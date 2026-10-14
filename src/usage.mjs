// How much of each login's plan is used: Claude's and Codex's rolling windows (5 hours, a week) and
// Claude's extra-usage spend. Nothing here asks for a token or reads one; the numbers come from what
// the CLIs already say:
//   Claude  the rate_limit_event a `claude -p --output-format stream-json` run prints. Agents' headless
//           runs report it for free; a check (a one-word Haiku run, at most every PROBE_EVERY) fills in
//           a login nobody ran lately.
//   Codex   the rate_limits of the newest token_count event in its session files (CODEX_HOME/sessions).
// Keyed per login: an account's id, or "machine:<cli>" for this computer's own login.

import { spawn } from "node:child_process";
import { openSync, readSync, closeSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CHAT_DIR, cfg, splitCmd } from "./config.mjs";
import { BACKENDS } from "./backends/index.mjs";
import { HOME } from "./canvas/store.mjs";

export const USAGE_BACKENDS = ["claude", "codex"];
const PROBE_EVERY = 10 * 60 * 1000;
const FILE = join(HOME, "usage.json"); // the last numbers, so cards have them right after a restart
const usage = new Map(load()); // key -> { windows, limited, plan?, credits?, checkedAt, source }
const probing = new Map(); // key -> Promise
const listeners = new Set();

export const usageKey = (account, backend) => (account?.dir ? account.id : `machine:${account?.backend || backend}`);
export const onUsage = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

/** the latest numbers per login, with windows that have since reset shown empty */
export function usageView(key) {
  const u = usage.get(key);
  if (!u) return null;
  const now = Date.now();
  return { ...u, windows: u.windows.map((w) => (w.resetsAt && w.resetsAt < now ? { ...w, used: 0, resetsAt: null } : w)) };
}
/** forgets every stored number (the app's reset) */
export function clearUsage() {
  usage.clear();
  try { rmSync(FILE, { force: true }); } catch {}
}
export const allUsage = () => Object.fromEntries([...usage.keys()].map((k) => [k, usageView(k)]));

function load() {
  try { return Object.entries(JSON.parse(readFileSync(FILE, "utf8"))); } catch { return []; }
}
let saving = null;
function save() {
  if (saving) return;
  saving = setTimeout(() => {
    saving = null;
    try { mkdirSync(HOME, { recursive: true }); writeFileSync(FILE + ".tmp", JSON.stringify(Object.fromEntries(usage))); renameSync(FILE + ".tmp", FILE); } catch {}
  }, 1000);
  saving.unref?.();
}

function store(key, u) {
  if (!u) return null;
  usage.set(key, { ...u, checkedAt: Date.now() });
  save();
  const view = usageView(key);
  for (const fn of listeners) { try { fn(key, view); } catch {} }
  return view;
}

const WINDOW_IDS = { five_hour: "5h", seven_day: "week", seven_day_opus: "week_opus", seven_day_sonnet: "week_sonnet", overage: "extra" };
const sec = (t) => (typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : t ? Date.parse(t) || null : null);

/** Claude's rate_limit_event.rate_limit_info, as windows */
export function fromClaude(info) {
  if (!info || typeof info !== "object") return null;
  const windows = [];
  for (const [k, w] of Object.entries(info.unifiedWindows || {})) {
    if (typeof w?.utilization === "number") windows.push({ id: WINDOW_IDS[k] || k, used: w.utilization, resetsAt: sec(w.resetsAt) });
  }
  // the window the event is about, when it isn't one of the above (extra usage: the spend limit)
  const id = WINDOW_IDS[info.rateLimitType] || info.rateLimitType;
  if (id && typeof info.utilization === "number" && !windows.some((w) => w.id === id)) {
    windows.push({ id, used: info.utilization, resetsAt: sec(info.resetsAt) });
  }
  if (!windows.length) return null;
  return { windows, limited: info.status === "rejected", ...(info.isUsingOverage ? { overage: true } : {}), source: "claude" };
}

/** Codex's rate_limits (a token_count event), as windows */
export function fromCodex(rl) {
  if (!rl || typeof rl !== "object") return null;
  const name = (m) => (m === 300 ? "5h" : m === 10080 ? "week" : m >= 1440 ? `${Math.round(m / 1440)}d` : `${Math.round(m / 60)}h`);
  const windows = [rl.primary, rl.secondary].filter((w) => typeof w?.used_percent === "number")
    .map((w) => ({ id: name(w.window_minutes), used: w.used_percent / 100, resetsAt: sec(w.resets_at) }));
  if (!windows.length) return null;
  const credits = rl.credits?.has_credits && !rl.credits.unlimited ? { balance: Number(rl.credits.balance) || 0 } : undefined;
  return { windows, limited: !!(rl.rate_limit_reached_type || rl.spend_control_reached), plan: rl.plan_type || undefined,
    ...(credits ? { credits } : {}), source: "codex" };
}

/** a Claude run's limits, as it printed them */
export function noteClaudeLimits(key, info) { return store(key, fromClaude(info)); }

// ---------- Codex: its session files ----------

/** the newest file under dir (depth-first by name; session folders are YYYY/MM/DD) */
function newestFile(dir, depth = 0) {
  let names;
  try { names = readdirSync(dir).sort().reverse(); } catch { return null; }
  if (depth === 3) {
    let best = null;
    for (const n of names.filter((n) => n.endsWith(".jsonl"))) {
      let t;
      try { t = statSync(join(dir, n)).mtimeMs; } catch { continue; } // vanished mid-scan
      if (!best || t > best.t) best = { f: join(dir, n), t };
    }
    return best?.f || null;
  }
  for (const n of names) { if (/^\d+$/.test(n)) { const f = newestFile(join(dir, n), depth + 1); if (f) return f; } }
  return null;
}

/** the last rate_limits in a session file (read from its end) */
export function lastCodexLimits(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = statSync(file).size, len = Math.min(size, 512 * 1024), buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n").reverse();
    for (const l of lines) {
      if (!l.includes("\"rate_limits\"")) continue;
      try { const rl = JSON.parse(l).payload?.rate_limits; if (rl) return rl; } catch {}
    }
  } catch {} finally { if (fd !== undefined) closeSync(fd); }
  return null;
}

export function readCodex(key, dir) {
  const home = dir || process.env.CODEX_HOME || join(homedir(), ".codex");
  const file = newestFile(join(home, "sessions"));
  return file ? store(key, fromCodex(lastCodexLimits(file))) : null;
}

// ---------- Claude: a one-word check ----------

function claudeCmd() {
  return BACKENDS.find((b) => b.name === "claude")?.cmd || splitCmd(process.env.TAKSIM_CLAUDE_BIN || "claude");
}

/** runs a tiny Haiku turn under the login's env and keeps only its rate_limit_event */
function probeClaude(key, env) {
  const [file, ...pre] = claudeCmd();
  return new Promise((resolve) => {
    const args = [...pre, "-p", "--output-format", "stream-json", "--verbose", "--model", "haiku", "--tools", "",
      "--no-session-persistence", "--max-turns", "1", "--system-prompt", "Reply with one word."];
    let child;
    try { child = spawn(file, args, { cwd: CHAT_DIR, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "ignore"], detached: true }); }
    catch { return resolve(null); }
    let buf = "", got = null;
    const finish = () => { clearTimeout(timer); try { if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill(); } catch {} } resolve(got); };
    const timer = setTimeout(finish, 45000);
    timer.unref?.();
    child.stdout.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.includes("rate_limit_event")) continue;
        try { got = noteClaudeLimits(key, JSON.parse(line).rate_limit_info); } catch {}
        if (got) return finish();
      }
    });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", () => { clearTimeout(timer); resolve(got); });
    child.stdin.on("error", () => {});
    child.stdin.end("ok");
  });
}

/**
 * Fresh numbers for one login. Codex reads its files every time (cheap); Claude runs a check only when
 * nothing reported for PROBE_EVERY, unless forced. `env` points the CLI at the account's config dir.
 */
export async function refreshUsage({ key, backend, dir, env = {}, force = false }) {
  if (backend === "codex") return readCodex(key, dir);
  if (backend !== "claude") return null;
  if (cfg.fake) return usageView(key); // tests never run the real CLI
  const have = usage.get(key);
  if (!force && have && Date.now() - have.checkedAt < PROBE_EVERY) return usageView(key);
  if (!probing.has(key)) probing.set(key, probeClaude(key, env).finally(() => probing.delete(key)));
  return probing.get(key);
}

export function _resetUsage() { usage.clear(); }
