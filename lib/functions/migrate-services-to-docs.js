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
const SERVICE_COLLECTION_ID = "services";
const PANEL_SERVICE_START = 100;

function response(statusCode, body) {
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

function parseBody(event) {
  if (!event?.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return {};
  }
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeServiceRow(raw = {}, fallbackId = "", forceActive = null) {
  const panelServiceId = String(
    raw.panelServiceId || raw.serviceId || fallbackId
  ).trim();

  if (!panelServiceId) return null;

  const active = typeof forceActive === "boolean"
    ? forceActive
    : raw.active !== false;

  return {
    ...(raw || {}),
    panelServiceId,
    serviceId: panelServiceId,
    active
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return response(200, { ok: true });
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return response(405, { error: "Method Not Allowed" });
  }

  try {
    const body = parseBody(event);
    const qs = event.queryStringParameters || {};

    const dryRun = parseBool(body.dryRun ?? qs.dryRun, false);
    const overwrite = parseBool(body.overwrite ?? qs.overwrite, false);
    const includeDeleted = parseBool(body.includeDeleted ?? qs.includeDeleted, true);

    const allSnap = await db.collection(SERVICE_COLLECTION_ID).get();

    const existingDocIds = new Set();
    const legacyMapDocs = [];
    let nextPanelServiceId = PANEL_SERVICE_START - 1;

    allSnap.forEach((docSnap) => {
      const data = docSnap.data() || {};
      const explicitId = String(data.panelServiceId || data.serviceId || "").trim();
      if (explicitId) {
        existingDocIds.add(explicitId);
        const numericId = toNumber(explicitId, 0);
        if (Number.isFinite(numericId) && numericId > nextPanelServiceId) {
          nextPanelServiceId = numericId;
        }
        return;
      }

      const servicesMap = data.services && typeof data.services === "object" ? data.services : null;
      if (!servicesMap) return;
      legacyMapDocs.push({
        docId: docSnap.id,
        servicesMap
      });
    });

    const merged = new Map();
    legacyMapDocs.forEach(({ servicesMap }) => {
      Object.entries(servicesMap || {}).forEach(([panelServiceId, raw]) => {
        const normalized = normalizeServiceRow(raw, panelServiceId, null);
        if (!normalized) return;
        merged.set(normalized.serviceId, normalized);
      });
    });

    let scanned = 0;
    let skippedDeleted = 0;
    let skippedExisting = 0;
    let toWrite = 0;

    const rowsForWrite = [];

    merged.forEach((row, serviceId) => {
      scanned += 1;
      if (row.deleted === true && !includeDeleted) {
        skippedDeleted += 1;
        return;
      }

      if (!overwrite && existingDocIds.has(serviceId)) {
        skippedExisting += 1;
        return;
      }

      const numericId = toNumber(serviceId, 0);
      if (Number.isFinite(numericId) && numericId > nextPanelServiceId) {
        nextPanelServiceId = numericId;
      }

      rowsForWrite.push([serviceId, row]);
      toWrite += 1;
    });

    const summary = {
      dryRun,
      overwrite,
      includeDeleted,
      legacyMapDocs: legacyMapDocs.length,
      scanned,
      toWrite,
      skippedDeleted,
      skippedExisting,
      nextPanelServiceId
    };

    if (!dryRun) {
      const chunkSize = 400;
      for (let index = 0; index < rowsForWrite.length; index += chunkSize) {
        const chunk = rowsForWrite.slice(index, index + chunkSize);
        const batch = db.batch();

        chunk.forEach(([serviceId, row]) => {
          batch.set(db.collection(SERVICE_COLLECTION_ID).doc(serviceId), {
            ...(row || {}),
            panelServiceId: serviceId,
            serviceId,
            active: row.active !== false,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        });

        await batch.commit();
      }
    }

    return response(200, {
      success: true,
      message: dryRun
        ? "Dry run completed. No writes were made."
        : "Services migrated to individual service documents.",
      summary
    });
  } catch (err) {
    console.error("migrate-services-to-docs error:", err);
    return response(500, {
      success: false,
      error: err.message || "Migration failed"
    });
  }
};
