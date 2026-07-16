// Vercel API route: /api/vendor
// Migrated from netlify/functions/vendor.js via a thin adapter.
const { createVercelHandler } = require("../lib/netlify-adapter");
const mod = require("../lib/functions/vendor");

module.exports = createVercelHandler(mod.handler);
