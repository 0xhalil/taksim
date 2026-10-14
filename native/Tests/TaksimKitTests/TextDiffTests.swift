import Testing
@testable import TaksimKit

@Suite struct TextDiffTests {
    @Test func unchangedTextIsAllContext() {
        let rows = LineDiff.rows(old: "a\nb\nc\n", new: "a\nb\nc\n")
        #expect(rows.count == 3)
        #expect(rows.allSatisfy { $0.old?.kind == .context && $0.new?.kind == .context })
        #expect(rows.map { $0.old?.number } == [1, 2, 3])
        #expect(rows.map { $0.new?.number } == [1, 2, 3])
    }

    @Test func anAddedLineStandsOnTheRightAndNumbersFollow() {
        let rows = LineDiff.rows(old: "a\nc\n", new: "a\nb\nc\n")
        #expect(rows.count == 3)
        #expect(rows[1].old == nil)
        #expect(rows[1].new?.kind == .added && rows[1].new?.text == "b" && rows[1].new?.number == 2)
        #expect(rows[2].old?.number == 2 && rows[2].new?.number == 3) // "c" after it moved down
    }

    @Test func aRemovedLineStandsOnTheLeft() {
        let rows = LineDiff.rows(old: "a\nb\nc\n", new: "a\nc\n")
        #expect(rows.map { $0.old != nil } == [true, true, true])
        #expect(rows[1].new == nil && rows[1].old?.text == "b")
        #expect(rows[2].new?.number == 2)
    }

    @Test func aRewrittenLinePairsUpAndMarksItsMiddle() {
        let rows = LineDiff.rows(old: "let x = compute(41)\n", new: "let x = compute(42)\n")
        #expect(rows.count == 1)
        #expect(rows[0].isChange)
        // only the digit changed: "let x = compute(4" and ")" stay
        #expect(rows[0].old?.hot == 17..<18)
        #expect(rows[0].new?.hot == 17..<18)
        #expect(String(Array(rows[0].new!.text)[rows[0].new!.hot!]) == "2")
    }

    @Test func aLineWithNothingInCommonIsNotSplit() {
        let rows = LineDiff.rows(old: "aaa\n", new: "zzz\n")
        #expect(rows.count == 1 && rows[0].isChange)
        #expect(rows[0].old?.hot == nil && rows[0].new?.hot == nil)
    }

    @Test func aLongerBlockThanTheOtherKeepsItsExtraLinesAlone() {
        let rows = LineDiff.rows(old: "a\nb1\nb2\nb3\nz\n", new: "a\nB\nz\n")
        #expect(rows.map { "\($0.old?.kind.rawValue ?? "-")/\($0.new?.kind.rawValue ?? "-")" } == [
            "context/context",
            "removed/added", "removed/-", "removed/-",
            "context/context",
        ])
    }

    @Test func aNewFileIsAllAddedAndADeletedOneAllRemoved() {
        let added = LineDiff.rows(old: "", new: "one\ntwo\n")
        #expect(added.count == 2 && added.allSatisfy { $0.old == nil && $0.new?.kind == .added })
        let removed = LineDiff.rows(old: "one\ntwo\n", new: "")
        #expect(removed.count == 2 && removed.allSatisfy { $0.new == nil && $0.old?.kind == .removed })
        #expect(LineDiff.rows(old: "", new: "").isEmpty)
    }

    @Test func aMissingFinalNewlineIsNotALine() {
        #expect(LineDiff.rows(old: "a\nb", new: "a\nb\n").allSatisfy { $0.isChange == false })
    }
}
