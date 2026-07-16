import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  getDoc,
  doc,
  query,
  where,
  limit,
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

const $ = (id) => document.getElementById(id);
const userBalanceDisplay = $("userBalance");
const rewardsWrap = $("myRewards");
const heroPill = $("heroPill");
const heroTitle = $("heroTitle");
const heroSubtitle = $("heroSubtitle");

const fmtInr = (n) => `\u20B9${Number(n || 0).toFixed(2)}`;
const escapeHtml = (v) => String(v || "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}[c]));

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

async function triggerAutoDraw() {
  try {
    await fetch(AUTO_DRAW_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "userpanel_rewards" })
    });
  } catch (err) {
    console.warn("Auto draw trigger failed:", err?.message || err);
  }
}

async function loadUserSummary() {
  if (!USERNAME || !userBalanceDisplay) return;

  const cached = readCache(USER_SUMMARY_CACHE_KEY, { maxAgeMs: CacheTTL.userSummary });
  if (cached) {
    userBalanceDisplay.textContent = fmtInr(cached.balance || 0);
  }

  try {
    const snap = await getDocs(query(collection(db, "users"), where("username", "==", USERNAME), limit(1)));
    if (snap.empty) return;

    const u = snap.docs[0].data() || {};
    const summary = {
      username: String(u.username || ""),
      email: String(u.email || ""),
      balance: Number(u.balance || 0),
      extraProfit: Number(u.extraProfit || 0),
      discount: Number(u.discount || 0),
      timezone: String(u.timezone || "Asia/Kolkata"),
      whatsapp: String(u.whatsapp || "")
    };

    writeCache(USER_SUMMARY_CACHE_KEY, summary);
    userBalanceDisplay.textContent = fmtInr(summary.balance || 0);
  } catch (err) {
    console.warn("User summary failed:", err?.message || err);
  }
}

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
      const rawLink = String(row.claimLink || "").trim();
      const safeLinkUrl = sanitizeHttpUrl(rawLink);
      const safeLinkLabel = safeLinkUrl ? escapeHtml(rawLink) : "";
      const safeRowId = escapeHtml(row.id || "");

      const linkMarkup = safeLinkUrl
        ? `<a href="${escapeHtml(safeLinkUrl)}" target="_blank" rel="noopener noreferrer">${safeLinkLabel}</a>`
        : "-";

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
              <div class="reward-meta-lbl">Order ID / Link</div>
              <div class="reward-meta-val">${escapeHtml(orderId)}<br>${linkMarkup}</div>
            </div>
          </div>

          <p class="reward-note">
            ${state.code === "claimed"
              ? `Claimed on ${escapeHtml(claimedAt)}`
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
    await loadMyRewards();
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

document.addEventListener("click", (event) => {
  const claimBtn = event.target.closest('[data-action="claim-reward"]');
  if (!claimBtn) return;
  claimReward(claimBtn.getAttribute("data-id"), claimBtn);
});

(async function init() {
  await Promise.allSettled([
    loadUserSummary(),
    loadArenaSettings()
  ]);

  await triggerAutoDraw();
  await loadMyRewards();

  setInterval(() => {
    loadMyRewards();
  }, 30000);
})();
