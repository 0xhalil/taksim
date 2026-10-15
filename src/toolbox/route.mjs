// Whether a saved tool really fits a request, judged by a model rather than by shared words: a message can
// share words with a tool and still be about something else ("the log-in page is broken" isn't a log viewer).
// Used where the agent itself can't be asked: a prompt typed straight into its terminal. The judge is the
// model of that conversation, on its account: the person may have no subscription but the one they chose.
// Without one (the demo, a fake model) the word match stands in.
//   judge(text, tools, { model, env }) -> { use: tool | null, build: string | null, by }

import { run } from "../runner.mjs";
import { pickBackend } from "../backends/index.mjs";
import { candidates, suggest } from "./match.mjs";

const SYSTEM = `You route a user's request in taksim, an app where AI agents open live panels (saved tools) next to their work.
Given the request and the saved tools that share words with it, reply with ONLY a JSON object:
{"use": "<the id of the tool that really serves this request, or null>",
 "build": "<when no tool fits but a live panel would clearly help (something to watch, check again or compare), the need in a few words; else null>"}
A tool fits only when opening it answers what the user asked; sharing a word is not enough. Most coding requests need neither. No markdown.`;

const describe = (t) => ({ id: t.id, name: t.name, summary: t.summary, when: (t.when || []).slice(0, 5) });

export function parseJudgement(text, ids) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const use = typeof j.use === "string" && ids.includes(j.use) ? j.use : null;
    const build = !use && typeof j.build === "string" && j.build.trim() ? j.build.trim().slice(0, 200) : null;
    return { use, build };
  } catch { return null; }
}

async function byModel(text, found, { model: name, env, signal }) {
  if (!name) return null;
  const { backend, model, error } = pickBackend(name);
  if (error || backend.name === "fake") return null;
  const tools = found.map(({ tool }) => describe(tool));
  const r = await run(backend, { model, system: SYSTEM, prompt: `Request: ${text.slice(0, 1500)}\n\nTools:\n${JSON.stringify(tools, null, 1)}`,
    opts: {}, env, signal: signal || AbortSignal.timeout(60000) });
  return parseJudgement(r.text, tools.map((t) => t.id));
}

// `build`: also ask whether a new tool is worth building when no saved one shares words with the request.
export async function judge(text, tools, { model, env, signal, build = false } = {}) {
  const found = candidates(text, tools);
  if (!found.length && !build) return { use: null, build: null, by: "words" };
  const words = () => ({ use: suggest(text, tools)[0]?.tool || null, build: null, by: "words" });
  try {
    const got = await byModel(text, found, { model, env, signal });
    if (!got) return words();
    return { use: got.use ? tools.find((t) => t.id === got.use) || null : null, build: got.build, by: model };
  } catch { return words(); }
}
