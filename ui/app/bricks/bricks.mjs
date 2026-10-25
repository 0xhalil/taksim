// View bricks (Bricks/*.swift): how a panel shows a source's data. Each brick is a class with a root element and
// update(ctx); the registry maps a spec's brick name to it. Data comes from agents, so it is only ever text.
import { L } from '../theme.mjs';
import { icon } from '../icons.mjs';
import { el } from '../ui.mjs';
import { markdown } from '../chat/markdown.mjs';
import * as B from './data.mjs';

const reduce = matchMedia('(prefers-reduced-motion: reduce)');
export const still = () => reduce.matches;

/** what views keep across re-renders, by memo key: a chart's samples, which bars already grew */
export const memos = new Map();
export function memo(key, make) { let m = memos.get(key); if (!m) { m = make(); memos.set(key, m); } return m; }
export function dropMemos(owner) { for (const k of memos.keys()) if (k.startsWith(owner + '|')) memos.delete(k); }
export const memoKey = (owner, v) => owner + '|' + JSON.stringify([v.id, v.brick, v.source ?? null, v.x ?? null, v.y ?? null, v.agg ?? null, v.scale ?? null]);

const empty = (text = L('no data')) => el('div', 'brick-empty', text);

/** a number that counts to its new value (450 ms, 1-(1-t)³) */
function countTo(node, from, to, format, ms = 450) {
  if (still() || !Number.isFinite(from) || from === to) { node.textContent = format(to); return; }
  const start = performance.now();
  const step = () => {
    const k = B.ease((performance.now() - start) / ms);
    node.textContent = format(from + (to - from) * k);
    if (k < 1 && node.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- stat: one big number or word ----------

class StatBrick {
  static showsAge = false;
  constructor() { this.root = el('div', 'brick-stat'); }
  update(ctx) {
    const s = B.stat(ctx.view, ctx.state.data);
    const n = parseFloat(s.text.split(' ')[0]), was = this.value;
    this.root.style.color = B.toneColor(s.tone) ?? 'var(--ink)';
    if (Number.isFinite(n) && Number.isFinite(was) && /^[-+]?[\d.]+(\s|$)/.test(s.text)) {
      const unit = s.text.slice(s.text.indexOf(' ') >= 0 ? s.text.indexOf(' ') : s.text.length), dec = (s.text.split(' ')[0].split('.')[1] ?? '').length;
      countTo(this.root, was, n, (x) => x.toFixed(dec) + unit);
    } else this.root.textContent = s.text;
    this.value = n;
  }
}

// ---------- kv: an object's fields ----------

class KVBrick {
  constructor() { this.root = el('div', 'brick-kv'); }
  update(ctx) {
    const pairs = B.pairs(ctx.view, ctx.state.data);
    if (!pairs.length) return this.root.replaceChildren(empty());
    this.root.replaceChildren(...pairs.flatMap((p) => {
      const v = el('span', 'v selectable', B.show(p.value, 400));
      const c = B.toneColor(B.tone(p.value));
      if (c) v.style.color = c;
      return [el('span', 'k', p.label), v];
    }));
  }
}

// ---------- json: raw data ----------

class JSONBrick {
  constructor() { this.root = el('pre', 'brick-json selectable'); }
  update(ctx) {
    const full = B.pretty(ctx.state.data);
    this.root.textContent = full.length > 60000 ? full.slice(0, 60000) + '\n…' : full;
  }
}

// ---------- markdown: text the agent writes ----------

class MarkdownBrick {
  constructor() { this.root = el('div', 'brick-md selectable'); }
  update(ctx) {
    const d = ctx.state.data;
    const src = typeof d === 'string' ? d : d == null ? (ctx.view.text ?? '') : '```\n' + B.pretty(d) + '\n```';
    if (src === this.src) return;
    this.src = src;
    this.root.replaceChildren(markdown(src));
  }
}

// ---------- table: rows that keep their identity, slide when they move, flash when they change ----------

class TableBrick {
  sort = null;
  rows = new Map();
  constructor() {
    this.root = el('div', 'brick-table');
    this.table = el('table');
    this.root.append(this.table);
  }

  update(ctx) {
    const same = this.ctx && this.ctx.state.data === ctx.state.data && this.ctx.view === ctx.view && this.ctx.picked === ctx.picked;
    this.ctx = ctx;
    if (!same) this.#apply(true);
  }

  #apply(animated) {
    const ctx = this.ctx, v = ctx.view, all = B.rows(ctx.state.data).map(B.asRow);
    if (!all.length) { this.root.replaceChildren(empty()); this.rows.clear(); this.drawn = false; return; }
    if (!this.table.isConnected) this.root.replaceChildren(this.table);
    const cols = B.columns(v, all), acts = ctx.preview ? [] : B.rowActions(v);
    const shown = B.keyed(this.sort ? B.sorted(all, this.sort.field, this.sort.desc) : all, v.key ?? cols[0]?.field);
    const sig = JSON.stringify([cols.map((c) => c.field), acts.length]);
    const motion = animated && !still() && shown.length <= 150 && this.sig === sig;
    if (this.sig !== sig) { this.sig = sig; this.rows.clear(); this.table.replaceChildren(); }
    const m = memo(ctx.memoKey + (ctx.preview ? '#preview' : ''), () => ({ first: null }));
    m.first ??= new Set(shown.map((s) => s.id));
    const numCols = new Set(cols.map((c, i) => [c, i]).filter(([c]) => {
      let any = false;
      return shown.every(({ row }) => { const t = B.show(B.get(row, c.field)).trim(); if (!t) return true; if (!/^-?\d+(\.\d+)?$/.test(t)) return false; any = true; return true; }) && any;
    }).map(([, i]) => i));
    const barField = v.bar ?? null;
    const barMax = barField ? Math.max(0, ...shown.map((s) => B.parseNum(B.get(s.row, barField))).filter(Number.isFinite)) || 1 : 1;
    // the header: a click sorts up, down, off
    const head = el('tr');
    cols.forEach((c, i) => {
      const th = el('th', numCols.has(i) ? 'num' : '', c.label);
      if (this.sort?.field === c.field) th.append(icon(this.sort.desc ? 'chevron.down' : 'chevron.up', 9, 2));
      th.addEventListener('click', () => {
        if (ctx.preview) return;
        this.sort = this.sort?.field === c.field ? (this.sort.desc ? null : { field: c.field, desc: true }) : { field: c.field, desc: false };
        this.#apply(true);
      });
      head.append(th);
    });
    if (acts.length) head.append(el('th'));
    const thead = el('thead', null, head);
    // where each kept row sat (for the slide), then the rows in their new order
    const before = new Map();
    if (motion) for (const [id, tr] of this.rows) before.set(id, tr.getBoundingClientRect().top);
    const body = el('tbody'), next = new Map();
    shown.forEach(({ id, row }, idx) => {
      let tr = this.rows.get(id), fresh = !tr;
      if (!tr) { tr = el('tr'); tr.cells_ = []; }
      tr.row = row;
      const picked = ctx.picked != null && B.show(B.get(row, ctx.pickField ?? '')) === ctx.picked;
      tr.classList.toggle('picked', picked);
      cols.forEach((c, i) => {
        const value = B.get(row, c.field), text = B.show(value);
        let td = tr.cells_[i];
        if (!td) { td = el('td'); tr.cells_[i] = td; tr.append(td); }
        td.className = numCols.has(i) ? 'num' : '';
        const old = td.dataset.v;
        if (old !== text) {
          const span = td.querySelector('.t') ?? td.appendChild(el('span', 't'));
          const a = parseFloat(old), b = parseFloat(text);
          if (motion && old != null && !fresh) {
            td.classList.remove('flash'); void td.offsetWidth; td.classList.add('flash');
            if (shown.length <= 20 && /^-?\d+(\.\d+)?$/.test(old.trim()) && /^-?\d+(\.\d+)?$/.test(text.trim())) countTo(span, a, b, (x) => x.toFixed((text.split('.')[1] ?? '').length));
            else span.textContent = text;
          } else span.textContent = text;
          td.dataset.v = text;
          td.title = text.length === 160 && text.endsWith('…') ? B.show(value, 2000) : '';
        }
        const tc = B.toneColor(B.tone(value));
        td.style.color = tc ?? '';
        if (c.field === barField) {
          const bar = td.querySelector('.bar') ?? td.insertBefore(el('i', 'bar'), td.firstChild);
          const share = Math.max(0, Math.min(1, B.parseNum(value) / barMax));
          bar.style.width = `calc((100% - 8px) * ${Number.isFinite(share) ? share : 0})`;
        } else td.querySelector('.bar')?.remove();
      });
      while (tr.cells_.length > cols.length) tr.cells_.pop().remove();
      if (acts.length) {
        let cell = tr.querySelector('.acts');
        if (!cell) { cell = el('td', 'acts'); tr.append(cell); }
        cell.replaceChildren(...acts.map((a, k) => {
          const b = el('button', 'row-act' + (a.run && !a.ask ? ' run' : ''), a.label);
          b.type = 'button';
          b.title = a.run ? L('Runs: %@', a.run.join(' ')) : L('Asks the agent: %@', a.ask ?? '');
          b.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (b.disabled) return;
            b.disabled = true;
            const ok = await ctx.act(k, tr.row);
            b.disabled = false;
            if (ok) { b.classList.add('sent'); setTimeout(() => b.classList.remove('sent'), 1500); }
          });
          return b;
        }));
      }
      if (fresh && ctx.pick) tr.addEventListener('click', () => this.ctx.pick?.(tr.row));
      tr.classList.toggle('pickable', !!ctx.pick);
      if (fresh && motion) {
        // in from the left; on the first draw one after another
        const delay = m.first.has(id) ? Math.min(idx, 12) * 28 : 0;
        tr.animate([{ transform: 'translateX(-8px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 380, delay, easing: 'cubic-bezier(.34,1.3,.64,1)', fill: 'backwards' });
      }
      next.set(id, tr);
      body.append(tr);
    });
    // gone rows fade where they were
    if (motion) for (const [id, tr] of this.rows) if (!next.has(id)) {
      const r = tr.getBoundingClientRect(), host = this.root.getBoundingClientRect(), k = (r.height / tr.offsetHeight) || 1;
      const ghost = tr.cloneNode(true);
      Object.assign(ghost.style, { position: 'absolute', left: 0, top: (r.top - host.top) / k + this.root.scrollTop + 'px', width: '100%', pointerEvents: 'none' });
      ghost.classList.add('ghost-row');
      this.root.append(ghost);
      ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: 'ease-out' }).onfinish = () => ghost.remove();
    }
    this.rows = next;
    this.table.replaceChildren(thead, body);
    // kept rows slide from where they were (FLIP)
    if (motion) for (const [id, tr] of next) {
      const was = before.get(id);
      if (was == null) continue;
      const k = (tr.getBoundingClientRect().height / tr.offsetHeight) || 1, dy = (was - tr.getBoundingClientRect().top) / k;
      if (Math.abs(dy) > 0.5) tr.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 520, easing: 'cubic-bezier(.34,1.25,.64,1)' });
    }
  }
}

// ---------- log: lines, newest at the bottom ----------

class LogBrick {
  lines = [];
  constructor() {
    this.root = el('div', 'brick-log');
    this.root.addEventListener('click', (e) => {
      const line = e.target.closest('.line');
      if (!line || !this.clickable) return;
      const row = this.lines[Number(line.dataset.i)];
      if (this.ctx.pick) this.ctx.pick(row); else this.ctx.act(0, row);
    });
  }
  get clickable() { return this.ctx && !this.ctx.preview && (!!this.ctx.pick || B.rowActions(this.ctx.view).length > 0); }
  update(ctx) {
    const specChanged = this.ctx?.view !== ctx.view;
    if (!specChanged && this.ctx?.state.data === ctx.state.data) return;
    this.ctx = ctx;
    const rs = B.rows(ctx.state.data).slice(-500);
    if (!rs.length) { this.root.replaceChildren(empty(L('no rows yet'))); this.lines = []; return; }
    const atBottom = this.root.scrollTop + this.root.clientHeight >= this.root.scrollHeight - 4;
    // the old lines the new ones start with stay; the ones before them go, the ones after them come
    let keep = 0;
    if (!specChanged && this.lines.length) {
      const last = JSON.stringify(this.lines.at(-1)), olds = this.lines.map((x) => JSON.stringify(x)), news = rs.map((x) => JSON.stringify(x));
      for (let j = Math.min(news.length, olds.length) - 1; j >= 0; j--) {
        if (news[j] === last && news.slice(0, j + 1).every((x, i) => x === olds[olds.length - 1 - j + i])) { keep = j + 1; break; }
      }
    }
    if (!keep) this.root.replaceChildren();
    else { const drop = this.lines.length - keep; for (let i = 0; i < drop; i++) this.root.firstChild?.remove(); }
    for (const [i, r] of rs.slice(keep).entries()) {
      const l = B.line(ctx.view, r), div = el('div', 'line');
      if (l.level) { const tag = el('span', 'lvl', l.level.toUpperCase()); tag.style.color = B.toneColor(l.tone) ?? 'var(--muted)'; div.append(tag); }
      div.append(el('span', 'txt', l.text));
      this.root.append(div);
      void i;
    }
    this.lines = rs;
    [...this.root.children].forEach((n, i) => { n.dataset.i = i; });
    this.root.classList.toggle('clickable', this.clickable);
    this.root.title = this.clickable && !ctx.pick ? B.rowActions(ctx.view)[0]?.label ?? '' : '';
    if (atBottom || !keep) this.root.scrollTop = this.root.scrollHeight;
  }
}

// ---------- bars: a ranked bar race ----------

class BarsBrick {
  items = new Map();
  constructor() { this.root = el('div', 'brick-bars'); }
  update(ctx) {
    const v = ctx.view, list = B.ranked(ctx.state.data, v);
    const given = B.num(v, 'max') ?? 0, top = given > 0 ? given : Math.max(0, ...list.map((x) => x.value)), full = top > 0 ? top : 1;
    const unit = v.unit ? ` ${v.unit}` : '', m = memo(ctx.memoKey + (ctx.preview ? '#preview' : ''), () => ({ drawn: false }));
    if (!list.length) { this.root.replaceChildren(empty()); this.items.clear(); return; }
    if (this.root.querySelector('.brick-empty')) this.root.replaceChildren();
    this.root.style.height = list.length * 22 + 'px';
    const labW = Math.min(ctx.width * 0.38, 170), next = new Map();
    list.forEach((it, i) => {
      let r = this.items.get(it.label);
      const fresh = !r;
      if (!r) {
        r = { root: el('div', 'bar-row'), fill: el('i'), num: el('span', 'n'), value: 0 };
        const lab = el('span', 'lab', it.label);
        lab.title = it.label;
        r.root.append(lab, el('span', 'track', r.fill), r.num);
        r.root.style.transform = `translateY(${(m.drawn ? list.length : i) * 22}px)`;
        if (m.drawn && !still()) r.root.style.opacity = 0;
        this.root.append(r.root);
      }
      r.root.firstChild.style.width = labW + 'px';
      const tone = B.thresholdTone(v, it.value);
      r.fill.style.background = B.toneColor(tone) ?? 'var(--accent)';
      const frac = Math.max(0, Math.min(1, it.value / full));
      requestAnimationFrame(() => { r.root.style.transform = `translateY(${i * 22}px)`; r.root.style.opacity = 1; r.fill.style.width = frac * 100 + '%'; });
      if (it.raw) r.num.textContent = it.raw;
      else { const whole = it.value === Math.round(it.value); countTo(r.num, fresh ? 0 : r.value, it.value, (n) => B.fmtNum(whole ? Math.round(n) : n) + unit); }
      r.value = it.value;
      next.set(it.label, r);
    });
    for (const [label, r] of this.items) if (!next.has(label)) { r.root.style.opacity = 0; setTimeout(() => r.root.remove(), 400); }
    this.items = next;
    m.drawn = true;
  }
}

export const registry = { stat: StatBrick, kv: KVBrick, json: JSONBrick, markdown: MarkdownBrick, table: TableBrick, log: LogBrick, bars: BarsBrick };
export function register(name, cls) { registry[name] = cls; }
export const hidesAge = (name) => registry[name]?.showsAge === false;
export function makeBrick(name) { return new (registry[name] ?? JSONBrick)(); }
