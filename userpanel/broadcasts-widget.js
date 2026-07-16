import { db } from "./firebase.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { CacheTTL, readCache, writeCache, broadcastsKey } from "./data-cache.js";

const stack = document.getElementById("broadcastTicker");
const popupId = "broadcastPopupOverlay";
const BROADCASTS_CACHE_KEY = broadcastsKey();

function runWhenIdle(task) {
  if (typeof task !== "function") return;
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(task, { timeout: 1200 });
  } else {
    setTimeout(task, 180);
  }
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripHtml(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html || "";
  return tmp.textContent || tmp.innerText || "";
}

function sanitizeHttpUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch {
    // ignore malformed urls
  }
  return "";
}

function sanitizeColorValue(rawColor) {
  const value = String(rawColor || "").trim();
  if (!value) return "#000000";
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return value;
  if (/^rgb(a)?\([0-9,\s.%-]+\)$/i.test(value)) return value;
  if (/^[a-z]{3,20}$/i.test(value)) return value;
  return "#000000";
}

function pickTheme(b) {
  const text = `${b.title || ""} ${b.message || ""}`.toLowerCase();
  if (text.includes("bonus") || text.includes("offer") || text.includes("special")) return "orange";
  if (text.includes("whatsapp") || text.includes("join") || text.includes("community")) return "teal";
  return Number(b.priority || 0) >= 2 ? "orange" : "teal";
}

function pickTag(b) {
  const iconType = String(b.iconType || "").toLowerCase();
  if (iconType === "info") return { icon: "bi-info-circle", label: "info" };
  if (iconType === "warning") return { icon: "bi-exclamation-triangle", label: "alert" };
  if (iconType === "success") return { icon: "bi-check-circle", label: "success" };
  if (iconType === "error") return { icon: "bi-x-circle", label: "error" };
  if (iconType === "whatsapp") return { icon: "bi-whatsapp", label: "whatsapp" };
  if (iconType === "telegram") return { icon: "bi-telegram", label: "telegram" };

  const text = `${b.title || ""} ${b.message || ""}`.toLowerCase();
  if (text.includes("whatsapp") || text.includes("community")) return { icon: "bi-whatsapp", label: "join" };
  if (text.includes("bonus") || text.includes("offer")) return { icon: "bi-gift", label: "offer" };
  return { icon: "bi-megaphone", label: "update" };
}

function findCta(b) {
  if (b.ctaUrl) {
    const safe = sanitizeHttpUrl(b.ctaUrl);
    if (safe) return { label: b.ctaLabel || "Open", url: safe };
  }
  const msg = String(b.message || "");
  const urlMatch = msg.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) {
    const label = msg.toLowerCase().includes("whatsapp") ? "Join" : "Open";
    const safe = sanitizeHttpUrl(urlMatch[0]);
    if (safe) return { label, url: safe };
  }
  if (msg.toLowerCase().includes("whatsapp")) {
    const wa = msg.match(/wa\.me\/\S+/i);
    if (wa) {
      const safe = sanitizeHttpUrl(`https://${wa[0]}`);
      if (safe) return { label: "Join", url: safe };
    }
  }
  return null;
}

function createMarqueeText(text) {
  const safe = escapeHtml(text);
  return `
    <span class="broadcast-text">${safe}</span>
    <span class="broadcast-text">${safe}</span>
    <span class="broadcast-text">${safe}</span>
  `;
}

function isDismissed(id) {
  return localStorage.getItem(`broadcast_dismissed_${id}`) === "1";
}

function markDismissed(id) {
  localStorage.setItem(`broadcast_dismissed_${id}`, "1");
}

function isPopupDismissed(id) {
  return localStorage.getItem(`broadcast_popup_dismissed_${id}`) === "1";
}

function markPopupDismissed(id) {
  localStorage.setItem(`broadcast_popup_dismissed_${id}`, "1");
}

function normalizeType(value) {
  const t = String(value || "").trim().toLowerCase();
  if (t === "broadcast" || t === "popup") return "broadcast";
  return "announcement";
}

function getCurrentPath() {
  const path = window.location.pathname || "";
  const filename = path.split("/").pop() || "";
  return { path, filename };
}

function matchesPath(b) {
  const paths = Array.isArray(b.paths) ? b.paths : [];
  if (!paths.length || paths.includes("*")) return true;
  const { path, filename } = getCurrentPath();
  return paths.includes(path) || paths.includes(filename) || paths.includes(`/${filename}`);
}

function matchesTarget(b) {
  const target = String(b.targetUsers || "all").toLowerCase();
  if (target === "logged_in") {
    return Boolean(localStorage.getItem("smmGrowthUser") || sessionStorage.getItem("smmGrowthUser"));
  }
  return true;
}

function buildPopup(b) {
  if (!b || document.getElementById(popupId)) return;
  const cta = findCta(b);
  const title = escapeHtml(b.title || "Broadcast");
  const messageHtml = escapeHtml(b.messageText || stripHtml(b.message || ""));
  const confirmText = escapeHtml(b.confirmText || "Okay!");
  const confirmColor = sanitizeColorValue(b.confirmColor || "#000000");
  const iconType = String(b.iconType || "").toLowerCase();
  const iconMap = {
    info: "bi-info-circle",
    warning: "bi-exclamation-triangle",
    success: "bi-check-circle",
    error: "bi-x-circle",
    whatsapp: "bi-whatsapp",
    telegram: "bi-telegram"
  };
  const iconClass = iconMap[iconType] || "bi-megaphone";
  const ctaMarkup = cta
    ? `<a class="broadcast-popup-cta" href="${escapeHtml(cta.url)}" target="_blank" rel="noopener">${escapeHtml(cta.label || "Open")}</a>`
    : "";

  const theme = pickTheme(b);
  const overlay = document.createElement("div");
  overlay.id = popupId;
  overlay.className = "broadcast-popup-overlay";
  overlay.innerHTML = `
    <div class="broadcast-popup theme-${theme}" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="broadcast-popup-header">
        <span class="broadcast-popup-badge">Broadcast</span>
        <button class="broadcast-popup-close" type="button" aria-label="Close popup">&times;</button>
      </div>
      <div class="broadcast-popup-body">
        <div class="broadcast-popup-title"><i class="bi ${iconClass}"></i> ${title}</div>
        <div class="broadcast-popup-message">${messageHtml}</div>
      </div>
      <div class="broadcast-popup-actions">
        ${ctaMarkup}
        <button class="broadcast-popup-dismiss" type="button" style="background:${confirmColor}; border-color:${confirmColor}; color:#fff;">${confirmText}</button>
      </div>
    </div>
  `;

  const closePopup = () => {
    markPopupDismissed(b.id);
    overlay.remove();
  };

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePopup();
  });

  const closeBtn = overlay.querySelector(".broadcast-popup-close");
  const dismissBtn = overlay.querySelector(".broadcast-popup-dismiss");
  if (closeBtn) closeBtn.addEventListener("click", closePopup);
  if (dismissBtn) {
    dismissBtn.addEventListener("click", () => {
      if (cta?.url) {
        window.open(cta.url, "_blank", "noopener");
      }
      closePopup();
    });
  }

  document.body.appendChild(overlay);
}

function renderBroadcasts(all = []) {
  const now = Date.now();
  const eligible = all.filter((b) => {
    if (b.active === false) return false;
    if (b.startAt && now < Number(b.startAt)) return false;
    if (b.endAt && now > Number(b.endAt)) return false;
    if (!matchesTarget(b)) return false;
    if (!matchesPath(b)) return false;
    return true;
  });

  const announcements = eligible.filter((b) => {
    if (normalizeType(b.type) !== "announcement") return false;
    if (isDismissed(b.id)) return false;
    return true;
  });

  const popups = eligible.filter((b) => {
    if (normalizeType(b.type) !== "broadcast") return false;
    if (isPopupDismissed(b.id)) return false;
    return true;
  });

  announcements.sort((a, b) => {
    const pa = Number(a.priority || 0);
    const pb = Number(b.priority || 0);
    if (pb !== pa) return pb - pa;
    return Number(b.createdAt || 0) - Number(a.createdAt || 0);
  });

  if (stack) {
    if (!announcements.length) {
      stack.style.display = "none";
    } else {
      stack.style.display = "flex";
      stack.innerHTML = "";

      announcements.forEach((b) => {
        const theme = pickTheme(b);
        const tag = pickTag(b);
        const cta = findCta(b);
        const safeText = b.messageText || stripHtml(b.message || "");
        const text = `${b.title || ""} ${safeText}`.trim();
        const ctaMarkup = cta
          ? `<a class="broadcast-cta" href="${escapeHtml(cta.url)}" target="_blank" rel="noopener">${escapeHtml(cta.label || "Open")}</a>`
          : "";

        const bar = document.createElement("div");
        bar.className = `broadcast-bar ${theme}`;
        bar.innerHTML = `
          <div class="broadcast-left">
            <i class="bi ${tag.icon}"></i>
            <span class="tag">${tag.label}</span>
          </div>
          <div class="broadcast-marquee">
            <div class="marquee-track">${createMarqueeText(text)}</div>
          </div>
          ${ctaMarkup}
          <button class="broadcast-close" aria-label="Close">&times;</button>
        `;

        const closeBtn = bar.querySelector(".broadcast-close");
        if (closeBtn) {
          closeBtn.addEventListener("click", () => {
            markDismissed(b.id);
            bar.remove();
            if (!stack.querySelector(".broadcast-bar")) {
              stack.style.display = "none";
            }
          });
        }

        stack.appendChild(bar);
      });
    }
  }

  if (popups.length) {
    popups.sort((a, b) => {
      const pa = Number(a.priority || 0);
      const pb = Number(b.priority || 0);
      if (pb !== pa) return pb - pa;
      return Number(b.createdAt || 0) - Number(a.createdAt || 0);
    });
    buildPopup(popups[0]);
  }
}

async function loadBroadcasts() {
  const cached = readCache(BROADCASTS_CACHE_KEY, { maxAgeMs: CacheTTL.broadcasts });
  if (Array.isArray(cached)) {
    renderBroadcasts(cached);
  }

  runWhenIdle(async () => {
    try {
      const snap = await getDocs(collection(db, "broadcasts"));
      const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      writeCache(BROADCASTS_CACHE_KEY, all);
      renderBroadcasts(all);
    } catch (err) {
      if (!Array.isArray(cached)) {
        console.error("Broadcast load failed:", err);
      }
    }
  });
}

loadBroadcasts();
