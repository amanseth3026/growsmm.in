const fetch = require("node-fetch");
const admin = require("firebase-admin");

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

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
const CLAIM_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;
const CLAIM_LOCK_MS = 2 * 60 * 1000;

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

function respond(statusCode, body) {
  return {
    statusCode,
    headers,
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

function normalizeUsername(name) {
  return String(name || "").trim().toLowerCase();
}

function isManualService(serviceId) {
  return String(serviceId || "").trim().toLowerCase().startsWith("manual_");
}

function toSafeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney(value) {
  return Number(toSafeNumber(value, 0).toFixed(4));
}

function normalizeWinnerClaimState(winner = {}) {
  return String(winner.claimStatus || "").toLowerCase().trim();
}

async function placeVendorRewardOrder({
  winner,
  rewardServiceId,
  rewardQty,
  claimLink
}) {
  const serviceStore = await readAllServiceDocsFromCollection(db, {
    includeDeleted: false
  });
  const serviceMap = serviceStore.servicesById || {};

  const serviceConfig = serviceMap[rewardServiceId] || null;
  if (!serviceConfig || serviceConfig.deleted === true || serviceConfig.active === false) {
    throw new Error("Selected reward service is disabled or not found.");
  }

  const vendorId = String(serviceConfig.vendorId || "").trim();
  const vendorServiceId = String(serviceConfig.vendorServiceId || serviceConfig.service || rewardServiceId).trim();
  if (!vendorId || !vendorServiceId) {
    throw new Error("Reward service vendor mapping is missing.");
  }

  const vendorSnap = await db.collection("vendors").doc(vendorId).get();
  if (!vendorSnap.exists) {
    throw new Error("Assigned vendor not found.");
  }

  const vendor = vendorSnap.data() || {};
  const vendorUrl = String(vendor.url || "").trim();
  const vendorKey = String(vendor.key || "").trim();
  if (!vendorUrl || !vendorKey) {
    throw new Error("Vendor API credentials are missing.");
  }

  const vendorCurrency = String(vendor.currency || "INR").toUpperCase();
  const exchangeRate = toSafeNumber(vendor.exchangeRate, 1);
  const rateRaw = toSafeNumber(serviceConfig.rate ?? serviceConfig.vendorPrice ?? 0, 0);
  const rateInInr = vendorCurrency === "USD" ? rateRaw * exchangeRate : rateRaw;
  const vendorCost = roundMoney((rateInInr / 1000) * rewardQty);

  const form = new URLSearchParams();
  form.append("key", vendorKey);
  form.append("action", "add");
  form.append("service", vendorServiceId);
  form.append("link", claimLink);
  form.append("quantity", String(rewardQty));

  let vendorResponse = {};
  try {
    const res = await fetch(vendorUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString()
    });

    vendorResponse = await res.json();
  } catch (err) {
    throw new Error(`Vendor request failed: ${err?.message || "Unknown error"}`);
  }

  if (!vendorResponse || typeof vendorResponse !== "object") {
    throw new Error("Invalid response from vendor API.");
  }

  if (vendorResponse.error) {
    throw new Error(String(vendorResponse.error));
  }

  const vendorOrderId = String(vendorResponse.order || "").trim();
  if (!vendorOrderId) {
    throw new Error("Vendor order id missing in response.");
  }

  return {
    mode: "vendor_auto",
    vendorId,
    vendorServiceId,
    vendorOrderId,
    vendorResponse,
    vendorCost,
    status: "processing"
  };
}

async function prepareManualRewardOrder({ rewardServiceId }) {
  return {
    mode: "manual",
    vendorId: null,
    vendorServiceId: rewardServiceId,
    vendorOrderId: null,
    vendorResponse: { message: "Manual reward service selected" },
    vendorCost: 0,
    status: "manual_pending"
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method Not Allowed" });
  }

  const body = parseBody(event);
  const winnerId = String(body.winnerId || "").trim();
  const username = String(body.username || "").trim();
  const claimLink = String(body.link || "").trim();

  if (!winnerId || !username || !claimLink) {
    return respond(400, { error: "winnerId, username and link are required." });
  }

  const requestId = `claim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const winnerRef = db.collection("prize_winners").doc(winnerId);

  let lockedWinner = null;

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(winnerRef);
      if (!snap.exists) {
        throw new Error("Reward winner record not found.");
      }

      const winner = snap.data() || {};
      const winnerUsername = String(winner.username || "").trim();
      if (!winnerUsername || normalizeUsername(winnerUsername) !== normalizeUsername(username)) {
        throw new Error("This reward does not belong to your account.");
      }

      const now = Date.now();
      const claimState = normalizeWinnerClaimState(winner);
      const alreadyClaimed = claimState === "claimed" || winner.claimedAt || winner.claimOrderId;
      if (alreadyClaimed) {
        throw new Error("This reward is already claimed.");
      }

      const createdAt = toSafeNumber(winner.createdAt, now);
      const deadlineAt = toSafeNumber(winner.claimDeadlineAt, createdAt + CLAIM_WINDOW_MS);
      if (deadlineAt < now) {
        tx.set(winnerRef, {
          claimStatus: "expired",
          updatedAt: now,
          claimExpiredAt: now
        }, { merge: true });
        throw new Error("Reward claim expired. Claim window is 10 days.");
      }

      const lockAt = toSafeNumber(winner.claimLockAt, 0);
      const isLocked = claimState === "claiming" && (now - lockAt < CLAIM_LOCK_MS);
      if (isLocked) {
        throw new Error("Claim is already in progress. Please try again shortly.");
      }

      tx.set(winnerRef, {
        claimStatus: "claiming",
        claimRequestId: requestId,
        claimLockAt: now,
        claimLink,
        updatedAt: now
      }, { merge: true });

      lockedWinner = {
        id: snap.id,
        ...winner,
        claimDeadlineAt: deadlineAt,
        claimLink,
        winnerUsername
      };
    });

    if (!lockedWinner) {
      throw new Error("Could not start reward claim.");
    }

    const now = Date.now();
    const contestId = String(lockedWinner.contestId || "").trim();
    const rewardServiceId = String(lockedWinner.rewardServiceId || "contest_reward").trim() || "contest_reward";
    const rewardServiceTitle = String(lockedWinner.rewardServiceTitle || lockedWinner.prize || "Reward").trim() || "Reward";
    const rewardQty = Math.max(1, toSafeNumber(lockedWinner.rewardQty, 1));

    let orderModeData = null;
    if (isManualService(rewardServiceId)) {
      orderModeData = await prepareManualRewardOrder({ rewardServiceId });
    } else {
      orderModeData = await placeVendorRewardOrder({
        winner: lockedWinner,
        rewardServiceId,
        rewardQty,
        claimLink
      });
    }

    const contestSnap = contestId
      ? await db.collection("prize_contests").doc(contestId).get()
      : null;
    const contest = contestSnap && contestSnap.exists ? (contestSnap.data() || {}) : {};
    const contestCharge = roundMoney(contest.totalEarnings || 0);

    let responsePayload = null;

    await db.runTransaction(async (tx) => {
      const [winnerSnap, counterSnap] = await Promise.all([
        tx.get(winnerRef),
        tx.get(db.collection("meta").doc("prize_reward_order_counter"))
      ]);

      if (!winnerSnap.exists) {
        throw new Error("Winner record missing while finalizing claim.");
      }

      const winner = winnerSnap.data() || {};
      const claimState = normalizeWinnerClaimState(winner);
      const reqId = String(winner.claimRequestId || "").trim();
      if (claimState !== "claiming" || reqId !== requestId) {
        throw new Error("Claim lock mismatch. Please retry claim.");
      }

      const current = toSafeNumber(counterSnap.exists ? counterSnap.data()?.value : 5000, 5000);
      const next = current + 1;
      const orderId = String(next);
      const orderDocId = `prize_reward_${next}`;
      const winnerUsername = String(winner.username || "").trim();

      const orderData = {
        orderId,
        orderDocId,

        winnerId,
        username: winnerUsername,
        usernameKey: normalizeUsername(winnerUsername),

        contestId,
        contestTitle: String(winner.contestTitle || contest.title || "Prize Contest").trim(),
        prizeLabel: String(winner.prize || "Reward").trim(),

        rewardServiceId,
        rewardServiceTitle,
        rewardQty,
        link: claimLink,

        mode: orderModeData.mode,
        status: orderModeData.status,

        contestCharge,
        vendorCost: roundMoney(orderModeData.vendorCost),

        vendorId: orderModeData.vendorId,
        vendorServiceId: orderModeData.vendorServiceId,
        vendorOrderId: orderModeData.vendorOrderId,
        vendorResponse: orderModeData.vendorResponse || {},

        createdAt: now,
        date: new Date(now).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
        updatedAt: now,
        createdAtTs: FieldValue.serverTimestamp()
      };

      tx.set(db.collection("meta").doc("prize_reward_order_counter"), {
        value: next,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      tx.set(db.collection("prize_orders").doc(orderDocId), orderData, { merge: true });

      tx.set(winnerRef, {
        claimStatus: "claimed",
        claimedAt: now,
        claimOrderId: orderId,
        claimOrderDocId: orderDocId,
        claimLink,
        delivery: orderModeData.mode === "vendor_auto" ? "processing" : "pending",
        vendorOrderId: orderModeData.vendorOrderId || null,
        claimRequestId: FieldValue.delete(),
        claimLockAt: FieldValue.delete(),
        updatedAt: now
      }, { merge: true });

      responsePayload = {
        orderId,
        orderDocId,
        mode: orderModeData.mode,
        status: orderModeData.status,
        contestTitle: orderData.contestTitle,
        vendorOrderId: orderModeData.vendorOrderId || null
      };
    });

    return respond(200, {
      success: true,
      ...responsePayload
    });
  } catch (err) {
    console.error("contest-claim failed:", err);

    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(winnerRef);
        if (!snap.exists) return;
        const row = snap.data() || {};
        const reqId = String(row.claimRequestId || "").trim();
        const state = normalizeWinnerClaimState(row);
        if (state === "claiming" && reqId === requestId) {
          tx.set(winnerRef, {
            claimStatus: "unclaimed",
            claimRequestId: FieldValue.delete(),
            claimLockAt: FieldValue.delete(),
            claimError: String(err?.message || "Claim failed"),
            updatedAt: Date.now()
          }, { merge: true });
        }
      });
    } catch (unlockErr) {
      console.warn("Failed to unlock winner claim:", unlockErr?.message || unlockErr);
    }

    return respond(400, {
      success: false,
      error: err?.message || "Could not claim reward."
    });
  }
};






