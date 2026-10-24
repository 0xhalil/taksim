import SwiftUI
import TaksimKit

struct ChatReviewData: Decodable {
    var path: String
    var binary: Bool
    var writable: Bool
    var status: String
    var diff: String
    var hunks: [Hunk]
    struct Hunk: Decodable, Identifiable {
        var id: String
        var header: String
        var diff: String
        var status: String
    }
}

/// Frozen turn changes; one primary review action, details and reversal beside the affected code.
struct ChatReviewView: View {
    let entry: ChatEntry
    let model: ChatModel
    let store: CanvasStore
    var initialPath: String?
    var preview: ChatReviewData?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isSnapshot) private var snapshot
    @FocusState private var commentFocused: Bool
    @State private var selected = ""
    @State private var review: ChatReviewData?
    @State private var states: [String: String] = [:]
    @State private var busy = false
    @State private var loading = false
    @State private var error: String?
    @State private var comment = ""
    @State private var commentHunk: String?
    @State private var sent = false
    private var base: String { "/v1/canvases/\(model.canvas)/agents/\(model.agent)" }
    private var disabled: Bool { busy || loading || ["running", "waiting"].contains(model.agent(model.agent, store)?.status ?? "") }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "doc.text.magnifyingglass").foregroundStyle(JB.accent)
                Text(L("Changes")).fontWeight(.medium)
                Text(L("%d files", entry.changes?.count ?? 0)).foregroundStyle(JB.muted)
                Spacer()
                if busy || loading { ProgressView().controlSize(.small) }
                Button { dismiss() } label: { Image(systemName: "xmark") }.buttonStyle(Tap()).help(L("Close"))
            }.padding(12).background(JB.panel)
            Rectangle().fill(JB.line).frame(height: 1)
            HStack(spacing: 0) {
                Group {
                    if snapshot { fileList }
                    else { ScrollView { fileList } }
                }.frame(width: 170).frame(maxHeight: .infinity, alignment: .top).background(JB.panel)

                Rectangle().fill(JB.line).frame(width: 1)
                VStack(alignment: .leading, spacing: 0) {
                    if let review = review ?? preview {
                        HStack(spacing: 8) {
                            Text(review.path).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            Button { commentHunk = ""; sent = false; commentFocused = true } label: { Image(systemName: "bubble.left") }.buttonStyle(Tap()).help(L("Request a fix for this file"))
                            Button { store.showDiff(model.agent, path: review.path, old: entry.checkpoint, new: entry.after) } label: { Image(systemName: "arrow.up.right.square") }.buttonStyle(Tap()).help(L("Open in editor"))
                            actions(status: review.status, hunk: nil, writable: review.writable)
                        }.padding(10).background(JB.panel)
                        if snapshot { diffContent(review) }
                        else {
                            // a short diff starts at the top left, not in the middle of the pane
                            GeometryReader { g in
                                ScrollView([.vertical, .horizontal]) {
                                    diffContent(review).padding(10).frame(minWidth: g.size.width, minHeight: g.size.height, alignment: .topLeading)
                                }
                            }
                        }
                        if commentHunk != nil {
                            HStack(spacing: 8) {
                                TextField(L("Fix request"), text: $comment).textFieldStyle(.plain).focused($commentFocused).onSubmit { Task { await requestFix() } }
                                Button { Task { await requestFix() } } label: { Image(systemName: sent ? "checkmark" : "arrow.up") }
                                    .buttonStyle(Tap()).foregroundStyle(sent ? JB.ok : JB.accent)
                                    .disabled(disabled || comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.agent(model.agent, store)?.chatMode != "agent")
                                    .help(L("Ask the agent for a fix"))
                            }.padding(12).background(JB.panel)
                        }
                    } else { Spacer(); if !loading { Image(systemName: "doc.text.magnifyingglass").foregroundStyle(JB.muted) }; Spacer() }
                }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            if let error { Text(error).foregroundStyle(JB.err).padding(10).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled) }
        }.font(.system(size: 12)).foregroundStyle(JB.ink).background(JB.bg)
            .frame(minWidth: 680, idealWidth: 900, minHeight: 480, idealHeight: 650)
            .task { guard !snapshot else { return }; await loadStates(); selected = initialPath ?? entry.changes?.first?.path ?? "" }
            .task(id: selected) { if !snapshot { await load() } }
            .animation(reduceMotion || snapshot ? nil : .easeOut(duration: 0.2), value: states)
    }
    private var fileList: some View {
        VStack(alignment: .leading, spacing: 3) {
                    ForEach(entry.changes ?? []) { file in
                        Button { selected = file.path } label: {
                            HStack(spacing: 6) {
                                Image(systemName: symbol(states[file.path] ?? "pending")).foregroundStyle(states[file.path] == "kept" ? JB.ok : JB.muted)
                                Text((file.path as NSString).lastPathComponent).lineLimit(1)
                                Spacer(minLength: 0)
                            }.padding(7).contentShape(Rectangle())
                                .background(RoundedRectangle(cornerRadius: 4).fill(selected == file.path ? JB.accent.opacity(0.15) : .clear))
                        }.buttonStyle(Tap()).help(file.path).disabled(busy)
                    }
        }.padding(8)
    }
    private func symbol(_ status: String) -> String {
        status == "kept" ? "checkmark.circle.fill" : status == "reverted" ? "arrow.uturn.backward.circle" : status == "partial" ? "circle.lefthalf.filled" : "circle"
    }
    @ViewBuilder private func actions(status: String, hunk: String?, writable: Bool) -> some View {
        if status == "reverted" {
            Button { Task { await change("redo", hunk: hunk) } } label: { Label(L("Redo"), systemImage: "arrow.uturn.forward") }.buttonStyle(Tap()).disabled(disabled || !writable)
        } else {
            Button { Task { await change("keep", hunk: hunk) } } label: { Label(status == "kept" ? (hunk == nil ? L("File kept") : L("Hunk kept")) : (hunk == nil ? L("Keep file") : L("Keep hunk")), systemImage: "checkmark") }
                .buttonStyle(Tap()).foregroundStyle(status == "kept" ? JB.ok : JB.accent).disabled(disabled || status == "kept")
            Button { Task { await change("revert", hunk: hunk) } } label: { Image(systemName: "arrow.uturn.backward") }.buttonStyle(Tap()).disabled(disabled || !writable).help(L("Revert"))
        }
    }
    @ViewBuilder private func diffContent(_ review: ChatReviewData) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if review.binary { Label(L("Binary file"), systemImage: "doc") }
            else if review.hunks.isEmpty { code(review.diff) }
            else {
                ForEach(review.hunks) { hunk in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            Text(hunk.header).font(.system(size: 10, design: .monospaced)).foregroundStyle(JB.muted)
                            Spacer()
                            Button { commentHunk = hunk.id; sent = false; commentFocused = true } label: { Image(systemName: "bubble.left") }.buttonStyle(Tap()).help(L("Request a fix for this change"))
                            actions(status: hunk.status, hunk: hunk.id, writable: review.writable && review.status != "reverted")
                        }
                        code(hunk.diff.hasPrefix("@@") ? String(hunk.diff.drop { $0 != "\n" }.dropFirst()) : hunk.diff) // its header is the line above
                    }.padding(8).background(RoundedRectangle(cornerRadius: 5).fill(JB.panel))
                        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(commentHunk == hunk.id ? JB.accent : .clear))
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func code(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array((text.hasSuffix("\n") ? text.dropLast() : text[...]).split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, line in
                Text(String(line).isEmpty ? " " : String(line)).font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(line.hasPrefix("+") ? JB.ok : line.hasPrefix("-") ? JB.err : JB.text)
                    .textSelection(.enabled).fixedSize(horizontal: true, vertical: false)
            }
        }
    }
    private func loadStates() async {
        guard let from = entry.checkpoint, let to = entry.after else { return }
        struct States: Decodable {
            struct File: Decodable { var path: String; var status: String }
            var files: [File]
        }
        if let data = try? await model.api.get("\(base)/review?from=\(from)&to=\(to)", as: States.self) {
            states = Dictionary(data.files.map { ($0.path, $0.status) }, uniquingKeysWith: { _, last in last })
        }
    }
    private func load() async {
        guard !selected.isEmpty, let from = entry.checkpoint, let to = entry.after else { return }
        let file = selected
        loading = true; review = nil; error = nil; commentHunk = nil; comment = ""; sent = false
        defer { if selected == file { loading = false } }
        let q = file.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&+=#?"))) ?? file
        do {
            let value = try await model.api.get("\(base)/review?from=\(from)&to=\(to)&path=\(q)", as: ChatReviewData.self)
            guard selected == file && !Task.isCancelled else { return }
            review = value; states[file] = value.status
        } catch { if selected == file && !Task.isCancelled { self.error = (error as? APIError)?.message ?? error.localizedDescription } }
    }
    private func change(_ action: String, hunk: String?) async {
        guard !disabled, let from = entry.checkpoint, let to = entry.after else { return }
        busy = true; error = nil; defer { busy = false }
        var args: [String: Any] = ["from": from, "to": to, "path": selected, "action": action]
        if let hunk { args["hunk"] = hunk }
        do { review = try await model.api.post("\(base)/review", args, as: ChatReviewData.self); states[selected] = review?.status }
        catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
    }
    private func requestFix() async {
        guard !disabled, !comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, model.agent(model.agent, store)?.chatMode == "agent", let review else { return }
        let diff = review.hunks.first { $0.id == commentHunk }?.diff ?? review.diff
        busy = true; error = nil; defer { busy = false }
        do {
            _ = try await model.api.post("\(base)/messages", ["text": "My fix request for the \(review.path) change: \(comment)\n\nReviewed turn: \(entry.checkpoint ?? "") → \(entry.after ?? "")\n<review_diff>\n\(diff.prefix(20000))\n</review_diff>"])
            comment = ""; sent = true
        } catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
    }
}
