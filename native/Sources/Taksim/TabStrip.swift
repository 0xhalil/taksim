import AppKit
import SwiftUI
import TaksimKit

struct TabStrip: View {
    let store: CanvasStore
    @AppStorage("tabOrder") private var orderJSON = "[]"
    @State private var offset: CGFloat = 0
    @State private var renaming: String?
    @State private var draft = ""
    @Environment(\.isSnapshot) private var isSnapshot

    private var tabs: [CanvasSummary] {
        let order = (try? JSONDecoder().decode([String].self, from: Data(orderJSON.utf8))) ?? []
        let rank = { (c: CanvasSummary) in order.firstIndex(of: c.id) ?? Int.max }
        return store.visibleCanvases.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map(\.element)
    }

    var body: some View {
        GeometryReader { geo in
            // the branch control takes its room from the tabs while the canvas works in a git repo
            let branchRoom = store.branches?.repos.isEmpty == false ? BranchControl.width : 0
            let layout = TabLayout(width: geo.size.width - branchRoom, count: tabs.count)
            let hidden = layout.hidden(offset: offset, count: tabs.count)
            ScrollViewReader { proxy in
                HStack(spacing: 0) {
                    if layout.overflowing {
                        arrow(.left, disabled: hidden.left == 0, help: L("%d tabs on the left", hidden.left), action: {
                            scroll(proxy, layout: layout, direction: -1)
                        }).contextMenu { Button(L("Go to first tab")) { reveal(tabs.first?.id, proxy: proxy, anchor: .leading) } }
                    }
                    // ImageRenderer can't draw a ScrollView or a Menu: snapshots get the plain row
                    if isSnapshot {
                        HStack(spacing: 0) { ForEach(tabs) { tab($0).frame(width: layout.tabWidth) } }
                            .frame(width: layout.viewport, alignment: .leading).clipped()
                    } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 0) {
                            ForEach(tabs) { canvas in
                                tab(canvas).frame(width: layout.tabWidth).id(canvas.id)
                                    .draggable(canvas.id)
                                    .dropDestination(for: String.self) { items, _ in
                                        guard let id = items.first, tabs.contains(where: { $0.id == id }) else { return false }
                                        move(id, before: canvas.id)
                                        return true
                                    }
                            }
                        }.frame(height: ChromeMetrics.tabHeight)
                    }
                    .frame(width: layout.viewport)
                    .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.x } action: { _, value in offset = value }
                    .clipped()
                    }
                    if layout.overflowing {
                        arrow(.right, disabled: hidden.right == 0, help: L("%d tabs on the right", hidden.right), action: {
                            scroll(proxy, layout: layout, direction: 1)
                        }).contextMenu { Button(L("Go to last tab")) { reveal(tabs.last?.id, proxy: proxy, anchor: .trailing) } }
                    }
                    Button { Task { await store.newCanvas() } } label: { AppIcon.plus.frame(width: ChromeMetrics.icon, height: ChromeMetrics.icon) }
                        .buttonStyle(IconButton()).help(L("New canvas  ⌘T")).accessibilityLabel(L("New canvas"))
                    if !layout.overflowing { Spacer(minLength: 0) }
                    BranchControl(store: store)
                    if !isSnapshot { canvasMenu(proxy: proxy) }
                }
                .padding(.horizontal, ChromeMetrics.inset)
                .onChange(of: store.currentId) { _, id in reveal(id, proxy: proxy) }
                .onChange(of: geo.size.width) { reveal(store.currentId, proxy: proxy) }
                .onChange(of: tabs.map(\.id)) { reveal(store.currentId, proxy: proxy) }
                .onAppear { reveal(store.currentId, proxy: proxy) }
            }
        }
        .frame(height: ChromeMetrics.tabHeight)
        .background(JB.panel)
        .overlay(alignment: .bottom) { Rectangle().fill(JB.line).frame(height: 1) }
    }

    private func canvasMenu(proxy: ScrollViewProxy) -> some View {
        Menu {
            if !tabs.isEmpty {
                Button(L("Go to first tab")) { reveal(tabs.first?.id, proxy: proxy, anchor: .leading) }
                Button(L("Go to last tab")) { reveal(tabs.last?.id, proxy: proxy, anchor: .trailing) }
                Divider()
                ForEach(tabs) { c in
                    Button {
                        Task { await store.open(c.id); reveal(c.id, proxy: proxy) }
                    } label: {
                        Label(c.name, systemImage: c.id == store.currentId ? "checkmark" : store.lockedTabs.contains(c.id) ? "lock.fill" : "rectangle")
                    }
                }
            }
        } label: { Image(nsImage: AppIcon.down.templateImage) }
        .menuStyle(.borderlessButton).menuIndicator(.hidden)
        .frame(width: ChromeMetrics.control, height: ChromeMetrics.control)
        .help(L("All tabs")).accessibilityLabel(L("All tabs"))
    }

    private func tab(_ c: CanvasSummary) -> some View {
        CanvasTab(canvas: c, active: c.id == store.currentId, locked: store.lockedTabs.contains(c.id),
                  renaming: renaming == c.id, draft: $draft,
                  onClose: { close([c.id]) }, onSelect: { Task { await store.open(c.id) } },
                  onRename: { draft = c.name; renaming = c.id },
                  onCommit: {
                      let name = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                      renaming = nil
                      if !name.isEmpty, name != c.name { Task { await store.rename(canvas: c.id, to: name) } }
                  }, onCancel: { renaming = nil })
        .contextMenu {
            let ids = tabs.map(\.id)
            let index = ids.firstIndex(of: c.id) ?? 0
            Button(store.lockedTabs.contains(c.id) ? L("Unlock tab") : L("Lock tab")) { store.toggleTabLock(c.id) }
            Divider()
            closeItem(L("Close tab"), ids: [c.id])
            closeItem(L("Close other tabs"), ids: Set(ids.filter { $0 != c.id }))
            closeItem(L("Close tabs to the right"), ids: Set(ids.dropFirst(index + 1)))
            closeItem(L("Close tabs to the left"), ids: Set(ids.prefix(index)))
            closeItem(L("Close all tabs"), ids: Set(ids))
            Divider()
            Button(L("Rename")) { draft = c.name; renaming = c.id }
        }
    }

    private func closeItem(_ title: String, ids: Set<String>) -> some View {
        Button(title) { close(ids) }.disabled(ids.subtracting(store.lockedTabs).isEmpty)
    }
    private func close(_ ids: Set<String>) {
        let ordered = tabs.map(\.id)
        Task { await store.closeTabs(ids, ordered: ordered) }
    }
    private func move(_ id: String, before target: String) {
        guard id != target else { return }
        var ids = tabs.map(\.id)
        ids.removeAll { $0 == id }
        ids.insert(id, at: ids.firstIndex(of: target) ?? ids.count)
        orderJSON = String(decoding: (try? JSONEncoder().encode(ids)) ?? Data("[]".utf8), as: UTF8.self)
    }
    private enum Direction { case left, right }
    private func arrow(_ direction: Direction, disabled: Bool, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { (direction == .left ? AppIcon.left : AppIcon.right).frame(width: ChromeMetrics.icon, height: ChromeMetrics.icon) }
            .buttonStyle(IconButton()).disabled(disabled).help(help).accessibilityLabel(direction == .left ? L("Previous tabs") : L("Next tabs"))
    }
    private func scroll(_ proxy: ScrollViewProxy, layout: TabLayout, direction: Int) {
        guard !tabs.isEmpty else { return }
        let index = layout.target(offset: offset, direction: direction, count: tabs.count)
        reveal(tabs[index].id, proxy: proxy, anchor: .leading)
    }
    private func reveal(_ id: String?, proxy: ScrollViewProxy, anchor: UnitPoint? = nil) {
        guard let id else { return }
        withAnimation(.easeOut(duration: 0.18)) { proxy.scrollTo(id, anchor: anchor) }
    }
}

struct CanvasTab: View {
    let canvas: CanvasSummary
    let active: Bool
    let locked: Bool
    let renaming: Bool
    @Binding var draft: String
    let onClose: () -> Void
    let onSelect: () -> Void
    let onRename: () -> Void
    let onCommit: () -> Void
    let onCancel: () -> Void
    @State private var hover = false
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            CanvasIcon(name: canvas.name, busy: (canvas.busy ?? 0) > 0)
            if renaming {
                TextField(L("Canvas name"), text: $draft).textFieldStyle(.plain).focused($focused)
                    .onSubmit(onCommit).onAppear { focused = true }
                    .onExitCommand(perform: onCancel)
                    .onChange(of: focused) { _, value in if !value && renaming { onCommit() } }
            } else {
                // a name the first request gave it fades in where "canvas 2" was
                Text(canvas.name).lineLimit(1).truncationMode(.tail)
                    .contentTransition(.opacity).animation(.easeOut(duration: 0.35), value: canvas.name)
            }
            Spacer(minLength: 0)
            if locked {
                AppIcon.lock.frame(width: 10, height: 10).foregroundStyle(JB.muted)
                    .frame(width: 20, height: 24).help(L("Tab locked; right-click to unlock"))
                    .accessibilityLabel(L("Locked tab"))
            } else {
                Button(action: onClose) { AppIcon.close.frame(width: 9, height: 9) }
                    .buttonStyle(CloseButtonStyle())
                    .frame(width: 22, height: 24)
                    .opacity(active || hover ? 1 : 0)
                    .scaleEffect(active || hover ? 1 : 0.6)
                    .animation(.spring(response: 0.25, dampingFraction: 0.75), value: active || hover)
                    .help(L("Close tab")).accessibilityLabel(L("Close %@ tab", canvas.name))
            }
        }
        .font(.system(size: 12))
        .foregroundStyle(active || hover ? JB.ink : JB.text)
        .padding(.leading, 12).padding(.trailing, 4)
        .frame(height: ChromeMetrics.tabHeight)
        .background(active ? JB.bg : hover ? JB.tint : .clear)
        .animation(.easeOut(duration: 0.15), value: hover)
        .overlay(alignment: .trailing) { Rectangle().fill(JB.line.opacity(0.5)).frame(width: 1).padding(.vertical, 8) }
        .overlay(alignment: .bottom) { if active { Rectangle().fill(JB.accent).frame(height: 3) } }
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture(count: 2, perform: onRename)
        .onTapGesture(perform: onSelect)
        .help(canvas.name)
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }
}

/// A canvas's icon: its initial on a color of its own, like a PyCharm project icon; a green dot while agents work.
struct CanvasIcon: View {
    let name: String
    var busy = false
    var size: CGFloat = 16
    @State private var pulse = false

    var body: some View {
        RoundedRectangle(cornerRadius: size / 4)
            .fill(JB.icon(for: name))
            .frame(width: size, height: size)
            .overlay {
                Text(initial).font(.system(size: size * 0.6, weight: .bold)).foregroundStyle(.white)
            }
            .overlay(alignment: .bottomTrailing) {
                if busy {
                    Circle().fill(JB.ok).frame(width: 8, height: 8)
                        .overlay(Circle().stroke(JB.panel, lineWidth: 2))
                        .offset(x: 3, y: 3)
                        .opacity(pulse ? 0.35 : 1)
                        .onAppear { withAnimation(.easeInOut(duration: 0.7).repeatForever()) { pulse = true } }
                }
            }
    }

    private var initial: String {
        let ch = name.first { $0.isLetter || $0.isNumber }
        return ch.map { String($0).uppercased(with: Locale(identifier: "tr")) } ?? "?"
    }
}

/// Toolbar-style icon button: quiet until hovered.
struct IconButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Hovering { hover in
            configuration.label
                .foregroundStyle(hover ? JB.ink : JB.muted)
                .frame(width: ChromeMetrics.control, height: ChromeMetrics.control)
                .background(RoundedRectangle(cornerRadius: 4).fill(configuration.isPressed ? JB.panel2 : hover ? JB.tint : .clear))
                .scaleEffect(configuration.isPressed ? 0.9 : 1)
                .animation(.spring(response: 0.22, dampingFraction: 0.6), value: configuration.isPressed)
                .animation(.easeOut(duration: 0.12), value: hover)
        }
    }
}

struct Hovering<Content: View>: View {
    @ViewBuilder let content: (Bool) -> Content
    @State private var hover = false
    var body: some View { content(hover).onHover { hover = $0 } }
}
