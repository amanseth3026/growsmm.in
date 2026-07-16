// Vercel API route: /api/order
// Migrated from netlify/functions/order.js via a thin adapter.
const { createVercelHandler } = require("../lib/netlify-adapter");
const mod = require("../lib/functions/order");

module.exports = createVercelHandler(mod.handler);
