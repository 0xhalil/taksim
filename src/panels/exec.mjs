// Programs run by panels: argv only (no shell), in their own process group so stopping a panel also stops
// what they started, with a time limit and capped output.

import { spawn, killTree } from "../platform.mjs";

const MAX_OUT = 4 * 1024 * 1024;

function kill(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  killTree(child, "SIGTERM");
  setTimeout(() => { if (child.exitCode === null && child.signalCode === null) killTree(child, "SIGKILL"); }, 2000).unref();
}

const live = new Set();
export function killAllPanelProcs() { for (const c of live) kill(c); }

function start(argv, cwd, env) {
  const [bin, ...args] = argv;
  const child = spawn(bin, args, { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  live.add(child);
  child.on("close", () => live.delete(child));
  return child;
}

// Runs to completion: { code, stdout, stderr }. Rejects when the program can't start or times out.
export function runOnce(argv, { cwd, timeoutMs = 30000, signal, env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = start(argv, cwd, env); } catch (e) { return reject(e); }
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; kill(child); }, timeoutMs);
    const onAbort = () => kill(child);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (c) => { if (stdout.length < MAX_OUT) stdout += c; });
    child.stderr.on("data", (c) => { if (stderr.length < 64 * 1024) stderr += c; });
    child.on("error", (e) => { clearTimeout(timer); reject(e.code === "ENOENT" ? new Error(`program not found: ${argv[0]}`) : e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (timedOut) return reject(new Error(`timed out after ${timeoutMs / 1000}s`));
      resolve({ code, stdout, stderr });
    });
  });
}

// A long-running program whose stdout lines are handed to onLine. Returns { stop }.
export function runStream(argv, { cwd, onLine, onExit }) {
  let child;
  try { child = start(argv, cwd); } catch (e) { queueMicrotask(() => onExit?.(e)); return { stop() {} }; }
  let buf = "", stderr = "", stopped = false;
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, "")); buf = buf.slice(i + 1); }
    if (buf.length > MAX_OUT) buf = "";
  });
  child.stderr.on("data", (c) => { stderr = (stderr + c).slice(-4000); });
  child.on("error", (e) => { if (!stopped) onExit?.(e.code === "ENOENT" ? new Error(`program not found: ${argv[0]}`) : e); stopped = true; });
  child.on("close", (code) => {
    if (buf) onLine(buf);
    if (!stopped) onExit?.(code === 0 ? null : new Error(stderr.trim().split("\n").slice(-3).join("\n") || `exited with code ${code}`));
    stopped = true;
  });
  return { stop() { stopped = true; kill(child); } };
}
