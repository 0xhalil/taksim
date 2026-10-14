//
//  LineFoldRibbonView+Draw.swift
//  CodeEditSourceEditor
//
//  Created by Khan Winter on 5/8/25.
//  taksim: drawn like PyCharm instead of Xcode's filled column. A block shows a faint chevron where it starts;
//  hovering it shows its end too and a thin guide between them; a folded block shows a chevron pointing right.
//

import AppKit
import CodeEditTextView

extension LineFoldRibbonView {
    struct DrawingFoldInfo {
        let fold: FoldRange
        let startLine: TextLineStorage<TextLine>.TextLinePosition
        let endLine: TextLineStorage<TextLine>.TextLinePosition
    }

    // MARK: - Draw

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext,
              let layoutManager = model?.controller?.textView.layoutManager,
              let rangeStart = layoutManager.textLineForPosition(dirtyRect.minY),
              let rangeEnd = layoutManager.textLineForPosition(dirtyRect.maxY) else {
            return
        }
        context.saveGState()
        context.clip(to: dirtyRect)
        context.setLineCap(.round)
        context.setLineJoin(.round)

        let folds = getDrawingFolds(forTextRange: rangeStart.range.location..<rangeEnd.range.upperBound, layoutManager: layoutManager)
        let hovered = hoveringFold.fold
        let progress = hoveringFold.progress

        // the hovered block: a thin guide from its start to its end, then its end's chevron
        if let h = hovered, let info = folds.first(where: { $0.fold.isHoveringEqual(h) }), !info.fold.isCollapsed {
            let top = info.startLine.yPos + info.startLine.height
            let bottom = info.endLine.yPos
            if bottom - top > 4 {
                context.setStrokeColor(NSColor.tertiaryLabelColor.withAlphaComponent(0.6 * progress).cgColor)
                context.setLineWidth(1)
                context.move(to: CGPoint(x: Self.width / 2, y: top + 2))
                context.addLine(to: CGPoint(x: Self.width / 2, y: bottom - 2))
                context.strokePath()
            }
            chevron(.up, at: info.endLine.yPos + info.endLine.height / 2,
                    color: NSColor.secondaryLabelColor.withAlphaComponent(progress), in: context)
        }

        // every block's start: faint, stronger while hovered; a folded one points right
        for info in folds {
            let y = info.startLine.yPos + info.startLine.height / 2
            if info.fold.isCollapsed {
                chevron(.right, at: y, color: NSColor.secondaryLabelColor, in: context)
            } else {
                let on = hovered.map { info.fold.isHoveringEqual($0) } ?? false
                chevron(.down, at: y, color: on ? NSColor.secondaryLabelColor : NSColor.tertiaryLabelColor, in: context)
            }
        }
        context.restoreGState()
    }

    private enum Pointing { case down, up, right }

    private func chevron(_ pointing: Pointing, at y: CGFloat, color: NSColor, in context: CGContext) {
        let c = CGPoint(x: Self.width / 2, y: y), w: CGFloat = 3.5, h: CGFloat = 2.2
        let path = CGMutablePath()
        switch pointing {
        case .down:
            path.move(to: CGPoint(x: c.x - w, y: c.y - h))
            path.addLine(to: CGPoint(x: c.x, y: c.y + h))
            path.addLine(to: CGPoint(x: c.x + w, y: c.y - h))
        case .up:
            path.move(to: CGPoint(x: c.x - w, y: c.y + h))
            path.addLine(to: CGPoint(x: c.x, y: c.y - h))
            path.addLine(to: CGPoint(x: c.x + w, y: c.y + h))
        case .right:
            path.move(to: CGPoint(x: c.x - h, y: c.y - w))
            path.addLine(to: CGPoint(x: c.x + h, y: c.y))
            path.addLine(to: CGPoint(x: c.x - h, y: c.y + w))
        }
        context.saveGState()
        context.setStrokeColor(color.cgColor)
        context.setLineWidth(1.3)
        context.addPath(path)
        context.strokePath()
        context.restoreGState()
    }

    // MARK: - Get Drawing Folds

    /// The folds that start in a range of text, with their first and last lines; the hovered one too, so its guide
    /// and end are drawn even when it started above the range.
    private func getDrawingFolds(forTextRange textRange: Range<Int>, layoutManager: TextLayoutManager) -> [DrawingFoldInfo] {
        var folds = (model?.getFolds(in: textRange) ?? []).filter { textRange.contains($0.range.lowerBound) }
        if let hovered = hoveringFold.fold, !folds.contains(where: { $0.isHoveringEqual(hovered) }) { folds.append(hovered) }
        return folds.compactMap { fold in
            guard let startLine = layoutManager.textLineForOffset(fold.range.lowerBound),
                  let endLine = layoutManager.textLineForOffset(fold.range.upperBound) else {
                return nil
            }
            return DrawingFoldInfo(fold: fold, startLine: startLine, endLine: endLine)
        }
    }
}
