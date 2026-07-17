const fetch = require("node-fetch");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey
    })
  });
}

const db = admin.firestore();
const SERVICE_COLLECTION_ID = "services";

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

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, x-sync-key",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return {};
  }
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function getSyncSecret() {
  return String(
    process.env.PANEL_SYNC_SECRET ||
    process.env.AUTO_SYNC_SECRET ||
    process.env.ORDER_SYNC_SECRET ||
    process.env.CRON_SECRET_KEY ||
    ""
  ).trim();
}

function getProvidedKey(event, body) {
  const qs = event?.queryStringParameters || {};
  const headers = event?.headers || {};
  return String(
    qs.key ||
    body?.key ||
    headers["x-sync-key"] ||
    headers["X-Sync-Key"] ||
    ""
  ).trim();
}

function isScheduledInvocation(event) {
  const headers = event?.headers || {};
  const nfEvent = String(headers["x-nf-event"] || headers["X-Nf-Event"] || "").toLowerCase();
  return nfEvent === "schedule";
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeCurrency(value, fallback = "INR") {
  const clean = String(value || fallback).trim().toUpperCase();
  return clean || fallback;
}

function getServiceCurrencyConfig(vendor = {}, local = {}) {
  return {
    currency: normalizeCurrency(local.currency || vendor.currency || "INR"),
    exchangeRate: toNumber(local.exchangeRate, toNumber(vendor.exchangeRate, 1)) || 1
  };
}

function convertVendorRateToInr(vendorRate, currency, exchangeRate) {
  let inr = toNumber(vendorRate, 0);
  if (normalizeCurrency(currency) === "USD") {
    inr = inr * (toNumber(exchangeRate, 1) || 1);
  }
  return Number(inr.toFixed(4));
}

function calcUserPrice(vendorRate, profit, currency, exchangeRate) {
  const baseRateInr = convertVendorRateToInr(vendorRate, currency, exchangeRate);
  return Number((baseRateInr * (1 + toNumber(profit, 0) / 100)).toFixed(4));
}

function normalizeCategoryName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeService(raw = {}) {
  const serviceId = String(raw.service ?? raw.vendorServiceId ?? raw.id ?? "").trim();
  if (!serviceId) return null;

  return {
    serviceId,
    name: String(raw.name || "Unnamed Service").trim() || "Unnamed Service",
    category: normalizeCategoryName(raw.category) || "General",
    type: String(raw.type || raw.serviceType || raw.service_type || "Default").trim() || "Default",
    description: String(raw.description || raw.desc || "No description available").trim() || "No description available",
    min: toNumber(raw.min, 0),
    max: toNumber(raw.max, 0),
    rate: toNumber(raw.rate, 0)
  };
}

async function fetchVendorServices(baseUrl, vendor, forceRefresh) {
  const res = await fetch(`${baseUrl}/api/vendor`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "services",
      key: vendor.key,
      url: vendor.url,
      forceRefresh
    })
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.success === false) {
    const message = payload?.error || payload?.message || `Vendor fetch failed (${res.status})`;
    throw new Error(message);
  }

  let list = payload?.data || [];
  if (!Array.isArray(list) && list && typeof list === "object") {
    list = Object.values(list);
  }
  if (!Array.isArray(list)) list = [];

  return list.map(normalizeService).filter(Boolean);
}

function isServicePriceChanged(local, nextPricing) {
  return (
    toNumber(local.rate, 0) !== toNumber(nextPricing.rate, 0) ||
    toNumber(local.vendorPrice, 0) !== toNumber(nextPricing.vendorPrice, 0) ||
    toNumber(local.userPrice, 0) !== toNumber(nextPricing.userPrice, 0) ||
    toNumber(local.rateInr, 0) !== toNumber(nextPricing.rateInr, 0) ||
    normalizeCurrency(local.currency || "INR") !== normalizeCurrency(nextPricing.currency || "INR") ||
    toNumber(local.exchangeRate, 1) !== toNumber(nextPricing.exchangeRate, 1)
  );
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return response(200, { ok: true });
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return response(405, { error: "Method Not Allowed" });
  }

  try {
    const body = parseBody(event);
    const qs = event.queryStringParameters || {};
    const scheduled = isScheduledInvocation(event);

    const expectedKey = getSyncSecret();
    if (!scheduled && expectedKey && getProvidedKey(event, body) !== expectedKey) {
      return response(401, { success: false, error: "Unauthorized" });
    }

    const forceRefresh = parseBool(body.forceRefresh ?? qs.forceRefresh, true);
    const vendorFilter = String(body.vendorId ?? qs.vendorId ?? "").trim();

    const baseUrl = process.env.SITE_URL || process.env.URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");

    let vendorDocs = [];
    if (vendorFilter) {
      const oneVendor = await db.collection("vendors").doc(vendorFilter).get();
      if (!oneVendor.exists) {
        return response(404, { success: false, error: `Vendor not found: ${vendorFilter}` });
      }
      vendorDocs = [oneVendor];
    } else {
      const vendorsSnap = await db.collection("vendors").get();
      vendorDocs = vendorsSnap.docs;
    }

    if (!vendorDocs.length) {
      return response(200, {
        success: true,
        message: "No vendors found",
        summary: {
          vendorsProcessed: 0,
          vendorsSkipped: 0,
          servicesScanned: 0,
          updated: 0,
          disabled: 0,
          reenabled: 0,
          unchanged: 0,
          activeMapDisabled: 0
        },
        vendors: [],
        errors: []
      });
    }

    const serviceStore = await readAllServiceDocsFromCollection(db, {
      includeDeleted: true
    });
    const activeMap = {};
    serviceStore.rows.forEach((row) => {
      const serviceId = String(row?.panelServiceId || row?.serviceId || row?.docId || "").trim();
      if (!serviceId) return;
      activeMap[serviceId] = {
        ...(row || {}),
        panelServiceId: serviceId,
        serviceId
      };
    });

    let activeMapChanged = false;
    const changedServiceIds = new Set();

    const summary = {
      vendorsProcessed: 0,
      vendorsSkipped: 0,
      servicesScanned: 0,
      updated: 0,
      disabled: 0,
      reenabled: 0,
      unchanged: 0,
      activeMapDisabled: 0
    };
    const vendorResults = [];
    const errors = [];

    for (const vendorDoc of vendorDocs) {
      const vendorId = vendorDoc.id;
      const vendor = vendorDoc.data() || {};
      const vendorName = String(vendor.name || "Vendor").trim() || "Vendor";
      const vendorSummary = {
        vendorId,
        vendorName,
        scanned: 0,
        updated: 0,
        disabled: 0,
        reenabled: 0,
        unchanged: 0
      };

      if (!vendor.url || !vendor.key) {
        summary.vendorsSkipped += 1;
        errors.push(`Vendor ${vendorName} (${vendorId}) is missing url/key`);
        vendorResults.push(vendorSummary);
        continue;
      }

      let remoteList = [];
      try {
        remoteList = await fetchVendorServices(baseUrl, vendor, forceRefresh);
      } catch (err) {
        summary.vendorsSkipped += 1;
        errors.push(`Vendor ${vendorName} (${vendorId}) sync failed: ${err.message}`);
        vendorResults.push(vendorSummary);
        continue;
      }

      const remoteByServiceId = new Map(remoteList.map((svc) => [svc.serviceId, svc]));
      const localEntries = Object.entries(activeMap).filter(([, row]) =>
        String(row.vendorId || "").trim() === vendorId && row?.deleted !== true
      );

      for (const [panelServiceIdRaw, localRow] of localEntries) {
        const panelServiceId = String(panelServiceIdRaw || localRow?.panelServiceId || localRow?.serviceId || "").trim();
        const local = localRow || {};
        const vendorServiceId = String(local.vendorServiceId || local.service || local.serviceId || "").trim();
        if (!panelServiceId || !vendorServiceId) continue;

        vendorSummary.scanned += 1;
        summary.servicesScanned += 1;

        const remote = remoteByServiceId.get(vendorServiceId);
        if (remote) {
          const localIsActive = local.active !== false;
          const nextRate = toNumber(remote.rate, 0);
          const serviceProfit = toNumber(
            local.profit,
            toNumber(activeMap[panelServiceId]?.profit, 0)
          );
          const { currency, exchangeRate } = getServiceCurrencyConfig(vendor, local);
          const nextUserPrice = calcUserPrice(nextRate, serviceProfit, currency, exchangeRate);
          const nextPricing = {
            rate: nextRate,
            vendorPrice: nextRate,
            userPrice: nextUserPrice,
            rateInr: nextUserPrice,
            currency,
            exchangeRate
          };
          const next = {
            ...local,
            panelServiceId,
            serviceId: panelServiceId,
            vendorServiceId,
            vendorId,
            vendorName,
            ...nextPricing,
            active: localIsActive,
            syncStatus: "ok",
            lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          };
          if (localIsActive) {
            delete next.disabledReason;
            delete next.disabledAt;
          } else {
            next.disabledReason = local.disabledReason || "manual_disabled";
            next.disabledAt = local.disabledAt || admin.firestore.FieldValue.serverTimestamp();
          }

          const pricingChanged = isServicePriceChanged(local, nextPricing);
          const metadataChanged =
            String(local.vendorId || "").trim() !== vendorId ||
            String(local.vendorServiceId || local.service || local.serviceId || "").trim() !== vendorServiceId ||
            String(local.syncStatus || "") !== "ok" ||
            String(local.vendorName || "").trim() !== vendorName;

          activeMap[panelServiceId] = next;
          activeMapChanged = true;
          changedServiceIds.add(panelServiceId);

          if (pricingChanged || metadataChanged || !localRow) {
            vendorSummary.updated += 1;
            summary.updated += 1;
          } else {
            vendorSummary.unchanged += 1;
            summary.unchanged += 1;
          }
          continue;
        }

        const wasActive = local.active !== false;
        const next = {
          ...local,
          panelServiceId,
          serviceId: panelServiceId,
          vendorServiceId,
          vendorId,
          vendorName,
          active: false,
          syncStatus: "missing_on_vendor",
          disabledReason: "missing_on_vendor",
          disabledAt: local.disabledAt || admin.firestore.FieldValue.serverTimestamp(),
          lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        activeMap[panelServiceId] = next;
        activeMapChanged = true;
        changedServiceIds.add(panelServiceId);

        if (wasActive || String(local.syncStatus || "") !== "missing_on_vendor") {
          vendorSummary.disabled += 1;
          summary.disabled += 1;
          if (wasActive) {
            summary.activeMapDisabled += 1;
          }
        } else {
          vendorSummary.unchanged += 1;
          summary.unchanged += 1;
        }
      }

      summary.vendorsProcessed += 1;
      vendorResults.push(vendorSummary);
    }

    if (activeMapChanged) {
      const changedIds = Array.from(changedServiceIds.values());
      const chunkSize = 400;

      for (let index = 0; index < changedIds.length; index += chunkSize) {
        const chunk = changedIds.slice(index, index + chunkSize);
        const batch = db.batch();

        chunk.forEach((serviceId) => {
          const cleanId = String(serviceId || "").trim();
          if (!cleanId) return;
          const row = activeMap[cleanId] || {};

          batch.set(db.collection(SERVICE_COLLECTION_ID).doc(cleanId), {
            ...(row || {}),
            panelServiceId: cleanId,
            serviceId: cleanId,
            active: row.active !== false,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        });

        await batch.commit();
      }

    }

    return response(200, {
      success: true,
      scheduled,
      forceRefresh,
      vendorFilter: vendorFilter || null,
      generatedAt: Date.now(),
      summary,
      vendors: vendorResults,
      errors
    });
  } catch (err) {
    console.error("auto-sync-services error:", err);
    return response(500, {
      success: false,
      error: err.message || "Failed to sync services"
    });
  }
};



