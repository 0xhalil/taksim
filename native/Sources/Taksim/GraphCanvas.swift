import AppKit
import SwiftUI
import TaksimKit

/// The canvas in the window: GraphView plus what app.mjs does around it (renaming in place, menus, deleting
/// with a question, grouping a selection, the bar over a selection, pulses on messages).
struct GraphCanvas: View {
    let store: CanvasStore
    let fitRequest: Int
    @AppStorage("showGrid") private var showGrid = true
    var addAgent: (CGPoint) -> Void = { _ in }
    var editAgent: (String) -> Void = { _ in }
    var center: (@escaping () -> CGPoint) -> Void = { _ in }
    var focus: (@escaping (String) -> Void) -> Void = { _ in }
    var opener: (@escaping (String, Bool) -> Void) -> Void = { _ in }

    var body: some View {
        // reading what the canvas shows makes SwiftUI redraw it when any of it changes
        // (streaming text isn't here: a token redraws only its card, through the event listener)
        let _ = (showGrid, ThemeState.shared.choice, store.agents, store.groups, store.links, store.currentId, store.ghosts)
        GraphRepresentable(store: store, fitRequest: fitRequest, showGrid: showGrid, addAgent: addAgent, editAgent: editAgent, center: center, focus: focus, opener: opener)
    }
}

private struct GraphRepresentable: NSViewRepresentable {
    let store: CanvasStore
    let fitRequest: Int
    var showGrid = true
    let addAgent: (CGPoint) -> Void
    let editAgent: (String) -> Void
    let center: (@escaping () -> CGPoint) -> Void
    let focus: (@escaping (String) -> Void) -> Void
    let opener: (@escaping (String, Bool) -> Void) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(store: store) }

    func makeNSView(context: Context) -> GraphView {
        let v = GraphView()
        v.clipsToBounds = true // terminals and panels never spill over the toolbar and tabs
        context.coordinator.view = v
        context.coordinator.addAgent = addAgent
        context.coordinator.editAgent = editAgent
        center { [weak v] in v?.viewCenter() ?? .zero }
        opener { [weak c = context.coordinator] id, isNew in c?.openTerminal(id, isNew) }
        focus { [weak v] id in v?.revealAgent(id) }
        v.store = store
        v.actions = context.coordinator.actions()
        store.onEvent = { [weak v] ev in
            v?.transcriptEvent(ev)
            if ev.type == "text_delta", let v, let id = (try? JSONDecoder().decode(DeltaID.self, from: ev.data))?.id,
               let a = store.agents[id] {
                v.setNeedsDisplay(v.screenRect(v.rectOf(a)).insetBy(dx: -4, dy: -4))
                return
            }
            guard let v, ev.type == "message",
                  let m = try? JSONSerialization.jsonObject(with: ev.data) as? [String: Any],
                  let from = m["from"] as? String, let to = m["to"] as? String,
                  let a = store.agents[from], store.agents[to] != nil else { return }
            v.pulse(from: from, to: to, color: Pal.backend(a.backend))
        }
        DispatchQueue.main.async { v.fit() }
        return v
    }

    func updateNSView(_ v: GraphView, context: Context) {
        let c = context.coordinator
        // another tab: its terminals and panels (kept from the last visit) come back as they were; no reconnecting
        if c.canvasId != store.currentId {
            if let old = c.canvasId { c.views[old] = (v.scale, v.offset) }
            c.canvasId = store.currentId
            v.selected = []
            v.switchedCanvas()
            // back where you left it, or the whole canvas the first time (once its agents are in)
            if let id = store.currentId, let seen = c.views[id] { v.scale = seen.0; v.offset = seen.1; v.needsDisplay = true; c.pendingFit = false }
            else { c.pendingFit = true }
        }
        if c.pendingFit, !store.currentAgents.isEmpty { c.pendingFit = false; v.fit() }
        v.syncModes()
        if c.fitRequest != fitRequest { c.fitRequest = fitRequest; v.fit(animated: true) }
        v.layoutTerminals()
        // redraw only when something the canvas draws changed (an agent's lastText under its open terminal,
        // termReady or a panel's data don't show on the canvas itself)
        let sig = v.drawnSignature(showGrid: showGrid)
        if sig != c.drawn { c.drawn = sig; v.kick() }
    }

    @MainActor
    final class Coordinator {
        var drawn = 0
        let store: CanvasStore
        weak var view: GraphView?
        var canvasId: String?
        var fitRequest = 0
        var views: [String: (CGFloat, CGPoint)] = [:] // each canvas's zoom and scroll, kept across tab switches
        var pendingFit = false
        var editor: NSTextField?
        var selbar: SelectionBar?
        var addAgent: (CGPoint) -> Void = { _ in }
        var editAgent: (String) -> Void = { _ in }

        init(store: CanvasStore) {
            self.store = store; canvasId = store.currentId
            // ⌘L added to an agent's chat: a node with neither terminal nor chat shows its chat
            chatObserver = NotificationCenter.default.addObserver(forName: ChatDrafts.wantsChat, object: nil, queue: .main) { [weak self] n in
                guard let id = n.object as? String else { return }
                MainActor.assumeIsolated {
                    guard let self, let a = self.store.agents[id], !a.isTerminalOpen else { return }
                    if a.chat != true, (a.createdBy ?? "user") == "user" { self.store.setChat(id, true) }
                    if n.userInfo?["reveal"] as? Bool == true {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in self?.view?.revealAgent(id) }
                    }
                }
            }
        }
        private var chatObserver: NSObjectProtocol?
        deinit { if let chatObserver { NotificationCenter.default.removeObserver(chatObserver) } }

        /// opens or closes an agent's terminal; an opened one is kept in view and focused
        func openTerminal(_ id: String, _ isNew: Bool) {
            store.toggleTerminal(id) { [weak self] in self?.view?.terminalOpened(id, isNew: isNew) }
        }

        func actions() -> GraphView.Actions {
            var a = GraphView.Actions()
            a.toggleTerminal = { [weak self] id in self?.openTerminal(id, false) }
            a.toggleCollapsed = { [weak self] id in
                guard let self, let ag = self.store.agents[id] else { return }
                self.store.setCollapsed(id, !ag.isCollapsed)
                self.view?.layoutTerminals() // its chat or terminal hides with the fold, and comes back with the unfold
                self.view?.needsDisplay = true
            }
            a.openGroupNote = { [weak self] gid, rect in self?.openGroupNote(gid, at: rect) }
            a.openIDE = { [weak self] id in self?.view?.toggleIDE(id) }
            a.toggleToolHelp = { [weak self] id in
                guard let self, let a = self.store.agents[id] else { return }
                self.store.setToolHelp(id, !a.toolsOn)
            }
            a.computerKey = { [weak self] id in self?.computerKey(id) }
            a.toggleHelpers = { [weak self] id in
                guard let self, let on = self.store.agents[id]?.delegate else { self?.store.setHelpers(id, true); return }
                self.store.setHelpers(id, !on)
            }
            a.renameAgent = { [weak self] id, rect in
                guard let self, let name = self.store.agents[id]?.name else { return }
                self.editInPlace(rect, name) { self.store.renameAgent(id, to: $0) }
            }
            a.renameGroup = { [weak self] gid, rect in self?.renameGroup(gid, rect) }
            a.deleteAgent = { [weak self] id in self?.deleteAgent(id) }
            a.menu = { [weak self] target, e, at in self?.menu(target, e, at) }
            a.selectionChanged = { [weak self] ids in self?.selectionChanged(ids) }
            a.groupSelection = { [weak self] in self?.groupSelection() }
            a.viewMoved = { [weak self] in self?.hideSelbar() }
            a.removePanel = { [weak self] id in self?.removePanel(id) }
            a.keepPanel = { [weak self] id in self?.keepPanel(id) }
            return a
        }

        /// the display key on a node: allows an agent that asks (macOS asks for its part then), opens the
        /// System Settings pane macOS still refuses, or takes the computer back
        func computerKey(_ id: String) {
            let c = store.computer[id]
            if let missing = c?.missing?.first {
                MacPermissions.request()
                MacPermissions.openSettings(for: missing)
                if c?.isAsking == true { store.setComputer(id, true) }
                return
            }
            if c == nil || c?.isAsking == true {
                MacPermissions.request()
                store.setComputer(id, true)
            } else {
                store.setComputer(id, false)
            }
        }

        // ---------- panels ----------

        private var notePopover: NSPopover?
        /// a group's shared note, beside its icon
        func openGroupNote(_ gid: String, at rect: CGRect) {
            guard let view else { return }
            notePopover?.close()
            let p = NSPopover()
            p.behavior = .transient
            p.animates = true
            p.contentViewController = NSHostingController(rootView: GroupNoteView(store: store, gid: gid))
            p.show(relativeTo: rect, of: view, preferredEdge: .maxY)
            notePopover = p
        }

        /// gone at once, no question: for a few seconds ↶ brings it back as it was (spec, size, fold)
        func removePanel(_ id: String) {
            guard let a = store.agents[id], let p = a.panel, let spec = p.spec else { return }
            store.removePanel(id)
            showUndo(title: spec.title) { [weak self] in
                guard let self else { return }
                Task {
                    try? await self.store.setPanelSpec(id, spec.json)
                    self.store.panelUI(id, collapsed: p.ui.collapsed, maximized: p.ui.maximized, size: p.ui.size)
                }
            }
        }

        private var undoBar: NSView?
        /// a small ↶ capsule at the bottom of the canvas, for six seconds
        func showUndo(title: String, undo: @escaping () -> Void) {
            guard let view else { return }
            undoBar?.removeFromSuperview()
            var bar: NSView?
            let host = NSHostingView(rootView: UndoCapsule(title: title) { undo(); bar?.removeFromSuperview() })
            bar = host
            host.frame.size = host.fittingSize
            host.frame.origin = CGPoint(x: (view.bounds.width - host.frame.width) / 2, y: view.bounds.height - host.frame.height - 18)
            host.autoresizingMask = [.minXMargin, .maxXMargin, .minYMargin]
            host.alphaValue = 0
            view.addSubview(host)
            undoBar = host
            NSAnimationContext.runAnimationGroup { $0.duration = 0.25; host.animator().alphaValue = 1 }
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak host] in
                guard let host else { return }
                NSAnimationContext.runAnimationGroup({ $0.duration = 0.3; host.animator().alphaValue = 0 }) { host.removeFromSuperview() }
            }
        }

        /// Keep: the panel becomes a tool in one press and flies into the tools icon (app.mjs keepPanel).
        func keepPanel(_ id: String) {
            guard let view else { return }
            if store.agents[id]?.panel?.tool != nil { ToolShelf.shared.open?(); return }
            let from = view.panelWindowRect(id)
            Task {
                guard await store.keepPanel(id), let from, let window = view.window else { return }
                KeepFlight.fly(in: window, from: from) { ToolShelf.shared.bump() }
            }
        }

        // ---------- renaming in place (app.mjs editInPlace) ----------

        func editInPlace(_ rect: CGRect, _ value: String, save: @escaping (String) -> Void) {
            guard let view else { return }
            editor?.removeFromSuperview()
            let f = InPlaceField(frame: rect)
            f.stringValue = value
            f.font = .systemFont(ofSize: max(11, 14 * view.scale), weight: .semibold)
            f.onFinish = { [weak self, weak f] ok in
                guard let f else { return }
                let next = f.stringValue.trimmingCharacters(in: .whitespaces)
                f.removeFromSuperview()
                self?.editor = nil
                if ok, !next.isEmpty, next != value { save(next) }
                view.window?.makeFirstResponder(view)
            }
            view.addSubview(f)
            editor = f
            view.window?.makeFirstResponder(f)
            f.currentEditor()?.selectAll(nil)
        }

        func renameGroup(_ gid: String, _ rect: CGRect) {
            guard let g = store.groups[gid] else { return }
            editInPlace(rect, g.name) { [weak self] in self?.store.patchGroup(gid, ["name": $0]) }
        }

        // ---------- deleting ----------

        func deleteAgent(_ id: String) {
            guard let a = store.agents[id] else { return }
            guard !(UserDefaults.standard.object(forKey: "confirmDelete") as? Bool ?? true) || confirm(L("Delete \"%@\"? Its conversation history is deleted too.", a.name), action: L("Delete")) else { return }
            store.deleteAgent(id)
        }

        func confirm(_ message: String, action: String) -> Bool {
            let alert = NSAlert()
            alert.messageText = message
            alert.addButton(withTitle: action)
            alert.addButton(withTitle: L("Cancel"))
            alert.buttons.first?.hasDestructiveAction = true
            return alert.runModal() == .alertFirstButtonReturn
        }

        // ---------- menus (app.mjs showMenu), as the Mac's own context menu ----------

        func menu(_ target: GraphView.MenuTarget, _ e: NSEvent, _ at: CGPoint) {
            guard let view else { return }
            let m = NSMenu()
            func item(_ title: String, danger: Bool = false, _ fn: @escaping () -> Void) {
                let i = MenuItem(title: title, fn: fn)
                if danger { i.attributedTitle = NSAttributedString(string: title, attributes: [.foregroundColor: NSColor.systemRed]) }
                m.addItem(i)
            }
            switch target {
            case .agent(let id):
                guard let a = store.agents[id] else { return }
                item(a.isTerminalOpen ? L("Close terminal") : L("Open terminal")) { [weak self] in self?.openTerminal(id, false) }
                // a chat in the node instead of the card (Cursor-like: @files, images, checkpoints); same session as the terminal
                if !a.isTerminalOpen, (a.createdBy ?? "user") == "user" {
                    let on = a.chat == true
                    let i = MenuItem(title: L("Chat")) { [weak self] in self?.store.setChat(id, !on) }
                    i.state = on ? .on : .off
                    m.addItem(i)
                }
                if a.cwd != nil || a.folder != nil {
                    item(a.ide.map { !$0.isNull } == true ? L("Close IDE") : "IDE") { [weak self] in self?.view?.toggleIDE(id) }
                    item(L("Open IDE in a window")) { [weak self] in
                        guard let self, let canvas = self.store.currentId, let a = self.store.agents[id] else { return }
                        IDEWindows.show(base: self.store.api.base, canvas: canvas, agent: a)
                    }
                }
                // tool help: the switch that left the title bar, with its name
                let tools = MenuItem(title: L("Tool help")) { [weak self] in self?.store.setToolHelp(id, !a.toolsOn) }
                tools.state = a.toolsOn ? .on : .off
                tools.image = NSImage(systemSymbolName: "wand.and.stars", accessibilityDescription: nil)
                tools.toolTip = L("Reuses saved and market tools and saves its own")
                m.addItem(tools)
                // computer control: also on the title while the agent asks for it or has it
                let control = store.computer[id]
                let computer = MenuItem(title: L("Computer control")) { [weak self] in
                    if control?.state == "on" { self?.store.setComputer(id, false) } else { self?.computerKey(id) }
                }
                computer.state = control?.state == "on" ? .on : control?.isAsking == true ? .mixed : .off
                computer.image = NSImage(systemSymbolName: "display", accessibilityDescription: nil)
                m.addItem(computer)
                item(L("Rename")) { [weak self, weak view] in
                    guard let self, let view, let a = self.store.agents[id] else { return }
                    let r = view.rectOf(a)
                    self.editInPlace(view.screenRect(CGRect(x: r.minX + 30, y: r.minY + 3, width: max(120, view.nameEnd(a) - 26), height: 24)), a.name) { self.store.renameAgent(id, to: $0) }
                }
                // its thinking level, as the model offers them; "Default" leaves it to the model
                if let levels = store.models.first(where: { $0.id == a.model })?.efforts, !levels.isEmpty {
                    let think = NSMenuItem(title: L("Thinking"), action: nil, keyEquivalent: "")
                    think.image = NSImage(systemSymbolName: "brain", accessibilityDescription: nil)
                    let sub = NSMenu()
                    for level in [nil] + levels.map(Optional.some) {
                        let i = MenuItem(title: level.map(AgentSheet.effortName) ?? L("Default")) { [weak self] in self?.store.setEffort(id, level) }
                        i.state = (a.effort ?? nil) == level || (level == nil && (a.effort ?? "").isEmpty) ? .on : .off
                        sub.addItem(i)
                        if level == nil { sub.addItem(.separator()) }
                    }
                    think.submenu = sub
                    m.addItem(think)
                }
                item(L("Settings…")) { [weak self] in self?.editAgent(id) }
                if a.isTerminalOpen, let queued = a.queued, queued > 0, a.autoDeliver == false {
                    item(L("Deliver pending message (%d)", queued)) { [weak self] in self?.store.deliver(id) }
                }
                item(L("Stop")) { [weak self] in self?.store.stop(id) }
                item(L("Reset session")) { [weak self] in self?.store.resetSession(id) }
                m.addItem(.separator())
                item(L("Delete  (⌫)"), danger: true) { [weak self] in self?.deleteAgent(id) }
            case .group(let gid):
                guard let g = store.groups[gid] else { return }
                item(L("Rename")) { [weak self, weak view] in
                    guard let self, let view else { return }
                    let r = view.groupRect(g)
                    self.renameGroup(gid, view.screenRect(CGRect(x: r.minX + 2, y: r.minY + 2, width: min(r.width - 4, 320), height: 18 * 1.4 - 2)))
                }
                item(L("Group note")) { [weak self, weak view] in
                    guard let self, let view, let g = self.store.groups[gid] else { return }
                    self.openGroupNote(gid, at: view.screenRect(view.noteRect(g)))
                }
                item(L("Change color…")) { [weak self] in self?.pickColor(gid) }
                if g.color != nil { item(L("Default color")) { [weak self] in self?.store.patchGroup(gid, ["color": NSNull()]) } }
                item(L("Add agent here")) { [weak self] in self?.addAgent(CGPoint(x: at.x - 140, y: at.y - 40)) }
                m.addItem(.separator())
                item(L("Delete group"), danger: true) { [weak self] in
                    guard let self, self.confirm(L("Delete the group \"%@\"? Its note and versions are deleted; agents stay.", g.name), action: L("Delete")) else { return }
                    self.store.deleteGroup(gid)
                }
            case .canvas:
                item(L("Add agent here")) { [weak self] in self?.addAgent(CGPoint(x: at.x - 140, y: at.y - 40)) }
                if !view.selected.isEmpty { item(L("Group  ⌘G")) { [weak self] in self?.groupSelection() } }
                item(L("Create group here")) { [weak self] in
                    guard let self, let name = self.ask(L("Group name")) else { return }
                    Task { _ = await self.store.createGroup(rect: [at.x - 40, at.y - 40, 840, 520], name: name, color: self.nextGroupColor()) }
                }
                item(L("Show all")) { [weak view] in view?.fit(animated: true) }
            }
            NSMenu.popUpContextMenu(m, with: e, for: view)
        }

        func ask(_ title: String) -> String? {
            let alert = NSAlert()
            alert.messageText = title
            let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
            alert.accessoryView = field
            alert.addButton(withTitle: L("OK"))
            alert.addButton(withTitle: L("Cancel"))
            alert.window.initialFirstResponder = field
            guard alert.runModal() == .alertFirstButtonReturn else { return nil }
            let v = field.stringValue.trimmingCharacters(in: .whitespaces)
            return v.isEmpty ? nil : v
        }

        var colorTarget: String?
        func pickColor(_ gid: String) {
            colorTarget = gid
            let panel = NSColorPanel.shared
            panel.color = NSColor(css: store.groups[gid]?.color) ?? NSColor(hex: 0x548AF7)
            panel.setTarget(self)
            panel.setAction(#selector(colorChanged(_:)))
            panel.makeKeyAndOrderFront(nil)
        }
        @objc func colorChanged(_ panel: NSColorPanel) {
            guard let gid = colorTarget, let c = panel.color.usingColorSpace(.sRGB) else { return }
            let hex = String(format: "#%02x%02x%02x", Int(c.redComponent * 255), Int(c.greenComponent * 255), Int(c.blueComponent * 255))
            store.patchGroup(gid, ["color": hex])
        }

        // ---------- grouping a selection (app.mjs groupSelection) ----------

        static let groupColors = ["#548af7", "#5fb865", "#d6ae58", "#b189f5", "#2aacb8", "#e08855", "#c77dbb"] // JetBrains file colors

        func nextGroupColor() -> String {
            let used = Set(store.groups.values.map { $0.color ?? Self.groupColors[0] })
            return Self.groupColors.first { !used.contains($0) } ?? Self.groupColors[store.groups.count % Self.groupColors.count]
        }

        /// agents working in the same folder are named after it; otherwise a plain name to type over
        func autoName(_ ids: [String]) -> String {
            let folders = ids.map { store.agents[$0]?.folder?.name }
            if let f = folders.first ?? nil, folders.allSatisfy({ $0 == f }) { return f }
            return L("group")
        }

        func groupSelection() {
            guard let view, !view.selected.isEmpty else { return }
            let ids = Array(view.selected)
            hideSelbar()
            // a frame around the agents with what is docked beside them (graph.mjs frameOf)
            let rs = ids.compactMap { store.agents[$0] }.map { a -> CGRect in
                var r = view.rectOf(a)
                if let d = view.dockWidth(a) { r.size.width += d.width; r.size.height = max(r.height, d.height) }
                return r
            }
            guard let first = rs.first else { return }
            let b = rs.dropFirst().reduce(first) { $0.union($1) }
            let rect = [b.minX - 30, b.minY - 60, b.width + 60, b.height + 90].map(Double.init)
            Task {
                guard let g = await store.createGroup(rect: rect, name: autoName(ids), color: nextGroupColor()) else { return }
                view.celebrateGroup(g.id)
                try? await Task.sleep(for: .milliseconds(420))
                let r = view.groupRect(g)
                renameGroup(g.id, view.screenRect(CGRect(x: r.minX + 2, y: r.minY + 2, width: min(r.width - 4, 320), height: 18 * 1.4 - 2)))
            }
        }

        // ---------- the bar over a selection: one button, group them ----------

        func selectionChanged(_ ids: [String]) {
            guard let view else { return }
            hideSelbar()
            guard !ids.isEmpty, case .marquee = view.drag ?? .pan(start: .zero, offset: .zero) else { return }
            let rs = ids.compactMap { store.agents[$0] }.map { view.screenRect(view.rectOf($0)) }
            guard let first = rs.first else { return }
            let b = rs.dropFirst().reduce(first) { $0.union($1) }.insetBy(dx: -30 * view.scale, dy: 0)
            let bar = SelectionBar { [weak self] in self?.groupSelection() }
            bar.frame = CGRect(x: max(8, min(b.midX - 23, view.bounds.width - 54)), y: max(8, b.minY - 60 * view.scale - 54), width: 46, height: 44)
            view.addSubview(bar)
            bar.appear()
            selbar = bar
        }

        func hideSelbar() { selbar?.removeFromSuperview(); selbar = nil }
    }
}

/// a menu item that runs a closure
final class MenuItem: NSMenuItem {
    let fn: () -> Void
    init(title: String, fn: @escaping () -> Void) {
        self.fn = fn
        super.init(title: title, action: #selector(run), keyEquivalent: "")
        target = self
    }
    required init(coder: NSCoder) { fatalError() }
    @objc func run() { fn() }
}

/// the text field that renames in place: accent border, Enter saves, Esc cancels, leaving saves
final class InPlaceField: NSTextField, NSTextFieldDelegate {
    var onFinish: ((Bool) -> Void)?
    private var done = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        delegate = self
        isBezeled = false
        drawsBackground = true
        backgroundColor = NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(hex: 0x393B40) : NSColor(hex: 0xEBECF0) }
        focusRingType = .none
        wantsLayer = true
        layer?.cornerRadius = 5
        layer?.borderWidth = 1
        layer?.borderColor = Pal.accent.cgColor
    }
    required init?(coder: NSCoder) { fatalError() }

    func finish(_ ok: Bool) { guard !done else { return }; done = true; onFinish?(ok) }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(insertNewline(_:)) { finish(true); return true }
        if sel == #selector(cancelOperation(_:)) { finish(false); return true }
        return false
    }
    func controlTextDidEndEditing(_ obj: Notification) { finish(true) }
}

/// the bar floating over a selection (canvas.html #selbar): one button that groups, springing in
final class SelectionBar: NSView {
    let onGroup: () -> Void
    private var hover = false

    init(onGroup: @escaping () -> Void) {
        self.onGroup = onGroup
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 5
        layer?.borderWidth = 1
        layer?.shadowOpacity = 0.15
        layer?.shadowRadius = 5
        layer?.shadowOffset = CGSize(width: 0, height: -10)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
        toolTip = L("Group  ⌘G")
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }

    func appear() {
        // like the web's selin: from 6 px lower and 85% to its place, with a little overshoot
        layer?.anchorPoint = CGPoint(x: 0.5, y: 0.5)
        layer?.position = CGPoint(x: frame.midX, y: frame.midY)
        let a = CASpringAnimation(keyPath: "transform.scale")
        a.fromValue = 0.85; a.toValue = 1; a.damping = 12; a.initialVelocity = 4
        a.duration = a.settlingDuration
        let o = CABasicAnimation(keyPath: "opacity")
        o.fromValue = 0; o.toValue = 1; o.duration = 0.2
        layer?.add(a, forKey: "in"); layer?.add(o, forKey: "fade")
    }

    override func updateLayer() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = (NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(hex: 0x393B40) : NSColor(hex: 0xEBECF0) }).cgColor
            layer?.borderColor = Pal.grid.cgColor
        }
    }
    override var wantsUpdateLayer: Bool { false }

    override func draw(_ dirty: NSRect) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            guard let ctx = NSGraphicsContext.current?.cgContext else { return }
            let bg = NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(hex: 0x393B40) : NSColor(hex: 0xEBECF0) }
            layer?.backgroundColor = bg.cgColor
            layer?.borderColor = Pal.grid.cgColor
            let btn = bounds.insetBy(dx: 5, dy: 5)
            if hover {
                ctx.setFillColor(Pal.accent.cgColor)
                ctx.addPath(CGPath(roundedRect: btn, cornerWidth: 10, cornerHeight: 10, transform: nil)); ctx.fillPath()
            }
            AppIcon.draw(AppIcon.group, in: ctx,
                         rect: CGRect(x: btn.midX - 10, y: btn.midY - 10, width: 20, height: 20),
                         color: hover ? .white : Pal.ink)
        }
    }

    override func mouseEntered(with e: NSEvent) { hover = true; needsDisplay = true }
    override func mouseExited(with e: NSEvent) { hover = false; needsDisplay = true }
    override func mouseDown(with e: NSEvent) {
        layer?.add({ let a = CABasicAnimation(keyPath: "transform.scale"); a.fromValue = 0.88; a.toValue = 1; a.duration = 0.15; return a }(), forKey: "press")
    }
    override func mouseUp(with e: NSEvent) { onGroup() }
}


/// "↶ <panel>": undoes the removal it stands for
private struct UndoCapsule: View {
    let title: String
    let undo: () -> Void
    var body: some View {
        Button(action: undo) {
            HStack(spacing: 7) {
                Image(systemName: "arrow.uturn.backward").font(.system(size: 12, weight: .semibold))
                Text(title).font(.system(size: 12.5)).lineLimit(1).strikethrough(color: JB.muted)
            }
            .foregroundStyle(JB.ink)
            .padding(.horizontal, 14).frame(height: 32)
            .background(Capsule().fill(JB.panel))
            .overlay(Capsule().strokeBorder(JB.line))
            .shadow(color: .black.opacity(0.25), radius: 10, y: 4)
        }
        .buttonStyle(Press())
        .help(L("Undo"))
    }
}

private struct DeltaID: Decodable { var id: String }
