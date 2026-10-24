import SwiftUI
import TaksimKit

/// The sidebar: this canvas's agents (reveal one, open its terminal), then the past conversations, newest first,
/// as the Claude app lists them; a click continues one here. One search finds both, the past ones by their words too.
struct AgentNavigator: View {
    @Bindable var model: AppModel
    let store: CanvasStore
    @State private var query = ""
    @State private var selected: String?
    @State private var past: [PastConversation]
    @State private var continuing: String?
    @Environment(\.isSnapshot) private var isSnapshot
    @AppStorage("historyGrouping") private var grouping = HistoryGrouping.date
    @AppStorage("historySorting") private var sorting = HistorySorting.lastActive
    /// the sections folded shut (their ids, one per line), kept across launches
    @AppStorage("historyCollapsed") private var collapsedRaw = ""
    private var collapsed: Set<String> { Set(collapsedRaw.split(separator: "\n").map(String.init)) }
    private var sections: [HistorySection] { PastConversation.sections(past, by: grouping, sort: sorting) }

    /// `past`: the history as it is shown first (a snapshot draws it without asking the engine)
    init(model: AppModel, store: CanvasStore, past: [PastConversation] = []) {
        self.model = model
        self.store = store
        _past = State(initialValue: past)
    }

    /// the list scrolls; a snapshot can't draw a scroll view, so there it simply stands
    @ViewBuilder private func scroller<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        if isSnapshot { content().frame(maxHeight: .infinity, alignment: .top) } else { ScrollView { content() } }
    }

    private var agents: [Agent] {
        store.currentAgents.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || ($0.backend ?? "").localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(L("Agents")).font(.system(size: 11, weight: .semibold))
                Text("\(store.currentAgents.count)").font(.system(size: 10, design: .monospaced)).foregroundStyle(JB.muted)
                Spacer()
                Button { model.showNavigator = false } label: { AppIcon.minimize.frame(width: 16, height: 16) }
                    .buttonStyle(IconButton()).help(L("Hide sidebar")).accessibilityLabel(L("Hide sidebar"))
            }.padding(.horizontal, 12).frame(height: 34)
            HStack(spacing: 6) {
                AppIcon.search.frame(width: 14, height: 14).foregroundStyle(JB.muted)
                TextField(L("Search"), text: $query).textFieldStyle(.plain).font(.system(size: 12))
                    .onSubmit { if let a = agents.first { reveal(a.id) } }
                    .onExitCommand { query = "" }
            }.padding(8).background(JB.bg).overlay(Rectangle().strokeBorder(JB.line)).padding(.horizontal, 10).padding(.bottom, 10)
            scroller {
                LazyVStack(spacing: 1) {
                    ForEach(agents) { a in
                        HStack(spacing: 0) {
                            Button { reveal(a.id) } label: {
                                HStack(spacing: 8) {
                                    Rectangle().fill(JB.status(a.status) ?? JB.muted).frame(width: 3, height: 14)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(a.name).font(.system(size: 12, weight: .medium)).foregroundStyle(JB.ink).lineLimit(1)
                                        Text(a.backend ?? "terminal").font(.system(size: 10)).foregroundStyle(JB.muted)
                                    }
                                    Spacer(minLength: 0)
                                }.padding(.leading, 12).frame(height: 42).contentShape(Rectangle())
                            }.buttonStyle(Press()).help(L("Show on canvas"))
                            Button { reveal(a.id); model.openTerminal(a.id, false) } label: {
                                (a.isTerminalOpen ? AppIcon.minimize : AppIcon.terminal).frame(width: 16, height: 16)
                            }.buttonStyle(IconButton()).padding(.trailing, 5)
                                .help(a.isTerminalOpen ? L("Hide terminal") : L("Open terminal"))
                                .accessibilityLabel(a.isTerminalOpen ? L("%@: hide terminal", a.name) : L("%@: open terminal", a.name))
                        }
                        .background(selected == a.id ? JB.tint : .clear)
                        .overlay(alignment: .leading) { if selected == a.id { Rectangle().fill(JB.accent).frame(width: 2) } }
                    }
                    if agents.isEmpty, !query.isEmpty, past.isEmpty {
                        Text(L("No results")).font(.system(size: 12)).foregroundStyle(JB.muted).padding(16)
                    }
                    if !past.isEmpty {
                        HStack(spacing: 6) {
                            Image(systemName: "clock.arrow.circlepath").font(.system(size: 10.5))
                            Text(L("History")).font(.system(size: 11, weight: .semibold))
                            Spacer()
                            arrangeMenu
                        }
                        .foregroundStyle(JB.muted).padding(.leading, 12).padding(.trailing, 6).padding(.top, agents.isEmpty ? 4 : 14).padding(.bottom, 2)
                        ForEach(sections) { section in
                            sectionHeader(section)
                            if !collapsed.contains(section.id) {
                                ForEach(section.items) { c in pastRow(c) }
                            }
                        }
                    }
                }
                .animation(.spring(response: 0.35, dampingFraction: 0.85), value: past.map(\.id))
                .animation(.spring(response: 0.35, dampingFraction: 0.85), value: grouping)
                .animation(.spring(response: 0.35, dampingFraction: 0.85), value: sorting)
                .animation(.spring(response: 0.3, dampingFraction: 0.9), value: collapsedRaw)
            }
        }
        .frame(width: 260).frame(maxHeight: .infinity).background(JB.panel)
        .onChange(of: store.currentId) { selected = nil; query = "" }
        // read again as conversations come and go: an agent removed here joins the list, a search narrows it
        .task(id: "\(query)|\(store.order.joined(separator: ","))|\(store.canvases.count)|\(store.currentId ?? "")") {
            if !query.isEmpty { try? await Task.sleep(for: .milliseconds(250)) }
            guard !Task.isCancelled, let list = try? await store.history(matching: query) else { return }
            past = list
        }
    }

    /// how the history is laid out, under the lid: by date or by project, newest activity or newest start first
    private var arrangeMenu: some View {
        Menu {
            Picker(L("Group"), selection: $grouping) {
                Label(L("By date"), systemImage: "calendar").tag(HistoryGrouping.date)
                Label(L("By project"), systemImage: "folder").tag(HistoryGrouping.project)
            }
            .pickerStyle(.inline)
            Picker(L("Sort"), selection: $sorting) {
                Label(L("Last active"), systemImage: "clock").tag(HistorySorting.lastActive)
                Label(L("Started"), systemImage: "sparkles").tag(HistorySorting.created)
            }
            .pickerStyle(.inline)
        } label: {
            Image(systemName: grouping == .project ? "folder" : "line.3.horizontal.decrease").font(.system(size: 11))
                .frame(width: 22, height: 20).contentShape(Rectangle())
        }
        .menuStyle(.button).buttonStyle(Press()).menuIndicator(.hidden).fixedSize()
        .pointerStyle(.link).help(L("Group and sort"))
    }

    /// a section's name and count; a click folds it shut or open again
    private func sectionHeader(_ section: HistorySection) -> some View {
        let shut = collapsed.contains(section.id)
        return Button {
            var set = collapsed
            if shut { set.remove(section.id) } else { set.insert(section.id) }
            collapsedRaw = set.sorted().joined(separator: "\n")
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "chevron.right").font(.system(size: 8, weight: .bold))
                    .rotationEffect(.degrees(shut ? 0 : 90))
                if grouping == .project { Image(systemName: "folder").font(.system(size: 10)) }
                Text(section.title).font(.system(size: 10.5, weight: .semibold)).lineLimit(1)
                if shut { Text("\(section.items.count)").font(.system(size: 10, design: .monospaced)).foregroundStyle(JB.muted2) }
                Spacer(minLength: 0)
            }
            .foregroundStyle(JB.muted).padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 3).contentShape(Rectangle())
        }
        .buttonStyle(Press())
        .pointerStyle(.link)
        .help(section.items.first?.cwd ?? section.title)
    }

    /// a past conversation: its CLI, its first request, where and when; a click continues it on this canvas
    private func pastRow(_ c: PastConversation) -> some View {
        Button { Task { await continueHere(c) } } label: {
            HStack(alignment: .top, spacing: 9) {
                ZStack {
                    BackendTile(backend: c.backend ?? "claude", size: 18)
                    if continuing == c.id { ProgressView().controlSize(.mini) }
                }
                .padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    Text(c.title).font(.system(size: 12)).foregroundStyle(JB.ink).lineLimit(1)
                    HStack(spacing: 4) {
                        // by project the section already names the folder
                        if grouping == .date, let f = c.folder { Text(f).lineLimit(1) ; Text("·") }
                        Text(PastConversation.when(c.time(sorting))).fixedSize()
                    }
                    .font(.system(size: 10.5)).foregroundStyle(JB.muted2)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 6).contentShape(Rectangle())
        }
        .buttonStyle(Press())
        .pointerStyle(.link)
        .help(c.lastText.map { "\(c.name) — \($0)" } ?? c.name)
        .disabled(continuing != nil)
        // dragged onto the canvas, it opens where it is dropped
        .draggable(c.dragPayload) {
            HStack(spacing: 7) {
                BackendTile(backend: c.backend ?? "claude", size: 16)
                Text(c.title).font(.system(size: 12)).foregroundStyle(JB.ink).lineLimit(1)
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 7).fill(JB.panel2))
            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(JB.line))
        }
        .contextMenu {
            Button(L("Delete"), systemImage: "trash") {
                withAnimation { past.removeAll { $0.id == c.id } }
                Task { try? await store.forgetConversation(c.id) }
            }
        }
        .transition(.opacity.combined(with: .move(edge: .top)))
    }

    /// the conversation comes back as an agent in the middle of the view, its chat ready to type
    private func continueHere(_ c: PastConversation) async {
        continuing = c.id
        defer { continuing = nil }
        if await model.continueConversation(c.id) { withAnimation { past.removeAll { $0.id == c.id } } }
    }

    private func reveal(_ id: String) { selected = id; model.focusAgent(id) }
}
