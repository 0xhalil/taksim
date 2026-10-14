import Foundation

// The IDE's data, from the server's IDE API (src/routes/ide.mjs): the project's files, an open file's text and
// when it changed on disk, the agent's notes on lines. The native IDE (Taksim/IDE/) draws them.

public struct IDENote: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var path: String
    public var line: Int
    public var endLine: Int?
    public var text: String
    /// info, warning or error
    public var severity: String?
}

/// the IDE's state as the server keeps it
public struct IDEState: Decodable, Equatable, Sendable {
    public var tabs: [String]?
    public var active: String?
    public var notes: [IDENote]?
    public var root: String?
    public var rootName: String?
    public var ui: IDEUI?

    public init(json: JSONValue?) {
        guard let json, let d = try? JSONEncoder().encode(json), let s = try? JSONDecoder().decode(IDEState.self, from: d) else { return }
        self = s
    }
}

/// the dock's panes: which left tool window is out, and whether the pane is out at all
public struct IDEUI: Decodable, Equatable, Sendable {
    public var tree: Bool?
    public var left: String?
}

public struct IDEEntry: Decodable, Equatable, Identifiable, Sendable {
    public var name: String
    public var path: String
    public var dir: Bool?
    /// a folder the IDE doesn't look into (node_modules, .git, build output…)
    public var excluded: Bool?
    public var id: String { path }
    public var isDir: Bool { dir ?? false }
}

public struct IDEFile: Decodable, Sendable {
    public var path: String
    public var mtime: Double?
    public var size: Int?
    public var content: String?
    public var tooLarge: Bool?
    public var binary: Bool?
}

/// "show this": a file and the lines to bring into view and mark (the agent's ide_open)
public struct IDEReveal: Equatable, Sendable {
    public var path: String
    public var line: Int
    public var endLine: Int
    public var at: Double
    public init(path: String, line: Int, endLine: Int, at: Double) { self.path = path; self.line = line; self.endLine = endLine; self.at = at }
}

/// files that changed on disk (the agent edits through its own CLI), with a counter so each batch is seen once
public struct IDEDiskChange: Equatable, Sendable {
    public var paths: [String]
    public var stamp: Int
}

/// a Fark view someone asked for before its dock was there: the file and what the two sides are
/// (a checkpoint tree, "HEAD", or nil for the disk)
public struct WantedDiff: Equatable, Sendable {
    public var path: String
    public var old: String?
    public var new: String?
    public init(path: String, old: String? = nil, new: String? = nil) {
        self.path = path; self.old = old; self.new = new
    }
}

/// one changed file from `git status`: modified, added, untracked, deleted or renamed
public struct IDEGitFile: Decodable, Equatable, Sendable {
    public var path: String
    public var status: String
}

public struct IDEGitStatus: Decodable, Equatable, Sendable {
    public var branch: String?
    public var files: [IDEGitFile]
}

public struct IDEGitCommit: Decodable, Equatable, Sendable {
    public var hash: String
    public var subject: String
}

/// the server's IDE API for one agent
public struct IDEClient: Sendable {
    public let api: APIClient
    public let base: String
    /// the agent's own path (the chat's endpoints, like checkpoints, hang off it)
    public let agentBase: String

    public init(api: APIClient, canvas: String, agent: String) {
        self.api = api
        base = "/v1/canvases/\(canvas)/agents/\(agent)/ide"
        agentBase = "/v1/canvases/\(canvas)/agents/\(agent)"
    }

    private func q(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&+="))) ?? s }

    public func tree(_ path: String = "") async throws -> [IDEEntry] {
        struct R: Decodable { var entries: [IDEEntry] }
        return try await api.get("\(base)/tree?path=\(q(path))", as: R.self).entries
    }

    public func files() async throws -> [String] {
        struct R: Decodable { var files: [String] }
        return try await api.get("\(base)/files", as: R.self).files
    }

    public func read(_ path: String) async throws -> IDEFile {
        try await api.get("\(base)/file?path=\(q(path))", as: IDEFile.self)
    }

    /// saves when the file is still as it was read (`mtime`); a 409 means it changed on disk since
    public func write(_ path: String, _ content: String, mtime: Double?) async throws -> Double? {
        struct R: Decodable { var mtime: Double? }
        var body: [String: Any] = ["content": content]
        if let mtime { body["mtime"] = mtime }
        return try await api.put("\(base)/file?path=\(q(path))", body, as: R.self).mtime
    }

    /// the open tabs and the active one, kept on the server so the IDE comes back as it was
    public func setTabs(_ tabs: [String], active: String?) async throws {
        try await api.patch(base, ["tabs": tabs, "active": active ?? NSNull()])
    }

    /// which left tool window is open (project or commit) and whether the pane is out
    public func setUI(left: String, tree: Bool) async throws {
        try await api.patch(base, ["ui": ["left": left, "tree": tree]])
    }

    // ---------- git ----------

    /// the branch and changed files; nil when the folder isn't in a repository
    public func git() async throws -> IDEGitStatus? {
        let v = try await api.get(base + "/git", as: JSONValue.self)
        guard !v.isNull else { return nil }
        return try JSONDecoder().decode(IDEGitStatus.self, from: JSONEncoder().encode(v))
    }

    /// a file as committed at HEAD ("" when it's new)
    public func gitFile(_ path: String) async throws -> String {
        struct R: Decodable { var content: String }
        return try await api.get("\(base)/git?path=\(q(path))", as: R.self).content
    }

    /// a file as it was in a checkpoint tree — a turn's before or after ("" when it wasn't there then)
    public func checkpointFile(_ tree: String, _ path: String) async throws -> String {
        struct R: Decodable { var content: String }
        return try await api.get("\(agentBase)/checkpoint?at=\(q(tree))&path=\(q(path))", as: R.self).content
    }

    public func commit(_ files: [String], message: String, amend: Bool) async throws -> IDEGitCommit {
        try await api.post("\(base)/commit", ["files": files, "message": message, "amend": amend], as: IDEGitCommit.self)
    }

    /// commits and pushes in one go (the branch's upstream, or the first remote)
    public func push() async throws -> String {
        struct R: Decodable { var output: String? }
        return try await api.post("\(base)/push", [:], as: R.self).output ?? ""
    }

    /// throws away the chosen files' changes (tracked go back to HEAD, new ones are deleted)
    public func rollback(_ files: [String]) async throws {
        _ = try await api.post("\(base)/rollback", ["files": files])
    }

    /// one message for the chosen changes, written by the engine's fast model
    public func commitMessage(_ files: [String]) async throws -> String {
        struct R: Decodable { var message: String }
        return try await api.post("\(base)/commit-message", ["files": files], as: R.self).message
    }

    public func clearNote(_ id: String) async throws {
        _ = try await api.delete("\(base)/notes?id=\(q(id))")
    }
}

/// "go to file": the query's letters in order in the path, rewarding runs, word starts and the file name
/// (the web IDE's fuzzy match)
public enum FuzzyPath {
    public static func score(_ query: String, _ path: String) -> Int? {
        let q = Array(query.lowercased().filter { !$0.isWhitespace }), p = Array(path.lowercased())
        guard !q.isEmpty else { return 0 }
        let nameStart = (path.lastIndex(of: "/").map { path.distance(from: path.startIndex, to: $0) + 1 }) ?? 0
        var score = 0, qi = 0, last = -2
        for (i, c) in p.enumerated() where qi < q.count && c == q[qi] {
            score += 1
            if i == last + 1 { score += 5 }
            if i == 0 || "/_-. ".contains(p[i - 1]) { score += 8 }
            if i >= nameStart { score += 3 }
            last = i
            qi += 1
        }
        guard qi == q.count else { return nil }
        return score * 100 - path.count
    }

    public static func rank(_ query: String, _ paths: [String], limit: Int = 50) -> [String] {
        if query.trimmingCharacters(in: .whitespaces).isEmpty { return Array(paths.prefix(limit)) }
        return paths.compactMap { p in score(query, p).map { (p, $0) } }.sorted { $0.1 > $1.1 }.prefix(limit).map(\.0)
    }
}
