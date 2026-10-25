// What the view bricks do with data before drawing it (TaksimKit/BrickData.swift, BrickMath.swift): paths into
// rows, values as short text, the colour a word implies, numbers, times, rankings, a small safe markdown.
import { L, lang } from '../theme.mjs';

const pathCache = new Map();
/** "a.b.0.c" -> a, b, 0, c; a key with dots goes in brackets: "metadata.labels[app.kubernetes.io/name]" */
export function pathKeys(path) {
  let k = pathCache.get(path);
  if (!k) {
    k = [...String(path).matchAll(/\[([^\]]*)\]|[^.[\]]+/g)].map((m) => m[1] ?? m[0]);
    if (pathCache.size > 4000) pathCache.clear();
    pathCache.set(path, k);
  }
  return k;
}
/** a dotted path into a value; empty means the value itself */
export function get(v, path) {
  if (path == null || path === '') return v;
  let cur = v;
  for (const k of pathKeys(path)) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}
/** a value as one line of text, cut at `max` characters */
export function show(v, max = 160) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
export const pretty = (v) => JSON.stringify(v, null, 2) ?? 'null';
export const compact = (v) => JSON.stringify(v) ?? 'null';

const bad = /^(error|err|fail(ed|ure)?|crash\w*|down|exited.*|dead|oomkilled|critical|fatal|unhealthy|imagepullbackoff|errimagepull|evicted|false)$/i;
const warn = /^(warn(ing)?|pending|degraded|restarting|unknown|slow|terminating|containercreating|backoff)$/i;
const good = /^(ok|up.*|running|ready|healthy|active|succeeded|success|pass(ed)?|true|completed|bound|available)$/i;
/** short words that say how something is doing: 'good' | 'warn' | 'bad' | '' */
export function tone(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s || s.length > 40) return '';
  const first = s.split(/[ (]/)[0] || s;
  if (bad.test(s) || bad.test(first)) return 'bad';
  if (warn.test(s) || warn.test(first)) return 'warn';
  if (good.test(s) || good.test(first)) return 'good';
  return '';
}
export const toneColor = (t) => ({ good: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--err)' }[t] ?? null);

/** a source's data as rows: a list as it is, nothing as none, anything else as one row */
export const rows = (data) => (Array.isArray(data) ? data : data == null ? [] : [data]);
/** a row that isn't an object is {value: it} */
export const asRow = (r) => (r && typeof r === 'object' && !Array.isArray(r) ? r : { value: r });

/** [ "field" | {field, label} ] as columns, or the fields of the first rows (up to 12) */
export function viewColumns(view, key = 'columns') {
  const a = view[key];
  if (!Array.isArray(a) || !a.length) return null;
  return a.map((c) => (typeof c === 'string' ? { field: c, label: c } : c?.field ? { field: c.field, label: c.label ?? c.field, raw: c } : null)).filter(Boolean);
}
export function columns(view, rs) {
  const c = viewColumns(view);
  if (c) return c;
  const seen = [];
  for (const r of rs.slice(0, 30)) if (r && typeof r === 'object') for (const k of Object.keys(r)) if (!seen.includes(k)) seen.push(k);
  return seen.slice(0, 12).map((f) => ({ field: f, label: f }));
}
/** a path or a list of paths; null when not set */
export function paths(view, key) {
  const v = view[key];
  if (typeof v === 'string') return v ? [v] : null;
  if (Array.isArray(v)) { const p = v.filter((x) => typeof x === 'string'); return p.length ? p : null; }
  return null;
}
export const num = (view, key) => { const v = view[key]; return typeof v === 'number' ? v : typeof v === 'string' && v.trim() && !isNaN(+v) ? +v : null; };
export const heading = (view) => view.title ?? view.source ?? view.brick;
export const rowActions = (view) => (Array.isArray(view.row_actions) ? view.row_actions.filter((a) => typeof a?.label === 'string') : []);

/** rows sorted by a field: numerically when both are numbers, else as text */
export function sorted(rs, field, descending) {
  return rs.map((r, i) => [r, i]).sort(([a, i], [b, j]) => {
    const x = get(a, field), y = get(b, field), nx = parseNum(x), ny = parseNum(y);
    let r = Number.isFinite(nx) && Number.isFinite(ny) ? Math.sign(nx - ny) : show(x).localeCompare(show(y), undefined, { numeric: true });
    if (!r) return i - j;
    return descending ? -r : r;
  }).map(([r]) => r);
}
/** up to 500 rows, each with a stable id: its key, numbered when the key repeats */
export function keyed(rs, key) {
  const seen = new Map();
  return rs.slice(0, 500).map((r) => {
    const k = show(get(r, key), 400), n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return { id: n ? `${k}\0${n}` : k, row: r };
  });
}

/** stat: the value (a field of the first row, else a list's length, else the data) and its colour */
export function stat(view, data) {
  let v;
  if (typeof view.value === 'string') v = get(Array.isArray(data) ? data[0] : data, view.value);
  else if (Array.isArray(data)) v = data.length;
  else v = data;
  if (v && typeof v === 'object') v = JSON.stringify(v);
  const empty = v == null || v === '';
  const n = empty ? null : typeof v === 'number' ? v : typeof v === 'boolean' ? +v : typeof v === 'string' && v.trim() && !isNaN(+v) ? +v : null;
  let t = '';
  if (view.ok != null && !empty) t = show(v) === show(view.ok) ? 'good' : 'warn';
  const wa = num(view, 'warn_above'), ea = num(view, 'error_above');
  if (n != null && ea != null && n > ea) t = 'bad';
  else if (n != null && wa != null && n > wa) t = 'warn';
  else if (n != null && (wa != null || ea != null) && !t) t = 'good';
  if (!t) t = tone(v);
  return { text: (show(v, 40) || '—') + (view.unit ? ` ${view.unit}` : ''), tone: t };
}

/** kv: label/value pairs of an object (the first row of a list) */
export function pairs(view, data) {
  const o = asRow(Array.isArray(data) ? data[0] : data);
  const cols = viewColumns(view, 'fields') ?? Object.keys(o ?? {}).slice(0, 30).map((f) => ({ field: f, label: f }));
  return cols.map((c) => ({ label: c.label, value: get(o, c.field) }));
}

const levelNames = { warning: 'warn', critical: 'crit', emergency: 'emerg', information: 'info', default: 'log' };
/** log: a row's level (abbreviated) and text; `text` may be a list of paths, the first non-empty wins */
export function line(view, r) {
  const ps = paths(view, 'text');
  const text = ps ? show(first(r, ps), 2000) : r && typeof r === 'object' ? (r.text != null ? show(r.text, 2000) : JSON.stringify(r)) : show(r, 2000);
  const raw = typeof view.level === 'string' ? get(r, view.level) : null;
  const level = (raw ? show(raw, 1e5) : '').toLowerCase();
  const t = /err|fatal|crit|panic|alert|emerg/.test(level) ? 'bad' : level.includes('warn') ? 'warn' : '';
  return { level: levelNames[level] ?? level.slice(0, 5), text, tone: t };
}
export const first = (r, ps) => ps.map((p) => get(r, p)).find((v) => v != null && v !== '');

// ---------- numbers and times ----------

const qty = { m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5 };
/** a number from a value: 12, "12.5", "250m", "512Mi", "1.5GB", "37%", "14 (2m ago)" */
export function parseNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'string') return NaN;
  const m = v.trim().match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(?:(Ki|Mi|Gi|Ti|Pi|[mkKMGTP])B?|%|B)?(?=$|[\s(,/])/);
  return m ? Number(m[1]) * (qty[m[2]] ?? 1) : NaN;
}
const unitS = { ms: 0.001, s: 1, sec: 1, m: 60, min: 60, h: 3600, d: 86400, w: 604800, y: 31536000 };
/** seconds from a duration: 90, "90s", "1m30s", "2h", "3d4h", "250ms", "01:02:03" */
export function parseDuration(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const s = v.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^\d+:\d{2}(:\d{2})?$/.test(s)) return s.split(':').reduce((a, x) => a * 60 + Number(x), 0);
  if (!/^(\d+(\.\d+)?\s*(ms|sec|min|s|m|h|d|w|y)\s*)+$/.test(s)) return NaN;
  return [...s.matchAll(/(\d+(\.\d+)?)\s*(ms|sec|min|s|m|h|d|w|y)/g)].reduce((a, m) => a + Number(m[1]) * unitS[m[3]], 0);
}
/** epoch ms from a time: ISO text, epoch seconds or ms, "now", or an age ("47m", "5m ago") counted back from now */
export function parseTime(v, now = Date.now()) {
  if (typeof v === 'number') return Number.isFinite(v) ? (Math.abs(v) < 1e11 ? v * 1000 : v) : NaN;
  if (typeof v !== 'string') return NaN;
  const s = v.trim();
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return parseTime(Number(s), now);
  if (/^(now|just now|şimdi)$/i.test(s)) return now;
  const age = parseDuration(s.replace(/\s*(ago|önce)$/i, ''));
  if (Number.isFinite(age) && /[a-z]/i.test(s)) return now - age * 1000;
  return Date.parse(s);
}
/** how rows become one number: count | sum | avg | max | min | last */
export function aggregate(values, agg) {
  if (agg === 'count') return values.filter((v) => v != null && v !== '' && v !== false).length;
  const n = values.map(parseNum).filter(Number.isFinite);
  if (!n.length) return NaN;
  if (agg === 'avg') return n.reduce((a, b) => a + b, 0) / n.length;
  if (agg === 'max') return Math.max(...n);
  if (agg === 'min') return Math.min(...n);
  if (agg === 'last') return n.at(-1);
  return n.reduce((a, b) => a + b, 0);
}
export const yPaths = (view) => paths(view, 'y') ?? [null];
/** chart: one refresh of a source -> one number per series, times view.scale */
export function measure(data, view) {
  const s = num(view, 'scale') ?? 1, scale = !s || isNaN(s) ? 1 : s;
  return yPaths(view).map((y) => {
    let v;
    if (Array.isArray(data)) {
      const agg = view.agg ?? (y == null ? 'count' : 'sum');
      v = y != null ? aggregate(data.map((r) => get(r, y)), agg) : agg === 'count' ? data.length : aggregate(data, agg);
    } else {
      const x = y == null ? data : get(data, y);
      v = Array.isArray(x) ? x.length : parseNum(x);
    }
    return Number.isFinite(v) ? v * scale : NaN;
  });
}
/** chart with x: rows that carry their own time; rows with the same time are one point */
export function points(data, view, now = Date.now()) {
  const order = [], groups = new Map();
  for (const r of Array.isArray(data) ? data : []) {
    const t = parseTime(get(r, view.x), now);
    if (!Number.isFinite(t)) continue;
    if (!groups.has(t)) { groups.set(t, []); order.push(t); }
    groups.get(t).push(r);
  }
  return order.sort((a, b) => a - b).map((t) => ({ t, v: measure(groups.get(t), view) }));
}
/** bars: rows -> ranked, rows with the same label summed (counted without value) */
export function ranked(data, view) {
  const valuePath = view.value || null, agg = view.agg ?? (valuePath ? 'sum' : 'count');
  const order = [], groups = new Map();
  for (const r0 of rows(data)) {
    const r = asRow(r0), label = show(get(r, view.label), 80) || '—';
    if (!groups.has(label)) { groups.set(label, []); order.push(label); }
    groups.get(label).push(valuePath ? get(r, valuePath) : r);
  }
  const out = order.map((label) => {
    const vals = groups.get(label), value = agg === 'count' ? vals.length : aggregate(vals, agg);
    let raw = null;
    if (vals.length === 1 && valuePath && typeof vals[0] === 'string' && !/^[-+]?[\d.]+$/.test(vals[0].trim())) raw = vals[0].trim();
    return { label, value: Number.isFinite(value) ? value : 0, raw };
  });
  out.sort((a, b) => b.value - a.value || (a.label === '—') - (b.label === '—') || a.label.localeCompare(b.label));
  const lim = num(view, 'limit');
  return out.slice(0, lim == null ? 10 : Math.max(1, Math.floor(lim)));
}

const statusWords = [
  ['err', /^(fail(ed|ure|ing)?|error(ed)?|crash\w*|timed_out|timeout|startup_failure|rejected|changes_requested|broken|down|oomkilled|critical|fatal|unhealthy|false|imagepullbackoff|errimagepull|evicted|dead|exited)$/],
  ['warn', /^(warn(ing)?|degraded|action_required|unstable|partial\w*|retry(ing)?|flaky|restarting|backoff|terminating|slow)$/],
  ['run', /^(running|in_progress|progressing|started|deploying|building|syncing|rolling\w*|open|active|reconciling|provisioning|updating|containercreating)$/],
  ['wait', /^(queued|pending|waiting|requested|review_required|draft|scheduled|created|new|unknown|stopping)$/],
  ['ok', /^(ok|success|succeeded|successful|pass(ed)?|completed?|done|merged|approved|ready|healthy|true|deployed|available|closed|up|bound)$/],
  ['idle', /^(cancel+ed|skipped|neutral|stale|superseded|inactive|retired|stopped|terminated|suspended)$/],
];
/** a status word -> ok | warn | err | run | wait | idle | "" */
export function statusTone(v) {
  const s = (v == null ? '' : typeof v === 'string' ? v : show(v, 1e5)).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!s || s.length > 40) return '';
  const head = s.split(/[_(]/)[0];
  for (const w of [s, head]) for (const [t, re] of statusWords) if (re.test(w)) return t;
  return '';
}
/** timeline: rows -> intervals; one without an end, or still running or waiting, is open */
export function intervals(data, view, now = Date.now()) {
  const out = [], seen = new Map();
  for (const r0 of rows(data)) {
    const r = asRow(r0), start = parseTime(get(r, view.start), now);
    if (!Number.isFinite(start)) continue;
    const sp = paths(view, 'status'), status = sp ? first(r, sp) : null, t = statusTone(status);
    let end = typeof view.end === 'string' ? parseTime(get(r, view.end), now) : NaN;
    if (!Number.isFinite(end) && typeof view.duration === 'string') { const d = parseDuration(get(r, view.duration)); if (Number.isFinite(d)) end = start + d * 1000; }
    const open = !Number.isFinite(end) || t === 'run' || t === 'wait';
    const label = show(typeof view.label === 'string' ? get(r, view.label) : '', 120);
    const group = typeof view.group === 'string' ? show(get(r, view.group), 80) || '—' : null;
    const base = `${group ?? ''}\0${label}\0${start}`, n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push({ key: n ? `${base}\0${n}` : base, label, group, start, end: open ? null : Math.max(start, end), open, status: status != null ? show(status, 40) : '', tone: t });
  }
  return out;
}

const trim = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
/** short, plain numbers: 0.25, 12.4, 230, 12.3k, 4.1M */
export function fmtNum(n) {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return trim((n / 1e9).toFixed(1)) + 'G';
  if (a >= 1e6) return trim((n / 1e6).toFixed(1)) + 'M';
  if (a >= 1e4) return trim((n / 1e3).toFixed(1)) + 'k';
  if (a >= 100) return String(Math.round(n));
  if (a >= 10) return trim(n.toFixed(1));
  const s = trim(n.toFixed(2));
  return s === '-0' ? '0' : s;
}
/** 45 sec · 7 min · 2 hr 5 min · 3 d 4 hr */
export function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return L('%d sec', s);
  const m = Math.floor(s / 60);
  if (m < 60) return L('%d min', m);
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? L('%d hr %d min', h, m % 60) : L('%d hr', h);
  const d = Math.floor(h / 24);
  return h % 24 ? L('%d d %d hr', d, h % 24) : L('%d d', d);
}
/** a tick or tooltip time: 14:05, 14:05:30 for short spans, "7 Oct" for long ones */
export function fmtClock(t, span = 0, now = Date.now()) {
  const d = new Date(t), p = (x) => String(x).padStart(2, '0'), hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (span > 0 && span <= 600000) return `${hm}:${p(d.getSeconds())}`;
  const day = d.toLocaleDateString(lang === 'tr' ? 'tr-TR' : 'en-US', { day: 'numeric', month: 'short' });
  if (span > 2 * 86400000) return day;
  if (span === 0 && new Date(now).toDateString() !== d.toDateString()) return `${day} ${hm}`;
  return hm;
}
const steps = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800, 2592000].map((x) => x * 1000);
/** time ticks a person would pick: every 10 s, 1 min, 5 min, 1 h, 1 day (days on local midnight) */
export function timeTicks(d0, d1, max = 5) {
  const step = steps.find((s) => (d1 - d0) / s <= max) ?? steps.at(-1);
  const off = step >= 86400000 ? -new Date(d0).getTimezoneOffset() * 60000 : 0;
  const out = [];
  for (let t = Math.ceil((d0 + off) / step) * step - off; t <= d1; t += step) out.push(t);
  return out;
}
/** the round number at or above a value: 1, 2, 2.5, 5, 10 × 10ⁿ */
export function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
export function thresholdTone(view, n) {
  if (!Number.isFinite(n)) return '';
  const e = num(view, 'error_above'), w = num(view, 'warn_above');
  if (e != null && n > e) return 'bad';
  if (w != null && n > w) return 'warn';
  return '';
}
/** the ease every value move uses: 1-(1-t)³ */
export const ease = (t) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
/** CSS's cubic-bezier as a function of t */
export function bezier(x1, y1, x2, y2) {
  const c = (a, b, s) => 3 * a * (1 - s) * (1 - s) * s + 3 * b * (1 - s) * s * s + s * s * s;
  return (t) => {
    t = Math.min(1, Math.max(0, t));
    let s = t;
    for (let i = 0; i < 8; i++) {
      const x = c(x1, x2, s) - t, dx = 3 * x1 * (1 - s) ** 2 + 6 * (x2 - x1) * (1 - s) * s + 3 * (1 - x2) * s * s;
      if (Math.abs(x) < 1e-5 || Math.abs(dx) < 1e-6) break;
      s = Math.min(1, Math.max(0, s - x / dx));
    }
    return c(y1, y2, s);
  };
}
export const springCurve = bezier(0.34, 1.25, 0.64, 1);

/** "now", "12 sec ago" … */
export function ago(ts, now = Date.now()) {
  if (!ts) return '';
  const s = Math.round((now - ts) / 1000);
  return s < 5 ? L('now') : s < 60 ? L('%d sec ago', s) : s < 3600 ? L('%d min ago', Math.round(s / 60)) : L('%d hr ago', Math.round(s / 3600));
}
