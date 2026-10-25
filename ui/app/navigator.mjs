// The sidebar (AgentNavigator.swift): this canvas's agents (reveal one, open its terminal), then the past
// conversations, newest first, as the Claude app lists them; a click continues one here. One search finds both.
import { L, lang } from './theme.mjs';
import { api } from './api.mjs';
import { icon } from './icons.mjs';
import { el, btn, menu, backendTile } from './ui.mjs';

function stored(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function keep(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
const statusColor = (s) => ({ running: 'var(--ok)', waiting: 'var(--wait)', error: 'var(--err)' }[s] ?? 'var(--muted)');

/** "now", "5 min", "3 hr", "Yesterday", "4 days", then the date: how the Claude app dates its conversations */
export function when(ms, now = new Date()) {
  if (!ms) return '';
  const d = new Date(ms), s = Math.max(0, Math.round((now - d) / 1000));
  if (s < 60) return L('now');
  if (s < 3600) return L('%d min', Math.floor(s / 60));
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const days = Math.round((day(now) - day(d)) / 864e5);
  if (days === 0) return L('%d hr', Math.floor(s / 3600));
  if (days === 1) return L('Yesterday');
  if (days < 7) return L('%d days', days);
  return d.toLocaleDateString(lang === 'tr' ? 'tr-TR' : 'en-US', { day: 'numeric', month: 'short', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}

/** Today, Yesterday, Previous 7 days, Previous 30 days, then month by month; or one section per project */
export function sections(list, grouping, sorting, now = new Date()) {
  const time = (c) => (sorting === 'created' ? c.createdAt : null) ?? c.lastAt ?? 0;
  const sorted = [...list].sort((a, b) => time(b) - time(a)), out = [];
  const add = (id, title, c) => { const s = out.find((x) => x.id === id); if (s) s.items.push(c); else out.push({ id, title, items: [c] }); };
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  if (grouping === 'date') {
    for (const c of sorted) {
      const d = new Date(time(c)), days = Math.round((day(now) - day(d)) / 864e5);
      if (days <= 0) add('today', L('Today'), c);
      else if (days === 1) add('yesterday', L('Yesterday'), c);
      else if (days <= 7) add('week', L('Previous 7 days'), c);
      else if (days <= 30) add('month', L('Previous 30 days'), c);
      else add(`m${d.getFullYear()}-${d.getMonth() + 1}`, d.toLocaleDateString(lang === 'tr' ? 'tr-TR' : 'en-US', { month: 'long', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) }), c);
    }
  } else {
    for (const c of sorted) if (c.cwd || c.folder) add('p:' + (c.cwd ?? c.folder), c.folder ?? c.cwd.split(/[\\/]/).filter(Boolean).at(-1), c);
    for (const c of sorted) if (!c.cwd && !c.folder) add('p:', L('No folder'), c);
  }
  return out;
}

export class Navigator {
  query = '';
  selected = null;
  past = [];
  continuing = null;

  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.root = el('aside', 'navigator');
    this.root.setAttribute('aria-label', L('Sidebar'));
    this.count = el('span', 'nav-count');
    const head = el('div', 'nav-head', el('b', null, L('Agents')), this.count, el('span', 'spacer'), btn('ibtn', icon('minus', 14), () => app.toggleNavigator(), L('Hide sidebar')));
    this.search = el('input');
    this.search.placeholder = L('Search');
    this.search.setAttribute('aria-label', L('Search'));
    this.search.addEventListener('input', () => { this.query = this.search.value; this.render(); this.#load(250); });
    this.search.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { const a = this.#agents()[0]; if (a) this.reveal(a.id); }
      if (e.key === 'Escape') { this.search.value = this.query = ''; this.render(); this.#load(0); }
    });
    this.list = el('div', 'nav-list');
    this.root.append(head, el('label', 'nav-search', icon('magnifyingglass', 14), this.search), this.list);
    this.store.watch(() => { if (!this.root.hidden) this.#reload(); });
  }

  get grouping() { return stored('taksim.historyGrouping', 'date'); }
  get sorting() { return stored('taksim.historySorting', 'lastActive'); }
  get collapsed() { return new Set(stored('taksim.historyCollapsed', [])); }

  /** read again as conversations come and go: an agent removed here joins the list */
  #reload() {
    const key = [this.store.order.join(','), this.store.canvases.length, this.store.currentId].join('|');
    if (key !== this.lastKey) {
      if (this.store.currentId !== this.lastCanvas) { this.lastCanvas = this.store.currentId; this.selected = null; }
      this.lastKey = key;
      this.#load(0);
    }
    this.render();
  }

  #load(delay) {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      const q = this.query.trim();
      try { this.past = (await api.get(q ? `/v1/history?q=${encodeURIComponent(q)}` : '/v1/history')).conversations ?? []; } catch {}
      this.render();
    }, delay);
  }

  #agents() {
    const q = this.query.toLowerCase();
    return this.store.currentAgents.filter((a) => !q || a.name.toLowerCase().includes(q) || (a.backend ?? '').toLowerCase().includes(q));
  }

  show(on) {
    this.root.hidden = !on;
    if (on) { this.lastKey = null; this.#reload(); }
  }

  render() {
    if (this.root.hidden) return;
    this.count.textContent = this.store.currentAgents.length;
    const agents = this.#agents(), rows = [];
    for (const a of agents) {
      const main = btn('nav-agent', null, () => this.reveal(a.id), L('Show on canvas'));
      const bar = el('i');
      bar.style.background = statusColor(a.status);
      main.append(bar, el('span', 'nav-agent-text', el('b', null, a.name), el('span', null, a.backend ?? 'terminal')));
      const term = btn('ibtn', icon(a.shell ? 'minus' : 'terminal', 16), () => { this.reveal(a.id); this.app.canvas.openTerminal(a.id); }, a.shell ? L('Hide terminal') : L('Open terminal'));
      const row = el('div', 'nav-row' + (this.selected === a.id ? ' on' : ''), main, term);
      rows.push(row);
    }
    if (!agents.length && this.query && !this.past.length) rows.push(el('div', 'nav-empty', L('No results')));
    if (this.past.length) {
      const arrange = btn('tap nav-arrange', icon(this.grouping === 'project' ? 'folder' : 'list.bullet', 11), () => menu(arrange, [
        { label: L('By date'), icon: 'clock.arrow.circlepath', checked: this.grouping === 'date', run: () => { keep('taksim.historyGrouping', 'date'); this.render(); } },
        { label: L('By project'), icon: 'folder', checked: this.grouping === 'project', run: () => { keep('taksim.historyGrouping', 'project'); this.render(); } },
        null,
        { label: L('Last active'), checked: this.sorting === 'lastActive', run: () => { keep('taksim.historySorting', 'lastActive'); this.render(); } },
        { label: L('Started'), icon: 'sparkles', checked: this.sorting === 'created', run: () => { keep('taksim.historySorting', 'created'); this.render(); } },
      ]), L('Group and sort'));
      const head = el('div', 'nav-history', icon('clock.arrow.circlepath', 11), el('b', null, L('History')), el('span', 'spacer'), arrange);
      if (!agents.length) head.style.paddingTop = '4px';
      rows.push(head);
      const shut = this.collapsed;
      for (const sec of sections(this.past, this.grouping, this.sorting)) {
        const closed = shut.has(sec.id);
        const h = btn('nav-section', null, () => {
          const set = this.collapsed;
          if (closed) set.delete(sec.id); else set.add(sec.id);
          keep('taksim.historyCollapsed', [...set].sort());
          this.render();
        });
        const chev = el('span', 'chev' + (closed ? '' : ' open'), icon('chevron.right', 8, 2.4));
        h.append(chev);
        if (this.grouping === 'project') h.append(icon('folder', 10));
        h.append(el('b', null, sec.title));
        if (closed) h.append(el('span', 'n', String(sec.items.length)));
        h.title = sec.items[0]?.cwd ?? sec.title;
        rows.push(h);
        if (!closed) for (const c of sec.items) rows.push(this.#pastRow(c));
      }
    }
    this.list.replaceChildren(...rows);
  }

  /** a past conversation: its CLI, its first request, where and when; a click continues it on this canvas */
  #pastRow(c) {
    const time = (this.sorting === 'created' ? c.createdAt : null) ?? c.lastAt;
    const b = btn('nav-past', null, async () => {
      if (this.continuing) return;
      this.continuing = c.id;
      this.render();
      if (await this.app.continueConversation(c.id)) this.past = this.past.filter((x) => x.id !== c.id);
      this.continuing = null;
      this.render();
    });
    const tile = backendTile(c.backend ?? 'claude', 18);
    if (this.continuing === c.id) tile.classList.add('busy');
    const meta = el('span', 'meta');
    if (this.grouping === 'date' && c.folder) meta.append(el('span', 'ellip', c.folder), '·');
    meta.append(el('span', null, when(time)));
    b.append(tile, el('span', 'nav-past-text', el('span', 'title', c.title), meta));
    b.title = c.lastText ? `${c.name} — ${c.lastText}` : c.name;
    b.disabled = !!this.continuing;
    // dragged onto the canvas or a tab, it opens there
    b.draggable = true;
    b.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/taksim-conversation', c.id); e.dataTransfer.effectAllowed = 'copy'; });
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      menu({ x: e.clientX, y: e.clientY }, [{ label: L('Delete'), icon: 'trash', run: () => {
        this.past = this.past.filter((x) => x.id !== c.id);
        this.render();
        api.delete(`/v1/history/${c.id}`).catch(() => {});
      } }]);
    });
    return b;
  }

  reveal(id) { this.selected = id; this.render(); this.app.revealAgent(id); }
}
