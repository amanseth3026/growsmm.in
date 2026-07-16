// Thin adapter: converts a Vercel (req, res) invocation into a
// Netlify-style { event } → { statusCode, headers, body } handler call.
// This preserves the original Netlify function code byte-for-byte and
// only translates the request/response boundary.

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    // Vercel already parses JSON/urlencoded bodies onto req.body by default.
    // We want the *raw* string Netlify handlers expect on event.body.
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === "string") return resolve(req.body);
      if (Buffer.isBuffer(req.body)) return resolve(req.body.toString("utf8"));
      try {
        return resolve(JSON.stringify(req.body));
      } catch (e) {
        return reject(e);
      }
    }
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function normalizeHeaders(reqHeaders = {}) {
  const out = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : v;
  }
  return out;
}

function splitPathAndQuery(url) {
  const idx = url.indexOf("?");
  if (idx === -1) return { path: url, queryStringParameters: {} };
  const path = url.slice(0, idx);
  const qs = url.slice(idx + 1);
  const params = {};
  const multi = {};
  for (const pair of qs.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const rawK = eq === -1 ? pair : pair.slice(0, eq);
    const rawV = eq === -1 ? "" : pair.slice(eq + 1);
    let k, v;
    try {
      k = decodeURIComponent(rawK.replace(/\+/g, " "));
    } catch {
      k = rawK;
    }
    try {
      v = decodeURIComponent(rawV.replace(/\+/g, " "));
    } catch {
      v = rawV;
    }
    params[k] = v;
    (multi[k] = multi[k] || []).push(v);
  }
  return { path, queryStringParameters: params, multiValueQueryStringParameters: multi };
}

function toVercel(res, result) {
  if (!result || typeof result !== "object") {
    res.status(200).end();
    return;
  }
  const { statusCode = 200, headers = {}, body = "", isBase64Encoded = false } = result;
  for (const [k, v] of Object.entries(headers)) {
    try {
      res.setHeader(k, v);
    } catch (_) {
      /* ignore invalid header */
    }
  }
  res.status(statusCode);
  if (body === undefined || body === null || body === "") return res.end();
  if (isBase64Encoded) return res.end(Buffer.from(body, "base64"));
  return res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function createVercelHandler(netlifyHandler) {
  return async function vercelHandler(req, res) {
    try {
      const rawBody = await readRawBody(req);
      const { path, queryStringParameters, multiValueQueryStringParameters } = splitPathAndQuery(
        req.url || "/"
      );
      const headers = normalizeHeaders(req.headers);
      const event = {
        httpMethod: req.method,
        path,
        rawUrl: req.url,
        headers,
        multiValueHeaders: Object.fromEntries(
          Object.entries(headers).map(([k, v]) => [k, [v]])
        ),
        queryStringParameters,
        multiValueQueryStringParameters,
        body: rawBody,
        isBase64Encoded: false,
      };
      const context = {};
      const result = await netlifyHandler(event, context);
      toVercel(res, result || { statusCode: 200, body: "" });
    } catch (err) {
      console.error("[netlify-adapter] handler error:", err);
      try {
        res.status(500).setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: err && err.message ? err.message : "Internal Server Error" }));
      } catch (_) {
        /* response already sent */
      }
    }
  };
}

module.exports = { createVercelHandler };
