import Foundation

// Numbers, times and rankings for the animated bricks (chart, timeline, bars, table): a port of the exported
// helpers in ui/canvas/bricks.mjs (parseNum … timeTicks), tested against the same cases as
// test/panels.test.mjs. Times are epoch milliseconds, as in the page; NaN means "none", as there.

extension Bricks {
    // ---------- reading values ----------

    static let qty: [String: Double] = ["m": 1e-3, "k": 1e3, "K": 1e3, "M": 1e6, "G": 1e9, "T": 1e12, "P": 1e15,
                                        "Ki": 1024, "Mi": pow(1024, 2), "Gi": pow(1024, 3), "Ti": pow(1024, 4), "Pi": pow(1024, 5)]
    static let numRe = #/^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(?:(Ki|Mi|Gi|Ti|Pi|[mkKMGTP])B?|%|B)?(?=$|[\s(,/])/#

    /// A number from a value: 12, "12.5", "250m" (milli, k8s CPU), "512Mi"/"1.5GB" (sizes), "37%", "14 (2m ago)".
    public static func parseNum(_ v: JSONValue?) -> Double {
        switch v {
        case .number(let n)?: return n
        case .bool(let b)?: return b ? 1 : 0
        case .string(let s)?:
            guard let m = s.trimmingCharacters(in: .whitespacesAndNewlines).prefixMatch(of: numRe), let n = Double(m.1) else { return .nan }
            return n * (m.2.flatMap { qty[String($0)] } ?? 1)
        default: return .nan
        }
    }

    static let unitS: [String: Double] = ["ms": 0.001, "s": 1, "sec": 1, "m": 60, "min": 60, "h": 3600, "d": 86400, "w": 604800, "y": 31536000]

    /// Seconds from a duration: 90, "90", "90s", "1m30s", "2h", "3d4h", "250ms", "01:02:03".
    public static func parseDuration(_ v: JSONValue?) -> Double {
        switch v {
        case .number(let n)?: return n
        case .string(let raw)?:
            let s = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if s.wholeMatch(of: #/\d+(\.\d+)?/#) != nil { return Double(s) ?? .nan }
            if s.wholeMatch(of: #/\d+:\d{2}(:\d{2})?/#) != nil {
                return s.split(separator: ":").reduce(0) { $0 * 60 + (Double($1) ?? 0) }
            }
            guard s.wholeMatch(of: #/(\d+(\.\d+)?\s*(ms|sec|min|s|m|h|d|w|y)\s*)+/#) != nil else { return .nan }
            return s.matches(of: #/(\d+(\.\d+)?)\s*(ms|sec|min|s|m|h|d|w|y)/#).reduce(0) { $0 + (Double($1.1) ?? 0) * (unitS[String($1.3)] ?? 0) }
        default: return .nan
        }
    }

    /// Epoch ms from a time: ISO/date text, epoch seconds or ms (number or digits), "now", or an age the way
    /// CLIs print it ("47m", "2d3h", "5m ago", kubectl AGE), counted back from now.
    public static func parseTime(_ v: JSONValue?, now: Double = Date().timeIntervalSince1970 * 1000) -> Double {
        switch v {
        case .number(let n)?: return n.isFinite ? (abs(n) < 1e11 ? n * 1000 : n) : .nan
        case .string(let raw)?:
            let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if s.isEmpty { return .nan }
            if s.wholeMatch(of: #/\d+(\.\d+)?/#) != nil { return parseTime(.number(Double(s) ?? .nan), now: now) }
            if s.wholeMatch(of: #/(?i)now|just now|şimdi/#) != nil { return now }
            let age = parseDuration(.string(s.replacing(#/(?i)\s*(ago|önce)$/#, with: "")))
            if age.isFinite, s.contains(where: { $0.isASCII && $0.isLetter }) { return now - age * 1000 }
            return dateParse(s)
        default: return .nan
        }
    }

    /// what JavaScript's Date.parse reads from CLIs and APIs: ISO 8601 (a date alone is UTC midnight, a time
    /// without a zone is local), RFC 2822
    static func dateParse(_ s: String) -> Double {
        let iso = ISO8601DateFormatter()
        for o: ISO8601DateFormatter.Options in [[.withInternetDateTime, .withFractionalSeconds], [.withInternetDateTime]] {
            iso.formatOptions = o
            if let d = iso.date(from: s) { return d.timeIntervalSince1970 * 1000 }
        }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        let formats: [(String, TimeZone?)] = [
            ("yyyy-MM-dd", TimeZone(identifier: "UTC")), ("yyyy-MM", TimeZone(identifier: "UTC")),
            ("yyyy-MM-dd'T'HH:mm:ss.SSS", nil), ("yyyy-MM-dd'T'HH:mm:ss", nil), ("yyyy-MM-dd'T'HH:mm", nil),
            ("yyyy-MM-dd HH:mm:ss.SSS", nil), ("yyyy-MM-dd HH:mm:ss", nil), ("yyyy-MM-dd HH:mm", nil),
            ("yyyy-MM-dd HH:mm:ssZ", nil), ("yyyy-MM-dd HH:mm:ss Z", nil), ("EEE, dd MMM yyyy HH:mm:ss Z", nil),
            ("EEE MMM d HH:mm:ss yyyy", nil), ("EEE MMM d HH:mm:ss zzz yyyy", nil),
        ]
        for (fmt, tz) in formats {
            f.dateFormat = fmt
            f.timeZone = tz ?? .current
            if let d = f.date(from: s) { return d.timeIntervalSince1970 * 1000 }
        }
        return .nan
    }

    // ---------- turning rows into numbers ----------

    /// How rows become one number: count | sum | avg | max | min | last. nil is a missing value.
    public static func aggregate(_ values: [JSONValue?], _ agg: String?) -> Double {
        if agg == "count" { return Double(values.filter { v in v != nil && v != .null && v != .string("") && v != .bool(false) }.count) }
        let n = values.map(parseNum).filter(\.isFinite)
        guard !n.isEmpty else { return .nan }
        switch agg {
        case "avg": return n.reduce(0, +) / Double(n.count)
        case "max": return n.max()!
        case "min": return n.min()!
        case "last": return n.last!
        default: return n.reduce(0, +)
        }
    }

    /// a chart's series: its y paths, or one series of the rows/value itself
    public static func yPaths(_ view: BrickSpec) -> [String?] { view.paths("y") ?? [nil] }

    /// chart: one refresh of a source -> one number per series (view.y). A list: agg over its rows (default
    /// count without y, sum with y); an object: the value at y; a plain value: itself. Times view.scale.
    public static func measure(_ data: JSONValue, _ view: BrickSpec) -> [Double] {
        let s = view.number("scale") ?? 1
        let scale = s == 0 || s.isNaN ? 1 : s
        return yPaths(view).map { y in
            var v: Double
            if let rows = data.array {
                let agg = view.string("agg") ?? (y == nil ? "count" : "sum")
                if let y { v = aggregate(rows.map { get($0, y) }, agg) }
                else { v = agg == "count" ? Double(rows.count) : aggregate(rows, agg) }
            } else {
                let x = y == nil ? data : get(data, y)
                v = x?.array.map { Double($0.count) } ?? parseNum(x)
            }
            return v.isFinite ? v * scale : .nan
        }
    }

    public struct Point: Equatable, Sendable { public var t: Double; public var v: [Double] }

    /// chart with x: rows that carry their own time; rows with the same time are one point (agg as above).
    public static func points(_ data: JSONValue, _ view: BrickSpec, now: Double = Date().timeIntervalSince1970 * 1000) -> [Point] {
        var order: [Double] = [], groups: [Double: [JSONValue]] = [:]
        for r in data.array ?? [] {
            let t = parseTime(get(r, view.string("x")), now: now)
            guard t.isFinite else { continue }
            if groups[t] == nil { order.append(t) }
            groups[t, default: []].append(r)
        }
        return order.sorted().map { Point(t: $0, v: measure(.array(groups[$0]!), view)) }
    }

    public struct Ranked: Equatable, Sendable {
        public var label: String
        public var value: Double
        /// one row with a unit ("250m", "512Mi"): shown as written
        public var raw: String?
    }

    /// bars: rows -> ranked, rows with the same label summed (counted without value)
    public static func ranked(_ data: JSONValue, _ view: BrickSpec) -> [Ranked] {
        let valuePath = view.string("value").flatMap { $0.isEmpty ? nil : $0 }
        let agg = view.string("agg") ?? (valuePath != nil ? "sum" : "count")
        var order: [String] = [], groups: [String: [JSONValue?]] = [:]
        for r0 in rows(data) {
            let r = asRow(r0)
            let l = show(get(r, view.string("label")), max: 80)
            let label = l.isEmpty ? "—" : l
            if groups[label] == nil { order.append(label) }
            groups[label, default: []].append(valuePath.map { get(r, $0) } ?? r)
        }
        var out = order.map { label -> Ranked in
            let vals = groups[label]!
            let value = agg == "count" ? Double(vals.count) : aggregate(vals, agg)
            var raw: String?
            if vals.count == 1, valuePath != nil, let s = vals[0]?.string?.trimmingCharacters(in: .whitespacesAndNewlines),
               s.wholeMatch(of: #/[-+]?[\d.]+/#) == nil { raw = s }
            return Ranked(label: label, value: value.isFinite ? value : 0, raw: raw)
        }
        out.sort { a, b in
            if a.value != b.value { return a.value > b.value }
            if (a.label == "—") != (b.label == "—") { return b.label == "—" }
            return a.label.localizedCompare(b.label) == .orderedAscending
        }
        let lim = view.number("limit").map { $0.rounded(.down) } ?? .nan
        return Array(out.prefix(lim.isNaN ? 10 : Int(max(1, lim))))
    }

    // ---------- status ----------

    static let statusWords: [(String, Regex<AnyRegexOutput>)] = [
        ("err", try! Regex(#"fail(ed|ure|ing)?|error(ed)?|crash\w*|timed_out|timeout|startup_failure|rejected|changes_requested|broken|down|oomkilled|critical|fatal|unhealthy|false|imagepullbackoff|errimagepull|evicted|dead|exited"#)),
        ("warn", try! Regex(#"warn(ing)?|degraded|action_required|unstable|partial\w*|retry(ing)?|flaky|restarting|backoff|terminating|slow"#)),
        ("run", try! Regex(#"running|in_progress|progressing|started|deploying|building|syncing|rolling\w*|open|active|reconciling|provisioning|updating|containercreating"#)),
        ("wait", try! Regex(#"queued|pending|waiting|requested|review_required|draft|scheduled|created|new|unknown|stopping"#)),
        ("ok", try! Regex(#"ok|success|succeeded|successful|pass(ed)?|completed?|done|merged|approved|ready|healthy|true|deployed|available|closed|up|bound"#)),
        ("idle", try! Regex(#"cancel+ed|skipped|neutral|stale|superseded|inactive|retired|stopped|terminated|suspended"#)),
    ]

    /// A status word -> ok | warn | err | run | wait | idle | "" (GitHub, Kubernetes, CI and deploy words).
    public static func statusTone(_ v: JSONValue?) -> String {
        let text: String
        switch v {
        case nil, .null?: text = ""
        case .string(let s)?: text = s
        case let x?: text = show(x, max: 100_000)
        }
        let s = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().replacing(#/[\s-]+/#, with: "_")
        guard !s.isEmpty, s.count <= 40 else { return "" }
        let head = String(s.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "_" || $0 == "(" }).first ?? "")
        for w in [s, head] { for (t, re) in statusWords where w.wholeMatch(of: re) != nil { return t } }
        return ""
    }

    // ---------- timeline ----------

    public struct Interval: Equatable, Sendable {
        public var key: String
        public var label: String
        public var group: String?
        public var start: Double
        /// nil while open: it ends now and keeps growing
        public var end: Double?
        public var open: Bool
        public var status: String
        public var tone: String
    }

    /// timeline: rows -> intervals. One without an end, or whose status means still running or waiting, is open.
    public static func intervals(_ data: JSONValue, _ view: BrickSpec, now: Double = Date().timeIntervalSince1970 * 1000) -> [Interval] {
        var out: [Interval] = [], seen: [String: Int] = [:]
        for r0 in rows(data) {
            let r = asRow(r0)
            let start = parseTime(get(r, view.string("start")), now: now)
            guard start.isFinite else { continue }
            let status = view.paths("status").flatMap { first(r, $0) }
            let tone = statusTone(status)
            var end = view.string("end").map { parseTime(get(r, $0), now: now) } ?? .nan
            if !end.isFinite, let dp = view.string("duration") {
                let d = parseDuration(get(r, dp))
                if d.isFinite { end = start + d * 1000 }
            }
            let open = !end.isFinite || tone == "run" || tone == "wait"
            let label = show(view.string("label").flatMap { get(r, $0) } ?? .string(""), max: 120)
            let group = view.string("group").map { g -> String in let s = show(get(r, g), max: 80); return s.isEmpty ? "—" : s }
            let base = "\(group ?? "")\u{0}\(label)\u{0}\(number(start))"
            let n = seen[base] ?? 0
            seen[base] = n + 1
            out.append(Interval(key: n > 0 ? "\(base)\u{0}\(n)" : base, label: label, group: group, start: start,
                                end: open ? nil : max(start, end), open: open, status: status.map { show($0, max: 40) } ?? "", tone: tone))
        }
        return out
    }

    // ---------- formatting ----------

    /// JavaScript's toFixed: the nearest, halves away from zero
    static func fixed(_ n: Double, _ digits: Int) -> String {
        let d = NSDecimalNumber(value: n).rounding(accordingToBehavior: NSDecimalNumberHandler(
            roundingMode: .plain, scale: Int16(digits), raiseOnExactness: false, raiseOnOverflow: false, raiseOnUnderflow: false, raiseOnDivideByZero: false))
        return String(format: "%.\(digits)f", d.doubleValue)
    }

    /// short, plain numbers: 0.25, 12.4, 230, 12.3k, 4.1M
    public static func fmtNum(_ n: Double) -> String {
        guard n.isFinite else { return "—" }
        let a = abs(n)
        func trim(_ s: String) -> String {
            guard s.contains(".") else { return s }
            var t = s
            while t.hasSuffix("0") { t.removeLast() }
            if t.hasSuffix(".") { t.removeLast() }
            return t
        }
        if a >= 1e9 { return trim(fixed(n / 1e9, 1)) + "G" }
        if a >= 1e6 { return trim(fixed(n / 1e6, 1)) + "M" }
        if a >= 1e4 { return trim(fixed(n / 1e3, 1)) + "k" }
        if a >= 100 { return String(Int64((n + 0.5).rounded(.down))) }
        if a >= 10 { return trim(fixed(n, 1)) }
        let s = trim(fixed(n, 2))
        return s == "-0" ? "0" : s
    }

    /// 45 sn · 7 dk · 2 sa 5 dk · 3 g 4 sa
    public static func fmtDur(_ ms: Double) -> String {
        let s = Int(max(0, (ms / 1000 + 0.5).rounded(.down)))
        if s < 60 { return L("%d sec", s) }
        let m = s / 60
        if m < 60 { return L("%d min", m) }
        let hr = m / 60
        if hr < 48 { return m % 60 > 0 ? L("%d hr %d min", hr, m % 60) : L("%d hr", hr) }
        let d = hr / 24
        return hr % 24 > 0 ? L("%d d %d hr", d, hr % 24) : L("%d d", d)
    }

    /// a tick or tooltip time: 14:05, 14:05:30 for short spans, "7 Eki" for long ones, "7 Eki 14:05" another day
    public static func fmtClock(_ t: Double, span: Double = 0, now: Double = Date().timeIntervalSince1970 * 1000) -> String {
        let d = Date(timeIntervalSince1970: t / 1000), cal = Calendar.current
        let c = cal.dateComponents([.hour, .minute, .second], from: d)
        let hm = String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
        if span > 0, span <= 600_000 { return hm + String(format: ":%02d", c.second ?? 0) }
        let f = DateFormatter()
        f.locale = Locale(identifier: LangState.shared.current == .turkish ? "tr_TR" : "en_US")
        f.dateFormat = "d MMM"
        if span > 2 * 86_400_000 { return f.string(from: d) }
        if span == 0, !cal.isDate(d, inSameDayAs: Date(timeIntervalSince1970: now / 1000)) { return "\(f.string(from: d)) \(hm)" }
        return hm
    }

    static let steps: [Double] = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800, 2592000].map { $0 * 1000 }

    /// time ticks a person would pick: every 10 s, 1 min, 5 min, 1 h, 1 day (days on local midnight)…
    public static func timeTicks(_ d0: Double, _ d1: Double, max: Int = 5) -> [Double] {
        let step = steps.first { (d1 - d0) / $0 <= Double(max) } ?? steps.last!
        let off = step >= 86_400_000 ? Double(TimeZone.current.secondsFromGMT(for: Date(timeIntervalSince1970: d0 / 1000))) * 1000 : 0
        var out: [Double] = []
        var t = ((d0 + off) / step).rounded(.up) * step - off
        while t <= d1 { out.append(t); t += step }
        return out
    }

    /// the round number at or above a value: 1, 2, 2.5, 5, 10 × 10ⁿ
    public static func niceMax(_ v: Double) -> Double {
        guard v > 0 else { return 1 }
        let p = pow(10, (log10(v)).rounded(.down)), f = v / p
        return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p
    }

    /// above a view's thresholds: "bad" over error_above, "warn" over warn_above
    public static func thresholdTone(_ view: BrickSpec, _ n: Double) -> Tone {
        guard n.isFinite else { return .none }
        if let e = view.number("error_above"), n > e { return .bad }
        if let w = view.number("warn_above"), n > w { return .warn }
        return .none
    }

    /// the ease every value move uses: 1-(1-t)³
    public static func ease(_ t: Double) -> Double { 1 - pow(1 - min(1, max(0, t)), 3) }
}
