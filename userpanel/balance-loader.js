import { readCache, writeCache, userSummaryKey, CacheTTL } from "./data-cache.js";
import { fetchUserSummaryFast, getActiveUsername } from "./firestore-fast.js";

const USERNAME_KEY = "smmGrowthUser";

function getUsername() {
  return (getActiveUsername() || localStorage.getItem(USERNAME_KEY) || sessionStorage.getItem(USERNAME_KEY) || "").trim();
}

function formatINR(n) {
  return `\u20B9${Number(n || 0).toFixed(2)}`;
}

function updateBalanceOnPage(value) {
  const formatted = formatINR(value);
  const ids = ["userBalance", "userBalanceDisplay", "osBalance", "balanceInfo"];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    if ("value" in el) el.value = formatted; else el.textContent = formatted;
  });

  // common badge inside header
  document.querySelectorAll('.badge-balance span, .badge-balance').forEach((el) => {
    if (!el) return;
    el.textContent = formatted;
  });

  // update any element with data-balance attribute
  document.querySelectorAll('[data-balance-target]').forEach((el) => {
    el.textContent = formatted;
  });

  // also update sidebar widget if present
  const sidebarElem = document.getElementById('sidebarWalletAmount');
  if (sidebarElem) sidebarElem.textContent = formatted;
}

async function fetchRemoteAndApply(username) {
  try {
    const summary = await fetchUserSummaryFast(username, { forceRefresh: true });
    if (!summary) return;
    const balance = Number(summary.balance || 0);
    try { writeCachedSummary(username, summary); } catch {}
    updateBalanceOnPage(balance);
  } catch (err) {
    // silently ignore
    console.warn('balance-loader: fetch failed', err?.message || err);
  }
}

function writeCachedSummary(username, data) {
  try {
    // write minimal cached summary to keep other modules working
    const payload = {
      username: username,
      email: data.email || '',
      balance: Number(data.balance || 0),
      timezone: data.timezone || 'Asia/Kolkata',
      profileImage: data.profileImage || data.photo || ''
    };
    writeCache(userSummaryKey(username || 'guest'), payload);
  } catch {
    // ignore
  }
}

export async function initBalanceLoader() {
  const username = getUsername();
  if (!username) return;

  // try cache first
  try {
    const cached = readCache(userSummaryKey(username), { maxAgeMs: CacheTTL.userSummary });
    if (cached && typeof cached.balance !== 'undefined') {
      updateBalanceOnPage(cached.balance);
    }
  } catch {}

  // then fetch fresh
  await fetchRemoteAndApply(username);
}

// auto-init when loaded
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => { initBalanceLoader().catch(()=>{}); });
} else {
  initBalanceLoader().catch(()=>{});
}

