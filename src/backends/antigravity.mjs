// Antigravity CLI (`agy`): Google's agent CLI on the person's Google AI plan (Pro / Ultra), the one the Antigravity
// app uses. It replaced Gemini CLI for personal Google accounts (Gemini CLI now answers "This client is no longer
// supported for Gemini Code Assist for individuals").
//   headless  `agy -p <prompt> --output-format stream-json`: init (conversation_id), step_update (text_delta,
//             tool steps), result (response, usage, status)
//   models    `agy models`: the account's own list, "<slug>\t<name>"; a slug ending in -low/-medium/-high is one
//             model at that thinking level, so taksim shows "agy:<model>" once with its levels (--effort)
//   sessions  --conversation <id> resumes one; a new one names itself in init
//   MCP       a folder of taksim's added with --add-dir, whose .agents/mcp_config.json holds taksim's server and
//             the agent's others: the person's project and ~/.gemini/config stay untouched
// Signing in is the CLI's own: Google Sign-In in its TUI, kept in the keychain.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn } from "../platform.mjs";
import { CHAT_DIR, splitCmd } from "../config.mjs";
import { HOME } from "../canvas/store.mjs";

const onPath = (f) => (process.env.PATH || "").split(delimiter).some((d) => d && existsSync(join(d, f)));
// the installer puts it in ~/.local/bin, which a GUI app's PATH may not have
const LOCAL_BIN = join(homedir(), ".local", "bin", "agy");
export const AGY_CMD = splitCmd(process.env.TAKSIM_AGY_BIN || (onPath("agy") || !existsSync(LOCAL_BIN) ? "agy" : LOCAL_BIN));

export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const PREFIX = "agy:";
const wire = (model) => (model.startsWith(PREFIX) ? model.slice(PREFIX.length) : "");

/** `agy models` → one entry per model, its thinking levels gathered from the slugs that carry them */
export function parseAgyModels(text) {
  const out = new Map();
  for (const line of String(text).split("\n")) {
    const [slug, ...rest] = line.trim().split("\t");
    if (!slug || !/^[a-z0-9][\w.-]*$/i.test(slug) || !rest.length) continue;
    const name = rest.join(" ").trim();
    const m = slug.match(new RegExp(`^(.+)-(${EFFORTS.join("|")})$`));
    const base = m ? m[1] : slug;
    const entry = out.get(base) || { id: PREFIX + base, slug: base, name: m ? name.replace(/\s*\([^)]*\)\s*$/, "") : name, efforts: [] };
    if (m && !entry.efforts.includes(m[2])) entry.efforts.push(m[2]);
    out.set(base, entry);
  }
  for (const e of out.values()) e.efforts.sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
  return [...out.values()];
}

/** the folder an agent's run adds with --add-dir, so the CLI finds taksim's MCP servers in its .agents */
export function mcpDir(url, mcp) {
  const entry = (spec) => spec.url ? { serverUrl: spec.url, ...(spec.headers ? { headers: spec.headers } : {}) }
    : { command: spec.command, args: spec.args || [], ...(spec.env ? { env: spec.env } : {}) };
  const config = JSON.stringify({ mcpServers: Object.fromEntries([
    ["taksim", { serverUrl: url }],
    ...(mcp?.added || []).map(({ name, spec }) => [name, entry(spec)]),
  ]) }, null, 2);
  const dir = join(HOME, "antigravity", createHash("sha256").update(config).digest("hex").slice(0, 16));
  const file = join(dir, ".agents", "mcp_config.json");
  if (!existsSync(file) || readFileSync(file, "utf8") !== config) {
    mkdirSync(join(dir, ".agents"), { recursive: true });
    writeFileSync(file, config, { mode: 0o600 }); // its url holds the agent's token
  }
  return dir;
}

/** who the CLI signed in as, from its newest log that says it */
export function signedInEmail(dir = join(homedir(), ".gemini", "antigravity-cli", "log")) {
  try {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".log")).sort().reverse().slice(0, 20)) {
      const m = [...readFileSync(join(dir, f), "utf8").matchAll(/authenticated successfully as (\S+@\S+)/g)].pop();
      if (m) return m[1];
    }
  } catch { /* no logs yet */ }
  return null;
}

export default {
  name: "antigravity",
  cmd: AGY_CMD,
  // "agy" lets the CLI pick (its last model); the rest come from `agy models` (init)
  models: ["agy"],
  details: [],
  defaultModel: "agy",
  matches: (m) => m === "agy" || m.startsWith(PREFIX),
  maxConcurrency: Number(process.env.TAKSIM_AGY_CONCURRENCY || 2),

  async init() {
    if (process.env.TAKSIM_FAKE === "1" && process.env.TAKSIM_MODEL_DETAILS !== "1") return;
    const [bin, ...pre] = this.cmd;
    const out = await new Promise((resolve) => {
      let buf = "";
      try {
        const child = spawn(bin, [...pre, "models"], { cwd: CHAT_DIR, stdio: ["ignore", "pipe", "ignore"] });
        const timer = setTimeout(() => child.kill(), 30000);
        child.stdout.on("data", (c) => (buf += c));
        child.on("close", () => { clearTimeout(timer); resolve(buf); });
        child.on("error", () => { clearTimeout(timer); resolve(""); });
      } catch { resolve(""); }
    });
    const listed = parseAgyModels(out);
    if (listed.length) { this.details = listed; this.models = ["agy", ...listed.map((d) => d.id)]; }
  },

  checkModel(model) {
    if (this.details.length && model !== "agy" && !this.models.includes(model)) return `unknown Antigravity model "${model}"; see GET /v1/models`;
  },

  build({ model, system, prompt, opts }) {
    const agentMode = !!opts.cwd && !opts.chat;
    const args = ["-p", system ? `<instructions>\n${system}\n</instructions>\n\n${prompt}` : prompt, "--output-format", "stream-json"];
    if (wire(model)) args.push("--model", wire(model));
    if (opts.effort) args.push("--effort", opts.effort);
    // headless can't ask: read-only agents and chats plan, the others may edit and run commands in their folder
    args.push(...(!agentMode || opts.sandbox === "read-only" ? ["--mode", "plan"] : ["--dangerously-skip-permissions"]));
    if (opts.session) args.push("--conversation", opts.session);
    if (opts.mcpUrl) args.push("--add-dir", mcpDir(opts.mcpUrl, opts.mcp));
    return { args, cwd: opts.cwd || CHAT_DIR, stdin: "" };
  },

  // The TUI for a terminal node. No system-prompt flag: a new session gets its instructions as its first message.
  interactive({ model, session, system, mcpUrl, sandbox, effort, mcp }) {
    const [file, ...pre] = this.cmd;
    const args = [...pre, ...(wire(model) ? ["--model", wire(model)] : []), ...(effort ? ["--effort", effort] : []),
      ...(sandbox === "read-only" ? ["--mode", "plan"] : []), ...(mcpUrl ? ["--add-dir", mcpDir(mcpUrl, mcp)] : [])];
    if (session) args.push("--conversation", session);
    else if (system) args.push("-i", `<instructions>\n${system}\n</instructions>\n\nReply with one short line saying you're ready; then wait for the user.`);
    return { file, args, env: {} };
  },

  parse(ev, st, onText) {
    const id = ev.init?.conversation_id || ev.conversation_id || ev.step_update?.conversation_id || ev.result?.conversation_id;
    if (id) st.session = id;
    const s = ev.step_update;
    if (s?.step_type === "agent_response" && s.text_delta) {
      // a new answer after a tool call starts on its own paragraph
      if (st.agyStep !== undefined && st.agyStep !== s.step_index && st.text) { onText("\n\n"); st.text += "\n\n"; }
      st.agyStep = s.step_index;
      onText(s.text_delta);
      st.text += s.text_delta;
    }
    if (ev.event === "result" && ev.result) {
      const r = ev.result;
      if (typeof r.response === "string" && r.response) st.text = r.response;
      st.usage = { input: r.usage?.input_tokens || 0, output: r.usage?.output_tokens || 0 };
      if (r.status && r.status !== "SUCCESS") st.error = r.error?.message || r.error || `antigravity ${String(r.status).toLowerCase()}`;
      else if (!st.text && r.denied_actions?.length) st.error = `antigravity refused ${r.denied_actions.map((d) => d.display_name || d.action).join(", ")} (read-only)`;
    } else if (ev.event === "error") {
      st.error = ev.error?.message || ev.message || "antigravity error";
    }
  },
};
