import AppKit
import SwiftUI

/// CodeEditSymbols' names, drawn with the nearest system symbol
enum Fallback {
    static let names: [String: String] = [
        "vault": "lock.shield", "vault.fill": "lock.shield.fill", "commit": "smallcircle.filled.circle",
        "checkout": "arrow.triangle.branch", "branch": "arrow.triangle.branch", "breakpoint": "bookmark",
        "breakpoint.fill": "bookmark.fill", "chevron.up.chevron.down": "chevron.up.chevron.down", "github": "chevron.left.forwardslash.chevron.right",
        "doc.java": "doc.text", "doc.javascript": "doc.text", "doc.json": "doc.text", "doc.python": "doc.text", "doc.ruby": "doc.text",
        "square.split.horizontal.plus": "square.split.1x2", "square.split.vertical.plus": "square.split.2x1",
    ]
    static func system(_ name: String) -> String { names[name] ?? name }
}

public extension Image {
    init(symbol: String) { self.init(systemName: Fallback.system(symbol)) }
    static let vault: Image = .init(symbol: "vault")
    static let vaultFill: Image = .init(symbol: "vault.fill")
    static let commit: Image = .init(symbol: "commit")
    static let checkout: Image = .init(symbol: "checkout")
    static let branch: Image = .init(symbol: "branch")
    static let breakpoint: Image = .init(symbol: "breakpoint")
    static let breakpointFill: Image = .init(symbol: "breakpoint.fill")
    static let chevronUpChevronDown: Image = .init(symbol: "chevron.up.chevron.down")
    static let github: Image = .init(symbol: "github")
    static let docJava: Image = .init(symbol: "doc.java")
    static let docJavascript: Image = .init(symbol: "doc.javascript")
    static let docJson: Image = .init(symbol: "doc.json")
    static let docPython: Image = .init(symbol: "doc.python")
    static let docRuby: Image = .init(symbol: "doc.ruby")
    static let squareSplitHorizontalPlus: Image = .init(symbol: "square.split.horizontal.plus")
    static let squareSplitVerticalPlus: Image = .init(symbol: "square.split.vertical.plus")
}

public extension NSImage {
    static func symbol(named: String) -> NSImage? { NSImage(systemSymbolName: Fallback.system(named), accessibilityDescription: nil) }
    static let vault: NSImage? = .symbol(named: "vault")
    static let vaultFill: NSImage? = .symbol(named: "vault.fill")
    static let commit: NSImage? = .symbol(named: "commit")
    static let checkout: NSImage? = .symbol(named: "checkout")
    static let branch: NSImage? = .symbol(named: "branch")
    static let breakpoint: NSImage? = .symbol(named: "breakpoint")
    static let breakpointFill: NSImage? = .symbol(named: "breakpoint.fill")
    static let chevronUpChevronDown: NSImage? = .symbol(named: "chevron.up.chevron.down")
    static let github: NSImage? = .symbol(named: "github")
}
