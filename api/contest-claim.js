// Vercel API route: /api/contest-claim
// Migrated from netlify/functions/contest-claim.js via a thin adapter.
const { createVercelHandler } = require("../lib/netlify-adapter");
const mod = require("../lib/functions/contest-claim");

module.exports = createVercelHandler(mod.handler);
