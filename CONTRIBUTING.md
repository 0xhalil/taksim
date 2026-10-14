# Contributing to taksim

Thanks for wanting to help. taksim is a native macOS app (`native/`, Swift) on a Node engine (`src/`); read
[CLAUDE.md](CLAUDE.md) for the rules of the codebase and [docs/design-language.md](docs/design-language.md) for how
the interface should look and behave. Both apply to people and to coding agents alike.

## Getting set up

```bash
npm install
native/scripts/build-app.sh && open native/build/Taksim.app
```

You need macOS 15+, Node 20+, Swift 6 (Xcode or its command line tools), and at least one agent CLI signed in for
real use. Tests don't need any subscription: the engine has a fake CLI backend (`TAKSIM_FAKE=1`).

```bash
npm test                    # engine
cd native && swift test     # app
```

To look at the app without touching your own data, run a demo engine and point the app at it:

```bash
TAKSIM_FAKE=1 TAKSIM_HOME=$(mktemp -d) TAKSIM_PORT=8790 npm start
TAKSIM_URL=http://127.0.0.1:8790 native/build/Taksim.app/Contents/MacOS/Taksim
```

## What makes a change land

- **It follows the design language.** Show, don't tell; one action per moment; motion that means something;
  JetBrains colours from the theme tokens. "Would it still be understood without the text?" is the first review
  question.
- **It covers every provider it can.** A feature that works for one CLI should be considered for all of them
  (Claude Code, Codex, Gemini CLI, opencode, Copilot, local models); say in
  [docs/provider-support.md](docs/provider-support.md) what was verified against a real CLI and what wasn't.
- **The interface is native.** No new web UI under `ui/`; the engine adds catalogue, validation and data, the app
  draws.
- **Text is translatable.** Interface text is `L("English")` with its Turkish in the `Tr` tables; text for agents
  (prompts, tool descriptions) is English.
- **Tests pass and new behaviour has tests.** Engine tests use `node:test` with the fake backend; app logic that can
  live in `TaksimKit` should, so it can be tested.
- **Code reads like the code around it** — same naming, same comment density, no new dependencies without a reason.

## Pull requests

Keep them focused: one feature or fix, with a short description of what changes for the user and how you checked it
(a screenshot for anything visible). Open an issue first for larger changes so we can agree on the shape.

By contributing you agree that your contribution is licensed under the project's
[PolyForm Shield 1.0.0](LICENSE) license.
