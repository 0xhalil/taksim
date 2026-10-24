import XCTest
@testable import TaksimKit

final class BranchSetTests: XCTestCase {
    private func state(_ active: String?, branches: [String?]) throws -> BranchState {
        let repos = zip(["/r/payments", "/r/gateway"], branches).map { dir, b in
            ["dir": dir, "name": (dir as NSString).lastPathComponent, "branch": b as Any, "dirty": false, "branches": ["main"]] as [String: Any]
        }
        let json: [String: Any] = [
            "repos": repos,
            "sets": [["id": "s1", "name": "payments fix", "branches": ["/r/gateway": "main", "/r/payments": "fix/payments", "/gone": "x"]]],
            "active": active as Any,
        ]
        return try JSONDecoder().decode(BranchState.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testTheControlNamesTheSetElseTheSharedBranch() throws {
        XCTAssertEqual(try state("s1", branches: ["fix/payments", "main"]).title, "payments fix")
        XCTAssertEqual(try state(nil, branches: ["main", "main"]).title, "main")
        XCTAssertNil(try state(nil, branches: ["fix/payments", "main"]).title) // the icon alone
        XCTAssertTrue(try state("s1", branches: ["fix/payments", "main"]).currentIsSaved)
    }

    func testASetReadsInTheCanvasRepoOrderWithoutReposItLeft() throws {
        let s = try state(nil, branches: ["main", "main"])
        XCTAssertEqual(s.lines(of: s.sets[0]).map { "\($0.repo) \($0.branch)" }, ["payments fix/payments", "gateway main"])
    }
}
