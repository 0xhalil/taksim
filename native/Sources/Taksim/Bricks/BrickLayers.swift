import AppKit
import QuartzCore
import SwiftUI
import TaksimKit

// The live bricks (chart, table, log) are AppKit views drawing with Core Animation layers: a refresh changes
// only the layers it touches and motion runs on the render server, so a canvas full of live panels doesn't
// re-run SwiftUI's layout every few seconds per brick. SwiftUI hosts them (NSViewRepresentable) inside the
// usual card; a snapshot draws them into an image, since ImageRenderer can't draw AppKit views.

extension Pal {
    static let panel = dyn(0x2B2D30, 0xF7F8FA), panel2 = dyn(0x393B40, 0xEBECF0), line = dyn(0x43454A, 0xDFE1E5)
    static let line2 = dyn(0x4E5157, 0xC9CCD6), warn = dyn(0xF2C55C, 0xB27A00)
}

extension Tone {
    var nsColor: NSColor? {
        switch self {
        case .good: Pal.ok
        case .warn: Pal.warn
        case .bad: Pal.err
        case .none: nil
        }
    }
}

/// the panel's zoom, so layer text is rasterized sharp when the canvas zooms in (SwiftUI scales hosted AppKit
/// views with a layer transform)
struct BrickZoomKey: EnvironmentKey { static let defaultValue: CGFloat = 1 }
extension EnvironmentValues {
    var brickZoom: CGFloat { get { self[BrickZoomKey.self] } set { self[BrickZoomKey.self] = newValue } }
}

/// CSS's cubic-bezier as Core Animation timing
extension CAMediaTimingFunction {
    static let brickMove = CAMediaTimingFunction(controlPoints: 0.215, 0.61, 0.355, 1) // 1-(1-t)³
    static let out = CAMediaTimingFunction(controlPoints: 0.22, 1, 0.36, 1)
    static let easeOut = CAMediaTimingFunction(name: .easeOut)
}

/// text: fonts, measured widths (cached; a live table measures the same strings every refresh)
enum BrickText {
    struct Style: Hashable { let size: CGFloat; let weight: NSFont.Weight; let mono: Bool; var digits = false; var kern: CGFloat = 0 }

    static func font(_ s: Style) -> NSFont {
        if let f = fonts[s] { return f }
        let f: NSFont = s.mono ? .monospacedSystemFont(ofSize: s.size, weight: s.weight)
            : s.digits ? .monospacedDigitSystemFont(ofSize: s.size, weight: s.weight) : .systemFont(ofSize: s.size, weight: s.weight)
        fonts[s] = f
        return f
    }
    nonisolated(unsafe) private static var fonts: [Style: NSFont] = [:]

    private struct Key: Hashable { let text: String; let style: Style }
    nonisolated(unsafe) private static var widths: [Key: CGFloat] = [:]

    static func width(_ text: String, _ s: Style) -> CGFloat {
        let k = Key(text: text, style: s)
        if let w = widths[k] { return w }
        if widths.count > 20_000 { widths.removeAll(keepingCapacity: true) }
        let w = ceil(NSAttributedString(string: text, attributes: attrs(s, color: .black)).size().width)
        widths[k] = w
        return w
    }

    static func attrs(_ s: Style, color: NSColor) -> [NSAttributedString.Key: Any] {
        var a: [NSAttributedString.Key: Any] = [.font: font(s), .foregroundColor: color]
        if s.kern != 0 { a[.kern] = s.kern }
        return a
    }

    /// a line's height as SwiftUI lays out a Text, and where its baseline sits from the top
    static func lineHeight(_ s: Style) -> CGFloat { let f = font(s); return ceil(f.ascender - f.descender + f.leading) }
    static func ascender(_ s: Style) -> CGFloat { font(s).ascender }
}

/// a CATextLayer that doesn't animate its changes and only redraws when its text or color does
final class TextLayer: CATextLayer {
    private var shown: (String, Int, CGColor?)?
    var textStyle: BrickText.Style = .init(size: 12, weight: .regular, mono: false)

    override init() { super.init(); setup() }
    override init(layer: Any) { super.init(layer: layer) }
    required init?(coder: NSCoder) { fatalError() }

    private func setup() {
        actions = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull(), "string": NSNull(), "hidden": NSNull(), "opacity": NSNull()]
        isWrapped = false
        truncationMode = .end
        allowsFontSubpixelQuantization = true
    }

    /// sets the text (color resolved by the caller); a change of either redraws it
    func set(_ text: String, color: CGColor, style: BrickText.Style? = nil) {
        let st = style ?? textStyle
        let key = (text, st.hashValue, color)
        if let s = shown, s.0 == key.0, s.1 == key.1, s.2 == key.2 { return }
        shown = key
        textStyle = st
        // the truncation "…" is drawn in the layer's own font: the same one, or it pushes the line down
        font = BrickText.font(st)
        fontSize = st.size
        foregroundColor = color
        var a = BrickText.attrs(st, color: .black)
        a[.foregroundColor] = NSColor(cgColor: color) ?? .black
        string = NSAttributedString(string: text, attributes: a)
    }
    var text: String { shown?.0 ?? "" }
    var textWidth: CGFloat { BrickText.width(text, textStyle) }

    /// places it so its text's left edge is at x and baseline at y
    func place(x: CGFloat, baseline: CGFloat, width: CGFloat? = nil) {
        alignmentMode = .left
        let h = BrickText.lineHeight(textStyle)
        frame = CGRect(x: x, y: baseline - BrickText.ascender(textStyle), width: width ?? textWidth + 2, height: h)
    }

    /// right edge at `right`: for columns of numbers
    func placeRight(right: CGFloat, baseline: CGFloat, width: CGFloat) {
        alignmentMode = .right
        let h = BrickText.lineHeight(textStyle)
        frame = CGRect(x: right - width, y: baseline - BrickText.ascender(textStyle), width: width, height: h)
    }
}

/// layers that never animate on their own: only the explicit animations the bricks add
class QuietLayer: CALayer {
    override func action(forKey event: String) -> CAAction? { nil }
}
final class QuietShape: CAShapeLayer {
    override func action(forKey event: String) -> CAAction? { nil }
}

/// The base of the layer bricks: flipped, layer-backed, recolored for the theme and appearance, text
/// rasterized for the screen and the canvas's zoom.
class LayerBrickView: NSView {
    /// a snapshot or Reduce Motion: everything at its final place at once
    var still = false
    /// drawn once into an image: no scroll, no masks (CALayer.render(in:) skips them)
    var snapshot = false
    var zoom: CGFloat = 1 { didSet { if textScale != oldScale { oldScale = textScale; rescale() } } }
    private var oldScale: CGFloat = 0
    private var themeObserver: NSObjectProtocol?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layerContentsRedrawPolicy = .never
        themeObserver = NotificationCenter.default.addObserver(forName: Theme.changed, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.restyle() }
        }
    }
    required init?(coder: NSCoder) { fatalError() }
    deinit { if let themeObserver { NotificationCenter.default.removeObserver(themeObserver) } }

    override var isFlipped: Bool { true }
    override var wantsUpdateLayer: Bool { true }
    override func makeBackingLayer() -> CALayer { QuietLayer() }

    var motion: Bool { !still && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    /// a color as the view's appearance and the theme resolve it
    func cg(_ c: NSColor, _ alpha: CGFloat = 1) -> CGColor {
        var out = c.cgColor
        effectiveAppearance.performAsCurrentDrawingAppearance { out = (alpha < 1 ? c.withAlphaComponent(c.alphaComponent * alpha) : c).cgColor }
        return out
    }

    /// pixels per point for text layers: the screen's, sharper when the canvas is zoomed in
    var textScale: CGFloat {
        let base = window?.backingScaleFactor ?? 2
        return base * max(1, (zoom * 2).rounded(.up) / 2)
    }

    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); restyle() }
    override func viewDidChangeBackingProperties() { super.viewDidChangeBackingProperties(); oldScale = textScale; rescale() }

    /// colors again (theme or appearance changed)
    func restyle() {}
    /// text layers at the current textScale
    func rescale() { layer?.sublayers?.forEach { setScale($0) } }
    func setScale(_ l: CALayer) {
        if l is CATextLayer { l.contentsScale = textScale } else if l is CAShapeLayer { l.contentsScale = textScale }
        l.sublayers?.forEach { setScale($0) }
    }

    /// what the view shows, as an image (snapshots): its own drawing, then its layers
    func snapshotImage(scale: CGFloat = 2) -> NSImage {
        let size = bounds.size
        let w = max(1, Int(size.width * scale)), h = max(1, Int(size.height * scale))
        let img = NSImage(size: size)
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return img }
        ctx.scaleBy(x: scale, y: scale)
        // flipped like the view
        ctx.translateBy(x: 0, y: size.height)
        ctx.scaleBy(x: 1, y: -1)
        effectiveAppearance.performAsCurrentDrawingAppearance {
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
            drawSnapshot(ctx)
            NSGraphicsContext.restoreGraphicsState()
        }
        if let cgi = ctx.makeImage() { img.addRepresentation(NSBitmapImageRep(cgImage: cgi)) }
        return img
    }

    /// draws into a flipped context; by default the layer tree (render(in:) skips masks: still bricks use none)
    func drawSnapshot(_ ctx: CGContext) { layer?.render(in: ctx) }
}

/// One display link for every counting number on screen, 24 frames a second, so all of them change in one
/// Core Animation commit per frame instead of one each.
@MainActor final class BrickTicker: NSObject {
    static let shared = BrickTicker()
    private var clients: [ObjectIdentifier: (owner: () -> AnyObject?, tick: () -> Bool)] = [:]
    private var link: CADisplayLink?

    /// `tick` runs every frame while it returns true
    func add(_ owner: AnyObject, _ tick: @escaping () -> Bool) {
        clients[ObjectIdentifier(owner)] = ({ [weak owner] in owner }, tick)
        guard link == nil, let screen = NSScreen.main else { return }
        link = screen.displayLink(target: self, selector: #selector(step))
        // a counting number reads fine at 24 frames a second; each frame redraws its text
        link?.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 24, preferred: 24)
        link?.add(to: .main, forMode: .common)
    }
    func remove(_ owner: AnyObject) { clients[ObjectIdentifier(owner)] = nil }

    @objc private func step() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (id, c) in clients where c.owner() == nil || !c.tick() { clients[id] = nil }
        CATransaction.commit()
        if clients.isEmpty { link?.invalidate(); link = nil }
    }
}

/// an SF Symbol as an image for a layer, tinted
enum BrickSymbol {
    private struct Key: Hashable { let name: String; let size: CGFloat; let color: CGColor; let scale: CGFloat
        static func == (a: Key, b: Key) -> Bool { a.name == b.name && a.size == b.size && a.scale == b.scale && CFEqual(a.color, b.color) }
        func hash(into h: inout Hasher) { h.combine(name); h.combine(size); h.combine(scale) }
    }
    nonisolated(unsafe) private static var cache: [Key: CGImage] = [:]

    static func image(_ name: String, size: CGFloat, weight: NSFont.Weight = .bold, color: CGColor, scale: CGFloat) -> CGImage? {
        let k = Key(name: name, size: size, color: color, scale: scale)
        if let c = cache[k] { return c }
        let config = NSImage.SymbolConfiguration(pointSize: size, weight: weight)
            .applying(.init(paletteColors: [NSColor(cgColor: color) ?? .gray]))
        guard let img = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(config) else { return nil }
        let rect = CGRect(origin: .zero, size: img.size)
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(ceil(img.size.width * scale)), pixelsHigh: Int(ceil(img.size.height * scale)),
                                   bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        rep?.size = img.size
        guard let rep else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        img.draw(in: rect)
        NSGraphicsContext.restoreGraphicsState()
        let cg = rep.cgImage
        if cache.count > 200 { cache.removeAll() }
        cache[k] = cg
        return cg
    }
}

/// a layer brick inside SwiftUI; in a snapshot, its picture
struct LayerBrick<V: LayerBrickView>: NSViewRepresentable {
    let make: () -> V
    let update: (V) -> Void
    var zoom: CGFloat = 1
    var still = false

    func makeNSView(context: Context) -> V { let v = make(); v.still = still; v.zoom = zoom; return v }
    func updateNSView(_ v: V, context: Context) {
        v.still = still
        v.zoom = zoom
        update(v)
    }
    /// whatever it is offered (the brick sets its height): without this SwiftUI asks AppKit for a fitting size,
    /// which builds an Auto Layout engine over the view's whole subtree on every refresh
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: V, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? nsView.bounds.width, height: proposal.height ?? nsView.bounds.height)
    }
}

/// a layer brick drawn once into an image, for ImageRenderer (snapshots)
struct LayerBrickSnapshot<V: LayerBrickView>: View {
    let size: CGSize
    let dark: Bool
    let make: () -> V
    let update: (V) -> Void

    var body: some View {
        let v = make()
        let _ = {
            v.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            v.still = true
            v.snapshot = true
            v.frame = CGRect(origin: .zero, size: size)
            update(v)
            v.layoutSubtreeIfNeeded()
        }()
        Image(nsImage: v.snapshotImage()).resizable().frame(width: size.width, height: size.height)
    }
}
