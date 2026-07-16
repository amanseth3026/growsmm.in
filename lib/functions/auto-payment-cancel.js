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
    const paymentId = String(body.paymentId || "").trim();
    const username = String(body.username || "").trim();
    const reason = String(body.reason || "user_cancelled").slice(0, 80);

    if (!paymentId) return send(400, { error: "paymentId required" });

    const ref = db.collection("payments").doc(paymentId);
    const snap = await ref.get();
    if (!snap.exists) return send(404, { error: "Payment not found" });

    const p = snap.data();
    if (String(p.method || "").toLowerCase() !== "auto") {
      return send(400, { error: "Not an auto payment" });
    }
    if (username && String(p.username || "") !== username) {
      return send(403, { error: "Payment does not belong to this user" });
    }

    const currentStatus = String(p.status || "pending").toLowerCase();
    if (currentStatus === "pending") {
      await ref.update({
        status: "canceled",
        canceledAt: Date.now(),
        lastCheckReason: reason,
      });
      return send(200, { success: true, paymentId, status: "canceled" });
    }

    return send(200, { success: true, paymentId, status: currentStatus });
  } catch (err) {
    console.error("auto-payment-cancel error:", err);
    return send(500, { error: err.message || "Internal error" });
  }
};

