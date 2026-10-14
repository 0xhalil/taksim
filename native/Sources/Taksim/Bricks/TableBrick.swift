import AppKit
import QuartzCore
import SwiftUI
import TaksimKit

/// Rows as a table (bricks.mjs table). Rows keep their identity across refreshes (the `key` field, else the
/// first column; a repeated key is numbered), so a refresh or a sort slides them to their new places (520 ms),
/// new rows slide in from the left (380 ms, staggered 28 ms on the first draw), gone rows fade (300 ms),
/// changed cells flash (900 ms) and numbers count to their new value. `bar` draws a column's values as bars
/// behind them. More than 150 rows, or other columns, draw without motion.
///
/// Each row is a layer with its cells' text; a refresh changes only the cells whose text changed, and the
/// slides, fades and flashes run on the render server.
struct TableBrick: BrickView {
    static let name = "table"
    let ctx: BrickContext
    init(ctx: BrickContext) { self.ctx = ctx }

    @Environment(\.stillMotion) private var still
    @Environment(\.isSnapshot) private var isSnapshot
    @Environment(\.brickZoom) private var zoom
    @Environment(\.colorScheme) private var scheme

    static let rowH: CGFloat = 21, headH: CGFloat = 22, maxH: CGFloat = 340

    /// the keys of the first draw: those rows come in one after another
    final class Memo { var firstKeys: Set<String>?; var signature = "" }

    var body: some View {
        let ctx = ctx
        let n = min(500, Bricks.rows(ctx.data).count)
        let h = min(Self.maxH, Self.headH + CGFloat(n) * Self.rowH + 2)
        if n == 0 { BrickEmpty() } else if isSnapshot {
            LayerBrickSnapshot(size: CGSize(width: max(1, ctx.width), height: h), dark: scheme == .dark,
                               make: { TableLayerView() }, update: { $0.update(ctx) })
        } else {
            LayerBrick(make: { TableLayerView() }, update: { $0.update(ctx) }, zoom: zoom, still: still)
                .frame(height: h)
        }
    }
}

/// the brick: a scroll view around the table's layers
final class TableLayerView: LayerBrickView {
    let scroll = NSScrollView()
    let table = TableContent()
    private var scrollObserver: NSObjectProtocol?

    override init(frame: NSRect) {
        super.init(frame: frame)
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.documentView = table
        scroll.contentView.postsBoundsChangedNotifications = true
        scrollObserver = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.table.scrolled() }
        }
        addSubview(scroll)
        table.owner = self
    }
    required init?(coder: NSCoder) { fatalError() }
    deinit { if let scrollObserver { NotificationCenter.default.removeObserver(scrollObserver) } }

    override func layout() {
        super.layout()
        if scroll.frame != bounds { scroll.frame = bounds; table.relayout() }
    }
    func update(_ c: BrickContext) {
        table.update(c)
    }
    /// a snapshot draws the table's layers as a flipped root, like the view's own
    override func drawSnapshot(_ ctx: CGContext) {
        guard let l = table.layer else { return }
        let was = l.isGeometryFlipped
        l.isGeometryFlipped = true
        l.render(in: ctx)
        l.isGeometryFlipped = was
    }
    override func restyle() { table.restyle() }
    override func rescale() { super.rescale(); table.layer.map { setScale($0) } }
}

/// the table itself, as layers: a header, then a layer per row
final class TableContent: NSView, NSViewToolTipOwner {
    weak var owner: TableLayerView?
    private var ctx: BrickContext?
    private var memo: TableBrick.Memo?
    private var sort: (field: String, desc: Bool)?

    // what is shown
    private var cols: [Column] = []
    private var colX: [CGFloat] = [], colW: [CGFloat] = []
    private var acts: [RowAction] = []
    private var actW: [CGFloat] = []
    private var shown: [(id: String, row: JSONValue)] = []
    private var barField: String?
    private var barMax = 1.0
    /// columns whose every value is a number: right-aligned like a spreadsheet
    private var numCols = Set<Int>()
    private var gridW: CGFloat = 0
    private var signature = ""
    private var countCells = true

    // layers
    private let header = QuietLayer()
    private var heads: [(text: TextLayer, arrow: QuietLayer)] = []
    private let headLine = QuietLayer()
    private var rows: [String: TableRowLayer] = [:]
    private var hoverId: String?
    private var hoverButton: (row: String, index: Int)?
    private var counting: [(cell: TableCellLayer, a: Double, b: Double, decimals: Int, start: CFTimeInterval)] = []

    static let cellStyle = BrickText.Style(size: 12, weight: .regular, mono: false)
    static let headStyle = BrickText.Style(size: 12, weight: .semibold, mono: false)
    static let actStyle = BrickText.Style(size: 11.5, weight: .regular, mono: false)

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layerContentsRedrawPolicy = .never
        layer?.addSublayer(header)
        header.addSublayer(headLine)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override var wantsUpdateLayer: Bool { true }
    override func makeBackingLayer() -> CALayer { QuietLayer() }

    var still: Bool { owner?.still ?? true }
    var snapshot: Bool { owner?.snapshot ?? false }
    func cg(_ c: NSColor, _ a: CGFloat = 1) -> CGColor { owner?.cg(c, a) ?? c.cgColor }
    var textScale: CGFloat { owner?.textScale ?? 2 }

    // ---------- data ----------

    func update(_ c: BrickContext) {
        let same = ctx.map { $0.data == c.data && $0.view == c.view && $0.preview == c.preview && $0.picked == c.picked } ?? false
        ctx = c
        if memo == nil { memo = BrickMemos.get(c.memoKey + (c.preview ? "#preview" : "")) { TableBrick.Memo() } }
        if !same { apply(animated: true) }
    }

    func restyle() { apply(animated: false) }
    func relayout() { apply(animated: false) }

    /// what the data says now, laid out; rows move, come and go, cells flash
    private func apply(animated: Bool) {
        guard let ctx, let memo, let owner else { return }
        let all = Bricks.rows(ctx.data).map(Bricks.asRow)
        cols = Bricks.columns(ctx.view, rows: all)
        let ordered = sort.map { Bricks.sorted(all, by: $0.field, descending: $0.desc) } ?? all
        shown = Bricks.keyed(ordered, key: ctx.view.string("key") ?? cols.first?.field)
        acts = ctx.view.rowActions
        let sig = Bricks.compact(.array(cols.map { .string($0.field) } + [.bool(!acts.isEmpty)]))
        // other columns on a table already drawn: start over, without motion
        let reset = !signature.isEmpty && signature != sig
        if memo.signature != sig { memo.signature = sig; memo.firstKeys = nil }
        if signature != sig { signature = sig; for r in rows.values { r.layer.removeFromSuperlayer() }; rows = [:] }
        let first = memo.firstKeys ?? { memo.firstKeys = Set(shown.map(\.id)); return memo.firstKeys! }()
        let motion = animated && owner.motion && shown.count <= 150 && !reset
        // counting every changed number is lovely in a short table and a frame-eater in a long one
        countCells = shown.count <= 20
        barField = ctx.view.string("bar")
        barMax = barField.map { f in max(0, shown.map { Bricks.parseNum(Bricks.get($0.row, f)) }.filter(\.isFinite).max() ?? 0) } ?? 0
        if barMax <= 0 { barMax = 1 }
        // a column of only numbers reads as numbers: right edge, like a spreadsheet
        numCols = Set(cols.indices.filter { i in
            var any = false
            return shown.allSatisfy { r in
                let t = Bricks.show(Bricks.get(r.row, cols[i].field)).trimmingCharacters(in: .whitespaces)
                if t.isEmpty { return true }
                guard Self.number(t) != nil else { return false }
                any = true
                return true
            } && any
        })

        // column widths: the widest cell (up to 320) or header, plus 8
        var widths = cols.map { c -> CGFloat in
            BrickText.width(c.label, Self.headStyle) + (sort?.field == c.field ? 3 + 10 : 0) + 8
        }
        for (_, r) in shown {
            for (i, c) in cols.enumerated() {
                let w = min(320, BrickText.width(Bricks.show(Bricks.get(r, c.field)), Self.cellStyle)) + 8
                if w > widths[i] { widths[i] = w }
            }
        }
        colW = widths
        colX = []
        var x: CGFloat = 0
        for w in widths { colX.append(x); x += w }
        actW = acts.map { BrickText.width($0.label, Self.actStyle) + 14 }
        gridW = x + (acts.isEmpty ? 0 : actW.reduce(0, +) + CGFloat(acts.count - 1) * 4)
        let viewW = owner.bounds.width
        let rowW = max(gridW, viewW)
        let height = TableBrick.headH + CGFloat(shown.count) * TableBrick.rowH
        let size = CGSize(width: rowW, height: max(height, owner.bounds.height))
        if frame.size != size { setFrameSize(size) }

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        drawHeader(rowW)

        // rows: kept ones move, new ones slide in, gone ones fade where they were
        let wanted = Set(shown.map(\.id))
        for (id, r) in rows where !wanted.contains(id) {
            rows[id] = nil
            if motion {
                let l = r.layer
                CATransaction.begin()
                CATransaction.setCompletionBlock { l.removeFromSuperlayer() }
                let a = CABasicAnimation(keyPath: "opacity")
                a.fromValue = l.presentation()?.opacity ?? 1; a.toValue = 0
                a.duration = 0.3; a.timingFunction = .easeOut
                a.fillMode = .forwards; a.isRemovedOnCompletion = false
                l.add(a, forKey: "leave")
                CATransaction.commit()
            } else { r.layer.removeFromSuperlayer() }
        }
        let visible = visibleRange(height: height)
        for (i, item) in shown.enumerated() {
            let y = TableBrick.headH + CGFloat(i) * TableBrick.rowH
            guard visible.contains(i) else {
                // a long table keeps layers only for the rows in view
                if let r = rows[item.id] { r.layer.removeFromSuperlayer(); rows[item.id] = nil }
                continue
            }
            if let r = rows[item.id] {
                let was = r.layer.presentation()?.position.y ?? r.layer.position.y
                r.layer.position = CGPoint(x: 0, y: y)
                fill(r, item.row, width: rowW, motion: motion)
                if motion, abs(was - y) > 0.5 {
                    let a = CABasicAnimation(keyPath: "position.y")
                    a.fromValue = was; a.toValue = y
                    a.duration = 0.52
                    a.timingFunction = CAMediaTimingFunction(controlPoints: 0.34, 1.25, 0.64, 1)
                    r.layer.add(a, forKey: "slide")
                }
            } else {
                let r = TableRowLayer()
                r.id = item.id
                r.layer.anchorPoint = .zero
                r.layer.position = CGPoint(x: 0, y: y)
                layer?.insertSublayer(r.layer, below: header)
                rows[item.id] = r
                fill(r, item.row, width: rowW, motion: false)
                owner.setScale(r.layer)
                if motion {
                    // in from the left; on the first draw one after another
                    let delay = first.contains(item.id) ? Double(min(i, 12)) * 0.028 : 0
                    let t = CACurrentMediaTime() + delay
                    let slide = CABasicAnimation(keyPath: "position.x")
                    slide.fromValue = -8; slide.toValue = 0
                    slide.timingFunction = CAMediaTimingFunction(controlPoints: 0.34, 1.3, 0.64, 1)
                    let fade = CABasicAnimation(keyPath: "opacity")
                    fade.fromValue = 0; fade.toValue = 1
                    fade.timingFunction = .easeOut
                    for a in [slide, fade] { a.duration = 0.38; a.beginTime = t; a.fillMode = .backwards }
                    r.layer.add(slide, forKey: "in")
                    r.layer.add(fade, forKey: "fade")
                }
            }
        }
        updateTips()
    }

    /// the rows to keep layers for: all of a table that moves; of a long one, those near the visible part
    private func visibleRange(height: CGFloat) -> Range<Int> {
        guard shown.count > 150 else { return 0..<shown.count }
        let vis = snapshot ? CGRect(x: 0, y: 0, width: 1, height: TableBrick.maxH) : visibleRect
        let lo = Int(((vis.minY - TableBrick.headH - 400) / TableBrick.rowH).rounded(.down))
        let hi = Int(((vis.maxY - TableBrick.headH + 400) / TableBrick.rowH).rounded(.up))
        return max(0, lo)..<max(max(0, lo), min(shown.count, hi))
    }

    func scrolled() {
        guard shown.count > 150 else { return }
        apply(animated: false)
    }

    private func drawHeader(_ rowW: CGFloat) {
        header.frame = CGRect(x: 0, y: 0, width: rowW, height: TableBrick.headH)
        headLine.frame = CGRect(x: 0, y: TableBrick.headH - 1, width: rowW, height: 1)
        headLine.backgroundColor = cg(Pal.line)
        while heads.count < cols.count {
            let t = TextLayer(); t.textStyle = Self.headStyle
            let a = QuietLayer(); a.contentsGravity = .center
            header.addSublayer(t); header.addSublayer(a)
            t.contentsScale = textScale; a.contentsScale = textScale
            heads.append((t, a))
        }
        while heads.count > cols.count { let h = heads.removeLast(); h.text.removeFromSuperlayer(); h.arrow.removeFromSuperlayer() }
        let lh = BrickText.lineHeight(Self.headStyle)
        let baseline = (TableBrick.headH - lh) / 2 + BrickText.ascender(Self.headStyle)
        for (i, c) in cols.enumerated() {
            let h = heads[i]
            h.text.set(c.label, color: cg(Pal.muted))
            let sorted = sort?.field == c.field
            if numCols.contains(i) {
                let avail = colW[i] - 8 - (sorted ? 13 : 0)
                h.text.placeRight(right: colX[i] + colW[i] - 4 - (sorted ? 13 : 0), baseline: baseline, width: max(0, avail))
            } else {
                h.text.place(x: colX[i], baseline: baseline, width: min(h.text.textWidth + 2, colW[i] - 8))
            }
            if sorted {
                h.arrow.isHidden = false
                h.arrow.contents = BrickSymbol.image(sort!.desc ? "arrow.down" : "arrow.up", size: 9, color: cg(Pal.muted), scale: textScale)
                h.arrow.frame = CGRect(x: numCols.contains(i) ? colX[i] + colW[i] - 12 : colX[i] + h.text.textWidth + 3, y: 0, width: 10, height: TableBrick.headH)
            } else { h.arrow.isHidden = true }
        }
    }

    /// a row's cells, bar, separator and buttons
    private func fill(_ r: TableRowLayer, _ row: JSONValue, width: CGFloat, motion: Bool) {
        r.row = row
        r.layer.bounds = CGRect(x: 0, y: 0, width: width, height: TableBrick.rowH)
        r.hover.frame = r.layer.bounds
        r.hover.backgroundColor = cg(Pal.panel2, 0.5)
        r.hover.isHidden = hoverId != r.id
        r.mark.frame = r.layer.bounds
        r.mark.backgroundColor = cg(Pal.accent, 0.18)
        r.mark.isHidden = !(ctx.map { c in c.picked != nil && Bricks.show(Bricks.get(row, c.pickField ?? "")) == c.picked } ?? false)
        r.sep.frame = CGRect(x: 0, y: TableBrick.rowH - 1, width: width, height: 1)
        r.sep.backgroundColor = cg(Pal.panel2)
        r.ensureCells(cols.count, scale: textScale)
        let lh = BrickText.lineHeight(Self.cellStyle)
        let baseline = (TableBrick.rowH - lh) / 2 + BrickText.ascender(Self.cellStyle)
        for (i, c) in cols.enumerated() {
            let cell = r.cells[i]
            let value = Bricks.get(row, c.field)
            let text = Bricks.show(value)
            let old = cell.value
            cell.value = text
            cell.long = text.count == 160 && text.hasSuffix("…")
            cell.full = value
            cell.frame = CGRect(x: colX[i], y: 0, width: colW[i], height: TableBrick.rowH)
            let color = cg(Bricks.tone(value).nsColor ?? Pal.text)
            // a change lights the cell up, then it fades; a number counts from the old value to the new one
            if let old, old != text {
                counting.removeAll { $0.cell === cell }
                if motion {
                    cell.flash(cg(Pal.accent, 0.28))
                    if countCells, let a = Self.number(old), let b = Self.number(text) {
                        let decimals = text.trimmingCharacters(in: .whitespaces).split(separator: ".").dropFirst().first?.count ?? 0
                        counting.append((cell, a, b, decimals, CACurrentMediaTime()))
                        startCounting()
                    }
                }
            }
            cell.color = color
            if !counting.contains(where: { $0.cell === cell }) { cell.text.set(text, color: color, style: Self.cellStyle) }
            if numCols.contains(i) {
                cell.text.placeRight(right: colX[i] + colW[i] - 4, baseline: baseline, width: max(0, colW[i] - 8))
            } else {
                cell.text.place(x: colX[i], baseline: baseline, width: min(BrickText.width(text, Self.cellStyle) + 2, colW[i] - 8))
            }
            // the share of the column's largest value, behind the text
            if c.field == barField {
                let share = max(0, min(1, Bricks.parseNum(value) / barMax))
                let bw = (colW[i] - 8) * CGFloat(share.isFinite ? share : 0)
                let bar = cell.ensureBar(in: r.layer)
                bar.backgroundColor = cg(Pal.accent, 0.2)
                let was = bar.presentation()?.bounds.width ?? bar.bounds.width
                bar.anchorPoint = .zero
                bar.frame = CGRect(x: colX[i], y: 3, width: bw, height: TableBrick.rowH - 6)
                if motion, abs(was - bw) > 0.5 {
                    let a = CABasicAnimation(keyPath: "bounds.size.width")
                    a.fromValue = was; a.toValue = bw; a.duration = 0.55; a.timingFunction = .out
                    bar.add(a, forKey: "grow")
                }
            } else { cell.bar?.removeFromSuperlayer(); cell.bar = nil }
        }
        // the row's actions, after the last column
        r.ensureButtons(acts, scale: textScale)
        var x = colX.last.map { $0 + colW.last! } ?? 0
        for (i, b) in r.buttons.enumerated() {
            b.frame = CGRect(x: x, y: (TableBrick.rowH - 18) / 2, width: actW[i], height: 18)
            b.style(self, action: acts[i], hover: hoverButton.map { $0.row == r.id && $0.index == i } ?? false)
            x += actW[i] + 4
        }
    }

    static let numeric = #/-?\d+(\.\d+)?/#
    static func number(_ s: String) -> Double? {
        let t = s.trimmingCharacters(in: .whitespaces)
        return t.wholeMatch(of: numeric) != nil ? Double(t) : nil
    }

    // ---------- counting ----------

    private func startCounting() {
        guard window != nil else { return }
        BrickTicker.shared.add(self) { [weak self] in self?.countTick() ?? false }
    }

    /// one frame of the counting numbers; false when they're done
    private func countTick() -> Bool {
        let now = CACurrentMediaTime()
        for c in counting {
            let k = Bricks.ease((now - c.start) / 0.45)
            let text = k >= 1 ? (c.cell.value ?? "") : String(format: "%.\(c.decimals)f", c.a + (c.b - c.a) * k)
            c.cell.text.set(text, color: c.cell.color ?? cg(Pal.text), style: Self.cellStyle)
        }
        counting.removeAll { now - $0.start >= 0.45 }
        return !counting.isEmpty
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { BrickTicker.shared.remove(self); for c in counting { c.cell.text.set(c.cell.value ?? "", color: c.cell.color ?? cg(Pal.text), style: Self.cellStyle) }; counting = [] }
    }

    // ---------- pointer ----------

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }

    private func rowAt(_ p: CGPoint) -> Int? {
        guard p.y >= TableBrick.headH else { return nil }
        let i = Int((p.y - TableBrick.headH) / TableBrick.rowH)
        return shown.indices.contains(i) ? i : nil
    }
    private func buttonAt(_ p: CGPoint, row i: Int) -> Int? {
        guard let r = rows[shown[i].id] else { return nil }
        let local = CGPoint(x: p.x, y: p.y - (TableBrick.headH + CGFloat(i) * TableBrick.rowH))
        return r.buttons.firstIndex { $0.frame.contains(local) }
    }

    override func mouseMoved(with e: NSEvent) { hover(convert(e.locationInWindow, from: nil)) }
    override func mouseExited(with e: NSEvent) { hover(nil) }

    private func hover(_ p: CGPoint?) {
        let i = p.flatMap(rowAt)
        let id = i.map { shown[$0].id }
        let b = i.flatMap { i in buttonAt(p!, row: i).map { (shown[i].id, $0) } }
        if id == hoverId, b?.0 == hoverButton?.row, b?.1 == hoverButton?.index { return }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        let was = [hoverId, hoverButton?.row].compactMap { $0 }
        hoverId = id
        hoverButton = b.map { (row: $0.0, index: $0.1) }
        for rid in Set(was + [id, b?.0].compactMap { $0 }) {
            guard let r = rows[rid] else { continue }
            r.hover.isHidden = hoverId != rid
            for (k, btn) in r.buttons.enumerated() where acts.indices.contains(k) {
                btn.style(self, action: acts[k], hover: hoverButton.map { $0.row == rid && $0.index == k } ?? false)
            }
        }
        CATransaction.commit()
    }

    override func mouseDown(with e: NSEvent) {
        guard let ctx, !ctx.preview else { return }
        let p = convert(e.locationInWindow, from: nil)
        if p.y < TableBrick.headH {
            // a header sorts: up, down, off
            guard let c = cols.indices.first(where: { p.x >= colX[$0] && p.x < colX[$0] + colW[$0] }).map({ cols[$0] }) else { return }
            let on = sort?.field == c.field
            sort = on ? (sort!.desc ? nil : (c.field, true)) : (c.field, false)
            apply(animated: true)
            return
        }
        // a click on a row (not on its buttons) picks it, when a row input follows this table
        if let i = rowAt(p), buttonAt(p, row: i) == nil, let pick = ctx.pick { pick(shown[i].row); return }
        guard let i = rowAt(p), let k = buttonAt(p, row: i), let r = rows[shown[i].id], acts.indices.contains(k) else { return }
        let btn = r.buttons[k], row = r.row
        guard !btn.busy else { return }
        btn.busy = true
        btn.style(self, action: acts[k], hover: true)
        Task { @MainActor [weak self] in
            let ok = await ctx.act(k, row)
            btn.busy = false
            guard let self else { return }
            btn.style(self, action: self.acts[safe: k] ?? self.acts[0], hover: false)
            if ok { btn.sent(self) }
        }
    }

    // ---------- tooltips: long cells and what a button does ----------

    private func updateTips() {
        removeAllToolTips()
        for (i, item) in shown.enumerated() {
            guard let r = rows[item.id] else { continue }
            let y = TableBrick.headH + CGFloat(i) * TableBrick.rowH
            for c in r.cells where c.long { addToolTip(c.frame.offsetBy(dx: 0, dy: y), owner: self, userData: nil) }
            for b in r.buttons { addToolTip(b.frame.offsetBy(dx: 0, dy: y), owner: self, userData: nil) }
        }
    }

    func view(_ view: NSView, stringForToolTip tag: NSView.ToolTipTag, point: NSPoint, userData data: UnsafeMutableRawPointer?) -> String {
        guard let i = rowAt(point), let r = rows[shown[i].id] else { return "" }
        let local = CGPoint(x: point.x, y: point.y - (TableBrick.headH + CGFloat(i) * TableBrick.rowH))
        if let k = r.buttons.firstIndex(where: { $0.frame.contains(local) }), let a = acts[safe: k] {
            return a.run.map { L("Runs: %@", $0.joined(separator: " ")) } ?? L("Asks the agent: %@", a.ask ?? "")
        }
        if let c = r.cells.first(where: { $0.frame.contains(local) }), c.long { return Bricks.show(c.full, max: 2000) }
        return ""
    }
}

/// one row's layers
final class TableRowLayer {
    var id = ""
    var row: JSONValue = .null
    let layer = QuietLayer()
    /// the picked row (a row input): lit in the accent
    let mark = QuietLayer()
    let hover = QuietLayer()
    let sep = QuietLayer()
    var cells: [TableCellLayer] = []
    var buttons: [TableActionLayer] = []

    init() {
        layer.addSublayer(mark)
        layer.addSublayer(hover)
        layer.addSublayer(sep)
    }

    func ensureCells(_ n: Int, scale: CGFloat) {
        while cells.count < n {
            let c = TableCellLayer()
            layer.addSublayer(c.text)
            c.text.contentsScale = scale
            cells.append(c)
        }
        while cells.count > n { let c = cells.removeLast(); c.text.removeFromSuperlayer(); c.flashLayer?.removeFromSuperlayer(); c.bar?.removeFromSuperlayer() }
    }

    func ensureButtons(_ acts: [RowAction], scale: CGFloat) {
        while buttons.count < acts.count { let b = TableActionLayer(scale: scale); layer.addSublayer(b); buttons.append(b) }
        while buttons.count > acts.count { buttons.removeLast().removeFromSuperlayer() }
    }
}

/// a cell: its text, and the flash and bar behind it
final class TableCellLayer {
    let text = TextLayer()
    var value: String?
    var full: JSONValue?
    var long = false
    var color: CGColor?
    var frame: CGRect = .zero
    var flashLayer: QuietLayer?
    var bar: QuietLayer?

    func flash(_ color: CGColor) {
        guard let parent = text.superlayer else { return }
        let f = flashLayer ?? { let l = QuietLayer(); parent.insertSublayer(l, at: 1); flashLayer = l; return l }()
        f.frame = frame
        f.backgroundColor = color
        f.opacity = 0
        let a = CABasicAnimation(keyPath: "opacity")
        a.fromValue = 1; a.toValue = 0; a.duration = 0.9; a.timingFunction = .easeOut
        f.add(a, forKey: "flash")
    }

    func ensureBar(in parent: CALayer) -> QuietLayer {
        if let bar { return bar }
        let l = QuietLayer()
        l.cornerRadius = 3
        parent.insertSublayer(l, at: 1)
        bar = l
        return l
    }
}

/// a row action (canvas.html .act): a small bordered button; `run` ones lean blue. While it runs it dims; an
/// `ask` that reached the agent turns into a check for a moment.
final class TableActionLayer: QuietLayer {
    let label = TextLayer()
    let check = QuietLayer()
    var busy = false
    var labelColor: CGColor?

    init(scale: CGFloat) {
        super.init()
        cornerRadius = 5
        borderWidth = 1
        addSublayer(label)
        addSublayer(check)
        check.contentsGravity = .center
        check.isHidden = true
        label.contentsScale = scale
        check.contentsScale = scale
        contentsScale = scale
    }
    override init(layer: Any) { super.init(layer: layer) }
    required init?(coder: NSCoder) { fatalError() }

    func style(_ t: TableContent, action: RowAction, hover: Bool) {
        backgroundColor = t.cg(Pal.panel2)
        borderColor = hover ? t.cg(Pal.accent) : action.isRun ? t.cg(Pal.accent, 0.5) : t.cg(Pal.line)
        opacity = busy ? 0.5 : 1
        labelColor = t.cg(Pal.ink)
        label.set(action.label, color: labelColor!, style: TableContent.actStyle)
        let lh = BrickText.lineHeight(TableContent.actStyle)
        label.place(x: 7, baseline: (bounds.height - lh) / 2 + BrickText.ascender(TableContent.actStyle))
        check.frame = bounds
        check.contents = BrickSymbol.image("checkmark", size: 11.5, weight: .regular, color: t.cg(Pal.ok), scale: t.textScale)
    }

    /// the agent got it: a check pops in, and after a moment the label comes back
    func sent(_ t: TableContent) {
        let reduce = !(t.owner?.motion ?? false)
        check.isHidden = false
        label.opacity = 0
        if !reduce {
            let pop = CASpringAnimation(keyPath: "transform.scale")
            pop.fromValue = 0.2; pop.toValue = 1
            pop.mass = 1; pop.stiffness = 440; pop.damping = 16
            pop.duration = pop.settlingDuration
            check.add(pop, forKey: "pop")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self else { return }
            self.check.isHidden = true
            self.label.opacity = 1
            if !reduce {
                let f = CABasicAnimation(keyPath: "opacity")
                f.fromValue = 0; f.toValue = 1; f.duration = 0.3
                self.label.add(f, forKey: "back")
            }
        }
    }
}
