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
    /// the CLI it was begun in ("claude", "codex", "copilot", "gemini") when that was outside taksim; nil for one of taksim's
    public var source: String?
    /// the folder it worked in (what "by project" groups on) and when it began
    public var cwd: String?
    public var createdAt: Double?

    public init(id: String, title: String, name: String, model: String? = nil, backend: String? = nil, folder: String? = nil,
                canvas: CanvasRef? = nil, lastText: String? = nil, messages: Int? = nil, lastAt: Double? = nil,
                source: String? = nil, cwd: String? = nil, createdAt: Double? = nil) {
        self.id = id; self.title = title; self.name = name; self.model = model; self.backend = backend; self.folder = folder
        self.canvas = canvas; self.lastText = lastText; self.messages = messages; self.lastAt = lastAt
        self.source = source; self.cwd = cwd; self.createdAt = createdAt
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

/// How the history is laid out: in date sections or one section per project, newest activity or newest start first.
public enum HistoryGrouping: String, CaseIterable, Sendable { case date, project }
public enum HistorySorting: String, CaseIterable, Sendable { case lastActive, created }

public struct HistorySection: Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var items: [PastConversation]
}

extension PastConversation {
    /// what a row carries when dragged out of the sidebar (a plain string, told apart from a tab's id)
    public var dragPayload: String { "taksim-history:" + id }
    public static func id(fromDrag s: String) -> String? {
        s.hasPrefix("taksim-history:") ? String(s.dropFirst("taksim-history:".count)) : nil
    }

    /// the moment it is sorted and dated by
    public func time(_ sorting: HistorySorting) -> Double { (sorting == .created ? createdAt : nil) ?? lastAt ?? 0 }

    /// the list in sections, as the Claude app shows it: Today, Yesterday, Previous 7 days, Previous 30 days, then
    /// month by month; or by project (its folder), the project worked in last first, "No folder" at the end
    public static func sections(_ list: [PastConversation], by grouping: HistoryGrouping, sort: HistorySorting,
                                now: Date = Date(), calendar cal: Calendar = .current) -> [HistorySection] {
        let sorted = list.sorted { $0.time(sort) > $1.time(sort) }
        var out: [HistorySection] = []
        func add(_ id: String, _ title: String, _ c: PastConversation) {
            if let i = out.firstIndex(where: { $0.id == id }) { out[i].items.append(c) } else { out.append(HistorySection(id: id, title: title, items: [c])) }
        }
        switch grouping {
        case .date:
            let today = cal.startOfDay(for: now)
            let f = DateFormatter()
            f.locale = Locale(identifier: LangState.shared.current == .turkish ? "tr_TR" : "en_US")
            for c in sorted {
                let d = Date(timeIntervalSince1970: c.time(sort) / 1000)
                let days = cal.dateComponents([.day], from: cal.startOfDay(for: d), to: today).day ?? 0
                switch days {
                case ...0: add("today", L("Today"), c)
                case 1: add("yesterday", L("Yesterday"), c)
                case 2...7: add("week", L("Previous 7 days"), c)
                case 8...30: add("month", L("Previous 30 days"), c)
                default:
                    f.setLocalizedDateFormatFromTemplate(cal.isDate(d, equalTo: now, toGranularity: .year) ? "MMMM" : "MMMM y")
                    let m = cal.dateComponents([.year, .month], from: d)
                    add("m\(m.year ?? 0)-\(m.month ?? 0)", f.string(from: d), c)
                }
            }
        case .project:
            for c in sorted where c.cwd != nil || c.folder != nil {
                add("p:" + (c.cwd ?? c.folder ?? ""), c.folder ?? (c.cwd.map { ($0 as NSString).lastPathComponent } ?? ""), c)
            }
            for c in sorted where c.cwd == nil && c.folder == nil { add("p:", L("No folder"), c) }
        }
        return out
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
        // one begun in a CLI itself continues on the model last picked here for that CLI
        var models: [String: String] = [:]
        for b in ["claude", "codex", "copilot", "gemini", "opencode"] { if let m = preferences.string(forKey: "lastModel.\(b)") { models[b] = m } }
        if !models.isEmpty { body["models"] = models }
        let a: Agent = try await api.post("\(canvasPath)/history/\(id)", body, as: Agent.self)
        if agents[a.id] == nil { order.append(a.id) }
        agents[a.id] = a
        return a
    }

    /// gone for good
    public func forgetConversation(_ id: String) async throws { _ = try await api.delete("/v1/history/\(id)") }
}
