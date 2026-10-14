import Foundation
import Testing
@testable import TaksimKit

@Suite struct PanelInputsTests {
    @Test func inputsAndButtonsComeThroughAndBack() throws {
        let j = try JSONValue.parse(#"""
        {"spec":{"title":"Pods","sources":{"p":{"brick":"command","run":["kubectl","-n","{{in.ns}}"]}},
          "views":[{"id":"pods","brick":"table","source":"p","filter":{"input":"q"}},{"id":"log","brick":"log","source":"p","when":"pod"}],
          "inputs":{"ns":{"kind":"select","options":["default","prod"],"label":"namespace"},"q":{"kind":"text"},
                    "pod":{"kind":"row","view":"pods","field":"name"},"live":{"kind":"toggle"},
                    "ctx":{"kind":"select","options":{"source":"p","field":"context"}}},
          "actions":[{"label":"Restart","run":["kubectl","rollout","restart"]}]},
         "ui":{},"status":"running","pending":[],"sources":{},"inputs":{"ns":"prod","q":"","pod":null,"live":true}}
        """#.data(using: .utf8)!)
        let p = Panel(json: j)
        let spec = try #require(p.spec)
        #expect(spec.inputs.map(\.name) == ["ns", "q", "pod", "live", "ctx"])
        #expect(spec.inputs[0].options == ["default", "prod"] && spec.inputs[0].label == "namespace")
        #expect(spec.inputs[2].view == "pods" && spec.inputs[2].field == "name")
        #expect(spec.inputs[4].optionsFrom?.source == "p" && spec.inputs[4].optionsFrom?.field == "context")
        #expect(spec.actions.count == 1)
        #expect(p.value("ns") == "prod" && p.value("pod") == "" && p.value("live") == "true")
        // the spec goes back to the server whole (an edit keeps its inputs and buttons)
        let back = PanelSpec(json: spec.json)
        #expect(back.inputs == spec.inputs && back.actions == spec.actions)
    }
}
