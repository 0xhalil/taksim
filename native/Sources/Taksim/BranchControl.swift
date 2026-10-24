import SwiftUI
import TaksimKit

/// The canvas's branches, at the right of the tab strip: the set the canvas is on (or the branch all its repos
/// share). Its menu switches the whole canvas to another set in one step, keeps the current branches as a new
/// set, and moves a single repo. Shown only when an agent on the canvas works in a git repo.
struct BranchControl: View {
    let store: CanvasStore
    static let width: CGFloat = 200
    @Environment(\.isSnapshot) private var isSnapshot
    @State private var renaming: String?
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        if let state = store.branches, !state.repos.isEmpty {
            Group {
                // ImageRenderer can't draw a Menu or a popover: snapshots get the label
                if isSnapshot { label(state) } else {
                    Menu { menu(state) } label: { label(state) }
                        .menuStyle(.borderlessButton).menuIndicator(.hidden)
                        .fixedSize()
                        .popover(isPresented: Binding(get: { renaming != nil }, set: { if !$0 { commit() } }), arrowEdge: .bottom) {
                            TextField("", text: $draft).textFieldStyle(.plain).font(.system(size: 12.5))
                                .focused($focused).onSubmit(commit).onExitCommand { renaming = nil }
                                .frame(width: 180).padding(10)
                                .onAppear { focused = true }
                        }
                }
            }
            .frame(maxWidth: Self.width, alignment: .trailing)
            .help(store.branchError ?? state.repos.map { "\($0.name)  \($0.branch ?? "—")" }.joined(separator: "\n"))
            .accessibilityLabel(L("Branches"))
            .animation(.spring(response: 0.35, dampingFraction: 0.8), value: state.title)
        }
    }

    private func label(_ state: BranchState) -> some View {
        HStack(spacing: 5) {
            ZStack {
                if store.branchSwitching { ProgressView().controlSize(.mini) }
                else { AppIcon.branch.frame(width: 12, height: 12) }
            }
            .frame(width: 14, height: 14)
            .foregroundStyle(store.branchError != nil ? JB.err : state.active != nil ? JB.accent : JB.muted)
            if let t = state.title {
                Text(t).lineLimit(1).truncationMode(.middle)
                    .id(t).transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity),
                                                  removal: .move(edge: .top).combined(with: .opacity)))
            }
            if state.repos.contains(where: { $0.dirty == true }) {
                Circle().fill(JB.warn).frame(width: 5, height: 5).accessibilityLabel(L("Uncommitted changes"))
            }
        }
        .font(.system(size: 12))
        .foregroundStyle(JB.text)
        .padding(.horizontal, 8).frame(height: ChromeMetrics.control)
        .clipped()
        .contentShape(Rectangle())
    }

    @ViewBuilder private func menu(_ state: BranchState) -> some View {
        if let e = store.branchError { Text(e) ; Divider() }
        ForEach(state.sets) { set in
            Button { Task { await store.switchBranches(to: set.id) } } label: {
                if set.id == state.active { Image(systemName: "checkmark") }
                Text(set.name)
                Text(state.lines(of: set).map { "\($0.repo) \($0.branch)" }.joined(separator: " · "))
            }
            .disabled(set.id == state.active || store.branchSwitching)
        }
        if !state.currentIsSaved {
            Button {
                Task {
                    // the system names it; the name arrives selected, ready to type over
                    if let s = await store.saveBranchSet() { draft = s.name; renaming = s.id }
                }
            } label: { Label(L("Current branches"), systemImage: "plus") }
        }
        Divider()
        ForEach(state.repos) { repo in
            Menu {
                ForEach(repo.branches ?? [], id: \.self) { b in
                    Button { Task { await store.switchBranch(repo: repo.dir, to: b) } } label: {
                        if b == repo.branch { Image(systemName: "checkmark") }
                        Text(b)
                    }
                    .disabled(b == repo.branch || store.branchSwitching)
                }
            } label: {
                Text(repo.name)
                Text((repo.branch ?? "—") + (repo.dirty == true ? "  ●" : ""))
            }
        }
        if !state.sets.isEmpty {
            Divider()
            Menu(L("Sets")) {
                ForEach(state.sets) { set in
                    Menu(set.name) {
                        Button(L("Rename")) { draft = set.name; renaming = set.id }
                        Button(L("Take current branches")) { store.updateBranchSet(set.id) }.disabled(set.id == state.active)
                        Divider()
                        Button(L("Delete"), role: .destructive) { store.deleteBranchSet(set.id) }
                    }
                }
            }
        }
    }

    private func commit() {
        guard let id = renaming else { return }
        renaming = nil
        let name = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty, name != store.branches?.sets.first(where: { $0.id == id })?.name { store.renameBranchSet(id, to: name) }
    }
}
