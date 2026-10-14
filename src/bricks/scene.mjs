// The scene brick's meaning: what the server validates and what the native app's Core Animation renderer
// (TaksimKit Scene.swift) follows exactly. A scene is data an agent writes, never code.
//
//   { brick: "scene", source?, size: [w, h],
//     x?: {min, max}, y?: {min, max},          data coordinates for shapes marked "data": true (y grows upward)
//     shapes: [shape],                          drawn as written
//     each?: {rows?, key?, shapes: [shape]},    one copy of these per row of the source ("{field}" fills them in)
//     steps?: [step], loop?: bool,              a Manim-like timeline, played when the view first shows
//     move_s?: number }                         how long keyed shapes take to reach new values when data changes
//
// shape: {id, type, x, y, w, h, r, rx, x2, y2, points, d, text, size, weight, align, color, fill, width,
//         opacity, dash, rotate, data, hidden}
// step:  {do, target, at?, dur?, to?, ease?}
//
// Values may be templates: "{field}" (a row's field), "{i}" (row index), arithmetic like "{i*40+20}" or
// "{value/max*200}", and text like "{name}: {count}". A template that is only one expression becomes a number.

import { get, statusTone } from "./data.mjs";

export const SHAPES = ["rect", "circle", "ellipse", "line", "arrow", "polyline", "polygon", "area", "path", "text", "brace"];
export const VERBS = ["create", "write", "fade_in", "fade_out", "grow", "move", "transform", "indicate", "wait"];
export const EASES = ["smooth", "linear", "spring"];
// colors are theme words, so a scene looks right in every theme
export const COLORS = ["ink", "text", "muted", "line", "panel", "bg", "accent", "ok", "warn", "err", "wait", "s1", "s2", "s3", "s4", "none"];
export const LIMITS = { shapes: 300, steps: 60, seconds: 20 };

const NUMERIC = ["x", "y", "w", "h", "r", "rx", "x2", "y2", "size", "width", "opacity", "rotate"];

// ---------- expressions: numbers, fields, + - * / % ( ), min/max/abs/round, comparisons and a ? b : c ----------

const FUNCS = { min: Math.min, max: Math.max, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, sqrt: Math.sqrt, log: Math.log10 };

/** evaluates one expression against a row (fields by path), its index i and the scene's stats; never eval() */
export function evaluate(expr, scope) {
  const src = String(expr);
  let p = 0;
  const peek = () => { while (src[p] === " ") p++; return src[p]; };
  const fail = (m) => { throw new Error(`${m} in "${src}"`); };
  function primary() {
    const c = peek();
    if (c === "(") { p++; const v = ternary(); if (peek() !== ")") fail("missing )"); p++; return v; }
    if (c === "-") { p++; return -primary(); }
    if (c === "'" || c === '"') { const q = c; const e = src.indexOf(q, p + 1); if (e < 0) fail("unclosed string"); const s = src.slice(p + 1, e); p = e + 1; return s; }
    const num = /^\d+(\.\d+)?/.exec(src.slice(p));
    if (num) { p += num[0].length; return Number(num[0]); }
    const id = /^[A-Za-z_][\w.]*(\[[^\]]*\][\w.]*)*/.exec(src.slice(p)); // a field path, dotted keys in [brackets]
    if (!id) fail("unexpected character");
    p += id[0].length;
    const name = id[0];
    if (peek() === "(" && FUNCS[name]) {
      p++;
      const args = [];
      if (peek() !== ")") { args.push(ternary()); while (peek() === ",") { p++; args.push(ternary()); } }
      if (peek() !== ")") fail("missing )");
      p++;
      return FUNCS[name](...args.map(Number));
    }
    return lookup(name, scope);
  }
  function term() {
    let v = primary();
    for (;;) {
      const c = peek();
      if (c === "*" || c === "/" || c === "%") { p++; const r = primary(); v = c === "*" ? num(v) * num(r) : c === "/" ? num(v) / num(r) : num(v) % num(r); }
      else return v;
    }
  }
  function sum() {
    let v = term();
    for (;;) {
      const c = peek();
      if (c === "+" || c === "-") { p++; const r = term(); v = c === "+" ? (typeof v === "string" || typeof r === "string" ? `${v}${r}` : v + r) : num(v) - num(r); }
      else return v;
    }
  }
  function compare() {
    const v = sum();
    const op = /^(==|!=|>=|<=|>|<)/.exec(src.slice((peek(), p)));
    if (!op) return v;
    p += op[0].length;
    const r = sum();
    switch (op[0]) {
      case "==": return v == r; case "!=": return v != r;
      case ">=": return num(v) >= num(r); case "<=": return num(v) <= num(r);
      case ">": return num(v) > num(r); default: return num(v) < num(r);
    }
  }
  function ternary() {
    const c = compare();
    if (peek() !== "?") return c;
    p++;
    const a = ternary();
    if (peek() !== ":") fail("missing :");
    p++;
    const b = ternary();
    return c ? a : b;
  }
  const v = ternary();
  if (peek() !== undefined) fail("unexpected text");
  return v;
}
const num = (v) => (typeof v === "number" ? v : Number.parseFloat(v));

// a row's own field first; the scene's vars (i, n, w, h, max, min, sum) when the row has no such field
function lookup(name, scope) {
  const v = scope.row !== undefined && scope.row !== null && typeof scope.row === "object" ? get(scope.row, name) : undefined;
  if (v !== undefined) return v;
  return scope.vars?.[name];
}

/** fills a template: one expression alone keeps its type (a number stays a number); otherwise text */
export function fill(value, scope) {
  if (typeof value !== "string" || !value.includes("{")) return value;
  const whole = /^\{([^{}]+)\}$/.exec(value);
  if (whole) { const v = evaluate(whole[1], scope); return v === undefined ? "" : v; }
  return value.replace(/\{([^{}]+)\}/g, (_, e) => { const v = evaluate(e, scope); return v === undefined || v === null ? "" : typeof v === "number" ? fmt(v) : String(v); });
}
const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

function fillShape(shape, scope) {
  const out = {};
  for (const [k, v] of Object.entries(shape)) {
    if (k === "points" && Array.isArray(v)) out.points = v.map((pt) => (Array.isArray(pt) ? pt.map((c) => fill(c, scope)) : pt));
    else out[k] = fill(v, scope);
  }
  for (const k of NUMERIC) if (out[k] !== undefined) out[k] = Number(out[k]);
  return out;
}

// ---------- expansion: a view plus its source's data -> the shapes to draw ----------

/** the list of rows a scene's `each` repeats over */
export function rowsOf(view, data) {
  const at = view.each?.rows ? get(data, view.each.rows) : data;
  return Array.isArray(at) ? at : at === undefined || at === null ? [] : [at];
}

/**
 * The scene's shapes for this data: static ones, then one copy of the `each` shapes per row (ids made unique by
 * the row's key), with templates filled in and data coordinates mapped to scene units. Vars available to
 * templates: i (row index), n (row count), max/min/sum of the `each.value` field when given, w and h.
 */
export function expand(view, data) {
  const [W, H] = sceneSize(view);
  const rows = view.each ? rowsOf(view, data) : [];
  const values = view.each?.value ? rows.map((r) => Number(get(r, view.each.value))).filter(Number.isFinite) : [];
  const stats = { n: rows.length, w: W, h: H, max: values.length ? Math.max(...values) : 0, min: values.length ? Math.min(...values) : 0,
    sum: values.reduce((a, b) => a + b, 0) };
  const out = [];
  const base = { vars: { ...stats, i: 0 }, row: Array.isArray(data) ? undefined : data };
  for (const [j, s] of (view.shapes || []).entries()) out.push(finish(fillShape(s, base), s.id ?? `s${j}`, view));
  const seen = new Map();
  rows.forEach((row, i) => {
    const scope = { vars: { ...stats, i }, row };
    let key = view.each.key ? String(get(row, view.each.key) ?? i) : String(i);
    const k = seen.get(key) || 0;
    seen.set(key, k + 1);
    if (k) key = `${key}#${k + 1}`;
    for (const [j, s] of view.each.shapes.entries()) out.push(finish(fillShape(s, scope), `${key}/${s.id ?? `e${j}`}`, view));
  });
  return out.slice(0, LIMITS.shapes);
}

export function sceneSize(view) {
  const [w, h] = Array.isArray(view.size) ? view.size.map(Number) : [];
  return [Number.isFinite(w) && w > 0 ? w : 400, Number.isFinite(h) && h > 0 ? h : 240];
}

/** data coordinates -> scene units for a shape marked data: true (x/y frames from the view; y grows up) */
function mapper(view) {
  const [W, H] = sceneSize(view);
  const fx = view.x || { min: 0, max: W }, fy = view.y || { min: 0, max: H };
  const sx = (v) => ((v - fx.min) / ((fx.max - fx.min) || 1)) * W;
  const sy = (v) => H - ((v - fy.min) / ((fy.max - fy.min) || 1)) * H;
  return { sx, sy, sw: (v) => (v / ((fx.max - fx.min) || 1)) * W, sh: (v) => (v / ((fy.max - fy.min) || 1)) * H };
}

function finish(s, id, view) {
  s.id = String(id);
  if (s.data) {
    const m = mapper(view);
    if (Number.isFinite(s.x)) s.x = m.sx(s.x);
    if (Number.isFinite(s.x2)) s.x2 = m.sx(s.x2);
    if (Number.isFinite(s.w)) s.w = m.sw(s.w);
    if (Number.isFinite(s.h)) { s.h = m.sh(s.h); if (Number.isFinite(s.y)) s.y = m.sy(s.y) - s.h; }
    else if (Number.isFinite(s.y)) s.y = m.sy(s.y);
    if (Number.isFinite(s.y2)) s.y2 = m.sy(s.y2);
    if (Array.isArray(s.points)) s.points = s.points.map(([x, y]) => [m.sx(Number(x)), m.sy(Number(y))]);
    delete s.data;
  }
  return s;
}

/** a color word (or "status:<word>", colored by what it means) -> a theme token every renderer maps */
export function colorToken(c, fallback = "ink") {
  if (c === undefined || c === null || c === "") return fallback;
  const s = String(c);
  if (s.startsWith("status:")) {
    const tone = statusTone(s.slice(7));
    return { ok: "ok", warn: "warn", err: "err", run: "accent", wait: "wait", idle: "muted" }[tone] || "accent";
  }
  return COLORS.includes(s) ? s : fallback;
}

// ---------- the timeline ----------

/**
 * When each step runs: a step starts at `at` seconds when given, else when the previous one ends; `wait` only
 * moves the clock. Returns [{...step, targets: [ids], start, end}] (seconds) and which shapes start hidden
 * (the targets of create, write, fade_in and grow appear with their step).
 */
export function schedule(view, shapes) {
  const ids = shapes.map((s) => s.id);
  const match = (t) => {
    const list = Array.isArray(t) ? t : [t];
    return ids.filter((id) => list.some((x) => x === "*" || id === x || id.endsWith(`/${x}`) || id.startsWith(`${x}/`)));
  };
  const out = [], hidden = new Set();
  let clock = 0;
  for (const st of (view.steps || []).slice(0, LIMITS.steps)) {
    const dur = Math.max(0, Math.min(LIMITS.seconds, Number(st.dur ?? (st.do === "wait" ? 0.5 : 0.6))));
    const start = Number.isFinite(Number(st.at)) && st.at !== undefined ? Number(st.at) : clock;
    const targets = st.do === "wait" ? [] : match(st.target ?? "*");
    if (["create", "write", "fade_in", "grow"].includes(st.do)) for (const id of targets) if (!out.some((o) => o.targets.includes(id) && o.start < start)) hidden.add(id);
    out.push({ ...st, dur, targets, start: Math.min(start, LIMITS.seconds), end: Math.min(start + dur, LIMITS.seconds) });
    clock = Math.max(clock, start + dur);
  }
  return { steps: out, hidden, length: Math.min(LIMITS.seconds, clock) };
}

export function ease(name, t) {
  const c = Math.min(1, Math.max(0, t));
  if (name === "linear") return c;
  if (name === "spring") { const s = 1.70158; return 1 + (s + 1) * (c - 1) ** 3 + s * (c - 1) ** 2; }
  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2; // smooth: Manim's smooth-ish ease in/out
}

// ---------- validation (the server's catalog uses this) ----------

export function validateScene(v, at) {
  const errors = [];
  const shapeErr = (s, where) => {
    if (!s || typeof s !== "object") { errors.push(`${where}: must be an object`); return; }
    if (!SHAPES.includes(s.type)) errors.push(`${where}.type: one of ${SHAPES.join(", ")}`);
    for (const k of ["color", "fill"]) if (s[k] !== undefined && typeof s[k] === "string" && !s[k].includes("{") && !s[k].startsWith("status:") && !COLORS.includes(s[k])) errors.push(`${where}.${k}: a theme color (${COLORS.join(", ")}) or "status:<word>"`);
    for (const k of Object.keys(s)) if (typeof s[k] === "string" && s[k].includes("{")) {
      for (const m of s[k].matchAll(/\{([^{}]+)\}/g)) { try { evaluate(m[1], { vars: { i: 0, n: 1, w: 1, h: 1, max: 1, min: 0, sum: 1 }, row: {} }); } catch (e) { errors.push(`${where}.${k}: ${e.message}`); } }
    }
    if (["polyline", "polygon", "area"].includes(s.type) && !Array.isArray(s.points)) errors.push(`${where}.points: a list of [x, y]`);
    if (s.type === "path" && typeof s.d !== "string") errors.push(`${where}.d: an SVG path in scene units`);
    if (s.type === "text" && s.text === undefined) errors.push(`${where}.text: required`);
  };
  if (v.size !== undefined && !(Array.isArray(v.size) && v.size.length === 2 && v.size.every((n) => Number(n) > 0))) errors.push(`${at}.size: [width, height]`);
  if (v.shapes !== undefined && !Array.isArray(v.shapes)) errors.push(`${at}.shapes: a list`);
  (v.shapes || []).forEach((s, i) => shapeErr(s, `${at}.shapes[${i}]`));
  if (v.each !== undefined) {
    if (!v.each || !Array.isArray(v.each.shapes)) errors.push(`${at}.each.shapes: a list of shapes repeated per row`);
    else v.each.shapes.forEach((s, i) => shapeErr(s, `${at}.each.shapes[${i}]`));
    if (!v.source) errors.push(`${at}.each: needs a source to repeat over`);
  }
  if (!(v.shapes || []).length && !v.each) errors.push(`${at}: give shapes, each, or both`);
  if ((v.shapes || []).length > LIMITS.shapes) errors.push(`${at}.shapes: at most ${LIMITS.shapes}`);
  if (v.steps !== undefined) {
    if (!Array.isArray(v.steps)) errors.push(`${at}.steps: a list`);
    else {
      if (v.steps.length > LIMITS.steps) errors.push(`${at}.steps: at most ${LIMITS.steps}`);
      v.steps.forEach((st, i) => {
        if (!st || !VERBS.includes(st.do)) errors.push(`${at}.steps[${i}].do: one of ${VERBS.join(", ")}`);
        if (st?.ease !== undefined && !EASES.includes(st.ease)) errors.push(`${at}.steps[${i}].ease: one of ${EASES.join(", ")}`);
        if (["move", "transform"].includes(st?.do) && (typeof st.to !== "object" || !st.to)) errors.push(`${at}.steps[${i}].to: the properties to reach`);
      });
    }
  }
  return errors;
}
