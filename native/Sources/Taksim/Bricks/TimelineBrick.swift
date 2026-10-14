import SwiftUI
import TaksimKit

/// Intervals on a time axis, a Gantt (bricks.mjs timeline): bars from start to end on rows of 20 px, lanes by
/// group (a lane gets sub-rows when its bars overlap), a red dashed now-line. Open intervals (no end, or a
/// status still running or waiting) grow with the clock and pulse a 2 px right edge; new bars grow in from
/// their start (600 ms, staggered 30 ms on the first draw); hovering a bar shows its times and duration.
struct TimelineBrick: BrickView {
    static let name = "timeline"
    let ctx: BrickContext
    init(ctx: BrickContext) { self.ctx = ctx }

    @Environment(\.stillMotion) private var still
    @State private var hover: CGPoint?

    static let rowH: CGFloat = 20, axisH: CGFloat = 16, maxRows = 80, bodyMax: CGFloat = 300

    final class Memo {
        var d0: Double?
        var last = 0.0
        var born: [String: Double] = [:]
        var drawn = false
        var lastData: JSONValue?
        var rows: [Row] = []
    }
    struct Row { var label: String; var items: [Bricks.Interval] }

    var memo: Memo { BrickMemos.get(ctx.memoKey + (ctx.preview ? "#preview" : "")) { Memo() } }
    var v: BrickSpec { ctx.view }
    func clock(_ real: Double) -> Double { ctx.preview ? (ctx.now ?? real) : real }
    static func ms() -> Double { Date().timeIntervalSince1970 * 1000 }

    var body: some View {
        let m = memo
        let _ = ingest(m)
        let rows = m.rows
        if rows.isEmpty { BrickEmpty() } else {
            let h = Self.axisH + CGFloat(rows.count) * Self.rowH
            // every frame while bars grow in (and the axis eases), then 10 a second for open bars' pulse, else once a second
            let grown = (m.born.values.max() ?? 0) + 600 + 800
            let open = rows.contains { $0.items.contains(where: \.open) }
            let clock = BrickClock(busyUntil: still ? .distantPast : Date(timeIntervalSince1970: grown / 1000),
                                   idle: ctx.preview ? nil : open && !still ? 0.1 : 1)
            let plot = TimelineView(clock) { tl in
                Canvas { g, size in draw(g, size, m, real: tl.date.timeIntervalSince1970 * 1000) }
                    .onContinuousHover { p in if case .active(let pt) = p { hover = pt } else { hover = nil } }
            }
            .frame(height: h)
            if h > Self.axisH + Self.bodyMax { BrickScroll(height: Self.axisH + Self.bodyMax) { plot } } else { plot }
        }
    }

    /// new data: intervals, and lanes with sub-rows by first fit
    func ingest(_ m: Memo) {
        guard m.lastData != ctx.data else { return }
        m.lastData = ctx.data
        let real = Self.ms()
        let items = Array(Bricks.intervals(ctx.data, v, now: clock(real)).prefix(300))
        var rows: [Row] = []
        if v.string("group") != nil {
            var lanes: [String: [[Bricks.Interval]]] = [:]
            for it in items.sorted(by: { $0.start < $1.start }) {
                var subs = lanes[it.group ?? "—", default: []]
                if let i = subs.firstIndex(where: { ($0.last!.open ? Double.infinity : $0.last!.end!) <= it.start }) { subs[i].append(it) }
                else { subs.append([it]) }
                lanes[it.group ?? "—"] = subs
            }
            // lanes in the order the source gave them
            var order: [String] = []
            for it in items where !order.contains(it.group ?? "—") { order.append(it.group ?? "—") }
            for g in order { for (i, sub) in (lanes[g] ?? []).enumerated() { rows.append(Row(label: i == 0 ? g : "", items: sub)) } }
        } else {
            rows = items.map { Row(label: $0.label, items: [$0]) }
        }
        rows = Array(rows.prefix(Self.maxRows))
        let keys = Set(items.map(\.key))
        m.born = m.born.filter { keys.contains($0.key) }
        for (ri, r) in rows.enumerated() {
            for it in r.items where m.born[it.key] == nil {
                m.born[it.key] = real + (m.drawn ? 0 : Double(min(ri, 16)) * 30)
            }
        }
        m.rows = rows
        m.drawn = true
    }

    func color(_ tone: String) -> Color {
        switch tone {
        case "ok": JB.ok
        case "warn": JB.warn
        case "err": JB.err
        case "wait": JB.wait
        case "idle": JB.muted2
        default: JB.accent // run, or no status
        }
    }

    func draw(_ g: GraphicsContext, _ size: CGSize, _ m: Memo, real: Double) {
        let W = size.width, lab = min(W * 0.34, 170), trackW = max(1, W - lab)
        let now = clock(real)
        let all = m.rows.flatMap(\.items)
        // the window's start eases (180 ms) to the earliest bar, or to now − window_s
        let first = all.map(\.start).min() ?? now - 3_600_000
        let win = (v.number("window_s") ?? 0) > 0 ? v.number("window_s")! * 1000 : 0
        let want = win > 0 ? now - win : min(first, now - 60000)
        let dt = min(100, real - (m.last == 0 ? real : m.last))
        m.last = real
        var d0 = m.d0 == nil || still ? want : m.d0! + (want - m.d0!) * (1 - exp(-dt / 180))
        if abs(want - d0) < 50 { d0 = want }
        m.d0 = d0
        let d1 = now + (now - d0) * 0.035, span = max(1, d1 - d0)
        func fx(_ t: Double) -> CGFloat { CGFloat((t - d0) / span) }

        // axis
        let axisLine = Self.axisH - 0.5
        g.stroke(Path { $0.move(to: CGPoint(x: lab, y: axisLine)); $0.addLine(to: CGPoint(x: W, y: axisLine)) }, with: .color(JB.line), lineWidth: 1)
        for t in Bricks.timeTicks(d0, d1, max: 5) where fx(t) <= 0.93 && fx(t) >= 0 {
            g.draw(Text(Bricks.fmtClock(t, span: span)).font(.system(size: 9.5).monospacedDigit()).foregroundStyle(JB.muted2),
                   at: CGPoint(x: lab + fx(t) * trackW, y: 1), anchor: .top)
        }
        // rows
        var hit: (Bricks.Interval, CGRect)?
        for (ri, r) in m.rows.enumerated() {
            let y = Self.axisH + CGFloat(ri) * Self.rowH
            if !r.label.isEmpty {
                g.draw(Text(Self.fit(r.label, width: lab - 8, size: 11.5)).font(.system(size: 11.5)).foregroundStyle(JB.text),
                       at: CGPoint(x: 0, y: y + Self.rowH / 2), anchor: .leading)
            }
            g.fill(Path(CGRect(x: lab, y: y + Self.rowH / 2 - 0.5, width: trackW, height: 1)), with: .color(JB.panel2))
            var track = g
            track.clip(to: Path(CGRect(x: lab, y: y, width: trackW, height: Self.rowH)))
            for it in r.items {
                let s = max(it.start, d0), e = it.open ? now : (it.end ?? now)
                let k = CGFloat(max(0, e - s) / span)
                // growing in from its start
                let born = m.born[it.key] ?? 0
                let gk = still ? 1 : CGFloat(Bezier.spring((real - born) / 600))
                guard gk > 0 || real >= born else { continue }
                let full = CGRect(x: lab + fx(s) * trackW, y: y + 3, width: max(3, k * trackW), height: Self.rowH - 6)
                let rect = CGRect(x: full.minX, y: full.minY, width: max(0, full.width * max(0, gk)), height: full.height)
                let col = color(it.tone)
                let shape = UnevenRoundedRectangle(topLeadingRadius: 4, bottomLeadingRadius: 4,
                                                   bottomTrailingRadius: it.open ? 1 : 4, topTrailingRadius: it.open ? 1 : 4).path(in: rect)
                var bar = track
                bar.opacity = still ? 1 : 0.3 + 0.7 * min(1, max(0, Double(gk)))
                bar.fill(shape, with: .color(col))
                if it.open, rect.width > 2 {
                    let pulse = 0.45 + 0.1 * cos(2 * .pi * real / 1400)
                    bar.fill(Path(CGRect(x: rect.maxX - 2, y: rect.minY, width: 2, height: rect.height)), with: .color(JB.accentInk.opacity(pulse)))
                }
                // words only where they fit
                if k * trackW >= 30, gk >= 0.99 {
                    let t = v.string("group") != nil ? it.label : Bricks.fmtDur(e - it.start)
                    var inner = bar
                    inner.clip(to: Path(rect))
                    inner.draw(Text(Self.fit(t, width: rect.width - 10, size: 10)).font(.system(size: 10).monospacedDigit()).foregroundStyle(JB.accentInk),
                               at: CGPoint(x: rect.minX + 5, y: rect.midY), anchor: .leading)
                }
                if let h = hover, full.insetBy(dx: 0, dy: -3).contains(h) { hit = (it, full) }
            }
        }
        // now
        let nx = lab + fx(now) * trackW
        g.stroke(Path { $0.move(to: CGPoint(x: nx, y: 0)); $0.addLine(to: CGPoint(x: nx, y: size.height)) },
                 with: .color(JB.err.opacity(0.8)), style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
        // the bar under the pointer
        if let (it, _) = hit, let h = hover {
            let end = it.open ? now : (it.end ?? now)
            let lines = [Text(it.label.isEmpty ? (it.group ?? "") : it.label).font(.system(size: 11, weight: .bold)).foregroundStyle(JB.ink),
                         Text("\(Bricks.fmtClock(it.start, now: now)) → \(it.open ? L("now") : Bricks.fmtClock(end, now: now))").font(.system(size: 11)).foregroundStyle(JB.muted1),
                         Text(Bricks.fmtDur(end - it.start) + (it.status.isEmpty ? "" : " · \(it.status)")).font(.system(size: 11)).foregroundStyle(JB.muted1)]
            let rs = lines.map { g.resolve($0) }
            let sz = rs.map { $0.measure(in: CGSize(width: 300, height: 30)) }
            let bw = (sz.map(\.width).max() ?? 0) + 16, bh = sz.reduce(0) { $0 + $1.height + 1 } + 8
            let box = CGRect(x: min(h.x + 12, W - bw - 4), y: min(h.y + 14, size.height - bh), width: bw, height: bh)
            g.fill(Path(roundedRect: box, cornerRadius: 6), with: .color(JB.panel2))
            g.stroke(Path(roundedRect: box, cornerRadius: 6), with: .color(JB.line), lineWidth: 1)
            var y = box.minY + 4
            for (r, s) in zip(rs, sz) { g.draw(r, at: CGPoint(x: box.minX + 8, y: y), anchor: .topLeading); y += s.height + 1 }
        }
    }

    /// text cut with "…" to a width
    static func fit(_ s: String, width: CGFloat, size: CGFloat) -> String {
        let font = NSFont.systemFont(ofSize: size)
        func w(_ x: String) -> CGFloat { (x as NSString).size(withAttributes: [.font: font]).width }
        guard width > 0 else { return "" }
        if w(s) <= width { return s }
        var t = s
        while !t.isEmpty, w(t + "…") > width { t.removeLast() }
        return t.isEmpty ? "" : t + "…"
    }
}
