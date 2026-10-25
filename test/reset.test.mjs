// The app's reset: POST /v1/reset leaves what a fresh install has.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "taksim-home-"));
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_FAKE = "1";
process.env.TAKSIM_QUIET = "1";

const { startServer } = await import("../src/server.mjs");

let server, base;
before(async () => {
  server = await startServer({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); });

const api = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test("POST /v1/reset removes canvases, named accounts and the user's own tools", async () => {
  const canvas = (await api("POST", "/v1/canvases", { name: "work" })).body;
  await api("POST", `/v1/canvases/${canvas.id}/agents`, { name: "a", model: "fake" });
  const acct = await api("POST", "/v1/accounts", { name: "work", backend: "claude" });
  assert.equal(acct.status, 201);
  const accountDir = acct.body.dir;
  assert.ok((await api("GET", "/v1/accounts")).body.accounts.length >= 1);

  const r = await api("POST", "/v1/reset", {});
  assert.equal(r.status, 200);
  assert.equal(r.body.canvases, 1);
  assert.equal(r.body.accounts >= 1, true);

  assert.deepEqual((await api("GET", "/v1/canvases")).body.canvases, []);
  assert.equal((await api("GET", "/v1/accounts")).body.accounts.filter((a) => a.dir).length, 0);
  assert.equal(existsSync(join(home, "canvases", canvas.id)), false);
  if (accountDir) assert.equal(existsSync(accountDir), false);
});
