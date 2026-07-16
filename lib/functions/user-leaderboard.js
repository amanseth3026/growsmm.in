const admin = require("firebase-admin");

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS"
};

const ORDER_COLLECTIONS = [
  "orders_active",
  "orders_completed",
  "orders_cancel",
  "orders_partial",
  "orders"
];
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60 * 1000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const LEADERBOARD_TZ = "Asia/Kolkata";

if (!admin.apps.length) {
  const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey
    })
  });
}

const db = admin.firestore();

function toMillis(value) {
  if (Number.isFinite(value)) return Number(value);
  if (!value) return 0;

  if (typeof value.toMillis === "function") {
    const ms = Number(value.toMillis());
    return Number.isFinite(ms) ? ms : 0;
  }

  if (typeof value === "object" && Number.isFinite(value.seconds)) {
    const seconds = Number(value.seconds);
    const nanoseconds = Number(value.nanoseconds || 0);
    return (seconds * 1000) + Math.floor(nanoseconds / 1e6);
  }

  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function normalizeAmount(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function getKolkataStartOfDayMs(referenceMs = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LEADERBOARD_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(referenceMs));

  let year = 0;
  let month = 0;
  let day = 0;

  parts.forEach((part) => {
    if (part.type === "year") year = Number(part.value);
    if (part.type === "month") month = Number(part.value);
    if (part.type === "day") day = Number(part.value);
  });

  if (!year || !month || !day) {
    return referenceMs - (referenceMs % DAY_MS);
  }

  // IST has fixed +05:30 offset with no DST changes.
  return Date.UTC(year, month - 1, day, 0, 0, 0, 0) - IST_OFFSET_MS;
}

function buildOrderDedupeKey(docId, data = {}) {
  const internalOrderId = String(data.internalOrderId || "").trim();
  if (internalOrderId) return `internal:${internalOrderId}`;

  const payer = String(data.payer || data.username || "").trim().toLowerCase();
  const orderId = String(data.orderId || "").trim();
  if (payer && orderId) return `order:${payer}:${orderId}`;

  const createdAt = toMillis(data.createdAt || data.orderPlacedAt || data.date);
  const amount = normalizeAmount(data.amount || data.charge || data.totalAmount);
  if (payer && createdAt) return `fallback:${payer}:${createdAt}:${amount.toFixed(4)}`;

  return `doc:${String(docId || "").trim()}`;
}

function sanitizeLimit(rawLimit) {
  const parsed = Number(rawLimit);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

async function fetchOrdersSince(minStartMs) {
  const snapshots = await Promise.all(
    ORDER_COLLECTIONS.map((collectionName) =>
      db.collection(collectionName).where("createdAt", ">=", minStartMs).get()
    )
  );

  const dedupe = new Set();
  const rows = [];

  snapshots.forEach((snap) => {
    snap.forEach((docSnap) => {
      const data = docSnap.data() || {};
      const key = buildOrderDedupeKey(docSnap.id, data);
      if (dedupe.has(key)) return;
      dedupe.add(key);
      rows.push(data);
    });
  });

  return rows;
}

function buildLeaderboard(rows, startMs, limit) {
  const users = new Map();

  rows.forEach((order) => {
    const createdAt = toMillis(order.createdAt || order.orderPlacedAt || order.date);
    if (!createdAt || createdAt < startMs) return;

    const usernameRaw = String(order.payer || order.username || "").trim();
    if (!usernameRaw) return;

    const amount = normalizeAmount(order.amount || order.charge || order.totalAmount);
    if (!amount) return;

    const usernameKey = usernameRaw.toLowerCase();
    if (!users.has(usernameKey)) {
      users.set(usernameKey, {
        username: usernameRaw,
        totalAmount: 0,
        orderCount: 0
      });
    }

    const bucket = users.get(usernameKey);
    bucket.totalAmount += amount;
    bucket.orderCount += 1;
  });

  return Array.from(users.values())
    .sort((a, b) => {
      if (b.totalAmount !== a.totalAmount) return b.totalAmount - a.totalAmount;
      if (b.orderCount !== a.orderCount) return b.orderCount - a.orderCount;
      return a.username.localeCompare(b.username, "en", { sensitivity: "base" });
    })
    .slice(0, limit)
    .map((row) => ({
      username: row.username,
      totalAmount: Number(row.totalAmount.toFixed(4)),
      orderCount: row.orderCount
    }));
}

function normalizeUsernameKey(value = "") {
  return String(value || "").trim().toLowerCase();
}

function getAvatarUrlFromUserData(data = {}) {
  return String(
    data.profileImage || data.avatarUrl || data.photo || data.photoURL || ""
  ).trim();
}

function chunkArray(items = [], size = 10) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length || size <= 0) return [];

  const chunks = [];
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size));
  }
  return chunks;
}

async function fetchAvatarMapForRows(rowGroups = []) {
  const avatarMap = new Map();
  const usernameSet = new Set();

  rowGroups.forEach((group) => {
    if (!Array.isArray(group)) return;
    group.forEach((row) => {
      const rawUsername = String(row?.username || "").trim();
      if (!rawUsername) return;
      usernameSet.add(rawUsername);
      const normalized = normalizeUsernameKey(rawUsername);
      if (normalized && normalized !== rawUsername) {
        usernameSet.add(normalized);
      }
    });
  });

  const usernames = Array.from(usernameSet);
  if (!usernames.length) return avatarMap;

  const chunks = chunkArray(usernames, 10);
  try {
    for (const chunk of chunks) {
      if (!chunk.length) continue;
      const snap = await db.collection("users").where("username", "in", chunk).get();
      snap.forEach((docSnap) => {
        const data = docSnap.data() || {};
        const key = normalizeUsernameKey(data.username || "");
        if (!key) return;
        avatarMap.set(key, getAvatarUrlFromUserData(data));
      });
    }
  } catch (err) {
    console.warn("user-leaderboard avatar lookup failed:", err?.message || err);
  }

  return avatarMap;
}

function attachAvatarUrls(rows = [], avatarMap = new Map()) {
  if (!Array.isArray(rows) || !rows.length) return [];
  return rows.map((row) => {
    const usernameKey = normalizeUsernameKey(row?.username || "");
    const avatarUrl = usernameKey ? String(avatarMap.get(usernameKey) || "").trim() : "";
    return { ...row, profileImage: avatarUrl, avatarUrl };
  });
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method Not Allowed" })
    };
  }

  try {
    const limit = sanitizeLimit(event?.queryStringParameters?.limit);
    const nowMs = Date.now();
    const dailyStartMs = getKolkataStartOfDayMs(nowMs);
    const weeklyStartMs = nowMs - (7 * DAY_MS);
    const monthlyStartMs = nowMs - (30 * DAY_MS);
    const fetchStartMs = Math.min(dailyStartMs, weeklyStartMs, monthlyStartMs);

    const rows = await fetchOrdersSince(fetchStartMs);
    const dailyRows = buildLeaderboard(rows, dailyStartMs, limit);
    const weeklyRows = buildLeaderboard(rows, weeklyStartMs, limit);
    const monthlyRows = buildLeaderboard(rows, monthlyStartMs, limit);
    const avatarMap = await fetchAvatarMapForRows([dailyRows, weeklyRows, monthlyRows]);

    const payload = {
      generatedAt: nowMs,
      timezone: LEADERBOARD_TZ,
      daily: attachAvatarUrls(dailyRows, avatarMap),
      weekly: attachAvatarUrls(weeklyRows, avatarMap),
      monthly: attachAvatarUrls(monthlyRows, avatarMap)
    };

    return {
      statusCode: 200,
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60"
      },
      body: JSON.stringify(payload)
    };
  } catch (err) {
    console.error("user-leaderboard error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Leaderboard build failed"
      })
    };
  }
};
