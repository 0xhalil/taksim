// The ⌘K palette (CommandPalette.swift): one search over the canvas's agents, the past conversations (by their
// words too), the actions and the settings sections. ↑↓ moves, ⏎ opens (⌥⏎ an agent's terminal), ⌘[ ⌘] switch
// tabs, esc closes.
import { L } from './theme.mjs';
import { api } from './api.mjs';
import { icon } from './icons.mjs';
import { el, btn } from './ui.mjs';
import { when } from './navigator.mjs';
import { settingsSections } from './settings.mjs';

const tabs = [['all', 'All'], ['agents', 'Agents'], ['history', 'History'], ['actions', 'Actions'], ['settings', 'Settings']];
const statusColor = (s) => ({ running: 'var(--ok)', waiting: 'var(--wait)', error: 'var(--err)' }[s]);

export class CommandPalette {
  constructor(app) { this.app = app; this.store = app.store; }

  toggle() { if (this.root) this.close(); else this.open(); }

  open() {
    this.query = '';
    this.tab = 'all';
    this.selected = 0;
    this.past = [];
    this.field = el('input');
    this.field.placeholder = L('Search agents, conversations, settings…');
    this.field.addEventListener('input', () => { this.query = this.field.value; this.selected = 0; this.draw(); this.#load(200); });
    this.field.addEventListener('keydown', (e) => this.#key(e));
    this.clear = btn('tap', icon('xmark.circle', 12), () => { this.field.value = this.query = ''; this.draw(); this.#load(0); this.field.focus(); }, L('Clear'));
    this.tabsEl = el('div', 'pal-tabs');
    this.list = el('div', 'pal-list');
    this.root = el('div', 'palette', el('div', 'pal-search', icon('magnifyingglass', 13), this.field, this.clear), this.tabsEl, el('hr'), this.list, el('hr'),
      el('div', 'pal-foot', L('↑↓ Select · ⏎ Open · ⌥⏎ Terminal · esc Close')));
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', L('Command palette'));
    this.scrim = el('div', 'pal-scrim', this.root);
    this.scrim.addEventListener('pointerdown', (e) => { if (e.target === this.scrim) this.close(); });
    document.body.append(this.scrim);
    this.draw();
    this.#load(0);
    requestAnimationFrame(() => this.field.focus());
  }

  close() { this.scrim?.remove(); this.root = this.scrim = null; this.app.graph.canvas.focus({ preventScroll: true }); }

  #load(delay) {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      const q = this.query.trim();
      try { this.past = (await api.get(q ? `/v1/history?q=${encodeURIComponent(q)}` : '/v1/history')).conversations ?? []; } catch {}
      if (this.root) this.draw();
    }, delay);
  }

  rows() {
    const out = [], a = this.app;
    for (const ag of this.store.currentAgents) out.push({ id: 'agent-' + ag.id, agent: ag.id, tab: 'agents', section: L('Agents'), dot: statusColor(ag.status), title: ag.name, hint: ag.model, run: () => a.revealAgent(ag.id) });
    for (const c of this.past.slice(0, !this.query && this.tab === 'all' ? 5 : 40)) {
      out.push({ id: 'past-' + c.id, tab: 'history', section: L('History'), symbol: 'clock.arrow.circlepath', title: c.title, hint: when(c.lastAt), run: () => a.continueConversation(c.id) });
    }
    out.push({ id: 'new-agent', tab: 'actions', section: L('Actions'), symbol: 'plus', title: L('New Agent'), run: () => a.openSheet({ at: a.graph.viewCenter() }) });
    out.push({ id: 'new-canvas', tab: 'actions', section: L('Actions'), symbol: 'square.stack.3d.up', title: L('New canvas'), hint: '⌘T', run: () => this.store.newCanvas() });
    out.push({ id: 'navigator', tab: 'actions', section: L('Actions'), symbol: 'sidebar.left', title: L('Sidebar'), hint: '⇧⌘A', run: () => a.toggleNavigator() });
    for (const s of settingsSections) out.push({ id: 'settings-' + s.id, tab: 'settings', section: L('Settings'), symbol: s.symbol, title: s.title, keywords: s.keywords, run: () => a.openSettings(s.id) });
    return out;
  }

  visible() {
    const q = this.query.trim().toLocaleLowerCase('tr');
    return this.rows().filter((r) => (this.tab === 'all' || r.tab === this.tab)
      && (!q || r.tab === 'history' || r.title.toLocaleLowerCase('tr').includes(q) || (r.keywords ?? []).some((k) => k.toLocaleLowerCase('tr').includes(q))));
  }

  draw() {
    this.clear.hidden = !this.query;
    this.tabsEl.replaceChildren(...tabs.map(([id, title]) => {
      const b = btn('pal-tab' + (this.tab === id ? ' on' : ''), null, () => { this.tab = id; this.selected = 0; this.draw(); this.field.focus(); });
      b.append(L(title));
      return b;
    }));
    const rows = this.visible(), out = [];
    let section = null;
    rows.forEach((r, i) => {
      if (r.section !== section) { section = r.section; out.push(el('div', 'pal-section', section)); }
      const b = btn('pal-row' + (i === this.selected ? ' on' : ''), null, () => this.#run(r));
      if (r.dot) { const d = el('i', 'pal-dot'); d.style.background = r.dot; b.append(d); }
      else if (r.symbol) b.append(el('span', 'pal-sym', icon(r.symbol, 12)));
      b.append(el('span', 'pal-title', r.title), el('span', 'spacer'));
      if (r.hint) b.append(el('span', 'pal-hint', r.hint));
      b.addEventListener('pointermove', () => { if (this.selected !== i) { this.selected = i; this.#mark(); } });
      out.push(b);
    });
    if (!rows.length) out.push(el('div', 'pal-empty', L('No results')));
    this.list.replaceChildren(...out);
  }

  #mark() {
    this.list.querySelectorAll('.pal-row').forEach((b, i) => b.classList.toggle('on', i === this.selected));
    this.list.querySelectorAll('.pal-row')[this.selected]?.scrollIntoView({ block: 'nearest' });
  }

  #run(r, terminal = false) {
    this.close();
    if (terminal && r.agent) this.app.canvas.openTerminal(r.agent); else r.run();
  }

  #key(e) {
    e.stopPropagation();
    const rows = this.visible();
    if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (rows.length) { this.selected = (this.selected + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length; this.#mark(); } }
    else if (e.key === 'Enter') { e.preventDefault(); const r = rows[this.selected]; if (r) this.#run(r, e.altKey); }
    else if ((e.metaKey || e.ctrlKey) && (e.key === '[' || e.key === ']')) {
      e.preventDefault();
      const i = tabs.findIndex(([id]) => id === this.tab);
      this.tab = tabs[(i + (e.key === ']' ? 1 : -1) + tabs.length) % tabs.length][0];
      this.selected = 0;
      this.draw();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); this.close(); }
  }
}
