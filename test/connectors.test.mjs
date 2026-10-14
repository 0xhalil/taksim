// Connections: a token pasted once, kept out of reach of panels and agents; read-only calls, paged.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "taksim-home-"));
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_FAKE = "1";
process.env.TAKSIM_QUIET = "1";

const { connect, disconnect, listConnections, fetchConnector, checkConnector, readToken, _forget } = await import("../src/connectors.mjs");
const { validate, reach, catalog } = await import("../src/bricks/catalog.mjs");
after(() => rmSync(home, { recursive: true, force: true }));

// Slack's Web API, as far as these tests need it
const realFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), auth: opts?.headers?.authorization, method: opts?.method || "GET", body: opts?.body ? JSON.parse(opts.body) : null });
  const u = new URL(url);
  if (u.host === "api.linear.app") return new Response(JSON.stringify(linear(opts)), { status: 200 });
  if (u.host === "acme.atlassian.net") return jira(u, opts);
  const body = u.pathname === "/api/auth.test" ? { ok: opts.headers.authorization === "Bearer xoxb-good", user: "bot", team: "Acme", error: "invalid_auth" }
    : u.pathname === "/api/conversations.history" ? (u.searchParams.get("cursor")
      ? { ok: true, messages: [{ text: "third" }] }
      : { ok: true, messages: [{ text: "first" }, { text: "second" }], response_metadata: { next_cursor: "c2" } })
    : { ok: false, error: "unknown_method" };
  return new Response(JSON.stringify(body), { status: 200 });
};
after(() => { globalThis.fetch = realFetch; });

// Linear's GraphQL: the viewer, and two pages of issues
const issue = (n) => ({ identifier: `ENG-${n}`, title: `t${n}`, state: { name: "Todo", type: "unstarted" }, assignee: { name: "Ada" }, team: { key: "ENG" }, labels: { nodes: [] } });
function linear(opts) {
  if (opts.headers.authorization !== "lin_api_good") return { errors: [{ message: "Authentication required" }] };
  const { query, variables } = JSON.parse(opts.body);
  if (/viewer \{ name email/.test(query)) return { data: { viewer: { name: "Ada", email: "ada@acme.com" } } };
  if (/issues\(/.test(query)) return { data: { issues: variables.after
    ? { nodes: [issue(3)], pageInfo: { hasNextPage: false, endCursor: null } }
    : { nodes: [issue(1), issue(2)], pageInfo: { hasNextPage: true, endCursor: "p2" } } } };
  return { errors: [{ message: "unknown" }] };
}
// Jira Cloud's REST: basic auth, search paged by token, projects by startAt
function jira(u, opts) {
  if (opts.headers.authorization !== `Basic ${Buffer.from("me@acme.com:ATATT-good").toString("base64")}`) return new Response("{}", { status: 401 });
  const body = u.pathname === "/rest/api/3/myself" ? { displayName: "Ada Lovelace" }
    : u.pathname === "/rest/api/3/search/jql" ? (u.searchParams.get("nextPageToken")
      ? { issues: [{ key: "ENG-3", fields: { summary: "c", status: { name: "Done" } } }], isLast: true }
      : { issues: [{ key: "ENG-1", fields: { summary: "a", status: { name: "To Do" }, assignee: { displayName: "Ada" } } }, { key: "ENG-2", fields: { summary: "b", status: { name: "To Do" } } }], nextPageToken: "n2" })
    : u.pathname === "/rest/api/3/project/search" ? { startAt: Number(u.searchParams.get("startAt") || 0), maxResults: 1, total: 2, isLast: u.searchParams.has("startAt"), values: [{ key: u.searchParams.has("startAt") ? "OPS" : "ENG" }] }
    : null;
  return new Response(JSON.stringify(body), { status: body ? 200 : 404 });
}

test("a token is checked with the service, kept only for the user, and never listed", async () => {
  await assert.rejects(connect("slack", "xoxb-bad"), /didn't accept/);
  assert.equal(listConnections().find((c) => c.id === "slack").connected, false);
  const c = await connect("slack", "  xoxb-good  ");
  assert.deepEqual([c.connected, c.who], [true, "bot · Acme"]);
  assert.ok(!JSON.stringify(listConnections()).includes("xoxb-good"));
  assert.ok(!readFileSync(join(home, "connections.json"), "utf8").includes("xoxb-good"));
  assert.equal(statSync(join(home, "connections", "slack")).mode & 0o077, 0, "only the user can read the token file");
  _forget();
  assert.equal(await readToken("slack"), "xoxb-good");
  assert.deepEqual(catalog().connected, ["slack"]);
});

test("a connector source: read-only calls only, approved once, paged into rows with the token", async () => {
  assert.ok(checkConnector({ service: "slack", call: "chat.postMessage" }, "s").length, "writing calls are refused");
  assert.ok(checkConnector({ service: "slack", call: "conversations.delete" }, "s").length);
  assert.ok(checkConnector({ service: "github", call: "repos/a/b/pulls" }, "s").length === 0);
  assert.ok(checkConnector({ service: "mail", call: "x" }, "s").length);
  const v = validate({ sources: { m: { brick: "connector", service: "slack", call: "conversations.history", params: { channel: "C1" }, pages: 2, every_s: 5 } },
    views: [{ id: "t", brick: "table", source: "m" }] });
  assert.deepEqual(v.errors, []);
  assert.equal(v.spec.sources.m.every_s, 30, "services are asked at most every 30 s");
  assert.deepEqual(reach(v.spec, "/tmp")[0], { at: "sources.m", kind: "connector", service: "slack", call: "conversations.history", params: { channel: "C1" }, every_s: 30 });
  calls.length = 0;
  const rows = await fetchConnector(v.spec.sources.m);
  assert.deepEqual(rows.map((r) => r.text), ["first", "second", "third"]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.auth === "Bearer xoxb-good"));
  assert.match(calls[1].url, /cursor=c2/);
  await assert.rejects(fetchConnector({ service: "slack", call: "chat.postMessage" }), /isn't a call/);
});

test("disconnecting forgets the token", async () => {
  await disconnect("slack");
  assert.equal(await readToken("slack"), null);
  await assert.rejects(fetchConnector({ service: "slack", call: "conversations.list" }), /isn't connected/);
});

test("Linear: named queries only, the key as it is, issues paged by cursor into flat rows", async () => {
  assert.ok(checkConnector({ service: "linear", call: "issues" }, "s").length === 0);
  for (const call of ["issueCreate", "mutation { issueDelete(id: \"x\") { success } }", "query { issues { nodes { id } } }"]) {
    assert.ok(checkConnector({ service: "linear", call }, "s").length, `${call} is refused`);
    await assert.rejects(fetchConnector({ service: "linear", call }), /isn't a call/);
  }
  await assert.rejects(connect("linear", "lin_api_bad"), /didn't accept.*Authentication/);
  assert.equal((await connect("linear", "lin_api_good")).who, "Ada · ada@acme.com");
  calls.length = 0;
  const rows = await fetchConnector({ service: "linear", call: "issues", params: { team: "ENG", state: "Todo" }, pages: 3 });
  assert.deepEqual(rows.map((r) => r.identifier), ["ENG-1", "ENG-2", "ENG-3"]);
  assert.deepEqual([rows[0].state, rows[0].assignee, rows[0].team], ["Todo", "Ada", "ENG"]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.method === "POST" && c.auth === "lin_api_good" && !/mutation/.test(c.body.query)));
  assert.deepEqual(calls[0].body.variables.filter, { team: { key: { eq: "ENG" } }, state: { name: { eq: "Todo" } } });
  assert.equal(calls[1].body.variables.after, "p2");
  await disconnect("linear");
});

test("Jira: site|email|api_token in one field, basic auth, GET paths only, paged", async () => {
  assert.ok(checkConnector({ service: "jira", call: "search" }, "s").length === 0);
  assert.ok(checkConnector({ service: "jira", call: "issue/ENG-12/comment" }, "s").length === 0);
  for (const call of ["issue", "issue/ENG-1/transitions", "issue/ENG-1/assignee", "../admin", "project/ENG/delete"]) assert.ok(checkConnector({ service: "jira", call }, "s").length, `${call} is refused`);
  await assert.rejects(connect("jira", "ATATT-good"), /site\|email\|api_token/);
  await assert.rejects(connect("jira", "acme|me@acme.com|ATATT-bad"), /HTTP 401/);
  assert.equal((await connect("jira", "acme|me@acme.com|ATATT-good")).who, "Ada Lovelace · acme");
  calls.length = 0;
  const rows = await fetchConnector({ service: "jira", call: "search", params: { jql: "project = ENG" }, pages: 5 });
  assert.deepEqual(rows.map((r) => [r.key, r.status]), [["ENG-1", "To Do"], ["ENG-2", "To Do"], ["ENG-3", "Done"]]);
  assert.equal(rows[0].assignee, "Ada");
  assert.ok(calls.every((c) => c.method === "GET" && c.url.startsWith("https://acme.atlassian.net/rest/api/3/search/jql?")));
  assert.match(calls[0].url, /fields=summary/);
  assert.match(calls[1].url, /nextPageToken=n2/);
  const projects = await fetchConnector({ service: "jira", call: "project/search", pages: 5 });
  assert.deepEqual(projects.map((p) => p.key), ["ENG", "OPS"]);
  await disconnect("jira");
});
