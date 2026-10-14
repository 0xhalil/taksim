import Foundation
import Testing
@testable import Taksim
import TaksimKit

/// Against a running demo server: TAKSIM_IDE_TEST=<base url> <canvas> <agent> (an agent whose IDE has a.py-like
/// files). Skipped otherwise.
@Suite struct IDEModelLiveTests {
    @Test @MainActor func editsSaveThemselvesAndAConflictWaits() async throws {
        guard let spec = ProcessInfo.processInfo.environment["TAKSIM_IDE_TEST"]?.split(separator: " "), spec.count == 4 else { return }
        let client = IDEClient(api: APIClient(base: URL(string: String(spec[0]))!), canvas: String(spec[1]), agent: String(spec[2]))
        let path = String(spec[3])
        let m = IDEModel(agent: String(spec[2]), client: client)
        m.open(path)
        for _ in 0..<40 where m.buffers[path] == nil { try await Task.sleep(for: .milliseconds(50)) }
        let before = try #require(m.buffers[path]?.text)
        m.edit(path, before + "# native\n")
        try await Task.sleep(for: .seconds(1.2))
        #expect(try await client.read(path).content == before + "# native\n")
        #expect(m.buffers[path]?.dirty == false)
        // the file changes on disk under unsaved edits: nothing is overwritten until the person chooses
        let disk = try await client.read(path)
        _ = try await client.write(path, before + "# disk\n", mtime: disk.mtime)
        m.edit(path, before + "# mine\n")
        try await Task.sleep(for: .seconds(1.2))
        #expect(m.buffers[path]?.conflict == true)
        #expect(try await client.read(path).content == before + "# disk\n")
        m.keepMine(path)
        try await Task.sleep(for: .seconds(0.5))
        #expect(try await client.read(path).content == before + "# mine\n")
        _ = try await client.write(path, before, mtime: nil)
    }
}
