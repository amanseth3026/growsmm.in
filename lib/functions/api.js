// netlify/functions/api.js
const fetch = require("node-fetch");
const admin = require("firebase-admin");

/* =========================================================================
   FIREBASE INIT
   ========================================================================= */
let db = null;

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

function getDb() {
  if (db) return db;

  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (
    !process.env.FIREBASE_PROJECT_ID ||
    !process.env.FIREBASE_CLIENT_EMAIL ||
    !privateKey
  ) {
    throw new Error("Missing Firebase ENV variables");
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey
      })
    });
  }

  db = admin.firestore();
  return db;
}

const ORDER_COLLECTIONS = {
  active: "orders_active",
  completed: "orders_completed",
  canceled: "orders_cancel",
  partial: "orders_partial",
  legacy: "orders"
};

const ORDER_LOOKUP_COLLECTIONS = [
  ORDER_COLLECTIONS.active,
  ORDER_COLLECTIONS.completed,
  ORDER_COLLECTIONS.canceled,
  ORDER_COLLECTIONS.partial,
  ORDER_COLLECTIONS.legacy
];

const ACTIVE_ORDER_STATUSES = new Set([
  "pending",
  "processing",
  "in progress",
  "inprogress",
  "in-progress",
  "queue",
  "queued"
]);

/* =========================================================================
   BODY PARSER (JSON + FORM-URLENCODED)
   ========================================================================= */
function parseBody(event) {
  const ct = event.headers["content-type"] || event.headers["Content-Type"] || "";

  if (ct.includes("application/json")) {
    try {
      return JSON.parse(event.body || "{}");
    } catch {
      return {};
    }
  }

  if (ct.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(event.body || "");
    return Object.fromEntries(params.entries());
  }

  return {};
}

/* =========================================================================
   HELPERS
   ========================================================================= */
function response(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function normalizeType(typeValue) {
  return String(typeValue || "Default").trim() || "Default";
}

function isCustomCommentsType(typeValue) {
  const type = normalizeType(typeValue).toLowerCase().replace(/\s+/g, " ");
  return type.includes("custom") && type.includes("comment");
}

function countCommentLines(text) {
  return String(text || "")
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function sanitizeDocIdPart(value, fallback = "unknown") {
  const clean = String(value || "").trim();
  if (!clean) return fallback;
  return clean.replace(/[\/\\]/g, "_");
}

function buildVendorOrderDocId(vendorId, orderId) {
  const safeVendor = sanitizeDocIdPart(vendorId, "no_vendor");
  const safeOrder = sanitizeDocIdPart(orderId, "unknown_order");
  return `${safeVendor}__${safeOrder}`;
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

function extractAverageTime(svc) {
  if (!svc || typeof svc !== "object") return "";

  const direct = pickFirstFilled([
    svc.average_time,
    svc.avg_time,
    svc.time,
    svc.averageTime,
    svc.avgTime,
    svc.estimated_time,
    svc.estimatedTime,
    svc.average_delivery_time,
    svc.delivery_time,
    svc.speed,
    svc["average time"],
    svc["avg time"],
    svc["delivery time"],
    svc["Average Time"],
    svc["AVG TIME"]
  ]);
  if (direct) return direct;

  const entries = Object.entries(svc);
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

function parseIdList(raw, max = 100) {
  return String(raw || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, max);
}

function normalizeFlag(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  const v = String(value || "").toLowerCase().trim();
  return v === "1" || v === "true" || v === "yes";
}

function getOrderStatusPayload(orderData) {
  return {
    charge: String(orderData.amount ?? "0"),
    start_count: String(orderData.startCount ?? 0),
    status: String(orderData.status || "pending"),
    remains: String(orderData.remains ?? 0),
    currency: "INR"
  };
}

function extractActionResult(raw, key, id, valueField) {
  if (Array.isArray(raw)) {
    const matched = raw.find((item) => String(item?.[key] ?? "") === String(id));
    if (!matched) return { error: "Incorrect order ID" };
    if (Object.prototype.hasOwnProperty.call(matched, valueField)) {
      return matched[valueField];
    }
    if (matched.error) return { error: String(matched.error) };
    return matched;
  }

  if (raw && typeof raw === "object") {
    if (Object.prototype.hasOwnProperty.call(raw, valueField)) {
      return raw[valueField];
    }
    if (Object.prototype.hasOwnProperty.call(raw, String(id))) {
      const row = raw[String(id)];
      if (row && typeof row === "object" && Object.prototype.hasOwnProperty.call(row, valueField)) {
        return row[valueField];
      }
      return row;
    }
    if (raw.error) return { error: String(raw.error) };
  }

  if (raw === undefined || raw === null || raw === "") {
    return { error: "Unexpected vendor response" };
  }

  return raw;
}

function extractRefillStatus(raw, refillId) {
  if (Array.isArray(raw)) {
    const matched = raw.find((item) => String(item?.refill ?? "") === String(refillId));
    if (!matched) return undefined;
    return Object.prototype.hasOwnProperty.call(matched, "status")
      ? matched.status
      : matched;
  }

  if (raw && typeof raw === "object") {
    if (Object.prototype.hasOwnProperty.call(raw, "status")) return raw.status;
    if (Object.prototype.hasOwnProperty.call(raw, String(refillId))) {
      const row = raw[String(refillId)];
      if (row && typeof row === "object" && Object.prototype.hasOwnProperty.call(row, "status")) {
        return row.status;
      }
      return row;
    }
    if (raw.error) return { error: String(raw.error) };
  }

  return undefined;
}

async function callVendorApi(vendorData, params) {
  try {
    const payload = new URLSearchParams();
    payload.append("key", vendorData.key);
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") {
        payload.append(k, String(v));
      }
    });

    const res = await fetch(vendorData.url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: payload.toString()
    });

    const text = await res.text();
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: false, error: "Invalid JSON from vendor" };
    }
  } catch (err) {
    return { ok: false, error: err.message || "Vendor request failed" };
  }
}

async function fetchServicesFromVendor(vendorData) {
  const res = await callVendorApi(vendorData, { action: "services" });
  if (!res.ok) return { success: false };

  let data = res.data;
  if (Array.isArray(data?.data)) {
    data = data.data;
  } else if (Array.isArray(data?.services)) {
    data = data.services;
  } else if (!Array.isArray(data) && data && typeof data === "object") {
    data = Object.values(data);
  }

  if (!Array.isArray(data)) return { success: false };

  const normalized = data.map((svc) => {
    const serviceId = pickFirstFilled([
      svc.service,
      svc.serviceId,
      svc.service_id,
      svc.vendorServiceId,
      svc.id
    ]);
    const serviceName = pickFirstFilled([
      svc.name,
      svc.title,
      svc.service_name,
      svc.serviceName,
      svc.service_title,
      svc.serviceTitle
    ]) || "Unnamed Service";
    const serviceCategory = pickFirstFilled([
      svc.category,
      svc.category_name,
      svc.categoryName,
      svc.cat,
      svc.group,
      svc.group_name,
      svc.service_category,
      svc.serviceCategory
    ]) || "General";
    const avgTime = extractAverageTime(svc);
    return {
      service: serviceId,
      serviceId,
      vendorServiceId: serviceId,
      name: serviceName,
      title: serviceName,
      serviceName,
      category: serviceCategory,
      serviceCategory,
      description:
        pickFirstFilled([
          svc.description,
          svc.desc,
          svc.details,
          svc.service_description,
          svc.serviceDescription
        ]) ||
        "No description available",
      type: normalizeType(
        pickFirstFilled([svc.type, svc.service_type, svc.serviceType, "Default"])
      ),
      rate: Number(svc.rate ?? svc.price ?? svc.cost ?? 0),
      min: Number(svc.min ?? svc.minimum ?? svc.minQty ?? 0),
      max: Number(svc.max ?? svc.maximum ?? svc.maxQty ?? 0),
      average_time: avgTime,
      time: avgTime,
      refill: normalizeFlag(svc.refill),
      cancel: normalizeFlag(svc.cancel)
    };
  });

  return { success: true, data: normalized };
}

function normalizeOrderStatus(status) {
  return String(status || "").toLowerCase().trim();
}

function isActiveOrderStatus(status) {
  return ACTIVE_ORDER_STATUSES.has(normalizeOrderStatus(status));
}

async function findOrderDocForUser(dbConn, username, orderId) {
  const orderDocId = String(orderId || "").trim();
  if (!orderDocId) return null;

  for (const collectionName of ORDER_LOOKUP_COLLECTIONS) {
    const directSnap = await dbConn.collection(collectionName).doc(orderDocId).get();
    if (directSnap.exists) {
      const directData = directSnap.data() || {};
      if (directData.payer === username) {
        return {
          id: directSnap.id,
          data: directData,
          ref: directSnap.ref,
          sourceCollection: collectionName
        };
      }
    }

    const byOrderIdSnap = await dbConn
      .collection(collectionName)
      .where("orderId", "==", orderDocId)
      .limit(5)
      .get();

    const matched = byOrderIdSnap.docs.find((docSnap) => {
      const row = docSnap.data() || {};
      return row.payer === username;
    });

    if (!matched) continue;
    return {
      id: matched.id,
      data: matched.data() || {},
      ref: matched.ref,
      sourceCollection: collectionName
    };
  }

  return null;
}

async function createRefillForOrder({ dbConn, username, orderId, vendorsMap }) {
  const found = await findOrderDocForUser(dbConn, username, orderId);
  if (!found) return { error: "Incorrect order ID" };

  const order = found.data;
  const vendor = vendorsMap[order.vendorId];
  if (!vendor) return { error: "Incorrect order ID" };

  const vendorOrderId = String(order.orderId || orderId);
  const vendorRes = await callVendorApi(vendor, { action: "refill", order: vendorOrderId });
  if (!vendorRes.ok) return { error: vendorRes.error || "Vendor refill failed" };

  const refillResult = extractActionResult(vendorRes.data, "order", vendorOrderId, "refill");
  if (refillResult && typeof refillResult === "object" && refillResult.error) {
    return { error: String(refillResult.error) };
  }

  const refillId = String(
    (refillResult && typeof refillResult === "object"
      ? refillResult.refill || refillResult.id || refillResult.refill_id
      : refillResult) || ""
  ).trim();

  if (!refillId) {
    return { error: "Refill request failed" };
  }

  await dbConn.collection("refills").doc(refillId).set(
    {
      refillId,
      orderId: vendorOrderId,
      vendorId: order.vendorId,
      payer: username,
      createdAt: Date.now(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  return refillId;
}

async function getRefillStatus({ dbConn, username, refillId, vendorsMap }) {
  const refillSnap = await dbConn.collection("refills").doc(String(refillId)).get();
  const candidates = [];

  if (refillSnap.exists) {
    const refillData = refillSnap.data() || {};
    if (refillData.payer && refillData.payer !== username) {
      return { error: "Refill not found" };
    }
    if (refillData.vendorId && vendorsMap[refillData.vendorId]) {
      candidates.push(vendorsMap[refillData.vendorId]);
    }
  }

  if (!candidates.length) {
    candidates.push(...Object.values(vendorsMap));
  }

  for (const vendor of candidates) {
    const vendorRes = await callVendorApi(vendor, { action: "refill_status", refill: refillId });
    if (!vendorRes.ok) continue;

    const status = extractRefillStatus(vendorRes.data, refillId);
    if (status === undefined) continue;

    if (status && typeof status === "object" && status.error) {
      continue;
    }

    return status;
  }

  return { error: "Refill not found" };
}

async function createCancelForOrder({ dbConn, username, orderId, vendorsMap }) {
  const found = await findOrderDocForUser(dbConn, username, orderId);
  if (!found) return { error: "Incorrect order ID" };

  const order = found.data;
  if (found.sourceCollection !== ORDER_COLLECTIONS.active || !isActiveOrderStatus(order.status)) {
    return { error: "Order is not active/cancelable" };
  }
  const vendor = vendorsMap[order.vendorId];
  if (!vendor) return { error: "Incorrect order ID" };

  const vendorOrderId = String(order.orderId || orderId);
  const vendorRes = await callVendorApi(vendor, { action: "cancel", orders: vendorOrderId });
  if (!vendorRes.ok) return { error: vendorRes.error || "Vendor cancel failed" };

  const cancelResult = extractActionResult(vendorRes.data, "order", vendorOrderId, "cancel");
  if (cancelResult && typeof cancelResult === "object" && cancelResult.error) {
    return { error: String(cancelResult.error) };
  }

  return cancelResult;
}

/* =========================================================================
   MAIN HANDLER
   ========================================================================= */
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return response(405, { error: "Method Not Allowed" });
  }

  try {
    const dbConn = getDb();
    const body = parseBody(event);
    const { key, action } = body;

    if (!key || !action) {
      return response(400, { error: "Missing API Key or Action" });
    }

    const userSnap = await dbConn
      .collection("users")
      .where("apiKey", "==", key)
      .limit(1)
      .get();

    if (userSnap.empty) {
      return response(401, { error: "Invalid API Key" });
    }

    const userDoc = userSnap.docs[0];
    const userData = userDoc.data();

    const userExtraProfit = Number(userData.extraProfit || 0);
    const userDiscount = Number(userData.discount || 0);

    const [serviceStore, vendorSnap] = await Promise.all([
      readAllServiceDocsFromCollection(dbConn, {
        includeDeleted: false
      }),
      dbConn.collection("vendors").get()
    ]);
    const activeServices = serviceStore.servicesById || {};
    if (vendorSnap.empty) {
      return response(500, { error: "Configuration Error: No Vendors Found" });
    }

    const vendorsMap = {};
    vendorSnap.forEach((docSnap) => {
      vendorsMap[docSnap.id] = { id: docSnap.id, ...docSnap.data() };
    });

    const defaultProfit = Number(serviceStore.defaultProfit || 0);

    if (action === "balance") {
      return response(200, {
        balance: String(userData.balance || 0),
        currency: "INR"
      });
    }

    if (action === "services") {
      const vendorPromises = Object.values(vendorsMap).map(async (vendor) => {
        const res = await fetchServicesFromVendor(vendor);
        return {
          vendorId: vendor.id,
          vendorData: vendor,
          success: res.success,
          data: res.data || []
        };
      });

      const vendorResults = await Promise.all(vendorPromises);
      const vendorServicesMap = {};
      vendorResults.forEach((row) => {
        if (row.success) vendorServicesMap[row.vendorId] = row;
      });

      const output = [];

      for (const [panelServiceId, conf] of Object.entries(activeServices)) {
        if (conf?.deleted === true || conf?.active === false) {
          continue;
        }

        const vendorServiceId = String(conf?.vendorServiceId || panelServiceId).trim();
        let remoteSvc = null;
        let vendorData = null;

        if (conf.vendorId) {
          if (!vendorServicesMap[conf.vendorId]) {
            continue;
          }
          remoteSvc = vendorServicesMap[conf.vendorId].data.find(
            (svc) => String(svc.service) === String(vendorServiceId)
          );
          vendorData = vendorServicesMap[conf.vendorId].vendorData;
        } else {
          for (const vId of Object.keys(vendorServicesMap)) {
            const found = vendorServicesMap[vId].data.find(
              (svc) => String(svc.service) === String(vendorServiceId)
            );
            if (found) {
              remoteSvc = found;
              vendorData = vendorServicesMap[vId].vendorData;
              break;
            }
          }
        }

        if (!remoteSvc || !vendorData) continue;

        const serviceName = pickFirstFilled([
          conf?.name,
          conf?.title,
          conf?.serviceName,
          remoteSvc.name,
          remoteSvc.title,
          remoteSvc.serviceName
        ]) || "Unnamed Service";
        const serviceCategory = pickFirstFilled([
          conf?.category,
          conf?.serviceCategory,
          remoteSvc.category,
          remoteSvc.serviceCategory
        ]) || "General";

        let baseRate = Number(remoteSvc.rate || 0);
        if ((vendorData.currency || "INR") === "USD") {
          baseRate = baseRate * (Number(vendorData.exchangeRate) || 1);
        }

        const globalProfit = conf.profit ?? defaultProfit;
        let rateStep1 = baseRate * (1 + globalProfit / 100);
        let rateStep2 = rateStep1 * (1 + userExtraProfit / 100);
        let finalRate = rateStep2 * (1 - userDiscount / 100);
        finalRate = Number(finalRate.toFixed(4));

        output.push({
          service: String(panelServiceId),
          name: serviceName,
          title: serviceName,
          serviceName,
          category: serviceCategory,
          serviceCategory,
          type: normalizeType(remoteSvc.type),
          rate: String(finalRate),
          min: String(remoteSvc.min ?? 0),
          max: String(remoteSvc.max ?? 0),
          refill: normalizeFlag(remoteSvc.refill),
          cancel: normalizeFlag(remoteSvc.cancel),
          description: remoteSvc.description || "No description available"
        });
      }

      return response(200, output);
    }

    if (action === "add") {
      const { service, link, quantity, comments } = body;
      if (!service || !link) {
        return response(400, { error: "Missing parameters" });
      }

      const panelServiceId = String(service).trim();
      const serviceConf = activeServices[panelServiceId];
      if (!serviceConf || serviceConf.deleted === true || serviceConf.active === false) {
        return response(400, { error: "Service disabled or not found" });
      }
      const vendorServiceId = String(serviceConf.vendorServiceId || panelServiceId).trim();

      let vendorData = serviceConf.vendorId ? vendorsMap[serviceConf.vendorId] : null;
      let remoteSvc = null;

      if (vendorData) {
        const vendorServices = await fetchServicesFromVendor(vendorData);
        if (vendorServices.success) {
          remoteSvc = vendorServices.data.find((svc) => String(svc.service) === String(vendorServiceId));
        }
      } else {
        for (const vendor of Object.values(vendorsMap)) {
          const vendorServices = await fetchServicesFromVendor(vendor);
          if (!vendorServices.success) continue;
          const found = vendorServices.data.find((svc) => String(svc.service) === String(vendorServiceId));
          if (found) {
            remoteSvc = found;
            vendorData = vendor;
            break;
          }
        }
      }

      if (!remoteSvc || !vendorData) {
        return response(400, { error: "Service unavailable upstream" });
      }

      const serviceType = normalizeType(remoteSvc.type);
      const serviceName = pickFirstFilled([
        serviceConf?.name,
        serviceConf?.title,
        serviceConf?.serviceName,
        remoteSvc.name,
        remoteSvc.title,
        remoteSvc.serviceName
      ]) || "Unnamed Service";
      const serviceCategory = pickFirstFilled([
        serviceConf?.category,
        serviceConf?.serviceCategory,
        remoteSvc.category,
        remoteSvc.serviceCategory
      ]) || "General";
      const customCommentsService = isCustomCommentsType(serviceType);
      const cleanComments = String(comments || "").trim();

      let finalQty = Number(quantity);
      if (customCommentsService) {
        if (!cleanComments) {
          return response(400, { error: "Comments are required for this service type" });
        }
        finalQty = countCommentLines(cleanComments);
      }

      if (!Number.isFinite(finalQty) || finalQty <= 0) {
        return response(400, { error: "Invalid quantity" });
      }

      const minQty = Number(remoteSvc.min || 0);
      const maxQty = Number(remoteSvc.max || 0);
      if (minQty > 0 && finalQty < minQty) {
        return response(400, { error: `Minimum quantity is ${minQty}` });
      }
      if (maxQty > 0 && finalQty > maxQty) {
        return response(400, { error: `Maximum quantity is ${maxQty}` });
      }

      let baseRate = Number(remoteSvc.rate || 0);
      if ((vendorData.currency || "INR") === "USD") {
        baseRate = baseRate * (Number(vendorData.exchangeRate) || 1);
      }

      const globalProfit = serviceConf.profit ?? defaultProfit;
      let rateStep1 = baseRate * (1 + globalProfit / 100);
      let rateStep2 = rateStep1 * (1 + userExtraProfit / 100);
      let userRate = rateStep2 * (1 - userDiscount / 100);
      userRate = Number(userRate.toFixed(4));

      const totalCost = Number(((userRate / 1000) * finalQty).toFixed(4));
      if ((userData.balance || 0) < totalCost) {
        return response(400, { error: "Insufficient balance" });
      }

      const vendorReq = await callVendorApi(vendorData, {
        action: "add",
        service: String(vendorServiceId),
        link,
        quantity: String(finalQty),
        comments: customCommentsService ? cleanComments : undefined
      });

      if (!vendorReq.ok) {
        return response(500, { error: vendorReq.error || "Upstream API Error" });
      }

      const vendorResponse = vendorReq.data || {};
      if (vendorResponse.error) {
        return response(400, { error: String(vendorResponse.error) });
      }

      const orderId = String(vendorResponse.order || `api_${Date.now()}`);
      const internalOrderDocId = buildVendorOrderDocId(vendorData.id, orderId);

      const formattedDate = new Date()
        .toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
          year: "numeric",
          month: "numeric",
          day: "numeric",
          hour: "numeric",
          minute: "numeric",
          second: "numeric",
          hour12: true
        })
        .toLowerCase();

      const createdAtMs = Date.now();
      const orderPayload = {
        orderId,
        internalOrderId: internalOrderDocId,
        payer: userData.username,
        serviceId: panelServiceId,
        panelServiceId,
        vendorServiceId,
        serviceTitle: serviceName,
        serviceName,
        title: serviceName,
        serviceCategory,
        category: serviceCategory,
        serviceType,
        vendorId: vendorData.id,
        vendorPrice: baseRate,
        userPrice: userRate,
        qty: finalQty,
        amount: totalCost,
        originalQty: finalQty,
        originalAmount: totalCost,
        refundAppliedTotal: 0,
        refundProcessed: false,
        refundedAmount: 0,
        refund: 0,
        link,
        ...(customCommentsService && cleanComments && { comments: cleanComments }),
        status: "pending",
        viaApi: true,
        createdAt: createdAtMs,
        orderPlacedAt: createdAtMs,
        processingStartedAt: createdAtMs,
        date: formattedDate
      };

      try {
        await dbConn.runTransaction(async (tx) => {
          const freshUserSnap = await tx.get(userDoc.ref);
          const freshUserData = freshUserSnap.data() || {};
          if (Number(freshUserData.balance || 0) < totalCost) {
            throw new Error("Insufficient balance");
          }

          const activeOrderRef = dbConn.collection(ORDER_COLLECTIONS.active).doc(internalOrderDocId);
          const legacyOrderRef = dbConn.collection(ORDER_COLLECTIONS.legacy).doc(internalOrderDocId);
          const existingOrderSnap = await tx.get(activeOrderRef);

          if (existingOrderSnap.exists) {
            const existingOrder = existingOrderSnap.data() || {};
            if (existingOrder.payer !== userData.username) {
              throw new Error("Order ID collision");
            }
            return;
          }

          tx.update(userDoc.ref, {
            balance: admin.firestore.FieldValue.increment(-totalCost),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          tx.set(activeOrderRef, orderPayload, { merge: true });
          tx.set(legacyOrderRef, orderPayload, { merge: true });
        });
      } catch (txnErr) {
        if ((txnErr.message || "").toLowerCase().includes("insufficient")) {
          return response(400, { error: "Insufficient balance" });
        }
        throw txnErr;
      }

      return response(200, { order: orderId });
    }

    if (action === "status") {
      const multiIds = parseIdList(body.orders);
      if (multiIds.length) {
        const result = {};
        for (const orderId of multiIds) {
          const found = await findOrderDocForUser(dbConn, userData.username, orderId);
          result[orderId] = found ? getOrderStatusPayload(found.data) : { error: "Incorrect order ID" };
        }
        return response(200, result);
      }

      const orderId = String(body.order || "").trim();
      if (!orderId) {
        return response(400, { error: "Order ID required" });
      }

      const found = await findOrderDocForUser(dbConn, userData.username, orderId);
      if (!found) {
        return response(200, { error: "Incorrect order ID" });
      }

      return response(200, getOrderStatusPayload(found.data));
    }

    if (action === "refill") {
      const multiOrders = parseIdList(body.orders);
      if (multiOrders.length) {
        const out = [];
        for (const orderId of multiOrders) {
          const refill = await createRefillForOrder({
            dbConn,
            username: userData.username,
            orderId,
            vendorsMap
          });
          out.push({ order: orderId, refill });
        }
        return response(200, out);
      }

      const orderId = String(body.order || "").trim();
      if (!orderId) {
        return response(400, { error: "Order ID required" });
      }

      const refill = await createRefillForOrder({
        dbConn,
        username: userData.username,
        orderId,
        vendorsMap
      });
      return response(200, { refill });
    }

    if (action === "refill_status") {
      const multiRefills = parseIdList(body.refills);
      if (multiRefills.length) {
        const out = [];
        for (const refillId of multiRefills) {
          const status = await getRefillStatus({
            dbConn,
            username: userData.username,
            refillId,
            vendorsMap
          });
          out.push({ refill: refillId, status });
        }
        return response(200, out);
      }

      const refillId = String(body.refill || "").trim();
      if (!refillId) {
        return response(400, { error: "Refill ID required" });
      }

      const status = await getRefillStatus({
        dbConn,
        username: userData.username,
        refillId,
        vendorsMap
      });

      if (status && typeof status === "object" && status.error) {
        return response(200, status);
      }

      return response(200, { status });
    }

    if (action === "cancel") {
      const ids = parseIdList(body.orders || body.order);
      if (!ids.length) {
        return response(400, { error: "Order IDs required" });
      }

      const out = [];
      for (const orderId of ids) {
        const cancel = await createCancelForOrder({
          dbConn,
          username: userData.username,
          orderId,
          vendorsMap
        });
        out.push({ order: orderId, cancel });
      }
      return response(200, out);
    }

    return response(400, { error: "Invalid Action" });
  } catch (err) {
    console.error("API Error:", err);
    return response(500, { error: err.message });
  }
};



