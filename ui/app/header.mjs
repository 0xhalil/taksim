// The main toolbar (HeaderBar.swift): the brand, the sidebar key, the connection dot, show-all and settings,
// and the bar's one accent key, + Agent with its chevron.
import { L } from './theme.mjs';
import { icon } from './icons.mjs';
import { el, btn, menu, mark, backendTile } from './ui.mjs';
import { backendLabel } from './store.mjs';
import { usageBars, windowName, until } from './settings.mjs';

export class HeaderBar {
  constructor(app) {
    this.app = app;
    this.root = el('header');
    if (window.taksimDesktop) document.documentElement.dataset.desktop = window.taksimDesktop.platform;
    const brand = el('div', 'brand', mark(15), el('b', null, 'taksim'));
    this.sidebar = btn('hic', 'sidebar.left', () => app.toggleNavigator(), L('Sidebar  ⌘⇧A'));
    this.conn = el('span', 'conn');
    this.conn.title = L('Connection lost');
    this.conn.setAttribute('role', 'status');
    this.conn.setAttribute('aria-label', L('Connection lost'));
    // kept tools fly to the settings key and wait under Settings › Plugins
    this.shelf = 0;
    this.shelfBadge = el('span', 'shelf-badge');
    this.shelfBadge.hidden = true;
    this.settingsKey = btn('hic', 'gearshape', () => { if (this.shelf) { this.shelf = 0; this.shelfBadge.hidden = true; app.openSettings('plugins'); } else app.openSettings(); }, L('Settings  ⌘,'));
    this.settingsKey.append(this.shelfBadge);
    const group = el('div', 'hgroup',
      btn('hic', 'arrow.up.left.and.arrow.down.right', () => app.graph.fit(true), L('Show all  ⌘0')),
      this.settingsKey);
    this.key = this.#agentKey();
    this.usage = el('button', 'usage-key');
    this.usage.type = 'button';
    this.usage.setAttribute('aria-label', L('Usage'));
    this.usage.addEventListener('click', () => this.#usagePanel());
    this.root.append(brand, this.sidebar, el('span', 'spacer'), this.usage, this.conn, group, this.key);
  }

  bumpShelf() {
    this.shelf++;
    this.shelfBadge.textContent = String(this.shelf);
    this.shelfBadge.hidden = false;
    this.shelfBadge.animate([{ transform: 'scale(.4)' }, { transform: 'scale(1.15)' }, { transform: 'none' }], { duration: 350, easing: 'ease-out' });
  }

  /** "+ Agent": an agent like the last one in a folder asked first; the chevron picks another CLI */
  #agentKey() {
    const key = el('div', 'agent-key');
    const down = (on) => key.classList.toggle('down', on);
    const add = btn('add', null, () => { down(true); menu(key, this.#folderMenu(), { onClose: () => down(false) }); }, L('Add agent'));
    add.append(icon('plus', 12, 1.9), L('Agent'));
    const more = btn('more', null, () => { down(true); menu(key, this.#backendMenu(), { onClose: () => down(false) }); });
    more.setAttribute('aria-label', L('More'));
    more.append(icon('chevron.down', 10, 2.2));
    key.append(add, el('i'), more);
    return key;
  }

  #folderMenu() {
    const app = this.app, folders = app.folderChoices();
    const items = folders.map((path) => ({ label: folderTitle(path, folders), icon: 'folder', run: () => app.addAgent({ folder: path }) }));
    if (items.length) items.push(null);
    items.push({ label: L('Choose folder'), icon: 'folder.badge.plus', run: () => app.quickAdd() });
    items.push({ label: L('No folder'), icon: 'tray', run: () => app.addAgent({ folder: '' }) });
    return items;
  }

  #backendMenu() {
    const app = this.app;
    return [
      ...app.store.backends.map((b) => ({ label: backendLabel(b), icon: 'terminal', run: () => app.quickAdd(b) })),
      null,
      { label: L('Details…'), run: () => app.openSheet({ at: app.graph.viewCenter() }) },
    ];
  }

  /** the header's gauges: one per login the open canvas uses; a click opens every login's numbers */
  #usage() {
    const s = this.app.store;
    const shown = s.canvasLogins.map((l) => [l, s.usageFor(l.key)]).filter(([, u]) => u);
    const key = JSON.stringify(shown.map(([l, u]) => [l.key, u.windows?.map((w) => w.used), u.limited]));
    if (key === this.usageKey) return;
    this.usageKey = key;
    this.usage.hidden = !shown.length;
    this.usage.replaceChildren(...shown.map(([l, u]) => {
      const g = el('span', 'usage-one', backendTile(l.login.backend, 14));
      const n = loginShort(l.login);
      if (n) g.append(el('span', 'usage-name', n.length > 14 ? n.slice(0, 13) + '…' : n));
      g.append(usageBars(u, 26));
      g.title = [loginTitle(l.login), loginDetail(l.login)].filter(Boolean).join('\n');
      return g;
    }));
  }

  /** every login's windows: name, bar, percent, when it resets; ↻ reads them all again */
  #usagePanel() {
    const existing = document.querySelector('.usage-panel');
    if (existing) {
      existing._close ? existing._close() : existing.remove();
      return;
    }
    const s = this.app.store, panel = el('div', 'usage-panel');
    const close = () => {
      panel.remove();
      document.removeEventListener('pointerdown', off, true);
    };
    panel._close = close;
    const draw = () => {
      const rows = Object.keys(s.usage).filter((k) => s.loginKey(k) === k && s.usageFor(k)).map((k) => {
        const l = s.usageLogins[k] ?? (k.startsWith('machine:') ? { backend: k.slice(8), machine: true } : (() => { const a = s.accounts.find((x) => x.id === k); return a ? { backend: a.backend, name: a.name, email: a.status?.email } : null; })());
        return l && { key: k, login: l, usage: s.usageFor(k) };
      }).filter(Boolean).sort((a, b) => a.login.backend.localeCompare(b.login.backend) || (a.login.machine ? 0 : 1) - (b.login.machine ? 0 : 1) || loginTitle(a.login).localeCompare(loginTitle(b.login)));
      const out = rows.map((r) => {
        const detail = loginDetail(r.login) || r.usage.plan || '';
        const head = el('div', 'up-head', backendTile(r.login.backend, 20), el('div', 'up-who', el('b', null, loginTitle(r.login)), detail ? el('span', null, detail) : null), el('span', 'spacer'));
        if (r.usage.limited) head.append(el('span', 'up-flag err', L('full')));
        else if (r.usage.overage) head.append(el('span', 'up-flag warn', L('Overage')));
        const box = el('div', 'up-login', head);
        for (const w of r.usage.windows ?? []) {
          const lvl = r.usage.limited && w.used >= 0.99 ? 'full' : w.used >= 0.95 ? 'full' : w.used >= 0.75 ? 'high' : 'calm';
          const color = { calm: 'var(--muted)', high: 'var(--warn)', full: 'var(--err)' }[lvl];
          const bar = el('i', 'up-bar'), fill = el('b');
          fill.style.width = Math.max(1, Math.min(1, w.used) * 100) + '%';
          fill.style.background = color;
          bar.append(fill);
          const pct = el('span', 'up-pct', `%${Math.round(w.used * 100)}`);
          if (lvl !== 'calm') pct.style.color = color;
          box.append(el('div', 'up-window', el('span', 'up-name', windowName(w.id)), bar, pct, el('span', 'up-reset', until(w.resetsAt) ? '↻ ' + until(w.resetsAt) : '')));
        }
        if (r.usage.credits?.balance != null) box.append(el('div', 'up-window', el('span', 'up-name', L('Credits')), el('span', 'spacer'), el('span', null, r.usage.credits.balance.toFixed(2))));
        return box;
      });
      if (!out.length) out.push(el('div', 'muted', '—'));
      const refresh = btn('hic', icon('arrow.clockwise', 12), async () => { refresh.disabled = true; await s.refreshUsage(true); await s.loadChoices(); draw(); }, L('Refresh'));
      panel.replaceChildren(...out, el('div', 'up-foot', el('span', 'spacer'), refresh));
    };
    draw();
    document.body.append(panel);
    const r = this.usage.getBoundingClientRect();
    Object.assign(panel.style, { left: Math.max(8, Math.min(r.left + r.width / 2 - 155, innerWidth - 318)) + 'px', top: r.bottom + 8 + 'px' });
    const off = (e) => { if (!panel.contains(e.target) && !this.usage.contains(e.target)) close(); };
    setTimeout(() => document.addEventListener('pointerdown', off, true));
    s.loadChoices().then(() => s.refreshUsage()).then(draw);
  }

  render() {
    const s = this.app.store;
    this.#usage();
    this.sidebar.classList.toggle('on', this.app.showNavigator);
    this.conn.hidden = s.connected || !s.everConnected;
    this.key.classList.toggle('disabled', !s.currentId);
  }
}

const loginShort = (l) => l.name ?? l.email?.split('@')[0] ?? null;
const loginTitle = (l) => l.name ?? l.email ?? backendLabel(l.backend);
const loginDetail = (l) => [l.email, l.plan].filter(Boolean).join(' · ');

/** a folder's name; with its parent too when another one in the list has the same name */
export function folderTitle(path, all) {
  const name = (p) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
  if (all.filter((p) => name(p) === name(path)).length < 2) return name(path);
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/');
}
