import AppKit
import SwiftUI
import TaksimKit

// taksim, native. The engine is the Node server for now (../src): the app reuses one already running on the
// port, else starts it, and stops the one it started when it quits. TAKSIM_URL points it at another server
// (e.g. a demo one), TAKSIM_ROOT at another checkout.

final class AppDelegate: NSObject, NSApplicationDelegate {
    var launcher: ServerLauncher?
    weak var store: CanvasStore?

    func applicationWillFinishLaunching(_ notification: Notification) {
        EditorResources.load()
        if ProcessInfo.processInfo.environment["TAKSIM_SELFTEST"] == "1" { EditorResources.selfTest() }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // built as a SwiftPM executable: make it a regular app with a Dock icon and menu bar
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        // no window state restoration: AppKit would keep snapshotting the window's image as the canvas changes,
        // and a window restored as closed left the app empty (nothing to start the engine and the canvas)
        for w in NSApp.windows { w.isRestorable = false }
    }

    func applicationShouldSaveApplicationState(_ app: NSApplication) -> Bool { false }
    func applicationShouldRestoreApplicationState(_ app: NSApplication) -> Bool { false }
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        // closed tabs waiting out their undo moment are deleted before the engine stops
        MainActor.assumeIsolated { store?.purgeNow() }
        launcher?.stop()
    }

}

@main
struct TaksimApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @State private var model = AppModel()
    @AppStorage("theme") private var theme = ThemeChoice.system.rawValue

    var body: some Scene {
        Window("taksim", id: "main") {
            ContentView(model: model)
                .frame(minWidth: 720, minHeight: 480)
                .background(WindowTweaks())
                .task { delegate.launcher = model.launcher; model.onStarted = { delegate.store = $0 }; await model.start() }
                .onAppear { applyTheme() }
                .onChange(of: theme) { applyTheme() }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1440, height: 900)
        .restorationBehavior(.disabled) // always opens, never comes back closed
        .commands {
            CommandGroup(replacing: .help) {
                Button(L("Intro and accounts")) { model.showWelcome = true }
            }
            CommandGroup(replacing: .newItem) {
                Button(L("New canvas")) { Task { await model.store?.newCanvas() } }.keyboardShortcut("t")
            }
            CommandMenu(L("Canvas")) {
                Button(L("Command palette")) { model.paletteOpen = true }.keyboardShortcut("k", modifiers: .command)
                Button(L("Agent navigator")) { model.showNavigator.toggle() }.keyboardShortcut("a", modifiers: [.command, .shift])
                Button(L("Show all")) { model.fitRequest += 1 }.keyboardShortcut("0")
                Divider()
                ForEach(1..<10) { n in
                    Button(L("Tab %d", n)) { model.selectTab(n - 1) }.keyboardShortcut(KeyEquivalent(Character(String(n))))
                }
            }
        }

        Settings { SettingsView(model: model).onChange(of: theme) { applyTheme() } }
    }

    // the whole app follows the choice, so the dynamic JetBrains colors resolve for it
    private func applyTheme() {
        let choice = ThemeChoice(rawValue: theme) ?? .system
        ThemeState.shared.choice = choice
        NSApp.appearance = choice.appearance
    }
}

/// Starts the engine, then the store; what the window shows while that happens.
@MainActor @Observable
final class AppModel {
    var store: CanvasStore?
    var failure: String?
    var showNavigator = false
    /// the opening plays on top of the window until the logo has landed in the header
    var showLaunch = Opening.plays
    var paletteOpen = false
    @ObservationIgnored var notifier: AgentNotifier?
    /// the settings section to show when the settings window opens next
    var settingsSection: SettingsSection?
    /// Settings › Hesaplar starts adding an account for this CLI when it opens
    var addAccountFor: String?
    var showWelcome = !UserDefaults.standard.bool(forKey: "welcomed") || ProcessInfo.processInfo.environment["TAKSIM_WELCOME"] == "1"
    @ObservationIgnored var focusAgent: (String) -> Void = { _ in }
    var fitRequest = 0
    var sheet: AgentSheetContext?
    @ObservationIgnored var viewCenter: () -> CGPoint = { .zero }
    @ObservationIgnored var openTerminal: (String, Bool) -> Void = { _, _ in }
    let launcher: ServerLauncher?
    /// the engine's address; the launcher's may move off a port another program holds
    private(set) var base: URL
    /// the engine on the port started from older code than the checkout has: the header offers ↻
    var engineStale = false
    var restartingEngine = false

    init() {
        let env = ProcessInfo.processInfo.environment
        if let u = env["TAKSIM_URL"], let url = URL(string: u) {
            base = url
            launcher = nil
        } else {
            let asked = Int(env["TAKSIM_PORT"] ?? "")
            let kept = UserDefaults.standard.integer(forKey: ServerLauncher.portKey)
            let l = ServerLauncher(port: asked ?? (kept > 0 ? kept : 8787), root: ServerLauncher.defaultRoot(), movable: asked == nil)
            base = l.baseURL
            launcher = l
        }
    }

    /// looks now and every minute whether the engine is older than the code on disk
    func watchEngine() {
        guard let launcher else { return }
        Task { @MainActor [weak self] in
            while let self {
                self.engineStale = await launcher.isStale()
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    /// ↻: a new engine from the code on disk; the canvas reconnects to it
    func restartEngine() {
        guard let launcher, !restartingEngine else { return }
        restartingEngine = true
        Task { @MainActor in
            do { try await launcher.restart() } catch { store?.error = error.localizedDescription }
            engineStale = await launcher.isStale()
            restartingEngine = false
            if let s = store, let id = s.currentId { await s.reconnect(id) }
        }
    }

    /// the engine didn't start: once more, from the spinner
    /// the store is up (at launch, or after a retry): the app delegate keeps it for quitting
    @ObservationIgnored var onStarted: (CanvasStore) -> Void = { _ in }

    func retryStart() async {
        guard failure != nil, store == nil else { return }
        failure = nil
        await start()
    }

    func start() async {
        // TAKSIM_SNAPSHOT_CANVAS=canvas.json: draw that canvas without a server and write it to TAKSIM_SNAPSHOT
        // (compares the native canvas with the web's /ui/nodes.html on the same data)
        let env = ProcessInfo.processInfo.environment
        if let file = env["TAKSIM_SNAPSHOT_CANVAS"], let path = env["TAKSIM_SNAPSHOT"],
           let data = FileManager.default.contents(atPath: file), let c = try? JSONDecoder().decode(Canvas.self, from: data) {
            let s = CanvasStore(api: APIClient(base: base))
            s.load(c)
            let dark = env["TAKSIM_SNAPSHOT_DARK"] == "1"
            let size = NSSize(width: Double(env["TAKSIM_SNAPSHOT_W"] ?? "") ?? 1200, height: Double(env["TAKSIM_SNAPSHOT_H"] ?? "") ?? 800)
            let graph = GraphView(frame: NSRect(origin: .zero, size: size))
            graph.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            graph.store = s
            graph.fit()
            if let sel = env["TAKSIM_SNAPSHOT_SELECT"] { graph.selected = Set(sel.split(separator: ",").map(String.init)) }
            graph.hoverId = env["TAKSIM_SNAPSHOT_HOVER"]
            // TAKSIM_SNAPSHOT_LINK=<to agent id>: the pointer on the arrow its creator drew to it
            if let to = env["TAKSIM_SNAPSHOT_LINK"] { graph.hoverLink = s.links.first { $0.to == to && $0.kind == "created" } }
            if let rep = graph.bitmapImageRepForCachingDisplay(in: graph.bounds) {
                graph.cacheDisplay(in: graph.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
            }
            NSApp.terminate(nil)
            return
        }
        do {
            try await launcher?.ensure()
            if let launcher { base = launcher.baseURL }
            watchEngine()
            // a released app: new versions and announcements from GitHub Releases
            if let launcher {
                Updater.shared.stopEngine = {
                    var req = URLRequest(url: launcher.baseURL.appending(path: "/v1/restart"))
                    req.httpMethod = "POST"; req.timeoutInterval = 3
                    _ = try? await URLSession.shared.data(for: req)
                    launcher.stop()
                }
            }
            Updater.shared.start()
            let s = CanvasStore(api: APIClient(base: base))
            store = s
            onStarted(s)
            notifier = AgentNotifier(model: self, store: s)
            Task { await s.loadChoices() } // ready before the first + Ajan
            // TAKSIM_CANVAS=id: open that canvas (a snapshot of a demo server doesn't touch the remembered one)
            await s.start(prefer: env["TAKSIM_CANVAS"] ?? UserDefaults.standard.string(forKey: "canvas"))
            snapshotIfAsked(s)
            if let path = ProcessInfo.processInfo.environment["TAKSIM_SNAPSHOT_SHEET"] { snapshotSheet(s, path) }
            // TAKSIM_SNAPSHOT_MODELS=/path.png with TAKSIM_SNAPSHOT_BACKEND=codex: the model list under the model well
            if let path = ProcessInfo.processInfo.environment["TAKSIM_SNAPSHOT_MODELS"] {
                AgentSheet.snapshotModels(s, backend: ProcessInfo.processInfo.environment["TAKSIM_SNAPSHOT_BACKEND"] ?? "claude", to: path)
            }
            if let path = ProcessInfo.processInfo.environment["TAKSIM_SNAPSHOT_SETTINGS"] { snapshotSettings(path) }
            if let path = ProcessInfo.processInfo.environment["TAKSIM_SNAPSHOT_PALETTE"] { snapshotPalette(s, path) }
            if let path = ProcessInfo.processInfo.environment["TAKSIM_SNAPSHOT_WELCOME"] { snapshotWelcome(path) }
            if let path = ProcessInfo.processInfo.environment["TAKSIM_SNAPSHOT_LAUNCH"] { snapshotLaunch(path) }
            if let path = ProcessInfo.processInfo.environment["TAKSIM_SNAPSHOT_IDE"], let id = ProcessInfo.processInfo.environment["TAKSIM_SNAPSHOT_AGENT"],
               let c = s.currentId, let a = s.agents[id] {
                IDEWindows.snapshot(base: s.api.base, canvas: c, agent: a, to: path)
            }
            // TAKSIM_TABCYCLE=1: switch tabs every 2 s and log how long each switch takes (performance checks)
            if ProcessInfo.processInfo.environment["TAKSIM_TABCYCLE"] != nil {
                Task { @MainActor in
                    for i in 0..<12 {
                        try? await Task.sleep(for: .seconds(2))
                        let c = s.visibleCanvases[(i + 1) % s.visibleCanvases.count]
                        let t0 = CACurrentMediaTime()
                        await s.open(c.id)
                        let t1 = CACurrentMediaTime()
                        await Task.yield()
                        print(String(format: "tab %@: open %.0f ms, %d agents", c.name, (t1 - t0) * 1000, s.currentAgents.count)); fflush(stdout)
                    }
                }
            }
            // TAKSIM_SNAPSHOT_NOTE=/path.png with TAKSIM_SNAPSHOT_GROUP=<id>: a group's note, written to a PNG
            if let path = ProcessInfo.processInfo.environment["TAKSIM_SNAPSHOT_NOTE"], let gid = ProcessInfo.processInfo.environment["TAKSIM_SNAPSHOT_GROUP"] {
                let host = NSHostingView(rootView: GroupNoteView(store: s, gid: gid))
                let w = NSWindow(contentRect: NSRect(x: -3000, y: 0, width: 420, height: 340), styleMask: [.borderless], backing: .buffered, defer: false)
                w.contentView = host
                w.appearance = NSAppearance(named: ProcessInfo.processInfo.environment["TAKSIM_SNAPSHOT_DARK"] == "1" ? .darkAqua : .aqua)
                w.orderFrontRegardless()
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(2.5))
                    w.setContentSize(host.fittingSize)
                    try? await Task.sleep(for: .milliseconds(300))
                    guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return }
                    host.cacheDisplay(in: host.bounds, to: rep)
                    try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
                }
            }
            if let b = ProcessInfo.processInfo.environment["TAKSIM_QUICKADD"] { addAgent(backend: b.isEmpty ? nil : b, folder: folderChoices().first ?? "") }
        } catch {
            failure = error.localizedDescription
        }
    }

    /// TAKSIM_SNAPSHOT=/path.png: renders the tab strip and canvas to a PNG (and logs what the store holds),
    /// for checking the UI without looking at the screen
    func snapshotIfAsked(_ s: CanvasStore) {
        let env = ProcessInfo.processInfo.environment
        guard let path = env["TAKSIM_SNAPSHOT"] else { return }
        if let t = env["TAKSIM_SNAPSHOT_THEME"], let c = ThemeChoice(rawValue: t) { ThemeState.shared.choice = c }
        let delay = Double(env["TAKSIM_SNAPSHOT_DELAY"] ?? "") ?? 2
        let dark = env["TAKSIM_SNAPSHOT_DARK"] == "1"
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(delay))
            print("snapshot: \(s.canvases.count) canvases, current \(s.currentId ?? "-"), \(s.currentAgents.count) agents, \(s.groups.count) groups, connected \(s.connected)"); fflush(stdout)
            NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            let tabs = ImageRenderer(content: TabStrip(store: s).frame(width: 1200, height: 36).background(JB.panel)
                .environment(\.colorScheme, dark ? .dark : .light).environment(\.isSnapshot, true))
            tabs.scale = 2
            let header = ImageRenderer(content: HeaderBar(model: self).frame(width: 1200, height: 40)
                .environment(\.colorScheme, dark ? .dark : .light).environment(\.isSnapshot, true))
            header.scale = 2
            // TAKSIM_SNAPSHOT_USAGE=/file.png: the header gauges' popover (a popover itself can't be drawn)
            if let f = env["TAKSIM_SNAPSHOT_USAGE"] {
                await s.loadChoices()
                let r = ImageRenderer(content: UsagePanel(store: s).environment(\.colorScheme, dark ? .dark : .light).environment(\.isSnapshot, true))
                r.scale = 2
                if let img = r.nsImage, let t = img.tiffRepresentation, let png = NSBitmapImageRep(data: t)?.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: f))
                }
            }
            // TAKSIM_SNAPSHOT_MOVIE=/file.mp4: the first scene view's timeline, written as a movie
            if let f = env["TAKSIM_SNAPSHOT_MOVIE"], let a = s.currentAgents.first(where: { $0.panel?.spec?.views.contains { $0.brick == "scene" } == true }),
               let v = a.panel?.spec?.views.first(where: { $0.brick == "scene" }) {
                let ctx = BrickContext(view: v, state: s.feeds.feed(a.id)[v.source], width: 600)
                if let e = env["TAKSIM_SNAPSHOT_SCENE_EDIT"] {
                    let r = ImageRenderer(content: SceneEditor(raw: v.raw, save: { _ in nil }, done: {}).environment(\.colorScheme, dark ? .dark : .light))
                    r.scale = 2
                    if let img = r.nsImage, let t = img.tiffRepresentation, let png = NSBitmapImageRep(data: t)?.representation(using: .png, properties: [:]) { try? png.write(to: URL(fileURLWithPath: e)) }
                }
                do { try await SceneMovie.write(ctx, dark: dark, to: URL(fileURLWithPath: f)) { _ in }; print("movie: ok") }
                catch { print("movie: \(error.localizedDescription)") }
                fflush(stdout)
            }
            // TAKSIM_SNAPSHOT_AUDIT=/file.png: where the first panel view's numbers come from (its popover)
            if let f = env["TAKSIM_SNAPSHOT_AUDIT"], let a = s.currentAgents.first(where: { $0.panel?.spec != nil }), let spec = a.panel?.spec,
               let v = spec.views.first(where: { $0.source != nil }), let src = v.source, let def = spec.sources[src] {
                let r = ImageRenderer(content: SourceAudit(name: src, def: def, state: s.feeds.feed(a.id)[src], heading: v.heading, refresh: {}, explain: { _ in })
                    .environment(\.colorScheme, dark ? .dark : .light).environment(\.isSnapshot, true))
                r.scale = 2
                if let img = r.nsImage, let t = img.tiffRepresentation, let png = NSBitmapImageRep(data: t)?.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: f))
                }
            }
            let graph = GraphView(frame: NSRect(x: 0, y: 0, width: 1200, height: 726))
            graph.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            graph.isSnapshotting = true
            graph.store = s
            // TAKSIM_SNAPSHOT_GHOST=agentId:toolId: offer that saved tool next to the agent, as tool_suggested does
            if let g = env["TAKSIM_SNAPSHOT_GHOST"]?.split(separator: ":"), g.count == 2,
               let t = try? await s.api.get("/v1/toolbox/\(g[1])", as: JSONValue.self) {
                s.suggest(String(g[0]), ToolCard(json: t))
            }
            // TAKSIM_SNAPSHOT_INJECT=file.json {agent, panel, data: {source: value}} (or a list of them): show
            // those panels locally
            if let f = env["TAKSIM_SNAPSHOT_INJECT"], let d = FileManager.default.contents(atPath: f), let j = try? JSONValue.parse(d) {
                for e in j.array ?? [j] {
                    guard let id = e["agent"]?.string, let p = e["panel"] else { continue }
                    var data: [String: SourceState] = [:]
                    for (k, v) in e["data"]?.object ?? [:] { data[k] = SourceState(data: v, updatedAt: Date().timeIntervalSince1970 * 1000) }
                    s.show(panel: Panel(json: p), data: data, on: id)
                }
            }
            // TAKSIM_SNAPSHOT_PANEL=agentId:collapsed|maximized: that panel's state, as its buttons would set it
            if let p = env["TAKSIM_SNAPSHOT_PANEL"]?.split(separator: ":"), p.count == 2 {
                s.panelUI(String(p[0]), collapsed: p[1] == "collapsed" ? true : nil, maximized: p[1] == "maximized" ? true : nil)
            }
            graph.fit()
            if let sel = env["TAKSIM_SNAPSHOT_SELECT"] { graph.selected = Set(sel.split(separator: ",").map(String.init)) }
            graph.hoverId = env["TAKSIM_SNAPSHOT_HOVER"]
            // TAKSIM_SNAPSHOT_LINK=<to agent id>: the pointer on the arrow its creator drew to it
            if let to = env["TAKSIM_SNAPSHOT_LINK"] { graph.hoverLink = s.links.first { $0.to == to && $0.kind == "created" } }
            // TAKSIM_SNAPSHOT_FOCUS=agentId: that node at 1:1 (or TAKSIM_SNAPSHOT_SCALE), near the top left
            if let id = env["TAKSIM_SNAPSHOT_FOCUS"], let a = s.agents[id] {
                graph.scale = CGFloat(Double(env["TAKSIM_SNAPSHOT_SCALE"] ?? "") ?? 1)
                graph.offset = CGPoint(x: 40 - graph.pos(a).x, y: 60 - graph.pos(a).y)
            }
            // TAKSIM_SNAPSHOT_OPEN=agentId: open its terminal as a click on ▶ would
            if let id = env["TAKSIM_SNAPSHOT_OPEN"] {
                graph.syncModes()
                s.toggleTerminal(id) { [weak graph] in graph?.terminalOpened(id, isNew: false) }
            }
            // TAKSIM_SNAPSHOT_IDEDOCK=agentId[:project|commit]: open its IDE as the node's </> would (which
            // pane the shot shows is set once the dock is up, below)
            if let v = env["TAKSIM_SNAPSHOT_IDEDOCK"], let id = v.split(separator: ":").first {
                s.openIDE(String(id))
            }
            // terminals connect and draw what the server sends first
            let host = NSWindow(contentRect: NSRect(x: -4000, y: 0, width: 1200, height: 726), styleMask: [.borderless], backing: .buffered, defer: false)
            host.contentView = graph
            host.orderFrontRegardless()
            graph.layoutTerminals()
            try? await Task.sleep(for: .seconds(2.5))
            graph.layoutTerminals()
            for (id, t) in graph.terminals {
                let term = t.box.term.getTerminal()
                let line = (0..<min(term.rows, 8)).map { r in term.getLine(row: r)?.translateToString(trimRight: true) ?? "" }.joined(separator: "|")
                print("term \(id): dark=\(t.box.dark.map(String.init) ?? "nil") \(term.cols)x\(term.rows) frame=\(t.box.frame) termframe=\(t.box.term.frame) lines=\(line)"); fflush(stdout)
            }
            // docked IDEs load their tree and files, then each one is drawn on its own (cacheDisplay of the canvas skips it)
            var ideShots: [String: NSImage] = [:]
            if !graph.ides.isEmpty {
                try? await Task.sleep(for: .seconds(Double(env["TAKSIM_SNAPSHOT_IDE_WAIT"] ?? "") ?? 3))
                graph.layoutPanels() // this view isn't the window's: it hears of changes only here, then loads them
                // the dock's left pane, as the stripe's click would leave it (the server state stays as it was)
                if let v = env["TAKSIM_SNAPSHOT_IDEDOCK"] {
                    let parts = v.split(separator: ":").map(String.init)
                    if let h = graph.ides[parts[0]] {
                        h.ide.panel = parts.count > 1 && parts[1] == "project" ? .project : .commit
                        h.ide.showLeft = true
                        await h.ide.refreshGit()
                    }
                }
                // TAKSIM_SNAPSHOT_IDEDIFF=agentId[:path]: show that changed file's Fark view, as its row's click would
                if let v = env["TAKSIM_SNAPSHOT_IDEDIFF"] {
                    let parts = v.split(separator: ":").map(String.init)
                    if let h = graph.ides[parts[0]] {
                        await h.ide.refreshGit()
                        let path = parts.count > 1 ? parts[1] : (h.ide.git?.files.first?.path ?? "")
                        if !path.isEmpty { await h.ide.openDiff(path) }
                        try? await Task.sleep(for: .seconds(1))
                    }
                }
                // TAKSIM_SNAPSHOT_IDEAI=agentId:inline|ask|review[:path]: the model features as their keys would leave them
                // (inline runs ⌘K on lines 1-2 of the path, ask asks the palette, review runs the commit window's bug button)
                if let v = env["TAKSIM_SNAPSHOT_IDEAI"] {
                    let parts = v.split(separator: ":").map(String.init)
                    if parts.count > 1, let h = graph.ides[parts[0]] {
                        let path = parts.count > 2 ? parts[2] : (h.ide.active ?? "")
                        switch parts[1] {
                        case "inline":
                            h.ide.open(path)
                            for _ in 0..<40 where h.ide.buffers[path] == nil { try? await Task.sleep(for: .milliseconds(50)) }
                            h.ide.startInline(path: path, from: 1, to: 2, instruction: "make it clearer", run: true)
                            try? await Task.sleep(for: .seconds(2))
                        case "ask":
                            h.ide.startGoToFile(asking: true)
                            await h.ide.ask("where is compute defined?")
                        case "review":
                            h.ide.panel = .commit; h.ide.showLeft = true
                            await h.ide.refreshGit()
                            await h.ide.review()
                        default: break
                        }
                    }
                }
                // TAKSIM_SNAPSHOT_IDETURN=agentId[:path]: a turn's own change (both sides read from its trees),
                // as a click on the chat's changed-file row does
                if let v = env["TAKSIM_SNAPSHOT_IDETURN"] {
                    let parts = v.split(separator: ":").map(String.init)
                    if let h = graph.ides[parts[0]], let c = s.currentId {
                        struct T: Decodable { var transcript: [JSONValue] }
                        if let t = try? await s.api.get("/v1/canvases/\(c)/agents/\(parts[0])/transcript?limit=200", as: T.self) {
                            // a message-path turn carries its changes on the answer itself; a terminal turn gets
                            // its own "changes" entry — either way, the last entry that changed something
                            let change = t.transcript.last { !($0["changes"]?.array ?? []).isEmpty }
                            let path = parts.count > 1 ? parts[1] : (change?["changes"]?.array?.first?["path"]?.string ?? "")
                            if let change, !path.isEmpty {
                                await h.ide.openDiff(path, old: change["checkpoint"]?.string, new: change["after"]?.string)
                                try? await Task.sleep(for: .seconds(1))
                            }
                        }
                    }
                }
                try? await Task.sleep(for: .seconds(1.5))
                graph.layoutPanels()
                for (id, h) in graph.ides where !h.isHidden && !h.area.isHidden {
                    h.area.layoutSubtreeIfNeeded()
                    guard let rep = h.area.bitmapImageRepForCachingDisplay(in: h.area.bounds) else { continue }
                    h.area.cacheDisplay(in: h.area.bounds, to: rep)
                    let img = NSImage(size: h.area.frame.size); img.addRepresentation(rep)
                    ideShots[id] = img
                    print("ide \(id): panel=\(h.ide.panel.rawValue) left=\(h.ide.showLeft) git=\(h.ide.git?.files.count ?? -1) staged=\(h.ide.stagedFiles.count) diff=\(h.ide.diff?.path ?? "-") rows=\(h.ide.diff?.rows.count ?? 0) notice=\(h.ide.notice?.text ?? "-") tabs=\(h.ide.tabs) active=\(h.ide.active ?? "-") error=\(h.ide.error ?? "-")"); fflush(stdout)
                }
            }
            guard let rep = graph.bitmapImageRepForCachingDisplay(in: graph.bounds), let top = tabs.cgImage, let head = header.cgImage else { return }
            graph.cacheDisplay(in: graph.bounds, to: rep)
            let out = NSImage(size: NSSize(width: 1200, height: 800))
            out.lockFocus()
            NSImage(cgImage: head, size: NSSize(width: 1200, height: 40)).draw(in: NSRect(x: 0, y: 760, width: 1200, height: 40))
            NSImage(cgImage: top, size: NSSize(width: 1200, height: 34)).draw(in: NSRect(x: 0, y: 726, width: 1200, height: 34))
            // terminals leave default cells transparent for their layer's color, which cacheDisplay doesn't draw
            NSColor(hex: dark ? 0x1E1F22 : 0xFFFFFF).setFill()
            NSRect(x: 0, y: 0, width: 1200, height: 726).fill()
            let gi = NSImage(size: graph.bounds.size); gi.addRepresentation(rep)
            gi.draw(in: NSRect(x: 0, y: 0, width: 1200, height: 726))
            // panels are SwiftUI, which cacheDisplay doesn't draw: each one rendered on its own, where it sits
            for (id, h) in graph.panels where !h.isHidden {
                // TAKSIM_SNAPSHOT_PANELS_LIVE=1: the panel's own hosting view, as the window draws it
                if env["TAKSIM_SNAPSHOT_PANELS_LIVE"] == "1", let rep = h.host.bitmapImageRepForCachingDisplay(in: h.host.bounds) {
                    h.host.cacheDisplay(in: h.host.bounds, to: rep)
                    let img = NSImage(size: h.host.bounds.size); img.addRepresentation(rep)
                    let f = h.frame
                    img.draw(in: NSRect(x: f.minX, y: 726 - f.maxY, width: f.width, height: f.height))
                    print("panel \(id) live frame=\(f) host=\(h.host.frame) fitting=\(h.host.fittingSize)"); fflush(stdout)
                    continue
                }
                let r = ImageRenderer(content: PanelRoot(model: h.model)
                    .environment(\.colorScheme, dark ? .dark : .light).environment(\.isSnapshot, true))
                r.scale = 2
                guard let img = r.cgImage else { continue }
                let f = h.frame
                NSImage(cgImage: img, size: f.size).draw(in: NSRect(x: f.minX, y: 726 - f.maxY, width: f.width, height: f.height))
                let feed = h.model.feed.sources.map { "\($0.key)=\(Bricks.compact($0.value.data).prefix(60))" }.joined(separator: " ")
                print("panel \(id): \(h.model.panel?.status ?? "ghost") frame=\(f) scale=\(h.model.scale) feed: \(feed)"); fflush(stdout)
            }
            for (id, h) in graph.ides where !h.isHidden {
                let f = h.frame
                if let shot = ideShots[id] {
                    let w = h.area.frame
                    shot.draw(in: NSRect(x: f.minX + w.minX, y: 726 - f.minY - w.maxY, width: w.width, height: w.height))
                }
                let r = ImageRenderer(content: IDEDockHeader(model: h.model)
                    .environment(\.colorScheme, dark ? .dark : .light).environment(\.isSnapshot, true))
                r.scale = 2
                if let img = r.cgImage {
                    let hh = h.header.frame.height
                    NSImage(cgImage: img, size: CGSize(width: f.width, height: hh)).draw(in: NSRect(x: f.minX, y: 726 - f.minY - hh, width: f.width, height: hh))
                }
                print("ide \(id): frame=\(f) shot=\(ideShots[id] != nil)"); fflush(stdout)
            }
            // SwiftUI chats, like the header and panels, need their snapshot fallback to be drawn explicitly.
            for (id, transcript) in graph.transcripts where !transcript.box.isHidden {
                let f = transcript.box.frame
                let renderer = ImageRenderer(content: ChatView(model: transcript.model, store: s)
                    .environment(\.colorScheme, dark ? .dark : .light).environment(\.isSnapshot, true)
                    .frame(width: f.width, height: f.height))
                renderer.scale = 2
                if let image = renderer.cgImage {
                    NSImage(cgImage: image, size: f.size).draw(in: NSRect(x: f.minX, y: 726 - f.maxY, width: f.width, height: f.height))
                }
                print("chat \(id): frame=\(f)"); fflush(stdout)
            }
            out.unlockFocus()
            if let tiff = out.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: path))
            }
        }
    }

    /// TAKSIM_SNAPSHOT_SHEET=/path.png: the new-agent sheet in an offscreen window, written to a PNG
    func snapshotSheet(_ s: CanvasStore, _ path: String) {
        let host = NSHostingView(rootView: AgentSheet(store: s, context: .add(at: .zero)) { _ in })
        let w = NSWindow(contentRect: NSRect(x: -3000, y: 0, width: 440, height: 640), styleMask: [.borderless], backing: .buffered, defer: false)
        w.contentView = host
        w.appearance = NSAppearance(named: ProcessInfo.processInfo.environment["TAKSIM_SNAPSHOT_DARK"] == "1" ? .darkAqua : .aqua)
        w.orderFrontRegardless()
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            host.layoutSubtreeIfNeeded()
            let size = host.fittingSize
            w.setContentSize(size)
            try? await Task.sleep(for: .milliseconds(300))
            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return }
            host.cacheDisplay(in: host.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
        }
    }

    /// TAKSIM_SNAPSHOT_SETTINGS=/path.png (TAKSIM_SNAPSHOT_SECTION=plugins…): the settings window, written to a PNG
    func snapshotSettings(_ path: String) {        let env = ProcessInfo.processInfo.environment
        let section = SettingsSection(rawValue: env["TAKSIM_SNAPSHOT_SECTION"] ?? "") ?? .general
        addAccountFor = env["TAKSIM_SNAPSHOT_ADD_ACCOUNT"]
        if let t = env["TAKSIM_SNAPSHOT_THEME"], let c = ThemeChoice(rawValue: t) { ThemeState.shared.choice = c }
        let host = NSHostingView(rootView: SettingsView(model: self, section: section))
        let w = NSWindow(contentRect: NSRect(x: -3000, y: 0, width: 900, height: Double(env["TAKSIM_SNAPSHOT_H"] ?? "") ?? 600), styleMask: [.borderless], backing: .buffered, defer: false)
        w.contentView = host
        w.appearance = NSAppearance(named: env["TAKSIM_SNAPSHOT_DARK"] == "1" ? .darkAqua : .aqua)
        w.orderFrontRegardless()
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(2.5))
            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return }
            host.cacheDisplay(in: host.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
        }
    }

    /// TAKSIM_SNAPSHOT_PALETTE=/path.png: the ⌘K palette over the current canvas, written to a PNG
    func snapshotPalette(_ s: CanvasStore, _ path: String) {
        let env = ProcessInfo.processInfo.environment
        let host = NSHostingView(rootView: CommandPalette(store: s, goToAgent: { _ in }, openTerminal: { _ in },
                                                           newAgent: {}, newCanvas: {}, toggleNavigator: {}, openSettings: { _ in }, close: {})
            .environment(\.colorScheme, env["TAKSIM_SNAPSHOT_DARK"] == "1" ? .dark : .light).environment(\.isSnapshot, true)
            .frame(width: 640))
        let w = NSWindow(contentRect: NSRect(x: -3000, y: 0, width: 640, height: 480), styleMask: [.borderless], backing: .buffered, defer: false)
        w.contentView = host
        w.appearance = NSAppearance(named: env["TAKSIM_SNAPSHOT_DARK"] == "1" ? .darkAqua : .aqua)
        w.orderFrontRegardless()
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            host.layoutSubtreeIfNeeded()
            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return }
            host.cacheDisplay(in: host.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
        }
    }

    /// TAKSIM_SNAPSHOT_WELCOME=/path.png: the welcome at TAKSIM_SNAPSHOT_AT seconds into its story;
    /// TAKSIM_WELCOME_LOGIN=<cli> also starts that CLI's sign-in, to show the login terminal
    func snapshotWelcome(_ path: String) {
        let env = ProcessInfo.processInfo.environment
        let host = NSHostingView(rootView: WelcomeView(model: self, autoLogin: env["TAKSIM_WELCOME_LOGIN"]).frame(width: 900, height: 700))
        let w = NSWindow(contentRect: NSRect(x: -3000, y: 0, width: 900, height: 700), styleMask: [.borderless], backing: .buffered, defer: false)
        w.contentView = host
        w.appearance = NSAppearance(named: env["TAKSIM_SNAPSHOT_DARK"] == "1" ? .darkAqua : .aqua)
        w.orderFrontRegardless()
        let at = Double(env["TAKSIM_SNAPSHOT_AT"] ?? "") ?? 6.5
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            let now = Date().timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: StoryView.loop)
            try? await Task.sleep(for: .seconds((at - now + StoryView.loop).truncatingRemainder(dividingBy: StoryView.loop)))
            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return }
            host.cacheDisplay(in: host.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
            print("welcome snapshot at \(at)"); fflush(stdout)
        }
    }

    /// TAKSIM_SNAPSHOT_LAUNCH=/path.png: the opening at each of TAKSIM_SNAPSHOT_AT's seconds (comma separated),
    /// one file per time (/path-<seconds>.png)
    func snapshotLaunch(_ path: String) {
        let env = ProcessInfo.processInfo.environment
        let times = (env["TAKSIM_SNAPSHOT_AT"] ?? "1.5").split(separator: ",").compactMap { Double($0) }
        let w = NSWindow(contentRect: NSRect(x: -3000, y: 0, width: 900, height: 600), styleMask: [.borderless], backing: .buffered, defer: false)
        w.appearance = NSAppearance(named: env["TAKSIM_SNAPSHOT_DARK"] == "1" ? .darkAqua : .aqua)
        Task { @MainActor in
            for t in times {
                // TAKSIM_SNAPSHOT_FLIGHT=1: the times are in the flight to a header mark at the top left
                let flight = env["TAKSIM_SNAPSHOT_FLIGHT"] != nil
                let host = NSHostingView(rootView: LaunchView(target: flight ? CGRect(x: 70, y: 14, width: 15, height: 15) : nil, finish: {},
                                                              at: flight ? nil : t, flightAt: flight ? t : nil).frame(width: 900, height: 600))
                w.contentView = host
                w.orderFrontRegardless()
                try? await Task.sleep(for: .milliseconds(500))
                guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { continue }
                host.cacheDisplay(in: host.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path.replacingOccurrences(of: ".png", with: "-\(t).png")))
            }
            print("launch snapshots"); fflush(stdout)
        }
    }

    /// the folders this canvas's agents work in, the latest first: what a new agent can be started in with one click
    func folderChoices() -> [String] {
        guard let store else { return [] }
        var seen = Set<String>(), out: [String] = []
        for a in store.currentAgents.sorted(by: { ($0.createdAt ?? 0) > ($1.createdAt ?? 0) }) {
            if let cwd = a.cwd, !cwd.isEmpty, seen.insert(cwd).inserted { out.append(cwd) }
        }
        return Array(out.prefix(6))
    }

    /// a new agent without a form, in a folder asked for first (an agent beside it may work elsewhere): the folder
    /// panel opens on the latest one, and Open starts the agent there
    func quickAdd(backend: String? = nil) {
        guard store != nil else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = L("Start here")
        if let last = folderChoices().first { panel.directoryURL = URL(fileURLWithPath: (last as NSString).expandingTildeInPath) }
        let start: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            self?.addAgent(backend: backend, folder: url.path)
        }
        if let window = NSApp.keyWindow { panel.beginSheetModal(for: window, completionHandler: start) } else { panel.begin(completionHandler: start) }
    }

    /// a new agent in the given folder ("" for none): the last model (or the given CLI's default) and the account last
    /// used with it, in the middle of the view, its native chat ready to type
    func addAgent(backend: String?, folder: String) {
        guard let store else { return }
        Task {
            // the choices are loaded when the app starts; wait only if they aren't there yet
            if store.models.isEmpty { await store.loadChoices() } else { Task { await store.loadChoices() } }
            let last = UserDefaults.standard.string(forKey: "lastModel") ?? "sonnet"
            var m = store.models.contains { $0.id == last } ? last : (store.models.first?.id ?? "sonnet")
            if let backend, store.backendOf(m) != backend {
                m = store.models.first { $0.owned_by == backend && ["sonnet", "gpt-6-astra", "opencode-go/glm-5.3", "fake-echo"].contains($0.id) }?.id
                    ?? store.models.first { $0.owned_by == backend }?.id ?? m
            }
            var fields: [String: Any] = ["model": m]
            if !folder.isEmpty { fields["cwd"] = folder }
            let acct = UserDefaults.standard.string(forKey: "lastAccount.\(store.backendOf(m))") ?? ""
            if store.accounts.contains(where: { $0.id == acct }) { fields["account"] = acct }
            let at = viewCenter()
            fields["pos"] = [at.x.rounded(), at.y.rounded()]
            // its login is signed out (a first run that skipped the accounts): the sheet signs it in, then creates
            if await AccountsModel.ready(api: store.api, backend: store.backendOf(m), account: fields["account"] as? String) == false {
                sheet = .add(at: at, model: m, cwd: folder)
                return
            }
            do {
                let a = try await store.addAgent(fields)
                UserDefaults.standard.set(m, forKey: "lastModel")
                agentAdded(a)
            } catch {
                sheet = .add(at: at) // couldn't start it: ask in full
            }
        }
    }

    /// Both the quick button and the detailed sheet open the same chat as an AI-created agent.
    func agentAdded(_ agent: Agent) {
        focusAgent(agent.id)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { ChatDrafts.shared.focus = agent.id }
    }

    func selectTab(_ i: Int) {
        guard let s = store, i < s.visibleCanvases.count else { return }
        let data = Data((UserDefaults.standard.string(forKey: "tabOrder") ?? "[]").utf8)
        let order = (try? JSONDecoder().decode([String].self, from: data)) ?? []
        let tabs = s.visibleCanvases.enumerated().sorted {
            (order.firstIndex(of: $0.element.id) ?? Int.max, $0.offset)
                < (order.firstIndex(of: $1.element.id) ?? Int.max, $1.offset)
        }.map(\.element)
        Task { await s.open(tabs[i].id) }
    }
}

/// the main window isn't restorable: no periodic window snapshots for state restoration
private struct WindowTweaks: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { Probe() }
    func updateNSView(_ v: NSView, context: Context) {}
    final class Probe: NSView {
        override func viewDidMoveToWindow() { window?.isRestorable = false; FirstClick.enable(on: window?.contentView) }
    }
}
