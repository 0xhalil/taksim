import Foundation
import Testing
@testable import TaksimKit

@Suite struct ReleaseTests {
    @Test func versionsCompareByNumberNotText() throws {
        #expect(AppVersion("v0.10.0")! > AppVersion("0.9.9")!)
        #expect(AppVersion("0.2")! == AppVersion("0.2.0")!)
        #expect(AppVersion("1.0.0-beta")! == AppVersion("1.0.0")!)
        #expect(AppVersion("latest") == nil)
    }

    @Test func aNewerPublishedReleaseWithItsChecksumIsAnUpdate() throws {
        let json = """
        {"tag_name":"v0.3.0","body":"notes","assets":[
          {"name":"Taksim-0.3.0.zip","browser_download_url":"https://x/a.zip"},
          {"name":"Taksim-0.3.0.zip.sha256","browser_download_url":"https://x/a.zip.sha256"}]}
        """
        let r = try JSONDecoder().decode(Release.self, from: Data(json.utf8))
        #expect(r.isUpdate(over: AppVersion("0.2.9")))
        #expect(!r.isUpdate(over: AppVersion("0.3.0")))
        #expect(!r.isUpdate(over: nil)) // a dev build isn't updated from releases
        var noSum = r
        noSum.assets.removeLast()
        #expect(!noSum.isUpdate(over: AppVersion("0.1")))
        var pre = r
        pre.prerelease = true
        #expect(!pre.isUpdate(over: AppVersion("0.1")))
    }

    @Test func announcementsShowOnceForTheirVersionsUntilTheyEnd() {
        let all = [
            Announcement(id: "a", text: "old"),
            Announcement(id: "b", text: "for old apps", below: "0.3"),
            Announcement(id: "c", text: "ended", until: "2020-01-01"),
            Announcement(id: "d", text: "new", minVersion: "0.3"),
        ]
        let v = AppVersion("0.3.1")
        #expect(Announcement.pending(all, version: v, seen: []).map(\.id) == ["d", "a"])
        #expect(Announcement.pending(all, version: v, seen: ["d"]).map(\.id) == ["a"])
        #expect(Announcement.pending(all, version: AppVersion("0.2"), seen: []).map(\.id) == ["b", "a"])
    }
}
