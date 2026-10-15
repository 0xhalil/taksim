import Foundation

/// Server-sent events, line by line: "event:" and "data:" fields and a blank line ending each event. Comments
/// (": ping") are skipped.
public struct RawSSEParser {
    var type: String?
    var data: [String] = []

    public init() {}

    /// Feeds one line (without its newline); returns the event's name and data when the line ends one.
    public mutating func feed(_ line: String) -> (event: String?, data: String)? {
        if line.isEmpty {
            defer { type = nil; data = [] }
            guard !data.isEmpty else { return nil }
            return (type, data.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { return nil }
        let (field, value) = Self.split(line)
        switch field {
        case "event": type = value
        case "data": data.append(value)
        default: break
        }
        return nil
    }

    static func split(_ line: String) -> (String, String) {
        guard let i = line.firstIndex(of: ":") else { return (line, "") }
        var value = line[line.index(after: i)...]
        if value.first == " " { value = value.dropFirst() }
        return (String(line[..<i]), String(value))
    }
}

/// The canvas event stream's events: each one's data is the bus's JSON { seq, ts, type, data }.
public struct SSEParser {
    var raw = RawSSEParser()

    public init() {}

    public mutating func feed(_ line: String) -> ServerEvent? {
        guard let (type, payload) = raw.feed(line),
              let obj = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any] else { return nil }
        let seq = (obj["seq"] as? NSNumber)?.intValue ?? 0
        let kind = type ?? (obj["type"] as? String) ?? "message"
        let inner = obj["data"].flatMap { try? JSONSerialization.data(withJSONObject: $0) } ?? Data("{}".utf8)
        return ServerEvent(seq: seq, type: kind, data: inner)
    }
}

/// Reads an SSE endpoint, reconnecting a second after the connection drops. `url` is asked again on each
/// connect (the canvas stream resumes from the last event it saw).
enum SSEConnection {
    static func run(session: URLSession, url: @escaping @Sendable () -> URL, onState: @escaping @Sendable (Bool) -> Void,
                    onEvent: @escaping @Sendable (String?, String) -> Void) async {
        while !Task.isCancelled {
            do {
                var req = URLRequest(url: url())
                req.timeoutInterval = 3600
                let (bytes, _) = try await session.bytes(for: req)
                onState(true)
                // split lines by hand: URLSession's `lines` drops the blank lines that end SSE events
                var parser = RawSSEParser()
                var buf: [UInt8] = []
                for try await byte in bytes {
                    if byte != 10 { buf.append(byte); continue }
                    if buf.last == 13 { buf.removeLast() }
                    let line = String(decoding: buf, as: UTF8.self)
                    buf.removeAll(keepingCapacity: true)
                    if let (event, data) = parser.feed(line) { onEvent(event, data) }
                }
            } catch {
                if Task.isCancelled { break }
            }
            onState(false)
            try? await Task.sleep(for: .seconds(1))
        }
    }
}

/// A canvas's event stream, reconnecting from the last seen event when the connection drops.
public enum EventStream {
    public static func events(base: URL, canvas: String, since: Int, session: URLSession = APIClient.session,
                              onState: @escaping @Sendable (Bool) -> Void = { _ in }) -> AsyncStream<ServerEvent> {
        AsyncStream { continuation in
            let last = Counter(since)
            let task = Task {
                await SSEConnection.run(session: session, url: {
                    let fallback = base.appending(path: "/v1/canvases/\(canvas)/events")
                    guard var comps = URLComponents(url: fallback, resolvingAgainstBaseURL: false) else { return fallback }
                    comps.queryItems = [URLQueryItem(name: "since", value: String(last.value))]
                    return comps.url ?? fallback
                }, onState: onState) { event, data in
                    var p = SSEParser()
                    p.raw.type = event
                    p.raw.data = [data]
                    if let ev = p.feed("") { last.value = max(last.value, ev.seq); continuation.yield(ev) }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// GET /v1/canvases/:id/panels/stream: every panel's data on (re)connect, then its changes
    public static func panels(base: URL, canvas: String, session: URLSession = APIClient.session) -> AsyncStream<PanelMessage> {
        AsyncStream { continuation in
            let task = Task {
                await SSEConnection.run(session: session, url: { base.appending(path: "/v1/canvases/\(canvas)/panels/stream") },
                                        onState: { _ in }) { event, data in
                    if let m = PanelMessage(event: event, data: data) { continuation.yield(m) }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// the last event id, shared between reconnects
final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var v: Int
    init(_ v: Int) { self.v = v }
    var value: Int {
        get { lock.withLock { v } }
        set { lock.withLock { v = newValue } }
    }
}
