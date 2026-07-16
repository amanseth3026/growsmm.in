// Vercel API route: /api/public-services
// Migrated from netlify/functions/public-services.js via a thin adapter.
const { createVercelHandler } = require("../lib/netlify-adapter");
const mod = require("../lib/functions/public-services");

module.exports = createVercelHandler(mod.handler);
