// Anthropic: POST /v1/messages

import { randomUUID } from "node:crypto";
import { run } from "../runner.mjs";
import { sendJson, sse, SSE_HEADERS } from "../http.mjs";
import { textOf, buildPrompt } from "./common.mjs";

export async function anthropicMessages(req, res, body, ctx) {
  const system = Array.isArray(body.system) ? textOf(body.system) : body.system || "";
  const job = { model: ctx.model, system, prompt: buildPrompt(body.messages), opts: ctx.opts, signal: ctx.signal };
  const id = `msg_${randomUUID().replace(/-/g, "")}`;
  const model = body.model || ctx.model;

  if (body.stream) {
    res.writeHead(200, SSE_HEADERS);
    sse(res, { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [],
      stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } }, "message_start");
    sse(res, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start");
    try {
      const r = await run(ctx.backend, { ...job, onText: (t) =>
        sse(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }, "content_block_delta") });
      sse(res, { type: "content_block_stop", index: 0 }, "content_block_stop");
      sse(res, { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: r.usage.output } }, "message_delta");
      sse(res, { type: "message_stop" }, "message_stop");
    } catch (e) {
      sse(res, { type: "error", error: { type: "api_error", message: e.message } }, "error");
    }
    return res.end();
  }

  const r = await run(ctx.backend, job);
  sendJson(res, 200, {
    id, type: "message", role: "assistant", model,
    content: [{ type: "text", text: r.text }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: r.usage.input, output_tokens: r.usage.output },
  }, { "x-agent-session-id": r.session || "" });
}
