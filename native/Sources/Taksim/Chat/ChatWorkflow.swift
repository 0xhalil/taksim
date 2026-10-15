import SwiftUI
import TaksimKit

/// The plan's handle in the chat, as Cursor's plan card: its name, the first lines of it, how far it is, and the one
/// action. The plan itself is read, selected from and edited in the dock beside the node.
struct ChatPlanCard: View {
    let plan: ChatPlan
    let model: ChatModel
    let store: CanvasStore
    let running: Bool
    private var available: Bool { !running && model.queue.isEmpty && !model.workflowBusy }
    private var status: String {
        switch plan.status { case "running": L("Applying"); case "done": L("Done"); case "failed": L("Failed"); default: L("Ready for review") }
    }
    /// the opening lines of the plan as plain words: headings and list marks dropped, the title not repeated
    private var preview: String {
        let skip = CharacterSet(charactersIn: "#-*>+ \t").union(.whitespaces)
        let lines = plan.content.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: skip).replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
                .replacingOccurrences(of: "[ ] ", with: "").replacingOccurrences(of: "[x] ", with: "").replacingOccurrences(of: "[X] ", with: "") }
            .filter { !$0.isEmpty && $0.lowercased() != plan.title.lowercased() && !$0.hasPrefix("```") }
        return lines.prefix(3).joined(separator: "\n")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // the whole top opens the plan
            Button { model.planShown.toggle() } label: {
                HStack(spacing: 7) {
                    Image(systemName: "list.bullet.clipboard").foregroundStyle(JB.accent)
                    Text(plan.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    Text("v\(plan.version)").foregroundStyle(JB.muted2).fixedSize()
                    Spacer(minLength: 0)
                    Text(status).foregroundStyle(plan.status == "done" ? JB.ok : plan.status == "failed" ? JB.err : JB.muted).lineLimit(1)
                    Image(systemName: "sidebar.right").foregroundStyle(model.planShown ? JB.accent : JB.muted)
                }.contentShape(Rectangle())
            }
            .buttonStyle(Tap()).help(model.planShown ? L("Close plan") : L("Open plan beside the chat"))
            if !preview.isEmpty {
                Text(preview).font(.system(size: 12)).foregroundStyle(JB.muted).lineLimit(3).lineSpacing(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                Spacer()
                if plan.status == "draft" {
                    Button { action("build") } label: {
                        Label(L("Apply plan"), systemImage: "play.fill").font(.system(size: 12, weight: .semibold)).foregroundStyle(JB.accentInk)
                            .lineLimit(1).fixedSize().padding(.horizontal, 12).frame(height: 26)
                            .background(RoundedRectangle(cornerRadius: 7).fill(JB.accent))
                    }
                    .buttonStyle(Tap(well: false)).disabled(!available).opacity(available ? 1 : 0.5)
                    .help(L("Apply version %d of this plan in Agent mode", plan.version))
                } else if plan.status != "running" {
                    Button { action("revise") } label: { Label(L("Replan"), systemImage: "arrow.clockwise").lineLimit(1).fixedSize() }
                        .buttonStyle(Tap()).disabled(!available)
                }
            }
        }
        .font(.system(size: 12)).foregroundStyle(JB.ink).padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(JB.panel))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(JB.line))
    }
    private func action(_ action: String) {
        Task { await model.changeWorkflow(["action": action, "id": plan.id, "version": plan.version], store: store) }
    }
}

/// What the agent asks, as Cursor's question card: each question with numbered choices to pick from (a click, or the
/// number) and a line for an answer of one's own; one action, Continue, when every question has an answer. The plan
/// mode's clarifying questions and the permission asks come through the same card.
struct ChatQuestionCard: View {
    let question: ChatQuestion
    let model: ChatModel
    let store: CanvasStore
    @State private var answers: [String: String] = [:]
    @Environment(\.isSnapshot) private var snapshot
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private func has(_ q: ChatQuestion.Question) -> Bool { !(answers[q.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var complete: Bool { question.questions.allSatisfy(has) }
    private var answered: Int { question.questions.filter(has).count }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "questionmark.bubble").foregroundStyle(JB.accent)
                Text(question.questions.count > 1 ? "\(answered)/\(question.questions.count)" : L("Question")).foregroundStyle(JB.muted).monospacedDigit()
                Spacer()
                Button { model.stop() } label: { Image(systemName: model.stopping ? "ellipsis" : "stop.fill") }.buttonStyle(Tap()).help(L("Stop")).disabled(model.stopping)
            }
            .font(.system(size: 11.5))
            if snapshot { fields }
            else { ViewThatFits(in: .vertical) { fields; ScrollView { fields }.scrollIndicators(.never) }.frame(maxHeight: 320) } // as tall as its questions, scrolling only past the cap
            HStack {
                Spacer()
                Button { Task { await model.changeWorkflow(["action": "answer", "id": question.id, "answers": answers], store: store) } } label: {
                    HStack(spacing: 5) {
                        Text(model.workflowBusy ? L("Sending…") : L("Continue"))
                        Image(systemName: "return").font(.system(size: 10, weight: .semibold))
                    }
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(complete ? JB.accentInk : JB.muted)
                    .padding(.horizontal, 12).frame(height: 26)
                    .background(RoundedRectangle(cornerRadius: 7).fill(complete ? JB.accent : JB.panel2))
                }
                .buttonStyle(Tap(well: false)).disabled(!complete || model.workflowBusy)
                .keyboardShortcut(.defaultAction)
            }
        }
        .font(.system(size: 13)).padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(JB.panel))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(JB.line))
        .padding(.horizontal, 10).padding(.bottom, 10).padding(.top, 4)
        .animation(reduceMotion || snapshot ? nil : .easeOut(duration: 0.15), value: answers)
        .onChange(of: question.id) { answers = [:] }
    }

    private var fields: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(question.questions) { q in
                VStack(alignment: .leading, spacing: 6) {
                    Text(q.title).fontWeight(.medium).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    ForEach(Array(q.options.enumerated()), id: \.offset) { n, option in
                        QuestionOption(number: n + 1, text: option, selected: answers[q.id] == option) { answers[q.id] = option }
                    }
                    other(q)
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    /// an answer of one's own, in the line after the choices
    @ViewBuilder private func other(_ q: ChatQuestion.Question) -> some View {
        let typed = !q.options.contains(answers[q.id] ?? "") && has(q)
        HStack(spacing: 8) {
            Image(systemName: "pencil").font(.system(size: 10)).foregroundStyle(typed ? JB.accentInk : JB.muted)
                .frame(width: 20, height: 20).background(RoundedRectangle(cornerRadius: 5).fill(typed ? JB.accent : JB.panel2))
            if snapshot { Text(L("Your reply")).foregroundStyle(JB.muted2).frame(maxWidth: .infinity, alignment: .leading) }
            else {
                TextField(L("Your reply"), text: Binding(get: { typed || !has(q) ? answers[q.id] ?? "" : "" }, set: { answers[q.id] = $0 }), axis: .vertical)
                    .textFieldStyle(.plain).lineLimit(1...4)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 8).fill(typed ? JB.accent.opacity(0.14) : JB.bg.opacity(0.6)))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(typed ? JB.accent.opacity(0.7) : JB.line.opacity(0.7)))
    }
}

/// one choice: its number (the key that picks it), the words, the ring that says it is the answer
private struct QuestionOption: View {
    let number: Int
    let text: String
    let selected: Bool
    let pick: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: pick) {
            HStack(alignment: .top, spacing: 8) {
                Text("\(number)").font(.system(size: 11, weight: .semibold, design: .rounded)).monospacedDigit()
                    .foregroundStyle(selected ? JB.accentInk : JB.muted)
                    .frame(width: 20, height: 20).background(RoundedRectangle(cornerRadius: 5).fill(selected ? JB.accent : JB.panel2))
                Text(text).multilineTextAlignment(.leading).foregroundStyle(JB.ink).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8).padding(.vertical, 6).contentShape(Rectangle())
            .background(RoundedRectangle(cornerRadius: 8).fill(selected ? JB.accent.opacity(0.14) : hover ? JB.panel2 : JB.bg.opacity(0.6)))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(selected ? JB.accent.opacity(0.7) : JB.line.opacity(0.7)))
        }
        .buttonStyle(Tap(well: false, dim: false))
        .onHover { hover = $0 }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
