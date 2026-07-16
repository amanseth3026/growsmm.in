import { firebaseConfig } from "./firebase.js";
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getMessaging, getToken, onMessage } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js";

const PUSH_TOPIC = "growsmm_offers";
const DEFAULT_TARGET_URL = "/userpanel/neworder.html";
const STORAGE_KEYS = {
  token: "smmPushToken",
  enabled: "smmPushEnabled",
  dismissed: "smmPushPromptDismissed"
};

let initPromise = null;
let foregroundListenerBound = false;

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function getCurrentUsername() {
  return normalizeUsername(
    safeReadStorage("smmGrowthUser") ||
    safeReadSessionStorage("smmGrowthUser") ||
    ""
  );
}

function safeReadStorage(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function safeWriteStorage(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Ignore storage failures; push can still work for this session.
  }
}

function safeReadSessionStorage(key) {
  try {
    return sessionStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function supportsPush() {
  return typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof Notification !== "undefined" &&
    "serviceWorker" in navigator;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeTargetUrl(raw) {
  const target = String(raw || "").trim();
  if (!target) return DEFAULT_TARGET_URL;
  if (/^https?:\/\//i.test(target)) return target;
  if (target.startsWith("/")) return target;
  if (target.startsWith("wa.me/")) return `https://${target}`;
  if (target.startsWith("www.")) return `https://${target}`;
  if (target.includes("/")) return `/${target.replace(/^\/+/, "")}`;
  if (target.includes(".")) return `https://${target}`;
  return `/${target.replace(/^\/+/, "")}`;
}

function ensureToastHost() {
  let host = document.getElementById("smmPushToastHost");
  if (host) return host;

  host = document.createElement("div");
  host.id = "smmPushToastHost";
  host.style.position = "fixed";
  host.style.right = "16px";
  host.style.bottom = "16px";
  host.style.zIndex = "3500";
  host.style.display = "grid";
  host.style.gap = "10px";
  host.style.width = "min(360px, calc(100vw - 32px))";
  document.body.appendChild(host);
  return host;
}

function showToast({ title, body, ctaLabel = "Open", ctaUrl = DEFAULT_TARGET_URL, tone = "info" } = {}) {
  const host = ensureToastHost();
  const card = document.createElement("div");
  const safeCtaUrl = normalizeTargetUrl(ctaUrl);
  const accent =
    tone === "success" ? "linear-gradient(135deg, #16a34a, #0f766e)" :
    tone === "warning" ? "linear-gradient(135deg, #f59e0b, #ea580c)" :
    tone === "error" ? "linear-gradient(135deg, #ef4444, #b91c1c)" :
    "linear-gradient(135deg, #1d4ed8, #7c3aed)";

  card.style.background = "rgba(255,255,255,0.96)";
  card.style.border = "1px solid rgba(226,232,240,0.85)";
  card.style.borderLeft = `6px solid transparent`;
  card.style.borderImage = `${accent} 1`;
  card.style.borderRadius = "18px";
  card.style.boxShadow = "0 18px 42px rgba(15,23,42,0.18)";
  card.style.padding = "14px";
  card.style.backdropFilter = "blur(16px)";
  card.innerHTML = `
    <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px;">
      <div style="min-width:0;">
        <div style="font-weight:800; color:#0f172a; font-size:0.98rem; line-height:1.25;">${escapeHtml(title || "GrowSMM")}</div>
        <div style="color:#475569; font-size:0.88rem; line-height:1.55; margin-top:4px;">${escapeHtml(body || "New update available.")}</div>
      </div>
      <button type="button" aria-label="Dismiss" style="border:none; background:#f1f5f9; color:#0f172a; width:28px; height:28px; border-radius:999px; cursor:pointer; flex:0 0 auto;">&times;</button>
    </div>
    <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:12px;">
      <button type="button" style="border:1px solid #cbd5e1; background:#fff; color:#0f172a; border-radius:12px; padding:9px 12px; font-weight:800; font-size:0.85rem;">Later</button>
      <a href="${escapeHtml(safeCtaUrl)}" style="display:inline-flex; align-items:center; justify-content:center; text-decoration:none; background:#1d4ed8; color:#fff; border-radius:12px; padding:9px 12px; font-weight:800; font-size:0.85rem;">${escapeHtml(ctaLabel)}</a>
    </div>
  `;

  const close = () => {
    card.remove();
  };

  const buttons = card.querySelectorAll("button");
  if (buttons[0]) buttons[0].addEventListener("click", close);
  if (buttons[1]) buttons[1].addEventListener("click", close);

  host.prepend(card);
  window.setTimeout(close, 7000);
}

function getVapidKey() {
  const vapid = String(firebaseConfig?.messagingVapidKey || firebaseConfig?.vapidKey || "").trim();
  return vapid || "";
}

async function ensureMessagingReady() {
  if (!supportsPush()) return null;

  try {
    const app = getApp();
    const messaging = getMessaging(app);
    const registration = await navigator.serviceWorker.register("/sw.js", {
      updateViaCache: "none"
    });
    registration.update().catch(() => {});
    const options = {
      serviceWorkerRegistration: registration
    };
    const vapidKey = getVapidKey();
    if (vapidKey) options.vapidKey = vapidKey;

    return { messaging, options };
  } catch (err) {
    console.warn("FCM init failed:", err);
    return null;
  }
}

async function subscribeToken(token, username) {
  const res = await fetch("/api/push-subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      username,
      topic: PUSH_TOPIC,
      source: "web-pwa",
      userAgent: navigator.userAgent || "",
      enabled: true
    })
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    throw new Error(json?.error || "Push subscription failed");
  }

  return json;
}

function getNotificationSlot() {
  return document.querySelector("[data-push-notifications-slot], #pushNotificationsSlot");
}

function renderNotificationControl(slot, state) {
  if (!slot) return null;

  const icon = state === "enabled"
    ? "fa-solid fa-bell"
    : state === "denied"
      ? "fa-solid fa-bell-slash"
      : "fa-regular fa-bell";
  const helper =
    state === "enabled"
      ? "Browser notifications are active on this device."
      : state === "denied"
        ? "Allow notifications in browser settings to turn this on."
        : "Turn on browser notifications for order updates and announcements.";

  slot.dataset.pushState = state;

  if (state === "enabled") {
    slot.innerHTML = `
      <div class="d-flex align-items-center gap-2 flex-wrap">
        <span class="badge rounded-pill text-bg-success"><i class="${icon} me-1"></i> Notifications On</span>
        <small class="text-muted">${escapeHtml(helper)}</small>
      </div>
    `;
    return null;
  }

  slot.innerHTML = `
    <button type="button" class="btn btn-primary" data-push-notifications>
      <i class="${icon} me-1"></i> Enable Notifications
    </button>
    <small class="text-muted d-block mt-2">${escapeHtml(helper)}</small>
  `;

  return slot.querySelector("[data-push-notifications]");
}

async function bindForegroundListener(messaging) {
  if (!messaging || foregroundListenerBound) return;
  foregroundListenerBound = true;

  onMessage(messaging, () => {
    // Foreground pushes stay silent; background notifications are handled by the service worker.
  });
}

async function syncPushSubscription({ promptForPermission = false, showFeedback = true } = {}) {
  if (!supportsPush()) {
    return { ok: false, reason: "unsupported" };
  }

  const username = getCurrentUsername();
  if (!username) {
    return { ok: false, reason: "no_user" };
  }

  let permission = Notification.permission;
  if (permission !== "granted" && promptForPermission) {
    permission = await Notification.requestPermission();
  }

  if (permission !== "granted") {
    safeWriteStorage(STORAGE_KEYS.enabled, "0");
    return { ok: false, reason: permission === "denied" ? "denied" : "pending" };
  }

  const ready = await ensureMessagingReady();
  if (!ready) {
    return { ok: false, reason: "messaging_unavailable" };
  }

  await bindForegroundListener(ready.messaging);

  const tokenOptions = { ...ready.options };
  const token = await getToken(ready.messaging, tokenOptions);
  if (!token) {
    throw new Error("Could not generate a push token.");
  }

  await subscribeToken(token, username);
  safeWriteStorage(STORAGE_KEYS.token, token);
  safeWriteStorage(STORAGE_KEYS.enabled, "1");

  if (showFeedback) {
    showToast({
      title: "Notifications enabled",
      body: "Offer alerts will now reach this device.",
      ctaLabel: "Done",
      ctaUrl: DEFAULT_TARGET_URL,
      tone: "success"
    });
  }

  return { ok: true, token };
}

async function initPushNotifications() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!supportsPush()) return;

    const slot = getNotificationSlot();
    if (!slot) return;

    const permission = Notification.permission;
    if (permission === "granted") {
      renderNotificationControl(slot, "enabled");
      try {
        await syncPushSubscription({ promptForPermission: false, showFeedback: false });
      } catch (err) {
        console.warn("Push subscription refresh failed:", err);
      }
      return;
    }

    const link = renderNotificationControl(slot, permission === "denied" ? "denied" : "idle");
    if (!link) return;

    link.addEventListener("click", async (event) => {
      event.preventDefault();
      const originalHtml = link.innerHTML;
      link.disabled = true;
      link.innerHTML = '<span class="spinner-border spinner-border-sm" aria-hidden="true"></span>';
      let finalStateRendered = false;
      try {
        const result = await syncPushSubscription({ promptForPermission: true, showFeedback: true });
        if (result.ok) {
          renderNotificationControl(slot, "enabled");
          finalStateRendered = true;
          return;
        }

        if (result.reason === "denied") {
          renderNotificationControl(slot, "denied");
          finalStateRendered = true;
          showToast({
            title: "Notifications blocked",
            body: "Browser settings me notifications allow karni hongi.",
            ctaLabel: "OK",
            ctaUrl: DEFAULT_TARGET_URL,
            tone: "warning"
          });
        }
      } catch (err) {
        console.warn("Push enable failed:", err);
        showToast({
          title: "Notification setup failed",
          body: err?.message || "Please try again.",
          ctaLabel: "Close",
          ctaUrl: DEFAULT_TARGET_URL,
          tone: "error"
        });
      } finally {
        if (!finalStateRendered) {
          const currentButton = slot.querySelector("[data-push-notifications]");
          if (currentButton) {
            currentButton.disabled = false;
            currentButton.innerHTML = originalHtml;
          }
        }
      }
    });

    if (permission === "denied") return;
  })();

  return initPromise;
}

initPushNotifications().catch((err) => {
  console.warn("Push notification init error:", err);
});

export {
  initPushNotifications,
  syncPushSubscription as requestPushNotifications
};
