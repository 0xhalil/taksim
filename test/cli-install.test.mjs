// A CLI that isn't on the computer is installed from the official package into taksim's own folder, from one
// click; the list says how it goes. npm here is a stand-in script, so nothing is downloaded.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const home = mkdtempSync(join(tmpdir(), "taksim-home-"));
const tools = mkdtempSync(join(tmpdir(), "taksim-tools-"));
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_FAKE = "1";
process.env.TAKSIM_QUIET = "1";
// a PATH with nothing of the real CLIs: only the stand-in npm and the system's basics
const basics = ["/usr/bin", "/bin"];
process.env.PATH = [tools, ...basics].join(delimiter);
process.env.TAKSIM_CODEX_BIN = "codex"; // looked up by name on PATH

const { startServer } = await import("../src/server.mjs");
let server, base;
before(async () => {
  server = await startServer({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(home, { recursive: true, force: true }); rmSync(tools, { recursive: true, force: true }); });
const api = async (method, path) => {
  const r = await fetch(base + path, { method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const standIn = (body) => { writeFileSync(join(tools, "npm"), `#!/bin/sh\n${body}\n`); chmodSync(join(tools, "npm"), 0o755); };
const codex = async () => (await api("GET", "/v1/accounts")).data.backends.find((b) => b.name === "codex");

test("installing a missing CLI: one click, progress in the list, the CLI found afterwards", async () => {
  assert.equal((await codex()).installed, false);
  // npm gets the official package and installs under taksim's own folder (no -g into the system)
  standIn(`echo "$@" > "${join(tools, "args")}"; P=""; while [ $# -gt 0 ]; do [ "$1" = "--prefix" ] && P="$2"; shift; done
sleep 0.4; mkdir -p "$P/bin"; printf '#!/bin/sh\\nexit 0\\n' > "$P/bin/codex"; chmod +x "$P/bin/codex"`);
  const started = await api("POST", "/v1/accounts/backends/codex/install");
  assert.equal(started.status, 202);
  assert.equal(started.data.installing, true);
  // asking twice doesn't install twice
  assert.equal((await api("POST", "/v1/accounts/backends/codex/install")).data.installing, true);
  assert.equal((await codex()).installing, true);
  for (let i = 0; i < 100 && !(await codex()).installed; i++) await sleep(50);
  const b = await codex();
  assert.equal(b.installed, true);
  assert.equal(b.installing, false);
  assert.equal(b.installError, null);
  const args = readFileSync(join(tools, "args"), "utf8");
  assert.match(args, /install -g --prefix .*cli .*@openai\/codex/);
  assert.ok(existsSync(join(home, "cli", "bin", "codex")));
  // already there: nothing runs again
  assert.equal((await api("POST", "/v1/accounts/backends/codex/install")).data.installing, false);
});

test("a failed install says why and can be tried again; unknown and unsupported CLIs are refused", async () => {
  rmSync(join(home, "cli"), { recursive: true, force: true });
  standIn(`echo "npm error 404 not found" >&2; exit 1`);
  await api("POST", "/v1/accounts/backends/gemini/install");
  let b;
  for (let i = 0; i < 100; i++) { b = (await api("GET", "/v1/accounts")).data.backends.find((x) => x.name === "gemini"); if (!b.installing) break; await sleep(50); }
  assert.equal(b.installed, false);
  assert.match(b.installError, /404/);
  // trying again starts a new one and clears the old error
  standIn(`sleep 0.3; exit 1`);
  assert.equal((await api("POST", "/v1/accounts/backends/gemini/install")).data.installError, null);
  assert.equal((await api("POST", "/v1/accounts/backends/fake/install")).status, 400);
  assert.equal((await api("POST", "/v1/accounts/backends/nonsense/install")).status, 400);
  assert.equal((await api("GET", "/v1/accounts/backends/codex/install")).status, 405);
});
