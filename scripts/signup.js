import { auth, createUserWithEmailAndPassword } from "./firebase.js";
import { db } from "./firebase.js";
import { createPasswordRecord } from "./password-utils.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  setDoc,
  where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const existingUser = localStorage.getItem("smmGrowthUser");
if (existingUser) {
  window.location.replace("/userpanel/neworder.html");
}

const signupForm = document.getElementById("signupForm");
const suUsername = document.getElementById("suUsername");
const suName = document.getElementById("suName");
const suEmail = document.getElementById("suEmail");
const suWhatsapp = document.getElementById("suWhatsapp");
const suPassword = document.getElementById("suPassword");
const suConfirmPassword = document.getElementById("suConfirmPassword");
const suTerms = document.getElementById("suTerms");
const suSubmit = document.getElementById("suSubmit");
const signupError = document.getElementById("signupError");
const availabilityCache = new Map();

function showError(message) {
  if (!signupError) return;
  signupError.textContent = message;
  signupError.style.display = "block";
}

function clearError() {
  if (!signupError) return;
  signupError.textContent = "";
  signupError.style.display = "none";
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeWhatsapp(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidWhatsapp(phone) {
  return /^\+?[0-9]{10,15}$/.test(phone);
}

function normalizeAmount(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Number(amount.toFixed(2));
}

async function getNewUserTestBalance() {
  try {
    const snap = await getDoc(doc(db, "meta", "panel_settings"));
    if (!snap.exists()) return 0;
    return normalizeAmount(snap.data()?.newUserTestBalance);
  } catch (err) {
    console.warn("New user test balance load failed:", err);
    return 0;
  }
}

async function checkUserExistsByUsername(username) {
  const key = `u:${username}`;
  if (availabilityCache.has(key)) return availabilityCache.get(key);

  const usernameQuery = query(collection(db, "users"), where("username", "==", username), limit(1));
  const snap = await getDocs(usernameQuery);
  const exists = !snap.empty;
  availabilityCache.set(key, exists);
  return exists;
}

async function checkUserExistsByEmail(emailLower) {
  const key = `e:${emailLower}`;
  if (availabilityCache.has(key)) return availabilityCache.get(key);

  const emailQuery = query(collection(db, "users"), where("emailLower", "==", emailLower), limit(1));
  const snap = await getDocs(emailQuery);
  if (!snap.empty) {
    availabilityCache.set(key, true);
    return true;
  }

  const emailFallback = query(collection(db, "users"), where("email", "==", emailLower), limit(1));
  const snapFallback = await getDocs(emailFallback);
  const exists = !snapFallback.empty;
  availabilityCache.set(key, exists);
  return exists;
}

async function createUserProfile(credUser, payload) {
  const [passwordRecord, startingBalance] = await Promise.all([
    createPasswordRecord(payload.password),
    getNewUserTestBalance()
  ]);

  await setDoc(doc(db, "users", credUser.uid), {
    uid: credUser.uid,
    username: payload.username,
    name: payload.name,
    email: payload.email,
    emailLower: payload.email,
    whatsapp: payload.whatsapp,
    ...passwordRecord,
    balance: startingBalance,
    authProvider: "password",
    createdAt: Date.now(),
    updatedAt: Date.now()
  }, { merge: true });
}

if (signupForm) {
  signupForm.addEventListener("input", clearError);

  suUsername?.addEventListener("input", () => {
    const cursor = suUsername.selectionStart;
    suUsername.value = normalizeUsername(suUsername.value);
    if (typeof cursor === "number") suUsername.setSelectionRange(cursor, cursor);
  });

  suWhatsapp?.addEventListener("input", () => {
    suWhatsapp.value = String(suWhatsapp.value || "").replace(/[^\d+]/g, "");
  });

  suEmail?.addEventListener("blur", () => {
    suEmail.value = normalizeEmail(suEmail.value);
  });

  signupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError();

    const username = normalizeUsername(suUsername?.value);
    const name = String(suName?.value || "").trim();
    const email = normalizeEmail(suEmail?.value);
    const whatsapp = normalizeWhatsapp(suWhatsapp?.value);
    const password = String(suPassword?.value || "").trim();
    const confirmPassword = String(suConfirmPassword?.value || "").trim();
    const termsAccepted = !!suTerms?.checked;

    if (!username || !name || !email || !whatsapp || !password || !confirmPassword) {
      showError("Please fill all fields.");
      return;
    }
    if (!/^[a-z0-9_]{3,30}$/.test(username)) {
      showError("Username must be 3-30 chars with lowercase letters, numbers, or underscore.");
      return;
    }
    if (!isValidEmail(email)) {
      showError("Please enter a valid email.");
      return;
    }
    if (!isValidWhatsapp(whatsapp)) {
      showError("Please enter a valid WhatsApp number.");
      return;
    }
    if (password.length < 6) {
      showError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirmPassword) {
      showError("Password and confirm password do not match.");
      return;
    }
    if (!termsAccepted) {
      showError("Please accept terms of service.");
      return;
    }

    const originalText = suSubmit?.textContent || "Sign up";

    try {
      if (suSubmit) {
        suSubmit.disabled = true;
        suSubmit.textContent = "Creating account...";
      }

      const [usernameTaken, emailTaken] = await Promise.all([
        checkUserExistsByUsername(username),
        checkUserExistsByEmail(email)
      ]);

      if (usernameTaken) {
        showError("Username already exists. Please choose another.");
        return;
      }
      if (emailTaken) {
        showError("Email already exists. Please use another email.");
        return;
      }

      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await createUserProfile(cred.user, {
        username,
        name,
        email,
        whatsapp,
        password
      });

      localStorage.setItem("smmGrowthUser", username);
      localStorage.setItem("smmGrowthRemember", "1");
      window.location.href = "/userpanel/neworder.html";
    } catch (err) {
      console.error("Signup error:", err);
      if (err?.code === "auth/email-already-in-use") {
        showError("Email already exists. Please use another email.");
      } else if (err?.code === "auth/invalid-email") {
        showError("Invalid email format.");
      } else if (err?.code === "auth/weak-password") {
        showError("Weak password. Use at least 6 characters.");
      } else {
        showError("Signup failed. Please try again.");
      }
    } finally {
      if (suSubmit) {
        suSubmit.disabled = false;
        suSubmit.textContent = originalText;
      }
    }
  });
}
