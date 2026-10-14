import CoreGraphics
import TaksimKit

/// A chart's picture as numbers and paths, without layers (bricks.mjs chart): the y range that fits the values
/// and each series' line, area or bars. The chart builds it twice per change, for the picture now and the
/// one it moves to, and lets Core Animation move between them.
struct ChartPlot: Equatable {
    var w: CGFloat
    var lo: Double, hi: Double
    /// the time at x = 0 and pixels per millisecond
    var t0: Double, k: Double

    static let top: CGFloat = 6
    static var bottom: CGFloat { ChartBrick.plotH - 15 }

    func x(_ t: Double) -> CGFloat { CGFloat((t - t0) * k) }
    func y(_ v: Double) -> CGFloat {
        let top = Double(Self.top), bottom = Double(Self.bottom)
        return CGFloat(top + (1 - (v - lo) / ((hi - lo) == 0 ? 1 : hi - lo)) * (bottom - top))
    }
}

struct ChartSeriesPaths {
    var line = CGMutablePath()
    var area = CGMutablePath()
    var bars = CGMutablePath()
    /// the end of the line (where its dot sits)
    var last: CGPoint?
}

enum ChartGeometry {
    /// the y range for these values: a round top a little over the highest, a round floor under negatives,
    /// and for a line far from zero a floor near its values so its movement shows
    static func scale(_ vals: [[Double]], kind: String, stack: Bool) -> (lo: Double, hi: Double) {
        let tops = vals.map { r in stack ? r.filter(\.isFinite).reduce(0, +) : (r.filter(\.isFinite).max() ?? -.infinity) }
        let lows = vals.map { r in min(r.filter(\.isFinite).min() ?? 0, 0) }
        let hiData = max(0, tops.filter(\.isFinite).max() ?? 0), loData = min(0, lows.min() ?? 0)
        let target = Bricks.niceMax(hiData * 1.08 == 0 ? 1 : hiData * 1.08)
        var lo = loData < 0 ? -Bricks.niceMax(-loData * 1.08) : 0
        let finite = vals.flatMap { $0 }.filter(\.isFinite), minData = finite.min() ?? 0
        if kind == "line", !stack, minData > 0, minData > (hiData - minData) * 2 {
            let step = Bricks.niceMax((target - minData) / 3)
            lo = max(0, ((minData - (hiData - minData) * 0.3) / step).rounded(.down) * step)
        }
        return (lo, target)
    }

    /// which points each series draws: those with a value in `vals` (the picture moved to). The picture now is
    /// drawn with the same points, so the two paths have the same parts and Core Animation can move between them.
    static func mask(_ vals: [[Double]], series: Int) -> [[Bool]] {
        (0..<series).map { k in vals.map { ($0[safe: k] ?? .nan).isFinite } }
    }

    /// each series' paths. A live bar stands for the time since the sample before it, ending when it arrived;
    /// with x a bar is centered on its time. `hold` carries a live line's last value on to that x.
    static func paths(times: [Double], vals: [[Double]], mask: [[Bool]], plot p: ChartPlot, kind: String, stack: Bool,
                      xMode: Bool, hold: CGFloat?, everyMs: Double) -> [ChartSeriesPaths] {
        let n = times.count, series = mask.count
        let starts = (0..<n).map { i in i > 0 ? times[i - 1] : times[i] - (n > 1 ? times[1] - times[i] : everyMs) }
        let gaps = zip(times.dropFirst(), times).map { p.x($0) - p.x($1) }
        let gap = xMode ? max(4, min(n > 1 ? (gaps.min() ?? 0) * 0.8 : p.w / 3, (p.w / CGFloat(max(1, n))) * 0.7)) : 0
        var base = [Double](repeating: 0, count: n)
        var out: [ChartSeriesPaths] = []
        for k in 0..<series {
            var s = ChartSeriesPaths()
            let on = mask[k]
            let yv = (0..<n).map { i -> Double in
                let x = vals[i][safe: k] ?? .nan
                return x.isFinite ? (stack ? base[i] + x : x) : (on[i] ? base[i] : .nan)
            }
            if kind == "bar" {
                for i in 0..<n where on[i] {
                    var x0 = xMode ? p.x(times[i]) - gap / 2 : p.x(starts[i]) + 0.5, x1 = xMode ? p.x(times[i]) + gap / 2 : p.x(times[i]) - 0.5
                    if !stack && series > 1 { let part = (x1 - x0) / CGFloat(series); x0 += part * CGFloat(k); x1 = x0 + part }
                    if x1 - x0 < 1 { x1 = x0 + 1 }
                    let yb = p.y(stack ? base[i] : 0), yt = p.y(yv[i])
                    s.bars.addRect(CGRect(x: x0, y: min(yb, yt), width: x1 - x0, height: abs(yb - yt)))
                }
            } else {
                var upper: [(CGPoint, Int)] = [], pen = false
                for i in 0..<n {
                    guard on[i] else { pen = false; continue }
                    let pt = CGPoint(x: p.x(times[i]), y: p.y(yv[i]))
                    if pen { s.line.addLine(to: pt) } else { s.line.move(to: pt) }
                    upper.append((pt, i)); pen = true; s.last = pt
                }
                if let l = s.last, let h = hold {
                    let e = CGPoint(x: h, y: l.y)
                    s.line.addLine(to: e); upper.append((e, n - 1)); s.last = e
                }
                if kind == "area", let first = upper.first {
                    s.area.move(to: first.0)
                    for (pt, _) in upper.dropFirst() { s.area.addLine(to: pt) }
                    for (pt, i) in upper.reversed() { s.area.addLine(to: CGPoint(x: pt.x, y: p.y(stack ? base[i] : max(p.lo, 0)))) }
                    s.area.closeSubpath()
                }
            }
            if stack { for i in 0..<n where yv[i].isFinite { base[i] = yv[i] } }
            out.append(s)
        }
        return out
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
