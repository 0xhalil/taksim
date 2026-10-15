import AppKit
import TaksimKit

// Native canvas painting, using the shared canvas geometry and restrained membership feedback.

/// the palette as NSColors that resolve for the drawing appearance (Theme.swift has the SwiftUI side)
enum Pal {
    static func dyn(_ dark: UInt32, _ light: UInt32) -> NSColor { Theme.color(dark, light) }
    static let bg = dyn(0x1E1F22, 0xFFFFFF), ink = dyn(0xDFE1E5, 0x1E1F22), text = dyn(0xBCBEC4, 0x2B2D30)
    static let muted = dyn(0x868A91, 0x6C707E), muted1 = dyn(0x9DA0A8, 0x5A5D6B), muted2 = dyn(0x6F737A, 0xA8ADBD)
    static let accent = dyn(0x3574F0, 0x3574F0), ok = dyn(0x5FB865, 0x208A3C), err = dyn(0xF75464, 0xDB3B4B), wait = dyn(0x2AACB8, 0x0B8A96)
    static let grid = dyn(0x35373B, 0xDFE1E5), nodeHead = dyn(0x323438, 0xF2F3F5), nodeBody = dyn(0x2B2D30, 0xFFFFFF)
    static let tint = NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(white: 1, alpha: 0x22 / 255) : NSColor(white: 0, alpha: 0x18 / 255) }
    static let backends: [String: NSColor] = ["claude": NSColor(hex: 0xC4552D), "codex": NSColor(hex: 0x2B7A98), "opencode": NSColor(hex: 0x6A4FB3), "gemini": NSColor(hex: 0x3A7D44), "copilot": NSColor(hex: 0x57606A), "local": NSColor(hex: 0x7A6A3A)]
    static func backend(_ b: String?) -> NSColor { backends[b ?? ""] ?? NSColor(hex: 0x6B6862) }
    static func status(_ s: String?) -> NSColor? { ["running": ok, "waiting": wait, "error": err][s ?? ""] }
}

private let logoPaths: [String: CGPath] = Logos.paths.mapValues { SVGPath.parse($0) }
private let sysFont = { (size: CGFloat, weight: NSFont.Weight) in NSFont.systemFont(ofSize: size, weight: weight) }

/// The person's chosen canvas text size (Settings › Appearance), a multiplier on every
/// canvas font. Everything on the canvas zooms together; this only sets the base size.
enum CanvasText {
    static let changed = Notification.Name("taksim.canvas-text")
    static var size: CGFloat {
        let v = UserDefaults.standard.double(forKey: "canvasTextSize")
        return v > 0 ? CGFloat(min(1.5, max(0.75, v))) : 1
    }
    static func save(_ v: Double) {
        UserDefaults.standard.set(min(1.5, max(0.75, v)), forKey: "canvasTextSize")
        NotificationCenter.default.post(name: changed, object: nil)
    }
}


extension GraphView {
    /// a canvas font: the base size times the chosen size. The whole canvas zooms as one,
    /// so fonts scale with it (unlike the IDE dock, which keeps its real size to stay clickable).
    func cfont(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
        NSFont.systemFont(ofSize: size * CanvasText.size, weight: weight)
    }
    func ctitle() -> NSFont {
        let size = 14 * CanvasText.size
        return NSFont(name: "Arial", size: size) ?? NSFont.systemFont(ofSize: size, weight: .regular)
    }

    override func draw(_ dirty: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.clip(to: dirty.intersection(bounds))
        stepViewAnim()
        // the text matrix isn't part of the graphics state: leave it clean for the terminals drawn after us
        defer { ctx.textMatrix = .identity }
        effectiveAppearance.performAsCurrentDrawingAppearance {
            ctx.setFillColor(Pal.bg.cgColor)
            ctx.fill(dirty)
            guard store != nil else { return }
            ctx.saveGState()
            ctx.scaleBy(x: scale, y: scale)
            ctx.translateBy(x: offset.x, y: offset.y)
            // only what the dirty rect touches: a streaming card redraws itself, not the whole canvas
            let area = CGRect(x: dirty.minX / scale - offset.x, y: dirty.minY / scale - offset.y, width: dirty.width / scale, height: dirty.height / scale)
            drawGroups(ctx)
            drawGrid(ctx, area)
            drawLinks(ctx)
            let lifted = draggingItems ? selected : []
            let seen = { (a: Agent) in self.footprintOf(a).insetBy(dx: -16, dy: -16).intersects(area) }
            for a in agents where !lifted.contains(a.id) && seen(a) { drawNode(ctx, a) }
            for a in agents where lifted.contains(a.id) { drawNode(ctx, a) }
            drawGroupFeedback(ctx)
            drawMarquee(ctx)
            drawDropTarget(ctx)
            ctx.restoreGState()
        }
    }

    func stepViewAnim() {
        guard let v = viewAnim else { return }
        let t = min(1, (CACurrentMediaTime() - v.start) / 0.35), k = 1 - pow(1 - t, 3)
        scale = v.from.0 + (v.to.0 - v.from.0) * k
        offset = CGPoint(x: v.from.1.x + (v.to.1.x - v.from.1.x) * k, y: v.from.1.y + (v.to.1.y - v.from.1.y) * k)
        if t >= 1 { viewAnim = nil }
    }

    // ---------- text ----------

    func textSize(_ s: String, _ font: NSFont) -> CGSize { (s as NSString).size(withAttributes: [.font: font]) }

    /// draws text with its vertical middle at y (canvas textBaseline "middle") or its baseline at y
    func drawText(_ s: String, _ font: NSFont, _ color: NSColor, x: CGFloat, y: CGFloat, middle: Bool = true, align: NSTextAlignment = .left) {
        let w = align == .center ? textSize(s, font).width : 0
        let top = middle ? y - (font.ascender - font.descender) / 2 : y - font.ascender
        (s as NSString).draw(at: CGPoint(x: x - w / 2, y: top), withAttributes: [.font: font, .foregroundColor: color])
    }

    /// the baseline that centres a line's letters (between cap and x height) on y, as an eye sees it
    func midBaseline(_ font: NSFont, _ y: CGFloat) -> CGFloat { y + (font.capHeight + font.xHeight) / 4 }

    /// text cut to a width, with an ellipsis (graph.mjs fit)
    func fitText(_ text: String, _ font: NSFont, _ maxW: CGFloat) -> String {
        let key = "fit|\(font.fontName)|\(font.pointSize)|\(Int(maxW))|\(text)"
        if let hit = WrapCache.lines[key]?.first { return hit }
        let out = fitTextUncached(text, font, maxW)
        if WrapCache.lines.count > 400 { WrapCache.lines.removeAll() }
        WrapCache.lines[key] = [out]
        return out
    }

    func fitTextUncached(_ text: String, _ font: NSFont, _ maxW: CGFloat) -> String {
        if textSize(text, font).width <= maxW { return text }
        let chars = Array(text)
        var lo = 0, hi = chars.count
        while lo < hi {
            let m = (lo + hi + 1) / 2
            if textSize(String(chars[0..<m]) + "…", font).width <= maxW { lo = m } else { hi = m - 1 }
        }
        return lo > 0 ? String(chars[0..<lo]).trimmingCharacters(in: .whitespaces) + "…" : ""
    }

    func shortTitle(_ a: Agent) -> String { fitText(a.name, ctitle(), (a.isCollapsed ? expandedSize(a) : size(a)).width - Self.th - Self.btn * (3 + (a.hasFolder ? 1 : 0) + (hasIDE(a) ? 1 : 0)) - 50) }

    /// lines of text within a width: the head of finished answers, cut with an ellipsis (graph.mjs wrap)
    /// a card's text in lines; measured once per text, width and font (cards redraw far more often than they change)
    func wrap(_ text: String, _ font: NSFont, _ maxW: CGFloat, _ maxLines: Int) -> [String] {
        let key = "\(font.pointSize)|\(Int(maxW))|\(maxLines)|\(text)"
        if let hit = WrapCache.lines[key] { return hit }
        let out = wrapUncached(text, font, maxW, maxLines)
        if WrapCache.lines.count > 400 { WrapCache.lines.removeAll() }
        WrapCache.lines[key] = out
        return out
    }

    func wrapUncached(_ text: String, _ font: NSFont, _ maxW: CGFloat, _ maxLines: Int) -> [String] {
        guard !text.isEmpty else { return [] }
        var lines: [String] = [], line = ""
        for var word in text.split(separator: " ").map(String.init) {
            while textSize(word, font).width > maxW && word.count > 1 {
                if !line.isEmpty { lines.append(line); line = "" }
                var n = word.count
                while n > 1 && textSize(String(word.prefix(n)), font).width > maxW { n = Int(Double(n) * 0.9) }
                lines.append(String(word.prefix(n)))
                word = String(word.dropFirst(n))
                if lines.count > maxLines * 6 { break }
            }
            let next = line.isEmpty ? word : "\(line) \(word)"
            if textSize(next, font).width > maxW && !line.isEmpty { lines.append(line); line = word } else { line = next }
            if lines.count > maxLines * 6 { break }
        }
        if !line.isEmpty { lines.append(line) }
        if lines.count <= maxLines { return lines }
        var out = Array(lines.prefix(maxLines))
        out[maxLines - 1] = String(out[maxLines - 1].dropLast(min(2, out[maxLines - 1].count))) + "…"
        return out
    }

    // ---------- background ----------

    func drawGrid(_ ctx: CGContext, _ dirty: CGRect) {
        guard UserDefaults.standard.object(forKey: "showGrid") as? Bool ?? true else { return }
        let area = dirty.intersection(CGRect(x: -offset.x, y: -offset.y, width: bounds.width / scale, height: bounds.height / scale))
        ctx.setFillColor(Pal.grid.cgColor)
        let step: CGFloat = 40
        var x = (area.minX / step).rounded(.down) * step
        while x < area.maxX {
            var y = (area.minY / step).rounded(.down) * step
            while y < area.maxY { ctx.fill(CGRect(x: x - 1, y: y - 1, width: 2, height: 2)); y += step }
            x += step
        }
    }

    /// Quiet enclosure, with color reserved for membership and the group heading.
    func drawGroups(_ ctx: CGContext) {
        for g in groups {
            let r = groupRect(g), c = groupColor(g)
            let outline = CGPath(roundedRect: r, cornerWidth: 10, cornerHeight: 10, transform: nil)
            ctx.saveGState()
            ctx.setFillColor(c.withAlphaComponent(0.055).cgColor)
            ctx.addPath(outline); ctx.fillPath()
            ctx.setStrokeColor(c.withAlphaComponent(0.28).cgColor)
            ctx.setLineWidth(1 / scale)
            ctx.addPath(outline); ctx.strokePath()
            ctx.setFillColor(c.cgColor)
            ctx.fillEllipse(in: CGRect(x: r.minX + 11, y: r.minY + 11, width: 5, height: 5))
            ctx.setStrokeColor(c.withAlphaComponent(0.5).cgColor)
            ctx.move(to: CGPoint(x: r.maxX - 13, y: r.maxY - 6))
            ctx.addLine(to: CGPoint(x: r.maxX - 6, y: r.maxY - 13)); ctx.strokePath()
            ctx.restoreGState()
            drawText(fitText(groupTitle(g), cfont(12, .medium), max(0, r.width - 80)), cfont(12, .medium), Pal.ink,
                     x: r.minX + 23, y: r.minY + 18, middle: false)
            // the group's shared note: an open book, filled once something is written, with its version
            let n = noteRect(g), has = (g.version ?? 0) > 0
            let tint = hoverNote == g.id ? Pal.ink : has ? c : Pal.muted
            AppIcon.draw(has ? AppIcon.noteFilled : AppIcon.note, in: ctx, rect: n, color: tint)
            if has, let v = g.version {
                drawText("v\(v)", cfont(10.5, .medium), tint, x: n.minX - 3, y: n.midY + 4, align: .right)
            }
        }
    }

    /// the group's name; its note and keeper show in the note icon and the note itself
    func groupTitle(_ g: TaksimKit.Group) -> String { g.name }

    // ---------- links ----------

    /// where the segment from the center of r toward p leaves r (graph.mjs edgePoint)
    func edgePoint(_ r: CGRect, _ p: CGPoint) -> CGPoint {
        let cx = r.midX, cy = r.midY, dx = p.x - cx, dy = p.y - cy
        if dx == 0 && dy == 0 { return CGPoint(x: cx, y: cy) }
        let s = min(abs((r.width / 2 + 6) / (dx == 0 ? 1e-9 : dx)), abs((r.height / 2 + 6) / (dy == 0 ? 1e-9 : dy)))
        return CGPoint(x: cx + dx * s, y: cy + dy * s)
    }

    func endpoints(_ from: String, _ to: String, _ off: CGFloat = 0) -> (CGPoint, CGPoint)? {
        guard let A = store.agents[from], let B = store.agents[to] else { return nil }
        let ra = rectOf(A), rb = rectOf(B)
        let ca = CGPoint(x: ra.midX, y: ra.midY), cb = CGPoint(x: rb.midX, y: rb.midY)
        let len = max(hypot(cb.x - ca.x, cb.y - ca.y), 1)
        let ox = -(cb.y - ca.y) / len * off, oy = (cb.x - ca.x) / len * off
        let a = edgePoint(ra, CGPoint(x: cb.x + ox, y: cb.y + oy)), b = edgePoint(rb, CGPoint(x: ca.x + ox, y: ca.y + oy))
        return (CGPoint(x: a.x + ox, y: a.y + oy), CGPoint(x: b.x + ox, y: b.y + oy))
    }

    func drawArrow(_ ctx: CGContext, _ a: CGPoint, _ b: CGPoint, color: NSColor, width: CGFloat = 1.5, dash: [CGFloat] = [], head: Bool = true, alpha: CGFloat = 1) {
        ctx.saveGState()
        ctx.setAlpha(alpha)
        ctx.setStrokeColor(color.cgColor)
        ctx.setFillColor(color.cgColor)
        ctx.setLineWidth(width)
        ctx.setLineDash(phase: 0, lengths: dash)
        ctx.move(to: a); ctx.addLine(to: b); ctx.strokePath()
        if head {
            let ang = atan2(b.y - a.y, b.x - a.x)
            ctx.setLineDash(phase: 0, lengths: [])
            ctx.move(to: b)
            ctx.addLine(to: CGPoint(x: b.x - 10 * cos(ang - 0.4), y: b.y - 10 * sin(ang - 0.4)))
            ctx.addLine(to: CGPoint(x: b.x - 10 * cos(ang + 0.4), y: b.y - 10 * sin(ang + 0.4)))
            ctx.closePath(); ctx.fillPath()
        }
        ctx.restoreGState()
    }

    func drawLinks(_ ctx: CGContext) {
        let links = store.links
        for l in links {
            let both = links.contains { $0.from == l.to && $0.to == l.from && $0.kind == "message" }
            guard let (a, b) = endpoints(l.from, l.to, l.kind == "message" && both ? 6 : 0) else { continue }
            if l.kind == "created" { drawArrow(ctx, a, b, color: Pal.muted2, width: 2) }
            else { drawArrow(ctx, a, b, color: NSColor(hex: 0x6B6862), width: 1.2, dash: [5, 5], alpha: 0.8) }
        }
        // what an arrow is for, on it, while the pointer is on it or the agent it points to works on that:
        // why its creator made it, what it handed it last. Pills that would land on each other don't all
        // draw: the hovered one wins, then a message label over the created one.
        func isHover(_ l: Link) -> Bool {
            guard let h = hoverLink else { return false }
            return h.from == l.from && h.to == l.to && h.kind == l.kind
        }
        func isWorking(_ l: Link) -> Bool {
            guard let label = l.label, !label.isEmpty,
                  let a = store.agents[l.to], ["running", "waiting"].contains(a.status ?? "") else { return false }
            return workingOn(a) == label
        }
        struct Pill { let text: String; let font: NSFont; let center: CGPoint; let rect: CGRect; let rank: Int; let strong: Bool }
        var pills: [Pill] = []
        for l in links where (l.label ?? "").isEmpty == false && (isWorking(l) || isHover(l)) {
            guard let label = l.label else { continue }
            let both = links.contains { $0.from == l.to && $0.to == l.from && $0.kind == "message" }
            guard let (a, b) = endpoints(l.from, l.to, l.kind == "message" && both ? 6 : 0) else { continue }
            let t = l.kind == "created" ? 0.4 : 0.62
            let f = cfont(11, l.kind == "created" ? .medium : .regular)
            let s = fitText(label, f, 170), size = textSize(s, f)
            let c = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
            let rect = CGRect(x: c.x - size.width / 2 - 7, y: c.y - 9, width: size.width + 14, height: 18)
            pills.append(Pill(text: s, font: f, center: c, rect: rect, rank: isHover(l) ? 0 : (l.kind == "message" ? 1 : 2), strong: l.kind == "created"))
        }
        var drawn: [CGRect] = []
        for p in pills.sorted(by: { $0.rank < $1.rank }) {
            if drawn.contains(where: { $0.insetBy(dx: -6, dy: -3).intersects(p.rect) }) { continue }
            drawn.append(p.rect)
            ctx.saveGState()
            ctx.setFillColor(Pal.panel.cgColor)
            ctx.addPath(CGPath(roundedRect: p.rect, cornerWidth: 9, cornerHeight: 9, transform: nil)); ctx.fillPath()
            ctx.setStrokeColor(Pal.line.cgColor); ctx.setLineWidth(1)
            ctx.addPath(CGPath(roundedRect: p.rect.insetBy(dx: 0.5, dy: 0.5), cornerWidth: 8.5, cornerHeight: 8.5, transform: nil)); ctx.strokePath()
            ctx.restoreGState()
            drawText(p.text, p.font, p.strong ? Pal.text : Pal.muted, x: p.center.x, y: p.center.y + 4, align: .center)
        }
        // One sign for "this one waits for that one": a bright dashed line. A pending ask, an orchestrator and the
        // agents doing its parts right now, an agent kept from its folder by the one writing there.
        for a in agents { for t in Set((a.waitingOn ?? []) + (a.workingWith ?? []) + (a.blockedBy ?? [])) {
            if let (p, q) = endpoints(a.id, t, 6) { drawArrow(ctx, p, q, color: Pal.wait, width: 2, dash: [8, 6], alpha: 0.9) }
        } }
        let now = CACurrentMediaTime()
        pulses.removeAll { now - $0.start >= Self.pulseMs }
        for p in pulses {
            let t = (now - p.start) / Self.pulseMs
            guard let (a, b) = endpoints(p.from, p.to, 6) else { continue }
            drawArrow(ctx, a, b, color: p.color, width: 2.5, alpha: 1 - t * 0.6)
            ctx.setFillColor(p.color.cgColor)
            ctx.fillEllipse(in: CGRect(x: a.x + (b.x - a.x) * t - 5, y: a.y + (b.y - a.y) * t - 5, width: 10, height: 10))
        }
    }

    /// what an agent is busy with for another agent: the label of the last arrow into it (the latest hand-off,
    /// else why it was made); nil when it isn't working or nobody labeled it
    func workingOn(_ a: Agent) -> String? {
        guard ["running", "waiting"].contains(a.status ?? "") else { return nil }
        let into = store.links.filter { $0.to == a.id && !($0.label ?? "").isEmpty }
        return (into.first { $0.kind == "message" } ?? into.first { $0.kind == "created" })?.label
    }

    // ---------- the agent card (LiteGraph drawNode + graph.mjs onDrawForeground) ----------

    func drawNode(_ ctx: CGContext, _ a: Agent) {
        let r = rectOf(a), th = Self.th, w = r.width, h = r.height - th
        // it shows as waiting while others do its parts, or while another agent's writing keeps it from its folder
        let status = a.waitsForOthers ? "waiting" : a.status ?? "idle", scolor = Pal.status(status)
        let pulseAlpha: CGFloat = { let t = CACurrentMediaTime().truncatingRemainder(dividingBy: 1.4) / 1.4; return pow(sin(t * .pi * 2), 2) }()
        ctx.saveGState()
        ctx.translateBy(x: r.minX, y: r.minY + th)

        // body with LiteGraph's shadow, the title bar, the line under it
        let body = CGPath(roundedRect: CGRect(x: 0, y: -th, width: w, height: h + th), cornerWidth: 8, cornerHeight: 8, transform: nil)
        ctx.saveGState()
        let lifted = draggingItems && selected.contains(a.id)
        ctx.setShadow(offset: CGSize(width: 0, height: lifted ? -5 : -1), blur: lifted ? 12 : 3,
                      color: NSColor(white: 0, alpha: lifted ? 0.22 : 0.12).cgColor)
        ctx.setFillColor(Pal.nodeBody.cgColor)
        ctx.addPath(body); ctx.fillPath()
        ctx.restoreGState()
        ctx.saveGState()
        ctx.addPath(body); ctx.clip()
        ctx.setFillColor(Pal.nodeHead.cgColor)
        ctx.fill(CGRect(x: 0, y: -th, width: w, height: th))
        if !a.isCollapsed {
            ctx.setFillColor(Pal.grid.cgColor)
            ctx.fill(CGRect(x: 0, y: -1 / scale, width: w, height: 1 / scale))
        }
        ctx.restoreGState()

        // selected: LiteGraph's outline, 6 out, rounded 14
        if selected.contains(a.id) {
            ctx.saveGState()
            ctx.setAlpha(0.8)
            ctx.setStrokeColor(Pal.accent.cgColor)
            ctx.setLineWidth(1.5 / scale)
            ctx.addPath(CGPath(roundedRect: CGRect(x: -3, y: -th - 3, width: w + 6, height: h + th + 6), cornerWidth: 11, cornerHeight: 11, transform: nil))
            ctx.strokePath()
            ctx.restoreGState()
        } else if hoverId == a.id && drag == nil {
            // under the pointer: its edge shows, quieter than a selection
            ctx.saveGState()
            ctx.setStrokeColor(Pal.muted.withAlphaComponent(0.55).cgColor)
            ctx.setLineWidth(1 / scale)
            ctx.addPath(body); ctx.strokePath()
            ctx.restoreGState()
        }

        // title: the CLI's logo tile, the name
        drawLogo(ctx, a.backend, x: 9, y: -th + (th - 14) / 2, size: 14, bg: Pal.backend(a.backend))
        let title = shortTitle(a)
        drawText(title, ctitle(), Pal.ink, x: th, y: midBaseline(ctitle(), -th / 2), middle: false)
        // while it works on something an agent handed it: what that is, after its name.
        // Its width pushes the folder line right, or the two texts pile up.
        var whyW: CGFloat = 0
        if let why = workingOn(a) {
            let nameW = textSize(title, ctitle()).width, f = cfont(11.5)
            let room = w - th - nameW - Self.btn * (2 + (a.hasFolder ? 1 : 0) + (hasIDE(a) ? 1 : 0) + (Self.titleSwitches ? 1 : 0)) - 64
            let s = fitText(why, f, room)
            if room > 40, !s.isEmpty {
                drawText(s, f, Pal.muted, x: th + nameW + 8, y: midBaseline(f, -th / 2), middle: false)
                whyW = textSize(s, f).width + 8
            }
        }

        // A solid, flush rail makes group membership readable at a glance.
        if let g = innerGroup(of: a) {
            ctx.saveGState()
            ctx.addPath(body); ctx.clip()
            ctx.setFillColor(groupColor(g).cgColor)
            ctx.fill(CGRect(x: 0, y: -th, width: 4, height: h + th))
            ctx.restoreGState()
        }

        // the terminal button
        let bx = w - Self.btn - 6, by = -th + (th - 18) / 2
        if a.hasFolder { titleButton(ctx, x: bx, y: by, fill: a.isTerminalOpen ? NSColor(white: 0, alpha: 0x55 / 255) : Pal.tint, hover: hoverTerm == a.id,
                    depth: pressDepth(a.id, "term")) { r in
            AppIcon.draw(a.isTerminalOpen ? AppIcon.minimize : AppIcon.terminal, in: ctx, rect: r.insetBy(dx: (r.width - 15) / 2, dy: (r.height - 15) / 2), color: Pal.ink)
        } }
        // the IDE button, on agents that work in a git repo (like the web's)
        let lead = a.hasFolder ? bx - Self.btn - 4 : bx
        if hasIDE(a) {
            titleButton(ctx, x: lead, y: by, fill: Pal.tint.withAlphaComponent(0.06), hover: hoverIDE == a.id, depth: pressDepth(a.id, "ide")) { r in
                AppIcon.draw(AppIcon.code, in: ctx, rect: r.insetBy(dx: (r.width - 14) / 2, dy: (r.height - 14) / 2), color: Pal.ink)
            }
        }
        // the switch that makes it an orchestrator: lit while it may create agents for parts of its work
        let hx = hasIDE(a) ? lead - Self.btn - 4 : lead, helping = a.delegate == true
        titleButton(ctx, x: hx, y: by, fill: helping ? Pal.accent.withAlphaComponent(0.22) : Pal.tint.withAlphaComponent(0.06),
                    hover: hoverHelpers == a.id, depth: pressDepth(a.id, "helpers")) { r in
            AppIcon.draw(helping ? AppIcon.helpersOn : AppIcon.helpers, in: ctx, rect: r.insetBy(dx: (r.width - 15) / 2, dy: (r.height - 15) / 2),
                         color: helping ? Pal.accent : Pal.ink)
        }
        // the fold button: one tap folds the node to this bar, or opens it again
        let fx = hx - Self.btn - 4
        titleButton(ctx, x: fx, y: by, fill: Pal.tint.withAlphaComponent(0.06), hover: hoverFold == a.id, depth: pressDepth(a.id, "fold")) { r in
            AppIcon.draw(a.isCollapsed ? AppIcon.down : AppIcon.minimize, in: ctx, rect: r.insetBy(dx: (r.width - 14) / 2, dy: (r.height - 14) / 2), color: Pal.ink)
        }
        // tool help is in the node's menu unless the title shows it
        let tx = Self.titleSwitches ? fx - Self.btn - 4 : fx, tools = a.toolsOn
        if Self.titleSwitches {
            ctx.setFillColor((tools ? Pal.accent.withAlphaComponent(0.22) : hoverToolHelp == a.id ? Pal.tint : Pal.tint.withAlphaComponent(0.06)).cgColor)
            ctx.addPath(CGPath(roundedRect: CGRect(x: tx, y: by, width: Self.btn, height: 18), cornerWidth: 5, cornerHeight: 5, transform: nil)); ctx.fillPath()
            AppIcon.draw(AppIcon.toolHelp, in: ctx, rect: CGRect(x: tx + (Self.btn - 14) / 2, y: -th + (th - 14) / 2, width: 14, height: 14),
                         color: tools ? Pal.accent : Pal.muted1)
        }

        // status: a dot left of the button; queued messages: a badge on the button
        if let c = scolor {
            ctx.saveGState()
            ctx.setAlpha(status == "running" ? 0.55 + 0.45 * pulseAlpha : 1)
            ctx.setFillColor(c.cgColor)
            ctx.fillEllipse(in: CGRect(x: fx - 15, y: -th / 2 - 4, width: 8, height: 8))
            ctx.restoreGState()
        }
        if let q = a.queued, q > 0 {
            let f = cfont(10, .bold), label = "\(q)", bw = max(15, textSize(label, f).width + 8)
            let qx = bx + Self.btn - bw / 2 + 3, qy = by - 4
            ctx.setFillColor(Pal.accent.cgColor)
            ctx.addPath(CGPath(roundedRect: CGRect(x: qx, y: qy - 7, width: bw, height: 15), cornerWidth: 7.5, cornerHeight: 7.5, transform: nil)); ctx.fillPath()
            drawText(label, f, .white, x: qx + bw / 2, y: qy + 0.5, align: .center)
        }

        // the status outline, pulsing while running or waiting
        if let c = scolor {
            ctx.saveGState()
            ctx.setAlpha(status == "error" ? 0.9 : 0.45 + 0.45 * pulseAlpha)
            ctx.setStrokeColor(c.cgColor)
            ctx.setLineWidth(2)
            ctx.addPath(CGPath(roundedRect: CGRect(x: -3, y: -th - 3, width: w + 6, height: h + th + 6), cornerWidth: 10, cornerHeight: 10, transform: nil)); ctx.strokePath()
            ctx.restoreGState()
        }

        // heard a double-click it can't act on yet: an accent outline that fades
        if let f = flashes[a.id] {
            let t = CGFloat(min(1, (CACurrentMediaTime() - f) / 0.7))
            ctx.saveGState()
            ctx.setAlpha(1 - t)
            ctx.setStrokeColor(Pal.accent.cgColor)
            ctx.setLineWidth(2.5)
            let grow = 3 + 6 * t
            ctx.addPath(CGPath(roundedRect: CGRect(x: -grow, y: -th - grow, width: w + grow * 2, height: h + th + grow * 2), cornerWidth: 10 + grow, cornerHeight: 10 + grow, transform: nil)); ctx.strokePath()
            ctx.restoreGState()
        }

        // folded to its title bar: its tool is tucked away too, so a tool waiting for approval lights the bar red
        if a.isCollapsed {
            if a.panel?.spec != nil, a.panel?.status == "pending" {
                ctx.saveGState()
                ctx.setAlpha(0.55 + 0.45 * pulseAlpha)
                ctx.setStrokeColor(Pal.err.cgColor)
                ctx.setLineWidth(2)
                ctx.addPath(CGPath(roundedRect: CGRect(x: -3, y: -th - 3, width: w + 6, height: th + 6), cornerWidth: 10, cornerHeight: 10, transform: nil)); ctx.strokePath()
                ctx.restoreGState()
            }
            ctx.restoreGState()
            return
        }

        if (a.isTerminalOpen || hasTranscript(a)) && terminalsShown {
            // the terminal covers the body; where it works sits in the title bar after the name
            // up to the leftmost button (the tool help switch) and the status dot before it, not under them
            let nx = nameEnd(a) + 6 + whyW, room = tx - 22 - nx
            if room > 60, a.folder != nil || a.accountName != nil { drawMeta(a, x: nx + 8, y: -th / 2 + 1, maxW: room - 8, color: Pal.muted1) }
            ctx.setFillColor(Pal.bg.cgColor)
            ctx.fill(CGRect(x: 4, y: 2, width: w - 14, height: h - 12))
            grip(ctx, w, h)
            ctx.restoreGState()
            return
        }

        // the folder icon sits centred under the logo tile; text below shares that edge
        let pad: CGFloat = 10
        drawMeta(a, x: pad, y: 15, maxW: w - pad * 2, color: a.folder != nil || a.accountName != nil ? Pal.muted1 : Pal.muted)
        let streaming = store.streaming[a.id]
        let text = (status == "running" && streaming != nil) ? streaming! : (a.lastError ?? (a.lastText?.isEmpty == false ? a.lastText! : a.role ?? ""))
        let lines = max(1, Int((h - 32) / 17))
        let color = a.lastError != nil && status != "running" ? Pal.err : (a.lastText?.isEmpty == false || status == "running") ? Pal.ink : Pal.muted
        let f = cfont(12.5)
        let clean = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        for (i, line) in wrap(clean, f, w - pad * 2, lines).enumerated() { drawText(line, f, color, x: pad, y: 38 + CGFloat(i) * 17) }
        if hoverId == a.id { grip(ctx, w, h) }
        ctx.restoreGState()
    }

    /// a square in a node's title bar: its fill, lighter under the pointer, dipping in for a moment when pressed;
    /// `icon` draws into the (pressed: shrunk) square
    func titleButton(_ ctx: CGContext, x: CGFloat, y: CGFloat, fill: NSColor, hover: Bool, depth: CGFloat, icon: (CGRect) -> Void) {
        let full = CGRect(x: x, y: y, width: Self.btn, height: 18)
        let r = full.insetBy(dx: full.width * 0.06 * depth, dy: full.height * 0.06 * depth)
        ctx.setFillColor(fill.cgColor)
        ctx.addPath(CGPath(roundedRect: r, cornerWidth: 5, cornerHeight: 5, transform: nil)); ctx.fillPath()
        if hover || depth > 0 {
            ctx.setFillColor(Pal.ink.withAlphaComponent(0.08 + 0.1 * depth).cgColor)
            ctx.addPath(CGPath(roundedRect: r, cornerWidth: 5, cornerHeight: 5, transform: nil)); ctx.fillPath()
        }
        icon(r)
    }

    func grip(_ ctx: CGContext, _ w: CGFloat, _ h: CGFloat) {
        ctx.setStrokeColor(Pal.muted.cgColor)
        ctx.setLineWidth(1.5)
        for d: CGFloat in [4, 8] { ctx.move(to: CGPoint(x: w - 2, y: h - 2 - d)); ctx.addLine(to: CGPoint(x: w - 2 - d, y: h - 2)); ctx.strokePath() }
    }

    /// Established provider marks; a terminal symbol for providers without a supplied logo.
    func drawLogo(_ ctx: CGContext, _ backend: String?, x: CGFloat, y: CGFloat, size: CGFloat, bg: NSColor) {
        ctx.saveGState()
        ctx.setFillColor(bg.cgColor)
        ctx.addPath(CGPath(roundedRect: CGRect(x: x - 3, y: y - 3, width: size + 6, height: size + 6), cornerWidth: 5, cornerHeight: 5, transform: nil)); ctx.fillPath()
        ctx.setFillColor(NSColor.white.cgColor)
        ctx.setStrokeColor(NSColor.white.cgColor)
        if let p = logoPaths[backend ?? ""] {
            ctx.translateBy(x: x, y: y)
            ctx.scaleBy(x: size / 24, y: size / 24)
            ctx.addPath(p); ctx.fillPath()
        } else {
            AppIcon.draw(AppIcon.terminal, in: ctx, rect: CGRect(x: x, y: y, width: size, height: size), color: .white)
        }
        ctx.restoreGState()
    }

    /// folder, branch and account when chosen, else the model; icons instead of labels; a part that would
    /// only fit as a stub is left out (graph.mjs drawMeta)
    func drawMeta(_ a: Agent, x x0: CGFloat, y: CGFloat, maxW: CGFloat, color: NSColor) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let f = cfont(11.5)
        var parts: [(AppSymbol?, String)] = []
        // it only reads (Ask, Plan, a reader or reviewer of a job): a lock before its folder, as an editor marks a file it won't change
        if a.sandbox == "read-only" || a.chatMode == "ask" || a.chatMode == "plan" { parts.append((AppSymbol(name: "lock"), "")) }
        if let fo = a.folder { parts.append((AppIcon.folder, fo.name)); if let b = fo.branch { parts.append((AppIcon.branch, b)) } }
        if let acct = a.accountName { parts.append((AppIcon.user, acct)) }
        if parts.isEmpty { parts.append((nil, [a.model ?? "", a.sandbox == "read-only" ? "okur" : ""].filter { !$0.isEmpty }.joined(separator: " · "))) }
        // a thinking level picked for this agent (none: its model's default)
        if let e = a.effort, !e.isEmpty { parts.append((AppIcon.brain, AgentSheet.effortName(e))) }
        // its login's plan, only once it runs short: how full the fullest window is
        if let u = a.usageKey.flatMap({ store?.usage(for: $0) }), u.level != .calm, let p = u.peak {
            parts.insert((AppIcon.gauge, u.limited == true ? "dolu" : Usage.percent(p.used)), at: min(1, parts.count))
        }
        var x = x0, room = maxW
        for (i, (icon, text)) in parts.enumerated() {
            let iw: CGFloat = icon == nil ? 0 : 15, full = textSize(text, f).width, last = i == parts.count - 1
            let width = i == 0 ? min(full, last ? room - iw : max(room * 0.62, room - iw - 90)) : min(full, room - iw)
            if i > 0 && width < min(full, 70) { break }
            if text.isEmpty, let icon { // a sign of its own, without a word
                guard room > 16 else { continue }
                AppIcon.draw(icon, in: ctx, rect: CGRect(x: x, y: y - 6, width: 12, height: 12), color: color)
                x += 18; room -= 18
                continue
            }
            let t = room > 24 ? fitText(text, f, width) : ""
            guard !t.isEmpty else { continue }
            if let icon {
                AppIcon.draw(icon, in: ctx, rect: CGRect(x: x, y: y - 6, width: 12, height: 12), color: color)
            }
            drawText(t, f, color, x: x + iw, y: y)
            let used = iw + textSize(t, f).width + 12
            x += used
            room -= used
        }
    }

    // Membership is shown at the boundary, without invented physical connections.
    static func ease(_ t: CGFloat) -> CGFloat { 1 - pow(1 - t, 3) }

    func drawGroupFeedback(_ ctx: CGContext) {
        ctx.saveGState()
        defer { ctx.restoreGState() }
        if draggingItems {
            let changes = membershipChanges()
            for gid in Set(changes.map(\.gid)) {
                guard let g = store.groups[gid] else { continue }
                let joining = changes.contains { $0.gid == gid && $0.kind == .join }
                let r = groupRect(g)
                ctx.setStrokeColor(groupColor(g).withAlphaComponent(joining ? 0.85 : 0.4).cgColor)
                ctx.setLineWidth((joining ? 2 : 1) / scale)
                ctx.setLineDash(phase: 0, lengths: joining ? [] : [4 / scale, 4 / scale])
                ctx.addPath(CGPath(roundedRect: r, cornerWidth: 10, cornerHeight: 10, transform: nil))
                ctx.strokePath()
            }
        }
        ctx.setLineDash(phase: 0, lengths: [])
        let now = CACurrentMediaTime()
        groupAnims.removeAll { now - $0.start >= ($0.kind == .born ? Self.bornMs : Self.joinMs) }
        for an in groupAnims {
            guard let g = store.groups[an.gid] else { continue }
            let duration = an.kind == .born ? Self.bornMs : Self.joinMs
            let opacity = 1 - (now - an.start) / duration
            ctx.setStrokeColor(groupColor(g).withAlphaComponent(opacity * 0.6).cgColor)
            ctx.setLineWidth(2 / scale)
            ctx.addPath(CGPath(roundedRect: groupRect(g), cornerWidth: 10, cornerHeight: 10, transform: nil))
            ctx.strokePath()
        }
    }

    /// ⌘-drag selection: a soft rounded marquee; the nodes it takes get a ring; a count rides its corner
    func drawMarquee(_ ctx: CGContext) {
        guard case .marquee(let s, let n) = drag else { return }
        let m = CGRect(x: min(s.x, n.x), y: min(s.y, n.y), width: abs(n.x - s.x), height: abs(n.y - s.y))
        guard m.width + m.height >= 4 else { return }
        let accent = Pal.accent
        ctx.saveGState()
        ctx.setFillColor(accent.withAlphaComponent(0.07).cgColor)
        ctx.setStrokeColor(accent.withAlphaComponent(0.75).cgColor)
        ctx.setLineWidth(1.5 / scale)
        let mp = CGPath(roundedRect: m, cornerWidth: 12 / scale, cornerHeight: 12 / scale, transform: nil)
        ctx.addPath(mp); ctx.fillPath(); ctx.addPath(mp); ctx.strokePath()
        var count = 0
        for a in agents where rectOf(a).intersects(m) {
            count += 1
            ctx.saveGState()
            ctx.setStrokeColor(accent.cgColor)
            ctx.setLineWidth(2.5 / scale)
            ctx.setShadow(offset: .zero, blur: 14, color: accent.cgColor)
            ctx.addPath(CGPath(roundedRect: rectOf(a).insetBy(dx: -4, dy: -4), cornerWidth: 11, cornerHeight: 11, transform: nil)); ctx.strokePath()
            ctx.restoreGState()
        }
        if count > 0 {
            let rad = 11 / scale
            let cx = n.x + (n.x >= m.midX ? 1 : -1) * rad * 1.4, cy = n.y + (n.y >= m.midY ? 1 : -1) * rad * 1.4
            ctx.setFillColor(accent.cgColor)
            ctx.fillEllipse(in: CGRect(x: cx - rad, y: cy - rad, width: rad * 2, height: rad * 2))
            drawText("\(count)", cfont(12, .bold), Pal.bg, x: cx, y: cy + 0.5 / scale, align: .center)
        }
        ctx.restoreGState()
    }

    /// a tool card dragged over a node: the node it would land on glows
    func drawDropTarget(_ ctx: CGContext) {
        guard let id = dropTarget, let a = store.agents[id] else { return }
        ctx.saveGState()
        ctx.setStrokeColor(Pal.accent.cgColor)
        ctx.setLineWidth(3 / scale)
        ctx.setShadow(offset: .zero, blur: 18, color: Pal.accent.cgColor)
        ctx.addPath(CGPath(roundedRect: rectOf(a).insetBy(dx: -5, dy: -5), cornerWidth: 12, cornerHeight: 12, transform: nil)); ctx.strokePath()
        ctx.restoreGState()
    }
}

@MainActor enum WrapCache { static var lines: [String: [String]] = [:] }
