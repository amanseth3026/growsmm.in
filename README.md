# GrowSMM — Vercel

Migrated from Netlify. This project deploys as a static site + Node.js
serverless functions on Vercel.

## Layout

```
/                         Static assets served at the root (index.html, styles/, scripts/, ...)
api/                      Vercel serverless functions (was netlify/functions/*)
lib/functions/            Original Netlify function code, unmodified
lib/netlify-adapter.js    Bridges Netlify (event) → Vercel (req, res)
vercel.json               Rewrites, redirects, cron, headers (was netlify.toml + _redirects)
.env.example              All required environment variables
```

Every `api/<name>.js` is a thin adapter that requires the original handler
from `lib/functions/<name>.js` and invokes it with a synthesized Netlify
`event` object, then forwards `{ statusCode, headers, body }` back to
Vercel's `res`. Business logic is unchanged.

## URL mapping

| Old Netlify URL                          | New Vercel URL   |
| ---------------------------------------- | ---------------- |
| `/.netlify/functions/order`              | `/api/order`     |
| `/.netlify/functions/public-services`    | `/api/public-services` |
| `/.netlify/functions/auto-payment-*`     | `/api/auto-payment-*` |
| ...all others                            | `/api/<same-name>` |

All frontend fetch calls have already been updated.

## Deploy

1. Copy `.env.example` → set every variable in Vercel → Project → Settings
   → Environment Variables.
2. Push to GitHub, import into Vercel.
3. Framework preset: **Other**. Build command: leave default (none). Output
   directory: leave default (repo root serves static files).
4. First deploy runs `npm install` and provisions `api/*` as serverless
   functions automatically.

## Cron

`auto-sync-services` runs on the schedule declared in `vercel.json`
(requires Vercel plan that includes cron; free plan is limited to
daily crons — adjust the schedule if your plan requires it).

The `contest-auto-finalize` cron from `netlify.toml` had no matching
handler file in the upload, so it was not carried over.

## Local dev

```
npm install
npx vercel dev
```
