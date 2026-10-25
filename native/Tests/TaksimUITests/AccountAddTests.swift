import Foundation
import Testing
@testable import Taksim
import TaksimKit

/// Adding an account end to end against an engine with the test CLI: TAKSIM_ACCOUNTS_TEST=http://127.0.0.1:<port>
/// (TAKSIM_FAKE=1, its own TAKSIM_HOME). Skipped otherwise. One click signs it in and names it by its email; the same
/// login added again leaves one account and points at it.
@Suite(.serialized) struct AccountAddTests {
    @Test @MainActor func welcomeSelectsExactAccount() throws {
        let m = AccountsModel(api: APIClient(base: URL(string: "http://127.0.0.1:1")!))
        m.backends = [.init(name: "codex", label: "ChatGPT", installed: true)]
        m.machine = ["codex": .init(loggedIn: true, email: "personal@example.com")]
        m.accounts = [.init(id: "work", name: "Work", backend: "codex", dir: "/isolated", status: .init(loggedIn: true, email: "work@example.com"))]
        m.selected = "work"
        #expect(m.readyChoice?.account == "work")
        m.accounts = []
        #expect(m.readyChoice?.id == "machine:codex")
        #expect(m.readyChoice?.account == nil)
        m.machine = [:]
        #expect(m.readyChoice == nil)
    }

    @Test @MainActor func addingSignsInNamesByEmailAndKeepsOneOfTheSameLogin() async throws {
        guard let url = ProcessInfo.processInfo.environment["TAKSIM_ACCOUNTS_TEST"].flatMap(URL.init(string:)) else { return }
        let m = AccountsModel(api: APIClient(base: url))
        await m.load()
        for a in m.accounts where a.backend == "fake" && a.dir != nil { await m.remove(a.id) }
        await m.add(backend: "fake", name: m.freeName("test"))
        let first = try #require(m.accounts.first { $0.backend == "fake" && $0.dir != nil })
        #expect(first.name == "test@example.com")
        await m.add(backend: "fake", name: m.freeName("test"))
        #expect(m.accounts.filter { $0.backend == "fake" && $0.dir != nil }.count == 1, "the same login isn't added twice")
        #expect(m.pointed == first.id)
        await m.remove(first.id)
    }
}
