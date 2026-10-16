// How each CLI's pre-tool hook reads a tool call and takes an answer (permission-hook.mjs). A call is put in
// Claude's words ({ tool: "Bash", input: { command } }, Edit/Write with file_path, WebFetch with url), so the chat
// asks about it the same way whichever CLI runs, and "allow this kind" covers a program (npm, git) for all of them.
//
// Sources (checked 2026-10-16):
//   codex   PreToolUse: tool_name/tool_input; Bash, apply_patch, mcp__server__tool. Deny with
//           hookSpecificOutput.permissionDecision "deny" + permissionDecisionReason (learn.chatgpt.com/docs/hooks)
//   gemini  BeforeTool: tool_name/tool_input; deny with { decision: "deny", reason } (geminicli.com/docs/hooks/reference)
//   copilot preToolUse: toolName/toolArgs; { permissionDecision, permissionDecisionReason }
//           (docs.github.com/en/copilot/reference/hooks-reference)
//   opencode tool.execute.before: input.tool, output.args; a throw blocks the call (opencode.ai/docs/plugins)

const SHELL = /^(bash|shell|run_shell_command|exec_command|local_shell|powershell)$/i;
const EDIT = /^(apply_patch|edit|multiedit|write|write_file|replace|create|str_replace(_editor|_based_edit_tool)?|patch|notebookedit|notebook_edit|insert)$/i;
// what only looks, or only keeps the turn's own notes and questions (tool names as each CLI reports them)
const READ = /^(read|read_file|read_many_files|view|glob|grep|grep_search|search_file_content|list_directory|ls|list|find|codebase_search|web_search|google_web_search|websearch|todoread|todowrite|write_todos|update_todo|update_todos|update_plan|task|think|report_intent|ask_user|question|enter_plan_mode|exit_plan_mode|skill|activate_skill|lsp|list_bash|read_bash|read_agent|list_agents|list_mcp_resources|list_mcp_resource_templates|read_mcp_resource)$/i;
const WEB = /^(web_fetch|webfetch|fetch|fetch_url)$/i;

const parse = (v) => { if (typeof v !== "string") return v && typeof v === "object" ? v : {}; try { return JSON.parse(v); } catch { return { value: v }; } };
const first = (o, ...keys) => keys.map((k) => o?.[k]).find((v) => typeof v === "string" && v);

/** the files an apply_patch touches ("*** Update File: a/b.js") */
const patchFiles = (patch) => [...String(patch || "").matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1].trim());

/** a call in Claude's words, with its kind: read, edit, shell, web, taksim, mcp or other */
export function normalize(name, rawInput, { server } = {}) {
  const tool = String(name || "");
  const input = parse(rawInput);
  if (server === "taksim" || /^mcp__?taksim_|^taksim[_-]/i.test(tool)) return { kind: "taksim", tool, input };
  if (SHELL.test(tool)) {
    const cmd = Array.isArray(input.command) ? input.command.join(" ") : first(input, "command", "cmd", "script", "value") || "";
    return { kind: "shell", tool: "Bash", input: { command: cmd } };
  }
  if (/^apply_patch$/i.test(tool)) {
    const files = patchFiles(first(input, "command", "patch", "input", "value"));
    return { kind: "edit", tool: "Edit", input: { file_path: files.join(", ") } };
  }
  if (EDIT.test(tool)) return { kind: "edit", tool: /write|create/i.test(tool) ? "Write" : "Edit", input: { file_path: first(input, "file_path", "filePath", "path", "absolute_path", "target_file") || "" } };
  if (WEB.test(tool)) return { kind: "web", tool: "WebFetch", input: { url: first(input, "url", "prompt") || "" } };
  if (READ.test(tool)) return { kind: "read", tool, input };
  if (/^mcp__/.test(tool) || server) return { kind: "mcp", tool, input };
  return { kind: "other", tool, input };
}

export const ADAPTERS = {
  codex: {
    read: (p) => normalize(p.tool_name, p.tool_input),
    // allow: nothing to add, the CLI goes on as it would
    write: (a, out) => { if (a.behavior !== "allow") out.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: a.message || "the user declined" } })); },
  },
  gemini: {
    read: (p) => normalize(p.tool_name, p.tool_input, { server: p.mcp_context?.server_name }),
    write: (a, out) => out.write(JSON.stringify(a.behavior === "allow" ? { decision: "allow" } : { decision: "deny", reason: a.message || "the user declined" })),
  },
  copilot: {
    read: (p) => normalize(p.toolName ?? p.tool_name, p.toolArgs ?? p.tool_input),
    write: (a, out) => out.write(JSON.stringify(a.behavior === "allow" ? { permissionDecision: "allow" } : { permissionDecision: "deny", permissionDecisionReason: a.message || "the user declined" })),
  },
};
