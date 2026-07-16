import {
  collection,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

export const SERVICE_COLLECTION_ID = "services";
export const PANEL_SERVICE_START = 100;

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isValidPanelServiceId(value) {
  return /^\d+$/.test(String(value || "").trim());
}

export function normalizeServiceRecord(raw = {}, fallbackDocId = "", forceActive = null) {
  const panelServiceId = String(raw.panelServiceId || raw.serviceId || fallbackDocId || "").trim();
  if (!isValidPanelServiceId(panelServiceId)) return null;

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

export async function readAllServiceDocsFromCollection(db, { includeDeleted = false } = {}) {
  const snap = await getDocs(collection(db, SERVICE_COLLECTION_ID));
  const rowsById = new Map();

  snap.forEach((docSnap) => {
    const raw = docSnap.data() || {};
    if (raw && typeof raw.services === "object") return;
    const normalized = normalizeServiceRecord(raw, docSnap.id);
    if (!normalized) return;
    if (!includeDeleted && normalized.deleted === true) return;
    rowsById.set(normalized.serviceId, normalized);
  });

  let nextPanelServiceId = PANEL_SERVICE_START - 1;
  rowsById.forEach((row) => {
    const numericId = toNumber(row.serviceId, 0);
    if (Number.isFinite(numericId) && numericId > nextPanelServiceId) {
      nextPanelServiceId = numericId;
    }
  });

  return {
    servicesById: Object.fromEntries(rowsById.entries()),
    rows: Array.from(rowsById.values()),
    nextPanelServiceId,
    defaultProfit: 0
  };
}
