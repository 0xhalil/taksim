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

    @Test func groupsByDateAsTheClaudeAppDoes() {
        LangState.testGate.lock(); defer { LangState.testGate.unlock() }
        let was = LangState.shared.current
        LangState.shared.current = .english
        defer { LangState.shared.current = was }
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "UTC")!
        let now = cal.date(from: DateComponents(year: 2026, month: 10, day: 24, hour: 15))!
        func at(_ days: Int, _ id: String) -> PastConversation {
            PastConversation(id: id, title: id, name: id, lastAt: cal.date(byAdding: .day, value: -days, to: now)!.timeIntervalSince1970 * 1000)
        }
        let s = PastConversation.sections([at(40, "old"), at(0, "now"), at(3, "week"), at(1, "yday"), at(12, "month"), at(400, "lastyear")],
                                          by: .date, sort: .lastActive, now: now, calendar: cal)
        #expect(s.map(\.title) == ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "September", "September 2025"])
        #expect(s.flatMap { $0.items.map(\.id) } == ["now", "yday", "week", "month", "old", "lastyear"])
    }

    @Test func groupsByProjectNewestFirstAndSortsByStart() {
        let a = PastConversation(id: "a", title: "a", name: "a", folder: "web", lastAt: 300, cwd: "/w/web", createdAt: 10)
        let b = PastConversation(id: "b", title: "b", name: "b", folder: "api", lastAt: 200, cwd: "/w/api", createdAt: 30)
        let c = PastConversation(id: "c", title: "c", name: "c", folder: "web", lastAt: 100, cwd: "/w/web", createdAt: 20)
        let d = PastConversation(id: "d", title: "d", name: "d", lastAt: 400)
        let byProject = PastConversation.sections([a, b, c, d], by: .project, sort: .lastActive)
        #expect(byProject.map(\.title) == ["web", "api", "No folder"] || byProject.map(\.title) == ["web", "api", "Klasörsüz"])
        #expect(byProject[0].items.map(\.id) == ["a", "c"])
        let byStart = PastConversation.sections([a, b, c, d], by: .project, sort: .created)
        #expect(byStart.map(\.id) == ["p:/w/api", "p:/w/web", "p:"])
        #expect(byStart[1].items.map(\.id) == ["c", "a"])
    }

    @Test func aDraggedRowCarriesItsId() {
        let c = PastConversation(id: "cc-5e55", title: "t", name: "n")
        #expect(PastConversation.id(fromDrag: c.dragPayload) == "cc-5e55")
        #expect(PastConversation.id(fromDrag: "some-tab-id") == nil)
    }
}
