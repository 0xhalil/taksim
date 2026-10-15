import SwiftUI
import TaksimKit

// A panel's frame (canvas.html .panel): its header, the approval strip, the bricks, a run action's output and
// the corner grip; collapsed, only a strip with its title. The offered tool (a ghost) is drawn here too.

struct PanelChrome: View {
    let model: PanelModel
    @Environment(\.isSnapshot) private var isSnapshot

    var body: some View {
        let collapsed = model.collapsed
        ZStack(alignment: .bottomTrailing) {
            if collapsed {
                CollapsedStrip(title: model.title) { model.actions.ui(false, nil, nil) }
            } else {
                // everything at the panel's own width: nothing inside (a long output line, a wide value) may widen
                // the stack, or the header would stretch with it and push its buttons past the panel's edge
                VStack(spacing: 0) {
                    PanelHeader(model: model)
                    if let p = model.panel, !p.isRunning { ApprovalStrip(panel: p, actions: model.actions) }
                    InputsBar(model: model)
                    PanelBody(model: model)
                        // layer bricks rasterize their text for the zoom, in steps (a pinch doesn't redraw every frame)
                        .environment(\.brickZoom, max(1, (model.scale * 2).rounded(.up) / 2))
                    if let out = model.output { OutputPane(text: out.text, ok: out.ok) { model.output = nil } }
                }
                .frame(width: max(1, model.size.width), alignment: .topLeading)
                .clipped()
                Grip(model: model)
            }
        }
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
        .background(JB.panel)
        .clipShape(RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(JB.line))
        .shadow(color: .black.opacity(0.22), radius: 11, y: 6)
        .coordinateSpace(name: "panel")
        .font(.system(size: 12.5))
        .foregroundStyle(JB.text)
        .tint(JB.accent)
    }
}

// ---------- header ----------

struct PanelHeader: View {
    let model: PanelModel
    @State private var editing = false

    var body: some View {
        let p = model.panel
        HStack(spacing: 7) {
            StatusDot(panel: p)
            Text(model.title).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(JB.ink)
                .lineLimit(1).truncationMode(.tail)
                .layoutPriority(-1) // the title gives way; the buttons always fit
                .help(p?.tool.map { L("from the tool \"%@\"", $0.name) } ?? "")
            Spacer(minLength: 4)
            PanelButton(symbol: "arrow.clockwise", help: L("Refresh")) { model.actions.refresh() }
            KeepButton(kept: model.kept, invite: model.inviteKeep, name: p?.tool?.name) { model.actions.keep() }
            PanelButton(symbol: p?.ui.maximized == true ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                        help: p?.ui.maximized == true ? L("Restore size") : L("Maximize")) { toggleMax() }
            PanelButton(symbol: "minus", help: L("Minimize")) { model.actions.ui(true, nil, nil) }
            PanelButton(symbol: "xmark", help: L("Remove panel")) { model.actions.remove() }
        }
        .padding(.leading, 10).padding(.trailing, 6)
        .frame(height: 30)
        .background(JB.panel2)
        .overlay(alignment: .bottom) { Rectangle().fill(JB.line).frame(height: 1) }
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { toggleMax() }
        .contextMenu {
            Button(L("Tell the agent…")) { editing = true }
            Button(L("Refresh")) { model.actions.refresh() }
            Button(model.kept ? L("Kept") : L("Keep")) { model.actions.keep() }.disabled(model.kept)
            Divider()
            Button(L("Remove panel")) { model.actions.remove() }
        }
        .popover(isPresented: $editing, arrowEdge: .top) { PanelEditor(model: model) { editing = false } }
    }

    func toggleMax() { model.actions.ui(false, !(model.panel?.ui.maximized ?? false), nil) }
}

/// running green, waiting for approval amber, rejected or a failing source red
struct StatusDot: View {
    let panel: Panel?
    var body: some View {
        let color: Color = switch panel?.status {
        case "pending": JB.warn
        case "rejected": JB.err
        default: panel?.hasError == true ? JB.err : JB.ok
        }
        Circle().fill(color).frame(width: 8, height: 8)
            .animation(.easeInOut(duration: 0.3), value: panel?.status)
            .help(["running": L("live"), "pending": L("waiting for approval"), "rejected": L("rejected")][panel?.status ?? ""] ?? "")
    }
}

/// canvas.html .pbtn: 22×22, muted until hovered
struct PanelButton: View {
    let symbol: String
    var help = ""
    var tint: Color?
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Hovering { hover in
                Image(systemName: symbol).font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(tint ?? (hover ? JB.ink : JB.muted))
                    .frame(width: 22, height: 22)
                    .background(RoundedRectangle(cornerRadius: 5).fill(hover ? JB.panel : .clear))
                    .contentShape(Rectangle())
                    .animation(.easeOut(duration: 0.12), value: hover)
            }
        }
        .buttonStyle(Press(scale: 0.86))
        .help(help)
    }
}

/// a bookmark: hollow until the panel is kept as a tool; a live panel nobody kept glows for a while
struct KeepButton: View {
    let kept: Bool
    let invite: Bool
    let name: String?
    let action: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isSnapshot) private var isSnapshot

    var body: some View {
        PanelButton(symbol: kept ? "bookmark.fill" : "bookmark", help: kept ? L("Kept: %@", name ?? "") : L("Keep"),
                    tint: kept || invite ? JB.accent : nil, action: action)
            // the ring runs on the render server: a SwiftUI animation here re-laid the whole panel every frame
            // (a snapshot can't draw a layer view: it would show the "unavailable" mark instead)
            .background { if !isSnapshot { PulseRing(active: invite && !reduceMotion).frame(width: 26, height: 26).allowsHitTesting(false) } }
            .symbolEffect(.bounce, value: kept)
    }
}

/// collapsed: the title, written down the strip; a click opens the panel again
struct CollapsedStrip: View {
    let title: String
    let open: () -> Void
    var body: some View {
        Hovering { hover in
            GeometryReader { g in
                Text(title).font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(hover ? JB.ink : JB.muted)
                    .lineLimit(1).truncationMode(.tail)
                    .frame(width: max(0, g.size.height - 20))
                    .rotationEffect(.degrees(90))
                    .frame(width: g.size.width, height: g.size.height)
            }
            .background(hover ? JB.panel2 : .clear)
            .contentShape(Rectangle())
            .onTapGesture(perform: open)
            .help(L("Open panel"))
        }
    }
}

// ---------- approval ----------

/// what the panel wants to reach (commands, files, addresses, run buttons) and the three answers
struct ApprovalStrip: View {
    let panel: Panel
    let actions: PanelActions
    @Environment(\.isSnapshot) private var isSnapshot

    var body: some View {
        let rejected = panel.status == "rejected"
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(panel.pending.enumerated()), id: \.offset) { _, r in ReachRow(reach: r, rejected: rejected) }
            }
            HStack(spacing: 6) {
                Button(L("Approve")) { actions.approve(false) }.buttonStyle(StripButton(primary: true))
                Button(L("Always")) { actions.approve(true) }.buttonStyle(StripButton()).help(L("Always approve this agent's panels"))
                if !rejected { Button(L("Reject")) { actions.reject() }.buttonStyle(StripButton(danger: true)) }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background((rejected ? JB.err : JB.warn).opacity(0.1))
        .overlay(alignment: .bottom) { Rectangle().fill(JB.line).frame(height: 1) }
        .transition(.move(edge: .top).combined(with: .opacity))
    }
}

struct ReachRow: View {
    let reach: Reach
    let rejected: Bool
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Image(systemName: Self.symbol(reach.kind)).font(.system(size: 11)).foregroundStyle(rejected ? JB.err : JB.warn).frame(width: 14)
            if reach.kind == "action", let l = reach.label {
                Text(l).font(.system(size: 11, weight: .semibold)).foregroundStyle(JB.ink)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(RoundedRectangle(cornerRadius: 4).fill(JB.panel2))
            }
            Text(reach.text).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(JB.ink)
                .strikethrough(rejected, color: JB.err.opacity(0.6))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if let c = reach.cadence {
                Text(c).font(.system(size: 10.5)).foregroundStyle(JB.muted)
            }
        }
    }
    static func symbol(_ kind: String) -> String {
        switch kind {
        case "command": "terminal"
        case "action": "cursorarrow.click"
        case "file": "doc.text"
        case "sql": "cylinder.split.1x2"
        case "connector": "link"
        default: "globe"
        }
    }
}

/// canvas.html .btn: small, primary blue, danger red text
struct StripButton: ButtonStyle {
    var primary = false
    var danger = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: primary ? .semibold : .regular))
            .foregroundStyle(primary ? JB.accentInk : danger ? JB.err : JB.ink)
            .padding(.horizontal, 9).frame(height: 22)
            .background(RoundedRectangle(cornerRadius: 4).fill(primary ? JB.accent : JB.panel2))
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(primary ? JB.accent : JB.line))
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.6), value: configuration.isPressed)
    }
}

// ---------- body ----------

/// the bricks in rows of four quarters (canvas.html .pbody grid); a narrow panel puts two stats a row and
/// everything else full width
struct PanelBody: View {
    let model: PanelModel
    @Environment(\.isSnapshot) private var isSnapshot

    var body: some View {
        // a view with `when` shows while that input has a value (a picked row: master/detail)
        let panel = model.panel
        let views = (panel?.spec?.views ?? []).filter { v in v.string("when").map { !(panel?.value($0).isEmpty ?? true) && panel?.value($0) != "false" } ?? true }
        let width = max(100, model.size.width - 16)
        let content = VStack(alignment: .leading, spacing: 8) {
            if views.isEmpty {
                Text(L("No views")).font(.system(size: 12)).foregroundStyle(JB.muted).padding(4)
            }
            ForEach(Array(Self.rows(views, narrow: width < 504).enumerated()), id: \.offset) { _, row in
                HStack(alignment: .top, spacing: 8) {
                    ForEach(row, id: \.view.id) { cell in
                        BrickCard(view: cell.view, feed: model.feed, status: model.panel?.sources[cell.view.source ?? ""],
                                  width: Self.width(cell.span, of: width), actions: model.actions, owner: model.id, panel: panel)
                    }
                }
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: views.map(\.id))
        if isSnapshot { content.frame(minHeight: 0, maxHeight: .infinity, alignment: .top).clipped() }
        else { ScrollView(.vertical) { content }.scrollIndicators(.automatic).frame(minHeight: 0, maxHeight: .infinity) }
    }

    struct Cell { var view: BrickSpec; var span: Int }

    static func rows(_ views: [BrickSpec], narrow: Bool) -> [[Cell]] {
        var out: [[Cell]] = [], cur: [Cell] = [], used = 0
        for v in views {
            let span = narrow ? (v.brick == "stat" ? 2 : 4) : v.span
            if used + span > 4, !cur.isEmpty { out.append(cur); cur = []; used = 0 }
            cur.append(Cell(view: v, span: span))
            used += span
        }
        if !cur.isEmpty { out.append(cur) }
        return out
    }

    static func width(_ span: Int, of total: CGFloat) -> CGFloat {
        let col = (total - 8 * 3) / 4
        return col * CGFloat(span) + 8 * CGFloat(span - 1)
    }
}

/// one view: its name and age, its error, the brick
struct BrickCard: View {
    let view: BrickSpec
    let feed: PanelFeed
    let status: SourceStatus?
    let width: CGFloat
    var actions = PanelActions()
    var preview = false
    /// whose panel this is (the agent, or a ghost's agent and tool): keys what the view keeps
    var owner = ""
    var previewAt: Double?
    var series: JSONValue?
    var everyS: Double?
    /// the live panel (its inputs: a filter's text, a row input this view picks for)
    var panel: Panel?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isSnapshot) private var isSnapshot
    @State private var auditing = false
    /// the source this view shows, as written in the spec (none for previews and views without one)
    private var auditDef: JSONValue? { preview ? nil : view.source.flatMap { panel?.spec?.sources[$0] } }

    /// a row input this view feeds: clicking a row picks it
    private var rowInput: PanelInput? { panel?.spec?.inputs.first { $0.kind == "row" && $0.view == view.id } }

    /// the source's rows narrowed by the view's filter (a text input), without re-running the source
    private func filtered(_ s: SourceState) -> SourceState {
        guard let input = view["filter"]?["input"]?.string, let q = panel?.value(input), !q.isEmpty else { return s }
        let fields = view["filter"]?["fields"]?.array?.compactMap(\.string)
        let needle = q.lowercased()
        let rows = Bricks.rows(s.data).filter { r in
            let hay = fields.map { $0.map { Bricks.show(Bricks.get(r, $0)) }.joined(separator: " ") } ?? Bricks.compact(r)
            return hay.lowercased().contains(needle)
        }
        return SourceState(data: .array(rows), error: s.error, updatedAt: s.updatedAt)
    }

    var body: some View {
        let state = filtered(view.source == nil ? SourceState() : feed[view.source])
        let pick = rowInput
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                // the view's own title, unless it just repeats the panel's
                if view.heading != panel?.spec?.title {
                    Text(view.heading).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(auditing ? JB.ink : JB.muted)
                        .lineLimit(1).truncationMode(.tail)
                }
                Spacer(minLength: 0)
                if !BrickRegistry.hidesAge(view.brick), !preview, let ts = state.updatedAt {
                    TimelineView(.periodic(from: .now, by: 5)) { t in
                        Text(Bricks.ago(ts, now: t.date)).font(.system(size: 10.5)).foregroundStyle(JB.muted2)
                    }
                    .help(L("updated: %@", Date(timeIntervalSince1970: ts / 1000).formatted(date: .omitted, time: .standard)))
                }
            }
            .padding(.horizontal, 9).padding(.top, 5).padding(.bottom, 3)
            // the header is where its numbers come from: a click shows the source as it runs
            .contentShape(Rectangle())
            .onTapGesture { if auditDef != nil { auditing.toggle() } }
            .help(auditDef == nil ? "" : L("Where the data comes from"))
            .popover(isPresented: $auditing, arrowEdge: .top) {
                if let src = view.source, let def = auditDef {
                    SourceAudit(name: src, def: def, state: feed[src], heading: view.heading,
                                refresh: { actions.refresh() }, explain: { auditing = false; actions.tell($0) })
                }
            }
            if let e = state.error ?? status?.error, !preview {
                Label(e, systemImage: "exclamationmark.triangle.fill").font(.system(size: 11.5)).foregroundStyle(JB.err)
                    .labelStyle(.titleAndIcon)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 9).padding(.bottom, 5)
                    .transition(.opacity)
            }
            BrickRegistry.view(BrickContext(view: view, state: state, width: width - 18, preview: preview, act: { i, row in
                await actions.action(view.id, i, row)
            }, memoKey: BrickContext.memoKey(owner: owner, view), now: previewAt, series: series, everyS: everyS,
               pickField: pick?.field, picked: pick.flatMap { panel?.value($0.name) }.flatMap { $0.isEmpty ? nil : $0 },
               pick: pick.map { i in { row in actions.input(i.name, .string(Bricks.show(Bricks.get(row, i.field ?? "")))) } },
               edit: preview ? nil : { [panel, actions] raw in
                   guard var spec = panel?.spec, let i = spec.views.firstIndex(where: { $0.id == view.id }), let v = BrickSpec(json: raw, index: i) else { return L("view not found") }
                   spec.views[i] = v
                   return await actions.setSpec(spec.json)
               }))
            .environment(\.stillMotion, reduceMotion || isSnapshot)
            .padding(.horizontal, 9).padding(.bottom, 8)
        }
        .frame(width: width, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 7).fill(JB.panel))
        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(JB.line))
        .animation(.easeInOut(duration: 0.3), value: state.error)
    }
}

// ---------- output, grip ----------

/// what a run action printed, under the bricks (canvas.html .pout)
struct OutputPane: View {
    let text: String
    let ok: Bool
    let close: () -> Void
    @Environment(\.isSnapshot) private var isSnapshot
    var body: some View {
        let t = Text(text.isEmpty ? "—" : text).font(.system(size: 11.5, design: .monospaced))
            .foregroundStyle(ok ? JB.text : JB.err).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 8).padding(.trailing, 30).padding(.vertical, 6)
        Group {
            if isSnapshot { t.frame(maxHeight: 120, alignment: .top).clipped() } else { ScrollView { t }.frame(maxHeight: 120) }
        }
        .fixedSize(horizontal: false, vertical: true)
        .background(JB.bg)
        .overlay(alignment: .top) { Rectangle().fill(JB.line).frame(height: 1) }
        .overlay(alignment: .topTrailing) { PanelButton(symbol: "xmark", action: close).padding(3) }
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

/// the bottom-right corner resizes (canvas.html .pgrip); the size is saved when the drag ends
struct Grip: View {
    let model: PanelModel
    @State private var start: CGSize?

    var body: some View {
        Canvas { ctx, size in
            for k in [0.5, 0.75] as [CGFloat] {
                var p = Path()
                p.move(to: CGPoint(x: size.width * k - 1, y: size.height - 2))
                p.addLine(to: CGPoint(x: size.width - 2, y: size.height * k - 1))
                ctx.stroke(p, with: .color(JB.muted2), lineWidth: 1.2)
            }
        }
        .frame(width: 14, height: 14)
        .contentShape(Rectangle())
        .pointerStyle(.frameResize(position: .bottomTrailing))
        .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .named("panel"))
            .onChanged { g in
                let s = start ?? {
                    let p = model.panel
                    let s = p?.ui.maximized == true ? GraphView.panelMax : CGSize(width: p?.ui.size.first ?? 560, height: p?.ui.size.last ?? 400)
                    start = s
                    return s
                }()
                model.liveSize = CGSize(width: max(260, s.width + g.translation.width), height: max(160, s.height + g.translation.height))
                model.actions.relayout()
            }
            .onEnded { _ in
                if let s = model.liveSize { model.actions.ui(nil, false, [Double(s.width.rounded()), Double(s.height.rounded())]) }
                model.liveSize = nil
                start = nil
                model.actions.relayout()
            })
        .help(L("Resize"))
    }
}

// ---------- editing ----------

/// under the header's right click: tell the agent what to change, or edit the spec as JSON
struct PanelEditor: View {
    let model: PanelModel
    let done: () -> Void
    @State private var ask = ""
    @State private var json = ""
    @State private var showJSON = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField(L("e.g. only show errors"), text: $ask, axis: .vertical)
                .textFieldStyle(.plain).font(.system(size: 13)).lineLimit(2...5)
                .padding(8).background(RoundedRectangle(cornerRadius: 6).fill(JB.bg))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(JB.line))
                .onSubmit(send)
            HStack {
                Button { withAnimation(.spring(duration: 0.35)) { showJSON.toggle() } } label: {
                    Image(systemName: "curlybraces").foregroundStyle(showJSON ? JB.accent : JB.muted)
                }.buttonStyle(Press()).help("JSON")
                Spacer()
                Button(action: send) { Image(systemName: "paperplane.fill") }
                    .buttonStyle(StripButton(primary: true)).disabled(ask.trimmingCharacters(in: .whitespaces).isEmpty)
                    .keyboardShortcut(.return, modifiers: .command)
            }
            if showJSON {
                TextEditor(text: $json).font(.system(size: 11.5, design: .monospaced)).frame(height: 260)
                    .scrollContentBackground(.hidden).padding(4).background(RoundedRectangle(cornerRadius: 6).fill(JB.bg))
                if let error { Text(error).font(.system(size: 11.5)).foregroundStyle(JB.err).fixedSize(horizontal: false, vertical: true) }
                HStack { Spacer(); Button(L("Save"), action: save).buttonStyle(StripButton(primary: true)) }
            }
        }
        .padding(12)
        .frame(width: 420)
        .background(JB.panel)
        .onAppear { json = Bricks.pretty(model.panel?.spec?.json ?? .null) }
    }

    func send() {
        let t = ask.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        model.actions.tell("[Panel change request from the user] \(t)")
        done()
    }

    func save() {
        guard let spec = try? JSONValue.parse(json) else { error = L("Couldn't read JSON"); return }
        Task { @MainActor in
            if let e = await model.actions.setSpec(spec) { error = e } else { done() }
        }
    }
}

// ---------- the offered tool ----------

/// A saved tool that fits what the person asked, drawn faintly where the panel would be; ▶ opens it.
struct GhostPanel: View {
    let model: PanelModel
    @State private var shown = false
    @State private var pressed = false
    @State private var hover = false
    @Environment(\.isSnapshot) private var isSnapshot
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let tool = model.ghost
        let on = shown || isSnapshot
        // the whole ghost opens the tool; hovering wakes the preview and gives the frame the accent
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                if let tool { ToolTile(card: tool) }
                Text(tool?.name ?? "").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(JB.ink).lineLimit(1)
                    .help(tool?.summary ?? "")
                Spacer(minLength: 4)
                Text(L("Open")).font(.system(size: 12, weight: .semibold)).foregroundStyle(JB.accentInk)
                    .padding(.horizontal, 10).frame(height: 22)
                    .background(Capsule().fill(JB.accent))
                    .scaleEffect(pressed ? 0.88 : hover ? 1.06 : 1)
                PanelButton(symbol: "xmark", help: L("Not needed")) { model.actions.dismissGhost() }
            }
            .padding(.leading, 10).padding(.trailing, 6).frame(height: 34)
            if let tool, let spec = tool.spec {
                PreviewBody(tool: tool, spec: spec, width: model.size.width - 16, owner: "\(model.id)/\(tool.id)")
                    .opacity(hover ? 0.85 : 0.4).saturation(hover ? 1 : 0.25).allowsHitTesting(false)
                    .frame(minHeight: 0, maxHeight: .infinity, alignment: .top).clipped()
            } else { Spacer() }
        }
        .contentShape(Rectangle())
        .onTapGesture { pressed = true; model.actions.useGhost() }
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.25), value: hover)
        .animation(.spring(response: 0.3, dampingFraction: 0.6), value: pressed)
        .help(L("Open"))
        .background(JB.panel.opacity(0.7))
        .clipShape(RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(hover ? JB.accent : JB.muted2, style: StrokeStyle(lineWidth: 1.5, dash: [5, 4])))
        .opacity(on ? 1 : 0)
        .offset(x: on ? 0 : -14)
        .animation(reduceMotion ? nil : .spring(response: 0.5, dampingFraction: 0.8), value: on)
        .onAppear { shown = true }
    }
}

/// a spec's bricks drawn with sample data, not interactive (market.mjs drawPreview)
struct PreviewBody: View {
    let tool: ToolCard
    let spec: PanelSpec
    let width: CGFloat
    var owner = ""

    var body: some View {
        let feed = PanelFeed(sample: tool.preview ?? .null)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(PanelBody.rows(spec.views, narrow: width < 504).enumerated()), id: \.offset) { _, row in
                HStack(alignment: .top, spacing: 8) {
                    ForEach(row, id: \.view.id) { cell in
                        BrickCard(view: cell.view, feed: feed, status: nil, width: PanelBody.width(cell.span, of: width), preview: true,
                                  owner: owner, previewAt: tool.previewAt, series: tool.previewSeries[cell.view.id],
                                  everyS: cell.view.source.flatMap { spec.sources[$0]?["every_s"]?.number })
                    }
                }
            }
        }
        .padding(8)
    }
}

/// an accent ring that widens and fades, four times (Core Animation; nothing re-renders while it plays)
struct PulseRing: NSViewRepresentable {
    let active: Bool
    func makeNSView(context: Context) -> RingView { RingView() }
    func updateNSView(_ v: RingView, context: Context) { v.set(active) }

    final class RingView: NSView {
        private let ring = CAShapeLayer()
        private var on = false
        override init(frame: NSRect) {
            super.init(frame: frame)
            wantsLayer = true
            ring.fillColor = nil
            ring.lineWidth = 2
            ring.opacity = 0
            layer?.addSublayer(ring)
        }
        required init?(coder: NSCoder) { fatalError() }
        override func layout() {
            super.layout()
            ring.frame = bounds
            ring.path = CGPath(ellipseIn: bounds.insetBy(dx: 2, dy: 2), transform: nil)
        }
        func set(_ active: Bool) {
            guard active != on else { return }
            on = active
            ring.removeAllAnimations()
            guard active else { return }
            ring.strokeColor = Pal.accent.cgColor
            let scale = CABasicAnimation(keyPath: "transform.scale")
            scale.fromValue = 0.8; scale.toValue = 1.25
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0.5; fade.toValue = 0
            let g = CAAnimationGroup()
            g.animations = [scale, fade]
            g.duration = 1.3
            g.repeatCount = 4
            g.timingFunction = CAMediaTimingFunction(name: .easeOut)
            ring.add(g, forKey: "pulse")
        }
    }
}
