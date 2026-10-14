// Connections to services (Slack, GitHub…) that panels read from: the user pastes a token once in the app's
// settings; it is kept in the macOS keychain (a file only readable by the user elsewhere) and used only here,
// to make the read-only calls a panel's "connector" source names. Agents and panels never see it.
//   { brick: "connector", service: "slack", call: "conversations.history", params: { channel: "C0123" }, every_s: 60 }
// Each service lists the calls it allows (all of them read), how its answers page, and where the rows are.
// A service whose API isn't a plain GET (Linear's GraphQL, Jira's basic auth) builds its own request.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./canvas/store.mjs";
import { cfg } from "./config.mjs";

const MAX_PAGES = 5;
const MAX_ROWS = 1000;

export const CONNECTORS = {
  slack: {
    label: "Slack",
    tokenHelp: "https://api.slack.com/apps",
    tokenHint: "xoxb-… / xoxp-…",
    // Web API methods that only read
    calls: /^(conversations\.(list|history|replies|info|members)|users\.(list|info|lookupByEmail|getPresence)|search\.(messages|files|all)|reactions\.(get|list)|pins\.list|bookmarks\.list|team\.info|usergroups\.(list|users\.list)|emoji\.list|files\.(list|info)|channels\.(list|history|info))$/,
    example: { brick: "connector", service: "slack", call: "conversations.history", params: { channel: "C0123456" }, every_s: 120 },
    callDesc: "a read-only Slack Web API method (conversations.list/history/replies, users.list, search.messages…); params are its arguments",
    url: (call, params) => `https://slack.com/api/${call}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`,
    check: (j) => { if (j && j.ok === false) throw new Error(`slack: ${j.error}${j.needed ? ` (needs ${j.needed})` : ""}`); },
    next: (j, call, params) => j?.response_metadata?.next_cursor ? { ...params, cursor: j.response_metadata.next_cursor } : null,
    rows: (j) => j.messages?.matches || j.messages || j.channels || j.members || j.files?.matches || j.files || j.items || j.usergroups
      || (j.emoji ? Object.entries(j.emoji).map(([name, url]) => ({ name, url })) : null) || j,
    who: async (token) => { const j = await getJson("https://slack.com/api/auth.test", token); CONNECTORS.slack.check(j); return [j.user, j.team].filter(Boolean).join(" · "); },
  },
  github: {
    label: "GitHub",
    tokenHelp: "https://github.com/settings/tokens?type=beta",
    tokenHint: "github_pat_… / ghp_…",
    // REST paths; GET only
    calls: /^\/?(repos|orgs|users|user|search|issues|notifications|gists)(\/[\w.@%-]+)*$/,
    example: { brick: "connector", service: "github", call: "repos/OWNER/REPO/pulls", params: { state: "open" }, every_s: 300 },
    callDesc: "a GitHub REST path read with GET (repos/OWNER/REPO/pulls, search/issues, notifications…); params are its query string",
    url: (call, params) => `https://api.github.com/${call.replace(/^\//, "")}${Object.keys(params).length ? `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}` : ""}`,
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    check: (j) => { if (j?.message && !j.items && !j.id && !j.login) throw new Error(`github: ${j.message}`); },
    next: (j, call, params, res) => /rel="next"/.test(res?.headers.get("link") || "") ? { ...params, page: Number(params.page || 1) + 1 } : null,
    rows: (j) => j.items || j,
    who: async (token) => (await getJson("https://api.github.com/user", token, CONNECTORS.github.headers)).login,
  },
  linear: {
    label: "Linear",
    tokenHelp: "https://linear.app/settings/account/security",
    tokenHint: "lin_api_…",
    // a fixed set of named queries; never the agent's own GraphQL, so nothing can mutate
    calls: /^(issues|my_issues|issue|cycles|projects|teams|users)$/,
    example: { brick: "connector", service: "linear", call: "issues", params: { team: "ENG", state: "In Progress" }, every_s: 300 },
    callDesc: "one of issues (params: team key, state, assignee email, label, project, first), my_issues (state), issue (id: ENG-123), "
      + "cycles (team), projects, teams, users; rows are flat (identifier, title, state, assignee…)",
    request: (call, params, token, query) => ({
      url: "https://api.linear.app/graphql", method: "POST",
      headers: { authorization: /^lin_api_/.test(token) ? token : `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(query ? { query } : linearQuery(call, params)),
    }),
    check: (j) => { if (j?.errors?.length) throw new Error(`linear: ${j.errors.map((e) => e.message).join("; ")}`); },
    next: (j, call, params) => { const c = linearConn(j, call); return c?.pageInfo?.hasNextPage ? { ...params, after: c.pageInfo.endCursor } : null; },
    rows: (j) => { const one = j.data?.issue; if (one) return linearIssue(one); const c = linearConn(j, Object.keys(j.data || {})[0]); return c ? c.nodes.map((n) => (n.identifier ? linearIssue(n) : flat(n))) : j.data; },
    who: async (token) => {
      const j = await send(CONNECTORS.linear.request("viewer", {}, token, "query { viewer { name email } }"));
      CONNECTORS.linear.check(j);
      return [j.data?.viewer?.name, j.data?.viewer?.email].filter(Boolean).join(" · ");
    },
  },
  jira: {
    label: "Jira",
    tokenHelp: "https://id.atlassian.com/manage-profile/security/api-tokens",
    // one field: the site, the account's email and an API token
    tokenHint: "site|email|api_token",
    // REST v3 and Agile paths; GET only
    calls: /^(search(\/jql)?|myself|field|status|priority|project(\/search|\/[\w-]+)?|issue\/[A-Za-z][\w]*-\d+(\/(comment|changelog|worklog))?|board(\/\d+(\/(sprint|issue|backlog))?)?|sprint\/\d+(\/issue)?)$/,
    example: { brick: "connector", service: "jira", call: "search", params: { jql: "project = ENG AND statusCategory != Done ORDER BY updated DESC" }, every_s: 300 },
    callDesc: "a Jira Cloud path read with GET: search (params: jql, fields), issue/KEY-1, issue/KEY-1/comment, project/search, myself, "
      + "board, board/ID/sprint, sprint/ID/issue; issues come back flat (key, summary, status, assignee…)",
    request: (call, params, token) => {
      const { site, auth } = jiraAuth(token);
      const agile = /^(board|sprint)/.test(call);
      const path = call === "search" ? "search/jql" : call;
      const q = { ...params };
      if (/^search|\/issue$|\/backlog$/.test(call) && !q.fields) q.fields = "summary,status,assignee,priority,issuetype,project,created,updated";
      const qs = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString();
      return { url: `https://${site}/rest/${agile ? "agile/1.0" : "api/3"}/${path}${qs ? `?${qs}` : ""}`, headers: { authorization: auth, accept: "application/json" } };
    },
    check: (j) => { if (j?.errorMessages?.length) throw new Error(`jira: ${j.errorMessages.join("; ")}`); },
    next: (j, call, params) => {
      if (j.nextPageToken) return { ...params, nextPageToken: j.nextPageToken };
      const got = (j.values || j.issues || []).length;
      if (j.isLast === true || !got || j.startAt === undefined) return null;
      const at = j.startAt + got;
      return j.isLast === false || at < (j.total ?? 0) ? { ...params, startAt: at } : null;
    },
    rows: (j) => (j.issues ? j.issues.map(jiraIssue) : j.fields && j.key ? jiraIssue(j) : j.comments || j.values || j.worklogs || j),
    who: async (token) => {
      const j = await send(CONNECTORS.jira.request("myself", {}, token));
      return [j.displayName, jiraAuth(token).site.replace(/\.atlassian\.net$/, "")].filter(Boolean).join(" · ");
    },
  },
  // not a source for panels: TypeSafe's Jev answers typed questions with probabilities, and the orchestrator asks it
  // through the decide tool (src/jev.mjs). Connected here like the rest, so its key lives in the keychain.
  jev: {
    label: "Jev (TypeSafe)",
    decision: true,
    tokenHelp: "https://docs.typesafe.ai",
    tokenHint: "TypeSafe API key",
    calls: /^$/,
    callDesc: "none: Jev is asked questions by agents (the decide tool), not read by panels",
    url: () => "",
    check: () => {},
    next: () => null,
    rows: (j) => j,
    who: async (token) => {
      const j = await getJson(`${process.env.TAKSIM_JEV_BASE || "https://api.typesafe.ai"}/v1/models`, token);
      const first = (j.data || j.models || [])[0];
      return first ? `Jev · ${first.id || first.name || first}` : "Jev";
    },
  },
};

/** the services panels can read (Jev is for agents' questions, not a source) */
export const PANEL_SERVICES = Object.keys(CONNECTORS).filter((k) => !CONNECTORS[k].decision);

// ---------- Linear: named queries, flat rows ----------

const ISSUE = "id identifier title url priority priorityLabel estimate createdAt updatedAt dueDate state { name type } assignee { name email } team { key } project { name } labels { nodes { name } }";
const PAGE = "pageInfo { hasNextPage endCursor }";
const QUERIES = {
  issues: `query($first: Int, $after: String, $filter: IssueFilter) { issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) { nodes { ${ISSUE} } ${PAGE} } }`,
  my_issues: `query($first: Int, $after: String, $filter: IssueFilter) { viewer { assignedIssues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) { nodes { ${ISSUE} } ${PAGE} } } }`,
  issue: `query($id: String!) { issue(id: $id) { ${ISSUE} description } }`,
  cycles: `query($first: Int, $after: String, $filter: CycleFilter) { cycles(first: $first, after: $after, filter: $filter) { nodes { id number name startsAt endsAt progress team { key } } ${PAGE} } }`,
  projects: `query($first: Int, $after: String) { projects(first: $first, after: $after) { nodes { id name state progress startDate targetDate url lead { name } } ${PAGE} } }`,
  teams: `query($first: Int, $after: String) { teams(first: $first, after: $after) { nodes { id key name } ${PAGE} } }`,
  users: `query($first: Int, $after: String) { users(first: $first, after: $after) { nodes { id name email active } ${PAGE} } }`,
};

function linearQuery(call, p) {
  const eq = (v) => ({ eq: String(v) });
  const filter = {};
  if (p.team) filter.team = { key: eq(p.team) };
  if (call !== "cycles") {
    if (p.state) filter.state = { name: eq(p.state) };
    if (p.assignee) filter.assignee = { email: eq(p.assignee) };
    if (p.label) filter.labels = { name: eq(p.label) };
    if (p.project) filter.project = { name: eq(p.project) };
  }
  const variables = call === "issue" ? { id: String(p.id || "") }
    : { first: Math.min(250, Math.max(1, Number(p.first) || 50)), ...(p.after ? { after: String(p.after) } : {}), ...(Object.keys(filter).length && /issues|cycles/.test(call) ? { filter } : {}) };
  return { query: QUERIES[call], variables };
}
const linearConn = (j, call) => (call === "my_issues" || call === "viewer" ? j.data?.viewer?.assignedIssues : j.data?.[call]);
const linearIssue = (n) => ({ identifier: n.identifier, title: n.title, state: n.state?.name, stateType: n.state?.type, priority: n.priorityLabel,
  assignee: n.assignee?.name || null, team: n.team?.key, project: n.project?.name || null, labels: (n.labels?.nodes || []).map((l) => l.name).join(", "),
  estimate: n.estimate ?? null, dueDate: n.dueDate || null, createdAt: n.createdAt, updatedAt: n.updatedAt, url: n.url, ...(n.description !== undefined ? { description: n.description } : {}) });
// nested objects ({ team: { key } }, { lead: { name } }) become one plain value
const flat = (n) => Object.fromEntries(Object.entries(n).map(([k, v]) => [k, v && typeof v === "object" ? (v.key ?? v.name ?? JSON.stringify(v)) : v]));

// ---------- Jira: "site|email|api_token", flat issues ----------

function jiraAuth(token) {
  const [site, email, ...rest] = String(token).split("|");
  const key = rest.join("|");
  if (!site || !email || !key) throw new Error("expected site|email|api_token (e.g. acme|me@acme.com|ATATT…)");
  const host = site.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return { site: host.includes(".") ? host : `${host}.atlassian.net`, auth: `Basic ${Buffer.from(`${email}:${key}`).toString("base64")}` };
}
const jiraIssue = (i) => {
  const f = i.fields || {};
  return { key: i.key, summary: f.summary, status: f.status?.name, statusCategory: f.status?.statusCategory?.name, assignee: f.assignee?.displayName || null,
    priority: f.priority?.name || null, type: f.issuetype?.name, project: f.project?.key, created: f.created, updated: f.updated };
};

// ---------- the token: keychain on macOS, else a user-only file (and always a file in tests) ----------

const SERVICE = (id) => `taksim:${id}`;
const useKeychain = process.platform === "darwin" && !cfg.fake;
const fileOf = (id) => join(HOME, "connections", id);

function security(args, input) {
  return new Promise((resolve) => {
    const p = spawn("/usr/bin/security", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("close", (code) => resolve(code === 0 ? out : null));
    p.on("error", () => resolve(null));
    p.stdin.end(input || "");
  });
}

export async function saveToken(id, token) {
  if (useKeychain) {
    // through security's own prompt mode, so the token is never on a command line other processes can see
    const q = (s) => `"${s.replace(/(["\\])/g, "\\$1")}"`;
    if (await security(["-i"], `add-generic-password -U -a taksim -s ${q(SERVICE(id))} -w ${q(token)}\n`) === null) throw new Error("the keychain refused the token");
    return;
  }
  mkdirSync(join(HOME, "connections"), { recursive: true, mode: 0o700 });
  writeFileSync(fileOf(id), token, { mode: 0o600 });
}

const cache = new Map(); // id -> token, read once per run
/** the same, for code that can't wait (an agent's environment as its CLI starts) */
export function readTokenSync(id) {
  if (cache.has(id)) return cache.get(id);
  let t = null;
  if (useKeychain) { try { t = execFileSync("/usr/bin/security", ["find-generic-password", "-a", "taksim", "-s", SERVICE(id), "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch {} }
  else if (existsSync(fileOf(id))) t = readFileSync(fileOf(id), "utf8").trim() || null;
  if (t) cache.set(id, t);
  return t;
}
export async function readToken(id) {
  if (cache.has(id)) return cache.get(id);
  let t = null;
  if (useKeychain) t = (await security(["find-generic-password", "-a", "taksim", "-s", SERVICE(id), "-w"]))?.trim() || null;
  else if (existsSync(fileOf(id))) t = readFileSync(fileOf(id), "utf8").trim() || null;
  if (t) cache.set(id, t);
  return t;
}

export async function dropToken(id) {
  cache.delete(id);
  if (useKeychain) await security(["delete-generic-password", "-a", "taksim", "-s", SERVICE(id)]);
  rmSync(fileOf(id), { force: true });
}

// ---------- who is connected ----------

const META = join(HOME, "connections.json"); // { id: { who, connectedAt } }: never the token
const readMeta = () => { try { return JSON.parse(readFileSync(META, "utf8")); } catch { return {}; } };
const writeMeta = (m) => { mkdirSync(HOME, { recursive: true }); writeFileSync(META + ".tmp", JSON.stringify(m, null, 2)); renameSync(META + ".tmp", META); };

export function listConnections() {
  const meta = readMeta();
  return Object.entries(CONNECTORS).map(([id, c]) => ({ id, label: c.label, tokenHelp: c.tokenHelp, tokenHint: c.tokenHint,
    connected: !!meta[id], who: meta[id]?.who || null, connectedAt: meta[id]?.connectedAt || null }));
}
export const connectedServices = () => Object.keys(readMeta()).filter((id) => CONNECTORS[id] && !CONNECTORS[id].decision);
export const isConnected = (id) => !!readMeta()[id] && !!CONNECTORS[id];

/** checks the token against the service (who it signs in as), then keeps it */
export async function connect(id, token, { verify = true } = {}) {
  const c = CONNECTORS[id];
  if (!c) throw Object.assign(new Error(`no service ${id}`), { status: 404 });
  token = typeof token === "string" ? token.trim() : "";
  if (!token || /\s/.test(token)) throw Object.assign(new Error("paste the token"), { status: 400 });
  let who = null;
  if (verify) {
    try { who = await c.who(token); } catch (e) { throw Object.assign(new Error(`${c.label} didn't accept the token: ${e.message}`), { status: 400 }); }
  }
  await saveToken(id, token);
  cache.set(id, token);
  writeMeta({ ...readMeta(), [id]: { who, connectedAt: Date.now() } });
  return listConnections().find((x) => x.id === id);
}

export async function disconnect(id) {
  if (!CONNECTORS[id]) throw Object.assign(new Error(`no service ${id}`), { status: 404 });
  await dropToken(id);
  const m = readMeta(); delete m[id]; writeMeta(m);
}

// ---------- the source ----------

async function send({ url, method = "GET", headers = {}, body }, signal) {
  const res = await fetch(url, { method, body, headers: { "user-agent": "taksim", ...headers },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`unexpected response (HTTP ${res.status}, not JSON: ${text.slice(0, 120)})`); }
  return Object.defineProperty(j, "__res", { value: res, enumerable: false });
}
const getJson = (url, token, headers = {}, signal) => send({ url, headers: { authorization: `Bearer ${token}`, ...headers } }, signal);

/** validation errors for a connector source */
export function checkConnector(s, at) {
  const errors = [];
  const c = PANEL_SERVICES.includes(s.service) ? CONNECTORS[s.service] : null;
  if (!c) errors.push(`${at}.service: one of ${PANEL_SERVICES.join(", ")}`);
  else if (typeof s.call !== "string" || !c.calls.test(s.call)) errors.push(`${at}.call: ${c.callDesc}`);
  if (s.params !== undefined && (typeof s.params !== "object" || Array.isArray(s.params) || Object.values(s.params || {}).some((v) => typeof v === "object" && v !== null))) {
    errors.push(`${at}.params: an object of plain values`);
  }
  if (s.pages !== undefined && !(Number(s.pages) >= 1 && Number(s.pages) <= MAX_PAGES)) errors.push(`${at}.pages: 1-${MAX_PAGES}`);
  return errors;
}

/** runs a connector source: the call, page after page (up to `pages`), as rows */
export async function fetchConnector(s, signal) {
  const c = CONNECTORS[s.service];
  if (!c || c.decision || !c.calls.test(s.call || "")) throw new Error(`${s.service}: "${s.call}" isn't a call panels may make`);
  const token = await readToken(s.service);
  if (!token) throw new Error(`${c.label} isn't connected: add it under Ayarlar → Bağlantılar`);
  let params = { ...(s.params || {}) }, rows = [];
  for (let page = 0; page < Math.min(MAX_PAGES, Number(s.pages) || 1) && params; page++) {
    const j = c.request ? await send(c.request(s.call, params, token), signal) : await getJson(c.url(s.call, params), token, c.headers, signal);
    c.check(j);
    const r = c.rows(j);
    if (!Array.isArray(r)) { if (page === 0) return r; break; } // one object (team.info, a user): the data itself
    rows = rows.concat(r);
    if (rows.length >= MAX_ROWS) break;
    params = c.next(j, s.call, params, j.__res);
  }
  return rows.slice(0, MAX_ROWS);
}

export const _forget = () => cache.clear();
