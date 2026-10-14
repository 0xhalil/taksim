import SwiftUI
import TaksimKit

// Where a view's numbers come from (Claude Dashboards' "click a number, see its query"): the source as it
// runs — the command, the SQL, the service call, the address or the file — then how its rows are narrowed,
// how many there are and when they were read. ↻ reads it again; Explain asks the agent to walk through it.

struct SourceAudit: View {
    let name: String
    let def: JSONValue
    let state: SourceState
    let heading: String
    let refresh: () -> Void
    let explain: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                Image(systemName: symbol).font(.system(size: 12)).foregroundStyle(JB.accent).frame(width: 16)
                Text(kindLabel).font(.system(size: 12, weight: .semibold)).foregroundStyle(JB.ink)
                Text(name).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(JB.muted)
                Spacer(minLength: 8)
                if let s = def["every_s"]?.number { Label(L("%d s", Int(s)), systemImage: "arrow.triangle.2.circlepath").font(.system(size: 10.5)).foregroundStyle(JB.muted) }
            }
            if let what = what {
                Text(what).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(JB.ink)
                    .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 5).fill(JB.bg.opacity(0.7)))
            }
            // how the rows are narrowed after they come in
            let narrowing = ["pick", "where", "sort", "limit"].compactMap { k in def[k].map { (k, Self.text($0)) } }
            if !narrowing.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(narrowing, id: \.0) { k, v in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(k).font(.system(size: 11)).foregroundStyle(JB.muted).frame(width: 40, alignment: .leading)
                            Text(v).font(.system(size: 11, design: .monospaced)).foregroundStyle(JB.text).textSelection(.enabled)
                        }
                    }
                }
            }
            HStack(spacing: 10) {
                Text(rowsText).font(.system(size: 11)).foregroundStyle(JB.muted)
                if let ts = state.updatedAt {
                    Text(Date(timeIntervalSince1970: ts / 1000).formatted(date: .omitted, time: .standard)).font(.system(size: 11)).foregroundStyle(JB.muted2).monospacedDigit()
                }
                Spacer()
                Button { refresh() } label: { Image(systemName: "arrow.clockwise").font(.system(size: 11, weight: .semibold)) }
                    .buttonStyle(StripButton()).help(L("Refresh"))
                Button { explain(prompt) } label: { Text(L("Explain")) }.buttonStyle(StripButton(primary: true))
            }
        }
        .padding(12)
        .frame(width: 360)
        .background(JB.panel)
    }

    private var brick: String { def["brick"]?.string ?? "" }
    private var kindLabel: String {
        switch brick {
        case "command": L("Command")
        case "sql": "SQL · \(def["engine"]?.string ?? "")"
        case "connector": ["slack": "Slack", "github": "GitHub"][def["service"]?.string ?? ""] ?? (def["service"]?.string ?? "")
        case "http": L("Address")
        case "tail": L("File")
        default: L("Agent")
        }
    }
    private var symbol: String {
        switch brick {
        case "command": "terminal"
        case "sql": "cylinder.split.1x2"
        case "connector": "link"
        case "http": "globe"
        case "tail": "doc.text"
        default: "sparkles"
        }
    }
    /// the thing itself, as one would type it
    private var what: String? {
        switch brick {
        case "command":
            let argv: [String] = (def["run"]?.array ?? []).compactMap(\.string)
            return argv.map { $0.contains(" ") ? "'" + $0 + "'" : $0 }.joined(separator: " ")
        case "sql": return [def["db"]?.string, def["query"]?.string].compactMap { $0 }.joined(separator: "\n")
        case "connector":
            let params: JSONObject = def["params"]?.object ?? [:]
            let lines: [String] = params.keys.sorted().map { k in k + "=" + Self.text(params[k] ?? .null) }
            return ([def["call"]?.string ?? ""] + lines).joined(separator: "\n")
        case "http": return def["url"]?.string
        case "tail": return def["path"]?.string
        default: return nil
        }
    }
    private var rowsText: String {
        if case .array(let a) = state.data { return L("%d rows", a.count) }
        return state.data == .null ? L("No data") : L("1 record")
    }
    private var prompt: String {
        "Explain the numbers in the view \"\(heading)\" of your panel. It shows the source \"\(name)\": \(Self.text(def)). "
            + "Walk through what it runs or asks, how its rows are filtered, grouped and counted, and anything that could make the numbers misleading. Keep it short."
    }
    static func text(_ v: JSONValue) -> String {
        if let s = v.string { return s }
        if let d = try? JSONEncoder().encode(v), let s = String(data: d, encoding: .utf8) { return s }
        return ""
    }
}
