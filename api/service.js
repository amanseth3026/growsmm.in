// Vercel API route: /api/service
// Migrated from netlify/functions/service.js via a thin adapter.
const { createVercelHandler } = require("../lib/netlify-adapter");
const mod = require("../lib/functions/service");

module.exports = createVercelHandler(mod.handler);
