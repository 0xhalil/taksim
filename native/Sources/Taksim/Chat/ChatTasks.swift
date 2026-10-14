import SwiftUI
import TaksimKit

/// Live progress stays beside the composer, even while the user reads earlier messages.
struct ChatTaskList: View {
    let tasks: [ChatTask]
    let live: Bool
    var paused = false
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isSnapshot) private var snapshot
    private var completed: Int { tasks.filter { $0.status == "completed" }.count }
    private var cancelled: Int { tasks.filter { $0.status == "cancelled" }.count }
    private var blocked: Int { tasks.filter { $0.status == "blocked" }.count }
    private var active: [ChatTask] { tasks.filter { $0.status == "in_progress" } }
    private var summary: ChatTask? { active.first ?? tasks.first { $0.status == "blocked" } ?? tasks.first { $0.status == "pending" } }
    private var title: String { live ? L("Tasks") : completed == tasks.count ? L("Done") : cancelled == tasks.count ? L("Cancelled") : L("Incomplete") }
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 7) {
                    Image(systemName: completed == tasks.count ? "checkmark.circle" : "checklist")
                        .foregroundStyle(completed == tasks.count ? JB.ok : JB.accent)
                    Text(title)
                    Text("\(completed)/\(tasks.count)").monospacedDigit().contentTransition(.numericText()).foregroundStyle(JB.muted)
                    if cancelled > 0 { Text(L("%d cancelled", cancelled)).foregroundStyle(JB.muted2) }
                    if blocked > 0 { Text(L("%d blocked", blocked)).foregroundStyle(JB.warn) }
                    if paused { Image(systemName: "pause.circle").foregroundStyle(JB.muted).help(L("Waiting for a reply")) }
                    else if active.count > 1 { Text(L("%d active", active.count)).foregroundStyle(JB.muted) }
                    Spacer(minLength: 0)
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").foregroundStyle(JB.muted2)
                }.contentShape(Rectangle())
            }.buttonStyle(Tap()).help(expanded ? L("Collapse tasks") : L("Show tasks"))
            HStack(spacing: 3) {
                ForEach(tasks) { task in
                    Capsule().fill(task.status == "completed" ? JB.ok : task.status == "in_progress" ? JB.accent : task.status == "blocked" ? JB.warn : JB.line)
                        .frame(height: 3)
                }
            }.accessibilityHidden(true)
            if expanded {
                if live && !snapshot { ScrollView { rows }.frame(maxHeight: 160).scrollIndicators(.hidden) }
                else { rows }
            } else if live, let summary { row(summary) }
        }
        .font(.system(size: 11.5)).foregroundStyle(JB.ink).padding(9)
        .background(RoundedRectangle(cornerRadius: 6).fill(JB.panel))
        .animation(reduceMotion || snapshot ? nil : .spring(response: 0.3, dampingFraction: 0.88), value: expanded)
        .animation(reduceMotion || snapshot ? nil : .easeOut(duration: 0.2), value: tasks)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L("Tasks, %2$d of %1$d steps done", tasks.count, completed))
    }
    private var rows: some View {
        VStack(alignment: .leading, spacing: 7) { ForEach(tasks) { row($0) } }
            .frame(maxWidth: .infinity, alignment: .leading)
    }
    private func row(_ task: ChatTask) -> some View {
        let status = task.status == "completed" ? L("Done") : task.status == "cancelled" ? L("Cancelled") : task.status == "blocked" ? L("Blocked") : task.status == "in_progress" ? (paused ? L("Waiting") : L("Working")) : L("Not done")
        let priority = task.priority == "high" ? L(" · High priority") : task.priority == "medium" ? L(" · Medium priority") : task.priority == "low" ? L(" · Low priority") : ""
        return HStack(alignment: .top, spacing: 7) {
            Image(systemName: task.status == "completed" ? "checkmark.circle.fill" : task.status == "in_progress" ? (paused ? "pause.circle" : "arrow.trianglehead.2.clockwise.rotate.90") : task.status == "blocked" ? "exclamationmark.circle" : task.status == "cancelled" ? "minus.circle" : "circle")
                .foregroundStyle(task.status == "completed" ? JB.ok : task.status == "in_progress" ? JB.accent : task.status == "blocked" ? JB.warn : JB.muted2)
                .frame(width: 14)
            Text(task.status == "in_progress" ? task.activeForm ?? task.content : task.content).strikethrough(task.status == "cancelled")
                .foregroundStyle(task.status == "cancelled" ? JB.muted2 : JB.ink).lineLimit(live && !expanded ? 2 : nil).textSelection(.enabled)
        }.frame(maxWidth: .infinity, alignment: .leading).help("\(task.content) — \(status)\(priority)")
            .accessibilityLabel("\(task.content), \(status)\(priority)")
    }
}
