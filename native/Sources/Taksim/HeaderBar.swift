import AppKit
import SwiftUI
import TaksimKit

/// canvas.html `.hic`: a 30×28 icon button, muted until hovered
struct HeaderIconStyle: ButtonStyle {
    var on = false
    func makeBody(configuration: Configuration) -> some View {
        Hovering { hover in
            configuration.label
                .frame(width: 16, height: 16)
                .foregroundStyle(hover || on ? JB.ink : JB.muted)
                .frame(width: 30, height: 28)
                .background(RoundedRectangle(cornerRadius: 6).fill(configuration.isPressed ? JB.line : hover || on ? JB.panel2 : .clear))
                .scaleEffect(configuration.isPressed ? 0.9 : 1)
                .contentShape(Rectangle())
                .animation(.easeOut(duration: 0.15), value: hover)
                .animation(.spring(response: 0.22, dampingFraction: 0.6), value: configuration.isPressed)
        }
    }
}

/// one half of the bar's single accent key: no shape of its own (the key draws one), lighter while hovered
struct AddButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Hovering { hover in
            configuration.label
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(JB.accentInk)
                .padding(.leading, 9).padding(.trailing, 11)
                .frame(height: 28)
                .background(Color.white.opacity(configuration.isPressed ? 0 : hover ? 0.1 : 0))
                .brightness(configuration.isPressed ? -0.06 : 0)
                .contentShape(Rectangle())
                .animation(.easeOut(duration: 0.15), value: hover)
        }
    }
}

/// The main toolbar (canvas.html `header`, desktop layout): room for the window buttons, the brand, the
/// connection dot, the icon group, "+ Ajan". The bar drags the window, as `-webkit-app-region: drag` does.
struct HeaderBar: View {
    @Bindable var model: AppModel
    @Environment(\.openSettings) private var openSettings
    @Environment(\.isSnapshot) private var isSnapshot
    private var shelf = ToolShelf.shared
    private var updater = Updater.shared

    init(model: AppModel) { self.model = model }

    /// the saved tools live under settings' plugins for now
    private func openTools() {
        withAnimation { shelf.count = 0 }
        model.settingsSection = .plugins
        openSettings()
    }

    var body: some View {
        HStack(spacing: 6) {
            HStack(spacing: 7) {
                MarkShape(small: true).fill(JB.accent).frame(width: 15, height: 15)
                    .opacity(model.showLaunch ? 0 : 1)
                    .anchorPreference(key: MarkAnchorKey.self, value: .bounds) { $0 }
                Text("taksim").font(.system(size: 13.5, weight: .semibold)).kerning(-0.135).foregroundStyle(JB.ink)
            }
            .padding(.trailing, 8)
            .help(["taksim", AppBuild.commit, AppBuild.builtAt.map { Date(timeIntervalSince1970: $0).formatted(date: .abbreviated, time: .shortened) }]
                .compactMap { $0 }.joined(separator: " · "))
            Button { model.showNavigator.toggle() } label: { AppIcon.navigator }
                .buttonStyle(HeaderIconStyle(on: model.showNavigator))
                .help(L("Sidebar  ⌘⇧A")).accessibilityLabel(L("Sidebar"))
            Spacer(minLength: 8)
            // the engine runs older code than the checkout (a server left running across an update): one click
            // starts it again from the code on disk
            if let note = updater.announcements.first {
                // the publisher's message: read and gone with a click (its link opens, if it has one)
                Button { updater.open(note) } label: {
                    HStack(spacing: 6) {
                        Image(systemName: note.important ? "exclamationmark.circle.fill" : "megaphone.fill").font(.system(size: 11))
                            .foregroundStyle(note.important ? JB.warn : JB.accent)
                        Text(updater.text(note)).font(.system(size: 12)).foregroundStyle(JB.ink).lineLimit(1)
                        if note.url != nil { Image(systemName: "arrow.up.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(JB.muted) }
                    }
                    .padding(.horizontal, 10).frame(height: 24).frame(maxWidth: 420)
                    .background(Capsule().fill(JB.panel2))
                }
                .buttonStyle(Press())
                .contextMenu { Button(L("Dismiss")) { updater.dismiss(note) } }
                .transition(.move(edge: .top).combined(with: .opacity))
                .padding(.trailing, 6)
            }
            if updater.available != nil || updater.installing {
                // a newer release: one click downloads, checks and swaps the app, then reopens it
                Button { updater.install() } label: {
                    HStack(spacing: 5) {
                        if updater.installing { ProgressView(value: updater.progress).progressViewStyle(.circular).controlSize(.mini) }
                        else { Image(systemName: "arrow.down.circle").font(.system(size: 11, weight: .semibold)) }
                        Text(updater.available?.version?.description ?? L("Update")).font(.system(size: 12, weight: .medium)).monospacedDigit()
                    }
                    .foregroundStyle(JB.accentInk)
                    .padding(.horizontal, 9).frame(height: 24)
                    .background(Capsule().fill(JB.accent))
                }
                .buttonStyle(Press()).disabled(updater.installing)
                .help(updater.failure ?? L("Install the new version and reopen"))
                .transition(.scale.combined(with: .opacity))
                .padding(.trailing, 6)
            }
            if let store = model.store { UsageHeader(store: store) }
            conn
            HStack(spacing: 2) {
                Button { model.fitRequest += 1 } label: { AppIcon.fit }.help(L("Show all  ⌘0")).accessibilityLabel(L("Show all"))
                // kept tools fly here and wait under Settings › Plugins
                Button { if shelf.count > 0 { openTools() } else { openSettings() } } label: { AppIcon.settings }
                    .background(ToolShelfAnchor())
                    .overlay(alignment: .topTrailing) {
                        if shelf.count > 0 {
                            Text("\(shelf.count)").font(.system(size: 9, weight: .bold)).foregroundStyle(JB.accentInk)
                                .padding(.horizontal, 4).frame(minWidth: 14, minHeight: 14)
                                .background(Capsule().fill(JB.accent))
                                .offset(x: 2, y: -1)
                                .transition(.scale.combined(with: .opacity))
                        }
                    }
                    .help(L("Settings  ⌘,")).accessibilityLabel(L("Settings"))
            }
            .buttonStyle(HeaderIconStyle())
            .padding(.trailing, 6)
            .overlay(alignment: .trailing) { Rectangle().fill(JB.line).frame(width: 1) }
            .padding(.trailing, 4)
            // one click: an agent like the last one (model, folder, account), its terminal open; the chevron picks another CLI
            HStack(spacing: 0) {
                // the folder is asked first: the ones the canvas's agents work in, or another
                if isSnapshot {
                    HStack(spacing: 5) { AppIcon.plus.frame(width: 12, height: 12); Text(L("Agent")) }
                        .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(JB.accentInk).padding(.leading, 9).padding(.trailing, 11).frame(height: 28)
                } else {
                    Menu {
                        let folders = model.folderChoices()
                        ForEach(folders, id: \.self) { path in
                            Button { model.addAgent(backend: nil, folder: path) } label: { Label(Self.folderTitle(path, among: folders), systemImage: "folder") }
                                .help(path)
                        }
                        if !folders.isEmpty { Divider() }
                        Button { model.quickAdd() } label: { Label(L("Choose folder"), systemImage: "folder.badge.plus") }
                        Button { model.addAgent(backend: nil, folder: "") } label: { Label(L("No folder"), systemImage: "tray") }
                    } label: {
                        HStack(spacing: 5) { AppIcon.plus.frame(width: 12, height: 12); Text(L("Agent")) }
                            .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(JB.accentInk)
                            .padding(.leading, 9).padding(.trailing, 11).frame(height: 28).contentShape(Rectangle())
                    }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    .help(L("Add agent"))
                }
                Rectangle().fill(JB.accentInk.opacity(0.22)).frame(width: 1, height: 14)
                if isSnapshot {
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold)).foregroundStyle(JB.accentInk).frame(width: 22, height: 28)
                } else {
                    Menu {
                        ForEach(model.store?.backends ?? [], id: \.self) { b in
                            Button { model.quickAdd(backend: b) } label: { Label(CanvasStore.label(of: b), systemImage: "terminal") }
                        }
                        Divider()
                        Button(L("Details…")) { model.sheet = .add(at: model.viewCenter()) }
                    } label: {
                        Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold))
                    }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    .foregroundStyle(JB.accentInk)
                    .frame(width: 24, height: 28)
                    .contentShape(Rectangle())
                    .task { await model.store?.loadChoices() }
                }
            }
            .background(RoundedRectangle(cornerRadius: 6).fill(JB.accent))
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .disabled(model.store?.currentId == nil)
        }
        .padding(.leading, 84).padding(.trailing, 10)
        .frame(height: 40)
        .frame(maxWidth: .infinity)
        .background(JB.panel)
        .overlay(alignment: .bottom) { Rectangle().fill(JB.bg).frame(height: 1) }
        .gesture(WindowDragGesture())
        .onAppear { shelf.open = { openTools() } }
        .onTapGesture(count: 2) { NSApp.keyWindow?.performZoom(nil) }
    }

    /// a folder's name; with its parent too when another one in the list has the same name
    static func folderTitle(_ path: String, among all: [String]) -> String {
        let name = (path as NSString).lastPathComponent
        guard all.filter({ ($0 as NSString).lastPathComponent == name }).count > 1 else { return name }
        return ((path as NSString).deletingLastPathComponent as NSString).lastPathComponent + "/" + name
    }

    /// canvas.html #conn: only a broken connection shows
    @ViewBuilder private var conn: some View {
        let ok = model.store?.connected ?? false
        let dropped = !ok && (model.store?.everConnected ?? false)
        // nothing while it's live; only a lost connection shows, as a red dot
        if dropped {
            Circle().fill(JB.err).frame(width: 7, height: 7)
                .padding(.horizontal, 8)
                .transition(.opacity)
                .help(L("Connection lost"))
                .accessibilityLabel(L("Connection lost"))
        }
    }
}

/// Puts the window buttons inside the header (at 14, 16, as a "hiddenInset" title bar would), and keeps them there
/// through resizes and full screen.
struct TrafficLights: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { Placer() }
    func updateNSView(_ v: NSView, context: Context) { (v as? Placer)?.place() }

    final class Placer: NSView {
        var observers: [NSObjectProtocol] = []
        override func viewDidMoveToWindow() {
            observers.forEach(NotificationCenter.default.removeObserver)
            observers = []
            guard let w = window else { return }
            w.titlebarAppearsTransparent = true
            w.titleVisibility = .hidden
            w.styleMask.insert(.fullSizeContentView)
            w.backgroundColor = NSColor(hex: 0x161514)
            for n in [NSWindow.didResizeNotification, NSWindow.didEndLiveResizeNotification, NSWindow.didExitFullScreenNotification, NSWindow.didBecomeKeyNotification] {
                observers.append(NotificationCenter.default.addObserver(forName: n, object: w, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.place() }
                })
            }
            DispatchQueue.main.async { self.place() }
        }
        func place() {
            guard let w = window, !w.styleMask.contains(.fullScreen),
                  let close = w.standardWindowButton(.closeButton), let bar = close.superview?.superview else { return }
            let h: CGFloat = 40
            bar.frame = NSRect(x: 0, y: w.frame.height - h, width: w.frame.width, height: h)
            for (i, kind) in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].enumerated() {
                guard let b = w.standardWindowButton(kind) else { continue }
                b.setFrameOrigin(NSPoint(x: 14 + CGFloat(i) * 20, y: (b.superview?.frame.height ?? h) - 16 - b.frame.height))
            }
        }
    }
}
