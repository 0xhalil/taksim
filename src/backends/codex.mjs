// Codex CLI: `codex exec --json`.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CHAT_DIR, ROOT, splitCmd } from "../config.mjs";
import { asksPermission, permissionEnv, hookCommand, HOOK_TIMEOUT_S } from "../term/permission-hook.mjs";

const tq = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, `\\"`);
const tomlArray = (a) => `[${a.map((x) => `"${tq(x)}"`).join(", ")}]`;
/**
 * -c assignments for taksim's PreToolUse hook and its trust. Codex runs a hook it didn't load from a managed
 * layer only when hooks.state holds its hash: sha256 of the key-sorted JSON of the group (codex-rs config
 * fingerprint.rs), keyed by where the -c layer puts it (checked with codex 0.162.1).
 */
export function codexPermissionHook() {
  const handler = { async: false, command: hookCommand("codex"), timeout: HOOK_TIMEOUT_S, type: "command" };
  const hash = createHash("sha256").update(JSON.stringify({ event_name: "pre_tool_use", hooks: [handler], matcher: ".*" })).digest("hex");
  return ["-c", `hooks.PreToolUse=[{matcher=".*",hooks=[{type="command",command="${tq(handler.command)}",timeout=${HOOK_TIMEOUT_S}}]}]`,
    "-c", `hooks.state={"/<session-flags>/config.toml:pre_tool_use:0:0"={trusted_hash="sha256:${hash}"}}`];
}

/** -c assignments for an agent's MCP servers: the added ones (pre-approved: exec can't ask), the ones turned off */
function mcpArgs(mcp) {
  const out = [];
  for (const { name, spec } of mcp?.added || []) {
    const k = `mcp_servers.${name}`;
    if (spec.url) out.push("-c", `${k}.url="${tq(spec.url)}"`);
    else {
      out.push("-c", `${k}.command="${tq(spec.command)}"`, "-c", `${k}.args=${tomlArray(spec.args || [])}`);
      for (const [ek, ev] of Object.entries(spec.env || {})) if (/^\w+$/.test(ek)) out.push("-c", `${k}.env.${ek}="${tq(ev)}"`);
    }
    out.push("-c", `${k}.default_tools_approval_mode="approve"`);
  }
  for (const name of mcp?.off || []) out.push("-c", `mcp_servers.${name}.enabled=false`);
  return out;
}

export default {
  name: "codex",
  cmd: splitCmd(process.env.TAKSIM_CODEX_BIN || "npx --yes @openai/codex"),
  models: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
  defaultModel: process.env.TAKSIM_CODEX_MODEL || "gpt-6-astra",
  matches: (m) => /^(gpt|codex|o\d)/.test(m),
  maxConcurrency: Number(process.env.TAKSIM_CODEX_CONCURRENCY || 2),
  hooks: true,           // notify reports the end of each terminal turn (there is no start event)
  permissions: ["auto", "default", "acceptEdits"], // Manual and Accept edits ask through a PreToolUse hook
  ownSessionIds: false,  // the thread id arrives with the first notify
  readyPattern: /Ask Codex to do anything/, // composer placeholder: past the update/trust screens
  busyPattern: /esc to interrupt|Working \(/,  // shown while a turn runs

  build({ model, system, prompt, opts }) {
    const agentMode = !!opts.cwd && !opts.chat;
    const sandbox = agentMode ? (opts.sandbox || "workspace-write") : "read-only";
    // values are validated upstream (allowlist + [\w-] session ids), but always TOML-escape:
    // -c takes a dotted key = "value" assignment and a rogue quote would inject keys.
    const tq = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, `\\"`);
    const common = ["--json", "-m", model, "--skip-git-repo-check",
      "-c", `sandbox_mode="${tq(sandbox)}"`, "-c", "notify=[]"];
    if (opts.effort) common.push("-c", `model_reasoning_effort="${tq(opts.effort)}"`);
    if (!agentMode && !opts.persist) common.push("--ephemeral");
    if (opts.mcpUrl) {
      // exec mode can't prompt, so the taksim tools are pre-approved
      common.push("-c", `mcp_servers.taksim.url="${tq(opts.mcpUrl)}"`, "-c", "mcp_servers.taksim.tool_timeout_sec=900",
        "-c", 'mcp_servers.taksim.default_tools_approval_mode="approve"', ...mcpArgs(opts.mcp));
    }
    // Manual / Accept edits: a PreToolUse hook asks the person in the chat before a command, a patch or an MCP
    // tool runs. It is given for this run only, and trusted for this run only, by its hash: only this hook,
    // never another hook the person has not reviewed (as --dangerously-bypass-hook-trust would).
    const asks = asksPermission(opts);
    if (asks) common.push(...codexPermissionHook());
    const args = opts.session
      ? ["exec", "resume", ...common, opts.session, "-"]
      : ["exec", ...common, "-"];
    // codex exec has no system-prompt flag, so instructions ride in the prompt.
    const stdin = system ? `<instructions>\n${system}\n</instructions>\n\n${prompt}` : prompt;
    return { args, cwd: opts.cwd || CHAT_DIR, stdin, ...(asks ? { env: permissionEnv(opts) } : {}) };
  },

  // The interactive TUI for a terminal node; codex has no system-prompt flag, the MCP server's
  // instructions tell it who it is on the canvas.
  interactive({ model, session, mcpUrl, hookUrl, sandbox, effort, mcp }) {
    const [file, ...pre] = this.cmd;
    const tq = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, `\\"`);
    const notify = JSON.stringify([process.execPath, join(ROOT, "src/term/notify.mjs"), `${hookUrl}/stop`]);
    const opts = ["-m", model, "-c", `sandbox_mode="${tq(sandbox === "read-only" ? "read-only" : "workspace-write")}"`,
      "-c", `mcp_servers.taksim.url="${tq(mcpUrl)}"`, "-c", "mcp_servers.taksim.tool_timeout_sec=900",
      "-c", 'mcp_servers.taksim.default_tools_approval_mode="approve"', ...mcpArgs(mcp), "-c", `notify=${notify}`,
      ...(effort ? ["-c", `model_reasoning_effort="${tq(effort)}"`] : [])];
    return { file, args: [...pre, ...(session ? ["resume", ...opts, session] : opts)], env: {} };
  },

  parse(ev, st, onText) {
    if (ev.type === "thread.started") st.session = ev.thread_id;
    else if (ev.type === "item.completed" && ev.item?.type === "agent_message") {
      // Codex emits whole messages, not token deltas; the last one is the answer.
      if (st.text) onText("\n\n");
      onText(ev.item.text);
      st.text = ev.item.text;
    } else if (ev.type === "turn.completed") {
      const u = ev.usage || {};
      st.usage = { input: u.input_tokens || 0, output: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0) };
    } else if (ev.type === "turn.failed" || ev.type === "error") {
      st.error = ev.error?.message || ev.message || "codex error";
    }
  },

  // How full the context is: `codex exec --json` reports only a turn's totals, but the session's own log
  // (CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<session>.jsonl) records the last request and the model's window.
  afterRun(st, env) {
    if (!st.session) return;
    const file = rolloutOf(env.CODEX_HOME || join(homedir(), ".codex"), st.session);
    if (!file) return;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0 && i > lines.length - 400; i--) {
      if (!lines[i].includes('"token_count"')) continue;
      let ev; try { ev = JSON.parse(lines[i]); } catch { continue; }
      const info = (ev.payload || ev).info;
      if (!info?.last_token_usage || !info.model_context_window) continue;
      const u = info.last_token_usage;
      st.context = { used: (u.input_tokens || 0) + (u.output_tokens || 0), window: info.model_context_window };
      return;
    }
  },
};

/** a session's log file: the newest days first, a few weeks back at most */
function rolloutOf(home, session) {
  const root = join(home, "sessions");
  if (!existsSync(root)) return null;
  const desc = (dir) => { try { return readdirSync(dir).filter((n) => /^\d+$/.test(n)).sort().reverse(); } catch { return []; } };
  let days = 0;
  for (const y of desc(root)) for (const m of desc(join(root, y))) for (const d of desc(join(root, y, m))) {
    if (++days > 45) return null;
    const dir = join(root, y, m, d);
    const hit = readdirSync(dir).find((n) => n.endsWith(`${session}.jsonl`));
    if (hit && statSync(join(dir, hit)).isFile()) return join(dir, hit);
  }
  return null;
}
