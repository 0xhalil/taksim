import Testing
@testable import TaksimKit

@Suite struct TabNameTests {
    @Test func newTabsCountOnlyTheOpenOnes() {
        LangState.testGate.lock()
        defer { LangState.shared.current = .english; LangState.testGate.unlock() }
        LangState.shared.current = .english
        #expect(CanvasStore.nextTabName(open: []) == "canvas 1")
        #expect(CanvasStore.nextTabName(open: ["canvas 1", "ops"]) == "canvas 3")
        #expect(CanvasStore.nextTabName(open: ["tuval 2"]) == "canvas 3")
        LangState.shared.current = .turkish
        #expect(CanvasStore.nextTabName(open: []) == "tuval 1")
    }
}
