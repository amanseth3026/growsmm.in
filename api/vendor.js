// netlify/functions/vendor.js

// ===============================
// VENDOR-WISE IN-MEMORY CACHE
// ===============================
let serviceCache = {};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ===============================
// MAIN HANDLER
// ===============================
exports.handler = async (event) => {
  try {
    // ===============================
    // CORS PREFLIGHT
    // ===============================
    if (event.httpMethod === "OPTIONS") {
      return response(200, { ok: true });
    }

    // ===============================
    // Method check
    // ===============================
    if (event.httpMethod !== "POST") {
      return response(405, { error: "Method Not Allowed" });
    }

    // ===============================
    // Parse body safely
    // ===============================
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return response(400, { error: "Invalid JSON body" });
    }

    const { key, url, action, forceRefresh } = body;

    if (!key || !url || !action) {
      return response(400, { error: "Missing key, url or action" });
    }

    // ===============================
    // 🔥 SERVICES (WITH NORMALIZATION + CACHE)
    // ===============================
    if (action === "services") {
      const now = Date.now();
      const cacheKey = `${url}::${key}`;

      // 🔄 Force refresh support
      if (forceRefresh === true) {
        delete serviceCache[cacheKey];
      }

      // ✅ Cache hit
      if (
        serviceCache[cacheKey] &&
        now - serviceCache[cacheKey].time < CACHE_TTL
      ) {
        return response(200, {
          success: true,
          cached: true,
          vendor: url,
          data: serviceCache[cacheKey].data,
        });
      }

      // ❌ Cache miss → Call vendor API
      const payload = new URLSearchParams({
        key,
        action: "services",
      });

      const vendorRes = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: payload.toString(),
      });

      const raw = await safeParse(vendorRes);

      // 🔥 Normalize vendor response safely
      let list = [];
      if (Array.isArray(raw)) {
        list = raw;
      } else if (Array.isArray(raw?.data)) {
        list = raw.data;
      } else if (Array.isArray(raw?.services)) {
        list = raw.services;
      } else if (typeof raw === "object") {
        list = Object.values(raw);
      }

      const normalized = list.map(normalizeService);

      // ✅ Store ONLY normalized data in cache
      serviceCache[cacheKey] = {
        data: normalized,
        time: now,
      };

      return response(200, {
        success: true,
        cached: false,
        vendor: url,
        data: normalized,
      });
    }

    // ===============================
    // 🔹 OTHER ACTIONS (NO CACHE)
    // ===============================
    const payload = new URLSearchParams({
      key,
      action,
    });

    [
      "service",
      "link",
      "quantity",
      "order",
      "orders",
      "comments",
      "refill",
      "refills"
    ].forEach((field) => {
      if (body[field] !== undefined) {
        payload.append(field, String(body[field]));
      }
    });

    const vendorRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: payload.toString(),
    });

    const data = await safeParse(vendorRes);

    return response(200, {
      success: true,
      vendor: url,
      action,
      data,
    });

  } catch (err) {
    console.error("❌ Vendor Function Error:", err);
    return response(500, {
      success: false,
      error: "Vendor function failed",
      message: err.message,
    });
  }
};

// ===============================
// 🔧 HELPERS
// ===============================

// 🔥 SERVICE NORMALIZER (CORE FIX)
function toCleanString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function pickFirstFilled(values) {
  for (const value of values) {
    const clean = toCleanString(value);
    if (clean) return clean;
  }
  return "";
}

function extractAverageTime(s) {
  if (!s || typeof s !== "object") return "";

  const direct = pickFirstFilled([
    s.average_time,
    s.avg_time,
    s.time,
    s.delivery_time,
    s.speed,
    s.averageTime,
    s.avgTime,
    s.estimated_time,
    s.estimatedTime,
    s.average_delivery_time,
    s["average time"],
    s["avg time"],
    s["delivery time"],
    s["Average Time"],
    s["AVG TIME"]
  ]);
  if (direct) return direct;

  const entries = Object.entries(s);
  const preferred = entries.find(([key, val]) => {
    const k = String(key || "").toLowerCase();
    const v = toCleanString(val);
    return !!v && /(avg|average)/.test(k) && /time|delivery|speed/.test(k);
  });
  if (preferred) return toCleanString(preferred[1]);

  const broad = entries.find(([key, val]) => {
    const k = String(key || "").toLowerCase();
    const v = toCleanString(val);
    return !!v && /(time|delivery|speed)/.test(k);
  });
  return broad ? toCleanString(broad[1]) : "";
}

function normalizeService(s) {
  const normalizedType = String(
    pickFirstFilled([s.type, s.service_type, s.serviceType, "Default"])
  ).trim() || "Default";
  const normalizedAvgTime = extractAverageTime(s);
  const serviceId = pickFirstFilled([
    s.service,
    s.serviceId,
    s.service_id,
    s.vendorServiceId,
    s.id
  ]);
  const normalizedName = pickFirstFilled([
    s.name,
    s.title,
    s.service_name,
    s.serviceName,
    s.service_title,
    s.serviceTitle
  ]) || "Unnamed Service";
  const normalizedCategory = pickFirstFilled([
    s.category,
    s.category_name,
    s.categoryName,
    s.cat,
    s.group,
    s.group_name,
    s.service_category,
    s.serviceCategory
  ]) || "General";

  return {
    // IDs
    service: serviceId,
    serviceId,
    vendorServiceId: serviceId,
    id: serviceId,

    // Name & category
    name: normalizedName,
    title: normalizedName,
    serviceName: normalizedName,
    category: normalizedCategory,
    serviceCategory: normalizedCategory,
    type: normalizedType,

    // Pricing
    rate: Number(s.rate ?? s.price ?? s.cost ?? 0),
    min: Number(s.min ?? s.minimum ?? s.minQty ?? 0),
    max: Number(s.max ?? s.maximum ?? s.maxQty ?? 0),

    // 🔥 DESCRIPTION (ALL VARIANTS COVERED)
    description:
      pickFirstFilled([
        s.description,
        s.desc,
        s.details,
        s.service_description,
        s.serviceDescription
      ]) ||
      "No description available",

    // 🔥 AVERAGE TIME (ALL VARIANTS COVERED)
    average_time: normalizedAvgTime,
    time: normalizedAvgTime,

    // Optional flags (safe)
    refill: s.refill ?? false,
    cancel: s.cancel ?? false,
  };
}

// Safe JSON parser
async function safeParse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// Standard response wrapper
function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}
