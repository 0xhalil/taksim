import Foundation
import Testing
@testable import TaksimKit

/// Another program on the engine's port (a Cloudflare worker's dev server takes 8787) doesn't stop the app: the
/// engine moves to the next free port. The full start runs with TAKSIM_PORT_TEST=1 (it starts an engine).
@Suite(.serialized) struct LauncherPortTests {
    /// a listening socket on a free port, held until `close`
    private func hold() throws -> (port: Int, fd: Int32) {
        let port = try #require((18900...18999).first(where: ServerLauncher.isFree))
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(port).bigEndian)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        #expect(bound == 0 && listen(fd, 1) == 0)
        return (port, fd)
    }

    @Test func aHeldPortIsNotFree() throws {
        let (port, fd) = try hold()
        #expect(!ServerLauncher.isFree(port))
        close(fd)
        #expect(ServerLauncher.isFree(port))
    }

    @Test func theEngineMovesOffAPortAnotherProgramHolds() async throws {
        guard ProcessInfo.processInfo.environment["TAKSIM_PORT_TEST"] != nil else { return }
        let (port, fd) = try hold()
        defer { close(fd) }
        let l = ServerLauncher(port: port, root: ServerLauncher.defaultRoot(), movable: true)
        try await l.ensure()
        #expect(l.port != port)
        #expect(await l.health() == "taksim")
        l.stop()

        let fixed = ServerLauncher(port: port, root: ServerLauncher.defaultRoot())
        await #expect(throws: (any Error).self) { try await fixed.ensure() }
        fixed.stop()
    }
}
