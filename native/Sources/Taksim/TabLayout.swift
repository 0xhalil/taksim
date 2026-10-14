import Foundation

/// Fixed optical sizes on a four-point spacing grid.
enum ChromeMetrics {
    static let icon: CGFloat = 14
    static let control: CGFloat = 28
    static let tabHeight: CGFloat = 36
    static let inset: CGFloat = 8
    static let gap: CGFloat = 4
}

struct TabLayout {
    let tabWidth: CGFloat = 168
    let viewport: CGFloat
    let overflowing: Bool
    init(width: CGFloat, count: Int) {
        let usable = max(0, width - ChromeMetrics.inset * 2)
        overflowing = CGFloat(count) * tabWidth + ChromeMetrics.control * 2 > usable
        viewport = overflowing ? max(0, usable - ChromeMetrics.control * 4) : CGFloat(count) * tabWidth
    }
    func hidden(offset: CGFloat, count: Int) -> (left: Int, right: Int) {
        let content = CGFloat(count) * tabWidth
        let start = min(max(0, offset), max(0, content - viewport))
        return (Int(ceil(max(0, start - 0.5) / tabWidth)),
                Int(ceil(max(0, content - start - viewport - 0.5) / tabWidth)))
    }
    func target(offset: CGFloat, direction: Int, count: Int) -> Int {
        let step = max(1, Int(viewport / tabWidth) - 1)
        let first = Int(max(0, offset) / tabWidth)
        return min(max(0, first + direction * step), max(0, count - 1))
    }
}
