import XCTest
import AppKit
import SwiftUI
import TaksimKit
@testable import Taksim

final class GraphInteractionTests: XCTestCase {
    @MainActor private func graph() throws -> GraphView {
        let json = ##"{"id":"test","name":"Studio","agents":[{"id":"a","name":"Design","backend":"claude","pos":[60,100],"cardSize":[220,100]},{"id":"b","name":"Build","backend":"codex","pos":[320,100],"cardSize":[220,100]}],"groups":[{"id":"g","name":"Workspace","rect":[20,20,570,230],"color":"#548af7"}]}"##
        let store = CanvasStore(api: APIClient(base: URL(string: "http://127.0.0.1:1")!))
        store.load(try JSONDecoder().decode(Canvas.self, from: Data(json.utf8)))
        let view = GraphView(frame: CGRect(x: 0, y: 0, width: 900, height: 500))
        view.store = store
        return view
    }

    /// A folded node's width, its title and its size must not ask each other in a circle (the 2026-10-14 crash
    /// reports, a dev build: shortTitle > nameEnd > collapsedWidth > size, until the stack ran out), and a node or
    /// group saved with too few numbers in its geometry must draw, not trap.
    @MainActor func testFoldedNodesSizeWithoutRecursingAndBadGeometryDoesNotTrap() throws {
        let json = ##"{"id":"test","name":"Studio","agents":[{"id":"a","name":"A very long agent name that cannot fit in a folded node at all","backend":"claude","pos":[60,100],"collapsed":true},{"id":"b","name":"Short","backend":"codex","pos":[1],"cardSize":[220],"collapsed":true},{"id":"c","name":"","backend":"codex","pos":[],"size":[]}],"groups":[{"id":"g","name":"Short rect","rect":[1,2],"color":"#548af7"}]}"##
        let store = CanvasStore(api: APIClient(base: URL(string: "http://127.0.0.1:1")!))
        store.load(try JSONDecoder().decode(Canvas.self, from: Data(json.utf8)))
        let view = GraphView(frame: CGRect(x: 0, y: 0, width: 900, height: 500))
        view.store = store
        for id in ["a", "b", "c"] {
            let a = try XCTUnwrap(store.agents[id])
            let w = view.size(a).width
            XCTAssertTrue(w.isFinite && w > 0, "\(id) width \(w)")
            XCTAssertLessThanOrEqual(w, view.expandedSize(a).width)
            XCTAssertFalse(view.shortTitle(a).isEmpty && !a.name.isEmpty)
            _ = view.rectOf(a); _ = view.pos(a)
        }
        XCTAssertEqual(view.groupRect(view.groups[0]), .zero)
    }

    @MainActor func testReleaseOutsideKeepsPositionEvenWhenCardOverlapsGroup() throws {
        for zoom in [CGFloat(0.5), 1, 2] {
            let view = try graph()
            view.scale = zoom
            view.selected = ["a"]
            view.beginNodeDrag(at: .zero)
            view.store.preview("a", pos: [500, 100])
            XCTAssertTrue(view.rectOf(view.store.agents["a"]!).intersects(view.groupRect(view.groups[0])))
            XCTAssertEqual(view.membershipChanges().filter { $0.kind == .leave }.count, 1)
            view.finishMembership()
            XCTAssertEqual(view.store.agents["a"]?.pos, [500, 100])
            XCTAssertNil(view.innerGroup(of: view.store.agents["a"]!))
        }
    }

    @MainActor func testReenterBeforeReleasePreservesMembership() throws {
        let view = try graph()
        view.selected = ["a"]
        view.beginNodeDrag(at: .zero)
        view.store.preview("a", pos: [650, 100])
        view.store.preview("a", pos: [100, 100])
        view.finishMembership()
        XCTAssertTrue(view.membershipChanges().isEmpty)
        XCTAssertEqual(view.innerGroup(of: view.store.agents["a"]!)?.id, "g")
        XCTAssertEqual(view.store.agents["a"]?.pos, [100, 100])
    }

    @MainActor func testNavigatorRevealsOffscreenAgentWithoutMovingIt() throws {
        let view = try graph()
        view.store.preview("a", pos: [4000, -2000])
        view.revealAgent("a")
        if let animation = view.viewAnim {
            view.scale = animation.to.0
            view.offset = animation.to.1
            view.viewAnim = nil
        }
        let agent = try XCTUnwrap(view.store.agents["a"])
        let center = view.toScreen(view.centerOf(agent))
        XCTAssertEqual(center.x, view.bounds.midX, accuracy: 0.01)
        XCTAssertEqual(center.y, view.bounds.midY, accuracy: 0.01)
        XCTAssertTrue(view.bounds.contains(view.screenRect(view.rectOf(agent))))
        XCTAssertEqual(view.selected, ["a"])
        XCTAssertEqual(agent.pos, [4000, -2000])
        view.revealAgent("missing")
        XCTAssertEqual(view.selected, ["a"])
        view.timer?.invalidate()
    }

    @MainActor func testRenderReviewArtifacts() async throws {
        guard let folder = ProcessInfo.processInfo.environment["TAKSIM_UI_REVIEW"] else { return }
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        let view = try graph()
        for dark in [false, true] {
            view.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            view.selected = ["a"]
            view.beginNodeDrag(at: .zero)
            view.store.preview("a", pos: [500, 290])
            view.draggingItems = true
            let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
            view.cacheDisplay(in: view.bounds, to: rep)
            try rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: "\(folder)/canvas-\(dark ? "dark" : "light").png"))
            view.store.preview("a", pos: [60, 100])
            let host = NSHostingView(rootView: SettingsView(model: AppModel()).environment(\.colorScheme, dark ? .dark : .light))
            let window = NSWindow(contentRect: CGRect(x: -3000, y: 0, width: 900, height: 600), styleMask: [.borderless], backing: .buffered, defer: false)
            window.appearance = view.appearance
            window.contentView = host
            window.orderFrontRegardless()
            try await Task.sleep(for: .milliseconds(200))
            host.layoutSubtreeIfNeeded()
            let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            try bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: "\(folder)/settings-\(dark ? "dark" : "light").png"))
            window.orderOut(nil)
            let model = AppModel()
            model.store = view.store
            model.showNavigator = true
            let appHost = NSHostingView(rootView: ContentView(model: model).environment(\.colorScheme, dark ? .dark : .light))
            let appWindow = NSWindow(contentRect: CGRect(x: -3000, y: 0, width: 1100, height: 650), styleMask: [.borderless], backing: .buffered, defer: false)
            appWindow.appearance = view.appearance
            appWindow.contentView = appHost
            appWindow.orderFrontRegardless()
            try await Task.sleep(for: .milliseconds(300))
            appHost.layoutSubtreeIfNeeded()
            let appBitmap = try XCTUnwrap(appHost.bitmapImageRepForCachingDisplay(in: appHost.bounds))
            appHost.cacheDisplay(in: appHost.bounds, to: appBitmap)
            try appBitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: "\(folder)/app-\(dark ? "dark" : "light").png"))
            appWindow.orderOut(nil)

        }
    }
}
