// How much of a plan is used: Claude's rate_limit_event and Codex's session files, as windows.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "taksim-home-"));
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_FAKE = "1";
process.env.TAKSIM_QUIET = "1";

const { fromClaude, fromCodex, lastCodexLimits, readCodex, noteClaudeLimits, usageView, usageKey, onUsage, refreshUsage, _resetUsage } =
  await import("../src/usage.mjs");
after(() => rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

const later = Math.floor(Date.now() / 1000) + 3600;

test("Claude: the unified windows, and the extra-usage spend when the event is about it", () => {
  const u = fromClaude({ status: "allowed_warning", rateLimitType: "overage", utilization: 0.88, resetsAt: later,
    isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.03, resetsAt: later }, seven_day: { utilization: 0.52, resetsAt: later } } });
  assert.deepEqual(u.windows.map((w) => [w.id, w.used]), [["5h", 0.03], ["week", 0.52], ["extra", 0.88]]);
  assert.equal(u.windows[0].resetsAt, later * 1000);
  assert.equal(u.limited, false);
  // the event about the 5-hour window doesn't add it twice
  const v = fromClaude({ status: "rejected", rateLimitType: "five_hour", utilization: 1, unifiedWindows: { five_hour: { utilization: 1, resetsAt: later } } });
  assert.deepEqual(v.windows.map((w) => w.id), ["5h"]);
  assert.equal(v.limited, true);
  assert.equal(fromClaude(null), null);
  assert.equal(fromClaude({ status: "allowed" }), null);
});

test("Codex: primary and secondary windows by their length, credits and the plan", () => {
  const u = fromCodex({ primary: { used_percent: 12.5, window_minutes: 300, resets_at: later }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: later },
    credits: { has_credits: true, unlimited: false, balance: "3.5" }, plan_type: "plus", rate_limit_reached_type: null });
  assert.deepEqual(u.windows.map((w) => [w.id, w.used]), [["5h", 0.125], ["week", 0.4]]);
  assert.deepEqual(u.credits, { balance: 3.5 });
  assert.equal(u.plan, "plus");
  assert.equal(u.limited, false);
  assert.equal(fromCodex({ primary: { used_percent: 100, window_minutes: 300 }, rate_limit_reached_type: "primary" }).limited, true);
});

test("Codex: the newest session file's last rate_limits", () => {
  const codex = join(home, "codex");
  const day = (d) => join(codex, "sessions", "2026", "10", d);
  mkdirSync(day("07"), { recursive: true });
  mkdirSync(day("08"), { recursive: true });
  const line = (pct) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: pct, window_minutes: 300, resets_at: later } } } });
  writeFileSync(join(day("07"), "rollout-a.jsonl"), line(90) + "\n");
  writeFileSync(join(day("08"), "rollout-b.jsonl"), [line(5), "{\"type\":\"other\"}", line(7), ""].join("\n"));
  assert.equal(lastCodexLimits(join(day("08"), "rollout-b.jsonl")).primary.used_percent, 7);
  const u = readCodex("acct1", codex);
  assert.equal(u.windows[0].used, 0.07);
  assert.equal(usageView("acct1").windows[0].used, 0.07);
  assert.equal(readCodex("none", join(home, "missing")), null);
});

test("a window that has since reset shows empty; listeners hear of new numbers; a login's key", async () => {
  _resetUsage();
  const heard = [];
  const off = onUsage((k, u) => heard.push([k, u.windows[0].used]));
  noteClaudeLimits("machine:claude", { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.6, resetsAt: Math.floor(Date.now() / 1000) - 10 } } });
  off();
  assert.deepEqual(heard, [["machine:claude", 0]]);
  assert.equal(usageView("machine:claude").windows[0].resetsAt, null);
  assert.equal(usageKey({ id: "a1", backend: "claude", dir: "/x" }), "a1");
  assert.equal(usageKey({ id: "a2", backend: "claude", dir: null }), "machine:claude");
  assert.equal(usageKey(null, "codex"), "machine:codex");
  // under the test backend nothing runs the real CLI
  assert.equal(await refreshUsage({ key: "k", backend: "claude", force: true }), null);
});

test("GET /v1/usage names each login: account name and who signed in", async () => {
  const { startServer } = await import("../src/server.mjs");
  const server = await startServer({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const acct = await (await fetch(base + "/v1/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "iş", backend: "fake" }) })).json();
    noteClaudeLimits(acct.id, { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: later } } });
    noteClaudeLimits("machine:fake", { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: later } } });
    const body = await (await fetch(base + "/v1/usage")).json();
    assert.deepEqual([body.logins[acct.id].name, body.logins[acct.id].backend, body.logins[acct.id].machine], ["iş", "fake", false]);
    assert.equal(body.logins["machine:fake"].machine, true);
    // once both are read: this computer signed in as "iş" is the same login, shown once
    rmSync(join(home, "fake-home", "logged-out"), { force: true }); // the test CLI's own login signs in as the same user
    const after = await (await fetch(base + "/v1/usage/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    const m = after.logins["machine:fake"];
    assert.equal(m.email, after.logins[acct.id].email);
    assert.deepEqual([m.same, m.name], [acct.id, "iş"]);
  } finally { server.close(); }
});

test("GET /v1/usage leaves out a CLI's own login once it reads as signed out", async () => {
  const { startServer } = await import("../src/server.mjs");
  const server = await startServer({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    mkdirSync(join(home, "fake-home"), { recursive: true });
    writeFileSync(join(home, "fake-home", "logged-out"), "");
    noteClaudeLimits("machine:fake", { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: later } } });
    const body = await (await fetch(base + "/v1/usage/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    assert.equal(body.logins["machine:fake"], undefined);
    assert.equal(body.usage["machine:fake"], undefined);
  } finally { rmSync(join(home, "fake-home", "logged-out"), { force: true }); server.close(); }
});
