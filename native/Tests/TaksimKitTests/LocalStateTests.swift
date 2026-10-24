import Foundation
import Testing
@testable import TaksimKit

/// The Local tile's one step, from where getting a local model stands (src/local-setup.mjs).
@Suite struct LocalStateTests {
    private func state(installed: Bool = true, running: Bool = true, models: [String] = [], brew: Bool = true, pull: String? = nil) throws -> LocalState {
        let json = """
        {"ollama":{"installed":\(installed),"app":false,"running":\(running)},"canInstall":\(brew),"models":\(models),
         "recommended":{"model":"qwen3:4b","gb":2.5},"memoryGB":16,"freeGB":14.2,"install":null,"start":null,"pull":\(pull ?? "null")}
        """
        return try JSONDecoder().decode(LocalState.self, from: Data(json.utf8))
    }

    @Test func eachStateHasOneStep() throws {
        #expect(try state(installed: false).step == .install)
        #expect(try state(installed: false, brew: false).step == .download)
        #expect(try state(running: false).step == .start)
        #expect(try state().step == .pull("qwen3:4b"))
        #expect(try state(models: ["local:qwen3:4b"]).step == .ready)
        let pulling = try state(pull: #"{"running":true,"model":"qwen3:4b","completed":600,"total":1000,"error":null}"#)
        #expect(pulling.step == .busy)
        #expect(pulling.pull?.fraction == 0.6)
        let failed = try state(pull: #"{"running":false,"model":"qwen3:4b","error":"qwen3:4b needs 2.5 GB; 1.0 GB is free"}"#)
        #expect(failed.step == .pull("qwen3:4b"), "a failed download can be tried again")
        #expect(failed.problem == "qwen3:4b needs 2.5 GB; 1.0 GB is free")
    }
}
