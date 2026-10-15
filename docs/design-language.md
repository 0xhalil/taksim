# taksim: design language

For anyone — person or agent — working on taksim's interface.

## 1. Main principle: like Braun and Apple

Technical work looks simple. Complexity is the system's problem, not the user's. A feature that doesn't follow this
isn't finished.

1. **Show, don't tell.**
   - No explanatory paragraphs, hint text or "click here".
   - Live previews, icons, colour, logos and motion carry the meaning.
   - Text is only names, numbers and one-word labels.
2. **One moment, one action.**
   - Each state has one action that stands out, like the single coloured key of the Braun ET66: ▶ open, bookmark,
     + add, share, group.
   - No two-button dialogs or confirmation forms. Do undoable things without asking.
3. **The right place, the right time.**
   - A suggestion appears when it is needed, next to the work.
   - A permission is asked on first use, not at install.
4. **Under the lid.**
   - Settings, triggers, JSON and details stay hidden (⋯, right click).
   - Only what is used every day sits on the front.
5. **It thinks for itself.**
   - The system fills in names, colours, triggers and settings.
   - The user can overwrite them; a name field arrives selected and ready to type.
   - Example: grouping fills in a name and colour, and 420 ms later the name opens for editing in place.
6. **Motion means something.**
   - Animation isn't decoration; it says where something came from and went.
   - Examples: a hidden panel flies to its toolbar icon, a group frame closes around its agents, a node pulled out
     of a group stretches like a band and either snaps free or springs back.
   - 0.3–0.8 s, springy. Motion never makes anyone wait.
7. **Direct manipulation.**
   - Drag and drop, editing in place (double-click a name) and resizing from corners.
   - No forms; the only exceptions are adding an agent and the Settings window.
8. **JetBrains colours** (below). No "AI slop": no beige-orange grounds, neon gradients or purple glow.
9. **Size is free.**
   - Every node resizes freely from its four corners, like LiteGraph (22 px handles). No magnets, size classes or
     "match size" buttons.

Before adding an interface, ask:
- Would it still be understood without the text?
- Which is the one action?
- Can the system fill this in itself?
- What does the motion say?

[tool-flow.html](tool-flow.html) shows the language at work.

### Tried and rejected (don't propose again)
- Screens full of explanatory text that look "technical".
- A three-square size picker, a "match the one next to it" button and size magnets.
- A dropdown next to a tab's name; tabs are already selectable.
- Coloured capsule badges with an icon and a word in a card's title ("Orchestrator", "Read-only"). Titles are
  neutral; a lit switch or a faint icon says what a card is.
- A header button that rebuilt the app from source: it meant nothing to a user. Released apps update themselves.

## 2. Colours: IntelliJ New UI

Two themes: IntelliJ Dark (default) and IntelliJ Light, plus Darcula and High Contrast in Settings. The sun/moon in
the header switches; until one is picked, the app follows the system.
- The tokens live in `native/Sources/Taksim/Theme.swift` (`JB`, SwiftUI) and `GraphDraw.swift` (`Pal`, the canvas).
- Never hard-code a new colour; add or use a token.

| token | dark | light |
|---|---|---|
| `bg` (ground, active tab, terminal) | `#1E1F22` | `#FFFFFF` |
| `panel` (header, tab strip, card body) | `#2B2D30` | `#F7F8FA` |
| `panel2` (hover, field ground) | `#393B40` | `#EBECF0` |
| `line` (borders) | `#43454A` | `#DFE1E5` |
| `ink` (main text) | `#DFE1E5` | `#1E1F22` |
| `text` | `#BCBEC4` | `#2B2D30` |
| `muted` (secondary) | `#868A91` | `#6C707E` |
| `accent` (the one accent, JetBrains blue) | `#3574F0` | `#3574F0` |
| `ok` / `warn` / `err` | `#5FB865` / `#F2C55C` / `#F75464` | `#208A3C` / `#B27A00` / `#DB3B4B` |
| `nodeHead` | `#323438` | `#F2F3F5` |
| `grid` (dot grid) | `#35373B` | `#DFE1E5` |

Rules:
- Titles are neutral. A brand colour (Claude `#C4552D`, Codex `#2B7A98`, opencode `#6A4FB3`, Gemini `#3A7D44`) lives
  only in a provider's small logo tile.
- Status colours are for meaning only: green good, yellow warning, red trouble.
- Shadow and blur are for depth, not decoration.

## 3. The parts

- **Window:** header 40 px, tab strip 36 px, the canvas below. The header leaves room for the traffic lights.
- **Header** (as calm as JetBrains' main toolbar): the agent navigator on the left; on the right only what is used
  every day — show all, settings — a divider, and the one blue action: "+ Agent", whose chevron picks another CLI.
  An update or an announcement appears there only while there is one; a red dot appears only when the engine
  connection drops.
- **Tabs:** 168 px wide; + sits next to the last tab and stays at the right when tabs overflow; tabs can be locked;
  drag to reorder, double-click to rename.
- **Canvas** (`GraphView`, `GraphDraw`, a Core Graphics take on LiteGraph):
  - Dot grid. A card's title bar is 30 px, corners 8.
  - The title bar: the provider's logo tile, the name (vertically centred on the bar), the title buttons
    (helpers switch, IDE, terminal). Buttons lighten under the pointer and dip in for a moment when pressed; a card
    under the pointer shows its edge.
  - Computer control's display key sits left of the fold button, and only while it matters. While an agent asks
    for the screen, it breathes with the waiting outline and one click allows it. While the agent has the screen,
    it is lit blue and flashes on each action; a click takes the screen back. It is yellow while macOS still
    refuses Screen Recording or Accessibility, and a click opens that System Settings pane. The node's menu has the
    same switch ("Computer control").
  - Body padding 10 px; the folder icon sits centred under the logo tile.
  - A card opens at 300×150, a terminal at 760×440; the smallest card is 220×80, the smallest terminal 480×280.
    Sizes snap to a 10 px grid.
  - Double-click a title bar to fold the card to a narrow bar (logo, name, buttons); its docked panel and IDE hide
    with it, and a tool waiting for approval lights the folded bar red.
- **Groups:** faint rounded frames; cards in a group get a solid colour rail on their left edge. A node is a member
  when its centre is inside the frame. Joining takes 650 ms; a new group's frame closes around its members in 900 ms.
  ⌘-drag draws a selection; ⌘G groups it.
- **Terminal:** opens in the card's body and pans and zooms with the canvas. On opening, the card moves to the nearest
  free spot and its groups grow to keep it.
- **Panels:** docked to the right of the card, built from bricks: table, log, stat, kv, markdown, json and an
  animated trio that explains like 3Blue1Brown — chart (live time series), timeline (durations and waits), bars
  (a ranking race). Tables are live too: rows slide to their new place, new rows enter from the left, removed rows
  fade where they were, changed cells flash, numbers count to their new value.

Motion values:
- A pulled node's wobble: `exp(-4t)·cos(2.6πt)`; the general easing curve: `1-(1-t)³`; a message pulse: 900 ms.
- Bricks: value changes 450 ms; a rescaling y axis follows with a 160 ms time constant; table rows 520 ms; bar order
  600 ms `cubic-bezier(.34,1.25,.64,1)`; a new row 380 ms; a cell flash 900 ms; a timeline bar grows from its start in
  600 ms. Reduce Motion turns them off.

## 4. The native app

- The interface is Swift, SwiftUI and AppKit. The engine is the Node server in `src/`; the app finds or starts it
  (a released app carries it, with its own Node, in `Contents/Resources/engine`). The engine is to move to Swift
  piece by piece.
- `TaksimKit/`: models, the REST client, the SSE event stream, `CanvasStore`, `ServerLauncher`, release and
  announcement logic. It has no UI and is where tests go.
- `Taksim/`: `GraphView` + `GraphDraw` (the canvas), `GraphCanvas` (menus, renaming in place, grouping),
  `TerminalLayer` (SwiftTerm over the engine's `/term` WebSocket), `HeaderBar`, `TabStrip`, `AgentSheet`, `Theme`,
  `Chat/`, `IDE/` (CodeEditSourceEditor), `Bricks/`, `Updater`. `Logos` is generated by `scripts/gen-logos.sh`.

**Verifying without a screen:**
- Run a demo engine on port 8790: `TAKSIM_FAKE=1 TAKSIM_HOME=$(mktemp -d) TAKSIM_PORT=8790 npm start`.
  Never touch a user's real engine on 8787 or its data.
- A snapshot of the app:
  ```bash
  TAKSIM_URL=http://127.0.0.1:8790 TAKSIM_SNAPSHOT=/tmp/x.png TAKSIM_SNAPSHOT_DARK=1 native/build/Taksim.app/Contents/MacOS/Taksim
  ```
  - More: `_SELECT=id,id`, `_HOVER=id`, `_FOCUS=id` (1:1 scale), `_OPEN=id` (opens its terminal),
    `_GHOST=agent:tool` (a tool suggestion), `_PANEL=agent:collapsed|maximized`, `_INJECT=file.json`
    (`{agent, panel, data}`, shown locally only). `TAKSIM_CANVAS=id` opens that canvas.
  - The docked IDE: `TAKSIM_SNAPSHOT_IDEDOCK=agent[:project|commit]`, `TAKSIM_SNAPSHOT_IDEDIFF=agent[:file]`,
    `TAKSIM_SNAPSHOT_IDETURN=agent[:file]`.
  - Other windows: `TAKSIM_SNAPSHOT_SHEET`, `_SETTINGS`, `_WELCOME`, `_USAGE`, `_PALETTE`.
  - If the window never opens when started from a terminal, use `open -n --env KEY=VALUE … native/build/Taksim.app`.
- Snapshots can't draw ScrollView or Menu; views use plain fallbacks under the `isSnapshot` environment value.

**Pitfalls:**
- URLSession's `lines` swallows the empty lines that end SSE events; split the bytes yourself.
- `cacheDisplay` doesn't draw SwiftUI or layer backgrounds; render SwiftUI parts with `ImageRenderer`.
- `textMatrix` isn't part of the graphics state; reset it after drawing or SwiftTerm's text shifts.
- Don't stop a test app with `pkill -f`; it closes the user's own window too. Stop only your own PID.
- During a zoom gesture, views over the canvas are scaled by AppKit (`GraphView.liveZoom`) and laid out once it ends;
  re-laying SwiftUI out on every step made zooming stutter.

## 5. Working rules

- The interface is English by default; Turkish is picked in Settings › Appearance › Language, more languages later.
  New text is `L("English")` with its Turkish in the `Tr` tables; PyCharm's proper names (Commit, Amend, Project,
  Branch, Terminal, Run, Debug) stay. The engine answers user-facing messages in the request's `Accept-Language`.
- Text for agents (system prompts, tool descriptions) is English.
- Write code with the comment density and naming of the code around it. The engine has no build step: plain ES
  modules.
