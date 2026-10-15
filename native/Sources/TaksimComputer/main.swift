// taksim-computer: the hands and eyes behind the agents' computer_* tools. The engine (src/computer/) starts one
// and talks to it in JSON lines on stdin/stdout: {"id":1,"cmd":"screenshot",...} -> {"id":1,"ok":true,...}.
// It ships inside Taksim.app, so macOS asks for Screen Recording and Accessibility once, for taksim, and the
// engine the app starts inherits them. Coordinates here are global points (top-left of the main display is 0,0);
// the engine maps them to and from the screenshots it hands the agents.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

typealias Obj = [String: Any]

struct Failure: Error { let message: String; init(_ m: String) { message = m } }

func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue ?? (v as? String).flatMap(Double.init) }
func point(_ o: Obj, _ x: String = "x", _ y: String = "y") throws -> CGPoint {
    guard let px = num(o[x]), let py = num(o[y]) else { throw Failure("\(x) and \(y) are required") }
    return CGPoint(x: px, y: py)
}

// ---------- displays and pictures ----------

func displays() -> [Obj] {
    var ids = [CGDirectDisplayID](repeating: 0, count: 16), n: UInt32 = 0
    CGGetActiveDisplayList(16, &ids, &n)
    return ids.prefix(Int(n)).enumerated().map { i, id in
        let b = CGDisplayBounds(id), mode = CGDisplayCopyDisplayMode(id)
        let scale = mode.map { Double($0.pixelWidth) / max(Double($0.width), 1) } ?? 1
        return ["index": i, "id": Int(id), "x": b.minX, "y": b.minY, "width": b.width, "height": b.height,
                "scale": scale, "main": CGDisplayIsMain(id) != 0]
    }
}

/// a JPEG of a display (or a rectangle of it, in global points), at most maxWidth pixels wide
func screenshot(_ o: Obj) async throws -> Obj {
    guard CGPreflightScreenCaptureAccess() else { throw Failure("screen-recording") }
    let index = Int(num(o["display"]) ?? 0)
    let list = displays()
    guard index >= 0, index < list.count, let did = list[index]["id"] as? Int else { throw Failure("no display \(index)") }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { $0.displayID == CGDirectDisplayID(did) }) else { throw Failure("no display \(index)") }
    let bounds = CGDisplayBounds(CGDirectDisplayID(did))
    var area = CGRect(x: 0, y: 0, width: bounds.width, height: bounds.height) // in the display's own points
    if let r = o["region"] as? [Any], r.count == 4, let x = num(r[0]), let y = num(r[1]), let w = num(r[2]), let h = num(r[3]) {
        area = CGRect(x: x - bounds.minX, y: y - bounds.minY, width: w, height: h).intersection(area)
        if area.isEmpty { throw Failure("the region is off the display") }
    }
    let maxWidth = num(o["maxWidth"]) ?? 1280, native = (list[index]["scale"] as? Double) ?? 2
    let px = min(maxWidth, area.width * native) / area.width // image pixels per point
    let cfg = SCStreamConfiguration()
    cfg.sourceRect = area
    cfg.width = Int((area.width * px).rounded())
    cfg.height = Int((area.height * px).rounded())
    cfg.showsCursor = true
    let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: display, excludingWindows: []), configuration: cfg)
    let rep = NSBitmapImageRep(cgImage: image)
    guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.72]) else { throw Failure("could not encode the picture") }
    return ["data": jpeg.base64EncodedString(), "width": image.width, "height": image.height,
            "origin": [bounds.minX + area.minX, bounds.minY + area.minY], "pxPerPoint": px, "display": list[index],
            "cursor": [cursor().x, cursor().y]]
}

// ---------- mouse ----------

let source = CGEventSource(stateID: .hidSystemState)

func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap) }

func cursor() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

func buttonOf(_ o: Obj) -> (CGMouseButton, CGEventType, CGEventType, CGEventType) {
    switch o["button"] as? String {
    case "right": (.right, .rightMouseDown, .rightMouseUp, .rightMouseDragged)
    case "middle": (.center, .otherMouseDown, .otherMouseUp, .otherMouseDragged)
    default: (.left, .leftMouseDown, .leftMouseUp, .leftMouseDragged)
    }
}

func move(to p: CGPoint) {
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
}

/// glides the pointer there (apps that track hovering see the way), a few frames long
func glide(to p: CGPoint, dragging: (CGEventType, CGMouseButton)? = nil) {
    let from = cursor(), steps = max(1, min(12, Int(hypot(p.x - from.x, p.y - from.y) / 40)))
    for i in 1...steps {
        let t = Double(i) / Double(steps), q = CGPoint(x: from.x + (p.x - from.x) * t, y: from.y + (p.y - from.y) * t)
        if let (type, button) = dragging { post(CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: q, mouseButton: button)) }
        else { move(to: q) }
        usleep(8000)
    }
}

func click(_ o: Obj) throws {
    let p = try point(o), (button, down, up, _) = buttonOf(o)
    let count = max(1, min(3, Int(num(o["count"]) ?? 1)))
    let flags = try modifierFlags(o["modifiers"] as? [String] ?? [])
    glide(to: p)
    for n in 1...count {
        for type in [down, up] {
            let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button)
            e?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
            if !flags.isEmpty { e?.flags = flags }
            post(e)
            usleep(12000)
        }
        usleep(30000)
    }
}

func drag(_ o: Obj) throws {
    let from = try point(o, "fromX", "fromY"), to = try point(o, "toX", "toY"), (button, down, up, dragged) = buttonOf(o)
    glide(to: from)
    post(CGEvent(mouseEventSource: source, mouseType: down, mouseCursorPosition: from, mouseButton: button))
    usleep(80000)
    glide(to: to, dragging: (dragged, button))
    usleep(80000)
    post(CGEvent(mouseEventSource: source, mouseType: up, mouseCursorPosition: to, mouseButton: button))
}

func press(_ o: Obj) throws {
    let p = o["x"] != nil ? try point(o) : cursor(), (button, down, up, _) = buttonOf(o)
    if o["x"] != nil { glide(to: p) }
    post(CGEvent(mouseEventSource: source, mouseType: (o["up"] as? Bool) == true ? up : down, mouseCursorPosition: p, mouseButton: button))
}

func scroll(_ o: Obj) throws {
    if o["x"] != nil { glide(to: try point(o)) }
    let dy = Int32(num(o["dy"]) ?? 0), dx = Int32(num(o["dx"]) ?? 0)
    // a notch at a time, as a wheel does; positive dy goes down the page
    for _ in 0..<max(abs(dy), abs(dx), 1) {
        post(CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2,
                     wheel1: dy == 0 ? 0 : (dy > 0 ? -1 : 1), wheel2: dx == 0 ? 0 : (dx > 0 ? -1 : 1), wheel3: 0))
        usleep(15000)
    }
}

// ---------- keyboard ----------

// ANSI key codes (they name places on the keyboard, not letters; text goes through unicode events instead)
let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
    "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
    "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
    "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
    "return": 36, "enter": 36, "tab": 48, "space": 49, "backspace": 51, "delete": 51, "escape": 53, "esc": 53,
    "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "page_up": 116, "page_down": 121,
    "left": 123, "right": 124, "down": 125, "up": 126, "arrowleft": 123, "arrowright": 124, "arrowdown": 125, "arrowup": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109,
    "f11": 103, "f12": 111, "capslock": 57, "help": 114, "kp_enter": 76,
]
let modifierKeys: [String: (CGEventFlags, CGKeyCode)] = [
    "cmd": (.maskCommand, 55), "command": (.maskCommand, 55), "meta": (.maskCommand, 55), "super": (.maskCommand, 55),
    "ctrl": (.maskControl, 59), "control": (.maskControl, 59), "alt": (.maskAlternate, 58), "option": (.maskAlternate, 58),
    "opt": (.maskAlternate, 58), "shift": (.maskShift, 56), "fn": (.maskSecondaryFn, 63),
]

func modifierFlags(_ names: [String]) throws -> CGEventFlags {
    try names.reduce(into: CGEventFlags()) { f, n in
        guard let m = modifierKeys[n.lowercased()] else { throw Failure("unknown modifier \(n)") }
        f.insert(m.0)
    }
}

func keyEvent(_ code: CGKeyCode, _ down: Bool, _ flags: CGEventFlags) {
    let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
    e?.flags = flags
    post(e)
}

/// "cmd+shift+4", "Return", "ctrl+a", "F5": modifiers held around one key, `repeat` times; `hold` seconds held down
func key(_ o: Obj) throws {
    guard let combo = o["key"] as? String, !combo.isEmpty else { throw Failure("key is required") }
    var parts = combo.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
    if combo.hasSuffix("++") { parts.removeLast(2); parts.append("+") } // "cmd++"
    let name = parts.removeLast()
    let flags = try modifierFlags(parts)
    let mods = parts.compactMap { modifierKeys[$0.lowercased()] }
    let lower = name.lowercased()
    let code = keyCodes[lower] ?? modifierKeys[lower]?.1
    let times = max(1, min(100, Int(num(o["repeat"]) ?? 1))), hold = min(10, num(o["hold"]) ?? 0)
    for _ in 0..<times {
        var held = CGEventFlags()
        for (flag, keyCode) in mods { held.insert(flag); keyEvent(keyCode, true, held) }
        if let code {
            keyEvent(code, true, flags)
            if hold > 0 { usleep(useconds_t(hold * 1_000_000)) }
            keyEvent(code, false, flags)
        } else if name.count == 1 {
            typeText(name, flags)
        } else { throw Failure("unknown key \(name)") }
        for (_, keyCode) in mods.reversed() { keyEvent(keyCode, false, []) }
        usleep(20000)
    }
}

/// text as the keyboard would type it, whatever the layout: unicode key events, a few characters each
func typeText(_ text: String, _ flags: CGEventFlags = []) {
    let chars = Array(text.utf16)
    var i = 0
    while i < chars.count {
        // a newline is the Return key (fields that submit on Enter submit); the rest goes as unicode
        if chars[i] == 10 || chars[i] == 13 { keyEvent(36, true, flags); keyEvent(36, false, flags); i += 1; usleep(8000); continue }
        var j = i
        while j < chars.count, j - i < 16, chars[j] != 10, chars[j] != 13 { j += 1 }
        var chunk = Array(chars[i..<j])
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
            e?.flags = flags
            e?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
            post(e)
        }
        i = j
        usleep(8000)
    }
}

// ---------- windows and what is in them ----------

func windows() -> Obj {
    let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [Obj] ?? []
    let front = NSWorkspace.shared.frontmostApplication
    let list: [Obj] = info.compactMap { w in
        guard (w[kCGWindowLayer as String] as? Int) == 0, let b = w[kCGWindowBounds as String] as? Obj else { return nil }
        let r = CGRect(dictionaryRepresentation: b as CFDictionary) ?? .zero
        guard r.width > 40, r.height > 30 else { return nil }
        return ["app": w[kCGWindowOwnerName as String] as? String ?? "", "pid": w[kCGWindowOwnerPID as String] as? Int ?? 0,
                "title": w[kCGWindowName as String] as? String ?? "", "x": r.minX, "y": r.minY, "width": r.width, "height": r.height]
    }
    return ["windows": list, "frontmost": front?.localizedName ?? "", "frontmostPid": Int(front?.processIdentifier ?? 0),
            "cursor": [cursor().x, cursor().y], "displays": displays()]
}

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func frame(_ el: AXUIElement) -> CGRect? {
    guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute) else { return nil }
    var pt = CGPoint.zero, sz = CGSize.zero
    guard CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    AXValueGetValue(p as! AXValue, .cgPoint, &pt)
    AXValueGetValue(s as! AXValue, .cgSize, &sz)
    return CGRect(origin: pt, size: sz)
}

func label(_ v: AnyObject?) -> String {
    guard let v else { return "" }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return ""
}

/// the focused window of an app (the frontmost, or one named) as a tree of roles, names, values and frames
func read(_ o: Obj) throws -> Obj {
    guard AXIsProcessTrusted() else { throw Failure("accessibility") }
    let apps = NSWorkspace.shared.runningApplications
    let app: NSRunningApplication?
    if let name = (o["app"] as? String)?.lowercased(), !name.isEmpty {
        app = apps.first { $0.localizedName?.lowercased() == name || $0.bundleIdentifier?.lowercased() == name }
            ?? apps.first { ($0.localizedName?.lowercased() ?? "").contains(name) && $0.activationPolicy == .regular }
    } else { app = NSWorkspace.shared.frontmostApplication }
    guard let app else { throw Failure("no running app \(o["app"] as? String ?? "")") }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 2)
    let win = attr(root, kAXFocusedWindowAttribute).flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
        ?? (attr(root, kAXWindowsAttribute) as? [AXUIElement])?.first
    guard let win else { return ["app": app.localizedName ?? "", "nodes": [Obj]()] }
    let limit = Int(num(o["max"]) ?? 400)
    var nodes: [Obj] = []
    func walk(_ el: AXUIElement, _ depth: Int) {
        guard nodes.count < limit, depth < 40 else { return }
        let role = label(attr(el, kAXRoleAttribute)).replacingOccurrences(of: "AX", with: "")
        let name = [label(attr(el, kAXTitleAttribute)), label(attr(el, kAXDescriptionAttribute)), label(attr(el, kAXHelpAttribute))]
            .first { !$0.isEmpty } ?? ""
        let value = String(label(attr(el, kAXValueAttribute)).prefix(200))
        let f = frame(el)
        let visible = (f?.width ?? 0) >= 2 && (f?.height ?? 0) >= 2
        let plain = ["Group", "SplitGroup", "ScrollArea", "LayoutArea", "Unknown", ""].contains(role) && name.isEmpty && value.isEmpty
        if visible && !plain {
            var n: Obj = ["role": role, "name": String(name.prefix(120)), "depth": depth]
            if !value.isEmpty { n["value"] = value }
            if let f { n["frame"] = [f.minX, f.minY, f.width, f.height] }
            if (attr(el, kAXFocusedAttribute) as? Bool) == true { n["focused"] = true }
            if (attr(el, kAXEnabledAttribute) as? Bool) == false { n["disabled"] = true }
            nodes.append(n)
        }
        for c in (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { walk(c, visible && !plain ? depth + 1 : depth) }
    }
    walk(win, 0)
    return ["app": app.localizedName ?? "", "pid": Int(app.processIdentifier), "window": label(attr(win, kAXTitleAttribute)),
            "frame": frame(win).map { [$0.minX, $0.minY, $0.width, $0.height] } ?? [], "nodes": nodes, "truncated": nodes.count >= limit]
}

func status() -> Obj {
    ["screen": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted(), "displays": displays(), "cursor": [cursor().x, cursor().y]]
}

// ---------- the line protocol ----------

func handle(_ o: Obj) async throws -> Obj {
    let cmd = o["cmd"] as? String ?? ""
    let needsHands = ["click", "move", "drag", "mouse", "scroll", "type", "key"].contains(cmd)
    if needsHands, !AXIsProcessTrusted() { throw Failure("accessibility") }
    switch cmd {
    case "status": return status()
    case "screenshot": return try await screenshot(o)
    case "windows": return windows()
    case "read": return try read(o)
    case "click": try click(o)
    case "move": glide(to: try point(o))
    case "drag": try drag(o)
    case "mouse": try press(o)
    case "scroll": try scroll(o)
    case "type": typeText(o["text"] as? String ?? "")
    case "key": try key(o)
    case "request":
        // the system's own prompts (from the app that started the engine); harmless when already granted
        if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
        if !AXIsProcessTrusted() { _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary) }
        return status()
    default: throw Failure("unknown command \(cmd)")
    }
    return ["cursor": [cursor().x, cursor().y]]
}

func reply(_ o: Obj) {
    guard let data = try? JSONSerialization.data(withJSONObject: o), let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

if CommandLine.arguments.contains("--version") { print("taksim-computer 1"); exit(0) }

// one command at a time, in order: an agent's click must land before its next screenshot. Lines are read off the
// main thread; the main run loop keeps NSWorkspace's view of running and frontmost apps current.
Thread.detachNewThread {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let o = (try? JSONSerialization.jsonObject(with: data)) as? Obj else { continue }
        let id = o["id"] ?? NSNull()
        let done = DispatchSemaphore(value: 0)
        Task {
            do { var r = try await handle(o); r["id"] = id; r["ok"] = true; reply(r) }
            catch let f as Failure { reply(["id": id, "ok": false, "error": f.message]) }
            catch { reply(["id": id, "ok": false, "error": error.localizedDescription]) }
            done.signal()
        }
        done.wait()
    }
    exit(0)
}
RunLoop.main.run()
