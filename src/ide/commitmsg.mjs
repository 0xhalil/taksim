// "Write it for me": one commit message for the chosen changes, written by a fast model from the diff
// itself and how the repository's own commits read. The Commit window's ✦ calls this; nothing is committed
// here. Without a model to ask, the button says why and the person writes it.

import { httpError } from "../http.mjs";
import { run } from "../runner.mjs";
import { pickBackend, BACKENDS } from "../backends/index.mjs";
import { gitStatus } from "./fs.mjs";
import { diffForModel, log } from "./vcs.mjs";

const SYSTEM = `You write the one-line git commit message for a change in a software project.
Match how this repository's own recent commits read: lowercase, concrete, no trailing period, saying what
the change does rather than what it touches. Reply with ONLY the message: no quotes, no markdown, one line.`;

function modelFor() {
  if (process.env.TAKSIM_COMMIT_MODEL) return process.env.TAKSIM_COMMIT_MODEL;
  if (process.env.TAKSIM_FAKE === "1") return "fake-commit";
  return BACKENDS.some((b) => b.name === "claude") ? "haiku" : BACKENDS[0]?.defaultModel;
}

/** the message alone, whatever wrapping the model used */
export function cleanMessage(text) {
  let t = String(text || "").trim();
  t = t.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
  t = t.split("\n").find((l) => l.trim()) || "";
  t = t.replace(/^(commit message|message)\s*:\s*/i, "").trim();
  t = t.replace(/^["'`]+|["'`]+$/g, "").trim();
  return t.split("\n")[0].slice(0, 200);
}

export async function suggestMessage(root, { files } = {}) {
  const status = await gitStatus(root);
  if (!status) throw httpError(400, "this folder is not a git repository");
  const changed = new Set(status.files.map((f) => f.path));
  const list = (Array.isArray(files) && files.length ? files.map(String) : status.files.map((f) => f.path)).filter((p) => changed.has(p));
  if (!list.length) throw httpError(400, "no changes to describe");
  const diff = await diffForModel(root, list);
  if (!diff.trim()) throw httpError(400, "no changes to describe");
  const style = (await log(root, 8)).map((c) => `- ${c.subject}`).join("\n");
  const { backend, model, error } = pickBackend(modelFor());
  if (error) throw httpError(503, error);
  let text;
  try {
    const r = await run(backend, { model, system: SYSTEM, prompt: `Recent commits (this repository's style):\n${style}\n\nThe change:\n${diff}`,
      opts: {}, signal: AbortSignal.timeout(60000) });
    text = r.text;
  } catch (e) {
    throw httpError(502, `the model couldn't write it: ${e.message}`);
  }
  const message = cleanMessage(text);
  if (!message) throw httpError(502, "the model returned nothing");
  return { message, by: model };
}
