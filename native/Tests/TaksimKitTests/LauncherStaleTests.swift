import Foundation
import Testing
@testable import TaksimKit

/// Against a running engine: TAKSIM_STALE_TEST=<port>. A fresh engine isn't stale; one started before the
/// newest change under src/ is. Skipped otherwise.
@Suite struct LauncherStaleTests {
    @Test func aFreshEngineIsNotStale() async throws {
        guard let port = ProcessInfo.processInfo.environment["TAKSIM_STALE_TEST"].flatMap(Int.init) else { return }
        let l = ServerLauncher(port: port, root: ServerLauncher.defaultRoot())
        #expect(await l.isStale() == false)
        #expect(ServerLauncher.newestChange(l.root.appending(path: "src")) > 0)
    }
}
