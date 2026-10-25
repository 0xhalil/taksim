// Settings (SettingsView.swift), laid out as Cursor's: a searchable list of sections on the left; on the right the
// section under its heading, as groups of rows, each one setting with its one control. Everything applies at once.
import { L, lang, setLanguage, themes, choice, setTheme, hex, onTheme } from './theme.mjs';
import { api } from './api.mjs';
import { icon } from './icons.mjs';
import { el, btn, menu, sheet, backendTile, toast } from './ui.mjs';
import { canvasText, showGrid } from './graph.mjs';
import { backendLabel } from './store.mjs';
import { AccountsModel, installHints, loginTerminal } from './accounts.mjs';
import { copyText } from './chat/markdown.mjs';

function stored(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function keep(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }

const sections = [
  ['general', 'General', 'gearshape', ['notification', 'bildirim', 'sound', 'ses', 'delete', 'sil', 'language', 'dil', 'english', 'türkçe', 'ızgara', 'tuval', 'grid', 'canvas', 'yazı', 'text size']],
  ['appearance', 'Appearance', 'paintbrush', ['tema', 'theme', 'darcula', 'koyu', 'açık', 'kontrast', 'dark', 'light', 'contrast']],
  ['accounts', 'Accounts', 'person.2', ['hesap', 'giriş', 'login', 'e-posta', 'ajan', 'agent', 'claude', 'codex', 'copilot', 'github', 'opencode', 'gemini', 'antigravity', 'google', 'cli', 'kurulu', 'installed', 'local', 'ollama']],
  ['plugins', 'Plugins', 'puzzlepiece', ['araç', 'tool', 'market', 'eklenti', 'plugin', 'extension', 'yüklü']],
  ['connections', 'Connections', 'globe', ['slack', 'github', 'token', 'bağlantı', 'servis', 'veri']],
  ['keymap', 'Keyboard shortcuts', 'key', ['kısayol', 'keymap', 'tuş', 'klavye']],
];
export const settingsSections = sections.map(([id, title, symbol, keywords]) => ({ id, get title() { return L(title); }, symbol, keywords }));

/** a group: a small name, then a card whose rows are parted by hairlines */
function group(title, ...rows) {
  const card = el('div', 'set-card', ...rows.filter(Boolean));
  return el('div', 'set-group', title ? el('div', 'set-group-title', title) : null, card);
}
/** one setting: its name, a line saying what it does, its one control on the right */
function row(title, detail, control, lead) {
  return el('div', 'set-row', lead ?? null, el('div', 'set-row-text', el('div', 'set-row-title', title), detail ? el('div', 'set-row-detail', detail) : null), el('span', 'spacer'), control ?? null);
}
function quietButton(title, run, cls = '') { const b = btn('set-button ' + cls, null, run); b.append(title); return b; }
function toggle(on, change) {
  const t = el('input');
  t.type = 'checkbox';
  t.checked = on;
  t.addEventListener('change', () => change(t.checked));
  return el('label', 'switch', t);
}
function avatar(name, size = 28) {
  let n = 7;
  for (const c of name) n = (n * 31 + c.codePointAt(0)) % 360;
  const a = el('span', 'avatar', [...name][0]?.toLocaleUpperCase('tr') ?? '?');
  Object.assign(a.style, { width: size + 'px', height: size + 'px', background: `hsl(${n} 40% 55%)` });
  return a;
}

export class Settings {
  section = 'general';
  query = '';
  data = { tools: [], market: [], accounts: [] };

  constructor(app) { this.app = app; }

  open(section, opts = {}) {
    if (section) this.section = section;
    this.opts = opts;
    if (this.root) { this.draw(); return; }
    this.root = el('div', 'settings');
    this.close = sheet(this.root, { width: 900, onClose: () => { this.root = null; this.accounts?.cancel(); this.accounts = null; this.untheme?.(); clearTimeout(this.localTimer); } });
    this.root.closest('dialog').classList.add('settings-sheet');
    this.untheme = onTheme(() => this.draw());
    this.load();
    this.draw();
  }

  async load() {
    const [t, m, a] = await Promise.all([api.get('/v1/toolbox').catch(() => null), api.get('/v1/market').catch(() => null), api.get('/v1/accounts').catch(() => null)]);
    if (t) this.data.tools = t.tools ?? [];
    if (m) this.data.market = m.tools ?? [];
    if (a) this.data.accounts = a.accounts ?? [];
    this.drawSidebar();
    if (this.section === 'plugins') this.draw();
  }

  get matches() {
    const q = this.query.trim().toLocaleLowerCase('tr');
    return q ? settingsSections.filter((s) => [s.title, ...s.keywords].some((k) => k.toLocaleLowerCase('tr').includes(q))) : settingsSections;
  }

  draw() {
    if (!this.root) return;
    this.sidebar ??= el('div', 'set-sidebar');
    this.drawSidebar();
    const s = settingsSections.find((x) => x.id === this.section);
    const pane = el('div', 'set-pane', el('h1', null, s.title));
    const body = el('div', 'set-body');
    pane.append(body);
    ({ general: () => this.#general(body), appearance: () => this.#appearance(body), accounts: () => this.#accounts(body), plugins: () => this.#plugins(body),
      connections: () => this.#connections(body), keymap: () => this.#keymap(body) })[this.section]();
    this.root.replaceChildren(this.sidebar, pane);
  }

  drawSidebar() {
    if (!this.sidebar) return;
    const search = this.searchField ??= (() => {
      const f = el('input');
      f.placeholder = L('Search');
      f.addEventListener('input', () => {
        this.query = f.value;
        const m = this.matches;
        if (m.length && !m.some((x) => x.id === this.section)) { this.section = m[0].id; this.draw(); } else this.drawSidebar();
      });
      f.addEventListener('keydown', (e) => e.stopPropagation());
      return f;
    })();
    const badge = (id) => (id === 'plugins' ? this.data.tools.length : id === 'accounts' ? this.data.accounts.length : 0) || null;
    this.sidebar.replaceChildren(el('label', 'set-search', icon('magnifyingglass', 12), search),
      ...this.matches.map((s) => {
        const b = btn('set-nav' + (s.id === this.section ? ' on' : ''), null, () => { this.section = s.id; this.draw(); });
        b.append(icon(s.symbol, 14), el('span', null, s.title), el('span', 'spacer'));
        if (badge(s.id)) b.append(el('span', 'n', String(badge(s.id))));
        return b;
      }));
  }

  // ---------- General ----------

  #general(body) {
    const language = el('select', 'set-select');
    for (const [v, label] of [['en', 'English'], ['tr', 'Türkçe']]) { const o = el('option', null, label); o.value = v; language.append(o); }
    language.value = lang;
    language.addEventListener('change', () => { setLanguage(language.value); this.app.render(); this.draw(); });
    const size = el('input', 'set-slider');
    Object.assign(size, { type: 'range', min: 0.75, max: 1.5, step: 0.05, value: canvasText.size });
    const pct = el('span', 'set-pct', `${Math.round(canvasText.size * 100)}%`);
    size.addEventListener('input', () => { canvasText.size = Number(size.value); pct.textContent = `${Math.round(size.value * 100)}%`; this.app.graph.widths?.clear(); this.app.graph.kick(); });
    const n = (key, fallback = true) => toggle(stored(`taksim.notify.${key}`, fallback), (v) => keep(`taksim.notify.${key}`, v));
    body.append(
      group(L('Preferences'),
        row(L('Language'), L('The language of the app; agents are always written to in English'), language),
        row(L('Keyboard shortcuts'), L('See every shortcut'), quietButton(L('Open'), () => { this.section = 'keymap'; this.draw(); })),
        row(L('Theme'), L('Dark, light, Darcula or high contrast'), quietButton(L('Open'), () => { this.section = 'appearance'; this.draw(); }))),
      group(L('Canvas'),
        row(L('Dot grid'), L('Show the dots behind the nodes'), toggle(showGrid.on, (v) => { showGrid.on = v; this.app.graph.kick(); })),
        row(L('Text size'), L('Base size for canvas text; zooms with everything'), el('span', 'set-inline', size, pct))),
      group(L('Notifications'),
        row(L('Agent finished'), L('When the app is in the background'), n('done')),
        row(L('Needs approval'), L('A tool waits for you'), n('approval')),
        row(L('Failed'), L('A turn ended with an error'), n('failed')),
        row(L('Sound'), L('Play a sound with approvals and errors'), n('sound'))),
      group(L('Reset'),
        row(L('Start over'), L('Canvases, accounts, connections and tools go; the app opens as when first installed'), quietButton(L('Reset'), () => this.#startOver(), 'danger'))),
    );
  }

  async #startOver() {
    if (!confirm(`${L('Start over?')}\n\n${L('Every canvas and conversation, every account and connection, and your own tools are deleted. This cannot be undone.')}`)) return;
    try { await api.post('/v1/reset', {}); } catch (e) { toast(L('Could not reset: %@', e.message), { error: true }); return; }
    try { for (const k of Object.keys(localStorage)) if (k.startsWith('taksim.')) localStorage.removeItem(k); } catch {}
    location.href = '/app';
  }

  // ---------- Appearance ----------

  #appearance(body) {
    const grid = el('div', 'theme-grid');
    for (const [id, label] of themes) {
      const card = btn('theme-card' + (choice === id ? ' on' : ''), null, () => { setTheme(id); this.draw(); });
      const preview = el('div', 'theme-preview');
      if (id === 'system') preview.append(themePreview('light'), themePreview('dark'));
      else preview.append(themePreview(id));
      const name = el('span', 'theme-name', id === 'system' ? L('System') : id === 'contrast' ? L('High Contrast') : label);
      if (choice === id) name.append(icon('checkmark', 10, 2.2));
      card.append(preview, name);
      grid.append(card);
    }
    body.append(el('div', 'set-group', el('div', 'set-group-title', L('Theme')), grid));
  }

  // ---------- Accounts ----------

  #accounts(body) {
    if (!this.accounts) {
      const m = this.accounts = new AccountsModel();
      m.watch(() => { if (this.section === 'accounts' && this.root) this.draw(); });
      m.onSignedIn = () => { this.load(); this.app.store.loadChoices(); };
      m.load().then(async () => {
        await m.refreshStatuses();
        await m.loadUsage();
        this.#handleOpts();
      });
    } else {
      this.#handleOpts();
    }
    const m = this.accounts;
    if (!m.backends.length) { body.append(el('div', 'set-loading', '…')); return; }
    for (const b of m.backends.filter((x) => x.name !== 'fake' || location.port !== '8787')) body.append(this.#cli(b));
    body.append(this.#local());
  }

  #handleOpts() {
    const m = this.accounts;
    if (!m) return;
    if (this.opts?.add) {
      const b = this.opts.add;
      this.opts.add = null;
      m.add(b, m.freeName(backendLabel(b)));
    }
    if (this.opts?.signIn) {
      const b = m.backends.find((x) => x.name === this.opts.signIn), acct = this.opts.account;
      this.opts.signIn = null;
      if (acct) m.signIn(acct, b?.name);
      else if (b) m.signInMachine(b);
    }
  }

  /** one CLI: its mark and name, this computer's login and its named accounts as rows, + to add another */
  #cli(b) {
    const m = this.accounts, installed = !!b.installed;
    const head = el('div', 'cli-head', backendTile(b.name, 18), el('b', null, b.label));
    if (!installed) head.classList.add('off');
    if (m.installing.has(b.name)) head.append(el('span', 'spin'));
    else if (!installed) {
      const get = btn('tap', icon('arrow.down.circle', 14), () => m.signInMachine(b), m.problem[b.name] ?? L('Install and sign in'));
      get.style.color = m.failed.has(b.name) ? 'var(--err)' : 'var(--accent)';
      get.disabled = !!m.login;
      head.append(get);
    }
    head.append(el('i'));
    const box = el('div', 'set-group', head);
    if (!installed) {
      if (m.failed.has(b.name) && installHints[b.name]) box.append(el('div', 'set-card', this.#installHelp(b)));
      return box;
    }
    const list = m.accounts.filter((a) => a.backend === b.name).sort((x, y) => (x.dir ? 1 : 0) - (y.dir ? 1 : 0) || x.name.localeCompare(y.name));
    const card = el('div', 'set-card');
    if (!list.some((a) => !a.dir)) {
      const st = m.machine[b.name], name = st?.email ?? b.label;
      card.append(this.#accountRow({ name, status: st, usage: m.usage[`machine:${b.name}`], loggingIn: m.login?.backend === b.name && !list.some((a) => a.id === m.login?.account),
        signIn: () => m.signInMachine(b), items: [{ label: L('Sign in again'), run: () => m.signInMachine(b) }], pointKey: `machine:${b.name}` }));
    }
    for (const a of list) {
      const own = b.name === 'gemini' && a.dir;
      card.append(this.#accountRow({ name: a.name, id: a.id, status: a.status ?? (!a.dir ? m.machine[b.name] : null), usage: m.usageOf(a), loggingIn: m.login?.account === a.id,
        signIn: () => m.signIn(a.id, b.name, own), key: own ? () => this.#keyRow(a, b, card) : null, pointKey: a.id,
        items: [
          { label: L('Sign in again'), run: () => m.signIn(a.id, b.name, own) },
          ...(own ? [{ label: L('API key'), run: () => this.#keyRow(a, b, card) }] : []),
          { label: L('Rename'), run: () => this.#rename(a) },
          null,
          { label: a.dir ? L('Delete') : L('Remove name'), danger: true, disabled: m.login?.account === a.id, run: () => {
            if (a.dir && !confirm(L('Delete "%@"?', a.name))) return;
            m.remove(a.id);
          } },
        ] }));
    }
    if (m.installing.has(b.name)) card.append(el('div', 'acct-row', el('span', 'spin'), el('span', 'muted', L('Installing'))));
    else if (b.named !== false) {
      const add = btn('acct-row add', null, () => m.add(b.name, m.freeName(b.label)));
      add.append(el('span', 'avatar dashed', icon('plus', 11, 2)), el('span', null, L('Add account')));
      add.disabled = !!m.login;
      card.append(add);
    }
    box.append(card);
    if (m.problem[b.name]) box.append(el('div', 'set-problem', icon('exclamationmark.triangle', 11), m.problem[b.name]));
    if (m.login?.backend === b.name) box.append(loginTerminal(m.login, () => m.cancel()));
    return box;
  }

  /** avatar, name (double-click renames), who is signed in; the one action needed; the rest under ⋯ */
  #accountRow({ name, id, status, usage, loggingIn, signIn, key, items, pointKey }) {
    const m = this.accounts;
    const dot = el('i', 'dot');
    dot.style.background = loggingIn ? 'var(--wait)' : !status ? 'var(--muted2)' : status.loggedIn ? 'var(--ok)' : 'var(--err)';
    const line = loggingIn ? L('Signing in') : !status ? '' : status.loggedIn
      ? ([status.email === name ? null : status.email, status.plan].filter(Boolean).join(' · ') || L('Signed in')) : L('Sign-in required');
    const title = el('div', 'acct-name', name);
    if (id) title.addEventListener('dblclick', () => this.#rename(m.accounts.find((a) => a.id === id)));
    const row = el('div', 'acct-row' + (m.pointed === pointKey ? ' pointed' : ''), avatar(name), el('div', 'acct-text', title, el('div', 'acct-status', dot, el('span', null, line))), el('span', 'spacer'));
    if (usage && status?.loggedIn) row.append(usageBars(usage, 54));
    if (!loggingIn && status && !status.loggedIn && key) row.append(btn('tap', icon('key', 12), key, L('Sign in with an API key')));
    if (!loggingIn && status && !status.loggedIn) {
      const s = btn('pill-key', null, signIn);
      s.append(L('Sign in'));
      s.disabled = !!m.login;
      row.append(s);
    }
    if (items && id) { const more = btn('tap more', icon('ellipsis', 14), () => menu(more, items), L('More')); row.append(more); }
    if (items) row.addEventListener('contextmenu', (e) => { e.preventDefault(); menu({ x: e.clientX, y: e.clientY }, items); });
    return row;
  }

  #rename(a) {
    if (!a) return;
    const name = prompt(L('Rename'), a.name);
    if (name?.trim() && name.trim() !== a.name) this.accounts.rename(a.id, name.trim());
  }

  /** the API key, pasted once; Enter checks it with Google and keeps it in the keychain */
  #keyRow(a, b, card) {
    card.querySelector('.key-row')?.remove();
    const f = el('input');
    f.type = 'password';
    f.placeholder = 'AIza… (Google AI Studio)';
    const save = async () => { const k = f.value.trim(); if (k && await this.accounts.setKey(a.id, b.name, k)) keyRow.remove(); };
    f.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') save(); if (e.key === 'Escape') keyRow.remove(); });
    const keyRow = el('div', 'key-row', f, btn('tap', icon('info.circle', 13), () => window.open('https://aistudio.google.com/apikey', '_blank', 'noopener'), L('Where to get a key')), btn('pill-key', '⏎', save));
    card.append(keyRow);
    f.focus();
  }

  #installHelp(b) {
    const [command, url] = installHints[b.name];
    const r = el('div', 'acct-row install', el('span', 'warn', icon('exclamationmark.triangle', 14)), el('div', 'acct-text', el('code', 'selectable', command), this.accounts.problem[b.name] ? el('div', 'acct-status', this.accounts.problem[b.name]) : null), el('span', 'spacer'),
      btn('tap', icon('doc.on.doc', 12), () => copyText(command), L('Copy')), btn('tap', icon('arrow.up.right', 12), () => window.open(url, '_blank', 'noopener'), url),
      btn('tap', icon('arrow.clockwise', 12), () => this.accounts.install(b.name), L('Try again')));
    return r;
  }

  /** Settings › Accounts › Local: the model servers on this computer with their models; servers added by hand */
  #local() {
    const box = el('div', 'set-group');
    const head = el('div', 'cli-head', backendTile('local', 18), el('b', null, L('Local')));
    const card = el('div', 'set-card', el('div', 'acct-row', el('span', 'spin')));
    box.append(head, card);
    const draw = (st) => {
      if (st.memoryGB) { head.querySelector('.mem')?.remove(); const mem = el('span', 'mem muted2', `${st.memoryGB} GB`); mem.title = L('Memory'); head.append(mem); }
      if (!head.querySelector('i')) head.append(el('i'));
      const rows = [];
      const step = !st.models?.length ? (st.install?.running || st.start?.running || st.pull?.running ? 'busy' : !st.ollama.installed ? (st.canInstall ? 'install' : 'download') : !st.ollama.running ? 'start' : 'pull') : 'ready';
      if (step !== 'ready') {
        const r = el('div', 'acct-row', el('span', 'avatar plain', icon('arrow.down.circle', 16)), el('div', 'acct-text', el('div', 'acct-name', st.pull?.model ?? st.recommended.model), el('div', 'acct-status', `${st.recommended.gb.toFixed(1)} GB`)), el('span', 'spacer'));
        const f = st.pull?.total ? Math.min(1, (st.pull.completed ?? 0) / st.pull.total) : null;
        if (f != null && st.pull?.running) { const p = el('progress'); p.max = 1; p.value = f; r.append(p, el('span', 'set-pct', `${Math.round(f * 100)}%`)); }
        else if (step === 'busy') r.append(el('span', 'spin'));
        else {
          const k = btn('pill-key', null, async () => {
            try {
              if (step === 'install') await api.post('/v1/local/install');
              else if (step === 'download') window.open('https://ollama.com/download', '_blank', 'noopener');
              else if (step === 'start') await api.post('/v1/local/start');
              else await api.post('/v1/local/pull', { model: st.recommended.model });
            } catch (e) { toast(e.message, { error: true }); }
            refresh();
          });
          k.append({ install: L('Install Ollama'), download: L('Get Ollama'), start: L('Start Ollama') }[step] ?? L('Download'));
          r.append(k);
        }
        rows.push(r);
      }
      for (const s of st.servers ?? []) {
        const u = (() => { try { return new URL(s.url); } catch { return null; } })();
        const known = u && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ? { 11434: 'Ollama', 1234: 'LM Studio', 8080: 'llama.cpp', 8000: 'vLLM', 1337: 'Jan' }[u.port] : null;
        const dot = el('i', 'dot');
        dot.style.background = s.running ? 'var(--ok)' : 'var(--muted2)';
        const sr = el('div', 'acct-row', el('span', 'avatar plain', icon('cpu', 15)), el('div', 'acct-text', el('div', 'acct-name', known ?? (u ? u.host : s.url)),
          el('div', 'acct-status', dot, el('span', null, s.running ? (s.models.length === 1 ? L('1 model') : L('%d models', s.models.length)) : L('Not running')))), el('span', 'spacer'));
        sr.title = s.url;
        if (!s.builtIn) { const more = btn('tap more', icon('ellipsis', 14), () => menu(more, [{ label: L('Remove'), danger: true, run: async () => { await api.post('/v1/local/servers/remove', { url: s.url }).catch(() => {}); refresh(); } }])); sr.append(more); }
        rows.push(sr);
        for (const md of s.models) {
          const facts = [md.sizeGB != null ? `${md.sizeGB.toFixed(1)} GB` : null, md.params, (md.window ?? md.max) ? `${(md.window ?? md.max) >= 1000 ? Math.round((md.window ?? md.max) / 1000) + 'K' : md.window ?? md.max} ctx` : null].filter(Boolean);
          const mr = el('div', 'acct-row model', el('span', 'avatar plain'), el('div', 'acct-text', el('div', 'acct-name small', md.id), facts.length ? el('div', 'acct-status', facts.join(' · ')) : null), el('span', 'spacer'));
          if (md.tools != null) { const w = el('span', null, icon('wand.and.stars', 11)); w.style.color = md.tools ? 'var(--accent)' : 'var(--muted2)'; w.title = md.tools ? L('Edits files and runs commands') : L('Chat only'); mr.append(w); }
          if (s.kind === 'ollama') { const more = btn('tap more', icon('ellipsis', 14), () => menu(more, [{ label: L('Delete'), danger: true, run: async () => { try { await api.post('/v1/local/delete', { model: md.id }); } catch (e) { toast(e.message, { error: true }); } refresh(); } }])); mr.append(more); }
          rows.push(mr);
        }
      }
      const add = btn('acct-row add', null, () => {
        const f = el('input', 'mono');
        f.value = 'http://127.0.0.1:8080';
        const r = el('div', 'acct-row', el('span', 'avatar plain accent', icon('plus', 11, 2)), f);
        add.replaceWith(r);
        f.focus(); f.select();
        f.addEventListener('keydown', async (e) => {
          e.stopPropagation();
          if (e.key === 'Escape') refresh();
          if (e.key !== 'Enter') return;
          try { await api.post('/v1/local/servers', { url: f.value.trim() }); } catch (err) { toast(err.message, { error: true }); }
          refresh();
        });
      });
      add.append(el('span', 'avatar dashed', icon('plus', 11, 2)), el('span', null, L('Add server')));
      rows.push(add);
      card.replaceChildren(...rows);
      box.querySelector('.set-problem')?.remove();
      const problem = st.pull?.error ?? st.start?.error ?? st.install?.error;
      if (problem) box.append(el('div', 'set-problem', icon('exclamationmark.triangle', 11), problem));
      clearTimeout(this.localTimer);
      this.localTimer = setTimeout(refresh, step === 'busy' ? 700 : 4000);
    };
    const refresh = async () => { if (!box.isConnected && this.root) return; try { draw(await api.get('/v1/local')); } catch {} };
    refresh();
    return box;
  }

  // ---------- Plugins ----------

  #plugins(body) {
    this.pluginTab ??= 'market';
    const tab = this.pluginTab, all = tab === 'market' ? this.data.market : this.data.tools;
    const q = (this.pluginQuery ?? '').trim().toLocaleLowerCase('tr');
    const list = q ? all.filter((t) => [t.name, t.summary ?? '', t.id, ...(t.keywords ?? [])].join(' ').toLocaleLowerCase('tr').includes(q)) : all;
    const key = (t) => `${t.shelf ?? ''}/${t.author ?? ''}/${t.id}`;
    const current = list.find((t) => key(t) === this.pluginSelected) ?? list[0];
    const tabs = el('div', 'plug-tabs');
    for (const [id, label, n] of [['market', 'Market', this.data.market.length], ['installed', L('Installed'), this.data.tools.length]]) {
      const b = btn('plug-tab' + (tab === id ? ' on' : ''), null, () => { this.pluginTab = id; this.pluginSelected = null; this.draw(); });
      b.append(label, el('span', 'muted', String(n)));
      tabs.append(b);
    }
    const search = el('input');
    search.placeholder = L('Search');
    search.value = this.pluginQuery ?? '';
    search.addEventListener('input', () => { this.pluginQuery = search.value; const pos = search.selectionStart; this.draw(); const f = this.root.querySelector('.plug-search input'); f.focus(); f.setSelectionRange(pos, pos); });
    search.addEventListener('keydown', (e) => e.stopPropagation());
    tabs.append(el('span', 'spacer'), el('label', 'plug-search', icon('magnifyingglass', 11), search));
    const rows = el('div', 'plug-list', ...list.map((t) => {
      const b = btn('plug-row' + (current && key(t) === key(current) ? ' on' : ''), null, () => { this.pluginSelected = key(t); this.draw(); });
      const text = el('span', 'plug-text', el('b', null, t.name));
      if (t.summary && t.summary !== t.name) text.append(el('span', null, t.summary));
      b.append(toolTile(t, 30), text, el('span', 'spacer'));
      if (tab === 'market' && t.shelf === 'github' && t.author) b.append(el('span', 'muted small', '@' + t.author));
      b.append(this.#toolAction(t, true));
      return b;
    }));
    const detail = el('div', 'plug-detail');
    if (current) {
      const meta = el('div', 'plug-meta');
      if (current.author) meta.append(el('span', null, icon('person', 10), current.author));
      if (current.version) meta.append(el('span', null, `v${current.version}`));
      if (current.uses) meta.append(el('span', null, icon('arrow.clockwise', 10), String(current.uses)));
      if (current.shelfLabel) meta.append(el('span', null, icon('square.stack.3d.up', 10), current.shelfLabel));
      detail.append(el('div', 'plug-head', toolTile(current, 52), el('div', null, el('h2', null, current.name), meta), el('span', 'spacer'), this.#toolAction(current, false)));
      if (current.summary && current.summary !== current.name) detail.append(el('p', null, current.summary));
      if (current.available?.missing?.length) detail.append(el('div', 'plug-missing', icon('exclamationmark.triangle', 12), el('code', null, current.available.missing.join(', '))));
      if (current.runs?.length) detail.append(el('div', 'plug-runs', ...current.runs.map((r) => el('div', null, icon('chevron.right', 9, 2.4), el('code', 'selectable', r)))));
    } else detail.append(el('div', 'plug-empty', icon('puzzlepiece', 34, 1.2)));
    body.classList.add('flush');
    body.append(tabs, el('div', 'plug-split', el('div', 'plug-col', rows), detail));
  }

  #toolAction(t, compact) {
    if (this.pluginTab === 'market') {
      if (t.installed) { const c = el('span', 'plug-ok', icon('checkmark', 11, 2.2)); c.style.width = compact ? '22px' : '70px'; return c; }
      const b = btn('pill-key square', null, async (e) => {
        e.stopPropagation();
        b.disabled = true;
        await api.post('/v1/market/install', { shelf: t.shelf ?? 'local', id: t.id, ...(t.author && t.shelf === 'github' ? { by: t.author } : {}) }).catch((err) => toast(err.message, { error: true }));
        await this.load();
        this.draw();
      });
      b.append(L('Install'));
      return b;
    }
    if (t.builtin) return el('span');
    return btn('tap', icon('trash', 12), async (e) => { e.stopPropagation(); await api.delete(`/v1/toolbox/${t.id}`).catch(() => {}); await this.load(); this.draw(); }, L('Remove'));
  }

  // ---------- Connections ----------

  async #connections(body) {
    const card = el('div', 'set-card');
    body.append(card);
    let list = [];
    try { list = (await api.get('/v1/connections')).connections ?? []; } catch {}
    const marks = { slack: ['#4a154b', 'bubble.left'], github: ['#24292f', 'chevron.left.forwardslash.chevron.right'], linear: ['#5e6ad2', 'circle.fill'], jira: ['#0052cc', 'square.stack.3d.up'] };
    card.replaceChildren(...list.map((c) => {
      const [color, sym] = marks[c.id] ?? ['var(--panel2)', 'globe'];
      const mark = el('span', 'service', icon(sym, 13, 2));
      mark.style.background = color;
      if (!c.connected) mark.style.filter = 'saturate(.2)';
      const text = el('div', 'acct-text', el('div', 'acct-name', c.label));
      if (c.connected) { const dot = el('i', 'dot'); dot.style.background = 'var(--ok)'; text.append(el('div', 'acct-status', dot, el('span', null, c.who ?? L('connected')))); }
      const top = el('div', 'acct-row', mark, text, el('span', 'spacer'));
      const box = el('div', 'conn', top);
      const tokenRow = () => {
        const f = el('input');
        f.type = 'password';
        f.placeholder = c.tokenHint ?? 'token';
        const save = async () => {
          const t = f.value.trim();
          if (!t) return;
          key.disabled = true;
          try { await api.put(`/v1/connections/${c.id}`, { token: t }); this.draw(); }
          catch (e) { problem.textContent = e.message; problem.hidden = false; f.classList.add('bad'); key.disabled = false; }
        };
        f.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') save(); });
        const key = btn('pill-key', null, save);
        key.append(L('Connect'));
        const problem = el('div', 'set-problem');
        problem.hidden = true;
        const r = el('div', 'token-row', f);
        if (c.tokenHelp) r.append(btn('tap', icon('info.circle', 13), () => window.open(c.tokenHelp, '_blank', 'noopener'), L('Where to get the token')));
        r.append(key);
        box.append(r, problem);
        f.focus();
      };
      if (c.connected) {
        const more = btn('tap more', icon('ellipsis', 14), () => menu(more, [
          { label: L('Replace token'), run: tokenRow }, null,
          { label: L('Remove connection'), danger: true, run: async () => { await api.delete(`/v1/connections/${c.id}`).catch(() => {}); this.draw(); } },
        ]));
        top.append(more);
      } else setTimeout(() => { if (!box.querySelector('.token-row')) tokenRow(); document.activeElement?.blur(); });
      return box;
    }));
  }

  // ---------- Shortcuts ----------

  #keymap(body) {
    const mod = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl';
    const caps = (keys) => el('span', 'caps', ...keys.map((k) => el('kbd', null, k)));
    const canvas = [[L('Command palette'), [mod, 'K']], [L('New canvas'), [mod, 'T']], [L('Show all'), [mod, '0']], [L('Tab 1–9'), [mod, '1…9']],
      [L('Sidebar'), [mod, '⇧', 'A']], [L('Group'), [mod, 'G']], [L('Select'), [mod, L('drag')]], [L('Zoom'), [mod, L('scroll')]], [L('Delete'), ['⌫']], [L('Settings'), [mod, ',']]];
    const chat = [[L('Send'), ['⏎']], [L('New line'), ['⇧', '⏎']], [L('Switch Agent / Ask / Plan'), ['⇧', '⇥']], [L('Search in chat'), [mod, 'F']]];
    body.append(group(L('Canvas'), ...canvas.map(([t, k]) => row(t, null, caps(k)))), group(L('Chat'), ...chat.map(([t, k]) => row(t, null, caps(k)))));
  }
}

/** a theme drawn as a small window of itself: header, tab, a card on the canvas, the accent */
function themePreview(t) {
  const dark = t !== 'light';
  const map = { darcula: { 0x1E1F22: 0x2B2B2B, 0x2B2D30: 0x3C3F41, 0x323438: 0x45494A, 0x43454A: 0x555555, 0xBCBEC4: 0xA9B7C6, 0x868A91: 0x808080, 0x3574F0: 0x4A88C7, 0x5FB865: 0x499C54 },
    contrast: { 0x1E1F22: 0x000000, 0x2B2D30: 0x0A0A0A, 0x323438: 0x141414, 0x43454A: 0x6E6E6E, 0xBCBEC4: 0xFFFFFF, 0x868A91: 0xC8C8C8, 0x3574F0: 0x1AEBFF, 0x5FB865: 0x3DD68C } }[t] ?? {};
  const c = (d, l) => hex(dark ? (map[d] ?? d) : l);
  const p = el('div', 'tp');
  p.style.background = c(0x1E1F22, 0xFFFFFF);
  p.innerHTML = `<div style="height:14px;background:${c(0x2B2D30, 0xF7F8FA)};display:flex;justify-content:flex-end;align-items:center;padding-right:5px"><i style="width:18px;height:7px;border-radius:2px;background:${c(0x3574F0, 0x3574F0)}"></i></div>`
    + `<div style="height:12px;background:${c(0x2B2D30, 0xF7F8FA)};position:relative"><i style="position:absolute;left:6px;bottom:0;width:30px;height:1.5px;background:${c(0x3574F0, 0x3574F0)}"></i></div>`
    + `<div style="position:absolute;left:12px;top:36px;width:64px;height:38px;border-radius:3px;overflow:hidden;box-shadow:0 0 0 .5px ${c(0x43454A, 0xDFE1E5)};background:${c(0x2B2D30, 0xFFFFFF)}">`
    + `<div style="height:9px;background:${c(0x323438, 0xF2F3F5)}"></div><i style="display:block;margin:5px 5px 3px;width:34px;height:2px;background:${c(0xBCBEC4, 0x2B2D30)}"></i><i style="display:block;margin:0 5px;width:24px;height:2px;background:${c(0x868A91, 0x6C707E)}"></i></div>`
    + `<i style="position:absolute;left:82px;top:38px;width:5px;height:5px;border-radius:50%;background:${c(0x5FB865, 0x208A3C)}"></i>`;
  return p;
}

/** a tool's mark from what it runs: a known kind's colour and symbol, else its initial */
function toolTile(t, size) {
  const hay = [t.id, ...(t.requires?.bin ?? []), ...(t.runs ?? []), ...(t.keywords ?? [])].join(' ').toLowerCase();
  const kinds = [['kube|k8s|helm', '#326CE5', 'cpu'], ['docker|podman|compose', '#1D63ED', 'square.stack.3d.up'], ['psql|postgres|pg_|mysql|sqlite|sql', '#336791', 'list.bullet'],
    ['redis', '#D82C20', 'square.stack.3d.up'], ['rabbit|kafka|queue|kuyruk|nats', '#FF6600', 'tray'], ['\\bgit\\b|^git|lazygit|\\bgh\\b', '#F05033', 'arrow.triangle.branch'],
    ['\\bdf\\b|\\bdu\\b|disk', '#2F9E6E', 'folder'], ['\\bps\\b|top|cpu|process|süreç', '#8A5CF6', 'cpu'], ['log|tail|journal', '#6B6862', 'list.bullet'], ['curl|http|url|api|health', '#0E9488', 'globe']];
  const hit = kinds.find(([re]) => new RegExp(re).test(hay));
  let n = 0;
  for (const ch of t.name) n = (n * 31 + ch.codePointAt(0)) % 360;
  const box = el('span', 'tool-tile', hit ? icon(hit[2], size * 0.46, 2) : [...t.name][0]?.toLocaleUpperCase('tr') ?? '?');
  Object.assign(box.style, { width: size + 'px', height: size + 'px', borderRadius: size / 4.4 + 'px', background: hit ? hit[1] : `hsl(${n} 45% 45%)`, fontSize: size * 0.5 + 'px' });
  return box;
}

/** a login's plan at a glance: one thin bar per main window; yellow from 75%, red when full */
export function usageBars(u, width = 28) {
  const main = ['5h', 'week'].map((id) => u.windows?.find((w) => w.id === id)).filter(Boolean);
  const shown = main.length ? main : (u.windows ?? []).slice(0, 2);
  const box = el('span', 'ubars');
  for (const w of shown) {
    const lvl = u.limited && w.used >= 0.99 ? 'full' : w.used >= 0.95 ? 'full' : w.used >= 0.75 ? 'high' : 'calm';
    const bar = el('i');
    bar.style.width = width + 'px';
    const fill = el('b');
    fill.style.width = Math.max(2, width * Math.min(1, w.used)) + 'px';
    fill.style.background = { calm: 'var(--muted)', high: 'var(--warn)', full: 'var(--err)' }[lvl];
    bar.append(fill);
    box.append(bar);
  }
  box.title = shown.map((w) => `${windowName(w.id)} %${Math.round(w.used * 100)}${until(w.resetsAt) ? ' ↻ ' + until(w.resetsAt) : ''}`).join('\n');
  return box;
}
export function windowName(id) {
  return { '5h': L('5 hours'), week: L('Week'), week_opus: L('Week · Opus'), week_sonnet: L('Week · Sonnet'), extra: L('Extra usage') }[id]
    ?? (/^\d+d$/.test(id) ? L('%d days', parseInt(id)) : /^\d+h$/.test(id) ? L('%d hours', parseInt(id)) : id);
}
export function until(resetsAt) {
  if (!resetsAt) return null;
  const s = resetsAt / 1000 - Date.now() / 1000;
  if (s <= 0) return null;
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 2) return L('%d days', d);
  if (h >= 1) return m % 60 === 0 || h >= 10 ? L('%d hr', h) : L('%d hr %d min', h, m % 60);
  return L('%d min', Math.max(1, m));
}
