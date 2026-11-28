import AppKit
import CoreGraphics
import Foundation
import QuartzCore

// MARK: - Soft Particle Sprite Cache (Zero Hard Crosshairs / Sparkles, §18.4, A66)

/// Caches small premultiplied soft-radial cotton-light CGImage sprites keyed by quantized RGB.
/// Ensures zero hard star/crosshair spikes and low per-frame CPU/GPU cost even on 120/144Hz displays.
final class LumenSoftParticleSpriteCache {
  static let shared = LumenSoftParticleSpriteCache()

  private var cache: [String: CGImage] = [:]
  private var keyOrder: [String] = []
  private let limit = 160

  func sprite(r: UInt8, g: UInt8, b: UInt8, glowEnabled: Bool) -> CGImage? {
    // Quantize to 16-level buckets to keep cache bounded while preserving exact card hues
    let qr = (r >> 4) << 4
    let qg = (g >> 4) << 4
    let qb = (b >> 4) << 4
    let key = "\(qr)-\(qg)-\(qb)-\(glowEnabled ? 1 : 0)"
    if let cached = cache[key] { return cached }

    let size = 32
    let space = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(
      data: nil,
      width: size,
      height: size,
      bitsPerComponent: 8,
      bytesPerRow: size * 4,
      space: space,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }

    let rf = CGFloat(qr) / 255.0
    let gf = CGFloat(qg) / 255.0
    let bf = CGFloat(qb) / 255.0
    let center = CGPoint(x: 16, y: 16)

    if glowEnabled {
      let colors = [
        NSColor(srgbRed: rf, green: gf, blue: bf, alpha: 0.88).cgColor,
        NSColor(srgbRed: rf, green: gf, blue: bf, alpha: 0.60).cgColor,
        NSColor(srgbRed: rf, green: gf, blue: bf, alpha: 0.27).cgColor,
        NSColor(srgbRed: rf, green: gf, blue: bf, alpha: 0.07).cgColor,
        NSColor(srgbRed: rf, green: gf, blue: bf, alpha: 0.0).cgColor
      ] as CFArray
      if let grad = CGGradient(colorsSpace: space, colors: colors, locations: [0.0, 0.20, 0.44, 0.72, 1.0]) {
        ctx.drawRadialGradient(grad, startCenter: center, startRadius: 1, endCenter: center, endRadius: 15.5, options: [])
      }
    }

    let coreRadius: CGFloat = glowEnabled ? 1.5 : 3.0
    ctx.setFillColor(NSColor(srgbRed: rf, green: gf, blue: bf, alpha: 0.64).cgColor)
    ctx.fillEllipse(in: CGRect(x: center.x - coreRadius, y: center.y - coreRadius, width: coreRadius * 2, height: coreRadius * 2))

    guard let image = ctx.makeImage() else { return nil }
    if cache.count >= limit, let oldest = keyOrder.first {
      keyOrder.removeFirst()
      cache.removeValue(forKey: oldest)
    }
    cache[key] = image
    keyOrder.append(key)
    return image
  }
}

// MARK: - Live Card Texture Sampler

struct LumenSampledCardTexture {
  let snapshot: CGImage
  let sampleWidth: Int
  let sampleHeight: Int
  let rgbaBytes: [UInt8]

  static func capture(from view: NSView) -> LumenSampledCardTexture? {
    let bounds = view.bounds
    guard bounds.width >= 4, bounds.height >= 4 else { return nil }
    guard let rep = view.bitmapImageRepForCachingDisplay(in: bounds) else { return nil }
    rep.size = bounds.size
    view.cacheDisplay(in: bounds, to: rep)
    guard let fullImage = rep.cgImage else { return nil }

    let sampleW = 40
    let sampleH = 44
    var bytes = [UInt8](repeating: 0, count: sampleW * sampleH * 4)
    let space = CGColorSpaceCreateDeviceRGB()
    bytes.withUnsafeMutableBytes { rawBuf in
      if let baseAddress = rawBuf.baseAddress,
         let ctx = CGContext(
          data: baseAddress,
          width: sampleW,
          height: sampleH,
          bitsPerComponent: 8,
          bytesPerRow: sampleW * 4,
          space: space,
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) {
        ctx.interpolationQuality = .low
        ctx.draw(fullImage, in: CGRect(x: 0, y: 0, width: sampleW, height: sampleH))
      }
    }
    return LumenSampledCardTexture(snapshot: fullImage, sampleWidth: sampleW, sampleHeight: sampleH, rgbaBytes: bytes)
  }

  /// Samples the live RGBA pixel at normalized (u, v) in top-down coordinates, lifting dark pixels
  /// softly so cotton-light dissolution dust remains visibly tied to card tones on dark glass.
  func sampleColor(u: CGFloat, v: CGFloat, fallbackTint: NSColor) -> (UInt8, UInt8, UInt8, UInt8) {
    let px = max(0, min(sampleWidth - 1, Int((u * CGFloat(sampleWidth - 1)).rounded())))
    // CoreGraphics draw into unflipped bitmap places visual top at row (sampleH - 1)
    let py = max(0, min(sampleHeight - 1, Int(((1.0 - v) * CGFloat(sampleHeight - 1)).rounded())))
    let offset = (py * sampleWidth + px) * 4
    guard offset + 3 < rgbaBytes.count else {
      return rgbBytes(from: fallbackTint)
    }
    let a = rgbaBytes[offset + 3]
    guard a > 24 else { return (0, 0, 0, 0) }
    // Un-premultiply gently and lift luminosity slightly toward soft cotton-light
    let invA = 255.0 / max(1.0, Double(a))
    let rawR = min(255.0, Double(rgbaBytes[offset]) * invA)
    let rawG = min(255.0, Double(rgbaBytes[offset + 1]) * invA)
    let rawB = min(255.0, Double(rgbaBytes[offset + 2]) * invA)
    let lift: Double = 0.24
    let r = UInt8(min(255, Int(rawR + (248.0 - rawR) * lift)))
    let g = UInt8(min(255, Int(rawG + (251.0 - rawG) * lift)))
    let b = UInt8(min(255, Int(rawB + (255.0 - rawB) * lift)))
    return (r, g, b, a)
  }

  private func rgbBytes(from color: NSColor) -> (UInt8, UInt8, UInt8, UInt8) {
    let rgb = color.usingColorSpace(.sRGB) ?? NSColor(srgbRed: 0.72, green: 0.85, blue: 1.0, alpha: 1.0)
    return (
      UInt8(max(0, min(255, Int((rgb.redComponent * 255).rounded())))),
      UInt8(max(0, min(255, Int((rgb.greenComponent * 255).rounded())))),
      UInt8(max(0, min(255, Int((rgb.blueComponent * 255).rounded())))),
      255
    )
  }
}

// MARK: - Shared Multi-Display Effects Clock & Particle Engine (§4, §16.4, §17.2, §18.4, A70)

/// Single unified animation clock and particle field owner shared across ALL participating `OrbitViewport` panels.
///
/// Why a single shared engine matters for multi-display Orbit (§4, A70):
/// - A card straddling two monitors or dissolving near a monitor seam uses ONE particle array,
///   ONE captured `LumenSampledCardTexture`, ONE monotonic timestamp (`CACurrentMediaTime()`),
///   and ONE completion trigger (`onParticlesFinished`).
/// - Each viewport's `LumenOrbitEffectsOverlayView` renders only the local coordinate slice
///   intersecting its `railRange`, so the diagonal dissolution front and drifting particles cross
///   physical bezels seamlessly even when displays run at different refresh rates (e.g. 60Hz + 120Hz).
final class LumenOrbitEffectsEngine {
  struct SoftParticle {
    let u: CGFloat
    let v: CGFloat
    let phase: Double
    let life: TimeInterval
    let dx: CGFloat
    let dy: CGFloat
    let size: CGFloat
    let r: UInt8
    let g: UInt8
    let b: UInt8
    let seed: CGFloat
  }

  final class DissolveJob {
    let itemID: String
    let texture: LumenSampledCardTexture?
    let particles: [SoftParticle]
    let particlesEnabled: Bool
    let glowEnabled: Bool
    let startTime: TimeInterval
    let finishTime: TimeInterval
    /// Returns the slot's current frame in GLOBAL scrolled rail coordinates:
    /// horizontal: `(globalCardOriginX - scrollOffset, topY, w, h)`
    /// vertical: `(x, globalCardOriginY - scrollOffset, w, h)`
    let globalAnchorFrameProvider: () -> NSRect?
    let onParticlesFinished: () -> Void
    var finished = false

    init(
      itemID: String,
      texture: LumenSampledCardTexture?,
      particles: [SoftParticle],
      particlesEnabled: Bool,
      glowEnabled: Bool,
      startTime: TimeInterval,
      finishTime: TimeInterval,
      globalAnchorFrameProvider: @escaping () -> NSRect?,
      onParticlesFinished: @escaping () -> Void
    ) {
      self.itemID = itemID
      self.texture = texture
      self.particles = particles
      self.particlesEnabled = particlesEnabled
      self.glowEnabled = glowEnabled
      self.startTime = startTime
      self.finishTime = finishTime
      self.globalAnchorFrameProvider = globalAnchorFrameProvider
      self.onParticlesFinished = onParticlesFinished
    }
  }

  final class AggregateJob {
    let itemID: String
    let texture: LumenSampledCardTexture?
    let particles: [SoftParticle]
    let glowEnabled: Bool
    let startTime: TimeInterval
    let duration: TimeInterval
    let globalAnchorFrameProvider: () -> NSRect?
    let onSetTargetAlpha: (CGFloat) -> Void

    init(
      itemID: String,
      texture: LumenSampledCardTexture?,
      particles: [SoftParticle],
      glowEnabled: Bool,
      startTime: TimeInterval,
      duration: TimeInterval,
      globalAnchorFrameProvider: @escaping () -> NSRect?,
      onSetTargetAlpha: @escaping (CGFloat) -> Void
    ) {
      self.itemID = itemID
      self.texture = texture
      self.particles = particles
      self.glowEnabled = glowEnabled
      self.startTime = startTime
      self.duration = duration
      self.globalAnchorFrameProvider = globalAnchorFrameProvider
      self.onSetTargetAlpha = onSetTargetAlpha
    }
  }

  private final class TickTask {
    let id: UUID
    let step: (TimeInterval) -> Bool // return false when complete
    init(id: UUID = UUID(), step: @escaping (TimeInterval) -> Bool) {
      self.id = id
      self.step = step
    }
  }

  private final class WeakOverlayBox {
    weak var overlay: LumenOrbitEffectsOverlayView?
    init(_ overlay: LumenOrbitEffectsOverlayView) { self.overlay = overlay }
  }

  private(set) var dissolveJobs: [String: DissolveJob] = [:]
  private(set) var aggregateJobs: [String: AggregateJob] = [:]
  private var tickTasks: [UUID: TickTask] = [:]
  private var overlayBoxes: [WeakOverlayBox] = []
  private var displayTimer: Timer?

  /// Unified frame timestamp updated once per tick so all participating viewports sample the exact same instant.
  private(set) var currentFrameTime: TimeInterval = CACurrentMediaTime()

  deinit {
    stopAll()
  }

  func attachOverlay(_ overlay: LumenOrbitEffectsOverlayView) {
    overlayBoxes.removeAll { $0.overlay == nil || $0.overlay === overlay }
    overlayBoxes.append(WeakOverlayBox(overlay))
    overlay.engine = self
    overlay.needsDisplay = true
  }

  func detachOverlay(_ overlay: LumenOrbitEffectsOverlayView) {
    overlayBoxes.removeAll { $0.overlay == nil || $0.overlay === overlay }
    if overlay.engine === self {
      overlay.engine = nil
    }
    overlay.needsDisplay = true
  }

  func hasActiveDissolve(for itemID: String) -> Bool {
    dissolveJobs[itemID] != nil
  }

  func isAggregating(itemID: String) -> Bool {
    aggregateJobs[itemID] != nil
  }

  /// Registers a shared-clock animation tick (used for 420ms continuous slot reflow & smooth cross-screen scroll).
  @discardableResult
  func addTickTask(_ step: @escaping (TimeInterval) -> Bool) -> UUID {
    let task = TickTask(step: step)
    tickTasks[task.id] = task
    ensureTimerRunning()
    return task.id
  }

  func removeTickTask(_ id: UUID) {
    tickTasks.removeValue(forKey: id)
    stopTimerIfIdle()
  }

  /// Launches Phase 1 of V14/V15 Soft Dissolution for a card being removed across 1..N screens.
  /// Invokes `onParticlesFinished` strictly AFTER every tail particle has extinguished.
  func startDissolve(
    itemID: String,
    cardView: NSView,
    fallbackTint: NSColor,
    particlesEnabled: Bool,
    glowEnabled: Bool,
    globalAnchorFrameProvider: @escaping () -> NSRect?,
    onParticlesFinished: @escaping () -> Void
  ) {
    cancelAggregation(for: itemID)
    cancelDissolve(for: itemID)

    let texture = LumenSampledCardTexture.capture(from: cardView)
    let now = CACurrentMediaTime()
    currentFrameTime = now

    if !particlesEnabled {
      let job = DissolveJob(
        itemID: itemID,
        texture: texture,
        particles: [],
        particlesEnabled: false,
        glowEnabled: glowEnabled,
        startTime: now,
        finishTime: now + LumenV15Tokens.dissolveNoParticlesHold,
        globalAnchorFrameProvider: globalAnchorFrameProvider,
        onParticlesFinished: onParticlesFinished
      )
      dissolveJobs[itemID] = job
      ensureTimerRunning()
      markOverlaysDirty()
      return
    }

    let rect = cardView.bounds
    let particles = buildParticles(width: rect.width, height: rect.height, texture: texture, fallbackTint: fallbackTint)
    var maxEnd: TimeInterval = LumenV15Tokens.dissolveHoldDuration
    for p in particles {
      let end = 0.02 + p.phase * 0.365 + p.life
      if end > maxEnd { maxEnd = end }
    }
    let job = DissolveJob(
      itemID: itemID,
      texture: texture,
      particles: particles,
      particlesEnabled: true,
      glowEnabled: glowEnabled,
      startTime: now,
      finishTime: now + maxEnd,
      globalAnchorFrameProvider: globalAnchorFrameProvider,
      onParticlesFinished: onParticlesFinished
    )
    dissolveJobs[itemID] = job
    ensureTimerRunning()
    markOverlaysDirty()
  }

  /// Launches reverse cotton-light aggregation for a newly captured or undone card (§16.4, §18.4).
  func startAggregation(
    itemID: String,
    cardView: NSView,
    fallbackTint: NSColor,
    particlesEnabled: Bool,
    glowEnabled: Bool,
    globalAnchorFrameProvider: @escaping () -> NSRect?,
    onSetTargetAlpha: @escaping (CGFloat) -> Void
  ) {
    cancelAggregation(for: itemID)
    guard LumenMotion.isEnabled else {
      onSetTargetAlpha(1)
      return
    }
    guard particlesEnabled else {
      onSetTargetAlpha(0)
      let startTime = CACurrentMediaTime()
      let duration: TimeInterval = 0.28
      _ = addTickTask { now in
        let t = min(1.0, max(0.0, (now - startTime) / duration))
        let eased = LumenMotion.cubicBezier(t, 0.2, 0.8, 0.2, 1.0)
        onSetTargetAlpha(CGFloat(eased))
        if t >= 1.0 {
          onSetTargetAlpha(1)
          return false
        }
        return true
      }
      return
    }

    // Capture full unclipped texture while card is opaque, then hide all live slices until aggregation finishes.
    onSetTargetAlpha(1)
    cardView.layoutSubtreeIfNeeded()
    let texture = LumenSampledCardTexture.capture(from: cardView)
    let particles = buildParticles(width: cardView.bounds.width, height: cardView.bounds.height, texture: texture, fallbackTint: fallbackTint)
    onSetTargetAlpha(0)

    let now = CACurrentMediaTime()
    currentFrameTime = now
    let job = AggregateJob(
      itemID: itemID,
      texture: texture,
      particles: particles,
      glowEnabled: glowEnabled,
      startTime: now,
      duration: LumenV15Tokens.captureAggregateDuration,
      globalAnchorFrameProvider: globalAnchorFrameProvider,
      onSetTargetAlpha: onSetTargetAlpha
    )
    aggregateJobs[itemID] = job
    ensureTimerRunning()
    markOverlaysDirty()
  }

  func cancelDissolve(for itemID: String) {
    dissolveJobs.removeValue(forKey: itemID)
    markOverlaysDirty()
    stopTimerIfIdle()
  }

  func cancelAggregation(for itemID: String) {
    if let existing = aggregateJobs.removeValue(forKey: itemID) {
      existing.onSetTargetAlpha(1)
    }
    markOverlaysDirty()
    stopTimerIfIdle()
  }

  func stopAll() {
    dissolveJobs.removeAll()
    for job in aggregateJobs.values {
      job.onSetTargetAlpha(1)
    }
    aggregateJobs.removeAll()
    tickTasks.removeAll()
    displayTimer?.invalidate()
    displayTimer = nil
    markOverlaysDirty()
  }

  func invalidateOverlays() {
    currentFrameTime = CACurrentMediaTime()
    markOverlaysDirty()
  }

  // MARK: Particle Generation

  private func buildParticles(width: CGFloat, height: CGFloat, texture: LumenSampledCardTexture?, fallbackTint: NSColor) -> [SoftParticle] {
    let nx = max(12, min(22, Int((width / 10.5).rounded())))
    let ny = max(14, min(24, Int((height / 10.5).rounded())))
    var result: [SoftParticle] = []
    result.reserveCapacity(nx * ny)

    var rng = SplitMix64(seed: UInt64(bitPattern: Int64(CACurrentMediaTime() * 1_000_000)))
    let fallbackRGB = fallbackTint.usingColorSpace(.sRGB) ?? NSColor(srgbRed: 0.72, green: 0.85, blue: 1.0, alpha: 1.0)
    let fbR = UInt8(max(0, min(255, Int((fallbackRGB.redComponent * 255).rounded()))))
    let fbG = UInt8(max(0, min(255, Int((fallbackRGB.greenComponent * 255).rounded()))))
    let fbB = UInt8(max(0, min(255, Int((fallbackRGB.blueComponent * 255).rounded()))))

    for y in 0..<ny {
      for x in 0..<nx {
        let u = (CGFloat(x) + 0.18 + rng.nextCGFloat() * 0.64) / CGFloat(nx)
        let v = (CGFloat(y) + 0.18 + rng.nextCGFloat() * 0.64) / CGFloat(ny)
        var r = fbR, g = fbG, b = fbB
        if let texture {
          let sampled = texture.sampleColor(u: u, v: v, fallbackTint: fallbackTint)
          if sampled.3 < 20 { continue }
          r = sampled.0
          g = sampled.1
          b = sampled.2
        }
        let phase = 0.62 * Double(u) + 0.38 * Double(1.0 - v) + rng.nextDouble() * 0.12
        let life = LumenV15Tokens.dissolveParticleLifeMin + rng.nextDouble() * (LumenV15Tokens.dissolveParticleLifeMax - LumenV15Tokens.dissolveParticleLifeMin)
        let dx = 8.0 + rng.nextCGFloat() * 37.0 + (u - 0.5) * 22.0
        // Flipped Y: negative dy drifts gently upward
        let dy = -(6.0 + rng.nextCGFloat() * 31.0 + (0.5 - v) * 16.0)
        let size = 1.65 + rng.nextCGFloat() * 2.10
        let seed = rng.nextCGFloat() * .pi * 2.0
        result.append(SoftParticle(u: u, v: v, phase: phase, life: life, dx: dx, dy: dy, size: size, r: r, g: g, b: b, seed: seed))
      }
    }
    return result
  }

  // MARK: Shared Unified Clock Loop

  private func ensureTimerRunning() {
    guard displayTimer == nil else { return }
    let timer = Timer(timeInterval: 1.0 / 90.0, repeats: true) { [weak self] _ in
      self?.tick()
    }
    RunLoop.main.add(timer, forMode: .common)
    displayTimer = timer
  }

  private func stopTimerIfIdle() {
    if dissolveJobs.isEmpty && aggregateJobs.isEmpty && tickTasks.isEmpty {
      displayTimer?.invalidate()
      displayTimer = nil
    }
  }

  private func tick() {
    let now = CACurrentMediaTime()
    currentFrameTime = now

    // 1. Advance shared-clock tick tasks (e.g. 420ms reservation collapse & smooth cross-screen scroll)
    if !tickTasks.isEmpty {
      let currentTasks = Array(tickTasks.values)
      for task in currentTasks {
        let keepRunning = task.step(now)
        if !keepRunning {
          tickTasks.removeValue(forKey: task.id)
        }
      }
    }

    // 2. Check dissolve job completions (strictly after every tail particle extinguishes)
    var completedDissolves: [DissolveJob] = []
    for (id, job) in dissolveJobs {
      if now >= job.finishTime && !job.finished {
        job.finished = true
        completedDissolves.append(job)
        dissolveJobs.removeValue(forKey: id)
      }
    }
    for job in completedDissolves {
      job.onParticlesFinished()
    }

    // 3. Check aggregation completions
    for (id, job) in aggregateJobs {
      if now >= job.startTime + job.duration {
        job.onSetTargetAlpha(1)
        aggregateJobs.removeValue(forKey: id)
      }
    }

    // 4. Redraw participating overlays whenever visual effects ran or just finished
    if !dissolveJobs.isEmpty || !aggregateJobs.isEmpty || !completedDissolves.isEmpty {
      markOverlaysDirty()
    }

    stopTimerIfIdle()
  }

  private func markOverlaysDirty() {
    overlayBoxes.removeAll { $0.overlay == nil }
    for box in overlayBoxes {
      box.overlay?.needsDisplay = true
    }
  }
}

// MARK: - Per-Viewport Non-Interactive Effects Overlay Slice

/// Lightweight per-viewport overlay mounted above `railViewport`.
/// Translates each active job in `LumenOrbitEffectsEngine` from global rail coordinates into
/// this viewport's local coordinate frame and clips cleanly to its card-rail strip.
final class LumenOrbitEffectsOverlayView: NSView {
  weak var engine: LumenOrbitEffectsEngine?
  var viewportRailRange: ClosedRange<CGFloat> = 0...1440
  var railLeadingInsetInOverlay: CGFloat = 0
  var isHorizontalRail: Bool = true

  override var isFlipped: Bool { true }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.masksToBounds = false
  }

  required init?(coder: NSCoder) { nil }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  func attachEngine(_ engine: LumenOrbitEffectsEngine) {
    engine.attachOverlay(self)
  }

  func detachEngine() {
    engine?.detachOverlay(self)
  }

  private func localFrame(from globalFrame: NSRect) -> NSRect {
    if isHorizontalRail {
      return NSRect(
        x: railLeadingInsetInOverlay + globalFrame.minX - viewportRailRange.lowerBound,
        y: globalFrame.minY,
        width: globalFrame.width,
        height: globalFrame.height
      )
    }
    return NSRect(
      x: globalFrame.minX,
      y: globalFrame.minY - viewportRailRange.lowerBound,
      width: globalFrame.width,
      height: globalFrame.height
    )
  }

  private func localRailClipRect() -> NSRect {
    if isHorizontalRail {
      return NSRect(
        x: railLeadingInsetInOverlay,
        y: 0,
        width: max(0, bounds.width - railLeadingInsetInOverlay),
        height: bounds.height
      )
    }
    return bounds
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let engine,
          !engine.dissolveJobs.isEmpty || !engine.aggregateJobs.isEmpty,
          let ctx = NSGraphicsContext.current?.cgContext else { return }

    let now = engine.currentFrameTime
    let clipRect = localRailClipRect()

    for job in engine.dissolveJobs.values {
      drawDissolveJob(job, now: now, clipRect: clipRect, in: ctx)
    }
    for job in engine.aggregateJobs.values {
      drawAggregateJob(job, now: now, clipRect: clipRect, in: ctx)
    }
  }

  private func drawDissolveJob(
    _ job: LumenOrbitEffectsEngine.DissolveJob,
    now: TimeInterval,
    clipRect: NSRect,
    in ctx: CGContext
  ) {
    guard let globalFrame = job.globalAnchorFrameProvider(),
          globalFrame.width > 1,
          globalFrame.height > 1 else { return }

    let frame = localFrame(from: globalFrame)
    // Cull jobs completely outside this viewport (including particle drift margin)
    guard frame.insetBy(dx: -110, dy: -110).intersects(bounds) else { return }

    let elapsed = max(0, now - job.startTime)

    ctx.saveGState()
    ctx.clip(to: clipRect.insetBy(dx: 0, dy: -90))

    if !job.particlesEnabled {
      let t = min(1.0, elapsed / max(0.01, LumenV15Tokens.dissolveNoParticlesHold))
      if let img = job.texture?.snapshot {
        let scale = CGFloat(1.0 - 0.045 * t)
        let dy = CGFloat(6.0 * t)
        let drawRect = CGRect(
          x: frame.midX - frame.width * scale / 2,
          y: frame.midY - frame.height * scale / 2 + dy,
          width: frame.width * scale,
          height: frame.height * scale
        )
        drawFlippedSnapshot(img, in: drawRect, cornerRadius: LumenV15Tokens.orbitCardCorner, alpha: CGFloat(1.0 - t), clipRect: clipRect, ctx: ctx)
      }
      ctx.restoreGState()
      return
    }

    // 1. Progressively dissolved card ghost with wide feathered diagonal front (front ≈ 480ms, §18.4)
    let frontProgress = max(-0.13, min(1.15, ((elapsed - 0.015) / LumenV15Tokens.dissolveFrontDuration) * 1.30 - 0.19))
    if let img = job.texture?.snapshot, frontProgress < 1.14 {
      let ghostAlpha = CGFloat(1.0 - 0.18 * min(1.0, elapsed / LumenV15Tokens.dissolveFrontDuration))
      drawFeatheredMaskedSnapshot(
        img,
        in: frame,
        front: CGFloat(frontProgress),
        reversed: false,
        alpha: ghostAlpha,
        clipRect: clipRect,
        ctx: ctx
      )
    }

    // 2. Shared cotton-light particles drifting seamlessly across viewport boundaries (peak alpha ≈ 0.58)
    for p in job.particles {
      let f = (elapsed - (0.02 + p.phase * 0.365)) / p.life
      if f <= 0 || f >= 1 { continue }
      let ff = CGFloat(f)
      let k = ff * ff * (3.0 - 2.0 * ff)
      let curl = sin(ff * .pi) * 5.0
      let px = frame.minX + p.u * frame.width + p.dx * k + sin(p.seed + ff * 3.0) * curl
      let py = frame.minY + p.v * frame.height + p.dy * k + cos(p.seed + ff * 3.0) * curl
      let sz = p.size * (1.0 - 0.35 * ff) * 8.0
      let pRect = CGRect(x: px - sz / 2, y: py - sz / 2, width: sz, height: sz)
      guard pRect.intersects(bounds) else { continue }
      let alpha = pow(max(0, sin(.pi * ff)), 1.25) * LumenV15Tokens.dissolveParticlePeakAlpha
      if let sprite = LumenSoftParticleSpriteCache.shared.sprite(r: p.r, g: p.g, b: p.b, glowEnabled: job.glowEnabled) {
        ctx.setAlpha(alpha)
        ctx.draw(sprite, in: pRect)
      }
    }
    ctx.setAlpha(1.0)
    ctx.restoreGState()
  }

  private func drawAggregateJob(
    _ job: LumenOrbitEffectsEngine.AggregateJob,
    now: TimeInterval,
    clipRect: NSRect,
    in ctx: CGContext
  ) {
    guard let globalFrame = job.globalAnchorFrameProvider(),
          globalFrame.width > 1,
          globalFrame.height > 1 else { return }

    let frame = localFrame(from: globalFrame)
    guard frame.insetBy(dx: -110, dy: -110).intersects(bounds) else { return }

    let t = max(0.0, min(1.0, (now - job.startTime) / max(0.01, job.duration)))
    let q = 1.0 - t

    ctx.saveGState()
    ctx.clip(to: clipRect.insetBy(dx: 0, dy: -90))

    // 1. Progressive diagonal reveal of the arriving card
    let front = max(-0.2, min(1.2, (q - 0.08) / 0.72))
    if let img = job.texture?.snapshot {
      let ghostAlpha = CGFloat(1.0 - max(0.0, (q - 0.78) / 0.22))
      drawFeatheredMaskedSnapshot(
        img,
        in: frame,
        front: CGFloat(front),
        reversed: true,
        alpha: ghostAlpha,
        clipRect: clipRect,
        ctx: ctx
      )
    }

    // 2. Coalescing cotton-light particles
    for p in job.particles {
      let f = (q - p.phase * 0.47) / 0.53
      if f <= 0 || f >= 1 { continue }
      let ff = CGFloat(f)
      let ease = 1.0 - pow(1.0 - ff, 2.0)
      let curl = sin(ff * .pi) * 8.0
      let px = frame.minX + p.u * frame.width + p.dx * ease + sin(p.seed + ff * 3.5) * curl
      let py = frame.minY + p.v * frame.height + p.dy * ease + cos(p.seed + ff * 3.5) * curl
      let sz = p.size * (1.0 - 0.35 * ff) * 8.0
      let pRect = CGRect(x: px - sz / 2, y: py - sz / 2, width: sz, height: sz)
      guard pRect.intersects(bounds) else { continue }
      let alpha = pow(max(0, sin(.pi * ff)), 1.25) * LumenV15Tokens.dissolveParticlePeakAlpha
      if let sprite = LumenSoftParticleSpriteCache.shared.sprite(r: p.r, g: p.g, b: p.b, glowEnabled: job.glowEnabled) {
        ctx.setAlpha(alpha)
        ctx.draw(sprite, in: pRect)
      }
    }
    ctx.setAlpha(1.0)
    ctx.restoreGState()
  }

  private func drawFlippedSnapshot(_ image: CGImage, in frame: CGRect, cornerRadius: CGFloat, alpha: CGFloat, clipRect: CGRect, ctx: CGContext) {
    ctx.saveGState()
    ctx.clip(to: clipRect)
    let rounded = CGPath(roundedRect: frame, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil)
    ctx.addPath(rounded)
    ctx.clip()
    ctx.setAlpha(alpha)
    ctx.translateBy(x: frame.minX, y: frame.maxY)
    ctx.scaleBy(x: 1, y: -1)
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: frame.width, height: frame.height))
    ctx.restoreGState()
  }

  private func drawFeatheredMaskedSnapshot(
    _ image: CGImage,
    in frame: CGRect,
    front: CGFloat,
    reversed: Bool,
    alpha: CGFloat,
    clipRect: CGRect,
    ctx: CGContext
  ) {
    guard let maskImg = makeDiagonalMaskImage(width: 96, height: 112, front: front, reversed: reversed) else {
      drawFlippedSnapshot(image, in: frame, cornerRadius: LumenV15Tokens.orbitCardCorner, alpha: alpha, clipRect: clipRect, ctx: ctx)
      return
    }
    ctx.saveGState()
    ctx.clip(to: clipRect)
    let rounded = CGPath(roundedRect: frame, cornerWidth: LumenV15Tokens.orbitCardCorner, cornerHeight: LumenV15Tokens.orbitCardCorner, transform: nil)
    ctx.addPath(rounded)
    ctx.clip()
    ctx.setAlpha(alpha)
    ctx.translateBy(x: frame.minX, y: frame.maxY)
    ctx.scaleBy(x: 1, y: -1)
    let localRect = CGRect(x: 0, y: 0, width: frame.width, height: frame.height)
    ctx.clip(to: localRect, mask: maskImg)
    ctx.draw(image, in: localRect)
    ctx.restoreGState()
  }

  private func makeDiagonalMaskImage(width: Int, height: Int, front: CGFloat, reversed: Bool) -> CGImage? {
    let space = CGColorSpaceCreateDeviceGray()
    guard let mctx = CGContext(
      data: nil,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: width,
      space: space,
      bitmapInfo: CGImageAlphaInfo.none.rawValue
    ) else { return nil }

    let w = CGFloat(width)
    let h = CGFloat(height)
    let loc0 = max(0, min(1, front - 0.23))
    let loc1 = max(loc0, min(1, front - 0.09))
    let loc2 = max(loc1, min(1, front + 0.08))
    let loc3 = max(loc2, min(1, front + 0.23))
    let colors = [
      CGColor(gray: 0.0, alpha: 1.0),
      CGColor(gray: 0.18, alpha: 1.0),
      CGColor(gray: 0.66, alpha: 1.0),
      CGColor(gray: 1.0, alpha: 1.0)
    ] as CFArray
    if let grad = CGGradient(colorsSpace: space, colors: colors, locations: [loc0, loc1, loc2, loc3]) {
      let start = reversed ? CGPoint(x: 0, y: h) : CGPoint(x: 0, y: 0)
      let end = reversed ? CGPoint(x: w, y: 0) : CGPoint(x: w, y: h)
      mctx.drawLinearGradient(grad, start: start, end: end, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    }
    return mctx.makeImage()
  }
}

/// Fast deterministic PRNG for organic particle jitter without per-particle SystemRandomNumberGenerator overhead.
private struct SplitMix64 {
  private var state: UInt64

  init(seed: UInt64) {
    self.state = seed == 0 ? 0x9E3779B97F4A7C15 : seed
  }

  mutating func next() -> UInt64 {
    state &+= 0x9E3779B97F4A7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
    z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
    return z ^ (z >> 31)
  }

  mutating func nextDouble() -> Double {
    Double(next() >> 11) / Double(1 << 53)
  }

  mutating func nextCGFloat() -> CGFloat {
    CGFloat(nextDouble())
  }
}
