import AppKit
import SwiftUI
import TaksimKit

// The panel layer (ui/canvas/panels.mjs): each agent's panel is a SwiftUI view docked to the right of its node,
// kept aligned with it as the canvas pans and zooms, like the terminals. A panel collapses to a strip beside the
// node, opens to its own size (resized from its corner) or maximizes; a saved tool offered for an agent shows
// faintly in the same place with ▶. Its views are bricks (Bricks/), fed by the canvas's panel stream.

/// what a panel asks of the app; set by GraphCanvas
struct PanelActions {
    var ui: (_ collapsed: Bool?, _ maximized: Bool?, _ size: [Double]?) -> Void = { _, _, _ in }
    var approve: (_ always: Bool) -> Void = { _ in }
    var reject: () -> Void = {}
    var refresh: () -> Void = {}
    var remove: () -> Void = {}
    var keep: () -> Void = {}
    /// true when it went to the agent (an `ask`)
    var action: (_ view: String, _ index: Int, _ row: JSONValue) async -> Bool = { _, _, _ in false }
    var useGhost: () -> Void = {}
    var dismissGhost: () -> Void = {}
    var tell: (String) -> Void = { _ in }
    var setSpec: (JSONValue) async -> String? = { _ in nil }
    /// the panel's size changed on its own (a corner drag): the canvas lays out again
    var relayout: () -> Void = {}
    /// an input the user changed (inputs.mjs)
    var input: (_ name: String, _ value: JSONValue) -> Void = { _, _ in }
    /// a button in the strip; true when it went to the agent
    var button: (_ index: Int) async -> Bool = { _ in false }
}

/// One agent's panel as its view sees it.
@MainActor @Observable
final class PanelModel {
    let id: String
    var panel: Panel?
    var ghost: ToolCard?
    let feed: PanelFeed
    /// the size while the corner is dragged (graph units)
    var liveSize: CGSize?
    /// the size drawn now: the target, eased toward when it changes (collapse, maximize)
    var size: CGSize = .zero
    var scale: CGFloat = 1
    /// the last run action's output
    var output: (text: String, ok: Bool)?
    /// a live panel nobody kept yet invites it once
    var inviteKeep = false
    @ObservationIgnored var actions = PanelActions()
    @ObservationIgnored var invited = false

    init(id: String, feed: PanelFeed) { self.id = id; self.feed = feed }

    var title: String { panel?.spec?.title ?? ghost?.name ?? "Panel" }
    var collapsed: Bool { panel?.ui.collapsed ?? false }
    var kept: Bool { panel?.tool != nil }

    /// a running panel that nobody kept: after 12 s the bookmark glows for a while (panels.mjs invite)
    func maybeInvite() {
        guard !invited, let p = panel, p.isRunning, p.tool == nil else { return }
        invited = true
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(12))
            guard let self, !self.kept, self.panel != nil else { return }
            self.inviteKeep = true
            try? await Task.sleep(for: .seconds(5.2))
            self.inviteKeep = false
        }
    }
}

/// the view over the canvas holding one panel; swallows the pointer so the canvas doesn't pan under it
final class PanelHost: NSView {
    let model: PanelModel
    var canvas = "" // like terminals: kept, hidden, while another tab is shown
    let host: NSHostingView<PanelRoot>
    // easing between sizes (graph units)
    var anim: (from: CGSize, to: CGSize, start: CFTimeInterval)?
    var target: CGSize?

    init(model: PanelModel) {
        self.model = model
        host = NSHostingView(rootView: PanelRoot(model: model))
        super.init(frame: .zero)
        host.sizingOptions = []
        addSubview(host)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override func scrollWheel(with e: NSEvent) {}
    override func mouseDown(with e: NSEvent) {}
    override func rightMouseDown(with e: NSEvent) {}
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }

    /// on screen: the panel's SwiftUI view is in the window. Off screen (scrolled away, too small, another tab, the
    /// window covered or minimized) it is taken out, so its live data doesn't re-run its layout and drawing for
    /// nobody; back on screen it draws once with the latest data.
    var live = true {
        didSet {
            guard live != oldValue else { return }
            if live { host.frame = bounds; addSubview(host) } else { host.removeFromSuperview() }
        }
    }

    /// screen origin and the panel's size in graph units at this scale
    func place(origin: CGPoint, size: CGSize, scale: CGFloat) {
        let f = CGRect(x: origin.x, y: origin.y, width: size.width * scale, height: size.height * scale)
        // mid-zoom: keep the laid-out panel and let the bounds scale it to the new size
        if GraphView.liveZoom, model.size == size, model.scale > 0 {
            if frame != f { frame = f }
            setBoundsSize(CGSize(width: size.width * model.scale, height: size.height * model.scale))
            return
        }
        if frame != f { frame = f }
        if bounds.size != frame.size { setBoundsSize(frame.size) }
        if host.frame != bounds { host.frame = bounds }
        if model.scale != scale { model.scale = scale }
        if model.size != size { model.size = size }
    }
}

/// the panel at its graph size, scaled to the canvas's zoom
struct PanelRoot: View {
    let model: PanelModel
    var body: some View {
        let s = model.scale, size = model.size
        Group {
            if model.panel != nil { PanelChrome(model: model) }
            else if model.ghost != nil { GhostPanel(model: model) }
        }
        .frame(width: max(1, size.width), height: max(1, size.height))
        .scaleEffect(s, anchor: .topLeading)
        .frame(width: size.width * s, height: size.height * s, alignment: .topLeading)
    }
}

extension GraphView {
    static let panelGap: CGFloat = 14           // panels.mjs GAP
    static let panelStrip: CGFloat = 34         // COLLAPSED_W
    static let panelMax = CGSize(width: 1000, height: 680) // MAX
    static let ghostSize = CGSize(width: 520, height: 340)
    static let panelMinScale: CGFloat = 0.3     // below this a panel is unreadable; it hides

    /// the panel's size next to a node, in graph units (panels.mjs layout / extent)
    func panelSize(_ a: Agent) -> CGSize? {
        if let p = a.panel, p.spec != nil {
            if p.ui.collapsed { return CGSize(width: Self.panelStrip, height: rectOf(a).height) }
            if let live = panels[a.id]?.model.liveSize { return live }
            if p.ui.maximized { return Self.panelMax }
            return CGSize(width: p.ui.size.first ?? 560, height: p.ui.size.last ?? 400)
        }
        return store?.ghosts[a.id] != nil ? Self.ghostSize : nil
    }

    /// true while a panel eases to a new size
    var panelsMoving: Bool { panels.values.contains { $0.anim != nil } }

    /// the window is actually on screen (not covered, minimized or on another space)
    var windowShown: Bool { isSnapshotting || (window?.occlusionState.contains(.visible) ?? false) }

    /// opens, places and closes the panel views to match the agents
    func layoutPanels() {
        guard let store else { return }
        var keep = Set<String>()
        let now = CACurrentMediaTime()
        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        for a in agents {
            guard let size = panelSize(a) else { continue }
            keep.insert(a.id)
            let h = panels[a.id] ?? {
                let m = PanelModel(id: a.id, feed: store.feeds.feed(a.id))
                m.actions = panelActions(a.id)
                let h = PanelHost(model: m)
                h.canvas = store.currentId ?? ""
                addSubview(h)
                panels[a.id] = h
                return h
            }()
            let m = h.model
            let panel = a.panel?.spec != nil ? a.panel : nil
            if m.panel != panel { m.panel = panel; m.maybeInvite() }
            let ghost = panel == nil ? store.ghosts[a.id] : nil
            if m.ghost != ghost { m.ghost = ghost }
            // a new size eases in (collapsing into the strip, maximizing); a dragged corner follows at once
            if h.target != size {
                if let from = h.target, m.liveSize == nil, !reduce, !isSnapshotting { h.anim = (h.anim.map { _ in m.size } ?? from, size, now) }
                h.target = size
            }
            var shown = size
            if let an = h.anim {
                let t = min(1, (now - an.start) / 0.42)
                if t >= 1 { h.anim = nil } else {
                    let k = Self.spring(t)
                    shown = CGSize(width: an.from.width + (an.to.width - an.from.width) * k, height: an.from.height + (an.to.height - an.from.height) * k)
                }
            }
            h.isHidden = scale < Self.panelMinScale || a.isCollapsed
            let r = rectOf(a)
            h.place(origin: CGPoint(x: (r.maxX + Self.panelGap + offset.x) * scale, y: (r.minY + offset.y) * scale), size: shown, scale: scale)
            h.live = !h.isHidden && windowShown && h.frame.intersects(bounds)
        }
        for (id, h) in panels where !keep.contains(id) {
            if h.canvas == (store.currentId ?? "") { h.removeFromSuperview(); panels[id] = nil; BrickMemos.drop(owner: id) } else { h.isHidden = true; h.live = false }
        }
        layoutIDEs()
    }

    /// an underdamped spring, settled by t = 1 (a little overshoot, like the web's cubic-bezier(.3,1.6,.5,1))
    static func spring(_ t: CGFloat) -> CGFloat {
        let z: CGFloat = 0.7, w: CGFloat = 10, wd = w * (1 - z * z).squareRoot()
        return 1 - exp(-z * w * t) * (cos(wd * t) + z * w / wd * sin(wd * t))
    }

    func closeAllPanels() {
        for h in panels.values { h.removeFromSuperview() }
        panels = [:]
        closeAllIDEs()
    }

    /// the panel's frame in window coordinates (where a kept panel flies from)
    func panelWindowRect(_ id: String) -> CGRect? {
        guard let h = panels[id], !h.isHidden else { return nil }
        return h.convert(h.bounds, to: nil)
    }

    func panelActions(_ id: String) -> PanelActions {
        var a = PanelActions()
        a.ui = { [weak self] c, m, s in self?.store.panelUI(id, collapsed: c, maximized: m, size: s); self?.kick() }
        a.approve = { [weak self] always in self?.store.approvePanel(id, always: always) }
        a.reject = { [weak self] in self?.store.rejectPanel(id) }
        a.refresh = { [weak self] in self?.store.refreshPanel(id) }
        a.remove = { [weak self] in self?.actions.removePanel(id) }
        a.keep = { [weak self] in self?.actions.keepPanel(id) }
        a.action = { [weak self] view, index, row in await self?.runAction(id, view: view, index: index, row: row) ?? false }
        a.useGhost = { [weak self] in guard let self, let t = self.store.ghosts[id] else { return }; self.store.useTool(id, t) }
        a.dismissGhost = { [weak self] in self?.store.dismissGhost(id); self?.kick() }
        a.tell = { [weak self] text in self?.store.tell(id, text) }
        a.setSpec = { [weak self] spec in
            do { try await self?.store.setPanelSpec(id, spec); return nil } catch { return error.localizedDescription }
        }
        a.relayout = { [weak self] in self?.layoutPanels(); self?.needsDisplay = true }
        a.input = { [weak self] name, value in self?.store.setPanelInputs(id, [name: value]) }
        a.button = { [weak self] index in await self?.runButton(id, index) ?? false }
        return a
    }

    /// a button in the panel's strip: like a row action, without a row
    func runButton(_ id: String, _ index: Int) async -> Bool {
        guard let m = panels[id]?.model else { return false }
        do {
            let r = try await store.panelButton(id, index: index)
            if r.sent == true { return true }
            m.output = ("$ \((r.argv ?? []).joined(separator: " "))\n\(r.output ?? "")", r.code == 0)
        } catch {
            m.output = (error.localizedDescription, false)
        }
        return false
    }

    /// a row action: `ask` goes to the agent (its node pulses), `run` shows the program's output under the panel
    func runAction(_ id: String, view: String, index: Int, row: JSONValue) async -> Bool {
        guard let m = panels[id]?.model else { return false }
        do {
            let r = try await store.panelAction(id, view: view, index: index, row: row)
            if r.sent == true { return true }
            m.output = ("$ \((r.argv ?? []).joined(separator: " "))\n\(r.output ?? "")", r.code == 0)
        } catch {
            m.output = (error.localizedDescription, false)
        }
        return false
    }
}
