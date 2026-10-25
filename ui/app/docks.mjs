// What docks to the right of a node (IDEDock.swift, PanelLayer.swift, ChatPlanDock.swift): its tool panel, its
// IDE, its plan, in that order, panning and zooming with the canvas. The IDE keeps its real text size: it is moved
// and resized rather than scaled, and it is the engine's IDE page (project, tabs, editor, git, run, terminal).
import { L, isDark, onTheme } from './theme.mjs';
import { api } from './api.mjs';
import { icon } from './icons.mjs';
import { el, btn } from './ui.mjs';
import { PANEL_GAP } from './graph.mjs';

const PANEL_MIN_SCALE = 0.3;   // below this a dock is unreadable: it hides
const IDE_HEAD = 32, IDE_STRIP = 34;
const IDE_MAX = [1400, 860];

/** the IDE's state as the engine keeps it (a.ide.ui) */
function ideState(a) {
  if (!a.ide) return null;
  const ui = a.ide.ui ?? {};
  return { collapsed: !!ui.collapsed, maximized: !!ui.maximized, size: Array.isArray(ui.size) && ui.size.length === 2 ? ui.size : [940, 580] };
}

export class Docks {
  ides = new Map();      // agent id -> { root, frame, canvas, live }

  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.graph = app.graph;
    this.root = app.bodies;
    // the sizes the canvas makes room for, in the order they sit after the node
    this.graph.docks.push((a) => this.app.panels?.size(a) ?? null, (a) => this.ideSize(a), (a) => this.app.plans?.size(a) ?? null);
    onTheme(() => { for (const d of this.ides.values()) d.frame.src = this.#src(d.agent, d.canvas); });
  }

  ideSize(a) {
    const st = ideState(a);
    if (!st) return null;
    if (st.collapsed) return [IDE_STRIP, this.graph.rectOf(a).h];
    return this.ides.get(a.id)?.live ?? (st.maximized ? IDE_MAX : st.size);
  }

  /** where a dock starts: after the node, then after each dock before it */
  dockX(a, before) {
    const r = this.graph.rectOf(a);
    let x = r.x + r.w + PANEL_GAP;
    for (const fn of before) { const s = fn(a); if (s) x += s[0] + PANEL_GAP; }
    return x;
  }

  #src(agent, canvas) { return `/ide/${canvas}/${agent}?theme=${isDark ? 'dark' : 'light'}`; }

  layout() {
    const s = this.store, g = this.graph, canvas = s.currentId, keep = new Set();
    for (const a of g.agents) {
      const st = ideState(a), size = st && this.ideSize(a);
      if (!st) continue;
      keep.add(a.id);
      let d = this.ides.get(a.id);
      if (!d) d = this.#makeIDE(a.id, canvas);
      d.root.hidden = g.scale < PANEL_MIN_SCALE || !!a.collapsed;
      d.root.classList.toggle('folded', st.collapsed);
      d.max.replaceChildren(icon(st.maximized ? 'arrow.uturn.backward' : 'arrow.up.left.and.arrow.down.right', 12));
      d.max.title = st.maximized ? L('Restore') : L('Maximize');
      d.title.textContent = a.folder?.name ?? a.ide?.rootName ?? a.name;
      if (d.root.hidden) continue;
      const x = this.dockX(a, [(b) => this.app.panels?.size(b) ?? null]), r = g.rectOf(a), p = g.toScreen({ x, y: r.y });
      Object.assign(d.root.style, { width: size[0] * g.scale + 'px', height: size[1] * g.scale + 'px', transform: `translate(${p.x}px, ${p.y}px)`, zIndex: 900 });
      d.head.style.height = (st.collapsed ? size[1] : IDE_HEAD) * g.scale + 'px';
      d.head.style.setProperty('--k', g.scale);
    }
    for (const [id, d] of this.ides) {
      if (keep.has(id)) continue;
      if (d.canvas === canvas) { d.root.remove(); this.ides.delete(id); } else d.root.hidden = true;
    }
  }

  #makeIDE(id, canvas) {
    const s = this.store;
    const root = el('div', 'ide-dock');
    root.dataset.agent = id;
    const title = el('span', 'ide-title');
    const max = btn('dock-btn', null, () => { const a = s.agents.get(id); this.ui(id, { maximized: !ideState(a)?.maximized }); });
    const head = el('div', 'ide-head', el('span', 'accent', icon('chevron.left.forwardslash.chevron.right', 12, 2)), title, el('span', 'spacer'),
      btn('dock-btn', icon('square.and.arrow.up', 12), () => window.open(`/ide/${canvas}/${id}`, `taksim-ide-${id}`), L('Open in window')),
      max,
      btn('dock-btn', icon('minus', 12), () => this.ui(id, { collapsed: true }), L('Collapse dock')),
      btn('dock-btn', icon('xmark', 11, 1.8), () => this.close(id), L('Close')));
    // folded to a strip: the strip itself opens it again
    head.addEventListener('click', (e) => { if (root.classList.contains('folded') && !e.target.closest('.dock-btn')) this.ui(id, { collapsed: false }); });
    const frame = el('iframe', 'ide-frame');
    frame.title = 'IDE';
    frame.src = this.#src(id, canvas);
    const corner = el('div', 'dock-corner');
    root.append(head, frame, corner);
    this.root.append(root);
    const d = { root, head, frame, title, max, canvas, agent: id, live: null };
    // the corner resizes the dock, in graph units; the size is saved when the drag ends
    corner.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      corner.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY, size: this.ideSize(s.agents.get(id)) };
      frame.style.pointerEvents = 'none';
      const move = (ev) => {
        const k = Math.max(0.1, this.graph.scale);
        d.live = [Math.max(420, start.size[0] + (ev.clientX - start.x) / k), Math.max(260, start.size[1] + (ev.clientY - start.y) / k)];
        this.graph.kick();
        this.app.layoutBodies();
      };
      const up = () => {
        corner.removeEventListener('pointermove', move);
        frame.style.pointerEvents = '';
        if (d.live) { const size = d.live.map(Math.round); d.live = null; this.ui(id, { size, maximized: false }); }
      };
      corner.addEventListener('pointermove', move);
      corner.addEventListener('pointerup', up, { once: true });
    });
    this.ides.set(id, d);
    return d;
  }

  /** the dock's state: folded, maximized, its size; shown at once, saved on the engine */
  ui(id, fields) {
    const a = this.store.agents.get(id);
    if (!a?.ide) return;
    this.store.agents.set(id, { ...a, ide: { ...a.ide, ui: { ...(a.ide.ui ?? {}), ...fields } } });
    this.store.changed();
    this.store.run(() => api.patch(this.store.agentPath(id, '/ide'), { ui: fields }));
  }

  /** opens the agent's IDE next to its node (on a file, when given) */
  open(id, path) {
    this.store.run(async () => {
      const v = await api.post(this.store.agentPath(id, '/ide'), path ? { path } : {});
      const a = this.store.agents.get(id);
      if (a) { this.store.agents.set(id, { ...a, ide: v }); this.store.changed(); }
    });
  }
  close(id) {
    const a = this.store.agents.get(id);
    if (a) { this.store.agents.set(id, { ...a, ide: null }); this.store.changed(); }
    this.store.run(() => api.delete(this.store.agentPath(id, '/ide')));
  }
  toggle(id) { if (this.store.agents.get(id)?.ide) this.close(id); else this.open(id); }
}
