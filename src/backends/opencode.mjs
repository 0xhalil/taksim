// opencode: `opencode run --format json`. Models are provider/model, listed by `opencode models`.

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { CHAT_DIR, splitCmd } from "../config.mjs";
import { asksPermission, permissionEnv, PLUGIN } from "../term/permission-hook.mjs";

/** opencode's mcp entries for an agent's added servers, and the user's own ones it turned off */
function opencodeServers(mcp) {
  const entry = (spec) => spec.url ? { type: "remote", url: spec.url, ...(spec.headers ? { headers: spec.headers } : {}) }
    : { type: "local", command: [spec.command, ...(spec.args || [])], ...(spec.env ? { environment: spec.env } : {}) };
  return Object.fromEntries([
    ...(mcp?.added || []).map(({ name, spec }) => [name, entry(spec)]),
    ...(mcp?.offSpecs || []).map(({ name, spec }) => [name, { ...entry(spec), enabled: false }]),
  ]);
}

export default {
  name: "opencode",
  cmd: splitCmd(process.env.TAKSIM_OPENCODE_BIN || "opencode"),
  models: [], // filled by init()
  defaultModel: process.env.TAKSIM_OPENCODE_MODEL || "opencode-go/glm-5.3",
  matches: (m) => m.includes("/"),
  maxConcurrency: Number(process.env.TAKSIM_OPENCODE_CONCURRENCY || 2),
  permissions: ["auto", "default", "acceptEdits"], // Manual and Accept edits ask through taksim's plugin

  async init() {
    const [bin, ...pre] = this.cmd;
    const out = await new Promise((resolve) => {
      const child = spawn(bin, [...pre, "models"], { cwd: CHAT_DIR, stdio: ["ignore", "pipe", "ignore"] });
      let buf = "";
      child.stdout.on("data", (c) => (buf += c));
      child.on("close", () => resolve(buf));
      child.on("error", () => resolve(""));
    });
    this.models = out.split("\n").map((l) => l.trim()).filter((l) => /^[\w.-]+\/[\w.:-]+$/.test(l))
      .sort((a, b) => a.includes("free") - b.includes("free")); // subscription models first
  },

  // Once the model list is known, reject typos up front instead of opencode's opaque server error.
  checkModel(model) {
    if (this.models.length && !this.models.includes(model)) {
      return `unknown opencode model "${model}"; see GET /v1/models`;
    }
  },

  build({ model, system, prompt, opts }) {
    const args = ["run", "--format", "json", "-m", model, "--dir", opts.cwd || CHAT_DIR];
    let text = prompt;
    const config = {};
    if (opts.mcpUrl) config.mcp = { taksim: { type: "remote", url: opts.mcpUrl, timeout: 15 * 60 * 1000 }, ...opencodeServers(opts.mcp) };
    if (!opts.cwd || opts.chat) {
      // Chat mode: an inline tool-less agent (except the taksim tools) whose prompt is the caller's system prompt.
      config.agent = { "taksim-chat": {
        mode: "primary", prompt: system || "You are a helpful assistant.", tools: { "*": false, "taksim_*": true },
        permission: { edit: "deny", bash: "deny", webfetch: "deny" } } };
      args.push("--agent", "taksim-chat");
    } else {
      // "plan" is opencode's read-only agent; the default "build" agent can edit and run commands.
      if (opts.sandbox === "read-only") args.push("--agent", "plan");
      if (system) text = `<instructions>\n${system}\n</instructions>\n\n${prompt}`;
    }
    // Manual / Accept edits: taksim's plugin asks the person before a tool runs (permission-plugin.mjs)
    const asks = asksPermission(opts);
    if (asks) config.plugin = [pathToFileURL(PLUGIN).href];
    if (opts.session) args.push("--session", opts.session);
    if (opts.effort) args.push("--variant", opts.effort);
    args.push("--", text);
    const env = { ...(Object.keys(config).length ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) } : {}), ...(asks ? permissionEnv(opts) : {}) };
    return { args, cwd: opts.cwd || CHAT_DIR, stdin: "", env };
  },

  parse(ev, st, onText) {
    if (ev.sessionID) st.session = ev.sessionID;
    if (ev.type === "text" && ev.part?.text) {
      // whole text parts, not token deltas; the last one is the answer
      if (st.text) onText("\n\n");
      onText(ev.part.text);
      st.text = ev.part.text;
    } else if (ev.type === "step_finish") {
      const t = ev.part?.tokens || {};
      st.usage = {
        input: st.usage.input + (t.input || 0) + (t.cache?.read || 0),
        output: st.usage.output + (t.output || 0) + (t.reasoning || 0),
      };
    } else if (ev.type === "error") {
      st.error = ev.error?.data?.message || ev.error?.name || "opencode error";
    }
  },
};
