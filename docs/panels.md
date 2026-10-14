# Panels: agents building their own tools from bricks

## Goal

We don't know in advance what an agent will work on: Kubernetes, Docker, Postgres, a CI pipeline, a log file, an HTTP
service or a team's own internal tool. So taksim doesn't ship one integration per domain; it ships **general
bricks**. An agent combines them to:

- gather data (command output, files, HTTP, its own findings),
- show it in a **panel** docked to its card,
- **watch** it in the background and wake up to interpret trouble,
- let the user hand it work from the panel.

Kubernetes is only an example; the same bricks build a Postgres slow-query board or a CI watcher.

## Three layers

```
3. Tools     saved, parameterised, shareable assemblies ("watch k8s", "postgres slow queries")
               ▲  the agent saves what it built: save_tool
2. Assembly  one panel's recipe: which sources, which views, which rules (JSON)
               ▲  the agent builds and changes it while working: panel_open / panel_patch
1. Bricks    taksim's built-in, small, general building blocks: source, parser, transform, view, rule, action
```

- **Bricks** are taksim's code: few, general and safe. Each describes its own schema; agents read the catalogue with
  `list_bricks`.
- **An assembly** is data the agent produces, not code. The agent writes no HTML or JS; it wires bricks together with
  JSON. So every backend (Claude, Codex, opencode, Gemini, Copilot) uses it the same way, and security checks stay in
  taksim.
- **A tool** is a saved assembly that worked: its parameters (which context, which database), notes for the next
  agent, sample data and the phrases that find it.

## The brick catalogue

| Kind | Bricks | Note |
|---|---|---|
| **Source** | `command` (once, polled with `every_s`, or `stream`), `tail` (a file), `http` (polled), `agent` (data the agent pushes with `panel_push`), `sql` | Commands run as argv arrays, never through a shell; the default directory is the agent's folder |
| **Parser** | `json`, `jsonl`, `lines`, `csv`, `columns` (space-aligned tables such as kubectl or docker output), `regex` (named groups) | Turns raw output into rows and fields |
| **Transform** | `pick` (a field path), `where`, `sort`, `limit` | Declarative; no `eval` |
| **View** | `table`, `log`, `stat`, `kv`, `markdown`, `json`, `chart`, `timeline`, `bars`, `scene` | Data is always printed as text; agent HTML never runs |
| **Action** | `ask` (a message to the agent with the row's context), `run` (a command, approved) | Bound to a row, a button or a form |

Adding a brick takes a few lines: an entry in `src/bricks/catalog.mjs` (schema and description), a runner in
`src/panels/panel.mjs` for a source, and a view under `native/Sources/Taksim/Bricks/` for a view. The catalogue grows
by itself and agents see the new brick in `list_bricks`.

## An example assembly

```jsonc
{
  "title": "Local services",
  "sources": {
    "ps":  { "brick": "command", "run": ["docker", "ps", "--format", "{{json .}}"], "parse": "jsonl", "every_s": 5 },
    "log": { "brick": "tail", "path": "logs/app.log",
             "parse": { "regex": "^(?<ts>\\S+) (?<level>\\w+) (?<msg>.*)$" } },
    "api": { "brick": "http", "url": "http://localhost:3000/health", "parse": "json", "every_s": 10 }
  },
  "views": [
    { "brick": "stat", "source": "api", "value": "status", "ok": "ok", "title": "API" },
    { "brick": "table", "source": "ps", "columns": ["Names", "Status", "Image"],
      "row_actions": [{ "label": "Why does it restart?", "brick": "ask", "text": "Look into the {Names} container" }] },
    { "brick": "log", "source": "log", "level": "level", "span": 2 }
  ]
}
```

**Postgres slow queries:** a `command` source runs `psql --csv -c "select query, mean_exec_time … from
pg_stat_statements"` every 30 seconds, shown as a `table` and a `chart`. **Kubernetes:** `kubectl get pods -o json`
with `pick: items`; `kubectl get events --watch-only -o json` as a `stream`.

The simplest panel has no sources at all: the agent pushes its findings to an `agent` source as `markdown` and `table`
— a report panel.

## The agent's tools

| Tool | What it does |
|---|---|
| `list_bricks` | The brick catalogue, schemas and short examples |
| `panel_open` | Opens an assembly (`spec`) as a panel; says when approval is pending |
| `panel_patch` | Changes an open panel: add, remove or change views, sources |
| `panel_push` | Pushes data to the `agent` source |
| `panel_read` | Reads the latest data of the panel's sources, instead of running the command again |
| `panel_close` | Closes the panel and stops its sources |
| `find_tools`, `use_tool`, `add_tool`, `save_tool`, `design_tool` | Find, start from, add and save tools (below) |

`panel_open` refuses a broken assembly and says what is wrong by the schema — an unknown brick, a missing field, a
view bound to a source that doesn't exist — and the agent corrects itself from that message. Panel tools carry
`readOnlyHint`: Claude Code runs read-only agents in plan mode, which only allows tools marked that way.

## Security

The agent can already run commands in its own CLI, but panel sources are different: they run **repeatedly and
unattended**, outside the agent's sandbox.

- **Approval.** A new command, a file outside the agent's folder, a URL other than `localhost` or a `run` action shows
  an approval strip with the exact argv, path or URL. The approval is bound to a hash of that part of the assembly:
  if `panel_patch` changes a command, approval is asked again; view changes need none. Sources that need no approval
  (the agent's own data, files in its folder, local URLs) start at once.
- **Auto-approve.** Each agent has an "approve panel commands automatically" setting (or "Always" on the approval
  strip). Only the user can turn it on; an agent can't turn it on for an agent it creates. Off by default.
- **Write actions.** A value coming from a row can't start with `-` in a `run` action. Read-only agents' assemblies
  can't contain `run`.
- **Running.** `execFile` and argv only, with time and output limits, process-group cancellation and a per-canvas
  limit on concurrent sources.
- **Never readable.** Files that hold credentials (`~/.ssh`, `~/.aws`, …) can't be read by any panel, approved or not.
- **Shared tools.** Someone else's tool shows the commands it runs before it joins your library; opened in an agent,
  its commands still wait for approval.

## Decisions

1. **Where a panel sits.** Docked to its agent's card, moving with it. Collapsed, it becomes a strip beside the card;
   open, it resizes from its corner; ⤢ maximises it. Size and state persist.
2. **People change panels through the agent.** ✎ (or right click › Edit panel…) lets you tell the agent what you
   want ("only show errors") so it applies `panel_patch`, or edit the JSON yourself; a spec you write needs no
   approval.

## Tools and the market

A panel that worked is saved as a **tool**: with its parameters, notes for the agent, sample data and the triggers
that find it.

- **Where they live:** `toolbox/*.json` are taksim's built-in tools (modelled on k9s, lazydocker, lnav, htop, duf and
  lazygit). `~/.taksim/toolbox/` is the user's library. The shared market is a GitHub repository every taksim reads;
  sharing writes to the user's own folder there (or opens a pull request from a fork).
- **Matching:** `src/toolbox/match.mjs` compares each message with the tools' triggers, keywords, commands and
  phrases learned from use, with prefix matching for Turkish suffixes and an alias table for synonyms; no model call.
  A tool is suggested when a message repeats one of its `when` phrases, or names its subject and backs it with a
  second word. Greetings, learned-only words and words common to every coding request never suggest a tool alone.
  Each tool is suggested to an agent once.
- **Triggers are written by AI:** the agent saving a panel writes its triggers with `save_tool`; when the user saves,
  a fast model writes them in the background (`TAKSIM_TRIGGER_MODEL`).
- **`design_tool`:** with no fitting tool, the agent finds the product that serves the need best (k9s, pghero,
  RabbitMQ's UI…), takes what its first screen shows, its alarms and its common actions, and turns them into a panel.
  The model product goes into the tool's `reference`.

## Next

- Rules and signals: `match`, `threshold`, `change`, `absent` rules that badge, highlight or wake the agent, behind
  dedupe, batching, an hourly per-agent turn limit and merging while the agent is busy — subscriptions have quotas.
- More bricks: `status_grid`, `graph`, `form`, `diff`, `window`, `count_by`; external MCP tools as sources; a
  sandboxed `html` brick without network access for the rare custom view.
