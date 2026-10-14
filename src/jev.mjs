// TypeSafe's Jev: a decision model. It writes no text; given a content and a question with fixed answers it
// returns a probability for each. Optional: with no key connected (Settings > Connections) none of this runs,
// the decide tool is not offered and nothing else changes. The key is read from the keychain, never sent
// anywhere but Jev's own endpoint.
//   POST {base}/v1/systemone  { model, state, questions: { id: { type, instructions, criteria } } }
//   -> { model, answers: { id: { choice, confidence, probabilities } | { noul } | { score, confidence } } }

import { createHash } from "node:crypto";
import { isConnected, readToken } from "./connectors.mjs";

const base = () => process.env.TAKSIM_JEV_BASE || "https://api.typesafe.ai";
const MODEL = () => process.env.TAKSIM_JEV_MODEL || "jev-latest";
const MAX_STATE = 24000; // chars; the API takes 32k tokens of state plus the longest question
const TIMEOUT_MS = 8000;
const cache = new Map(); // question hash -> { at, answer }; the same question gets the same answer for a while
const TTL_MS = 5 * 60 * 1000;

export const jevReady = () => isConnected("jev");

/** the API's own call: questions in, answers out; null when it can't answer (not connected, slow, refused) */
export async function ask(state, questions, { signal } = {}) {
  if (!jevReady()) return null;
  const token = await readToken("jev");
  if (!token) return null;
  const body = JSON.stringify({ model: MODEL(), state: typeof state === "string" ? state.slice(0, MAX_STATE) : state, questions });
  try {
    const res = await fetch(`${base()}/v1/systemone`, {
      method: "POST", body, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()).answers || null;
  } catch { return null; }
}

/**
 * One choice among named options: { choice, confidence, probabilities } or null.
 * `options` maps an option's name to what it means (or null).
 */
export async function pick({ state, instructions, options }) {
  const names = Object.keys(options || {});
  if (names.length < 2 || !instructions) return null;
  const key = createHash("sha1").update(JSON.stringify([state, instructions, options])).digest("hex");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.answer;
  const answers = await ask(state, { q: { type: "choice", instructions, criteria: options } });
  const a = answers?.q;
  if (!a || typeof a.choice !== "string") return null;
  const answer = { choice: a.choice, confidence: Number(a.confidence) || 0, probabilities: a.probabilities || {} };
  cache.set(key, { at: Date.now(), answer });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return answer;
}

/** a yes/no: the probability of yes (0..1), or null */
export async function yesNo({ state, instructions }) {
  const answers = await ask(state, { q: { type: "noul", instructions } });
  const n = answers?.q?.noul;
  return typeof n === "number" ? n : null;
}

export const _forget = () => cache.clear();
