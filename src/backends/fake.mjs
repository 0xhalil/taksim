// Deterministic test backend (TAKSIM_FAKE=1). See fake-cli.mjs for the models.

import { join } from "node:path";
import { CHAT_DIR, ROOT } from "../config.mjs";

export default {
  name: "fake",
  cmd: [process.execPath, join(ROOT, "src/backends/fake-cli.mjs")],
  models: ["fake-echo", "fake-activity", "fake-native-tasks", "fake-args", "fake-wait", "fake-delegate", "fake-slow", "fake-error", "fake-crash", "fake-commit", "fake-ide"],
  defaultModel: "fake-echo",
  matches: (m) => m.startsWith("fake"),
  maxConcurrency: Number(process.env.TAKSIM_FAKE_CONCURRENCY || 2),
  hooks: true,
  readyHook: true,
  ownSessionIds: true,

  // an agent whose system prompt mentions DIALOG starts with a screen that needs Enter, like a trust prompt
  interactive({ session, mcpUrl, hookUrl, system }) {
    const args = [join(ROOT, "src/backends/fake-tui.mjs"), "--hook", hookUrl, "--mcp", mcpUrl, "--session", session];
    if (/DIALOG/.test(system)) args.push("--dialog");
    return { file: process.execPath, args, env: {} };
  },

  build({ model, system, prompt, opts }) {
    const args = ["--model", model];
    if (opts.session) args.push("--session", opts.session);
    if (system) args.push("--system", system);
    if (opts.mcpUrl) args.push("--mcp", opts.mcpUrl);
    return { args, cwd: opts.cwd || CHAT_DIR, stdin: prompt };
  },

  parse(ev, st, onText) {
    if (ev.type === "session") st.session = ev.id;
    else if (ev.type === "delta") onText(ev.text);
    else if (ev.type === "result") { st.text = ev.text; st.usage = ev.usage; }
    else if (ev.type === "error") st.error = ev.message;
  },
};
