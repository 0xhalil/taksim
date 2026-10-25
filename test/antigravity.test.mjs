// Antigravity CLI (agy): its model list with thinking levels, headless arguments, the MCP folder it adds, and
// its stream-json events.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "taksim-home-"));
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_FAKE = "1";
process.env.TAKSIM_QUIET = "1";

const { default: agy, parseAgyModels, mcpDir } = await import("../src/backends/antigravity.mjs");
const { pickBackend } = await import("../src/backends/index.mjs");
const { activityOf } = await import("../src/backends/activity.mjs");
after(() => rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

const LISTED = `Fetching available models...
gemini-4-argon-medium\tGemini 4 Argon (Medium)
gemini-4-argon-high\tGemini 4 Argon (High)
gemini-4-argon-low\tGemini 4 Argon (Low)
claude-opus-5-5-high\tClaude Opus 5.5 (High)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`;

test("agy models: one model per name, its levels in order, ids that no other CLI claims", () => {
  const m = parseAgyModels(LISTED);
  assert.deepEqual(m.map((x) => x.id), ["agy:gemini-4-argon", "agy:claude-opus-5-5", "agy:gpt-oss-120b"]);
  assert.deepEqual(m[0].efforts, ["low", "medium", "high"]);
  assert.equal(m[0].name, "Gemini 4 Argon");
  assert.equal(pickBackend("agy:claude-opus-5-5").backend.name, "antigravity", "not Claude Code");
  assert.equal(pickBackend("agy:gpt-oss-120b").backend.name, "antigravity", "not Codex");
  assert.equal(pickBackend("agy").backend.name, "antigravity");
});

test("headless: stream-json, the model and level as flags, read-only plans, a folder of its own for MCP", () => {
  const ro = agy.build({ model: "agy:gemini-4-argon", system: "be brief", prompt: "hi",
    opts: { cwd: "/tmp", sandbox: "read-only", effort: "high", session: "c-1", mcpUrl: "http://127.0.0.1:1/mcp/tok" } });
  const a = ro.args;
  assert.equal(a[0], "-p");
  assert.match(a[1], /^<instructions>\nbe brief\n<\/instructions>\n\nhi$/);
  assert.equal(a[a.indexOf("--output-format") + 1], "stream-json");
  assert.equal(a[a.indexOf("--model") + 1], "gemini-4-argon");
  assert.equal(a[a.indexOf("--effort") + 1], "high");
  assert.equal(a[a.indexOf("--mode") + 1], "plan");
  assert.equal(a[a.indexOf("--conversation") + 1], "c-1");
  const dir = a[a.indexOf("--add-dir") + 1];
  const file = join(dir, ".agents", "mcp_config.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).mcpServers.taksim, { serverUrl: "http://127.0.0.1:1/mcp/tok" });
  // Windows keeps a user's files to that user by its own ACLs; POSIX modes say nothing there
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o077, 0, "the token url is the person's alone");
  const rw = agy.build({ model: "agy", prompt: "hi", opts: { cwd: "/tmp" } }).args;
  assert.ok(rw.includes("--dangerously-skip-permissions") && !rw.includes("--model"), "the CLI's own model; a writer may act");
  assert.equal(mcpDir("http://x/mcp/a"), mcpDir("http://x/mcp/a"), "the same servers share a folder");
});

test("stream-json: the conversation id, text as it comes, the answer and its usage; a tool step is an activity", () => {
  const st = { text: "", session: null, usage: { input: 0, output: 0 }, error: null };
  let shown = "";
  const on = (t) => (shown += t);
  agy.parse({ event: "init", conversation_id: "c-9", init: { model: "gemini-4-argon" } }, st, on);
  const tool = { event: "step_update", step_update: { conversation_id: "c-9", step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { parameters: { CommandLine: "ls -la" } } } };
  agy.parse(tool, st, on);
  agy.parse({ event: "step_update", step_update: { conversation_id: "c-9", step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: "It is " } }, st, on);
  agy.parse({ event: "step_update", step_update: { conversation_id: "c-9", step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "empty.\n" } }, st, on);
  agy.parse({ event: "result", result: { conversation_id: "c-9", status: "SUCCESS", response: "It is empty.\n", usage: { input_tokens: 10, output_tokens: 4 } } }, st, on);
  assert.equal(st.session, "c-9");
  assert.equal(shown, "It is empty.\n");
  assert.deepEqual(st.usage, { input: 10, output: 4 });
  assert.equal(st.error, null);
  assert.deepEqual(activityOf(tool), [{ id: "c-9:2", label: "run_command", detail: "ls -la", status: "running" }]);
  assert.equal(activityOf({ ...tool, step_update: { ...tool.step_update, state: "ERROR" } })[0].status, "error");
  const failed = { text: "", usage: {}, error: null };
  agy.parse({ event: "result", result: { status: "ERROR", response: "" } }, failed, () => {});
  assert.equal(failed.error, "antigravity error");
});
