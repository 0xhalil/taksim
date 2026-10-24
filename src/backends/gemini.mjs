// Gemini CLI: `gemini -p --output-format stream-json` headless, its TUI in a terminal node.
// The CLI ignores system settings files not owned by root, so taksim's part lives in the user settings of the
// accounts taksim makes (GEMINI_CLI_HOME, see accounts.mjs): the taksim MCP server at $TAKSIM_MCP_URL and hooks
// that post to $TAKSIM_HOOK_URL, both set per agent here (the hooks only where it is set: terminal sessions).
// The user's own ~/.gemini is never touched, so this computer's own Gemini login runs without taksim's tools.
// Signing in is the CLI's own: a Google login in the account's folder, or an API key (accounts.mjs).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CHAT_DIR, splitCmd } from "../config.mjs";
import { asksPermission, permissionEnv, hookCommand, HOOK_TIMEOUT_S } from "../term/permission-hook.mjs";

const hook = (event) => ({ hooks: [{ type: "command",
  command: `[ -n "$TAKSIM_HOOK_URL" ] && curl -s -m 5 -X POST -H 'content-type: application/json' --data-binary @- "$TAKSIM_HOOK_URL/${event}" >/dev/null 2>&1; true` }] });

/** what taksim adds to a Gemini account's settings.json: the same for every agent, the urls come from the env */
export const TAKSIM_SETTINGS = {
  mcpServers: { taksim: { httpUrl: "$TAKSIM_MCP_URL", trust: true, timeout: 15 * 60 * 1000 } },
  hooks: { SessionStart: [hook("ready")], BeforeAgent: [hook("start")], AfterAgent: [hook("stop")],
    // Manual / Accept edits: asks the person before a tool runs, only in runs that set the url (permission-hook.mjs)
    BeforeTool: [{ matcher: "*", hooks: [{ type: "command", timeout: HOOK_TIMEOUT_S * 1000,
      command: `[ -z "$TAKSIM_PERMISSION_URL" ] && exit 0; exec $TAKSIM_PERMISSION_HOOK` }] }] },
};

/**
 * A Google login (a Google AI Pro / Ultra plan, the one Antigravity uses too) is overridden by a service account
 * the shell exports for other work: with GOOGLE_APPLICATION_CREDENTIALS set the CLI signs in as that account and
 * fails on its Cloud project ("Cloud Code Private API has not been used"). Only Vertex AI uses it, so every other
 * sign-in gets it blanked.
 */
export function googleLoginEnv(dir = null) {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_GENAI_USE_VERTEXAI === "true") return {};
  let type = null;
  try { type = JSON.parse(readFileSync(join(dir || homedir(), ".gemini", "settings.json"), "utf8")).security?.auth?.selectedType; } catch {}
  return type === "vertex-ai" ? {} : { GOOGLE_APPLICATION_CREDENTIALS: "" };
}

export default {
  name: "gemini",
  cmd: splitCmd(process.env.TAKSIM_GEMINI_BIN || "gemini"),
  // "gemini" is the CLI's own default (it picks Pro or Flash as the plan allows); the rest are its usual ids
  models: ["gemini", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite",
    ...(process.env.TAKSIM_GEMINI_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean)],
  defaultModel: "gemini",
  matches: (m) => m.startsWith("gemini"),
  maxConcurrency: Number(process.env.TAKSIM_GEMINI_CONCURRENCY || 2),
  hooks: true,          // BeforeAgent / AfterAgent report terminal turns
  // Manual and Accept edits ask through a BeforeTool hook, which lives in the settings of taksim's Gemini accounts
  permissions: ["auto", "default", "acceptEdits"], permissionsNeedAccount: true,
  readyHook: true,      // SessionStart says the TUI is up
  ownSessionIds: true,  // --session-id names a new session; --resume <uuid> continues it

  build({ model, system, prompt, opts }) {
    const args = ["--output-format", "stream-json", "--skip-trust"];
    if (model !== "gemini") args.push("-m", model);
    // plan = read-only; auto_edit lets it change files without asking; yolo would also run commands unasked.
    // Manual / Accept edits: the BeforeTool hook asks the person, so the CLI's own confirmation steps aside
    const asks = asksPermission(opts);
    args.push("--approval-mode", !opts.cwd || opts.sandbox === "read-only" ? "plan" : asks ? "yolo" : "auto_edit");
    if (opts.session) args.push(opts.newSession ? "--session-id" : "--resume", opts.session);
    else args.push("--session-id", randomUUID());

    // no system-prompt flag (GEMINI_SYSTEM_MD replaces the whole prompt), so instructions ride in the prompt
    const text = system ? `<instructions>\n${system}\n</instructions>\n\n${prompt}` : prompt;
    args.push("-p", text);
    if (opts.mcp?.off?.length) args.push("--allowed-mcp-server-names", "taksim", ...opts.mcp.cli.map((s) => s.name));
    const env = { ...googleLoginEnv(), ...(opts.mcpUrl ? { TAKSIM_MCP_URL: opts.mcpUrl, TAKSIM_HOOK_URL: "" } : {}),
      ...(asks ? { ...permissionEnv(opts), TAKSIM_PERMISSION_HOOK: hookCommand("gemini") } : { TAKSIM_PERMISSION_URL: "" }) };
    return { args, cwd: opts.cwd || CHAT_DIR, stdin: "", env };
  },

  // The TUI for a terminal node. A new session gets its instructions as its first message (the CLI has no
  // system-prompt flag); a resumed one has them in its history.
  interactive({ model, session, newSession, system, mcpUrl, hookUrl, sandbox, mcp }) {
    const [file, ...pre] = this.cmd;
    const args = [...pre, "--skip-trust", ...(model !== "gemini" ? ["-m", model] : []),
      newSession ? "--session-id" : "--resume", session,
      ...(sandbox === "read-only" ? ["--approval-mode", "plan"] : [])];
    if (newSession && system) args.push("-i", `${INTRO}\n<instructions>\n${system}\n</instructions>`);
    return { file, args, env: { ...googleLoginEnv(), TAKSIM_MCP_URL: mcpUrl, TAKSIM_HOOK_URL: hookUrl } };
  },

  // Google ended Gemini CLI for personal accounts (Code Assist for individuals) and moved them to Antigravity
  explain(stderr) {
    if (/IneligibleTierError|no longer supported for Gemini Code Assist for individuals/.test(stderr)) {
      return "Gemini CLI no longer runs on a personal Google account; Google moved it to Antigravity. Pick an Antigravity model (agy:…) instead.";
    }
  },

  parse(ev, st, onText) {
    if (ev.session_id) st.session = ev.session_id;
    if (ev.type === "message" && ev.role === "assistant" && typeof ev.content === "string") {
      onText(ev.content);
      st.text += ev.content;
    } else if (ev.type === "result") {
      const s = ev.stats || {};
      st.usage = { input: s.input_tokens || s.input || 0, output: s.output_tokens || s.output || 0 };
      if (ev.status && ev.status !== "success") st.error = ev.error?.message || "gemini error";
    } else if (ev.type === "error" && ev.severity !== "warning") {
      st.error = ev.message || "gemini error";
    }
  },
};

/** the first message of a terminal session: its standing instructions, answered with one line */
export const INTRO = "[taksim setup] These are your standing instructions for this session. Reply with one short line saying you're ready; then wait for the user.";
