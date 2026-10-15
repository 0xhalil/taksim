import AppKit
import QuartzCore
import SwiftUI
import TaksimKit

/// An animated picture an agent designs from shapes, to explain something (src/bricks/scene.mjs is the meaning,
/// TaksimKit Scene.swift its port): the scene's size scaled to the brick's width, its steps played once when the
/// view first shows (or looped), keyed shapes gliding to new data.
///
/// Drawn with Core Animation: every shape is a layer, and each one's whole timeline is one keyframe animation per
/// property, built once and run by the render server. Between steps and after them the app does nothing.
struct SceneBrick: BrickView {
    static let name = "scene"
    static var showsAge: Bool { false }
    let ctx: BrickContext
    init(ctx: BrickContext) { self.ctx = ctx }

    @Environment(\.stillMotion) private var still
    @Environment(\.isSnapshot) private var isSnapshot
    @Environment(\.brickZoom) private var zoom
    @Environment(\.colorScheme) private var scheme
    @State private var player = ScenePlayer()
    @State private var hover = false

    var body: some View {
        let ctx = ctx, player = player
        let size = SceneMath.sceneSize(ctx.view.raw)
        let w = max(1, ctx.width), h = max(1, (w * CGFloat(size.h / size.w)).rounded())
        if isSnapshot {
            LayerBrickSnapshot(size: CGSize(width: w, height: h), dark: scheme == .dark, make: { SceneLayerView() }, update: { $0.update(ctx) })
        } else {
            LayerBrick(make: { () -> SceneLayerView in let v = SceneLayerView(); player.view = v; return v }, update: { (v: SceneLayerView) in v.update(ctx); player.ctx = ctx }, zoom: zoom, still: still)
                .frame(height: h)
                // its controls come with the pointer (and stay while a movie is written)
                .overlay(alignment: .bottom) {
                    if !ctx.preview, hover || player.exporting || player.editing {
                        SceneControls(player: player, title: ctx.view.heading).padding(6).transition(.opacity)
                    }
                }
                .onHover { hover = $0 }
                .animation(.easeOut(duration: 0.18), value: hover)
        }
    }
}

/// which spec a scene already played, so a view made again (the panel scrolled back, the canvas re-rendered)
/// doesn't replay it
final class SceneMemo { var played: JSONValue? }

// ---------- what a shape looks like ----------

/// one shape's look at one moment, in scene units
struct SceneLook {
    /// a text shape's text; nil for drawn shapes
    var text: String?
    var fillPath: CGPath = CGMutablePath()
    var strokePath: CGPath = CGMutablePath()
    /// theme words (SceneMath.colors); a text's color is its fill
    var fill: String?
    var fillAlpha: CGFloat = 1
    var stroke: String?
    var width: CGFloat = 1.5
    var dash: [NSNumber]?
    var opacity: CGFloat = 1
    /// where grow and indicate scale from
    var center: CGPoint = .zero
    // text
    var size: CGFloat = 12
    var weight: NSFont.Weight = .regular
    /// 0 left, 0.5 centered, 1 right of x
    var align: CGFloat = 0
    /// x and the baseline
    var origin: CGPoint = .zero
    var rotate: CGFloat = 0

    var hasStroke: Bool { stroke != nil && width > 0 && !strokePath.isEmpty }
    var hasFill: Bool { fill != nil && !fillPath.isEmpty }
}

enum SceneGeometry {
    /// a shape's fields -> its paths and colors
    static func look(_ s: SceneMath.Shape, scene: (w: Double, h: Double)) -> SceneLook {
        var l = SceneLook()
        func n(_ k: String) -> CGFloat? { s.num(k).map { CGFloat($0) } }
        func given(_ k: String) -> Bool { s[k] != nil && s[k] != .null && s[k] != .string("") }
        func token(_ v: JSONValue?, _ fallback: String) -> String? { let t = SceneMath.colorToken(v, fallback: fallback); return t == "none" ? nil : t }
        l.opacity = min(1, max(0, n("opacity") ?? 1))
        l.rotate = n("rotate") ?? 0
        l.width = max(0, n("width") ?? 1.5)
        switch s["dash"] {
        case .number(let d)? where d > 0: l.dash = [NSNumber(value: d), NSNumber(value: d)]
        case .array(let a)?: let d = a.map { SceneMath.jsNumber($0) }.filter { $0.isFinite && $0 >= 0 }; l.dash = d.isEmpty ? nil : d.map { NSNumber(value: $0) }
        case .bool(true)?: l.dash = [4, 3]
        case .string(let t)? where !t.isEmpty:
            let d = t.split(whereSeparator: { $0 == " " || $0 == "," }).compactMap { Double($0) }
            l.dash = d.isEmpty ? nil : d.map { NSNumber(value: $0) }
        default: break
        }

        let type = s.type
        if type == "text" {
            l.text = SceneMath.text(s["text"])
            l.size = max(1, n("size") ?? 12)
            l.weight = weight(s["weight"])
            switch s["align"]?.string {
            case "middle"?, "center"?: l.align = 0.5
            case "end"?, "right"?: l.align = 1
            default: l.align = 0
            }
            l.origin = CGPoint(x: n("x") ?? 0, y: n("y") ?? 0)
            l.fill = token(given("color") ? s["color"] : s["fill"], "ink")
            return l
        }

        let fillTok = given("fill") ? token(s["fill"], "none") : nil
        l.stroke = given("color") ? token(s["color"], "ink") : (given("fill") ? nil : "ink")
        let x = n("x") ?? 0, y = n("y") ?? 0
        var both: CGPath?
        switch type {
        case "rect":
            let r = CGRect(x: x, y: y, width: n("w") ?? 0, height: n("h") ?? 0).standardized
            let rx = min(max(0, n("rx") ?? 0), r.width / 2, r.height / 2)
            both = rx > 0 ? CGPath(roundedRect: r, cornerWidth: rx, cornerHeight: rx, transform: nil) : CGPath(rect: r, transform: nil)
        case "circle":
            let r = max(0, n("r") ?? 10)
            both = CGPath(ellipseIn: CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2), transform: nil)
        case "ellipse":
            let r = n("r") ?? 10
            let w = max(0, n("w") ?? r * 2), h = max(0, n("h") ?? r * 2)
            both = CGPath(ellipseIn: CGRect(x: x - w / 2, y: y - h / 2, width: w, height: h), transform: nil)
        case "line", "arrow":
            let a = CGPoint(x: x, y: y), b = CGPoint(x: n("x2") ?? x, y: n("y2") ?? y)
            let p = CGMutablePath()
            if type == "arrow" {
                let dx = b.x - a.x, dy = b.y - a.y, len = max(0.0001, hypot(dx, dy))
                let ux = dx / len, uy = dy / len
                let hl = min(len * 0.6, max(7, l.width * 3.5)), hw = hl * 0.55
                let base = CGPoint(x: b.x - ux * hl, y: b.y - uy * hl)
                p.move(to: a); p.addLine(to: CGPoint(x: base.x + ux * 0.5, y: base.y + uy * 0.5))
                let head = CGMutablePath()
                head.move(to: b)
                head.addLine(to: CGPoint(x: base.x - uy * hw, y: base.y + ux * hw))
                head.addLine(to: CGPoint(x: base.x + uy * hw, y: base.y - ux * hw))
                head.closeSubpath()
                l.fillPath = head
                l.fill = l.stroke
            } else {
                p.move(to: a); p.addLine(to: b)
            }
            l.strokePath = p
        case "polyline", "polygon", "area":
            let pts = points(s["points"])
            let p = CGMutablePath()
            if let f = pts.first { p.move(to: f); pts.dropFirst().forEach { p.addLine(to: $0) } }
            if type == "polygon" {
                p.closeSubpath()
                both = p
            } else if type == "area" {
                l.strokePath = p
                let base = n("y") ?? CGFloat(scene.h)
                let a = CGMutablePath()
                if let f = pts.first, let last = pts.last {
                    a.move(to: CGPoint(x: f.x, y: base))
                    pts.forEach { a.addLine(to: $0) }
                    a.addLine(to: CGPoint(x: last.x, y: base))
                    a.closeSubpath()
                }
                l.fillPath = a
                if !given("color") && !given("fill") { l.stroke = "accent" }
                l.fill = fillTok ?? l.stroke
                l.fillAlpha = fillTok != nil ? 1 : 0.22
            } else {
                l.strokePath = p
            }
        case "path":
            both = SVGPath.parse(s["d"]?.string ?? "")
        case "brace":
            l.strokePath = brace(CGPoint(x: x, y: y), CGPoint(x: n("x2") ?? x, y: n("y2") ?? y))
        default: break
        }
        if let both {
            l.strokePath = both
            l.fillPath = both
            l.fill = fillTok
        }
        // rotated about its own middle
        let box = union(l.fillPath, l.strokePath)
        if l.rotate != 0, !box.isNull {
            var t = CGAffineTransform(translationX: box.midX, y: box.midY).rotated(by: l.rotate * .pi / 180).translatedBy(x: -box.midX, y: -box.midY)
            l.fillPath = l.fillPath.copy(using: &t) ?? l.fillPath
            l.strokePath = l.strokePath.copy(using: &t) ?? l.strokePath
        }
        let b = union(l.fillPath, l.strokePath)
        l.center = b.isNull ? .zero : CGPoint(x: b.midX, y: b.midY)
        return l
    }

    static func union(_ a: CGPath, _ b: CGPath) -> CGRect {
        let x = a.isEmpty ? CGRect.null : a.boundingBoxOfPath, y = b.isEmpty ? CGRect.null : b.boundingBoxOfPath
        return x.union(y)
    }

    static func points(_ v: JSONValue?) -> [CGPoint] {
        (v?.array ?? []).compactMap { p in
            guard let c = p.array, c.count >= 2 else { return nil }
            let x = SceneMath.jsNumber(c[0]), y = SceneMath.jsNumber(c[1])
            return x.isFinite && y.isFinite ? CGPoint(x: x, y: y) : nil
        }
    }

    static func weight(_ v: JSONValue?) -> NSFont.Weight {
        let s = v.map { SceneMath.jsString($0) }?.lowercased() ?? ""
        if let n = Double(s) { return n >= 700 ? .bold : n >= 600 ? .semibold : n >= 500 ? .medium : n <= 300 ? .light : .regular }
        switch s {
        case "bold", "heavy", "black": return .bold
        case "semibold": return .semibold
        case "medium": return .medium
        case "light", "thin": return .light
        default: return .regular
        }
    }

    /// a curly brace from a to b, its tip on the right of the way (below a line drawn left to right)
    static func brace(_ a: CGPoint, _ b: CGPoint) -> CGPath {
        let len = hypot(b.x - a.x, b.y - a.y)
        let p = CGMutablePath()
        guard len > 0 else { return p }
        let d = min(14, max(6, len * 0.12)), q = min(d / 2, len / 4), m = len / 2
        p.move(to: .zero)
        p.addQuadCurve(to: CGPoint(x: q, y: q), control: CGPoint(x: 0, y: q))
        p.addLine(to: CGPoint(x: m - q, y: q))
        p.addQuadCurve(to: CGPoint(x: m, y: d), control: CGPoint(x: m, y: q))
        p.addQuadCurve(to: CGPoint(x: m + q, y: q), control: CGPoint(x: m, y: q))
        p.addLine(to: CGPoint(x: len - q, y: q))
        p.addQuadCurve(to: CGPoint(x: len, y: 0), control: CGPoint(x: len, y: q))
        var t = CGAffineTransform(translationX: a.x, y: a.y).rotated(by: atan2(b.y - a.y, b.x - a.x))
        return p.copy(using: &t) ?? p
    }

    /// a shape's fields after a move/transform step reached its `to`
    static func merged(_ s: SceneMath.Shape, _ to: JSONObject) -> SceneMath.Shape {
        var out = s
        for (k, v) in to where k != "id" && k != "type" {
            if ["x", "y", "w", "h", "r", "rx", "x2", "y2", "size", "width", "opacity", "rotate"].contains(k) {
                let n = SceneMath.jsNumber(v)
                if n.isFinite { out.props[k] = .number(n) }
            } else {
                out.props[k] = v
            }
        }
        return out
    }
}

// ---------- the timeline of one shape ----------

/// a shape at one moment of its timeline: its look and how far each verb has got
struct SceneFrame {
    var look: SceneLook
    /// shown at all (fade_in / fade_out, hidden until created)
    var vis: CGFloat = 1
    /// how much of the outline is drawn (create)
    var drawn: CGFloat = 1
    /// how much the fill has come in (create)
    var filled: CGFloat = 1
    /// grow and indicate
    var scale: CGFloat = 1
    /// toward the accent (indicate)
    var tint: CGFloat = 0
    /// how much of a text is written (write)
    var reveal: CGFloat = 1
}

struct SceneKey { var t: Double; var frame: SceneFrame; var ease: String }

enum SceneTimeline {
    /// a shape's keyframes over the plan; the last is where it rests
    static func keys(_ shape: SceneMath.Shape, plan: SceneMath.Plan, scene: (w: Double, h: Double)) -> [SceneKey] {
        var s = shape
        var cur = SceneFrame(look: SceneGeometry.look(s, scene: scene))
        if plan.hidden.contains(shape.id) || SceneMath.truthy(shape["hidden"]) { cur.vis = 0 }
        var out = [SceneKey(t: 0, frame: cur, ease: "linear")]
        let gap = 0.001
        for st in plan.steps where st.targets.contains(shape.id) {
            let lastT = out.last!.t
            let t0 = max(st.start, lastT), d = max(0, st.end - st.start), t1 = t0 + d
            if t0 > lastT { out.append(SceneKey(t: t0, frame: cur, ease: "linear")) }
            func jump(_ f: SceneFrame) { cur = f; out.append(SceneKey(t: out.last!.t + gap, frame: f, ease: "linear")) }
            func to(_ t: Double, _ f: SceneFrame, _ e: String = st.ease) { cur = f; out.append(SceneKey(t: max(t, out.last!.t), frame: f, ease: e)) }
            let isText = cur.look.text != nil
            switch st.verb {
            case "create", "write":
                var a = cur
                a.vis = 1
                if isText {
                    a.reveal = 0; jump(a)
                    a.reveal = 1; to(t1, a, st.raw["ease"] == nil ? "linear" : st.ease)
                } else {
                    let stroke = a.look.hasStroke, fill = a.look.hasFill
                    a.drawn = stroke ? 0 : 1; a.filled = 0; jump(a)
                    if stroke && fill { a.drawn = 1; to(t0 + d * 0.65, a); a.filled = 1; to(t1, a) } else { a.drawn = 1; a.filled = 1; to(t1, a) }
                }
            case "fade_in":
                var a = cur
                a.vis = 0; jump(a)
                a.vis = 1; to(t1, a)
            case "fade_out":
                var a = cur
                a.vis = 0; to(t1, a)
            case "grow":
                var a = cur
                a.vis = 1; a.scale = 0; jump(a)
                a.scale = 1; to(t1, a)
            case "move", "transform":
                if let t = st.to {
                    s = SceneGeometry.merged(s, t)
                    var a = cur
                    a.look = SceneGeometry.look(s, scene: scene)
                    to(t1, a)
                }
            case "indicate":
                var a = cur
                a.scale = 1.15; a.tint = 1; to(t0 + d / 2, a, "smooth")
                a.scale = 1; a.tint = 0; to(t1, a, "smooth")
            default: break
            }
        }
        return out
    }

    static func timing(_ ease: String) -> CAMediaTimingFunction {
        switch ease {
        case "linear": CAMediaTimingFunction(name: .linear)
        case "spring": CAMediaTimingFunction(controlPoints: 0.34, 1.56, 0.64, 1) // back out, as scene.mjs ease
        default: CAMediaTimingFunction(controlPoints: 0.65, 0, 0.35, 1)           // cubic in-out
        }
    }
}

// ---------- the layers ----------

final class QuietText: CATextLayer {
    override func action(forKey event: String) -> CAAction? { nil }
}

/// one shape's layers: a container (opacity, grow), its fill and its outline, or its text (one layer per text
/// it shows, crossfading)
@MainActor final class SceneNode {
    let id: String
    var shape: SceneMath.Shape
    var keys: [SceneKey] = []
    let container = QuietLayer()
    let fill = QuietShape(), stroke = QuietShape()
    /// a text's layers by the text they show
    var texts: [(text: String, layer: QuietText, mask: QuietLayer?)] = []
    var isText: Bool { shape.type == "text" }
    var final: SceneFrame { keys.last?.frame ?? SceneFrame(look: SceneGeometry.look(shape, scene: (100, 100))) }

    init(_ shape: SceneMath.Shape) {
        id = shape.id
        self.shape = shape
        container.anchorPoint = .zero
        if !isText {
            stroke.fillColor = nil
            stroke.lineCap = .round
            stroke.lineJoin = .round
            container.addSublayer(fill)
            container.addSublayer(stroke)
        }
    }
}

final class SceneLayerView: LayerBrickView {
    private let stage = QuietLayer()
    private let empty = TextLayer()
    private var nodes: [String: SceneNode] = [:]
    private var order: [String] = []
    private var spec: JSONValue?
    private var data: JSONValue?
    private var scene: (w: Double, h: Double) = (400, 240)
    private var plan = SceneMath.Plan(steps: [], hidden: [], length: 0)
    private var memo: SceneMemo?
    private var pendingPlay = false
    private var k: CGFloat = 1

    override init(frame: NSRect) {
        super.init(frame: frame)
        stage.anchorPoint = .zero
        stage.masksToBounds = true
        layer!.addSublayer(stage)
        empty.textStyle = .init(size: 12, weight: .regular, mono: false)
        empty.isHidden = true
        layer!.addSublayer(empty)
    }
    required init?(coder: NSCoder) { fatalError() }

    var loop: Bool { spec?["loop"]?.bool == true }
    var moveS: Double { let m = SceneMath.jsNumber(spec?["move_s"]); return m.isFinite && m >= 0 ? min(m, 5) : 0.6 }

    // ---------- data ----------

    func update(_ c: BrickContext) {
        let raw = c.view.raw
        let specChanged = raw != spec, dataChanged = c.data != data
        if memo == nil { memo = BrickMemos.get(c.memoKey + "|scene") { SceneMemo() } }
        guard specChanged || dataChanged || spec == nil else { return }
        spec = raw
        data = c.data
        scene = SceneMath.sceneSize(raw)
        fitStage()
        let shapes = (try? SceneMath.expand(raw, c.data)) ?? []
        plan = SceneMath.schedule(raw, shapes)
        empty.isHidden = !shapes.isEmpty
        if shapes.isEmpty { empty.set("veri yok", color: cg(Pal.muted)); empty.place(x: 0, baseline: 16) }
        if specChanged {
            rebuild(shapes)
            pendingPlay = motion && plan.length > 0 && (loop || memo?.played != raw)
            if pendingPlay, window != nil { play() }
        } else {
            glide(shapes)
        }
    }

    /// the scene's units scaled to the view's width
    private func fitStage() {
        let w = bounds.width > 0 ? bounds.width : CGFloat(scene.w)
        let nk = w / CGFloat(scene.w)
        stage.bounds = CGRect(x: 0, y: 0, width: scene.w, height: scene.h)
        stage.position = .zero
        stage.transform = CATransform3DMakeScale(nk, nk, 1)
        if abs(nk - k) > 0.001 { k = nk; rescale() }
    }

    override func layout() { super.layout(); fitStage() }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard window != nil else { return }
        rescale()
        if pendingPlay, motion { play() }
    }

    override func setScale(_ l: CALayer) {
        let s = textScale * max(1, k)
        if l is CATextLayer || l is CAShapeLayer { l.contentsScale = s }
        l.sublayers?.forEach { setScale($0) }
    }

    override func restyle() {
        // colors again, at rest (a running timeline would hold the old ones)
        for n in nodes.values { n.container.removeAllAnimationsDeep(); show(n, n.final) }
        if !empty.isHidden { empty.set("veri yok", color: cg(Pal.muted)) }
    }

    /// a new spec: every shape anew, at the end of its timeline
    private func rebuild(_ shapes: [SceneMath.Shape]) {
        for n in nodes.values { n.container.removeFromSuperlayer() }
        nodes = [:]
        order = shapes.map(\.id)
        for s in shapes {
            let n = SceneNode(s)
            n.keys = SceneTimeline.keys(s, plan: plan, scene: scene)
            nodes[s.id] = n
            stage.addSublayer(n.container)
            show(n, n.final)
        }
        rescale()
    }

    /// new data: shapes with the same id glide to their new look, new ones fade in, gone ones fade out
    private func glide(_ shapes: [SceneMath.Shape]) {
        let animate = motion && !pendingPlay
        let ids = Set(shapes.map(\.id))
        let dur = moveS
        for (id, n) in nodes where !ids.contains(id) {
            nodes[id] = nil
            n.container.removeAllAnimationsDeep()
            guard animate, dur > 0 else { n.container.removeFromSuperlayer(); continue }
            var gone = n.final
            gone.vis = 0
            run(n, [SceneKey(t: 0, frame: n.final, ease: "linear"), SceneKey(t: dur, frame: gone, ease: "smooth")], total: dur, repeats: false)
            DispatchQueue.main.asyncAfter(deadline: .now() + dur + 0.05) { [weak self] in
                if self?.nodes[id] !== n { n.container.removeFromSuperlayer() }
            }
        }
        var containers: [CALayer] = []
        for s in shapes {
            let keys = SceneTimeline.keys(s, plan: plan, scene: scene)
            if let n = nodes[s.id] {
                let from = n.final
                n.container.removeAllAnimationsDeep()
                n.shape = s
                n.keys = keys
                if animate, dur > 0 {
                    run(n, [SceneKey(t: 0, frame: from, ease: "linear"), SceneKey(t: dur, frame: n.final, ease: "smooth")], total: dur, repeats: false)
                } else { show(n, n.final) }
                containers.append(n.container)
            } else {
                let n = SceneNode(s)
                n.keys = keys
                nodes[s.id] = n
                stage.addSublayer(n.container)
                if animate, dur > 0 {
                    var born = n.final
                    born.vis = 0
                    run(n, [SceneKey(t: 0, frame: born, ease: "linear"), SceneKey(t: dur, frame: n.final, ease: "smooth")], total: dur, repeats: false)
                } else { show(n, n.final) }
                containers.append(n.container)
            }
        }
        order = shapes.map(\.id)
        // drawn in the order written; the ones fading out stay on top of nothing in particular
        let leaving = (stage.sublayers ?? []).filter { l in !containers.contains { $0 === l } }
        stage.sublayers = leaving + containers
        rescale()
    }

    /// the steps, from the start (or from `t` into them): every shape's whole timeline handed to the render
    /// server at once. `clock` is the time base to start on (CARenderer's, for a movie); the screen's by default.
    func play(from t: Double = 0, clock: CFTimeInterval? = nil) {
        pendingPlay = false
        memo?.played = spec
        let total = plan.length + (loop ? 1.2 : 0)
        guard total > 0 else { return }
        // the stage runs on the screen's clock again (a pause or a scrub had stopped it)
        stage.speed = 1; stage.timeOffset = 0; stage.beginTime = 0
        paused = false
        let begin = (clock ?? CACurrentMediaTime() + 0.05) - t
        playBegin = begin
        for id in order { if let n = nodes[id] { n.container.removeAllAnimationsDeep(); run(n, n.keys, total: total, repeats: loop, begin: begin) } }
    }

    // ---------- playback: what the scene's controls do ----------

    private(set) var playBegin: CFTimeInterval = 0
    private(set) var paused = false
    /// the timeline's length in seconds (0: nothing moves)
    var length: Double { plan.length }
    /// how far into the timeline it is now
    var time: Double {
        let at = paused ? stage.timeOffset : CACurrentMediaTime()
        return min(length, max(0, at - playBegin))
    }
    var playing: Bool { !paused && length > 0 && CACurrentMediaTime() - playBegin < length }
    /// holds the picture where it is
    func pause() {
        guard !paused else { return }
        let at = CACurrentMediaTime()
        stage.speed = 0
        stage.timeOffset = at
        paused = true
    }
    /// shows the moment `t` seconds in, held there (the render server draws it; nothing is rebuilt)
    func scrub(_ t: Double) {
        if playBegin == 0 { play(); }
        stage.speed = 0
        stage.timeOffset = playBegin + min(max(0, t), length)
        paused = true
    }
    /// the scene as data and the time base for a movie made from it offscreen (SceneMovie)
    var sceneSize: (w: Double, h: Double) { scene }

    // ---------- frames -> layers ----------

    /// a frame's values, layer by layer and property by property; the same list for every frame of a node
    private func values(_ n: SceneNode, _ f: SceneFrame) -> [(CALayer, String, Any)] {
        let l = f.look
        var out: [(CALayer, String, Any)] = [(n.container, "opacity", NSNumber(value: Float(l.opacity * f.vis)))]
        if n.isText {
            let shown = l.text ?? ""
            for t in n.texts {
                let style = textStyle(n, l)
                let lh = BrickText.lineHeight(style) * l.size / style.size, asc = BrickText.ascender(style) * l.size / style.size
                out.append((t.layer, "opacity", NSNumber(value: t.text == shown ? 1 : 0)))
                out.append((t.layer, "position", NSValue(point: CGPoint(x: l.origin.x, y: l.origin.y - asc + lh / 2))))
                let s = l.size / style.size * f.scale
                let tr = CATransform3DScale(CATransform3DMakeRotation(l.rotate * .pi / 180, 0, 0, 1), s, s, 1)
                out.append((t.layer, "transform", NSValue(caTransform3D: tr)))
                out.append((t.layer, "foregroundColor", color(l.fill, tint: f.tint)))
                if let m = t.mask {
                    out.append((m, "bounds", NSValue(rect: CGRect(x: 0, y: 0, width: (t.layer.bounds.width + 2) * f.reveal, height: t.layer.bounds.height + 4))))
                }
            }
        } else {
            let c = l.center
            var tr = CATransform3DMakeTranslation(c.x, c.y, 0)
            tr = CATransform3DScale(tr, f.scale, f.scale, 1)
            tr = CATransform3DTranslate(tr, -c.x, -c.y, 0)
            out.append((n.container, "transform", NSValue(caTransform3D: tr)))
            out.append((n.fill, "path", l.fillPath))
            out.append((n.fill, "fillColor", color(l.fill, alpha: l.fillAlpha * f.filled, tint: f.tint)))
            out.append((n.stroke, "path", l.strokePath))
            out.append((n.stroke, "strokeColor", color(l.stroke, tint: f.tint)))
            out.append((n.stroke, "lineWidth", NSNumber(value: Double(l.width))))
            out.append((n.stroke, "strokeEnd", NSNumber(value: Double(f.drawn))))
        }
        return out
    }

    private func textStyle(_ n: SceneNode, _ l: SceneLook) -> BrickText.Style {
        // one font size per text shape, its largest, scaled down where it is smaller: sharp, and its size animates
        let size = n.keys.map { $0.frame.look.size }.max() ?? l.size
        return BrickText.Style(size: size, weight: l.weight, mono: false)
    }

    /// the text layers a node's keyframes need, one per text shown
    private func ensureTexts(_ n: SceneNode, _ keys: [SceneKey], masks: Bool) {
        guard n.isText else { return }
        var wanted: [String] = []
        for k in keys { let t = k.frame.look.text ?? ""; if !wanted.contains(t) { wanted.append(t) } }
        for t in n.texts where !wanted.contains(t.text) { t.layer.removeFromSuperlayer() }
        n.texts = n.texts.filter { wanted.contains($0.text) }
        guard let look = keys.last?.frame.look else { return }
        let style = textStyle(n, look)
        for t in wanted {
            let layer: QuietText
            if let i = n.texts.firstIndex(where: { $0.text == t }) { layer = n.texts[i].layer } else {
                layer = QuietText()
                n.container.addSublayer(layer)
                n.texts.append((t, layer, nil))
                setScale(layer)
            }
            layer.font = BrickText.font(style)
            layer.fontSize = style.size
            layer.string = t
            layer.alignmentMode = .left
            layer.bounds = CGRect(x: 0, y: 0, width: BrickText.width(t, style) + 2, height: BrickText.lineHeight(style))
            layer.anchorPoint = CGPoint(x: look.align, y: 0.5)
            guard let i = n.texts.firstIndex(where: { $0.text == t }) else { continue }
            if masks, n.texts[i].mask == nil {
                let m = QuietLayer()
                m.backgroundColor = CGColor(gray: 0, alpha: 1)
                m.anchorPoint = .zero
                m.position = CGPoint(x: -1, y: -2)
                layer.mask = m
                n.texts[i].mask = m
            } else if !masks, let m = n.texts[i].mask {
                m.removeFromSuperlayer()
                layer.mask = nil
                n.texts[i].mask = nil
            }
        }
    }

    /// a frame at rest: the layers' own values, no animation
    private func show(_ n: SceneNode, _ f: SceneFrame) {
        ensureTexts(n, [SceneKey(t: 0, frame: f, ease: "linear")] + n.keys.suffix(1), masks: false)
        for (l, k, v) in values(n, f) { l.setValue(v, forKeyPath: k) }
        if !n.isText { n.stroke.lineDashPattern = f.look.dash }
    }

    /// keyframes over `total` seconds as one animation per property that changes; the layers rest at the last
    private func run(_ n: SceneNode, _ keys: [SceneKey], total: Double, repeats: Bool, begin: CFTimeInterval? = nil) {
        guard let last = keys.last, total > 0 else { return }
        ensureTexts(n, keys, masks: keys.contains { $0.frame.reveal < 1 })
        let frames = keys.map { values(n, $0.frame) }
        guard let lastFrame = frames.last else { return }
        let times = keys.map { NSNumber(value: min(1, max(0, $0.t / total))) } + (last.t < total ? [1] : [])
        let ends = last.t < total
        let timings = keys.dropFirst().map { SceneTimeline.timing($0.ease) } + (ends ? [CAMediaTimingFunction(name: .linear)] : [])
        let start = begin ?? CACurrentMediaTime()
        for (i, (layer, path, final)) in lastFrame.enumerated() {
            var vals = frames.map { $0[i].2 }
            if ends { vals.append(final) }
            layer.setValue(final, forKeyPath: path)
            guard vals.contains(where: { !same($0, vals[0]) }) else { continue }
            let a = CAKeyframeAnimation(keyPath: path)
            a.values = vals
            a.keyTimes = times
            a.timingFunctions = timings
            a.duration = total
            a.beginTime = start
            a.fillMode = .backwards
            if repeats { a.repeatCount = .infinity }
            layer.add(a, forKey: "scene." + path)
        }
        if !n.isText { n.stroke.lineDashPattern = last.frame.look.dash }
    }

    private func same(_ a: Any, _ b: Any) -> Bool {
        let x = a as AnyObject, y = b as AnyObject
        if CFGetTypeID(x) == CGPath.typeID, CFGetTypeID(y) == CGPath.typeID { return (x as! CGPath) == (y as! CGPath) }
        if CFGetTypeID(x) == CGColor.typeID, CFGetTypeID(y) == CGColor.typeID { return (x as! CGColor) == (y as! CGColor) }
        return x.isEqual(y)
    }

    // ---------- colors ----------

    static func palette(_ token: String) -> NSColor? {
        switch token {
        case "ink": Pal.ink
        case "text": Pal.text
        case "muted": Pal.muted
        case "line": Pal.line
        case "panel": Pal.panel
        case "bg": Pal.bg
        case "accent", "s1": Pal.accent
        case "ok": Pal.ok
        case "warn": Pal.warn
        case "err": Pal.err
        case "wait", "s2": Pal.wait
        case "s3": Pal.muted1
        case "s4": Pal.line2
        default: nil
        }
    }

    /// a theme word as this view's appearance resolves it, faded and tinted toward the accent
    private func color(_ token: String?, alpha: CGFloat = 1, tint: CGFloat = 0) -> CGColor {
        guard let token, let ns = Self.palette(token) else { return CGColor(gray: 0, alpha: 0) }
        var out = CGColor(gray: 0, alpha: 0)
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let base = ns.usingColorSpace(.sRGB) ?? ns
            let mixed = tint > 0 ? (base.blended(withFraction: min(1, tint) * 0.85, of: Pal.accent.usingColorSpace(.sRGB) ?? Pal.accent) ?? base) : base
            out = mixed.withAlphaComponent(mixed.alphaComponent * max(0, min(1, alpha))).cgColor
        }
        return out
    }
}

extension CALayer {
    /// this layer's animations and its sublayers', so they rest at their own values
    func removeAllAnimationsDeep() {
        removeAllAnimations()
        mask?.removeAllAnimations()
        sublayers?.forEach { $0.removeAllAnimationsDeep() }
    }
}
