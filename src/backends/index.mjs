// Backend registry. A backend is an object with:
//   name, cmd, models, defaultModel, matches(model), maxConcurrency,
//   build({model, system, prompt, opts, note}) -> {args, cwd, stdin, env?},
//   parse(jsonEvent, state, onText)
// and optionally init(), resolveModel(model), checkModel(model) -> error string.

import { baseUrl, cfg } from "../config.mjs";
import claude from "./claude.mjs";
import codex from "./codex.mjs";
import opencode from "./opencode.mjs";
import gemini from "./gemini.mjs";
import copilot from "./copilot.mjs";
import local from "./local.mjs";
import fake from "./fake.mjs";

// Display order; matching order is separate: "local:" and "copilot:" first (a local id may hold a "/"),
// then opencode's "provider/model" check, which must win over the other prefixes.
export const BACKENDS = [
  claude, codex,
  gemini,
  copilot, opencode, local,
  ...(cfg.fake ? [fake] : []),
];
const rank = (b) => (b === local || b === copilot ? 2 : b === opencode ? 1 : 0);
const MATCH_ORDER = [...BACKENDS].sort((a, b) => rank(b) - rank(a));

export async function initBackends() {
  await Promise.all(BACKENDS.map((b) => b.init?.()));
}

export function pickBackend(model) {
  const m = (model || "").toLowerCase();
  const matched = MATCH_ORDER.find((b) => b.matches(m));
  const backend = matched || claude;
  const resolved = backend.resolveModel ? backend.resolveModel(model) : model || backend.defaultModel;
  // a name no CLI knows isn't quietly run as Claude's default
  if (!matched && m) return { backend, model: resolved, error: `unknown model "${model}"; see GET /v1/models` };
  return { backend, model: resolved, error: backend.checkModel?.(resolved) };
}

export function listModels() {
  return BACKENDS.flatMap((b) => b.models.map((id) =>
    ({ id, object: "model", owned_by: b.name, type: "model", display_name: id })));
}

// Appended to an orchestrating agent's system prompt so it can delegate through this proxy.
export function orchestratorNote() {
  const list = BACKENDS.filter((b) => b !== fake).map((b) => `${b.name}: ${b.models.length > 8
    ? `${b.models.filter((m) => !m.includes("free")).slice(0, 8).join(", ")} … (${b.models.length} total, GET ${baseUrl()}/models)`
    : b.models.join(", ")}`).join("; ");
  return `Other AI agents are available through a local OpenAI-compatible API at ${baseUrl()}.
Models — ${list}.
Delegate with curl, e.g.:
curl -s ${baseUrl()}/chat/completions -H 'content-type: application/json' -H 'x-agent-cwd: <abs project dir>' \\
  -d '{"model":"gpt-6-astra","messages":[{"role":"user","content":"<self-contained task>"}]}'
Omit x-agent-cwd for a plain question with no file access. The other agent sees none of your context, so write a self-contained task. Verify what it returns before relying on it.`;
}
