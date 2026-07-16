import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  doc,
  updateDoc,
  deleteDoc,
  query,
  where,
  serverTimestamp,
  runTransaction,
  increment,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  requireAdminAuth,
  initAdminSidebar,
  bindAdminLogout,
  getVisiblePageTokens,
  buildPageButton
} from "./admin-ui-common.js";

requireAdminAuth();
initAdminSidebar();
bindAdminLogout("btnLogout");

const PAYMENT_PAGE_SIZE = 25;

let allPayments = [];
let filteredPayments = [];
let currentPaymentPage = 1;
const table = document.getElementById("payTableBody");
const paymentSearchInput = document.getElementById("paymentSearchInput");
const adminPaymentsPaginationWrap = document.getElementById("adminPaymentsPaginationWrap");
const adminPaymentsPagination = document.getElementById("adminPaymentsPagination");
let activePaymentFilter = "pending_manual";

function getStatusBadge(status) {
  const st = (status || "pending").toLowerCase();
  if (st === "approved") return "bg-success";
  if (st === "rejected" || st === "expired" || st === "canceled" || st === "cancelled" || st === "failed") return "bg-danger";
  return "bg-warning text-dark";
}

async function loadPayments() {
  table.innerHTML = `<tr><td colspan="8" class="text-center py-4">Loading payments...</td></tr>`;

  const snap = await getDocs(collection(db, "payments"));
  allPayments = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  allPayments.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const activeBtn =
    document.querySelector(`#pills-tab .nav-link[data-filter="${activePaymentFilter}"]`) ||
    document.querySelector("#pills-tab .nav-link");

  if (activeBtn) {
    filterPay(activePaymentFilter, activeBtn, true);
  } else {
    filterPay(activePaymentFilter, null, true);
  }
}

function fmtDate(v) {
  if (!v) return "-";
  if (typeof v === "string") return v;
  if (v.toDate) return v.toDate().toLocaleString("en-IN");
  if (v.seconds) return new Date(Number(v.seconds) * 1000).toLocaleString("en-IN");
  return new Date(Number(v) || Date.now()).toLocaleString("en-IN");
}

function normalizeStatus(st) {
  return String(st || "pending").toLowerCase();
}

function normalizeMethod(m) {
  return String(m || "manual").toLowerCase();
}

function isFailedStatus(st) {
  const s = normalizeStatus(st);
  return s === "failed" || s === "rejected" || s === "expired" || s === "canceled" || s === "cancelled";
}

function isAutoProblemPending(p) {
  const st = normalizeStatus(p.status);
  const method = normalizeMethod(p.method);
  if (method !== "auto" || st !== "pending") return false;

  const expiresAt = Number(p.expiresAt || 0);
  if (expiresAt && Date.now() > expiresAt) return true;

  const reason = String(p.lastCheckReason || p.cancelReason || p.autoCancelReason || "").toLowerCase();
  if (reason.includes("cancel") || reason.includes("expired") || reason.includes("qr")) return true;

  if (p.autoCancelled === true || p.qrCancelled === true) return true;
  return false;
}

function getMethodValue(p) {
  const method = normalizeMethod(p.method);
  if (method === "manual") return "manual";
  if (method === "auto") return String(p.id || "auto");
  return method || "-";
}

function getTranUtrValue(p) {
  return String(p.txnId || p.utr || p.id || "-");
}

function matchesSearch(p, term) {
  if (!term) return true;
  const ref = getTranUtrValue(p).toLowerCase();
  const username = String(p.username || "").toLowerCase();
  const date = String(p.date || fmtDate(p.createdAt) || "").toLowerCase();
  const methodValue = getMethodValue(p).toLowerCase();
  const emailSender = String(p.senderEmail || p.gmailFrom || p.gmailSender || "").toLowerCase();
  const status = normalizeStatus(p.status);
  const amountRaw = Number(p.amount || 0);
  const amount2 = amountRaw.toFixed(2);
  const amount1 = amountRaw.toFixed(1);
  const amount0 = String(Math.round(amountRaw));
  return (
    ref.includes(term) ||
    username.includes(term) ||
    date.includes(term) ||
    methodValue.includes(term) ||
    emailSender.includes(term) ||
    status.includes(term) ||
    amount2.includes(term) ||
    amount1.includes(term) ||
    amount0.includes(term)
  );
}

function renderPaymentPagination(totalPages) {
  if (!adminPaymentsPaginationWrap || !adminPaymentsPagination) return;

  if (totalPages <= 1) {
    adminPaymentsPaginationWrap.classList.add("d-none");
    adminPaymentsPagination.innerHTML = "";
    return;
  }

  adminPaymentsPaginationWrap.classList.remove("d-none");
  const tokens = getVisiblePageTokens(totalPages, currentPaymentPage);

  let html = "";
  html += buildPageButton('<i class="bi bi-chevron-left"></i>', currentPaymentPage - 1, {
    disabled: currentPaymentPage <= 1
  });

  tokens.forEach((token) => {
    if (token === "...") {
      html += buildPageButton("...", null, { ellipsis: true });
      return;
    }
    html += buildPageButton(String(token), token, { active: token === currentPaymentPage });
  });

  html += buildPageButton('<i class="bi bi-chevron-right"></i>', currentPaymentPage + 1, {
    disabled: currentPaymentPage >= totalPages
  });

  adminPaymentsPagination.innerHTML = html;
}

function renderCurrentPaymentPage() {
  table.innerHTML = "";
  const total = filteredPayments.length;
  const totalPages = total ? Math.ceil(total / PAYMENT_PAGE_SIZE) : 0;

  if (!total) {
    table.innerHTML = `<tr><td colspan="8" class="text-center text-muted py-4">No requests found.</td></tr>`;
    renderPaymentPagination(0);
    return;
  }

  const pageStart = (currentPaymentPage - 1) * PAYMENT_PAGE_SIZE;
  const pageRows = filteredPayments.slice(pageStart, pageStart + PAYMENT_PAGE_SIZE);

  pageRows.forEach((p) => {
    const method = normalizeMethod(p.method);
    const status = normalizeStatus(p.status);
    const autoProblem = isAutoProblemPending(p);
    const methodValue = getMethodValue(p);
    const methodDisplay =
      activePaymentFilter === "failed"
        ? (method === "auto" ? "auto" : "manual")
        : methodValue;
    const tranUtr = getTranUtrValue(p);
    const displayDate = p.date || fmtDate(p.createdAt);
    let btnAction = `<span class="text-muted small">-</span>`;

    if (status === "pending" && (method === "manual" || autoProblem)) {
      btnAction = `
        <button class="btn btn-sm btn-success me-1" onclick="window.approve('${p.id}')"><i class="bi bi-check-lg"></i></button>
        <button class="btn btn-sm btn-danger" onclick="window.reject('${p.id}')"><i class="bi bi-x-lg"></i></button>
      `;
    } else if (status === "approved") {
      btnAction = `<span class="text-muted small">Completed</span>`;
    } else if (isFailedStatus(status)) {
      btnAction = `<span class="text-danger small">Failed</span>`;
    }

    const deleteBtn = `<button class="btn btn-sm btn-outline-danger ms-1" onclick="window.deletePayment('${p.id}')"><i class="bi bi-trash"></i></button>`;
    btnAction = `${btnAction} ${deleteBtn}`;

    table.innerHTML += `
      <tr>
        <td><small>${displayDate || "-"}</small></td>
        <td class="fw-bold">${p.username || "-"}</td>
        <td class="text-success fw-bold">₹${Number(p.amount || 0).toFixed(2)}</td>
        <td>${p.payerName || "N/A"}</td>
        <td><code class="text-dark bg-light px-2 py-1 rounded border">${tranUtr}</code></td>
        <td><code class="text-dark bg-light px-2 py-1 rounded border">${methodDisplay}</code></td>
        <td><span class="badge ${getStatusBadge(status)}">${status}</span></td>
        <td>${btnAction}</td>
      </tr>
    `;
  });

  renderPaymentPagination(totalPages);
}

window.filterPay = (status, btnEl = null, resetPage = true) => {
  activePaymentFilter = status;
  if (!btnEl) {
    btnEl = document.querySelector(`#pills-tab .nav-link[data-filter="${status}"]`);
  }
  document.querySelectorAll("#pills-tab .nav-link").forEach((b) => b.classList.remove("active"));
  if (btnEl) {
    btnEl.classList.add("active");
    btnEl.setAttribute("data-filter", status);
  }

  const term = String(paymentSearchInput?.value || "").trim().toLowerCase();
  filteredPayments = allPayments.filter((p) => {
    const st = normalizeStatus(p.status);
    const method = normalizeMethod(p.method);

    let sectionMatch = false;
    if (status === "pending_manual") {
      sectionMatch = (st === "pending" && method === "manual") || isAutoProblemPending(p);
    } else if (status === "approved") {
      sectionMatch = st === "approved";
    } else if (status === "failed") {
      sectionMatch = isFailedStatus(st);
    }

    return sectionMatch && matchesSearch(p, term);
  });

  const totalPages = filteredPayments.length ? Math.ceil(filteredPayments.length / PAYMENT_PAGE_SIZE) : 0;
  if (resetPage) currentPaymentPage = 1;
  if (totalPages && currentPaymentPage > totalPages) currentPaymentPage = totalPages;
  if (!totalPages) currentPaymentPage = 1;

  renderCurrentPaymentPage();
};

window.approve = async (docId) => {
  if (!confirm("Approve this payment?")) return;

  try {
    const paymentData = allPayments.find((row) => String(row.id || "") === String(docId)) || null;
    if (!paymentData) {
      throw new Error("Payment not found");
    }

    const approvedAmount = Number(paymentData.amount || 0);
    const paymentUsername = String(paymentData.username || "").trim();
    if (!paymentUsername) {
      throw new Error("Payment username missing");
    }
    if (!Number.isFinite(approvedAmount) || approvedAmount <= 0) {
      throw new Error("Invalid amount");
    }

    const userQuery = query(collection(db, "users"), where("username", "==", paymentUsername));
    const userSnap = await getDocs(userQuery);
    if (userSnap.empty) {
      throw new Error("User not found");
    }

    const paymentRef = doc(db, "payments", docId);
    const userRef = userSnap.docs[0].ref;

    const txResult = await runTransaction(db, async (tx) => {
      const paymentSnap = await tx.get(paymentRef);
      if (!paymentSnap.exists()) {
        throw new Error("Payment not found");
      }

      const paymentData = paymentSnap.data() || {};
      const currentStatus = String(paymentData.status || "pending").toLowerCase();
      if (currentStatus !== "pending") {
        return { credited: false, status: currentStatus };
      }

      const userSnapTx = await tx.get(userRef);
      if (!userSnapTx.exists()) {
        throw new Error("User not found");
      }

      tx.update(userRef, {
        balance: increment(approvedAmount),
        updatedAt: serverTimestamp(),
      });
      tx.update(paymentRef, {
        status: "approved",
        approvedAt: serverTimestamp(),
        approvedBy: localStorage.getItem("quickboostAdminName") || "admin",
      });

      return { credited: true, status: "approved", username: paymentUsername, amount: approvedAmount };
    });

    if (!txResult.credited) {
      alert("No action taken. Payment is already " + txResult.status + ".");
    } else {
      alert("Approved!");
    }
    loadPayments();
  } catch (e) {
    alert("Error: " + e.message);
  }
};

window.reject = async (docId) => {
  if (confirm("Reject this payment?")) {
    await updateDoc(doc(db, "payments", docId), { status: "rejected" });
    loadPayments();
  }
};

window.deletePayment = async (docId) => {
  if (!confirm("Are you sure you want to delete this payment record?")) return;
  try {
    await deleteDoc(doc(db, "payments", docId));
    await loadPayments();
  } catch (e) {
    alert("Delete failed: " + e.message);
  }
};

if (paymentSearchInput) {
  paymentSearchInput.addEventListener("input", () => {
    const activeBtn = document.querySelector(`#pills-tab .nav-link.active`);
    filterPay(activePaymentFilter, activeBtn, true);
  });
}

if (adminPaymentsPagination) {
  adminPaymentsPagination.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-page]");
    if (!button) return;

    const targetPage = Number(button.getAttribute("data-page") || 0);
    const totalPages = filteredPayments.length ? Math.ceil(filteredPayments.length / PAYMENT_PAGE_SIZE) : 0;
    if (!targetPage || targetPage < 1 || targetPage > totalPages || targetPage === currentPaymentPage) return;

    currentPaymentPage = targetPage;
    renderCurrentPaymentPage();
  });
}

loadPayments();
