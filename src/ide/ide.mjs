// An agent's IDE: open tabs, the agent's notes on lines (like an inspection), the dock's size, and a watcher
// that tells open pages which files changed on disk (the agent edits through its own CLI, not the IDE).

import { watch, existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { httpError } from "../http.mjs";
import { inside, relPath, forgetFiles, SKIP } from "./fs.mjs";
import { Sessions } from "./sessions.mjs";

const UI = { collapsed: false, maximized: false, size: [940, 580], tree: true, left: "project", bottom: null };
const BOTTOM = ["problems", "git", "find", "terminal", "run", "debug"];
const MAX_TABS = 30, MAX_NOTES = 200;
const SEVERITIES = ["info", "warning", "error"];

export class Ide {
  constructor(agent, data = {}) {
    this.agent = agent;
    this.tabs = Array.isArray(data.tabs) ? data.tabs.filter((t) => typeof t === "string" && t) : [];
    this.active = data.active || this.tabs.at(-1) || null;
    this.ui = { ...UI, ...data.ui };
    this.notes = Array.isArray(data.notes) ? data.notes : [];
    this.breakpoints = data.breakpoints && typeof data.breakpoints === "object" ? data.breakpoints : {}; // path -> lines
    this.sessions = new Sessions(this);
    this.watcher = null;
    this.closed = false; // the watcher starts once the IDE is in use (changed(), or the agent loading it)
  }

  get root() { return this.agent.workDir(); }

  toJSON() { return { tabs: this.tabs, active: this.active, ui: this.ui, notes: this.notes, breakpoints: this.breakpoints }; }

  view() { return { ...this.toJSON(), root: this.root, rootName: basename(this.root), sessions: this.sessions.views() }; }

  changed(extra = {}) {
    this.watch();
    this.agent.canvas.bus.emit("ide_updated", { id: this.agent.id, ide: this.view(), ...extra });
    this.agent.canvas.save();
  }

  // Opens files as tabs and shows `path` (at `line`, highlighting through `endLine`).
  open({ files = [], path, line, endLine } = {}) {
    const want = [...files, ...(path ? [path] : [])].map((p) => this.file(p));
    for (const p of want) if (!this.tabs.includes(p)) this.tabs.push(p);
    this.tabs = this.tabs.slice(-MAX_TABS);
    if (want.length) this.active = path ? want.at(-1) : want[0];
    this.ui.collapsed = false;
    const reveal = this.active && (line || path) ? { path: this.active, line: Number(line) || 1, endLine: Number(endLine) || Number(line) || 1, at: Date.now() } : null;
    this.changed(reveal ? { reveal } : {});
    return this.view();
  }

  // A file in the project, as its relative path; folders and missing files are refused with a message the
  // agent can act on.
  file(p) {
    const rel = relPath(this.root, String(p));
    const abs = inside(this.root, rel);
    if (!existsSync(abs)) throw httpError(404, `no such file: ${p} (paths are relative to ${this.root})`);
    if (!rel || statSync(abs).isDirectory()) throw httpError(400, `${p || "."} is a folder; pass a file in it`);
    return rel;
  }

  // What the page changed: open tabs, the active one, the dock's size and panes.
  // Tab and breakpoint paths are re-validated: only files inside the project stick.
  setState(patch = {}) {
    const keep = (p) => { try { return this.file(p); } catch { return null; } };
    if (Array.isArray(patch.tabs)) this.tabs = patch.tabs.filter((t) => typeof t === "string" && t).map(keep).filter(Boolean).slice(-MAX_TABS);
    if (patch.active !== undefined) this.active = (typeof patch.active === "string" && patch.active && keep(patch.active)) || null;
    const ui = patch.ui || {};
    for (const k of ["collapsed", "maximized", "tree"]) if (typeof ui[k] === "boolean") this.ui[k] = ui[k];
    if (ui.bottom !== undefined) this.ui.bottom = BOTTOM.includes(ui.bottom) ? ui.bottom : null;
    if (ui.left !== undefined) this.ui.left = ui.left === "commit" ? "commit" : "project";
    if (patch.breakpoints && typeof patch.breakpoints === "object") {
      this.breakpoints = Object.fromEntries(Object.entries(patch.breakpoints)
        .map(([p, lines]) => { let rel; try { rel = this.file(p); } catch { return null; }
          return [rel, [...new Set((Array.isArray(lines) ? lines : []).map(Number).filter((n) => n > 0))].sort((a, b) => a - b)]; })
        .filter((e) => e && e[1].length));
      this.sessions.breakpointsChanged();
    }
    if (Array.isArray(ui.size)) {
      const [w, h] = ui.size.map(Number);
      if (Number.isFinite(w) && Number.isFinite(h)) this.ui.size = [Math.min(2600, Math.max(420, Math.round(w))), Math.min(1800, Math.max(260, Math.round(h)))];
    }
    this.changed();
  }

  // `code`, the text of the first marked line, moves the note to where that text really is: models miscount lines.
  note({ path, line, end_line, text, severity = "info", code, source }) {
    if (!path || !text) throw httpError(400, "path and text are required");
    const p = this.file(path);
    const lines = readFileSync(inside(this.root, p), "utf8").split("\n");
    // a line past the end lands on the last one rather than nowhere
    let start = Math.min(lines.length, Math.max(1, Number(line) || 1));
    let end = Math.min(lines.length, Math.max(start, Number(end_line) || start));
    const want = typeof code === "string" ? code.trim() : "";
    let moved = 0;
    if (want) {
      if (!lines[start - 1]?.includes(want)) {
        const hits = lines.map((l, i) => (l.includes(want) ? i + 1 : 0)).filter(Boolean);
        if (hits.length) {
          const best = hits.reduce((a, b) => (Math.abs(b - start) < Math.abs(a - start) ? b : a));
          moved = best - start;
          start += moved; end = Math.min(lines.length, end + moved);
        }
      }
    }
    const n = { id: Math.random().toString(36).slice(2, 8), path: p, line: start, endLine: end, text: String(text).slice(0, 2000),
      severity: SEVERITIES.includes(severity) ? severity : "info", at: Date.now(), ...(source ? { source } : {}), ...(moved ? { moved } : {}) };
    this.notes = [...this.notes, n].slice(-MAX_NOTES);
    this.changed();
    return n;
  }

  clearNotes({ path, id, source } = {}) {
    const before = this.notes.length;
    if (path) path = relPath(this.root, String(path)); // "./src/app.py" or an absolute path names the same notes
    this.notes = this.notes.filter((n) => (id ? n.id !== id : source ? n.source !== source : path ? n.path !== path : false));
    this.changed();
    return before - this.notes.length;
  }

  // ---------- files changed on disk ----------

  watch() {
    if (this.closed || this.watcher) return;
    const root = this.root;
    let pending = new Set(), git = false, timer = null;
    try {
      this.watcher = watch(root, { recursive: true }, (_, name) => {
        if (!name) return;
        const rel = String(name).split(/[\\/]/);
        // a commit, checkout or stage (by the agent or in a terminal) changes which files the page colors as changed
        // (Windows reports a change inside .git as the folder itself, or as its logs)
        if (rel[0] === ".git") { if (rel.length > 1 && !/^(index|HEAD|ORIG_HEAD|refs|logs|packed-refs)$/.test(rel[1])) return; git = true; }
        else if (rel.some((part) => SKIP.has(part))) return;
        else pending.add(rel.join("/"));
        clearTimeout(timer);
        timer = setTimeout(() => {
          const paths = [...pending];
          pending = new Set();
          forgetFiles(root);
          this.agent.canvas.bus.emit("ide_files", { id: this.agent.id, paths: paths.slice(0, 200), ...(git ? { git: true } : {}) });
          git = false;
        }, 150);
      });
      this.watcher.on("error", () => { this.watcher?.close(); this.watcher = null; });
    } catch { this.watcher = null; } // the folder may be gone; the page still works, it just isn't told
  }

  // the agent's folder changed
  rewatch() { this.watcher?.close(); this.watcher = null; this.watch(); this.changed(); }

  close() { this.closed = true; this.watcher?.close(); this.watcher = null; this.sessions.close(); }
}
