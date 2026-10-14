import SwiftUI
import TaksimKit

// A scene's words and timing, edited in place (Claude Motion: "change any word, number or timing"): every
// text the scene writes — its own or one per row, templates included — and every step's length. Saving
// replaces the view's definition; the scene plays again with the change.

struct SceneEditor: View {
    let raw: JSONValue
    let save: (JSONValue) async -> String?
    let done: () -> Void
    @State private var draft: JSONValue = .null
    @State private var error: String?
    @State private var busy = false

    /// where each text lives: (list key path, index in it)
    private struct TextRef: Identifiable, Hashable { var each: Bool; var index: Int; var id: String { "\(each ? "each" : "top").\(index)" } }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            let texts = textRefs
            if !texts.isEmpty {
                section(L("Texts"))
                ForEach(texts) { r in
                    HStack(spacing: 8) {
                        Text(shape(r)["id"]?.string ?? "—").font(.system(size: 10.5, design: .monospaced)).foregroundStyle(JB.muted)
                            .frame(width: 64, alignment: .leading).lineLimit(1)
                        TextField("", text: Binding(get: { shape(r)["text"]?.string ?? "" }, set: { setText(r, $0) }))
                            .textFieldStyle(.plain).font(.system(size: 12)).foregroundStyle(JB.ink)
                            .padding(.horizontal, 7).frame(height: 24)
                            .background(RoundedRectangle(cornerRadius: 5).fill(JB.bg.opacity(0.6)))
                            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(JB.line))
                        if r.each { Image(systemName: "square.stack").font(.system(size: 10)).foregroundStyle(JB.muted).help(L("per row")) }
                    }
                }
            }
            let steps = draft["steps"]?.array ?? []
            if !steps.isEmpty {
                section(L("Timing"))
                ForEach(steps.indices, id: \.self) { i in
                    HStack(spacing: 8) {
                        Text(steps[i]["do"]?.string ?? "").font(.system(size: 11.5, weight: .medium)).foregroundStyle(JB.ink).frame(width: 64, alignment: .leading)
                        Text(Self.target(steps[i]["target"])).font(.system(size: 11, design: .monospaced)).foregroundStyle(JB.muted).lineLimit(1)
                        Spacer(minLength: 8)
                        let dur = steps[i]["dur"]?.number ?? 0.6
                        Stepper(value: Binding(get: { dur }, set: { setDur(i, $0) }), in: 0...10, step: 0.1) {
                            Text(L("%.1f sec", dur)).font(.system(size: 11.5)).monospacedDigit().foregroundStyle(JB.ink)
                        }
                        .controlSize(.mini)
                    }
                }
            }
            if let error { Label(error, systemImage: "exclamationmark.triangle.fill").font(.system(size: 11.5)).foregroundStyle(JB.err).lineLimit(3) }
            HStack {
                Spacer()
                Button(L("Cancel")) { done() }.buttonStyle(StripButton())
                Button { Task { busy = true; error = await save(draft); busy = false; if error == nil { done() } } } label: {
                    if busy { ProgressView().controlSize(.mini) } else { Text(L("Save")) }
                }
                .buttonStyle(StripButton(primary: true)).disabled(draft == raw || busy)
            }
        }
        .padding(12)
        .frame(width: 380)
        .background(JB.panel)
        .onAppear { draft = raw }
    }

    private func section(_ t: String) -> some View {
        Text(t).font(.system(size: 11, weight: .semibold)).foregroundStyle(JB.muted)
    }

    // ---------- the draft ----------

    private var textRefs: [TextRef] {
        let top = (draft["shapes"]?.array ?? []).indices.filter { draft["shapes"]?.array?[$0]["type"]?.string == "text" }.map { TextRef(each: false, index: $0) }
        let each = (draft["each"]?["shapes"]?.array ?? []).indices.filter { draft["each"]?["shapes"]?.array?[$0]["type"]?.string == "text" }.map { TextRef(each: true, index: $0) }
        return top + each
    }
    private func shape(_ r: TextRef) -> JSONValue {
        (r.each ? draft["each"]?["shapes"]?.array : draft["shapes"]?.array)?[safe: r.index] ?? .null
    }
    private func setText(_ r: TextRef, _ t: String) {
        guard case .object(var root) = draft else { return }
        if r.each {
            guard case .object(var each)? = root["each"], case .array(var list)? = each["shapes"], case .object(var s) = list[r.index] else { return }
            s["text"] = .string(t); list[r.index] = .object(s); each["shapes"] = .array(list); root["each"] = .object(each)
        } else {
            guard case .array(var list)? = root["shapes"], case .object(var s) = list[r.index] else { return }
            s["text"] = .string(t); list[r.index] = .object(s); root["shapes"] = .array(list)
        }
        draft = .object(root)
    }
    private func setDur(_ i: Int, _ d: Double) {
        guard case .object(var root) = draft, case .array(var steps)? = root["steps"], case .object(var st) = steps[i] else { return }
        st["dur"] = .number((d * 10).rounded() / 10); steps[i] = .object(st); root["steps"] = .array(steps)
        draft = .object(root)
    }
    static func target(_ v: JSONValue?) -> String {
        if let s = v?.string { return s }
        return (v?.array ?? []).compactMap(\.string).joined(separator: ", ")
    }
}
