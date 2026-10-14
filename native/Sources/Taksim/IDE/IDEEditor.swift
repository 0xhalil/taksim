import AppKit
import CodeEditLanguages
import CodeEditSourceEditor
import CodeEditTextView
import SwiftUI
import TaksimKit

/// One open file in CodeEdit's editor: PyCharm's New UI colors, the agent's notes underlined on their lines,
/// and the lines an agent shows (ide_open) brought into view and marked for a moment.
struct IDEEditor: View {
    let model: IDEModel
    let path: String
    @Environment(\.colorScheme) private var scheme
    @State private var state = SourceEditorState()
    @State private var marks = EditorMarks()

    var body: some View {
        let text = Binding(get: { model.buffers[path]?.text ?? "" }, set: { model.edit(path, $0) })
        SourceEditor(text, language: Self.language(path), configuration: Self.configuration(dark: scheme == .dark),
                     state: $state, coordinators: [marks])
            .onAppear { marks.notes = model.notes(in: path); marks.reveal = model.reveal?.path == path ? model.reveal : nil }
            .onChange(of: model.notes) { _, _ in marks.notes = model.notes(in: path) }
            .onChange(of: model.reveal) { _, r in if r?.path == path { marks.reveal = r } }
            // ⌘L (Cursor's "add to chat"): the picked lines go to this agent's chat as a chip
            .background {
                Button("") { addToChat() }.keyboardShortcut("l", modifiers: .command).opacity(0).allowsHitTesting(false)
                // ⌘K (Cursor's inline edit): the picked lines, or the caret's line, to be rewritten from a sentence
                Button("") { if let r = marks.region() { model.startInline(path: path, from: r.from, to: r.to) } }
                    .keyboardShortcut("k", modifiers: .command).opacity(0).allowsHitTesting(false)
            }
            .overlay(alignment: .top) {
                if let e = model.inline, e.path == path {
                    InlineEditBar(model: model, edit: e).padding(.top, 8).padding(.horizontal, 14)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.spring(response: 0.3, dampingFraction: 0.85), value: model.inline?.id)
    }

    private func addToChat() {
        guard let s = marks.selection() else { return }
        ChatDrafts.shared.add(ChatAttachment(kind: "selection", path: path, from: s.from, to: s.to, text: s.text), to: model.agent)
        NotificationCenter.default.post(name: ChatDrafts.wantsChat, object: model.agent)
    }

    static func language(_ path: String) -> CodeLanguage {
        CodeLanguage.detectLanguageFrom(url: URL(fileURLWithPath: path))
    }

    static func configuration(dark: Bool) -> SourceEditorConfiguration {
        SourceEditorConfiguration(
            appearance: .init(theme: dark ? darcula : light, font: .monospacedSystemFont(ofSize: 12.5, weight: .regular),
                              lineHeightMultiple: 1.35, wrapLines: false),
            behavior: .init(indentOption: .spaces(count: 4)),
            peripherals: .init(showMinimap: false, showFoldingRibbon: true)
        )
    }

    private static func c(_ hex: UInt32) -> NSColor { NSColor(hex: hex) }
    private static func a(_ hex: UInt32, bold: Bool = false, italic: Bool = false) -> EditorTheme.Attribute { .init(color: c(hex), bold: bold, italic: italic) }

    /// PyCharm's New UI dark scheme (the web IDE's "darcula")
    static let darcula = EditorTheme(
        text: a(0xBCBEC4), insertionPoint: c(0xCED0D6), invisibles: a(0x393B40), background: c(0x1E1F22),
        lineHighlight: c(0x26282E), selection: c(0x214283), keywords: a(0xCF8E6D), commands: a(0x56A8F5),
        types: a(0xBCBEC4), attributes: a(0xB3AE60), variables: a(0xBCBEC4), values: a(0xC77DBB), numbers: a(0x2AACB8),
        strings: a(0x6AAB73), characters: a(0xCF8E6D), comments: a(0x7A7E85, italic: true))

    /// IntelliJ Light (New UI)
    static let light = EditorTheme(
        text: a(0x080808), insertionPoint: c(0x000000), invisibles: a(0xDFE1E5), background: c(0xFFFFFF),
        lineHighlight: c(0xF5F8FE), selection: c(0xA6D2FF), keywords: a(0x0033B3), commands: a(0x00627A),
        types: a(0x080808), attributes: a(0x9E880D), variables: a(0x080808), values: a(0x871094), numbers: a(0x1750EB),
        strings: a(0x067D17), characters: a(0x0037A6), comments: a(0x8C8C8C, italic: true))
}

/// What the editor marks on its text: the agent's notes (underlined in their severity's color) and the lines an
/// agent shows (outlined, then faded after a few seconds).
@MainActor
final class EditorMarks: TextViewCoordinator {
    private weak var controller: TextViewController?
    var notes: [IDENote] = [] { didSet { if notes != oldValue { drawNotes() } } }
    var reveal: IDEReveal? { didSet { if reveal != oldValue { drawReveal() } } }

    nonisolated func prepareCoordinator(controller: TextViewController) {
        MainActor.assumeIsolated { self.controller = controller }
    }

    nonisolated func controllerDidAppear(controller: TextViewController) {
        MainActor.assumeIsolated {
            self.controller = controller
            drawNotes()
            DispatchQueue.main.async { self.drawReveal() }
        }
    }

    nonisolated func textViewDidChangeText(controller: TextViewController) {
        MainActor.assumeIsolated { drawNotes() } // lines moved under them
    }

    nonisolated func destroy() {}

    /// the lines picked in this editor while it has the keyboard: 1-based, and their text (whole lines)
    func selection() -> (from: Int, to: Int, text: String)? {
        guard let tv = controller?.textView, tv.window?.firstResponder === tv else { return nil }
        let r = tv.selectedRange()
        guard r.location != NSNotFound, r.length > 0 else { return nil }
        let text = tv.string as NSString
        let full = text.lineRange(for: r)
        let before = text.substring(to: r.location)
        let from = before.components(separatedBy: "\n").count
        let picked = text.substring(with: full)
        let to = from + max(0, picked.trimmingCharacters(in: .newlines).components(separatedBy: "\n").count - 1)
        return (from, to, picked)
    }

    /// the lines ⌘K works on: the picked ones, else the line the caret is on
    func region() -> (from: Int, to: Int)? {
        if let s = selection() { return (s.from, s.to) }
        guard let tv = controller?.textView, tv.window?.firstResponder === tv else { return nil }
        let loc = min(tv.selectedRange().location, tv.string.utf16.count)
        guard loc != NSNotFound else { return nil }
        let line = (tv.string as NSString).substring(to: loc).components(separatedBy: "\n").count
        return (line, line)
    }

    private func drawNotes() {
        guard let tv = controller?.textView, let em = tv.emphasisManager else { return }
        em.removeEmphases(for: "notes")
        let text = tv.string as NSString
        em.addEmphases(notes.flatMap { n in
            (n.line...max(n.line, n.endLine ?? n.line)).compactMap { Self.lines(text, $0, $0) }
                .map { Emphasis(range: $0, style: .underline(color: Self.tone(n.severity))) }
        }, for: "notes")
    }

    private func drawReveal() {
        guard let r = reveal, let c = controller, let tv = c.textView, let em = tv.emphasisManager else { return }
        c.setCursorPositions([CursorPosition(line: r.line, column: 1)], scrollToVisible: true)
        guard let range = Self.lines(tv.string as NSString, r.line, r.endLine) else { return }
        tv.scrollToRange(range, center: true)
        em.removeEmphases(for: "reveal")
        // a frame around each line (one emphasis per line: a range over several lines draws only the first)
        let text = tv.string as NSString
        em.addEmphases((r.line...max(r.line, r.endLine)).compactMap { Self.lines(text, $0, $0) }
            .map { Emphasis(range: $0, style: .outline(color: NSColor(hex: 0x3574F0), fill: false)) }, for: "reveal")
        _ = range
        let at = r.at
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            guard self?.reveal?.at == at else { return }
            self?.controller?.textView?.emphasisManager?.removeEmphases(for: "reveal")
        }
    }

    static func tone(_ severity: String?) -> NSColor {
        switch severity { case "error": NSColor(hex: 0xF75464); case "warning": NSColor(hex: 0xF2C55C); default: NSColor(hex: 0x3574F0) }
    }

    /// lines first...last (1-based) as a range of the text, without the final line break
    static func lines(_ text: NSString, _ first: Int, _ last: Int) -> NSRange? {
        guard first >= 1 else { return nil }
        var line = 1, start = -1, end = -1, i = 0
        while i <= text.length {
            if line == first && start < 0 { start = i }
            let lineEnd = text.range(of: "\n", range: NSRange(location: i, length: text.length - i)).location
            let stop = lineEnd == NSNotFound ? text.length : lineEnd
            if line == max(first, last) { end = stop; break }
            if lineEnd == NSNotFound { end = stop; break }
            i = lineEnd + 1
            line += 1
        }
        guard start >= 0, end > start else { return nil } // an empty line has nothing to mark
        return NSRange(location: start, length: end - start)
    }
}
