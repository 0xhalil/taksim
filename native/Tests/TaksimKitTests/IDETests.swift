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
}
