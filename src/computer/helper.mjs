// The engine's line to taksim-computer (native/Sources/TaksimComputer), the small program inside Taksim.app that
// takes screenshots and moves the mouse and keyboard. One process serves every agent, one command at a time:
// JSON lines in, JSON lines out. macOS grants Screen Recording and Accessibility to the app that started the
// engine, so the helper works with the app's permissions.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ROOT } from "../config.mjs";

const candidates = () => [
  process.env.TAKSIM_COMPUTER_HELPER,                           // set by the app (and the tests)
  join(ROOT, "../../MacOS/taksim-computer"),                    // a packaged app: the engine is in Contents/Resources/engine
  join(ROOT, "native/build/Taksim.app/Contents/MacOS/taksim-computer"),
  join(ROOT, "native/.build/release/taksim-computer"),
  join(ROOT, "native/.build/debug/taksim-computer"),
].filter(Boolean);

export const helperPath = () => (process.platform === "darwin" || process.env.TAKSIM_COMPUTER_HELPER ? candidates().find((p) => existsSync(p)) : null) || null;

let proc = null; // { child, pending: Map<id, {ok, fail, timer}>, seq }

function start() {
  const path = helperPath();
  if (!path) throw new Error("taksim-computer isn't built; native/scripts/build-app.sh builds it into the app.");
  const child = spawn(path, [], { stdio: ["pipe", "pipe", "ignore"] });
  const p = { child, pending: new Map(), seq: 0 };
  createInterface({ input: child.stdout }).on("line", (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    const w = p.pending.get(m.id);
    if (!w) return;
    p.pending.delete(m.id);
    clearTimeout(w.timer);
    if (m.ok) w.ok(m); else w.fail(Object.assign(new Error(m.error || "the helper failed"), { code: m.error }));
  });
  const gone = () => {
    if (proc === p) proc = null;
    for (const w of p.pending.values()) { clearTimeout(w.timer); w.fail(new Error("taksim-computer stopped")); }
    p.pending.clear();
  };
  child.on("exit", gone);
  child.on("error", gone);
  child.stdin.on("error", () => {});
  return p;
}

/** runs one helper command; rejects with err.code "screen-recording" / "accessibility" when macOS hasn't allowed it */
export function helper(cmd, args = {}, timeoutMs = 20000) {
  if (!proc) proc = start();
  const p = proc, id = ++p.seq;
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => { p.pending.delete(id); fail(new Error(`taksim-computer did not answer "${cmd}" in ${timeoutMs / 1000}s`)); }, timeoutMs);
    p.pending.set(id, { ok, fail, timer });
    p.child.stdin.write(JSON.stringify({ id, cmd, ...args }) + "\n");
  });
}

export function stopHelper() {
  const p = proc;
  proc = null;
  if (p) { p.child.stdin.end(); p.child.kill(); }
}
