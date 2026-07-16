import { db } from "./firebase.js";
import {
  doc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  fetchPanelSettings,
  normalizePanelTheme,
  normalizePanelSettings,
  writePanelSettingsCache,
} from "./admin-panel-settings.js";
import {
  requireAdminAuth,
  initAdminSidebar,
  bindAdminLogout
} from "./admin-ui-common.js";

// Cloudinary config (same as userpanel account)
const CLOUDINARY_CLOUD_NAME = "dcrxjq8l5";
const CLOUDINARY_UPLOAD_PRESET = "unsigned_upload";
const CLOUDINARY_UPLOAD_URL = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;

requireAdminAuth();

// Global error reporting for easier debugging in admin pages
window.addEventListener("error", (ev) => {
  try {
    const msg = ev?.error?.message || ev.message || String(ev?.error || ev?.message || "Unknown error");
    console.error("Unhandled error:", ev.error || ev.message, ev.error || ev);
    setStatus && typeof setStatus === 'function' && setStatus(`Error: ${msg}`, "danger");
  } catch {}
});
window.addEventListener("unhandledrejection", (ev) => {
  try {
    const reason = ev?.reason || ev;
    console.error("Unhandled promise rejection:", reason);
    setStatus && typeof setStatus === 'function' && setStatus(`Error: ${String(reason?.message || reason)}`, "danger");
  } catch {}
});

initAdminSidebar();

const form = document.getElementById("panelSettingsForm");
const nameInput = document.getElementById("panelNameInput");
const mobileInput = document.getElementById("panelMobileInput");
const whatsappNumberInput = document.getElementById("whatsappNumberInput");
const whatsappCommunityInput = document.getElementById("whatsappCommunityInput");
const whatsappEnabledInput = document.getElementById("whatsappEnabledInput");
const newUserTestBalanceInput = document.getElementById("newUserTestBalanceInput");
const statusEl = document.getElementById("panelSettingsStatus");
const saveBtn = document.getElementById("btnSavePanelSettings");
const siteLogoInput = document.getElementById("siteLogoInput");
const siteLogoPreview = document.getElementById("siteLogoPreview");
const LOGO_HINT_DEFAULT = "PNG/JPG, max 5MB";
const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const ALLOWED_LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/jpg"]);

function setLogoHint(text = LOGO_HINT_DEFAULT, isError = false) {
  try {
    const hintEl = siteLogoInput?.closest?.("div")?.querySelector?.(".form-text");
    if (!hintEl) return;
    hintEl.textContent = text;
    hintEl.style.color = isError ? "#dc2626" : "#6c757d";
  } catch {}
}

function validateLogoFile(file) {
  if (!file) return "Please select a logo file.";
  if (!ALLOWED_LOGO_TYPES.has((file.type || "").toLowerCase())) return "Only PNG or JPG image is allowed.";
  if ((file.size || 0) > MAX_LOGO_BYTES) return "Logo size should be 5MB or less.";
  return "";
}

function setSaveButtonLoading(isLoading = false, text = "Saving...") {
  if (!saveBtn) return;
  saveBtn.disabled = isLoading;
  saveBtn.innerHTML = isLoading ? `<span class="spinner-border spinner-border-sm" aria-hidden="true"></span> ${text}` : '<i class="bi bi-check2-circle"></i> Save Settings';
}

let currentSettings = normalizePanelSettings({});

function setStatus(message, tone = "muted") {
  if (!statusEl) return;
  statusEl.className = `small text-${tone}`;
  statusEl.textContent = message || "";
}

function normalizeAmount(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Number(amount.toFixed(2));
}

function fillForm(settings) {
  if (nameInput) nameInput.value = settings.panelName || "";
  if (mobileInput) mobileInput.value = settings.panelMobile || "";
  if (whatsappNumberInput) whatsappNumberInput.value = settings.whatsappNumber || "";
  if (whatsappCommunityInput) whatsappCommunityInput.value = settings.whatsappCommunityUrl || "";
  if (whatsappEnabledInput) whatsappEnabledInput.checked = Boolean(settings.whatsappEnabled);
  if (newUserTestBalanceInput) newUserTestBalanceInput.value = String(normalizeAmount(settings.newUserTestBalance));
  if (siteLogoPreview && settings.logoUrl) {
    siteLogoPreview.src = settings.logoUrl;
  }
}

const userPanelFirebaseConfig = {
  apiKey: "AIzaSyDlLKwLcvQKyjasNPUSxJ7Gkd-suGf-W6Q",
  authDomain: "reseller-panel-d376c.firebaseapp.com",
  projectId: "reseller-panel-d376c",
  storageBucket: "reseller-panel-d376c.firebasestorage.app",
  appId: "1:923222855704:web:581ad8dd2759fe4102f36d",
  measurementId: "G-78ZZY6S5E7"
};

let userApp = null;
let userPanelDb = null;
try {
  userApp = initializeApp(userPanelFirebaseConfig, "userpanel-settings");
  userPanelDb = getFirestore(userApp);
} catch (err) {
  console.warn("User panel Firebase init failed:", err);
}

async function uploadImageToCloudinary(file) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

  // Provide clearer error messages and timeout handling
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  let response;
  try {
    response = await fetch(CLOUDINARY_UPLOAD_URL, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    console.error("Cloudinary request failed:", err);
    throw new Error(err?.message || "Network error during upload.");
  }

  clearTimeout(timeout);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = String(data?.error?.message || `Upload failed (${response.status})`).trim();
    console.error("Cloudinary upload response error:", data);
    throw new Error(msg || "Cloudinary upload failed.");
  }

  const secureUrl = String(data?.secure_url || "").trim();
  if (!secureUrl) {
    console.error("Cloudinary response missing secure_url:", data);
    throw new Error("Cloudinary upload succeeded but secure_url was missing.");
  }
  return secureUrl;
}

if (form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setStatus("");

    const panelName = String(nameInput?.value || "").trim();
    const panelMobile = String(mobileInput?.value || "").trim();
    const theme = normalizePanelTheme("classic");
    const whatsappNumber = String(whatsappNumberInput?.value || "").trim();
    const whatsappEnabled = Boolean(whatsappEnabledInput?.checked);
    const whatsappCommunityUrl = String(whatsappCommunityInput?.value || "").trim();
    const newUserTestBalance = normalizeAmount(newUserTestBalanceInput?.value);

    if (!panelName) {
      setStatus("Panel name is required.", "danger");
      return;
    }
    if (Number(newUserTestBalanceInput?.value || 0) < 0) {
      setStatus("New user test balance cannot be negative.", "danger");
      return;
    }

    setSaveButtonLoading(true, "Saving...");
    setStatus("Saving...", "secondary");

    try {
      // If a new logo file is selected, upload it to Cloudinary first (same as account flow).
      let logoUrl = currentSettings?.logoUrl || "";
      const file = siteLogoInput?.files?.[0];
      if (file) {
        try {
          const validation = validateLogoFile(file);
          if (validation) throw new Error(validation);

          setStatus("Uploading logo...", "secondary");
          setSaveButtonLoading(true, "Uploading...");

          logoUrl = await uploadImageToCloudinary(file);
          setStatus("Logo uploaded.", "muted");
        } catch (err) {
          console.warn("Logo upload failed:", err);
          setLogoHint(String(err?.message || "Logo upload failed"), true);
        }
      }

      const payload = {
        panelName,
        panelMobile,
        theme,
        logoUrl,
        whatsappNumber,
        whatsappEnabled,
        whatsappCommunityUrl,
        newUserTestBalance,
        updatedAt: serverTimestamp(),
      };

      await setDoc(
        doc(db, "meta", "panel_settings"),
        payload,
        { merge: true }
      );

      if (userPanelDb) {
        try {
          await setDoc(doc(userPanelDb, "meta", "panel_settings"), payload, { merge: true });
        } catch (err) {
          console.warn("User panel settings save failed:", err);
        }
      }

      try {
        const existing = JSON.parse(localStorage.getItem("panelSettings") || "{}");
        localStorage.setItem(
          "panelSettings",
          JSON.stringify({
            ...existing,
            panelName,
            panelMobile,
            theme,
            logoUrl,
            whatsappNumber,
            whatsappEnabled,
            whatsappCommunityUrl,
            newUserTestBalance,
          })
        );
      } catch {
        // Ignore local cache write failures.
      }

      writePanelSettingsCache(payload);
      currentSettings = { panelName, panelMobile, theme, logoUrl, whatsappNumber, whatsappEnabled, whatsappCommunityUrl, newUserTestBalance };
      // Update preview to the uploaded URL so change is visible immediately
      try {
        if (siteLogoPreview && logoUrl) {
          try { siteLogoPreview.crossOrigin = 'anonymous'; } catch {}
          siteLogoPreview.src = `${logoUrl}${logoUrl.includes('?') ? '&' : '?'}_=${Date.now()}`;
        }
      } catch (e) {}

      setStatus("Settings saved.", "success");
    } catch (err) {
      console.error("savePanelSettings:", err);
      setStatus("Save failed. Check console.", "danger");
    } finally {
      setSaveButtonLoading(false);
    }
  });
}

if (siteLogoInput && siteLogoPreview) {
  siteLogoInput.addEventListener('change', (e) => {
    const file = siteLogoInput.files?.[0];
    if (!file) return;
    const validation = validateLogoFile(file);
    if (validation) {
      setLogoHint(validation, true);
      siteLogoInput.value = "";
      return;
    }
    setLogoHint();
    try {
      const url = URL.createObjectURL(file);
      siteLogoPreview.src = url;
    } catch (err) {
      // ignore
    }
  });
}

bindAdminLogout("btnLogout");

fetchPanelSettings().then((settings) => {
  currentSettings = settings;
  fillForm(settings);
  setStatus("Settings loaded.", "muted");
});
