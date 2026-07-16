// Vercel API route: /api/api
// Migrated from netlify/functions/api.js via a thin adapter.
const { createVercelHandler } = require("../lib/netlify-adapter");
const mod = require("../lib/functions/api");

module.exports = createVercelHandler(mod.handler);
