import { db } from "./firebase.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { CacheTTL, readCache, writeCache, broadcastsKey } from "./data-cache.js";

const stack = document.getElementById("broadcastsStack");
const emptyEl = document.getElementById("broadcastEmpty");
const BROADCASTS_CACHE_KEY = broadcastsKey();

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
    // ignore malformed links
  }
  return "";
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

function renderBroadcasts(all = []) {
  if (!stack) return;

  const now = Date.now();
  const active = all.filter((b) => {
    if (b.active === false) return false;
    if (b.startAt && now < Number(b.startAt)) return false;
    if (b.endAt && now > Number(b.endAt)) return false;
    if (!matchesTarget(b)) return false;
    if (!matchesPath(b)) return false;
    return true;
  });

  active.sort((a, b) => {
    const pa = Number(a.priority || 0);
    const pb = Number(b.priority || 0);
    if (pb !== pa) return pb - pa;
    return Number(b.createdAt || 0) - Number(a.createdAt || 0);
  });

  if (!active.length) {
    if (emptyEl) emptyEl.classList.remove("d-none");
    return;
  }

  if (emptyEl) emptyEl.classList.add("d-none");
  stack.innerHTML = "";

  active.forEach((b) => {
    const tag = pickTag(b);
    const cta = findCta(b);
    const safeText = b.messageText || stripHtml(b.message || "");
    const created = b.updatedAt || b.createdAt;
    const createdText = created ? new Date(Number(created.seconds ? created.seconds * 1000 : created)).toLocaleString("en-IN") : "";
    const type = normalizeType(b.type) === "broadcast" ? "Broadcast" : "Announcement";
    const ctaMarkup = cta
      ? `<a class="cta" href="${escapeHtml(cta.url)}" target="_blank" rel="noopener">${escapeHtml(cta.label || "Open")}</a>`
      : "";

    const line = document.createElement("div");
    line.className = "broadcast-line";
    line.innerHTML = `
      <div class="icon"><i class="bi ${tag.icon}"></i></div>
      <div>
        <div class="title">${escapeHtml(b.title || "Announcement")}</div>
        <div class="desc">${escapeHtml(safeText)}</div>
        ${createdText ? `<div class="meta">${escapeHtml(createdText)}</div>` : ""}
      </div>
      <div class="d-flex flex-column align-items-end gap-2">
        <span class="pill">${type}</span>
        ${ctaMarkup}
      </div>
    `;

    stack.appendChild(line);
  });
}

async function loadBroadcasts() {
  const cached = readCache(BROADCASTS_CACHE_KEY, { maxAgeMs: CacheTTL.broadcasts });
  if (Array.isArray(cached)) {
    renderBroadcasts(cached);
  }

  try {
    const snap = await getDocs(collection(db, "broadcasts"));
    const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    writeCache(BROADCASTS_CACHE_KEY, all);
    renderBroadcasts(all);
  } catch (err) {
    if (!Array.isArray(cached)) {
      console.error("Broadcast feed load failed:", err);
    }
  }
}

loadBroadcasts();
