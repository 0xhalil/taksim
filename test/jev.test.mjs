// Jev, TypeSafe's decision model, as an optional tool: with a key connected the orchestrator gets `decide`;
// without one nothing changes. A local stand-in answers where the real API would.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "taksim-home-"));
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_FAKE = "1";
process.env.TAKSIM_QUIET = "1";

// a stand-in for api.typesafe.ai: the light option when the state says "rename", else the strong one
const asked = [];
const jev = createServer((req, res) => {
  const auth = req.headers.authorization;
  if (req.url === "/v1/models") {
    res.writeHead(auth === "Bearer good-key" ? 200 : 401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "jev-1.13.0" }] }));
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = JSON.parse(body); asked.push({ auth, ...j });
    const [id, q] = Object.entries(j.questions)[0];
    const light = /rename/.test(j.state);
    const probabilities = Object.fromEntries(Object.keys(q.criteria || { a: 0 }).map((k) => [k, k === (light ? "light" : "strong") ? 0.9 : 0.1]));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "jev-1.13.0", answers: { [id]: q.type === "noul" ? { type: "noul", noul: 0.8 } : { type: "choice", choice: light ? "light" : "strong", confidence: 0.9, probabilities } }, usage: {} }));
  });
});
await new Promise((r) => jev.listen(0, "127.0.0.1", r));
process.env.TAKSIM_JEV_BASE = `http://127.0.0.1:${jev.address().port}`;

const { startServer } = await import("../src/server.mjs");
const { getCanvas } = await import("../src/canvas/canvas.mjs");
const { pick, yesNo, jevReady } = await import("../src/jev.mjs");

let server, base;
before(async () => {
  server = await startServer({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); jev.close(); rmSync(home, { recursive: true, force: true }); });

const api = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const rpc = async (token, body) => (await fetch(`${base}/mcp/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const OPTIONS = { light: "mechanical, small", strong: "needs careful design" };

test("without a key: not ready, no decide tool, pick answers null", async () => {
  assert.equal(jevReady(), false);
  assert.equal(await pick({ state: "rename a variable", instructions: "tier?", options: OPTIONS }), null);
  const c = (await api("POST", "/v1/canvases", {})).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-echo" })).data;
  const token = getCanvas(c.id).agents.get(a.id).token;
  const list = await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(list.result.tools.some((t) => t.name === "decide"), false);
});

test("a wrong key is refused, a good one connects (and is not a panel source)", async () => {
  assert.equal((await api("PUT", "/v1/connections/jev", { token: "bad-key" })).status, 400);
  const ok = await api("PUT", "/v1/connections/jev", { token: "good-key" });
  assert.equal(ok.status, 200);
  assert.match(ok.data.who, /jev-1\.13\.0/);
  assert.equal(jevReady(), true);
});

test("pick returns the likeliest option with its confidence, and asks once for the same question", async () => {
  const before = asked.length;
  const r = await pick({ state: "rename a variable in one file", instructions: "Which model tier does this task need?", options: OPTIONS });
  assert.equal(r.choice, "light");
  assert.equal(r.confidence, 0.9);
  assert.equal(asked.at(-1).auth, "Bearer good-key");
  assert.equal(asked.at(-1).questions.q.type, "choice");
  await pick({ state: "rename a variable in one file", instructions: "Which model tier does this task need?", options: OPTIONS });
  assert.equal(asked.length, before + 1, "the second, identical question came from the cache");
  assert.equal((await pick({ state: "redesign the auth flow", instructions: "Which model tier does this task need?", options: OPTIONS })).choice, "strong");
  assert.equal(await yesNo({ state: "rm -rf /", instructions: "Is this command dangerous?" }), 0.8);
});

test("the orchestrator is offered decide and gets the answer through MCP", async () => {
  const c = (await api("POST", "/v1/canvases", {})).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-echo" })).data;
  const token = getCanvas(c.id).agents.get(a.id).token;
  const list = await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(list.result.tools.some((t) => t.name === "decide"), true);
  const init = await rpc(token, { jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
  assert.match(init.result.instructions, /decide asks Jev/);
  const out = await rpc(token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "decide", arguments: { state: "rename a helper", question: "Tier?", options: OPTIONS } } });
  assert.equal(JSON.parse(out.result.content[0].text).choice, "light");
  const bad = await rpc(token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "decide", arguments: { state: "x", question: "q", options: { only: "one" } } } });
  assert.equal(bad.result.isError, true);
});

test("disconnecting takes decide away again, and panels never list Jev as a source", async () => {
  assert.equal((await api("DELETE", "/v1/connections/jev")).status, 200);
  assert.equal(jevReady(), false);
  const { checkConnector } = await import("../src/connectors.mjs");
  assert.match(checkConnector({ service: "jev", call: "x" }, "s")[0], /one of slack, github, linear, jira/);
});
