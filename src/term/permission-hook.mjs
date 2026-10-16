#!/usr/bin/env node
// A CLI's pre-tool hook for the node permission modes (Manual, Accept edits) of CLIs that have no
// permission-prompt tool of their own (Claude has one: mcp__taksim__approve). The CLI runs this before a tool call
// with the call on stdin; reads, and edits under Accept edits, go through at once, and anything else is asked in
// the chat through POST $TAKSIM_PERMISSION_URL (the same approve flow as Claude's). What comes back is printed in
// the CLI's own hook format. Anything but a clear yes is a no, and so is a hook that can't reach taksim.
//
//   node permission-hook.mjs <codex|gemini|copilot>     env: TAKSIM_PERMISSION_URL, TAKSIM_PERMISSION
// opencode loads permission-plugin.mjs instead, which calls decide() below in-process.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTERS } from "./permission-adapters.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN = join(HERE, "permission-plugin.mjs");
/** a headless agent turn of a node in Manual or Accept edits: its CLI asks through the hook */
export const asksPermission = (opts) => !!opts.permissionUrl && !!opts.cwd && !opts.chat && opts.sandbox !== "read-only"
  && (opts.permission === "default" || opts.permission === "acceptEdits");
export const permissionEnv = (opts) => ({ TAKSIM_PERMISSION_URL: opts.permissionUrl, TAKSIM_PERMISSION: opts.permission });
/** the command a CLI's hook runs (this engine's own Node) */
export const hookCommand = (cli) => `"${process.execPath}" "${join(HERE, "permission-hook.mjs")}" ${cli}`;
/** a person may take a while to answer; the CLIs' own defaults (30–600 s) would let the call through or fail it */
export const HOOK_TIMEOUT_S = 24 * 60 * 60;

/** what kind of call it is: reads and taksim's own tools never ask */
export function decide(call, mode) {
  if (!call || call.kind === "read" || call.kind === "taksim") return "allow";
  if (mode === "acceptEdits" && call.kind === "edit") return "allow";
  if (mode !== "default" && mode !== "acceptEdits") return "allow"; // auto: the CLI's own rules
  return "ask";
}

/** the question in the chat, as Claude's approve tool would put it: { behavior: allow | deny, message } */
export async function askTaksim(url, call) {
  if (!url) return { behavior: "deny", message: "taksim could not be asked" };
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_name: call.tool, input: call.input }) });
    const out = await res.json();
    return out?.behavior === "allow" ? out : { behavior: "deny", message: out?.message || "the user declined" };
  } catch { return { behavior: "deny", message: "taksim could not be asked" }; }
}

async function main() {
  const adapter = ADAPTERS[process.argv[2]];
  if (!adapter) process.exit(0);
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload = {};
  try { payload = JSON.parse(raw || "{}"); } catch { /* nothing to judge */ }
  const call = adapter.read(payload);
  const verdict = decide(call, process.env.TAKSIM_PERMISSION);
  const answer = verdict === "allow" ? { behavior: "allow" } : await askTaksim(process.env.TAKSIM_PERMISSION_URL, call);
  adapter.write(answer, process.stdout);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
