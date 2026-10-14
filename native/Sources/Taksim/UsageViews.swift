import SwiftUI
import TaksimKit

// A login's plan at a glance (src/usage.mjs): one thin bar per window, the 5-hour one over the week's.
// Calm bars stay grey; yellow from 75 %, red when full. Hovering says which window and when it resets.

extension Usage.Level {
    var color: Color { switch self { case .calm: JB.muted; case .high: JB.warn; case .full: JB.err } }
}

/// the main windows as stacked hairline bars
struct UsageBars: View {
    let usage: Usage
    var width: CGFloat = 28
    var body: some View {
        VStack(spacing: 2) {
            ForEach(usage.main) { w in
                Capsule().fill(JB.line).frame(width: width, height: 3)
                    .overlay(alignment: .leading) {
                        Capsule().fill((usage.limited == true && w.used >= 0.99 ? .full : Usage.level(w.used)).color)
                            .frame(width: max(2, width * min(1, w.used)), height: 3)
                    }
            }
        }
        .animation(.spring(response: 0.5, dampingFraction: 0.8), value: usage.windows)
        .help(usage.main.map { w in [Usage.name(w.id), Usage.percent(w.used), Usage.until(w.resetsAt).map { "↻ \($0)" }].compactMap { $0 }.joined(separator: " ") }.joined(separator: "\n"))
    }
}

/// the header's gauges: one per login the open canvas uses; a click opens every login's numbers
struct UsageHeader: View {
    let store: CanvasStore
    @State private var open = false

    var body: some View {
        let shown = store.canvasLogins.compactMap { l in store.usage(for: l.key).map { (l, $0) } }
        if !shown.isEmpty {
            Button { open.toggle() } label: {
                HStack(spacing: 10) {
                    ForEach(shown, id: \.0.key) { l, u in
                        HStack(spacing: 5) {
                            BackendTile(backend: l.login.backend, size: 14)
                            // the name tells two logins of one CLI apart
                            if let n = l.login.short {
                                Text(n.count > 14 ? n.prefix(13) + "…" : n).font(.system(size: 11.5, weight: .medium)).foregroundStyle(JB.muted).lineLimit(1).fixedSize()
                            }
                            UsageBars(usage: u, width: 26)
                        }
                        .help([l.login.title, l.login.detail].filter { !$0.isEmpty }.joined(separator: "\n"))
                    }
                }
                .padding(.horizontal, 8).frame(height: 28).contentShape(Rectangle())
            }
            .buttonStyle(Press())
            .popover(isPresented: $open, arrowEdge: .bottom) { UsagePanel(store: store) }
            .transition(.opacity.combined(with: .scale(scale: 0.9)))
            .accessibilityLabel(L("Usage"))
        }
    }
}

/// every login's windows: name, bar, percent, when it resets; ↻ reads them all again
struct UsagePanel: View {
    let store: CanvasStore
    @State private var busy = false

    private var rows: [(key: String, login: UsageLogin, usage: Usage)] {
        store.usage.compactMap { key, _ in
            // one row per login: a machine login signed in as a named account shows as that account
            guard store.loginKey(key) == key, let u = store.usage(for: key) else { return nil }
            if let l = store.usageLogins[key] { return (key, l, u) }
            // not described yet: what the key itself says
            if key.hasPrefix("machine:") { return (key, UsageLogin(backend: String(key.dropFirst("machine:".count)), machine: true), u) }
            guard let a = store.accounts.first(where: { $0.id == key }) else { return nil }
            return (key, UsageLogin(backend: a.backend, name: a.name, email: a.status?.email), u)
        }
        .sorted { ($0.login.backend, $0.login.machine == true ? 0 : 1, $0.login.title) < ($1.login.backend, $1.login.machine == true ? 0 : 1, $1.login.title) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(rows, id: \.key) { r in
                VStack(alignment: .leading, spacing: 7) {
                    HStack(spacing: 8) {
                        BackendTile(backend: r.login.backend, size: 20)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(r.login.title).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(JB.ink).lineLimit(1)
                            let detail = r.login.detail.isEmpty ? (r.usage.plan ?? "") : r.login.detail
                            if !detail.isEmpty { Text(detail).font(.system(size: 11)).foregroundStyle(JB.muted).lineLimit(1).truncationMode(.middle) }
                        }
                        Spacer(minLength: 8)
                        if r.usage.limited == true {
                            Text(L("full")).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(JB.err)
                        } else if r.usage.overage == true {
                            Text(L("Overage")).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(JB.warn)
                        }
                    }
                    ForEach(r.usage.windows) { w in WindowRow(window: w, limited: r.usage.limited == true) }
                    if let b = r.usage.credits?.balance {
                        HStack { Text(L("Credits")).foregroundStyle(JB.muted); Spacer(); Text(String(format: "%.2f", b)).foregroundStyle(JB.ink).monospacedDigit() }
                            .font(.system(size: 11.5))
                    }
                }
            }
            if rows.isEmpty { Text("—").foregroundStyle(JB.muted).frame(maxWidth: .infinity) }
            HStack {
                Spacer()
                Button { Task { busy = true; await store.refreshUsage(force: true); await store.loadChoices(); busy = false } } label: {
                    if busy { ProgressView().controlSize(.mini).frame(width: 14, height: 14) }
                    else { Image(systemName: "arrow.clockwise").font(.system(size: 11, weight: .semibold)).frame(width: 14, height: 14) }
                }
                .buttonStyle(HeaderIconStyle()).help(L("Refresh")).disabled(busy)
            }
        }
        .padding(14)
        .frame(width: 310)
        .background(JB.panel)
        .task { await store.loadChoices(); await store.refreshUsage() }
    }
}

private struct WindowRow: View {
    let window: Usage.Window
    let limited: Bool
    var body: some View {
        let level: Usage.Level = limited && window.used >= 0.99 ? .full : Usage.level(window.used)
        HStack(spacing: 8) {
            Text(Usage.name(window.id)).font(.system(size: 11.5)).foregroundStyle(JB.muted).frame(width: 86, alignment: .leading)
            Capsule().fill(JB.line).frame(height: 5)
                .overlay(alignment: .leading) {
                    GeometryReader { g in Capsule().fill(level.color).frame(width: max(3, g.size.width * min(1, window.used))) }
                }
            Text(Usage.percent(window.used)).font(.system(size: 11.5, weight: .medium)).foregroundStyle(level == .calm ? JB.ink : level.color)
                .monospacedDigit().frame(width: 36, alignment: .trailing)
            Text(Usage.until(window.resetsAt).map { "↻ \($0)" } ?? "").font(.system(size: 10.5)).foregroundStyle(JB.muted2)
                .monospacedDigit().lineLimit(1).fixedSize().frame(minWidth: 62, alignment: .trailing)
        }
        .frame(height: 16)
    }
}
