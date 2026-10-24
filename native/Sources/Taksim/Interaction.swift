import AppKit
import SwiftUI

// How controls answer the pointer, everywhere the same: hovering lights a control up, pressing sinks it a
// little with a spring, and both ease instead of jumping (Apple's buttons, Braun's switches that give way).

/// for a button that draws its own face (tiles, capsules, wells, rows): a lift on hover, a sink on press
/// The lift is a wash of ink over the face's own shape (brightness alone said nothing on a white face in the
/// light theme), and the pointer becomes a hand: over any button it is plain that it is one.
struct Press: ButtonStyle {
    var scale: CGFloat = 0.96
    func makeBody(configuration: Configuration) -> some View { Face(configuration: configuration, scale: scale) }

    private struct Face: View {
        let configuration: Configuration
        let scale: CGFloat
        @Environment(\.isEnabled) private var enabled
        @Environment(\.isSnapshot) private var snapshot
        @State private var hover = false
        var body: some View {
            let lit = hover && enabled, down = configuration.isPressed && enabled
            configuration.label
                .overlay { if lit || down { JB.ink.opacity(down ? 0.16 : 0.08).mask(configuration.label).allowsHitTesting(false) } }
                .scaleEffect(down ? scale : 1)
                .onHover { hover = $0 }
                .pointerStyle(enabled ? .link : .default)
                .animation(snapshot ? nil : .spring(response: 0.25, dampingFraction: 0.6), value: down)
                .animation(snapshot ? nil : .easeOut(duration: 0.15), value: lit)
        }
    }
}

/// A click on a window that isn't the active one lands on what was clicked, instead of only bringing the window
/// forward: coming back to the app, the first press on a button is a press. SwiftUI's hosting views say no to
/// this by default; the answer is changed on the view's own class.
@MainActor
enum FirstClick {
    private static var done = Set<ObjectIdentifier>()
    static func enable(on view: NSView?) {
        guard let view else { return }
        let cls: AnyClass = type(of: view)
        guard done.insert(ObjectIdentifier(cls)).inserted else { return }
        let block: @convention(block) (AnyObject, NSEvent?) -> Bool = { _, _ in true }
        let selector = #selector(NSView.acceptsFirstMouse(for:))
        guard let method = class_getInstanceMethod(NSView.self, selector) else { return }
        class_replaceMethod(cls, selector, imp_implementationWithBlock(block), method_getTypeEncoding(method))
    }
}

/// a small control in a chat (an icon, a short label, a row): a well comes up under it on hover and darkens as it
/// is pressed, and the pointer becomes a hand, so it is plain that this is a button and that the press landed.
/// One that can't be pressed now is faint and answers nothing.
struct Tap: ButtonStyle {
    var well = true
    var dim = true
    func makeBody(configuration: Configuration) -> some View { Face(configuration: configuration, well: well, dim: dim) }

    private struct Face: View {
        let configuration: Configuration
        let well: Bool
        let dim: Bool
        @Environment(\.isEnabled) private var enabled
        @Environment(\.isSnapshot) private var snapshot
        @State private var hover = false
        var body: some View {
            let lit = hover && enabled, down = configuration.isPressed && enabled
            configuration.label
                .brightness(down ? -0.08 : lit && !well ? 0.06 : 0)
                .background(RoundedRectangle(cornerRadius: 5).fill(!well ? .clear : down ? JB.line : lit ? JB.line.opacity(0.55) : .clear).padding(-3))
                .scaleEffect(down ? 0.93 : 1)
                .opacity(enabled || !dim ? 1 : 0.4)
                .contentShape(Rectangle())
                .onHover { hover = $0 }
                .pointerStyle(enabled ? .link : .default)
                .animation(snapshot ? nil : .spring(response: 0.22, dampingFraction: 0.65), value: down)
                .animation(snapshot ? nil : .easeOut(duration: 0.12), value: lit)
        }
    }
}

/// a composer's drop-down chip (Agent, Auto, the model, thinking): a well appears under it on hover, the pointer says it
/// is a button, and it dips a little while the menu opens. The well is drawn outside the chip, so the row doesn't shift.
/// Apply it after `.disabled`, so a chip that can't be used doesn't light.
struct ChipHover: ViewModifier {
    @Environment(\.isEnabled) private var enabled
    @Environment(\.isSnapshot) private var snapshot
    @State private var hover = false
    func body(content: Content) -> some View {
        let lit = hover && enabled
        content
            .background(RoundedRectangle(cornerRadius: 6).fill(lit ? JB.line.opacity(0.55) : .clear).padding(.horizontal, -6).padding(.vertical, -3))
            .contentShape(Rectangle())
            .onHover { hover = $0 }
            .pointerStyle(enabled ? .link : .default)
            .animation(snapshot ? nil : .easeOut(duration: 0.12), value: lit)
    }
}
extension View { func chipHover() -> some View { modifier(ChipHover()) } }

/// the small × that closes a tab, a strip, a capsule: a round well appears under it on hover, it sinks on press
struct CloseButtonStyle: ButtonStyle {
    var size: CGFloat = 18
    func makeBody(configuration: Configuration) -> some View {
        Hovering { hover in
            configuration.label
                .foregroundStyle(hover ? JB.ink : JB.muted)
                .frame(width: size, height: size)
                .contentShape(Rectangle()) // the whole square takes the click, not just the glyph
                .background(Circle().fill(configuration.isPressed ? JB.line : hover ? JB.panel2 : .clear))
                .scaleEffect(configuration.isPressed ? 0.86 : 1)
                .pointerStyle(.link)
                .animation(.spring(response: 0.22, dampingFraction: 0.6), value: configuration.isPressed)
                .animation(.easeOut(duration: 0.12), value: hover)
        }
    }
}
