import SwiftUI
import TaksimKit

/// One big number or word, colored by the spec's thresholds (or by what the word says). A number rolls to its
/// new value.
struct StatBrick: BrickView {
    static let name = "stat"
    static let showsAge = false
    let ctx: BrickContext
    init(ctx: BrickContext) { self.ctx = ctx }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let s = Bricks.stat(ctx.view, ctx.data)
        let n = Double(s.text.split(separator: " ").first ?? "")
        Text(s.text)
            .font(.system(size: 26, weight: .semibold)).kerning(-0.5)
            .foregroundStyle(s.tone.color ?? JB.ink)
            .lineLimit(1).truncationMode(.tail)
            .contentTransition(n.map { .numericText(value: $0) } ?? .opacity)
            .animation(reduceMotion ? nil : .spring(response: 0.5, dampingFraction: 0.85), value: s.text)
            .animation(.easeInOut(duration: 0.3), value: s.tone)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
