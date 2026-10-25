// The IDE dock: files inside the agent's folder only, saving with conflict checks, search, git, notes,
// the watcher and the agent's tools.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, realpathSync } from "node:fs";
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

const project = realpathSync.native(mkdtempSync(join(tmpdir(), "taksim-ide-")));
const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "taksim-out-")));
mkdirSync(join(project, "src"));
mkdirSync(join(project, "node_modules", "dep"), { recursive: true });
writeFileSync(join(project, "src", "app.py"), "def main():\n    return compute(41)\n\n\ndef compute(x):\n    return x + 1\n");
writeFileSync(join(project, "README.md"), "# demo\n");
writeFileSync(join(project, "node_modules", "dep", "index.js"), "compute\n");
writeFileSync(join(outside, "secret.txt"), "nope\n");
symlinkSync(outside, join(project, "escape"));
execFileSync("git", ["init", "-q"], { cwd: project });
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "src", "README.md"], { cwd: project });
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: project });

let server, base;
before(async () => {
  server = await startServer({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); for (const d of [home, project, outside]) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); });

async function api(method, path, body) {
  const r = await fetch(base + path, { method, headers: method === "GET" ? {} : { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
async function setup() {
  const c = (await api("POST", "/v1/canvases", { vars: { project_dir: project } })).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-echo" })).data;
  return { c, a, ide: (rest = "") => `/v1/canvases/${c.id}/agents/${a.id}/ide${rest}` };
}
async function tool(cid, aid, name, args = {}) {
  const token = getCanvas(cid).agents.get(aid).token;
  const r = await (await fetch(`${base}/mcp/${token}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json();
  return { error: !!r.result.isError, text: r.result.content[0].text };
}
const enc = encodeURIComponent;

test("exec sessions run an explicit command in a PTY the page can attach to", async () => {
  const { c, a, ide } = await setup();
  await api("POST", ide(), {});
  const s = (await api("POST", ide("/sessions"), { kind: "exec", args: ["echo", "pod-shell"], title: "pod" })).data;
  assert.equal(s.kind, "exec");
  assert.equal(s.title, "pod");
  assert.ok(["running", "exited"].includes(s.status));
  const list = (await api("GET", ide("/sessions"))).data.sessions;
  assert.ok(list.some((x) => x.id === s.id && x.kind === "exec"));
  assert.equal((await api("POST", ide("/sessions"), { kind: "exec" })).status, 400);
  assert.equal((await api("POST", ide("/sessions"), { kind: "exec", args: [] })).status, 400);
  assert.equal((await api("POST", ide("/sessions"), { kind: "nope" })).status, 400);
  assert.equal((await api("POST", ide(`/sessions/${s.id}/stop`), {})).status, 200);
  assert.equal((await api("DELETE", ide(`/sessions/${s.id}`))).status, 200);
  assert.equal((await api("GET", ide("/sessions"))).data.sessions.some((x) => x.id === s.id), false);
  await api("DELETE", `/v1/canvases/${c.id}`);
});

test("IDE tools are listed, read-only for plan mode, and in the system prompt", async () => {
  const { c, a } = await setup();
  const token = getCanvas(c.id).agents.get(a.id).token;
  const list = await (await fetch(`${base}/mcp/${token}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json();
  for (const n of ["ide_open", "ide_note", "ide_close"]) assert.equal(list.result.tools.find((t) => t.name === n)?.annotations?.readOnlyHint, true, n);
  assert.match(getCanvas(c.id).agents.get(a.id).systemPrompt(), /ide_open/);
});

test("ide_open opens tabs at a line; bad paths are refused and leave no IDE", async () => {
  const { c, a, ide } = await setup();
  assert.match((await tool(c.id, a.id, "ide_open", { path: "nope.py" })).text, /no such file/);
  assert.equal((await api("GET", ide())).data, null);
  const events = [];
  getCanvas(c.id).bus.subs.add((ev) => ev.type === "ide_updated" && events.push(ev.data));
  const r = await tool(c.id, a.id, "ide_open", { path: join(project, "src/app.py"), line: 5, end_line: 6, files: ["./README.md"] });
  assert.equal(r.error, false);
  const v = (await api("GET", ide())).data;
  assert.deepEqual(v.tabs, ["README.md", "src/app.py"]);
  assert.equal(v.active, "src/app.py");
  assert.equal(v.root, project);
  assert.deepEqual({ ...events.at(-1).reveal, at: 0 }, { path: "src/app.py", line: 5, endLine: 6, at: 0 });
  assert.ok((await api("GET", `/v1/canvases/${c.id}/agents/${a.id}`)).data.ide.tabs.length === 2);
  await tool(c.id, a.id, "ide_close");
  assert.equal((await api("GET", ide())).data, null);
});

test("files stay inside the agent's folder", async () => {
  const { ide } = await setup();
  for (const p of ["../etc/passwd", "/etc/passwd", "escape/secret.txt"]) {
    const r = await api("GET", ide(`/file?path=${enc(p)}`));
    assert.equal(r.status, 400, p);
  }
  assert.equal((await api("PUT", ide("/file"), { path: "escape/new.txt", content: "x" })).status, 400);
  // an absolute path inside the project is fine, and becomes relative
  assert.equal((await api("GET", ide(`/file?path=${enc(join(project, "README.md"))}`))).status, 200);
  assert.equal((await api("PUT", ide("/file"), { path: ".git/config", content: "x" })).status, 403);
});

test("tree, read, save with conflict detection, create, move, delete", async () => {
  const { ide } = await setup();
  const tree = (await api("GET", ide("/tree"))).data.entries;
  assert.deepEqual(tree.filter((e) => e.dir).map((e) => [e.name, e.excluded]), [["escape", false], ["node_modules", true], ["src", false]]);
  assert.deepEqual((await api("GET", ide("/tree?path=src"))).data.entries.map((e) => e.path), ["src/app.py"]);

  const f = (await api("GET", ide(`/file?path=${enc("src/app.py")}`))).data;
  assert.match(f.content, /def compute/);
  const saved = await api("PUT", ide("/file"), { path: "src/app.py", content: f.content + "# edited\n", mtime: f.mtime });
  assert.equal(saved.status, 200);
  // a save based on the old version is a conflict, and says what the file's time is now
  const stale = await api("PUT", ide("/file"), { path: "src/app.py", content: "lost", mtime: f.mtime - 5000 });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.mtime, saved.data.mtime);
  assert.match(readFileSync(join(project, "src/app.py"), "utf8"), /# edited/);

  assert.equal((await api("POST", ide("/mkdir"), { path: "pkg/sub" })).status, 200);
  assert.equal((await api("PUT", ide("/file"), { path: "pkg/sub/x.py", content: "x = 1\n" })).status, 200);
  assert.equal((await api("POST", ide("/move"), { from: "pkg/sub/x.py", to: "pkg/y.py" })).status, 200);
  assert.equal((await api("GET", ide(`/file?path=${enc("pkg/y.py")}`))).data.content, "x = 1\n");
  assert.equal((await api("DELETE", ide(`/file?path=pkg`))).status, 200);
  assert.equal((await api("GET", ide(`/file?path=${enc("pkg/y.py")}`))).status, 404);
  assert.equal((await api("DELETE", ide(`/file?path=`))).status, 400);
});

test("go to file and find in files skip excluded folders", async () => {
  const { ide } = await setup();
  const files = (await api("GET", ide("/files"))).data.files;
  assert.ok(files.includes("src/app.py") && files.includes("README.md"));
  assert.ok(!files.some((f) => f.startsWith("node_modules/") || f.startsWith(".git/")));
  const found = (await api("GET", ide("/search?q=compute"))).data.results;
  assert.deepEqual(found.map((r) => [r.path, r.line]), [["src/app.py", 2], ["src/app.py", 5]]);
  assert.equal(found[1].text, "def compute(x):");
  assert.deepEqual((await api("GET", ide(`/search?q=${enc("def \\w+\\(x\\)")}&regex=1`))).data.results.map((r) => r.line), [5]);
});

test("git: changed files and the committed version", async () => {
  const { ide } = await setup();
  writeFileSync(join(project, "README.md"), "# demo\nchanged\n");
  writeFileSync(join(project, "new.txt"), "n\n");
  const st = (await api("GET", ide("/git"))).data;
  assert.ok(st.branch);
  const by = Object.fromEntries(st.files.map((f) => [f.path, f.status]));
  assert.equal(by["README.md"], "modified");
  assert.equal(by["new.txt"], "untracked");
  assert.equal((await api("GET", ide(`/git?path=README.md`))).data.content, "# demo\n");
  assert.equal((await api("GET", ide(`/git?path=new.txt`))).data.content, "");
  execFileSync("git", ["checkout", "-q", "README.md"], { cwd: project });
  rmSync(join(project, "new.txt"));
});

test("the fast model writes a commit message for the chosen change", async () => {
  const { ide } = await setup();
  writeFileSync(join(project, "README.md"), "# demo\nchanged\n");
  const r = await api("POST", ide("/commit-message"), { files: ["README.md"] });
  assert.equal(r.status, 200);
  assert.equal(r.data.message, "fake: describe the change");
  assert.equal(r.data.by, "fake-commit");
  // nothing to describe: an untouched file, or a path git doesn't know
  writeFileSync(join(project, "clean.txt"), "ok\n");
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "clean.txt"], { cwd: project });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "clean"], { cwd: project });
  assert.equal((await api("POST", ide("/commit-message"), { files: ["clean.txt"] })).status, 400);
  assert.equal((await api("POST", ide("/commit-message"), { files: ["nope.txt"] })).status, 400);
  execFileSync("git", ["checkout", "-q", "README.md"], { cwd: project });
});

test("a file outside a repository has no commit message to write", async () => {
  const c = (await api("POST", "/v1/canvases", { vars: { project_dir: outside } })).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-echo" })).data;
  assert.equal((await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/ide/commit-message`, {})).status, 400);
});

test("ide_note marks lines, opens the file, and can be cleared", async () => {
  const { c, a, ide } = await setup();
  assert.match((await tool(c.id, a.id, "ide_note", { path: "src/app.py", line: 2, text: "off by one?", severity: "warning" })).text, /Noted src\/app.py:2/);
  const v = (await api("GET", ide())).data;
  assert.deepEqual(v.tabs, ["src/app.py"]);
  assert.deepEqual(v.notes.map((n) => [n.path, n.line, n.endLine, n.severity, n.text]), [["src/app.py", 2, 2, "warning", "off by one?"]]);
  await tool(c.id, a.id, "ide_note", { path: "README.md", line: 1, text: "title", severity: "bogus" });
  assert.equal((await api("GET", ide())).data.notes[1].severity, "info");
  assert.equal((await api("DELETE", ide(`/notes?path=README.md`))).data.removed, 1);
  assert.match((await tool(c.id, a.id, "ide_note", { clear: true })).text, /Removed 1/);
});

test("the watcher tells the page which files changed; it stops with the agent", async () => {
  const { c, a, ide } = await setup();
  await api("POST", ide(), { path: "README.md" });
  const seen = [];
  getCanvas(c.id).bus.subs.add((ev) => ev.type === "ide_files" && seen.push(...ev.data.paths));
  await sleep(200);
  writeFileSync(join(project, "src", "app.py"), readFileSync(join(project, "src", "app.py"), "utf8"));
  writeFileSync(join(project, "node_modules", "dep", "index.js"), "ignored\n");
  const end = Date.now() + 4000;
  while (!seen.includes("src/app.py") && Date.now() < end) await sleep(50);
  assert.ok(seen.includes("src/app.py"), `saw ${seen}`);
  assert.ok(!seen.some((p) => p.startsWith("node_modules")));
  const agent = getCanvas(c.id).agents.get(a.id);
  const ideObj = agent.ide;
  await api("DELETE", `/v1/canvases/${c.id}/agents/${a.id}`);
  assert.equal(ideObj.watcher, null);
});

test("the IDE's tabs and layout are saved with the canvas", async () => {
  const { c, a, ide } = await setup();
  await api("POST", ide(), { files: ["README.md", "src/app.py"] });
  await api("PATCH", ide(), { active: "README.md", ui: { tree: false, bottom: "git", size: [1000, 600] } });
  const saved = JSON.parse(JSON.stringify(getCanvas(c.id).toJSON())).agents.find((x) => x.id === a.id).ide;
  assert.equal(saved.active, "README.md");
  assert.deepEqual(saved.ui, { collapsed: false, maximized: false, size: [1000, 600], tree: false, left: "project", bottom: "git" });
  // the IDE counts in the room the node takes, so new agents don't land under it
  const fp = getCanvas(c.id).footprintOf(getCanvas(c.id).agents.get(a.id));
  assert.ok(fp[2] > 1000);
});

test("ide_note with code lands on the line that has it, whatever line number came with it", async () => {
  const { c, a, ide } = await setup();
  const r = await tool(c.id, a.id, "ide_note", { path: "src/app.py", line: 2, text: "here", code: "def compute(x):" });
  assert.match(r.text, /Noted src\/app.py:5 .*Moved \+3 lines/);
  await tool(c.id, a.id, "ide_note", { path: "src/app.py", line: 6, end_line: 7, text: "right already", code: "return x + 1" });
  assert.deepEqual((await api("GET", ide())).data.notes.map((n) => [n.line, n.endLine]), [[5, 5], [6, 7]]);
});

test("folders aren't files: ide_open and ide_note refuse them and leave no empty tab", async () => {
  const { c, a, ide } = await setup();
  assert.match((await tool(c.id, a.id, "ide_open", { path: "src" })).text, /is a folder/);
  assert.match((await tool(c.id, a.id, "ide_open", { path: "." })).text, /is a folder/);
  assert.equal((await api("POST", ide(), { path: "." })).status, 400);
  await api("POST", ide(), { path: "README.md" });
  assert.match((await tool(c.id, a.id, "ide_note", { path: "src", text: "x" })).text, /is a folder/);
  await api("PATCH", ide(), { tabs: ["README.md", ""] });
  assert.deepEqual((await api("GET", ide())).data.tabs, ["README.md"]);
});

test("a note past the end lands on the last line; clearing takes the path however it's written", async () => {
  const { c, a, ide } = await setup();
  await tool(c.id, a.id, "ide_note", { path: "src/app.py", line: 40, end_line: 90, text: "end" });
  const lines = readFileSync(join(project, "src", "app.py"), "utf8").split("\n").length;
  assert.deepEqual((await api("GET", ide())).data.notes.map((n) => [n.line, n.endLine]), [[lines, lines]]);
  assert.match((await tool(c.id, a.id, "ide_note", { path: join(project, "src", "app.py"), clear: true })).text, /Removed 1/);
});

test("a commit made outside the IDE tells the page to recolor its changed files", async () => {
  const { c, a, ide } = await setup();
  await api("POST", ide(), { path: "README.md" });
  const seen = [];
  getCanvas(c.id).bus.subs.add((ev) => ev.type === "ide_files" && seen.push(ev.data));
  await sleep(200);
  writeFileSync(join(project, "README.md"), "# demo\nmore\n");
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "more"], { cwd: project });
  const end = Date.now() + 4000;
  while (!seen.some((d) => d.git) && Date.now() < end) await sleep(50);
  assert.ok(seen.some((d) => d.git), JSON.stringify(seen));
  assert.ok(!seen.some((d) => d.paths.some((p) => p.startsWith(".git"))));
  await api("DELETE", ide());
});

test("the IDE has a page of its own, for a window outside the canvas", async () => {
  const { c, a } = await setup();
  const r = await fetch(`${base}/ide/${c.id}/${a.id}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  assert.match(await r.text(), /ide-page\.mjs/);
  assert.equal((await fetch(`${base}/ui/canvas/ide-page.mjs`)).status, 200);
});

test("⌘K: the chosen lines come back rewritten, nothing is written", async () => {
  const { ide } = await setup();
  writeFileSync(join(project, "calc.py"), "def one():\n    return 1\n\n\ndef compute(x):\n    return x + 1\n");
  const r = await api("POST", ide("/edit"), { path: "calc.py", from: 5, to: 6, instruction: "rename" });
  assert.equal(r.status, 200);
  assert.equal(r.data.original, "def compute(x):\n    return x + 1");
  assert.equal(r.data.replacement, "def compute(x):  # edited\n    return x + 1  # edited");
  assert.equal(readFileSync(join(project, "calc.py"), "utf8").includes("# edited"), false);
  assert.equal((await api("POST", ide("/edit"), { path: "calc.py", from: 1, to: 1, instruction: "" })).status, 400);
  assert.equal((await api("POST", ide("/edit"), { path: "../x", from: 1, to: 1, instruction: "a" })).status >= 400, true);
});

test("ask the codebase: only real files and lines come back", async () => {
  const { ide } = await setup();
  const r = await api("POST", ide("/ask"), { question: "where is compute?" });
  assert.equal(r.status, 200);
  assert.equal(r.data.answer, "fake answer");
  assert.deepEqual(r.data.files, ["src/app.py"]);
  assert.deepEqual(r.data.hits, [{ path: "src/app.py", line: 5, endLine: 6, why: "compute lives here" }]);
  assert.equal((await api("POST", ide("/ask"), {})).status, 400);
});

test("review: findings on changed files become notes, a rerun replaces them", async () => {
  const { ide } = await setup();
  writeFileSync(join(project, "rev.py"), "def f():\n    return 1\n");
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "rev.py"], { cwd: project });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "rev"], { cwd: project });
  assert.equal((await api("POST", ide("/review"), { files: ["rev.py"] })).status, 400); // unchanged: nothing to review
  writeFileSync(join(project, "rev.py"), "def f():\n    return 1\n\n\ndef g():\n    return risky()\n");
  const r = await api("POST", ide("/review"), { files: ["rev.py"] });
  assert.equal(r.status, 200);
  assert.equal(r.data.notes.length, 1);
  assert.equal(r.data.notes[0].path, "rev.py");
  assert.equal(r.data.notes[0].line, 5); // the model said 99; the code text moved it
  assert.equal(r.data.notes[0].severity, "error");
  await api("POST", ide("/review"), { files: ["rev.py"] });
  assert.equal((await api("GET", ide())).data.notes.filter((n) => n.source === "review").length, 1);
  execFileSync("git", ["checkout", "--", "rev.py"], { cwd: project });
});

test("project rules: cursor and taksim files are listed and reach the agent's system prompt", async () => {
  const { c, a, ide } = await setup();
  const rules = await import("../src/ide/rules.mjs");
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "taksim-rules-")));
  try {
    assert.equal(rules.projectRules(dir), "");
    writeFileSync(join(dir, ".cursorrules"), "Always use tabs.\n");
    mkdirSync(join(dir, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(dir, ".cursor", "rules", "api.mdc"), "---\ndescription: API style\nglobs: src/api/**\nalwaysApply: false\n---\nUse REST.\n");
    writeFileSync(join(dir, ".cursor", "rules", "all.mdc"), "---\nalwaysApply: true\n---\nBe brief.\n");
    const list = rules.listRules(dir);
    assert.deepEqual(list.map((r) => [r.path, r.always]), [[".cursorrules", true], [".cursor/rules/all.mdc", true], [".cursor/rules/api.mdc", false]]);
    const text = rules.projectRules(dir);
    assert.match(text, /Always use tabs/);
    assert.match(text, /Be brief/);
    assert.doesNotMatch(text, /Use REST/); // a scoped rule is named, not pasted
    assert.match(text, /api\.mdc: API style \(files: src\/api\/\*\*\)/);
    assert.equal(rules.ensureRules(dir), ".cursorrules");
    const fresh = realpathSync.native(mkdtempSync(join(tmpdir(), "taksim-rules2-")));
    assert.equal(rules.ensureRules(fresh), ".taksimrules");
    rmSync(fresh, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
  const g = await api("GET", ide("/rules"));
  assert.deepEqual(g.data.rules, []);
  assert.equal((await api("POST", ide("/rules"), {})).data.path, ".taksimrules");
  assert.equal((await api("GET", ide("/rules"))).data.rules.length, 0); // empty files don't count
  rmSync(join(project, ".taksimrules"), { force: true });
  void c; void a;
});
