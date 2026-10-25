import AppKit
import SwiftUI
import TaksimKit

/// What the agent sheet is open for: a new agent at a spot (a model and folder already picked, if any), or an
/// agent's settings.
enum AgentSheetContext: Identifiable {
    case add(at: CGPoint, model: String? = nil, cwd: String? = nil)
    case edit(id: String)
    var id: String { switch self { case .add(let p, _, _): "add-\(p.x)-\(p.y)"; case .edit(let id): "edit-\(id)" } }
}

/// A new agent, or an agent's settings, without a form's clutter: the CLI as logo tiles, then one aligned row
/// per choice with an icon for its label, the rarely changed ones behind ⋯, and one action. Everything starts
/// filled in (the last model, the canvas's folder and the account last used with that CLI).
struct AgentSheet: View {
    let store: CanvasStore
    let context: AgentSheetContext
    /// another account for a CLI: Settings › Hesaplar names it and signs it in
    var addAccount: (String) -> Void = { _ in }
    let onDone: (Agent?) -> Void

    @State private var name = ""
    @State private var role = ""
    @State private var backend = ""
    @State private var model = ""
    /// the thinking level; nil leaves it to the model's CLI
    @State private var effort: String?
    @State private var choosingModel = false
    @State private var account = ""
    @State private var readOnly = false
    @State private var cwd = ""
    @State private var branch = ""
    @State private var git: CanvasStore.GitInfo?
    @State private var system = ""
    @State private var autoApprove = false
    @State private var more = false
    @State private var error: String?
    @State private var busy = false
    @State private var dropping = false
    /// the chosen login is signed out (or its CLI isn't here): the one action signs it in, then creates
    @State private var signedOut = false
    /// each CLI's own login on this computer, read when the CLI is picked
    @State private var machine: [String: AccountsModel.Status] = [:]
    @State private var signer: AccountsModel?
    /// getting a local model going (the Local tile with none there yet): Ollama, then a model for this Mac
    @State private var local: LocalState?
    @FocusState private var nameFocused: Bool

    private var editing: Agent? { if case .edit(let id) = context { return store.agents[id] }; return nil }

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(JB.line).frame(height: 1)
            VStack(alignment: .leading, spacing: 16) {
                cliTiles
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 10) {
                    row("cpu", "Model") { if needsLocal { localWell } else { modelPicker } }
                    if let levels = currentModel?.efforts, !levels.isEmpty { row("brain", L("Thinking")) { effortMeter(levels) } }
                    // a local model has no account: it runs on this Mac
                    if backend != "local" { row(signedOut ? "person.crop.circle.badge.exclamationmark" : "person.crop.circle", L("Account"), tint: signedOut ? JB.warn : JB.muted) { accountPicker } }
                    row("folder", L("Folder")) { folderWell }
                    if let git, git.repo != nil { row("arrow.triangle.branch", "Branch") { branchField(git) } }
                    row("lock", L("Access")) { accessPicker }
                }
                moreSection
                if let l = signer?.login, l.backend == backend {
                    LoginTerminal(login: l, cancel: { signer?.cancel() }).transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .padding(20)
            .animation(.spring(response: 0.45, dampingFraction: 0.85), value: signer?.login == nil)
            Rectangle().fill(JB.line).frame(height: 1)
            footer
        }
        .frame(width: 460)
        .background(JB.panel)
        .tint(JB.accent)
        .task { await setup() }
        .task(id: "\(backend)|\(account)") { await checkSignIn() }
        .task(id: backend) {
            // the Local tile: watched while a model is being got (fast while something runs), to pick it once there
            while backend == "local", !Task.isCancelled {
                await refreshLocal()
                if !needsLocal { break }
                try? await Task.sleep(for: .seconds(local?.step == .busy ? 0.7 : 3))
            }
        }
        .onDisappear { signer?.cancel() }
        .task(id: cwd) { try? await Task.sleep(for: .milliseconds(300)); await loadBranches() }
        .onExitCommand { onDone(nil) }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
            Task { await store.loadChoices(); if account.isEmpty { account = rememberedAccount() } }
        }
    }

    // ---------- parts ----------

    /// the agent: its CLI's mark and its name, ready to type over
    private var header: some View {
        HStack(spacing: 12) {
            BackendTile(backend: backend.isEmpty ? "claude" : backend, size: 34)
                .animation(.spring(response: 0.35, dampingFraction: 0.7), value: backend)
            TextField("", text: $name, prompt: Text(editing?.name ?? L("Name")).foregroundStyle(JB.muted2))
                .textFieldStyle(.plain)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(JB.ink)
                .focused($nameFocused)
                .onSubmit { Task { await submit() } }
            Button { onDone(nil) } label: {
                Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).frame(width: 24, height: 24)
            }
            .buttonStyle(HeaderIconStyle()).help(L("Close (Esc)"))
        }
        .padding(.leading, 20).padding(.trailing, 12).frame(height: 64)
    }

    /// the CLIs as tiles; picking one picks its usual model
    private var cliTiles: some View {
        HStack(spacing: 8) {
            ForEach(tileBackends, id: \.self) { b in
                let on = b == backend
                Button { pick(backend: b) } label: {
                    VStack(spacing: 6) {
                        BackendTile(backend: b, size: 26).saturation(on ? 1 : 0.35).opacity(on ? 1 : 0.7)
                        Text(CanvasStore.label(of: b)).font(.system(size: 11, weight: on ? .semibold : .regular))
                            .foregroundStyle(on ? JB.ink : JB.muted).lineLimit(1)
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 8).fill(on ? JB.sel : JB.bg.opacity(0.5)))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(on ? JB.accent : JB.line))
                    .contentShape(Rectangle())
                }
                .buttonStyle(Press())
                .animation(.spring(response: 0.3, dampingFraction: 0.75), value: on)
            }
        }
    }

    /// the CLIs to pick from; Local is there before any local model is, so one can be got from here
    private var tileBackends: [String] {
        var list = store.backends.filter { $0 != "fake" || store.backends.count == 1 || backend == "fake" || ProcessInfo.processInfo.environment["TAKSIM_URL"] != nil }
        if !list.contains("local") { list.insert("local", at: list.firstIndex(of: "fake") ?? list.endIndex) }
        return list
    }

    /// Local is picked and no local model is there yet
    private var needsLocal: Bool { backend == "local" && modelsForBackend.isEmpty }

    /// in the model's place while none is there: Ollama's state, or the model this Mac gets and its download
    private var localWell: some View {
        WellLabel(opens: false) {
            if let st = local {
                switch st.step {
                case .install, .download, .start:
                    Circle().fill(st.ollama.installed ? JB.muted2 : JB.err).frame(width: 6, height: 6)
                    Text("Ollama").foregroundStyle(JB.ink)
                default:
                    Image(systemName: "arrow.down.circle").foregroundStyle(JB.muted)
                    Text(st.pull?.model ?? st.recommended.model).foregroundStyle(JB.ink)
                    Text(String(format: "%.1f GB", st.recommended.gb)).foregroundStyle(JB.muted2).monospacedDigit()
                    if let f = st.pull?.fraction, st.pull?.running == true {
                        ProgressView(value: f).progressViewStyle(.linear).tint(JB.accent).frame(maxWidth: 120)
                    }
                }
            } else {
                ProgressView().controlSize(.mini)
            }
        }
        .animation(.easeOut(duration: 0.2), value: local?.pull?.completed)
    }

    /// the footer's key while a local model is being got: what the next step is called
    private var localKey: String {
        guard let st = local else { return "…" }
        switch st.step {
        case .install: return L("Install Ollama")
        case .download: return L("Get Ollama")
        case .start: return L("Start Ollama")
        case .pull: return L("Download")
        case .ready: return L("Create")
        case .busy:
            if st.pull?.running == true { return L("Downloading %d%%", Int(((st.pull?.fraction ?? 0) * 100).rounded())) }
            return st.install?.running == true ? L("Installing") : L("Starting")
        }
    }

    /// the next step: install Ollama (or open its download page without Homebrew), start it, pull the model
    private func localStep() async {
        guard let st = local else { return }
        error = nil
        do {
            switch st.step {
            case .install: try await store.installOllama()
            case .download: if let u = URL(string: "https://ollama.com/download") { NSWorkspace.shared.open(u) }
            case .start: try await store.startOllama()
            case .pull(let m): try await store.pullLocalModel(m)
            case .ready, .busy: break
            }
        } catch { self.error = error.localizedDescription }
        await refreshLocal()
    }

    /// reads where it stands; once a model is there it is picked
    private func refreshLocal() async {
        guard let st = try? await store.localState() else { return }
        local = st
        if st.step == .ready, modelsForBackend.isEmpty {
            await store.loadChoices()
            if backend == "local", model.isEmpty || !modelsForBackend.contains(model) { pick(model: Self.usualModel("local", in: store.models) ?? "") }
        }
    }

    /// one row: an icon for a label (its name on hover), the control filling the rest
    private func row<C: View>(_ symbol: String, _ label: String, tint: Color = JB.muted, @ViewBuilder _ content: () -> C) -> some View {
        GridRow {
            Image(systemName: symbol).font(.system(size: 13)).foregroundStyle(tint)
                .frame(width: 18).help(label)
                .gridColumnAlignment(.center)
            content().frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: 28)
    }

    /// the model: its name and context in the well; the list below it says what each one is
    private var modelPicker: some View {
        Button { choosingModel.toggle() } label: {
            WellLabel {
                Text(currentModel?.display_name ?? (model.isEmpty ? "—" : model)).foregroundStyle(JB.ink)
                if let c = currentModel?.context_window { Text(Self.tokens(c)).foregroundStyle(JB.muted2).monospacedDigit() }
            }
        }
        .buttonStyle(Press())
        .popover(isPresented: $choosingModel, attachmentAnchor: .rect(.bounds), arrowEdge: .bottom) {
            ModelList(models: store.models.filter { $0.owned_by == backend }, selected: model) { m in
                choosingModel = false
                pick(model: m)
            }
        }
    }

    /// thinking levels as a meter, lowest to highest: tap a bar to pick it, tap it again for the model's default
    private func effortMeter(_ levels: [String]) -> some View {
        let fallback = currentModel?.default_effort
        let shown = effort ?? fallback
        let at = shown.flatMap { levels.firstIndex(of: $0) }
        return HStack(spacing: 10) {
            HStack(alignment: .bottom, spacing: 3) {
                ForEach(Array(levels.enumerated()), id: \.offset) { i, level in
                    let lit = at.map { i <= $0 } ?? false
                    Button { withAnimation(.spring(response: 0.3, dampingFraction: 0.75)) { effort = effort == level ? nil : level } } label: {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(lit ? (effort == nil ? JB.muted : JB.accent) : JB.line)
                            .frame(width: 14, height: 7 + CGFloat(i) * 3.5)
                            .frame(height: 26, alignment: .bottom)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(Press(scale: 0.9))
                    .help(Self.effortName(level))
                }
            }
            // muted while it is the model's own default
            Text(shown.map(Self.effortName) ?? L("default")).font(.system(size: 12.5))
                .foregroundStyle(effort == nil ? JB.muted : JB.ink)
                .contentTransition(.opacity)
                .help(effort == nil ? L("the model's default") : "")
            Spacer(minLength: 0)
        }
        .frame(height: 28)
    }

    @MainActor static func snapshotModels(_ s: CanvasStore, backend: String, to path: String) {
        Task { @MainActor in
            for _ in 0..<40 where s.models.isEmpty { try? await Task.sleep(for: .milliseconds(100)) }
            let host = NSHostingView(rootView: ModelList(models: s.models.filter { $0.owned_by == backend }.prefix(8).map { $0 },
                                                         selected: s.models.first { $0.owned_by == backend }?.id ?? "") { _ in })
            let w = NSWindow(contentRect: NSRect(x: -3000, y: 0, width: 380, height: 400), styleMask: [.borderless], backing: .buffered, defer: false)
            w.contentView = host
            w.appearance = NSAppearance(named: ProcessInfo.processInfo.environment["TAKSIM_SNAPSHOT_DARK"] == "1" ? .darkAqua : .aqua)
            w.orderFrontRegardless()
            try? await Task.sleep(for: .seconds(1))
            w.setContentSize(host.fittingSize)
            try? await Task.sleep(for: .milliseconds(300))
            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return }
            host.cacheDisplay(in: host.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
        }
    }

    static func effortName(_ e: String) -> String {
        ["minimal": L("Minimal"), "low": L("Low"), "medium": L("Medium"), "high": L("High"), "xhigh": L("Very high"), "max": L("Max"), "ultra": L("Ultra")][e] ?? e
    }

    /// 272000 → 272K, 1000000 → 1M
    static func tokens(_ n: Int) -> String {
        n >= 1_000_000 ? "\(n % 1_000_000 == 0 ? String(n / 1_000_000) : String(format: "%.1f", Double(n) / 1_000_000))M" : "\(n / 1000)K"
    }

    private var accountPicker: some View {
        let current = accountsForBackend.first { $0.id == account }
        return Menu {
            if !machineNamed, machineTwin == nil { Button { account = "" } label: { Label(machineLogin, systemImage: "person.crop.circle") } }
            ForEach(accountsForBackend) { a in
                Button(Self.accountLabel(a)) { account = a.id }
            }
            Divider()
            Button { Task { await addAccountThenPick() } } label: { Label(L("Add account"), systemImage: "plus") }
        } label: {
            WellLabel {
                if let current {
                    Text(current.name).foregroundStyle(JB.ink)
                    if let e = current.status?.email, e != current.name { Text(e).foregroundStyle(JB.muted2).lineLimit(1) }
                } else {
                    Text(machineLogin).foregroundStyle(JB.ink)
                }
            }
        }
        .menuStyle(.button).buttonStyle(Press()).menuIndicator(.hidden)
    }

    /// the folder: click to choose, or drop one from Finder
    private var folderWell: some View {
        let dir = cwd.trimmingCharacters(in: .whitespaces)
        return Button { pickFolder() } label: {
            HStack(spacing: 8) {
                Image(systemName: dir.isEmpty ? "folder.badge.plus" : "folder.fill").font(.system(size: 13))
                    .foregroundStyle(dir.isEmpty ? JB.muted : JB.accent)
                if dir.isEmpty {
                    Text("—").foregroundStyle(JB.muted2)
                } else {
                    Text((dir as NSString).lastPathComponent).foregroundStyle(JB.ink).lineLimit(1)
                    Text((dir as NSString).deletingLastPathComponent.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                        .foregroundStyle(JB.muted2).lineLimit(1).truncationMode(.head)
                }
                Spacer(minLength: 4)
                if !dir.isEmpty {
                    Button { cwd = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(JB.muted2) }
                        .buttonStyle(Press()).help(L("No folder"))
                }
            }
            .modifier(Well(highlight: dropping, dashed: dir.isEmpty))
        }
        .buttonStyle(Press())
        .help(dir.isEmpty ? L("Choose folder") : dir)
        .dropDestination(for: URL.self) { urls, _ in
            guard let u = urls.first(where: { $0.hasDirectoryPath }) ?? urls.first else { return false }
            cwd = u.hasDirectoryPath ? u.path : u.deletingLastPathComponent().path
            return true
        } isTargeted: { dropping = $0 }
    }

    /// the branch the folder will be on: its branches to pick, or a new name; switching shows current → new
    private func branchField(_ git: CanvasStore.GitInfo) -> some View {
        let cur = git.current ?? ""
        let b = branch.trimmingCharacters(in: .whitespaces)
        let switching = !b.isEmpty && b != cur
        let fresh = switching && !(git.branches ?? []).contains(b)
        // the list opens under the whole well, like the other menus: the menu spans the well, the field sits on it
        return ZStack {
            Menu {
                ForEach(git.branches ?? [], id: \.self) { name in Button(name) { branch = name } }
            } label: {
                WellLabel { Color.clear.frame(height: 1) }
            }
            .menuStyle(.button).buttonStyle(Press()).menuIndicator(.hidden)
            HStack(spacing: 8) {
            TextField("", text: $branch, prompt: Text(cur).foregroundStyle(JB.muted2))
                .textFieldStyle(.plain).font(.system(size: 12.5)).foregroundStyle(JB.ink)
            if switching {
                HStack(spacing: 4) {
                    Text(cur).foregroundStyle(JB.muted)
                    Image(systemName: "arrow.right").font(.system(size: 9, weight: .bold))
                    Image(systemName: fresh ? "plus.circle.fill" : "arrow.triangle.branch")
                }
                .font(.system(size: 11)).foregroundStyle(JB.warn)
                .help(fresh ? L("new branch") : "git checkout")
                .transition(.opacity.combined(with: .move(edge: .trailing)))
            }
            }
            .padding(.leading, 10).padding(.trailing, 30) // the chevron's end of the well opens the list
        }
        .frame(height: 28)
        .animation(.easeOut(duration: 0.2), value: switching)
    }

    /// two halves of one well: edits files and runs commands, or only reads
    private var accessPicker: some View {
        HStack(spacing: 2) {
            ForEach([(false, "pencil", L("Edits")), (true, "eye", L("Reads"))], id: \.0) { value, symbol, label in
                let on = readOnly == value
                Button { withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) { readOnly = value } } label: {
                    HStack(spacing: 6) { Image(systemName: symbol).font(.system(size: 11)); Text(label) }
                        .font(.system(size: 12.5, weight: on ? .semibold : .regular))
                        .foregroundStyle(on ? JB.ink : JB.muted)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(RoundedRectangle(cornerRadius: 4).fill(on ? JB.panel2 : .clear))
                        .contentShape(Rectangle())
                }
                .buttonStyle(Press())
            }
        }
        .padding(2)
        .frame(height: 28).frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 6).fill(JB.bg.opacity(0.6)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(JB.line))
    }

    /// what is rarely set: a role, extra instructions, panels running without asking
    private var moreSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { more.toggle() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold))
                        .rotationEffect(.degrees(more ? 90 : 0))
                    Image(systemName: "ellipsis")
                    if !more, hasMore { Circle().fill(JB.accent).frame(width: 5, height: 5) }
                }
                .foregroundStyle(JB.muted).frame(height: 18).contentShape(Rectangle())
            }
            .buttonStyle(Press()).help(L("Role, instructions, auto-approve"))
            if more {
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 10) {
                    row("theatermasks", L("Role")) {
                        TextField("", text: $role, prompt: Text(L("reviewer, writes tests…")).foregroundStyle(JB.muted2))
                            .textFieldStyle(.plain).foregroundStyle(JB.ink).modifier(Well())
                    }
                    row("text.alignleft", L("Extra instructions")) {
                        TextEditor(text: $system).font(.system(size: 12.5)).frame(height: 60)
                            .scrollContentBackground(.hidden).padding(4)
                            .background(RoundedRectangle(cornerRadius: 6).fill(JB.bg.opacity(0.6)))
                            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(JB.line))
                            .foregroundStyle(JB.ink)
                    }
                    row("bolt", L("Panel commands")) {
                        Toggle(L("Run without asking"), isOn: $autoApprove).toggleStyle(.switch).controlSize(.small)
                            .font(.system(size: 12.5)).foregroundStyle(JB.text)
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 10) {
            if let shown = error ?? (needsLocal ? local?.problem : nil) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(JB.err)
                Text(shown).font(.system(size: 12)).foregroundStyle(JB.err).lineLimit(2)
            }
            Spacer()
            // signed out: the same key signs the CLI in where it stands, then creates; for Local with no model yet it
            // takes the next step of getting one (install, start, download)
            let signing = signer?.login != nil || signer?.installing.contains(backend) == true || (needsLocal && local?.step == .busy)
            Button { Task { await (needsLocal ? localStep() : signedOut ? signInThenSubmit() : submit()) } } label: {
                HStack(spacing: 7) {
                    if signedOut || needsLocal {
                        if signing { ProgressView().controlSize(.mini) } else { BackendTile(backend: backend, size: 16) }
                    }
                    Text(needsLocal ? localKey : signedOut ? (signing ? L("Signing in") : L("Sign in")) : editing == nil ? L("Create") : L("Save"))
                        .monospacedDigit()
                }
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(JB.accentInk)
                .padding(.horizontal, 16).frame(height: 30)
                .background(RoundedRectangle(cornerRadius: 6).fill(JB.accent))
                .opacity(busy || signing || (model.isEmpty && !needsLocal) ? 0.5 : 1)
                .contentTransition(.opacity)
            }
            .buttonStyle(Press())
            .keyboardShortcut(.defaultAction)
            .disabled(busy || signing || (model.isEmpty && !needsLocal))
            .animation(.spring(response: 0.3, dampingFraction: 0.8), value: signedOut)
        }
        .padding(.horizontal, 20).frame(height: 56)
    }

    // ---------- choices ----------

    private var modelsForBackend: [String] { store.models.filter { $0.owned_by == backend }.map(\.id) }
    private var currentModel: CanvasStore.Model? { store.models.first { $0.id == model } }

    /// a model, with the thinking level last used with it (if it takes that one)
    private func pick(model m: String) {
        model = m
        let levels = store.models.first { $0.id == m }?.efforts ?? []
        let last = UserDefaults.standard.string(forKey: "lastEffort.\(m)")
        if let e = effort, levels.contains(e) { return }
        effort = last.flatMap { levels.contains($0) ? $0 : nil }
    }
    private var accountsForBackend: [CanvasStore.Account] { store.accounts.filter { $0.backend == backend } }
    /// the CLI's own login, named by the email it signed in with
    private var machineLogin: String { machineEmail ?? CanvasStore.label(of: backend) }
    private var machineEmail: String? { machine[backend]?.email ?? store.usageLogins["machine:\(backend)"]?.email }
    private var machineNamed: Bool { accountsForBackend.contains { $0.dir == nil } }
    /// an added account signed in as the CLI's own login stands for it: that login is listed once
    private var machineTwin: CanvasStore.Account? {
        guard let e = machineEmail?.lowercased() else { return nil }
        return accountsForBackend.first { $0.dir != nil && $0.status?.email?.lowercased() == e }
    }
    /// an added account: its name, and the email it signed in with when that says more
    static func accountLabel(_ a: CanvasStore.Account) -> String {
        guard let e = a.status?.email, e != a.name else { return a.name }
        return "\(a.name) · \(e)"
    }
    private var hasMore: Bool { !role.isEmpty || !system.isEmpty || autoApprove }

    /// a CLI's usual model (the one the server picks for it)
    static func usualModel(_ backend: String, in models: [CanvasStore.Model]) -> String? {
        models.first { $0.owned_by == backend && ["sonnet", "gpt-6-astra", "opencode-go/glm-5.3", "fake-echo"].contains($0.id) }?.id
            ?? models.first { $0.owned_by == backend }?.id
    }

    private func pick(backend b: String) {
        guard b != backend else { return }
        backend = b
        let last = UserDefaults.standard.string(forKey: "lastModel.\(b)")
        pick(model: last.flatMap { l in modelsForBackend.contains(l) ? l : nil } ?? Self.usualModel(b, in: store.models) ?? "")
        account = rememberedAccount()
    }

    private func rememberedAccount() -> String {
        let saved = UserDefaults.standard.string(forKey: "lastAccount.\(backend)") ?? ""
        if accountsForBackend.contains(where: { $0.id == saved }) { return saved }
        return machineNamed ? (accountsForBackend.first { $0.dir == nil }?.id ?? "") : (machineTwin?.id ?? "")
    }

    private func setup() async {
        if store.models.isEmpty { await store.loadChoices() } else {
            // the lists refresh behind the sheet; a remembered account deleted since then is let go
            Task { await store.loadChoices(); if !account.isEmpty, !accountsForBackend.contains(where: { $0.id == account }) { account = rememberedAccount() } }
        }
        if let a = editing {
            name = a.name; role = a.role ?? ""; model = a.model ?? ""; effort = a.effort; readOnly = a.sandbox == "read-only"
            system = a.system ?? ""; cwd = a.cwd ?? ""; autoApprove = a.autoApprove ?? false; account = a.account ?? ""
            backend = store.backendOf(model)
            more = !role.isEmpty || !system.isEmpty
        } else {
            let given: (model: String?, cwd: String?) = if case .add(_, let m, let c) = context { (m, c) } else { (nil, nil) }
            model = given.model ?? UserDefaults.standard.string(forKey: "lastModel") ?? "sonnet"
            backend = store.backendOf(model)
            if !store.models.contains(where: { $0.id == model }) { model = Self.usualModel(backend, in: store.models) ?? model }
            pick(model: model)
            // agents of one tab usually work in the same folder
            cwd = given.cwd ?? store.currentAgents.filter { $0.cwd != nil }.max { ($0.createdAt ?? 0) < ($1.createdAt ?? 0) }?.cwd ?? ""
            account = rememberedAccount()
        }
        nameFocused = true
    }

    /// whether the chosen login is signed in; unknown (a CLI without logins) counts as ready
    private func checkSignIn() async {
        guard !backend.isEmpty else { return }
        let b = backend, acct = account.isEmpty ? nil : account
        if machine[b] == nil, let st = try? await store.api.get("/v1/accounts/machine/\(b)", as: AccountsModel.Status.self), st.loggedIn == true {
            machine[b] = st
            if b == backend, account.isEmpty, let twin = machineTwin { account = twin.id; return }
        }
        let ready = await AccountsModel.ready(api: store.api, backend: b, account: acct)
        guard b == backend, acct == (account.isEmpty ? nil : account) else { return }
        signedOut = ready == false
    }

    /// signs the chosen login in (installing its CLI first when it isn't here), then creates the agent
    private func signInThenSubmit() async {
        let s = signer ?? AccountsModel(api: store.api)
        signer = s
        if s.backends.isEmpty { await s.load() }
        let b = backend
        if account.isEmpty {
            guard let cli = s.backends.first(where: { $0.name == b }) else { return }
            await s.signIn(cli)
        } else {
            if s.backends.first(where: { $0.name == b })?.installed != true, !(await s.install(b)) { return }
            await s.signIn(account: account, backend: b)
        }
        await store.loadChoices()
        // the machine login may have been named just now: pick it up
        if account.isEmpty { account = rememberedAccount() }
        await checkSignIn()
        if s.problem[b] != nil { error = s.problem[b] }
        if !signedOut { await submit() }
    }

    /// creates a new account for this CLI, signs it in with a terminal/OAuth right here in the sheet, and selects it
    private func addAccountThenPick() async {
        let s = signer ?? AccountsModel(api: store.api)
        signer = s
        if s.backends.isEmpty { await s.load() }
        let b = backend
        let beforeIds = Set(accountsForBackend.map(\.id))
        await s.add(backend: b, name: s.freeName(CanvasStore.label(of: b)))
        await store.loadChoices()
        if let added = accountsForBackend.first(where: { !beforeIds.contains($0.id) }) {
            account = added.id
        } else if account.isEmpty {
            account = rememberedAccount()
        }
        await checkSignIn()
        if s.problem[b] != nil { error = s.problem[b] }
    }

    private func loadBranches() async {
        let dir = cwd.trimmingCharacters(in: .whitespaces)
        git = dir.isEmpty ? nil : await store.git(dir)
        branch = git?.current ?? ""
    }

    private func pickFolder() {
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.canCreateDirectories = true
        if !cwd.isEmpty { p.directoryURL = URL(fileURLWithPath: (cwd as NSString).expandingTildeInPath) }
        if p.runModal() == .OK, let url = p.url { cwd = url.path }
    }

    private func submit() async {
        guard !busy, !model.isEmpty else { return }
        busy = true
        defer { busy = false }
        error = nil
        var fields: [String: Any] = ["role": role, "model": model, "system": system, "autoApprove": autoApprove]
        fields["effort"] = effort ?? NSNull()
        let n = name.trimmingCharacters(in: .whitespaces)
        if !n.isEmpty { fields["name"] = n }
        fields["account"] = account.isEmpty ? NSNull() : account
        fields["sandbox"] = readOnly ? "read-only" : NSNull()
        let dir = cwd.trimmingCharacters(in: .whitespaces)
        fields["cwd"] = dir.isEmpty ? NSNull() : dir
        // another branch picked: switch the folder first, as `git switch` would; back again if the agent then fails
        let b = branch.trimmingCharacters(in: .whitespaces)
        var switchedFrom: String?
        do {
            if let git, let cur = git.current, !b.isEmpty, b != cur { try await store.checkout(dir, branch: b); switchedFrom = cur }
            UserDefaults.standard.set(account, forKey: "lastAccount.\(backend)")
            UserDefaults.standard.set(model, forKey: "lastModel.\(backend)")
            UserDefaults.standard.set(effort, forKey: "lastEffort.\(model)")
            if let a = editing {
                try await store.updateAgent(a.id, fields)
                onDone(nil)
            } else {
                UserDefaults.standard.set(model, forKey: "lastModel")
                if case .add(let at, _, _) = context { fields["pos"] = [at.x.rounded(), at.y.rounded()] }
                for k in ["account", "sandbox", "cwd", "effort"] where fields[k] is NSNull { fields[k] = nil }
                onDone(try await store.addAgent(fields))
            }
        } catch {
            self.error = error.localizedDescription
            if let from = switchedFrom { try? await store.checkout(dir, branch: from) }
        }
    }
}

/// every row's control looks the same: 28 tall, full width, the canvas color, a hairline
private struct Well: ViewModifier {
    var highlight = false
    var dashed = false
    func body(content: Content) -> some View {
        content
            .font(.system(size: 12.5))
            .padding(.horizontal, 10).frame(height: 28).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 6).fill(highlight ? JB.sel : JB.bg.opacity(0.6)))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(highlight ? JB.accent : JB.line, style: StrokeStyle(lineWidth: 1, dash: dashed ? [4, 3] : [])))
            .contentShape(Rectangle())
    }
}

/// a menu's face as a well: what is chosen, and the up-down chevron at the end
private struct WellLabel<C: View>: View {
    /// the ⌃⌄ that says a list opens; a well that only shows something has none
    var opens = true
    @ViewBuilder let content: C
    var body: some View {
        HStack(spacing: 8) {
            content.lineLimit(1)
            Spacer(minLength: 4)
            if opens { Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(JB.muted) }
        }
        .modifier(Well())
    }
}

/// a CLI's models under the model well: each with its name, a line about it and its context window
struct ModelList: View {
    let models: [CanvasStore.Model]
    let selected: String
    let choose: (String) -> Void

    var body: some View {
        let rows = VStack(alignment: .leading, spacing: 1) {
            ForEach(models) { m in
                Hovering { hover in
                    Button { choose(m.id) } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Image(systemName: "checkmark").font(.system(size: 10, weight: .bold))
                                .foregroundStyle(JB.accent).opacity(m.id == selected ? 1 : 0).frame(width: 12)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(m.display_name ?? m.id).font(.system(size: 12.5, weight: m.id == selected ? .semibold : .regular))
                                    .foregroundStyle(JB.ink)
                                if let d = m.description {
                                    Text(d).font(.system(size: 11)).foregroundStyle(JB.muted).lineLimit(2)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            Spacer(minLength: 8)
                            if let e = m.efforts, !e.isEmpty {
                                Image(systemName: "brain").font(.system(size: 10)).foregroundStyle(JB.muted2)
                                    .help(e.map(AgentSheet.effortName).joined(separator: " · "))
                            }
                            if let c = m.context_window {
                                Text(AgentSheet.tokens(c)).font(.system(size: 11)).foregroundStyle(JB.muted2).monospacedDigit()
                            }
                        }
                        .padding(.horizontal, 10).padding(.vertical, 7)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 5).fill(hover ? JB.sel : .clear))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(Press())
                }
            }
        }
        .padding(6)
        SwiftUI.Group {
            if models.count > 8 { ScrollView { rows }.frame(height: 380) } else { rows }
        }
        .frame(width: 380)
        .background(JB.panel)
    }
}
