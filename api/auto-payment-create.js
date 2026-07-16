// Vercel API route: /api/auto-payment-create
// Migrated from netlify/functions/auto-payment-create.js via a thin adapter.
const { createVercelHandler } = require("../lib/netlify-adapter");
const mod = require("../lib/functions/auto-payment-create");

module.exports = createVercelHandler(mod.handler);
