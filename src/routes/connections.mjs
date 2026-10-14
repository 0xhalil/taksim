// Connections API: which services panels can read, connect one with a token (kept in the keychain, never
// sent back), disconnect it.

import { readJson, sendJson, httpError } from "../http.mjs";
import { listConnections, connect, disconnect } from "../connectors.mjs";

export async function connectionRoutes(req, res, path) {
  if (path === "/v1/connections" && req.method === "GET") return sendJson(res, 200, { connections: listConnections() });
  const m = path.match(/^\/v1\/connections\/([\w-]+)$/);
  if (!m) return false;
  if (req.method === "PUT") {
    const body = await readJson(req).catch(() => { throw httpError(400, "invalid JSON"); });
    return sendJson(res, 200, await connect(m[1], body?.token));
  }
  if (req.method === "DELETE") { await disconnect(m[1]); return sendJson(res, 200, { ok: true }); }
  throw httpError(405, "method not allowed");
}
