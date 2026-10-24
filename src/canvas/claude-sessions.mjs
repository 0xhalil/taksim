// Conversations started outside taksim, in Claude Code or the Claude app's Code tab: they live as one JSONL per
// session under ~/.claude/projects/<folder>/. Listed beside taksim's own past conversations, so one begun there is
// continued here: an agent in the same folder resumes the same session, its chat filled from the file.
// Read only; taksim never changes these files (the CLI appends to its own session as it always does).

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { HOME } from "./store.mjs";

export const PREFIX = "cc-";
const root = () => join(process.env.TAKSIM_CLAUDE_HOME || join(homedir(), ".claude"), "projects");
const NEWEST = 150; // sessions looked at, newest first: an old one is still a search away in the Claude app
const cache = new Map(); // file -> { key, info }

// a request as typed: a string, or text parts (tool results and the CLI's own notes aren't the person's words)
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
}
const typed = (line) => line.type === "user" && !line.isMeta && !line.isSidechain && line.message?.role === "user"
  && (typeof line.message.content === "string" || line.message.content?.some?.((p) => p?.type === "text"));
// the CLI's markup around commands and reminders: not part of what was asked
const clean = (t) => t.replace(/<(command|local-command|system-reminder|bash)[\w-]*>[\s\S]*?<\/\1[\w-]*>/g, " ").replace(/\s+/g, " ").trim();

const real = (p) => { if (!p) return null; try { return realpathSync(p); } catch { return p; } };

async function parse(file) {
  const lines = [];
  for (const l of (await readFile(file, "utf8")).split("\n")) {
    if (!l) continue;
    try { lines.push(JSON.parse(l)); } catch { /* a line the CLI is still writing */ }
  }
  return lines;
}

// what the list needs from one session file, read again only when the file changed (asynchronously: the engine keeps
// answering while a few hundred megabytes of sessions are read the first time)
const reading = new Map(); // file -> { key, promise }: a list asked for while the warm-up reads waits for that read
async function infoOf(file) {
  const st = await stat(file);
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit?.key === key) return hit.info;
  const busy = reading.get(file);
  if (busy?.key === key) return busy.promise;
  const promise = readInfo(file, st, key).finally(() => { if (reading.get(file)?.promise === promise) reading.delete(file); });
  reading.set(file, { key, promise });
  return promise;
}

async function readInfo(file, st, key) {
  const lines = await parse(file);
  const first = lines.find((l) => typed(l) && clean(textOf(l.message.content)));
  const named = lines.filter((l) => l.type === "custom-title" && l.customTitle).at(-1)?.customTitle
    || lines.filter((l) => l.type === "summary" && l.summary).at(-1)?.summary;
  const lastAnswer = lines.filter((l) => l.type === "assistant" && !l.isSidechain).map((l) => textOf(l.message?.content)).filter(Boolean).at(-1);
  const info = first ? {
    session: basename(file, ".jsonl"),
    // the folder as taksim names it (/var is /private/var on macOS): the same project groups as one
    cwd: real(first.cwd || lines.find((l) => l.cwd)?.cwd || null),
    title: (named || clean(textOf(first.message.content))).slice(0, 120),
    lastText: (lastAnswer || "").slice(0, 280),
    messages: lines.filter((l) => (l.type === "user" && typed(l)) || (l.type === "assistant" && textOf(l.message?.content))).length,
    lastAt: st.mtimeMs,
    createdAt: Date.parse(first.timestamp) || st.birthtimeMs || null,
    // what a search looks in: the words said, not the tool output and request blobs around them
    words: lines.filter((l) => !l.isSidechain && (typed(l) || l.type === "assistant")).map((l) => textOf(l.message?.content)).join("\n").toLowerCase(),
  } : null;
  cache.set(file, { key, info });
  return info;
}

async function sessionFiles() {
  const dir = root();
  if (!existsSync(dir)) return [];
  const files = [];
  for (const p of await readdir(dir)) {
    let names = [];
    try { names = await readdir(join(dir, p)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const f = join(dir, p, n);
      try { files.push({ f, at: (await stat(f)).mtimeMs }); } catch { /* removed meanwhile */ }
    }
  }
  return files.sort((a, b) => b.at - a.at).slice(0, NEWEST).map((x) => x.f);
}

/** Claude Code's sessions as past conversations; `owned` are session ids taksim's agents already hold */
export async function listClaudeSessions({ q = "", owned = new Set() } = {}) {
  const needle = String(q).trim().toLowerCase();
  const out = [];
  for (const f of await sessionFiles()) {
    let info;
    try { info = await infoOf(f); } catch { continue; }
    // taksim's own agents run Claude in its folders: those conversations are already on a canvas or in its history
    if (!info || owned.has(info.session) || (info.cwd && info.cwd.startsWith(HOME))) continue;
    if (needle && ![info.title, info.cwd].join(" ").toLowerCase().includes(needle) && !info.words.includes(needle)) continue;
    out.push({
      id: PREFIX + info.session, source: "claude-code", title: info.title, name: "Claude Code", backend: "claude", model: null,
      folder: info.cwd ? basename(info.cwd) : null, cwd: info.cwd, lastText: info.lastText, messages: info.messages, lastAt: info.lastAt, createdAt: info.createdAt,
    });
  }
  return out;
}

/** one session to continue: its folder and its conversation as taksim transcript entries (the agent's id as `self`) */
export async function readClaudeSession(id, self) {
  if (!id.startsWith(PREFIX)) return null;
  const session = id.slice(PREFIX.length);
  if (!/^[\w-]+$/.test(session)) return null;
  const f = existsSync(root()) && readdirSync(root()).map((p) => join(root(), p, `${session}.jsonl`)).find(existsSync);
  if (!f) return null;
  const lines = await parse(f);
  const entries = [];
  for (const l of lines) {
    if (l.isSidechain) continue;
    const ts = Date.parse(l.timestamp) || undefined;
    if (typed(l)) {
      const text = clean(textOf(l.message.content));
      if (text) entries.push({ ts, from: "user", to: self, kind: "user", text });
    } else if (l.type === "assistant") {
      const text = textOf(l.message?.content).trim();
      if (!text) continue;
      // one answer comes in several lines (text between tool calls): they read as one message
      const prev = entries.at(-1);
      if (prev?.from === self) prev.text += "\n\n" + text;
      else entries.push({ ts, from: self, to: "user", kind: "assistant", text });
    }
  }
  const info = await infoOf(f);
  return { session, cwd: info?.cwd || null, title: info?.title || "", entries };
}
