// Getting a local model going from the app, one step at a time: Ollama installed (Homebrew, else its download page),
// started, and a model that suits this Mac's memory pulled, with progress. GET /v1/local says where things stand.

import { spawn } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { delimiter, join } from "node:path";
import { httpError } from "./http.mjs";
import local, { serverList, addServer, removeServer, deleteModel } from "./backends/local.mjs";

const OLLAMA = process.env.TAKSIM_OLLAMA_URL || "http://127.0.0.1:11434";
const APP = "/Applications/Ollama.app";
// the model offered for this computer: the largest Qwen3 that leaves room to work (it calls tools, has a thinking
// mode, and comes in steps of size); sizes are the download (Ollama's library, 2026-10)
const STEPS = [
  { below: 12, model: "qwen3:1.7b", gb: 1.4 },
  { below: 24, model: "qwen3:4b", gb: 2.5 },
  { below: 48, model: "qwen3:8b", gb: 5.2 },
  { below: Infinity, model: "qwen3:14b", gb: 9.3 },
];
export const recommend = (memoryGB) => STEPS.find((s) => memoryGB < s.below);

const job = { install: null, start: null, pull: null }; // what is under way: { running, error, ... }

const onPath = (f) => (process.env.PATH || "").split(delimiter).some((d) => d && existsSync(join(d, f)));
function ollamaBin() {
  for (const p of ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama", join(APP, "Contents/Resources/ollama")]) if (existsSync(p)) return p;
  return onPath("ollama") ? "ollama" : null;
}
const brew = () => ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find(existsSync) || null;

async function running() {
  try { return !!(await (await fetch(`${OLLAMA}/api/version`, { signal: AbortSignal.timeout(1200) })).json()).version; } catch { return false; }
}
const freeGB = () => { try { const s = statfsSync(homedir()); return (s.bavail * s.bsize) / 1e9; } catch { return null; } };

/** where things stand, for the app's Local tile */
export async function localState() {
  const memoryGB = Math.round(totalmem() / 2 ** 30); // as macOS says it: 16 GB, not 17
  const step = recommend(memoryGB);
  const up = await running();
  if (up && !local.models.length) await local.refresh(); // a server started outside taksim a moment ago
  return {
    ollama: { installed: !!ollamaBin() || existsSync(APP), app: existsSync(APP), running: up },
    canInstall: !!brew(),
    models: local.models,
    recommended: { model: step.model, gb: step.gb },
    memoryGB, freeGB: freeGB() == null ? null : Math.round(freeGB() * 10) / 10,
    install: job.install, start: job.start, pull: job.pull,
    servers: await serverList(),
  };
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const keep = (c) => { tail = (tail + c).slice(-2000); };
    child.stdout.on("data", keep); child.stderr.on("data", keep);
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(tail.trim().split("\n").slice(-3).join("\n") || `exit ${code}`)));
  });
}

/** Homebrew's ollama, then started; without Homebrew the app opens Ollama's download page instead */
export function installOllama() {
  if (!brew()) throw httpError(400, "Homebrew isn't on this computer; get Ollama from https://ollama.com/download");
  if (job.install?.running) return job.install;
  job.install = { running: true, error: null };
  run(brew(), ["install", "ollama"]).then(
    async () => { job.install = { running: false, error: null }; await startOllama().catch(() => {}); },
    (e) => { job.install = { running: false, error: String(e.message).slice(0, 400) }; },
  );
  return job.install;
}

/** the app if there is one (it keeps itself running), else `ollama serve` left running on its own; waits until it answers */
export async function startOllama() {
  if (await running()) return { running: true };
  const bin = ollamaBin();
  if (!existsSync(APP) && !bin) throw httpError(400, "Ollama isn't installed");
  job.start = { running: true, error: null };
  try {
    if (existsSync(APP)) spawn("open", ["-a", APP], { stdio: "ignore", detached: true }).unref();
    else spawn(bin, ["serve"], { stdio: "ignore", detached: true, env: { ...process.env, OLLAMA_FLASH_ATTENTION: "1" } }).unref();
    for (let i = 0; i < 40 && !(await running()); i++) await new Promise((r) => setTimeout(r, 500));
    if (!(await running())) throw new Error("Ollama didn't start");
    await local.refresh();
    job.start = null;
    return { running: true };
  } catch (e) {
    job.start = { running: false, error: e.message };
    throw httpError(500, e.message);
  }
}

/** pulls a model with progress (job.pull: completed / total bytes); the disk is checked first */
export async function pullModel(model) {
  const name = String(model || "").trim();
  if (!/^[\w.\-/]+(:[\w.\-]+)?$/.test(name)) throw httpError(400, "bad model name");
  if (job.pull?.running) return job.pull;
  if (!(await running())) throw httpError(400, "Ollama isn't running");
  const need = STEPS.find((s) => s.model === name)?.gb;
  const free = freeGB();
  if (need && free != null && free < need + 1) throw httpError(400, `${name} needs ${need} GB; ${free.toFixed(1)} GB is free`);
  job.pull = { running: true, model: name, completed: 0, total: 0, error: null };
  (async () => {
    const r = await fetch(`${OLLAMA}/api/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: name, stream: true }) });
    if (!r.ok) throw new Error(`Ollama answered ${r.status}`);
    const decoder = new TextDecoder();
    let buf = "";
    // the layers come one after another: the biggest one's bytes are the progress
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.error) throw new Error(ev.error);
        if (ev.total && ev.total >= job.pull.total) { job.pull.total = ev.total; job.pull.completed = ev.completed || 0; }
        if (ev.status === "success") job.pull.done = true;
      }
    }
    if (!job.pull.done) throw new Error("the download stopped");
    await local.refresh();
    job.pull = { running: false, model: name, done: true, error: null };
  })().catch((e) => { job.pull = { running: false, model: name, error: String(e.message).slice(0, 300) }; });
  return job.pull;
}

// GET /v1/local · POST /v1/local/install · POST /v1/local/start · POST /v1/local/pull {model}
export async function localRoutes(req, res, path, { readJson, sendJson }) {
  if (path === "/v1/local" && req.method === "GET") return sendJson(res, 200, await localState());
  if (req.method !== "POST") return false;
  if (path === "/v1/local/install") return sendJson(res, 202, installOllama());
  if (path === "/v1/local/start") return sendJson(res, 200, await startOllama());
  // Settings: servers added and removed (Ollama's and LM Studio's stay), a model deleted to free its disk
  if (path === "/v1/local/servers") {
    const body = await readJson(req).catch(() => ({}));
    const url = addServer(body?.url);
    if (!url) throw httpError(400, "give the server's address, like http://127.0.0.1:8080");
    await local.refresh();
    return sendJson(res, 200, { url });
  }
  if (path === "/v1/local/servers/remove") {
    const body = await readJson(req).catch(() => ({}));
    removeServer(body?.url);
    await local.refresh();
    return sendJson(res, 200, { ok: true });
  }
  if (path === "/v1/local/delete") {
    const body = await readJson(req).catch(() => ({}));
    try { await deleteModel(String(body?.model || "")); } catch (e) { throw httpError(400, e.message); }
    await local.refresh();
    return sendJson(res, 200, { ok: true });
  }
  if (path === "/v1/local/pull") {
    const body = await readJson(req).catch(() => ({}));
    return sendJson(res, 202, await pullModel(body?.model || recommend(Math.round(totalmem() / 2 ** 30)).model));
  }
  return false;
}
