// Named accounts: separate CLI config dirs per account, agents bound to accounts, MCP create_agent with
// an account, login flow in a terminal. Uses the fake backend's FAKE_CONFIG_DIR account kind.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const home = mkdtempSync(join(tmpdir(), "taksim-home-"));
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_FAKE = "1";
process.env.TAKSIM_QUIET = "1";
delete process.env.GOOGLE_APPLICATION_CREDENTIALS; // a developer's service account would show up in Gemini's env
process.env.TAKSIM_OPENCODE_BIN = "/nonexistent/opencode";

const { startServer } = await import("../src/server.mjs");

let server, base, port;
before(async () => {
  server = await startServer({ host: "127.0.0.1", port: 0 });
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});
after(() => { server.close(); rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); });

async function api(method, path, body) {
  const r = await fetch(base + path, {
    method, headers: method === "GET" ? {} : { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const newCanvas = async () => (await api("POST", "/v1/canvases", {})).data;
const addAgent = (cid, spec) => api("POST", `/v1/canvases/${cid}/agents`, spec);
const say = async (cid, aid, text) => (await api("POST", `/v1/canvases/${cid}/agents/${aid}/messages`, { text, wait: true })).data;
const call = (tool, args) => `CALL ${JSON.stringify({ tool, args })}`;

async function until(fn, timeout = 6000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(50);
  }
}

let work, personal;

test("accounts: create with their own config dir, name the machine login, reject duplicates", async () => {
  const w = await api("POST", "/v1/accounts", { name: "work", backend: "fake" });
  assert.equal(w.status, 201);
  work = w.data;
  assert.ok(work.dir && existsSync(work.dir), "a separate config dir is created");
  const p = await api("POST", "/v1/accounts", { name: "personal", backend: "fake", machine: true });
  assert.equal(p.status, 201);
  personal = p.data;
  assert.equal(personal.dir, null, "the machine login has no dir of its own");
  assert.equal((await api("POST", "/v1/accounts", { name: "Work", backend: "fake" })).status, 409);
  assert.equal((await api("POST", "/v1/accounts", { name: "other", backend: "fake", machine: true })).status, 409);
  assert.equal((await api("POST", "/v1/accounts", { name: "x", backend: "nope" })).status, 400);
  const list = (await api("GET", "/v1/accounts")).data.accounts.map((a) => a.name);
  assert.deepEqual(list, ["work", "personal"]);
});

test("account status is read with the account's config dir", async () => {
  assert.equal((await api("GET", `/v1/accounts/${work.id}/status`)).data.loggedIn, true);
  assert.equal((await api("GET", `/v1/accounts/${personal.id}/status`)).data.loggedIn, false);
});

test("agents run under their account; the same canvas can mix accounts", async () => {
  const c = await newCanvas();
  const a = (await addAgent(c.id, { name: "w", model: "fake-args", account: "work" })).data;
  const b = (await addAgent(c.id, { name: "p", model: "fake-args", account: "personal" })).data;
  assert.equal(a.accountName, "work");
  assert.equal(JSON.parse((await say(c.id, a.id, "x")).text).configDir, work.dir);
  assert.equal(JSON.parse((await say(c.id, b.id, "x")).text).configDir, null);
});

test("an account must match the model's CLI; without a model it picks that CLI's default", async () => {
  const c = await newCanvas();
  const bad = await addAgent(c.id, { model: "sonnet", account: "work" });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error.message, /is a fake account but sonnet runs on claude/);
  const auto = (await addAgent(c.id, { account: "work" })).data;
  assert.equal(auto.model, "fake-echo");
  assert.equal((await addAgent(c.id, { model: "fake-echo", account: "nobody" })).status, 400);
});

test("changing an agent's account starts a new session", async () => {
  const c = await newCanvas();
  const a = (await addAgent(c.id, { model: "fake-args", account: "work" })).data;
  await say(c.id, a.id, "x");
  assert.ok((await api("GET", `/v1/canvases/${c.id}/agents/${a.id}`)).data.session);
  const v = (await api("PATCH", `/v1/canvases/${c.id}/agents/${a.id}`, { account: "personal" })).data;
  assert.equal(v.session, null);
  assert.equal(v.accountName, "personal");
});

test("agents choose accounts by name through create_agent; helpers inherit their creator's account", async () => {
  const c = await newCanvas();
  const lead = (await addAgent(c.id, { name: "lead", model: "fake-delegate", account: "work" })).data;
  const list = JSON.parse((await say(c.id, lead.id, call("list_agents"))).text.replace(/^list_agents: /, ""));
  assert.equal(list.your_account, "work");
  assert.deepEqual(list.accounts.map((a) => a.name), ["work", "personal"]);
  await say(c.id, lead.id, [
    call("create_agent", { name: "personal-helper", role: "r", model: "fake-echo", account: "personal" }),
    call("create_agent", { name: "same-account", role: "r", model: "fake-echo" }),
  ].join("\n"));
  const agents = (await api("GET", `/v1/canvases/${c.id}`)).data.agents;
  assert.equal(agents.find((a) => a.name === "personal-helper").accountName, "personal");
  assert.equal(agents.find((a) => a.name === "same-account").accountName, "work");
  const bad = await say(c.id, lead.id, call("create_agent", { name: "x", role: "r", account: "nope" }));
  assert.match(bad.text, /ERROR no account "nope"; accounts: work \(fake\), personal \(fake\)/);
});

test("a terminal runs under the agent's account", async () => {
  const c = await newCanvas();
  const a = (await addAgent(c.id, { model: "fake-echo", account: "work" })).data;
  await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/terminal`);
  const out = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/term/${c.id}/${a.id}`, { headers: { origin: `http://127.0.0.1:${port}` } });
    let o = "";
    ws.on("message", (d) => { o += d; if (o.includes("ready")) { ws.close(); resolve(o); } });
    ws.on("error", reject);
  });
  assert.ok(out.includes(`config=${work.dir}`));
  await api("DELETE", `/v1/canvases/${c.id}/agents/${a.id}/terminal`);
});

test("login runs the CLI's login flow in a terminal and refreshes the status", async () => {
  assert.equal((await api("POST", `/v1/accounts/${work.id}/login`)).status, 200);
  const out = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/term/account/${work.id}`, { headers: { origin: `http://127.0.0.1:${port}` } });
    let o = "";
    ws.on("message", (d) => (o += d));
    ws.on("close", () => resolve(o));
    ws.on("error", reject);
  });
  assert.match(out, /Login successful/);
  await until(async () => (await api("GET", "/v1/accounts")).data.accounts.find((a) => a.id === work.id).loggingIn === false);
});

test("deleting an account moves its agents back to the machine login", async () => {
  const tmp = (await api("POST", "/v1/accounts", { name: "temp", backend: "fake" })).data;
  const c = await newCanvas();
  const a = (await addAgent(c.id, { model: "fake-echo", account: "temp" })).data;
  assert.equal((await api("DELETE", `/v1/accounts/${tmp.id}`)).status, 200);
  assert.equal(existsSync(tmp.dir), false);
  const v = (await api("GET", `/v1/canvases/${c.id}/agents/${a.id}`)).data;
  assert.equal(v.account, null);
});

test("a cancelled login can start again at once; a login that ends is never seen without its result", async () => {
  const acct = (await api("POST", "/v1/accounts", { name: "again", backend: "fake" })).data;
  assert.equal((await api("POST", `/v1/accounts/${acct.id}/login`)).status, 200);
  await api("DELETE", `/v1/accounts/${acct.id}/login`);
  assert.equal((await api("GET", `/v1/accounts/${acct.id}/login`)).data.running, false);
  assert.equal((await api("POST", `/v1/accounts/${acct.id}/login`)).data.running, true, "a fresh login, not the dying one");
  // poll it to the end: running, then done; never "stopped and not done" in between
  const seen = [];
  await until(async () => { const s = (await api("GET", `/v1/accounts/${acct.id}/login`)).data; seen.push(s); return !s.running; }, 8000);
  assert.ok(seen.every((s) => s.running || s.done), JSON.stringify(seen.at(-1)));
  await api("DELETE", `/v1/accounts/${acct.id}`);
});

test("bad accounts are refused without leaving folders; naming this computer's login keeps agents' sessions", async () => {
  assert.equal((await api("POST", "/v1/accounts", { name: "x", backend: "constructor", machine: true })).status, 400);
  assert.equal((await api("POST", "/v1/accounts", { name: "y", backend: "toString" })).status, 400);
  assert.equal(existsSync(join(home, "accounts", "toString")), false);
  assert.equal((await api("POST", "/v1/accounts", { name: { a: 1 }, backend: "fake" })).status, 400);
  const machine = (await api("GET", "/v1/accounts")).data.accounts.find((a) => a.backend === "fake" && !a.dir)
    || (await api("POST", "/v1/accounts", { name: "this mac", backend: "fake", machine: true })).data;
  const c = await newCanvas();
  const a = (await addAgent(c.id, { model: "fake-echo", account: machine.id })).data;
  await say(c.id, a.id, "hi");
  const session = (await api("GET", `/v1/canvases/${c.id}/agents/${a.id}`)).data.session;
  assert.ok(session);
  await api("PATCH", `/v1/canvases/${c.id}/agents/${a.id}`, { account: null });
  assert.equal((await api("GET", `/v1/canvases/${c.id}/agents/${a.id}`)).data.session, session, "same login, same session");
});

test("a new Claude account skips first-run onboarding; carry-over merges settings without overriding the account's", async () => {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const c = (await api("POST", "/v1/accounts", { name: "claude-acct", backend: "claude", copy_settings: false })).data;
  const state = JSON.parse(readFileSync(join(c.dir, ".claude.json"), "utf8"));
  assert.equal(state.hasCompletedOnboarding, true, "no onboarding (and its login step) in the account's TUI");
  assert.ok(JSON.parse(readFileSync(join(c.dir, "settings.json"), "utf8")).theme, "the theme picker is answered too");
  writeFileSync(join(c.dir, "settings.json"), JSON.stringify({ theme: "light" }));
  assert.equal((await api("POST", `/v1/accounts/${c.id}/carry-over`)).status, 200);
  assert.equal(JSON.parse(readFileSync(join(c.dir, "settings.json"), "utf8")).theme, "light", "the account's own choice wins");
  assert.equal((await api("POST", `/v1/accounts/${personal.id}/carry-over`)).status, 400, "the machine login already has them");
  await api("DELETE", `/v1/accounts/${c.id}`);
});

test("signing in: the sign-in link is picked up, and a login that stays open is closed once signed in", async () => {
  const { writeFileSync } = await import("node:fs");
  const acct = (await api("POST", "/v1/accounts", { name: "fresh", backend: "fake" })).data;
  writeFileSync(join(acct.dir, "logged-out"), "");
  assert.equal((await api("GET", `/v1/accounts/${acct.id}/status`)).data.loggedIn, false);
  const started = (await api("POST", `/v1/accounts/${acct.id}/login`)).data;
  assert.equal(started.running, true);
  const end = await until(async () => {
    const s = (await api("GET", `/v1/accounts/${acct.id}/login`)).data;
    return s.done && !s.running ? s : null;
  });
  assert.equal(end.url, "https://login.example.test/oauth/authorize?client=fake&state=1");
  assert.equal(end.status.loggedIn, true);
  await api("DELETE", `/v1/accounts/${acct.id}`);
});

test("every CLI is offered, and an account's environment points only that CLI at its own folder", async () => {
  const { backends } = (await api("GET", "/v1/accounts")).data;
  assert.deepEqual(backends.map((b) => b.name), ["claude", "codex", "opencode", "copilot", "gemini", "antigravity", "fake"]);
  assert.equal(backends.find((b) => b.name === "antigravity").named, false, "one login per computer");
  assert.equal(backends.find((b) => b.name === "fake").installed, true);
  const { accountEnv } = await import("../src/accounts.mjs");
  const env = (backend) => accountEnv({ backend, dir: "/x" });
  assert.deepEqual(env("claude"), { CLAUDE_CONFIG_DIR: "/x" });
  assert.deepEqual(env("codex"), { CODEX_HOME: "/x" });
  assert.deepEqual(env("opencode"), { XDG_DATA_HOME: join("/x", "data") });
  assert.deepEqual(env("copilot"), { COPILOT_HOME: "/x" });
  assert.deepEqual(env("gemini"), { GEMINI_CLI_HOME: "/x", GEMINI_FORCE_FILE_STORAGE: "true" });
  assert.deepEqual(accountEnv({ backend: "gemini", dir: null }), {}, "the machine login changes nothing");
});

test("who is signed in is read from each CLI's own files, without exposing secrets", async () => {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { _KINDS } = await import("../src/accounts.mjs");
  const dir = mkdtempSync(join(tmpdir(), "taksim-acct-"));
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  // nothing yet: signed out everywhere
  for (const k of ["codex", "opencode", "copilot", "gemini"]) assert.equal((await _KINDS[k].status({ dir })).loggedIn, false, k);

  writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { refresh_token: "r",
    id_token: `h.${b64({ email: "me@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } })}.s` } }));
  const codex = await _KINDS.codex.status({ dir });
  assert.deepEqual([codex.loggedIn, codex.email, codex.plan], [true, "me@example.com", "ChatGPT plus"]);

  mkdirSync(join(dir, "data", "opencode"), { recursive: true });
  writeFileSync(join(dir, "data", "opencode", "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "sk-secret" } }));
  const oc = await _KINDS.opencode.status({ dir });
  assert.deepEqual([oc.loggedIn, oc.plan], [true, "OpenCode Go"]);
  assert.ok(!JSON.stringify(oc).includes("sk-secret"));

  mkdirSync(join(dir, ".gemini"), { recursive: true });
  writeFileSync(join(dir, ".gemini", "gemini-credentials.json"), "encrypted");
  writeFileSync(join(dir, ".gemini", "google_accounts.json"), JSON.stringify({ active: "g@example.com", old: [] }));
  writeFileSync(join(dir, ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }));
  const gm = await _KINDS.gemini.status({ dir });
  assert.deepEqual([gm.loggedIn, gm.email, gm.plan], [true, "g@example.com", "Google"]);

  writeFileSync(join(dir, "config.json"), "// managed automatically\n" + JSON.stringify({
    last_logged_in_user: { host: "https://github.com", login: "octocat" }, logged_in_users: [{ host: "https://github.com", login: "octocat" }] }));
  const cp = await _KINDS.copilot.status({ dir });
  assert.deepEqual([cp.loggedIn, cp.email, cp.plan], [true, "octocat", "Copilot"]);
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

test("a new Gemini account keeps its settings in its own folder and never self-updates", async () => {
  const { readFileSync } = await import("node:fs");
  const g = (await api("POST", "/v1/accounts", { name: "gem", backend: "gemini", copy_settings: false })).data;
  const s = JSON.parse(readFileSync(join(g.dir, ".gemini", "settings.json"), "utf8"));
  assert.equal(s.general.disableAutoUpdate, true);
  await api("DELETE", `/v1/accounts/${g.id}`);
});

test("a turn that fails while its login is signed out names the CLI to sign in to; signed in, it doesn't", async () => {
  const { writeFileSync, rmSync: rm } = await import("node:fs");
  const acct = (await api("POST", "/v1/accounts", { name: "expired", backend: "fake" })).data;
  writeFileSync(join(acct.dir, "logged-out"), "");
  const c = await newCanvas();
  const a = (await addAgent(c.id, { model: "fake-error", account: acct.id })).data;
  await say(c.id, a.id, "x");
  const last = async () => (await api("GET", `/v1/canvases/${c.id}/agents/${a.id}/transcript`)).data.transcript.filter((e) => e.kind === "error").at(-1);
  assert.equal((await last()).signIn, "fake");
  rm(join(acct.dir, "logged-out"), { force: true });
  await say(c.id, a.id, "again");
  assert.equal((await last()).signIn, undefined, "a failure of its own isn't a sign-in");
  await api("DELETE", `/v1/accounts/${acct.id}`);
});

test("an account being added goes when its sign-in is cancelled or fails, and stays once it signs in", async () => {
  const { writeFileSync } = await import("node:fs");
  const names = async () => (await api("GET", "/v1/accounts")).data.accounts.map((a) => a.name);
  // cancelled mid sign-in
  const a = (await api("POST", "/v1/accounts", { name: "half", backend: "fake", draft: true })).data;
  writeFileSync(join(a.dir, "logged-out"), "");
  await api("POST", `/v1/accounts/${a.id}/login`);
  await api("DELETE", `/v1/accounts/${a.id}/login`);
  assert.ok(!(await names()).includes("half"), "cancelled: nothing left behind");
  assert.ok(!existsSync(a.dir), "its folder goes too");
  // signed in
  const b = (await api("POST", "/v1/accounts", { name: "whole", backend: "fake", draft: true })).data;
  writeFileSync(join(b.dir, "logged-out"), "");
  await api("POST", `/v1/accounts/${b.id}/login`);
  await until(async () => (await api("GET", `/v1/accounts/${b.id}/login`)).data.done);
  const kept = (await api("GET", "/v1/accounts")).data.accounts.find((x) => x.id === b.id);
  assert.ok(kept && !kept.draft, "signed in: kept, no longer a draft");
  await api("DELETE", `/v1/accounts/${b.id}/login`);
  assert.ok((await names()).includes("whole"), "stopping a finished sign-in keeps it");
  // an ordinary account isn't a draft: a cancelled sign-in leaves it as it was
  const c = (await api("POST", "/v1/accounts", { name: "plain", backend: "fake" })).data;
  writeFileSync(join(c.dir, "logged-out"), "");
  await api("POST", `/v1/accounts/${c.id}/login`);
  await api("DELETE", `/v1/accounts/${c.id}/login`);
  assert.ok((await names()).includes("plain"));
  for (const x of [b, c]) await api("DELETE", `/v1/accounts/${x.id}`);
});

test("at start, a draft an earlier run left is removed unless it signed in", async () => {
  const { writeFileSync } = await import("node:fs");
  const { cleanDrafts } = await import("../src/accounts.mjs");
  const left = (await api("POST", "/v1/accounts", { name: "left", backend: "fake", draft: true })).data;
  writeFileSync(join(left.dir, "logged-out"), "");
  const landed = (await api("POST", "/v1/accounts", { name: "landed", backend: "fake", draft: true })).data;
  await cleanDrafts();
  const after = (await api("GET", "/v1/accounts")).data.accounts;
  assert.ok(!after.some((a) => a.id === left.id));
  assert.ok(after.some((a) => a.id === landed.id && !a.draft));
  await api("DELETE", `/v1/accounts/${landed.id}`);
});
