import SwiftUI
import TaksimKit

/// "1 file", "2 files": the singular where it is one
func countText(_ n: Int, one: String, other: String) -> String { n == 1 ? L(one) : L(other, n) }

/// Actual tool execution as Cursor shows it: plain muted lines, no card. The verb is a little brighter than what it
/// worked on; a chevron after the words opens the details.
struct ChatActivityView: View {
    let activities: [ChatActivity]
    @State private var expanded = false
    @State private var hover = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isSnapshot) private var isSnapshot

    private var failed: Int { activities.filter { $0.status == "error" }.count }
    private var active: ChatActivity? { activities.last { $0.status == "running" } }
    private var summary: String {
        failed > 0 ? "\(countText(activities.count, one: "1 operation", other: "%d operations")) · \(countText(failed, one: "1 error", other: "%d errors"))"
                   : countText(activities.count, one: "1 operation", other: "%d operations")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 5) {
                    if let active {
                        Text(active.label).foregroundStyle(JB.muted)
                        if !active.detail.isEmpty { Text(active.detail).foregroundStyle(JB.muted2).lineLimit(1).truncationMode(.middle) }
                    } else {
                        if failed > 0 { Image(systemName: "exclamationmark.triangle").foregroundStyle(JB.err).font(.system(size: 11)) }
                        Text(summary).foregroundStyle(JB.muted).lineLimit(1)
                    }
                    Image(systemName: "chevron.right").font(.system(size: 8.5, weight: .semibold)).foregroundStyle(JB.muted2)
                        .rotationEffect(.degrees(expanded ? 90 : 0)).opacity(hover || expanded ? 1 : 0)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(Tap()).help(L("Activity details"))
            .onHover { hover = $0 }
            if expanded {
                ForEach(activities) { activity in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 5) {
                            if activity.status == "error" { Image(systemName: "exclamationmark.triangle").foregroundStyle(JB.err).font(.system(size: 10.5)) }
                            Text(activity.label).foregroundStyle(JB.muted)
                            if activity.status == "running" { Image(systemName: "ellipsis").foregroundStyle(JB.muted2) }
                        }
                        if !activity.detail.isEmpty {
                            Text(activity.detail).font(.system(size: 11.5, design: .monospaced)).textSelection(.enabled)
                                .foregroundStyle(JB.muted2).lineLimit(8)
                                .padding(.leading, 2)
                        }
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .font(.system(size: 13)).foregroundStyle(JB.muted)
        .animation(reduceMotion || isSnapshot ? nil : .spring(response: 0.35, dampingFraction: 0.86), value: expanded)
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
