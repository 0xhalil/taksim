import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import claude from "../src/backends/claude.mjs";
import codex from "../src/backends/codex.mjs";

test("Claude: the context is the latest request as the API measured it, against the model's window", () => {
  const st = { usage: { input: 0, output: 0 } };
  const ev = (usage) => ({ type: "assistant", message: { usage } });
  claude.parse(ev({ input_tokens: 2, cache_read_input_tokens: 19996, cache_creation_input_tokens: 17755, output_tokens: 4 }), st, () => {});
  claude.parse(ev({ input_tokens: 5, cache_read_input_tokens: 37751, cache_creation_input_tokens: 300, output_tokens: 40 }), st, () => {});
  // a sub-agent's request doesn't count
  claude.parse({ ...ev({ input_tokens: 900000 }), parent_tool_use_id: "t1" }, st, () => {});
  claude.parse({ type: "result", result: "ok", usage: {}, modelUsage: { "claude-haiku": { contextWindow: 1000000 } } }, st, () => {});
  assert.deepEqual(st.context, { used: 38096, window: 1000000 });
});

test("Codex: the context comes from the session's own log", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  try {
    const dir = join(home, "sessions", "2026", "10", "14");
    mkdirSync(dir, { recursive: true });
    const line = (last, window) => JSON.stringify({ type: "event_msg", payload: { type: "token_count",
      info: { total_token_usage: { input_tokens: 108610 }, last_token_usage: { input_tokens: last, output_tokens: 66 }, model_context_window: window } } });
    writeFileSync(join(dir, "rollout-2026-10-14T16-39-38-abc.jsonl"), [line(1000, 475000), '{"type":"other"}', line(25560, 475000), ""].join("\n"));
    const st = { session: "abc" };
    codex.afterRun(st, { CODEX_HOME: home });
    assert.deepEqual(st.context, { used: 25626, window: 475000 });
    const none = { session: "missing" };
    codex.afterRun(none, { CODEX_HOME: home });
    assert.equal(none.context, undefined);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
