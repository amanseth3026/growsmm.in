export function normalizeCategoryName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

const CATEGORY_ORDER_CACHE_KEY = "growsmm_category_order_cache_v1";
const CATEGORY_ORDER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function categoryKey(value) {
  return normalizeCategoryName(value).toLowerCase();
}

function readCategoryOrderCacheEntry({ allowExpired = false } = {}) {
  try {
    const raw = localStorage.getItem(CATEGORY_ORDER_CACHE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const ts = Number(parsed?.ts || 0);
    if (!ts) return null;

    if (!allowExpired && Date.now() - ts > CATEGORY_ORDER_CACHE_TTL_MS) {
      return null;
    }

    const categories = Array.isArray(parsed?.categories)
      ? parsed.categories
      : Array.isArray(parsed?.data)
        ? parsed.data
        : [];

    return mergeCategoryOrder(categories, []);
  } catch {
    return null;
  }
}

export function readCachedCategoryOrder() {
  return readCategoryOrderCacheEntry();
}

export function writeCategoryOrderCache(categories = []) {
  const ordered = mergeCategoryOrder(categories, []);
  try {
    localStorage.setItem(
      CATEGORY_ORDER_CACHE_KEY,
      JSON.stringify({
        ts: Date.now(),
        categories: ordered,
      })
    );
  } catch {
    // Ignore storage failures.
  }
  return ordered;
}

export function clearCategoryOrderCache() {
  try {
    localStorage.removeItem(CATEGORY_ORDER_CACHE_KEY);
  } catch {
    // no-op
  }
}

export function mergeCategoryOrder(preferredOrder = [], availableNames = []) {
  const ordered = [];
  const seen = new Set();

  for (const value of preferredOrder) {
    const clean = normalizeCategoryName(value);
    if (!clean) continue;
    const key = categoryKey(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(clean);
  }

  const extras = [];
  const extraSeen = new Set();

  for (const value of availableNames) {
    const clean = normalizeCategoryName(value);
    if (!clean) continue;
    const key = categoryKey(clean);
    if (seen.has(key) || extraSeen.has(key)) continue;
    extraSeen.add(key);
    extras.push(clean);
  }

  extras.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return [...ordered, ...extras];
}
