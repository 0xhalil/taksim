import AppKit
import SwiftUI
import TaksimKit
import UniformTypeIdentifiers

// The composer: what you type and what goes with it. ⏎ sends, ⇧⏎ breaks the line; @ offers the folder's
// files and the canvas's agents (Tab takes the first); images come by ⌘V, drop or the clip; the model and
// its thinking level sit on top, the one action (■ while it works) at the bottom.

struct ChatComposer: View {
    let model: ChatModel
    let store: CanvasStore
    let running: Bool
    let queued: Int
    @State private var drafts = ChatDrafts.shared
    @State private var suggestions: [ChatAttachment] = []
    @State private var selectedSuggestion = 0
    @State private var suggestionTask: Task<Void, Never>?
    @State private var pasteMonitor: Any?
    @State private var dropTargeted = false
    @State private var editorWidth: CGFloat = 300
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var focused: Bool
    @Environment(\.isSnapshot) private var isSnapshot

    private var agentId: String { model.agent }
    private var text: Binding<String> { Binding(get: { drafts.text[agentId] ?? "" }, set: { v in drafts.text[agentId] = v }) }
    private var chips: [ChatAttachment] { drafts.attachments[agentId] ?? [] }
    private var agent: Agent? { store.agents[agentId] }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !commands.isEmpty { commandList }
            else if !suggestions.isEmpty { suggestionList }
            if model.uploading > 0 {
                Label(L("%d images", model.uploading), systemImage: "arrow.up.doc").font(.system(size: 11)).foregroundStyle(JB.accent)
            }
            if !chips.isEmpty { ChipRow(items: chips, remove: { a in drafts.attachments[agentId]?.removeAll { $0 == a } }, open: { a in if let path = a.path { store.openIDE(agentId, path: path) } }) }
            editor
            // as in Cursor: how it works and with which model on the left, the clip and the one action on the right
            HStack(spacing: 6) {
                modeMenu
                permissionMenu
                modelMenu
                Spacer(minLength: 4)
                if model.sending > 0 { Image(systemName: "ellipsis").foregroundStyle(JB.accent).help(L("Sending")) }
                if queued > model.queue.count { Text(L("%d pending", queued - model.queue.count)).font(.system(size: 11)).foregroundStyle(JB.muted).lineLimit(1) }
                if let c = agent?.context, c.window > 0 { ContextGauge(context: c) }
                attachMenu
                sendButton
            }
        }
        .padding(11)
        .background(RoundedRectangle(cornerRadius: 10).fill(JB.panel))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(dropTargeted || focused ? JB.accent.opacity(dropTargeted ? 0.8 : 0.65) : JB.line.opacity(0.8), lineWidth: dropTargeted ? 2 : 1))
        .overlay { if dropTargeted { Label(L("Add"), systemImage: "plus.circle.fill").font(.system(size: 13, weight: .medium)).foregroundStyle(JB.accent).padding(9).background(Capsule().fill(JB.panel)) } }
        .animation(reduceMotion || isSnapshot ? nil : .spring(response: 0.35, dampingFraction: 0.86), value: chips.map(\.id))
        .animation(reduceMotion || isSnapshot ? nil : .easeOut(duration: 0.18), value: focused || dropTargeted)
        .padding(.horizontal, 8).padding(.top, 5).padding(.bottom, 8)
        .modifier(DropFiles(enabled: !isSnapshot, targeted: $dropTargeted, drop: drop))
        .onAppear { installPaste() }
        .onDisappear { suggestionTask?.cancel(); if let m = pasteMonitor { NSEvent.removeMonitor(m); pasteMonitor = nil } }
        .onChange(of: drafts.text[agentId]) { _, value in updateSuggestions(value ?? "") }
        .onChange(of: drafts.focus) { _, id in if id == agentId { focused = true; drafts.focus = nil } }
    }

    // ---------- the text ----------

    @ViewBuilder private var editor: some View {
        let content = NSAttributedString(string: text.wrappedValue.isEmpty ? " " : text.wrappedValue + " ", attributes: [.font: NSFont.systemFont(ofSize: 12.5)])
        let height = content.boundingRect(with: CGSize(width: max(60, editorWidth - 12), height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading]).height
        ZStack(alignment: .topLeading) {
            if text.wrappedValue.isEmpty {
                Text(running ? L("Add to queue") : agent?.chatMode == "ask" ? L("Ask about the code") : agent?.chatMode == "plan" ? L("What should we plan?") : editorWidth < 340 ? L("Ask for something…") : L("Ask for something…  / for commands · @ for context")).font(.system(size: 12.5)).foregroundStyle(JB.muted2).lineLimit(1).padding(.leading, 5).padding(.top, 1)
                    .allowsHitTesting(false)
            }
            if isSnapshot {
                Text(text.wrappedValue).font(.system(size: 12.5)).foregroundStyle(JB.ink)
            } else {
                TextEditor(text: text)
                    .font(.system(size: 12.5)).foregroundStyle(JB.ink)
                    .scrollContentBackground(.hidden).background(.clear).scrollIndicators(.never)
                    .focused($focused)
                    .onKeyPress(.return, phases: .down) { press in
                        if press.modifiers.contains(.shift) { return .ignored }
                        if pickCommand() { return .handled }
                        if pickSuggestion() { return .handled }
                        send(); return .handled
                    }
                    .onKeyPress(.tab, phases: .down) { press in
                        if press.modifiers.contains(.shift) {
                            guard !running, queued == 0, !model.settingMode, model.sending == 0 else { return .handled }
                            let modes = ["agent", "ask", "plan"]
                            let mode = agent?.chatMode ?? (agent?.sandbox == "read-only" ? "ask" : "agent")
                            let next = modes[((modes.firstIndex(of: mode) ?? 0) + 1) % modes.count]
                            Task { await model.setMode(next, store: store) }; return .handled
                        }
                        return (pickCommand() || pickSuggestion()) ? .handled : .ignored
                    }
                    .onKeyPress(.downArrow) { moveSuggestion(1) ? .handled : .ignored }
                    .onKeyPress(.upArrow) { moveSuggestion(-1) ? .handled : .ignored }
                    .onKeyPress(.escape, phases: .down) { _ in
                        if !commands.isEmpty { drafts.text[agentId] = ""; return .handled }
                        guard !suggestions.isEmpty else { return .ignored }
                        suggestionTask?.cancel(); suggestions = []; return .handled
                    }
            }
        }
        .frame(height: min(144, max(42, ceil(height) + 8)))
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { editorWidth = $0 }
    }

    private var sendButton: some View {
        let empty = text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && chips.isEmpty
        return Button { if running && empty { model.stop() } else { send() } } label: {
            Image(systemName: model.stopping ? "ellipsis" : running && empty ? "stop.fill" : running ? "text.line.first.and.arrowtriangle.forward" : "arrow.up")
                .contentTransition(.symbolEffect(.replace))
                .font(.system(size: 11, weight: .bold)).foregroundStyle(JB.accentInk)
                .frame(width: 28, height: 28)
                .background(RoundedRectangle(cornerRadius: 7).fill(running && empty ? JB.err : JB.accent))
                .opacity(!running && empty ? 0.4 : 1)
        }
        .buttonStyle(Tap(well: false, dim: false)).disabled((!running && empty) || model.stopping || model.uploading > 0)
        .help(running && empty ? L("Stop") : running ? L("Add to queue (⏎)") : L("Send (⏎)"))
        .accessibilityLabel(running && empty ? L("Stop") : running ? L("Add to queue") : L("Send"))
        .animation(reduceMotion || isSnapshot ? nil : .spring(response: 0.3, dampingFraction: 0.8), value: running && empty)
    }

    private func send() {
        guard model.uploading == 0 else { return }
        if pickCommand() { return }
        let t = text.wrappedValue
        guard !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !chips.isEmpty else { return }
        model.send(t, attachments: chips)
        drafts.text[agentId] = ""
        drafts.attachments[agentId] = []
        suggestions = []
    }

    private struct Command: Identifiable {
        let id: String
        let title: String
        let detail: String
        let symbol: String
    }

    /// file drops land here in real use; offscreen renders take no drops, where the
    /// drop target would otherwise paint its hover highlight for nothing
    private struct DropFiles: ViewModifier {
        let enabled: Bool
        @Binding var targeted: Bool
        let drop: ([NSItemProvider]) -> Void
        func body(content: Content) -> some View {
            if enabled {
                content.onDrop(of: [.fileURL, .image], isTargeted: $targeted) { providers in drop(providers); return true }
            } else { content }
        }
    }
    private var commands: [Command] {
        let t = text.wrappedValue
        guard t.hasPrefix("/"), !t.contains(where: \.isWhitespace) else { return [] }
        return [Command(id: "/side", title: L("Side chat"), detail: L("Branch aside, history stays"), symbol: "arrow.triangle.branch"),
                Command(id: "/new", title: L("New chat"), detail: L("Same model, fresh session"), symbol: "plus.bubble"),
                Command(id: "/files", title: L("Add files"), detail: L("Pick files and folders"), symbol: "paperclip"),
                Command(id: "/export", title: L("Export"), detail: L("Save as Markdown"), symbol: "square.and.arrow.up"),
                Command(id: "/agents", title: L("Create agents"), detail: agent?.delegate == true ? L("On · click to turn off") : L("Split work across agents"), symbol: "person.2.badge.plus"),
                Command(id: "/agent", title: L("Agent"), detail: L("Apply and verify"), symbol: "bolt"),
                Command(id: "/ask", title: L("Ask"), detail: L("Research the code"), symbol: "bubble.left"),
                Command(id: "/plan", title: L("Plan"), detail: L("Review the plan first"), symbol: "list.bullet.clipboard")]
            .filter { $0.id.hasPrefix(t.lowercased()) }
    }
    private var commandList: some View {
        VStack(spacing: 0) {
            ForEach(Array(commands.enumerated()), id: \.element.id) { i, command in
                Button { execute(command) } label: {
                    HStack(spacing: 8) {
                        Image(systemName: command.symbol).frame(width: 14).foregroundStyle(JB.accent)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(command.title).foregroundStyle(JB.ink)
                            Text(command.detail).font(.system(size: 11)).foregroundStyle(JB.muted)
                        }
                        Spacer()
                        Text(command.id).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(JB.muted)
                    }.font(.system(size: 12)).padding(.horizontal, 8).padding(.vertical, 5)
                        .background(i == selectedSuggestion ? JB.sel : .clear).contentShape(Rectangle())
                }.buttonStyle(Tap())
            }
        }.background(RoundedRectangle(cornerRadius: 6).fill(JB.panel2))
    }
    private func pickCommand() -> Bool {
        guard commands.indices.contains(selectedSuggestion) else { return false }
        execute(commands[selectedSuggestion]); return true
    }
    private func execute(_ command: Command) {
        switch command.id {
        case "/side", "/new":
            let original = text.wrappedValue
            Task {
                if await model.branch(store: store, fresh: command.id == "/new"), drafts.text[agentId] == original {
                    drafts.text[agentId] = ""
                }
            }
        case "/agent", "/ask", "/plan":
            guard !running, queued == 0, !model.settingMode, model.sending == 0 else { return }
            let original = text.wrappedValue
            let mode = String(command.id.dropFirst())
            Task {
                await model.setMode(mode, store: store)
                if agent?.chatMode == mode, drafts.text[agentId] == original { drafts.text[agentId] = "" }
            }
        case "/agents": drafts.text[agentId] = ""; store.setHelpers(agentId, !(agent?.delegate == true))
        case "/files": drafts.text[agentId] = ""; openPanel()
        case "/export": drafts.text[agentId] = ""; model.export(title: agent?.name ?? L("Chat"))
        default: break
        }
    }

    // ---------- @ ----------

    /// the word being typed after @, if any
    private func mentionQuery(_ t: String) -> String? {
        guard let at = t.lastIndex(of: "@") else { return nil }
        if at != t.startIndex, !t[t.index(before: at)].isWhitespace { return nil }
        let q = t[t.index(after: at)...]
        return q.contains(where: \.isWhitespace) ? nil : String(q)
    }

    private func suggest(_ t: String) async {
        guard let q = mentionQuery(t) else { if !suggestions.isEmpty { suggestions = [] }; return }
        let agents = store.currentAgents.filter { $0.id != agentId && (q.isEmpty || $0.name.localizedCaseInsensitiveContains(q)) }
            .prefix(3).map { ChatAttachment(kind: "agent", name: $0.name) }
        let conversations = store.currentAgents.filter { $0.id != agentId && !($0.lastText ?? "").isEmpty && (q.isEmpty || $0.name.localizedCaseInsensitiveContains(q)) }
            .prefix(2).map { ChatAttachment(kind: "conversation", path: $0.id, name: $0.name) }
        let paths = await model.fileList()
        let folders = Set(paths.flatMap { path -> [String] in
            let parts = path.split(separator: "/")
            return parts.count > 1 ? (1..<parts.count).map { parts.prefix($0).joined(separator: "/") } : []
        })
        let directoryMatches = FuzzyPath.rank(q, Array(folders).sorted(), limit: 3).map { ChatAttachment(kind: "folder", path: $0) }
        let files = FuzzyPath.rank(q, paths, limit: 7).map { ChatAttachment(kind: "file", path: $0) }
        guard !Task.isCancelled, drafts.text[agentId] == t else { return }
        selectedSuggestion = 0
        suggestions = Array((Array(agents) + Array(conversations) + directoryMatches + files).prefix(10))
    }

    private func updateSuggestions(_ text: String) {
        suggestionTask?.cancel()
        suggestions = []; selectedSuggestion = 0
        suggestionTask = Task { await suggest(text) }
    }

    private func moveSuggestion(_ direction: Int) -> Bool {
        let count = commands.isEmpty ? suggestions.count : commands.count
        guard count > 0 else { return false }
        selectedSuggestion = (selectedSuggestion + direction + count) % count
        return true
    }

    private func pickSuggestion() -> Bool {
        guard suggestions.indices.contains(selectedSuggestion) else { return false }
        pick(suggestions[selectedSuggestion]); return true
    }

    private func pick(_ a: ChatAttachment) {
        // the @word goes, the chip comes
        if var t = drafts.text[agentId], let at = t.lastIndex(of: "@") { t.removeSubrange(at...); drafts.text[agentId] = t }
        drafts.add(a, to: agentId)
        drafts.focus = nil
        focused = true
        suggestions = []
    }

    private var suggestionList: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(suggestions.enumerated()), id: \.offset) { i, a in
                Button { pick(a) } label: {
                    HStack(spacing: 7) {
                        Image(systemName: a.symbol).font(.system(size: 11)).foregroundStyle(JB.accent).frame(width: 14)
                        Text((a.kind == "agent" || a.kind == "conversation") ? (a.name ?? "") : (a.path.map { ($0 as NSString).lastPathComponent } ?? "")).font(.system(size: 12)).foregroundStyle(JB.ink)
                        if a.kind == "file" || a.kind == "folder", let p = a.path {
                            Text((p as NSString).deletingLastPathComponent).font(.system(size: 11)).foregroundStyle(JB.muted2).lineLimit(1).truncationMode(.head)
                        }
                        Spacer()
                        if i == selectedSuggestion { Text("⇥").font(.system(size: 11)).foregroundStyle(JB.muted2) }
                    }
                    .padding(.horizontal, 8).frame(height: 24).contentShape(Rectangle())
                    .background(i == selectedSuggestion ? JB.sel : .clear)
                }
                .buttonStyle(Tap())
            }
        }
        .background(RoundedRectangle(cornerRadius: 6).fill(JB.panel2))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(JB.line))
    }

    // ---------- attachments ----------

    private var attachMenu: some View {
        Button { openPanel() } label: { Image(systemName: "paperclip").font(.system(size: 12)).foregroundStyle(JB.muted).frame(width: 20, height: 20) }
            .buttonStyle(Tap()).help(L("Add a file, folder, or image"))
    }

    private func openPanel() {
        let p = NSOpenPanel()
        p.canChooseFiles = true; p.canChooseDirectories = true; p.allowsMultipleSelection = true
        if let cwd = agent?.cwd { p.directoryURL = URL(fileURLWithPath: cwd) }
        guard p.runModal() == .OK else { return }
        for u in p.urls { attach(url: u) }
    }

    private func attach(url u: URL) {
        let type = UTType(filenameExtension: u.pathExtension)
        if let type, type.conforms(to: .image), let data = try? Data(contentsOf: u) {
            Task { if let a = await model.upload(data, type: type.preferredMIMEType ?? "image/png") { drafts.add(a, to: agentId) } }
            return
        }
        var dir: ObjCBool = false
        FileManager.default.fileExists(atPath: u.path, isDirectory: &dir)
        drafts.add(ChatAttachment(kind: dir.boolValue ? "folder" : "file", path: u.path), to: agentId)
    }

    private func drop(_ providers: [NSItemProvider]) {
        for p in providers {
            if p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                _ = p.loadObject(ofClass: URL.self) { u, _ in if let u { DispatchQueue.main.async { attach(url: u) } } }
            } else if p.canLoadObject(ofClass: NSImage.self) {
                _ = p.loadObject(ofClass: NSImage.self) { img, _ in
                    guard let img = img as? NSImage, let png = Self.png(img) else { return }
                    DispatchQueue.main.async { Task { if let a = await model.upload(png, type: "image/png") { drafts.add(a, to: agentId) } } }
                }
            }
        }
    }

    /// ⌘V with an image on the clipboard (and no text) attaches the image; anything else pastes as usual
    private func installPaste() {
        guard pasteMonitor == nil, !isSnapshot else { return }
        pasteMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
            guard focused, e.modifierFlags.contains(.command), e.charactersIgnoringModifiers == "v" else { return e }
            let pb = NSPasteboard.general
            guard pb.string(forType: .string) == nil, let img = NSImage(pasteboard: pb), let png = Self.png(img) else { return e }
            Task { if let a = await model.upload(png, type: "image/png") { drafts.add(a, to: agentId) } }
            return nil
        }
    }

    static func png(_ img: NSImage) -> Data? {
        guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }

    // ---------- model and thinking ----------

    @ViewBuilder private var modeMenu: some View {
        let mode = agent?.chatMode ?? (agent?.sandbox == "read-only" ? "ask" : "agent")
        let title = mode == "plan" ? "Plan" : mode == "ask" ? L("Ask") : L("Agent")
        let symbol = mode == "plan" ? "list.bullet.clipboard" : mode == "ask" ? "bubble.left" : "bolt"
        if isSnapshot { chip(title, symbol: symbol) }
        else {
            Menu {
                ForEach(["agent", "ask", "plan"], id: \.self) { next in
                    Button { Task { await model.setMode(next, store: store) } } label: {
                        Label(next == "plan" ? "Plan" : next == "ask" ? L("Ask") : L("Agent"), systemImage: next == mode ? "checkmark" : next == "plan" ? "list.bullet.clipboard" : next == "ask" ? "bubble.left" : "bolt")
                    }
                }
            } label: { Label(title, systemImage: symbol) }
            .menuStyle(.borderlessButton).menuIndicator(.visible).fixedSize().font(.system(size: 11.5))
            .disabled(running || queued > 0 || model.settingMode || model.sending > 0)
            .help(mode == "plan" ? L("Plan · doesn't change files · ⇧⇥") : mode == "ask" ? L("Ask · read-only · ⇧⇥") : L("Agent · applies changes · ⇧⇥"))
            .chipHover()
        }
    }

    /// how this node's turns ask for permission, where its CLI has the choice: the one a person picks to stop
    /// being asked about everything (auto), or to be asked about everything (manual)
    @ViewBuilder private var permissionMenu: some View {
        let mode = agent?.chatMode ?? (agent?.sandbox == "read-only" ? "ask" : "agent")
        let modes = agent?.permissions ?? []
        if mode == "agent", !modes.isEmpty {
            let current = agent?.permission ?? "auto"
            let narrow = editorWidth < 340
            if isSnapshot { chip(narrow ? "" : Self.permissionTitle(current), symbol: Self.permissionSymbol(current)) }
            else {
                Menu {
                    ForEach(modes, id: \.self) { next in
                        Button { Task { await model.setPermission(next, store: store) } } label: {
                            Label("\(Self.permissionTitle(next)) · \(Self.permissionHint(next))", systemImage: next == current ? "checkmark" : Self.permissionSymbol(next))
                        }
                    }
                } label: {
                    if narrow { Image(systemName: Self.permissionSymbol(current)) } else { Label(Self.permissionTitle(current), systemImage: Self.permissionSymbol(current)) }
                }
                .menuStyle(.borderlessButton).menuIndicator(.visible).fixedSize().font(.system(size: 11.5))
                .foregroundStyle(current == "bypassPermissions" ? JB.err : JB.ink)
                .disabled(running || queued > 0 || model.settingMode || model.sending > 0)
                .help(L("Permissions: %@", Self.permissionHint(current)))
                .chipHover()
            }
        }
    }

    static func permissionTitle(_ mode: String) -> String {
        switch mode { case "default": L("Manual"); case "acceptEdits": L("Accept edits"); case "bypassPermissions": L("Bypass"); default: L("Auto") }
    }
    static func permissionHint(_ mode: String) -> String {
        switch mode { case "default": L("Asks before every change"); case "acceptEdits": L("Edits files, asks about the rest"); case "bypassPermissions": L("Does everything without asking"); default: L("Claude decides what is safe") }
    }
    static func permissionSymbol(_ mode: String) -> String {
        switch mode { case "default": "hand.raised"; case "acceptEdits": "pencil"; case "bypassPermissions": "exclamationmark.shield"; default: "wand.and.stars" }
    }

    private var modelLabel: String {
        let name = store.models.first { $0.id == agent?.model }?.display_name ?? agent?.model ?? ""
        let limit = editorWidth < 320 ? 9 : editorWidth < 460 ? 14 : 24
        return name.count > limit ? String(name.prefix(limit - 1)) + "…" : name
    }

    @ViewBuilder private var modelMenu: some View {
        let backend = agent?.backend ?? ""
        let models = store.models.filter { $0.owned_by == backend }.map(\.id)
        if isSnapshot {
            chip(modelLabel, symbol: nil)
        } else {
            Menu {
                ForEach(models, id: \.self) { m in modelChoice(m) }
                let others = store.backends.filter { $0 != backend && ($0 != "fake" || backend == "fake") }
                if !others.isEmpty { Divider() }
                ForEach(others, id: \.self) { provider in
                    Menu(provider) {
                        ForEach(store.models.filter { $0.owned_by == provider }.map(\.id), id: \.self) { m in modelChoice(m) }
                    }
                }
            } label: { Text(modelLabel + (agent?.effort.map { " · " + AgentSheet.effortName($0) } ?? "")) } // the menu draws its own chevron, after the name
            .menuStyle(.borderlessButton).menuIndicator(.visible).fixedSize().font(.system(size: 11.5)).foregroundStyle(JB.muted)
            .help(L("Model: %@", agent?.model ?? "")).disabled(running || queued > 0 || model.sending > 0 || model.settingMode)
            .chipHover()
        }
    }

    /// a model; one with thinking levels opens them beside it (Sonnet ▸ Default, Low … Max), and a level picks both
    @ViewBuilder private func modelChoice(_ name: String) -> some View {
        let info = store.models.first { $0.id == name }
        let shown = info?.display_name ?? name
        let current = name == agent?.model
        if let levels = info?.efforts, !levels.isEmpty {
            Menu {
                effortChoice(name, nil, label: L("Default"))
                Divider()
                ForEach(levels, id: \.self) { l in effortChoice(name, l, label: AgentSheet.effortName(l)) }
            } label: {
                let title = shown + (current ? agent?.effort.map { " · " + AgentSheet.effortName($0) } ?? "" : "")
                if current { Label(title, systemImage: "checkmark") } else { Text(title) }
            }
        } else {
            Button { pick(name, effort: nil) } label: {
                if current { Label(shown, systemImage: "checkmark") } else { Text(shown) }
            }
        }
    }

    private func effortChoice(_ name: String, _ level: String?, label: String) -> some View {
        Button { pick(name, effort: level) } label: {
            if name == agent?.model, agent?.effort == level { Label(label, systemImage: "checkmark") } else { Text(label) }
        }
    }

    /// the same model: only its thinking changes; another one: model and level go together (no level: its default)
    private func pick(_ name: String, effort: String?) {
        if name == agent?.model { return store.setEffort(agentId, effort) }
        let levels = store.models.first { $0.id == name }?.efforts ?? []
        var change: [String: Any] = ["model": name]
        if !levels.isEmpty { change["effort"] = effort ?? "" }
        Task { do { try await store.updateAgent(agentId, change) } catch { model.error = error.localizedDescription } }
    }

    private func chip(_ text: String, symbol: String?) -> some View {
        HStack(spacing: 4) {
            if let symbol { Image(systemName: symbol).font(.system(size: 10)) }
            Text(text).font(.system(size: 11.5)).lineLimit(1).truncationMode(.middle)
            Image(systemName: "chevron.down").font(.system(size: 7.5, weight: .semibold))
        }
        .foregroundStyle(JB.muted)
        .padding(.horizontal, 7).frame(height: 22)
        .background(RoundedRectangle(cornerRadius: 5).fill(JB.panel2.opacity(0.6)))
    }
}

/// How full the agent's context is, as its CLI measured it: a small ring and the percentage; amber from 80%,
/// red from 95%. The exact counts are in the tooltip.
struct ContextGauge: View {
    let context: AgentContext
    var body: some View {
        let f = context.fraction
        let color = f >= 0.95 ? JB.err : f >= 0.8 ? JB.warn : JB.accent
        HStack(spacing: 4) {
            ZStack {
                Circle().stroke(JB.line, lineWidth: 2)
                Circle().trim(from: 0, to: max(0.02, f)).stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round)).rotationEffect(.degrees(-90))
            }
            .frame(width: 12, height: 12)
            Text("\(Int((f * 100).rounded()))%").font(.system(size: 11)).monospacedDigit().foregroundStyle(f >= 0.8 ? color : JB.muted)
        }
        .animation(.easeOut(duration: 0.4), value: f)
        .help(L("Context: %@ of %@ tokens", AgentContext.tokens(context.used), AgentContext.tokens(context.window)))
        .accessibilityLabel(L("Context %d%%", Int((f * 100).rounded())))
    }
}
