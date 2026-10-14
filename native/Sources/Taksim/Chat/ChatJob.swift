import SwiftUI
import TaksimKit

/// The work an orchestrator handed out, as the engine keeps it: each part, who has it, on which model, and how far
/// it is. A row leads to that part's agent on the canvas.
struct ChatJobCard: View {
    let job: ChatJob
    var model: ChatModel?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isSnapshot) private var snapshot
    private var done: Int { job.parts.filter { $0.status == "done" }.count }
    private var state: String {
        switch job.status {
        case "proposed": L("Waiting for you"); case "running": L("Working"); case "done": L("Done")
        case "stopped": L("Stopped"); case "timed out": L("Timed out"); default: L("Incomplete")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 7) {
                Image(systemName: "point.3.connected.trianglepath.dotted").foregroundStyle(JB.accent)
                Text(job.title).fontWeight(.medium).lineLimit(1)
                Text("\(done)/\(job.parts.count)").monospacedDigit().contentTransition(.numericText()).foregroundStyle(JB.muted).fixedSize()
                Spacer(minLength: 4)
                Text(state).foregroundStyle(job.status == "done" ? JB.ok : job.status == "running" || job.status == "proposed" ? JB.muted : JB.warn).lineLimit(1).fixedSize()
                // the job's one action: stop it while it runs, go on where it left off when it didn't finish
                if let model {
                    if job.status == "running" {
                        Button { model.stop() } label: { Image(systemName: model.stopping ? "ellipsis" : "stop.fill").frame(width: 18, height: 18) }
                            .buttonStyle(Tap()).disabled(model.stopping).help(L("Stop"))
                    } else if ["stopped", "partial", "timed out"].contains(job.status) {
                        Button { model.resumeJob() } label: { Image(systemName: "play.fill").foregroundStyle(JB.accent).frame(width: 18, height: 18) }
                            .buttonStyle(Tap()).help(L("Resume where it left off"))
                    }
                }
            }
            HStack(spacing: 3) {
                ForEach(job.parts) { part in Capsule().fill(color(part.status, bar: true)).frame(height: 3) }
            }.accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                ForEach(job.parts) { part in
                    row(symbol(part.status), color(part.status, bar: false), part.title, part.model ?? "", struck: part.status == "skipped" || part.status == "cancelled",
                        writes: part.writes == true, help: part.error ?? part.agentName ?? part.title, agent: part.agentId)
                }
                // what proves it: the commands the engine ran, and the review of the diff
                ForEach(job.checks ?? []) { check in
                    row(check.status == "passed" ? "checkmark.circle.fill" : check.status == "running" ? "arrow.trianglehead.2.clockwise.rotate.90" : check.status == "pending" ? "circle" : "xmark.circle.fill",
                        check.status == "passed" ? JB.ok : check.status == "running" ? JB.accent : check.status == "pending" ? JB.muted2 : JB.err,
                        check.command, "", mono: true, help: check.output ?? check.command, agent: nil)
                }
                if let review = job.review {
                    row(review.status == "ok" ? "checkmark.seal.fill" : review.status == "running" ? "arrow.trianglehead.2.clockwise.rotate.90" : review.status == "problems" ? "exclamationmark.triangle.fill" : "minus.circle",
                        review.status == "ok" ? JB.ok : review.status == "running" ? JB.accent : review.status == "problems" ? JB.warn : JB.muted2,
                        L("Review"), review.model ?? "", help: review.findings ?? L("Review"), agent: review.agentId)
                }
            }
            if job.warning == "light-lead", job.status == "proposed" || job.status == "running" {
                Label(L("Light model leading"), systemImage: "exclamationmark.triangle").font(.system(size: 10.5)).foregroundStyle(JB.warn)
                    .help(L("This agent runs on a light model; a stronger one plans and checks better."))
            }
        }
        .font(.system(size: 11.5)).foregroundStyle(JB.ink).padding(9)
        .background(RoundedRectangle(cornerRadius: 6).fill(JB.panel))
        .animation(reduceMotion || snapshot ? nil : .easeOut(duration: 0.2), value: job)
        .accessibilityElement(children: .contain)
    }

    /// one line of the job: a part, a check or the review; a line with an agent leads to it on the canvas
    private func row(_ symbol: String, _ tint: Color, _ title: String, _ trailing: String, struck: Bool = false, writes: Bool = false, mono: Bool = false,
                     help: String, agent: String?) -> some View {
        Button { if let agent { NotificationCenter.default.post(name: ChatDrafts.wantsChat, object: agent, userInfo: ["reveal": true]) } } label: {
            HStack(spacing: 7) {
                Image(systemName: symbol).foregroundStyle(tint).frame(width: 14)
                Text(title).font(.system(size: mono ? 10.5 : 11.5, design: mono ? .monospaced : .default)).strikethrough(struck)
                    .foregroundStyle(struck ? JB.muted2 : JB.ink).lineLimit(1).truncationMode(.middle)
                if writes { Image(systemName: "pencil").font(.system(size: 9)).foregroundStyle(JB.muted2).help(L("Changes files")) }
                Spacer(minLength: 6)
                Text(trailing).font(.system(size: 10.5)).foregroundStyle(JB.muted2).lineLimit(1).truncationMode(.middle)
            }
            .frame(height: 22).contentShape(Rectangle())
        }
        .buttonStyle(Tap(dim: false)).disabled(agent == nil).help(help)
    }

    private func symbol(_ status: String) -> String {
        switch status {
        case "done": "checkmark.circle.fill"; case "running": "arrow.trianglehead.2.clockwise.rotate.90"
        case "failed": "exclamationmark.circle"; case "skipped", "cancelled": "minus.circle"; case "stopped": "stop.circle"
        default: "circle"
        }
    }
    private func color(_ status: String, bar: Bool) -> Color {
        switch status {
        case "done": JB.ok; case "running": JB.accent; case "failed": JB.err
        default: bar ? JB.line : JB.muted2
        }
    }
}
