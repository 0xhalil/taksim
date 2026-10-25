import Foundation
import Observation

/// The app's state: the canvases (tabs), the open canvas and what's on it, kept current by the canvas's
/// event stream. The Swift counterpart of ui/canvas/app.mjs (state + onEvent).
@MainActor @Observable
public final class CanvasStore {
    public let api: APIClient
    public private(set) var canvases: [CanvasSummary] = []
    public private(set) var lockedTabs: Set<String>
    @ObservationIgnored let preferences: UserDefaults
    public private(set) var closedTabs: Set<String> = []
    public var visibleCanvases: [CanvasSummary] { canvases.filter { !closedTabs.contains($0.id) } }
    public private(set) var currentId: String?
    /// the open canvas's agents (kept per canvas in spaces)
    public internal(set) var agents: [String: Agent] {
        get { currentId.map { agents(on: $0).all } ?? [:] }
        set { if let id = currentId { agents(on: id).all = newValue } }
    }
    @ObservationIgnored private var spaces: [String: CanvasAgents] = [:]
    /// one canvas's agents, watched apart from the other canvases': a chat reads its own canvas's, so switching tabs
    /// or a stream on another canvas doesn't draw it again (SwitchBenchTests)
    public func agents(on canvas: String) -> CanvasAgents {
        if let s = spaces[canvas] { return s }
        let s = CanvasAgents()
        spaces[canvas] = s
        return s
    }
    public internal(set) var order: [String] = []        // agent ids in the order they came
    public private(set) var groups: [String: Group] = [:]
    /// agent id -> its computer control (only agents that have it or ask for it)
    public private(set) var computer: [String: ComputerControl] = [:]
    /// per agent: the latest "show this" of its IDE (ide_open), and the files that changed on disk since
    public var ideReveals: [String: IDEReveal] = [:]
    public var ideDiskChanges: [String: IDEDiskChange] = [:]
    /// per agent: a file whose Fark view should come up once its dock is there (a chat's changed file, clicked)
    public var wantedDiffs: [String: WantedDiff] = [:]
    public private(set) var links: [Link] = []
    public private(set) var streaming: [String: String] = [:] // agent id -> text streaming in this turn
    public private(set) var connected = false
    /// true once the stream was up: a later drop shows as lost (red), not as connecting (gray)
    public private(set) var everConnected = false
    public var error: String?
    /// every panel's data (the panel stream), per agent
    @ObservationIgnored public let feeds = PanelFeeds()
    /// a saved tool offered next to an agent that has no panel yet (tool_suggested): drawn as a ghost panel
    public private(set) var ghosts: [String: ToolCard] = [:]
    /// the open canvas's repos, branch sets and active set (BranchSets.swift); each canvas's last known, kept for its tab
    public internal(set) var branches: BranchState?
    public internal(set) var branchSwitching = false
    public internal(set) var branchError: String?
    @ObservationIgnored var branchCache: [String: BranchState] = [:]

    /// every event after it is applied, for what the view animates (a message pulses along its link)
    @ObservationIgnored public var onEvent: ((ServerEvent) -> Void)?
    /// more listeners besides the canvas's own (notifications, the Dock badge)
    @ObservationIgnored public var listeners: [(ServerEvent) -> Void] = []
    @ObservationIgnored var stream: Task<Void, Never>?
    @ObservationIgnored var panelStream: Task<Void, Never>?
    @ObservationIgnored var poll: Task<Void, Never>?

    public init(api: APIClient, preferences: UserDefaults = .standard) {
        self.api = api
        self.preferences = preferences
        lockedTabs = Set(preferences.stringArray(forKey: "lockedCanvasTabs") ?? [])
    }

    public func toggleTabLock(_ id: String) {
        if lockedTabs.contains(id) { lockedTabs.remove(id) } else { lockedTabs.insert(id) }
        preferences.set(lockedTabs.sorted(), forKey: "lockedCanvasTabs")
    }

    public func closeTabs(_ requested: Set<String>, ordered: [String]) async {
        let plan = TabClosePlan(requested: requested, ordered: ordered, locked: lockedTabs, current: currentId)
        closedTabs.formUnion(plan.closing)
        scheduleDelete(plan.closing)
        guard let current = currentId, plan.closing.contains(current) else { return }
        await closeTab(current, next: plan.next)
    }

    // ---------- closing is deleting, after a moment to take it back ----------

    /// the tabs closed last, still on the server for a moment: Geri al brings them back
    public private(set) var undoable: [CanvasSummary] = []
    private var pendingDeletes: [String: Task<Void, Never>] = [:]
    /// how long a closed canvas can still be brought back
    public static let undoSeconds = 6.0

    private func scheduleDelete(_ ids: Set<String>) {
        guard !ids.isEmpty else { return }
        undoable = canvases.filter { ids.contains($0.id) }
        for id in ids {
            pendingDeletes[id]?.cancel()
            pendingDeletes[id] = Task { [weak self] in
                try? await Task.sleep(for: .seconds(Self.undoSeconds))
                guard !Task.isCancelled else { return }
                await self?.purge(id)
            }
        }
    }

    /// the canvas goes from the server: its agents stop, their terminals close, its files are removed
    private func purge(_ id: String) async {
        pendingDeletes[id] = nil
        undoable.removeAll { $0.id == id }
        guard closedTabs.contains(id) else { return }
        do {
            try await api.delete("/v1/canvases/\(id)")
            canvases.removeAll { $0.id == id }
            closedTabs.remove(id)
        } catch { self.error = error.localizedDescription }
    }

    /// Geri al: the tabs closed last come back, the first of them in front
    public func undoClose() async {
        let back = undoable
        undoable = []
        for c in back { pendingDeletes[c.id]?.cancel(); pendingDeletes[c.id] = nil; closedTabs.remove(c.id) }
        if let first = back.first { await open(first.id) }
    }

    /// quitting: what waits to be deleted is deleted now (at most a second; the app is going away)
    public func purgeNow() {
        let ids = Array(pendingDeletes.keys).filter { closedTabs.contains($0) }
        for t in pendingDeletes.values { t.cancel() }
        pendingDeletes = [:]
        let group = DispatchGroup()
        for id in ids {
            var req = URLRequest(url: api.base.appending(path: "/v1/canvases/\(id)"))
            req.httpMethod = "DELETE"
            req.timeoutInterval = 1
            group.enter()
            URLSession.shared.dataTask(with: req) { _, _, _ in group.leave() }.resume()
        }
        _ = group.wait(timeout: .now() + 1)
    }

    public var currentAgents: [Agent] { order.compactMap { agents[$0] } }

    /// the node just pressed comes to the front: later in the order is nearer the eye
    public func raise(_ id: String) {
        guard order.last != id, let i = order.firstIndex(of: id) else { return }
        order.remove(at: i)
        order.append(id)
    }

    /// Loads the tab list and opens a canvas (the remembered one, else the first; makes one if there are none).
    public func start(prefer: String?) async {
        do {
            var list = try await api.get("/v1/canvases", as: CanvasList.self).canvases
            if list.isEmpty {
                let c: Canvas = try await api.post("/v1/canvases", ["name": Self.nextTabName(open: []), "autoName": true], as: Canvas.self)
                list = [CanvasSummary(id: c.id, name: c.name, agents: 0, busy: 0)]
            }
            canvases = list
            let id = list.contains(where: { $0.id == prefer }) ? prefer! : list[0].id
            await open(id)
            // the other tabs read ahead, so the first visit to one shows it at once too
            for c in list where c.id != id && visited[c.id] == nil {
                if let full = try? await api.get("/v1/canvases/\(c.id)", as: Canvas.self), visited[c.id] == nil { visited[c.id] = full }
            }
        } catch { self.error = error.localizedDescription }
        startPolling()
    }

    /// each visited canvas as it was last seen, so switching back shows it at once (the server then catches up)
    @ObservationIgnored private var visited: [String: Canvas] = [:]

    public func open(_ id: String) async {
        closedTabs.remove(id)
        guard id != currentId else { return }
        stream?.cancel()
        panelStream?.cancel()
        if let cur = currentId {
            visited[cur] = Canvas(id: cur, name: canvases.first { $0.id == cur }?.name ?? "", agents: currentAgents, links: links, groups: Array(groups.values), seq: nil)
        }
        if let seen = visited[id] { load(seen) } else { currentId = id; agents = [:]; order = []; groups = [:]; links = [] }
        branches = branchCache[id]
        branchError = nil
        do {
            let c: Canvas = try await api.get("/v1/canvases/\(id)", as: Canvas.self)
            guard currentId == id else { return }
            load(c)
            listen(id, since: c.seq ?? 0)
            refreshBranches()
        } catch { self.error = error.localizedDescription }
    }

    /// the same canvas from a new engine (after ↻): its state read again and its streams opened afresh
    public func reconnect(_ id: String) async {
        stream?.cancel()
        panelStream?.cancel()
        do {
            let c: Canvas = try await api.get("/v1/canvases/\(id)", as: Canvas.self)
            guard currentId == id else { return }
            load(c)
            listen(id, since: 0)
            refreshBranches()
        } catch { self.error = error.localizedDescription }
    }

    /// Closes the tab here; closeTabs deletes the canvas from the server once the undo moment passes.
    public func closeTab(_ id: String, next: String?) async {
        guard !lockedTabs.contains(id) else { return }
        closedTabs.insert(id)
        guard currentId == id else { return }
        stream?.cancel()
        stream = nil
        panelStream?.cancel()
        panelStream = nil
        currentId = nil
        agents = [:]; order = []; groups = [:]; links = []; streaming = [:]; ghosts = [:]
        feeds.clear()
        connected = false
        if let next { await open(next) }
    }

    public func load(_ c: Canvas) {
        closedTabs.remove(c.id)
        currentId = c.id
        // the same agents again (a tab shown from what was kept, then the engine's copy) touch nothing on screen
        let fresh = Dictionary(c.agents.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        if agents != fresh { agents = fresh }
        if order != c.agents.map(\.id) { order = c.agents.map(\.id) }
        groups = Dictionary((c.groups ?? []).map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        links = c.links ?? []
        computer = c.computer ?? [:]
        streaming = [:]
        ghosts = [:]
        // panel data stays keyed by agent: a canvas shown again shows its last data until the stream refreshes it
    }

    func listen(_ id: String, since: Int) {
        Task { await loadUsage() } // plan usage is per login, not per canvas: what is known so far
        let events = EventStream.events(base: api.base, canvas: id, since: since) { [weak self] up in
            Task { @MainActor in
                self?.connected = up
                if up { self?.everConnected = true }
            }
        }
        stream = Task { [weak self] in
            for await ev in events {
                guard let self, self.currentId == id else { break }
                self.apply(ev)
            }
        }
        let panels = EventStream.panels(base: api.base, canvas: id)
        panelStream = Task { [weak self] in
            for await m in panels {
                guard let self, self.currentId == id else { break }
                self.feeds.apply(m)
            }
        }
    }

    // the other tabs' agent counts and "working" dots, every few seconds
    func startPolling() {
        poll?.cancel()
        poll = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4))
                guard let self, let list = try? await self.api.get("/v1/canvases", as: CanvasList.self) else { continue }
                if list.canvases != self.canvases { self.canvases = list.canvases }
            }
        }
    }

    // ---------- events (ui/canvas/app.mjs onEvent) ----------

    struct AgentPayload: Decodable { var agent: Agent }
    struct IdPayload: Decodable { var id: String }
    struct StatusPayload: Decodable {
        var id: String; var status: String?; var queued: Int?; var waitingOn: [String]?
        var workingWith: [String]?; var blockedBy: [String]?
        var lastError: String?; var termReady: Bool?; var folder: Agent.Folder?
    }
    struct LinkPayload: Decodable { var link: Link }
    struct MessagePayload: Decodable { var from: String; var to: String; var kind: String?; var text: String? }
    struct DeltaPayload: Decodable { var id: String; var text: String }
    struct GroupPayload: Decodable { var group: Group }
    struct PanelPayload: Decodable { var id: String; var panel: Panel? }
    struct IdePayload: Decodable {
        var id: String; var ide: JSONValue?; var reveal: Reveal?
        struct Reveal: Decodable { var path: String; var line: Int?; var endLine: Int?; var at: Double? }
    }
    struct IdeFilesPayload: Decodable { var id: String; var paths: [String]? }
    struct ComputerPayload: Decodable { var id: String; var computer: ComputerControl? }

    public func apply(_ ev: ServerEvent) {
        let d = JSONDecoder()
        func decode<T: Decodable>(_ t: T.Type) -> T? { try? d.decode(t, from: ev.data) }
        switch ev.type {
        case "agent_created", "agent_updated":
            guard let p = decode(AgentPayload.self) else { return }
            // a new folder, or its branch moved (the folder picker, a terminal): the branch control follows
            if agents[p.agent.id]?.folder != p.agent.folder { refreshBranches() }
            if agents[p.agent.id] == nil { order.append(p.agent.id) }
            // an update carries the whole view; keep the text streaming in this turn
            agents[p.agent.id] = p.agent
        case "usage_updated":
            if let p = decode(UsagePayload.self) {
                usage[p.key] = p.usage
                if usageLogins[p.key] == nil { Task { await loadUsage() } } // a login not seen before: learn who it is
            }
        case "agent_status":
            guard let p = decode(StatusPayload.self), var a = agents[p.id] else { return }
            a.status = p.status ?? a.status
            a.queued = p.queued
            a.waitingOn = p.waitingOn
            a.workingWith = p.workingWith
            a.blockedBy = p.blockedBy
            a.lastError = p.lastError
            a.termReady = p.termReady
            if let f = p.folder, f != a.folder { refreshBranches() }
            a.folder = p.folder ?? a.folder
            if a.status != "running" { streaming[p.id] = nil }
            agents[p.id] = a
        case "branches_changed":
            refreshBranches()
        case "canvas_updated":
            // its first request named it, or it was renamed elsewhere: the tab says so now, not at the next poll
            struct NamePayload: Decodable { var name: String? }
            if let name = decode(NamePayload.self)?.name, let id = currentId, let i = canvases.firstIndex(where: { $0.id == id }),
               canvases[i].name != name { canvases[i].name = name }
        case "agent_removed":
            guard let p = decode(IdPayload.self) else { return }
            refreshBranches()
            agents[p.id] = nil
            ghosts[p.id] = nil
            feeds.remove(p.id)
            computer[p.id] = nil
            order.removeAll { $0 == p.id }
            links.removeAll { $0.from == p.id || $0.to == p.id }
        case "link_created":
            if let p = decode(LinkPayload.self) { links.append(p.link) }
        case "link_updated":
            if let p = decode(LinkPayload.self), let i = links.firstIndex(where: { $0.from == p.link.from && $0.to == p.link.to && $0.kind == p.link.kind }) {
                links[i] = p.link
            }
        case "message":
            // every other kind (the person's message, an error, a restore, changes) still goes on to the chat
            if let p = decode(MessagePayload.self), p.kind == "assistant", var a = agents[p.from] {
                a.lastText = p.text
                agents[p.from] = a
                streaming[p.from] = nil
            }
        case "text_delta":
            if let p = decode(DeltaPayload.self) { streaming[p.id, default: ""] += p.text }
        case "group_created", "group_updated", "context_updated":
            if let p = decode(GroupPayload.self) { groups[p.group.id] = p.group }
        case "group_removed":
            if let p = decode(IdPayload.self) { groups[p.id] = nil }
        case "panel_updated":
            guard let p = decode(PanelPayload.self), var a = agents[p.id] else { return }
            a.panel = p.panel?.spec == nil ? nil : p.panel
            agents[p.id] = a
            if a.panel != nil { ghosts[p.id] = nil } else { feeds.remove(p.id) }
        case "tool_suggested":
            guard let j = try? JSONValue.parse(ev.data), let id = j["id"]?.string, let t = j["tool"],
                  let a = agents[id], a.panel == nil else { return }
            ghosts[id] = ToolCard(json: t)
        case "ide_updated":
            guard let p = decode(IdePayload.self), var a = agents[p.id] else { return }
            a.ide = p.ide
            agents[p.id] = a
            if let r = p.reveal {
                ideReveals[p.id] = IDEReveal(path: r.path, line: r.line ?? 1, endLine: r.endLine ?? r.line ?? 1, at: r.at ?? Date().timeIntervalSince1970 * 1000)
            }
        case "computer":
            if let p = decode(ComputerPayload.self) { computer[p.id] = p.computer }
        case "ide_files":
            guard let p = decode(IdeFilesPayload.self), let paths = p.paths, !paths.isEmpty else { return }
            ideDiskChanges[p.id] = IDEDiskChange(paths: paths, stamp: (ideDiskChanges[p.id]?.stamp ?? 0) + 1)
        default:
            break
        }
        onEvent?(ev)
        for l in listeners { l(ev) }
    }

    // ---------- actions ----------

    /// a position while dragging: shown at once, saved when the drag ends (move)
    public func preview(_ id: String, pos: [Double]) { agents[id]?.pos = pos }

    public func move(_ id: String, to pos: [Double]) {
        agents[id]?.pos = pos
        Task { try? await api.patch("/v1/canvases/\(currentId ?? "")/agents/\(id)", ["pos": pos.map { $0.rounded() }]) }
    }

    var canvasPath: String { "/v1/canvases/\(currentId ?? "")" }
    func agentPath(_ id: String, _ rest: String = "") -> String { "\(canvasPath)/agents/\(id)\(rest)" }
    func run(_ work: @escaping () async throws -> Void) {
        Task { do { try await work() } catch { self.error = error.localizedDescription } }
    }

    /// the node folds to its title bar, or opens again
    public func setCollapsed(_ id: String, _ on: Bool) {
        agents[id]?.collapsed = on
        run { try await self.api.patch(self.agentPath(id), ["collapsed": on]) }
    }

    /// a corner drag ended: the card's (or the terminal's) size and, for top/left corners, its position
    public func resize(_ id: String, size: [Double], terminal: Bool, pos: [Double]) {
        if terminal { agents[id]?.size = size } else { agents[id]?.cardSize = size }
        agents[id]?.pos = pos
        run { try await self.api.patch(self.agentPath(id), [terminal ? "size" : "cardSize": size, "pos": pos]) }
    }

    public func setGroupRect(_ gid: String, rect: [Double]) {
        groups[gid]?.rect = rect
        run { try await self.api.patch("\(self.canvasPath)/groups/\(gid)", ["rect": rect]) }
    }

    public func createGroup(rect: [Double], name: String, color: String?) async -> Group? {
        var body: [String: Any] = ["name": name, "rect": rect.map { $0.rounded() }]
        if let color { body["color"] = color }
        do {
            let g: Group = try await api.post("\(canvasPath)/groups", body, as: Group.self)
            groups[g.id] = g
            return g
        } catch { self.error = error.localizedDescription; return nil }
    }

    public func patchGroup(_ gid: String, _ body: [String: Any]) {
        if let n = body["name"] as? String { groups[gid]?.name = n }
        if body.keys.contains("color") { groups[gid]?.color = body["color"] as? String }
        run { try await self.api.patch("\(self.canvasPath)/groups/\(gid)", body) }
    }

    public func deleteGroup(_ gid: String) {
        groups[gid] = nil
        run { try await self.api.delete("\(self.canvasPath)/groups/\(gid)") }
    }

    public func renameAgent(_ id: String, to name: String) {
        agents[id]?.name = name
        run { try await self.api.patch(self.agentPath(id), ["name": name]) }
    }

    public func deleteAgent(_ id: String) { run { try await self.api.delete(self.agentPath(id)) } }

    /// opens a plain shell in the agent's folder, in its node, or closes it back into the chat
    /// `opened` runs once a terminal the call opened is in `agents`
    public func toggleTerminal(_ id: String, opened: @escaping () -> Void = {}) {
        guard let a = agents[id] else { return }
        run {
            if a.isTerminalOpen { try await self.api.delete(self.agentPath(id, "/shell")); return }
            let v: Agent = try await self.api.post(self.agentPath(id, "/shell"), as: Agent.self)
            self.agents[id] = v
            opened()
        }
    }

    /// re-reads one agent (e.g. its terminal's socket closed: is the terminal still open?)
    public func refreshAgent(_ id: String) {
        run { _ = try await self.reloadAgent(id) }
    }

    @discardableResult public func reloadAgent(_ id: String) async throws -> Agent {
        let a: Agent = try await api.get(agentPath(id), as: Agent.self)
        agents[id] = a
        return a
    }

    public func stop(_ id: String) { run { try await self.api.post(self.agentPath(id, "/stop")) } }
    public func resetSession(_ id: String) { run { try await self.api.patch(self.agentPath(id), ["reset_session": true]) } }
    public func deliver(_ id: String) { run { try await self.api.post(self.agentPath(id, "/deliver")) } }

    public func deleteCanvas(_ id: String) async {
        do {
            try await api.delete("/v1/canvases/\(id)")
            let i = canvases.firstIndex { $0.id == id } ?? 0
            canvases.removeAll { $0.id == id }
            if id == currentId, !canvases.isEmpty { currentId = nil; await open(canvases[min(i, canvases.count - 1)].id) }
        } catch { self.error = error.localizedDescription }
    }

    // ---------- adding and editing agents (app.mjs openAgentDialog / submit) ----------

    /// a model as its CLI describes it (src/backends/models.mjs); the details are missing when the CLI doesn't say
    public struct Model: Decodable, Identifiable, Sendable {
        public var id: String; public var owned_by: String
        public var display_name: String?; public var description: String?; public var context_window: Int?
        /// the thinking levels it takes, lowest first, and the one its CLI uses when none is given
        public var efforts: [String]?; public var default_effort: String?
        public init(id: String, owned_by: String) { self.id = id; self.owned_by = owned_by }
    }
    public struct ModelList: Decodable, Sendable { public var data: [Model] }
    public struct Account: Decodable, Identifiable, Sendable {
        public var id: String; public var name: String; public var backend: String; public var dir: String?
        public var status: Status?
        public struct Status: Decodable, Sendable { public var loggedIn: Bool?; public var email: String? }
    }
    public struct AccountList: Decodable, Sendable { public var accounts: [Account] }
    public struct GitInfo: Decodable, Sendable { public var repo: String?; public var current: String?; public var branches: [String]? }

    public private(set) var models: [Model] = []
    public private(set) var accounts: [Account] = []

    /// the CLIs the server can run agents on, in the usual order
    public var backends: [String] {
        let order = ["claude", "codex", "copilot", "antigravity", "opencode", "gemini", "local", "fake"]
        return Array(Set(models.map(\.owned_by))).sorted { (order.firstIndex(of: $0) ?? 99, $0) < (order.firstIndex(of: $1) ?? 99, $1) }
    }
    nonisolated public static func label(of backend: String) -> String {
        ["claude": "Claude Code", "codex": "Codex", "copilot": "GitHub Copilot", "opencode": "opencode", "antigravity": "Antigravity", "gemini": "Gemini CLI", "local": L("Local"), "fake": "test"][backend] ?? backend
    }

    // ---------- plan usage (src/usage.mjs) ----------

    /// per login: how much of its plan's windows is used
    public private(set) var usage: [String: Usage] = [:]
    /// who each of those logins is (name, email, plan)
    public private(set) var usageLogins: [String: UsageLogin] = [:]
    private func take(_ l: UsageList) { usage = l.usage.compactMapValues { $0 }; usageLogins.merge(l.logins ?? [:]) { $1 } }
    struct UsagePayload: Decodable { var key: String; var usage: Usage? }

    public func loadUsage() async {
        if let l = try? await api.get("/v1/usage", as: UsageList.self) { take(l) }
        // who signed in is read from the CLI in the background: ask once more for the emails still missing
        if usageLogins.values.contains(where: { $0.email == nil }), !usageRetried {
            usageRetried = true
            try? await Task.sleep(for: .seconds(3))
            if let l = try? await api.get("/v1/usage", as: UsageList.self) { take(l) }
        }
    }
    private var usageRetried = false
    /// every login read again; `force` also runs Claude's short check when it reported lately
    public func refreshUsage(force: Bool = false) async {
        if let l = try? await api.post("/v1/usage/refresh", ["force": force], as: UsageList.self) { take(l) }
    }
    /// the logins the open canvas's agents run under, in the order they first appear
    public var canvasLogins: [(key: String, login: UsageLogin)] {
        var seen = Set<String>(), out: [(key: String, login: UsageLogin)] = []
        for a in currentAgents {
            guard let raw = a.usageKey, let b = a.backend else { continue }
            let k = loginKey(raw)
            guard seen.insert(k).inserted else { continue }
            out.append((k, usageLogins[k] ?? UsageLogin(backend: b, name: a.accountName, machine: k.hasPrefix("machine:"))))
        }
        return out
    }

    /// the key a login is shown under: a machine login signed in as a named account is that account
    public func loginKey(_ key: String) -> String {
        if let same = usageLogins[key]?.same, usageLogins[same] != nil || usage[same] != nil { return same }
        return key
    }
    /// a login's numbers: the freshest of its own and of every key that is the same login
    public func usage(for key: String) -> Usage? {
        let k = loginKey(key)
        let keys = [k] + usageLogins.filter { $0.value.same == k }.map(\.key)
        return keys.compactMap { usage[$0] }.max { ($0.checkedAt ?? 0) < ($1.checkedAt ?? 0) }
    }

    public func loadChoices() async {
        if let m = try? await api.get("/v1/models", as: ModelList.self) { models = m.data.map { item in
            guard item.owned_by == "antigravity" else { return item }
            var item = item
            let name = item.display_name ?? item.id
            item.display_name = item.id == "agy" ? "Default" : (name.hasPrefix("agy:") ? String(name.dropFirst(4)) : name)
            return item
        } }
        if let a = try? await api.get("/v1/accounts", as: AccountList.self) { accounts = a.accounts }
    }

    /// the CLI a model runs on (app.mjs backendOf)
    public func backendOf(_ model: String) -> String {
        models.first { $0.id == model }?.owned_by
            ?? (model.hasPrefix("local:") ? "local" : model == "copilot" || model.hasPrefix("copilot:") ? "copilot"
                : model == "agy" || model.hasPrefix("agy:") ? "antigravity"
                : model.contains("/") ? "opencode" : model.range(of: "^(gpt|codex|o\\d)", options: .regularExpression) != nil ? "codex" : "claude")
    }

    public func git(_ dir: String) async -> GitInfo? {
        var c = URLComponents(url: api.base.appending(path: "/v1/git"), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "dir", value: dir)]
        guard let url = c.url, let (data, _) = try? await URLSession.shared.data(from: url) else { return nil }
        return try? JSONDecoder().decode(GitInfo.self, from: data)
    }

    public func checkout(_ dir: String, branch: String) async throws {
        try await api.post("/v1/git/checkout", ["dir": dir, "branch": branch])
    }

    public func addAgent(_ fields: [String: Any]) async throws -> Agent {
        var spec = fields
        if spec["chat"] == nil { spec["chat"] = true }
        let a: Agent = try await api.post("\(canvasPath)/agents", spec, as: Agent.self)
        if agents[a.id] == nil { order.append(a.id) }
        agents[a.id] = a
        return a
    }

    public func forkChat(_ id: String, fields: [String: Any]) async throws -> Agent {
        let a: Agent = try await api.post("\(agentPath(id))/fork", fields, as: Agent.self)
        if agents[a.id] == nil { order.append(a.id) }
        agents[a.id] = a
        return a
    }

    public func updateAgent(_ id: String, _ fields: [String: Any]) async throws {
        let a: Agent = try await api.patch(agentPath(id), fields, as: Agent.self)
        agents[id] = a
    }

    /// a new tab, numbered after the open ones (closed tabs don't count: with none open it is "canvas 1" again)
    public func newCanvas() async {
        let name = Self.nextTabName(open: visibleCanvases.map(\.name))
        do {
            // a made-up name: the first request in it names it (canvas.mjs nameAfter)
            let c: Canvas = try await api.post("/v1/canvases", ["name": name, "autoName": true], as: Canvas.self)
            canvases.append(CanvasSummary(id: c.id, name: c.name, agents: 0, busy: 0))
            await open(c.id)
        } catch { self.error = error.localizedDescription }
    }

    /// "canvas n" after the open tabs' count, skipping a name an open tab has
    nonisolated public static func nextTabName(open: [String]) -> String {
        let used = Set(open)
        var n = open.count + 1
        while used.contains("canvas \(n)") || used.contains("tuval \(n)") { n += 1 }
        return L("canvas %d", n)
    }

    public func rename(canvas id: String, to name: String) async {
        guard let i = canvases.firstIndex(where: { $0.id == id }) else { return }
        canvases[i].name = name
        _ = try? await api.send("PUT", "/v1/canvases/\(id)", body: try? JSONSerialization.data(withJSONObject: ["name": name])) as JSONValue
    }

    // ---------- panels (app.mjs PanelLayer handlers) ----------

    /// collapse, maximize, size: shown at once, the server confirms with panel_updated
    public func panelUI(_ id: String, collapsed: Bool? = nil, maximized: Bool? = nil, size: [Double]? = nil) {
        guard agents[id]?.panel != nil else { return }
        var body: [String: Any] = [:]
        if let collapsed { agents[id]?.panel?.ui.collapsed = collapsed; body["collapsed"] = collapsed }
        if let maximized { agents[id]?.panel?.ui.maximized = maximized; body["maximized"] = maximized }
        if let size { agents[id]?.panel?.ui.size = size; body["size"] = size }
        run { try await self.api.patch(self.agentPath(id, "/panel"), body) }
    }

    /// always: from now on this agent's panels run without asking (the agent's autoApprove)
    public func approvePanel(_ id: String, always: Bool) { run { try await self.api.post(self.agentPath(id, "/panel/approve"), ["always": always]) } }
    public func rejectPanel(_ id: String) { run { try await self.api.post(self.agentPath(id, "/panel/reject")) } }
    public func refreshPanel(_ id: String) { run { try await self.api.post(self.agentPath(id, "/panel/refresh")) } }
    public func removePanel(_ id: String) { run { try await self.api.delete(self.agentPath(id, "/panel")) } }

    /// an agent's thinking level from its node (nil: the model's default); an open terminal restarts with it
    public func setEffort(_ id: String, _ effort: String?) {
        agents[id]?.effort = effort
        run { let _: JSONValue = try await self.api.patch(self.agentPath(id), ["effort": effort ?? ""]) }
    }

    /// the node's chat instead of its card: shown at once, the server confirms with agent_updated
    public func setChat(_ id: String, _ on: Bool) {
        agents[id]?.chat = on ? true : nil
        run { let _: JSONValue = try await self.api.patch(self.agentPath(id), ["chat": on]) }
    }

    /// the node's tool help switch: shown at once, the server confirms with agent_updated
    public func setToolHelp(_ id: String, _ on: Bool) {
        agents[id]?.toolHelp = on ? nil : false
        run { let _: JSONValue = try await self.api.patch(self.agentPath(id), ["toolHelp": on]) }
    }

    /// computer control: allows it (answering the agent's ask) or takes it back; shown at once, the server
    /// confirms with a computer event
    public func setComputer(_ id: String, _ allow: Bool) {
        computer[id] = allow ? ComputerControl(state: "on", missing: computer[id]?.missing, at: computer[id]?.at) : nil
        run { let _: JSONValue = try await self.api.post(self.agentPath(id, "/computer"), ["allow": allow]) }
    }

    /// the node's helpers switch: shown at once, the server confirms with agent_updated
    public func setHelpers(_ id: String, _ on: Bool) {
        agents[id]?.delegate = on
        run { let _: JSONValue = try await self.api.patch(self.agentPath(id), ["delegate": on]) }
    }

    // ---------- the IDE docked beside a node ----------

    public func ideClient(_ id: String) -> IDEClient? {
        currentId.map { IDEClient(api: api, canvas: $0, agent: id) }
    }

    /// opens the agent's IDE next to its node (on a file, when given)
    public func openIDE(_ id: String, path: String? = nil) {
        run {
            let v: JSONValue = try await self.api.post(self.agentPath(id, "/ide"), path.map { ["path": $0] } ?? [:])
            self.agents[id]?.ide = v
        }
    }

    /// opens the agent's IDE onto that file's Fark view: what a click on a chat's changed file does.
    /// `old`/`new` name the sides: a checkpoint tree for a turn's before or after, "HEAD", or nil for the disk.
    public func showDiff(_ id: String, path: String, old: String? = nil, new: String? = nil) {
        wantedDiffs[id] = WantedDiff(path: path, old: old, new: new)
        openIDE(id)
    }

    /// the dock's state: folded to a strip, maximized, or its own size (graph units); which left tool
    /// window is out (project or commit) and whether the pane is out at all
    public func ideUI(_ id: String, collapsed: Bool? = nil, maximized: Bool? = nil, size: [Double]? = nil, left: String? = nil, tree: Bool? = nil) {
        guard case .object(var ide)? = agents[id]?.ide else { return }
        var ui = ide["ui"]?.object ?? JSONObject()
        var body: [String: Any] = [:]
        if let collapsed { ui["collapsed"] = .bool(collapsed); body["collapsed"] = collapsed }
        if let maximized { ui["maximized"] = .bool(maximized); body["maximized"] = maximized }
        if let size { ui["size"] = .array(size.map { .number($0) }); body["size"] = size }
        if let left { ui["left"] = .string(left); body["left"] = left }
        if let tree { ui["tree"] = .bool(tree); body["tree"] = tree }
        ide["ui"] = .object(ui)
        agents[id]?.ide = .object(ide)
        run { let _: JSONValue = try await self.api.patch(self.agentPath(id, "/ide"), ["ui": body]) }
    }

    public func closeIDE(_ id: String) {
        agents[id]?.ide = nil
        run { _ = try await self.api.delete(self.agentPath(id, "/ide")) }
    }

    /// the person's own spec (so it is approved)
    public func setPanelSpec(_ id: String, _ spec: JSONValue) async throws {
        let _: JSONValue = try await api.send("PUT", agentPath(id, "/panel"), body: try JSONSerialization.data(withJSONObject: ["spec": spec.any]))
    }

    /// a message to the agent, as the person typed it
    public func tell(_ id: String, _ text: String) { run { try await self.api.post(self.agentPath(id, "/messages"), ["text": text]) } }

    public struct ActionResult: Decodable, Sendable {
        public var sent: Bool?
        public var code: Int?
        public var output: String?
        public var argv: [String]?
    }
    /// inputs the user changed: shown at once, the server re-runs what follows them and confirms
    public func setPanelInputs(_ id: String, _ values: JSONObject) {
        guard agents[id]?.panel != nil else { return }
        for (k, v) in values { agents[id]?.panel?.inputs[k] = v }
        var body: [String: Any] = [:]
        for (k, v) in values { body[k] = v.any }
        run { try await self.api.post(self.agentPath(id, "/panel/inputs"), body) }
    }

    /// a button in the panel's strip
    public func panelButton(_ id: String, index: Int) async throws -> ActionResult {
        try await api.post(agentPath(id, "/panel/button"), ["index": index], as: ActionResult.self)
    }

    /// a row action: `ask` goes to the agent (sent), `run` comes back with the program's output
    public func panelAction(_ id: String, view: String, index: Int, row: JSONValue) async throws -> ActionResult {
        try await api.post(agentPath(id, "/panel/action"), ["view": view, "index": index, "row": row.any], as: ActionResult.self)
    }

    /// keeps the panel as a saved tool; true when it was saved now
    public func keepPanel(_ id: String) async -> Bool {
        guard let p = agents[id]?.panel, p.tool == nil else { return false }
        do {
            try await api.post(agentPath(id, "/panel/save"), ["name": p.spec?.title ?? agents[id]?.name ?? "Panel"])
            return true
        } catch { self.error = error.localizedDescription; return false }
    }

    /// opens an offered tool as the agent's panel; a setting nobody filled in is the agent's to find out
    public func useTool(_ id: String, _ tool: ToolCard) {
        run {
            let missing = tool.missingParams
            if !missing.isEmpty {
                let text = "[The user picked the saved tool \"\(tool.name)\" (\(tool.id)).] Open it with use_tool; find out \(missing.joined(separator: ", ")) yourself (e.g. the current kubectl context) or ask me if you can't."
                try await self.api.post(self.agentPath(id, "/messages"), ["text": text])
                self.ghosts[id] = nil
                return
            }
            try await self.api.post(self.agentPath(id, "/tool"), ["tool": tool.id])
        }
    }

    public func dismissGhost(_ id: String) { ghosts[id] = nil }

    /// shows a panel and its data locally, as panel_updated and the panel stream would (snapshots of bricks the
    /// server doesn't know yet, tests)
    public func show(panel: Panel, data: [String: SourceState], on id: String) {
        guard agents[id] != nil else { return }
        agents[id]?.panel = panel
        ghosts[id] = nil
        feeds.apply(.snapshot(agent: id, sources: data))
    }

    /// offers a tool next to an agent, as tool_suggested does (tests, snapshots)
    public func suggest(_ id: String, _ tool: ToolCard) { if agents[id]?.panel == nil { ghosts[id] = tool } }
}

/// a canvas's agents, observed on their own (CanvasStore.agents(on:))
@MainActor @Observable
public final class CanvasAgents {
    public internal(set) var all: [String: Agent] = [:]
}
