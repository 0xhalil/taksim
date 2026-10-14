// GitHub Copilot CLI: `copilot -p --output-format json`, on the user's Copilot subscription.
// "copilot" lets Copilot pick the model (auto); "copilot:<id>" asks for one (TAKSIM_COPILOT_MODELS=a,b lists more).
// The same CLI also runs local models (local.mjs), so the shared parts live here.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { CHAT_DIR, splitCmd } from "../config.mjs";
import { HOME } from "../canvas/store.mjs";

const onPath = (f) => (process.env.PATH || "").split(delimiter).some((d) => d && existsSync(join(d, f)));
export const COPILOT_CMD = splitCmd(process.env.TAKSIM_COPILOT_BIN || (onPath("copilot") ? "copilot" : "npx --yes @github/copilot"));

// Claude-style hooks in a plugin taksim owns: Copilot reports SessionStart / UserPromptSubmit / Stop with
// Claude's payloads (session_id, prompt, transcript_path). The URL comes from the terminal's environment,
// so one plugin serves every agent; runs without TAKSIM_HOOK_URL (headless) skip it. Stop is posted a
// moment later, in the background: the turn's last message reaches events.jsonl only after the hook returns.
const post = (event) => `curl -s -m 5 -X POST -H 'content-type: application/json' --data-binary "$p" "$TAKSIM_HOOK_URL/${event}"`;
const hook = (event, later) => ({ hooks: [{ type: "command",
  command: `[ -z "$TAKSIM_HOOK_URL" ] && exit 0; p=$(cat); ${later ? `(sleep 1; ${post(event)}) >/dev/null 2>&1 &` : `${post(event)} >/dev/null 2>&1`} true` }] });
export function hookPlugin() {
  const dir = join(HOME, "copilot-plugin");
  const files = {
    ".claude-plugin/plugin.json": { name: "taksim", version: "1.0.0", description: "taksim turn hooks" },
    "hooks/hooks.json": { hooks: { UserPromptSubmit: [hook("start")], Stop: [hook("stop", true)] } },
  };
  for (const [f, data] of Object.entries(files)) {
    const path = join(dir, f), text = JSON.stringify(data, null, 2);
    mkdirSync(join(path, ".."), { recursive: true });
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) writeFileSync(path, text);
  }
  return dir;
}

// Copilot has no system-prompt flag; an agent's instructions go in an AGENTS.md of its own that
// COPILOT_CUSTOM_INSTRUCTIONS_DIRS adds to the project's.
function instructionsDir(session, system) {
  const dir = join(HOME, "copilot-instructions", session);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), system || "");
  return dir;
}

const mcpConfig = (url, mcp) => JSON.stringify({ mcpServers: Object.fromEntries([
  ["taksim", { type: "http", url, tools: ["*"] }],
  ...(mcp?.added || []).map(({ name, spec }) => [name, spec.url ? { type: "http", url: spec.url, tools: ["*"], ...(spec.headers ? { headers: spec.headers } : {}) }
    : { type: "local", command: spec.command, args: spec.args || [], tools: ["*"], ...(spec.env ? { env: spec.env } : {}) }]),
]) });
const mcpOff = (mcp) => (mcp?.off || []).flatMap((n) => ["--disable-mcp-server", n]);

// Everything both Copilot backends share; `wire(model)` maps a taksim model id to the CLI's model and env.
export function copilotBackend({ name, wire, ...rest }) {
  return {
    name,
    cmd: COPILOT_CMD,
    maxConcurrency: 2,
    hooks: true,          // UserPromptSubmit / Stop report terminal turns
    readyHook: true,      // a turn starts only with the start hook, not with a typed line
    // the composer's footer: past the folder trust question (SessionStart waits for the first prompt)
    readyPattern: /\/ commands · \? help/,
    busyPattern: /Esc to cancel|esc to interrupt|Thinking/i,
    ownSessionIds: true,  // --session-id names a new session and resumes an existing one
    ...rest,

    build({ model, system, prompt, opts }) {
      const w = wire(model);
      const agentMode = !!opts.cwd && !opts.chat;
      const args = ["-p", agentMode && system ? `<instructions>\n${system}\n</instructions>\n\n${prompt}` : prompt,
        "--output-format", "json", "--no-ask-user", "--no-auto-update", "-s", ...w.args];
      if (agentMode) {
        // read-only agents plan; the others may edit and run commands in their folder
        args.push(...(opts.sandbox === "read-only" ? ["--plan", "--allow-all-tools", "--deny-tool", "write", "--deny-tool", "shell"] : ["--allow-all-tools"]));
      } else {
        // chat: no tools but taksim's
        args.push("--available-tools", "taksim", "--allow-all-tools", "--disable-builtin-mcps", "--no-custom-instructions");
        if (system) args[1] = `<instructions>\n${system}\n</instructions>\n\n${prompt}`;
      }
      if (opts.mcpUrl) args.push("--additional-mcp-config", mcpConfig(opts.mcpUrl, opts.mcp), "--allow-tool", "taksim",
        ...(opts.mcp?.added || []).flatMap((s) => ["--allow-tool", s.name]), ...mcpOff(opts.mcp));
      if (opts.session) args.push("--session-id", opts.session);
      if (opts.effort) args.push("--reasoning-effort", opts.effort);
      return { args, cwd: opts.cwd || CHAT_DIR, stdin: "", env: { COPILOT_AUTO_UPDATE: "false", ...w.env } };
    },

    // The interactive TUI for a terminal node; tools still ask in the TUI unless the agent is read-only.
    interactive({ model, session, system, mcpUrl, hookUrl, sandbox, effort, mcp }) {
      const [file, ...pre] = this.cmd;
      const w = wire(model);
      const args = [...pre, ...w.args, "--session-id", session, "--no-auto-update", ...(effort ? ["--reasoning-effort", effort] : []),
        "--additional-mcp-config", mcpConfig(mcpUrl, mcp), "--allow-tool", "taksim", ...mcpOff(mcp),
        "--plugin-dir", hookPlugin(), ...(sandbox === "read-only" ? ["--plan"] : [])];
      return { file, args, env: { ...w.env, COPILOT_AUTO_UPDATE: "false", TAKSIM_HOOK_URL: hookUrl,
        COPILOT_CUSTOM_INSTRUCTIONS_DIRS: instructionsDir(session, system) } };
    },

    parse(ev, st, onText) {
      if (ev.sessionId) st.session = ev.sessionId;
      const d = ev.data || {};
      if (ev.type === "assistant.message_delta" && d.deltaContent) {
        onText(d.deltaContent);
      } else if (ev.type === "assistant.message" && typeof d.content === "string" && d.content) {
        // one message per model call; the last one is the answer
        st.text = d.content;
      } else if (ev.type === "assistant.usage" || ev.type === "session.usage") {
        st.usage = { input: d.inputTokens || st.usage.input, output: d.outputTokens || st.usage.output };
      } else if (ev.type === "session.error" || (ev.type === "model.call_final_result" && d.result && d.result !== "success")) {
        st.error = d.message || d.error?.message || d.errorMessage || `${name} error`;
      } else if (ev.type === "result" && ev.exitCode && !st.error && !st.text) {
        st.error = `${name} exited with code ${ev.exitCode}`;
      }
    },
  };
}

const extra = (process.env.TAKSIM_COPILOT_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean);

export default copilotBackend({
  name: "copilot",
  models: ["copilot", ...extra.map((m) => `copilot:${m}`)],
  defaultModel: "copilot",
  matches: (m) => m === "copilot" || m.startsWith("copilot:"),
  maxConcurrency: Number(process.env.TAKSIM_COPILOT_CONCURRENCY || 2),
  resolveModel: (model) => model || "copilot",
  wire: (model) => ({ args: ["--model", model.startsWith("copilot:") ? model.slice(8) : "auto"], env: {} }),
});
