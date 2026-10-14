import Foundation

// The line diff behind the IDE's "Fark" view: which lines of a file the working copy added, removed or
// rewrote against HEAD, and — inside a rewritten line — the middle that really changed. Pure text in,
// rows out; the view draws them side by side.

/// One line on one side of a diff.
public struct DiffLine: Equatable, Sendable {
    public enum Kind: String, Equatable, Sendable { case context, added, removed }
    public var kind: Kind
    /// the line's number on its own side (1-based)
    public var number: Int?
    public var text: String
    /// a rewritten line: the changed middle, as character offsets into `text` (the rest is common prefix and suffix)
    public var hot: Range<Int>?

    public init(kind: Kind, number: Int?, text: String, hot: Range<Int>? = nil) {
        self.kind = kind
        self.number = number
        self.text = text
        self.hot = hot
    }
}

/// A row of the side-by-side view: the old line, the new line, or both (a rewrite).
public struct DiffRow: Equatable, Sendable {
    public var old: DiffLine?
    public var new: DiffLine?
    public var isChange: Bool { old?.kind == .removed && new?.kind == .added }
}

public enum LineDiff {
    /// how big a change the line-by-line walk below is allowed to see; past it the middle is shown as a
    /// whole removed block followed by a whole added one (the view stays honest, only finer pairing is lost)
    static let maxCells = 1_000_000

    public static func rows(old: String, new: String) -> [DiffRow] {
        let a = lines(old), b = lines(new)
        // the unchanged head and tail step aside first: a one-line edit in a long file stays cheap
        var head = 0
        while head < a.count, head < b.count, a[head] == b[head] { head += 1 }
        var tail = 0
        while tail < a.count - head, tail < b.count - head, a[a.count - 1 - tail] == b[b.count - 1 - tail] { tail += 1 }
        let midA = Array(a[head..<(a.count - tail)]), midB = Array(b[head..<(b.count - tail)])

        var out: [DiffRow] = []
        for i in 0..<head { out.append(context(old: i + 1, new: i + 1, a[i])) }
        let ops = midA.count * midB.count <= maxCells ? walk(midA, midB) : plain(midA, midB)
        var oldNo = head + 1, newNo = head + 1
        var i = 0
        while i < ops.count {
            switch ops[i] {
            case .equal:
                out.append(context(old: oldNo, new: newNo, midA[oldNo - head - 1])); oldNo += 1; newNo += 1; i += 1
            case .del, .add:
                // a run of removed and added lines: the two sides pair up, the rest stands alone
                var dels: [String] = [], adds: [String] = []
                while i < ops.count, ops[i] != .equal {
                    if ops[i] == .del { dels.append(midA[oldNo - head - 1]); oldNo += 1 } else { adds.append(midB[newNo - head - 1]); newNo += 1 }
                    i += 1
                }
                for k in 0..<max(dels.count, adds.count) {
                    if k < dels.count, k < adds.count {
                        let hot = rewrite(dels[k], adds[k])
                        out.append(DiffRow(old: DiffLine(kind: .removed, number: oldNo - dels.count + k, text: dels[k], hot: hot.old),
                                           new: DiffLine(kind: .added, number: newNo - adds.count + k, text: adds[k], hot: hot.new)))
                    } else if k < dels.count {
                        out.append(DiffRow(old: DiffLine(kind: .removed, number: oldNo - dels.count + k, text: dels[k]), new: nil))
                    } else {
                        out.append(DiffRow(old: nil, new: DiffLine(kind: .added, number: newNo - adds.count + k, text: adds[k])))
                    }
                }
            }
        }
        for i in 0..<tail {
            let oldIndex = a.count - tail + i, newIndex = b.count - tail + i
            out.append(context(old: oldIndex + 1, new: newIndex + 1, a[oldIndex]))
        }
        return out
    }

    private static func context(old: Int, new: Int, _ text: String) -> DiffRow {
        DiffRow(old: DiffLine(kind: .context, number: old, text: text), new: DiffLine(kind: .context, number: new, text: text))
    }

    private enum Op { case equal, del, add }

    /// a plain LCS walk: the longest common subsequence as a run of equal / removed / added lines
    private static func walk(_ a: [String], _ b: [String]) -> [Op] {
        guard !a.isEmpty, !b.isEmpty else { return plain(a, b) }
        var table = [[Int]](repeating: [Int](repeating: 0, count: b.count + 1), count: a.count + 1)
        for i in stride(from: a.count - 1, through: 0, by: -1) {
            for j in stride(from: b.count - 1, through: 0, by: -1) {
                table[i][j] = a[i] == b[j] ? table[i + 1][j + 1] + 1 : max(table[i + 1][j], table[i][j + 1])
            }
        }
        var ops: [Op] = []
        var i = 0, j = 0
        while i < a.count, j < b.count {
            if a[i] == b[j] { ops.append(.equal); i += 1; j += 1 }
            else if table[i + 1][j] >= table[i][j + 1] { ops.append(.del); i += 1 }
            else { ops.append(.add); j += 1 }
        }
        while i < a.count { ops.append(.del); i += 1 }
        while j < b.count { ops.append(.add); j += 1 }
        return ops
    }

    private static func plain(_ a: [String], _ b: [String]) -> [Op] {
        [Op](repeating: .del, count: a.count) + [Op](repeating: .add, count: b.count)
    }

    /// a rewritten line pair: what stayed at the head and tail (at least one character inside), and the middle
    static func rewrite(_ old: String, _ new: String) -> (old: Range<Int>?, new: Range<Int>?) {
        let a = Array(old), b = Array(new)
        var head = 0
        while head < a.count, head < b.count, a[head] == b[head] { head += 1 }
        var tail = 0
        while tail < a.count - head, tail < b.count - head, a[a.count - 1 - tail] == b[b.count - 1 - tail] { tail += 1 }
        // nothing in common before or after: the whole line is the change, already painted as one
        guard head > 0 || tail > 0 else { return (nil, nil) }
        let oldHot = head..<max(head, a.count - tail)
        let newHot = head..<max(head, b.count - tail)
        return (oldHot.isEmpty ? nil : oldHot, newHot.isEmpty ? nil : newHot)
    }

    /// the text's lines, with a trailing newline's empty line left out
    static func lines(_ text: String) -> [String] {
        var l = text.components(separatedBy: "\n")
        if l.count > 1, l.last == "" { l.removeLast() }
        return text.isEmpty ? [] : l
    }
}
