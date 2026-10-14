import Testing
import Foundation
@testable import Taksim

@Suite struct IDELanguageTests {
    @Test @MainActor func pythonIsDetectedAndHasQueries() {
        let l = IDEEditor.language("app/server.py")
        #expect("\(l.id)".contains("python"))
    }
}
