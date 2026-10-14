// Orchestrated work: the engine, not the model, keeps the rules (approval first, writers in order, one
// join, the person decides on a failure, stop reaches the parts). Driven by the fake models.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const home = mkdtempSync(join(tmpdir(), "taksim-home-"));
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_FAKE = "1";
process.env.TAKSIM_QUIET = "1";
process.env.TAKSIM_OPENCODE_BIN = "/nonexistent/opencode";

const { startServer } = await import("../src/server.mjs");
const { getCanvas } = await import("../src/canvas/canvas.mjs");

let server, base;
before(async () => {
  server = await startServer({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(home, { recursive: true, force: true }); });

async function api(method, path, body) {
  const r = await fetch(base + path, { method, headers: method === "GET" ? {} : { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
async function until(fn, timeout = 6000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(40);
  }
}
const call = (tool, args) => `CALL ${JSON.stringify({ tool, args })}`;

// an orchestrator on a fresh canvas, and the ways to drive it
async function setup({ delegate = true } = {}) {
  const c = (await api("POST", "/v1/canvases", {})).data;
  const lead = (await api("POST", `/v1/canvases/${c.id}/agents`, { name: "lead", model: "fake-delegate", chat: true, delegate })).data;
  const path = `/v1/canvases/${c.id}/agents/${lead.id}`;
  // plan_work returns at once: the turn that called it ends, the job goes on outside it
  const plan = async (parts, title = "Login refactor", more = {}) => (await api("POST", `${path}/messages`, { text: call("plan_work", { title, parts, ...more }), wait: true })).data.text;
  const question = (match = /./) => until(async () => { const q = (await api("GET", `${path}/workflow`)).data.question; return q && match.test(q.questions[0].title) ? q : null; });
  const answer = async (text, match) => { const q = await question(match); return api("POST", `${path}/workflow`, { action: "answer", id: q.id, answers: { q1: text } }); };
  const job = async () => (await api("GET", `${path}/job`)).data.job;
  const ended = () => until(async () => { const j = await job(); return j && !["proposed", "running"].includes(j.status) ? j : null; }, 10000);
  // what the orchestrator was told when the job ended, and what it then said
  const told = () => until(async () => {
    const t = (await api("GET", `${path}/transcript`)).data.transcript, i = t.findLastIndex((e) => e.kind === "job");
    return i >= 0 && t[i + 1]?.from === lead.id ? { message: t[i].text, reply: t[i + 1].text } : null;
  });
  const agents = () => [...getCanvas(c.id).agents.values()];
  return { c, lead, path, plan, question, answer, job, ended, told, agents, done: () => api("DELETE", `/v1/canvases/${c.id}`) };
}

test("plan_work returns at once; nothing starts before the person says so; then each part gets what it builds on and one message comes back", async () => {
  const t = await setup();
  const said = await t.plan([
    { id: "research", title: "Araştır", task: "find every caller of check_session", model: "fake-echo" },
    { id: "impl", title: "Uygula", task: "move the check", depends_on: ["research"], writes: true, model: "fake-wait", done_when: "the helper exists" },
  ]);
  assert.match(said, /Proposed to the user: "Login refactor", 2 parts\. Nothing has started[\s\S]*End your turn/);
  assert.equal((await api("GET", t.path)).data.status, "waiting", "the orchestrator's turn is over; the person is being asked");
  const q = await t.question();
  assert.equal(q.questions[0].title, "Start this work? Login refactor (2 parts)");
  assert.deepEqual(q.questions[0].options, ["Start", "Cancel"]);
  assert.equal((await t.job()).status, "proposed");
  assert.equal(t.agents().length, 1, "no agent exists before the answer");
  await t.answer("Start");
  const job = await t.ended();
  assert.equal(job.status, "done");
  const [research, impl] = job.parts;
  assert.deepEqual([research.status, impl.status], ["done", "done"]);
  assert.ok(impl.startedAt >= research.endedAt, "after what it depends on");
  // the agents: named for their part, reading unless the part writes, made by the orchestrator, not overlapping
  const made = t.agents().filter((a) => a.id !== t.lead.id);
  assert.deepEqual(made.map((a) => [a.name, a.model, a.sandbox === "read-only", a.jobRole]), [["Araştır", "fake-echo", true, "reader"], ["Uygula", "fake-wait", false, "writer"]]);
  assert.ok(made.every((a) => a.createdBy === t.lead.id && !a.delegate), "parts don't orchestrate on their own");
  const rects = t.agents().map((a) => getCanvas(t.c.id).rectOf(a));
  for (const [i, r] of rects.entries()) for (const o of rects.slice(i + 1)) assert.ok(r[0] + r[2] <= o[0] || o[0] + o[2] <= r[0] || r[1] + r[3] <= o[1] || o[1] + o[3] <= r[1], "nodes don't overlap");
  // the writer was given what the research found; its task stands alone and carries no tool suggestions
  const got = JSON.parse(impl.answer).prompt;
  assert.match(got, /move the check[\s\S]*Result of the earlier part "Araştır" \(Araştır\):\necho: [\s\S]*find every caller of check_session[\s\S]*It is done when: the helper exists[\s\S]*the checks you ran/);
  assert.doesNotMatch(got, /saved tools that look relevant/);
  // one message back, from the engine; nothing proved the work (no checks, no git folder to diff), and it is told so
  const { message, reply } = await t.told();
  assert.match(message, /^The work "Login refactor" you handed out with plan_work has ended\./);
  assert.match(message, /"status": "done"[\s\S]*nothing checked it[\s\S]*their word, not proof/);
  assert.match(reply, /the engine, not the user, about work you handed out/, "the orchestrator sees who is speaking");
  await t.done();
});

test("done is checked, not said: the engine runs the checks and a reviewer reads the diff alone", async () => {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const repo = mkdtempSync(join(tmpdir(), "taksim-job-"));
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
  git("init", "-q"); writeFileSync(join(repo, "a.txt"), "one\ntwo\n"); git("add", "-A"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const t = await setup();
  await api("PATCH", t.path, { cwd: repo });
  await t.plan([{ id: "impl", title: "Uygula", task: "uppercase two", writes: true, model: "fake-wait" }], "Rename", { request: "make two uppercase", checks: ["grep -q TWO a.txt", "grep -q NOPE a.txt"] });
  const q = await t.question();
  assert.equal(q.questions[0].title, "Start this work? Rename (1 part)\nThen runs: grep -q TWO a.txt ; grep -q NOPE a.txt", "the person sees what will run");
  await t.answer("Start");
  // the writer's turn changes the file
  const writer = await until(() => t.agents().find((a) => a.name === "Uygula" && a.status === "running"));
  await sleep(150); // past the snapshot its turn starts with
  writeFileSync(join(repo, "a.txt"), "one\nTWO\n");
  const job = await t.ended();
  assert.deepEqual(job.parts[0].changed, ["a.txt"], "what the engine saw change");
  assert.deepEqual(job.checks.map((c) => [c.command, c.status, c.exit]), [["grep -q TWO a.txt", "passed", 0], ["grep -q NOPE a.txt", "failed", 1]]);
  assert.equal(job.status, "partial", "a failed check is not done");
  // the reviewer: read-only, knows only the request and the diff
  const reviewer = t.agents().find((a) => a.id === job.review.agentId);
  assert.equal(reviewer.sandbox, "read-only");
  assert.deepEqual([writer.jobRole, reviewer.jobRole], ["writer", "reviewer"]);
  const { readTranscript } = await import("../src/canvas/store.mjs");
  const asked = readTranscript(t.c.id, reviewer.id, 5).find((e) => e.to === reviewer.id).text;
  assert.match(asked, /You know nothing of how it was made[\s\S]*What was asked for: make two uppercase[\s\S]*```diff[\s\S]*-two\n\+TWO[\s\S]*VERDICT: OK or VERDICT: PROBLEMS/);
  assert.doesNotMatch(asked, /conversation_history/);
  assert.equal(job.review.status, "problems", "no VERDICT: OK means it isn't one");
  assert.equal(job.review.model, "fake-delegate");
  const { message } = await t.told();
  assert.match(message, /Checks failed: grep -q NOPE a\.txt\. The work is not done until they pass[\s\S]*The reviewer found problems/);
  await t.done();
  rmSync(repo, { recursive: true, force: true });
});

test("cancelled or answered otherwise: no agents, and the orchestrator is told not to go around it", async () => {
  const t = await setup();
  const parts = [{ title: "A", task: "do a", model: "fake-echo" }, { title: "B", task: "do b", model: "fake-echo" }];
  await t.plan(parts);
  await t.answer("Cancel");
  assert.match((await t.told()).message, /The user cancelled the work "Login refactor" you proposed\. Do not start it another way/);
  assert.equal((await t.job()).status, "declined");
  await until(async () => (await api("GET", t.path)).data.status === "idle");
  await t.plan(parts, "Second");
  await t.answer("önce yalnızca A'yı yap");
  assert.match((await until(async () => { const x = await t.told(); return /Second/.test(x.message) ? x : null; })).message, /did not start the work "Second" and answered: "önce yalnızca A'yı yap"/);
  assert.equal(t.agents().length, 1);
  await t.done();
});

test("a failed part stops new starts and goes to the person: retry, skip with what depends on it, or stop", async () => {
  const t = await setup();
  const parts = [
    { id: "a", title: "A", task: "a", model: "fake-error", writes: true },
    { id: "b", title: "B", task: "b", depends_on: ["a"], model: "fake-echo" },
    { id: "c", title: "C", task: "c", model: "fake-echo" },
  ];
  await t.plan(parts);
  await t.answer("Start", /Start this work/);
  let q = await t.question(/A part failed/);
  assert.match(q.questions[0].title, /A part failed: A \(fake-error\)\n.*fake failure/);
  assert.deepEqual(q.questions[0].options, ["Retry", "Skip", "Stop"]);
  assert.equal((await t.job()).parts[1].status, "pending", "what depends on it has not started");
  await t.answer("Retry", /A part failed/);
  q = await until(async () => { const x = (await api("GET", `${t.path}/workflow`)).data.question; return x && x.id !== q.id ? x : null; });
  assert.equal(t.agents().filter((a) => a.name === "A").length, 1, "the retry went to the same agent");
  // the person removes that agent before retrying again: the retry makes a new one instead of failing on a ghost
  getCanvas(t.c.id).removeAgent(t.agents().find((a) => a.name === "A"));
  await t.answer("Retry", /A part failed/);
  q = await until(async () => { const x = (await api("GET", `${t.path}/workflow`)).data.question; return x && x.id !== q.id ? x : null; });
  assert.match(q.questions[0].title, /fake failure/, "it ran again, on a new agent");
  assert.equal(t.agents().filter((a) => a.name === "A").length, 1);
  await t.answer("Skip", /A part failed/);
  const job = await t.ended();
  assert.deepEqual(job.parts.map((p) => p.status), ["skipped", "skipped", "done"]);
  assert.equal(job.status, "partial");
  assert.match((await t.told()).message, /Not done: a \(skipped\), b \(skipped\)\. Do not present the work as finished/);

  await until(async () => (await api("GET", t.path)).data.status === "idle");
  await t.plan(parts.slice(0, 2), "again");
  await t.answer("Start", /Start this work/);
  await t.answer("Stop", /A part failed/);
  assert.deepEqual((await t.ended()).parts.map((p) => p.status), ["failed", "cancelled"]);
  // "Stop" is a stop: the orchestrator is told to report, and its turn can't change files (a real model went on and did the work itself)
  const told = await until(async () => { const x = await t.told(); return /again/.test(x.message) ? x : null; });
  assert.match(told.message, /The user stopped this work when a part failed\. Stop too: for this message you cannot change files/);
  const lead = getCanvas(t.c.id).agents.get(t.lead.id);
  const { readTranscript } = await import("../src/canvas/store.mjs");
  assert.equal(readTranscript(t.c.id, lead.id, 3).at(-1).checkpoint, undefined, "a turn that can't write takes no checkpoint");
  await t.done();
});

test("what is wrong with the parts is said at once, before anyone is asked or made", async () => {
  const t = await setup();
  const bad = (parts) => t.plan(parts);
  assert.match(await bad([{ title: "A", task: "a", model: "gpt-nope" }]), /model "gpt-nope" can't be run on this computer now \(not installed, or its CLI isn't signed in\); choose from list_agents/);
  assert.match(await bad([{ id: "a", title: "A", task: "a", depends_on: ["b"] }, { id: "b", title: "B", task: "b", depends_on: ["a"] }]), /wait on each other in a circle: a, b/);
  assert.match(await bad([{ id: "a", title: "A", task: "" }, { id: "a", title: "A2", task: "x", depends_on: ["zz"] }]), /a: task is empty[\s\S]*"a" is used twice[\s\S]*depends on "zz", which isn't a part/);
  assert.match(await bad(Array.from({ length: 5 }, (_, i) => ({ title: `P${i}`, task: "x" }))), /too many parts \(5\); at most 4/);
  assert.match(await bad([{ id: "x", title: "X", task: "x", writes: true }, { id: "y", title: "Y", task: "y", writes: true }]), /one writer: x, y all write\. Put the changes in one part/);
  assert.match(await bad([{ title: "A", task: "a", agent: "nobody" }]), /no agent "nobody" on this canvas/);
  assert.equal(t.agents().length, 1);
  assert.equal((await api("GET", `${t.path}/workflow`)).data.question, null);
  assert.equal(await t.job(), null);
  await t.done();
});

test("a light model leading is said where the person decides; the reviewer stays on the orchestrator's own CLI", async () => {
  const t = await setup();
  const agent = getCanvas(t.c.id).agents.get(t.lead.id);
  const models = [{ id: "haiku", cli: "claude", tier: "light" }, { id: "sonnet", cli: "claude", tier: "standard" }, { id: "opus", cli: "claude", tier: "strong" }, { id: "gpt-6-astra", cli: "codex", tier: "strong" }];
  const parts = [{ title: "A", task: "a", model: "sonnet" }];
  agent.model = "haiku";
  let job = agent.orchestration.check({ parts }, models);
  assert.equal(job.warning, "light-lead");
  assert.equal(job.reviewer, "opus", "its own CLI's strong model");
  agent.model = "opus";
  job = agent.orchestration.check({ parts }, models);
  assert.equal(job.warning, undefined);
  assert.equal(job.reviewer, "opus");
  // no strong model on its own CLI: it reviews on its own model rather than reach for another login
  agent.model = "fake-delegate";
  assert.equal(agent.orchestration.check({ parts: [{ title: "A", task: "a" }] }, [...models, { id: "fake-delegate", cli: "fake", tier: "standard" }]).reviewer, "fake-delegate");
  await t.done();
});

test("stopping the orchestrator stops the work it handed out, though its own turn ended long ago", async () => {
  const t = await setup();
  await t.plan([{ id: "slow", title: "Yavaş", task: "hang", model: "fake-slow", writes: true }, { id: "next", title: "Sonra", task: "x", depends_on: ["slow"], model: "fake-echo" }]);
  await t.answer("Start");
  const part = await until(() => t.agents().find((a) => a.name === "Yavaş" && a.status === "running"));
  assert.equal((await api("GET", t.path)).data.status, "idle", "the orchestrator is free while its parts work");
  // a second job can't be handed out on top of the first
  assert.match(await t.plan([{ title: "X", task: "x" }]), /a job you handed out is still under way/);
  assert.equal((await api("POST", `${t.path}/stop`)).status, 200);
  const job = await t.ended();
  await until(() => part.status !== "running");
  assert.equal(job.status, "stopped");
  assert.deepEqual(job.parts.map((p) => p.status), ["stopped", "cancelled"]);
  assert.equal(t.agents().some((a) => a.name === "Sonra"), false);
  await sleep(200);
  assert.equal((await api("GET", `${t.path}/transcript`)).data.transcript.some((e) => e.kind === "job"), false, "stopped by the person: nothing wakes the orchestrator");
  await t.done();
});

test("it shows who works with whom: the orchestrator with its parts, and an agent kept waiting by another that is writing", async () => {
  const { mkdtempSync: mk } = await import("node:fs");
  const folder = mk(join(tmpdir(), "taksim-lock-"));
  const t = await setup();
  await api("PATCH", t.path, { cwd: folder });
  await t.plan([{ id: "slow", title: "Yazan", task: "hang", model: "fake-slow", writes: true }]);
  await t.answer("Start");
  const writer = await until(() => t.agents().find((a) => a.name === "Yazan" && a.status === "running"));
  // the orchestrator is not in a turn, yet its node says it is working with that agent
  assert.deepEqual((await api("GET", t.path)).data.workingWith, [writer.id]);
  // another agent of the person's, asked to write in the same folder, has to wait for the writer: it says for whom
  const other = (await api("POST", `/v1/canvases/${t.c.id}/agents`, { name: "öbür", model: "fake-echo", chat: true, cwd: folder })).data;
  const otherPath = `/v1/canvases/${t.c.id}/agents/${other.id}`;
  const turn = api("POST", `${otherPath}/messages`, { text: "bir şey yaz", wait: true });
  const blocked = await until(async () => { const v = (await api("GET", otherPath)).data; return v.blockedBy.length ? v : null; });
  assert.deepEqual(blocked.blockedBy, [writer.id]);
  assert.equal(blocked.status, "running");
  // the writer ends: the wait is over and nothing says otherwise
  await api("POST", `${t.path}/stop`);
  assert.match((await turn).data.text, /echo: bir şey yaz/);
  const after = (await api("GET", otherPath)).data;
  assert.deepEqual([after.blockedBy, after.status], [[], "idle"]);
  assert.deepEqual((await api("GET", t.path)).data.workingWith, []);
  await t.done();
  rmSync(folder, { recursive: true, force: true });
});

test("a job that was stopped, or cut off by a restart, goes on where it left off when the person resumes it", async () => {
  const t = await setup();
  await t.plan([{ id: "a", title: "Bir", task: "a", model: "fake-echo" }, { id: "b", title: "İki", task: "hang", depends_on: ["a"], model: "fake-slow" },
    { id: "c", title: "Üç", task: "c", depends_on: ["b"], model: "fake-echo" }]);
  await t.answer("Start");
  const slow = await until(() => t.agents().find((a) => a.name === "İki" && a.status === "running"));
  await api("POST", `${t.path}/stop`);
  let job = await t.ended();
  assert.deepEqual(job.parts.map((p) => p.status), ["done", "stopped", "cancelled"]);
  assert.equal((await api("GET", `${t.path}/job`)).data.resumable, true);
  const firstRun = job.parts[0].endedAt;
  // what kept it from finishing is fixed (here: a model that answers), then: resume
  await until(() => slow.status !== "running");
  await api("PATCH", `/v1/canvases/${t.c.id}/agents/${slow.id}`, { model: "fake-echo" });
  assert.equal((await api("POST", `${t.path}/job`, { action: "resume" })).status, 200);
  assert.equal((await api("GET", `${t.path}/workflow`)).data.question, null, "their press was the go-ahead: nothing is asked again");
  job = await until(async () => { const j = await t.job(); return j.status === "done" ? j : null; });
  assert.deepEqual(job.parts.map((p) => p.status), ["done", "done", "done"]);
  assert.equal(job.parts[0].endedAt, firstRun, "what was done was not done again");
  assert.equal(t.agents().filter((a) => a.name === "İki").length, 1, "the same agent went on");
  assert.match((await t.told()).message, /"status": "done"/);
  assert.equal((await api("POST", `${t.path}/job`, { action: "resume" })).status, 409, "nothing is left to resume");
  // a restart mid-job: the engine comes back with the job marked as cut off, and it can be resumed the same way
  const agent = getCanvas(t.c.id).agents.get(t.lead.id);
  agent.job.status = "running"; agent.job.parts[2].status = "running";
  const { Orchestration } = await import("../src/canvas/orchestration.mjs");
  agent.orchestration = new Orchestration(agent);
  assert.deepEqual([agent.job.status, agent.job.parts[2].status, agent.job.parts[2].error, agent.orchestration.resumable], ["stopped", "failed", "interrupted", true]);
  await api("POST", `${t.path}/job`, { action: "resume" });
  assert.equal((await until(async () => { const j = await t.job(); return j.status === "done" ? j : null; })).parts[2].status, "done");
  await t.done();
});

test("the approval can wait as long as the person likes, and the next job clears the last one's agents", async () => {
  const t = await setup();
  const parts = [{ title: "A", task: "a", model: "fake-echo" }, { title: "B", task: "b", model: "fake-echo" }];
  await t.plan(parts, "First");
  await t.question();
  // the person talks to the orchestrator before answering: its turn runs, the question keeps its place
  const side = await api("POST", `${t.path}/messages`, { text: "ne durumdayız", wait: true });
  assert.match(side.data.text, /the work you handed out is still under way\. For this message you can read and answer, not change files[\s\S]*ne durumdayız/);
  assert.equal((await t.question()).questions[0].title, "Start this work? First (2 parts)");
  await t.answer("Start");
  assert.equal((await t.ended()).status, "done");
  const first = t.agents().filter((a) => a.id !== t.lead.id).map((a) => a.id);
  assert.equal(first.length, 2);
  await t.told();
  await until(async () => (await api("GET", t.path)).data.status === "idle");
  // the canvas would fill up after a few jobs otherwise (12 agents)
  for (const title of ["Second", "Third", "Fourth", "Fifth", "Sixth"]) {
    await until(async () => { const a = (await api("GET", t.path)).data; return a.status === "idle" && a.queued === 0; });
    assert.match(await t.plan(parts, title), /Proposed to the user/, title);
    await t.answer("Start", new RegExp(title));
    await until(async () => { const j = await t.job(); return j.title === title && j.status === "done"; });
  }
  assert.equal(t.agents().length, 3, "only the last job's agents remain");
  assert.equal(t.agents().some((a) => first.includes(a.id)), false);
  await t.done();
});

test("Create agents off: no orchestrating on its own, but the work is split when the person asks for it", async () => {
  const t = await setup({ delegate: false });
  const parts = [{ title: "A", task: "a", model: "fake-echo" }, { title: "B", task: "b", model: "fake-echo" }];
  assert.match(await t.plan(parts), /Create agents is off for you and the user didn't ask you to split this work across agents/);
  assert.equal(t.agents().length, 1);
  const { splits } = await import("../src/toolbox/mcp.mjs");
  assert.deepEqual(["bu işi ajanlara böl", "split this across three agents", "işi yardımcı ajanlara dağıt", "run the parts in parallel with agents",
    "split this function in two", "ajan oluştur", "dosyayı ikiye böl"].map(splits), [true, true, true, true, false, false, false]);
  // their own words are the permission, whatever the switch says
  const agent = getCanvas(t.c.id).agents.get(t.lead.id);
  await api("POST", `${t.path}/messages`, { text: `bu işi iki ajana böl\n${call("plan_work", { title: "İki parça", parts })}`, wait: true });
  await t.answer("Start");
  assert.equal((await t.ended()).status, "done");
  assert.deepEqual(t.agents().filter((a) => a.id !== t.lead.id).map((a) => a.jobRole), ["reader", "reader"]);
  assert.match(agent.systemPrompt(), /When the user explicitly asks you to split the work across agents, do it with plan_work/);
  await t.done();
});

test("the evaluation runner: one task, both ways, judged by the task's own checks", async () => {
  const { runTask, summarize } = await import("../eval/run.mjs");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const repo = mkdtempSync(join(tmpdir(), "taksim-evalrepo-"));
  writeFileSync(join(repo, "a.txt"), "one\n");
  const task = { id: "t1", repo, prompt: "say hi", checks: ["test -f a.txt", "grep -q one a.txt"] };
  const results = [await runTask(base, task, { model: "fake-echo", mode: "single" }), await runTask(base, task, { model: "fake-echo", mode: "orchestrated" }),
    await runTask(base, { ...task, checks: ["grep -q NOPE a.txt"] }, { model: "fake-echo", mode: "single" })];
  assert.deepEqual(results.map((r) => [r.mode, r.passed, r.split, r.agents, r.error]), [["single", true, false, 1, null], ["orchestrated", true, false, 1, null], ["single", false, false, 1, null]]);
  assert.ok(results[0].tokens > 0 && results[0].checks.every((c) => c.passed));
  assert.deepEqual(summarize(results).map((r) => [r.mode, r.tasks, r.passed]), [["single", 2, 1], ["orchestrated", 1, 1]]);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "one\n", "the task's own repository is untouched");
  assert.equal((await api("GET", "/v1/canvases")).data.canvases.filter((c) => c.name.startsWith("eval ")).length, 0, "its canvases are gone");
  rmSync(repo, { recursive: true, force: true });
});
