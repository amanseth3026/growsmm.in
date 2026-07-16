import { db } from "../firebase.js";
import {
  mergeCategoryOrder,
  categoryKey,
  readCachedCategoryOrder,
  writeCategoryOrderCache
} from "../category-order.js";
import {
  collection, getDocs, getDoc, query, where, doc, limit
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  CacheTTL,
  readCache,
  writeCache,
  userSummaryKey,
  orderCountKey
} from "./data-cache.js";
import {
  DEFAULT_ORDER_COLLECTIONS,
  fetchUserOrderCountFast,
  fetchUserSummaryFast,
  getActiveUsername
} from "./firestore-fast.js";
import {
  appendMaintenanceKey,
  shouldTriggerSharedSync
} from "../scripts/status-sync.js";
import { readAllServiceDocsFromCollection } from "../scripts/services-collection.js";

const USERNAME = getActiveUsername();
const ORDER_API = "/api/order";
const STATUS_API = "/api/status-check";
const STATUS_SYNC_MIN_GAP_MS = 5 * 60 * 1000;
const ORDER_COLLECTIONS = DEFAULT_ORDER_COLLECTIONS;
const SERVICE_CACHE_TTL_MS = 20 * 60 * 1000;
const SERVICE_CACHE_VERSION = 3;
const SERVICE_CACHE_KEY = `smm_services_cache_v${SERVICE_CACHE_VERSION}_${USERNAME || "guest"}`;
const CATEGORY_ORDER_DOC_ID = "service_categories";
const USER_SUMMARY_CACHE_KEY = userSummaryKey(USERNAME);
const ORDER_COUNT_CACHE_KEY = orderCountKey(USERNAME);
const GLOBAL_SERVICE_SEARCH_MIN_LEN = 2;
const GLOBAL_SERVICE_SEARCH_LIMIT = 20;
const GLOBAL_SERVICE_SEARCH_DEBOUNCE_MS = 70;
const SERVICE_RENDER_INITIAL = 120;
const SERVICE_RENDER_BATCH = 80;
const BOOTSTRAP_USER_SUMMARY = readCache(USER_SUMMARY_CACHE_KEY, {
  maxAgeMs: CacheTTL.userSummary
});

// --- SAFE DOM SELECTOR ---
const $ = id => document.getElementById(id);

// --- DOM ELEMENTS ---
const userName = $("userName");
const userBalanceDisplay = $("userBalance");
const userOrdersDisplay = $("userOrders");

// Dropdown Elements
const catBtn = $("catBtn");
const catList = $("catList");
const catItems = $("catItems");
const svcBtn = $("svcBtn");
const svcList = $("svcList");
const svcItems = $("svcItems");
const svcSearch = document.getElementById("svcSearch");
const svcSearchResults = document.getElementById("svcSearchResults");

const serviceDesc = $("serviceDesc");
const avgTimeDisplay = $("avgTimeDisplay");
const avgTimeValue = $("avgTimeValue");

const orderLinkInput = $("orderLink");
const orderQtyInput = $("orderQty");
const qtyHint = $("qtyHint");
const orderPriceInput = $("orderPrice");
const btnPlaceOrder = $("btnPlaceOrder");

// --- CUSTOM COMMENTS ELEMENTS ---
const commentsArea = $("commentsArea");
const orderComments = $("orderComments");
const commentsCountInfo = $("commentsCountInfo");
const customCommentsToggleWrap = $("customCommentsToggleWrap");
const customCommentsToggle = $("customCommentsToggle");

let hybridServices = {};
let currentService = null;
let currentUser = BOOTSTRAP_USER_SUMMARY && typeof BOOTSTRAP_USER_SUMMARY === "object"
  ? { ...BOOTSTRAP_USER_SUMMARY }
  : null;
let currentQty = 0;
let allServices = [];
let categoryOrder = [];
let dropdownGlobalHandlersBound = false;
let globalSearchTimer = null;
let selectedCategoryName = "";
let selectedCategoryServices = [];
let selectedCategoryFilteredServices = [];
let selectedServiceRenderCursor = 0;
let serviceListScrollBound = false;

function getServiceCachePricingFingerprint() {
  const extraProfit = Number(currentUser?.extraProfit || 0);
  const discount = Number(currentUser?.discount || 0);
  return `${extraProfit}|${discount}`;
}

function readServiceCache() {
  try {
    const raw = localStorage.getItem(SERVICE_CACHE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const expiresAt = Number(parsed?.expiresAt || 0);
    if (!expiresAt || Date.now() > expiresAt) {
      localStorage.removeItem(SERVICE_CACHE_KEY);
      return null;
    }

    if (String(parsed?.pricing || "") !== getServiceCachePricingFingerprint()) {
      return null;
    }

    const cachedHybrid = parsed?.hybridServices;
    const cachedAll = parsed?.allServices;
    if (!cachedHybrid || typeof cachedHybrid !== "object" || !Array.isArray(cachedAll)) {
      return null;
    }

    return {
      hybridServices: cachedHybrid,
      allServices: cachedAll
    };
  } catch {
    return null;
  }
}

function writeServiceCache() {
  try {
    const payload = {
      savedAt: Date.now(),
      expiresAt: Date.now() + SERVICE_CACHE_TTL_MS,
      pricing: getServiceCachePricingFingerprint(),
      hybridServices,
      allServices
    };
    localStorage.setItem(SERVICE_CACHE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn("Service cache write failed:", err?.message || err);
  }
}

function normalizeText(value) {
  return String(value || "").toLowerCase().trim();
}

function buildServiceSearchText(service) {
  return [
    service.title,
    service.name,
    service.id,
    service.displayId,
    service.category
  ]
    .map((item) => String(item || "").toLowerCase())
    .join(" ");
}

function normalizeServiceForRuntime(service) {
  const normalized = { ...(service || {}) };
  normalized.title = String(normalized.title || normalized.name || "Unnamed Service");
  normalized.name = String(normalized.name || normalized.title || "Unnamed Service");
  normalized.id = String(normalized.id || "").trim();
  normalized.displayId = String(normalized.displayId || normalized.id).trim();
  normalized.category = String(normalized.category || "Other").trim() || "Other";
  normalized.searchText = buildServiceSearchText(normalized);
  return normalized;
}

function hydrateServiceIndexes() {
  allServices = Array.isArray(allServices)
    ? allServices.map((service) => normalizeServiceForRuntime(service))
    : [];

  const nextBuckets = {};
  Object.entries(hybridServices || {}).forEach(([category, items]) => {
    const cleanCategory = String(category || "Other").trim() || "Other";
    nextBuckets[cleanCategory] = Array.isArray(items)
      ? items.map((service) => normalizeServiceForRuntime(service))
      : [];
  });
  hybridServices = nextBuckets;
}

function clearServiceSearchResults() {
  if (!svcSearchResults) return;
  svcSearchResults.innerHTML = "";
  svcSearchResults.style.display = "none";
}

function createServiceItemNode(service, onClick) {
  const safeTitle = escapeHtml(service.title || "");
  const safeDisplayId = escapeHtml(service.displayId || service.id || "-");
  const safeAvgTime = escapeHtml(service.displayAvgTime || formatAvgTime(service.avgTime));
  const safePrice = Number(service.userPrice || 0).toFixed(2);

  const div = document.createElement("div");
  div.className = "custom-dd-item";
  div.style.display = "block";
  div.innerHTML = `
    <div style="width:100%; min-width:0;">
        <div class="fw-bold text-dark" style="font-size:0.85rem;">${safeTitle}</div>
        <div class="d-flex justify-content-between mt-1">
            <span class="badge bg-light text-dark border">ID: ${safeDisplayId}</span>
            <span class="badge bg-primary bg-opacity-10 text-primary">&#8377;${safePrice}</span>
        </div>
        <div class="text-muted small mt-1"><i class="bi bi-stopwatch"></i> ${safeAvgTime}</div>
    </div>
  `;
  div.onclick = onClick;
  return div;
}

async function loadCategoryOrder() {
  const cached = readCachedCategoryOrder();
  if (cached) {
    categoryOrder = cached;
    return;
  }

  try {
    const snap = await getDoc(doc(db, "meta", CATEGORY_ORDER_DOC_ID));
    if (!snap.exists()) {
      categoryOrder = [];
      return;
    }

    const saved = snap.data()?.categories;
    if (!Array.isArray(saved)) {
      categoryOrder = [];
      return;
    }

    categoryOrder = mergeCategoryOrder(saved, []);
    writeCategoryOrderCache(categoryOrder);
  } catch (err) {
    console.warn("Category order load failed:", err?.message || err);
  }
}

function buildStatusApiUrl() {
  return appendMaintenanceKey(STATUS_API);
}

function shouldTriggerStatusSync() {
  return shouldTriggerSharedSync({ minGapMs: STATUS_SYNC_MIN_GAP_MS });
}

async function getUserOrderCount(username) {
  if (!username) return 0;
  return fetchUserOrderCountFast(username, {
    collections: ORDER_COLLECTIONS,
    forceRefresh: true
  });
}

async function triggerStatusCheckOnLoad() {
  if (!shouldTriggerStatusSync()) return;
  try {
    await fetch(buildStatusApiUrl(), { method: "GET", keepalive: true });
  } catch (e) { console.warn("Status check failed:", e.message); }
}

function applyUserSummaryToUI(summary = {}) {
  if (!summary || typeof summary !== "object") return;
  if (!currentUser) currentUser = {};
  currentUser = { ...currentUser, ...summary };

  if (userBalanceDisplay) {
    userBalanceDisplay.textContent = `\u20B9${Number(currentUser.balance || 0).toFixed(2)}`;
  }

  if (userName) {
    userName.textContent = String(currentUser.username || currentUser.displayName || "").trim();
  }
}

function cacheCurrentUserSummary() {
  if (!currentUser || !USERNAME) return;
  const normalizedUsername = String(currentUser.username || "").trim();
  if (!normalizedUsername) return;
  writeCache(USER_SUMMARY_CACHE_KEY, {
    id: String(currentUser.id || "").trim(),
    username: normalizedUsername,
    email: String(currentUser.email || "").trim(),
    balance: Number(currentUser.balance || 0),
    extraProfit: Number(currentUser.extraProfit || 0),
    discount: Number(currentUser.discount || 0),
    timezone: String(currentUser.timezone || "Asia/Kolkata").trim(),
    whatsapp: String(currentUser.whatsapp || "").trim()
  });
}

// --- LOAD USER PANEL ---
// keep user placeholders empty until cached/firestore data arrives
if (userName) userName.textContent = "";
if (userBalanceDisplay) userBalanceDisplay.textContent = "";
if (userOrdersDisplay) userOrdersDisplay.textContent = "";

async function loadUserPanel() {
  if (!USERNAME) return;
  const cachedUserSummary = BOOTSTRAP_USER_SUMMARY;
  if (cachedUserSummary) {
    applyUserSummaryToUI(cachedUserSummary);
  }

  const cachedOrderCountRaw = readCache(ORDER_COUNT_CACHE_KEY, {
    maxAgeMs: CacheTTL.orderCount
  });
  const cachedOrderCount = Number(cachedOrderCountRaw);
  const hasCachedOrderCount = Number.isFinite(cachedOrderCount) && cachedOrderCount >= 0;
  if (hasCachedOrderCount && userOrdersDisplay) {
    userOrdersDisplay.textContent = String(cachedOrderCount);
  }

  const refreshOrderCount = () => {
    getUserOrderCount(USERNAME)
      .then((freshCount) => {
        if (!Number.isFinite(freshCount)) return;
        writeCache(ORDER_COUNT_CACHE_KEY, Number(freshCount));
        if (userOrdersDisplay) userOrdersDisplay.textContent = String(freshCount);
      })
      .catch((err) => {
        console.warn("Order count background refresh failed:", err?.message || err);
      });
  };

  try {
    const summary = await fetchUserSummaryFast(USERNAME, { forceRefresh: true });
    if (summary) {
      currentUser = { ...summary };
      applyUserSummaryToUI(currentUser);
      cacheCurrentUserSummary();
    }
  } catch (err) {
    console.error("loadUserPanel error:", err);
  } finally {
    // Order count is informative, so refresh it in the background instead of blocking the page.
    refreshOrderCount();
  }
}

// --- HELPER: Icon ---
function getCategoryIcon(name) {
    const n = String(name || "").toLowerCase();
    if(n.includes("instagram")) return '<i class="bi bi-instagram text-danger"></i>';
    if(n.includes("facebook")) return '<i class="bi bi-facebook text-primary"></i>';
    if(n.includes("youtube")) return '<i class="bi bi-youtube text-danger"></i>';
    if(n.includes("telegram")) return '<i class="bi bi-telegram text-info"></i>';
    if(n.includes("twitter") || n.includes("x ")) return '<i class="bi bi-twitter-x"></i>';
    if(n.includes("tiktok")) return '<i class="bi bi-tiktok"></i>';
    return '<i class="bi bi-hdd-stack text-muted"></i>';
}

function formatAvgTime(timeStr) {
    const t = String(timeStr || "").trim();
    const tLower = t.toLowerCase();
    if (!t || tLower === "not available" || tLower === "not specified" || tLower === "n/a" || tLower === "0") {
        return "Instantly / 1 hour";
    }
    if(!isNaN(t)) {
        const mins = Number(t);
        if(mins > 60) {
            const h = Math.floor(mins / 60);
            const m = mins % 60;
            return `${h} Hour(s) ${m} Min`;
        }
        return `${mins} Minutes`;
    }
    return t.replace(/-/g, " ");
}

function extractServiceAvgTime(service) {
  if (!service || typeof service !== "object") return "";

  const candidates = [
    service.average_time,
    service.avg_time,
    service.time,
    service.averageTime,
    service.avgTime,
    service.estimated_time,
    service.estimatedTime,
    service.average_delivery_time,
    service.delivery_time,
    service.speed,
    service["average time"],
    service["avg time"],
    service["delivery time"],
    service["Average Time"],
    service["AVG TIME"]
  ];

  for (const value of candidates) {
    const clean = String(value ?? "").trim();
    if (clean && clean.toLowerCase() !== "null" && clean.toLowerCase() !== "undefined") {
      return clean;
    }
  }

  const fallback = Object.entries(service).find(([key, value]) => {
    const k = String(key || "").toLowerCase();
    const v = String(value ?? "").trim();
    if (!v) return false;
    if (/(avg|average)/.test(k) && /time|delivery|speed/.test(k)) return true;
    return false;
  });

  return fallback ? String(fallback[1]).trim() : "";
}

// --- DESCRIPTION FORMATTER ---
function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, function (c) {
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]);
  });
}

function formatDescription(text) {
  if (!text) return "";
  const lines = String(text).split(/\r\n|\r|\n/).map(l => l.replace(/\t+/g, '    ').trim());

  // If every non-empty line is a list item, render a single <ul>
  const nonEmpty = lines.filter(l => l !== "");
  const allListLike = nonEmpty.length > 0 && nonEmpty.every(l => /^[-•\*]\s+/.test(l));
  if (allListLike) {
    const items = nonEmpty.map(l => '<li>' + escapeHtml(l.replace(/^[-•\*]\s+/, '')) + '</li>');
    return '<ul>' + items.join('') + '</ul>';
  }

  // Mixed content: transform sequences of list-lines into <ul>, others into <p>
  let html = '';
  let inList = false;
  for (const raw of lines) {
    const l = raw;
    if (/^[-•\*]\s+/.test(l)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += '<li>' + escapeHtml(l.replace(/^[-•\*]\s+/, '')) + '</li>';
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      if (l === '') html += '<br>'; else html += '<p style="margin:0 0 8px;">' + escapeHtml(l) + '</p>';
    }
  }
  if (inList) html += '</ul>';
  return html;
}

// --- AUTO-RESIZE SERVICE DESCRIPTION BOX ---
function adjustServiceDescHeight() {
  try {
    if (!serviceDesc) return;
    // reset to natural height first
    serviceDesc.style.height = 'auto';
    const max = 420; // px
    const sh = serviceDesc.scrollHeight || 0;
    if (sh > max) {
      serviceDesc.style.height = max + 'px';
      serviceDesc.style.overflowY = 'auto';
    } else {
      serviceDesc.style.height = (sh ? sh + 'px' : 'auto');
      serviceDesc.style.overflowY = 'hidden';
    }
  } catch (e) { /* ignore */ }
}

let pendingDescResizeFrame = null;
function scheduleServiceDescResize() {
  if (pendingDescResizeFrame) return;
  pendingDescResizeFrame = requestAnimationFrame(() => {
    pendingDescResizeFrame = null;
    if (serviceDesc && serviceDesc.style.display !== "none") adjustServiceDescHeight();
  });
}

// adjust on window resize if visible
window.addEventListener("resize", scheduleServiceDescResize, { passive: true });

function applyServicePayload(payload) {
  hybridServices = payload?.hybridServices || {};
  allServices = payload?.allServices || [];
  hydrateServiceIndexes();
}

async function fetchHybridServicesFromFirestore() {
  const [vendorSnap, serviceStore, manualSnap] = await Promise.all([
    getDocs(collection(db, "vendors")),
    readAllServiceDocsFromCollection(db, {
      includeDeleted: false
    }),
    getDocs(collection(db, "manual_services"))
  ]);

  const vendorExchangeMap = {};
  vendorSnap.forEach((d) => {
    const v = d.data() || {};
    vendorExchangeMap[d.id] = {
      currency: String(v.currency || "INR").toUpperCase(),
      exchangeRate: Number(v.exchangeRate) || 1
    };
  });

  const nextHybridServices = {};
  const nextAllServices = [];
  const userExtraProfit = Number(currentUser?.extraProfit || 0);
  const userDiscount = Number(currentUser?.discount || 0);

  const calcUserRate = (panelRate) => {
    const step1 = Number(panelRate || 0) * (1 + userExtraProfit / 100);
    const step2 = step1 * (1 - userDiscount / 100);
    return Number(step2.toFixed(4));
  };

  const convertToInr = (rawRate, vendorId) => {
    let inr = Number(rawRate || 0);
    const vendorInfo = vendorExchangeMap[String(vendorId || "").trim()];
    if (vendorInfo?.currency === "USD") {
      inr = inr * (Number(vendorInfo.exchangeRate) || 1);
    }
    return Number(inr || 0);
  };

  const addServiceToBuckets = (serviceLike) => {
    const normalized = normalizeServiceForRuntime(serviceLike);
    if (!nextHybridServices[normalized.category]) nextHybridServices[normalized.category] = [];
    nextHybridServices[normalized.category].push(normalized);
    nextAllServices.push(normalized);
  };

  serviceStore.rows.forEach((service) => {
    if (service.deleted === true || service.active === false) return;

    const cleanPanelServiceId = String(service.panelServiceId || service.serviceId || "").trim();
    if (!cleanPanelServiceId) return;
    const vendorServiceId = String(service.vendorServiceId || service.service || cleanPanelServiceId).trim();

    const effectiveVendorId = String(service.vendorId || "").trim();
    const profit = Number(service.profit || 0);
    const rawRate = Number(service.rate ?? service.vendorPrice ?? 0);
    const baseRateInr = convertToInr(rawRate, effectiveVendorId);

    let panelRate = 0;
    if (baseRateInr > 0) {
      panelRate = baseRateInr * (1 + profit / 100);
    } else {
      panelRate = Number(service.userPrice || service.rateInr || 0);
    }

    const userPrice = calcUserRate(panelRate);
    const rawTime = extractServiceAvgTime(service) || "Not available";
    const displayAvgTime = formatAvgTime(rawTime);

    addServiceToBuckets({
      id: cleanPanelServiceId,
      displayId: String(service.displayId || cleanPanelServiceId),
      vendorServiceId,
      title: service.name || service.title || "Unnamed Service",
      name: service.name || service.title || "Unnamed Service",
      type: service.type || service.serviceType || "",
      category: service.category || "Other",
      description: service.description || service.desc || "",
      minQty: Number(service.min ?? service.minQty ?? 1),
      maxQty: Number(service.max ?? service.maxQty ?? 0),
      userPrice,
      avgTime: rawTime,
      displayAvgTime
    });
  });

  manualSnap.forEach((d) => {
    const m = d.data();
    if (m?.active === false) return;
    const manualAvg = m.avgTime || "Manual";
    addServiceToBuckets({
      id: `manual_${d.id}`,
      displayId: String(d.id),
      vendorServiceId: "",
      title: m.title || "Manual Service",
      name: m.title || "Manual Service",
      type: m.type || "Manual",
      category: m.category || "Manual",
      description: m.description || "",
      minQty: Number(m.minQty || 1),
      maxQty: Number(m.maxQty || 0),
      userPrice: Number(m.userPrice || 0),
      avgTime: manualAvg,
      displayAvgTime: formatAvgTime(manualAvg)
    });
  });

  return {
    hybridServices: nextHybridServices,
    allServices: nextAllServices
  };
}

// --- LOAD SERVICES (With Currency Conversion) ---
async function loadHybridServices() {
  if (!catBtn) return;
  const categoryOrderPromise = loadCategoryOrder();
  const cached = readServiceCache();
  let renderedFromCache = false;

  if (cached) {
    applyServicePayload(cached);
    renderedFromCache = true;
    await categoryOrderPromise;
    initCustomDropdowns();

    fetchHybridServicesFromFirestore()
      .then(async (freshPayload) => {
        applyServicePayload(freshPayload);
        writeServiceCache();
        await categoryOrderPromise;
        initCustomDropdowns();
      })
      .catch((err) => {
        console.warn("Background services refresh failed:", err?.message || err);
      });
    return;
  }

  try {
    const freshPayload = await fetchHybridServicesFromFirestore();
    applyServicePayload(freshPayload);

    if (!allServices.length && catItems) {
      catItems.innerHTML = '<div class="text-muted p-3">Services are currently unavailable. Please try again later.</div>';
    }

    writeServiceCache();
    await categoryOrderPromise;
    initCustomDropdowns();
  } catch (err) {
    console.error("Services Load Error:", err);
    if (!renderedFromCache && catItems) {
      catItems.innerHTML = '<div class="text-muted p-3">Services are currently unavailable. Please try again later.</div>';
    }
  }
}

let renderServices = () => {};

// --- CUSTOM DROPDOWNS ---
function initCustomDropdowns() {
  const categories = mergeCategoryOrder(categoryOrder, Object.keys(hybridServices));
  let currentSelectedCategory = selectedCategoryName && categories.includes(selectedCategoryName)
    ? selectedCategoryName
    : "";

  const renderCategoryServiceChunk = (reset = false) => {
    if (!svcItems) return;
    if (reset) {
      svcItems.innerHTML = "";
      selectedServiceRenderCursor = 0;
    }

    const total = selectedCategoryFilteredServices.length;
    if (!total || selectedServiceRenderCursor >= total) return;

    const targetCursor = reset
      ? Math.min(total, SERVICE_RENDER_INITIAL)
      : Math.min(total, selectedServiceRenderCursor + SERVICE_RENDER_BATCH);
    const fragment = document.createDocumentFragment();

    for (let i = selectedServiceRenderCursor; i < targetCursor; i += 1) {
      const service = selectedCategoryFilteredServices[i];
      fragment.appendChild(
        createServiceItemNode(service, () => {
          selectService(service);
          svcList.style.display = "none";
        })
      );
    }

    selectedServiceRenderCursor = targetCursor;
    svcItems.appendChild(fragment);
  };

  const selectCategory = (cat, { openServiceList = false } = {}) => {
    const categoryServices = hybridServices[cat] || [];
    const firstService = categoryServices[0] || null;
    const currentServiceId = String(currentService?.id || "").trim();
    const preservedService = currentServiceId
      ? categoryServices.find((service) => String(service.id || "").trim() === currentServiceId)
      : null;
    const nextSelectedService = preservedService || firstService;
    currentSelectedCategory = cat;
    selectedCategoryName = cat;
    const safeCategory = escapeHtml(cat);

    catBtn.innerHTML = `
      <div class="text-truncate" style="max-width: 95%; display: inline-block; font-size: 13px;">
        ${getCategoryIcon(cat)} ${safeCategory}
      </div>
      <i class="bi bi-chevron-down small"></i>
    `;
    catList.style.display = "none";
    svcBtn.style.opacity = "1";
    svcBtn.style.pointerEvents = "auto";
    svcBtn.innerHTML = `<span>Select Service</span> <i class="bi bi-chevron-down small"></i>`;

    if (catItems) {
      catItems.querySelectorAll(".custom-dd-item").forEach((item) => {
        const itemCategory = String(item.getAttribute("data-category-value") || "").trim();
        item.classList.toggle("is-active", categoryKey(itemCategory) === categoryKey(cat));
      });
    }

    renderServices(cat);
    if (nextSelectedService) {
      const sameServiceSelected = String(currentService?.id || "").trim() === String(nextSelectedService.id || "").trim();
      if (!sameServiceSelected) {
        selectService(nextSelectedService);
      }
    }

    if (openServiceList) {
      setTimeout(() => { svcList.style.display = "block"; }, 100);
    } else {
      svcList.style.display = "none";
    }
  };

  const renderCats = () => {
    if (!catItems) return;
    catItems.innerHTML = "";
    const fragment = document.createDocumentFragment();

    categories.forEach((cat) => {
      const safeCategory = escapeHtml(cat);
      const div = document.createElement("div");
      div.className = "custom-dd-item";
      div.setAttribute("data-category-value", cat);
      if (currentSelectedCategory && categoryKey(cat) === categoryKey(currentSelectedCategory)) {
        div.classList.add("is-active");
      }
      div.innerHTML = `${getCategoryIcon(cat)} <span>${safeCategory}</span>`;
      div.onclick = () => selectCategory(cat, { openServiceList: true });
      fragment.appendChild(div);
    });

    catItems.appendChild(fragment);
  };
  renderCats();

  renderServices = (cat, filter = "") => {
    if (cat) {
      selectedCategoryServices = hybridServices[cat] || [];
    }
    const q = normalizeText(filter);
    selectedCategoryFilteredServices = !q
      ? selectedCategoryServices
      : selectedCategoryServices.filter((service) => String(service.searchText || "").includes(q));
    renderCategoryServiceChunk(true);
  };

  if (!serviceListScrollBound && svcList) {
    svcList.addEventListener("scroll", () => {
      if (svcList.style.display === "none") return;
      if (svcList.scrollTop + svcList.clientHeight + 48 < svcList.scrollHeight) return;
      renderCategoryServiceChunk(false);
    }, { passive: true });
    serviceListScrollBound = true;
  }

  const toggle = (btn, list) => {
    const isHidden = list.style.display === "none" || list.style.display === "";
    catList.style.display = "none";
    svcList.style.display = "none";
    if (isHidden) list.style.display = "block";
  };

  catBtn.onclick = (e) => { e.stopPropagation(); toggle(catBtn, catList); };
  svcBtn.onclick = (e) => { e.stopPropagation(); toggle(svcBtn, svcList); };

  if (!dropdownGlobalHandlersBound) {
    document.addEventListener("click", (e) => {
      if (!catBtn.contains(e.target) && !catList.contains(e.target)) catList.style.display = "none";
      if (!svcBtn.contains(e.target) && !svcList.contains(e.target)) svcList.style.display = "none";
    });
    dropdownGlobalHandlersBound = true;
  }

  if (categories.length) {
    selectCategory(currentSelectedCategory || categories[0], { openServiceList: false });
  }
}

// --- GLOBAL SEARCH ---
if (svcSearch && svcSearchResults) {
  const runGlobalServiceSearch = () => {
    const q = normalizeText(svcSearch.value);
    svcSearchResults.innerHTML = "";

    if (q.length < GLOBAL_SERVICE_SEARCH_MIN_LEN) {
      clearServiceSearchResults();
      return;
    }

    const matches = [];
    for (let i = 0; i < allServices.length; i += 1) {
      const service = allServices[i];
      if (!String(service.searchText || "").includes(q)) continue;
      matches.push(service);
      if (matches.length >= GLOBAL_SERVICE_SEARCH_LIMIT) break;
    }

    if (!matches.length) {
      clearServiceSearchResults();
      return;
    }

    const fragment = document.createDocumentFragment();
    matches.forEach((service) => {
      fragment.appendChild(
        createServiceItemNode(service, () => {
          selectedCategoryName = service.category;
          const safeCategory = escapeHtml(service.category);
          catBtn.innerHTML = `<span>${getCategoryIcon(service.category)} ${safeCategory}</span><i class="bi bi-chevron-down small"></i>`;
          svcBtn.style.opacity = "1";
          svcBtn.style.pointerEvents = "auto";
          if (catItems) {
            catItems.querySelectorAll(".custom-dd-item").forEach((item) => {
              const itemCategory = String(item.getAttribute("data-category-value") || "").trim();
              item.classList.toggle("is-active", categoryKey(itemCategory) === categoryKey(service.category));
            });
          }
          renderServices(service.category);
          selectService(service);
          svcSearch.value = "";
          clearServiceSearchResults();
        })
      );
    });

    svcSearchResults.appendChild(fragment);
    svcSearchResults.style.display = "block";
  };

  svcSearch.addEventListener("input", () => {
    if (globalSearchTimer) clearTimeout(globalSearchTimer);
    globalSearchTimer = setTimeout(runGlobalServiceSearch, GLOBAL_SERVICE_SEARCH_DEBOUNCE_MS);
  });

  document.addEventListener("click", (e) => {
    if (!svcSearch.contains(e.target) && !svcSearchResults.contains(e.target)) {
      clearServiceSearchResults();
    }
  });
}

function isCustomComments(svc) {
    if (!svc || typeof svc !== "object") return false;
    const rawType = String(svc.type || svc.serviceType || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    return rawType.includes("custom") && rawType.includes("comment");
}

function countCommentLines(text) {
  if (!text) return 0;
  return String(text)
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function syncCustomCommentQty() {
  const count = countCommentLines(orderComments?.value || "");
  if (orderQtyInput) orderQtyInput.value = String(count);
  if (commentsCountInfo) commentsCountInfo.textContent = `${count} comments`;
  calcTotal();
}

// toggle handler to show/hide comments area when checkbox used for non-custom services
if (customCommentsToggle) {
  customCommentsToggle.addEventListener('change', () => {
    if (customCommentsToggle.checked) {
      if (commentsArea) commentsArea.style.display = 'block';
      if (orderQtyInput) { orderQtyInput.readOnly = true; orderQtyInput.placeholder = 'Enter comments above'; }
    } else {
      if (commentsArea) commentsArea.style.display = 'none';
      if (orderQtyInput) { orderQtyInput.readOnly = false; orderQtyInput.placeholder = '0'; orderQtyInput.value = currentService ? currentService.minQty : '' ; }
    }
  });
}

if (orderComments) {
  orderComments.addEventListener("input", () => {
    if (isCustomComments(currentService)) syncCustomCommentQty();
  });
}

function selectService(s) {
    currentService = s;
    const shownId = s.displayId || s.id;
    const safeShownId = escapeHtml(shownId);
    const safeTitle = escapeHtml(s.title || s.name || "");
    svcBtn.innerHTML = `<div class="text-truncate" style="max-width: 95%;font-size: 13px;"><span class="fw-bold text-primary small">ID:${safeShownId}</span> - ${safeTitle}</div><i class="bi bi-chevron-down small"></i>`;
    serviceDesc.style.display = "block";
    serviceDesc.classList.add('service-note');
    serviceDesc.innerHTML = formatDescription(s.description || s.desc || "");
    // Auto adjust height based on content
    scheduleServiceDescResize();
    
    avgTimeDisplay.style.display = "flex";
    avgTimeValue.textContent = s.displayAvgTime || formatAvgTime(s.avgTime);

    const customCommentService = isCustomComments(s);

    // Custom Comments Logic
    if (customCommentService) {
      if(commentsArea) commentsArea.style.display = "block";
      if(customCommentsToggleWrap) customCommentsToggleWrap.classList.add('d-none');
      if(customCommentsToggle) customCommentsToggle.checked = true;
        if(orderComments) orderComments.value = ""; 
        if(commentsCountInfo) commentsCountInfo.textContent = "0 comments";

        if(orderQtyInput) {
            orderQtyInput.value = "0";
            orderQtyInput.readOnly = true;
            orderQtyInput.placeholder = "Enter comments above";
        }

    } else {
      // show toggle for non-custom services allowing manual comments
      if(commentsArea) commentsArea.style.display = "none";
      if(customCommentsToggleWrap) customCommentsToggleWrap.classList.remove('d-none');
      if(customCommentsToggle) customCommentsToggle.checked = false;
        if(orderComments) orderComments.value = "";
        if(commentsCountInfo) commentsCountInfo.textContent = "0 comments";
        if(orderQtyInput) {
            orderQtyInput.readOnly = false;
            orderQtyInput.placeholder = "0";
            orderQtyInput.value = s.minQty;
        }
    }

    if(orderQtyInput && !customCommentService) {
      orderQtyInput.value = s.minQty;
    }
    
    if (orderQtyInput) {
        if (s.maxQty > 0) {
            qtyHint.textContent = `Min: ${s.minQty} - Max: ${s.maxQty}`;
            orderQtyInput.max = s.maxQty;
        } else {
            qtyHint.textContent = `Min: ${s.minQty}`;
            orderQtyInput.removeAttribute("max");
        }
    }
    calcTotal();
}

function calcTotal() {
  if(!currentService || !orderQtyInput || !orderPriceInput) return;
  const qty = Number(orderQtyInput.value);
  currentQty = qty;
  const total = (currentService.userPrice / 1000) * qty;
  orderPriceInput.value = `\u20B9${total.toFixed(4)}`;
  currentService.total = total;
}

if (orderQtyInput) orderQtyInput.addEventListener("input", calcTotal);

// --- PLACE ORDER ---
if (btnPlaceOrder) {
  btnPlaceOrder.addEventListener("click", async () => {
    const link = orderLinkInput.value.trim();
    const customCommentService = isCustomComments(currentService);
    
    let finalComments = "";
    if (customCommentService) {
        finalComments = orderComments.value.trim();
        if(!finalComments) return alert("Please enter comments!");
        currentQty = countCommentLines(finalComments);
        if (orderQtyInput) orderQtyInput.value = String(currentQty);
        calcTotal();
    }

    if (!currentService || !link || currentQty < currentService.minQty) return alert("Please check all fields.");
    if (currentService.maxQty > 0 && currentQty > currentService.maxQty) return alert("Max Qty Exceeded");
    if (!currentUser || Number(currentUser.balance || 0) < currentService.total) return alert("Low Balance. Please Add Funds.");

    btnPlaceOrder.disabled = true; btnPlaceOrder.textContent = "Placing...";

    // Run duplicate-check and order POST in parallel — cancel POST if a duplicate is found.
    const controller = new AbortController();

    const dupCheckPromise = (async () => {
      // Narrow duplicate check: only fetch the top few active orders on this exact link.
      const qCheck = query(
        collection(db, "orders_active"),
        where("payer", "==", USERNAME),
        where("link", "==", link),
        limit(5)
      );
      const checkSnap = await getDocs(qCheck);
      const activeOrder = checkSnap.docs.find(d => {
        const data = d.data();
        const st = (data.status || "").toLowerCase().trim();
        const isSameService = String(data.serviceId) === String(currentService.id);
        const isActive = ["pending", "processing", "in progress", "queue", "queued"].includes(st);
        return isSameService && isActive;
      });
      if (activeOrder) {
        controller.abort();
        const dupErr = new Error(`Order ALREADY ACTIVE on this link!\nStatus: ${activeOrder.data().status}\nPlease wait.`);
        dupErr.__duplicate = true;
        throw dupErr;
      }
      return null;
    })();

    const payload = {
      payer: USERNAME,
      serviceDocId: currentService.id,
      quantity: currentQty,
      link: link
    };
    if (finalComments) payload.comments = finalComments;

    const orderPromise = fetch(ORDER_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      keepalive: true
    }).then(async (res) => {
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed");
      return json;
    });

    try {
      // Wait for both — duplicate check gates the success.
      const [, json] = await Promise.all([dupCheckPromise, orderPromise]);

      $("osOrderId").textContent = json.orderId || "N/A";
      $("osServiceName").textContent = currentService.title;
      $("osLink").textContent = link;
      $("osQty").textContent = currentQty;
      $("osCharge").textContent = `\u20B9${currentService.total.toFixed(4)}`;
      const newBal = (currentUser.balance - currentService.total).toFixed(4);
      $("osBalance").textContent = `\u20B9${newBal}`;
      new bootstrap.Modal($("orderSuccessModal")).show();
    } catch (err) {
      // Swallow the AbortError that comes from cancelling the POST after a duplicate hit.
      if (err && (err.name === "AbortError" || err.__duplicate)) {
        if (err.__duplicate) alert(err.message);
      } else {
        alert(err.message || "Failed");
      }
    } finally {
      btnPlaceOrder.disabled = false; btnPlaceOrder.textContent = "PLACE ORDER";
    }
  });
}

// Init
(async function () {
  triggerStatusCheckOnLoad().catch(() => {});
  await loadUserPanel();
  await loadHybridServices();
})();






