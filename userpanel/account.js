import { db, auth, signOut } from "./firebase.js";
import {
  createPasswordRecord,
  hasPasswordRecord,
  verifyPasswordRecord
} from "../password-utils.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  deleteField,
  limit,
  updateDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  CacheTTL,
  readCache,
  writeCache,
  userSummaryKey
} from "./data-cache.js";
import { fetchUserSummaryFast, getActiveUsername } from "./firestore-fast.js";

const USERNAME_KEY = "smmGrowthUser";
const MAX_PROFILE_PHOTO_BYTES = 5 * 1024 * 1024;
const PROFILE_PHOTO_HINT_DEFAULT = "PNG/JPG, max 5MB";
const ALLOWED_PROFILE_PHOTO_TYPES = new Set(["image/png", "image/jpeg", "image/jpg"]);
const CLOUDINARY_CLOUD_NAME = "dcrxjq8l5";
const CLOUDINARY_UPLOAD_PRESET = "unsigned_upload";
const CLOUDINARY_UPLOAD_URL = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;

// Elements
const userNameDisplay = document.getElementById("userNameDisplay");
const userEmailDisplay = document.getElementById("userEmailDisplay");
const userBalanceDisplay = document.getElementById("userBalanceDisplay");
const userAvatar = document.getElementById("userAvatar");
const userAvatarImg = document.getElementById("userAvatarImg");
const userAvatarFallback = document.getElementById("userAvatarFallback");
const btnUploadPhoto = document.getElementById("btnUploadPhoto");
const profilePhotoInput = document.getElementById("profilePhotoInput");
const profilePhotoHint = document.getElementById("profilePhotoHint");
const btnLogout = document.getElementById("btnLogout");
const usernamePreview = document.getElementById("usernamePreview");
const emailPreview = document.getElementById("emailPreview");
const apiUrlPreview = document.getElementById("apiUrlPreview");
const apiKeyPreview = document.getElementById("apiKeyPreview");
const btnCopyApiKey = document.getElementById("btnCopyApiKey");
const btnGenerateApiKey = document.getElementById("btnGenerateApiKey");
const btnToggleApiKey = document.getElementById("btnToggleApiKey");
const passwordPreview = document.getElementById("passwordPreview");
const btnTogglePassword = document.getElementById("btnTogglePassword");
const passwordToggleButtons = Array.from(document.querySelectorAll("[data-password-target]"));
const passwordChangeForm = document.getElementById("passwordChangeForm");
const currentPasswordInput = document.getElementById("currentPasswordInput");
const newPasswordInput = document.getElementById("newPasswordInput");
const confirmPasswordInput = document.getElementById("confirmPasswordInput");
const btnChangePassword = document.getElementById("btnChangePassword");
const timezoneForm = document.getElementById("timezoneForm");
const timezoneSelect = document.getElementById("timezoneSelect");
const btnSaveTimezone = document.getElementById("btnSaveTimezone");

// WhatsApp Elements
const displayWhatsAppStatus = document.getElementById("displayWhatsAppStatus");
const btnSaveWhatsApp = document.getElementById("btnSaveWhatsApp");
const whatsappInput = document.getElementById("whatsappInput");

let currentUserDocId = null;
let currentUserData = null;
let currentApiKey = "";
let isPasswordVisible = false;
let isApiKeyVisible = false;

function getUsername() {
  return (getActiveUsername() || localStorage.getItem(USERNAME_KEY) || sessionStorage.getItem(USERNAME_KEY) || "").trim();
}

function getUserSummaryCacheKey(username = getUsername()) {
  return userSummaryKey(username || "guest");
}

function writeUserSummaryCache(summary = {}) {
  const username = String(summary.username || getUsername() || "").trim();
  if (!username) return;
  const resolvedProfileImage = String(
    summary.profileImage || summary.photo || summary.avatarUrl || summary.photoURL || ""
  ).trim();
  writeCache(getUserSummaryCacheKey(username), {
    username,
    email: String(summary.email || "").trim(),
    balance: Number(summary.balance || 0),
    extraProfit: Number(summary.extraProfit || 0),
    discount: Number(summary.discount || 0),
    timezone: String(summary.timezone || "Asia/Kolkata").trim(),
    whatsapp: String(summary.whatsapp || "").trim(),
    profileImage: resolvedProfileImage,
    photo: resolvedProfileImage
  });
}

function formatINR(n) {
  return `\u20B9${Number(n || 0).toFixed(2)}`;
}

function getApiUrl() {
  return `${window.location.origin}/api/api`;
}

function getApiKeyFromData(userData = {}) {
  return String(
    userData.apiKey || userData.api_key || userData.apikey || ""
  ).trim();
}

function getUserPhotoUrl(userData = {}) {
  return String(
    userData.profileImage || userData.photo || userData.avatarUrl || userData.photoURL || ""
  ).trim();
}

function setTextOrValue(el, value) {
  if (!el) return;
  if ("value" in el) {
    el.value = value;
  } else {
    el.textContent = value;
  }
}

function maskApiKey(apiKey = "") {
  const key = String(apiKey || "");
  if (!key) return "Not available";
  if (key.length <= 4) return "*".repeat(key.length);
  return `${key.slice(0, 1)}${"*".repeat(Math.max(1, key.length - 2))}${key.slice(-1)}`;
}

function hasSecurePasswordRecord(userData = {}) {
  return !!String(userData.passwordHash || "").trim() && !!String(userData.passwordSalt || "").trim();
}

function getLegacyPassword(userData = {}) {
  return String(userData.password || "").trim();
}

function maskPassword(password = "") {
  const value = String(password || "");
  if (!value) return "Not set";
  if (value.length <= 2) return "*".repeat(value.length);
  return `${value.slice(0, 1)}${"*".repeat(Math.max(1, value.length - 2))}${value.slice(-1)}`;
}

function setProfilePhotoHint(text = PROFILE_PHOTO_HINT_DEFAULT, isError = false) {
  if (!profilePhotoHint) return;
  profilePhotoHint.textContent = String(text || PROFILE_PHOTO_HINT_DEFAULT);
  profilePhotoHint.style.color = isError ? "#dc2626" : "#64748b";
}

function setProfileUploadButtonLoading(isLoading = false) {
  if (!btnUploadPhoto) return;
  btnUploadPhoto.disabled = isLoading;
  btnUploadPhoto.innerHTML = isLoading
    ? '<span class="spinner-border spinner-border-sm" aria-hidden="true"></span> Uploading...'
    : '<i class="bi bi-camera"></i> Upload photo';
}

function getProfileUploadErrorMessage(error) {
  const message = String(error?.message || "").toLowerCase();
  if (
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("network request failed")
  ) {
    return "Image upload failed due to network issue. Please check internet and try again.";
  }
  if (
    message.includes("upload preset") ||
    message.includes("unsigned") ||
    message.includes("not allowed")
  ) {
    return "Cloudinary upload preset issue. Please verify 'unsigned_upload' preset is unsigned and active.";
  }
  return String(error?.message || "Profile photo upload failed. Please try again.");
}

function validateProfilePhoto(file) {
  if (!file) return "Please select a photo.";
  const fileType = String(file.type || "").toLowerCase();
  if (!ALLOWED_PROFILE_PHOTO_TYPES.has(fileType)) {
    return "Only PNG or JPG image is allowed.";
  }
  if (Number(file.size || 0) > MAX_PROFILE_PHOTO_BYTES) {
    return "Image size should be 5MB or less.";
  }
  return "";
}

async function uploadImageToCloudinary(file) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

  const response = await fetch(CLOUDINARY_UPLOAD_URL, {
    method: "POST",
    body: formData
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = String(data?.error?.message || `Upload failed (${response.status})`).trim();
    throw new Error(msg || "Cloudinary upload failed.");
  }

  const secureUrl = String(data?.secure_url || "").trim();
  if (!secureUrl) {
    throw new Error("Cloudinary upload succeeded but secure_url was missing.");
  }
  return secureUrl;
}

function applyAvatarToUI(userData = {}, username = "") {
  const safeUsername = String(username || "").trim();
  const initial = safeUsername ? safeUsername.charAt(0).toUpperCase() : "U";
  const photoUrl = getUserPhotoUrl(userData);

  if (userAvatarFallback) {
    setTextOrValue(userAvatarFallback, initial);
    userAvatarFallback.classList.toggle("d-none", !!photoUrl);
  }

  if (!userAvatar) return;

  if (userAvatarImg) {
    if (photoUrl) {
      userAvatarImg.src = photoUrl;
      userAvatarImg.alt = safeUsername ? `${safeUsername} profile photo` : "User profile photo";
      userAvatarImg.classList.remove("d-none");
      userAvatar.classList.add("has-photo");
      return;
    }

    userAvatarImg.classList.add("d-none");
    userAvatarImg.removeAttribute("src");
  }

  userAvatar.classList.remove("has-photo");
  if (!userAvatarImg && !userAvatarFallback) {
    userAvatar.textContent = initial;
  }
}

async function uploadProfilePhoto(file) {
  const validationMessage = validateProfilePhoto(file);
  if (validationMessage) {
    setProfilePhotoHint(validationMessage, true);
    alert(validationMessage);
    return;
  }

  const userId = await ensureUserDocId();
  if (!userId) {
    setProfilePhotoHint("Unable to load account. Please refresh and try again.", true);
    alert("Unable to load account. Please refresh and try again.");
    return;
  }

  const username = String(currentUserData?.username || currentUserData?.name || getUsername() || "").trim();

  setProfileUploadButtonLoading(true);
  setProfilePhotoHint("Uploading photo...", false);

  try {
    const downloadUrl = await uploadImageToCloudinary(file);

    await updateDoc(doc(db, "users", userId), {
      profileImage: downloadUrl,
      photo: downloadUrl,
      avatarUrl: downloadUrl,
      photoURL: downloadUrl,
      updatedAt: Date.now()
    });

    if (!currentUserData) currentUserData = {};
    currentUserData.profileImage = downloadUrl;
    currentUserData.photo = downloadUrl;
    currentUserData.avatarUrl = downloadUrl;
    currentUserData.photoURL = downloadUrl;

    applyAvatarToUI(currentUserData, username || getUsername());
    writeUserSummaryCache({
      username: currentUserData.username || username || getUsername(),
      email: currentUserData.email || "",
      balance: currentUserData.balance || 0,
      extraProfit: currentUserData.extraProfit || 0,
      discount: currentUserData.discount || 0,
      timezone: currentUserData.timezone || "Asia/Kolkata",
      whatsapp: currentUserData.whatsapp || "",
      profileImage: downloadUrl,
      photo: downloadUrl
    });
    try {
      localStorage.removeItem("panel_user_leaderboard_v2");
      localStorage.removeItem("panel_user_leaderboard_v3");
    } catch {
      // Ignore storage errors.
    }

    setProfilePhotoHint("Photo uploaded successfully.", false);
    alert("Profile photo updated.");
  } catch (error) {
    console.error("Profile photo upload failed:", error);
    const errMsg = getProfileUploadErrorMessage(error);
    setProfilePhotoHint(errMsg, true);
    alert(errMsg);
  } finally {
    setProfileUploadButtonLoading(false);
  }
}

function applyApiToUI(apiKey = "", forceHide = false) {
  currentApiKey = String(apiKey || "").trim();
  if (forceHide) isApiKeyVisible = false;

  setTextOrValue(apiUrlPreview, getApiUrl());
  setTextOrValue(apiKeyPreview, isApiKeyVisible ? (currentApiKey || "Not available") : maskApiKey(currentApiKey));

  if (btnToggleApiKey) {
    btnToggleApiKey.disabled = !currentApiKey;
    btnToggleApiKey.innerHTML = isApiKeyVisible
      ? '<i class="bi bi-eye-slash me-1"></i> Hide'
      : '<i class="bi bi-eye me-1"></i> Show';
  }
  if (btnCopyApiKey) btnCopyApiKey.disabled = !currentApiKey;
}

function syncPasswordToggleButton(buttonEl, inputEl) {
  if (!buttonEl || !inputEl) return;
  const isVisible = inputEl.type === "text";
  buttonEl.setAttribute("aria-pressed", isVisible ? "true" : "false");
  buttonEl.setAttribute("aria-label", isVisible ? "Hide password" : "Show password");
  buttonEl.innerHTML = isVisible
    ? '<i class="bi bi-eye-slash"></i>'
    : '<i class="bi bi-eye"></i>';
}

function togglePasswordInputVisibility(buttonEl) {
  const targetId = buttonEl?.getAttribute("data-password-target");
  const inputEl = targetId ? document.getElementById(targetId) : null;
  if (!inputEl) return;

  inputEl.type = inputEl.type === "password" ? "text" : "password";
  syncPasswordToggleButton(buttonEl, inputEl);
}

function applyCurrentPasswordToUI(userData = {}) {
  if (!currentPasswordInput) return;

  const legacyPassword = getLegacyPassword(userData);
  currentPasswordInput.value = legacyPassword;
  currentPasswordInput.type = legacyPassword ? "text" : "password";

  const toggleButton = document.querySelector('[data-password-target="currentPasswordInput"]');
  syncPasswordToggleButton(toggleButton, currentPasswordInput);
}

function applyPasswordToUI(userData = {}, forceHide = false) {
  const hasPassword = hasPasswordRecord(userData);
  const legacyPassword = getLegacyPassword(userData);
  const securePassword = hasSecurePasswordRecord(userData);
  if (forceHide) isPasswordVisible = false;

  if (passwordPreview) {
    if (!hasPassword) {
      setTextOrValue(passwordPreview, "Not set");
    } else if (legacyPassword) {
      setTextOrValue(passwordPreview, isPasswordVisible ? legacyPassword : maskPassword(legacyPassword));
    } else {
      setTextOrValue(passwordPreview, "Password saved securely");
    }
  }

  if (btnTogglePassword) {
    btnTogglePassword.disabled = !hasPassword || securePassword;
    btnTogglePassword.setAttribute("aria-pressed", isPasswordVisible && !securePassword ? "true" : "false");
    btnTogglePassword.setAttribute(
      "aria-label",
      securePassword
        ? "Password is stored securely and cannot be revealed"
        : (isPasswordVisible ? "Hide password" : "Show password")
    );
    btnTogglePassword.title = securePassword
      ? "Password is stored securely and can't be revealed"
      : "Toggle password visibility";
    btnTogglePassword.innerHTML = securePassword
      ? '<i class="bi bi-shield-lock"></i>'
      : (isPasswordVisible
        ? '<i class="bi bi-eye-slash"></i>'
        : '<i class="bi bi-eye"></i>');
  }
}

function getUserTimezone(data = {}) {
  const raw = String(data.timezone || "").trim();
  return raw || "Asia/Kolkata";
}

function ensureTimezoneOption(value) {
  if (!timezoneSelect || !value) return;
  const exists = Array.from(timezoneSelect.options).some((opt) => opt.value === value);
  if (exists) return;
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = value;
  timezoneSelect.appendChild(opt);
}

function applyTimezoneToUI(timezone) {
  if (!timezoneSelect) return;
  const tz = String(timezone || "").trim() || "Asia/Kolkata";
  ensureTimezoneOption(tz);
  timezoneSelect.value = tz;
}

function generateApiKey() {
  const bytes = new Uint8Array(20);
  if (window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  const base = Array.from(bytes, (b) => (b % 36).toString(36)).join("");
  return `gk_${base}`;
}

function applyUserToUI(userData = {}) {
  const username = String(userData.username || "").trim();
  const email = String(userData.email || "").trim();
  const apiKey = getApiKeyFromData(userData);
  const timezone = getUserTimezone(userData);
  const hasBalance =
    userData.balance !== undefined &&
    userData.balance !== null &&
    String(userData.balance).trim() !== "";

  if (userNameDisplay) setTextOrValue(userNameDisplay, username);
  if (userEmailDisplay) setTextOrValue(userEmailDisplay, email);
  if (userBalanceDisplay) setTextOrValue(userBalanceDisplay, hasBalance ? formatINR(userData.balance) : "");
  applyAvatarToUI(userData, username);
  setTextOrValue(usernamePreview, username);
  setTextOrValue(emailPreview, email);
  applyApiToUI(apiKey, true);
  applyTimezoneToUI(timezone);
  applyCurrentPasswordToUI(userData);
  applyPasswordToUI(userData, true);
}

function clearHashIfAny() {
  if (!window.location.hash) return;
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

function openModalById(id) {
  const modalEl = document.getElementById(id);
  if (!modalEl || !window.bootstrap?.Modal) return;
  const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  modal.show();
}

async function performLogout() {
  localStorage.removeItem(USERNAME_KEY);
  localStorage.removeItem("smmGrowthRemember");
  sessionStorage.removeItem(USERNAME_KEY);

  try {
    await signOut(auth);
  } catch (err) {
    console.warn("Firebase sign-out failed:", err);
  }
  window.location.href = "/index.html";
}

function handleHashActions() {
  const hash = (window.location.hash || "").toLowerCase();
  if (!hash) return;

  if (hash === "#whatsapp") {
    openModalById("whatsappModal");
    clearHashIfAny();
    return;
  }

  if (hash === "#security") {
    openModalById("securityModal");
    clearHashIfAny();
    return;
  }

  if (hash === "#logout") {
    performLogout();
  }
}

async function loadUserData() {
  const username = getUsername();
  if (!username) {
    window.location.href = "/index.html";
    return;
  }

  const cachedSummary = readCache(getUserSummaryCacheKey(username), {
    maxAgeMs: CacheTTL.userSummary
  });
  if (cachedSummary) {
    applyUserToUI({
      username: cachedSummary.username || "",
      email: cachedSummary.email || "",
      balance: cachedSummary.balance,
      apiKey: "",
      timezone: cachedSummary.timezone || "Asia/Kolkata",
      profileImage: cachedSummary.profileImage || cachedSummary.photo || ""
    });

    if (cachedSummary.whatsapp) {
      setTextOrValue(displayWhatsAppStatus, cachedSummary.whatsapp);
      if (whatsappInput) whatsappInput.value = cachedSummary.whatsapp;
    } else {
      setTextOrValue(displayWhatsAppStatus, "");
    }
  }

  try {
    let userDoc = null;
    const fastSummary = await fetchUserSummaryFast(username, { forceRefresh: false });
    const fastDocId = String(fastSummary?.id || "").trim();

    if (fastDocId) {
      const fastSnap = await getDoc(doc(db, "users", fastDocId));
      if (fastSnap.exists()) {
        userDoc = fastSnap;
      }
    }

    if (!userDoc) {
      const q = query(collection(db, "users"), where("username", "==", username), limit(1));
      const snapshot = await getDocs(q);
      if (!snapshot.empty) {
        userDoc = snapshot.docs[0];
      }
    }

    if (userDoc) {
      currentUserDocId = userDoc.id;
      currentUserData = userDoc.data();

      applyUserToUI({
        username: String(currentUserData.username || currentUserData.name || "").trim(),
        email: String(currentUserData.email || "").trim(),
        balance: currentUserData.balance,
        apiKey: getApiKeyFromData(currentUserData),
        timezone: currentUserData.timezone || "Asia/Kolkata",
        profileImage: getUserPhotoUrl(currentUserData),
        photo: getUserPhotoUrl(currentUserData),
      });

      writeUserSummaryCache({
        username: String(currentUserData.username || currentUserData.name || "").trim(),
        email: String(currentUserData.email || "").trim(),
        balance: currentUserData.balance || 0,
        extraProfit: currentUserData.extraProfit || 0,
        discount: currentUserData.discount || 0,
        timezone: currentUserData.timezone || "Asia/Kolkata",
        whatsapp: currentUserData.whatsapp || "",
        profileImage: getUserPhotoUrl(currentUserData),
        photo: getUserPhotoUrl(currentUserData)
      });

      if (currentUserData.whatsapp) {
        setTextOrValue(displayWhatsAppStatus, currentUserData.whatsapp);
        if (whatsappInput) whatsappInput.value = currentUserData.whatsapp;
      } else {
        setTextOrValue(displayWhatsAppStatus, "");
      }
    }
  } catch (error) {
    console.error("Load Error:", error);
  }
}

async function ensureUserDocId() {
  if (currentUserDocId) return currentUserDocId;
  await loadUserData();
  return currentUserDocId;
}

if (btnSaveWhatsApp) {
  btnSaveWhatsApp.addEventListener("click", async () => {
    const newNumber = whatsappInput?.value?.trim() || "";
    if (!newNumber || newNumber.length < 10) {
      alert("Please enter a valid WhatsApp number.");
      return;
    }

    const originalBtnText = btnSaveWhatsApp.innerHTML;
    btnSaveWhatsApp.innerHTML = "Saving...";
    btnSaveWhatsApp.disabled = true;

    try {
      const userId = await ensureUserDocId();
      if (!userId) {
        alert("User not loaded yet. Please reload and try again.");
        return;
      }

      await updateDoc(doc(db, "users", userId), { whatsapp: newNumber });
      if (!currentUserData) currentUserData = {};
      currentUserData.whatsapp = newNumber;
      writeUserSummaryCache({
        username: currentUserData.username || getUsername(),
        email: currentUserData.email || "",
        balance: currentUserData.balance || 0,
        extraProfit: currentUserData.extraProfit || 0,
        discount: currentUserData.discount || 0,
        timezone: currentUserData.timezone || "Asia/Kolkata",
        whatsapp: newNumber,
        profileImage: getUserPhotoUrl(currentUserData),
        photo: getUserPhotoUrl(currentUserData)
      });

      setTextOrValue(displayWhatsAppStatus, newNumber);

      const modalEl = document.getElementById("whatsappModal");
      const modalInstance = modalEl ? bootstrap.Modal.getInstance(modalEl) : null;
      if (modalInstance) modalInstance.hide();

      alert("WhatsApp number saved successfully!");
    } catch (error) {
      console.error("Update Error:", error);
      alert("Failed to save number.");
    } finally {
      btnSaveWhatsApp.innerHTML = originalBtnText;
      btnSaveWhatsApp.disabled = false;
    }
  });
}

if (btnUploadPhoto && profilePhotoInput) {
  btnUploadPhoto.addEventListener("click", () => {
    profilePhotoInput.click();
  });

  profilePhotoInput.addEventListener("change", async (event) => {
    const selectedFile = event?.target?.files?.[0] || null;
    profilePhotoInput.value = "";
    if (!selectedFile) return;
    await uploadProfilePhoto(selectedFile);
  });
}

if (btnCopyApiKey) {
  btnCopyApiKey.addEventListener("click", async () => {
    if (!currentApiKey) {
      alert("API key not available.");
      return;
    }

    const originalLabel = btnCopyApiKey.innerHTML;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(currentApiKey);
      } else {
        const temp = document.createElement("textarea");
        temp.value = currentApiKey;
        document.body.appendChild(temp);
        temp.select();
        document.execCommand("copy");
        temp.remove();
      }
      btnCopyApiKey.innerHTML = '<i class="bi bi-check2 me-1"></i> Copied';
      setTimeout(() => {
        btnCopyApiKey.innerHTML = originalLabel;
      }, 1400);
    } catch (error) {
      console.error("Copy API key failed:", error);
      alert("Unable to copy API key.");
    }
  });
}

if (btnToggleApiKey) {
  btnToggleApiKey.addEventListener("click", () => {
    if (!currentApiKey) return;
    isApiKeyVisible = !isApiKeyVisible;
    applyApiToUI(currentApiKey, false);
  });
}

if (btnGenerateApiKey) {
  btnGenerateApiKey.addEventListener("click", async () => {
    if (!confirm("Generate new API key? Old key will stop working.")) return;

    const original = btnGenerateApiKey.innerHTML;
    try {
      btnGenerateApiKey.disabled = true;
      btnGenerateApiKey.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Generating...';

      const userId = await ensureUserDocId();
      if (!userId) {
        alert("Unable to load account. Please refresh and try again.");
        return;
      }

      const newKey = generateApiKey();
      await updateDoc(doc(db, "users", userId), {
        apiKey: newKey,
        updatedAt: Date.now(),
      });

      if (!currentUserData) currentUserData = {};
      currentUserData.apiKey = newKey;
      applyApiToUI(newKey, true);
      alert("New API key generated successfully.");
    } catch (error) {
      console.error("Generate API key failed:", error);
      alert("Failed to generate API key.");
    } finally {
      btnGenerateApiKey.disabled = false;
      btnGenerateApiKey.innerHTML = original;
    }
  });
}

if (btnTogglePassword) {
  btnTogglePassword.addEventListener("click", () => {
    if (!hasPasswordRecord(currentUserData || {})) return;
    if (hasSecurePasswordRecord(currentUserData || {})) return;
    isPasswordVisible = !isPasswordVisible;
    applyPasswordToUI(currentUserData || {}, false);
  });
}

passwordToggleButtons.forEach((buttonEl) => {
  const targetId = buttonEl.getAttribute("data-password-target");
  const inputEl = targetId ? document.getElementById(targetId) : null;
  if (!inputEl) return;
  syncPasswordToggleButton(buttonEl, inputEl);
  buttonEl.addEventListener("click", () => togglePasswordInputVisibility(buttonEl));
});

if (timezoneForm) {
  timezoneForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const timezone = String(timezoneSelect?.value || "").trim();
    if (!timezone) {
      alert("Please select timezone.");
      return;
    }

    const original = btnSaveTimezone?.innerHTML || "Change Timezone";
    try {
      if (btnSaveTimezone) {
        btnSaveTimezone.disabled = true;
        btnSaveTimezone.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Saving...';
      }

      const userId = await ensureUserDocId();
      if (!userId) {
        alert("Unable to load account. Please refresh and try again.");
        return;
      }

      await updateDoc(doc(db, "users", userId), { timezone, updatedAt: Date.now() });
      if (!currentUserData) currentUserData = {};
      currentUserData.timezone = timezone;
      writeUserSummaryCache({
        username: currentUserData.username || getUsername(),
        email: currentUserData.email || "",
        balance: currentUserData.balance || 0,
        extraProfit: currentUserData.extraProfit || 0,
        discount: currentUserData.discount || 0,
        timezone,
        whatsapp: currentUserData.whatsapp || "",
        profileImage: getUserPhotoUrl(currentUserData),
        photo: getUserPhotoUrl(currentUserData)
      });
      applyTimezoneToUI(timezone);
      alert("Timezone updated.");
    } catch (error) {
      console.error("Timezone update failed:", error);
      alert("Failed to update timezone.");
    } finally {
      if (btnSaveTimezone) {
        btnSaveTimezone.disabled = false;
        btnSaveTimezone.innerHTML = original;
      }
    }
  });
}

if (passwordChangeForm) {
  passwordChangeForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const currentInput = String(currentPasswordInput?.value || "").trim();
    const nextPassword = String(newPasswordInput?.value || "").trim();
    const confirmPassword = String(confirmPasswordInput?.value || "").trim();
    const hasSavedPassword = hasPasswordRecord(currentUserData || {});

    if (hasSavedPassword) {
      const currentPasswordOk = await verifyPasswordRecord(currentInput, currentUserData || {});
      if (!currentPasswordOk) {
        alert("Current password is incorrect.");
        return;
      }
    }

    if (!nextPassword || nextPassword.length < 6) {
      alert("New password must be at least 6 characters.");
      return;
    }

    if (nextPassword !== confirmPassword) {
      alert("New password and confirm password do not match.");
      return;
    }

    const originalLabel = btnChangePassword?.innerHTML || "Update Password";

    try {
      if (btnChangePassword) {
        btnChangePassword.disabled = true;
        btnChangePassword.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Updating...';
      }

      const userId = await ensureUserDocId();
      if (!userId) {
        alert("Unable to find your account. Please reload and try again.");
        return;
      }

      const passwordRecord = await createPasswordRecord(nextPassword);
      await updateDoc(doc(db, "users", userId), {
        ...passwordRecord,
        password: deleteField(),
        updatedAt: Date.now()
      });

      if (!currentUserData) currentUserData = {};
      Object.assign(currentUserData, passwordRecord);
      delete currentUserData.password;

      if (currentPasswordInput) currentPasswordInput.value = "";
      if (newPasswordInput) newPasswordInput.value = "";
      if (confirmPasswordInput) confirmPasswordInput.value = "";

      isPasswordVisible = false;
      applyPasswordToUI(currentUserData || {}, true);
      alert("Password updated successfully.");
    } catch (error) {
      console.error("Password update failed:", error);
      alert("Failed to update password. Please try again.");
    } finally {
      if (btnChangePassword) {
        btnChangePassword.disabled = false;
        btnChangePassword.innerHTML = originalLabel;
      }
    }
  });
}

if (btnLogout) {
  btnLogout.addEventListener("click", performLogout);
}

function initAccount() {
  setProfilePhotoHint(PROFILE_PHOTO_HINT_DEFAULT, false);

  if (userAvatarImg) {
    userAvatarImg.addEventListener("error", () => {
      userAvatarImg.classList.add("d-none");
      userAvatarImg.removeAttribute("src");
      if (userAvatar) userAvatar.classList.remove("has-photo");
      if (userAvatarFallback) userAvatarFallback.classList.remove("d-none");
    });
  }

  applyUserToUI({});
  setTextOrValue(displayWhatsAppStatus, "");
  loadUserData();
  setTimeout(handleHashActions, 0);
  window.addEventListener("hashchange", handleHashActions);
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initAccount);
} else {
  initAccount();
}
