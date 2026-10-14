// Small HTTP helpers shared by routes.

// The attachments route streams its own 20 MB cap; every other JSON body is capped here
// so one giant POST can't balloon the proxy's memory.
const MAX_JSON_BODY = 10 * 1024 * 1024;

export function readJson(req, maxBytes = MAX_JSON_BODY) {
  return new Promise((resolve, reject) => {
    let body = "", size = 0, tooBig = false;
    req.on("data", (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > maxBytes) { tooBig = true; reject(Object.assign(new Error("request body too large"), { status: 413 })); req.destroy(); return; }
      body += c;
    });
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

export function sendJson(res, status, obj, extra = {}) {
  res.writeHead(status, { "content-type": "application/json", ...extra });
  res.end(JSON.stringify(obj));
}

export function sse(res, data, event) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

export const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" };

export const httpError = (status, message) => Object.assign(new Error(message), { status });
