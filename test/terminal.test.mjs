// Terminal nodes against the fake TUI: PTY over WebSocket, hooks, delivery into the TUI, guards.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const home = mkdtempSync(join(tmpdir(), "taksim-home-"));
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_FAKE = "1";
process.env.TAKSIM_QUIET = "1";
process.env.TAKSIM_OPENCODE_BIN = "/nonexistent/opencode";
process.env.TAKSIM_INJECT_ACK_MS = "800";

const { startServer } = await import("../src/server.mjs");

let server, base, port;
before(async () => {
  server = await startServer({ host: "127.0.0.1", port: 0 });
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});
after(() => { server.close(); rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); });

async function api(method, path, body) {
  const r = await fetch(base + path, {
    method, headers: method === "GET" ? {} : { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const newCanvas = async (body = {}) => (await api("POST", "/v1/canvases", body)).data;
const addAgent = async (cid, spec) => (await api("POST", `/v1/canvases/${cid}/agents`, spec)).data;
const view = async (cid, aid) => (await api("GET", `/v1/canvases/${cid}/agents/${aid}`)).data;
const transcript = async (cid, aid) => (await api("GET", `/v1/canvases/${cid}/agents/${aid}/transcript`)).data.transcript;
const call = (tool, args) => `CALL ${JSON.stringify({ tool, args })}`;

async function until(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(50);
  }
}

// A browser-like terminal client: collects output, sends keystrokes.
function connect(cid, aid, origin = `http://127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/term/${cid}/${aid}`, { headers: origin ? { origin } : {} });
    const client = { ws, out: "", type: (d) => ws.send(JSON.stringify({ t: "i", d })) };
    ws.on("message", (d) => (client.out += d.toString()));
    ws.on("open", () => resolve(client));
    ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on("error", reject);
  });
}

async function openTerminal(name = "tty", spec = {}) {
  const c = await newCanvas();
  const a = await addAgent(c.id, { name, model: "fake-echo", ...spec });
  const r = await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/terminal`);
  assert.equal(r.status, 200);
  assert.equal(r.data.terminal, true);
  return { c, a };
}

test("terminal I/O over WebSocket, hooks record the turn, reattach replays scrollback", async () => {
  const { c, a } = await openTerminal();
  const t = await connect(c.id, a.id);
  await until(() => t.out.includes("fake-tui ready"));
  t.type("hello\r");
  await until(() => t.out.includes("tui: hello"));
  await until(async () => (await view(c.id, a.id)).lastText === "tui: hello");
  const tr = await transcript(c.id, a.id);
  assert.deepEqual(tr.map((e) => [e.kind, e.text]), [["user", "hello"], ["assistant", "tui: hello"]]);
  assert.equal((await view(c.id, a.id)).status, "idle");
  t.ws.close();
  const again = await connect(c.id, a.id);
  await until(() => again.out.includes("tui: hello"));
  again.ws.close();
  await api("DELETE", `/v1/canvases/${c.id}/agents/${a.id}/terminal`);
});

test("an ask to a terminal agent is pasted into its TUI and answered through the stop hook", async () => {
  const { c, a } = await openTerminal("worker");
  const lead = await addAgent(c.id, { name: "lead", model: "fake-delegate" });
  const t = await connect(c.id, a.id);
  const r = await api("POST", `/v1/canvases/${c.id}/agents/${lead.id}/messages`,
    { text: call("ask_agent", { agent: "worker", message: "are you there?" }), wait: true });
  assert.match(r.data.text, /^ask_agent: tui: are you there\?$/);
  // the paste kept the header and the message together as one prompt
  // as text: Windows' console redraws with cursor and title sequences between the characters
  assert.match(t.out.replace(/\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[ -\/]*[@-~]/g, ""), /\[Message from agent "lead"[\s\S]*are you there\?/);
  const tr = await transcript(c.id, a.id);
  assert.deepEqual(tr.map((e) => [e.kind, e.from === lead.id ? "lead" : e.from === a.id ? "worker" : e.from]),
    [["ask", "lead"], ["assistant", "worker"]]);
  t.ws.close();
  await api("DELETE", `/v1/canvases/${c.id}/agents/${a.id}/terminal`);
});

test("delivery waits while the person is typing a line", async () => {
  const { c, a } = await openTerminal();
  const t = await connect(c.id, a.id);
  await until(() => t.out.includes("ready"));
  t.type("draft");
  await sleep(100);
  await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/messages`, { text: "queued msg" });
  await sleep(1500);
  let v = await view(c.id, a.id);
  assert.equal(v.queued, 1, "must not paste into a half-written line");
  t.type("\x15"); // Ctrl-U clears the line; delivery resumes after the quiet period
  await until(() => t.out.includes("tui: queued msg"), 9000);
  v = await view(c.id, a.id);
  assert.equal(v.queued, 0);
  t.ws.close();
  await api("DELETE", `/v1/canvases/${c.id}/agents/${a.id}/terminal`);
});

test("closing the terminal returns the agent to headless turns, re-queuing an unanswered paste", async () => {
  const { c, a } = await openTerminal();
  const t = await connect(c.id, a.id);
  await until(() => t.out.includes("ready"));
  const reply = api("POST", `/v1/canvases/${c.id}/agents/${a.id}/messages`, { text: "SLOW job", wait: true });
  await until(() => t.out.includes("SLOW job"));
  await api("DELETE", `/v1/canvases/${c.id}/agents/${a.id}/terminal`);
  const r = await reply;
  assert.equal(r.status, 200);
  assert.match(r.data.text, /^echo: /); // answered by the headless fake-echo run instead
  assert.equal((await view(c.id, a.id)).terminal, false);
});

test("typing /exit in the TUI closes the terminal node", async () => {
  const { c, a } = await openTerminal();
  const t = await connect(c.id, a.id);
  await until(() => t.out.includes("ready"));
  t.type("/exit\r");
  await until(async () => (await view(c.id, a.id)).terminal === false);
});

test("WebSocket guard: Origin must be present and our own; closed terminals refuse", async () => {
  const { c, a } = await openTerminal();
  await assert.rejects(connect(c.id, a.id, "https://evil.example"), /HTTP 403/);
  await assert.rejects(connect(c.id, a.id, null), /HTTP 403/);
  await api("DELETE", `/v1/canvases/${c.id}/agents/${a.id}/terminal`);
  await until(async () => (await view(c.id, a.id)).terminal === false);
  await assert.rejects(connect(c.id, a.id), /HTTP 409/);
});

test("hooks need a valid agent token", async () => {
  const r = await fetch(`${base}/hooks/not-a-token/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 404);
});

test("terminal count is limited per canvas", async () => {
  const c = await newCanvas({ limits: { max_terminals: 1 } });
  const a = await addAgent(c.id, { model: "fake-echo" });
  const b = await addAgent(c.id, { model: "fake-echo" });
  assert.equal((await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/terminal`)).status, 200);
  const r = await api("POST", `/v1/canvases/${c.id}/agents/${b.id}/terminal`);
  assert.equal(r.status, 409);
  assert.match(r.data.error.message, /at most 1 terminal/);
  await api("DELETE", `/v1/canvases/${c.id}/agents/${a.id}/terminal`);
});

test("focus/mouse/arrow escape sequences from the browser don't count as typing", async () => {
  const { c, a } = await openTerminal();
  const t = await connect(c.id, a.id);
  await until(() => t.out.includes("ready"));
  t.type("\x1b[I\x1b[O\x1b[I\x1b[A\x1b[<0;10;5M"); // focus in/out, arrow up, SGR mouse report
  await sleep(100);
  const started = Date.now();
  await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/messages`, { text: "after focus" });
  await until(() => t.out.includes("tui: after focus"), 4000);
  assert.ok(Date.now() - started < 3500, "delivery must not wait for the typing guard");
  t.ws.close();
  await api("DELETE", `/v1/canvases/${c.id}/agents/${a.id}/terminal`);
});

test("nothing is pasted while the TUI shows a startup dialog; delivery starts once it is answered", async () => {
  const { c, a } = await openTerminal("dlg", { system: "DIALOG" });
  const t = await connect(c.id, a.id);
  await until(() => t.out.includes("Do you trust"));
  assert.equal((await view(c.id, a.id)).termReady, false);
  await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/messages`, { text: "hello there" });
  await sleep(1500);
  assert.equal((await view(c.id, a.id)).queued, 1, "must not paste into the dialog");
  t.type("\r"); // the person answers the dialog
  await until(() => t.out.includes("tui: hello there"));
  assert.equal((await view(c.id, a.id)).queued, 0);
  t.ws.close();
  await api("DELETE", `/v1/canvases/${c.id}/agents/${a.id}/terminal`);
});

test("a paste the TUI never takes goes back to the queue with a visible warning", async () => {
  const { c, a } = await openTerminal();
  const t = await connect(c.id, a.id);
  await until(() => t.out.includes("ready"));
  await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/messages`, { text: "DROP this" });
  const v = await until(async () => { const x = await view(c.id, a.id); return x.queued === 1 && x.lastError ? x : null; }, 4000);
  assert.match(v.lastError, /didn't accept the message/);
  assert.equal(v.status, "idle");
  assert.equal(v.termReady, false);
  // the transcript has the incoming message once, not once per attempt
  const tr = await transcript(c.id, a.id);
  assert.equal(tr.filter((e) => e.text === "DROP this").length, 1);
  t.ws.close();
  await api("DELETE", `/v1/canvases/${c.id}/agents/${a.id}/terminal`);
});

test("a terminal opened after headless turns resumes the same session (the agent remembers)", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { name: "helper", model: "fake-echo" }); // chat mode, like auto-created agents
  await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/messages`, { text: "remember 42", wait: true });
  const { session } = await view(c.id, a.id);
  assert.ok(session);
  await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/terminal`);
  const t = await connect(c.id, a.id);
  await until(() => t.out.includes("ready"));
  assert.ok(t.out.includes(`session=${session}`), "the TUI must resume the headless session");
  assert.equal((await view(c.id, a.id)).session, session);
  t.ws.close();
  await api("DELETE", `/v1/canvases/${c.id}/agents/${a.id}/terminal`);
});

test("a terminal closed without any turn leaves no session behind", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-echo" });
  await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/terminal`);
  const t = await connect(c.id, a.id);
  await until(() => t.out.includes("ready"));
  assert.equal((await view(c.id, a.id)).session, null, "an unused TUI session isn't stored");
  t.type("hi\r");
  await until(async () => (await view(c.id, a.id)).session);
  t.ws.close();
  await api("DELETE", `/v1/canvases/${c.id}/agents/${a.id}/terminal`);
});
