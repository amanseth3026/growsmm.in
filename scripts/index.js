// ==============================
// landing.js
// Performance-focused version
// ==============================

const APP_VERSION = "v17";
const APP_VERSION_KEY = "app_version";
const USER_KEY = "smmGrowthUser";
const REMEMBER_KEY = "smmGrowthRemember";

function runVersionedStorageMigration() {
  try {
    const savedVersion = localStorage.getItem(APP_VERSION_KEY);
    if (savedVersion === APP_VERSION) return;

    // Clean only landing/auth keys instead of clearing whole storage.
    const scopedKeys = [
      USER_KEY,
      REMEMBER_KEY,
      "reloaded_once",
      "smm_services_cache_v2_guest",
      "smm_services_cache_v3_guest"
    ];
    scopedKeys.forEach((key) => {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    });
    localStorage.setItem(APP_VERSION_KEY, APP_VERSION);
  } catch {
    // Ignore storage access errors (private mode, blocked storage, etc).
  }
}

runVersionedStorageMigration();

const existingUser = localStorage.getItem(USER_KEY) || sessionStorage.getItem(USER_KEY);
if (existingUser) {
  window.location.replace("/userpanel/neworder.html");
} else {
  document.body.classList.add("loaded");
}

const loginBtns = document.querySelectorAll(".login-trigger");
const loginCard = document.getElementById("landingLoginCard");
const landingLoginForm = document.getElementById("landingLoginForm");
const loginIdentifier = document.getElementById("loginIdentifier");
const loginPassword = document.getElementById("loginPassword");
const rememberMe = document.getElementById("rememberMe");
const loginError = document.getElementById("loginError");
const btnGoogleLogin = document.getElementById("btnGoogleLogin");
const btnSignIn = document.getElementById("btnSignIn");

const loginLookupCache = new Map();
let firebaseDepsPromise = null;

function normalizeIdentifier(value) {
  return String(value || "").trim().toLowerCase();
}

function sanitizeUsername(value) {
  const cleaned = String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return cleaned || "user";
}

function showError(message) {
  if (!loginError) return;
  loginError.textContent = message;
  loginError.classList.remove("d-none");
  loginError.style.display = "block";
}

function clearError() {
  if (!loginError) return;
  loginError.textContent = "";
  loginError.classList.add("d-none");
  loginError.style.display = "none";
}

function toggleButtonLoading(button, loadingText, isLoading) {
  if (!button) return;

  if (isLoading) {
    button.dataset.original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>${loadingText}`;
    return;
  }

  button.disabled = false;
  button.innerHTML = button.dataset.original || "Continue";
}

function saveLogin(username) {
  const normalizedUsername = normalizeIdentifier(username);
  const useLocalStorage = rememberMe?.checked !== false;

  if (useLocalStorage) {
    localStorage.setItem(USER_KEY, normalizedUsername);
    localStorage.setItem(REMEMBER_KEY, "1");
    sessionStorage.removeItem(USER_KEY);
    sessionStorage.removeItem(REMEMBER_KEY);
  } else {
    sessionStorage.setItem(USER_KEY, normalizedUsername);
    sessionStorage.setItem(REMEMBER_KEY, "1");
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(REMEMBER_KEY);
  }

  window.location.assign("/userpanel/neworder.html");
}

async function loadFirebaseDeps() {
  if (firebaseDepsPromise) return firebaseDepsPromise;

  firebaseDepsPromise = Promise.all([
    import("./firebase.js"),
    import("./password-utils.js"),
    import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js")
  ]).then(([firebaseMod, passwordMod, firestoreMod]) => ({
    auth: firebaseMod.auth,
    provider: firebaseMod.provider,
    signInWithPopup: firebaseMod.signInWithPopup,
    db: firebaseMod.db,
    createPasswordRecord: passwordMod.createPasswordRecord,
    hasPasswordRecord: passwordMod.hasPasswordRecord,
    verifyPasswordRecord: passwordMod.verifyPasswordRecord,
    doc: firestoreMod.doc,
    getDoc: firestoreMod.getDoc,
    setDoc: firestoreMod.setDoc,
    deleteField: firestoreMod.deleteField,
    getDocs: firestoreMod.getDocs,
    collection: firestoreMod.collection,
    limit: firestoreMod.limit,
    query: firestoreMod.query,
    where: firestoreMod.where
  }));

  return firebaseDepsPromise;
}

function preloadFirebaseDeps() {
  void loadFirebaseDeps().catch(() => {});
}

function scheduleDepsWarmup() {
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(preloadFirebaseDeps, { timeout: 2500 });
    return;
  }
  window.setTimeout(preloadFirebaseDeps, 1800);
}

scheduleDepsWarmup();

landingLoginForm?.addEventListener("focusin", preloadFirebaseDeps, { once: true });
btnGoogleLogin?.addEventListener("pointerdown", preloadFirebaseDeps, { once: true, passive: true });

async function isUsernameTaken(candidate, deps, ignoreUid = "") {
  const usernameQuery = deps.query(
    deps.collection(deps.db, "users"),
    deps.where("username", "==", candidate),
    deps.limit(1)
  );
  const snap = await deps.getDocs(usernameQuery);
  if (snap.empty) return false;
  if (!ignoreUid) return true;
  return snap.docs.some((docSnap) => docSnap.id !== ignoreUid);
}

async function generateUniqueUsername(base, deps, ignoreUid = "") {
  const root = sanitizeUsername(base);
  let candidate = root;
  let counter = 0;

  while (counter < 120) {
    const taken = await isUsernameTaken(candidate, deps, ignoreUid);
    if (!taken) return candidate;
    counter += 1;
    candidate = `${root}_${counter}`;
  }

  return `${root}_${Date.now().toString().slice(-4)}`;
}

function normalizeAmount(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Number(amount.toFixed(2));
}

async function getNewUserTestBalance(deps) {
  try {
    const snap = await deps.getDoc(deps.doc(deps.db, "meta", "panel_settings"));
    if (!snap.exists()) return 0;
    return normalizeAmount(snap.data()?.newUserTestBalance);
  } catch (err) {
    console.warn("New user test balance load failed:", err);
    return 0;
  }
}

async function ensureGoogleUserProfile(user, deps) {
  const ref = deps.doc(deps.db, "users", user.uid);
  const snap = await deps.getDoc(ref);
  const current = snap.exists() ? snap.data() : {};

  let username = normalizeIdentifier(current?.username);
  if (!username) {
    const base = user.displayName || user.email?.split("@")[0] || "user";
    username = await generateUniqueUsername(base, deps, user.uid);
  }

  const email = normalizeIdentifier(user.email || current?.email || "");
  const isNewUser = !snap.exists();
  const startingBalance = isNewUser
    ? await getNewUserTestBalance(deps)
    : Number(current?.balance || 0);

  const payload = {
    username,
    email,
    emailLower: email,
    uid: user.uid,
    authProvider: "google",
    name: user.displayName || current?.name || "User",
    photo: user.photoURL || current?.photo || "",
    balance: startingBalance,
    updatedAt: Date.now()
  };

  if (isNewUser) {
    payload.createdAt = Date.now();
  }

  const legacyPassword = String(current?.password || "").trim();
  if (!current?.passwordHash && legacyPassword) {
    const passwordRecord = await deps.createPasswordRecord(legacyPassword);
    Object.assign(payload, passwordRecord);
    payload.password = deps.deleteField();
    payload.passwordMigratedAt = Date.now();
  }

  await deps.setDoc(ref, payload, { merge: true });
  return username;
}

async function handleGoogleLogin() {
  clearError();

  try {
    toggleButtonLoading(btnGoogleLogin, "Loading...", true);
    const deps = await loadFirebaseDeps();
    const res = await deps.signInWithPopup(deps.auth, deps.provider);
    const username = await ensureGoogleUserProfile(res.user, deps);
    saveLogin(username);
  } catch (err) {
    console.error("Google login error:", err);
    if (err?.code !== "auth/popup-closed-by-user") {
      showError("Google login failed. Please try again.");
    }
  } finally {
    toggleButtonLoading(btnGoogleLogin, "", false);
  }
}

async function findUserByIdentifier(identifier, deps) {
  const value = normalizeIdentifier(identifier);
  if (!value) return null;

  if (loginLookupCache.has(value)) {
    return loginLookupCache.get(value);
  }

  const userQuery = value.includes("@")
    ? deps.query(
      deps.collection(deps.db, "users"),
      deps.where("emailLower", "==", value),
      deps.limit(1)
    )
    : deps.query(
      deps.collection(deps.db, "users"),
      deps.where("username", "==", value),
      deps.limit(1)
    );

  const snap = await deps.getDocs(userQuery);
  if (snap.empty) {
    loginLookupCache.set(value, null);
    return null;
  }

  const userData = snap.docs[0].data();
  loginLookupCache.set(value, userData);
  return userData;
}

if (landingLoginForm) {
  landingLoginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError();

    const identifier = normalizeIdentifier(loginIdentifier?.value);
    const password = String(loginPassword?.value || "").trim();

    if (!identifier || !password) {
      showError("Please enter username/email and password.");
      return;
    }

    try {
      toggleButtonLoading(btnSignIn, "Signing In...", true);
      const deps = await loadFirebaseDeps();
      const userData = await findUserByIdentifier(identifier, deps);

      if (!userData || !userData.username) {
        showError("User not found.");
        return;
      }

      if (!deps.hasPasswordRecord(userData)) {
        showError("Password not set for this account.");
        return;
      }

      const passwordOk = await deps.verifyPasswordRecord(password, userData);
      if (!passwordOk) {
        showError("Invalid password.");
        return;
      }

      saveLogin(userData.username);
    } catch (err) {
      console.error("Manual login error:", err);
      showError("Login failed. Please try again.");
    } finally {
      toggleButtonLoading(btnSignIn, "", false);
    }
  });
}

if (btnGoogleLogin) {
  btnGoogleLogin.addEventListener("click", handleGoogleLogin);
}

loginBtns.forEach((btn) => {
  btn.addEventListener("click", (event) => {
    event.preventDefault();

    if (loginCard) {
      loginCard.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    }

    window.setTimeout(() => {
      loginIdentifier?.focus();
    }, 260);
  });
});
