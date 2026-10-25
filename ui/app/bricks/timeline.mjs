// Intervals on a time axis, a Gantt (Bricks/TimelineBrick.swift): bars on 20 px rows, lanes by group (sub-rows
// when bars overlap), a red dashed now-line. Open intervals grow with the clock and pulse their right edge; new bars
// grow in from their start (600 ms, staggered 30 ms on the first draw); hovering a bar shows its times.
import { L, pal } from '../theme.mjs';
import { el } from '../ui.mjs';
import * as B from './data.mjs';
import { memo, still } from './bricks.mjs';

const ROW = 20, AXIS = 16, MAX_ROWS = 80, BODY_MAX = 300;
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const toneColor = (t) => ({ ok: pal.ok, warn: pal.warn, err: pal.err, wait: pal.wait, idle: pal.muted2 }[t] ?? pal.accent);

export class TimelineBrick {
  constructor() {
    this.root = el('div', 'brick-timeline');
    this.canvas = el('canvas');
    this.root.append(this.canvas);
    this.canvas.addEventListener('pointermove', (e) => { const r = this.canvas.getBoundingClientRect(), k = r.width / this.w || 1; this.hover = { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }; this.kick(); });
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; this.kick(); });
  }

  update(ctx) {
    this.ctx = ctx;
    this.m = memo(ctx.memoKey + (ctx.preview ? '#preview' : ''), () => ({ d0: null, last: 0, born: new Map(), drawn: false, lastData: undefined, rows: [] }));
    this.#ingest();
    const h = AXIS + this.m.rows.length * ROW;
    this.root.style.height = Math.min(h, AXIS + BODY_MAX) + 'px';
    this.kick();
  }

  clock(real) { return this.ctx.preview ? (this.ctx.now ?? real) : real; }

  /** new data: intervals, and lanes with sub-rows by first fit */
  #ingest() {
    const m = this.m, v = this.ctx.view;
    if (m.lastData === this.ctx.state.data) return;
    m.lastData = this.ctx.state.data;
    const real = Date.now(), items = B.intervals(this.ctx.state.data, v, this.clock(real)).slice(0, 300);
    let rows = [];
    if (typeof v.group === 'string') {
      const lanes = new Map(), order = [];
      for (const it of [...items].sort((a, b) => a.start - b.start)) {
        const g = it.group ?? '—', subs = lanes.get(g) ?? [];
        const i = subs.findIndex((s) => { const l = s.at(-1); return (l && !l.open ? l.end : Infinity) <= it.start; });
        if (i >= 0) subs[i].push(it); else subs.push([it]);
        lanes.set(g, subs);
      }
      for (const it of items) if (!order.includes(it.group ?? '—')) order.push(it.group ?? '—');
      for (const g of order) (lanes.get(g) ?? []).forEach((sub, i) => rows.push({ label: i ? '' : g, items: sub }));
    } else rows = items.map((it) => ({ label: it.label, items: [it] }));
    rows = rows.slice(0, MAX_ROWS);
    const keys = new Set(items.map((i) => i.key));
    for (const k of m.born.keys()) if (!keys.has(k)) m.born.delete(k);
    rows.forEach((r, ri) => { for (const it of r.items) if (!m.born.has(it.key)) m.born.set(it.key, real + (m.drawn ? 0 : Math.min(ri, 16) * 30)); });
    m.rows = rows;
    m.drawn = true;
  }

  kick() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; this.draw(); });
  }

  draw() {
    if (!this.root.isConnected || !this.ctx) return;
    const m = this.m, v = this.ctx.view, rows = m.rows;
    if (!rows.length) { this.root.replaceChildren(el('div', 'brick-empty', L('no data'))); this.root.style.height = ''; return; }
    if (!this.canvas.isConnected) this.root.replaceChildren(this.canvas);
    const W = Math.max(1, Math.round(this.root.clientWidth || this.ctx.width)), H = AXIS + rows.length * ROW, dpr = Math.max(2, devicePixelRatio || 1);
    this.w = W;
    if (this.canvas.width !== W * dpr || this.canvas.height !== H * dpr) { this.canvas.width = W * dpr; this.canvas.height = H * dpr; this.canvas.style.width = W + 'px'; this.canvas.style.height = H + 'px'; }
    const g = this.canvas.getContext('2d'), real = Date.now(), now = this.clock(real);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const lab = Math.min(W * 0.34, 170), trackW = Math.max(1, W - lab), all = rows.flatMap((r) => r.items);
    // the window's start eases (180 ms) to the earliest bar, or to now − window_s
    const firstT = all.length ? Math.min(...all.map((i) => i.start)) : now - 3600000;
    const win = (B.num(v, 'window_s') ?? 0) > 0 ? B.num(v, 'window_s') * 1000 : 0;
    const want = win > 0 ? now - win : Math.min(firstT, now - 60000);
    const dt = Math.min(100, real - (m.last || real));
    m.last = real;
    let d0 = m.d0 == null || still() ? want : m.d0 + (want - m.d0) * (1 - Math.exp(-dt / 180));
    if (Math.abs(want - d0) < 50) d0 = want;
    m.d0 = d0;
    const d1 = now + (now - d0) * 0.035, span = Math.max(1, d1 - d0), fx = (t) => (t - d0) / span;
    // the axis
    g.strokeStyle = pal.line; g.lineWidth = 1;
    g.beginPath(); g.moveTo(lab, AXIS - 0.5); g.lineTo(W, AXIS - 0.5); g.stroke();
    g.font = `9.5px ${FONT}`; g.fillStyle = pal.muted2; g.textAlign = 'center'; g.textBaseline = 'top';
    for (const t of B.timeTicks(d0, d1, 5)) if (fx(t) <= 0.93 && fx(t) >= 0) g.fillText(B.fmtClock(t, span), lab + fx(t) * trackW, 1);
    g.textAlign = 'left'; g.textBaseline = 'middle';
    let hit = null, moving = false;
    const fit = (s, width, font) => { g.font = font; if (g.measureText(s).width <= width) return s; let t = s; while (t && g.measureText(t + '…').width > width) t = t.slice(0, -1); return t ? t + '…' : ''; };
    rows.forEach((r, ri) => {
      const y = AXIS + ri * ROW;
      if (r.label) { g.fillStyle = pal.text; g.fillText(fit(r.label, lab - 8, `11.5px ${FONT}`), 0, y + ROW / 2); }
      g.fillStyle = pal.panel2; g.fillRect(lab, y + ROW / 2 - 0.5, trackW, 1);
      g.save();
      g.beginPath(); g.rect(lab, y, trackW, ROW); g.clip();
      for (const it of r.items) {
        const s = Math.max(it.start, d0), e = it.open ? now : (it.end ?? now), k = Math.max(0, e - s) / span;
        const born = m.born.get(it.key) ?? 0, gk = still() ? 1 : B.springCurve((real - born) / 600);
        if (real - born < 600) moving = true;
        if (real < born) continue;
        const full = { x: lab + fx(s) * trackW, y: y + 3, w: Math.max(3, k * trackW), h: ROW - 6 };
        const rw = Math.max(0, full.w * Math.max(0, gk));
        g.globalAlpha = still() ? 1 : 0.3 + 0.7 * Math.min(1, Math.max(0, gk));
        g.fillStyle = toneColor(it.tone);
        g.beginPath(); g.roundRect(full.x, full.y, rw, full.h, it.open ? [4, 1, 1, 4] : 4); g.fill();
        if (it.open && rw > 2) { g.globalAlpha *= 0.45 + 0.1 * Math.cos(2 * Math.PI * real / 1400); g.fillStyle = '#fff'; g.fillRect(full.x + rw - 2, full.y, 2, full.h); }
        g.globalAlpha = 1;
        if (k * trackW >= 30 && gk >= 0.99) {
          const t = typeof v.group === 'string' ? it.label : B.fmtDur(e - it.start);
          g.save(); g.beginPath(); g.rect(full.x, full.y, rw, full.h); g.clip();
          g.fillStyle = '#fff'; g.fillText(fit(t, rw - 10, `10px ${FONT}`), full.x + 5, full.y + full.h / 2);
          g.restore();
        }
        const hv = this.hover;
        if (hv && hv.x >= full.x && hv.x <= full.x + full.w && hv.y >= full.y - 3 && hv.y <= full.y + full.h + 3) hit = it;
      }
      g.restore();
    });
    // now
    const nx = lab + fx(now) * trackW;
    g.strokeStyle = pal.err; g.globalAlpha = 0.8; g.setLineDash([3, 2]);
    g.beginPath(); g.moveTo(nx, 0); g.lineTo(nx, H); g.stroke();
    g.setLineDash([]); g.globalAlpha = 1;
    // the bar under the pointer
    if (hit && this.hover) {
      const end = hit.open ? now : (hit.end ?? now);
      const lines = [[hit.label || hit.group || '', `700 11px ${FONT}`, pal.ink], [`${B.fmtClock(hit.start, 0, now)} → ${hit.open ? L('now') : B.fmtClock(end, 0, now)}`, `11px ${FONT}`, pal.muted1],
        [B.fmtDur(end - hit.start) + (hit.status ? ` · ${hit.status}` : ''), `11px ${FONT}`, pal.muted1]];
      let bw = 0;
      for (const [t, f] of lines) { g.font = f; bw = Math.max(bw, g.measureText(t).width); }
      bw += 16;
      const bh = lines.length * 15 + 8, bx = Math.min(this.hover.x + 12, W - bw - 4), by = Math.min(this.hover.y + 14, H - bh);
      g.beginPath(); g.roundRect(bx, by, bw, bh, 6); g.fillStyle = pal.panel2; g.fill(); g.strokeStyle = pal.line; g.stroke();
      g.textBaseline = 'top';
      lines.forEach(([t, f, c], i) => { g.font = f; g.fillStyle = c; g.fillText(t, bx + 8, by + 4 + i * 15); });
    }
    // dense frames while bars grow in or the axis eases, then 10 a second for open bars, else once a second
    clearTimeout(this.timer);
    if (this.ctx.preview && !moving) return;
    const open = all.some((i) => i.open);
    if (moving || Math.abs(want - d0) > 0) this.kick();
    else this.timer = setTimeout(() => this.kick(), open && !still() ? 100 : 1000);
  }
}
