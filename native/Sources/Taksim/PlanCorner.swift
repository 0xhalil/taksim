import AppKit

/// the corner that resizes a plan docked beside its node, as the IDE's corner does (sizes in graph units)
final class PlanCorner: NSView {
    static let minSize = CGSize(width: 320, height: 240)
    var current: () -> CGSize = { .zero }
    var scale: () -> CGFloat = { 1 }
    var onResize: (CGSize, Bool) -> Void = { _, _ in }
    private var start: (point: CGPoint, size: CGSize)?
    private var live: CGSize?

    override var isFlipped: Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .frameResize(position: .bottomRight, directions: .all)) }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with e: NSEvent) { start = (e.locationInWindow, current()) }
    override func mouseDragged(with e: NSEvent) {
        guard let s = start else { return }
        let p = e.locationInWindow, k = max(0.1, scale())
        let size = CGSize(width: max(Self.minSize.width, s.size.width + (p.x - s.point.x) / k),
                          height: max(Self.minSize.height, s.size.height - (p.y - s.point.y) / k))
        live = size
        onResize(size, false)
    }
    override func mouseUp(with e: NSEvent) {
        guard start != nil else { return }
        start = nil
        onResize(live ?? current(), true)
        live = nil
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
