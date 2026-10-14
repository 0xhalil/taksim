// Panels: bricks, specs, approval, sources (command, stream, tail, agent), row actions and the data stream.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const home = mkdtempSync(join(tmpdir(), "taksim-home-"));
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_FAKE = "1";
process.env.TAKSIM_QUIET = "1";
process.env.TAKSIM_OPENCODE_BIN = "/nonexistent/opencode";

const { startServer } = await import("../src/server.mjs");
const { getCanvas } = await import("../src/canvas/canvas.mjs");
const { parse, shape, fill } = await import("../src/bricks/data.mjs");
const { validate } = await import("../src/bricks/catalog.mjs");

const project = mkdtempSync(join(tmpdir(), "taksim-proj-"));
const NODE = process.execPath;

let server, base;
before(async () => {
  server = await startServer({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); });

async function api(method, path, body) {
  const r = await fetch(base + path, {
    method, headers: method === "GET" ? {} : { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const newCanvas = async () => (await api("POST", "/v1/canvases", { vars: { project_dir: project } })).data;
const addAgent = async (cid, spec) => (await api("POST", `/v1/canvases/${cid}/agents`, spec)).data;
async function tool(cid, aid, name, args = {}) {
  const token = getCanvas(cid).agents.get(aid).token;
  const r = await fetch(`${base}/mcp/${token}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const { result } = await r.json();
  const text = result.content[0].text;
  let data = text;
  try { data = JSON.parse(text); } catch { /* plain text */ }
  return { error: !!result.isError, text, data };
}
const panelPath = (cid, aid, rest = "") => `/v1/canvases/${cid}/agents/${aid}/panel${rest}`;
async function until(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(50);
  }
}
const nodeCmd = (code) => [NODE, "-e", code];

// ---------- data bricks ----------

test("parsers read json, jsonl, lines, csv, aligned columns and regex", () => {
  assert.deepEqual(parse('{"a":1}', "json"), { a: 1 });
  assert.deepEqual(parse('{"a":1}\nnot json\n{"a":2}\n', "jsonl"), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(parse("x\n\ny\n", "lines"), [{ text: "x" }, { text: "y" }]);
  assert.deepEqual(parse('name,note\napi,"a, b"\nweb,"say ""hi"""', "csv"), [{ name: "api", note: "a, b" }, { name: "web", note: 'say "hi"' }]);
  const ps = "CONTAINER ID   IMAGE     STATUS\nabc123         nginx     Up 2 hours\ndef456         redis     Exited (1)\n";
  assert.deepEqual(parse(ps, "columns"), [
    { "CONTAINER ID": "abc123", IMAGE: "nginx", STATUS: "Up 2 hours" },
    { "CONTAINER ID": "def456", IMAGE: "redis", STATUS: "Exited (1)" },
  ]);
  // right-aligned numbers (ps): a 5-digit pid starts left of its header
  assert.deepEqual(parse("  PID  %CPU COMM\n    7   0.0 launchd\n12345  98.5 node server\n", "columns"),
    [{ PID: "7", "%CPU": "0.0", COMM: "launchd" }, { PID: "12345", "%CPU": "98.5", COMM: "node server" }]);
  assert.deepEqual(parse("10:00 ERROR boom\nnoise\n10:01 INFO ok", { regex: "^(?<ts>\\S+) (?<level>\\w+) (?<msg>.*)$" }),
    [{ ts: "10:00", level: "ERROR", msg: "boom" }, { ts: "10:01", level: "INFO", msg: "ok" }]);
});

test("shape picks, filters, sorts and limits; fill puts row values in templates", () => {
  const data = { items: [{ n: "a", cpu: 5, s: { p: "Running" } }, { n: "b", cpu: 50, s: { p: "Failed" } }, { n: "c", cpu: 20, s: { p: "Running" } }] };
  assert.deepEqual(shape(data, { pick: "items", where: { "s.p": "Running" }, sort: "-cpu" }).map((r) => r.n), ["c", "a"]);
  assert.deepEqual(shape(data, { pick: "items", where: { cpu: { gt: 10 } }, limit: 1 }).map((r) => r.n), ["b"]);
  assert.deepEqual(shape(data, { pick: "items", where: { n: { in: ["a", "c"] }, "s.p": { match: "^run" } } }).map((r) => r.n), ["a", "c"]);
  assert.equal(fill("{n} is {s.p}", data.items[1]), "b is Failed");
  assert.equal(fill("{CONTAINER ID} at {%CPU}% {missing}", { "CONTAINER ID": "abc", "%CPU": "9.5" }), "abc at 9.5% {missing}");
});

test("validate explains what's wrong and fills in view ids and spans", () => {
  const bad = validate({ sources: { x: { brick: "nope" }, y: { brick: "command" } }, views: [{ brick: "table", source: "z" }, { brick: "gauge" }] });
  assert.equal(bad.spec, null);
  const msg = bad.errors.join("\n");
  assert.match(msg, /sources\.x\.brick: unknown source "nope"/);
  assert.match(msg, /sources\.y\.run: required/);
  assert.match(msg, /views\[0\]\.source: no source "z"/);
  assert.match(msg, /views\[1\]\.brick: unknown view "gauge"/);
  const ok = validate({ sources: { s: { brick: "agent" } }, views: [{ brick: "table", source: "s" }, { brick: "markdown", text: "hi" }, { id: "n", brick: "stat", source: "s" }] });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.spec.views.map((v) => [v.id, v.span]), [["v1", 4], ["v2", 4], ["n", 1]]);
  const ro = validate({ sources: { s: { brick: "agent" } }, views: [{ brick: "table", source: "s", row_actions: [{ label: "x", run: ["rm", "{f}"] }] }] }, { readOnly: true });
  assert.match(ro.errors.join(), /run actions need edit access/);
});

test("chart, timeline and bars specs are checked field by field", () => {
  const s = { sources: { s: { brick: "agent" } } };
  const ok = validate({ ...s, views: [
    { brick: "chart", source: "s", y: ["total", "ttfb"], agg: "avg", kind: "area", window_s: 120, unit: "ms", scale: 1000, stacked: true, warn_above: 500 },
    { brick: "chart", source: "s", x: "day", kind: "bar" },
    { brick: "timeline", source: "s", start: "createdAt", end: "updatedAt", label: "title", group: "workflowName", status: ["conclusion", "status"] },
    { brick: "bars", source: "s", label: "NAME", value: "CPU(cores)", limit: 5, max: 100, unit: "%" },
    { brick: "table", source: "s", key: "id", bar: "age_h" },
    { brick: "log", source: "s", text: ["textPayload", "jsonPayload.message"], level: "severity" },
  ] });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.spec.views.map((v) => v.span), [2, 2, 4, 2, 4, 4]);
  const bad = validate({ ...s, views: [
    { brick: "chart", source: "s", agg: "median", kind: "pie", y: [1] },
    { brick: "timeline", source: "s", label: "x" },
    { brick: "bars", source: "s", value: "v" },
  ] }).errors.join("\n");
  assert.match(bad, /views\[0\]\.agg: must be one of count, sum, avg, max, min, last/);
  assert.match(bad, /views\[0\]\.kind: must be one of line, area, bar/);
  assert.match(bad, /views\[0\]\.y: must be a field path or a list of them/);
  assert.match(bad, /views\[1\]\.start: required/);
  assert.match(bad, /views\[2\]\.label: required/);
});

test("paths reach keys with dots in brackets", () => {
  const row = { metadata: { labels: { "cloud.googleapis.com/location": "europe-west1" } }, items: [{ a: 1 }] };
  const g = (o, p) => shape(o, { pick: p });
  assert.equal(g(row, "metadata.labels[cloud.googleapis.com/location]"), "europe-west1");
  assert.equal(g(row, "items.0.a"), 1);
});

test("status words mean the same everywhere (the native app's BrickMath has the same lists)", async () => {
  const { statusTone } = await import("../src/bricks/data.mjs");
  assert.equal(statusTone("in_progress"), "run");
  assert.equal(statusTone("CHANGES_REQUESTED"), "err");
  assert.equal(statusTone("queued"), "wait");
  assert.equal(statusTone("success"), "ok");
  assert.equal(statusTone("cancelled"), "idle");
  assert.equal(statusTone("Running (since 2m)"), "run");
});

// ---------- tools ----------

test("panel tools are listed and list_bricks describes the catalog", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-echo" });
  const token = getCanvas(c.id).agents.get(a.id).token;
  const list = await (await fetch(`${base}/mcp/${token}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json();
  const names = list.result.tools.map((t) => t.name);
  for (const n of ["list_bricks", "panel_open", "panel_patch", "panel_push", "panel_read", "panel_close"]) assert.ok(names.includes(n), n);
  const cat = (await tool(c.id, a.id, "list_bricks")).data;
  assert.deepEqual(Object.keys(cat.sources), ["command", "tail", "http", "sql", "connector", "agent"]);
  assert.ok(cat.views.table && cat.views.log && cat.example.views.length);
  assert.ok(getCanvas(c.id).agents.get(a.id).systemPrompt().includes("panel_open"));
});

test("an invalid spec is rejected with the errors and leaves no panel", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-echo" });
  const r = await tool(c.id, a.id, "panel_open", { spec: { views: [{ brick: "table", source: "missing" }] } });
  assert.equal(r.error, true);
  assert.match(r.text, /no source "missing"/);
  assert.equal((await api("GET", panelPath(c.id, a.id))).status, 404);
});

test("agent-pushed data shows without approval; push, read, patch and close", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-echo" });
  const open = await tool(c.id, a.id, "panel_open", { spec: { title: "Bulgular", sources: { notes: { brick: "agent" } },
    views: [{ id: "md", brick: "markdown", source: "notes" }] } });
  assert.equal(open.data.status, "running");
  await tool(c.id, a.id, "panel_push", { source: "notes", data: "# Özet\n- ok" });
  await tool(c.id, a.id, "panel_push", { source: "found", data: [{ file: "a.js", issue: "leak" }] }); // added on the fly
  await tool(c.id, a.id, "panel_push", { source: "found", data: { file: "b.js", issue: "race" }, mode: "append" });
  const read = (await tool(c.id, a.id, "panel_read")).data;
  assert.equal(read.sources.notes.data, "# Özet\n- ok");
  assert.deepEqual(read.sources.found.data.map((r) => r.file), ["a.js", "b.js"]);

  const p = await tool(c.id, a.id, "panel_patch", { views: [{ id: "t", brick: "table", source: "found", columns: ["file"] }, { id: "md", title: "Notlar" }], order: ["t", "md"] });
  assert.deepEqual(p.data.views, ["t", "md"]);
  const view = (await api("GET", panelPath(c.id, a.id))).data;
  assert.equal(view.spec.views[1].title, "Notlar");
  assert.equal(view.data.found.data.length, 2, "patching views keeps pushed data");
  assert.ok((await api("GET", `/v1/canvases/${c.id}/agents/${a.id}`)).data.panel.spec);

  await tool(c.id, a.id, "panel_patch", { views: [{ id: "md", remove: true }] });
  assert.deepEqual((await api("GET", panelPath(c.id, a.id))).data.spec.views.map((v) => v.id), ["t"]);
  await tool(c.id, a.id, "panel_close");
  assert.equal((await api("GET", panelPath(c.id, a.id))).status, 404);
});

test("a command source waits for approval, then runs and shapes its output", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-echo" });
  const run = nodeCmd("console.log(JSON.stringify({items:[{n:'a',cpu:5},{n:'b',cpu:50},{n:'c',cpu:20}]}))");
  const open = await tool(c.id, a.id, "panel_open", { spec: { sources: { top: { brick: "command", run, parse: "json", pick: "items", sort: "-cpu", limit: 2 }, mine: { brick: "agent" } },
    views: [{ brick: "table", source: "top" }, { brick: "json", source: "mine" }] } });
  await tool(c.id, a.id, "panel_push", { source: "mine", data: { ok: 1 } });
  assert.deepEqual((await tool(c.id, a.id, "panel_read")).data.sources.mine.data, { ok: 1 }, "sources that need no approval work while the rest waits");
  assert.equal(open.data.status, "pending");
  assert.match(open.data.note, /approve/);
  let v = (await api("GET", panelPath(c.id, a.id))).data;
  assert.equal(v.pending[0].kind, "command");
  assert.deepEqual(v.pending[0].argv, run);
  await sleep(300);
  assert.equal((await tool(c.id, a.id, "panel_read")).data.sources.top.data, null, "nothing runs before approval");

  await api("POST", panelPath(c.id, a.id, "/approve"), {});
  const rows = await until(async () => (await tool(c.id, a.id, "panel_read")).data.sources.top.data);
  assert.deepEqual(rows.map((r) => r.n), ["b", "c"]);

  // a view change keeps the approval; a new command needs it again
  assert.equal((await tool(c.id, a.id, "panel_patch", { views: [{ id: "v1", title: "Top" }] })).data.status, "running");
  assert.equal((await tool(c.id, a.id, "panel_patch", { sources: { more: { brick: "command", run: nodeCmd("1") } } })).data.status, "pending");
  await api("POST", panelPath(c.id, a.id, "/reject"), {});
  v = (await api("GET", panelPath(c.id, a.id))).data;
  assert.equal(v.status, "rejected");
  assert.deepEqual([...getCanvas(c.id).agents.get(a.id).panel.runners.keys()], ["mine"], "rejected: no command runs");
});

test("auto-approve runs commands at once; only the user can turn it on", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-echo", autoApprove: true });
  const r = await tool(c.id, a.id, "panel_open", { spec: { sources: { s: { brick: "command", run: nodeCmd("console.log('hi')") } }, views: [{ brick: "log", source: "s" }] } });
  assert.equal(r.data.status, "running");
  assert.deepEqual(await until(async () => (await tool(c.id, a.id, "panel_read")).data.sources.s.data), [{ text: "hi" }]);

  const lead = await addAgent(c.id, { name: "lead", model: "fake-delegate" });
  const call = `CALL ${JSON.stringify({ tool: "create_agent", args: { name: "kid", role: "x", autoApprove: true } })}`;
  await api("POST", `/v1/canvases/${c.id}/agents/${lead.id}/messages`, { text: call, wait: true });
  const kid = getCanvas(c.id).find("kid");
  assert.equal(kid.autoApprove, false);

  // "always" on the approval card turns it on for that agent
  const b = await addAgent(c.id, { model: "fake-echo" });
  await tool(c.id, b.id, "panel_open", { spec: { sources: { s: { brick: "command", run: nodeCmd("console.log(1)") } }, views: [{ brick: "json", source: "s" }] } });
  await api("POST", panelPath(c.id, b.id, "/approve"), { always: true });
  assert.equal((await api("GET", `/v1/canvases/${c.id}/agents/${b.id}`)).data.autoApprove, true);
});

test("the user's own spec needs no approval", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-echo" });
  const r = await api("PUT", panelPath(c.id, a.id), { spec: { sources: { s: { brick: "command", run: nodeCmd("console.log('x')") } }, views: [{ brick: "log", source: "s" }] } });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, "running");
  const bad = await api("PUT", panelPath(c.id, a.id), { spec: { views: [{ brick: "bogus" }] } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error.message, /unknown view "bogus"/);
});

test("tail follows a file in the agent's directory; credential files are refused", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-echo" });
  mkdirSync(join(project, "logs"), { recursive: true });
  const file = join(project, "logs", "app.log");
  writeFileSync(file, "10:00 INFO start\n10:01 ERROR boom\n");
  const r = await tool(c.id, a.id, "panel_open", { spec: { sources: { log: { brick: "tail", path: "logs/app.log",
    parse: { regex: "^(?<ts>\\S+) (?<level>\\w+) (?<msg>.*)$" }, where: { level: { ne: "DEBUG" } } } }, views: [{ brick: "log", source: "log", text: "msg", level: "level" }] } });
  assert.equal(r.data.status, "running", "a file inside the agent's directory needs no approval");
  await until(async () => (await tool(c.id, a.id, "panel_read")).data.sources.log.data?.length === 2);
  appendFileSync(file, "10:02 DEBUG noise\n10:03 WARN slow\n");
  const rows = await until(async () => { const d = (await tool(c.id, a.id, "panel_read")).data.sources.log.data; return d?.length === 3 && d; });
  assert.deepEqual(rows.map((x) => x.msg), ["start", "boom", "slow"]);

  const outside = await tool(c.id, a.id, "panel_patch", { sources: { other: { brick: "tail", path: join(home, "x.log") } } });
  assert.equal(outside.data.status, "pending", "a file elsewhere needs approval");
  const secret = await tool(c.id, a.id, "panel_patch", { sources: { k: { brick: "tail", path: "~/.ssh/id_rsa" } } });
  assert.equal(secret.error, true);
  assert.match(secret.text, /credential/);
});

test("a stream command appends its lines and stops with the agent", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-echo", autoApprove: true });
  const pidFile = join(project, "stream.pid");
  const script = `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); let i=0; setInterval(()=>console.log(JSON.stringify({i:i++})),50)`;
  await tool(c.id, a.id, "panel_open", { spec: { sources: { ev: { brick: "command", run: nodeCmd(script), stream: true, parse: "jsonl", limit: 5 } }, views: [{ brick: "log", source: "ev" }] } });
  const rows = await until(async () => { const d = (await tool(c.id, a.id, "panel_read")).data.sources.ev.data; return d?.length === 5 && d.at(-1).i >= 6 && d; });
  assert.equal(rows.length, 5, "keeps only the last `limit` rows");
  const pid = Number(readFileSync(pidFile, "utf8"));
  process.kill(pid, 0); // running
  await api("DELETE", `/v1/canvases/${c.id}/agents/${a.id}`);
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
});

test("row actions: ask messages the agent with the row; run executes with row values", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-echo" });
  await tool(c.id, a.id, "panel_open", { spec: { sources: { s: { brick: "agent" } }, views: [{ id: "t", brick: "table", source: "s",
    row_actions: [{ label: "Neden?", ask: "Why is {name} {state}?" }, { label: "Echo", run: [NODE, "-e", "console.log('got', process.argv[1])", "{name}"] }] }] } });
  assert.equal((await api("GET", panelPath(c.id, a.id))).data.status, "pending", "run actions need approval too");
  await api("POST", panelPath(c.id, a.id, "/approve"), {});

  const ask = await api("POST", panelPath(c.id, a.id, "/action"), { view: "t", index: 0, row: { name: "api", state: "down" } });
  assert.deepEqual(ask.data, { sent: true });
  const t = await until(async () => {
    const tr = (await api("GET", `/v1/canvases/${c.id}/agents/${a.id}/transcript`)).data.transcript;
    return tr.find((e) => e.kind === "assistant") && tr;
  });
  assert.match(t[0].text, /^\[From your panel, view "t"\] Why is api down\?\n\nRow: \{"name":"api","state":"down"\}/);

  const run = await api("POST", panelPath(c.id, a.id, "/action"), { view: "t", index: 1, row: { name: "web" } });
  assert.equal(run.data.code, 0);
  assert.equal(run.data.output, "got web");
  const inject = await api("POST", panelPath(c.id, a.id, "/action"), { view: "t", index: 1, row: { name: "--evil" } });
  assert.equal(inject.status, 400);
});

test("read-only agents can't add run actions", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-echo", sandbox: "read-only" });
  const r = await tool(c.id, a.id, "panel_open", { spec: { sources: { s: { brick: "agent" } }, views: [{ brick: "table", source: "s", row_actions: [{ label: "x", run: ["true"] }] }] } });
  assert.equal(r.error, true);
  assert.match(r.text, /read-only/);
});

test("the panel stream sends a snapshot, then changes", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-echo" });
  await tool(c.id, a.id, "panel_open", { spec: { sources: { s: { brick: "agent" } }, views: [{ brick: "json", source: "s" }] } });
  await tool(c.id, a.id, "panel_push", { source: "s", data: { v: 1 } });
  const ac = new AbortController();
  const r = await fetch(`${base}/v1/canvases/${c.id}/panels/stream`, { signal: ac.signal });
  const reader = r.body.getReader();
  let buf = "";
  const next = async (re) => {
    while (!re.test(buf)) buf += new TextDecoder().decode((await reader.read()).value);
  };
  await next(/event: snapshot\ndata: .*"v":1/);
  await tool(c.id, a.id, "panel_push", { source: "s", data: { v: 2 } });
  await next(/event: data\ndata: .*"mode":"replace".*"v":2/);
  ac.abort();
});

test("ui state is kept and the panel survives a reload", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-echo" });
  await tool(c.id, a.id, "panel_open", { spec: { title: "T", sources: { s: { brick: "agent" } }, views: [{ brick: "json", source: "s" }] } });
  await api("PATCH", panelPath(c.id, a.id), { collapsed: true, size: [700, 500] });
  const canvas = getCanvas(c.id);
  canvas.flush();
  const saved = JSON.parse(JSON.stringify(canvas.toJSON())).agents.find((x) => x.id === a.id);
  assert.equal(saved.panel.spec.title, "T");
  assert.deepEqual(saved.panel.ui, { collapsed: true, maximized: false, size: [700, 500] });
  assert.equal(saved.autoApprove, false);
});

test("panel tools are marked read-only, so read-only agents (Claude's plan mode) can use them", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-echo", sandbox: "read-only" });
  const token = getCanvas(c.id).agents.get(a.id).token;
  const list = await (await fetch(`${base}/mcp/${token}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json();
  const ro = Object.fromEntries(list.result.tools.map((t) => [t.name, !!t.annotations?.readOnlyHint]));
  for (const n of ["list_bricks", "panel_open", "panel_patch", "panel_push", "panel_read", "panel_close", "list_agents", "get_context"]) assert.equal(ro[n], true, n);
  assert.equal(ro.create_agent, false);
  assert.equal(ro.update_context, undefined, "shared context rewriting is absent from Ask mode");
});

test("panels nobody looks at poll slowly; a page opening the canvas or unfolding the panel brings them back", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { name: "w", model: "fake-echo" });
  await api("PUT", `/v1/canvases/${c.id}/agents/${a.id}/panel`, { spec: { sources: { t: { brick: "command", run: ["date"], every_s: 2 } }, views: [{ brick: "log", source: "t" }] } });
  const canvas = getCanvas(c.id), panel = canvas.agents.get(a.id).panel;
  assert.equal(panel.pace(2), 30, "no page open: at least every 30 s");
  const send = () => {};
  canvas.panelSubs.add(send);
  assert.equal(panel.pace(2), 2, "a page shows it: as asked");
  panel.setUi({ collapsed: true });
  assert.equal(panel.pace(10), 60, "folded: 6× slower");
  let refreshed = 0;
  for (const r of panel.runners.values()) { const f = r.refresh; r.refresh = () => { refreshed++; f?.(); }; }
  panel.setUi({ collapsed: false });
  assert.equal(refreshed, 1, "unfolding runs it at once");
  canvas.panelSubs.delete(send);
});

test("scene: templates, rows, data frames and the timeline mean the same thing for every renderer", async () => {
  const { evaluate, fill, expand, schedule, colorToken, validateScene, ease } = await import("../src/bricks/scene.mjs");
  assert.equal(evaluate("i*40+20", { vars: { i: 2 } }), 100);
  assert.equal(evaluate("i-1", { vars: { i: 2 } }), 1);
  assert.equal(evaluate("max(a, b) / 2", { row: { a: 3, b: 8 } }), 4);
  assert.equal(evaluate("STATUS == 'Running' ? 'ok' : 'err'", { row: { STATUS: "Failed" } }), "err");
  assert.equal(evaluate("labels[app.kubernetes.io/name]", { row: { labels: { "app.kubernetes.io/name": "api" } } }), "api");
  assert.throws(() => evaluate("process.exit()", { row: {} }), /unexpected/);
  assert.equal(fill("{name}: {n}", { row: { name: "api", n: 3 } }), "api: 3");
  assert.equal(fill("{n/max*100}", { row: { n: 5 }, vars: { max: 10 } }), 50, "a lone expression stays a number");

  const view = { source: "q", size: [300, 100], shapes: [{ id: "title", type: "text", x: 10, y: 14, text: "Kuyruk" }],
    each: { key: "name", value: "n", shapes: [{ id: "bar", type: "rect", x: "{i*60+10}", y: "{100-n/max*80}", w: 40, h: "{n/max*80}", fill: "status:{state}" }] },
    steps: [{ do: "write", target: "title" }, { do: "grow", target: "bar" }, { do: "wait", dur: 1 }, { do: "indicate", target: "b", at: 3 }] };
  const shapes = expand(view, [{ name: "a", n: 2, state: "Running" }, { name: "b", n: 4, state: "Failed" }, { name: "b", n: 1, state: "Pending" }]);
  assert.deepEqual(shapes.map((s) => s.id), ["title", "a/bar", "b/bar", "b#2/bar"], "repeated keys stay unique");
  assert.deepEqual(shapes.slice(1).map((s) => [s.x, s.y, s.h]), [[10, 60, 40], [70, 20, 80], [130, 80, 20]]);
  assert.deepEqual(shapes.slice(1).map((s) => colorToken(s.fill)), ["accent", "err", "wait"], "status words color by meaning");

  const plan = schedule(view, shapes);
  assert.deepEqual(plan.steps.map((s) => [s.do, s.start, s.end]), [["write", 0, 0.6], ["grow", 0.6, 1.2], ["wait", 1.2, 2.2], ["indicate", 3, 3.6]]);
  assert.deepEqual(plan.steps[1].targets, ["a/bar", "b/bar", "b#2/bar"], "a target names the shape inside each, for every row");
  assert.deepEqual(plan.steps[3].targets, ["b/bar"], "or one row by its key");
  assert.ok(plan.hidden.has("title") && plan.hidden.has("a/bar"), "what is created later starts hidden");
  assert.equal(plan.length, 3.6);

  const data = { x: { min: 0, max: 10 }, y: { min: 0, max: 100 }, size: [200, 100], shapes: [{ type: "rect", data: true, x: 5, y: 0, w: 1, h: 50 }] };
  assert.deepEqual((({ x, y, w, h }) => ({ x, y, w, h }))(expand(data, null)[0]), { x: 100, y: 50, w: 20, h: 50 }, "data units: y grows up");
  assert.equal(ease("smooth", 0.5), 0.5);
  assert.deepEqual(validateScene({ shapes: [{ type: "text" }] }, "v"), ["v.shapes[0].text: required"]);
});
