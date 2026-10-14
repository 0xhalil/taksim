import SwiftUI
import TaksimKit

// The Fark view: a changed file against HEAD, side by side, the way JetBrains and Cursor show one — removed
// lines red on the left, added lines green on the right, the middle that really changed inside a rewritten
// line lit brighter. Rows are walked by the engine (TaksimKit's LineDiff), never by the eye.

struct IDEDiffView: View {
    let model: IDEModel
    let diff: IDEDiff

    private var columns: CGFloat {
        // one column per side, wide enough for the longest line (capped: past that it scrolls)
        let longest = diff.rows.reduce(0) { max($0, max($1.old?.text.count ?? 0, $1.new?.text.count ?? 0)) }
        return min(1600, max(300, CGFloat(longest) * 7.3 + 58))
    }

    var body: some View {
        VStack(spacing: 0) {
            bar
            Rectangle().fill(JB.line).frame(height: 1)
            ScrollView([.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(diff.rows.enumerated()), id: \.offset) { _, row in line(row) }
                }
                .padding(.vertical, 4)
            }
        }
        .background(JB.bg)
    }

    private var bar: some View {
        HStack(spacing: 8) {
            FileIcon(path: diff.path)
            Text((diff.path as NSString).lastPathComponent).font(.system(size: 12, weight: .medium)).foregroundStyle(JB.ink).lineLimit(1)
            Text((diff.path as NSString).deletingLastPathComponent).font(.system(size: 11)).foregroundStyle(JB.muted2).lineLimit(1).truncationMode(.head)
            Spacer(minLength: 8)
            HStack(spacing: 4) {
                Text(diff.oldLabel).font(.system(size: 10, weight: .medium)).foregroundStyle(JB.muted2)
                Image(systemName: "arrow.left.arrow.right").font(.system(size: 8)).foregroundStyle(JB.muted2)
                Text(diff.newLabel).font(.system(size: 10, weight: .medium)).foregroundStyle(JB.muted2)
            }
            Button { model.closeDiff() } label: { Image(systemName: "xmark").font(.system(size: 8, weight: .bold)) }
                .buttonStyle(CloseButtonStyle(size: 18)).help(L("Close diff  ⎋"))
        }
        .padding(.leading, 10).padding(.trailing, 6).frame(height: 32)
        .background(JB.panel)
    }

    private func line(_ row: DiffRow) -> some View {
        HStack(spacing: 0) {
            cell(row.old, side: .old, tone: JB.err, filler: row.old == nil)
            Rectangle().fill(JB.line).frame(width: 1)
            cell(row.new, side: .new, tone: JB.ok, filler: row.new == nil)
        }
        .frame(height: 17)
    }

    private enum Side { case old, new }

    @ViewBuilder private func cell(_ line: DiffLine?, side: Side, tone: Color, filler: Bool) -> some View {
        HStack(spacing: 0) {
            Text(line?.number.map(String.init) ?? "")
                .font(.system(size: 10.5, design: .monospaced)).foregroundStyle(JB.muted2)
                .frame(width: 42, alignment: .trailing).padding(.trailing, 6)
            if let line {
                styled(line, tone: tone)
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(line.kind == .context ? JB.text : JB.ink)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.leading, 4)
        .frame(width: columns, alignment: .leading)
        .background(background(line, tone: tone, filler: filler))
    }

    private func background(_ line: DiffLine?, tone: Color, filler: Bool) -> Color {
        if filler { return JB.panel.opacity(0.45) }
        switch line?.kind {
        case .removed, .added: return tone.opacity(0.13)
        default: return .clear
        }
    }

    /// the line, with the middle that changed lit brighter than the rest of it
    private func styled(_ line: DiffLine, tone: Color) -> Text {
        guard let hot = line.hot else { return Text(line.text) }
        let chars = Array(line.text)
        var out = AttributedString(String(chars[..<hot.lowerBound]))
        var mid = AttributedString(String(chars[hot]))
        mid.backgroundColor = tone.opacity(0.32)
        out += mid
        out += AttributedString(String(chars[hot.upperBound...]))
        return Text(out)
    }
}
