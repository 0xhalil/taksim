import Foundation
import Testing
import AppKit
import SwiftUI
import TaksimKit
@testable import Taksim

@Suite struct ChatTests {
    @Test func answersSplitIntoTextAndFencedCode() {
        let b = ChatMarkdown.blocks("Önce:\n```swift\nlet x = 1\n```\nsonra **bitti**")
        #expect(b.count == 3)
        if case .code(let lang, let code) = b[1] { #expect(lang == "swift"); #expect(code == "let x = 1") } else { Issue.record("no code block") }
        // while streaming, an open fence runs to the end
        let s = ChatMarkdown.blocks("bak:\n```\nyarım")
        if case .code(_, let code) = s.last! { #expect(code == "yarım") } else { Issue.record("no open block") }
    }

    @Test func markdownStructuresAndNestedFencesRemainStableWhileStreaming() {
        let blocks = ChatMarkdown.blocks("# Başlık\n\n- [x] bitti\n  - iç\n1. sıra\n> alıntı\n\n| Ad | Durum |\n| --- | :---: |\n| a | hazır |\n\n````swift\n```nested\nlet x = 1\n````")
        #expect(blocks.contains(.heading(1, "Başlık")))
        #expect(blocks.contains(.item("☑", 0, "bitti")))
        #expect(blocks.contains(.item("•", 1, "iç")))
        #expect(blocks.contains(.item("1.", 0, "sıra")))
        #expect(blocks.contains(.quote("alıntı")))
        #expect(blocks.contains(.table([["Ad", "Durum"], ["a", "hazır"]])))
        #expect(blocks.last == .code("swift", "```nested\nlet x = 1"))
        #expect(ChatMarkdown.blocks("~~~python\nx = 1") == [.code("python", "x = 1")])
    }

    @Test @MainActor func toolLifecycleRetainsIdentityAndNeverCarriesIntoTheNextTurn() {
        let m = ChatModel(api: .init(base: URL(string: "http://127.0.0.1:1")!), canvas: "c", agent: "a")
        m.takeActivity(.init(id: "1", label: "Read", detail: "app.py", status: "running"), reset: false)
        m.takeActivity(.init(id: "1", label: "Read", detail: "app.py", status: "done"), reset: false)
        #expect(m.activities.count == 1)
        #expect(m.activities[0].status == "done")
        m.delta("old")
        m.takeActivity(nil, reset: true)
        #expect(m.activities.isEmpty && m.streaming.isEmpty)
    }

    @Test @MainActor func duplicateEventsAreIgnoredAndTurnsKeepTheirCheckpoint() {
        let m = ChatModel(api: .init(base: URL(string: "http://127.0.0.1:1")!), canvas: "c", agent: "a")
        m.entries = [ChatEntry(ts: 1, from: "user", to: "a", kind: "user", text: "selam")]
        m.take(ChatEntry(ts: 1, from: "user", to: "a", kind: "user", text: "selam"))
        #expect(m.entries.count == 1 && m.entries[0].ts == 1)
        m.entries = [ChatEntry(ts: 1, from: "user", to: "a", kind: "user", text: "x"),
                     ChatEntry(ts: 2, from: "a", to: "user", kind: "assistant", text: "y", checkpoint: "abc")]
        #expect(m.checkpoint(after: 0) == "abc")
        m.delta("ya"); m.delta("zı")
        #expect(m.streaming == "yazı")
        m.take(ChatEntry(ts: 3, from: "a", to: "user", kind: "assistant", text: "yazı"))
        #expect(m.streaming.isEmpty)
    }

    @Test @MainActor func messagesShowWhatThePersonDidAndRestoresSayWhichWay() {
        let applied = ChatEntry(from: "user", to: "a", kind: "user", text: "Implement this user-reviewed plan exactly.\n\n<approved_plan id=\"p-1\" version=\"12\">\n# Steps\n</approved_plan>")
        #expect(applied.appliedPlan == 12)
        let fix = ChatEntry(from: "user", to: "a", kind: "user", text: "My fix request for the a.txt change: lowercase\n\nReviewed turn: x → y\n<review_diff>\n+two\n</review_diff>")
        #expect(fix.appliedPlan == nil)
        #expect(fix.shownText == "My fix request for the a.txt change: lowercase")
        #expect(ChatEntry(from: "user", to: "a", text: "plain <approved_plan> talk").appliedPlan == nil)
        #expect(ChatEntry(from: "a", to: "user", text: applied.text).appliedPlan == nil)
        // undo, redo, undo, redo: the trees repeat (content hashes), the order tells back from forward
        let m = ChatModel(api: .init(base: URL(string: "http://127.0.0.1:1")!), canvas: "c", agent: "a")
        m.entries = [ChatEntry(ts: 1, from: "a", to: "user", kind: "assistant", text: "y", checkpoint: "before", after: "after"),
                     ChatEntry(ts: 2, from: "user", to: "a", kind: "restore", checkpoint: "before", redo: "after"),
                     ChatEntry(ts: 3, from: "user", to: "a", kind: "restore", checkpoint: "after", redo: "before"),
                     ChatEntry(ts: 4, from: "user", to: "a", kind: "restore", checkpoint: "before", redo: "after"),
                     ChatEntry(ts: 5, from: "user", to: "a", kind: "restore", checkpoint: "after", redo: "before"),
                     ChatEntry(ts: 6, from: "a", to: "user", kind: "assistant", text: "z", checkpoint: "after"),
                     ChatEntry(ts: 7, from: "user", to: "a", kind: "restore", checkpoint: "before", redo: "after")]
        #expect((0..<7).map(m.wentForward) == [false, false, true, false, true, false, false])
    }

    @Test func chipsSayWhatTheyAre() {
        #expect(ChatAttachment(kind: "selection", path: "src/app.py", from: 3, to: 9).label == "app.py 3–9")
        #expect(ChatAttachment(kind: "agent", name: "yazar").label == "@yazar")
    }

    @Test @MainActor func queueAgainstDemo() async throws {
        guard let base = ProcessInfo.processInfo.environment["TAKSIM_CHAT_TEST"], let url = URL(string: base),
              url.host == "127.0.0.1", [8790, 8791].contains(url.port ?? 0) else { return }
        LangState.testGate.lock()
        defer { LangState.shared.current = .english; LangState.testGate.unlock() }
        LangState.shared.current = .english
        let api = APIClient(base: url)
        struct C: Decodable { var id: String }
        let c = try await api.post("/v1/canvases", ["name": "Chat review"], as: C.self)
        do {
            let store = CanvasStore(api: api)
            store.load(try await api.get("/v1/canvases/\(c.id)", as: Canvas.self))
            let a = try await store.addAgent(["model": "fake-slow"])
            #expect(a.chat == true)
            #expect(!a.isTerminalOpen)
            let graph = GraphView(frame: CGRect(x: 0, y: 0, width: 900, height: 600))
            graph.store = store
            #expect(graph.hasTranscript(a))
            #expect(graph.size(a) == CGSize(width: 640, height: 360))
            let path = "/v1/canvases/\(c.id)/agents/\(a.id)"
            try await api.post("\(path)/messages", ["text": "active"])
            try await api.post("\(path)/messages", ["text": "pending", "attachments": [["kind": "file", "path": "Theme.swift"]]])
            let model = ChatModel(api: api, canvas: c.id, agent: a.id)
            await model.load()
            #expect(model.entries.count == 1)
            #expect(model.queue.count == 1)
            let item = try #require(model.queue.first)
            #expect(await model.changeQueue(["id": item.id, "text": "edited"]))
            #expect(model.queue.first?.text == "edited")
            #expect(model.queue.first?.attachments.first?.path == "Theme.swift")
            #expect(await model.changeQueue(["id": item.id], cancel: true))
            #expect(model.queue.isEmpty)
            #expect(await model.changeQueue(["id": item.id, "text": "late"]) == false)
            #expect(model.error == "Queue changed; the message may have started.")
            try await api.post("\(path)/stop")
            for _ in 0..<30 {
                let updated = try await api.get(path, as: Agent.self)
                if updated.status != "running" { break }
                try await Task.sleep(for: .milliseconds(100))
            }
            try await store.updateAgent(a.id, ["model": "fake-echo"])
            await model.setMode("plan", store: store)
            #expect(store.agents[a.id]?.chatMode == "plan")
            #expect(store.agents[a.id]?.sandbox == "read-only")
            try await api.post("\(path)/messages", ["text": "Plan", "wait": true])
            await model.load()
            let branch = try await store.forkChat(a.id, fields: [:])
            #expect(branch.chatOrigin?.id == a.id)
            #expect(branch.chatMode == "plan")
            #expect(!branch.isTerminalOpen)
            let branchModel = ChatModel(api: api, canvas: c.id, agent: branch.id)
            await branchModel.load()
            #expect(branchModel.entries.last?.text == model.entries.last?.text)
            #expect(await model.changeWorkflow(["action": "publish", "title": "Native plan", "content": "# Review\nValidate the selected version"], store: store))
            let reviewed = try #require(model.plan)
            #expect(await model.changeWorkflow(["id": reviewed.id, "version": reviewed.version, "content": "# Edited\nValidate"], store: store, edit: true))
            let edited = try #require(model.plan)
            #expect(edited.version == reviewed.version + 1)
            #expect(await model.changeWorkflow(["action": "build", "id": edited.id, "version": edited.version], store: store))
            #expect(store.agents[a.id]?.sandbox == nil)
            for _ in 0..<30 {
                await model.load()
                if model.plan?.status == "done" { break }
                try await Task.sleep(for: .milliseconds(100))
            }
            #expect(model.plan?.status == "done")
            try await api.delete("/v1/canvases/\(c.id)")
        } catch {
            try? await api.delete("/v1/canvases/\(c.id)")
            throw error
        }
    }

    @Test @MainActor func searchIncludesContextAndChangesAndReuseKeepsTheDraft() {
        LangState.testGate.lock()
        defer { LangState.shared.current = .english; LangState.testGate.unlock() }
        LangState.shared.current = .english
        let m = ChatModel(api: .init(base: URL(string: "http://127.0.0.1:1")!), canvas: "c", agent: "a")
        let attachment = ChatAttachment(kind: "selection", path: "src/café.swift", from: 2, to: 4, text: "let x = 1")
        m.entries = [ChatEntry(from: "user", to: "a", text: "Düzenle", attachments: [attachment]),
                     ChatEntry(from: "a", to: "user", text: "Bitti", changes: [ChatChange(path: "src/theme.swift", added: 1, removed: 2)])]
        #expect(m.matches("cafe") == [0])
        #expect(m.matches("THEME") == [1])
        #expect(m.matches("  ").isEmpty)
        let drafts = ChatDrafts()
        drafts.text["a"] = "Yeni istek"
        drafts.attachments["a"] = [attachment]
        drafts.reuse(m.entries[0], for: "a")
        #expect(drafts.text["a"] == "Yeni istek\n\nDüzenle")
        #expect(drafts.attachments["a"] == [attachment])
        #expect(drafts.focus == "a")
        let exported = ChatModel.markdown(m.entries, title: "Yazar", agent: "a")
        #expect(exported.contains("## You\n\nDüzenle"))
        #expect(exported.contains("src/café.swift · 2–4"))
        #expect(exported.contains("let x = 1"))
        #expect(exported.contains("src/theme.swift (+1, −2)"))
    }

    @Test @MainActor func tasksAgainstDemo() async throws {
        guard let base = ProcessInfo.processInfo.environment["TAKSIM_CHAT_TEST"], let url = URL(string: base),
              url.host == "127.0.0.1", url.port == 8791 else { return }
        let api = APIClient(base: url)
        struct C: Decodable { var id: String }
        let c = try await api.post("/v1/canvases", ["name": "Task review"], as: C.self)
        do {
            let agent = try await api.post("/v1/canvases/\(c.id)/agents", ["model": "fake-delegate", "chatMode": "agent", "chat": true], as: Agent.self)
            let path = "/v1/canvases/\(c.id)/agents/\(agent.id)"
            let store = CanvasStore(api: api)
            store.load(try await api.get("/v1/canvases/\(c.id)", as: Canvas.self))
            let model = ChatModel(api: api, canvas: c.id, agent: agent.id)
            func call(_ tool: String, _ args: [String: Any]) throws -> String {
                "CALL " + String(decoding: try JSONSerialization.data(withJSONObject: ["tool": tool, "args": args]), as: UTF8.self)
            }
            let todos = [["id": "one", "content": "Investigate", "status": "in_progress"], ["id": "two", "content": "Validate", "status": "pending"]]
            let text = try [call("update_todos", ["todos": todos]), call("ask_user", ["questions": [["title": "Continue?"]]]),
                            call("update_todos", ["merge": true, "todos": [["id": "one", "content": "Investigate", "status": "completed"]]])].joined(separator: "\n")
            try await api.post("\(path)/messages", ["text": text])
            for _ in 0..<50 {
                await model.load()
                if model.question != nil { break }
                try await Task.sleep(for: .milliseconds(100))
            }
            #expect(model.tasks.map(\.status) == ["in_progress", "pending"])
            let question = try #require(model.question)
            #expect(await model.changeWorkflow(["action": "answer", "id": question.id, "answers": ["q1": "Yes"]], store: store))
            for _ in 0..<50 {
                await model.load()
                if model.entries.last?.kind == "assistant" { break }
                try await Task.sleep(for: .milliseconds(100))
            }
            #expect(model.tasks.isEmpty)
            #expect(model.entries.last?.tasks?.map(\.status) == ["completed", "pending"])
            let exported = ChatModel.markdown(model.entries, title: "Review", agent: agent.id)
            #expect(exported.contains("- [x] Investigate"))
            #expect(exported.contains("- [ ] Validate"))
            try await api.delete("/v1/canvases/\(c.id)")
        } catch {
            _ = try? await api.delete("/v1/canvases/\(c.id)")
            throw error
        }
    }

    @Test @MainActor func renderTurnReview() throws {
        guard let folder = ProcessInfo.processInfo.environment["TAKSIM_CHAT_REVIEW"] else { return }
        let api = APIClient(base: URL(string: "http://127.0.0.1:1")!)
        let store = CanvasStore(api: api)
        let model = ChatModel(api: api, canvas: "c", agent: "a")
        let entry = ChatEntry(from: "a", to: "user", kind: "assistant", changes: [ChatChange(path: "src/app.swift", added: 3, removed: 2)], checkpoint: "before", after: "after")
        let data = ChatReviewData(path: "src/app.swift", binary: false, writable: true, status: "partial", diff: "", hunks: [
            .init(id: "one", header: "@@ -12,3 +12,3 @@", diff: " let theme = JB.panel\n-let spacing = 4\n+let spacing = 8\n", status: "kept"),
            .init(id: "two", header: "@@ -28,3 +28,4 @@", diff: " func render() {\n-    draw()\n+    withAnimation { draw() }\n }\n", status: "reverted")])
        let before = ThemeState.shared.choice; defer { ThemeState.shared.choice = before }
        for dark in [false, true] {
            ThemeState.shared.choice = dark ? .dark : .light
            let renderer = ImageRenderer(content: ChatReviewView(entry: entry, model: model, store: store, preview: data)
                .environment(\.isSnapshot, true).environment(\.colorScheme, dark ? .dark : .light).frame(width: 900, height: 620))
            renderer.scale = 2
            let rep = NSBitmapImageRep(cgImage: try #require(renderer.cgImage))
            try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
            try #require(rep.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: "\(folder)/review-\(dark ? "dark" : "light").png"))
        }
    }

    /// Offscreen native rendering: uses the same snapshot fallback as the application's review images.
    @Test @MainActor func renderChatReview() throws {
        guard let folder = ProcessInfo.processInfo.environment["TAKSIM_CHAT_REVIEW"] else { return }
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        let api = APIClient(base: URL(string: "http://127.0.0.1:1")!)
        let store = CanvasStore(api: api)
        var canvas = try JSONDecoder().decode(Canvas.self, from: Data(#"{"id":"c","name":"Studio","agents":[{"id":"a","name":"Yazar","model":"sonnet","backend":"claude","status":"running","queued":2}]}"#.utf8))
        store.load(canvas)
        let model = ChatModel(api: api, canvas: "c", agent: "a")
        model.loaded = true
        model.entries = [ChatEntry(ts: 1, from: "user", to: "a", text: "Sohbet arayüzünü sadeleştir.", attachments: [ChatAttachment(kind: "file", path: "ChatView.swift")]),
                         ChatEntry(ts: 2, from: "a", to: "user", kind: "assistant", text: "## Sohbet hazır\n\n- [x] Bağlam ve mesaj kuyruğu\n- [x] Klavye ile arama\n\n```swift\nlet style = JB.panel\n```", activities: [ChatActivity(id: "done", label: "Read", detail: "ChatView.swift", status: "done")], usage: ChatUsage(input: 820, output: 164), changes: [ChatChange(path: "ChatView.swift", added: 24, removed: 8)])]
        model.queue = [QueuedChatMessage(id: "q1", text: "Açık temayı da kontrol et.", attachments: [], ts: 3),
                       QueuedChatMessage(id: "q2", text: "Arama sonuçlarında dosya adları da bulunsun.", attachments: [ChatAttachment(kind: "file", path: "Theme.swift")], ts: 4)]
        model.activities = [ChatActivity(id: "live", label: "Komut", detail: "swift test --filter ChatTests", status: "running")]
        model.tasks = [ChatTask(id: "1", content: "Kaynakları araştır", status: "completed"), ChatTask(id: "2", content: "Mod sınırlarını doğrula", status: "in_progress"), ChatTask(id: "3", content: "Kontrolleri çalıştır", status: "blocked", priority: "high")]
        let before = ThemeState.shared.choice
        defer { ThemeState.shared.choice = before }
        for dark in [false, true] {
            ThemeState.shared.choice = dark ? .dark : .light
            let renderer = ImageRenderer(content: ChatView(model: model, store: store)
                .environment(\.isSnapshot, true).environment(\.colorScheme, dark ? .dark : .light)
                .frame(width: 480, height: 680))
            renderer.scale = 2
            let cg = try #require(renderer.cgImage)
            let rep = NSBitmapImageRep(cgImage: cg)
            try #require(rep.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: "\(folder)/chat-\(dark ? "dark" : "light").png"))
            canvas.agents[0].status = "idle"; canvas.agents[0].chatMode = "plan"; canvas.agents[0].queued = 0
            store.load(canvas)
            let savedQueue = model.queue, savedActivities = model.activities, savedTasks = model.tasks
            model.queue = []; model.activities = []; model.tasks = []
            let savedEntries = model.entries
            model.entries = []
            model.plan = ChatPlan(id: "p", version: 2, title: "Sohbet akışı", content: "## Yapılacaklar\n\n- [ ] Modları ayır\n- [ ] Plan sürümünü doğrula\n- [ ] Testleri çalıştır", status: "draft", updatedAt: 0)
            let plan = ImageRenderer(content: ChatView(model: model, store: store)
                .environment(\.isSnapshot, true).environment(\.colorScheme, dark ? .dark : .light).frame(width: 480, height: 680))
            plan.scale = 2
            let planRep = NSBitmapImageRep(cgImage: try #require(plan.cgImage))
            try #require(planRep.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: "\(folder)/plan-\(dark ? "dark" : "light").png"))
            model.entries = []; model.plan = nil
            model.question = ChatQuestion(id: "question", questions: [.init(id: "q1", title: "Plan nerede saklansın?", options: ["Proje klasöründe", "Yerel arşivde"])])
            let narrow = ImageRenderer(content: ChatView(model: model, store: store)
                .environment(\.isSnapshot, true).environment(\.colorScheme, dark ? .dark : .light).frame(width: 280, height: 360))
            narrow.scale = 2
            let narrowRep = NSBitmapImageRep(cgImage: try #require(narrow.cgImage))
            try #require(narrowRep.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: "\(folder)/narrow-\(dark ? "dark" : "light").png"))
            model.question = nil
            model.entries = savedEntries; model.queue = savedQueue; model.activities = savedActivities; model.tasks = savedTasks
            canvas.agents[0].status = "running"; canvas.agents[0].chatMode = "agent"; canvas.agents[0].queued = 2
            store.load(canvas)
        }
    }
}
