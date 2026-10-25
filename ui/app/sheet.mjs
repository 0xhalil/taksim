// A new agent, or an agent's settings (AgentSheet.swift), without a form's clutter: the CLI as logo tiles, then
// one row per choice with an icon for its label, the rarely changed ones behind ⋯, and one action. Everything
// starts filled in: the last model, the canvas's folder, the account last used with that CLI.
import { L } from './theme.mjs';
import { api } from './api.mjs';
import { icon } from './icons.mjs';
import { el, btn, menu, sheet, float, backendTile, tooltip } from './ui.mjs';
import { effortName } from './graph.mjs';
import { backendLabel } from './store.mjs';
import { AccountsModel, loginTerminal } from './accounts.mjs';

function stored(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function keep(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }

/** 272000 → 272K, 1000000 → 1M */
export const tokens = (n) => (n >= 1e6 ? (n % 1e6 === 0 ? String(n / 1e6) : (n / 1e6).toFixed(1)) + 'M' : Math.floor(n / 1000) + 'K');

/** a CLI's usual model (the one the server picks for it) */
export function usualModel(backend, models) {
  return models.find((m) => m.owned_by === backend && ['sonnet', 'gpt-6-astra', 'opencode-go/glm-5.3', 'fake-echo'].includes(m.id))?.id
    ?? models.find((m) => m.owned_by === backend)?.id ?? '';
}

export class AgentSheet {
  constructor(app) { this.app = app; this.store = app.store; }

  /** ctx: { at, model?, cwd?, backend? } to add, { edit: id } for an agent's settings */
  async open(ctx = {}) {
    const s = this.store;
    this.ctx = ctx;
    this.editing = ctx.edit ? s.agents.get(ctx.edit) : null;
    this.error = null;
    this.busy = false;
    this.more = false;
    this.signedOut = false;
    this.machine = {};
    const a = this.editing;
    if (!s.models.length) await s.loadChoices(); else s.loadChoices().then(() => this.draw());
    if (a) {
      Object.assign(this, { name: a.name, role: a.role ?? '', model: a.model ?? '', effort: a.effort ?? null, readOnly: a.sandbox === 'read-only',
        system: a.system ?? '', cwd: a.cwd ?? '', autoApprove: !!a.autoApprove, account: a.account ?? '' });
      this.backend = s.backendOf(this.model);
      this.more = !!(this.role || this.system);
    } else {
      Object.assign(this, { name: '', role: '', system: '', autoApprove: false, readOnly: false, effort: null });
      this.model = ctx.model ?? stored('taksim.lastModel', 'sonnet');
      this.backend = ctx.backend ?? s.backendOf(this.model);
      if (ctx.backend && s.backendOf(this.model) !== ctx.backend) this.model = usualModel(ctx.backend, s.models);
      if (!s.models.some((m) => m.id === this.model)) this.model = usualModel(this.backend, s.models) || this.model;
      this.pickModel(this.model);
      // agents of one tab usually work in the same folder
      this.cwd = ctx.cwd ?? [...s.currentAgents].filter((x) => x.cwd).sort((x, y) => (y.createdAt ?? 0) - (x.createdAt ?? 0))[0]?.cwd ?? '';
      this.account = this.rememberedAccount();
    }
    this.signer?.cancel();
    this.signer = null;
    this.root = el('div', 'agent-sheet');
    this.close = sheet(this.root, { onClose: () => { this.root = null; this.signer?.cancel(); } });
    this.draw();
    this.loadBranches();
    this.checkSignIn();
    requestAnimationFrame(() => this.nameField?.focus());
  }

  get models() { return this.store.models.filter((m) => m.owned_by === this.backend); }
  get current() { return this.store.models.find((m) => m.id === this.model); }
  get accounts() { return this.store.accounts.filter((a) => a.backend === this.backend); }
  get machineNamed() { return this.accounts.some((a) => !a.dir); }
  /** the CLI's own login, named by the email it signed in with */
  get machineLogin() { return this.machine[this.backend]?.email ?? this.store.usageLogins[`machine:${this.backend}`]?.email ?? backendLabel(this.backend); }
  /** an added account signed in as the CLI's own login stands for it: that login is listed once */
  get machineTwin() {
    const e = (this.machine[this.backend]?.email ?? this.store.usageLogins[`machine:${this.backend}`]?.email)?.toLowerCase();
    return e ? this.accounts.find((a) => a.dir && a.status?.email?.toLowerCase() === e) ?? null : null;
  }

  rememberedAccount() {
    const saved = stored(`taksim.lastAccount.${this.backend}`, '');
    if (this.accounts.some((a) => a.id === saved)) return saved;
    return this.machineNamed ? (this.accounts.find((a) => !a.dir)?.id ?? '') : (this.machineTwin?.id ?? '');
  }

  /** a model, with the thinking level last used with it (if it takes that one) */
  pickModel(m) {
    this.model = m;
    const levels = this.store.models.find((x) => x.id === m)?.efforts ?? [];
    if (this.effort && levels.includes(this.effort)) return;
    const last = stored(`taksim.lastEffort.${m}`, null);
    this.effort = levels.includes(last) ? last : null;
  }

  pickBackend(b) {
    if (b === this.backend) return;
    if (this.signer?.login) { this.signer.cancel(); this.signer = null; }
    this.backend = b;
    const last = stored(`taksim.lastModel.${b}`, null);
    this.pickModel(this.models.some((m) => m.id === last) ? last : usualModel(b, this.store.models));
    this.account = this.rememberedAccount();
    this.draw();
    this.checkSignIn();
  }

  async checkSignIn() {
    const b = this.backend, acct = this.account || null;
    if (!b || b === 'local' || b === 'fake') { this.signedOut = false; return; }
    if (!(b in this.machine)) {
      this.machine[b] = null;
      api.get(`/v1/accounts/machine/${b}`).then((st) => {
        this.machine[b] = st?.loggedIn ? st : null;
        if (b === this.backend && !this.account && this.machineTwin) this.account = this.machineTwin.id;
        if (b === this.backend) this.draw();
      }).catch(() => {});
    }
    try {
      const st = await api.get(acct ? `/v1/accounts/${acct}/status` : `/v1/accounts/machine/${b}`);
      if (b === this.backend && acct === (this.account || null)) { this.signedOut = st?.loggedIn === false; this.draw(); }
    } catch {}
  }

  async loadBranches() {
    const dir = this.cwd.trim();
    this.git = null;
    if (dir) { try { this.git = await api.get(`/v1/git?dir=${encodeURIComponent(dir)}`); } catch {} }
    this.branch = this.git?.current ?? '';
    this.draw();
  }

  // ---------- drawing ----------

  draw() {
    if (!this.root) return;
    const focused = document.activeElement === this.nameField;
    this.root.replaceChildren(this.#header(), this.#body(), this.#footer());
    if (focused) this.nameField.focus();
  }

  #header() {
    this.nameField = el('input', 'sheet-name');
    this.nameField.value = this.name;
    this.nameField.placeholder = this.editing?.name ?? L('Name');
    this.nameField.setAttribute('aria-label', L('Name'));
    this.nameField.addEventListener('input', () => { this.name = this.nameField.value; });
    this.nameField.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.submit(); });
    return el('div', 'sheet-head', backendTile(this.backend || 'claude', 34), this.nameField, btn('hic', icon('xmark', 11, 1.8), () => this.close(), L('Close (Esc)')));
  }

  #body() {
    const body = el('div', 'sheet-body', this.#tiles());
    const grid = el('div', 'sheet-grid');
    const row = (symbol, label, control, tint) => {
      const l = el('span', 'label', icon(symbol, 13));
      if (tint) l.style.color = tint;
      tooltip(l, label);
      grid.append(l, control);
    };
    row('cpu', L('Model'), this.#modelWell());
    if (this.current?.efforts?.length) row('brain', L('Thinking'), this.#meter(this.current.efforts));
    if (this.backend !== 'local') row(this.signedOut ? 'person.crop.circle.badge.exclamationmark' : 'person.crop.circle', L('Account'), this.#accountWell(), this.signedOut ? 'var(--warn)' : null);
    row('folder', L('Folder'), this.#folderWell());
    if (this.git?.repo) row('arrow.triangle.branch', 'Branch', this.#branchWell());
    row('lock', L('Access'), this.#access());
    body.append(grid, this.#more());
    if (this.signer?.login && this.signer.login.backend === this.backend) {
      body.append(loginTerminal(this.signer.login, () => this.signer.cancel()));
    }
    return body;
  }

  /** the CLIs as tiles; picking one picks its usual model */
  #tiles() {
    const s = this.store;
    let list = s.backends.filter((b) => b !== 'fake' || s.backends.length === 1 || this.backend === 'fake' || location.port !== '8787');
    if (!list.includes('local')) list.splice(list.includes('fake') ? list.indexOf('fake') : list.length, 0, 'local');
    return el('div', 'cli-tiles', ...list.map((b) => {
      const t = btn('cli-tile' + (b === this.backend ? ' on' : ''), null, () => this.pickBackend(b));
      t.append(backendTile(b, 26), el('span', null, backendLabel(b)));
      return t;
    }));
  }

  #modelWell() {
    const w = btn('well', null, () => this.#modelList(w));
    if (!this.models.length && this.backend === 'local') {
      w.append(el('span', 'ellip', 'Ollama'), el('span', 'spacer'));
      w.title = L('Settings › Accounts › Local');
      w.onclick = () => { this.close(); this.app.openSettings('accounts'); };
      return w;
    }
    w.append(el('span', 'ellip', this.current?.display_name ?? (this.model || '—')));
    if (this.current?.context_window) w.append(el('span', 'dim', tokens(this.current.context_window)));
    w.append(el('span', 'spacer'), chevrons());
    return w;
  }

  /** the CLI's models under the model well: each with its name, a line about it and its context window */
  #modelList(anchor) {
    const existing = document.querySelector('.model-list');
    if (existing) {
      existing._close ? existing._close() : existing.remove();
      if (existing._anchor === anchor) return;
    }
    const list = el('div', 'model-list');
    list._anchor = anchor;
    const close = () => {
      list.remove();
      document.removeEventListener('pointerdown', off, true);
      document.removeEventListener('keydown', onKey, true);
    };
    list._close = close;

    for (const m of this.models) {
      const b = btn('model-row' + (m.id === this.model ? ' on' : ''), null, () => { close(); this.pickModel(m.id); this.draw(); });
      const chk = el('span', 'chk', m.id === this.model ? icon('checkmark', 10, 2) : null);
      const txt = el('span', 'txt', el('b', null, m.display_name ?? m.id));
      if (m.description) txt.append(el('span', null, m.description));
      b.append(chk, txt);
      if (m.efforts?.length) { const br = el('span', 'muted2', icon('brain', 10)); br.title = m.efforts.map(effortName).join(' · '); b.append(br); }
      if (m.context_window) b.append(el('span', 'ctx', tokens(m.context_window)));
      list.append(b);
    }
    float(list);
    const r = anchor.getBoundingClientRect();
    list.style.left = Math.max(8, Math.min(r.left + r.width / 2 - 190, innerWidth - 388)) + 'px';
    list.style.top = (r.bottom + 6) + 'px';
    const off = (e) => {
      if (anchor.contains(e.target)) return;
      if (!list.contains(e.target)) close();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    setTimeout(() => {
      document.addEventListener('pointerdown', off, true);
      document.addEventListener('keydown', onKey, true);
    });
  }

  /** thinking levels as a meter, lowest to highest: a bar picks it, the same bar again leaves it to the model */
  #meter(levels) {
    const shown = this.effort ?? this.current?.default_effort ?? null, at = shown ? levels.indexOf(shown) : -1;
    const bars = el('div', 'bars', ...levels.map((level, i) => {
      const b = el('button');
      b.type = 'button';
      tooltip(b, effortName(level));
      const bar = el('i');
      bar.style.height = 7 + i * 3.5 + 'px';
      if (at >= 0 && i <= at) bar.style.background = this.effort == null ? 'var(--muted)' : 'var(--accent)';
      b.append(bar);
      b.addEventListener('click', () => { this.effort = this.effort === level ? null : level; this.draw(); });
      return b;
    }));
    const label = el('span', null, shown ? effortName(shown) : L('default'));
    label.style.fontSize = '12.5px';
    label.style.color = this.effort == null ? 'var(--muted)' : 'var(--ink)';
    if (this.effort == null) label.title = L("the model's default");
    return el('div', 'meter', bars, label);
  }

  #accountWell() {
    const current = this.accounts.find((a) => a.id === this.account);
    const w = btn('well', null, () => menu(w, [
      ...(this.machineNamed || this.machineTwin ? [] : [{ label: this.machineLogin, icon: 'person.crop.circle', checked: !this.account, run: () => { this.account = ''; this.draw(); this.checkSignIn(); } }]),
      ...this.accounts.map((a) => ({ label: accountLabel(a), checked: a.id === this.account, run: () => { this.account = a.id; this.draw(); this.checkSignIn(); } })),
      null,
      { label: L('Add account'), icon: 'plus', run: () => this.addAccount() },
    ]));
    if (current) { w.append(el('span', 'ellip', current.name)); if (current.status?.email && current.status.email !== current.name) w.append(el('span', 'dim ellip', current.status.email)); }
    else w.append(el('span', 'ellip', this.machineLogin));
    w.append(el('span', 'spacer'), chevrons());
    return w;
  }

  /** the folder: click to choose, or type one */
  #folderWell() {
    const dir = this.cwd.trim();
    const w = btn('well' + (dir ? '' : ' dashed'), null, () => this.#pickFolder());
    const ic = el('span', null, icon(dir ? 'folder.fill' : 'folder.badge.plus', 13));
    ic.style.color = dir ? 'var(--accent)' : 'var(--muted)';
    w.append(ic);
    if (!dir) w.append(el('span', 'dim', '—'));
    else {
      const parts = dir.split(/[\\/]/).filter(Boolean);
      w.append(el('span', 'ellip', parts.at(-1) ?? dir), el('span', 'dim ellip head-ellip', dir.slice(0, dir.length - (parts.at(-1)?.length ?? 0)).replace(/^\/(Users|home)\/[^/]+/, '~')));
    }
    w.append(el('span', 'spacer'));
    if (dir) w.append(btn('tap', icon('xmark.circle.fill', 12), () => { this.cwd = ''; this.loadBranches(); }, L('No folder')));
    w.title = dir || L('Choose folder');
    return w;
  }

  async #pickFolder() {
    let path = null;
    try { const result = await api.post('/v1/pick-folder', { start: this.cwd || null }); if (result.canceled) return; path = result.path; } catch {}
    if (path === null && !this.typing) {
      // no folder dialog on this system: the well takes a typed path
      this.typing = true;
      const grid = this.root.querySelector('.sheet-grid'), wells = grid.querySelectorAll('.well');
      const target = [...wells].find((w) => w.title === (this.cwd || L('Choose folder')));
      const f = el('input');
      f.value = this.cwd;
      f.placeholder = '/path/to/project';
      const box = el('div', 'well', f);
      target?.replaceWith(box);
      f.focus();
      const done = () => { this.typing = false; this.cwd = f.value.trim(); this.loadBranches(); };
      f.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(); if (e.key === 'Escape') { this.typing = false; this.draw(); } });
      f.addEventListener('blur', done);
      return;
    }
    if (path) { this.cwd = path; this.loadBranches(); }
  }

  /** the branch the folder will be on: its branches to pick, or a new name; switching shows current → new */
  #branchWell() {
    const cur = this.git.current ?? '';
    const w = el('div', 'well');
    const f = el('input');
    f.value = this.branch;
    f.placeholder = cur;
    const sign = el('span', 'warn');
    const update = () => {
      const b = f.value.trim(), switching = b && b !== cur, fresh = switching && !(this.git.branches ?? []).includes(b);
      sign.replaceChildren(...(switching ? [el('span', 'muted', cur), icon('arrow.right', 9, 2), icon(fresh ? 'plus.circle.fill' : 'arrow.triangle.branch', 11)] : []));
      sign.style.display = switching ? 'inline-flex' : 'none';
      sign.style.alignItems = 'center';
      sign.style.gap = '4px';
      sign.style.fontSize = '11px';
      sign.title = fresh ? L('new branch') : 'git checkout';
    };
    f.addEventListener('input', () => { this.branch = f.value; update(); });
    f.addEventListener('keydown', (e) => e.stopPropagation());
    update();
    const list = btn('tap', null, () => menu(w, (this.git.branches ?? []).map((b) => ({ label: b, checked: b === this.branch, run: () => { this.branch = b; f.value = b; update(); } }))));
    list.append(chevrons());
    w.append(f, sign, list);
    return w;
  }

  /** two halves of one well: edits files and runs commands, or only reads */
  #access() {
    const seg = el('div', 'segmented');
    for (const [value, symbol, label] of [[false, 'pencil', L('Edits')], [true, 'eye', L('Reads')]]) {
      const b = btn(this.readOnly === value ? 'on' : '', null, () => { this.readOnly = value; this.draw(); });
      b.append(icon(symbol, 11), label);
      seg.append(b);
    }
    return seg;
  }

  /** what is rarely set: a role, extra instructions, panels running without asking */
  #more() {
    const box = el('div', 'sheet-more');
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '10px';
    const key = btn('more-key' + (this.more ? ' open' : ''), null, () => { this.more = !this.more; this.draw(); }, L('Role, instructions, auto-approve'));
    key.append(el('span', 'chev', icon('chevron.right', 9, 2.2)), icon('ellipsis', 14));
    if (!this.more && (this.role || this.system || this.autoApprove)) key.append(el('span', 'dot'));
    box.append(key);
    if (!this.more) return box;
    const grid = el('div', 'sheet-grid');
    const row = (symbol, label, control) => { const l = el('span', 'label', icon(symbol, 13)); tooltip(l, label); grid.append(l, control); };
    const role = el('input');
    role.value = this.role;
    role.placeholder = L('reviewer, writes tests…');
    role.addEventListener('input', () => { this.role = role.value; });
    role.addEventListener('keydown', (e) => e.stopPropagation());
    row('theatermasks', L('Role'), el('div', 'well', role));
    const system = el('textarea', 'well');
    system.value = this.system;
    system.addEventListener('input', () => { this.system = system.value; });
    system.addEventListener('keydown', (e) => e.stopPropagation());
    row('text.alignleft', L('Extra instructions'), system);
    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.checked = this.autoApprove;
    toggle.addEventListener('change', () => { this.autoApprove = toggle.checked; });
    row('bolt', L('Panel commands'), el('label', 'switch', toggle, L('Run without asking')));
    box.append(grid);
    return box;
  }

  #footer() {
    const foot = el('div', 'sheet-foot');
    if (this.error) foot.append(el('span', 'sheet-error', icon('exclamationmark.triangle', 12), this.error));
    foot.append(el('span', 'spacer'));
    const key = btn('sheet-key', null, () => (this.signedOut ? this.signIn() : this.submit()));
    if (this.signedOut) key.append(backendTile(this.backend, 16), L('Sign in'));
    else key.append(this.editing ? L('Save') : L('Create'));
    key.disabled = this.busy || !this.model;
    foot.append(key);
    return foot;
  }

  async addAccount() {
    this.signer ??= new AccountsModel();
    const s = this.signer;
    s.watch(() => this.draw());
    if (!s.backends.length) await s.load();
    const b = this.backend;
    const beforeIds = new Set(this.accounts.map((a) => a.id));
    await s.add(b, s.freeName(backendLabel(b)));
    await this.store.loadChoices();
    const added = this.accounts.find((a) => !beforeIds.has(a.id));
    if (added) this.account = added.id;
    else if (!this.account) this.account = this.rememberedAccount();
    this.draw();
    this.checkSignIn();
  }

  /** signed out: sign in with the CLI's own terminal or browser sign-in right here in the sheet, then create */
  async signIn() {
    this.signer ??= new AccountsModel();
    const s = this.signer;
    s.watch(() => this.draw());
    if (!s.backends.length) await s.load();
    const b = this.backend;
    if (!this.account) {
      const cli = s.backends.find((x) => x.name === b);
      if (cli) await s.signInMachine(cli);
    } else {
      if (!s.backends.find((x) => x.name === b)?.installed && !(await s.install(b))) return;
      await s.signIn(this.account, b);
    }
    await this.store.loadChoices();
    if (!this.account) this.account = this.rememberedAccount();
    await this.checkSignIn();
    if (s.problem[b]) this.error = s.problem[b];
    if (!this.signedOut) await this.submit();
  }

  async submit() {
    if (this.busy || !this.model) return;
    this.busy = true;
    this.error = null;
    this.draw();
    const s = this.store, dir = this.cwd.trim(), b = (this.branch ?? '').trim();
    const fields = { role: this.role, model: this.model, system: this.system, autoApprove: this.autoApprove, effort: this.effort ?? null,
      account: this.account || null, sandbox: this.readOnly ? 'read-only' : null, cwd: dir || null };
    if (this.name.trim()) fields.name = this.name.trim();
    let switchedFrom = null;
    try {
      // another branch picked: switch the folder first, as `git switch` would; back again if the agent then fails
      if (this.git?.current && b && b !== this.git.current) { await api.post('/v1/git/checkout', { dir, branch: b }); switchedFrom = this.git.current; }
      keep(`taksim.lastAccount.${this.backend}`, this.account);
      keep(`taksim.lastModel.${this.backend}`, this.model);
      keep(`taksim.lastEffort.${this.model}`, this.effort);
      if (this.editing) { await s.updateAgent(this.editing.id, fields); this.close(); }
      else {
        keep('taksim.lastModel', this.model);
        const at = this.ctx.at ?? this.app.graph.viewCenter();
        fields.pos = [Math.round(at.x), Math.round(at.y)];
        for (const k of ['account', 'sandbox', 'cwd', 'effort']) if (fields[k] == null) delete fields[k];
        const a = await s.addAgent(fields);
        this.close();
        this.app.agentAdded(a);
      }
    } catch (e) {
      this.error = e.message;
      if (switchedFrom) api.post('/v1/git/checkout', { dir, branch: switchedFrom }).catch(() => {});
    }
    this.busy = false;
    this.draw();
  }
}

/** an added account: its name, and the email it signed in with when that says more */
function accountLabel(a) { const e = a.status?.email; return a.name + (e && e !== a.name ? ` · ${e}` : ''); }

function chevrons() {
  const c = icon('chevron.up.chevron.down', 10);
  c.style.color = 'var(--muted)';
  return c;
}
