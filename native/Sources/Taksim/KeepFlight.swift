import AppKit
import SwiftUI

/// The tools icon in the header: where a kept panel flies to, and how many were kept since it was last opened
/// (app.mjs gallery.bump).
@MainActor @Observable
final class ToolShelf {
    static let shared = ToolShelf()
    /// the icon's frame in the window's content (SwiftUI global coordinates, top-left origin)
    @ObservationIgnored var frame: CGRect?
    var count = 0
    @ObservationIgnored var open: (() -> Void)?

    func bump() { withAnimation(.spring(response: 0.35, dampingFraction: 0.5)) { count += 1 } }
}

/// a kept panel's outline shrinks into the tools icon (canvas.html .keepfly: 0.75 s, cubic-bezier(.6,0,.3,1))
@MainActor
enum KeepFlight {
    static func fly(in window: NSWindow, from windowRect: CGRect, done: @escaping () -> Void) {
        guard let content = window.contentView, let target = ToolShelf.shared.frame,
              !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { done(); return }
        let start = content.convert(windowRect, from: nil)
        let center = CGPoint(x: target.midX, y: content.isFlipped ? target.midY : content.bounds.height - target.midY)
        let end = CGRect(x: center.x - 9, y: center.y - 7, width: 18, height: 14)
        let v = NSView(frame: start)
        v.wantsLayer = true
        v.layer?.cornerRadius = 10
        v.layer?.borderWidth = 1.5
        v.layer?.borderColor = Pal.accent.cgColor
        v.layer?.backgroundColor = Pal.accent.withAlphaComponent(0.12).cgColor
        content.addSubview(v)
        let curve = CAMediaTimingFunction(controlPoints: 0.6, 0, 0.3, 1)
        let r = CABasicAnimation(keyPath: "cornerRadius")
        r.fromValue = 10; r.toValue = 4; r.duration = 0.75; r.timingFunction = curve
        v.layer?.add(r, forKey: "radius")
        v.layer?.cornerRadius = 4
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.75
            ctx.timingFunction = curve
            v.animator().frame = end
            v.animator().alphaValue = 0.25
        } completionHandler: {
            MainActor.assumeIsolated {
                v.removeFromSuperview()
                done()
            }
        }
    }
}

/// reports a view's frame in the window's content to the tool shelf
struct ToolShelfAnchor: View {
    var body: some View {
        GeometryReader { g in
            Color.clear
                .onAppear { ToolShelf.shared.frame = g.frame(in: .global) }
                .onChange(of: g.frame(in: .global)) { _, f in ToolShelf.shared.frame = f }
        }
    }
}
