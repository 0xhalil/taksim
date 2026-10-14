import SwiftUI
import TaksimKit

/// An object's fields as label/value pairs (the first row of a list).
struct KVBrick: BrickView {
    static let name = "kv"
    let ctx: BrickContext
    init(ctx: BrickContext) { self.ctx = ctx }

    var body: some View {
        let pairs = Bricks.pairs(ctx.view, ctx.data)
        if pairs.isEmpty { BrickEmpty() } else {
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 2) {
                ForEach(Array(pairs.enumerated()), id: \.offset) { _, p in
                    GridRow {
                        Text(p.label).foregroundStyle(JB.muted).lineLimit(1)
                        Text(Bricks.show(p.value, max: 400)).foregroundStyle(Bricks.tone(p.value).color ?? JB.text)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                }
            }
            .font(.system(size: 12))
        }
    }
}
