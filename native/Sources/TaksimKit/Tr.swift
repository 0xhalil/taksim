import Foundation

/// English → Türkçe. Keyed by the English text passed to `L()`, so call sites
/// stay readable and untranslated strings fall back to English. Batch tables
/// from the localization passes live in `Tr_Batch*.swift` and are consulted here.
enum Tr {
    /// Core table (units and shared words land here; batches hold the rest).
    static let dict: [String: String] = [:]

    static func string(for en: String) -> String? {
        dict[en] ?? Tr.batchA[en] ?? Tr.batchB[en] ?? Tr.batchC[en] ?? Tr.batchD[en]
    }
}
