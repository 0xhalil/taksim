import SwiftUI
import TaksimKit

/// A compact tool window: locate an agent, reveal it on the canvas, or open its terminal.
struct AgentNavigator: View {
    @Bindable var model: AppModel
    let store: CanvasStore
    @State private var query = ""
    @State private var selected: String?

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
                    .buttonStyle(IconButton()).help(L("Hide navigator")).accessibilityLabel(L("Hide navigator"))
            }.padding(.horizontal, 12).frame(height: 34)
            HStack(spacing: 6) {
                AppIcon.search.frame(width: 14, height: 14).foregroundStyle(JB.muted)
                TextField(L("Find agent"), text: $query).textFieldStyle(.plain).font(.system(size: 12))
                    .onSubmit { if let a = agents.first { reveal(a.id) } }
                    .onExitCommand { query = "" }
            }.padding(8).background(JB.bg).overlay(Rectangle().strokeBorder(JB.line)).padding(.horizontal, 10).padding(.bottom, 10)
            ScrollView {
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
                    if agents.isEmpty {
                        Text(query.isEmpty ? L("No agents yet") : L("No results")).font(.system(size: 12)).foregroundStyle(JB.muted).padding(16)
                    }
                }
            }
        }
        .frame(width: 220).frame(maxHeight: .infinity).background(JB.panel)
        .onChange(of: store.currentId) { selected = nil; query = "" }
    }

    private func reveal(_ id: String) { selected = id; model.focusAgent(id) }
}
