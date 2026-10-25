// Compat endpoints, guards and cancellation against the fake backend (no subscriptions needed).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";

process.env.TAKSIM_FAKE = "1";
process.env.TAKSIM_QUIET = "1";
process.env.TAKSIM_OPENCODE_BIN = "/nonexistent/opencode"; // skip the real model listing

const { startServer } = await import("../src/server.mjs");

let server, base;
before(async () => {
  server = await startServer({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, body, headers = {}) => fetch(base + path, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});

// raw request, so Host/Origin can be set freely
function raw(path, { method = "GET", headers = {}, body } = {}) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function readSse(res) {
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const data = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "))?.slice(6);
      buf = buf.slice(i + 2);
      if (data) events.push(data === "[DONE]" ? data : JSON.parse(data));
    }
  }
  return events;
}

const userMsg = (content) => [{ role: "user", content }];

test("lists fake models", async () => {
  const r = await (await fetch(base + "/v1/models")).json();
  assert.ok(r.data.some((m) => m.id === "fake-echo" && m.owned_by === "fake"));
});

test("openai non-stream", async () => {
  const r = await post("/v1/chat/completions", { model: "fake-echo", messages: userMsg("hello") });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.choices[0].message.content, "echo: hello");
  assert.equal(d.backend, "fake");
  assert.match(d.session_id, /^fake-/);
  assert.equal(r.headers.get("x-agent-session-id"), d.session_id);
});

test("openai stream yields deltas, usage and [DONE]", async () => {
  const r = await post("/v1/chat/completions", {
    model: "fake-echo", stream: true, stream_options: { include_usage: true }, messages: userMsg("abcd"),
  });
  const ev = await readSse(r);
  const text = ev.filter((e) => e !== "[DONE]").map((e) => e.choices?.[0]?.delta?.content || "").join("");
  assert.equal(text, "echo: abcd");
  assert.ok(ev.some((e) => e.usage?.completion_tokens === "echo: abcd".length));
  assert.equal(ev.at(-1), "[DONE]");
});

test("anthropic non-stream and stream", async () => {
  const d = await (await post("/v1/messages", { model: "fake-echo", system: "s", messages: userMsg("hi") })).json();
  assert.equal(d.content[0].text, "echo: hi");
  const ev = await readSse(await post("/v1/messages", { model: "fake-echo", stream: true, messages: userMsg("yo") }));
  assert.equal(ev.filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join(""), "echo: yo");
  assert.equal(ev.at(-1).type, "message_stop");
});

test("history is flattened into one prompt", async () => {
  const d = await (await post("/v1/chat/completions", { model: "fake-args", messages: [
    { role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" },
  ] })).json();
  const { prompt } = JSON.parse(d.choices[0].message.content);
  assert.match(prompt, /<conversation_history>[\s\S]*<assistant>\nb\n<\/assistant>[\s\S]*<user>\nc\n<\/user>$/);
});

test("agent mode runs in x-agent-cwd and resumes sessions", async () => {
  const d = await (await post("/v1/chat/completions", { model: "fake-args", messages: userMsg("x") },
    { "x-agent-cwd": realpathSync.native(tmpdir()), "x-agent-session": "abc-1" })).json();
  const out = JSON.parse(d.choices[0].message.content);
  assert.equal(out.cwd, realpathSync.native(tmpdir()));
  assert.deepEqual(out.argv.slice(out.argv.indexOf("--session"), out.argv.indexOf("--session") + 2), ["--session", "abc-1"]);
});

test("backend errors map to 502", async () => {
  const e1 = await post("/v1/chat/completions", { model: "fake-error", messages: userMsg("x") });
  assert.equal(e1.status, 502);
  assert.match((await e1.json()).error.message, /fake failure/);
  const e2 = await post("/v1/chat/completions", { model: "fake-crash", messages: userMsg("x") });
  assert.equal(e2.status, 502);
  assert.match((await e2.json()).error.message, /fake crash/);
});

test("request validation", async () => {
  const cases = [
    [{ model: "fake-echo", messages: [{ role: "system", content: "x" }] }, {}, /non-system/],
    [{ model: "fake-echo", messages: userMsg("x") }, { "x-agent-permission": "bypassPermissions" }, /permission must be/],
    [{ model: "fake-echo", messages: userMsg("x") }, { "x-agent-sandbox": "danger-full-access" }, /sandbox must be/],
    [{ model: "fake-echo", messages: userMsg("x") }, { "x-agent-cwd": "relative/dir" }, /absolute/],
    [{ model: "fake-echo", messages: userMsg("x") }, { "x-agent-session": "a;rm -rf" }, /session/],
  ];
  for (const [body, headers, re] of cases) {
    const r = await post("/v1/chat/completions", body, headers);
    assert.equal(r.status, 400);
    assert.match((await r.json()).error.message, re);
  }
});

test("guards reject foreign Host, foreign Origin and non-JSON posts", async () => {
  const { port } = new URL(base);
  assert.equal((await raw("/v1/models", { headers: { host: `evil.example:${port}` } })).status, 403);
  assert.equal((await raw("/v1/models", { headers: { host: `127.0.0.1:${port}`, origin: "https://evil.example" } })).status, 403);
  assert.equal((await raw("/v1/models", { headers: { host: `localhost:${port}`, origin: `http://localhost:${port}` } })).status, 200);
  const form = await raw("/v1/chat/completions", {
    method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "text/plain" },
    body: JSON.stringify({ model: "fake-echo", messages: userMsg("x") }),
  });
  assert.equal(form.status, 415);
});

test("refuses non-loopback bind without remote opt-in", async () => {
  await assert.rejects(startServer({ host: "0.0.0.0", port: 0 }), /TAKSIM_ALLOW_REMOTE/);
});

test("client disconnect kills the CLI and its grandchildren", async () => {
  const ac = new AbortController();
  const r = await post("/v1/chat/completions", { model: "fake-slow", stream: true, messages: userMsg("x") });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", pids;
  while (!pids) {
    buf += dec.decode((await reader.read()).value, { stream: true });
    const m = buf.match(/\{\\"pid\\":(\d+),\\"child\\":(\d+)\}/);
    if (m) pids = [Number(m[1]), Number(m[2])];
  }
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(pids.every(alive));
  await reader.cancel();
  ac.abort();
  for (let i = 0; i < 40 && pids.some(alive); i++) await sleep(100);
  assert.deepEqual(pids.filter(alive), []);
});

test("read-only agents run Claude in plan mode, headless and in the terminal", async () => {
  const { default: claude } = await import("../src/backends/claude.mjs");
  const headless = claude.build({ model: "haiku", system: "", prompt: "x", opts: { cwd: "/tmp", sandbox: "read-only" } }).args;
  assert.equal(headless[headless.indexOf("--permission-mode") + 1], "plan");
  const writable = claude.build({ model: "haiku", system: "", prompt: "x", opts: { cwd: "/tmp" } }).args;
  assert.equal(writable[writable.indexOf("--permission-mode") + 1], "acceptEdits");
  const tui = claude.interactive({ model: "haiku", session: "s", system: "", mcpUrl: "u", hookUrl: "h", sandbox: "read-only" }).args;
  assert.equal(tui[tui.indexOf("--permission-mode") + 1], "plan");
});
