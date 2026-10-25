// The window (ContentView.swift) and the app's model (TaksimApp.swift's AppModel): the toolbar, the tab strip,
// the sidebar and the canvas; adding agents, the keyboard, the undo capsule for closed tabs.
import { L, onTheme } from './theme.mjs';
import { api } from './api.mjs';
import { icon } from './icons.mjs';
import { el, toast } from './ui.mjs';
import { CanvasStore } from './store.mjs';
import { HeaderBar } from './header.mjs';
import { TabStrip } from './tabs.mjs';
import { GraphView } from './graph.mjs';
import { CanvasCoordinator } from './canvas.mjs';
import { Bodies } from './bodies.mjs';
import { AgentSheet } from './sheet.mjs';
import { Navigator } from './navigator.mjs';
import { Settings } from './settings.mjs';
import { CommandPalette } from './palette.mjs';
import { Docks } from './docks.mjs';
import { GroupNote } from './groupnote.mjs';
import { PlanDocks } from './plan.mjs';
import { Panels } from './panels.mjs';
import { BranchControl } from './branches.mjs';
import { Notifier } from './notifier.mjs';
import { Welcome } from './welcome.mjs';

function stored(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function keep(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }

class App {
  showNavigator = stored('taksim.showNavigator', false);

  constructor(root) {
    this.store = new CanvasStore();
    this.header = new HeaderBar(this);
    this.branches = new BranchControl(this);
    this.tabs = new TabStrip(this);
    this.main = el('main');
    this.stage = el('section');
    this.stage.id = 'stage';
    this.stage.setAttribute('aria-label', L('Canvas'));
    this.navigator = new Navigator(this);
    this.main.append(this.navigator.root, this.stage);
    root.append(this.header.root, this.tabs.root, this.main);
    this.graph = new GraphView(this.store, this.stage);
    this.bodies = el('div');
    this.bodies.id = 'bodies';
    this.stage.append(this.bodies);
    this.canvas = new CanvasCoordinator(this);
    this.docks = new Docks(this);
    this.plans = new PlanDocks(this);
    this.panels = new Panels(this);
    this.bodyLayer = new Bodies(this);
    this.sheet = new AgentSheet(this);
    this.settings = new Settings(this);
    this.palette = new CommandPalette(this);
    this.groupNote = new GroupNote(this);
    this.notifier = new Notifier(this);
    this.welcome = new Welcome(this);
    this.navigator.show(this.showNavigator);
    this.store.watch(() => this.render());
    onTheme(() => this.render());
    // a past conversation dragged from the sidebar opens where it is dropped
    this.stage.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/taksim-conversation')) e.preventDefault(); });
    this.stage.addEventListener('drop', (e) => {
      const id = e.dataTransfer.getData('text/taksim-conversation');
      if (!id) return;
      e.preventDefault();
      const r = this.stage.getBoundingClientRect();
      this.continueConversation(id, this.graph.toGraph({ x: e.clientX - r.left, y: e.clientY - r.top }));
    });
    this.#keys();
  }

  async start() {
    const prefer = new URL(location.href).searchParams.get('canvas') ?? stored('taksim.canvas', null);
    await this.store.start(prefer);
    this.render();
    if (this.welcome.needed) this.welcome.open();
  }

  render() {
    const s = this.store;
    this.header.render();
    this.tabs.render();
    if (s.currentId && s.currentId !== this.shownCanvas) {
      this.shownCanvas = s.currentId;
      keep('taksim.canvas', s.currentId);
      history.replaceState(null, '', `/app?canvas=${encodeURIComponent(s.currentId)}`);
    }
    this.#emptyState();
    this.canvas.update();
    this.#undoCapsule();
    if (s.error) { toast(s.error, { error: true }); s.error = null; }
  }

  /** every tab closed: one action, a new canvas */
  #emptyState() {
    const empty = !this.store.currentId && !this.store.visibleCanvases.length;
    if (empty && !this.emptyEl) {
      const b = el('button', 'agent-key');
      const add = el('span', 'add', icon('plus', 14, 1.9), L('Canvas'));
      add.style.display = 'flex';
      add.style.alignItems = 'center';
      b.append(add);
      b.addEventListener('click', () => this.store.newCanvas());
      this.emptyEl = el('div', 'empty-canvas', b);
      this.stage.append(this.emptyEl);
    } else if (!empty && this.emptyEl) { this.emptyEl.remove(); this.emptyEl = null; }
  }

  /** "<name> closed · Undo", with a ring that runs out as the undo moment does */
  #undoCapsule() {
    const names = this.store.undoable.map((c) => c.name);
    const key = names.join('\n');
    if (key === this.undoKey) return;
    this.undoKey = key;
    this.undoEl?.remove();
    this.undoEl = null;
    if (!names.length) return;
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ring.setAttribute('width', 14); ring.setAttribute('height', 14); ring.setAttribute('viewBox', '0 0 14 14');
    ring.innerHTML = `<circle cx="7" cy="7" r="6" fill="none" stroke="var(--muted)" stroke-width="2" stroke-linecap="round" pathLength="100"
      stroke-dasharray="100" transform="rotate(-90 7 7)"><animate attributeName="stroke-dashoffset" from="0" to="100" dur="${CanvasStore.undoSeconds}s" fill="freeze"/></circle>`;
    const undo = el('button', null, L('Undo'));
    undo.addEventListener('click', () => this.store.undoClose());
    this.undoEl = el('div', 'capsule', ring, el('span', null, names.length === 1 ? L('“%@” closed', names[0]) : L('%d canvases closed', names.length)), undo);
    this.main.append(this.undoEl);
  }

  // ---------- adding agents (AppModel.addAgent / quickAdd) ----------

  /** the folders the canvas's agents work in, newest first */
  folderChoices() {
    const seen = new Set(), out = [];
    for (const a of [...this.store.currentAgents].sort((x, y) => (y.createdAt ?? 0) - (x.createdAt ?? 0))) {
      if (a.cwd && !seen.has(a.cwd)) { seen.add(a.cwd); out.push(a.cwd); }
    }
    return out.slice(0, 6);
  }

  /** a new agent without a form, in a folder asked for first */
  async quickAdd(backend) {
    let path = null;
    try { const result = await api.post('/v1/pick-folder', { start: this.folderChoices()[0] ?? null }); if (result.canceled) return; path = result.path; } catch {}
    if (path) return this.addAgent({ backend, folder: path });
    // no dialog on this system: the sheet asks for the folder
    if (path === null && !this.pickerTried) { this.pickerTried = true; }
    this.openSheet({ at: this.graph.viewCenter(), backend });
  }

  /** a new agent in the given folder ('' for none): the last model, in the middle of the view, its chat ready */
  async addAgent({ backend = null, folder = '' } = {}) {
    const s = this.store;
    if (!s.models.length) await s.loadChoices(); else s.loadChoices();
    const last = stored('taksim.lastModel', 'sonnet');
    let m = s.models.some((x) => x.id === last) ? last : (s.models[0]?.id ?? 'sonnet');
    if (backend && s.backendOf(m) !== backend) {
      m = s.models.find((x) => x.owned_by === backend && ['sonnet', 'gpt-6-astra', 'opencode-go/glm-5.3', 'fake-echo'].includes(x.id))?.id
        ?? s.models.find((x) => x.owned_by === backend)?.id ?? m;
    }
    const fields = { model: m };
    if (folder) fields.cwd = folder;
    const acct = stored(`taksim.lastAccount.${s.backendOf(m)}`, '');
    if (s.accounts.some((a) => a.id === acct)) fields.account = acct;
    const at = this.graph.viewCenter();
    fields.pos = [Math.round(at.x), Math.round(at.y)];
    try {
      const a = await s.addAgent(fields);
      keep('taksim.lastModel', m);
      this.agentAdded(a);
    } catch { this.openSheet({ at, model: m, cwd: folder }); }
  }

  agentAdded(a) {
    this.graph.revealAgent(a.id);
    setTimeout(() => this.bodyLayer.focus(a.id), 300);
  }

  /** a past conversation continued on the open canvas: the agent comes back with its chat and session */
  async continueConversation(id, at) {
    if (!this.store.currentId) await this.store.newCanvas();
    const p = at ?? this.graph.viewCenter(), body = { pos: [Math.round(p.x), Math.round(p.y)] };
    // one begun in a CLI itself continues on the model last picked here for that CLI
    const models = Object.fromEntries(['claude', 'codex', 'copilot', 'antigravity', 'gemini', 'opencode'].map((b) => [b, stored(`taksim.lastModel.${b}`, null)]).filter(([, m]) => m));
    if (Object.keys(models).length) body.models = models;
    try {
      const a = await api.post(`${this.store.canvasPath()}/history/${id}`, body);
      if (!this.store.agents.has(a.id)) this.store.order.push(a.id);
      this.store.agents.set(a.id, a);
      this.store.changed();
      this.agentAdded(a);
      return true;
    } catch (e) { this.store.fail(e); return false; }
  }

  revealAgent(id) {
    const a = this.store.agents.get(id);
    if (!a) return;
    if (!a.shell && a.chat !== true && (a.createdBy ?? 'user') === 'user') this.store.setChat(id, true);
    setTimeout(() => this.graph.revealAgent(id), 150);
  }

  /** the agent's IDE docked beside its node, on a file when given */
  openIDE(id, path) { this.docks.open(id, path); }
  showDiff(id, path) { this.docks.open(id, path); }
  toggleIDE(id) { this.docks.toggle(id); }
  layoutBodies() { this.bodyLayer.layout(); }
  /** "↶ <title>": undoes the removal it stands for, for six seconds */
  undoCapsule(title, undo) {
    this.removed?.remove();
    const b = el('button', 'capsule undo-capsule', icon('arrow.uturn.backward', 12, 2), el('s', null, title));
    b.title = L('Undo');
    b.addEventListener('click', () => { b.remove(); undo(); });
    this.stage.append(b);
    this.removed = b;
    setTimeout(() => { b.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300 }).onfinish = () => b.remove(); }, 6000);
  }
  openGroupNote(gid, rect) { this.groupNote.open(gid, rect); }

  // ---------- panes not built yet in this step ----------

  openSheet(ctx) { this.sheet?.open(ctx); }
  openSettings(section, opts) { this.settings.open(section, opts); }
  toggleNavigator() { this.showNavigator = !this.showNavigator; keep('taksim.showNavigator', this.showNavigator); this.navigator.show(this.showNavigator); this.render(); }

  // ---------- keyboard (the Mac menu's shortcuts) ----------

  #keys() {
    // Electron's menu bar (TaksimApp.commands): the same commands, its labels in the app's language
    const desk = window.taksimDesktop;
    if (desk?.setMenu) {
      const sync = () => desk.setMenu({
        settings: L('Settings…'), newCanvas: L('New canvas'), canvas: L('Canvas'), palette: L('Command palette'), sidebar: L('Sidebar'),
        showAll: L('Show all'), tabs: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => L('Tab %d', n)), intro: L('Intro and accounts'),
      });
      sync();
      onTheme(sync);
      desk.onCommand((c, n) => {
        if (c === 'newCanvas') this.store.newCanvas();
        else if (c === 'settings') this.openSettings();
        else if (c === 'palette') this.palette.toggle();
        else if (c === 'sidebar') this.toggleNavigator();
        else if (c === 'showAll') this.graph.fit(true);
        else if (c === 'intro') this.welcome.open();
        else if (c === 'tab') { const t = this.tabs.tabs()[n]; if (t) this.store.open(t.id); }
      });
    }
    addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
      if (mod && k === 't' && !e.shiftKey) { e.preventDefault(); this.store.newCanvas(); return; }
      if (mod && k === '0') { e.preventDefault(); this.graph.fit(true); return; }
      if (mod && e.shiftKey && k === 'a') { e.preventDefault(); this.toggleNavigator(); return; }
      if (mod && k === ',') { e.preventDefault(); this.openSettings(); return; }
      if (mod && k === 'k') { e.preventDefault(); this.palette.toggle(); return; }
      if (mod && k === 'z' && !typing && this.store.undoable.length) { e.preventDefault(); this.store.undoClose(); return; }
      if (mod && /^[1-9]$/.test(e.key) && !e.shiftKey) {
        const tabs = this.tabs.tabs(), i = Number(e.key) - 1;
        if (tabs[i]) { e.preventDefault(); this.store.open(tabs[i].id); }
      }
    });
  }
}

const app = new App(document.getElementById('app'));
window.taksim = app;
app.start();
