// Conversations started outside taksim, in the coding CLIs themselves (and the Claude app's Code tab): each CLI
// keeps its sessions on disk with the folder they ran in. Listed beside taksim's own past conversations, so every
// AI that worked in a project shows under it, and one begun there is continued here: an agent of that CLI in the
// same folder resumes the same session (Gemini's live in its own home, so its conversation seeds a new session),
// its chat filled from the file. Read only; taksim never changes these files.
//
//   Claude Code  ~/.claude/projects/<folder>/<session>.jsonl
//   Codex        ~/.codex/sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl
//   Copilot      ~/.copilot/session-state/<session>/{workspace.yaml, events.jsonl}
//   Gemini       ~/.gemini/tmp/<project>/chats/session-….json, the folder in <project>/.project_root

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { HOME } from "./store.mjs";

const home = (env, dir) => process.env[env] || join(homedir(), dir);
const NEWEST = 150; // sessions looked at per CLI, newest first
const real = (p) => { if (!p) return null; try { return realpathSync(p); } catch { return p; } };
// throwaway folders (the system's temporary ones, where taksim's own chats and test runs work): not a project
const TEMP = [...new Set([tmpdir(), "/tmp", "/private/tmp"].map(real).filter(Boolean))];
const throwaway = (cwd) => !process.env.TAKSIM_HISTORY_TEMP && TEMP.some((t) => cwd === t || cwd.startsWith(t + "/"));
// the CLIs' markup around commands, reminders and context: not part of what was asked
const clean = (t) => String(t || "").replace(/<([\w-]+)[^>]*>[\s\S]*?<\/\1>/g, " ").replace(/\s+/g, " ").trim();

async function lines(file) {
  const out = [];
  for (const l of (await readFile(file, "utf8")).split("\n")) {
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch { /* a line the CLI is still writing */ }
  }
  return out;
}

async function newest(files) {
  const out = [];
  for (const f of files) { try { out.push({ f, at: (await stat(f)).mtimeMs }); } catch { /* removed meanwhile */ } }
  return out.sort((a, b) => b.at - a.at).slice(0, NEWEST).map((x) => x.f);
}

async function filesUnder(dir, keep) {
  if (!existsSync(dir)) return [];
  let names = [];
  try { names = await readdir(dir, { recursive: true }); } catch { return []; }
  return names.filter(keep).map((n) => join(dir, n));
}

// ---------- each CLI: where its sessions are, and one read as { session, cwd, title?, createdAt?, turns } ----------
// turns: [{ ts, who: "user" | "agent", text }]

const claudeText = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n") : "";

const SOURCES = [
  {
    backend: "claude", prefix: "cc-", label: "Claude Code", resumable: true,
    files: async () => newest(await filesUnder(join(home("TAKSIM_CLAUDE_HOME", ".claude"), "projects"), (n) => n.endsWith(".jsonl") && n.split("/").length === 2)),
    async read(file) {
      const all = await lines(file);
      const turns = [];
      let cwd = null, title = null, createdAt = null;
      for (const l of all) {
        if (l.type === "custom-title" && l.customTitle) title = l.customTitle;
        else if (l.type === "summary" && l.summary && !title) title = l.summary;
        if (l.isSidechain) continue;
        cwd ||= l.cwd || null;
        const ts = Date.parse(l.timestamp) || undefined;
        if (l.type === "user" && !l.isMeta && l.message?.role === "user") {
          const text = clean(claudeText(l.message.content));
          if (text) { createdAt ||= ts; turns.push({ ts, who: "user", text }); }
        } else if (l.type === "assistant") {
          const text = claudeText(l.message?.content).trim();
          if (text) turns.push({ ts, who: "agent", text });
        }
      }
      return { session: basename(file, ".jsonl"), cwd, title, createdAt, turns };
    },
  },
  {
    backend: "codex", prefix: "cx-", label: "Codex", resumable: true,
    files: async () => newest(await filesUnder(join(process.env.CODEX_HOME && !process.env.TAKSIM_CODEX_HOME ? process.env.CODEX_HOME : home("TAKSIM_CODEX_HOME", ".codex"), "sessions"), (n) => /rollout-.*\.jsonl$/.test(n))),
    async read(file) {
      const all = await lines(file);
      const meta = all.find((l) => l.type === "session_meta")?.payload || {};
      const turns = [];
      for (const l of all) {
        const p = l.payload;
        if (l.type !== "response_item" || p?.type !== "message" || !Array.isArray(p.content)) continue;
        const ts = Date.parse(l.timestamp) || undefined;
        if (p.role === "user") {
          // the CLI's own context (environment, AGENTS.md) arrives as user messages too
          const raw = p.content.filter((c) => c.type === "input_text").map((c) => c.text).join("\n");
          if (/^\s*(# AGENTS\.md|<environment_context>|<user_instructions>|<permissions)/.test(raw)) continue;
          // the Codex app puts attached files first ("# Files mentioned by the user: … ## My request: …")
          const asked = raw.match(/^## My request[^:\n]*:\s*([\s\S]*)$/m)?.[1];
          const text = clean(/^\s*# Files mentioned by the user:/.test(raw) && asked ? asked : raw);
          if (text) turns.push({ ts, who: "user", text });
        } else if (p.role === "assistant") {
          const text = p.content.filter((c) => c.type === "output_text").map((c) => c.text).join("\n").trim();
          if (text) turns.push({ ts, who: "agent", text });
        }
      }
      return { session: meta.id || basename(file, ".jsonl").slice(-36), cwd: meta.cwd || null, createdAt: Date.parse(meta.timestamp) || null, turns };
    },
  },
  {
    backend: "copilot", prefix: "cp-", label: "GitHub Copilot", resumable: true,
    files: async () => {
      const dir = join(home("TAKSIM_COPILOT_HOME", ".copilot"), "session-state");
      if (!existsSync(dir)) return [];
      return newest(readdirSync(dir).map((d) => join(dir, d, "events.jsonl")).filter(existsSync));
    },
    async read(file) {
      const ws = await readFile(join(dirname(file), "workspace.yaml"), "utf8").catch(() => "");
      const field = (k) => ws.match(new RegExp(`^${k}: (.+)$`, "m"))?.[1]?.trim() || null;
      const turns = [];
      for (const l of await lines(file)) {
        const ts = Date.parse(l.timestamp) || undefined;
        const text = typeof l.data?.content === "string" ? l.data.content.trim() : "";
        if (!text) continue;
        if (l.type === "user.message") { const t = clean(text); if (t) turns.push({ ts, who: "user", text: t }); }
        else if (l.type === "assistant.message") turns.push({ ts, who: "agent", text });
      }
      const named = field("user_named") === "true" ? field("name") : null;
      return { session: basename(dirname(file)), cwd: field("cwd"), title: named, createdAt: Date.parse(field("created_at")) || null, turns };
    },
  },
  {
    backend: "gemini", prefix: "gm-", label: "Gemini CLI", resumable: false,
    files: async () => newest(await filesUnder(join(home("TAKSIM_GEMINI_HOME", ".gemini"), "tmp"), (n) => /(^|\/)chats\/session-[^/]*\.json$/.test(n))),
    async read(file) {
      const j = JSON.parse(await readFile(file, "utf8"));
      const cwd = (await readFile(join(dirname(dirname(file)), ".project_root"), "utf8").catch(() => "")).trim() || null;
      const turns = [];
      for (const m of j.messages || []) {
        const ts = Date.parse(m.timestamp) || undefined;
        const text = typeof m.content === "string" ? m.content.trim() : Array.isArray(m.content) ? m.content.map((p) => p?.text || "").join("\n").trim() : "";
        if (!text) continue;
        if (m.type === "user") { const t = clean(text); if (t) turns.push({ ts, who: "user", text: t }); }
        else if (m.type === "gemini" || m.type === "model") turns.push({ ts, who: "agent", text });
      }
      return { session: j.sessionId || basename(file, ".json"), cwd, createdAt: Date.parse(j.startTime) || null, turns };
    },
  },
];

const sourceOf = (id) => SOURCES.find((s) => String(id).startsWith(s.prefix));
export const isOutside = (id) => !!sourceOf(id);

// ---------- what the list needs from one session, read again only when its file changed ----------
// (asynchronously: the engine keeps answering while a few hundred megabytes of sessions are read the first time;
// a list asked for while the warm-up reads a file waits for that read)
const cache = new Map();   // file -> { key, info }
const reading = new Map(); // file -> { key, promise }

async function infoOf(src, file) {
  const st = await stat(file);
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit?.key === key) return hit.info;
  const busy = reading.get(file);
  if (busy?.key === key) return busy.promise;
  const promise = (async () => {
    const s = await src.read(file);
    const firstAsk = s.turns.find((t) => t.who === "user");
    const info = firstAsk ? {
      // a request one taksim agent sent another starts with who sent it: the title is the request
      session: s.session, cwd: real(s.cwd), title: (s.title || firstAsk.text).replace(/^\[Message from agent "[^"]*"[^\]]*\]\s*/, "").slice(0, 120),
      lastText: (s.turns.filter((t) => t.who === "agent").at(-1)?.text || "").slice(0, 280),
      messages: s.turns.length, lastAt: st.mtimeMs, createdAt: s.createdAt || firstAsk.ts || st.birthtimeMs || null,
      // what a search looks in: the words said, not tool output and request blobs
      words: s.turns.map((t) => t.text).join("\n").toLowerCase(),
    } : null;
    cache.set(file, { key, info });
    return info;
  })().finally(() => { if (reading.get(file)?.promise === promise) reading.delete(file); });
  reading.set(file, { key, promise });
  return promise;
}

/** every CLI's sessions as past conversations; `owned` are session ids taksim's agents already hold */
export async function listOutsideSessions({ q = "", owned = new Set() } = {}) {
  const needle = String(q).trim().toLowerCase();
  const out = [];
  for (const src of SOURCES) {
    let files = [];
    try { files = await src.files(); } catch { continue; }
    for (const f of files) {
      let info;
      try { info = await infoOf(src, f); } catch { continue; }
      // taksim's own agents run the CLIs in its folders: those conversations are already on a canvas or in its history
      if (!info || owned.has(info.session) || (info.cwd && (info.cwd.startsWith(HOME) || throwaway(info.cwd)))) continue;
      if (needle && ![info.title, info.cwd].join(" ").toLowerCase().includes(needle) && !info.words.includes(needle)) continue;
      out.push({
        id: src.prefix + info.session, source: src.backend, title: info.title, name: src.label, backend: src.backend, model: null,
        folder: info.cwd ? basename(info.cwd) : null, cwd: info.cwd, lastText: info.lastText, messages: info.messages,
        lastAt: info.lastAt, createdAt: info.createdAt,
      });
    }
  }
  return out;
}

/** one session to continue: its CLI, folder, whether its session can be resumed here, and its conversation as
 * taksim transcript entries (`self` is the agent's id) */
export async function readOutsideSession(id, self) {
  const src = sourceOf(id);
  if (!src) return null;
  const session = String(id).slice(src.prefix.length);
  if (!/^[\w.-]+$/.test(session)) return null;
  let file = null;
  for (const f of await src.files()) {
    const info = await infoOf(src, f).catch(() => null);
    if (info?.session === session) { file = f; break; }
  }
  if (!file) return null;
  const s = await src.read(file);
  const entries = [];
  for (const t of s.turns) {
    if (t.who === "user") { entries.push({ ts: t.ts, from: "user", to: self, kind: "user", text: t.text }); continue; }
    // one answer comes in several pieces (text between tool calls): they read as one message
    const prev = entries.at(-1);
    if (prev?.from === self) prev.text += "\n\n" + t.text;
    else entries.push({ ts: t.ts, from: self, to: "user", kind: "assistant", text: t.text });
  }
  const info = await infoOf(src, file);
  return { backend: src.backend, label: src.label, resumable: src.resumable, session, cwd: info?.cwd || null, title: info?.title || "", entries };
}
