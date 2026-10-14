import Foundation

// The server's JSON, as src/canvas/*.mjs sends it. Fields the UI may not get (older canvases, partial
// events) are optional, so decoding never fails on a missing one.

/// A canvas in the tab strip: GET /v1/canvases.
public struct CanvasSummary: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var agents: Int?
    public var busy: Int?
    public var createdAt: Double?
}

public struct CanvasList: Codable, Sendable {
    public var canvases: [CanvasSummary]
}

/// A whole canvas: GET /v1/canvases/:id (canvas.view()).
public struct Canvas: Codable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var agents: [Agent]
    public var links: [Link]?
    public var groups: [Group]?
    public var seq: Int?
}

/// An agent (agent.view() in src/canvas/agent.mjs).
public struct Agent: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var role: String?
    public var system: String?
    public var autoApprove: Bool?
    /// helpers: it hands routine work to helper agents on the cheapest model that fits, reusing the ones it has
    public var delegate: Bool?
    /// what it is in an orchestrated job: "writer" (the one part that changes files), "reader", or "reviewer"
    public var jobRole: String?
    /// the agents doing a part of its handed-out work right now
    public var workingWith: [String]?
    /// the agents writing in its folder that it has to wait for before its turn can start
    public var blockedBy: [String]?
    /// not working itself at this moment because of other agents: they do its parts, or one of them is writing in its folder
    public var waitsForOthers: Bool { !(workingWith ?? []).isEmpty || !(blockedBy ?? []).isEmpty }
    /// tool help: it looks for a saved or market tool before building one, and saves what it builds; nil: on
    public var toolHelp: Bool?
    public var toolsOn: Bool { toolHelp != false }
    /// shows a chat instead of a card while its terminal is closed
    public var chatMode: String?
    public var chatOrigin: ChatOrigin?
    public struct ChatOrigin: Codable, Equatable, Sendable {
        public var id: String
        public var name: String
        public var at: Double?
    }
    public var chat: Bool?
    public var model: String?
    /// the thinking level it runs with; nil: its CLI's default
    public var effort: String?
    public var backend: String?
    public var account: String?
    public var accountName: String?
    /// the login it runs under, for its plan's usage (CanvasStore.usage)
    public var usageKey: String?
    public var sandbox: String?
    public var cwd: String?
    public var status: String?
    public var queued: Int?
    public var waitingOn: [String]?
    public var lastError: String?
    public var lastText: String?
    public var terminal: Bool?
    public var termReady: Bool?
    public var autoDeliver: Bool?
    public var folder: Folder?
    public var pos: [Double]?
    public var size: [Double]?
    public var cardSize: [Double]?
    /// only its title bar shows (double-click the bar)
    public var collapsed: Bool?
    /// how full its context is, as its CLI measured the last turn (Claude, Codex); nil when the CLI doesn't say
    public var context: AgentContext?
    public var createdBy: String?
    public var createdAt: Double?
    public var panel: Panel?
    public var ide: JSONValue?

    public struct Folder: Codable, Equatable, Sendable {
        public var path: String?
        public var name: String
        public var branch: String?
    }

    public var isTerminalOpen: Bool { terminal ?? false }
    public var isCollapsed: Bool { collapsed ?? false }
}

/// A line between agents: one created the other, or they talked.
public struct Link: Codable, Equatable, Sendable {
    public var from: String
    public var to: String
    public var kind: String
    /// what the agent wrote for the arrow: why it made the other one, or what it handed it last
    public var label: String?
}

/// A group frame (canvas.groupView()).
public struct Group: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var rect: [Double]
    public var color: String?
    public var maintainer: String?
    public var version: Int?
    public var members: [String]?
    /// the note version each member last read (nil: not yet)
    public var seen: [String: Int?]?
}

/// One event of a canvas's stream: GET /v1/canvases/:id/events (src/canvas/events.mjs).
public struct ServerEvent: Sendable {
    public var seq: Int
    public var type: String
    /// the event's "data" object, as raw JSON for the typed decoders in CanvasStore
    public var data: Data
}

/// tokens in the agent's context after its last turn, and its model's window
public struct AgentContext: Codable, Equatable, Sendable {
    public var used: Double
    public var window: Double
    public init(used: Double, window: Double) { self.used = used; self.window = window }
    /// 0…1
    public var fraction: Double { window > 0 ? min(1, max(0, used / window)) : 0 }
    /// "38K", "1.2M"
    public static func tokens(_ n: Double) -> String {
        n >= 1_000_000 ? String(format: n >= 10_000_000 ? "%.0fM" : "%.1fM", n / 1_000_000).replacingOccurrences(of: ".0M", with: "M")
            : n >= 1000 ? String(format: "%.0fK", n / 1000) : String(Int(n))
    }
}
