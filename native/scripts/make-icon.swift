// Draws the app icon (native/Resources/AppIcon.icns): taksim's mark in white on the accent blue. The mark's
// geometry is TaksimKit's (Sources/TaksimKit/TaksimMark.swift), so run it through make-icon.sh (needs iconutil).
import AppKit

func hex(_ v: UInt32, _ a: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat(v >> 16 & 0xFF) / 255, green: CGFloat(v >> 8 & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: a)
}

func draw(_ size: Int) -> Data {
    let s = CGFloat(size)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ctx = NSGraphicsContext.current!.cgContext
    ctx.scaleBy(x: s / 1024, y: s / 1024)
    // flip: y down, as the canvas draws
    ctx.translateBy(x: 0, y: 1024); ctx.scaleBy(x: 1, y: -1)

    // Apple's grid: the body is 824 wide at 100, corners 185; a soft shadow under it
    let body = CGRect(x: 100, y: 100, width: 824, height: 824)
    let shape = CGPath(roundedRect: body, cornerWidth: 185, cornerHeight: 185, transform: nil)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: 10), blur: 28, color: hex(0x000000, 0.35).cgColor)
    ctx.setFillColor(hex(0x3574F0).cgColor); ctx.addPath(shape); ctx.fillPath()
    ctx.restoreGState()
    // a little light from above, so the key doesn't read flat
    ctx.saveGState()
    ctx.addPath(shape); ctx.clip()
    let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [hex(0xFFFFFF, 0.14).cgColor, hex(0xFFFFFF, 0).cgColor] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(grad, start: CGPoint(x: 512, y: 100), end: CGPoint(x: 512, y: 620), options: [])
    ctx.restoreGState()

    // the mark, white, centred; the small cut for the small sizes
    let side: CGFloat = 540, k = side / TaksimMark.crop.width
    var t = CGAffineTransform(translationX: 512 - side / 2, y: 512 - side / 2).scaledBy(x: k, y: k).translatedBy(x: -TaksimMark.crop.minX, y: -TaksimMark.crop.minY)
    if let mark = (size <= 64 ? TaksimMark.compact : TaksimMark.full).copy(using: &t) {
        ctx.setFillColor(hex(0xFFFFFF).cgColor); ctx.addPath(mark); ctx.fillPath(using: .winding)
    }

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let here = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
let set = here.appending(path: "../Resources/AppIcon.iconset").standardized
try? FileManager.default.removeItem(at: set)
try! FileManager.default.createDirectory(at: set, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    try! draw(base).write(to: set.appending(path: "icon_\(base)x\(base).png"))
    try! draw(base * 2).write(to: set.appending(path: "icon_\(base)x\(base)@2x.png"))
}
let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", set.path, "-o", set.deletingLastPathComponent().appending(path: "AppIcon.icns").path]
try! p.run(); p.waitUntilExit()
try? FileManager.default.copyItem(at: set.appending(path: "icon_512x512@2x.png"), to: set.deletingLastPathComponent().appending(path: "AppIcon.png"))
try? FileManager.default.removeItem(at: set)
print(p.terminationStatus == 0 ? "native/Resources/AppIcon.icns" : "iconutil failed")
