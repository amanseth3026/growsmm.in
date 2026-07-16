import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  query,
  where,
  limit,
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { fetchUserSummaryFast, getActiveUsername } from "./firestore-fast.js";

const USERNAME = getActiveUsername();
const USERNAME_NORMALIZED = String(USERNAME || "").trim().toLowerCase();

const ORDER_COLLECTIONS = [
  "orders_active",
  "orders_completed",
  "orders_cancel",
  "orders_partial",
  "orders"
];

const panelSettings = (() => {
  try {
    return JSON.parse(localStorage.getItem("panelSettings") || "{}");
  } catch {
    return {};
  }
})();

const PANEL_NAME = String(panelSettings.panelName || "Panel").trim() || "Panel";
const ADMIN_WA = String(panelSettings.whatsappNumber || "").replace(/[^\d]/g, "");
const COMMUNITY_URL = String(panelSettings.whatsappCommunityUrl || "").trim();

const UI_CONFIG = {
  typingMinMs: 260,
  typingMaxMs: 820,
  maxHistoryMessages: 50,
  profileCacheMs: 60 * 1000,
  ordersCacheMs: 45 * 1000
};

const chatContainer = document.getElementById("chatContainer");
const msgInput = document.getElementById("msgInput");
const btnSend = document.getElementById("btnSend");
const typingIndicator = document.getElementById("typingIndicator");
const btnClear = document.getElementById("btnClear");

const HISTORY_STORAGE_KEY = `smm_help_chat_v5_${USERNAME_NORMALIZED || "guest"}`;

const session = {
  awaitingIntent: "",
  profile: { ts: 0, data: null },
  orders: { ts: 0, data: [] }
};
const ORDER_LOOKUP_CACHE_MS = 30 * 1000;
const orderLookupCache = new Map();

const INTENT_TERMS = {
  greeting: [
    "hi", "hello", "hey", "namaste", "salam", "hola", "bonjour", "ciao", "ola",
    "merhaba", "good morning", "good evening",
    "\u0928\u092e\u0938\u094d\u0924\u0947", "\u0939\u0947\u0932\u094b", "\u0938\u0932\u093e\u092e",
    "\u0645\u0631\u062d\u0628\u0627", "\u0440\u0438\u0432\u0435\u0442", "\u043f\u0440\u0438\u0432\u0435\u0442"
  ],
  thanks: [
    "thanks", "thank you", "thx", "shukriya", "dhanyavad", "gracias", "merci", "obrigado",
    "\u0936\u0941\u0915\u094d\u0930\u093f\u092f\u093e", "\u0927\u0928\u094d\u092f\u0935\u093e\u0926",
    "\u0634\u0643\u0631\u0627", "\u0441\u043f\u0430\u0441\u0438\u0431\u043e"
  ],
  balance: [
    "balance", "wallet", "fund", "funds", "money", "paisa", "wallet balance", "saldo",
    "solde", "bakiye", "cuenta", "amount", "cash", "rupee", "usd",
    "\u092c\u0948\u0932\u0947\u0902\u0938", "\u092a\u0948\u0938\u093e", "\u0930\u093e\u0936\u093f",
    "\u0631\u0635\u064a\u062f", "\u0627\u0644\u0631\u0635\u064a\u062f", "\u0431\u0430\u043b\u0430\u043d\u0441"
  ],
  add_funds: [
    "add funds", "deposit", "recharge", "top up", "add money", "fund add", "upi", "qr",
    "payment method", "how to pay", "pay",
    "funds add", "dinero", "recarregar", "recharge money",
    "\u092b\u0902\u0921 \u0910\u0921", "\u0930\u0940\u091a\u093e\u0930\u094d\u091c", "\u092a\u0947\u092e\u0947\u0902\u091f",
    "\u0627\u0636\u0627\u0641\u0629", "\u062f\u0641\u0639", "\u043f\u043e\u043f\u043e\u043b\u043d\u0438\u0442\u044c", "\u043e\u043f\u043b\u0430\u0442\u0430"
  ],
  order_status: [
    "order status", "status", "track", "tracking", "order check", "my order", "order id",
    "pedido", "statut", "status do pedido", "where is my order",
    "order", "processing", "pending", "in progress", "completed",
    "\u0911\u0930\u094d\u0921\u0930", "\u0938\u094d\u0925\u093f\u0924\u093f", "\u0938\u094d\u091f\u0947\u091f\u0938",
    "\u0637\u0644\u0628", "\u062d\u0627\u0644\u0629", "\u062d\u0627\u0644\u0629 \u0627\u0644\u0637\u0644\u0628",
    "\u0437\u0430\u043a\u0430\u0437", "\u0441\u0442\u0430\u0442\u0443\u0441"
  ],
  order_history: [
    "history", "order history", "all orders", "past orders", "my orders", "transactions",
    "historial", "historique", "historico", "orders list",
    "\u0911\u0930\u094d\u0921\u0930 \u0939\u093f\u0938\u094d\u091f\u094d\u0930\u0940",
    "\u0627\u0644\u0637\u0644\u0628\u0627\u062a", "\u0438\u0441\u0442\u043e\u0440\u0438\u044f"
  ],
  refill: [
    "refill", "drop", "dropped", "decrease", "non drop", "warranty", "guarantee",
    "followers drop", "likes drop", "r30", "r60", "r90", "r365",
    "refil", "re fill", "re-fill",
    "\u0930\u093f\u092b\u093f\u0932", "\u0921\u094d\u0930\u0949\u092a",
    "\u0631\u064a\u0641\u064a\u0644", "\u0636\u0645\u0627\u0646",
    "\u0440\u0435\u0444\u0438\u043b", "\u0433\u0430\u0440\u0430\u043d\u0442\u0438\u044f"
  ],
  payment_issue: [
    "payment issue", "payment failed", "money deducted", "deducted", "utr", "txn", "transaction",
    "not added", "pending payment", "payment pending", "failed payment", "chargeback",
    "\u092a\u0947\u092e\u0947\u0902\u091f \u092b\u0947\u0932", "\u092a\u0948\u0938\u0947 \u0915\u091f",
    "\u0627\u0644\u062f\u0641\u0639 \u0641\u0634\u0644", "\u0645\u0639\u0627\u0645\u0644\u0629",
    "\u043e\u043f\u043b\u0430\u0442\u0430 \u043d\u0435 \u043f\u0440\u043e\u0448\u043b\u0430"
  ],
  api: [
    "api", "api key", "token", "developer", "integration", "endpoint",
    "clave api", "api access", "key generate",
    "\u090f\u092a\u0940\u0906\u0908", "\u0915\u0940",
    "\u0645\u0641\u062a\u0627\u062d", "\u0628\u0631\u0645\u062c\u0629",
    "\u0430\u043f\u0438", "\u043a\u043b\u044e\u0447"
  ],
  login: [
    "login", "sign in", "signin", "register", "signup", "password", "otp", "account", "auth",
    "no login", "cant login", "cannot login",
    "\u0932\u0949\u0917\u093f\u0928", "\u0938\u093e\u0907\u0928", "\u092a\u093e\u0938\u0935\u0930\u094d\u0921",
    "\u062a\u0633\u062c\u064a\u0644", "\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631",
    "\u0432\u043e\u0439\u0442\u0438", "\u043f\u0430\u0440\u043e\u043b\u044c"
  ],
  services: [
    "service", "services", "price", "rate", "category", "best service", "cheap",
    "instagram", "youtube", "facebook", "telegram", "followers", "likes", "views",
    "which service", "how to order", "new order",
    "\u0938\u0930\u094d\u0935\u093f\u0938", "\u092a\u094d\u0930\u093e\u0907\u0938",
    "\u062e\u062f\u0645\u0629", "\u0633\u0639\u0631",
    "\u0441\u0435\u0440\u0432\u0438\u0441", "\u0446\u0435\u043d\u0430"
  ],
  cancel: [
    "cancel", "stop order", "cancel order", "refund", "money back", "terminate",
    "revert", "abort order",
    "\u0915\u0948\u0902\u0938\u0932", "\u0930\u0926\u094d\u0926", "\u0930\u093f\u092b\u0902\u0921",
    "\u0627\u0644\u063a\u0627\u0621", "\u0627\u0633\u062a\u0631\u062f\u0627\u062f",
    "\u043e\u0442\u043c\u0435\u043d\u0430", "\u0432\u043e\u0437\u0432\u0440\u0430\u0442"
  ],
  support: [
    "support", "admin", "human", "agent", "contact", "help", "whatsapp", "talk",
    "customer care", "owner", "team", "assist",
    "\u0938\u092a\u094b\u0930\u094d\u091f", "\u090f\u0921\u092e\u093f\u0928", "\u092e\u0926\u0926",
    "\u0645\u0633\u0627\u0639\u062f\u0629", "\u062f\u0639\u0645", "\u0627\u0644\u0645\u0633\u0624\u0648\u0644",
    "\u043f\u043e\u0434\u0434\u0435\u0440\u0436\u043a\u0430", "\u0430\u0434\u043c\u0438\u043d"
  ],
  community: [
    "community", "group", "join group", "whatsapp group", "telegram group",
    "community link", "join channel",
    "\u0917\u094d\u0930\u0941\u092a", "\u0915\u092e\u094d\u092f\u0941\u0928\u093f\u091f\u0940",
    "\u0645\u062c\u062a\u0645\u0639", "\u0645\u062c\u0645\u0648\u0639\u0629",
    "\u0441\u043e\u043e\u0431\u0449\u0435\u0441\u0442\u0432\u043e", "\u0433\u0440\u0443\u043f\u043f\u0430"
  ]
};

const ORDER_HINT_TERMS = [
  "order", "status", "track", "pedido", "statut", "tracking",
  "\u0911\u0930\u094d\u0921\u0930", "\u0637\u0644\u0628", "\u0437\u0430\u043a\u0430\u0437"
];

const REFILL_HINT_TERMS = [
  "refill", "drop", "warranty", "guarantee", "r30", "r60", "r90", "r365",
  "\u0930\u093f\u092b\u093f\u0932", "\u0631\u064a\u0641\u064a\u0644", "\u0440\u0435\u0444\u0438\u043b"
];

const BACK_TERMS = [
  "cancel", "back", "exit", "stop", "no", "nahi", "nahin", "nhi",
  "\u0928\u0939\u0940\u0902", "\u0627\u0644\u063a\u0627\u0621", "\u043e\u0442\u043c\u0435\u043d\u0430"
];

const STATUS_BADGE_CLASS = {
  pending: "bg-warning text-dark",
  processing: "bg-info text-dark",
  "in progress": "bg-primary",
  completed: "bg-success",
  partial: "bg-secondary",
  canceled: "bg-danger",
  cancelled: "bg-danger"
};

function normalizeText(input) {
  return String(input || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(input) {
  return String(input || "").replace(/[&<>"']/g, (char) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    }[char];
  });
}

function toMillis(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.seconds === "number") {
    const nanos = Number(value?.nanoseconds || 0);
    return (value.seconds * 1000) + Math.floor(nanos / 1e6);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMoney(value) {
  const amount = Number(value || 0);
  return `\u20B9${amount.toFixed(2)}`;
}

function formatDateTime(value) {
  const ts = toMillis(value);
  if (!ts) return "-";
  return new Date(ts).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata"
  });
}

function statusKey(status) {
  return String(status || "").trim().toLowerCase();
}

function statusBadge(status) {
  return STATUS_BADGE_CLASS[statusKey(status)] || "bg-dark";
}

function safeHttpUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.href;
    }
    return "";
  } catch {
    return "";
  }
}

function toJsSingleQuotedString(input) {
  return String(input || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
}

function containsAnyTerm(normalizedText, terms) {
  return terms.some((term) => normalizedText.includes(term));
}

function extractOrderId(text) {
  const value = String(text || "");

  const manual = value.match(/manual[_\-\s]?(\d{2,})/i);
  if (manual) return `manual_${manual[1]}`;

  const direct = value.match(/\b\d{3,}\b/);
  if (!direct) return "";

  return String(direct[0]).trim();
}

function isBackMessage(text) {
  const normalized = normalizeText(text);
  return containsAnyTerm(normalized, BACK_TERMS);
}

function detectIntentMeta(text) {
  const normalized = normalizeText(text);
  let bestIntent = "";
  let bestScore = 0;

  Object.entries(INTENT_TERMS).forEach(([intent, terms]) => {
    let score = 0;
    terms.forEach((term) => {
      if (normalized.includes(term)) {
        score += term.includes(" ") ? 2 : 1;
      }
    });
    if (score > bestScore) {
      bestScore = score;
      bestIntent = intent;
    }
  });

  return {
    intent: bestScore > 0 ? bestIntent : "",
    score: bestScore,
    normalized
  };
}

function resolveOrderActionIntent(orderId, normalized, fallbackIntent = "order_status") {
  if (!orderId) return "";

  const asksRefill = containsAnyTerm(normalized, REFILL_HINT_TERMS);
  const asksOrder = containsAnyTerm(normalized, ORDER_HINT_TERMS);

  if (asksRefill && !asksOrder) return "refill";
  if (asksOrder && !asksRefill) return "order_status";
  if (asksRefill && asksOrder) {
    if (normalized.includes("refill") || normalized.includes("warranty") || normalized.includes("drop")) {
      return "refill";
    }
    return "order_status";
  }

  return fallbackIntent;
}

function adminWhatsAppLink(prefill = "") {
  if (!ADMIN_WA) return "";
  const base = `https://wa.me/${ADMIN_WA}`;
  if (!prefill) return base;
  return `${base}?text=${encodeURIComponent(prefill)}`;
}

function renderQuickChips(chips = []) {
  if (!Array.isArray(chips) || !chips.length) return "";
  const html = chips.map((chip) => {
    const label = escapeHtml(chip.label || chip.command || "");
    const command = toJsSingleQuotedString(chip.command || "");
    return `<span class="chip" onclick="sendChip('${command}')">${label}</span>`;
  }).join("");
  return `<div class="chip-container">${html}</div>`;
}

async function getUserProfile(forceRefresh = false) {
  if (!USERNAME_NORMALIZED) return null;
  const now = Date.now();

  if (
    !forceRefresh &&
    session.profile.data &&
    now - session.profile.ts < UI_CONFIG.profileCacheMs
  ) {
    return session.profile.data;
  }

  const fastSummary = await fetchUserSummaryFast(USERNAME, {
    forceRefresh,
    cacheMaxAgeMs: UI_CONFIG.profileCacheMs
  });
  if (fastSummary) {
    session.profile = { ts: now, data: fastSummary };
    return fastSummary;
  }

  const snap = await getDocs(
    query(collection(db, "users"), where("username", "==", USERNAME), limit(1))
  );
  if (snap.empty) {
    session.profile = { ts: now, data: null };
    return null;
  }

  const row = snap.docs[0];
  const data = { id: row.id, ...row.data() };
  session.profile = { ts: now, data };
  return data;
}

async function getUserOrders(forceRefresh = false) {
  if (!USERNAME_NORMALIZED) return [];
  const now = Date.now();

  if (
    !forceRefresh &&
    Array.isArray(session.orders.data) &&
    now - session.orders.ts < UI_CONFIG.ordersCacheMs
  ) {
    return session.orders.data;
  }

  const snaps = await Promise.all(
    ORDER_COLLECTIONS.map((collectionName) =>
      getDocs(query(collection(db, collectionName), where("payer", "==", USERNAME)))
    )
  );

  const rows = [];
  snaps.forEach((snap, index) => {
    const sourceCollection = ORDER_COLLECTIONS[index];
    snap.forEach((docSnap) => {
      rows.push({
        docId: docSnap.id,
        sourceCollection,
        ...docSnap.data()
      });
    });
  });

  const deduped = new Map();
  rows.forEach((order) => {
    const key = String(order.docId || "");
    if (!key) return;
    if (!deduped.has(key)) {
      deduped.set(key, order);
      return;
    }
    const existing = deduped.get(key);
    const existingTs = Math.max(toMillis(existing.updatedAt), toMillis(existing.createdAt));
    const incomingTs = Math.max(toMillis(order.updatedAt), toMillis(order.createdAt));
    if (incomingTs >= existingTs) {
      deduped.set(key, order);
    }
  });

  const output = Array.from(deduped.values()).sort((a, b) => {
    return Math.max(toMillis(b.createdAt), toMillis(b.updatedAt)) -
      Math.max(toMillis(a.createdAt), toMillis(a.updatedAt));
  });

  session.orders = { ts: now, data: output };
  return output;
}

async function findOrderById(orderIdInput) {
  const parsed = extractOrderId(orderIdInput);
  if (!parsed) return null;

  const cachedOrder = orderLookupCache.get(parsed);
  if (cachedOrder && Date.now() - Number(cachedOrder.ts || 0) < ORDER_LOOKUP_CACHE_MS) {
    return cachedOrder.data;
  }

  const directDocIds = [];
  if (parsed.startsWith("manual_")) {
    directDocIds.push(parsed);
    directDocIds.push(parsed.replace(/^manual_/, ""));
  } else {
    directDocIds.push(parsed);
    if (/^\d+$/.test(parsed)) {
      directDocIds.push(`manual_${parsed}`);
    }
  }

  const directFetchTasks = [];
  for (const collectionName of ORDER_COLLECTIONS) {
    for (const docId of directDocIds) {
      directFetchTasks.push(
        getDoc(doc(db, collectionName, docId))
          .then((docSnap) => ({ collectionName, docSnap }))
          .catch(() => null)
      );
    }
  }
  const directFetchRows = await Promise.all(directFetchTasks);
  for (const row of directFetchRows) {
    if (!row?.docSnap?.exists()) continue;
    const data = row.docSnap.data() || {};
    if (String(data.payer || "").trim().toLowerCase() !== USERNAME_NORMALIZED) continue;
    const result = { docId: row.docSnap.id, sourceCollection: row.collectionName, ...data };
    orderLookupCache.set(parsed, { ts: Date.now(), data: result });
    return result;
  }

  const fieldVariants = [];
  const clean = parsed.replace(/^manual_/, "");
  if (/^\d+$/.test(clean)) fieldVariants.push(Number(clean));
  fieldVariants.push(clean);
  fieldVariants.push(parsed);

  const queryTasks = [];
  for (const collectionName of ORDER_COLLECTIONS) {
    for (const variant of fieldVariants) {
      queryTasks.push(
        getDocs(query(collection(db, collectionName), where("orderId", "==", variant), limit(1)))
          .then((snap) => ({ collectionName, snap }))
          .catch(() => null)
      );
    }
  }
  const queryRows = await Promise.all(queryTasks);
  for (const row of queryRows) {
    if (!row || row.snap.empty) continue;
    const docRow = row.snap.docs[0];
    const data = docRow.data() || {};
    if (String(data.payer || "").trim().toLowerCase() !== USERNAME_NORMALIZED) continue;
    const result = { docId: docRow.id, sourceCollection: row.collectionName, ...data };
    orderLookupCache.set(parsed, { ts: Date.now(), data: result });
    return result;
  }

  return null;
}

function evaluateRefill(order) {
  const status = statusKey(order?.status);
  if (status !== "completed") {
    return {
      eligible: false,
      reason: "Order is not completed yet. Refill check starts after completion.",
      plan: "Not started",
      usedDays: 0,
      totalDays: 0
    };
  }

  const serviceText = normalizeText(order?.serviceTitle || order?.serviceName || order?.name || "");

  if (serviceText.includes("no refill") || serviceText.includes("norefill")) {
    return {
      eligible: false,
      reason: "Service is marked as No Refill.",
      plan: "No Refill",
      usedDays: 0,
      totalDays: 0
    };
  }

  let totalDays = 30;
  let plan = "Standard 30 Days";

  if (
    serviceText.includes("lifetime") ||
    serviceText.includes("non drop") ||
    serviceText.includes("non-drop")
  ) {
    totalDays = Number.POSITIVE_INFINITY;
    plan = "Lifetime / Non-Drop";
  } else {
    const rMatch = serviceText.match(/\br\s?(\d{2,3})\b/);
    const dMatch = serviceText.match(/\b(\d{2,3})\s*(day|days|d)\b/);
    const parsedDays = Number((rMatch?.[1] || dMatch?.[1] || "").trim());
    if (Number.isFinite(parsedDays) && parsedDays > 0) {
      totalDays = parsedDays;
      plan = `${parsedDays} Days`;
    }
  }

  const createdMs =
    toMillis(order?.createdAt) ||
    toMillis(order?.orderPlacedAt) ||
    toMillis(order?.processingStartedAt) ||
    Date.now();

  const usedDays = Math.max(0, Math.ceil((Date.now() - createdMs) / (24 * 60 * 60 * 1000)));

  if (!Number.isFinite(totalDays)) {
    return {
      eligible: true,
      reason: "Lifetime warranty is active.",
      plan,
      usedDays,
      totalDays
    };
  }

  const remaining = Math.max(0, totalDays - usedDays);
  if (usedDays <= totalDays) {
    return {
      eligible: true,
      reason: `Within warranty window. Remaining approx ${remaining} day(s).`,
      plan,
      usedDays,
      totalDays
    };
  }

  return {
    eligible: false,
    reason: `Warranty expired. Used ${usedDays} day(s) out of ${totalDays}.`,
    plan,
    usedDays,
    totalDays
  };
}

function renderOrderCard(order, extraHtml = "") {
  const orderId = escapeHtml(String(order?.orderId || order?.docId || "-"));
  const serviceName = escapeHtml(String(order?.serviceTitle || order?.serviceName || order?.name || "Unknown"));
  const status = String(order?.status || "pending");
  const statusText = escapeHtml(status.toUpperCase());
  const statusClass = statusBadge(status);
  const amount = formatMoney(order?.amount || 0);
  const qty = escapeHtml(String(order?.qty ?? order?.quantity ?? "-"));
  const remains = escapeHtml(String(order?.remains ?? "-"));
  const startCount = escapeHtml(String(order?.startCount ?? order?.start_count ?? "-"));
  const created = formatDateTime(order?.createdAt || order?.orderPlacedAt);
  const safeLink = safeHttpUrl(order?.link);
  const linkHtml = safeLink
    ? `<a href="${escapeHtml(safeLink)}" target="_blank" rel="noopener">Open Link</a>`
    : "-";

  const refillCmd = toJsSingleQuotedString(`Refill ${orderId}`);
  const statusCmd = toJsSingleQuotedString(`Status ${orderId}`);

  return `
    <div class="card border-0 shadow-sm mt-2" style="background:#f8f9fa; font-size:0.9rem;">
      <div class="card-header bg-white fw-bold d-flex justify-content-between align-items-center">
        <span>Order #${orderId}</span>
        <span class="badge ${statusClass}">${statusText}</span>
      </div>
      <div class="card-body p-2">
        <p class="mb-1"><b>Service:</b> ${serviceName}</p>
        <p class="mb-1"><b>Link:</b> ${linkHtml}</p>
        <div class="d-flex justify-content-between mt-2 mb-2 bg-white p-2 rounded border">
          <div class="text-center">
            <small class="text-muted d-block">Start</small>
            <strong>${startCount}</strong>
          </div>
          <div class="text-center border-start border-end px-3">
            <small class="text-muted d-block">Qty</small>
            <strong>${qty}</strong>
          </div>
          <div class="text-center">
            <small class="text-muted d-block">Remains</small>
            <strong>${remains}</strong>
          </div>
        </div>
        <p class="mb-1"><b>Charge:</b> ${amount}</p>
        <p class="mb-2"><b>Created:</b> ${escapeHtml(created)}</p>
        ${extraHtml}
        <div class="chip-container mt-2">
          <span class="chip" onclick="sendChip('${statusCmd}')">Refresh Status</span>
          <span class="chip" onclick="sendChip('${refillCmd}')">Check Refill</span>
        </div>
      </div>
    </div>
  `;
}

function renderGreetingMessage() {
  return `
    <b>Hi ${escapeHtml(USERNAME || "there")}!</b><br>
    I can help with panel queries in multiple languages: balance, order status, refill, payments, API, and support.<br><br>
    ${renderQuickChips([
      { label: "Wallet Balance", command: "My Balance" },
      { label: "Order Status", command: "Order Status" },
      { label: "Refill Check", command: "Refill" },
      { label: "Add Funds", command: "Add Funds" }
    ])}
  `;
}

function renderFallbackMessage() {
  return `
    I can solve panel-related questions. Try one of these:<br><br>
    ${renderQuickChips([
      { label: "My Balance", command: "My Balance" },
      { label: "Order Status", command: "Order Status" },
      { label: "Refill", command: "Refill" },
      { label: "Payment Issue", command: "Payment Issue" }
    ])}
  `;
}

async function handleBalanceIntent() {
  const profile = await getUserProfile();
  if (!profile) {
    return "I could not find your profile right now. Please refresh and try again.";
  }

  const balance = Number(profile.balance || 0);
  const extra = balance < 50
    ? "Balance is low. Please add funds before placing new orders."
    : "Balance is available for new orders.";

  return `
    <b>Wallet Balance</b><br>
    <h2 class="text-success m-0">${formatMoney(balance)}</h2>
    <small class="text-muted">${escapeHtml(extra)}</small><br><br>
    ${renderQuickChips([
      { label: "Add Funds", command: "Add Funds" },
      { label: "Payment Issue", command: "Payment Issue" }
    ])}
  `;
}

async function handleOrderHistoryIntent() {
  const orders = await getUserOrders();
  if (!orders.length) {
    return "No orders found in your account yet.";
  }

  const counts = {
    total: orders.length,
    pending: 0,
    processing: 0,
    completed: 0,
    partial: 0,
    canceled: 0
  };

  orders.forEach((order) => {
    const key = statusKey(order.status);
    if (key === "pending") counts.pending += 1;
    else if (key === "processing" || key === "in progress") counts.processing += 1;
    else if (key === "completed") counts.completed += 1;
    else if (key === "partial") counts.partial += 1;
    else if (key === "canceled" || key === "cancelled") counts.canceled += 1;
  });

  const latest = orders[0];
  return `
    <b>Order Summary (${counts.total})</b><br>
    Pending: <b>${counts.pending}</b><br>
    Processing: <b>${counts.processing}</b><br>
    Completed: <b>${counts.completed}</b><br>
    Partial: <b>${counts.partial}</b><br>
    Canceled: <b>${counts.canceled}</b><br><br>
    Latest order:<br>
    ${renderOrderCard(latest)}
  `;
}

async function handleOrderStatusIntent(orderIdInput = "") {
  const orderId = extractOrderId(orderIdInput);
  if (!orderId) {
    const orders = await getUserOrders();
    if (!orders.length) {
      return "No orders found. Send an Order ID (example: 12345) to check status.";
    }
    return `
      You did not send an Order ID, so I checked your latest order.<br>
      ${renderOrderCard(orders[0])}
    `;
  }

  const order = await findOrderById(orderId);
  if (!order) {
    return `Order ID <b>${escapeHtml(orderId)}</b> not found in your account. Please check ID and try again.`;
  }

  return renderOrderCard(order);
}

async function handleRefillIntent(orderIdInput = "") {
  const orderId = extractOrderId(orderIdInput);
  if (!orderId) {
    session.awaitingIntent = "refill";
    return "Please send your Order ID for refill check (example: 12345).";
  }

  const order = await findOrderById(orderId);
  if (!order) {
    return `Order ID <b>${escapeHtml(orderId)}</b> not found in your account.`;
  }

  const result = evaluateRefill(order);
  const icon = result.eligible ? "bi-check-circle-fill text-success" : "bi-x-circle-fill text-danger";
  const alertClass = result.eligible ? "alert-success" : "alert-danger";
  const refillMsg = [
    `Refill Request`,
    `User: ${USERNAME}`,
    `Order ID: ${order.orderId || order.docId || orderId}`,
    `Service: ${order.serviceTitle || order.serviceName || order.name || "-"}`,
    `Plan: ${result.plan}`,
    `Result: ${result.eligible ? "Eligible" : "Not Eligible"}`,
    `Reason: ${result.reason}`
  ].join("\n");
  const waLink = adminWhatsAppLink(refillMsg);
  const safeWaLink = safeHttpUrl(waLink);
  const supportBtn = safeWaLink
    ? `<a href="${escapeHtml(safeWaLink)}" target="_blank" rel="noopener" class="chat-action-btn"><i class="bi bi-whatsapp"></i> Request Refill</a>`
    : `<div class="small text-muted">Admin WhatsApp is not configured.</div>`;

  const extraHtml = `
    <div class="alert ${alertClass} p-2 mb-2">
      <i class="bi ${icon}"></i>
      <b>${result.eligible ? "Eligible" : "Not Eligible"}:</b> ${escapeHtml(result.reason)}
    </div>
    <div class="small mb-2">
      <b>Plan:</b> ${escapeHtml(result.plan)}<br>
      <b>Used Days:</b> ${escapeHtml(String(result.usedDays))}
      ${Number.isFinite(result.totalDays) ? `<br><b>Total Days:</b> ${escapeHtml(String(result.totalDays))}` : ""}
    </div>
    ${supportBtn}
  `;

  return renderOrderCard(order, extraHtml);
}

function handleAddFundsIntent() {
  const waLink = adminWhatsAppLink("Hi, I need help with add funds.");
  const safeWaLink = safeHttpUrl(waLink);
  return `
    <b>Add Funds Help</b><br>
    1. Open Add Funds page and enter amount.<br>
    2. Complete UPI/QR payment.<br>
    3. If payment is deducted but not credited, share UTR and screenshot.<br><br>
    <a href="addfunds.html" class="chat-action-btn">Open Add Funds</a>
    ${safeWaLink ? `<a href="${escapeHtml(safeWaLink)}" target="_blank" rel="noopener" class="chat-action-btn"><i class="bi bi-whatsapp"></i> Contact Admin</a>` : ""}
  `;
}

function handlePaymentIssueIntent() {
  const waLink = adminWhatsAppLink("Payment deducted but not credited. Please check.");
  const safeWaLink = safeHttpUrl(waLink);
  return `
    <b>Payment Issue Guide</b><br>
    Share these details for fast resolution:<br>
    1. UTR / Transaction ID<br>
    2. Paid amount<br>
    3. Payment screenshot<br><br>
    ${safeWaLink ? `<a href="${escapeHtml(safeWaLink)}" target="_blank" rel="noopener" class="chat-action-btn"><i class="bi bi-whatsapp"></i> Send Details to Admin</a>` : "Admin WhatsApp is not configured."}
  `;
}

function handleApiIntent() {
  return `
    <b>API Help</b><br>
    API URL and API Key are available in your account/API section.<br>
    If key is not working, regenerate API key from account settings and test again.
  `;
}

function handleLoginIntent() {
  const waLink = adminWhatsAppLink("I need login/account help.");
  const safeWaLink = safeHttpUrl(waLink);
  return `
    <b>Login / Account Help</b><br>
    1. Check username/email and password.<br>
    2. Clear browser cache and retry.<br>
    3. If still failing, contact admin with screenshot.<br><br>
    ${safeWaLink ? `<a href="${escapeHtml(safeWaLink)}" target="_blank" rel="noopener" class="chat-action-btn"><i class="bi bi-whatsapp"></i> Contact Admin</a>` : ""}
  `;
}

function handleServicesIntent() {
  return `
    <b>Service Selection Tips</b><br>
    1. Use search in New Order page for platform + service type.<br>
    2. Check description, min/max, and refill terms before placing order.<br>
    3. Compare speed + refill policy, not only price.<br><br>
    <a href="neworder.html" class="chat-action-btn">Open New Order</a>
  `;
}

function handleCancelIntent() {
  const waLink = adminWhatsAppLink("Please check if my order can be canceled/refunded.");
  const safeWaLink = safeHttpUrl(waLink);
  return `
    <b>Cancel / Refund</b><br>
    Orders already in processing usually cannot be canceled from provider side.<br>
    If still pending, cancellation may be possible.<br><br>
    Send your Order ID for exact check.<br>
    ${safeWaLink ? `<a href="${escapeHtml(safeWaLink)}" target="_blank" rel="noopener" class="chat-action-btn"><i class="bi bi-whatsapp"></i> Ask Admin</a>` : ""}
  `;
}

function handleSupportIntent() {
  const waLink = adminWhatsAppLink("Hi, I need support.");
  const safeWaLink = safeHttpUrl(waLink);
  if (!safeWaLink) {
    return "Admin contact is not configured yet. Please check panel settings.";
  }
  return `
    <b>Human Support</b><br>
    <a href="${escapeHtml(safeWaLink)}" target="_blank" rel="noopener" class="chat-action-btn"><i class="bi bi-whatsapp"></i> Chat on WhatsApp</a>
  `;
}

function handleCommunityIntent() {
  const safeCommunityUrl = safeHttpUrl(COMMUNITY_URL);
  if (!safeCommunityUrl) {
    return "Community link is not configured yet.";
  }
  return `
    <b>Join Community</b><br>
    <a href="${escapeHtml(safeCommunityUrl)}" target="_blank" rel="noopener" class="chat-action-btn">Open Community Link</a>
  `;
}

async function routeByIntent(intent, raw, normalized, orderId) {
  if (orderId && containsAnyTerm(normalized, REFILL_HINT_TERMS)) {
    return await handleRefillIntent(orderId);
  }

  if (orderId && containsAnyTerm(normalized, ORDER_HINT_TERMS)) {
    return await handleOrderStatusIntent(orderId);
  }

  if (orderId && !containsAnyTerm(normalized, INTENT_TERMS.balance)) {
    return await handleOrderStatusIntent(orderId);
  }

  switch (intent) {
    case "greeting":
      return renderGreetingMessage();
    case "thanks":
      return "You are welcome. Ask anything about your panel anytime.";
    case "balance":
      return await handleBalanceIntent();
    case "add_funds":
      return handleAddFundsIntent();
    case "order_status":
      session.awaitingIntent = "order_status";
      return "Please send Order ID to check status (example: 12345).";
    case "order_history":
      return await handleOrderHistoryIntent();
    case "refill":
      session.awaitingIntent = "refill";
      return "Please send Order ID for refill eligibility check.";
    case "payment_issue":
      return handlePaymentIssueIntent();
    case "api":
      return handleApiIntent();
    case "login":
      return handleLoginIntent();
    case "services":
      return handleServicesIntent();
    case "cancel":
      return handleCancelIntent();
    case "support":
      return handleSupportIntent();
    case "community":
      return handleCommunityIntent();
    default:
      if (containsAnyTerm(normalized, ORDER_HINT_TERMS)) {
        session.awaitingIntent = "order_status";
        return "Please send your Order ID and I will fetch live status.";
      }
      return renderFallbackMessage();
  }
}

async function processUserMessage(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";

  if (!USERNAME_NORMALIZED) {
    return "Please login first, then I can fetch your panel data and answer accurately.";
  }

  const normalized = normalizeText(raw);
  const orderId = extractOrderId(raw);
  const intentMeta = detectIntentMeta(raw);
  const activeIntent = intentMeta.intent;

  if (session.awaitingIntent === "order_status") {
    if (isBackMessage(raw)) {
      session.awaitingIntent = "";
      return "Okay, canceled. Ask anything else related to your panel.";
    }

    if (orderId) {
      const chosenIntent = resolveOrderActionIntent(orderId, normalized, "order_status");
      session.awaitingIntent = "";
      if (chosenIntent === "refill") return await handleRefillIntent(orderId);
      return await handleOrderStatusIntent(orderId);
    }

    if (activeIntent && activeIntent !== "order_status") {
      session.awaitingIntent = "";
      return await routeByIntent(activeIntent, raw, normalized, orderId);
    }

    if (!orderId) {
      return "Please send a valid Order ID (example: 12345).";
    }
  }

  if (session.awaitingIntent === "refill") {
    if (isBackMessage(raw)) {
      session.awaitingIntent = "";
      return "Refill flow canceled.";
    }

    if (orderId) {
      const chosenIntent = resolveOrderActionIntent(orderId, normalized, "refill");
      session.awaitingIntent = "";
      if (chosenIntent === "order_status") return await handleOrderStatusIntent(orderId);
      return await handleRefillIntent(orderId);
    }

    if (activeIntent && activeIntent !== "refill") {
      session.awaitingIntent = "";
      return await routeByIntent(activeIntent, raw, normalized, orderId);
    }

    if (!orderId) {
      return "Please send a valid Order ID for refill check (example: 12345).";
    }
  }

  return await routeByIntent(activeIntent, raw, normalized, orderId);
}

function getTimeLabel() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function scrollToBottom() {
  if (!chatContainer) return;
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function showTyping() {
  if (!typingIndicator) return;
  typingIndicator.style.display = "block";
  scrollToBottom();
}

function hideTyping() {
  if (!typingIndicator) return;
  typingIndicator.style.display = "none";
}

function addUserMessage(text) {
  if (!chatContainer || !typingIndicator) return;
  const div = document.createElement("div");
  div.className = "message msg-user";
  div.innerHTML = `${escapeHtml(text)}<div class="msg-meta"><i class="bi bi-check2-all"></i> ${getTimeLabel()}</div>`;
  chatContainer.insertBefore(div, typingIndicator);
  scrollToBottom();
  saveChatHistory();
}

function addBotMessage(html) {
  if (!chatContainer || !typingIndicator) return;
  const div = document.createElement("div");
  div.className = "message msg-ai";
  div.innerHTML = `${html}<div class="msg-meta">${getTimeLabel()}</div>`;
  chatContainer.insertBefore(div, typingIndicator);
  scrollToBottom();
  saveChatHistory();
}

function computeTypingDelay(text) {
  const base = UI_CONFIG.typingMinMs;
  const extra = Math.min(420, Math.max(0, String(text || "").length * 7));
  const jitter = Math.floor(Math.random() * 90);
  return Math.min(UI_CONFIG.typingMaxMs, base + extra + jitter);
}

async function handleSend() {
  const text = String(msgInput?.value || "").trim();
  if (!text) return;

  addUserMessage(text);
  if (msgInput) msgInput.value = "";
  showTyping();

  try {
    const reply = await processUserMessage(text);
    const delay = computeTypingDelay(reply);
    setTimeout(() => {
      hideTyping();
      addBotMessage(reply || "Done.");
    }, delay);
  } catch (err) {
    console.error("help bot error:", err);
    hideTyping();
    addBotMessage("Something went wrong while checking data. Please try again.");
  }
}

function buildWelcomeCard() {
  return `
    <div class="welcome-card text-center p-4">
      <div class="mb-3">
        <span class="bg-white p-3 rounded-circle shadow-sm">
          <i class="bi bi-robot text-primary display-6"></i>
        </span>
      </div>
      <h5 class="fw-bold mb-1">Hello, ${escapeHtml(USERNAME || "Guest")}!</h5>
      <p class="text-muted small">${escapeHtml(PANEL_NAME)} AI Support Online</p>
      <p class="small mb-3">Ask in your language about balance, orders, refill, payments, API, or support.</p>
      <div class="d-flex justify-content-center gap-2 mt-2 flex-wrap">
        <span class="badge bg-light text-dark border pointer" onclick="sendChip('My Balance')">Balance</span>
        <span class="badge bg-light text-dark border pointer" onclick="sendChip('Order Status')">Order Status</span>
        <span class="badge bg-light text-dark border pointer" onclick="sendChip('Refill')">Refill</span>
        <span class="badge bg-light text-dark border pointer" onclick="sendChip('Add Funds')">Add Funds</span>
      </div>
    </div>
  `;
}

function saveChatHistory() {
  if (!chatContainer) return;
  const nodes = Array.from(chatContainer.querySelectorAll(".message, .welcome-card, .chat-session-sep"));
  const trimmed = nodes.slice(-UI_CONFIG.maxHistoryMessages);
  const html = trimmed.map((node) => node.outerHTML).join("");
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, html);
  } catch (err) {
    console.warn("Failed to save chat history:", err);
  }
}

function loadChatHistory() {
  if (!chatContainer || !typingIndicator) return;
  const saved = localStorage.getItem(HISTORY_STORAGE_KEY);

  if (saved) {
    const holder = document.createElement("div");
    holder.innerHTML = saved;
    while (holder.firstChild) {
      chatContainer.insertBefore(holder.firstChild, typingIndicator);
    }
    const sep = document.createElement("div");
    sep.className = "chat-session-sep text-center small text-muted my-2";
    sep.textContent = "- New Session -";
    chatContainer.insertBefore(sep, typingIndicator);
  } else {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = buildWelcomeCard();
    while (wrapper.firstChild) {
      chatContainer.insertBefore(wrapper.firstChild, typingIndicator);
    }
  }

  scrollToBottom();
}

function clearChatHistory() {
  try {
    localStorage.removeItem(HISTORY_STORAGE_KEY);
  } catch {
    // no-op
  }

  if (!chatContainer || !typingIndicator) return;
  Array.from(chatContainer.children).forEach((child) => {
    if (child !== typingIndicator) child.remove();
  });
  const wrapper = document.createElement("div");
  wrapper.innerHTML = buildWelcomeCard();
  while (wrapper.firstChild) {
    chatContainer.insertBefore(wrapper.firstChild, typingIndicator);
  }
  saveChatHistory();
}

window.sendChip = function sendChip(text) {
  if (!msgInput) return;
  msgInput.value = String(text || "").trim();
  handleSend();
};

if (btnSend) {
  btnSend.addEventListener("click", handleSend);
}

if (msgInput) {
  msgInput.addEventListener("keypress", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleSend();
    }
  });
}

if (btnClear) {
  btnClear.addEventListener("click", () => {
    if (confirm("Clear chat history?")) {
      clearChatHistory();
    }
  });
}

loadChatHistory();

if (!USERNAME_NORMALIZED) {
  addBotMessage("Login session not found. Please login to get account-specific answers.");
}
