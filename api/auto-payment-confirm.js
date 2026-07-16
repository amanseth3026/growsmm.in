// Vercel API route: /api/auto-payment-confirm
// Migrated from netlify/functions/auto-payment-confirm.js via a thin adapter.
const { createVercelHandler } = require("../lib/netlify-adapter");
const mod = require("../lib/functions/auto-payment-confirm");

module.exports = createVercelHandler(mod.handler);
