// Vercel API route: /api/client-config
// Migrated from netlify/functions/client-config.js via a thin adapter.
const { createVercelHandler } = require("../lib/netlify-adapter");
const mod = require("../lib/functions/client-config");

module.exports = createVercelHandler(mod.handler);
