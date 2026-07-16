const fetch = require("node-fetch");
const admin = require("firebase-admin");

/* ------------------------------------------------------------------
   CORS HEADERS
------------------------------------------------------------------ */
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* ------------------------------------------------------------------
   FIREBASE INIT
------------------------------------------------------------------ */
if (!admin.apps.length) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey,
    }),
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

const ORDER_COLLECTIONS = {
  active: "orders_active",
  legacy: "orders"
};

function isCustomCommentsType(typeValue) {
  const normalized = String(typeValue || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return normalized.includes("custom") && normalized.includes("comment");
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

/* ==================================================================
   MAIN HANDLER
================================================================== */
exports.handler = async (event) => {
  /* ---------------- OPTIONS (CORS) ---------------- */
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { payer, serviceDocId, quantity, link, comments } = body; 

    if (!payer || !serviceDocId || !link) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing required fields" }),
      };
    }

    /* ----------------------------------------------------------
       🔥 CHANGE 1: SPLIT LOGIC (SUPPORT OLD & NEW FORMAT)
    ---------------------------------------------------------- */
    const rawServiceId = String(serviceDocId);
    const panelServiceId = rawServiceId.trim();
    const isManual = rawServiceId.startsWith("manual_");

    /* ----------------------------------------------------------
       1️⃣ FETCH USER
    ---------------------------------------------------------- */
    const userSnap = await db
      .collection("users")
      .where("username", "==", payer)
      .limit(1)
      .get();

    if (userSnap.empty) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "User not found" }),
      };
    }

    const userDoc = userSnap.docs[0];
    const user = userDoc.data();

    /* ----------------------------------------------------------
       2-MANUAL: HANDLE MANUAL SERVICES (NO VENDOR API)
    ---------------------------------------------------------- */
    if (isManual) {
      const manualId = rawServiceId.replace(/^manual_/, "");
      const manualSnap = await db.collection("manual_services").doc(manualId).get();

      if (!manualSnap.exists) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Manual service not found" }),
        };
      }

      const manual = manualSnap.data() || {};
      if (manual.active === false) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Service is currently disabled" }),
        };
      }

      const unitPrice = Number(manual.userPrice || 0);
      if (!unitPrice || unitPrice <= 0) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Service price invalid" }),
        };
      }

      const requestedQty = Number(quantity);
      if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Invalid quantity" }),
        };
      }

      const totalAmount = Number(((unitPrice / 1000) * requestedQty).toFixed(4));

      let numericOrderId = null;
      let orderData = null;

      const counterRef = db.collection("meta").doc("manual_order_counter");

      try {
        await db.runTransaction(async (tx) => {
          const counterSnap = await tx.get(counterRef);
          const current = Number(counterSnap.exists ? counterSnap.data().value : 99) || 99;
          numericOrderId = current + 1;

          // Balance check in transaction (safe)
          const userSnapTxn = await tx.get(userDoc.ref);
          const userData = userSnapTxn.data() || {};
          const balance = Number(userData.balance || 0);
          if (balance < totalAmount) {
            throw new Error("Insufficient balance");
          }

          tx.update(userDoc.ref, { balance: balance - totalAmount });
          tx.set(counterRef, {
            value: numericOrderId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });

          const finalOrderDocId = `manual_${numericOrderId}`;
          const createdAtMs = Date.now();

          orderData = {
            payer,
            payerName: userData.fullName || payer,

            orderId: String(numericOrderId),

            serviceId: rawServiceId,
            vendorServiceId: manualId,

            serviceTitle: manual.title || "Manual Service",

            vendorId: null,

            vendorPrice: unitPrice,
            userPrice: unitPrice,

            qty: requestedQty,
            amount: totalAmount,
            originalQty: requestedQty,
            originalAmount: totalAmount,
            refundAppliedTotal: 0,
            refundProcessed: false,
            refundedAmount: 0,
            refund: 0,

            link,
            startCount: "-",

            ...(comments && { comments }),

            status: "pending",
            manual: true,

            createdAt: createdAtMs,
            orderPlacedAt: createdAtMs,
            processingStartedAt: createdAtMs,
            date: new Date().toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
            }),
          };

          tx.set(
            db.collection(ORDER_COLLECTIONS.active).doc(finalOrderDocId),
            orderData,
            { merge: true }
          );
          tx.set(
            db.collection(ORDER_COLLECTIONS.legacy).doc(finalOrderDocId),
            orderData,
            { merge: true }
          );
        });
      } catch (e) {
        if ((e.message || "").toLowerCase().includes("insufficient")) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: "Insufficient balance" }),
          };
        }
        throw e;
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          orderId: String(numericOrderId),
          orderData,
        }),
      };
    }

    /* ----------------------------------------------------------
       2️⃣ LOAD ACTIVE SERVICES CONFIG & IDENTIFY VENDOR
    ---------------------------------------------------------- */
    const serviceStore = await readAllServiceDocsFromCollection(db, {
      includeDeleted: false
    });
    const activeServiceMap = serviceStore.servicesById || {};
    const defaultProfit = Number(serviceStore.defaultProfit || 0);

    const mapConfig = activeServiceMap[panelServiceId] || null;
    if (!mapConfig || mapConfig.deleted === true || mapConfig.active === false) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Service is currently disabled or not found" }),
      };
    }

    const serviceConfig = { ...mapConfig };

    const targetVendorId = String(serviceConfig.vendorId || "").trim();
    const vendorServiceId = String(
      serviceConfig.vendorServiceId ||
      serviceConfig.service ||
      panelServiceId
    ).trim();

    if (!targetVendorId || !vendorServiceId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Service is currently disabled or not found" }),
      };
    }
/* ----------------------------------------------------------
       3️⃣ FETCH SPECIFIC VENDOR CREDENTIALS
    ---------------------------------------------------------- */
    const vendorSnap = await db.collection("vendors").doc(targetVendorId).get();

    if (!vendorSnap.exists) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Assigned vendor not found in database" }),
      };
    }

    const vendor = vendorSnap.data();
    
    if(!vendor.url || !vendor.key) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: "Vendor API credentials missing" }),
        };
    }

    /* ----------------------------------------------------------
       4️⃣ FETCH LIVE RATES VIA vendor.js (SAFETY CHECK)
    ---------------------------------------------------------- */
    const baseUrl = process.env.URL || "http://localhost:8888";

    const vendorRes = await fetch(
      `${baseUrl}/api/vendor`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "services",
          key: vendor.key,
          url: vendor.url,
        }),
      }
    );

    const vendorJson = await vendorRes.json();
    let vendorServices = vendorJson.data || [];
    
    if (!Array.isArray(vendorServices) && typeof vendorServices === 'object') {
      vendorServices = Object.values(vendorServices);
    }

    // 🔥 CHANGE 4: Vendor API service match using raw ID
    const svc = vendorServices.find(
      (s) => String(s.service) === String(vendorServiceId)
    );

    if (!svc) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Service ID not found on Vendor API" }),
      };
    }

    const serviceType = String(serviceConfig.type || svc.type || svc.serviceType || "Default");
    const serviceTitle = String(serviceConfig.name || serviceConfig.title || svc.name || "Unnamed Service");
    const customCommentsService = isCustomCommentsType(serviceType);
    const cleanComments = String(comments || "").trim();

    let finalQty = Number(quantity);
    if (customCommentsService) {
      if (!cleanComments) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Comments are required for this service type" }),
        };
      }
      finalQty = countCommentLines(cleanComments);
    }

    if (!Number.isFinite(finalQty) || finalQty <= 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Invalid quantity" }),
      };
    }

    const minQty = Number(svc.min || 0);
    const maxQty = Number(svc.max || 0);
    if (minQty > 0 && finalQty < minQty) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: `Minimum quantity is ${minQty}` }),
      };
    }
    if (maxQty > 0 && finalQty > maxQty) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: `Maximum quantity is ${maxQty}` }),
      };
    }

    /* ----------------------------------------------------------
       5️⃣ PRICE CALCULATION (WITH CURRENCY CONVERSION)
    ---------------------------------------------------------- */
    const profit = serviceConfig.profit ?? defaultProfit;
    
    let baseRate = Number(svc.rate || 0);

    // 🔥 CURRENCY LOGIC
    if (vendor.currency === "USD") {
        const exchangeRate = Number(vendor.exchangeRate) || 1;
        baseRate = baseRate * exchangeRate;
    }
    
    const userRate = Number((baseRate * (1 + profit / 100)).toFixed(2));
    const totalAmount = Number(((userRate / 1000) * finalQty).toFixed(4));

    if (Number(user.balance || 0) < totalAmount) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Insufficient balance" }),
      };
    }

    /* ----------------------------------------------------------
       6️⃣ PLACE ORDER TO SPECIFIC VENDOR
    ---------------------------------------------------------- */
    const form = new URLSearchParams();
    form.append("key", vendor.key);
    form.append("action", "add");
    // IMPORTANT: Send the raw vendor ID to the external API, not the composite string
    form.append("service", vendorServiceId); 
    form.append("link", link);
    form.append("quantity", String(finalQty));
    
    if (customCommentsService) form.append("comments", cleanComments);

    let vendorOrderId = null;
    let vendorResponse = {};
    let startCount = "-";

    try {
      const r = await fetch(vendor.url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });

      vendorResponse = await r.json();
      
      // Handle various vendor response formats
      if (vendorResponse.error) throw new Error(vendorResponse.error);
      
      vendorOrderId = vendorResponse.order;

      startCount =
        vendorResponse.start_count ||
        vendorResponse.startCounter ||
        vendorResponse.start ||
        "-";

    } catch (e) {
      console.error("Vendor API Fail:", e);

      let safeErrorMessage = e.message;

      if (
        safeErrorMessage.toLowerCase().includes("balance") || 
        safeErrorMessage.toLowerCase().includes("insufficient")
      ) {
        safeErrorMessage = "Service temporarily unavailable due to technical load. Please try again later or contact support.";
      }

      return {
          statusCode: 502, 
          headers,
          body: JSON.stringify({ error: `Order Failed: ${safeErrorMessage}` })
      };
    }

    /* ----------------------------------------------------------
       7️⃣ BUILD ORDER IDS (PUBLIC + INTERNAL DOC KEY)
    ---------------------------------------------------------- */
    const publicOrderId = vendorOrderId
      ? String(vendorOrderId)
      : `pending_${Date.now()}`;
    const internalOrderDocId = vendorOrderId
      ? buildVendorOrderDocId(targetVendorId, publicOrderId)
      : publicOrderId;

    /* ----------------------------------------------------------
       8️⃣ SAVE ORDER + DEDUCT BALANCE (ATOMIC)
    ---------------------------------------------------------- */
    const createdAtMs = Date.now();

    const orderData = {
      payer,
      payerName: user.fullName || payer,

      orderId: publicOrderId,
      internalOrderId: internalOrderDocId,

      // 🔥 CHANGE 5: Store both user-facing ID and real Vendor ID
      serviceId: String(panelServiceId),
      panelServiceId: String(panelServiceId),
      vendorServiceId: String(vendorServiceId),
      
      serviceTitle,
      serviceType,

      vendorId: targetVendorId, 
      
      vendorPrice: baseRate, 
      userPrice: userRate,

      qty: finalQty,
      amount: totalAmount,
      originalQty: finalQty,
      originalAmount: totalAmount,
      refundAppliedTotal: 0,
      refundProcessed: false,
      refundedAmount: 0,
      refund: 0,

      link,
      startCount,
      
      ...(customCommentsService && cleanComments && { comments: cleanComments }),

      status: vendorOrderId ? "processing" : "pending",
      vendorResponse,

      createdAt: createdAtMs,
      orderPlacedAt: createdAtMs,
      processingStartedAt: createdAtMs,
      date: new Date().toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
      }),
    };

    try {
      await db.runTransaction(async (tx) => {
        const userSnapTxn = await tx.get(userDoc.ref);
        const userData = userSnapTxn.data() || {};
        const freshBalance = Number(userData.balance || 0);
        if (freshBalance < totalAmount) {
          throw new Error("Insufficient balance");
        }

        tx.update(userDoc.ref, {
          balance: Number((freshBalance - totalAmount).toFixed(4)),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        tx.set(
          db.collection(ORDER_COLLECTIONS.active).doc(internalOrderDocId),
          orderData,
          { merge: true }
        );
        tx.set(
          db.collection(ORDER_COLLECTIONS.legacy).doc(internalOrderDocId),
          orderData,
          { merge: true }
        );
      });
    } catch (e) {
      if ((e.message || "").toLowerCase().includes("insufficient")) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Insufficient balance" }),
        };
      }
      throw e;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        orderId: publicOrderId,
        internalOrderId: internalOrderDocId,
        orderData,
      }),
    };

  } catch (err) {
    console.error("ORDER SYSTEM ERROR:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};





