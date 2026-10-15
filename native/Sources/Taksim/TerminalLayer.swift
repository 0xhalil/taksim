import AppKit
import SwiftUI
import SwiftTerm
import TaksimKit

// An agent's terminal (its CLI's TUI), as ui/canvas/term.mjs does it: a terminal view over the node's body,
// kept aligned with it as the canvas pans and zooms, fed from the server's terminal WebSocket
// (/term/<canvas>/<agent>: {t:"i",d} input, {t:"r",cols,rows} size, raw output back). The PTY lives in the
// server; this view opens none.

/// xterm.js's colors as the web sets them (term.mjs DARK / LIGHT; xterm's defaults where the web sets none)
enum TermColors {
    static func c(_ hex: UInt32) -> SwiftTerm.Color {
        SwiftTerm.Color(red: UInt16((hex >> 16) & 0xFF) * 257, green: UInt16((hex >> 8) & 0xFF) * 257, blue: UInt16(hex & 0xFF) * 257)
    }
    static let darkAnsi: [UInt32] = [0x1E1F22, 0xCD3131, 0x0DBC79, 0xE5E510, 0x2472C8, 0xBC3FBC, 0x11A8CD, 0xE5E5E5,
                                     0x6F737A, 0xF14C4C, 0x23D18B, 0xF5F543, 0x3B8EEA, 0xD670D6, 0x29B8DB, 0xE5E5E5]
    static let lightAnsi: [UInt32] = [0x000000, 0xC7222D, 0x067D17, 0xA67C00, 0x1750EB, 0x871094, 0x0E7D8C, 0x6C707E,
                                      0x8C8C8C, 0xE55765, 0x208A3C, 0xC27D04, 0x3574F0, 0xA64AB3, 0x1A9AA8, 0x1E1F22]

    static func apply(_ v: TerminalView, dark: Bool) {
        func t(_ d: UInt32, _ l: UInt32) -> NSColor { NSColor(hex: Theme.hex(d, l, isDark: dark)) }
        v.installColors((dark ? darkAnsi : lightAnsi).map(c))
        v.nativeBackgroundColor = t(0x1E1F22, 0xFFFFFF)
        v.nativeForegroundColor = t(0xBCBEC4, 0x1E1F22)
        v.caretColor = t(0xCED0D6, 0x1E1F22)
        v.selectedTextBackgroundColor = t(0x2E436E, 0xD4E2FF)
    }
}

/// the box over a node's body: the canvas background with the web's padding (.term: 6 4 4 8), the terminal in it
final class TermBox: NSView {
    let term: TerminalView
    var dark: Bool?

    init() {
        term = TerminalView(frame: .zero, font: .monospacedSystemFont(ofSize: 13, weight: .regular),
                            options: TerminalOptions(scrollback: 5000))
        super.init(frame: .zero)
        wantsLayer = true
        addSubview(term)
        applyTheme()
        themeObserver = NotificationCenter.default.addObserver(forName: Theme.changed, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.applyTheme() }
        }
    }
    deinit { if let themeObserver { NotificationCenter.default.removeObserver(themeObserver) } }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }

    /// size in graph units; the box's frame (screen) scales it, like the web's CSS transform
    /// room kept under the terminal (a transcript's message line)
    var footer: CGFloat = 0

    func place(screen: CGRect, graphSize: CGSize) {
        frame = screen
        bounds = CGRect(origin: .zero, size: graphSize)
        term.frame = CGRect(x: 8, y: 6, width: max(10, graphSize.width - 12), height: max(10, graphSize.height - 10 - footer))
        layoutFooter?(graphSize)
    }
    var layoutFooter: ((CGSize) -> Void)?

    var theme: ThemeChoice?
    var themeObserver: NSObjectProtocol?

    func applyTheme() {
        let d = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        guard d != dark || theme != Theme.current else { return }
        dark = d
        theme = Theme.current
        layer?.backgroundColor = NSColor(hex: Theme.hex(0x1E1F22, 0xFFFFFF, isDark: d)).cgColor
        TermColors.apply(term, dark: d)
    }

    override func viewDidChangeEffectiveAppearance() { applyTheme() }
    override func viewDidMoveToSuperview() { applyTheme() }
    override func viewDidMoveToWindow() { applyTheme() }
}

/// one agent's terminal: its view and its socket
@MainActor
final class AgentTerminal: NSObject, TerminalViewDelegate, URLSessionWebSocketDelegate {
    let box = TermBox()
    let url: URL
    let origin: String
    var task: URLSessionWebSocketTask?
    var session: URLSession!
    var retries = 0
    var closed = false
    var canvas = "" // the canvas the agent is on: the terminal stays (hidden) while another tab is shown
    var onGone: () -> Void = {}

    convenience init(base: URL, canvas: String, agent: String) { self.init(base: base, path: "/term/\(canvas)/\(agent)") }

    /// any of the server's terminals: an agent's (/term/<canvas>/<agent>), an account login's (/term/account/<id>)
    init(base: URL, path: String) {
        var c = URLComponents(url: base, resolvingAgainstBaseURL: false) ?? URLComponents()
        c.scheme = base.scheme == "https" ? "wss" : "ws"
        c.path = path
        url = c.url ?? base
        origin = "\(base.scheme ?? "http")://\(base.host ?? "127.0.0.1")\(base.port.map { ":\($0)" } ?? "")"
        super.init()
        session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: .main)
        box.term.terminalDelegate = self
        connect()
    }

    func connect() {
        guard !closed else { return }
        var req = URLRequest(url: url)
        req.setValue(origin, forHTTPHeaderField: "Origin") // the server only takes its own origin
        let t = session.webSocketTask(with: req)
        task = t
        t.resume()
        receive(t)
    }

    func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            MainActor.assumeIsolated {
                guard let self, self.task === t else { return }
                switch result {
                case .success(.string(let s)): self.box.term.feed(text: s); self.receive(t)
                case .success(.data(let d)): self.box.term.feed(byteArray: ArraySlice(d)); self.receive(t)
                case .success: self.receive(t)
                case .failure: self.dropped()
                }
            }
        }
    }

    nonisolated func urlSession(_ s: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol p: String?) {
        MainActor.assumeIsolated {
            retries = 0
            box.term.getTerminal().resetToInitialState()
            let t = box.term.getTerminal()
            send(["t": "r", "cols": t.cols, "rows": t.rows])
        }
    }

    // retry briefly (network blips); after that, let the app re-check whether the terminal still exists
    func dropped() {
        guard !closed else { return }
        retries += 1
        if retries <= 3 {
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(retries)) { [weak self] in self?.connect() }
        } else {
            onGone()
        }
    }

    func send(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(s)) { _ in }
    }

    func close() {
        closed = true
        task?.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
        box.removeFromSuperview()
    }

    // ---------- TerminalViewDelegate ----------

    nonisolated func send(source: TerminalView, data: ArraySlice<UInt8>) {
        let text = String(decoding: data, as: UTF8.self)
        MainActor.assumeIsolated { send(["t": "i", "d": text]) }
    }
    nonisolated func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        MainActor.assumeIsolated { send(["t": "r", "cols": newCols, "rows": newRows]) }
    }
    nonisolated func setTerminalTitle(source: TerminalView, title: String) {}
    nonisolated func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    nonisolated func scrolled(source: TerminalView, position: Double) {}
    nonisolated func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

extension GraphView {
    static let termEdge: CGFloat = 10    // px of node edge left uncovered for resizing (term.mjs EDGE)
    static let termMinScale: CGFloat = 0.45 // below this the text is unreadable: the summary card shows instead

    var terminalsShown: Bool { scale >= Self.termMinScale }

    /// opens, places and closes the terminal views to match the agents (term.mjs ensure / layout / remove)
    func layoutTerminals() {
        guard let store, let canvas = store.currentId else { return }
        var keep = Set<String>()
        for a in agents where a.isTerminalOpen {
            keep.insert(a.id)
            let t = terminals[a.id] ?? {
                let t = AgentTerminal(base: store.api.base, path: "/term/shell/\(canvas)/\(a.id)")
                t.canvas = canvas
                t.onGone = { [weak self] in self?.store?.refreshAgent(a.id) }
                addSubview(t.box)
                terminals[a.id] = t
                return t
            }()
            t.box.isHidden = !terminalsShown || a.isCollapsed
            let p = pos(a), s = size(a)
            let g = CGSize(width: s.width - Self.termEdge, height: s.height - Self.termEdge)
            t.box.place(screen: CGRect(x: (p.x + offset.x) * scale, y: (p.y + offset.y) * scale, width: g.width * scale, height: g.height * scale), graphSize: g)
        }
        layoutTranscripts(canvas)
        // gone from this canvas: closed; on another canvas: kept, hidden, so coming back is instant
        for (id, t) in terminals where !keep.contains(id) {
            if t.canvas == canvas { t.close(); terminals[id] = nil } else { t.box.isHidden = true }
        }
        layoutPanels()
    }

    /// the tab changed: what belongs to other canvases hides at once (layoutTerminals/Panels bring this one's back)
    func switchedCanvas() {
        for t in terminals.values { t.box.isHidden = true }
        for t in transcripts.values { t.box.isHidden = true; t.plan?.isHidden = true }
        for h in panels.values { h.isHidden = true }
        modes = [:]
        baseRects = [:]
        layoutTerminals()
    }

    func closeAllTerminals() {
        for t in terminals.values { t.close() }
        terminals = [:]
        closeAllPanels()
        modes = [:]
        baseRects = [:]
    }

    /// a node that opened or closed its terminal since the last call: an opened one moves to the nearest free
    /// spot, and the groups it sat in grow to keep it (app.mjs showAgent). Returns the ids that moved.
    @discardableResult
    func syncModes() -> Set<String> {
        var moved = Set<String>()
        for a in agents {
            let now = a.isTerminalOpen
            defer { modes[a.id] = now }
            guard let was = modes[a.id], was != now else { continue }
            let gids = groupsAt(a) // before moving: the node stays a member wherever it lands
            if now, let p = placeFree(a) { store.move(a.id, to: [Double(p.x), Double(p.y)]); moved.insert(a.id) }
            fitGroups(gids, a.id)
        }
        for id in modes.keys where store.agents[id] == nil { modes[id] = nil }
        return moved
    }

    /// the terminal this app asked for is open: keep it in view and type into it (app.mjs toggleTerminal)
    func terminalOpened(_ id: String, isNew: Bool) {
        if syncModes().contains(id) || isNew { fit() }
        layoutTerminals()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.focusTerminal(id) }
    }

    /// the node and the panel docked to its right: the room it takes (graph.mjs footprintOf)
    func footprintOf(_ a: Agent) -> CGRect {
        var r = rectOf(a)
        if let d = dockWidth(a) { r.size.width += d.width; r.size.height = max(r.height, d.height) }
        return r
    }

    /// groups the node sits in (top-left corner or center inside), innermost first (graph.mjs groupsAt)
    func groupsAt(_ a: Agent) -> [String] {
        let r = rectOf(a), pts = [CGPoint(x: r.minX + 1, y: r.minY + 1), CGPoint(x: r.midX, y: r.midY)]
        return groups.filter { g in pts.contains { inside(g, $0) } }
            .sorted { groupRect($0).width * groupRect($0).height < groupRect($1).width * groupRect($1).height }.map(\.id)
    }

    /// agents whose node center lies inside the group's frame (graph.mjs membersOf)
    func membersOf(_ gid: String) -> [String] {
        guard let g = store.groups[gid] else { return [] }
        return agents.filter { inside(g, centerOf($0)) }.map(\.id)
    }

    /// the frame around some nodes, with a group's margins (graph.mjs boundsOf)
    func boundsOf(_ ids: [String]) -> CGRect? {
        let rs = ids.compactMap { store.agents[$0] }.map(rectOf)
        guard let first = rs.first else { return nil }
        let u = rs.dropFirst().reduce(first) { $0.union($1) }
        return CGRect(x: u.minX - 30, y: u.minY - 60, width: u.width + 60, height: u.height + 90)
    }

    /// the nearest free spot on a 40 grid for a node that grew, preferring right and below (graph.mjs placeFree)
    func placeFree(_ a: Agent) -> CGPoint? {
        func overlaps(_ a: CGRect, _ b: CGRect) -> Bool {
            a.minX < b.maxX + 40 && b.minX < a.maxX + 40 && a.minY < b.maxY + 30 && b.minY < a.maxY + 30
        }
        let others = agents.filter { $0.id != a.id }.map(footprintOf)
        let own = footprintOf(a), p0 = pos(a)
        func freeAt(_ x: CGFloat, _ y: CGFloat) -> Bool {
            !others.contains { overlaps(CGRect(x: x, y: y - Self.th, width: own.width, height: own.height), $0) }
        }
        if freeAt(p0.x, p0.y) { return nil }
        let step: CGFloat = 40
        var best: (p: CGPoint, d: CGFloat)?
        for gx in -40...40 {
            for gy in -40...40 {
                let x = p0.x + CGFloat(gx) * step, y = p0.y + CGFloat(gy) * step
                let d = hypot(CGFloat(gx), CGFloat(gy)) - (gx > 0 ? 0.01 : 0) - (gy > 0 ? 0.005 : 0)
                if best == nil || d < best!.d, freeAt(x, y) { best = (CGPoint(x: x.rounded(), y: y.rounded()), d) }
            }
        }
        return best?.p
    }

    /// the groups a node sat in grow to hold it again, inner ones first; each keeps the frame the user set as
    /// its least (app.mjs fitGroups)
    func fitGroups(_ gids: [String], _ id: String) {
        var inner: CGRect?
        for gid in gids {
            guard let g = store.groups[gid], g.rect.count >= 4 else { continue }
            let cur = CGRect(x: g.rect[0], y: g.rect[1], width: g.rect[2], height: g.rect[3])
            let base = baseRects[gid] ?? cur
            var r = base
            if let b = boundsOf(Array(Set(membersOf(gid) + [id]))) { r = r.union(b) }
            if let inner { r = r.union(inner) }
            let rect = [r.minX, r.minY, r.width, r.height].map { Double($0.rounded()) }
            inner = CGRect(x: rect[0], y: rect[1], width: rect[2], height: rect[3])
            if rect == g.rect { continue }
            baseRects[gid] = base
            store.setGroupRect(gid, rect: rect)
        }
    }

    func focusTerminal(_ id: String) {
        guard let t = terminals[id] else { return }
        window?.makeFirstResponder(t.box.term)
    }
}

/// An agent without a TUI open shows its chat (ChatView): an agent another agent made, or one switched to chat.
/// The SwiftUI chat scales with the canvas like everything else; this is its place on the canvas.
@MainActor
final class AgentTranscript {
    let box: ChatBox
    var canvas = ""
    let model: ChatModel
    let store: CanvasStore
    /// the plan docked beside the node, while it is open
    var plan: PlanBox?

    init(api: APIClient, store: CanvasStore, canvas: String, agent: String) {
        self.canvas = canvas
        model = ChatModel(api: api, canvas: canvas, agent: agent)
        self.store = store
        box = ChatBox(ChatView(model: model, store: store))
    }

    /// a recorded message from the canvas's events
    func entry(_ e: ChatEntry) { model.take(e) }
    /// a piece of the answer as it streams
    func delta(_ text: String) { model.delta(text) }
    func close() { box.removeFromSuperview(); plan?.removeFromSuperview(); plan = nil }
}

/// A SwiftUI view's place on the canvas: the node's screen rect, drawn at the canvas zoom.
/// The view is laid out in graph units and SwiftUI does the scaling itself: it finds what is under the pointer
/// from the view's place in the window, one point for one unit, and scaled bounds (as the terminal box has) are
/// invisible to it. With those, a press on a button of a zoomed-out chat landed on whatever sits at that distance
/// unscaled, usually nothing.
final class ZoomBox<Content: View>: NSView {
    private let host: NSHostingView<Zoomed<Content>>
    private let zoom = ChatZoom()

    init(_ root: Content) {
        host = NSHostingView(rootView: Zoomed(content: root, zoom: zoom))
        super.init(frame: .zero)
        host.autoresizingMask = [.width, .height]
        addSubview(host)
        FirstClick.enable(on: host)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    func place(screen: CGRect, graphSize: CGSize) {
        frame = screen
        // mid-zoom: keep the laid-out view and let the bounds scale it to the new size
        if GraphView.liveZoom, zoom.size == graphSize, zoom.scale > 0 {
            setBoundsSize(CGSize(width: graphSize.width * zoom.scale, height: graphSize.height * zoom.scale))
            return
        }
        if bounds.size != frame.size { setBoundsSize(frame.size) }
        host.frame = bounds
        let scale = graphSize.width > 0 ? screen.width / graphSize.width : 1
        if zoom.size != graphSize { zoom.size = graphSize }
        if abs(zoom.scale - scale) > 0.0001 { zoom.scale = scale }
    }

    // A press the view itself has no use for (between messages, beside a line of text) ends here. Passed on,
    // the canvas took it for a grab of the node: the card slid under the pointer and no text could be selected.
    // The node still moves by its title.
    override func mouseDown(with e: NSEvent) {}
    override func mouseDragged(with e: NSEvent) {}
    override func mouseUp(with e: NSEvent) {}
}

typealias ChatBox = ZoomBox<ChatView>
typealias PlanBox = ZoomBox<PlanDocument>

@MainActor @Observable
final class ChatZoom {
    var scale: CGFloat = 1
    var size: CGSize = CGSize(width: 640, height: 360)
}

struct Zoomed<Content: View>: View {
    let content: Content
    let zoom: ChatZoom
    var body: some View {
        content.frame(width: zoom.size.width, height: zoom.size.height)
            .scaleEffect(zoom.scale, anchor: .topLeading)
            .frame(width: zoom.size.width * zoom.scale, height: zoom.size.height * zoom.scale, alignment: .topLeading)
            .clipped() // whatever the node's size, nothing is drawn outside it
    }
}

extension GraphView {
    /// made by another agent (not the person): its node is a live chat while it has no TUI
    func isDelegate(_ a: Agent) -> Bool { (a.createdBy ?? "user") != "user" }
    /// the node shows its chat: a delegate, or an agent the person switched to chat, while no TUI is open
    func hasTranscript(_ a: Agent) -> Bool { !a.isTerminalOpen && (isDelegate(a) || a.chat == true) }

    /// the plan's dock beside a node, while it is open
    func planSize(_ a: Agent) -> CGSize? {
        guard let t = transcripts[a.id], t.model.planShown, t.model.plan != nil else { return nil }
        return CGSize(width: 440, height: max(420, size(a).height + Self.th))
    }

    /// the terminal or chat that fills a node's body, if one is showing
    func bodyBox(_ id: String) -> NSView? {
        guard let box: NSView = terminals[id]?.box ?? transcripts[id]?.box, !box.isHidden else { return nil }
        return box
    }

    /// One order decides what covers what. The frames are drawn on the canvas in the agents' order, but the
    /// bodies are views above all of that drawing: a node underneath showed its chat over the title of the node on
    /// top of it. Each body is cut away where a node in front of it lies, so the one in front is whole.
    func applyStacking() {
        let list = agents
        CATransaction.begin(); CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        for (i, a) in list.enumerated() {
            guard let box = bodyBox(a.id) else { continue }
            let covers = list[(i + 1)...].map { screenRect(rectOf($0)).insetBy(dx: -3 * scale, dy: -3 * scale) }.filter { $0.intersects(box.frame) }
            if covers.isEmpty { box.layer?.mask = nil; continue }
            box.wantsLayer = true
            var path = CGPath(rect: box.bounds, transform: nil)
            for r in covers { path = path.subtracting(CGPath(rect: box.convert(r, from: self), transform: nil)) }
            let mask = (box.layer?.mask as? CAShapeLayer) ?? CAShapeLayer()
            mask.frame = box.layer?.bounds ?? box.bounds
            mask.path = path
            box.layer?.mask = mask
        }
    }

    /// a press goes to the node in front at that point, not to a body underneath that was cut away there
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let hit = super.hitTest(point), hit !== self else { return super.hitTest(point) }
        let local = superview.map { convert(point, from: $0) } ?? point
        guard let top = agentAt(toGraph(local)) else { return hit }
        for a in agents where a.id != top.id {
            guard let box = bodyBox(a.id), hit === box || hit.isDescendant(of: box) else { continue }
            if let own = bodyBox(top.id), let h = own.hitTest(local) { return h }
            return self
        }
        return hit
    }

    func layoutTranscripts(_ canvas: String) {
        guard let store else { return }
        var keep = Set<String>()
        for a in agents where hasTranscript(a) {
            keep.insert(a.id)
            let t = transcripts[a.id] ?? {
                let t = AgentTranscript(api: store.api, store: store, canvas: canvas, agent: a.id)
                t.model.onPlanShown = { [weak self] in if let id = self?.store?.currentId { self?.layoutTranscripts(id) } }
                addSubview(t.box)
                transcripts[a.id] = t
                return t
            }()
            t.box.isHidden = !terminalsShown || a.isCollapsed
            let p = pos(a), s = size(a)
            let g = CGSize(width: s.width - Self.termEdge, height: s.height - Self.termEdge)
            t.box.place(screen: CGRect(x: (p.x + offset.x) * scale, y: (p.y + offset.y) * scale, width: g.width * scale, height: g.height * scale), graphSize: g)
            // its plan, docked like the IDE: after the node, its panel and its IDE
            if t.model.planShown, t.model.plan != nil {
                let dock = t.plan ?? {
                    let d = PlanBox(PlanDocument(model: t.model, store: store))
                    addSubview(d); t.plan = d
                    return d
                }()
                let r = rectOf(a)
                let x = r.maxX + Self.panelGap + (panelSize(a).map { $0.width + Self.panelGap } ?? 0) + (ideSize(a).map { $0.width + Self.panelGap } ?? 0)
                let size = planSize(a) ?? .zero
                dock.isHidden = !terminalsShown || scale < Self.panelMinScale || a.isCollapsed
                dock.place(screen: CGRect(x: (x + offset.x) * scale, y: (r.minY + offset.y) * scale, width: size.width * scale, height: size.height * scale), graphSize: size)
            } else if let dock = t.plan { dock.removeFromSuperview(); t.plan = nil }
        }
        for (id, t) in transcripts where !keep.contains(id) {
            if t.canvas == canvas { t.close(); transcripts[id] = nil } else { t.box.isHidden = true; t.plan?.isHidden = true }
        }
        applyStacking()
    }

    /// the live parts of a delegate's conversation, from the canvas's events
    func transcriptEvent(_ ev: ServerEvent) {
        switch ev.type {
        case "chat_tasks":
            struct T: Decodable { var id: String; var tasks: [ChatTask] }
            if let t = try? JSONDecoder().decode(T.self, from: ev.data) { transcripts[t.id]?.model.takeTasks(t.tasks) }
        case "chat_workflow":
            struct W: Decodable { var id: String; var plan: ChatPlan?; var question: ChatQuestion? }
            if let w = try? JSONDecoder().decode(W.self, from: ev.data), let t = transcripts[w.id] {
                let before = t.model.plan
                t.model.takeWorkflow(plan: w.plan, question: w.question)
                // a plan just proposed (or proposed again) opens beside the node
                if let plan = w.plan, plan.status == "draft", before?.id != plan.id || before?.version != plan.version { t.model.planShown = true }
                if w.plan == nil { t.model.planShown = false }
            }
        case "chat_job":
            struct J: Decodable { var id: String; var job: ChatJob? }
            if let j = try? JSONDecoder().decode(J.self, from: ev.data) { transcripts[j.id]?.model.job = j.job }
        case "chat_activity":
            struct A: Decodable { var id: String; var reset: Bool?; var activity: ChatActivity? }
            if let a = try? JSONDecoder().decode(A.self, from: ev.data) { transcripts[a.id]?.model.takeActivity(a.activity, reset: a.reset == true) }
        case "chat_queue":
            struct Q: Decodable { var id: String; var messages: [QueuedChatMessage] }
            if let q = try? JSONDecoder().decode(Q.self, from: ev.data) { transcripts[q.id]?.model.takeQueue(q.messages) }
        case "message":
            guard let e = try? JSONDecoder().decode(ChatEntry.self, from: ev.data), e.from != e.to else { return }
            transcripts[e.to]?.entry(e)
            if e.to != e.from { transcripts[e.from]?.entry(e) }
        case "text_delta":
            struct D: Decodable { var id: String; var text: String }
            if let d = try? JSONDecoder().decode(D.self, from: ev.data) { transcripts[d.id]?.delta(d.text) }
        default: break
        }
    }
}
