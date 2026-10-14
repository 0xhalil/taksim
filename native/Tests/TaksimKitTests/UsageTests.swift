import Foundation
import Testing
@testable import TaksimKit

@Suite struct UsageTests {
    @Test func decodesWhatTheEngineSends() throws {
        let json = #"{"usage":{"machine:claude":{"windows":[{"id":"5h","used":0.82,"resetsAt":1791560224374},{"id":"week","used":0.41,"resetsAt":null},{"id":"extra","used":0.12}],"limited":false,"checkedAt":1,"source":"claude"},"gone":null}}"#
        let l = try JSONDecoder().decode(UsageList.self, from: Data(json.utf8))
        let u = try #require(l.usage["machine:claude"] ?? nil)
        #expect(u.main.map(\.id) == ["5h", "week"])
        #expect(u.peak?.id == "5h")
        #expect(u.level == .high)
        #expect(Usage(windows: [.init(id: "5h", used: 0.3)], limited: true).level == .full)
        #expect(Usage(windows: [.init(id: "3d", used: 0.1)]).main.map(\.id) == ["3d"])
    }

    @Test func namesPercentsAndResets() {
        LangState.testGate.lock()
        defer { LangState.shared.current = .english; LangState.testGate.unlock() }
        LangState.shared.current = .english
        #expect(Usage.name("week") == "Week")
        #expect(Usage.name("3d") == "3 days")
        #expect(Usage.percent(0.825) == "%83")
        let now = Date(timeIntervalSince1970: 1000)
        let at = { (s: Double) in (1000 + s) * 1000 }
        #expect(Usage.until(at(42 * 60), now: now) == "42 min")
        #expect(Usage.until(at(3 * 3600 + 10 * 60), now: now) == "3 hr 10 min")
        #expect(Usage.until(at(3 * 86400), now: now) == "3 days")
        #expect(Usage.until(at(-5), now: now) == nil)
        LangState.shared.current = .turkish
        #expect(Usage.name("week") == "Hafta")
        #expect(Usage.name("3d") == "3 gün")
        #expect(Usage.until(at(42 * 60), now: now) == "42 dk")
        #expect(Usage.until(at(3 * 86400), now: now) == "3 gün")
    }
}
