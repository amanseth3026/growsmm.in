// Vercel API route: /api/auto-payment-cancel
// Migrated from netlify/functions/auto-payment-cancel.js via a thin adapter.
const { createVercelHandler } = require("../lib/netlify-adapter");
const mod = require("../lib/functions/auto-payment-cancel");

module.exports = createVercelHandler(mod.handler);
