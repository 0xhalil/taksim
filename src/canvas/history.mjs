// Past conversations: an agent taken off its canvas (removed, or its canvas closed) is kept under
// ~/.taksim/history/<id>/ with its transcript, so it can be found again (by its words too) and continued on any
// canvas, as the Claude app's conversation list does. An agent nobody talked to leaves nothing behind.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { HOME, readTranscript, transcriptFile } from "./store.mjs";

const DIR = join(HOME, "history");
const safe = (id) => { if (!/^[\w-]+$/.test(String(id))) throw new Error(`invalid id: ${id}`); return id; };
const metaOf = (id) => join(DIR, safe(id), "meta.json");
// what isn't carried to another canvas: its place, its panel and IDE (they belong to the canvas it left)
const DROPPED = ["pos", "size", "cardSize", "collapsed", "panel", "ide", "parent", "depth", "job", "jobRole"];

const said = (e) => e.from === "user" && e.kind !== "restore" && typeof e.text === "string" && e.text.trim();
// the title the system gives it: its first request, as the Claude app names a conversation
const titleOf = (entries, name) => {
  const first = entries.find(said)?.text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return first ? first.slice(0, 120) : name;
};

/** keeps the agent and its conversation; false when there was nothing to keep (its transcript is then left alone) */
export function archiveAgent(canvas, agent) {
  const entries = readTranscript(canvas.id, agent.id, 100000);
  if (!entries.some(said)) return false;
  const d = join(DIR, safe(agent.id));
  mkdirSync(d, { recursive: true });
  const data = agent.toJSON();
  for (const k of DROPPED) delete data[k];
  // a conversation run in the canvas's own scratch folder can't be resumed from another canvas's: its transcript
  // seeds a new session there instead
  if (!data.cwd && !canvas.vars.project_dir) { data.session = null; data.seedHistory = true; }
  if (!data.cwd && canvas.vars.project_dir) data.cwd = canvas.vars.project_dir;
  const last = entries.at(-1);
  const meta = {
    id: agent.id, agent: data, title: titleOf(entries, agent.name), canvas: { id: canvas.id, name: canvas.name },
    folder: data.cwd ? basename(data.cwd) : null, backend: agent.backend,
    lastText: [...entries].reverse().find((e) => e.from === agent.id && e.kind === "assistant")?.text?.slice(0, 280) || "",
    messages: entries.filter((e) => e.kind !== "restore").length, createdAt: data.createdAt || null,
    lastAt: last?.ts || Date.now(), archivedAt: Date.now(),
  };
  renameSync(transcriptFile(canvas.id, agent.id), join(d, "transcript.jsonl"));
  writeFileSync(metaOf(agent.id), JSON.stringify(meta, null, 2));
  return true;
}

function readMeta(id) {
  try { return JSON.parse(readFileSync(metaOf(id), "utf8")); } catch { return null; }
}

/** the kept conversations, newest first; `q` finds them by title, name, folder or anything said in them */
export function listHistory({ q = "", limit = 200 } = {}) {
  if (!existsSync(DIR)) return [];
  const needle = String(q).trim().toLowerCase();
  const out = [];
  for (const id of readdirSync(DIR)) {
    const m = readMeta(id);
    if (!m) continue;
    if (needle) {
      const head = [m.title, m.agent?.name, m.folder, m.canvas?.name].filter(Boolean).join(" ").toLowerCase();
      if (!head.includes(needle)) {
        let text = "";
        try { text = readFileSync(join(DIR, id, "transcript.jsonl"), "utf8").toLowerCase(); } catch { /* gone meanwhile */ }
        if (!text.includes(needle)) continue;
      }
    }
    const { agent, ...summary } = m;
    out.push({ ...summary, name: agent?.name || "", model: agent?.model || null });
  }
  return out.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, limit);
}

/** takes a conversation out of the history to continue it on `canvasId`: the agent's data, its transcript moved there */
export function takeFromHistory(id, canvasId, newId) {
  const m = readMeta(id);
  if (!m) return null;
  const to = transcriptFile(canvasId, newId);
  mkdirSync(join(to, ".."), { recursive: true });
  const from = join(DIR, safe(id), "transcript.jsonl");
  if (existsSync(from)) renameSync(from, to);
  rmSync(join(DIR, safe(id)), { recursive: true, force: true });
  return m;
}

export function forgetHistory(id) {
  if (!readMeta(id)) return false;
  rmSync(join(DIR, safe(id)), { recursive: true, force: true });
  return true;
}

/** the CLI sessions taksim's kept conversations hold (claude-sessions.mjs leaves those out of its list) */
export function heldSessions() {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).map((id) => readMeta(id)?.agent?.session).filter(Boolean);
}
