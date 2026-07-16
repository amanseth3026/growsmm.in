// prizearena.js - User-side Prize Arena with tabs, past tournaments, and reward claims.

import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  getDoc,
  doc,
  query,
  where,
  orderBy,
  limit,
  runTransaction,
  serverTimestamp,
  increment,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  CacheTTL,
  readCache,
  writeCache,
  userSummaryKey
} from "./data-cache.js";
import { getActiveUsername } from "./firestore-fast.js";

const USERNAME = getActiveUsername();
const NORMALIZED_USERNAME = String(USERNAME || "").trim().toLowerCase();
const USER_SUMMARY_CACHE_KEY = userSummaryKey(USERNAME);

const AUTO_DRAW_API = "/api/prize-auto-draw";
const CLAIM_API = "/api/contest-claim";
const CLAIM_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;
const PAST_CONTEST_LIMIT = 15;

const $ = (id) => document.getElementById(id);
const userBalanceDisplay = $("userBalance");
const activeWrap = $("activeContests");
const pastWrap = $("pastTournaments");
const rewardsWrap = $("myRewards");
const heroPill = $("heroPill");
const heroTitle = $("heroTitle");
const heroSubtitle = $("heroSubtitle");

const paneActive = $("paneActive");
const panePast = $("panePast");
const paneRewards = $("paneRewards");

const tabButtons = Array.from(document.querySelectorAll("[data-arena-tab]"));

const fmtInr = (n) => `\u20B9${Number(n || 0).toFixed(2)}`;
const escapeHtml = (v) => String(v || "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}[c]));

const fmtDate = (ts) => {
  const ms = Number(ts || 0);
  if (!ms) return "-";
  return new Date(ms).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
};

const fmtDateTime = (ts) => {
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
};

const countdown = (endsAt) => {
  const diff = Number(endsAt || 0) - Date.now();
  if (diff <= 0) return "Ended";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h left`;
  return `${h}h ${m}m left`;
};

const participantDocId = (contestId, username) => {
  const c = String(contestId || "").trim();
  const u = String(username || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  return `${c}__${u}`;
};

let cachedBalance = 0;
let pastContestRows = [];
let winnersByContest = new Map();

function winnersPageHref(contestId) {
  const id = String(contestId || "").trim();
  return `prize-winners.html?contestId=${encodeURIComponent(id)}`;
}

function computeRewardState(row) {
  const now = Date.now();
  const createdAt = Number(row.createdAt || now);
  const deadlineAt = Number(row.claimDeadlineAt || (createdAt + CLAIM_WINDOW_MS));
  const claimed = String(row.claimStatus || "").toLowerCase() === "claimed" || row.claimedAt || row.claimOrderId;
  const expired = !claimed && deadlineAt < now;

  if (claimed) {
    return {
      code: "claimed",
      label: "Claimed",
      canClaim: false,
      deadlineAt
    };
  }

  if (expired) {
    return {
      code: "expired",
      label: "Expired",
      canClaim: false,
      deadlineAt
    };
  }

  return {
    code: "claimable",
    label: "Claimable",
    canClaim: true,
    deadlineAt
  };
}

function switchTab(tab) {
  const normalized = String(tab || "active").trim().toLowerCase();

  tabButtons.forEach((btn) => {
    const btnTab = String(btn.getAttribute("data-arena-tab") || "").toLowerCase();
    btn.classList.toggle("active", btnTab === normalized);
  });

  paneActive?.classList.toggle("d-none", normalized !== "active");
  panePast?.classList.toggle("d-none", normalized !== "past");
  paneRewards?.classList.toggle("d-none", normalized !== "rewards");
}

function initialArenaTab() {
  const fromQuery = new URLSearchParams(window.location.search).get("tab");
  const normalized = String(fromQuery || "").trim().toLowerCase();
  if (normalized === "past") return "past";
  return "active";
}

async function triggerAutoDraw() {
  try {
    await fetch(AUTO_DRAW_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "userpanel" })
    });
  } catch (err) {
    console.warn("Auto draw trigger failed:", err?.message || err);
  }
}

/* ---------- USER SUMMARY ---------- */
async function loadUserSummary() {
  if (!USERNAME) return;

  const cached = readCache(USER_SUMMARY_CACHE_KEY, { maxAgeMs: CacheTTL.userSummary });
  if (cached) {
    cachedBalance = Number(cached.balance || 0);
    if (userBalanceDisplay) userBalanceDisplay.textContent = fmtInr(cachedBalance);
  }

  try {
    const snap = await getDocs(query(collection(db, "users"), where("username", "==", USERNAME), limit(1)));
    if (snap.empty) return;

    const u = snap.docs[0].data() || {};
    cachedBalance = Number(u.balance || 0);

    const summary = {
      username: String(u.username || ""),
      email: String(u.email || ""),
      balance: cachedBalance,
      extraProfit: Number(u.extraProfit || 0),
      discount: Number(u.discount || 0),
      timezone: String(u.timezone || "Asia/Kolkata"),
      whatsapp: String(u.whatsapp || "")
    };

    writeCache(USER_SUMMARY_CACHE_KEY, summary);
    if (userBalanceDisplay) userBalanceDisplay.textContent = fmtInr(cachedBalance);
  } catch (err) {
    console.warn("User summary failed:", err?.message || err);
  }
}

/* ---------- SETTINGS ---------- */
async function loadArenaSettings() {
  try {
    const ref = doc(db, "prize_settings", "main");
    const snap = await getDoc(ref);
    if (!snap.exists()) return;

    const s = snap.data() || {};
    if (s.heroPill && heroPill) heroPill.textContent = s.heroPill;
    if (s.heroTitle && heroTitle) heroTitle.textContent = s.heroTitle;
    if (s.heroSubtitle && heroSubtitle) heroSubtitle.textContent = s.heroSubtitle;
  } catch (err) {
    console.warn("Arena settings load failed:", err?.message || err);
  }
}

/* ---------- ACTIVE CONTESTS ---------- */
async function loadActiveContests() {
  if (!activeWrap) return;

  try {
    const snap = await getDocs(query(collection(db, "prize_contests"), where("status", "==", "active")));

    const now = Date.now();
    const contests = [];
    snap.forEach((row) => {
      const data = row.data() || {};
      if (Number(data.endsAt || 0) <= now) return;
      contests.push({ id: row.id, ...data });
    });

    contests.sort((a, b) => Number(a.endsAt || 0) - Number(b.endsAt || 0));

    if (!contests.length) {
      activeWrap.innerHTML = '<div class="empty-card">No active contests right now. Check back soon!</div>';
      return;
    }

    const joinedIds = new Set();
    if (USERNAME) {
      const partSnap = await getDocs(query(collection(db, "prize_participants"), where("username", "==", USERNAME)));
      partSnap.forEach((p) => joinedIds.add(String(p.data()?.contestId || "")));
    }

    activeWrap.innerHTML = contests.map((contest) => {
      const safeContestId = escapeHtml(contest.id || "");
      const joined = joinedIds.has(contest.id);
      const ended = Number(contest.endsAt || 0) <= Date.now();
      const fee = Number(contest.fee || 0);
      const shortBalance = cachedBalance < fee;

      const canJoin = Boolean(USERNAME) && !joined && !ended;
      let btnLabel = `Join - ${fmtInr(fee)}`;
      if (joined) btnLabel = "Joined";
      if (ended) btnLabel = "Ended";
      if (!USERNAME) btnLabel = "Login required";
      if (canJoin && shortBalance) btnLabel = `Add funds - ${fmtInr(fee)}`;

      return `
        <article class="contest-card" data-id="${safeContestId}">
          <div>
            <h6>${escapeHtml(contest.title || "Untitled Contest")}</h6>
            <div class="contest-meta">
              <span><i class="bi bi-gift"></i> ${escapeHtml(contest.prize || "Reward")}</span>
              <span><i class="bi bi-trophy"></i> ${Number(contest.winnersCount || 1)} winner slots</span>
              <span><i class="bi bi-people-fill"></i> ${Number(contest.participantsCount || 0)} joined</span>
              <span class="countdown"><i class="bi bi-clock-history"></i> ${escapeHtml(countdown(contest.endsAt))}</span>
            </div>
          </div>
          <button class="btn-join" data-action="join" data-id="${safeContestId}" ${canJoin ? "" : "disabled"}>
            ${escapeHtml(btnLabel)}
          </button>
        </article>
      `;
    }).join("");
  } catch (err) {
    console.warn("Active contests load failed:", err?.message || err);
    activeWrap.innerHTML = '<div class="empty-card">Could not load contests. Try again later.</div>';
  }
}

/* ---------- PAST TOURNAMENT ---------- */
function getPastWinners(contestId) {
  const rows = winnersByContest.get(String(contestId || "")) || [];
  return [...rows].sort((a, b) => {
    const ar = Number(a.rank || 0);
    const br = Number(b.rank || 0);
    if (ar && br && ar !== br) return ar - br;
    return Number(a.createdAt || 0) - Number(b.createdAt || 0);
  });
}

function renderPastTournament() {
  if (!pastWrap) return;

  if (!pastContestRows.length) {
    pastWrap.innerHTML = '<div class="empty-card">No tournament history yet.</div>';
    return;
  }

  pastWrap.innerHTML = pastContestRows.map((contest) => {
    const contestId = String(contest.id || "");
    const safeContestId = escapeHtml(contestId);
    const winners = getPastWinners(contestId);
    const resolvedCount = Number(contest.winnerCountResolved || winners.length || 0);
    const totalSlots = Number(contest.winnersCount || 1);
    const winnersHref = winnersPageHref(contestId);
    const safeWinnersHref = escapeHtml(winnersHref);

    return `
      <article class="past-card" data-contest-id="${safeContestId}">
        <div class="past-head">
          <div>
            <h6 class="past-title">${escapeHtml(contest.title || "Tournament")}</h6>
            <div class="past-meta">
              <span><i class="bi bi-gift"></i> ${escapeHtml(contest.prize || "Reward")}</span>
              <span><i class="bi bi-people"></i> Winners ${resolvedCount}/${totalSlots}</span>
              <span><i class="bi bi-calendar-event"></i> Ended ${escapeHtml(fmtDate(contest.endsAt || contest.updatedAt))}</span>
            </div>
          </div>
          <a class="past-toggle" href="${safeWinnersHref}">
            View Winners
          </a>
        </div>
      </article>
    `;
  }).join("");
}

async function loadPastTournament() {
  if (!pastWrap) return;

  try {
    const [contestSnap, winnerSnap] = await Promise.all([
      getDocs(collection(db, "prize_contests")),
      getDocs(query(collection(db, "prize_winners"), orderBy("createdAt", "desc"), limit(400)))
    ]);

    winnersByContest = new Map();
    winnerSnap.forEach((row) => {
      const data = row.data() || {};
      const contestId = String(data.contestId || "").trim();
      if (!contestId) return;
      if (!winnersByContest.has(contestId)) winnersByContest.set(contestId, []);
      winnersByContest.get(contestId).push({ id: row.id, ...data });
    });

    const rows = [];
    contestSnap.forEach((row) => {
      const data = row.data() || {};
      const endsAt = Number(data.endsAt || 0);
      const hasEnded = String(data.status || "").toLowerCase() === "ended" || (endsAt && endsAt <= Date.now());
      if (!hasEnded) return;
      rows.push({ id: row.id, ...data });
    });

    rows.sort((a, b) => {
      const aMs = Number(a.endsAt || a.updatedAt || a.createdAt || 0);
      const bMs = Number(b.endsAt || b.updatedAt || b.createdAt || 0);
      return bMs - aMs;
    });

    pastContestRows = rows.slice(0, PAST_CONTEST_LIMIT);
    renderPastTournament();
  } catch (err) {
    console.warn("Past tournament load failed:", err?.message || err);
    pastWrap.innerHTML = '<div class="empty-card">Could not load past tournaments.</div>';
  }
}

/* ---------- REWARDS ---------- */
async function syncExpiredRewards(rows) {
  const expired = rows.filter((row) => {
    const state = computeRewardState(row);
    return state.code === "expired" && String(row.claimStatus || "").toLowerCase() !== "expired";
  });

  if (!expired.length) return;

  await Promise.allSettled(expired.map((row) =>
    updateDoc(doc(db, "prize_winners", row.id), {
      claimStatus: "expired",
      updatedAt: Date.now()
    })
  ));
}

async function loadMyRewards() {
  if (!rewardsWrap) return;

  try {
    const rows = [];
    const seen = new Set();

    if (USERNAME) {
      const byExact = await getDocs(query(
        collection(db, "prize_winners"),
        where("username", "==", USERNAME),
        limit(120)
      ));

      byExact.forEach((row) => {
        if (seen.has(row.id)) return;
        seen.add(row.id);
        rows.push({ id: row.id, ...(row.data() || {}) });
      });
    }

    if (!rows.length && NORMALIZED_USERNAME) {
      const byKey = await getDocs(query(
        collection(db, "prize_winners"),
        where("usernameKey", "==", NORMALIZED_USERNAME),
        limit(120)
      ));

      byKey.forEach((row) => {
        if (seen.has(row.id)) return;
        seen.add(row.id);
        rows.push({ id: row.id, ...(row.data() || {}) });
      });
    }

    rows.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

    if (!rows.length) {
      rewardsWrap.innerHTML = '<div class="empty-card">You have not won any rewards yet.</div>';
      return;
    }

    rewardsWrap.innerHTML = rows.map((row) => {
      const state = computeRewardState(row);
      const deadline = fmtDateTime(state.deadlineAt);
      const claimedAt = row.claimedAt ? fmtDateTime(row.claimedAt) : "-";
      const contestTitle = String(row.contestTitle || "Prize Contest");
      const rewardTitle = String(row.rewardServiceTitle || row.prize || "Reward");
      const rewardQty = Math.max(1, Number(row.rewardQty || 1));
      const orderId = row.claimOrderId ? `#${row.claimOrderId}` : "-";
      const safeRowId = escapeHtml(row.id || "");

      const claimButton = state.canClaim
        ? `<button type="button" class="btn-claim" data-action="claim-reward" data-id="${safeRowId}">Claim Reward</button>`
        : `<button type="button" class="btn-claim" disabled>${escapeHtml(state.label)}</button>`;

      return `
        <article class="reward-card" data-winner-id="${safeRowId}">
          <div class="reward-head">
            <h6 class="reward-title">${escapeHtml(contestTitle)}</h6>
            <span class="reward-status ${escapeHtml(state.code)}">${escapeHtml(state.label)}</span>
          </div>

          <div class="reward-meta">
            <div class="reward-meta-item">
              <div class="reward-meta-lbl">Reward</div>
              <div class="reward-meta-val">${escapeHtml(rewardTitle)}</div>
            </div>
            <div class="reward-meta-item">
              <div class="reward-meta-lbl">Quantity</div>
              <div class="reward-meta-val">${rewardQty}</div>
            </div>
            <div class="reward-meta-item">
              <div class="reward-meta-lbl">Claim Deadline</div>
              <div class="reward-meta-val">${escapeHtml(deadline)}</div>
            </div>
            <div class="reward-meta-item">
              <div class="reward-meta-lbl">Order</div>
              <div class="reward-meta-val">${escapeHtml(orderId)}</div>
            </div>
          </div>

          <p class="reward-note">
            ${state.code === "claimed"
              ? `Claimed on ${escapeHtml(claimedAt)}${row.claimLink ? ` • Link: ${escapeHtml(row.claimLink)}` : ""}`
              : "Claim once by submitting your target link. Reward remains available for 10 days."}
          </p>

          ${claimButton}
        </article>
      `;
    }).join("");

    syncExpiredRewards(rows).catch(() => {});
  } catch (err) {
    console.warn("Rewards load failed:", err?.message || err);
    rewardsWrap.innerHTML = '<div class="empty-card">Could not load rewards.</div>';
  }
}

/* ---------- JOIN CONTEST ---------- */
async function joinContest(contestId, btn) {
  if (!USERNAME) {
    alert("Please log in to join a contest.");
    return;
  }

  if (!contestId || !btn) return;

  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Joining...';

  try {
    const uSnap = await getDocs(query(collection(db, "users"), where("username", "==", USERNAME), limit(1)));
    if (uSnap.empty) throw new Error("User not found.");

    const userRef = uSnap.docs[0].ref;
    const contestRef = doc(db, "prize_contests", contestId);
    const participantRef = doc(db, "prize_participants", participantDocId(contestId, NORMALIZED_USERNAME || USERNAME));

    let feeUsed = 0;
    let nextBalance = null;

    await runTransaction(db, async (tx) => {
      const [userDoc, contestDoc, participantDoc] = await Promise.all([
        tx.get(userRef),
        tx.get(contestRef),
        tx.get(participantRef)
      ]);

      if (!contestDoc.exists()) throw new Error("Contest not found.");
      if (participantDoc.exists()) throw new Error("You already joined this contest.");

      const contest = contestDoc.data() || {};
      if (String(contest.status || "").toLowerCase() !== "active") throw new Error("Contest is no longer active.");
      if (Number(contest.endsAt || 0) <= Date.now()) throw new Error("Contest has ended.");

      const fee = Number(contest.fee || 0);
      const balance = Number(userDoc.data()?.balance || 0);
      if (balance < fee) throw new Error("Insufficient balance. Please add funds.");

      feeUsed = fee;
      nextBalance = Number((balance - fee).toFixed(4));
      tx.update(userRef, { balance: nextBalance });
      tx.update(contestRef, {
        participantsCount: increment(1),
        totalEarnings: increment(fee)
      });
      tx.set(participantRef, {
        contestId,
        username: USERNAME,
        usernameKey: NORMALIZED_USERNAME || USERNAME.toLowerCase(),
        fee,
        joinedAt: Date.now(),
        createdAt: serverTimestamp()
      });
    });

    const finalBalance = Number.isFinite(nextBalance)
      ? Math.max(0, nextBalance)
      : Math.max(0, cachedBalance - feeUsed);
    cachedBalance = finalBalance;
    if (userBalanceDisplay) userBalanceDisplay.textContent = fmtInr(cachedBalance);

    const cachedSummary = readCache(USER_SUMMARY_CACHE_KEY, { maxAgeMs: CacheTTL.userSummary }) || {};
    cachedSummary.balance = cachedBalance;
    writeCache(USER_SUMMARY_CACHE_KEY, cachedSummary);

    btn.innerHTML = "Joined";
    btn.disabled = true;

    await loadActiveContests();
  } catch (err) {
    console.warn("Join failed:", err?.message || err);
    alert(err?.message || "Could not join contest.");
    btn.innerHTML = originalLabel;
    btn.disabled = false;
  }
}

/* ---------- CLAIM REWARD ---------- */
async function claimReward(winnerId, btn) {
  if (!winnerId || !btn) return;

  const link = prompt("Reward claim ke liye target link daalein (e.g. profile/post URL):", "");
  if (link == null) return;
  const cleanLink = String(link || "").trim();
  if (!cleanLink) return alert("Please enter a valid link.");

  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Claiming...';

  try {
    const res = await fetch(CLAIM_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        winnerId,
        username: USERNAME,
        link: cleanLink
      })
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.success) {
      throw new Error(json?.error || "Reward claim failed.");
    }

    const modeText = json?.mode === "manual" ? "Manual" : "Auto Vendor";
    alert(`Reward claimed successfully. Admin processing mode: ${modeText}.`);

    await Promise.allSettled([
      loadMyRewards(),
      loadPastTournament()
    ]);
  } catch (err) {
    console.warn("Claim reward failed:", err?.message || err);
    alert(err?.message || "Could not claim reward.");
    btn.disabled = false;
    btn.innerHTML = original;
    return;
  }

  btn.innerHTML = "Claimed";
  btn.disabled = true;
}

/* ---------- DOM EVENTS ---------- */
document.addEventListener("click", (event) => {
  const tabBtn = event.target.closest("[data-arena-tab]");
  if (tabBtn) {
    switchTab(tabBtn.getAttribute("data-arena-tab"));
    return;
  }

  const joinBtn = event.target.closest('[data-action="join"]');
  if (joinBtn) {
    joinContest(joinBtn.getAttribute("data-id"), joinBtn);
    return;
  }

  const claimBtn = event.target.closest('[data-action="claim-reward"]');
  if (claimBtn) {
    claimReward(claimBtn.getAttribute("data-id"), claimBtn);
  }
});

/* ---------- INIT ---------- */
(async function init() {
  switchTab(initialArenaTab());

  await Promise.allSettled([
    loadUserSummary(),
    loadArenaSettings()
  ]);

  await triggerAutoDraw();

  await Promise.allSettled([
    loadActiveContests(),
    loadPastTournament(),
    loadMyRewards()
  ]);

  setInterval(() => {
    loadActiveContests();
    loadMyRewards();
  }, 30000);
})();
