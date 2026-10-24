import AppKit
import SwiftUI

// How a CLI's mark is drawn (Logos.swift holds the marks): a product's own full-colour icon as it is, else its
// one-colour mark in white on the brand's colour.

extension Logos {
    @MainActor private static var images: [String: NSImage] = [:]

    /// the product's own icon (vector, sharp at every size), read once
    @MainActor static func icon(_ backend: String?) -> NSImage? {
        guard let b = backend, let svg = icons[b] else { return nil }
        if let hit = images[b] { return hit }
        guard let img = NSImage(data: Data(svg.utf8)) else { return nil }
        images[b] = img
        return img
    }

    /// the brand's colour (the tile under a one-colour mark)
    static func tile(_ backend: String?) -> UInt32 { tiles[backend ?? ""] ?? 0x6B6862 }

    /// a colour for what the CLI does on the canvas (a message's pulse): its brand colour, unless that is black
    /// (GitHub, opencode), which wouldn't show on the dark ground
    static func mark(_ backend: String?) -> UInt32 {
        let c = tile(backend)
        let r = (c >> 16) & 0xFF, g = (c >> 8) & 0xFF, b = c & 0xFF
        return r + g + b < 120 ? 0x868A91 : c
    }
}
