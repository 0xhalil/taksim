// Copied from src/bricks/data.mjs by scripts/sync-native.mjs; edit that file, then run the script.
// Data bricks: parsers turn raw source output into rows, transforms shape them. Declarative only, no eval:
// agents assemble these by name in a panel spec (see catalog.mjs).

export const PARSERS = ["json", "jsonl", "lines", "csv", "columns", "regex"];

// "a.b.0.c" -> obj.a.b[0].c; an empty path is the value itself. A key with dots goes in brackets:
// "metadata.labels[app.kubernetes.io/name]".
export function get(obj, path) {
  if (path === undefined || path === null || path === "") return obj;
  let v = obj;
  for (const k of [...String(path).matchAll(/\[([^\]]*)\]|[^.[\]]+/g)].map((m) => m[1] ?? m[0])) {
    if (v === null || v === undefined) return undefined;
    v = v[k];
  }
  return v;
}

// parse: "json" | "jsonl" | "lines" | "csv" | "columns" | { regex: "(?<name>…)" }
export function parse(text, how = "lines") {
  const kind = typeof how === "object" && how ? "regex" : how;
  if (kind === "json") return JSON.parse(text);
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  if (kind === "jsonl") return lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  if (kind === "csv") return csvRows(lines);
  if (kind === "tsv") { const [head = [], ...rows] = lines.map((l) => l.split("\t")); return rows.map((c) => Object.fromEntries(head.map((k, i) => [k, c[i]]))); }
  if (kind === "columns") return columnRows(lines);
  if (kind === "regex") return parseLines(lines, how);
  return lines.map((text) => ({ text }));
}

// One line of streamed output (stream commands, tail) -> zero or one row.
export function parseLine(line, how = "lines") {
  if (!line.trim()) return [];
  const kind = typeof how === "object" && how ? "regex" : how;
  if (kind === "json" || kind === "jsonl") { try { return [JSON.parse(line)]; } catch { return [{ text: line }]; } }
  if (kind === "regex") return parseLines([line], how);
  return [{ text: line }];
}

function parseLines(lines, { regex, flags = "" }) {
  const re = new RegExp(regex, flags.replace(/g/g, ""));
  return lines.flatMap((line) => {
    const m = re.exec(line);
    if (!m) return [];
    return [m.groups ? { ...m.groups } : Object.fromEntries(m.slice(1).map((v, i) => [String(i + 1), v]))];
  });
}

function csvRows(lines) {
  const split = (line) => {
    const out = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
    }
    out.push(cur);
    return out;
  };
  const [head, ...rest] = lines;
  if (!head) return [];
  const keys = split(head).map((k) => k.trim());
  return rest.map((l) => Object.fromEntries(split(l).map((v, i) => [keys[i] ?? String(i), v])));
}

// Aligned table output (kubectl, docker, ps). Columns are the runs of characters between positions that are
// blank on every line, so left- and right-aligned columns both work; a run under no header word belongs to
// the column on its left (e.g. the words of "Up 2 hours").
function columnRows(lines) {
  const [head, ...rest] = lines;
  if (!head) return [];
  const width = Math.max(...lines.map((l) => l.length));
  const blank = (i) => lines.every((l) => (l[i] ?? " ") === " ");
  const runs = [];
  for (let i = 0, at = -1; i <= width; i++) {
    const b = i === width || blank(i);
    if (!b && at < 0) at = i;
    if (b && at >= 0) { runs.push([at, i]); at = -1; }
  }
  // A header may contain single spaces ("CONTAINER ID"): a word one space after the previous one, with no
  // data under it, is part of that header. ("%CPU %MEM" in ps has data under both, so they stay apart.)
  const heads = [];
  const empty = (a, b) => rest.every((l) => !l.slice(a, b).trim());
  for (const m of head.matchAll(/\S+/g)) {
    const prev = heads.at(-1), a = m.index, b = a + m[0].length;
    if (prev && a - prev.b === 1 && empty(a, b)) { prev.key += ` ${m[0]}`; prev.b = b; } else heads.push({ key: m[0], a, b });
  }
  const cols = heads.map((h) => ({ key: h.key, a: Infinity, b: -1 }));
  let last = 0;
  for (const [a, b] of runs) {
    let k = heads.findIndex((h) => h.a < b && a < h.b);
    if (k < 0) k = last;
    last = k;
    cols[k].a = Math.min(cols[k].a, a);
    cols[k].b = Math.max(cols[k].b, b);
  }
  // a header word that got no data and follows the previous one by a space is part of it ("Mounted on" in df)
  const merged = [];
  cols.forEach((c, i) => {
    if (c.b < 0 && merged.length && heads[i].a - heads[i - 1].b === 1) merged.at(-1).key += ` ${c.key}`;
    else merged.push(c);
  });
  return rest.map((line) => Object.fromEntries(merged.map((c) => [c.key, c.b < 0 ? "" : line.slice(c.a, c.b).trim()])));
}

// where: { field: value | { eq, ne, in, gt, gte, lt, lte, match, contains } }
export function matches(row, where) {
  if (!where) return true;
  return Object.entries(where).every(([path, cond]) => {
    const v = get(row, path);
    if (cond === null || typeof cond !== "object" || Array.isArray(cond)) return v === cond || String(v) === String(cond);
    return Object.entries(cond).every(([op, x]) => {
      switch (op) {
        case "eq": return v === x || String(v) === String(x);
        case "ne": return !(v === x || String(v) === String(x));
        case "in": return Array.isArray(x) && x.some((y) => y === v || String(y) === String(v));
        case "gt": return Number(v) > Number(x);
        case "gte": return Number(v) >= Number(x);
        case "lt": return Number(v) < Number(x);
        case "lte": return Number(v) <= Number(x);
        case "match": try { return new RegExp(x, "i").test(String(v ?? "")); } catch { return false; }
        case "contains": return String(v ?? "").toLowerCase().includes(String(x).toLowerCase());
        default: return false;
      }
    });
  });
}

// pick, where, sort ("field" or "-field"), limit, applied in that order
export function shape(value, { pick, where, sort, limit } = {}) {
  let v = get(value, pick);
  if (!Array.isArray(v)) return v;
  if (where) v = v.filter((r) => matches(r, where));
  if (sort) {
    const desc = sort.startsWith("-"), key = desc ? sort.slice(1) : sort;
    const cmp = (a, b) => {
      const x = get(a, key), y = get(b, key);
      const nx = Number(x), ny = Number(y);
      const r = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : String(x ?? "").localeCompare(String(y ?? ""));
      return desc ? -r : r;
    };
    v = [...v].sort(cmp);
  }
  if (limit) v = v.slice(0, limit);
  return v;
}

// "{name} is {status.phase}" with values from a row. Fields may have spaces or % ("{CONTAINER ID}", "{%CPU}");
// a placeholder the row has no value for stays as written.
export function fill(template, row = {}) {
  return String(template).replace(/\{([^{}"'\n:]+)\}/g, (all, path) => {
    const v = get(row, path.trim());
    return v === undefined ? all : v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

// What a status word means (Running, Failed, Pending…): ok, warn, err, run, wait, idle or "" — so a scene or a
// table colors by meaning. The native app has the same lists (TaksimKit BrickMath statusTone).
const ST = [
  ["err", /^(fail(ed|ure|ing)?|error(ed)?|crash\w*|timed_out|timeout|startup_failure|rejected|changes_requested|broken|down|oomkilled|critical|fatal|unhealthy|false|imagepullbackoff|errimagepull|evicted|dead|exited)$/],
  ["warn", /^(warn(ing)?|degraded|action_required|unstable|partial\w*|retry(ing)?|flaky|restarting|backoff|terminating|slow)$/],
  ["run", /^(running|in_progress|progressing|started|deploying|building|syncing|rolling\w*|open|active|reconciling|provisioning|updating|containercreating)$/],
  ["wait", /^(queued|pending|waiting|requested|review_required|draft|scheduled|created|new|unknown|stopping)$/],
  ["ok", /^(ok|success|succeeded|successful|pass(ed)?|completed?|done|merged|approved|ready|healthy|true|deployed|available|closed|up|bound)$/],
  ["idle", /^(cancel+ed|skipped|neutral|stale|superseded|inactive|retired|stopped|terminated|suspended)$/],
];
export function statusTone(v) {
  const s = String(v ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!s || s.length > 40) return "";
  for (const w of [s, s.split(/[_(]/)[0]]) for (const [t, re] of ST) if (re.test(w)) return t;
  return "";
}
