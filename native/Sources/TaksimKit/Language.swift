import Foundation

/// Product language. English is the default; more languages join later by adding
/// a case, a label, and a table consulted from `Tr.string(for:)`.
public enum Language: String, CaseIterable, Sendable {
    case english = "en"
    case turkish = "tr"

    public var label: String {
        switch self {
        case .english: "English"
        case .turkish: "Türkçe"
        }
    }
}

/// The app language: English unless picked in Settings. Observed, so every view
/// that reads a string through `L()` redraws when it changes.
@Observable public final class LangState {
    public static let shared = LangState()

    /// Tests that switch the language hold this: swift-testing runs suites in
    /// parallel and the language is process-global.
    public static let testGate = NSLock()

    public var current: Language {
        didSet { UserDefaults.standard.set(current.rawValue, forKey: "taksim.language") }
    }

    public init() {
        current = Language(rawValue: UserDefaults.standard.string(forKey: "taksim.language") ?? "") ?? .english
    }

    /// Accept-Language for the engine, so its messages match the app language.
    public var acceptLanguage: String { current == .turkish ? "tr" : "en" }
}

/// A user-facing string, written in English (the default language): `L("Add agent")`.
/// The Turkish table translates it when Türkçe is picked; anything untranslated
/// falls back to English. Pass values as format args, never by interpolation —
/// `L("Delete %@?", name)` — so the translation can reorder them. Only use `%@`,
/// `%d` and `%%`; escape a literal percent as `%%` whenever args are passed.
public func L(_ en: String, _ args: CVarArg...) -> String {
    let template = (LangState.shared.current == .turkish ? Tr.string(for: en) : nil) ?? en
    guard !args.isEmpty else { return template }
    return String(format: template, locale: Locale.current, arguments: args)
}
