import AppKit
import SwiftUI
import TaksimKit

// The opening as layers: built once, then played by Core Animation's render server, so that nothing the app
// does meanwhile (the canvas building under it, the engine starting) can make it stall or skip. The numbers are
// the ones the Canvas drawing in Launch.swift has (it stays for snapshots): each animation is that drawing's
// value, sampled every 1/60 s over the whole opening. Layers use y-up coordinates; the board's own y-down
// numbers come through one flipped transform.

/// the opening's times: when each line's head leaves the logo, the star, and the flight start (seconds)
struct OpeningTimeline {
    var lastThrough = 0.0, lastOut = 0.0
    init(_ roads: [TaksimMark.Road]) {
        for r in roads {
            let thr = r.at / 1000 + Opening.pass * r.inside.upperBound
            lastThrough = max(lastThrough, thr); lastOut = max(lastOut, thr + Opening.tail)
        }
    }
    var starAt: Double { lastThrough + Opening.starPause }
    var flyAt: Double { max(lastOut, starAt + Opening.starTime) + Opening.settle }
    var total: Double { flyAt + Opening.flight + Opening.glint + 0.1 }
}

struct OpeningStageView: NSViewRepresentable {
    let target: CGRect?
    let onFlight: () -> Void
    let finish: () -> Void
    func makeNSView(context: Context) -> OpeningStage {
        let v = OpeningStage()
        v.target = target; v.onFlight = onFlight; v.finish = finish
        return v
    }
    func updateNSView(_ v: OpeningStage, context: Context) {
        v.target = target; v.onFlight = onFlight; v.finish = finish
        v.startIfReady()
    }
}

final class OpeningStage: NSView {
    var target: CGRect?
    var onFlight: () -> Void = {}
    var finish: () -> Void = {}
    /// a test: no animations, the layers hold the values of this many seconds into the opening
    var standAt: Double?
    /// a test's window is off screen: it plays all the same
    var playsUnseen = false
    private let stage = CALayer()
    /// the centre mark's layers and the flight's, for a test to watch while it plays
    private(set) var boardLayer: CALayer?
    private(set) var flightLayer: CALayer?
    var timeline: OpeningTimeline?
    private var built = false
    private var flying = false
    private var waitedForTarget = false
    private var observer: NSObjectProtocol?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.addSublayer(stage)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func hitTest(_ point: NSPoint) -> NSView? { flying ? nil : super.hitTest(point) }
    override func layout() { super.layout(); stage.frame = bounds; startIfReady() }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        observer.map(NotificationCenter.default.removeObserver); observer = nil
        guard let window else { return }
        // an opening nobody can see waits for the window to be seen
        observer = NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: window, queue: .main) { [weak self] _ in
            self?.startIfReady()
        }
        startIfReady()
    }
    deinit { observer.map(NotificationCenter.default.removeObserver) }

    func startIfReady() {
        guard !built, bounds.width > 0, bounds.height > 0, let window, window.occlusionState.contains(.visible) || standAt != nil || playsUnseen else { return }
        // where the mark lands is known a moment after the first layout; wait for it a little, not for ever
        if target == nil && !waitedForTarget {
            waitedForTarget = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.startIfReady() }
            return
        }
        build()
    }

    /// the layers alone, for a renderer that is handed a moment (tests)
    func detachedLayers() -> CALayer {
        stage.frame = bounds
        if !built { build() }
        return stage
    }

    // ---------- building ----------

    private func cg(_ c: Color) -> CGColor {
        var out = NSColor(c).cgColor
        effectiveAppearance.performAsCurrentDrawingAppearance { out = NSColor(c).cgColor }
        return out
    }

    /// a layer whose own coordinates are the parent's, over a plane big enough for the lines that start far out
    private func plane<T: CALayer>(_ l: T) -> T {
        l.bounds = CGRect(x: -6000, y: -6000, width: 12000, height: 12000)
        l.position = .zero
        return l
    }

    private func keyframes(_ keyPath: String, _ values: [Any], total: Double, begin: CFTimeInterval) -> CAKeyframeAnimation {
        let a = CAKeyframeAnimation(keyPath: keyPath)
        a.values = values
        a.keyTimes = values.indices.map { NSNumber(value: Double($0) / Double(max(1, values.count - 1))) }
        a.calculationMode = .linear
        a.duration = total
        a.beginTime = begin
        a.fillMode = .both
        a.isRemovedOnCompletion = false
        return a
    }

    /// plays `values` on the layer; standing at a moment (tests), the layer simply takes that moment's value
    private func animate(_ layer: CALayer, _ keyPath: String, _ values: [Any], total: Double, begin: CFTimeInterval, key: String) {
        guard let t = standAt else {
            layer.add(keyframes(keyPath, values, total: total, begin: begin), forKey: key)
            return
        }
        let value = values[min(values.count - 1, max(0, Int((t / total * Double(values.count - 1)).rounded())))]
        if keyPath == "transform.scale", let v = value as? Double { layer.setAffineTransform(CGAffineTransform(scaleX: v, y: v)) }
        else { layer.setValue(value, forKeyPath: keyPath) }
    }

    /// `f` at every 1/60 s from `from` to `to`
    private func sampled<T>(_ from: Double, _ to: Double, _ f: (Double) -> T) -> [T] {
        let n = max(2, Int(((to - from) * 60).rounded(.up)) + 1)
        return (0..<n).map { f(from + (to - from) * Double($0) / Double(n - 1)) }
    }

    private func build() {
        built = true
        let size = bounds.size
        let side = min(Opening.maxSide, min(size.width, size.height) * 0.4)
        let home = CGRect(x: (size.width - side) / 2, y: (size.height - side) / 2, width: side, height: side)
        let k = side / Opening.board
        let far = 500 - Double(max(size.width, size.height)) / 2 / k - 80
        let roads = TaksimMark.roads(far: far)
        let tl = OpeningTimeline(roads)
        let total = tl.total
        let accent = cg(JB.accent), ground = cg(JB.bg)
        let begin: CFTimeInterval
        if standAt != nil { begin = 0 } else { begin = CACurrentMediaTime() + 0.05 }
        let H = size.height
        func up(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x, y: H - p.y) }   // the view's y-down point as a layer's

        // the ground, which lets go as the mark leaves
        let back = CALayer()
        back.frame = bounds; back.backgroundColor = ground
        animate(back, "opacity", sampled(0, total) { t in t < tl.flyAt ? 1.0 : 1 - (1 - pow(1 - Opening.clamp((t - tl.flyAt) / 0.55), 2)) }, total: total, begin: begin, key: "ground")
        stage.addSublayer(back)

        // the board: 1000 × 1000, y down, at home
        let board = CALayer()
        board.bounds = CGRect(x: 0, y: 0, width: Opening.board, height: Opening.board)
        board.anchorPoint = .zero
        board.position = up(home.origin)
        board.setAffineTransform(CGAffineTransform(scaleX: k, y: -k))
        animate(board, "opacity", sampled(0, total) { $0 < tl.flyAt ? 1.0 : 0.0 }, total: total, begin: begin, key: "gone")
        stage.addSublayer(board)
        boardLayer = board
        timeline = tl

        // the lines, outside the logo only (the logo is drawn below)
        let outside = plane(CALayer())
        let huge = CGMutablePath()
        huge.addRect(CGRect(x: -9000, y: -9000, width: 19000, height: 19000))
        huge.addPath(TaksimMark.silhouette())
        let cut = plane(CAShapeLayer())
        cut.path = huge; cut.fillRule = .evenOdd; cut.fillColor = NSColor.black.cgColor
        outside.mask = cut
        board.addSublayer(outside)
        // the logo, shown where a head has passed
        let logo = plane(CAShapeLayer())
        logo.path = TaksimMark.full; logo.fillColor = accent
        let shown = plane(CALayer())
        logo.mask = shown
        board.addSublayer(logo)

        for r in roads {
            let p = { (t: Double) in Opening.clamp((t - r.at / 1000) / Opening.pass) }
            let q = { (t: Double) in Opening.easeIn(Opening.clamp((t - (r.at / 1000 + Opening.pass * r.inside.upperBound)) / Opening.tail)) }
            let line = plane(CAShapeLayer())
            line.path = r.path; line.fillColor = nil; line.strokeColor = accent; line.lineWidth = r.width; line.lineCap = .butt
            line.strokeStart = 0; line.strokeEnd = 0
            animate(line, "strokeStart", sampled(0, total) { min(q($0), p($0)) }, total: total, begin: begin, key: "tail")
            animate(line, "strokeEnd", sampled(0, total) { p($0) }, total: total, begin: begin, key: "head")
            outside.addSublayer(line)
            let uncover = plane(CAShapeLayer())
            uncover.path = r.path; uncover.fillColor = nil; uncover.strokeColor = NSColor.black.cgColor; uncover.lineWidth = r.width
            uncover.strokeEnd = 0
            animate(uncover, "strokeEnd", sampled(0, total) { p($0) }, total: total, begin: begin, key: "reveal")
            shown.addSublayer(uncover)
        }

        // the star on its own: a circle growing over the logo
        let starLogo = plane(CAShapeLayer())
        starLogo.path = TaksimMark.full; starLogo.fillColor = accent
        let disc = CAShapeLayer()
        disc.bounds = CGRect(x: 0, y: 0, width: 364, height: 364)
        disc.position = CGPoint(x: 500, y: 500)
        disc.path = CGPath(ellipseIn: disc.bounds, transform: nil)
        disc.fillColor = NSColor.black.cgColor
        disc.setAffineTransform(CGAffineTransform(scaleX: 0.0001, y: 0.0001))
        animate(disc, "transform.scale", sampled(0, total) { max(0.0001, $0 < tl.starAt ? 0 : Opening.pop(Opening.clamp(($0 - tl.starAt) / Opening.starTime))) }, total: total, begin: begin, key: "pop")
        starLogo.mask = disc
        board.addSublayer(starLogo)

        buildFlight(total: total, begin: begin, tl: tl, home: home, accent: accent, up: up)

        // the end: the roads' part is over (nothing behind may be pressed through it), then everything
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05 + tl.flyAt) { [weak self] in self?.flying = true; self?.onFlight() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05 + total) { [weak self] in self?.finish() }
    }

    private func buildFlight(total: Double, begin: CFTimeInterval, tl: OpeningTimeline, home: CGRect, accent: CGColor, up: (CGPoint) -> CGPoint) {
        let side = home.width
        let from = home.insetBy(dx: side * 0.1, dy: side * 0.1)
        let to = target ?? from
        let a = CGPoint(x: from.midX, y: from.midY), b = CGPoint(x: to.midX, y: to.midY)
        let dx = b.x - a.x, dy = b.y - a.y
        let ctrl = CGPoint(x: (a.x + b.x) / 2 - dy * 0.22, y: (a.y + b.y) / 2 + dx * 0.22)
        func ease(_ x: Double) -> Double { x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2 }
        func q(_ t: Double) -> Double { ease(Opening.clamp(t / Opening.flight)) }
        func pos(_ q: Double) -> CGPoint {
            let u = 1 - q
            return CGPoint(x: u * u * a.x + 2 * u * q * ctrl.x + q * q * b.x, y: u * u * a.y + 2 * u * q * ctrl.y + q * q * b.y)
        }
        func sz(_ q: Double) -> Double { from.width + (to.width - from.width) * q }
        let fly0 = tl.flyAt
        // the flight's own time at every sample of the whole opening (0 before it starts)
        func flightTime(_ t: Double) -> Double { max(0, t - fly0) }
        let flightGroup = CALayer()
        flightGroup.frame = bounds
        flightGroup.opacity = 0
        animate(flightGroup, "opacity", sampled(0, total) { $0 < fly0 ? 0.0 : 1.0 }, total: total, begin: begin, key: "appear")
        stage.addSublayer(flightGroup)
        flightLayer = flightGroup

        // the tail: where it was a moment ago, thinner and fainter the further back
        let n = 26
        for i in 0..<n {
            let fade = 1 - Double(i) / Double(n)
            for inner in [false, true] where !inner || i < 12 {
                let seg = CAShapeLayer()
                seg.frame = bounds
                seg.fillColor = nil; seg.lineCap = .round
                seg.strokeColor = inner ? NSColor.white.cgColor : accent
                seg.opacity = 0
                let ts = sampled(0, total) { $0 }
                func segment(_ t: Double) -> (CGPath, Double, Double) {
                    let ft = flightTime(t), now = q(ft)
                    let q0 = q(ft - Double(i) * 0.014), q1 = q(ft - Double(i + 1) * 0.014)
                    let path = CGMutablePath()
                    path.move(to: up(pos(q0))); path.addLine(to: up(pos(q1)))
                    let on = t >= fly0 && now > 0.001 && now < 0.999
                    let width = inner ? max(0.8, sz(q0) * 0.14 * fade) : max(1, sz(q0) * 0.46 * fade)
                    let alpha = on ? (inner ? pow(fade, 2) * 0.55 : pow(fade, 1.6) * 0.9) : 0
                    return (path, width, alpha)
                }
                let frames = ts.map(segment)
                animate(seg, "path", frames.map { $0.0 }, total: total, begin: begin, key: "path")
                animate(seg, "lineWidth", frames.map { $0.1 }, total: total, begin: begin, key: "width")
                animate(seg, "opacity", frames.map { $0.2 }, total: total, begin: begin, key: "alpha")
                flightGroup.addSublayer(seg)
            }
        }

        // the mark itself: the cross shrinks into the header's small cut as it goes
        func markLayer(small: Bool, color: CGColor) -> CAShapeLayer {
            let l = CAShapeLayer()
            l.bounds = CGRect(x: 0, y: 0, width: TaksimMark.crop.width, height: TaksimMark.crop.height)
            var t = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: -TaksimMark.crop.minX, ty: TaksimMark.crop.maxY)   // y down → up, to the layer's corner
            l.path = (small ? TaksimMark.compact : TaksimMark.full).copy(using: &t)
            l.fillColor = color
            return l
        }
        func place(_ l: CALayer, opacity: (Double) -> Double) {
            animate(l, "position", sampled(0, total) { NSValue(point: up(pos(q(flightTime($0))))) }, total: total, begin: begin, key: "position")
            animate(l, "transform.scale", sampled(0, total) { sz(q(flightTime($0))) / TaksimMark.crop.width }, total: total, begin: begin, key: "scale")
            animate(l, "opacity", sampled(0, total) { opacity(Opening.clamp((q(flightTime($0)) - 0.35) / 0.5)) }, total: total, begin: begin, key: "swap")
            flightGroup.addSublayer(l)
        }
        place(markLayer(small: false, color: accent)) { 1 - $0 }
        place(markLayer(small: true, color: accent)) { $0 }

        // the glint: a four-pointed star flashing once on the landed mark
        let at = up(b)
        let g = { (t: Double) in Opening.clamp((flightTime(t) - Opening.flight) / Opening.glint) }
        let f = { (t: Double) -> Double in let x = g(t); return x > 0 && x < 1 ? sin(Double.pi * x) : 0 }
        let glow = CAGradientLayer()
        glow.type = .radial
        glow.colors = [accent.copy(alpha: 0.55) ?? accent, accent.copy(alpha: 0) ?? accent]
        glow.startPoint = CGPoint(x: 0.5, y: 0.5); glow.endPoint = CGPoint(x: 1, y: 1)
        glow.bounds = CGRect(x: 0, y: 0, width: 100, height: 100); glow.position = at; glow.opacity = 0
        animate(glow, "opacity", sampled(0, total) { f($0) }, total: total, begin: begin, key: "glow")
        animate(glow, "transform.scale", sampled(0, total) { max(0.01, (30 * f($0) + 4) * 1.8 + 14) / 100 }, total: total, begin: begin, key: "grow")
        flightGroup.addSublayer(glow)
        let star = CAShapeLayer()
        let R = 34.0, kk = R * 0.14
        let sp = CGMutablePath()
        sp.move(to: CGPoint(x: 0, y: R))
        sp.addQuadCurve(to: CGPoint(x: R, y: 0), control: CGPoint(x: kk, y: kk))
        sp.addQuadCurve(to: CGPoint(x: 0, y: -R), control: CGPoint(x: kk, y: -kk))
        sp.addQuadCurve(to: CGPoint(x: -R, y: 0), control: CGPoint(x: -kk, y: -kk))
        sp.addQuadCurve(to: CGPoint(x: 0, y: R), control: CGPoint(x: -kk, y: kk))
        star.path = sp; star.fillColor = NSColor.white.cgColor
        star.bounds = CGRect(x: -R, y: -R, width: 2 * R, height: 2 * R); star.position = at; star.opacity = 0
        animate(star, "opacity", sampled(0, total) { 0.95 * f($0) }, total: total, begin: begin, key: "flash")
        animate(star, "transform.scale", sampled(0, total) { max(0.01, (30 * f($0) + 4) / R) }, total: total, begin: begin, key: "size")
        flightGroup.addSublayer(star)
        let sheen = markLayer(small: true, color: NSColor.white.cgColor)
        sheen.position = at; sheen.opacity = 0
        sheen.setAffineTransform(CGAffineTransform(scaleX: to.width / TaksimMark.crop.width, y: to.width / TaksimMark.crop.width))
        animate(sheen, "opacity", sampled(0, total) { 0.4 * f($0) }, total: total, begin: begin, key: "sheen")
        flightGroup.addSublayer(sheen)
    }
}
