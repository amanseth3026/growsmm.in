const admin = require("firebase-admin");

const CACHE_TTL_MS = 30 * 1000;
let cachedSettings = null;
let cachedAt = 0;

async function loadAutoPaymentSettings() {
  try {
    const now = Date.now();
    if (cachedSettings && now - cachedAt < CACHE_TTL_MS) {
      return cachedSettings;
    }

    const snap = await admin.firestore().collection("meta").doc("auto_payment_settings").get();
    const data = snap.exists ? snap.data() || {} : {};

    cachedSettings = data;
    cachedAt = now;
    return data;
  } catch (_) {
    return {};
  }
}

module.exports = { loadAutoPaymentSettings };
