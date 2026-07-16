import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  doc,
  setDoc,
  addDoc,
  deleteDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { initPanelSettings } from "./admin-panel-settings.js";
import { readAllServiceDocsFromCollection } from "../scripts/services-collection.js";
import {
  requireAdminAuth,
  initAdminSidebar,
  bindAdminLogout
} from "./admin-ui-common.js";

requireAdminAuth();

const ORDER_COLLECTIONS = [
  { name: "orders_active", priority: 1 },
  { name: "orders_partial", priority: 2 },
  { name: "orders_completed", priority: 3 },
  { name: "orders_cancel", priority: 4 },
  { name: "orders", priority: 0 }
];

const PROCESSING_STATUSES = new Set([
  "processing",
  "in progress",
  "inprogress",
  "queued",
  "queue",
  "running",
  "started"
]);

const COMPLETED_STATUSES = new Set([
  "completed",
  "complete",
  "success",
  "delivered"
]);

const numberFmt = new Intl.NumberFormat("en-IN");
const balanceFmt = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
const PROVIDER_BALANCE_ENDPOINT = "/api/vendor";
const ACTIVE_DAYS = 7;
const ACTIVE_WINDOW_MS = ACTIVE_DAYS * 24 * 60 * 60 * 1000;

const $ = (id) => document.getElementById(id);
let providerRows = [];
let providerServiceCountByVendor = {};
let providerBalanceByVendor = Object.create(null);
let providerBalanceRequestToken = 0;
let providerBalanceLoading = false;

function formatCount(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "0";
  return numberFmt.format(Math.max(0, Math.floor(n)));
}

function setText(id, value) {
  const el = $(id);
  if (!el) return;
  el.textContent = formatCount(value);
}

function setStatus(text, isError = false) {
  const statusEl = $("dashboardStatus");
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.toggle("error", !!isError);
}

function setRefreshState(loading) {
  const btn = $("btnRefreshDashboard");
  if (!btn) return;
  btn.disabled = !!loading;
  if (loading) {
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Refreshing`;
  } else {
    btn.innerHTML = `<i class="bi bi-arrow-clockwise"></i> Refresh`;
  }
}

function htmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function maskKey(keyRaw) {
  const key = String(keyRaw || "").trim();
  if (!key) return "-";
  if (key.length <= 8) return "********";
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

function parseBalanceNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;

  const cleaned = value.replace(/,/g, "").trim();
  if (!cleaned) return null;

  const match = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;

  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function getStoredProviderBalance(provider = {}) {
  const candidates = [
    provider.balance,
    provider.apiBalance,
    provider.api_balance,
    provider.walletBalance,
    provider.wallet_balance,
    provider.availableBalance,
    provider.available_balance,
    provider.currentBalance,
    provider.current_balance,
    provider.remainingBalance,
    provider.remaining_balance,
    provider.credit,
    provider.credits,
    provider.funds,
    provider.cash,
    provider.amount
  ];

  for (const candidate of candidates) {
    const parsed = parseBalanceNumber(candidate);
    if (parsed !== null) return parsed;
  }

  return null;
}

function extractProviderBalance(payload, seen = new Set(), depth = 0) {
  if (payload === null || payload === undefined || depth > 5) return null;

  if (typeof payload === "number" || typeof payload === "string") {
    return parseBalanceNumber(payload);
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = extractProviderBalance(item, seen, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }

  if (typeof payload !== "object") return null;
  if (seen.has(payload)) return null;
  seen.add(payload);

  const directKeys = [
    "balance",
    "apiBalance",
    "api_balance",
    "walletBalance",
    "wallet_balance",
    "availableBalance",
    "available_balance",
    "currentBalance",
    "current_balance",
    "remainingBalance",
    "remaining_balance",
    "balanceAmount",
    "credit",
    "credits",
    "funds",
    "cash",
    "money",
    "amount"
  ];

  const containerKeys = [
    "data",
    "result",
    "response",
    "raw",
    "account",
    "wallet",
    "info",
    "details"
  ];

  for (const key of directKeys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      const found = extractProviderBalance(payload[key], seen, depth + 1);
      if (found !== null) return found;
    }
  }

  for (const key of containerKeys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      const found = extractProviderBalance(payload[key], seen, depth + 1);
      if (found !== null) return found;
    }
  }

  return null;
}

function formatProviderBalance(value) {
  const parsed = parseBalanceNumber(value);
  if (parsed === null) return "-";
  return balanceFmt.format(parsed);
}

function getProviderBalanceCell(provider) {
  const liveBalance = Object.prototype.hasOwnProperty.call(providerBalanceByVendor, provider.id)
    ? providerBalanceByVendor[provider.id]
    : null;
  const balance = liveBalance !== null && liveBalance !== undefined
    ? liveBalance
    : getStoredProviderBalance(provider);

  if (balance === null) {
    const placeholder = providerBalanceLoading ? "Loading..." : "-";
    return `<span class="provider-balance text-muted">${htmlEscape(placeholder)}</span>`;
  }

  const toneClass = Number(balance) < 0 ? "text-danger" : "";
  return `<span class="provider-balance ${toneClass}">${htmlEscape(formatProviderBalance(balance))}</span>`;
}

async function fetchProviderBalance(provider) {
  const key = String(provider.key || "").trim();
  const url = String(provider.url || "").trim();

  if (!key || !url) return null;

  const response = await fetch(PROVIDER_BALANCE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: "balance",
      key,
      url
    })
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Invalid balance response.");
  }

  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.message || payload?.error || `Balance request failed (${response.status})`);
  }

  const balance = extractProviderBalance(payload?.data ?? payload);
  return balance !== null ? balance : null;
}

async function refreshProviderBalances(rows, token) {
  if (!rows.length) {
    if (token === providerBalanceRequestToken) {
      providerBalanceByVendor = Object.create(null);
      providerBalanceLoading = false;
      renderProviderInlineTable();
    }
    return;
  }

  const settled = await Promise.allSettled(rows.map((provider) => fetchProviderBalance(provider)));
  if (token !== providerBalanceRequestToken) return;

  const nextBalances = Object.create(null);
  settled.forEach((result, index) => {
    if (result.status !== "fulfilled") return;
    const balance = result.value;
    if (balance === null || balance === undefined) return;

    const providerId = String(rows[index]?.id || "").trim();
    if (!providerId) return;
    nextBalances[providerId] = balance;
  });

  providerBalanceByVendor = nextBalances;
  providerBalanceLoading = false;
  renderProviderInlineTable();
}

function normalizeStatus(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isCancelledStatus(status) {
  const st = normalizeStatus(status);
  return st === "canceled" || st === "cancelled" || st === "failed" || st === "rejected";
}

function isRefundedOrder(order = {}) {
  const status = normalizeStatus(order.status);
  if (status === "refunded") return true;
  if (order.refunded === true) return true;
  if (Number(order.refundAppliedTotal || 0) > 0) return true;
  if (Number(order.refundedAmount || 0) > 0) return true;
  if (Number(order.refund || 0) > 0) return true;
  return false;
}

function isDripfeedOrder(order = {}) {
  if (order.isDripfeed === true || order.isDripFeed === true || order.dripfeed === true) return true;
  if (Number(order.runs || 0) > 1 || Number(order.interval || 0) > 0) return true;
  const serviceType = String(order.serviceType || order.type || order.mode || "").toLowerCase();
  return serviceType.includes("drip");
}

function toMs(value) {
  if (!value) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value?.toDate && typeof value.toDate === "function") {
    const d = value.toDate();
    return d instanceof Date ? d.getTime() : 0;
  }
  if (typeof value === "object" && Number.isFinite(Number(value.seconds))) {
    return Number(value.seconds) * 1000;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function getOrderTime(order = {}) {
  return Math.max(
    toMs(order.updatedAt),
    toMs(order.statusUpdatedAt),
    toMs(order.completedAt),
    toMs(order.processingStartedAt),
    toMs(order.orderPlacedAt),
    toMs(order.createdAt),
    toMs(order.date)
  );
}

function getOrderIdentity(docId, order = {}) {
  const candidates = [
    order.orderDocId,
    order.docId,
    order.orderId,
    order.id,
    docId
  ].map((v) => String(v || "").trim()).filter(Boolean);

  if (candidates.length) return `oid:${candidates[0]}`;

  const fallback = [
    String(order.payer || "").trim(),
    String(order.serviceId || "").trim(),
    String(order.link || "").trim(),
    String(order.createdAt || "").trim()
  ].join("|");
  return fallback ? `fp:${fallback}` : `doc:${String(docId || "").trim()}`;
}

async function safeCollection(name) {
  try {
    const snap = await getDocs(collection(db, name));
    return { name, docs: snap.docs, size: snap.size, error: null };
  } catch (err) {
    console.warn(`Dashboard: collection load failed for ${name}`, err);
    return { name, docs: [], size: 0, error: err };
  }
}

async function safeActiveServices() {
  try {
    const { rows } = await readAllServiceDocsFromCollection(db, {
      includeDeleted: false
    });

    const docs = rows
      .map((service) => ({
        id: String(service.serviceId || service.panelServiceId || "").trim(),
        data: () => service
      }))
      .filter((row) => row.id);

    return { name: "services", docs, size: docs.length, error: null };
  } catch (err) {
    console.warn("Dashboard: active services load failed", err);
    return { name: "services", docs: [], size: 0, error: err };
  }
}

function dedupeOrders(collectionResults = []) {
  const deduped = new Map();

  collectionResults.forEach((result) => {
    const source = ORDER_COLLECTIONS.find((row) => row.name === result.name);
    const sourcePriority = Number(source?.priority || 0);

    result.docs.forEach((docSnap) => {
      const data = docSnap.data() || {};
      const identity = getOrderIdentity(docSnap.id, data);
      const eventTime = getOrderTime(data);
      const existing = deduped.get(identity);

      if (!existing) {
        deduped.set(identity, { ...data, __time: eventTime, __priority: sourcePriority });
        return;
      }

      if (eventTime > existing.__time) {
        deduped.set(identity, { ...data, __time: eventTime, __priority: sourcePriority });
        return;
      }

      if (eventTime === existing.__time && sourcePriority > existing.__priority) {
        deduped.set(identity, { ...data, __time: eventTime, __priority: sourcePriority });
      }
    });
  });

  return Array.from(deduped.values());
}

function buildOrderMetrics(allOrders = []) {
  const total = allOrders.length;
  const pending = allOrders.filter((o) => normalizeStatus(o.status) === "pending").length;
  const processing = allOrders.filter((o) => PROCESSING_STATUSES.has(normalizeStatus(o.status))).length;
  const completed = allOrders.filter((o) => COMPLETED_STATUSES.has(normalizeStatus(o.status))).length;
  const cancelled = allOrders.filter((o) => isCancelledStatus(o.status)).length;
  const refunded = allOrders.filter((o) => isRefundedOrder(o)).length;

  const dripfeedOrders = allOrders.filter((o) => isDripfeedOrder(o));
  const dripTotal = dripfeedOrders.length;
  const dripPending = dripfeedOrders.filter((o) => {
    const status = normalizeStatus(o.status);
    return status === "pending" || PROCESSING_STATUSES.has(status);
  }).length;

  return { total, pending, processing, completed, cancelled, refunded, dripTotal, dripPending };
}

function buildUserMetrics(usersResult, orders = [], paymentsResult) {
  const users = usersResult.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));

  const orderUsers = new Set();
  const activeUsers7d = new Set();
  const now = Date.now();
  const activeSince = now - ACTIVE_WINDOW_MS;

  orders.forEach((order) => {
    const username = String(order.payer || order.username || "").trim();
    if (!username) return;
    orderUsers.add(username);
    const t = getOrderTime(order);
    if (t >= activeSince) activeUsers7d.add(username);
  });

  const paidUsers = new Set();
  paymentsResult.docs.forEach((docSnap) => {
    const payment = docSnap.data() || {};
    const status = normalizeStatus(payment.status);
    if (!(status === "approved" || status === "completed")) return;
    if (Number(payment.amount || 0) <= 0) return;
    const username = String(payment.username || payment.payer || "").trim();
    if (username) paidUsers.add(username);
  });

  let balanced = 0;
  let normal = 0;
  let withOrders = 0;
  let withPayments = 0;
  let active7d = 0;

  users.forEach((u) => {
    const username = String(u.username || u.id || "").trim();
    const hasOrder = username ? orderUsers.has(username) : false;
    const hasPayment = username ? paidUsers.has(username) : false;
    const isActive = username ? activeUsers7d.has(username) : false;

    if (hasPayment) balanced += 1;
    if (!hasOrder && !hasPayment) normal += 1;
    if (hasOrder) withOrders += 1;
    if (hasPayment) withPayments += 1;
    if (isActive) active7d += 1;
  });

  return {
    total: users.length,
    active7d,
    balanced,
    normal,
    withOrders,
    withPayments
  };
}

function buildServiceMetrics(servicesResult, manualResult) {
  const vendorRows = servicesResult.docs.map((d) => d.data() || {});
  const manualRows = manualResult.docs.map((d) => d.data() || {});

  const vendorTotal = vendorRows.length;
  const vendorActive = vendorRows.filter((s) => s.active !== false).length;
  const manualTotal = manualRows.length;
  const manualActive = manualRows.filter((s) => s.active !== false).length;

  const total = vendorTotal + manualTotal;
  const active = vendorActive + manualActive;
  const inactive = Math.max(total - active, 0);

  const categories = new Set();
  vendorRows.forEach((s) => {
    const cat = String(s.category || "General").trim();
    if (cat) categories.add(cat.toLowerCase());
  });
  manualRows.forEach((s) => {
    const cat = String(s.category || "Manual").trim();
    if (cat) categories.add(cat.toLowerCase());
  });

  return { total, active, inactive, vendorTotal, manualTotal, categories: categories.size };
}

function buildPaymentMetrics(paymentsResult) {
  const rows = paymentsResult.docs.map((d) => d.data() || {});
  const total = rows.length;

  let approved = 0;
  let pending = 0;
  let failed = 0;
  let manual = 0;
  let auto = 0;

  rows.forEach((payment) => {
    const status = normalizeStatus(payment.status);
    const method = normalizeStatus(payment.method || "manual");

    if (status === "approved" || status === "completed") approved += 1;
    else if (status === "pending") pending += 1;
    else failed += 1;

    if (method === "auto") auto += 1;
    else manual += 1;
  });

  return { total, approved, pending, failed, manual, auto };
}

function buildProviderMetrics(vendorsResult, servicesResult) {
  const providerRows = vendorsResult.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
  const total = providerRows.length;

  const vendorIdsInServices = new Set(
    servicesResult.docs
      .map((docSnap) => docSnap.data() || {})
      .map((row) => String(row.vendorId || "").trim())
      .filter(Boolean)
  );

  const withServices = providerRows.filter((p) => vendorIdsInServices.has(String(p.id || "").trim())).length;
  const idle = Math.max(total - withServices, 0);

  return { total, withServices, idle };
}

function fmtDate(value) {
  const ms = toMs(value);
  if (!ms) return "-";
  return new Date(ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

function setProviderInlineStatus(message, tone = "") {
  const el = $("providerInlineStatus");
  if (!el) return;
  el.textContent = String(message || "").trim();
  el.classList.remove("error", "success");
  if (tone === "error") el.classList.add("error");
  if (tone === "success") el.classList.add("success");
}

function fillProviderInlineForm(provider = null) {
  $("providerInlineDocId").value = provider?.id || "";
  $("providerInlineName").value = provider?.name || "";
  $("providerInlineUrl").value = provider?.url || "";
  $("providerInlineKey").value = provider?.key || "";
  $("providerInlineProfit").value = Number(provider?.profit ?? 20);
  $("providerInlineCurrency").value = String(provider?.currency || "INR").toUpperCase();
  $("providerInlineExchange").value = Number(provider?.exchangeRate ?? 1) || 1;
}

function resetProviderInlineForm() {
  fillProviderInlineForm(null);
  setProviderInlineStatus("");
}

function getProviderInlinePayload() {
  const name = String($("providerInlineName")?.value || "").trim();
  const url = String($("providerInlineUrl")?.value || "").trim();
  const key = String($("providerInlineKey")?.value || "").trim();
  const profit = Number($("providerInlineProfit")?.value || 0);
  const currency = String($("providerInlineCurrency")?.value || "INR").toUpperCase();
  const exchangeRate = Number($("providerInlineExchange")?.value || 1) || 1;

  if (!name || !url || !key) {
    throw new Error("Provider name, API URL, and API key are required.");
  }

  return {
    name,
    url,
    key,
    profit: Number.isFinite(profit) ? profit : 0,
    currency,
    exchangeRate
  };
}

function renderProviderInlineTable() {
  const tbody = $("providerInlineTableBody");
  if (!tbody) return;

  const term = String($("providerInlineSearch")?.value || "").trim().toLowerCase();
  const rows = providerRows.filter((provider) => {
    const name = String(provider.name || "").toLowerCase();
    const url = String(provider.url || "").toLowerCase();
    const id = String(provider.id || "").toLowerCase();
    return !term || name.includes(term) || url.includes(term) || id.includes(term);
  });

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted py-3">No providers found.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((provider) => {
    const linkedServices = Number(providerServiceCountByVendor[provider.id] || 0);
    const updatedAt = provider.updatedAt || provider.createdAt || 0;

    return `
      <tr>
        <td>
          <div class="fw-semibold">${htmlEscape(provider.name || "Provider")}</div>
          <small class="text-muted">${htmlEscape(provider.id)}</small>
        </td>
        <td><small>${htmlEscape(provider.url || "-")}</small></td>
        <td><span class="masked-key">${htmlEscape(maskKey(provider.key))}</span></td>
        <td>${getProviderBalanceCell(provider)}</td>
        <td>${htmlEscape(String(provider.currency || "INR").toUpperCase())}</td>
        <td>${Number(provider.profit || 0).toFixed(2)}</td>
        <td>${linkedServices}</td>
        <td><small>${htmlEscape(fmtDate(updatedAt))}</small></td>
        <td class="d-flex gap-1">
          <button type="button" class="btn btn-sm btn-outline-primary provider-inline-action" data-action="edit" data-id="${htmlEscape(provider.id)}">
            <i class="bi bi-pencil"></i>
          </button>
          <button type="button" class="btn btn-sm btn-outline-danger provider-inline-action" data-action="delete" data-id="${htmlEscape(provider.id)}">
            <i class="bi bi-trash"></i>
          </button>
        </td>
      </tr>
    `;
  }).join("");
}

function syncProviderInlineState(vendorsResult, servicesResult) {
  providerServiceCountByVendor = {};
  servicesResult.docs.forEach((docSnap) => {
    const row = docSnap.data() || {};
    const vendorId = String(row.vendorId || "").trim();
    if (!vendorId) return;
    providerServiceCountByVendor[vendorId] = (providerServiceCountByVendor[vendorId] || 0) + 1;
  });

  providerRows = vendorsResult.docs.map((docSnap) => ({
    id: docSnap.id,
    ...(docSnap.data() || {})
  }));

  providerRows.sort((a, b) => {
    const ta = toMs(a.updatedAt || a.createdAt);
    const tb = toMs(b.updatedAt || b.createdAt);
    return tb - ta;
  });

  providerBalanceRequestToken += 1;
  const balanceToken = providerBalanceRequestToken;
  providerBalanceByVendor = Object.create(null);
  providerBalanceLoading = providerRows.length > 0;

  const editingDocId = String($("providerInlineDocId")?.value || "").trim();
  if (editingDocId && !providerRows.some((row) => row.id === editingDocId)) {
    resetProviderInlineForm();
  }

  renderProviderInlineTable();
  setProviderInlineStatus(`Loaded ${providerRows.length} provider(s).`);

  if (providerBalanceLoading) {
    refreshProviderBalances(providerRows, balanceToken).catch((err) => {
      if (balanceToken !== providerBalanceRequestToken) return;
      console.warn("Provider balance refresh failed:", err);
      providerBalanceLoading = false;
      renderProviderInlineTable();
    });
  }
}

function editProviderInline(docId) {
  const id = String(docId || "").trim();
  const row = providerRows.find((provider) => provider.id === id);
  if (!row) {
    setProviderInlineStatus("Provider not found.", "error");
    return;
  }

  fillProviderInlineForm(row);
  setProviderInlineStatus(`Editing provider: ${row.name || id}`);
  showSection("providers");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function removeProviderInline(docId) {
  const id = String(docId || "").trim();
  const row = providerRows.find((provider) => provider.id === id);
  if (!row) {
    setProviderInlineStatus("Provider not found.", "error");
    return;
  }

  const linked = Number(providerServiceCountByVendor[id] || 0);
  if (linked > 0) {
    alert(`Cannot delete provider "${row.name}". ${linked} services are linked to this provider. Please remove or reassign services first.`);
    return;
  }

  if (!confirm(`Delete provider "${row.name}" permanently?`)) return;

  try {
    await deleteDoc(doc(db, "vendors", id));
    if (String($("providerInlineDocId")?.value || "").trim() === id) {
      resetProviderInlineForm();
    }
    await loadDashboard();
    setProviderInlineStatus("Provider deleted successfully.", "success");
  } catch (err) {
    console.error("Provider delete failed:", err);
    setProviderInlineStatus("Provider delete failed.", "error");
  }
}

async function saveProviderInline(e) {
  e.preventDefault();

  const saveBtn = $("btnProviderSaveInline");
  if (!saveBtn) return;

  const oldLabel = saveBtn.innerHTML;
  saveBtn.disabled = true;
  saveBtn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> Saving...`;

  try {
    const payload = getProviderInlinePayload();
    const docId = String($("providerInlineDocId")?.value || "").trim();

    if (docId) {
      await setDoc(doc(db, "vendors", docId), {
        ...payload,
        updatedAt: serverTimestamp()
      }, { merge: true });
    } else {
      await addDoc(collection(db, "vendors"), {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    }

    resetProviderInlineForm();
    await loadDashboard();
    setProviderInlineStatus("Provider saved successfully.", "success");
    showSection("providers");
  } catch (err) {
    console.error("Provider save failed:", err);
    setProviderInlineStatus(err?.message || "Provider save failed.", "error");
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = oldLabel;
  }
}

function renderMetrics(metrics) {
  setText("metricOrders", metrics.orders.total);
  setText("metricUsers", metrics.users.total);
  setText("metricServices", metrics.services.total);
  setText("metricPayments", metrics.payments.total);
  setText("metricProviders", metrics.providers.total);

  setText("ordersTotal", metrics.orders.total);
  setText("ordersPending", metrics.orders.pending);
  setText("ordersProcessing", metrics.orders.processing);
  setText("ordersCompleted", metrics.orders.completed);
  setText("ordersCancelled", metrics.orders.cancelled);
  setText("ordersRefunded", metrics.orders.refunded);
  setText("ordersDripTotal", metrics.orders.dripTotal);
  setText("ordersDripPending", metrics.orders.dripPending);

  setText("usersTotal", metrics.users.total);
  setText("usersActive7d", metrics.users.active7d);
  setText("usersBalanced", metrics.users.balanced);
  setText("usersNormal", metrics.users.normal);
  setText("usersWithOrders", metrics.users.withOrders);
  setText("usersWithPayments", metrics.users.withPayments);

  setText("servicesTotal", metrics.services.total);
  setText("servicesActive", metrics.services.active);
  setText("servicesInactive", metrics.services.inactive);
  setText("servicesVendorTotal", metrics.services.vendorTotal);
  setText("servicesManualTotal", metrics.services.manualTotal);
  setText("servicesCategories", metrics.services.categories);

  setText("paymentsTotal", metrics.payments.total);
  setText("paymentsApproved", metrics.payments.approved);
  setText("paymentsPending", metrics.payments.pending);
  setText("paymentsFailed", metrics.payments.failed);
  setText("paymentsManual", metrics.payments.manual);
  setText("paymentsAuto", metrics.payments.auto);

  setText("providersTotal", metrics.providers.total);
  setText("providersWithServices", metrics.providers.withServices);
  setText("providersIdle", metrics.providers.idle);
}

function showSection(target) {
  const sections = {
    orders: $("section-orders"),
    users: $("section-users"),
    services: $("section-services"),
    payments: $("section-payments"),
    providers: $("section-providers")
  };

  Object.entries(sections).forEach(([key, el]) => {
    if (!el) return;
    if (key === target) el.classList.remove("hidden");
    else el.classList.add("hidden");
  });

  document.querySelectorAll(".metric-toggle").forEach((btn) => {
    const btnTarget = String(btn.getAttribute("data-target") || "").trim();
    btn.classList.toggle("active", btnTarget === target);
  });
}

async function loadDashboard() {
  setRefreshState(true);
  setStatus("Loading dashboard data...");

  try {
    const names = [
      "users",
      ...ORDER_COLLECTIONS.map((row) => row.name),
      "payments",
      "vendors",
      "manual_services"
    ];

    const [servicesResult, ...results] = await Promise.all([
      safeActiveServices(),
      ...names.map((name) => safeCollection(name))
    ]);
    const byName = Object.fromEntries(results.map((row) => [row.name, row]));
    byName.services = servicesResult;
    const failed = [servicesResult, ...results].filter((row) => row.error);

    const dedupedOrders = dedupeOrders(
      ORDER_COLLECTIONS.map((row) => byName[row.name]).filter(Boolean)
    );

    const metrics = {
      orders: buildOrderMetrics(dedupedOrders),
      users: buildUserMetrics(byName.users || { docs: [] }, dedupedOrders, byName.payments || { docs: [] }),
      services: buildServiceMetrics(byName.services || { docs: [] }, byName.manual_services || { docs: [] }),
      payments: buildPaymentMetrics(byName.payments || { docs: [] }),
      providers: buildProviderMetrics(byName.vendors || { docs: [] }, byName.services || { docs: [] })
    };

    renderMetrics(metrics);
    syncProviderInlineState(byName.vendors || { docs: [] }, byName.services || { docs: [] });

    if (failed.length) {
      setStatus(`Loaded with partial data. Missing: ${failed.map((f) => f.name).join(", ")}`, true);
    } else {
      const now = new Date();
      setStatus(`Last updated: ${now.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`);
    }
  } catch (err) {
    console.error("Dashboard load failed:", err);
    setStatus("Dashboard load failed. Please refresh.", true);
  } finally {
    setRefreshState(false);
  }
}

function bindEvents() {
  $("btnRefreshDashboard")?.addEventListener("click", loadDashboard);

  document.querySelectorAll(".metric-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = String(btn.getAttribute("data-target") || "orders").trim();
      showSection(target);
    });
  });

  $("providerFormInline")?.addEventListener("submit", saveProviderInline);
  $("btnProviderNewInline")?.addEventListener("click", resetProviderInlineForm);
  $("btnProviderCancelInline")?.addEventListener("click", resetProviderInlineForm);
  $("providerInlineSearch")?.addEventListener("input", renderProviderInlineTable);

  $("providerInlineTableBody")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".provider-inline-action");
    if (!btn) return;

    const action = String(btn.getAttribute("data-action") || "").trim();
    const id = String(btn.getAttribute("data-id") || "").trim();
    if (!id) return;

    if (action === "edit") {
      editProviderInline(id);
      return;
    }
    if (action === "delete") {
      removeProviderInline(id);
    }
  });

  bindAdminLogout("btnLogout");
}

initAdminSidebar({ closeOnOutsideClick: true, requireAllCoreElements: true });
bindEvents();
resetProviderInlineForm();
showSection("orders");
initPanelSettings().catch((err) => console.warn("Dashboard panel settings init failed:", err));
loadDashboard();

