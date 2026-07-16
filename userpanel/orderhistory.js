// orderhistory.js - Handles Orders History & Status Logic

import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  CacheTTL,
  readCache,
  writeCache,
  userSummaryKey,
  ordersKey
} from "./data-cache.js";
import { fetchUserSummaryFast, getActiveUsername } from "./firestore-fast.js";
import {
  appendMaintenanceKey,
  shouldTriggerSharedSync
} from "../scripts/status-sync.js";

const USERNAME = getActiveUsername();
const STATUS_API = "/api/status-check";
const STATUS_SYNC_MIN_GAP_MS = 5 * 60 * 1000;
const ORDER_COLLECTIONS = [
  "orders_active",
  "orders_completed",
  "orders_cancel",
  "orders_partial",
  "orders"
];
const ORDER_PAGE_SIZE = 25;
const USER_SUMMARY_CACHE_KEY = userSummaryKey(USERNAME);
const ORDERS_CACHE_KEY = ordersKey(USERNAME);
const ORDER_SEARCH_DEBOUNCE_MS = 90;

const $ = (id) => document.getElementById(id);

const userName = $("userName");
const userBalanceDisplay = $("userBalance");
const totalOrdersCount = $("totalOrdersCount");
const ordersContainer = $("ordersContainer");
const orderSearchInput = $("orderSearchInput");
const ordersPaginationWrap = $("ordersPaginationWrap");
const ordersPagination = $("ordersPagination");

let allOrders = [];
let filteredOrders = [];
let currentOrderPage = 1;
let orderSearchDebounceTimer = null;

function isContestRewardOrder(order = {}) {
  const category = String(order.orderCategory || "").toLowerCase().trim();
  const chargeLabel = String(order.chargeLabel || "").toLowerCase().trim();
  return category === "contest_reward" || chargeLabel === "contest";
}

function buildStatusApiUrl() {
  return appendMaintenanceKey(STATUS_API);
}

function shouldTriggerStatusSync() {
  return shouldTriggerSharedSync({ minGapMs: STATUS_SYNC_MIN_GAP_MS });
}

function applyUserSummaryToUI(summary = {}) {
  if (!summary || typeof summary !== "object") return;
  if (userBalanceDisplay) {
    userBalanceDisplay.textContent = `\u20B9${Number(summary.balance || 0).toFixed(2)}`;
  }
  if (userName) {
    userName.textContent = String(summary.username || "").trim();
  }
}

function normalizeStatus(value) {
  return String(value || "").toLowerCase().trim();
}

function buildOrderSearchText(order) {
  return [
    order.orderId,
    order.serviceTitle,
    order.link,
    order.status,
    order.date
  ]
    .map((v) => String(v || "").toLowerCase())
    .join(" ");
}

function splitOrderDate(rawDate) {
  const text = String(rawDate || "");
  if (!text) return { datePart: "-", timePart: "-" };
  const parts = text.split(",");
  return {
    datePart: String(parts[0] || "-").trim() || "-",
    timePart: String(parts[1] || "-").trim() || "-"
  };
}

function sanitizeHttpUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return "#";
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch {
    // ignore malformed urls
  }
  return "#";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

async function fetchOrdersForUser(username) {
  if (!username) return [];

  const snaps = await Promise.all(
    ORDER_COLLECTIONS.map((collectionName) =>
      getDocs(query(collection(db, collectionName), where("payer", "==", username)))
    )
  );

  const rows = [];
  const seenIds = new Set();

  snaps.forEach((snap) => {
    snap.forEach((docSnap) => {
      const row = docSnap.data() || {};
      if (isContestRewardOrder(row)) return;

      const dedupeKey = String(docSnap.id);
      if (seenIds.has(dedupeKey)) return;
      seenIds.add(dedupeKey);
      const { datePart, timePart } = splitOrderDate(row.date);
      rows.push({
        docId: docSnap.id,
        ...row,
        __statusKey: normalizeStatus(row.status),
        __searchText: buildOrderSearchText(row),
        __datePart: datePart,
        __timePart: timePart
      });
    });
  });

  rows.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  return rows;
}

function getActiveStatusFilter() {
  const activeBtn = document.querySelector(".filter-btn.active");
  return String(activeBtn?.getAttribute("data-filter") || "all").toLowerCase();
}

function matchesSearch(order, term) {
  if (!term) return true;
  const hay = String(order.__searchText || "").toLowerCase();
  return hay.includes(term);
}

function getVisiblePageTokens(totalPages, activePage) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  if (activePage <= 2) {
    return [1, 2, 3, "...", totalPages];
  }

  if (activePage >= totalPages - 1) {
    return [1, "...", totalPages - 2, totalPages - 1, totalPages];
  }

  return [1, "...", activePage - 1, activePage, activePage + 1, "...", totalPages];
}

function buildPageButton(labelHtml, page, { disabled = false, active = false, ellipsis = false } = {}) {
  const itemClasses = [
    "page-item",
    disabled ? "disabled" : "",
    active ? "active" : "",
    ellipsis ? "ellipsis" : ""
  ].filter(Boolean).join(" ");

  if (disabled || ellipsis || !page) {
    return `<li class="${itemClasses}"><span class="page-link">${labelHtml}</span></li>`;
  }

  return `<li class="${itemClasses}"><button type="button" class="page-link" data-page="${page}">${labelHtml}</button></li>`;
}

function renderOrderPagination(totalPages) {
  if (!ordersPaginationWrap || !ordersPagination) return;

  if (totalPages <= 1) {
    ordersPaginationWrap.classList.add("d-none");
    ordersPagination.innerHTML = "";
    return;
  }

  ordersPaginationWrap.classList.remove("d-none");
  const tokens = getVisiblePageTokens(totalPages, currentOrderPage);

  let html = "";
  html += buildPageButton('<i class="bi bi-chevron-left"></i>', currentOrderPage - 1, {
    disabled: currentOrderPage <= 1
  });

  tokens.forEach((token) => {
    if (token === "...") {
      html += buildPageButton("...", null, { ellipsis: true });
      return;
    }
    html += buildPageButton(String(token), token, { active: token === currentOrderPage });
  });

  html += buildPageButton('<i class="bi bi-chevron-right"></i>', currentOrderPage + 1, {
    disabled: currentOrderPage >= totalPages
  });

  ordersPagination.innerHTML = html;
}

function renderCurrentOrderPage() {
  if (!ordersContainer) return;

  const total = filteredOrders.length;
  const totalPages = total ? Math.ceil(total / ORDER_PAGE_SIZE) : 0;

  if (totalOrdersCount) totalOrdersCount.textContent = `Total: ${total} Orders`;
  ordersContainer.innerHTML = "";

  if (!total) {
    ordersContainer.innerHTML = '<div class="text-center mt-5 text-muted"><p>No orders found.</p></div>';
    renderOrderPagination(0);
    return;
  }

  const pageStart = (currentOrderPage - 1) * ORDER_PAGE_SIZE;
  const pageRows = filteredOrders.slice(pageStart, pageStart + ORDER_PAGE_SIZE);

  const html = pageRows.map((order) => {
    const chargeText = `\u20B9${Number(order.amount || 0).toFixed(2)}`;
    const safeLink = sanitizeHttpUrl(order.link);
    const safeLinkHref = escapeHtml(safeLink);
    const linkLabel = String(order.link || "#");
    const statusLabel = String(order.status || "Processing");
    const statusClass = statusLabel
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[^a-z0-9_-]/g, "");
    const safeOrderId = escapeHtml(order.orderId || "ID");
    const safeStatus = escapeHtml(statusLabel);
    const safeServiceTitle = escapeHtml(order.serviceTitle || "Unknown");
    const safeLinkLabel = escapeHtml(linkLabel);
    const safeQty = escapeHtml(order.qty);
    const safeRemains = escapeHtml(order.remains != null ? order.remains : "-");
    const safeStartCount = escapeHtml(order.startCount || "-");
    const safeDatePart = escapeHtml(order.__datePart || "-");
    const safeTimePart = escapeHtml(order.__timePart || "-");
    const safeChargeText = escapeHtml(chargeText);

    return `
      <div class="order-card">
        <div class="d-flex justify-content-between align-items-center">
          <div class="order-id">#${safeOrderId}</div>
          <span class="status-badge status-${statusClass || "processing"}">${safeStatus}</span>
        </div>
        <div class="service-title">${safeServiceTitle}</div>
        <div class="link-box"><a href="${safeLinkHref}" target="_blank" rel="noopener">${safeLinkLabel}</a></div>
        <div class="row detail-row">
          <div class="col-4"><div class="detail-label">Qty</div><div class="detail-val">${safeQty}</div></div>
          <div class="col-4"><div class="detail-label">Charge</div><div class="detail-val">${safeChargeText}</div></div>
          <div class="col-4 text-end"><div class="detail-label">Date</div><div class="detail-val">${safeDatePart}</div></div>
          <div class="col-4"><div class="detail-label">Remains</div><div class="detail-val">${safeRemains}</div></div>
          <div class="col-4"><div class="detail-label">Start</div><div class="detail-val">${safeStartCount}</div></div>
          <div class="col-4 text-end"><div class="detail-label">Time</div><div class="detail-val">${safeTimePart}</div></div>
        </div>
      </div>
    `;
  }).join("");

  ordersContainer.innerHTML = html;
  renderOrderPagination(totalPages);
}

function applyFiltersAndRender(resetPage = true) {
  const statusFilter = getActiveStatusFilter();
  const term = String(orderSearchInput?.value || "").trim().toLowerCase();

  filteredOrders = allOrders.filter((order) => {
    const statusOk = statusFilter === "all" || String(order.__statusKey || "") === statusFilter;
    return statusOk && matchesSearch(order, term);
  });

  const totalPages = filteredOrders.length ? Math.ceil(filteredOrders.length / ORDER_PAGE_SIZE) : 0;
  if (resetPage) currentOrderPage = 1;
  if (totalPages && currentOrderPage > totalPages) currentOrderPage = totalPages;
  if (!totalPages) currentOrderPage = 1;

  renderCurrentOrderPage();
}

if (userName) userName.textContent = "";
if (userBalanceDisplay) userBalanceDisplay.textContent = "";

async function loadUserPanel() {
  if (!USERNAME) return;

  const cachedUserSummary = readCache(USER_SUMMARY_CACHE_KEY, {
    maxAgeMs: CacheTTL.userSummary
  });
  if (cachedUserSummary) {
    applyUserSummaryToUI(cachedUserSummary);
  }

  try {
    const summary = await fetchUserSummaryFast(USERNAME, { forceRefresh: true });
    if (!summary) return;
    applyUserSummaryToUI(summary);
    writeCache(USER_SUMMARY_CACHE_KEY, summary);
  } catch (err) {
    console.error("loadUserPanel error:", err);
  }
}

async function loadUserOrdersHistory() {
  if (!ordersContainer) return;

  const cachedOrders = readCache(ORDERS_CACHE_KEY, {
    maxAgeMs: CacheTTL.orders
  });
  if (Array.isArray(cachedOrders) && cachedOrders.length) {
    allOrders = cachedOrders.filter((row) => !isContestRewardOrder(row));
    applyFiltersAndRender(true);
  }

  if (shouldTriggerStatusSync()) {
    fetch(buildStatusApiUrl(), { method: "GET", keepalive: true }).catch((err) =>
      console.error("Status check trigger failed", err)
    );
  }

  try {
    allOrders = await fetchOrdersForUser(USERNAME);
    writeCache(ORDERS_CACHE_KEY, allOrders);
    applyFiltersAndRender(true);
  } catch (err) {
    console.error("History Error:", err);
    ordersContainer.innerHTML = '<div class="text-center mt-5 text-danger"><p>Failed to load orders.</p></div>';
    renderOrderPagination(0);
  }
}

const filterBtns = document.querySelectorAll(".filter-btn");
filterBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    filterBtns.forEach((item) => item.classList.remove("active"));
    btn.classList.add("active");
    applyFiltersAndRender(true);
  });
});

if (orderSearchInput) {
  orderSearchInput.addEventListener("input", () => {
    if (orderSearchDebounceTimer) clearTimeout(orderSearchDebounceTimer);
    orderSearchDebounceTimer = setTimeout(() => {
      applyFiltersAndRender(true);
    }, ORDER_SEARCH_DEBOUNCE_MS);
  });
}

if (ordersPagination) {
  ordersPagination.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-page]");
    if (!button) return;

    const targetPage = Number(button.getAttribute("data-page") || 0);
    const totalPages = filteredOrders.length ? Math.ceil(filteredOrders.length / ORDER_PAGE_SIZE) : 0;

    if (!targetPage || targetPage < 1 || targetPage > totalPages || targetPage === currentOrderPage) return;

    currentOrderPage = targetPage;
    renderCurrentOrderPage();
  });
}

(async function init() {
  await Promise.allSettled([
    loadUserPanel(),
    loadUserOrdersHistory()
  ]);
})();
