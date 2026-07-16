import { db } from "./firebase.js";
import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  requireAdminAuth,
  initAdminSidebar,
  bindAdminLogout
} from "./admin-ui-common.js";

requireAdminAuth();
initAdminSidebar();
bindAdminLogout("btnLogout");

const form = document.getElementById("cashTypeForm");
const saveStatus = document.getElementById("saveStatus");
const btnSave = document.getElementById("btnSaveSettings");

const manualUpiIdInput = document.getElementById("manualUpiId");
const manualUpiNameInput = document.getElementById("manualUpiName");
const manualGmailImapUserInput = document.getElementById("manualGmailImapUser");
const manualGmailImapAppPasswordInput = document.getElementById("manualGmailImapAppPassword");
const autoUpiIdInput = document.getElementById("autoUpiId");
const autoUpiNameInput = document.getElementById("autoUpiName");
const autoGmailImapUserInput = document.getElementById("autoGmailImapUser");
const autoGmailImapAppPasswordInput = document.getElementById("autoGmailImapAppPassword");

function setStatus(msg, tone = "muted") {
  if (!saveStatus) return;
  saveStatus.className = `small text-${tone}`;
  saveStatus.textContent = msg || "";
}

async function loadSettings() {
  setStatus("Loading...", "secondary");
  try {
    const snap = await getDoc(doc(db, "meta", "auto_payment_settings"));
    if (snap.exists()) {
      const data = snap.data() || {};
      const manual = data.manual || {};
      const auto = data.auto || {};

      if (manualUpiIdInput) {
        manualUpiIdInput.value = manual.upiId || data.manualUpiId || data.upiId || "";
      }
      if (manualUpiNameInput) {
        manualUpiNameInput.value = manual.upiName || data.manualUpiName || data.upiName || "";
      }
      if (manualGmailImapUserInput) {
        manualGmailImapUserInput.value =
          manual.gmailImapUser || data.manualGmailImapUser || "";
      }
      if (manualGmailImapAppPasswordInput) {
        manualGmailImapAppPasswordInput.value =
          manual.gmailImapAppPassword || data.manualGmailImapAppPassword || "";
      }

      if (autoUpiIdInput) {
        autoUpiIdInput.value = auto.upiId || data.autoUpiId || data.upiId || "";
      }
      if (autoUpiNameInput) {
        autoUpiNameInput.value = auto.upiName || data.autoUpiName || data.upiName || "";
      }

      if (autoGmailImapUserInput) {
        autoGmailImapUserInput.value = auto.gmailImapUser || data.gmailImapUser || "";
      }
      if (autoGmailImapAppPasswordInput) {
        autoGmailImapAppPasswordInput.value =
          auto.gmailImapAppPassword || data.gmailImapAppPassword || "";
      }
    }
    setStatus("Settings loaded.", "muted");
  } catch (e) {
    console.error("loadSettings:", e);
    setStatus("Failed to load settings.", "danger");
  }
}

document.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-password-toggle='true']");
  if (!btn) return;

  event.preventDefault();
  const targetId = String(btn.getAttribute("data-password-target") || "").trim();
  if (!targetId) return;

  const input = document.getElementById(targetId);
  if (!input) return;

  const isHidden = input.type === "password";
  input.type = isHidden ? "text" : "password";
  btn.innerHTML = isHidden
    ? '<i class="bi bi-eye-slash"></i>'
    : '<i class="bi bi-eye"></i>';
});

if (form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setStatus("");

    const manualUpiId = String(manualUpiIdInput?.value || "").trim();
    const manualUpiName = String(manualUpiNameInput?.value || "").trim();
    const manualGmailImapUser = String(manualGmailImapUserInput?.value || "").trim();
    const manualGmailImapAppPassword = String(manualGmailImapAppPasswordInput?.value || "")
      .trim()
      .replace(/\s+/g, "");

    const autoUpiId = String(autoUpiIdInput?.value || "").trim();
    const autoUpiName = String(autoUpiNameInput?.value || "").trim();
    const gmailImapUser = String(autoGmailImapUserInput?.value || "").trim();
    const gmailImapAppPassword = String(autoGmailImapAppPasswordInput?.value || "")
      .trim()
      .replace(/\s+/g, "");

    if (!manualUpiId) {
      setStatus("Manual UPI ID is required.", "danger");
      return;
    }
    if (!autoUpiId) {
      setStatus("Auto UPI ID is required.", "danger");
      return;
    }

    if (btnSave) btnSave.disabled = true;
    setStatus("Saving...", "secondary");
    try {
      await setDoc(
        doc(db, "meta", "auto_payment_settings"),
        {
          manual: {
            upiId: manualUpiId,
            upiName: manualUpiName,
            gmailImapUser: manualGmailImapUser,
            gmailImapAppPassword: manualGmailImapAppPassword,
          },
          auto: {
            upiId: autoUpiId,
            upiName: autoUpiName,
            gmailImapUser,
            gmailImapAppPassword,
          },
          manualUpiId,
          manualUpiName,
          manualGmailImapUser,
          manualGmailImapAppPassword,
          autoUpiId,
          autoUpiName,
          upiId: autoUpiId,
          upiName: autoUpiName,
          gmailImapUser,
          gmailImapAppPassword,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      setStatus("Saved successfully.", "success");
    } catch (err) {
      console.error("saveSettings:", err);
      setStatus("Save failed. Check console.", "danger");
    } finally {
      if (btnSave) btnSave.disabled = false;
    }
  });
}

loadSettings();
