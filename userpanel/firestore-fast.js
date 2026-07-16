import { db } from "./firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  CacheTTL,
  readCache,
  writeCache,
  userSummaryKey
} from "./data-cache.js";

const USERNAME_STORAGE_KEY = "smmGrowthUser";
const USER_DOC_ID_CACHE_PREFIX = "smm_user_doc_id_v1:";
const USER_SUMMARY_MEMORY_TTL_MS = 30 * 1000;
const ORDER_COUNT_MEMORY_TTL_MS = 20 * 1000;

export const DEFAULT_ORDER_COLLECTIONS = [
  "orders_active",
  "orders_completed",
  "orders_cancel",
  "orders_partial",
  "orders"
];

const userSummaryMemory = new Map();
const userSummaryPending = new Map();
const orderCountMemory = new Map();
const orderCountPending = new Map();

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

export function getActiveUsername() {
  return normalizeUsername(
    localStorage.getItem(USERNAME_STORAGE_KEY) ||
    sessionStorage.getItem(USERNAME_STORAGE_KEY) ||
    ""
  );
}

function userDocIdCacheKey(username) {
  return `${USER_DOC_ID_CACHE_PREFIX}${normalizeUsername(username) || "guest"}`;
}

function readUserDocId(username) {
  try {
    return String(localStorage.getItem(userDocIdCacheKey(username)) || "").trim();
  } catch {
    return "";
  }
}

function writeUserDocId(username, docId) {
  const cleanDocId = String(docId || "").trim();
  if (!cleanDocId) return;
  try {
    localStorage.setItem(userDocIdCacheKey(username), cleanDocId);
  } catch {
    // Ignore storage failures.
  }
}

function normalizeSummary(docId, raw = {}, fallbackUsername = "") {
  const username = String(raw.username || fallbackUsername || "").trim().toLowerCase();
  if (!username) return null;

  return {
    id: String(docId || "").trim(),
    username,
    email: String(raw.email || "").trim(),
    balance: Number(raw.balance || 0),
    extraProfit: Number(raw.extraProfit || 0),
    discount: Number(raw.discount || 0),
    timezone: String(raw.timezone || "Asia/Kolkata").trim(),
    whatsapp: String(raw.whatsapp || "").trim(),
    profileImage: String(raw.profileImage || raw.photo || raw.avatarUrl || raw.photoURL || "").trim(),
    photo: String(raw.photo || raw.profileImage || raw.avatarUrl || raw.photoURL || "").trim()
  };
}

function writeUserSummaryCache(summary) {
  if (!summary?.username) return;
  writeCache(userSummaryKey(summary.username), summary);
}

async function fetchByCachedDocId(username, cachedDocId) {
  if (!cachedDocId) return null;
  const snap = await getDoc(doc(db, "users", cachedDocId));
  if (!snap.exists()) return null;
  const summary = normalizeSummary(snap.id, snap.data(), username);
  if (!summary) return null;
  if (normalizeUsername(summary.username) !== normalizeUsername(username)) return null;
  return summary;
}

async function fetchByUsernameQuery(username) {
  const qUser = query(
    collection(db, "users"),
    where("username", "==", username),
    limit(1)
  );
  const userSnap = await getDocs(qUser);
  if (userSnap.empty) return null;
  const row = userSnap.docs[0];
  return normalizeSummary(row.id, row.data(), username);
}

export async function fetchUserSummaryFast(
  usernameInput,
  { forceRefresh = false, cacheMaxAgeMs = CacheTTL.userSummary } = {}
) {
  const username = normalizeUsername(usernameInput || getActiveUsername());
  if (!username) return null;

  const cacheKey = userSummaryKey(username);
  const memoryHit = userSummaryMemory.get(username);
  if (!forceRefresh && memoryHit && Date.now() - memoryHit.ts < USER_SUMMARY_MEMORY_TTL_MS) {
    return { ...memoryHit.data };
  }

  if (!forceRefresh && userSummaryPending.has(username)) {
    return userSummaryPending.get(username);
  }

  const runner = (async () => {
    const cachedSummary = !forceRefresh
      ? readCache(cacheKey, { maxAgeMs: cacheMaxAgeMs })
      : null;
    const normalizedCached = normalizeSummary(
      String(cachedSummary?.id || "").trim(),
      cachedSummary || {},
      username
    );

    if (!forceRefresh && normalizedCached) {
      userSummaryMemory.set(username, { ts: Date.now(), data: normalizedCached });
    }

    let freshSummary = null;
    const cachedDocId = readUserDocId(username);

    try {
      freshSummary = await fetchByCachedDocId(username, cachedDocId);
    } catch {
      freshSummary = null;
    }

    if (!freshSummary) {
      try {
        freshSummary = await fetchByUsernameQuery(username);
      } catch {
        freshSummary = null;
      }
    }

    const finalSummary = freshSummary || normalizedCached;
    if (freshSummary) {
      writeUserDocId(username, freshSummary.id);
      writeUserSummaryCache(freshSummary);
    }

    if (finalSummary) {
      userSummaryMemory.set(username, { ts: Date.now(), data: finalSummary });
      return { ...finalSummary };
    }

    userSummaryMemory.delete(username);
    return null;
  })();

  userSummaryPending.set(username, runner);
  try {
    return await runner;
  } finally {
    userSummaryPending.delete(username);
  }
}

export async function fetchUserOrderCountFast(
  usernameInput,
  { collections = DEFAULT_ORDER_COLLECTIONS, forceRefresh = false } = {}
) {
  const username = normalizeUsername(usernameInput || getActiveUsername());
  if (!username) return 0;

  const memoryHit = orderCountMemory.get(username);
  if (!forceRefresh && memoryHit && Date.now() - memoryHit.ts < ORDER_COUNT_MEMORY_TTL_MS) {
    return Number(memoryHit.count || 0);
  }

  if (!forceRefresh && orderCountPending.has(username)) {
    return orderCountPending.get(username);
  }

  const runner = (async () => {
    const snaps = await Promise.all(
      collections.map((collectionName) =>
        getDocs(query(collection(db, collectionName), where("payer", "==", username)))
      )
    );

    const uniqueIds = new Set();
    snaps.forEach((snap) => {
      snap.forEach((docSnap) => uniqueIds.add(String(docSnap.id)));
    });
    const finalCount = uniqueIds.size;

    const safeCount = Number.isFinite(finalCount) && finalCount > 0 ? finalCount : 0;
    orderCountMemory.set(username, { ts: Date.now(), count: safeCount });
    return safeCount;
  })();

  orderCountPending.set(username, runner);
  try {
    return await runner;
  } finally {
    orderCountPending.delete(username);
  }
}
