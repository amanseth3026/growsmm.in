import { db } from "../firebase.js";
import {
  mergeCategoryOrder,
  readCachedCategoryOrder,
  writeCategoryOrderCache
} from "./category-order.js";
import { readAllServiceDocsFromCollection } from "./services-collection.js";
import {
  getDoc,
  doc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const tableBody = document.getElementById("servicesTableBody");
const searchInput = document.getElementById("servicesSearchInput");
const categoryFilter = document.getElementById("servicesCategoryFilter");
const categoryBtn = document.getElementById("servicesCategoryBtn");
const categoryLabel = document.getElementById("servicesCategoryLabel");
const categoryList = document.getElementById("servicesCategoryList");
const categoryItems = document.getElementById("servicesCategoryItems");

const descModalEl = document.getElementById("serviceDescModal");
const descTitle = document.getElementById("descTitle");
const descMeta = document.getElementById("descMeta");
const descText = document.getElementById("descText");

let descModal = null;
let allServices = [];
let filteredServices = [];
let filterTimer = null;
let categoryOrder = [];
const serviceByUid = new Map();

const SERVICE_CACHE_KEY = "growsmm_public_services_v3";
const SERVICE_CACHE_TTL_MS = 20 * 60 * 1000;
const FILTER_DEBOUNCE_MS = 120;

function normalizeCategory(category) {
  const clean = String(category || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) return "Other";
  return clean;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    };
    return map[char] || char;
  });
}

function formatPrice(rateInr) {
  const safeRate = Number(rateInr || 0);
  return `\u20b9${safeRate.toFixed(4)}`;
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
    const services = Array.isArray(parsed?.services) ? parsed.services : [];
    return services.map((service, index) =>
      normalizeService(
        {
          ...service,
          source: "cache"
        },
        index
      )
    );
  } catch {
    return null;
  }
}

function writeServiceCache(services) {
  try {
    const payload = {
      savedAt: Date.now(),
      expiresAt: Date.now() + SERVICE_CACHE_TTL_MS,
      services: services.map((service) => ({
        id: service.id,
        name: service.name,
        category: service.category,
        description: service.description,
        min: service.min,
        max: service.max,
        rateInr: service.rateInr,
        avgTime: service.avgTime
      }))
    };
    localStorage.setItem(SERVICE_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage failures.
  }
}

function normalizeService(raw, index) {
  const displayId = String(raw.displayId ?? raw.id ?? raw.service ?? index + 1);
  const min = Number(raw.min ?? raw.minQty ?? 0);
  const max = Number(raw.max ?? raw.maxQty ?? 0);
  const rateInr = Number(raw.rateInr ?? raw.userPrice ?? raw.rate ?? 0);
  const normalizedCategory = normalizeCategory(raw.category);

  return {
    uid: `${displayId}_${index}_${raw.source || "svc"}`,
    id: displayId,
    name: String(raw.name ?? raw.title ?? "Unnamed Service"),
    category: normalizedCategory,
    categoryKey: normalizedCategory.toLowerCase(),
    description: String(raw.description ?? "No description available"),
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 0,
    rateInr: Number.isFinite(rateInr) ? rateInr : 0,
    avgTime: String(raw.avgTime ?? ""),
    searchText: [
      displayId,
      raw.name ?? raw.title ?? "",
      normalizedCategory,
      raw.description ?? ""
    ].join(" ").toLowerCase()
  };
}

function indexServices(list = []) {
  serviceByUid.clear();
  list.forEach((service) => {
    serviceByUid.set(String(service.uid || ""), service);
  });
}

function sortServices(list) {
  return [...list].sort((a, b) => {
    const byCategory = a.category.localeCompare(b.category, undefined, { sensitivity: "base" });
    if (byCategory !== 0) return byCategory;
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    if (byName !== 0) return byName;
    return String(a.id).localeCompare(String(b.id), undefined, { numeric: true, sensitivity: "base" });
  });
}

async function loadCategoryOrder() {
  const cached = readCachedCategoryOrder();
  if (cached) {
    categoryOrder = cached;
    return;
  }

  try {
    const snap = await getDoc(doc(db, "meta", "service_categories"));
    if (!snap.exists()) {
      categoryOrder = [];
      return;
    }

    const categories = snap.data()?.categories;
    if (!Array.isArray(categories)) {
      categoryOrder = [];
      return;
    }

    categoryOrder = mergeCategoryOrder(categories, []);
    writeCategoryOrderCache(categoryOrder);
  } catch (error) {
    console.warn("Failed to load category order:", error);
  }
}

async function fetchServicesFromStore() {
  const { rows } = await readAllServiceDocsFromCollection(db, {
    includeDeleted: false
  });

  const list = rows
    .filter((saved) => saved.active !== false && saved.deleted !== true)
    .map((saved, index) => normalizeService(
      {
        displayId: saved.panelServiceId ?? saved.serviceId ?? saved.displayId ?? index + 1,
        name: saved.name || saved.title || "Unnamed Service",
        category: saved.category || "Other",
        description: saved.description || "No description available",
        min: saved.min,
        max: saved.max,
        rateInr: saved.userPrice ?? saved.rateInr ?? saved.rate ?? saved.vendorPrice ?? 0,
        avgTime: saved.average_time || saved.avgTime || saved.time || "",
        source: "firebase"
      },
      index
    ));

  return sortServices(list);
}

function closeCategoryDropdown() {
  if (!categoryList || !categoryBtn) return;
  categoryList.classList.remove("is-open");
  categoryBtn.setAttribute("aria-expanded", "false");
}

function openCategoryDropdown() {
  if (!categoryList || !categoryBtn) return;
  categoryList.classList.add("is-open");
  categoryBtn.setAttribute("aria-expanded", "true");
}

function toggleCategoryDropdown() {
  if (!categoryList) return;
  if (categoryList.classList.contains("is-open")) {
    closeCategoryDropdown();
    return;
  }
  openCategoryDropdown();
}

function setCategorySelection(value, label, shouldFilter = true) {
  const selectedValue = String(value || "all").toLowerCase();
  const selectedLabel = String(label || "All Categories");

  if (categoryFilter) categoryFilter.value = selectedValue;
  if (categoryLabel) categoryLabel.textContent = selectedLabel;

  if (categoryItems) {
    categoryItems.querySelectorAll("[data-category-value]").forEach((option) => {
      const optionValue = String(option.getAttribute("data-category-value") || "").toLowerCase();
      const isActive = optionValue === selectedValue;
      option.classList.toggle("is-active", isActive);
      option.setAttribute("aria-selected", isActive ? "true" : "false");
    });
  }

  closeCategoryDropdown();
  if (shouldFilter) applyFilters();
}

function populateCategoryFilter() {
  if (!categoryFilter) return;

  const categories = mergeCategoryOrder(
    categoryOrder,
    [...new Set(allServices.map((service) => service.category))]
  );

  const previousValue = String(categoryFilter.value || "all").toLowerCase();
  const options = [
    { value: "all", label: "All Categories" },
    ...categories.map((category) => ({ value: category.toLowerCase(), label: category }))
  ];

  if (categoryItems) {
    categoryItems.innerHTML = options.map((option) => `
      <button
        type="button"
        class="custom-dd-item services-dd-item"
        data-category-value="${escapeHtml(option.value)}"
        data-category-label="${escapeHtml(option.label)}"
        role="option"
      >${escapeHtml(option.label)}</button>
    `).join("");
  }

  const selectedOption = options.find((option) => option.value === previousValue) || options[0];
  setCategorySelection(selectedOption.value, selectedOption.label, false);
}

function applyFilters() {
  const term = String(searchInput?.value || "").trim().toLowerCase();
  const selectedCategory = String(categoryFilter?.value || "all").toLowerCase();

  filteredServices = allServices.filter((service) => {
    const matchesCategory = selectedCategory === "all" || service.categoryKey === selectedCategory;
    if (!matchesCategory) return false;

    if (!term) return true;
    return String(service.searchText || "").includes(term);
  });

  renderTable();
}

function scheduleApplyFilters() {
  if (filterTimer) {
    clearTimeout(filterTimer);
  }
  filterTimer = setTimeout(() => {
    applyFilters();
  }, FILTER_DEBOUNCE_MS);
}

function createCategoryRows(services) {
  const groups = new Map();
  services.forEach((service) => {
    const key = service.categoryKey || normalizeCategory(service.category).toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, {
        name: normalizeCategory(service.category),
        items: []
      });
    }
    groups.get(key).items.push(service);
  });

  const rows = [];
  const orderedCategories = mergeCategoryOrder(
    categoryOrder,
    [...groups.values()].map((group) => group.name)
  );

  for (const category of orderedCategories) {
    const group = groups.get(normalizeCategory(category).toLowerCase());
    if (!group) continue;
    const items = group.items;

    rows.push(
      `<tr class="category-row"><td colspan="6">${escapeHtml(category)} <span class="count">${items.length} services</span></td></tr>`
    );

    items.forEach((service) => {
      rows.push(`
        <tr>
          <td>${escapeHtml(service.id)}</td>
          <td><div class="service-name">${escapeHtml(service.name)}</div></td>
          <td class="price-cell">${escapeHtml(formatPrice(service.rateInr))}</td>
          <td class="min-cell">${service.min > 0 ? service.min : "-"}</td>
          <td class="max-cell">${service.max > 0 ? service.max : "-"}</td>
          <td>
            <button type="button" class="view-btn" data-view="${escapeHtml(service.uid)}">View</button>
          </td>
        </tr>
      `);
    });
  }

  return rows.join("");
}

function renderTable() {
  if (!filteredServices.length) {
    const message = allServices.length
      ? "No services match your search/filter."
      : "No services available right now.";
    tableBody.innerHTML = `<tr class="empty-row"><td colspan="6">${message}</td></tr>`;
    return;
  }

  tableBody.innerHTML = createCategoryRows(filteredServices);
}

function openDescription(service) {
  if (!service) return;
  if (!descModal) descModal = new bootstrap.Modal(descModalEl);

  descTitle.textContent = service.name;
  descText.textContent = service.description || "No description available";
  descMeta.innerHTML = `
    <span class="desc-chip">ID: ${escapeHtml(service.id)}</span>
    <span class="desc-chip">Category: ${escapeHtml(service.category)}</span>
    <span class="desc-chip">Price: ${escapeHtml(formatPrice(service.rateInr))}</span>
    <span class="desc-chip">Min: ${service.min > 0 ? service.min : "-"}</span>
    <span class="desc-chip">Max: ${service.max > 0 ? service.max : "-"}</span>
    ${service.avgTime ? `<span class="desc-chip">Avg Time: ${escapeHtml(service.avgTime)}</span>` : ""}
  `;

  descModal.show();
}

async function loadServices() {
  tableBody.innerHTML = `<tr class="empty-row"><td colspan="6">Loading services...</td></tr>`;

  const categoryOrderPromise = loadCategoryOrder();
  const cachedList = readServiceCache();
  if (cachedList !== null) {
    allServices = sortServices(cachedList);
    indexServices(allServices);
    await categoryOrderPromise;
    populateCategoryFilter();
    applyFilters();

    fetchServicesFromStore()
      .then(async (freshList) => {
        allServices = freshList;
        indexServices(allServices);
        writeServiceCache(allServices);
        await categoryOrderPromise;
        populateCategoryFilter();
        applyFilters();
      })
      .catch((error) => {
        console.warn("Background service refresh failed:", error);
      });
    return;
  }

  try {
    allServices = await fetchServicesFromStore();
    indexServices(allServices);
    writeServiceCache(allServices);
    await categoryOrderPromise;
    populateCategoryFilter();
    applyFilters();
  } catch (error) {
    console.error("Failed to load services from Firebase:", error);
    if (!allServices.length) {
      allServices = [];
      filteredServices = [];
      await categoryOrderPromise;
      populateCategoryFilter();
      tableBody.innerHTML = `<tr class="empty-row"><td colspan="6">Unable to load services right now. Please try again.</td></tr>`;
    }
  }
}

tableBody.addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (!button) return;
  const uid = button.getAttribute("data-view");
  const service = serviceByUid.get(String(uid || "")) || null;
  openDescription(service);
});

searchInput?.addEventListener("input", scheduleApplyFilters);
categoryBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleCategoryDropdown();
});

categoryItems?.addEventListener("click", (event) => {
  const option = event.target.closest("[data-category-value]");
  if (!option) return;
  const value = option.getAttribute("data-category-value") || "all";
  const label = option.getAttribute("data-category-label") || "All Categories";
  setCategorySelection(value, label, true);
});

document.addEventListener("click", (event) => {
  if (!categoryList || !categoryBtn) return;
  if (categoryBtn.contains(event.target) || categoryList.contains(event.target)) return;
  closeCategoryDropdown();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeCategoryDropdown();
});

loadServices();

