import AppKit
import Foundation
import Testing
@testable import Taksim
import TaksimKit

/// Mid-zoom the docked IDE moves and resizes with the canvas but its content keeps the size it was laid out at,
/// unscaled, so its text never grows or shrinks; once the gesture rests the content takes the new room.
@Suite struct IDEZoomTests {
    @Test @MainActor func zoomingMovesTheBoxNotTheText() {
        let model = IDEModel(agent: "t", client: IDEClient(api: APIClient(base: URL(string: "http://127.0.0.1:1")!), canvas: "c", agent: "t"))
        let host = IDEHost(model: IDEDockModel(id: "t"), ide: model)
        let size = CGSize(width: 900, height: 560)
        host.place(origin: CGPoint(x: 100, y: 100), size: size, scale: 1)
        let laidOut = host.body.frame.size
        #expect(laidOut == CGSize(width: 900, height: 560 - IDEHost.head))

        host.place(origin: CGPoint(x: 160, y: 160), size: size, scale: 1.6, live: true)
        #expect(host.frame.size == CGSize(width: 900 * 1.6, height: 560 * 1.6))
        #expect(host.body.frame.size == laidOut)
        #expect(host.bounds.size == host.frame.size) // no bounds scaling: the text stays its real size

        host.place(origin: CGPoint(x: 160, y: 160), size: size, scale: 1.6)
        #expect(host.body.frame.width == 900 * 1.6)
        #expect(abs(host.body.frame.height - (560 - IDEHost.head) * 1.6) < 0.01)
    }
}
