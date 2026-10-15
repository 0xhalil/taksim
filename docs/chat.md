# Chat in the card

What taksim's chat does, measured against Cursor's agent chat. The interface is native SwiftUI/AppKit; the behaviour
lives in the Node engine. Braun/Apple restraint and PyCharm colours apply throughout.

## Features

| Feature | In taksim |
|---|---|
| Queued messages | A small queue above the input: edit in place, remove, drag by the handle to reorder. Attachments are kept. A running turn and messages between agents can't be changed. |
| Search in a chat | Magnifier, field, count and two arrows. Searches text, attachment paths and changed files; the timeline isn't filtered, it scrolls to the match. Works over the last 500 entries. |
| Reuse an old message | Right click › Reuse: the request and its attachments go into the current draft; history and files stay. |
| Copy | An icon under an answer while the pointer is on it (a failed answer keeps its retry showing), right click on any message; code blocks keep their own copy button. |
| Export | ⋯ › Export as Markdown. The history is fetched again (up to 100,000 entries) with attachments, selected code and changed files. |
| Context | The `@` list: files, folders, selected code (⌘L) and past chats, picked with ↑/↓ and Enter/Tab. A stale file search can't overwrite newer text. |
| Reading while it streams | Scrolling up stops following; ↓ returns to the latest answer. |
| Side chat | ⋯ › Side chat, or the branch icon on an answer: a frozen reference of the conversation up to that entry, its own CLI session and its own card on the canvas, and a way back. It doesn't rewind files. |
| New chat | + or `/new`: the same model, account and folder, empty history, new session. |
| Agent / Ask / Plan | The mode below the input (⇧⇥, `/agent`, `/ask`, `/plan`). Ask and Plan use each backend's read-only permissions. Switching renews the session with new context; the visible history stays. Refused while a turn, a queue or an open terminal is active. Ask and Plan can't hand work to an editing agent, run panel commands or SQL processes; auto-approve can't get around that. |
| Plan dock | A proposed plan opens next to the card (after its panel and IDE) and pans and zooms with the canvas. Select a part and "Add to chat" quotes it into the input; the pencil edits in place, and "Apply plan" saves the edit as a new version and applies it. |
| Selecting text | Answers, your messages and code blocks are real text views: drag to select, double-click a word, ⌘C, right click. Dragging inside the chat no longer moves the card; the title bar does. |
| Small cards | A chat card is at least 320×260 and nothing spills out; narrow cards shorten the input hint and turn Review/Undo into icons. |
| Orchestrator | The "create agents" switch in the title bar (`/agents` in chat). **Off (default):** an agent creates agents only when the user asks. **On:** it may orchestrate but still does the work itself unless parts are truly independent or need another skill. Splitting goes through `plan_work`, whose rules the engine keeps ([src/canvas/orchestration.mjs](../src/canvas/orchestration.mjs)): at most 4 parts; **one writer** (at most one part changes files); nothing starts before the user presses Start; each part gets what the parts it depends on found; models are checked against what can run on this machine; a failed part asks the user (retry / skip / stop); when done the engine runs the job's checks itself and has an agent that never saw the conversation review the diff alone; the orchestrator wakes once, with every result. Measured in [eval/](../eval/README.md). |
| Long jobs | A job runs outside the turn that proposed it: `plan_work` returns at once and the result arrives as one message, because every CLI gives up on a tool call after 15 minutes. Approval has no time limit (the 3-hour limit starts at Start); you can talk to the orchestrator meanwhile but that turn can't change files; stopping the orchestrator stops its parts; a stopped or interrupted job shows "stopped" and ▶ resumes it without redoing finished parts. |
| Who waits for whom | One sign: a bright dashed line from the waiting agent to the one it waits for, and the waiting card's outline breathes in the waiting colour — for a pending question (`ask_agent`), an orchestrator whose parts are being done (`workingWith`) and an agent kept out of its folder by another writer (`blockedBy`). |
| If the user asks to split | Even with the switch off, "split this across agents" runs `plan_work`; the engine's rules still hold. "Split this function in two" isn't a request to split work. |
| What a card is | The title stays neutral. An orchestrator's people switch is lit (the accent) or faint; a read-only agent shows a small faint lock before its folder. Coloured capsules and word badges were tried and rejected. |
| Cursor's layout | The input like Cursor's: text on top; mode and model (and thinking level) bottom left; attach and the one action bottom right. Only copy sits under an answer; "branch from here" is in the right-click menu. |
| Editable plan | `propose_plan` offers a versioned Markdown document: edit in place, save to or open from the project, apply a chosen version once, revise a finished or failed plan. Stale versions are refused. |
| Clarifying questions | `ask_user` asks one to three questions with numbered choices (click one) and a line for an answer of one's own; Continue (⏎) when each has an answer. Plan mode's questions and the permission asks (Manual and Accept edits) come through the same card. The agent waits in a real tool call. |
| Live tasks | Codex `todo_list`, Claude `TaskCreate/TaskUpdate` and `TodoWrite`, opencode `todowrite/todoread`, Gemini `write_todos`, Copilot task events and taksim's `update_todos` feed one list: done / active / pending / cancelled, steps and a real count. Unfinished steps are never marked done because the turn ended. |
| Real tool activity | Every CLI's tool events become one `id/label/detail/status` shape, drawn as Cursor's plain muted lines (no card): the active step on one line, a chevron on hover opens the details, results kept with the answer. |
| Past chats as context | The chat icon in `@`: another agent's last 30 entries, resolved by the engine at send time and frozen into the message. No new task is sent to that agent. |
| Local commands | `/side`, `/new`, `/files`, `/export`, `/agent`, `/ask`, `/plan`. |
| Markdown | Headings, lists, task boxes, quotes, tables, rules; nested and unclosed code fences; no line numbers (as in Cursor's chat), horizontal scroll and folding after 24 lines. |
| Attachments | Click a chip to preview: path, selected source, image; open the file in the editor. |
| Change review | Review, or a file row in an answer, opens the turn's fixed diff: keep, undo and redo per file or hunk, persistent review marks, and a fix request sent with the hunk as reference. Undo stops with 409 on a file edited since; the Git index is untouched. |
| Persistent draft | Text and attachment references survive; a failed send gives the draft back. |
| Feedback | Focus and drop targets, sending/stopping states, the queue sliding in and out, copy confirmation; transitions respect Reduce Motion. |
| Retry and real usage | Retry on an error answer; input/output tokens as the CLI reports them. No estimated context percentage. |

### Verified with a real model (2026-10-14)

opencode CLI with the free `opencode/nemotron-3-ultra-free` model on a small Python project (a wrong cart total and a
discount code request). Passed: a single agent fixing the bug; not splitting when agents weren't mentioned, even with
the switch on; `plan_work` when asked to split (a reader, a writer and a reviewer, the engine's
`python3 -m unittest -q` check, review "ok"); stopping the writer and resuming with ▶. What these runs changed in the
engine: job parts can't be handed out with `create_agent` (the model had opened four agents despite the prompt); the
orchestrator is offered models of **signed-in** CLIs only; "Stop" on a failed part binds the orchestrator too, and the
report turn can't change files. Not yet tried with Claude, Codex, Gemini, Copilot or strong paid models.

## Modes

| Mode | How it works | Result |
|---|---|---|
| Agent | Explores the project, edits files, runs the fitting checks and fixes failures. | Changes, check results and turn diffs. |
| Ask | Reads the real sources and call paths; answers with file and line references. | An answer without code changes; a clarifying question when needed. |
| Plan | Explores first, asks on important decisions; plans the files, steps and checks. | An editable document, applied only when the user starts a chosen version. |

## Next

- Tool activity and task adapters for more CLIs.
- A context meter from what the CLI measures, not an estimate.
- Steering a running turn: not every CLI takes a message at a safe tool boundary; queueing stays.

## Sources

- [Cursor Agent: queue, checkpoints and chat search](https://cursor.com/docs/agent/overview)
- [Cursor Ask mode](https://prod.cursor.com/help/ai-features/ask-mode)
- [Cursor task notifications](https://prod.cursor.com/docs/cli/acp)
- [Cursor Plan mode](https://prod.cursor.com/docs/agent/plan-mode)

## Engine

- `GET …/agents/:id/queue` returns the person's queued messages; `PATCH` edits `{id, text, attachments?}` or orders
  `{order: [id, …]}`; `POST {id}` removes one. Changing a started, recorded or agent-to-agent message is a 409. The
  `chat_queue` event updates the app. Queued messages live in memory and don't survive a restart.
- `POST …/agents/:id/fork` creates a side chat: `{fresh: true}` starts empty; `{at, from, text}` picks an entry. A
  stale pick is a 409, a reference over 120,000 characters a 413.
- `PATCH …/agents/:id` with `{chatMode: "agent" | "ask" | "plan"}` switches access, session and history together.
  `GET …/agents/:id/activity` gives the running turn's activity; `chat_activity` events update the app.
- `GET …/agents/:id/workflow` returns the latest plan and pending question; `PATCH` edits a plan with a version check;
  `POST` takes `publish`, `save`, `build`, `revise`, `answer`; `chat_workflow` carries the live state.
- `update_todos({todos: [{id, content, status}], merge?})` works only in an active Agent turn: up to 40 tasks and one
  active step. `GET …/agents/:id/tasks` and `chat_tasks` follow it.
- `GET/POST …/agents/:id/review` works only on that chat's recorded checkpoint/after pairs; `POST
  {from,to,path,action,hunk?}`. Symlinks and submodules aren't written back. Outside a Git folder there are no
  checkpoints, so review isn't offered.

Per-provider coverage and open work: [provider-support.md](provider-support.md).
