// Vercel API route: /api/auto-sync-services
// Migrated from netlify/functions/auto-sync-services.js via a thin adapter.
const { createVercelHandler } = require("../lib/netlify-adapter");
const mod = require("../lib/functions/auto-sync-services");

module.exports = createVercelHandler(mod.handler);
