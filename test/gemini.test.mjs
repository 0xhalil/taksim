// Gemini CLI: headless and TUI arguments, taksim's own settings per agent (MCP and turn hooks), and an
// account signed in with an API key instead of a Google login.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "taksim-home-"));
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_FAKE = "1";
process.env.TAKSIM_QUIET = "1";

const { startServer } = await import("../src/server.mjs");
const { default: gemini, INTRO } = await import("../src/backends/gemini.mjs");
const { pickBackend } = await import("../src/backends/index.mjs");
const { accountEnv, findAccount } = await import("../src/accounts.mjs");

let server, base;
before(async () => { server = await startServer({ host: "127.0.0.1", port: 0 }); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.close(); rmSync(home, { recursive: true, force: true }); });
async function api(method, path, body) {
  const r = await fetch(base + path, { method, headers: method === "GET" ? {} : { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}

test("Gemini is one of the CLIs, its models run on it", () => {
  assert.equal(pickBackend("gemini-2.5-flash").backend.name, "gemini");
  assert.equal(pickBackend("gemini").backend.name, "gemini");
});

test("headless: stream-json, read-only as plan, a named session; its MCP url in the env, no hooks", () => {
  const r = gemini.build({ model: "gemini-2.5-pro", system: "be brief", prompt: "hi",
    opts: { cwd: "/tmp", sandbox: "read-only", session: "s-1", newSession: true, mcpUrl: "http://127.0.0.1:1/mcp/tok" } });
  const a = r.args;
  assert.deepEqual(a.slice(0, 3), ["--output-format", "stream-json", "--skip-trust"]);
  assert.equal(a[a.indexOf("-m") + 1], "gemini-2.5-pro");
  assert.equal(a[a.indexOf("--approval-mode") + 1], "plan");
  assert.equal(a[a.indexOf("--session-id") + 1], "s-1");
  assert.match(a.at(-1), /<instructions>\nbe brief\n<\/instructions>\n\nhi/);
  assert.deepEqual(r.env, { TAKSIM_MCP_URL: "http://127.0.0.1:1/mcp/tok", TAKSIM_HOOK_URL: "" }, "hooks stay quiet in headless runs");
  assert.ok(gemini.build({ model: "gemini", prompt: "x", opts: { cwd: "/tmp", session: "s-1" } }).args.includes("--resume"));
});

test("terminal: the hook url in the env, a new session gets its instructions as its first message", () => {
  const r = gemini.interactive({ model: "gemini", session: "s-2", newSession: true, system: "you watch logs", mcpUrl: "http://m", hookUrl: "http://h/hooks/t" });
  assert.equal(r.args[r.args.indexOf("--session-id") + 1], "s-2");
  assert.ok(r.args[r.args.indexOf("-i") + 1].startsWith(INTRO));
  assert.deepEqual(r.env, { TAKSIM_MCP_URL: "http://m", TAKSIM_HOOK_URL: "http://h/hooks/t" });
  const resumed = gemini.interactive({ model: "gemini", session: "s-2", newSession: false, system: "x", mcpUrl: "http://m", hookUrl: "http://h" });
  assert.ok(resumed.args.includes("--resume") && !resumed.args.includes("-i"));
});

test("a Gemini account taksim makes carries taksim's MCP server and gated hooks in its own settings", async () => {
  const acct = (await api("POST", "/v1/accounts", { name: "g-ayar", backend: "gemini" })).data;
  const s = JSON.parse(readFileSync(join(acct.dir, ".gemini", "settings.json"), "utf8"));
  assert.equal(s.mcpServers.taksim.httpUrl, "$TAKSIM_MCP_URL");
  for (const ev of ["SessionStart", "BeforeAgent", "AfterAgent"]) assert.match(s.hooks[ev][0].hooks[0].command, /^\[ -n "\$TAKSIM_HOOK_URL" \]/);
  assert.equal(s.general.disableAutoUpdate, true);
  await api("DELETE", `/v1/accounts/${acct.id}`);
});

test("an agent's terminal turn: the setup message isn't recorded as the user's, the answer comes from prompt_response", async () => {
  const { getCanvas } = await import("../src/canvas/canvas.mjs");
  const c = (await api("POST", "/v1/canvases", {})).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "gemini" })).data;
  const agent = getCanvas(c.id).agents.get(a.id);
  agent.onHook("start", { prompt: `${INTRO}\n<instructions>x</instructions>`, session_id: "g1" });
  agent.onHook("stop", { prompt_response: "ready", session_id: "g1" });
  const t = (await api("GET", `/v1/canvases/${c.id}/agents/${a.id}/transcript`)).data;
  const entries = t.entries || t.transcript || t;
  assert.ok(!JSON.stringify(entries).includes("instructions>x"), "the setup isn't in the transcript as a user message");
  assert.equal(agent.lastText, "ready");
});

test("a Gemini account signed in with an API key: kept out of accounts.json, given to its CLI, gone with the account", async () => {
  const acct = (await api("POST", "/v1/accounts", { name: "kişisel gemini", backend: "gemini" })).data;
  const machine = (await api("POST", "/v1/accounts", { name: "bu mac gemini", backend: "gemini", machine: true })).data;
  assert.equal((await api("PUT", `/v1/accounts/${machine.id}/api-key`, { key: "k" })).status, 400, "this computer's login stays as it is");
  assert.equal((await api("PUT", `/v1/accounts/${acct.id}/api-key`, { key: "" })).status, 400);
  const st = await api("PUT", `/v1/accounts/${acct.id}/api-key`, { key: "AIza-test-key" });
  assert.equal(st.status, 200, JSON.stringify(st.data));
  assert.deepEqual([st.data.loggedIn, st.data.plan], [true, "API key"]);
  assert.ok(!readFileSync(join(home, "accounts.json"), "utf8").includes("AIza-test-key"));
  assert.equal(accountEnv(findAccount(acct.id)).GEMINI_API_KEY, "AIza-test-key");
  assert.equal(accountEnv(findAccount(acct.id)).GEMINI_CLI_HOME, acct.dir);
  assert.equal(JSON.parse(readFileSync(join(acct.dir, ".gemini", "settings.json"), "utf8")).security.auth.selectedType, "gemini-api-key");
  const other = (await api("POST", "/v1/accounts", { name: "c", backend: "fake" })).data;
  assert.equal((await api("PUT", `/v1/accounts/${other.id}/api-key`, { key: "x" })).status, 400, "only Gemini takes a key");
  await api("DELETE", `/v1/accounts/${acct.id}`);
  assert.equal(existsSync(join(home, "connections", `account-${acct.id}`)), false);
});

test("a private sign-in notes the page without opening the default browser", async () => {
  const acct = (await api("POST", "/v1/accounts", { name: "gizli", backend: "fake" })).data;
  const r = await api("POST", `/v1/accounts/${acct.id}/login`, { private: true });
  assert.equal(r.data.private, true);
  await api("DELETE", `/v1/accounts/${acct.id}/login`);
});
