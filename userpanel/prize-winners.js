import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  getDoc,
  doc,
  query,
  where,
  limit
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  CacheTTL,
  readCache,
  writeCache,
  userSummaryKey
} from "./data-cache.js";
import { getActiveUsername } from "./firestore-fast.js";

const USERNAME = getActiveUsername();
const USER_SUMMARY_CACHE_KEY = userSummaryKey(USERNAME);
const urlParams = new URLSearchParams(window.location.search);
const CONTEST_ID = String(urlParams.get("contestId") || "").trim();

const $ = (id) => document.getElementById(id);
const userBalanceDisplay = $("userBalance");
const contestTitleEl = $("contestTitle");
const contestMetaEl = $("contestMeta");
const winnerCountEl = $("winnerCount");
const updatedAtEl = $("updatedAt");
const winnersListEl = $("winnersList");
const winnerTabs = Array.from(document.querySelectorAll("[data-winner-filter]"));

const formatInr = (n) => `\u20B9${Number(n || 0).toFixed(2)}`;
const escapeHtml = (value) => String(value || "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;"
}[c]));

let allWinnerRows = [];
let activeFilter = "all";

function formatDateTime(ts) {
  const ms = Number(ts || 0);
  if (!ms) return "-";
  return new Date(ms).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function normalizeClaimStatus(row) {
  const raw = String(row?.claimStatus || "").toLowerCase();
  if (raw === "claimed" || row?.claimOrderId || row?.claimedAt) {
    return { code: "claimed", label: "Claimed" };
  }
  if (raw === "expired") {
    return { code: "expired", label: "Expired" };
  }
  return { code: "unclaimed", label: "Unclaimed" };
}

function prizeLabel(row) {
  const reward = String(row?.rewardServiceTitle || row?.prize || "Reward").trim();
  const qty = Math.max(1, Number(row?.rewardQty || 1));
  return `${reward} - Qty ${qty}`;
}

function winnerDisplayName(row) {
  return String(row?.username || row?.winnerUsername || "Unknown User").trim() || "Unknown User";
}

function winnerAvatar(row) {
  const candidates = [
    row?.avatarUrl,
    row?.photoUrl,
    row?.profilePhotoUrl,
    row?.userPhotoUrl
  ];

  for (const candidate of candidates) {
    const clean = String(candidate || "").trim();
    if (clean) return clean;
  }

  return "";
}

function userInitials(name) {
  const raw = String(name || "").trim();
  if (!raw) return "U";

  const parts = raw.replace(/[_\-.]+/g, " ").split(/\s+/).filter(Boolean);
  if (!parts.length) return "U";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
}

function normalizeWinners(rows) {
  const normalized = (Array.isArray(rows) ? rows : []).map((row) => ({
    id: String(row?.id || ""),
    rank: Number(row?.rank || 0),
    username: winnerDisplayName(row),
    prizeText: prizeLabel(row),
    qty: Math.max(1, Number(row?.rewardQty || 1)),
    claim: normalizeClaimStatus(row),
    avatarUrl: winnerAvatar(row),
    createdAt: Number(row?.createdAt || 0)
  }));

  normalized.sort((a, b) => {
    const aRank = Number(a.rank || 0);
    const bRank = Number(b.rank || 0);
    const aHasRank = aRank > 0;
    const bHasRank = bRank > 0;
    if (aHasRank && bHasRank && aRank !== bRank) return aRank - bRank;
    if (aHasRank !== bHasRank) return aHasRank ? -1 : 1;
    return Number(a.createdAt || 0) - Number(b.createdAt || 0);
  });

  return normalized.map((row, index) => ({
    ...row,
    displayRank: row.rank > 0 ? row.rank : index + 1
  }));
}

function filteredWinners() {
  if (activeFilter === "claimed") {
    return allWinnerRows.filter((row) => row.claim.code === "claimed");
  }
  if (activeFilter === "unclaimed") {
    return allWinnerRows.filter((row) => row.claim.code !== "claimed");
  }
  return [...allWinnerRows];
}

function updateWinnerTabs() {
  winnerTabs.forEach((tab) => {
    const tabKey = String(tab.getAttribute("data-winner-filter") || "").trim().toLowerCase();
    tab.classList.toggle("active", tabKey === activeFilter);
  });
}

function setState(message) {
  if (!winnersListEl) return;
  winnersListEl.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function avatarMarkup(row, className) {
  if (row.avatarUrl) {
    return `<span class="${className}"><img src="${escapeHtml(row.avatarUrl)}" alt="${escapeHtml(row.username)}"></span>`;
  }
  return `<span class="${className}">${escapeHtml(userInitials(row.username))}</span>`;
}

function renderTopCard(row) {
  if (!row) return "";
  return `
    <article class="winner-top-card">
      <i class="bi bi-trophy-fill winner-trophy"></i>
      ${avatarMarkup(row, "winner-avatar")}
      <span class="winner-rank-pill">Rank #${row.displayRank}</span>
      <div class="winner-user">${escapeHtml(row.username)}</div>
      <div class="winner-note">Prize Qty: ${row.qty}</div>
      <div class="winner-prize">${escapeHtml(row.prizeText)}</div>
      <span class="winner-status ${escapeHtml(row.claim.code)}">${escapeHtml(row.claim.label)}</span>
    </article>
  `;
}

function renderWinners() {
  if (!winnersListEl) return;
  const rows = filteredWinners();

  if (winnerCountEl) {
    winnerCountEl.textContent = `Showing: ${rows.length} / ${allWinnerRows.length}`;
  }

  if (!allWinnerRows.length) {
    setState("No winners announced for this contest yet.");
    return;
  }

  if (!rows.length) {
    setState("No winners found for selected filter.");
    return;
  }

  const top3 = rows.slice(0, 3);
  const rowMarkup = rows.map((row) => `
    <div class="winners-row">
      <span class="rank">#${row.displayRank}</span>
      <span class="user">
        ${avatarMarkup(row, "winner-avatar-sm")}
        <span class="user-text">${escapeHtml(row.username)}</span>
      </span>
      <span class="prize">${escapeHtml(row.prizeText)}</span>
      <span class="status"><span class="winner-status ${escapeHtml(row.claim.code)}">${escapeHtml(row.claim.label)}</span></span>
    </div>
  `).join("");

  winnersListEl.innerHTML = `
    <div class="winners-top">
      ${renderTopCard(top3[0])}
      ${renderTopCard(top3[1])}
      ${renderTopCard(top3[2])}
    </div>
    <div class="winners-table">
      <div class="winners-row head">
        <span>Rank</span>
        <span>User</span>
        <span>Prize</span>
        <span>Status</span>
      </div>
      ${rowMarkup}
    </div>
  `;
}

async function loadUserSummary() {
  if (!USERNAME || !userBalanceDisplay) return;

  const cached = readCache(USER_SUMMARY_CACHE_KEY, { maxAgeMs: CacheTTL.userSummary });
  if (cached) {
    userBalanceDisplay.textContent = formatInr(cached.balance || 0);
  }

  try {
    const snap = await getDocs(query(collection(db, "users"), where("username", "==", USERNAME), limit(1)));
    if (snap.empty) return;

    const userData = snap.docs[0].data() || {};
    const summary = {
      username: String(userData.username || ""),
      email: String(userData.email || ""),
      balance: Number(userData.balance || 0),
      extraProfit: Number(userData.extraProfit || 0),
      discount: Number(userData.discount || 0),
      timezone: String(userData.timezone || "Asia/Kolkata"),
      whatsapp: String(userData.whatsapp || "")
    };

    writeCache(USER_SUMMARY_CACHE_KEY, summary);
    userBalanceDisplay.textContent = formatInr(summary.balance || 0);
  } catch (err) {
    console.warn("User summary load failed:", err?.message || err);
  }
}

async function loadContestMeta() {
  if (!CONTEST_ID) return;

  try {
    const contestSnap = await getDoc(doc(db, "prize_contests", CONTEST_ID));
    if (!contestSnap.exists()) return;

    const contest = contestSnap.data() || {};
    const title = String(contest.title || "Contest Winners");
    const prize = String(contest.prize || "Reward");
    const slots = Number(contest.winnersCount || 0);
    const endedOn = formatDateTime(contest.endsAt || contest.updatedAt || contest.createdAt);

    if (contestTitleEl) contestTitleEl.textContent = title;
    if (contestMetaEl) {
      contestMetaEl.textContent = `Prize: ${prize} | Winner Slots: ${slots || "-"} | Ended: ${endedOn}`;
    }
  } catch (err) {
    console.warn("Contest meta load failed:", err?.message || err);
  }
}

async function loadWinners() {
  if (!CONTEST_ID) {
    if (contestTitleEl) contestTitleEl.textContent = "Contest not selected";
    if (contestMetaEl) contestMetaEl.textContent = "Please open this page from Past Tournament > View Winners.";
    setState("Contest ID missing.");
    return;
  }

  try {
    const snap = await getDocs(query(
      collection(db, "prize_winners"),
      where("contestId", "==", CONTEST_ID),
      limit(250)
    ));

    const rows = [];
    snap.forEach((row) => rows.push({ id: row.id, ...(row.data() || {}) }));

    allWinnerRows = normalizeWinners(rows);
    updateWinnerTabs();
    renderWinners();

    if (updatedAtEl) {
      updatedAtEl.textContent = `Updated: ${formatDateTime(Date.now())}`;
    }
  } catch (err) {
    console.warn("Winners load failed:", err?.message || err);
    setState("Could not load winners right now.");
    if (updatedAtEl) updatedAtEl.textContent = "Update failed";
  }
}

function bindWinnerTabs() {
  winnerTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const key = String(tab.getAttribute("data-winner-filter") || "").trim().toLowerCase();
      if (!key || key === activeFilter) return;
      activeFilter = key;
      updateWinnerTabs();
      renderWinners();
    });
  });
}

bindWinnerTabs();

(async function init() {
  await Promise.allSettled([
    loadUserSummary(),
    loadContestMeta(),
    loadWinners()
  ]);
})();
