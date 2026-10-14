import SwiftUI

/// When a brick redraws: every frame while something moves (a value easing, bars growing in), then only as often
/// as the picture actually changes (a 5-minute window moves about a pixel a second). A SwiftUI TimelineView's
/// schedule is fixed when its body runs, so the slowdown has to be part of the schedule itself.
struct BrickClock: TimelineSchedule {
    /// dense frames until this moment
    var busyUntil: Date
    /// the pace after that; nil stops redrawing until the brick's data changes
    var idle: TimeInterval?
    var dense: TimeInterval = 1 / 60

    func entries(from start: Date, mode: TimelineScheduleMode) -> AnyIterator<Date> {
        var t = start
        let low = mode == .lowFrequency
        return AnyIterator {
            defer {
                if t < busyUntil && !low { t = t.addingTimeInterval(dense) }
                else if let idle { t = t.addingTimeInterval(low ? max(idle, 1) : idle) }
                else { t = .distantFuture }
            }
            return t == .distantFuture ? nil : t
        }
    }
}
