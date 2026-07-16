// Vercel API route: /api/manual-payment-verify
// Migrated from netlify/functions/manual-payment-verify.js via a thin adapter.
const { createVercelHandler } = require("../lib/netlify-adapter");
const mod = require("../lib/functions/manual-payment-verify");

module.exports = createVercelHandler(mod.handler);
