import Foundation
import Observation

// An agent's panel as the server describes it (src/panels/panel.mjs view()): a spec of bricks
// (src/bricks/catalog.mjs), how it sits next to its node, whether its commands may run, and the saved tool it
// came from. Read leniently: a field the app doesn't know or a malformed one never drops the whole panel.

public struct Panel: Codable, Equatable, Sendable {
    public var spec: PanelSpec?
    public var ui: PanelUI
    public var tool: PanelTool?
    /// running: sources run · pending: waiting for the user's approval · rejected: the user said no
    public var status: String
    /// what the user is asked to allow (commands, files, URLs, run actions)
    public var pending: [Reach]
    /// per source: its last error and when it last changed (the data itself comes over the panel stream)
    public var sources: [String: SourceStatus]
    /// the values of the spec's inputs (what the user or the agent picked, else the defaults)
    public var inputs: JSONObject = [:]

    public init(spec: PanelSpec?, ui: PanelUI = PanelUI(), tool: PanelTool? = nil, status: String = "running",
                pending: [Reach] = [], sources: [String: SourceStatus] = [:]) {
        self.spec = spec; self.ui = ui; self.tool = tool; self.status = status; self.pending = pending; self.sources = sources
    }

    public init(json j: JSONValue) {
        spec = j["spec"].flatMap { $0.object == nil ? nil : PanelSpec(json: $0) }
        ui = PanelUI(json: j["ui"] ?? .null)
        tool = j["tool"].flatMap(PanelTool.init(json:))
        status = j["status"]?.string ?? "running"
        pending = (j["pending"]?.array ?? []).map(Reach.init(json:))
        var s: [String: SourceStatus] = [:]
        for (k, v) in j["sources"]?.object ?? [:] { s[k] = SourceStatus(error: v["error"]?.string, updatedAt: v["updatedAt"]?.number) }
        sources = s
        inputs = j["inputs"]?.object ?? [:]
    }

    public init(from decoder: Decoder) throws { self.init(json: try JSONValue(from: decoder)) }

    /// an input's value as text ("" when unset; toggles "true"/"false")
    public func value(_ name: String) -> String {
        switch inputs[name] { case .string(let s)?: s; case .bool(let b)?: b ? "true" : ""; case .number(let n)?: Bricks.show(.number(n)); default: "" }
    }

    public var json: JSONValue {
        var o: JSONObject = ["ui": ui.json, "status": .string(status)]
        o["spec"] = spec?.json ?? .null
        o["tool"] = tool.map { t -> JSONValue in
            var x: JSONObject = ["id": .string(t.id), "name": .string(t.name)]
            x["params"] = t.params
            return .object(x)
        } ?? .null
        o["pending"] = .array(pending.map(\.json))
        o["inputs"] = .object(inputs)
        return .object(o)
    }
    public func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }

    public var isRunning: Bool { status == "running" }
    /// a source failed: the status dot turns red
    public var hasError: Bool { sources.values.contains { $0.error != nil } }
}

public struct SourceStatus: Equatable, Sendable {
    public var error: String?
    public var updatedAt: Double?
}

public struct PanelUI: Equatable, Sendable {
    public var collapsed = false
    public var maximized = false
    public var size: [Double] = [560, 400]

    public init(collapsed: Bool = false, maximized: Bool = false, size: [Double] = [560, 400]) {
        self.collapsed = collapsed; self.maximized = maximized; self.size = size
    }
    public init(json j: JSONValue) {
        collapsed = j["collapsed"]?.bool ?? false
        maximized = j["maximized"]?.bool ?? false
        if let s = j["size"]?.array?.compactMap(\.number), s.count == 2 { size = s }
    }
    var json: JSONValue { .object(["collapsed": .bool(collapsed), "maximized": .bool(maximized), "size": .array(size.map(JSONValue.number))]) }
}

/// the saved tool a panel was opened from (or was kept as)
public struct PanelTool: Equatable, Sendable {
    public var id: String
    public var name: String
    public var params: JSONValue?
    init?(json j: JSONValue) {
        guard let id = j["id"]?.string else { return nil }
        self.id = id
        name = j["name"]?.string ?? id
        params = j["params"]
    }
}

/// { title, sources: { name: source }, views: [ brick ] }
public struct PanelSpec: Equatable, Sendable {
    public var title: String
    public var sources: JSONObject
    public var views: [BrickSpec]
    /// controls the user changes while the panel runs (src/bricks/inputs.mjs), in the spec's order
    public var inputs: [PanelInput] = []
    /// buttons in the panel's strip: { label, icon?, run | ask }
    public var actions: [JSONValue] = []

    public init(title: String, sources: JSONObject = [:], views: [BrickSpec] = []) {
        self.title = title; self.sources = sources; self.views = views
    }
    public init(json j: JSONValue) {
        title = j["title"]?.string ?? "Panel"
        sources = j["sources"]?.object ?? [:]
        views = (j["views"]?.array ?? []).enumerated().compactMap { i, v in BrickSpec(json: v, index: i) }
        inputs = (j["inputs"]?.object ?? [:]).compactMap { PanelInput(name: $0.0, json: $0.1) }
        actions = j["actions"]?.array ?? []
    }
    public var json: JSONValue {
        var o: JSONObject = ["title": .string(title), "sources": .object(sources), "views": .array(views.map(\.raw))]
        if !inputs.isEmpty { var io = JSONObject(); for i in inputs { io[i.name] = i.raw }; o["inputs"] = .object(io) }
        if !actions.isEmpty { o["actions"] = .array(actions) }
        return .object(o)
    }
}

/// One view of a panel: which brick draws it, from which source, and the brick's own fields (kept whole in
/// `raw`, so a brick added on the server only needs its renderer here).
public struct BrickSpec: Equatable, Sendable, Identifiable {
    public var id: String
    public var brick: String
    public var source: String?
    public var title: String?
    /// width in quarters of the panel (1-4)
    public var span: Int
    public var raw: JSONValue

    public init?(json j: JSONValue, index: Int = 0) {
        guard j.object != nil else { return nil }
        raw = j
        brick = j["brick"]?.string ?? "json"
        id = j["id"]?.string ?? "v\(index + 1)"
        source = j["source"]?.string
        title = j["title"]?.string
        span = max(1, min(4, j["span"]?.number.flatMap { $0.isFinite ? Int($0) : nil } ?? Self.defaultSpan[brick] ?? 4))
    }

    /// catalog.mjs spans, for specs the server didn't fill in (previews)
    static let defaultSpan = ["stat": 1, "kv": 2, "chart": 2, "bars": 2]

    public subscript(key: String) -> JSONValue? { raw[key] }
    /// a path or a list of paths ("y", "status", "text"); nil when not set
    public func paths(_ key: String) -> [String]? {
        if let s = raw[key]?.string { return s.isEmpty ? nil : [s] }
        if let a = raw[key]?.array { let p = a.compactMap(\.string); return p.isEmpty ? nil : p }
        return nil
    }
    public func string(_ key: String) -> String? { raw[key]?.string }
    public func number(_ key: String) -> Double? { raw[key]?.number ?? raw[key]?.string.flatMap(Double.init) }

    /// the heading: its title, else its source, else the brick's name
    public var heading: String { title ?? source ?? brick }

    /// [ "field" | {field, label} ] as columns
    public func columns(_ key: String = "columns") -> [Column]? {
        guard let a = raw[key]?.array, !a.isEmpty else { return nil }
        return a.compactMap { c in
            if let f = c.string { return Column(field: f, label: f) }
            guard let f = c["field"]?.string else { return nil }
            return Column(field: f, label: c["label"]?.string ?? f, raw: c)
        }
    }

    public var rowActions: [RowAction] { (raw["row_actions"]?.array ?? []).compactMap(RowAction.init(json:)) }
}

public struct Column: Equatable, Sendable, Identifiable {
    public var field: String
    public var label: String
    /// the column's other fields (e.g. a future `bar` or `format`)
    public var raw: JSONValue = .null
    public var id: String { field }
    public init(field: String, label: String, raw: JSONValue = .null) { self.field = field; self.label = label; self.raw = raw }
}

/// a button on a table row or log line: `ask` sends the row to the agent, `run` runs a program with its values
public struct RowAction: Equatable, Sendable {
    public var label: String
    public var ask: String?
    public var run: [String]?
    public var refresh: Bool
    init?(json j: JSONValue) {
        guard let l = j["label"]?.string else { return nil }
        label = l
        ask = j["ask"]?.string
        run = j["run"]?.array?.compactMap(\.string)
        refresh = j["refresh"]?.bool ?? false
    }
    public var isRun: Bool { run != nil && ask == nil }
}

/// what part of a spec reaches outside the panel (catalog.mjs reach): the user approves these
public struct Reach: Equatable, Sendable {
    public var at: String
    public var kind: String // command | action | file | http | sql | connector
    public var argv: [String]?
    public var everyS: Double?
    public var stream: Bool
    public var label: String?
    public var path: String?
    public var url: String?
    /// sql: the database client and what it is asked; connector: the service and its call
    public var engine: String?
    public var db: String?
    public var query: String?
    public var service: String?
    public var call: String?

    init(json j: JSONValue) {
        at = j["at"]?.string ?? ""
        kind = j["kind"]?.string ?? "command"
        argv = j["argv"]?.array?.compactMap(\.string)
        everyS = j["every_s"]?.number
        stream = j["stream"]?.bool ?? false
        label = j["label"]?.string
        path = j["path"]?.string
        url = j["url"]?.string
        engine = j["engine"]?.string; db = j["db"]?.string; query = j["query"]?.string
        service = j["service"]?.string; call = j["call"]?.string
    }
    var json: JSONValue {
        var o: JSONObject = ["at": .string(at), "kind": .string(kind), "stream": .bool(stream)]
        if let argv { o["argv"] = .array(argv.map(JSONValue.string)) }
        if let everyS { o["every_s"] = .number(everyS) }
        if let label { o["label"] = .string(label) }
        if let path { o["path"] = .string(path) }
        if let url { o["url"] = .string(url) }
        for (k, v) in [("engine", engine), ("db", db), ("query", query), ("service", service), ("call", call)] { if let v { o[k] = .string(v) } }
        return .object(o)
    }

    /// the thing itself, as the user would type it: the command line, the file, the address
    public var text: String {
        switch kind {
        case "command", "action": (argv ?? []).joined(separator: " ")
        case "file": path ?? ""
        case "sql": [engine, db].compactMap { $0 }.joined(separator: " · ") + ": " + (query ?? "")
        case "connector": [service, call].compactMap { $0 }.joined(separator: " · ")
        default: url ?? ""
        }
    }
    /// how often, in a word or two (panels.mjs describe)
    public var cadence: String? {
        if stream { return L("streaming") }
        if let s = everyS { return L("%d sec", Int(s)) }
        return nil
    }
}

/// A saved tool as the toolbox describes it (toolbox/store.mjs card): offered next to an agent as a ghost panel.
public struct ToolCard: Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var summary: String?
    public var spec: PanelSpec?
    /// sample data per source, saved when the tool was kept: what the ghost shows
    public var preview: JSONValue?
    /// the moment the sample was taken: "now" in the preview (epoch ms)
    public var previewAt: Double?
    /// a chart's history per view id: numbers, or lists of numbers for several series
    public var previewSeries: JSONObject
    public var params: JSONObject
    public var logo: String?

    public init(json j: JSONValue) {
        id = j["id"]?.string ?? ""
        name = j["name"]?.string ?? id
        summary = j["summary"]?.string
        spec = j["spec"].flatMap { $0.object == nil ? nil : PanelSpec(json: $0) }
        preview = j["preview"]?["data"]
        previewAt = j["preview"]?["at"]?.number
        previewSeries = j["preview"]?["series"]?.object ?? [:]
        params = j["params"]?.object ?? [:]
        logo = j["logo"]?.string
    }

    /// params nobody filled in: the agent finds them out (app.mjs useTool)
    public var missingParams: [String] {
        params.compactMap { k, p in (p["default"] ?? .null).isNull ? k : nil }
    }
}

// ---------- data: the panel stream ----------

/// one source's data as the page holds it
public struct SourceState: Equatable, Sendable {
    public var data: JSONValue
    public var error: String?
    public var updatedAt: Double?
    public init(data: JSONValue = .null, error: String? = nil, updatedAt: Double? = nil) {
        self.data = data; self.error = error; self.updatedAt = updatedAt
    }
}

/// A message of GET /v1/canvases/:id/panels/stream: "snapshot" {agent, sources: {name: state}} on each
/// (re)connect, then "data" {agent, source, mode: replace|append|error, data, error, updatedAt, keep?}.
public enum PanelMessage: Equatable, Sendable {
    case snapshot(agent: String, sources: [String: SourceState])
    case data(agent: String, source: String, mode: String, data: JSONValue, error: String?, updatedAt: Double?, keep: Int?)

    public init?(event: String?, data text: String) {
        guard let j = try? JSONValue.parse(text), let agent = j["agent"]?.string else { return nil }
        if event == "snapshot" {
            var s: [String: SourceState] = [:]
            for (k, v) in j["sources"]?.object ?? [:] {
                s[k] = SourceState(data: v["data"] ?? .null, error: v["error"]?.string, updatedAt: v["updatedAt"]?.number)
            }
            self = .snapshot(agent: agent, sources: s)
        } else {
            guard let source = j["source"]?.string else { return nil }
            self = .data(agent: agent, source: source, mode: j["mode"]?.string ?? "replace", data: j["data"] ?? .null,
                         error: j["error"]?.string, updatedAt: j["updatedAt"]?.number, keep: j["keep"]?.number.map { Int($0) })
        }
    }
}

/// One agent's panel data. Each source is observed on its own: new rows for "ps" redraw the table showing
/// "ps", not the chart and the log beside it.
@MainActor @Observable
public final class PanelFeed {
    @MainActor @Observable public final class Box {
        public internal(set) var state = SourceState()
    }
    @ObservationIgnored private var boxes: [String: Box] = [:]
    /// bumped only when a source appears, so views that read an unknown source learn it exists
    private var shape = 0

    public init(sources: [String: SourceState] = [:]) { self.sources = sources }
    /// a feed holding sample data per source (a saved tool's preview)
    public convenience init(sample: JSONValue) {
        var s: [String: SourceState] = [:]
        for (k, v) in sample.object ?? [:] { s[k] = SourceState(data: v) }
        self.init(sources: s)
    }

    private func box(_ name: String) -> Box {
        if let b = boxes[name] { return b }
        let b = Box()
        boxes[name] = b
        shape &+= 1
        return b
    }

    public subscript(source: String?) -> SourceState {
        guard let source else { return SourceState() }
        if let b = boxes[source] { return b.state }
        _ = shape // not there yet: redraw when it comes
        return SourceState()
    }

    /// all sources at once (snapshots, clearing); setting one only touches the boxes whose state changed
    public internal(set) var sources: [String: SourceState] {
        get { boxes.mapValues(\.state) }
        set {
            for (k, v) in newValue { let b = box(k); if b.state != v { b.state = v } }
            for (k, b) in boxes where newValue[k] == nil && b.state != SourceState() { b.state = SourceState() }
        }
    }

    func set(_ source: String, _ state: SourceState) { let b = box(source); if b.state != state { b.state = state } }
    func state(_ source: String) -> SourceState { boxes[source]?.state ?? SourceState() }
}

/// Every panel's data on the open canvas (panels.mjs snapshot / update).
@MainActor
public final class PanelFeeds {
    public private(set) var feeds: [String: PanelFeed] = [:]
    public init() {}

    public func feed(_ agent: String) -> PanelFeed {
        if let f = feeds[agent] { return f }
        let f = PanelFeed()
        feeds[agent] = f
        return f
    }

    public func clear() { for f in feeds.values { f.sources = [:] } }
    public func remove(_ agent: String) { feeds[agent]?.sources = [:] }

    public func apply(_ m: PanelMessage) {
        switch m {
        case .snapshot(let agent, let sources):
            feed(agent).sources = sources
        case .data(let agent, let source, let mode, let data, let error, let updatedAt, let keep):
            let f = feed(agent)
            let prev = f.state(source)
            var next = prev.data
            if mode == "replace" { next = data }
            else if mode == "append" {
                let rows = (prev.data.array ?? []) + (data.array ?? [data])
                next = .array(Array(rows.suffix(keep ?? 500)))
            }
            f.set(source, SourceState(data: next, error: error, updatedAt: updatedAt))
        }
    }
}

/// One input of a panel: select (fixed options, or a field of a source's rows), text, toggle, or row (the
/// clicked row of a table or log view)
public struct PanelInput: Equatable, Sendable, Identifiable {
    public var name: String
    public var kind: String
    public var label: String?
    /// a select's fixed options
    public var options: [String]?
    /// a select's options from a source: the values of `field` in its rows
    public var optionsFrom: (source: String, field: String)?
    /// a row input's view and the field of the clicked row it takes
    public var view: String?
    public var field: String?
    /// a slider's range and unit
    public var min: Double?
    public var max: Double?
    public var step: Double?
    public var unit: String?
    public var raw: JSONValue
    public var id: String { name }

    public init?(name: String, json j: JSONValue) {
        guard let kind = j["kind"]?.string else { return nil }
        self.name = name; self.kind = kind; raw = j
        label = j["label"]?.string
        options = j["options"]?.array?.compactMap { $0.string ?? $0.number.map { Bricks.show(.number($0)) } }
        if let s = j["options"]?["source"]?.string, let f = j["options"]?["field"]?.string { optionsFrom = (s, f) }
        view = j["view"]?.string
        field = j["field"]?.string
        min = j["min"]?.number
        max = j["max"]?.number
        step = j["step"]?.number
        unit = j["unit"]?.string
    }

    public static func == (a: PanelInput, b: PanelInput) -> Bool { a.name == b.name && a.raw == b.raw }
}
