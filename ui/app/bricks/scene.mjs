// An animated picture an agent designs from shapes, to explain something (Bricks/SceneBrick.swift; the meaning is
// src/bricks/scene.mjs, used here as it is): the scene scaled to the brick's width, its steps played once when the
// view first shows (or looped), keyed shapes gliding to new data. Drawn as SVG, one frame per animation frame
// only while something moves.
import { L, pal } from '../theme.mjs';
import { icon } from '../icons.mjs';
import { el, btn } from '../ui.mjs';
import { expand, schedule, sceneSize, colorToken, ease as sceneEase } from '../shared/scene.mjs';
import { memo, still } from './bricks.mjs';

const SVG = 'http://www.w3.org/2000/svg';
const NUM = ['x', 'y', 'w', 'h', 'r', 'rx', 'x2', 'y2', 'size', 'width', 'opacity', 'rotate'];
const tokenColor = (t) => (t == null || t === 'none' ? null : { s1: pal.accent, s2: pal.wait, s3: pal.muted1, s4: pal.line2 }[t] ?? pal[t] ?? pal.ink);
const given = (s, k) => s[k] != null && s[k] !== '';
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const lerp = (a, b, k) => a + (b - a) * k;

/** a shape's props after a move/transform step reached its `to` */
function merged(s, to) {
  const out = { ...s };
  for (const [k, v] of Object.entries(to ?? {})) {
    if (k === 'id' || k === 'type') continue;
    if (NUM.includes(k)) { const n = num(v); if (Number.isFinite(n)) out[k] = n; } else out[k] = v;
  }
  return out;
}

/** a shape's keyframes over the plan: props and how far each verb has got; the last is where it rests */
function keys(shape, plan) {
  let s = shape, cur = { props: s, vis: plan.hidden.has(s.id) || s.hidden === true ? 0 : 1, drawn: 1, filled: 1, scale: 1, tint: 0, reveal: 1 };
  const out = [{ t: 0, f: cur, ease: 'linear' }], gap = 0.001;
  for (const st of plan.steps) {
    if (!st.targets.includes(s.id)) continue;
    const last = out.at(-1).t, t0 = Math.max(st.start, last), d = Math.max(0, st.end - st.start), t1 = t0 + d, e = st.ease ?? 'smooth';
    if (t0 > last) out.push({ t: t0, f: cur, ease: 'linear' });
    const jump = (f) => { cur = f; out.push({ t: out.at(-1).t + gap, f, ease: 'linear' }); };
    const to = (t, f, ea = e) => { cur = f; out.push({ t: Math.max(t, out.at(-1).t), f, ease: ea }); };
    const isText = s.type === 'text';
    if (st.do === 'create' || st.do === 'write') {
      if (isText) { jump({ ...cur, vis: 1, reveal: 0 }); to(t1, { ...cur, reveal: 1 }, st.ease == null ? 'linear' : e); }
      else {
        const stroke = !(given(s, 'fill') && !given(s, 'color')), fill = given(s, 'fill');
        jump({ ...cur, vis: 1, drawn: stroke ? 0 : 1, filled: 0 });
        if (stroke && fill) { to(t0 + d * 0.65, { ...cur, drawn: 1 }); to(t1, { ...cur, filled: 1 }); } else to(t1, { ...cur, drawn: 1, filled: 1 });
      }
    } else if (st.do === 'fade_in') { jump({ ...cur, vis: 0 }); to(t1, { ...cur, vis: 1 }); }
    else if (st.do === 'fade_out') to(t1, { ...cur, vis: 0 });
    else if (st.do === 'grow') { jump({ ...cur, vis: 1, scale: 0 }); to(t1, { ...cur, scale: 1 }); }
    else if ((st.do === 'move' || st.do === 'transform') && st.to) { s = merged(s, st.to); to(t1, { ...cur, props: s }); }
    else if (st.do === 'indicate') { to(t0 + d / 2, { ...cur, scale: 1.15, tint: 1 }, 'smooth'); to(t1, { ...cur, scale: 1, tint: 0 }, 'smooth'); }
  }
  return out;
}

/** two frames mixed: numbers and points eased, everything else switched at the end */
function mix(a, b, k) {
  const props = { ...b.props };
  for (const key of NUM) { const x = num(a.props[key]), y = num(b.props[key]); if (Number.isFinite(x) && Number.isFinite(y)) props[key] = lerp(x, y, k); else if (k < 1) props[key] = a.props[key]; }
  if (Array.isArray(a.props.points) && Array.isArray(b.props.points) && a.props.points.length === b.props.points.length) {
    props.points = b.props.points.map((p, i) => [lerp(+a.props.points[i][0], +p[0], k), lerp(+a.props.points[i][1], +p[1], k)]);
  }
  if (k < 1) for (const key of ['text', 'color', 'fill', 'd']) props[key] = k < 0.5 ? a.props[key] : b.props[key];
  return { props, vis: lerp(a.vis, b.vis, k), drawn: lerp(a.drawn, b.drawn, k), filled: lerp(a.filled, b.filled, k), scale: lerp(a.scale, b.scale, k), tint: lerp(a.tint, b.tint, k), reveal: lerp(a.reveal, b.reveal, k) };
}
function frameAt(ks, t) {
  if (t <= ks[0].t) return ks[0].f;
  for (let i = 1; i < ks.length; i++) {
    if (t <= ks[i].t) {
      const a = ks[i - 1], b = ks[i], k = (t - a.t) / Math.max(1e-6, b.t - a.t);
      return mix(a.f, b.f, sceneEase(b.ease, k));
    }
  }
  return ks.at(-1).f;
}

/** the SVG for a shape's props at one moment */
function draw(node, f, H) {
  const s = f.props, type = s.type;
  const n = (k, d = 0) => (Number.isFinite(num(s[k])) ? num(s[k]) : d);
  const tok = (v, d) => { const t = colorToken(v, d); return t === 'none' ? null : t; };
  node.g.setAttribute('opacity', Math.max(0, Math.min(1, n('opacity', 1))) * f.vis);
  node.g.style.display = f.vis <= 0.001 ? 'none' : '';
  const accent = f.tint > 0 ? (c) => mixColor(c, pal.accent, f.tint) : (c) => c;
  if (type === 'text') {
    const t = node.text;
    const color = tokenColor(tok(given(s, 'color') ? s.color : s.fill, 'ink'));
    const full = String(s.text ?? ''), shown = f.reveal >= 1 ? full : full.slice(0, Math.round(full.length * f.reveal));
    t.textContent = shown;
    t.setAttribute('x', n('x'));
    t.setAttribute('y', n('y'));
    t.setAttribute('font-size', Math.max(1, n('size', 12)));
    const w = String(s.weight ?? '').toLowerCase(), wn = Number(w);
    t.setAttribute('font-weight', Number.isFinite(wn) && w ? wn : { bold: 700, heavy: 700, black: 700, semibold: 600, medium: 500, light: 300, thin: 300 }[w] ?? 400);
    t.setAttribute('text-anchor', { middle: 'middle', center: 'middle', end: 'end', right: 'end' }[s.align] ?? 'start');
    t.setAttribute('fill', accent(color ?? pal.ink));
    t.setAttribute('transform', n('rotate') ? `rotate(${n('rotate')} ${n('x')} ${n('y')})` : '');
    applyScale(node.g, f.scale, n('x'), n('y'));
    return;
  }
  const fillTok = given(s, 'fill') ? tok(s.fill, 'none') : null;
  let stroke = given(s, 'color') ? tok(s.color, 'ink') : given(s, 'fill') ? null : 'ink';
  let fill = fillTok, fillAlpha = 1, d = '', headD = '', both = true;
  const x = n('x'), y = n('y');
  if (type === 'rect') {
    const w = n('w'), h = n('h'), rx = Math.min(Math.max(0, n('rx')), Math.abs(w) / 2, Math.abs(h) / 2), X = Math.min(x, x + w), Y = Math.min(y, y + h), W = Math.abs(w), Hh = Math.abs(h);
    d = rx > 0 ? `M${X + rx} ${Y}h${W - 2 * rx}a${rx} ${rx} 0 0 1 ${rx} ${rx}v${Hh - 2 * rx}a${rx} ${rx} 0 0 1 ${-rx} ${rx}h${-(W - 2 * rx)}a${rx} ${rx} 0 0 1 ${-rx} ${-rx}v${-(Hh - 2 * rx)}a${rx} ${rx} 0 0 1 ${rx} ${-rx}z` : `M${X} ${Y}h${W}v${Hh}h${-W}z`;
  } else if (type === 'circle' || type === 'ellipse') {
    const r = n('r', 10), rw = type === 'circle' ? Math.max(0, r) : Math.max(0, n('w', r * 2)) / 2, rh = type === 'circle' ? Math.max(0, r) : Math.max(0, n('h', r * 2)) / 2;
    d = `M${x - rw} ${y}a${rw} ${rh} 0 1 0 ${rw * 2} 0a${rw} ${rh} 0 1 0 ${-rw * 2} 0z`;
  } else if (type === 'line' || type === 'arrow') {
    both = false;
    const x2 = n('x2', x), y2 = n('y2', y);
    if (type === 'arrow') {
      const dx = x2 - x, dy = y2 - y, len = Math.max(1e-4, Math.hypot(dx, dy)), ux = dx / len, uy = dy / len, width = Math.max(0, n('width', 1.5));
      const hl = Math.min(len * 0.6, Math.max(7, width * 3.5)), hw = hl * 0.55, bx = x2 - ux * hl, by = y2 - uy * hl;
      d = `M${x} ${y}L${bx + ux * 0.5} ${by + uy * 0.5}`;
      headD = `M${x2} ${y2}L${bx - uy * hw} ${by + ux * hw}L${bx + uy * hw} ${by - ux * hw}z`;
      fill = stroke;
    } else d = `M${x} ${y}L${x2} ${y2}`;
  } else if (type === 'polyline' || type === 'polygon' || type === 'area') {
    const pts = (Array.isArray(s.points) ? s.points : []).map((p) => [num(p?.[0]), num(p?.[1])]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
    const line = pts.map(([a, b], i) => `${i ? 'L' : 'M'}${a} ${b}`).join('');
    if (type === 'polygon') d = line + (pts.length ? 'z' : '');
    else if (type === 'area') {
      both = false;
      d = line;
      const base = Number.isFinite(num(s.y)) ? num(s.y) : H;
      headD = pts.length ? `M${pts[0][0]} ${base}` + pts.map(([a, b]) => `L${a} ${b}`).join('') + `L${pts.at(-1)[0]} ${base}z` : '';
      if (!given(s, 'color') && !given(s, 'fill')) stroke = 'accent';
      fill = fillTok ?? stroke;
      fillAlpha = fillTok ? 1 : 0.22;
    } else { both = false; d = line; }
  } else if (type === 'path') d = String(s.d ?? '');
  else if (type === 'brace') {
    both = false;
    const x2 = n('x2', x), y2 = n('y2', y), len = Math.hypot(x2 - x, y2 - y);
    if (len > 0) {
      const dd = Math.min(14, Math.max(6, len * 0.12)), q = Math.min(dd / 2, len / 4), m = len / 2;
      d = `M0 0Q0 ${q} ${q} ${q}L${m - q} ${q}Q${m} ${q} ${m} ${dd}Q${m} ${q} ${m + q} ${q}L${len - q} ${q}Q${len} ${q} ${len} 0`;
      node.stroke.setAttribute('transform', `translate(${x} ${y}) rotate(${Math.atan2(y2 - y, x2 - x) * 180 / Math.PI})`);
    }
  }
  if (type !== 'brace') node.stroke.removeAttribute('transform');
  const width = Math.max(0, n('width', 1.5));
  const dash = typeof s.dash === 'number' && s.dash > 0 ? `${s.dash} ${s.dash}` : Array.isArray(s.dash) ? s.dash.join(' ') : s.dash === true ? '4 3' : typeof s.dash === 'string' ? s.dash.replace(/,/g, ' ') : '';
  // the outline draws itself (create): a dash as long as the path, offset by what is not drawn yet
  node.stroke.setAttribute('d', d);
  node.stroke.setAttribute('stroke', stroke ? accent(tokenColor(stroke)) : 'none');
  node.stroke.setAttribute('stroke-width', width);
  node.stroke.setAttribute('fill', 'none');
  if (f.drawn < 1) { node.stroke.setAttribute('pathLength', 1); node.stroke.setAttribute('stroke-dasharray', '1 1'); node.stroke.setAttribute('stroke-dashoffset', 1 - f.drawn); }
  else { node.stroke.removeAttribute('pathLength'); node.stroke.setAttribute('stroke-dasharray', dash); node.stroke.removeAttribute('stroke-dashoffset'); }
  node.fill.setAttribute('d', both ? d : headD);
  node.fill.setAttribute('fill', fill ? accent(tokenColor(fill)) : 'none');
  node.fill.setAttribute('fill-opacity', fillAlpha * f.filled);
  if (type !== 'brace' && n('rotate')) {
    const box = node.g.getBBox?.();
    if (box) { const t = `rotate(${n('rotate')} ${box.x + box.width / 2} ${box.y + box.height / 2})`; node.stroke.setAttribute('transform', t); node.fill.setAttribute('transform', t); }
  } else node.fill.removeAttribute('transform');
  if (f.scale !== 1) { const box = node.g.getBBox?.(); applyScale(node.g, f.scale, box ? box.x + box.width / 2 : x, box ? box.y + box.height / 2 : y); }
  else node.g.removeAttribute('transform');
}
function applyScale(g, k, cx, cy) { if (k === 1) g.removeAttribute('transform'); else g.setAttribute('transform', `translate(${cx} ${cy}) scale(${k}) translate(${-cx} ${-cy})`); }
function mixColor(a, b, k) {
  const p = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) return a;
  const x = p(a), y = p(b);
  return '#' + x.map((v, i) => Math.round(lerp(v, y[i], k)).toString(16).padStart(2, '0')).join('');
}

export class SceneBrick {
  static showsAge = false;
  nodes = new Map();

  constructor() {
    this.root = el('div', 'brick-scene');
    this.svg = document.createElementNS(SVG, 'svg');
    this.root.append(this.svg);
    this.controls = el('div', 'scene-controls', btn('scene-key', icon('arrow.clockwise', 12), () => this.play(true), L('Replay')));
    this.root.append(this.controls);
  }

  update(ctx) {
    const v = ctx.view, data = ctx.state.data;
    const specChanged = JSON.stringify(v) !== this.specKey, dataChanged = data !== this.data;
    this.ctx = ctx;
    this.controls.hidden = !!ctx.preview;
    if (!specChanged && !dataChanged && this.specKey) return;
    this.specKey = JSON.stringify(v);
    this.data = data;
    this.memo = memo(ctx.memoKey + '|scene', () => ({ played: null }));
    const [W, H] = sceneSize(v);
    this.W = W; this.H = H;
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.svg.setAttribute('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif');
    let shapes = [];
    try { shapes = expand(v, data); } catch {}
    this.plan = schedule(v, shapes);
    if (!shapes.length) { this.svg.replaceChildren(); this.root.dataset.empty = L('no data'); return; }
    delete this.root.dataset.empty;
    if (specChanged) {
      this.svg.replaceChildren();
      this.nodes.clear();
      for (const s of shapes) this.#node(s);
      this.order = shapes.map((s) => s.id);
      if (!still() && this.plan.length > 0 && (v.loop === true || this.memo.played !== this.specKey)) this.play();
      else this.#rest();
    } else this.#glide(shapes);
  }

  #node(s) {
    const g = document.createElementNS(SVG, 'g'), node = { shape: s, g };
    if (s.type === 'text') { node.text = document.createElementNS(SVG, 'text'); g.append(node.text); }
    else { node.fill = document.createElementNS(SVG, 'path'); node.stroke = document.createElementNS(SVG, 'path'); node.stroke.setAttribute('stroke-linecap', 'round'); node.stroke.setAttribute('stroke-linejoin', 'round'); g.append(node.fill, node.stroke); }
    node.keys = keys(s, this.plan);
    this.svg.append(g);
    this.nodes.set(s.id, node);
    return node;
  }

  /** every shape where its timeline ends */
  #rest() { for (const n of this.nodes.values()) { n.shown = n.keys.at(-1).f; draw(n, n.shown, this.H); } }

  /** the steps from the start (once per spec, unless it loops) */
  play(again = false) {
    if (again) this.memo.played = null;
    this.memo.played = this.specKey;
    const start = performance.now(), len = this.plan.length;
    cancelAnimationFrame(this.raf);
    const frame = () => {
      if (!this.root.isConnected) { this.raf = requestAnimationFrame(frame); return; }
      let t = (performance.now() - start) / 1000;
      if (this.ctx.view.loop === true) t %= len + 0.8;
      for (const n of this.nodes.values()) { n.shown = frameAt(n.keys, t); draw(n, n.shown, this.H); }
      if (t < len || this.ctx.view.loop === true) this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  /** new data: keyed shapes glide to their new values, new ones fade in, gone ones fade out */
  #glide(shapes) {
    const moveS = Number.isFinite(+this.ctx.view.move_s) && +this.ctx.view.move_s >= 0 ? Math.min(+this.ctx.view.move_s, 5) : 0.6;
    const next = new Map(), plans = [];
    for (const s of shapes) {
      let n = this.nodes.get(s.id);
      const target = { props: s, vis: s.hidden === true ? 0 : 1, drawn: 1, filled: 1, scale: 1, tint: 0, reveal: 1 };
      if (!n) { n = this.#node(s); n.shown = { ...target, vis: 0 }; }
      n.keys = [{ t: 0, f: target, ease: 'linear' }];
      plans.push([n, n.shown ?? target, target]);
      next.set(s.id, n);
    }
    for (const [id, n] of this.nodes) if (!next.has(id)) plans.push([n, n.shown ?? n.keys.at(-1).f, { ...(n.shown ?? n.keys.at(-1).f), vis: 0 }, true]);
    this.nodes = next;
    const start = performance.now();
    cancelAnimationFrame(this.raf);
    const frame = () => {
      const k = still() || moveS === 0 ? 1 : Math.min(1, (performance.now() - start) / 1000 / moveS), e = sceneEase('smooth', k);
      for (const [n, a, b, gone] of plans) { n.shown = mix(a, b, e); draw(n, n.shown, this.H); if (gone && k >= 1) n.g.remove(); }
      if (k < 1) this.raf = requestAnimationFrame(frame);
    };
    frame();
  }
}
