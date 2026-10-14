// The IDE's PyCharm tool windows, added to IdeLayer (ide.mjs): Commit (left), Git log, Terminal, Run and
// Debug (bottom), plus breakpoints, the execution line and inline values in the editor.

import { Terminal } from "../vendor/xterm.mjs";
import { FitAddon } from "../vendor/xterm-addon-fit.mjs";
import { INLINE } from "./ide.mjs";
import { T } from "./lang.mjs";
import { termTheme } from "./term.mjs";
import { onTheme } from "./theme.mjs";

const h = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};
const enc = encodeURIComponent;
const base = (p) => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const STATUS_TR = { modified: T("modified"), added: T("added"), untracked: T("untracked"), deleted: T("deleted"), renamed: T("moved") };
const GIT_CLASS = { modified: "g-mod", added: "g-add", untracked: "g-new", deleted: "g-del", renamed: "g-mod" };
export const BUG = '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M8 2.2c1.4 0 2.5.9 2.8 2.1H5.2C5.5 3.1 6.6 2.2 8 2.2zM4.6 5.3h6.8c.6.6 1 1.4 1.1 2.3h2v1.2h-2v.9l2.2 1.4-.6 1-1.9-1.2A4.4 4.4 0 0 1 8 13.8a4.4 4.4 0 0 1-4.2-2.9l-1.9 1.2-.6-1L3.5 9.7v-.9h-2V7.6h2c.1-.9.5-1.7 1.1-2.3z"/></svg>';

// A terminal-like console for a session: xterm attached to the session's pty over a WebSocket.
class Console {
  constructor(url) {
    this.div = h("div", "icons");
    this.term = new Terminal({ fontSize: 12.5, fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace', theme: termTheme(), cursorBlink: true, scrollback: 5000 });
    this.offTheme = onTheme(() => { this.term.options.theme = termTheme(); });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.div);
    this.url = url;
    this.term.onData((d) => { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: "i", d })); });
    this.term.onResize(({ cols, rows }) => { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: "r", cols, rows })); });
    new ResizeObserver(() => { if (this.div.offsetWidth) try { this.fit.fit(); } catch { /* hidden */ } }).observe(this.div);
    this.connect();
  }

  connect() {
    if (this.closed) return;
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${this.url}`);
    this.ws = ws;
    ws.onopen = () => { this.term.reset(); try { this.fit.fit(); } catch { /* hidden */ } ws.send(JSON.stringify({ t: "r", cols: this.term.cols, rows: this.term.rows })); };
    ws.onmessage = (m) => this.term.write(typeof m.data === "string" ? m.data : new Uint8Array(m.data));
  }

  dispose() { this.closed = true; this.offTheme(); this.ws?.close(); this.term.dispose(); this.div.remove(); }
}

export const toolMethods = {
  // ---------- Commit (left tool window) ----------

  // The toolbar, the changed files and the message form. The form is built once and kept, so the list can
  // redraw (the agent saves files while the user writes a message) without taking the text or the focus.
  renderCommit(e) {
    const box = e.commitEl;
    if (!box || e.ui.left !== "commit") return;
    const files = e.git?.files || [];
    // new changes start selected, new files don't (like PyCharm's default changelist)
    for (const f of files) if (!e.commitSeen.has(f.path)) { e.commitSeen.add(f.path); if (f.status !== "untracked") e.commitSel.add(f.path); }
    for (const p of [...e.commitSel]) if (!files.some((f) => f.path === p)) e.commitSel.delete(p);
    if (!e.commitForm) e.commitForm = this.commitForm(e);
    const bar = h("div", "cbar");
    const tb = (label, tip, fn) => { const b = bar.appendChild(h("button", "pbtn", label)); b.title = tip; b.onclick = fn; return b; };
    tb("↻", T("Refresh"), () => this.refreshGit(e));
    tb("↶", "Rollback", () => this.rollback(e));
    tb("⇆", T("Diff"), () => { const p = [...e.commitSel][0]; if (p) this.diffWith(e, p, "head"); });
    bar.appendChild(h("span", "spacer"));
    bar.appendChild(h("span", "dim", e.git?.branch ? `⎇ ${e.git.branch}` : ""));
    const list = h("div", "clist");
    const group = (title, items) => {
      if (!items.length) return;
      const head = list.appendChild(h("div", "cgroup"));
      const all = head.appendChild(h("input"));
      all.type = "checkbox";
      all.checked = items.every((f) => e.commitSel.has(f.path));
      all.indeterminate = !all.checked && items.some((f) => e.commitSel.has(f.path));
      all.onchange = () => { for (const f of items) all.checked ? e.commitSel.add(f.path) : e.commitSel.delete(f.path); this.renderCommit(e); };
      head.appendChild(h("b", "", title));
      head.appendChild(h("span", "dim", T("{n} files", { n: items.length })));
      for (const f of items) {
        const row = list.appendChild(h("div", "crow"));
        const cb = row.appendChild(h("input"));
        cb.type = "checkbox";
        cb.checked = e.commitSel.has(f.path);
        cb.onchange = () => { cb.checked ? e.commitSel.add(f.path) : e.commitSel.delete(f.path); this.renderCommit(e); };
        row.appendChild(this.icon(base(f.path)));
        row.appendChild(h("span", `cname ${GIT_CLASS[f.status] || ""}`, base(f.path)));
        row.appendChild(h("span", "dim", dirOf(f.path)));
        row.title = `${f.path} · ${STATUS_TR[f.status] || f.status}`;
        row.onclick = (ev) => { if (ev.target !== cb && f.status !== "deleted") this.diffWith(e, f.path, "head"); };
        row.ondblclick = () => { if (f.status !== "deleted") this.open(e, f.path); };
      }
    };
    group("Changes", files.filter((f) => f.status !== "untracked"));
    group("Unversioned Files", files.filter((f) => f.status === "untracked"));
    if (e.git && !files.length) list.appendChild(h("div", "none", T("No changes")));
    const f = e.commitForm;
    if (f.msg.value !== (e.commitMsg || "")) f.msg.value = e.commitMsg || "";
    f.amend.checked = !!e.commitAmend;
    this.commitButtons(e);
    f.top.replaceChildren(bar, list);
    if (f.el.parentNode !== box) box.replaceChildren(f.top, f.el);
  },

  commitForm(e) {
    const el = h("div", "cform");
    const amendRow = el.appendChild(h("label", "camend"));
    const amend = amendRow.appendChild(h("input"));
    amend.type = "checkbox";
    amendRow.appendChild(document.createTextNode(" Amend"));
    const msg = el.appendChild(h("textarea", "cmsg"));
    msg.placeholder = T("Commit message");
    msg.oninput = () => { e.commitMsg = msg.value; };
    amend.onchange = async () => {
      e.commitAmend = amend.checked;
      this.commitButtons(e);
      if (amend.checked && !msg.value.trim()) {
        const log = await this.o.api("GET", this.o.path(e.id, "/ide/log")).catch(() => null);
        msg.value = e.commitMsg = log?.commits?.[0]?.subject || "";
      }
    };
    const row = el.appendChild(h("div", "cbtns"));
    const commit = row.appendChild(h("button", "btn primary", "Commit"));
    const push = row.appendChild(h("button", "btn", "Commit and Push…"));
    commit.onclick = () => this.commit(e, false);
    push.onclick = () => this.commit(e, true);
    const count = row.appendChild(h("span", "dim"));
    msg.onkeydown = (ev) => { if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") this.commit(e, false); };
    return { top: h("div", "ctop"), el, msg, amend, commit, push, count };
  },

  commitButtons(e) {
    const f = e.commitForm, n = e.commitSel.size;
    for (const b of [f.commit, f.push]) b.disabled = !n && !f.amend.checked;
    f.count.textContent = n ? T("{n} files", { n }) : "";
  },

  async commit(e, andPush) {
    const files = [...e.commitSel];
    const message = (e.commitMsg || "").trim();
    if (!message) return this.o.toast(T("Write a commit message"));
    for (const p of files) { const f = e.files.get(p); if (this.dirty(f)) await this.save(e, { path: p }); } // what you see is what you commit
    try {
      const r = await this.o.api("POST", this.o.path(e.id, "/ide/commit"), { files, message, amend: !!e.commitAmend });
      this.o.toast(T("{n} files committed: {hash} {subject}", { n: files.length, hash: r.hash, subject: r.subject }));
      e.commitMsg = "";
      e.commitAmend = false;
      if (andPush) {
        const p = await this.o.api("POST", this.o.path(e.id, "/ide/push")).catch((err) => ({ error: err.message }));
        this.o.toast(p.error ? T("Push failed: {error}", { error: p.error }) : T("Pushed{extra}", { extra: p.output ? `: ${p.output.split("\n").at(-1)}` : "" }));
      }
    } catch (err) { this.o.toast(err.message); }
    this.closeDiff(e); // a diff against HEAD is stale now
    await this.refreshGit(e);
    if (e.ui.bottom === "git") this.refreshLog(e);
  },

  async rollback(e) {
    const files = [...e.commitSel];
    if (!files.length) return this.o.toast(T("Select files to revert"));
    const fresh = files.filter((p) => e.git?.files.find((f) => f.path === p)?.status === "untracked");
    if (!confirm(T("Revert changes in {n} files?{fresh}\nThis cannot be undone.", { n: files.length, fresh: fresh.length ? T("\n{fresh} new files will be deleted.", { fresh: fresh.length }) : "" }))) return;
    try {
      const r = await this.o.api("POST", this.o.path(e.id, "/ide/rollback"), { files });
      this.o.toast(T("Reverted: {n} files{deleted}", { n: r.restored, deleted: r.deleted ? T(", {d} new files deleted", { d: r.deleted }) : "" }));
    } catch (err) { this.o.toast(err.message); }
    this.closeDiff(e);
    this.refreshGit(e);
  },

  // ---------- Git log (bottom) ----------

  async refreshLog(e) {
    e.log = (await this.o.api("GET", this.o.path(e.id, "/ide/log")).catch(() => ({ commits: [] }))).commits;
    this.renderLog(e);
  },

  renderLog(e) {
    const body = e.ui.bottom === "git" && e.bottomEl.querySelector(".bbody");
    if (!body) return;
    if (!e.log) { body.replaceChildren(h("div", "none", T("Loading…"))); return this.refreshLog(e); }
    if (!e.log.length) return body.replaceChildren(h("div", "none", T("No commits")));
    if (!e.log.some((c) => c.hash === e.logSel)) e.logSel = e.log[0].hash; // the latest, until another is chosen
    const wrap = h("div", "lwrap");
    const list = wrap.appendChild(h("div", "llist"));
    const detail = wrap.appendChild(h("div", "ldetail"));
    for (const c of e.log) {
      const row = list.appendChild(h("div", `lrow${e.logSel === c.hash ? " on" : ""}`));
      row.appendChild(h("span", "lsub", c.subject));
      for (const r of c.refs.slice(0, 2)) row.appendChild(h("span", "lref", r.replace("HEAD -> ", "")));
      row.appendChild(h("span", "dim", c.author));
      row.appendChild(h("span", "dim", c.date));
      row.onclick = () => { e.logSel = c.hash; this.renderLog(e); };
    }
    this.renderCommitDetail(e, detail, e.logSel);
    body.replaceChildren(wrap);
  },

  async renderCommitDetail(e, el, hash) {
    const c = await this.o.api("GET", this.o.path(e.id, `/ide/show?hash=${hash}`)).catch((err) => ({ error: err.message }));
    if (c.error) return el.replaceChildren(h("div", "none bad", c.error));
    el.replaceChildren(h("div", "lmsg", c.message), h("div", "dim pad", `${c.hash.slice(0, 10)} · ${c.author} · ${c.date}`),
      ...c.files.map((f) => {
        const r = h("div", "brow");
        r.appendChild(this.icon(base(f.path)));
        r.appendChild(h("span", `txt ${GIT_CLASS[f.status] || ""}`, base(f.path)));
        r.appendChild(h("span", "dim", dirOf(f.path)));
        r.onclick = () => this.diffRev(e, c.hash, f.path);
        return r;
      }));
  },

  async diffRev(e, hash, path) {
    const get = (rev) => this.o.api("GET", this.o.path(e.id, `/ide/rev?rev=${rev}&path=${enc(path)}`)).then((r) => r.content).catch(() => "");
    const [left, right] = await Promise.all([get(`${hash}^`), get(hash)]);
    this.diffTexts(e, `${path} · ${hash.slice(0, 8)}^ ↔ ${hash.slice(0, 8)}`, left, right, path);
  },

  // ---------- sessions: Terminal, Run, Debug (bottom) ----------

  session(e, s) {
    if (s.removed) {
      e.sessions.delete(s.id);
      e.consoles.get(s.id)?.dispose();
      e.consoles.delete(s.id);
    } else {
      const prev = e.sessions.get(s.id);
      e.sessions.set(s.id, s);
      if (!prev && e.startedHere.delete(s.id)) { e.activeSession[s.kind] = s.id; this.setBottom(e, s.kind); }
      if (s.kind === "debug" && s.debug?.status === "paused" && (prev?.debug?.status !== "paused" || prev?.debug?.frames?.[0]?.line !== s.debug.frames?.[0]?.line || prev?.debug?.frame !== s.debug.frame)) {
        e.activeSession.debug = s.id;
        e.debugTab = "debugger";
        const f = s.debug.frames[s.debug.frame || 0];
        if (f && !f.path.startsWith("/")) this.reveal(e, { path: f.path, line: f.line, endLine: f.line });
        if (e.ui.bottom !== "debug") this.setBottom(e, "debug");
      }
      // the program ended: what's left to see is its output
      if (s.kind === "debug" && s.debug?.status === "ended" && prev?.debug?.status !== "ended" && e.activeSession.debug === s.id) e.debugTab = "console";
    }
    this.renderRunBox(e);
    this.renderSessions(e);
    this.decorateDebug(e);
    this.bottom(e);
  },

  async startSession(e, kind, path) {
    try {
      if (kind !== "terminal") {
        if (!path) return this.o.toast(T("Open the file to run first"));
        const f = e.files.get(path);
        if (this.dirty(f)) await this.save(e, { path });
      }
      const s = await this.o.api("POST", this.o.path(e.id, "/ide/sessions"), { kind, path });
      e.startedHere.add(s.id);
      if (!e.sessions.has(s.id)) this.session(e, s);
      else { e.activeSession[kind] = s.id; this.setBottom(e, kind); }
    } catch (err) { this.o.toast(err.message); }
  },

  run(e, kind) { return this.startSession(e, kind, e.shown); },

  stopActive(e) {
    const live = [...e.sessions.values()].filter((s) => s.kind !== "terminal" && s.status === "running");
    const s = live.find((x) => x.id === e.activeSession[e.ui.bottom]) || live.at(-1);
    if (s) this.o.api("POST", this.o.path(e.id, `/ide/sessions/${s.id}/stop`)).catch((err) => this.o.toast(err.message));
  },

  debugCmd(e, cmd, args = {}) {
    const s = e.sessions.get(e.activeSession.debug);
    if (!s) return null;
    return this.o.api("POST", this.o.path(e.id, `/ide/sessions/${s.id}/debug`), { cmd, ...args }).catch((err) => { this.o.toast(err.message); return null; });
  },

  renderRunBox(e) {
    const live = [...e.sessions.values()].some((s) => s.kind !== "terminal" && s.status === "running");
    e.stopBtn.disabled = !live;
    e.cfgEl.textContent = e.shown ? base(e.shown) : "Current File";
    e.cfgEl.title = e.shown || "";
    const big = e.bottomEl.querySelector(".ibig");
    if (big) big.disabled = !e.shown;
    const paused = [...e.sessions.values()].some((s) => s.debug?.status === "paused");
    e.el.classList.toggle("dbg-paused", paused);
  },

  console(e, s) {
    let c = e.consoles.get(s.id);
    if (!c) {
      c = new Console(`/term/ide/${this.o.canvasId()}/${e.id}/${s.id}`);
      e.consoles.set(s.id, c);
    }
    return c;
  },

  // the session tabs and contents of the Terminal, Run or Debug window
  renderSessions(e) {
    const kind = e.ui.bottom;
    if (!["terminal", "run", "debug"].includes(kind)) return;
    const body = e.bottomEl.querySelector(".bbody");
    if (!body) return;
    const list = [...e.sessions.values()].filter((s) => s.kind === kind);
    if (!list.some((s) => s.id === e.activeSession[kind])) e.activeSession[kind] = list.at(-1)?.id;
    const active = e.sessions.get(e.activeSession[kind]);
    body.classList.add("sess");
    const tabs = h("div", "stabs");
    for (const s of list) {
      const t = tabs.appendChild(h("div", `stab${s.id === active?.id ? " on" : ""}${s.status === "exited" ? " done" : ""}`));
      if (s.kind === "debug") { const i = h("span", "sicon"); i.innerHTML = BUG; t.appendChild(i); } else if (s.kind === "run") t.appendChild(h("span", "sicon run", "▶"));
      t.appendChild(h("span", "", s.title));
      if (s.status === "exited") t.appendChild(h("span", "dim", s.exitCode ? `(${s.exitCode})` : "✓"));
      const x = t.appendChild(h("button", "tx", "×"));
      x.title = T("Close");
      x.onclick = (ev) => { ev.stopPropagation(); this.o.api("DELETE", this.o.path(e.id, `/ide/sessions/${s.id}`)).catch(() => {}); };
      t.onclick = () => { e.activeSession[kind] = s.id; this.renderSessions(e); this.decorateDebug(e); };
    }
    if (kind === "terminal") { const add = tabs.appendChild(h("button", "pbtn", "+")); add.title = T("New terminal"); add.onclick = () => this.startSession(e, "terminal"); }
    if (kind === "run" && active) {
      tabs.appendChild(h("span", "spacer"));
      const re = tabs.appendChild(h("button", "pbtn", "⟳")); re.title = T("Rerun"); re.onclick = () => this.startSession(e, "run", active.path);
      const st = tabs.appendChild(h("button", "pbtn", "■")); st.title = T("Stop"); st.disabled = active.status !== "running";
      st.onclick = () => this.o.api("POST", this.o.path(e.id, `/ide/sessions/${active.id}/stop`)).catch(() => {});
    }
    const content = h("div", "scontent");
    if (!active) {
      if (kind === "terminal") {
        if (!e.autoTerminal) { e.autoTerminal = true; this.startSession(e, "terminal"); }
      } else {
        // nothing ran yet: the one thing to do here, for the open file
        const go = content.appendChild(h("button", `ibig ${kind}`));
        go.innerHTML = kind === "run" ? "▶" : BUG;
        go.title = `${kind === "run" ? T("Run (⌃R)") : "Debug (⌃D)"}${e.shown ? `: ${base(e.shown)}` : ""}`;
        go.disabled = !e.shown;
        go.onclick = () => this.run(e, kind);
      }
    } else if (kind === "debug") this.renderDebugger(e, active, content);
    else content.appendChild(this.console(e, active).div);
    body.replaceChildren(tabs, content);
    if (active && kind !== "debug") setTimeout(() => { const c = e.consoles.get(active.id); try { c?.fit.fit(); } catch { /* hidden */ } if (kind === "terminal") c?.term.focus(); }, 30);
  },

  renderDebugger(e, s, content) {
    const d = s.debug || { status: "starting" };
    const bar = content.appendChild(h("div", "dbar"));
    const paused = d.status === "paused", live = s.status === "running";
    const b = (label, tip, fn, on) => { const x = bar.appendChild(h("button", "pbtn dbtn", label)); x.title = tip; x.disabled = !on; x.onclick = fn; return x; };
    b("▶", T("Resume (F9)"), () => this.debugCmd(e, "continue"), paused);
    b("⏸", T("Pause"), () => this.debugCmd(e, "pause"), live && !paused);
    b("↷", T("Step over (F8)"), () => this.debugCmd(e, "next"), paused);
    b("↓", T("Step into (F7)"), () => this.debugCmd(e, "step"), paused);
    b("↑", T("Step out (⇧F8)"), () => this.debugCmd(e, "return"), paused);
    b("■", T("Stop"), () => this.debugCmd(e, "stop"), live);
    const re = b("⟳", T("Restart"), () => this.startSession(e, "debug", s.path), true);
    re.classList.add("sep");
    bar.appendChild(h("span", "dsep"));
    for (const [k, label] of [["debugger", "Debugger"], ["console", "Console"]]) {
      const t = bar.appendChild(h("button", `dtab${(e.debugTab || "debugger") === k ? " on" : ""}`, label));
      t.onclick = () => { e.debugTab = k; this.renderSessions(e); };
    }
    bar.appendChild(h("span", "spacer"));
    const st = bar.appendChild(h("span", `dstate ${d.status}`, { starting: T("starting…"), running: T("running"), paused: d.reason === "exception" ? T("exception caught") : T("paused"), ended: T("ended{exit}", { exit: d.exitCode ? ` (${d.exitCode})` : "" }) }[d.status] || d.status));
    st.title = d.exception || "";
    if (paused) {
      const ask = bar.appendChild(h("button", "btn ask", T("Ask agent")));
      ask.title = T("Have the agent read this state (stack, variables, code) and explain it");
      ask.onclick = () => this.o.askAgent?.(e.id, `[The user is paused in the debugger at ${d.frames[d.frame || 0]?.path}:${d.frames[d.frame || 0]?.line}${d.exception ? ` after ${d.exception}` : ""}. Call ide_debug_state to see the stack, variables and code, then explain what is going on and what looks wrong.]`);
    }
    if ((e.debugTab || "debugger") === "console") { content.appendChild(this.console(e, s).div); return; }
    const panes = content.appendChild(h("div", "dpanes"));
    const frames = panes.appendChild(h("div", "dframes"));
    frames.appendChild(h("div", "dhead", "Frames"));
    const vars = panes.appendChild(h("div", "dvars"));
    vars.appendChild(h("div", "dhead", "Variables"));
    this.console(e, s); // keep the program's output flowing even while the Debugger tab shows
    if (!paused) return;
    if (d.exception) frames.appendChild(h("div", "dexc", `⚡ ${d.exception}`));
    d.frames.forEach((f, i) => {
      const r = frames.appendChild(h("div", `dframe${i === (d.frame || 0) ? " on" : ""}`));
      r.appendChild(h("span", "", `${f.name}`));
      r.appendChild(h("span", "dim", `${base(f.path)}:${f.line}`));
      r.title = `${f.path}:${f.line}`;
      r.onclick = async () => { await this.debugCmd(e, "frame", { index: i }); };
    });
    const tree = vars.appendChild(h("div", "dtree"));
    const row = (v, depth) => {
      const r = h("div", "dvar");
      r.style.paddingLeft = `${8 + depth * 14}px`;
      const arrow = r.appendChild(h("span", "tarrow", v.ref ? "▸" : ""));
      r.appendChild(h("span", "vname", v.name));
      r.appendChild(h("span", "dim", ` = {${v.type}${v.size != null ? `: ${v.size}` : ""}} `));
      r.appendChild(h("span", "vval", v.value));
      if (v.ref) {
        let kids = null;
        r.onclick = async () => {
          if (kids) { kids.remove(); kids = null; arrow.textContent = "▸"; return; }
          const res = await this.debugCmd(e, "expand", { ref: v.ref });
          if (!res) return;
          kids = h("div");
          for (const c of res.variables) kids.appendChild(row(c, depth + 1));
          r.after(kids);
          arrow.textContent = "▾";
        };
      }
      return r;
    };
    if (!d.variables.length) tree.appendChild(h("div", "none", T("No variables.")));
    for (const v of d.variables) tree.appendChild(row(v, 0));
    const ev = vars.appendChild(h("form", "deval"));
    const input = ev.appendChild(h("input"));
    input.placeholder = T("Expression");
    input.value = e.evalExpr || "";
    const out = vars.appendChild(h("div", "devout"));
    if (e.evalOut) out.append(e.evalOut.cloneNode(true));
    ev.onsubmit = async (x) => {
      x.preventDefault();
      e.evalExpr = input.value;
      const r = await this.o.api("POST", this.o.path(e.id, `/ide/sessions/${s.id}/debug`), { cmd: "evaluate", expr: input.value, frame: d.frame || 0 }).catch((err) => ({ error: err.message }));
      const line = h("div", r.error ? "bad" : "");
      line.textContent = r.error ? r.error : `${input.value} = ${r.result.value}  {${r.result.type}}`;
      e.evalOut = line;
      out.replaceChildren(line);
    };
  },

  // ---------- breakpoints, the execution line, inline values ----------

  toggleBreakpoint(e, line) {
    const path = e.shown;
    if (!path) return;
    const bps = { ...(e.view.breakpoints || {}) };
    const set = new Set(bps[path] || []);
    if (set.has(line)) set.delete(line); else set.add(line);
    bps[path] = [...set].sort((a, b) => a - b);
    if (!bps[path].length) delete bps[path];
    this.state(e, { breakpoints: bps });
  },

  decorateDebug(e) {
    if (!e.dbgDecos || !this.monaco) return;
    const m = this.monaco, out = [];
    for (const line of (e.view?.breakpoints || {})[e.shown] || []) {
      out.push({ range: new m.Range(line, 1, line, 1), options: { glyphMarginClassName: "ibp", glyphMarginHoverMessage: { value: T("Breakpoint (click to remove)") },
        className: "ibp-line", isWholeLine: true, stickiness: 1 } });
    }
    const s = e.sessions.get(e.activeSession.debug) || [...e.sessions.values()].find((x) => x.debug?.status === "paused");
    const d = s?.debug;
    const hints = [];
    if (d?.status === "paused") {
      const sel = d.frame || 0;
      d.frames.forEach((f, i) => {
        if (f.path !== e.shown || (i !== 0 && i !== sel)) return;
        out.push({ range: new m.Range(f.line, 1, f.line, 1), options: { isWholeLine: true, className: i === 0 ? (d.reason === "exception" ? "iexc-line" : "iexec-line") : "iframe-line",
          glyphMarginClassName: i === 0 ? "iexec-glyph" : "" } });
      });
      // inline values, as PyCharm shows them: the selected frame's variables at the end of the lines that use them
      const f = d.frames[sel];
      const model = e.editor.getModel();
      if (f && f.path === e.shown && model) {
        const vals = new Map(d.variables.map((v) => [v.name, v.value.length > 40 ? `${v.value.slice(0, 39)}…` : v.value]));
        const from = Math.max(1, f.first_line || f.line), to = Math.min(model.getLineCount(), f.line);
        for (let n = from; n <= to; n++) {
          const text = model.getLineContent(n).replace(/#.*$/, "");
          const names = [...new Set(text.match(/[A-Za-z_]\w*/g) || [])].filter((w) => vals.has(w)).slice(0, 4);
          if (!names.length) continue;
          hints.push({ position: { lineNumber: n, column: model.getLineMaxColumn(n) }, label: names.map((w) => `${w}: ${vals.get(w)}`).join("   "), paddingLeft: true });
        }
      }
    }
    e.dbgDecos.set(out);
    // inline values for this IDE's files: only the open one while paused
    for (const f of e.files.values()) if (f.model) INLINE.delete(f.model.uri.toString());
    const model = e.editor?.getModel();
    if (model && hints.length) INLINE.set(model.uri.toString(), hints);
    INLINE.changed?.();
  },
};
