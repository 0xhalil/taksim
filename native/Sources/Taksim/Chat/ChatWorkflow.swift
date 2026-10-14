import SwiftUI
import TaksimKit

/// The plan's handle in the chat: its name, how far it is, the way to its dock and the one action. The plan itself
/// is read, selected from and edited in the dock beside the node.
struct ChatPlanCard: View {
    let plan: ChatPlan
    let model: ChatModel
    let store: CanvasStore
    let running: Bool
    private var available: Bool { !running && model.queue.isEmpty && !model.workflowBusy }
    private var status: String {
        switch plan.status { case "running": L("Applying"); case "done": L("Done"); case "failed": L("Failed"); default: L("Ready for review") }
    }
    var body: some View {
        HStack(spacing: 8) {
            // the whole left side opens the plan
            Button { model.planShown.toggle() } label: {
                HStack(spacing: 7) {
                    Image(systemName: "list.bullet.clipboard").foregroundStyle(JB.accent)
                    Text(plan.title).fontWeight(.medium).lineLimit(1)
                    Text("v\(plan.version)").foregroundStyle(JB.muted2).fixedSize()
                    Text(status).foregroundStyle(plan.status == "done" ? JB.ok : plan.status == "failed" ? JB.err : JB.muted).lineLimit(1).layoutPriority(-1)
                    Spacer(minLength: 0)
                    Image(systemName: "sidebar.right").foregroundStyle(model.planShown ? JB.accent : JB.muted)
                }.contentShape(Rectangle())
            }
            .buttonStyle(Tap()).help(model.planShown ? L("Close plan") : L("Open plan beside the chat"))
            if plan.status == "draft" {
                Button { action("build") } label: { Label(L("Apply plan"), systemImage: "play.fill").lineLimit(1).fixedSize() }
                    .buttonStyle(Tap()).foregroundStyle(JB.accent).disabled(!available)
                    .help(L("Apply version %d of this plan in Agent mode", plan.version))
            } else if plan.status != "running" {
                Button { action("revise") } label: { Label(L("Replan"), systemImage: "arrow.clockwise").lineLimit(1).fixedSize() }
                    .buttonStyle(Tap()).disabled(!available)
            }
        }
        .font(.system(size: 11.5)).foregroundStyle(JB.ink).padding(.horizontal, 12).frame(height: 38)
        .background(RoundedRectangle(cornerRadius: 8).fill(JB.panel))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(JB.line))
    }
    private func action(_ action: String) {
        Task { await model.changeWorkflow(["action": action, "id": plan.id, "version": plan.version], store: store) }
    }
}

struct ChatQuestionCard: View {
    let question: ChatQuestion
    let model: ChatModel
    let store: CanvasStore
    @State private var answers: [String: String] = [:]
    @Environment(\.isSnapshot) private var snapshot
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var complete: Bool { question.questions.allSatisfy { !(answers[$0.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(L("Waiting for your reply"), systemImage: "questionmark.bubble").foregroundStyle(JB.accent)
                Spacer()
                Button { model.stop() } label: { Image(systemName: model.stopping ? "ellipsis" : "stop.fill") }.buttonStyle(Tap()).help(L("Stop")).disabled(model.stopping)
            }
            if snapshot { fields }
            else { ViewThatFits(in: .vertical) { fields; ScrollView { fields } }.frame(maxHeight: 300) } // as tall as its questions, scrolling only past the cap
            HStack {
                Text("\(question.questions.filter { !(answers[$0.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.count)/\(question.questions.count)").monospacedDigit().foregroundStyle(JB.muted)
                Spacer()
                Button { Task { await model.changeWorkflow(["action": "answer", "id": question.id, "answers": answers], store: store) } } label: {
                    Label(model.workflowBusy ? L("Sending…") : L("Continue"), systemImage: "arrow.up")
                }.buttonStyle(Tap()).foregroundStyle(JB.accent).disabled(!complete || model.workflowBusy)
            }
        }
        .font(.system(size: 11.5)).padding(10).background(JB.panel)
        .animation(reduceMotion || snapshot ? nil : .easeOut(duration: 0.15), value: answers)
        .onChange(of: question.id) { answers = [:] }
    }
    private var fields: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(question.questions) { q in
                VStack(alignment: .leading, spacing: 5) {
                    Text(q.title).fontWeight(.medium).textSelection(.enabled)
                    ForEach(Array(q.options.enumerated()), id: \.offset) { _, option in
                        Button { answers[q.id] = option } label: {
                            HStack(alignment: .top, spacing: 6) {
                                Image(systemName: answers[q.id] == option ? "checkmark.circle.fill" : "circle")
                                Text(option).multilineTextAlignment(.leading)
                            }.foregroundStyle(answers[q.id] == option ? JB.accent : JB.muted)
                        }.buttonStyle(Tap())
                    }
                    if snapshot { Text(L("Your reply")).foregroundStyle(JB.muted2).padding(7).frame(maxWidth: .infinity, alignment: .leading).background(RoundedRectangle(cornerRadius: 5).fill(JB.bg)) }
                    else { TextField(L("Your reply"), text: Binding(get: { answers[q.id] ?? "" }, set: { answers[q.id] = $0 }), axis: .vertical)
                        .textFieldStyle(.plain).lineLimit(1...3).padding(7)
                        .background(RoundedRectangle(cornerRadius: 5).fill(JB.bg))
                    }
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
