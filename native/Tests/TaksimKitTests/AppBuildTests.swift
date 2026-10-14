import Foundation
import Testing
@testable import TaksimKit

@Suite struct AppBuildTests {
    @Test func staleOnceASourceIsNewerThanTheBuild() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "taksim-build-\(UUID().uuidString)")
        let src = root.appending(path: "native/Sources/Taksim")
        try FileManager.default.createDirectory(at: src, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = src.appending(path: "A.swift")
        try Data("x".utf8).write(to: file)
        let changed = Date(timeIntervalSince1970: 1_800_000_000)
        try FileManager.default.setAttributes([.modificationDate: changed], ofItemAtPath: file.path)
        #expect(AppBuild.isStale(root: root, builtAt: 1_800_000_000 - 60))
        #expect(!AppBuild.isStale(root: root, builtAt: 1_800_000_000 + 60))
        #expect(!AppBuild.isStale(root: root, builtAt: nil), "not a built app: nothing to compare")
    }
}
