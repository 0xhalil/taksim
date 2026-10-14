import CoreGraphics
import Foundation

/// taksim's mark: four roads meeting at a crossing. Drawn on a 1000 × 1000 board (the cross itself spans
/// 100…900); the same numbers as native/Resources/logo/taksim-mark.svg and the site's opening.
///
/// - `logo` is the finished mark: the cross with its stripes cut out.
/// - `roads` are the stripes as lines that run on to the page's edges, for the opening.
public enum TaksimMark {
    /// the cross's arm half-width, arm length from the centre, and where the corner arcs are centred from the centre
    public static let arm = 130.0, reach = 400.0, corner = 170.0
    /// the width of the stripes between the star and the outer piece
    public static let band = 34.0
    /// the visible part of the board: the mark has no margin inside it
    public static let crop = CGRect(x: 100, y: 100, width: 800, height: 800)

    /// the cross with its pointed tips
    public static func silhouette() -> CGPath {
        let c = 500.0, w = arm, l = reach
        let p = CGMutablePath()
        let pts: [(Double, Double)] = [
            (c, c - l), (c + w, c - l + w), (c + w, c - w), (c + l - w, c - w), (c + l, c), (c + l - w, c + w), (c + w, c + w),
            (c + w, c + l - w), (c, c + l), (c - w, c + l - w), (c - w, c + w), (c - l + w, c + w), (c - l, c), (c - l + w, c - w),
            (c - w, c - w), (c - w, c - l + w),
        ]
        p.move(to: CGPoint(x: pts[0].0, y: pts[0].1))
        for q in pts.dropFirst() { p.addLine(to: CGPoint(x: q.0, y: q.1)) }
        p.closeSubpath()
        return p
    }

    /// one stripe's edge in the top-left quarter: down the top arm, round the corner, out along the left arm
    private static func edge(radius r: Double, reach far: Double) -> CGPath {
        let c = 500 - corner
        let p = CGMutablePath()
        p.move(to: CGPoint(x: c + r, y: far))
        p.addLine(to: CGPoint(x: c + r, y: c))
        p.addArc(center: CGPoint(x: c, y: c), radius: r, startAngle: 0, endAngle: .pi / 2, clockwise: false)
        p.addLine(to: CGPoint(x: far, y: c + r))
        return p
    }

    private static func turned(_ path: CGPath, _ quarters: Int) -> CGPath {
        var t = CGAffineTransform(translationX: 500, y: 500).rotated(by: Double(quarters) * .pi / 2).translatedBy(x: -500, y: -500)
        return path.copy(using: &t) ?? path
    }

    /// the finished mark. `small`: the version for 16–32 px, with wide gaps and no second stripe.
    public static func logo(small: Bool = false) -> CGPath {
        let gap = small ? 34.0 : 12.0
        let c = 500 - corner, tip = 500 - reach - 60
        var radii = [corner]
        if !small { radii.append(corner - band - gap) }
        let cuts = CGMutablePath()
        for q in 0..<4 {
            for r in radii { cuts.addPath(turned(edge(radius: r, reach: tip), q).copy(strokingWithWidth: gap, lineCap: .butt, lineJoin: .miter, miterLimit: 10)) }
            let centre = CGMutablePath()
            centre.move(to: CGPoint(x: 500, y: tip)); centre.addLine(to: CGPoint(x: 500, y: c))
            cuts.addPath(turned(centre, q).copy(strokingWithWidth: gap, lineCap: .butt, lineJoin: .miter, miterLimit: 10))
        }
        return silhouette().subtracting(cuts, using: .winding)
    }

    /// the two finished marks, built once
    public static let full = logo()
    public static let compact = logo(small: true)

    /// A road of the opening: a stripe as one line that enters from a page edge, bends through the logo and leaves
    /// by the next edge. `outer` is the broad piece, otherwise the thin band.
    public struct Road {
        public var path: CGPath
        public var width: Double
        public var at: Double
        public var inside: ClosedRange<Double>   // the share of the line's length that lies in the logo
    }

    /// The eight roads, turning the same way round (right→up, left→down, top→left, bottom→right). `far`: how
    /// far out the lines start, in board units (a negative number past the board's edge).
    public static func roads(far: Double) -> [Road] {
        let c = 500 - corner, tipIn = 500 - reach
        // each stripe: radius of its centre line round the corner, and its width
        let stripes: [(r: Double, w: Double)] = [(79, 78), (147, band)]
        let order: [(quarter: Int, at: Double)] = [(1, 0), (3, 260), (0, 520), (2, 780)]
        var out: [Road] = []
        for (quarter, at) in order {
            for (i, s) in stripes.enumerated() {
                let path = edge(radius: s.r, reach: far)
                let lenIn = tipIn - far, lenThrough = (c - tipIn) * 2 + Double.pi / 2 * s.r, total = lenIn * 2 + lenThrough
                out.append(Road(path: turned(path, quarter), width: s.w, at: at + Double(i) * 70,
                                inside: (lenIn / total)...((lenIn + lenThrough) / total)))
            }
        }
        return out
    }
}
