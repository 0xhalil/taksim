import AppKit
import SwiftUI
import TaksimKit

// The Commit tool window: the branch, the changed files with their state's own color, a checkbox per file
// for what goes in, a click for the Fark (side by side against HEAD), and — under one accent action, Commit —
// the message with the ✦ (a fast model writes it from the diff). Rollback sits on the row's right click,
// push, amend and select-all under ⋯: the front holds only the every-day things.

/// a file's git state, as IntelliJ colors it: modified blue, added green, new (untracked) red, deleted gray
enum GitTone {
    static func color(_ status: String?) -> Color {
        switch status {
        case "added": Color(hex: 0x629755)
        case "untracked": JB.err
        case "deleted": Color(hex: 0x6C6C6C)
        default: Color(hex: 0x6897BB) // modified and renamed
        }
    }

    static func letter(_ status: String?) -> String {
        switch status {
        case "added": "A"
        case "untracked": "U"
        case "deleted": "D"
        case "renamed": "R"
        default: "M"
        }
    }
}

struct IDECommit: View {
    @Bindable var model: IDEModel
    @Environment(\.isSnapshot) private var isSnapshot

    private var files: [IDEGitFile] { model.git?.files ?? [] }
    private var tracked: [IDEGitFile] { files.filter { $0.status != "untracked" } }
    private var fresh: [IDEGitFile] { files.filter { $0.status == "untracked" } }
    private var canCommit: Bool {
        (!model.commitSel.isEmpty || model.amend) && !model.commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            head
            Rectangle().fill(JB.line).frame(height: 1)
            list
            Rectangle().fill(JB.line).frame(height: 1)
            form
        }
    }

    // ---------- the branch and the quiet tools ----------

    private var head: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.triangle.branch").font(.system(size: 11)).foregroundStyle(JB.muted)
            Text(model.git?.branch ?? "").font(.system(size: 11.5, weight: .medium)).foregroundStyle(JB.text).lineLimit(1).truncationMode(.head)
            Spacer(minLength: 4)
            Button { Task { await model.review() } } label: {
                if model.reviewing { ProgressView().controlSize(.mini).frame(width: 20, height: 20) }
                else { Image(systemName: "ladybug").font(.system(size: 10.5)).foregroundStyle(files.isEmpty ? JB.muted2 : JB.accent) }
            }
            .buttonStyle(CloseButtonStyle(size: 20)).disabled(model.reviewing || files.isEmpty).help(L("Have the model review the changes"))
            Button { Task { await model.refreshGit() } } label: { Image(systemName: "arrow.clockwise").font(.system(size: 10.5)) }
                .buttonStyle(CloseButtonStyle(size: 20)).help(L("Refresh"))
            if !isSnapshot {
                Menu { menu } label: { Image(systemName: "ellipsis").font(.system(size: 11)) }
                    .menuStyle(.button).buttonStyle(Press()).menuIndicator(.hidden).fixedSize()
                    .help(L("Amend, push, select all"))
            }
        }
        .padding(.leading, 10).padding(.trailing, 6).frame(height: 32)
    }

    @ViewBuilder private var menu: some View {
        let all = !files.isEmpty && files.allSatisfy { model.commitSel.contains($0.path) }
        Button(all ? L("Deselect all") : L("Select all")) { model.selectAll(!all) }
        Toggle("Amend", isOn: Binding(get: { model.amend }, set: { model.amend = $0 }))
        Divider()
        Button(L("Push")) { Task { await model.push() } }
        Button(L("Commit and push")) { Task { await model.commit(andPush: true) } }.disabled(!canCommit)
    }

    // ---------- the changed files ----------

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                group(L("Changes"), tracked)
                group(L("New files"), fresh)
                if files.isEmpty {
                    Text(L("No changes")).font(.system(size: 12)).foregroundStyle(JB.muted2)
                        .padding(.horizontal, 12).padding(.vertical, 10)
                }
            }
            .padding(.vertical, 4)
        }
    }

    @ViewBuilder private func group(_ title: String, _ items: [IDEGitFile]) -> some View {
        if !items.isEmpty {
            let all = items.allSatisfy { model.commitSel.contains($0.path) }
            HStack(spacing: 6) {
                Toggle("", isOn: Binding(get: { all }, set: { model.setGroup(items.map(\.path), $0) }))
                    .toggleStyle(.checkbox).controlSize(.small).labelsHidden()
                Text(title).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(JB.text)
                Spacer(minLength: 4)
                Text("\(items.count)").font(.system(size: 10.5)).foregroundStyle(JB.muted2)
            }
            .padding(.leading, 10).padding(.trailing, 8).frame(height: 24)
            ForEach(items, id: \.path) { row($0) }
        }
    }

    private func row(_ f: IDEGitFile) -> some View {
        let selected = model.commitSel.contains(f.path)
        let tone = GitTone.color(f.status)
        return Hovering { hover in
            HStack(spacing: 6) {
                Toggle("", isOn: Binding(get: { selected }, set: { _ in model.toggleCommit(f.path) }))
                    .toggleStyle(.checkbox).controlSize(.small).labelsHidden()
                FileIcon(path: f.path)
                Text((f.path as NSString).lastPathComponent)
                    .font(.system(size: 12)).lineLimit(1).foregroundStyle(tone)
                    .strikethrough(f.status == "deleted", color: tone)
                Text((f.path as NSString).deletingLastPathComponent)
                    .font(.system(size: 10.5)).foregroundStyle(JB.muted2).lineLimit(1).truncationMode(.head)
                Spacer(minLength: 4)
                Text(GitTone.letter(f.status)).font(.system(size: 10, weight: .semibold, design: .monospaced)).foregroundStyle(JB.muted2)
            }
            .padding(.leading, 10).padding(.trailing, 8)
            .frame(height: 22)
            .background(RoundedRectangle(cornerRadius: 4).fill(hover ? JB.tint : .clear).padding(.horizontal, 4))
            .contentShape(Rectangle())
            .onTapGesture(count: 2) { model.closeDiff(); model.open(f.path) }
            .onTapGesture { Task { await model.openDiff(f.path) } }
            .contextMenu {
                Button(L("Show diff")) { Task { await model.openDiff(f.path) } }
                Button(L("Open file")) { model.closeDiff(); model.open(f.path) }
                Divider()
                Button(L("Discard changes")) { confirmRollback([f.path]) }
            }
            .help(f.path)
        }
    }

    /// throwing a file's changes away can't be taken back (new files are deleted): it asks once
    private func confirmRollback(_ paths: [String]) {
        let a = NSAlert()
        a.messageText = paths.count == 1 ? L("Discard %@?", paths[0]) : L("Discard %d files?", paths.count)
        a.informativeText = L("Changes will be deleted; new files will be removed. This cannot be undone.")
        a.alertStyle = .warning
        a.addButton(withTitle: L("Discard"))
        a.addButton(withTitle: L("Cancel"))
        if a.runModal() == .alertFirstButtonReturn { Task { await model.rollback(paths) } }
    }

    // ---------- the message and the one action ----------

    private var form: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .bottomTrailing) {
                if model.commitMessage.isEmpty {
                    Text(L("Commit message")).font(.system(size: 12)).foregroundStyle(JB.muted2)
                        .padding(.leading, 5).padding(.top, 3)
                        .frame(maxWidth: .infinity, alignment: .leading).allowsHitTesting(false)
                }
                if isSnapshot {
                    Text(model.commitMessage).font(.system(size: 12)).foregroundStyle(JB.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    TextEditor(text: $model.commitMessage)
                        .font(.system(size: 12)).foregroundStyle(JB.ink)
                        .scrollContentBackground(.hidden).background(.clear)
                        .frame(height: 46)
                        .onKeyPress(.return, phases: .down) { press in
                            guard press.modifiers.contains(.command) else { return .ignored }
                            Task { await model.commit() }
                            return .handled
                        }
                }
                Button { Task { await model.suggestCommitMessage() } } label: {
                    if model.writingMessage {
                        ProgressView().controlSize(.mini).frame(width: 22, height: 22)
                    } else {
                        Image(systemName: "sparkles").font(.system(size: 11)).foregroundStyle(files.isEmpty ? JB.muted2 : JB.accent)
                            .frame(width: 22, height: 22).contentShape(Circle())
                    }
                }
                .buttonStyle(CloseButtonStyle(size: 22)).disabled(model.writingMessage || files.isEmpty)
                .help(L("Have the model write it"))
                .padding(.trailing, 2).padding(.bottom, 2)
            }
            .padding(4)
            .background(RoundedRectangle(cornerRadius: 6).fill(JB.bg))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(JB.line))

            HStack(spacing: 8) {
                if let n = model.notice {
                    Text(n.text).font(.system(size: 10.5)).foregroundStyle(n.bad ? JB.err : JB.ok)
                        .lineLimit(1).truncationMode(.middle).transition(.opacity)
                    if n.offersPush {
                        Button { Task { await model.push() } } label: { Text(L("Push")).font(.system(size: 11, weight: .semibold)).foregroundStyle(JB.accent) }
                            .buttonStyle(Press())
                    }
                } else if !model.commitSel.isEmpty {
                    Text(L("%d files", model.commitSel.count)).font(.system(size: 10.5)).foregroundStyle(JB.muted)
                }
                Spacer(minLength: 4)
                commitButton
            }
        }
        .padding(10)
        .animation(.easeOut(duration: 0.2), value: model.notice)
    }

    private var commitButton: some View {
        Button { Task { await model.commit() } } label: {
            Group {
                if model.committing { ProgressView().controlSize(.mini) } else { Text("Commit").font(.system(size: 12, weight: .semibold)) }
            }
            .foregroundStyle(JB.accentInk)
            .frame(minWidth: 68, minHeight: 26)
            .background(RoundedRectangle(cornerRadius: 6).fill(JB.accent))
            .opacity(canCommit || model.committing ? 1 : 0.4)
        }
        .buttonStyle(Press())
        .disabled(!canCommit || model.committing)
        .keyboardShortcut(.return, modifiers: .command)
        .help("Commit  ⌘⏎")
    }
}
