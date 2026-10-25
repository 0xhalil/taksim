// What each model is, read from the CLIs themselves where they say it: a name, a line about it, its context
// window and the reasoning efforts it takes (the "thinking" levels a TUI offers with /model or /effort).
//   codex:    ~/.codex/models_cache.json (the list codex fetched; "list" models only, the rest are hidden)
//   opencode: `opencode models --verbose` (name, limits, variants = efforts)
//   claude:   aliases, with the efforts `claude --help` names for --effort
//   antigravity: `agy models` (its init), a model's levels gathered from its -low/-medium/-high slugs
// GET /v1/models gives the list with these details; it refreshes in the background when it gets old.

import { spawn } from "../platform.mjs";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKENDS, listModels } from "./index.mjs";
import { claudeName } from "./claude-names.mjs";

const STALE_MS = 30 * 60 * 1000;
const details = new Map(); // model id -> { name, description, context, efforts, defaultEffort }
let refreshedAt = 0, refreshing = null;

const CLAUDE = {
  opus: { name: "Opus", description: ["Most capable Claude: hard, long jobs", "En güçlü Claude: zor, uzun işler"] },
  sonnet: { name: "Sonnet", description: ["Fast and strong: daily coding", "Hızlı ve güçlü: günlük kodlama"] },
  haiku: { name: "Haiku", description: ["Fastest and lightest", "En hızlı ve hafif"] },
  fable: { name: "Fable", description: null },
};
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const backend = (name) => BACKENDS.find((b) => b.name === name);

// a program's stdout, or "" when it fails or takes too long
function output(cmd, args, ms = 20000) {
  return new Promise((resolve) => {
    let buf = "", done = false;
    const finish = () => { if (!done) { done = true; resolve(buf); } };
    try {
      const child = spawn(cmd[0], [...cmd.slice(1), ...args], { stdio: ["ignore", "pipe", "ignore"] });
      const timer = setTimeout(() => { child.kill(); finish(); }, ms);
      child.stdout.on("data", (c) => (buf += c));
      child.on("close", () => { clearTimeout(timer); finish(); });
      child.on("error", () => { clearTimeout(timer); buf = ""; finish(); });
    } catch { finish(); }
  });
}

export function readCodexCache(file = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "models_cache.json")) {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return [];
    const models = JSON.parse(readFileSync(file, "utf8")).models || [];
    return models.filter((m) => m?.slug && m.visibility !== "hide")
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((m) => ({ id: m.slug, name: m.display_name || m.slug, description: m.description || null,
        context: m.context_window || null, efforts: (m.supported_reasoning_levels || []).map((r) => r.effort || r).filter((e) => typeof e === "string"),
        defaultEffort: m.default_reasoning_level || null }));
  } catch { return []; }
}

// `opencode models --verbose`: "provider/model" lines, each followed by its JSON
export function parseOpencodeVerbose(text) {
  const out = [];
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const id = lines[i].trim();
    if (!/^[\w.-]+\/[\w.:-]+$/.test(id) || lines[i + 1]?.trim() !== "{") continue;
    let j = i + 1;
    while (j < lines.length && lines[j] !== "}") j++;
    try {
      const m = JSON.parse(lines.slice(i + 1, j + 1).join("\n"));
      out.push({ id, name: m.name || id, description: null, context: m.limit?.context || null,
        efforts: Object.keys(m.variants || {}), defaultEffort: null, reasoning: !!m.capabilities?.reasoning });
    } catch { /* one bad entry */ }
    i = j;
  }
  return out;
}

export function parseClaudeEfforts(help) {
  const m = String(help).match(/--effort\b[\s\S]{0,200}?\(([a-z, ]+)\)/);
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : null;
}

async function refresh() {
  // tests and the demo run on the fake CLI: the real CLIs' lists would only make them depend on this machine
  if (process.env.TAKSIM_FAKE === "1" && process.env.TAKSIM_MODEL_DETAILS !== "1") { refreshedAt = Date.now(); return; }
  const codex = backend("codex");
  if (codex) {
    const listed = readCodexCache();
    for (const d of listed) details.set(d.id, d);
    if (listed.length) codex.models = listed.map((d) => d.id); // the account's current models, not a fixed list
  }
  const claude = backend("claude");
  if (claude && claude.name !== "fake") {
    const efforts = parseClaudeEfforts(await output(claude.cmd, ["--help"], 10000)) || CLAUDE_EFFORTS;
    for (const id of claude.models) details.set(id, { ...(CLAUDE[id] || { name: id, description: null }), context: null, efforts, defaultEffort: null });
  }
  const opencode = backend("opencode");
  if (opencode) {
    for (const d of parseOpencodeVerbose(await output(opencode.cmd, ["models", "--verbose"], 30000))) details.set(d.id, d);
  }
  const agy = backend("antigravity");
  if (agy) {
    await agy.init?.(); // the account's list now, not the one from when the engine started
    for (const d of agy.details || []) details.set(d.id, { name: d.name, description: null, context: null, efforts: d.efforts, defaultEffort: null });
  }
  refreshedAt = Date.now();
}

export function refreshModelDetails() {
  refreshing ||= refresh().catch(() => {}).finally(() => { refreshing = null; });
  return refreshing;
}

// the efforts a model takes; null when unknown (anything goes, the CLI decides)
export function effortsOf(model) {
  const e = details.get(model)?.efforts;
  return e?.length ? e : null;
}

// How much a model costs to run, roughly, from its name: light (fast and cheap: haiku, luna, flash, mini…),
// strong (the most capable and dearest: opus, astra, pro…), standard otherwise. Free and local ones say so.
const LIGHT = /haiku|luna|\bmini\b|nano|flash|lite|small|\b[1-9]b\b/i; // "mini" a word of its own: gemini is not light
const STRONG = /opus|astra|ultra|\bpro\b|-pro|reserve/i;
export function tierOf(id) { return LIGHT.test(id) ? "light" : STRONG.test(id) ? "strong" : "standard"; }
export const isFree = (m) => m.owned_by === "local" || /free/i.test(m.id);

export function describeModels(lang = "en") {
  if (Date.now() - refreshedAt > STALE_MS) refreshModelDetails();
  return listModels().map((m) => {
    const d = details.get(m.id);
    const base = { ...m, ...(m.owned_by === "antigravity" ? { display_name: m.id === "agy" ? "Default" : m.id.replace(/^agy:/, "") } : {}), tier: tierOf(m.id), ...(isFree(m) ? { free: true } : {}) };
    if (!d) return base;
    const desc = Array.isArray(d.description) ? (lang === "tr" ? d.description[1] : d.description[0]) : d.description;
    return { ...base, display_name: claudeName(m.id) || d.name || m.id, description: desc || null, context_window: d.context || null,
      efforts: d.efforts?.length ? d.efforts : null, default_effort: d.defaultEffort || null };
  });
}
