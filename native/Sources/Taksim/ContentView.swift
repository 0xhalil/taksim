import SwiftUI
import TaksimKit

/// The window: the main toolbar (40), the tab strip (36), the canvas.
struct ContentView: View {
    @Bindable var model: AppModel
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        VStack(spacing: 0) {
            HeaderBar(model: model)
            if let store = model.store {
                TabStrip(store: store)
                HStack(spacing: 0) {
                    if model.showNavigator {
                        AgentNavigator(model: model, store: store)
                        Rectangle().fill(JB.line).frame(width: 1)
                    }
                if store.currentId == nil && store.visibleCanvases.isEmpty {
                    // every tab closed: one action, a new canvas
                    Button { Task { await store.newCanvas() } } label: {
                        HStack(spacing: 5) { AppIcon.plus.frame(width: 14, height: 14); Text(L("Canvas")) }
                    }
                    .buttonStyle(AddButtonStyle())
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                GraphCanvas(store: store, fitRequest: model.fitRequest,
                            addAgent: { model.sheet = .add(at: $0) },
                            editAgent: { model.sheet = .edit(id: $0) },
                            center: { model.viewCenter = $0 },
                            focus: { model.focusAgent = $0 },
                            opener: { model.openTerminal = $0 })
                }
                }
            } else {
                starting
            }
        }
        .background(JB.bg)
        // a closed tab is deleted in a moment: until then, one action takes it back
        .overlay(alignment: .bottom) {
            if let store = model.store, !store.undoable.isEmpty {
                UndoCloseChip(store: store).padding(.bottom, 22)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.85), value: model.store?.undoable.map(\.id))
        .overlay { if model.showWelcome && model.store != nil { WelcomeView(model: model) } }
        .overlayPreferenceValue(MarkAnchorKey.self) { anchor in
            GeometryReader { geo in
                if model.showLaunch { LaunchView(target: anchor.map { geo[$0] }) { model.showLaunch = false } }
            }
        }
        .overlay(alignment: .top) {
            if model.paletteOpen, let store = model.store {
                CommandPalette(store: store,
                               goToAgent: { model.focusAgent($0) },
                               openTerminal: { model.openTerminal($0, false) },
                               newAgent: { model.sheet = .add(at: .zero) },
                               newCanvas: { Task { await store.newCanvas() } },
                               toggleNavigator: { model.showNavigator.toggle() },
                               openSettings: { model.settingsSection = $0; openSettings() },
                               close: { model.paletteOpen = false })
                .padding(.top, 90)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .animation(.easeOut(duration: 0.2), value: model.paletteOpen)
        .background(TrafficLights())
        .ignoresSafeArea()
        .sheet(item: $model.sheet) { ctx in
            if let store = model.store {
                AgentSheet(store: store, context: ctx, addAccount: { backend in
                    // Settings › Hesaplar opens with a new account of this CLI being named
                    model.addAccountFor = backend
                    model.settingsSection = .accounts
                    openSettings()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { model.addAccountFor = nil }
                }) { created in
                    model.sheet = nil
                    if let a = created { model.agentAdded(a) }
                }
            }
        }
        .onChange(of: model.store?.currentId) { _, id in
            if let id, ProcessInfo.processInfo.environment["TAKSIM_URL"] == nil { UserDefaults.standard.set(id, forKey: "canvas") }
        }
    }

    private var starting: some View {
        VStack(spacing: 10) {
            if let f = model.failure {
                AppIcon.warning.frame(width: 28, height: 28).foregroundStyle(JB.err)
                Text(f).foregroundStyle(JB.text).multilineTextAlignment(.center).frame(maxWidth: 420).textSelection(.enabled)
                // the one action: try again (Node installed meanwhile, the other program closed)
                Button { Task { await model.retryStart() } } label: {
                    Image(systemName: "arrow.clockwise").font(.system(size: 13, weight: .semibold)).foregroundStyle(JB.accentInk)
                        .frame(width: 36, height: 28).background(RoundedRectangle(cornerRadius: 6).fill(JB.accent))
                }
                .buttonStyle(Press()).pointerStyle(.link).help(L("Try again")).padding(.top, 4)
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// "<name> closed · Undo", with a ring that runs out as the undo moment does
struct UndoCloseChip: View {
    let store: CanvasStore
    @State private var start = Date()
    var body: some View {
        let names = store.undoable.map(\.name)
        HStack(spacing: 10) {
            TimelineView(.animation) { t in
                let left = max(0, 1 - t.date.timeIntervalSince(start) / CanvasStore.undoSeconds)
                Circle().trim(from: 0, to: left).stroke(JB.muted, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90)).frame(width: 14, height: 14)
            }
            Text(names.count == 1 ? L("\u{201C}%@\u{201D} closed", names[0]) : L("%d canvases closed", names.count))
                .font(.system(size: 12.5)).foregroundStyle(JB.ink).lineLimit(1)
            Button { Task { await store.undoClose() } } label: {
                Text(L("Undo")).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(JB.accent)
            }
            .buttonStyle(Press())
            .keyboardShortcut("z", modifiers: .command)
        }
        .padding(.horizontal, 14).frame(height: 36)
        .background(Capsule().fill(JB.panel2))
        .overlay(Capsule().strokeBorder(JB.line))
        .shadow(color: .black.opacity(0.25), radius: 12, y: 4)
        .onChange(of: store.undoable.map(\.id)) { start = Date() }
    }
}
