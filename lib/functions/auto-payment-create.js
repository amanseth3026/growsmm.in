const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
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

const AUTO_EXPIRY_MS = Number(AUTO_PAYMENT_CONFIG.autoPaymentExpiryMs || 3 * 60 * 1000);
const DEFAULT_AUTO_UPI_ID = process.env.AUTO_UPI_ID || "amanseth54@fam";
const DEFAULT_AUTO_UPI_NAME = process.env.AUTO_UPI_NAME || "";
const WATCHER_ENABLED = !!AUTO_PAYMENT_CONFIG.enablePyWatcher;
const GITHUB_WATCHER_ENABLED = (process.env.ENABLE_GITHUB_WATCHER || "false").toLowerCase() === "true";
const GITHUB_REPO_OWNER = process.env.GITHUB_REPO_OWNER || "";
const GITHUB_REPO_NAME = process.env.GITHUB_REPO_NAME || "";
const GITHUB_WORKFLOW_FILE = process.env.GITHUB_WORKFLOW_FILE || "run-watcher.yml";
const GITHUB_REF = process.env.GITHUB_REF || "main";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const ALLOW_LOCAL_PY_FALLBACK =
  (process.env.ALLOW_LOCAL_PY_FALLBACK || "false").toLowerCase() === "true";

function send(statusCode, body) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body),
  };
}

function buildQrData(amount, paymentId, upiId, upiName) {
  const am = Number(amount).toFixed(2);
  const note = `AUTO_${paymentId}`;
  return `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(
    upiName
  )}&am=${encodeURIComponent(am)}&cu=INR&tn=${encodeURIComponent(note)}`;
}

function qrImageUrl(qrData) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(
    qrData
  )}`;
}

function hashToPaise(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return (h % 80) + 10; // 10..89
}

function generatePayableAmount(baseAmount, paymentId) {
  // Index-free uniqueness strategy using paymentId hash.
  const paise = hashToPaise(paymentId);
  return Number((baseAmount + paise / 100).toFixed(2));
}

function normalizeSettingString(value) {
  return String(value || "").trim();
}

async function loadPanelSettingsFallback() {
  try {
    const snap = await db.collection("meta").doc("panel_settings").get();
    if (snap.exists) {
      return snap.data() || {};
    }
  } catch (err) {
    console.warn("auto-payment-create panel settings load failed:", err.message);
  }
  return {};
}

function normalizeImapPassword(value) {
  return normalizeSettingString(value).replace(/\s+/g, "");
}

function getHeaderValue(headers, name) {
  if (!headers) return "";
  const key = String(name || "").toLowerCase();
  const direct = headers[key];
  if (direct) return String(direct).split(",")[0].trim();
  const match = Object.entries(headers).find(([k]) => String(k).toLowerCase() === key);
  return match ? String(match[1]).split(",")[0].trim() : "";
}

function buildAutoConfirmUrl(event) {
  const headers = event?.headers || {};
  const host =
    getHeaderValue(headers, "x-forwarded-host") ||
    getHeaderValue(headers, "host");
  if (!host) return "";
  let proto =
    getHeaderValue(headers, "x-forwarded-proto") ||
    getHeaderValue(headers, "x-forwarded-protocol");
  if (!proto) {
    proto = host.includes("localhost") || host.includes("127.0.0.1") ? "http" : "https";
  }
  return `${proto}://${host}/api/auto-payment-confirm`;
}

function isHttpUrl(value) {
  const raw = normalizeSettingString(value);
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_) {
    return false;
  }
}

function isLoopbackHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "0.0.0.0"
  );
}

function isPublicHttpUrl(value) {
  const raw = normalizeSettingString(value);
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return !isLoopbackHost(parsed.hostname);
  } catch (_) {
    return false;
  }
}

function pickConfirmUrl(candidates = [], options = {}) {
  const requirePublic = !!options.requirePublic;
  for (const candidate of candidates) {
    const value = normalizeSettingString(candidate);
    if (!value) continue;
    const valid = requirePublic ? isPublicHttpUrl(value) : isHttpUrl(value);
    if (valid) return value;
  }
  return "";
}

function resolveConfirmUrls(event, preferredUrl = "") {
  const candidates = [
    preferredUrl,
    normalizeSettingString(process.env.AUTO_CONFIRM_URL),
    buildAutoConfirmUrl(event),
    normalizeSettingString(AUTO_PAYMENT_CONFIG.autoConfirmUrl),
  ];
  return {
    any: pickConfirmUrl(candidates, { requirePublic: false }),
    public: pickConfirmUrl(candidates, { requirePublic: true }),
  };
}

function generateConfirmToken() {
  return crypto.randomBytes(24).toString("hex");
}

async function createSimplePaymentId(createdAt) {
  // Preferred format: auto_<timestamp>
  let ts = Number(createdAt || Date.now());
  for (let i = 0; i < 5; i++) {
    const candidate = `auto_${ts}`;
    const snap = await db.collection("payments").doc(candidate).get();
    if (!snap.exists) return candidate;
    ts += 1;
  }
  // Last resort, still starts with auto_<timestamp>
  return `auto_${Date.now()}`;
}

function triggerPythonWatcher(payload) {
  try {
    if (!WATCHER_ENABLED) {
      return { ok: false, reason: "py_watcher_disabled" };
    }

    const pythonBin = AUTO_PAYMENT_CONFIG.pythonBin || "python";
    const scriptPath =
      AUTO_PAYMENT_CONFIG.pyWatcherScript ||
      path.resolve(process.cwd(), "scripts", "gmail_auto_watcher.py");

    const autoConfirmUrl =
      payload.autoConfirmUrl ||
      process.env.AUTO_CONFIRM_URL ||
      AUTO_PAYMENT_CONFIG.autoConfirmUrl;
    const confirmSecret =
      payload.confirmToken || process.env.AUTO_PAYMENT_CONFIRM_SECRET || "";
    const gmailImapUser = payload.gmailImapUser || process.env.GMAIL_IMAP_USER || "";
    const gmailImapAppPassword =
      payload.gmailImapAppPassword || process.env.GMAIL_IMAP_APP_PASSWORD || "";

    const child = spawn(
      pythonBin,
      [
        scriptPath,
        "--payment-id",
        payload.paymentId,
        "--username",
        payload.username,
        "--amount",
        String(payload.amount),
        "--expires-at",
        String(payload.expiresAt),
      ],
      {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          PY_WATCHER_INTERVAL_SEC: String(AUTO_PAYMENT_CONFIG.pyWatcherIntervalSec || 8),
          PY_WATCHER_MAX_RUNTIME_SEC: String(AUTO_PAYMENT_CONFIG.pyWatcherMaxRuntimeSec || 240),
          AUTO_CONFIRM_URL: autoConfirmUrl,
          AUTO_PAYMENT_CONFIRM_SECRET: confirmSecret,
          GMAIL_IMAP_USER: gmailImapUser,
          GMAIL_IMAP_APP_PASSWORD: gmailImapAppPassword,
          GMAIL_FROM_MATCH:
            process.env.GMAIL_FROM_MATCH || AUTO_PAYMENT_CONFIG.gmailFromMatch,
          GMAIL_MESSAGE_MAX_AGE_SEC: String(
            Number(process.env.GMAIL_MESSAGE_MAX_AGE_SEC || AUTO_PAYMENT_CONFIG.gmailMessageMaxAgeSec || 30)
          ),
          GMAIL_SEARCH_HINT:
            process.env.GMAIL_SEARCH_HINT || AUTO_PAYMENT_CONFIG.gmailSearchHint,
          GMAIL_CREDIT_KEYWORDS:
            process.env.GMAIL_CREDIT_KEYWORDS || AUTO_PAYMENT_CONFIG.gmailCreditKeywords,
        },
      }
    );
    child.unref();

    db.collection("auto_payment_logs").add({
      eventType: "watcher_triggered",
      paymentId: payload.paymentId,
      username: payload.username,
      amount: Number(payload.amount || 0),
      source: "auto_payment_create",
      status: "ok",
      createdAt: Date.now(),
      date: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    }).catch(() => {});
    return { ok: true, reason: "python_watcher_triggered" };
  } catch (e) {
    // Do not fail QR creation if watcher spawn fails.
    console.warn("python watcher trigger failed:", e.message);
    db.collection("auto_payment_logs").add({
      eventType: "watcher_triggered",
      paymentId: payload.paymentId,
      username: payload.username,
      amount: Number(payload.amount || 0),
      source: "auto_payment_create",
      status: "failed",
      error: e.message || "spawn_failed",
      createdAt: Date.now(),
      date: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    }).catch(() => {});
    return { ok: false, reason: "python_spawn_failed", detail: e.message || "" };
  }
}

async function triggerGitHubWatcher(payload) {
  if (!GITHUB_WATCHER_ENABLED) return { ok: false, reason: "github_watcher_disabled" };
  if (!GITHUB_TOKEN || !GITHUB_REPO_OWNER || !GITHUB_REPO_NAME || !GITHUB_WORKFLOW_FILE) {
    return { ok: false, reason: "github_watcher_missing_config" };
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(
    GITHUB_REPO_OWNER
  )}/${encodeURIComponent(GITHUB_REPO_NAME)}/actions/workflows/${encodeURIComponent(
    GITHUB_WORKFLOW_FILE
  )}/dispatches`;

  const inputs = {
    payment_id: payload.paymentId,
    username: payload.username,
    amount: String(payload.amount),
    expires_at: String(payload.expiresAt),
  };
  if (payload.gmailImapUser) inputs.gmail_imap_user = payload.gmailImapUser;
  if (payload.gmailImapAppPassword) {
    inputs.gmail_imap_app_password = payload.gmailImapAppPassword;
  }
  if (payload.autoConfirmUrl) inputs.auto_confirm_url = payload.autoConfirmUrl;
  if (payload.confirmToken) inputs.confirm_token = payload.confirmToken;

  const body = {
    ref: GITHUB_REF,
    inputs,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "smm-auto-payment-create",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 204) {
    return { ok: true, reason: "github_watcher_triggered" };
  }
  const errText = await res.text();
  return {
    ok: false,
    reason: `github_watcher_http_${res.status}`,
    detail: String(errText || "").slice(0, 220),
  };
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
    const username = (body.username || "").trim();
    const amount = Number(body.amount || 0);
    const payerName = (body.payerName || "").trim();

    if (!username) return send(400, { error: "Username required" });
    if (!Number.isFinite(amount) || amount < 10) {
      return send(400, { error: "Min amount is 10" });
    }

    const userSnap = await db
      .collection("users")
      .where("username", "==", username)
      .limit(1)
      .get();
    if (userSnap.empty) return send(404, { error: "User not found" });
    const userDoc = userSnap.docs[0];

    const createdAt = Date.now();
    const expiresAt = createdAt + AUTO_EXPIRY_MS;
    const paymentId = await createSimplePaymentId(createdAt);
    const payableAmount = generatePayableAmount(amount, paymentId);
    const [settings, panelSettings] = await Promise.all([
      loadAutoPaymentSettings(),
      loadPanelSettingsFallback(),
    ]);
    const autoSettings = settings.auto || {};
    const autoUpiId =
      normalizeSettingString(
        autoSettings.upiId || settings.autoUpiId || settings.upiId
      ) || DEFAULT_AUTO_UPI_ID;
    const autoUpiName =
      normalizeSettingString(
        autoSettings.upiName || settings.autoUpiName || settings.upiName
      ) ||
      normalizeSettingString(panelSettings.panelName) ||
      DEFAULT_AUTO_UPI_NAME;
    const preferredAutoConfirmUrl = normalizeSettingString(
      autoSettings.autoConfirmUrl || settings.autoConfirmUrl
    );
    const confirmUrls = resolveConfirmUrls(event, preferredAutoConfirmUrl);
    const autoConfirmUrl = confirmUrls.any;
    const publicAutoConfirmUrl = confirmUrls.public;
    const gmailImapUser = normalizeSettingString(
      autoSettings.gmailImapUser || settings.gmailImapUser
    );
    const gmailImapAppPassword = normalizeImapPassword(
      autoSettings.gmailImapAppPassword || settings.gmailImapAppPassword
    );

    const confirmToken = generateConfirmToken();
    const qrData = buildQrData(payableAmount, paymentId, autoUpiId, autoUpiName);
    const qrUrl = qrImageUrl(qrData);

    await db.collection("payments").doc(paymentId).set({
      username,
      userId: userDoc.id,
      payerName: payerName || username,
      amount: payableAmount,
      baseAmount: Number(amount.toFixed(2)),
      payableAmount,
      utr: paymentId,
      method: "auto",
      status: "pending",
      createdAt,
      expiresAt,
      date: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
      qrData,
      qrUrl,
      upiId: autoUpiId,
      upiName: autoUpiName,
      confirmToken,
      gmailMatched: false,
      lastGmailCheckAt: 0,
      watcherTriggered: false,
      watcherSource: "none",
      watcherStatus: "skipped",
      watcherReason: "watcher_not_dispatched",
      lastCheckReason: "pending_initial",
      checkAttempts: 0,
    });

    let watcherSource = "none";
    let watcherStatus = "skipped";
    let watcherReason = "watcher_disabled";
    let watcherTriggered = false;
    if (WATCHER_ENABLED) {
      if (GITHUB_WATCHER_ENABLED) {
        if (!publicAutoConfirmUrl) {
          watcherSource = "github_actions";
          watcherStatus = "failed";
          watcherReason = "github_watcher_invalid_confirm_url";
          if (ALLOW_LOCAL_PY_FALLBACK) {
            const pyResult = triggerPythonWatcher({
              paymentId,
              username,
              amount: payableAmount,
              expiresAt,
              gmailImapUser,
              gmailImapAppPassword,
              autoConfirmUrl,
              confirmToken,
            });
            watcherSource = "python_local";
            watcherStatus = pyResult.ok ? "ok" : "failed";
            watcherReason = pyResult.reason || watcherReason;
            watcherTriggered = !!pyResult.ok;
          }
        } else {
          const ghResult = await triggerGitHubWatcher({
            paymentId,
            username,
            amount: payableAmount,
            expiresAt,
            gmailImapUser,
            gmailImapAppPassword,
            autoConfirmUrl: publicAutoConfirmUrl,
            confirmToken,
          });
          if (ghResult.ok) {
            watcherSource = "github_actions";
            watcherStatus = "ok";
            watcherReason = ghResult.reason;
            watcherTriggered = true;
          } else if (ALLOW_LOCAL_PY_FALLBACK) {
            const pyResult = triggerPythonWatcher({
              paymentId,
              username,
              amount: payableAmount,
              expiresAt,
              gmailImapUser,
              gmailImapAppPassword,
              autoConfirmUrl,
              confirmToken,
            });
            watcherSource = "python_local";
            watcherStatus = pyResult.ok ? "ok" : "failed";
            watcherReason = pyResult.reason || ghResult.reason || "fallback_python";
            watcherTriggered = !!pyResult.ok;
          } else {
            watcherSource = "github_actions";
            watcherStatus = "failed";
            watcherReason = ghResult.reason || "github_watcher_failed";
          }
        }
      } else {
        const pyResult = triggerPythonWatcher({
          paymentId,
          username,
          amount: payableAmount,
          expiresAt,
          gmailImapUser,
          gmailImapAppPassword,
          autoConfirmUrl,
          confirmToken,
        });
        watcherSource = "python_local";
        watcherStatus = pyResult.ok ? "ok" : "failed";
        watcherReason = pyResult.reason || "python_watcher_result_unknown";
        watcherTriggered = !!pyResult.ok;
      }
    }

    await db.collection("payments").doc(paymentId).update({
      watcherTriggered,
      watcherSource,
      watcherStatus,
      watcherReason,
      watcherDispatchAt: Date.now(),
    });

    await db.collection("auto_payment_logs").add({
      eventType: "watcher_dispatch",
      paymentId,
      username,
      amount: Number(payableAmount || 0),
      source: watcherSource,
      status: watcherStatus,
      reason: watcherReason,
      createdAt: Date.now(),
      date: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    });

    return send(200, {
      success: true,
      paymentId,
      baseAmount: Number(amount.toFixed(2)),
      payableAmount,
      expiresAt,
      expiresInSec: Math.floor(AUTO_EXPIRY_MS / 1000),
      upiId: autoUpiId,
      qrData,
      qrUrl,
      watcherSource,
      watcherStatus,
      watcherReason,
    });
  } catch (err) {
    console.error("auto-payment-create error:", err);
    return send(500, { error: err.message || "Internal error" });
  }
};
