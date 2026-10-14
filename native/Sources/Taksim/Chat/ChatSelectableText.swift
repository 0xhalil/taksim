import AppKit
import SwiftUI

// Text in a chat that can be taken out of it: press and drag selects, a double click takes the word, ⌘C and
// the right click copy. It is a real text view rather than SwiftUI's selectable Text, which never began a
// selection inside a node on the canvas (the press fell through and the canvas dragged the card instead).

struct ChatText: View {
    let string: NSAttributedString
    var wraps = true
    var selectable = true
    @Environment(\.isSnapshot) private var snapshot
    @Environment(\.colorScheme) private var scheme

    /// prose with **bold**, *italic*, `code`, ~~strike~~ and links
    init(markdown text: String, size: CGFloat = 12.5, weight: NSFont.Weight = .regular) {
        string = Self.attributed(markdown: text, size: size, weight: weight)
    }

    /// text as it is: a message the person wrote, code, a path
    init(_ text: String, size: CGFloat = 12.5, monospaced: Bool = false, color: NSColor = ChatText.ink, alignment: NSTextAlignment = .left,
         wraps: Bool = true, selectable: Bool = true) {
        let font = monospaced ? NSFont.monospacedSystemFont(ofSize: size, weight: .regular) : NSFont.systemFont(ofSize: size)
        string = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color, .paragraphStyle: Self.paragraph(alignment)])
        self.wraps = wraps
        self.selectable = selectable
    }

    // the theme's colours as AppKit ones: they follow the appearance by themselves
    static let ink = Theme.color(0xDFE1E5, 0x1E1F22)
    static let faint = Theme.color(0x6F737A, 0xA8ADBD)
    static let accent = Theme.color(0x3574F0, 0x3574F0)
    static let well = Theme.color(0x2B2D30, 0xF7F8FA)
    static let selection = Theme.color(0x2E436E, 0xD4E2FF)

    var body: some View {
        // an offscreen render draws no AppKit view: the same words as plain text there
        if snapshot { Text(AttributedString(string)).fixedSize(horizontal: !wraps, vertical: true) }
        else { Field(string: string, wraps: wraps, selectable: selectable, scheme: scheme) }
    }

    static func paragraph(_ alignment: NSTextAlignment = .left) -> NSParagraphStyle {
        let p = NSMutableParagraphStyle()
        p.lineSpacing = 3
        p.alignment = alignment
        return p
    }

    static func attributed(markdown text: String, size: CGFloat, weight: NSFont.Weight) -> NSAttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        let parsed = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        let out = NSMutableAttributedString()
        for run in parsed.runs {
            let intent = run.inlinePresentationIntent ?? []
            var font = intent.contains(.code) ? NSFont.monospacedSystemFont(ofSize: size - 0.5, weight: weight)
                : NSFont.systemFont(ofSize: size, weight: intent.contains(.stronglyEmphasized) ? .semibold : weight)
            if intent.contains(.emphasized) { font = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask) }
            var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: ink, .paragraphStyle: paragraph()]
            if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if let link = run.link { attributes[.link] = link; attributes[.foregroundColor] = accent }
            out.append(NSAttributedString(string: String(parsed[run.range].characters), attributes: attributes))
        }
        return out
    }

    /// the size the words take at a width: the height of their lines, no wider than they need
    static func size(_ string: NSAttributedString, width: CGFloat?) -> CGSize {
        let limit = CGSize(width: width ?? .greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
        let r = string.boundingRect(with: limit, options: [.usesLineFragmentOrigin, .usesFontLeading])
        return CGSize(width: ceil(r.width), height: ceil(r.height))
    }

    private struct Field: NSViewRepresentable {
        let string: NSAttributedString
        let wraps: Bool
        let selectable: Bool
        let scheme: ColorScheme // a theme change redraws the colours

        func makeNSView(context: Context) -> Quiet {
            let v = Quiet(frame: .zero)
            v.isEditable = false
            v.drawsBackground = false
            v.textContainerInset = .zero
            v.textContainer?.lineFragmentPadding = 0
            v.isVerticallyResizable = false
            v.isHorizontallyResizable = false
            v.isAutomaticLinkDetectionEnabled = false
            v.linkTextAttributes = [.foregroundColor: ChatText.accent, .cursor: NSCursor.pointingHand]
            v.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            return v
        }

        func updateNSView(_ v: Quiet, context: Context) {
            v.isSelectable = selectable
            v.textContainer?.widthTracksTextView = wraps
            if !wraps { v.textContainer?.containerSize = CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude) }
            v.selectedTextAttributes = [.backgroundColor: ChatText.selection]
            if v.textStorage?.isEqual(to: string) != true {
                let selection = v.selectedRange()
                v.textStorage?.setAttributedString(string)
                // an answer still streaming in keeps what was selected so far
                if selection.length > 0, NSMaxRange(selection) <= string.length { v.setSelectedRange(selection) }
            }
        }

        func sizeThatFits(_ proposal: ProposedViewSize, nsView: Quiet, context: Context) -> CGSize? {
            let natural = ChatText.size(string, width: nil)
            guard wraps, let width = proposal.width, width.isFinite, width < natural.width else { return natural }
            return CGSize(width: width, height: ChatText.size(string, width: width).height)
        }
    }

    /// a text view that is only its words: no scrolling of its own, and its selection goes when another takes over
    final class Quiet: NSTextView {
        override func scrollWheel(with event: NSEvent) { nextResponder?.scrollWheel(with: event) }
        override func resignFirstResponder() -> Bool {
            setSelectedRange(NSRange(location: 0, length: 0))
            return super.resignFirstResponder()
        }
        override var acceptsFirstResponder: Bool { isSelectable }
        override func hitTest(_ point: NSPoint) -> NSView? { isSelectable ? super.hitTest(point) : nil }
    }
}
