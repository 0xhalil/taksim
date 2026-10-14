import SwiftUI
import TaksimKit

// View bricks (ui/canvas/bricks.mjs): how a panel shows a source's data. Each brick is one SwiftUI view in its
// own file, conforming to BrickView, and one line in `BrickRegistry.all`. Data comes from agents, so it is
// only ever shown as text, never as markup.

/// what a brick gets: its spec, its source's data, the room it has, and how to run its row actions
struct BrickContext {
    let view: BrickSpec
    let state: SourceState
    /// inner width in graph units
    let width: CGFloat
    /// drawn with a tool's sample data (the ghost): nothing to click
    var preview = false
    /// runs row action `index` with a row; true when it went to the agent
    var act: (_ index: Int, _ row: JSONValue) async -> Bool = { _, _ in false }
    /// where this view keeps what outlives a re-render (a chart's history): the panel's owner and the view
    var memoKey = ""
    /// a preview's "now" (the moment its sample was taken, epoch ms)
    var now: Double?
    /// a preview chart's history (preview.series[view id])
    var series: JSONValue?
    /// how often the view's source refreshes, spacing a preview's history
    var everyS: Double?
    /// a row input this view feeds (inputs.mjs): the field it takes, the picked value, and how to pick a row
    var pickField: String?
    var picked: String?
    var pick: ((JSONValue) -> Void)?
    /// replaces this view's definition in the panel (its own fields, as JSON); an error message, or nil when saved
    var edit: ((JSONValue) async -> String?)?

    var data: JSONValue { state.data }

    /// what a view keeps across re-renders depends on what it draws (panels.mjs memo key)
    static func memoKey(owner: String, _ v: BrickSpec) -> String {
        let parts: [JSONValue?] = [.string(v.id), .string(v.brick), v.source.map(JSONValue.string), v["x"], v["y"], v["agg"], v["scale"]]
        return owner + "|" + Bricks.compact(.array(parts.map { $0 ?? .null }))
    }
}

/// What views keep across re-renders, by memo key: a chart's samples, which bars a timeline already grew.
@MainActor
enum BrickMemos {
    static var store: [String: AnyObject] = [:]
    static func get<T: AnyObject>(_ key: String, _ make: () -> T) -> T {
        if let m = store[key] as? T { return m }
        let m = make()
        store[key] = m
        return m
    }
    /// a panel went away: what its views kept goes too
    static func drop(owner: String) { store = store.filter { !$0.key.hasPrefix(owner + "|") } }
}

/// motion off: Reduce Motion, or a snapshot (everything at its final place)
struct StillKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var stillMotion: Bool { get { self[StillKey.self] } set { self[StillKey.self] = newValue } }
}

/// CSS's cubic-bezier(x1, y1, x2, y2): progress at time t (0…1)
struct Bezier {
    let x1, y1, x2, y2: Double
    static let spring = Bezier(x1: 0.34, y1: 1.25, x2: 0.64, y2: 1) // re-rank, row slide, bar growth
    static let out = Bezier(x1: 0.22, y1: 1, x2: 0.36, y2: 1)        // widths

    func callAsFunction(_ t: Double) -> Double {
        let t = min(1, max(0, t))
        func c(_ a: Double, _ b: Double, _ s: Double) -> Double { 3 * a * (1 - s) * (1 - s) * s + 3 * b * (1 - s) * s * s + s * s * s }
        var s = t
        for _ in 0..<8 { // Newton on x(s) = t
            let x = c(x1, x2, s) - t
            let dx = 3 * x1 * (1 - s) * (1 - s) + 6 * (x2 - x1) * (1 - s) * s + 3 * (1 - x2) * s * s
            if abs(x) < 1e-5 || abs(dx) < 1e-6 { break }
            s = min(1, max(0, s - x / dx))
        }
        return c(y1, y2, s)
    }
    var animation: (Double) -> Animation { { .timingCurve(x1, y1, x2, y2, duration: $0) } }
}

extension Animation {
    /// the ease every value move uses (1-(1-t)³), 450 ms
    static let brickMove = Animation.timingCurve(0.215, 0.61, 0.355, 1, duration: 0.45)
}

/// a number that counts to its new value as it animates
struct CountText: View, Animatable {
    var value: Double
    let format: (Double) -> String
    var animatableData: Double { get { value } set { value = newValue } }
    var body: some View { Text(format(value)) }
}

protocol BrickView: View {
    /// the brick's name in specs ("table")
    static var name: String { get }
    /// the card shows how old the data is (a big number doesn't need it)
    static var showsAge: Bool { get }
    init(ctx: BrickContext)
}
extension BrickView { static var showsAge: Bool { true } }

enum BrickRegistry {
    /// every brick the app can draw; a new brick is a file and a line here
    static let all: [any BrickView.Type] = [
        TableBrick.self, LogBrick.self, StatBrick.self, KVBrick.self, MarkdownBrick.self, JSONBrick.self,
        ChartBrick.self, TimelineBrick.self, BarsBrick.self, SceneBrick.self,
    ]
    static let byName: [String: any BrickView.Type] = Dictionary(uniqueKeysWithValues: all.map { ($0.name, $0) })

    /// the brick for a view; one the app doesn't know yet shows its data as JSON
    static func view(_ ctx: BrickContext) -> AnyView {
        func make<B: BrickView>(_ b: B.Type) -> AnyView { AnyView(b.init(ctx: ctx)) }
        let type: any BrickView.Type = byName[ctx.view.brick] ?? JSONBrick.self
        return make(type)
    }

    static func hidesAge(_ brick: String) -> Bool { !(byName[brick]?.showsAge ?? true) }
}

// ---------- shared pieces ----------

extension Tone {
    var color: Color? {
        switch self {
        case .good: JB.ok
        case .warn: JB.warn
        case .bad: JB.err
        case .none: nil
        }
    }
}

/// a scroll view of a fixed height, or (in a snapshot, which can't draw scroll views) the top of the content
struct BrickScroll<Content: View>: View {
    var axes: Axis.Set = .vertical
    let height: CGFloat
    var bottom = false
    @ViewBuilder let content: () -> Content
    @Environment(\.isSnapshot) private var isSnapshot

    var body: some View {
        let wide = axes.contains(.horizontal)
        if isSnapshot {
            content().fixedSize(horizontal: wide, vertical: false)
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .frame(height: height, alignment: bottom ? .bottomLeading : .topLeading).clipped()
        } else if wide {
            ScrollView(axes) { content() }
                .defaultScrollAnchor(bottom ? .bottomLeading : .topLeading)
                .frame(height: height)
        } else {
            ScrollView(axes) { content().frame(maxWidth: .infinity, alignment: .topLeading) }
                .defaultScrollAnchor(bottom ? .bottom : .top)
                .frame(height: height)
        }
    }
}

/// "veri yok": a source with nothing yet
struct BrickEmpty: View {
    var text = "veri yok"
    var body: some View { Text(text).font(.system(size: 12)).foregroundStyle(JB.muted).padding(.vertical, 4) }
}

/// times in data: epoch seconds or milliseconds, or ISO 8601 text
enum BrickTime {
    static func date(_ v: JSONValue?) -> Date? {
        switch v {
        case .number(let n)?: return Date(timeIntervalSince1970: n > 1e11 ? n / 1000 : n)
        case .string(let s)?:
            if let n = Double(s) { return date(.number(n)) }
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let d = f.date(from: s) { return d }
            f.formatOptions = [.withInternetDateTime]
            return f.date(from: s)
        default: return nil
        }
    }
}
