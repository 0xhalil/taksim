import XCTest
import CoreGraphics
@testable import Taksim

final class ChartGeometryTests: XCTestCase {
    func testScaleFitsWithARoundTopAndFloor() {
        // a round top a little over the highest value
        XCTAssertEqual(ChartGeometry.scale([[10], [42]], kind: "area", stack: false).hi, 50)
        XCTAssertEqual(ChartGeometry.scale([[10], [42]], kind: "area", stack: false).lo, 0)
        // stacked: the sums
        XCTAssertEqual(ChartGeometry.scale([[30, 30]], kind: "bar", stack: true).hi, 100)
        // negatives get a round floor
        XCTAssertEqual(ChartGeometry.scale([[-3], [4]], kind: "line", stack: false).lo, -5)
        // a line far from zero gets a floor near its values
        let s = ChartGeometry.scale([[100], [102], [101]], kind: "line", stack: false)
        XCTAssertEqual(s.lo, 50)
        XCTAssertEqual(s.hi, 200)
        // nothing: 0…1
        XCTAssertEqual(ChartGeometry.scale([], kind: "line", stack: false).hi, 1)
    }

    func testThePictureNowAndTheOneItMovesToHaveTheSameParts() {
        let plot = ChartPlot(w: 300, lo: 0, hi: 10, t0: 0, k: 0.1)
        let times = [0.0, 1000, 2000]
        let to: [[Double]] = [[1, 2], [.nan, 4], [5, 6]]
        let from: [[Double]] = [[1, 2], [.nan, 3], [0, 0]]
        let mask = ChartGeometry.mask(to, series: 2)
        XCTAssertEqual(mask, [[true, false, true], [true, true, true]])
        for kind in ["line", "area", "bar"] {
            let a = ChartGeometry.paths(times: times, vals: from, mask: mask, plot: plot, kind: kind, stack: false, xMode: false, hold: 400, everyMs: 1000)
            let b = ChartGeometry.paths(times: times, vals: to, mask: mask, plot: plot, kind: kind, stack: false, xMode: false, hold: 400, everyMs: 1000)
            for (p, q) in zip(a, b) {
                XCTAssertEqual(elements(p.line), elements(q.line), kind)
                XCTAssertEqual(elements(p.area), elements(q.area), kind)
                XCTAssertEqual(elements(p.bars), elements(q.bars), kind)
            }
        }
    }

    func testALiveLineHoldsItsLastValueToNow() {
        let plot = ChartPlot(w: 200, lo: 0, hi: 10, t0: -2000, k: 0.1)
        let p = ChartGeometry.paths(times: [-2000, -1000], vals: [[5], [10]], mask: [[true, true]], plot: plot, kind: "line",
                                    stack: false, xMode: false, hold: 400, everyMs: 1000)[0]
        XCTAssertEqual(p.last, CGPoint(x: 400, y: plot.y(10)))
        XCTAssertEqual(plot.y(10), ChartPlot.top)
        XCTAssertEqual(plot.y(0), ChartPlot.bottom)
        // a live bar spans the time since the sample before it
        let bars = ChartGeometry.paths(times: [-2000, -1000], vals: [[5], [10]], mask: [[true, true]], plot: plot, kind: "bar",
                                       stack: false, xMode: false, hold: nil, everyMs: 1000)[0].bars
        XCTAssertEqual(bars.boundingBox.minX, plot.x(-3000) + 0.5, accuracy: 0.01)
        XCTAssertEqual(bars.boundingBox.maxX, plot.x(-1000) - 0.5, accuracy: 0.01)
    }

    private func elements(_ p: CGPath) -> [Int32] {
        var out: [Int32] = []
        p.applyWithBlock { out.append($0.pointee.type.rawValue) }
        return out
    }
}
