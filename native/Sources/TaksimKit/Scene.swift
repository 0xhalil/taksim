import Foundation

// The scene brick's meaning, ported from src/bricks/scene.mjs (the source of meaning; SceneBrick.swift is the
// renderer): expressions without eval, templates, expansion of `each` rows and data frames, theme color words
// and the step timeline. The same inputs give the same outputs (test/panels.test.mjs "scene: …", SceneTests.swift).
// Named SceneMath since SwiftUI owns `Scene`.

public enum SceneMath {
    public static let shapes = ["rect", "circle", "ellipse", "line", "arrow", "polyline", "polygon", "area", "path", "text", "brace"]
    public static let verbs = ["create", "write", "fade_in", "fade_out", "grow", "move", "transform", "indicate", "wait"]
    public static let colors = ["ink", "text", "muted", "line", "panel", "bg", "accent", "ok", "warn", "err", "wait", "s1", "s2", "s3", "s4", "none"]
    public static let limits = (shapes: 300, steps: 60, seconds: 20.0)
    static let numeric = ["x", "y", "w", "h", "r", "rx", "x2", "y2", "size", "width", "opacity", "rotate"]

    /// what a template sees: a row (fields by path) and the scene's vars (i, n, w, h, max, min, sum)
    public struct Scope {
        public var row: JSONValue?
        public var vars: [String: JSONValue]
        public init(row: JSONValue? = nil, vars: [String: JSONValue] = [:]) { self.row = row; self.vars = vars }
        public init(row: JSONValue? = nil, nums: [String: Double]) { self.row = row; vars = nums.mapValues(JSONValue.number) }
    }

    public struct Failure: Error, CustomStringConvertible { public let message: String; public var description: String { message } }

    // ---------- JavaScript's conversions ----------

    /// Number(v); nil is undefined
    public static func jsNumber(_ v: JSONValue?) -> Double {
        switch v {
        case nil: return .nan
        case .null?: return 0
        case .bool(let b)?: return b ? 1 : 0
        case .number(let n)?: return n
        case .string(let s)?:
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.isEmpty { return 0 }
            if t == "Infinity" || t == "+Infinity" { return .infinity }
            if t == "-Infinity" { return -.infinity }
            if t.lowercased().hasPrefix("0x"), let n = Int(t.dropFirst(2), radix: 16) { return Double(n) }
            guard t.wholeMatch(of: #/[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/#) != nil else { return .nan }
            return Double(t) ?? .nan
        case .array(let a)?: return a.isEmpty ? 0 : a.count == 1 ? jsNumber(.string(jsString(a[0]))) : .nan
        case .object?: return .nan
        }
    }

    /// Number.parseFloat(v): the number a text starts with
    static func parseFloat(_ v: JSONValue?) -> Double {
        if case .number(let n)? = v { return n }
        let s = jsString(v).trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("Infinity") || s.hasPrefix("+Infinity") { return .infinity }
        if s.hasPrefix("-Infinity") { return -.infinity }
        guard let m = s.prefixMatch(of: #/[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/#) else { return .nan }
        return Double(m.0) ?? .nan
    }

    /// String(v)
    public static func jsString(_ v: JSONValue?) -> String {
        switch v {
        case nil: return "undefined"
        case .null?: return "null"
        case .bool(let b)?: return b ? "true" : "false"
        case .number(let n)?: return jsNum(n)
        case .string(let s)?: return s
        case .array(let a)?: return a.map { $0 == .null ? "" : jsString($0) }.joined(separator: ",")
        case .object?: return "[object Object]"
        }
    }

    static func jsNum(_ n: Double) -> String {
        if n.isNaN { return "NaN" }
        if n.isInfinite { return n > 0 ? "Infinity" : "-Infinity" }
        if n == n.rounded(), abs(n) < 1e21 { return n == 0 ? "0" : String(format: "%.0f", n) }
        return String(n)
    }

    public static func truthy(_ v: JSONValue?) -> Bool {
        switch v {
        case nil, .null?: false
        case .bool(let b)?: b
        case .number(let n)?: n != 0 && !n.isNaN
        case .string(let s)?: !s.isEmpty
        default: true
        }
    }

    /// a == b, loosely, as JavaScript compares
    static func looseEqual(_ a: JSONValue?, _ b: JSONValue?) -> Bool {
        let nullish = { (v: JSONValue?) in v == nil || v == .null }
        if nullish(a) || nullish(b) { return nullish(a) && nullish(b) }
        switch (a!, b!) {
        case (.string(let x), .string(let y)): return x == y
        case (.number(let x), .number(let y)): return x == y
        case (.bool(let x), .bool(let y)): return x == y
        case (.object, _), (.array, _), (_, .object), (_, .array):
            if case .object = a!, case .object = b! { return false }
            if case .array = a!, case .array = b! { return false }
            let prim: (JSONValue) -> JSONValue = { v in
                switch v { case .object, .array: .string(jsString(v)); default: v }
            }
            return looseEqual(prim(a!), prim(b!))
        default: return jsNumber(a) == jsNumber(b)
        }
    }

    /// NaN wins, as in Math.min/Math.max
    static func jsMin(_ a: Double, _ b: Double) -> Double { a.isNaN || b.isNaN ? .nan : Swift.min(a, b) }
    static func jsMax(_ a: Double, _ b: Double) -> Double { a.isNaN || b.isNaN ? .nan : Swift.max(a, b) }
    /// Math.round: halves go up
    static func jsRound(_ x: Double) -> Double { (x + 0.5).rounded(.down) }

    // ---------- expressions ----------

    static let funcs: [String: ([Double]) -> Double] = [
        "min": { $0.reduce(Double.infinity, jsMin) }, "max": { $0.reduce(-Double.infinity, jsMax) },
        "abs": { abs($0.first ?? .nan) }, "round": { jsRound($0.first ?? .nan) },
        "floor": { ($0.first ?? .nan).rounded(.down) }, "ceil": { ($0.first ?? .nan).rounded(.up) },
        "sqrt": { ($0.first ?? .nan).squareRoot() }, "log": { log10($0.first ?? .nan) },
    ]

    /// evaluates one expression against a row (fields by path), its index i and the scene's stats; nil is
    /// undefined. Numbers, strings, fields, + - * / % ( ), the functions above, comparisons and a ? b : c.
    public static func evaluate(_ expr: String, _ scope: Scope) throws -> JSONValue? {
        var p = Parser(src: Array(expr.unicodeScalars), text: expr, scope: scope)
        let v = try p.ternary()
        if p.peek() != nil { throw p.fail("unexpected text") }
        return v
    }

    struct Parser {
        let src: [Unicode.Scalar]
        let text: String
        let scope: Scope
        var p = 0

        func fail(_ m: String) -> Failure { Failure(message: "\(m) in \"\(text)\"") }
        mutating func peek() -> Unicode.Scalar? {
            while p < src.count, src[p] == " " { p += 1 }
            return p < src.count ? src[p] : nil
        }
        func rest() -> Substring { Substring(String(String.UnicodeScalarView(src[p...]))) }
        static func isWord(_ c: Unicode.Scalar) -> Bool { c == "_" || ("a"..."z").contains(c) || ("A"..."Z").contains(c) || ("0"..."9").contains(c) }

        mutating func primary() throws -> JSONValue? {
            let c = peek()
            if c == "(" {
                p += 1
                let v = try ternary()
                if peek() != ")" { throw fail("missing )") }
                p += 1
                return v
            }
            if c == "-" { p += 1; return .number(-SceneMath.jsNumber(try primary())) }
            if c == "'" || c == "\"" {
                guard let e = src[(p + 1)...].firstIndex(of: c!) else { throw fail("unclosed string") }
                let s = String(String.UnicodeScalarView(src[(p + 1)..<e]))
                p = e + 1
                return .string(s)
            }
            let r = rest()
            if let m = r.prefixMatch(of: #/\d+(\.\d+)?/#) {
                p += m.0.unicodeScalars.count
                return .number(Double(m.0)!)
            }
            guard let id = r.prefixMatch(of: #/[A-Za-z_][\w.]*(\[[^\]]*\][\w.]*)*/#.asciiOnlyWordCharacters()) else { throw fail("unexpected character") }
            p += id.0.unicodeScalars.count
            let name = String(id.0)
            if peek() == "(", let f = SceneMath.funcs[name] {
                p += 1
                var args: [JSONValue?] = []
                if peek() != ")" {
                    args.append(try ternary())
                    while peek() == "," { p += 1; args.append(try ternary()) }
                }
                if peek() != ")" { throw fail("missing )") }
                p += 1
                return .number(f(args.map(SceneMath.jsNumber)))
            }
            return SceneMath.lookup(name, scope)
        }

        func num(_ v: JSONValue?) -> Double { SceneMath.parseFloat(v) }

        mutating func term() throws -> JSONValue? {
            var v = try primary()
            while true {
                let c = peek()
                guard c == "*" || c == "/" || c == "%" else { return v }
                p += 1
                let r = try primary()
                let a = num(v), b = num(r)
                v = .number(c == "*" ? a * b : c == "/" ? a / b : (b == 0 || a.isInfinite ? .nan : a.truncatingRemainder(dividingBy: b)))
            }
        }

        mutating func sum() throws -> JSONValue? {
            var v = try term()
            while true {
                let c = peek()
                guard c == "+" || c == "-" else { return v }
                p += 1
                let r = try term()
                if c == "+" {
                    let str: (JSONValue?) -> Bool = { x in
                        switch x { case .string?, .object?, .array?: true; default: false }
                    }
                    v = str(v) || str(r) ? .string(SceneMath.jsString(v) + SceneMath.jsString(r)) : .number(SceneMath.jsNumber(v) + SceneMath.jsNumber(r))
                } else {
                    v = .number(num(v) - num(r))
                }
            }
        }

        mutating func compare() throws -> JSONValue? {
            let v = try sum()
            _ = peek()
            guard let op = rest().prefixMatch(of: #/==|!=|>=|<=|>|</#) else { return v }
            p += op.0.unicodeScalars.count
            let r = try sum()
            switch op.0 {
            case "==": return .bool(SceneMath.looseEqual(v, r))
            case "!=": return .bool(!SceneMath.looseEqual(v, r))
            case ">=": return .bool(num(v) >= num(r))
            case "<=": return .bool(num(v) <= num(r))
            case ">": return .bool(num(v) > num(r))
            default: return .bool(num(v) < num(r))
            }
        }

        mutating func ternary() throws -> JSONValue? {
            let c = try compare()
            if peek() != "?" { return c }
            p += 1
            let a = try ternary()
            if peek() != ":" { throw fail("missing :") }
            p += 1
            let b = try ternary()
            return SceneMath.truthy(c) ? a : b
        }
    }

    /// a row's own field first; the scene's vars when the row has no such field
    static func lookup(_ name: String, _ scope: Scope) -> JSONValue? {
        if let row = scope.row {
            switch row {
            case .object, .array: if let v = Bricks.get(row, name) { return v }
            default: break
            }
        }
        return scope.vars[name]
    }

    /// fills a template: one expression alone keeps its type (a number stays a number); otherwise text
    public static func fill(_ value: JSONValue, _ scope: Scope) throws -> JSONValue {
        guard case .string(let s) = value, s.contains("{") else { return value }
        if let whole = s.wholeMatch(of: #/\{([^{}]+)\}/#) {
            return try evaluate(String(whole.1), scope) ?? .string("")
        }
        var out = "", last = s.startIndex
        for m in s.matches(of: #/\{([^{}]+)\}/#) {
            out += s[last..<m.range.lowerBound]
            let v = try evaluate(String(m.1), scope)
            switch v {
            case nil, .null?: break
            case .number(let n)?: out += fmt(n)
            default: out += jsString(v)
            }
            last = m.range.upperBound
        }
        return .string(out + s[last...])
    }

    static func fmt(_ n: Double) -> String { n.isFinite && n == n.rounded() ? jsNum(n) : jsNum(jsRound(n * 100) / 100) }

    /// a value as a text shape shows it: numbers like a template prints them (two decimals at most)
    public static func text(_ v: JSONValue?) -> String {
        switch v {
        case nil, .null?: return ""
        case .number(let n)?: return fmt(n)
        default: return jsString(v)
        }
    }

    static func fillShape(_ shape: JSONObject, _ scope: Scope) throws -> JSONObject {
        var out = JSONObject()
        for (k, v) in shape {
            if k == "points", case .array(let pts) = v {
                out[k] = .array(try pts.map { pt in
                    if case .array(let c) = pt { return .array(try c.map { try fill($0, scope) }) }
                    return pt
                })
            } else {
                out[k] = try fill(v, scope)
            }
        }
        for k in numeric { if let v = out[k] { out[k] = .number(jsNumber(v)) } }
        return out
    }

    // ---------- expansion ----------

    /// one shape to draw: its unique id and its filled-in fields
    public struct Shape: Equatable, Sendable {
        public var id: String
        public var props: JSONObject
        public init(id: String, props: JSONObject) { self.id = id; self.props = props }
        public var type: String { props["type"]?.string ?? "" }
        public subscript(key: String) -> JSONValue? { props[key] }
        /// a numeric field; nil when missing or not a finite number
        public func num(_ key: String) -> Double? {
            guard let v = props[key] else { return nil }
            let n = jsNumber(v)
            return n.isFinite ? n : nil
        }
    }

    /// the list of rows a scene's `each` repeats over
    public static func rowsOf(_ view: JSONValue, _ data: JSONValue?) -> [JSONValue] {
        let at: JSONValue?
        if let r = view["each"]?["rows"], truthy(r) { at = data.flatMap { Bricks.get($0, jsString(r)) } } else { at = data }
        switch at {
        case .array(let a)?: return a
        case nil, .null?: return []
        case let x?: return [x]
        }
    }

    public static func sceneSize(_ view: JSONValue) -> (w: Double, h: Double) {
        if case .array(let a)? = view["size"], a.count >= 1 {
            let w = jsNumber(a[0]), h = a.count > 1 ? jsNumber(a[1]) : .nan
            return (w.isFinite && w > 0 ? w : 400, h.isFinite && h > 0 ? h : 240)
        }
        return (400, 240)
    }

    /// The scene's shapes for this data: static ones, then one copy of the `each` shapes per row (ids made
    /// unique by the row's key), templates filled in and data coordinates mapped to scene units.
    public static func expand(_ view: JSONValue, _ data: JSONValue?) throws -> [Shape] {
        let (W, H) = sceneSize(view)
        let each = view["each"].flatMap { truthy($0) ? $0 : nil }
        let rows = each != nil ? rowsOf(view, data) : []
        var values: [Double] = []
        if let vf = each?["value"], truthy(vf) {
            values = rows.map { jsNumber(Bricks.get($0, jsString(vf))) }.filter(\.isFinite)
        }
        var stats: [String: Double] = ["n": Double(rows.count), "w": W, "h": H,
                                       "max": values.isEmpty ? 0 : values.max()!, "min": values.isEmpty ? 0 : values.min()!,
                                       "sum": values.reduce(0, +)]
        stats["i"] = 0
        var out: [Shape] = []
        let baseRow: JSONValue? = { if case .array? = data { return nil }; return data }()
        let base = Scope(row: baseRow, nums: stats)
        for (j, s) in (view["shapes"]?.array ?? []).enumerated() {
            guard let o = s.object else { continue }
            out.append(finish(try fillShape(o, base), id(o["id"], "s\(j)"), view))
        }
        if let each {
            var seen: [String: Int] = [:]
            let shapes = each["shapes"]?.array ?? []
            for (i, row) in rows.enumerated() {
                stats["i"] = Double(i)
                let scope = Scope(row: row, nums: stats)
                var key = String(i)
                if let kf = each["key"], truthy(kf) {
                    let v = Bricks.get(row, jsString(kf))
                    key = v == nil || v == .null ? String(i) : jsString(v)
                }
                let k = seen[key] ?? 0
                seen[key] = k + 1
                if k > 0 { key = "\(key)#\(k + 1)" }
                for (j, s) in shapes.enumerated() {
                    guard let o = s.object else { continue }
                    out.append(finish(try fillShape(o, scope), "\(key)/\(id(o["id"], "e\(j)"))", view))
                }
            }
        }
        return Array(out.prefix(limits.shapes))
    }

    static func id(_ v: JSONValue?, _ fallback: String) -> String { v == nil || v == .null ? fallback : jsString(v) }

    /// data coordinates -> scene units for a shape marked data: true (x/y frames from the view; y grows up)
    static func finish(_ s0: JSONObject, _ id: String, _ view: JSONValue) -> Shape {
        var s = s0
        s["id"] = .string(id)
        if truthy(s["data"]) {
            let (W, H) = sceneSize(view)
            func frame(_ k: String, _ size: Double) -> (min: Double, span: Double) {
                guard let f = view[k], truthy(f) else { return (0, size) }
                let lo = jsNumber(f["min"]), span = jsNumber(f["max"]) - lo
                return (lo, span == 0 || span.isNaN ? 1 : span)
            }
            let fx = frame("x", W), fy = frame("y", H)
            let sx = { (v: Double) in (v - fx.min) / fx.span * W }, sy = { (v: Double) in H - (v - fy.min) / fy.span * H }
            func n(_ k: String) -> Double? { s[k]?.number.flatMap { $0.isFinite ? $0 : nil } }
            if let x = n("x") { s["x"] = .number(sx(x)) }
            if let x2 = n("x2") { s["x2"] = .number(sx(x2)) }
            if let w = n("w") { s["w"] = .number(w / fx.span * W) }
            if let h = n("h") {
                let hh = h / fy.span * H
                s["h"] = .number(hh)
                if let y = n("y") { s["y"] = .number(sy(y) - hh) }
            } else if let y = n("y") { s["y"] = .number(sy(y)) }
            if let y2 = n("y2") { s["y2"] = .number(sy(y2)) }
            if case .array(let pts)? = s["points"] {
                s["points"] = .array(pts.map { pt in
                    let c = pt.array ?? []
                    return .array([.number(sx(jsNumber(c.first))), .number(sy(jsNumber(c.count > 1 ? c[1] : nil)))])
                })
            }
            s["data"] = nil
        }
        return Shape(id: id, props: s)
    }

    /// a color word (or "status:<word>", colored by what it means) -> a theme token every renderer maps
    public static func colorToken(_ c: JSONValue?, fallback: String = "ink") -> String {
        guard let c, c != .null, c != .string("") else { return fallback }
        let s = jsString(c)
        if s.hasPrefix("status:") {
            let tone = Bricks.statusTone(.string(String(s.dropFirst(7))))
            return ["ok": "ok", "warn": "warn", "err": "err", "run": "accent", "wait": "wait", "idle": "muted"][tone] ?? "accent"
        }
        return colors.contains(s) ? s : fallback
    }

    // ---------- the timeline ----------

    public struct Step: Equatable, Sendable {
        /// the verb (create, write, …)
        public var verb: String
        public var targets: [String]
        public var start: Double
        public var end: Double
        public var dur: Double
        /// the step as written (to, ease, target, …)
        public var raw: JSONObject
        public var ease: String { raw["ease"]?.string ?? "smooth" }
        public var to: JSONObject? { raw["to"]?.object }
    }

    public struct Plan: Equatable, Sendable {
        public var steps: [Step]
        /// shapes that start hidden: the targets of create, write, fade_in and grow appear with their step
        public var hidden: Set<String>
        /// seconds
        public var length: Double
        public init(steps: [Step] = [], hidden: Set<String> = [], length: Double = 0) { self.steps = steps; self.hidden = hidden; self.length = length }
    }

    /// When each step runs: at `at` seconds when given, else when the previous one ends; `wait` only moves
    /// the clock.
    public static func schedule(_ view: JSONValue, _ shapes: [Shape]) -> Plan {
        let ids = shapes.map(\.id)
        func match(_ t: JSONValue) -> [String] {
            let list = (t.array ?? [t]).map { jsString($0) }
            return ids.filter { id in list.contains { x in x == "*" || id == x || id.hasSuffix("/\(x)") || id.hasPrefix("\(x)/") } }
        }
        var out: [Step] = [], hidden = Set<String>()
        var clock = 0.0
        for st0 in (view["steps"]?.array ?? []).prefix(limits.steps) {
            let st = st0.object ?? JSONObject()
            let verb = st["do"].map { jsString($0) } ?? ""
            let durV = st["dur"].flatMap { $0 == .null ? nil : $0 } ?? .number(verb == "wait" ? 0.5 : 0.6)
            let dur = jsMax(0, jsMin(limits.seconds, jsNumber(durV)))
            let at = st["at"]
            let start = at != nil && jsNumber(at).isFinite ? jsNumber(at) : clock
            let targets = verb == "wait" ? [] : match(st["target"].flatMap { $0 == .null ? nil : $0 } ?? .string("*"))
            if ["create", "write", "fade_in", "grow"].contains(verb) {
                for id in targets where !out.contains(where: { $0.targets.contains(id) && $0.start < start }) { hidden.insert(id) }
            }
            out.append(Step(verb: verb, targets: targets, start: jsMin(start, limits.seconds), end: jsMin(start + dur, limits.seconds), dur: dur, raw: st))
            clock = jsMax(clock, start + dur)
        }
        return Plan(steps: out, hidden: hidden, length: jsMin(limits.seconds, clock))
    }

    public static func ease(_ name: String?, _ t: Double) -> Double {
        let c = Swift.min(1, Swift.max(0, t))
        if name == "linear" { return c }
        if name == "spring" { let s = 1.70158; return 1 + (s + 1) * pow(c - 1, 3) + s * pow(c - 1, 2) }
        return c < 0.5 ? 4 * c * c * c : 1 - pow(-2 * c + 2, 3) / 2
    }
}
