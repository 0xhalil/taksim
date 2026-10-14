import AppKit
import SwiftUI
import TaksimKit

// The first launch: what taksim is, shown as a short loop instead of words, then the coding CLIs as tiles
// that sign in where they stand, then one action (Start) that puts the first agent on the canvas.

/// The CLIs' sign-in state on this computer, and the login running in the welcome, if any.
@MainActor @Observable
final class AccountsModel {
    struct Backend: Decodable, Identifiable { var name: String; var label: String; var installed: Bool?; var id: String { name } }
    struct Account: Decodable, Identifiable {
        var id: String; var name: String; var backend: String; var dir: String?
        var status: Status?; var loggingIn: Bool?
    }
    struct Status: Decodable { var loggedIn: Bool?; var missing: Bool?; var email: String?; var plan: String? }
    struct LoginState: Decodable { var running: Bool; var done: Bool; var url: String?; var status: Status? }
    struct Login { var backend: String; var account: String; var terminal: AgentTerminal; var url: String?; var privately = false }

    let api: APIClient
    var backends: [Backend] = []
    var accounts: [Account] = []
    var machine: [String: Status] = [:]
    var login: Login?
    var justSignedIn: Set<String> = []
    var failed: Set<String> = []
    /// why the last try for a CLI failed, as the engine said it (a taken name, not installed…)
    var problem: [String: String] = [:]
    /// each login's plan usage, by account id or "machine:<cli>"
    var usage: [String: Usage] = [:]

    init(api: APIClient) { self.api = api }

    private struct List: Decodable { var accounts: [Account]; var backends: [Backend] }
    static let order = ["claude", "codex", "copilot", "opencode", "gemini", "fake"]

    func load() async {
        guard let l = try? await api.get("/v1/accounts", as: List.self) else { return }
        accounts = l.accounts
        backends = l.backends.sorted { (Self.order.firstIndex(of: $0.name) ?? 99) < (Self.order.firstIndex(of: $1.name) ?? 99) }
        await withTaskGroup(of: (String, Status?).self) { g in
            for b in backends where b.installed == true {
                g.addTask { [api] in (b.name, try? await api.get("/v1/accounts/machine/\(b.name)", as: Status.self)) }
            }
            for await (name, st) in g { if let st { machine[name] = st } }
        }
    }

    /// signed in on this computer, by its own login or by an account named for it
    func signedIn(_ backend: String) -> Status? {
        if let m = machine[backend], m.loggedIn == true { return m }
        return accounts.first { $0.backend == backend && $0.status?.loggedIn == true }?.status
    }

    /// signs this computer's login of a CLI in: names it after the CLI (rename later in Settings), then runs
    /// the CLI's own sign-in in a terminal and watches it until it lands
    func signIn(_ b: Backend) async {
        guard login == nil else { return }
        clear(b.name)
        var account = accounts.first { $0.backend == b.name && $0.dir == nil }
        if account == nil {
            account = await attempt(b.name) { try await self.api.post("/v1/accounts", ["name": self.freeName(b.label), "backend": b.name, "machine": true], as: Account.self) }
        }
        guard let a = account else { return }
        await signIn(account: a.id, backend: b.name)
    }

    /// a name nobody uses yet: "Claude Code", then "Claude Code 2", "Claude Code 3"…
    func freeName(_ base: String) -> String {
        var name = base, n = 2
        while accounts.contains(where: { $0.name.lowercased() == name.lowercased() }) { name = "\(base) \(n)"; n += 1 }
        return name
    }

    /// another account of a CLI, with its own config folder, signed in right away
    func add(backend: String, name: String) async {
        guard login == nil else { return }
        clear(backend)
        guard let a = await attempt(backend, { try await self.api.post("/v1/accounts", ["name": name, "backend": backend], as: Account.self) }) else { return }
        accounts.append(a)
        await signIn(account: a.id, backend: backend, privately: backend == "gemini")
    }

    func rename(_ id: String, to name: String) async {
        let b = accounts.first { $0.id == id }?.backend ?? ""
        clear(b)
        _ = await attempt(b) { try await self.api.patch("/v1/accounts/\(id)", ["name": name]) }
        await load()
    }

    func remove(_ id: String) async {
        let b = accounts.first { $0.id == id }?.backend ?? ""
        clear(b)
        _ = await attempt(b) { try await self.api.delete("/v1/accounts/\(id)") }
        await load()
    }

    private func clear(_ backend: String) { failed.remove(backend); problem[backend] = nil }
    /// a call whose failure marks the CLI and keeps the engine's reason
    private func attempt<T>(_ backend: String, _ call: () async throws -> T) async -> T? {
        do { return try await call() } catch {
            failed.insert(backend)
            problem[backend] = (error as? APIError)?.message ?? error.localizedDescription
            return nil
        }
    }

    /// what is known of each login's plan, then read again (Claude: a short check when nothing reported lately)
    func loadUsage() async {
        if let l = try? await api.get("/v1/usage", as: UsageList.self) { usage = l.usage.compactMapValues { $0 } }
        if let l = try? await api.post("/v1/usage/refresh", as: UsageList.self) { usage = l.usage.compactMapValues { $0 } }
    }
    func usage(of a: Account) -> Usage? { usage[a.dir == nil ? "machine:\(a.backend)" : a.id] }

    /// each account's sign-in, read from its CLI (the list only has what was read last)
    func refreshStatuses() async {
        await withTaskGroup(of: (String, Status?).self) { g in
            for a in accounts where a.loggingIn != true {
                g.addTask { [api] in (a.id, try? await api.get("/v1/accounts/\(a.id)/status", as: Status.self)) }
            }
            for await (id, st) in g { if let st, let i = accounts.firstIndex(where: { $0.id == id }) { accounts[i].status = st } }
        }
    }

    /// runs an account's sign-in in a terminal and watches it until it lands
    /// `privately`: the sign-in page opens in a private browser window instead of the default browser, so a
    /// Google account other than the one this computer's browser is signed in to can be used (a work Mac)
    func signIn(account id: String, backend: String, privately: Bool = false) async {
        guard login == nil else { return }
        clear(backend)
        guard await attempt(backend, { try await self.api.post("/v1/accounts/\(id)/login", ["private": privately], as: LoginState.self) }) != nil else { return }
        let t = AgentTerminal(base: api.base, path: "/term/account/\(id)")
        login = Login(backend: backend, account: id, terminal: t, privately: privately)
        var opened = false
        var misses = 0
        while let l = login, l.account == id {
            try? await Task.sleep(for: .seconds(1))
            let s: LoginState
            do { s = try await api.get("/v1/accounts/\(id)/login", as: LoginState.self); misses = 0 } catch {
                // the account was deleted, or the engine is gone: stop watching instead of waiting forever
                misses += 1
                if (error as? APIError)?.status == 404 || misses >= 5 { finish(l, ok: false) }
                continue
            }
            login?.url = s.url
            if privately, !opened, let u = s.url, let url = URL(string: u) { opened = true; PrivateBrowser.open(url) }
            if s.done {
                try? await Task.sleep(for: .milliseconds(900)) // the CLI's own "signed in" stays readable a moment
                finish(l, ok: true)
                await load()
                await refreshStatuses()
            } else if !s.running {
                finish(l, ok: false)
            }
        }
    }

    /// signs a Gemini account in with an API key; the engine checks it with Google first
    func setKey(_ id: String, backend: String, key: String) async -> Bool {
        clear(backend)
        guard await attempt(backend, { try await self.api.put("/v1/accounts/\(id)/api-key", ["key": key], as: Status.self) }) != nil else { return false }
        await load()
        await refreshStatuses()
        justSignedIn.insert(backend)
        return true
    }

    func cancel() {
        guard let l = login else { return }
        Task { _ = try? await api.delete("/v1/accounts/\(l.account)/login") }
        finish(l, ok: false, quiet: true)
    }

    private func finish(_ l: Login, ok: Bool, quiet: Bool = false) {
        l.terminal.close()
        withAnimation(.spring(response: 0.45, dampingFraction: 0.75)) {
            login = nil
            if ok { justSignedIn.insert(l.backend) } else if !quiet { failed.insert(l.backend) }
        }
    }
}

struct WelcomeView: View {
    let model: AppModel
    var autoLogin: String? = nil
    @State private var accounts: AccountsModel?
    @State private var shown = false

    var body: some View {
        ZStack {
            Color.black.opacity(shown ? 0.45 : 0).ignoresSafeArea()
            VStack(spacing: 0) {
                StoryView().frame(height: accounts?.login == nil ? 250 : 120).clipShape(UnevenRoundedRectangle(topLeadingRadius: 14, topTrailingRadius: 14))
                Rectangle().fill(JB.line).frame(height: 1)
                VStack(spacing: 18) {
                    if let accounts { CLITiles(accounts: accounts) } else { ProgressView().controlSize(.small).frame(height: 120) }
                    if let l = accounts?.login { LoginTerminal(login: l, cancel: { accounts?.cancel() }).transition(.move(edge: .bottom).combined(with: .opacity)) }
                    startButton
                }
                .padding(.horizontal, 28).padding(.vertical, 22)
            }
            .frame(width: 720)
            .animation(.spring(response: 0.45, dampingFraction: 0.85), value: accounts?.login == nil)
            .background(RoundedRectangle(cornerRadius: 14).fill(JB.panel))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(JB.line))
            .overlay(alignment: .topTrailing) {
                Button { close() } label: { Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).frame(width: 26, height: 26) }
                    .buttonStyle(HeaderIconStyle()).padding(10).help(L("Close"))
            }
            .shadow(color: .black.opacity(0.35), radius: 30, y: 12)
            .scaleEffect(shown ? 1 : 0.94)
            .opacity(shown ? 1 : 0)
        }
        .onAppear {
            withAnimation(.spring(response: 0.5, dampingFraction: 0.8)) { shown = true }
            if let api = model.store?.api, accounts == nil {
                let a = AccountsModel(api: api); accounts = a
                Task {
                    await a.load()
                    if let b = a.backends.first(where: { $0.name == autoLogin }) { await a.signIn(b) }
                }
            }
        }
        .onExitCommand { close() }
    }

    private var ready: String? { accounts?.backends.first { accounts?.signedIn($0.name) != nil && $0.name != "fake" }?.name
        ?? accounts?.backends.first { accounts?.signedIn($0.name) != nil }?.name }

    /// the one action: an agent on the first signed-in CLI, its terminal open
    private var startButton: some View {
        Button { start() } label: {
            HStack(spacing: 7) {
                if let r = ready { BackendTile(backend: r, size: 18) }
                Text(L("Start")).font(.system(size: 14, weight: .semibold))
                Image(systemName: "arrow.right").font(.system(size: 12, weight: .bold))
            }
            .foregroundStyle(JB.accentInk)
            .padding(.horizontal, 18).frame(height: 36)
            .background(Capsule().fill(JB.accent))
            .opacity(ready == nil ? 0.4 : 1)
        }
        .buttonStyle(Press())
        .disabled(ready == nil || accounts?.login != nil)
        .keyboardShortcut(.defaultAction)
        .animation(.spring(response: 0.4, dampingFraction: 0.7), value: ready)
    }

    private func start() {
        guard let store = model.store, let backend = ready else { return }
        close()
        guard store.currentAgents.isEmpty else { return }
        Task {
            await store.loadChoices()
            let m = store.models.first { $0.owned_by == backend && ($0.id == "sonnet" || backend != "claude") }?.id
                ?? store.models.first { $0.owned_by == backend }?.id ?? "sonnet"
            var fields: [String: Any] = ["model": m]
            let at = model.viewCenter()
            fields["pos"] = [at.x.rounded(), at.y.rounded()]
            if let a = try? await store.addAgent(fields) { model.agentAdded(a) }
        }
    }

    private func close() {
        accounts?.cancel()
        UserDefaults.standard.set(true, forKey: "welcomed")
        withAnimation(.spring(response: 0.35, dampingFraction: 0.9)) { shown = false }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { model.showWelcome = false }
    }
}

/// one tile per coding CLI: its mark, its name, and what it needs — nothing (signed in), a sign-in, or installing
struct CLITiles: View {
    let accounts: AccountsModel
    var body: some View {
        HStack(spacing: 12) {
            ForEach(accounts.backends.filter { $0.name != "fake" || accounts.backends.count == 1 || ProcessInfo.processInfo.environment["TAKSIM_URL"] != nil }) { b in
                CLITile(backend: b, accounts: accounts)
            }
        }
    }
}

private struct CLITile: View {
    let backend: AccountsModel.Backend
    let accounts: AccountsModel
    @State private var hover = false

    var body: some View {
        let st = accounts.signedIn(backend.name)
        let installed = backend.installed == true
        let active = accounts.login?.backend == backend.name
        VStack(spacing: 10) {
            BackendTile(backend: backend.name, size: 40)
                .saturation(installed ? 1 : 0).opacity(installed ? 1 : 0.45)
                .overlay(alignment: .bottomTrailing) {
                    if st != nil {
                        Image(systemName: "checkmark.circle.fill").font(.system(size: 16)).foregroundStyle(JB.ok)
                            .background(Circle().fill(JB.panel).padding(1)).offset(x: 6, y: 6)
                            .transition(.scale(scale: 0.2).combined(with: .opacity))
                    }
                }
                .scaleEffect(accounts.justSignedIn.contains(backend.name) ? 1.08 : 1)
            Text(backend.label).font(.system(size: 12.5, weight: .medium)).foregroundStyle(JB.ink).lineLimit(1)
            Group {
                if let st {
                    Text(st.email ?? st.plan ?? " ").font(.system(size: 11)).foregroundStyle(JB.muted).lineLimit(1).truncationMode(.middle)
                        .padding(.horizontal, 8)
                } else if !installed {
                    Image(systemName: "arrow.down.circle").font(.system(size: 15)).foregroundStyle(JB.muted).help(L("not installed"))
                } else if active {
                    ProgressView().controlSize(.small)
                } else {
                    Button { Task { await accounts.signIn(backend) } } label: {
                        Text(L("Sign in")).font(.system(size: 12, weight: .semibold)).foregroundStyle(JB.accentInk)
                            .padding(.horizontal, 12).frame(height: 24)
                            .background(Capsule().fill(accounts.failed.contains(backend.name) ? JB.err : JB.accent))
                    }
                    .buttonStyle(Press()).disabled(accounts.login != nil)
                }
            }
            .frame(height: 24)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
        .background(RoundedRectangle(cornerRadius: 10).fill(active ? JB.sel : hover ? JB.panel2 : JB.bg.opacity(0.5)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(active ? JB.accent : JB.line))
        .onHover { hover = $0 }
        .animation(.spring(response: 0.45, dampingFraction: 0.7), value: st != nil)
        .animation(.easeOut(duration: 0.2), value: hover)
    }
}

/// the CLI's own sign-in, in a terminal under the tiles; the browser page it opened, as one button
struct LoginTerminal: View {
    let login: AccountsModel.Login
    let cancel: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                BackendTile(backend: login.backend, size: 16)
                Text(L("Login — %@", login.account.isEmpty ? login.backend : login.account))
                    .font(.system(size: 11.5, weight: .medium)).foregroundStyle(JB.text).lineLimit(1).truncationMode(.middle)
                Spacer()
                if let u = login.url, let url = URL(string: u) {
                    Button { if login.privately { PrivateBrowser.open(url) } else { NSWorkspace.shared.open(url) } } label: {
                        Image(systemName: login.privately ? "eye.slash" : "safari").font(.system(size: 13)).frame(width: 26, height: 22)
                    }
                    .buttonStyle(HeaderIconStyle()).help(login.privately ? L("Open in a private window") : u)
                }
                Button(action: cancel) { Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).frame(width: 26, height: 22) }
                    .buttonStyle(HeaderIconStyle()).help(L("Cancel"))
            }
            .padding(.horizontal, 8).frame(height: 32)
            .background(JB.nodeHead)
            TermHost(terminal: login.terminal).frame(height: 190)
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(JB.line))
    }
}

/// a server terminal's view, filling its SwiftUI frame 1:1 and taking the keyboard
struct TermHost: NSViewRepresentable {
    let terminal: AgentTerminal
    func makeNSView(context: Context) -> Holder { Holder(terminal: terminal) }
    func updateNSView(_ v: Holder, context: Context) { v.needsLayout = true }
    final class Holder: NSView {
        let terminal: AgentTerminal
        init(terminal: AgentTerminal) { self.terminal = terminal; super.init(frame: .zero); addSubview(terminal.box) }
        required init?(coder: NSCoder) { fatalError() }
        override func layout() {
            super.layout()
            terminal.box.place(screen: bounds, graphSize: bounds.size)
        }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
                guard let self else { return }
                self.window?.makeFirstResponder(self.terminal.box.term)
            }
        }
    }
}

/// taksim in eight seconds, without a word: agents appear on the canvas, talk (a pulse runs along the
/// arrow), get grouped (the frame closes in around them), and one opens a panel with a live chart
struct StoryView: View {
    static let loop: Double = 8.5
    var body: some View {
        TimelineView(.animation) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: Self.loop)
            Canvas { ctx, size in draw(&ctx, size, t) }
        }
        .background(JB.bg)
    }

    private func ease(_ x: Double) -> Double { let c = min(1, max(0, x)); return 1 - pow(1 - c, 3) }
    /// a spring that overshoots a little (the canvas's ease-out-back)
    private func back(_ x: Double) -> Double { let c = min(1, max(0, x)), s = 1.70158; return 1 + (s + 1) * pow(c - 1, 3) + s * pow(c - 1, 2) }
    private func phase(_ t: Double, _ a: Double, _ d: Double) -> Double { min(1, max(0, (t - a) / d)) }

    private func draw(_ ctx: inout GraphicsContext, _ size: CGSize, _ t: Double) {
        let fade = t > Self.loop - 0.6 ? 1 - ease((t - (Self.loop - 0.6)) / 0.6) : 1
        // dot grid
        let grid = Path { p in
            var x: CGFloat = 12
            while x < size.width { var y: CGFloat = 12; while y < size.height { p.addEllipse(in: CGRect(x: x, y: y, width: 1.6, height: 1.6)); y += 20 }; x += 20 }
        }
        ctx.fill(grid, with: .color(JB.grid))
        ctx.opacity = fade

        let cx = size.width / 2, cy = size.height / 2
        let card = CGSize(width: 132, height: 64)
        let nodes: [(String, CGPoint, Double)] = [
            ("claude", CGPoint(x: cx - 210, y: cy - 58), 0.2),
            ("codex", CGPoint(x: cx - 30, y: cy - 58), 1.1),
            ("gemini", CGPoint(x: cx - 120, y: cy + 34), 2.0),
        ]
        // the group frame closes in around the three
        let g = phase(t, 3.2, 0.9)
        if g > 0 {
            let tight = CGRect(x: cx - 240, y: cy - 104, width: 372, height: 186)
            let k = 1 - back(g)
            let r = tight.insetBy(dx: -40 * k, dy: -30 * k)
            let frame = Path(roundedRect: r, cornerRadius: 10)
            ctx.fill(frame, with: .color(JB.accent.opacity(0.07 * g)))
            ctx.stroke(frame, with: .color(JB.accent.opacity(0.45 * g)), lineWidth: 1)
            ctx.fill(Path(ellipseIn: CGRect(x: r.minX + 11, y: r.minY + 11, width: 5, height: 5)), with: .color(JB.accent.opacity(g)))
        }
        // arrows with a message pulse running along each
        let links: [(Int, Int, Double)] = [(0, 1, 1.6), (1, 2, 2.5), (2, 0, 4.4)]
        for (a, b, at) in links {
            let p = phase(t, at, 0.4)
            guard p > 0 else { continue }
            let (from, to) = edge(nodes[a].1, nodes[b].1, card)
            let end = CGPoint(x: from.x + (to.x - from.x) * ease(p), y: from.y + (to.y - from.y) * ease(p))
            var line = Path(); line.move(to: from); line.addLine(to: end)
            ctx.stroke(line, with: .color(JB.muted.opacity(0.8)), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            if p >= 1 { arrowHead(&ctx, from, to) }
            let q = phase(t, at + 0.35, 0.9)
            if q > 0 && q < 1 {
                let pt = CGPoint(x: from.x + (to.x - from.x) * ease(q), y: from.y + (to.y - from.y) * ease(q))
                ctx.fill(Path(ellipseIn: CGRect(x: pt.x - 4, y: pt.y - 4, width: 8, height: 8)), with: .color(JB.backend(nodes[a].0)))
            }
        }
        // the cards
        for (i, n) in nodes.enumerated() {
            let p = phase(t, n.2, 0.5)
            guard p > 0 else { continue }
            let s = back(p)
            let r = CGRect(x: n.1.x, y: n.1.y, width: card.width, height: card.height)
            var c = ctx
            c.opacity = fade * p
            c.translateBy(x: r.midX, y: r.midY); c.scaleBy(x: 0.7 + 0.3 * s, y: 0.7 + 0.3 * s); c.translateBy(x: -r.midX, y: -r.midY)
            let body = Path(roundedRect: r, cornerRadius: 8)
            c.fill(body, with: .color(JB.nodeBody))
            c.fill(Path(roundedRect: CGRect(x: r.minX, y: r.minY, width: r.width, height: 22), cornerRadius: 8), with: .color(JB.nodeHead))
            c.stroke(body, with: .color(JB.line), lineWidth: 1)
            c.fill(Path(roundedRect: CGRect(x: r.minX + 6, y: r.minY + 4, width: 14, height: 14), cornerRadius: 3.5), with: .color(JB.backend(n.0)))
            if let d = Logos.paths[n.0] {
                c.fill(Path(SVGPath.parse(d)).applying(CGAffineTransform(scaleX: 10 / 24, y: 10 / 24).concatenating(CGAffineTransform(translationX: r.minX + 8, y: r.minY + 6))), with: .color(.white))
            } else {
                var prompt = Path()
                prompt.move(to: CGPoint(x: r.minX + 9.5, y: r.minY + 8)); prompt.addLine(to: CGPoint(x: r.minX + 12.5, y: r.minY + 11)); prompt.addLine(to: CGPoint(x: r.minX + 9.5, y: r.minY + 14))
                prompt.move(to: CGPoint(x: r.minX + 13.5, y: r.minY + 14)); prompt.addLine(to: CGPoint(x: r.minX + 16.5, y: r.minY + 14))
                c.stroke(prompt, with: .color(.white), style: StrokeStyle(lineWidth: 1.3, lineCap: .round, lineJoin: .round))
            }
            c.fill(Path(roundedRect: CGRect(x: r.minX + 26, y: r.minY + 9, width: 44, height: 4), cornerRadius: 2), with: .color(JB.text))
            // typing lines while it works
            let work = phase(t, n.2 + 0.4, 1.2)
            for k in 0..<3 {
                let w = (r.width - 20) * CGFloat(min(1, max(0, work * 3 - Double(k)))) * [0.9, 0.7, 0.5][k]
                c.fill(Path(roundedRect: CGRect(x: r.minX + 10, y: r.minY + 30 + CGFloat(k) * 9, width: w, height: 3.5), cornerRadius: 1.75), with: .color(JB.muted.opacity(0.7)))
            }
            // a working dot
            let breathe = 0.5 + 0.5 * sin(t * 4 + Double(i))
            c.fill(Path(ellipseIn: CGRect(x: r.maxX - 14, y: r.minY + 8, width: 6, height: 6)), with: .color(JB.ok.opacity(0.4 + 0.6 * breathe)))
        }
        // the panel slides out of codex with a live chart
        let pp = phase(t, 4.9, 0.6)
        if pp > 0 {
            let host = nodes[1].1
            let w: CGFloat = 170, h: CGFloat = 112
            let x0 = host.x + card.width + 14
            let r = CGRect(x: x0 - 30 * (1 - back(pp)), y: host.y, width: w, height: h)
            var c = ctx
            c.opacity = fade * pp
            let panel = Path(roundedRect: r, cornerRadius: 8)
            c.fill(panel, with: .color(JB.panel))
            c.stroke(panel, with: .color(JB.line), lineWidth: 1)
            c.fill(Path(roundedRect: CGRect(x: r.minX, y: r.minY, width: r.width, height: 18), cornerRadius: 8), with: .color(JB.panel2))
            c.fill(Path(ellipseIn: CGRect(x: r.minX + 8, y: r.minY + 6, width: 6, height: 6)), with: .color(JB.ok))
            // the line draws itself from left to right, then keeps moving
            let plot = CGRect(x: r.minX + 10, y: r.minY + 30, width: r.width - 20, height: r.height - 42)
            let drawn = phase(t, 5.3, 1.4)
            var line = Path(), area = Path()
            let steps = 40
            for k in 0...steps {
                let fx = Double(k) / Double(steps)
                guard fx <= drawn else { break }
                let v = 0.5 + 0.28 * sin(fx * 7 + t * 1.6) + 0.12 * sin(fx * 19 + t * 3)
                let pt = CGPoint(x: plot.minX + plot.width * fx, y: plot.maxY - plot.height * v)
                if k == 0 { line.move(to: pt); area.move(to: CGPoint(x: pt.x, y: plot.maxY)); area.addLine(to: pt) } else { line.addLine(to: pt); area.addLine(to: pt) }
                if k == steps || Double(k + 1) / Double(steps) > drawn { area.addLine(to: CGPoint(x: pt.x, y: plot.maxY)); area.closeSubpath()
                    c.fill(Path(ellipseIn: CGRect(x: pt.x - 3, y: pt.y - 3, width: 6, height: 6)), with: .color(JB.accent)) }
            }
            c.fill(area, with: .linearGradient(Gradient(colors: [JB.accent.opacity(0.28), JB.accent.opacity(0)]), startPoint: CGPoint(x: 0, y: plot.minY), endPoint: CGPoint(x: 0, y: plot.maxY)))
            c.stroke(line, with: .color(JB.accent), style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round))
        }
    }

    private func edge(_ a: CGPoint, _ b: CGPoint, _ s: CGSize) -> (CGPoint, CGPoint) {
        let ca = CGPoint(x: a.x + s.width / 2, y: a.y + s.height / 2), cb = CGPoint(x: b.x + s.width / 2, y: b.y + s.height / 2)
        func out(_ c: CGPoint, toward o: CGPoint) -> CGPoint {
            let dx = o.x - c.x, dy = o.y - c.y
            let k = min(abs(s.width / 2 / max(abs(dx), 0.001)), abs(s.height / 2 / max(abs(dy), 0.001))) + 6 / max(hypot(dx, dy), 1)
            return CGPoint(x: c.x + dx * k, y: c.y + dy * k)
        }
        return (out(ca, toward: cb), out(cb, toward: ca))
    }

    private func arrowHead(_ ctx: inout GraphicsContext, _ from: CGPoint, _ to: CGPoint) {
        let ang = atan2(to.y - from.y, to.x - from.x)
        var p = Path()
        p.move(to: to)
        p.addLine(to: CGPoint(x: to.x - 9 * cos(ang - 0.4), y: to.y - 9 * sin(ang - 0.4)))
        p.move(to: to)
        p.addLine(to: CGPoint(x: to.x - 9 * cos(ang + 0.4), y: to.y - 9 * sin(ang + 0.4)))
        ctx.stroke(p, with: .color(JB.muted), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
    }
}

/// A page in a private window: Chrome's incognito when Chrome is here, else Safari, which macOS can't be told to
/// open privately (the link is then also on the clipboard, for a private window opened by hand)
enum PrivateBrowser {
    static func open(_ url: URL) {
        let ws = NSWorkspace.shared
        for id in ["com.google.Chrome", "com.brave.Browser", "com.microsoft.edgemac", "com.google.Chrome.canary"] {
            guard let app = ws.urlForApplication(withBundleIdentifier: id) else { continue }
            let flag = id == "com.microsoft.edgemac" ? "--inprivate" : "--incognito"
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            p.arguments = ["-na", app.path, "--args", flag, url.absoluteString]
            if (try? p.run()) != nil { return }
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url.absoluteString, forType: .string)
        ws.open(url)
    }
}
