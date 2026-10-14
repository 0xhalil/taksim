import Foundation
import Testing
import TaksimKit

/// Against a running demo server: TAKSIM_LIVE_URL=<base url>. Skipped otherwise.
@Suite struct TabCloseLiveTests {
    private struct List: Decodable { var canvases: [CanvasSummary] }

    @Test @MainActor func aClosedTabIsDeletedOnceItsUndoMomentPasses() async throws {
        guard let u = ProcessInfo.processInfo.environment["TAKSIM_LIVE_URL"], let base = URL(string: u) else { return }
        let api = APIClient(base: base)
        let store = CanvasStore(api: api)
        let keep: Canvas = try await api.post("/v1/canvases", ["name": "kalan"], as: Canvas.self)
        let gone: Canvas = try await api.post("/v1/canvases", ["name": "giden"], as: Canvas.self)
        _ = try await api.post("/v1/canvases/\(gone.id)/agents", ["model": "fake-echo"], as: Agent.self)
        await store.start(prefer: gone.id)
        #expect(store.currentId == gone.id)

        // closed: gone from the tabs at once, back with Geri al
        await store.closeTabs([gone.id], ordered: store.visibleCanvases.map(\.id))
        #expect(!store.visibleCanvases.contains { $0.id == gone.id })
        #expect(store.undoable.map(\.id) == [gone.id])
        await store.undoClose()
        #expect(store.visibleCanvases.contains { $0.id == gone.id })
        #expect(store.currentId == gone.id)

        // closed again and left: deleted from the server, its agents with it
        await store.closeTabs([gone.id], ordered: store.visibleCanvases.map(\.id))
        try await Task.sleep(for: .seconds(CanvasStore.undoSeconds + 1.5))
        let ids = try await api.get("/v1/canvases", as: List.self).canvases.map(\.id)
        #expect(!ids.contains(gone.id))
        #expect(ids.contains(keep.id))
        #expect(store.undoable.isEmpty)
        _ = try? await api.delete("/v1/canvases/\(keep.id)")
    }
}
