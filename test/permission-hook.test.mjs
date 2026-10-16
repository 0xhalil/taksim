import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalize, ADAPTERS } from "../src/term/permission-adapters.mjs";
import { decide, asksPermission } from "../src/term/permission-hook.mjs";
import codex from "../src/backends/codex.mjs";
import gemini from "../src/backends/gemini.mjs";
import copilot from "../src/backends/copilot.mjs";
import opencode from "../src/backends/opencode.mjs";

const HOOK = fileURLToPath(new URL("../src/term/permission-hook.mjs", import.meta.url));

test("every CLI's call is put in Claude's words, so the chat asks the same way", () => {
  assert.deepEqual(normalize("Bash", { command: "npm test" }), { kind: "shell", tool: "Bash", input: { command: "npm test" } });
  assert.deepEqual(normalize("run_shell_command", { command: "ls" }).input, { command: "ls" });
  assert.deepEqual(normalize("bash", JSON.stringify({ command: "git push" })).input, { command: "git push" }, "copilot's args may come as a string");
  assert.deepEqual(normalize("apply_patch", { command: "*** Begin Patch\n*** Update File: a.js\n*** Add File: b.js\n*** End Patch" }),
    { kind: "edit", tool: "Edit", input: { file_path: "a.js, b.js" } });
  assert.equal(normalize("write_file", { file_path: "/x" }).tool, "Write");
  assert.equal(normalize("edit", { filePath: "z.ts" }).input.file_path, "z.ts");
  assert.equal(normalize("webfetch", { url: "http://a" }).kind, "web");
  for (const t of ["mcp__taksim__list_agents", "taksim-list_agents", "taksim_list_agents", "mcp_taksim_ask_agent"]) assert.equal(normalize(t, {}).kind, "taksim", t);
  assert.equal(normalize("list_agents", {}, { server: "taksim" }).kind, "taksim");
  assert.equal(normalize("mcp__fs__write", {}).kind, "mcp");
  assert.equal(normalize("read_file", {}).kind, "read");
});

test("Manual asks about edits and commands, Accept edits only about commands, reads never", () => {
  const shell = normalize("Bash", { command: "rm -rf x" }), edit = normalize("apply_patch", {}), read = normalize("read_file", {});
  assert.deepEqual([decide(shell, "default"), decide(edit, "default"), decide(read, "default")], ["ask", "ask", "allow"]);
  assert.deepEqual([decide(shell, "acceptEdits"), decide(edit, "acceptEdits"), decide(normalize("mcp__fs__x", {}), "acceptEdits")], ["ask", "allow", "ask"]);
  assert.equal(decide(shell, "auto"), "allow");
  assert.equal(decide(normalize("taksim_ask_agent", {}), "default"), "allow");
});

test("each CLI gets the answer in its own hook format", () => {
  const out = () => { const o = { s: "", write(x) { this.s += x; } }; return o; };
  const no = { behavior: "deny", message: "the user declined" };
  let o = out(); ADAPTERS.codex.write({ behavior: "allow" }, o); assert.equal(o.s, "", "codex: allow adds nothing");
  o = out(); ADAPTERS.codex.write(no, o);
  assert.deepEqual(JSON.parse(o.s), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "the user declined" } });
  o = out(); ADAPTERS.gemini.write(no, o); assert.deepEqual(JSON.parse(o.s), { decision: "deny", reason: "the user declined" });
  o = out(); ADAPTERS.copilot.write({ behavior: "allow" }, o); assert.deepEqual(JSON.parse(o.s), { permissionDecision: "allow" });
  assert.equal(ADAPTERS.copilot.read({ toolName: "bash", toolArgs: '{"command":"ls"}' }).input.command, "ls");
});

/** the hook as a CLI runs it: the call on stdin, taksim's answer on stdout */
async function runHook(cli, payload, mode, answer) {
  const asked = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    asked.push(JSON.parse(body));
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(answer));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const child = spawn(process.execPath, [HOOK, cli], { env: { ...process.env, TAKSIM_PERMISSION: mode,
      TAKSIM_PERMISSION_URL: `http://127.0.0.1:${server.address().port}/hooks/t/permission` } });
    let out = ""; child.stdout.on("data", (c) => (out += c));
    child.stdin.end(JSON.stringify(payload));
    await new Promise((r) => child.on("close", r));
    return { out, asked };
  } finally { server.close(); }
}

test("the hook asks taksim and passes the person's answer back to the CLI", async () => {
  let r = await runHook("codex", { tool_name: "Bash", tool_input: { command: "curl x" } }, "default", { behavior: "deny", message: "the user said: not now" });
  assert.deepEqual(r.asked, [{ tool_name: "Bash", input: { command: "curl x" } }]);
  assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason, "the user said: not now");
  r = await runHook("gemini", { tool_name: "run_shell_command", tool_input: { command: "ls" } }, "acceptEdits", { behavior: "allow" });
  assert.deepEqual(JSON.parse(r.out), { decision: "allow" });
  r = await runHook("gemini", { tool_name: "write_file", tool_input: { file_path: "a" } }, "acceptEdits", { behavior: "deny" });
  assert.deepEqual([r.asked.length, JSON.parse(r.out).decision], [0, "allow"], "Accept edits lets an edit through without asking");
});

test("a hook that can't reach taksim refuses", async () => {
  const child = spawn(process.execPath, [HOOK, "copilot"], { env: { ...process.env, TAKSIM_PERMISSION: "default", TAKSIM_PERMISSION_URL: "http://127.0.0.1:1/x" } });
  let out = ""; child.stdout.on("data", (c) => (out += c));
  child.stdin.end(JSON.stringify({ toolName: "bash", toolArgs: { command: "ls" } }));
  await new Promise((r) => child.on("close", r));
  assert.equal(JSON.parse(out).permissionDecision, "deny");
});

test("Manual and Accept edits add the hook to each CLI's run; Auto, read-only and chat runs don't", () => {
  const base = { cwd: "/tmp/w", permissionUrl: "http://h/hooks/t/permission", mcpUrl: "http://m", session: "s", newSession: true };
  assert.equal(asksPermission({ ...base, permission: "auto" }), false);
  assert.equal(asksPermission({ ...base, permission: "default", sandbox: "read-only" }), false);
  assert.equal(asksPermission({ ...base, permission: "default", chat: true }), false);
  const manual = { ...base, permission: "default" };

  const c = codex.build({ model: "gpt-6-astra", prompt: "x", opts: manual });
  assert.ok(!c.args.includes("--dangerously-bypass-hook-trust"), "only taksim's own hook is trusted, by its hash");
  assert.match(c.args.find((a) => a.startsWith("hooks.state=")), /pre_tool_use:0:0"=\{trusted_hash="sha256:[0-9a-f]{64}"\}/);
  assert.match(c.args.find((a) => a.startsWith("hooks.PreToolUse=")), /permission-hook\.mjs\\?" codex",timeout=86400/);
  assert.equal(c.env.TAKSIM_PERMISSION, "default");
  assert.ok(!codex.build({ model: "gpt-6-astra", prompt: "x", opts: { ...base, permission: "auto" } }).args.some((a) => a.startsWith("hooks.")));

  const g = gemini.build({ model: "gemini", prompt: "x", opts: manual });
  assert.equal(g.args[g.args.indexOf("--approval-mode") + 1], "yolo", "the hook is the gate, not the CLI's own prompt");
  assert.match(g.env.TAKSIM_PERMISSION_HOOK, /permission-hook\.mjs" gemini$/);
  assert.equal(gemini.build({ model: "gemini", prompt: "x", opts: { ...base, permission: "auto" } }).args.includes("yolo"), false);

  const p = copilot.build({ model: "copilot", prompt: "x", opts: manual });
  assert.ok(p.args.includes("--plugin-dir"));
  assert.equal(p.env.TAKSIM_PERMISSION_URL, base.permissionUrl);

  const o = opencode.build({ model: "opencode-go/glm-5.3", prompt: "x", opts: { ...manual, permission: "acceptEdits" } });
  assert.match(JSON.parse(o.env.OPENCODE_CONFIG_CONTENT).plugin[0], /^file:\/\/.*permission-plugin\.mjs$/);
  assert.equal(o.env.TAKSIM_PERMISSION, "acceptEdits");
});
