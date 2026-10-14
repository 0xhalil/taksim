import SwiftUI
import TaksimKit

/// Raw data as indented JSON, for anything without a better view (and for bricks this app doesn't know yet).
struct JSONBrick: BrickView {
    static let name = "json"
    let ctx: BrickContext
    init(ctx: BrickContext) { self.ctx = ctx }

    var body: some View {
        let full = Bricks.pretty(ctx.data)
        let text = full.count > 60000 ? String(full.prefix(60000)) + "\n…" : full
        let lines = text.reduce(1) { $1 == "\n" ? $0 + 1 : $0 }
        BrickScroll(axes: [.vertical, .horizontal], height: min(340, CGFloat(lines) * 16.7 + 14)) {
            Text(text).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(JB.text)
                .lineSpacing(1.5)
                .textSelection(.enabled)
                .fixedSize()
                .padding(.horizontal, 9).padding(.vertical, 7)
        }
        .background(RoundedRectangle(cornerRadius: 6).fill(JB.bg))
    }
}
