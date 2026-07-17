// netlify/functions/service.js
// Legacy compatibility endpoint:
// keeps old route alive but always returns the new services-doc based list.
const fetch = require("node-fetch");

function corsResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return corsResponse(200, { ok: true });
  }

  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return corsResponse(405, { error: "Method Not Allowed" });
  }

  try {
    const baseUrl = process.env.SITE_URL || process.env.URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
    const res = await fetch(`${baseUrl}/api/public-services`, {
      method: "GET",
      headers: { "Accept": "application/json" }
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      return corsResponse(res.status, {
        error: payload?.error || "Failed to fetch services"
      });
    }

    const services = Array.isArray(payload?.services) ? payload.services : [];
    return corsResponse(200, {
      data: services,
      source: "public-services"
    });
  } catch (error) {
    console.error("service.js proxy error:", error);
    return corsResponse(500, {
      error: error.message || "Internal Error"
    });
  }
};
