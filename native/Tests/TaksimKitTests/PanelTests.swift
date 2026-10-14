import Foundation
import Testing
@testable import TaksimKit

// Panels: the view the server sends (panel.mjs view()), the panel stream, and what bricks do with data
// (bricks.mjs), on payloads shaped like the server's.

let pendingPanel = #"""
{"spec":{"title":"Servisler","sources":{"up":{"brick":"command","run":["uptime"],"every_s":5},"pods":{"brick":"agent"}},
 "views":[{"id":"n","brick":"stat","source":"pods","title":"Pod","span":1},
  {"id":"pods","brick":"table","source":"pods","columns":["name",{"field":"status.phase","label":"Durum"}],
   "row_actions":[{"label":"Neden?","ask":"Why is {name} {status}?"},{"label":"Yeniden","run":["echo","restart","{name}"],"refresh":true}],"span":4},
  {"id":"c","brick":"chart","source":"pods","y":"v","window_s":60,"span":9}]},
 "ui":{"collapsed":false,"maximized":true,"size":[600,420]},"tool":null,"status":"pending",
 "pending":[{"at":"sources.up","kind":"command","argv":["uptime"],"every_s":5,"stream":false},
  {"at":"views.pods","kind":"action","label":"Yeniden","argv":["echo","restart","{name}"]}],
 "sources":{"pods":{"error":null,"updatedAt":1791328167812},"up":{"error":"boom","updatedAt":1}}}
"""#

@Test func decodesAPanelView() throws {
    LangState.testGate.lock()
    defer { LangState.shared.current = .english; LangState.testGate.unlock() }
    let p = try JSONDecoder().decode(Panel.self, from: Data(pendingPanel.utf8))
    #expect(p.status == "pending" && !p.isRunning)
    #expect(p.spec?.title == "Servisler")
    #expect(p.spec?.views.map(\.brick) == ["stat", "table", "chart"])
    #expect(p.spec?.views[2].span == 4) // clamped
    #expect(p.spec?.views[2].number("window_s") == 60) // a brick's own fields stay readable
    #expect(p.ui.maximized && p.ui.size == [600, 420])
    #expect(p.tool == nil)
    #expect(p.hasError)
    let table = try #require(p.spec?.views[1])
    #expect(table.columns()?.map(\.label) == ["name", "Durum"])
    #expect(table.rowActions.count == 2)
    #expect(table.rowActions[1].isRun && table.rowActions[1].refresh)
    #expect(p.pending.map(\.text) == ["uptime", "echo restart {name}"])
    LangState.shared.current = .english
    #expect(p.pending[0].cadence == "5 sec")
    LangState.shared.current = .turkish
    #expect(p.pending[0].cadence == "5 sn")
}

@Test func anAgentCarriesItsPanelAndAMalformedOneDoesNotDropIt() throws {
    let json = #"{"id":"a1","name":"ops","panel":{"spec":{"views":[{"brick":"log"},7]},"ui":{"size":"big"},"status":3}}"#
    let a = try JSONDecoder().decode(Agent.self, from: Data(json.utf8))
    #expect(a.panel?.spec?.title == "Panel")
    #expect(a.panel?.spec?.views.map(\.id) == ["v1"])
    #expect(a.panel?.ui.size == [560, 400])
    #expect(a.panel?.status == "running")
    let none = try JSONDecoder().decode(Agent.self, from: Data(#"{"id":"a2","name":"x","panel":null}"#.utf8))
    #expect(none.panel == nil)
}

@MainActor @Test func parsesThePanelStream() {
    var sse = RawSSEParser()
    let lines = [
        "event: snapshot",
        #"data: {"agent":"a1","sources":{"log":{"data":[{"text":"a"}],"error":null,"updatedAt":5}}}"#, "",
        ": ping", "",
        "event: data",
        #"data: {"agent":"a1","source":"log","mode":"append","data":[{"text":"b"},{"text":"c"}],"error":null,"updatedAt":6,"keep":2}"#, "",
        "event: data",
        #"data: {"agent":"a1","source":"n","mode":"replace","data":{"z":1,"a":2},"error":null,"updatedAt":7}"#, "",
        "event: data",
        #"data: {"agent":"a1","source":"n","mode":"error","data":null,"error":"exit 1","updatedAt":8}"#, "",
    ]
    let messages = lines.compactMap { sse.feed($0) }.compactMap { PanelMessage(event: $0.event, data: $0.data) }
    #expect(messages.count == 4)
    do {
        let feeds = PanelFeeds()
        for m in messages.prefix(3) { feeds.apply(m) }
        let f = feeds.feed("a1")
        // append keeps the last `keep` rows
        #expect(f["log"].data == .array([.object(["text": .string("b")]), .object(["text": .string("c")])]))
        #expect(f["log"].updatedAt == 6)
        // objects keep the server's key order
        #expect(f["n"].data.object?.keys == ["z", "a"])
        feeds.apply(messages[3])
        #expect(f["n"].error == "exit 1")
        #expect(f["n"].data.object?.keys == ["z", "a"]) // an error keeps the last data
    }
}

@Test func orderedJSONReadsEverything() throws {
    let v = try JSONValue.parse(#" {"b":[1,2.5,-3e2,true,false,null],"a":"\"x\"\nç😀","c":{}} "#)
    #expect(v.object?.keys == ["b", "a", "c"])
    #expect(v["b"] == .array([.number(1), .number(2.5), .number(-300), .bool(true), .bool(false), .null]))
    #expect(v["a"]?.string == "\"x\"\nç😀")
    #expect(throws: (any Error).self) { try JSONValue.parse("{\"a\":1,}") }
    #expect(Bricks.compact(v) == #"{"b":[1,2.5,-300,true,false,null],"a":"\"x\"\nç😀","c":{}}"#)
}

@Test func bricksReadDataAsTheWebDoes() throws {
    LangState.testGate.lock()
    defer { LangState.shared.current = .english; LangState.testGate.unlock() }
    LangState.shared.current = .english
    let rows = try JSONValue.parse(#"[{"name":"api","status":{"phase":"Running"},"n":"10"},{"name":"db","status":{"phase":"CrashLoopBackOff"},"n":9},{"name":"x","n":"100"}]"#)
    #expect(Bricks.show(Bricks.get(rows.array![0], "status.phase")) == "Running")
    #expect(Bricks.tone(.string("Running")) == .good)
    #expect(Bricks.tone(.string("CrashLoopBackOff")) == .bad) // "crash…" outranks "backoff", as in the web
    #expect(Bricks.tone(.string("Exited (1) 2 hours ago")) == .bad)
    #expect(Bricks.tone(.string("hello")) == .none)
    #expect(Bricks.show(.number(3)) == "3" && Bricks.show(.number(2.5)) == "2.5")
    #expect(Bricks.show(.string(String(repeating: "a", count: 200))).count == 160)
    // numbers sort as numbers even when they come as text
    #expect(Bricks.sorted(rows.array!, by: "n", descending: true).map { Bricks.show($0["name"]) } == ["x", "api", "db"])
    let table = try #require(BrickSpec(json: .object(["brick": .string("table")])))
    #expect(Bricks.columns(table, rows: rows.array!).map(\.field) == ["name", "status", "n"])

    let stat = try #require(BrickSpec(json: try JSONValue.parse(#"{"brick":"stat","value":"load","unit":"%","warn_above":70,"error_above":90}"#)))
    #expect(Bricks.stat(stat, try JSONValue.parse(#"{"load":76}"#)) == ("76 %", .warn))
    #expect(Bricks.stat(stat, try JSONValue.parse(#"{"load":12}"#)).tone == .good)
    #expect(Bricks.stat(stat, .null).text == "— %")
    let count = try #require(BrickSpec(json: .object(["brick": .string("stat")])))
    #expect(Bricks.stat(count, rows).text == "3")

    let log = try #require(BrickSpec(json: try JSONValue.parse(#"{"brick":"log","text":"msg","level":"level"}"#)))
    let l = Bricks.line(log, try JSONValue.parse(#"{"msg":"down","level":"ERROR"}"#))
    #expect(l.level == "error" && l.text == "down" && l.tone == .bad)

    #expect(Bricks.ago(nil) == "")
    LangState.shared.current = .english
    #expect(Bricks.ago(1000, now: Date(timeIntervalSince1970: 3)) == "now")
    #expect(Bricks.ago(0, now: Date(timeIntervalSince1970: 90)) == "2 min ago")
    LangState.shared.current = .turkish
    #expect(Bricks.ago(1000, now: Date(timeIntervalSince1970: 3)) == "şimdi")
    #expect(Bricks.ago(0, now: Date(timeIntervalSince1970: 90)) == "2 dk önce")
}

@Test func markdownIsSmallAndSafe() {
    let blocks = MD.parse("### Durum\n- [x] api **ok**\n- [ ] `worker`\n1. bir\n> not\n\nsatır *bir*\niki\n```\n<b>kod</b>\n```")
    #expect(blocks == [
        .heading(level: 3, [.text("Durum")]),
        .list(ordered: false, [MD.Item(spans: [.text("api "), .bold("ok")], checked: true), MD.Item(spans: [.code("worker")], checked: false)]),
        .list(ordered: true, [MD.Item(spans: [.text("bir")], checked: nil)]),
        .quote([.text("not")]),
        .paragraph([.text("satır "), .em("bir"), .text(" iki")]),
        .code("<b>kod</b>"),
    ])
}

@MainActor @Test func panelEventsAndOffersUpdateTheStore() throws {
    let store = CanvasStore(api: APIClient(base: URL(string: "http://127.0.0.1:1")!))
    store.load(try JSONDecoder().decode(Canvas.self, from: fixture("canvas")))
    let id = try #require(store.currentAgents.first?.id)
    func ev(_ type: String, _ data: String) -> ServerEvent { ServerEvent(seq: 1, type: type, data: Data(data.utf8)) }
    store.apply(ev("panel_updated", #"{"id":"\#(id)","panel":null}"#))

    store.apply(ev("tool_suggested", #"{"id":"\#(id)","tool":{"id":"k8s","name":"Pods","spec":{"title":"Pods","views":[{"brick":"table","source":"p"}]},"preview":{"data":{"p":[{"a":1}]}},"params":{"context":{"default":null},"ns":{"default":"x"}}}}"#))
    #expect(store.ghosts[id]?.name == "Pods")
    #expect(store.ghosts[id]?.missingParams == ["context"])
    #expect(store.ghosts[id]?.preview?["p"] != nil)

    store.apply(ev("panel_updated", "{\"id\":\"\(id)\",\"panel\":\(pendingPanel)}"))
    #expect(store.agents[id]?.panel?.status == "pending")
    #expect(store.ghosts[id] == nil) // the panel took the offer's place

    store.apply(ev("panel_updated", #"{"id":"\#(id)","panel":null}"#))
    #expect(store.agents[id]?.panel == nil)
}
