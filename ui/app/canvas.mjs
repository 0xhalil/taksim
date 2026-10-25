// What GraphCanvas.swift does around the canvas: renaming in place, the context menus, grouping a selection,
// the bar over a selection, pulses along links when agents talk, undo for a removed panel.
import { L, groupColors } from './theme.mjs';
import { logos } from './logos.mjs';
import { icon } from './icons.mjs';
import { el, menu, editInPlace } from './ui.mjs';
import { effortName, TH } from './graph.mjs';

const markColor = (b) => {
  const c = logos.tiles[b] ?? '#6b6862', n = parseInt(c.slice(1), 16);
  return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255) < 120 ? '#868a91' : c;
};

export class CanvasCoordinator {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.graph = app.graph;
    this.views = new Map();   // each canvas's zoom and scroll, kept across tab switches
    this.canvasId = null;
    this.pendingFit = false;
    this.graph.actions = {
      toggleTerminal: (id) => this.openTerminal(id),
      toggleCollapsed: (id) => { const a = this.store.agents.get(id); if (a) this.store.setCollapsed(id, !a.collapsed); },
      openIDE: (id) => app.toggleIDE?.(id),
      toggleHelpers: (id) => { const a = this.store.agents.get(id); this.store.setHelpers(id, !(a?.delegate === true)); },
      computerKey: (id) => this.computerKey(id),
      renameAgent: (id, r) => { const a = this.store.agents.get(id); if (a) editInPlace(r, a.name, (n) => this.store.renameAgent(id, n), { fontSize: Math.max(11, 14 * this.graph.scale) }); },
      renameGroup: (gid, r) => this.renameGroup(gid, r),
      deleteAgent: (id) => this.store.deleteAgent(id),
      menu: (target, at, p) => this.menu(target, at, p),
      selectionChanged: (ids) => this.selectionChanged(ids),
      groupSelection: () => this.groupSelection(),
      viewMoved: () => this.hideSelbar(),
      openGroupNote: (gid, r) => app.openGroupNote?.(gid, r),
    };
    this.store.listen((type, d) => {
      if (type !== 'message') return;
      const from = this.store.agents.get(d.from);
      if (from && this.store.agents.has(d.to)) this.graph.pulse(d.from, d.to, markColor(from.backend));
    });
  }

  /** after every store change: another tab comes back where it was left, terminals move to free spots */
  update() {
    const s = this.store, g = this.graph;
    if (this.canvasId !== s.currentId) {
      if (this.canvasId) this.views.set(this.canvasId, [g.scale, { ...g.offset }]);
      this.canvasId = s.currentId;
      g.selected = new Set();
      g.modes = new Map();
      g.baseRects = new Map();
      const seen = s.currentId && this.views.get(s.currentId);
      if (seen) { g.moveView(seen[0], seen[1]); this.pendingFit = false; } else this.pendingFit = true;
    }
    if (this.pendingFit && s.currentAgents.length) { this.pendingFit = false; g.fit(); }
    const moved = g.syncModes();
    if (this.opening && moved.has(this.opening)) g.fit();
    g.kick();
    g.onLayout();
  }

  /** opens or closes an agent's terminal; an opened one is kept in view and focused */
  openTerminal(id) {
    this.opening = id;
    this.store.toggleTerminal(id, () => setTimeout(() => { this.app.bodyLayer?.focus(id); this.opening = null; }, 300));
  }

  computerKey(id) {
    const c = this.store.computer[id];
    if (c?.missing?.length) { if (c.state === 'asking') this.store.setComputer(id, true); return; }
    this.store.setComputer(id, !c || c.state === 'asking');
  }

  renameGroup(gid, r) {
    const g = this.store.groups.get(gid);
    if (g) editInPlace(r, g.name, (name) => this.store.patchGroup(gid, { name }), { fontSize: Math.max(11, 12 * this.graph.scale) });
  }

  // ---------- menus ----------

  menu(target, at, p) {
    const s = this.store, view = this.graph, items = [];
    if (target.agent) {
      const id = target.agent, a = s.agents.get(id);
      if (!a) return;
      items.push({ label: a.shell ? L('Close terminal') : L('Open terminal'), run: () => this.openTerminal(id) });
      if (!a.shell && (a.createdBy ?? 'user') === 'user') items.push({ label: L('Chat'), checked: a.chat === true, run: () => s.setChat(id, a.chat !== true) });
      if (a.cwd || a.folder) {
        items.push({ label: a.ide ? L('Close IDE') : 'IDE', run: () => this.app.toggleIDE?.(id) });
        items.push({ label: L('Open IDE in a window'), run: () => window.open(`/ide/${s.currentId}/${id}`, '_blank', 'noopener') });
      }
      const tools = a.toolHelp !== false;
      items.push({ label: L('Tool help'), checked: tools, icon: 'wand.and.stars', run: () => s.setToolHelp(id, !tools) });
      const control = s.computer[id];
      items.push({ label: L('Computer control'), checked: control?.state === 'on', mixed: control?.state === 'asking', icon: 'display',
        run: () => (control?.state === 'on' ? s.setComputer(id, false) : this.computerKey(id)) });
      items.push({ label: L('Rename'), run: () => { const r = view.rectOf(a); this.graph.actions.renameAgent(id, view.clientRect({ x: r.x + 30, y: r.y + 3, w: Math.max(120, view.nameEnd(a) - 26), h: 24 })); } });
      const levels = s.models.find((m) => m.id === a.model)?.efforts;
      if (levels?.length) {
        items.push({ label: L('Thinking'), icon: 'brain', items: [
          { label: L('Default'), checked: !a.effort, run: () => s.setEffort(id, null) }, null,
          ...levels.map((e) => ({ label: effortName(e), checked: a.effort === e, run: () => s.setEffort(id, e) })),
        ] });
      }
      items.push({ label: L('Settings…'), run: () => this.app.openSheet({ edit: id }) });
      if (a.shell && a.queued > 0 && a.autoDeliver === false) items.push({ label: L('Deliver pending message (%d)', a.queued), run: () => s.deliver(id) });
      items.push({ label: L('Stop'), run: () => s.stop(id) });
      items.push({ label: L('Reset session'), run: () => s.resetSession(id) });
      items.push(null, { label: L('Delete  (⌫)'), danger: true, run: () => s.deleteAgent(id) });
    } else if (target.group) {
      const gid = target.group, g = s.groups.get(gid);
      if (!g) return;
      const titleRect = () => { const r = view.groupRect(g); return view.clientRect({ x: r.x + 2, y: r.y + 2, w: Math.min(r.w - 4, 320), h: 18 * 1.4 - 2 }); };
      items.push({ label: L('Rename'), run: () => this.renameGroup(gid, titleRect()) });
      items.push({ label: L('Group note'), run: () => this.app.openGroupNote?.(gid, view.clientRect(view.noteRect(g))) });
      items.push({ label: L('Change color…'), items: groupColors.map((c) => ({ label: c, checked: (g.color ?? groupColors[0]) === c, run: () => s.patchGroup(gid, { color: c }) })) });
      if (g.color) items.push({ label: L('Default color'), run: () => s.patchGroup(gid, { color: null }) });
      items.push({ label: L('Add agent here'), run: () => this.app.openSheet({ at: { x: p.x - 140, y: p.y - 40 } }) });
      items.push(null, { label: L('Delete group'), danger: true, run: () => {
        if (confirm(L('Delete the group "%@"? Its note and versions are deleted; agents stay.', g.name))) s.deleteGroup(gid);
      } });
    } else {
      items.push({ label: L('Add agent here'), run: () => this.app.openSheet({ at: { x: p.x - 140, y: p.y - 40 } }) });
      if (view.selected.size) items.push({ label: L('Group'), key: '⌘G', run: () => this.groupSelection() });
      items.push({ label: L('Create group here'), run: async () => {
        const g = await s.createGroup([p.x - 40, p.y - 40, 840, 520], L('group'), this.nextGroupColor());
        if (g) { view.celebrateGroup(g.id); setTimeout(() => { const r = view.groupRect(g); this.renameGroup(g.id, view.clientRect({ x: r.x + 2, y: r.y + 2, w: Math.min(r.w - 4, 320), h: 18 * 1.4 - 2 })); }, 420); }
      } });
      items.push({ label: L('Show all'), run: () => view.fit(true) });
    }
    menu(at, items);
  }

  // ---------- grouping a selection ----------

  nextGroupColor() {
    const used = new Set([...this.store.groups.values()].map((g) => g.color ?? groupColors[0]));
    return groupColors.find((c) => !used.has(c)) ?? groupColors[this.store.groups.size % groupColors.length];
  }

  /** agents working in the same folder are named after it; otherwise a plain name to type over */
  autoName(ids) {
    const folders = ids.map((id) => this.store.agents.get(id)?.folder?.name);
    return folders[0] && folders.every((f) => f === folders[0]) ? folders[0] : L('group');
  }

  async groupSelection() {
    const view = this.graph, ids = [...view.selected];
    if (!ids.length) return;
    this.hideSelbar();
    const rs = ids.map((id) => this.store.agents.get(id)).filter(Boolean).map((a) => view.footprintOf(a));
    if (!rs.length) return;
    const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
    const w = Math.max(...rs.map((r) => r.x + r.w)) - x, h = Math.max(...rs.map((r) => r.y + r.h)) - y;
    const g = await this.store.createGroup([x - 30, y - 60, w + 60, h + 90], this.autoName(ids), this.nextGroupColor());
    if (!g) return;
    view.celebrateGroup(g.id);
    setTimeout(() => { const r = view.groupRect(g); this.renameGroup(g.id, view.clientRect({ x: r.x + 2, y: r.y + 2, w: Math.min(r.w - 4, 320), h: 18 * 1.4 - 2 })); }, 420);
  }

  /** the bar over a marquee selection: one button, group them */
  selectionChanged(ids) {
    const view = this.graph;
    this.hideSelbar();
    if (!ids.length || !view.marqueeEnded) return;
    const rs = ids.map((id) => this.store.agents.get(id)).filter(Boolean).map((a) => view.screenRect(view.rectOf(a)));
    const minX = Math.min(...rs.map((r) => r.x)) - 30 * view.scale, maxX = Math.max(...rs.map((r) => r.x + r.w)) + 30 * view.scale;
    const minY = Math.min(...rs.map((r) => r.y));
    const bar = el('button', 'selbar', el('span', null, icon('rectangle.3.group', 20)));
    bar.title = L('Group  ⌘G');
    bar.style.left = Math.max(8, Math.min((minX + maxX) / 2 - 23, view.width - 54)) + 'px';
    bar.style.top = Math.max(8, minY - 60 * view.scale - 54 + TH * 0) + 'px';
    bar.addEventListener('click', () => this.groupSelection());
    view.stage.append(bar);
    this.selbar = bar;
  }
  hideSelbar() { this.selbar?.remove(); this.selbar = null; }
}
