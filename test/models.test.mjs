// Model details as the CLIs give them (names, context, efforts), and an agent's thinking level.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "taksim-home-"));
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_FAKE = "1";
process.env.TAKSIM_QUIET = "1";
process.env.TAKSIM_OPENCODE_BIN = "/nonexistent/opencode";

const { startServer } = await import("../src/server.mjs");
const { readCodexCache, parseOpencodeVerbose, parseClaudeEfforts } = await import("../src/backends/models.mjs");

let server, base;
before(async () => { server = await startServer({ host: "127.0.0.1", port: 0 }); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.close(); rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); });

async function api(method, path, body) {
  const r = await fetch(base + path, { method, headers: method === "GET" ? {} : { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}

test("codex's model cache: listed models in order, with efforts and context", () => {
  const f = join(home, "models_cache.json");
  writeFileSync(f, JSON.stringify({ models: [
    { slug: "b", display_name: "B", priority: 2, visibility: "list", context_window: 272000, default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
    { slug: "hidden", visibility: "hide", priority: 0 },
    { slug: "a", display_name: "A", description: "first", priority: 1, visibility: "list", supported_reasoning_levels: [] },
  ] }));
  const m = readCodexCache(f);
  assert.deepEqual(m.map((x) => x.id), ["a", "b"]);
  assert.deepEqual(m[1], { id: "b", name: "B", description: null, context: 272000, efforts: ["low", "high"], defaultEffort: "medium" });
  assert.deepEqual(readCodexCache(join(home, "missing.json")), []);
});

test("opencode's verbose list and claude's --effort help", () => {
  const text = 'opencode/x\n{\n  "name": "X",\n  "limit": { "context": 200000 },\n  "variants": { "low": {}, "high": {} }\n}\nopencode/y\n{\n  "name": "Y"\n}\n';
  assert.deepEqual(parseOpencodeVerbose(text).map((m) => [m.id, m.name, m.context, m.efforts]), [["opencode/x", "X", 200000, ["low", "high"]], ["opencode/y", "Y", null, []]]);
  assert.deepEqual(parseClaudeEfforts("  --effort <level>   Effort level for the current session\n      (low, medium, high, xhigh, max)\n"), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(parseClaudeEfforts("no such flag"), null);
});

test("an agent keeps a thinking level; a bad one is refused, empty means the CLI's default", async () => {
  const c = (await api("POST", "/v1/canvases", {})).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-echo", effort: "high" })).data;
  assert.equal(a.effort, "high");
  assert.equal((await api("PATCH", `/v1/canvases/${c.id}/agents/${a.id}`, { effort: "LOUD!" })).status, 400);
  assert.equal((await api("PATCH", `/v1/canvases/${c.id}/agents/${a.id}`, { effort: "" })).data.effort ?? null, null);
  assert.ok(Array.isArray((await api("GET", "/v1/models")).data.data));
});

test("a new thinking level restarts an open terminal on the same session", async () => {
  const { getCanvas } = await import("../src/canvas/canvas.mjs");
  const c = (await api("POST", "/v1/canvases", {})).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-echo" })).data;
  assert.equal((await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/terminal`)).status, 200);
  const agent = getCanvas(c.id).agents.get(a.id);
  const first = agent.terminal;
  await api("PATCH", `/v1/canvases/${c.id}/agents/${a.id}`, { effort: "high" });
  for (let i = 0; i < 60 && (!agent.terminal || agent.terminal === first); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(agent.terminal && agent.terminal !== first, "a new terminal");
  assert.equal(agent.effort, "high");
  await api("DELETE", `/v1/canvases/${c.id}/agents/${a.id}/terminal`);
});

test("the create-agents switch: on, the agent is told to orchestrate, pick the fitting model per part and reuse agents", async () => {
  const c = (await api("POST", "/v1/canvases", {})).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-args" })).data;
  const sys = async () => {
    const out = JSON.parse((await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/messages`, { text: "x", wait: true })).data.text);
    return out.argv[out.argv.indexOf("--system") + 1];
  };
  assert.doesNotMatch(await sys(), /Create agents is on/);
  assert.match(await sys(), /Create agents is off/);
  assert.equal((await api("PATCH", `/v1/canvases/${c.id}/agents/${a.id}`, { delegate: true })).data.delegate, true);
  const on = await sys();
  assert.match(on, /Create agents is on: you may orchestrate/);
  assert.match(on, /by who does that kind of work well, not by price/);
  assert.match(on, /Reuse before you create/);
  const { tierOf } = await import("../src/backends/models.mjs");
  assert.deepEqual(["haiku", "sonnet", "opus", "gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra", "opencode/exo-free"].map(tierOf),
    ["light", "standard", "strong", "light", "standard", "strong", "standard"]);
  assert.deepEqual(["gemini-2.5-pro", "agy:gemini-4-argon", "agy:gemini-3.8-flash", "gpt-5-mini"].map(tierOf),
    ["strong", "standard", "light", "light"], "gemini isn't light for the mini in its name");
});

test("the arrows say why: a helper's reason on the created link, the latest topic on the message link", async () => {
  const c = (await api("POST", "/v1/canvases", {})).data;
  const lead = (await api("POST", `/v1/canvases/${c.id}/agents`, { name: "lead", model: "fake-delegate" })).data;
  const say = (t) => api("POST", `/v1/canvases/${c.id}/agents/${lead.id}/messages`, { text: `CALL ${JSON.stringify(t)}`, wait: true });
  await say({ tool: "create_agent", args: { name: "cevirmen", role: "translator: EN<->TR", model: "fake-echo", reason: "TR çeviri" } });
  await say({ tool: "ask_agent", args: { agent: "cevirmen", message: "translate hi", about: "README   çevirisi" } });
  const links = (await api("GET", `/v1/canvases/${c.id}`)).data.links;
  assert.equal(links.find((l) => l.kind === "created").label, "TR çeviri");
  assert.equal(links.find((l) => l.kind === "message").label, "README çevirisi");
  await say({ tool: "ask_agent", args: { agent: "cevirmen", message: "translate bye", about: "CHANGELOG" } });
  assert.equal((await api("GET", `/v1/canvases/${c.id}`)).data.links.find((l) => l.kind === "message").label, "CHANGELOG");
});
