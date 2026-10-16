// Claude Code: `claude -p --output-format stream-json`.

import { baseUrl, CHAT_DIR, splitCmd } from "../config.mjs";
import { recordClaudeModel } from "./claude-names.mjs";

// every tool of the taksim MCP server (a server-level rule, so new tools are covered too)
const TOOLS = ["mcp__taksim"];

// Claude Code hook that forwards the hook's JSON (stdin) to taksim; never fails the turn.
// The URL is server-generated, but always single-quote-escape it: the CLI runs this via a shell.
const shQ = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const hook = (url) => ({ hooks: [{ type: "command",
  command: `curl -s -m 5 -X POST -H 'content-type: application/json' --data-binary @- ${shQ(url)} >/dev/null 2>&1 || true` }] });

/** taksim's server and the agent's others, in Claude Code's --mcp-config shape */
const mcpConfig = (url, servers = []) => JSON.stringify({ mcpServers: Object.fromEntries([
  ["taksim", { type: "http", url }],
  ...servers.map(({ name, spec }) => [name, spec.url ? { type: "http", url: spec.url, ...(spec.headers ? { headers: spec.headers } : {}) }
    : { type: "stdio", command: spec.command, args: spec.args || [], ...(spec.env ? { env: spec.env } : {}) }]),
]) });

export default {
  name: "claude",
  cmd: splitCmd(process.env.TAKSIM_CLAUDE_BIN || "claude"),
  models: ["opus", "sonnet", "haiku", "fable"],
  defaultModel: process.env.TAKSIM_CLAUDE_MODEL || "sonnet",
  permissions: true,    // every node permission mode: its own --permission-mode, asking through mcp__taksim__approve
  matches: (m) => /^(claude|opus|sonnet|haiku|fable)/.test(m),
  maxConcurrency: Number(process.env.TAKSIM_CLAUDE_CONCURRENCY || 3),
  hooks: true,          // start/stop hooks report terminal turns
  readyHook: true,      // SessionStart reports the TUI is past its trust prompt
  ownSessionIds: true,  // --session-id lets us name a new session up front

  // Claude Code takes aliases; map names it may not know (e.g. "sonnet-latest") to the alias.
  resolveModel(model) {
    const m = (model || "").toLowerCase();
    if (m.startsWith("claude-")) return model;
    return this.models.find((a) => m.includes(a)) || this.defaultModel;
  },

  build({ model, system, prompt, opts, note }) {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--model", model];
    // opts.chat forces chat mode even with a cwd (canvas chat agents get a stable directory so their
    // persisted session can be resumed later, e.g. in a terminal)
    if (opts.cwd && !opts.chat) {
      // read-only agents run in plan mode: they can read and reason, not edit or run commands
      const readOnly = opts.sandbox === "read-only";
      args.push("--permission-mode", readOnly ? "plan" : opts.permission || "acceptEdits");
      // a turn that can't answer on a terminal: what the mode would ask about goes to the person in the chat
      // (taksim's approve tool) instead of being refused. auto and bypass don't ask.
      if (opts.mcpUrl && !readOnly && ["default", "acceptEdits"].includes(opts.permission)) args.push("--permission-prompt-tool", "mcp__taksim__approve");
      if (opts.tools) args.push("--tools", opts.tools);
      if (!opts.mcpUrl) {
        args.push("--strict-mcp-config"); // skip the user's MCP connectors in proxied runs
        // Lets the orchestrator reach the other backends through this proxy.
        args.push("--allowedTools", `Bash(curl ${baseUrl()}/*)`, `Bash(curl -s ${baseUrl()}/*)`);
      }
      args.push("--append-system-prompt", [opts.mcpUrl ? "" : note, system].filter(Boolean).join("\n\n"));
    } else {
      args.push("--tools", "");
      if (!opts.persist) args.push("--no-session-persistence");
      args.push("--system-prompt", system || "You are a helpful assistant.");
    }
    if (opts.mcpUrl) {
      // canvas agents: the taksim tools replace the curl note. The config is strict so servers turned off stay
      // off; the user's own servers that are on, and the ones added in taksim, come along (pre-approved: -p
      // can't ask)
      const servers = [...(opts.mcp?.cli || []), ...(opts.mcp?.added || [])];
      args.push("--strict-mcp-config", "--mcp-config", mcpConfig(opts.mcpUrl, servers));
      args.push("--allowedTools", ...TOOLS, ...servers.map((s) => `mcp__${s.name}`));
    }
    if (opts.session) args.push(opts.newSession ? "--session-id" : "--resume", opts.session);
    if (opts.effort) args.push("--effort", opts.effort);
    // ask_agent can legitimately wait for minutes
    const env = opts.mcpUrl ? { MCP_TOOL_TIMEOUT: String(15 * 60 * 1000),
      ...(opts.cwd && !opts.chat && opts.sandbox !== "read-only" ? { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" } : {}) } : undefined;
    return { args, cwd: opts.cwd || CHAT_DIR, stdin: prompt, env };
  },

  // The interactive TUI for a terminal node. The user's own MCP servers and settings stay in effect.
  interactive({ model, session, newSession, system, mcpUrl, hookUrl, sandbox, effort, mcp, permission }) {
    const [file, ...pre] = this.cmd;
    const args = [...pre, "--model", model, newSession ? "--session-id" : "--resume", session,
      ...(effort ? ["--effort", effort] : []),
      ...(sandbox === "read-only" ? ["--permission-mode", "plan"] : permission ? ["--permission-mode", permission] : []),
      // the TUI keeps everything the CLI loads (plugins, claude.ai connectors) unless a server is turned off
      ...(mcp?.off?.length ? ["--strict-mcp-config", "--mcp-config", mcpConfig(mcpUrl, [...mcp.cli, ...mcp.added])]
        : ["--mcp-config", mcpConfig(mcpUrl, mcp?.added || [])]),
      "--allowedTools", ...TOOLS,
      "--append-system-prompt", system,
      "--settings", JSON.stringify({ hooks: { SessionStart: [hook(`${hookUrl}/ready`)],
        UserPromptSubmit: [hook(`${hookUrl}/start`)], Stop: [hook(`${hookUrl}/stop`)] } })];
    return { file, args, env: { MCP_TOOL_TIMEOUT: String(15 * 60 * 1000) } };
  },

  parse(ev, st, onText) {
    if (ev.session_id) st.session = ev.session_id;
    if (ev.type === "system" && ev.subtype === "init") recordClaudeModel(ev.model);
    if (ev.type === "rate_limit_event") st.limits = ev.rate_limit_info; // the plan's windows (src/usage.mjs)
    // how full the context is: what the latest request sent, measured by the API (sub-agents have their own)
    if (ev.type === "assistant" && !ev.parent_tool_use_id && ev.message?.usage) {
      const u = ev.message.usage;
      st.context = { ...st.context, used: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0) };
    }
    if (ev.type === "stream_event" && !ev.parent_tool_use_id) {
      const d = ev.event?.delta;
      if (ev.event?.type === "content_block_delta" && d?.type === "text_delta") onText(d.text);
    } else if (ev.type === "result") {
      if (ev.is_error) st.error = ev.result || "claude error";
      else st.text = ev.result;
      const u = ev.usage || {};
      st.usage = {
        input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        output: u.output_tokens || 0,
      };
      for (const id of Object.keys(ev.modelUsage || {})) recordClaudeModel(id);
      const windows = Object.values(ev.modelUsage || {}).map((m) => m.contextWindow).filter((n) => n > 0);
      if (windows.length && st.context?.used) st.context.window = Math.max(...windows);
    }
  },
};
