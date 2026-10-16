import AppKit
import TaksimKit

/// Native canvas: group enclosures, links, agent cards and selection, rendered with Core Graphics.
/// Group membership follows node centers and is previewed directly during a drag.
/// Coordinates follow LiteGraph: screen = (graph + offset) · scale; an agent's `pos` is the top-left of its
/// body, its title bar (30) sits above it.
@MainActor
final class GraphView: NSView {
    struct Actions {
        var toggleTerminal: (String) -> Void = { _ in }
        var toggleCollapsed: (String) -> Void = { _ in }
        var renameAgent: (String, CGRect) -> Void = { _, _ in }
        var renameGroup: (String, CGRect) -> Void = { _, _ in }
        var deleteAgent: (String) -> Void = { _ in }
        var menu: (MenuTarget, NSEvent, CGPoint) -> Void = { _, _, _ in }
        var selectionChanged: ([String]) -> Void = { _ in }
        var groupSelection: () -> Void = {}
        var viewMoved: () -> Void = {}
        var removePanel: (String) -> Void = { _ in }
        var keepPanel: (String) -> Void = { _ in }
        var openIDE: (String) -> Void = { _ in }
        var toggleHelpers: (String) -> Void = { _ in }
        var toggleToolHelp: (String) -> Void = { _ in }
        var computerKey: (String) -> Void = { _ in }
        var openGroupNote: (String, CGRect) -> Void = { _, _ in }
    }
    enum MenuTarget { case agent(String), group(String), canvas }

    var store: CanvasStore! { didSet { needsDisplay = true } }
    var actions = Actions()

    // view: LiteGraph's DragAndScale
    var scale: CGFloat = 1 { didSet { if scale != oldValue, !movingView { layoutTerminals() } } }
    var offset = CGPoint.zero { didSet { if offset != oldValue, !movingView { layoutTerminals() } } }
    /// scale and offset change together: the views over the canvas are laid out once, not after each
    private var movingView = false
    func moveView(scale s: CGFloat, offset o: CGPoint) {
        guard s != scale || o != offset else { return }
        movingView = true
        scale = s; offset = o
        movingView = false
        layoutTerminals()
    }
    var terminals: [String: AgentTerminal] = [:]
    var transcripts: [String: AgentTranscript] = [:] // the native conversation of each agent in chat mode
    var flashes: [String: CFTimeInterval] = [:]      // a press the node heard but can't act on yet
    var panels: [String: PanelHost] = [:]
    /// docked IDEs (IDEDock.swift)
    var ides: [String: IDEHost] = [:]
    /// drawing for a snapshot: no easing, everything at its final place
    var isSnapshotting = false
    var modes: [String: Bool] = [:]           // terminal open, as last laid out: a change moves the node (app.mjs showAgent)
    var baseRects: [String: CGRect] = [:]     // group id -> the frame as the user last set it (app.mjs fitGroups)

    // selection and hover
    var selected: Set<String> = [] { didSet { if selected != oldValue { actions.selectionChanged(Array(selected)) } } }
    var hoverId: String?
    var hoverIDE: String?
    var hoverHelpers: String?
    var hoverFold: String?
    var hoverToolHelp: String?
    var hoverComputer: String?
    var hoverTerm: String?
    /// a title button just pressed: it dips for a moment so the press is felt (agent id, which button, when)
    var pressedButton: (id: String, kind: String, at: CFTimeInterval)?
    func press(_ id: String, _ kind: String) { pressedButton = (id, kind, CACurrentMediaTime()); kick() }
    /// 0…1: how far a title button is pushed in right now
    func pressDepth(_ id: String, _ kind: String) -> CGFloat {
        guard let p = pressedButton, p.id == id, p.kind == kind else { return 0 }
        let t = CGFloat((CACurrentMediaTime() - p.at) / 0.22)
        return t >= 1 ? 0 : sin(t * .pi)
    }
    /// the arrow under the pointer: its label shows
    var hoverLink: Link?
    var hoverNote: String?
    var dropTarget: String? { didSet { needsDisplay = true } }

    // gestures in progress
    enum Drag {
        case pan(start: CGPoint, offset: CGPoint)
        case nodes(start: CGPoint, from: [String: CGPoint])
        case resize(id: String, corner: Corner, start: CGPoint, rect: CGRect)
        case group(id: String, start: CGPoint, rect: CGRect, members: [String: CGPoint])
        case groupResize(id: String, start: CGPoint, rect: CGRect)
        case marquee(start: CGPoint, now: CGPoint)
    }
    enum Corner { case nw, ne, sw, se }
    var drag: Drag?
    var localSize: [String: CGSize] = [:]
    var localPos: [String: CGPoint] = [:]     // positions while nodes are dragged     // sizes while a corner is dragged
    var localGroup: [String: CGRect] = [:]    // group frames while dragged
    var draggingItems = false

    // group membership while nodes are dragged (graph.mjs)
    var dragStartGroups: [String: Set<String>]?
    var dragPos: [String: CGPoint]?
    var groupAnims: [GroupAnim] = []
    var pulses: [Pulse] = []

    struct GroupAnim { var gid: String; var kind: Kind; var start: CFTimeInterval
        enum Kind { case join, leave, born } }
    struct Pulse { var from: String; var to: String; var start: CFTimeInterval; var color: NSColor }

    static let th: CGFloat = 30            // LiteGraph.NODE_TITLE_HEIGHT
    static let btn: CGFloat = 22           // the title-bar terminal button
    static let handle: CGFloat = 22        // LGraphNode.resizeHandleSize (set in graph.mjs)
    static let joinMs = 0.22, bornMs = 0.3, pulseMs = 0.9
    private var raiseMonitor: Any?
    static let minCard = CGSize(width: 220, height: 80), minTerm = CGSize(width: 480, height: 280)
    /// a chat needs room for its bar, a message and the composer with its buttons in one row
    static let minChat = CGSize(width: 320, height: 260)

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    // ---------- geometry ----------

    func toScreen(_ p: CGPoint) -> CGPoint { CGPoint(x: (p.x + offset.x) * scale, y: (p.y + offset.y) * scale) }
    func toGraph(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x / scale - offset.x, y: p.y / scale - offset.y) }
    func screenRect(_ r: CGRect) -> CGRect {
        CGRect(origin: toScreen(r.origin), size: CGSize(width: r.width * scale, height: r.height * scale))
    }

    var agents: [Agent] { store?.currentAgents ?? [] }

    /// a hash of what the canvas draws: changes to anything else (texts under open terminals, readiness,
    /// panel data) don't redraw it
    func drawnSignature(showGrid: Bool) -> Int {
        var h = Hasher()
        h.combine(showGrid)
        h.combine(Theme.current)
        for a in agents {
            h.combine(a.id); h.combine(a.name); h.combine(a.pos); h.combine(a.size); h.combine(a.cardSize); h.combine(a.collapsed)
            h.combine(a.status); h.combine(a.queued); h.combine(a.waitingOn); h.combine(a.workingWith); h.combine(a.blockedBy); h.combine(a.terminal); h.combine(a.backend)
            h.combine(a.folder?.name); h.combine(a.folder?.branch); h.combine(a.accountName); h.combine(a.model); h.combine(a.delegate); h.combine(a.toolHelp); h.combine(a.effort)
            h.combine(a.jobRole); h.combine(a.sandbox); h.combine(a.chatMode) // what its badge says
            h.combine(store?.computer[a.id])
            if let u = a.usageKey.flatMap({ store?.usage(for: $0) }), u.level != .calm { h.combine(u.limited); h.combine(u.peak?.used) }
            h.combine(a.panel?.spec != nil); h.combine(a.panel?.ui.collapsed); h.combine(a.panel?.ui.size)
            if !a.isTerminalOpen && !hasTranscript(a) { h.combine(a.lastText); h.combine(a.lastError); h.combine(a.role) }
        }
        for g in groups { h.combine(g.id); h.combine(g.name); h.combine(g.rect); h.combine(g.color); h.combine(g.version) }
        for l in store?.links ?? [] { h.combine(l.from); h.combine(l.to); h.combine(l.kind) }
        h.combine(store?.ghosts.keys.sorted() ?? [])
        return h.finalize()
    }

    func pos(_ a: Agent) -> CGPoint {
        if let p = localPos[a.id] { return p }
        let x = a.pos?.first ?? 0
        let y = (a.pos?.count ?? 0) > 1 ? (a.pos?[1] ?? 0) : 0
        return CGPoint(x: x, y: y)
    }

    /// where a dragged node is while the pointer moves: only the canvas knows, the store hears once on release
    func setLocal(_ id: String, _ p: CGPoint) {
        localPos[id] = p
        needsDisplay = true
        layoutTerminals()
    }

    /// a stored size on the 10 px grid and within bounds (graph.mjs fitSize)
    func size(_ a: Agent) -> CGSize {
        if a.isCollapsed { return CGSize(width: collapsedWidth(a), height: 0) }
        return localSize[a.id] ?? expandedSize(a)
    }

    /// folded, it narrows to its logo, name, status dot and title buttons
    func collapsedWidth(_ a: Agent) -> CGFloat {
        let buttons = CGFloat((hasIDE(a) ? 3 : 2) + (Self.titleSwitches ? 1 : 0) + (computerOf(a) != nil ? 1 : 0))
        let titleW = (a.name as NSString).size(withAttributes: [.font: ctitle()]).width
        let full = Self.th + titleW + 8 + 22 + buttons * (Self.btn + 4) + 6
        return min(expandedSize(a).width, max(150, full.rounded()))
    }

    /// its size when it isn't folded to its title bar
    func expandedSize(_ a: Agent) -> CGSize {
        let term = a.isTerminalOpen
        let raw = term ? (a.size ?? [760, 440]) : (a.cardSize ?? (hasTranscript(a) ? [640, 360] : [300, 150]))
        let rawW = raw.first ?? (term ? 760 : 300)
        let rawH = raw.count > 1 ? raw[1] : (term ? 440 : 150)
        let mn = term ? Self.minTerm : hasTranscript(a) ? Self.minChat : Self.minCard, mx = term ? CGSize(width: 1800, height: 1400) : CGSize(width: 1000, height: 900)
        func g(_ v: Double, _ lo: CGFloat, _ hi: CGFloat) -> CGFloat { min(hi, max(lo, (CGFloat(v) / 10).rounded() * 10)) }
        return CGSize(width: g(rawW, mn.width, mx.width), height: g(rawH, mn.height, mx.height))
    }

    /// body plus title bar, in graph units (graph.mjs rectOf)
    func rectOf(_ a: Agent) -> CGRect {
        let p = pos(a), s = size(a)
        return CGRect(x: p.x, y: p.y - Self.th, width: s.width, height: s.height + Self.th)
    }
    func centerOf(_ a: Agent) -> CGPoint { let r = rectOf(a); return CGPoint(x: r.midX, y: r.midY) }

    func groupRect(_ g: TaksimKit.Group) -> CGRect {
        if let local = localGroup[g.id] { return local }
        guard g.rect.count >= 4 else { return .zero }
        return CGRect(x: g.rect[0], y: g.rect[1], width: g.rect[2], height: g.rect[3])
    }
    var groups: [TaksimKit.Group] { (store?.groups.values.map { $0 } ?? []).sorted { $0.id < $1.id } }

    func inside(_ g: TaksimKit.Group, _ p: CGPoint) -> Bool { groupRect(g).contains(p) }
    func groupIds(of a: Agent) -> Set<String> { Set(groups.filter { inside($0, centerOf(a)) }.map(\.id)) }

    /// the innermost group holding a node: its color marks the node's left edge
    func innerGroup(of a: Agent) -> TaksimKit.Group? {
        groups.filter { inside($0, centerOf(a)) }.min { groupRect($0).width * groupRect($0).height < groupRect($1).width * groupRect($1).height }
    }

    func groupColor(_ g: TaksimKit.Group) -> NSColor { NSColor(css: g.color) ?? NSColor(hex: 0x548AF7) }

    // ---------- hit testing ----------

    func agentAt(_ p: CGPoint) -> Agent? { agents.reversed().first { rectOf($0).contains(p) } }

    func cornerAt(_ a: Agent, _ p: CGPoint) -> Corner? {
        guard !a.isCollapsed else { return nil } // a folded node keeps its size for when it opens
        let r = rectOf(a), h = Self.handle
        let left = p.x < r.minX + h, right = p.x > r.maxX - h, top = p.y < r.minY + h, bottom = p.y > r.maxY - h
        if bottom && right { return .se }
        if bottom && left { return .sw }
        if top && right && !inTitleButton(a, p) { return .ne }
        if top && left && p.x < r.minX + 8 { return .nw } // the logo sits there; only its very edge resizes
        return nil
    }

    /// an agent working in a git repo gets an IDE button left of the terminal one
    func hasIDE(_ a: Agent) -> Bool { a.folder?.branch != nil }
    func inIDEButton(_ a: Agent, _ p: CGPoint) -> Bool {
        guard hasIDE(a) else { return false }
        let r = rectOf(a), bx = slotX(a, a.hasFolder ? 1 : 0)
        return p.x >= bx && p.x <= bx + Self.btn && p.y >= r.minY && p.y <= r.minY + Self.th
    }

    /// the helpers switch, left of the IDE button (or of the terminal one): on, the agent hands routine work to
    /// helper agents on the cheapest model that fits
    /// the title's buttons from the right: terminal (only with a folder), IDE (only in a git repo), helpers, fold
    func slotX(_ a: Agent, _ i: Int) -> CGFloat { rectOf(a).maxX - 6 - Self.btn - CGFloat(i) * (Self.btn + 4) }
    func helpersX(_ a: Agent) -> CGFloat { slotX(a, (a.hasFolder ? 1 : 0) + (hasIDE(a) ? 1 : 0)) }
    /// the tool help switch, left of the helpers one: on, the agent reuses saved and market tools and saves its own
    /// the fold button, left of the helpers switch: the node folds to its title bar, or opens again
    func foldX(_ a: Agent) -> CGFloat { helpersX(a) - Self.btn - 4 }
    func toolHelpX(_ a: Agent) -> CGFloat { foldX(a) - Self.btn - 4 }
    func inFoldButton(_ a: Agent, _ p: CGPoint) -> Bool {
        let r = rectOf(a), bx = foldX(a)
        return p.x >= bx && p.x <= bx + Self.btn && p.y >= r.minY && p.y <= r.minY + Self.th
    }
    /// The title keeps three squares: the terminal, the IDE, and the one switch that changes what the node is
    /// (it creates agents: lit when on, like any switch here). Tool help is in the node's menu (right click).
    static let titleSwitches = false
    func inToolHelpButton(_ a: Agent, _ p: CGPoint) -> Bool {
        guard Self.titleSwitches else { return false }
        let r = rectOf(a), bx = toolHelpX(a)
        return p.x >= bx && p.x <= bx + Self.btn && p.y >= r.minY && p.y <= r.minY + Self.th
    }
    /// computer control's key, left of the fold button: there only while the agent asks for the screen (it
    /// breathes; one click allows) or has it (lit; a click takes it back; yellow while macOS still refuses)
    func computerOf(_ a: Agent) -> ComputerControl? { store?.computer[a.id] }
    func computerX(_ a: Agent) -> CGFloat { foldX(a) - Self.btn - 4 }
    func inComputerButton(_ a: Agent, _ p: CGPoint) -> Bool {
        guard computerOf(a) != nil else { return false }
        let r = rectOf(a), bx = computerX(a)
        return p.x >= bx && p.x <= bx + Self.btn && p.y >= r.minY && p.y <= r.minY + Self.th
    }
    func inHelpersButton(_ a: Agent, _ p: CGPoint) -> Bool {
        let r = rectOf(a), bx = helpersX(a)
        return p.x >= bx && p.x <= bx + Self.btn && p.y >= r.minY && p.y <= r.minY + Self.th
    }

    /// a labeled arrow within a few points of `p` (graph units)
    func linkAt(_ p: CGPoint) -> Link? {
        let reach = 7 / max(scale, 0.2)
        for l in store?.links ?? [] where !(l.label ?? "").isEmpty {
            let both = (store?.links ?? []).contains { $0.from == l.to && $0.to == l.from && $0.kind == "message" }
            guard let (a, b) = endpoints(l.from, l.to, l.kind == "message" && both ? 6 : 0) else { continue }
            let dx = b.x - a.x, dy = b.y - a.y, len2 = max(dx * dx + dy * dy, 1)
            let t = max(0, min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
            if hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)) < reach { return l }
        }
        return nil
    }

    func inTitleButton(_ a: Agent, _ p: CGPoint) -> Bool {
        guard a.hasFolder else { return false } // a plain terminal needs a folder to be in
        let r = rectOf(a), bx = r.maxX - Self.btn - 8
        return p.x >= bx && p.x <= bx + Self.btn + 4 && p.y >= r.minY && p.y <= r.minY + Self.th
    }

    /// where a group's note icon sits: the right end of its title band (graph units)
    func noteRect(_ g: TaksimKit.Group) -> CGRect {
        let r = groupRect(g)
        return CGRect(x: r.maxX - 26, y: r.minY + 8, width: 15, height: 15)
    }
    func groupNoteAt(_ p: CGPoint) -> TaksimKit.Group? {
        groups.reversed().first { noteRect($0).insetBy(dx: -5, dy: -5).contains(p) }
    }

    func groupTitleAt(_ p: CGPoint) -> TaksimKit.Group? {
        groups.reversed().first { g in let r = groupRect(g); return r.contains(p) && p.y < r.minY + 18 * 1.4 }
    }
    func groupResizeAt(_ p: CGPoint) -> TaksimKit.Group? {
        groups.reversed().first { g in let r = groupRect(g); return p.x > r.maxX - 16 && p.x <= r.maxX + 2 && p.y > r.maxY - 16 && p.y <= r.maxY + 2 }
    }
    func groupAt(_ p: CGPoint) -> TaksimKit.Group? {
        groups.filter { groupRect($0).contains(p) }.min { groupRect($0).width * groupRect($0).height < groupRect($1).width * groupRect($1).height }
    }

    // ---------- view ----------

    func fit(animated: Bool = false) {
        let rects = agents.map { a -> CGRect in
            var r = rectOf(a)
            if let d = dockWidth(a) { r.size.width += d.width; r.size.height = max(r.height, d.height) }
            return r
        }
        guard let first = rects.first, bounds.width > 0 else { return }
        let box = rects.dropFirst().reduce(first) { $0.union($1) }
        let pad: CGFloat = 80
        let s = min(1.1, max(0.45, min(bounds.width / (box.width + pad * 2), bounds.height / (box.height + pad * 2))))
        let to = CGPoint(x: bounds.width / 2 / s - box.midX, y: bounds.height / 2 / s - box.midY)
        if animated { animateView(to: s, offset: to) } else { scale = s; offset = to; needsDisplay = true }
    }

    func revealAgent(_ id: String) {
        guard let a = store.agents[id], bounds.width > 0, bounds.height > 0 else { return }
        selected = [id]
        let r = rectOf(a)
        let zoom = max(0.1, min(1, bounds.width / (r.width + 80), bounds.height / (r.height + 80)))
        animateView(to: zoom, offset: CGPoint(x: bounds.midX / zoom - r.midX, y: bounds.midY / zoom - r.midY))
    }

    var viewAnim: (from: (CGFloat, CGPoint), to: (CGFloat, CGPoint), start: CFTimeInterval)?
    func animateView(to s: CGFloat, offset o: CGPoint) {
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { scale = s; offset = o; needsDisplay = true; return }
        viewAnim = ((scale, offset), (s, o), CACurrentMediaTime())
        kick()
    }

    /// the room a docked panel (or an offered tool) and a docked IDE take next to a node
    func dockWidth(_ a: Agent) -> CGSize? {
        guard !a.isCollapsed else { return nil } // folded, its docks are tucked away
        let docks = [panelSize(a), ideSize(a), planSize(a)].compactMap { $0 }
        guard !docks.isEmpty else { return nil }
        return CGSize(width: docks.reduce(0) { $0 + $1.width + Self.panelGap }, height: docks.map(\.height).max() ?? 0)
    }

    /// where a new agent goes when none is chosen: the middle of the view (graph.mjs viewCenter)
    func viewCenter() -> CGPoint {
        CGPoint(x: bounds.width / 2 / scale - offset.x - 150, y: bounds.height / 2 / scale - offset.y - 75)
    }

    func zoom(by k: CGFloat, at p: CGPoint) {
        beginLiveView()
        let g = toGraph(p), s = min(10, max(0.1, scale * k))
        moveView(scale: s, offset: CGPoint(x: p.x / s - g.x, y: p.y / s - g.y))
        needsDisplay = true
    }

    // ---------- live view: zooming and panning without laying anything out ----------

    /// While the view zooms or pans, the views over the canvas (chats, panels, IDEs, terminals) stay where they
    /// were laid out and their layers are scaled and shifted to follow on the GPU. Moved for real, every scroll
    /// view in them made its SwiftUI view lay itself out again: 50–200 ms a step with a few chats open. They are
    /// placed for real once the gesture rests. (scale, offset) as last laid out.
    private(set) var liveFrom: (scale: CGFloat, offset: CGPoint)?
    private var liveSettle: DispatchWorkItem?

    func beginLiveView() {
        if liveFrom == nil { liveFrom = (scale, offset) }
        liveSettle?.cancel()
        let settle = DispatchWorkItem { [weak self] in self?.endLiveView() }
        liveSettle = settle
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18, execute: settle)
    }

    func endLiveView() {
        liveSettle?.cancel(); liveSettle = nil
        guard liveFrom != nil else { return }
        liveFrom = nil
        // the views take their real place and size and lay their content out at the new zoom before they lose
        // the transform, all in the frame the canvas draws next
        layoutTerminals()
        for v in canvasViews where !v.isHidden { v.layoutSubtreeIfNeeded() }
        setLiveTransform(k: 1, t: .zero)
    }

    /// what was laid out at (s0, o0) shows at (scale, offset): screen point x goes to x·k + (offset − o0)·scale
    func applyLiveView() {
        guard let f = liveFrom else { return }
        setLiveTransform(k: scale / f.scale, t: CGPoint(x: (offset.x - f.offset.x) * scale, y: (offset.y - f.offset.y) * scale))
    }

    /// the views laid out on the canvas (not the canvas's own drawing, which AppKit keeps in a layer of its own)
    var canvasViews: [NSView] {
        terminals.values.map(\.box) + transcripts.values.flatMap { [$0.box, $0.plan].compactMap { $0 } } + Array(panels.values) + Array(ides.values)
    }

    /// x·k + t (this view's flipped coordinates) on each view's layer: a layer turns around its anchor point, in
    /// its parent layer's coordinates, which run y up unless flipped
    private func setLiveTransform(k: CGFloat, t: CGPoint) {
        guard let parent = layer else { return }
        let lt = parent.contentsAreFlipped() ? t : CGPoint(x: t.x, y: parent.bounds.height * (1 - k) - t.y)
        // no transaction of its own: one would reach the screen at once, a frame before the canvas redraws the
        // nodes under it, and on a quick zoom the chats grew and shrank inside their frames (a view's own layer
        // doesn't animate a change)
        for v in canvasViews {
            guard let l = v.layer else { continue }
            if k == 1, t == .zero { l.transform = CATransform3DIdentity; continue }
            let d = CGPoint(x: l.position.x * (k - 1) + lt.x, y: l.position.y * (k - 1) + lt.y)
            l.transform = CATransform3DConcat(CATransform3DMakeScale(k, k, 1), CATransform3DMakeTranslation(d.x, d.y, 0))
        }
    }

    // ---------- animation: redraw every frame while something moves ----------

    var timer: Timer?
    var frameCount = 0
    func kick() {
        needsDisplay = true
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 1 / 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }
    func tick() {
        flashes = flashes.filter { CACurrentMediaTime() - $0.value < 0.7 }
        let moving = viewAnim != nil || !pulses.isEmpty || !groupAnims.isEmpty || drag != nil || panelsMoving || !flashes.isEmpty || pressedButton.map { CACurrentMediaTime() - $0.at < 0.25 } == true
        let breathing = agents.contains { ($0.status ?? "idle") != "idle" || !($0.waitingOn ?? []).isEmpty || $0.waitsForOthers || ($0.isCollapsed && $0.panel?.status == "pending") }
        if moving {
            needsDisplay = true
            layoutTerminals() // views over the canvas follow what moves
        } else if breathing {
            // only the status dots and outlines breathe (1.4 s): 20 frames a second is plenty, nothing else to lay out
            frameCount &+= 1
            if frameCount % 3 == 0 {
                for a in agents where (a.status ?? "idle") != "idle" || !(a.waitingOn ?? []).isEmpty || a.waitsForOthers {
                    setNeedsDisplay(screenRect(rectOf(a)).insetBy(dx: -8, dy: -8))
                }
            }
        }
        if !moving && !breathing { timer?.invalidate(); timer = nil; needsDisplay = true }
    }

    func pulse(from: String, to: String, color: NSColor) {
        pulses.append(Pulse(from: from, to: to, start: CACurrentMediaTime(), color: color))
        kick()
    }

    func celebrateGroup(_ id: String) {
        groupAnims.append(GroupAnim(gid: id, kind: .born, start: CACurrentMediaTime()))
        kick()
    }

    // ---------- pointer ----------

    override func mouseDown(with e: NSEvent) {
        window?.makeFirstResponder(self)
        actions.viewMoved()
        let sp = convert(e.locationInWindow, from: nil), p = toGraph(sp)
        let cmd = e.modifierFlags.contains(.command)

        if e.clickCount == 2 { return doubleClick(at: p) }

        if let a = agentAt(p) {
            if inTitleButton(a, p) { press(a.id, "term"); actions.toggleTerminal(a.id); return }
            if inIDEButton(a, p) { press(a.id, "ide"); actions.openIDE(a.id); return }
            if inFoldButton(a, p) { press(a.id, "fold"); actions.toggleCollapsed(a.id); return }
            if inHelpersButton(a, p) { press(a.id, "helpers"); actions.toggleHelpers(a.id); return }
            if inToolHelpButton(a, p) { press(a.id, "tools"); actions.toggleToolHelp(a.id); return }
            if inComputerButton(a, p) { press(a.id, "computer"); actions.computerKey(a.id); return }
            if let c = cornerAt(a, p) {
                drag = .resize(id: a.id, corner: c, start: p, rect: rectOf(a))
                return
            }
            if e.modifierFlags.contains(.shift) { selected.formSymmetricDifference([a.id]) }
            else if !selected.contains(a.id) { selected = [a.id] }
            beginNodeDrag(at: p)
            return
        }
        if cmd { drag = .marquee(start: p, now: p); selected = []; kick(); return }
        if let g = groupNoteAt(p) { actions.openGroupNote(g.id, screenRect(noteRect(g))); return }
        if let g = groupResizeAt(p) { drag = .groupResize(id: g.id, start: p, rect: groupRect(g)); return }
        if let g = groupTitleAt(p) {
            let members = Dictionary(agents.filter { inside(g, centerOf($0)) }.map { ($0.id, pos($0)) }, uniquingKeysWith: { _, last in last })
            drag = .group(id: g.id, start: p, rect: groupRect(g), members: members)
            beginMembership()
            return
        }
        selected = []
        drag = .pan(start: sp, offset: offset)
        show(.closedHand)
    }

    func beginNodeDrag(at p: CGPoint) {
        let from = Dictionary(agents.filter { selected.contains($0.id) }.map { ($0.id, pos($0)) }, uniquingKeysWith: { _, last in last })
        drag = .nodes(start: p, from: from)
        beginMembership()
    }

    func beginMembership() {
        dragStartGroups = Dictionary(agents.map { ($0.id, groupIds(of: $0)) }, uniquingKeysWith: { _, last in last })
        dragPos = Dictionary(agents.map { ($0.id, pos($0)) }, uniquingKeysWith: { _, last in last })
    }

    override func mouseDragged(with e: NSEvent) {
        if let c = cursor(at: convert(e.locationInWindow, from: nil), flags: e.modifierFlags) { show(c) }
        guard let d = drag else { return }
        let sp = convert(e.locationInWindow, from: nil), p = toGraph(sp)
        switch d {
        case .pan(let start, let o):
            offset = CGPoint(x: o.x + (sp.x - start.x) / scale, y: o.y + (sp.y - start.y) / scale)
        case .nodes(let start, let from):
            draggingItems = true
            for (id, f) in from { setLocal(id, CGPoint(x: f.x + p.x - start.x, y: f.y + p.y - start.y)) }
        case .resize(let id, let corner, let start, let r):
            resize(id, corner: corner, delta: CGPoint(x: p.x - start.x, y: p.y - start.y), rect: r)
        case .group(let id, let start, let r, let members):
            let dx = p.x - start.x, dy = p.y - start.y
            localGroup[id] = r.offsetBy(dx: dx, dy: dy)
            for (mid, f) in members { setLocal(mid, CGPoint(x: f.x + dx, y: f.y + dy)) }
        case .groupResize(let id, let start, let r):
            localGroup[id] = CGRect(x: r.minX, y: r.minY, width: max(140, r.width + p.x - start.x), height: max(80, r.height + p.y - start.y))
        case .marquee(let start, _):
            drag = .marquee(start: start, now: p)
        }
        kick()
    }

    /// a corner drag: LiteGraph's rule (top and left corners move the node too), held above the minimum
    func resize(_ id: String, corner: Corner, delta: CGPoint, rect r: CGRect) {
        guard let a = store.agents[id] else { return }
        let mn = a.isTerminalOpen ? Self.minTerm : hasTranscript(a) ? Self.minChat : Self.minCard
        var x = r.minX, y = r.minY, w = r.width, h = r.height
        switch corner {
        case .se: w += delta.x; h += delta.y
        case .sw: x += delta.x; w -= delta.x; h += delta.y
        case .ne: y += delta.y; w += delta.x; h -= delta.y
        case .nw: x += delta.x; y += delta.y; w -= delta.x; h -= delta.y
        }
        if w < mn.width { if corner == .sw || corner == .nw { x = r.maxX - mn.width }; w = mn.width }
        if h - Self.th < mn.height { if corner == .ne || corner == .nw { y = r.maxY - mn.height - Self.th }; h = mn.height + Self.th }
        localSize[id] = CGSize(width: w, height: h - Self.th)
        setLocal(id, CGPoint(x: x, y: y + Self.th))
    }

    override func mouseUp(with e: NSEvent) {
        defer {
            drag = nil; draggingItems = false; kick()
            if let c = cursor(at: convert(e.locationInWindow, from: nil), flags: e.modifierFlags) { show(c) }
        }
        guard let d = drag else { return }
        // what moved goes to the store (and the server) once, now
        defer { localPos = [:]; needsDisplay = true }
        switch d {
        case .nodes:
            finishMembership()
            for a in agents where dragPos?[a.id] != nil && pos(a) != dragPos?[a.id] {
                store.move(a.id, to: [pos(a).x.rounded(), pos(a).y.rounded()])
            }
        case .resize(let id, _, _, _):
            guard let a = store.agents[id], let s = localSize[id] else { return }
            store.resize(id, size: [s.width.rounded(), s.height.rounded()], terminal: a.isTerminalOpen, pos: [pos(a).x.rounded(), pos(a).y.rounded()])
            localSize[id] = nil
        case .group(let id, _, _, let members):
            finishMembership()
            if let r = localGroup[id] { baseRects[id] = nil; store.setGroupRect(id, rect: [r.minX, r.minY, r.width, r.height].map { $0.rounded() }) }
            localGroup[id] = nil
            for mid in members.keys { if let a = store.agents[mid] { store.move(mid, to: [pos(a).x.rounded(), pos(a).y.rounded()]) } }
        case .groupResize(let id, _, _):
            if let r = localGroup[id] { baseRects[id] = nil; store.setGroupRect(id, rect: [r.minX, r.minY, r.width, r.height].map { $0.rounded() }) }
            localGroup[id] = nil
        case .marquee(let s, let n):
            let r = CGRect(x: min(s.x, n.x), y: min(s.y, n.y), width: abs(n.x - s.x), height: abs(n.y - s.y))
            if r.width + r.height > 4 { selected = Set(agents.filter { rectOf($0).intersects(r) }.map(\.id)) }
        case .pan:
            break
        }
        dragStartGroups = nil
    }

    /// Geometry is the source of truth: releasing never changes the user's chosen position.
    func finishMembership() {
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
        let now = CACurrentMediaTime()
        let changes = membershipChanges()
        for gid in Set(changes.map(\.gid)) {
            let joining = changes.contains { $0.gid == gid && $0.kind == .join }
            groupAnims.append(GroupAnim(gid: gid, kind: joining ? .join : .leave, start: now))
        }
    }

    struct Change { var id: String; var gid: String; var kind: Kind; enum Kind { case join, leave } }
    func membershipChanges() -> [Change] {
        guard let before = dragStartGroups else { return [] }
        var out: [Change] = []
        for a in agents {
            guard let was = before[a.id] else { continue }
            let now = groupIds(of: a)
            for gid in now.subtracting(was) { out.append(Change(id: a.id, gid: gid, kind: .join)) }
            for gid in was.subtracting(now) { out.append(Change(id: a.id, gid: gid, kind: .leave)) }
        }
        return out
    }

    func doubleClick(at p: CGPoint) {
        if let a = agentAt(p) {
            let r = rectOf(a)
            if p.y < r.minY + Self.th && p.x < r.minX + nameEnd(a) {
                actions.renameAgent(a.id, screenRect(CGRect(x: r.minX + 30, y: r.minY + 3, width: max(120, nameEnd(a) - 26), height: Self.th - 6)))
                return
            }
            if p.y < r.minY + Self.th { return }
            return
        }
        if let g = groupTitleAt(p) {
            let r = groupRect(g)
            actions.renameGroup(g.id, screenRect(CGRect(x: r.minX + 2, y: r.minY + 2, width: min(r.width - 4, 320), height: 18 * 1.4 - 2)))
        }
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func rightMouseDown(with e: NSEvent) {
        let p = toGraph(convert(e.locationInWindow, from: nil))
        if let a = agentAt(p) {
            if !selected.contains(a.id) { selected = [a.id] }
            actions.menu(.agent(a.id), e, p)
        } else if let g = groupAt(p) {
            actions.menu(.group(g.id), e, p)
        } else {
            actions.menu(.canvas, e, p)
        }
    }

    override func scrollWheel(with e: NSEvent) {
        actions.viewMoved()
        let sp = convert(e.locationInWindow, from: nil)
        if e.modifierFlags.contains(.command) || !e.hasPreciseScrollingDeltas {
            // wheel up / fingers up zooms in, as LiteGraph does (wheelDeltaY > 0)
            zoom(by: 1 + e.scrollingDeltaY * (e.hasPreciseScrollingDeltas ? 0.004 : 0.04), at: sp)
        } else {
            beginLiveView()
            offset = CGPoint(x: offset.x + e.scrollingDeltaX / scale, y: offset.y + e.scrollingDeltaY / scale)
            needsDisplay = true
        }
    }

    override func magnify(with e: NSEvent) { actions.viewMoved(); zoom(by: 1 + e.magnification, at: convert(e.locationInWindow, from: nil)) }

    override func keyDown(with e: NSEvent) {
        if e.keyCode == 51 || e.keyCode == 117, let id = selected.first { actions.deleteAgent(id); return } // ⌫, ⌦
        if e.modifierFlags.contains(.command), e.charactersIgnoringModifiers == "g", !selected.isEmpty { actions.groupSelection(); return }
        super.keyDown(with: e)
    }

    // the cursor says what pressing would do; the card under the pointer shows its corner grip
    // the window covered, minimized or shown again: panels freeze or come back (layoutPanels decides)
    private var occlusion: NSObjectProtocol?
    private var textSizeObserver: NSObjectProtocol?
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        // a press anywhere on a node (its title, its terminal, its chat) brings it to the front
        if raiseMonitor == nil, window != nil {
            raiseMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] e in
                if let self, e.window === self.window, !self.isHiddenOrHasHiddenAncestor {
                    let sp = self.convert(e.locationInWindow, from: nil)
                    if self.bounds.contains(sp), let hit = self.window?.contentView?.hitTest(e.locationInWindow), hit === self || hit.isDescendant(of: self),
                       let a = self.agentAt(self.toGraph(sp)) {
                        self.store?.raise(a.id)
                        self.layoutTerminals(); self.needsDisplay = true
                    }
                }
                return e
            }
        } else if window == nil, let m = raiseMonitor { NSEvent.removeMonitor(m); raiseMonitor = nil }
        if let occlusion { NotificationCenter.default.removeObserver(occlusion) }
        occlusion = window.map { w in
            NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: w, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.layoutTerminals() }
            }
        }
        if textSizeObserver == nil {
            textSizeObserver = NotificationCenter.default.addObserver(forName: CanvasText.changed, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.needsDisplay = true }
            }
        }
    }

    override func updateTrackingAreas() {
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .cursorUpdate, .activeInKeyWindow, .inVisibleRect], owner: self))
    }

    // ---------- the cursor says what a press would do ----------

    private var shownCursor: NSCursor?
    private func show(_ c: NSCursor) {
        guard c !== shownCursor || NSCursor.current !== c else { return }
        shownCursor = c
        c.set()
    }

    /// the cursor for a point on the canvas; nil where a view on top (a terminal, a panel) owns it
    func cursor(at sp: CGPoint, flags: NSEvent.ModifierFlags) -> NSCursor? {
        if let d = drag {
            switch d {
            case .pan, .nodes, .group: return .closedHand
            case .resize(_, let c, _, _): return c == .se || c == .nw ? .frameResize(position: .bottomRight, directions: .all) : .frameResize(position: .bottomLeft, directions: .all)
            case .groupResize: return .frameResize(position: .bottomRight, directions: .all)
            case .marquee: return .crosshair
            }
        }
        if let hit = superview.flatMap({ hitTest(convert(sp, to: $0)) }), hit !== self { return nil }
        let p = toGraph(sp)
        if let a = agentAt(p) {
            if inTitleButton(a, p) || inIDEButton(a, p) || inFoldButton(a, p) || inHelpersButton(a, p) || inToolHelpButton(a, p) || inComputerButton(a, p) { return .pointingHand }
            if let c = cornerAt(a, p) { return c == .se || c == .nw ? .frameResize(position: .bottomRight, directions: .all) : .frameResize(position: .bottomLeft, directions: .all) }
            return .arrow
        }
        if groupNoteAt(p) != nil { return .pointingHand }
        if groupResizeAt(p) != nil { return .frameResize(position: .bottomRight, directions: .all) }
        if flags.contains(.command) { return .crosshair }
        return .arrow
    }

    override func cursorUpdate(with e: NSEvent) {
        if let c = cursor(at: convert(e.locationInWindow, from: nil), flags: e.modifierFlags) { show(c) } else { shownCursor = nil }
    }

    override func flagsChanged(with e: NSEvent) {
        super.flagsChanged(with: e)
        guard let w = window else { return }
        let sp = convert(w.mouseLocationOutsideOfEventStream, from: nil)
        if bounds.contains(sp), let c = cursor(at: sp, flags: e.modifierFlags) { show(c) }
    }

    override func mouseMoved(with e: NSEvent) {
        let sp = convert(e.locationInWindow, from: nil), p = toGraph(sp)
        guard let c = cursor(at: sp, flags: e.modifierFlags) else {
            // a terminal or a panel is under the pointer: it sets its own cursor
            shownCursor = nil
            if hoverId != nil || hoverIDE != nil || hoverTerm != nil || hoverHelpers != nil || hoverFold != nil || hoverComputer != nil {
                hoverId = nil; hoverIDE = nil; hoverTerm = nil; hoverHelpers = nil; hoverFold = nil; hoverComputer = nil; needsDisplay = true
            }
            return
        }
        show(c)
        let a = agentAt(p)
        let id = a.flatMap { $0.isTerminalOpen ? nil : $0.id }
        if id != hoverId { hoverId = id; needsDisplay = true }
        let ide = a.flatMap { inIDEButton($0, p) ? $0.id : nil }
        let term = a.flatMap { inTitleButton($0, p) ? $0.id : nil }
        if ide != hoverIDE || term != hoverTerm {
            hoverIDE = ide; hoverTerm = term; needsDisplay = true
            if let t = term { toolTip = store?.agents[t]?.isTerminalOpen == true ? L("Close terminal") : L("Open terminal") }
            else if ide != nil { toolTip = "IDE" }
            else { toolTip = nil }
        }
        let fold = a.flatMap { inFoldButton($0, p) ? $0.id : nil }
        if fold != hoverFold {
            hoverFold = fold; needsDisplay = true
            toolTip = fold.map { store?.agents[$0]?.isCollapsed == true ? L("Open") : L("Fold") } ?? nil
        }
        let helpers = a.flatMap { inHelpersButton($0, p) ? $0.id : nil }
        if helpers != hoverHelpers {
            hoverHelpers = helpers; needsDisplay = true
            toolTip = helpers.map { store?.agents[$0]?.delegate == true ? L("Creates agents") : L("Create agents") } ?? nil
        }
        let tools = a.flatMap { inToolHelpButton($0, p) ? $0.id : nil }
        if tools != hoverToolHelp {
            hoverToolHelp = tools; needsDisplay = true
            if let t = tools { toolTip = store?.agents[t]?.toolsOn == true ? L("Tool suggestions on") : L("Tool suggestions off") }
            else if helpers == nil { toolTip = nil }
        }
        let computer = a.flatMap { inComputerButton($0, p) ? $0.id : nil }
        if computer != hoverComputer {
            hoverComputer = computer; needsDisplay = true
            if let c = computer.flatMap({ store?.computer[$0] }) {
                toolTip = c.needsMac ? L("Allow in System Settings") : c.isAsking ? L("Allow computer control") : L("Controls the computer")
            } else if helpers == nil && tools == nil && fold == nil { toolTip = nil }
        }
        let link = a == nil ? linkAt(p) : nil
        if link != hoverLink { hoverLink = link; needsDisplay = true }
        let note = a == nil ? groupNoteAt(p)?.id : nil
        if note != hoverNote { hoverNote = note; needsDisplay = true }
    }

    override func mouseExited(with e: NSEvent) {
        if hoverId != nil || hoverTerm != nil || hoverIDE != nil || hoverHelpers != nil || hoverFold != nil || hoverComputer != nil {
            hoverId = nil; hoverTerm = nil; hoverIDE = nil; hoverHelpers = nil; hoverFold = nil; hoverComputer = nil; needsDisplay = true
        }
    }

    /// where a node's name ends in its title bar (double-click there renames)
    func nameEnd(_ a: Agent) -> CGFloat {
        Self.th + (shortTitle(a) as NSString).size(withAttributes: [.font: ctitle()]).width + 8
    }
}

extension NSColor {
    convenience init?(css: String?) {
        guard let s = css, s.hasPrefix("#"), let v = UInt32(s.dropFirst().prefix(6), radix: 16) else { return nil }
        self.init(hex: v)
    }
}
