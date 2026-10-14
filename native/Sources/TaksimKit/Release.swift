import Foundation

/// A version as releases are tagged: "0.2.1" or "v0.2.1"; missing parts count as 0 ("0.2" == "0.2.0").
public struct AppVersion: Comparable, CustomStringConvertible, Sendable {
    public let parts: [Int]
    public init?(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespaces).drop { $0 == "v" || $0 == "V" }
        let core = t.split(separator: "-").first.map(String.init) ?? ""
        let parts = core.split(separator: ".").map { Int($0) }
        guard !parts.isEmpty, parts.allSatisfy({ $0 != nil }) else { return nil }
        self.parts = parts.compactMap { $0 }
    }
    public var description: String { parts.map(String.init).joined(separator: ".") }
    public static func < (a: AppVersion, b: AppVersion) -> Bool {
        for i in 0..<max(a.parts.count, b.parts.count) {
            let x = i < a.parts.count ? a.parts[i] : 0, y = i < b.parts.count ? b.parts[i] : 0
            if x != y { return x < y }
        }
        return false
    }
    public static func == (a: AppVersion, b: AppVersion) -> Bool { !(a < b) && !(b < a) }

    /// this app's version (CFBundleShortVersionString); nil when not run from a built .app
    public static var current: AppVersion? {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String).flatMap(AppVersion.init)
    }
}

/// A GitHub release (GET /repos/{repo}/releases/latest): its tag is the version; the app ships as a zip asset
/// with a ".sha256" asset beside it.
public struct Release: Decodable, Sendable {
    public struct Asset: Decodable, Sendable {
        public var name: String
        public var browser_download_url: String
    }
    public var tag_name: String
    public var name: String?
    public var body: String?
    public var draft: Bool?
    public var prerelease: Bool?
    public var assets: [Asset]

    public var version: AppVersion? { AppVersion(tag_name) }
    /// the app archive and its checksum file
    public var archive: Asset? { assets.first { $0.name.hasSuffix(".zip") } }
    public var checksum: Asset? { archive.flatMap { a in assets.first { $0.name == a.name + ".sha256" } } }

    /// newer than `current`, published, and installable (an archive with its checksum)
    public func isUpdate(over current: AppVersion?) -> Bool {
        guard draft != true, prerelease != true, let v = version, archive != nil, checksum != nil else { return false }
        guard let current else { return false }
        return current < v
    }
}

/// A message from the publisher (announcements.json in the releases repository): shown once in the app,
/// as a macOS notification too when important.
public struct Announcement: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var text: String
    /// Turkish text, when the app is in Turkish
    public var tr: String?
    public var level: String?
    public var url: String?
    /// only for apps at or above / below these versions ("below" excludes it)
    public var minVersion: String?
    public var below: String?
    /// ISO 8601; after it the message is no longer shown
    public var until: String?

    public init(id: String, text: String, tr: String? = nil, level: String? = nil, url: String? = nil,
                minVersion: String? = nil, below: String? = nil, until: String? = nil) {
        self.id = id; self.text = text; self.tr = tr; self.level = level; self.url = url
        self.minVersion = minVersion; self.below = below; self.until = until
    }

    public var important: Bool { level == "important" }

    /// the messages this app hasn't seen that apply to its version, newest (last in the file) first
    public static func pending(_ all: [Announcement], version: AppVersion?, seen: Set<String>, now: Date = Date()) -> [Announcement] {
        let iso = ISO8601DateFormatter()
        let day = DateFormatter()
        day.dateFormat = "yyyy-MM-dd"
        day.locale = Locale(identifier: "en_US_POSIX")
        return all.reversed().filter { a in
            guard !seen.contains(a.id), !a.text.isEmpty else { return false }
            if let u = a.until, let d = iso.date(from: u) ?? day.date(from: u), d < now { return false }
            if let m = a.minVersion.flatMap(AppVersion.init) { guard let v = version, !(v < m) else { return false } }
            if let b = a.below.flatMap(AppVersion.init) { guard let v = version, v < b else { return false } }
            return true
        }
    }
}
