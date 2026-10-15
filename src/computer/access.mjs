// Who may use the computer: an agent asks the first time it reaches for the screen, and waits while its node shows
// the display key; the person's one click allows it (and the app asks macOS for Screen Recording and
// Accessibility then, for taksim). The allowance stays with the agent until the person switches it off.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOME } from "../canvas/store.mjs";

const ASK_TIMEOUT_S = Number(process.env.TAKSIM_COMPUTER_ASK_S || 180);
const file = () => join(HOME, "computer.json");

let allowed = null; // Set of agent ids
const asking = new Map(); // agent id -> { waiters: Set<{ok, fail}> }
const missing = new Map(); // agent id -> ["screen" | "accessibility"]: what macOS hasn't allowed yet
const lastAct = new Map(); // agent id -> ms of its last action (the key flashes)

function grants() {
  if (!allowed) {
    try { allowed = new Set(existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")).agents || [] : []); } catch { allowed = new Set(); }
  }
  return allowed;
}
function save() {
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify({ agents: [...grants()] }, null, 2));
}

/** "on", "asking" or null, and what macOS still lacks */
export function computerState(agent) {
  const state = asking.has(agent.id) ? "asking" : grants().has(agent.id) ? "on" : null;
  return state ? { state, ...(missing.get(agent.id)?.length ? { missing: missing.get(agent.id) } : {}), ...(lastAct.has(agent.id) ? { at: lastAct.get(agent.id) } : {}) } : null;
}

/** every agent of a canvas that has (or asks for) the computer */
export function computerView(canvas) {
  const out = {};
  for (const a of canvas.agents.values()) { const s = computerState(a); if (s) out[a.id] = s; }
  return out;
}

const emit = (agent) => agent.canvas?.bus?.emit("computer", { id: agent.id, computer: computerState(agent) });

/** the person's answer: true allows (and wakes an agent that waits), false takes it back or turns the ask down */
export function setComputer(agent, allow) {
  const w = asking.get(agent.id);
  asking.delete(agent.id);
  if (allow) grants().add(agent.id); else { grants().delete(agent.id); missing.delete(agent.id); }
  save();
  if (w) {
    for (const x of w.waiters) allow ? x.ok() : x.fail(new Error("The user did not allow computer control. Do the work another way (browser_ tools for web pages, your shell), or tell them why you need the screen."));
    if (agent.status === "waiting" && !agent.waitingOn?.size) agent.setStatus?.(agent.current ? "running" : "idle");
  }
  emit(agent);
}

/** resolves once the agent may use the computer; the first time, it asks and waits for the person */
export async function requireComputer(agent) {
  if (grants().has(agent.id)) return;
  let w = asking.get(agent.id);
  const first = !w;
  if (!w) { w = { waiters: new Set() }; asking.set(agent.id, w); }
  const signal = agent.current?.ac?.signal;
  let timer, entry, onAbort;
  try {
    await new Promise((ok, fail) => {
      entry = { ok, fail };
      w.waiters.add(entry);
      timer = setTimeout(() => fail(new Error(`The user hasn't allowed computer control within ${ASK_TIMEOUT_S}s (the display key on your node). Do the work another way, or ask them to allow it and try again.`)), ASK_TIMEOUT_S * 1000);
      onAbort = () => fail(new Error("turn was stopped"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (first) { agent.setStatus?.("waiting"); emit(agent); }
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    w.waiters.delete(entry);
    if (!w.waiters.size && asking.get(agent.id) === w) {
      asking.delete(agent.id); // nobody waits any more: the key stops asking
      if (agent.status === "waiting" && !agent.waitingOn?.size) agent.setStatus?.(agent.current ? "running" : "idle");
      emit(agent);
    }
  }
}

/** what macOS refused the helper ("screen" / "accessibility"), or that it allows everything again */
export function noteMissing(agent, list) {
  const before = (missing.get(agent.id) || []).join();
  if (list.length) missing.set(agent.id, list); else missing.delete(agent.id);
  if (before !== list.join()) emit(agent);
}

/** an action happened: the key flashes */
export function noteAct(agent) {
  lastAct.set(agent.id, Date.now());
  emit(agent);
}

/** an agent removed: its allowance goes with it */
export function forgetComputer(id) {
  asking.delete(id); missing.delete(id); lastAct.delete(id);
  if (grants().delete(id)) save();
}

/** for tests and reset: read the file again */
export function resetComputerAccess() { allowed = null; asking.clear(); missing.clear(); lastAct.clear(); }
