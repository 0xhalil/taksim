import Foundation

/// How much of a login's plan is used (src/usage.mjs): Claude's and Codex's rolling windows and Claude's
/// extra-usage spend. Keyed per login: an account's id, or "machine:<cli>".
public struct Usage: Codable, Equatable, Sendable {
    public struct Window: Codable, Equatable, Sendable, Identifiable {
        /// "5h", "week", "week_opus", "extra" (Claude's spend limit), "3d"…
        public var id: String
        /// 0…1
        public var used: Double
        /// ms since 1970; nil once it has reset
        public var resetsAt: Double?
        public init(id: String, used: Double, resetsAt: Double? = nil) { self.id = id; self.used = used; self.resetsAt = resetsAt }
    }
    public struct Credits: Codable, Equatable, Sendable { public var balance: Double? }

    public var windows: [Window]
    /// a window is full: runs on this login are refused until it resets
    public var limited: Bool?
    /// Claude is spending extra usage (past the plan)
    public var overage: Bool?
    public var plan: String?
    public var credits: Credits?
    public var checkedAt: Double?

    public init(windows: [Window], limited: Bool? = nil) { self.windows = windows; self.limited = limited }

    /// the fullest window, the one that stops work first
    public var peak: Window? { windows.max { $0.used < $1.used } }
    /// the windows a glance shows: the 5-hour one and the week (else the first two)
    public var main: [Window] {
        let picked = ["5h", "week"].compactMap { id in windows.first { $0.id == id } }
        return picked.isEmpty ? Array(windows.prefix(2)) : picked
    }

    public enum Level: Sendable { case calm, high, full }
    public static func level(_ used: Double) -> Level { used >= 0.95 ? .full : used >= 0.75 ? .high : .calm }
    public var level: Level { limited == true ? .full : Self.level(peak?.used ?? 0) }

    /// "5 hours", "Week", "Extra usage"…
    public static func name(_ id: String) -> String {
        switch id {
        case "5h": L("5 hours")
        case "week": L("Week")
        case "week_opus": L("Week · Opus")
        case "week_sonnet": L("Week · Sonnet")
        case "extra": L("Extra usage")
        default:
            if id.hasSuffix("d"), let n = Int(id.dropLast()) { L("%d days", n) }
            else if id.hasSuffix("h"), let n = Int(id.dropLast()) { L("%d hours", n) }
            else { id }
        }
    }

    /// "%52"
    public static func percent(_ used: Double) -> String { "%\(Int((used * 100).rounded()))" }

    /// how long until a window resets: "42 min", "3 hr 10 min", "2 days"
    public static func until(_ resetsAt: Double?, now: Date = Date()) -> String? {
        guard let r = resetsAt else { return nil }
        let s = r / 1000 - now.timeIntervalSince1970
        guard s > 0 else { return nil }
        let m = Int(s / 60), h = m / 60, d = h / 24
        if d >= 2 { return L("%d days", d) }
        if h >= 1 { return m % 60 == 0 || h >= 10 ? L("%d hr", h) : L("%d hr %d min", h, m % 60) }
        return L("%d min", max(1, m))
    }
}

/// who a login is: the account's name (nil: this computer's unnamed login), the email it signed in with, its plan
public struct UsageLogin: Codable, Equatable, Sendable {
    public var backend: String
    public var name: String?
    public var machine: Bool?
    public var email: String?
    public var plan: String?
    /// this computer's login is signed in as this named account: one login, shown once
    public var same: String?
    public init(backend: String, name: String? = nil, machine: Bool? = nil, email: String? = nil, plan: String? = nil) {
        self.backend = backend; self.name = name; self.machine = machine; self.email = email; self.plan = plan
    }
    /// what tells it apart at a glance: its name, else the email's name part
    public var short: String? { name ?? email.map { String($0.split(separator: "@").first ?? Substring($0)) } }
    /// the row title: its name, else the email it signed in with, else the CLI's name
    public var title: String { name ?? email ?? CanvasStore.label(of: backend) }
    /// email · plan
    public var detail: String { [email, plan].compactMap { $0 }.joined(separator: " · ") }
}

public struct UsageList: Decodable, Sendable { public var usage: [String: Usage?]; public var logins: [String: UsageLogin]? }
