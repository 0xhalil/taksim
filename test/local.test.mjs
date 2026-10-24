// Local models through taksim's own light loop (src/backends/local.mjs) against a stand-in Ollama: tools when the
// model has them, sized to the window the server opens; chat when it hasn't them or keeps calling them wrongly; a
// thinking model's answer that only sits in its reasoning.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const requests = []; // every /api/chat body, in order
const MODELS = {
  coder: { tools: true, window: 8192 },
  plain: { tools: false, window: 8192 },
  tiny: { tools: true, window: 1024 },
  clumsy: { tools: true, window: 8192 },
};

const call = (name, args) => ({ function: { name, arguments: args } });
// what the stand-in model does, from the last user message and how far the turn is
function reply(body) {
  // the person's request (not the note taksim adds when it takes the tools away)
  const ask = [...body.messages].reverse().find((m) => m.role === "user" && !/^Tools aren't available/.test(m.content))?.content || "";
  const tools = body.messages.filter((m) => m.role === "tool");
  if (/fix calc/.test(ask)) {
    if (!tools.length) return { thinking: "I should read it.", tool_calls: [call("read_file", { path: "calc.py" })] };
    if (tools.length === 1) return { tool_calls: [call("edit_file", { path: "calc.py", old: "a - b", new: "a + b" })] };
    return { thinking: "done", content: "Fixed add(): it returns a + b now." };
  }
  if (/only think/.test(ask)) return { thinking: "The answer is 42.", content: "" };
  if (/garbage/.test(ask)) return body.tools ? { tool_calls: [call("summon_dragon", {})] } : { content: "plain answer" };
  if (/history/.test(ask)) return { content: `seen ${body.messages.length} messages` };
  return { content: "hello there" };
}

const ollama = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  res.setHeader("content-type", "application/json");
  if (req.url === "/v1/models") return res.end(JSON.stringify({ data: Object.keys(MODELS).map((id) => ({ id })) }));
  if (req.url === "/api/version") return res.end(JSON.stringify({ version: "0.40.10" }));
  if (req.url === "/api/show") {
    const m = MODELS[body.model];
    return res.end(JSON.stringify({ capabilities: ["completion", ...(m.tools ? ["tools"] : [])], model_info: { "qwen3.context_length": 40960 } }));
  }
  if (req.url === "/api/ps") return res.end(JSON.stringify({ models: Object.entries(MODELS).map(([name, m]) => ({ name, model: name, context_length: m.window })) }));
  if (req.url === "/api/pull") {
    // streamed as Ollama does: the manifest, a layer's bytes coming in, then success; the model is there afterwards
    const lines = [{ status: "pulling manifest" }, { status: "pulling abc", total: 1000, completed: 0 }, { status: "pulling abc", total: 1000, completed: 600 },
      { status: "pulling abc", total: 1000, completed: 1000 }, { status: "verifying sha256 digest" }, { status: "success" }];
    MODELS[body.model] = { tools: true, window: 4096 };
    return res.end(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
  if (req.url === "/api/chat") {
    requests.push(body);
    const r = reply(body);
    // streamed as Ollama does: pieces of thinking and content, then a done line with the counts
    const out = [];
    if (r.thinking) out.push({ message: { role: "assistant", thinking: r.thinking } });
    if (r.content) for (const piece of r.content.match(/.{1,8}/g)) out.push({ message: { role: "assistant", content: piece } });
    if (r.tool_calls) out.push({ message: { role: "assistant", content: "", tool_calls: r.tool_calls } });
    out.push({ done: true, prompt_eval_count: 321, eval_count: 12 });
    return res.end(out.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
  res.statusCode = 404; res.end("{}");
});
await new Promise((r) => ollama.listen(0, "127.0.0.1", r));

const home = mkdtempSync(join(tmpdir(), "taksim-home-"));
const project = mkdtempSync(join(tmpdir(), "taksim-local-"));
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_QUIET = "1";
process.env.TAKSIM_LOCAL_URL = `http://127.0.0.1:${ollama.address().port}/v1`;
process.env.TAKSIM_OLLAMA_URL = `http://127.0.0.1:${ollama.address().port}`;
process.env.TAKSIM_OPENCODE_BIN = "/nonexistent/opencode";

const { startServer } = await import("../src/server.mjs");
let server, base;
before(async () => {
  server = await startServer({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); ollama.close(); rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); });

async function api(method, path, body) {
  const r = await fetch(base + path, { method, headers: method === "GET" ? {} : { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const canvas = async () => (await api("POST", "/v1/canvases", { name: "local" })).data;
const agent = async (c, spec) => (await api("POST", `/v1/canvases/${c.id}/agents`, { cwd: project, ...spec })).data;
const say = async (c, a, text) => (await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/messages`, { text, wait: true })).data;
const lastAnswer = async (c, a) => (await api("GET", `/v1/canvases/${c.id}/agents/${a.id}/transcript`)).data.transcript.at(-1);

test("a model with tools reads and edits a file in its folder, and says what it did", async () => {
  writeFileSync(join(project, "calc.py"), "def add(a, b):\n    return a - b\n");
  const c = await canvas();
  const a = await agent(c, { model: "local:coder", name: "Coder" });
  requests.length = 0;
  const r = await say(c, a, "fix calc.py");
  assert.equal(r.text, "Fixed add(): it returns a + b now.");
  assert.equal(readFileSync(join(project, "calc.py"), "utf8"), "def add(a, b):\n    return a + b\n");
  assert.equal(requests.length, 3, "read, edit, answer");
  const first = requests[0];
  assert.equal(first.messages[0].role, "system");
  assert.ok(first.messages[0].content.length < 1200, "a short system prompt, not a CLI's 20k tokens");
  assert.deepEqual(first.tools.map((t) => t.function.name), ["read_file", "edit_file", "list_files", "write_file", "run_command"]);
  assert.match(requests[1].messages.at(-1).content, /1\tdef add/, "the file came back with line numbers");
  const last = await lastAnswer(c, a);
  assert.deepEqual(last.activities.map((x) => [x.label, x.detail, x.status]), [["Read", "calc.py", "done"], ["Edit", "calc.py", "done"]]);
});

test("a model without tools only chats, as the server's own chat does", async () => {
  const c = await canvas();
  const a = await agent(c, { model: "local:plain" });
  requests.length = 0;
  assert.equal((await say(c, a, "hi")).text, "hello there");
  assert.equal(requests[0].tools, undefined);
});

test("an answer left only in the reasoning is said instead of nothing", async () => {
  const c = await canvas();
  const a = await agent(c, { model: "local:coder" });
  assert.equal((await say(c, a, "only think")).text, "The answer is 42.");
});

test("a model that keeps calling tools that aren't there finishes the turn as a chat, and chats from then on", async () => {
  const c = await canvas();
  const a = await agent(c, { model: "local:clumsy" });
  requests.length = 0;
  assert.equal((await say(c, a, "garbage")).text, "plain answer");
  assert.equal(requests.length, 4, "three wrong calls, then the answer without tools");
  assert.match(requests[1].messages.at(-1).content, /there is no tool "summon_dragon"/, "each wrong call is told what is there");
  assert.equal(requests[3].tools, undefined);
  requests.length = 0;
  await say(c, a, "hi");
  assert.equal(requests[0].tools, undefined, "remembered for this model");
});

test("a small window takes fewer tools and the newest part of the conversation", async () => {
  const c = await canvas();
  const a = await agent(c, { model: "local:tiny" });
  for (let i = 0; i < 6; i++) await say(c, a, `history ${i} ${"word ".repeat(120)}`);
  requests.length = 0;
  await say(c, a, "history now");
  const body = requests[0];
  const names = (body.tools || []).map((t) => t.function.name);
  assert.ok(names.length < 5, `fewer tools in 1024 tokens (got ${names.join(", ") || "none"})`);
  assert.ok(!names.includes("run_command"), "the command tool goes first");
  const sent = JSON.stringify(body.messages).length / 3.5 + JSON.stringify(body.tools || []).length / 3.5;
  assert.ok(sent < 1024, `everything sent fits the window (~${Math.round(sent)} tokens)`);
  assert.ok(body.messages.length < 14, "the oldest messages were left out");
  assert.equal(body.messages.at(-1).content, "history now");
});

test("a read-only agent gets only the tools that read", async () => {
  const c = await canvas();
  const a = await agent(c, { model: "local:coder", sandbox: "read-only" });
  requests.length = 0;
  await say(c, a, "hi");
  assert.deepEqual(requests[0].tools.map((t) => t.function.name), ["read_file", "list_files"]);
});

test("files outside the folder stay out of reach", async () => {
  const { runTool } = await import("../src/backends/local-tools.mjs");
  const out = await runTool("read_file", { path: "../../etc/passwd" }, { cwd: project, permission: "auto" });
  assert.match(out, /^error: .*outside the project/);
  assert.match(await runTool("edit_file", { path: "calc.py", old: "nope", new: "x" }, { cwd: project, permission: "auto" }), /not found/);
});

test("small models' slips: offset 0 and limit -1 read the whole file, line numbers and lost indentation still match, files that exist aren't overwritten", async () => {
  const { runTool } = await import("../src/backends/local-tools.mjs");
  const o = { cwd: project, permission: "auto" };
  writeFileSync(join(project, "two.py"), "def add(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a * b\n");
  assert.match(await runTool("read_file", { path: "two.py", offset: 0, limit: -1 }, o), /^1\tdef add[\s\S]*6\t    return a \* b/);
  assert.match(await runTool("edit_file", { path: "two.py", old: "2\t    return a - b", new: "    return a + b" }, o), /^edited/);
  assert.match(await runTool("edit_file", { path: "two.py", old: "def mul(a, b):\nreturn a * b", new: "def mul(a, b):\nreturn a * b * 1" }, o), /^edited/);
  assert.equal(readFileSync(join(project, "two.py"), "utf8"), "def add(a, b):\n    return a + b\n\n\ndef mul(a, b):\n    return a * b * 1\n", "indentation kept");
  assert.match(await runTool("write_file", { path: "two.py", content: "x" }, o), /already exists; change it with edit_file/);
  assert.match(await runTool("write_file", { path: "new/three.py", content: "x = 1\n" }, o), /^created/);
});

test("the Local tile's state: Ollama running, a model for this Mac's memory, and a pull with progress that adds it", async () => {
  const { recommend } = await import("../src/local-setup.mjs");
  assert.equal(recommend(8).model, "qwen3:1.7b");
  assert.equal(recommend(16).model, "qwen3:4b");
  assert.equal(recommend(32).model, "qwen3:8b");
  assert.equal(recommend(128).model, "qwen3:14b");
  const st = (await api("GET", "/v1/local")).data;
  assert.equal(st.ollama.running, true);
  assert.ok(st.models.includes("local:coder"));
  assert.match(st.recommended.model, /^qwen3:/);
  assert.equal((await api("POST", "/v1/local/start", {})).data.running, true, "already running: nothing to do");
  assert.equal((await api("POST", "/v1/local/pull", { model: "bad name!" })).status, 400);
  const started = await api("POST", "/v1/local/pull", { model: "qwen3:0.6b" });
  assert.equal(started.status, 202);
  let pull;
  for (let i = 0; i < 50; i++) {
    pull = (await api("GET", "/v1/local")).data.pull;
    if (!pull.running) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.deepEqual([pull.done, pull.error], [true, null]);
  assert.ok((await api("GET", "/v1/local")).data.models.includes("local:qwen3:0.6b"), "pulled: on the list at once");
});
