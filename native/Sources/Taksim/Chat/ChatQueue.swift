import SwiftUI
import TaksimKit
import UniformTypeIdentifiers

/// Pending requests stay next to the composer; editing and dragging never affect the active turn.
struct ChatQueue: View {
    let model: ChatModel
    @Environment(\.isSnapshot) private var isSnapshot
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "text.line.first.and.arrowtriangle.forward")
                Text(L("%d queued", model.queue.count))
                Spacer()
                if model.queueBusy { Image(systemName: "ellipsis").foregroundStyle(JB.accent) }
            }
            .font(.system(size: 10.5)).foregroundStyle(JB.muted).padding(.horizontal, 10).frame(height: 24)
            if isSnapshot || model.queue.count <= 3 { rows }
            else { ScrollView { rows }.frame(maxHeight: 160) }
            Rectangle().fill(JB.line).frame(height: 1)
        }
        .background(JB.panel)
        .animation(reduceMotion || isSnapshot ? nil : .spring(response: 0.35, dampingFraction: 0.85), value: model.queue.map(\.id))
    }

    private var rows: some View {
        VStack(spacing: 2) {
            ForEach(model.queue) { message in
                if isSnapshot { QueuedMessageRow(message: message, model: model) }
                else { QueuedMessageRow(message: message, model: model)
                    .onDrop(of: [.plainText], isTargeted: nil) { providers in
                        guard !model.queueBusy, let provider = providers.first else { return false }
                        _ = provider.loadObject(ofClass: String.self) { value, _ in
                            guard let id = value else { return }
                            Task { @MainActor in
                                var ids = model.queue.map(\.id)
                                guard id != message.id, let from = ids.firstIndex(of: id), let to = ids.firstIndex(of: message.id) else { return }
                                ids.remove(at: from)
                                ids.insert(id, at: to)
                                _ = await model.changeQueue(["order": ids])
                            }
                        }
                        return true
                    }
                }
            }
        }
        .padding(.horizontal, 8).padding(.bottom, 6)
    }
}

private struct QueuedMessageRow: View {
    let message: QueuedChatMessage
    let model: ChatModel
    @State private var editing = false
    @State private var text = ""
    @FocusState private var focused: Bool
    @Environment(\.isSnapshot) private var isSnapshot

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            if isSnapshot { grip }
            else { grip.onDrag { NSItemProvider(object: message.id as NSString) }.help(L("Reorder")) }
            VStack(alignment: .leading, spacing: 4) {
                if editing {
                    TextField(L("Message"), text: $text, axis: .vertical).textFieldStyle(.plain).lineLimit(1...5)
                        .focused($focused).onSubmit { save() }
                        .onKeyPress(.escape) { editing = false; return .handled }
                } else {
                    Text(message.text.isEmpty ? L("Attachment") : message.text).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                        .onTapGesture(count: 2) { edit() }
                }
                if !message.attachments.isEmpty { ChipRow(items: message.attachments) }
            }
            .font(.system(size: 11.5)).foregroundStyle(JB.ink).padding(.vertical, 3)
            Button { if editing { save() } else { edit() } } label: {
                Image(systemName: editing ? "checkmark" : "pencil").frame(width: 20, height: 22)
            }
            .buttonStyle(Tap()).help(editing ? L("Save") : L("Edit"))
            Button { Task { _ = await model.changeQueue(["id": message.id], cancel: true) } } label: {
                Image(systemName: "xmark").frame(width: 20, height: 22)
            }
            .buttonStyle(Tap()).help(L("Remove from queue"))
        }
        .font(.system(size: 10)).foregroundStyle(JB.muted)
        .padding(5).background(RoundedRectangle(cornerRadius: 6).fill(JB.panel2))
        .disabled(model.queueBusy)
    }

    private var grip: some View {
        Image(systemName: "line.3.horizontal").font(.system(size: 10)).foregroundStyle(JB.muted2).frame(width: 18, height: 22)
    }

    private func edit() { text = message.text; editing = true; focused = true }
    private func save() {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !message.attachments.isEmpty else { return }
        Task { if await model.changeQueue(["id": message.id, "text": text]) { editing = false } }
    }
}
