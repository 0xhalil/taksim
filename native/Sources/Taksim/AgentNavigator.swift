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
                        }
                        .foregroundStyle(JB.muted).padding(.horizontal, 12).padding(.top, agents.isEmpty ? 4 : 14).padding(.bottom, 4)
                        ForEach(past) { c in pastRow(c) }
                    }
                }
                .animation(.spring(response: 0.35, dampingFraction: 0.85), value: past.map(\.id))
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
                        if let f = c.folder { Text(f).lineLimit(1) ; Text("·") }
                        Text(PastConversation.when(c.lastAt)).fixedSize()
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
