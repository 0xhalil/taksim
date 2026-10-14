// Local models: whatever an OpenAI-compatible server on this computer serves (Ollama, LM Studio, vLLM,
// llama.cpp), run as full agents by the Copilot CLI in offline mode (BYOK: no GitHub sign-in, no network).
// Models are "local:<id>", found by asking each server's /v1/models; TAKSIM_LOCAL_URL=url,url replaces the
// default servers (Ollama :11434, LM Studio :1234).

import { copilotBackend } from "./copilot.mjs";

const SERVERS = (process.env.TAKSIM_LOCAL_URL || "http://127.0.0.1:11434/v1,http://127.0.0.1:1234/v1")
  .split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
const PREFIX = "local:";
const REFRESH_MS = 30000;

const where = new Map(); // model id (without the prefix) -> server base url

async function discover() {
  const found = await Promise.all(SERVERS.map(async (base) => {
    try {
      const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(1500) });
      const j = await r.json();
      return (j.data || []).map((m) => [m.id, base]).filter(([id]) => id);
    } catch { return []; } // not running
  }));
  where.clear();
  for (const [id, base] of found.flat()) if (!where.has(id)) where.set(id, base);
  return [...where.keys()].map((id) => PREFIX + id);
}

const backend = copilotBackend({
  name: "local",
  models: [], // filled by init() and kept fresh: a server started later shows up within REFRESH_MS
  defaultModel: "",
  matches: (m) => m.startsWith(PREFIX),
  maxConcurrency: Number(process.env.TAKSIM_LOCAL_CONCURRENCY || 1), // one GPU

  async init() {
    this.models = await discover();
    setInterval(async () => { this.models = await discover(); }, REFRESH_MS).unref();
  },

  checkModel(model) {
    const id = model.slice(PREFIX.length);
    if (!where.has(id)) {
      return where.size
        ? `unknown local model "${id}"; see GET /v1/models`
        : `no local model server is running (looked at ${SERVERS.join(", ")})`;
    }
  },

  wire(model) {
    const id = model.slice(PREFIX.length);
    return { args: [], env: {
      COPILOT_OFFLINE: "true", COPILOT_PROVIDER_TYPE: "openai",
      COPILOT_PROVIDER_BASE_URL: where.get(id) || SERVERS[0], COPILOT_MODEL: id,
    } };
  },
});

export default backend;
