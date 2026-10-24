import AppKit
import SwiftUI
import TaksimKit

// The Git tab, as VS Code's Source Control works: the branch (a picker) and sync on top, the message with the ✦
// (a fast model writes it from the diff) over one accent action, Commit — its ▾ holds Commit & Push, Amend and
// Undo Last Commit — then "Staged Changes" and "Changes". A row shows its icons on hover (open, discard,
// stage/unstage), a click opens the diff (index against HEAD, or disk against index). Pull, fetch, stash and
// the rest sit under ⋯.

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
    @State private var stagedOpen = true
    @State private var changesOpen = true

    private var files: [IDEGitFile] { model.git?.files ?? [] }
    private var staged: [IDEGitFile] { model.stagedFiles }
    private var changes: [IDEGitFile] { model.changedFiles }
    private var hasMessage: Bool { !model.commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var canCommit: Bool { hasMessage && (!files.isEmpty || model.amend) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            head
            Rectangle().fill(JB.line).frame(height: 1)
            form
            list
        }
    }

    // ---------- the branch, sync and the quiet tools ----------

    private var head: some View {
        HStack(spacing: 4) {
            if isSnapshot { branchLabel } else {
                Menu {
                    ForEach(model.branchList, id: \.self) { b in
                        Button { Task { await model.checkout(b) } } label: {
                            if b == model.git?.branch { Label(b, systemImage: "checkmark") } else { Text(b) }
                        }
                    }
                    Divider()
                    Button(L("Create branch…"), systemImage: "plus") { createBranch() }
                } label: { branchLabel }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().pointerStyle(.link)
                .onAppear { Task { await model.loadBranches() } }
                .help(L("Switch branch"))
            }
            Spacer(minLength: 4)
            syncButton
            Button { Task { await model.review() } } label: {
                if model.reviewing { ProgressView().controlSize(.mini) }
                else { Image(systemName: "ladybug").font(.system(size: 10.5)).foregroundStyle(files.isEmpty ? JB.muted2 : JB.accent) }
            }
            .buttonStyle(CloseButtonStyle(size: 22)).disabled(model.reviewing || files.isEmpty).help(L("Have the model review the changes"))
            Button { Task { await model.refreshGit() } } label: { Image(systemName: "arrow.clockwise").font(.system(size: 10.5)) }
                .buttonStyle(CloseButtonStyle(size: 22)).help(L("Refresh"))
            if !isSnapshot {
                Menu { menu } label: { Image(systemName: "ellipsis").font(.system(size: 11)).frame(width: 22, height: 22).contentShape(Rectangle()) }
                    .menuStyle(.button).buttonStyle(Press()).menuIndicator(.hidden).fixedSize()
                    .help(L("More actions"))
            }
        }
        .padding(.leading, 10).padding(.trailing, 6).frame(height: 34)
    }

    private var branchLabel: some View {
        HStack(spacing: 5) {
            Image(systemName: "arrow.triangle.branch").font(.system(size: 11))
            Text(model.git?.branch ?? "").font(.system(size: 11.5, weight: .medium)).lineLimit(1).truncationMode(.head)
            Image(systemName: "chevron.down").font(.system(size: 7.5, weight: .semibold))
        }
        .foregroundStyle(JB.text).padding(.horizontal, 6).frame(height: 24).contentShape(Rectangle())
    }

    /// ↻ with what is behind and ahead; one click pulls then pushes
    private var syncButton: some View {
        let g = model.git
        return Button { Task { await model.sync() } } label: {
            HStack(spacing: 3) {
                Image(systemName: "arrow.triangle.2.circlepath").font(.system(size: 10.5))
                    .rotationEffect(.degrees(model.syncing ? 360 : 0))
                    .animation(model.syncing ? .linear(duration: 1).repeatForever(autoreverses: false) : .default, value: model.syncing)
                if let g, g.behind > 0 { Text("\(g.behind)↓").font(.system(size: 10.5)) }
                if let g, g.ahead > 0 { Text("\(g.ahead)↑").font(.system(size: 10.5)) }
            }
            .foregroundStyle((g?.ahead ?? 0) + (g?.behind ?? 0) > 0 ? JB.accent : JB.muted)
            .padding(.horizontal, 5).frame(minWidth: 22, minHeight: 22).contentShape(Rectangle())
        }
        .buttonStyle(Press()).disabled(model.syncing)
        .help(g?.upstream == nil ? L("Publish branch") : L("Sync changes"))
    }

    @ViewBuilder private var menu: some View {
        Button(L("Pull")) { Task { await model.pull() } }
        Button(L("Push")) { Task { await model.push() } }
        Button(L("Fetch")) { Task { await model.fetchRemote() } }
        Divider()
        Button(L("Stage all")) { Task { await model.setStaged(changes.map(\.path), true) } }.disabled(changes.isEmpty)
        Button(L("Unstage all")) { Task { await model.setStaged(staged.map(\.path), false) } }.disabled(staged.isEmpty)
        Button(L("Discard all changes")) { confirmRollback(changes.map(\.path)) }.disabled(changes.isEmpty)
        Divider()
        Button(L("Stash")) { Task { await model.stash() } }.disabled(files.isEmpty)
        Button(L("Pop stash")) { Task { await model.stash(pop: true) } }
        Divider()
        Button(L("Create branch…")) { createBranch() }
        Button(L("Undo last commit")) { Task { await model.undoLastCommit() } }
    }

    private func createBranch() {
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
        field.placeholderString = L("Branch name")
        let a = NSAlert()
        a.messageText = L("Create branch")
        a.accessoryView = field
        a.addButton(withTitle: L("Create"))
        a.addButton(withTitle: L("Cancel"))
        a.window.initialFirstResponder = field
        guard a.runModal() == .alertFirstButtonReturn else { return }
        let name = field.stringValue.trimmingCharacters(in: .whitespaces)
        if !name.isEmpty { Task { await model.checkout(name, create: true) } }
    }

    // ---------- the message and the one action ----------

    private var form: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack(alignment: .bottomTrailing) {
                if model.commitMessage.isEmpty {
                    Text(L("Commit message")).font(.system(size: 12)).foregroundStyle(JB.muted2)
                        .padding(.leading, 5).padding(.top, 3)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).allowsHitTesting(false)
                }
                if isSnapshot {
                    Text(model.commitMessage).font(.system(size: 12)).foregroundStyle(JB.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    TextEditor(text: $model.commitMessage)
                        .font(.system(size: 12)).foregroundStyle(JB.ink)
                        .scrollContentBackground(.hidden).background(.clear)
                        .padding(.trailing, 26)
                        .onKeyPress(.return, phases: .down) { press in
                            guard press.modifiers.contains(.command) else { return .ignored }
                            Task { await model.commit() }
                            return .handled
                        }
                }
                Button { Task { await model.suggestCommitMessage() } } label: {
                    if model.writingMessage { ProgressView().controlSize(.mini) }
                    else { Image(systemName: "sparkles").font(.system(size: 11)).foregroundStyle(files.isEmpty ? JB.muted2 : JB.accent) }
                }
                .buttonStyle(CloseButtonStyle(size: 24)).disabled(model.writingMessage || files.isEmpty)
                .help(L("Have the model write it"))
            }
            .frame(height: 54).padding(4)
            .background(RoundedRectangle(cornerRadius: 6).fill(JB.bg))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(JB.line))

            commitButton

            if let n = model.notice {
                HStack(spacing: 8) {
                    Text(n.text).font(.system(size: 10.5)).foregroundStyle(n.bad ? JB.err : JB.ok)
                        .lineLimit(1).truncationMode(.middle).transition(.opacity)
                    if n.offersPush {
                        Button { Task { await model.push() } } label: { Text(L("Push")).font(.system(size: 11, weight: .semibold)).foregroundStyle(JB.accent) }
                            .buttonStyle(Press())
                    }
                }
            }
        }
        .padding(10)
        .animation(.easeOut(duration: 0.2), value: model.notice)
    }

    /// ✓ Commit, with a ▾ beside it: Commit & Push, Amend, Undo Last Commit
    private var commitButton: some View {
        HStack(spacing: 1) {
            Button { Task { await model.commit() } } label: {
                Group {
                    if model.committing { ProgressView().controlSize(.mini) }
                    else {
                        HStack(spacing: 5) {
                            Image(systemName: "checkmark").font(.system(size: 10.5, weight: .bold))
                            Text(model.amend ? L("Commit (Amend)") : L("Commit")).font(.system(size: 12, weight: .semibold))
                        }
                    }
                }
                .foregroundStyle(JB.accentInk).frame(maxWidth: .infinity, minHeight: 28).contentShape(Rectangle())
            }
            .buttonStyle(Press()).disabled(!canCommit || model.committing)
            .keyboardShortcut(.return, modifiers: .command).help("Commit  ⌘⏎")
            if !isSnapshot {
                Menu {
                    Button(L("Commit")) { Task { await model.commit() } }.disabled(!canCommit)
                    Button(L("Commit and push")) { Task { await model.commit(andPush: true) } }.disabled(!canCommit)
                    Toggle(L("Amend"), isOn: $model.amend)
                    Divider()
                    Button(L("Undo last commit")) { Task { await model.undoLastCommit() } }
                } label: {
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold)).foregroundStyle(JB.accentInk)
                        .frame(width: 26, height: 28).contentShape(Rectangle())
                }
                .menuStyle(.button).buttonStyle(Press()).menuIndicator(.hidden).fixedSize()
            }
        }
        .background(RoundedRectangle(cornerRadius: 6).fill(JB.accent))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .opacity(canCommit || model.committing ? 1 : 0.4)
    }

    // ---------- the changed files ----------

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if !staged.isEmpty {
                    header(L("Staged Changes"), count: staged.count, open: $stagedOpen) {
                        iconButton("minus", L("Unstage all")) { Task { await model.setStaged(staged.map(\.path), false) } }
                    }
                    if stagedOpen { ForEach(staged, id: \.path) { row($0, staged: true) } }
                }
                if !changes.isEmpty {
                    header(L("Changes"), count: changes.count, open: $changesOpen) {
                        iconButton("arrow.uturn.backward", L("Discard all changes")) { confirmRollback(changes.map(\.path)) }
                        iconButton("plus", L("Stage all")) { Task { await model.setStaged(changes.map(\.path), true) } }
                    }
                    if changesOpen { ForEach(changes, id: \.path) { row($0, staged: false) } }
                }
                if files.isEmpty {
                    Text(L("No changes")).font(.system(size: 12)).foregroundStyle(JB.muted2)
                        .padding(.horizontal, 12).padding(.vertical, 10)
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func iconButton(_ symbol: String, _ help: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol).font(.system(size: 10.5, weight: .medium)) }
            .buttonStyle(CloseButtonStyle(size: 20)).help(help)
    }

    private func header<Actions: View>(_ title: String, count: Int, open: Binding<Bool>, @ViewBuilder actions: () -> Actions) -> some View {
        let acts = actions()
        return Hovering { hover in
            HStack(spacing: 4) {
                Image(systemName: "chevron.right").font(.system(size: 8, weight: .bold)).foregroundStyle(JB.muted)
                    .rotationEffect(.degrees(open.wrappedValue ? 90 : 0)).frame(width: 12)
                Text(title).font(.system(size: 11, weight: .semibold)).foregroundStyle(JB.text).textCase(.uppercase)
                Spacer(minLength: 4)
                if hover { acts.transition(.opacity) }
                Text("\(count)").font(.system(size: 10, weight: .semibold)).foregroundStyle(JB.muted)
                    .padding(.horizontal, 6).frame(minWidth: 18, minHeight: 16).background(Capsule().fill(JB.sel))
            }
            .padding(.leading, 8).padding(.trailing, 8).frame(height: 26)
            .contentShape(Rectangle()).pointerStyle(.link)
            .onTapGesture { withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { open.wrappedValue.toggle() } }
            .animation(.easeOut(duration: 0.12), value: hover)
        }
    }

    private func row(_ f: IDEGitFile, staged inIndex: Bool) -> some View {
        let state = inIndex ? f.indexStatus : f.workStatus
        let tone = GitTone.color(state)
        return Hovering { hover in
            HStack(spacing: 6) {
                FileIcon(path: f.path)
                Text((f.path as NSString).lastPathComponent)
                    .font(.system(size: 12)).lineLimit(1).foregroundStyle(tone)
                    .strikethrough(state == "deleted", color: tone)
                Text((f.path as NSString).deletingLastPathComponent)
                    .font(.system(size: 10.5)).foregroundStyle(JB.muted2).lineLimit(1).truncationMode(.head)
                Spacer(minLength: 4)
                if hover {
                    if state != "deleted" { iconButton("doc.text", L("Open file")) { model.closeDiff(); model.open(f.path) } }
                    if !inIndex { iconButton("arrow.uturn.backward", L("Discard changes")) { confirmRollback([f.path]) } }
                    iconButton(inIndex ? "minus" : "plus", inIndex ? L("Unstage") : L("Stage")) { Task { await model.setStaged([f.path], !inIndex) } }
                }
                Text(GitTone.letter(state)).font(.system(size: 10, weight: .semibold, design: .monospaced)).foregroundStyle(tone)
                    .frame(width: 12)
            }
            .padding(.leading, 22).padding(.trailing, 8)
            .frame(height: 24)
            .background(RoundedRectangle(cornerRadius: 4).fill(hover ? JB.tint : .clear).padding(.horizontal, 4))
            .contentShape(Rectangle()).pointerStyle(.link)
            .onTapGesture(count: 2) { model.closeDiff(); model.open(f.path) }
            .onTapGesture { Task { await showDiff(f, staged: inIndex) } }
            .contextMenu {
                Button(L("Show diff")) { Task { await showDiff(f, staged: inIndex) } }
                if state != "deleted" { Button(L("Open file")) { model.closeDiff(); model.open(f.path) } }
                Divider()
                Button(inIndex ? L("Unstage") : L("Stage"), systemImage: inIndex ? "minus.circle" : "plus.circle") { Task { await model.setStaged([f.path], !inIndex) } }
                if !inIndex { Button(L("Discard changes"), systemImage: "arrow.uturn.backward") { confirmRollback([f.path]) } }
                if f.status != "deleted" { Button(L("Delete"), systemImage: "trash") { confirmDelete([f.path]) } }
            }
            .help(f.path)
        }
    }

    /// the index against HEAD for a staged row; the disk against the index for the rest
    private func showDiff(_ f: IDEGitFile, staged inIndex: Bool) async {
        if inIndex { await model.openDiff(f.path, old: "HEAD", new: "INDEX") }
        else { await model.openDiff(f.path, old: "INDEX", new: nil) }
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

    private func confirmDelete(_ paths: [String]) {
        let a = NSAlert()
        a.messageText = paths.count == 1 ? L("Delete %@?", paths[0]) : L("Delete %d files?", paths.count)
        a.informativeText = L("The files are removed from disk.")
        a.alertStyle = .warning
        a.addButton(withTitle: L("Delete"))
        a.addButton(withTitle: L("Cancel"))
        if a.runModal() == .alertFirstButtonReturn { Task { await model.deleteFiles(paths) } }
    }
}
