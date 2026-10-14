import Foundation

// What the view bricks do with data before drawing it (ui/canvas/bricks.mjs): paths into rows, values as short
// text, the color a word implies, a small safe markdown. No UI here, so it is tested on its own.

public enum Tone: String, Sendable { case none, good, warn, bad }

public enum Bricks {
    /// a dotted path into a value ("status.phase"); empty means the value itself
    public static func get(_ v: JSONValue, _ path: String?) -> JSONValue? {
        guard let path, !path.isEmpty else { return v }
        var cur: JSONValue? = v
        for k in pathKeys(path) {
            guard let c = cur else { return nil }
            if case .array(let a) = c, let i = Int(k) { cur = a.indices.contains(i) ? a[i] : nil } else { cur = c[k] }
        }
        return cur
    }

    /// a value as one line of text, cut at `max` characters
    public static func show(_ v: JSONValue?, max: Int = 160) -> String {
        let s: String
        switch v {
        case nil, .null?: return ""
        case .string(let x)?: s = x
        case .number(let n)?: s = number(n)
        case .bool(let b)?: s = b ? "true" : "false"
        case let x?: s = compact(x)
        }
        return s.count > max ? String(s.prefix(max - 1)) + "…" : s
    }

    /// a number as JavaScript prints it: no ".0" on whole numbers
    public static func number(_ n: Double) -> String {
        if n.isNaN { return "NaN" }
        if n == n.rounded(), abs(n) < 1e15 { return String(Int64(n)) }
        return String(n)
    }

    /// JSON on one line (JSON.stringify)
    public static func compact(_ v: JSONValue) -> String {
        switch v {
        case .null: "null"
        case .bool(let b): b ? "true" : "false"
        case .number(let n): number(n)
        case .string(let s): quote(s)
        case .array(let a): "[" + a.map(compact).joined(separator: ",") + "]"
        case .object(let o): "{" + o.map { quote($0.0) + ":" + compact($0.1) }.joined(separator: ",") + "}"
        }
    }

    /// JSON indented by two spaces (JSON.stringify(x, null, 2))
    public static func pretty(_ v: JSONValue, _ indent: String = "") -> String {
        let inner = indent + "  "
        switch v {
        case .array(let a) where !a.isEmpty:
            return "[\n" + a.map { inner + pretty($0, inner) }.joined(separator: ",\n") + "\n" + indent + "]"
        case .object(let o) where !o.isEmpty:
            return "{\n" + o.map { inner + quote($0.0) + ": " + pretty($0.1, inner) }.joined(separator: ",\n") + "\n" + indent + "}"
        default:
            return compact(v)
        }
    }

    static func quote(_ s: String) -> String {
        var out = "\""
        for c in s.unicodeScalars {
            switch c {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case _ where c.value < 0x20: out += String(format: "\\u%04x", c.value)
            default: out.unicodeScalars.append(c)
            }
        }
        return out + "\""
    }

    // short words that say how something is doing get a color, whatever the source
    static let bad = try! NSRegularExpression(pattern: "^(error|err|fail(ed|ure)?|crash\\w*|down|exited.*|dead|oomkilled|critical|fatal|unhealthy|imagepullbackoff|errimagepull|evicted|false)$", options: .caseInsensitive)
    static let warn = try! NSRegularExpression(pattern: "^(warn(ing)?|pending|degraded|restarting|unknown|slow|terminating|containercreating|backoff)$", options: .caseInsensitive)
    static let good = try! NSRegularExpression(pattern: "^(ok|up.*|running|ready|healthy|active|succeeded|success|pass(ed)?|true|completed|bound|available)$", options: .caseInsensitive)

    public static func tone(_ v: JSONValue?) -> Tone {
        guard let s = v?.string?.trimmingCharacters(in: .whitespaces), !s.isEmpty, s.count <= 40 else { return .none }
        let first = String(s.split(whereSeparator: { $0 == " " || $0 == "(" }).first ?? Substring(s))
        func m(_ r: NSRegularExpression, _ x: String) -> Bool { r.firstMatch(in: x, range: NSRange(x.startIndex..., in: x)) != nil }
        if m(bad, s) || m(bad, first) { return .bad }
        if m(warn, s) || m(warn, first) { return .warn }
        if m(good, s) || m(good, first) { return .good }
        return .none
    }

    /// a source's data as rows: a list as it is, nothing as none, anything else as one row
    public static func rows(_ data: JSONValue) -> [JSONValue] {
        switch data {
        case .array(let a): a
        case .null: []
        default: [data]
        }
    }
    /// a row that isn't an object is {value: it}
    public static func asRow(_ r: JSONValue) -> JSONValue { r.object != nil ? r : .object(["value": r]) }

    /// the view's columns, or the fields of the first rows (up to 12, in the order they came)
    public static func columns(_ view: BrickSpec, rows: [JSONValue]) -> [Column] {
        if let c = view.columns() { return c }
        var seen: [String] = []
        for r in rows.prefix(30) { for k in r.object?.keys ?? [] where !seen.contains(k) { seen.append(k) } }
        return seen.prefix(12).map { Column(field: $0, label: $0) }
    }

    /// rows sorted by a field: numerically when both are numbers, else as text
    public static func sorted(_ rows: [JSONValue], by field: String, descending: Bool) -> [JSONValue] {
        func num(_ v: JSONValue?) -> Double? { let n = parseNum(v); return n.isFinite ? n : nil }
        let s = rows.enumerated().sorted { a, b in
            let x = get(a.element, field), y = get(b.element, field)
            let r: ComparisonResult
            if let nx = num(x), let ny = num(y) { r = nx < ny ? .orderedAscending : nx > ny ? .orderedDescending : .orderedSame }
            else { r = show(x).localizedStandardCompare(show(y)) }
            if r == .orderedSame { return a.offset < b.offset }
            return descending ? r == .orderedDescending : r == .orderedAscending
        }
        return s.map(\.element)
    }

    /// table: up to 500 rows, each with a stable id: its key (the `key` field, else the first column), numbered
    /// with "\0n" when the key repeats
    public static func keyed(_ rows: [JSONValue], key: String?) -> [(id: String, row: JSONValue)] {
        var seen: [String: Int] = [:]
        return rows.prefix(500).map { r in
            let k = show(get(r, key), max: 400)
            let n = seen[k, default: 0]
            seen[k] = n + 1
            return (n == 0 ? k : "\(k)\u{0}\(n)", r)
        }
    }

    /// log: how many of the old lines the new ones start with (the old list's tail is the new one's head), so
    /// only the lines before that overlap go and only the ones after it come; 0 when nothing lines up
    public static func appendOverlap<T: Equatable>(old: [T], new: [T]) -> Int {
        guard let last = old.last, !new.isEmpty else { return 0 }
        // where the old last line sits in the new list; the latest place that lines up wins
        var j = min(new.count, old.count) - 1
        while j >= 0 {
            if new[j] == last, new[...j].elementsEqual(old[(old.count - 1 - j)...]) { return j + 1 }
            j -= 1
        }
        return 0
    }

    /// stat: the value (a field of the first row, else a list's length, else the data) and its color
    public static func stat(_ view: BrickSpec, _ data: JSONValue) -> (text: String, tone: Tone) {
        var v: JSONValue?
        if let path = view.string("value") { v = get(data.array?.first ?? data, path) }
        else if let a = data.array { v = .number(Double(a.count)) }
        else { v = data }
        if let x = v, x.object != nil || x.array != nil { v = .string(compact(x)) }
        let empty = v == nil || v == .null || v == .string("")
        let n: Double? = empty ? nil : (v?.number ?? v?.string.flatMap { Double($0) } ?? (v?.bool).map { $0 ? 1 : 0 })
        var tone = Tone.none
        if let ok = view["ok"], !empty { tone = show(v) == show(ok) ? .good : .warn }
        let warnAbove = view.number("warn_above"), errAbove = view.number("error_above")
        if let n, let e = errAbove, n > e { tone = .bad }
        else if let n, let w = warnAbove, n > w { tone = .warn }
        else if n != nil, warnAbove != nil || errAbove != nil, tone == .none { tone = .good }
        if tone == .none { tone = Bricks.tone(v) }
        let text = (show(v, max: 40).isEmpty ? "—" : show(v, max: 40)) + (view.string("unit").map { " \($0)" } ?? "")
        return (text, tone)
    }

    /// kv: label/value pairs of an object (the first row of a list)
    public static func pairs(_ view: BrickSpec, _ data: JSONValue) -> [(label: String, value: JSONValue?)] {
        let o = asRow(data.array?.first ?? data)
        let cols = view.columns("fields") ?? (o.object?.keys ?? []).prefix(30).map { Column(field: $0, label: $0) }
        return cols.map { ($0.label, get(o, $0.field)) }
    }

    /// log: a row's level and text
    static let levelNames = ["warning": "warn", "critical": "crit", "emergency": "emerg", "information": "info", "default": "log"]

    /// log: a row's level (abbreviated) and text; `text` may be a list of paths, the first non-empty wins
    public static func line(_ view: BrickSpec, _ r: JSONValue) -> (level: String, text: String, tone: Tone) {
        let text: String
        if let paths = view.paths("text") { text = show(first(r, paths), max: 2000) }
        else if r.object != nil { text = r["text"].map { show($0, max: 2000) } ?? compact(r) }
        else { text = show(r, max: 2000) }
        let raw = view.string("level").flatMap { get(r, $0) }
        let level = (raw.map { truthy($0) ? show($0, max: 100_000) : "" } ?? "").lowercased()
        let tone: Tone = level.range(of: "err|fatal|crit|panic|alert|emerg", options: .regularExpression) != nil ? .bad
            : level.contains("warn") ? .warn : .none
        return (levelNames[level] ?? String(level.prefix(5)), text, tone)
    }

    /// the first of several paths that holds something (not missing, null or "")
    public static func first(_ r: JSONValue, _ paths: [String]) -> JSONValue? {
        paths.lazy.compactMap { get(r, $0) }.first { $0 != .null && $0 != .string("") }
    }

    /// JavaScript's truthiness, for `x || y`
    static func truthy(_ v: JSONValue?) -> Bool {
        switch v {
        case nil, .null?, .bool(false)?, .string("")?: false
        case .number(let n)?: n != 0 && !n.isNaN
        default: true
        }
    }

    /// "a.b.0.c" -> a, b, 0, c; a key with dots goes in brackets: "metadata.labels[app.kubernetes.io/name]"
    /// a path's keys; parsed once per path (tables ask for every cell on every redraw)
    public static func pathKeys(_ path: String) -> [String] {
        pathLock.lock(); defer { pathLock.unlock() }
        if let k = pathCache[path] { return k }
        let k = path.matches(of: #/\[([^\]]*)\]|[^.\[\]]+/#).map { m in m.1.map(String.init) ?? String(m.0) }
        if pathCache.count > 4000 { pathCache.removeAll() }
        pathCache[path] = k
        return k
    }
    nonisolated(unsafe) private static var pathCache: [String: [String]] = [:]
    private static let pathLock = NSLock()

    /// "now", "12 s ago" … (panels.mjs ago)
    public static func ago(_ ts: Double?, now: Date = Date()) -> String {
        guard let ts else { return "" }
        let s = Int(((now.timeIntervalSince1970 * 1000 - ts) / 1000).rounded())
        return s < 5 ? L("now") : s < 60 ? L("%d sec ago", s) : s < 3600 ? L("%d min ago", Int((Double(s) / 60).rounded())) : L("%d hr ago", Int((Double(s) / 3600).rounded()))
    }
}

// ---------- markdown ----------

/// A small, safe markdown (bricks.mjs markdown): headings, lists (with [ ] / [x]), quotes, code blocks,
/// **bold**, *em*, `code`. Text only, never HTML.
public enum MD {
    public enum Block: Equatable, Sendable {
        case heading(level: Int, [Span])
        case paragraph([Span])
        case list(ordered: Bool, [Item])
        case quote([Span])
        case code(String)
    }
    public struct Item: Equatable, Sendable {
        public var spans: [Span]
        /// nil: a plain item · false: to do · true: done
        public var checked: Bool?
    }
    public enum Span: Equatable, Sendable { case text(String), bold(String), em(String), code(String) }

    public static func parse(_ src: String) -> [Block] {
        var out: [Block] = []
        let lines = src.replacingOccurrences(of: "\r", with: "").components(separatedBy: "\n")
        var para: [String] = []
        var list: (ordered: Bool, items: [Item])?
        func flushPara() { if !para.isEmpty { out.append(.paragraph(inline(para.joined(separator: " ")))); para = [] } }
        func flushList() { if let l = list { out.append(.list(ordered: l.ordered, l.items)); list = nil } }
        func flush() { flushPara(); flushList() }
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if line.hasPrefix("```") {
                flush()
                var code: [String] = []
                i += 1
                while i < lines.count, !lines[i].hasPrefix("```") { code.append(lines[i]); i += 1 }
                out.append(.code(code.joined(separator: "\n")))
                i += 1
                continue
            }
            if let m = line.firstMatch(of: #/^(#{1,4})\s+(.*)$/#) {
                flush()
                out.append(.heading(level: m.1.count, inline(String(m.2))))
            } else if let m = line.firstMatch(of: #/^\s*(?:[-*]|(\d+)\.)\s+(.*)$/#) {
                flushPara()
                let ordered = m.1 != nil
                if list?.ordered != ordered { flushList(); list = (ordered, []) }
                var text = String(m.2), checked: Bool?
                if let b = text.firstMatch(of: #/^\[([ xX])\]\s+(.*)$/#) { checked = b.1 != " "; text = String(b.2) }
                list?.items.append(Item(spans: inline(text), checked: checked))
            } else if line.hasPrefix(">") {
                flush()
                out.append(.quote(inline(String(line.dropFirst().drop { $0 == " " }))))
            } else if line.trimmingCharacters(in: .whitespaces).isEmpty {
                flush()
            } else {
                flushList()
                para.append(line.trimmingCharacters(in: .whitespaces))
            }
            i += 1
        }
        flush()
        return out
    }

    public static func inline(_ text: String) -> [Span] {
        var out: [Span] = []
        var rest = Substring(text)
        let token = #/\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*/#
        while let m = rest.firstMatch(of: token) {
            if m.range.lowerBound > rest.startIndex { out.append(.text(String(rest[..<m.range.lowerBound]))) }
            let t = String(m.0)
            if t.hasPrefix("**") { out.append(.bold(String(t.dropFirst(2).dropLast(2)))) }
            else if t.hasPrefix("`") { out.append(.code(String(t.dropFirst().dropLast()))) }
            else { out.append(.em(String(t.dropFirst().dropLast()))) }
            rest = rest[m.range.upperBound...]
        }
        if !rest.isEmpty { out.append(.text(String(rest))) }
        return out
    }
}
