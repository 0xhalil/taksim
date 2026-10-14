#!/usr/bin/env node
// Does orchestrating pay, on our own work? Runs each task twice on a copy of its repository: once with one
// agent, once with "Create agents" on, and lets the task's own check commands say which worked.
//
//   node eval/run.mjs --server http://127.0.0.1:8787 --model sonnet [--tasks eval/tasks] [--modes single,orchestrated] [--out eval/results.json]
//
// It talks to a running taksim engine (the app's, so its accounts are used) and spends real tokens on real models.
// Approval questions of an orchestrated job are answered "Start"; a failed part is answered "Stop".

import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export async function runTask(server, task, { model, mode, timeoutMs = 30 * 60 * 1000 }) {
  const api = async (method, path, body) => {
    const r = await fetch(server + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  // a copy of the repository, so the two runs start from the same place and the original is untouched
  const work = mkdtempSync(join(tmpdir(), `taksim-eval-${task.id}-${mode}-`));
  cpSync(resolve(task.repo), work, { recursive: true });
  if (spawnSync("git", ["rev-parse", "--git-dir"], { cwd: work }).status !== 0) {
    execFileSync("git", ["init", "-q"], { cwd: work });
    execFileSync("git", ["add", "-A"], { cwd: work });
    execFileSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@taksim", "commit", "-qm", "start", "--allow-empty"], { cwd: work });
  }
  const canvas = (await api("POST", "/v1/canvases", { name: `eval ${task.id} ${mode}` })).data;
  const started = Date.now();
  const out = { task: task.id, mode, model, passed: false, checks: [], split: false, agents: 1, tokens: 0, seconds: 0, error: null };
  try {
    const lead = (await api("POST", `/v1/canvases/${canvas.id}/agents`, { name: "lead", model, chat: true, cwd: work, delegate: mode === "orchestrated", autoApprove: true })).data;
    const path = `/v1/canvases/${canvas.id}/agents/${lead.id}`;
    const sent = await api("POST", `${path}/messages`, { text: task.prompt });
    if (sent.status >= 400) throw new Error(sent.data?.error?.message || `HTTP ${sent.status}`);
    const answered = true; // the turn is under way from here; its end is read from the agent's state below
    // done when its first turn has ended, nothing it handed out is under way, nobody is asked anything and it is idle
    // with an empty queue (an orchestrated job goes on after the turn that proposed it and reports in a later one)
    for (;;) {
      if (Date.now() - started > timeoutMs) { await api("POST", `${path}/stop`); out.error = "timed out"; break; }
      const q = (await api("GET", `${path}/workflow`)).data?.question;
      if (q) {
        // the orchestrator's own questions: start the work, stop on a failed part; anything else gets a neutral go-ahead
        const options = q.questions[0].options || [];
        const pick = options.includes("Start") ? "Start" : options.includes("Stop") ? "Stop" : options[0] || "Use your best judgment and continue.";
        await api("POST", `${path}/workflow`, { action: "answer", id: q.id, answers: Object.fromEntries(q.questions.map((x) => [x.id, pick])) });
      } else if (answered) {
        const now = (await api("GET", path)).data, j = (await api("GET", `${path}/job`)).data?.job;
        if (now.status === "error" && now.queued === 0) { out.error ||= now.lastError || "the agent failed"; break; }
        if (now.status !== "running" && now.status !== "waiting" && now.queued === 0 && !(j && ["proposed", "running"].includes(j.status))) {
          await sleep(300); // the engine's message about a finished job is queued just after the job ends
          const again = (await api("GET", path)).data;
          if (again.status !== "running" && again.queued === 0) break;
        }
      }
      await sleep(400);
    }
    const job = (await api("GET", `${path}/job`)).data?.job;
    out.split = !!job && job.status !== "declined";
    if (job) out.job = { status: job.status, parts: job.parts.map((p) => [p.title, p.model, p.status]), review: job.review?.status || null };
    const agents = (await api("GET", `/v1/canvases/${canvas.id}`)).data.agents;
    out.agents = agents.length;
    out.made = agents.filter((a) => a.id !== lead.id).map((a) => [a.name, a.model, a.sandbox || "write", a.jobRole || "by create_agent"]);
    for (const a of agents) {
      const t = (await api("GET", `/v1/canvases/${canvas.id}/agents/${a.id}/transcript?limit=1000`)).data?.transcript || [];
      for (const e of t) out.tokens += (e.usage?.input || 0) + (e.usage?.output || 0);
    }
  } catch (e) { out.error = e.message; }
  out.seconds = Math.round((Date.now() - started) / 1000);
  // the task's checks decide, not what any agent said
  for (const command of task.checks || []) {
    const r = spawnSync("/bin/sh", ["-c", command], { cwd: work, encoding: "utf8", timeout: 10 * 60 * 1000, env: { ...process.env, CI: "1" } });
    out.checks.push({ command, passed: r.status === 0, output: ((r.stdout || "") + (r.stderr || "")).slice(-1500) });
  }
  out.passed = !out.error && out.checks.length > 0 && out.checks.every((c) => c.passed);
  await api("DELETE", `/v1/canvases/${canvas.id}`).catch(() => {});
  rmSync(work, { recursive: true, force: true });
  return out;
}

export function summarize(results) {
  const rows = [];
  for (const mode of [...new Set(results.map((r) => r.mode))]) {
    const of = results.filter((r) => r.mode === mode), n = of.length || 1;
    rows.push({ mode, tasks: of.length, passed: of.filter((r) => r.passed).length, split: of.filter((r) => r.split).length,
      tokens: Math.round(of.reduce((s, r) => s + r.tokens, 0) / n), seconds: Math.round(of.reduce((s, r) => s + r.seconds, 0) / n) });
  }
  return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
  const server = arg("--server", "http://127.0.0.1:8787"), model = arg("--model"), dir = arg("--tasks", "eval/tasks");
  const modes = arg("--modes", "single,orchestrated").split(",");
  if (!model) { console.error("usage: node eval/run.mjs --model <id> [--server URL] [--tasks dir] [--modes single,orchestrated] [--out file]"); process.exit(2); }
  const tasks = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))).filter((t) => !t.example);
  if (!tasks.length) { console.error(`no tasks in ${dir} (files marked "example": true are skipped); see eval/README.md`); process.exit(2); }
  const results = [];
  for (const task of tasks) for (const mode of modes) {
    process.stdout.write(`${task.id} · ${mode} … `);
    const r = await runTask(server, task, { model, mode });
    results.push(r);
    console.log(`${r.passed ? "pass" : "FAIL"}${r.split ? " (split)" : ""} ${r.tokens} tokens ${r.seconds}s${r.error ? ` · ${r.error}` : ""}`);
  }
  console.table(summarize(results));
  writeFileSync(arg("--out", "eval/results.json"), JSON.stringify({ at: new Date().toISOString(), model, results }, null, 2));
}
