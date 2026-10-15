import Foundation

/// Any JSON, for the parts of the API the app passes along or reads loosely (panel specs and data, IDE state).
/// Objects keep their keys in the order the server wrote them when read with `JSONValue.parse` (a table with no
/// columns set shows its fields in that order, as the web does).
public enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object(JSONObject)

    public init(from decoder: Decoder) throws {
        if let c = try? decoder.container(keyedBy: AnyKey.self) {
            var o = JSONObject()
            for k in c.allKeys { o[k.stringValue] = try c.decode(JSONValue.self, forKey: k) }
            self = .object(o)
            return
        }
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else { self = .array(try c.decode([JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .object(let o):
            var c = encoder.container(keyedBy: AnyKey.self)
            for (k, v) in o { try c.encode(v, forKey: AnyKey(k)) }
        default:
            var c = encoder.singleValueContainer()
            switch self {
            case .null: try c.encodeNil()
            case .bool(let b): try c.encode(b)
            case .number(let n): try c.encode(n)
            case .string(let s): try c.encode(s)
            case .array(let a): try c.encode(a)
            case .object: break
            }
        }
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public var string: String? { if case .string(let s) = self { return s }; return nil }
    public var number: Double? { if case .number(let n) = self { return n }; return nil }
    public var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var array: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    public var object: JSONObject? { if case .object(let o) = self { return o }; return nil }
    public var isNull: Bool { self == .null }

    /// as Foundation objects, for request bodies (JSONSerialization)
    public var any: Any {
        switch self {
        case .null: NSNull()
        case .bool(let b): b
        case .number(let n): n
        case .string(let s): s
        case .array(let a): a.map(\.any)
        case .object(let o): Dictionary(o.map { ($0.0, $0.1.any) }, uniquingKeysWith: { _, last in last })
        }
    }

    /// Reads JSON text, keeping the order of every object's keys.
    public static func parse(_ data: Data) throws -> JSONValue {
        var p = OrderedJSONParser(bytes: [UInt8](data))
        p.space()
        let v = try p.value()
        p.space()
        guard p.i == p.bytes.count else { throw p.fail("trailing characters") }
        return v
    }
    public static func parse(_ text: String) throws -> JSONValue { try parse(Data(text.utf8)) }
}

struct AnyKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ s: String) { stringValue = s }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

/// A JSON object that remembers the order its keys came in. Equal when the same keys hold the same values.
public struct JSONObject: Equatable, Sendable, Sequence, ExpressibleByDictionaryLiteral {
    public private(set) var keys: [String] = []
    private var dict: [String: JSONValue] = [:]

    public init() {}
    public init(dictionaryLiteral elements: (String, JSONValue)...) { for (k, v) in elements { self[k] = v } }

    public subscript(key: String) -> JSONValue? {
        get { dict[key] }
        set {
            if let v = newValue {
                if dict.updateValue(v, forKey: key) == nil { keys.append(key) }
            } else if dict.removeValue(forKey: key) != nil {
                keys.removeAll { $0 == key }
            }
        }
    }

    public var count: Int { keys.count }
    public var isEmpty: Bool { keys.isEmpty }
    public var values: [JSONValue] { keys.compactMap { dict[$0] } }
    public func makeIterator() -> AnyIterator<(String, JSONValue)> {
        var i = 0
        return AnyIterator { () -> (String, JSONValue)? in
            while i < keys.count {
                let k = keys[i]
                i += 1
                if let v = dict[k] { return (k, v) }
            }
            return nil
        }
    }
    public static func == (a: JSONObject, b: JSONObject) -> Bool { a.dict == b.dict }
}

/// JSONDecoder and JSONSerialization lose the order of an object's keys; this keeps it.
struct OrderedJSONParser {
    let bytes: [UInt8]
    var i = 0

    struct Failure: LocalizedError { var message: String; var errorDescription: String? { message } }
    func fail(_ m: String) -> Failure { Failure(message: "JSON: \(m) at \(i)") }

    mutating func space() { while i < bytes.count, [32, 9, 10, 13].contains(bytes[i]) { i += 1 } }

    mutating func value() throws -> JSONValue {
        guard i < bytes.count else { throw fail("unexpected end") }
        switch bytes[i] {
        case UInt8(ascii: "{"):
            i += 1
            var o = JSONObject()
            space()
            if i < bytes.count, bytes[i] == UInt8(ascii: "}") { i += 1; return .object(o) }
            while true {
                space()
                guard i < bytes.count, bytes[i] == UInt8(ascii: "\"") else { throw fail("expected a key") }
                let k = try string()
                space()
                guard i < bytes.count, bytes[i] == UInt8(ascii: ":") else { throw fail("expected :") }
                i += 1
                space()
                o[k] = try value()
                space()
                guard i < bytes.count else { throw fail("unexpected end") }
                if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
                if bytes[i] == UInt8(ascii: "}") { i += 1; return .object(o) }
                throw fail("expected , or }")
            }
        case UInt8(ascii: "["):
            i += 1
            var a: [JSONValue] = []
            space()
            if i < bytes.count, bytes[i] == UInt8(ascii: "]") { i += 1; return .array(a) }
            while true {
                space()
                a.append(try value())
                space()
                guard i < bytes.count else { throw fail("unexpected end") }
                if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
                if bytes[i] == UInt8(ascii: "]") { i += 1; return .array(a) }
                throw fail("expected , or ]")
            }
        case UInt8(ascii: "\""):
            return .string(try string())
        case UInt8(ascii: "t"): try literal("true"); return .bool(true)
        case UInt8(ascii: "f"): try literal("false"); return .bool(false)
        case UInt8(ascii: "n"): try literal("null"); return .null
        default:
            let start = i
            while i < bytes.count, "+-0123456789.eE".utf8.contains(bytes[i]) { i += 1 }
            guard i > start, let n = Double(String(decoding: bytes[start..<i], as: UTF8.self)) else { throw fail("unexpected character") }
            return .number(n)
        }
    }

    mutating func literal(_ word: String) throws {
        let w = Array(word.utf8)
        guard i + w.count <= bytes.count, Array(bytes[i..<i + w.count]) == w else { throw fail("expected \(word)") }
        i += w.count
    }

    mutating func string() throws -> String {
        i += 1 // the opening quote
        var out: [UInt8] = []
        while i < bytes.count {
            let b = bytes[i]
            i += 1
            if b == UInt8(ascii: "\"") { return String(decoding: out, as: UTF8.self) }
            guard b == UInt8(ascii: "\\") else { out.append(b); continue }
            guard i < bytes.count else { break }
            let e = bytes[i]
            i += 1
            switch e {
            case UInt8(ascii: "n"): out.append(10)
            case UInt8(ascii: "t"): out.append(9)
            case UInt8(ascii: "r"): out.append(13)
            case UInt8(ascii: "b"): out.append(8)
            case UInt8(ascii: "f"): out.append(12)
            case UInt8(ascii: "u"):
                var code = try hex4()
                if (0xD800..<0xDC00).contains(code), i + 1 < bytes.count, bytes[i] == UInt8(ascii: "\\"), bytes[i + 1] == UInt8(ascii: "u") {
                    i += 2
                    let low = try hex4()
                    code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)
                }
                out.append(contentsOf: Array(String(Character(Unicode.Scalar(code) ?? "\u{FFFD}")).utf8))
            default: out.append(e) // \" \\ \/
            }
        }
        throw fail("unterminated string")
    }

    mutating func hex4() throws -> UInt32 {
        guard i + 4 <= bytes.count, let v = UInt32(String(decoding: bytes[i..<i + 4], as: UTF8.self), radix: 16) else { throw fail("bad \\u escape") }
        i += 4
        return v
    }
}
