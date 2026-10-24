import Foundation

/// The canvas's repos and their branches, the saved branch sets and the one the canvas is on (GET …/branches).
public struct BranchState: Decodable, Equatable, Sendable {
    public struct Repo: Decodable, Equatable, Sendable, Identifiable {
        public var dir: String
        public var name: String
        public var branch: String?
        public var dirty: Bool?
        public var busy: Bool?
        public var branches: [String]?
        public var id: String { dir }
    }
    public struct Set: Decodable, Equatable, Sendable, Identifiable {
        public var id: String
        public var name: String
        public var branches: [String: String]
    }
    public var repos: [Repo]
    public var sets: [Set]
    public var active: String?

    public init(repos: [Repo] = [], sets: [Set] = [], active: String? = nil) {
        self.repos = repos; self.sets = sets; self.active = active
    }

    public var activeSet: Set? { sets.first { $0.id == active } }

    /// what the control says: the set the canvas is on; else the branch every repo is on; else nothing (the icon alone)
    public var title: String? {
        if let s = activeSet { return s.name }
        let all = Swift.Set(repos.compactMap(\.branch))
        return all.count == 1 ? all.first : nil
    }

    /// the set's branch per repo of this canvas, in the canvas's repo order (repos it doesn't name keep theirs)
    public func lines(of set: Set) -> [(repo: String, branch: String)] {
        repos.compactMap { r in set.branches[r.dir].map { (r.name, $0) } }
    }

    /// the current branches already make up a set
    public var currentIsSaved: Bool { active != nil }
}

extension CanvasStore {
    var branchesPath: String { "\(canvasPath)/branches" }

    /// reads the canvas's branches again (on open, after a switch here or anywhere, when its agents change)
    public func refreshBranches() {
        guard let id = currentId else { return }
        Task {
            guard let s = try? await api.get("/v1/canvases/\(id)/branches", as: BranchState.self), currentId == id else { return }
            if branches != s { branches = s }
            branchCache[id] = s
        }
    }

    /// the whole canvas onto a saved set: every repo switched at once, or none
    public func switchBranches(to set: String) async { await switchBranches(["set": set]) }

    /// one repo onto another branch, its uncommitted work kept for when it comes back
    public func switchBranch(repo dir: String, to branch: String) async { await switchBranches(["branches": [dir: branch]]) }

    private func switchBranches(_ body: [String: Any]) async {
        guard let id = currentId else { return }
        branchError = nil
        branchSwitching = true
        defer { branchSwitching = false }
        do {
            let s = try await api.post("/v1/canvases/\(id)/branches", body, as: BranchState.self)
            if currentId == id { branches = s }
            branchCache[id] = s
        } catch {
            if currentId == id { branchError = error.localizedDescription }
        }
    }

    /// the branches checked out now, kept as a set (named by the system; rename in place)
    @discardableResult public func saveBranchSet() async -> BranchState.Set? {
        guard let id = currentId else { return nil }
        let s = try? await api.post("/v1/canvases/\(id)/branch-sets", [:], as: BranchState.Set.self)
        refreshBranches()
        return s
    }

    public func renameBranchSet(_ set: String, to name: String) {
        run { try await self.api.patch("\(self.canvasPath)/branch-sets/\(set)", ["name": name]); self.refreshBranches() }
    }

    /// the set takes the branches checked out now
    public func updateBranchSet(_ set: String) {
        guard let b = branches else { return }
        let now = Dictionary(b.repos.compactMap { r in r.branch.map { (r.dir, $0) } }, uniquingKeysWith: { a, _ in a })
        run { try await self.api.patch("\(self.canvasPath)/branch-sets/\(set)", ["branches": now]); self.refreshBranches() }
    }

    public func deleteBranchSet(_ set: String) {
        if var b = branches { b.sets.removeAll { $0.id == set }; branches = b }
        run { try await self.api.delete("\(self.canvasPath)/branch-sets/\(set)"); self.refreshBranches() }
    }
}
