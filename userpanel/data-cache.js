const CACHE_PREFIX = "smm_up_cache_v15";

export const CacheTTL = {
  panelSettings: 5 * 60 * 1000,
  userSummary: 2 * 60 * 1000,
  orderCount: 60 * 1000,
  orders: 60 * 1000,
  payments: 60 * 1000,
  broadcasts: 60 * 1000,
  authGuard: 90 * 1000
};

function buildKey(key) {
  return `${CACHE_PREFIX}:${String(key || "").trim()}`;
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

export function readCache(key, { maxAgeMs = 0 } = {}) {
  try {
    const raw = localStorage.getItem(buildKey(key));
    if (!raw) return null;

    const parsed = safeParse(raw);
    if (!parsed || typeof parsed !== "object") return null;

    const ts = Number(parsed.ts || 0);
    if (!ts) return null;

    if (maxAgeMs > 0 && Date.now() - ts > maxAgeMs) {
      return null;
    }

    return parsed.data ?? null;
  } catch {
    return null;
  }
}

export function writeCache(key, data) {
  try {
    const payload = { ts: Date.now(), data };
    localStorage.setItem(buildKey(key), JSON.stringify(payload));
  } catch {
    // Ignore quota / storage errors to keep runtime safe.
  }
}

export function clearCache(key) {
  try {
    localStorage.removeItem(buildKey(key));
  } catch {
    // no-op
  }
}

export function panelSettingsKey() {
  return "panel_settings";
}

export function userSummaryKey(username) {
  return `user_summary:${normalizeUsername(username) || "guest"}`;
}

export function orderCountKey(username) {
  return `order_count:${normalizeUsername(username) || "guest"}`;
}

export function ordersKey(username) {
  return `orders:${normalizeUsername(username) || "guest"}`;
}

export function paymentsKey(username) {
  return `payments:${normalizeUsername(username) || "guest"}`;
}

export function broadcastsKey() {
  return "broadcasts_all";
}

export function authGuardKey(uidOrEmail) {
  return `auth_guard:${String(uidOrEmail || "").trim().toLowerCase() || "anon"}`;
}
