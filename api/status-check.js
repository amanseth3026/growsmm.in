// Vercel API route: /api/status-check
// Migrated from netlify/functions/status-check.js via a thin adapter.
const { createVercelHandler } = require("../lib/netlify-adapter");
const mod = require("../lib/functions/status-check");

module.exports = createVercelHandler(mod.handler);
