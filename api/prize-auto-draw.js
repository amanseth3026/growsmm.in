// Vercel API route: /api/prize-auto-draw
// Migrated from netlify/functions/prize-auto-draw.js via a thin adapter.
const { createVercelHandler } = require("../lib/netlify-adapter");
const mod = require("../lib/functions/prize-auto-draw");

module.exports = createVercelHandler(mod.handler);
