// The IDE's model features, the ones Cursor made familiar: ⌘K rewrites chosen lines from an instruction, "ask the
// codebase" finds where something lives from a question, "review" marks what looks wrong in the uncommitted
// changes. Each is one run of the user's own agent CLI (the fast model of the first backend that has one), so no
// API key is involved; nothing here writes a file: edits come back as text for the page to show as a diff.

import { readFileSync } from "node:fs";
import { httpError } from "../http.mjs";
import { run } from "../runner.mjs";
import { pickBackend, BACKENDS } from "../backends/index.mjs";
import { inside, allFiles, gitStatus } from "./fs.mjs";
import { diffForModel } from "./vcs.mjs";
import { projectRules } from "./rules.mjs";

const MAX_FILE = 60000;

function modelFor(kind) {
  if (process.env.TAKSIM_IDE_MODEL) return process.env.TAKSIM_IDE_MODEL;
  if (process.env.TAKSIM_FAKE === "1") return "fake-ide";
  if (!BACKENDS.some((b) => b.name === "claude")) return BACKENDS[0]?.defaultModel;
  return kind === "pick" ? "haiku" : "sonnet"; // picking files is easy; editing and reviewing are not
}

async function ask(kind, root, system, prompt, timeout = 120000) {
  const { backend, model, error } = pickBackend(modelFor(kind));
  if (error) throw httpError(503, error);
  const rules = projectRules(root, { all: true });
  try {
    const r = await run(backend, { model, system: rules ? `${system}\n\nProject rules:\n${rules}` : system, prompt: `TASK: ${kind}\n${prompt}`, opts: {}, signal: AbortSignal.timeout(timeout) });
    return { text: r.text || "", by: model };
  } catch (e) {
    throw httpError(502, `the model couldn't do it: ${e.message}`);
  }
}

/** the JSON a model answered with, whatever fence or chatter surrounds it */
export function parseJson(text) {
  const t = String(text || "");
  const first = (o) => { const i = t.indexOf(o); return i < 0 ? Infinity : i; };
  for (const [open, close] of first("[") < first("{") ? [["[", "]"], ["{", "}"]] : [["{", "}"], ["[", "]"]]) {
    const s = t.indexOf(open);
    if (s < 0) continue;
    for (let e = t.lastIndexOf(close); e > s; e = t.lastIndexOf(close, e - 1)) {
      try { return JSON.parse(t.slice(s, e + 1)); } catch { /* try a shorter one */ }
    }
  }
  return null;
}

/** the code alone, whatever fence the model wrapped it in (a fence is only dropped when it wraps the whole reply) */
export function cleanCode(text) {
  let t = String(text || "").replace(/\r\n/g, "\n");
  const m = t.match(/^\s*```[\w+-]*\n([\s\S]*?)\n?```\s*$/);
  if (m) t = m[1];
  return t.replace(/\n+$/, "");
}

const EDIT_SYSTEM = `You are a precise code editor inside an IDE. You are given a file, a selected region of it, and an instruction.
Rewrite ONLY the selected region as the instruction says, keeping the file's indentation and style. Reply with ONLY the
new text of the region: no explanation, no markdown fence, no line numbers. An empty reply deletes the region.`;

// ⌘K: the chosen lines (1-based, inclusive) rewritten from an instruction.
export async function editSelection(root, { path, from, to, instruction }) {
  if (!path || !String(instruction || "").trim()) throw httpError(400, "path and instruction are required");
  const text = readFileSync(inside(root, path), "utf8");
  if (text.length > 400000) throw httpError(400, "the file is too large to edit with the model");
  const lines = text.split("\n");
  const a = Math.min(lines.length, Math.max(1, Number(from) || 1)), b = Math.min(lines.length, Math.max(a, Number(to) || a));
  const selected = lines.slice(a - 1, b).join("\n");
  const around = lines.slice(Math.max(0, a - 1 - 80), Math.min(lines.length, b + 80)).join("\n").slice(0, MAX_FILE);
  const { text: out, by } = await ask("edit", root, EDIT_SYSTEM,
    `File: ${path}\nContext around the selection:\n<context>\n${around}\n</context>\n\nSelected region (lines ${a}-${b}):\n<selected>\n${selected}\n</selected>\n\nInstruction: ${String(instruction).slice(0, 2000)}`);
  return { path, from: a, to: b, original: selected, replacement: cleanCode(out), by };
}

const PICK_SYSTEM = `You help find code in a project. From the list of file paths, choose the files most likely to answer the question.
Reply with ONLY a JSON array of up to 6 paths, most relevant first.`;
const ANSWER_SYSTEM = `You answer a question about a codebase from the numbered file excerpts given. Reply with ONLY JSON:
{"answer": "one or two sentences", "hits": [{"path": "...", "line": 12, "end_line": 20, "why": "a few words"}]}
Hits are the places that matter, at most 8, with line numbers taken from the excerpts. Never invent paths or lines.`;

const numbered = (text) => text.split("\n").map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join("\n");

// "Ask the codebase": where does this live? The model first picks files from the project's paths, then reads them.
export async function askCodebase(root, { question }) {
  const q = String(question || "").trim();
  if (!q) throw httpError(400, "question is required");
  const files = allFiles(root).slice(0, 4000);
  if (!files.length) throw httpError(400, "the project has no files");
  const picked = parseJson((await ask("pick", root, PICK_SYSTEM, `Question: ${q}\n\nFILE LIST\n${files.join("\n")}`, 60000)).text);
  const set = new Set(files);
  const chosen = (Array.isArray(picked) ? picked : []).map(String).filter((p) => set.has(p)).slice(0, 6);
  if (!chosen.length) return { answer: "", hits: [], files: [] };
  let budget = 48000;
  const excerpts = [];
  for (const p of chosen) {
    let t;
    try { t = readFileSync(inside(root, p), "utf8"); } catch { continue; }
    if (t.includes("\0")) continue;
    t = t.slice(0, Math.min(12000, budget));
    budget -= t.length;
    excerpts.push(`=== ${p}\n${numbered(t)}`);
    if (budget <= 0) break;
  }
  const { text, by } = await ask("answer", root, ANSWER_SYSTEM, `Question: ${q}\n\nANSWER FROM THESE FILES\n${excerpts.join("\n\n")}`);
  const j = parseJson(text) || {};
  const ok = new Set(chosen);
  const hits = (Array.isArray(j.hits) ? j.hits : []).filter((h) => h && ok.has(h.path) && Number(h.line) > 0).slice(0, 8)
    .map((h) => ({ path: h.path, line: Math.floor(Number(h.line)), endLine: Math.max(Math.floor(Number(h.line)), Math.floor(Number(h.end_line)) || 0),
      why: String(h.why || "").slice(0, 160) }));
  return { answer: String(j.answer || "").slice(0, 600), hits, files: chosen, by };
}

const REVIEW_SYSTEM = `You review uncommitted changes in a software project, like a careful colleague. Find real problems in the changed lines:
bugs, missed edge cases, broken callers, security mistakes. Skip style and taste. Reply with ONLY a JSON array (empty if the change is fine) of
{"path": "...", "line": 12, "code": "text of that line", "severity": "error|warning|info", "text": "what is wrong and why, one or two sentences"}.
At most 8 findings; line numbers are for the NEW version of the file.`;

// Cursor's Bugbot, on the working copy: what a model finds wrong in the uncommitted changes (they become notes).
export async function reviewChanges(root, { files } = {}) {
  const status = await gitStatus(root);
  if (!status) throw httpError(400, "this folder is not a git repository");
  const changed = new Set(status.files.filter((f) => f.status !== "deleted").map((f) => f.path));
  const list = (Array.isArray(files) && files.length ? files.map(String) : [...changed]).filter((p) => changed.has(p));
  if (!list.length) throw httpError(400, "no changes to review");
  const diff = await diffForModel(root, list, { maxBytes: 60000 });
  if (!diff.trim()) throw httpError(400, "no changes to review");
  const { text, by } = await ask("review", root, REVIEW_SYSTEM, `The change:\n${diff}`, 180000);
  const j = parseJson(text);
  if (!Array.isArray(j)) throw httpError(502, "the model returned no review");
  const findings = j.filter((f) => f && changed.has(f.path) && String(f.text || "").trim())
    .slice(0, 8).map((f) => ({ path: f.path, line: Math.max(1, Math.floor(Number(f.line)) || 1), code: typeof f.code === "string" ? f.code : undefined,
      severity: ["info", "warning", "error"].includes(f.severity) ? f.severity : "warning", text: String(f.text).slice(0, 600) }));
  return { findings, by };
}
