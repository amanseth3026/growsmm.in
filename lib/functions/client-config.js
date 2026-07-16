// netlify/functions/client-config.js

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return corsResponse(200, {});
    }

    if (event.httpMethod !== "GET") {
      return corsResponse(405, { error: "Method Not Allowed" });
    }

    const envAuthDomain = String(process.env.FIREBASE_AUTH_DOMAIN || "").trim();
    const reqHost = normalizeHost(
      event?.headers?.["x-forwarded-host"] ||
      event?.headers?.host ||
      ""
    );
    const isLocalHost = /^localhost(?::\d+)?$|^127\.0\.0\.1(?::\d+)?$/i.test(reqHost);
    const useSameSiteAuth =
      String(process.env.FIREBASE_AUTH_USE_SAME_SITE || "").trim() === "1" ||
      isLocalHost;

    const resolvedAuthDomain = useSameSiteAuth && reqHost ? reqHost : envAuthDomain;

    const config = {
      apiKey: process.env.FIREBASE_API_KEY || "",
      authDomain: resolvedAuthDomain,
      databaseURL: process.env.FIREBASE_DATABASE_URL || "",
      projectId: process.env.FIREBASE_PROJECT_ID || "",
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "",
      appId: process.env.FIREBASE_APP_ID || "",
      measurementId: process.env.FIREBASE_MEASUREMENT_ID || "",
    };

    if (!config.apiKey || !config.authDomain || !config.projectId) {
      return corsResponse(500, { error: "Missing Firebase client config" });
    }

    return corsResponse(200, config);
  } catch (err) {
    return corsResponse(500, { error: err.message || "Internal Error" });
  }
};

function corsResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
      "Vary": "Host, X-Forwarded-Host"
    },
    body: JSON.stringify(body),
  };
}

function normalizeHost(rawHost) {
  return String(rawHost || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}
