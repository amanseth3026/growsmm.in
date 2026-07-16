import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  requireAdminAuth,
  initAdminSidebar,
  bindAdminLogout
} from "./admin-ui-common.js";

const PUBLIC_SERVICE_CACHE_KEYS = ["growsmm_public_services_v2", "growsmm_public_services_v3"];

// Auth Check
requireAdminAuth();
initAdminSidebar({ closeOnOutsideClick: true });

// --- DOM ---
const manualForm = document.getElementById("manualServiceForm");
const manualSearch = document.getElementById("manualSearch");
const manualTableBody = document.getElementById("manualServiceTableBody");
const manualCount = document.getElementById("manualCount");
const manualSaveBtn = document.getElementById("manualSaveBtn");
const manualClearBtn = document.getElementById("manualClearBtn");

const manualId = document.getElementById("manualId");
const manualTitle = document.getElementById("manualTitle");
const manualCategory = document.getElementById("manualCategory");
const manualPrice = document.getElementById("manualPrice");
const manualMin = document.getElementById("manualMin");
const manualMax = document.getElementById("manualMax");
const manualAvgTime = document.getElementById("manualAvgTime");
const manualDesc = document.getElementById("manualDesc");
const manualActive = document.getElementById("manualActive");

let manualServices = [];
let manualEditId = "";

function sanitizeManualId(raw) {
  return String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "");
}

function clearPublicServiceCache() {
  try {
    PUBLIC_SERVICE_CACHE_KEYS.forEach((cacheKey) => localStorage.removeItem(cacheKey));
  } catch {
    // Ignore cache cleanup failures.
  }
}

function resetManualForm() {
  manualEditId = "";
  if (manualForm) manualForm.reset();
  if (manualActive) manualActive.checked = true;
  if (manualId) manualId.disabled = false;
  if (manualSaveBtn) manualSaveBtn.innerHTML = `<i class="bi bi-check-lg"></i> Save Manual Service`;
}

async function loadManualServices() {
  if (!manualTableBody) return;
  const snap = await getDocs(collection(db, "manual_services"));
  manualServices = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  manualServices.sort((a, b) => {
    const aTime = a.createdAt?.seconds || 0;
    const bTime = b.createdAt?.seconds || 0;
    return bTime - aTime;
  });
  renderManualServices();
}

function renderManualServices() {
  if (!manualTableBody) return;
  const term = (manualSearch?.value || "").toLowerCase().trim();
  const filtered = manualServices.filter(m => {
    const hay = `${m.title || ""} ${m.category || ""} ${m.id}`.toLowerCase();
    return !term || hay.includes(term);
  });

  if (manualCount) manualCount.textContent = filtered.length;

  if (!filtered.length) {
    manualTableBody.innerHTML = `<tr><td colspan="8" class="text-center text-muted py-4">No manual services found</td></tr>`;
    return;
  }

  manualTableBody.innerHTML = filtered.map(m => {
    const active = m.active !== false;
    const price = Number(m.userPrice || 0).toFixed(2);
    const min = Number(m.minQty || 0);
    const max = Number(m.maxQty || 0);
    const category = m.category || "Manual";
    return `
      <tr>
        <td>
          <div class="form-check d-flex justify-content-center">
            <input type="checkbox" class="form-check-input manual-active" data-id="${m.id}" ${active ? "checked" : ""}>
          </div>
        </td>
        <td title="${m.id}"><small class="text-muted">${m.id}</small></td>
        <td><span class="badge bg-light text-dark border text-truncate" style="max-width:120px; display:block;">${category}</span></td>
        <td title="${m.title || ""}"><div class="text-truncate" style="max-width: 260px;">${m.title || "Untitled"}</div></td>
        <td><small class="fw-bold text-secondary">₹${price}</small></td>
        <td>${min}</td>
        <td>${max || "-"}</td>
        <td class="text-end">
          <button class="btn btn-sm btn-light border manual-edit" data-id="${m.id}"><i class="bi bi-pencil"></i></button>
          <button class="btn btn-sm btn-light border text-danger manual-delete" data-id="${m.id}"><i class="bi bi-trash"></i></button>
        </td>
      </tr>
    `;
  }).join("");
}

if (manualSearch) {
  manualSearch.addEventListener("input", () => renderManualServices());
}

if (manualForm) {
  manualForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const title = manualTitle?.value.trim();
    const category = manualCategory?.value.trim();
    const userPrice = Number(manualPrice?.value || 0);
    const minQty = Number(manualMin?.value || 0);
    const maxQty = Number(manualMax?.value || 0);
    const avgTime = manualAvgTime?.value.trim();
    const description = manualDesc?.value.trim();
    const active = manualActive ? manualActive.checked : true;

    if (!title || !category || !userPrice || !minQty) {
      return alert("Please fill all required fields.");
    }

    if (manualSaveBtn) manualSaveBtn.textContent = "Saving...";

    try {
      const payload = {
        title,
        category,
        userPrice,
        minQty,
        maxQty,
        avgTime,
        description,
        active,
        updatedAt: serverTimestamp()
      };

      if (manualEditId) {
        await updateDoc(doc(db, "manual_services", manualEditId), payload);
        alert("Manual service updated!");
      } else {
        const rawId = manualId?.value || "";
        const cleanId = sanitizeManualId(rawId);
        if (!cleanId) {
          return alert("Please enter a valid Service ID.");
        }
        if (cleanId.startsWith("manual_")) {
          return alert("Please remove the manual_ prefix from Service ID.");
        }
        if (manualId && cleanId !== rawId) manualId.value = cleanId;

        const ref = doc(db, "manual_services", cleanId);
        const exists = await getDoc(ref);
        if (exists.exists()) {
          return alert("Service ID already exists. Please use a different ID.");
        }

        payload.createdAt = serverTimestamp();
        await setDoc(ref, payload);
        alert("Manual service created!");
      }

      resetManualForm();
      await loadManualServices();
      clearPublicServiceCache();
    } catch (err) {
      alert("Error: " + err.message);
    } finally {
      if (manualSaveBtn) manualSaveBtn.innerHTML = `<i class="bi bi-check-lg"></i> Save Manual Service`;
    }
  });
}

if (manualClearBtn) {
  manualClearBtn.addEventListener("click", () => resetManualForm());
}

if (manualTableBody) {
  manualTableBody.addEventListener("click", async (e) => {
    const editBtn = e.target.closest(".manual-edit");
    const delBtn = e.target.closest(".manual-delete");

    if (editBtn) {
      const id = editBtn.getAttribute("data-id");
      const svc = manualServices.find(m => m.id === id);
      if (!svc) return;
      manualEditId = id;
      if (manualId) { manualId.value = id; manualId.disabled = true; }
      if (manualTitle) manualTitle.value = svc.title || "";
      if (manualCategory) manualCategory.value = svc.category || "";
      if (manualPrice) manualPrice.value = svc.userPrice || 0;
      if (manualMin) manualMin.value = svc.minQty || 0;
      if (manualMax) manualMax.value = svc.maxQty || 0;
      if (manualAvgTime) manualAvgTime.value = svc.avgTime || "";
      if (manualDesc) manualDesc.value = svc.description || "";
      if (manualActive) manualActive.checked = svc.active !== false;
      if (manualSaveBtn) manualSaveBtn.textContent = "Update Manual Service";
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    if (delBtn) {
      const id = delBtn.getAttribute("data-id");
      if (!confirm("Delete this manual service?")) return;
      try {
        await deleteDoc(doc(db, "manual_services", id));
        await loadManualServices();
        clearPublicServiceCache();
      } catch (err) {
        alert("Error: " + err.message);
      }
    }
  });

  manualTableBody.addEventListener("change", async (e) => {
    const chk = e.target;
    if (!chk.classList.contains("manual-active")) return;
    const id = chk.getAttribute("data-id");
    try {
      await updateDoc(doc(db, "manual_services", id), {
        active: chk.checked,
        updatedAt: serverTimestamp()
      });
      clearPublicServiceCache();
    } catch (err) {
      alert("Error: " + err.message);
    }
  });
}

bindAdminLogout("btnLogout");

loadManualServices();



