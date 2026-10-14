// The brick catalog: what an agent can put in a panel spec, how a spec is checked, and which parts of it
// need the user's approval. A spec is data, never code:
//   { title, sources: { <name>: { brick, …, parse, pick, where, sort, limit } }, views: [ { brick, source, … } ] }
// Adding a brick is one entry here (plus its runner in panels/panel.mjs or its renderer in ui/canvas/bricks.mjs).

import { SQL_ENGINES, checkSql } from "./sql.mjs";
import { CONNECTORS, PANEL_SERVICES, checkConnector, connectedServices } from "../connectors.mjs";
import { resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { PARSERS } from "./data.mjs";
import { validateScene, SHAPES, VERBS, COLORS } from "./scene.mjs";
import { validateInputs, validateActions, checkUses, INPUTS_DESC } from "./inputs.mjs";

export const LIMITS = { sources: 8, views: 16, min_every_s: 2, rows: 1000 };

const f = (type, desc, extra = {}) => ({ type, desc, ...extra });

const SHAPE = {
  parse: f("parse", `how to read the output: ${PARSERS.filter((p) => p !== "regex").join(", ")} or {"regex": "^(?<level>\\\\w+) (?<msg>.*)$"} (named groups become fields). "columns" reads aligned tables like kubectl/docker output.`),
  pick: f("string", "path to the part to use, e.g. \"items\" or \"data.result\""),
  where: f("where", "keep rows matching {field: value} or {field: {eq|ne|in|gt|gte|lt|lte|match|contains: x}}"),
  sort: f("string", "field to sort by; \"-field\" for descending"),
  limit: f("number", `max rows (at most ${LIMITS.rows})`),
};

export const SOURCES = {
  command: {
    desc: "Runs a program (argv, no shell) in your working directory: once, every N seconds, or as a stream of lines.",
    fields: { run: f("argv", "program and arguments, e.g. [\"docker\", \"ps\", \"--format\", \"{{json .}}\"]", { required: true }),
      every_s: f("number", `re-run every N seconds (min ${LIMITS.min_every_s})`), stream: f("boolean", "long-running command whose output lines are appended (e.g. kubectl get events -w, tail -f)"), ...SHAPE },
    example: { brick: "command", run: ["docker", "ps", "--format", "{{json .}}"], parse: "jsonl", every_s: 5 },
  },
  tail: {
    desc: "Follows a text file (e.g. a log): its last lines, then new lines as they are written.",
    fields: { path: f("string", "file path, relative to your working directory or absolute", { required: true }),
      lines: f("number", "lines to show from the end at start (default 200)"), ...SHAPE },
    example: { brick: "tail", path: "logs/app.log", parse: { regex: "^(?<ts>\\S+) (?<level>\\w+) (?<msg>.*)$" } },
  },
  http: {
    desc: "Fetches a URL (GET), once or every N seconds.",
    fields: { url: f("string", "http(s) URL", { required: true }), every_s: f("number", "re-fetch every N seconds"), ...SHAPE },
    example: { brick: "http", url: "http://localhost:3000/health", parse: "json", every_s: 10 },
  },
  sql: {
    desc: "A read-only SQL query against a database, through its own client (sqlite3, duckdb, psql, mysql, clickhouse, bq, snow), so the user's existing login is used. "
      + "One reading statement (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN); the rows become the source's data. Put {{in.x}} inside quotes: '{{in.x}}' (quotes in values are escaped). "
      + "For a schema explorer, schema: \"tables\" lists tables and views instead of a query, and schema: \"columns\" with a table (or {{in.t}}) lists its columns.",
    fields: { engine: f("string", `one of ${Object.keys(SQL_ENGINES).join(", ")}`, { required: true }),
      db: f("string", "sqlite/duckdb: the database file; postgres: a connection string or service; mysql: the database; clickhouse: host; bigquery: project; snowflake: connection name"),
      query: f("string", "the SELECT to run (not with schema)"), schema: f("enum", "list the database itself instead of running a query", { values: ["tables", "columns"] }),
      table: f("string", "the table for schema: columns (plain dotted name, or {{in.t}})"),
      every_s: f("number", "re-run every N seconds"), ...SHAPE },
    example: { brick: "sql", engine: "sqlite", db: "app.db", query: "SELECT status, count(*) AS n FROM orders GROUP BY status", every_s: 30 },
  },
  connector: {
    desc: "Reads a service the user connected in taksim (Slack, GitHub, Linear, Jira) with its own token, which you never see: read-only calls, paged. "
      + "Use it for dashboards fed by those services (messages per channel, open PRs, issues by state, sprint progress).",
    fields: { service: f("string", `one of ${PANEL_SERVICES.join(", ")} (only the connected ones work; see "connected")`, { required: true }),
      call: f("string", PANEL_SERVICES.map((k) => CONNECTORS[k]).map((c) => `${c.label}: ${c.callDesc}`).join("; "), { required: true }),
      params: f("object", "the call's arguments"), pages: f("number", "how many pages to read (default 1, at most 5)"),
      every_s: f("number", "re-read every N seconds (at least 30)"), ...SHAPE },
    example: CONNECTORS.slack.example,
  },
  agent: {
    desc: "Data you push yourself with panel_push: findings, summaries, tables you computed.",
    fields: { ...SHAPE },
    example: { brick: "agent" },
  },
};

const ACTIONS_DESC = "row actions: [{label, ask: \"why is {name} failing?\"}] sends the user's click to you as a message with the row; "
  + "[{label, run: [\"docker\", \"restart\", \"{Names}\"], refresh: true}] runs a program with row values (needs edit access)";

const AGG = ["count", "sum", "avg", "max", "min", "last"];
const TIME = "a time: ISO date, epoch seconds or ms, or an age as CLIs print it (\"47m\", \"2d3h\", \"5m ago\", kubectl AGE)";

export const VIEWS = {
  scene: { desc: "A small animated picture you design from shapes, to EXPLAIN something the other views can't show (in the spirit of 3Blue1Brown): "
      + "a pipeline with items moving between stages, a request's path through services, a queue filling up, before/after of a change, a cluster's nodes and pods, how a retry/backoff works. "
      + "Write shapes in scene units (size, default 400x240; x right, y down) or in data units with \"data\": true against the view's x/y frames (y up). "
      + "Repeat shapes per row of a source with each (templates: \"{field}\", \"{i}\" row index, \"{n}\" row count, \"{max}\"/\"{min}\"/\"{sum}\" of each.value, arithmetic like \"{i*60+20}\" or \"{value/max*180}\", conditions like \"{STATUS == 'Running' ? 'ok' : 'err'}\"); "
      + "when the data changes, shapes with the same key glide to their new values, new ones fade in, gone ones fade out. "
      + "Tell the story with steps, played in order when the view appears (Manim-like): create (draws outlines), write (types text), fade_in, fade_out, grow, move/transform (to: new props), indicate (a pulse), wait. "
      + `Shape types: ${SHAPES.join(", ")}. Colors are theme words only: ${COLORS.join(", ")}, or \"status:<word>\" to color by meaning (Running, Failed, Pending…). Keep it simple: a few shapes, a few steps, labels short.`,
    fields: {
      size: f("any", "[width, height] in scene units (default [400, 240])"),
      x: f("any", "data frame for shapes with data: true, {min, max}"), y: f("any", "data frame for y, {min, max} (grows upward)"),
      shapes: f("any", "fixed shapes: [{id, type, x, y, w, h, r, rx, x2, y2, points, d, text, size, weight, align, color, fill, width, opacity, dash, rotate, data}]"),
      each: f("any", "{rows?: path to the list in the data, key?: field that identifies a row, value?: numeric field for {max}/{min}/{sum}, shapes: [shape templates]}"),
      steps: f("any", `[{do: ${VERBS.join("|")}, target: shape id (or the id inside each, or \"*\"), at?: seconds, dur?: seconds (0.6), to?: {props}, ease?: smooth|linear|spring}]`),
      loop: f("boolean", "replay the steps when they end"),
      move_s: f("number", "seconds keyed shapes take to reach new data (default 0.6)"),
    }, span: 4, sourceOptional: true },
  table: { desc: "Rows as a table. Animated: on refresh rows slide to their new place, new rows slide in, changed cells flash and numbers count up/down; the user can sort by a column.",
    fields: { columns: f("columns", "fields to show, e.g. [\"name\", \"status.phase\"] or [{\"field\": \"status.phase\", \"label\": \"Durum\"}]; default: all"),
      key: f("string", "field that identifies a row across refreshes (default: the first column)"),
      bar: f("string", "a numeric column to draw as a proportional bar behind its values, e.g. \"RESTARTS\""),
      row_actions: f("actions", ACTIONS_DESC) }, span: 4 },
  log: { desc: "Lines as a scrolling log, newest at the bottom.", fields: { text: f("paths", "field with the line text, or a list of fields (first non-empty wins, e.g. [\"textPayload\", \"jsonPayload.message\"]); default \"text\", or the whole row"), level: f("string", "field with the level (error/warn/info…) for coloring"), row_actions: f("actions", ACTIONS_DESC) }, span: 4 },
  stat: { desc: "One big number or word, colored by thresholds.", fields: { value: f("string", "path to the value (default: the row count of a list)"), unit: f("string", "unit shown after the value"), ok: f("any", "value that means healthy (green); anything else is a warning"), warn_above: f("number", "amber above this"), error_above: f("number", "red above this") }, span: 1 },
  kv: { desc: "An object's fields as label/value pairs (first row of a list).", fields: { fields: f("columns", "fields to show; default: all") }, span: 2 },
  markdown: { desc: "Text you write: a summary, explanation or checklist. Static \"text\" or a source that holds a string.", fields: { text: f("string", "markdown, when no source is given") }, span: 4, sourceOptional: true },
  json: { desc: "Raw data as indented JSON, for anything without a better view.", fields: {}, span: 4 },
  chart: { desc: "A live time series: use it to show a trend or to explain how something changes (latency, error count, CPU, queue depth, pods ready). Each refresh of the source adds one sample at the time it arrives; the line scrolls, new values ease in, the latest value is shown big. With x, rows that carry their own time are plotted directly (e.g. commits per day, run durations).",
    fields: {
      y: f("paths", "field path, or a list of paths for several series (numbers; units like \"250m\", \"512Mi\", \"37%\" are read). Default: the row count of a list, or the value itself"),
      agg: f("enum", `how one refresh's rows become one number per series: ${AGG.join(" | ")}. Default: count without y, sum with y`, { values: AGG }),
      x: f("string", `field with each row's own time (${TIME}); rows with the same time become one point (agg as above)`),
      kind: f("enum", "line | area | bar (default line)", { values: ["line", "area", "bar"] }),
      window_s: f("number", "seconds of history to show (default 300; with x: all rows)"),
      unit: f("string", "unit shown after the value, e.g. \"ms\""),
      scale: f("number", "multiply values, e.g. 1000 for seconds -> ms"),
      stacked: f("boolean", "stack the series (area or bar)"),
      warn_above: f("number", "amber dashed line and value above this"), error_above: f("number", "red dashed line and value above this"),
    }, span: 2 },
  timeline: { desc: "Intervals on a time axis (a Gantt chart): use it for durations and waiting — CI runs, deploys, rollouts, how long each PR or job has been open. Bars run from start to end, colored by status; an interval with no end (or a running/queued/pending status) grows live up to the \"now\" line. Hovering a bar shows its times and duration.",
    fields: {
      start: f("string", `field with the start (${TIME})`, { required: true }),
      end: f("string", "field with the end (same formats); missing = still open"),
      duration: f("string", "field with a duration instead of end (seconds, or \"1m30s\")"),
      label: f("string", "field naming each bar"),
      group: f("string", "field to group bars into lanes (e.g. workflow, service, author)"),
      status: f("paths", "field (or list of fields, first non-empty wins, e.g. [\"conclusion\", \"status\"]) colored by meaning: success/failed/running/queued/cancelled…"),
      window_s: f("number", "show only the last N seconds (default: from the earliest start)"),
    }, span: 4 },
  bars: { desc: "Ranked horizontal bars (a bar-chart race): use it for rankings and \"who/what has the most\" — restarts per pod, CPU per pod, issues per assignee, commits per author. Rows with the same label are added up (or counted when there is no value); on refresh bars slide to their new rank and numbers count to their new value.",
    fields: {
      label: f("string", "field naming each bar", { required: true }),
      value: f("string", "numeric field (units like \"250m\", \"512Mi\" are read); default: count rows per label"),
      agg: f("enum", `${AGG.join(" | ")} for rows with the same label (default: sum with value, count without)`, { values: AGG }),
      limit: f("number", "how many bars (default 10)"),
      max: f("number", "the value of a full bar (e.g. 100 for percent); default: the largest"),
      unit: f("string", "unit after each value"),
      warn_above: f("number", "amber bars above this"), error_above: f("number", "red bars above this"),
    }, span: 2 },
};

const VIEW_COMMON = { id: f("string", "stable id, so panel_patch can change or remove this view"), title: f("string", "heading"), source: f("string", "name of a source"), span: f("number", "width in quarters of the panel, 1-4"),
  when: f("string", INPUTS_DESC.when), filter: f("filter", INPUTS_DESC.filter) };

// Catalog for list_bricks: compact, with an example spec.
export function catalog() {
  const brief = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { desc: v.desc,
    fields: Object.fromEntries(Object.entries(v.fields).map(([n, x]) => [n, `${x.desc}${x.required ? " (required)" : ""}`])),
    ...(v.example ? { example: v.example } : {}) }]));
  return {
    spec: "{ title, sources: { <name>: <source> }, views: [ <view> ], inputs?: { <name>: <input> }, actions?: [ <button> ] }",
    inputs: INPUTS_DESC.inputs,
    actions: INPUTS_DESC.actions,
    sources: brief(SOURCES),
    connected: connectedServices(),
    views: brief(VIEWS),
    view_fields: Object.fromEntries(Object.entries(VIEW_COMMON).map(([n, x]) => [n, x.desc])),
    limits: LIMITS,
    approval: "Commands, run actions, files outside your directory and non-local URLs run only after the user approves them (or has turned on auto-approve for you); the other sources run at once. View changes never need approval.",
    example: {
      title: "Local services",
      sources: {
        ps: { brick: "command", run: ["docker", "ps", "--format", "{{json .}}"], parse: "jsonl", every_s: 5 },
        log: { brick: "tail", path: "logs/app.log", parse: { regex: "^(?<ts>\\S+) (?<level>\\w+) (?<msg>.*)$" } },
        notes: { brick: "agent" },
      },
      views: [
        { id: "count", brick: "stat", source: "ps", title: "Containers" },
        { id: "trend", brick: "chart", source: "ps", title: "Containers over time" },
        { id: "ps", brick: "table", source: "ps", columns: ["Names", "Status", "Image"], row_actions: [{ label: "Explain", ask: "Why is {Names} in state {Status}?" }] },
        { id: "log", brick: "log", source: "log", text: "msg", level: "level" },
        { id: "notes", brick: "markdown", source: "notes", title: "Findings" },
      ],
    },
    interactive_example: {
      title: "Pods",
      inputs: {
        ns: { kind: "select", options: ["default", "prod", "staging"], label: "namespace" },
        q: { kind: "text" },
        pod: { kind: "row", view: "pods", field: "metadata.name" },
      },
      sources: {
        pods: { brick: "command", run: ["kubectl", "get", "pods", "-n", "{{in.ns}}", "-o", "json"], parse: "json", pick: "items", every_s: 10 },
        logs: { brick: "command", run: ["kubectl", "logs", "-n", "{{in.ns}}", "{{in.pod}}", "--tail", "200"], parse: "lines", every_s: 5 },
      },
      views: [
        { id: "pods", brick: "table", source: "pods", columns: ["metadata.name", "status.phase"], filter: { input: "q" } },
        { id: "logs", brick: "log", source: "logs", when: "pod", title: "Logs" },
      ],
      actions: [{ label: "Restart", icon: "arrow.clockwise", run: ["kubectl", "rollout", "restart", "deployment", "-n", "{{in.ns}}"], refresh: true }],
    },
  };
}

// Checks a spec and returns { spec, errors }; the returned spec has view ids and clamped numbers.
export function validate(input, { readOnly = false } = {}) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { spec: null, errors: ["spec must be an object {title, sources, views}"] };
  const spec = { title: typeof input.title === "string" ? input.title.slice(0, 120) : "Panel", sources: {}, views: [] };
  const sources = input.sources ?? {};
  if (typeof sources !== "object" || Array.isArray(sources)) errors.push("sources must be an object of name -> source");
  const names = Object.keys(sources || {});
  if (names.length > LIMITS.sources) errors.push(`at most ${LIMITS.sources} sources`);
  for (const name of names) {
    const s = sources[name], at = `sources.${name}`;
    if (!/^[\w-]{1,40}$/.test(name)) { errors.push(`${at}: names may use letters, digits, _ and -`); continue; }
    if (!s || typeof s !== "object") { errors.push(`${at}: must be an object`); continue; }
    const def = SOURCES[s.brick];
    if (!def) { errors.push(`${at}.brick: unknown source "${s.brick}"; one of ${Object.keys(SOURCES).join(", ")}`); continue; }
    errors.push(...checkFields(s, def.fields, at));
    if (readOnly && ["command", "sql"].includes(s.brick)) errors.push(`${at}: command and SQL sources need Agent mode; this agent is read-only`);
    const out = { ...s };
    if (out.every_s !== undefined) out.every_s = Math.max(LIMITS.min_every_s, Number(out.every_s) || LIMITS.min_every_s);
    if (out.limit !== undefined) out.limit = Math.min(LIMITS.rows, Math.max(1, Math.floor(Number(out.limit)) || LIMITS.rows));
    if (s.brick === "http" && !/^https?:\/\//i.test(String(s.url || ""))) errors.push(`${at}.url: must start with http:// or https://`);
    if (s.brick === "sql") errors.push(...checkSql(s, at));
    if (s.brick === "connector") {
      errors.push(...checkConnector(s, at));
      if (out.every_s !== undefined) out.every_s = Math.max(30, out.every_s); // services limit how often they may be asked
    }
    spec.sources[name] = out;
  }
  const views = input.views ?? [];
  if (!Array.isArray(views)) errors.push("views must be a list");
  else if (views.length > LIMITS.views) errors.push(`at most ${LIMITS.views} views`);
  const ids = new Set();
  (Array.isArray(views) ? views : []).forEach((v, i) => {
    const at = `views[${i}]`;
    if (!v || typeof v !== "object") { errors.push(`${at}: must be an object`); return; }
    const def = VIEWS[v.brick];
    if (!def) { errors.push(`${at}.brick: unknown view "${v.brick}"; one of ${Object.keys(VIEWS).join(", ")}`); return; }
    errors.push(...checkFields(v, { ...VIEW_COMMON, ...def.fields }, at));
    if (v.brick === "scene") errors.push(...validateScene(v, at));
    if (v.source !== undefined && !(v.source in (sources || {}))) errors.push(`${at}.source: no source "${v.source}"; sources: ${names.join(", ") || "none"}`);
    if (v.source === undefined && !def.sourceOptional) errors.push(`${at}.source: required for ${v.brick}`);
    for (const [j, a] of (v.row_actions || []).entries()) {
      if (a?.run && readOnly) errors.push(`${at}.row_actions[${j}]: run actions need edit access; this agent is read-only (use ask instead)`);
    }
    const id = String(v.id || `v${i + 1}`);
    if (ids.has(id)) errors.push(`${at}.id: "${id}" is used twice`);
    ids.add(id);
    spec.views.push({ ...v, id, span: Math.min(4, Math.max(1, Math.floor(Number(v.span)) || def.span)) });
  });
  const vi = validateInputs(input.inputs, { views: spec.views, sources: spec.sources });
  errors.push(...vi.errors);
  if (vi.inputs && Object.keys(vi.inputs).length) spec.inputs = vi.inputs;
  const va = validateActions(input.actions, { readOnly });
  errors.push(...va.errors);
  if (va.actions?.length) spec.actions = va.actions;
  checkUses(spec, errors);
  return { spec: errors.length ? null : spec, errors };
}

function checkFields(obj, fields, at) {
  const errors = [];
  for (const [name, def] of Object.entries(fields)) {
    const v = obj[name];
    if (v === undefined || v === null) { if (def.required) errors.push(`${at}.${name}: required (${def.desc})`); continue; }
    const bad = (want) => errors.push(`${at}.${name}: must be ${want}`);
    switch (def.type) {
      case "string": if (typeof v !== "string") bad("a string"); break;
      case "paths": if (!(typeof v === "string" || (Array.isArray(v) && v.length && v.every((x) => typeof x === "string")))) bad("a field path or a list of them"); break;
      case "enum": if (!def.values.includes(v)) bad(`one of ${def.values.join(", ")}`); break;
      case "number": if (!Number.isFinite(Number(v))) bad("a number"); break;
      case "boolean": if (typeof v !== "boolean") bad("true or false"); break;
      case "argv": if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === "string") || !v[0]) bad("a non-empty list of strings (program, then arguments)"); break;
      case "columns": if (!Array.isArray(v) || !v.every((x) => typeof x === "string" || (x && typeof x.field === "string"))) bad("a list of field paths or {field, label}"); break;
      case "where": if (typeof v !== "object" || Array.isArray(v)) bad("an object {field: condition}"); break;
      case "parse":
        if (typeof v === "string" ? !PARSERS.includes(v) || v === "regex" : typeof v !== "object" || typeof v.regex !== "string") bad(`one of ${PARSERS.filter((p) => p !== "regex").join(", ")} or {"regex": "…"}`);
        else if (typeof v === "object") { try { new RegExp(v.regex); } catch (e) { errors.push(`${at}.${name}.regex: ${e.message}`); } }
        break;
      case "actions":
        if (!Array.isArray(v)) { bad("a list"); break; }
        v.forEach((a, j) => {
          const aa = `${at}.${name}[${j}]`;
          if (!a || typeof a.label !== "string") errors.push(`${aa}.label: required`);
          else if (typeof a.ask !== "string" && !(Array.isArray(a.run) && a.run.length && a.run.every((x) => typeof x === "string"))) errors.push(`${aa}: needs "ask" (text) or "run" (argv)`);
        });
        break;
    }
  }
  return errors;
}

// The parts of a spec that reach outside the panel: what the user approves. Views don't count.
export function reach(spec, workDir) {
  const items = [];
  for (const [name, s] of Object.entries(spec?.sources || {})) {
    if (s.brick === "command") items.push({ at: `sources.${name}`, kind: "command", argv: s.run, every_s: s.every_s || null, stream: !!s.stream });
    else if (s.brick === "http" && !isLocalUrl(s.url)) items.push({ at: `sources.${name}`, kind: "http", url: s.url });
    // a query reads a database the user can reach: approved once, as written
    else if (s.brick === "connector") items.push({ at: `sources.${name}`, kind: "connector", service: s.service, call: s.call, params: s.params || {}, every_s: s.every_s || null });
    else if (s.brick === "sql") items.push({ at: `sources.${name}`, kind: "sql", engine: s.engine, db: s.db || null, query: s.query, every_s: s.every_s || null });
    else if (s.brick === "tail") {
      const p = resolvePath(s.path, workDir);
      if (!under(p, workDir)) items.push({ at: `sources.${name}`, kind: "file", path: p });
    }
  }
  for (const v of spec?.views || []) {
    for (const a of v.row_actions || []) if (a.run) items.push({ at: `views.${v.id}`, kind: "action", label: a.label, argv: a.run });
  }
  for (const a of spec?.actions || []) if (a.run) items.push({ at: "actions", kind: "action", label: a.label, argv: a.run });
  return items;
}

export const reachHash = (items) => items.length ? createHash("sha256").update(JSON.stringify(items)).digest("hex").slice(0, 16) : null;

export function resolvePath(p, workDir) {
  let s = String(p || "");
  if (s === "~" || s.startsWith("~/")) s = homedir() + s.slice(1);
  return isAbsolute(s) ? resolve(s) : resolve(workDir, s);
}
const under = (p, dir) => p === dir || p.startsWith(dir.replace(/\/+$/, "") + "/");

function isLocalUrl(u) {
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(u).hostname); } catch { return false; }
}

// Files no panel may read, approved or not: where logins and keys live.
const SECRET = [".ssh", ".aws", ".gnupg", ".claude", ".codex", ".taksim/accounts", ".config/gcloud", ".kube/config", ".netrc", ".docker/config.json"];
export function isSecretPath(p) {
  const home = homedir();
  return SECRET.some((d) => under(p, resolve(home, d)));
}
