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

## Computer control

All connections get the same `computer_*` tools over taksim's MCP server (`src/computer/`), carried out by
`taksim-computer` (`native/Sources/TaksimComputer`), a small helper inside Taksim.app. The first call an agent makes
asks the person: the agent waits while a display key breathes on its node's title, and one click allows it. On that
click the app asks macOS for Screen Recording and Accessibility. The allowance stays with that agent until the key
or the node's menu turns it off. While macOS still refuses one of them, the key turns yellow and opens that System
Settings pane, and the tool's answer says what is missing. Ask and Plan agents only look: they get screenshot,
windows and read, and nothing that clicks or types.

| What | taksim tool | Anthropic `computer_toolset_20260801` | OpenAI `computer` | Gemini desktop |
|---|---|---|---|---|
| See the screen, any monitor | `computer_screenshot` (`display`) | screenshot | screenshot | take_screenshot |
| Zoom | `computer_screenshot` `region` | zoom | — | — |
| Wait | `computer_screenshot` `wait_s` | wait | wait | wait |
| Pointer position | in every screenshot's text | cursor_position | — | — |
| Click: left, right, middle, double, triple, with modifiers | `computer_click` | the click actions | click, double_click | the click actions |
| Press or release a button | `computer_click` `press` | left_mouse_down/up | — | mouse_down/up |
| Move, hover | `computer_move` | mouse_move | move | move |
| Drag | `computer_drag` | left_click_drag | drag | drag_and_drop |
| Scroll | `computer_scroll` | scroll | scroll | scroll |
| Type text (any layout) | `computer_type` | type | type | type |
| Keys and shortcuts, repeat, hold | `computer_key` (`repeat`, `hold_s`) | key, hold_key | keypress | press_key, hotkey, key_down/up |
| Windows, apps, monitors | `computer_windows` | — | — | — |
| An app's controls as text, with refs to click | `computer_read` (Accessibility tree) | — | — | — |
| Open an app, a file, a URL | `computer_open` | — | — | — |

Agents work in the pixels of their last screenshot, which is at most 1280 pixels wide. The engine maps those pixels
to screen points, on secondary monitors too.

| Connection | Built into the CLI | In taksim |
|---|---|---|
| Claude | Claude Code's own `computer-use` MCP server (macOS, research preview, Pro/Max, turned on in `/mcp`) | The shared tools. The CLI's own server is reachable in the agent's terminal (`/mcp`), and its approvals happen there. Not tried with a real run. |
| Copilot | `/computer on` (public preview since 2026-10-01) | The shared tools. `/computer` is reachable in the agent's terminal. Not tried with a real run. |
| Codex | Computer use is a plugin of the Codex desktop app. The CLI's docs don't mention it (not verified). | The shared tools. Not tried with a real run. |
| Gemini, opencode | None | The shared tools are the only way. Not tried with a real run. |
| Local models | — | Need a model that calls tools and reads images. Not tried. |

How it was verified:

- `test/computer.test.mjs` (with a stand-in helper) covers the ask, the allow, a decline, a timeout, persistence,
  coordinate mapping on several monitors, zoom, refs from reading, Ask/Plan limits and macOS refusals. A protocol
  check of the real helper runs when it is built.
- `ComputerControlTests` covers the store.
- On a demo engine, a fake-delegate agent asked, waited, was allowed and listed this Mac's real windows. Its
  screenshot, click and read came back with the Screen Recording and Accessibility explanation. Snapshots of the key
  were taken in both themes.

Still unchecked:

- A real screenshot or click with macOS permissions granted to Taksim.app. That needs the person to allow it.
- A real CLI and model using these tools.

Limits:

- macOS grants the permissions to the app that started the engine. An engine started from a terminal
  (`npm start`) uses that terminal's permissions.
- An ad-hoc signed dev build changes its signature on every build, so macOS may ask again after a rebuild.
- Holding a modifier alone across several calls (key_down/key_up) isn't offered. `computer_key` `hold_s` and
  `computer_click` `modifiers` cover holding inside one call.

## Shared change review

Codex, Claude, opencode, Gemini, Copilot and local models use the same core checkpoint review. It doesn't depend on a
CLI feature; it needs a Git working folder and the saved before/after trees of a turn. File and hunk decisions
persist and the Git index isn't touched; undo is refused once a file has changed again. How each real model answers a
fix request still needs checking per model.

## Local models

Taksim talks to a local model server itself (`src/backends/local.mjs`), as the server's own chat does: no CLI in
between and nothing changed about the model. A model whose server lists `tools` among its capabilities gets a light
tool loop run by the engine (`local-tools.mjs`: read, edit, list, write files in the agent's folder, run a command);
Manual and Accept edits ask in the chat as the CLIs' hooks do. The loop is sized to the window the server really opens
(Ollama's `/api/ps`, else 4096): the instructions and tools take at most a quarter of it (the command tool goes
first, then writing, listing), the newest conversation fills the rest, and earlier tool results shrink as a turn
grows. A model that keeps calling tools that aren't there, or with broken arguments, finishes the turn as a chat and
chats from then on. An answer a thinking model leaves only in its reasoning is said instead of nothing. Ollama is
spoken to through `/api/chat`; LM Studio, llama.cpp, vLLM and Jan through their OpenAI-compatible endpoint.

Checked 2026-10-25 on an M1 Pro with 16 GB and Ollama 0.40.10, `qwen3:1.7b` at Ollama's default 4096 window, task: a
Git folder whose `calc.py` subtracts in `add()`: three runs out of three fixed it with read and edit (12–31 s, 1.8k
tokens sent, 1.2 GB), leaving the rest of the file alone. What a small model got wrong on the way, and what the tools
now take: `offset: 0` and `limit: -1` for "the whole file", `old` copied with read_file's line numbers or without the
file's indentation, and rewriting a whole file it had misread (write_file creates new files only).

Before this, local models ran through the Copilot CLI offline (checked 2026-10-24): its prompt was about 20k tokens,
Ollama cut it to the last ~2k of its 4096 window without a word (`truncating input prompt limit=2050 prompt=20042`),
and the turn answered nothing. Codex `--oss` (a 24k prompt) described the fix without making it; opencode with an
Ollama provider sent no request in 5 minutes.

## Antigravity

Google ended Gemini CLI for personal Google accounts: since 2026-06-18 it answers "This client is no longer supported
for Gemini Code Assist for individuals" (`IneligibleTierError`), and taksim says so in plain words. Gemini CLI stays
for API keys, Vertex AI and Code Assist Standard / Enterprise. A Google AI Pro / Ultra plan now runs through the
Antigravity CLI (`agy`, `src/backends/antigravity.mjs`), signed in with the same Google login as the Antigravity app.

Checked 2026-10-25 with agy 1.4.7 on a signed-in Google AI Pro account:

| What | How | Checked |
| --- | --- | --- |
| Models and levels | `agy models`, read when the engine starts and with the model details; `<slug>-low/-medium/-high` become one `agy:<slug>` with its levels, sent as `--model <slug> --effort <level>` | Real run: Gemini 4 Argon, Gemini 3.8 Flash, Claude Opus / Sonnet 5.5, GPT-OSS 120B |
| Headless turns | `-p … --output-format stream-json`: `text_delta` steps stream, `result` gives the answer and usage | Real run: an agent wrote a file in its folder |
| Sessions | init's `conversation_id`; `--conversation <id>` resumes (an unknown id starts a new one) | Real run |
| taksim's tools | `--add-dir` a folder of taksim's whose `.agents/mcp_config.json` names its MCP server (`serverUrl`) and the agent's added servers; the person's project and `~/.gemini/config` stay untouched | Real run: `list_agents` from a canvas agent |
| Tool activity | tool `step_update`s (ACTIVE, DONE, ERROR) | Real events, unit test |
| Permissions | read-only and chats `--mode plan`; the rest `--dangerously-skip-permissions` | Real run. Manual / Accept edits aren't offered: headless agy can't ask and refuses instead, and its hooks aren't documented yet |
| Terminal | its TUI with `--model`, `--effort`, `--mode plan`, `--conversation`; a new one gets its instructions with `-i` | Opens on a real account; its first start shows agy's own setup (theme, Gemini import) once. No hooks, so taksim can't tell when a turn ends: queued messages wait for "send now", and a new terminal session's id isn't picked up |
| Accounts | this computer's login only (the keychain); who is signed in is read from agy's log | Real account |
| Install | Google's release server, checked against its SHA-512, into taksim's own `cli/bin` (no shell profile changes) | Not run from the app yet (installed here with Google's install.sh) |

Not there yet: the user's own MCP servers can't be turned off per agent (agy has one global list), a turn's denied
actions only show as text, and `/usage` quota isn't read into taksim's plan bars.

## Open work

- Relay Copilot's newer SQL task list through a reliable SDK/RPC read; don't build a list from the bare
  `session.todos_changed` signal.
- Bring task events of agents opened as terminals into the native chat.
- Verify task and tool flows with real CLI versions.
- Local models: the canvas's own tools (other agents, panels) through the light loop; a real run on LM Studio and
  llama.cpp; image input for models that take it.
- Gemini's permission hook: try it with a real run on a signed-in taksim Gemini account (an API key or Vertex AI one:
  personal Google logins moved to Antigravity).
- Antigravity: turn hooks for its terminal, Manual / Accept edits, plan quota in the usage bars.
- Widen the inventory of provider features: question flows, plan tools, steering a turn, session branches,
  context meters, sub-agents, image input and provider-specific settings. Judge each against official sources and a
  real connection; parity across these isn't there yet.
- Computer control: try it with a real run per CLI, and with permissions granted. Consider showing the agent's
  pointer on screen while it acts, and a global stop key.

## Permission modes (per node)

Auto, Manual and Accept edits on every CLI that runs headless; Bypass stays Claude's (with `TAKSIM_ALLOW_DANGEROUS=1`).
Manual asks before edits, commands, web fetches and other MCP tools; Accept edits lets edits through and asks about
the rest; reads and taksim's own tools never ask. Every question is the same chat card (Allow, Allow this kind in this
chat, Deny) from the same approve flow, and anything but a clear yes is a no.

| Connection | How it asks | Verified |
|---|---|---|
| Claude | `--permission-prompt-tool mcp__taksim__approve` | Real CLI: allow and deny |
| Codex | `PreToolUse` hook given with `-c` for the run, trusted for that run only by its hash (`hooks.state`), never with `--dangerously-bypass-hook-trust` | Real run (gpt-6-luna, 2026-10-16): allow wrote the file, deny didn't |
| Copilot | `preToolUse` in taksim's hook plugin (`--plugin-dir`); a hook decision holds under `--allow-all-tools` | Real run (2026-10-16): allow and deny |
| opencode | taksim's plugin (`OPENCODE_CONFIG_CONTENT` `plugin`), `tool.execute.before` throws on a no | Real run (deepseek-v4.1-flash-free, 2026-10-16): allow and deny; the model was told it was declined |
| Gemini | `BeforeTool` hook in the settings of taksim's Gemini accounts; the run uses `--approval-mode yolo` so the hook is the gate | Unit tests only: no signed-in Gemini on the test machine. Not offered on this Mac's own Gemini login, which runs without taksim's settings |

How it works: `src/term/permission-hook.mjs` (the hook the CLIs run, Node), `permission-adapters.mjs` (each CLI's
payload in Claude's words, and its answer format), `permission-plugin.mjs` (opencode), and
`POST /hooks/<agent token>/permission` on the engine. `test/permission-hook.test.mjs` covers the decisions, every
format and a real child process against a stand-in engine.

Limits:

- Codex runs an allowed command inside its sandbox as before: an approved `curl` still has no network under
  `workspace-write`.
- A hook that crashes or times out lets the call through on Codex, Gemini and Copilot (their rule, not taksim's); the
  timeout is a day, and a hook that can't reach taksim answers no.
- Terminal nodes (the CLIs' own TUIs) still ask in the terminal.
- Codex reads files with shell commands, so in Manual it asks about those too.

## Official sources

- [Claude Code computer use](https://code.claude.com/docs/en/computer-use), [Anthropic computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- [OpenAI computer use](https://developers.openai.com/api/docs/guides/tools-computer-use), [Codex app computer use](https://learn.chatgpt.com/docs/computer-use.md)
- [Gemini computer use](https://ai.google.dev/gemini-api/docs/computer-use), [Gemini CLI tools](https://geminicli.com/docs/reference/tools/)
- [Copilot computer use](https://docs.github.com/copilot/concepts/agents/computer-use), [opencode tools](https://opencode.ai/docs/tools/)

- [opencode CLI events, installed 1.18.32](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/cli/cmd/run.ts)
- [opencode todo tool](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/tool/todo.ts)
- [Gemini todo tool](https://geminicli.com/docs/tools/todos/)
- [Antigravity CLI](https://antigravity.google), `agy --help` and `agy help mcp` (1.4.7)
- [Gemini JSON stream format](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/output/types.ts)
- [Copilot event schema](https://github.com/github/copilot-sdk/blob/main/nodejs/src/generated/session-events.ts)
- [Copilot tool names](https://docs.github.com/en/copilot/reference/hooks-reference)
