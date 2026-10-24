// Routing to the Copilot and local backends, Copilot's CLI arguments and JSONL events (the local loop: local.test.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// a stand-in Ollama: /v1/models lists one model whose id has a "/" like LM Studio's
const ollama = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ data: [{ id: "qwen/qwen3-8b" }, { id: "llama3.2:latest" }] }));
});
await new Promise((r) => ollama.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${ollama.address().port}/v1`;
process.env.TAKSIM_LOCAL_URL = `http://127.0.0.1:1/v1,${base}`; // the first one isn't running
process.env.TAKSIM_HOME = mkdtempSync(join(tmpdir(), "taksim-backends-"));
process.env.TAKSIM_COPILOT_BIN = "copilot";

const { pickBackend, listModels } = await import("../src/backends/index.mjs");
const { default: copilot } = await import("../src/backends/copilot.mjs");
const { default: local } = await import("../src/backends/local.mjs");
await local.init();
test.after(() => ollama.close());

test("copilot: and local: models reach their own backends, even with a / in the id", () => {
  assert.equal(pickBackend("copilot").backend.name, "copilot");
  assert.equal(pickBackend("copilot:gpt-5.4").backend.name, "copilot");
  assert.equal(pickBackend("local:qwen/qwen3-8b").backend.name, "local");
  assert.equal(pickBackend("opencode-go/glm-5.3").backend.name, "opencode");
  assert.equal(pickBackend("gpt-6-astra").backend.name, "codex");
});

test("local models are found on the servers that are running", () => {
  assert.deepEqual(local.models, ["local:qwen/qwen3-8b", "local:llama3.2:latest"]);
  assert.ok(listModels().some((m) => m.id === "local:llama3.2:latest" && m.owned_by === "local"));
  assert.equal(local.checkModel("local:llama3.2:latest"), undefined);
  assert.match(local.checkModel("local:nope"), /unknown local model/);
});

test("a local model is run by taksim itself, not by a CLI", () => {
  assert.equal(typeof local.direct, "function");
  assert.equal(local.build, undefined);
  assert.equal(local.interactive, undefined, "no terminal mode: there is no CLI to show");
});

test("copilot picks its own model unless one is named; read-only agents plan", () => {
  const auto = copilot.build({ model: "copilot", prompt: "x", opts: { cwd: "/tmp/p", sandbox: "read-only", session: "s1", mcpUrl: "http://m" } });
  assert.equal(auto.args[auto.args.indexOf("--model") + 1], "auto");
  assert.ok(auto.args.includes("--plan"));
  assert.equal(auto.args[auto.args.indexOf("--session-id") + 1], "s1");
  assert.deepEqual(JSON.parse(auto.args[auto.args.indexOf("--additional-mcp-config") + 1]).mcpServers.taksim.url, "http://m");
  const named = copilot.build({ model: "copilot:gpt-5.4", prompt: "x", opts: {} });
  assert.equal(named.args[named.args.indexOf("--model") + 1], "gpt-5.4");
});

test("the terminal gets taksim's hook plugin and the agent's instructions", async () => {
  const { readFileSync } = await import("node:fs");
  const t = copilot.interactive({ model: "copilot", session: "abc", system: "You are on a canvas.", mcpUrl: "http://m", hookUrl: "http://h/hooks/t" });
  assert.equal(t.env.TAKSIM_HOOK_URL, "http://h/hooks/t");
  assert.equal(readFileSync(join(t.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS, "AGENTS.md"), "utf8"), "You are on a canvas.");
  const hooks = JSON.parse(readFileSync(join(t.args[t.args.indexOf("--plugin-dir") + 1], "hooks", "hooks.json"), "utf8")).hooks;
  assert.deepEqual(Object.keys(hooks), ["UserPromptSubmit", "Stop", "preToolUse"]);
  assert.match(hooks.preToolUse[0].bash, /^\[ -z "\$TAKSIM_PERMISSION_URL" \] && exit 0;/, "the permission hook stays quiet unless a run asks");
  assert.match(hooks.Stop[0].hooks[0].command, /\$TAKSIM_HOOK_URL\/stop/);
});

test("copilot's JSONL: deltas stream, the last message is the answer, the result names the session", () => {
  const st = { text: "", session: null, usage: { input: 0, output: 0 }, error: null };
  let streamed = "";
  for (const ev of [
    { type: "assistant.message_delta", data: { deltaContent: "Hel" } },
    { type: "assistant.message_delta", data: { deltaContent: "lo" } },
    { type: "assistant.message", data: { content: "Hello" } },
    { type: "result", sessionId: "sess-1", exitCode: 0 },
  ]) copilot.parse(ev, st, (t) => (streamed += t));
  assert.deepEqual([streamed, st.text, st.session, st.error], ["Hello", "Hello", "sess-1", null]);
});

test("claude's permission mode: auto and bypass decide alone, the others ask the person through taksim", async () => {
  const { default: claude } = await import("../src/backends/claude.mjs");
  const run = (sandbox, permission) => claude.build({ model: "sonnet", system: "s", prompt: "p", opts: { cwd: "/tmp/p", sandbox, permission, mcpUrl: "http://127.0.0.1/mcp/t" } }).args;
  const at = (args, flag) => args[args.indexOf(flag) + 1];
  for (const mode of ["default", "acceptEdits"]) {
    assert.equal(at(run("workspace-write", mode), "--permission-mode"), mode);
    assert.equal(at(run("workspace-write", mode), "--permission-prompt-tool"), "mcp__taksim__approve");
  }
  for (const mode of ["auto", "bypassPermissions"]) {
    assert.equal(at(run("workspace-write", mode), "--permission-mode"), mode);
    assert.ok(!run("workspace-write", mode).includes("--permission-prompt-tool"));
  }
  // read-only turns are plan mode whatever was picked, and ask nothing
  assert.equal(at(run("read-only", "auto"), "--permission-mode"), "plan");
  assert.ok(!run("read-only", "default").includes("--permission-prompt-tool"));
  // the terminal gets the mode as a flag; unset leaves Claude's own default
  const tui = (permission) => claude.interactive({ model: "sonnet", session: "s", newSession: true, system: "s", mcpUrl: "http://127.0.0.1/mcp/t", hookUrl: "http://127.0.0.1/h", sandbox: null, permission }).args;
  assert.equal(at(tui("auto"), "--permission-mode"), "auto");
  assert.ok(!tui(undefined).includes("--permission-mode"));
});

test("canvas Ask and Agent access maps consistently to each CLI's execution policy", async () => {
  const { default: claude } = await import("../src/backends/claude.mjs");
  const { default: codex } = await import("../src/backends/codex.mjs");
  const { default: opencode } = await import("../src/backends/opencode.mjs");
  const { default: gemini } = await import("../src/backends/gemini.mjs");
  const request = (backend, sandbox) => backend.build({ model: backend.defaultModel, system: "core policy", prompt: "work", opts: { cwd: "/tmp/project", sandbox, mcpUrl: "http://127.0.0.1/mcp/test" } });
  const option = (out, flag) => out.args[out.args.indexOf(flag) + 1];
  assert.equal(option(request(claude, "read-only"), "--permission-mode"), "plan");
  assert.equal(option(request(claude, "workspace-write"), "--permission-mode"), "acceptEdits");
  assert.equal(request(claude, "workspace-write").env.CLAUDE_CODE_ENABLE_TODO_TOOLS, "1");
  assert.equal(request(claude, "read-only").env.CLAUDE_CODE_ENABLE_TODO_TOOLS, undefined);
  assert.ok(request(codex, "read-only").args.includes('sandbox_mode="read-only"'));
  assert.ok(request(codex, "workspace-write").args.includes('sandbox_mode="workspace-write"'));
  assert.equal(option(request(opencode, "read-only"), "--agent"), "plan");
  assert.ok(!request(opencode, "workspace-write").args.includes("--agent"));
  assert.equal(option(request(gemini, "read-only"), "--approval-mode"), "plan");
  assert.equal(option(request(gemini, "workspace-write"), "--approval-mode"), "auto_edit");
  for (const backend of [copilot]) {
    const model = "copilot";
    const ask = backend.build({ model, prompt: "work", opts: { cwd: "/tmp/project", sandbox: "read-only" } });
    const agent = backend.build({ model, prompt: "work", opts: { cwd: "/tmp/project", sandbox: "workspace-write" } });
    assert.ok(ask.args.includes("--plan"));
    assert.ok(ask.args.includes("--deny-tool") && ask.args.includes("write") && ask.args.includes("shell"));
    assert.ok(!agent.args.includes("--plan") && !agent.args.includes("--deny-tool"));
  }
});


test('every provider wires the shared Taksim task tools into agent runs', async () => {
  const { default: claude } = await import('../src/backends/claude.mjs');
  const { default: codex } = await import('../src/backends/codex.mjs');
  const { default: opencode } = await import('../src/backends/opencode.mjs');
  const { default: gemini } = await import('../src/backends/gemini.mjs');
  const url = 'http://127.0.0.1:9876/mcp/test';
  // (local models get no MCP: taksim runs their tools itself, local.mjs)
  for (const backend of [claude, codex, opencode, gemini, copilot]) {
    const model = backend.defaultModel;
    const out = backend.build({ model, system: 'task policy', prompt: 'work', opts: { cwd: '/tmp/project', mcpUrl: url, sandbox: 'workspace-write' } });
    assert.ok(JSON.stringify([out.args, out.env]).includes(url), backend.name);
  }
});
