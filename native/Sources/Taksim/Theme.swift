import AppKit
import SwiftUI
import TaksimKit

/// The app's colors. Each is written as its IntelliJ Dark and IntelliJ Light value (ui/canvas.html :root) and
/// resolves for the window's appearance and the chosen theme (Darcula and High Contrast remap the dark ones), so
/// switching the theme recolors everything without redrawing by hand. Reading one registers the theme as a
/// SwiftUI dependency.
enum JB {
    static var bg: Color { dyn(0x1E1F22, 0xFFFFFF) }
    static var panel: Color { dyn(0x2B2D30, 0xF7F8FA) }
    static var panel2: Color { dyn(0x393B40, 0xEBECF0) }
    static var line: Color { dyn(0x43454A, 0xDFE1E5) }
    static var ink: Color { dyn(0xDFE1E5, 0x1E1F22) }
    static var text: Color { dyn(0xBCBEC4, 0x2B2D30) }
    static var muted: Color { dyn(0x868A91, 0x6C707E) }
    static var muted2: Color { dyn(0x6F737A, 0xA8ADBD) }
    static var muted1: Color { dyn(0x9DA0A8, 0x5A5D6B) }
    static var line2: Color { dyn(0x4E5157, 0xC9CCD6) }
    static var accent: Color { dyn(0x3574F0, 0x3574F0) }
    /// text on the accent (canvas.html --accent-ink); 0xFFFFFE only so High Contrast can make it black
    static var accentInk: Color { dyn(0xFFFFFE, 0xFFFFFF) }
    static var sel: Color { dyn(0x2E436E, 0xD4E2FF) }
    static var ok: Color { dyn(0x5FB865, 0x208A3C) }
    static var err: Color { dyn(0xF75464, 0xDB3B4B) }
    static var warn: Color { dyn(0xF2C55C, 0xB27A00) }
    static var wait: Color { dyn(0x2AACB8, 0x0B8A96) }
    static var grid: Color { dyn(0x35373B, 0xDFE1E5) }
    static var nodeHead: Color { dyn(0x323438, 0xF2F3F5) }
    static var nodeBody: Color { dyn(0x2B2D30, 0xFFFFFF) }
    static var tabEdge: Color { dyn(0x1E1F22, 0xEBECF0) }
    static var tint: Color { dyn(0xFFFFFF, 0x000000, darkAlpha: 0.05, lightAlpha: 0.04) }

    /// each CLI's color, only on its logo tile (ui/canvas/graph.mjs COLORS)
    static func backend(_ name: String?) -> Color {
        switch name {
        case "claude": Color(hex: 0xC4552D)
        case "codex": Color(hex: 0x2B7A98)
        case "opencode": Color(hex: 0x6A4FB3)
        case "gemini": Color(hex: 0x3A7D44)
        case "copilot": Color(hex: 0x57606A)
        case "local": Color(hex: 0x7A6A3A)
        default: Color(hex: 0x6B6862)
        }
    }

    static func status(_ s: String?) -> Color? {
        switch s {
        case "running": ok
        case "waiting": wait
        case "error": err
        default: nil
        }
    }

    /// canvas icon colors (ui/canvas/app.mjs ICON_COLORS), picked by an FNV-1a hash of the name
    static let iconColors: [UInt32] = [0x3574F0, 0x4A9C5D, 0xD9773F, 0x9B6EE0, 0x1F9AA6, 0xC09534, 0xB85EA8, 0xD9534F, 0x5B7FD6, 0x7A8A34]
    static func icon(for name: String) -> Color {
        var h: UInt32 = 2166136261
        for u in name.unicodeScalars { h = (h ^ u.value) &* 16777619 }
        return Color(hex: iconColors[Int(h % UInt32(iconColors.count))])
    }

    static func dyn(_ dark: UInt32, _ light: UInt32, darkAlpha: CGFloat = 1, lightAlpha: CGFloat = 1) -> Color {
        let theme = ThemeState.shared.choice // observed: a theme change redraws whoever read this color
        // one Color per value and theme: the same instance every time lets SwiftUI see nothing changed
        let key = Key(dark: dark, light: light, da: darkAlpha, la: lightAlpha, theme: theme)
        if let c = cache[key] { return c }
        let c = Color(nsColor: Theme.color(dark, light, darkAlpha: darkAlpha, lightAlpha: lightAlpha))
        cache[key] = c
        return c
    }
    private struct Key: Hashable { var dark: UInt32, light: UInt32, da: CGFloat, la: CGFloat, theme: ThemeChoice }
    nonisolated(unsafe) private static var cache: [Key: Color] = [:]
}

extension NSColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
    }
}

extension Color {
    init(hex: UInt32) { self.init(nsColor: NSColor(hex: hex)) }
    /// a group's color as the server stores it ("#548af7")
    init?(css: String?) {
        guard let s = css, s.hasPrefix("#"), let v = UInt32(s.dropFirst().prefix(6), radix: 16) else { return nil }
        self.init(hex: v)
    }
}

/// true while rendering a snapshot (ImageRenderer can't draw scroll views or AppKit views)
struct SnapshotKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var isSnapshot: Bool { get { self[SnapshotKey.self] } set { self[SnapshotKey.self] = newValue } }
}

/// The user's theme, like PyCharm's (Settings › Appearance › Theme): follows the system until one is picked.
enum ThemeChoice: String, CaseIterable, Identifiable {
    case system, light, dark, darcula, contrast
    var id: String { rawValue }
    var label: String {
        switch self {
        case .system: L("System")
        case .light: "IntelliJ Light"
        case .dark: "IntelliJ Dark"
        case .darcula: "Darcula"
        case .contrast: L("High Contrast")
        }
    }
    var isDark: Bool? { self == .system ? nil : self != .light }
    var scheme: ColorScheme? { isDark.map { $0 ? .dark : .light } }
    var appearance: NSAppearance? { isDark.map { NSAppearance(named: $0 ? .darkAqua : .aqua)! } }
    /// the dark theme this one draws with when the appearance is dark: IntelliJ Dark's values remapped
    var darkMap: [UInt32: UInt32] {
        switch self {
        case .darcula: Theme.darcula
        case .contrast: Theme.contrast
        default: [:]
        }
    }
}

/// The chosen theme, for the colors (read anywhere, also while drawing) and for SwiftUI to observe.
@Observable final class ThemeState {
    static let shared = ThemeState()
    var choice: ThemeChoice = ThemeChoice(rawValue: UserDefaults.standard.string(forKey: "theme") ?? "") ?? .system {
        didSet { Theme.current = choice; NotificationCenter.default.post(name: Theme.changed, object: nil) }
    }
}

enum Theme {
    nonisolated(unsafe) static var current: ThemeChoice = ThemeState.shared.choice
    static let changed = Notification.Name("taksim.theme.changed")

    /// a color's value for an appearance under the current theme
    static func hex(_ dark: UInt32, _ light: UInt32, isDark: Bool) -> UInt32 {
        isDark ? (current.darkMap[dark] ?? dark) : light
    }
    static func color(_ dark: UInt32, _ light: UInt32, darkAlpha: CGFloat = 1, lightAlpha: CGFloat = 1) -> NSColor {
        NSColor(name: nil) { appearance in
            let d = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return NSColor(hex: hex(dark, light, isDark: d), alpha: d ? darkAlpha : lightAlpha)
        }
    }

    /// PyCharm's Darcula, keyed by the IntelliJ Dark value it replaces
    static let darcula: [UInt32: UInt32] = [
        0x1E1F22: 0x2B2B2B, 0x2B2D30: 0x3C3F41, 0x393B40: 0x4C5052, 0x43454A: 0x555555, 0x4E5157: 0x5E6060,
        0xDFE1E5: 0xBBBBBB, 0xBCBEC4: 0xA9B7C6, 0x9DA0A8: 0x999999, 0x868A91: 0x808080, 0x6F737A: 0x606366,
        0x3574F0: 0x4A88C7, 0x2E436E: 0x2F65CA, 0x5FB865: 0x499C54, 0xF75464: 0xC75450, 0xF2C55C: 0xBBB529,
        0x2AACB8: 0x299999, 0x35373B: 0x3A3A3A, 0x323438: 0x45494A, 0xCED0D6: 0xBBBBBB,
    ]
    /// PyCharm's High Contrast
    static let contrast: [UInt32: UInt32] = [
        0x1E1F22: 0x000000, 0x2B2D30: 0x0A0A0A, 0x393B40: 0x1F1F1F, 0x43454A: 0x6E6E6E, 0x4E5157: 0x8C8C8C,
        0xDFE1E5: 0xFFFFFF, 0xBCBEC4: 0xFFFFFF, 0x9DA0A8: 0xDADADA, 0x868A91: 0xC8C8C8, 0x6F737A: 0x9A9A9A,
        0x3574F0: 0x1AEBFF, 0x2E436E: 0x0F4C75, 0x5FB865: 0x3DD68C, 0xF75464: 0xFF6B6B, 0xF2C55C: 0xFFD000,
        0x2AACB8: 0x00E5FF, 0x35373B: 0x2A2A2A, 0x323438: 0x141414, 0xCED0D6: 0xFFFFFF, 0xFFFFFE: 0x000000,
    ]
}
