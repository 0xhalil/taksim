import Foundation
import Testing
@testable import TaksimKit

// The same cases as test/panels.test.mjs "scene: …" for src/bricks/scene.mjs, so the port means the same thing.

private func json(_ s: String) -> JSONValue { try! JSONValue.parse(s) }
private func ev(_ e: String, row: String? = nil, vars: [String: Double] = [:]) throws -> JSONValue? {
    try SceneMath.evaluate(e, SceneMath.Scope(row: row.map(json), nums: vars))
}

@Test func sceneExpressionsWithoutEval() throws {
    #expect(try ev("i*40+20", vars: ["i": 2]) == .number(100))
    #expect(try ev("i-1", vars: ["i": 2]) == .number(1))
    #expect(try ev("max(a, b) / 2", row: #"{"a":3,"b":8}"#) == .number(4))
    #expect(try ev("STATUS == 'Running' ? 'ok' : 'err'", row: #"{"STATUS":"Failed"}"#) == .string("err"))
    #expect(try ev("labels[app.kubernetes.io/name]", row: #"{"labels":{"app.kubernetes.io/name":"api"}}"#) == .string("api"))
    #expect(throws: SceneMath.Failure.self) { try ev("process.exit()", row: "{}") }
    do { _ = try ev("process.exit()", row: "{}") } catch let e as SceneMath.Failure { #expect(e.message.contains("unexpected")) }
    #expect(try SceneMath.fill(.string("{name}: {n}"), .init(row: json(#"{"name":"api","n":3}"#))) == .string("api: 3"))
    #expect(try SceneMath.fill(.string("{n/max*100}"), .init(row: json(#"{"n":5}"#), nums: ["max": 10])) == .number(50), "a lone expression stays a number")
    // a few more of JavaScript's rules
    #expect(try ev("n > 2 ? 'big' : 'small'", row: #"{"n":"3"}"#) == .string("big"))
    #expect(try ev("'a' + 1") == .string("a1"))
    #expect(try ev("round(2.5) + floor(1.9) + ceil(0.1) + abs(-1) + sqrt(4) + log(100)") == .number(10))
    #expect(try ev("i", row: #"{"i":7}"#, vars: ["i": 1]) == .number(7), "the row's field wins over a var")
    #expect(try SceneMath.fill(.string("{x/3}"), .init(nums: ["x": 1])) == .number(1.0 / 3))
    #expect(try SceneMath.fill(.string("v={x/3}"), .init(nums: ["x": 1])) == .string("v=0.33"))
}

@Test func sceneRowsDataFramesAndTheTimeline() throws {
    let view = json(#"""
    { "source": "q", "size": [300, 100], "shapes": [{"id": "title", "type": "text", "x": 10, "y": 14, "text": "Kuyruk"}],
      "each": {"key": "name", "value": "n", "shapes": [{"id": "bar", "type": "rect", "x": "{i*60+10}", "y": "{100-n/max*80}", "w": 40, "h": "{n/max*80}", "fill": "status:{state}"}]},
      "steps": [{"do": "write", "target": "title"}, {"do": "grow", "target": "bar"}, {"do": "wait", "dur": 1}, {"do": "indicate", "target": "b", "at": 3}] }
    """#)
    let shapes = try SceneMath.expand(view, json(#"[{"name":"a","n":2,"state":"Running"},{"name":"b","n":4,"state":"Failed"},{"name":"b","n":1,"state":"Pending"}]"#))
    #expect(shapes.map(\.id) == ["title", "a/bar", "b/bar", "b#2/bar"], "repeated keys stay unique")
    #expect(shapes.dropFirst().map { [$0.num("x"), $0.num("y"), $0.num("h")] } == [[10, 60, 40], [70, 20, 80], [130, 80, 20]])
    #expect(shapes.dropFirst().map { SceneMath.colorToken($0["fill"]) } == ["accent", "err", "wait"], "status words color by meaning")

    let plan = SceneMath.schedule(view, shapes)
    #expect(plan.steps.map(\.verb) == ["write", "grow", "wait", "indicate"])
    #expect(plan.steps.map { [$0.start, $0.end] } == [[0, 0.6], [0.6, 1.2], [1.2, 2.2], [3, 3.6]])
    #expect(plan.steps[1].targets == ["a/bar", "b/bar", "b#2/bar"], "a target names the shape inside each, for every row")
    #expect(plan.steps[3].targets == ["b/bar"], "or one row by its key")
    #expect(plan.hidden.contains("title") && plan.hidden.contains("a/bar"), "what is created later starts hidden")
    #expect(plan.length == 3.6)

    let data = json(#"{"x": {"min": 0, "max": 10}, "y": {"min": 0, "max": 100}, "size": [200, 100], "shapes": [{"type": "rect", "data": true, "x": 5, "y": 0, "w": 1, "h": 50}]}"#)
    let d = try SceneMath.expand(data, nil)[0]
    #expect([d.num("x"), d.num("y"), d.num("w"), d.num("h")] == [100, 50, 20, 50], "data units: y grows up")
    #expect(d["data"] == nil)
    #expect(SceneMath.ease("smooth", 0.5) == 0.5)
}

@Test func sceneColorsAndEases() {
    #expect(SceneMath.colorToken(nil) == "ink")
    #expect(SceneMath.colorToken(.string("purple"), fallback: "muted") == "muted")
    #expect(SceneMath.colorToken(.string("s2")) == "s2")
    #expect(SceneMath.colorToken(.string("status:succeeded")) == "ok")
    #expect(SceneMath.ease("linear", 0.3) == 0.3)
    #expect(abs(SceneMath.ease("spring", 1) - 1) < 1e-12 && SceneMath.ease("spring", 0.7) > 1, "spring overshoots")
    #expect(SceneMath.ease("smooth", 0) == 0 && SceneMath.ease("smooth", 1) == 1)
}
