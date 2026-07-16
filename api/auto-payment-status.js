// Vercel API route: /api/auto-payment-status
// Migrated from netlify/functions/auto-payment-status.js via a thin adapter.
const { createVercelHandler } = require("../lib/netlify-adapter");
const mod = require("../lib/functions/auto-payment-status");

module.exports = createVercelHandler(mod.handler);
