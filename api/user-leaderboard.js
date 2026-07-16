// Vercel API route: /api/user-leaderboard
// Migrated from netlify/functions/user-leaderboard.js via a thin adapter.
const { createVercelHandler } = require("../lib/netlify-adapter");
const mod = require("../lib/functions/user-leaderboard");

module.exports = createVercelHandler(mod.handler);
