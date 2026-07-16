import { db, auth, signOut } from "./firebase.js";
import { doc, getDoc, collection, getDocs, query, where, limit } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  CacheTTL,
  readCache,
  writeCache,
  panelSettingsKey,
  authGuardKey,
  userSummaryKey
} from "./data-cache.js";
import { applyPanelBranding, writePanelSettingsCache } from "../panel-branding-core.js";
import { fetchUserSummaryFast } from "./firestore-fast.js";

const DEFAULT_SETTINGS = {
  panelName: "",
  whatsappEnabled: false,
  whatsappNumber: "",
  whatsappCommunityUrl: "",
  syncKey: "",
};

const MAINTENANCE_MIN_GAP_MS = 5 * 60 * 1000;
const MAINTENANCE_LAST_RUN_KEY = "panelMaintenanceLastRunAt";
const MAINTENANCE_LAST_RUN_SHARED_KEY = "panelMaintenanceLastRunAtShared";
const USERNAME_STORAGE_KEY = "smmGrowthUser";
const REMEMBER_STORAGE_KEY = "smmGrowthRemember";

function runWhenIdle(task) {
  if (typeof task !== "function") return;
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(task, { timeout: 1200 });
  } else {
    setTimeout(task, 180);
  }
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function shouldPersistLogin() {
  const remembered = String(localStorage.getItem(REMEMBER_STORAGE_KEY) || "").trim();
  if (remembered === "1") return true;

  // If the username is already cached locally, keep using localStorage so the
  // app survives reopen/standalone launches without forcing login again.
  return !!String(localStorage.getItem(USERNAME_STORAGE_KEY) || "").trim();
}

function getStoredUsername() {
  return normalizeUsername(
    localStorage.getItem(USERNAME_STORAGE_KEY) ||
    sessionStorage.getItem(USERNAME_STORAGE_KEY) ||
    ""
  );
}

function setStoredUsername(usernameInput) {
  const username = normalizeUsername(usernameInput);
  if (!username) return;

  if (shouldPersistLogin()) {
    localStorage.setItem(USERNAME_STORAGE_KEY, username);
    sessionStorage.removeItem(USERNAME_STORAGE_KEY);
    return;
  }

  sessionStorage.setItem(USERNAME_STORAGE_KEY, username);
  localStorage.removeItem(USERNAME_STORAGE_KEY);
}

function clearStoredUsername() {
  localStorage.removeItem(USERNAME_STORAGE_KEY);
  sessionStorage.removeItem(USERNAME_STORAGE_KEY);
}

function normalizeSettings(raw = {}) {
  const panelName = String(raw.panelName || DEFAULT_SETTINGS.panelName).trim() || DEFAULT_SETTINGS.panelName;
  const whatsappEnabled = Boolean(raw.whatsappEnabled);
  const whatsappNumber = String(raw.whatsappNumber || "").trim();
  const whatsappCommunityUrl = String(raw.whatsappCommunityUrl || "").trim();
  const syncKey = String(raw.syncKey || raw.maintenanceKey || raw.cronKey || "").trim();
  return { panelName, whatsappEnabled, whatsappNumber, whatsappCommunityUrl, syncKey };
}

function applyPanelText(settings) {
  const normalized = normalizeSettings(settings);
  applyPanelBranding(normalized, {
    title: document.title,
    themeStorageKey: "panelTheme",
  });
  writePanelSettingsCache(normalized);
  return normalized;
}

async function triggerBackgroundPanelMaintenance() {
  const now = Date.now();
  const lastRunSession = Number(sessionStorage.getItem(MAINTENANCE_LAST_RUN_KEY) || 0);
  const lastRunShared = Number(localStorage.getItem(MAINTENANCE_LAST_RUN_SHARED_KEY) || 0);
  const lastRun = Math.max(lastRunSession, lastRunShared);
  if (lastRun && now - lastRun < MAINTENANCE_MIN_GAP_MS) return;

  sessionStorage.setItem(MAINTENANCE_LAST_RUN_KEY, String(now));
  localStorage.setItem(MAINTENANCE_LAST_RUN_SHARED_KEY, String(now));

  let syncKey = "";
  try {
    const settings = JSON.parse(localStorage.getItem("panelSettings") || "{}");
    syncKey = String(settings.syncKey || settings.maintenanceKey || settings.cronKey || "").trim();
  } catch {
    syncKey = "";
  }

  const withKey = (endpoint) => {
    if (!syncKey) return endpoint;
    const joiner = endpoint.includes("?") ? "&" : "?";
    return `${endpoint}${joiner}key=${encodeURIComponent(syncKey)}`;
  };

  const statusEndpoint = withKey("/api/status-check");
  const endpoints = [statusEndpoint];

  endpoints.forEach((endpoint) => {
    fetch(endpoint, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      keepalive: true
    }).catch(() => {});
  });
}

export async function initPanelSettings() {
  const cacheKey = panelSettingsKey();
  const cached = readCache(cacheKey, { maxAgeMs: CacheTTL.panelSettings });

  if (cached) {
    const settings = normalizeSettings(cached);
    const normalized = applyPanelText(settings);
    localStorage.setItem("panelSettings", JSON.stringify(normalized));
    return normalized;
  }

  let settings = { ...DEFAULT_SETTINGS };
  try {
    const snap = await getDoc(doc(db, "meta", "panel_settings"));
    if (snap.exists()) {
      settings = normalizeSettings(snap.data());
      writeCache(cacheKey, settings);
    }
  } catch (err) {
    console.warn("User panel settings load failed:", err);
  }

  const normalized = applyPanelText(settings);
  localStorage.setItem("panelSettings", JSON.stringify(normalized));
  return normalized;
}

initPanelSettings();
runWhenIdle(() => {
  triggerBackgroundPanelMaintenance();
});

// --- AUTH GUARD: ensure Firestore has username & email for logged user ---
async function checkUserFirestoreIntegrity(loggedUser) {
  try {
    // If the Firebase auth user has no email linked, force logout immediately
    if (!loggedUser || !loggedUser.email || String(loggedUser.email).trim() === "") {
      try { await signOut(auth); } catch {}
      clearStoredUsername();
      alert("No email linked to this account. Logging out.");
      location.href = location.origin + '/index.html';
      return;
    }

    const email = String(loggedUser?.email || "").trim();
    const usernameLS = getStoredUsername();
    const integrityCacheKey = authGuardKey(loggedUser?.uid || email);
    const cachedIntegrity = readCache(integrityCacheKey, { maxAgeMs: CacheTTL.authGuard });
    if (cachedIntegrity?.ok) {
      const cachedUsername = String(cachedIntegrity.username || usernameLS || "").trim();
      if (cachedUsername) {
        setStoredUsername(cachedUsername);
        return;
      }
    }

    let userDoc = null;
    if (loggedUser?.uid) {
      const byUid = await getDoc(doc(db, "users", String(loggedUser.uid).trim()));
      if (byUid.exists()) {
        userDoc = byUid;
      }
    }

    if (!userDoc && email) {
      const q = query(collection(db, "users"), where("email", "==", email), limit(1));
      const snap = await getDocs(q);
      if (!snap.empty) userDoc = snap.docs[0];
    }

    if (!userDoc && usernameLS) {
      const q2 = query(collection(db, "users"), where("username", "==", usernameLS), limit(1));
      const snap2 = await getDocs(q2);
      if (!snap2.empty) userDoc = snap2.docs[0];
    }

    if (!userDoc) {
      await signOut(auth);
      clearStoredUsername();
      alert("Account not found in records. Logging out.");
      location.href = location.origin + '/index.html';
      return;
    }

    const data = userDoc.data() || {};
    if (!String(data.username || "").trim() || !String(data.email || "").trim()) {
      await signOut(auth);
      clearStoredUsername();
      alert("Incomplete account data. Logging out.");
      location.href = location.origin + '/index.html';
      return;
    }

    // Ensure local username is synced
    const finalUsername = String(data.username || usernameLS || "").trim();
    if (finalUsername) setStoredUsername(finalUsername);

    writeCache(integrityCacheKey, {
      ok: true,
      username: finalUsername,
      email: String(data.email || email || "").trim()
    });

    if (finalUsername) {
      writeCache(userSummaryKey(finalUsername), {
        id: userDoc.id,
        username: finalUsername,
        email: String(data.email || "").trim(),
        balance: Number(data.balance || 0),
        extraProfit: Number(data.extraProfit || 0),
        discount: Number(data.discount || 0),
        timezone: String(data.timezone || "Asia/Kolkata").trim(),
        whatsapp: String(data.whatsapp || "").trim()
      });
    }
  } catch (err) {
    console.warn("User integrity check failed:", err);
  }
}

async function validateLocalUsernameSession(usernameInput) {
  try {
    const username = String(usernameInput || "").trim().toLowerCase();
    if (!username) return false;

    const cachedUser = readCache(userSummaryKey(username), { maxAgeMs: CacheTTL.userSummary });
    if (cachedUser?.username) {
      setStoredUsername(String(cachedUser.username).trim().toLowerCase());
      return true;
    }

    const fastSummary = await fetchUserSummaryFast(username, { forceRefresh: true });
    if (fastSummary?.username) {
      setStoredUsername(String(fastSummary.username).trim().toLowerCase());
      return true;
    }

    const userQ = query(collection(db, "users"), where("username", "==", username), limit(1));
    const userSnap = await getDocs(userQ);
    if (userSnap.empty) return false;

    const data = userSnap.docs[0]?.data() || {};
    const normalizedUsername = String(data.username || "").trim().toLowerCase();
    if (!normalizedUsername) return false;

    // Keep local session username canonical and available across panel pages.
    setStoredUsername(normalizedUsername);
    writeCache(userSummaryKey(normalizedUsername), {
      id: userSnap.docs[0]?.id || "",
      username: normalizedUsername,
      email: String(data.email || "").trim(),
      balance: Number(data.balance || 0),
      extraProfit: Number(data.extraProfit || 0),
      discount: Number(data.discount || 0),
      timezone: String(data.timezone || "Asia/Kolkata").trim(),
      whatsapp: String(data.whatsapp || "").trim()
    });
    return true;
  } catch (err) {
    console.warn("Local username session validation failed:", err);
    return false;
  }
}

let loginRedirectInProgress = false;

function setupAuthGuard() {
  try {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        await checkUserFirestoreIntegrity(user);
        return;
      }

      const usernameLS = getStoredUsername();
      if (usernameLS) {
        const isValidLocalSession = await validateLocalUsernameSession(usernameLS);
        if (isValidLocalSession) return;
      }

      if (loginRedirectInProgress) return;
      loginRedirectInProgress = true;
      try { clearStoredUsername(); } catch {}
      location.href = location.origin + "/index.html";
    });
  } catch (err) {
    console.warn("Auth guard setup failed:", err);
  }
}

setupAuthGuard();

// --- Highlight active bottom-nav item based on current path ---
function setBottomNavActive() {
  try {
    const current = (location.pathname || '').split('/').pop().toLowerCase();
    if (!current) return;
    ['.bottom-nav .nav-btn', '.sidebar-menu a'].forEach((selector) => {
      document.querySelectorAll(selector).forEach(a => {
        try {
          const href = (a.getAttribute('href') || '').split('/').pop().toLowerCase();
          if (href && href === current) a.classList.add('active'); else a.classList.remove('active');
        } catch (e) { /* ignore */ }
      });
    });
  } catch (err) { console.warn('setBottomNavActive failed', err); }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setBottomNavActive); else setBottomNavActive();
