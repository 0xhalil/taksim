// An agent's panel: a spec of bricks (bricks/catalog.mjs) docked to its node, and the runtime behind it.
// Sources run while the spec is approved (or reaches nothing outside the panel) and stop when the panel or
// agent goes away. Data goes to the page over the canvas's panel stream, not the event bus, so a busy
// panel doesn't fill the bus's replay buffer.

import { readOnly } from "../canvas/chat-modes.mjs";
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { validate, reach, reachHash, resolvePath, isSecretPath, LIMITS } from "../bricks/catalog.mjs";
import { parse, parseLine, shape, matches, fill } from "../bricks/data.mjs";
import { defaults, checkValue, fillInputs } from "../bricks/inputs.mjs";
import { httpError } from "../http.mjs";
import { runOnce, runStream } from "./exec.mjs";
import { sqlCommand, SQL_ENGINES } from "../bricks/sql.mjs";
import { fetchConnector } from "../connectors.mjs";

const UI = { collapsed: false, maximized: false, size: [560, 400] };
const APPEND_KEEP = 500; // rows a stream or tail keeps
const READ_CHARS = 20000; // what panel_read gives an agent per source

export class Panel {
  constructor(agent, data = {}) {
    this.agent = agent;
    this.spec = data.spec || null;
    this.ui = { ...UI, ...data.ui };
    this.approved = data.approved || null; // reach hash the user approved
    this.rejected = data.rejected || null;
    this.tool = data.tool || null;    // { id, name, params } when the spec came from a saved tool
    this.inputs = data.inputs || {};  // the values the user (or the agent) picked for the spec's inputs
    this.state = new Map();   // source -> { data, error, updatedAt, json }
    this.runners = new Map(); // source -> { def, stop, refresh? }
    this.closed = false;
    setImmediate(() => this.sync());
  }

  get canvas() { return this.agent.canvas; }

  toJSON() { return { spec: this.spec, ui: this.ui, approved: this.approved, rejected: this.rejected, tool: this.tool, inputs: this.inputs }; }

  /** every input's value: the picked one, else its default */
  values() {
    const out = defaults(this.spec?.inputs);
    for (const [k, v] of Object.entries(this.inputs)) if (k in out) out[k] = v;
    return out;
  }

  /** inputs changed by the user (or the agent): sources that use them re-run, views that follow them redraw */
  setInputs(patch = {}) {
    if (!this.spec) throw httpError(400, "no panel");
    for (const [k, v] of Object.entries(patch)) {
      const def = this.spec.inputs?.[k];
      if (!def) throw httpError(400, `no input "${k}"; inputs: ${Object.keys(this.spec.inputs || {}).join(", ") || "none"}`);
      try { this.inputs[k] = checkValue(def, v); } catch (e) { throw httpError(400, `inputs.${k}: ${e.message}`); }
    }
    this.sync();
    this.changed();
    return this.view();
  }

  reach() { return reach(this.spec, this.agent.workDir()); }

  // running: sources run · pending: waiting for the user's approval · rejected: the user said no
  status() {
    const items = this.reach();
    if (!items.length || this.agent.autoApprove) return "running";
    const h = reachHash(items);
    if (h === this.approved) return "running";
    return h === this.rejected ? "rejected" : "pending";
  }

  view() {
    const status = this.status();
    return { spec: this.spec, ui: this.ui, tool: this.tool, status, pending: status === "running" ? [] : this.reach(), inputs: this.values(),
      sources: Object.fromEntries([...this.state].map(([k, s]) => [k, { error: s.error || null, updatedAt: s.updatedAt || null }])) };
  }

  snapshot() {
    return Object.fromEntries([...this.state].map(([k, s]) => [k, { data: s.data ?? null, error: s.error || null, updatedAt: s.updatedAt || null }]));
  }

  changed() {
    this.canvas.bus.emit("panel_updated", { id: this.agent.id, panel: this.view() });
    this.canvas.save();
  }

  // ---------- spec ----------

  // by "user": the person wrote it (or picked the tool it came from), which is approval in itself.
  // tool: the saved tool it came from; a patch keeps it, a new spec from scratch drops it.
  setSpec(input, { by = "agent", tool, keepTool = false } = {}) {
    const { spec, errors } = validate(input, { readOnly: readOnly(this.agent) });
    if (errors.length) throw httpError(400, `invalid panel spec:\n- ${errors.join("\n- ")}`);
    for (const [name, s] of Object.entries(spec.sources)) {
      if (s.brick === "tail" && isSecretPath(resolvePath(s.path, this.agent.workDir()))) {
        throw httpError(400, `sources.${name}.path: panels can't read credential files`);
      }
    }
    this.spec = spec;
    // picked values stay for inputs that are still there and still take them
    this.inputs = Object.fromEntries(Object.entries(this.inputs).filter(([k, v]) => {
      try { return spec.inputs?.[k] && checkValue(spec.inputs[k], v) !== undefined; } catch { return false; }
    }));
    if (!keepTool) this.tool = tool || null;
    if (by === "user") { this.approved = reachHash(this.reach()); this.rejected = null; }
    this.sync();
    this.changed();
    return this.view();
  }

  // Merge patch: title; sources by name (null removes); views by id ({id, remove: true} removes, new ids are added).
  patch(p = {}) {
    if (!this.spec) throw httpError(400, "no panel yet; open one with panel_open");
    const next = structuredClone(this.spec);
    if (typeof p.title === "string") next.title = p.title;
    for (const [name, d] of Object.entries(p.inputs || {})) {
      next.inputs ||= {};
      if (d === null) delete next.inputs[name]; else next.inputs[name] = d;
    }
    if (Array.isArray(p.actions)) next.actions = p.actions;
    for (const [name, s] of Object.entries(p.sources || {})) {
      if (s === null) delete next.sources[name]; else next.sources[name] = s;
    }
    for (const v of p.views || []) {
      const i = next.views.findIndex((x) => x.id === v?.id);
      if (i < 0) { if (!v?.remove) next.views.push(v); continue; }
      if (v.remove) next.views.splice(i, 1); else next.views[i] = { ...next.views[i], ...v };
    }
    if (Array.isArray(p.order)) {
      const rank = (v) => { const r = p.order.indexOf(v.id); return r < 0 ? Infinity : r; };
      next.views.sort((a, b) => rank(a) - rank(b));
    }
    return this.setSpec(next, { keepTool: true });
  }

  setUi(patch = {}) {
    const unfolded = patch.collapsed === false && this.ui.collapsed;
    if (typeof patch.collapsed === "boolean") this.ui.collapsed = patch.collapsed;
    if (typeof patch.maximized === "boolean") this.ui.maximized = patch.maximized;
    if (Array.isArray(patch.size)) {
      const [w, h] = patch.size.map(Number);
      if (Number.isFinite(w) && Number.isFinite(h)) this.ui.size = [Math.min(2400, Math.max(260, Math.round(w))), Math.min(1800, Math.max(160, Math.round(h)))];
    }
    this.changed();
    if (unfolded) this.watchedAgain();
  }

  approve() { this.approved = reachHash(this.reach()); this.rejected = null; this.sync(); this.changed(); }
  reject() { this.rejected = reachHash(this.reach()); this.sync(); this.changed(); }

  close() {
    this.closed = true;
    for (const r of this.runners.values()) r.stop();
    this.runners.clear();
    // pending batched appends must not fire after close (panelEmit on a dead canvas)
    for (const st of this.state.values()) {
      if (st.flush) { clearTimeout(st.flush); st.flush = null; st.pending = []; }
    }
  }

  // ---------- sources ----------

  // Starts what should run and stops what changed, was removed, or is no longer approved. Sources that reach
  // nothing outside the panel (the agent's own data, files in its folder, local URLs) run while the rest
  // waits for approval.
  sync() {
    if (this.closed || !this.spec) return;
    const approved = this.status() === "running";
    const gated = new Set(this.reach().map((p) => p.at));
    const may = (name) => !(readOnly(this.agent) && ["command", "sql"].includes(this.spec.sources[name]?.brick)) && (approved || !gated.has(`sources.${name}`));
    // each source as it runs now: its {{in.…}} filled with the inputs' values
    const values = this.values(), now = {};
    for (const [name, def] of Object.entries(this.spec.sources)) {
      const r = fillInputs(def, values);
      if (r.value?.brick === "tail" && isSecretPath(resolvePath(r.value.path, this.agent.workDir()))) r.error = "panels can't read credential files";
      if (r.value?.brick === "sql" && SQL_ENGINES[r.value.engine]?.db === "file" && isSecretPath(resolvePath(r.value.db, this.agent.workDir()))) r.error = "panels can't read credential files";
      now[name] = r;
    }
    for (const [name, r] of this.runners) {
      const def = this.spec.sources[name];
      if (!def || !may(name) || now[name].error || r.def !== JSON.stringify(now[name].value)) {
        r.stop();
        this.runners.delete(name);
        if (!def || def.brick !== "agent") this.state.delete(name);
      }
    }
    for (const name of this.state.keys()) if (!this.spec.sources[name]) this.state.delete(name);
    for (const [name, def] of Object.entries(this.spec.sources)) {
      if (!may(name)) {
        if (readOnly(this.agent) && ["command", "sql"].includes(def.brick)) {
          const error = this.agent.canvas.lang === "tr" ? "Sor/Plan modunda komut kaynağı durduruldu." : "Command sources stop in Ask/Plan mode.";
          this.state.set(name, { data: null, error, updatedAt: Date.now() });
          this.emit(name, "replace", null);
        }
        continue;
      }
      if (this.runners.has(name)) continue;
      // a row input nobody picked yet: its sources wait (no "kubectl logs" without a pod)
      const empty = [...JSON.stringify(def).matchAll(/\{\{\s*in\.(\w+)\s*\}\}/g)].some(([, n]) => this.spec.inputs?.[n]?.kind === "row" && !values[n]);
      if (empty) { this.state.set(name, { data: null }); continue; }
      if (now[name].error) { this.state.set(name, { data: null, error: now[name].error, updatedAt: Date.now() }); this.emit(name, "replace", null); continue; }
      this.runners.set(name, { def: JSON.stringify(now[name].value), ...this.start(name, now[name].value) });
    }
  }

  start(name, def) {
    if (!this.state.has(name)) this.state.set(name, { data: null });
    if (def.brick === "agent") return { stop() {} };
    if (def.brick === "command" && def.stream) return this.startStream(name, def);
    if (def.brick === "tail") return this.startTail(name, def);
    return this.startPoll(name, def);
  }

  // command (not streamed) and http: run once, and again every `every_s`
  startPoll(name, def) {
    let timer = null, stopped = false, busy = false;
    const ac = new AbortController();
    const tick = async () => {
      if (stopped || busy) return;
      busy = true;
      clearTimeout(timer);
      try {
        if (def.brick === "connector") {
          this.set(name, shape(await fetchConnector(def, ac.signal), def));
        } else if (def.brick === "sql") {
          const q = sqlCommand(def, (p) => resolvePath(p, this.agent.workDir()));
          const text = await this.command(q.argv, ac.signal, q.env);
          this.set(name, shape(text.trim() ? parse(text, q.parse) : [], def));
        } else {
          const text = def.brick === "http" ? await fetchText(def.url, ac.signal) : await this.command(def.run, ac.signal);
          this.set(name, shape(parse(text, def.parse || (def.brick === "http" ? guessParse(text) : "lines")), def));
        }
      } catch (e) {
        if (!stopped) this.fail(name, e.message);
      } finally {
        busy = false;
        if (!stopped && def.every_s) timer = setTimeout(tick, this.pace(def.every_s) * 1000);
      }
    };
    tick();
    return { stop() { stopped = true; clearTimeout(timer); ac.abort(); }, refresh: tick };
  }

  // How often a polled source runs: as asked while someone looks at it (the canvas is open on a page and the
  // panel isn't folded), else 6× slower and at least every 30 s. The agent can still read it; it just doesn't
  // keep a cluster busy for nobody. Watching again refreshes at once (see watchedAgain).
  pace(every) {
    const watched = this.agent.canvas.panelSubs?.size > 0 && !this.ui?.collapsed;
    return watched ? every : Math.max(every * 6, 30);
  }

  // someone looks again (a page opened the canvas, the panel unfolded): stale sources run now
  watchedAgain() {
    for (const r of this.runners.values()) r.refresh?.();
  }

  async command(argv, signal, env) {
    const r = await runOnce(argv, { cwd: this.agent.workDir(), signal, env });
    if (r.code !== 0 && !r.stdout.trim()) throw new Error(r.stderr.trim().split("\n").slice(-3).join("\n") || `${argv[0]} exited with code ${r.code}`);
    return r.stdout;
  }

  // a long-running command: lines are appended; restarted with backoff if it exits
  startStream(name, def) {
    let proc = null, stopped = false, restarts = 0, timer = null;
    const go = () => {
      const started = Date.now();
      proc = runStream(def.run, {
        cwd: this.agent.workDir(),
        onLine: (line) => this.append(name, def, parseLine(line, def.parse || "lines")),
        onExit: (err) => {
          if (stopped) return;
          if (Date.now() - started > 60000) restarts = 0;
          if (err) this.fail(name, err.message);
          if (++restarts > 5) return this.fail(name, `${err?.message || "the command exited"}; stopped after 5 restarts`);
          timer = setTimeout(go, 1000 * 2 ** restarts);
        },
      });
    };
    go();
    return { stop() { stopped = true; clearTimeout(timer); proc?.stop(); } };
  }

  // a file: its last lines, then new lines as it grows (polled, which also survives rotation and editors)
  startTail(name, def) {
    const path = resolvePath(def.path, this.agent.workDir());
    let pos = null, rest = "", timer = null, stopped = false;
    const read = (from, to) => {
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(to - from);
        readSync(fd, buf, 0, buf.length, from);
        return buf.toString("utf8");
      } finally { closeSync(fd); }
    };
    const tick = () => {
      if (stopped) return;
      try {
        const size = statSync(path).size;
        if (pos === null || size < pos) {
          // first read, or the file was truncated/rotated: start over from its last lines
          const from = Math.max(0, size - 256 * 1024);
          const lines = read(from, size).split(/\r?\n/);
          if (from > 0) lines.shift(); // likely a partial line
          rest = lines.pop() ?? "";
          const keep = lines.slice(-(Number(def.lines) || 200));
          this.state.set(name, { data: [] });
          this.append(name, def, keep.flatMap((l) => parseLine(l, def.parse || "lines")), true);
          pos = size;
        } else if (size > pos) {
          const lines = (rest + read(pos, size)).split(/\r?\n/);
          rest = lines.pop() ?? "";
          pos = size;
          this.append(name, def, lines.flatMap((l) => parseLine(l, def.parse || "lines")));
        }
        const st = this.state.get(name);
        if (st?.error) { st.error = null; this.emit(name, "replace", st.data); }
      } catch (e) {
        pos = null;
        this.fail(name, e.code === "ENOENT" ? `no such file: ${path}` : e.message);
      }
      timer = setTimeout(tick, 1000);
    };
    tick();
    return { stop() { stopped = true; clearTimeout(timer); } };
  }

  // ---------- data ----------

  set(name, data) {
    const json = JSON.stringify(data ?? null);
    const prev = this.state.get(name);
    if (prev && prev.json === json && !prev.error) { prev.updatedAt = Date.now(); return; }
    this.state.set(name, { data, json, error: null, updatedAt: Date.now() });
    this.emit(name, "replace", data);
  }

  append(name, def, rows, replace = false) {
    const kept = rows.filter((r) => matches(r, def.where));
    if (!kept.length && !replace) return;
    const st = this.state.get(name) || { data: [] };
    const keep = Math.min(def.limit || APPEND_KEEP, LIMITS.rows);
    st.data = [...(Array.isArray(st.data) ? st.data : []), ...kept].slice(-keep);
    st.updatedAt = Date.now();
    st.json = null;
    this.state.set(name, st);
    // batch bursts of lines into one message to the page
    st.pending = [...(st.pending || []), ...kept];
    if (replace) { st.pending = null; return this.emit(name, "replace", st.data); }
    if (st.flush) return;
    st.flush = setTimeout(() => {
      st.flush = null;
      const out = st.pending || [];
      st.pending = [];
      if (out.length) this.emit(name, "append", out.slice(-keep), { keep });
    }, 200);
  }

  fail(name, message) {
    const st = this.state.get(name) || { data: null };
    if (st.error === message) return;
    st.error = message;
    st.updatedAt = Date.now();
    this.state.set(name, st);
    this.emit(name, "error", null);
  }

  emit(name, mode, data, extra = {}) {
    const st = this.state.get(name) || {};
    this.canvas.panelEmit({ agent: this.agent.id, source: name, mode, data, error: st.error || null, updatedAt: st.updatedAt || null, ...extra });
  }

  // panel_push: data for an "agent" source; a missing source is added
  push(name, data, mode = "replace") {
    if (!this.spec) this.setSpec({ title: "Panel", sources: { [name]: { brick: "agent" } }, views: [] });
    let def = this.spec.sources[name];
    if (!def) { this.patch({ sources: { [name]: { brick: "agent" } } }); def = this.spec.sources[name]; }
    if (def.brick !== "agent") throw httpError(400, `source "${name}" is a ${def.brick} source; panel_push only fills "agent" sources`);
    if (mode === "append") this.append(name, def, (Array.isArray(data) ? data : [data]).map((r) => (r && typeof r === "object" ? r : { text: String(r) })));
    else this.set(name, shape(data, def));
  }

  refresh(name) {
    for (const [n, r] of this.runners) if (!name || n === name) r.refresh?.();
  }

  read(name) {
    const out = { status: this.status(), ...(this.spec?.inputs ? { inputs: this.values() } : {}), sources: {} };
    for (const n of Object.keys(this.spec?.sources || {})) {
      if (name && n !== name) continue;
      const s = this.state.get(n) || {}; // not started yet (e.g. waiting for approval)
      const text = JSON.stringify(s.data ?? null);
      out.sources[n] = { error: s.error || null, updated_s_ago: s.updatedAt ? Math.round((Date.now() - s.updatedAt) / 1000) : null,
        rows: Array.isArray(s.data) ? s.data.length : undefined,
        data: text.length > READ_CHARS ? `${text.slice(0, READ_CHARS)}… (truncated; narrow it with where/limit or ask for one source)` : s.data ?? null };
    }
    if (name && !this.spec?.sources[name]) throw httpError(400, `no source "${name}"; sources: ${Object.keys(this.spec?.sources || {}).join(", ") || "none"}`);
    return out;
  }

  // A click on a button in the panel's strip: its {{in.…}} filled, then run or sent like a row action.
  async button(index) {
    const a0 = this.spec?.actions?.[index];
    if (!a0) throw httpError(404, "no such button");
    const r = fillInputs(a0, this.values());
    if (r.error) throw httpError(400, r.error);
    return this.perform(r.value, {}, `the button "${a0.label}"`);
  }

  // A click on a row action in the page.
  async action({ view, index, row }) {
    const v = this.spec?.views.find((x) => x.id === view);
    const a0 = v?.row_actions?.[index];
    if (!a0) throw httpError(404, "no such action");
    const filled = fillInputs(a0, this.values());
    if (filled.error) throw httpError(400, filled.error);
    return this.perform(filled.value, row && typeof row === "object" ? row : {}, `view "${v.title || v.id}"`);
  }

  async perform(a, r, where) {
    if (typeof a.ask === "string") {
      const ctx = JSON.stringify(r);
      const inputs = this.spec?.inputs ? `\nInputs: ${JSON.stringify(this.values())}` : "";
      const text = `[From your panel, ${where}] ${fill(a.ask, r)}${ctx !== "{}" ? `\n\nRow: ${ctx.length > 1500 ? ctx.slice(0, 1500) + "…" : ctx}` : ""}${inputs}`;
      this.agent.enqueue({ kind: "user", from: null, text }).catch(() => {});
      return { sent: true };
    }
    if (this.status() !== "running") throw httpError(409, "the panel's commands aren't approved");
    if (readOnly(this.agent)) throw httpError(403, "this agent is read-only");
    const argv = a.run.map((t) => {
      const out = fill(t, r);
      // a value from the row must not turn into an option of the program
      if (t !== out && out.startsWith("-") && !t.startsWith("-")) throw httpError(400, `refusing "${out}": row values can't start with "-"`);
      return out;
    });
    const res = await runOnce(argv, { cwd: this.agent.workDir(), timeoutMs: 60000 });
    if (a.refresh) setTimeout(() => this.refresh(), 300);
    return { code: res.code, output: (res.stdout + (res.stderr ? `\n${res.stderr}` : "")).trim().slice(-4000), argv };
  }
}

async function fetchText(url, signal) {
  const r = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]), redirect: "follow" });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  return text.length > 4 * 1024 * 1024 ? text.slice(0, 4 * 1024 * 1024) : text;
}

function guessParse(text) {
  const t = text.trimStart();
  return t.startsWith("{") || t.startsWith("[") ? "json" : "lines";
}
