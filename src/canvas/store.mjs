// Canvas persistence under ~/.taksim/canvases/<id>/: canvas.json plus one transcript JSONL per agent.

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = process.env.TAKSIM_HOME || join(homedir(), ".taksim");
const CANVASES = join(HOME, "canvases");

const dir = (id) => join(CANVASES, id);
const safeId = (id) => { if (!/^[\w-]+$/.test(id)) throw new Error(`invalid id: ${id}`); return id; };

export function listCanvasIds() {
  if (!existsSync(CANVASES)) return [];
  return readdirSync(CANVASES).filter((id) => existsSync(join(CANVASES, id, "canvas.json")));
}

export function loadCanvas(id) {
  return JSON.parse(readFileSync(join(dir(safeId(id)), "canvas.json"), "utf8"));
}

// Write to a temp file and rename, so a crash mid-write never leaves a truncated canvas.json.
export function saveCanvas(data) {
  const d = dir(safeId(data.id));
  mkdirSync(join(d, "agents"), { recursive: true });
  const tmp = join(d, "canvas.json.tmp");
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, join(d, "canvas.json"));
}

// A stable working directory for agents without a project directory, so CLIs ask to trust it once.
export function workspaceDir(id) {
  const d = join(dir(safeId(id)), "workspace");
  mkdirSync(d, { recursive: true });
  return d;
}

export function deleteCanvas(id) {
  rmSync(dir(safeId(id)), { recursive: true, force: true });
}

export function appendTranscript(canvasId, agentId, entry) {
  const d = join(dir(safeId(canvasId)), "agents");
  mkdirSync(d, { recursive: true });
  appendFileSync(join(d, `${safeId(agentId)}.jsonl`), JSON.stringify(entry) + "\n");
}

export function readTranscript(canvasId, agentId, limit = 500) {
  const f = join(dir(safeId(canvasId)), "agents", `${safeId(agentId)}.jsonl`);
  if (!existsSync(f)) return [];
  const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
  const out = [];
  for (const l of lines.slice(-limit)) {
    try { out.push(JSON.parse(l)); } catch { /* a line cut mid-write by a crash: skip it */ }
  }
  return out;
}

export function deleteTranscript(canvasId, agentId) {
  rmSync(join(dir(safeId(canvasId)), "agents", `${safeId(agentId)}.jsonl`), { force: true });
}

// ---------- group context notes: groups/<gid>/CONTEXT.md, every version kept under history/ ----------
const groupDir = (canvasId, gid) => join(dir(safeId(canvasId)), "groups", safeId(gid));

export function readGroupContext(canvasId, gid) {
  const f = join(groupDir(canvasId, gid), "CONTEXT.md");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
}

export function writeGroupContext(canvasId, gid, version, content) {
  const d = groupDir(canvasId, gid);
  mkdirSync(join(d, "history"), { recursive: true });
  writeFileSync(join(d, "history", `${String(version).padStart(5, "0")}.md`), content);
  writeFileSync(join(d, "CONTEXT.md.tmp"), content);
  renameSync(join(d, "CONTEXT.md.tmp"), join(d, "CONTEXT.md"));
}

// who wrote each entry of the note (canvas/memory.mjs); a sidecar, so CONTEXT.md stays plain markdown
export function readGroupMemory(canvasId, gid) {
  const f = join(groupDir(canvasId, gid), "MEMORY.json");
  try { return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; } catch { return null; }
}

export function writeGroupMemory(canvasId, gid, entries) {
  const d = groupDir(canvasId, gid);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "MEMORY.json.tmp"), JSON.stringify(entries));
  renameSync(join(d, "MEMORY.json.tmp"), join(d, "MEMORY.json"));
}

export function listGroupHistory(canvasId, gid) {
  const d = join(groupDir(canvasId, gid), "history");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".md")).map((f) => Number(f.slice(0, -3))).sort((a, b) => a - b) : [];
}

export function readGroupVersion(canvasId, gid, version) {
  const f = join(groupDir(canvasId, gid), "history", `${String(version).padStart(5, "0")}.md`);
  return existsSync(f) ? readFileSync(f, "utf8") : null;
}

export function deleteGroupFiles(canvasId, gid) {
  rmSync(groupDir(canvasId, gid), { recursive: true, force: true });
}
