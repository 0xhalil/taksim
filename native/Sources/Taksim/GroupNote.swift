import AppKit
import SwiftUI
import TaksimKit

/// A group's memory: what its agents know together beyond what they tell each other directly — goals,
/// decisions, conventions, findings. It reads as entries, each beside the one who wrote it (an agent's logo,
/// or you); a click edits an entry in place, × drops it (↶ brings it back), + adds one. Every save is a version,
/// so nothing is lost; older versions are a menu away. Members carry a dot: filled once they've read the latest.
/// One member is the keeper (the agent allowed to rewrite the whole memory; the group's orchestrator unless you
/// pick another); every member may add to it.
struct GroupNoteView: View {
    let store: CanvasStore
    let gid: String

    struct Detail: Decodable {
        var name: String; var members: [String]?; var maintainer: String?; var version: Int?
        var context: String?; var color: String?; var memory: [MemoryEntry]?; var seen: [String: Int?]?
    }
    private struct Versions: Decodable { var versions: [Int] }
    private struct Old: Decodable { var content: String }
    private enum Field: Hashable { case entry(Int), add, raw }

    @Environment(\.isSnapshot) private var isSnapshot
    @State private var detail: Detail?
    @State private var entries: [MemoryEntry] = []
    @State private var versions: [Int] = []
    /// an older version being looked at (read-only; ↺ makes it the newest)
    @State private var viewing: Int?
    @State private var old: [String] = []
    @State private var editing: Int?
    @State private var draft = ""
    @State private var adding = ""
    /// the whole memory as markdown, for edits across entries
    @State private var raw = false
    @State private var rawText = ""
    @State private var rawSave: Task<Void, Never>?
    @State private var undo: [MemoryEntry]?
    @State private var savedFlash = false
    @FocusState private var focus: Field?

    private var path: String { "/v1/canvases/\(store.currentId ?? "")/groups/\(gid)" }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            SwiftUI.Group {
                if raw { rawEditor }
                else if viewing != nil { list(old.map { MemoryEntry(text: $0, by: nil) }, live: false) }
                else { list(entries, live: true) }
            }
            .background(RoundedRectangle(cornerRadius: 6).fill(JB.bg.opacity(0.6)))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(viewing == nil ? JB.line : JB.warn))
            members
        }
        .padding(14)
        .frame(width: 440)
        .background(JB.panel)
        .task { await load() }
        .onChange(of: store.groups[gid]?.version) { _, _ in if editing == nil && !raw && viewing == nil { Task { await load() } } }
        .onChange(of: store.groups[gid]?.seen) { _, now in detail?.seen = now ?? detail?.seen }
        .onChange(of: store.groups[gid]?.members) { _, now in if let now { detail?.members = now } }
        .onChange(of: store.groups[gid]?.maintainer) { _, now in detail?.maintainer = now ?? nil }
        .onChange(of: rawText) { _, now in scheduleRaw(now) }
        .onChange(of: focus) { was, _ in if case .entry(let i) = was, editing == i { commit(i) } }
        .onDisappear { if let i = editing { commit(i) }; flushRaw() }
        .animation(.spring(response: 0.32, dampingFraction: 0.85), value: entries)
    }

    // ---------- parts ----------

    private var header: some View {
        HStack(spacing: 8) {
            Circle().fill(Color(css: detail?.color) ?? JB.accent).frame(width: 7, height: 7)
            Text(detail?.name ?? "").font(.system(size: 13, weight: .semibold)).foregroundStyle(JB.ink).lineLimit(1)
            Spacer()
            if savedFlash {
                Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(JB.ok)
                    .transition(.opacity.combined(with: .scale))
            }
            if let back = undo {
                Button { save(back.map(\.text), optimistic: back) } label: { icon("arrow.uturn.backward") }
                    .buttonStyle(Press()).help(L("undo")).transition(.opacity.combined(with: .scale))
            }
            if viewing != nil {
                Button { save(old, optimistic: old.map { MemoryEntry(text: $0) }) } label: { icon("arrow.counterclockwise", tint: JB.warn) }
                    .buttonStyle(Press()).help(L("restore this version"))
            }
            Button { toggleRaw() } label: { icon(raw ? "list.bullet" : "text.alignleft", tint: raw ? JB.accent : JB.muted) }
                .buttonStyle(Press()).help(raw ? L("entries") : "markdown")
            versionMenu
        }
        .animation(.easeOut(duration: 0.2), value: savedFlash)
        .animation(.easeOut(duration: 0.2), value: undo == nil)
    }

    private func icon(_ name: String, tint: Color = JB.muted) -> some View {
        Image(systemName: name).font(.system(size: 11, weight: .medium)).foregroundStyle(tint)
            .frame(width: 24, height: 22).background(RoundedRectangle(cornerRadius: 5).fill(JB.panel2))
    }

    /// the memory's versions: an old one shows read-only; ↺ makes it the newest
    private var versionMenu: some View {
        Menu {
            Button { show(nil) } label: { Label(L("Current"), systemImage: viewing == nil ? "checkmark" : "") }
            Divider()
            ForEach(versions.reversed(), id: \.self) { v in
                Button { show(v) } label: { Label("v\(v)", systemImage: viewing == v ? "checkmark" : "") }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "clock.arrow.circlepath").font(.system(size: 11))
                Text(viewing.map { "v\($0)" } ?? "v\(detail?.version ?? 0)").font(.system(size: 11.5, weight: .medium)).monospacedDigit()
            }
            .foregroundStyle(viewing == nil ? JB.muted : JB.warn)
            .padding(.horizontal, 7).frame(height: 22)
            .background(RoundedRectangle(cornerRadius: 5).fill(JB.panel2))
        }
        .menuStyle(.button).buttonStyle(Press()).menuIndicator(.hidden).fixedSize()
        .disabled(versions.isEmpty)
    }

    @ViewBuilder private func list(_ items: [MemoryEntry], live: Bool) -> some View {
        let rows = VStack(alignment: .leading, spacing: 1) {
            // an author's consecutive entries share one mark, like a thread
            ForEach(Array(items.enumerated()), id: \.offset) { i, e in row(i, e, live: live, first: i == 0 || items[i - 1].by != e.by) }
            if live { addRow }
            if items.isEmpty && !live {
                Image(systemName: "text.book.closed").font(.system(size: 24)).foregroundStyle(JB.muted2)
                    .frame(maxWidth: .infinity).padding(.vertical, 30)
            }
        }
        .padding(6)
        if items.count > 7 && !isSnapshot { ScrollView { rows }.frame(height: 320) }
        else { rows.frame(maxWidth: .infinity, alignment: .leading) }
    }

    private func row(_ i: Int, _ e: MemoryEntry, live: Bool, first: Bool) -> some View {
        Hovering { hover in
            HStack(alignment: .firstTextBaseline, spacing: 9) {
                author(first ? e.by : nil).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 4 }
                if live && editing == i {
                    TextField("", text: $draft, axis: .vertical)
                        .textFieldStyle(.plain).font(.system(size: 12.5)).foregroundStyle(JB.ink)
                        .focused($focus, equals: .entry(i))
                        .onSubmit { commit(i) }
                        .onExitCommand { editing = nil }
                } else {
                    Text(rendered(e.text)).font(.system(size: 12.5)).foregroundStyle(JB.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .contentShape(Rectangle())
                        .onTapGesture { if live { edit(i) } }
                }
                if live && hover && editing != i {
                    if let at = e.at { Text(ago(at)).font(.system(size: 10.5)).foregroundStyle(JB.muted2).monospacedDigit() }
                    Button { remove(i) } label: { Image(systemName: "xmark").font(.system(size: 8.5, weight: .bold)) }
                        .buttonStyle(CloseButtonStyle(size: 16)).help(L("forget"))
                }
            }
            .padding(.horizontal, 7).padding(.top, first ? 6 : 1).padding(.bottom, 6)
            .background(RoundedRectangle(cornerRadius: 5).fill(editing == i ? JB.sel : hover && live ? JB.tint : .clear))
            .pointerStyle(live ? .horizontalText : nil)
        }
    }

    /// always ready: type and ⏎ adds an entry in your name
    private var addRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            Image(systemName: "plus").font(.system(size: 10, weight: .bold)).foregroundStyle(focus == .add ? JB.accent : JB.muted2)
                .frame(width: 16)
            TextField("", text: $adding, axis: .vertical)
                .textFieldStyle(.plain).font(.system(size: 12.5)).foregroundStyle(JB.ink)
                .focused($focus, equals: .add)
                .onSubmit { add() }
        }
        .padding(.horizontal, 7).padding(.vertical, 7)
        .contentShape(Rectangle())
        .onTapGesture { focus = .add }
    }

    /// who wrote it: an agent's logo (by name on hover), or you
    @ViewBuilder private func author(_ by: String?) -> some View {
        if by == nil {
            Color.clear.frame(width: 16, height: 16)
        } else if by == "user" {
            Image(systemName: "person.crop.circle.fill").font(.system(size: 15)).foregroundStyle(JB.muted)
                .frame(width: 16, height: 16).help(L("you"))
        } else if let by, let a = store.agents[by] {
            BackendTile(backend: a.backend ?? "", size: 16).help(a.name)
        } else {
            Image(systemName: "circle.dashed").font(.system(size: 14)).foregroundStyle(JB.muted2).frame(width: 16, height: 16)
        }
    }

    private var rawEditor: some View {
        TextEditor(text: $rawText)
            .font(.system(size: 12.5, design: .monospaced))
            .scrollContentBackground(.hidden)
            .focused($focus, equals: .raw)
            .padding(6)
            .frame(height: 260)
    }

    /// the group's agents; the pencil marks the keeper (tap to give it, tap again to take it back),
    /// the dot whether they have read the latest version
    private var members: some View {
        let ids = detail?.members ?? []
        let version = detail?.version ?? 0
        return HStack(spacing: 6) {
            Image(systemName: "person.2").font(.system(size: 11)).foregroundStyle(JB.muted)
            if ids.isEmpty { Text("—").foregroundStyle(JB.muted2).font(.system(size: 12)) }
            ForEach(ids, id: \.self) { id in
                let keeper = detail?.maintainer == id
                let read = (detail?.seen?[id] ?? nil).map { $0 >= version } ?? false
                Button { setKeeper(keeper ? nil : id) } label: {
                    HStack(spacing: 4) {
                        if let a = store.agents[id] { BackendTile(backend: a.backend ?? "", size: 14) }
                        Text(store.agents[id]?.name ?? id).font(.system(size: 11.5, weight: keeper ? .semibold : .regular))
                        if keeper { Image(systemName: "pencil").font(.system(size: 9, weight: .bold)) }
                        if version > 0 {
                            Circle().fill(read ? JB.ok : .clear).overlay(Circle().strokeBorder(read ? JB.ok : JB.muted2, lineWidth: 1))
                                .frame(width: 6, height: 6)
                        }
                    }
                    .foregroundStyle(keeper ? JB.ink : JB.text)
                    .padding(.horizontal, 7).frame(height: 22)
                    .background(Capsule().fill(keeper ? JB.sel : JB.panel2))
                    .overlay(Capsule().strokeBorder(keeper ? JB.accent : .clear))
                }
                .buttonStyle(Press())
                .padding(.horizontal, 1)
                .help(keeper ? L("this agent may also rewrite the memory") : L("allow rewriting the memory"))
            }
            Spacer(minLength: 0)
        }
    }

    // ---------- reading ----------

    /// headings bold, list markers as bullets, inline markdown (bold, code, links) as itself
    private func rendered(_ text: String) -> AttributedString {
        var out = AttributedString()
        for (n, line) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
            if n > 0 { out += AttributedString("\n") }
            var s = String(line), heading = false
            if let r = s.range(of: #"^#{1,6}\s+"#, options: .regularExpression) { s.removeSubrange(r); heading = true }
            if let r = s.range(of: #"^(\s*)[-*+]\s"#, options: .regularExpression) {
                let indent = s[r].prefix { $0 == " " }
                s.replaceSubrange(r, with: indent + "• ")
            }
            var a = (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
            if heading { a.font = .system(size: 12.5, weight: .semibold); a.foregroundColor = JB.ink }
            out += a
        }
        return out
    }

    private func ago(_ ms: Double) -> String {
        let s = max(0, Date().timeIntervalSince1970 - ms / 1000)
        switch s {
        case ..<60: return L("now")
        case ..<3600: return L("%d min", Int(s / 60))
        case ..<86400: return L("%d hr", Int(s / 3600))
        default: return L("%d d", Int(s / 86400))
        }
    }

    // ---------- editing ----------

    private func edit(_ i: Int) {
        if let j = editing, j != i { commit(j) }
        draft = entries[i].text
        editing = i
        focus = .entry(i)
    }

    private func commit(_ i: Int) {
        guard editing == i else { return }
        editing = nil
        guard entries.indices.contains(i) else { return }
        let t = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if t == entries[i].text { return }
        var next = entries
        if t.isEmpty { next.remove(at: i) } else { next[i] = MemoryEntry(text: t, by: "user", at: Date().timeIntervalSince1970 * 1000) }
        if t.isEmpty { undo = entries }
        save(next.map(\.text), optimistic: next)
    }

    private func add() {
        let t = adding.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        adding = ""
        let next = entries + [MemoryEntry(text: t, by: "user", at: Date().timeIntervalSince1970 * 1000)]
        save(next.map(\.text), optimistic: next)
        focus = .add
    }

    /// gone at once; ↶ in the header brings it back for a few seconds
    private func remove(_ i: Int) {
        undo = entries
        var next = entries
        next.remove(at: i)
        save(next.map(\.text), optimistic: next)
        let mark = next
        Task { try? await Task.sleep(for: .seconds(6)); if entries == mark { undo = nil } }
    }

    private func toggleRaw() {
        if raw { flushRaw(); raw = false; Task { await load() } }
        else { if let i = editing { commit(i) }; rawText = GroupMemory.join(entries.map(\.text)); raw = true; focus = .raw }
    }

    private func scheduleRaw(_ text: String) {
        rawSave?.cancel()
        guard raw, text != GroupMemory.join(entries.map(\.text)) else { return }
        rawSave = Task {
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled else { return }
            save(GroupMemory.split(text), optimistic: nil, reload: false)
        }
    }

    private func flushRaw() {
        rawSave?.cancel()
        if raw, rawText != GroupMemory.join(entries.map(\.text)) { save(GroupMemory.split(rawText), optimistic: nil, reload: false) }
    }

    // ---------- data ----------

    private func load() async {
        guard let d = try? await store.api.get(path, as: Detail.self) else { return }
        detail = d
        entries = d.memory ?? GroupMemory.split(d.context ?? "").map { MemoryEntry(text: $0) }
        versions = (try? await store.api.get(path + "/history", as: Versions.self))?.versions ?? []
    }

    private func show(_ v: Int?) {
        if let i = editing { commit(i) }
        flushRaw(); raw = false
        viewing = v
        Task {
            if let v, let o = try? await store.api.get("\(path)/history/\(v)", as: Old.self) { old = GroupMemory.split(o.content) }
            else if v == nil { await load() }
        }
    }

    /// writes the memory as its entries; the engine keeps each unchanged entry's writer
    private func save(_ texts: [String], optimistic: [MemoryEntry]?, reload: Bool = true) {
        if let optimistic { entries = optimistic }
        if optimistic != nil, undo != nil, optimistic == undo { undo = nil }
        viewing = nil
        let text = GroupMemory.join(texts)
        Task {
            guard (try? await store.api.put(path + "/context", ["content": text])) != nil else { return }
            if reload { await load() } else {
                entries = texts.map { t in entries.first { $0.text == t } ?? MemoryEntry(text: t, by: "user", at: Date().timeIntervalSince1970 * 1000) }
                versions = (try? await store.api.get(path + "/history", as: Versions.self))?.versions ?? versions
            }
            savedFlash = true
            try? await Task.sleep(for: .seconds(1.2))
            savedFlash = false
        }
    }

    private func setKeeper(_ id: String?) {
        detail?.maintainer = id
        store.patchGroup(gid, ["maintainer": id ?? NSNull()])
    }
}
