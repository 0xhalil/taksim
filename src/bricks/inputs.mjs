// A panel's inputs: what the user changes while the panel runs, and what sources and views follow.
//   inputs: { <name>: { kind: select | text | toggle | slider | row, … } }
//     select  options: ["a", "b"] or { source, field } (the values of a field in a source's rows), default
//     text    a search box; default ""
//     toggle  on or off; default false
//     slider  a number between min and max: { min, max, step?, unit?, default? }
//     row     the row the user clicked in a table or log view: { view, field } (the field's value), default null
// Sources take values as {{in.<name>}} in their commands, URLs, paths and SQL queries; a change re-runs only
// the sources that use it. The user approves a source once, as written with its {{in.…}}: picking another value
// doesn't ask again. Views can show only while an input has a value (when) and narrow their rows by one (filter).

export const INPUT_KINDS = ["select", "text", "toggle", "slider", "row"];
export const INPUT_LIMITS = { inputs: 8, actions: 6, options: 50, value_chars: 200 };

const REF = /\{\{\s*in\.([A-Za-z_]\w*)\s*\}\}/g;

export const INPUTS_DESC = {
  inputs: "Controls the user changes while the panel runs, drawn in a strip above the views: "
    + "{ <name>: { kind: \"select\", options: [\"prod\", \"staging\"] | { source, field }, default } | { kind: \"text\", default: \"\" } "
    + "| { kind: \"toggle\", default: false } | { kind: \"slider\", min, max, step?, unit?, default } | { kind: \"row\", view: \"<table or log view id>\", field: \"<field>\" } } (each may have a one-word label). "
    + "Use {{in.<name>}} in a source's run, url, path or SQL query: changing the input re-runs that source (approval covers the template, not each value). "
    + "A \"row\" input is the clicked row of a view: pair it with a view that has when: \"<name>\" for master/detail (pick a pod, see its logs). "
    + "A \"slider\" is a number for counts and cutoffs (\"top {{in.n}} processes\", \"errors in the last {{in.h}} hours\").",
  actions: "Buttons in the panel's strip: [{ label, icon?: SF Symbol name, run: [argv] | ask: \"text\", refresh?: true }]; "
    + "{{in.<name>}} works in them too. run needs edit access and the user's approval, like row actions.",
  when: "view field: show the view only while this input has a value (a picked row, a non-empty search, a toggle that is on)",
  filter: "table/log view field: { input: \"<text input>\", fields?: [\"…\"] } keeps the rows whose fields contain the text (case-insensitive), without re-running the source",
};

/** the input names a value (a source, an action) refers to with {{in.x}} */
export function refsOf(value, out = new Set()) {
  if (typeof value === "string") for (const m of value.matchAll(REF)) out.add(m[1]);
  else if (Array.isArray(value)) value.forEach((v) => refsOf(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => refsOf(v, out));
  return out;
}

export function validateInputs(input, { views = [], sources = {} } = {}) {
  const errors = [], inputs = {};
  if (input === undefined || input === null) return { inputs: undefined, errors };
  if (typeof input !== "object" || Array.isArray(input)) return { inputs: undefined, errors: ["inputs must be an object of name -> input"] };
  const names = Object.keys(input);
  if (names.length > INPUT_LIMITS.inputs) errors.push(`at most ${INPUT_LIMITS.inputs} inputs`);
  for (const name of names) {
    const d = input[name], at = `inputs.${name}`;
    if (!/^[A-Za-z_]\w{0,30}$/.test(name)) { errors.push(`${at}: names may use letters, digits and _`); continue; }
    if (!d || typeof d !== "object" || !INPUT_KINDS.includes(d.kind)) { errors.push(`${at}.kind: one of ${INPUT_KINDS.join(", ")}`); continue; }
    const out = { kind: d.kind, ...(typeof d.label === "string" ? { label: d.label.slice(0, 24) } : {}) };
    if (d.kind === "select") {
      if (Array.isArray(d.options)) {
        if (!d.options.length || d.options.length > INPUT_LIMITS.options || !d.options.every((o) => typeof o === "string" || typeof o === "number")) {
          errors.push(`${at}.options: 1-${INPUT_LIMITS.options} strings`);
        } else out.options = d.options.map(String);
      } else if (d.options && typeof d.options === "object") {
        if (!(d.options.source in sources)) errors.push(`${at}.options.source: no source "${d.options.source}"`);
        if (typeof d.options.field !== "string") errors.push(`${at}.options.field: the field holding the values`);
        out.options = { source: d.options.source, field: d.options.field };
      } else errors.push(`${at}.options: a list, or { source, field }`);
      out.default = d.default === undefined || d.default === null ? (Array.isArray(out.options) ? out.options[0] : null) : String(d.default);
    } else if (d.kind === "text") {
      out.default = typeof d.default === "string" ? d.default.slice(0, INPUT_LIMITS.value_chars) : "";
    } else if (d.kind === "toggle") {
      out.default = d.default === true;
    } else if (d.kind === "slider") {
      const num = (v, what) => {
        if (typeof v !== "number" || !Number.isFinite(v)) { errors.push(`${at}.${what}: a number`); return null; }
        return v;
      };
      const min = num(d.min, "min"), max = num(d.max, "max");
      if (min === null || max === null) continue;
      if (!(min < max)) { errors.push(`${at}: min must be below max`); continue; }
      let step = d.step === undefined ? null : num(d.step, "step");
      if (step !== null && !(step > 0 && step <= max - min)) { errors.push(`${at}.step: between 0 and max-min`); continue; }
      if (d.unit !== undefined && (typeof d.unit !== "string" || d.unit.length > 12)) { errors.push(`${at}.unit: at most 12 characters`); continue; }
      let dv = d.default === undefined || d.default === null ? min : Number(d.default);
      if (!Number.isFinite(dv)) { errors.push(`${at}.default: a number between min and max`); continue; }
      dv = Math.min(max, Math.max(min, dv));
      Object.assign(out, { min, max, step, unit: typeof d.unit === "string" ? d.unit : null,
        default: step ? Math.min(max, parseFloat((min + Math.round((dv - min) / step) * step).toFixed(6))) : dv });
    } else {
      const v = views.find((x) => x.id === d.view);
      if (!v || !["table", "log"].includes(v.brick)) errors.push(`${at}.view: the id of a table or log view`);
      if (typeof d.field !== "string" || !d.field) errors.push(`${at}.field: the row field that becomes the value`);
      Object.assign(out, { view: d.view, field: d.field, default: null });
    }
    inputs[name] = out;
  }
  return { inputs, errors };
}

/** checks what the panel uses: {{in.x}} names, when, filter, actions */
export function checkUses(spec, errors) {
  const known = new Set(Object.keys(spec.inputs || {}));
  const unknown = (where, names) => { for (const n of names) if (!known.has(n)) errors.push(`${where}: no input "${n}"; inputs: ${[...known].join(", ") || "none"}`); };
  for (const [name, s] of Object.entries(spec.sources || {})) unknown(`sources.${name}`, refsOf(s));
  for (const v of spec.views || []) {
    if (v.when !== undefined) unknown(`views.${v.id}.when`, [String(v.when)]);
    if (v.filter !== undefined) {
      if (!v.filter || typeof v.filter.input !== "string") errors.push(`views.${v.id}.filter: { input, fields? }`);
      else if (spec.inputs?.[v.filter.input]?.kind !== "text") errors.push(`views.${v.id}.filter.input: the name of a text input`);
    }
    for (const a of v.row_actions || []) unknown(`views.${v.id}.row_actions`, refsOf(a));
  }
  for (const [i, a] of (spec.actions || []).entries()) unknown(`actions[${i}]`, refsOf(a));
}

export function validateActions(input, { readOnly = false } = {}) {
  const errors = [];
  if (input === undefined || input === null) return { actions: undefined, errors };
  if (!Array.isArray(input)) return { actions: undefined, errors: ["actions must be a list"] };
  if (input.length > INPUT_LIMITS.actions) errors.push(`at most ${INPUT_LIMITS.actions} actions`);
  const actions = [];
  input.forEach((a, i) => {
    const at = `actions[${i}]`;
    if (!a || typeof a.label !== "string") { errors.push(`${at}.label: required`); return; }
    const run = Array.isArray(a.run) && a.run.length && a.run.every((x) => typeof x === "string") ? a.run : null;
    if (!run && typeof a.ask !== "string") { errors.push(`${at}: needs "ask" (text) or "run" (argv)`); return; }
    if (run && readOnly) errors.push(`${at}: run actions need edit access; this agent is read-only (use ask instead)`);
    actions.push({ label: a.label.slice(0, 40), ...(typeof a.icon === "string" ? { icon: a.icon } : {}),
      ...(run ? { run } : { ask: a.ask }), ...(a.refresh ? { refresh: true } : {}) });
  });
  return { actions, errors };
}

/** the values the panel starts with */
export const defaults = (inputs) => Object.fromEntries(Object.entries(inputs || {}).map(([k, d]) => [k, d.default ?? null]));

/** a value the user (or the agent) picked, made what the input holds; throws a message for a bad one */
export function checkValue(def, v) {
  if (def.kind === "toggle") return v === true || v === "true";
  if (def.kind === "slider") {
    const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
    if (!Number.isFinite(n)) throw new Error("a number");
    const c = Math.min(def.max, Math.max(def.min, n));
    if (!def.step) return c;
    return Math.min(def.max, parseFloat((def.min + Math.round((c - def.min) / def.step) * def.step).toFixed(6)));
  }
  if (v === null || v === undefined || v === "") return def.kind === "text" ? "" : null;
  const s = String(v);
  if (s.length > INPUT_LIMITS.value_chars) throw new Error(`too long (at most ${INPUT_LIMITS.value_chars} characters)`);
  if (/[\r\n\0]/.test(s)) throw new Error("one line only");
  if (def.kind === "select" && Array.isArray(def.options) && !def.options.includes(s)) throw new Error(`one of ${def.options.join(", ")}`);
  return s;
}

/** a value as text, for a template */
const asText = (v) => (v === true ? "true" : v === false ? "false" : v === null || v === undefined ? "" : String(v));

/**
 * A source (or action) with its {{in.x}} filled. Values go in as written, with three guards: an argv element
 * can't become an option ("-…"), a value in a URL is URL-encoded, and a value in a file path can't leave the
 * folder ("/" or ".."). Returns { value } or { error }.
 */
export function fillInputs(def, values) {
  try {
    const filled = structuredClone(def);
    const sub = (s, mode) => s.replace(REF, (_, n) => {
      const v = asText(values[n]);
      if (mode === "url") return encodeURIComponent(v);
      if (mode === "sql") return v.replace(/'/g, "''"); // a value inside '…' stays one string
      if (mode === "path" && (v.includes("/") || v.includes(".."))) throw new Error(`"${v}" can't be part of a file path`);
      return v;
    });
    if (Array.isArray(filled.run)) {
      filled.run = filled.run.map((t) => {
        const out = sub(t, "argv");
        if (t !== out && out.startsWith("-") && !t.trimStart().startsWith("-")) throw new Error(`refusing "${out}": an input can't start with "-"`);
        return out;
      });
    }
    if (typeof filled.url === "string") filled.url = sub(filled.url, "url");
    if (typeof filled.path === "string") filled.path = sub(filled.path, "path");
    const deep = (x) => (typeof x === "string" ? sub(x, "text") : Array.isArray(x) ? x.map(deep)
      : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, deep(y)])) : x);
    if (filled.brick === "sql" && typeof filled.query === "string") filled.query = sub(filled.query, "sql");
    for (const k of Object.keys(filled)) if (!["run", "url", "path", ...(filled.brick === "sql" ? ["query"] : [])].includes(k)) filled[k] = deep(filled[k]);
    return { value: filled };
  } catch (e) {
    return { error: e.message };
  }
}
