import AppKit
import ApplicationServices
import CoreGraphics

/// What macOS must allow before agents can use the computer: Screen Recording to see it, Accessibility to drive
/// the mouse and keyboard. taksim asks when the person first allows an agent, not at install; the engine the app
/// starts (and its taksim-computer helper) inherits what the app is granted.
enum MacPermissions {
    static var canSee: Bool { CGPreflightScreenCaptureAccess() }
    static var canDrive: Bool { AXIsProcessTrusted() }

    /// the system's own prompts, for what isn't allowed yet
    static func request() {
        if !canSee { _ = CGRequestScreenCaptureAccess() }
        if !canDrive { _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary) }
    }

    /// the System Settings pane for what is still refused ("screen" or "accessibility")
    static func openSettings(for missing: String) {
        let pane = missing == "screen" ? "Privacy_ScreenCapture" : "Privacy_Accessibility"
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") { NSWorkspace.shared.open(url) }
    }
}
