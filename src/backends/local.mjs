// Local models: whatever a model server on this computer serves (Ollama, LM Studio, llama.cpp, vLLM, Jan), run
// directly, as the server's own chat does: no CLI in between and nothing changed about the model. A model that can
// call tools gets taksim's light tool loop (local-tools.mjs: read, edit, list, write files in the agent's folder, run a
// command) sized to the window the server really opens; one that can't, or keeps calling them wrongly, chats.
// Models are "local:<id>", found by asking each server's /v1/models; TAKSIM_LOCAL_URL=url,url replaces the default
// servers (Ollama :11434, LM Studio :1234).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { TOOLS, READ_ONLY, describe, runTool } from "./local-tools.mjs";
import { HOME } from "../canvas/store.mjs";

// the servers looked at: Ollama's and LM Studio's usual ports, and the ones added in Settings (local-servers.json);
// TAKSIM_LOCAL_URL=url,url replaces them all (tests)
export const BUILT_IN = ["http://127.0.0.1:11434/v1", "http://127.0.0.1:1234/v1"];
const SAVED = join(HOME, "local-servers.json");
const clean = (u) => u.trim().replace(/\/+$/, "");
export function savedServers() {
  try { return JSON.parse(readFileSync(SAVED, "utf8")).servers.filter((u) => typeof u === "string"); } catch { return []; }
}
export function servers() {
  if (process.env.TAKSIM_LOCAL_URL) return process.env.TAKSIM_LOCAL_URL.split(",").map(clean).filter(Boolean);
  return [...new Set([...BUILT_IN, ...savedServers()])];
}
/** a server's address as it is kept: http(s), its /v1 (an OpenAI-compatible server's API) */
export function normalizeServer(input) {
  let s = String(input || "").trim();
  if (/^[a-z][\w+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) return null; // ftp://, file://: not a model server
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!["http:", "https:"].includes(u.protocol) || !u.hostname) return null;
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path.endsWith("/v1") ? path : path + "/v1"}`;
}
export function addServer(input) {
  const url = normalizeServer(input);
  if (!url) return null;
  if (!servers().includes(url) && !savedServers().includes(url)) {
    mkdirSync(HOME, { recursive: true });
    writeFileSync(SAVED, JSON.stringify({ servers: [...savedServers(), url] }, null, 2));
  }
  return url;
}
export function removeServer(url) {
  const left = savedServers().filter((u) => u !== url);
  if (existsSync(SAVED)) writeFileSync(SAVED, JSON.stringify({ servers: left }, null, 2));
  return left;
}
const PREFIX = "local:";
const REFRESH_MS = 30000;
const DEFAULT_WINDOW = 4096; // what a server opens when it doesn't say (Ollama's smallest default)
const MAX_STEPS = 24;        // tool rounds in one turn
const MAX_BAD_CALLS = 3;     // wrong tool calls in a row before the turn goes on as chat

const where = new Map();   // model id -> { base, ollama }
const facts = new Map();   // model id -> { tools, window, max }: read from the server, refreshed when it says more
const unreliable = new Set(); // models whose tool calls kept failing: they chat

// a token is about 3.5 characters of English or code; close enough to keep a prompt inside the window
export const tokens = (s) => Math.ceil(String(s || "").length / 3.5);
const origin = (base) => base.replace(/\/v1$/, "");

async function getJson(url, init) {
  const r = await fetch(url, { signal: AbortSignal.timeout(2500), ...init });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

async function discover() {
  const found = await Promise.all(servers().map(async (base) => {
    try {
      const j = await getJson(`${base}/models`);
      const ollama = await getJson(`${origin(base)}/api/version`).then((v) => !!v.version, () => false);
      return (j.data || []).map((m) => [m.id, { base, ollama }]).filter(([id]) => id);
    } catch { return []; } // not running
  }));
  where.clear();
  for (const [id, s] of found.flat()) if (!where.has(id)) where.set(id, s);
  return [...where.keys()].map((id) => PREFIX + id);
}

/** what the server says about a model: whether it calls tools, the window it opens now, and the most it could take */
export async function modelFacts(id) {
  const s = where.get(id);
  const known = facts.get(id) || { tools: true, window: DEFAULT_WINDOW, max: null };
  if (!s?.ollama) { facts.set(id, known); return known; } // other servers: try tools, assume the small window
  try {
    const show = await getJson(`${origin(s.base)}/api/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: id }) });
    const max = Object.entries(show.model_info || {}).find(([k]) => k.endsWith(".context_length"))?.[1] || null;
    const caps = show.capabilities;
    known.tools = Array.isArray(caps) ? caps.includes("tools") : true;
    known.max = max;
    // the window it runs with now, if it is loaded; else the default it will open (no bigger than the model takes)
    const ps = await getJson(`${origin(s.base)}/api/ps`).catch(() => ({ models: [] }));
    const loaded = (ps.models || []).find((m) => m.name === id || m.model === id);
    known.window = loaded?.context_length || Math.min(known.window || DEFAULT_WINDOW, max || Infinity);
  } catch { /* the server went away: keep what was known */ }
  facts.set(id, known);
  return known;
}

/** every server with what it serves, for Settings: Ollama's models with their size, window and whether they call
 * tools (its /api/tags says all of it); another server's model names */
export async function serverList() {
  const ps = new Map();
  return Promise.all(servers().map(async (base) => {
    const built = BUILT_IN.includes(base) && !process.env.TAKSIM_LOCAL_URL;
    const out = { url: base, builtIn: built || !savedServers().includes(base), running: false, kind: null, models: [] };
    try {
      const listed = await getJson(`${base}/models`);
      out.running = true;
      const tags = await getJson(`${origin(base)}/api/tags`).catch(() => null);
      if (tags?.models) {
        out.kind = "ollama";
        const loaded = await getJson(`${origin(base)}/api/ps`).catch(() => ({ models: [] }));
        for (const m of loaded.models || []) ps.set(m.name, m.context_length);
        out.models = tags.models.map((m) => {
          const max = m.details?.context_length || null;
          const caps = m.capabilities;
          if (Array.isArray(caps)) facts.set(m.name, { ...(facts.get(m.name) || {}), tools: caps.includes("tools"), max,
            window: ps.get(m.name) || Math.min(facts.get(m.name)?.window || DEFAULT_WINDOW, max || Infinity) });
          // the window it really runs with: the loaded one's, else Ollama's default (not the most the model could take)
          return { id: m.name, sizeGB: Math.round((m.size || 0) / 1e8) / 10, params: m.details?.parameter_size || null,
            tools: Array.isArray(caps) ? caps.includes("tools") : null, window: ps.get(m.name) || Math.min(DEFAULT_WINDOW, max || Infinity), max };
        });
      } else {
        out.kind = "openai";
        out.models = (listed.data || []).map((m) => ({ id: m.id, sizeGB: null, params: null, tools: null, window: null, max: null }));
      }
    } catch { /* not running */ }
    return out;
  }));
}

/** an Ollama model gone from this computer (frees its disk) */
export async function deleteModel(id) {
  const s = where.get(id);
  if (!s?.ollama) throw new Error(`${id} isn't an Ollama model here`);
  const r = await fetch(`${origin(s.base)}/api/delete`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: id }) });
  if (!r.ok) throw new Error(`Ollama answered ${r.status}`);
  facts.delete(id);
}

// ---------- one call to the server, streamed ----------

/** Ollama's own chat: content and thinking apart, tool calls whole */
async function ollamaChat(s, model, messages, tools, signal, onText) {
  const r = await fetch(`${origin(s.base)}/api/chat`, { method: "POST", signal, headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true, ...(tools.length ? { tools } : {}) }) });
  if (!r.ok) throw new Error(`the model server answered ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const out = { content: "", thinking: "", calls: [], promptTokens: 0, outputTokens: 0 };
  for await (const line of lines(r.body)) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.error) throw new Error(ev.error);
    const m = ev.message || {};
    if (m.thinking) out.thinking += m.thinking;
    if (m.content) { out.content += m.content; onText(m.content); }
    for (const c of m.tool_calls || []) out.calls.push({ id: c.id || null, name: c.function?.name, args: c.function?.arguments });
    if (ev.done) { out.promptTokens = ev.prompt_eval_count || 0; out.outputTokens = ev.eval_count || 0; }
  }
  return out;
}

/** any OpenAI-compatible server (LM Studio, llama.cpp, vLLM, Jan): server-sent events, tool calls in pieces */
async function openaiChat(s, model, messages, tools, signal, onText) {
  const r = await fetch(`${s.base}/chat/completions`, { method: "POST", signal, headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: messages.map(toOpenAI), stream: true, stream_options: { include_usage: true }, ...(tools.length ? { tools } : {}) }) });
  if (!r.ok) throw new Error(`the model server answered ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const out = { content: "", thinking: "", calls: [], promptTokens: 0, outputTokens: 0 };
  const parts = [];
  for await (const line of lines(r.body)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") break;
    let ev; try { ev = JSON.parse(data); } catch { continue; }
    if (ev.error) throw new Error(ev.error.message || String(ev.error));
    if (ev.usage) { out.promptTokens = ev.usage.prompt_tokens || 0; out.outputTokens = ev.usage.completion_tokens || 0; }
    const d = ev.choices?.[0]?.delta || {};
    const think = d.reasoning_content || d.reasoning;
    if (think) out.thinking += think;
    if (d.content) { out.content += d.content; onText(d.content); }
    for (const t of d.tool_calls || []) {
      const p = parts[t.index ?? parts.length] ||= { id: t.id, name: "", args: "" };
      if (t.id) p.id = t.id;
      if (t.function?.name) p.name += t.function.name;
      if (t.function?.arguments) p.args += t.function.arguments;
    }
  }
  out.calls = parts.filter(Boolean).map((p) => ({ id: p.id || null, name: p.name, args: p.args }));
  return out;
}

// Ollama keeps tool calls' arguments as objects and answers tools by name; the OpenAI shape wants strings and ids
function toOpenAI(m) {
  if (m.role === "assistant" && m.tool_calls) {
    return { role: "assistant", content: m.content || "", tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: "function",
      function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments ?? {}) } })) };
  }
  if (m.role === "tool") return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
  return { role: m.role, content: m.content };
}

async function* lines(body) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}

const parseArgs = (a) => {
  if (a && typeof a === "object") return a;
  try { return JSON.parse(a || "{}"); } catch { return null; }
};

// ---------- the window: what goes in it ----------

/** the tools that fit: the instructions and tools take at most a quarter of the window, the least needed go first */
export function toolsFor(window, system, { readOnly = false } = {}) {
  let list = TOOLS.filter((t) => !readOnly || READ_ONLY.has(t.function.name));
  while (list.length && tokens(system) + tokens(JSON.stringify(list)) > window / 4) list = list.slice(0, -1);
  return list;
}

/** the conversation that fits: newest first until the budget is used, oldest messages dropped */
export function fitHistory(history, budget) {
  const kept = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const t = tokens(history[i].content) + 4;
    if (used + t > budget) break;
    kept.unshift(history[i]);
    used += t;
  }
  return kept;
}

// tool results from earlier rounds shrink once the turn grows past its budget, the newest kept whole
function shrink(messages, budget) {
  const size = () => messages.reduce((n, m) => n + tokens(m.content) + tokens(JSON.stringify(m.tool_calls || "")) + 4, 0);
  for (const m of messages) {
    if (size() <= budget) break;
    if (m.role === "tool" && m.content.length > 200 && m !== messages.at(-1)) m.content = m.content.slice(0, 200) + "… (cut to save room)";
  }
}

// ---------- a turn ----------

async function direct({ model, system, prompt, opts, onText, onActivity, signal }) {
  const id = model.slice(PREFIX.length);
  const s = where.get(id);
  if (!s) throw new Error(`no local model server has ${id} now`);
  const f = await modelFacts(id);
  const window = f.window;
  const agentMode = !!opts.cwd && !opts.chat;
  const tools = agentMode && f.tools && !unreliable.has(id) ? toolsFor(window, system, { readOnly: opts.sandbox === "read-only" }) : [];
  const answerRoom = Math.min(1024, Math.floor(window / 4));
  const historyBudget = window - answerRoom - tokens(system) - tokens(JSON.stringify(tools)) - tokens(prompt);
  const messages = [{ role: "system", content: system }, ...fitHistory(opts.history || [], Math.max(0, historyBudget)), { role: "user", content: prompt }];
  const chat = s.ollama ? ollamaChat : openaiChat;
  const st = { text: "", session: null, usage: { input: 0, output: 0 }, error: null, context: null };
  let bad = 0, live = tools, lastThinking = "";

  for (let step = 0; step < MAX_STEPS; step++) {
    shrink(messages, window - answerRoom);
    const r = await chat(s, id, messages, live, signal, onText);
    st.usage.input += r.promptTokens; st.usage.output += r.outputTokens;
    if (r.promptTokens) st.context = { used: r.promptTokens, window };
    if (r.thinking) lastThinking = r.thinking;
    // Ollama gives tool calls no ids: each gets one of its own, so every call keeps its line in the chat
    r.calls.forEach((c, i) => { c.id ||= `call_${step}_${i}`; });
    if (!r.calls.length) {
      // a thinking model may leave its answer in its reasoning only: that is said instead of nothing
      st.text = r.content.trim() || lastThinking.trim();
      if (!r.content.trim() && st.text) onText(st.text);
      return st;
    }
    messages.push({ role: "assistant", content: r.content, tool_calls: r.calls.map((c) => ({ id: c.id, function: { name: c.name, arguments: parseArgs(c.args) ?? {} } })) });
    for (const c of r.calls) {
      const args = parseArgs(c.args);
      const known = live.some((t) => t.function.name === c.name);
      const activity = { id: c.id, ...describe(c.name, args || {}), status: "running" };
      onActivity(activity);
      const result = !known ? `error: there is no tool "${c.name}" here; the tools are ${live.map((t) => t.function.name).join(", ")}`
        : args === null ? `error: the arguments of ${c.name} weren't valid JSON`
        : await runTool(c.name, args, { cwd: opts.cwd, permission: opts.permission, permissionUrl: opts.permissionUrl, signal,
          maxChars: Math.max(1500, Math.floor(window * 3.5 / 4)) });
      if (signal?.aborted) throw new Error("cancelled");
      const failed = result.startsWith("error:");
      onActivity({ ...activity, status: failed ? "error" : "done" });
      messages.push({ role: "tool", tool_call_id: c.id, tool_name: c.name, content: result });
      // a call it got wrong (a tool that isn't there, broken arguments) is a sign; its own mistakes aren't
      bad = !known || args === null ? bad + 1 : 0;
    }
    if (bad >= MAX_BAD_CALLS) {
      // it can't drive the tools: remembered for this model, and this turn finishes as a chat
      unreliable.add(id);
      live = [];
      messages.push({ role: "user", content: "Tools aren't available now. Answer with what you know so far." });
    }
  }
  st.text = "I stopped after many tool steps; ask me to go on if there's more to do.";
  onText(st.text);
  return st;
}

const backend = {
  name: "local",
  models: [], // filled by init() and kept fresh: a server started later shows up within REFRESH_MS
  defaultModel: "",
  matches: (m) => m.startsWith(PREFIX),
  maxConcurrency: Number(process.env.TAKSIM_LOCAL_CONCURRENCY || 1), // one GPU
  permissions: ["auto", "default", "acceptEdits"], // the loop asks in the chat itself
  direct,

  async init() {
    this.models = await discover();
    setInterval(async () => { this.models = await discover(); }, REFRESH_MS).unref();
  },
  /** looks again now (a server just started, a model just pulled) */
  async refresh() { this.models = await discover(); return this.models; },

  checkModel(model) {
    const id = model.slice(PREFIX.length);
    if (!where.has(id)) {
      return where.size
        ? `unknown local model "${id}"; see GET /v1/models`
        : `no local model server is running (looked at ${servers().join(", ")})`;
    }
  },
};

export default backend;
