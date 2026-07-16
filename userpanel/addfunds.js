import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  getDoc,
  query,
  where,
  doc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  CacheTTL,
  readCache,
  writeCache,
  userSummaryKey,
  paymentsKey
} from "./data-cache.js";
import { fetchUserSummaryFast, getActiveUsername } from "./firestore-fast.js";

const USERNAME = getActiveUsername();
const AUTO_CREATE_API = "/api/auto-payment-create";
const AUTO_STATUS_API = "/api/auto-payment-status";
const AUTO_CANCEL_API = "/api/auto-payment-cancel";
const MANUAL_VERIFY_API = "/api/manual-payment-verify";
const MANUAL_QR_CACHE_KEY = "smm_manual_qr_data_v1";
const MANUAL_QR_CACHE_TIME_KEY = "smm_manual_qr_data_time_v1";
const MANUAL_QR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVE_AUTO_PAYMENT_KEY = "smm_active_auto_payment_v1";
const USER_SUMMARY_CACHE_KEY = userSummaryKey(USERNAME);
const PAYMENTS_CACHE_KEY = paymentsKey(USERNAME);

const $ = (id) => document.getElementById(id);

const userBalanceDisplay = $("userBalance");
const paymentHistoryTable = $("paymentHistoryTable");
const userPaymentsPaginationWrap = $("userPaymentsPaginationWrap");
const userPaymentsPagination = $("userPaymentsPagination");
const addFundsForm = $("addFundsForm");

const tabManual = $("tabManual");
const tabAuto = $("tabAuto");
const manualSection = $("manualSection");
const autoSection = $("autoSection");

const autoAmountInput = $("autoAmountInput");
const autoPayerNameInput = $("autoPayerNameInput");
const btnGenerateAutoQr = $("btnGenerateAutoQr");
const btnResumeAutoPayment = $("btnResumeAutoPayment");
const autoQrPopupOverlay = $("autoQrPopupOverlay");
const btnCloseAutoPopup = $("btnCloseAutoPopup");
const autoQrImage = $("autoQrImage");
const autoPayableAmount = $("autoPayableAmount");
const autoBaseAmount = $("autoBaseAmount");
const autoUpiId = $("autoUpiId");
const autoTimer = $("autoTimer");
const autoStatusText = $("autoStatusText");
const btnPayAutoPayment = $("btnPayAutoPayment");
const btnCancelAutoPayment = $("btnCancelAutoPayment");
const autoStateOverlay = $("autoStateOverlay");
const autoStateCard = $("autoStateCard");
const autoStateIcon = $("autoStateIcon");
const autoStateTitle = $("autoStateTitle");
const autoStateMsg = $("autoStateMsg");
const manualQrImage = $("manualQrImage");
const manualUpiId = $("manualUpiId");
const USER_PAYMENTS_PAGE_SIZE = 25;

let activeAutoPaymentId = "";
let activeAutoExpiresAt = 0;
let activeAutoQrData = "";
let activeAutoQrUrl = "";
let activeAutoPayableAmount = 0;
let activeAutoBaseAmount = 0;
let activeAutoUpi = "";
let countdownInterval = null;
let statusPollInterval = null;
let stateLocked = false;
let allUserPayments = [];
let currentUserPaymentsPage = 1;

if (!USERNAME) {
  window.location.href = "/index.html";
}

function readManualQrCache() {
  try {
    const data = localStorage.getItem(MANUAL_QR_CACHE_KEY);
    const ts = Number(localStorage.getItem(MANUAL_QR_CACHE_TIME_KEY) || 0);
    if (!data || !ts) return null;
    if (Date.now() - ts > MANUAL_QR_CACHE_TTL_MS) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function writeManualQrCache(dataUrl) {
  try {
    if (!dataUrl) return;
    localStorage.setItem(MANUAL_QR_CACHE_KEY, dataUrl);
    localStorage.setItem(MANUAL_QR_CACHE_TIME_KEY, String(Date.now()));
  } catch (_) {}
}

async function cacheManualQrFromNetwork() {
  if (!manualQrImage || !manualQrImage.src) return;
  if (String(manualQrImage.src).startsWith("data:")) return;
  try {
    const res = await fetch(manualQrImage.src, { cache: "no-store" });
    if (!res.ok) return;
    const blob = await res.blob();
    const reader = new FileReader();
    reader.onload = () => {
      const out = String(reader.result || "");
      if (out.startsWith("data:image")) {
        writeManualQrCache(out);
        if (manualQrImage) manualQrImage.src = out;
      }
    };
    reader.readAsDataURL(blob);
  } catch (_) {}
}

function initManualQrCache() {
  if (!manualQrImage) return;
  const cached = readManualQrCache();
  if (cached) {
    manualQrImage.src = cached;
    // Keep cache fresh in background.
    cacheManualQrFromNetwork().catch(() => {});
    return;
  }
  // First run: fetch and save for faster next open.
  cacheManualQrFromNetwork().catch(() => {});
}

function buildManualQrUrl(upiId, upiName) {
  const pa = encodeURIComponent(upiId);
  const pn = encodeURIComponent(upiName || "UPI");
  const data = `upi://pay?pa=${pa}&pn=${pn}`;
  return `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(
    data
  )}`;
}

function applyManualUpi(upiId, upiName) {
  if (!manualQrImage || !upiId) return;
  const nextUrl = buildManualQrUrl(upiId, upiName);
  if (manualQrImage.src !== nextUrl) {
    try {
      localStorage.removeItem(MANUAL_QR_CACHE_KEY);
      localStorage.removeItem(MANUAL_QR_CACHE_TIME_KEY);
    } catch (_) {}
    manualQrImage.src = nextUrl;
  }
  if (manualUpiId) manualUpiId.textContent = upiId;
}

async function loadAutoPaymentSettings() {
  try {
    const snap = await getDoc(doc(db, "meta", "auto_payment_settings"));
    if (!snap.exists()) return;
    const data = snap.data() || {};
    const manualSettings = data.manual || {};
    const upiId = String(
      manualSettings.upiId || data.manualUpiId || data.upiId || ""
    ).trim();
    const upiName = String(
      manualSettings.upiName || data.manualUpiName || data.upiName || ""
    ).trim();
    if (upiId) applyManualUpi(upiId, upiName);
  } catch (e) {
    console.warn("auto payment settings load failed:", e.message);
  }
}

function setMode(mode) {
  const isManual = mode === "manual";
  tabManual.classList.toggle("active", isManual);
  tabAuto.classList.toggle("active", !isManual);
  manualSection.classList.toggle("section-hidden", !isManual);
  autoSection.classList.toggle("section-hidden", isManual);
}

tabManual && tabManual.addEventListener("click", () => setMode("manual"));
tabAuto && tabAuto.addEventListener("click", () => setMode("auto"));

function statusBadge(_cls, text) {
  const label = String(text || "");
  if (autoStatusText) autoStatusText.textContent = `Status: ${label}`;
}

function fmtAmt(n) {
  return `₹${Number(n || 0).toFixed(2)}`;
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

function applyUserSummaryToUI(summary = {}) {
  if (!summary || typeof summary !== "object") return;
  if (userBalanceDisplay) {
    userBalanceDisplay.textContent = `\u20B9${Number(summary.balance || 0).toFixed(2)}`;
  }
}

function displayStatus(status) {
  const s = String(status || "pending").toLowerCase();
  if (s === "expired" || s === "canceled" || s === "cancelled" || s === "failed") {
    return "failed";
  }
  return s;
}

function getManualVerifyErrorMessage(rawMsg) {
  const msg = String(rawMsg || "").trim();
  if (!msg) return "Failed to verify payment.";
  if (msg.toLowerCase() === "no matching payment found") {
    return "UTR verification failed, transaction not found in the last 1 hour.";
  }
  return msg;
}
function persistActiveAutoPayment() {
  try {
    if (!activeAutoPaymentId) {
      localStorage.removeItem(ACTIVE_AUTO_PAYMENT_KEY);
      updateResumeButton();
      return;
    }
    localStorage.setItem(
      ACTIVE_AUTO_PAYMENT_KEY,
      JSON.stringify({
        paymentId: activeAutoPaymentId,
        expiresAt: Number(activeAutoExpiresAt || 0),
        username: USERNAME,
        qrData: activeAutoQrData || "",
        qrUrl: activeAutoQrUrl || "",
        payableAmount: Number(activeAutoPayableAmount || 0),
        baseAmount: Number(activeAutoBaseAmount || 0),
        upiId: activeAutoUpi || "",
      })
    );
    updateResumeButton();
  } catch (_) {}
}
function clearActiveAutoPaymentCache() {
  try {
    localStorage.removeItem(ACTIVE_AUTO_PAYMENT_KEY);
  } catch (_) {}
  updateResumeButton();
}
function restoreActiveAutoPayment() {
  try {
    const raw = localStorage.getItem(ACTIVE_AUTO_PAYMENT_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || data.username !== USERNAME || !data.paymentId) return false;
    activeAutoPaymentId = String(data.paymentId);
    activeAutoExpiresAt = Number(data.expiresAt || 0);
    activeAutoQrData = String(data.qrData || "");
    activeAutoQrUrl = String(data.qrUrl || "");
    activeAutoPayableAmount = Number(data.payableAmount || 0);
    activeAutoBaseAmount = Number(data.baseAmount || 0);
    activeAutoUpi = String(data.upiId || "");
    updateResumeButton();
    return true;
  } catch (_) {
    updateResumeButton();
    return false;
  }
}
function hasActiveAutoPayment() {
  return !!activeAutoPaymentId && Date.now() < Number(activeAutoExpiresAt || 0);
}
function updateResumeButton() {
  if (!btnResumeAutoPayment) return;
  if (hasActiveAutoPayment()) {
    btnResumeAutoPayment.classList.remove("section-hidden");
  } else {
    btnResumeAutoPayment.classList.add("section-hidden");
  }
}
function renderAutoPaymentFromCache() {
  if (!hasActiveAutoPayment()) return;
  openQrPopup();
  if (activeAutoQrUrl) autoQrImage.src = activeAutoQrUrl;
  autoPayableAmount.textContent = fmtAmt(activeAutoPayableAmount || 0);
  autoBaseAmount.textContent = fmtAmt(activeAutoBaseAmount || 0);
  autoUpiId.textContent = activeAutoUpi || "-";
  statusBadge("bg-warning text-dark", "Pending");
}
function stopAutoTracking() {
  if (countdownInterval) clearInterval(countdownInterval);
  if (statusPollInterval) clearInterval(statusPollInterval);
  countdownInterval = null;
  statusPollInterval = null;
}

function openQrPopup() {
  if (autoQrPopupOverlay) autoQrPopupOverlay.style.display = "flex";
}

function closeQrPopup() {
  if (autoQrPopupOverlay) autoQrPopupOverlay.style.display = "none";
}

async function cancelActiveAutoPayment(reason = "user_cancelled") {
  if (!activeAutoPaymentId) return;
  try {
    await fetch(AUTO_CANCEL_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentId: activeAutoPaymentId,
        username: USERNAME,
        reason,
      }),
    });
  } catch (e) {
    console.warn("cancelActiveAutoPayment:", e.message);
  } finally {
    clearActiveAutoPaymentCache();
  }
}

function showAutoState(ok, title, msg) {
  if (stateLocked) return;
  stateLocked = true;
  stopAutoTracking();
  closeQrPopup();
  clearActiveAutoPaymentCache();
  if (!ok) statusBadge("bg-danger", "Failed");
  activeAutoPaymentId = "";
  activeAutoExpiresAt = 0;
  updateResumeButton();
  if (!autoStateOverlay || !autoStateCard) return;
  autoStateCard.classList.remove("state-ok", "state-fail");
  autoStateCard.classList.add(ok ? "state-ok" : "state-fail");
  if (autoStateIcon) autoStateIcon.textContent = ok ? "✓" : "✕";
  if (autoStateTitle) autoStateTitle.textContent = title;
  if (autoStateMsg) autoStateMsg.textContent = msg;
  autoStateOverlay.style.display = "flex";
  setTimeout(() => {
    window.location.href = "addfunds.html";
  }, 2400);
}

function updateTimerUI() {
  const msLeft = Math.max(0, activeAutoExpiresAt - Date.now());
  const sec = Math.floor(msLeft / 1000);
  const mm = String(Math.floor(sec / 60)).padStart(2, "0");
  const ss = String(sec % 60).padStart(2, "0");
  autoTimer.textContent = `${mm}:${ss}`;
}

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

if (addFundsForm) {
  addFundsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const verifyBtn = addFundsForm.querySelector('button[type="submit"]');
    const rawReference = String($("utrInput").value || "");
    const reference = rawReference.trim().replace(/\s+/g, "").toUpperCase();
    const amount = Number($("amountInput").value);
    const payerName = String($("payerNameInput").value || "").trim();

    if (!Number.isFinite(amount) || amount < 10) return alert("Min amount \u20B910");
    if (!reference) return alert("Please enter UTR / Transaction Ref.");
    if (!payerName) return alert("Please enter payer name.");

    const originalBtnText = verifyBtn ? verifyBtn.textContent : "";
    if (verifyBtn) {
      verifyBtn.disabled = true;
      verifyBtn.textContent = "VERIFYING...";
    }

    try {
      const res = await fetch(MANUAL_VERIFY_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: USERNAME,
          amount,
          payerName,
          reference,
        }),
      });

      const text = await res.text();
      let json = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch (_) {
        json = {};
      }

      if (!res.ok || !json.success) {
        throw new Error(json.error || "Failed to verify payment.");
      }

      const successModalEl = document.getElementById("addFundsSuccessModal");
      if (successModalEl) {
        const msgEl = successModalEl.querySelector("p");
        if (msgEl && json.message) msgEl.textContent = String(json.message);
        new bootstrap.Modal(successModalEl).show();
      }

      addFundsForm.reset();
      await Promise.all([loadUserPanel(), loadPaymentsHistory()]);
    } catch (err) {
      console.error(err);
      alert(getManualVerifyErrorMessage(err.message));
    } finally {
      if (verifyBtn) {
        verifyBtn.disabled = false;
        verifyBtn.textContent = originalBtnText || "VERIFY PAYMENT";
      }
    }
  });
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

function renderUserPaymentsPagination(totalPages) {
  if (!userPaymentsPaginationWrap || !userPaymentsPagination) return;

  if (totalPages <= 1) {
    userPaymentsPaginationWrap.classList.add("d-none");
    userPaymentsPagination.innerHTML = "";
    return;
  }

  userPaymentsPaginationWrap.classList.remove("d-none");
  const tokens = getVisiblePageTokens(totalPages, currentUserPaymentsPage);

  let html = "";
  html += buildPageButton('<i class="bi bi-chevron-left"></i>', currentUserPaymentsPage - 1, {
    disabled: currentUserPaymentsPage <= 1
  });

  tokens.forEach((token) => {
    if (token === "...") {
      html += buildPageButton("...", null, { ellipsis: true });
      return;
    }
    html += buildPageButton(String(token), token, { active: token === currentUserPaymentsPage });
  });

  html += buildPageButton('<i class="bi bi-chevron-right"></i>', currentUserPaymentsPage + 1, {
    disabled: currentUserPaymentsPage >= totalPages
  });

  userPaymentsPagination.innerHTML = html;
}

function renderUserPaymentsPage() {
  if (!paymentHistoryTable) return;
  paymentHistoryTable.innerHTML = "";

  const total = allUserPayments.length;
  const totalPages = total ? Math.ceil(total / USER_PAYMENTS_PAGE_SIZE) : 0;

  if (!total) {
    paymentHistoryTable.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-3">No transactions found.</td></tr>`;
    renderUserPaymentsPagination(0);
    return;
  }

  const pageStart = (currentUserPaymentsPage - 1) * USER_PAYMENTS_PAGE_SIZE;
  const pageRows = allUserPayments.slice(pageStart, pageStart + USER_PAYMENTS_PAGE_SIZE);

  pageRows.forEach((p) => {
    const method = escapeHtml(String(p.method || "manual").toUpperCase());
    const ref = escapeHtml(String(p.utr || p.txnId || p.id || "-"));
    const status = escapeHtml(displayStatus(p.status || "pending"));
    const date = escapeHtml(String(p.date || "-"));
    const amount = escapeHtml(fmtAmt(p.amount));
    paymentHistoryTable.innerHTML += `
      <tr>
        <td>${date}</td>
        <td>${method}</td>
        <td>${ref}</td>
        <td>${amount}</td>
        <td>${status}</td>
      </tr>`;
  });

  renderUserPaymentsPagination(totalPages);
}

async function loadPaymentsHistory() {
  if (!paymentHistoryTable) return;
  paymentHistoryTable.innerHTML = "";

  const cachedPayments = readCache(PAYMENTS_CACHE_KEY, {
    maxAgeMs: CacheTTL.payments
  });
  if (Array.isArray(cachedPayments) && cachedPayments.length) {
    allUserPayments = cachedPayments;
    currentUserPaymentsPage = 1;
    renderUserPaymentsPage();
  }

  try {
    const q = query(collection(db, "payments"), where("username", "==", USERNAME));
    const snap = await getDocs(q);
    const list = [];
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
    allUserPayments = list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    writeCache(PAYMENTS_CACHE_KEY, allUserPayments);
    currentUserPaymentsPage = 1;
    renderUserPaymentsPage();
  } catch (err) {
    console.error("Payment History Error:", err);
    if (!allUserPayments.length) {
      paymentHistoryTable.innerHTML = "<tr><td colspan=\"5\" class=\"text-center text-danger py-3\">Failed to load transactions.</td></tr>";
      renderUserPaymentsPagination(0);
    }
  }
}

function renderAutoPaymentBox(data) {
  openQrPopup();
  activeAutoQrData = String(data.qrData || "").trim();
  autoQrImage.src = data.qrUrl;
  autoPayableAmount.textContent = fmtAmt(data.payableAmount);
  autoBaseAmount.textContent = fmtAmt(data.baseAmount);
  autoUpiId.textContent = data.upiId || "-";
  statusBadge("bg-warning text-dark", "Pending");
  if (autoStatusText) autoStatusText.textContent = "Status: pending | waiting for payment confirmation";
}

function openUpiApp() {
  if (!activeAutoQrData) {
    alert("UPI link not ready yet. Please generate QR again.");
    return;
  }
  try {
    // Mobile browsers: opens installed UPI apps (GPay, PhonePe, Paytm, etc.)
    window.location.href = activeAutoQrData;
  } catch (_) {
    alert("Unable to open payment app. Please scan the QR.");
  }
}

async function generateAutoQr() {
  stateLocked = false;
  if (autoStateOverlay) autoStateOverlay.style.display = "none";
  const amount = Number(autoAmountInput.value || 0);
  const payerName = (autoPayerNameInput.value || "").trim();
  if (amount < 10) return alert("Min amount \u20B910");

  btnGenerateAutoQr.disabled = true;
  btnGenerateAutoQr.textContent = "Generating...";
  try {
    const res = await fetch(AUTO_CREATE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: USERNAME, amount, payerName }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to create auto QR");

    activeAutoPaymentId = json.paymentId;
    activeAutoExpiresAt = Number(json.expiresAt || 0);
    persistActiveAutoPayment();
    renderAutoPaymentBox(json);
    startAutoTracking();

    await loadPaymentsHistory();
  } catch (e) {
    console.error(e);
    alert(e.message || "Auto QR failed");
  } finally {
    btnGenerateAutoQr.disabled = false;
    btnGenerateAutoQr.textContent = "GENERATE AUTO QR";
  }
}

async function checkAutoStatus(manualClick = false, options = {}) {
  const suppressFailurePopup = !!options.suppressFailurePopup;
  if (!activeAutoPaymentId) return;
  try {
    const res = await fetch(AUTO_STATUS_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentId: activeAutoPaymentId,
        username: USERNAME,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Status check failed");

    if (json.status === "approved") {
      statusBadge("bg-success", "Approved");
      await loadUserPanel();
      await loadPaymentsHistory();
      showAutoState(true, "Payment Success", "Amount credited. Redirecting to Balance...");
      return;
    }

    if (
      json.status === "expired" ||
      json.status === "canceled" ||
      json.status === "cancelled" ||
      json.status === "failed"
    ) {
      statusBadge("bg-danger", "Failed");
      await loadPaymentsHistory();
      if (suppressFailurePopup) {
        clearActiveAutoPaymentCache();
        activeAutoPaymentId = "";
        activeAutoExpiresAt = 0;
        return;
      }
      const failMsg =
        json.status === "expired"
          ? "QR expired. Redirecting to Back..."
          : "Payment failed/cancelled. Redirecting to Back...";
      showAutoState(false, "Payment Failed", failMsg);
      return;
    }

    if (json.status === "pending") {
      activeAutoExpiresAt = Number(json.expiresAt || activeAutoExpiresAt);
      updateTimerUI();
      statusBadge("bg-warning text-dark", "Pending");
      if (autoStatusText) {
        autoStatusText.textContent = `Status: pending | checks: ${json.checkAttempts || 0}`;
      }
      if (manualClick) {
        alert(`Payment abhi pending hai.\nStatus: pending\nCheck attempts: ${json.checkAttempts || 0}`);
      }
      return;
    }

    statusBadge("bg-secondary", json.status || "Unknown");
  } catch (e) {
    console.error("checkAutoStatus:", e.message);
    if (manualClick) alert(e.message || "Status check failed");
  }
}

function startAutoTracking() {
  stopAutoTracking();
  updateTimerUI();
  persistActiveAutoPayment();

  countdownInterval = setInterval(() => {
    updateTimerUI();
    if (Date.now() >= activeAutoExpiresAt) {
      statusBadge("bg-danger", "Expired");
      stopAutoTracking();
      showAutoState(false, "Payment Failed", "QR expired. Redirecting to Back...");
    }
  }, 1000);

  // Gmail match polling window. Credits as soon as backend finds exact amount.
  statusPollInterval = setInterval(() => {
    checkAutoStatus(false).catch(() => {});
  }, 7000);
}

btnGenerateAutoQr && btnGenerateAutoQr.addEventListener("click", generateAutoQr);
btnResumeAutoPayment &&
  btnResumeAutoPayment.addEventListener("click", () => {
    if (!hasActiveAutoPayment()) {
      updateResumeButton();
      alert("No active auto payment found.");
      return;
    }
    renderAutoPaymentFromCache();
    startAutoTracking();
    checkAutoStatus(false, { suppressFailurePopup: true }).catch(() => {});
  });
btnPayAutoPayment && btnPayAutoPayment.addEventListener("click", openUpiApp);
btnCloseAutoPopup &&
  btnCloseAutoPopup.addEventListener("click", () => {
    closeQrPopup();
    updateResumeButton();
  });
btnCancelAutoPayment &&
  btnCancelAutoPayment.addEventListener("click", async () => {
    await cancelActiveAutoPayment("user_cancelled_popup_btn");
    showAutoState(false, "Payment Failed", "Payment cancelled. Redirecting to Back...");
  });
autoQrPopupOverlay &&
  autoQrPopupOverlay.addEventListener("click", async (e) => {
    if (e.target === autoQrPopupOverlay) {
      await cancelActiveAutoPayment("user_cancelled_overlay_click");
      showAutoState(false, "Payment Failed", "Payment cancelled. Redirecting to Back...");
    }
  });

if (userPaymentsPagination) {
  userPaymentsPagination.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-page]");
    if (!button) return;

    const targetPage = Number(button.getAttribute("data-page") || 0);
    const totalPages = allUserPayments.length ? Math.ceil(allUserPayments.length / USER_PAYMENTS_PAGE_SIZE) : 0;
    if (!targetPage || targetPage < 1 || targetPage > totalPages || targetPage === currentUserPaymentsPage) return;

    currentUserPaymentsPage = targetPage;
    renderUserPaymentsPage();
  });
}

(async function init() {
  initManualQrCache();
  setMode("auto");
  const restoredFromCache = restoreActiveAutoPayment();
  updateResumeButton();

  const settingsPromise = loadAutoPaymentSettings();
  const userPromise = loadUserPanel();
  const paymentsPromise = loadPaymentsHistory();

  if (restoredFromCache && hasActiveAutoPayment()) {
    renderAutoPaymentFromCache();
    checkAutoStatus(false, { suppressFailurePopup: true }).catch(() => {});
  }

  await Promise.allSettled([settingsPromise, userPromise, paymentsPromise]);
})();

window.addEventListener("beforeunload", stopAutoTracking);
