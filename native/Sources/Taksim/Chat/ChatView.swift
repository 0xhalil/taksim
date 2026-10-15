import AppKit
import SwiftUI
import TaksimKit

// The chat inside a node: messages as they happen, each answer's changed files with the way back, and the
// composer. Calm JetBrains surfaces; the user's messages sit in a wash, the agent's answers are plain text.

struct ChatView: View {
    let model: ChatModel
    let store: CanvasStore
    @Environment(\.isSnapshot) private var isSnapshot
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var searching = false
    @State private var query = ""
    @State private var match = 0
    @State private var following = true
    @State private var nearBottom = true
    @State private var userScrolling = false
    @State private var listHeight: CGFloat = 400
    @FocusState private var searchFocused: Bool

    private var matches: [Int] { model.matches(query) }
    private var destination: Int? { matches.indices.contains(match) ? matches[match] : nil }

    private var agent: Agent? { store.agents[model.agent] }
    private var running: Bool { ["running", "waiting"].contains(agent?.status ?? "") }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            messages
            if !model.tasks.isEmpty { ChatTaskList(tasks: model.tasks, live: true, paused: agent?.status == "waiting").padding(.horizontal, 10).padding(.vertical, 6) }
            if let error = model.error {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle").foregroundStyle(JB.err)
                    Text(error).lineLimit(2).textSelection(.enabled)
                    Spacer(minLength: 0)
                    Button { model.error = nil } label: { Image(systemName: "xmark") }.buttonStyle(Tap()).help(L("Close"))
                }
                .font(.system(size: 11)).foregroundStyle(JB.muted).padding(8).background(JB.panel)
            }
            if let job = model.job, shows(job) { ChatJobCard(job: job, model: model).padding(.horizontal, 10).padding(.vertical, 6) }
            if !model.queue.isEmpty { ChatQueue(model: model).transition(.opacity.combined(with: .move(edge: .bottom))) }
            if let question = model.question {
                // the question is what the turn waits on: it takes the room its options need, the messages give way
                ChatQuestionCard(question: question, model: model, store: store)
                    .layoutPriority(1)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            if model.question == nil { ChatComposer(model: model, store: store, running: running, queued: agent?.queued ?? 0) }
        }
        .background(JB.bg)
        .onKeyPress("f", phases: .down) { press in
            guard press.modifiers.contains(.command) else { return .ignored }
            searching = true; following = false; searchFocused = true; return .handled
        }
        .animation(reduceMotion || isSnapshot ? nil : .spring(response: 0.35, dampingFraction: 0.88), value: model.queue.map(\.id))
        .animation(reduceMotion || isSnapshot ? nil : .easeOut(duration: 0.2), value: model.error != nil)
        .animation(reduceMotion || isSnapshot ? nil : .easeOut(duration: 0.2), value: model.entries.count)
        .animation(reduceMotion || isSnapshot ? nil : .spring(response: 0.35, dampingFraction: 0.88), value: model.question?.id)
        .task { if !model.loaded { await model.load() } }
    }

    /// the orchestrated work stays in view while it is under way, and after it until the next request
    private func shows(_ job: ChatJob) -> Bool {
        if ["proposed", "running"].contains(job.status) { return true }
        let asked = model.entries.last { $0.from == "user" && $0.kind == "user" }?.ts ?? 0
        return (job.updatedAt ?? 0) >= asked && job.status != "declined"
    }

    private var toolbar: some View {
        HStack(spacing: 8) {
            if searching {
                TextField(L("Search"), text: $query).textFieldStyle(.plain).focused($searchFocused)
                    .onSubmit { step(1) }
                    .onKeyPress(.escape) { closeSearch(); return .handled }
                Text(matches.isEmpty ? "0" : "\(match + 1)/\(matches.count)").monospacedDigit().foregroundStyle(JB.muted)
                tool("chevron.up", L("Previous")) { step(-1) }.disabled(matches.isEmpty)
                tool("chevron.down", L("Next")) { step(1) }.disabled(matches.isEmpty)
                tool("xmark", L("Close")) { closeSearch()}
            } else {
                Text(L("Chat")).fontWeight(.medium).foregroundStyle(JB.ink)
                if agent?.status == "waiting" { Image(systemName: "pause.circle").foregroundStyle(JB.wait).help(L("Waiting for a reply")) }
                else if let n = agent?.workingWith?.count, n > 0 { Image(systemName: "pause.circle").foregroundStyle(JB.wait).help(L("%d agents are working for it", n)) }
                if let origin = agent?.chatOrigin {
                    Button { NotificationCenter.default.post(name: ChatDrafts.wantsChat, object: origin.id, userInfo: ["reveal": true]) } label: {
                        Label(origin.name, systemImage: "arrow.triangle.branch").lineLimit(1)
                    }.buttonStyle(Tap()).help(L("Go to main chat"))
                }
                Spacer(minLength: 4)
                tool("plus", L("New chat")) { Task { _ = await model.branch(store: store, fresh: true) } }.disabled(model.branching)
                tool("magnifyingglass", L("Search in chat (⌘F)")) { searching = true; following = false; searchFocused = true }
                if !isSnapshot {
                    Menu {
                        Button(L("Side chat"), systemImage: "arrow.triangle.branch") { Task { _ = await model.branch(store: store) } }
                            .disabled(model.branching)
                        Divider()
                        Button(L("Export Markdown…"), systemImage: "square.and.arrow.up") { model.export(title: agent?.name ?? L("Chat")) }
                    } label: { Image(systemName: "ellipsis").frame(width: 20, height: 20) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().help(L("Chat"))
                } else { Image(systemName: "ellipsis").frame(width: 20, height: 20) }
            }
        }
        .font(.system(size: 11)).foregroundStyle(JB.muted)
        .padding(.horizontal, 12).frame(height: 34).background(JB.bg)
        .onChange(of: query) { match = 0 }
        .onChange(of: matches.count) { if match >= matches.count { match = 0 } }
    }

    private func emptyAction(_ key: String, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Text(key).font(.system(size: 11, design: .monospaced)).frame(width: 19, height: 19)
                    .background(RoundedRectangle(cornerRadius: 4).fill(JB.panel2))
                Text(label).font(.system(size: 11))
            }.foregroundStyle(JB.muted)
        }.buttonStyle(Tap())
    }

    private func tool(_ symbol: String, _ help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol).frame(width: 20, height: 20) }
            .buttonStyle(Tap()).help(help).accessibilityLabel(help)
    }

    private func step(_ direction: Int) {
        guard !matches.isEmpty else { return }
        match = (match + direction + matches.count) % matches.count
    }

    private func closeSearch() { searching = false; query = ""; searchFocused = false; following = nearBottom }

    /// a finished plan stays where it ended: what was said after it comes after it
    private var planIndex: Int? {
        guard let plan = model.plan, plan.status == "done" || plan.status == "failed" else { return nil }
        return model.entries.firstIndex { ($0.ts ?? 0) > plan.updatedAt }
    }

    @ViewBuilder private var messages: some View {
        let list = VStack(alignment: .leading, spacing: 20) {
            ForEach(Array(model.entries.enumerated()), id: \.offset) { i, e in
                if i == planIndex, let plan = model.plan { ChatPlanCard(plan: plan, model: model, store: store, running: running) }
                row(i, e).id(i)
                    .padding(3)
                    .transition(.opacity.combined(with: .offset(y: 6)))
                    .background(RoundedRectangle(cornerRadius: 8).fill(destination == i ? JB.sel : .clear))
            }
            if planIndex == nil, let plan = model.plan { ChatPlanCard(plan: plan, model: model, store: store, running: running) }
            if !model.activities.isEmpty { ChatActivityView(activities: model.activities) }
            if !model.streaming.isEmpty {
                ChatMarkdown(text: model.streaming).frame(maxWidth: .infinity, alignment: .leading)
            } else if running && model.question == nil {
                // its turn hasn't started: another agent is writing in its folder. Who, instead of "Working…".
                if let holders = agent?.blockedBy, !holders.isEmpty {
                    ChatBlocked(names: holders.compactMap { store.agents[$0]?.name }) {
                        if let first = holders.first { NotificationCenter.default.post(name: ChatDrafts.wantsChat, object: first, userInfo: ["reveal": true]) }
                    }
                } else { ChatWorking() }
            }
            if model.entries.isEmpty && model.plan == nil && model.question == nil && !running {
                VStack(spacing: 9) {
                    // a short node keeps the two ways in and lets the picture go
                    if listHeight >= 190 {
                        Image(systemName: agent?.chatMode == "plan" ? "list.bullet.clipboard" : agent?.chatMode == "ask" ? "bubble.left" : "bubble.left.and.text.bubble.right").font(.system(size: 26, weight: .light)).foregroundStyle(JB.muted2)
                    }
                    Text(agent?.chatMode == "plan" ? L("New plan") : agent?.chatMode == "ask" ? L("New question") : L("New chat")).font(.system(size: 14, weight: .medium)).foregroundStyle(JB.ink)
                    HStack(spacing: 14) {
                        emptyAction("@", L("Context")) { // a draft kept from before stays
                            let draft = ChatDrafts.shared.text[model.agent] ?? ""
                            ChatDrafts.shared.text[model.agent] = draft.isEmpty || draft.last?.isWhitespace == true ? draft + "@" : draft + " @"
                            ChatDrafts.shared.focus = model.agent
                        }
                        emptyAction("/", L("Command")) {
                            if (ChatDrafts.shared.text[model.agent] ?? "").isEmpty { ChatDrafts.shared.text[model.agent] = "/" }
                            ChatDrafts.shared.focus = model.agent
                        }
                    }
                }
                .frame(maxWidth: .infinity).padding(.vertical, listHeight >= 190 ? 24 : 4)
            }
            Color.clear.frame(height: 1).id("end")
        }
        .padding(.horizontal, 14).padding(.vertical, 16)
        if isSnapshot {
            list.frame(maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading).clipped()
        } else {
            ScrollViewReader { proxy in
                ScrollView { list.frame(maxWidth: 760, alignment: .leading).frame(maxWidth: .infinity) }
                    .scrollIndicators(.never) // .hidden still draws the legacy bar when a mouse is connected
                    // the history arriving after the view, a row settling in, an answer growing: stay on the latest
                    .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { _, _ in
                        // after this layout pass; a scroll asked for inside it is dropped
                        if following && !userScrolling { DispatchQueue.main.async { proxy.scrollTo("end", anchor: .bottom) } }
                    }
                    .defaultScrollAnchor(.bottom)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { listHeight = $0 }
                    .onScrollGeometryChange(for: Bool.self) { g in
                        g.contentOffset.y + g.containerSize.height >= g.contentSize.height - 40
                    } action: { _, bottom in
                        nearBottom = bottom
                        if userScrolling && !searching { following = bottom }
                    }
                    .onScrollPhaseChange { _, phase in
                        userScrolling = phase == .interacting || phase == .tracking || phase == .decelerating
                    }
                    .onChange(of: model.entries.count) { if following { proxy.scrollTo("end", anchor: .bottom) } }
                    .onChange(of: model.plan) { if following { proxy.scrollTo("end", anchor: .bottom) } }
                    .onChange(of: model.streaming) { if following { proxy.scrollTo("end", anchor: .bottom) } }
                    .onChange(of: destination) { if let i = destination { proxy.scrollTo(i, anchor: .center) } }
                    .onAppear { proxy.scrollTo("end", anchor: .bottom) }
                    .overlay(alignment: .bottomTrailing) {
                        if !following && !searching {
                            Button { following = true; withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) { proxy.scrollTo("end", anchor: .bottom) } } label: {
                                Image(systemName: "arrow.down").font(.system(size: 12, weight: .semibold)).frame(width: 28, height: 28)
                                    .background(Circle().fill(JB.panel2)).overlay(Circle().strokeBorder(JB.line))
                            }
                            .buttonStyle(Tap()).foregroundStyle(JB.ink).help(L("Go to latest message")).padding(10)
                        }
                    }
            }
        }
    }

    @ViewBuilder private func row(_ i: Int, _ e: ChatEntry) -> some View {
        if e.kind == "restore" {
            // only the latest restore can still be stepped over
            RestoreDivider(entry: e, model: model, latest: i == model.entries.lastIndex { $0.kind == "restore" }, forward: model.wentForward(i))
        } else if e.kind == "changes" {
            if let ch = e.changes, !ch.isEmpty { ChangesCard(entry: e, model: model, store: store) }
        } else if e.kind == "job" {
            // the engine telling the orchestrator its handed-out work ended: a mark in the conversation, not a message to read
            HStack(spacing: 8) {
                Rectangle().fill(JB.line).frame(height: 1)
                Label(L("Work ended"), systemImage: "point.3.connected.trianglepath.dotted").font(.system(size: 11)).foregroundStyle(JB.muted).fixedSize()
                Rectangle().fill(JB.line).frame(height: 1)
            }
            .contextMenu { Button(L("Copy"), systemImage: "doc.on.doc") { copyChatText(e.text ?? "") } }
        } else if e.to == model.agent {
            UserMessage(entry: e, who: e.from == "user" ? nil : store.agents[e.from]?.name ?? e.from,
                        checkpoint: model.checkpoint(after: i), model: model, store: store, running: running)
        } else if e.from == model.agent {
            HoverRow { hover in
            VStack(alignment: .leading, spacing: 10) {
                // stopping it yourself isn't a failure
                let stopped = e.kind == "error" && e.text == "stopped"
                if e.kind == "error", !stopped {
                    Text(L("Couldn't complete")).font(.system(size: 10.5, weight: .medium)).foregroundStyle(JB.err)
                }
                if let tasks = e.tasks, !tasks.isEmpty { ChatTaskList(tasks: tasks, live: false) }
                if let activities = e.activities, !activities.isEmpty { ChatActivityView(activities: activities) }
                if stopped {
                    Label(L("Stopped"), systemImage: "stop.circle").font(.system(size: 12)).foregroundStyle(JB.muted)
                } else if e.kind == "error" {
                    Label(e.text ?? "", systemImage: "exclamationmark.triangle.fill").font(.system(size: 12.5)).foregroundStyle(JB.err)
                        .textSelection(.enabled)
                } else {
                    ChatMarkdown(text: e.text ?? "")
                }
                HStack(spacing: 8) {
                    if let usage = e.usage, (usage.input ?? 0) + (usage.output ?? 0) > 0 {
                        Text(countText((usage.input ?? 0) + (usage.output ?? 0), one: "1 token", other: "%d tokens")).font(.system(size: 10)).foregroundStyle(JB.muted2)
                            .help(L("Input: %d · Output: %d", usage.input ?? 0, usage.output ?? 0))
                    }
                    Spacer()
                    if agent?.chatMode == "plan", e.kind == "assistant", model.plan == nil, !running, i == model.entries.lastIndex(where: { $0.from == model.agent }) {
                        Button { Task { await model.changeWorkflow(["action": "publish", "title": "Plan", "content": e.text ?? ""], store: store) } } label: { Image(systemName: "list.bullet.clipboard").font(.system(size: 10.5)) }
                            .buttonStyle(Tap()).foregroundStyle(JB.muted).help(L("Open as plan")).disabled(model.workflowBusy)
                    }
                    if e.kind == "error", let request = model.entries.prefix(i).last(where: { $0.from == "user" && $0.kind != "restore" }) {
                        Button { model.send(request.text ?? "", attachments: request.attachments ?? []) } label: { Image(systemName: "arrow.clockwise") }
                            .buttonStyle(Tap()).help(L("Retry")).disabled(running || model.sending > 0)
                    }
                    MessageCopy(text: e.text ?? "")
                }
                // as in Cursor: what can be done with an answer shows while the pointer is on it (a failed one keeps its retry)
                .opacity(hover || e.kind == "error" ? 1 : 0)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: hover)
                if let ch = e.changes, !ch.isEmpty { ChangesCard(entry: e, model: model, store: store) }
            }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contextMenu {
                Button(L("Copy"), systemImage: "doc.on.doc") { copyChatText(e.text ?? "") }
                Button(L("Branch from here"), systemImage: "arrow.triangle.branch") { Task { _ = await model.branch(store: store, at: e) } }.disabled(model.branching)
            }
        }
    }
}

/// a row that knows whether the pointer is on it
private struct HoverRow<Content: View>: View {
    @State private var hover = false
    let content: (Bool) -> Content
    var body: some View { content(hover).contentShape(Rectangle()).onHover { hover = $0 } }
}

private func copyChatText(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}

private struct MessageCopy: View {
    let text: String
    @State private var copied = false
    var body: some View {
        Button {
            copyChatText(text); copied = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { copied = false }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc").contentTransition(.symbolEffect(.replace)).font(.system(size: 10.5))
                .foregroundStyle(copied ? JB.ok : JB.muted).frame(width: 20, height: 18)
        }
        .buttonStyle(Tap()).help(L("Copy response"))
    }
}

/// what was asked: in a wash, its attachments as chips; hovering offers going back to before it
private struct UserMessage: View {
    let entry: ChatEntry
    let who: String?
    let checkpoint: String?
    let model: ChatModel
    let store: CanvasStore
    let running: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hover = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let who { Text(who).font(.system(size: 11, weight: .semibold)).foregroundStyle(JB.muted) }
            if let a = entry.attachments, !a.isEmpty { ChipRow(items: a, open: { a in if let path = a.path { store.openIDE(model.agent, path: path) } }) }
            if let version = entry.appliedPlan {
                Label("\(L("Apply plan")) · v\(version)", systemImage: "list.bullet.clipboard").font(.system(size: 12.5)).foregroundStyle(JB.ink)
            } else if let t = entry.shownText, !t.isEmpty {
                ChatText(t)
            }
        }
        .padding(.horizontal, 13).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(JB.panel.opacity(0.55)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(JB.line.opacity(0.7)))
        .overlay(alignment: .topTrailing) {
            // Cursor's checkpoint: the folder as it was before this message
            if hover, let checkpoint, !running {
                Button { model.restore(checkpoint) } label: {
                    Label(L("Go back"), systemImage: "arrow.uturn.backward").font(.system(size: 11, weight: .medium))
                        .padding(.horizontal, 7).frame(height: 22)
                        .background(Capsule().fill(JB.panel))
                        .overlay(Capsule().strokeBorder(JB.line))
                }
                .buttonStyle(Tap()).foregroundStyle(JB.ink)
                .help(L("Restore the folder to before this message"))
                .padding(6).transition(.opacity)
            }
        }
        .contextMenu {
            Button(L("Copy"), systemImage: "doc.on.doc") { copyChatText(entry.shownText ?? "") }
            if entry.from == "user", entry.appliedPlan == nil {
                Button(L("Edit and reuse"), systemImage: "pencil") { ChatDrafts.shared.reuse(entry, for: model.agent) }
                Button(L("Branch from here"), systemImage: "arrow.triangle.branch") { Task { _ = await model.branch(store: store, at: entry) } }.disabled(model.branching)
            }
        }
        .onHover { hover = $0 }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: hover)
    }
}

/// the files a turn changed: +/− per file, a click opens it in the IDE; "Geri al" restores the folder
private struct ChangesCard: View {
    @State private var reviewing = false
    @State private var reviewPath: String?
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isSnapshot) private var isSnapshot
    let entry: ChatEntry
    let model: ChatModel
    let store: CanvasStore

    var body: some View {
        let ch = entry.changes ?? []
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "doc.on.doc").font(.system(size: 11)).foregroundStyle(JB.muted)
Text(countText(ch.count, one: "1 file", other: "%d files")).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(JB.ink).lineLimit(1).fixedSize()
                let add = ch.compactMap(\.added).reduce(0, +), rem = ch.compactMap(\.removed).reduce(0, +)
                Text("+\(add)").foregroundStyle(JB.ok).font(.system(size: 11.5, design: .monospaced))
                Text("−\(rem)").foregroundStyle(JB.err).font(.system(size: 11.5, design: .monospaced))
                Spacer()
                // in a narrow node the two actions stay, as their symbols
                ViewThatFits(in: .horizontal) { actions(words: true); actions(words: false) }

            }
            .padding(.horizontal, 10).frame(height: 30)
            Rectangle().fill(JB.line).frame(height: 1)
            ForEach(ch.prefix(expanded ? ch.count : 12)) { c in
                // the turn's own change, frozen: before ↔ after. A binary file has no diff to show, so it
                // opens in the editor instead; a turn from before trees were kept falls back to the editor too.
                Button {
                    if entry.checkpoint != nil && entry.after != nil { reviewPath = c.path; reviewing = true }
                    else { openTurnDiff(c) }
                } label: {
                    HStack(spacing: 8) {
                        Text((c.path as NSString).lastPathComponent).font(.system(size: 12)).foregroundStyle(JB.ink).lineLimit(1)
                        Text((c.path as NSString).deletingLastPathComponent).font(.system(size: 11)).foregroundStyle(JB.muted2)
                            .lineLimit(1).truncationMode(.head)
                        Spacer(minLength: 6)
                        if let a = c.added { Text("+\(a)").foregroundStyle(JB.ok) }
                        if let r = c.removed { Text("−\(r)").foregroundStyle(JB.err) }
                        if c.added == nil { Text(L("binary")).foregroundStyle(JB.muted) }
                    }
                    .font(.system(size: 11, design: .monospaced))
                    .padding(.horizontal, 10).frame(height: 24).contentShape(Rectangle())
                }
                .buttonStyle(Tap())
            }
            if ch.count > 12 {
                Button { expanded.toggle() } label: {
                    Label(expanded ? L("Collapse") : L("%d more files", ch.count - 12), systemImage: expanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 11)).foregroundStyle(JB.muted).padding(.horizontal, 10).frame(height: 24)
                }.buttonStyle(Tap())
            }
        }
        .background(RoundedRectangle(cornerRadius: 8).fill(JB.panel))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(JB.line))
        .sheet(isPresented: $reviewing) { ChatReviewView(entry: entry, model: model, store: store, initialPath: reviewPath) }
        .contextMenu {
            if let checkpoint = entry.checkpoint { Button(L("Revert entire turn")) { model.restore(checkpoint) }.disabled(model.busyRestore != nil || store.agents[model.agent]?.status == "running") }
        }
        .animation(reduceMotion || isSnapshot ? nil : .spring(response: 0.35, dampingFraction: 0.9), value: expanded)
    }

    private func actions(words: Bool) -> some View {
        HStack(spacing: words ? 6 : 10) {
            if entry.checkpoint != nil && entry.after != nil {
                Button { reviewPath = nil; reviewing = true } label: {
                    if words { Label(L("Review"), systemImage: "doc.text.magnifyingglass") } else { Image(systemName: "doc.text.magnifyingglass") }
                }
                .buttonStyle(Tap()).foregroundStyle(JB.accent).help(L("Review"))
            }
            if let checkpoint = entry.checkpoint {
                Button { model.restore(checkpoint) } label: {
                    if words { Label(L("Undo"), systemImage: "arrow.uturn.backward") } else { Image(systemName: "arrow.uturn.backward") }
                }
                .buttonStyle(Tap()).foregroundStyle(JB.muted)
                .disabled(model.busyRestore != nil || store.agents[model.agent]?.status == "running")
                .help(L("Revert entire turn"))
            }
        }.fixedSize()
    }

    /// the file's change as this turn made it: both sides read from the turn's trees, so later edits and
    /// other turns don't creep in
    private func openTurnDiff(_ c: ChatChange) {
        guard c.added != nil || c.removed != nil, entry.checkpoint != nil || entry.after != nil else {
            store.openIDE(model.agent, path: c.path) // binary, or a turn recorded before its trees were kept
            return
        }
        store.showDiff(model.agent, path: c.path, old: entry.checkpoint, new: entry.after)
    }
}

/// a restore in the conversation: where the folder went back to, and the way forward again
private struct RestoreDivider: View {
    let entry: ChatEntry
    let model: ChatModel
    var latest = true
    var forward = false
    var body: some View {
        HStack(spacing: 8) {
            Rectangle().fill(JB.line).frame(height: 1)
            Label(forward ? L("Redone") : L("Restored"), systemImage: forward ? "arrow.uturn.forward" : "arrow.uturn.backward").font(.system(size: 11)).foregroundStyle(JB.muted).fixedSize()
            if latest, let r = entry.redo {
                Button(forward ? L("Undo") : L("Redo")) { model.restore(r) }.buttonStyle(Tap()).font(.system(size: 11, weight: .semibold)).foregroundStyle(JB.accent)
                    .disabled(model.busyRestore != nil)
            }
            Rectangle().fill(JB.line).frame(height: 1)
        }
    }
}

/// Context is inspectable before sending, including selected source and image previews.
struct ChipRow: View {
    let items: [ChatAttachment]
    var remove: ((ChatAttachment) -> Void)?
    var open: ((ChatAttachment) -> Void)?
    var body: some View {
        FlowRow(spacing: 5) {
            ForEach(items) { attachment in
                AttachmentChip(attachment: attachment, remove: remove, open: open)
            }
        }
    }
}

private struct AttachmentChip: View {
    let attachment: ChatAttachment
    var remove: ((ChatAttachment) -> Void)?
    var open: ((ChatAttachment) -> Void)?
    @State private var preview = false
    @State private var image: NSImage?
    @Environment(\.isSnapshot) private var isSnapshot

    var body: some View {
        HStack(spacing: 4) {
            Button { preview.toggle() } label: {
                HStack(spacing: 4) {
                    if let image { Image(nsImage: image).resizable().scaledToFill().frame(width: 16, height: 16).clipShape(RoundedRectangle(cornerRadius: 3)) }
                    else { Image(systemName: attachment.symbol).font(.system(size: 10)).foregroundStyle(JB.accent) }
                    Text(attachment.label).font(.system(size: 11.5)).foregroundStyle(JB.ink).lineLimit(1)
                }.contentShape(Rectangle())
            }.buttonStyle(Tap()).help(attachment.path ?? attachment.name ?? "")
            if let remove {
                Button { remove(attachment) } label: { Image(systemName: "xmark").font(.system(size: 8, weight: .bold)).foregroundStyle(JB.muted).frame(width: 14, height: 18) }
                    .buttonStyle(Tap()).help(L("Remove from context")).accessibilityLabel(L("Remove %@ attachment", attachment.label))
            }
        }
        .padding(.horizontal, 7).frame(height: 24).background(Capsule().fill(JB.sel))
        .popover(isPresented: $preview) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Label(attachment.label, systemImage: attachment.symbol).font(.system(size: 12, weight: .medium))
                    Spacer()
                    if let open, ["file", "selection"].contains(attachment.kind) {
                        Button { preview = false; open(attachment) } label: { Image(systemName: "arrow.up.right.square") }.buttonStyle(Tap()).help(L("Open in editor"))
                    }
                }
                if let path = attachment.path, attachment.kind != "conversation" { Text(path).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(JB.muted).textSelection(.enabled) }
                if let image { Image(nsImage: image).resizable().scaledToFit().frame(maxHeight: 220) }
                if let text = attachment.text, !text.isEmpty {
                    ScrollView { Text(text).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 220)
                }
            }.foregroundStyle(JB.ink).padding(12).frame(width: 340).background(JB.panel)
        }
        .task(id: attachment.path) {
            guard !isSnapshot, attachment.kind == "image", let path = attachment.path else { return }
            image = NSImage(contentsOfFile: path)
        }
    }
}

/// chips that wrap to the next line
struct FlowRow: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let w = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for s in subviews {
            let z = s.sizeThatFits(.unspecified)
            if x > 0, x + z.width > w { x = 0; y += line + spacing; line = 0 }
            x += z.width + spacing; line = max(line, z.height); widest = max(widest, x - spacing)
        }
        return CGSize(width: min(w, widest), height: y + line)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for s in subviews {
            let z = s.sizeThatFits(.unspecified)
            if x > bounds.minX, x + z.width > bounds.maxX { x = bounds.minX; y += line + spacing; line = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(z))
            x += z.width + spacing; line = max(line, z.height)
        }
    }
}
