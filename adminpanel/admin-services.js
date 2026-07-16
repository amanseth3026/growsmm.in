import { db } from "./firebase.js";
import {
  mergeCategoryOrder,
  normalizeCategoryName,
  readCachedCategoryOrder,
  writeCategoryOrderCache
} from "../category-order.js";
import {
  collection,
  getDoc,
  getDocs,
  doc,
  setDoc,
  serverTimestamp,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { readAllServiceDocsFromCollection } from "../scripts/services-collection.js";
import {
  requireAdminAuth,
  initAdminSidebar,
  bindAdminLogout
} from "./admin-ui-common.js";

requireAdminAuth();

const PANEL_SERVICE_START = 100;
const CATEGORY_REGISTRY_DOC_ID = "service_categories";
const SERVICE_COLLECTION_ID = "services";
const SERVICE_COUNTER_META_DOC_ID = "service_panel_counter";
const PUBLIC_SERVICE_CACHE_KEYS = ["growsmm_public_services_v2", "growsmm_public_services_v3"];

let allVendors = [];
let selectedVendorId = "";
let currentView = "all";
let searchDebounceTimer = null;
let categoryRefreshNeeded = true;
let categoryRegistry = [];

let activeMap = {};
let serviceRegistryByComposite = {};
let serviceOwnerDocMap = {};
let servicePanelIdMap = {};
let serviceDataByPanelId = {};
let loadedVendorServicesByVendorId = {};
let deletedServiceKeySet = new Set();

let editServiceModal = null;
let bulkCategoryModal = null;
let vendorPickerModal = null;
let editingServiceKey = "";
let editingCurrency = "INR";
let editingExchangeRate = 1;
let editingMode = "edit";

const $ = (id) => document.getElementById(id);

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isValidPanelServiceId(value) {
  return /^\d+$/.test(String(value || "").trim());
}

function htmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clearPublicServiceCache() {
  try {
    PUBLIC_SERVICE_CACHE_KEYS.forEach((cacheKey) => localStorage.removeItem(cacheKey));
  } catch {
    // Ignore cache cleanup failures.
  }
}

function sanitizeDocIdPart(value, fallback = "unknown") {
  const clean = String(value || "").trim();
  if (!clean) return fallback;
  return clean.replace(/[\/\\]/g, "_");
}

function buildVendorServiceDocId(vendorId, serviceId) {
  const safeVendor = sanitizeDocIdPart(vendorId, "no_vendor");
  const safeService = sanitizeDocIdPart(serviceId, "unknown_service");
  return `${safeVendor}__${safeService}`;
}

function buildServiceKey(vendorId, vendorServiceId) {
  return `${String(vendorId || "").trim()}::${String(vendorServiceId || "").trim()}`;
}

function parseServiceKey(serviceKey) {
  const raw = String(serviceKey || "").trim();
  if (!raw) return { vendorId: "", vendorServiceId: "" };
  const separatorIndex = raw.indexOf("::");
  if (separatorIndex < 0) {
    return {
      vendorId: String(selectedVendorId || "").trim(),
      vendorServiceId: raw
    };
  }
  return {
    vendorId: raw.slice(0, separatorIndex).trim(),
    vendorServiceId: raw.slice(separatorIndex + 2).trim()
  };
}

function getVendorById(vendorId) {
  const target = String(vendorId || "").trim();
  if (!target) return null;
  return allVendors.find((row) => row.id === target) || null;
}

function getSelectedVendorConfig() {
  return getVendorById(selectedVendorId) || null;
}

function getDefaultProfit() {
  const selectedVendor = getSelectedVendorConfig();
  return toNumber(selectedVendor?.profit, 20);
}

function extractServiceIdentity(rawService = {}, fallbackDocId = "") {
  const panelServiceId = String(rawService.panelServiceId || rawService.serviceId || "").trim();
  const vendorServiceId = String(rawService.vendorServiceId || rawService.service || "").trim();
  const vendorId = String(rawService.vendorId || "").trim();
  const active = rawService.active !== false;

  return {
    panelServiceId,
    vendorServiceId,
    vendorId,
    active,
    docId: fallbackDocId
  };
}

function getVendorCurrencyConfig() {
  const selectedVendor = getSelectedVendorConfig();
  const currency = String(selectedVendor?.currency || "INR").toUpperCase();
  const exchangeRate = toNumber(selectedVendor?.exchangeRate, 1) || 1;
  return { currency, exchangeRate };
}

function getCurrencyConfigForService(vendorId, savedData = null, rawData = null) {
  const selected = String(selectedVendorId || "").trim();
  const targetVendorId = String(vendorId || "").trim();
  if (selected && targetVendorId && selected === targetVendorId) {
    return getVendorCurrencyConfig();
  }

  const vendor = getVendorById(targetVendorId);
  const currency = String(
    savedData?.currency
    || rawData?.currency
    || vendor?.currency
    || "INR"
  ).toUpperCase();
  const exchangeRate = toNumber(
    savedData?.exchangeRate,
    toNumber(rawData?.exchangeRate, toNumber(vendor?.exchangeRate, 1))
  ) || 1;

  return { currency, exchangeRate };
}

function convertVendorRateToInr(vendorRateRaw, currencyInput, exchangeRateInput) {
  const fallback = getVendorCurrencyConfig();
  const currency = String(currencyInput || fallback.currency || "INR").toUpperCase();
  const exchangeRate = toNumber(exchangeRateInput, fallback.exchangeRate) || 1;
  let inr = toNumber(vendorRateRaw, 0);
  if (currency === "USD") {
    inr = inr * exchangeRate;
  }
  return inr;
}

function calcUserPriceFromVendorRate(vendorRateRaw, profitPct, currencyInput, exchangeRateInput) {
  const baseRateInr = convertVendorRateToInr(vendorRateRaw, currencyInput, exchangeRateInput);
  const profit = toNumber(profitPct, 0);
  return Number((baseRateInr * (1 + profit / 100)).toFixed(4));
}

function getVendorDisplayName(vendorId, savedData = null) {
  const savedVendorName = String(savedData?.vendorName || "").trim();
  if (savedVendorName) return savedVendorName;
  const vendor = getVendorById(vendorId);
  return String(vendor?.name || "").trim() || "Vendor";
}

function resolveServiceContext(serviceKey) {
  const parsed = parseServiceKey(serviceKey);
  const vendorId = String(parsed.vendorId || "").trim();
  const vendorServiceId = String(parsed.vendorServiceId || "").trim();
  if (!vendorId || !vendorServiceId) {
    return { key: "", vendorId, vendorServiceId, saved: null, raw: null };
  }

  const key = buildServiceKey(vendorId, vendorServiceId);
  if (deletedServiceKeySet.has(key)) {
    return { key, vendorId, vendorServiceId, saved: null, raw: null };
  }
  const saved = serviceRegistryByComposite[key] || null;
  const raw = getLoadedVendorService(vendorId, vendorServiceId);

  return { key, vendorId, vendorServiceId, saved, raw };
}

function isDeletedServiceRecord(service = {}) {
  return service?.deleted === true;
}

function getServiceCategory(serviceLike) {
  const clean = normalizeCategoryName(serviceLike?.category);
  return clean || "General";
}

function getServiceCounterRef() {
  return doc(db, "meta", SERVICE_COUNTER_META_DOC_ID);
}

function snapshotServiceMapFromMemory() {
  const snapshot = {};

  Object.entries(serviceDataByPanelId || {}).forEach(([panelServiceId, raw]) => {
    const cleanId = String(panelServiceId || raw?.panelServiceId || raw?.serviceId || "").trim();
    if (!isValidPanelServiceId(cleanId)) return;

    snapshot[cleanId] = {
      ...(raw || {}),
      panelServiceId: cleanId,
      serviceId: cleanId,
      active: raw?.active !== false
    };
  });

  return snapshot;
}

async function readServiceStoresForTx(tx) {
  const counterRef = getServiceCounterRef();
  const counterSnap = await tx.get(counterRef);
  const servicesObj = snapshotServiceMapFromMemory();
  const previousServicesObj = { ...servicesObj };

  let nextPanelServiceId = toNumber(counterSnap.data()?.nextPanelServiceId, PANEL_SERVICE_START - 1);
  if (!Number.isFinite(nextPanelServiceId) || nextPanelServiceId < PANEL_SERVICE_START - 1) {
    nextPanelServiceId = PANEL_SERVICE_START - 1;
  }

  Object.keys(servicesObj).forEach((serviceId) => {
    const numericId = Number(serviceId);
    if (Number.isFinite(numericId) && numericId > nextPanelServiceId) {
      nextPanelServiceId = numericId;
    }
  });

  return {
    counterRef,
    servicesObj,
    previousServicesObj,
    nextPanelServiceId
  };
}

function writeServiceStoresTx(tx, {
  counterRef,
  servicesObj,
  previousServicesObj,
  nextPanelServiceId
}) {
  const previous = previousServicesObj || {};
  const current = servicesObj || {};
  const serviceIds = new Set([
    ...Object.keys(previous),
    ...Object.keys(current)
  ]);

  serviceIds.forEach((serviceId) => {
    const cleanId = String(serviceId || "").trim();
    if (!isValidPanelServiceId(cleanId)) return;

    const before = previous[cleanId];
    const after = current[cleanId];

    if (before === after) return;

    if (!after) {
      tx.set(doc(db, SERVICE_COLLECTION_ID, cleanId), {
        panelServiceId: cleanId,
        serviceId: cleanId,
        active: false,
        deleted: true,
        updatedAt: serverTimestamp()
      }, { merge: true });
      return;
    }

    tx.set(doc(db, SERVICE_COLLECTION_ID, cleanId), {
      ...after,
      panelServiceId: cleanId,
      serviceId: cleanId,
      active: after.active !== false,
      deleted: after.deleted === true,
      updatedAt: serverTimestamp()
    }, { merge: true });
  });

  tx.set(counterRef, {
    nextPanelServiceId,
    updatedAt: serverTimestamp()
  }, { merge: true });
}

function writeServiceEntry(servicesObj, panelServiceId, data) {
  const key = String(panelServiceId || "").trim();
  if (!isValidPanelServiceId(key)) return;
  servicesObj[key] = {
    panelServiceId: key,
    serviceId: key,
    ...data,
    deleted: data?.deleted === true
  };
}

function uniqueCategories(values = []) {
  const map = new Map();
  values.forEach((value) => {
    const categoryName = getServiceCategory({ category: value });
    const key = categoryName.toLowerCase();
    if (!map.has(key)) {
      map.set(key, categoryName);
    }
  });
  return Array.from(map.values());
}

function normalizeVendorServiceRecord(vendorId, rawService = {}) {
  const safeVendorId = String(vendorId || "").trim();
  const vendorServiceId = String(
    rawService.vendorServiceId
    || rawService.service
    || rawService.id
    || ""
  ).trim();

  if (!safeVendorId || !vendorServiceId) return null;

  return {
    vendorId: safeVendorId,
    vendorServiceId,
    service: vendorServiceId,
    name: String(rawService.name || rawService.service_name || "Unnamed Service").trim() || "Unnamed Service",
    category: getServiceCategory(rawService),
    type: String(rawService.type || rawService.serviceType || rawService.service_type || "Default").trim() || "Default",
    rate: toNumber(rawService.rate ?? rawService.price, 0),
    min: Math.max(0, toNumber(rawService.min ?? rawService.minimum, 0)),
    max: Math.max(0, toNumber(rawService.max ?? rawService.maximum, 0)),
    description: String(
      rawService.description
      || rawService.desc
      || rawService.details
      || rawService.service_description
      || "No description available"
    ).trim() || "No description available"
  };
}

function getLoadedVendorService(vendorId, vendorServiceId) {
  const safeVendorId = String(vendorId || "").trim();
  const safeServiceId = String(vendorServiceId || "").trim();
  if (!safeVendorId || !safeServiceId) return null;
  const bucket = loadedVendorServicesByVendorId[safeVendorId];
  if (!bucket) return null;
  return bucket[safeServiceId] || null;
}

function getLoadedVendorServiceByKey(serviceKey) {
  const parsed = parseServiceKey(serviceKey);
  const key = buildServiceKey(parsed.vendorId, parsed.vendorServiceId);
  if (deletedServiceKeySet.has(key)) return null;
  return getLoadedVendorService(parsed.vendorId, parsed.vendorServiceId);
}

function getLoadedServiceList(vendorFilter = "") {
  const safeVendorId = String(vendorFilter || "").trim();
  if (!safeVendorId) return [];

  const bucket = loadedVendorServicesByVendorId[safeVendorId];
  if (!bucket || typeof bucket !== "object") return [];

  return Object.values(bucket).map((rawService) => {
    const vendorServiceId = String(rawService.vendorServiceId || rawService.service || "").trim();
    const key = buildServiceKey(safeVendorId, vendorServiceId);
    if (deletedServiceKeySet.has(key)) return null;
    return {
      serviceKey: key,
      vendorId: safeVendorId,
      vendorServiceId,
      panelServiceId: "",
      name: String(rawService.name || "Unnamed Service").trim() || "Unnamed Service",
      category: getServiceCategory(rawService),
      savedData: null,
      rawData: rawService,
      isSaved: false,
      active: false
    };
  }).filter(Boolean);
}

async function loadVendorServicesForVendor(vendorId, forceRefresh = true) {
  const safeVendorId = String(vendorId || "").trim();
  const vendor = getVendorById(safeVendorId);
  if (!vendor) {
    throw new Error("Selected vendor not found.");
  }
  if (!vendor.url || !vendor.key) {
    throw new Error("Vendor API URL or API key missing.");
  }

  const res = await fetch("/api/vendor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "services",
      key: vendor.key,
      url: vendor.url,
      forceRefresh: !!forceRefresh
    })
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.success === false) {
    throw new Error(payload?.error || payload?.message || "Vendor services load failed.");
  }

  let list = payload?.data || [];
  if (!Array.isArray(list) && list && typeof list === "object") {
    list = Object.values(list);
  }
  if (!Array.isArray(list)) {
    list = [];
  }

  const normalizedBucket = {};
  list.forEach((row) => {
    const normalized = normalizeVendorServiceRecord(safeVendorId, row);
    if (!normalized) return;
    normalizedBucket[normalized.vendorServiceId] = normalized;
  });

  loadedVendorServicesByVendorId[safeVendorId] = normalizedBucket;
  return Object.keys(normalizedBucket).length;
}

async function loadCategoryRegistry() {
  categoryRegistry = [];
  const cached = readCachedCategoryOrder();
  if (cached) {
    categoryRegistry = uniqueCategories(cached);
    return;
  }

  try {
    const snap = await getDoc(doc(db, "meta", CATEGORY_REGISTRY_DOC_ID));
    if (!snap.exists()) return;
    const categories = snap.data()?.categories;
    if (!Array.isArray(categories)) return;
    categoryRegistry = uniqueCategories(categories);
    writeCategoryOrderCache(categoryRegistry);
  } catch (err) {
    console.warn("Category registry load failed:", err);
  }
}

async function ensureCategoriesInRegistry(categoryNames = []) {
  const nextRegistry = mergeCategoryOrder(categoryRegistry, Array.isArray(categoryNames) ? categoryNames : []);

  const unchanged = nextRegistry.length === categoryRegistry.length
    && nextRegistry.every((value, index) => value === categoryRegistry[index]);

  if (unchanged) return;

  categoryRegistry = nextRegistry;
  await setDoc(doc(db, "meta", CATEGORY_REGISTRY_DOC_ID), {
    categories: categoryRegistry,
    updatedAt: serverTimestamp()
  }, { merge: true });
  writeCategoryOrderCache(categoryRegistry);
}

async function tryEnsureCategoriesInRegistry(categoryNames = []) {
  try {
    await ensureCategoriesInRegistry(categoryNames);
  } catch (err) {
    console.warn("Category registry update skipped:", err);
  }
}

function getCategoryChoices() {
  const categories = new Set();

  categoryRegistry.forEach((categoryName) => {
    categories.add(getServiceCategory({ category: categoryName }));
  });

  getMergedServiceRows(String(selectedVendorId || "").trim()).forEach((serviceRow) => {
    categories.add(serviceRow.category);
  });

  categories.add("General");
  return mergeCategoryOrder(categoryRegistry, Array.from(categories));
}

function refreshEditCategorySelect(categoryNames = [], selectedCategory = "") {
  const select = $("editServiceCategory");
  if (!select) return;

  const selected = getServiceCategory({ category: selectedCategory });
  const categoriesBase = Array.isArray(categoryNames) && categoryNames.length
    ? categoryNames
    : getCategoryChoices();
  const categories = mergeCategoryOrder(categoriesBase, [selected]);

  select.innerHTML = categories
    .map((categoryName) => `<option value="${htmlEscape(categoryName)}">${htmlEscape(categoryName)}</option>`)
    .join("");

  if (categories.includes(selected)) {
    select.value = selected;
    return;
  }

  if (categories.includes("General")) {
    select.value = "General";
  }
}

function getSavedServiceList(vendorFilter = "") {
  const normalizedFilter = String(vendorFilter || "").trim();
  return Object.values(serviceRegistryByComposite).reduce((rows, savedRow) => {
    if (isDeletedServiceRecord(savedRow)) return rows;
    const vendorId = String(savedRow.vendorId || "").trim();
    const vendorServiceId = String(savedRow.vendorServiceId || savedRow.service || "").trim();
    if (!vendorId || !vendorServiceId) return rows;
    if (normalizedFilter && vendorId !== normalizedFilter) return rows;

    const key = buildServiceKey(vendorId, vendorServiceId);
    rows.push({
      serviceKey: key,
      vendorId,
      vendorServiceId,
      panelServiceId: String(savedRow.panelServiceId || savedRow.serviceId || "").trim(),
      name: String(savedRow.name || savedRow.title || "Unnamed Service").trim() || "Unnamed Service",
      category: getServiceCategory(savedRow),
      savedData: savedRow,
      rawData: null,
      isSaved: true,
      active: savedRow.active !== false
    });
    return rows;
  }, []);
}

function getMergedServiceRows(vendorFilter = "") {
  const savedRows = getSavedServiceList(vendorFilter);
  const loadedRows = getLoadedServiceList(vendorFilter);
  const mergedRows = new Map();

  savedRows.forEach((row) => {
    mergedRows.set(row.serviceKey, { ...row });
  });

  loadedRows.forEach((row) => {
    const existing = mergedRows.get(row.serviceKey);
    if (!existing) {
      mergedRows.set(row.serviceKey, row);
      return;
    }

    mergedRows.set(row.serviceKey, {
      ...existing,
      rawData: row.rawData || existing.rawData || null,
      category: normalizeCategoryName(existing.category || row.category) || "General",
      name: existing.name || row.name
    });
  });

  const categoryOrder = mergeCategoryOrder(
    categoryRegistry,
    Array.from(mergedRows.values()).map((row) => row.category)
  );
  const categoryIndexMap = new Map(categoryOrder.map((name, index) => [String(name || "").toLowerCase(), index]));

  const rows = Array.from(mergedRows.values()).sort((a, b) => {
    const categoryA = String(a.category || "").toLowerCase();
    const categoryB = String(b.category || "").toLowerCase();
    const orderA = categoryIndexMap.has(categoryA) ? categoryIndexMap.get(categoryA) : Number.MAX_SAFE_INTEGER;
    const orderB = categoryIndexMap.has(categoryB) ? categoryIndexMap.get(categoryB) : Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    const nameA = String(a.name || "").toLowerCase();
    const nameB = String(b.name || "").toLowerCase();
    return nameA.localeCompare(nameB);
  });

  return rows;
}

function getBaseServiceList() {
  const vendorFilter = String(selectedVendorId || "").trim();
  const rows = getMergedServiceRows(vendorFilter);

  if (currentView === "active") {
    return rows.filter((row) => row.active);
  }

  if (currentView === "inactive") {
    return rows.filter((row) => !row.active);
  }

  return rows;
}

function refreshCategoryFilter() {
  const select = $("categoryFilter");
  if (!select) return;

  const previous = select.value || "all";
  const sorted = getCategoryChoices();

  select.innerHTML = "";

  const allOpt = document.createElement("option");
  allOpt.value = "all";
  allOpt.textContent = "All Categories";
  select.appendChild(allOpt);

  sorted.forEach((categoryName) => {
    const opt = document.createElement("option");
    opt.value = String(categoryName);
    opt.textContent = String(categoryName);
    select.appendChild(opt);
  });

  if (sorted.includes(previous)) {
    select.value = previous;
  } else {
    select.value = "all";
  }

  refreshBulkCategorySelect(sorted, $("bulkCategoryFilter")?.value || "");
  refreshEditCategorySelect(sorted, $("editServiceCategory")?.value || "");
}

function refreshBulkCategorySelect(categoryNames = [], selectedCategory = "") {
  const select = $("bulkCategoryFilter");
  if (!select) return;

  const selected = String(selectedCategory || "").trim();
  const categoriesBase = Array.isArray(categoryNames) && categoryNames.length
    ? categoryNames
    : getCategoryChoices();
  const categories = mergeCategoryOrder(categoriesBase, selected ? [selected] : []);

  select.innerHTML = `<option value="">Bulk Category</option>` + categories
    .map((categoryName) => `<option value="${htmlEscape(categoryName)}">${htmlEscape(categoryName)}</option>`)
    .join("");

  if (selected && categories.includes(selected)) {
    select.value = selected;
    return;
  }

  select.value = "";
}

function refreshStatusFilter() {
  const select = $("statusFilter");
  if (!select) return;

  const desiredValue = `view:${currentView}`;
  const hasDesiredOption = Array.from(select.options).some((option) => String(option.value || "") === desiredValue);
  select.value = hasDesiredOption ? desiredValue : "view:all";
}

function refreshVendorFilter() {
  const select = $("vendorFilter");
  if (!select) return;

  const sortedVendors = [...allVendors].sort((a, b) => {
    const nameA = String(a?.name || a?.id || "").toLowerCase();
    const nameB = String(b?.name || b?.id || "").toLowerCase();
    return nameA.localeCompare(nameB);
  });

  const previous = String(selectedVendorId || "").trim();
  select.innerHTML = `<option value="">All Vendors</option>` + (sortedVendors.length
    ? sortedVendors
      .map((vendor) => {
        const vendorId = String(vendor?.id || "").trim();
        const vendorName = String(vendor?.name || "Vendor").trim() || "Vendor";
        return `<option value="${htmlEscape(vendorId)}">${htmlEscape(vendorName)} (${htmlEscape(vendorId)})</option>`;
      })
      .join("")
    : "");

  if (previous && allVendors.some((vendor) => String(vendor?.id || "").trim() === previous)) {
    select.value = previous;
    return;
  }

  if (previous) {
    selectedVendorId = "";
  }
  select.value = "";
}

function refreshViewFilter() {
  refreshStatusFilter();
  refreshVendorFilter();
}

function initEditModal() {
  if (editServiceModal) return;
  const modalEl = $("editServiceModal");
  if (!modalEl || !window.bootstrap) return;
  editServiceModal = new window.bootstrap.Modal(modalEl);
}

function initVendorPickerModal() {
  if (vendorPickerModal) return;
  const modalEl = $("vendorPickerModal");
  if (!modalEl || !window.bootstrap) return;
  vendorPickerModal = new window.bootstrap.Modal(modalEl);
}

function initBulkCategoryModal() {
  if (bulkCategoryModal) return;
  const modalEl = $("bulkCategoryModal");
  if (!modalEl || !window.bootstrap) return;
  bulkCategoryModal = new window.bootstrap.Modal(modalEl);
}

function openBulkCategoryModal() {
  initBulkCategoryModal();
  if (!bulkCategoryModal) {
    alert("Category modal is not ready.");
    return;
  }

  refreshBulkCategorySelect();
  bulkCategoryModal.show();
}

function populateVendorPickerSelect() {
  const select = $("vendorPickerSelect");
  if (!select) return;

  const placeholder = `<option value="">Select vendor</option>`;
  const options = allVendors
    .map((vendor) => `<option value="${htmlEscape(vendor.id)}">${htmlEscape(vendor.name || "Vendor")} (${htmlEscape(vendor.id)})</option>`)
    .join("");

  select.innerHTML = `${placeholder}${options}`;
  if (selectedVendorId && allVendors.some((vendor) => vendor.id === selectedVendorId)) {
    select.value = selectedVendorId;
  }
}

function openVendorPickerModal() {
  if (!allVendors.length) {
    alert("No vendors found. Please add a vendor first.");
    return;
  }

  initVendorPickerModal();
  if (!vendorPickerModal) {
    alert("Vendor picker is not ready.");
    return;
  }

  populateVendorPickerSelect();
  vendorPickerModal.show();
}

async function confirmVendorSelectionAndLoadServices() {
  const select = $("vendorPickerSelect");
  const vendorId = String(select?.value || "").trim();
  if (!vendorId) {
    alert("Please select a vendor.");
    return;
  }

  const confirmBtn = $("btnVendorPickerConfirm");
  const oldLabel = confirmBtn?.innerHTML || "Load Services";
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> Loading...`;
  }

  try {
    const count = await loadVendorServicesForVendor(vendorId, true);
    setVendorFilter(vendorId);

    if (vendorPickerModal) {
      vendorPickerModal.hide();
    }

    alert(`Loaded ${count} service(s) for selected vendor.`);
  } catch (err) {
    console.error("Vendor services load failed:", err);
    alert(err?.message || "Unable to load vendor services.");
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = oldLabel;
    }
  }
}

function setServiceModalMode(mode = "edit") {
  editingMode = mode === "create" ? "create" : "edit";
  const isCreate = editingMode === "create";

  const titleEl = document.querySelector("#editServiceModal .modal-title");
  if (titleEl) {
    titleEl.textContent = isCreate ? "Add New Service" : "Edit Service Details";
  }

  const vendorServiceInput = $("editVendorServiceId");
  const vendorIdInput = $("editVendorId");
  const serviceTypeInput = $("editServiceType");

  if (vendorServiceInput) vendorServiceInput.readOnly = !isCreate;
  if (vendorIdInput) vendorIdInput.readOnly = !isCreate;
  if (serviceTypeInput) serviceTypeInput.readOnly = !isCreate;
}

function recalcEditUserPrice() {
  const vendorPrice = toNumber($("editVendorPrice")?.value, 0);
  const profit = toNumber($("editServiceProfit")?.value, 0);
  $("editUserPrice").value = String(
    calcUserPriceFromVendorRate(vendorPrice, profit, editingCurrency, editingExchangeRate)
  );
}

function refreshEditingCurrencyFromVendorInput() {
  const vendorId = String($("editVendorId")?.value || "").trim();
  const { currency, exchangeRate } = getCurrencyConfigForService(vendorId, null, null);
  editingCurrency = currency;
  editingExchangeRate = exchangeRate;
}

function findServiceControlByKey(selector, serviceKey) {
  const normalizedKey = String(serviceKey || "").trim();
  if (!normalizedKey) return null;

  return Array.from(document.querySelectorAll(selector)).find((element) => {
    return String(element.getAttribute("data-service-key") || "").trim() === normalizedKey;
  }) || null;
}

function getSelectedBulkServiceRecords() {
  return Array.from(document.querySelectorAll(".svc-bulk-chk"))
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => {
      const serviceKey = String(checkbox.getAttribute("data-service-key") || "").trim();
      const parsed = parseServiceKey(serviceKey);
      const serviceVendorId = String(parsed.vendorId || "").trim();
      const vendorServiceId = String(parsed.vendorServiceId || "").trim();

      if (!serviceVendorId || !vendorServiceId) return null;

      const key = buildServiceKey(serviceVendorId, vendorServiceId);
      return {
        checkbox,
        serviceKey: key,
        serviceVendorId,
        vendorServiceId,
        existing: serviceRegistryByComposite[key] || null,
        rawService: getLoadedVendorServiceByKey(key) || {},
        profitInput: findServiceControlByKey(".svc-profit", key)
      };
    })
    .filter(Boolean);
}

function buildBulkServiceModel(record = {}, overrides = {}) {
  const checkbox = record.checkbox || null;
  const existing = record.existing || null;
  const rawService = record.rawService || {};
  const serviceVendorId = String(record.serviceVendorId || "").trim();
  const vendorServiceId = String(record.vendorServiceId || "").trim();
  const profitInput = record.profitInput || null;

  const serviceCategory = String(
    overrides.targetCategory
    || existing?.category
    || rawService?.category
    || checkbox?.getAttribute("data-cat")
    || "General"
  ).trim() || "General";

  const vendorName = getVendorDisplayName(serviceVendorId, existing);
  const { currency, exchangeRate } = getCurrencyConfigForService(serviceVendorId, existing, rawService);
  const serviceName = String(
    existing?.name
    || rawService?.name
    || checkbox?.getAttribute("data-name")
    || "Unnamed Service"
  ).trim() || "Unnamed Service";
  const serviceType = String(existing?.type || rawService?.type || rawService?.serviceType || "Default").trim() || "Default";
  const serviceMin = Math.max(0, toNumber(existing?.min, toNumber(rawService?.min, 0)));
  const serviceMax = Math.max(0, toNumber(existing?.max, toNumber(rawService?.max, 0)));
  const vendorPrice = toNumber(rawService?.rate, toNumber(existing?.vendorPrice, toNumber(existing?.rate, 0)));
  const profit = toNumber(profitInput?.value, toNumber(existing?.profit, getDefaultProfit()));
  const userPrice = calcUserPriceFromVendorRate(vendorPrice, profit, currency, exchangeRate);
  const serviceDescription = String(existing?.description || rawService?.description || "No description available").trim() || "No description available";
  const rowActive = !!checkbox?.closest("tr")?.classList.contains("table-success");
  const active = typeof overrides.desiredActive === "boolean"
    ? overrides.desiredActive
    : (existing ? existing.active !== false : rowActive);
  const panelServiceId = String(existing?.panelServiceId || existing?.serviceId || "").trim();

  return {
    serviceVendorId,
    vendorServiceId,
    vendorName,
    serviceName,
    serviceCategory,
    serviceType,
    serviceMin,
    serviceMax,
    vendorPrice,
    profit,
    userPrice,
    currency,
    exchangeRate,
    serviceDescription,
    active,
    panelServiceId,
    serviceDocId: existing?.docId || buildVendorServiceDocId(serviceVendorId, vendorServiceId)
  };
}

async function runBulkServiceMutation({
  buttonId = "",
  loadingLabel = "Working...",
  confirmMessage = null,
  successMessage = "",
  targetCategory = null,
  desiredActive = null
} = {}) {
  const selectedRecords = getSelectedBulkServiceRecords();
  if (!selectedRecords.length) {
    alert("Please select at least one service.");
    return false;
  }

  const prompt = typeof confirmMessage === "function"
    ? confirmMessage(selectedRecords.length)
    : confirmMessage;
  if (prompt && !confirm(prompt)) {
    return false;
  }

  const actionBtn = buttonId ? $(buttonId) : null;
  const oldLabel = actionBtn?.innerHTML || "";
  if (actionBtn) {
    actionBtn.disabled = true;
    actionBtn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> ${loadingLabel}`;
  }

  const usedCategories = new Set();

  try {
    await runTransaction(db, async (tx) => {
        const state = await readServiceStoresForTx(tx);
        const servicesObj = { ...state.servicesObj };
        let nextPanelServiceId = state.nextPanelServiceId;

        for (const record of selectedRecords) {
          const model = buildBulkServiceModel(record, { targetCategory, desiredActive });
          usedCategories.add(model.serviceCategory);

          let panelServiceId = String(model.panelServiceId || "").trim();
          if (!panelServiceId) {
            nextPanelServiceId += 1;
            panelServiceId = String(nextPanelServiceId);
          }

          writeServiceEntry(servicesObj, panelServiceId, {
            vendorId: model.serviceVendorId,
            vendorServiceId: model.vendorServiceId,
            vendorName: model.vendorName,
            name: model.serviceName,
            title: model.serviceName,
            category: model.serviceCategory,
            description: model.serviceDescription,
            type: model.serviceType,
            min: model.serviceMin,
            max: model.serviceMax,
            rate: model.vendorPrice,
            vendorPrice: model.vendorPrice,
            profit: model.profit,
            userPrice: model.userPrice,
            currency: model.currency,
            exchangeRate: model.exchangeRate,
            active: model.active,
            syncStatus: "ok",
            updatedAt: serverTimestamp(),
            lastSyncAt: serverTimestamp()
          });
        }

        writeServiceStoresTx(tx, {
          counterRef: state.counterRef,
          servicesObj,
          previousServicesObj: state.previousServicesObj,
          nextPanelServiceId
        });
      });

    if (usedCategories.size) {
      await tryEnsureCategoriesInRegistry(Array.from(usedCategories));
    }

    await refreshServiceOwnershipFromServices();
    clearPublicServiceCache();
    categoryRefreshNeeded = true;
    renderServices();

    const message = typeof successMessage === "function"
      ? successMessage(selectedRecords.length)
      : successMessage;
    if (message) {
      alert(message);
    }

    return true;
  } catch (err) {
    console.error(err);
    alert(`Bulk update failed: ${err.message}`);
    return false;
  } finally {
    if (actionBtn) {
      actionBtn.disabled = false;
      actionBtn.innerHTML = oldLabel;
    }
  }
}

async function refreshServiceOwnershipFromServices() {
  serviceRegistryByComposite = {};
  serviceOwnerDocMap = {};
  servicePanelIdMap = {};
  serviceDataByPanelId = {};
  activeMap = {};
  deletedServiceKeySet = new Set();

  const serviceStore = await readAllServiceDocsFromCollection(db, {
    includeDeleted: true
  });

  serviceStore.rows.forEach((data) => {
      const panelServiceId = String(data?.panelServiceId || data?.serviceId || data?.docId || "").trim();
      const identity = extractServiceIdentity(data, panelServiceId);
      if (!identity.vendorId || !identity.vendorServiceId) return;

      const normalized = {
        ...data,
        docId: identity.panelServiceId || panelServiceId,
        vendorId: identity.vendorId,
        vendorServiceId: identity.vendorServiceId,
        panelServiceId: identity.panelServiceId || panelServiceId,
        serviceId: identity.panelServiceId || panelServiceId,
        active: identity.active
      };

      const key = buildServiceKey(identity.vendorId, identity.vendorServiceId);

      if (isDeletedServiceRecord(normalized)) {
        deletedServiceKeySet.add(key);
        return;
      }

      serviceRegistryByComposite[key] = normalized;
      serviceOwnerDocMap[key] = normalized.serviceId;

      if (normalized.serviceId) {
        servicePanelIdMap[key] = normalized.serviceId;
        serviceDataByPanelId[normalized.serviceId] = normalized;

        if (normalized.active) {
          activeMap[normalized.serviceId] = {
            vendorId: normalized.vendorId,
            vendorServiceId: normalized.vendorServiceId,
            profit: toNumber(normalized.profit, 0),
            active: true,
            name: normalized.name || normalized.title || "",
            category: normalizeCategoryName(normalized.category) || "General"
          };
        }
      }
  });
}

async function loadConfig() {
  initAdminSidebar({ closeOnOutsideClick: true });
  initEditModal();

  const previousSelected = selectedVendorId;

  const vendorSnap = await getDocs(collection(db, "vendors"));
  allVendors = [];

  vendorSnap.forEach((docSnap) => {
    const vendorData = docSnap.data() || {};
    allVendors.push({ id: docSnap.id, ...vendorData });
  });

  const validVendorIds = new Set(allVendors.map((row) => row.id));
  Object.keys(loadedVendorServicesByVendorId).forEach((vendorId) => {
    if (!validVendorIds.has(vendorId)) {
      delete loadedVendorServicesByVendorId[vendorId];
    }
  });
  populateVendorPickerSelect();

  if (previousSelected && allVendors.some((row) => row.id === previousSelected)) {
    selectedVendorId = previousSelected;
  } else {
    selectedVendorId = "";
  }

  await refreshServiceOwnershipFromServices();
  await loadCategoryRegistry();

  refreshViewFilter();
  categoryRefreshNeeded = true;
  renderServices();
}

function renderServices() {
  const tbody = $("serviceTableBody");
  if (!tbody) return;

  const searchFilter = String($("searchSvc")?.value || "").toLowerCase();

  if (categoryRefreshNeeded) {
    refreshCategoryFilter();
    categoryRefreshNeeded = false;
  }

  const selectedCategory = $("categoryFilter")?.value || "all";
  const globalProfit = getDefaultProfit();

  const rows = [];

  getBaseServiceList().forEach((serviceRow) => {
    const vendorId = String(serviceRow.vendorId || "").trim();
    const vendorServiceId = String(serviceRow.vendorServiceId || "").trim();
    if (!vendorId || !vendorServiceId) return;

    const key = String(serviceRow.serviceKey || buildServiceKey(vendorId, vendorServiceId)).trim();
    const savedData = serviceRow.savedData || null;
    const rawData = serviceRow.rawData || null;
    const isActive = savedData ? savedData.active !== false : false;

    const categoryName = String(serviceRow.category || getServiceCategory(savedData || rawData)).trim() || "General";
    if (selectedCategory !== "all" && categoryName !== selectedCategory) return;

    const panelServiceId = String(serviceRow.panelServiceId || savedData?.panelServiceId || savedData?.serviceId || "").trim();
    const name = String(serviceRow.name || savedData?.name || rawData?.name || "Unnamed Service").trim() || "Unnamed Service";
    const vendorDisplayName = getVendorDisplayName(vendorId, savedData);

    const searchText = `${name} ${categoryName} ${vendorServiceId} ${vendorId} ${vendorDisplayName} ${panelServiceId}`.toLowerCase();
    if (searchFilter && !searchText.includes(searchFilter)) return;

    const profit = toNumber(savedData?.profit, globalProfit);
    const vendorRateRaw = toNumber(savedData?.vendorPrice, toNumber(savedData?.rate, toNumber(rawData?.rate, 0)));
    const { currency, exchangeRate } = getCurrencyConfigForService(vendorId, savedData, rawData);
    const vendorRateInr = convertVendorRateToInr(vendorRateRaw, currency, exchangeRate);

    const userPrice = toNumber(
      savedData?.userPrice,
      calcUserPriceFromVendorRate(vendorRateRaw, profit, currency, exchangeRate)
    );

    const statusBadge = isActive
      ? '<span class="badge bg-success-subtle text-success border border-success-subtle">Enabled</span>'
      : '<span class="badge bg-danger-subtle text-danger border border-danger-subtle">Disabled</span>';

    const panelIdDisplay = panelServiceId
      ? `<span class="fw-semibold">${htmlEscape(panelServiceId)}</span>`
      : '<span class="text-muted">New</span>';

    const hasSavedDoc = !!savedData;

    rows.push(`
      <tr class="svc-row ${isActive ? "table-success" : ""}" data-service-key="${htmlEscape(key)}">
        <td>
          <div class="form-check d-flex justify-content-center mb-0">
            <input
              type="checkbox"
              class="form-check-input svc-bulk-chk border-secondary"
              data-service-key="${htmlEscape(key)}"
              data-vendor-id="${htmlEscape(vendorId)}"
              data-vendor-service-id="${htmlEscape(vendorServiceId)}"
              data-name="${htmlEscape(name)}"
              data-cat="${htmlEscape(categoryName)}"
              title="Select for bulk actions"
            >
          </div>
        </td>
        <td><small class="text-muted">${panelIdDisplay}</small></td>
        <td>
          <small class="fw-semibold d-block">${htmlEscape(vendorDisplayName)}</small>
          <small class="text-muted">ID: ${htmlEscape(vendorServiceId)}</small>
        </td>
        <td><span class="badge bg-light text-dark border text-truncate" style="max-width:160px; display:block;">${htmlEscape(categoryName)}</span></td>
        <td title="${htmlEscape(name)}"><div class="text-truncate" style="max-width:320px;">${htmlEscape(name)}</div></td>
        <td><small class="fw-bold text-secondary">Rs ${vendorRateInr.toFixed(4)}</small></td>
        <td>
          <input
            type="number"
            class="form-control form-control-sm svc-profit p-1 text-center"
            style="width:68px; height:28px;"
            value="${profit}"
            data-service-key="${htmlEscape(key)}"
            data-vendor-id="${htmlEscape(vendorId)}"
            data-vendor-service-id="${htmlEscape(vendorServiceId)}"
          >
        </td>
        <td class="fw-bold text-primary">Rs ${userPrice.toFixed(4)}</td>
        <td>${statusBadge}</td>
        <td class="d-flex gap-1">
          <button type="button" class="btn btn-sm btn-outline-primary svc-edit-btn" data-service-key="${htmlEscape(key)}" title="Edit">
            <i class="bi bi-pencil"></i>
          </button>
          <button
            type="button"
            class="btn btn-sm ${isActive ? "btn-outline-danger" : "btn-outline-success"} svc-toggle-btn"
            data-service-key="${htmlEscape(key)}"
            ${hasSavedDoc ? "" : "disabled"}
            title="${hasSavedDoc ? (isActive ? "Disable" : "Enable") : "Save once first"}"
          >
            <i class="bi ${isActive ? "bi-eye-slash" : "bi-eye"}"></i>
          </button>
          <button
            type="button"
            class="btn btn-sm btn-outline-danger svc-delete-btn"
            data-service-key="${htmlEscape(key)}"
            ${hasSavedDoc ? "" : "disabled"}
            title="${hasSavedDoc ? "Delete from database" : "Save once first"}"
          >
            <i class="bi bi-trash3"></i>
          </button>
        </td>
      </tr>
    `);
  });

  tbody.innerHTML = rows.join("");
  const bulkSelectAll = $("bulkSelectAll");
  if (bulkSelectAll) {
    bulkSelectAll.checked = false;
  }
  $("countDisplay").textContent = String(rows.length);
}

function setViewFilter(view) {
  const raw = String(view || "").trim();
  const viewMatch = raw.match(/^view:(all|active|inactive)$/i);
  const vendorMatch = raw.match(/^vendor:(.+)$/i);
  if (vendorMatch) {
    selectedVendorId = String(vendorMatch[1] || "").trim();
  } else if (viewMatch) {
    currentView = viewMatch[1].toLowerCase();
  } else if (raw === "all") {
    currentView = "all";
    selectedVendorId = "";
  }

  refreshViewFilter();
  categoryRefreshNeeded = true;
  renderServices();
}

function setStatusFilter(view) {
  const raw = String(view || "").trim();
  const viewMatch = raw.match(/^view:(all|active|inactive)$/i);
  currentView = viewMatch ? viewMatch[1].toLowerCase() : "all";
  refreshViewFilter();
  categoryRefreshNeeded = true;
  renderServices();
}

function setVendorFilter(vendorId) {
  selectedVendorId = String(vendorId || "").trim();
  refreshViewFilter();
  categoryRefreshNeeded = true;
  renderServices();
}

function fillEditFormFromData(serviceKeyInput) {
  const context = resolveServiceContext(serviceKeyInput);
  const key = context.key;
  const saved = context.saved;
  const raw = context.raw;
  const vendorId = context.vendorId;
  const vendorServiceId = context.vendorServiceId;

  if (!vendorId || !vendorServiceId || (!saved && !raw)) {
    alert("Service data not found.");
    return false;
  }

  const panelServiceId = String(saved?.panelServiceId || saved?.serviceId || "").trim();
  const name = String(saved?.name || raw?.name || "Unnamed Service").trim() || "Unnamed Service";
  const category = String(saved?.category || raw?.category || "General").trim() || "General";
  const type = String(saved?.type || raw?.type || raw?.serviceType || "Default").trim() || "Default";
  const min = toNumber(saved?.min, toNumber(raw?.min, 0));
  const max = toNumber(saved?.max, toNumber(raw?.max, 0));
  const vendorPrice = toNumber(saved?.vendorPrice, toNumber(saved?.rate, toNumber(raw?.rate, 0)));
  const profit = toNumber(saved?.profit, getDefaultProfit());
  const { currency, exchangeRate } = getCurrencyConfigForService(vendorId, saved, raw);
  const userPrice = toNumber(saved?.userPrice, calcUserPriceFromVendorRate(vendorPrice, profit, currency, exchangeRate));
  const active = saved ? saved.active !== false : true;
  const normalizedCategory = getServiceCategory({ category });
  const normalizedType = String(type).trim() || "Default";

  setServiceModalMode("edit");
  $("editPanelServiceId").value = panelServiceId;
  $("editVendorServiceId").value = vendorServiceId;
  $("editVendorId").value = vendorId;
  $("editServiceName").value = name;
  refreshEditCategorySelect(getCategoryChoices(), normalizedCategory);
  $("editServiceCategory").value = normalizedCategory;
  $("editServiceType").value = normalizedType;
  $("editServiceMin").value = String(min);
  $("editServiceMax").value = String(max);
  $("editVendorPrice").value = String(vendorPrice);
  $("editServiceProfit").value = String(profit);
  $("editUserPrice").value = String(userPrice);
  $("editServiceDescription").value = String(saved?.description || raw?.description || "No description available");
  $("editServiceActive").checked = active;

  editingServiceKey = key;
  editingCurrency = currency;
  editingExchangeRate = exchangeRate;
  return true;
}

async function openEditModal(serviceKeyInput) {
  initEditModal();
  if (!editServiceModal) {
    alert("Modal is not ready.");
    return;
  }

  const ok = fillEditFormFromData(serviceKeyInput);
  if (!ok) return;

  editServiceModal.show();
}

function openCreateModal() {
  initEditModal();
  if (!editServiceModal) {
    alert("Modal is not ready.");
    return;
  }

  setServiceModalMode("create");

  const vendorId = String(selectedVendorId || allVendors[0]?.id || "").trim();
  const defaultProfit = toNumber(getVendorById(vendorId)?.profit, getDefaultProfit());
  const defaultCategory = "General";
  const defaultVendorPrice = 0;

  refreshEditCategorySelect(getCategoryChoices(), defaultCategory);
  $("editPanelServiceId").value = "";
  $("editVendorServiceId").value = "";
  $("editVendorId").value = vendorId;
  $("editServiceName").value = "";
  $("editServiceCategory").value = defaultCategory;
  $("editServiceType").value = "Default";
  $("editServiceMin").value = "0";
  $("editServiceMax").value = "0";
  $("editVendorPrice").value = String(defaultVendorPrice);
  $("editServiceProfit").value = String(defaultProfit);
  $("editServiceDescription").value = "";
  $("editServiceActive").checked = true;

  refreshEditingCurrencyFromVendorInput();
  recalcEditUserPrice();
  editingServiceKey = "";
  editServiceModal.show();
}

async function saveEditedService() {
  const vendorServiceId = String($("editVendorServiceId")?.value || "").trim();
  const serviceVendorId = String($("editVendorId")?.value || "").trim();
  if (!vendorServiceId || !serviceVendorId) {
    alert("Service identity is missing.");
    return;
  }

  const requestedKey = buildServiceKey(serviceVendorId, vendorServiceId);
  const key = editingServiceKey || requestedKey;
  const existing = serviceRegistryByComposite[key] || null;
  const isCreateMode = editingMode === "create" && !editingServiceKey;
  if (isCreateMode && existing) {
    const proceed = confirm("Service already exists for this vendor and service ID. Do you want to update it?");
    if (!proceed) return;
  }

  const raw = getLoadedVendorServiceByKey(key) || {};

  const vendorName = getVendorDisplayName(serviceVendorId, existing);
  const { currency, exchangeRate } = getCurrencyConfigForService(serviceVendorId, existing, raw);

  const serviceName = String($("editServiceName")?.value || "").trim();
  const serviceCategory = String($("editServiceCategory")?.value || "").trim() || "General";
  const serviceType = String(existing?.type || raw?.type || raw?.serviceType || $("editServiceType")?.value || "Default").trim() || "Default";
  const serviceMin = Math.max(0, toNumber($("editServiceMin")?.value, toNumber(existing?.min, toNumber(raw?.min, 0))));
  const serviceMax = Math.max(0, toNumber($("editServiceMax")?.value, toNumber(existing?.max, toNumber(raw?.max, 0))));
  const vendorPrice = Math.max(0, toNumber($("editVendorPrice")?.value, toNumber(existing?.vendorPrice, toNumber(raw?.rate, 0))));
  const profit = toNumber($("editServiceProfit")?.value, toNumber(existing?.profit, getDefaultProfit()));
  const defaultUserPrice = calcUserPriceFromVendorRate(vendorPrice, profit, currency, exchangeRate);
  const userPrice = Math.max(0, toNumber($("editUserPrice")?.value, defaultUserPrice));
  const serviceDescription = String($("editServiceDescription")?.value || "").trim() || "No description available";
  const serviceActive = $("editServiceActive")?.checked !== false;

  if (!serviceName) {
    alert("Service name is required.");
    return;
  }

  const saveBtn = $("btnSaveEditedService");
  const oldLabel = saveBtn.innerHTML;
  saveBtn.disabled = true;
  saveBtn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> Saving...`;

  try {
    await runTransaction(db, async (tx) => {
      const state = await readServiceStoresForTx(tx);
      const servicesObj = { ...state.servicesObj };
      let nextPanelServiceId = state.nextPanelServiceId;

      let panelServiceId = String(
        existing?.panelServiceId
        || existing?.serviceId
        || $("editPanelServiceId")?.value
        || ""
      ).trim();

      if (!panelServiceId) {
        nextPanelServiceId += 1;
        panelServiceId = String(nextPanelServiceId);
      }

      writeServiceEntry(servicesObj, panelServiceId, {
        vendorId: serviceVendorId,
        vendorServiceId,
        vendorName,
        name: serviceName,
        title: serviceName,
        category: serviceCategory,
        description: serviceDescription,
        type: serviceType,
        min: serviceMin,
        max: serviceMax,
        rate: vendorPrice,
        vendorPrice,
        profit,
        userPrice,
        currency,
        exchangeRate,
        active: serviceActive,
        syncStatus: "ok",
        updatedAt: serverTimestamp(),
        lastSyncAt: serverTimestamp()
      });

      writeServiceStoresTx(tx, {
        counterRef: state.counterRef,
        servicesObj,
        previousServicesObj: state.previousServicesObj,
        nextPanelServiceId
      });
    });

    await refreshServiceOwnershipFromServices();
    await tryEnsureCategoriesInRegistry([serviceCategory]);
    clearPublicServiceCache();
    categoryRefreshNeeded = true;
    renderServices();

    if (editServiceModal) {
      editServiceModal.hide();
    }

    alert(existing ? "Service updated successfully." : "Service added successfully.");
  } catch (err) {
    console.error(err);
    alert(`Failed to save service: ${err.message}`);
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = oldLabel;
  }
}

async function toggleServiceStatus(serviceKeyInput) {
  const context = resolveServiceContext(serviceKeyInput);
  const key = context.key;
  const existing = serviceRegistryByComposite[key];
  if (!existing) {
    alert("Save this service once before toggling.");
    return;
  }

  const nextActive = existing.active === false;

  try {
    await runTransaction(db, async (tx) => {
      const state = await readServiceStoresForTx(tx);
      const servicesObj = { ...state.servicesObj };
      const panelServiceId = String(existing.panelServiceId || existing.serviceId || "").trim();
      if (!panelServiceId) return;

      writeServiceEntry(servicesObj, panelServiceId, {
        ...existing,
        panelServiceId,
        serviceId: panelServiceId,
        active: nextActive,
        updatedAt: serverTimestamp()
      });

      writeServiceStoresTx(tx, {
        counterRef: state.counterRef,
        servicesObj,
        previousServicesObj: state.previousServicesObj,
        nextPanelServiceId: state.nextPanelServiceId
      });
    });

    await refreshServiceOwnershipFromServices();
    clearPublicServiceCache();
    categoryRefreshNeeded = true;
    renderServices();
  } catch (err) {
    console.error(err);
    alert(`Failed to change status: ${err.message}`);
  }
}

async function deleteService(serviceKeyInput) {
  const context = resolveServiceContext(serviceKeyInput);
  const saved = context.saved;
  if (!saved) {
    alert("Saved service not found in database.");
    return;
  }

  const serviceName = String(saved.name || saved.title || "service").trim() || "service";
  const confirmMessage = `Delete "${serviceName}" from database? This cannot be undone.`;
  if (!confirm(confirmMessage)) return;

  const panelServiceId = String(saved.panelServiceId || saved.serviceId || saved.docId || "").trim();
  if (!isValidPanelServiceId(panelServiceId)) {
    alert("Service ID is invalid. Unable to delete this service.");
    return;
  }

  try {
    await runTransaction(db, async (tx) => {
      tx.delete(doc(db, SERVICE_COLLECTION_ID, panelServiceId));
    });

    await refreshServiceOwnershipFromServices();
    clearPublicServiceCache();
    categoryRefreshNeeded = true;
    renderServices();
    alert("Service deleted successfully.");
  } catch (err) {
    console.error(err);
    alert(`Delete failed: ${err.message}`);
  }
}

async function applyBulkCategoryChange() {
  const targetCategory = String($("bulkCategoryFilter")?.value || "").trim();
  if (!targetCategory) {
    alert("Please choose a category first.");
    return;
  }

  const updated = await runBulkServiceMutation({
    buttonId: "btnApplyBulkCategory",
    loadingLabel: "Applying...",
    targetCategory,
    confirmMessage: (count) => `Change category of ${count} selected service(s) to "${targetCategory}"?`,
    successMessage: (count) => `Category updated for ${count} service(s).`
  });

  if (updated && bulkCategoryModal) {
    bulkCategoryModal.hide();
  }
}

async function bulkSetSelectedServiceStatus(desiredActive) {
  await runBulkServiceMutation({
    buttonId: desiredActive ? "btnBulkActivateServices" : "btnBulkDisableServices",
    loadingLabel: desiredActive ? "Activating..." : "Disabling...",
    desiredActive,
    confirmMessage: (count) => `${desiredActive ? "Activate" : "Disable"} ${count} selected service(s)?`,
    successMessage: (count) => `${desiredActive ? "Activated" : "Disabled"} ${count} service(s).`
  });
}

async function bulkDeleteSelectedServices() {
  const selectedRecords = getSelectedBulkServiceRecords();
  if (!selectedRecords.length) {
    alert("Please select at least one service.");
    return;
  }

  const savedRecords = selectedRecords.filter((record) => {
    const existing = record.existing || null;
    return !!(existing && String(existing.docId || "").trim());
  });

  if (!savedRecords.length) {
    alert("Only saved services can be deleted.");
    return;
  }

  const skippedCount = selectedRecords.length - savedRecords.length;
  const confirmMessage = skippedCount
    ? `Delete ${savedRecords.length} saved service(s)?\n${skippedCount} unsaved service(s) will be skipped.`
    : `Delete ${savedRecords.length} selected service(s) from database? This cannot be undone.`;

  if (!confirm(confirmMessage)) return;

  const actionBtn = $("btnBulkDeleteServices");
  const oldLabel = actionBtn?.innerHTML || "";
  if (actionBtn) {
    actionBtn.disabled = true;
    actionBtn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> Deleting...`;
  }

  try {
    await runTransaction(db, async (tx) => {
      for (const record of savedRecords) {
        const existing = record.existing || {};
        const panelServiceId = String(
          existing.panelServiceId
          || existing.serviceId
          || existing.docId
          || ""
        ).trim();
        if (!isValidPanelServiceId(panelServiceId)) continue;
        tx.delete(doc(db, SERVICE_COLLECTION_ID, panelServiceId));
      }
    });

    await refreshServiceOwnershipFromServices();
    clearPublicServiceCache();
    categoryRefreshNeeded = true;
    renderServices();

    const suffix = skippedCount ? ` (${skippedCount} unsaved skipped)` : "";
    alert(`Deleted ${savedRecords.length} service(s)${suffix}.`);
  } catch (err) {
    console.error(err);
    alert(`Bulk delete failed: ${err.message}`);
  } finally {
    if (actionBtn) {
      actionBtn.disabled = false;
      actionBtn.innerHTML = oldLabel;
    }
  }
}

async function saveSelection() {
  await runBulkServiceMutation({
    buttonId: "btnSaveSelection",
    loadingLabel: "Saving...",
    successMessage: (count) => `Saved changes for ${count} selected service(s).`
  });
}

function bindEvents() {
  $("statusFilter")?.addEventListener("change", (e) => {
    setStatusFilter(String(e.target.value || "view:all").trim());
  });

  $("vendorFilter")?.addEventListener("change", (e) => {
    setVendorFilter(String(e.target.value || "").trim());
  });

  $("categoryFilter")?.addEventListener("change", () => {
    renderServices();
  });

  $("searchSvc")?.addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(renderServices, 300);
  });

  $("serviceTableBody")?.addEventListener("click", (e) => {
    const editBtn = e.target.closest(".svc-edit-btn");
    if (editBtn) {
      const serviceKey = String(editBtn.getAttribute("data-service-key") || "").trim();
      if (serviceKey) {
        openEditModal(serviceKey);
      }
      return;
    }

    const toggleBtn = e.target.closest(".svc-toggle-btn");
    if (toggleBtn && !toggleBtn.disabled) {
      const serviceKey = String(toggleBtn.getAttribute("data-service-key") || "").trim();
      if (serviceKey) {
        toggleServiceStatus(serviceKey);
      }
      return;
    }

    const deleteBtn = e.target.closest(".svc-delete-btn");
    if (deleteBtn && !deleteBtn.disabled) {
      const serviceKey = String(deleteBtn.getAttribute("data-service-key") || "").trim();
      if (serviceKey) {
        deleteService(serviceKey);
      }
    }
  });

  $("bulkSelectAll")?.addEventListener("change", (e) => {
    const checked = e.target.checked;
    document.querySelectorAll(".svc-bulk-chk").forEach((checkbox) => {
      checkbox.checked = checked;
    });
  });

  $("btnBulkChangeCategory")?.addEventListener("click", openBulkCategoryModal);
  $("btnApplyBulkCategory")?.addEventListener("click", applyBulkCategoryChange);
  $("btnBulkActivateServices")?.addEventListener("click", () => bulkSetSelectedServiceStatus(true));
  $("btnBulkDisableServices")?.addEventListener("click", () => bulkSetSelectedServiceStatus(false));
  $("btnBulkDeleteServices")?.addEventListener("click", bulkDeleteSelectedServices);
  $("btnSaveSelection")?.addEventListener("click", saveSelection);
  $("btnAddService")?.addEventListener("click", openVendorPickerModal);
  $("btnVendorPickerConfirm")?.addEventListener("click", confirmVendorSelectionAndLoadServices);
  $("btnSaveEditedService")?.addEventListener("click", saveEditedService);

  $("editVendorId")?.addEventListener("input", () => {
    refreshEditingCurrencyFromVendorInput();
    recalcEditUserPrice();
  });

  $("editVendorPrice")?.addEventListener("input", recalcEditUserPrice);
  $("editServiceProfit")?.addEventListener("input", recalcEditUserPrice);

  bindAdminLogout("btnLogout");
}

bindEvents();
loadConfig();


