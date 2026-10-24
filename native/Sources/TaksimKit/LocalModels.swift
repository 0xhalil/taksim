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
