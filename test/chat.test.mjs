// The chat around an agent: checkpoints before each turn (what it changed, going back), attachments (files,
// picked lines, pasted images) said to the agent with the message.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const home = mkdtempSync(join(tmpdir(), "taksim-home-"));
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_FAKE = "1";
process.env.TAKSIM_QUIET = "1";

const { startServer } = await import("../src/server.mjs");
const { snapshot, changes, restore, fileDiff } = await import("../src/canvas/checkpoint.mjs");
const { getCanvas } = await import("../src/canvas/canvas.mjs");

let server, base, repo;
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
before(async () => {
  server = await startServer({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
  repo = mkdtempSync(join(tmpdir(), "taksim-repo-"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  writeFileSync(join(repo, ".gitignore"), "secret.env\n");
  git("add", "."); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
});
after(() => { server.close(); rmSync(home, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); });
async function api(method, path, body) {
  const r = await fetch(base + path, { method, headers: method === "GET" ? {} : { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}

test("pending chat requests can be edited, reordered and cancelled without changing active or inter-agent work", async () => {
  const c = (await api("POST", "/v1/canvases", {})).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-slow", chat: true })).data;
  const path = `/v1/canvases/${c.id}/agents/${a.id}`;
  const agent = getCanvas(c.id).agents.get(a.id);
  try {
    await api("POST", `${path}/messages`, { text: "active" });
    await api("POST", `${path}/messages`, { text: "first", attachments: [{ kind: "file", path: "a.txt" }] });
    const other = agent.enqueue({ kind: "reply", from: "another-agent", text: "between" }).catch(() => {});
    await api("POST", `${path}/messages`, { text: "second" });
    const q = (await api("GET", `${path}/queue`)).data.messages;
    assert.deepEqual(q.map((m) => m.text), ["first", "second"]);
    assert.equal((await api("PATCH", `${path}/queue`, { id: q[0].id, text: "revised" })).status, 200);
    assert.equal((await api("PATCH", `${path}/queue`, { id: q[0].id, text: "" })).status, 200, "attachment-only requests are valid");
    assert.equal((await api("PATCH", `${path}/queue`, { id: q[1].id, text: "" })).status, 400);
    await api("PATCH", `${path}/queue`, { id: q[0].id, text: "revised" });
    assert.equal((await api("PATCH", `${path}/queue`, { order: [q[1].id, q[0].id] })).status, 200);
    assert.deepEqual(agent.queue.map((m) => m.text), ["second", "between", "revised"]);
    assert.equal(agent.current.item.text, "active");
    assert.equal((await api("PATCH", `${path}/queue`, { order: [q[0].id, q[0].id] })).status, 409);
    assert.equal((await api("POST", `${path}/queue`, { id: agent.queue[1].id })).status, 409, "agent messages aren't editable");
    assert.equal((await api("POST", `${path}/queue`, { id: q[1].id })).status, 200);
    assert.equal((await api("PATCH", `${path}/queue`, { id: q[1].id, text: "too late" })).status, 409);
    assert.deepEqual((await api("GET", `${path}/queue`)).data.messages[0].attachments, [{ kind: "file", path: "a.txt" }]);
    const transcript = (await api("GET", `${path}/transcript`)).data.transcript;
    assert.equal(transcript.some((m) => m.text === "second"), false, "cancelled messages never enter history");
    await api("PATCH", path, { model: "fake-echo" });
    await api("POST", `${path}/stop`);
    for (let i = 0; i < 80 && (agent.current || agent.queue.length); i++) await sleep(50);
    assert.equal(agent.queue.length, 0);
    assert.equal(agent.current, null);
    assert.equal((await api("PATCH", `${path}/queue`, { id: q[0].id, text: "late" })).status, 409);
    const done = (await api("GET", `${path}/transcript`)).data.transcript;
    assert.ok(done.some((m) => m.kind === "user" && m.text === "revised"));
    await other;
  } finally { await api("DELETE", path); }
});

test("a checkpoint is the working tree as a tree, without touching the index, branch or stash", async () => {
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  const before = await snapshot(repo);
  const staged = git("diff", "--cached", "--name-only");
  writeFileSync(join(repo, "a.txt"), "ONE\ntwo\nthree\n");
  writeFileSync(join(repo, "new.txt"), "fresh\n");
  writeFileSync(join(repo, "secret.env"), "TOKEN=1\n");
  const after = await snapshot(repo);
  assert.equal(git("diff", "--cached", "--name-only"), staged, "the user's index is as it was");
  assert.equal(git("stash", "list"), "");
  const ch = await changes(repo, before, after);
  assert.deepEqual(ch.map((c) => [c.path, c.added, c.removed]).sort(), [["a.txt", 1, 1], ["new.txt", 1, 0]], "ignored files aren't part of it");
  assert.match(await fileDiff(repo, before, after, "a.txt"), /-one\n\+ONE/);
  // back: the change undone, the new file gone, the ignored one left alone
  const r = await restore(repo, before);
  assert.equal(r.removed, 1);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "one\ntwo\nthree\n");
  assert.equal(existsSync(join(repo, "new.txt")), false);
  assert.equal(existsSync(join(repo, "secret.env")), true);
  assert.equal(await snapshot(tmpdir()), null, "outside git there are no checkpoints");
});

test("a turn records what it changed and the checkpoint before it; the chat goes back to it", async () => {
  const c = (await api("POST", "/v1/canvases", {})).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-wait", cwd: repo })).data;
  const sent = await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/messages`, { text: "edit it" });
  assert.equal(sent.status, 202);
  await sleep(150); // the agent "edits" while its turn runs
  writeFileSync(join(repo, "a.txt"), "changed by the turn\n");
  let t;
  for (let i = 0; i < 60; i++) {
    t = (await api("GET", `/v1/canvases/${c.id}/agents/${a.id}/transcript`)).data.transcript;
    if (t.some((e) => e.kind === "assistant")) break;
    await sleep(50);
  }
  const answer = t.find((e) => e.kind === "assistant");
  assert.ok(answer.checkpoint, "the checkpoint before the turn");
  assert.deepEqual(answer.changes.map((x) => x.path), ["a.txt"]);
  const d = await api("GET", `/v1/canvases/${c.id}/agents/${a.id}/diff?from=${answer.checkpoint}&to=${answer.after}&path=a.txt`);
  assert.match(d.data.diff, /\+changed by the turn/);
  // the chat's turn diff reads both sides from the trees, so later edits don't creep in
  const at = (t) => api("GET", `/v1/canvases/${c.id}/agents/${a.id}/checkpoint?at=${t}&path=a.txt`);
  assert.equal((await at(answer.checkpoint)).data.content, "one\ntwo\nthree\n");
  assert.equal((await at(answer.after)).data.content, "changed by the turn\n");
  // a file that wasn't there yet is empty, and a tree that isn't a checkpoint is refused
  assert.equal((await api("GET", `/v1/canvases/${c.id}/agents/${a.id}/checkpoint?at=${answer.checkpoint}&path=nope.txt`)).data.content, "");
  assert.equal((await api("GET", `/v1/canvases/${c.id}/agents/${a.id}/checkpoint?at=nope&path=a.txt`)).status, 400);
  assert.equal((await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/restore`, { checkpoint: "nope" })).status, 400);
  assert.equal((await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/restore`, { checkpoint: answer.checkpoint })).status, 200);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "one\ntwo\nthree\n");
  t = (await api("GET", `/v1/canvases/${c.id}/agents/${a.id}/transcript`)).data.transcript;
  assert.equal(t.at(-1).kind, "restore");
  // and forward again: the restore's own "now" undoes it
  assert.equal((await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/restore`, { checkpoint: t.at(-1).redo })).status, 200);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "changed by the turn\n");
});

test("attachments go to the agent with the message; a pasted image is kept in the workspace", async () => {
  const c = (await api("POST", "/v1/canvases", {})).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-echo", chat: true })).data;
  assert.equal(a.chat, true);
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const up = await fetch(`${base}/v1/canvases/${c.id}/agents/${a.id}/attachments`, { method: "POST", headers: { "content-type": "image/png" }, body: png });
  assert.equal(up.status, 201);
  const { path } = await up.json();
  assert.ok(existsSync(path) && path.endsWith(".png"));
  assert.equal((await fetch(`${base}/v1/canvases/${c.id}/agents/${a.id}/attachments`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" })).status, 415);
  const r = await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/messages`, { text: "bak", wait: true, attachments: [
    { kind: "file", path: "src/app.js" }, { kind: "selection", path: "src/app.js", from: 10, to: 12, text: "let x = 1" },
    { kind: "image", path }, { kind: "agent", name: "yazar" }] });
  assert.match(r.data.text, /\[Attached by the user\]/);
  assert.match(r.data.text, /- file: src\/app\.js/);
  assert.match(r.data.text, /lines 10-12 of src\/app\.js:\n```\nlet x = 1\n```/);
  assert.match(r.data.text, /image: .*\.png/);
  assert.match(r.data.text, /the agent "yazar"/);
  const t = (await api("GET", `/v1/canvases/${c.id}/agents/${a.id}/transcript`)).data.transcript;
  assert.equal(t.find((e) => e.kind === "user").attachments.length, 4, "the chat shows them with the message");
  assert.equal((await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/messages`, { attachments: [{ kind: "virus" }] })).status, 400);
});

test("chat forks freeze the chosen conversation and persist independent sessions without copying checkpoints", async () => {
  const c = (await api("POST", "/v1/canvases", {})).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-echo", chat: true, chatMode: "plan" })).data;
  const path = `/v1/canvases/${c.id}/agents/${a.id}`;
  const agent = getCanvas(c.id).agents.get(a.id);
  agent.session = "parent-session";
  agent.record({ from: "user", to: a.id, kind: "user", text: "first", attachments: [{ kind: "selection", path: "a.txt", text: "selected", from: 1, to: 1 }] });
  agent.record({ from: a.id, to: "user", kind: "assistant", text: "plan", checkpoint: "abc", changes: [{ path: "a.txt", added: 1 }] });
  agent.record({ from: "user", to: a.id, kind: "user", text: "later" });
  const entries = (await api("GET", `${path}/transcript`)).data.transcript;
  const branch = await api("POST", `${path}/fork`, { at: entries[1].ts, from: a.id, text: "plan" });
  assert.equal(branch.status, 201);
  const b = branch.data;
  assert.equal(b.session, null);
  assert.equal(b.chat, true);
  assert.equal(b.chatMode, "plan");
  assert.equal(b.sandbox, "read-only");
  assert.equal(b.chatOrigin.id, a.id);
  assert.match(b.forkContext, /selected/);
  assert.doesNotMatch(b.forkContext, /later/);
  const transcript = (await api("GET", `/v1/canvases/${c.id}/agents/${b.id}/transcript`)).data.transcript;
  assert.deepEqual(transcript.map((e) => e.text), ["first", "plan"]);
  assert.equal(transcript[1].from, b.id);
  assert.equal(transcript[1].checkpoint, undefined);
  assert.equal(transcript[1].changes, undefined);
  assert.equal(agent.session, "parent-session");
  const { loadCanvas } = await import("../src/canvas/store.mjs");
  getCanvas(c.id).flush();
  const saved = loadCanvas(c.id).agents.find((e) => e.id === b.id);
  assert.equal(saved.forkContext, b.forkContext);
  const fresh = await api("POST", `${path}/fork`, { fresh: true });
  assert.equal(fresh.status, 201);
  assert.equal(fresh.data.forkContext, "");
  assert.deepEqual((await api("GET", `/v1/canvases/${c.id}/agents/${fresh.data.id}/transcript`)).data.transcript, []);
  const count = getCanvas(c.id).agents.size;
  assert.equal((await api("POST", `${path}/fork`, { at: 0, from: a.id, text: "missing" })).status, 409);
  assert.equal(getCanvas(c.id).agents.size, count);
  await api("DELETE", `/v1/canvases/${c.id}`);
});

test("seeded history carries what was said, not the restores and change lists between", async () => {
  const c = (await api("POST", "/v1/canvases", {})).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-echo" })).data;
  const agent = getCanvas(c.id).agents.get(a.id);
  agent.record({ from: "user", to: a.id, kind: "user", text: "first" });
  agent.record({ from: a.id, to: "user", kind: "assistant", text: "done" });
  agent.record({ from: "user", to: a.id, kind: "restore", text: "", checkpoint: "abc", redo: "def" });
  agent.record({ from: a.id, to: "user", kind: "changes", text: "", changes: [{ path: "a.txt", added: 1 }] });
  agent.record({ from: "user", to: a.id, kind: "user", text: "second" });
  agent.seedHistory = true;
  const prompt = agent.prompt({ kind: "user", text: "second" });
  assert.match(prompt, /<user>\nfirst\n<\/user>\n\n<you>\ndone\n<\/you>\n<\/conversation_history>/);
  assert.doesNotMatch(prompt, /<user>\n\n<\/user>|<you>\n\n<\/you>/);
  await api("DELETE", `/v1/canvases/${c.id}`);
});

test("Ask and Plan modes are read-only, start fresh context on transition, and reject changes while work is pending", async () => {
  const c = (await api("POST", "/v1/canvases", {})).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-slow", chatMode: "ask" })).data;
  const path = `/v1/canvases/${c.id}/agents/${a.id}`;
  const agent = getCanvas(c.id).agents.get(a.id);
  assert.equal(agent.sandbox, "read-only");
  assert.match(agent.systemPrompt(), /Chat mode: Ask/);
  assert.equal((await api("PATCH", path, { chatMode: "invalid" })).status, 400);
  assert.equal((await api("PATCH", path, { chatMode: "plan" })).status, 200);
  agent.record({ from: a.id, to: "user", kind: "assistant", text: "The plan" });
  agent.session = "read-only-session";
  assert.equal((await api("PATCH", path, { chatMode: "agent" })).status, 200);
  assert.equal(agent.session, null);
  assert.equal(agent.sandbox, null);
  const { loadCanvas } = await import("../src/canvas/store.mjs");
  getCanvas(c.id).flush();
  assert.equal(loadCanvas(c.id).agents[0].seedHistory, false);
  assert.ok(loadCanvas(c.id).agents[0].modeContextSince);
  agent.record({ from: "user", to: a.id, kind: "user", text: "Implement" });
  assert.doesNotMatch(agent.prompt({ kind: "user", text: "Implement" }), /The plan/);
  agent.seedHistory = true;
  assert.doesNotMatch(agent.prompt({ kind: "user", text: "Implement" }), /The plan/);
  await api("POST", `${path}/messages`, { text: "active" });
  assert.equal((await api("PATCH", path, { chatMode: "ask", name: "unexpected" })).status, 409);
  assert.equal(agent.name, a.name);
  assert.equal(agent.chatMode, "agent");
  await api("DELETE", `/v1/canvases/${c.id}`);
});

test("tool activity streams real states and is archived once with the answer", async () => {
  const c = (await api("POST", "/v1/canvases", {})).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-activity" })).data;
  const path = `/v1/canvases/${c.id}/agents/${a.id}`;
  const reply = await api("POST", `${path}/messages`, { text: "test", wait: true });
  assert.equal(reply.status, 200);
  const events = getCanvas(c.id).bus.buffer.filter((e) => e.type === "chat_activity");
  assert.equal(events[0].data.reset, true);
  assert.deepEqual(events.filter((e) => e.data.activity).map((e) => e.data.activity.status), ["running", "done"]);
  const transcript = (await api("GET", `${path}/transcript`)).data.transcript;
  assert.deepEqual(transcript.at(-1).activities, [{ id: "tool-1", label: "Command", detail: "npm test", status: "done" }]);
  assert.deepEqual((await api("GET", `${path}/activity`)).data.activities, []);
  await api("DELETE", `/v1/canvases/${c.id}`);
});

test("past chat mentions carry a frozen server-resolved reference, not a new request to the other agent", async () => {
  const c = (await api("POST", "/v1/canvases", {})).data;
  const source = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-echo", name: "Kaynak" })).data;
  const target = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-echo" })).data;
  const origin = getCanvas(c.id).agents.get(source.id);
  origin.record({ from: source.id, to: "user", kind: "assistant", text: "previous decision" });
  const path = `/v1/canvases/${c.id}/agents/${target.id}`;
  const reply = await api("POST", `${path}/messages`, { text: "use context", wait: true, attachments: [{ kind: "conversation", path: source.id, text: "untrusted replacement" }] });
  assert.equal(reply.status, 200);
  assert.match(reply.data.text, /previous decision/);
  assert.doesNotMatch(reply.data.text, /untrusted replacement/);
  assert.equal(origin.current, null);
  origin.record({ from: source.id, to: "user", kind: "assistant", text: "later decision" });
  const transcript = (await api("GET", `${path}/transcript`)).data.transcript;
  assert.doesNotMatch(transcript[0].attachments[0].text, /later decision/);
  assert.equal((await api("POST", `${path}/messages`, { attachments: [{ kind: "conversation", path: "missing" }] })).status, 409);
  await api("DELETE", `/v1/canvases/${c.id}`);
});

test("reviewed plans persist, reject stale versions and build only the chosen content", async () => {
  const c = (await api("POST", "/v1/canvases", {})).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-delegate", cwd: repo, chatMode: "plan", chat: true })).data;
  const path = `/v1/canvases/${c.id}/agents/${a.id}`;
  const agent = getCanvas(c.id).agents.get(a.id);
  try {
    await api("POST", `${path}/messages`, { text: "ordinary plan-mode answer", wait: true });
    assert.equal((await api("GET", `${path}/workflow`)).data.plan, null, "ordinary answers do not create an approval action");
    const content = "# Implement\n\n1. Inspect a.txt\n2. Validate behavior";
    await api("POST", `${path}/messages`, { text: `CALL ${JSON.stringify({ tool: "propose_plan", args: { title: "Change", content } })}`, wait: true });
    const plan = (await api("GET", `${path}/workflow`)).data.plan;
    assert.equal(plan.status, "draft");
    assert.equal(readFileSync(join(home, "plans", c.id, a.id, `${plan.id}-v1.md`), "utf8"), content + "\n");
    const revised = (await api("PATCH", `${path}/workflow`, { id: plan.id, version: plan.version, content: "# Revised\nOnly inspect a.txt" })).data.plan;
    assert.equal(revised.version, 2);
    assert.equal((await api("POST", `${path}/workflow`, { action: "build", id: plan.id, version: 1 })).status, 409);
    assert.equal(agent.chatMode, "plan");
    const saved = await api("POST", `${path}/workflow`, { action: "save", id: revised.id, version: 2 });
    assert.equal(saved.status, 201);
    assert.equal(readFileSync(join(repo, saved.data.path), "utf8"), revised.content + "\n");
    writeFileSync(join(repo, saved.data.path), "user edit");
    assert.equal((await api("POST", `${path}/workflow`, { action: "save", id: revised.id, version: 2 })).status, 409);
    const built = await api("POST", `${path}/workflow`, { action: "build", id: revised.id, version: 2 });
    assert.equal(built.status, 202);
    assert.equal(agent.chatMode, "agent");
    assert.equal((await api("POST", `${path}/workflow`, { action: "build", id: revised.id, version: 2 })).status, 409);
    for (let i = 0; i < 100 && agent.current; i++) await sleep(30);
    assert.equal(agent.chatPlan.status, "done");
    const entry = (await api("GET", `${path}/transcript`)).data.transcript.find((e) => e.kind === "user" && e.text.includes("<approved_plan"));
    assert.ok(entry.text.includes(revised.content));
    assert.ok(!entry.text.includes(content));
    const { loadCanvas } = await import("../src/canvas/store.mjs");
    getCanvas(c.id).flush();
    assert.equal(loadCanvas(c.id).agents[0].chatPlan.status, "done");
    const { Agent } = await import("../src/canvas/agent.mjs");
    const savedAgent = loadCanvas(c.id).agents[0];
    const recovered = new Agent(getCanvas(c.id), { ...savedAgent, chatPlan: { ...savedAgent.chatPlan, status: "running" } });
    assert.equal(recovered.chatPlan.status, "failed", "an interrupted plan can be revised after restart");
    const next = (await api("POST", `${path}/workflow`, { action: "revise", id: revised.id, version: 2 })).data.plan;
    assert.equal(next.status, "draft");
    assert.notEqual(next.id, revised.id);
    assert.equal(agent.chatMode, "plan");
    await api("PATCH", path, { model: "fake-error" });
    await api("POST", `${path}/workflow`, { action: "build", id: next.id, version: next.version });
    for (let i = 0; i < 100 && agent.current; i++) await sleep(30);
    assert.equal(agent.chatPlan.status, "failed");
  } finally { await api("DELETE", `/v1/canvases/${c.id}`); }
});

test("permission prompts reach the person in the chat: allow, allow a kind, deny, and a stopped turn refuses", async () => {
  const c = (await api("POST", "/v1/canvases", {})).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-delegate", permission: "default" })).data;
  assert.equal(a.permission, "default");
  const path = `/v1/canvases/${c.id}/agents/${a.id}`;
  const agent = getCanvas(c.id).agents.get(a.id);
  const call = (command) => `CALL ${JSON.stringify({ tool: "approve", args: { tool_name: "Bash", input: { command } } })}`;
  const waitQuestion = async () => { for (let i = 0; i < 100 && !agent.workflow.pending; i++) await sleep(30); return agent.workflow.pending?.view; };
  const finish = async () => { for (let i = 0; i < 100 && agent.current; i++) await sleep(30); };
  const reply = async (q, answer) => (await api("POST", `${path}/workflow`, { action: "answer", id: q.id, answers: { q1: answer } })).status;
  try {
    // one yes: allowed once, and the person's chat says what was asked
    await api("POST", `${path}/messages`, { text: call("curl -s https://example.com") });
    let q = await waitQuestion();
    assert.ok(q); assert.equal(agent.status, "waiting");
    assert.equal(q.questions[0].title, "Run: curl -s https://example.com");
    assert.equal(q.questions[0].options.length, 3);
    assert.equal(await reply(q, q.questions[0].options[0]), 200);
    await finish();
    assert.match(agent.lastText, /"behavior":"allow"/);
    // the same program asks again: it was allowed once, not for good
    await api("POST", `${path}/messages`, { text: call("curl https://example.org") });
    q = await waitQuestion(); assert.ok(q);
    // a kind, for this chat: curl no more asks, but a chain of commands is judged whole
    assert.equal(await reply(q, q.questions[0].options[1]), 200);
    await finish();
    assert.match(agent.lastText, /"behavior":"allow"/);
    await api("POST", `${path}/messages`, { text: call("curl https://example.net") });
    await finish();
    assert.equal(agent.workflow.pending, null);
    assert.match(agent.lastText, /"behavior":"allow"/);
    await api("POST", `${path}/messages`, { text: call("curl https://example.net; rm -rf ~") });
    q = await waitQuestion(); assert.ok(q);
    // free text is a no that says why
    assert.equal(await reply(q, "not that one"), 200);
    await finish();
    assert.match(agent.lastText, /"behavior":"deny"/);
    assert.match(agent.lastText, /not that one/);
    // a stopped turn refuses what was waiting
    await api("POST", `${path}/messages`, { text: call("npm publish") });
    q = await waitQuestion(); assert.ok(q);
    await api("POST", `${path}/stop`);
    await finish();
    assert.equal(agent.workflow.pending, null);
    assert.equal((await api("PATCH", path, { permission: "nonsense" })).status, 400);
    assert.equal((await api("PATCH", path, { permission: "acceptEdits" })).data.permission, "acceptEdits");
    assert.equal((await api("PATCH", path, { permission: "auto" })).data.permission, null);
  } finally { await api("DELETE", `/v1/canvases/${c.id}`); }
});

test("clarifications suspend the real tool call, accept free text and cancel with the turn", async () => {
  const c = (await api("POST", "/v1/canvases", {})).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-delegate", chatMode: "ask" })).data;
  const path = `/v1/canvases/${c.id}/agents/${a.id}`;
  const agent = getCanvas(c.id).agents.get(a.id);
  const text = `CALL ${JSON.stringify({ tool: "ask_user", args: { questions: [{ title: "Which approach?", options: ["A", "B"] }] } })}`;
  try {
    await api("POST", `${path}/messages`, { text });
    for (let i = 0; i < 100 && !agent.workflow.pending; i++) await sleep(30);
    const question = (await api("GET", `${path}/workflow`)).data.question;
    assert.ok(question);
    assert.equal(agent.status, "waiting");
    assert.equal((await api("POST", `${path}/workflow`, { action: "answer", id: question.id, answers: {} })).status, 400);
    assert.equal((await api("POST", `${path}/workflow`, { action: "answer", id: question.id, answers: { q1: "My own approach" } })).status, 200);
    assert.equal((await api("POST", `${path}/workflow`, { action: "answer", id: question.id, answers: { q1: "duplicate" } })).status, 409);
    for (let i = 0; i < 100 && agent.current; i++) await sleep(30);
    assert.equal((await api("GET", `${path}/transcript`)).data.transcript.find((e) => e.kind === "clarification").text, "Which approach?\nMy own approach");
    assert.match(agent.lastText, /My own approach/);
    await api("POST", `${path}/messages`, { text });
    for (let i = 0; i < 100 && !agent.workflow.pending; i++) await sleep(30);
    const old = agent.workflow.pending.view.id;
    await api("POST", `${path}/stop`);
    for (let i = 0; i < 100 && agent.current; i++) await sleep(30);
    assert.equal(agent.workflow.pending, null);
    assert.equal((await api("POST", `${path}/workflow`, { action: "answer", id: old, answers: { q1: "late" } })).status, 409);
    assert.equal((await api("POST", `${path}/workflow`, { action: "publish", content: "not allowed" })).status, 409);
  } finally { await api("DELETE", `/v1/canvases/${c.id}`); }
});

test("core access transitions reset context atomically and read-only panels cannot bypass the mode", async () => {
  const c = (await api("POST", "/v1/canvases", {})).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-delegate", cwd: repo, chatMode: "ask", autoApprove: true })).data;
  const path = `/v1/canvases/${c.id}/agents/${a.id}`;
  const agent = getCanvas(c.id).agents.get(a.id);
  try {
    const marker = join(repo, "ask-mode-must-not-write.txt");
    const spec = { sources: { cmd: { brick: "command", run: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`] } }, views: [{ brick: "log", source: "cmd" }] };
    for (const mode of ["ask", "plan"]) {
      await api("PATCH", path, { chatMode: mode });
      const result = await api("POST", `${path}/messages`, { text: `CALL ${JSON.stringify({ tool: "panel_open", args: { spec } })}`, wait: true });
      assert.match(result.data.text, /read-only/);
      assert.equal(existsSync(marker), false);
    }
    agent.session = "old-plan-session";
    assert.equal((await api("PATCH", path, { sandbox: "workspace-write" })).status, 200);
    assert.equal(agent.chatMode, "agent");
    assert.equal(agent.session, null);
    assert.equal(agent.seedHistory, false);
    const { Panel } = await import("../src/panels/panel.mjs");
    agent.panel = new Panel(agent);
    agent.panel.setSpec({ sources: { cmd: { brick: "command", run: [process.execPath, "-e", "process.stdout.write('ok')"], every_s: 30 } }, views: [{ brick: "log", source: "cmd" }] });
    assert.equal(agent.panel.runners.size, 1);
    agent.session = "old-agent-session";
    await api("PATCH", path, { sandbox: "read-only" });
    assert.equal(agent.chatMode, "ask");
    assert.equal(agent.session, null);
    assert.equal(agent.panel.runners.size, 0, "existing command panels stop when entering Ask");
    assert.match(agent.panel.state.get("cmd").error, /Ask\/Plan/);
    assert.equal(agent.panel.state.get("cmd").data, null, "stale command output is not shown as live");
    const tools = await fetch(`${base}/mcp/${agent.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }).then((r) => r.json());
    const names = tools.result.tools.map((t) => t.name);
    for (const name of ["propose_plan", "update_todos", "save_tool", "add_tool", "update_context"]) assert.ok(!names.includes(name));
    await api("PATCH", path, { model: "fake-slow" });
    await api("POST", `${path}/messages`, { text: "active" });
    assert.equal((await api("PATCH", path, { sandbox: "workspace-write", name: "must not change" })).status, 409);
    assert.equal(agent.chatMode, "ask");
    assert.equal(agent.name, a.name);
  } finally { await api("DELETE", `/v1/canvases/${c.id}`); }
});

test("live tasks are validated, merged, archived and never automatically marked complete", async () => {
  const c = (await api("POST", "/v1/canvases", {})).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-delegate", chatMode: "agent" })).data;
  const path = `/v1/canvases/${c.id}/agents/${a.id}`;
  const agent = getCanvas(c.id).agents.get(a.id);
  const todos = [{ id: "one", content: "Investigate", status: "in_progress" }, { id: "two", content: "Validate", status: "pending" }];
  const call = (tool, args) => `CALL ${JSON.stringify({ tool, args })}`;
  const rpc = async (args) => fetch(`${base}/mcp/${agent.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "update_todos", arguments: args } }) }).then((r) => r.json());
  try {
    const text = [call("update_todos", { todos }), call("ask_user", { questions: [{ title: "Continue?" }] }), call("update_todos", { merge: true, todos: [{ ...todos[0], status: "completed" }] })].join("\n");
    await api("POST", `${path}/messages`, { text });
    for (let i = 0; i < 100 && !agent.workflow.pending; i++) await sleep(30);
    assert.deepEqual((await api("GET", `${path}/tasks`)).data.tasks, todos);
    assert.equal((await rpc({ todos: [{ ...todos[0] }, { ...todos[1], status: "in_progress" }] })).result.isError, true);
    assert.equal((await rpc({ todos: [todos[0], todos[0]] })).result.isError, true);
    assert.deepEqual(agent.tasks.items, todos, "invalid updates are atomic");
    assert.ok(getCanvas(c.id).bus.buffer.some((e) => e.type === "chat_tasks" && e.data.tasks.length === 2));
    await api("POST", `${path}/workflow`, { action: "answer", id: agent.workflow.pending.view.id, answers: { q1: "Yes" } });
    for (let i = 0; i < 100 && agent.current; i++) await sleep(30);
    const entries = (await api("GET", `${path}/transcript`)).data.transcript;
    assert.deepEqual(entries.at(-1).tasks.map((t) => t.status), ["completed", "pending"]);
    assert.deepEqual((await api("GET", `${path}/tasks`)).data.tasks, []);
    await api("POST", `${path}/messages`, { text: [call("update_todos", { todos }), call("ask_user", { questions: [{ title: "Wait?" }] })].join("\n") });
    for (let i = 0; i < 100 && !agent.workflow.pending; i++) await sleep(30);
    await api("POST", `${path}/stop`);
    for (let i = 0; i < 100 && agent.current; i++) await sleep(30);
    const stopped = (await api("GET", `${path}/transcript`)).data.transcript.at(-1);
    assert.deepEqual(stopped.tasks.map((t) => t.status), ["cancelled", "pending"]);
    await api("PATCH", path, { chatMode: "ask" });
    const denied = await api("POST", `${path}/messages`, { text: call("update_todos", { todos }), wait: true });
    assert.match(denied.data.text, /Agent mode/);
    assert.deepEqual(agent.tasks.items, []);
  } finally { await api("DELETE", `/v1/canvases/${c.id}`); }
});

test("native CLI tasks stream, survive split UTF-8 and final JSON without a newline, and obey Ask mode", async () => {
  const c = (await api("POST", "/v1/canvases", {})).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-native-tasks", chatMode: "agent" })).data;
  const path = `/v1/canvases/${c.id}/agents/${a.id}`;
  try {
    for (const backend of ["codex", "claude", "opencode", "gemini", "copilot", "local"]) {
      const canvas = getCanvas(c.id);
      const before = canvas.bus.buffer.length;
      assert.equal((await api("POST", `${path}/messages`, { text: backend, wait: true })).status, 200);
      const entry = (await api("GET", `${path}/transcript`)).data.transcript.at(-1);
      assert.deepEqual(entry.tasks.map((t) => t.status), ["completed", "pending"]);
      assert.equal(entry.tasks[0].content, "Kaynakları araştır");
      assert.equal(entry.tasks[1].content, "Testleri çalıştır");
      if (!["codex", "claude"].includes(backend)) assert.ok(entry.activities.some((a) => a.status === "error"), "failed tools remain visible");
      const events = canvas.bus.buffer.slice(before).filter((e) => e.type === "chat_tasks" && e.data.tasks.length);
      assert.ok(events.some((e) => e.data.tasks[0].status === (backend === "codex" ? "pending" : "in_progress")));
      assert.deepEqual((await api("GET", `${path}/tasks`)).data.tasks, []);
    }
    await api("PATCH", path, { chatMode: "ask" });
    await api("POST", `${path}/messages`, { text: "codex", wait: true });
    assert.deepEqual((await api("GET", `${path}/transcript`)).data.transcript.at(-1).tasks, []);
  } finally { await api("DELETE", `/v1/canvases/${c.id}`); }
});

test('turn review reverses individual hunks and files, persists decisions, and protects later edits and the index', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'taksim-review-test-'));
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  g('init', '-q');
  const old = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
  writeFileSync(join(dir, 'a.txt'), old); writeFileSync(join(dir, 'deleted.txt'), 'restore me\n'); writeFileSync(join(dir, 'binary.dat'), Buffer.from([0, 1, 2])); g('add', '.'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  writeFileSync(join(dir, 'staged.txt'), 'user index'); g('add', 'staged.txt');
  const index = g('diff', '--cached');
  const c = (await api('POST', '/v1/canvases', {})).data;
  const a = (await api('POST', `/v1/canvases/${c.id}/agents`, { model: 'fake-echo', cwd: dir })).data;
  const agent = getCanvas(c.id).agents.get(a.id), path = `/v1/canvases/${c.id}/agents/${a.id}/review`;
  try {
    const from = await snapshot(dir);
    const updated = old.replace('line 0\n', 'başlangıç\n').replace('line 39\n', 'bitiş\n');
    writeFileSync(join(dir, 'a.txt'), updated); writeFileSync(join(dir, 'new.txt'), 'new\n'); rmSync(join(dir, 'deleted.txt')); writeFileSync(join(dir, 'binary.dat'), Buffer.from([0, 3, 4]));
    const to = await snapshot(dir);
    agent.record({ from: a.id, to: 'user', kind: 'assistant', checkpoint: from, after: to, changes: await changes(dir, from, to), text: 'done' });
    const get = (file = 'a.txt') => api('GET', `${path}?from=${from}&to=${to}&path=${encodeURIComponent(file)}`);
    const change = (action, hunk, file = 'a.txt') => api('POST', path, { from, to, path: file, action, ...(hunk ? { hunk } : {}) });
    const review = (await get()).data;
    assert.equal(review.hunks.length, 2);
    assert.equal((await change('revert', review.hunks[0].id)).status, 200);
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), updated.replace('başlangıç\n', 'line 0\n'));
    assert.equal((await change('revert', review.hunks[1].id)).status, 200);
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), old);
    assert.equal((await change('keep')).data.status, 'partial', 'keeping remaining work preserves reversed blocks');
    assert.equal((await change('redo', review.hunks[0].id)).status, 200);
    assert.equal((await change('keep', review.hunks[0].id)).data.hunks[0].status, 'kept');
    assert.equal((await change('revert')).status, 200);
    assert.equal((await change('redo')).status, 200);
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), updated);
    assert.equal((await change('revert', null, 'new.txt')).status, 200); assert.equal(existsSync(join(dir, 'new.txt')), false);
    assert.equal((await change('redo', null, 'new.txt')).status, 200); assert.equal(readFileSync(join(dir, 'new.txt'), 'utf8'), 'new\n');
    assert.equal((await change('revert', null, 'deleted.txt')).status, 200); assert.equal(readFileSync(join(dir, 'deleted.txt'), 'utf8'), 'restore me\n');
    assert.equal((await change('redo', null, 'deleted.txt')).status, 200); assert.equal(existsSync(join(dir, 'deleted.txt')), false);
    assert.equal((await get('binary.dat')).data.binary, true);
    const binaryResult = await change('revert', null, 'binary.dat'); assert.equal(binaryResult.status, 200, JSON.stringify(binaryResult.data)); assert.deepEqual(readFileSync(join(dir, 'binary.dat')), Buffer.from([0, 1, 2]));
    assert.equal((await change('redo', null, 'binary.dat')).status, 200); assert.deepEqual(readFileSync(join(dir, 'binary.dat')), Buffer.from([0, 3, 4]));
    agent.current = {}; assert.equal((await change('keep')).status, 409); agent.current = null;
    writeFileSync(join(dir, 'a.txt'), updated + 'user edit\n');
    assert.equal((await change('revert')).status, 409);
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), updated + 'user edit\n');
    assert.equal(g('diff', '--cached'), index, 'review leaves staged work untouched');
    assert.ok(Object.keys(agent.chatReviews).length);
    getCanvas(c.id).flush();
    const saved = JSON.parse(readFileSync(join(home, 'canvases', c.id, 'canvas.json'), 'utf8'));
    assert.deepEqual(saved.agents.find((v) => v.id === a.id).chatReviews, agent.chatReviews);
    assert.equal((await api('GET', `${path}?from=${from}&to=${to}`)).data.files.find((v) => v.path === 'a.txt').status, 'kept');
    assert.equal((await get('../escape')).status, 404);
    assert.equal((await change('revert', 'unknown')).status, 409);
  } finally { await api('DELETE', `/v1/canvases/${c.id}`); rmSync(dir, { recursive: true, force: true }); }
});
