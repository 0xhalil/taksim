// Runs one backend CLI invocation, with per-backend concurrency gates.

import { TaskEvents } from "./backends/tasks.mjs";
import { activityOf } from "./backends/activity.mjs";
import { StringDecoder } from "node:string_decoder";
import { spawn, killTree } from "./platform.mjs";
import { cfg } from "./config.mjs";
import { orchestratorNote } from "./backends/index.mjs";

// ---------- concurrency gates (per backend, so an orchestrator can't deadlock on its own workers) ----------
const gates = new Map();
const gate = (b) => {
  if (!gates.has(b.name)) gates.set(b.name, { active: 0, waiting: [] });
  return gates.get(b.name);
};

export function acquire(b, signal) {
  const g = gate(b);
  if (signal?.aborted) return Promise.reject(new Error("cancelled"));
  if (g.active < b.maxConcurrency) { g.active++; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, signal };
    g.waiting.push(entry);
    // a client that disconnected while queued must not burn a slot later
    signal?.addEventListener("abort", () => {
      const i = g.waiting.indexOf(entry);
      if (i >= 0) { g.waiting.splice(i, 1); reject(new Error("cancelled")); }
    }, { once: true });
  });
}

export function release(b) {
  const g = gate(b);
  let next = g.waiting.shift();
  // skip waiters whose client already went away (their abort listener removed them
  // unless the abort fired after the shift; resolve() there is a harmless no-op)
  while (next?.signal?.aborted) next = g.waiting.shift();
  if (next) next.resolve(); else g.active--;
}

export function gateStatus(b) {
  const g = gate(b);
  return { active: g.active, queued: g.waiting.length, max: b.maxConcurrency };
}

// ---------- process groups ----------
// Children start in their own process group so cancelling also stops grandchildren
// (e.g. `npx @openai/codex` -> codex, or tools an agent launched).
const live = new Set();

function killGroup(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  killTree(child, "SIGTERM");
  setTimeout(() => { if (child.exitCode === null && child.signalCode === null) killTree(child, "SIGKILL"); }, 3000).unref();
}

export function killAll() {
  for (const child of live) killGroup(child);
}

// ---------- runner ----------
export function run(backend, { model, system, prompt, opts, onText = () => {}, onLimits, onActivity = () => {}, onTasks = () => {}, taskSeed = [], signal, env: extraEnv }) {
  // a backend that talks to its model itself (local.mjs): no CLI to start
  if (backend.direct) {
    if (signal?.aborted) return Promise.reject(new Error("cancelled"));
    return backend.direct({ model, system, prompt, opts, onText, onActivity, signal })
      .catch((e) => { throw signal?.aborted ? new Error("cancelled") : e; });
  }
  const { args, cwd, stdin, env } = backend.build({ model, system, prompt, opts, note: orchestratorNote() });
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("cancelled"));
    const [bin, ...pre] = backend.cmd;
    const child = spawn(bin, [...pre, ...args], {
      cwd, env: { ...process.env, ...extraEnv, ...env }, stdio: ["pipe", "pipe", "pipe"], detached: true,
    });
    live.add(child);
    const timer = setTimeout(() => killGroup(child), cfg.timeoutMs);
    const onAbort = () => killGroup(child);
    signal?.addEventListener("abort", onAbort);
    const st = { text: "", session: opts.session || null, usage: { input: 0, output: 0 }, error: null };
    const lang = opts.lang || "en";
    let buf = "", stderr = "";
    // a broken or hostile CLI must not balloon the proxy: cap buffered output.
    const MAX_STDERR = 512 * 1024, MAX_LINE_BUF = 4 * 1024 * 1024;
    const addStderr = (c) => {
      stderr += c;
      if (stderr.length > MAX_STDERR) stderr = stderr.slice(-MAX_STDERR);
    };
    const decoder = new StringDecoder("utf8");
    const activities = new Map();
    const taskEvents = new TaskEvents(taskSeed);
    const processLine = (line) => {
      if (!line.trimStart().startsWith("{")) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      try { backend.parse(event, st, onText); } catch { return; }
      let tasks;
      try { tasks = taskEvents.take(event); } catch { tasks = null; }
      if (tasks !== null) onTasks(tasks);
      for (const update of activityOf(event, lang)) {
        const activity = { ...(activities.get(update.id) || { label: lang === "tr" ? "Araç" : "Tool", detail: "" }), ...update };
        activities.set(activity.id, activity);
        onActivity(activity);
      }
    };
    child.stdout.on("data", (chunk) => {
      buf += decoder.write(chunk);
      // no newline in sight (e.g. a huge minified blob): keep only the tail so one
      // line can't grow without bound; JSON lines are still parsed once completed.
      if (buf.length > MAX_LINE_BUF) buf = buf.slice(-MAX_LINE_BUF);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        processLine(line);
      }
    });
    child.stderr.on("data", addStderr);
    child.stdin.on("error", () => {}); // child may exit before reading stdin
    const done = () => { clearTimeout(timer); live.delete(child); signal?.removeEventListener("abort", onAbort); };
    child.on("error", (e) => { done(); reject(e); });
    child.on("close", (code) => {
      buf += decoder.end();
      if (buf.trim()) processLine(buf.trim());
      done();
      for (const activity of activities.values()) if (activity.status === "running")
        onActivity({ ...activity, status: signal?.aborted ? "cancelled" : code === 0 && !st.error ? "done" : "error" });
      if (st.limits) onLimits?.(st.limits); // also when the run failed: a rejected run says why
      try { backend.afterRun?.(st, { ...process.env, ...extraEnv, ...env }); } catch {} // what only the CLI's own files say

      if (signal?.aborted) return reject(new Error("cancelled"));
      if (st.error) return reject(new Error(st.error));
      if (code === 0 || st.text) return resolve(st);
      // a backend may say in plain words what its CLI's error means
      reject(new Error(backend.explain?.(stderr) || stderr.trim().split("\n").slice(-5).join("\n") || `${backend.name} exited with code ${code}`));
    });
    child.stdin.end(stdin);
  });
}
