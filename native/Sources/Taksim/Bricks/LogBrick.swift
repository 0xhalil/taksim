import AppKit
import SwiftUI
import TaksimKit

/// Lines as a scrolling log, newest at the bottom (it stays there while new lines come in). The level, when the
/// spec names its field, colors the line's tag. With a row action, a click on a line runs the first one.
///
/// A text view that only appends: a refresh adds the lines that came and drops the ones that went from the
/// top, the lines already there aren't laid out again.
struct LogBrick: BrickView {
    static let name = "log"
    let ctx: BrickContext
    init(ctx: BrickContext) { self.ctx = ctx }

    @Environment(\.stillMotion) private var still
    @Environment(\.isSnapshot) private var isSnapshot
    @Environment(\.brickZoom) private var zoom
    @Environment(\.colorScheme) private var scheme

    static let lineH: CGFloat = 16.7

    var body: some View {
        let ctx = ctx
        let n = min(500, Bricks.rows(ctx.data).count)
        let h = min(340, CGFloat(n) * Self.lineH + 4)
        if n == 0 { BrickEmpty(text: L("no rows yet")) } else if isSnapshot {
            LayerBrickSnapshot(size: CGSize(width: max(1, ctx.width), height: h), dark: scheme == .dark,
                               make: { LogLayerView() }, update: { $0.update(ctx) })
        } else {
            LayerBrick(make: { LogLayerView() }, update: { $0.update(ctx) }, zoom: zoom, still: still)
                .frame(height: h)
        }
    }
}

final class LogLayerView: LayerBrickView {
    let scroll = NSScrollView()
    let text = LogTextView()
    private var ctx: BrickContext?
    /// the rows shown, one per line, and each line's length in the text. Lines that left the data stay at the
    /// top for a while and go in one batch: cutting the top lays the whole text out again.
    private var lines: [JSONValue] = []
    static let staleBatch = 200
    private var lengths: [Int] = []

    static let textFont = NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular)
    static let levelFont = NSFont.monospacedSystemFont(ofSize: 10, weight: .regular)

    override init(frame: NSRect) {
        super.init(frame: frame)
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        text.isEditable = false
        text.isSelectable = false
        text.drawsBackground = false
        text.isRichText = true
        text.textContainerInset = .zero
        text.textContainer?.lineFragmentPadding = 2
        text.textContainer?.widthTracksTextView = true
        text.isVerticallyResizable = true
        text.isHorizontallyResizable = false
        text.autoresizingMask = [.width]
        text.layoutManager?.allowsNonContiguousLayout = true
        text.owner = self
        scroll.documentView = text
        addSubview(scroll)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        if scroll.frame != bounds {
            scroll.frame = bounds
            text.frame.size.width = scroll.contentSize.width
            text.minSize = CGSize(width: 0, height: bounds.height)
            text.maxSize = CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
            text.textContainer?.containerSize = CGSize(width: scroll.contentSize.width, height: .greatestFiniteMagnitude)
            stickToBottom()
        }
    }

    var action: RowAction? { ctx.flatMap { $0.preview ? nil : $0.view.rowActions.first } }
    /// a line can be clicked: it picks the line (a row input follows this log) or runs the first row action
    var clickable: Bool { ctx.map { !$0.preview && ($0.pick != nil || !$0.view.rowActions.isEmpty) } ?? false }

    func update(_ c: BrickContext) {
        let specChanged = ctx.map { $0.view != c.view } ?? true
        let same = !specChanged && ctx?.data == c.data
        ctx = c
        text.toolTip = action?.label
        guard !same else { return }
        let rows = Array(Bricks.rows(c.data).suffix(500))
        guard let storage = text.textStorage else { return }
        let atBottom = isAtBottom
        // the old lines the new ones start with stay; the ones before them go, the ones after them come
        let keep = specChanged ? 0 : Bricks.appendOverlap(old: lines, new: rows)
        // the lines before the overlap left the data; they go once there are enough of them
        let stale = lines.count - keep
        let drop = stale > Self.staleBatch ? stale : 0
        storage.beginEditing()
        if keep == 0 { storage.setAttributedString(NSAttributedString()); lengths = [] }
        else if drop > 0 {
            // the lines that went, and the newline the first one kept starts with
            let cut = lengths.prefix(drop).reduce(0, +) + 1
            storage.deleteCharacters(in: NSRange(location: 0, length: cut))
            lengths.removeFirst(drop)
            lengths[0] -= 1
        }
        let added = NSMutableAttributedString()
        for (i, r) in rows.dropFirst(keep).enumerated() {
            // every line but the first starts with its newline
            let first = keep + i == 0
            let s = attributed(r, newline: !first)
            added.append(s)
            lengths.append(s.length)
        }
        storage.append(added)
        storage.endEditing()
        lines = keep == 0 ? rows : Array(lines.dropFirst(drop)) + rows.dropFirst(keep)
        text.hoverLine = nil
        text.needsDisplay = true
        if atBottom || keep == 0 { stickToBottom() }
    }

    /// a row as one line: its level tag (42 wide), then its text; a wrapped line lines up under the text
    private func attributed(_ r: JSONValue, newline: Bool) -> NSAttributedString {
        guard let ctx else { return NSAttributedString() }
        let l = Bricks.line(ctx.view, r)
        let p = NSMutableParagraphStyle()
        p.lineSpacing = 1.5
        let out = NSMutableAttributedString(string: newline ? "\n" : "", attributes: [.font: Self.textFont, .paragraphStyle: p])
        if !l.level.isEmpty {
            p.tabStops = [NSTextTab(textAlignment: .left, location: 42)]
            p.headIndent = 42
            out.append(NSAttributedString(string: l.level.uppercased() + "\t",
                                          attributes: [.font: Self.levelFont, .foregroundColor: l.tone.nsColor ?? Pal.muted, .paragraphStyle: p]))
        }
        out.append(NSAttributedString(string: l.text, attributes: [.font: Self.textFont, .foregroundColor: Pal.text, .paragraphStyle: p]))
        return out
    }

    var isAtBottom: Bool {
        let clip = scroll.contentView.bounds
        return clip.maxY >= text.frame.height - 4
    }

    func stickToBottom() {
        text.layoutManager?.ensureLayout(for: text.textContainer!)
        let h = text.frame.height, clipH = scroll.contentView.bounds.height
        scroll.contentView.scroll(to: CGPoint(x: 0, y: max(0, h - clipH)))
        scroll.reflectScrolledClipView(scroll.contentView)
    }

    /// the line index under a point of the text view
    func line(at p: CGPoint) -> (index: Int, rect: CGRect)? {
        guard let lm = text.layoutManager, let tc = text.textContainer, !lengths.isEmpty else { return nil }
        let i = lm.characterIndex(for: p, in: tc, fractionOfDistanceBetweenInsertionPoints: nil)
        var start = 0
        for (k, n) in lengths.enumerated() {
            if i < start + n || k == lengths.count - 1 {
                // the line's own characters (its leading newline belongs to the line before visually)
                let lead = k == 0 ? 0 : 1
                let range = NSRange(location: start + lead, length: max(0, n - lead))
                let glyphs = lm.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
                var rect = lm.boundingRect(forGlyphRange: glyphs, in: tc)
                rect.origin.x = 0
                rect.size.width = text.bounds.width
                guard rect.contains(CGPoint(x: 1, y: p.y)) else { return nil }
                return (k, rect)
            }
            start += n
        }
        return nil
    }

    func run(_ index: Int) {
        guard let ctx, clickable, lines.indices.contains(index) else { return }
        let row = lines[index]
        if let pick = ctx.pick { pick(row); return }
        Task { @MainActor in _ = await ctx.act(0, row) }
    }

    override func restyle() { text.needsDisplay = true }

    override func drawSnapshot(_ ctx: CGContext) {
        // the text view draws itself: the visible part, as scrolled
        let clip = scroll.contentView.bounds
        ctx.saveGState()
        ctx.translateBy(x: 0, y: -clip.minY)
        if let lm = text.layoutManager, let tc = text.textContainer {
            lm.ensureLayout(for: tc)
            let glyphs = lm.glyphRange(forBoundingRect: clip, in: tc)
            lm.drawGlyphs(forGlyphRange: glyphs, at: .zero)
        }
        ctx.restoreGState()
    }
}

/// the log's text: a hovered line with an action gets a background, a click runs it
final class LogTextView: NSTextView {
    weak var owner: LogLayerView?
    var hoverLine: (index: Int, rect: CGRect)?

    override func drawBackground(in rect: NSRect) {
        guard let h = hoverLine else { return }
        Pal.panel2.setFill()
        h.rect.fill()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.filter { $0.owner === self && $0.userInfo?["log"] != nil }.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: ["log": true]))
    }

    override func mouseMoved(with e: NSEvent) {
        guard owner?.clickable == true else { return }
        let h = owner?.line(at: convert(e.locationInWindow, from: nil))
        guard h?.index != hoverLine?.index else { return }
        if let r = hoverLine?.rect { setNeedsDisplay(r) }
        hoverLine = h
        if let r = h?.rect { setNeedsDisplay(r) }
    }
    override func mouseExited(with e: NSEvent) {
        if let r = hoverLine?.rect { setNeedsDisplay(r) }
        hoverLine = nil
    }
    override func mouseDown(with e: NSEvent) {
        guard let o = owner, o.clickable, let h = o.line(at: convert(e.locationInWindow, from: nil)) else { return }
        o.run(h.index)
    }
    override func cursorUpdate(with e: NSEvent) { NSCursor.arrow.set() }
    override func resetCursorRects() {}
}
