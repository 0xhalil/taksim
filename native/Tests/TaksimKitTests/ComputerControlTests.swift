import Foundation
import Testing
@testable import TaksimKit

// Computer control (src/computer/access.mjs): the canvas carries who has it or asks, events keep it current.
@MainActor @Test func computerControlFollowsTheCanvasAndItsEvents() throws {
    let store = CanvasStore(api: APIClient(base: URL(string: "http://127.0.0.1:1")!))
    var canvas = try JSONDecoder().decode(Canvas.self, from: fixture("canvas"))
    let id = try #require(canvas.agents.first?.id)
    canvas.computer = [id: ComputerControl(state: "on")]
    store.load(canvas)
    #expect(store.computer[id]?.state == "on")
    func ev(_ data: String) -> ServerEvent { ServerEvent(seq: 1, type: "computer", data: Data(data.utf8)) }

    store.apply(ev(#"{"id":"\#(id)","computer":{"state":"asking"}}"#))
    #expect(store.computer[id]?.isAsking == true)
    store.apply(ev(#"{"id":"\#(id)","computer":{"state":"on","missing":["screen"],"at":1760000000000}}"#))
    #expect(store.computer[id]?.needsMac == true)
    #expect(store.computer[id]?.at == 1760000000000)
    store.apply(ev(#"{"id":"\#(id)","computer":null}"#))
    #expect(store.computer[id] == nil)

    store.apply(ev(#"{"id":"\#(id)","computer":{"state":"on"}}"#))
    store.apply(ServerEvent(seq: 2, type: "agent_removed", data: Data(#"{"id":"\#(id)"}"#.utf8)))
    #expect(store.computer[id] == nil)
}

@Test func aCanvasWithoutComputerControlStillDecodes() throws {
    let c = try JSONDecoder().decode(Canvas.self, from: fixture("canvas"))
    #expect(c.computer == nil)
}
