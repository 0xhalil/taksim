import AppKit
import TaksimKit

/// One agent's IDE as the native view sees it: the project tree as far as it was opened, the open tabs and their
/// text, and the agent's notes. Edits save themselves a moment after typing stops (there is no Save step); a file
/// the agent changed on disk reloads when it has no unsaved edits, and otherwise waits for the person to choose.
@MainActor @Observable
final class IDEModel {
    let agent: String
    @ObservationIgnored let client: IDEClient

    struct Buffer {
        enum Kind { case text, binary, tooLarge, missing }
        var text: String
        /// what is on disk (as last read or written)
        var saved: String
        var mtime: Double?
        var kind: Kind = .text
        /// changed on disk while it had unsaved edits: the person picks disk or theirs
        var conflict = false
        var dirty: Bool { text != saved }
    }

    var rootName = ""
    /// folder path ("" is the root) -> its entries, for the folders that were opened
    var children: [String: [IDEEntry]] = [:]
    var expanded: Set<String> = [""]
    var tabs: [String] = []
    var active: String?
    var buffers: [String: Buffer] = [:]
    var notes: [IDENote] = []
    /// the lines to bring into view and mark, consumed by the editor
    var reveal: IDEReveal?
    /// ⌘P
    var goingToFile = false
    var allFiles: [String]?
    var error: String?

    /// which left tool window shows: the project or the commit list, and whether the pane is out at all
    var panel: IDEPanel = .project
    var showLeft = true

    /// git: the branch and changed files, which of them go into the next commit, and the message being written
    var git: IDEGitStatus?
    /// `git status` has come back at least once (a folder outside a repository has no Commit window)
    var gitLoaded = false
    /// a pull, push or fetch is running (the sync button turns)
    var syncing = false
    /// the branches there are, for the branch picker
    var branchList: [String] = []
    var commitMessage = ""
    var amend = false
    var committing = false
    /// the ✦ button is asking the model for a message
    var writingMessage = false
    /// the last thing done here ("3 dosya · a1b2c3d", or what went wrong), shown for a moment
    var notice: IDENotice?
    /// the file whose "Fark" view is over the editor
    var diff: IDEDiff?

    /// ⌘K: the rewrite being asked for, run, or shown for accepting
    var inline: IDEInlineEdit?
    /// ⌘P in its "ask the project" form, and the answer it got
    var asking = false
    var answering = false
    var answer: IDEAnswer?
    /// a model is reading the uncommitted changes (the commit window's bug button)
    var reviewing = false
    /// the project's rule files
    var rules: [IDERule] = []

    @ObservationIgnored private var saves: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var tabSync: Task<Void, Never>?
    @ObservationIgnored private var seenReveal: Double = 0
    @ObservationIgnored private var seenDisk = 0

    init(agent: String, client: IDEClient) {
        self.agent = agent
        self.client = client
    }

    // ---------- from the server ----------

    /// the IDE's state as the server sent it (ide_updated): tabs it opened, notes, the project's name
    func apply(_ state: IDEState) {
        rootName = state.rootName ?? rootName
        notes = state.notes ?? []
        if let left = state.ui?.left { panel = left == "commit" ? .commit : .project }
        if let tree = state.ui?.tree { showLeft = tree }
        for t in state.tabs ?? [] where !tabs.contains(t) { tabs.append(t) }
        if let a = state.active, a != active, tabs.contains(a) { select(a, sync: false) }
        if active == nil { active = tabs.last }
        if let a = active { showFolders(of: a); if buffers[a] == nil { Task { await load(a) } } }
        if children[""] == nil { Task { await loadDir("") } }
    }

    func apply(reveal r: IDEReveal) {
        guard r.at > seenReveal else { return }
        seenReveal = r.at
        open(r.path)
        reveal = r
    }

    /// files the agent (or anything else) changed on disk
    func apply(disk d: IDEDiskChange) {
        guard d.stamp > seenDisk else { return }
        seenDisk = d.stamp
        let changed = Set(d.paths)
        for p in changed where buffers[p] != nil {
            if buffers[p]?.dirty == true { buffers[p]?.conflict = true } else { Task { await load(p) } }
        }
        // the folders that show them get their entries again (new and deleted files)
        let dirs = Set(changed.map { ($0 as NSString).deletingLastPathComponent }).filter { children[$0] != nil }
        for dir in dirs { Task { await loadDir(dir) } }
        allFiles = nil
        Task { await refreshGit() }
    }

    // ---------- tree ----------

    func loadDir(_ path: String) async {
        do { children[path] = try await client.tree(path) } catch { self.error = error.localizedDescription }
    }

    func toggle(_ dir: String) {
        if expanded.contains(dir) { expanded.remove(dir); return }
        expanded.insert(dir)
        if children[dir] == nil { Task { await loadDir(dir) } }
    }

    // ---------- tabs ----------

    func open(_ path: String) {
        if !tabs.contains(path) { tabs.append(path) }
        select(path)
        showFolders(of: path)
    }

    /// the file's folders open in the tree
    func showFolders(of path: String) {
        var dir = (path as NSString).deletingLastPathComponent
        while !dir.isEmpty {
            if !expanded.contains(dir) { expanded.insert(dir); if children[dir] == nil { let d = dir; Task { await loadDir(d) } } }
            dir = (dir as NSString).deletingLastPathComponent
        }
    }

    func select(_ path: String, sync: Bool = true) {
        active = path
        if buffers[path] == nil { Task { await load(path) } }
        if sync { syncTabs() }
    }

    func close(_ path: String) {
        flush(path)
        guard let i = tabs.firstIndex(of: path) else { return }
        tabs.remove(at: i)
        buffers[path] = nil
        if active == path { active = tabs.indices.contains(i) ? tabs[i] : tabs.last }
        syncTabs()
    }

    private func syncTabs() {
        tabSync?.cancel()
        let t = tabs, a = active, c = client
        tabSync = Task { try? await Task.sleep(for: .milliseconds(300)); if !Task.isCancelled { try? await c.setTabs(t, active: a) } }
    }

    // ---------- files ----------

    func load(_ path: String) async {
        do {
            let f = try await client.read(path)
            let kind: Buffer.Kind = f.binary == true ? .binary : f.tooLarge == true ? .tooLarge : .text
            let text = f.content ?? ""
            buffers[path] = Buffer(text: text, saved: text, mtime: f.mtime, kind: kind)
        } catch {
            buffers[path] = Buffer(text: "", saved: "", kind: .missing)
        }
    }

    /// typing: saved a moment after it stops
    func edit(_ path: String, _ text: String) {
        guard buffers[path]?.kind == .text, buffers[path]?.text != text else { return }
        buffers[path]?.text = text
        guard buffers[path]?.conflict != true else { return } // waits for the person's choice
        saves[path]?.cancel()
        saves[path] = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled else { return }
            await self?.save(path)
        }
    }

    func flush(_ path: String) {
        guard saves[path] != nil else { return }
        saves[path]?.cancel()
        saves[path] = nil
        if buffers[path]?.dirty == true, buffers[path]?.conflict != true { Task { await save(path) } }
    }

    func save(_ path: String, force: Bool = false) async {
        guard let b = buffers[path], b.kind == .text, b.dirty || force else { return }
        let text = b.text
        do {
            let m = try await client.write(path, text, mtime: force ? nil : b.mtime)
            buffers[path]?.saved = text
            buffers[path]?.mtime = m
            buffers[path]?.conflict = false
        } catch let e as APIError where e.status == 409 {
            buffers[path]?.conflict = true
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// a conflict, settled: the disk's version, or the person's (written over it)
    func takeDisk(_ path: String) { Task { await load(path) } }
    func keepMine(_ path: String) { Task { await save(path, force: true) } }

    // ---------- notes ----------

    func notes(in path: String) -> [IDENote] { notes.filter { $0.path == path }.sorted { $0.line < $1.line } }

    func clear(_ note: IDENote) {
        notes.removeAll { $0.id == note.id }
        let c = client
        Task { try? await c.clearNote(note.id) }
    }

    func show(_ note: IDENote) {
        open(note.path)
        reveal = IDEReveal(path: note.path, line: note.line, endLine: note.endLine ?? note.line, at: Date().timeIntervalSince1970 * 1000)
    }

    // ---------- git ----------

    /// which left pane shows; the click on the open one folds it, as PyCharm's tool window buttons do
    func setPanel(_ p: IDEPanel) {
        if showLeft, panel == p { showLeft = false } else { panel = p; showLeft = true }
        let c = client, left = panel.rawValue, tree = showLeft
        Task { try? await c.setUI(left: left, tree: tree) }
        if showLeft, p == .commit { Task { await refreshGit() } } // the list is fresh each time it comes out
    }

    func refreshGit() async {
        do {
            git = try await client.git()
            gitLoaded = true
        } catch {
            git = nil
            gitLoaded = true
            say(error.localizedDescription, bad: true)
        }
    }

    func gitStatus(of path: String) -> String? {
        git?.files.first { $0.path == path }?.status
    }

    /// a folder holding a changed file shows it too, as PyCharm's tree does
    func folderChanged(_ dir: String) -> Bool {
        git?.files.contains { $0.path.hasPrefix(dir + "/") } ?? false
    }

    /// the index holds these (VS Code's "Staged Changes")
    var stagedFiles: [IDEGitFile] { git?.files.filter(\.staged) ?? [] }
    /// the disk holds more of these than the index does (its "Changes", new files too)
    var changedFiles: [IDEGitFile] { git?.files.filter(\.unstaged) ?? [] }

    /// what goes in is what is staged; with nothing staged the changes are staged first (VS Code's smart commit)
    func commit(andPush: Bool = false) async {
        let message = commitMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { say(L("Write a commit message"), bad: true); return }
        guard !stagedFiles.isEmpty || !changedFiles.isEmpty || amend else { say(L("No changes to commit"), bad: true); return }
        committing = true
        defer { committing = false }
        for p in (git?.files ?? []).map(\.path) where buffers[p]?.dirty == true { await save(p) }
        do {
            if stagedFiles.isEmpty && !amend { try await client.stage(changedFiles.map(\.path)) }
            let staged = stagedFiles.isEmpty ? changedFiles.count : stagedFiles.count
            let r = try await client.commit(nil, message: message, amend: amend)
            commitMessage = ""
            let wasAmend = amend
            amend = false
            closeDiff() // a diff against HEAD is stale now
            say(wasAmend ? L("amend · %@ · %@", r.hash, r.subject) : L("%d files · %@ · %@", staged, r.hash, r.subject), push: andPush)
            await refreshGit()
            if andPush { await push() }
        } catch {
            say(error.localizedDescription, bad: true)
        }
    }

    func push() async {
        syncing = true
        defer { syncing = false }
        do {
            let out = try await client.push()
            let last = out.split(separator: "\n").last.map(String.init) ?? ""
            say(last.isEmpty ? L("Pushed") : L("Pushed · %@", last))
            await refreshGit()
        } catch {
            say(L("push: %@", error.localizedDescription), bad: true)
        }
    }

    /// VS Code's sync button: pull what is behind, then push what is ahead
    func sync() async {
        guard !syncing else { return }
        syncing = true
        defer { syncing = false }
        do {
            if (git?.behind ?? 0) > 0 { try await client.pull() }
            if (git?.ahead ?? 0) > 0 || git?.upstream == nil { _ = try await client.push() }
            else if (git?.behind ?? 0) == 0 { try await client.fetch() }
            say(L("Synced"))
        } catch {
            say(error.localizedDescription, bad: true)
        }
        await refreshGit()
    }

    func fetchRemote() async { await run(L("Fetched")) { try await self.client.fetch() } }
    func pull() async { await run(L("Pulled")) { try await self.client.pull() } }
    func stash(pop: Bool = false) async { await run(pop ? L("Stash applied") : L("Stashed")) { try await self.client.stash(pop: pop) } }

    private func run(_ done: String, _ work: () async throws -> Void) async {
        guard !syncing else { return }
        syncing = true
        defer { syncing = false }
        do { try await work(); say(done); closeDiff() } catch { say(error.localizedDescription, bad: true) }
        await refreshGit()
    }

    /// takes the last commit back; its changes stay staged and its message comes back into the box
    func undoLastCommit() async {
        do {
            let message = try await client.uncommit()
            if commitMessage.isEmpty { commitMessage = message }
            closeDiff()
            say(L("Last commit undone"))
        } catch {
            say(error.localizedDescription, bad: true)
        }
        await refreshGit()
    }

    func loadBranches() async {
        if let r = try? await client.branches() { branchList = r.all }
    }

    func checkout(_ branch: String, create: Bool = false) async {
        await run(branch) {
            try await self.client.checkout(branch, create: create)
            for p in self.tabs { await self.load(p) } // the files may differ on the other branch
        }
    }

    /// throws the files' changes away: back to what is staged (`toHead` false, VS Code's Discard) or to HEAD
    /// (PyCharm's Rollback; new files are deleted)
    func rollback(_ paths: [String], toHead: Bool = false) async {
        guard !paths.isEmpty else { return }
        do {
            try await client.rollback(paths, keepIndex: !toHead)
            closeDiff()
            say(L("Discarded %d files", paths.count))
            await refreshGit()
            for p in paths where buffers[p] != nil { await load(p) }
        } catch {
            say(error.localizedDescription, bad: true)
        }
    }

    /// stage / unstage: the index follows the row, the file on disk doesn't change
    func setStaged(_ paths: [String], _ on: Bool) async {
        guard !paths.isEmpty else { return }
        do {
            if on { try await client.stage(paths) } else { try await client.unstage(paths) }
            closeDiff()
            await refreshGit()
        } catch {
            say(error.localizedDescription, bad: true)
        }
    }

    /// removes the files from disk (open tabs of them close)
    func deleteFiles(_ paths: [String]) async {
        guard !paths.isEmpty else { return }
        do {
            try await client.delete(paths)
            for p in paths { buffers[p] = nil; close(p) }
            closeDiff()
            say(L("Deleted %d files", paths.count))
            await refreshGit()
        } catch {
            say(error.localizedDescription, bad: true)
        }
    }

    /// the ✦: a fast model writes the message from the diff of what is going in
    func suggestCommitMessage() async {
        guard !writingMessage else { return }
        let files = stagedFiles.isEmpty ? (git?.files.map(\.path) ?? []) : stagedFiles.map(\.path)
        guard !files.isEmpty else { return }
        writingMessage = true
        defer { writingMessage = false }
        do {
            commitMessage = try await client.commitMessage(files)
        } catch {
            say(error.localizedDescription, bad: true)
        }
    }

    /// the file's change, side by side over the editor: HEAD or a checkpoint tree on the left, a turn's
    /// after tree or the disk on the right (nil is the disk)
    func openDiff(_ path: String, old: String? = nil, new: String? = nil) async {
        guard let left = await diffSide(path, rev: old, label: old == nil ? L("Working copy") : old == "HEAD" ? "HEAD" : old == "INDEX" ? L("Staged") : L("Before turn")),
              let right = await diffSide(path, rev: new, label: new == nil ? L("Working copy") : new == "INDEX" ? L("Staged") : L("After turn")) else { return }
        guard left.text.utf8.count + right.text.utf8.count <= 2_000_000 else { say(L("File too large for diff"), bad: true); return }
        diff = IDEDiff(path: path, old: left.text, new: right.text, oldLabel: left.label, newLabel: right.label,
                       rows: LineDiff.rows(old: left.text, new: right.text))
    }

    /// one side of a Fark: the disk (binary files refused), HEAD, or a checkpoint tree
    private func diffSide(_ path: String, rev: String?, label: String) async -> (text: String, label: String)? {
        guard let rev else {
            if let b = buffers[path] {
                guard b.kind == .text else { say(L("Binary file: no diff available"), bad: true); return nil }
                return (b.text, label)
            }
            let f = try? await client.read(path)
            guard f?.binary != true, f?.tooLarge != true else { say(L("Binary file: no diff available"), bad: true); return nil }
            return (f?.content ?? "", label)
        }
        if rev == "INDEX" { return ((try? await client.indexFile(path)) ?? "", label) }
        if rev == "HEAD" { return ((try? await client.gitFile(path)) ?? "", label) }
        return ((try? await client.checkpointFile(rev, path)) ?? "", label)
    }

    func closeDiff() { diff = nil }

    /// the last thing done here, said for a moment (motion, not a dialog)
    func say(_ text: String, bad: Bool = false, push: Bool = false) {
        let n = IDENotice(text: text, bad: bad, offersPush: push && !bad, at: Date())
        notice = n
        Task {
            try? await Task.sleep(for: .seconds(8))
            if notice == n { notice = nil }
        }
    }

    // ---------- go to file ----------

    func startGoToFile(asking ask: Bool = false) {
        goingToFile = true
        asking = ask
        if allFiles == nil { let c = client; Task { allFiles = (try? await c.files()) ?? [] } }
    }

    // ---------- ⌘K: change these lines ----------

    /// opens the box on lines `from…to` of the file. With an instruction (a note's text, "fix this") it runs at once.
    func startInline(path: String, from: Int, to: Int, instruction: String = "", run: Bool = false) {
        guard buffers[path]?.kind == .text else { return }
        inlineTask?.cancel()
        inline = IDEInlineEdit(path: path, from: from, to: max(from, to), instruction: instruction, phase: .asking)
        if run { submitInline() }
    }

    func submitInline() {
        guard var e = inline, case .asking = e.phase, let b = buffers[e.path] else { return }
        let instruction = e.instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instruction.isEmpty else { return }
        e.phase = .running
        inline = e
        let c = client
        inlineTask = Task { [weak self] in
            do {
                if b.dirty { await self?.save(e.path) } // the engine reads the file from disk
                let r = try await c.edit(e.path, from: e.from, to: e.to, instruction: instruction)
                guard !Task.isCancelled, self?.inline?.id == e.id else { return }
                self?.inline?.phase = .proposal(original: r.original, replacement: r.replacement,
                                                rows: LineDiff.rows(old: r.original, new: r.replacement))
            } catch {
                guard !Task.isCancelled, self?.inline?.id == e.id else { return }
                self?.inline?.phase = .failed(error.localizedDescription)
            }
        }
    }

    /// the proposal goes into the buffer (and saves itself like any edit); stale ones are dropped
    func acceptInline() {
        guard let e = inline, case let .proposal(original, replacement, _) = e.phase else { return }
        inline = nil
        guard let text = buffers[e.path]?.text,
              let next = IDESplice.apply(text, from: e.from, to: e.to, original: original, replacement: replacement) else {
            say(L("The lines changed meanwhile"), bad: true); return
        }
        edit(e.path, next)
    }

    func rejectInline() {
        inlineTask?.cancel()
        inline = nil
    }

    @ObservationIgnored private var inlineTask: Task<Void, Never>?

    // ---------- ask the project ----------

    func ask(_ question: String) async {
        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, !answering else { return }
        answering = true
        answer = nil
        defer { answering = false }
        do { answer = try await client.ask(q) } catch { say(error.localizedDescription, bad: true) }
    }

    func go(to hit: IDEAskHit) {
        goingToFile = false
        open(hit.path)
        reveal = IDEReveal(path: hit.path, line: hit.line, endLine: hit.endLine ?? hit.line, at: Date().timeIntervalSince1970 * 1000)
    }

    // ---------- review the changes ----------

    /// a model reads the uncommitted changes and marks what looks wrong as notes on their lines
    func review() async {
        guard !reviewing else { return }
        reviewing = true
        defer { reviewing = false }
        do {
            let found = try await client.review()
            let ids = Set(found.map(\.id))
            notes = notes.filter { !ids.contains($0.id) } + found
            say(found.isEmpty ? L("No problems found") : L("%d notes", found.count), bad: false)
            if let first = found.first { show(first) }
        } catch {
            say(error.localizedDescription, bad: true)
        }
    }

    // ---------- rules ----------

    func refreshRules() async { rules = (try? await client.rules()) ?? rules }

    /// opens the project's rules file (made when there is none)
    func openRules() {
        let c = client
        Task {
            guard let path = try? await c.rulesFile() else { return }
            closeDiff()
            open(path)
            await refreshRules()
        }
    }
}

/// the left tool windows, as PyCharm's stripe names them
enum IDEPanel: String, Sendable {
    case project, commit
}

/// a change shown side by side: the two texts, what each side is (HEAD, a turn's before/after, the disk),
/// and the walked rows between them
struct IDEDiff: Equatable {
    var path: String
    var old: String
    var new: String
    var oldLabel: String
    var newLabel: String
    var rows: [DiffRow]
}

/// the ⌘K box: which lines, what was asked, and where it is
struct IDEInlineEdit: Equatable, Identifiable {
    enum Phase: Equatable {
        case asking
        case running
        case proposal(original: String, replacement: String, rows: [DiffRow])
        case failed(String)
    }
    let id = UUID()
    var path: String
    var from: Int
    var to: Int
    var instruction: String
    var phase: Phase
}

/// what just happened in the IDE, said for a few seconds
struct IDENotice: Equatable {
    var text: String
    var bad: Bool
    /// a successful commit offers the next step in place
    var offersPush: Bool
    var at: Date
}
