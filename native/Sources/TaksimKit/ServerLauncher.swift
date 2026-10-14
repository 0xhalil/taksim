import Foundation

/// Finds or starts the taksim engine (the Node server):
/// reuse a server already on the port, else start bin/taksim.mjs with the login shell's environment (apps
/// started from Finder don't inherit PATH, and node and the agent CLIs live there), and stop it on quit.
public final class ServerLauncher: @unchecked Sendable {
    public let port: Int
    public let root: URL
    public private(set) var process: Process?
    let logURL: URL

    public enum Failure: LocalizedError {
        case portTaken(Int), noNode, didNotStart(String)
        public var errorDescription: String? {
            switch self {
            case .portTaken(let p): L("Port %d is used by another program.", p)
            case .noNode: L("Node.js was not found. Node 20+ must be installed (the engine runs on Node for now).")
            case .didNotStart(let log): L("The engine did not start; log: %@", log)
            }
        }
    }

    public init(port: Int, root: URL) {
        self.port = port
        self.root = root
        let home = ProcessInfo.processInfo.environment["TAKSIM_HOME"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appending(path: ".taksim")
        logURL = home.appending(path: "native-server.log")
    }

    public var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    /// "taksim" when our server answers, "other" when something else does, nil when nothing does.
    public func health() async -> String? {
        var req = URLRequest(url: baseURL.appending(path: "/health"))
        req.timeoutInterval = 1.5
        guard let (data, _) = try? await URLSession.shared.data(for: req) else { return nil }
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        return obj?["backends"] != nil ? "taksim" : "other"
    }

    public func ensure() async throws {
        switch await health() {
        case "taksim": return
        case "other": throw Failure.portTaken(port)
        default: break
        }
        var env = ProcessInfo.processInfo.environment.merging(Self.loginShellEnv()) { _, new in new }
        env["TAKSIM_PORT"] = String(port)
        // markers of a Claude Code session this app may have been started from (see src/config.mjs)
        for k in env.keys where k.hasPrefix("CLAUDECODE") || k.hasPrefix("CLAUDE_CODE_") || k == "ANTHROPIC_BASE_URL" { env[k] = nil }
        // a packaged app brings its own Node beside the engine; a checkout uses the one on PATH
        let bundled = root.appending(path: "runtime/node").path
        guard let node = FileManager.default.isExecutableFile(atPath: bundled) ? bundled : Self.find("node", in: env["PATH"] ?? "") else { throw Failure.noNode }

        try FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
        let log = try FileHandle(forWritingTo: logURL)
        log.seekToEndOfFile()

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [root.appending(path: "bin/taksim.mjs").path, "serve"]
        p.currentDirectoryURL = root
        p.environment = env
        p.standardOutput = log
        p.standardError = log
        try p.run()
        process = p
        for _ in 0..<60 {
            if await health() == "taksim" { return }
            try await Task.sleep(for: .milliseconds(250))
        }
        throw Failure.didNotStart(logURL.path)
    }

    /// true when the engine on the port started from older code than the checkout has now (a server left
    /// running across an update): what it says it started from vs the newest change under src/ on disk
    public func isStale() async -> Bool {
        var req = URLRequest(url: baseURL.appending(path: "/health"))
        req.timeoutInterval = 1.5
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        guard let code = obj["code"] as? Double else { return true } // older than the stamp itself
        return Self.newestChange(root.appending(path: "src")) > code + 1000
    }

    static func newestChange(_ dir: URL, kinds: Set<String> = ["mjs", "js", "py"]) -> Double {
        let fm = FileManager.default
        guard let e = fm.enumerator(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) else { return 0 }
        var newest = 0.0
        for case let u as URL in e where kinds.contains(u.pathExtension) {
            if let d = try? u.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate {
                newest = max(newest, d.timeIntervalSince1970 * 1000)
            }
        }
        return newest
    }

    /// the "↻": the engine stops (it saves and closes everything as on SIGTERM), then a new one starts from
    /// the code on disk, owned by this app
    public func restart() async throws {
        var req = URLRequest(url: baseURL.appending(path: "/v1/restart"))
        req.httpMethod = "POST"
        req.timeoutInterval = 3
        _ = try? await URLSession.shared.data(for: req)
        for _ in 0..<40 {
            if await health() == nil { break }
            try await Task.sleep(for: .milliseconds(150))
        }
        process = nil
        try await ensure()
    }

    /// Stops the server this app started (it closes its terminals and agent CLIs on SIGTERM).
    public func stop() {
        if let p = process, p.isRunning { p.terminate() }
        process = nil
    }

    /// The environment of an interactive login shell, so ~/.zshrc PATH tweaks (nvm, ~/.local/bin) apply.
    public static func loginShellEnv() -> [String: String] {
        let sh = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: sh)
        p.arguments = ["-ilc", "printf '\\0__TAKSIM_ENV__\\0'; env -0"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return [:] }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let text = String(decoding: data, as: UTF8.self)
        guard let r = text.range(of: "\0__TAKSIM_ENV__\0") else { return [:] }
        var env: [String: String] = [:]
        for entry in text[r.upperBound...].split(separator: "\0") {
            guard let eq = entry.firstIndex(of: "=") else { continue }
            env[String(entry[..<eq])] = String(entry[entry.index(after: eq)...])
        }
        return env
    }

    /// the engine inside a released app, when this is one
    public static var packedEngine: URL? {
        guard let r = Bundle.main.resourceURL?.appending(path: "engine"),
              FileManager.default.fileExists(atPath: r.appending(path: "bin/taksim.mjs").path) else { return nil }
        return r
    }

    static func find(_ bin: String, in path: String) -> String? {
        for dir in path.split(separator: ":") {
            let p = "\(dir)/\(bin)"
            if FileManager.default.isExecutableFile(atPath: p) { return p }
        }
        return nil
    }

    /// The engine: TAKSIM_ROOT, else the one packed into the app (Contents/Resources/engine, a release), else
    /// the checkout this package sits in (native/ is inside the repo).
    public static func defaultRoot(file: String = #filePath) -> URL {
        if let r = ProcessInfo.processInfo.environment["TAKSIM_ROOT"] { return URL(fileURLWithPath: r) }
        if let packed = packedEngine { return packed }
        var url = URL(fileURLWithPath: file)
        while url.path != "/" {
            url.deleteLastPathComponent()
            if FileManager.default.fileExists(atPath: url.appending(path: "bin/taksim.mjs").path) { return url }
        }
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    }
}
