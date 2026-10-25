# Platform support

## Accepted direction — 2026-10-25

macOS keeps the native SwiftUI/AppKit application. Linux and Windows will share a web-based interface connected
to the same Node engine. This records the product direction, not a claim that either new platform works today.
The first web client uses browser ES modules in `ui/app/`, served by the engine at `/app`.
Desktop shell/packaging is not selected. Browser-only distribution
is not decided; local CLI and filesystem access still require the local engine.

## Architecture

- Keep provider adapters, sessions, orchestration, tools and persistence in the shared engine (`src/`).
- Reuse its REST, SSE and terminal WebSocket contracts across clients; do not duplicate provider logic in a UI.
- Keep macOS native. Build the Linux/Windows client against the current native behaviour and design language.
- Isolate platform-dependent process management, terminal handling, credentials, paths, browser discovery,
  computer control, installation and updates behind explicit platform capabilities.
- Show unsupported capabilities truthfully. A working shared API does not establish OS or provider support.
- Retain Node as the shared engine direction; evaluate any future Swift migration against all three platforms.

## Delivery sequence

1. Add Linux and Windows engine CI; audit shell assumptions, executable discovery, PTYs, process shutdown,
   paths and credential storage. Fix portability failures before claiming engine support.
2. Select the client framework and distribution shell using a canvas, streamed chat, terminal and editor spike.
   Check performance, accessibility, keyboard handling and local-engine lifecycle on both operating systems.
3. Implement canvas, agents, chat, approvals, terminal, IDE and settings with shared API contracts.
4. Verify all providers on each OS, then complete packaging, updates and platform integrations.

## Current verification

| Area | macOS | Linux | Windows |
|---|---|---|---|
| Desktop interface | Existing native app | `/app` web client ported from native; OS browser verification pending | `/app` web client ported from native; OS browser verification pending |
| Engine CI | Existing macOS workflow | Full engine suite, required | Full engine suite, required |
| Browser discovery | macOS paths present | Some Linux paths present; not verified by this audit | Not verified |
| Computer control | Existing native helper | No verified implementation | No verified implementation |
| Packaging and updates | Existing Mac scripts | AppImage and .deb (x64, arm64), electron-updater; CI runs the package | NSIS installer (x64, Arm), electron-updater; CI runs the package |

These are source-inspection findings, not fresh runtime tests. Track provider-specific checks in
[provider-support.md](provider-support.md). Do not mark platform parity complete until real connections and
user-facing workflows have been exercised.

## First implementation increment

The canvas shell and IDE terminal now use one platform selector: the user's POSIX shell when set, otherwise
zsh on macOS or sh on Linux; Windows uses ComSpec/COMSPEC or cmd.exe. A real PTY smoke test checks command output
and exit status on the host OS. Linux CI runs the full engine suite under Xvfb; Windows CI currently runs only
this platform test file, not the full engine suite. Neither job establishes real-provider compatibility.

Remaining portability work includes Windows npm shims/prefix layout, CLI executable discovery, POSIX shell
commands and process-group termination, Python virtualenv paths, sign-in browser hooks, credential storage,
computer control and packaging. The next increment below introduces the shared web preview.

### Local validation — 2026-10-25

- macOS: full engine suite 297 passed; after fixing test Git identities, the affected suites plus platform
  checks passed again (14 tests). Native app build succeeded.
- Linux: Node 22 Debian Bookworm container, full engine suite 291 passed, 6 skipped, 0 failed. Three browser
  tests require Chrome, two SQL tests require sqlite3, and the native computer-helper test is macOS-only.
- The Git fixtures now set repository-local identities so IDE commits do not rely on a developer's global config.
- Windows has not been run locally. The CI jobs are added but have not been dispatched or observed remotely.
- These checks do not verify desktop packaging, the future web client, or real provider connections.

## Web client — 2026-10-25 (second pass)

`/app` serves `ui/app/`, rewritten as a module-by-module port of the native app (the table in
`ui/app/README.md` maps each module to its Swift file). The canvas is painted with the same drawing code as
`GraphDraw.swift` on a 2D canvas; chats, terminals, panels and docks are DOM laid over the nodes the way
`TerminalLayer.swift` lays native views. Screenshots of native snapshots (`TAKSIM_SNAPSHOT`) and the web page at
1200×800, on the same demo engine, match in layout, geometry (same fit scale and node positions), colours in
IntelliJ Dark and Light, and type sizes.

Ported: header (brand, sidebar key, usage gauges and panel, connection dot, show all, settings with the kept-tool
badge, the + Agent key with its folder and CLI menus); tab strip (order, rename, lock, close several, undo the
close, overflow paging, all-tabs menu, branch control with sets); the canvas (dot grid, cards, logo tiles, meta
line, status dots and outlines, title keys, fold, helpers, computer key, groups with notes, links with labels and
pulses, waiting lines, pan, zoom, pinch, marquee selection and the group key, four-corner resize, drag with group
membership feedback, rename in place, context menus, delete); chats (messages, Markdown, streaming, activity,
tasks, queue with edit and reorder, questions, plan card and plan dock with quote-to-chat, changes card with
review, undo and redo, go back to a message's checkpoint, side and new chats, search, export, @ context, /
commands, image paste and drop, mode, permission and model/effort menus, context gauge); terminals over nodes
with a free spot found when one opens; agent sheet; sidebar with history (search, sections, group/sort, continue,
drag onto canvas or tab, delete); ⌘K palette; settings (general, appearance theme cards, accounts with install,
sign-in terminal, API key, rename, delete, Local models and servers, plugins market/installed, connections,
shortcuts); tool panels (approval, inputs, buttons, every brick: table, log, stat, kv, markdown, json, chart,
timeline, bars, scene; source audit, editor, keep with its flight, remove with undo, offered tools); IDE dock
(the engine's IDE page, docked, resized, folded, maximized); group notes with versions and keeper; notifications;
first-run welcome; English and Turkish (from the native tables).

Engine changes for it: the folder picker now opens the OS dialog on Linux (zenity or kdialog) and Windows
(PowerShell FolderBrowserDialog), and the browser can show a chat's attached image back
(`GET …/attachments?path=`, only files in that canvas's attachment folder).

Still different or open:
- The IDE dock is the engine's web IDE page; the native dock is its own SwiftUI IDE.
- No launch animation (the mark's opening); no scene movie export or scene editor; no computer control (macOS
  helper only); a Gemini account's private sign-in window opens as a normal tab.
- The native app's window chrome (traffic lights, menu bar, Dock badge) has web stand-ins: the page title counts
  working agents; shortcuts use ⌘ or Ctrl.
- Desktop packaging, auto-update and installers for Linux and Windows are not chosen yet.

Verification: on macOS Chrome, with the fake provider only — `test/web-app.test.mjs` (assets, module imports,
shared scene model, attachment route, and a browser run: + Agent, chat with safe rendering, a question answered,
drag saved, theme switch, a real PTY in a node, reload), plus automated and side-by-side visual comparisons of
every chat, AI and agent surface against native snapshots (`TAKSIM_SNAPSHOT`).
- Full SF Symbols vector coverage added to `ui/app/icons.mjs` matching native `Image(systemName:)` glyphs.
- Chat message headers, toolbar, task list, queue, plan cards, changes/review cards, question cards, and agent sheet verified in side-by-side visual capture with native SwiftUI app.
- Tests passing: `npm test` (302/302), `swift test --filter TaksimKitTests` (57/57), `node --test test/web-app.test.mjs` (4/4). Linux and Windows browsers and real provider sessions on those systems remain unverified.


## Electron development app

Run `npm run desktop` to open the shared UI in an Electron window. It connects to the local engine
on port 8787, starting it with the current Node runtime if needed. `TAKSIM_URL` selects an already
running local engine; `TAKSIM_CANVAS` selects a canvas. `npm run desktop -- --choose-folder` opens
the system directory chooser on launch. Cancel leaves the canvas unchanged.

The sandboxed renderer exposes only a directory-picker bridge and the menu bar (labels in, commands out), both
validated against the main app frame. On macOS the menu bar is the native app's (`TaksimApp.commands`: New canvas
⌘T, the Canvas menu, Help › Intro and accounts) in the app's language, and ⌘W closes the window as it does
natively. The window, Dock and favicon use the native app icon (`ui/app/icon.png`, copied by
`scripts/sync-native.mjs`).

The canvas reads the wheel as `GraphView.scrollWheel` does: a mouse wheel zooms (4% per line), ⌘ and pinch zoom,
a trackpad's two fingers pan. A browser has no `hasPreciseScrollingDeltas`, so the device is read from Chromium's
numbers: a trackpad's `wheelDelta` is exactly three times its whole-pixel delta, a Mac wheel's delta is lines × 40
with a fixed-point fraction, elsewhere whole notches of 120. Checked with Electron's synthetic wheel events on
macOS; a physical mouse on Linux and Windows is unverified.

Sheets are modal `<dialog>`s, so the rest of the page is inert behind them; menus, tooltips, the model list, rename
fields and toasts opened over a sheet join the top layer inside it (`ui.mjs` `float`), as AppKit menus sit above a
sheet.
The picker uses Electron's native dialog on macOS, Linux and Windows. Native macOS retains NSOpenPanel.
External HTTP(S) links open in the system browser.

### Packaged app — 2026-10-25

`npm run desktop:dist` and the release's `desktop` job package the app with the engine and a Node runtime inside
(see [releasing.md](releasing.md)). `desktop/engine.cjs` starts that engine as `ServerLauncher.swift` does: the
login shell's environment on macOS and Linux (CLIs installed through nvm or `~/.local/bin` are found from a
launcher), Electron and Claude Code session variables left out, another program on 8787 moves it to a free port
(kept in `engine.json`), one window per engine (a second launch focuses it). Quitting stops the engine through
`/v1/restart`, which now ends it the same way on Windows (no signals there); if the app dies, the engine notices
its parent is gone (`TAKSIM_PARENT_PID`) and stops within two seconds.

Engine changes for Windows (`src/platform.mjs`): programs are found through PATHEXT; npm's `.cmd` shims run their
script with the engine's Node (Node cannot start a `.cmd` without a shell); other batch files go through
`cmd.exe /d /s /c` with cross-spawn's quoting; children start without console windows; a process tree is stopped
with `taskkill /T` (Windows has no process groups); `/bin/sh -c` commands use `cmd.exe` there; a merged
environment keeps one `PATH`.

Verified (2026-10-26): every package passes `package-smoke.mjs` (engine from the bundled Node, chat, real
terminal, quit) on its own system in CI before it ships: Linux x64 and arm64, Windows x64; the macOS arm64 build
locally. The released `.deb` and AppImage were installed from GitHub on a bare Debian and run the same way, which
found the `.deb` missing ALSA (fixed in 0.2.1; the release now installs the `.deb` on bare Debian and Ubuntu 24.04
and checks every library loads). The whole engine suite passes on Windows in CI and is required (macOS-only tests
skip). Still unverified: real providers on Linux and Windows (signing in, running Claude Code, Codex, Gemini) and
Windows on Arm, which no runner starts.

Electron now integrates native window controls into the existing 40px app toolbar: macOS traffic
lights on the left and Windows/Linux title-bar overlay on the right. Empty toolbar space is draggable;
action controls are excluded from dragging. Verified the macOS appearance and Electron drag-region
styles; Windows/Linux overlay appearance still requires verification on those systems.

## Rendering performance

View notifications in the shared web/Electron client are coalesced per animation frame; event listeners
and message accumulation still run for every event. Canvas breathing is scheduled only for visible
agents in both Electron/web and native macOS. Canvas-list polling does not overlap requests and pauses
while the web document is hidden, resuming on the next four-second polling interval.

The browser regression test delivers 100 text events across microtasks: all 100 reach listeners and
text storage, with one view notification. An offscreen running agent produces zero additional draws
over the measured 250 ms settling interval. These are targeted workload checks, not a general CPU or
battery-life benchmark. All providers share this rendering path.
