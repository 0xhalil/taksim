# Web / Electron client (Linux and Windows)

The interface Linux and Windows share, served by the engine at `/app` and packaged for desktop via Electron. It is a port of the native macOS app
(`native/Sources/Taksim`), file by file, so both look and behave the same; each module names the Swift file it
follows. Browser ES modules, no build step, no remote assets.

## Standing principle: Strict parity and synchronized releases

- **Always in sync**: The native macOS app and the Electron/web client must always remain identical in architecture, behavior, and design.
- **Dual-target fixes & features**: Whenever a fix, UI tweak, or new feature is made in native, it must also be implemented in `ui/app/` (and vice-versa).
- **Synchronized releases**: Every version release must ship simultaneously for both native macOS and the Electron desktop application.


| Module | Native counterpart |
|---|---|
| `theme.mjs` | `Theme.swift` (tokens, Darcula, High Contrast), `Language.swift` (`L()`) |
| `icons.mjs` | `AppIcon.swift` (SF Symbols redrawn as outline paths) |
| `store.mjs` | `TaksimKit/CanvasStore.swift` |
| `graph.mjs`, `canvas.mjs` | `GraphView.swift`, `GraphDraw.swift`, `GraphCanvas.swift` |
| `bodies.mjs` | `TerminalLayer.swift` (terminals and chats over nodes) |
| `chat/` | `Chat/*.swift` |
| `header.mjs`, `tabs.mjs`, `branches.mjs` | `HeaderBar.swift`, `UsageViews.swift`, `TabStrip.swift`, `BranchControl.swift` |
| `sheet.mjs`, `navigator.mjs`, `palette.mjs` | `AgentSheet.swift`, `AgentNavigator.swift`, `CommandPalette.swift` |
| `settings.mjs`, `accounts.mjs` | `SettingsView.swift`, `ConnectionsPane.swift`, `LocalSettings.swift`, `Welcome.swift` (AccountsModel) |
| `panels.mjs`, `bricks/` | `PanelLayer.swift`, `PanelChrome.swift`, `PanelInputs.swift`, `SourceAudit.swift`, `Bricks/*.swift` |
| `docks.mjs`, `plan.mjs`, `groupnote.mjs` | `IDEDock.swift`, `Chat/ChatPlanDock.swift`, `GroupNote.swift` |
| `welcome.mjs`, `notifier.mjs` | `Welcome.swift`, `AgentNotifier.swift` |

Generated files: `logos.mjs`, `tr.mjs` and `shared/` come from the Swift sources and `src/bricks/`; run
`node ui/app/scripts/sync-native.mjs` after those change (a test fails when `shared/` is stale).

Run it: start an engine (`TAKSIM_HOME=/tmp/x TAKSIM_FAKE=1 TAKSIM_PORT=8790 npm start`) and open
`http://127.0.0.1:8790/app`; `?welcome` shows the first run again. The engine must run without `TAKSIM_TOKEN`.

Test: `node --test --test-timeout=90000 test/web-app.test.mjs` (the browser part needs Chrome and skips without
it). See `docs/platform-support.md` for what is verified and what is still open.
