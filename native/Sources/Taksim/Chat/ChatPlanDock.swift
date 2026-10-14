import AppKit
import SwiftUI
import TaksimKit

// A plan beside the chat it belongs to, docked to the node like its IDE: one document to read from top to
// bottom, where any part can be selected and copied, and where selecting brings up, right at the pointer, the
// way to take that part back to the chat. It opens by itself when the agent proposes a plan and from the plan's
// card; the one action is the same as on the card.

struct PlanDocument: View {
    let model: ChatModel
    let store: CanvasStore
    @State private var editing = false
    @State private var draft = ""
    @State private var version = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var agent: Agent? { store.agents[model.agent] }
    private var running: Bool { ["running", "waiting"].contains(agent?.status ?? "") }
    private var available: Bool { !running && model.queue.isEmpty && !model.workflowBusy }

    var body: some View {
        VStack(spacing: 0) {
            if let plan = model.plan {
                header(plan)
                Rectangle().fill(JB.line).frame(height: 1)
                PlanText(source: editing ? draft : plan.content, editing: editing, edited: $draft, quote: quote)
                Rectangle().fill(JB.line).frame(height: 1)
                footer(plan)
            }
        }
        .background(JB.bg)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(JB.line))
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: editing)
        .onChange(of: model.plan?.version) { editing = false }
    }

    private func header(_ plan: ChatPlan) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "list.bullet.clipboard").foregroundStyle(JB.accent)
            Text(plan.title).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(JB.ink).lineLimit(1)
            Text("v\(plan.version)").foregroundStyle(JB.muted2).fixedSize()
            Spacer(minLength: 8)
            Text(status(plan)).lineLimit(1).fixedSize().foregroundStyle(plan.status == "done" ? JB.ok : plan.status == "failed" ? JB.err : JB.muted)
            Button { model.planShown = false } label: { Image(systemName: "xmark").frame(width: 18, height: 18) }.buttonStyle(Tap()).help(L("Close"))
        }
        .font(.system(size: 11.5)).padding(.leading, 12).padding(.trailing, 8).frame(height: 34).background(JB.nodeHead)
    }

    private func status(_ plan: ChatPlan) -> String {
        switch plan.status { case "running": L("Applying"); case "done": L("Done"); case "failed": L("Failed"); default: L("Ready for review") }
    }

    private func footer(_ plan: ChatPlan) -> some View {
        HStack(spacing: 14) {
            if editing {
                Button(L("Cancel")) { editing = false }.buttonStyle(Tap())
                Spacer()
                Button { Task { await saveEdit(plan) } } label: { Label(L("Save"), systemImage: "checkmark") }
                    .buttonStyle(Tap()).disabled(!canSave)
                // what was just written is what gets applied: saved as the next version, then started
                Button {
                    Task { if await saveEdit(plan), let saved = model.plan { act("build", saved); ChatDrafts.shared.focus = model.agent } }
                } label: { applyLabel }
                    .buttonStyle(Tap(well: false)).disabled(!canSave).help(L("Save these changes and apply the plan"))
            } else {
                Spacer()
                Button { act("save", plan) } label: { Image(systemName: "square.and.arrow.down") }
                    .buttonStyle(Tap()).help(L("Save to project and open")).disabled(!available)
                if plan.status == "draft" {
                    Button { draft = plan.content; version = plan.version; editing = true } label: { Image(systemName: "pencil") }
                        .buttonStyle(Tap()).help(L("Edit plan")).disabled(!available)
                    Button { act("build", plan); ChatDrafts.shared.focus = model.agent } label: { applyLabel }
                    .buttonStyle(Tap(well: false)).disabled(!available).help(L("Apply version %d of this plan in Agent mode", plan.version))
                } else if plan.status != "running" {
                    Button { act("revise", plan) } label: { Label(L("Replan"), systemImage: "arrow.clockwise").lineLimit(1).fixedSize() }.buttonStyle(Tap()).disabled(!available)
                }
            }
        }
        .font(.system(size: 12)).foregroundStyle(JB.ink).padding(.horizontal, 12).frame(height: 42).background(JB.panel)
    }

    private var applyLabel: some View {
        Label(L("Apply plan"), systemImage: "play.fill").font(.system(size: 12, weight: .semibold)).foregroundStyle(JB.accentInk)
            .lineLimit(1).fixedSize().padding(.horizontal, 12).frame(height: 26).background(RoundedRectangle(cornerRadius: 7).fill(JB.accent))
    }

    private var canSave: Bool { available && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// the edit becomes the plan's next version (nothing is sent when nothing changed)
    private func saveEdit(_ plan: ChatPlan) async -> Bool {
        if draft == plan.content { editing = false; return true }
        guard await model.changeWorkflow(["id": plan.id, "version": version, "content": draft], store: store, edit: true) else { return false }
        editing = false
        return true
    }

    private func act(_ action: String, _ plan: ChatPlan) {
        Task { await model.changeWorkflow(["action": action, "id": plan.id, "version": plan.version], store: store) }
    }

    /// the selected part, quoted at the end of what is being written to the agent; the composer takes the keyboard
    private func quote(_ selection: String) {
        let quoted = selection.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").map { "> " + $0 }.joined(separator: "\n")
        guard !quoted.isEmpty else { return }
        let current = ChatDrafts.shared.text[model.agent] ?? ""
        ChatDrafts.shared.text[model.agent] = (current.isEmpty ? "" : current.trimmingCharacters(in: .newlines) + "\n\n") + quoted + "\n\n"
        ChatDrafts.shared.focus = model.agent
    }
}

/// The plan as one text: everything in it selects together, across headings, steps and code. Letting go of a
/// selection brings "Add to chat" up where the pointer is.
private struct PlanText: NSViewRepresentable {
    let source: String
    let editing: Bool
    @Binding var edited: String
    let quote: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        let v = PlanTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 400))
        v.minSize = .zero
        v.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
        v.isVerticallyResizable = true
        v.autoresizingMask = [.width]
        v.textContainer?.widthTracksTextView = true
        v.drawsBackground = false
        v.textContainerInset = NSSize(width: 16, height: 14)
        v.isRichText = false
        v.allowsUndo = true
        v.isAutomaticQuoteSubstitutionEnabled = false
        v.isAutomaticDashSubstitutionEnabled = false
        v.selectedTextAttributes = [.backgroundColor: ChatText.selection]
        v.insertionPointColor = ChatText.accent
        v.delegate = context.coordinator
        v.pill.pressed = { [weak v] in
            guard let v else { return }
            let picked = (v.string as NSString).substring(with: v.selectedRange())
            v.setSelectedRange(NSRange(location: v.selectedRange().location, length: 0))
            context.coordinator.parent.quote(picked)
        }
        scroll.documentView = v
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let v = scroll.documentView as? PlanTextView else { return }
        let shown = context.coordinator.shown
        guard shown?.source != source || shown?.editing != editing else { return }
        // while it is being edited the text is the view's own: only entering or leaving the edit redraws it
        if editing, shown?.editing == true { context.coordinator.shown = (source, editing); return }
        context.coordinator.shown = (source, editing)
        v.isEditable = editing
        v.offersQuote = !editing
        let mono: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedSystemFont(ofSize: 12.5, weight: .regular), .foregroundColor: ChatText.ink, .paragraphStyle: ChatText.paragraph()]
        if editing {
            v.textStorage?.setAttributedString(NSAttributedString(string: source, attributes: mono))
            v.typingAttributes = mono
            v.window?.makeFirstResponder(v)
        } else {
            v.textStorage?.setAttributedString(ChatMarkdown.document(source))
        }
        v.setSelectedRange(NSRange(location: 0, length: 0))
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: PlanText
        var shown: (source: String, editing: Bool)?
        init(_ parent: PlanText) { self.parent = parent }

        func textViewDidChangeSelection(_ notification: Notification) { (notification.object as? PlanTextView)?.placePill() }
        func textDidChange(_ notification: Notification) {
            guard parent.editing, let v = notification.object as? NSTextView else { return }
            let text = v.string
            DispatchQueue.main.async { self.parent.edited = text }
        }
    }
}

/// the plan's text view: when a selection is let go, the pill comes up beside the pointer
final class PlanTextView: NSTextView {
    let pill = QuotePill()
    var offersQuote = true
    private var selecting = false

    override func mouseDown(with event: NSEvent) {
        selecting = true
        pill.removeFromSuperview()
        super.mouseDown(with: event) // returns when the button is let go: the selection is made
        selecting = false
        placePill(at: convert(window?.mouseLocationOutsideOfEventStream ?? event.locationInWindow, from: nil))
    }
    override func scrollWheel(with event: NSEvent) { super.scrollWheel(with: event) }
    override func resignFirstResponder() -> Bool {
        pill.removeFromSuperview()
        setSelectedRange(NSRange(location: selectedRange().location, length: 0))
        return super.resignFirstResponder()
    }

    /// by the pointer when it made the selection, else (the keyboard, a double click elsewhere) at the selection's end
    func placePill(at pointer: NSPoint? = nil) {
        let range = selectedRange()
        guard offersQuote, !selecting, range.length > 0, let layoutManager, let textContainer,
              !(string as NSString).substring(with: range).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { pill.removeFromSuperview(); return }
        let glyphs = layoutManager.glyphRange(forCharacterRange: NSRange(location: NSMaxRange(range) - 1, length: 1), actualCharacterRange: nil)
        var end = layoutManager.boundingRect(forGlyphRange: glyphs, in: textContainer)
        end.origin.x += textContainerOrigin.x; end.origin.y += textContainerOrigin.y
        let size = pill.fittingSize
        let anchor = pointer ?? NSPoint(x: end.maxX, y: end.maxY)
        // just below and right of the pointer, kept inside the text
        let x = min(max(6, anchor.x + 6), max(6, bounds.width - size.width - 6))
        let y = min(max(4, max(anchor.y, end.maxY) + 6), max(4, bounds.height - size.height - 4))
        pill.frame = NSRect(x: x, y: y, width: size.width, height: size.height)
        if pill.superview !== self { addSubview(pill); pill.appear() }
    }
}

/// "Add to chat": a small accent pill, drawn and pressed the AppKit way (it sits inside the text view)
final class QuotePill: NSView {
    var pressed: () -> Void = {}
    private var hover = false, down = false
    private let label = L("Add to chat")
    private let font = NSFont.systemFont(ofSize: 11.5, weight: .semibold)
    override var isFlipped: Bool { true }
    override var fittingSize: NSSize { NSSize(width: ceil((label as NSString).size(withAttributes: [.font: font]).width) + 40, height: 26) }

    func appear() {
        wantsLayer = true
        alphaValue = 0
        NSAnimationContext.runAnimationGroup { $0.duration = 0.14; animator().alphaValue = 1 }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect, .cursorUpdate], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { hover = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hover = false; down = false; needsDisplay = true }
    override func cursorUpdate(with event: NSEvent) { NSCursor.pointingHand.set() }
    override func mouseDown(with event: NSEvent) { down = true; needsDisplay = true }
    override func mouseUp(with event: NSEvent) {
        let inside = bounds.contains(convert(event.locationInWindow, from: nil))
        down = false; needsDisplay = true
        if inside { removeFromSuperview(); pressed() }
    }

    override func draw(_ dirtyRect: NSRect) {
        let body = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 13, yRadius: 13)
        (down ? ChatText.accent.blended(withFraction: 0.18, of: .black) : hover ? ChatText.accent.blended(withFraction: 0.1, of: .white) : ChatText.accent)?.setFill()
        body.fill()
        let ink = NSColor.white
        if let symbol = NSImage(systemSymbolName: "text.quote", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 11, weight: .semibold).applying(.init(paletteColors: [ink]))) {
            symbol.draw(in: NSRect(x: 11, y: (bounds.height - symbol.size.height) / 2, width: symbol.size.width, height: symbol.size.height))
        }
        (label as NSString).draw(at: NSPoint(x: 30, y: (bounds.height - font.capHeight) / 2 - (font.ascender - font.capHeight) - 0.5), withAttributes: [.font: font, .foregroundColor: ink])
    }
    override func accessibilityLabel() -> String? { label }
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .button }
    override func accessibilityPerformPress() -> Bool { removeFromSuperview(); pressed(); return true }
}

extension ChatMarkdown {
    /// a whole Markdown text as one attributed string: headings, steps, quotes, tables and code keep their
    /// look, and being one string they select as one
    static func document(_ source: String) -> NSAttributedString {
        let out = NSMutableAttributedString()
        func style(indent: CGFloat = 0, first: CGFloat? = nil, before: CGFloat = 0, after: CGFloat = 7) -> NSParagraphStyle {
            let p = NSMutableParagraphStyle()
            p.lineSpacing = 3; p.paragraphSpacing = after; p.paragraphSpacingBefore = before
            p.headIndent = indent; p.firstLineHeadIndent = first ?? indent
            p.tabStops = [NSTextTab(textAlignment: .left, location: indent)]
            return p
        }
        func add(_ s: NSAttributedString, _ p: NSParagraphStyle) {
            let m = NSMutableAttributedString(attributedString: s)
            m.append(NSAttributedString(string: "\n", attributes: [.font: NSFont.systemFont(ofSize: 13)]))
            m.addAttribute(.paragraphStyle, value: p, range: NSRange(location: 0, length: m.length))
            out.append(m)
        }
        let mono = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        for block in blocks(source) {
            switch block {
            case .text(let t): add(ChatText.attributed(markdown: t, size: 13, weight: .regular), style())
            case .heading(let level, let t):
                add(ChatText.attributed(markdown: t, size: level == 1 ? 20 : level == 2 ? 16 : 14, weight: .semibold), style(before: out.length == 0 ? 0 : level == 1 ? 12 : 8, after: 6))
            case .item(let marker, let indent, let t):
                let lead = CGFloat(indent) * 16, m = NSMutableAttributedString(string: marker + "\t", attributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: ChatText.faint])
                m.append(ChatText.attributed(markdown: t, size: 13, weight: .regular))
                add(m, style(indent: lead + 22, first: lead, after: 4))
            case .quote(let t):
                let m = NSMutableAttributedString(attributedString: ChatText.attributed(markdown: t, size: 13, weight: .regular))
                m.addAttribute(.foregroundColor, value: ChatText.faint, range: NSRange(location: 0, length: m.length))
                add(m, style(indent: 14))
            case .code(_, let code):
                // its lines stay together; the gap comes after the block
                add(NSAttributedString(string: code, attributes: [.font: mono, .foregroundColor: ChatText.ink, .backgroundColor: ChatText.well]), style(indent: 10, after: 0))
                add(NSAttributedString(string: "", attributes: [.font: NSFont.systemFont(ofSize: 4)]), style(after: 0))
            case .table(let rows):
                for (i, row) in rows.enumerated() {
                    add(ChatText.attributed(markdown: row.joined(separator: "   ·   "), size: 13, weight: i == 0 ? .semibold : .regular), style(after: 3))
                }
            case .rule:
                add(NSAttributedString(string: "———", attributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: ChatText.faint]), style())
            }
        }
        return out
    }
}
