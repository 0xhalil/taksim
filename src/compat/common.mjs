// Request plumbing shared by the OpenAI and Anthropic compatible endpoints.

import { CLAUDE_PERMISSIONS, SANDBOXES, EFFORTS } from "../config.mjs";
import { httpError } from "../http.mjs";
import { checkDir } from "../canvas/canvas.mjs";

export function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p.type === "text" ? p.text : p.type === "tool_result" ? textOf(p.content) : ""))
    .filter(Boolean)
    .join("\n");
}

// Flattens a chat history into a single prompt for a one-shot CLI run.
export function buildPrompt(messages) {
  const turns = messages.filter((m) => m.role !== "system");
  if (turns.length === 1) return textOf(turns[0].content);
  const history = turns.slice(0, -1)
    .map((m) => `<${m.role}>\n${textOf(m.content)}\n</${m.role}>`)
    .join("\n\n");
  const last = turns[turns.length - 1];
  return `<conversation_history>\n${history}\n</conversation_history>\n\n<${last.role}>\n${textOf(last.content)}\n</${last.role}>`;
}

// Options come from headers so standard OpenAI/Anthropic clients work unchanged.
// x-claude-* names are kept as aliases of x-agent-*.
export function optsFrom(headers) {
  const h = (k) => headers[`x-agent-${k}`] || headers[`x-claude-${k}`];
  return {
    cwd: h("cwd"),              // enables agent mode (tools / file access) in that directory
    session: h("session"),      // resume an earlier session (id returned in x-agent-session-id)
    effort: h("effort"),
    tools: h("tools"),          // claude: tool list in agent mode, e.g. "Read,Grep,Glob"
    permission: h("permission"),// claude: permission mode in agent mode (default acceptEdits)
    sandbox: h("sandbox"),      // codex/opencode/gemini: read-only or workspace-write
  };
}

export function validateOpts(o) {
  const bad = (name, v, allowed) => {
    if (v && !allowed.includes(v)) throw httpError(400, `${name} must be one of: ${allowed.join(", ")}`);
  };
  bad("permission", o.permission, CLAUDE_PERMISSIONS());
  bad("sandbox", o.sandbox, SANDBOXES());
  bad("effort", o.effort, EFFORTS);
  // agent mode runs a CLI with file access in cwd: same policy as canvas agents
  // (absolute, existing, outside logins/keys and system folders). checkDir throws 400.
  if (o.cwd) o.cwd = checkDir(o.cwd);
  if (o.session && !/^[\w-]+$/.test(o.session)) throw httpError(400, "invalid session id");
  return o;
}
