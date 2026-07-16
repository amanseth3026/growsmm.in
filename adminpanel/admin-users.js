import { db } from "./firebase.js";
import { collection, getDocs, doc, deleteDoc, updateDoc, addDoc, serverTimestamp, query, where, runTransaction } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
    requireAdminAuth,
    initAdminSidebar,
    bindAdminLogout
} from "./admin-ui-common.js";

requireAdminAuth();
initAdminSidebar();
bindAdminLogout("btnLogout");

const usersTableBody = document.getElementById("usersTableBody");
let allUsers = [];
const userSearchInput = document.getElementById("userSearch");
const userFilterSelect = document.getElementById("userFilter");
const adjustTypeInput = document.getElementById("adjustType");
const adjustAmountInput = document.getElementById("adjustAmount");
const adjustReasonInput = document.getElementById("adjustReason");
const adjustUtrInput = document.getElementById("adjustUtr");
const adjustPayerNameInput = document.getElementById("adjustPayerName");
const adjustPaymentFields = document.getElementById("adjustPaymentFields");

function updateAdjustPaymentFields() {
    const isAdd = (adjustTypeInput?.value || "add") === "add";
    if (adjustPaymentFields) {
        adjustPaymentFields.classList.toggle("d-none", !isAdd);
    }
    if (adjustUtrInput) {
        adjustUtrInput.required = isAdd;
    }
    if (adjustPayerNameInput) {
        adjustPayerNameInput.required = isAdd;
    }
}

if (adjustTypeInput) {
    adjustTypeInput.addEventListener("change", updateAdjustPaymentFields);
}
updateAdjustPaymentFields();

function normalizeUsername(value) {
    return String(value || "").trim().toLowerCase();
}

function normalizeStatus(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function applyUserFilters() {
    const term = String(userSearchInput?.value || "").trim().toLowerCase();
    const filter = String(userFilterSelect?.value || "all").trim();

    const filtered = allUsers.filter((u) => {
        const username = String(u.username || "").toLowerCase();
        if (term && !username.includes(term)) return false;

        const balance = Number(u.balance || 0);
        if (filter === "add_funds") return Boolean(u.hasPayment);
        if (filter === "no_add_funds") return !u.hasPayment;
        if (filter === "with_orders") return Boolean(u.hasOrder);
        if (filter === "without_orders") return !u.hasOrder;
        if (filter === "balance_positive") return balance > 0;
        if (filter === "balance_empty") return balance <= 0;

        return true;
    });

    renderUsers(filtered);
}

window.loginAsUser = (username) => {
    const cleanUsername = normalizeUsername(username);
    if (!cleanUsername) return;

    localStorage.setItem("smmGrowthUser", cleanUsername);
    sessionStorage.removeItem("smmGrowthUser");

    window.open("/userpanel/neworder.html", "_blank", "noopener,noreferrer");
};

async function loadUsers() {
    usersTableBody.innerHTML = `<tr><td colspan="6" class="text-center py-4">Loading users...</td></tr>`;

    try {
        const [
            ordersActiveSnap,
            ordersCompletedSnap,
            ordersCancelSnap,
            ordersPartialSnap,
            ordersLegacySnap,
            paymentsSnap,
            usersSnap
        ] = await Promise.all([
            getDocs(collection(db, "orders_active")),
            getDocs(collection(db, "orders_completed")),
            getDocs(collection(db, "orders_cancel")),
            getDocs(collection(db, "orders_partial")),
            getDocs(collection(db, "orders")),
            getDocs(collection(db, "payments")),
            getDocs(collection(db, "users"))
        ]);

        const spendingMap = {};
        const orderUsers = new Set();
        const seenOrderIds = new Set();
        const orderSnaps = [ordersActiveSnap, ordersCompletedSnap, ordersCancelSnap, ordersPartialSnap, ordersLegacySnap];

        orderSnaps.forEach((snap) => {
            snap.forEach((d) => {
                if (seenOrderIds.has(d.id)) return;
                seenOrderIds.add(d.id);
                const o = d.data() || {};
                const username = normalizeUsername(o.payer || o.username);
                if (username) {
                    orderUsers.add(username);
                    spendingMap[username] = (spendingMap[username] || 0) + Number(o.amount || 0);
                }
            });
        });

        const paidUsers = new Set();
        paymentsSnap.forEach((d) => {
            const p = d.data() || {};
            const status = normalizeStatus(p.status);
            if (!(status === "approved" || status === "completed")) return;
            if (Number(p.amount || 0) <= 0) return;

            const username = normalizeUsername(p.username || p.payer);
            if (username) paidUsers.add(username);
        });

        allUsers = [];

        usersSnap.forEach(d => {
            const u = d.data();
            const username = normalizeUsername(u.username || d.id);
            allUsers.push({
                id: d.id,
                ...u,
                spent: spendingMap[username] || 0,
                hasOrder: orderUsers.has(username),
                hasPayment: paidUsers.has(username)
            });
        });

        applyUserFilters();

    } catch(e) { console.error(e); }
}

function renderUsers(users) {
    usersTableBody.innerHTML = "";
    if (!users.length) {
        usersTableBody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-muted">No users found.</td></tr>`;
        return;
    }

    users.forEach(u => {
        const username = String(u.username || "").trim();
        let waDisplay = `<span class="text-muted small">-</span>`;
        if(u.whatsapp) {
            const num = u.whatsapp.replace(/\D/g, '');
            if(num.length >= 10) {
                waDisplay = `<a href="https://wa.me/${num}" target="_blank" class="text-success text-decoration-none">
                    <i class="bi bi-whatsapp"></i> ${u.whatsapp}
                </a>`;
            }
        }

        // --- API KEY DISPLAY LOGIC ---
        let apiDisplay = "";
        if (u.apiKey) {
            apiDisplay = `
                <div class="input-group input-group-sm" style="width: 180px;">
                    <input type="text" class="form-control" value="${u.apiKey}" readonly style="font-size: 0.75rem; background: #fff;">
                    <button class="btn btn-outline-secondary" onclick="navigator.clipboard.writeText('${u.apiKey}')" title="Copy"><i class="bi bi-copy"></i></button>
                    <button class="btn btn-outline-danger" onclick="window.generateApiKey('${u.id}')" title="Regenerate"><i class="bi bi-arrow-clockwise"></i></button>
                </div>
            `;
        } else {
            apiDisplay = `<button class="btn btn-sm btn-primary-custom" onclick="window.generateApiKey('${u.id}')">Generate Key</button>`;
        }

        const loginButton = username
            ? `<button class="btn btn-sm btn-outline-success" onclick="window.loginAsUser('${username}')" title="Login as user" aria-label="Login as user"><i class="bi bi-box-arrow-in-right"></i></button>`
            : `<button class="btn btn-sm btn-outline-success" disabled title="Username missing" aria-label="Username missing"><i class="bi bi-box-arrow-in-right"></i></button>`;

        const row = `
            <tr>
                <td class="fw-bold">${u.username}</td>
                <td>${waDisplay}</td>
                <td class="text-primary fw-bold">₹${Number(u.balance || 0).toFixed(2)}</td>
                <td>${apiDisplay}</td>
                <td>₹${u.spent.toFixed(2)}</td>
                <td class="d-flex gap-2">
                    ${loginButton}
                    <button class="btn btn-sm btn-outline-success"
                        onclick="window.openAdjustBalance('${u.id}')"
                        title="Adjust Balance">
                        <i class="bi bi-currency-exchange"></i>
                    </button>
                    <button class="btn btn-sm btn-outline-primary"
                        onclick="window.openEditUserPricing('${u.id}')">
                        <i class="bi bi-pencil"></i>
                    </button>
                    <button class="btn btn-sm btn-outline-danger"
                        onclick="window.deleteUser('${u.id}')">
                        <i class="bi bi-trash"></i>
                    </button>
                </td>

            </tr>
        `;
        usersTableBody.innerHTML += row;
    });
}

// --- SEARCH ---
userSearchInput?.addEventListener("input", applyUserFilters);
userFilterSelect?.addEventListener("change", applyUserFilters);

// --- GENERATE API KEY FUNCTION ---
window.generateApiKey = async (userId) => {
    if(!confirm("Generate new API Key for this user? Old key will stop working.")) return;

    // Create a simple random key
    const randomStr = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    const newKey = `sk_${randomStr}`; // Prefix sk_ for standard look

    try {
        const btn = event.target;
        if(btn) btn.innerHTML = "...";

        await updateDoc(doc(db, "users", userId), {
            apiKey: newKey
        });

        // Update local data immediately to reflect change without full reload
        const userIndex = allUsers.findIndex(u => u.id === userId);
        if(userIndex > -1) {
            allUsers[userIndex].apiKey = newKey;
            applyUserFilters();
        }
        // Or full reload: loadUsers();
    } catch(e) {
        alert("Error generating key: " + e.message);
    }
};

window.deleteUser = async (id) => {
    if(confirm("Delete User? This cannot be undone.")) {
        await deleteDoc(doc(db, "users", id));
        loadUsers();
    }
};

// --- OPEN EDIT PRICING MODAL ---
window.openEditUserPricing = (userId) => {
  const user = allUsers.find(u => u.id === userId);
  if (!user) return;

  document.getElementById("editUserId").value = userId;
  document.getElementById("editExtraProfit").value = user.extraProfit ?? "";
  document.getElementById("editDiscount").value = user.discount ?? "";

  new bootstrap.Modal(
    document.getElementById("editUserPricingModal")
  ).show();
};

// --- SAVE USER PRICING ---
document.getElementById("editUserPricingForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const userId = document.getElementById("editUserId").value;
  const extraProfit = Number(document.getElementById("editExtraProfit").value || 0);
  const discount = Number(document.getElementById("editDiscount").value || 0);

  if (extraProfit < 0 || discount < 0) {
    return alert("Negative values not allowed");
  }

  try {
    await updateDoc(doc(db, "users", userId), {
      extraProfit,
      discount
    });

    // update local cache
    const idx = allUsers.findIndex(u => u.id === userId);
    if (idx > -1) {
      allUsers[idx].extraProfit = extraProfit;
      allUsers[idx].discount = discount;
      applyUserFilters();
    }

    bootstrap.Modal
      .getInstance(document.getElementById("editUserPricingModal"))
      .hide();

  } catch (err) {
    alert("Failed to update pricing: " + err.message);
  }
});


loadUsers();

// --- OPEN ADJUST BALANCE MODAL ---
window.openAdjustBalance = (userId) => {
    const user = allUsers.find(u => u.id === userId);
    if (!user) return;

    document.getElementById('adjustUserId').value = userId;
    if (adjustTypeInput) adjustTypeInput.value = 'add';
    if (adjustAmountInput) adjustAmountInput.value = '';
    if (adjustReasonInput) adjustReasonInput.value = '';
    if (adjustUtrInput) adjustUtrInput.value = '';
    if (adjustPayerNameInput) {
        adjustPayerNameInput.value = user.fullName || user.name || user.username || '';
    }
    updateAdjustPaymentFields();

    new bootstrap.Modal(document.getElementById('adjustBalanceModal')).show();
};

// --- HANDLE ADJUST BALANCE FORM ---
document.getElementById('adjustBalanceForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const userId = document.getElementById('adjustUserId').value;
    const type = adjustTypeInput?.value || 'add';
    const amount = Number(adjustAmountInput?.value || 0);
    const reason = (adjustReasonInput?.value || '').trim();
    const utr = (adjustUtrInput?.value || '').trim().replace(/\s+/g, '').toUpperCase();
    const payerName = (adjustPayerNameInput?.value || '').trim();
    const adminName = localStorage.getItem('quickboostAdminName') || 'admin';
    const paymentDocId = utr.replace(/\//g, '-');

    if (!userId || amount <= 0) return alert('Enter a valid amount');
    if (type === 'add' && !utr) return alert('UTR / Transaction Ref is required for Add Balance.');
    if (type === 'add' && !paymentDocId) return alert('Please enter a valid UTR / Transaction Ref.');
    if (type === 'add' && !payerName) return alert('Payer Name is required for Add Balance.');

    const idx = allUsers.findIndex(u => u.id === userId);
    if (idx === -1) return alert('User not found');

    const user = allUsers[idx];
    const current = Number(user.balance || 0);
    const delta = type === 'add' ? amount : -amount;
    const newBalance = Number((current + delta).toFixed(2));

    if (type === 'subtract' && amount > current) {
        if (!confirm('Subtracting more than user balance will make it negative. Proceed?')) return;
    }

    try {
        let finalBalance = newBalance;

        if (type === 'add') {
            const existingUtrSnap = await getDocs(query(collection(db, 'payments'), where('utr', '==', utr)));
            if (!existingUtrSnap.empty) {
                return alert('This UTR already exists in payment history.');
            }

            const userRef = doc(db, 'users', userId);
            const paymentRef = doc(db, 'payments', paymentDocId);
            const displayDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

            await runTransaction(db, async (tx) => {
                const paymentSnap = await tx.get(paymentRef);
                if (paymentSnap.exists()) {
                    throw new Error('This UTR already exists in payment history.');
                }

                const userSnap = await tx.get(userRef);
                if (!userSnap.exists()) {
                    throw new Error('User not found');
                }

                const liveUser = userSnap.data() || {};
                const liveCurrent = Number(liveUser.balance || 0);
                finalBalance = Number((liveCurrent + amount).toFixed(2));

                tx.update(userRef, {
                    balance: finalBalance,
                    updatedAt: serverTimestamp()
                });

                tx.set(paymentRef, {
                    username: liveUser.username || user.username || '',
                    userId,
                    utr,
                    txnId: utr,
                    amount,
                    payerName,
                    method: 'manual',
                    status: 'approved',
                    createdAt: Date.now(),
                    date: displayDate,
                    approvedAt: serverTimestamp(),
                    approvedBy: adminName,
                    source: 'admin_balance_add',
                    reason
                });
            });
        } else {
            await updateDoc(doc(db, 'users', userId), {
                balance: newBalance,
                updatedAt: serverTimestamp()
            });
        }

        // log adjustment for audit
        try {
            await addDoc(collection(db, 'balanceAdjustments'), {
                userId,
                username: user.username || '',
                amount: delta,
                reason,
                action: type,
                utr: type === 'add' ? utr : '',
                payerName: type === 'add' ? payerName : '',
                admin: adminName,
                createdAt: serverTimestamp()
            });
        } catch (logErr) {
            console.warn('Failed to log balance adjustment', logErr);
        }

        // update local cache & UI
        allUsers[idx].balance = finalBalance;
        if (type === 'add') allUsers[idx].hasPayment = true;
        applyUserFilters();

        bootstrap.Modal.getInstance(document.getElementById('adjustBalanceModal')).hide();

    } catch (err) {
        alert('Failed to adjust balance: ' + (err.message || err));
    }

});
