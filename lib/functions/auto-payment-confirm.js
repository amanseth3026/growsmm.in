const admin = require("firebase-admin");

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

if (!admin.apps.length) {
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
  });
}

const db = admin.firestore();
const { FieldValue } = admin.firestore;

function normalizeTxnId(txnId) {
  return String(txnId || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

function send(statusCode, body) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return send(405, { error: "Method Not Allowed" });

  try {
    const body = JSON.parse(event.body || "{}");
    const paymentId = (body.paymentId || "").trim();
    const secret = (body.secret || "").trim();
    const confirmToken = (body.confirmToken || "").trim();
    const txnId = normalizeTxnId(body.txnId || "");
    const snippet = (body.snippet || "").toString().slice(0, 220);
    const subject = (body.subject || "").toString().slice(0, 220);
    const senderEmail = (body.senderEmail || "").toString().slice(0, 180);

    if (!paymentId) return send(400, { error: "paymentId required" });

    const envSecret = (process.env.AUTO_PAYMENT_CONFIRM_SECRET || "").trim();
    const hasToken = !!confirmToken;
    if (!hasToken && (!secret || secret !== envSecret)) {
      return send(403, { error: "Invalid secret" });
    }

    const paymentRef = db.collection("payments").doc(paymentId);
    let didCredit = false;
    const detectLogRef = paymentRef.collection("auto_payment_logs").doc();
    const creditLogRef = paymentRef.collection("auto_payment_logs").doc();

    await db.runTransaction(async (tx) => {
      const pSnap = await tx.get(paymentRef);
      if (!pSnap.exists) throw new Error("Payment not found");
      const p = pSnap.data();

      if (hasToken) {
        if (!p.confirmToken || p.confirmToken !== confirmToken) {
          throw new Error("confirm_token_invalid");
        }
      }

      if (p.method !== "auto") throw new Error("Not auto payment");
      if (p.status !== "pending") return;
      if (Date.now() > Number(p.expiresAt || 0)) {
        tx.update(paymentRef, { status: "expired", expiredAt: Date.now() });
        return;
      }

      let userRef = null;
      if (p.userId) userRef = db.collection("users").doc(p.userId);
      if (!userRef) {
        const uSnap = await tx.get(
          db.collection("users").where("username", "==", String(p.username || "")).limit(1)
        );
        if (!uSnap.empty) userRef = uSnap.docs[0].ref;
      }
      if (!userRef) throw new Error("User ref missing");
      if (!txnId) {
        tx.update(paymentRef, { lastCheckReason: "txn_missing" });
        return;
      }

      const txnLockRef = db.collection("auto_payment_txn_locks").doc(txnId);
      const txnLockSnap = await tx.get(txnLockRef);
      if (txnLockSnap.exists) {
        tx.update(paymentRef, { lastCheckReason: "duplicate_txn" });
        return;
      }

      // Check txn lock inside payment document to avoid extra document read
      const pData = p;
      if (pData && pData.txnLocks && pData.txnLocks[txnId]) {
        tx.update(paymentRef, { lastCheckReason: "duplicate_txn" });
        return;
      }

      tx.update(userRef, {
        balance: FieldValue.increment(Number(p.amount || 0)),
        updatedAt: FieldValue.serverTimestamp(),
      });

      tx.update(paymentRef, {
        status: "approved",
        approvedAt: FieldValue.serverTimestamp(),
        source: "python_gmail",
        gmailMatched: true,
        senderEmail: senderEmail || "",
        utr: txnId || "",
        txnId: txnId || "",
        gmailSnippet: snippet || "",
        gmailSubject: subject || "",
        matchedAt: Date.now(),
        lastCheckReason: "credited_python",
        checkAttempts: FieldValue.increment(1),
        confirmToken: FieldValue.delete(),
      });

      tx.set(detectLogRef, {
        eventType: "mail_detected",
        paymentId,
        username: p.username || "",
        amount: Number(p.amount || 0),
        senderEmail: senderEmail || "",
        txnId: txnId || "",
        subject: subject || "",
        snippet: snippet || "",
        source: "python_watcher",
        createdAt: Date.now(),
        date: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
      });

      tx.set(creditLogRef, {
        eventType: "credited",
        paymentId,
        username: p.username || "",
        amount: Number(p.amount || 0),
        senderEmail: senderEmail || "",
        txnId: txnId || "",
        subject: subject || "",
        snippet: snippet || "",
        source: "python_watcher",
        createdAt: Date.now(),
        date: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
      });

      tx.set(txnLockRef, {
        paymentId,
        username: p.username || "",
        amount: Number(p.amount || 0),
        txnId,
        createdAt: Date.now(),
        source: "python_watcher",
      });

      // Store txn lock inside the payment document to reduce reads
      const lockField = {};
      lockField[`txnLocks.${txnId}`] = {
        paymentId,
        username: p.username || "",
        amount: Number(p.amount || 0),
        txnId,
        createdAt: Date.now(),
        source: "python_watcher",
      };
      tx.update(paymentRef, lockField);
      didCredit = true;
    });

    return send(200, { success: true, paymentId, credited: didCredit });
  } catch (err) {
    if (String(err.message || "").includes("confirm_token_invalid")) {
      return send(403, { error: "Invalid confirm token" });
    }
    console.error("auto-payment-confirm error:", err);
    return send(500, { error: err.message || "Internal error" });
  }
};
