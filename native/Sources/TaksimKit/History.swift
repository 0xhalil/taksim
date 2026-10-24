import Foundation

/// A past conversation: an agent taken off its canvas (removed, or its canvas closed), kept with what was said so it
/// can be found again and continued (src/canvas/history.mjs).
public struct PastConversation: Decodable, Equatable, Identifiable, Sendable {
    public struct CanvasRef: Decodable, Equatable, Sendable { public var id: String; public var name: String? }
    public var id: String
    public var title: String
    public var name: String
    public var model: String?
    public var backend: String?
    public var folder: String?
    public var canvas: CanvasRef?
    public var lastText: String?
    public var messages: Int?
    public var lastAt: Double?
    /// "claude-code": begun in Claude Code or the Claude app, not on a canvas
    public var source: String?

    public init(id: String, title: String, name: String, model: String? = nil, backend: String? = nil, folder: String? = nil,
                canvas: CanvasRef? = nil, lastText: String? = nil, messages: Int? = nil, lastAt: Double? = nil) {
        self.id = id; self.title = title; self.name = name; self.model = model; self.backend = backend; self.folder = folder
        self.canvas = canvas; self.lastText = lastText; self.messages = messages; self.lastAt = lastAt
    }

    /// "now", "5 min", "3 hr", "Yesterday", "4 days", then the date: how the Claude app dates its conversations
    public static func when(_ ms: Double?, now: Date = Date()) -> String {
        guard let ms else { return "" }
        let date = Date(timeIntervalSince1970: ms / 1000)
        let s = max(0, now.timeIntervalSince(date).rounded())
        if s < 60 { return L("now") }
        if s < 3600 { return L("%d min", Int(s / 60)) }
        let cal = Calendar.current
        if cal.isDate(date, inSameDayAs: now) { return L("%d hr", Int(s / 3600)) }
        if let y = cal.date(byAdding: .day, value: -1, to: now), cal.isDate(date, inSameDayAs: y) { return L("Yesterday") }
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: date), to: cal.startOfDay(for: now)).day ?? 0
        if days < 7 { return L("%d days", days) }
        let f = DateFormatter()
        f.locale = Locale(identifier: LangState.shared.current == .turkish ? "tr_TR" : "en_US")
        f.setLocalizedDateFormatFromTemplate(cal.isDate(date, equalTo: now, toGranularity: .year) ? "d MMM" : "d MMM y")
        return f.string(from: date)
    }
}

extension CanvasStore {
    private struct HistoryList: Decodable { var conversations: [PastConversation] }

    /// the past conversations, newest first; `query` finds them by title, name, folder or anything said in them
    public func history(matching query: String = "") async throws -> [PastConversation] {
        let q = query.trimmingCharacters(in: .whitespaces)
        let path = q.isEmpty ? "/v1/history" : "/v1/history?q=\(q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+?"))) ?? "")"
        return try await api.get(path, as: HistoryList.self).conversations
    }

    /// that conversation continued on the open canvas near `at`: the agent comes back with its chat and session
    public func continueConversation(_ id: String, at: CGPoint) async throws -> Agent {
        var body: [String: Any] = ["pos": [at.x.rounded(), at.y.rounded()]]
        // one begun in Claude Code continues on the Claude model last picked here
        if let m = preferences.string(forKey: "lastModel.claude") { body["model"] = m }
        let a: Agent = try await api.post("\(canvasPath)/history/\(id)", body, as: Agent.self)
        if agents[a.id] == nil { order.append(a.id) }
        agents[a.id] = a
        return a
    }

    /// gone for good
    public func forgetConversation(_ id: String) async throws { _ = try await api.delete("/v1/history/\(id)") }
}
