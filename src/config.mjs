// Runtime configuration from env, shared constants and paths.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// When taksim is started from inside a Claude Code session (its terminal, an agent, the desktop app),
// it inherits that session's internal markers: host auth (ANTHROPIC_BASE_URL + host refresh), child-
// session flags that turn transcript saving off, the host account's ids. Passed on to agent CLIs they
// override each account's own login and break session resume, so drop them before spawning anything.
const INHERITED = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_AGENT_SDK_|CLAUDE_PREVIEW_|MCP_SERVER_CONNECTION_BATCH_SIZE$|MCP_CONNECTION_NONBLOCKING$)/;
export function cleanInheritedEnv(target = process.env) {
  if (!target.CLAUDECODE && !target.CLAUDE_CODE_ENTRYPOINT) return [];
  const removed = Object.keys(target).filter((k) => INHERITED.test(k) && k !== "CLAUDE_CONFIG_DIR");
  if (target.ANTHROPIC_BASE_URL) removed.push("ANTHROPIC_BASE_URL"); // the host session's auth proxy
  for (const k of removed) delete target[k];
  return removed;
}
cleanInheritedEnv();

const env = process.env;

export const cfg = {
  host: env.TAKSIM_HOST || "127.0.0.1",
  port: Number(env.TAKSIM_PORT ?? 8787), // updated to the bound port after listen (tests use 0)
  token: env.TAKSIM_TOKEN || "", // optional bearer / x-api-key check
  allowRemote: env.TAKSIM_ALLOW_REMOTE === "1",
  timeoutMs: Number(env.TAKSIM_TIMEOUT_MS || 30 * 60 * 1000),
  // Unrestricted modes (claude bypassPermissions, codex danger-full-access) only when explicitly enabled.
  allowDangerous: env.TAKSIM_ALLOW_DANGEROUS === "1",
  fake: env.TAKSIM_FAKE === "1", // deterministic test backend, no subscription needed
};

export const baseUrl = () => `http://${cfg.host}:${cfg.port}/v1`;

export const LOOPBACK = ["127.0.0.1", "localhost", "::1", "[::1]"];
export const isLoopback = (host) => LOOPBACK.includes(host);

export const CLAUDE_PERMISSIONS = () =>
  ["default", "acceptEdits", "plan", "auto", ...(cfg.allowDangerous ? ["bypassPermissions"] : [])];
// How a node's own turns ask for permission (Claude Code's modes): auto lets Claude judge, default asks about
// everything, acceptEdits asks about all but file edits. Plan is the chat mode, not one of these.
export const NODE_PERMISSIONS = () => ["auto", "default", "acceptEdits", ...(cfg.allowDangerous ? ["bypassPermissions"] : [])];
export const SANDBOXES = () =>
  ["read-only", "workspace-write", ...(cfg.allowDangerous ? ["danger-full-access"] : [])];
export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];

// Scratch dir for chat-mode runs so agents don't wander around the proxy's own cwd.
export const CHAT_DIR = mkdtempSync(join(tmpdir(), "taksim-chat-"));

export function splitCmd(s) {
  // "a b" and 'a b' stay one argv (so TAKSIM_*_BIN paths with spaces work); quotes don't nest.
  const out = [];
  let cur = "", q = null;
  for (const ch of s.trim()) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === `"` || ch === `'`) q = ch;
    else if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ""; } }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
