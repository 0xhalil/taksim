import Foundation

/// Where getting a local model stands (GET /v1/local, src/local-setup.mjs): Ollama installed, running, which models
/// are there, the one suited to this Mac, and what is under way.
public struct LocalState: Decodable, Equatable, Sendable {
    public struct Ollama: Decodable, Equatable, Sendable { public var installed: Bool; public var app: Bool; public var running: Bool }
    public struct Pick: Decodable, Equatable, Sendable { public var model: String; public var gb: Double }
    public struct Job: Decodable, Equatable, Sendable {
        public var running: Bool
        public var error: String?
        public var model: String?
        public var completed: Double?
        public var total: Double?
        public var done: Bool?
        /// 0…1 while bytes come in
        public var fraction: Double? { guard let t = total, t > 0, let c = completed else { return nil }; return min(1, c / t) }
    }
    public var ollama: Ollama
    public var canInstall: Bool
    public var models: [String]
    public var recommended: Pick
    public var memoryGB: Int?
    public var freeGB: Double?
    public var install: Job?
    public var start: Job?
    public var pull: Job?
    /// every server looked at, with what it serves (Settings)
    public var servers: [Server]?

    public struct Server: Decodable, Equatable, Sendable, Identifiable {
        public struct Model: Decodable, Equatable, Sendable, Identifiable {
            public var id: String
            public var sizeGB: Double?
            public var params: String?
            public var tools: Bool?
            public var window: Int?
            public var max: Int?
        }
        public var url: String
        public var builtIn: Bool
        public var running: Bool
        public var kind: String?
        public var models: [Model]
        public var id: String { url }

        /// what it is called: the program its port is known for, else host:port
        public var name: String {
            guard let u = URL(string: url), let host = u.host else { return url }
            let local = ["127.0.0.1", "localhost", "::1"].contains(host)
            if local, let p = u.port, let known = [11434: "Ollama", 1234: "LM Studio", 8080: "llama.cpp", 8000: "vLLM", 1337: "Jan"][p] { return known }
            return u.port.map { "\(host):\($0)" } ?? host
        }
    }

    /// the one thing that gets a local model going from here
    public enum Step: Equatable, Sendable { case ready, install, download, start, pull(String), busy }
    public var step: Step {
        if !models.isEmpty { return .ready }
        if install?.running == true || start?.running == true || pull?.running == true { return .busy }
        if !ollama.installed { return canInstall ? .install : .download }
        if !ollama.running { return .start }
        return .pull(recommended.model)
    }
    /// the last thing that went wrong, as the engine said it
    public var problem: String? { pull?.error ?? start?.error ?? install?.error }
}

extension CanvasStore {
    public func localState() async throws -> LocalState { try await api.get("/v1/local", as: LocalState.self) }
    public func installOllama() async throws { _ = try await api.post("/v1/local/install") }
    public func startOllama() async throws { _ = try await api.post("/v1/local/start") }
    public func pullLocalModel(_ model: String) async throws { _ = try await api.post("/v1/local/pull", ["model": model]) }
}

/// the same calls from Settings, which has the engine's address but no canvas store
extension APIClient {
    public func localState() async throws -> LocalState { try await get("/v1/local", as: LocalState.self) }
    public func addLocalServer(_ url: String) async throws { _ = try await post("/v1/local/servers", ["url": url]) }
    public func removeLocalServer(_ url: String) async throws { _ = try await post("/v1/local/servers/remove", ["url": url]) }
    public func deleteLocalModel(_ id: String) async throws { _ = try await post("/v1/local/delete", ["model": id]) }
    public func installOllama() async throws { _ = try await post("/v1/local/install") }
    public func startOllama() async throws { _ = try await post("/v1/local/start") }
    public func pullLocalModel(_ model: String) async throws { _ = try await post("/v1/local/pull", ["model": model]) }
}
