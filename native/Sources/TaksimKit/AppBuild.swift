import Foundation

/// The app's own build (native/scripts/build-app.sh stamps it): when, and from which commit. The app is
/// stale once its sources on disk are newer than that, the way the engine is (ServerLauncher.isStale).
public enum AppBuild {
    /// seconds since 1970; nil when not run from a built .app (swift run, tests)
    public static var builtAt: Double? { (Bundle.main.object(forInfoDictionaryKey: "TaksimBuiltAt") as? NSNumber)?.doubleValue }
    /// short hash, "+" when built with uncommitted changes
    public static var commit: String? { Bundle.main.object(forInfoDictionaryKey: "TaksimCommit") as? String }

    /// the newest change to what goes into the app: its Swift sources, the package, the build script (ms)
    public static func newestSource(root: URL) -> Double {
        let native = root.appending(path: "native")
        var newest = ServerLauncher.newestChange(native.appending(path: "Sources"), kinds: ["swift"])
        for f in ["Package.swift", "scripts/build-app.sh"] {
            if let d = try? native.appending(path: f).resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate {
                newest = max(newest, d.timeIntervalSince1970 * 1000)
            }
        }
        return newest
    }

    public static func isStale(root: URL, builtAt: Double? = builtAt) -> Bool {
        guard let b = builtAt else { return false }
        return newestSource(root: root) > b * 1000 + 2000
    }
}
