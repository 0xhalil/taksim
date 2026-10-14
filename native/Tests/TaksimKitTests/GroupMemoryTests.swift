import Testing
@testable import TaksimKit

@Suite struct GroupMemoryTests {
    @Test func splitsLikeTheEngine() {
        let text = "# Proje\nTürkçe yanıt ver.\n\n- a\n  - a1\n- b\n\nSon."
        #expect(GroupMemory.split(text) == ["# Proje\nTürkçe yanıt ver.", "- a\n  - a1", "- b", "Son."])
        #expect(GroupMemory.join(GroupMemory.split(text)) == text)
        #expect(GroupMemory.split("Giriş:\n- x\n- y") == ["Giriş:\n- x\n- y"])
        #expect(GroupMemory.join(["a", "  ", "- x", "- y"]) == "a\n\n- x\n- y")
    }
}
