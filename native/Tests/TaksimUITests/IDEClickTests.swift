import AppKit
import CodeEditTextView
import Foundation
import Testing
@testable import Taksim
import TaksimKit

/// A click on a line of the docked IDE lands on that line: the IDE in a window like the app's (content under a
/// transparent title bar), at the canvas's zoom, clicked through the window where the line is drawn.
@Suite struct IDEClickTests {
    @MainActor func clickedLine(scale: CGFloat, top: CGFloat) async throws -> (target: Int, got: Int, inset: CGFloat) {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800), styleMask: [.titled, .fullSizeContentView, .resizable], backing: .buffered, defer: false)
        w.titlebarAppearsTransparent = true
        w.isReleasedWhenClosed = false
        let root = FlippedView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800))
        w.contentView = root
        let model = IDEModel(agent: "t", client: IDEClient(api: APIClient(base: URL(string: "http://127.0.0.1:1")!), canvas: "c", agent: "t"))
        let text = (1...40).map { "line \($0) = \($0 * 3)" }.joined(separator: "\n")
        model.tabs = ["a.py"]; model.active = "a.py"
        model.buffers["a.py"] = .init(text: text, saved: text, mtime: nil)
        model.children[""] = []
        let host = IDEHost(model: IDEDockModel(id: "t"), ide: model)
        root.addSubview(host)
        host.place(origin: CGPoint(x: 100, y: top), size: CGSize(width: 900, height: 560), scale: scale)
        w.orderFrontRegardless()
        for _ in 0..<30 { try await Task.sleep(for: .milliseconds(50)); host.layoutSubtreeIfNeeded() }
        func find<T>(_ v: NSView, _ t: T.Type) -> T? { if let x = v as? T { return x }; for s in v.subviews { if let x = find(s, t) { return x } }; return nil }
        let tv = try #require(find(host, TextView.self))
        let scroll = try #require(tv.enclosingScrollView)
        // where line 12 is drawn: its fragment view, in the window
        let target = scale < 0.6 ? 4 : 12 // a line in view: the IDE keeps its text size and shows less when small
        let offset = (text as NSString).range(of: "line \(target) =").location
        let r = try #require(tv.layoutManager.rectForOffset(offset))
        let p = tv.convert(CGPoint(x: r.midX + 20, y: r.midY), to: nil)
        let down = NSEvent.mouseEvent(with: .leftMouseDown, location: p, modifierFlags: [], timestamp: 0, windowNumber: w.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        let up = NSEvent.mouseEvent(with: .leftMouseUp, location: p, modifierFlags: [], timestamp: 0, windowNumber: w.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 0)!
        w.sendEvent(down); w.sendEvent(up)
        let at = tv.selectionManager.textSelections.first?.range.location ?? -1
        let line = (text as NSString).substring(to: max(0, at)).filter { $0 == "\n" }.count + 1
        w.orderOut(nil)
        return (target, line, scroll.contentInsets.top)
    }

    @Test @MainActor func clicksLandOnTheirLine() async throws {
        for (scale, top) in [(1.0, 120.0), (0.8, 120.0), (0.65, 200.0), (1.0, 10.0), (0.5, 300.0), (0.35, 300.0), (1.5, 60.0)] {
            let r = try await clickedLine(scale: scale, top: top)
            #expect(r.got == r.target)
        }
    }
}

final class FlippedView: NSView { override var isFlipped: Bool { true } }
