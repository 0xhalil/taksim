import SwiftUI
import TaksimKit

// Cursor's ⌘K palette in our style: one search over the canvas's agents, the past
// conversations (by their words too), its actions and the settings sections. ↑↓ moves, ⏎ opens (⌥⏎ an agent's terminal),
// ⌘[ and ⌘] switch tabs, esc closes.
struct CommandPalette: View {
    enum Tab: String, CaseIterable {
        case all, agents, history, actions, settings
        var title: String {
            switch self {
            case .all: L("All")
            case .agents: L("Agents")
            case .history: L("History")
            case .actions: L("Actions")
            case .settings: L("Settings")
            }
        }
    }

    struct Row: Identifiable {
        let id: String
        let tab: Tab
        let section: String
        let symbol: String?
        let dot: Color?
        let title: String
        let hint: String?
        let run: () -> Void
    }

    let store: CanvasStore
    let goToAgent: (String) -> Void
    let openTerminal: (String) -> Void
    let newAgent: () -> Void
    /// a past conversation continued on the open canvas
    let continueConversation: (String) -> Void
    let newCanvas: () -> Void
    let toggleNavigator: () -> Void
    let openSettings: (SettingsSection) -> Void
    let close: () -> Void

    @State private var query = ""
    @State private var tab = Tab.all
    @State private var selected = 0
    /// the past conversations the engine found for the query (it searches their words, not only titles)
    @State private var past: [PastConversation] = []
    @FocusState private var focused: Bool
    @Environment(\.isSnapshot) private var isSnapshot
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var rows: [Row] {
        var out: [Row] = []
        for a in store.currentAgents {
            let agent = a
            out.append(Row(id: "agent-\(a.id)", tab: .agents, section: L("Agents"), symbol: nil,
                           dot: agent.status.flatMap(JB.status), title: agent.name,
                           hint: agent.model, run: { goToAgent(agent.id) }))
        }
        // without a query the latest few; with one, what the engine found
        for c in past.prefix(query.isEmpty && tab == .all ? 5 : 40) {
            let id = c.id
            out.append(Row(id: "past-\(c.id)", tab: .history, section: L("History"), symbol: "clock.arrow.circlepath",
                           dot: nil, title: c.title, hint: PastConversation.when(c.lastAt), run: { continueConversation(id) }))
        }
        out += [
            Row(id: "new-agent", tab: .actions, section: L("Actions"), symbol: "plus",
                dot: nil, title: L("New Agent"), hint: nil, run: newAgent),
            Row(id: "new-canvas", tab: .actions, section: L("Actions"), symbol: "rectangle.stack",
                dot: nil, title: L("New canvas"), hint: "⌘T", run: newCanvas),
            Row(id: "navigator", tab: .actions, section: L("Actions"), symbol: "sidebar.left",
                dot: nil, title: L("Sidebar"), hint: "⇧⌘A", run: toggleNavigator),
        ]
        for s in SettingsSection.allCases {
            let section = s
            out.append(Row(id: "settings-\(s.rawValue)", tab: .settings, section: L("Settings"), symbol: symbol(of: s),
                           dot: nil, title: s.title, hint: nil, run: { openSettings(section) }))
        }
        return out
    }

    private var visible: [Row] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return rows.filter { r in
            (tab == .all || r.tab == tab) &&
                (q.isEmpty || r.tab == .history || r.title.localizedCaseInsensitiveContains(q) ||
                    (r.tab == .settings ? settingsKeywords(r.id)?.contains { $0.localizedCaseInsensitiveContains(q) } == true : false))
        }
    }

    private func settingsKeywords(_ id: String) -> [String]? {
        guard id.hasPrefix("settings-"), let s = SettingsSection(rawValue: String(id.dropFirst("settings-".count))) else { return nil }
        return [s.title] + s.keywords
    }

    private func symbol(of s: SettingsSection) -> String { s.symbol }

    private func run(_ row: Row, terminal: Bool = false) {
        if terminal, row.id.hasPrefix("agent-") {
            openTerminal(String(row.id.dropFirst("agent-".count)))
        } else {
            row.run()
        }
        close()
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.system(size: 13)).foregroundStyle(JB.muted2)
                TextField(L("Search agents, conversations, settings…"), text: $query)
                    .textFieldStyle(.plain).font(.system(size: 13)).foregroundStyle(JB.ink)
                    .focused($focused)
                    .onKeyPress(.return, phases: .down) { press in
                        guard let row = visible.indices.contains(selected) ? visible[selected] : nil else { return .ignored }
                        run(row, terminal: press.modifiers.contains(.option)); return .handled
                    }
                    .onKeyPress(.upArrow) { move(-1) ? .handled : .ignored }
                    .onKeyPress(.downArrow) { move(1) ? .handled : .ignored }
                    .onKeyPress(.escape, phases: .down) { _ in close(); return .handled }
                    .onKeyPress("[", phases: .down) { press in
                        guard press.modifiers.contains(.command) else { return .ignored }
                        cycleTab(-1); return .handled
                    }
                    .onKeyPress("]", phases: .down) { press in
                        guard press.modifiers.contains(.command) else { return .ignored }
                        cycleTab(1); return .handled
                    }
                    .onSubmit { if let row = visible.indices.contains(selected) ? visible[selected] : nil { run(row) } }
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill").font(.system(size: 12)) }
                        .buttonStyle(Press()).foregroundStyle(JB.muted2).help(L("Clear"))
                }
            }
            .padding(.horizontal, 12).frame(height: 40)
            HStack(spacing: 2) {
                ForEach(Tab.allCases, id: \.self) { t in
                    Button { tab = t } label: {
                        Text(t.title).font(.system(size: 11.5, weight: tab == t ? .semibold : .regular))
                            .foregroundStyle(tab == t ? JB.ink : JB.muted)
                            .padding(.horizontal, 9).frame(height: 22)
                            .background(Capsule().fill(tab == t ? JB.panel2 : .clear))
                    }
                    .buttonStyle(Press()).accessibilityLabel(t.title)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            Rectangle().fill(JB.line.opacity(0.6)).frame(height: 1)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(sections, id: \.self) { section in
                        Text(section).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(JB.muted2)
                            .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 2)
                        ForEach(sectionRows(section)) { row in
                            Button { run(row) } label: { rowView(row, selected: visible.firstIndex(where: { $0.id == row.id }) == selected) }
                                .buttonStyle(Press())
                                .onHover { h in if h, let i = visible.firstIndex(where: { $0.id == row.id }) { selected = i } }
                        }
                    }
                    if visible.isEmpty {
                        Text(L("No results")).font(.system(size: 12)).foregroundStyle(JB.muted2)
                            .frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 18)
                    }
                }
                .padding(.bottom, 6)
            }
            .frame(maxHeight: 330)
            Rectangle().fill(JB.line.opacity(0.6)).frame(height: 1)
            Text(L("↑↓ Select · ⏎ Open · ⌥⏎ Terminal · esc Close"))
                .font(.system(size: 10.5)).foregroundStyle(JB.muted2)
                .frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 7)
        }
        .frame(width: 640)
        .background(RoundedRectangle(cornerRadius: 12).fill(JB.panel))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(JB.line))
        .shadow(color: .black.opacity(0.4), radius: 30, y: 10)
        .onChange(of: query) { selected = 0 }
        .onChange(of: tab) { selected = 0 }
        .onAppear { if !isSnapshot { focused = true } }
        .task(id: query) {
            if !query.isEmpty { try? await Task.sleep(for: .milliseconds(200)) }
            guard !Task.isCancelled, let list = try? await store.history(matching: query) else { return }
            past = list
        }
        .accessibilityLabel(L("Command palette"))
    }

    private var sections: [String] {
        var seen: [String] = []
        for r in visible where !seen.contains(r.section) { seen.append(r.section) }
        return seen
    }

    private func sectionRows(_ section: String) -> [Row] {
        visible.filter { $0.section == section }
    }

    @ViewBuilder private func rowView(_ row: Row, selected: Bool) -> some View {
        HStack(spacing: 8) {
            if let dot = row.dot {
                Circle().fill(dot).frame(width: 7, height: 7).padding(.leading, 2)
            } else if let symbol = row.symbol {
                Image(systemName: symbol).font(.system(size: 11.5)).foregroundStyle(JB.muted).frame(width: 16)
            }
            Text(row.title).font(.system(size: 12.5)).foregroundStyle(JB.ink).lineLimit(1)
            Spacer(minLength: 8)
            if let hint = row.hint {
                Text(hint).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(JB.muted2).lineLimit(1)
            }
        }
        .padding(.horizontal, 12).frame(height: 30).contentShape(Rectangle())
        .background(RoundedRectangle(cornerRadius: 6).fill(selected ? JB.sel : .clear))
    }

    private func move(_ direction: Int) -> Bool {
        guard !visible.isEmpty else { return false }
        selected = (selected + direction + visible.count) % visible.count
        return true
    }

    private func cycleTab(_ direction: Int) {
        let tabs = Tab.allCases
        guard let idx = tabs.firstIndex(of: tab) else { return }
        tab = tabs[(idx + direction + tabs.count) % tabs.count]
    }
}
