import AppKit
import TaksimKit
import UserNotifications

/// What happens on the canvas while you look elsewhere: a notification when an agent finishes a turn, fails,
/// or has a panel waiting for approval (only while the app is in the background), and the number of working
/// agents on the Dock icon. Permission is asked the first time there is something to say.
@MainActor
final class AgentNotifier: NSObject, UNUserNotificationCenterDelegate {
    weak var model: AppModel?
    let store: CanvasStore
    private var asked = false
    private var badgeTimer: Timer?

    init(model: AppModel, store: CanvasStore) {
        self.model = model
        self.store = store
        super.init()
        if Bundle.main.bundleIdentifier != nil { UNUserNotificationCenter.current().delegate = self }
        store.listeners.append { [weak self] ev in self?.handle(ev) }
        badgeTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.updateBadge() }
        }
    }

    private struct Turn: Decodable { var id: String; var text: String?; var error: String? }
    private struct PanelEvent: Decodable { var id: String; var panel: Panel?; struct Panel: Decodable { var status: String?; var spec: Spec?; struct Spec: Decodable { var title: String? } } }

    private func handle(_ ev: ServerEvent) {
        switch ev.type {
        case "turn_done":
            guard let t = try? JSONDecoder().decode(Turn.self, from: ev.data), let a = store.agents[t.id] else { return }
            notify(a, body: String((t.text ?? "").prefix(180)), kind: "done")
        case "turn_failed":
            guard let t = try? JSONDecoder().decode(Turn.self, from: ev.data), let a = store.agents[t.id] else { return }
            notify(a, body: "⚠︎ " + String((t.error ?? "").prefix(160)), kind: "failed")
        case "panel_updated":
            guard let p = try? JSONDecoder().decode(PanelEvent.self, from: ev.data), p.panel?.status == "pending", let a = store.agents[p.id] else { return }
            notify(a, body: "⏸ " + (p.panel?.spec?.title ?? "Panel"), kind: "approval")
        default: break
        }
    }

    private func notify(_ a: Agent, body: String, kind: String) {
        guard !NSApp.isActive, Bundle.main.bundleIdentifier != nil, Self.on("notify.\(kind)") else { return }
        let sound = Self.on("notify.sound")
        let center = UNUserNotificationCenter.current()
        let send = {
            let c = UNMutableNotificationContent()
            c.title = a.name
            c.body = body.trimmingCharacters(in: .whitespacesAndNewlines)
            c.sound = kind == "done" || !sound ? nil : .default
            c.threadIdentifier = a.id
            c.userInfo = ["agent": a.id, "canvas": self.store.currentId ?? ""]
            center.add(UNNotificationRequest(identifier: "\(a.id)-\(kind)-\(Date().timeIntervalSince1970)", content: c, trigger: nil))
        }
        if asked { send(); return }
        asked = true
        center.requestAuthorization(options: [.alert, .sound, .badge]) { ok, _ in
            if ok { DispatchQueue.main.async(execute: send) }
        }
    }

    /// a switch in Settings › General; on unless turned off
    private static func on(_ key: String) -> Bool { UserDefaults.standard.object(forKey: key) as? Bool ?? true }

    private func updateBadge() {
        guard Self.on("dockBadge") else { return }
        let n = store.currentAgents.filter { $0.status == "running" }.count
        let label = n > 0 ? "\(n)" : nil
        if NSApp.dockTile.badgeLabel != label { NSApp.dockTile.badgeLabel = label }
    }

    // a click on a notification brings its agent into view
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let id = info["agent"] as? String, canvas = info["canvas"] as? String
        await MainActor.run {
            NSApp.activate(ignoringOtherApps: true)
            guard let id, let model else { return }
            Task {
                if let canvas, !canvas.isEmpty, canvas != store.currentId { await store.open(canvas) }
                model.focusAgent(id)
            }
        }
    }
}
