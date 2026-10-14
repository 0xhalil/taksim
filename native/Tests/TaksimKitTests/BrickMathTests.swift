import Foundation
import Testing
@testable import TaksimKit

// The same cases as test/panels.test.mjs for the helpers of ui/canvas/bricks.mjs, so the native bricks read
// data exactly as the page does.

private func view(_ json: String) -> BrickSpec { BrickSpec(json: try! JSONValue.parse(json))! }
private func data(_ json: String) -> JSONValue { try! JSONValue.parse(json) }
private let iso: (String) -> Double = { Bricks.dateParse($0) }

@Test func pathsReachKeysWithDotsInBrackets() {
    let row = data(#"{"metadata":{"labels":{"cloud.googleapis.com/location":"europe-west1"}},"items":[{"a":1}]}"#)
    #expect(Bricks.get(row, "metadata.labels[cloud.googleapis.com/location]") == .string("europe-west1"))
    #expect(Bricks.get(row, "items.0.a") == .number(1))
    #expect(Bricks.pathKeys("a[b.c].d") == ["a", "b.c", "d"])
}

@Test func numbersDurationsAndTimesAreReadTheWayCLIsPrintThem() {
    LangState.testGate.lock()
    defer { LangState.shared.current = .english; LangState.testGate.unlock() }
    LangState.shared.current = .english
    #expect(Bricks.parseNum(.string("250m")) == 0.25)
    #expect(Bricks.parseNum(.string("512Mi")) == 512 * 1024 * 1024)
    #expect(Bricks.parseNum(.string("1.5GB")) == 1.5e9)
    #expect(Bricks.parseNum(.string("37%")) == 37)
    #expect(Bricks.parseNum(.string("14 (2m ago)")) == 14)
    #expect(Bricks.parseNum(.string("Running")).isNaN)
    #expect(Bricks.parseDuration(.string("1m30s")) == 90)
    #expect(Bricks.parseDuration(.string("2d3h")) == 2 * 86400 + 3 * 3600)
    #expect(Bricks.parseDuration(.string("01:02:03")) == 3723)
    let now = iso("2026-10-07T12:00:00Z")
    #expect(Bricks.parseTime(.string("47m"), now: now) == now - 47 * 60000)
    #expect(Bricks.parseTime(.string("2h ago"), now: now) == now - 2 * 3_600_000)
    #expect(Bricks.parseTime(.string("2026-10-07T11:00:00Z"), now: now) == now - 3_600_000)
    #expect(Bricks.parseTime(.number(1_791_374_400), now: now) == 1_791_374_400_000)
    #expect(Bricks.parseTime(.string("1791374400000"), now: now) == 1_791_374_400_000)
    #expect(Bricks.parseTime(.string("now"), now: now) == now)
    #expect(Bricks.parseTime(.string("<unknown>"), now: now).isNaN)
    #expect(Bricks.fmtDur(45000) == "45 sec")
    #expect(Bricks.fmtDur(125 * 60000) == "2 hr 5 min")
    #expect(Bricks.fmtDur(76 * 3_600_000) == "3 d 4 hr")
    LangState.shared.current = .turkish
    #expect(Bricks.fmtDur(45000) == "45 sn")
    #expect(Bricks.fmtDur(125 * 60000) == "2 sa 5 dk")
    #expect(Bricks.fmtDur(76 * 3_600_000) == "3 g 4 sa")
    #expect([0.25, 12.345, 230.4, 12345, 4.1e6].map(Bricks.fmtNum) == ["0.25", "12.3", "230", "12.3k", "4.1M"])
    let ticks = Bricks.timeTicks(now - 300_000, now, max: 5)
    #expect(ticks.count >= 3 && ticks.count <= 6 && ticks.allSatisfy { $0.truncatingRemainder(dividingBy: 60000) == 0 })
    // day steps sit on local midnight
    let days = Bricks.timeTicks(now - 20 * 86_400_000, now, max: 5)
    #expect(days.allSatisfy { Calendar.current.component(.hour, from: Date(timeIntervalSince1970: $0 / 1000)) == 0 })
    #expect([0, 0.8, 1.2, 2.2, 3, 7, 80].map(Bricks.niceMax) == [1, 1, 2, 2.5, 5, 10, 100])
}

@Test func chartARefreshBecomesOneNumberPerSeries() {
    let pods = data(#"[{"cpu":"200m"},{"cpu":"300m"},{"cpu":"1"}]"#)
    #expect(Bricks.measure(pods, view(#"{"brick":"chart"}"#)) == [3])
    #expect(Bricks.measure(pods, view(#"{"brick":"chart","y":"cpu"}"#)) == [1.5])
    #expect(Bricks.measure(pods, view(#"{"brick":"chart","y":"cpu","agg":"max"}"#)) == [1])
    #expect(Bricks.measure(data(#"[{"text":"0.131"}]"#), view(#"{"brick":"chart","y":"text","scale":1000}"#)) == [131])
    #expect(Bricks.measure(data(#"{"a":{"b":"7"},"n":[1,2]}"#), view(#"{"brick":"chart","y":["a.b","n"]}"#)) == [7, 2])
    #expect(Bricks.measure(.string("12"), view(#"{"brick":"chart"}"#)) == [12])
    #expect(Bricks.measure(data(#"[{"x":"-"}]"#), view(#"{"brick":"chart","y":"x","agg":"avg"}"#))[0].isNaN)
    let days = data(#"[{"day":"2026-10-06"},{"day":"2026-10-05"},{"day":"2026-10-06"}]"#)
    let p = Bricks.points(days, view(#"{"brick":"chart","x":"day"}"#))
    #expect(p.map(\.t) == [iso("2026-10-05"), iso("2026-10-06")])
    #expect(p.map { $0.v[0] } == [1, 2])
}

@Test func barsRankAndTimelineIntervalsStayOpenWhileRunning() {
    let r = Bricks.ranked(data(#"[{"who":"ayse"},{"who":"mert"},{"who":"ayse"},{}]"#), view(#"{"brick":"bars","label":"who"}"#))
    #expect(r.map(\.label) == ["ayse", "mert", "—"] && r.map(\.value) == [2, 1, 1])
    let cpu = Bricks.ranked(data(#"[{"n":"a","c":"250m"},{"n":"b","c":"1200m"}]"#), view(#"{"brick":"bars","label":"n","value":"c","limit":1}"#))
    #expect(cpu == [Bricks.Ranked(label: "b", value: 1.2, raw: "1200m")])
    #expect(Bricks.statusTone(.string("in_progress")) == "run")
    #expect(Bricks.statusTone(.string("CHANGES_REQUESTED")) == "err")
    #expect(Bricks.statusTone(.string("queued")) == "wait")
    #expect(Bricks.statusTone(.string("success")) == "ok")
    #expect(Bricks.statusTone(.string("cancelled")) == "idle")
    #expect(Bricks.statusTone(.string("Running (since 2m)")) == "run")
    let now = iso("2026-10-07T12:00:00Z")
    let runs = data(#"""
    [{"t":"build","s":"2026-10-07T11:50:00Z","e":"2026-10-07T11:57:00Z","conclusion":"failure","status":"completed"},
     {"t":"deploy","s":"2026-10-07T11:58:00Z","e":"2026-10-07T11:58:30Z","conclusion":"","status":"in_progress"},
     {"t":"pr","s":"3d","review":"REVIEW_REQUIRED"},
     {"t":"job","s":"10m","d":"2m30s"},
     {"t":"broken","s":"not a time"}]
    """#)
    let iv = Bricks.intervals(runs, view(#"{"brick":"timeline","start":"s","end":"e","duration":"d","label":"t","status":["conclusion","status","review"]}"#), now: now)
    #expect(iv.map(\.label) == ["build", "deploy", "pr", "job"])
    #expect(iv.map(\.tone) == ["err", "run", "wait", ""])
    #expect(iv.map(\.open) == [false, true, true, false])
    #expect(iv.map { $0.end.map { ($0 - 0) } == nil ? nil : ($0.end! - $0.start) / 1000 } == [420, nil, nil, 150])
}

@Test func logLinesTakeTheFirstPathAndShortLevels() {
    let v = view(#"{"brick":"log","text":["textPayload","jsonPayload.message"],"level":"severity"}"#)
    let l = Bricks.line(v, data(#"{"textPayload":"","jsonPayload":{"message":"hi"},"severity":"WARNING"}"#))
    #expect(l.text == "hi" && l.level == "warn" && l.tone == .warn)
    #expect(Bricks.line(v, data(#"{"textPayload":"x","severity":"ALERT"}"#)).tone == .bad)
}

@Test func tableRowsKeepTheirKeyAndRepeatsAreNumbered() {
    let rows = data(#"[{"n":"a","v":1},{"n":"b","v":2},{"n":"a","v":3},{"v":4}]"#).array!
    #expect(Bricks.keyed(rows, key: "n").map(\.id) == ["a", "b", "a\u{0}1", ""])
    #expect(Bricks.keyed(rows, key: "v").map(\.id) == ["1", "2", "3", "4"])
    #expect(Bricks.keyed(Array(repeating: .object(["n": .string("x")]), count: 600), key: "n").count == 500)
}

@Test func logAppendKeepsTheLinesItAlreadyHas() {
    // a tail that keeps 5 lines: two went at the top, two came at the bottom
    #expect(Bricks.appendOverlap(old: [1, 2, 3, 4, 5], new: [3, 4, 5, 6, 7]) == 3)
    // only new lines; nothing changed
    #expect(Bricks.appendOverlap(old: [1, 2], new: [1, 2, 3]) == 2)
    #expect(Bricks.appendOverlap(old: [1, 2, 3], new: [1, 2, 3]) == 3)
    // everything replaced, or a start
    #expect(Bricks.appendOverlap(old: [1, 2, 3], new: [7, 8]) == 0)
    #expect(Bricks.appendOverlap(old: [Int](), new: [1]) == 0)
    #expect(Bricks.appendOverlap(old: [1], new: [Int]()) == 0)
    // the old last line appears more than once: only a real overlap counts, the longest one
    #expect(Bricks.appendOverlap(old: [1, 2, 5], new: [5, 9, 2, 5, 6]) == 1)
    #expect(Bricks.appendOverlap(old: [1, 5, 5], new: [5, 5, 7]) == 2)
    #expect(Bricks.appendOverlap(old: [1, 2, 5], new: [2, 9, 5]) == 0)
    // repeated lines: the old lines kept plus the ones after the overlap are the new list
    let old = [1, 1, 1], new = [1, 1, 1, 1]
    let k = Bricks.appendOverlap(old: old, new: new)
    #expect(Array(old.suffix(k)) + Array(new.dropFirst(k)) == new)
}
