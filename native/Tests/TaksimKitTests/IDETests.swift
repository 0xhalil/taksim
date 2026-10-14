import Foundation
import Testing
@testable import TaksimKit

@Suite struct IDETests {
    @Test func goToFileRanksNameMatchesFirst() {
        let paths = ["src/canvas/agent.mjs", "src/agents.md", "native/Sources/Taksim/AgentSheet.swift", "test/x.mjs"]
        #expect(FuzzyPath.rank("agsh", paths).first == "native/Sources/Taksim/AgentSheet.swift")
        #expect(FuzzyPath.rank("agent.mjs", paths).first == "src/canvas/agent.mjs")
        #expect(FuzzyPath.score("zz", "src/a.mjs") == nil)
    }

    @Test func stateReadsTheServersView() {
        let j = try! JSONValue.parse(#"{"tabs":["a.py"],"active":"a.py","notes":[{"id":"n1","path":"a.py","line":3,"endLine":4,"text":"bug","severity":"error","at":1}],"root":"/x","rootName":"x","ui":{}}"#.data(using: .utf8)!)
        let s = IDEState(json: j)
        #expect(s.tabs == ["a.py"] && s.notes?.first?.severity == "error" && s.rootName == "x")
    }

    @Test func spliceReplacesTheShownLinesAndRefusesStaleOnes() {
        let text = "a\nb\nc\nd"
        #expect(IDESplice.apply(text, from: 2, to: 3, original: "b\nc", replacement: "B\nX\nC") == "a\nB\nX\nC\nd")
        #expect(IDESplice.apply(text, from: 2, to: 3, original: "b\nc", replacement: "") == "a\nd")
        #expect(IDESplice.apply(text, from: 2, to: 2, original: "zz", replacement: "B") == nil)
        #expect(IDESplice.apply(text, from: 4, to: 9, original: "d", replacement: "D") == nil)
    }

    @Test func answersAndEditsDecode() throws {
        let a = try JSONDecoder().decode(IDEAnswer.self, from: Data(#"{"answer":"here","hits":[{"path":"a.py","line":5,"endLine":6,"why":"x"}]}"#.utf8))
        #expect(a.hits.first?.id == "a.py:5" && a.hits.first?.endLine == 6)
        let e = try JSONDecoder().decode(IDEEditResult.self, from: Data(#"{"path":"a.py","from":1,"to":2,"original":"o","replacement":"r","by":"m"}"#.utf8))
        #expect(e.replacement == "r")
    }
}
