// IDE layer: a PyCharm-like editor docked next to an agent's node (after its panel), on the agent's working
// directory. Project and Commit on the left, editor tabs (Monaco, Darcula colors) in the middle, tool windows
// at the bottom (Problems: the agent's notes · Git log · Find · Terminal · Run · Debug, see ide-tools.mjs), a
// run configuration (▶ Run, 🐞 Debug) in the title bar, a status bar, ⇧⇧ / ⌘P to go to a file and ⌘⇧F to
// find in files. Saves with ⌘S and when the editor loses focus. Files the agent changes on disk reload by
// themselves; a file with unsaved edits asks first.

import { T as Theme, onTheme } from "./theme.mjs";
import { T } from "./lang.mjs";
import { toolMethods, BUG } from "./ide-tools.mjs";

const GAP = 14, COLLAPSED_W = 34, MAX = [1400, 860];
const MIN_SCALE = 0.3;

const h = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};
const enc = encodeURIComponent;
const base = (p) => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const LANGS = { js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
  py: "python", swift: "swift", go: "go", rs: "rust", rb: "ruby", java: "java", kt: "kotlin", c: "c", h: "cpp", cpp: "cpp",
  cs: "csharp", sh: "shell", json: "json", html: "html", css: "css", md: "markdown", yml: "yaml", yaml: "yaml", toml: "ini", sql: "sql" };
const langOf = (p) => LANGS[(base(p).split(".").pop() || "").toLowerCase()];

// ---------- Monaco, loaded the first time an IDE opens ----------
let monacoReady = null;
function loadMonaco() {
  if (monacoReady) return monacoReady;
  const p = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/vendor/monaco/vs/loader.js";
    s.onload = () => {
      window.require.config({ paths: { vs: "/vendor/monaco/vs" } });
      window.require(["vs/editor/editor.main"], () => { defineTheme(window.monaco); inlineValues(window.monaco); resolve(window.monaco); }, reject);
    };
    s.onerror = () => reject(new Error(T("editor failed to load (npm install?)")));
    document.head.appendChild(s);
  });
  // a failed load must not stick: reset so closing and reopening the IDE retries
  monacoReady = p;
  p.catch(() => { if (monacoReady === p) monacoReady = null; });
  return monacoReady;
}

// The debugger's inline values (a variable's value at the end of the lines that use it) are inlay hints:
// INLINE[model uri] = hints, then INLINE.changed() to redraw.
export const INLINE = new Map();
function inlineValues(monaco) {
  const emitter = new monaco.Emitter();
  INLINE.changed = () => emitter.fire();
  monaco.languages.registerInlayHintsProvider("python", {
    onDidChangeInlayHints: emitter.event,
    provideInlayHints: (model) => ({ hints: INLINE.get(model.uri.toString()) || [], dispose() {} }),
  });
}

// the editor scheme of the current theme: IntelliJ Light or Dark (New UI)
export const editorTheme = () => (Theme.name === "light" ? "intellij-light" : "darcula");
onTheme(() => { if (window.monaco) window.monaco.editor.setTheme(editorTheme()); });

// PyCharm's New UI editor schemes, dark and light
function defineTheme(monaco) {
  monaco.editor.defineTheme("intellij-light", {
    base: "vs", inherit: true,
    rules: [
      { token: "", foreground: "080808" },
      { token: "comment", foreground: "8C8C8C", fontStyle: "italic" },
      { token: "keyword", foreground: "0033B3" }, { token: "keyword.flow", foreground: "0033B3" },
      { token: "string", foreground: "067D17" }, { token: "string.escape", foreground: "0037A6" },
      { token: "number", foreground: "1750EB" }, { token: "regexp", foreground: "264EFF" },
      { token: "type", foreground: "080808" }, { token: "type.identifier", foreground: "080808" },
      { token: "identifier", foreground: "080808" }, { token: "delimiter", foreground: "080808" },
      { token: "annotation", foreground: "9E880D" }, { token: "tag", foreground: "0033B3" },
      { token: "attribute.name", foreground: "174AD4" }, { token: "attribute.value", foreground: "067D17" },
      { token: "constant", foreground: "871094" }, { token: "variable.predefined", foreground: "94558D" },
      { token: "key", foreground: "871094" }, { token: "string.key.json", foreground: "871094" }, { token: "string.value.json", foreground: "067D17" },
      { token: "keyword.json", foreground: "0033B3" }, { token: "metatag", foreground: "9E880D" },
    ],
    colors: {
      "editor.background": "#FFFFFF", "editor.foreground": "#080808",
      "editorLineNumber.foreground": "#AEB3C2", "editorLineNumber.activeForeground": "#767A8A",
      "editorGutter.background": "#FFFFFF", "editor.lineHighlightBackground": "#F5F8FE", "editor.lineHighlightBorder": "#F5F8FE",
      "editor.selectionBackground": "#A6D2FF", "editor.inactiveSelectionBackground": "#A6D2FF88", "editorCursor.foreground": "#000000",
      "editorIndentGuide.background1": "#EBECF0", "editorIndentGuide.activeBackground1": "#C9CCD6",
      "editor.findMatchBackground": "#F4D35E88", "editor.findMatchHighlightBackground": "#F4D35E44",
      "editorWhitespace.foreground": "#DFE1E5", "editorBracketMatch.background": "#93D9D9", "editorBracketMatch.border": "#93D9D9",
      "scrollbarSlider.background": "#C9CCD688", "scrollbarSlider.hoverBackground": "#A8ADBDAA",
      "editorOverviewRuler.border": "#FFFFFF", "editorWidget.background": "#F7F8FA", "editorHoverWidget.background": "#F7F8FA",
      "editorInlayHint.foreground": "#6C707E", "editorInlayHint.background": "#00000000",
      "diffEditor.insertedTextBackground": "#C9F2D2AA", "diffEditor.removedTextBackground": "#FAD9D9AA",
      "diffEditor.insertedLineBackground": "#E7F7EA", "diffEditor.removedLineBackground": "#FCEAEA",
    },
  });
  monaco.editor.defineTheme("darcula", {
    base: "vs-dark", inherit: true,
    rules: [
      { token: "", foreground: "BCBEC4" },
      { token: "comment", foreground: "7A7E85", fontStyle: "italic" },
      { token: "keyword", foreground: "CF8E6D" }, { token: "keyword.flow", foreground: "CF8E6D" },
      { token: "string", foreground: "6AAB73" }, { token: "string.escape", foreground: "CF8E6D" },
      { token: "number", foreground: "2AACB8" }, { token: "regexp", foreground: "42C3D4" },
      { token: "type", foreground: "BCBEC4" }, { token: "type.identifier", foreground: "BCBEC4" },
      { token: "identifier", foreground: "BCBEC4" }, { token: "delimiter", foreground: "BCBEC4" },
      { token: "annotation", foreground: "B3AE60" }, { token: "tag", foreground: "D5B778" },
      { token: "attribute.name", foreground: "BABABA" }, { token: "attribute.value", foreground: "6AAB73" },
      { token: "constant", foreground: "C77DBB" }, { token: "variable.predefined", foreground: "8888C6" },
      { token: "key", foreground: "C77DBB" }, { token: "string.key.json", foreground: "C77DBB" }, { token: "string.value.json", foreground: "6AAB73" },
      { token: "keyword.json", foreground: "CF8E6D" }, { token: "metatag", foreground: "B3AE60" },
    ],
    colors: {
      "editor.background": "#1E1F22", "editor.foreground": "#BCBEC4",
      "editorLineNumber.foreground": "#4B5059", "editorLineNumber.activeForeground": "#A1A3AB",
      "editorGutter.background": "#1E1F22", "editor.lineHighlightBackground": "#26282E", "editor.lineHighlightBorder": "#26282E",
      "editor.selectionBackground": "#214283", "editor.inactiveSelectionBackground": "#21428388", "editorCursor.foreground": "#CED0D6",
      "editorIndentGuide.background1": "#313438", "editorIndentGuide.activeBackground1": "#4B5059",
      "editor.findMatchBackground": "#2E5B3A", "editor.findMatchHighlightBackground": "#2F4A3E",
      "editorWhitespace.foreground": "#393B40", "editorBracketMatch.background": "#43454A", "editorBracketMatch.border": "#43454A",
      "scrollbarSlider.background": "#4E515788", "scrollbarSlider.hoverBackground": "#5A5D63AA",
      "editorOverviewRuler.border": "#1E1F22", "editorWidget.background": "#2B2D30", "editorHoverWidget.background": "#2B2D30",
      "editorInlayHint.foreground": "#868A91", "editorInlayHint.background": "#00000000",
      "diffEditor.insertedTextBackground": "#375239AA", "diffEditor.removedTextBackground": "#5E383888",
      "diffEditor.insertedLineBackground": "#294436", "diffEditor.removedLineBackground": "#402929",
    },
  });
}

// ---------- small helpers ----------
const ICONS = { py: ["py", "#4B8BBE"], js: ["js", "#D4BE4B"], mjs: ["js", "#D4BE4B"], cjs: ["js", "#D4BE4B"], jsx: ["jsx", "#61AFC9"],
  ts: ["ts", "#3B7FC4"], tsx: ["tsx", "#3B7FC4"], json: ["{}", "#C4A84B"], md: ["M", "#8C9AA6"], html: ["<>", "#D2694A"], css: ["#", "#9A7AC6"],
  sh: ["$", "#7FB35A"], zsh: ["$", "#7FB35A"], yml: ["y", "#C75F5F"], yaml: ["y", "#C75F5F"], toml: ["t", "#A07D5A"], go: ["go", "#4FB6D6"],
  rs: ["rs", "#C88A5A"], java: ["J", "#C77A3A"], kt: ["K", "#9F7AEA"], rb: ["rb", "#C2453B"], php: ["php", "#7A86B8"], sql: ["sql", "#C4A84B"],
  c: ["c", "#7896B8"], h: ["h", "#7896B8"], cpp: ["c+", "#7896B8"], txt: ["≡", "#8C9AA6"], lock: ["🔒", "#8C9AA6"], env: ["e", "#8C9AA6"], dockerfile: ["🐳", "#4FB6D6"] };
function icon(name) {
  const ext = name.toLowerCase() === "dockerfile" ? "dockerfile" : name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  const [t, c] = ICONS[ext] || ["·", "#8C9AA6"];
  const el = h("span", "ficon", t);
  el.style.color = c;
  return el;
}
const FOLDER = '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M1.5 3h4.3l1.5 1.5h7.2v8.5H1.5z"/></svg>';
// no file open: the two ways to find one, as keys
const EMPTY = '<div class="ikeys"><span>⌕ <kbd>⇧⇧</kbd></span><span>⊞ <kbd>⌘⇧F</kbd></span></div>';
const GIT_CLASS = { modified: "g-mod", added: "g-add", untracked: "g-new", deleted: "g-del", renamed: "g-mod" };

// "go to file": the query's letters in order, rewarding runs, word starts and the file name
function fuzzy(q, s) {
  const t = s.toLowerCase(), qq = q.toLowerCase();
  let i = 0, score = 0, last = -2;
  for (let j = 0; j < t.length && i < qq.length; j++) {
    if (t[j] !== qq[i]) continue;
    score += j === last + 1 ? 3 : 1;
    if (j === 0 || "/_-. ".includes(t[j - 1])) score += 2;
    last = j; i++;
  }
  if (i < qq.length) return -1;
  const b = base(t);
  if (b.startsWith(qq)) score += 12; else if (b.includes(qq)) score += 6;
  return score - t.length * 0.02;
}

export class IdeLayer {
  // opts: api(method, path, body), path(id, rest), onClose(id), toast(text), onFrame(), canvasId(), askAgent(id, text),
  // fill: the IDE fills the container (its own window, ui/ide.html) instead of docking beside a node
  constructor(container, opts) {
    this.el = container;
    this.o = opts;
    this.ides = new Map(); // agent id -> entry
  }

  // ---------- state from the server ----------

  async set(id, view, reveal) {
    let e = this.ides.get(id);
    if (!view) { if (e) this.destroy(id); return; }
    if (!e) e = this.create(id);
    const prev = e.view;
    e.view = view;
    if (!e.dragging) e.ui = { ...view.ui };
    // in a window of its own (opts.fill) the IDE always fills it; folding and sizing belong to the dock
    e.el.classList.toggle("collapsed", !this.o.fill && !!e.ui.collapsed);
    e.el.classList.toggle("maxed", !this.o.fill && !!e.ui.maximized && !e.ui.collapsed);
    e.el.classList.toggle("notree", !e.ui.tree);
    e.el.classList.toggle("left-commit", e.ui.left === "commit");
    e.stripeBtns.project.classList.toggle("on", e.ui.tree && e.ui.left !== "commit");
    e.stripeBtns.commit.classList.toggle("on", e.ui.tree && e.ui.left === "commit");
    if (!prev) for (const s of view.sessions || []) e.sessions.set(s.id, s);
    e.title.textContent = e.strip.textContent = view.rootName;
    e.title.title = view.root;
    e.max.textContent = e.ui.maximized ? "❐" : "⤢";
    if (!prev || prev.root !== view.root) { e.dirs.clear(); e.expanded = new Set([""]); this.loadDir(e, ""); this.refreshGit(e); }
    this.bottom(e);
    await e.ready;
    this.renderTabs(e);
    if (view.active && view.active !== e.shown) await this.show(e, view.active);
    if (!view.active && e.shown) this.showNothing(e);
    this.decorate(e);
    this.decorateDebug(e);
    this.renderProblems(e);
    this.renderCommit(e);
    this.renderRunBox(e);
    if (reveal) await this.reveal(e, reveal);
    else if (!prev) {
      // opened with the canvas: show the latest note in the open file, where the agent left off
      const last = view.notes.filter((n) => n.path === view.active).at(-1);
      if (last) this.goLine(e, last.line, last.endLine);
    }
  }

  // files the agent (or anything) changed on disk
  async filesChanged(id, paths) {
    const e = this.ides.get(id);
    if (!e) return;
    // the folders on screen that hold a changed path (a new folder shows up in its parent)
    for (const d of new Set(paths.map(dirOf))) if (e.dirs.has(d)) this.loadDir(e, d);
    this.refreshGit(e);
    for (const p of paths) {
      const f = e.files.get(p);
      if (f && !f.model) { e.files.delete(p); if (e.shown === p) { e.shown = null; await this.show(e, p); } continue; } // binary, too large or missing: look again
      if (!f?.model) continue;
      const disk = await this.o.api("GET", this.o.path(id, `/ide/file?path=${enc(p)}`)).catch(() => null);
      if (!disk || disk.mtime === f.mtime) continue;
      if (this.dirty(f)) { f.diskChanged = disk; if (e.shown === p) this.banner(e); continue; }
      if (typeof disk.content === "string" && disk.content !== f.model.getValue()) {
        // keep the view where it was
        const ed = e.editor, keep = e.shown === p ? { pos: ed.getPosition(), top: ed.getScrollTop() } : null;
        f.model.pushEditOperations([], [{ range: f.model.getFullModelRange(), text: disk.content }], () => null);
        f.saved = f.model.getAlternativeVersionId();
        if (keep) { ed.setPosition(keep.pos); ed.setScrollTop(keep.top); }
        f.flash = Date.now();
      }
      f.mtime = disk.mtime;
      this.renderTabs(e);
    }
  }

  // ---------- building the dock ----------

  create(id) {
    const el = h("div", "ide");
    const head = el.appendChild(h("div", "ihead"));
    head.appendChild(h("span", "ilogo", "◆"));
    const title = head.appendChild(h("b", "ititle"));
    const crumb = head.appendChild(h("span", "icrumb"));
    head.appendChild(h("span", "spacer"));
    // the run configuration: the open file, ▶ Run and 🐞 Debug, ■ Stop
    const runbox = head.appendChild(h("div", "irun"));
    const cfgEl = runbox.appendChild(h("span", "icfg", "Current File"));
    const rb = (html, cls, tip, fn) => { const b = runbox.appendChild(h("button", `pbtn ${cls}`)); b.innerHTML = html; b.title = tip; b.onclick = (ev) => { ev.stopPropagation(); fn(); }; return b; };
    rb("▶", "irunbtn", T("Run (⌃R)"), () => this.run(e, "run"));
    rb(BUG, "idbgbtn", "Debug (⌃D)", () => this.run(e, "debug"));
    const stopBtn = rb("■", "istopbtn", T("Stop"), () => this.stopActive(e));
    const btn = (label, tip, fn) => { const b = head.appendChild(h("button", "pbtn", label)); b.title = tip; b.onclick = (ev) => { ev.stopPropagation(); fn(); }; return b; };
    btn("⌕", T("Go to file (⇧⇧ or ⌘P)"), () => this.goto(e));
    btn("⊞", T("Find in files (⌘⇧F)"), () => this.setBottom(e, "find", true));
    const max = btn("⤢", T("Maximize"), () => this.state(e, { ui: { maximized: !e.ui.maximized, collapsed: false } }));
    max.classList.add("imax");
    btn("–", T("Collapse"), () => this.state(e, { ui: { collapsed: true } })).classList.add("imin");
    btn("×", T("Close the IDE"), () => this.o.onClose?.(id)).classList.add("iclose");
    const strip = el.appendChild(h("div", "pstrip"));
    strip.title = T("Open the IDE");
    strip.onclick = () => this.state(e, { ui: { collapsed: false } });

    const body = el.appendChild(h("div", "ibody"));
    const stripe = body.appendChild(h("div", "istripe"));
    // the left tool windows: Project and Commit; clicking the open one hides it
    const side = (key, label) => {
      const b = stripe.appendChild(h("button", `istripe-btn ${key}`, label));
      b.onclick = () => {
        const open = e.ui.tree && (e.ui.left || "project") === key;
        this.state(e, { ui: { tree: !open, left: key } });
        if (key === "commit" && !open) this.refreshGit(e);
      };
      return b;
    };
    const stripeBtns = { project: side("project", "Project"), commit: side("commit", "Commit") };
    const tree = body.appendChild(h("div", "itree"));
    const commitEl = body.appendChild(h("div", "icommit"));
    const main = body.appendChild(h("div", "imain"));
    const tabs = main.appendChild(h("div", "itabs"));
    const bannerEl = main.appendChild(h("div", "ibanner"));
    bannerEl.hidden = true;
    const edBox = main.appendChild(h("div", "ieditor"));
    const empty = main.appendChild(h("div", "iempty"));
    empty.innerHTML = EMPTY;

    const bottomEl = el.appendChild(h("div", "ibottom"));
    bottomEl.hidden = true;
    const foot = el.appendChild(h("div", "ifoot"));
    const tools = foot.appendChild(h("div", "itools"));
    const toolBtn = (key, label) => { const b = tools.appendChild(h("button", `itool ${key}`, label)); b.onclick = () => this.setBottom(e, e.ui.bottom === key ? null : key); return b; };
    const toolBtns = { problems: toolBtn("problems", "⚠ Problems"), git: toolBtn("git", "⎇ Git"), find: toolBtn("find", "⌕ Find"),
      terminal: toolBtn("terminal", ">_ Terminal"), run: toolBtn("run", "▶ Run"), debug: toolBtn("debug", "Debug") };
    toolBtns.debug.innerHTML = `${BUG} Debug`;
    foot.appendChild(h("span", "spacer"));
    const status = foot.appendChild(h("div", "istatus"));
    const grip = el.appendChild(h("div", "pgrip"));

    // keep pointer, wheel and keys inside the IDE instead of panning/zooming/deleting on the canvas
    for (const ev of ["pointerdown", "mousedown", "wheel", "keydown", "keyup", "dblclick", "contextmenu"]) el.addEventListener(ev, (x) => x.stopPropagation());
    head.addEventListener("dblclick", () => !this.o.fill && this.state(e, { ui: { maximized: !e.ui.maximized, collapsed: false } }));
    // ⇧⇧ (PyCharm's Search Everywhere), ⌘P / ⌘⇧O go to file, ⌘⇧F find in files
    let lastShift = 0;
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Shift" && !ev.repeat) { const now = Date.now(); if (now - lastShift < 350) { lastShift = 0; this.goto(e); } else lastShift = now; return; }
      lastShift = 0;
      const mod = ev.metaKey || ev.ctrlKey;
      if (mod && !ev.shiftKey && ev.key.toLowerCase() === "p") { ev.preventDefault(); this.goto(e); }
      else if (mod && ev.shiftKey && ev.key.toLowerCase() === "o") { ev.preventDefault(); this.goto(e); }
      else if (mod && ev.shiftKey && ev.key.toLowerCase() === "f") { ev.preventDefault(); this.setBottom(e, "find", true); }
      // PyCharm's macOS keys: ⌃R run, ⌃D debug; F7/F8/⇧F8/F9 step into/over/out and resume
      else if (ev.ctrlKey && !ev.metaKey && ev.key.toLowerCase() === "r") { ev.preventDefault(); this.run(e, "run"); }
      else if (ev.ctrlKey && !ev.metaKey && ev.key.toLowerCase() === "d") { ev.preventDefault(); this.run(e, "debug"); }
      else if (ev.key === "F8") { ev.preventDefault(); this.debugCmd(e, ev.shiftKey ? "return" : "next"); }
      else if (ev.key === "F7") { ev.preventDefault(); this.debugCmd(e, "step"); }
      else if (ev.key === "F9") { ev.preventDefault(); this.debugCmd(e, "continue"); }
      else if (ev.key === "Escape" && e.diff && !ev.target.closest?.(".find-widget, input, textarea:not(.inputarea)")) this.closeDiff(e);
    }, true);

    const e = { id, el, head, title, crumb, max, strip, tree, tabs, bannerEl, edBox, empty, bottomEl, toolBtns, status, grip, main,
      commitEl, stripeBtns, cfgEl, stopBtn, commitSel: new Set(), commitSeen: new Set(), commitMsg: "", commitAmend: false, log: null, logSel: null,
      sessions: new Map(), consoles: new Map(), activeSession: {}, startedHere: new Set(), dbgDecos: null,
      view: null, ui: {}, files: new Map(), loading: new Map(), dirs: new Map(), expanded: new Set([""]), git: null, shown: null, scale: 1,
      editor: null, diff: null, decos: null, revealDecos: null, find: { q: "", regex: false, case: false, results: [] } };
    e.ready = loadMonaco().then((monaco) => this.mountEditor(e, monaco)).catch((err) => { empty.textContent = err.message; });
    if (this.o.fill) { el.classList.add("fill"); el.style.display = "flex"; } else this.resizable(e);
    this.el.appendChild(el);
    this.ides.set(id, e);
    return e;
  }

  mountEditor(e, monaco) {
    this.monaco = monaco;
    e.editor = monaco.editor.create(e.edBox, {
      theme: editorTheme(), automaticLayout: true, fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13, lineHeight: 20, glyphMargin: true, minimap: { enabled: false }, renderLineHighlight: "all",
      scrollBeyondLastLine: false, smoothScrolling: true, rulers: [120], tabSize: 4, insertSpaces: true,
      bracketPairColorization: { enabled: false }, guides: { indentation: true }, fixedOverflowWidgets: true, model: null,
    });
    e.decos = e.editor.createDecorationsCollection();
    e.revealDecos = e.editor.createDecorationsCollection();
    e.dbgDecos = e.editor.createDecorationsCollection();
    // a click in the gutter (left of the code) sets or removes a breakpoint, as in PyCharm
    const T = monaco.editor.MouseTargetType;
    e.editor.onMouseDown((ev) => {
      if (![T.GUTTER_GLYPH_MARGIN, T.GUTTER_LINE_NUMBERS, T.GUTTER_LINE_DECORATIONS].includes(ev.target.type) || !ev.target.position) return;
      if (ev.target.type === T.GUTTER_LINE_NUMBERS && !ev.event.altKey && ev.target.element?.closest?.(".line-numbers") && ev.event.detail > 1) return;
      this.toggleBreakpoint(e, ev.target.position.lineNumber);
    });
    e.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this.save(e));
    e.editor.onDidBlurEditorWidget(() => this.save(e, { quiet: true })); // PyCharm saves when you leave
    e.editor.onDidChangeCursorPosition(() => this.renderStatus(e));
    e.editor.onDidChangeModelContent(() => this.renderTabs(e));
  }

  destroy(id) {
    const e = this.ides.get(id);
    if (!e) return;
    for (const f of e.files.values()) f.model?.dispose();
    for (const c of e.consoles.values()) c.dispose();
    e.diff?.dispose();
    e.editor?.dispose();
    e.el.remove();
    this.ides.delete(id);
  }

  clear() { for (const id of [...this.ides.keys()]) this.destroy(id); }

  state(e, patch) {
    if (patch.ui) e.ui = { ...e.ui, ...patch.ui };
    e.view = { ...e.view, ...patch, ui: e.ui };
    this.o.onFrame?.();
    this.o.api("PATCH", this.o.path(e.id, "/ide"), patch).catch((err) => this.o.toast(err.message));
    return this.set(e.id, e.view);
  }

  resizable(e) {
    e.grip.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      e.grip.setPointerCapture(ev.pointerId);
      const start = [ev.clientX, ev.clientY], size = e.ui.maximized ? [...MAX] : [...e.ui.size];
      e.dragging = true;
      const move = (m) => {
        e.ui = { ...e.ui, maximized: false, size: [Math.max(420, size[0] + (m.clientX - start[0]) / e.scale), Math.max(260, size[1] + (m.clientY - start[1]) / e.scale)] };
        e.el.classList.remove("maxed");
        this.o.onFrame?.();
      };
      e.grip.addEventListener("pointermove", move);
      e.grip.addEventListener("pointerup", () => {
        e.grip.removeEventListener("pointermove", move);
        e.dragging = false;
        this.state(e, { ui: { size: e.ui.size.map(Math.round), maximized: false } });
      }, { once: true });
    });
  }

  // ---------- project tree ----------

  async loadDir(e, dir) {
    const r = await this.o.api("GET", this.o.path(e.id, `/ide/tree?path=${enc(dir)}`)).catch(() => null);
    if (!r) { e.dirs.delete(dir); } else e.dirs.set(dir, r.entries);
    this.renderTree(e);
  }

  renderTree(e) {
    const git = new Map((e.git?.files || []).map((f) => [f.path, f.status]));
    const changedDirs = new Set([...git.keys()].flatMap((p) => { const parts = p.split("/"); return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/")); }));
    const rows = [];
    const rootRow = h("div", "trow root");
    rootRow.innerHTML = FOLDER;
    rootRow.appendChild(h("b", "", e.view?.rootName || ""));
    rootRow.appendChild(h("span", "tpath", e.view?.root || ""));
    rows.push(rootRow);
    const walk = (dir, depth) => {
      for (const en of e.dirs.get(dir) || []) {
        const row = h("div", `trow${en.dir ? " dir" : ""}${en.excluded ? " excl" : ""}${e.shown === en.path ? " sel" : ""}`);
        row.style.paddingLeft = `${8 + depth * 14}px`;
        if (en.dir) {
          const open = e.expanded.has(en.path);
          row.appendChild(h("span", "tarrow", open ? "▾" : "▸"));
          const f = h("span", "tfolder"); f.innerHTML = FOLDER; row.appendChild(f);
          row.appendChild(h("span", `tname${changedDirs.has(en.path) ? " g-mod" : ""}`, en.name));
          row.onclick = () => { if (open) e.expanded.delete(en.path); else { e.expanded.add(en.path); if (!e.dirs.has(en.path)) this.loadDir(e, en.path); } this.renderTree(e); };
        } else {
          row.appendChild(h("span", "tarrow", ""));
          row.appendChild(icon(en.name));
          row.appendChild(h("span", `tname ${GIT_CLASS[git.get(en.path)] || ""}`, en.name));
          row.onclick = () => this.open(e, en.path);
        }
        row.oncontextmenu = (ev) => { ev.preventDefault(); this.treeMenu(e, en, ev); };
        rows.push(row);
        if (en.dir && e.expanded.has(en.path)) walk(en.path, depth + 1);
      }
    };
    walk("", 1);
    rootRow.oncontextmenu = (ev) => { ev.preventDefault(); this.treeMenu(e, { path: "", dir: true, name: e.view?.rootName }, ev); };
    const scroll = e.tree.scrollTop;
    e.tree.replaceChildren(...rows);
    e.tree.scrollTop = scroll;
  }

  // New file / folder, rename, delete: the tree's context menu
  async treeMenu(e, en, ev) {
    document.querySelector(".imenu")?.remove();
    const menu = h("div", "imenu");
    const dir = en.dir ? en.path : dirOf(en.path);
    const item = (label, fn, cls = "") => { const b = menu.appendChild(h("button", cls, label)); b.onclick = () => { menu.remove(); fn(); }; };
    const call = (m, rest, body) => this.o.api(m, this.o.path(e.id, rest), body).catch((err) => { this.o.toast(err.message); return null; });
    item(T("New file…"), async () => {
      const name = prompt(T("File name"), dir ? `${dir}/` : ""); if (!name) return;
      if (await call("PUT", "/ide/file", { path: name, content: "" })) { e.expanded.add(dirOf(name)); await this.loadDir(e, dirOf(name)); this.open(e, name); }
    });
    item(T("New folder…"), async () => {
      const name = prompt(T("Folder name"), dir ? `${dir}/` : ""); if (!name) return;
      if (await call("POST", "/ide/mkdir", { path: name })) { e.expanded.add(dirOf(name)); this.loadDir(e, dirOf(name)); }
    });
    if (en.path) {
      item(T("Rename…"), async () => {
        const to = prompt(T("New name"), en.path); if (!to || to === en.path) return;
        if (await call("POST", "/ide/move", { from: en.path, to })) {
          this.loadDir(e, dirOf(en.path)); this.loadDir(e, dirOf(to));
          if (e.view.tabs.includes(en.path)) this.closeTab(e, en.path);
        }
      });
      item(T("Delete"), async () => {
        if (!confirm(T('Delete "{path}"? This cannot be undone.', { path: en.path }))) return;
        if (await call("DELETE", `/ide/file?path=${enc(en.path)}`)) { this.loadDir(e, dirOf(en.path)); for (const t of e.view.tabs.filter((t) => t === en.path || t.startsWith(`${en.path}/`))) this.closeTab(e, t); }
      }, "danger");
    }
    menu.style.left = `${ev.clientX}px`;
    menu.style.top = `${ev.clientY}px`;
    document.body.appendChild(menu);
    setTimeout(() => addEventListener("pointerdown", (x) => { if (!menu.contains(x.target)) menu.remove(); }, { once: true }), 0);
  }

  // ---------- files and tabs ----------

  dirty(f) { return f?.model && f.saved !== f.model.getAlternativeVersionId(); }

  // one load per file at a time: opening a file can ask for it twice (the click and the state it causes)
  load(e, path) {
    if (e.files.has(path)) return Promise.resolve(e.files.get(path));
    if (!e.loading.has(path)) e.loading.set(path, this.fetchFile(e, path).finally(() => e.loading.delete(path)));
    return e.loading.get(path);
  }

  async fetchFile(e, path) {
    let f;
    const r = await this.o.api("GET", this.o.path(e.id, `/ide/file?path=${enc(path)}`)).catch((err) => ({ error: err.message }));
    f = { path, mtime: r.mtime };
    if (r.error || r.binary || r.tooLarge) f.note = r.error || `${r.binary ? T("Binary") : T("Too large")} · ${Math.round(r.size / 1024)} KB`;
    else {
      const uri = this.monaco.Uri.parse(`file:///${e.id}/${path.split("/").map(enc).join("/")}`);
      this.monaco.editor.getModel(uri)?.dispose();
      f.model = this.monaco.editor.createModel(r.content, undefined, uri);
      f.saved = f.model.getAlternativeVersionId();
    }
    e.files.set(path, f);
    return f;
  }

  // the user opens a file (tree, go to file, find, problems)
  async open(e, path, line, col) {
    const tabs = e.view.tabs.includes(path) ? e.view.tabs : [...e.view.tabs, path];
    await this.state(e, { tabs, active: path });
    if (e.shown !== path) await this.show(e, path);
    if (line) this.goLine(e, line, line, col);
  }

  async show(e, path) {
    if (e.shown && e.shown !== path) this.save(e, { quiet: true });
    this.closeDiff(e);
    const f = await this.load(e, path);
    e.shown = path;
    e.empty.hidden = !!f.model;
    if (!f.model) { e.empty.textContent = f.note; e.editor?.setModel(null); }
    else e.editor.setModel(f.model);
    e.crumb.textContent = path.split("/").join(" › ");
    this.banner(e);
    this.decorate(e);
    this.decorateDebug(e);
    this.renderTabs(e);
    this.renderTree(e);
    this.renderStatus(e);
    this.renderRunBox(e);
  }

  showNothing(e) {
    this.closeDiff(e);
    e.shown = null;
    e.editor?.setModel(null);
    e.empty.hidden = false;
    e.empty.innerHTML = EMPTY; // (a binary or too large file left its note there)
    e.crumb.textContent = "";
    this.banner(e);
    this.decorateDebug(e);
    this.renderTree(e);
    this.renderRunBox(e);
    this.renderTabs(e);
    this.renderStatus(e);
  }

  async closeTab(e, path) {
    const f = e.files.get(path);
    if (this.dirty(f)) await this.save(e, { path });
    f?.model?.dispose();
    e.files.delete(path);
    const tabs = e.view.tabs.filter((t) => t !== path);
    const i = e.view.tabs.indexOf(path);
    const active = e.view.active === path ? tabs[Math.min(i, tabs.length - 1)] || null : e.view.active;
    if (e.shown === path) e.shown = null;
    this.state(e, { tabs, active });
  }

  renderTabs(e) {
    const git = new Map((e.git?.files || []).map((f) => [f.path, f.status]));
    e.tabs.replaceChildren(...(e.view?.tabs || []).map((p) => {
      const f = e.files.get(p);
      const t = h("div", `itab${p === e.view.active ? " on" : ""}`);
      t.title = p;
      t.appendChild(icon(base(p)));
      t.appendChild(h("span", `tn ${GIT_CLASS[git.get(p)] || ""}`, base(p)));
      if (this.dirty(f)) t.appendChild(h("span", "tdirty", "•"));
      if (f?.flash && Date.now() - f.flash < 4000) t.classList.add("flash");
      const x = t.appendChild(h("button", "tx", "×"));
      x.onclick = (ev) => { ev.stopPropagation(); this.closeTab(e, p); };
      t.onclick = () => this.open(e, p);
      t.onauxclick = (ev) => { if (ev.button === 1) this.closeTab(e, p); };
      return t;
    }));
    e.tabs.querySelector(".on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  async save(e, { path = e.shown, quiet = false, force = false } = {}) {
    const f = e.files.get(path);
    if (!f?.model || (!this.dirty(f) && !force)) return;
    const version = f.model.getAlternativeVersionId();
    try {
      const r = await this.o.api("PUT", this.o.path(e.id, "/ide/file"), { path, content: f.model.getValue(), mtime: force ? undefined : f.mtime });
      f.mtime = r.mtime;
      f.saved = version;
      f.conflict = null;
      f.diskChanged = null;
    } catch (err) {
      if (/changed on disk/.test(err.message)) { f.conflict = true; if (e.shown === path) this.banner(e); }
      else if (!quiet) this.o.toast(err.message);
    }
    this.renderTabs(e);
  }

  // the file changed on disk while it had unsaved edits, or a save found a newer version
  banner(e) {
    const f = e.files.get(e.shown);
    const show = f && (f.conflict || f.diskChanged);
    e.bannerEl.hidden = !show;
    if (!show) return;
    // the same two-sided question either way: theirs on disk, or mine in the editor
    e.bannerEl.replaceChildren(h("span", "", T("⚠ Changed on disk")), h("span", "spacer"));
    const b = (label, fn, cls = "") => { const x = e.bannerEl.appendChild(h("button", `btn ${cls}`, label)); x.onclick = fn; };
    b(T("Diff"), () => this.diffWith(e, f.path, "disk"));
    b(T("Load from disk"), async () => {
      const disk = await this.o.api("GET", this.o.path(e.id, `/ide/file?path=${enc(f.path)}`)).catch((err) => { this.o.toast(err.message); return null; });
      if (!disk) return;
      this.closeDiff(e);
      f.model.setValue(disk.content ?? "");
      f.mtime = disk.mtime; f.saved = f.model.getAlternativeVersionId(); f.conflict = f.diskChanged = null;
      this.banner(e); this.renderTabs(e);
    });
    b(T("Save mine"), async () => { this.closeDiff(e); await this.save(e, { path: f.path, force: true }); this.banner(e); }, "primary");
  }

  // ---------- notes, reveal ----------

  decorate(e) {
    if (!e.decos || !this.monaco) return;
    const notes = (e.view?.notes || []).filter((n) => n.path === e.shown);
    const sev = { error: this.monaco.MarkerSeverity.Error, warning: this.monaco.MarkerSeverity.Warning, info: this.monaco.MarkerSeverity.Info };
    e.decos.set(notes.map((n) => ({
      range: new this.monaco.Range(n.line, 1, n.endLine, 1),
      options: { isWholeLine: true, className: `inote-line ${n.severity}`, glyphMarginClassName: `inote-glyph ${n.severity}`,
        glyphMarginHoverMessage: { value: `${T("**Agent note:**")} ${n.text}` }, hoverMessage: { value: n.text },
        overviewRuler: { color: { error: "#db5c5c", warning: "#d6ae58", info: "#548af7" }[n.severity], position: this.monaco.editor.OverviewRulerLane.Right } },
    })));
    // the same notes as markers, so they also show as squiggles and in Monaco's own problem navigation (F8)
    const f = e.files.get(e.shown);
    if (f?.model) this.monaco.editor.setModelMarkers(f.model, "agent", notes.map((n) => ({ startLineNumber: n.line, startColumn: 1, endLineNumber: n.endLine,
      endColumn: f.model.getLineMaxColumn(Math.min(n.endLine, f.model.getLineCount())), message: n.text, severity: sev[n.severity], source: "ajan" })));
  }

  async reveal(e, { path, line, endLine }) {
    if (e.shown !== path) await this.show(e, path);
    this.goLine(e, line, endLine);
  }

  goLine(e, line, endLine = line, col = 1) {
    if (!e.editor?.getModel()) return;
    e.editor.revealLinesInCenter(line, endLine);
    e.editor.setPosition({ lineNumber: line, column: col });
    e.revealDecos.set([{ range: new this.monaco.Range(line, 1, endLine, 1), options: { isWholeLine: true, className: "ireveal" } }]);
    clearTimeout(e.revealTimer);
    e.revealTimer = setTimeout(() => e.revealDecos.clear(), 2500);
  }

  // ---------- bottom tool windows ----------

  setBottom(e, key) {
    this.state(e, { ui: { bottom: key } });
    if (key === "git") this.refreshGit(e);
    if (key === "find") setTimeout(() => e.bottomEl.querySelector("input")?.select(), 50); // ready to type, however it opened
  }

  bottom(e) {
    const key = e.ui.bottom;
    for (const [k, b] of Object.entries(e.toolBtns)) b.classList.toggle("on", k === key);
    const n = (e.view?.notes || []).length;
    e.toolBtns.problems.textContent = `⚠ Problems${n ? ` ${n}` : ""}`;
    const live = (k) => [...e.sessions.values()].some((s) => s.kind === k && s.status === "running");
    e.toolBtns.run.classList.toggle("live", live("run"));
    e.toolBtns.debug.classList.toggle("live", live("debug"));
    e.bottomEl.hidden = !key;
    e.bottomEl.classList.toggle("big", ["terminal", "run", "debug"].includes(key));
    if (!key || e.bottomEl.dataset.key === key) return;
    e.bottomEl.dataset.key = key;
    e.bottomEl.replaceChildren();
    const head = e.bottomEl.appendChild(h("div", "bhead"));
    head.appendChild(h("b", "", { problems: "Problems", git: "Git", find: "Find", terminal: "Terminal", run: "Run", debug: "Debug" }[key]));
    head.appendChild(h("span", "spacer"));
    const content = h("div", "bbody");
    if (key === "problems") {
      const clear = head.appendChild(h("button", "pbtn wide", T("Clear")));
      clear.onclick = () => this.o.api("DELETE", this.o.path(e.id, "/ide/notes")).catch((err) => this.o.toast(err.message));
    }
    if (key === "git") { const r = head.appendChild(h("button", "pbtn", "↻")); r.title = T("Refresh"); r.onclick = () => this.refreshLog(e); }
    if (key === "find") {
      const form = h("form", "ifind");
      const input = form.appendChild(h("input"));
      input.placeholder = T("Search");
      input.value = e.find.q;
      const opt = (label, k, tip) => { const b = form.appendChild(h("button", `pbtn wide${e.find[k] ? " on" : ""}`, label)); b.type = "button"; b.title = tip; b.onclick = () => { e.find[k] = !e.find[k]; b.classList.toggle("on", e.find[k]); }; };
      opt("Aa", "case", T("Match case"));
      opt(".*", "regex", T("Regular expression"));
      form.onsubmit = (ev) => { ev.preventDefault(); this.runFind(e, input.value); };
      e.bottomEl.appendChild(form);
    }
    const close = head.appendChild(h("button", "pbtn", "–"));
    close.title = T("Hide");
    close.onclick = () => this.setBottom(e, null);
    e.bottomEl.appendChild(content);
    if (key === "problems") this.renderProblems(e);
    if (key === "git") this.refreshLog(e);
    if (key === "find") this.renderFind(e);
    this.renderSessions(e);
  }

  renderProblems(e) {
    this.bottom(e);
    const body = e.ui.bottom === "problems" && e.bottomEl.querySelector(".bbody");
    if (!body) return;
    const notes = e.view?.notes || [];
    if (!notes.length) return body.replaceChildren(h("div", "none", T("No notes")));
    const byFile = new Map();
    for (const n of notes) (byFile.get(n.path) || byFile.set(n.path, []).get(n.path)).push(n);
    body.replaceChildren(...[...byFile].flatMap(([path, list]) => [
      (() => { const r = h("div", "brow file"); r.appendChild(icon(base(path))); r.appendChild(h("b", "", base(path))); r.appendChild(h("span", "dim", dirOf(path))); r.appendChild(h("span", "dim", `${list.length}`)); return r; })(),
      ...list.sort((a, b) => a.line - b.line).map((n) => {
        const r = h("div", `brow note ${n.severity}`);
        r.appendChild(h("span", "sev", { error: "●", warning: "▲", info: "ℹ" }[n.severity]));
        r.appendChild(h("span", "txt", n.text));
        r.appendChild(h("span", "dim", `:${n.line}`));
        r.onclick = () => this.open(e, n.path, n.line);
        return r;
      }),
    ]));
  }

  async refreshGit(e) {
    e.git = await this.o.api("GET", this.o.path(e.id, "/ide/git")).catch(() => null);
    e.el.classList.toggle("nogit", !e.git); // a folder outside git has no Commit or Git windows
    this.renderCommit(e);
    this.renderTree(e);
    this.renderTabs(e);
    this.renderStatus(e);
    this.bottom(e);
  }

  async runFind(e, q) {
    e.find.q = q;
    if (!q) return;
    const body = e.bottomEl.querySelector(".bbody");
    body.replaceChildren(h("div", "none", T("Searching…")));
    const r = await this.o.api("GET", this.o.path(e.id, `/ide/search?q=${enc(q)}&regex=${e.find.regex ? 1 : 0}&case=${e.find.case ? 1 : 0}`)).catch((err) => ({ error: err.message }));
    e.find.results = r.results || [];
    e.find.error = r.error;
    this.renderFind(e);
  }

  renderFind(e) {
    const body = e.ui.bottom === "find" && e.bottomEl.querySelector(".bbody");
    if (!body) return;
    const { results, q, error } = e.find;
    if (error) return body.replaceChildren(h("div", "none bad", error));
    if (!q) return body.replaceChildren();
    if (!results.length) return body.replaceChildren(h("div", "none", T("No results")));
    body.replaceChildren(h("div", "dim pad", T("{n} matches", { n: `${results.length}${results.length >= 500 ? "+" : ""}` })), ...results.map((m) => {
      const r = h("div", "brow");
      r.appendChild(icon(base(m.path)));
      const t = r.appendChild(h("span", "txt code"));
      t.textContent = m.text.trim();
      r.appendChild(h("span", "dim", `${m.path}:${m.line}`));
      r.onclick = () => this.open(e, m.path, m.line, m.col);
      return r;
    }));
  }

  // ---------- diff ----------

  async diffWith(e, path, against) {
    await e.ready;
    if (!this.monaco) { this.o.toast(T("editor failed to load; close and reopen the IDE")); return; }
    if (e.shown !== path) { await this.open(e, path); }
    const f = e.files.get(path);
    if (!f?.model) return;
    const other = against === "head"
      ? (await this.o.api("GET", this.o.path(e.id, `/ide/git?path=${enc(path)}`))).content
      : (await this.o.api("GET", this.o.path(e.id, `/ide/file?path=${enc(path)}`))).content ?? "";
    this.closeDiff(e);
    const m = this.monaco;
    e.diffOrig = m.editor.createModel(other, f.model.getLanguageId());
    const box = e.main.appendChild(h("div", "ieditor idiff"));
    const bar = box.appendChild(h("div", "idiffbar"));
    bar.appendChild(h("span", "", `${path} · ${against === "head" ? "HEAD" : T("Working copy")} ↔ ${T("editor")}`));
    bar.appendChild(h("span", "spacer"));
    const close = bar.appendChild(h("button", "pbtn", "×"));
    close.title = T("Close (Esc)");
    close.onclick = () => this.closeDiff(e);
    const host = box.appendChild(h("div", "idiffhost"));
    e.diff = m.editor.createDiffEditor(host, { theme: editorTheme(), automaticLayout: true, renderSideBySide: true, originalEditable: false,
      fontSize: 13, lineHeight: 20, minimap: { enabled: false }, fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace' });
    e.diff.setModel({ original: e.diffOrig, modified: f.model });
    const first = e.diff.onDidUpdateDiff(() => { first.dispose(); e.diff?.goToDiff("next"); }); // to the first change
    e.diffBox = box;
    e.edBox.hidden = true;
  }

  // a read-only diff of two texts (a commit in the log)
  diffTexts(e, title, left, right, path) {
    const m = this.monaco;
    if (!m) return;
    this.closeDiff(e);
    const uri = m.Uri.parse(`file:///diff/${Date.now()}/${path.split("/").map(enc).join("/")}`);
    // an empty probe model always reports plaintext: guess from the extension instead
    const lang = langOf(path) || m.editor.createModel("", undefined, uri).getLanguageId();
    m.editor.getModel(uri)?.dispose();
    e.diffOrig = m.editor.createModel(left, lang);
    e.diffMod = m.editor.createModel(right, lang);
    const box = e.main.appendChild(h("div", "ieditor idiff"));
    const bar = box.appendChild(h("div", "idiffbar"));
    bar.appendChild(h("span", "", title));
    bar.appendChild(h("span", "spacer"));
    const close = bar.appendChild(h("button", "pbtn", "×"));
    close.title = T("Close (Esc)");
    close.onclick = () => this.closeDiff(e);
    const host = box.appendChild(h("div", "idiffhost"));
    e.diff = m.editor.createDiffEditor(host, { theme: editorTheme(), automaticLayout: true, readOnly: true, originalEditable: false,
      fontSize: 13, lineHeight: 20, minimap: { enabled: false }, fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace' });
    e.diff.setModel({ original: e.diffOrig, modified: e.diffMod });
    const first = e.diff.onDidUpdateDiff(() => { first.dispose(); e.diff?.goToDiff("next"); });
    e.diffBox = box;
    e.edBox.hidden = true;
  }

  closeDiff(e) {
    if (!e.diff) return;
    e.diff.setModel(null);
    e.diff.dispose();
    e.diffOrig?.dispose();
    e.diffMod?.dispose();
    e.diffBox.remove();
    e.diff = e.diffOrig = e.diffMod = e.diffBox = null;
    e.edBox.hidden = false;
  }

  // ---------- go to file ----------

  async goto(e) {
    e.el.querySelector(".igoto")?.remove();
    const box = e.el.appendChild(h("div", "igoto"));
    const input = box.appendChild(h("input"));
    input.placeholder = T("Go to file…");
    const list = box.appendChild(h("div", "glist"));
    const files = (await this.o.api("GET", this.o.path(e.id, "/ide/files")).catch(() => ({ files: [] }))).files;
    let sel = 0, shown = [];
    const draw = () => {
      const q = input.value.trim();
      shown = q ? files.map((f) => [f, fuzzy(q, f)]).filter(([, s]) => s >= 0).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([f]) => f)
        : [...(e.view.tabs || [])].reverse().concat(files).filter((f, i, a) => a.indexOf(f) === i).slice(0, 50);
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      list.replaceChildren(...shown.map((f, i) => {
        const r = h("div", `grow${i === sel ? " on" : ""}`);
        r.appendChild(icon(base(f)));
        r.appendChild(h("b", "", base(f)));
        r.appendChild(h("span", "dim", dirOf(f)));
        r.onmousedown = (ev) => { ev.preventDefault(); done(f); };
        return r;
      }));
      list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
    };
    const done = (f) => { box.remove(); if (f) this.open(e, f); };
    input.oninput = () => { sel = 0; draw(); };
    input.onkeydown = (ev) => {
      if (ev.key === "ArrowDown") { sel = Math.min(sel + 1, shown.length - 1); draw(); ev.preventDefault(); }
      else if (ev.key === "ArrowUp") { sel = Math.max(sel - 1, 0); draw(); ev.preventDefault(); }
      else if (ev.key === "Enter") done(shown[sel]);
      else if (ev.key === "Escape") done(null);
    };
    input.onblur = () => setTimeout(() => box.remove(), 150);
    draw();
    input.focus();
  }

  renderStatus(e) {
    const parts = [];
    const pos = e.editor?.getPosition();
    const model = e.editor?.getModel();
    if (model && pos) {
      parts.push(`${pos.lineNumber}:${pos.column}`);
      parts.push(model.getEOL() === "\n" ? "LF" : "CRLF", "UTF-8");
      const lang = this.monaco?.languages.getLanguages().find((l) => l.id === model.getLanguageId());
      parts.push(lang?.aliases?.[0] || model.getLanguageId());
    }
    if (e.git?.branch) parts.push(`⎇ ${e.git.branch}`);
    e.status.textContent = parts.join("    ");
  }

  // ---------- layout ----------

  // Called every frame; `before(id)` is how much room the node's panel takes to its right.
  layout({ scale, offset }, rects, before) {
    for (const [id, e] of this.ides) {
      const r = rects.get(id);
      if (!r || scale < MIN_SCALE) { e.el.style.display = "none"; continue; }
      const [w, hh] = e.ui.collapsed ? [COLLAPSED_W, r.h] : e.ui.maximized ? MAX : e.ui.size;
      const s = e.el.style;
      s.display = "flex";
      s.left = `${(r.x + r.w + GAP + (before(id) || 0) + offset[0]) * scale}px`;
      s.top = `${(r.y + offset[1]) * scale}px`;
      s.width = `${w}px`;
      s.height = `${hh}px`;
      s.transform = `scale(${scale})`;
      e.scale = scale;
    }
  }

  icon(name) { return icon(name); }

  // a terminal, run or debug session changed (from the event stream)
  sessionChanged(id, s) {
    const e = this.ides.get(id);
    if (e) this.session(e, s);
  }

  extent(id, nodeH) {
    const e = this.ides.get(id);
    if (!e) return null;
    const [w, hh] = e.ui.collapsed ? [COLLAPSED_W, nodeH] : e.ui.maximized ? MAX : e.ui.size;
    return [w + GAP, hh];
  }
}

Object.assign(IdeLayer.prototype, toolMethods);
