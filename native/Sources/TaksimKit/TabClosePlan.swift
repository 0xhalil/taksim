import Foundation

/// Computes one navigation transition for a batch close; locked tabs always survive.
public struct TabClosePlan {
    public let closing: Set<String>
    public let next: String?
    public init(requested: Set<String>, ordered: [String], locked: Set<String>, current: String?) {
        let closing = requested.intersection(Set(ordered)).subtracting(locked)
        self.closing = closing
        guard let current, closing.contains(current) else { next = current; return }
        let index = ordered.firstIndex(of: current) ?? 0
        next = ordered.dropFirst(index + 1).first { !closing.contains($0) }
            ?? ordered.prefix(index).reversed().first { !closing.contains($0) }
    }
}
