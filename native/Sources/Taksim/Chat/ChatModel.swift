import AppKit
import Foundation
import Observation
import TaksimKit
import UniformTypeIdentifiers

// One agent's chat (the parts of Cursor's chat taksim can have): its transcript as messages, the answer
// streaming in, what each turn changed with the checkpoint before it, and a composer whose attachments
// (files, folders, agents, lines picked in the IDE, pasted images) go with the message.

struct ChatAttachment: Codable, Hashable, Identifiable {
    var kind: String          // file | folder | image | selection | agent
    var path: String?
    var name: String?
    var from: Int?
    var to: Int?
    var text: String?
    var id: String { [kind, path ?? name ?? "", from.map(String.init) ?? "", to.map(String.init) ?? ""].joined(separator: "|") }

    /// what the chip says: a file's name, lines, an agent's name
    var label: String {
        switch kind {
        case "conversation": return name ?? L("Chat")
        case "agent": return "@" + (name ?? "")
        case "selection": return "\((path as NSString?)?.lastPathComponent ?? "") \(from ?? 1)–\(to ?? from ?? 1)"
        default: return (path as NSString?)?.lastPathComponent ?? ""
        }
    }
    var symbol: String {
        switch kind {
        case "folder": "folder"
        case "image": "photo"
        case "selection": "text.alignleft"
        case "conversation": "bubble.left.and.bubble.right"
        case "agent": "person.crop.circle"
        default: "doc"
        }
    }
    var json: [String: Any] {
        var o: [String: Any] = ["kind": kind]
        if let path { o["path"] = path }
        if let name { o["name"] = name }
        if let from { o["from"] = from }
        if let to { o["to"] = to }
        if let text { o["text"] = text }
        return o
    }
}

struct ChatChange: Codable, Hashable, Identifiable {
    var path: String
    var added: Int?
    var removed: Int?
    var id: String { path }
}

struct ChatEntry: Codable, Identifiable, Hashable {
    var ts: Double?
    var mode: String?
    var from: String
    var to: String
    var kind: String?
    var text: String?
    var attachments: [ChatAttachment]?
    var tasks: [ChatTask]?
    var activities: [ChatActivity]?
    var usage: ChatUsage?
    var changes: [ChatChange]?
    var checkpoint: String?
    var after: String?
    var redo: String?
    /// a failed turn whose login is signed out: the CLI to sign in to (ChatSignIn)
    var signIn: String?
    var id: String { "\(ts ?? 0)|\(from)|\(kind ?? "")|\((text ?? "").prefix(24))" }

    /// the version of the plan this message started ("Apply plan"); the engine's prompt around it isn't the person's words
    var appliedPlan: Int? {
        guard from == "user", let t = text, let r = t.range(of: #"<approved_plan id="[^"]*" version="(\d+)">"#, options: .regularExpression) else { return nil }
        return Int(t[r].split(separator: "\"").last { Int($0) != nil } ?? "")
    }
    /// what the person wrote: a fix request from a review shows without the diff sent along with it
    var shownText: String? {
        guard from == "user", let t = text, t.contains("\n<review_diff>\n"), let cut = t.range(of: "\n\nReviewed turn: ") else { return text }
        return String(t[..<cut.lowerBound])
    }
}

struct ChatTask: Codable, Hashable, Identifiable {
    var id: String
    var content: String
    var status: String
    var activeForm: String?
    var priority: String?
}

struct ChatPlan: Codable, Hashable, Identifiable {
    var id: String
    var version: Int
    var title: String
    var content: String
    var status: String
    var updatedAt: Double
}

/// work the agent orchestrates: the parts it handed out, who has each, how far they are (the engine keeps it)
struct ChatJob: Codable, Hashable, Identifiable {
    var id: String
    var title: String
    var status: String          // proposed | running | done | partial | declined | stopped | timed out
    var parts: [Part]
    var checks: [Check]?
    var review: Review?
    var warning: String?
    var updatedAt: Double?
    /// a command the engine runs to prove the work
    struct Check: Codable, Hashable, Identifiable {
        var command: String
        var status: String      // pending | running | passed | failed | timed out | stopped
        var output: String?
        var id: String { command }
    }
    /// the change read from its diff alone, by an agent that knows nothing of the conversation
    struct Review: Codable, Hashable {
        var status: String      // running | ok | problems | skipped
        var model: String?
        var agentId: String?
        var findings: String?
    }
    struct Part: Codable, Hashable, Identifiable {
        var id: String
        var title: String
        var status: String      // pending | running | done | failed | skipped | cancelled | stopped
        var model: String?
        var agentId: String?
        var agentName: String?
        var writes: Bool?
        var error: String?
    }
}

struct ChatQuestion: Codable, Hashable, Identifiable {
    var id: String
    var questions: [Question]
    struct Question: Codable, Hashable, Identifiable {
        var id: String
        var title: String
        var options: [String]
    }
}

struct ChatUsage: Codable, Hashable {
    var input: Int?
    var output: Int?
}

struct ChatActivity: Codable, Hashable, Identifiable {
    var id: String
    var label: String
    var detail: String
    var status: String
}

struct QueuedChatMessage: Codable, Identifiable, Hashable {
    var id: String
    var text: String
    var attachments: [ChatAttachment]
    var ts: Double
}

/// drafts per agent, so a composer keeps what was typed and ⌘L in the IDE can add to the right one
@MainActor @Observable
final class ChatDrafts {
    static let shared = ChatDrafts(persistent: true)
    /// something was added for an agent (⌘L): its node shows its chat if it has no terminal open
    static let wantsChat = Notification.Name("taksim.chat.wants")
    var text: [String: String] = [:] { didSet { persist() } }
    var attachments: [String: [ChatAttachment]] = [:] { didSet { persist() } }
    @ObservationIgnored private let persistent: Bool
    @ObservationIgnored private var saveTask: Task<Void, Never>?

    init(persistent: Bool = false) {
        self.persistent = persistent
        if persistent {
            text = UserDefaults.standard.dictionary(forKey: "chat.drafts.text") as? [String: String] ?? [:]
            if let data = UserDefaults.standard.data(forKey: "chat.drafts.attachments"),
               let saved = try? JSONDecoder().decode([String: [ChatAttachment]].self, from: data) { attachments = saved }
        }
    }
    private func persist() {
        guard persistent else { return }
        // Coalesce typing; attachment bytes live in the workspace, only their references are saved.
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled, let self else { return }
            UserDefaults.standard.set(text.filter { !$0.value.isEmpty }, forKey: "chat.drafts.text")
            if let data = try? JSONEncoder().encode(attachments.filter { !$0.value.isEmpty }) {
                UserDefaults.standard.set(data, forKey: "chat.drafts.attachments")
            }
        }
    }
    /// the agent whose composer should take the keyboard (⌘L just added to it)
    var focus: String?

    func add(_ a: ChatAttachment, to agent: String) {
        var list = attachments[agent] ?? []
        if !list.contains(a) { list.append(a) }
        attachments[agent] = list
        focus = agent
    }

    /// Bring an earlier request back without discarding what is already being composed.
    func reuse(_ entry: ChatEntry, for agent: String) {
        let current = text[agent] ?? ""
        let request = entry.text ?? ""
        text[agent] = [current, request].filter { !$0.isEmpty }.joined(separator: "\n\n")
        for a in entry.attachments ?? [] { add(a, to: agent) }
        focus = agent
    }
}

@MainActor @Observable
final class ChatModel {
    let api: APIClient
    let canvas: String
    let agent: String
    var entries: [ChatEntry] = []
    var streaming = ""
    var loaded = false
    /// a restore just made, for its "Redo"
    var busyRestore: String?
    var error: String?
    var queue: [QueuedChatMessage] = []
    var queueBusy = false
    var sending = 0
    var uploading = 0
    var branching = false
    var settingMode = false
    var job: ChatJob?
    var plan: ChatPlan?
    /// the plan is open beside the node (the canvas lays its dock out when this changes)
    var planShown = false { didSet { if planShown != oldValue { onPlanShown?() } } }
    @ObservationIgnored var onPlanShown: (() -> Void)?
    var question: ChatQuestion?
    var tasks: [ChatTask] = []
    @ObservationIgnored private var taskVersion = 0
    var workflowBusy = false
    @ObservationIgnored private var workflowVersion = 0
    var stopping = false
    var activities: [ChatActivity] = []
    @ObservationIgnored private var activityVersion = 0
    @ObservationIgnored private var queueVersion = 0
    @ObservationIgnored var files: [String]?

    init(api: APIClient, canvas: String, agent: String) {
        self.api = api; self.canvas = canvas; self.agent = agent
    }

    private var path: String { "/v1/canvases/\(canvas)/agents/\(agent)" }

    func load() async {
        struct T: Decodable { var transcript: [ChatEntry] }
        do {
            let t = try await api.get("\(path)/transcript?limit=500", as: T.self)
            let live = entries.filter { !t.transcript.contains($0) }
            entries = (t.transcript + live).sorted { ($0.ts ?? 0) < ($1.ts ?? 0) }
        }
        catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
        struct A: Decodable { var activities: [ChatActivity] }
        let version = activityVersion
        if let a = try? await api.get("\(path)/activity", as: A.self), version == activityVersion { activities = a.activities }
        struct W: Decodable { var plan: ChatPlan?; var question: ChatQuestion? }
        let workflowVersion = self.workflowVersion
        if let w = try? await api.get("\(path)/workflow", as: W.self), workflowVersion == self.workflowVersion { takeWorkflow(plan: w.plan, question: w.question) }
        struct Tasks: Decodable { var tasks: [ChatTask] }
        let taskVersion = self.taskVersion
        if let t = try? await api.get("\(path)/tasks", as: Tasks.self), taskVersion == self.taskVersion { takeTasks(t.tasks) }
        struct J: Decodable { var job: ChatJob? }
        if let j = try? await api.get("\(path)/job", as: J.self) { job = j.job }
        await loadQueue()
        loaded = true
    }

    /// a recorded message from the canvas's events
    func take(_ e: ChatEntry) {
        guard e.from == agent || e.to == agent, e.from != e.to else { return }
        guard !entries.contains(e) else { return }
        if e.from == agent { files = nil; activityVersion += 1; streaming = ""; activities = []; takeTasks([]); stopping = false }
        entries.append(e)
    }

    func delta(_ text: String) { streaming += text }

    func send(_ text: String, attachments: [ChatAttachment]) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty || !attachments.isEmpty else { return }
        // Pending messages live in the queue; they enter the transcript only when their turn starts.
        let body: [String: Any] = ["text": t, "attachments": attachments.map(\.json)]
        sending += 1
        Task { [api, path] in
            defer { self.sending -= 1 }
            do { _ = try await api.post("\(path)/messages", body) }
            catch {
                self.error = (error as? APIError)?.message ?? error.localizedDescription
                ChatDrafts.shared.reuse(ChatEntry(from: "user", to: self.agent, text: t, attachments: attachments), for: self.agent)
            }
        }
    }

    func stop() {
        guard !stopping else { return }
        stopping = true
        Task {
            defer { stopping = false }
            do { _ = try await api.post("\(path)/stop") }
            catch { self.error = error.localizedDescription }
        }
    }

    /// a job that didn't finish goes on where it left off: what is done stays done
    func resumeJob() {
        Task {
            do { _ = try await api.post("\(path)/job", ["action": "resume"]) }
            catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
        }
    }

    func takeTasks(_ tasks: [ChatTask]) { taskVersion += 1; self.tasks = tasks }

    func takeWorkflow(plan: ChatPlan?, question: ChatQuestion?) {
        workflowVersion += 1
        self.plan = plan; self.question = question
    }

    @discardableResult
    func changeWorkflow(_ fields: [String: Any], store: CanvasStore, edit: Bool = false) async -> Bool {
        guard !workflowBusy else { return false }
        workflowBusy = true
        let version = workflowVersion
        defer { workflowBusy = false }
        do {
            struct W: Decodable { var plan: ChatPlan? }
            if edit {
                let w = try await api.patch("\(path)/workflow", fields, as: W.self)
                if version == workflowVersion { takeWorkflow(plan: w.plan, question: question) }
            } else if fields["action"] as? String == "save" {
                struct S: Decodable { var path: String }
                let saved = try await api.post("\(path)/workflow", fields, as: S.self)
                store.openIDE(agent, path: saved.path)
            } else if fields["action"] as? String == "answer" {
                _ = try await api.post("\(path)/workflow", fields)
                if version == workflowVersion { takeWorkflow(plan: plan, question: nil) }
            } else {
                let w = try await api.post("\(path)/workflow", fields, as: W.self)
                if version == workflowVersion { takeWorkflow(plan: w.plan, question: question) }
                _ = try? await store.reloadAgent(agent)
            }
            return true
        } catch {
            if (error as? APIError)?.status == 409 { self.error = L("Workflow changed; re-check the plan or question."); await load() }
            else { self.error = (error as? APIError)?.message ?? error.localizedDescription }
            return false
        }
    }

    func setMode(_ mode: String, store: CanvasStore) async {
        guard !settingMode else { return }
        settingMode = true
        defer { settingMode = false }
        do {
            try await store.updateAgent(agent, ["chatMode": mode])

        } catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
    }

    func setPermission(_ permission: String, store: CanvasStore) async {
        guard !settingMode else { return }
        settingMode = true
        defer { settingMode = false }
        do {
            try await store.updateAgent(agent, ["permission": permission])
        } catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
    }

    func takeActivity(_ activity: ChatActivity?, reset: Bool) {
        activityVersion += 1
        if reset { activities = []; streaming = "" }
        if let activity {
            if let i = activities.firstIndex(where: { $0.id == activity.id }) { activities[i] = activity }
            else { activities.append(activity) }
        }
    }

    func branch(store: CanvasStore, at entry: ChatEntry? = nil, fresh: Bool = false) async -> Bool {
        guard !branching else { return false }
        branching = true
        defer { branching = false }
        do {
            var fields: [String: Any] = ["fresh": fresh]
            if let entry, let ts = entry.ts { fields["at"] = ts; fields["from"] = entry.from; fields["text"] = entry.text ?? "" }
            let a = try await store.forkChat(agent, fields: fields)
            NotificationCenter.default.post(name: ChatDrafts.wantsChat, object: a.id, userInfo: ["reveal": true])
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { ChatDrafts.shared.focus = a.id }
            return true
        } catch { self.error = (error as? APIError)?.message ?? error.localizedDescription; return false }
    }

    func takeQueue(_ messages: [QueuedChatMessage]) { queueVersion += 1; queue = messages }

    func loadQueue() async {
        struct Q: Decodable { var messages: [QueuedChatMessage] }
        let version = queueVersion
        if let q = try? await api.get("\(path)/queue", as: Q.self), version == queueVersion { takeQueue(q.messages) }
    }

    func changeQueue(_ body: [String: Any], cancel: Bool = false) async -> Bool {
        guard !queueBusy else { return false }
        queueBusy = true
        defer { queueBusy = false }
        do {
            if cancel { _ = try await api.post("\(path)/queue", body) }
            else { _ = try await api.patch("\(path)/queue", body) }
            await loadQueue()
            return true
        } catch {
            if let e = error as? APIError, e.status == 409 { self.error = L("Queue changed; the message may have started.") }
            else { self.error = (error as? APIError)?.message ?? error.localizedDescription }
            await loadQueue()
            return false
        }
    }

    /// Search preserves the timeline; results are destinations rather than a filtered conversation.
    func matches(_ query: String) -> [Int] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return [] }
        return entries.indices.filter { i in
            let e = entries[i]
            return (e.text ?? "").localizedStandardContains(q) ||
                (e.attachments ?? []).contains { ($0.path ?? $0.name ?? "").localizedStandardContains(q) } ||
                (e.changes ?? []).contains { $0.path.localizedStandardContains(q) }
        }
    }

    static func markdown(_ entries: [ChatEntry], title: String, agent: String) -> String {
        var parts = ["# " + title.replacingOccurrences(of: "\n", with: " ")]
        for e in entries {
            if e.kind == "restore" { parts.append("---\n\n" + L("Restored")); continue }
            let heading = e.from == "user" ? L("You") : e.from == agent ? title : e.from
            var block = e.kind == "changes" ? "" : "## \(heading)\n\n\(e.text ?? "")"
            for a in e.attachments ?? [] {
                block += "\n\n> \(a.kind): \(a.path ?? a.name ?? "")"
                if a.kind == "selection" { block += " · \(a.from ?? 1)–\(a.to ?? a.from ?? 1)\n\n" + (a.text ?? "") }
            }
            for t in e.tasks ?? [] { block += "\n\n- [\(t.status == "completed" ? "x" : " ")] \(t.content) · \(t.status)" }
            for c in e.changes ?? [] { block += "\n\n- \(c.path)" + (c.added.map { " (+\($0), −\(c.removed ?? 0))" } ?? " (\(L("binary")))") }
            if !block.isEmpty { parts.append(block) }
        }
        return parts.joined(separator: "\n\n") + "\n"
    }

    func export(title: String) {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.init(filenameExtension: "md") ?? .plainText]
        panel.nameFieldStringValue = title.replacingOccurrences(of: "/", with: "-") + ".md"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            Task { @MainActor in
                struct T: Decodable { var transcript: [ChatEntry] }
                do {
                    let t = try await self.api.get("\(self.path)/transcript?limit=100000", as: T.self)
                    try Self.markdown(t.transcript, title: title, agent: self.agent).write(to: url, atomically: true, encoding: .utf8)
                } catch { self.error = error.localizedDescription }
            }
        }
    }

    /// back to a checkpoint (or forward again, with a restore's redo point)
    func restore(_ checkpoint: String) {
        guard busyRestore == nil else { return }
        busyRestore = checkpoint
        Task {
            do { _ = try await api.post("\(path)/restore", ["checkpoint": checkpoint]) }
            catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
            busyRestore = nil
        }
    }

    /// an image pasted or dropped: kept in the workspace, attached by its path
    func upload(_ data: Data, type: String) async -> ChatAttachment? {
        uploading += 1
        defer { uploading -= 1 }
        var req = URLRequest(url: api.base.appending(path: "\(path)/attachments"))
        req.httpMethod = "POST"
        req.setValue(type, forHTTPHeaderField: "content-type")
        req.httpBody = data
        struct R: Decodable { var path: String }
        guard let (d, r) = try? await URLSession.shared.data(for: req), (r as? HTTPURLResponse)?.statusCode == 201,
              let p = try? JSONDecoder().decode(R.self, from: d) else { error = L("Couldn't attach the image"); return nil }
        return ChatAttachment(kind: "image", path: p.path)
    }

    /// the files of its folder, for @ (loaded once)
    func fileList() async -> [String] {
        if let files { return files }
        let f = (try? await IDEClient(api: api, canvas: canvas, agent: agent).files()) ?? []
        files = f
        return f
    }

    /// a restore that steps forward again over the one right before it (Redo), rather than back to a checkpoint.
    /// Trees are content hashes, so the same one can be both a turn's start and a redo point: the order decides.
    func wentForward(_ index: Int) -> Bool {
        guard entries.indices.contains(index), entries[index].kind == "restore", index > 0 else { return false }
        let previous = entries[index - 1]
        guard previous.kind == "restore", previous.redo != nil, previous.redo == entries[index].checkpoint else { return false }
        return !wentForward(index - 1)
    }

    /// the checkpoint before the turn a user message started: the next answer's (or its changes entry's)
    func checkpoint(after index: Int) -> String? {
        for e in entries[(index + 1)...] {
            if e.from == "user", e.kind != "restore" { return nil }
            if let c = e.checkpoint, e.kind != "restore" { return c }
        }
        return nil
    }
}

extension ChatModel {
    /// an agent of this chat's canvas: watched on that canvas only, so a chat in the background isn't drawn again
    /// when the tabs switch
    func agent(_ id: String, _ store: CanvasStore) -> Agent? { store.agents(on: canvas).all[id] }
}
