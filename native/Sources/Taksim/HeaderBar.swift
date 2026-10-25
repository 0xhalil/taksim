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
            AgentKey(model: model)
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

/// The bar's single accent key, "+ Agent" and its chevron: a physical key that answers the pointer as Apple's do.
/// Hovering lifts it (a deeper shadow, a lighter face) and lights the half under the pointer; the plus turns a
/// quarter as if to say "a new one", the chevron dips toward the menu it opens. A press sinks the key with a
/// spring and it stays down while its menu is open. The key draws itself and opens plain AppKit menus under it:
/// a SwiftUI `Menu` label in the toolbar is redrawn as a bare system button, dropping the icon and the key's size.
struct AgentKey: View {
    @Bindable var model: AppModel
    @Environment(\.isSnapshot) private var isSnapshot
    @Environment(\.isEnabled) private var enabled
    @State private var addHover = false
    @State private var addDown = false
    @State private var moreHover = false
    @State private var moreDown = false
    @State private var open = false
    @State private var frame = CGRect.zero

    var body: some View {
        let lit = enabled && (addHover || moreHover), down = enabled && (addDown || moreDown || open)
        HStack(spacing: 0) {
            Button { pop(folderMenu()) } label: { addLabel }
                .buttonStyle(KeyHalf(down: $addDown, hover: addHover))
                .onHover { addHover = $0 }
                .help(L("Add agent")).accessibilityLabel(L("Add agent"))
            Rectangle().fill(JB.accentInk.opacity(lit ? 0.32 : 0.22)).frame(width: 1, height: 14)
            Button { pop(backendMenu()) } label: { moreLabel }
                .buttonStyle(KeyHalf(down: $moreDown, hover: moreHover))
                .onHover { moreHover = $0 }
                .accessibilityLabel(L("More"))
                .task { await model.store?.loadChoices() }
        }
        .foregroundStyle(JB.accentInk)
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous).fill(JB.accent)
                // a key's edge: light catches the top, the face falls off toward the bottom
                .overlay(LinearGradient(colors: [.white.opacity(lit ? 0.16 : 0.10), .clear, .black.opacity(0.08)], startPoint: .top, endPoint: .bottom))
        )
        .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(.white.opacity(lit ? 0.22 : 0.14), lineWidth: 0.5))
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        .brightness(down ? -0.07 : lit ? 0.03 : 0)
        .shadow(color: .black.opacity(down ? 0.18 : lit ? 0.34 : 0.2), radius: down ? 0.5 : lit ? 4 : 1, y: down ? 0 : lit ? 2 : 0.5)
        .scaleEffect(down ? 0.955 : 1)
        .opacity(enabled ? 1 : 0.5)
        .background(GeometryReader { g in Color.clear.onAppear { frame = g.frame(in: .global) }.onChange(of: g.frame(in: .global)) { frame = $1 } })
        .animation(isSnapshot ? nil : .spring(response: 0.26, dampingFraction: 0.62), value: down)
        .animation(isSnapshot ? nil : .spring(response: 0.3, dampingFraction: 0.8), value: lit)
    }

    private var addLabel: some View {
        HStack(spacing: 5) {
            AppIcon.plus.frame(width: 12, height: 12)
                .rotationEffect(.degrees(enabled && addHover ? 90 : 0))
                .animation(isSnapshot ? nil : .spring(response: 0.38, dampingFraction: 0.55), value: addHover)
            Text(L("Agent"))
        }
        .font(.system(size: 12.5, weight: .semibold))
        .padding(.leading, 9).padding(.trailing, 11).frame(height: 28)
    }

    private var moreLabel: some View {
        Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold))
            .offset(y: enabled && moreHover ? 1.5 : 0)
            .animation(isSnapshot ? nil : .spring(response: 0.3, dampingFraction: 0.5), value: moreHover)
            .frame(width: 24, height: 28)
    }

    /// the folder is asked first: the ones the canvas's agents work in, or another
    private func folderMenu() -> NSMenu {
        let m = NSMenu()
        let folders = model.folderChoices()
        for path in folders {
            let i = MenuItem(title: HeaderBar.folderTitle(path, among: folders)) { [model] in model.addAgent(backend: nil, folder: path) }
            i.image = NSImage(systemSymbolName: "folder", accessibilityDescription: nil)
            i.toolTip = path
            m.addItem(i)
        }
        if !folders.isEmpty { m.addItem(.separator()) }
        let choose = MenuItem(title: L("Choose folder")) { [model] in model.quickAdd() }
        choose.image = NSImage(systemSymbolName: "folder.badge.plus", accessibilityDescription: nil)
        m.addItem(choose)
        let none = MenuItem(title: L("No folder")) { [model] in model.addAgent(backend: nil, folder: "") }
        none.image = NSImage(systemSymbolName: "tray", accessibilityDescription: nil)
        m.addItem(none)
        return m
    }

    /// the chevron picks another CLI
    private func backendMenu() -> NSMenu {
        let m = NSMenu()
        for b in model.store?.backends ?? [] {
            let i = MenuItem(title: CanvasStore.label(of: b)) { [model] in model.quickAdd(backend: b) }
            i.image = NSImage(systemSymbolName: "terminal", accessibilityDescription: nil)
            m.addItem(i)
        }
        m.addItem(.separator())
        m.addItem(MenuItem(title: L("Details…")) { [model] in model.sheet = .add(at: model.viewCenter()) })
        return m
    }

    /// opens the menu just under the key, its left edge on the key's; the key stays down until it closes
    private func pop(_ m: NSMenu) {
        guard let view = NSApp.keyWindow?.contentView else { return }
        let y = view.isFlipped ? frame.maxY + 4 : view.bounds.height - frame.maxY - 4
        open = true
        m.popUp(positioning: nil, at: NSPoint(x: frame.minX, y: y), in: view)
        open = false
    }
}

/// one half of the accent key: the half under the pointer brightens, the pressed one darkens, the hand says "press"
private struct KeyHalf: ButtonStyle {
    @Binding var down: Bool
    let hover: Bool
    func makeBody(configuration: Configuration) -> some View { Face(configuration: configuration, down: $down, hover: hover) }

    private struct Face: View {
        let configuration: Configuration
        @Binding var down: Bool
        let hover: Bool
        @Environment(\.isEnabled) private var enabled
        @Environment(\.isSnapshot) private var snapshot
        var body: some View {
            configuration.label
                .background(Rectangle().fill(configuration.isPressed ? Color.black.opacity(0.12) : .white.opacity(enabled && hover ? 0.12 : 0)))
                .contentShape(Rectangle())
                .pointerStyle(enabled ? .link : .default)
                .animation(snapshot ? nil : .easeOut(duration: 0.14), value: hover)
                .onChange(of: configuration.isPressed) { down = $1 }
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
