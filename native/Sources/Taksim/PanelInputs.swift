import SwiftUI
import TaksimKit

// A panel's inputs and buttons (src/bricks/inputs.mjs), in one quiet strip between its header and its views:
// a few options as a segmented control, more as a menu, a search field, a switch, the picked row as a chip
// (× lets it go), and the agent's buttons at the end. Changing one re-runs only the sources that use it.

struct InputsBar: View {
    let model: PanelModel
    @Environment(\.isSnapshot) private var isSnapshot

    var body: some View {
        let p = model.panel
        let inputs = (p?.spec?.inputs ?? []).filter { $0.kind != "row" || !(p?.value($0.name).isEmpty ?? true) }
        let buttons = p?.spec?.actions ?? []
        if !inputs.isEmpty || !buttons.isEmpty {
            let row = HStack(spacing: 8) {
                ForEach(inputs) { control($0) }
                Spacer(minLength: 8)
                ForEach(Array(buttons.enumerated()), id: \.offset) { i, b in PanelStripButton(model: model, index: i, json: b) }
            }
            .padding(.horizontal, 10)
            .frame(minWidth: max(0, model.size.width), minHeight: 34, alignment: .leading)
            // the controls keep their size; a narrow panel scrolls them sideways (a snapshot can't draw a scroll view)
            SwiftUI.Group {
                if isSnapshot { row.frame(width: max(0, model.size.width), alignment: .leading).clipped() }
                else { ScrollView(.horizontal, showsIndicators: false) { row } }
            }
            .frame(height: 34)
            .background(JB.panel)
            .overlay(alignment: .bottom) { Rectangle().fill(JB.line).frame(height: 1) }
            .animation(.spring(response: 0.3, dampingFraction: 0.85), value: inputs.map(\.name))
        }
    }

    @ViewBuilder private func control(_ i: PanelInput) -> some View {
        let value = model.panel?.value(i.name) ?? ""
        switch i.kind {
        case "select":
            let options = i.options ?? sourceOptions(i)
            if options.count <= 4 && i.optionsFrom == nil {
                Segments(options: options, value: value) { set(i, .string($0)) }.help(i.label ?? i.name)
            } else {
                Menu {
                    ForEach(options, id: \.self) { o in Button { set(i, .string(o)) } label: { Label(o, systemImage: o == value ? "checkmark" : "") } }
                } label: {
                    HStack(spacing: 5) {
                        if let l = i.label { Text(l).foregroundStyle(JB.muted) }
                        Text(value.isEmpty ? "—" : value).foregroundStyle(JB.ink).lineLimit(1).fixedSize()
                        Image(systemName: "chevron.up.chevron.down").font(.system(size: 8.5, weight: .semibold)).foregroundStyle(JB.muted)
                    }
                    .font(.system(size: 11.5)).padding(.horizontal, 8).frame(height: 22)
                    .background(RoundedRectangle(cornerRadius: 5).fill(JB.bg.opacity(0.6)))
                    .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(JB.line))
                }
                .menuStyle(.button).buttonStyle(Press()).menuIndicator(.hidden).fixedSize()
            }
        case "text":
            SearchField(value: value, label: i.label) { set(i, .string($0)) }
        case "toggle":
            Toggle(isOn: Binding(get: { value == "true" }, set: { set(i, .bool($0)) })) {
                Text(i.label ?? i.name).font(.system(size: 11.5)).foregroundStyle(JB.muted)
            }
            .toggleStyle(.switch).controlSize(.mini)
        case "slider":
            if let lo = i.min, let hi = i.max, lo < hi {
                SliderRow(input: i, value: Double(value) ?? lo) { set(i, .number($0)) }
            }
        default: // a picked row
            HStack(spacing: 4) {
                Image(systemName: "cursorarrow.rays").font(.system(size: 10)).foregroundStyle(JB.accent)
                Text(value).font(.system(size: 11.5, weight: .medium)).foregroundStyle(JB.ink).lineLimit(1).fixedSize()
                Button { set(i, .null) } label: { Image(systemName: "xmark").font(.system(size: 7.5, weight: .bold)) }
                    .buttonStyle(CloseButtonStyle(size: 14))
            }
            .padding(.leading, 7).padding(.trailing, 3).frame(height: 22)
            .background(Capsule().fill(JB.sel))
            .help(i.label ?? i.name)
            .transition(.scale(scale: 0.8).combined(with: .opacity))
        }
    }

    /// a select's options from a source: the distinct values of a field, as they come
    private func sourceOptions(_ i: PanelInput) -> [String] {
        guard let from = i.optionsFrom else { return [] }
        var seen = Set<String>(), out: [String] = []
        for r in Bricks.rows(model.feed[from.source].data) {
            let v = Bricks.show(Bricks.get(r, from.field))
            if !v.isEmpty, seen.insert(v).inserted { out.append(v) }
            if out.count >= 50 { break }
        }
        return out
    }

    private func set(_ i: PanelInput, _ v: JSONValue) { model.actions.input(i.name, v) }
}

/// a few options side by side, the chosen one lit
struct Segments: View {
    let options: [String]
    let value: String
    let pick: (String) -> Void
    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.self) { o in
                let on = o == value
                Button { pick(o) } label: {
                    Text(o).font(.system(size: 11.5, weight: on ? .semibold : .regular)).foregroundStyle(on ? JB.ink : JB.muted)
                        .lineLimit(1).fixedSize()
                        .padding(.horizontal, 8).frame(height: 20)
                        .background(RoundedRectangle(cornerRadius: 4).fill(on ? JB.panel2 : .clear))
                        .contentShape(Rectangle())
                }
                .buttonStyle(Press())
            }
        }
        .padding(1)
        .background(RoundedRectangle(cornerRadius: 5).fill(JB.bg.opacity(0.6)))
        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(JB.line))
        .animation(.spring(response: 0.25, dampingFraction: 0.8), value: value)
    }
}

/// a number between min and max: the value follows the drag, the server hears of it when let go
struct SliderRow: View {
    let input: PanelInput
    let value: Double
    let commit: (Double) -> Void
    @State private var drag: Double?
    var body: some View {
        let lo = input.min ?? 0, hi = input.max ?? 100
        HStack(spacing: 6) {
            if let l = input.label { Text(l).font(.system(size: 11.5)).foregroundStyle(JB.muted) }
            Slider(value: Binding(get: { drag ?? min(max(value, lo), hi) }, set: { drag = $0 }),
                   in: lo...hi, step: input.step ?? (hi - lo) / 100,
                   onEditingChanged: { editing in if !editing, let d = drag { drag = nil; commit(d) } })
                .tint(JB.accent).frame(width: 110)
            Text([format(drag ?? min(max(value, lo), hi)), input.unit].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " "))
                .font(.system(size: 11.5)).foregroundStyle(JB.ink).monospacedDigit().frame(minWidth: 34, alignment: .trailing)
        }
        .help(input.label ?? input.name)
    }
    private func format(_ v: Double) -> String {
        v.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(v)) : String(format: "%g", v)
    }
}

/// a search box: the views it filters follow each keystroke; the server hears of it after a short pause
struct SearchField: View {
    let value: String
    let label: String?
    let commit: (String) -> Void
    @State private var text = ""
    @State private var send: Task<Void, Never>?
    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "magnifyingglass").font(.system(size: 10.5)).foregroundStyle(JB.muted)
            TextField("", text: $text, prompt: label.map { Text($0).foregroundStyle(JB.muted2) })
                .textFieldStyle(.plain).font(.system(size: 11.5)).frame(width: 130)
            if !text.isEmpty {
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill").font(.system(size: 10)).foregroundStyle(JB.muted2) }
                    .buttonStyle(Press())
            }
        }
        .padding(.horizontal, 7).frame(height: 22)
        .background(RoundedRectangle(cornerRadius: 5).fill(JB.bg.opacity(0.6)))
        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(JB.line))
        .onAppear { text = value }
        .onChange(of: text) { _, t in
            send?.cancel()
            send = Task { try? await Task.sleep(for: .milliseconds(350)); if !Task.isCancelled { commit(t) } }
        }
    }
}

/// one of the agent's buttons: a run shows its output under the panel, an ask lights up when sent
struct PanelStripButton: View {
    let model: PanelModel
    let index: Int
    let json: JSONValue
    @State private var busy = false
    @State private var sent = false
    var body: some View {
        let label = json["label"]?.string ?? "…"
        Button {
            guard !busy else { return }
            busy = true
            Task { let ok = await model.actions.button(index); busy = false; if ok { sent = true; try? await Task.sleep(for: .seconds(1.5)); sent = false } }
        } label: {
            HStack(spacing: 5) {
                if busy { ProgressView().controlSize(.mini) }
                else if sent { Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(JB.ok) }
                else if let s = json["icon"]?.string { Image(systemName: s).font(.system(size: 10.5)) }
                Text(label).font(.system(size: 11.5, weight: .medium)).lineLimit(1).fixedSize()
            }
            .foregroundStyle(JB.ink)
            .padding(.horizontal, 8).frame(height: 22)
            .background(RoundedRectangle(cornerRadius: 5).fill(JB.panel2))
        }
        .buttonStyle(Press())
        .help(json["run"]?.array.map { $0.compactMap(\.string).joined(separator: " ") } ?? json["ask"]?.string ?? "")
    }
}
