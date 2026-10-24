// The IDE's tool windows on the server: Commit (commit, amend, rollback, push), Git log, terminal and run
// sessions, and the Python debugger (breakpoints, stepping, variables, exceptions, the agent's view of it).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const home = mkdtempSync(join(tmpdir(), "taksim-home-"));
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_FAKE = "1";
process.env.TAKSIM_QUIET = "1";
process.env.TAKSIM_OPENCODE_BIN = "/nonexistent/opencode";

const { startServer } = await import("../src/server.mjs");
const { getCanvas } = await import("../src/canvas/canvas.mjs");

const project = realpathSync(mkdtempSync(join(tmpdir(), "taksim-vcs-")));
const remote = realpathSync(mkdtempSync(join(tmpdir(), "taksim-remote-")));
const g = (...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: project }).toString();
mkdirSync(join(project, "pkg"));
writeFileSync(join(project, "a.txt"), "one\n");
writeFileSync(join(project, "b.txt"), "two\n");
writeFileSync(join(project, "pkg", "calc.py"), [
  "def add(a, b):",
  "    total = a + b",
  "    return total",
  "",
  "",
  "items = [1, 2, 3]",
  "result = add(items[0], 10)",
  "print('result', result)",
  "",
].join("\n"));
writeFileSync(join(project, "pkg", "boom.py"), "def f(x):\n    return 10 / x\n\n\nprint(f(0))\n");
execFileSync("git", ["init", "-q", "--bare", remote]);
g("init", "-q", "-b", "main");
g("add", ".");
g("commit", "-qm", "init");
g("remote", "add", "origin", remote);

let server, base;
before(async () => {
  server = await startServer({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); for (const d of [home, project, remote]) rmSync(d, { recursive: true, force: true }); });

async function api(method, path, body) {
  const r = await fetch(base + path, { method, headers: method === "GET" ? {} : { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
async function until(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(50);
  }
}
async function setup() {
  const c = (await api("POST", "/v1/canvases", { vars: { project_dir: project } })).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-echo" })).data;
  const ide = (rest = "") => `/v1/canvases/${c.id}/agents/${a.id}/ide${rest}`;
  await api("POST", ide(), {});
  return { c, a, ide, agent: getCanvas(c.id).agents.get(a.id) };
}

test("commit only the chosen files, amend, then push to a new upstream", async () => {
  const { ide } = await setup();
  writeFileSync(join(project, "a.txt"), "one\nmore\n");
  writeFileSync(join(project, "b.txt"), "two\nmore\n");
  writeFileSync(join(project, "new.txt"), "new\n");
  assert.equal((await api("POST", ide("/commit"), { files: ["a.txt", "new.txt"], message: "  " })).status, 400);
  const r = await api("POST", ide("/commit"), { files: ["a.txt", "new.txt"], message: "Update a, add new" });
  assert.equal(r.status, 200);
  assert.equal(r.data.subject, "Update a, add new");
  const st = Object.fromEntries((await api("GET", ide("/git"))).data.files.map((f) => [f.path, f.status]));
  assert.deepEqual(st, { "b.txt": "modified" }, "b.txt was left out");

  const amend = await api("POST", ide("/commit"), { files: ["b.txt"], message: "Update a and b, add new", amend: true });
  assert.equal(amend.data.subject, "Update a and b, add new");
  assert.equal(g("rev-list", "--count", "HEAD").trim(), "2", "amended, not a new commit");

  const pushed = await api("POST", ide("/push"));
  assert.equal(pushed.status, 200, JSON.stringify(pushed.data));
  assert.equal(execFileSync("git", ["log", "-1", "--pretty=%s", "main"], { cwd: remote }).toString().trim(), "Update a and b, add new");
  assert.equal((await api("POST", ide("/commit"), { files: ["--all"], message: "x" })).status, 400, "no options as paths");
});

test("git log, a commit's files, and a file as of a commit", async () => {
  const { ide } = await setup();
  const commits = (await api("GET", ide("/log"))).data.commits;
  assert.ok(commits.length >= 2);
  assert.equal(commits.at(-1).subject, "init");
  const shown = (await api("GET", ide(`/show?hash=${commits[0].hash}`))).data;
  assert.deepEqual(shown.files.map((f) => [f.path, f.status]).sort(), [["a.txt", "modified"], ["b.txt", "modified"], ["new.txt", "added"]]);
  assert.equal((await api("GET", ide(`/rev?rev=${commits[0].hash}^&path=a.txt`))).data.content, "one\n");
  assert.equal((await api("GET", ide(`/rev?rev=${commits[0].hash}^&path=new.txt`))).data.content, "");
  assert.equal((await api("GET", ide(`/rev?rev=${enc("HEAD;rm")}&path=a.txt`))).status, 400);
});
const enc = encodeURIComponent;

test("rollback restores tracked files and deletes new ones", async () => {
  const { ide } = await setup();
  writeFileSync(join(project, "a.txt"), "scribbled\n");
  writeFileSync(join(project, "junk.txt"), "junk\n");
  const r = await api("POST", ide("/rollback"), { files: ["a.txt", "junk.txt"] });
  assert.deepEqual(r.data, { restored: 1, deleted: 1 });
  assert.equal(readFileSync(join(project, "a.txt"), "utf8"), "one\nmore\n");
  assert.equal(existsSync(join(project, "junk.txt")), false);
});

test("stage and unstage move files in and out of the index; delete removes them from disk", async () => {
  const { ide } = await setup();
  writeFileSync(join(project, "a.txt"), "staged edit\n");
  writeFileSync(join(project, "fresh.txt"), "fresh\n");
  const staged = async () => Object.fromEntries((await api("GET", ide("/git"))).data.files.map((f) => [f.path, f.staged]));
  await api("POST", ide("/stage"), { files: ["a.txt", "fresh.txt"] });
  assert.deepEqual(await staged(), { "a.txt": true, "fresh.txt": true });
  await api("POST", ide("/unstage"), { files: ["a.txt", "fresh.txt"] });
  assert.deepEqual(await staged(), { "a.txt": false, "fresh.txt": false });
  await api("POST", ide("/delete"), { files: ["fresh.txt"] });
  assert.equal(existsSync(join(project, "fresh.txt")), false);
  assert.equal((await api("POST", ide("/delete"), { files: ["-rf"] })).status, 400);
  await api("POST", ide("/rollback"), { files: ["a.txt"] });
});

test("a terminal runs a shell in the agent's folder; a run session runs the file", async () => {
  const { ide, agent } = await setup();
  const t = (await api("POST", ide("/sessions"), { kind: "terminal" })).data;
  assert.equal(t.kind, "terminal");
  const term = agent.ide.sessions.list.get(t.id).term;
  term.input("echo here-$((40+2)) && pwd\r");
  await until(() => term.tail.includes("here-42") && term.tail.includes(project));

  const r = (await api("POST", ide("/sessions"), { kind: "run", path: "pkg/calc.py" })).data;
  assert.equal(r.title, "calc.py");
  const run = agent.ide.sessions.list.get(r.id);
  await until(() => run.status === "exited");
  assert.match(run.term.tail, /result 11/);
  assert.equal(run.exitCode, 0);
  assert.equal((await api("POST", ide("/sessions"), { kind: "run", path: "a.txt" })).status, 400);
  await api("DELETE", ide(`/sessions/${t.id}`));
  assert.equal(agent.ide.sessions.list.has(t.id), false);
});

test("the debugger stops at a breakpoint, shows variables, steps and runs to the end", async () => {
  const { c, a, ide, agent } = await setup();
  await api("PATCH", ide(), { breakpoints: { "pkg/calc.py": [2] } });
  const s = (await api("POST", ide("/sessions"), { kind: "debug", path: "pkg/calc.py" })).data;
  const sess = agent.ide.sessions.list.get(s.id);
  const dbg = (cmd, args = {}) => api("POST", ide(`/sessions/${s.id}/debug`), { cmd, ...args });

  await until(() => sess.debug.state.status === "paused");
  let st = sess.debug.state;
  assert.equal(st.reason, "breakpoint");
  assert.deepEqual(st.frames.map((f) => [f.path, f.line, f.name]), [["pkg/calc.py", 2, "add"], ["pkg/calc.py", 7, "<module>"]]);
  assert.deepEqual(st.variables.map((v) => [v.name, v.value]), [["a", "1"], ["b", "10"]]);

  // the module frame: its variables, and a list that opens
  const mod = (await dbg("frame", { index: 1 })).data.variables;
  const items = mod.find((v) => v.name === "items");
  assert.equal(items.value, "[1, 2, 3]");
  assert.deepEqual((await dbg("expand", { ref: items.ref })).data.variables.map((v) => [v.name, v.value]), [["[0]", "1"], ["[1]", "2"], ["[2]", "3"]]);
  assert.equal((await dbg("evaluate", { expr: "a * 100 + b", frame: 0 })).data.result.value, "110");
  assert.match((await dbg("evaluate", { expr: "nope", frame: 0 })).data.error.message, /NameError/);

  await dbg("frame", { index: 0 }); // back to the top frame
  // the agent sees the same thing
  const token = agent.token;
  const r = await (await fetch(`${base}/mcp/${token}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ide_debug_state", arguments: {} } }) })).json();
  const seen = JSON.parse(r.result.content[0].text);
  assert.equal(seen.frame, "pkg/calc.py:2 in add");
  assert.equal(seen.variables.a, "1  (int)");
  assert.match(seen.code, /→    2      total = a \+ b/);

  await dbg("next");
  await until(() => sess.debug.state.status === "paused" && sess.debug.state.frames[0].line === 3);
  assert.equal(sess.debug.state.variables.find((v) => v.name === "total").value, "11");
  await dbg("return"); // step out, back in the module
  await until(() => sess.debug.state.status === "paused" && sess.debug.state.frames[0].name === "<module>");

  // a breakpoint added while paused is hit; then run to the end
  await api("PATCH", ide(), { breakpoints: { "pkg/calc.py": [2, 8] } });
  await dbg("continue");
  await until(() => sess.debug.state.status === "paused" && sess.debug.state.frames[0].line === 8);
  await dbg("continue");
  await until(() => sess.status === "exited");
  assert.equal(sess.debug.state.status, "ended");
  assert.match(sess.term.tail, /result 11/);
  assert.equal((await dbg("next")).status, 409);
  void c; void a;
});

test("an uncaught exception stops where it happened", async () => {
  const { ide, agent } = await setup();
  await api("PATCH", ide(), { breakpoints: {} });
  const s = (await api("POST", ide("/sessions"), { kind: "debug", path: "pkg/boom.py" })).data;
  const sess = agent.ide.sessions.list.get(s.id);
  await until(() => sess.debug.state.status === "paused");
  const st = sess.debug.state;
  assert.equal(st.reason, "exception");
  assert.match(st.exception, /ZeroDivisionError/);
  assert.deepEqual([st.frames[0].path, st.frames[0].line, st.frames[0].name], ["pkg/boom.py", 2, "f"]);
  assert.deepEqual(st.variables.map((v) => [v.name, v.value]), [["x", "0"]]);
  await api("POST", ide(`/sessions/${s.id}/debug`), { cmd: "stop" });
  await until(() => sess.status === "exited");
});

test("closing the IDE stops its processes", async () => {
  const { ide, agent } = await setup();
  const t = (await api("POST", ide("/sessions"), { kind: "terminal" })).data;
  const term = agent.ide.sessions.list.get(t.id).term;
  await api("DELETE", ide());
  await until(() => term.exited);
});
