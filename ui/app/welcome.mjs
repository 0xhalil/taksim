// The first run (Welcome.swift): taksim in eight seconds without a word (agents appear, talk, get grouped, one
// opens a panel), the CLIs to sign in to as tiles, and one action, Start: an agent on the first signed-in CLI.
import { L, pal, rgba } from './theme.mjs';
import { icon } from './icons.mjs';
import { el, btn, backendTile } from './ui.mjs';
import { AccountsModel, loginTerminal } from './accounts.mjs';
import { logos } from './logos.mjs';

function stored(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
const LOOP = 8.5;
const ease = (x) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;
const back = (x) => { const c = Math.min(1, Math.max(0, x)), s = 1.70158; return 1 + (s + 1) * (c - 1) ** 3 + s * (c - 1) ** 2; };
const phase = (t, a, d) => Math.min(1, Math.max(0, (t - a) / d));
const markColor = (b) => { const c = logos.tiles[b] ?? '#6b6862', n = parseInt(c.slice(1), 16); return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255) < 120 ? '#868a91' : c; };

export class Welcome {
  constructor(app) { this.app = app; }

  get needed() { return !stored('taksim.welcomed', false) || new URL(location.href).searchParams.has('welcome'); }

  open() {
    if (this.root) return;
    const m = this.accounts = new AccountsModel();
    this.story = el('canvas', 'story');
    this.tiles = el('div', 'wl-tiles');
    this.loginBox = el('div', 'wl-login');
    this.start = btn('wl-start', null, () => this.#start());
    const close = btn('hic wl-close', icon('xmark', 11, 1.8), () => this.close(), L('Close'));
    this.card = el('div', 'welcome', this.story, el('div', 'wl-body', this.tiles, this.loginBox, this.start), close);
    this.root = el('div', 'welcome-scrim', this.card);
    this.root.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); if (e.key === 'Enter' && !this.start.disabled && e.target === document.body) this.#start(); });
    document.body.append(this.root);
    m.watch(() => this.draw());
    m.load();
    this.draw();
    const tick = () => { if (!this.root) return; this.#story(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }

  close() {
    if (!this.root) return;
    this.accounts?.cancel();
    try { localStorage.setItem('taksim.welcomed', 'true'); } catch {}
    const r = this.root;
    this.root = null;
    r.classList.add('out');
    setTimeout(() => r.remove(), 300);
  }

  /** the first signed-in CLI (a real one before the test CLI) */
  get ready() {
    return this.accounts.ready;
  }

  draw() {
    if (!this.root) return;
    const m = this.accounts;
    const signed = (b) => (m.machine[b]?.loggedIn ? m.machine[b] : m.accounts.find((a) => a.backend === b && a.status?.loggedIn)?.status);
    this.tiles.replaceChildren(...(m.backends.length ? m.backends.filter((b) => b.name !== 'fake' || m.backends.length === 1 || location.port !== '8787').map((b) => {
      const st = signed(b.name), installed = !!b.installed, active = m.login?.backend === b.name;
      const tile = backendTile(b.name, 40);
      if (!installed) { tile.style.filter = 'saturate(0)'; tile.style.opacity = 0.45; }
      const mark = el('span', 'wl-tile-mark', tile);
      if (st) mark.append(el('span', 'wl-check', icon('checkmark', 10, 2.6)));
      const foot = el('div', 'wl-foot');
      if (st) {
        const picker = el('select', 'wl-account');
        picker.setAttribute('aria-label', `${b.label} account`);
        for (const c of m.choices.filter(c => c.backend === b.name)) {
          const option = el('option', null, c.label); option.value = c.id; picker.append(option);
        }
        if (m.ready?.backend === b.name) picker.value = m.ready.id;
        else {
          const placeholder = el('option', null, st.email ?? st.plan ?? 'Account');
          placeholder.value = ''; placeholder.disabled = true; placeholder.hidden = true;
          picker.prepend(placeholder); picker.value = '';
        }
        picker.onchange = () => {
          if (picker.value === '__add__') { m.add(b.name, m.freeName(b.label)); this.draw(); }
          else m.select(picker.value);
        };
        picker.disabled = !!m.login || m.preparing || m.loginStarting;
        foot.append(picker);
        if (b.named !== false) {
          const add = el('option', null, 'Add account'); add.value = '__add__'; picker.append(add);
        } else foot.title = 'This provider currently shares one system login';
      }
      else if (m.installing.has(b.name)) foot.append(el('span', 'spin'));
      else if (!installed) {
        const get = btn('tap', icon('arrow.down.circle', 17), () => m.signInMachine(b), m.problem[b.name] ?? L('Install and sign in'));
        get.style.color = m.failed.has(b.name) ? 'var(--err)' : 'var(--accent)';
        get.disabled = !!m.login || m.preparing || m.loginStarting;
        foot.append(get);
      } else if (active) foot.append(el('span', 'spin'));
      else {
        const s = btn('pill-key' + (m.failed.has(b.name) ? ' failed' : ''), null, () => m.signInMachine(b));
        s.append(L('Sign in'));
        s.disabled = !!m.login || m.preparing || m.loginStarting;
        foot.append(s);
      }
      return el('div', 'wl-tile' + (active || m.ready?.backend === b.name ? ' on' : ''), mark, el('b', null, b.label), foot);
    }) : [el('span', 'spin')]));
    this.loginBox.replaceChildren(...(m.login ? [loginTerminal(m.login, () => m.cancel())] : []));
    for (const message of Object.values(m.problem)) this.loginBox.append(el("div", "error", message));
    this.story.classList.toggle('short', !!m.login);
    const r = this.ready;
    this.start.replaceChildren(...(r ? [backendTile(r.backend, 18)] : []), el('span', null, L('Start')), icon('chevron.right', 12, 2.4));
    this.start.disabled = !r || !!m.login || m.preparing || m.loginStarting || !!this.starting;
    if (this.error) this.loginBox.append(el("div", "error", this.error));
  }

  async #start() {
    const choice = this.ready, s = this.app.store;
    if (!choice || this.starting) return;
    const backend = choice.backend;
    if (s.currentAgents.length) { this.close(); return; }
    this.starting = true; this.error = null; this.draw();
    try {
    await s.loadChoices();
    const m = s.models.find((x) => x.owned_by === backend && (x.id === 'sonnet' || backend !== 'claude'))?.id ?? s.models.find((x) => x.owned_by === backend)?.id;
    if (!m) throw new Error('No models available for this account');
    const at = this.app.graph.viewCenter();
    this.app.agentAdded(await s.addAgent({ model: m, account: choice.account, pos: [Math.round(at.x), Math.round(at.y)] }));
    this.close();
    } catch (e) { this.error = e.message; }
    finally { this.starting = false; this.draw(); }
  }

  /** agents appear on the canvas, talk (a pulse runs along the arrow), get grouped, one opens a live chart */
  #story() {
    const c = this.story, W = c.clientWidth, H = c.clientHeight, dpr = devicePixelRatio || 1;
    if (!W || !H) return;
    // the story shrinks while a login runs: the bitmap follows both sides, or the drawing stretches
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d'), t = (performance.now() / 1000) % LOOP;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = pal.bg; g.fillRect(0, 0, W, H);
    g.fillStyle = pal.grid;
    for (let x = 12; x < W; x += 20) for (let y = 12; y < H; y += 20) { g.beginPath(); g.arc(x + 0.8, y + 0.8, 0.8, 0, Math.PI * 2); g.fill(); }
    const fade = t > LOOP - 0.6 ? 1 - ease((t - (LOOP - 0.6)) / 0.6) : 1;
    g.globalAlpha = fade;
    const cx = W / 2, cy = H / 2, card = { w: 132, h: 64 };
    const nodes = [['claude', cx - 210, cy - 58, 0.2], ['codex', cx - 30, cy - 58, 1.1], ['gemini', cx - 120, cy + 34, 2.0]];
    const gp = phase(t, 3.2, 0.9);
    if (gp > 0) {
      const k = 1 - back(gp), r = { x: cx - 240 - 40 * k, y: cy - 104 - 30 * k, w: 372 + 80 * k, h: 186 + 60 * k };
      g.beginPath(); g.roundRect(r.x, r.y, r.w, r.h, 10);
      g.fillStyle = rgba(pal.accent, 0.07 * gp); g.fill();
      g.strokeStyle = rgba(pal.accent, 0.45 * gp); g.lineWidth = 1; g.stroke();
      g.fillStyle = rgba(pal.accent, gp); g.beginPath(); g.arc(r.x + 13.5, r.y + 13.5, 2.5, 0, Math.PI * 2); g.fill();
    }
    const edge = (a, b) => {
      const ca = { x: a[1] + card.w / 2, y: a[2] + card.h / 2 }, cb = { x: b[1] + card.w / 2, y: b[2] + card.h / 2 };
      const out = (p, o) => { const dx = o.x - p.x, dy = o.y - p.y, k = Math.min(Math.abs(card.w / 2 / Math.max(Math.abs(dx), 1e-3)), Math.abs(card.h / 2 / Math.max(Math.abs(dy), 1e-3))) + 6 / Math.max(Math.hypot(dx, dy), 1); return { x: p.x + dx * k, y: p.y + dy * k }; };
      return [out(ca, cb), out(cb, ca)];
    };
    for (const [a, b, at] of [[0, 1, 1.6], [1, 2, 2.5], [2, 0, 4.4]]) {
      const p = phase(t, at, 0.4);
      if (p <= 0) continue;
      const [f, to] = edge(nodes[a], nodes[b]), e = ease(p);
      g.strokeStyle = rgba(pal.muted, 0.8); g.lineWidth = 1.5; g.lineCap = 'round';
      g.beginPath(); g.moveTo(f.x, f.y); g.lineTo(f.x + (to.x - f.x) * e, f.y + (to.y - f.y) * e); g.stroke();
      if (p >= 1) {
        const ang = Math.atan2(to.y - f.y, to.x - f.x);
        g.strokeStyle = pal.muted;
        g.beginPath(); g.moveTo(to.x, to.y); g.lineTo(to.x - 9 * Math.cos(ang - 0.4), to.y - 9 * Math.sin(ang - 0.4)); g.moveTo(to.x, to.y); g.lineTo(to.x - 9 * Math.cos(ang + 0.4), to.y - 9 * Math.sin(ang + 0.4)); g.stroke();
      }
      const q = phase(t, at + 0.35, 0.9);
      if (q > 0 && q < 1) { const eq = ease(q); g.fillStyle = markColor(nodes[a][0]); g.beginPath(); g.arc(f.x + (to.x - f.x) * eq, f.y + (to.y - f.y) * eq, 4, 0, Math.PI * 2); g.fill(); }
    }
    nodes.forEach(([b, x, y, at], i) => {
      const p = phase(t, at, 0.5);
      if (p <= 0) return;
      const s = 0.7 + 0.3 * back(p);
      g.save();
      g.globalAlpha = fade * p;
      g.translate(x + card.w / 2, y + card.h / 2); g.scale(s, s); g.translate(-(x + card.w / 2), -(y + card.h / 2));
      g.beginPath(); g.roundRect(x, y, card.w, card.h, 8); g.fillStyle = pal.nodeBody; g.fill();
      g.save(); g.clip(); g.fillStyle = pal.nodeHead; g.fillRect(x, y, card.w, 22); g.restore();
      g.strokeStyle = pal.line; g.lineWidth = 1; g.beginPath(); g.roundRect(x, y, card.w, card.h, 8); g.stroke();
      g.fillStyle = logos.tiles[b] ?? '#6b6862'; g.beginPath(); g.roundRect(x + 6, y + 4, 14, 14, 3.5); g.fill();
      if (logos.paths[b]) { g.save(); g.translate(x + 8, y + 6); g.scale(10 / 24, 10 / 24); g.fillStyle = '#fff'; g.fill(new Path2D(logos.paths[b])); g.restore(); }
      g.fillStyle = pal.text; g.beginPath(); g.roundRect(x + 26, y + 9, 44, 4, 2); g.fill();
      const work = phase(t, at + 0.4, 1.2);
      [0.9, 0.7, 0.5].forEach((f, k) => { const w = (card.w - 20) * Math.min(1, Math.max(0, work * 3 - k)) * f; if (w > 0) { g.fillStyle = rgba(pal.muted, 0.7); g.beginPath(); g.roundRect(x + 10, y + 30 + k * 9, w, 3.5, 1.75); g.fill(); } });
      const br = 0.5 + 0.5 * Math.sin(t * 4 + i);
      g.fillStyle = rgba(pal.ok, 0.4 + 0.6 * br); g.beginPath(); g.arc(x + card.w - 11, y + 11, 3, 0, Math.PI * 2); g.fill();
      g.restore();
    });
    const pp = phase(t, 4.9, 0.6);
    if (pp > 0) {
      const host = nodes[1], w = 170, h = 112, r = { x: host[1] + card.w + 14 - 30 * (1 - back(pp)), y: host[2], w, h };
      g.save();
      g.globalAlpha = fade * pp;
      g.beginPath(); g.roundRect(r.x, r.y, w, h, 8); g.fillStyle = pal.panel; g.fill(); g.strokeStyle = pal.line; g.stroke();
      g.save(); g.clip(); g.fillStyle = pal.panel2; g.fillRect(r.x, r.y, w, 18); g.restore();
      g.fillStyle = pal.ok; g.beginPath(); g.arc(r.x + 11, r.y + 9, 3, 0, Math.PI * 2); g.fill();
      const plot = { x: r.x + 10, y: r.y + 30, w: w - 20, h: h - 42 }, drawn = phase(t, 5.3, 1.4), pts = [];
      for (let k = 0; k <= 40; k++) { const fx = k / 40; if (fx > drawn) break; const v = 0.5 + 0.28 * Math.sin(fx * 7 + t * 1.6) + 0.12 * Math.sin(fx * 19 + t * 3); pts.push([plot.x + plot.w * fx, plot.y + plot.h - plot.h * v]); }
      if (pts.length) {
        const grad = g.createLinearGradient(0, plot.y, 0, plot.y + plot.h);
        grad.addColorStop(0, rgba(pal.accent, 0.28)); grad.addColorStop(1, rgba(pal.accent, 0));
        g.beginPath(); g.moveTo(pts[0][0], plot.y + plot.h); for (const p of pts) g.lineTo(...p); g.lineTo(pts.at(-1)[0], plot.y + plot.h); g.closePath(); g.fillStyle = grad; g.fill();
        g.beginPath(); pts.forEach((p, k) => (k ? g.lineTo(...p) : g.moveTo(...p))); g.strokeStyle = pal.accent; g.lineWidth = 1.8; g.lineJoin = 'round'; g.stroke();
        g.fillStyle = pal.accent; g.beginPath(); g.arc(...pts.at(-1), 3, 0, Math.PI * 2); g.fill();
      }
      g.restore();
    }
    g.globalAlpha = 1;
  }
}
