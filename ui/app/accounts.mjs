// The CLIs' logins (Welcome.swift's AccountsModel): which CLIs are here, this computer's login and the named
// accounts of each, installing a CLI, and signing in with the CLI's own sign-in in a terminal, watched until it lands.
import { api } from './api.mjs';
import { L } from './theme.mjs';
import { icon } from './icons.mjs';
import { el, btn, backendTile } from './ui.mjs';
import { AgentTerminal } from './bodies.mjs';

const order = ['claude', 'codex', 'copilot', 'antigravity', 'opencode', 'gemini', 'fake'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** how to get a CLI by hand, for when installing it from here didn't work */
export const installHints = {
  claude: ['npm install -g @anthropic-ai/claude-code', 'https://docs.anthropic.com/en/docs/claude-code'],
  codex: ['npm install -g @openai/codex', 'https://github.com/openai/codex'],
  antigravity: ['curl -fsSL https://antigravity.google/cli/install.sh | bash', 'https://antigravity.google'],
  gemini: ['npm install -g @google/gemini-cli', 'https://github.com/google-gemini/gemini-cli'],
  copilot: ['npm install -g @github/copilot', 'https://github.com/github/copilot-cli'],
  opencode: ['npm install -g opencode-ai', 'https://opencode.ai'],
};

export class AccountsModel {
  backends = [];
  accounts = [];
  machine = {};
  login = null;          // { backend, account, terminal, url, privately }
  failed = new Set();
  installing = new Set();
  problem = {};
  usage = {};
  pointed = null;
  selected = null;
  preparing = false;
  loginStarting = false;
  get choices() {
    return this.backends.filter(b => b.installed).flatMap(b => [
      ...(this.machine[b.name]?.loggedIn ? [{ id: `machine:${b.name}`, backend: b.name, account: null, label: this.machine[b.name].email ?? 'This computer' }] : []),
      // an added account signed in as the CLI's own login is that login: listed once
      ...this.accounts.filter(a => a.backend === b.name && a.dir && a.status?.loggedIn && !a.loggingIn
        && !(this.machine[b.name]?.loggedIn && this.machine[b.name].email && a.status?.email?.toLowerCase() === this.machine[b.name].email.toLowerCase())).map(a => ({ id: a.id, backend: b.name, account: a.id, label: a.status.email ?? a.name })),
    ]);
  }
  get ready() { const c = this.choices; return c.find(a => a.id === this.selected) ?? c.find(a => a.backend !== 'fake') ?? c[0] ?? null; }
  select(id) { this.selected = id; this.changed(); }
  #watchers = new Set();

  watch(fn) { this.#watchers.add(fn); return () => this.#watchers.delete(fn); }
  changed() { for (const fn of this.#watchers) fn(); }

  async load() {
    let l;
    try { l = await api.get('/v1/accounts'); } catch { return; }
    this.accounts = l.accounts ?? [];
    const rank = (b) => { const i = order.indexOf(b.name); return i < 0 ? 99 : i; };
    this.backends = (l.backends ?? []).sort((a, b) => rank(a) - rank(b));
    await Promise.all(this.backends.filter((b) => b.installed).map(async (b) => {
      try { this.machine[b.name] = await api.get(`/v1/accounts/machine/${b.name}`); } catch {}
    }));
    await this.refreshStatuses();
  }

  async refreshStatuses() {
    await Promise.all(this.accounts.filter((a) => !a.loggingIn).map(async (a) => {
      try { a.status = await api.get(`/v1/accounts/${a.id}/status`); } catch {}
    }));
    this.changed();
  }

  async loadUsage() {
    try { this.usage = Object.fromEntries(Object.entries((await api.get('/v1/usage')).usage ?? {}).filter(([, v]) => v)); this.changed(); } catch {}
    try { this.usage = Object.fromEntries(Object.entries((await api.post('/v1/usage/refresh')).usage ?? {}).filter(([, v]) => v)); this.changed(); } catch {}
  }
  usageOf(a) { return this.usage[a.dir ? a.id : `machine:${a.backend}`]; }

  #clear(b) { this.failed.delete(b); delete this.problem[b]; }
  async #attempt(b, call) {
    try { return await call(); } catch (e) { this.failed.add(b); this.problem[b] = e.message; this.changed(); return null; }
  }

  /** a name nobody uses yet: "Claude Code", then "Claude Code 2"… */
  freeName(base) {
    let name = base, n = 2;
    while (this.accounts.some((a) => a.name.toLowerCase() === name.toLowerCase())) name = `${base} ${n++}`;
    return name;
  }

  /** installs a CLI from its official package and waits until it is on this computer */
  async install(name) {
    if (this.installing.has(name)) return false;
    this.installing.add(name);
    this.#clear(name);
    this.changed();
    try {
      if (!(await this.#attempt(name, () => api.post(`/v1/accounts/backends/${name}/install`)))) return false;
      const deadline = Date.now() + 11 * 60_000;
      while (Date.now() < deadline) {
        await sleep(1000);
        let l;
        try { l = await api.get('/v1/accounts'); } catch { continue; }
        const b = l.backends.find((x) => x.name === name);
        if (!b) return false;
        if (b.installed) { await this.load(); return true; }
        if (!b.installing) { this.failed.add(name); this.problem[name] = b.installError ?? L('Could not install'); return false; }
      }
      this.failed.add(name);
      this.problem[name] = L('Could not install');
      return false;
    } finally { this.installing.delete(name); this.changed(); }
  }

  /** this computer's login of a CLI: named after the CLI, then signed in */
  async signInMachine(b) {
    if (this.login || this.preparing || this.loginStarting) return;
    this.preparing = true; this.changed();
    try {
    this.#clear(b.name);
    if (!this.backends.find((x) => x.name === b.name)?.installed && !(await this.install(b.name))) return;
    let account = this.accounts.find((a) => a.backend === b.name && !a.dir);
    account ??= await this.#attempt(b.name, () => api.post('/v1/accounts', { name: this.freeName(b.label), backend: b.name, machine: true }));
    if (account) await this.signIn(account.id, b.name);
    } finally { this.preparing = false; this.changed(); }
  }

  /** another account of a CLI, with its own config folder, signed in right away */
  async add(backend, name) {
    if (this.login || this.preparing || this.loginStarting) return;
    this.preparing = true; this.changed();
    try {
    this.#clear(backend);
    if (!this.backends.find((x) => x.name === backend)?.installed && !(await this.install(backend))) return;
    const a = await this.#attempt(backend, () => api.post('/v1/accounts', { name, backend, draft: true }));
    if (!a) return;
    this.accounts.push(a);
    this.changed();
    await this.signIn(a.id, backend, backend === 'gemini');
    await this.load();
    const now = this.accounts.find((x) => x.id === a.id), email = now?.status?.email;
    if (!now?.status?.loggedIn || !email) return;
    // the same login again: the one that exists is pointed at
    const twin = this.accounts.find((x) => x.id !== a.id && x.backend === backend && x.status?.loggedIn && x.status?.email?.toLowerCase() === email.toLowerCase())?.id
      ?? (this.machine[backend]?.loggedIn && this.machine[backend]?.email?.toLowerCase() === email.toLowerCase() ? `machine:${backend}` : null);
    if (twin) { await this.remove(a.id); this.select(twin); this.point(twin); return; }
    this.select(a.id);
    if (now.name === name && !this.accounts.some((x) => x.name.toLowerCase() === email.toLowerCase())) await this.rename(a.id, email);
    } finally { this.preparing = false; this.changed(); }
  }

  point(key) { this.pointed = key; this.changed(); setTimeout(() => { if (this.pointed === key) { this.pointed = null; this.changed(); } }, 1600); }

  async rename(id, name) {
    const b = this.accounts.find((a) => a.id === id)?.backend ?? '';
    this.#clear(b);
    await this.#attempt(b, () => api.patch(`/v1/accounts/${id}`, { name }));
    await this.load();
  }
  async remove(id) {
    const b = this.accounts.find((a) => a.id === id)?.backend ?? '';
    this.#clear(b);
    await this.#attempt(b, () => api.delete(`/v1/accounts/${id}`));
    await this.load();
  }

  /** runs an account's sign-in in a terminal and watches it until it lands */
  async signIn(id, backend, privately = false) {
    if (this.login || this.loginStarting) return;
    this.loginStarting = true;
    this.#clear(backend);
    const started = await this.#attempt(backend, () => api.post(`/v1/accounts/${id}/login`, { private: privately }));
    this.loginStarting = false;
    if (!started) return;
    const terminal = new AgentTerminal(`/term/account/${id}`, () => {});
    const login = { backend, account: id, terminal, url: null, privately };
    this.login = login;
    this.changed();
    let opened = false, misses = 0;
    while (this.login === login) {
      await sleep(1000);
      let s;
      try { s = await api.get(`/v1/accounts/${id}/login`); misses = 0; } catch (e) {
        if (e.status === 404 || ++misses >= 5) this.#finish(login, false);
        continue;
      }
      if (login.url !== s.url) { login.url = s.url; this.changed(); }
      // a private window can't be asked for from a page: the sign-in page opens in a new tab
      if (privately && !opened && s.url) { opened = true; window.open(s.url, '_blank', 'noopener'); }
      if (s.done) {
        await sleep(900);
        this.#finish(login, true);
        await this.load();
        await this.refreshStatuses();
      } else if (!s.running) this.#finish(login, false);
    }
  }

  async setKey(id, backend, key) {
    this.#clear(backend);
    if (!(await this.#attempt(backend, () => api.put(`/v1/accounts/${id}/api-key`, { key })))) return false;
    await this.load();
    await this.refreshStatuses();
    return true;
  }

  cancel() {
    const l = this.login;
    if (!l) return;
    api.delete(`/v1/accounts/${l.account}/login`).catch(() => {});
    this.#finish(l, false, true);
  }

  #finish(l, ok, quiet = false) {
    l.terminal.close();
    if (this.login === l) this.login = null;
    if (!ok && !quiet) { this.failed.add(l.backend); this.problem[l.backend] = L("Sign-in didn't finish"); }
    if (ok) this.onSignedIn?.(l.backend);
    this.changed();
  }
}

/** the CLI's own sign-in, in a terminal under its row, with the sign-in page's address and a way out */
export function loginTerminal(login, cancel) {
  const head = el('div', 'login-head', backendTile(login.backend, 16), el('span', 'ellip', L('Login — %@', login.account || login.backend)), el('span', 'spacer'));
  if (login.url) {
    const open = btn('hic', icon(login.privately ? 'eye.slash' : 'safari', 13), () => window.open(login.url, '_blank', 'noopener'), login.privately ? L('Open in a private window') : login.url);
    head.append(open);
  }
  head.append(btn('hic', icon('xmark', 11, 1.8), cancel, L('Cancel')));
  const host = el('div', 'login-term');
  host.append(login.terminal.root);
  setTimeout(() => login.terminal.focus(), 200);
  return el('div', 'login', head, host);
}
