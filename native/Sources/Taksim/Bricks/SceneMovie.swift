import AppKit
import AVFoundation
import Metal
import QuartzCore
import SwiftUI
import TaksimKit

// A scene's controls and its movie (in the spirit of Claude Motion: the animation is the scene itself, as
// data, never generated footage). Hovering a scene shows ▶/⏸, a scrubber over its timeline and 🎞, which
// writes the timeline to an MP4: the same layers, drawn offscreen frame by frame by CARenderer at the
// moment each frame stands for, then encoded with AVAssetWriter.

/// what the controls hold on to: the scene's view on screen and the context it was last drawn with
@MainActor @Observable final class ScenePlayer {
    @ObservationIgnored weak var view: SceneLayerView?
    @ObservationIgnored var ctx: BrickContext?
    var exporting = false
    var editing = false
    var progress = 0.0
    var failed: String?
}

struct SceneControls: View {
    let player: ScenePlayer
    let title: String
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if let v = player.view, v.length > 0 {
            TimelineView(.animation(minimumInterval: 1 / 30, paused: !v.playing)) { _ in
                let t = v.time
                HStack(spacing: 8) {
                    Button { if v.playing { v.pause() } else { v.play(from: t >= v.length - 0.01 ? 0 : t) } } label: {
                        Image(systemName: v.playing ? "pause.fill" : "play.fill").font(.system(size: 10.5)).frame(width: 18, height: 18)
                    }
                    .buttonStyle(Press()).help(v.playing ? L("Pause") : L("Play"))
                    Slider(value: Binding(get: { t }, set: { v.scrub($0) }), in: 0...v.length).controlSize(.mini)
                    Text(String(format: "%.1f / %.1f", t, v.length)).font(.system(size: 10.5)).monospacedDigit().foregroundStyle(JB.muted)
                    if let edit = player.ctx?.edit, let raw = player.ctx?.view.raw {
                        Button { player.editing = true } label: { Image(systemName: "pencil").font(.system(size: 11)).frame(width: 18, height: 18) }
                            .buttonStyle(Press()).help(L("Texts and timing"))
                            .popover(isPresented: Binding(get: { player.editing }, set: { player.editing = $0 }), arrowEdge: .bottom) {
                                SceneEditor(raw: raw, save: edit, done: { player.editing = false })
                            }
                    }
                    if player.exporting {
                        ProgressView(value: player.progress).progressViewStyle(.circular).controlSize(.mini).frame(width: 18)
                    } else {
                        Button { export() } label: { Image(systemName: "film").font(.system(size: 11)).frame(width: 18, height: 18) }
                            .buttonStyle(Press()).help(player.failed ?? L("Save as MP4"))
                            .foregroundStyle(player.failed == nil ? JB.ink : JB.err)
                    }
                }
                .foregroundStyle(JB.ink)
                .padding(.horizontal, 8).frame(height: 28)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 7))
                .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(JB.line))
            }
        }
    }

    private func export() {
        guard let ctx = player.ctx else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.mpeg4Movie]
        panel.nameFieldStringValue = (title.isEmpty ? L("scene") : title) + ".mp4"
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        guard panel.runModal() == .OK, let url = panel.url else { return }
        player.exporting = true; player.progress = 0; player.failed = nil
        let dark = scheme == .dark
        Task { @MainActor in
            do {
                try await SceneMovie.write(ctx, dark: dark, to: url) { player.progress = $0 }
                NSWorkspace.shared.activateFileViewerSelecting([url])
            } catch { player.failed = L("Could not save: %@", error.localizedDescription) }
            player.exporting = false
        }
    }
}

enum SceneMovie {
    enum Failure: LocalizedError {
        case noGPU, writer(String)
        var errorDescription: String? { switch self { case .noGPU: L("No Metal"); case .writer(let m): m } }
    }

    /// the scene's timeline as an H.264 movie: `width` pixels wide, `fps` frames a second, a short hold at the end
    @MainActor
    static func write(_ ctx: BrickContext, dark: Bool, to url: URL, width: Int = 1280, fps: Int32 = 30,
                      progress: @escaping (Double) -> Void) async throws {
        let size = SceneMath.sceneSize(ctx.view.raw)
        let W = width & ~1, H = Int((Double(W) * size.h / size.w).rounded()) & ~1
        guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { throw Failure.noGPU }

        // the scene, offscreen, in the theme it is seen in, its whole timeline started at `clock`
        let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)!
        let view = SceneLayerView(frame: CGRect(x: 0, y: 0, width: W, height: H))
        view.appearance = appearance
        let clock: CFTimeInterval = 1000
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        appearance.performAsCurrentDrawingAppearance {
            view.update(BrickContext(view: ctx.view, state: ctx.state, width: CGFloat(W), preview: false, memoKey: "movie-\(UUID().uuidString)"))
            view.layer!.backgroundColor = NSColor(JB.panel).cgColor
        }
        view.layout()
        view.layer!.isGeometryFlipped = true
        view.play(clock: clock)
        CATransaction.commit()
        let length = view.length + 0.8 // the last picture stays a moment

        let desc = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: W, height: H, mipmapped: false)
        desc.usage = [.renderTarget, .shaderRead]
        desc.storageMode = device.hasUnifiedMemory ? .shared : .managed
        guard let texture = device.makeTexture(descriptor: desc) else { throw Failure.noGPU }
        let renderer = CARenderer(mtlTexture: texture, options: [kCARendererColorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                                                                kCARendererMetalCommandQueue: queue])
        renderer.layer = view.layer
        renderer.bounds = CGRect(x: 0, y: 0, width: W, height: H)

        try? FileManager.default.removeItem(at: url)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: W, AVVideoHeightKey: H,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: W * H * 6],
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H,
        ])
        writer.add(input)
        guard writer.startWriting() else { throw Failure.writer(writer.error?.localizedDescription ?? L("could not write")) }
        writer.startSession(atSourceTime: .zero)

        let frames = Int((length * Double(fps)).rounded(.up))
        for i in 0..<frames {
            renderer.beginFrame(atTime: clock + Double(i) / Double(fps), timeStamp: nil)
            renderer.addUpdate(renderer.bounds)
            renderer.render()
            renderer.endFrame()
            // the queue is serial: once this empty buffer is done, the frame above is drawn
            guard let cb = queue.makeCommandBuffer() else { throw Failure.noGPU }
            if texture.storageMode == .managed, let blit = cb.makeBlitCommandEncoder() { blit.synchronize(resource: texture); blit.endEncoding() }
            cb.commit()
            await cb.completed()

            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
            guard let pool = adaptor.pixelBufferPool else { throw Failure.writer(writer.error?.localizedDescription ?? L("no pixel pool")) }
            var pb: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb)
            guard let pb else { throw Failure.writer(L("no pixel buffer")) }
            CVPixelBufferLockBaseAddress(pb, [])
            // the texture's rows run bottom up, a movie's top down
            let base = CVPixelBufferGetBaseAddress(pb)!, bpr = CVPixelBufferGetBytesPerRow(pb)
            for y in 0..<H {
                texture.getBytes(base + (H - 1 - y) * bpr, bytesPerRow: bpr, from: MTLRegionMake2D(0, y, W, 1), mipmapLevel: 0)
            }
            CVPixelBufferUnlockBaseAddress(pb, [])
            adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: fps))
            if i % 5 == 0 { progress(Double(i) / Double(frames)); await Task.yield() }
        }
        input.markAsFinished()
        await writer.finishWriting()
        if writer.status != .completed { throw Failure.writer(writer.error?.localizedDescription ?? L("could not write")) }
        progress(1)
    }
}
