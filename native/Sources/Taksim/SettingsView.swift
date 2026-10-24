import AppKit
import SwiftUI
import TaksimKit

/// Settings, laid out as Cursor's are: a searchable list of sections on the left; on the right the section under
/// its heading, as groups of rows, each row one setting (its name, a line saying what it does, its one control).
/// Everything applies at once; there is no OK/Apply.
struct SettingsView: View {
    let model: AppModel
    @State var section: SettingsSection = .general
    @State private var query = ""
    @State private var data = SettingsData()

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Rectangle().fill(JB.line).frame(width: 1)
            VStack(alignment: .leading, spacing: 0) {
                Text(section.title)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(JB.ink)
                    .padding(.horizontal, 20).padding(.top, 18).padding(.bottom, 12)
                content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .background(JB.bg)
        }
        .frame(width: 900, height: 600)
        .background(JB.panel)
        .tint(JB.accent)
        .task(id: model.store?.api.base) { if let api = model.store?.api { await data.load(api) } }
        .onChange(of: model.settingsSection, initial: true) { _, s in
            guard let s else { return }
            section = s
            model.settingsSection = nil
            if let api = model.store?.api { Task { await data.load(api) } }
        }
    }

    // ---------- the section list ----------

    private var sidebar: some View {
        VStack(spacing: 8) {
            HStack(spacing: 6) {
                AppIcon.search.frame(width: 12, height: 12).foregroundStyle(JB.muted)
                TextField("", text: $query, prompt: Text(L("Search")).foregroundStyle(JB.muted)).textFieldStyle(.plain)
                if !query.isEmpty {
                    Button { query = "" } label: { AppIcon.close.frame(width: 9, height: 9) }.buttonStyle(Press()).foregroundStyle(JB.muted)
                }
            }
            .font(.system(size: 13))
            .padding(.horizontal, 8).frame(height: 28)
            .background(RoundedRectangle(cornerRadius: 6).fill(JB.panel2))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(JB.line))
            VStack(spacing: 1) {
                ForEach(matches) { s in
                    Button { section = s } label: {
                        Hovering { hover in
                            HStack(spacing: 8) {
                                Image(systemName: s.symbol).font(.system(size: 13)).frame(width: 18).foregroundStyle(section == s || hover ? JB.ink : JB.muted)
                                Text(s.title).foregroundStyle(JB.ink)
                                Spacer(minLength: 0)
                                if let n = data.badge(s) { Text("\(n)").font(.system(size: 11)).foregroundStyle(JB.muted) }
                            }
                            .font(.system(size: 13))
                            .padding(.horizontal, 8).frame(height: 28)
                            .background(RoundedRectangle(cornerRadius: 5).fill(section == s ? JB.sel : hover ? JB.line.opacity(0.5) : .clear))
                            .contentShape(Rectangle())
                        }
                    }
                    .buttonStyle(Press())
                }
            }
            Spacer()
        }
        .padding(10)
        .frame(width: 230)
        .onChange(of: query) { if let first = matches.first, !matches.contains(section) { section = first } }
    }

    private var matches: [SettingsSection] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased(with: Locale(identifier: "tr"))
        guard !q.isEmpty else { return SettingsSection.allCases }
        return SettingsSection.allCases.filter { s in ([s.title] + s.keywords).contains { $0.lowercased(with: Locale(identifier: "tr")).contains(q) } }
    }

    @ViewBuilder private var content: some View {
        switch section {
        case .general: GeneralPane(model: model, open: { section = $0 })
        case .appearance: AppearancePane()
        case .plugins: PluginsPane(data: data, api: model.store?.api)
        case .accounts: AccountsPane(data: data, api: model.store?.api, addFor: model.addAccountFor).onDisappear { model.addAccountFor = nil }
        case .connections: ConnectionsPane(api: model.store?.api)
        case .keymap: KeymapPane()
        }
    }
}

enum SettingsSection: String, CaseIterable, Identifiable {
    case general, appearance, accounts, plugins, connections, keymap
    var id: String { rawValue }
    var title: String {
        switch self {
        case .general: L("General")
        case .appearance: L("Appearance")
        case .plugins: L("Plugins")
        case .accounts: L("Accounts")
        case .connections: L("Connections")
        case .keymap: L("Keyboard shortcuts")
        }
    }
    var symbol: String {
        switch self {
        case .general: "gearshape"
        case .appearance: "paintpalette"
        case .plugins: "puzzlepiece.extension"
        case .accounts: "person.2"
        case .connections: "link"
        case .keymap: "keyboard"
        }
    }
    /// what the search also finds a section by
    var keywords: [String] {
        switch self {
        case .general: ["notification", "bildirim", "sound", "ses", "badge", "rozet", "delete", "sil", "language", "dil", "english", "türkçe", "ızgara", "tuval", "grid", "canvas", "yazı", "text size", "port", "node", "motor", "engine", "sunucu", "server", "url", "adres"]
        case .appearance: ["tema", "theme", "darcula", "koyu", "açık", "kontrast", "dark", "light", "contrast"]
        case .plugins: ["araç", "tool", "market", "eklenti", "plugin", "extension", "yüklü"]
        case .accounts: ["hesap", "giriş", "login", "e-posta", "ajan", "agent", "claude", "codex", "copilot", "github", "opencode", "gemini", "cli", "kurulu", "installed"]
        case .connections: ["slack", "github", "token", "bağlantı", "servis", "veri"]
        case .keymap: ["kısayol", "keymap", "tuş", "klavye"]
        }
    }
}

/// What the sections show from the server, loaded when the window opens.
@MainActor @Observable
final class SettingsData {
    struct Tool: Decodable, Identifiable {
        var id: String
        var name: String
        var summary: String?
        var author: String?
        var version: Int?
        var uses: Int?
        var builtin: Bool?
        var origin: String?
        var shelf: String?
        var shelfLabel: String?
        var installed: Bool?
        var runs: [String]?
        var keywords: [String]?
        var requires: Requires?
        var available: Available?
        var preview: JSONValue?
        var publishedAs: String?
        /// one entry per shelf and author: two people may share a tool id
        var key: String { "\(shelf ?? "")/\(author ?? "")/\(id)" }
        struct Requires: Decodable { var bin: [String]? }
        struct Available: Decodable { var ok: Bool?; var missing: [String]? }
    }
    struct Backend: Decodable, Identifiable { var name: String; var label: String; var installed: Bool?; var id: String { name } }
    struct Account: Decodable, Identifiable {
        var id: String; var name: String; var backend: String; var label: String?; var dir: String?
        var status: Status?
        struct Status: Decodable { var loggedIn: Bool?; var email: String? }
    }
    struct Gate: Decodable { var active: Int; var queued: Int; var max: Int }

    var tools: [Tool] = []
    var market: [Tool] = []
    var backends: [Backend] = []
    var accounts: [Account] = []
    var gates: [String: Gate] = [:]
    var loaded = false

    private struct ToolList: Decodable { var tools: [Tool] }
    private struct AccountList: Decodable { var accounts: [Account]; var backends: [Backend] }
    private struct Health: Decodable { var backends: [String: Gate] }

    func load(_ api: APIClient) async {
        async let t = try? api.get("/v1/toolbox", as: ToolList.self)
        async let m = try? api.get("/v1/market", as: ToolList.self)
        async let a = try? api.get("/v1/accounts", as: AccountList.self)
        async let h = try? api.get("/health", as: Health.self)
        if let t = await t { tools = t.tools }
        if let m = await m { market = m.tools }
        if let a = await a { accounts = a.accounts; backends = a.backends }
        if let h = await h { gates = h.backends }
        loaded = true
    }

    func badge(_ s: SettingsSection) -> Int? {
        switch s {
        case .plugins: tools.isEmpty ? nil : tools.count
        case .accounts: accounts.isEmpty ? nil : accounts.count
        default: nil
        }
    }
}

// ---------- shared pieces ----------

/// a group title inside a section, like PyCharm's separators
private struct PaneGroup<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(JB.muted)
                Rectangle().fill(JB.line).frame(height: 1)
            }
            content
        }
    }
}

/// A group of settings, as in Cursor: a small name, then a card whose rows are parted by hairlines.
struct SettingsGroup<Content: View>: View {
    var title: String?
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title { Text(title).font(.system(size: 12, weight: .medium)).foregroundStyle(JB.muted).padding(.leading, 2) }
            VStack(spacing: 0) {
                SwiftUI.Group(subviews: content) { rows in
                    ForEach(rows.indices, id: \.self) { i in
                        rows[i]
                        if i < rows.count - 1 { Rectangle().fill(JB.line.opacity(0.7)).frame(height: 1).padding(.leading, 14) }
                    }
                }
            }
            .background(RoundedRectangle(cornerRadius: 9).fill(JB.panel))
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(JB.line.opacity(0.6)))
        }
    }
}

/// One setting: its name, a line saying what it does, and its one control on the right.
struct SettingsRow<Lead: View, Control: View>: View {
    let title: String
    var detail: String?
    @ViewBuilder var lead: Lead
    @ViewBuilder let control: Control
    var body: some View {
        HStack(spacing: 12) {
            lead
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 13)).foregroundStyle(JB.ink)
                if let detail, !detail.isEmpty { Text(detail).font(.system(size: 11.5)).foregroundStyle(JB.muted).fixedSize(horizontal: false, vertical: true) }
            }
            Spacer(minLength: 12)
            control.font(.system(size: 12.5)).foregroundStyle(JB.ink)
        }
        .padding(.horizontal, 14).padding(.vertical, 10).frame(minHeight: 44)
    }
}
extension SettingsRow where Lead == EmptyView {
    init(_ title: String, _ detail: String? = nil, @ViewBuilder control: () -> Control) {
        self.title = title; self.detail = detail; self.lead = EmptyView(); self.control = control()
    }
}

/// the quiet bordered button a row ends in ("Open", "Copy")
struct SettingsButton: View {
    let title: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 12)).foregroundStyle(JB.ink).padding(.horizontal, 10).frame(height: 24)
                .background(RoundedRectangle(cornerRadius: 6).fill(JB.panel2))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(JB.line))
        }.buttonStyle(Press())
    }
}

/// a status dot: green working, grey not
private struct Dot: View {
    let on: Bool
    var body: some View { Circle().fill(on ? JB.ok : JB.muted2).frame(width: 7, height: 7) }
}

/// a CLI's mark on its color (the canvas's logo tile)
struct BackendTile: View {
    let backend: String
    var size: CGFloat = 22
    var body: some View {
        RoundedRectangle(cornerRadius: size / 4.4).fill(JB.backend(backend))
            .frame(width: size, height: size)
            .overlay {
                if let d = Logos.paths[backend] {
                    Path(SVGPath.parse(d)).applying(CGAffineTransform(scaleX: size * 0.64 / 24, y: size * 0.64 / 24))
                        .fill(.white).frame(width: size * 0.64, height: size * 0.64)
                } else {
                    Image(systemName: "terminal").font(.system(size: size * 0.5)).foregroundStyle(.white)
                }
            }
    }
}

/// a tool's mark from what it runs (gallery.mjs logoOf): a known kind's color and symbol, else its initial
struct ToolTile: View {
    let name: String
    /// what the tool is about: its id, programs, commands and keywords
    let hay: String
    var size: CGFloat = 32

    init(tool: SettingsData.Tool, size: CGFloat = 32) {
        name = tool.name
        hay = ([tool.id] + (tool.requires?.bin ?? []) + (tool.runs ?? []) + (tool.keywords ?? [])).joined(separator: " ").lowercased()
        self.size = size
    }
    /// an offered tool: what its sources run
    init(card: ToolCard, size: CGFloat = 20) {
        name = card.name
        let runs = card.spec?.sources.values.compactMap { s in s["run"]?.array?.compactMap(\.string).joined(separator: " ") ?? s["url"]?.string ?? s["path"]?.string } ?? []
        hay = ([card.id] + runs).joined(separator: " ").lowercased()
        self.size = size
    }

    private static let kinds: [(String, UInt32, String)] = [
        ("kube|k8s|helm", 0x326CE5, "helm"), ("docker|podman|compose", 0x1D63ED, "shippingbox"),
        ("psql|postgres|pg_|mysql|sqlite|sql", 0x336791, "cylinder"), ("redis", 0xD82C20, "square.stack.3d.up"),
        ("rabbit|kafka|queue|kuyruk|nats", 0xFF6600, "tray.full"), ("\\bgit\\b|^git|lazygit|\\bgh\\b", 0xF05033, "arrow.triangle.branch"),
        ("\\bdf\\b|\\bdu\\b|disk", 0x2F9E6E, "internaldrive"), ("\\bps\\b|top|cpu|process|süreç", 0x8A5CF6, "cpu"),
        ("log|tail|journal", 0x6B6862, "doc.plaintext"), ("curl|http|url|api|health", 0x0E9488, "network"),
    ]
    var body: some View {
        let hit = Self.kinds.first { hay.range(of: $0.0, options: .regularExpression) != nil }
        RoundedRectangle(cornerRadius: size / 4.4)
            .fill(hit.map { Color(hex: $0.1) } ?? hue)
            .frame(width: size, height: size)
            .overlay {
                if let hit { Image(systemName: hit.2).font(.system(size: size * 0.46, weight: .medium)).foregroundStyle(.white) }
                else { Text(String(name.prefix(1)).uppercased(with: Locale(identifier: "tr"))).font(.system(size: size * 0.5, weight: .bold)).foregroundStyle(.white) }
            }
    }
    private var hue: Color {
        var n = 0
        for c in name.unicodeScalars { n = (n * 31 + Int(c.value)) % 360 }
        return Color(hue: Double(n) / 360, saturation: 0.45, brightness: 0.6)
    }
}

// ---------- General ----------

struct GeneralPane: View {
    let model: AppModel
    let open: (SettingsSection) -> Void
    @AppStorage("showGrid") private var showGrid = true
    @AppStorage("notify.done") private var notifyDone = true
    @AppStorage("notify.approval") private var notifyApproval = true
    @AppStorage("notify.failed") private var notifyFailed = true
    @AppStorage("notify.sound") private var notifySound = true
    @AppStorage("dockBadge") private var dockBadge = true
    @State private var textSize = CanvasText.size
    @Bindable private var lang = LangState.shared
    private var langBinding: Binding<Language> { Binding(get: { lang.current }, set: { lang.current = $0 }) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                SettingsGroup(title: L("Preferences")) {
                    SettingsRow(L("Language"), L("The language of the app; agents are always written to in English")) {
                        Picker("", selection: langBinding) { ForEach(Language.allCases, id: \.self) { Text($0.label).tag($0) } }
                            .labelsHidden().pickerStyle(.menu).fixedSize()
                    }
                    SettingsRow(L("Keyboard shortcuts"), L("See every shortcut")) { SettingsButton(title: L("Open")) { open(.keymap) } }
                    SettingsRow(L("Theme"), L("Dark, light, Darcula or high contrast")) { SettingsButton(title: L("Open")) { open(.appearance) } }
                }
                SettingsGroup(title: L("Canvas")) {
                    SettingsRow(L("Dot grid"), L("Show the dots behind the nodes")) {
                        Toggle("", isOn: $showGrid).labelsHidden().toggleStyle(.switch).controlSize(.small)
                    }
                    SettingsRow(L("Text size"), L("Base size for canvas text; zooms with everything")) {
                        HStack(spacing: 8) {
                            Slider(value: $textSize, in: 0.75...1.5, step: 0.05).frame(width: 130).tint(JB.accent)
                            Text("\(Int((textSize * 100).rounded()))%").font(.system(size: 12)).foregroundStyle(JB.muted).monospacedDigit().frame(width: 40, alignment: .trailing)
                        }
                        .onChange(of: textSize) { _, v in CanvasText.save(v) }
                    }
                }
                SettingsGroup(title: L("Notifications")) {
                    SettingsRow(L("Agent finished"), L("When the app is in the background")) {
                        Toggle("", isOn: $notifyDone).labelsHidden().toggleStyle(.switch).controlSize(.small)
                    }
                    SettingsRow(L("Needs approval"), L("A tool waits for you")) {
                        Toggle("", isOn: $notifyApproval).labelsHidden().toggleStyle(.switch).controlSize(.small)
                    }
                    SettingsRow(L("Failed"), L("A turn ended with an error")) {
                        Toggle("", isOn: $notifyFailed).labelsHidden().toggleStyle(.switch).controlSize(.small)
                    }
                    SettingsRow(L("Sound"), L("Play a sound with approvals and errors")) {
                        Toggle("", isOn: $notifySound).labelsHidden().toggleStyle(.switch).controlSize(.small)
                    }
                    SettingsRow(L("Dock badge"), L("Working agents on the app icon")) {
                        Toggle("", isOn: $dockBadge).labelsHidden().toggleStyle(.switch).controlSize(.small)
                            .onChange(of: dockBadge) { _, on in if !on { NSApp.dockTile.badgeLabel = nil } }
                    }
                }
                SettingsGroup(title: L("Reset")) {
                    SettingsRow(L("Start over"), L("Canvases, accounts, connections and tools go; the app opens as when first installed")) {
                        Button(action: startOver) {
                            Text(L("Reset")).font(.system(size: 12)).foregroundStyle(JB.err).padding(.horizontal, 10).frame(height: 24)
                                .background(RoundedRectangle(cornerRadius: 6).fill(JB.panel2))
                                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(JB.err.opacity(0.6)))
                        }.buttonStyle(Press())
                    }
                }
            }
            .padding(.horizontal, 20).padding(.bottom, 20)
        }
    }
}

extension GeneralPane {
    /// everything taksim kept goes (the engine's canvases, accounts, connections, tools; this app's own
    /// preferences), then the app opens again as on the first day
    func startOver() {
        let alert = NSAlert()
        alert.messageText = L("Start over?")
        alert.informativeText = L("Every canvas and conversation, every account and connection, and your own tools are deleted. This cannot be undone.")
        alert.alertStyle = .warning
        alert.addButton(withTitle: L("Reset"))
        alert.addButton(withTitle: L("Cancel"))
        alert.buttons.first?.hasDestructiveAction = true
        guard alert.runModal() == .alertFirstButtonReturn, let api = model.store?.api else { return }
        Task { @MainActor in
            do { try await api.post("/v1/reset", [:] as [String: String]) } catch {
                let failed = NSAlert()
                failed.messageText = L("Could not reset: %@", error.localizedDescription)
                failed.runModal()
                return
            }
            if let id = Bundle.main.bundleIdentifier { UserDefaults.standard.removePersistentDomain(forName: id) }
            await Updater.shared.stopEngine()
            let relaunch = Process()
            relaunch.executableURL = URL(fileURLWithPath: "/bin/sh")
            relaunch.arguments = ["-c", "while kill -0 \"$0\" 2>/dev/null; do sleep 0.2; done; open \"$1\"",
                                  String(ProcessInfo.processInfo.processIdentifier), Bundle.main.bundleURL.path]
            try? relaunch.run()
            NSApp.terminate(nil)
        }
    }
}

private struct AppearancePane: View {
    @AppStorage("theme") private var theme = ThemeChoice.system.rawValue

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(L("Theme")).font(.system(size: 12, weight: .medium)).foregroundStyle(JB.muted).padding(.leading, 2)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 140, maximum: 170), spacing: 14)], alignment: .leading, spacing: 14) {
                    ForEach(ThemeChoice.allCases) { choice in ThemeCard(choice: choice, selected: theme == choice.rawValue) { theme = choice.rawValue } }
                }
            }
            .padding(.horizontal, 20).padding(.bottom, 20)
        }
    }
}

/// a theme drawn as a small window of itself: header, tab, a card on the canvas, the accent button
private struct ThemeCard: View {
    let choice: ThemeChoice
    let selected: Bool
    let pick: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: pick) {
            VStack(spacing: 8) {
                ZStack {
                    if choice == .system {
                        HStack(spacing: 0) { preview(.light); preview(.dark) }
                            .clipShape(RoundedRectangle(cornerRadius: 7))
                    } else {
                        preview(choice)
                    }
                }
                .frame(height: 92)
                .clipShape(RoundedRectangle(cornerRadius: 7))
                .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(selected ? JB.accent : hover ? JB.muted2 : JB.line, lineWidth: selected ? 2 : 1))
                .scaleEffect(hover && !selected ? 1.02 : 1)
                .animation(.spring(response: 0.3, dampingFraction: 0.7), value: hover)
                HStack(spacing: 4) {
                    Text(choice.label)
                    if selected { Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(JB.accent) }
                }
                .font(.system(size: 12, weight: selected ? .semibold : .regular))
                .foregroundStyle(JB.ink)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(Press())
        .onHover { hover = $0 }
        .accessibilityLabel(choice.label)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    /// the theme's own colors, whatever the window's theme is
    private func preview(_ t: ThemeChoice) -> some View {
        let dark = t != .light
        func c(_ d: UInt32, _ l: UInt32) -> Color { Color(hex: dark ? (t.darkMap[d] ?? d) : l) }
        return GeometryReader { g in
            ZStack(alignment: .topLeading) {
                c(0x1E1F22, 0xFFFFFF)
                VStack(spacing: 0) {
                    c(0x2B2D30, 0xF7F8FA).frame(height: 14)
                        .overlay(alignment: .trailing) { RoundedRectangle(cornerRadius: 2).fill(c(0x3574F0, 0x3574F0)).frame(width: 18, height: 7).padding(.trailing, 5) }
                    c(0x2B2D30, 0xF7F8FA).frame(height: 12)
                        .overlay(alignment: .bottomLeading) { c(0x3574F0, 0x3574F0).frame(width: 30, height: 1.5).padding(.leading, 6) }
                }
                VStack(spacing: 0) {
                    c(0x323438, 0xF2F3F5).frame(height: 9)
                    c(0x2B2D30, 0xFFFFFF)
                        .overlay(alignment: .topLeading) {
                            VStack(alignment: .leading, spacing: 3) {
                                c(0xBCBEC4, 0x2B2D30).frame(width: 34, height: 2)
                                c(0x868A91, 0x6C707E).frame(width: 24, height: 2)
                            }.padding(5)
                        }
                }
                .clipShape(RoundedRectangle(cornerRadius: 3))
                .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(c(0x43454A, 0xDFE1E5), lineWidth: 0.5))
                .frame(width: min(64, g.size.width * 0.6), height: 38)
                .offset(x: 12, y: 36)
                Circle().fill(c(0x5FB865, 0x208A3C)).frame(width: 5, height: 5).offset(x: 70, y: 40)
            }
        }
    }
}

// ---------- Eklentiler ----------

private struct PluginsPane: View {
    let data: SettingsData
    let api: APIClient?
    @State private var tab: Tab = .market
    @State private var query = ""
    @State private var selected: String?
    @State private var busy: String?
    /// the shared market's GitHub repository (owner/name); editing it in place
    @State private var repo: String?
    @State private var repoDraft = ""
    @State private var editingRepo = false
    /// what the last share did: shared under a name, or a pull request opened
    @State private var shared: [String: (text: String, url: URL?)] = [:]
    @State private var shareError: [String: String] = [:]
    enum Tab: String, CaseIterable {
        case market = "Market", installed = "Yüklü"
        var label: String { switch self { case .market: "Market"; case .installed: L("Installed") } }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 18) {
                ForEach(Tab.allCases, id: \.self) { t in
                    Button { tab = t; selected = nil } label: {
                        HStack(spacing: 5) {
                            Text(t.label)
                            Text("\(t == .market ? data.market.count : data.tools.count)").foregroundStyle(JB.muted).font(.system(size: 11))
                        }
                        .font(.system(size: 13, weight: tab == t ? .semibold : .regular))
                        .foregroundStyle(tab == t ? JB.ink : JB.text)
                        .frame(height: 34)
                        .overlay(alignment: .bottom) { if tab == t { Rectangle().fill(JB.accent).frame(height: 2) } }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(Press())
                }
                Spacer()
                HStack(spacing: 6) {
                    AppIcon.search.frame(width: 11, height: 11).foregroundStyle(JB.muted)
                    TextField("", text: $query, prompt: Text(L("Search")).foregroundStyle(JB.muted)).textFieldStyle(.plain)
                }
                .font(.system(size: 12.5))
                .padding(.horizontal, 8).frame(width: 200, height: 26)
                .background(RoundedRectangle(cornerRadius: 6).fill(JB.panel2))
            }
            .padding(.horizontal, 20)
            Rectangle().fill(JB.line).frame(height: 1)
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    if tab == .market { repoRow; Rectangle().fill(JB.line).frame(height: 1) }
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(list, id: \.key) { t in row(t) }
                        }
                    }
                }
                .frame(width: 330)
                Rectangle().fill(JB.line).frame(width: 1)
                if let t = list.first(where: { $0.key == selected }) ?? list.first {
                    detail(t).id(t.key)
                } else {
                    Image(systemName: "puzzlepiece.extension").font(.system(size: 34)).foregroundStyle(JB.muted2)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
    }

    private var list: [SettingsData.Tool] {
        let all = tab == .market ? data.market : data.tools
        let q = query.trimmingCharacters(in: .whitespaces).lowercased(with: Locale(identifier: "tr"))
        guard !q.isEmpty else { return all }
        return all.filter { ([$0.name, $0.summary ?? "", $0.id] + ($0.keywords ?? [])).joined(separator: " ").lowercased(with: Locale(identifier: "tr")).contains(q) }
    }

    private func row(_ t: SettingsData.Tool) -> some View {
        let on = t.key == (selected ?? list.first?.key)
        return Button { selected = t.key } label: {
            HStack(spacing: 10) {
                ToolTile(tool: t, size: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text(t.name).font(.system(size: 13, weight: .medium)).foregroundStyle(JB.ink).lineLimit(1)
                    if let s = t.summary, s != t.name { Text(s).font(.system(size: 11.5)).foregroundStyle(JB.muted).lineLimit(1) }
                }
                Spacer(minLength: 4)
                if tab == .market, t.shelf == "github", let a = t.author {
                    Text("@" + a).font(.system(size: 11)).foregroundStyle(JB.muted).lineLimit(1)
                }
                action(t, compact: true)
            }
            .padding(.horizontal, 14).frame(height: 52)
            .background(on ? JB.sel : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(Press())
    }

    private func detail(_ t: SettingsData.Tool) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 14) {
                    ToolTile(tool: t, size: 52)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(t.name).font(.system(size: 18, weight: .semibold)).foregroundStyle(JB.ink)
                        HStack(spacing: 10) {
                            if let a = t.author { Label(a, systemImage: "person").labelStyle(Tight()) }
                            if let v = t.version { Text("v\(v)") }
                            if let u = t.uses, u > 0 { Label("\(u)", systemImage: "repeat").labelStyle(Tight()) }
                            if let s = t.shelfLabel { Label(s, systemImage: "shippingbox").labelStyle(Tight()) }
                        }
                        .font(.system(size: 12)).foregroundStyle(JB.muted).lineLimit(1).fixedSize()
                    }
                    Spacer()
                    if tab == .installed { share(t) }
                    action(t, compact: false)
                }
                if let s = shared[t.id] {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(JB.ok)
                        if let u = s.url { Link(s.text, destination: u).foregroundStyle(JB.accent) } else { Text(s.text).foregroundStyle(JB.ink) }
                    }
                    .font(.system(size: 12))
                }
                if let e = shareError[t.id] {
                    Label(e, systemImage: "exclamationmark.triangle.fill").font(.system(size: 12)).foregroundStyle(JB.err).lineLimit(3)
                }
                if let s = t.summary, !s.isEmpty, s != t.name { Text(s).font(.system(size: 13)).foregroundStyle(JB.text) }
                if let missing = t.available?.missing, !missing.isEmpty {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(JB.warn)
                        Text(missing.joined(separator: ", ")).font(.system(size: 12, design: .monospaced)).foregroundStyle(JB.ink)
                    }
                }
                if let runs = t.runs, !runs.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(runs, id: \.self) { r in
                            HStack(spacing: 6) {
                                Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold)).foregroundStyle(JB.muted)
                                Text(r).font(.system(size: 12, design: .monospaced)).foregroundStyle(JB.ink).textSelection(.enabled)
                            }
                        }
                    }
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 6).fill(JB.panel))
                }
                if !previewLines(t).isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(previewLines(t).prefix(8).enumerated()), id: \.offset) { _, l in
                            Text(l).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(JB.text).lineLimit(1)
                        }
                    }
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 6).fill(JB.panel))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(JB.line))
                }
            }
            .padding(20)
        }
        .frame(maxWidth: .infinity)
    }

    /// the saved preview's rows, as the gallery card shows them
    private func previewLines(_ t: SettingsData.Tool) -> [String] {
        guard case .object(let sources)? = t.preview?["data"] else { return [] }
        return sources.keys.sorted().flatMap { k -> [String] in
            guard case .array(let rows)? = sources[k] else { return [] }
            return rows.compactMap { r in
                if let s = r["text"]?.string { return s }
                if case .object(let o) = r { return o.keys.sorted().compactMap { o[$0]?.string ?? o[$0]?.number.map { String(format: "%g", $0) } }.joined(separator: "  ") }
                return r.string
            }
        }
    }

    /// the one action a tool has here: install from the market, remove from the installed ones
    @ViewBuilder private func action(_ t: SettingsData.Tool, compact: Bool) -> some View {
        if tab == .market {
            if t.installed == true {
                Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(JB.ok)
                    .frame(width: compact ? 22 : 70, height: 24)
            } else {
                Button { Task { await install(t) } } label: {
                    Text(L("Install")).font(.system(size: 12, weight: .semibold)).foregroundStyle(JB.accentInk)
                        .padding(.horizontal, 10).frame(height: 24)
                        .background(RoundedRectangle(cornerRadius: 5).fill(JB.accent))
                        .opacity(busy == t.id ? 0.5 : 1)
                }
                .buttonStyle(Press()).disabled(busy != nil)
            }
        } else if t.builtin != true {
            Button { Task { await remove(t) } } label: {
                Image(systemName: "trash").font(.system(size: 12)).foregroundStyle(JB.muted)
                    .frame(width: 24, height: 24).contentShape(Rectangle())
            }
            .buttonStyle(Press()).help(L("Remove")).disabled(busy != nil)
        }
    }

    private func install(_ t: SettingsData.Tool) async {
        guard let api else { return }
        busy = t.id
        var body: [String: Any] = ["shelf": t.shelf ?? "local", "id": t.id]
        if let a = t.author, t.shelf == "github" { body["by"] = a }
        _ = try? await api.post("/v1/market/install", body)
        await data.load(api)
        busy = nil
    }
    // ---------- the shared market ----------

    /// the repository everyone shares to: shown as owner/name, edited in place (Enter saves; empty: none)
    @ViewBuilder private var repoRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "person.2.wave.2").font(.system(size: 12)).foregroundStyle(repo == nil ? JB.muted : JB.accent)
            if editingRepo || repo == nil {
                TextField("", text: $repoDraft, prompt: Text(L("owner/repo")).foregroundStyle(JB.muted2))
                    .textFieldStyle(.plain).font(.system(size: 12, design: .monospaced))
                    .onSubmit { Task { await saveRepo() } }
                    .onExitCommand { editingRepo = false; repoDraft = repo ?? "" }
            } else if let r = repo {
                Text(r).font(.system(size: 12, design: .monospaced)).foregroundStyle(JB.ink).lineLimit(1)
                    .onTapGesture(count: 2) { repoDraft = r; editingRepo = true }
                Spacer(minLength: 4)
                Button { repoDraft = r; editingRepo = true } label: { Image(systemName: "pencil").font(.system(size: 11)).foregroundStyle(JB.muted) }
                    .buttonStyle(Press()).help(L("Change the shared market"))
            }
        }
        .padding(.horizontal, 14).frame(height: 36)
        .help(L("Shared market: the GitHub repo everyone shares tools through"))
        .task { await loadRepo() }
    }

    private struct Repo: Decodable { var repo: String? }
    private func loadRepo() async {
        guard let api, let r = try? await api.get("/v1/market/repo", as: Repo.self) else { return }
        repo = r.repo; repoDraft = r.repo ?? ""
    }
    private func saveRepo() async {
        guard let api else { return }
        let r: Repo? = try? await api.put("/v1/market/repo", ["repo": repoDraft.trimmingCharacters(in: .whitespaces)], as: Repo.self)
        if let r { repo = r.repo; editingRepo = false; await data.load(api) }
    }

    /// Share: to the shared market under the user's GitHub name (a pull request when they can't push there)
    @ViewBuilder private func share(_ t: SettingsData.Tool) -> some View {
        if repo != nil, t.builtin != true, t.origin == "mine" || t.origin == nil {
            Button { Task { await publish(t) } } label: {
                HStack(spacing: 5) {
                    if busy == "share:" + t.id { ProgressView().controlSize(.mini) } else { Image(systemName: "square.and.arrow.up").font(.system(size: 11)) }
                    Text(L("Share")).font(.system(size: 12, weight: .semibold))
                }
                .foregroundStyle(JB.accentInk).padding(.horizontal, 10).frame(height: 24)
                .background(RoundedRectangle(cornerRadius: 5).fill(JB.accent))
            }
            .buttonStyle(Press()).disabled(busy != nil)
            .help(t.publishedAs.map { L("@%@ shared; push a new version", $0) } ?? L("Share under your username on the shared market"))
        }
    }
    private struct Published: Decodable { var version: Int?; var author: String?; var url: String?; var pr: String? }
    private func publish(_ t: SettingsData.Tool) async {
        guard let api else { return }
        busy = "share:" + t.id; shareError[t.id] = nil; shared[t.id] = nil
        defer { busy = nil }
        do {
            let r: Published = try await api.post("/v1/toolbox/\(t.id)/publish", ["shelf": "github"], as: Published.self)
            let who = r.author.map { "@" + $0 } ?? ""
            shared[t.id] = r.pr != nil
                ? (L("%@ · pull request opened for v%d", who, r.version ?? 1), r.pr.flatMap(URL.init(string:)))
                : (L("Shared as %@ · v%d", who, r.version ?? 1), r.url.flatMap(URL.init(string:)))
            await data.load(api)
        } catch { shareError[t.id] = (error as? APIError)?.message ?? error.localizedDescription }
    }

    private func remove(_ t: SettingsData.Tool) async {
        guard let api else { return }
        busy = t.id
        _ = try? await api.delete("/v1/toolbox/\(t.id)")
        await data.load(api)
        busy = nil
    }
}

private struct Tight: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) { configuration.icon.font(.system(size: 10)); configuration.title }
    }
}

// ---------- Ajanlar ----------

// ---------- Accounts ----------

private struct AccountsPane: View {
    let data: SettingsData
    let api: APIClient?
    /// a CLI to add an account for as soon as the pane opens (from the agent sheet's "Hesap ekle")
    var addFor: String?
    @State private var m: AccountsModel?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if let m {
                    ForEach(m.backends.filter { $0.name != "fake" || ProcessInfo.processInfo.environment["TAKSIM_URL"] != nil }) { b in
                        CLIAccounts(backend: b, m: m, startAdding: addFor == b.name)
                    }
                } else {
                    ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(.top, 40)
                }
            }
            .padding(20)
            .animation(.spring(response: 0.45, dampingFraction: 0.85), value: m?.login == nil)
        }
        .task {
            guard let api, m == nil else { return }
            let model = AccountsModel(api: api)
            m = model
            await model.load()
            await model.refreshStatuses()
            await model.loadUsage()
        }
        .onChange(of: m?.justSignedIn) { if let api { Task { await data.load(api) } } }
        .onDisappear { m?.cancel() }
    }
}

/// one CLI: its mark and name, this computer's login and its named accounts as rows, + to add another
private struct CLIAccounts: View {
    let backend: AccountsModel.Backend
    let m: AccountsModel
    var startAdding = false
    @State private var adding = false
    @State private var newName = ""
    @State private var renaming: String?
    /// the account whose API key is being pasted
    @State private var keyFor: String?
    @State private var keyDraft = ""
    @State private var savingKey = false
    @State private var draft = ""
    @FocusState private var focus: String?
    /// the row under the pointer: its remove button shows
    @State private var hovered: String?

    private var installed: Bool { backend.installed == true }
    private var list: [AccountsModel.Account] { m.accounts.filter { $0.backend == backend.name }.sorted { ($0.dir == nil ? 0 : 1, $0.name) < ($1.dir == nil ? 0 : 1, $1.name) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                BackendTile(backend: backend.name, size: 18).saturation(installed ? 1 : 0)
                Text(backend.label).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(installed ? JB.ink : JB.muted)
                if m.installing.contains(backend.name) { ProgressView().controlSize(.mini) }
                else if !installed {
                    Button { Task { await m.signIn(backend) } } label: {
                        Image(systemName: "arrow.down.circle.fill").font(.system(size: 13)).foregroundStyle(m.failed.contains(backend.name) ? JB.err : JB.accent)
                    }
                    .buttonStyle(Press()).disabled(m.login != nil)
                    .help(m.problem[backend.name] ?? L("Install and sign in"))
                }
                Rectangle().fill(JB.line).frame(height: 1)
            }
            if installed {
                VStack(spacing: 0) {
                    // the CLI's own login on this computer, before anyone named it: always listed, as the agent sheet
                    // offers it (signed out, it asks to sign in here too); it can't be removed, it is the computer's
                    if !list.contains(where: { $0.dir == nil }) {
                        let st = m.machine[backend.name]
                        let name = st?.email ?? backend.label
                        row(avatar: AnyView(initialAvatar(name)), name: name, status: st, usage: m.usage["machine:\(backend.name)"],
                            loggingIn: m.login?.backend == backend.name && !list.contains { $0.id == m.login?.account },
                            signIn: { Task { await m.signIn(backend) } }, menu: nil)
                        divider
                    }
                    ForEach(list) { a in
                        let st = a.status ?? (a.dir == nil ? m.machine[backend.name] : nil)
                        // a Gemini account of its own signs in privately (another Google account than the browser's),
                        // or with an API key
                        let own = backend.name == "gemini" && a.dir != nil
                        row(avatar: AnyView(initialAvatar(a.name)), name: a.name, id: a.id,
                            status: st, usage: m.usage(of: a), loggingIn: m.login?.account == a.id,
                            signIn: { Task { await m.signIn(account: a.id, backend: backend.name, privately: own) } },
                            key: own ? { keyFor = a.id; keyDraft = ""; focus = "key" } : nil,
                            remove: { remove(a) },
                            menu: AnyView(menu(a)))
                        if keyFor == a.id { keyRow(a) }
                        divider
                    }
                    addRow
                }
                .background(RoundedRectangle(cornerRadius: 8).fill(JB.panel))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(JB.line))
                if let why = m.problem[backend.name] {
                    Label(why, systemImage: "exclamationmark.triangle.fill").font(.system(size: 11.5)).foregroundStyle(JB.err)
                        .lineLimit(2).transition(.opacity)
                }
                if let l = m.login, l.backend == backend.name {
                    LoginTerminal(login: l, cancel: { m.cancel() }).transition(.move(edge: .top).combined(with: .opacity))
                }
            }
        }
        .onAppear { if startAdding { beginAdd() } }
        .onChange(of: startAdding) { _, now in if now { beginAdd() } }
    }

    private var divider: some View { Rectangle().fill(JB.line).frame(height: 1).padding(.leading, 50) }

    private func initialAvatar(_ name: String) -> some View {
        var n = 7
        for c in name.unicodeScalars { n = (n * 31 + Int(c.value)) % 360 }
        return Circle().fill(Color(hue: Double(n) / 360, saturation: 0.45, brightness: 0.75)).frame(width: 28, height: 28)
            .overlay(Text(String(name.prefix(1)).uppercased(with: Locale(identifier: "tr"))).font(.system(size: 12, weight: .bold)).foregroundStyle(.white))
    }

    /// avatar, name (double-click to rename), who is signed in; the one action needed; the rest under ⋯
    private func row(avatar: AnyView, name: String, id: String? = nil, status: AccountsModel.Status?, usage: Usage? = nil, loggingIn: Bool,
                     signIn: @escaping () -> Void, key: (() -> Void)? = nil, remove: (() -> Void)? = nil, menu: AnyView?) -> some View {
        HStack(spacing: 12) {
            avatar
            VStack(alignment: .leading, spacing: 2) {
                if let id, renaming == id {
                    TextField("", text: $draft).textFieldStyle(.plain).font(.system(size: 13)).foregroundStyle(JB.ink)
                        .focused($focus, equals: "rename")
                        .onSubmit { commitRename(id) }
                        .onExitCommand { renaming = nil }
                } else {
                    Text(name).font(.system(size: 13)).foregroundStyle(JB.ink)
                        .onTapGesture(count: 2) { if let id { draft = name; renaming = id; focus = "rename" } }
                }
                HStack(spacing: 5) {
                    Circle().fill(loggingIn ? JB.wait : status == nil ? JB.muted2 : status?.loggedIn == true ? JB.ok : JB.err).frame(width: 6, height: 6)
                    Text(loggingIn ? L("Signing in") : status == nil ? "" : status?.loggedIn == true
                         // the email once: a login named by its email says only its plan under it
                         ? ([status?.email == name ? nil : status?.email, status?.plan].compactMap { $0 }.joined(separator: " · ").nilIfEmpty ?? L("Signed in")) : L("Sign-in required"))
                        .font(.system(size: 11.5)).foregroundStyle(JB.muted).lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            if let usage, status?.loggedIn == true { UsageBars(usage: usage, width: 54) }
            if !loggingIn, let status, status.loggedIn != true, let key, keyFor != id {
                Button(action: key) { Image(systemName: "key").font(.system(size: 12)).foregroundStyle(JB.muted).frame(width: 24, height: 24) }
                    .buttonStyle(Press()).help(L("Sign in with an API key"))
            }
            if !loggingIn, let status, status.loggedIn != true {
                Button(action: signIn) {
                    Text(L("Sign in")).font(.system(size: 12, weight: .semibold)).foregroundStyle(JB.accentInk)
                        .padding(.horizontal, 12).frame(height: 24).background(Capsule().fill(JB.accent))
                }
                .buttonStyle(Press()).disabled(m.login != nil)
            }
            // one click on the row's own ✕ (it shows under the pointer); right click offers it too
            if let remove, hovered == name, loggingIn == false {
                Button(action: remove) { Image(systemName: "xmark.circle.fill").font(.system(size: 14)).foregroundStyle(JB.muted).frame(width: 24, height: 24) }
                    .buttonStyle(Press()).help(L("Remove")).transition(.scale.combined(with: .opacity))
            }
            if let menu { menu }
        }
        .padding(.horizontal, 12).frame(height: 52)
        .contentShape(Rectangle())
        .onHover { inside in withAnimation(.easeOut(duration: 0.15)) { if inside { hovered = name } else if hovered == name { hovered = nil } } }
        .contextMenu { if let remove { Button(L("Remove"), role: .destructive, action: remove) } }
    }

    /// the API key, pasted once; Enter checks it with Google and keeps it in the keychain
    private func keyRow(_ a: AccountsModel.Account) -> some View {
        HStack(spacing: 8) {
            SecureField("", text: $keyDraft, prompt: Text("AIza… (Google AI Studio)").foregroundStyle(JB.muted2))
                .textFieldStyle(.plain).font(.system(size: 12, design: .monospaced))
                .focused($focus, equals: "key")
                .padding(.horizontal, 8).frame(height: 26)
                .background(RoundedRectangle(cornerRadius: 5).fill(JB.bg.opacity(0.6)))
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(JB.line))
                .onSubmit { saveKey(a) }
                .onExitCommand { keyFor = nil }
            Button { NSWorkspace.shared.open(URL(string: "https://aistudio.google.com/apikey")!) } label: {
                Image(systemName: "questionmark.circle").font(.system(size: 13)).foregroundStyle(JB.muted)
            }
            .buttonStyle(Press()).help(L("Where to get a key"))
            Button { saveKey(a) } label: {
                if savingKey { ProgressView().controlSize(.mini).frame(width: 30) }
                else { Image(systemName: "return").font(.system(size: 11, weight: .semibold)).foregroundStyle(JB.accentInk) }
            }
            .buttonStyle(Press()).frame(width: 30, height: 24).background(RoundedRectangle(cornerRadius: 5).fill(JB.accent))
            .disabled(keyDraft.trimmingCharacters(in: .whitespaces).isEmpty || savingKey)
        }
        .padding(.leading, 52).padding(.trailing, 12).padding(.bottom, 10)
        .transition(.opacity.combined(with: .move(edge: .top)))
    }
    private func saveKey(_ a: AccountsModel.Account) {
        let k = keyDraft.trimmingCharacters(in: .whitespaces)
        guard !k.isEmpty else { return }
        savingKey = true
        Task { if await m.setKey(a.id, backend: backend.name, key: k) { keyFor = nil; keyDraft = "" }; savingKey = false }
    }

    private func menu(_ a: AccountsModel.Account) -> some View {
        Menu {
            Button(L("Sign in again")) { Task { await m.signIn(account: a.id, backend: backend.name, privately: backend.name == "gemini" && a.dir != nil) } }
            if backend.name == "gemini", a.dir != nil { Button(L("API key")) { keyFor = a.id; keyDraft = ""; focus = "key" } }
            Button(L("Rename")) { draft = a.name; renaming = a.id; focus = "rename" }
            Divider()
            Button(a.dir == nil ? L("Remove name") : L("Delete"), role: .destructive) { remove(a) }.disabled(m.login?.account == a.id)
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 12, weight: .semibold)).foregroundStyle(JB.muted).frame(width: 24, height: 24)
        }
        .menuStyle(.button).buttonStyle(Press()).menuIndicator(.hidden).fixedSize()
    }

    /// + Hesap ekle: the name comes filled in and selected; Enter makes the account and starts its sign-in
    @ViewBuilder private var addRow: some View {
        if m.installing.contains(backend.name) {
            // not on this computer: fetching it comes first
            HStack(spacing: 12) {
                ProgressView().controlSize(.small).frame(width: 28, height: 28)
                Text(L("Installing")).font(.system(size: 13)).foregroundStyle(JB.muted)
                Spacer()
            }
            .padding(.horizontal, 12).frame(height: 52)
        } else if !installed, m.failed.contains(backend.name), let hint = AccountsModel.installHints[backend.name] {
            installHelp(hint)
        } else if adding {
            HStack(spacing: 12) {
                Circle().strokeBorder(JB.accent, style: StrokeStyle(lineWidth: 1.2, dash: [3, 2])).frame(width: 28, height: 28)
                    .overlay(Image(systemName: "plus").font(.system(size: 11, weight: .bold)).foregroundStyle(JB.accent))
                TextField("", text: $newName).textFieldStyle(.plain).font(.system(size: 13)).foregroundStyle(JB.ink)
                    .focused($focus, equals: "add")
                    .onSubmit { commitAdd() }
                    .onExitCommand { adding = false }
                Button { commitAdd() } label: {
                    Image(systemName: "return").font(.system(size: 11, weight: .semibold)).foregroundStyle(JB.accentInk)
                        .frame(width: 26, height: 22).background(RoundedRectangle(cornerRadius: 5).fill(JB.accent))
                }
                .buttonStyle(Press()).disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(.horizontal, 12).frame(height: 52)
        } else {
            Button { beginAdd() } label: {
                HStack(spacing: 12) {
                    Circle().strokeBorder(JB.line, style: StrokeStyle(lineWidth: 1.2, dash: [3, 2])).frame(width: 28, height: 28)
                        .overlay(Image(systemName: "plus").font(.system(size: 11, weight: .bold)).foregroundStyle(JB.muted))
                    Text(L("Add account")).font(.system(size: 13)).foregroundStyle(JB.muted)
                    Spacer()
                }
                .padding(.horizontal, 12).frame(height: 44).contentShape(Rectangle())
            }
            .buttonStyle(Press()).disabled(m.login != nil)
        }
    }

    /// it could not be installed from here: the command to run and the page to go to, and a way to try again
    private func installHelp(_ hint: (command: String, url: String)) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle").foregroundStyle(JB.err).frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(hint.command).font(.system(size: 12, design: .monospaced)).foregroundStyle(JB.ink).textSelection(.enabled).lineLimit(1)
                if let why = m.problem[backend.name], !why.isEmpty {
                    Text(why).font(.system(size: 11)).foregroundStyle(JB.muted).lineLimit(2).truncationMode(.tail)
                }
            }
            Spacer(minLength: 6)
            Button { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(hint.command, forType: .string) } label: { Image(systemName: "doc.on.doc") }
                .buttonStyle(Press()).help(L("Copy"))
            Button { if let u = URL(string: hint.url) { NSWorkspace.shared.open(u) } } label: { Image(systemName: "arrow.up.right.square") }
                .buttonStyle(Press()).help(hint.url)
            Button { Task { if await m.install(backend.name) { nameIt() } } } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(Press()).help(L("Try again"))
        }
        .font(.system(size: 12)).padding(.horizontal, 12).frame(minHeight: 52)
    }

    /// + : a CLI that is here gets its name asked for; one that isn't is installed first, and then asked for
    private func beginAdd() {
        guard installed else {
            Task { if await m.install(backend.name) { nameIt() } }
            return
        }
        nameIt()
    }

    private func nameIt() {
        newName = m.freeName(backend.label)
        adding = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            focus = "add"
            NSApp.keyWindow?.fieldEditor(false, for: nil)?.selectAll(nil) // the name comes selected, ready to type over
        }
    }
    private func commitAdd() {
        let n = newName.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty else { return }
        adding = false
        Task { await m.add(backend: backend.name, name: n) }
    }
    private func commitRename(_ id: String) {
        let n = draft.trimmingCharacters(in: .whitespaces)
        renaming = nil
        guard !n.isEmpty else { return }
        Task { await m.rename(id, to: n) }
    }
    private func remove(_ a: AccountsModel.Account) {
        // a named account's own folder (its credentials) goes with it: ask once
        if a.dir != nil {
            let alert = NSAlert()
            alert.messageText = L("Delete \"%@\"?", a.name)
            alert.addButton(withTitle: L("Delete")).hasDestructiveAction = true
            alert.addButton(withTitle: L("Cancel"))
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        Task { await m.remove(a.id) }
    }
}

private extension String { var nilIfEmpty: String? { isEmpty ? nil : self } }

// ---------- Shortcuts ----------

private struct KeymapPane: View {
    private let keys: [(String, [String])] = [
        (L("Command palette"), ["⌘", "K"]),
        (L("New canvas"), ["⌘", "T"]), (L("Show all"), ["⌘", "0"]), (L("Tab 1–9"), ["⌘", "1…9"]),
        (L("Sidebar"), ["⌘", "⇧", "A"]), (L("Group"), ["⌘", "G"]), (L("Select"), ["⌘", L("drag")]),
        (L("Zoom"), ["⌘", L("scroll")]), (L("Delete"), ["⌫"]), (L("Settings"), ["⌘", ","]),
    ]
    private let chat: [(String, [String])] = [
        (L("Send"), ["⏎"]), (L("New line"), ["⇧", "⏎"]), (L("Switch Agent / Ask / Plan"), ["⇧", "⇥"]),
        (L("Search in chat"), ["⌘", "F"]), (L("Add selected code to chat"), ["⌘", "L"]),
    ]
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                SettingsGroup(title: L("Canvas")) { ForEach(keys, id: \.0) { k in SettingsRow(k.0) { caps(k.1) } } }
                SettingsGroup(title: L("Chat")) { ForEach(chat, id: \.0) { k in SettingsRow(k.0) { caps(k.1) } } }
            }
            .padding(.horizontal, 20).padding(.bottom, 20)
        }
    }
    private func caps(_ keys: [String]) -> some View {
        HStack(spacing: 4) {
            ForEach(keys, id: \.self) { c in
                Text(c).font(.system(size: 11.5, weight: .medium)).foregroundStyle(JB.ink)
                    .padding(.horizontal, 6).frame(minWidth: 22, minHeight: 20)
                    .background(RoundedRectangle(cornerRadius: 4).fill(JB.panel2))
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(JB.line))
            }
        }
    }
}
