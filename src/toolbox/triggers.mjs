// The words that make a tool findable, written by a model: what a person would say when they need it. An
// agent saving its own panel writes them itself (save_tool); this is for tools saved, imported or edited
// from the UI, and for "write them again". The model is the one the person works with: the agent's whose panel
// it was, else one of the canvas's agents, on its account (they may have no other subscription). Without a
// usable model, words taken from the spec stand in.

import { run } from "../runner.mjs";
import { pickBackend, BACKENDS } from "../backends/index.mjs";
import { specTriggers } from "./store.mjs";
import { allCanvases } from "../canvas/canvas.mjs";

const SYSTEM = `You write search triggers for a saved monitoring/dev tool in taksim, an app where AI agents open live panels.
Given the tool (its panel spec: commands, files, views), reply with ONLY a JSON object:
{"summary": "<one sentence: what it shows and what for>",
 "when": ["<8-14 short requests a user would type when they need this tool, mixed Turkish and English, casual, varied wording, e.g. 'pod'lar neden restart oluyor', 'watch the k8s pods'>"],
 "keywords": ["<6-15 single words: programs, technologies, nouns, synonyms>"],
 "reference": {"product": "<the best-known product this tool resembles, e.g. k9s, lazydocker, lnav, htop, pghero>", "url": "<its homepage>", "borrowed": ["<2-5 features of it this tool also shows>"]}}
No markdown, no explanation.`;

function writer(agent) {
  if (process.env.TAKSIM_TRIGGER_MODEL) return { model: process.env.TAKSIM_TRIGGER_MODEL };
  if (process.env.TAKSIM_FAKE === "1") return { model: "fake-echo" };
  const a = agent || allCanvases().flatMap((c) => [...c.agents.values()]).find((x) => x.model);
  return a ? { model: a.model, env: a.env } : { model: BACKENDS[0]?.defaultModel };
}

// what the model sees: everything that says what the tool does, nothing it showed (that may be private)
function describe(t) {
  return JSON.stringify({ name: t.name, summary: t.summary || undefined, instructions: t.instructions?.slice(0, 1500) || undefined,
    params: Object.fromEntries(Object.entries(t.params || {}).map(([k, p]) => [k, p.desc || ""])),
    sources: t.spec?.sources, views: (t.spec?.views || []).map((v) => ({ brick: v.brick, title: v.title, source: v.source, columns: v.columns })) }, null, 1);
}

function parseReply(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (!Array.isArray(j.when) || !j.when.length) return null;
    return { summary: typeof j.summary === "string" ? j.summary : "", when: j.when.map(String), keywords: Array.isArray(j.keywords) ? j.keywords.map(String) : [],
      reference: j.reference && typeof j.reference === "object" && j.reference.product ? j.reference : null };
  } catch { return null; }
}

// Words from the spec itself: programs, their subcommands, titles.
export function heuristicTriggers(t) {
  const { keywords } = specTriggers(t);
  return { summary: t.summary || t.spec?.title || t.name, when: [t.name, t.spec?.title].filter(Boolean), keywords, by: "spec" };
}

export async function generateTriggers(t, { signal, agent } = {}) {
  const fallback = heuristicTriggers(t);
  const who = writer(agent);
  const { backend, model, error } = pickBackend(who.model);
  if (error) return fallback;
  try {
    const r = await run(backend, { model, system: SYSTEM, prompt: `Tool:\n${describe(t)}`, opts: {}, env: who.env, signal: signal || AbortSignal.timeout(90000) });
    const got = parseReply(r.text);
    if (!got) return fallback;
    return { summary: got.summary || fallback.summary, when: got.when, reference: got.reference, keywords: [...new Set([...got.keywords, ...fallback.keywords])].slice(0, 30), by: model };
  } catch { return fallback; }
}
