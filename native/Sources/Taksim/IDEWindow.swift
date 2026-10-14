import AppKit
import TaksimKit
import WebKit

/// An agent's IDE in its own window. Until the IDE is native (phase 5) this hosts the server's IDE page,
/// which has everything the docked web IDE has: files, tabs, the editor, git, run/debug, terminal, notes.
@MainActor
enum IDEWindows {
    private static var open: [String: NSWindow] = [:]
    private static var delegates: [String: Closer] = [:]

    /// the page that shows one agent's IDE filling the window
    static func url(base: URL, canvas: String, agent: String) -> URL {
        var c = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        c.path = "/ide/\(canvas)/\(agent)"
        c.queryItems = [URLQueryItem(name: "theme", value: themeName),
                        URLQueryItem(name: "lang", value: LangState.shared.acceptLanguage)]
        return c.url!
    }

    private static var themeName: String {
        switch Theme.current {
        case .system: NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? "dark" : "light"
        case .light: "light"
        case .dark: "dark"
        case .darcula: "darcula"
        case .contrast: "contrast"
        }
    }

    /// TAKSIM_SNAPSHOT_IDE=/path.png with TAKSIM_SNAPSHOT_AGENT=<id>: the IDE window's page, written to a PNG
    static func snapshot(base: URL, canvas: String, agent: Agent, to path: String) {
        show(base: base, canvas: canvas, agent: agent)
        guard let w = open["\(canvas)/\(agent.id)"], let web = w.contentView as? WKWebView else { return }
        w.setFrameOrigin(NSPoint(x: -4000, y: 0)) // off screen: a snapshot, not a window for the user
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(6))
            web.takeSnapshot(with: nil) { image, _ in
                guard let image, let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
                try? png.write(to: URL(fileURLWithPath: path))
                print("ide snapshot written"); fflush(stdout)
            }
        }
    }

    static func show(base: URL, canvas: String, agent: Agent) {
        let key = "\(canvas)/\(agent.id)"
        if let w = open[key] { w.makeKeyAndOrderFront(nil); return }
        let web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        web.setValue(false, forKey: "drawsBackground") // the window's color shows until the page paints
        web.load(URLRequest(url: url(base: base, canvas: canvas, agent: agent.id)))
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        w.title = agent.folder?.name ?? agent.name
        w.subtitle = agent.name
        w.backgroundColor = Pal.bg
        w.contentView = web
        w.isReleasedWhenClosed = false
        w.setFrameAutosaveName("ide-\(key)")
        if !w.setFrameUsingName("ide-\(key)") { w.center() }
        let closer = Closer { open[key] = nil; delegates[key] = nil }
        delegates[key] = closer
        w.delegate = closer
        open[key] = w
        w.makeKeyAndOrderFront(nil)
    }

    private final class Closer: NSObject, NSWindowDelegate {
        let done: () -> Void
        init(_ done: @escaping () -> Void) { self.done = done }
        func windowWillClose(_ notification: Notification) { MainActor.assumeIsolated { done() } }
    }
}
