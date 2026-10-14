import SwiftUI
import TaksimKit

/// Ranked horizontal bars, a bar-chart race (bricks.mjs bars): rows with the same label add up (or are
/// counted); on every refresh bars slide to their new rank (600 ms, cubic-bezier(.34,1.25,.64,1)), widths ease
/// (600 ms), numbers count to their new value, new bars come up from below, gone ones fade (400 ms).
struct BarsBrick: BrickView {
    static let name = "bars"
    let ctx: BrickContext
    init(ctx: BrickContext) { self.ctx = ctx }

    @Environment(\.stillMotion) private var still

    static let rowH: CGFloat = 22

    final class Memo { var drawn = false }

    var body: some View {
        let v = ctx.view
        let list = Bricks.ranked(ctx.data, v)
        let given = v.number("max") ?? 0
        let top = given > 0 ? given : max(list.map(\.value).max() ?? 0, 0)
        let full = top > 0 ? top : 1
        let unit = v.string("unit").map { " \($0)" } ?? ""
        let memo = BrickMemos.get(ctx.memoKey + (ctx.preview ? "#preview" : "")) { Memo() }
        let drawn = memo.drawn
        let labW = min(ctx.width * 0.38, 170)
        if list.isEmpty { BrickEmpty() } else {
            ZStack(alignment: .topLeading) {
                ForEach(Array(list.enumerated()), id: \.element.label) { i, it in
                    BarRow(item: it, frac: max(0, min(1, it.value / full)), tone: Bricks.thresholdTone(v, it.value), unit: unit, labW: labW, still: still)
                        .offset(y: CGFloat(i) * Self.rowH)
                        .transition(.asymmetric(
                            insertion: .offset(y: drawn ? CGFloat(list.count - i) * Self.rowH : 0).combined(with: .opacity),
                            removal: .opacity.animation(.easeOut(duration: 0.4))))
                }
            }
            .frame(height: CGFloat(list.count) * Self.rowH, alignment: .top)
            .animation(still ? nil : Bezier.spring.animation(0.6), value: list.map(\.label))
            .animation(still ? nil : .easeOut(duration: 0.4), value: list.count)
            .onAppear { memo.drawn = true }
        }
    }
}

struct BarRow: View {
    let item: Bricks.Ranked
    let frac: Double
    let tone: Tone
    let unit: String
    let labW: CGFloat
    let still: Bool
    /// a new bar grows from nothing and its number counts up from 0
    @State private var appeared = false

    var body: some View {
        let on = appeared || still
        HStack(spacing: 8) {
            Text(item.label).foregroundStyle(JB.text).lineLimit(1).truncationMode(.tail)
                .frame(width: labW, alignment: .leading)
                .help(item.label)
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3).fill(JB.panel2)
                    RoundedRectangle(cornerRadius: 3).fill(tone.color ?? JB.accent)
                        .frame(width: g.size.width * (on ? frac : 0))
                        .animation(still ? nil : Bezier.out.animation(0.6), value: on ? frac : 0)
                        .animation(still ? nil : .easeInOut(duration: 0.3), value: tone)
                }
            }
            .frame(height: 12)
            Group {
                if let raw = item.raw { Text(raw) }
                else {
                    let whole = item.value == item.value.rounded()
                    CountText(value: on ? item.value : 0) { n in Bricks.fmtNum(whole ? n.rounded() : n) + unit }
                        .animation(still ? nil : .brickMove, value: on ? item.value : 0)
                }
            }
            .foregroundStyle(JB.ink).monospacedDigit().lineLimit(1)
            .frame(minWidth: 44, alignment: .trailing)
        }
        .font(.system(size: 11.5))
        .frame(height: BarsBrick.rowH)
        .onAppear { if !still { DispatchQueue.main.async { appeared = true } } }
    }
}
