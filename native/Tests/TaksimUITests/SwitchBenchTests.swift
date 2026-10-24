import XCTest
import AppKit
import SwiftUI
import TaksimKit
@testable import Taksim

/// Switching tabs on real canvases: TAKSIM_SWITCH_BENCH=http://127.0.0.1:<port> (an engine with two or more
/// canvases). Skipped otherwise. Times the frame that first shows the other canvas, and the one after the
/// engine's copy of it came in. With 4 agents and 3 chats the first frame took 80 ms and the second 4: every
/// chat, the hidden ones too, read the store's one agents dictionary and was drawn again whenever it was swapped.
/// Each canvas's agents are now watched apart (CanvasStore.agents(on:)) and an unchanged copy touches nothing:
/// 25 ms and 0.5. Most of what is left is SwiftUI committing the chats that come back into view.
final class SwitchBenchTests: XCTestCase {
    @MainActor func testSwitchingShowsTheOtherCanvasInOneFrame() async throws {
        guard let url = ProcessInfo.processInfo.environment["TAKSIM_SWITCH_BENCH"].flatMap(URL.init(string:)) else {
            throw XCTSkip("no engine")
        }
        let api = APIClient(base: url)
        let store = CanvasStore(api: api)
        await store.start(prefer: nil)
        let ids = store.canvases.filter { ($0.agents ?? 0) > 0 }.map(\.id)
        guard ids.count >= 2 else { throw XCTSkip("needs two canvases with agents") }
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 1500, height: 950), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.contentView = NSHostingView(rootView: VStack(spacing: 0) {
            TabStrip(store: store)
            GraphCanvas(store: store, fitRequest: 0)
        }.frame(width: 1500, height: 950))
        window.orderFront(nil)
        defer { window.orderOut(nil) }
        func frame() -> Double {
            let t = CACurrentMediaTime()
            window.contentView?.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            CATransaction.flush()
            return (CACurrentMediaTime() - t) * 1000
        }
        // every canvas visited once, its chats loaded
        for id in ids + [ids[0]] {
            await store.open(id)
            _ = frame()
            try await Task.sleep(for: .seconds(2))
            _ = frame()
        }
        var first: [Double] = [], fresh: [Double] = [], wait: [Double] = []
        for i in 0..<(Int(ProcessInfo.processInfo.environment["TAKSIM_SWITCH_N"] ?? "") ?? 20) {
            let id = ids[(i + 1) % ids.count]
            let t = CACurrentMediaTime()
            let open = Task { await store.open(id) }
            await Task.yield()
            XCTAssertEqual(store.currentId, id, "the tab shows before the engine answers")
            first.append((CACurrentMediaTime() - t) * 1000 + frame())
            let w = CACurrentMediaTime()
            await open.value
            wait.append((CACurrentMediaTime() - w) * 1000)
            fresh.append(frame())
            try await Task.sleep(for: .milliseconds(300))
            _ = frame()
        }
        func med(_ a: [Double]) -> Double { a.sorted()[a.count / 2] }
        func p90(_ a: [Double]) -> Double { a.sorted()[a.count * 9 / 10] }
        print(String(format: "SWITCHBENCH first frame median %.1f ms p90 %.1f · engine %.1f ms · fresh frame median %.1f ms p90 %.1f",
                     med(first), p90(first), med(wait), med(fresh), p90(fresh)))
        XCTAssertLessThan(med(first), 40, "switching tabs lays the chats out again")
    }
}
