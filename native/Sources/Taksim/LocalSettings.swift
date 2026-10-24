import AppKit
import SwiftUI
import TaksimKit

/// Settings › Accounts › Local: the model servers on this Mac (Ollama, LM Studio, ones added by hand) with their
/// models, in the CLIs' own row style. Getting the first model going is the same one step as in the agent sheet.
struct LocalModelsSection: View {
    let api: APIClient
    @State private var state: LocalState?
    @State private var adding = false
    @State private var draft = ""
    @State private var problem: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                BackendTile(backend: "local", size: 18)
                Text(L("Local")).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(JB.ink)
                if let m = state?.memoryGB { Text("\(m) GB").font(.system(size: 11)).foregroundStyle(JB.muted2).monospacedDigit().help(L("Memory")) }
                Rectangle().fill(JB.line).frame(height: 1)
            }
            VStack(spacing: 0) {
                if let st = state {
                    if st.step != .ready { setupRow(st); divider }
                    ForEach(st.servers ?? []) { s in
                        serverRow(s)
                        ForEach(s.models) { m in divider; modelRow(m, on: s) }
                        divider
                    }
                } else {
                    ProgressView().controlSize(.small).frame(maxWidth: .infinity).frame(height: 52)
                }
                addRow
            }
            .background(RoundedRectangle(cornerRadius: 8).fill(JB.panel))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(JB.line))
            if let why = problem ?? state?.problem {
                Label(why, systemImage: "exclamationmark.triangle.fill").font(.system(size: 11.5)).foregroundStyle(JB.err).lineLimit(2)
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: state)
        .task {
            // kept current while Settings is open: fast while something runs, else now and then
            while !Task.isCancelled {
                if let st = try? await api.localState() { state = st }
                try? await Task.sleep(for: .seconds(state?.step == .busy ? 0.7 : 4))
            }
        }
    }

    private var divider: some View { Rectangle().fill(JB.line).frame(height: 1).padding(.leading, 50) }

    /// no local model yet: the next step, its progress while it runs
    private func setupRow(_ st: LocalState) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "arrow.down.circle").font(.system(size: 16)).foregroundStyle(JB.muted).frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(st.pull?.model ?? st.recommended.model).font(.system(size: 13)).foregroundStyle(JB.ink)
                Text(String(format: "%.1f GB", st.recommended.gb)).font(.system(size: 11.5)).foregroundStyle(JB.muted).monospacedDigit()
            }
            Spacer(minLength: 8)
            if let f = st.pull?.fraction, st.pull?.running == true {
                ProgressView(value: f).progressViewStyle(.linear).tint(JB.accent).frame(width: 120)
                Text("\(Int((f * 100).rounded()))%").font(.system(size: 11.5)).foregroundStyle(JB.muted).monospacedDigit().frame(width: 36, alignment: .trailing)
            } else if st.step == .busy {
                ProgressView().controlSize(.small)
            } else {
                Button { Task { await step(st) } } label: {
                    Text(stepLabel(st)).font(.system(size: 12, weight: .semibold)).foregroundStyle(JB.accentInk)
                        .padding(.horizontal, 12).frame(height: 24).background(Capsule().fill(JB.accent))
                }
                .buttonStyle(Press()).pointerStyle(.link)
            }
        }
        .padding(.horizontal, 12).frame(height: 52)
    }

    private func stepLabel(_ st: LocalState) -> String {
        switch st.step {
        case .install: L("Install Ollama")
        case .download: L("Get Ollama")
        case .start: L("Start Ollama")
        default: L("Download")
        }
    }

    private func step(_ st: LocalState) async {
        problem = nil
        do {
            switch st.step {
            case .install: try await api.installOllama()
            case .download: if let u = URL(string: "https://ollama.com/download") { NSWorkspace.shared.open(u) }
            case .start: try await api.startOllama()
            case .pull(let m): try await api.pullLocalModel(m)
            case .ready, .busy: break
            }
        } catch { problem = (error as? APIError)?.message ?? error.localizedDescription }
        state = try? await api.localState()
    }

    /// a server: running or not, what it is, how many models; one added by hand can be removed
    private func serverRow(_ s: LocalState.Server) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "server.rack").font(.system(size: 14)).foregroundStyle(s.running ? JB.ink : JB.muted2).frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(s.name).font(.system(size: 13)).foregroundStyle(s.running ? JB.ink : JB.muted)
                HStack(spacing: 5) {
                    Circle().fill(s.running ? JB.ok : JB.muted2).frame(width: 6, height: 6)
                    Text(s.running ? countText(s.models.count, one: "1 model", other: "%d models") : L("Not running"))
                        .font(.system(size: 11.5)).foregroundStyle(JB.muted).lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            if !s.builtIn { more { Button(L("Remove"), role: .destructive) { remove(s) } } }
        }
        .padding(.leading, 12).padding(.trailing, s.builtIn ? 12 : 4).frame(height: 52)
        .contentShape(Rectangle())
        .contextMenu { if !s.builtIn { Button(L("Remove"), role: .destructive) { remove(s) } } }
        .help(s.url)
    }

    /// a model: its name, then its size, parameters and the window it opens (or could); the wrench lights when it calls tools
    private func modelRow(_ m: LocalState.Server.Model, on s: LocalState.Server) -> some View {
        HStack(spacing: 12) {
            Color.clear.frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(m.id).font(.system(size: 12.5)).foregroundStyle(JB.ink).lineLimit(1)
                let facts = [m.sizeGB.map { String(format: "%.1f GB", $0) }, m.params, (m.window ?? m.max).map { "\(Self.k($0)) ctx" }].compactMap { $0 }
                if !facts.isEmpty { Text(facts.joined(separator: " · ")).font(.system(size: 11)).foregroundStyle(JB.muted2).monospacedDigit() }
            }
            Spacer(minLength: 8)
            if let tools = m.tools {
                Image(systemName: "wrench.and.screwdriver").font(.system(size: 11)).foregroundStyle(tools ? JB.accent : JB.muted2.opacity(0.5))
                    .help(tools ? L("Edits files and runs commands") : L("Chat only"))
            }
            if s.kind == "ollama" { more { Button(L("Delete"), role: .destructive) { delete(m) } } }
        }
        .padding(.leading, 12).padding(.trailing, s.kind == "ollama" ? 4 : 12).frame(height: 44)
        .contentShape(Rectangle())
        .contextMenu { if s.kind == "ollama" { Button(L("Delete"), role: .destructive) { delete(m) } } }
    }

    static func k(_ n: Int) -> String { n >= 1000 ? "\(Int((Double(n) / 1000).rounded()))K" : "\(n)" }

    /// ⋯ with a finger-sized target
    private func more<C: View>(@ViewBuilder _ items: () -> C) -> some View {
        Menu { items() } label: {
            Image(systemName: "ellipsis").font(.system(size: 13, weight: .semibold)).foregroundStyle(JB.muted)
                .frame(width: 34, height: 34).contentShape(Rectangle())
        }
        .menuStyle(.button).buttonStyle(Press()).menuIndicator(.hidden).fixedSize().pointerStyle(.link).help(L("More"))
    }

    /// + Add server: the usual llama.cpp address comes filled in and selected, ready to type over; Enter adds it
    @ViewBuilder private var addRow: some View {
        if adding {
            HStack(spacing: 12) {
                Image(systemName: "plus").font(.system(size: 11, weight: .bold)).foregroundStyle(JB.accent).frame(width: 28)
                TextField("", text: $draft).textFieldStyle(.plain).font(.system(size: 13, design: .monospaced)).foregroundStyle(JB.ink)
                    .focused($focused)
                    .onSubmit { commitAdd() }
                    .onExitCommand { adding = false }
            }
            .padding(.horizontal, 12).frame(height: 44)
        } else {
            Button {
                draft = "http://127.0.0.1:8080"
                adding = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { focused = true; NSApp.keyWindow?.fieldEditor(false, for: nil)?.selectAll(nil) }
            } label: {
                HStack(spacing: 12) {
                    Circle().strokeBorder(JB.line, style: StrokeStyle(lineWidth: 1.2, dash: [3, 2])).frame(width: 28, height: 28)
                        .overlay(Image(systemName: "plus").font(.system(size: 11, weight: .bold)).foregroundStyle(JB.muted))
                    Text(L("Add server")).font(.system(size: 13)).foregroundStyle(JB.muted)
                    Spacer()
                }
                .padding(.horizontal, 12).frame(height: 44).contentShape(Rectangle())
            }
            .buttonStyle(Press()).pointerStyle(.link)
        }
    }

    private func commitAdd() {
        let url = draft.trimmingCharacters(in: .whitespaces)
        adding = false
        guard !url.isEmpty else { return }
        Task {
            problem = nil
            do { try await api.addLocalServer(url) } catch { problem = (error as? APIError)?.message ?? error.localizedDescription }
            state = try? await api.localState()
        }
    }

    private func remove(_ s: LocalState.Server) {
        Task { try? await api.removeLocalServer(s.url); state = try? await api.localState() }
    }

    /// gone from the disk (it can be downloaded again)
    private func delete(_ m: LocalState.Server.Model) {
        Task {
            problem = nil
            do { try await api.deleteLocalModel(m.id) } catch { problem = (error as? APIError)?.message ?? error.localizedDescription }
            state = try? await api.localState()
        }
    }
}
