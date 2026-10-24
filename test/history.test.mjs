// Past conversations: a removed agent or a closed canvas keeps what was said, findable by its words, and
// continues on any canvas with its transcript and session.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "taksim-home-"));
const project = mkdtempSync(join(tmpdir(), "taksim-project-"));
const claudeHome = mkdtempSync(join(tmpdir(), "taksim-claude-"));
const cliHomes = Object.fromEntries(["codex", "copilot", "gemini"].map((c) => [c, mkdtempSync(join(tmpdir(), `taksim-${c}-`))]));
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_CLAUDE_HOME = claudeHome;
// the CLIs' own sessions are read from these, never from the computer's
process.env.TAKSIM_CODEX_HOME = cliHomes.codex;
process.env.TAKSIM_COPILOT_HOME = cliHomes.copilot;
process.env.TAKSIM_GEMINI_HOME = cliHomes.gemini;
process.env.TAKSIM_HISTORY_TEMP = "1"; // the test projects live in the temporary folder, which is left out otherwise
process.env.TAKSIM_FAKE = "1";
process.env.TAKSIM_QUIET = "1";
process.env.TAKSIM_OPENCODE_BIN = "/nonexistent/opencode";

const { startServer } = await import("../src/server.mjs");

let server, base;
before(async () => {
  server = await startServer({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); rmSync(claudeHome, { recursive: true, force: true });
  for (const d of Object.values(cliHomes)) rmSync(d, { recursive: true, force: true }); });

async function api(method, path, body) {
  const r = await fetch(base + path, {
    method, headers: method === "GET" ? {} : { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const newCanvas = async () => (await api("POST", "/v1/canvases", {})).data;
const addAgent = async (cid, spec) => (await api("POST", `/v1/canvases/${cid}/agents`, spec)).data;
const say = (cid, aid, text) => api("POST", `/v1/canvases/${cid}/agents/${aid}/messages`, { text, wait: true });
const history = async (q = "") => (await api("GET", `/v1/history${q ? `?q=${encodeURIComponent(q)}` : ""}`)).data.conversations;
const transcript = async (cid, aid) => (await api("GET", `/v1/canvases/${cid}/agents/${aid}/transcript`)).data.transcript;

test("a removed agent's conversation is kept, found by its words, and continued on another canvas", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-echo", name: "Planner", cwd: project });
  await say(c.id, a.id, "plan the pelican migration");
  const quiet = await addAgent(c.id, { model: "fake-echo", name: "Quiet" });
  await api("DELETE", `/v1/canvases/${c.id}/agents/${a.id}`);
  await api("DELETE", `/v1/canvases/${c.id}/agents/${quiet.id}`);

  const [kept, ...rest] = (await history()).filter((c) => !c.source);
  assert.equal(rest.length, 0, "an agent nobody talked to leaves nothing behind");
  assert.equal(kept.id, a.id);
  assert.equal(kept.title, "plan the pelican migration");
  assert.equal(kept.name, "Planner");
  assert.equal(kept.folder, project.split("/").pop());
  assert.equal((await history("pelican")).length, 1, "found by its title");
  assert.equal((await history("echo:")).length, 1, "found by what was answered");
  assert.equal((await history("albatross")).length, 0);

  const other = await newCanvas();
  const back = await api("POST", `/v1/canvases/${other.id}/history/${a.id}`, { pos: [100, 100] });
  assert.equal(back.status, 201);
  assert.equal(back.data.name, "Planner");
  assert.equal(back.data.cwd, realpathSync(project));
  assert.ok((await transcript(other.id, back.data.id)).some((e) => e.text === "plan the pelican migration"), "its conversation came with it");
  assert.equal((await say(other.id, back.data.id, "go on")).status, 200);
  assert.equal((await history()).filter((c) => c.id === a.id).length, 0, "continued: no longer in the history");
  assert.equal((await api("POST", `/v1/canvases/${other.id}/history/${a.id}`, {})).status, 404);
});

test("closing a canvas keeps its conversations; one run in its scratch folder starts a seeded session", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-echo", name: "Scratch" });
  await say(c.id, a.id, "draft the release notes");
  await api("DELETE", `/v1/canvases/${c.id}`);
  const [kept] = await history("release notes");
  assert.equal(kept?.canvas?.id, c.id);

  const other = await newCanvas();
  const back = (await api("POST", `/v1/canvases/${other.id}/history/${kept.id}`, {})).data;
  assert.equal(back.session, null, "the scratch folder is gone: its session can't be resumed there");
  assert.equal(back.seedHistory, true);
});

test("a past conversation can be deleted for good", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-echo" });
  await say(c.id, a.id, "forget me");
  await api("DELETE", `/v1/canvases/${c.id}/agents/${a.id}`);
  assert.equal((await api("DELETE", `/v1/history/${a.id}`)).status, 200);
  assert.equal((await history("forget me")).length, 0);
  assert.equal((await api("DELETE", `/v1/history/${a.id}`)).status, 404);
});

test("a conversation begun in Claude Code is listed and continued here: same folder, same session, its chat filled", async () => {
  const dir = join(claudeHome, "projects", "-tmp-proj");
  mkdirSync(dir, { recursive: true });
  const line = (o) => JSON.stringify({ cwd: project, sessionId: "5e55-1011", timestamp: "2026-10-20T10:00:00Z", ...o });
  writeFileSync(join(dir, "5e55-1011.jsonl"), [
    line({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" }, isMeta: true }),
    line({ type: "user", message: { role: "user", content: "rename the walrus module" } }),
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "Looking at it." }] } }),
    line({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Renamed." }] } }),
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "side" }] }, isSidechain: true }),
    JSON.stringify({ type: "custom-title", customTitle: "Walrus rename", sessionId: "5e55-1011" }),
  ].join("\n") + "\n");
  // one of taksim's own runs (its scratch folders live under its home) isn't listed
  writeFileSync(join(dir, "own-run.jsonl"), JSON.stringify({ type: "user", cwd: join(home, "canvases", "x"), message: { role: "user", content: "internal" } }) + "\n");

  const [cc, ...more] = (await history()).filter((c) => c.source === "claude");
  assert.equal(more.length, 0);
  assert.equal(cc.id, "cc-5e55-1011");
  assert.equal(cc.title, "Walrus rename");
  assert.equal(cc.lastText, "Renamed.");
  assert.equal((await history("walrus module")).length, 1, "found by what was said in it");

  const c = await newCanvas();
  const back = await api("POST", `/v1/canvases/${c.id}/history/${cc.id}`, {});
  assert.equal(back.status, 201);
  assert.equal(back.data.session, "5e55-1011");
  assert.equal(back.data.cwd, realpathSync(project));
  const t = await transcript(c.id, back.data.id);
  assert.deepEqual(t.map((e) => [e.from === "user" ? "user" : "agent", e.text]), [["user", "rename the walrus module"], ["agent", "Looking at it.\n\nRenamed."]]);
  assert.equal((await history()).filter((x) => x.id === cc.id).length, 0, "held by an agent now: not listed twice");
});

test("an agent nobody named is named by its first request; a name given, or changed, stays", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-echo" });
  await say(c.id, a.id, "fix the flaky checkout test on CI please");
  const view = async (id) => (await api("GET", `/v1/canvases/${c.id}/agents/${id}`)).data;
  assert.equal((await view(a.id)).name, "Fix the flaky checkout test");
  await say(c.id, a.id, "and the other one");
  assert.equal((await view(a.id)).name, "Fix the flaky checkout test", "only the first request names it");
  const named = await addAgent(c.id, { model: "fake-echo", name: "Reviewer" });
  await say(c.id, named.id, "look at this");
  assert.equal((await view(named.id)).name, "Reviewer");
  const renamed = await addAgent(c.id, { model: "fake-echo" });
  await api("PATCH", `/v1/canvases/${c.id}/agents/${renamed.id}`, { name: "Mine" });
  await say(c.id, renamed.id, "something else");
  assert.equal((await view(renamed.id)).name, "Mine");
});

test("a canvas the system named takes its first request's folder, else its words; a typed name stays", async () => {
  const own = mkdtempSync(join(tmpdir(), "taksim-shop-"));
  const auto = (await api("POST", "/v1/canvases", { name: "canvas 4", autoName: true })).data;
  const a = await addAgent(auto.id, { model: "fake-echo", cwd: own, name: "Worker" });
  await say(auto.id, a.id, "tidy up the build scripts");
  const nameOf = async (id) => (await api("GET", `/v1/canvases/${id}`)).data.name;
  assert.equal(await nameOf(auto.id), own.split("/").pop(), "the project it works in");
  await say(auto.id, a.id, "and something else");
  assert.equal(await nameOf(auto.id), own.split("/").pop(), "only once");
  // another canvas on the same project: its name would repeat a tab, so its words name it
  const twin = (await api("POST", "/v1/canvases", {})).data;
  const t = await addAgent(twin.id, { model: "fake-echo", cwd: own });
  await say(twin.id, t.id, "review the checkout flow");
  assert.equal(await nameOf(twin.id), "Review the checkout flow");
  rmSync(own, { recursive: true, force: true });

  const loose = (await api("POST", "/v1/canvases", { name: "canvas 5", autoName: true })).data;
  const b = await addAgent(loose.id, { model: "fake-echo" });
  await say(loose.id, b.id, "draft a polite reply to the landlord about the heating");
  assert.equal(await nameOf(loose.id), "Draft a polite reply", "no folder: its first words, without a dangling 'to'");

  const typed = (await api("POST", "/v1/canvases", { name: "ops" })).data;
  const c = await addAgent(typed.id, { model: "fake-echo" });
  await say(typed.id, c.id, "check the disks");
  assert.equal(await nameOf(typed.id), "ops");

  const renamed = (await api("POST", "/v1/canvases", { name: "canvas 6", autoName: true })).data;
  await api("PUT", `/v1/canvases/${renamed.id}`, { name: "mine" });
  const d = await addAgent(renamed.id, { model: "fake-echo" });
  await say(renamed.id, d.id, "hello there");
  assert.equal(await nameOf(renamed.id), "mine");
});

test("Codex, Copilot and Gemini sessions in a folder are listed with Claude's, and continue in their own CLI", async () => {
  const proj = mkdtempSync(join(tmpdir(), "taksim-shared-"));
  // Codex: a rollout with its meta, the CLI's own context as a user message, then the request and the answer
  const cx = join(cliHomes.codex, "sessions", "2026", "10", "20");
  mkdirSync(cx, { recursive: true });
  const ts = "2026-10-20T09:00:00Z";
  writeFileSync(join(cx, "rollout-2026-10-20T09-00-00-0c0de000-0000-0000-0000-000000000001.jsonl"), [
    { type: "session_meta", timestamp: ts, payload: { id: "0c0de000-0000-0000-0000-000000000001", cwd: proj, timestamp: ts } },
    { type: "response_item", timestamp: ts, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
    // the Codex app's attachments come before the request
    { type: "response_item", timestamp: ts, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# Files mentioned by the user:\n\n## notes.pdf: /x/notes.pdf\n\n## My request:\nport the parser to rust" }] } },
    { type: "response_item", timestamp: ts, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Ported." }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  // Copilot: a session folder
  const cp = join(cliHomes.copilot, "session-state", "c0b1-0002");
  mkdirSync(cp, { recursive: true });
  writeFileSync(join(cp, "workspace.yaml"), `id: c0b1-0002\ncwd: ${proj}\nuser_named: false\ncreated_at: ${ts}\n`);
  writeFileSync(join(cp, "events.jsonl"), [
    { type: "user.message", timestamp: ts, data: { content: "add a dark mode toggle" } },
    { type: "assistant.message", timestamp: ts, data: { content: "", toolRequests: [] } },
    { type: "assistant.message", timestamp: ts, data: { content: "Added the toggle." } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  // Gemini: a chat file under its project hash, the folder in .project_root
  const gm = join(cliHomes.gemini, "tmp", "abc123");
  mkdirSync(join(gm, "chats"), { recursive: true });
  writeFileSync(join(gm, ".project_root"), proj);
  writeFileSync(join(gm, "chats", "session-2026-10-20T09-00-9e9e.json"), JSON.stringify({ sessionId: "9e9e-0003", startTime: ts, messages: [
    { type: "info", content: "update available" }, { type: "user", content: "summarise the open issues" }, { type: "gemini", content: "Three are open." }] }));

  const shared = (await history()).filter((c) => c.cwd === realpathSync(proj));
  assert.deepEqual(shared.map((c) => [c.source, c.title]).sort(), [["codex", "port the parser to rust"], ["copilot", "add a dark mode toggle"], ["gemini", "summarise the open issues"]]);
  assert.equal((await history("Three are open")).filter((c) => c.source === "gemini").length, 1, "found by an answer's words");

  const c = await newCanvas();
  const codex = shared.find((x) => x.source === "codex");
  const back = (await api("POST", `/v1/canvases/${c.id}/history/${codex.id}`, {})).data;
  assert.equal(back.backend, "codex");
  assert.equal(back.session, "0c0de000-0000-0000-0000-000000000001", "the same Codex thread");
  assert.equal(back.cwd, realpathSync(proj));
  assert.deepEqual((await transcript(c.id, back.id)).map((e) => e.text), ["port the parser to rust", "Ported."]);
  const gem = shared.find((x) => x.source === "gemini");
  const g = (await api("POST", `/v1/canvases/${c.id}/history/${gem.id}`, {})).data;
  assert.equal(g.backend, "gemini");
  assert.equal(g.session, null, "Gemini's session lives in its own home: the conversation seeds a new one");
  assert.equal(g.seedHistory, true);
  assert.equal((await history()).filter((x) => x.id === codex.id).length, 0, "held by an agent now");
  rmSync(proj, { recursive: true, force: true });
});
