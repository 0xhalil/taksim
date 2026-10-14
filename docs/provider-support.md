# Provider support

This tracks how completely taksim offers what each provider can do. A connection working doesn't mean all of a
provider's features are covered. Update the tables and the open work with every new feature.

## Live tasks and tool activity

| Connection | Built-in task relay | Shared taksim task tool | Tool activity |
|---|---|---|---|
| Codex | `todo_list` events; completion boxes | `update_todos` | Commands, files, MCP and search |
| Claude | Successful `TaskCreate/TaskUpdate` and `TodoWrite` results | `update_todos` | Tool start, input and result |
| opencode | Successful `todowrite/todoread`; priorities kept | `update_todos` | The CLI's real tool part results, errors and running state when given |
| Gemini | Successful `write_todos`; `blocked` kept | `update_todos` | Matched tool start and result |
| Copilot | Full-list inputs of the older `update_todo/TodoWrite`. The newer SQL task signal carries no content, so it isn't relayed. | The agent's instructions publish progress with `update_todos` | `tool.execution_start/complete` |
| Local LLMs | The same event adapter, through the Copilot CLI | Needs a model that calls tools and a working Copilot offline connection; `update_todos` preferred | The same event adapter, through the Copilot CLI |

This task flow belongs to the native chat's active turn. Ask and Plan modes publish no implementation tasks. A
proposed change isn't applied before built-in tasks are confirmed. Unfinished steps aren't marked done because the
turn ended. The active step isn't guessed from task boxes. When opencode's JSON stream reports only a tool's result,
no start time or running duration is invented.

Verified by unit tests on each provider's official event formats, a fake CLI over a real child process / JSONL pipe,
MCP configuration checks for all six connections, and the native package tests. This isn't a run against the real
providers; end-to-end checks with each installed CLI version and a real local model are still open.

## Browser

All connections get the same `browser_*` tools over taksim's MCP server (`src/browser/`): a visible Chrome on
taksim's own profile, tabs of its own per agent, pages read as refs, screenshots as images. Click (left, right,
double), hover, drag (mouse-following and HTML drag and drop), type, pick from a `<select>`, upload files (only from
the agent's folder or the temp folder, never credential files), keys with modifiers, iframes including cross-site
ones, alert/confirm/prompt/leave-page dialogs, and tabs a page opens (they become the agent's active tab).
`test/browser.test.mjs` covers each of these against a real Chrome.

| Connection | Status |
|---|---|
| Codex | Verified with a real run (2026-10-14): navigated, clicked, saw and described the screenshot |
| Claude | Verified with a real run (haiku, 2026-10-14): same task, screenshot seen and described |
| opencode | Verified with a real run (`opencode-go/claude-haiku-5-5`, 2026-10-14): same task, screenshot seen and described; image results depend on the chosen model reading images |
| Gemini, Copilot, local | Same MCP tools; not yet checked with a real run (no signed-in CLI on the test machine) |

## Shared change review

Codex, Claude, opencode, Gemini, Copilot and local models use the same core checkpoint review. It doesn't depend on a
CLI feature; it needs a Git working folder and the saved before/after trees of a turn. File and hunk decisions
persist and the Git index isn't touched; undo is refused once a file has changed again. How each real model answers a
fix request still needs checking per model.

## Open work

- Relay Copilot's newer SQL task list through a reliable SDK/RPC read; don't build a list from the bare
  `session.todos_changed` signal.
- Bring task events of agents opened as terminals into the native chat.
- Verify task and tool flows with real CLI versions; check a local model's tool calling separately.
- Widen the inventory of provider features: question/permission flows, plan tools, steering a turn, session branches,
  context meters, sub-agents, image input and provider-specific settings. Judge each against official sources and a
  real connection; parity across these isn't there yet.
- Computer use (screen and input beyond the browser), hosted by the native app.

## Official sources

- [opencode CLI events, installed 1.18.32](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/cli/cmd/run.ts)
- [opencode todo tool](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/tool/todo.ts)
- [Gemini todo tool](https://geminicli.com/docs/tools/todos/)
- [Gemini JSON stream format](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/output/types.ts)
- [Copilot event schema](https://github.com/github/copilot-sdk/blob/main/nodejs/src/generated/session-events.ts)
- [Copilot tool names](https://docs.github.com/en/copilot/reference/hooks-reference)
