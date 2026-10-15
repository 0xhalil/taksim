import AppKit
import QuartzCore
import SwiftUI
import TaksimKit

/// A live time series (bricks.mjs chart). Every refresh of the source is one sample, stamped when it arrives;
/// the plot scrolls with the clock, the newest value eases in (450 ms), the y scale eases to fit, the latest
/// value is big on the right. With x, rows carry their own time and are plotted as they are. The samples live
/// in a memo (per agent and view), so a re-render doesn't reset them; a preview draws the tool's saved series
/// once, left to right over 900 ms.
///
/// Drawn with Core Animation: a sample rebuilds the paths once and the layers ease to them; the window's scroll
/// is a translation the render server runs, so between samples the app does nothing.
struct ChartBrick: BrickView {
    static let name = "chart"
    let ctx: BrickContext
    init(ctx: BrickContext) { self.ctx = ctx }

    @Environment(\.stillMotion) private var still
    @Environment(\.isSnapshot) private var isSnapshot
    @Environment(\.brickZoom) private var zoom
    @Environment(\.colorScheme) private var scheme

    static let plotH: CGFloat = 110, headH: CGFloat = 26
    static let move = 450.0, introMs = 900.0
    static var palette: [NSColor] { [Pal.accent, Pal.wait, Pal.muted1, Pal.line2] } // the accent first, then quiet ones

    /// what a chart keeps across re-renders
    final class Memo {
        struct Sample { var t: Double; var v: [Double]; var from: [Double]?; var born: Double }
        var samples: [Sample] = []
        var lastAt: Double?
        var lastData: JSONValue?
        var intro = 0.0
        var seeded = false
        /// the y range drawn: easing from one to the other since `start`
        var scale: (from: (lo: Double, hi: Double), to: (lo: Double, hi: Double), start: Double)?
        static func ms() -> Double { Date().timeIntervalSince1970 * 1000 }

        /// the y range on screen at this moment
        func shownScale(_ real: Double) -> (lo: Double, hi: Double)? {
            guard let s = scale else { return nil }
            let k = Bricks.ease((real - s.start) / ChartBrick.move)
            return (s.from.lo + (s.to.lo - s.from.lo) * k, s.from.hi + (s.to.hi - s.from.hi) * k)
        }
    }

    var body: some View {
        let ctx = ctx
        if isSnapshot {
            LayerBrickSnapshot(size: CGSize(width: max(1, ctx.width), height: Self.headH + Self.plotH), dark: scheme == .dark,
                               make: { ChartLayerView() }, update: { $0.update(ctx) })
        } else {
            LayerBrick(make: { ChartLayerView() }, update: { $0.update(ctx) }, zoom: zoom, still: still)
                .frame(height: Self.headH + Self.plotH)
        }
    }
}

final class ChartLayerView: LayerBrickView {
    typealias Memo = ChartBrick.Memo
    private var ctx: BrickContext?
    private var memo: Memo?
    private var memoKey = ""

    // the head: the big latest value and its unit; with several series a legend on the left
    private let headValue = TextLayer(), headUnit = TextLayer()
    private var legend: [(swatch: QuietLayer, name: TextLayer, value: TextLayer)] = []
    // the plot
    private let plot = QuietLayer()
    private let gridLines = QuietShape()
    private let yLabels = (0..<3).map { _ in TextLayer() }
    private let warnLine = QuietShape(), errLine = QuietShape()
    /// the series, cut at the plot's edges; it grows from the left the first time
    private let clip = QuietLayer()
    /// moves left with the clock
    private let scroller = QuietLayer()
    private var series: [(area: QuietShape, line: QuietShape, bars: QuietShape, dot: QuietShape)] = []
    /// a live line's dots stay at "now", the right edge
    private let dots = QuietLayer()
    private let tickClip = QuietLayer(), tickScroller = QuietLayer()
    private var ticks: [TextLayer] = []
    private let hoverLine = QuietShape(), tipBox = QuietShape(), tipText = TextLayer()

    /// what the last rebuild drew
    private struct Built { var times: [Double]; var plot: ChartPlot; var scrollX: CGFloat; var at: Double; var width: CGFloat }
    private var built: Built?
    private var hoverX: CGFloat?
    private var timer: Timer?

    private static let valueStyle = BrickText.Style(size: 22, weight: .semibold, mono: false, digits: true, kern: -0.44)
    private static let unitStyle = BrickText.Style(size: 11.5, weight: .medium, mono: false)
    private static let legendStyle = BrickText.Style(size: 11, weight: .regular, mono: false)
    private static let legendValueStyle = BrickText.Style(size: 11, weight: .semibold, mono: false, digits: true)
    private static let axisStyle = BrickText.Style(size: 9.5, weight: .regular, mono: false, digits: true)
    private static let tipStyle = BrickText.Style(size: 11, weight: .regular, mono: false, digits: true)

    override init(frame: NSRect) {
        super.init(frame: frame)
        let root = layer!
        for l in [headValue, headUnit] as [CALayer] { root.addSublayer(l) }
        root.addSublayer(plot)
        plot.anchorPoint = .zero
        plot.addSublayer(gridLines)
        yLabels.forEach { plot.addSublayer($0) }
        for l in [warnLine, errLine] { l.lineDashPattern = [3, 3]; l.lineWidth = 1; l.fillColor = nil; plot.addSublayer(l) }
        clip.anchorPoint = .zero
        clip.masksToBounds = true
        plot.addSublayer(clip)
        scroller.anchorPoint = .zero
        clip.addSublayer(scroller)
        plot.addSublayer(dots)
        tickClip.anchorPoint = .zero
        tickClip.masksToBounds = true
        plot.addSublayer(tickClip)
        tickScroller.anchorPoint = .zero
        tickClip.addSublayer(tickScroller)
        hoverLine.lineDashPattern = [2, 2]; hoverLine.lineWidth = 1; hoverLine.fillColor = nil
        tipBox.lineWidth = 1
        for l in [hoverLine, tipBox, tipText] as [CALayer] { l.isHidden = true; plot.addSublayer(l) }
        headValue.textStyle = Self.valueStyle
        headUnit.textStyle = Self.unitStyle
        tipText.textStyle = Self.tipStyle
        yLabels.forEach { $0.textStyle = Self.axisStyle }
    }
    required init?(coder: NSCoder) { fatalError() }

    var v: BrickSpec { ctx!.view }
    var ys: [String?] { Bricks.yPaths(v) }
    var names: [String] { ys.map { $0.map { Bricks.pathKeys($0).last ?? $0 } ?? "" } }
    var kind: String { ["line", "area", "bar"].contains(v.string("kind") ?? "") ? v.string("kind")! : "line" }
    var windowMs: Double { max(10, v.number("window_s") ?? 300) * 1000 }
    var xMode: Bool { !(v.string("x") ?? "").isEmpty }
    var scrolls: Bool { !(ctx?.preview ?? true) && (!xMode || v.number("window_s") != nil) }
    var stack: Bool { v["stacked"]?.bool == true && ys.count > 1 }
    func clock(_ real: Double) -> Double { ctx?.preview == true ? (ctx?.now ?? real) : real }

    // ---------- data ----------

    func update(_ c: BrickContext) {
        let specChanged = ctx.map { $0.view != c.view || $0.preview != c.preview } ?? true
        ctx = c
        let key = c.memoKey + (c.preview ? "#preview" : "")
        if memo == nil || key != memoKey {
            memoKey = key
            memo = BrickMemos.get(key) {
                let m = Memo()
                if c.preview || (xMode && m.samples.isEmpty) { m.intro = Memo.ms() }
                return m
            }
        }
        let fresh = ingest(memo!)
        if fresh || specChanged || built == nil { rebuild(animate: !specChanged) }
    }

    /// a sample's value right now: from where it was to where it goes
    func cur(_ p: Memo.Sample, _ real: Double) -> [Double] {
        p.v.enumerated().map { i, val in
            guard let f = p.from?[safe: i], val.isFinite, f.isFinite, motion else { return val }
            return f + (val - f) * Bricks.ease((real - p.born) / ChartBrick.move)
        }
    }

    /// new data: with x the rows are the samples; otherwise one sample per refresh of the source. True when
    /// the picture changes.
    func ingest(_ m: Memo) -> Bool {
        guard let ctx else { return false }
        let real = Memo.ms()
        var changed = false
        if ctx.preview, !m.seeded, !xMode, let s = ctx.series?.array, !s.isEmpty {
            let every = (ctx.everyS ?? 5) * 1000, now = clock(real), n = s.count
            m.samples = s.enumerated().map { i, x in
                Memo.Sample(t: now - Double(n - 1 - i) * every, v: (x.array ?? [x]).map { Bricks.parseNum($0) }, from: nil, born: 0)
            }
            m.seeded = true
            changed = true
        }
        let data = ctx.data
        if xMode {
            guard m.lastData != data else { return changed }
            m.lastData = data
            var old: [Double: Memo.Sample] = [:]
            for p in m.samples { old[p.t] = p }
            let had = !m.samples.isEmpty
            m.samples = Bricks.points(data, v, now: clock(real)).map { p in
                Memo.Sample(t: p.t, v: p.v, from: old[p.t].map { cur($0, real) } ?? p.v.map { _ in had ? 0 : .nan }, born: real)
            }
            return true
        } else if !(ctx.preview && m.seeded), data != .null {
            let at = ctx.state.updatedAt
            if let at { guard at != m.lastAt else { return changed } } else { guard m.samples.isEmpty || m.lastData != data else { return changed } }
            m.lastAt = at
            m.lastData = data
            let val = Bricks.measure(data, v), prev = m.samples.last
            m.samples.append(Memo.Sample(t: clock(real), v: val, from: prev.map { cur($0, real) } ?? val.map { _ in 0 }, born: real))
            // keep the window plus the sample before it
            let cut = clock(real) - windowMs
            while m.samples.count > 2, m.samples[1].t < cut { m.samples.removeFirst() }
            if m.samples.count > 3000 { m.samples.removeFirst(m.samples.count - 3000) }
            return true
        }
        return changed
    }

    // ---------- the picture ----------

    override func layout() {
        super.layout()
        if let b = built, b.width != bounds.width { rebuild(animate: false) }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        timer?.invalidate(); timer = nil
        guard window != nil else { BrickTicker.shared.remove(self); return }
        rescale()
        // the window moves on without new samples too: what scrolled out leaves the scale, new ticks come in
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.scrolls, let b = self.built, Memo.ms() - b.at > 4500 else { return }
                self.rebuild(animate: true)
            }
        }
        timer?.tolerance = 1
        if built != nil { rebuild(animate: false) }
    }

    override func restyle() { if built != nil { rebuild(animate: false) } }

    private func ensureSeries(_ n: Int) {
        while series.count < n {
            let s = (area: QuietShape(), line: QuietShape(), bars: QuietShape(), dot: QuietShape())
            s.line.lineWidth = 1.8; s.line.lineCap = .round; s.line.lineJoin = .round; s.line.fillColor = nil
            s.dot.lineWidth = 1.5
            s.dot.path = CGPath(ellipseIn: CGRect(x: -2.8, y: -2.8, width: 5.6, height: 5.6), transform: nil)
            for l in [s.area, s.bars, s.line] { scroller.addSublayer(l); setScale(l) }
            dots.addSublayer(s.dot)
            setScale(s.dot)
            series.append(s)
        }
        while series.count > n {
            let s = series.removeLast()
            for l in [s.area, s.bars, s.line, s.dot] { l.removeFromSuperlayer() }
        }
    }

    private func ensureLegend(_ n: Int) {
        while legend.count < n {
            let item = (swatch: QuietLayer(), name: TextLayer(), value: TextLayer())
            item.swatch.cornerRadius = 2
            item.name.textStyle = Self.legendStyle
            item.value.textStyle = Self.legendValueStyle
            for l in [item.swatch, item.name, item.value] as [CALayer] { layer!.addSublayer(l); setScale(l) }
            legend.append(item)
        }
        while legend.count > n { let i = legend.removeLast(); [i.swatch, i.name, i.value].forEach { $0.removeFromSuperlayer() } }
    }

    /// draws the samples as they are now and eases to where they go; restarts the scroll
    func rebuild(animate: Bool) {
        guard let ctx, let m = memo else { return }
        let w = bounds.width
        guard w > 0 else { return }
        let real = Memo.ms(), now = clock(real), H = ChartBrick.plotH
        let anim = animate && motion
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }

        // the time window
        let pts = m.samples
        var d0 = now - windowMs, d1 = now
        if !(!xMode || v.number("window_s") != nil), let a = pts.first, let b = pts.last {
            d0 = a.t; d1 = b.t
            let gap = pts.count > 1 ? (zip(pts.dropFirst(), pts).map { $0.t - $1.t }.min() ?? 3_600_000) : 3_600_000
            if kind == "bar" || pts.count == 1 { d0 -= gap / 2; d1 += gap / 2 }
        }
        // what is visible: in a live window also the sample just before it, held up to its edge
        let i0 = pts.firstIndex { $0.t >= d0 } ?? pts.count
        let vis = pts[max(0, i0 - 1)...].filter { $0.t <= d1 }
        let times = vis.map(\.t), to = vis.map(\.v), from = vis.map { cur($0, real) }
        let target = ChartGeometry.scale(to, kind: kind, stack: stack)
        let shown = anim ? (m.shownScale(real) ?? target) : target
        m.scale = (shown, target, real)

        // the layer's x: a live window's x = 0 is "now" and the layer moves left from the right edge
        let k = Double(w) / max(1, d1 - d0)
        let t0 = scrolls ? now : d0
        let scrollX: CGFloat = scrolls ? w : 0
        let hold: CGFloat? = xMode ? nil : (scrolls ? w * 2 : w)
        let plotTo = ChartPlot(w: w, lo: target.lo, hi: target.hi, t0: t0, k: k)
        let plotFrom = ChartPlot(w: w, lo: shown.lo, hi: shown.hi, t0: t0, k: k)
        let mask = ChartGeometry.mask(to, series: ys.count)
        let every = (ctx.everyS ?? 5) * 1000
        let pTo = ChartGeometry.paths(times: times, vals: to, mask: mask, plot: plotTo, kind: kind, stack: stack, xMode: xMode, hold: hold, everyMs: every)
        let pFrom = anim ? ChartGeometry.paths(times: times, vals: from, mask: mask, plot: plotFrom, kind: kind, stack: stack, xMode: xMode, hold: hold, everyMs: every) : pTo
        built = Built(times: times, plot: plotTo, scrollX: scrollX, at: real, width: w)

        // where things sit
        plot.frame = CGRect(x: 0, y: ChartBrick.headH, width: w, height: H)
        // a live line's dots sit at the right edge, outside the cut, so the cut ends there
        let dotsAtEdge = hold != nil
        clip.bounds = CGRect(x: -4, y: 0, width: dotsAtEdge ? w + 4 : w + 8, height: H)
        clip.position = CGPoint(x: -4, y: 0)
        scroller.frame = CGRect(x: 0, y: 0, width: 1, height: H)
        dots.frame = CGRect(x: 0, y: 0, width: w, height: H)
        tickClip.frame = CGRect(x: 0, y: 0, width: w, height: H)
        tickScroller.frame = CGRect(x: 0, y: 0, width: 1, height: H)

        // grid and thresholds
        let grid = CGMutablePath()
        let axis = [target.hi, (target.hi + target.lo) / 2, target.lo]
        for (i, val) in axis.enumerated() {
            let y = plotTo.y(val).rounded() + 0.5
            grid.move(to: CGPoint(x: 0, y: y)); grid.addLine(to: CGPoint(x: w, y: y))
            let label = yLabels[i]
            label.isHidden = i == 2 && abs(target.lo) < 1e-9
            label.set(Bricks.fmtNum(val), color: cg(Pal.muted2))
            // the top line's label goes under it: above would reach into the legend
            let lh = BrickText.lineHeight(Self.axisStyle), asc = BrickText.ascender(Self.axisStyle)
            label.place(x: 2, baseline: i == 0 ? y + 2 + asc : y - 2 - lh + asc)
        }
        gridLines.path = grid
        gridLines.strokeColor = cg(Pal.line)
        gridLines.lineWidth = 1
        gridLines.fillColor = nil
        for (key, color, l) in [("warn_above", Pal.warn, warnLine), ("error_above", Pal.err, errLine)] {
            guard let t = v.number(key), t >= target.lo, t <= target.hi else { l.isHidden = true; continue }
            l.isHidden = false
            l.strokeColor = cg(color)
            func path(_ p: ChartPlot) -> CGPath { let y = p.y(t); let q = CGMutablePath(); q.move(to: CGPoint(x: 0, y: y)); q.addLine(to: CGPoint(x: w, y: y)); return q }
            setPath(l, from: path(plotFrom), to: path(plotTo), anim: anim)
        }

        // the series
        ensureSeries(ys.count)
        for (i, s) in series.enumerated() {
            let color = ChartBrick.palette[i % 4]
            let a = pFrom[i], b = pTo[i]
            s.bars.isHidden = kind != "bar"
            s.line.isHidden = kind == "bar"
            s.area.isHidden = kind != "area"
            s.dot.isHidden = kind == "bar" || b.last == nil
            if kind == "bar" {
                s.bars.fillColor = cg(color, 0.85)
                setPath(s.bars, from: a.bars, to: b.bars, anim: anim)
            } else {
                s.line.strokeColor = cg(color)
                setPath(s.line, from: a.line, to: b.line, anim: anim)
                if kind == "area" { s.area.fillColor = cg(color, 0.16); setPath(s.area, from: a.area, to: b.area, anim: anim) }
                s.dot.fillColor = cg(color)
                s.dot.strokeColor = cg(Pal.panel)
                if let end = b.last {
                    // at the edge a live dot stays put; with x it rides with its sample
                    if dotsAtEdge, s.dot.superlayer !== dots { dots.addSublayer(s.dot) }
                    if !dotsAtEdge, s.dot.superlayer !== scroller { scroller.addSublayer(s.dot) }
                    let pos = { (p: CGPoint) in dotsAtEdge ? CGPoint(x: w, y: p.y) : p }
                    let fromPos = pos(a.last ?? end), toPos = pos(end)
                    s.dot.position = toPos
                    s.dot.removeAnimation(forKey: "move")
                    if anim, fromPos != toPos {
                        let an = CABasicAnimation(keyPath: "position")
                        an.fromValue = fromPos; an.toValue = toPos
                        an.duration = ChartBrick.move / 1000; an.timingFunction = .brickMove
                        s.dot.add(an, forKey: "move")
                    }
                }
            }
        }

        // time ticks, in the layer's x like the series
        let span = d1 - d0
        let nTicks = max(2, Int(w / 95))
        let tickTimes = scrolls ? Bricks.timeTicks(d0, d1 + span, max: nTicks * 2) : Bricks.timeTicks(d0, d1, max: nTicks)
        while ticks.count < tickTimes.count { let t = TextLayer(); t.textStyle = Self.axisStyle; t.contentsScale = textScale; tickScroller.addSublayer(t); ticks.append(t) }
        while ticks.count > tickTimes.count { ticks.removeLast().removeFromSuperlayer() }
        let asc = BrickText.ascender(Self.axisStyle), lh = BrickText.lineHeight(Self.axisStyle)
        for (t, label) in zip(tickTimes, ticks) {
            label.set(Bricks.fmtClock(t, span: span), color: cg(Pal.muted2))
            let x = plotTo.x(t), tw = label.textWidth
            label.place(x: x - tw / 2, baseline: H - 1 - lh + asc)
            // without a moving edge (a still or a fixed window) only the ticks clear of the edges show
            let sx = x + scrollX
            label.isHidden = !(scrolls && !snapshot) && !(sx > 18 && sx < w - 18)
        }
        // a moving window fades its ticks at the edges instead
        if scrolls && !snapshot {
            let fade = (tickClip.mask as? CAGradientLayer) ?? CAGradientLayer()
            fade.startPoint = CGPoint(x: 0, y: 0.5); fade.endPoint = CGPoint(x: 1, y: 0.5)
            let e = NSNumber(value: Double(min(0.45, 22 / w)))
            fade.colors = [CGColor.clear, CGColor.black, CGColor.black, CGColor.clear]
            fade.locations = [0, e, NSNumber(value: 1 - e.doubleValue), 1]
            fade.frame = tickClip.bounds
            tickClip.mask = fade
        } else { tickClip.mask = nil }

        // the scroll: the render server moves both layers left at the window's pace until the next rebuild
        for l in [scroller, tickScroller] {
            l.removeAnimation(forKey: "scroll")
            l.position = CGPoint(x: scrollX, y: 0)
            guard scrolls, !snapshot else { continue }
            let pxPerS = Float(k * 1000), long = 3600.0
            let a = CABasicAnimation(keyPath: "position.x")
            a.fromValue = scrollX
            a.toValue = scrollX - CGFloat(pxPerS) * CGFloat(long)
            a.duration = long
            a.isRemovedOnCompletion = false
            a.fillMode = .forwards
            // a slow window needs few frames: about two per pixel moved
            let fps = min(30, max(4, (pxPerS * 2).rounded(.up)))
            a.preferredFrameRateRange = CAFrameRateRange(minimum: min(4, fps), maximum: fps, preferred: fps)
            l.add(a, forKey: "scroll")
        }

        // the first time, the series draw in from the left
        clip.removeAnimation(forKey: "reveal")
        dots.removeAnimation(forKey: "reveal")
        if m.intro > 0, motion {
            let p = (real - m.intro) / ChartBrick.introMs
            if p < 1 {
                let full = clip.bounds.width
                let a = CABasicAnimation(keyPath: "bounds.size.width")
                a.fromValue = full * CGFloat(Bricks.ease(p)); a.toValue = full
                a.duration = (1 - p) * ChartBrick.introMs / 1000
                a.timingFunction = .easeOut
                clip.add(a, forKey: "reveal")
                let d = CABasicAnimation(keyPath: "opacity")
                d.fromValue = 0; d.toValue = 1
                d.beginTime = CACurrentMediaTime() + a.duration * 0.8; d.duration = 0.2; d.fillMode = .backwards
                dots.add(d, forKey: "reveal")
            }
        }

        updateHead(real)
        // the head counts to the new values while they ease in
        if anim, vis.last.map({ real - $0.born < ChartBrick.move }) == true { startCounting() }
        drawHover()
    }

    private func setPath(_ l: CAShapeLayer, from: CGPath, to: CGPath, anim: Bool) {
        l.removeAnimation(forKey: "path")
        l.path = to
        guard anim, from != to else { return }
        let a = CABasicAnimation(keyPath: "path")
        a.fromValue = from; a.toValue = to
        a.duration = ChartBrick.move / 1000
        a.timingFunction = .brickMove
        l.add(a, forKey: "path")
    }

    // ---------- the head ----------

    private func startCounting() {
        guard window != nil else { return }
        BrickTicker.shared.add(self) { [weak self] in
            guard let self else { return false }
            let real = Memo.ms()
            self.updateHead(real)
            return (self.memo?.samples.last).map { real - $0.born <= ChartBrick.move + 30 } ?? false
        }
    }

    /// the latest value big on the right (colored past a threshold), the legend's values on the left
    private func updateHead(_ real: Double) {
        guard let m = memo else { return }
        let w = bounds.width, headH = ChartBrick.headH
        let latest = m.samples.last.map { cur($0, real) } ?? []
        let empty = built?.times.isEmpty ?? true
        let head = stack ? latest.filter(\.isFinite).reduce(0, +) : (latest.first ?? .nan)
        headValue.set(empty ? "—" : Bricks.fmtNum(head), color: cg(Bricks.thresholdTone(v, head).nsColor ?? Pal.ink))
        let vlh = BrickText.lineHeight(Self.valueStyle)
        let baseline = headH - vlh + BrickText.ascender(Self.valueStyle)
        var right = w
        if let u = v.string("unit") {
            headUnit.isHidden = false
            headUnit.set(u, color: cg(Pal.muted))
            right -= headUnit.textWidth
            headUnit.place(x: right, baseline: baseline)
            right -= 3
        } else { headUnit.isHidden = true }
        headValue.place(x: right - headValue.textWidth, baseline: baseline)

        ensureLegend(ys.count > 1 ? ys.count : 0)
        var x: CGFloat = 0
        let lh = BrickText.lineHeight(Self.legendStyle), top = headH - 3 - lh, lb = top + BrickText.ascender(Self.legendStyle)
        for (i, item) in legend.enumerated() {
            item.swatch.backgroundColor = cg(ChartBrick.palette[i % 4])
            item.swatch.frame = CGRect(x: x, y: top + (lh - 8) / 2, width: 8, height: 8)
            x += 12
            item.name.set(names[i], color: cg(Pal.muted))
            item.name.place(x: x, baseline: lb)
            x += item.name.textWidth + 4
            item.value.set(Bricks.fmtNum(latest[safe: i] ?? .nan), color: cg(Pal.ink))
            item.value.place(x: x, baseline: lb)
            x += item.value.textWidth + 10
        }
    }

    // ---------- hover: the sample under the pointer ----------

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }
    override func mouseMoved(with e: NSEvent) {
        let p = convert(e.locationInWindow, from: nil)
        hoverX = p.y >= ChartBrick.headH ? p.x : nil
        CATransaction.begin(); CATransaction.setDisableActions(true)
        drawHover()
        CATransaction.commit()
    }
    override func mouseExited(with e: NSEvent) {
        hoverX = nil
        CATransaction.begin(); CATransaction.setDisableActions(true)
        drawHover()
        CATransaction.commit()
    }

    private func drawHover() {
        let parts: [CALayer] = [hoverLine, tipBox, tipText]
        guard let hx = hoverX, let b = built, !b.times.isEmpty, let m = memo else { parts.forEach { $0.isHidden = true }; return }
        parts.forEach { $0.isHidden = false }
        let w = bounds.width, top = ChartPlot.top, bottom = ChartPlot.bottom
        // where the scroll is now
        let shift = (scroller.presentation() ?? scroller).position.x
        let xs = b.times.map { b.plot.x($0) + shift }
        let best = xs.indices.min { abs(xs[$0] - hx) < abs(xs[$1] - hx) }!
        let x = max(0, xs[best])
        let line = CGMutablePath(); line.move(to: CGPoint(x: x, y: top)); line.addLine(to: CGPoint(x: x, y: bottom))
        hoverLine.path = line
        hoverLine.strokeColor = cg(Pal.muted2)
        let real = Memo.ms()
        let sample = m.samples.first { $0.t == b.times[best] }
        let vals = sample.map { cur($0, real) } ?? []
        let unit = v.string("unit").map { " \($0)" } ?? ""
        let text = "\(Bricks.fmtClock(b.times[best], span: xMode ? 0 : 1))  " + vals.enumerated().map { i, n in
            (ys.count > 1 ? (names[safe: i] ?? "") + " " : "") + Bricks.fmtNum(n) }.joined(separator: " · ") + unit
        tipText.set(text, color: cg(Pal.ink))
        let tw = tipText.textWidth, th = BrickText.lineHeight(Self.tipStyle)
        let bw = tw + 12, bx = min(max(0, x - bw / 2), w - bw)
        let box = CGRect(x: bx, y: bottom - th - 6, width: bw, height: th + 2)
        tipBox.path = CGPath(roundedRect: box, cornerWidth: 5, cornerHeight: 5, transform: nil)
        tipBox.fillColor = cg(Pal.panel2)
        tipBox.strokeColor = cg(Pal.line)
        tipText.place(x: box.midX - tw / 2, baseline: box.midY - th / 2 + BrickText.ascender(Self.tipStyle))
    }
}
