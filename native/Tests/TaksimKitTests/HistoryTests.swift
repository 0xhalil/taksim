import Foundation
import Testing
@testable import TaksimKit

/// Past conversations as the sidebar lists them: decoded from the engine, dated as the Claude app dates them.
@Suite struct HistoryTests {
    @Test func decodesBothKinds() throws {
        let json = #"{"conversations":[{"id":"a1","title":"plan it","name":"Planner","backend":"claude","folder":"web","lastAt":1700000000000,"canvas":{"id":"c1","name":"work"}},{"id":"cc-5e55","source":"claude-code","title":"Walrus rename","name":"Claude Code","backend":"claude","lastAt":1700000001000}]}"#
        struct L: Decodable { var conversations: [PastConversation] }
        let l = try JSONDecoder().decode(L.self, from: Data(json.utf8))
        #expect(l.conversations.map(\.id) == ["a1", "cc-5e55"])
        #expect(l.conversations[0].canvas?.name == "work")
        #expect(l.conversations[1].source == "claude-code")
    }

    @Test func datesLikeTheClaudeApp() {
        LangState.testGate.lock(); defer { LangState.testGate.unlock() }
        let was = LangState.shared.current
        LangState.shared.current = .english
        defer { LangState.shared.current = was }
        let now = Date()
        let ms = { (d: Date) in d.timeIntervalSince1970 * 1000 }
        #expect(PastConversation.when(ms(now.addingTimeInterval(-20)), now: now) == "now")
        #expect(PastConversation.when(ms(now.addingTimeInterval(-300)), now: now) == "5 min")
        let yesterday = Calendar.current.date(byAdding: .day, value: -1, to: now)!
        #expect(PastConversation.when(ms(yesterday), now: now) == "Yesterday")
        let fourDays = Calendar.current.date(byAdding: .day, value: -4, to: now)!
        #expect(PastConversation.when(ms(fourDays), now: now) == "4 days")
        #expect(PastConversation.when(nil) == "")
    }
}
