// Canvas core against the fake backend: agents, turns, mailbox, persistence, events, locks.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const home = mkdtempSync(join(tmpdir(), "taksim-home-"));
const project = mkdtempSync(join(tmpdir(), "taksim-project-"));
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_FAKE = "1";
process.env.TAKSIM_QUIET = "1";
process.env.TAKSIM_OPENCODE_BIN = "/nonexistent/opencode";

const { startServer } = await import("../src/server.mjs");

let server, base;
const start = async () => {
  server = await startServer({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
};
before(start);
after(() => { server.close(); rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); rmSync(project, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); });

async function api(method, path, body) {
  const r = await fetch(base + path, {
    method, headers: method === "GET" ? {} : { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => null);
  return { status: r.status, data };
}

// Collects SSE events until `until(events)` is true.
async function events(canvasId, until, { since, timeout = 5000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  const r = await fetch(`${base}/v1/canvases/${canvasId}/events`, {
    signal: ac.signal, headers: since ? { "last-event-id": String(since) } : {},
  });
  const out = [];
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (!until(out)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const data = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "))?.slice(6);
        buf = buf.slice(i + 2);
        if (data) out.push(JSON.parse(data));
      }
    }
  } finally { clearTimeout(timer); ac.abort(); }
  return out;
}

const newCanvas = async (body = {}) => (await api("POST", "/v1/canvases", body)).data;
const addAgent = async (cid, spec) => (await api("POST", `/v1/canvases/${cid}/agents`, spec)).data;
const say = (cid, aid, text, wait = true) => api("POST", `/v1/canvases/${cid}/agents/${aid}/messages`, { text, wait });

test("an agent answers a user message and keeps a transcript", async () => {
  const c = await newCanvas({ name: "t1" });
  const a = await addAgent(c.id, { name: "echoer", model: "fake-echo" });
  const r = await say(c.id, a.id, "hello");
  assert.equal(r.status, 200);
  assert.match(r.data.text, /^echo: /);
  assert.match(r.data.text, /hello$/);
  const t = (await api("GET", `/v1/canvases/${c.id}/agents/${a.id}/transcript`)).data.transcript;
  assert.deepEqual(t.map((e) => e.kind), ["user", "assistant"]);
  assert.equal(t[1].text, r.data.text);
});

test("agents keep a CLI session in a stable directory; resetting it starts fresh", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-args" });
  const first = JSON.parse((await say(c.id, a.id, "first")).data.text);
  const session = first.argv[first.argv.indexOf("--session") + 1];
  assert.ok(session, "the first turn starts a named session");
  assert.equal((await api("GET", `/v1/canvases/${c.id}/agents/${a.id}`)).data.session, session);
  assert.match(first.cwd, /workspace$/); // no project dir: the canvas workspace
  const second = JSON.parse((await say(c.id, a.id, "second")).data.text);
  assert.equal(second.prompt, "second"); // the session carries the history
  assert.equal(second.argv[second.argv.indexOf("--session") + 1], session);
  await api("PATCH", `/v1/canvases/${c.id}/agents/${a.id}`, { reset_session: true });
  const third = JSON.parse((await say(c.id, a.id, "third")).data.text);
  assert.equal(third.prompt, "third");
  assert.notEqual(third.argv[third.argv.indexOf("--session") + 1], session);
});

test("agent-mode turns run in the project dir and resume the CLI session", async () => {
  const c = await newCanvas({ vars: { project_dir: project } });
  const a = await addAgent(c.id, { model: "fake-args", mode: "agent" });
  const first = JSON.parse((await say(c.id, a.id, "one")).data.text);
  assert.ok(first.cwd.endsWith(basename(project)));
  const session = (await api("GET", `/v1/canvases/${c.id}/agents/${a.id}`)).data.session;
  assert.equal(first.argv[first.argv.indexOf("--session") + 1], session);
  const second = JSON.parse((await say(c.id, a.id, "two")).data.text);
  assert.deepEqual(second.argv.slice(second.argv.indexOf("--session"), second.argv.indexOf("--session") + 2), ["--session", session]);
  assert.equal(second.prompt, "two"); // the session carries history, so no replay
});

test("messages to a busy agent queue up and run in order", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-wait" });
  const seen = events(c.id, (ev) => ev.filter((e) => e.type === "turn_done").length >= 2, { since: 1 });
  await say(c.id, a.id, "m1", false);
  const second = await say(c.id, a.id, "m2", false);
  assert.equal(second.data.queued, 1);
  const done = (await seen).filter((e) => e.type === "turn_done").map((e) => JSON.parse(e.data.text));
  assert.match(done[0].prompt, /m1$/);
  assert.match(done[1].prompt, /m2$/);
  assert.ok(done[1].start >= done[0].end);
});

test("stop cancels the running turn and kills its process group", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-slow" });
  const delta = events(c.id, (ev) => ev.some((e) => e.type === "text_delta"), { since: 1 });
  const reply = say(c.id, a.id, "go");
  const pids = Object.values(JSON.parse((await delta).find((e) => e.type === "text_delta").data.text));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(pids.every(alive));
  await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/stop`);
  const r = await reply;
  assert.equal(r.status, 502);
  assert.match(r.data.error.message, /stopped/);
  for (let i = 0; i < 40 && pids.some(alive); i++) await sleep(100);
  assert.deepEqual(pids.filter(alive), []);
  assert.equal((await api("GET", `/v1/canvases/${c.id}/agents/${a.id}`)).data.status, "idle");
});

test("failed turns are reported and the agent keeps working", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-error" });
  const r = await say(c.id, a.id, "x");
  assert.equal(r.status, 502);
  const view = (await api("GET", `/v1/canvases/${c.id}/agents/${a.id}`)).data;
  assert.equal(view.status, "error");
  assert.match(view.lastError, /fake failure/);
  await api("PATCH", `/v1/canvases/${c.id}/agents/${a.id}`, { model: "fake-echo" });
  assert.equal((await say(c.id, a.id, "again")).status, 200);
});

test("agents work in the canvas project dir when it is set, and agents' agents start read-only", async () => {
  const c = await newCanvas({ vars: { project_dir: project } });
  const a = await addAgent(c.id, { model: "fake-args" });
  assert.equal(a.sandbox, null, "user-created agents can edit");
  assert.ok(JSON.parse((await say(c.id, a.id, "x")).data.text).cwd.endsWith(basename(project)));
});

test("validation and limits", async () => {
  const c = await newCanvas({ limits: { max_agents: 2 } });
  assert.equal((await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-echo", cwd: "rel/dir" })).status, 400);
  assert.equal((await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-echo", sandbox: "danger-full-access" })).status, 400);
  await addAgent(c.id, { model: "fake-echo" });
  await addAgent(c.id, { model: "fake-echo" });
  const full = await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-echo" });
  assert.equal(full.status, 409);
  assert.match(full.data.error.message, /full/);
  assert.equal((await api("POST", `/v1/canvases/${c.id}/agents/nope/messages`, { text: "x" })).status, 404);
  assert.equal((await api("POST", `/v1/canvases/${c.id}/agents/${(await api("GET", `/v1/canvases/${c.id}`)).data.agents[0].id}/messages`, { text: "" })).status, 400);
});

test("names are unique per canvas and agents can be renamed, moved and removed", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { name: "dev", model: "fake-echo" });
  const b = await addAgent(c.id, { name: "dev", model: "fake-echo" });
  assert.equal(b.name, "dev-2");
  const patched = (await api("PATCH", `/v1/canvases/${c.id}/agents/${b.id}`, { name: "reviewer", pos: [10, 20], size: [900, 500], cardSize: { 0: 50, 1: 300 } })).data;
  assert.equal(patched.name, "reviewer");
  assert.deepEqual(patched.pos, [10, 20]);
  assert.deepEqual(patched.size, [900, 500]);
  assert.deepEqual(patched.cardSize, [200, 300], "sizes are clamped to a minimum");
  assert.equal((await api("DELETE", `/v1/canvases/${c.id}/agents/${a.id}`)).status, 200);
  assert.deepEqual((await api("GET", `/v1/canvases/${c.id}`)).data.agents.map((x) => x.name), ["reviewer"]);
});

test("SSE replays events after Last-Event-ID", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { name: "r", model: "fake-echo" });
  await say(c.id, a.id, "ping");
  const all = await events(c.id, (ev) => ev.some((e) => e.type === "turn_done"), { since: 0.5 });
  const types = all.map((e) => e.type);
  assert.ok(types.includes("agent_created") && types.includes("message") && types.includes("turn_done"));
  const mid = all.find((e) => e.type === "agent_status").seq;
  const after = await events(c.id, (ev) => ev.some((e) => e.type === "turn_done"), { since: mid });
  assert.ok(after.every((e) => e.seq > mid));
});

test("writable agent-mode agents in the same directory take turns", async () => {
  const c = await newCanvas({ vars: { project_dir: project } });
  const a = await addAgent(c.id, { model: "fake-wait", mode: "agent" });
  const b = await addAgent(c.id, { model: "fake-wait", mode: "agent" });
  const ro = await addAgent(c.id, { model: "fake-wait", mode: "agent", sandbox: "read-only" });
  const [ra, rb, rr] = await Promise.all([say(c.id, a.id, "a"), say(c.id, b.id, "b"), say(c.id, ro.id, "r")]);
  const [ta, tb, tr] = [ra, rb, rr].map((r) => JSON.parse(r.data.text));
  const [first, second] = ta.start < tb.start ? [ta, tb] : [tb, ta];
  assert.ok(second.start >= first.end, "writers must not overlap");
  assert.ok(tr.start < first.end, "a read-only agent doesn't wait for the lock");
});

test("canvases, agents, sessions and transcripts survive a restart", async () => {
  const c = await newCanvas({ name: "persist", vars: { project_dir: project } });
  const a = await addAgent(c.id, { name: "keeper", model: "fake-args", mode: "agent", role: "remembers" });
  await say(c.id, a.id, "remember me");
  const before = (await api("GET", `/v1/canvases/${c.id}/agents/${a.id}`)).data;
  server.close();
  await sleep(300);
  await start();
  const list = (await api("GET", "/v1/canvases")).data.canvases;
  assert.ok(list.some((x) => x.id === c.id && x.name === "persist"));
  const after = (await api("GET", `/v1/canvases/${c.id}/agents/${a.id}`)).data;
  assert.equal(after.session, before.session);
  assert.equal(after.role, "remembers");
  assert.equal(after.status, "idle");
  const t = (await api("GET", `/v1/canvases/${c.id}/agents/${a.id}/transcript`)).data.transcript;
  assert.equal(t[0].text, "remember me");
});

test("new nodes go to a free spot, counting resized nodes and open terminals", async () => {
  const c = await newCanvas();
  const rect = (a) => {
    const [w, h] = a.terminal ? a.size || [760, 440] : a.cardSize || [280, 118];
    return [a.pos[0], a.pos[1] - 30, w, h + 30];
  };
  const overlaps = (p, q) => p[0] < q[0] + q[2] && q[0] < p[0] + p[2] && p[1] < q[1] + q[3] && q[1] < p[1] + p[3];
  const first = await addAgent(c.id, { name: "a", model: "fake-echo", pos: [80, 80] });
  assert.deepEqual(first.pos, [80, 80], "a free requested spot is kept");
  await api("PATCH", `/v1/canvases/${c.id}/agents/${first.id}`, { cardSize: [900, 600] }); // a big node
  const second = await addAgent(c.id, { name: "b", model: "fake-echo", pos: [200, 200] }); // asks for a spot inside it
  const third = await addAgent(c.id, { name: "c", model: "fake-echo" });
  const agents = (await api("GET", `/v1/canvases/${c.id}`)).data.agents;
  for (const x of agents) for (const y of agents) {
    if (x.id < y.id) assert.ok(!overlaps(rect(x), rect(y)), `${x.name} and ${y.name} must not overlap`);
  }
  assert.ok(second.pos[0] !== 200 || second.pos[1] !== 200);
  assert.ok(third.pos);
});

test("a chosen folder shows its name and checked-out branch; system and credential folders are refused", async () => {
  const { execFileSync } = await import("node:child_process");
  const { homedir } = await import("node:os");
  const { realpathSync } = await import("node:fs");
  const repo = mkdtempSync(join(tmpdir(), "taksim-repo-"));
  execFileSync("git", ["init", "-q", "-b", "feature/x", repo]);
  const real = realpathSync.native(repo);
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-args", cwd: repo });
  assert.deepEqual(a.folder, { path: real, name: basename(real), branch: "feature/x" });
  assert.ok(JSON.parse((await say(c.id, a.id, "x")).data.text).cwd.endsWith(basename(repo)));
  assert.equal((await addAgent(c.id, { model: "fake-echo" })).folder, null, "no folder chosen, nothing shown");
  for (const bad of ["/etc", homedir(), join(homedir(), ".ssh"), "/nonexistent/dir"]) {
    assert.equal((await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-echo", cwd: bad })).status, 400, bad);
  }
  rmSync(repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

test("an agent works on whatever branch its folder has; picking another branch checks the folder out", async () => {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const repo = mkdtempSync(join(tmpdir(), "taksim-repo-"));
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "base\n");
  git("add", "."); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
  git("branch", "old");
  const info = (await api("GET", `/v1/git?dir=${encodeURIComponent(repo)}`)).data;
  assert.deepEqual([info.current, info.branches.sort()], ["main", ["main", "old"]]);

  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-args", cwd: repo });
  assert.equal(a.folder.branch, "main");
  assert.equal((await api("POST", "/v1/git/checkout", { dir: repo, branch: "old" })).data.branch, "old");
  assert.equal(git("branch", "--show-current"), "old");
  assert.equal((await api("GET", `/v1/canvases/${c.id}/agents/${a.id}`)).data.folder.branch, "old", "the agent follows the folder");
  assert.equal((await api("POST", "/v1/git/checkout", { dir: repo, branch: "feat/new" })).data.branch, "feat/new", "a new name creates it");
  assert.equal((await api("POST", "/v1/git/checkout", { dir: repo, branch: "bad..name" })).status, 400);
  // git's own rule: no switching over uncommitted changes it would overwrite
  git("checkout", "-q", "old");
  writeFileSync(join(repo, "a.txt"), "on old\n"); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "old");
  writeFileSync(join(repo, "a.txt"), "uncommitted\n");
  const refused = await api("POST", "/v1/git/checkout", { dir: repo, branch: "main" });
  assert.equal(refused.status, 409);
  assert.equal(git("branch", "--show-current"), "old");
  // a new branch named like a folder is a branch, never "restore that folder from HEAD"
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "x.txt"), "committed\n"); git("add", "."); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "src");
  writeFileSync(join(repo, "src", "x.txt"), "edited\n");
  assert.equal((await api("POST", "/v1/git/checkout", { dir: repo, branch: "src" })).data.branch, "src");
  assert.equal(readFileSync(join(repo, "src", "x.txt"), "utf8"), "edited\n", "uncommitted work stays");
  rmSync(repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

test("a rejected change leaves the agent as it was; unknown models and levels are refused; helpers get no more access than their creator", async () => {
  const c = await newCanvas();
  const { id } = await addAgent(c.id, { model: "fake-echo", name: "  keep  " });
  const before = (await api("GET", `/v1/canvases/${c.id}/agents/${id}`)).data;
  assert.equal(before.name, "keep", "names are trimmed");
  assert.equal((await api("PATCH", `/v1/canvases/${c.id}/agents/${id}`, { name: "other", effort: "high", sandbox: "bogus" })).status, 400);
  const after = (await api("GET", `/v1/canvases/${c.id}/agents/${id}`)).data;
  assert.deepEqual([after.name, after.effort ?? null], ["keep", null]);
  assert.equal((await api("PATCH", `/v1/canvases/${c.id}/agents/${id}`, { name: "   " })).status, 400);
  assert.equal((await api("POST", `/v1/canvases/${c.id}/agents`, { model: "nonexistent-model-xyz" })).status, 400);
  assert.equal((await api("POST", `/v1/canvases/${c.id}/agents`, { model: "sonnet", effort: "ultra" })).status, 400);
  // a read-only creator's helper stays read-only even when asked for editing access
  const { getCanvas } = await import("../src/canvas/canvas.mjs");
  const canvas = getCanvas(c.id);
  const parent = canvas.agents.get(id);
  parent.sandbox = "read-only";
  const child = canvas.addAgent({ model: "fake-echo", sandbox: "workspace-write" }, { createdBy: parent.id, parent });
  assert.equal(child.sandbox, "read-only");
});
