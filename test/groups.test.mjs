// Groups: frames whose members share a context note. Membership by position, nesting, the maintainer
// (lead) as the only agent allowed to edit, versions, and how the context reaches agents.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const home = mkdtempSync(join(tmpdir(), "taksim-home-"));
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_FAKE = "1";
process.env.TAKSIM_QUIET = "1";
process.env.TAKSIM_OPENCODE_BIN = "/nonexistent/opencode";

const { startServer } = await import("../src/server.mjs");

let server, base, port;
before(async () => {
  server = await startServer({ host: "127.0.0.1", port: 0 });
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});
after(() => { server.close(); rmSync(home, { recursive: true, force: true }); });

async function api(method, path, body) {
  const r = await fetch(base + path, {
    method, headers: method === "GET" ? {} : { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const newCanvas = async () => (await api("POST", "/v1/canvases", {})).data;
const addAgent = async (cid, spec) => (await api("POST", `/v1/canvases/${cid}/agents`, spec)).data;
const say = async (cid, aid, text) => (await api("POST", `/v1/canvases/${cid}/agents/${aid}/messages`, { text, wait: true })).data;
const call = (tool, args) => `CALL ${JSON.stringify({ tool, args })}`;
const until = async (fn, timeout = 6000) => {
  const end = Date.now() + timeout;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timeout"); await sleep(50); }
};

// outer [0,0,2000,1000] holds inner [0,0,900,600]; agents placed inside/outside by position
async function setup() {
  const c = await newCanvas();
  const outer = (await api("POST", `/v1/canvases/${c.id}/groups`, { name: "proje", rect: [0, 0, 2000, 1000], context: "# Proje\nTürkçe yanıt ver." })).data;
  const inner = (await api("POST", `/v1/canvases/${c.id}/groups`, { name: "backend", rect: [0, 0, 900, 600] })).data;
  const lead = await addAgent(c.id, { name: "lead", model: "fake-delegate", pos: [100, 100] });
  const dev = await addAgent(c.id, { name: "dev", model: "fake-args", pos: [100, 350] });
  const ui = await addAgent(c.id, { name: "ui", model: "fake-args", pos: [1200, 100] });
  const outside = await addAgent(c.id, { name: "outside", model: "fake-args", pos: [2600, 100] });
  return { c, outer, inner, lead, dev, ui, outside };
}

test("membership follows position; nested groups stack outermost first", async () => {
  const { c, outer, inner, lead, dev, ui, outside } = await setup();
  const groups = (await api("GET", `/v1/canvases/${c.id}/groups`)).data.groups;
  const members = (g) => groups.find((x) => x.id === g.id).members.sort();
  assert.deepEqual(members(inner), [dev.id, lead.id].sort());
  assert.deepEqual(members(outer), [dev.id, lead.id, ui.id].sort());
  assert.ok(!members(outer).includes(outside.id));
});

test("get_context returns the agent's groups outermost first; outsiders get none", async () => {
  const { c, lead, outside } = await setup();
  await api("PUT", `/v1/canvases/${c.id}/groups/backend/context`, { content: "API snake_case." });
  const out = (await say(c.id, lead.id, call("get_context"))).text;
  assert.match(out, /# proje \(v1[^)]*\)[\s\S]*Türkçe yanıt ver\.[\s\S]*# backend \(v1[^)]*\)[\s\S]*API snake_case\./);
  const lonely = (await api("POST", `/v1/canvases/${c.id}/agents`, { name: "d2", model: "fake-delegate", pos: [2600, 400] })).data;
  assert.match((await say(c.id, lonely.id, call("get_context"))).text, /not in any group/);
  void outside;
});

test("the summary of each group's context is in the member's system prompt", async () => {
  const { c, dev, outside } = await setup();
  const argv = (t) => JSON.parse(t).argv;
  const sys = (a) => a[a.indexOf("--system") + 1];
  const inside = sys(argv((await say(c.id, dev.id, "x")).text));
  assert.match(inside, /You are in groups "proje" > "backend"/);
  assert.match(inside, /--- proje \(v1\) ---\n# Proje\nTürkçe yanıt ver\./);
  assert.doesNotMatch(sys(argv((await say(c.id, outside.id, "x")).text)), /You are in group/);
});

test("only the group's maintainer can update its context; versions are kept", async () => {
  const { c, inner, lead, dev } = await setup();
  await api("PATCH", `/v1/canvases/${c.id}/groups/${inner.id}`, { maintainer: "dev" });
  const denied = (await say(c.id, lead.id, call("update_context", { group: "backend", content: "x" }))).text;
  assert.match(denied, /ERROR only the group's maintainer/);
  await api("PATCH", `/v1/canvases/${c.id}/groups/${inner.id}`, { maintainer: "lead" });
  const ok = (await say(c.id, lead.id, call("update_context", { group: "backend", content: "Karar: JWT." }))).text;
  assert.match(ok, /Updated "backend" context to v1/);
  await say(c.id, lead.id, call("update_context", { group: "backend", content: "Karar: Postgres.", mode: "append" }));
  const g = (await api("GET", `/v1/canvases/${c.id}/groups/${inner.id}`)).data;
  assert.equal(g.version, 2);
  assert.equal(g.context, "Karar: JWT.\n\nKarar: Postgres.");
  assert.deepEqual((await api("GET", `/v1/canvases/${c.id}/groups/${inner.id}/history`)).data.versions, [1, 2]);
  assert.equal((await api("GET", `/v1/canvases/${c.id}/groups/${inner.id}/history/1`)).data.content, "Karar: JWT.");
  // a maintainer that is removed loses the role to the members that remain
  await api("DELETE", `/v1/canvases/${c.id}/agents/${lead.id}`);
  assert.equal((await api("GET", `/v1/canvases/${c.id}/groups/${inner.id}`)).data.maintainer, dev.id);
});

test("terminal members get one-line notices for context updates and group moves", async () => {
  const { c, inner, dev } = await setup();
  const agent = await addAgent(c.id, { name: "tty", model: "fake-echo", pos: [500, 350] });
  await api("POST", `/v1/canvases/${c.id}/agents/${agent.id}/terminal`);
  let out = "";
  const ws = new WebSocket(`ws://127.0.0.1:${port}/term/${c.id}/${agent.id}`, { headers: { origin: `http://127.0.0.1:${port}` } });
  ws.on("message", (d) => (out += d));
  await until(() => out.includes("ready"));
  await api("PUT", `/v1/canvases/${c.id}/groups/${inner.id}/context`, { content: "yeni karar" });
  await api("POST", `/v1/canvases/${c.id}/agents/${agent.id}/messages`, { text: "first" });
  await until(() => out.includes("tui: first"));
  assert.match(out, /\[Group "backend" context updated to v1; call get_context/);
  await api("PATCH", `/v1/canvases/${c.id}/agents/${agent.id}`, { pos: [1200, 700] }); // out of backend, still in proje
  await api("POST", `/v1/canvases/${c.id}/agents/${agent.id}/messages`, { text: "second" });
  await until(() => out.includes("tui: second"));
  assert.match(out, /\[You left group "backend"; its context no longer applies\.\]/);
  ws.close();
  await api("DELETE", `/v1/canvases/${c.id}/agents/${agent.id}/terminal`);
  void dev;
});

test("groups: rename, resize, delete (with their files)", async () => {
  const { c, inner } = await setup();
  await api("PUT", `/v1/canvases/${c.id}/groups/${inner.id}/context`, { content: "x" });
  const r = (await api("PATCH", `/v1/canvases/${c.id}/groups/${inner.id}`, { name: "api", rect: [0, 0, 10, 10] })).data;
  assert.equal(r.name, "api");
  assert.deepEqual(r.rect, [0, 0, 140, 80], "frames have a minimum size");
  assert.equal((await api("PATCH", `/v1/canvases/${c.id}/groups/${inner.id}`, { maintainer: "nobody" })).status, 400);
  const dir = join(home, "canvases", c.id, "groups", inner.id);
  assert.ok(existsSync(dir));
  assert.equal((await api("DELETE", `/v1/canvases/${c.id}/groups/${inner.id}`)).status, 200);
  assert.equal(existsSync(dir), false);
  assert.equal((await api("GET", `/v1/canvases/${c.id}/groups/${inner.id}`)).status, 404);
});

test("a headless agent that joins a group is told so in its next message", async () => {
  const { c, outside } = await setup();
  await say(c.id, outside.id, "before");
  await api("PATCH", `/v1/canvases/${c.id}/agents/${outside.id}`, { pos: [1200, 400] }); // into "proje"
  const after = JSON.parse((await say(c.id, outside.id, "after")).text);
  assert.match(after.prompt, /^\[You are now in group "proje"; call get_context for its shared context\.\]\n\nafter$/);
  const next = JSON.parse((await say(c.id, outside.id, "again")).text);
  assert.equal(next.prompt, "again", "only once");
});

test("the memory is the note's entries, each with its writer; any member can remember, the user edits by hand", async () => {
  const { c, inner, lead } = await setup();
  const path = `/v1/canvases/${c.id}/groups/${inner.id}`;
  await api("PUT", `${path}/context`, { content: "Karar: JWT.\n\n- API snake_case\n- testler önce" });
  assert.match((await say(c.id, lead.id, call("remember", { text: "worker bellek sınırı 512Mi" }))).text, /Remembered in "backend" \(v2\)/);
  let g = (await api("GET", path)).data;
  assert.equal(g.context, "Karar: JWT.\n\n- API snake_case\n- testler önce\n\nworker bellek sınırı 512Mi");
  assert.deepEqual(g.memory.map((e) => [e.text, e.by]), [["Karar: JWT.", "user"], ["- API snake_case", "user"], ["- testler önce", "user"], ["worker bellek sınırı 512Mi", lead.id]]);
  // the user rewrites one entry and drops another: the rest keep their writers
  await api("PUT", `${path}/context`, { content: "Karar: JWT.\n\n- API camelCase\n\nworker bellek sınırı 512Mi" });
  g = (await api("GET", path)).data;
  assert.deepEqual(g.memory.map((e) => [e.text, e.by]), [["Karar: JWT.", "user"], ["- API camelCase", "user"], ["worker bellek sınırı 512Mi", lead.id]]);
  // reading marks the member as up to date
  await say(c.id, lead.id, call("get_context"));
  assert.equal((await api("GET", path)).data.seen[lead.id], 3);
  // only members remember, and only into their own groups
  const loner = await addAgent(c.id, { name: "loner", model: "fake-delegate", pos: [2600, 600] });
  assert.match((await say(c.id, loner.id, call("remember", { text: "x" }))).text, /ERROR You are not in any group/);
});

test("memory entries: blocks and list items split and join back", async () => {
  const { splitMemory, joinMemory } = await import("../src/canvas/memory.mjs");
  const text = "# Proje\nTürkçe yanıt ver.\n\n- a\n  - a1\n- b\n\nSon.";
  assert.deepEqual(splitMemory(text), ["# Proje\nTürkçe yanıt ver.", "- a\n  - a1", "- b", "Son."]);
  assert.equal(joinMemory(splitMemory(text)), text);
  assert.deepEqual(splitMemory("Giriş:\n- x\n- y"), ["Giriş:\n- x\n- y"]);
});

test("a group elects its keeper: the orchestrator, else the first to join; leaving hands it on", async () => {
  const c = await newCanvas();
  const g = (await api("POST", `/v1/canvases/${c.id}/groups`, { name: "ops", rect: [0, 0, 1600, 900] })).data;
  const keeper = async () => (await api("GET", `/v1/canvases/${c.id}/groups/${g.id}`)).data.maintainer;
  assert.equal(await keeper(), null);
  // two agents both created later by an orchestrator outside the group: the first to join keeps it
  const orch = await addAgent(c.id, { name: "orch", model: "fake-delegate", pos: [2400, 100] });
  await say(c.id, orch.id, call("create_agent", { name: "k8s", model: "fake-args" }));
  await say(c.id, orch.id, call("create_agent", { name: "kod", model: "fake-args" }));
  const byName = async (n) => (await api("GET", `/v1/canvases/${c.id}`)).data.agents.find((a) => a.name === n);
  const k8s = await byName("k8s"), kod = await byName("kod");
  await api("PATCH", `/v1/canvases/${c.id}/agents/${k8s.id}`, { pos: [100, 100] });
  assert.equal(await keeper(), k8s.id);
  await api("PATCH", `/v1/canvases/${c.id}/agents/${kod.id}`, { pos: [100, 500] });
  assert.equal(await keeper(), k8s.id);
  // the orchestrator that made them comes in: it takes over
  await api("PATCH", `/v1/canvases/${c.id}/agents/${orch.id}`, { pos: [700, 100] });
  assert.equal(await keeper(), orch.id);
  // it leaves: back to the first of the others to join
  await api("PATCH", `/v1/canvases/${c.id}/agents/${orch.id}`, { pos: [2400, 100] });
  assert.equal(await keeper(), k8s.id);
  // the user's pick stays while it is in the group, even against an orchestrator; leaving hands it on
  await api("PATCH", `/v1/canvases/${c.id}/groups/${g.id}`, { maintainer: kod.id });
  await api("PATCH", `/v1/canvases/${c.id}/agents/${orch.id}`, { pos: [700, 100] });
  assert.equal(await keeper(), kod.id);
  await api("PATCH", `/v1/canvases/${c.id}/agents/${kod.id}`, { pos: [2400, 600] });
  assert.equal(await keeper(), orch.id);
  // the user taking it back means none, and none stays
  await api("PATCH", `/v1/canvases/${c.id}/groups/${g.id}`, { maintainer: null });
  await api("PATCH", `/v1/canvases/${c.id}/agents/${kod.id}`, { pos: [100, 500] });
  assert.equal(await keeper(), null);
});
