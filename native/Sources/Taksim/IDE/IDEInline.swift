import SwiftUI
import TaksimKit

// ⌘K: a sentence floats over the lines it is about. One field; ⏎ sends it, the model's rewrite comes back as a
// small diff, and the one accent key (✓, ⏎) puts it into the file — ✕ or ⎋ drops it. Nothing is written until then.

struct InlineEditBar: View {
    let model: IDEModel
    let edit: IDEInlineEdit
    @FocusState private var focused: Bool
    @Environment(\.isSnapshot) private var isSnapshot

    var body: some View {
        VStack(spacing: 0) {
            header
            if case let .proposal(_, _, rows) = edit.phase {
                Rectangle().fill(JB.line).frame(height: 1)
                diff(rows)
            }
        }
        .frame(maxWidth: 560)
        .background(RoundedRectangle(cornerRadius: 10).fill(JB.panel).shadow(color: .black.opacity(0.35), radius: 16, y: 6))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(JB.line))
        .onAppear { if !isSnapshot, case .asking = edit.phase { focused = true } }
    }

    private var range: String { edit.from == edit.to ? "\(edit.from)" : "\(edit.from)–\(edit.to)" }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "sparkles").font(.system(size: 12)).foregroundStyle(JB.accent)
            switch edit.phase {
            case .asking:
                TextField("", text: Binding(get: { model.inline?.instruction ?? "" }, set: { model.inline?.instruction = $0 }))
                    .textFieldStyle(.plain).font(.system(size: 13)).foregroundStyle(JB.ink).focused($focused)
                    .onSubmit { model.submitInline() }
                    .onExitCommand { model.rejectInline() }
            case .running:
                Text(edit.instruction).font(.system(size: 12.5)).foregroundStyle(JB.muted).lineLimit(1)
                Spacer(minLength: 0)
                ProgressView().controlSize(.small)
            case .proposal:
                Text(edit.instruction).font(.system(size: 12.5)).foregroundStyle(JB.muted).lineLimit(1)
                Spacer(minLength: 0)
            case let .failed(message):
                Text(message).font(.system(size: 12)).foregroundStyle(JB.err).lineLimit(2).truncationMode(.tail)
                Spacer(minLength: 0)
            }
            Text(range).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(JB.muted2)
                .padding(.horizontal, 6).frame(height: 18)
                .background(Capsule().fill(JB.tint))
            actions
        }
        .padding(.leading, 12).padding(.trailing, 8).frame(minHeight: 38)
    }

    @ViewBuilder private var actions: some View {
        if case .proposal = edit.phase {
            Button { model.rejectInline() } label: { Image(systemName: "xmark").font(.system(size: 10, weight: .bold)) }
                .buttonStyle(CloseButtonStyle(size: 24)).keyboardShortcut(.cancelAction).help(L("Reject  ⎋"))
            Button { model.acceptInline() } label: {
                Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(JB.accentInk)
                    .frame(width: 30, height: 24).background(RoundedRectangle(cornerRadius: 6).fill(JB.accent))
            }
            .buttonStyle(Press()).keyboardShortcut(.defaultAction).help(L("Accept  ⏎"))
        } else if case .asking = edit.phase {
            Button { model.submitInline() } label: {
                Image(systemName: "arrow.up").font(.system(size: 11, weight: .bold))
                    .foregroundStyle(edit.instruction.trimmingCharacters(in: .whitespaces).isEmpty ? JB.muted2 : JB.accentInk)
                    .frame(width: 24, height: 24)
                    .background(Circle().fill(edit.instruction.trimmingCharacters(in: .whitespaces).isEmpty ? JB.tint : JB.accent))
            }
            .buttonStyle(Press()).help(L("Send  ⏎"))
        } else {
            Button { model.rejectInline() } label: { Image(systemName: "xmark").font(.system(size: 10, weight: .bold)) }
                .buttonStyle(CloseButtonStyle(size: 24)).help(L("Cancel  ⎋"))
        }
    }

    /// the rewrite as lines: what goes red, what comes in green, the rest dim
    private func diff(_ rows: [DiffRow]) -> some View {
        let lines = rows.flatMap { r -> [(DiffLine, Bool)] in
            if let o = r.old, let n = r.new, r.isChange { return [(o, false), (n, true)] }
            if let o = r.old, o.kind == .removed { return [(o, false)] }
            if let n = r.new { return [(n, n.kind == .added)] }
            return []
        }
        let body = VStack(alignment: .leading, spacing: 0) {
            if lines.isEmpty { Text(L("No change")).font(.system(size: 12)).foregroundStyle(JB.muted).padding(10) }
            ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
                HStack(spacing: 6) {
                    Text(l.0.kind == .added ? "+" : l.0.kind == .removed ? "−" : " ")
                        .font(.system(size: 11.5, design: .monospaced)).foregroundStyle(l.0.kind == .added ? JB.ok : JB.err).frame(width: 12)
                    Text(l.0.text.isEmpty ? " " : l.0.text).font(.system(size: 11.5, design: .monospaced))
                        .foregroundStyle(l.0.kind == .context ? JB.muted : JB.ink).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 10).frame(height: 17)
                .background(l.0.kind == .added ? JB.ok.opacity(0.14) : l.0.kind == .removed ? JB.err.opacity(0.14) : .clear)
            }
        }
        .padding(.vertical, 4)
        return Group {
            if isSnapshot { body.clipped() } else { ScrollView { body }.frame(maxHeight: 220) }
        }
    }
}
