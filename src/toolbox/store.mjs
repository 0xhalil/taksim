// Saved tools: a panel spec that worked, made reusable and shareable. A tool is data, never code:
//   { id, name, summary, when: [phrases a person says when they need it], keywords, requires: { bin },
//     params: { <name>: { desc, default } }, instructions (for the agent), spec (panel spec with {{param}}),
//     preview: { data: { <source>: sample }, at }, author, origin, uses, learned }
// Where they live:
//   builtin   <taksim>/toolbox/*.json             shipped with taksim, read-only (an edit saves a copy below)
//   library   ~/.taksim/toolbox/*.json            the user's own, and the ones added from the market
//   market    shelves: ~/.taksim/market/ plus TAKSIM_MARKET (comma-separated folders, or URLs of other taksim
//             servers). A shared folder or a teammate's taksim is how a team shares tools.
// Agents can use builtin and library tools. A market tool runs someone else's commands, so the user adds it
// to their library first, after seeing what it runs; its panel still asks before running anything.

import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { ROOT } from "../config.mjs";
import { HOME } from "../canvas/store.mjs";
import { validate, reach } from "../bricks/catalog.mjs";
import { httpError } from "../http.mjs";
import { T } from "../lang.mjs";
import { rank, tokens } from "./match.mjs";
import { readToken } from "../connectors.mjs";

const BUILTIN = join(ROOT, "toolbox");
const LIBRARY = join(HOME, "toolbox");
const LOCAL_MARKET = join(HOME, "market");
const LIMITS = { when: 24, keywords: 30, learned: 20, params: 12, instructions: 6000, preview: 48000, previewRows: 15, previewSamples: 120 };

const ID = /^[a-z0-9][a-z0-9-]{1,47}$/;
export const slug = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i")
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "arac";
export const author = () => process.env.TAKSIM_AUTHOR || (() => { try { return userInfo().username; } catch { return "anon"; } })();

// ---------- shape ----------

const strList = (v, max, len = 160) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/\n|,/) : [])
  .map((x) => String(x).trim().slice(0, len)).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).slice(0, max);

// Checks and cleans a tool; throws 400 with every problem found.
export function normalize(input, { origin } = {}) {
  const t = input && typeof input === "object" ? input : {};
  const errors = [];
  const id = t.id ? String(t.id) : slug(t.name);
  if (!ID.test(id)) errors.push(`id "${id}": lower-case letters, digits and -, 2-48 long`);
  const name = String(t.name || id).trim().slice(0, 60);
  const params = {};
  for (const [k, p] of Object.entries(t.params && typeof t.params === "object" ? t.params : {}).slice(0, LIMITS.params)) {
    if (!/^\w{1,32}$/.test(k)) { errors.push(`params.${k}: names may use letters, digits and _`); continue; }
    params[k] = { desc: String(p?.desc || "").slice(0, 200), default: p?.default === undefined || p?.default === null ? null : String(p.default) };
  }
  const spec = t.spec && typeof t.spec === "object" ? t.spec : null;
  if (!spec) errors.push("spec: the panel spec is required");
  else {
    // checked with every parameter filled, as it will run
    const filled = fillParams(spec, Object.fromEntries(Object.keys(params).map((k) => [k, params[k].default ?? "x"])));
    const v = validate(filled);
    errors.push(...v.errors.map((e) => `spec.${e}`));
    const unknown = [...JSON.stringify(spec).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).filter((k) => !(k in params));
    if (unknown.length) errors.push(`spec uses {{${[...new Set(unknown)].join("}}, {{")}}} but params doesn't declare ${unknown.length > 1 ? "them" : "it"}`);
  }
  let preview = null;
  if (t.preview?.data && typeof t.preview.data === "object") {
    preview = { data: trimPreview(t.preview.data), at: Number(t.preview.at) || Date.now() };
    const series = previewSeries(t.preview.series);
    if (series) preview.series = series;
    if (JSON.stringify(preview).length > LIMITS.preview) preview = null;
  }
  if (errors.length) throw httpError(400, `invalid tool:\n- ${errors.join("\n- ")}`);
  const bins = strList(t.requires?.bin, 8, 40);
  // every tool stays findable: few or no triggers are filled from the spec itself
  // (name, title, spec words), so matching never depends on the agent's diligence
  let when = strList(t.when, LIMITS.when);
  let keywords = strList(t.keywords, LIMITS.keywords, 40);
  if (when.length < 3 || keywords.length < 3) {
    const h = specTriggers({ name, spec });
    if (when.length < 3) when = [...new Set([...when, name, spec?.title, ...h.keywords.slice(0, 4)].filter(Boolean))].slice(0, LIMITS.when);
    if (keywords.length < 3) keywords = [...new Set([...keywords, ...h.keywords])].slice(0, 40);
  }
  return {
    id, name,
    summary: String(t.summary || "").trim().slice(0, 240),
    when,
    keywords,
    not_when: strList(t.not_when, 10, 200),
    coherence: coherence(spec),
    requires: { bin: bins.length ? bins : binsOf(spec) },
    params,
    instructions: String(t.instructions || "").slice(0, LIMITS.instructions),
    reference: reference(t.reference),
    spec,
    preview,
    author: String(t.author || author()).slice(0, 60),
    version: Math.max(1, Math.floor(Number(t.version)) || 1),
    origin: origin || t.origin || "mine",
    shelf: t.shelf || null,
    learned: strList(t.learned, LIMITS.learned, 200),
    uses: Math.max(0, Math.floor(Number(t.uses)) || 0),
    lastUsed: Number(t.lastUsed) || null,
    createdAt: Number(t.createdAt) || Date.now(),
    updatedAt: Date.now(),
    publishedAt: Number(t.publishedAt) || null,
  };
}

// words from the spec itself (programs, paths, titles): the offline fallback that keeps
// every tool findable, also used by triggers.mjs for the model-written upgrade
export function specTriggers(t) {
  const words = new Set();
  for (const s of Object.values(t.spec?.sources || {})) {
    if (Array.isArray(s.run)) s.run.filter((a) => !a.startsWith("-") && !a.includes("{{") && !/^\d+$/.test(a) && a.length < 24).slice(0, 3).forEach((a) => words.add(a.split("/").pop()));
    if (s.path) words.add(String(s.path).split("/").pop());
  }
  for (const w of tokens([t.name, t.spec?.title, ...(t.spec?.views || []).map((v) => v.title)].join(" "))) words.add(w);
  return { keywords: [...words].filter((w) => w && w.length < 30).slice(0, 15) };
}

// a spec that works but wastes: sources no view shows, inputs nothing uses, two views
// showing the same thing. Non-blocking: reported at save so the agent can trim.
export function coherence(spec) {
  const warnings = [];
  const sources = spec?.sources || {};
  const views = Array.isArray(spec?.views) ? spec.views : [];
  const shown = new Set(views.map((v) => v?.source).filter((s) => typeof s === "string"));
  for (const name of Object.keys(sources)) {
    if (sources[name]?.brick === "agent") continue; // read by panel_read, not by views
    if (!shown.has(name)) warnings.push(`sources.${name}: no view shows it; drop it or add a view`);
  }
  const blob = JSON.stringify({ sources, views });
  const ref = (n) => new RegExp(`\\{\\{\\s*(in\\.)?${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`).test(blob);
  for (const n of Object.keys(spec?.inputs || {})) {
    if (!ref(n)) warnings.push(`inputs.${n}: nothing uses it`);
  }
  const seen = new Map();
  views.forEach((v, i) => {
    const key = JSON.stringify({ brick: v?.brick, source: v?.source, columns: v?.columns, text: v?.text, query: v?.query });
    if (seen.has(key)) warnings.push(`views[${i}]: shows the same as views[${seen.get(key)}]`);
    else seen.set(key, i);
  });
  return warnings;
}

function fingerprint(spec) {
  const toks = [];
  for (const s of Object.values(spec?.sources || {})) {
    if (Array.isArray(s.run)) toks.push(`run:${String(s.run[0] || "").split("/").pop()}`);
    else if (s.path) toks.push(`path:${String(s.path).split("/").pop()}`);
    else if (s.url) toks.push(`url:${String(s.url).split("/")[2] || ""}`);
    else if (s.query) toks.push(`sql:${s.engine || ""}:${s.db || ""}`);
    else if (s.call) toks.push(`conn:${s.service || ""}:${s.call}`);
    else toks.push(`brick:${s.brick}`);
  }
  for (const v of spec?.views || []) toks.push(`view:${v.brick}:${v.source || ""}`);
  return toks;
}

// tools already saved that do nearly the same thing (0-1). save_tool refuses above 0.75
// so near-duplicates become updates, not siblings.
export function similarTools(t, { exclude = null, limit = 3 } = {}) {
  const fp = new Set(fingerprint(t.spec));
  const tw = new Set(tokens([...(t.when || []), ...(t.keywords || [])].join(" ")));
  const out = [];
  for (const o of listTools()) {
    if (o.id === exclude || (t.id && o.id === t.id)) continue;
    const ofp = new Set(fingerprint(o.spec));
    const union = new Set([...fp, ...ofp]).size;
    const fspec = union ? [...fp].filter((x) => ofp.has(x)).length / union : 0;
    const ow = new Set(tokens([...(o.when || []), ...(o.keywords || [])].join(" ")));
    const uw = new Set([...tw, ...ow]).size;
    const ftrig = uw ? [...tw].filter((x) => ow.has(x)).length / uw : 0;
    const score = Math.round((0.7 * fspec + 0.3 * ftrig) * 100) / 100;
    if (score >= 0.75) out.push({ id: o.id, name: o.name, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// the product a tool was modeled on (the tool-building skill, guide.mjs)
function reference(r) {
  if (!r || typeof r !== "object" || !r.product) return null;
  const url = /^https?:\/\//.test(String(r.url || "")) ? String(r.url).slice(0, 300) : null;
  return { product: String(r.product).slice(0, 60), url, borrowed: strList(r.borrowed, 10, 160) };
}

// programs the spec runs (first argv word), for "requires" and the "is it installed here" check
function binsOf(spec) {
  const bins = [];
  for (const s of Object.values(spec?.sources || {})) if (Array.isArray(s.run) && s.run[0]) bins.push(s.run[0]);
  for (const v of spec?.views || []) for (const a of v.row_actions || []) if (a.run?.[0]) bins.push(a.run[0]);
  return [...new Set(bins.map((b) => b.split("/").pop()))].filter((b) => !b.includes("{{")).slice(0, 8);
}

// Puts param values into every string of a spec: {{namespace}} -> "prod".
export function fillParams(spec, values) {
  const walk = (v) => typeof v === "string" ? v.replace(/\{\{(\w+)\}\}/g, (all, k) => (k in values && values[k] !== null ? String(values[k]) : all))
    : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  return walk(spec);
}

// The other way: the agent says which values in its panel are settings ("prod" is the namespace), and every
// string that has one gets {{namespace}} in its place.
export function parametrize(spec, params) {
  const pairs = Object.entries(params).filter(([, p]) => typeof p?.value === "string" && p.value.length >= 2)
    .sort((a, b) => b[1].value.length - a[1].value.length);
  const walk = (v) => {
    if (typeof v === "string") {
      let s = v;
      for (const [k, p] of pairs) s = s.split(p.value).join(`{{${k}}}`);
      return s;
    }
    return Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  };
  return walk(spec);
}

// A small sample of what the panel showed, enough to draw the preview.
export function trimPreview(data) {
  const cut = (v, depth = 0) => {
    if (typeof v === "string") return v.length > 2500 ? v.slice(-2500) : v;
    if (Array.isArray(v)) return v.slice(-LIMITS.previewRows).map((x) => cut(x, depth + 1));
    if (v && typeof v === "object") return depth > 4 ? null : Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, cut(x, depth + 1)]));
    return v;
  };
  const out = {};
  for (const [k, v] of Object.entries(data || {}).slice(0, 8)) out[k] = cut(v && typeof v === "object" && "data" in v ? v.data : v);
  return out;
}

// A chart's short history for the preview card: { <view id>: [number | [number, …], …] }, oldest first.
function previewSeries(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  const out = {};
  for (const [id, list] of Object.entries(s).slice(0, 8)) {
    if (!Array.isArray(list)) continue;
    const ok = list.slice(-LIMITS.previewSamples).map((x) => (Array.isArray(x) ? x.slice(0, 6).map(Number) : Number(x)))
      .filter((x) => (Array.isArray(x) ? x.every(Number.isFinite) : Number.isFinite(x)));
    if (ok.length) out[String(id).slice(0, 40)] = ok;
  }
  return Object.keys(out).length ? out : null;
}

// What an agent or the market shows for a tool: everything but the bulky preview.
export function card(t, { preview = false } = {}) {
  const { preview: p, learned, ...rest } = t;
  return { ...rest, learned: learned?.length || 0, available: available(t), runs: reach(fillParams(t.spec, defaults(t)), "/").map(describeReach),
    ...(preview ? { preview: p } : { hasPreview: !!p }) };
}
const describeReach = (r) => r.argv ? `${r.kind === "action" ? `[${r.label}] ` : ""}${r.argv.join(" ")}${r.every_s ? ` (her ${r.every_s}s)` : r.stream ? " (akış)" : ""}`
  : r.kind === "sql" ? `${r.engine}${r.db ? ` ${r.db}` : ""}: ${r.query}`
  : r.kind === "connector" ? `${r.service}: ${r.call}` : r.url || r.path;
const defaults = (t) => Object.fromEntries(Object.entries(t.params || {}).map(([k, p]) => [k, p.default ?? `<${k}>`]));

// ---------- programs installed here ----------

const which = new Map();
function hasBin(bin) {
  // re-checked every minute: a program installed after taksim started shows up without a restart.
  const hit = which.get(bin);
  if (hit && Date.now() - hit.at < 60 * 1000) return hit.ok;
  let ok = false;
  try { execFileSync("/bin/sh", ["-c", 'command -v "$1"', "sh", bin], { stdio: "ignore", timeout: 2000 }); ok = true; } catch { /* missing */ }
  which.set(bin, { ok, at: Date.now() });
  return ok;
}
export function available(t) {
  const missing = (t.requires?.bin || []).filter((b) => !hasBin(b));
  return { ok: !missing.length, missing };
}

// ---------- files ----------

function readDir(dir, origin) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const t = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (t && typeof t === "object" && t.id && t.spec) out.push({ ...t, origin: origin || t.origin || "mine" });
    } catch { /* skip a broken file */ }
  }
  return out;
}

function writeTool(dir, t) {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${t.id}.json.tmp`);
  writeFileSync(tmp, JSON.stringify(t, null, 2));
  renameSync(tmp, join(dir, `${t.id}.json`));
}

// Builtin tools, overridden by library tools with the same id.
export function listTools() {
  const byId = new Map();
  for (const t of readDir(BUILTIN, "builtin")) byId.set(t.id, t);
  for (const t of readDir(LIBRARY)) byId.set(t.id, { ...t, builtin: byId.get(t.id)?.origin === "builtin" || t.builtin || false });
  return [...byId.values()];
}

export function getTool(ref) {
  const tools = listTools();
  const s = String(ref || "").trim();
  return tools.find((t) => t.id === s) || tools.find((t) => t.name.toLowerCase() === s.toLowerCase()) || tools.find((t) => t.id === slug(s)) || null;
}

export function saveTool(t) {
  writeTool(LIBRARY, t);
  return t;
}

// Changes only what describes a tool (name, triggers, notes); its commands change by saving it again.
export function editTool(id, patch = {}) {
  const t = getTool(id);
  if (!t) throw httpError(404, `no tool ${id}`);
  const next = { ...t };
  if (patch.name !== undefined) next.name = String(patch.name).trim().slice(0, 60) || t.name;
  if (patch.summary !== undefined) next.summary = String(patch.summary).slice(0, 240);
  for (const k of ["when", "keywords"]) if (patch[k] !== undefined) next[k] = strList(patch[k], LIMITS[k], k === "when" ? 160 : 40);
  if (patch.reference !== undefined) next.reference = reference(patch.reference);
  if (patch.instructions !== undefined) next.instructions = String(patch.instructions).slice(0, LIMITS.instructions);
  if (patch.params && typeof patch.params === "object") {
    for (const [k, p] of Object.entries(patch.params)) if (next.params[k]) next.params[k] = { ...next.params[k], ...(p?.desc !== undefined ? { desc: String(p.desc) } : {}), ...(p?.default !== undefined ? { default: p.default === null ? null : String(p.default) } : {}) };
  }
  if (patch.learned === null) next.learned = [];
  next.updatedAt = Date.now();
  // a builtin tool changes as the user's own copy, so a taksim update doesn't undo it
  if (t.origin === "builtin") { next.builtin = true; next.origin = "builtin"; }
  return saveTool(next);
}

/** removes every tool the user added or changed; taksim's own come back as they shipped (the app's reset) */
export function clearLibrary() {
  rmSync(LIBRARY, { recursive: true, force: true });
  rmSync(LOCAL_MARKET, { recursive: true, force: true });
}

export function deleteTool(id, lang = "en") {
  const t = getTool(id);
  if (!t) throw httpError(404, `no tool ${id}`);
  const f = join(LIBRARY, `${t.id}.json`);
  if (!existsSync(f)) throw httpError(400, T(lang, "taksim's own tools can't be deleted", "taksim'in kendi araçları silinemez"));
  rmSync(f);
  return { ok: true, restored: t.builtin ? "builtin" : null };
}

// A use: count it and remember the words that led to it, so the next similar message finds it.
export function recordUse(id, phrase) {
  const t = getTool(id);
  if (!t) return;
  const next = { ...t, uses: (t.uses || 0) + 1, lastUsed: Date.now() };
  const p = String(phrase || "").replace(/^\[[^\]]*\]\s*/g, "").trim().slice(0, 200);
  const words = tokens(p);
  // what a person asked for, not instructions written for an agent (code in backticks, "Open it with use_tool")
  if (words.length >= 2 && words.length <= 30 && !/`|^open it with /i.test(p)) {
    const known = [...(t.when || []), ...(t.learned || [])].map((x) => tokens(x).join(" "));
    if (!known.includes(words.join(" "))) next.learned = [p, ...(t.learned || [])].slice(0, LIMITS.learned);
  }
  if (t.origin === "builtin") next.builtin = true;
  saveTool(next);
}

export function searchTools(query) {
  const tools = listTools();
  if (!String(query || "").trim()) return tools.sort((a, b) => (b.uses || 0) - (a.uses || 0) || a.name.localeCompare(b.name)).map((tool) => ({ tool, score: 0, why: [] }));
  return rank(query, tools);
}

// ---------- market ----------

export function shelves() {
  const extra = String(process.env.TAKSIM_MARKET || "").split(",").map((s) => s.trim()).filter(Boolean);
  const repo = marketRepo();
  return [{ id: "local", label: "Bu bilgisayar", at: LOCAL_MARKET },
    // the shared market: a GitHub repository every taksim user can read, and share to under their GitHub name
    ...(repo ? [{ id: "github", label: repo, at: `github:${repo}` }] : []),
    ...extra.map((at, i) => ({
      id: `s${i + 1}`, label: /^https?:/.test(at) ? new URL(at).host : at.split("/").filter(Boolean).pop(), at: /^https?:/.test(at) ? at.replace(/\/+$/, "") : resolve(at) }))];
}

// ---------- the shared market: a GitHub repository ----------
//   tools/<github login>/<tool id>.json, one file per tool. Anyone reads it (with the user's GitHub token when
//   connected, for the higher rate limit); sharing writes the user's own folder, or opens a pull request from
//   their fork when they can't push. The folder is the author: a tool can't claim to be someone else's.

const MARKET_FILE = join(HOME, "market.json");
const REPO = /^[\w.-]+\/[\w.-]+$/;
export const DEFAULT_MARKET_REPO = process.env.TAKSIM_MARKET_REPO || null;
export function marketRepo() {
  try { const r = JSON.parse(readFileSync(MARKET_FILE, "utf8")).repo; if (r === null || REPO.test(r)) return r; } catch {}
  return DEFAULT_MARKET_REPO;
}
export function setMarketRepo(repo) {
  const r = typeof repo === "string" ? repo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$|\/+$/g, "") : "";
  if (r && !REPO.test(r)) throw httpError(400, "the market is a GitHub repository: owner/name");
  mkdirSync(HOME, { recursive: true });
  writeFileSync(MARKET_FILE + ".tmp", JSON.stringify({ repo: r || null }));
  renameSync(MARKET_FILE + ".tmp", MARKET_FILE);
  remoteCache.clear();
  return marketRepo();
}

async function gh(path, { method = "GET", body, token, raw = false } = {}) {
  const url = path.startsWith("https://") ? path : `https://api.github.com/${path}`;
  const r = await fetch(url, { method, signal: AbortSignal.timeout(15000),
    headers: { accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", "user-agent": "taksim", "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch { j = text; }
  return { ok: r.ok, status: r.status, json: j };
}
const ghFail = (r, what) => httpError(r.status === 404 || r.status === 401 ? 400 : 502, `GitHub: ${what}: ${r.json?.message || `HTTP ${r.status}`}`);

const MARKET_PATH = /^tools\/([\w.-]{1,39})\/([a-z0-9][a-z0-9-]{1,47})\.json$/;
async function githubTools(repo) {
  const token = await readToken("github").catch(() => null);
  const tree = await gh(`repos/${repo}/git/trees/HEAD?recursive=1`, { token });
  if (!tree.ok) throw ghFail(tree, `can't read ${repo}`);
  const files = (tree.json?.tree || []).map((e) => e.path).filter((p) => MARKET_PATH.test(p)).slice(0, 300);
  const tools = await Promise.all(files.map(async (p) => {
    const [, login] = p.match(MARKET_PATH);
    const r = await gh(`repos/${repo}/contents/${p}`, { token, raw: true });
    if (!r.ok || !r.json || typeof r.json !== "object" || !r.json.spec) return null;
    return { ...r.json, author: login, path: p };
  }));
  return tools.filter(Boolean);
}

/** shares a tool to the GitHub market under the user's login: their folder, else a pull request from their fork */
async function publishGithub(repo, tool, lang = "en") {
  const token = await readToken("github").catch(() => null);
  if (!token) throw httpError(400, T(lang, "connect GitHub under Settings → Connections to share to the market", "Market'e paylaşmak için Ayarlar → Bağlantılar altından GitHub'ı bağlayın"));
  const me = await gh("user", { token });
  if (!me.ok) throw ghFail(me, "who are you");
  const login = me.json.login;
  const path = `tools/${login}/${tool.id}.json`;
  const content = Buffer.from(JSON.stringify({ ...tool, author: login }, null, 2) + "\n").toString("base64");
  const message = `${tool.name} (${tool.id}) v${tool.version} by @${login}`;
  const existing = await gh(`repos/${repo}/contents/${path}`, { token });
  const put = await gh(`repos/${repo}/contents/${path}`, { method: "PUT", token, body: { message, content, ...(existing.ok ? { sha: existing.json.sha } : {}) } });
  if (put.ok) return { author: login, url: put.json?.content?.html_url || null };
  if (put.status !== 403 && put.status !== 404) throw ghFail(put, "can't share");
  // no push access: the same file on a branch of the user's fork, offered as a pull request
  const up = await gh(`repos/${repo}`, { token });
  if (!up.ok) throw ghFail(up, `can't read ${repo}`);
  const base = up.json.default_branch;
  const fork = await gh(`repos/${repo}/forks`, { method: "POST", token, body: { default_branch_only: true } });
  if (!fork.ok) throw ghFail(fork, "can't fork the market");
  const forkName = fork.json.full_name;
  const head = await gh(`repos/${repo}/git/ref/heads/${base}`, { token });
  if (!head.ok) throw ghFail(head, "can't read the market's branch");
  const branch = `taksim/${tool.id}-v${tool.version}-${Date.now().toString(36)}`;
  let ref;
  for (let i = 0; i < 10; i++) { // a new fork takes a moment to exist
    ref = await gh(`repos/${forkName}/git/refs`, { method: "POST", token, body: { ref: `refs/heads/${branch}`, sha: head.json.object.sha } });
    if (ref.ok) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!ref.ok) throw ghFail(ref, "can't make a branch on your fork");
  const inFork = await gh(`repos/${forkName}/contents/${path}?ref=${encodeURIComponent(branch)}`, { token });
  const write = await gh(`repos/${forkName}/contents/${path}`, { method: "PUT", token,
    body: { message, content, branch, ...(inFork.ok ? { sha: inFork.json.sha } : {}) } });
  if (!write.ok) throw ghFail(write, "can't write to your fork");
  const pr = await gh(`repos/${repo}/pulls`, { method: "POST", token,
    body: { title: message, head: `${login}:${branch}`, base, body: `${tool.summary || ""}\n\nShared from taksim.` } });
  if (!pr.ok) throw ghFail(pr, "can't open the pull request");
  return { author: login, pr: pr.json.html_url };
}

const remoteCache = new Map(); // url -> { at, tools }
async function shelfTools(shelf) {
  if (shelf.at.startsWith("github:")) {
    const hit = remoteCache.get(shelf.at);
    if (hit && Date.now() - hit.at < 5 * 60000) return hit.tools;
    try { const tools = await githubTools(shelf.at.slice(7)); remoteCache.set(shelf.at, { at: Date.now(), tools }); return tools; }
    catch { return hit?.tools || []; }
  }
  if (!/^https?:/.test(shelf.at)) return readDir(shelf.at, "market");
  const hit = remoteCache.get(shelf.at);
  if (hit && Date.now() - hit.at < 60000) return hit.tools;
  try {
    const r = await fetch(`${shelf.at}/v1/market/tools`, { signal: AbortSignal.timeout(4000), headers: process.env.TAKSIM_MARKET_TOKEN ? { authorization: `Bearer ${process.env.TAKSIM_MARKET_TOKEN}` } : {} });
    const tools = r.ok ? (await r.json()).tools || [] : [];
    remoteCache.set(shelf.at, { at: Date.now(), tools });
    return tools;
  } catch { return hit?.tools || []; }
}

// Every shelf's tools, with whether the user already has each one.
export async function marketTools() {
  const mine = new Map(listTools().map((t) => [t.id, t]));
  const out = [];
  for (const shelf of shelves()) {
    for (const t of await shelfTools(shelf)) {
      const have = mine.get(t.id);
      out.push({ ...t, origin: "market", shelf: shelf.id, shelfLabel: shelf.label, installed: !!have, installedVersion: have?.version || null });
    }
  }
  return out;
}

// The local shelf's tools as served to other taksim servers.
export const servedMarket = () => readDir(LOCAL_MARKET, "market");

// What goes to the market: the tool without the user's own traces (usage, phrases learned from their messages).
function forMarket(t, { withPreview }) {
  const { learned, uses, lastUsed, shelf, builtin, installed, ...rest } = t;
  return { ...rest, origin: "market", preview: withPreview ? t.preview : null, publishedAt: Date.now() };
}

export async function publish(id, { shelf = "local", withPreview = true, lang = "en" } = {}) {
  const t = getTool(id);
  if (!t) throw httpError(404, `no tool ${id}`);
  const s = shelves().find((x) => x.id === shelf);
  if (!s) throw httpError(400, `no shelf ${shelf}`);
  const out = forMarket(t, { withPreview });
  const prev = (await shelfTools(s)).find((x) => x.id === t.id && (!s.at.startsWith("github:") || x.author === t.publishedAs));
  out.version = prev ? Math.max(prev.version || 1, t.version || 1) + 1 : t.version || 1;
  if (s.at.startsWith("github:")) {
    const r = await publishGithub(s.at.slice(7), out, lang);
    remoteCache.delete(s.at);
    saveTool({ ...t, version: out.version, publishedAt: out.publishedAt, publishedAs: r.author });
    return { shelf: s.id, version: out.version, author: r.author, url: r.url || null, pr: r.pr || null };
  }
  if (/^https?:/.test(s.at)) {
    const r = await fetch(`${s.at}/v1/market/tools`, { method: "POST", signal: AbortSignal.timeout(8000),
      headers: { "content-type": "application/json", ...(process.env.TAKSIM_MARKET_TOKEN ? { authorization: `Bearer ${process.env.TAKSIM_MARKET_TOKEN}` } : {}) },
      body: JSON.stringify({ tool: out }) });
    if (!r.ok) throw httpError(502, `${s.label}: ${(await r.json().catch(() => ({}))).error?.message || `HTTP ${r.status}`}`);
    remoteCache.delete(s.at);
  } else writeTool(s.at, normalize(out, { origin: "market" }));
  saveTool({ ...t, version: out.version, publishedAt: out.publishedAt });
  return { shelf: s.id, version: out.version };
}

// Another taksim publishing to this one's market.
export function receive(tool) {
  const t = normalize(tool, { origin: "market" });
  const prev = servedMarket().find((x) => x.id === t.id);
  if (prev && prev.author && prev.author !== t.author) throw httpError(409, `"${t.id}" is ${prev.author}'s tool; publish under another name`);
  writeTool(LOCAL_MARKET, { ...t, learned: [], uses: 0 });
  return t;
}

export async function install(shelf, id, { as, by } = {}) {
  const t = (await marketTools()).find((x) => x.shelf === shelf && x.id === id && (!by || x.author === by));
  if (!t) throw httpError(404, `no tool ${id} on shelf ${shelf}`);
  const mine = getTool(as || t.id);
  if (mine && mine.origin !== "market" && !as) throw httpError(409, `you already have a tool "${t.id}"; add this one under another id`);
  const out = normalize({ ...t, id: as || t.id, uses: mine?.uses, learned: mine?.learned, name: mine?.origin === "market" ? mine.name : t.name }, { origin: "market" });
  return saveTool({ ...out, shelf, installedAt: Date.now() });
}

export function unpublish(shelf, id) {
  const s = shelves().find((x) => x.id === shelf);
  if (!s || /^https?:/.test(s.at)) throw httpError(400, "only this computer's shelf can be changed from here");
  if (!ID.test(String(id))) throw httpError(400, `bad tool id ${id}`);
  const f = join(s.at, `${id}.json`);
  if (!existsSync(f)) throw httpError(404, `no tool ${id} on ${s.label}`);
  rmSync(f);
  return { ok: true };
}

// A tool file someone sent: it runs their commands, like a market tool.
export function importTool(input) {
  const t = normalize({ ...input, uses: 0, learned: [] }, { origin: "imported" });
  if (getTool(t.id) && getTool(t.id).origin !== "imported") throw httpError(409, `you already have a tool "${t.id}"; rename the file's id`);
  return saveTool(t);
}
