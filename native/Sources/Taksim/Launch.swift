import AppKit
import SwiftUI
import TaksimKit

// The opening, and the mark where it lands. Lines run in from the window's edges, pass through the logo as
// the stripes it is made of, and leave by the next edge; they draw themselves back out, the star appears, and
// the logo settles into the header. The same timeline as the website's (site/index.html, OPENING).

/// the mark as a shape, the cross filling the rect (the board's empty margin is cropped away)
struct MarkShape: Shape {
    var small = false
    func path(in rect: CGRect) -> Path {
        let t = CGAffineTransform(translationX: rect.minX, y: rect.minY)
            .scaledBy(x: rect.width / TaksimMark.crop.width, y: rect.height / TaksimMark.crop.height)
            .translatedBy(x: -TaksimMark.crop.minX, y: -TaksimMark.crop.minY)
        return Path(small ? TaksimMark.compact : TaksimMark.full).applying(t)
    }
}

/// where the header's mark sits, so the opening knows where to land
struct MarkAnchorKey: PreferenceKey {
    static let defaultValue: Anchor<CGRect>? = nil
    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) { value = value ?? nextValue() }
}

enum Opening {
    /// from a road's first edge to its other, at one steady speed (seconds)
    static let pass = 1.8
    /// how long a line then takes to draw itself back out
    static let tail = 0.8
    /// the star comes this long after the last head has left the logo
    static let starPause = 0.12, starTime = 0.5
    /// a breath before the mark flies to its corner
    static let settle = 0.15
    /// the flight to the header, like a shooting star, and the glint when it lands (seconds)
    static let flight = 0.75, glint = 0.6
    static let board = 1000.0, maxSide = 260.0

    /// Whether this launch plays it: not for snapshots, tests or when the system asks for less motion.
    static var plays: Bool {
        let env = ProcessInfo.processInfo.environment
        if env["TAKSIM_NO_LAUNCH"] != nil || env.keys.contains(where: { $0.hasPrefix("TAKSIM_SNAPSHOT") }) { return false }
        return !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }

    static func clamp(_ x: Double) -> Double { min(1, max(0, x)) }
    static func easeIn(_ x: Double) -> Double { x * x * (2 - x) * 0.6 + x * x * x * 0.4 }
    /// ease-out with a little overshoot, for the star
    static func pop(_ x: Double) -> Double { let c = 1.70158, y = x - 1; return 1 + (c + 1) * y * y * y + c * y * y }
}

struct LaunchView: View {
    let target: CGRect?
    let finish: () -> Void
    /// a snapshot shows the opening at this many seconds, standing still
    var at: Double? = nil
    /// …or the flight to the header at this many seconds
    var flightAt: Double? = nil
    @State private var flying = false

    var body: some View {
        if at != nil || flightAt != nil {
            // a snapshot: the Canvas drawing, standing still at a time
            GeometryReader { geo in
                let side = min(Opening.maxSide, min(geo.size.width, geo.size.height) * 0.4)
                let home = CGRect(x: (geo.size.width - side) / 2, y: (geo.size.height - side) / 2, width: side, height: side)
                let cross = home.insetBy(dx: side * 0.1, dy: side * 0.1)
                ZStack {
                    JB.bg
                    if let t = flightAt { Canvas { ctx, _ in drawFlight(&ctx, from: cross, to: target ?? cross, t: t) } }
                    else if let e = at { Canvas { ctx, size in draw(&ctx, size: size, home: home, e: e) } }
                }
            }
        } else {
            // the opening itself: layers built once and played by Core Animation, whatever the app is busy with
            OpeningStageView(target: target, onFlight: { flying = true }, finish: finish)
                .allowsHitTesting(!flying)
        }
    }

    private typealias Timeline = OpeningTimeline

    private func far(_ size: CGSize, side: Double) -> Double { 500 - Double(max(size.width, size.height)) / 2 / (side / Opening.board) - 80 }

    private func draw(_ ctx: inout GraphicsContext, size: CGSize, home: CGRect, e: Double) {
        let k = home.width / Opening.board
        ctx.translateBy(x: home.minX, y: home.minY)
        ctx.scaleBy(x: k, y: k)
        let roads = TaksimMark.roads(far: far(size, side: Double(home.width)))
        let tl = Timeline(roads)
        let huge = Path { $0.addRect(CGRect(x: -9000, y: -9000, width: 19000, height: 19000)); $0.addPath(Path(TaksimMark.silhouette())) }
        var reveal = Path()
        var outside: [(Path, Double)] = []
        for r in roads {
            let p = Opening.clamp((e - r.at / 1000) / Opening.pass)
            guard p > 0 else { continue }
            let road = Path(r.path)
            let q = Opening.easeIn(Opening.clamp((e - (r.at / 1000 + Opening.pass * r.inside.upperBound)) / Opening.tail))
            if q < p { outside.append((road.trimmedPath(from: q, to: p), r.width)) }
            reveal.addPath(road.trimmedPath(from: 0, to: p).strokedPath(StrokeStyle(lineWidth: r.width)))
        }
        // one layer for all the lines: outside the logo only; the logo itself is drawn below
        if !outside.isEmpty {
            ctx.drawLayer { l in
                l.clip(to: huge, style: FillStyle(eoFill: true))
                for (path, width) in outside { l.stroke(path, with: .color(JB.accent), style: StrokeStyle(lineWidth: width)) }
            }
        }
        let star = Opening.pop(Opening.clamp((e - tl.starAt) / Opening.starTime)) * 182
        let logo = Path(TaksimMark.full)
        ctx.drawLayer { l in
            l.clip(to: reveal)
            l.fill(logo, with: .color(JB.accent))
        }
        // the star on its own: a circle overlapping the roads would cancel them out of one clip
        if star > 0 {
            ctx.drawLayer { l in
                l.clip(to: Path(ellipseIn: CGRect(x: 500 - star, y: 500 - star, width: star * 2, height: star * 2)))
                l.fill(logo, with: .color(JB.accent))
            }
        }
    }

    // ---------- the flight: a shooting star ----------

    /// The mark leaves along a curve, fast in the middle, with a tail that is as long as it is quick; where it
    /// lands it glints once.
    private func drawFlight(_ ctx: inout GraphicsContext, from: CGRect, to: CGRect, t: Double) {
        let a = CGPoint(x: from.midX, y: from.midY), b = CGPoint(x: to.midX, y: to.midY)
        let dx = b.x - a.x, dy = b.y - a.y
        let ctrl = CGPoint(x: (a.x + b.x) / 2 - dy * 0.22, y: (a.y + b.y) / 2 + dx * 0.22)
        func ease(_ x: Double) -> Double { x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2 }
        func q(_ time: Double) -> Double { ease(Opening.clamp(time / Opening.flight)) }
        func pos(_ q: Double) -> CGPoint {
            let u = 1 - q
            return CGPoint(x: u * u * a.x + 2 * u * q * ctrl.x + q * q * b.x, y: u * u * a.y + 2 * u * q * ctrl.y + q * q * b.y)
        }
        func size(_ q: Double) -> Double { from.width + (to.width - from.width) * q }

        let now = q(t), at = pos(now)
        // the tail: where it was a moment ago, thinner and fainter the further back
        if now > 0.001 && now < 0.999 {
            let n = 26
            ctx.drawLayer { l in
                l.addFilter(.blur(radius: 2.5))
                for i in 0..<n {
                    let q0 = q(t - Double(i) * 0.014), q1 = q(t - Double(i + 1) * 0.014)
                    let fade = 1 - Double(i) / Double(n)
                    var seg = Path(); seg.move(to: pos(q0)); seg.addLine(to: pos(q1))
                    l.stroke(seg, with: .color(JB.accent.opacity(pow(fade, 1.6) * 0.9)),
                             style: StrokeStyle(lineWidth: max(1, size(q0) * 0.46 * fade), lineCap: .round))
                    if i < 12 {
                        l.stroke(seg, with: .color(.white.opacity(pow(fade, 2) * 0.55)),
                                 style: StrokeStyle(lineWidth: max(0.8, size(q0) * 0.14 * fade), lineCap: .round))
                    }
                }
            }
        }
        // the mark itself: the cross shrinks into the header's small cut as it goes
        let s = size(now), rect = CGRect(x: at.x - s / 2, y: at.y - s / 2, width: s, height: s)
        let swap = Opening.clamp((now - 0.35) / 0.5)
        ctx.fill(MarkShape().path(in: rect), with: .color(JB.accent.opacity(1 - swap)))
        ctx.fill(MarkShape(small: true).path(in: rect), with: .color(JB.accent.opacity(swap)))

        // the glint: a four-pointed star flashing once on the landed mark
        let g = Opening.clamp((t - Opening.flight) / Opening.glint)
        if g > 0 && g < 1 {
            let f = sin(Double.pi * g), r = 30.0 * f + 4
            ctx.drawLayer { l in
                l.addFilter(.blur(radius: 7))
                l.fill(Path(ellipseIn: CGRect(x: b.x - r * 0.9, y: b.y - r * 0.9, width: r * 1.8, height: r * 1.8)), with: .color(JB.accent.opacity(0.55 * f)))
            }
            var star = Path()
            let k = r * 0.14
            star.move(to: CGPoint(x: b.x, y: b.y - r))
            star.addQuadCurve(to: CGPoint(x: b.x + r, y: b.y), control: CGPoint(x: b.x + k, y: b.y - k))
            star.addQuadCurve(to: CGPoint(x: b.x, y: b.y + r), control: CGPoint(x: b.x + k, y: b.y + k))
            star.addQuadCurve(to: CGPoint(x: b.x - r, y: b.y), control: CGPoint(x: b.x - k, y: b.y + k))
            star.addQuadCurve(to: CGPoint(x: b.x, y: b.y - r), control: CGPoint(x: b.x - k, y: b.y - k))
            ctx.fill(star, with: .color(.white.opacity(0.95 * f)))
            ctx.fill(MarkShape(small: true).path(in: rect), with: .color(.white.opacity(0.4 * f)))
        }
    }
}
