// Orchestrated work: what an orchestrator hands out is a job the engine knows, not a plan kept in a model's
// head. The orchestrator states the parts once (plan_work) and its turn ends; the engine checks them, asks the
// person before anything starts, creates the agents, runs the parts, asks the person again when a part fails,
// proves the result, and wakes the orchestrator once with all of it. Stopping the orchestrator stops its parts.
//
// The job lives outside any turn on purpose. Every CLI gives up on a tool call after 15 minutes; real work, or
// a person who answers the approval after lunch, takes longer. A job tied to one tool call would be orphaned:
// the model told "timed out" while its agents kept changing files.
//
// Rules the engine keeps, whatever the model remembers:
//   - nothing starts before the person says so
//   - one writer: at most one part changes files; the others contribute by reading (research, analysis). Several
//     writers, even one after another, each decide things the others never see.
//   - a part starts only when the parts it depends on are done, and is given what they found
//   - a model is checked against what this computer can run before any agent is made
//   - a failed part stops new starts and is put to the person: retry, skip (with what depends on it), or stop
//   - "done" is checked, not said: the job's check commands are run by the engine, and a reviewer that knows nothing
//     of the conversation reads the change the engine saw (the diff), on a strong model
//   - the orchestrator hears back once, with every part's answer, the files that changed, the checks and the review
//   - the agents a job made are cleared away when the next job starts, so the canvas doesn't fill up with yesterday's

import { randomUUID } from "node:crypto";
import { shellSpawn, killTree } from "../platform.mjs";
import { httpError } from "../http.mjs";
import { T } from "../lang.mjs";
import { readOnly } from "./chat-modes.mjs";
import { readTranscript } from "./store.mjs";
import { fileDiff } from "./checkpoint.mjs";
import { tierOf } from "../backends/models.mjs";
import { splits } from "../toolbox/mcp.mjs";

// few parts: a job that needs more is usually one that shouldn't be split (or is several jobs)
export const MAX_PARTS = Number(process.env.TAKSIM_JOB_PARTS || 4);
const MAX_CHECKS = 3;
const JOB_TIMEOUT_MS = Number(process.env.TAKSIM_JOB_TIMEOUT_S || 3 * 3600) * 1000; // from the go-ahead, not from the proposal
const CHECK_TIMEOUT_MS = Number(process.env.TAKSIM_JOB_CHECK_TIMEOUT_S || 600) * 1000;
const ANSWER = 6000; // characters of a part's answer handed back to the orchestrator
const DIFF = 60000;  // characters of the change handed to the reviewer
const ACTIVE = ["proposed", "running"];

const str = (v, max) => String(v ?? "").trim().slice(0, max);

export class Orchestration {
  constructor(agent) {
    this.agent = agent;
    this.ac = null; // set while a job is under way
    // a job that was under way when the engine stopped didn't finish: say so instead of showing it as running
    const job = agent.job;
    if (job && ACTIVE.includes(job.status)) {
      for (const p of job.parts) if (["pending", "running"].includes(p.status)) { p.status = p.status === "running" ? "failed" : "cancelled"; p.error ||= "interrupted"; }
      for (const c of job.checks || []) if (c.status === "running") c.status = "stopped";
      if (job.review?.status === "running") job.review.status = "skipped";
      job.status = "stopped";
    }
  }

  get active() { return !!this.ac; }

  emit() {
    const a = this.agent;
    if (a.job) a.job.updatedAt = Date.now();
    a.canvas.bus.emit("chat_job", { id: a.id, job: a.job || null });
    // who it is working with right now is part of how its node looks
    const now = this.working().join();
    if (now !== this.shown) { this.shown = now; a.setStatus(a.status); }
    a.canvas.save();
  }

  /** the agents doing a part of its job at this moment */
  working() {
    const job = this.agent.job;
    if (!this.active || !job) return [];
    return [...job.parts.filter((p) => p.status === "running").map((p) => p.agentId), ...(job.review?.status === "running" ? [job.review.agentId] : [])].filter(Boolean);
  }

  /** what is left to do, if the job can be picked up again (it was stopped, interrupted, or ended with parts undone) */
  get resumable() {
    const job = this.agent.job;
    if (!job || this.active || ["proposed", "declined", "done"].includes(job.status)) return false;
    return true;
  }

  /** Go on where it stopped, as the person asks: what is done stays done, the rest runs again. Their press is the go-ahead. */
  resume() {
    const a = this.agent, job = a.job;
    if (this.active) throw httpError(409, "the job is already under way");
    if (!this.resumable) throw httpError(409, "there is nothing to resume");
    if (a.terminal) throw httpError(409, "close the terminal view first: the job asks its questions in the chat");
    for (const p of job.parts) if (p.status !== "done") { p.status = "pending"; p.error = null; p.asked = false; }
    for (const c of job.checks) if (c.status !== "passed") { c.status = "pending"; delete c.exit; delete c.output; }
    // a change that was already reviewed keeps its review only if nothing runs again
    if (job.parts.some((p) => p.status === "pending") || job.review?.status !== "ok") job.review = null;
    delete job.timedOut; delete job.note; delete job.halted;
    job.status = "running";
    this.ac = new AbortController();
    this.emit();
    this.drive(job, this.ac.signal, { approved: true }).catch(() => {}).finally(() => { this.ac = null; a.setStatus(a.status); });
    return job;
  }

  /** stop the job under way, with its parts (the orchestrator was stopped or removed) */
  cancel() { this.ac?.abort(); }

  /** the agents the last job made that are no longer doing anything: they make room for the next one */
  spent() {
    const a = this.agent, canvas = a.canvas;
    return (a.job?.made || []).map((id) => canvas.agents.get(id)).filter((x) => x && !x.current && !x.queue.length && !x.terminal && !x.panel?.spec);
  }

  /** the parts as the orchestrator stated them, checked; throws one error naming everything wrong */
  check(args, models) {
    const a = this.agent, canvas = a.canvas, wrong = [];
    const raw = Array.isArray(args?.parts) ? args.parts : [];
    if (!raw.length) throw httpError(400, "plan_work needs parts: at least one");
    if (raw.length > MAX_PARTS) throw httpError(400, `too many parts (${raw.length}); at most ${MAX_PARTS}. Merge the small ones.`);
    const known = new Set(models.map((m) => m.id));
    const parts = raw.map((p, i) => {
      const id = str(p.id, 40) || `p${i + 1}`;
      if (!/^[\w-]+$/.test(id)) wrong.push(`part ${i + 1}: id may only use letters, digits, - and _`);
      const part = { id, title: str(p.title, 80) || id, task: str(p.task, 20000), files: (Array.isArray(p.files) ? p.files : []).map((f) => str(f, 300)).filter(Boolean).slice(0, 40),
        depends_on: (Array.isArray(p.depends_on) ? p.depends_on : []).map((d) => str(d, 40)).filter(Boolean), writes: p.writes === true,
        model: str(p.model, 120) || null, effort: str(p.effort, 20) || null, done_when: str(p.done_when, 1000) || null,
        agent: str(p.agent, 80) || null, status: "pending", agentId: null, agentName: null, answer: null, changed: [], error: null };
      if (!part.task) wrong.push(`${id}: task is empty`);
      if (part.agent) {
        const t = canvas.find(part.agent);
        if (!t) wrong.push(`${id}: no agent "${part.agent}" on this canvas`);
        else if (t === a) wrong.push(`${id}: you can't give a part to yourself; do it when the results come back`);
        else if (part.writes && readOnly(t)) wrong.push(`${id}: "${t.name}" is read-only and this part writes`);
        else { part.agentId = t.id; part.agentName = t.name; part.model = t.model; part.given = true; }
      } else {
        if (!part.model) part.model = a.model;
        else if (!known.has(part.model)) wrong.push(`${id}: model "${part.model}" can't be run on this computer now (not installed, or its CLI isn't signed in); choose from list_agents' available_models (${[...known].slice(0, 15).join(", ")})`);
        part.cli = models.find((m) => m.id === part.model)?.cli || null;
      }
      return part;
    });
    const writers = parts.filter((p) => p.writes);
    if (writers.length > 1) wrong.push(`one writer: ${writers.map((p) => p.id).join(", ")} all write. Put the changes in one part (or make them yourself when the results come back) and let the other parts read: research, analysis, what to change and why`);
    const ids = parts.map((p) => p.id);
    for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) wrong.push(`part id "${id}" is used twice`);
    for (const p of parts) for (const d of p.depends_on) {
      if (d === p.id) wrong.push(`${p.id}: depends on itself`);
      else if (!ids.includes(d)) wrong.push(`${p.id}: depends on "${d}", which isn't a part`);
    }
    // a cycle would wait forever
    const done = new Set();
    for (let moved = true; moved;) {
      moved = false;
      for (const p of parts) if (!done.has(p.id) && p.depends_on.every((d) => done.has(d) || !ids.includes(d))) { done.add(p.id); moved = true; }
    }
    if (done.size < parts.length) wrong.push(`parts wait on each other in a circle: ${parts.filter((p) => !done.has(p.id)).map((p) => p.id).join(", ")}`);
    // room on the canvas: the parts, the reviewer when something is written, less what the last job leaves behind
    const fresh = parts.filter((p) => !p.agentId).length + (writers.length ? 1 : 0);
    const given = new Set(parts.map((p) => p.agentId).filter(Boolean));
    const room = canvas.limits.max_agents - canvas.agents.size + this.spent().filter((x) => !given.has(x.id)).length;
    if (fresh > room) wrong.push(`the canvas has room for ${Math.max(0, room)} more agents (limit ${canvas.limits.max_agents}) and this needs ${fresh}; reuse agents or merge parts`);
    if (fresh && a.depth + 1 > canvas.limits.max_depth) wrong.push(`agents at your depth can't create more (limit ${canvas.limits.max_depth}); do the work yourself`);
    const checks = (Array.isArray(args.checks) ? args.checks : []).map((c) => str(c, 300)).filter(Boolean);
    if (checks.length > MAX_CHECKS) wrong.push(`at most ${MAX_CHECKS} check commands`);
    if (wrong.length) throw httpError(400, `plan_work was not started:\n- ${wrong.join("\n- ")}`);
    // who reviews: the strong model of the orchestrator's own CLI, else its own model. Never another CLI's: that
    // login may not exist, and it would spend on an account the person didn't choose for this.
    const own = models.find((m) => m.id === a.model);
    const reviewer = tierOf(a.model || "") === "strong" ? a.model : models.find((m) => m.tier === "strong" && own && m.cli === own.cli)?.id || a.model;
    return { id: randomUUID(), title: str(args.title, 120) || "Work", status: "proposed", parts, checks: checks.map((command) => ({ command, status: "pending" })),
      review: null, reviewer, request: str(args.request, 4000) || null, made: [],
      // a light model plans and judges poorly: say so where the person decides
      ...(tierOf(a.model || "") === "light" ? { warning: "light-lead" } : {}), createdAt: Date.now(), updatedAt: Date.now() };
  }

  /** the plan_work tool: checks the parts, puts the job to the person and returns at once; the rest happens outside the turn */
  propose(args, models) {
    const a = this.agent;
    // the switch, or the person's own words: when they ask for the work to be split across agents, it is split
    const asked = [...(a.asks || []), a.lastAsk].some(splits);
    if (!a.delegate && !asked) throw httpError(409, "Create agents is off for you and the user didn't ask you to split this work across agents: do the work yourself. The user can ask for a split, or turn the switch on in your node's title.");
    if (readOnly(a)) throw httpError(409, "Orchestrating work needs Agent mode; Ask and Plan only investigate.");
    if (a.terminal) throw httpError(409, "plan_work needs the chat: the user is asked to start the work there. Tell them to close the terminal view of this node and ask again.");
    if (this.active) throw httpError(409, "a job you handed out is still under way; its results will arrive as a message. Wait for it.");
    const before = a.job;
    const job = this.check(args, models);
    job.leftover = (before?.made || []); // the last job's agents, cleared when this one is started
    a.job = job;
    this.ac = new AbortController();
    this.emit();
    this.drive(job, this.ac.signal).catch(() => {}).finally(() => { this.ac = null; a.setStatus(a.status); });
    return `Proposed to the user: "${job.title}", ${job.parts.length} part${job.parts.length === 1 ? "" : "s"}. Nothing has started; they are being asked now. `
      + "End your turn with one line saying the work is waiting for their go-ahead. Do not do the parts yourself and do not call plan_work again: "
      + "when every part has ended you get one message with all the results, the checks and the review.";
  }

  /** the job, from the question to the one message back */
  async drive(job, signal, { approved = false } = {}) {
    const a = this.agent, canvas = a.canvas, lang = canvas.lang;
    const say = (en, tr) => T(lang, en, tr);
    const live = new Map(); // part id -> promise of its end
    const stopParts = () => { for (const p of job.parts) if (p.status === "running") canvas.agents.get(p.agentId)?.stop(); if (job.review?.status === "running") canvas.agents.get(job.review.agentId)?.stop(); };
    signal.addEventListener("abort", stopParts, { once: true });
    let timer;
    try {
      // 1. nothing starts before the person says so. The parts are in the job's card; the question says what will
      // run on their machine and what to know.
      const start = say("Start", "Başlat"), cancel = say("Cancel", "Vazgeç");
      const lines = [`${say("Start this work?", "Bu iş başlasın mı?")} ${job.title} (${job.parts.length} ${say(job.parts.length === 1 ? "part" : "parts", "parça")})`,
        ...(job.checks.length ? [`${say("Then runs", "Sonra çalıştırır")}: ${job.checks.map((c) => c.command).join(" ; ")}`] : []),
        ...(job.warning ? [say("This agent runs on a light model; a stronger one plans and checks better.", "Bu ajan hafif bir modelde; daha güçlü bir model daha iyi planlar ve denetler.")] : [])];
      const reply = approved ? start : await this.ask(lines.join("\n"), [start, cancel], signal);
      if (reply !== start) {
        job.status = "declined"; for (const p of job.parts) p.status = "cancelled";
        this.emit();
        return this.tell(reply === cancel ? `The user cancelled the work "${job.title}" you proposed. Do not start it another way; ask what they want instead.`
          : `The user did not start the work "${job.title}" and answered: "${reply}". Change the parts accordingly and call plan_work again, or do what they ask.`);
      }
      // yesterday's agents make room; a part given to one of them keeps it
      const keep = new Set(job.parts.map((p) => p.agentId).filter(Boolean));
      for (const id of job.leftover || []) {
        const old = canvas.agents.get(id);
        if (old && !keep.has(id) && !old.current && !old.queue.length && !old.terminal && !old.panel?.spec) canvas.removeAgent(old);
      }
      delete job.leftover;
      job.status = "running"; this.emit();
      timer = setTimeout(() => { job.timedOut = true; stopParts(); }, JOB_TIMEOUT_MS);

      // 2. run: each part after what it depends on; readers together
      const by = (id) => job.parts.find((p) => p.id === id);
      const ready = (p) => p.status === "pending" && p.depends_on.every((d) => by(d).status === "done");
      const skipDependents = (id) => {
        for (const p of job.parts) if (p.status === "pending" && p.depends_on.includes(id)) { p.status = "skipped"; p.error = `needs "${id}"`; skipDependents(p.id); }
      };
      let halted = false; // a part failed: let what runs finish, start nothing new, then ask
      for (;;) {
        if (signal.aborted) throw new Error("stopped");
        if (!halted && !job.timedOut) for (const p of job.parts.filter(ready)) this.start(job, p, live, signal);
        if (live.size) { await Promise.race(live.values()); continue; }
        const failed = job.parts.filter((p) => p.status === "failed" && !p.asked);
        if (job.timedOut || !failed.length) {
          if (job.timedOut || !job.parts.some(ready)) break;
          halted = false; continue;
        }
        // 3. a part failed: the person decides
        halted = true;
        const p = failed[0];
        p.asked = true;
        const retry = say("Retry", "Yeniden dene"), skip = say("Skip", "Atla"), stop = say("Stop", "Durdur");
        this.emit();
        const choice = await this.ask(`${say("A part failed", "Bir parça başarısız oldu")}: ${p.title} (${p.model})\n${str(p.error, 600)}`, [retry, skip, stop], signal);
        if (choice === retry) { p.status = "pending"; p.error = null; p.asked = false; halted = false; }
        else if (choice === skip) { p.status = "skipped"; skipDependents(p.id); halted = false; }
        else {
          if (choice !== stop) job.note = choice; // their own words go back to the orchestrator
          else job.halted = true;                 // "Stop" is a stop: the orchestrator reports, it doesn't carry on alone
          for (const x of job.parts) if (x.status === "pending") x.status = "cancelled";
          break;
        }
        this.emit();
      }
      for (const p of job.parts) if (p.status === "pending") { p.status = "cancelled"; p.error ||= "not reached"; }

      // 4. done is checked, not said
      const writer = job.parts.find((p) => p.writes && p.status === "done");
      if (writer && !signal.aborted && !job.timedOut) {
        for (const c of job.checks) {
          if (c.status === "passed") continue;
          c.status = "running"; this.emit();
          Object.assign(c, await runCheck(c.command, a.workDir(), signal));
          this.emit();
          if (signal.aborted) throw new Error("stopped");
        }
        if (writer.changed.length && job.review?.status !== "ok") await this.reviewChange(job, writer, signal);
      }
      const checksOk = job.checks.every((c) => c.status === "passed" || c.status === "pending");
      job.status = job.timedOut ? "timed out" : job.parts.every((p) => p.status === "done") && checksOk ? "done" : "partial";
      this.emit();
      this.tell(this.report(job), { readOnly: !!job.halted });
    } catch (e) {
      stopParts();
      await Promise.allSettled(live.values());
      for (const p of job.parts) if (["pending", "running"].includes(p.status)) p.status = p.status === "running" ? "stopped" : "cancelled";
      for (const c of job.checks) if (c.status === "running") c.status = "stopped";
      if (job.review?.status === "running") job.review.status = "skipped";
      job.status = "stopped"; this.emit();
      // stopped by the person: nothing to wake the orchestrator for. Anything else it should hear about.
      if (!signal.aborted) this.tell(`The work "${job.title}" stopped on an engine error: ${e.message}. Tell the user; nothing more will run.`);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stopParts);
    }
  }

  /** one message to the orchestrator: it wakes for it like for any other, when it is free */
  tell(text, { readOnly = false } = {}) {
    const a = this.agent;
    if (!a.canvas.agents.has(a.id)) return;
    a.enqueue({ kind: "job", text, quiet: true, guest: readOnly }).catch(() => {});
  }

  /** one question to the person, in the chat's own question card, outside any turn; their answer alone comes back */
  async ask(title, options, signal) {
    const t = title.trim().slice(0, 1000);
    const out = await this.agent.workflow.ask({ questions: [{ title: t, options }] }, { signal });
    return out.slice(t.length).trim();
  }

  /** one part: its agent (made now, or the one named), the task as an ask, and what came of it */
  start(job, p, live, signal) {
    const a = this.agent, canvas = a.canvas;
    try {
      let target = p.agentId ? canvas.agents.get(p.agentId) : null;
      // the agent of an earlier try may have been removed meanwhile: a retry gets a new one
      if (p.agentId && !target) { if (p.given) throw new Error(`"${p.agentName}" is no longer on the canvas`); p.agentId = null; }
      if (!target) {
        // its orchestrator's account only where that account's CLI runs the model; another CLI uses this computer's login
        target = canvas.addAgent({ name: p.title, role: p.title, model: p.model, effort: p.effort || undefined, account: (!p.cli || p.cli === a.backend) && a.accountName || undefined,
          sandbox: p.writes ? "workspace-write" : "read-only", cwd: a.cwd || undefined }, { createdBy: a.id, parent: a, reason: p.title });
        // what the node is, for whoever looks at the canvas: this job's writer, or one of its readers
        target.jobRole = p.writes ? "writer" : "reader";
        job.made.push(target.id);
        canvas.bus.emit("agent_updated", { agent: target.view() });
      }
      p.agentId = target.id; p.agentName = target.name; p.status = "running"; p.error = null; p.startedAt = Date.now();
      // what the parts it builds on found goes with the task: it sees none of their work otherwise
      const before = p.depends_on.map((d) => job.parts.find((x) => x.id === d)).filter((x) => x?.answer).map((x) =>
        `Result of the earlier part "${x.title}" (${x.agentName}):\n${x.answer}${x.changed.length ? `\nFiles it changed: ${x.changed.join(", ")}` : ""}`);
      const text = [p.task,
        ...before,
        p.files.length ? `Files this part is about: ${p.files.join(", ")}` : "",
        p.done_when ? `It is done when: ${p.done_when}` : "",
        p.writes ? "You are the only agent changing files for this job. Change only what this part needs."
          : "This part only reads: do not change files; say what should change instead.",
        "Answer with: what you did, the files you changed, the checks you ran and their results. If you could not finish, say so plainly and why."].filter(Boolean).join("\n\n");
      const end = target.enqueue({ kind: "ask", from: a.id, text, about: p.title, quiet: true }).then((answer) => {
        p.status = "done"; p.answer = str(answer, ANSWER);
        // what the engine saw change in this turn, not what the agent says it changed
        const last = readTranscript(canvas.id, target.id, 3).filter((e) => e.from === target.id).at(-1);
        p.changed = (last?.changes || []).map((c) => c.path).slice(0, 60);
        p.trees = last?.checkpoint && last?.after ? [last.checkpoint, last.after] : null;
      }, (e) => {
        p.status = signal.aborted ? "stopped" : "failed"; p.error = str(e.message, 600);
      }).finally(() => { p.endedAt = Date.now(); live.delete(p.id); this.emit(); });
      live.set(p.id, end);
    } catch (e) {
      p.status = "failed"; p.error = str(e.message, 600);
    }
    this.emit();
  }

  /** the change, read by an agent that knows nothing of how it came about: the request and the diff, nothing else */
  async reviewChange(job, writer, signal) {
    const a = this.agent, canvas = a.canvas;
    job.review = { status: "running", model: job.reviewer, agentId: null, findings: null };
    this.emit();
    try {
      if (!writer.trees) throw new Error("no diff: the folder is not a git repository");
      let diff = "";
      for (const path of writer.changed) {
        if (diff.length > DIFF) break;
        diff += await fileDiff(a.workDir(), writer.trees[0], writer.trees[1], path);
      }
      if (!diff.trim()) throw new Error("no diff to read");
      const target = canvas.addAgent({ name: T(canvas.lang, "Review", "Gözden geçirme"), role: "reviews a change from its diff alone", model: job.reviewer,
        account: a.accountName || undefined, sandbox: "read-only", cwd: a.cwd || undefined }, { createdBy: a.id, parent: a, reason: T(canvas.lang, "review", "gözden geçirme") });
      target.jobRole = "reviewer";
      job.made.push(target.id);
      canvas.bus.emit("agent_updated", { agent: target.view() });
      job.review.agentId = target.id;
      const text = ["Review this change. You know nothing of how it was made, on purpose: judge it from the request and the diff, and read the surrounding code where you need to.",
        `What was asked for: ${job.request || job.title}\nThe part that made the change: ${writer.title}. ${writer.task.slice(0, 2000)}`,
        writer.done_when ? `It was to count as done when: ${writer.done_when}` : "",
        `The change (${writer.changed.length} files):\n\`\`\`diff\n${diff.slice(0, DIFF)}\n\`\`\`${diff.length > DIFF ? "\n(cut: read the rest in the files)" : ""}`,
        "Do not change files. Answer with a first line that is exactly VERDICT: OK or VERDICT: PROBLEMS, then the problems that matter, most serious first, each with its file and line and why it is wrong: bugs, what was asked for and is missing, what was changed and shouldn't have been. Leave style alone. If there is nothing serious, say so in a line."].filter(Boolean).join("\n\n");
      const answer = await target.enqueue({ kind: "ask", from: a.id, text, about: T(canvas.lang, "review", "gözden geçirme"), quiet: true });
      job.review.findings = str(answer, ANSWER);
      // the verdict, however the model dresses the line ("**VERDICT: OK**", "Verdict - ok")
      const head = answer.slice(0, 400);
      job.review.status = /verdict\W{0,6}ok\b/i.test(head) && !/verdict\W{0,6}problems/i.test(head) ? "ok" : "problems";
    } catch (e) {
      if (signal.aborted) throw e;
      job.review.status = "skipped"; job.review.findings = str(e.message, 600);
    } finally {
      this.emit();
    }
  }

  /** what the orchestrator gets back, once */
  report(job) {
    const parts = job.parts.map((p) => ({ id: p.id, title: p.title, agent: p.agentName, model: p.model, status: p.status,
      ...(p.answer ? { answer: p.answer } : {}), ...(p.error ? { error: p.error } : {}),
      ...(p.writes ? { files_changed: p.changed } : {}) }));
    const open = job.parts.filter((p) => p.status !== "done").map((p) => `${p.id} (${p.status})`);
    const failed = job.checks.filter((c) => c.status === "failed" || c.status === "timed out");
    const ran = job.checks.filter((c) => c.status !== "pending");
    const says = [];
    if (job.timedOut) says.push("The work ran out of time and was stopped.");
    if (job.halted) says.push("The user stopped this work when a part failed. Stop too: for this message you cannot change files. Tell them in a few lines what was done, what failed and why, and ask how they want to go on. Do not do the remaining work yourself unless they then ask you to.");
    if (open.length) says.push(`Not done: ${open.join(", ")}. Do not present the work as finished. Tell the user plainly what is done and what is not; do not redo skipped or stopped parts unless they ask.`);
    if (failed.length) says.push(`Checks failed: ${failed.map((c) => c.command).join(" ; ")}. The work is not done until they pass: read the output, fix the cause (you may write now; the parts have ended), run them again yourself.`);
    if (job.review?.status === "problems") says.push("The reviewer found problems (review.findings). Decide which are real against what the user asked, fix those yourself, and say which you left and why.");
    if (!says.length) says.push(ran.length || job.review?.status === "ok"
      ? "The parts are done, the checks that were run passed and the review found nothing serious. Tell the user what was done by which agent on which model, and what was checked."
      : "Every part reported done, but nothing checked it (no check commands, no change to review). That is their word, not proof: read what came back, run the project's checks yourself, then tell the user what was done and what you verified.");
    return `The work "${job.title}" you handed out with plan_work has ended.\n\n`
      + JSON.stringify({ job: job.title, status: job.status, ...(job.note ? { user_said: job.note } : {}), parts,
        ...(ran.length ? { checks: ran.map((c) => ({ command: c.command, status: c.status, exit: c.exit, output: c.output })) } : {}),
        ...(job.review ? { review: { status: job.review.status, model: job.review.model, findings: job.review.findings } } : {}) }, null, 2)
      + "\n\n" + says.join("\n");
  }
}

/** one check command, run by the engine in the job's folder: its exit code and the end of what it printed */
function runCheck(command, cwd, signal) {
  return new Promise((resolve) => {
    let out = "", done = false;
    const child = shellSpawn(command, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" }, detached: true });
    const kill = () => killTree(child, "SIGKILL");
    const end = (r) => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener("abort", stop); resolve({ ...r, output: out.slice(-3000) }); };
    const stop = () => { kill(); end({ status: "stopped", exit: null }); };
    const timer = setTimeout(() => { kill(); end({ status: "timed out", exit: null }); }, CHECK_TIMEOUT_MS);
    signal.addEventListener("abort", stop, { once: true });
    const take = (d) => { out = (out + d).slice(-20000); };
    child.stdout.on("data", take); child.stderr.on("data", take);
    child.on("error", (e) => { out += String(e.message); end({ status: "failed", exit: null }); });
    child.on("close", (code) => end({ status: code === 0 ? "passed" : "failed", exit: code }));
  });
}
