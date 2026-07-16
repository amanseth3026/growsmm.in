import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  CacheTTL,
  readCache,
  writeCache,
  userSummaryKey
} from "./data-cache.js";
import { getActiveUsername } from "./firestore-fast.js";

const USERNAME = getActiveUsername();
const LEADERBOARD_API = "/api/user-leaderboard";
const LEADERBOARD_CACHE_KEY = "panel_user_leaderboard_v2";
const LEADERBOARD_CACHE_TTL_MS = 2 * 60 * 1000;
const USER_SUMMARY_CACHE_KEY = userSummaryKey(USERNAME);
const PERIOD_LABELS = {
  daily: "Today",
  weekly: "Last 7 Days",
  monthly: "Last 30 Days"
};

const $ = (id) => document.getElementById(id);

const userBalanceDisplay = $("userBalance");
const leaderboardList = $("leaderboardList");
const leaderboardRange = $("leaderboardRange");
const leaderboardUpdated = $("leaderboardUpdated");
const leaderboardTabs = Array.from(document.querySelectorAll("[data-leaderboard-tab]"));

let leaderboardPayload = null;
let activePeriod = "daily";

function formatInr(amount) {
  return `\u20B9${Number(amount || 0).toFixed(2)}`;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[c]));
}

function getInitials(username) {
  const raw = String(username || "").trim();
  if (!raw) return "U";

  const source = raw.includes("@") ? raw.split("@")[0] : raw;
  const cleaned = source.replace(/[_\-.]+/g, " ").trim();
  if (!cleaned) return "U";

  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (!parts.length) return "U";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
}

function formatUpdatedAt(ts) {
  const ms = Number(ts || 0);
  if (!Number.isFinite(ms) || ms <= 0) return "Updated just now";
  const diffMs = Date.now() - ms;
  if (diffMs < 60 * 1000) return "Updated just now";
  const mins = Math.floor(diffMs / (60 * 1000));
  if (mins < 60) return `Updated ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Updated ${hrs}h ago`;
  return `Updated ${Math.floor(hrs / 24)}d ago`;
}

function readLeaderboardCache() {
  try {
    const raw = localStorage.getItem(LEADERBOARD_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const expiresAt = Number(parsed?.expiresAt || 0);
    if (!expiresAt || Date.now() > expiresAt) {
      localStorage.removeItem(LEADERBOARD_CACHE_KEY);
      return null;
    }
    return parsed?.payload || null;
  } catch {
    return null;
  }
}

function writeLeaderboardCache(payload) {
  if (!payload || typeof payload !== "object") return;
  try {
    localStorage.setItem(LEADERBOARD_CACHE_KEY, JSON.stringify({
      savedAt: Date.now(),
      expiresAt: Date.now() + LEADERBOARD_CACHE_TTL_MS,
      payload
    }));
  } catch (err) {
    console.warn("Leaderboard cache write failed:", err?.message || err);
  }
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row, index) => ({
    username: String(row?.username || "").trim() || `User ${index + 1}`,
    totalAmount: Number.isFinite(Number(row?.totalAmount)) ? Number(row.totalAmount) : 0,
    orderCount: Number.isFinite(Number(row?.orderCount)) ? Number(row.orderCount) : 0,
    avatarUrl: String(row?.avatarUrl || row?.photoURL || "").trim()
  }));
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  return {
    generatedAt: Number(payload.generatedAt || Date.now()),
    daily: normalizeRows(payload.daily),
    weekly: normalizeRows(payload.weekly),
    monthly: normalizeRows(payload.monthly)
  };
}

function setLeaderboardState(text) {
  if (!leaderboardList) return;
  leaderboardList.innerHTML = `<div class="leaderboard-state">${escapeHtml(text)}</div>`;
}

function avatarMarkup(className, username, avatarUrl) {
  if (avatarUrl) {
    return `<span class="${className}"><img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(username)}"></span>`;
  }
  return `<span class="${className}">${escapeHtml(getInitials(username))}</span>`;
}

function renderPodiumCard(row, rank) {
  const rankMeta = {
    1: { icon: "bi-trophy-fill", className: "rank-1" },
    2: { icon: "bi-award-fill", className: "rank-2" },
    3: { icon: "bi-bookmark-star-fill", className: "rank-3" }
  }[rank] || { icon: "bi-star-fill", className: "" };

  if (!row) {
    return `
      <article class="leaderboard-podium-card ${rankMeta.className}">
        <i class="bi ${rankMeta.icon} leaderboard-podium-icon"></i>
        <span class="leaderboard-avatar">--</span>
        <p class="leaderboard-podium-rank">Rank #${rank}</p>
        <p class="leaderboard-podium-name">Waiting...</p>
        <p class="leaderboard-podium-orders">No orders yet</p>
        <p class="leaderboard-podium-amount">${formatInr(0)}</p>
      </article>
    `;
  }

  const safeUser = escapeHtml(row.username);
  const orders = row.orderCount > 0
    ? `${row.orderCount} order${row.orderCount > 1 ? "s" : ""}`
    : "Top buyer";

  return `
    <article class="leaderboard-podium-card ${rankMeta.className}">
      <i class="bi ${rankMeta.icon} leaderboard-podium-icon"></i>
      ${avatarMarkup("leaderboard-avatar", row.username, row.avatarUrl)}
      <p class="leaderboard-podium-rank">Rank #${rank}</p>
      <p class="leaderboard-podium-name">${safeUser}</p>
      <p class="leaderboard-podium-orders">${escapeHtml(orders)}</p>
      <p class="leaderboard-podium-amount">${formatInr(row.totalAmount)}</p>
    </article>
  `;
}

function renderRestRows(rows) {
  if (!rows.length) {
    return `
      <div class="leaderboard-rest-row">
        <span class="leaderboard-rest-rank">#4+</span>
        <div class="leaderboard-rest-user">
          <span class="leaderboard-avatar-sm">--</span>
          <div>
            <strong>No more users</strong>
            <span>Only top 3 available</span>
          </div>
        </div>
        <div class="leaderboard-rest-amount">${formatInr(0)}</div>
      </div>
    `;
  }

  return rows.map((row) => {
    const orders = row.orderCount > 0
      ? `${row.orderCount} order${row.orderCount > 1 ? "s" : ""}`
      : "Top buyer";
    return `
      <div class="leaderboard-rest-row">
        <span class="leaderboard-rest-rank">#${row.rank}</span>
        <div class="leaderboard-rest-user">
          ${avatarMarkup("leaderboard-avatar-sm", row.username, row.avatarUrl)}
          <div>
            <strong>${escapeHtml(row.username)}</strong>
            <span>${escapeHtml(orders)}</span>
          </div>
        </div>
        <div class="leaderboard-rest-amount">${formatInr(row.totalAmount)}</div>
      </div>
    `;
  }).join("");
}

function renderLeaderboard(period = activePeriod) {
  if (!leaderboardList) return;

  const safePeriod = PERIOD_LABELS[period] ? period : "daily";
  activePeriod = safePeriod;

  leaderboardTabs.forEach((tab) => {
    const tabPeriod = String(tab.getAttribute("data-leaderboard-tab") || "").trim();
    tab.classList.toggle("active", tabPeriod === safePeriod);
  });

  if (leaderboardRange) leaderboardRange.textContent = PERIOD_LABELS[safePeriod] || "Today";

  if (!leaderboardPayload) {
    setLeaderboardState("Loading leaderboard...");
    if (leaderboardUpdated) leaderboardUpdated.textContent = "Updating...";
    return;
  }

  const rows = Array.isArray(leaderboardPayload[safePeriod]) ? leaderboardPayload[safePeriod] : [];
  if (!rows.length) {
    setLeaderboardState("No buy data found for this period.");
    if (leaderboardUpdated) leaderboardUpdated.textContent = formatUpdatedAt(leaderboardPayload.generatedAt);
    return;
  }

  const topRows = [rows[0] || null, rows[1] || null, rows[2] || null];
  const restRows = rows.slice(3).map((row, index) => ({ ...row, rank: index + 4 }));

  leaderboardList.innerHTML = `
    <div class="leaderboard-top3">
      ${renderPodiumCard(topRows[0], 1)}
      ${renderPodiumCard(topRows[1], 2)}
      ${renderPodiumCard(topRows[2], 3)}
    </div>
    <div class="leaderboard-rest">
      <div class="leaderboard-rest-head">
        <span>Rank</span>
        <span>User</span>
        <span>Total Spent</span>
      </div>
      ${renderRestRows(restRows)}
    </div>
  `;

  if (leaderboardUpdated) leaderboardUpdated.textContent = formatUpdatedAt(leaderboardPayload.generatedAt);
}

function bindTabs() {
  leaderboardTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const period = String(tab.getAttribute("data-leaderboard-tab") || "").trim();
      renderLeaderboard(period);
    });
  });
}

async function loadUserSummary() {
  if (!USERNAME || !userBalanceDisplay) return;

  const cached = readCache(USER_SUMMARY_CACHE_KEY, { maxAgeMs: CacheTTL.userSummary });
  if (cached) {
    userBalanceDisplay.textContent = formatInr(cached.balance || 0);
  }

  try {
    const qUser = query(collection(db, "users"), where("username", "==", USERNAME));
    const snap = await getDocs(qUser);
    if (snap.empty) return;

    const userData = snap.docs[0].data() || {};
    const summary = {
      username: String(userData.username || "").trim(),
      email: String(userData.email || "").trim(),
      balance: Number(userData.balance || 0),
      extraProfit: Number(userData.extraProfit || 0),
      discount: Number(userData.discount || 0),
      timezone: String(userData.timezone || "Asia/Kolkata").trim(),
      whatsapp: String(userData.whatsapp || "").trim()
    };
    writeCache(USER_SUMMARY_CACHE_KEY, summary);
    userBalanceDisplay.textContent = formatInr(summary.balance || 0);
  } catch (err) {
    console.warn("User summary load failed:", err?.message || err);
  }
}

async function loadLeaderboard() {
  if (!leaderboardList) return;

  const cached = readLeaderboardCache();
  if (cached) {
    const normalized = normalizePayload(cached);
    if (normalized) {
      leaderboardPayload = normalized;
      renderLeaderboard(activePeriod);
    }
  } else {
    renderLeaderboard(activePeriod);
  }

  try {
    const res = await fetch(`${LEADERBOARD_API}?limit=10`, { method: "GET", cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(String(json?.error || `Leaderboard request failed (${res.status})`).trim());

    const normalized = normalizePayload(json);
    if (!normalized) throw new Error("Invalid leaderboard data");

    leaderboardPayload = normalized;
    writeLeaderboardCache(normalized);
    renderLeaderboard(activePeriod);
  } catch (err) {
    console.warn("Leaderboard load failed:", err?.message || err);
    if (!leaderboardPayload) {
      setLeaderboardState("Leaderboard is temporarily unavailable.");
      if (leaderboardUpdated) leaderboardUpdated.textContent = "Could not update";
    }
  }
}

bindTabs();

(async function init() {
  await Promise.allSettled([
    loadUserSummary(),
    loadLeaderboard()
  ]);
})();
