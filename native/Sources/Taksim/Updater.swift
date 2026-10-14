import AppKit
import CryptoKit
import Foundation
import TaksimKit
import UserNotifications

/// Updates a packaged app from GitHub Releases and brings the publisher's announcements.
/// The releases repository holds each version as a release (tag "v0.3.0", a Taksim-0.3.0.zip and its .sha256)
/// and announcements.json on its default branch. The app looks on launch and every few hours; a newer version
/// shows ↓ in the header, one click downloads it, checks its checksum, swaps the app and reopens it.
@MainActor @Observable
final class Updater {
    static let shared = Updater()

    /// owner/name, from the app's Info.plist (TaksimReleaseRepo); TAKSIM_RELEASE_REPO overrides it
    let repo: String? = ProcessInfo.processInfo.environment["TAKSIM_RELEASE_REPO"]
        ?? Bundle.main.object(forInfoDictionaryKey: "TaksimReleaseRepo") as? String
    let version = AppVersion.current

    private(set) var available: Release?
    private(set) var installing = false
    /// 0…1 while the archive downloads
    private(set) var progress: Double = 0
    private(set) var failure: String?
    private(set) var announcements: [Announcement] = []
    /// set by the app: stops the engine this app runs, so the new app starts the new one
    @ObservationIgnored var stopEngine: () async -> Void = {}

    private var started = false
    private let seenKey = "announcements.seen", notifiedKey = "update.notified"

    func start() {
        guard !started, repo != nil else { return }
        started = true
        Task { @MainActor [weak self] in
            while let self {
                await self.check()
                // TAKSIM_UPDATE_NOW=1 (tests): install what was found without a click
                if ProcessInfo.processInfo.environment["TAKSIM_UPDATE_NOW"] == "1", self.available != nil { self.install() }
                try? await Task.sleep(for: .seconds(6 * 3600))
            }
        }
    }

    func check() async {
        guard let repo else { return }
        // TAKSIM_RELEASE_BASE: a stand-in for GitHub (tests): <base>/releases/latest and <base>/announcements.json
        let test = ProcessInfo.processInfo.environment["TAKSIM_RELEASE_BASE"]
        if let r: Release = await get(test.map { "\($0)/releases/latest" } ?? "https://api.github.com/repos/\(repo)/releases/latest"), r.isUpdate(over: version) {
            available = r
            notifyOnce(r)
        } else {
            available = nil
        }
        if let all: [Announcement] = await get(test.map { "\($0)/announcements.json" } ?? "https://raw.githubusercontent.com/\(repo)/HEAD/announcements.json") {
            let seen = Set(UserDefaults.standard.stringArray(forKey: seenKey) ?? [])
            let fresh = Announcement.pending(all, version: version, seen: seen)
            let shownBefore = Set(announcements.map(\.id))
            announcements = fresh
            for a in fresh where a.important && !shownBefore.contains(a.id) { notify(title: "taksim", body: text(a), id: "announce-\(a.id)") }
        }
    }

    /// what an announcement says in the app's language
    func text(_ a: Announcement) -> String { LangState.shared.current == .turkish ? (a.tr ?? a.text) : a.text }

    /// read: gone from the header; its link, if any, opens
    func open(_ a: Announcement) {
        if let u = a.url.flatMap(URL.init(string:)) { NSWorkspace.shared.open(u) }
        dismiss(a)
    }
    func dismiss(_ a: Announcement) {
        var seen = UserDefaults.standard.stringArray(forKey: seenKey) ?? []
        if !seen.contains(a.id) { seen.append(a.id) }
        UserDefaults.standard.set(Array(seen.suffix(200)), forKey: seenKey)
        withAnimationIfNeeded { announcements.removeAll { $0.id == a.id } }
    }

    // ---------- installing ----------

    func install() {
        guard let r = available, !installing, let zip = r.archive, let sum = r.checksum else { return }
        let app = Bundle.main.bundleURL
        guard app.pathExtension == "app" else { return }
        installing = true
        failure = nil
        progress = 0
        Task { @MainActor in
            do {
                let dir = FileManager.default.temporaryDirectory.appending(path: "taksim-update-\(UUID().uuidString)")
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let expected = try await String(decoding: data(sum.browser_download_url), as: UTF8.self)
                    .split(whereSeparator: \.isWhitespace).first.map(String.init)?.lowercased() ?? ""
                let archive = try await download(zip.browser_download_url, to: dir.appending(path: zip.name))
                let got = try SHA256.hash(data: Data(contentsOf: archive)).map { String(format: "%02x", $0) }.joined()
                guard !expected.isEmpty, got == expected else { throw Failure.checksum }
                let out = dir.appending(path: "unpacked")
                try await run("/usr/bin/ditto", ["-x", "-k", archive.path, out.path])
                guard let new = try FileManager.default.contentsOfDirectory(at: out, includingPropertiesForKeys: nil)
                    .first(where: { $0.pathExtension == "app" }) else { throw Failure.noApp }
                // downloaded by this app, checked against its checksum: no Gatekeeper prompt on the new one
                try? await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", new.path])
                guard FileManager.default.isWritableFile(atPath: app.deletingLastPathComponent().path) else { throw Failure.readOnly(app.deletingLastPathComponent().path) }
                await stopEngine()
                // once this app has quit: the new one takes its place and opens
                let swap = Process()
                swap.executableURL = URL(fileURLWithPath: "/bin/sh")
                swap.arguments = ["-c", """
                    while kill -0 "$0" 2>/dev/null; do sleep 0.2; done
                    rm -rf "$1.old" && mv "$1" "$1.old" && mv "$2" "$1" && rm -rf "$1.old" "$3"
                    open "$1"
                    """, String(ProcessInfo.processInfo.processIdentifier), app.path, new.path, dir.path]
                try swap.run()
                NSApp.terminate(nil)
            } catch {
                installing = false
                failure = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    enum Failure: LocalizedError {
        case checksum, noApp, readOnly(String)
        var errorDescription: String? {
            switch self {
            case .checksum: L("The download didn't match its checksum; nothing was changed.")
            case .noApp: L("The download has no app in it.")
            case .readOnly(let p): L("Can't write to %@; move taksim to Applications and try again.", p)
            }
        }
    }

    // ---------- plumbing ----------

    private func get<T: Decodable>(_ url: String) async -> T? {
        guard let d = try? await data(url) else { return nil }
        return try? JSONDecoder().decode(T.self, from: d)
    }

    private func data(_ url: String) async throws -> Data {
        guard let u = URL(string: url) else { throw URLError(.badURL) }
        var req = URLRequest(url: u)
        req.timeoutInterval = 20
        req.setValue("taksim/\(version?.description ?? "dev")", forHTTPHeaderField: "User-Agent")
        let (d, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return d
    }

    private func download(_ url: String, to file: URL) async throws -> URL {
        guard let u = URL(string: url) else { throw URLError(.badURL) }
        var watch: NSKeyValueObservation?
        defer { watch?.invalidate() }
        let tmp: URL = try await withCheckedThrowingContinuation { cont in
            let task = URLSession.shared.downloadTask(with: u) { loc, resp, err in
                if let err { return cont.resume(throwing: err) }
                guard let loc, (resp as? HTTPURLResponse)?.statusCode == 200 else { return cont.resume(throwing: URLError(.badServerResponse)) }
                // the file is gone once this returns: keep it
                let keep = loc.deletingLastPathComponent().appending(path: UUID().uuidString)
                do { try FileManager.default.moveItem(at: loc, to: keep); cont.resume(returning: keep) } catch { cont.resume(throwing: error) }
            }
            watch = task.progress.observe(\.fractionCompleted) { p, _ in
                let f = p.fractionCompleted
                Task { @MainActor [weak self] in self?.progress = f }
            }
            task.resume()
        }
        try? FileManager.default.removeItem(at: file)
        try FileManager.default.moveItem(at: tmp, to: file)
        progress = 1
        return file
    }

    private func run(_ exe: String, _ args: [String]) async throws {
        try await Task.detached {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: exe)
            p.arguments = args
            try p.run()
            p.waitUntilExit()
            if p.terminationStatus != 0 { throw URLError(.cannotDecodeContentData) }
        }.value
    }

    private func notifyOnce(_ r: Release) {
        guard UserDefaults.standard.string(forKey: notifiedKey) != r.tag_name else { return }
        UserDefaults.standard.set(r.tag_name, forKey: notifiedKey)
        notify(title: "taksim \(r.version?.description ?? r.tag_name)", body: L("A new version is ready to install"), id: "update-\(r.tag_name)")
    }

    private func notify(title: String, body: String, id: String) {
        guard Bundle.main.bundleIdentifier != nil else { return }
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { ok, _ in
            guard ok else { return }
            let c = UNMutableNotificationContent()
            c.title = title
            c.body = body
            center.add(UNNotificationRequest(identifier: id, content: c, trigger: nil))
        }
    }

    private func withAnimationIfNeeded(_ change: () -> Void) { change() }
}
