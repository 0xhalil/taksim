import XCTest
import AppKit
import Metal
import QuartzCore
import SwiftUI
import TaksimKit
@testable import Taksim

/// The opening is drawn twice: as a Canvas (snapshots) and as layers played by Core Animation (the app). Standing
/// at the same moment, the two must look alike.
final class LaunchStageTests: XCTestCase {
    private let w = 900, h = 600

    private func window(_ view: NSView) -> NSWindow {
        let win = NSWindow(contentRect: NSRect(x: -4000, y: 0, width: w, height: h), styleMask: [.borderless], backing: .buffered, defer: false)
        win.appearance = NSAppearance(named: .darkAqua)
        win.contentView = view
        win.orderFrontRegardless()
        return win
    }

    @MainActor private func canvas(at e: Double?, flight: Double?) async -> CGImage? {
        let host = NSHostingView(rootView: LaunchView(target: flight != nil ? CGRect(x: 70, y: 14, width: 15, height: 15) : nil, finish: {}, at: e, flightAt: flight).frame(width: CGFloat(w), height: CGFloat(h)))
        let win = window(host)
        try? await Task.sleep(for: .milliseconds(500))
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return nil }
        host.cacheDisplay(in: host.bounds, to: rep)
        win.orderOut(nil)
        return rep.cgImage
    }

    /// the layers holding one moment's values, drawn into a bitmap
    @MainActor private func layers(standAt t: Double) throws -> CGImage {
        let view = OpeningStage(frame: NSRect(x: 0, y: 0, width: w, height: h))
        view.appearance = NSAppearance(named: .darkAqua)
        view.target = CGRect(x: 70, y: 14, width: 15, height: 15)
        view.standAt = t
        let stage = view.detachedLayers()
        let ctx = try XCTUnwrap(CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        // over the ground the app has under the opening, which the opening lets go of
        ctx.setFillColor(NSColor(red: 0x1E / 255.0, green: 0x1F / 255.0, blue: 0x22 / 255.0, alpha: 1).cgColor)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        CATransaction.begin(); CATransaction.setDisableActions(true)
        stage.render(in: ctx)
        CATransaction.commit()
        return try XCTUnwrap(ctx.makeImage())
    }

    private func pixels(_ image: CGImage) -> [UInt8] {
        var data = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return data
    }

    @MainActor func testLayersLookLikeTheCanvasDrawing() async throws {
        let folder = ProcessInfo.processInfo.environment["TAKSIM_LAUNCH_REVIEW"]
        if let folder { try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true) }
        let roads = TaksimMark.roads(far: 500 - 900.0 / 2 / (min(Opening.maxSide, 600 * 0.4) / Opening.board) - 80)
        let flyAt = OpeningTimeline(roads).flyAt
        let moments: [(String, Double?, Double?, Double)] = [   // name, canvas e, canvas flight, layers' time
            ("roads-1.0", 1.0, nil, 1.0), ("roads-1.9", 1.9, nil, 1.9), ("star", flyAt - 0.2, nil, flyAt - 0.2),
            ("flight-0.35", nil, 0.35, flyAt + 0.35), ("glint", nil, Opening.flight + 0.25, flyAt + Opening.flight + 0.25),
        ]
        for (name, e, flight, t) in moments {
            let ca = await canvas(at: e, flight: flight)
            let a = try XCTUnwrap(ca), b = try layers(standAt: t)
            let pa = pixels(a), pb = pixels(b)
            var diff = 0.0, accentA = 0, accentB = 0
            for i in stride(from: 0, to: pa.count, by: 4) {
                diff += Double(abs(Int(pa[i]) - Int(pb[i])) + abs(Int(pa[i + 1]) - Int(pb[i + 1])) + abs(Int(pa[i + 2]) - Int(pb[i + 2]))) / 765
                if pa[i + 2] > 180 && pa[i] < 90 { accentA += 1 }
                if pb[i + 2] > 180 && pb[i] < 90 { accentB += 1 }
            }
            let mean = diff / Double(w * h)
            print("LAUNCH", name, "mean diff", String(format: "%.4f", mean), "accent px canvas", accentA, "layers", accentB)
            XCTAssertLessThan(mean, 0.01, "\(name): the layers and the Canvas drawing differ")
            XCTAssertEqual(Double(accentB), Double(accentA), accuracy: max(200, Double(accentA) * 0.05), "\(name): the same amount of colour")
            if let folder {
                for (tag, img) in [("canvas", a), ("layers", b)] {
                    try NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: "\(folder)/\(name)-\(tag).png"))
                }
            }
        }
    }

    /// Played for real in a window: the mark in the centre goes when the flight starts, and the flight shows then.
    @MainActor func testCentreMarkLeavesWhenTheFlightStarts() async throws {
        let view = OpeningStage(frame: NSRect(x: 0, y: 0, width: w, height: h))
        view.target = CGRect(x: 70, y: 14, width: 15, height: 15)
        view.playsUnseen = true
        let win = window(view)
        let began = Date().addingTimeInterval(0.05)   // the layers begin a moment after they are built
        view.startIfReady()
        let tl = try XCTUnwrap(view.timeline)
        let board = try XCTUnwrap(view.boardLayer), flight = try XCTUnwrap(view.flightLayer)
        func opacity(_ l: CALayer) -> Float { (l.presentation() ?? l).opacity }
        func at(_ t: Double) async { try? await Task.sleep(for: .seconds(max(0, t - Date().timeIntervalSince(began)))) }
        await at(tl.flyAt - 0.3)
        XCTAssertEqual(opacity(board), 1, accuracy: 0.01, "the centre mark is there until the flight starts")
        XCTAssertEqual(opacity(flight), 0, accuracy: 0.01, "and nothing flies yet")
        await at(tl.flyAt + 0.3)
        XCTAssertEqual(opacity(board), 0, accuracy: 0.01, "the centre mark is gone as the flight begins")
        XCTAssertEqual(opacity(flight), 1, accuracy: 0.01, "the flight shows")
        win.orderOut(nil)
    }
}
