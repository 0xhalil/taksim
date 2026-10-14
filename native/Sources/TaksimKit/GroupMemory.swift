import Foundation

/// One entry of a group's memory (src/canvas/memory.mjs): a block of its note and who wrote it.
public struct MemoryEntry: Codable, Equatable, Sendable {
    public var text: String
    /// an agent id, or "user"
    public var by: String?
    /// epoch ms
    public var at: Double?
    public init(text: String, by: String? = "user", at: Double? = nil) { self.text = text; self.by = by; self.at = at }
}

/// The note's blocks, as the engine splits them: at blank lines and between top-level list items.
public enum GroupMemory {
    static func isItem(_ s: Substring) -> Bool {
        s.range(of: #"^(?:[-*+]|\d+[.)])\s"#, options: .regularExpression) != nil
    }

    public static func split(_ text: String) -> [String] {
        var out: [String] = [], cur: String?
        for line in text.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false) {
            if line.trimmingCharacters(in: .whitespaces).isEmpty { if let c = cur { out.append(c) }; cur = nil; continue }
            if let c = cur, isItem(line), isItem(Substring(c)) { out.append(c); cur = String(line); continue }
            cur = cur.map { "\($0)\n\(line)" } ?? String(line)
        }
        if let c = cur { out.append(c) }
        return out.map { $0.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression) }.filter { !$0.isEmpty }
    }

    /// consecutive list items stay one list; anything else is a paragraph of its own
    public static func join(_ texts: [String]) -> String {
        let parts = texts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        var s = ""
        for (i, t) in parts.enumerated() {
            if i > 0 { s += isItem(Substring(parts[i - 1])) && isItem(Substring(t)) ? "\n" : "\n\n" }
            s += t
        }
        return s
    }
}
