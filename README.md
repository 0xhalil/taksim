<p align="center"><img src="native/Resources/AppIcon.png" width="128" alt="taksim"></p>

<h1 align="center">taksim</h1>

<p align="center">A live canvas for coding agents, on the subscriptions you already have.</p>

taksim is a native macOS app that runs the agent CLIs you are signed in to — **Claude Code, Codex, Gemini CLI,
opencode and GitHub Copilot** — as cards on a canvas. You talk to any of them; they ask each other questions, hand
off work, create helpers and build small live tools, and all of it happens where you can see it. No API keys: every
agent runs on your own login, on your own machine, and the engine listens on `127.0.0.1` only.

## Install

```bash
brew install --cask 0xhalil/taksim/taksim
```

Or download the latest `Taksim-<version>.zip` from [Releases](https://github.com/0xhalil/taksim-releases/releases),
unzip it and move `Taksim.app` to Applications. Releases are not notarized yet: the first time, right-click the app
and choose **Open**. The app updates itself from then on.

You need macOS 15 or later on Apple silicon, and at least one agent CLI installed and signed in
([Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex),
[Gemini CLI](https://github.com/google-gemini/gemini-cli), [opencode](https://opencode.ai),
[GitHub Copilot CLI](https://github.com/github/copilot-cli)). The welcome screen signs them in for you.

## What you get

- **The canvas.** Every agent is a card: its CLI's mark, its name, what it is doing. Drag, resize from any corner,
  double-click a title bar to fold a card to its bar. Agents an agent creates appear next to it with an arrow; messages
  between agents run along dashed lines. Tabs hold separate canvases.
- **Chat in the card.** Agent, Ask and Plan modes, `@` for files, folders, selections and past chats, a queue you can
  edit while the agent works, checkpoints before every turn, a per-turn diff of what changed and one-click undo.
- **The CLI itself.** Open a card's terminal and you are in the real Claude Code or Codex TUI — same session, slash
  commands and all. Close it and the agent carries on in the background.
- **Agents working together.** Over taksim's MCP server every agent can `list_agents`, `ask_agent`, `tell_agent` and
  `create_agent`, on any CLI and any of your accounts. Deadlocks are refused, depth and count are capped.
- **Panels.** An agent can build a live panel next to its card from ready-made bricks — tables, logs, stats, charts —
  fed by commands, files, URLs or its own data. Commands and outside reads run only after you approve them; files
  that hold credentials can never be read. Useful panels can be saved as tools and shared.
- **An IDE per agent.** A PyCharm-like dock with the agent's folder: project tree, editor, Git with commit and push,
  search, terminal, run, and a Python debugger the agent can read.
- **A browser.** Agents get `browser_*` tools: open pages, read them as a list of controls, click, hover, drag, type,
  pick, upload, answer dialogs, work inside iframes and across tabs, and look at screenshots. It is a visible Chrome
  window on a profile of taksim's own, so you watch what they do.
- **Groups.** Frames on the canvas share a note (goals, decisions, rules) with the agents inside them.
- **Accounts.** Several logins of the same CLI side by side (work and personal), each with its own config folder, and
  the plan usage of every login in the header.

## Build from source

```bash
git clone https://github.com/0xhalil/taksim && cd taksim
npm install                    # the engine's dependencies (Node 20+)
native/scripts/build-app.sh    # builds native/build/Taksim.app
open native/build/Taksim.app
```

The app starts the engine (`bin/taksim.mjs serve`) from the checkout it was built in, or connects to one already
running on port 8787. Xcode command line tools with Swift 6 are needed for the app.

| | |
|---|---|
| `npm test` | engine tests (`node:test`, a fake CLI backend — no subscription needed) |
| `cd native && swift test` | app tests |
| `npm start` | the engine alone, on `http://127.0.0.1:8787` |
| `TAKSIM_URL=http://127.0.0.1:8790 native/build/Taksim.app/Contents/MacOS/Taksim` | the app against another engine |
| `TAKSIM_FAKE=1 npm start` | an engine with deterministic test agents |

## The engine and its API

The engine is a Node server; the app is its only interface. It also exposes your subscriptions as an
OpenAI- and Anthropic-compatible API, where the model name picks the CLI:

```bash
curl -s 127.0.0.1:8787/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"Hello"}]}'
```

| Endpoint | |
|---|---|
| `POST /v1/chat/completions` | OpenAI format, streaming |
| `POST /v1/messages` | Anthropic format, streaming |
| `GET /v1/models`, `GET /health` | models of the installed CLIs; health |
| `/v1/canvases/…` | canvases, agents, messages, panels, IDE, groups (see `src/routes/`) |
| `/v1/accounts/…`, `/v1/usage` | logins and plan usage |

Headers switch a request into agent mode: `x-agent-cwd: /path/to/project` lets the CLI read, write and run commands
there; `x-agent-session`, `x-agent-effort`, `x-agent-permission` (Claude) and `x-agent-sandbox` (Codex, opencode)
tune it. `bypassPermissions` and `danger-full-access` are refused unless `TAKSIM_ALLOW_DANGEROUS=1`.

| Variable | Default |
|---|---|
| `TAKSIM_PORT`, `TAKSIM_HOST` | `8787`, `127.0.0.1` |
| `TAKSIM_TOKEN` | none; when set, requests must send it as `Authorization: Bearer` or `x-api-key` |
| `TAKSIM_HOME` | `~/.taksim` (canvases, accounts, the browser profile) |
| `TAKSIM_TIMEOUT_MS` | 30 minutes |
| `TAKSIM_<CLI>_CONCURRENCY`, `TAKSIM_<CLI>_MODEL`, `TAKSIM_<CLI>_BIN` | per CLI |

## Security

- The engine listens on `127.0.0.1` only. Listening elsewhere needs both `TAKSIM_ALLOW_REMOTE=1` and `TAKSIM_TOKEN`,
  and turns terminals off.
- Requests with a foreign `Host` or a browser `Origin` from another site are refused, so a web page can't drive your
  agents. Terminal WebSockets are accepted from the local app only.
- Panels and the IDE stay inside the agent's folder; `~/.ssh`, `~/.aws` and other credential stores are never read.
- Every subscription is yours and only yours: taksim is not a way to share an account with others.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Layout

```
native/          the macOS app (Swift, SwiftUI, AppKit); Sources/TaksimKit is the testable core
src/             the engine: server, CLI backends, canvases and agents, MCP tools, panels, IDE, browser, accounts
ui/              the IDE page the app shows in a web view (until the IDE is native)
toolbox/         built-in tools agents can start panels from
test/            engine tests
docs/            design language and feature notes
site/            the website
eval/            measuring whether agent orchestration pays off on real tasks
```

Contributions are welcome — read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

[PolyForm Shield 1.0.0](LICENSE): use, change and share taksim freely, at home or at work. You may not sell it or
offer a product that competes with it. Third-party code under `native/Vendor` and `ui/vendor` keeps its own license.
