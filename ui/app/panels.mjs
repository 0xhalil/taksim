// An agent's panel (PanelLayer.swift, PanelChrome.swift, PanelInputs.swift, SourceAudit.swift): a tool the agent
// built, docked to the right of its node. It collapses to a strip, opens to its own size (resized from its corner)
// or maximizes; a saved tool offered for an agent shows faintly in the same place with Open. Its views are bricks,
// fed by the canvas's panel stream.
import { L, pal } from './theme.mjs';
import { api, stream } from './api.mjs';
import { icon } from './icons.mjs';
import { el, btn, menu, toast } from './ui.mjs';
import * as B from './bricks/data.mjs';
import { makeBrick, register, hidesAge, memoKey, dropMemos } from './bricks/bricks.mjs';
import { ChartBrick } from './bricks/chart.mjs';
import { TimelineBrick } from './bricks/timeline.mjs';
import { SceneBrick } from './bricks/scene.mjs';

register('chart', ChartBrick);
register('timeline', TimelineBrick);
register('scene', SceneBrick);

const STRIP = 34, MAX = [1000, 680], GHOST = [520, 340], MIN_SCALE = 0.3;
const reachSymbol = (k) => ({ command: 'terminal', action: 'chevron.right', file: 'doc.on.doc', sql: 'list.bullet', connector: 'globe' }[k] ?? 'globe');

/** every panel's data on the open canvas: a snapshot on each (re)connect, then each source's changes */
export class PanelFeeds {
  feeds = new Map();   // agent -> Map(source -> { data, error, updatedAt })
  #watchers = new Set();
  watch(fn) { this.#watchers.add(fn); }
  feed(agent) { let f = this.feeds.get(agent); if (!f) { f = new Map(); this.feeds.set(agent, f); } return f; }
  get(agent, source) { return source == null ? { data: null } : this.feed(agent).get(source) ?? { data: null }; }
  open(canvas) {
    this.conn?.close();
    this.conn = stream(() => `/v1/canvases/${canvas}/panels/stream`, {
      onEvent: (type, raw) => {
        let j;
        try { j = JSON.parse(raw); } catch { return; }
        if (!j.agent) return;
        if (type === 'snapshot') {
          const f = this.feed(j.agent);
          f.clear();
          for (const [k, s] of Object.entries(j.sources ?? {})) f.set(k, { data: s.data ?? null, error: s.error ?? null, updatedAt: s.updatedAt ?? null });
        } else if (j.source) {
          const f = this.feed(j.agent), prev = f.get(j.source) ?? { data: null };
          let data = prev.data;
          if ((j.mode ?? 'replace') === 'replace') data = j.data ?? null;
          else if (j.mode === 'append') data = [...(Array.isArray(prev.data) ? prev.data : []), ...(Array.isArray(j.data) ? j.data : [j.data])].slice(-(j.keep ?? 500));
          f.set(j.source, { data, error: j.error ?? null, updatedAt: j.updatedAt ?? null });
        }
        for (const fn of this.#watchers) fn(j.agent);
      },
    });
  }
  close() { this.conn?.close(); this.conn = null; }
}

export class Panels {
  hosts = new Map();   // agent id -> PanelHost
  ghosts = new Map();  // agent id -> an offered saved tool

  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.graph = app.graph;
    this.feeds = new PanelFeeds();
    this.feeds.watch((agent) => this.hosts.get(agent)?.data());
    this.store.listen((type, d) => {
      if (type === 'tool_suggested' && d.id && d.tool && !this.store.agents.get(d.id)?.panel) { this.ghosts.set(d.id, d.tool); this.app.layoutBodies(); this.graph.kick(); }
      if (type === 'panel_updated' && d.panel?.spec) this.ghosts.delete(d.id);
      if (type === 'agent_removed') { this.ghosts.delete(d.id); this.feeds.feeds.delete(d.id); }
    });
  }

  /** its room beside the node, in graph units */
  size(a) {
    const p = a.panel;
    if (p?.spec) {
      const ui = p.ui ?? {};
      if (ui.collapsed) return [STRIP, this.graph.rectOf(a).h];
      const live = this.hosts.get(a.id)?.live;
      if (live) return live;
      if (ui.maximized) return MAX;
      return Array.isArray(ui.size) && ui.size.length === 2 ? ui.size : [560, 400];
    }
    return this.ghosts.has(a.id) ? GHOST : null;
  }

  layout() {
    const s = this.store, g = this.graph, canvas = s.currentId, keep = new Set();
    if (canvas !== this.canvas) { this.canvas = canvas; this.ghosts.clear(); if (canvas) this.feeds.open(canvas); else this.feeds.close(); }
    for (const a of g.agents) {
      const size = this.size(a);
      if (!size) continue;
      keep.add(a.id);
      let h = this.hosts.get(a.id);
      if (!h) { h = new PanelHost(this, a.id, canvas); this.hosts.set(a.id, h); this.app.bodies.append(h.root); }
      h.set(a.panel?.spec ? a.panel : null, a.panel?.spec ? null : this.ghosts.get(a.id), size);
      h.root.hidden = g.scale < MIN_SCALE || !!a.collapsed;
      if (h.root.hidden) continue;
      const r = g.rectOf(a), p = g.toScreen({ x: r.x + r.w + 14, y: r.y });
      Object.assign(h.root.style, { width: size[0] + 'px', height: size[1] + 'px', transform: `translate(${p.x}px, ${p.y}px) scale(${g.scale})`, zIndex: 900 });
    }
    for (const [id, h] of this.hosts) {
      if (keep.has(id)) continue;
      if (h.canvas === canvas) { h.root.remove(); this.hosts.delete(id); dropMemos(id); } else h.root.hidden = true;
    }
  }

  // ---------- what a panel asks of the engine ----------

  path(id, rest = '') { return this.store.agentPath(id, '/panel' + rest); }
  ui(id, fields) {
    const a = this.store.agents.get(id);
    if (!a?.panel) return;
    this.store.agents.set(id, { ...a, panel: { ...a.panel, ui: { ...(a.panel.ui ?? {}), ...fields } } });
    this.store.changed();
    this.graph.kick();
    this.store.run(() => api.patch(this.path(id), fields));
  }
  approve(id, always) { this.store.run(() => api.post(this.path(id, '/approve'), { always })); }
  reject(id) { this.store.run(() => api.post(this.path(id, '/reject'))); }
  refresh(id) { this.store.run(() => api.post(this.path(id, '/refresh'))); }
  tell(id, text) { this.store.tell(id, text); }
  async setSpec(id, spec) { try { await api.put(this.path(id), { spec }); return null; } catch (e) { return e.message; } }
  input(id, name, value) {
    const a = this.store.agents.get(id);
    if (a?.panel) { this.store.agents.set(id, { ...a, panel: { ...a.panel, inputs: { ...(a.panel.inputs ?? {}), [name]: value } } }); this.store.changed(); }
    this.store.run(() => api.post(this.path(id, '/inputs'), { [name]: value }));
  }
  /** a row action: `ask` goes to the agent, `run` comes back with the program's output under the panel */
  async action(id, view, index, row) { return this.#ran(id, () => api.post(this.path(id, '/action'), { view, index, row })); }
  async button(id, index) { return this.#ran(id, () => api.post(this.path(id, '/button'), { index })); }
  async #ran(id, call) {
    const h = this.hosts.get(id);
    try {
      const r = await call();
      if (r.sent) return true;
      h?.output(`$ ${(r.argv ?? []).join(' ')}\n${r.output ?? ''}`, r.code === 0);
    } catch (e) { h?.output(e.message, false); }
    return false;
  }

  /** gone at once, no question: for a few seconds ↶ brings it back as it was */
  remove(id) {
    const a = this.store.agents.get(id), p = a?.panel;
    if (!p?.spec) return;
    this.store.agents.set(id, { ...a, panel: null });
    this.store.changed();
    this.store.run(() => api.delete(this.path(id)));
    this.app.undoCapsule(p.spec.title, async () => {
      await api.put(this.path(id), { spec: p.spec }).catch(() => {});
      this.ui(id, { collapsed: !!p.ui?.collapsed, maximized: !!p.ui?.maximized, size: p.ui?.size });
    });
  }

  /** Keep: the panel becomes a tool in one press and flies into the settings key */
  async keep(id) {
    const a = this.store.agents.get(id), p = a?.panel;
    if (!p) return;
    if (p.tool) { this.app.openSettings('plugins'); return; }
    const from = this.hosts.get(id)?.root.getBoundingClientRect();
    try { await api.post(this.path(id, '/save'), { name: p.spec?.title ?? a.name ?? 'Panel' }); } catch (e) { toast(e.message, { error: true }); return; }
    const target = this.app.header.settingsKey?.getBoundingClientRect();
    if (!from || !target || matchMedia('(prefers-reduced-motion: reduce)').matches) return this.app.header.bumpShelf?.();
    const fly = el('div', 'keep-fly');
    Object.assign(fly.style, { left: from.left + 'px', top: from.top + 'px', width: from.width + 'px', height: from.height + 'px' });
    document.body.append(fly);
    const cx = target.left + target.width / 2, cy = target.top + target.height / 2;
    fly.animate([{}, { left: cx - 9 + 'px', top: cy - 7 + 'px', width: '18px', height: '14px', borderRadius: '4px', opacity: 0.25 }], { duration: 750, easing: 'cubic-bezier(.6,0,.3,1)', fill: 'forwards' })
      .onfinish = () => { fly.remove(); this.app.header.bumpShelf?.(); };
  }

  /** opens an offered tool as the agent's panel; a setting nobody filled in is the agent's to find out */
  useGhost(id) {
    const t = this.ghosts.get(id);
    if (!t) return;
    const missing = Object.entries(t.params ?? {}).filter(([, p]) => p?.default == null).map(([k]) => k);
    this.store.run(async () => {
      if (missing.length) {
        await api.post(this.store.agentPath(id, '/messages'), { text: `[The user picked the saved tool "${t.name}" (${t.id}).] Open it with use_tool; find out ${missing.join(', ')} yourself (e.g. the current kubectl context) or ask me if you can't.` });
        this.ghosts.delete(id);
        this.app.layoutBodies();
        return;
      }
      await api.post(this.store.agentPath(id, '/tool'), { tool: t.id });
    });
  }
  dismissGhost(id) { this.ghosts.delete(id); this.app.layoutBodies(); this.graph.kick(); }
}

/** one agent's panel, as its view sees it */
class PanelHost {
  live = null;
  cards = new Map();

  constructor(panels, id, canvas) {
    this.panels = panels;
    this.id = id;
    this.canvas = canvas;
    this.root = el('div', 'panel');
    this.root.dataset.agent = id;
  }

  set(panel, ghost, size) {
    const key = JSON.stringify([panel?.spec, panel?.status, panel?.pending, panel?.tool?.id, panel?.ui?.collapsed, panel?.ui?.maximized, panel?.inputs, Object.values(panel?.sources ?? {}).map((s) => s.error), ghost?.id]);
    this.size = size;
    if (key === this.key) return;
    this.key = key;
    this.panel = panel;
    this.ghost = ghost;
    this.draw();
    // a running panel nobody kept invites it once, after 12 s
    if (panel?.status === 'running' && !panel.tool && !this.invited) {
      this.invited = true;
      setTimeout(() => { if (this.panel && !this.panel.tool) { this.keepKey?.classList.add('invite'); setTimeout(() => this.keepKey?.classList.remove('invite'), 5200); } }, 12000);
    }
  }

  get title() { return this.panel?.spec?.title ?? this.ghost?.name ?? 'Panel'; }

  draw() {
    const P = this.panels, id = this.id, p = this.panel;
    this.cards.clear();
    if (!p) { this.root.className = 'panel ghost'; this.root.replaceChildren(...(this.ghost ? this.#ghost() : [])); return; }
    if (p.ui?.collapsed) {
      this.root.className = 'panel folded';
      const strip = el('button', 'panel-strip', el('span', null, this.title));
      strip.title = L('Open panel');
      strip.addEventListener('click', () => P.ui(id, { collapsed: false }));
      this.root.replaceChildren(strip);
      return;
    }
    this.root.className = 'panel';
    const dot = el('i', 'panel-dot');
    dot.style.background = p.status === 'pending' ? pal.warn : p.status === 'rejected' || Object.values(p.sources ?? {}).some((s) => s.error) ? pal.err : pal.ok;
    dot.title = { running: L('live'), pending: L('waiting for approval'), rejected: L('rejected') }[p.status] ?? '';
    const title = el('b', 'panel-title', this.title);
    if (p.tool) title.title = L('from the tool "%@"', p.tool.name);
    const max = !!p.ui?.maximized;
    this.keepKey = btn('pbtn' + (p.tool ? ' kept' : ''), icon(p.tool ? 'bookmark.fill' : 'bookmark', 12), () => P.keep(id), p.tool ? L('Kept: %@', p.tool.name) : L('Keep'));
    const head = el('div', 'panel-head', dot, title, el('span', 'spacer'),
      btn('pbtn', icon('arrow.clockwise', 12), () => P.refresh(id), L('Refresh')), this.keepKey,
      btn('pbtn', icon(max ? 'arrow.uturn.backward' : 'arrow.up.left.and.arrow.down.right', 12), () => P.ui(id, { collapsed: false, maximized: !max }), max ? L('Restore size') : L('Maximize')),
      btn('pbtn', icon('minus', 12), () => P.ui(id, { collapsed: true }), L('Minimize')),
      btn('pbtn', icon('xmark', 11, 1.8), () => P.remove(id), L('Remove panel')));
    head.addEventListener('dblclick', (e) => { if (!e.target.closest('.pbtn')) P.ui(id, { collapsed: false, maximized: !max }); });
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      menu({ x: e.clientX, y: e.clientY }, [
        { label: L('Tell the agent…'), run: () => this.#editor(head) },
        { label: L('Refresh'), run: () => P.refresh(id) },
        { label: p.tool ? L('Kept') : L('Keep'), disabled: !!p.tool, run: () => P.keep(id) },
        null,
        { label: L('Remove panel'), run: () => P.remove(id) },
      ]);
    });
    const parts = [head];
    if (p.status !== 'running') parts.push(this.#approval());
    const inputs = this.#inputs();
    if (inputs) parts.push(inputs);
    this.body = el('div', 'panel-body');
    parts.push(this.body);
    this.out = el('div', 'panel-out');
    this.out.hidden = true;
    parts.push(this.out);
    const grip = el('div', 'panel-grip');
    grip.title = L('Resize');
    grip.addEventListener('pointerdown', (e) => this.#resize(e, grip));
    parts.push(grip);
    this.root.replaceChildren(...parts);
    this.#bodies();
  }

  /** what the panel wants to reach and the three answers */
  #approval() {
    const p = this.panel, P = this.panels, rejected = p.status === 'rejected';
    const list = el('div', 'reach-list', ...(p.pending ?? []).map((r) => {
      const row = el('div', 'reach');
      const sym = el('span', 'reach-sym', icon(reachSymbol(r.kind), 11));
      row.append(sym);
      if (r.kind === 'action' && r.label) row.append(el('span', 'reach-label', r.label));
      const text = { command: (r.argv ?? []).join(' '), action: (r.argv ?? []).join(' '), file: r.path ?? '', sql: [r.engine, r.db].filter(Boolean).join(' · ') + ': ' + (r.query ?? ''), connector: [r.service, r.call].filter(Boolean).join(' · ') }[r.kind] ?? r.url ?? '';
      const t = el('code', 'selectable' + (rejected ? ' struck' : ''), text);
      row.append(t);
      const cadence = r.stream ? L('streaming') : r.every_s ? L('%d sec', r.every_s) : null;
      if (cadence) row.append(el('span', 'muted', cadence));
      return row;
    }));
    const approve = btn('strip-btn primary', null, () => P.approve(this.id, false));
    approve.append(L('Approve'));
    const always = btn('strip-btn', null, () => P.approve(this.id, true), L("Always approve this agent's panels"));
    always.append(L('Always'));
    const keys = el('div', 'strip-keys', approve, always);
    if (!rejected) { const no = btn('strip-btn danger', null, () => P.reject(this.id)); no.append(L('Reject')); keys.append(no); }
    const box = el('div', 'approval' + (rejected ? ' rejected' : ''), list, keys);
    return box;
  }

  /** inputs and the agent's buttons in one quiet strip */
  #inputs() {
    const p = this.panel, P = this.panels, spec = p.spec;
    const value = (n) => { const v = p.inputs?.[n]; return typeof v === 'string' ? v : v === true ? 'true' : typeof v === 'number' ? String(v) : ''; };
    const inputs = Object.entries(spec.inputs ?? {}).filter(([n, i]) => i?.kind && (i.kind !== 'row' || value(n)));
    const buttons = spec.actions ?? [];
    if (!inputs.length && !buttons.length) return null;
    const row = el('div', 'inputs');
    for (const [name, i] of inputs) {
      const v = value(name), set = (x) => P.input(this.id, name, x);
      if (i.kind === 'select') {
        const fromSource = i.options && !Array.isArray(i.options) && i.options.source;
        let options = Array.isArray(i.options) ? i.options.map(String) : [];
        if (fromSource) {
          const seen = new Set();
          for (const r of B.rows(P.feeds.get(this.id, i.options.source).data)) { const x = B.show(B.get(r, i.options.field)); if (x && !seen.has(x)) { seen.add(x); options.push(x); } if (options.length >= 50) break; }
        }
        if (options.length <= 4 && !fromSource) {
          const seg = el('div', 'segments');
          seg.title = i.label ?? name;
          for (const o of options) { const b = btn(o === v ? 'on' : '', null, () => set(o)); b.append(o); seg.append(b); }
          row.append(seg);
        } else {
          const b = btn('in-select', null, () => menu(b, options.map((o) => ({ label: o, checked: o === v, run: () => set(o) }))));
          if (i.label) b.append(el('span', 'muted', i.label));
          b.append(el('span', null, v || '—'), icon('chevron.down', 8, 2));
          row.append(b);
        }
      } else if (i.kind === 'text') {
        const f = el('input');
        f.value = v;
        f.placeholder = i.label ?? '';
        f.addEventListener('keydown', (e) => e.stopPropagation());
        let t;
        f.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => set(f.value), 350); });
        row.append(el('label', 'in-text', icon('magnifyingglass', 10), f));
      } else if (i.kind === 'toggle') {
        const t = el('input');
        t.type = 'checkbox';
        t.checked = v === 'true';
        t.addEventListener('change', () => set(t.checked));
        row.append(el('label', 'switch small', t, el('span', 'muted', i.label ?? name)));
      } else if (i.kind === 'slider' && i.min < i.max) {
        const r = el('input');
        Object.assign(r, { type: 'range', min: i.min, max: i.max, step: i.step ?? (i.max - i.min) / 100, value: Math.min(Math.max(+v || i.min, i.min), i.max) });
        const shown = el('span', 'in-val');
        const fmt = () => { shown.textContent = [r.value, i.unit].filter(Boolean).join(' '); };
        fmt();
        r.addEventListener('input', fmt);
        r.addEventListener('change', () => set(Number(r.value)));
        row.append(el('label', 'in-slider', i.label ? el('span', 'muted', i.label) : null, r, shown));
      } else {
        const chip = el('span', 'in-row', icon('chevron.right', 10, 2), el('b', null, v));
        chip.title = i.label ?? name;
        chip.append(btn('tap', icon('xmark', 7, 2.4), () => set(null)));
        row.append(chip);
      }
    }
    row.append(el('span', 'spacer'));
    buttons.forEach((b, k) => {
      const key = btn('in-button', null, async () => {
        if (key.disabled) return;
        key.disabled = true;
        const ok = await P.button(this.id, k);
        key.disabled = false;
        if (ok) { key.classList.add('sent'); setTimeout(() => key.classList.remove('sent'), 1500); }
      });
      key.append(b.label ?? '…');
      key.title = Array.isArray(b.run) ? b.run.join(' ') : b.ask ?? '';
      row.append(key);
    });
    return row;
  }

  /** the bricks in rows of four quarters; a narrow panel puts two stats a row and everything else full width */
  #bodies() {
    const p = this.panel, spec = p.spec, value = (n) => { const v = p.inputs?.[n]; return v == null || v === false ? '' : String(v); };
    const views = (spec.views ?? []).map((v, i) => ({ ...v, id: v.id ?? `v${i + 1}`, brick: v.brick ?? 'json' })).filter((v) => !v.when || (value(v.when) && value(v.when) !== 'false'));
    const width = Math.max(100, this.size[0] - 16), narrow = width < 504;
    if (!views.length) { this.body.replaceChildren(el('div', 'brick-empty', L('No views'))); return; }
    const rows = [];
    let cur = [], used = 0;
    for (const v of views) {
      const span = narrow ? (v.brick === 'stat' ? 2 : 4) : Math.max(1, Math.min(4, Math.round(v.span ?? { stat: 1, kv: 2, chart: 2, bars: 2 }[v.brick] ?? 4)));
      if (used + span > 4 && cur.length) { rows.push(cur); cur = []; used = 0; }
      cur.push({ v, span });
      used += span;
    }
    if (cur.length) rows.push(cur);
    const col = (width - 24) / 4;
    this.body.replaceChildren(...rows.map((r) => el('div', 'brick-row', ...r.map(({ v, span }) => {
      const card = new BrickCard(this, v, col * span + 8 * (span - 1));
      this.cards.set(v.id, card);
      return card.root;
    }))));
    this.data();
  }

  /** new data for some source: each card takes what is its own */
  data() { for (const c of this.cards.values()) c.update(); }

  output(text, ok) {
    if (!this.out) return;
    const t = el('pre', 'selectable' + (ok ? '' : ' err'), text || '—');
    this.out.replaceChildren(t, btn('pbtn out-x', icon('xmark', 10, 2), () => { this.out.hidden = true; }));
    this.out.hidden = false;
  }

  #resize(e, grip) {
    e.preventDefault();
    e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    const p = this.panel, start = { x: e.clientX, y: e.clientY, size: p.ui?.maximized ? MAX : (p.ui?.size ?? [560, 400]) };
    const move = (ev) => {
      const k = Math.max(0.1, this.panels.graph.scale);
      this.live = [Math.max(260, start.size[0] + (ev.clientX - start.x) / k), Math.max(160, start.size[1] + (ev.clientY - start.y) / k)];
      this.panels.graph.kick();
      this.panels.app.layoutBodies();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', () => {
      grip.removeEventListener('pointermove', move);
      if (this.live) { const size = this.live.map(Math.round); this.live = null; this.panels.ui(this.id, { maximized: false, size }); this.key = null; }
    }, { once: true });
  }

  /** under the header's right click: tell the agent what to change, or edit the spec as JSON */
  #editor(anchor) {
    const existing = document.querySelector('.panel-editor');
    if (existing) {
      existing._close ? existing._close() : existing.remove();
      if (existing._anchor === anchor) return;
    }
    const box = el('div', 'panel-editor');
    box._anchor = anchor;
    const close = () => {
      box.remove();
      document.removeEventListener('pointerdown', off, true);
    };
    box._close = close;
    const ask = el('textarea');
    ask.placeholder = L('e.g. only show errors');
    ask.rows = 2;
    const json = el('textarea', 'mono');
    json.value = B.pretty(this.panel.spec);
    json.hidden = true;
    const err = el('div', 'set-problem');
    const send = () => { const t = ask.value.trim(); if (!t) return; this.panels.tell(this.id, `[Panel change request from the user] ${t}`); close(); };
    ask.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); send(); } if (e.key === 'Escape') close(); });
    json.addEventListener('keydown', (e) => e.stopPropagation());
    const save = btn('strip-btn primary', null, async () => {
      let spec;
      try { spec = JSON.parse(json.value); } catch { err.textContent = L("Couldn't read JSON"); return; }
      const e = await this.panels.setSpec(this.id, spec);
      if (e) err.textContent = e; else close();
    });
    save.append(L('Save'));
    const saveRow = el('div', 'strip-keys right', save);
    saveRow.hidden = true;
    const toggle = btn('tap', el('span', 'mono', '{ }'), () => { json.hidden = saveRow.hidden = !json.hidden; }, 'JSON');
    const go = btn('strip-btn primary', icon('arrow.up', 11, 2), send);
    box.append(ask, el('div', 'strip-keys', toggle, el('span', 'spacer'), go), json, err, saveRow);
    document.body.append(box);
    const r = anchor.getBoundingClientRect();
    Object.assign(box.style, { left: Math.max(8, Math.min(r.left, innerWidth - 430)) + 'px', top: r.bottom + 6 + 'px' });
    ask.focus();
    const off = (e) => {
      if (anchor.contains(e.target)) return;
      if (!box.contains(e.target)) close();
    };
    setTimeout(() => document.addEventListener('pointerdown', off, true));
  }

  /** a saved tool that fits what the person asked, drawn faintly where the panel would be; the whole of it opens it */
  #ghost() {
    const t = this.ghost, P = this.panels;
    const open = el('span', 'ghost-open', L('Open'));
    const head = el('div', 'panel-head plain', el('b', 'panel-title', t.name), el('span', 'spacer'), open, btn('pbtn', icon('xmark', 11, 1.8), () => P.dismissGhost(this.id), L('Not needed')));
    head.title = t.summary ?? '';
    const body = el('div', 'panel-body preview');
    this.root.onclick = (e) => { if (!e.target.closest('.pbtn')) { open.classList.add('pressed'); P.useGhost(this.id); } };
    const spec = t.spec;
    if (spec?.views) {
      const sample = new Map(Object.entries(t.preview?.data ?? {}).map(([k, d]) => [k, { data: d }]));
      const width = Math.max(100, this.size[0] - 16), col = (width - 24) / 4;
      for (const [i, v0] of spec.views.entries()) {
        const v = { ...v0, id: v0.id ?? `v${i + 1}`, brick: v0.brick ?? 'json' };
        const span = width < 504 ? (v.brick === 'stat' ? 2 : 4) : Math.max(1, Math.min(4, v.span ?? { stat: 1, kv: 2, chart: 2, bars: 2 }[v.brick] ?? 4));
        const brick = makeBrick(v.brick), card = el('div', 'brick-card', el('div', 'brick-head', el('span', null, B.heading(v))), brick.root);
        card.style.width = col * span + 8 * (span - 1) + 'px';
        body.append(card);
        requestAnimationFrame(() => brick.update({ view: v, state: sample.get(v.source) ?? { data: null }, width: col * span - 18, preview: true, act: async () => false,
          memoKey: memoKey(`${this.id}/${t.id}`, v), now: t.preview?.at, series: t.preview?.series?.[v.id], everyS: v.source ? spec.sources?.[v.source]?.every_s : null }));
      }
    }
    return [head, body];
  }
}

/** one view: its name and age, its error, the brick */
class BrickCard {
  constructor(host, view, width) {
    this.host = host;
    this.view = view;
    this.width = width;
    this.brick = makeBrick(view.brick);
    const spec = host.panel.spec;
    this.age = el('span', 'brick-age');
    const head = el('div', 'brick-head');
    if (B.heading(view) !== spec.title) head.append(el('span', null, B.heading(view)));
    head.append(el('span', 'spacer'), this.age);
    // the header is where its numbers come from: a click shows the source as it runs
    const def = view.source ? spec.sources?.[view.source] : null;
    if (def) { head.classList.add('auditable'); head.title = L('Where the data comes from'); head.addEventListener('click', () => this.#audit(head, def)); }
    this.err = el('div', 'brick-error');
    this.err.hidden = true;
    this.root = el('div', 'brick-card', head, this.err, this.brick.root);
    this.root.style.width = width + 'px';
    clearInterval(this.ager);
    this.ager = setInterval(() => { if (!this.root.isConnected) clearInterval(this.ager); else this.#age(); }, 5000);
  }

  get state() {
    const s = this.host.panels.feeds.get(this.host.id, this.view.source);
    // the source's rows narrowed by the view's filter (a text input), without re-running the source
    const f = this.view.filter, q = f?.input ? String(this.host.panel.inputs?.[f.input] ?? '') : '';
    if (!q) return s;
    const needle = q.toLowerCase();
    return { ...s, data: B.rows(s.data).filter((r) => (Array.isArray(f.fields) ? f.fields.map((x) => B.show(B.get(r, x))).join(' ') : JSON.stringify(r)).toLowerCase().includes(needle)) };
  }

  update() {
    const host = this.host, panel = host.panel, state = this.state;
    if (state === this.lastState && panel === this.lastPanel) return;
    this.lastState = state;
    this.lastPanel = panel;
    const e = state.error ?? panel.sources?.[this.view.source ?? '']?.error;
    this.err.hidden = !e;
    this.err.replaceChildren(icon('exclamationmark.triangle', 11), el('span', 'selectable', e ?? ''));
    this.#age();
    const pick = Object.entries(panel.spec.inputs ?? {}).find(([, i]) => i?.kind === 'row' && i.view === this.view.id);
    const P = host.panels;
    this.brick.update({
      view: this.view, state, width: this.width - 18, preview: false,
      act: (i, row) => P.action(host.id, this.view.id, i, row),
      memoKey: memoKey(host.id, this.view),
      pickField: pick?.[1].field, picked: pick && panel.inputs?.[pick[0]] != null ? String(panel.inputs[pick[0]]) || null : null,
      pick: pick ? (row) => P.input(host.id, pick[0], B.show(B.get(row, pick[1].field ?? ''))) : null,
    });
  }

  #age() {
    const ts = this.lastState?.updatedAt;
    this.age.textContent = !hidesAge(this.view.brick) && ts ? B.ago(ts) : '';
    if (ts) this.age.title = L('updated: %@', new Date(ts).toLocaleTimeString());
  }

  /** where a view's numbers come from: the source as it runs, how its rows are narrowed; Explain asks the agent */
  #audit(anchor, def) {
    const existing = document.querySelector('.audit');
    if (existing) {
      existing._close ? existing._close() : existing.remove();
      if (existing._anchor === anchor) return;
    }
    const src = this.view.source, kind = def.brick ?? '';
    const label = { command: L('Command'), sql: `SQL · ${def.engine ?? ''}`, connector: { slack: 'Slack', github: 'GitHub' }[def.service] ?? def.service ?? '', http: L('Address'), tail: L('File') }[kind] ?? L('Agent');
    const what = kind === 'command' ? (def.run ?? []).map((a) => (String(a).includes(' ') ? `'${a}'` : a)).join(' ')
      : kind === 'sql' ? [def.db, def.query].filter(Boolean).join('\n')
      : kind === 'connector' ? [def.call ?? '', ...Object.keys(def.params ?? {}).sort().map((k) => `${k}=${typeof def.params[k] === 'string' ? def.params[k] : JSON.stringify(def.params[k])}`)].join('\n')
      : kind === 'http' ? def.url : kind === 'tail' ? def.path : null;
    const box = el('div', 'audit');
    box._anchor = anchor;
    const close = () => {
      box.remove();
      document.removeEventListener('pointerdown', off, true);
    };
    box._close = close;
    const head = el('div', 'audit-head', el('span', 'accent', icon(reachSymbol(kind === 'tail' ? 'file' : kind === 'http' ? 'http' : kind), 12)), el('b', null, label), el('code', 'muted', src), el('span', 'spacer'));
    if (def.every_s) head.append(el('span', 'muted', icon('arrow.clockwise', 10), L('%d s', def.every_s)));
    box.append(head);
    if (what) box.append(el('pre', 'audit-what selectable', what));
    for (const k of ['pick', 'where', 'sort', 'limit']) if (def[k] != null) box.append(el('div', 'audit-row', el('span', 'muted', k), el('code', 'selectable', typeof def[k] === 'string' ? def[k] : JSON.stringify(def[k]))));
    const st = this.lastState ?? { data: null }, rowsText = Array.isArray(st.data) ? L('%d rows', st.data.length) : st.data == null ? L('No data') : L('1 record');
    const explain = btn('strip-btn primary', null, () => {
      close();
      this.host.panels.tell(this.host.id, `Explain the numbers in the view "${B.heading(this.view)}" of your panel. It shows the source "${src}": ${JSON.stringify(def)}. Walk through what it runs or asks, how its rows are filtered, grouped and counted, and anything that could make the numbers misleading. Keep it short.`);
    });
    explain.append(L('Explain'));
    box.append(el('div', 'audit-foot', el('span', 'muted', rowsText), st.updatedAt ? el('span', 'muted2', new Date(st.updatedAt).toLocaleTimeString()) : null, el('span', 'spacer'),
      btn('strip-btn', icon('arrow.clockwise', 11, 2), () => this.host.panels.refresh(this.host.id), L('Refresh')), explain));
    document.body.append(box);
    const r = anchor.getBoundingClientRect();
    Object.assign(box.style, { left: Math.max(8, Math.min(r.left, innerWidth - 370)) + 'px', top: r.bottom + 6 + 'px' });
    const off = (e) => {
      if (anchor.contains(e.target)) return;
      if (!box.contains(e.target)) close();
    };
    setTimeout(() => document.addEventListener('pointerdown', off, true));
  }
}
