import CoreGraphics
import Foundation

/// An SVG path string ("M4 2 l3 3 a2 2 0 0 1 4 0 z") as a CGPath, for the CLI marks (Logos.swift) the web
/// draws with Path2D. Handles every path command, arcs as cubic Béziers.
enum SVGPath {
    static func parse(_ d: String) -> CGPath {
        let path = CGMutablePath()
        var tokens = Tokens(d)
        var cmd: Character = "M"
        var cur = CGPoint.zero, start = CGPoint.zero
        var lastCtrl: CGPoint? // for S/T reflections
        var lastCmd: Character = " "

        while let c = tokens.command() ?? (tokens.hasNumber ? cmd : nil) {
            cmd = c
            let rel = c.isLowercase
            let up = Character(c.uppercased())
            func pt() -> CGPoint? {
                guard let x = tokens.number(), let y = tokens.number() else { return nil }
                return rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
            }
            switch up {
            case "M":
                guard let p = pt() else { return path }
                path.move(to: p); cur = p; start = p
                cmd = rel ? "l" : "L" // further pairs are line-tos
                lastCtrl = nil
            case "L":
                guard let p = pt() else { return path }
                path.addLine(to: p); cur = p; lastCtrl = nil
            case "H":
                guard let x = tokens.number() else { return path }
                cur = CGPoint(x: rel ? cur.x + x : x, y: cur.y); path.addLine(to: cur); lastCtrl = nil
            case "V":
                guard let y = tokens.number() else { return path }
                cur = CGPoint(x: cur.x, y: rel ? cur.y + y : y); path.addLine(to: cur); lastCtrl = nil
            case "C":
                guard let c1 = pt(), let c2 = pt(), let p = pt() else { return path }
                path.addCurve(to: p, control1: c1, control2: c2); lastCtrl = c2; cur = p
            case "S":
                let c1 = ("CScs".contains(lastCmd) ? lastCtrl : nil).map { reflect($0, cur) } ?? cur
                guard let c2 = pt(), let p = pt() else { return path }
                path.addCurve(to: p, control1: c1, control2: c2); lastCtrl = c2; cur = p
            case "Q":
                guard let c1 = pt(), let p = pt() else { return path }
                path.addQuadCurve(to: p, control: c1); lastCtrl = c1; cur = p
            case "T":
                let c1 = ("QTqt".contains(lastCmd) ? lastCtrl : nil).map { reflect($0, cur) } ?? cur
                guard let p = pt() else { return path }
                path.addQuadCurve(to: p, control: c1); lastCtrl = c1; cur = p
            case "A":
                guard let rx = tokens.number(), let ry = tokens.number(), let rot = tokens.number(),
                      let large = tokens.flag(), let sweep = tokens.flag(), let p = pt() else { return path }
                arc(path, from: cur, to: p, rx: rx, ry: ry, rotation: rot, large: large, sweep: sweep)
                cur = p; lastCtrl = nil
            case "Z":
                path.closeSubpath(); cur = start; lastCtrl = nil
            default:
                return path
            }
            lastCmd = c
        }
        return path
    }

    static func reflect(_ p: CGPoint, _ about: CGPoint) -> CGPoint { CGPoint(x: 2 * about.x - p.x, y: 2 * about.y - p.y) }

    /// SVG arc (endpoint form) as cubics, per the SVG spec's conversion to center form.
    static func arc(_ path: CGMutablePath, from p0: CGPoint, to p1: CGPoint, rx rx0: CGFloat, ry ry0: CGFloat,
                    rotation: CGFloat, large: Bool, sweep: Bool) {
        var rx = abs(rx0), ry = abs(ry0)
        if rx == 0 || ry == 0 || p0 == p1 { path.addLine(to: p1); return }
        let phi = rotation * .pi / 180, cosP = cos(phi), sinP = sin(phi)
        let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
        let x1 = cosP * dx + sinP * dy, y1 = -sinP * dx + cosP * dy
        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 { rx *= sqrt(lambda); ry *= sqrt(lambda) }
        let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
        let den = rx * rx * y1 * y1 + ry * ry * x1 * x1
        var k = sqrt(max(0, num / den))
        if large == sweep { k = -k }
        let cx1 = k * rx * y1 / ry, cy1 = -k * ry * x1 / rx
        let cx = cosP * cx1 - sinP * cy1 + (p0.x + p1.x) / 2
        let cy = sinP * cx1 + cosP * cy1 + (p0.y + p1.y) / 2
        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            let a = atan2(ux * vy - uy * vx, ux * vx + uy * vy)
            return a
        }
        let theta1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
        var dTheta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
        if !sweep && dTheta > 0 { dTheta -= 2 * .pi } else if sweep && dTheta < 0 { dTheta += 2 * .pi }
        let segments = Int(ceil(abs(dTheta) / (.pi / 2)))
        let delta = dTheta / CGFloat(segments)
        let t = 4 / 3 * tan(delta / 4)
        var th = theta1
        func point(_ a: CGFloat) -> CGPoint {
            CGPoint(x: cx + rx * cos(a) * cosP - ry * sin(a) * sinP, y: cy + rx * cos(a) * sinP + ry * sin(a) * cosP)
        }
        func deriv(_ a: CGFloat) -> CGPoint {
            CGPoint(x: -rx * sin(a) * cosP - ry * cos(a) * sinP, y: -rx * sin(a) * sinP + ry * cos(a) * cosP)
        }
        for _ in 0..<segments {
            let a0 = th, a1 = th + delta
            let s = point(a0), e = point(a1), d0 = deriv(a0), d1 = deriv(a1)
            path.addCurve(to: e, control1: CGPoint(x: s.x + t * d0.x, y: s.y + t * d0.y),
                          control2: CGPoint(x: e.x - t * d1.x, y: e.y - t * d1.y))
            th = a1
        }
    }

    /// numbers and commands of a path string, including the compact forms (".5.5", "1e-3", arc flags "01")
    struct Tokens {
        let chars: [Character]
        var i = 0
        init(_ s: String) { chars = Array(s) }

        mutating func skip() { while i < chars.count, chars[i] == " " || chars[i] == "," || chars[i] == "\n" || chars[i] == "\t" { i += 1 } }

        mutating func command() -> Character? {
            skip()
            guard i < chars.count, chars[i].isLetter, chars[i] != "e", chars[i] != "E" else { return nil }
            defer { i += 1 }
            return chars[i]
        }

        var hasNumber: Bool {
            var j = i
            while j < chars.count, chars[j] == " " || chars[j] == "," { j += 1 }
            return j < chars.count && (chars[j].isNumber || chars[j] == "-" || chars[j] == "." || chars[j] == "+")
        }

        mutating func number() -> CGFloat? {
            skip()
            let s = i
            if i < chars.count, chars[i] == "-" || chars[i] == "+" { i += 1 }
            var dot = false
            while i < chars.count {
                let c = chars[i]
                if c.isNumber { i += 1 }
                else if c == "." && !dot { dot = true; i += 1 }
                else if (c == "e" || c == "E") && i + 1 < chars.count && (chars[i + 1].isNumber || chars[i + 1] == "-") {
                    i += 2
                    while i < chars.count, chars[i].isNumber { i += 1 }
                    break
                } else { break }
            }
            guard i > s, let v = Double(String(chars[s..<i])) else { return nil }
            return CGFloat(v)
        }

        mutating func flag() -> Bool? {
            skip()
            guard i < chars.count, chars[i] == "0" || chars[i] == "1" else { return nil }
            defer { i += 1 }
            return chars[i] == "1"
        }
    }
}
