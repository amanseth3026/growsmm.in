// firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { 
  getAuth, 
  GoogleAuthProvider, 
  RecaptchaVerifier, 
  signInWithPhoneNumber,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signOut,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const CONFIG_CACHE_KEY = "__FIREBASE_CONFIG__";
const CONFIG_STORAGE_KEY = "__FIREBASE_CONFIG_CACHE_V1__";
const CONFIG_TTL_MS = 12 * 60 * 60 * 1000;

function normalizeHost(rawHost) {
  return String(rawHost || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

function getCurrentHostKey() {
  try {
    return normalizeHost(window.location.host || "");
  } catch {
    return "";
  }
}

function readStoredConfig({ allowExpired = false } = {}) {
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const cachedConfig = parsed?.data;
    const ts = Number(parsed?.ts || 0);
    const cachedHost = normalizeHost(parsed?.host || "");
    const currentHost = getCurrentHostKey();

    if (!cachedConfig || !ts) return null;
    if (currentHost && cachedHost && currentHost !== cachedHost) return null;
    if (!allowExpired && Date.now() - ts > CONFIG_TTL_MS) return null;

    return cachedConfig;
  } catch {
    return null;
  }
}

function writeStoredConfig(config) {
  try {
    localStorage.setItem(
      CONFIG_STORAGE_KEY,
      JSON.stringify({
        ts: Date.now(),
        host: getCurrentHostKey(),
        data: config
      })
    );
  } catch {
    // Ignore storage write failures.
  }
}

async function fetchFirebaseConfigFromServer() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let res;
  try {
    res = await fetch("/api/client-config", {
      method: "GET",
      credentials: "same-origin",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`Failed to load Firebase config (${res.status})`);
  }
  const config = await res.json();
  if (!config || typeof config !== "object") {
    throw new Error("Invalid Firebase config payload");
  }
  return config;
}

async function loadFirebaseConfig() {
  if (globalThis[CONFIG_CACHE_KEY]) return globalThis[CONFIG_CACHE_KEY];

  const cached = readStoredConfig();
  if (cached) {
    globalThis[CONFIG_CACHE_KEY] = cached;
    // Revalidate in background so next navigation always has fresh settings.
    fetchFirebaseConfigFromServer()
      .then((freshConfig) => {
        globalThis[CONFIG_CACHE_KEY] = freshConfig;
        writeStoredConfig(freshConfig);
      })
      .catch(() => {});
    return cached;
  }

  let config = null;
  try {
    config = await fetchFirebaseConfigFromServer();
  } catch (err) {
    const staleCached = readStoredConfig({ allowExpired: true });
    if (staleCached) {
      globalThis[CONFIG_CACHE_KEY] = staleCached;
      return staleCached;
    }
    throw err;
  }

  globalThis[CONFIG_CACHE_KEY] = config;
  writeStoredConfig(config);
  return config;
}

const firebaseConfig = await loadFirebaseConfig();
if (!firebaseConfig?.apiKey || !firebaseConfig?.authDomain || !firebaseConfig?.projectId) {
  throw new Error("Missing Firebase client config. Check .env and client-config function.");
}

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

setPersistence(auth, browserLocalPersistence).catch((err) => {
  console.warn("Firebase auth persistence setup failed:", err);
});

export { 
  db, auth, provider, 
  firebaseConfig,
  RecaptchaVerifier, signInWithPhoneNumber, 
  signInWithEmailAndPassword, createUserWithEmailAndPassword, 
  signInWithPopup, signOut 
};
