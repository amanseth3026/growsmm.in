// Vercel API route: /api/migrate-services-to-docs
// Migrated from netlify/functions/migrate-services-to-docs.js via a thin adapter.
const { createVercelHandler } = require("../lib/netlify-adapter");
const mod = require("../lib/functions/migrate-services-to-docs");

module.exports = createVercelHandler(mod.handler);
