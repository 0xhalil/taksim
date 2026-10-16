import AppKit
import CodeEditTextView
import SwiftUI
import TaksimKit

// The IDE docked to the right of its node (after its panel), like the web canvas had it: when an agent's work is
// about code it opens it (ide_open), the node's </> opens or closes it, and it pans and zooms with the canvas.
// It is the native IDE (IDE/): project, tabs, editor, the agent's notes. ⧉ opens the server's full IDE page in a
// window of its own (git, run, debug, terminal) until those are native too.

/// an agent's IDE dock state, read from the server's IDE view (src/ide/ide.mjs UI)
struct IDEDockState: Equatable {
    var collapsed = false
    var maximized = false
    var size = CGSize(width: 940, height: 580)

    init?(_ ide: JSONValue?) {
        guard let ide, !ide.isNull else { return nil }
        let ui = ide["ui"]
        collapsed = ui?["collapsed"]?.bool ?? false
        maximized = ui?["maximized"]?.bool ?? false
        if let s = ui?["size"]?.array, s.count == 2, let w = s[0].number, let h = s[1].number { size = CGSize(width: w, height: h) }
    }
}

@MainActor @Observable
final class IDEDockModel {
    let id: String
    var title = ""
    var branch: String?
    var state: IDEDockState?
    var scale: CGFloat = 1
    var size: CGSize = .zero
    @ObservationIgnored var collapse: () -> Void = {}
    @ObservationIgnored var maximize: () -> Void = {}
    @ObservationIgnored var popOut: () -> Void = {}
    @ObservationIgnored var close: () -> Void = {}
    @ObservationIgnored var open: () -> Void = {}
    init(id: String) { self.id = id }
}

/// the IDE's strip: what folder it is, and its four buttons
struct IDEDockHeader: View {
    let model: IDEDockModel
    var body: some View {
        let s = model.scale
        let folded = model.state?.collapsed ?? false
        SwiftUI.Group {
            if folded {
                CollapsedStrip(title: model.title, open: model.open)
                    .background(RoundedRectangle(cornerRadius: 8).fill(JB.panel))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(JB.line))
            } else {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.left.forwardslash.chevron.right").font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(JB.accent)
                    // the page under it names the folder and file; the strip only holds the dock's controls
                    Spacer(minLength: 4)
                    PanelButton(symbol: "macwindow.on.rectangle", help: L("Open in window"), action: model.popOut)
                    PanelButton(symbol: model.state?.maximized == true ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                                help: model.state?.maximized == true ? L("Restore") : L("Maximize"), action: model.maximize)
                    PanelButton(symbol: "minus", help: L("Collapse dock"), action: model.collapse)
                    PanelButton(symbol: "xmark", help: L("Close"), action: model.close)
                }
                .padding(.leading, 12).padding(.trailing, 6)
                .frame(height: IDEHost.head)
                .background(UnevenRoundedRectangle(topLeadingRadius: 8, topTrailingRadius: 8).fill(JB.nodeHead))
            }
        }
        .frame(width: max(1, model.size.width), height: folded ? max(1, model.size.height) : IDEHost.head)
        .scaleEffect(s, anchor: .topLeading)
        .frame(width: model.size.width * s, height: (folded ? model.size.height : IDEHost.head) * s, alignment: .topLeading)
    }
}

/// the IDE's SwiftUI, letting the editor say what the pointer is: SwiftUI's own pointer handling would put the
/// arrow back over the text on every move (an I-beam over text, ⌥ a crosshair; an arrow over the gutter)
final class IDEHostingView: NSHostingView<IDEView> {
    private var pointerArea: NSTrackingArea?
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let pointerArea { removeTrackingArea(pointerArea) }
        let a = NSTrackingArea(rect: .zero, options: [.mouseMoved, .cursorUpdate, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(a)
        pointerArea = a
    }
    /// SwiftUI looks for its AppKit views (the editor) with its own geometry, which misses them when an ancestor
    /// scales its bounds (the canvas zoom): at 0.5 a click on the text went to SwiftUI. Where SwiftUI finds
    /// nothing of its own, the editor is looked for the AppKit way.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        // SwiftUI's own controls (tabs, tree, the go-to-file box over the editor) keep their clicks
        guard hit == nil || hit === self || hit is NSScrollView || hit?.enclosingScrollView != nil else { return hit }
        return editorHit(in: self, at: convert(point, from: superview)) ?? hit
    }

    /// `p` in `v`'s coordinates; the scroll view holding the editor (text, gutter, scrollers) answers for itself
    private func editorHit(in v: NSView, at p: NSPoint) -> NSView? {
        for s in v.subviews.reversed() where !s.isHidden && s.alphaValue > 0 {
            let q = s.convert(p, from: v)
            guard s.bounds.contains(q) || !s.clipsToBounds else { continue }
            if s is NSScrollView { if s.bounds.contains(q) { return s.hitTest(p) } else { continue } }
            if let h = editorHit(in: s, at: q) { return h }
        }
        return nil
    }

    override func cursorUpdate(with e: NSEvent) { if !editorPointer(e) { super.cursorUpdate(with: e) } }
    override func mouseMoved(with e: NSEvent) { super.mouseMoved(with: e); _ = editorPointer(e) }
    override func flagsChanged(with e: NSEvent) { super.flagsChanged(with: e); _ = editorPointer(e) }

    /// the pointer for what is under it: an I-beam where text is typed (the editor, ⌥ a crosshair; the go-to-file
    /// field), the arrow everywhere else (tabs, tree, buttons, gutter): SwiftUI sets none of its own here, so the
    /// editor's I-beam would stay over the tabs
    private func editorPointer(_ e: NSEvent) -> Bool {
        guard let sup = superview else { return false }
        var v = hitTest(sup.convert(e.locationInWindow, from: nil))
        while let view = v, view !== self {
            if view is TextView {
                (e.modifierFlags.contains(.option) ? NSCursor.crosshair : NSCursor.iBeam).set()
                return true
            }
            if view is NSTextView || view is NSTextField { NSCursor.iBeam.set(); return true }
            let kind = String(describing: type(of: view))
            if kind.contains("Gutter") || kind.contains("LineFoldRibbon") || kind.contains("Scroller") { break }
            v = view.superview
        }
        NSCursor.arrow.set()
        return true
    }
}

/// the IDE's area under the strip. It follows the canvas's zoom in size but not in scale: the IDE inside keeps
/// its real text size and simply has more or less room. (Scaling it made SwiftUI place the pointer, hovers and
/// clicks off from where things were drawn: the tree and the editor answered for a spot above the pointer.)
final class ScaledArea: NSView {
    override var isFlipped: Bool { true }
}

/// the view over the canvas holding one IDE: its strip, the IDE under it, and the corner that resizes it
final class IDEHost: NSView {
    static let head: CGFloat = 32
    let model: IDEDockModel
    let ide: IDEModel
    var canvas = ""
    let header: NSHostingView<IDEDockHeader>
    let area = ScaledArea()
    let body: IDEHostingView
    let corner = Corner()
    /// the size while the corner is dragged (graph units)
    var liveSize: CGSize?
    var onResize: (CGSize, Bool) -> Void = { _, _ in }
    /// the server's IDE state last given to the model
    var applied: JSONValue?
    private var keys: Any?

    init(model: IDEDockModel, ide: IDEModel) {
        self.model = model
        self.ide = ide
        header = NSHostingView(rootView: IDEDockHeader(model: model))
        header.sizingOptions = []
        body = IDEHostingView(rootView: IDEView(model: ide))
        body.sizingOptions = []
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.masksToBounds = true
        layer?.borderWidth = 1
        area.addSubview(body)
        addSubview(area)
        addSubview(header)
        addSubview(corner)
        corner.host = self
        // ⌘P (go to file) and ⌘S (save now) while the focus is in this IDE; ⎋ closes the Fark view
        keys = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            guard let self else { return e }
            if e.keyCode == 53 {
                if self.ide.goingToFile { return e } // the go-to-file box answers for its own ⎋
                if self.ide.inline != nil { self.ide.rejectInline(); return nil }
                if self.ide.diff != nil { self.ide.closeDiff(); return nil }
                return e
            }
            guard e.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
                  let r = self.window?.firstResponder as? NSView, r.isDescendant(of: self) else { return e }
            switch e.charactersIgnoringModifiers {
            case "p": self.ide.startGoToFile(); return nil
            case "s": if let a = self.ide.active { self.ide.flush(a) }; return nil
            default: return e
            }
        }
    }
    required init?(coder: NSCoder) { fatalError() }

    // the strip's buttons get the arrow (the editor's I-beam would otherwise stay over them)
    private var stripArea: NSTrackingArea?
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let stripArea { removeTrackingArea(stripArea) }
        let a = NSTrackingArea(rect: header.frame, options: [.mouseMoved, .mouseEnteredAndExited, .cursorUpdate, .activeInKeyWindow], owner: self)
        addTrackingArea(a)
        stripArea = a
    }
    override func cursorUpdate(with e: NSEvent) { NSCursor.arrow.set() }
    override func mouseMoved(with e: NSEvent) {
        if header.frame.contains(convert(e.locationInWindow, from: nil)) { NSCursor.arrow.set() }
    }

    override func removeFromSuperview() {
        if let keys { NSEvent.removeMonitor(keys); self.keys = nil }
        super.removeFromSuperview()
    }

    override var isFlipped: Bool { true }
    override func scrollWheel(with e: NSEvent) {}
    override func mouseDown(with e: NSEvent) {}
    override func rightMouseDown(with e: NSEvent) {}
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func updateLayer() {
        layer?.backgroundColor = Pal.panel.cgColor
        layer?.borderColor = Pal.line.cgColor
    }

    func place(origin: CGPoint, size: CGSize, scale: CGFloat) {
        let f = CGRect(x: origin.x, y: origin.y, width: size.width * scale, height: size.height * scale)
        if model.scale != scale { model.scale = scale }
        if model.size != size { model.size = size }
        if frame != f { frame = f }
        if bounds.size != frame.size { setBoundsSize(frame.size) }
        let folded = model.state?.collapsed ?? false
        let hh = Self.head * scale
        let strip = folded ? bounds : CGRect(x: 0, y: 0, width: bounds.width, height: hh)
        if header.frame != strip { header.frame = strip; updateTrackingAreas() }
        area.isHidden = folded
        corner.isHidden = folded
        if !folded {
            let a = CGRect(x: 0, y: hh, width: bounds.width, height: max(0, bounds.height - hh))
            if area.frame != a { area.frame = a }
            if area.bounds.size != a.size { area.setBoundsSize(a.size) }
            if body.frame.size != a.size { body.frame = CGRect(origin: .zero, size: a.size) }
            corner.frame = CGRect(x: bounds.width - 16, y: bounds.height - 16, width: 16, height: 16)
        }
    }

    /// the corner that resizes the IDE, as a panel's corner does
    final class Corner: NSView {
        weak var host: IDEHost?
        private var start: (point: CGPoint, size: CGSize)?
        override func resetCursorRects() { addCursorRect(bounds, cursor: .frameResize(position: .bottomRight, directions: .all)) }
        override func mouseDown(with e: NSEvent) {
            guard let host else { return }
            start = (e.locationInWindow, host.model.size)
        }
        override func mouseDragged(with e: NSEvent) {
            guard let host, let s = start else { return }
            let p = e.locationInWindow, k = max(0.1, host.model.scale)
            let size = CGSize(width: max(420, s.size.width + (p.x - s.point.x) / k), height: max(260, s.size.height - (p.y - s.point.y) / k))
            host.onResize(size, false)
        }
        override func mouseUp(with e: NSEvent) {
            guard let host, start != nil else { return }
            start = nil
            host.onResize(host.liveSize ?? host.model.size, true)
        }
        override func draw(_ dirtyRect: NSRect) {
            Pal.muted.withAlphaComponent(0.6).setStroke()
            let p = NSBezierPath()
            p.move(to: CGPoint(x: bounds.maxX - 4, y: bounds.minY + 6)); p.line(to: CGPoint(x: bounds.minX + 6, y: bounds.maxY - 4))
            p.move(to: CGPoint(x: bounds.maxX - 4, y: bounds.minY + 10)); p.line(to: CGPoint(x: bounds.minX + 10, y: bounds.maxY - 4))
            p.lineWidth = 1
            p.stroke()
        }
    }
}

extension GraphView {
    static let ideStrip: CGFloat = 34
    static let ideMax = CGSize(width: 1400, height: 860) // canvas.mjs IDE_MAX

    /// the IDE's size next to a node, in graph units
    func ideSize(_ a: Agent) -> CGSize? {
        guard let st = IDEDockState(a.ide) else { return nil }
        if st.collapsed { return CGSize(width: Self.ideStrip, height: rectOf(a).height) }
        if let live = ides[a.id]?.liveSize { return live }
        return st.maximized ? Self.ideMax : st.size
    }

    /// opens, places and closes the docked IDEs to match the agents
    func layoutIDEs() {
        guard let store else { return }
        var keep = Set<String>()
        for a in agents {
            guard let size = ideSize(a), let canvas = store.currentId else { continue }
            keep.insert(a.id)
            let h = ides[a.id] ?? makeIDE(a.id, canvas: canvas, api: store.api)
            h.model.state = IDEDockState(a.ide)
            h.model.title = a.folder?.name ?? a.ide?["rootName"]?.string ?? a.name
            h.model.branch = a.folder?.branch
            // what the server says about this IDE: its tabs and notes, a file to show, files changed on disk
            if h.applied != a.ide { h.applied = a.ide; h.ide.apply(IDEState(json: a.ide)) }
            if let r = store.ideReveals[a.id] { h.ide.apply(reveal: r) }
            if let d = store.ideDiskChanges[a.id] { h.ide.apply(disk: d) }
            // a chat's changed file, clicked: its Fark view comes up once (the request is spent here)
            if let p = store.wantedDiffs[a.id] {
                store.wantedDiffs[a.id] = nil
                Task { await h.ide.openDiff(p.path, old: p.old, new: p.new) }
            }
            // after the node and its panel
            let r = rectOf(a)
            let x = r.maxX + Self.panelGap + (panelSize(a).map { $0.width + Self.panelGap } ?? 0)
            h.isHidden = scale < Self.panelMinScale || a.isCollapsed
            h.place(origin: CGPoint(x: (x + offset.x) * scale, y: (r.minY + offset.y) * scale), size: size, scale: scale)
        }
        for (id, h) in ides where !keep.contains(id) {
            if h.canvas == (store.currentId ?? "") { h.removeFromSuperview(); ides[id] = nil } else { h.isHidden = true }
        }
    }

    private func makeIDE(_ id: String, canvas: String, api: APIClient) -> IDEHost {
        let m = IDEDockModel(id: id)
        let h = IDEHost(model: m, ide: IDEModel(agent: id, client: IDEClient(api: api, canvas: canvas, agent: id)))
        h.canvas = canvas
        m.collapse = { [weak self] in self?.store?.ideUI(id, collapsed: true); self?.relayoutDocks() }
        m.open = { [weak self] in self?.store?.ideUI(id, collapsed: false); self?.relayoutDocks() }
        m.maximize = { [weak self] in
            guard let self, let st = IDEDockState(self.store?.agents[id]?.ide) else { return }
            self.store?.ideUI(id, maximized: !st.maximized); self.relayoutDocks()
        }
        // to a window of its own: the dock folds to its strip beside the node (a click brings it back)
        m.popOut = { [weak self] in
            guard let self, let store = self.store, let a = store.agents[id] else { return }
            IDEWindows.show(base: store.api.base, canvas: canvas, agent: a)
            store.ideUI(id, collapsed: true)
            self.relayoutDocks()
        }
        m.close = { [weak self] in self?.store?.closeIDE(id); self?.relayoutDocks() }
        h.onResize = { [weak self, weak h] size, done in
            guard let self, let h else { return }
            h.liveSize = done ? nil : size
            if done { self.store?.ideUI(id, maximized: false, size: [size.width.rounded(), size.height.rounded()]) }
            self.relayoutDocks()
        }
        addSubview(h)
        ides[id] = h
        return h
    }

    func relayoutDocks() { layoutPanels(); needsDisplay = true }

    func closeAllIDEs() {
        for h in ides.values { h.removeFromSuperview() }
        ides = [:]
    }

    /// the node's </>: the IDE opens beside it, or closes
    func toggleIDE(_ id: String) {
        guard let store else { return }
        if store.agents[id]?.ide.map({ !$0.isNull }) == true { store.closeIDE(id) } else { store.openIDE(id) }
        relayoutDocks()
    }
}
