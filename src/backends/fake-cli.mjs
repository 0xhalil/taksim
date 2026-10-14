#!/usr/bin/env node
// Stand-in agent CLI for tests. Speaks a tiny JSONL protocol so the real spawn/parse/kill path is exercised.
//   fake-echo   answers "echo: <prompt>" in two deltas
//   fake-args   answers with its own argv/cwd as JSON
//   fake-wait   reports its start time, waits 400ms, then echoes
//   fake-delegate  runs every `CALL {"tool": ..., "args": {...}}` line of the new message against its
//                  MCP url (--mcp) and answers with the results; without CALL lines it answers "delegate: <msg>"
//   fake-slow   reports its pid and a grandchild's pid, then hangs (cancellation tests)
//   fake-error  reports an error event
//   fake-crash  exits non-zero with a stderr message
//   fake-ide    answers the IDE's model features (⌘K edit, ask the codebase, review) with canned results
//   fake-commit answers a fixed one-line commit message (the IDE's ✦ button)

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const model = arg("--model") || "fake-echo";
const session = arg("--session") || `fake-${process.pid}`;
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");

// An account counts as logged out while its config dir has a "logged-out" file.
const loggedOut = () => !process.env.FAKE_CONFIG_DIR || existsSync(join(process.env.FAKE_CONFIG_DIR, "logged-out"));
if (model === "fake-login") { // account login, like `claude auth login`
  process.stdout.write("Opening browser to sign in...\r\nIf it didn't open, visit: https://login.example.test/oauth/authorize?client=fake&state=1\r\n");
  if (process.env.FAKE_CONFIG_DIR && loggedOut()) {
    // like Gemini's TUI: the sign-in lands, the program keeps running
    setTimeout(() => { rmSync(join(process.env.FAKE_CONFIG_DIR, "logged-out"), { force: true }); process.stdout.write("Signed in.\r\n"); }, 400);
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write("Login successful.\r\n");
    setTimeout(() => process.exit(0), 300);
  }
} else if (model === "fake-status") { // account status, like `claude auth status`
  process.stdout.write(JSON.stringify({ loggedIn: !loggedOut(), email: "test@example.com" }) + "\n");
  process.exit(0);
}

let prompt = "";
if (model !== "fake-login") process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", () => {
  emit({ type: "session", id: session });
  if (model === "fake-echo") {
    const text = `echo: ${prompt}`;
    const half = Math.ceil(text.length / 2);
    emit({ type: "delta", text: text.slice(0, half) });
    emit({ type: "delta", text: text.slice(half) });
    emit({ type: "result", text, usage: { input: prompt.length, output: text.length } });
  } else if (model === "fake-activity") {
    emit({ type: "item.started", item: { id: "tool-1", type: "command_execution", command: "npm test" } });
    setTimeout(() => {
      emit({ type: "item.completed", item: { id: "tool-1", type: "command_execution", command: "npm test", exit_code: 0 } });
      emit({ type: "result", text: "Validated", usage: { input: 1, output: 1 } });
    }, 150);
  } else if (model === "fake-native-tasks") {
    const tool = (id, name, input) => emit({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
    const result = (id, output, error = false, newline = true) => {
      const event = { type: "user", tool_use_result: output, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: error }] } };
      if (newline) emit(event); else process.stdout.write(JSON.stringify(event));
    };
    if (/opencode|gemini|copilot|local/.test(prompt)) {
      const backend = ['opencode', 'gemini', 'copilot', 'local'].find((b) => prompt.includes(b));
      const rows = [{ content: "Kaynakları araştır", status: "in_progress" }, { content: "Testleri çalıştır", status: "pending" }];
      const snapshot = (id, status) => {
        if (backend === 'opencode') emit({ type: 'tool_use', part: { type: 'tool', callID: id, tool: 'todowrite', state: { status: status === 'success' ? 'completed' : 'error', input: { todos: rows } } } });
        else if (backend === 'gemini') {
          emit({ type: 'tool_use', tool_id: id, tool_name: 'write_todos', parameters: { todos: rows.map((t) => ({ description: t.content, status: t.status })) } });
          emit({ type: 'tool_result', tool_id: id, status });
        } else {
          emit({ type: 'tool.execution_start', data: { toolCallId: id, toolName: 'update_todo', arguments: { todos: rows } } });
          emit({ type: 'tool.execution_complete', data: { toolCallId: id, success: status === 'success' } });
        }
      };
      snapshot('initial', 'success');
      rows[0].status = 'completed'; snapshot('failed', 'error');
      setTimeout(() => { snapshot('done', 'success'); emit({ type: 'result', text: 'Native progress', usage: { input: 1, output: 1 } }); }, 120);
    } else if (prompt.includes("claude")) {
      tool("create", "TaskCreate", { subject: "Kaynakları araştır", activeForm: "Kaynaklar araştırılıyor" });
      result("create", { task: { id: "1" } });
      tool("active", "TaskUpdate", { taskId: "1", status: "in_progress" }); result("active", {});
      tool("bad", "TaskUpdate", { taskId: "1", status: "completed" }); result("bad", {}, true);
      tool("later", "TaskCreate", { subject: "Testleri çalıştır" }); result("later", { task: { id: "2" } });
      setTimeout(() => {
        emit({ type: "result", text: "Native progress", usage: { input: 1, output: 1 } });
        tool("done", "TaskUpdate", { taskId: "1", status: "completed" }); result("done", {}, false, false);
      }, 120);
    } else {
      // Split a UTF-8 character across chunks, as a real pipe can do.
      const event = { type: "item.started", item: { id: "plan", type: "todo_list", items: [{ text: "Kaynakları araştır", completed: false }, { text: "Testleri çalıştır", completed: false }] } };
      const bytes = Buffer.from(JSON.stringify(event) + "\n"), split = bytes.indexOf(Buffer.from("ı")) + 1;
      process.stdout.write(bytes.subarray(0, split));
      setTimeout(() => process.stdout.write(bytes.subarray(split)), 20);
      setTimeout(() => {
        emit({ type: "result", text: "Native progress", usage: { input: 1, output: 1 } });
        event.type = "item.completed"; event.item.items[0].completed = true;
        process.stdout.write(JSON.stringify(event));
      }, 120);
    }
  } else if (model === "fake-args") {
    const text = JSON.stringify({ argv, cwd: process.cwd(), prompt, configDir: process.env.FAKE_CONFIG_DIR || null });
    emit({ type: "delta", text });
    emit({ type: "result", text, usage: { input: 0, output: 0 } });
  } else if (model === "fake-wait") {
    const start = Date.now();
    emit({ type: "delta", text: JSON.stringify({ start }) });
    setTimeout(() => emit({ type: "result", text: JSON.stringify({ start, end: Date.now(), prompt }), usage: { input: 0, output: 0 } }), 400);
  } else if (model === "fake-delegate") {
    delegate(arg("--mcp"), prompt);
  } else if (model === "fake-slow") {
    const child = spawn("sleep", ["300"], { stdio: "ignore" });
    emit({ type: "delta", text: JSON.stringify({ pid: process.pid, child: child.pid }) });
    setInterval(() => {}, 1000);
  } else if (model === "fake-error") {
    emit({ type: "error", message: "fake failure" });
  } else if (model === "fake-commit") {
    const text = "fake: describe the change";
    emit({ type: "delta", text });
    emit({ type: "result", text, usage: { input: prompt.length, output: text.length } });
  } else if (model === "fake-ide") {
    // the IDE's model features: pick (files), answer, edit, review; each answers what its prompt asks for
    const task = (prompt.match(/^TASK: (\w+)/m) || [])[1];
    let text = "";
    if (task === "pick") text = JSON.stringify(["src/app.py", "nope.txt"]);
    else if (task === "answer") text = JSON.stringify({ answer: "fake answer", hits: [{ path: "src/app.py", line: 5, end_line: 6, why: "compute lives here" }, { path: "other.py", line: 1 }] });
    else if (task === "edit") text = "```py\n" + (prompt.match(/<selected>\n([\s\S]*?)\n<\/selected>/) || [, ""])[1].split("\n").map((l) => `${l}  # edited`).join("\n") + "\n```";
    else if (task === "review") {
      const file = (prompt.match(/^diff --git a\/(\S+)/m) || [, "x"])[1], added = (prompt.match(/^\+(?!\+\+)(.+)$/m) || [, ""])[1];
      text = "Here you go:\n" + JSON.stringify([{ path: file, line: 99, code: added, severity: "error", text: "fake finding" }, { path: "ghost.py", line: 1, text: "dropped" }]);
    }
    emit({ type: "delta", text });
    emit({ type: "result", text, usage: { input: prompt.length, output: text.length } });
  } else {
    process.stderr.write("fake crash\n");
    process.exit(3);
  }
});

async function delegate(url, prompt) {
  const message = prompt.split("</conversation_history>").pop();
  const calls = message.split("\n").filter((l) => l.startsWith("CALL ")).map((l) => JSON.parse(l.slice(5)));
  if (!calls.length) {
    const text = `delegate: ${message.trim()}`;
    emit({ type: "delta", text });
    return emit({ type: "result", text, usage: { input: 0, output: 0 } });
  }
  const results = [];
  for (const [i, c] of calls.entries()) {
    const r = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: c.tool, arguments: c.args || {} } }),
    }).then((res) => res.json());
    const out = r.result ? `${r.result.isError ? "ERROR " : ""}${r.result.content.map((x) => x.text).join("")}` : `RPC ${r.error.message}`;
    results.push(`${c.tool}: ${out}`);
  }
  const text = results.join("\n");
  emit({ type: "delta", text });
  emit({ type: "result", text, usage: { input: 0, output: 0 } });
}
