import { db } from "./firebase.js";
import { collection, getDocs, doc, deleteDoc, query, orderBy, serverTimestamp, where, runTransaction, increment } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { appendMaintenanceKey } from "../scripts/status-sync.js";
import {
    requireAdminAuth,
    initAdminSidebar,
    bindAdminLogout,
    getVisiblePageTokens,
    buildPageButton
} from "./admin-ui-common.js";

requireAdminAuth();
initAdminSidebar();

const ordersTableBody = document.getElementById("ordersTableBody");
const searchInput = document.getElementById("searchInput");
const statusFilter = document.getElementById("statusFilter");
const vendorFilter = document.getElementById("vendorFilter");
const totalOrdersCount = document.getElementById("totalOrdersCount");
const adminOrdersPaginationWrap = document.getElementById("adminOrdersPaginationWrap");
const adminOrdersPagination = document.getElementById("adminOrdersPagination");

const ORDER_COLLECTIONS = [
    "orders_active",
    "orders_completed",
    "orders_cancel",
    "orders_partial",
    "orders"
];
const ORDER_PAGE_SIZE = 25;

let allOrders = [];
let filteredOrders = [];
let currentOrderPage = 1;
let vendorMap = {};

function formatInr(value) {
    return `\u20B9${Number(value || 0).toFixed(2)}`;
}

function roundMoney(value) {
    return Number(Number(value || 0).toFixed(4));
}

function parseFiniteNumber(value) {
    const parsed = Number(String(value ?? "").trim());
    return Number.isFinite(parsed) ? parsed : null;
}

function getStoredRefundTotal(order = {}) {
    return roundMoney(Math.max(
        Number(order.refundAppliedTotal || 0),
        Number(order.refund || 0),
        Number(order.refundedAmount || 0)
    ));
}

function getOrderSettlementBase(order = {}, fallbackQty = null, fallbackAmount = null) {
    const originalQty = parseFiniteNumber(order.originalQty);
    const currentQty = parseFiniteNumber(order.qty);
    const currentRemains = parseFiniteNumber(order.remains);
    const originalAmount = parseFiniteNumber(order.originalAmount);
    const currentAmount = parseFiniteNumber(order.amount);
    const userPrice = parseFiniteNumber(order.userPrice);
    const refundTotal = getStoredRefundTotal(order);
    const status = String(order.status || "").toLowerCase().trim();
    const isSettledState =
        order.refundProcessed === true ||
        refundTotal > 0 ||
        status === "partial" ||
        status === "canceled" ||
        status === "completed";

    let qty = 0;
    if (originalQty !== null && originalQty > 0) {
        qty = originalQty;
    } else if (isSettledState && currentQty !== null) {
        if (currentRemains !== null) {
            qty = currentQty + currentRemains;
        } else {
            const derivedUnitPrice =
                currentAmount !== null && currentQty > 0
                    ? currentAmount / currentQty
                    : userPrice !== null && userPrice > 0
                        ? userPrice / 1000
                        : 0;
            qty = derivedUnitPrice > 0 && refundTotal > 0
                ? currentQty + (refundTotal / derivedUnitPrice)
                : currentQty;
        }
    } else if (currentQty !== null && currentQty > 0) {
        qty = currentQty;
    } else if (fallbackQty !== null && fallbackQty > 0) {
        qty = fallbackQty;
    }

    let unitPrice = 0;
    if (originalAmount !== null && originalAmount >= 0 && originalQty && originalQty > 0) {
        unitPrice = originalAmount / originalQty;
    } else if (currentAmount !== null && currentQty !== null && currentQty > 0) {
        unitPrice = currentAmount / currentQty;
    } else if (userPrice !== null && userPrice > 0) {
        unitPrice = userPrice / 1000;
    } else if (fallbackAmount !== null && fallbackQty !== null && fallbackQty > 0) {
        unitPrice = fallbackAmount / fallbackQty;
    }

    let amount = 0;
    if (originalAmount !== null && originalAmount >= 0) {
        amount = originalAmount;
    } else if (isSettledState) {
        if (currentAmount !== null && currentAmount >= 0 && refundTotal > 0) {
            amount = roundMoney(currentAmount + refundTotal);
        } else if (unitPrice > 0 && qty > 0) {
            amount = roundMoney(unitPrice * qty);
        } else if (refundTotal > 0) {
            amount = refundTotal;
        } else if (currentAmount !== null && currentAmount >= 0) {
            amount = currentAmount;
        } else if (fallbackAmount !== null && fallbackAmount >= 0) {
            amount = fallbackAmount;
        }
    } else if (currentAmount !== null && currentAmount >= 0) {
        amount = currentAmount;
    } else if (fallbackAmount !== null && fallbackAmount >= 0) {
        amount = fallbackAmount;
    }

    if (!unitPrice && qty > 0 && amount > 0) {
        unitPrice = amount / qty;
    }

    return {
        qty,
        amount,
        unitPrice
    };
}

async function getUserRefByUsername(username) {
    const cleanUsername = String(username || "").trim();
    if (!cleanUsername) return null;

    const snap = await getDocs(query(collection(db, "users"), where("username", "==", cleanUsername)));
    if (snap.empty) return null;
    return snap.docs[0].ref;
}

function getOrderVendorCost(order = {}) {
    const directCost = Number(order.vendorCost);
    if (Number.isFinite(directCost) && directCost > 0) {
        return directCost;
    }

    const qty = Number(order.qty || 0);
    const vendorRate = Number(order.vendorPrice || 0);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(vendorRate) || vendorRate <= 0) {
        return 0;
    }

    return Number(((vendorRate / 1000) * qty).toFixed(4));
}

function buildStatusApiUrl() {
    return appendMaintenanceKey("/api/status-check");
}

async function loadVendors() {
    if (!vendorFilter) return;
    try {
        const snap = await getDocs(collection(db, "vendors"));
        vendorMap = {};
        const list = [];
        snap.forEach((d) => {
            const v = d.data();
            vendorMap[d.id] = v?.name || "Vendor";
            list.push({ id: d.id, name: vendorMap[d.id] });
        });
        list.sort((a, b) => a.name.localeCompare(b.name));

        vendorFilter.innerHTML = `
            <option value="all">All Vendors</option>
            <option value="manual">Manual</option>
        `;
        list.forEach((v) => {
            const opt = document.createElement("option");
            opt.value = v.id;
            opt.textContent = v.name;
            vendorFilter.appendChild(opt);
        });
    } catch (e) {
        console.error("Failed to load vendors:", e);
    }
}

async function loadOrders() {
    try {
        const snaps = await Promise.all(
            ORDER_COLLECTIONS.map((name) => {
                const q = query(collection(db, name), orderBy("createdAt", "desc"));
                return getDocs(q);
            })
        );

        const deduped = new Map();
        snaps.forEach((snap, idx) => {
            const sourceCollection = ORDER_COLLECTIONS[idx];
            snap.docs.forEach((d) => {
                const docId = d.id;
                if (deduped.has(docId)) return;
                deduped.set(docId, {
                    docId,
                    sourceCollection,
                    ...d.data()
                });
            });
        });

        allOrders = Array.from(deduped.values());
        allOrders.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
        filterOrders(true);
    } catch (err) {
        console.error(err);
        ordersTableBody.innerHTML = `<tr><td colspan="11" class="text-danger text-center">Error loading orders</td></tr>`;
        renderOrderPagination(0);
    }
}

function renderOrderPagination(totalPages) {
    if (!adminOrdersPaginationWrap || !adminOrdersPagination) return;

    if (totalPages <= 1) {
        adminOrdersPaginationWrap.classList.add("d-none");
        adminOrdersPagination.innerHTML = "";
        return;
    }

    adminOrdersPaginationWrap.classList.remove("d-none");
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

    adminOrdersPagination.innerHTML = html;
}

function renderCurrentOrderPage() {
    ordersTableBody.innerHTML = "";
    const total = filteredOrders.length;
    const totalPages = total ? Math.ceil(total / ORDER_PAGE_SIZE) : 0;

    if (totalOrdersCount) totalOrdersCount.textContent = `${total} Orders`;

    if (!total) {
        ordersTableBody.innerHTML = `<tr><td colspan="11" class="text-center text-muted py-4">No orders found</td></tr>`;
        renderOrderPagination(0);
        return;
    }

    const pageStart = (currentOrderPage - 1) * ORDER_PAGE_SIZE;
    const pageRows = filteredOrders.slice(pageStart, pageStart + ORDER_PAGE_SIZE);

    const html = pageRows.map((o) => {
        const statusColors = {
            pending: "bg-warning text-dark",
            processing: "bg-info text-dark",
            "in progress": "bg-primary",
            completed: "bg-success",
            partial: "bg-secondary",
            canceled: "bg-danger"
        };
        const badgeClass = statusColors[o.status] || "bg-light text-dark";
        const vendorCost = getOrderVendorCost(o);

        return `
            <tr>
                <td><small class="text-muted">#${o.orderId || "N/A"}</small></td>
                <td><div class="fw-bold">${o.payer || "Guest"}</div></td>
                <td><div class="text-truncate" style="max-width: 160px;"><a href="${o.link}" target="_blank">${o.link}</a></div></td>
                <td><div class="text-truncate" style="max-width: 220px;" title="${o.serviceTitle || ""}">${o.serviceTitle || "N/A"}</div></td>
                <td>${o.qty}</td>
                <td class="fw-bold text-success">${formatInr(o.amount || 0)}</td>
                <td class="fw-bold text-danger">${formatInr(vendorCost)}</td>
                <td><small>${o.startCount || 0} / ${o.remains || 0}</small></td>
                <td><small>${o.date || "N/A"}</small></td>
                <td><span class="badge ${badgeClass}">${o.status}</span></td>
                <td>
                    <button class="btn btn-sm btn-light border" onclick="window.editOrder('${o.docId}', '${o.sourceCollection || "orders_active"}')"><i class="bi bi-pencil"></i></button>
                    <button class="btn btn-sm btn-light border text-danger" onclick="window.deleteOrder('${o.docId}', '${o.sourceCollection || "orders_active"}')"><i class="bi bi-trash"></i></button>
                </td>
            </tr>
        `;
    }).join("");

    ordersTableBody.innerHTML = html;
    renderOrderPagination(totalPages);
}

// Filters
function filterOrders(resetPage = true) {
    const term = String(searchInput?.value || "").toLowerCase();
    const status = statusFilter?.value || "all";
    const vendor = vendorFilter ? vendorFilter.value : "all";

    filteredOrders = allOrders.filter((o) => {
        const matchSearch =
            (o.orderId?.toString().includes(term)) ||
            (o.payer?.toLowerCase().includes(term)) ||
            (o.link?.toLowerCase().includes(term)) ||
            (o.serviceTitle?.toLowerCase().includes(term));
        const matchStatus = status === "all" || o.status === status;
        let matchVendor = true;
        if (vendor === "manual") {
            const isManual = o.manual === true || String(o.serviceId || "").startsWith("manual_") || !o.vendorId;
            matchVendor = isManual;
        } else if (vendor !== "all") {
            matchVendor = String(o.vendorId || "") === String(vendor);
        }
        return matchSearch && matchStatus && matchVendor;
    });

    const totalPages = filteredOrders.length ? Math.ceil(filteredOrders.length / ORDER_PAGE_SIZE) : 0;
    if (resetPage) currentOrderPage = 1;
    if (totalPages && currentOrderPage > totalPages) currentOrderPage = totalPages;
    if (!totalPages) currentOrderPage = 1;

    renderCurrentOrderPage();
}

searchInput.addEventListener("input", () => filterOrders(true));
statusFilter.addEventListener("change", () => filterOrders(true));
if (vendorFilter) vendorFilter.addEventListener("change", () => filterOrders(true));

if (adminOrdersPagination) {
    adminOrdersPagination.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-page]");
        if (!button) return;

        const targetPage = Number(button.getAttribute("data-page") || 0);
        const totalPages = filteredOrders.length ? Math.ceil(filteredOrders.length / ORDER_PAGE_SIZE) : 0;
        if (!targetPage || targetPage < 1 || targetPage > totalPages || targetPage === currentOrderPage) return;

        currentOrderPage = targetPage;
        renderCurrentOrderPage();
    });
}

// Edit Logic
window.editOrder = (docId, sourceCollection = "orders_active") => {
    const o = allOrders.find((x) => x.docId === docId && x.sourceCollection === sourceCollection);
    if (!o) return;
    document.getElementById("editDocId").value = docId;
    document.getElementById("editOrderForm").dataset.sourceCollection = sourceCollection;
    document.getElementById("editOrderId").value = o.orderId || "";
    document.getElementById("editStatus").value = o.status || "pending";
    document.getElementById("editQty").value = o.qty || 0;
    document.getElementById("editStartCount").value = o.startCount || 0;
    document.getElementById("editRemains").value = o.remains || 0;
    new bootstrap.Modal(document.getElementById("editOrderModal")).show();
};

document.getElementById("editOrderForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const docId = document.getElementById("editDocId").value;
    const sourceCollection = document.getElementById("editOrderForm").dataset.sourceCollection || "orders_active";
    const currentOrder = allOrders.find((x) => x.docId === docId && x.sourceCollection === sourceCollection);
    if (!currentOrder) {
        alert("Order not found. Please reload and try again.");
        return;
    }

    const editedOrderId = String(document.getElementById("editOrderId").value || currentOrder.orderId || "").trim();
    const newStatus = String(document.getElementById("editStatus").value || currentOrder.status || "pending").trim().toLowerCase();
    const qtyInputRaw = String(document.getElementById("editQty").value || "").trim();
    const remainsInputRaw = String(document.getElementById("editRemains").value || "").trim();
    const startCountRaw = String(document.getElementById("editStartCount").value || "").trim();

    const inputQty = qtyInputRaw === "" ? null : Number(qtyInputRaw);
    const inputRemains = remainsInputRaw === "" ? null : Number(remainsInputRaw);
    const inputStartCount = startCountRaw === "" ? null : Number(startCountRaw);

    const base = getOrderSettlementBase(currentOrder, inputQty, Number(currentOrder.amount || 0));
    const baseQty = base.qty;
    const baseAmount = base.amount;
    const unitPrice = base.unitPrice;

    let finalQty = Number.isFinite(inputQty) && inputQty !== null ? inputQty : (parseFiniteNumber(currentOrder.qty) || 0);
    let finalRemains = Number.isFinite(inputRemains) && inputRemains !== null ? inputRemains : (parseFiniteNumber(currentOrder.remains) || 0);
    let finalAmount = roundMoney(finalQty * unitPrice);
    let desiredRefundTotal = 0;

    if (newStatus === "completed") {
        finalQty = baseQty;
        finalRemains = 0;
        finalAmount = roundMoney(baseAmount);
    } else if (newStatus === "partial") {
        if (Number.isFinite(finalQty) && finalQty >= 0) {
            finalQty = Math.min(finalQty, baseQty || finalQty);
            finalRemains = Math.max(baseQty - finalQty, 0);
        } else if (Number.isFinite(finalRemains) && finalRemains >= 0) {
            finalRemains = Math.min(finalRemains, baseQty || finalRemains);
            finalQty = Math.max(baseQty - finalRemains, 0);
        } else {
            finalQty = parseFiniteNumber(currentOrder.qty) || 0;
            finalRemains = parseFiniteNumber(currentOrder.remains) || 0;
        }
        finalAmount = roundMoney(finalQty * unitPrice);
        desiredRefundTotal = roundMoney(Math.max(baseAmount - finalAmount, 0));
    } else if (newStatus === "canceled") {
        finalQty = 0;
        finalRemains = baseQty;
        finalAmount = 0;
        desiredRefundTotal = roundMoney(baseAmount);
    } else {
        if (!Number.isFinite(finalQty) || finalQty < 0) {
            finalQty = Number(currentOrder.qty || 0);
        }
        finalRemains = Number.isFinite(inputRemains) && inputRemains !== null
            ? Math.max(inputRemains, 0)
            : Number(currentOrder.remains || 0);
        finalAmount = roundMoney(finalQty * unitPrice);
        desiredRefundTotal = 0;
    }

    if (newStatus !== "canceled" && newStatus !== "partial" && newStatus !== "completed") {
        if (!Number.isFinite(finalQty) || finalQty <= 0) {
            alert("Quantity must be greater than zero.");
            return;
        }
    }

    const currentRefundTotal = getStoredRefundTotal(currentOrder);
    const balanceDelta = roundMoney(desiredRefundTotal - currentRefundTotal);

    if (balanceDelta < 0) {
        const deductText = `This change will deduct \u20B9${Math.abs(balanceDelta).toFixed(2)} from the user's balance. Continue?`;
        if (!confirm(deductText)) return;
    }

    const updatePayload = {
        orderId: editedOrderId,
        status: newStatus,
        qty: finalQty,
        amount: finalAmount,
        startCount: Number.isFinite(inputStartCount) && inputStartCount !== null ? inputStartCount : currentOrder.startCount || 0,
        remains: finalRemains,
        originalQty: baseQty,
        originalAmount: baseAmount,
        refundAppliedTotal: desiredRefundTotal,
        refund: desiredRefundTotal,
        refundedAmount: desiredRefundTotal,
        refundProcessed: newStatus === "partial" || newStatus === "canceled",
        updatedAt: serverTimestamp()
    };

    const userRef = await getUserRefByUsername(currentOrder.payer);
    if (!userRef && balanceDelta !== 0) {
        alert("User account not found for balance adjustment.");
        return;
    }

    const sourceRef = doc(db, sourceCollection, docId);
    const legacyRef = doc(db, "orders", docId);

    await runTransaction(db, async (tx) => {
        if (balanceDelta !== 0) {
            tx.update(userRef, {
                balance: increment(balanceDelta),
                updatedAt: serverTimestamp()
            });
        }

        tx.set(sourceRef, updatePayload, { merge: true });
        if (sourceCollection !== "orders") {
            tx.set(legacyRef, updatePayload, { merge: true });
        }
    });

    // Re-run backend status pipeline so completion metrics/avg time stay in sync.
    try {
        await fetch(buildStatusApiUrl(), { method: "POST" });
    } catch (err) {
        console.warn("status-check trigger failed after manual edit:", err);
    }

    bootstrap.Modal.getInstance(document.getElementById("editOrderModal")).hide();
    loadOrders();
});

window.deleteOrder = async (docId, sourceCollection = "orders_active") => {
    if (confirm("Delete this order? Cannot be undone.")) {
        await Promise.all([
            deleteDoc(doc(db, sourceCollection, docId)),
            deleteDoc(doc(db, "orders", docId)).catch(() => {})
        ]);
        loadOrders();
    }
};

bindAdminLogout("btnLogout");

loadVendors();
loadOrders();
