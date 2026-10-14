import AppKit
import SwiftUI
import TaksimKit

// Settings › Connections (src/connectors.mjs): the services panels can read. A token is pasted once and goes
// to the keychain; the row then says who it signs in as. Agents only ever see the data.

private struct Connection: Decodable, Identifiable {
    var id: String; var label: String; var tokenHelp: String?; var tokenHint: String?
    var connected: Bool; var who: String?
}
private struct ConnectionList: Decodable { var connections: [Connection] }

struct ConnectionsPane: View {
    let api: APIClient?
    @State private var list: [Connection] = []
    @State private var tokens: [String: String] = [:]
    @State private var busy: String?
    @State private var problem: [String: String] = [:]

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(list) { c in
                    row(c)
                    if c.id != list.last?.id { Rectangle().fill(JB.line).frame(height: 1).padding(.leading, 50) }
                }
            }
            .background(RoundedRectangle(cornerRadius: 8).fill(JB.panel))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(JB.line))
            .padding(20)
            .animation(.spring(response: 0.4, dampingFraction: 0.85), value: list.map(\.connected))
        }
        .task { await load() }
    }

    private func row(_ c: Connection) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                ServiceMark(id: c.id).saturation(c.connected ? 1 : 0.2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(c.label).font(.system(size: 13)).foregroundStyle(JB.ink)
                    if c.connected {
                        HStack(spacing: 5) {
                            Circle().fill(JB.ok).frame(width: 6, height: 6)
                            Text(c.who ?? L("connected")).font(.system(size: 11.5)).foregroundStyle(JB.muted).lineLimit(1)
                        }
                    }
                }
                Spacer(minLength: 8)
                if c.connected {
                    Menu {
                        Button(L("Replace token")) { tokens[c.id] = "" }
                        Divider()
                        Button(L("Remove connection"), role: .destructive) { Task { await remove(c) } }
                    } label: {
                        Image(systemName: "ellipsis").font(.system(size: 12, weight: .semibold)).foregroundStyle(JB.muted).frame(width: 24, height: 24)
                    }
                    .menuStyle(.button).buttonStyle(Press()).menuIndicator(.hidden).fixedSize()
                }
            }
            // the one action while it isn't connected: paste the token, Enter
            if !c.connected || tokens[c.id] != nil {
                HStack(spacing: 8) {
                    SecureField("", text: Binding(get: { tokens[c.id] ?? "" }, set: { tokens[c.id] = $0 }), prompt: Text(c.tokenHint ?? "token").foregroundStyle(JB.muted2))
                        .textFieldStyle(.plain).font(.system(size: 12, design: .monospaced))
                        .padding(.horizontal, 8).frame(height: 26)
                        .background(RoundedRectangle(cornerRadius: 5).fill(JB.bg.opacity(0.6)))
                        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(problem[c.id] == nil ? JB.line : JB.err))
                        .onSubmit { Task { await save(c) } }
                    if let help = c.tokenHelp, let url = URL(string: help) {
                        Button { NSWorkspace.shared.open(url) } label: { Image(systemName: "questionmark.circle").font(.system(size: 13)).foregroundStyle(JB.muted) }
                            .buttonStyle(Press()).help(L("Where to get the token"))
                    }
                    Button { Task { await save(c) } } label: {
                        if busy == c.id { ProgressView().controlSize(.mini).frame(width: 40) }
                        else { Text(L("Connect")).font(.system(size: 12, weight: .semibold)).foregroundStyle(JB.accentInk) }
                    }
                    .buttonStyle(Press())
                    .padding(.horizontal, 12).frame(height: 26).background(Capsule().fill(JB.accent))
                    .disabled((tokens[c.id] ?? "").trimmingCharacters(in: .whitespaces).isEmpty || busy != nil)
                }
                .padding(.leading, 40)
                if let why = problem[c.id] {
                    Label(why, systemImage: "exclamationmark.triangle.fill").font(.system(size: 11.5)).foregroundStyle(JB.err).lineLimit(2).padding(.leading, 40)
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 12)
    }

    private func load() async {
        guard let api, let l = try? await api.get("/v1/connections", as: ConnectionList.self) else { return }
        list = l.connections
    }
    private func save(_ c: Connection) async {
        guard let api, let t = tokens[c.id]?.trimmingCharacters(in: .whitespaces), !t.isEmpty else { return }
        busy = c.id; problem[c.id] = nil
        defer { busy = nil }
        do {
            _ = try await api.put("/v1/connections/\(c.id)", ["token": t])
            tokens[c.id] = nil
            await load()
        } catch { problem[c.id] = (error as? APIError)?.message ?? error.localizedDescription }
    }
    private func remove(_ c: Connection) async {
        guard let api else { return }
        _ = try? await api.delete("/v1/connections/\(c.id)")
        await load()
    }
}

/// a service's mark: its initial on its brand color, the way BackendTile marks CLIs
struct ServiceMark: View {
    let id: String
    var size: CGFloat = 28
    var body: some View {
        let (color, symbol): (Color, String) = switch id {
        case "slack": (Color(red: 0.29, green: 0.08, blue: 0.29), "number")
        case "github": (Color(red: 0.14, green: 0.16, blue: 0.18), "chevron.left.forwardslash.chevron.right")
        case "linear": (Color(red: 0.37, green: 0.42, blue: 0.82), "circle.lefthalf.filled")
        case "jira": (Color(red: 0.00, green: 0.32, blue: 0.80), "square.stack.3d.up.fill")
        case "jev": (JB.panel2, "arrow.triangle.branch")
        default: (JB.panel2, "link")
        }
        RoundedRectangle(cornerRadius: size * 0.24).fill(color).frame(width: size, height: size)
            .overlay(RoundedRectangle(cornerRadius: size * 0.24).strokeBorder(JB.line)) // a dark mark stays visible on a dark panel
            .overlay(Image(systemName: symbol).font(.system(size: size * 0.45, weight: .bold)).foregroundStyle(.white))
    }
}
