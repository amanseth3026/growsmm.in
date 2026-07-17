const fetch = require("node-fetch");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (
    !process.env.FIREBASE_PROJECT_ID ||
    !process.env.FIREBASE_CLIENT_EMAIL ||
    !privateKey
  ) {
    throw new Error("Missing Firebase ENV variables");
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey
    })
  });
}

const db = admin.firestore();

const __SVC_COLLECTION_ID = "services";
const __SVC_PANEL_START = 100;

function __svcToNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function __svcIsValidPanelServiceId(value) {
  return /^\d+$/.test(String(value || "").trim());
}

function __svcNormalizeServiceRecord(raw = {}, fallbackDocId = "", forceActive = null) {
  const panelServiceId = String(raw.panelServiceId || raw.serviceId || fallbackDocId || "").trim();
  if (!__svcIsValidPanelServiceId(panelServiceId)) return null;

  const active = typeof forceActive === "boolean"
    ? forceActive
    : raw.active !== false;

  return {
    ...(raw || {}),
    docId: panelServiceId,
    panelServiceId,
    serviceId: panelServiceId,
    active
  };
}

async function readAllServiceDocsFromCollection(dbConn, { includeDeleted = false } = {}) {
  const snap = await dbConn.collection(__SVC_COLLECTION_ID).get();
  const rowsById = new Map();

  snap.forEach((docSnap) => {
    const raw = docSnap.data() || {};
    if (raw && typeof raw.services === "object") return;
    const normalized = __svcNormalizeServiceRecord(raw, docSnap.id);
    if (!normalized) return;
    if (!includeDeleted && normalized.deleted === true) return;
    rowsById.set(normalized.serviceId, normalized);
  });

  let nextPanelServiceId = __SVC_PANEL_START - 1;
  rowsById.forEach((row) => {
    const numericId = __svcToNumber(row.serviceId, 0);
    if (Number.isFinite(numericId) && numericId > nextPanelServiceId) {
      nextPanelServiceId = numericId;
    }
  });

  return {
    rows: Array.from(rowsById.values()),
    servicesById: Object.fromEntries(rowsById.entries()),
    nextPanelServiceId,
    defaultProfit: 0
  };
}

function corsResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };
}

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

function extractAverageTime(service) {
  if (!service || typeof service !== "object") return "";

  const direct = pickFirstFilled([
    service.average_time,
    service.avg_time,
    service.time,
    service.averageTime,
    service.avgTime,
    service.estimated_time,
    service.estimatedTime,
    service.average_delivery_time,
    service.delivery_time,
    service.speed,
    service["average time"],
    service["avg time"],
    service["delivery time"],
    service["Average Time"],
    service["AVG TIME"]
  ]);
  if (direct) return direct;

  const fallback = Object.entries(service).find(([key, value]) => {
    const clean = toCleanString(value);
    if (!clean) return false;
    const k = String(key || "").toLowerCase();
    return /(avg|average)/.test(k) && /(time|delivery|speed)/.test(k);
  });

  return fallback ? toCleanString(fallback[1]) : "";
}

function normalizeVendorService(service, vendorId) {
  const serviceId = String(service.service ?? service.vendorServiceId ?? "").trim();
  if (!serviceId) return null;

  return {
    serviceId,
    vendorId,
    name: service.name || service.title || "Unnamed Service",
    category: service.category || "Other",
    description: service.description || service.desc || "No description available",
    type: String(service.type || service.serviceType || "Default").trim() || "Default",
    rate: Number(service.rate || 0),
    min: Number(service.min || 0),
    max: Number(service.max || 0),
    avgTime: extractAverageTime(service)
  };
}

async function fetchVendorServices(baseUrl, vendorId, vendor) {
  if (!vendor?.key || !vendor?.url) return [];

  try {
    const res = await fetch(`${baseUrl}/api/vendor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "services",
        key: vendor.key,
        url: vendor.url
      })
    });

    if (!res.ok) return [];
    const payload = await res.json();
    let services = payload?.data || [];
    if (!Array.isArray(services) && services && typeof services === "object") {
      services = Object.values(services);
    }

    if (!Array.isArray(services)) return [];

    return services
      .map((service) => normalizeVendorService(service, vendorId))
      .filter(Boolean);
  } catch (error) {
    console.error(`public-services: vendor fetch failed (${vendorId})`, error.message);
    return [];
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return corsResponse(200, { ok: true });
    }
    if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
      return corsResponse(405, { error: "Method Not Allowed" });
    }

    const [serviceStore, vendorSnap, manualSnap] = await Promise.all([
      readAllServiceDocsFromCollection(db, {
        includeDeleted: false
      }),
      db.collection("vendors").get(),
      db.collection("manual_services").get()
    ]);
    const defaultProfit = Number(serviceStore.defaultProfit || 0);
    const configuredRows = serviceStore.rows.filter((row) => row.deleted !== true && row.active !== false);

    const vendors = {};
    vendorSnap.forEach((docSnap) => {
      vendors[docSnap.id] = docSnap.data() || {};
    });

    const baseUrl = process.env.SITE_URL || process.env.URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
    const vendorIds = Object.keys(vendors);
    const vendorResults = await Promise.all(
      vendorIds.map((vendorId) => fetchVendorServices(baseUrl, vendorId, vendors[vendorId]))
    );

    const allRemoteServices = vendorResults.flat();
    const lookupByVendorAndId = new Map();
    const lookupById = new Map();

    allRemoteServices.forEach((service) => {
      const key = `${service.vendorId}::${service.serviceId}`;
      lookupByVendorAndId.set(key, service);
      if (!lookupById.has(service.serviceId)) lookupById.set(service.serviceId, service);
    });

    const output = [];

    configuredRows.forEach((conf) => {
      if (conf?.deleted === true || conf?.active === false) return;
      const panelServiceId = String(conf?.panelServiceId || conf?.serviceId || "").trim();
      if (!panelServiceId) return;

      const vendorServiceId = String(conf?.vendorServiceId || panelServiceId).trim();
      const preferredVendorId = String(conf?.vendorId || "").trim();

      const selected = preferredVendorId
        ? lookupByVendorAndId.get(`${preferredVendorId}::${vendorServiceId}`)
        : lookupById.get(String(vendorServiceId));

      if (!selected) return;

      const effectiveVendorId = preferredVendorId || selected.vendorId;
      const vendor = vendors[effectiveVendorId] || {};

      let baseRateInr = Number(selected.rate || 0);
      if (String(vendor.currency || "INR").toUpperCase() === "USD") {
        baseRateInr = baseRateInr * (Number(vendor.exchangeRate) || 1);
      }

      const serviceProfit = Number(conf?.profit ?? defaultProfit);
      const rateInr = Number((baseRateInr * (1 + serviceProfit / 100)).toFixed(4));

      output.push({
        id: String(panelServiceId),
        displayId: String(panelServiceId),
        name: selected.name,
        title: selected.name,
        category: selected.category || "Other",
        description: selected.description || "No description available",
        type: selected.type || "Default",
        min: Number(selected.min || 0),
        max: Number(selected.max || 0),
        rateInr,
        avgTime: selected.avgTime || "",
        source: "vendor"
      });
    });

    manualSnap.forEach((docSnap) => {
      const manual = docSnap.data() || {};
      if (manual.active === false) return;

      output.push({
        id: `manual_${docSnap.id}`,
        displayId: String(docSnap.id),
        name: manual.title || "Manual Service",
        title: manual.title || "Manual Service",
        category: manual.category || "Manual",
        description: manual.description || "No description available",
        type: manual.type || "Manual",
        min: Number(manual.minQty || 0),
        max: Number(manual.maxQty || 0),
        rateInr: Number(manual.userPrice || 0),
        avgTime: manual.avgTime || "",
        source: "manual"
      });
    });

    output.sort((a, b) => {
      const byCategory = a.category.localeCompare(b.category);
      if (byCategory !== 0) return byCategory;
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) return byName;
      return a.displayId.localeCompare(b.displayId);
    });

    const usdRates = vendorIds
      .map((vendorId) => vendors[vendorId])
      .filter((vendor) => String(vendor?.currency || "INR").toUpperCase() === "USD")
      .map((vendor) => Number(vendor?.exchangeRate || 0))
      .filter((rate) => Number.isFinite(rate) && rate > 0);

    const usdRate = Number(process.env.PUBLIC_USD_RATE || usdRates[0] || 83);

    return corsResponse(200, {
      services: output,
      usdRate,
      generatedAt: Date.now()
    });
  } catch (error) {
    console.error("public-services error:", error);
    return corsResponse(500, { error: error.message || "Failed to load services" });
  }
};



