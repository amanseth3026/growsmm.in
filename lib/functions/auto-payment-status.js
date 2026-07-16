const fetch = require("node-fetch");
const admin = require("firebase-admin");
const { AUTO_PAYMENT_CONFIG } = require("./auto-payment-config");
const { loadAutoPaymentSettings } = require("./auto-payment-settings");

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

const GMAIL_THROTTLE_MS = Number(process.env.AUTO_GMAIL_POLL_MS || 9000);
const GMAIL_FROM_MATCH = String(
  process.env.GMAIL_FROM_MATCH || AUTO_PAYMENT_CONFIG.gmailFromMatch || "famapp.in,famapp"
).toLowerCase();
const GMAIL_MAX_MSG_AGE_SEC = Number(
  process.env.GMAIL_MESSAGE_MAX_AGE_SEC || AUTO_PAYMENT_CONFIG.gmailMessageMaxAgeSec || 30
);
const PREFER_PY_WATCHER = !!AUTO_PAYMENT_CONFIG.preferPyWatcher;

function send(statusCode, body) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body),
  };
}

function getMissingConfig(effective, payment) {
  const missing = [];
  if (!process.env.GMAIL_CLIENT_ID) missing.push("GMAIL_CLIENT_ID");
  if (!process.env.GMAIL_CLIENT_SECRET) missing.push("GMAIL_CLIENT_SECRET");
  if (!process.env.GMAIL_REFRESH_TOKEN) missing.push("GMAIL_REFRESH_TOKEN");
  if (!effective.gmailImapUser) missing.push("GMAIL_IMAP_USER");
  if (!effective.gmailImapAppPassword) missing.push("GMAIL_IMAP_APP_PASSWORD");
  if (!(payment?.confirmToken || effective.autoPaymentConfirmSecret)) {
    missing.push("AUTO_PAYMENT_CONFIRM_SECRET");
  }
  return missing;
}

function resolvePyConfig(settings = {}, payment = null) {
  const autoSettings = settings.auto || {};
  const gmailImapUser = String(
    autoSettings.gmailImapUser || settings.gmailImapUser || ""
  ).trim();
  const gmailImapAppPassword = String(
    autoSettings.gmailImapAppPassword || settings.gmailImapAppPassword || ""
  )
    .trim()
    .replace(/\s+/g, "");
  const autoPaymentConfirmSecret = String(
    autoSettings.autoPaymentConfirmSecret || settings.autoPaymentConfirmSecret || ""
  ).trim();
  const hasConfirmToken = Boolean(payment?.confirmToken || autoPaymentConfirmSecret);
  const hasPyConfig = Boolean(gmailImapUser && gmailImapAppPassword && hasConfirmToken);

  return {
    gmailImapUser,
    gmailImapAppPassword,
    autoPaymentConfirmSecret,
    hasPyConfig,
  };
}

function b64UrlDecode(input) {
  if (!input) return "";
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(normalized + pad, "base64").toString("utf8");
}

function collectPartsText(payload) {
  if (!payload) return "";
  let text = "";
  if (payload.body && payload.body.data) {
    text += " " + b64UrlDecode(payload.body.data);
  }
  if (Array.isArray(payload.parts)) {
    for (const p of payload.parts) {
      text += " " + collectPartsText(p);
    }
  }
  return text;
}

function getHeader(payload, name) {
  const headers = Array.isArray(payload?.headers) ? payload.headers : [];
  const h = headers.find((x) => (x.name || "").toLowerCase() === name.toLowerCase());
  return (h?.value || "").toString();
}

function amountTextVariants(amount) {
  const n = Number(amount || 0);
  if (!Number.isFinite(n) || n <= 0) return [];
  const fixed2 = n.toFixed(2);
  const fixed1 = n.toFixed(1);
  const plain = String(Number(fixed2));
  const compact = fixed2.replace(/\.00$/, "");
  return Array.from(new Set([fixed2, fixed1, plain, compact]));
}

function extractTxnId(text) {
  const m = (text || "").match(/transaction\s*id\s*[:\-]?\s*([A-Z0-9]{8,})/i);
  return m ? m[1] : "";
}

function normalizeTxnId(txnId) {
  return String(txnId || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

function extractNumericAmounts(text) {
  const raw = String(text || "");
  const out = [];
  const re = /(?:₹|INR|RS\.?|RS)?\s*([0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const n = Number(String(m[1]).replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(Number(n.toFixed(2)));
  }
  return out;
}

function hasExactAmountMatch(text, expectedAmount) {
  const target = Number(Number(expectedAmount || 0).toFixed(2));
  if (!Number.isFinite(target) || target <= 0) return false;
  const nums = extractNumericAmounts(text);
  return nums.some((n) => n === target);
}

async function getGmailAccessToken() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) return null;

  const form = new URLSearchParams();
  form.append("client_id", clientId);
  form.append("client_secret", clientSecret);
  form.append("refresh_token", refreshToken);
  form.append("grant_type", "refresh_token");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Gmail token failed: ${txt}`);
  }

  const json = await res.json();
  return json.access_token;
}

async function listCandidateMessages(accessToken, payment) {
  const amountText = Number(payment.payableAmount || payment.amount || 0).toFixed(2);
  const createdAt = Number(payment.createdAt || 0);
  const now = Date.now();
  const recentWindowStart = now - GMAIL_MAX_MSG_AGE_SEC * 1000;
  const afterTs = Math.max(createdAt - 5000, recentWindowStart);
  const afterUnix = Math.floor(afterTs / 1000);
  const hint = process.env.GMAIL_SEARCH_HINT || AUTO_PAYMENT_CONFIG.gmailSearchHint || "FamX account OR FamApp OR received";
  const query = `after:${afterUnix} "${amountText}" ${hint}`.trim();

  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(
    query
  )}&maxResults=20`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Gmail list failed: ${txt}`);
  }
  const json = await res.json();
  return Array.isArray(json.messages) ? json.messages : [];
}

function messageLooksLikeCredit(text, amountText) {
  const body = (text || "").toLowerCase();
  if (!body.includes(amountText.toLowerCase())) return false;

  const keywords = (
    process.env.GMAIL_CREDIT_KEYWORDS ||
    AUTO_PAYMENT_CONFIG.gmailCreditKeywords ||
    "credited,received,success,payment,upi,money received"
  )
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  return keywords.some((k) => body.includes(k));
}

async function findMatchingPaymentMessage(accessToken, payment) {
  const amountText = Number(payment.payableAmount || payment.amount || 0).toFixed(2);
  const candidates = await listCandidateMessages(accessToken, payment);
  const fromTokens = GMAIL_FROM_MATCH.split(",").map((x) => x.trim()).filter(Boolean);
  const amountVariants = amountTextVariants(payment.payableAmount || payment.amount || 0);
  const expectedAmount = Number(payment.payableAmount || payment.amount || 0);
  const now = Date.now();
  const minTs = Math.max(Number(payment.createdAt || 0) - 5000, now - GMAIL_MAX_MSG_AGE_SEC * 1000);

  for (const msg of candidates) {
    const detailRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    if (!detailRes.ok) continue;

    const detail = await detailRes.json();
    const internalDate = Number(detail.internalDate || 0);
    if (internalDate && internalDate < minTs) continue;

    const subject = getHeader(detail.payload, "Subject");
    const from = getHeader(detail.payload, "From");
    const fromLower = from.toLowerCase();
    if (fromTokens.length && !fromTokens.some((token) => fromLower.includes(token))) {
      continue;
    }

    const snippet = detail.snippet || "";
    const fullText = `${subject}\n${snippet}\n${collectPartsText(detail.payload)}`;

    const hasAmount = amountVariants.some((v) => {
      const compact = v.replace(/,/g, "");
      return (
        fullText.includes(v) ||
        fullText.includes(`₹${v}`) ||
        fullText.includes(`Rs ${v}`) ||
        fullText.includes(`INR ${v}`) ||
        fullText.includes(compact) ||
        fullText.includes(`₹${compact}`)
      );
    });
    if (!hasAmount) continue;
    if (!hasExactAmountMatch(fullText, expectedAmount)) continue;
    if (!messageLooksLikeCredit(fullText, amountText)) continue;

    return {
      id: detail.id,
      threadId: detail.threadId,
      snippet: snippet.slice(0, 180),
      subject: String(subject || "").slice(0, 180),
      txnId: extractTxnId(fullText),
      from: String(from || "").slice(0, 180),
      internalDate,
    };
  }
  return null;
}

async function settleIfMatched(paymentDoc, options = {}) {
  const payment = paymentDoc.data();
  const hasPyConfig = !!options.hasPyConfig;
  if (payment.status !== "pending") return false;
  if (Date.now() > Number(payment.expiresAt || 0)) return false;

  // If Python watcher is configured, avoid OAuth polling noise by default.
  if (PREFER_PY_WATCHER && payment.watcherTriggered && hasPyConfig) {
    await paymentDoc.ref.update({
      lastGmailCheckAt: Date.now(),
      lastCheckReason: "waiting_python_watcher",
      checkAttempts: FieldValue.increment(1),
    });
    return false;
  }

  let token = null;
  try {
    token = await getGmailAccessToken();
  } catch (e) {
    const msg = String(e.message || "");
    const reason = msg.includes("invalid_client")
      ? "oauth_invalid_client"
      : `oauth_error:${msg.slice(0, 60)}`;
    await paymentDoc.ref.update({
      lastGmailCheckAt: Date.now(),
      lastCheckReason: reason,
      checkAttempts: FieldValue.increment(1),
    });
    return false;
  }

  if (!token) {
    const reason =
      payment.watcherTriggered && hasPyConfig
        ? "oauth_not_configured_waiting_python"
        : "gmail_config_missing";
    await paymentDoc.ref.update({
      lastGmailCheckAt: Date.now(),
      lastCheckReason: reason,
      checkAttempts: FieldValue.increment(1),
    });
    return false;
  }

  const hit = await findMatchingPaymentMessage(token, payment);

  await paymentDoc.ref.update({
    lastGmailCheckAt: Date.now(),
    checkAttempts: FieldValue.increment(1),
  });

  if (!hit) {
    await paymentDoc.ref.update({
      lastCheckReason: "mail_not_matched",
    });
    return false;
  }

  await db.collection("auto_payment_logs").add({
    eventType: "mail_detected",
    paymentId: paymentDoc.id,
    username: payment.username || "",
    amount: Number(payment.amount || 0),
    senderEmail: hit.from || "",
    txnId: hit.txnId || "",
    subject: hit.subject || "",
    snippet: hit.snippet || "",
    source: "gmail_api",
    createdAt: Date.now(),
    date: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
  });

  let didCredit = false;
  const creditLogRef = db.collection("auto_payment_logs").doc();
  await db.runTransaction(async (tx) => {
    const freshPaymentSnap = await tx.get(paymentDoc.ref);
    if (!freshPaymentSnap.exists) return;
    const freshPayment = freshPaymentSnap.data();

    if (freshPayment.status !== "pending") return;
    if (Date.now() > Number(freshPayment.expiresAt || 0)) return;

    let userRef = null;
    if (freshPayment.userId) {
      userRef = db.collection("users").doc(freshPayment.userId);
    } else {
      const uSnap = await db
        .collection("users")
        .where("username", "==", freshPayment.username)
        .limit(1)
        .get();
      if (!uSnap.empty) userRef = uSnap.docs[0].ref;
    }
    if (!userRef) throw new Error("User missing for auto settlement");

    const txnNorm = normalizeTxnId(hit.txnId);
    if (!txnNorm) {
      tx.update(paymentDoc.ref, {
        lastCheckReason: "txn_missing",
      });
      return;
    }
    const txnLockRef = db.collection("auto_payment_txn_locks").doc(txnNorm);
    const txnLockSnap = await tx.get(txnLockRef);
    if (txnLockSnap.exists) {
      tx.update(paymentDoc.ref, {
        lastCheckReason: "duplicate_txn",
      });
      return;
    }

    tx.update(userRef, {
      balance: FieldValue.increment(Number(freshPayment.amount || 0)),
      updatedAt: FieldValue.serverTimestamp(),
    });

    tx.update(paymentDoc.ref, {
      status: "approved",
      approvedAt: FieldValue.serverTimestamp(),
      gmailMatched: true,
      gmailMessageId: hit.id,
      gmailThreadId: hit.threadId,
      senderEmail: hit.from || "",
      gmailSnippet: hit.snippet,
      gmailSubject: hit.subject || "",
      utr: txnNorm,
      txnId: txnNorm,
      matchedAt: Date.now(),
      source: "gmail_auto",
      lastCheckReason: "credited",
    });
    tx.set(txnLockRef, {
      paymentId: paymentDoc.id,
      username: freshPayment.username || "",
      amount: Number(freshPayment.amount || 0),
      txnId: txnNorm,
      createdAt: Date.now(),
      source: "gmail_auto",
    });

    tx.set(creditLogRef, {
      eventType: "credited",
      paymentId: paymentDoc.id,
      username: freshPayment.username || "",
      amount: Number(freshPayment.amount || 0),
      senderEmail: hit.from || "",
      txnId: txnNorm,
      subject: hit.subject || "",
      snippet: hit.snippet || "",
      source: "gmail_api",
      createdAt: Date.now(),
      date: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    });
    didCredit = true;
  });

  return didCredit;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return send(405, { error: "Method Not Allowed" });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const paymentId = (body.paymentId || "").trim();
    const username = (body.username || "").trim();
    if (!paymentId) return send(400, { error: "paymentId required" });

    const ref = db.collection("payments").doc(paymentId);
    const snap = await ref.get();
    if (!snap.exists) return send(404, { error: "Payment not found" });

    const payment = snap.data();
    const settings = await loadAutoPaymentSettings();
    const effective = resolvePyConfig(settings, payment);
    if (payment.method !== "auto") return send(400, { error: "Not an auto payment" });
    if (username && payment.username !== username) {
      return send(403, { error: "Payment does not belong to this user" });
    }

    const now = Date.now();
    if (payment.status === "pending" && now > Number(payment.expiresAt || 0)) {
      await ref.update({
        status: "expired",
        expiredAt: now,
        lastCheckReason: "expired",
      });
    } else if (
      payment.status === "pending" &&
      now <= Number(payment.expiresAt || 0) &&
      now - Number(payment.lastGmailCheckAt || 0) >= GMAIL_THROTTLE_MS
    ) {
      try {
        await settleIfMatched(snap, { hasPyConfig: effective.hasPyConfig });
      } catch (e) {
        console.error("gmail settle error:", e.message);
        await ref.update({
          lastGmailCheckAt: Date.now(),
          lastCheckReason: `gmail_error:${String(e.message || "").slice(0, 80)}`,
          checkAttempts: FieldValue.increment(1),
        });
      }
    }

    const latest = await ref.get();
    const p = latest.data();
    const effectiveLatest = resolvePyConfig(settings, p);
    const msLeft = Math.max(0, Number(p.expiresAt || 0) - Date.now());

    return send(200, {
      success: true,
      paymentId: latest.id,
      username: p.username,
      status: p.status,
      method: p.method,
      amount: Number(p.amount || 0),
      payableAmount: Number(p.payableAmount || p.amount || 0),
      baseAmount: Number(p.baseAmount || 0),
      expiresAt: p.expiresAt || 0,
      secondsLeft: Math.floor(msLeft / 1000),
      gmailMatched: !!p.gmailMatched,
      debugReason: p.lastCheckReason || "",
      checkAttempts: Number(p.checkAttempts || 0),
      watcherTriggered: !!p.watcherTriggered,
      watcherSource: p.watcherSource || "",
      watcherStatus: p.watcherStatus || "",
      watcherReason: p.watcherReason || "",
      missingConfig: getMissingConfig(effectiveLatest, p),
    });
  } catch (err) {
    console.error("auto-payment-status error:", err);
    return send(500, { error: err.message || "Internal error" });
  }
};
