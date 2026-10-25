// A live time series (Bricks/ChartBrick.swift, ChartGeometry.swift). Every refresh of the source is one sample,
// stamped when it arrives; the plot scrolls with the clock, the newest value eases in (450 ms), the y scale eases to
// fit, the latest value is big on the right. With x, rows carry their own time. A preview draws the tool's saved
// series once, left to right over 900 ms. Drawn on a canvas, only as often as the picture moves.
import { pal, rgba } from '../theme.mjs';
import { el } from '../ui.mjs';
import * as B from './data.mjs';
import { memo, still } from './bricks.mjs';

const PLOT_H = 110, HEAD_H = 26, MOVE = 450, INTRO = 900, TOP = 6, BOTTOM = PLOT_H - 15;
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const palette = () => [pal.accent, pal.wait, pal.muted1, pal.line2];

function scaleFor(vals, kind, stack) {
  const fin = (r) => r.filter(Number.isFinite);
  const tops = vals.map((r) => (stack ? fin(r).reduce((a, b) => a + b, 0) : Math.max(...fin(r), -Infinity)));
  const lows = vals.map((r) => Math.min(Math.min(...fin(r), 0), 0));
  const hiData = Math.max(0, ...tops.filter(Number.isFinite)), loData = Math.min(0, ...lows);
  const target = B.niceMax(hiData * 1.08 || 1);
  let lo = loData < 0 ? -B.niceMax(-loData * 1.08) : 0;
  const all = vals.flat().filter(Number.isFinite), minData = all.length ? Math.min(...all) : 0;
  if (kind === 'line' && !stack && minData > 0 && minData > (hiData - minData) * 2) {
    const step = B.niceMax((target - minData) / 3);
    lo = Math.max(0, Math.floor((minData - (hiData - minData) * 0.3) / step) * step);
  }
  return { lo, hi: target };
}

export class ChartBrick {
  constructor() {
    this.root = el('div', 'brick-chart');
    this.canvas = el('canvas');
    this.root.append(this.canvas);
    this.root.style.height = HEAD_H + PLOT_H + 'px';
    this.canvas.addEventListener('pointermove', (e) => { const r = this.canvas.getBoundingClientRect(), k = r.width / this.w || 1; this.hover = (e.clientY - r.top) / k >= HEAD_H ? (e.clientX - r.left) / k : null; this.kick(); });
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; this.kick(); });
  }

  get v() { return this.ctx.view; }
  get ys() { return B.yPaths(this.v); }
  get names() { return this.ys.map((y) => (y ? B.pathKeys(y).at(-1) ?? y : '')); }
  get kind() { return ['line', 'area', 'bar'].includes(this.v.kind) ? this.v.kind : 'line'; }
  get windowMs() { return Math.max(10, B.num(this.v, 'window_s') ?? 300) * 1000; }
  get xMode() { return !!this.v.x; }
  get scrolls() { return !this.ctx.preview && (!this.xMode || B.num(this.v, 'window_s') != null); }
  get stack() { return this.v.stacked === true && this.ys.length > 1; }
  clock(real) { return this.ctx.preview ? (this.ctx.now ?? real) : real; }

  update(ctx) {
    this.ctx = ctx;
    const key = ctx.memoKey + (ctx.preview ? '#preview' : '');
    if (key !== this.key) {
      this.key = key;
      this.m = memo(key, () => ({ samples: [], lastAt: null, lastData: undefined, intro: 0, seeded: false, scale: null }));
      if ((ctx.preview || this.xMode) && !this.m.samples.length) this.m.intro = Date.now();
    }
    this.#ingest();
    this.kick();
  }

  /** a sample's value right now: from where it was to where it goes */
  cur(p, real) {
    return p.v.map((val, i) => {
      const f = p.from?.[i];
      if (!Number.isFinite(val) || !Number.isFinite(f) || still()) return val;
      return f + (val - f) * B.ease((real - p.born) / MOVE);
    });
  }

  #ingest() {
    const ctx = this.ctx, m = this.m, real = Date.now(), data = ctx.state.data;
    if (ctx.preview && !m.seeded && !this.xMode && Array.isArray(ctx.series) && ctx.series.length) {
      const every = (ctx.everyS ?? 5) * 1000, now = this.clock(real), n = ctx.series.length;
      m.samples = ctx.series.map((x, i) => ({ t: now - (n - 1 - i) * every, v: (Array.isArray(x) ? x : [x]).map(B.parseNum), from: null, born: 0 }));
      m.seeded = true;
    }
    if (this.xMode) {
      if (m.lastData === data) return;
      m.lastData = data;
      const old = new Map(m.samples.map((p) => [p.t, p])), had = m.samples.length > 0;
      m.samples = B.points(data, this.v, this.clock(real)).map((p) => ({ t: p.t, v: p.v, from: old.has(p.t) ? this.cur(old.get(p.t), real) : p.v.map(() => (had ? 0 : NaN)), born: real }));
    } else if (!(ctx.preview && m.seeded) && data != null) {
      const at = ctx.state.updatedAt;
      if (at ? at === m.lastAt : m.samples.length && m.lastData === data) return;
      m.lastAt = at;
      m.lastData = data;
      const val = B.measure(data, this.v), prev = m.samples.at(-1);
      m.samples.push({ t: this.clock(real), v: val, from: prev ? this.cur(prev, real) : val.map(() => 0), born: real });
      const cut = this.clock(real) - this.windowMs;
      while (m.samples.length > 2 && m.samples[1].t < cut) m.samples.shift();
      if (m.samples.length > 3000) m.samples.splice(0, m.samples.length - 3000);
    }
  }

  kick() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; this.draw(); });
  }

  draw() {
    if (!this.root.isConnected || !this.ctx) return;
    const w = Math.max(1, Math.round(this.root.clientWidth || this.ctx.width)), H = HEAD_H + PLOT_H, dpr = Math.max(2, devicePixelRatio || 1);
    this.w = w;
    if (this.canvas.width !== w * dpr) { this.canvas.width = w * dpr; this.canvas.height = H * dpr; this.canvas.style.width = w + 'px'; this.canvas.style.height = H + 'px'; }
    const g = this.canvas.getContext('2d'), m = this.m, real = Date.now(), now = this.clock(real), kind = this.kind, stack = this.stack;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, H);
    // the time window
    const pts = m.samples;
    let d0 = now - this.windowMs, d1 = now;
    if (!this.scrolls && pts.length) {
      d0 = pts[0].t; d1 = pts.at(-1).t;
      const gap = pts.length > 1 ? Math.min(...pts.slice(1).map((p, i) => p.t - pts[i].t)) : 3600000;
      if (kind === 'bar' || pts.length === 1) { d0 -= gap / 2; d1 += gap / 2; }
    }
    const i0 = pts.findIndex((p) => p.t >= d0), vis = pts.slice(Math.max(0, (i0 < 0 ? pts.length : i0) - 1)).filter((p) => p.t <= d1);
    const times = vis.map((p) => p.t), to = vis.map((p) => p.v), vals = vis.map((p) => this.cur(p, real));
    // the y range eases to fit
    const target = scaleFor(to, kind, stack);
    if (!m.scale || m.scale.to.lo !== target.lo || m.scale.to.hi !== target.hi) {
      const from = m.scale ? this.#scaleNow(real) : target;
      m.scale = { from, to: target, start: real };
    }
    const sc = still() ? target : this.#scaleNow(real);
    const k = w / Math.max(1, d1 - d0), x = (t) => (t - d0) * k;
    const y = (v) => TOP + (1 - (v - sc.lo) / ((sc.hi - sc.lo) || 1)) * (BOTTOM - TOP);
    g.save();
    g.translate(0, HEAD_H);
    // grid and its labels
    g.font = `9.5px ${FONT}`;
    g.textBaseline = 'alphabetic';
    [target.hi, (target.hi + target.lo) / 2, target.lo].forEach((val, i) => {
      const yy = Math.round(y(val)) + 0.5;
      g.strokeStyle = pal.line; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, yy); g.lineTo(w, yy); g.stroke();
      if (i === 2 && Math.abs(target.lo) < 1e-9) return;
      g.fillStyle = pal.muted2;
      g.fillText(B.fmtNum(val), 2, i === 0 ? yy + 11 : yy - 3);
    });
    for (const [key, color] of [['warn_above', pal.warn], ['error_above', pal.err]]) {
      const t = B.num(this.v, key);
      if (t == null || t < sc.lo || t > sc.hi) continue;
      g.strokeStyle = color; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(0, y(t)); g.lineTo(w, y(t)); g.stroke();
      g.setLineDash([]);
    }
    // the series, revealed from the left the first time
    let reveal = w;
    if (m.intro && !still()) { const p = (real - m.intro) / INTRO; if (p < 1) reveal = w * B.ease(p); else m.intro = 0; }
    g.save();
    g.beginPath(); g.rect(-4, 0, reveal + 8, PLOT_H); g.clip();
    const n = times.length, series = this.ys.length, base = new Array(n).fill(0), cols = palette();
    const every = (this.ctx.everyS ?? 5) * 1000;
    const starts = times.map((t, i) => (i > 0 ? times[i - 1] : t - (n > 1 ? times[1] - t : every)));
    const gaps = times.slice(1).map((t, i) => x(t) - x(times[i]));
    const barGap = this.xMode ? Math.max(4, Math.min(n > 1 ? Math.min(...gaps) * 0.8 : w / 3, (w / Math.max(1, n)) * 0.7)) : 0;
    const hold = this.xMode ? null : w;
    const ends = [];
    for (let s = 0; s < series; s++) {
      const color = cols[s % 4], on = to.map((r) => Number.isFinite(r[s]));
      const yv = vals.map((r, i) => { const v = r[s]; return Number.isFinite(v) ? (stack ? base[i] + v : v) : on[i] ? base[i] : NaN; });
      if (kind === 'bar') {
        g.fillStyle = rgba(color, 0.85);
        for (let i = 0; i < n; i++) {
          if (!on[i]) continue;
          let x0 = this.xMode ? x(times[i]) - barGap / 2 : x(starts[i]) + 0.5, x1 = this.xMode ? x(times[i]) + barGap / 2 : x(times[i]) - 0.5;
          if (!stack && series > 1) { const part = (x1 - x0) / series; x0 += part * s; x1 = x0 + part; }
          if (x1 - x0 < 1) x1 = x0 + 1;
          const yb = y(stack ? base[i] : 0), yt = y(yv[i]);
          g.fillRect(x0, Math.min(yb, yt), x1 - x0, Math.abs(yb - yt));
        }
      } else {
        const upper = [];
        let pen = false, last = null;
        g.beginPath();
        for (let i = 0; i < n; i++) {
          if (!on[i]) { pen = false; continue; }
          const p = [x(times[i]), y(yv[i])];
          if (pen) g.lineTo(...p); else g.moveTo(...p);
          upper.push([p, i]); pen = true; last = p;
        }
        if (last && hold != null) { const e = [hold, last[1]]; g.lineTo(...e); upper.push([e, n - 1]); last = e; }
        g.strokeStyle = color; g.lineWidth = 1.8; g.lineCap = 'round'; g.lineJoin = 'round';
        g.stroke();
        if (kind === 'area' && upper.length) {
          g.beginPath();
          upper.forEach(([p], j) => (j ? g.lineTo(...p) : g.moveTo(...p)));
          for (const [p, i] of [...upper].reverse()) g.lineTo(p[0], y(stack ? base[i] : Math.max(sc.lo, 0)));
          g.closePath(); g.fillStyle = rgba(color, 0.16); g.fill();
        }
        if (last) ends.push([last, color]);
      }
      if (stack) yv.forEach((v, i) => { if (Number.isFinite(v)) base[i] = v; });
    }
    g.restore();
    // a live line's dots at the edge
    if (reveal >= w) for (const [[px, py], color] of ends) {
      g.beginPath(); g.arc(px, py, 2.8, 0, Math.PI * 2);
      g.fillStyle = color; g.fill(); g.lineWidth = 1.5; g.strokeStyle = pal.panel; g.stroke();
    }
    // time ticks
    const span = d1 - d0, ticks = B.timeTicks(d0, d1, Math.max(2, Math.floor(w / 95)));
    g.font = `9.5px ${FONT}`; g.textAlign = 'center'; g.fillStyle = pal.muted2;
    for (const t of ticks) { const tx = x(t); if (tx > 18 && tx < w - 18) g.fillText(B.fmtClock(t, span), tx, PLOT_H - 4); }
    g.textAlign = 'left';
    // the sample under the pointer
    if (this.hover != null && times.length) {
      const xs = times.map(x), best = xs.reduce((b, v, i) => (Math.abs(v - this.hover) < Math.abs(xs[b] - this.hover) ? i : b), 0), hx = Math.max(0, xs[best]);
      g.strokeStyle = pal.muted2; g.setLineDash([2, 2]);
      g.beginPath(); g.moveTo(hx, TOP); g.lineTo(hx, BOTTOM); g.stroke(); g.setLineDash([]);
      const unit = this.v.unit ? ` ${this.v.unit}` : '';
      const text = `${B.fmtClock(times[best], this.xMode ? 0 : 1)}  ` + vals[best].map((v, i) => (series > 1 ? (this.names[i] ?? '') + ' ' : '') + B.fmtNum(v)).join(' · ') + unit;
      g.font = `11px ${FONT}`;
      const tw = g.measureText(text).width, bw = tw + 12, bx = Math.min(Math.max(0, hx - bw / 2), w - bw), by = BOTTOM - 21;
      g.beginPath(); g.roundRect(bx, by, bw, 16, 5); g.fillStyle = pal.panel2; g.fill(); g.strokeStyle = pal.line; g.stroke();
      g.fillStyle = pal.ink; g.fillText(text, bx + 6, by + 12);
    }
    g.restore();
    // the head: the latest value big on the right, the legend's values on the left
    const latest = vis.length ? vals.at(-1) : [];
    const head = stack ? latest.filter(Number.isFinite).reduce((a, b) => a + b, 0) : latest[0] ?? NaN;
    g.textBaseline = 'alphabetic';
    let right = w;
    if (this.v.unit) {
      g.font = `500 11.5px ${FONT}`; g.fillStyle = pal.muted;
      right -= g.measureText(this.v.unit).width; g.fillText(this.v.unit, right, HEAD_H - 6); right -= 3;
    }
    g.font = `600 22px ${FONT}`;
    const ht = vis.length ? B.fmtNum(head) : '—';
    g.fillStyle = B.thresholdTone(this.v, head) === 'bad' ? pal.err : B.thresholdTone(this.v, head) === 'warn' ? pal.warn : pal.ink;
    g.fillText(ht, right - g.measureText(ht).width, HEAD_H - 6);
    if (series > 1) {
      let lx = 0;
      for (let i = 0; i < series; i++) {
        g.fillStyle = cols[i % 4]; g.beginPath(); g.roundRect(lx, HEAD_H - 15, 8, 8, 2); g.fill(); lx += 12;
        g.font = `11px ${FONT}`; g.fillStyle = pal.muted; g.fillText(this.names[i], lx, HEAD_H - 7); lx += g.measureText(this.names[i]).width + 4;
        g.font = `600 11px ${FONT}`; g.fillStyle = pal.ink; const val = B.fmtNum(latest[i] ?? NaN); g.fillText(val, lx, HEAD_H - 7); lx += g.measureText(val).width + 10;
      }
    }
    // the next frame: every frame while something eases, else as often as the window moves a pixel
    const easing = vis.some((p) => real - p.born < MOVE + 30) || (m.scale && real - m.scale.start < MOVE) || m.intro;
    clearTimeout(this.timer);
    if (still()) return;
    if (easing) this.kick();
    else if (this.scrolls) this.timer = setTimeout(() => this.kick(), Math.max(33, Math.min(1000, 1000 / (k * 1000 * 2))));
  }

  #scaleNow(real) {
    const s = this.m.scale;
    if (!s) return { lo: 0, hi: 1 };
    const e = B.ease((real - s.start) / MOVE);
    return { lo: s.from.lo + (s.to.lo - s.from.lo) * e, hi: s.from.hi + (s.to.hi - s.from.hi) * e };
  }
}
