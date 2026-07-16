const admin = require("firebase-admin");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");

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

const MAIL_WINDOW_MS = 10 * 60 * 1000;
const MAIL_FETCH_LIMIT = Number(process.env.GMAIL_FETCH_LIMIT || 80);

const AMOUNT_RE =
  /(?:\u20B9|INR|RS\.?|Rs\.?|rs\.?)\s*([0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/gi;
const RECEIVED_AMOUNT_RE =
  /you\s+received\s*(?:\u20B9|INR|RS\.?|Rs\.?|rs\.?)\s*([0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/i;
const UTR_RE = /\bUTR\s*[:\-]?\s*([A-Z0-9]{6,})\b/i;
const TXN_RE = /\bTransaction\s*ID\s*[:\-]?\s*([A-Z0-9]{6,})\b/i;

class ManualVerifyError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function send(statusCode, body) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body),
  };
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function normalizeReference(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

function normalizeId(value) {
  return normalizeReference(value).replace(/[^A-Z0-9]/g, "");
}

function normalizeAmount(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

function extractAmountValues(text) {
  const raw = String(text || "");
  const values = [];
  const seen = new Set();

  const main = raw.match(RECEIVED_AMOUNT_RE);
  if (main && main[1]) {
    const n = normalizeAmount(String(main[1]).replace(/,/g, ""));
    if (n > 0) {
      values.push(n);
      seen.add(n);
    }
  }

  let match;
  while ((match = AMOUNT_RE.exec(raw)) !== null) {
    const n = normalizeAmount(String(match[1] || "").replace(/,/g, ""));
    if (n > 0 && !seen.has(n)) {
      values.push(n);
      seen.add(n);
    }
  }

  return values;
}

function extractUtr(text) {
  const m = String(text || "").match(UTR_RE);
  return m ? normalizeId(m[1]) : "";
}

function extractTxnId(text) {
  const m = String(text || "").match(TXN_RE);
  return m ? normalizeId(m[1]) : "";
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isFamAppMail(fromText, subject) {
  const from = String(fromText || "").toLowerCase();
  const sub = String(subject || "").toLowerCase();
  return from.includes("famapp.in") || sub.includes("you received");
}

function buildMessageText({ subject, text, htmlText }) {
  return [subject || "", text || "", htmlText || ""].join("\n").trim();
}

function createManualPaymentId() {
  return `manual_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function envelopeFromToText(envelopeFrom) {
  if (!Array.isArray(envelopeFrom) || !envelopeFrom.length) return "";
  return envelopeFrom
    .map((entry) => String(entry?.address || entry?.name || "").trim())
    .filter(Boolean)
    .join(", ");
}

async function resolveImapCredentials() {
  try {
    const snap = await db.collection("meta").doc("auto_payment_settings").get();
    const data = snap.exists ? snap.data() || {} : {};
    const manual = data.manual || {};
    const auto = data.auto || {};
    const manualUser = String(
      manual.gmailImapUser || data.manualGmailImapUser || ""
    ).trim();
    const manualPass = String(
      manual.gmailImapAppPassword || data.manualGmailImapAppPassword || ""
    )
      .trim()
      .replace(/\s+/g, "");
    if (manualUser && manualPass) {
      return { user: manualUser, pass: manualPass };
    }

    const envUser = String(process.env.GMAIL_USER || "").trim();
    const envPass = String(process.env.GMAIL_APP_PASSWORD || "")
      .trim()
      .replace(/\s+/g, "");
    if (envUser && envPass) {
      return { user: envUser, pass: envPass };
    }

    const autoUser = String(auto.gmailImapUser || data.gmailImapUser || "").trim();
    const autoPass = String(auto.gmailImapAppPassword || data.gmailImapAppPassword || "")
      .trim()
      .replace(/\s+/g, "");
    return { user: autoUser, pass: autoPass };
  } catch (_) {
    const envUser = String(process.env.GMAIL_USER || "").trim();
    const envPass = String(process.env.GMAIL_APP_PASSWORD || "")
      .trim()
      .replace(/\s+/g, "");
    if (envUser && envPass) {
      return { user: envUser, pass: envPass };
    }
    return { user: "", pass: "" };
  }
}

async function fetchCandidateMails() {
  const { user, pass } = await resolveImapCredentials();

  if (!user || !pass) {
    throw new ManualVerifyError("Gmail read failed", 500);
  }

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user,
      pass,
    },
    logger: false,
  });

  let lock = null;
  try {
    await client.connect();
    lock = await client.getMailboxLock("INBOX", { readOnly: true });

    const since = new Date(Date.now() - MAIL_WINDOW_MS);
    const uids = (await client.search({ since }, { uid: true })) || [];
    const recentUids = uids.slice(Math.max(0, uids.length - MAIL_FETCH_LIMIT));
    if (!recentUids.length) return [];

    const rows = await client.fetchAll(
      recentUids,
      {
        uid: true,
        envelope: true,
        internalDate: true,
        source: true,
      },
      { uid: true }
    );

    const out = [];
    for (const row of rows) {
      if (!row || !row.source) continue;

      const parsed = await simpleParser(row.source);
      const subject = String(parsed.subject || row.envelope?.subject || "").trim();
      const fromText = String(
        parsed.from?.text || envelopeFromToText(row.envelope?.from) || ""
      ).trim();
      const plainText = String(parsed.text || "").trim();
      const htmlText = stripHtml(parsed.html || "");
      const fullText = buildMessageText({
        subject,
        text: plainText,
        htmlText,
      });
      const internalDateMs = row.internalDate ? new Date(row.internalDate).getTime() : 0;

      out.push({
        subject,
        fromText,
        fullText,
        internalDateMs,
      });
    }

    out.sort((a, b) => Number(b.internalDateMs || 0) - Number(a.internalDateMs || 0));
    return out;
  } catch (_) {
    throw new ManualVerifyError("Gmail read failed", 500);
  } finally {
    if (lock) lock.release();
    try {
      await client.logout();
    } catch (_) {
      try {
        client.close();
      } catch (_) {}
    }
  }
}

function findMatchingMail(candidates, referenceKey, expectedAmount) {
  const now = Date.now();
  const cutoff = now - MAIL_WINDOW_MS;

  let sawExpired = false;
  let sawAmountMismatch = false;

  for (const row of candidates) {
    if (!isFamAppMail(row.fromText, row.subject)) continue;

    const text = String(row.fullText || "");
    const utr = extractUtr(text);
    const txnId = extractTxnId(text);
    const idForComparison = utr || txnId;
    if (!idForComparison) continue;

    // Rule 1 and Rule 2:
    // If UTR exists then only UTR can verify; otherwise Transaction ID can verify.
    if (idForComparison !== referenceKey) continue;

    const isRecent = Number(row.internalDateMs || 0) >= cutoff;
    if (!isRecent) {
      sawExpired = true;
      continue;
    }

    const amounts = extractAmountValues(text);
    const amountMatch = amounts.some((v) => v === expectedAmount);
    if (!amountMatch) {
      sawAmountMismatch = true;
      continue;
    }

    const lockId = utr || txnId;
    return {
      lockId,
      txnId: txnId || utr || "",
      utr: utr || "",
      subject: row.subject || "",
      senderEmail: row.fromText || "",
      snippet: text.replace(/\s+/g, " ").trim().slice(0, 220),
      matchedAt: now,
    };
  }

  if (sawAmountMismatch) {
    throw new ManualVerifyError("Amount mismatch", 400);
  }
  if (sawExpired) {
    throw new ManualVerifyError("Expired payment mail", 400);
  }
  throw new ManualVerifyError(
    "UTR verification failed, transaction not found in the last 1 hour.",
    404
  );
}

async function resolveUserRef(tx, username) {
  const directRef = db.collection("users").doc(username);
  const directSnap = await tx.get(directRef);
  if (directSnap.exists) return directRef;

  const qSnap = await tx.get(
    db.collection("users").where("username", "==", username).limit(1)
  );
  if (!qSnap.empty) return qSnap.docs[0].ref;

  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return send(405, { success: false, error: "Method Not Allowed" });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const username = normalizeUsername(body.username || "");
    const payerName = String(body.payerName || "").trim();
    const referenceRaw = String(body.reference || "").trim();
    const referenceNormalized = normalizeReference(referenceRaw);
    const referenceKey = normalizeId(referenceRaw);
    const amount = normalizeAmount(body.amount);

    if (!username) throw new ManualVerifyError("Username required", 400);
    if (!payerName) throw new ManualVerifyError("Payer name required", 400);
    if (!referenceNormalized || !referenceKey || referenceKey.length < 6) {
      throw new ManualVerifyError("Invalid reference", 400);
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ManualVerifyError("Invalid amount", 400);
    }

    // Must be checked before Gmail read.
    const earlyLockRef = db.collection("auto_payment_txn_locks").doc(referenceKey);
    const earlyLockSnap = await earlyLockRef.get();
    if (earlyLockSnap.exists) {
      return send(409, { success: false, error: "Already used" });
    }

    const candidates = await fetchCandidateMails();
    const matched = findMatchingMail(candidates, referenceKey, amount);

    const lockRef = db.collection("auto_payment_txn_locks").doc(matched.lockId);
    const paymentId = createManualPaymentId();
    const paymentRef = db.collection("payments").doc(paymentId);
    const createdAt = Date.now();

    await db.runTransaction(async (tx) => {
      const txnLockSnap = await tx.get(lockRef);
      if (txnLockSnap.exists) {
        throw new ManualVerifyError("Already used", 409);
      }

      const userRef = await resolveUserRef(tx, username);
      if (!userRef) {
        throw new ManualVerifyError("User not found", 404);
      }

      tx.update(userRef, {
        balance: FieldValue.increment(amount),
        updatedAt: FieldValue.serverTimestamp(),
      });

      tx.create(paymentRef, {
        username,
        userId: userRef.id,
        payerName,
        amount,
        method: "manual",
        status: "approved",
        createdAt,
        approvedAt: FieldValue.serverTimestamp(),
        date: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
        utr: matched.utr || matched.txnId,
        txnId: matched.txnId || matched.utr,
        reference: referenceKey,
        source: "gmail_verify",
        gmailMatched: true,
        senderEmail: matched.senderEmail || "",
        gmailSubject: String(matched.subject || "").slice(0, 220),
        gmailSnippet: String(matched.snippet || "").slice(0, 220),
        matchedAt: matched.matchedAt,
      });

      tx.set(lockRef, {
        amount,
        createdAt,
        paymentId,
        source: "gmail_verify",
        txnId: matched.lockId,
        username,
      });
    });

    db.collection("auto_payment_logs")
      .add({
        eventType: "manual_gmail_verified",
        paymentId,
        username,
        amount,
        txnId: matched.lockId,
        senderEmail: matched.senderEmail || "",
        subject: matched.subject || "",
        snippet: matched.snippet || "",
        source: "gmail_verify",
        createdAt: Date.now(),
        date: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
      })
      .catch(() => {});

    return send(200, {
      success: true,
      amount,
      txnId: matched.lockId,
      message: "Payment verified successfully",
    });
  } catch (err) {
    if (err instanceof ManualVerifyError) {
      return send(err.statusCode || 400, {
        success: false,
        error: err.message || "Verification failed",
      });
    }
    console.error("manual-payment-verify error:", err);
    return send(500, {
      success: false,
      error: "Gmail read failed",
    });
  }
};
