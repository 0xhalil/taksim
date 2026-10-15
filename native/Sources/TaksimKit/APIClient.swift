import Foundation

public struct APIError: LocalizedError, Sendable {
    public var status: Int
    public var message: String
    public var errorDescription: String? { message }
}

/// The server's REST API (src/routes/*.mjs). Errors come back as { error: { message } }.
public struct APIClient: Sendable {
    public let base: URL
    let session: URLSession

    /// a local engine: nothing to cache on disk (every response was being written to the URL cache)
    public static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.urlCache = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 3600 // event streams stay open
        return URLSession(configuration: c)
    }()

    public init(base: URL, session: URLSession = APIClient.session) {
        self.base = base
        self.session = session
    }

    public func get<T: Decodable>(_ path: String, as: T.Type = T.self) async throws -> T {
        try await send("GET", path, body: Optional<Data>.none)
    }

    @discardableResult
    public func post<T: Decodable>(_ path: String, _ body: [String: Any] = [:], as: T.Type = JSONValue.self) async throws -> T {
        try await send("POST", path, body: try JSONSerialization.data(withJSONObject: body))
    }

    @discardableResult
    public func patch<T: Decodable>(_ path: String, _ body: [String: Any], as: T.Type = JSONValue.self) async throws -> T {
        try await send("PATCH", path, body: try JSONSerialization.data(withJSONObject: body))
    }

    @discardableResult
    public func put<T: Decodable>(_ path: String, _ body: [String: Any], as: T.Type = JSONValue.self) async throws -> T {
        try await send("PUT", path, body: try JSONSerialization.data(withJSONObject: body))
    }

    @discardableResult
    public func delete(_ path: String) async throws -> JSONValue {
        try await send("DELETE", path, body: Optional<Data>.none)
    }

    func url(_ path: String) -> URL {
        let parts = path.split(separator: "?", maxSplits: 1).map(String.init)
        guard let p = parts.first else { return base }
        guard var c = URLComponents(url: base.appending(path: p), resolvingAgainstBaseURL: false) else { return base.appending(path: p) }
        if parts.count > 1 { c.percentEncodedQuery = parts[1] }
        return c.url ?? base.appending(path: p)
    }

    func send<T: Decodable>(_ method: String, _ path: String, body: Data?) async throws -> T {
        var req = URLRequest(url: url(path))
        req.httpMethod = method
        req.setValue(LangState.shared.acceptLanguage, forHTTPHeaderField: "Accept-Language")
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        let (data, res) = try await session.data(for: req)
        let status = (res as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let message = (try? JSONDecoder().decode(JSONValue.self, from: data))?["error"]?["message"]?.string
            throw APIError(status: status, message: message ?? "HTTP \(status)")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
