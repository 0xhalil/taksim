import XCTest
import AppKit
import TaksimKit
@testable import Taksim

/// Zooming a real canvas: TAKSIM_ZOOM_BENCH=http://127.0.0.1:<port> (an engine) and TAKSIM_ZOOM_BENCH_CANVAS=<id>.
/// Skipped otherwise. A step was 87–208 ms with two or three chats open (each chat laid out again as it moved);
/// mid-gesture the views now follow on their layers and are placed for real once it rests.
final class ZoomBenchTests: XCTestCase {
    @MainActor func testZoomStepsAreCheapAndViewsLandWhereTheyShow() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["TAKSIM_ZOOM_BENCH"].flatMap(URL.init(string:)), let id = env["TAKSIM_ZOOM_BENCH_CANVAS"] else {
            throw XCTSkip("no engine")
        }
        let api = APIClient(base: url)
        let store = CanvasStore(api: api)
        store.load(try await api.get("/v1/canvases/\(id)", as: Canvas.self))
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 1500, height: 950), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        let graph = GraphView(frame: CGRect(x: 0, y: 0, width: 1500, height: 950))
        window.contentView = graph
        window.orderFront(nil)
        defer { window.orderOut(nil) }
        graph.store = store
        graph.fit()
        graph.layoutTerminals()
        try await Task.sleep(for: .seconds(3)) // chats load their messages
        func frame() -> Double {
            let t = CACurrentMediaTime()
            window.contentView?.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            CATransaction.flush()
            return (CACurrentMediaTime() - t) * 1000
        }
        func shown() -> [CGRect] {
            graph.canvasViews.filter { !$0.isHidden }.compactMap { v in v.layer.map { graph.layer!.convert($0.bounds, from: $0) } }
        }
        _ = frame()

        let mid = CGPoint(x: graph.bounds.midX, y: graph.bounds.midY)
        var steps: [Double] = []
        for i in 0..<120 {
            let t = CACurrentMediaTime()
            graph.zoom(by: i < 60 ? 1.02 : 0.98, at: mid)
            steps.append((CACurrentMediaTime() - t) * 1000 + frame())
        }
        graph.endLiveView()
        let settle = frame()
        steps.sort()
        print(String(format: "ZOOMBENCH step median %.2f ms, p90 %.2f, settling %.1f ms", steps[steps.count / 2], steps[steps.count * 9 / 10], settle))

        // mid-gesture, each view shows where it lands once laid out for real
        for k in [1.3, 0.6] {
            let before = shown()
            graph.zoom(by: k, at: CGPoint(x: 300, y: 200))
            graph.offset.x += 37
            CATransaction.flush()
            let live = shown()
            graph.endLiveView()
            // laid out at the new zoom in the same frame the transform goes: nothing left for the next one
            func drawn() -> [String] {
                func walk(_ l: CALayer, _ d: Int) -> [String] {
                    ["\(d) \(Int(l.bounds.width))x\(Int(l.bounds.height)) \(l.affineTransform().a)"] + (d < 4 ? (l.sublayers ?? []).prefix(3).flatMap { walk($0, d + 1) } : [])
                }
                return graph.canvasViews.filter { !$0.isHidden }.compactMap { $0.layer }.flatMap { walk($0, 0) }
            }
            CATransaction.flush()
            let now = drawn()
            try await Task.sleep(for: .milliseconds(100))
            _ = frame()
            let later = drawn()
            print("ZOOMBENCH changed a frame later:", zip(now, later).filter { $0 != $1 }.prefix(6).map { "\($0) -> \($1)" })
            XCTAssertEqual(now, later, "the views drew at the old zoom for a frame")
            let real = shown()
            let moved = zip(before, live).map { max(abs($0.minX - $1.minX), abs($0.width - $1.width)) }.max() ?? 0
            let off = zip(live, real).map { max(abs($0.minX - $1.minX), abs($0.minY - $1.minY), abs($0.width - $1.width), abs($0.height - $1.height)) }.max() ?? 0
            XCTAssertGreaterThan(moved, 20)
            XCTAssertLessThan(off, 1.5)
        }
    }
}
