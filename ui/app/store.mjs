// The app's state: the canvases (tabs), the open canvas and what's on it, kept current by the canvas's event
// stream. A port of TaksimKit/CanvasStore.swift; views subscribe with `store.watch(fn)` and redraw from it.
import { api, stream } from './api.mjs';
import { L } from './theme.mjs';

function stored(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function keep(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }

export const backendOrder = ['claude', 'codex', 'copilot', 'antigravity', 'opencode', 'gemini', 'local', 'fake'];
export function backendLabel(b) {
  return { claude: 'Claude Code', codex: 'Codex', copilot: 'GitHub Copilot', opencode: 'opencode', antigravity: 'Antigravity', gemini: 'Gemini CLI', local: L('Local'), fake: 'test' }[b] ?? b;
}

export class CanvasStore {
  canvases = [];
  lockedTabs = new Set(stored('taksim.lockedCanvasTabs', []));
  closedTabs = new Set();
  currentId = null;
  agents = new Map();          // the open canvas's agents by id
  order = [];                  // agent ids in the order they came; later is nearer the eye
  groups = new Map();
  links = [];
  computer = {};               // agent id -> its computer control
  streaming = new Map();       // agent id -> text streaming in this turn
  connected = false;
  everConnected = false;
  error = null;
  undoable = [];               // the tabs closed last, still on the server for a moment
  models = [];
  accounts = [];
  usage = {};
  usageLogins = {};
  static undoSeconds = 6;

  #watchers = new Set();
  #listeners = new Set();
  #pending = false;
  #events = null;
  #visited = new Map();
  #deletes = new Map();
  #moving = new Map();

  get visibleCanvases() { return this.canvases.filter((c) => !this.closedTabs.has(c.id)); }
  get currentAgents() { return this.order.map((id) => this.agents.get(id)).filter(Boolean); }
  get backends() {
    const rank = (b) => { const i = backendOrder.indexOf(b); return i < 0 ? 99 : i; };
    return [...new Set(this.models.map((m) => m.owned_by))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }

  /** fn() after anything changed (coalesced to one call per task) */
  watch(fn) { this.#watchers.add(fn); return () => this.#watchers.delete(fn); }
  /** fn(type, data) for every event of the open canvas, after it is applied */
  listen(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
  changed() {
    if (this.#pending) return;
    this.#pending = true;
    requestAnimationFrame(() => { this.#pending = false; for (const fn of this.#watchers) fn(); });
  }
  fail(e) { this.error = e?.message || String(e); this.changed(); }
  run(work) { work().catch((e) => this.fail(e)); }

  // ---------- tabs ----------

  toggleTabLock(id) {
    if (this.lockedTabs.has(id)) this.lockedTabs.delete(id); else this.lockedTabs.add(id);
    keep('taksim.lockedCanvasTabs', [...this.lockedTabs].sort());
    this.changed();
  }

  /** closing is deleting, after a moment to take it back; the next tab opens in the closed one's place */
  async closeTabs(requested, ordered) {
    const closing = new Set([...requested].filter((id) => !this.lockedTabs.has(id)));
    if (!closing.size) return;
    let next = null;
    if (this.currentId && closing.has(this.currentId)) {
      const i = ordered.indexOf(this.currentId);
      next = ordered.slice(i + 1).find((id) => !closing.has(id)) ?? ordered.slice(0, i).reverse().find((id) => !closing.has(id)) ?? null;
    }
    for (const id of closing) this.closedTabs.add(id);
    this.#scheduleDelete(closing);
    if (this.currentId && closing.has(this.currentId)) await this.#closeCurrent(next);
    this.changed();
  }

  #scheduleDelete(ids) {
    this.undoable = this.canvases.filter((c) => ids.has(c.id));
    for (const id of ids) {
      clearTimeout(this.#deletes.get(id));
      this.#deletes.set(id, setTimeout(() => this.#purge(id), CanvasStore.undoSeconds * 1000));
    }
  }

  async #purge(id) {
    this.#deletes.delete(id);
    this.undoable = this.undoable.filter((c) => c.id !== id);
    if (!this.closedTabs.has(id)) return this.changed();
    try {
      await api.delete(`/v1/canvases/${id}`);
      this.canvases = this.canvases.filter((c) => c.id !== id);
      this.closedTabs.delete(id);
    } catch (e) { this.error = e.message; }
    this.changed();
  }

  async undoClose() {
    const back = this.undoable;
    this.undoable = [];
    for (const c of back) { clearTimeout(this.#deletes.get(c.id)); this.#deletes.delete(c.id); this.closedTabs.delete(c.id); }
    if (back[0]) await this.open(back[0].id);
    this.changed();
  }

  async #closeCurrent(next) {
    this.#events?.close();
    this.#events = null;
    this.currentId = null;
    this.agents = new Map(); this.order = []; this.groups = new Map(); this.links = []; this.streaming = new Map();
    this.connected = false;
    if (next) await this.open(next);
  }

  // ---------- canvases ----------

  /** loads the tab list and opens a canvas (the remembered one, else the first; makes one when there are none) */
  async start(prefer) {
    try {
      let list = (await api.get('/v1/canvases')).canvases;
      if (!list.length) {
        const c = await api.post('/v1/canvases', { name: CanvasStore.nextTabName([]), autoName: true });
        list = [{ id: c.id, name: c.name, agents: 0, busy: 0 }];
      }
      this.canvases = list;
      await this.open(list.some((c) => c.id === prefer) ? prefer : list[0].id);
      for (const c of list) if (c.id !== this.currentId && !this.#visited.has(c.id)) {
        api.get(`/v1/canvases/${c.id}`).then((full) => { if (!this.#visited.has(c.id)) this.#visited.set(c.id, full); }).catch(() => {});
      }
    } catch (e) { this.fail(e); }
    this.#poll();
    this.loadChoices();
  }

  #poll() {
    clearInterval(this.pollTimer);
    let polling = false;
    this.pollTimer = setInterval(async () => {
      if (polling || document.hidden) return;
      polling = true;
      try {
        const list = (await api.get('/v1/canvases')).canvases;
        if (JSON.stringify(list) !== JSON.stringify(this.canvases)) { this.canvases = list; this.changed(); }
      } catch {} finally { polling = false; }
    }, 4000);
  }

  async open(id) {
    this.closedTabs.delete(id);
    if (id === this.currentId) return this.changed();
    this.#events?.close();
    if (this.currentId) {
      const cur = this.currentId;
      this.#visited.set(cur, { id: cur, name: this.canvases.find((c) => c.id === cur)?.name ?? '', agents: this.currentAgents, links: this.links, groups: [...this.groups.values()], computer: this.computer });
    }
    const seen = this.#visited.get(id);
    if (seen) this.load(seen);
    else { this.currentId = id; this.agents = new Map(); this.order = []; this.groups = new Map(); this.links = []; this.changed(); }
    try {
      const c = await api.get(`/v1/canvases/${id}`);
      if (this.currentId !== id) return;
      this.load(c);
      this.#listen(id, c.seq ?? 0);
    } catch (e) { this.fail(e); }
  }

  load(c) {
    this.closedTabs.delete(c.id);
    this.currentId = c.id;
    this.agents = new Map(c.agents.map((a) => [a.id, a]));
    this.order = c.agents.map((a) => a.id);
    this.groups = new Map((c.groups ?? []).map((g) => [g.id, g]));
    this.links = c.links ?? [];
    this.computer = c.computer ?? {};
    this.streaming = new Map();
    this.changed();
  }

  #listen(id, since) {
    let last = since;
    this.loadUsage();
    this.#events = stream(() => `/v1/canvases/${id}/events?since=${last}`, {
      onState: (up) => { this.connected = up; if (up) this.everConnected = true; this.changed(); },
      onEvent: (type, raw) => {
        if (this.currentId !== id) return;
        let ev;
        try { ev = JSON.parse(raw); } catch { return; }
        last = Math.max(last, ev.seq ?? 0);
        this.apply(type ?? ev.type ?? 'message', ev.data ?? {});
      },
    });
  }

  // ---------- events (CanvasStore.apply) ----------

  apply(type, d) {
    const a = d.id ? this.agents.get(d.id) : null;
    switch (type) {
      case 'agent_created': case 'agent_updated':
        if (!d.agent) break;
        if (!this.agents.has(d.agent.id)) this.order.push(d.agent.id);
        this.agents.set(d.agent.id, this.#fresh(d.agent));
        break;
      case 'usage_updated':
        if (d.key) { this.usage[d.key] = d.usage; if (!this.usageLogins[d.key]) this.loadUsage(); }
        break;
      case 'agent_status':
        if (!a) break;
        this.agents.set(d.id, {
          ...a, status: d.status ?? a.status, queued: d.queued, waitingOn: d.waitingOn, workingWith: d.workingWith,
          blockedBy: d.blockedBy, lastError: d.lastError, termReady: d.termReady, folder: d.folder ?? a.folder,
        });
        if ((d.status ?? a.status) !== 'running') this.streaming.delete(d.id);
        break;
      case 'canvas_updated': {
        const c = this.canvases.find((c) => c.id === this.currentId);
        if (c && d.name && c.name !== d.name) c.name = d.name;
        break;
      }
      case 'agent_removed':
        this.agents.delete(d.id);
        delete this.computer[d.id];
        this.order = this.order.filter((x) => x !== d.id);
        this.links = this.links.filter((l) => l.from !== d.id && l.to !== d.id);
        break;
      case 'link_created': if (d.link) this.links.push(d.link); break;
      case 'link_updated': {
        const i = this.links.findIndex((l) => l.from === d.link?.from && l.to === d.link?.to && l.kind === d.link?.kind);
        if (i >= 0) this.links[i] = d.link;
        break;
      }
      case 'message': {
        const from = this.agents.get(d.from);
        if (d.kind === 'assistant' && from) { this.agents.set(d.from, { ...from, lastText: d.text }); this.streaming.delete(d.from); }
        break;
      }
      case 'text_delta': if (d.id) this.streaming.set(d.id, (this.streaming.get(d.id) ?? '') + d.text); break;
      case 'group_created': case 'group_updated': case 'context_updated': if (d.group) this.groups.set(d.group.id, d.group); break;
      case 'group_removed': this.groups.delete(d.id); break;
      case 'panel_updated': if (a) this.agents.set(d.id, { ...a, panel: d.panel?.spec ? d.panel : null }); break;
      case 'ide_updated': if (a) this.agents.set(d.id, { ...a, ide: d.ide }); break;
      case 'computer': if (d.computer) this.computer[d.id] = d.computer; else delete this.computer[d.id]; break;
    }
    for (const fn of this.#listeners) fn(type, d);
    this.changed();
  }

  // ---------- actions ----------

  canvasPath() { return `/v1/canvases/${this.currentId ?? ''}`; }
  agentPath(id, rest = '') { return `${this.canvasPath()}/agents/${id}${rest}`; }
  #patchLocal(id, fields) { const a = this.agents.get(id); if (a) { this.agents.set(id, { ...a, ...fields }); this.changed(); } }

  raise(id) {
    if (this.order.at(-1) === id || !this.order.includes(id)) return;
    this.order = [...this.order.filter((x) => x !== id), id];
    this.changed();
  }
  /** the server's view of an agent, keeping a move it hasn't heard of yet */
  #fresh(a) { const m = this.#moving.get(a.id); return m ? { ...a, pos: m.pos } : a; }

  /** a move shows at once; until the server has it, an older view of the agent from the stream doesn't undo it */
  move(id, pos) {
    this.#patchLocal(id, { pos });
    const mark = {};
    this.#moving.set(id, { pos, mark });
    this.run(() => api.patch(this.agentPath(id), { pos: pos.map(Math.round) }).finally(() => { if (this.#moving.get(id)?.mark === mark) this.#moving.delete(id); }));
  }
  setCollapsed(id, on) { this.#patchLocal(id, { collapsed: on }); this.run(() => api.patch(this.agentPath(id), { collapsed: on })); }
  resize(id, size, terminal, pos) {
    this.#patchLocal(id, { [terminal ? 'size' : 'cardSize']: size, pos });
    this.run(() => api.patch(this.agentPath(id), { [terminal ? 'size' : 'cardSize']: size, pos }));
  }
  renameAgent(id, name) { this.#patchLocal(id, { name }); this.run(() => api.patch(this.agentPath(id), { name })); }
  deleteAgent(id) { this.run(() => api.delete(this.agentPath(id))); }
  stop(id) { this.run(() => api.post(this.agentPath(id, '/stop'))); }
  resetSession(id) { this.run(() => api.patch(this.agentPath(id), { reset_session: true })); }
  deliver(id) { this.run(() => api.post(this.agentPath(id, '/deliver'))); }
  tell(id, text) { this.run(() => api.post(this.agentPath(id, '/messages'), { text })); }
  setChat(id, on) { this.#patchLocal(id, { chat: on ? true : null }); this.run(() => api.patch(this.agentPath(id), { chat: on })); }
  setHelpers(id, on) { this.#patchLocal(id, { delegate: on }); this.run(() => api.patch(this.agentPath(id), { delegate: on })); }
  setToolHelp(id, on) { this.#patchLocal(id, { toolHelp: on ? null : false }); this.run(() => api.patch(this.agentPath(id), { toolHelp: on })); }
  setEffort(id, effort) { this.#patchLocal(id, { effort }); this.run(() => api.patch(this.agentPath(id), { effort: effort ?? '' })); }
  setComputer(id, allow) {
    if (allow) this.computer[id] = { state: 'on', missing: this.computer[id]?.missing, at: this.computer[id]?.at }; else delete this.computer[id];
    this.changed();
    this.run(() => api.post(this.agentPath(id, '/computer'), { allow }));
  }
  async reloadAgent(id) { const a = await api.get(this.agentPath(id)); this.agents.set(id, this.#fresh(a)); this.changed(); return a; }

  /** a plain shell in the agent's folder, in its node, or closed back into the chat */
  toggleTerminal(id, opened = () => {}) {
    const a = this.agents.get(id);
    if (!a) return;
    this.run(async () => {
      if (a.shell) { await api.delete(this.agentPath(id, '/shell')); return; }
      const v = await api.post(this.agentPath(id, '/shell'));
      this.agents.set(id, this.#fresh(v));
      this.changed();
      opened();
    });
  }

  setGroupRect(gid, rect) {
    const g = this.groups.get(gid);
    if (g) this.groups.set(gid, { ...g, rect });
    this.changed();
    this.run(() => api.patch(`${this.canvasPath()}/groups/${gid}`, { rect }));
  }
  async createGroup(rect, name, color) {
    try {
      const g = await api.post(`${this.canvasPath()}/groups`, { name, rect: rect.map(Math.round), ...(color ? { color } : {}) });
      this.groups.set(g.id, g);
      this.changed();
      return g;
    } catch (e) { this.fail(e); return null; }
  }
  patchGroup(gid, body) {
    const g = this.groups.get(gid);
    if (g) this.groups.set(gid, { ...g, ...body });
    this.changed();
    this.run(() => api.patch(`${this.canvasPath()}/groups/${gid}`, body));
  }
  deleteGroup(gid) { this.groups.delete(gid); this.changed(); this.run(() => api.delete(`${this.canvasPath()}/groups/${gid}`)); }

  // ---------- adding agents ----------

  async loadChoices() {
    try { this.models = (await api.get('/v1/models')).data.map(m => m.owned_by === 'antigravity' ? { ...m, display_name: m.id === 'agy' ? 'Default' : (m.display_name ?? m.id).replace(/^agy:/, '') } : m); } catch {}
    try { this.accounts = (await api.get('/v1/accounts')).accounts; } catch {}
    this.changed();
  }

  /** the CLI a model runs on */
  backendOf(model) {
    return this.models.find((m) => m.id === model)?.owned_by
      ?? (model.startsWith('local:') ? 'local' : model === 'copilot' || model.startsWith('copilot:') ? 'copilot'
        : model === 'agy' || model.startsWith('agy:') ? 'antigravity'
        : model.includes('/') ? 'opencode' : /^(gpt|codex|o\d)/.test(model) ? 'codex' : 'claude');
  }

  async addAgent(fields) {
    const a = await api.post(`${this.canvasPath()}/agents`, { chat: true, ...fields });
    if (!this.agents.has(a.id)) this.order.push(a.id);
    this.agents.set(a.id, a);
    this.changed();
    return a;
  }
  async updateAgent(id, fields) { const a = await api.patch(this.agentPath(id), fields); this.agents.set(id, this.#fresh(a)); this.changed(); return a; }

  async newCanvas() {
    try {
      const c = await api.post('/v1/canvases', { name: CanvasStore.nextTabName(this.visibleCanvases.map((c) => c.name)), autoName: true });
      this.canvases.push({ id: c.id, name: c.name, agents: 0, busy: 0 });
      await this.open(c.id);
    } catch (e) { this.fail(e); }
  }

  /** "canvas n" after the open tabs' count, skipping a name an open tab has */
  static nextTabName(open) {
    const used = new Set(open);
    let n = open.length + 1;
    while (used.has(`canvas ${n}`) || used.has(`tuval ${n}`)) n++;
    return L('canvas %d', n);
  }

  async rename(id, name) {
    const c = this.canvases.find((c) => c.id === id);
    if (!c) return;
    c.name = name;
    this.changed();
    try { await api.put(`/v1/canvases/${id}`, { name }); } catch (e) { this.fail(e); }
  }

  // ---------- plan usage ----------

  async loadUsage() {
    try {
      const l = await api.get('/v1/usage');
      this.usage = Object.fromEntries(Object.entries(l.usage ?? {}).filter(([, v]) => v));
      Object.assign(this.usageLogins, l.logins ?? {});
      this.changed();
    } catch {}
  }
  /** the logins the open canvas's agents run under, in the order they first appear */
  get canvasLogins() {
    const seen = new Set(), out = [];
    for (const a of this.currentAgents) {
      if (!a.usageKey || !a.backend) continue;
      const k = this.loginKey(a.usageKey);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ key: k, login: this.usageLogins[k] ?? { backend: a.backend, name: a.accountName, machine: k.startsWith('machine:') } });
    }
    return out;
  }
  async refreshUsage(force = false) {
    try {
      const l = await api.post('/v1/usage/refresh', { force });
      this.usage = Object.fromEntries(Object.entries(l.usage ?? {}).filter(([, v]) => v));
      Object.assign(this.usageLogins, l.logins ?? {});
      this.changed();
    } catch {}
  }
  loginKey(key) { const same = this.usageLogins[key]?.same; return same && (this.usageLogins[same] || this.usage[same]) ? same : key; }
  usageFor(key) {
    const k = this.loginKey(key);
    const keys = [k, ...Object.entries(this.usageLogins).filter(([, v]) => v.same === k).map(([key]) => key)];
    return keys.map((x) => this.usage[x]).filter(Boolean).sort((a, b) => (b.checkedAt ?? 0) - (a.checkedAt ?? 0))[0] ?? null;
  }
}
