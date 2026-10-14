// OpenAI: POST /v1/chat/completions

import { randomUUID } from "node:crypto";
import { run } from "../runner.mjs";
import { sendJson, sse, SSE_HEADERS } from "../http.mjs";
import { textOf, buildPrompt } from "./common.mjs";

export async function openaiChat(req, res, body, ctx) {
  const system = body.messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n\n");
  const job = { model: ctx.model, system, prompt: buildPrompt(body.messages), opts: ctx.opts, signal: ctx.signal };
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model || ctx.model;

  if (body.stream) {
    res.writeHead(200, SSE_HEADERS);
    const chunk = (delta, finish = null) =>
      sse(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] });
    chunk({ role: "assistant", content: "" });
    try {
      const r = await run(ctx.backend, { ...job, onText: (t) => chunk({ content: t }) });
      chunk({}, "stop");
      if (body.stream_options?.include_usage) {
        sse(res, { id, object: "chat.completion.chunk", created, model, choices: [],
          usage: { prompt_tokens: r.usage.input, completion_tokens: r.usage.output, total_tokens: r.usage.input + r.usage.output },
          session_id: r.session });
      }
    } catch (e) {
      sse(res, { error: { message: e.message, type: `${ctx.backend.name}_error` } });
    }
    sse(res, "[DONE]");
    return res.end();
  }

  const r = await run(ctx.backend, job);
  sendJson(res, 200, {
    id, object: "chat.completion", created, model,
    choices: [{ index: 0, message: { role: "assistant", content: r.text }, finish_reason: "stop" }],
    usage: { prompt_tokens: r.usage.input, completion_tokens: r.usage.output, total_tokens: r.usage.input + r.usage.output },
    session_id: r.session, backend: ctx.backend.name,
  }, { "x-agent-session-id": r.session || "" });
}
