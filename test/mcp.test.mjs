// Agent-to-agent tools over MCP, driven by the fake-delegate model (no subscriptions needed).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
const { helperPath } = await import("../src/computer/helper.mjs");
const { COMPUTER_TOOLS } = await import("../src/computer/tools.mjs");

let server, base;
before(async () => {
  server = await startServer({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
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
const say = async (cid, aid, text) => (await api("POST", `/v1/canvases/${cid}/agents/${aid}/messages`, { text, wait: true })).data;
const call = (tool, args) => `CALL ${JSON.stringify({ tool, args })}`;
const agentView = async (cid, aid) => (await api("GET", `/v1/canvases/${cid}/agents/${aid}`)).data;
const rpc = (token, body) => fetch(`${base}/mcp/${token}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

async function until(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(50);
  }
}

test("MCP handshake and tool list", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { model: "fake-echo" });
  const token = getCanvas(c.id).agents.get(a.id).token;
  const init = await (await rpc(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).json();
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.equal(init.result.serverInfo.name, "taksim");
  assert.equal((await rpc(token, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const list = await (await rpc(token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  assert.deepEqual(list.result.tools.map((t) => t.name), ["approve", "update_todos", "ask_user", "list_agents", "ask_agent", "tell_agent", "get_context", "update_context", "remember", "plan_work", "create_agent",
    "design_tool", "find_tools", "add_tool", "use_tool", "save_tool", "list_bricks", "panel_open", "panel_patch", "panel_push", "panel_read", "panel_close", "ide_open", "ide_note", "ide_debug_state", "ide_close",
    "browser_navigate", "browser_snapshot", "browser_click", "browser_hover", "browser_drag", "browser_type", "browser_select", "browser_upload",
    "browser_press", "browser_scroll", "browser_dialog", "browser_tabs", "browser_screenshot", "browser_back", "browser_eval",
    ...(helperPath() ? COMPUTER_TOOLS.map((t) => t.name) : [])]); // computer control where taksim-computer is built
  assert.equal((await rpc("not-a-token", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 404);
});

test("list_agents shows the other agents", async () => {
  const c = await newCanvas();
  const lead = await addAgent(c.id, { name: "lead", model: "fake-delegate" });
  await addAgent(c.id, { name: "helper", model: "fake-echo", role: "echoes" });
  const out = await say(c.id, lead.id, call("list_agents"));
  const data = JSON.parse(out.text.replace(/^list_agents: /, ""));
  assert.equal(data.you, "lead");
  assert.deepEqual(data.agents.map((a) => [a.name, a.role]), [["helper", "echoes"]]);
});

test("ask_agent waits for and returns the other agent's answer", async () => {
  const c = await newCanvas();
  const lead = await addAgent(c.id, { name: "lead", model: "fake-delegate" });
  const helper = await addAgent(c.id, { name: "helper", model: "fake-echo" });
  const out = await say(c.id, lead.id, call("ask_agent", { agent: "helper", message: "ping" }));
  assert.match(out.text, /^ask_agent: echo: \[Message from agent "lead" \(fake-delegate\)[\s\S]*ping$/);
  const t = (await api("GET", `/v1/canvases/${c.id}/agents/${helper.id}/transcript`)).data.transcript;
  assert.deepEqual(t.map((e) => [e.kind, e.from]), [["ask", lead.id], ["assistant", helper.id]]);
  const canvas = (await api("GET", `/v1/canvases/${c.id}`)).data;
  assert.ok(canvas.links.some((l) => l.from === lead.id && l.to === helper.id && l.kind === "message"));
});

test("tell_agent returns at once and the answer arrives later as a reply turn", async () => {
  const c = await newCanvas();
  const lead = await addAgent(c.id, { name: "lead", model: "fake-delegate" });
  await addAgent(c.id, { name: "worker", model: "fake-wait" });
  const out = await say(c.id, lead.id, call("tell_agent", { agent: "worker", message: "job" }));
  assert.match(out.text, /Sent to "worker"/);
  const t = await until(async () => {
    const tr = (await api("GET", `/v1/canvases/${c.id}/agents/${lead.id}/transcript`)).data.transcript;
    return tr.some((e) => e.kind === "reply") && tr.at(-1).kind === "assistant" ? tr : null;
  });
  const reply = t.find((e) => e.kind === "reply");
  assert.match(JSON.parse(reply.text).prompt, /job$/);
  assert.match(t.at(-1).text, /^delegate: \[Reply from agent "worker"/);
});

test("Create agents off: a new agent only when asked for one; on: the agent is told to orchestrate and pick models", async () => {
  const c = (await api("POST", "/v1/canvases", {})).data;
  const lead = await addAgent(c.id, { name: "lead", model: "fake-delegate" });
  const agent = getCanvas(c.id).agents.get(lead.id);
  assert.match(agent.systemPrompt(), /Create agents is off: call create_agent only when the user explicitly asks/);
  assert.doesNotMatch(agent.systemPrompt(), /you may orchestrate/);
  // nobody asked for an agent: the tool refuses, however the agent came to call it
  agent.asks = ["refactor the login flow"]; agent.lastAsk = "refactor the login flow";
  const { handleMcp } = await import("../src/mcp/server.mjs").catch(() => ({}));
  const rpc = (body) => fetch(agent.mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: body }) }).then((r) => r.json());
  const refused = await rpc({ name: "create_agent", arguments: { name: "helper", model: "fake-echo" } });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /Create agents is off for you and nobody asked/);
  assert.equal(getCanvas(c.id).agents.size, 1);
  // asked in so many words, in either language
  for (const ask of ["bunun için yeni bir ajan aç", "create an agent that reviews the diff"]) {
    agent.asks = [ask]; agent.lastAsk = "ok go";
    assert.notEqual((await rpc({ name: "create_agent", arguments: { name: "asked", model: "fake-echo" } })).result.isError, true, ask);
  }
  assert.equal(getCanvas(c.id).agents.size, 3);
  // asked to split the work: that is plan_work's, however the request is worded
  agent.asks = ["split this work across agents: one researches, another adds the tests"]; agent.lastAsk = agent.asks[0];
  const split = await rpc({ name: "create_agent", arguments: { name: "part", model: "fake-echo" } });
  assert.match(split.result.content[0].text, /asked for this work to be split across agents: hand the parts out with plan_work/);
  // on: it may orchestrate, and the prompt says how; but parts still don't come from create_agent
  assert.equal((await api("PATCH", `/v1/canvases/${c.id}/agents/${lead.id}`, { delegate: true })).status, 200);
  agent.asks = ["refactor the login flow"]; agent.lastAsk = "refactor the login flow";
  assert.match(agent.systemPrompt(), /you may orchestrate[\s\S]*When in doubt, don't split[\s\S]*One writer[\s\S]*not by price: call list_agents first/);
  assert.doesNotMatch(agent.systemPrompt(), /Create agents is off/);
  const own = await rpc({ name: "create_agent", arguments: { name: "part", model: "fake-echo" } });
  assert.equal(own.result.isError, true);
  assert.match(own.result.content[0].text, /To hand out parts of your work, use plan_work/);
  assert.equal(getCanvas(c.id).agents.size, 3);
  // the agents a job makes don't make more on their own
  const part = getCanvas(c.id).addAgent({ name: "part", model: "fake-echo" }, { createdBy: lead.id, parent: agent });
  assert.match(part.systemPrompt(), /Create agents is off/);
  await api("DELETE", `/v1/canvases/${c.id}`);
});

test("create_agent adds a linked agent next to its creator and runs its task", async () => {
  const c = await newCanvas();
  const lead = await addAgent(c.id, { name: "lead", model: "fake-delegate", pos: [100, 100] });
  const out = await say(c.id, lead.id, call("create_agent", { name: "reviewer", role: "reviews", model: "fake-echo", task: "review this" }));
  const created = JSON.parse(out.text.replace(/^create_agent: /, "")).created;
  assert.equal(created.name, "reviewer");
  assert.equal(created.created_by, "lead");
  const canvas = (await api("GET", `/v1/canvases/${c.id}`)).data;
  const reviewer = canvas.agents.find((a) => a.name === "reviewer");
  assert.equal(reviewer.parent, lead.id);
  assert.equal(reviewer.depth, 1);
  assert.ok(reviewer.pos[0] > 100);
  assert.ok(canvas.links.some((l) => l.from === lead.id && l.to === reviewer.id && l.kind === "created"));
  // the task's answer comes back to the lead
  await until(async () => (await api("GET", `/v1/canvases/${c.id}/agents/${lead.id}/transcript`)).data.transcript
    .some((e) => e.kind === "reply" && /review this/.test(e.text)));
});

test("asking an agent that is waiting on you is refused instead of deadlocking", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { name: "a", model: "fake-delegate" });
  await addAgent(c.id, { name: "b", model: "fake-delegate" });
  // a asks b; b's message tells it to ask a back
  const inner = call("ask_agent", { agent: "a", message: "loop" });
  const out = await say(c.id, a.id, call("ask_agent", { agent: "b", message: inner }));
  assert.match(out.text, /waiting on you, so asking it would deadlock/);
  assert.equal((await agentView(c.id, a.id)).status, "idle");
});

test("self messages and unknown agents are tool errors", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { name: "solo", model: "fake-delegate" });
  const out = await say(c.id, a.id, [call("ask_agent", { agent: "solo", message: "x" }), call("tell_agent", { agent: "ghost", message: "x" })].join("\n"));
  assert.match(out.text, /ask_agent: ERROR you can't message yourself/);
  assert.match(out.text, /tell_agent: ERROR no agent "ghost"/);
});

test("creation depth and canvas size limits", async () => {
  const c = await newCanvas({ limits: { max_depth: 1, max_agents: 3 } });
  const root = await addAgent(c.id, { name: "root", model: "fake-delegate" });
  await say(c.id, root.id, call("create_agent", { name: "kid", role: "r", model: "fake-delegate" }));
  const kid = (await api("GET", `/v1/canvases/${c.id}`)).data.agents.find((a) => a.name === "kid");
  const deep = await say(c.id, kid.id, call("create_agent", { name: "grandkid", role: "r" }));
  assert.match(deep.text, /ERROR creation depth limit/);
  await say(c.id, root.id, call("create_agent", { name: "kid2", role: "r", model: "fake-echo" }));
  const full = await say(c.id, root.id, call("create_agent", { name: "kid3", role: "r", model: "fake-echo" }));
  assert.match(full.text, /ERROR canvas is full/);
});

test("ask_agent times out on a busy agent and withdraws the queued message", async () => {
  const c = await newCanvas();
  // read-only, so neither takes the directory's write lock (writers in one directory take turns)
  const lead = await addAgent(c.id, { name: "lead", model: "fake-delegate", sandbox: "read-only" });
  const busy = await addAgent(c.id, { name: "busy", model: "fake-slow", sandbox: "read-only" });
  api("POST", `/v1/canvases/${c.id}/agents/${busy.id}/messages`, { text: "hang" });
  await until(async () => (await agentView(c.id, busy.id)).status === "running");
  const out = await say(c.id, lead.id, call("ask_agent", { agent: "busy", message: "hello?", timeout_s: 1 }));
  assert.match(out.text, /ERROR "busy" did not answer within 1s/);
  assert.equal((await agentView(c.id, busy.id)).queued, 0);
  await api("POST", `/v1/canvases/${c.id}/agents/${busy.id}/stop`);
});

test("an agent waiting on another shares its directory lock with it", async () => {
  const project = mkdtempSync(join(tmpdir(), "taksim-project-"));
  const c = await newCanvas({ vars: { project_dir: project } });
  const lead = await addAgent(c.id, { name: "lead", model: "fake-delegate", mode: "agent" });
  await addAgent(c.id, { name: "coder", model: "fake-wait", mode: "agent" });
  // both are writable agents in the same dir; without lock sharing this would hang until the ask timeout
  const out = await say(c.id, lead.id, call("ask_agent", { agent: "coder", message: "implement", timeout_s: 5 }));
  assert.match(out.text, /^ask_agent: \{"start"/);
  rmSync(project, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

test("agents created by agents start read-only unless asked for editing access", async () => {
  const c = await newCanvas();
  const lead = await addAgent(c.id, { name: "lead", model: "fake-delegate" });
  await say(c.id, lead.id, [
    call("create_agent", { name: "reader", role: "r", model: "fake-echo" }),
    call("create_agent", { name: "writer", role: "w", model: "fake-echo", sandbox: "workspace-write" }),
  ].join("\n"));
  const agents = (await api("GET", `/v1/canvases/${c.id}`)).data.agents;
  assert.equal(agents.find((a) => a.name === "reader").sandbox, "read-only");
  assert.equal(agents.find((a) => a.name === "writer").sandbox, null);
});

test("create_agent can put the new agent in another folder", async () => {
  const { realpathSync } = await import("node:fs");
  const other = mkdtempSync(join(tmpdir(), "taksim-other-"));
  const c = await newCanvas();
  const lead = await addAgent(c.id, { name: "lead", model: "fake-delegate" });
  await say(c.id, lead.id, call("create_agent", { name: "elsewhere", role: "r", model: "fake-echo", cwd: other }));
  const created = (await api("GET", `/v1/canvases/${c.id}`)).data.agents.find((a) => a.name === "elsewhere");
  assert.equal(created.cwd, realpathSync.native(other));
  assert.equal(created.sandbox, "read-only", "still read-only unless asked");
  const bad = await say(c.id, lead.id, call("create_agent", { name: "x", role: "r", model: "fake-echo", cwd: process.platform === "win32" ? process.env.SystemRoot || "C:\\Windows" : "/etc" }));
  assert.match(bad.text, /ERROR .*can't be an agent's directory/);
  rmSync(other, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});
