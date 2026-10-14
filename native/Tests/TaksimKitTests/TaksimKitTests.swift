import Foundation
import Testing
@testable import TaksimKit

// Fixtures are real responses of the server (captured from a demo canvas), so a change to the API that the
// app can't read shows up here.
func fixture(_ name: String) throws -> Data {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
    return try Data(contentsOf: url)
}

@Test func decodesTheCanvasList() throws {
    let list = try JSONDecoder().decode(CanvasList.self, from: fixture("canvases"))
    #expect(!list.canvases.isEmpty)
    #expect(list.canvases.allSatisfy { !$0.id.isEmpty && !$0.name.isEmpty })
}

@Test func decodesACanvasWithAgentsPanelsAndGroups() throws {
    let c = try JSONDecoder().decode(Canvas.self, from: fixture("canvas"))
    #expect(!c.agents.isEmpty)
    let ops = try #require(c.agents.first { $0.name == "ops" })
    #expect(ops.backend == "fake")
    #expect(ops.panel?.spec?.title.isEmpty == false)
    #expect((c.groups ?? []).allSatisfy { $0.rect.count == 4 })
}

@Test func decodesACanvasWithAnIDE() throws {
    let c = try JSONDecoder().decode(Canvas.self, from: fixture("canvas-ide"))
    #expect(c.agents.contains { $0.ide != nil })
}

@Test func parsesServerSentEvents() {
    var p = SSEParser()
    let lines = [": connected seq=4", "id: 5", "event: agent_status",
                 #"data: {"seq":5,"ts":1,"type":"agent_status","data":{"id":"a1","status":"running"}}"#, ""]
    let events = lines.compactMap { p.feed($0) }
    #expect(events.count == 1)
    #expect(events[0].seq == 5)
    #expect(events[0].type == "agent_status")
    let data = try? JSONSerialization.jsonObject(with: events[0].data) as? [String: Any]
    #expect(data?["status"] as? String == "running")
}

@MainActor @Test func eventsUpdateTheStore() throws {
    let store = CanvasStore(api: APIClient(base: URL(string: "http://127.0.0.1:1")!))
    store.load(try JSONDecoder().decode(Canvas.self, from: fixture("canvas")))
    let id = try #require(store.currentAgents.first?.id)
    func ev(_ type: String, _ data: String) -> ServerEvent { ServerEvent(seq: 1, type: type, data: Data(data.utf8)) }

    store.apply(ev("agent_status", #"{"id":"\#(id)","status":"running","queued":2}"#))
    #expect(store.agents[id]?.status == "running")
    #expect(store.agents[id]?.queued == 2)

    store.apply(ev("text_delta", #"{"id":"\#(id)","text":"mer"}"#))
    store.apply(ev("text_delta", #"{"id":"\#(id)","text":"haba"}"#))
    #expect(store.streaming[id] == "merhaba")

    store.apply(ev("message", #"{"from":"\#(id)","to":"user","kind":"assistant","text":"bitti"}"#))
    #expect(store.agents[id]?.lastText == "bitti")
    #expect(store.streaming[id] == nil)

    store.apply(ev("agent_removed", #"{"id":"\#(id)"}"#))
    #expect(store.agents[id] == nil)
    #expect(!store.currentAgents.contains { $0.id == id })
}

@Test @MainActor func closingLastTabClearsViewWithoutDeletingCanvas() async throws {
    let store = CanvasStore(api: APIClient(base: URL(string: "http://127.0.0.1:1")!))
    let canvas = try JSONDecoder().decode(Canvas.self, from: fixture("canvas"))
    store.load(canvas)
    await store.closeTab(canvas.id, next: nil)
    #expect(store.currentId == nil)
    #expect(store.currentAgents.isEmpty)
    #expect(store.closedTabs.contains(canvas.id))
    #expect(store.error == nil)
    // Reloading the retained canvas restores all agents, rather than recreating them.
    store.load(canvas)
    #expect(store.currentAgents.count == canvas.agents.count)
}

@Test @MainActor func closingBackgroundTabKeepsCurrentCanvas() async throws {
    let store = CanvasStore(api: APIClient(base: URL(string: "http://127.0.0.1:1")!))
    let canvas = try JSONDecoder().decode(Canvas.self, from: fixture("canvas"))
    store.load(canvas)
    await store.closeTab("background", next: nil)
    #expect(store.currentId == canvas.id)
    #expect(store.currentAgents.count == canvas.agents.count)
    #expect(store.closedTabs.contains("background"))
}

@MainActor @Test func everyRecordedMessageReachesTheChat() throws {
    let store = CanvasStore(api: APIClient(base: URL(string: "http://127.0.0.1:1")!))
    store.load(try JSONDecoder().decode(Canvas.self, from: fixture("canvas")))
    let id = try #require(store.currentAgents.first?.id)
    var seen: [String] = []
    store.onEvent = { ev in
        if ev.type == "message", let m = try? JSONSerialization.jsonObject(with: ev.data) as? [String: Any] { seen.append(m["kind"] as? String ?? "") }
    }
    // the person's own message, a failure, a restore and a turn's changes are shown too, not only answers
    for kind in ["user", "error", "restore", "changes", "assistant"] {
        let from = kind == "user" || kind == "restore" ? "user" : id, to = from == "user" ? id : "user"
        store.apply(ServerEvent(seq: 1, type: "message", data: Data(#"{"from":"\#(from)","to":"\#(to)","kind":"\#(kind)","text":"x"}"#.utf8)))
    }
    #expect(seen == ["user", "error", "restore", "changes", "assistant"])
    #expect(store.agents[id]?.lastText == "x")
}
