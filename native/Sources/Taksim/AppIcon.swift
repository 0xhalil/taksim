import AppKit
import SwiftUI

/// Standard macOS symbols. Close, collapse and add retain their familiar x / − / + shapes.
struct AppSymbol: View {
    let name: String
    var body: some View {
        GeometryReader { geometry in
            Image(systemName: name)
                .font(.system(size: min(geometry.size.width, geometry.size.height), weight: .regular))
                .frame(width: geometry.size.width, height: geometry.size.height)
        }
    }
    var templateImage: NSImage {
        NSImage(systemSymbolName: name, accessibilityDescription: nil)!
    }
}

enum AppIcon {
    static let lock = AppSymbol(name: "lock.fill")
    static let close = AppSymbol(name: "xmark")
    static let minimize = AppSymbol(name: "minus")
    static let plus = AppSymbol(name: "plus")
    static let fit = AppSymbol(name: "arrow.up.left.and.arrow.down.right")
    static let adjust = AppSymbol(name: "slider.horizontal.3")
    static let settings = AppSymbol(name: "gearshape")
    static let terminal = AppSymbol(name: "terminal")
    static let code = AppSymbol(name: "chevron.left.forwardslash.chevron.right")
    static let helpers = AppSymbol(name: "person.2")
    static let brain = AppSymbol(name: "brain")
    static let toolHelp = AppSymbol(name: "wand.and.stars")
    static let toolHelpOff = AppSymbol(name: "wand.and.stars.inverse")
    static let gauge = AppSymbol(name: "gauge.with.dots.needle.67percent")
    static let helpersOn = AppSymbol(name: "person.2.fill")
    static let note = AppSymbol(name: "book.closed")
    static let noteFilled = AppSymbol(name: "book.closed.fill")
    static let left = AppSymbol(name: "chevron.left")
    static let right = AppSymbol(name: "chevron.right")
    static let down = AppSymbol(name: "chevron.down")
    static let search = AppSymbol(name: "magnifyingglass")
    static let navigator = AppSymbol(name: "sidebar.left")
    static let check = AppSymbol(name: "checkmark")
    static let grid = AppSymbol(name: "circle.grid.3x3")
    static let group = AppSymbol(name: "rectangle.3.group")
    static let warning = AppSymbol(name: "exclamationmark.triangle")
    static let folder = AppSymbol(name: "folder")
    static let branch = AppSymbol(name: "arrow.triangle.branch")
    static let user = AppSymbol(name: "person")
    static let tools = AppSymbol(name: "square.stack.3d.up")

    /// a symbol tinted and rasterized once per name, size and color; the canvas draws dozens on every redraw
    static func draw(_ icon: AppSymbol, in ctx: CGContext, rect: CGRect, color: NSColor) {
        let c = color.usingColorSpace(.sRGB) ?? color
        let key = "\(icon.name)|\(Int(rect.width * 4))x\(Int(rect.height * 4))|\(Int(c.redComponent * 255)),\(Int(c.greenComponent * 255)),\(Int(c.blueComponent * 255)),\(Int(c.alphaComponent * 255))"
        if let hit = rendered[key] {
            hit.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            return
        }
        let img = NSImage(size: rect.size, flipped: false) { b in drawUncached(icon, rect: b, color: c); return true }
        // rasterize now (at 2× for retina) so the drawing handler doesn't run again on every draw
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: max(1, Int(rect.width * 2)), pixelsHigh: max(1, Int(rect.height * 2)), bitsPerSample: 8,
                                   samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        if let rep {
            rep.size = rect.size
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            img.draw(in: CGRect(origin: .zero, size: rect.size))
            NSGraphicsContext.restoreGraphicsState()
            let cached = NSImage(size: rect.size)
            cached.addRepresentation(rep)
            if rendered.count > 500 { rendered.removeAll() }
            rendered[key] = cached
            cached.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        } else {
            drawUncached(icon, rect: rect, color: c)
        }
    }
    nonisolated(unsafe) private static var rendered: [String: NSImage] = [:] // drawn on the main thread only

    private static func drawUncached(_ icon: AppSymbol, rect: CGRect, color: NSColor) {
        let source = icon.templateImage.withSymbolConfiguration(.init(pointSize: rect.height, weight: .regular)) ?? icon.templateImage
        let tinted = NSImage(size: source.size, flipped: false) { bounds in
            source.draw(in: bounds)
            color.setFill()
            bounds.fill(using: .sourceIn)
            return true
        }
        let ratio = min(rect.width / source.size.width, rect.height / source.size.height)
        let size = CGSize(width: source.size.width * ratio, height: source.size.height * ratio)
        tinted.draw(in: CGRect(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2, width: size.width, height: size.height),
                    from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }
}
