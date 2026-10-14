import SwiftUI
import TaksimKit

/// Actual tool execution, collapsed to one line until the person asks for detail.
struct ChatActivityView: View {
    let activities: [ChatActivity]
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isSnapshot) private var isSnapshot

    private var failed: Int { activities.filter { $0.status == "error" }.count }
    private var active: ChatActivity? { activities.last { $0.status == "running" } }
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 6) {
                    Image(systemName: active == nil ? (failed > 0 ? "exclamationmark.triangle" : "checkmark.circle") : "gearshape")
                        .foregroundStyle(active == nil ? (failed > 0 ? JB.err : JB.muted) : JB.accent)
                    Text(active?.label ?? (failed > 0 ? L("%d operations · %d errors", activities.count, failed) : L("%d operations", activities.count))).lineLimit(1)
                    if let active, !active.detail.isEmpty { Text(active.detail).font(.system(size: 10.5, design: .monospaced)).lineLimit(1).truncationMode(.middle).foregroundStyle(JB.muted2) }
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(Tap()).help(L("Activity details"))
            if expanded {
                ForEach(activities) { activity in
                    HStack(alignment: .top, spacing: 7) {
                        Image(systemName: symbol(activity.status)).foregroundStyle(color(activity.status)).frame(width: 14)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(activity.label).fontWeight(.medium)
                            if !activity.detail.isEmpty {
                                Text(activity.detail).font(.system(size: 10.5, design: .monospaced)).textSelection(.enabled)
                                    .foregroundStyle(JB.muted).lineLimit(8)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 2)
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .font(.system(size: 11)).foregroundStyle(JB.muted)
        .padding(8).background(RoundedRectangle(cornerRadius: 7).fill(JB.panel.opacity(0.5)))
        .animation(reduceMotion || isSnapshot ? nil : .spring(response: 0.35, dampingFraction: 0.86), value: expanded)
    }

    private func symbol(_ status: String) -> String {
        switch status { case "done": "checkmark"; case "error": "exclamationmark.triangle"; case "cancelled": "stop"; default: "ellipsis" }
    }
    private func color(_ status: String) -> Color {
        switch status { case "done": JB.ok; case "error": JB.err; default: JB.muted }
    }
}

/// It can't start yet: the agents named here are writing in its folder. A press goes to the first of them.
struct ChatBlocked: View {
    let names: [String]
    let reveal: () -> Void
    var body: some View {
        Button(action: reveal) {
            HStack(spacing: 6) {
                Image(systemName: "lock").foregroundStyle(JB.wait)
                Text(names.joined(separator: ", ")).lineLimit(1)
                Image(systemName: "arrow.up.right").font(.system(size: 9))
            }
            .font(.system(size: 11)).foregroundStyle(JB.muted).padding(.vertical, 5).contentShape(Rectangle())
        }
        .buttonStyle(Tap()).help(L("Waiting: this agent is writing in the same folder"))
        .accessibilityLabel(L("Waiting for %@ to finish writing", names.joined(separator: ", ")))
    }
}

/// A quiet living indicator, used only while work is actually in progress.
struct ChatWorking: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isSnapshot) private var isSnapshot
    @State private var since = Date.now
    var body: some View {
        HStack(spacing: 6) {
            if reduceMotion || isSnapshot { Image(systemName: "ellipsis") }
            else {
                TimelineView(.animation(minimumInterval: 0.1)) { context in
                    let time = context.date.timeIntervalSinceReferenceDate
                    HStack(spacing: 3) {
                        ForEach(0..<3) { i in
                            Circle().fill(JB.accent).frame(width: 4, height: 4)
                                .opacity(0.3 + 0.7 * (sin(time * 4 - Double(i) * 0.9) + 1) / 2)
                        }
                    }
                }
            }
            if isSnapshot {
                Text(L("Working…")).font(.system(size: 11))
            } else {
                TimelineView(.periodic(from: since, by: 1.0)) { context in
                    let secs = max(0, Int(context.date.timeIntervalSince(since)))
                    Text(secs > 0 ? L("Working… %ds", secs) : L("Working…")).font(.system(size: 11))
                }
            }
        }
        .foregroundStyle(JB.muted).padding(.vertical, 5).accessibilityLabel(L("Agent is working"))
    }
}
