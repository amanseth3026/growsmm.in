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
const { FieldValue } = admin.firestore;

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

const ORDER_COLLECTIONS = {
  active: "orders_active",
  completed: "orders_completed",
  canceled: "orders_cancel",
  partial: "orders_partial",
  legacy: "orders"
};
const PRIZE_ORDER_COLLECTION = "prize_orders";

const STATUS_MAP = {
  pending: "pending",
  processing: "processing",
  "in progress": "in progress",
  inprogress: "in progress",
  "in-progress": "in progress",
  queued: "processing",
  queue: "processing",
  completed: "completed",
  complete: "completed",
  partial: "partial",
  canceled: "canceled",
  cancelled: "canceled"
};

const TERMINAL_TO_COLLECTION = {
  completed: ORDER_COLLECTIONS.completed,
  partial: ORDER_COLLECTIONS.partial,
  canceled: ORDER_COLLECTIONS.canceled
};

const TERMINAL_STATES = Object.keys(TERMINAL_TO_COLLECTION);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-sync-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json"
};

const normalize = (v) => String(v || "").toLowerCase().trim();

function respond(statusCode, body) {
  return {
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(body)
  };
}

function parseBody(event) {
  if (!event?.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    try {
      const params = new URLSearchParams(event.body);
      return Object.fromEntries(params.entries());
    } catch {
      return {};
    }
  }
}

function toMillis(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value?.toMillis === "function") return value.toMillis();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDuration(msInput) {
  const totalMinutes = Math.max(0, Math.round(Number(msInput || 0) / 60000));
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!minutes) return `${hours} hr`;
  return `${hours} hr ${minutes} min`;
}

function buildCompletionFields(order, completedAtMs = Date.now()) {
  const effectiveCompletedAt = toMillis(order?.completedAt) || completedAtMs;
  const orderPlacedAt =
    toMillis(order?.orderPlacedAt) ||
    toMillis(order?.processingStartedAt) ||
    toMillis(order?.createdAt) ||
    effectiveCompletedAt;
  const processingStartedAt = toMillis(order?.processingStartedAt) || orderPlacedAt;

  const completionDurationMs = Math.max(effectiveCompletedAt - processingStartedAt, 0);

  return {
    orderPlacedAt,
    processingStartedAt,
    completedAt: effectiveCompletedAt,
    completionDurationMs,
    completionDurationMinutes: Number((completionDurationMs / 60000).toFixed(2))
  };
}

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(4));
}

function getStoredRefundTotal(order = {}) {
  return roundMoney(Math.max(
    Number(order.refundAppliedTotal || 0),
    Number(order.refund || 0),
    Number(order.refundedAmount || 0)
  ));
}

function getSyncSecret() {
  return String(
    process.env.ORDER_SYNC_SECRET ||
    process.env.STATUS_CHECK_SECRET ||
    process.env.CRON_SECRET_KEY ||
    ""
  ).trim();
}

function getProvidedKey(event, body) {
  const query = event?.queryStringParameters || {};
  const headers = event?.headers || {};
  return String(
    query.key ||
    body?.key ||
    headers["x-sync-key"] ||
    headers["X-Sync-Key"] ||
    ""
  ).trim();
}

function isAuthorizedRequest(event, body) {
  const secret = getSyncSecret();
  if (!secret) return true;
  return getProvidedKey(event, body) === secret;
}

function getArchiveCollectionByStatus(status) {
  return TERMINAL_TO_COLLECTION[normalize(status)] || null;
}

function mapPrizeDeliveryStatus(status) {
  const clean = normalize(status);
  if (clean === "completed") return "sent";
  if (clean === "canceled" || clean === "partial") return "failed";
  return "pending";
}

async function syncPrizeOrderStatuses() {
  const snap = await db
    .collection(PRIZE_ORDER_COLLECTION)
    .orderBy("createdAt", "desc")
    .limit(300)
    .get();

  if (snap.empty) return { updated: 0 };

  let updated = 0;

  for (const docSnap of snap.docs) {
    const row = docSnap.data() || {};
    const mode = normalize(row.mode || "");
    const currentStatus = normalize(row.status || "pending");
    const vendorId = String(row.vendorId || "").trim();
    const vendorOrderId = String(row.vendorOrderId || "").trim();

    if (mode !== "vendor_auto" || !vendorId || !vendorOrderId) continue;
    if (currentStatus === "completed" || currentStatus === "canceled") continue;

    const vendorSnap = await db.collection("vendors").doc(vendorId).get();
    if (!vendorSnap.exists) continue;

    const vendor = vendorSnap.data() || {};
    if (!vendor.url || !vendor.key) continue;

    const form = new URLSearchParams();
    form.append("key", vendor.key);
    form.append("action", "status");
    form.append("order", vendorOrderId);

    let response = null;
    try {
      const res = await fetch(vendor.url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString()
      });
      response = await res.json();
    } catch {
      continue;
    }

    if (!response || typeof response !== "object") continue;

    const vendorStatusRaw = normalize(response.status);
    const finalStatus = STATUS_MAP[vendorStatusRaw] || currentStatus || "pending";
    const remains = Number(response.remains || 0);
    const startCount =
      response.start_count ||
      response.startCounter ||
      response.start ||
      response.start_counter ||
      row.startCount ||
      "-";

    const payload = {
      status: finalStatus,
      remains,
      startCount,
      vendorStatusRaw,
      updatedAt: FieldValue.serverTimestamp()
    };

    if (finalStatus === "completed") {
      payload.completedAt = Date.now();
    }

    await docSnap.ref.set(payload, { merge: true });
    updated += 1;

    const winnerId = String(row.winnerId || "").trim();
    if (!winnerId) continue;

    const delivery = mapPrizeDeliveryStatus(finalStatus);
    const winnerPayload = {
      delivery,
      updatedAt: Date.now()
    };
    if (delivery === "sent") {
      winnerPayload.deliveredAt = Date.now();
    }

    await db.collection("prize_winners").doc(winnerId).set(winnerPayload, { merge: true });
  }

  return { updated };
}

async function updateLegacyOrder(docId, payload) {
  await db.collection(ORDER_COLLECTIONS.legacy).doc(docId).set(payload, { merge: true });
}

async function moveToArchive(docSnap, orderData, finalStatus) {
  const targetCollection = getArchiveCollectionByStatus(finalStatus);
  if (!targetCollection) return false;

  const archiveRef = db.collection(targetCollection).doc(docSnap.id);
  const legacyRef = db.collection(ORDER_COLLECTIONS.legacy).doc(docSnap.id);

  const batch = db.batch();
  batch.set(
    archiveRef,
    {
      ...orderData,
      status: finalStatus,
      archivedFrom: ORDER_COLLECTIONS.active,
      archivedCollection: targetCollection,
      archivedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );
  batch.set(
    legacyRef,
    {
      ...orderData,
      status: finalStatus,
      archivedCollection: targetCollection,
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );
  batch.delete(docSnap.ref);
  await batch.commit();
  return true;
}

async function updateServiceAverageFromCompletedOrders(orderLike) {
  const serviceId = String(orderLike?.serviceId || "").trim();
  if (!serviceId) return;

  const sameServiceSnap = await db
    .collection(ORDER_COLLECTIONS.completed)
    .where("serviceId", "==", serviceId)
    .get();

  const completedRows = [];

  sameServiceSnap.forEach((docRow) => {
    const row = docRow.data() || {};
    const durationMs = Number(row.completionDurationMs || 0);
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;

    const completedAtMs =
      toMillis(row.completedAt) ||
      toMillis(row.updatedAt) ||
      toMillis(row.createdAt);

    completedRows.push({ durationMs, completedAtMs });
  });

  if (!completedRows.length) return;

  completedRows.sort((a, b) => b.completedAtMs - a.completedAtMs);
  const lastFive = completedRows.slice(0, 5);
  const durationsMs = lastFive.map((row) => row.durationMs);
  const avgCompletionTimeMs = Math.round(
    durationsMs.reduce((sum, value) => sum + value, 0) / durationsMs.length
  );

  const avgPayload = {
    avgTime: formatDuration(avgCompletionTimeMs),
    average_time: formatDuration(avgCompletionTimeMs),
    avgCompletionTimeMs,
    avgCompletionTimeMinutes: Number((avgCompletionTimeMs / 60000).toFixed(2)),
    completionSampleSize: durationsMs.length,
    completionDurationsLast5Ms: durationsMs,
    completionDurationsLast5Minutes: durationsMs.map((ms) => Number((ms / 60000).toFixed(2))),
    avgTimeSource: "last_5_completed_orders",
    lastCompletedAt: lastFive[0]?.completedAtMs || Date.now(),
    lastAvgUpdatedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };

  if (serviceId.startsWith("manual_")) {
    const manualId = serviceId.replace(/^manual_/, "").trim();
    if (!manualId) return;
    await db.collection("manual_services").doc(manualId).set(avgPayload, { merge: true });
    return;
  }

  const vendorId = String(orderLike?.vendorId || "").trim();
  const vendorServiceId = String(orderLike?.vendorServiceId || serviceId).trim();

  const serviceStore = await readAllServiceDocsFromCollection(db, {
    includeDeleted: true
  });
  const existing = serviceStore.servicesById?.[serviceId] || {};
  const isDisabled = existing.active === false;

  const nextService = {
    ...existing,
    ...avgPayload,
    panelServiceId: String(existing.panelServiceId || serviceId).trim() || serviceId,
    serviceId,
    vendorId: String(existing.vendorId || vendorId).trim() || vendorId,
    vendorServiceId: String(existing.vendorServiceId || vendorServiceId).trim() || vendorServiceId,
    active: !isDisabled,
    updatedAt: FieldValue.serverTimestamp()
  };

  await db.collection("services").doc(serviceId).set({
    ...nextService,
    panelServiceId: serviceId,
    serviceId,
    active: !isDisabled
  }, { merge: true });
}

async function syncActiveAndLegacy(docSnap, payload) {
  await Promise.all([
    docSnap.ref.set(payload, { merge: true }),
    updateLegacyOrder(docSnap.id, payload)
  ]);
}

async function syncRefundSensitiveStatus({
  docSnap,
  finalStatus,
  startCount,
  remains,
  nowMs
}) {
  const legacyRef = db.collection(ORDER_COLLECTIONS.legacy).doc(docSnap.id);

  return db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(docSnap.ref);
    if (!freshSnap.exists) {
      return {
        skipped: true,
        updated: false,
        archiveStatus: null,
        mergedOrder: null
      };
    }

    const order = freshSnap.data() || {};
    const orderPlacedAtMs = toMillis(order.orderPlacedAt) || toMillis(order.createdAt) || nowMs;
    const updatePayload = {
      status: finalStatus,
      startCount,
      remains,
      updatedAt: FieldValue.serverTimestamp()
    };

    if (!toMillis(order.orderPlacedAt)) updatePayload.orderPlacedAt = orderPlacedAtMs;
    if (!toMillis(order.processingStartedAt)) updatePayload.processingStartedAt = orderPlacedAtMs;

    if (finalStatus === "canceled") {
      const baseQty = Number(order.originalQty ?? order.qty ?? 0);
      const baseAmount = Number(order.originalAmount ?? order.amount ?? 0);
      const refundAmount = roundMoney(baseAmount);
      const currentRefundTotal = getStoredRefundTotal(order);
      const refundDelta = roundMoney(Math.max(refundAmount - currentRefundTotal, 0));
      const shouldRefund = refundDelta > 0;

      if (shouldRefund) {
        const userSnap = await tx.get(
          db.collection("users").where("username", "==", String(order.payer || "")).limit(1)
        );
        if (userSnap.empty) {
          throw new Error(`Refund user not found for order ${docSnap.id}`);
        }
        tx.update(userSnap.docs[0].ref, {
          balance: FieldValue.increment(refundDelta),
          updatedAt: FieldValue.serverTimestamp()
        });
      }

      Object.assign(updatePayload, {
        status: "canceled",
        originalQty: baseQty,
        originalAmount: baseAmount,
        qty: 0,
        amount: 0,
        remains: baseQty,
        refundAppliedTotal: refundAmount,
        refundProcessed: true,
        refundedAmount: refundAmount,
        refund: refundAmount,
        terminal: true
      });
    }

    if (finalStatus === "partial") {
      const baseQty = Number(order.originalQty ?? order.qty ?? 0);
      const baseAmount = Number(order.originalAmount ?? order.amount ?? 0);
      const hasValidPartial = remains > 0 && baseQty > remains;

      if (hasValidPartial) {
        const delivered = baseQty - remains;
        const pricePerUnit = baseQty > 0 ? baseAmount / baseQty : 0;
        const refundAmount = roundMoney(remains * pricePerUnit);
        const newAmount = roundMoney(delivered * pricePerUnit);
        const currentRefundTotal = getStoredRefundTotal(order);
        const refundDelta = roundMoney(Math.max(refundAmount - currentRefundTotal, 0));
        const shouldRefund = refundDelta > 0;

        if (shouldRefund) {
          const userSnap = await tx.get(
            db.collection("users").where("username", "==", String(order.payer || "")).limit(1)
          );
          if (userSnap.empty) {
            throw new Error(`Refund user not found for order ${docSnap.id}`);
          }
          tx.update(userSnap.docs[0].ref, {
            balance: FieldValue.increment(refundDelta),
            updatedAt: FieldValue.serverTimestamp()
          });
        }

        Object.assign(updatePayload, {
          status: "partial",
          originalQty: baseQty,
          originalAmount: baseAmount,
          qty: delivered,
          remains,
          refundAppliedTotal: refundAmount,
          refund: refundAmount,
          refundedAmount: refundAmount,
          amount: newAmount,
          refundProcessed: true,
          terminal: true
        });
      }
    }

    tx.set(docSnap.ref, updatePayload, { merge: true });
    tx.set(legacyRef, updatePayload, { merge: true });

    const archiveStatus = normalize(updatePayload.status || finalStatus);
    return {
      skipped: false,
      updated: true,
      archiveStatus,
      mergedOrder: {
        ...order,
        ...updatePayload,
        status: archiveStatus
      }
    };
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return respond(405, { error: "Method Not Allowed" });
  }

  const body = parseBody(event);
  if (!isAuthorizedRequest(event, body)) {
    return respond(401, { error: "Unauthorized" });
  }

  try {
    const snap = await db
      .collection(ORDER_COLLECTIONS.active)
      .orderBy("createdAt", "desc")
      .limit(300)
      .get();

    if (snap.empty) {
      return respond(200, {
        success: true,
        message: "No active orders found",
        updated: 0,
        moved: 0
      });
    }

    let updatedCount = 0;
    let movedCount = 0;

    for (const docSnap of snap.docs) {
      const order = docSnap.data() || {};
      const currentStatus = normalize(order.status);

      if (TERMINAL_STATES.includes(currentStatus)) {
        const completionPatch =
          currentStatus === "completed" ? buildCompletionFields(order) : {};
        const mergedOrder = {
          ...order,
          ...completionPatch,
          status: currentStatus
        };

        if (currentStatus === "completed") {
          await syncActiveAndLegacy(docSnap, {
            ...completionPatch,
            status: "completed",
            updatedAt: FieldValue.serverTimestamp()
          });
          updatedCount += 1;
        }

        const moved = await moveToArchive(docSnap, mergedOrder, currentStatus);
        if (moved) movedCount += 1;
        if (currentStatus === "completed") {
          await updateServiceAverageFromCompletedOrders(mergedOrder);
        }
        continue;
      }

      if (!order.orderId || !order.vendorId) {
        continue;
      }

      const vendorSnap = await db.collection("vendors").doc(order.vendorId).get();
      if (!vendorSnap.exists) continue;

      const vendor = vendorSnap.data() || {};
      if (!vendor.url || !vendor.key) continue;

      const form = new URLSearchParams();
      form.append("key", vendor.key);
      form.append("action", "status");
      form.append("order", String(order.orderId));

      let response = null;
      try {
        const res = await fetch(vendor.url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString()
        });
        response = await res.json();
      } catch {
        continue;
      }

      if (!response || typeof response !== "object") continue;

      const vendorStatusRaw = normalize(response.status);
      const finalStatus = STATUS_MAP[vendorStatusRaw] || normalize(order.status) || "pending";

      const startCount =
        response.start_count ||
        response.startCounter ||
        response.start ||
        response.start_counter ||
        order.startCount ||
        "-";

      const remains = Number(response.remains || 0);
      const nowMs = Date.now();

      if (finalStatus === "canceled" || finalStatus === "partial") {
        const refundSync = await syncRefundSensitiveStatus({
          docSnap,
          finalStatus,
          startCount,
          remains,
          nowMs
        });

        if (!refundSync || refundSync.skipped) {
          continue;
        }

        if (refundSync.updated) {
          updatedCount += 1;
        }

        if (TERMINAL_STATES.includes(refundSync.archiveStatus)) {
          const moved = await moveToArchive(docSnap, refundSync.mergedOrder, refundSync.archiveStatus);
          if (moved) movedCount += 1;
        }

        continue;
      }

      const updatePayload = {
        status: finalStatus,
        startCount,
        remains,
        updatedAt: FieldValue.serverTimestamp()
      };

      const orderPlacedAtMs = toMillis(order.orderPlacedAt) || toMillis(order.createdAt) || nowMs;
      if (!toMillis(order.orderPlacedAt)) updatePayload.orderPlacedAt = orderPlacedAtMs;
      if (!toMillis(order.processingStartedAt)) updatePayload.processingStartedAt = orderPlacedAtMs;

      if (finalStatus === "completed") {
        Object.assign(
          updatePayload,
          buildCompletionFields({
            ...order,
            orderPlacedAt: updatePayload.orderPlacedAt || order.orderPlacedAt,
            processingStartedAt: updatePayload.processingStartedAt || order.processingStartedAt
          })
        );
      }

      await syncActiveAndLegacy(docSnap, updatePayload);
      updatedCount += 1;

      if (TERMINAL_STATES.includes(finalStatus)) {
        const mergedOrder = {
          ...order,
          ...updatePayload,
          status: finalStatus
        };
        const moved = await moveToArchive(docSnap, mergedOrder, finalStatus);
        if (moved) movedCount += 1;

        if (finalStatus === "completed") {
          await updateServiceAverageFromCompletedOrders(mergedOrder);
        }
      }
    }

    const prizeOrderSync = await syncPrizeOrderStatuses();

    return respond(200, {
      success: true,
      message: "Status sync complete",
      updated: updatedCount,
      moved: movedCount,
      prizeUpdated: Number(prizeOrderSync?.updated || 0)
    });
  } catch (err) {
    console.error("Status sync failed:", err);
    return respond(500, {
      success: false,
      error: err.message || "Internal error"
    });
  }
};



