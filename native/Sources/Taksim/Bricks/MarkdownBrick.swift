import SwiftUI
import TaksimKit

/// Text the agent writes: a summary, an explanation, a checklist. Static `text`, or a source holding a string
/// (anything else is shown as a JSON code block).
struct MarkdownBrick: BrickView {
    static let name = "markdown"
    let ctx: BrickContext
    init(ctx: BrickContext) { self.ctx = ctx }

    var body: some View {
        let src: String = switch ctx.data {
        case .string(let s): s
        case .null: ctx.view.string("text") ?? ""
        default: "```\n" + Bricks.pretty(ctx.data) + "\n```"
        }
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(MD.parse(src).enumerated()), id: \.offset) { _, b in block(b) }
        }
        .font(.system(size: 12.5))
        .lineSpacing(2)
        .foregroundStyle(JB.text)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder func block(_ b: MD.Block) -> some View {
        switch b {
        case .heading(let level, let spans):
            Self.text(spans).font(.system(size: level <= 1 ? 14 : 13, weight: .semibold)).foregroundStyle(JB.ink).padding(.top, 2)
        case .paragraph(let spans):
            Self.text(spans).fixedSize(horizontal: false, vertical: true)
        case .quote(let spans):
            Self.text(spans).foregroundStyle(JB.muted).padding(.leading, 9)
                .overlay(alignment: .leading) { Rectangle().fill(JB.line).frame(width: 2) }
        case .code(let code):
            Text(code).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(JB.text)
                .padding(.horizontal, 9).padding(.vertical, 7)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 6).fill(JB.bg))
        case .list(let ordered, let items):
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(items.enumerated()), id: \.offset) { i, it in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Group {
                            if let c = it.checked { Image(systemName: c ? "checkmark.square.fill" : "square").foregroundStyle(c ? JB.ok : JB.muted) }
                            else { Text(ordered ? "\(i + 1)." : "•").foregroundStyle(JB.muted) }
                        }
                        .frame(minWidth: 12, alignment: .trailing)
                        Self.text(it.spans).foregroundStyle(it.checked == true ? JB.muted : JB.text)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.leading, 4)
        }
    }

    /// bold, italic and code runs in one text
    static func text(_ spans: [MD.Span]) -> Text {
        var s = AttributedString()
        for span in spans {
            switch span {
            case .text(let t): s += AttributedString(t)
            case .bold(let t): var a = AttributedString(t); a.font = .system(size: 12.5, weight: .bold); s += a
            case .em(let t): var a = AttributedString(t); a.font = .system(size: 12.5).italic(); s += a
            case .code(let t):
                var a = AttributedString("\u{2009}\(t)\u{2009}")
                a.font = .system(size: 11.5, design: .monospaced)
                a.backgroundColor = JB.panel2
                s += a
            }
        }
        return Text(s)
    }
}
