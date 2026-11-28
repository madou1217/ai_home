import AppKit
import CoreGraphics
import Foundation
import QuartzCore

// MARK: - Premultiplied Soft-Glow Particle Sprite Cache (§18.4 — Zero Hard Crosshairs)

final class LumenSoftParticleSpriteCache {
  static let shared = LumenSoftParticleSpriteCache()

  private var cache: [String: CGImage] = [:]
  private var keyOrder: [String] = []
  private let limit = 64

  private init() {}

  func sprite(r: UInt8, g: UInt8, b: UInt8, glowEnabled: Bool) -> CGImage? {
    // Quantize to 16-step buckets so sprite memory remains strictly bounded
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
    let af = max(0.1, CGFloat(a) / 255.0)
    let rawR = min(1.0, (CGFloat(rgbaBytes[offset]) / 255.0) / af)
    let rawG = min(1.0, (CGFloat(rgbaBytes[offset + 1]) / 255.0) / af)
    let rawB = min(1.0, (CGFloat(rgbaBytes[offset + 2]) / 255.0) / af)
    let lift: CGFloat = 0.26
    let r = UInt8(min(255, Int(((rawR * (1 - lift) + 0.92 * lift) * 255).rounded())))
    let g = UInt8(min(255, Int(((rawG * (1 - lift) + 0.96 * lift) * 255).rounded())))
    let b = UInt8(min(255, Int(((rawB * (1 - lift) + 1.00 * lift) * 255).rounded())))
    return (r, g, b, a)
  }

  private func rgbBytes(from color: NSColor) -> (UInt8, UInt8, UInt8, UInt8) {
    let rgb = color.usingColorSpace(.sRGB) ?? color
    return (
      UInt8(max(0, min(255, Int((rgb.redComponent * 255).rounded())))),
      UInt8(max(0, min(255, Int((rgb.greenComponent * 255).rounded())))),
      UInt8(max(0, min(255, Int((rgb.blueComponent * 255).rounded())))),
      255
    )
  }
}

// MARK: - Soft Dissolution & Aggregation Overlay View (§17.2, §18.4, §16.4)

/// Non-interactive composited overlay hosted above an Orbit viewport rail.
/// Drives:
/// 1. Texture-driven soft dissolution on delete (`front ≈ 480ms`, particles `320–500ms`, peak alpha `≈ 0.58`),
///    invoking `onParticlesFinished` strictly AFTER every tail particle extinguishes.
/// 2. Reverse soft-particle aggregation on live capture or undo restore (`≈ 900ms`).
/// 3. Shared display-synced continuous reflow ticks (`420ms`) so zero extra timers run when idle.
final class LumenOrbitEffectsOverlayView: NSView {
  private struct SoftParticle {
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

  private final class DissolveJob {
    let itemID: String
    let texture: LumenSampledCardTexture?
    let particles: [SoftParticle]
    let particlesEnabled: Bool
    let glowEnabled: Bool
    let startTime: TimeInterval
    let finishTime: TimeInterval
    let anchorFrameProvider: () -> NSRect?
    let clipRectProvider: () -> NSRect
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
      anchorFrameProvider: @escaping () -> NSRect?,
      clipRectProvider: @escaping () -> NSRect,
      onParticlesFinished: @escaping () -> Void
    ) {
      self.itemID = itemID
      self.texture = texture
      self.particles = particles
      self.particlesEnabled = particlesEnabled
      self.glowEnabled = glowEnabled
      self.startTime = startTime
      self.finishTime = finishTime
      self.anchorFrameProvider = anchorFrameProvider
      self.clipRectProvider = clipRectProvider
      self.onParticlesFinished = onParticlesFinished
    }
  }

  private final class AggregateJob {
    let itemID: String
    weak var targetView: NSView?
    let texture: LumenSampledCardTexture?
    let particles: [SoftParticle]
    let glowEnabled: Bool
    let startTime: TimeInterval
    let duration: TimeInterval
    let anchorFrameProvider: () -> NSRect?
    let clipRectProvider: () -> NSRect

    init(
      itemID: String,
      targetView: NSView,
      texture: LumenSampledCardTexture?,
      particles: [SoftParticle],
      glowEnabled: Bool,
      startTime: TimeInterval,
      duration: TimeInterval,
      anchorFrameProvider: @escaping () -> NSRect?,
      clipRectProvider: @escaping () -> NSRect
    ) {
      self.itemID = itemID
      self.targetView = targetView
      self.texture = texture
      self.particles = particles
      self.glowEnabled = glowEnabled
      self.startTime = startTime
      self.duration = duration
      self.anchorFrameProvider = anchorFrameProvider
      self.clipRectProvider = clipRectProvider
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

  private var dissolveJobs: [String: DissolveJob] = [:]
  private var aggregateJobs: [String: AggregateJob] = [:]
  private var tickTasks: [UUID: TickTask] = [:]
  private var displayTimer: Timer?

  override var isFlipped: Bool { true }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.masksToBounds = false
  }

  required init?(coder: NSCoder) { nil }

  deinit {
    stopAll()
  }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  func hasActiveDissolve(for itemID: String) -> Bool {
    dissolveJobs[itemID] != nil
  }

  /// Registers a shared-clock animation tick (used for 420ms continuous slot collapse/expand).
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

  /// Launches Phase 1 of V14/V15 Soft Dissolution for a card being removed.
  /// Invokes `onParticlesFinished` only after every tail particle has fully extinguished.
  func startDissolve(
    itemID: String,
    cardView: NSView,
    fallbackTint: NSColor,
    particlesEnabled: Bool,
    glowEnabled: Bool,
    anchorFrameProvider: @escaping () -> NSRect?,
    clipRectProvider: @escaping () -> NSRect,
    onParticlesFinished: @escaping () -> Void
  ) {
    cancelAggregation(for: itemID)
    cancelDissolve(for: itemID)

    let texture = LumenSampledCardTexture.capture(from: cardView)
    let now = CACurrentMediaTime()

    if !particlesEnabled {
      let job = DissolveJob(
        itemID: itemID,
        texture: texture,
        particles: [],
        particlesEnabled: false,
        glowEnabled: glowEnabled,
        startTime: now,
        finishTime: now + LumenV15Tokens.dissolveNoParticlesHold,
        anchorFrameProvider: anchorFrameProvider,
        clipRectProvider: clipRectProvider,
        onParticlesFinished: onParticlesFinished
      )
      dissolveJobs[itemID] = job
      ensureTimerRunning()
      needsDisplay = true
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
      anchorFrameProvider: anchorFrameProvider,
      clipRectProvider: clipRectProvider,
      onParticlesFinished: onParticlesFinished
    )
    dissolveJobs[itemID] = job
    ensureTimerRunning()
    needsDisplay = true
  }

  /// Launches reverse cotton-light aggregation for a newly captured or undone card (§16.4, §18.4).
  func startAggregation(
    itemID: String,
    cardView: NSView,
    fallbackTint: NSColor,
    particlesEnabled: Bool,
    glowEnabled: Bool,
    anchorFrameProvider: @escaping () -> NSRect?,
    clipRectProvider: @escaping () -> NSRect
  ) {
    cancelAggregation(for: itemID)
    guard LumenMotion.isEnabled else {
      cardView.alphaValue = 1
      return
    }
    guard particlesEnabled else {
      cardView.alphaValue = 0
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = 0.28
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
        cardView.animator().alphaValue = 1
      }
      return
    }

    // Capture texture while card is temporarily opaque, then hide real card until aggregation finishes
    cardView.alphaValue = 1
    cardView.layoutSubtreeIfNeeded()
    let texture = LumenSampledCardTexture.capture(from: cardView)
    let particles = buildParticles(width: cardView.bounds.width, height: cardView.bounds.height, texture: texture, fallbackTint: fallbackTint)
    cardView.alphaValue = 0

    let job = AggregateJob(
      itemID: itemID,
      targetView: cardView,
      texture: texture,
      particles: particles,
      glowEnabled: glowEnabled,
      startTime: CACurrentMediaTime(),
      duration: LumenV15Tokens.captureAggregateDuration,
      anchorFrameProvider: anchorFrameProvider,
      clipRectProvider: clipRectProvider
    )
    aggregateJobs[itemID] = job
    ensureTimerRunning()
    needsDisplay = true
  }

  func cancelDissolve(for itemID: String) {
    dissolveJobs.removeValue(forKey: itemID)
    needsDisplay = true
    stopTimerIfIdle()
  }

  func cancelAggregation(for itemID: String) {
    if let existing = aggregateJobs.removeValue(forKey: itemID) {
      existing.targetView?.alphaValue = 1
    }
    needsDisplay = true
    stopTimerIfIdle()
  }

  func stopAll() {
    dissolveJobs.removeAll()
    for job in aggregateJobs.values {
      job.targetView?.alphaValue = 1
    }
    aggregateJobs.removeAll()
    tickTasks.removeAll()
    displayTimer?.invalidate()
    displayTimer = nil
    needsDisplay = true
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
        let dy = -(10.0 + rng.nextCGFloat() * 43.0) + (v - 0.5) * 18.0
        let size = 0.6 + pow(rng.nextCGFloat(), 1.7) * 1.5
        let seed = rng.nextCGFloat() * 6.2831853
        result.append(SoftParticle(u: u, v: v, phase: phase, life: life, dx: dx, dy: dy, size: size, r: r, g: g, b: b, seed: seed))
      }
    }
    return result
  }

  // MARK: Shared Frame Clock

  private func ensureTimerRunning() {
    guard displayTimer == nil else { return }
    let timer = Timer(timeInterval: 1.0 / 90.0, repeats: true) { [weak self] _ in
      self?.tickFrame()
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

  private func tickFrame() {
    let now = CACurrentMediaTime()

    // 1. Advance continuous layout/reflow tick tasks
    if !tickTasks.isEmpty {
      var finishedTaskIDs: [UUID] = []
      for (id, task) in tickTasks {
        if !task.step(now) {
          finishedTaskIDs.append(id)
        }
      }
      for id in finishedTaskIDs {
        tickTasks.removeValue(forKey: id)
      }
    }

    // 2. Check dissolve completions (strictly after all tail particles extinguish)
    var completedDissolves: [DissolveJob] = []
    for (id, job) in dissolveJobs {
      if now >= job.finishTime || job.anchorFrameProvider() == nil {
        dissolveJobs.removeValue(forKey: id)
        if !job.finished {
          job.finished = true
          completedDissolves.append(job)
        }
      }
    }
    for job in completedDissolves {
      job.onParticlesFinished()
    }

    // 3. Check aggregation completions
    var completedAggregations: [String] = []
    for (id, job) in aggregateJobs {
      if now - job.startTime >= job.duration || job.anchorFrameProvider() == nil {
        job.targetView?.alphaValue = 1
        completedAggregations.append(id)
      }
    }
    for id in completedAggregations {
      aggregateJobs.removeValue(forKey: id)
    }

    if !dissolveJobs.isEmpty || !aggregateJobs.isEmpty {
      needsDisplay = true
    } else if !completedDissolves.isEmpty || !completedAggregations.isEmpty {
      needsDisplay = true
    }

    stopTimerIfIdle()
  }

  // MARK: Rendering

  override func draw(_ dirtyRect: NSRect) {
    guard !dissolveJobs.isEmpty || !aggregateJobs.isEmpty,
          let ctx = NSGraphicsContext.current?.cgContext else {
      return
    }
    let now = CACurrentMediaTime()

    for job in dissolveJobs.values {
      drawDissolveJob(job, now: now, in: ctx)
    }
    for job in aggregateJobs.values {
      drawAggregateJob(job, now: now, in: ctx)
    }
  }

  private func drawDissolveJob(_ job: DissolveJob, now: TimeInterval, in ctx: CGContext) {
    guard let frame = job.anchorFrameProvider(), frame.width > 1, frame.height > 1 else { return }
    let clipRect = job.clipRectProvider()
    let elapsed = max(0, now - job.startTime)

    ctx.saveGState()
    ctx.clip(to: clipRect.insetBy(dx: 0, dy: -90))

    if !job.particlesEnabled {
      // Short smooth dissolve when particles are off (§17.2)
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

    // 1. Draw progressively dissolved card ghost with wide feathered diagonal front (front ≈ 480ms, §18.4)
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

    // 2. Draw cotton-light particles drifting outward-upward (peak alpha ≈ 0.58)
    for p in job.particles {
      let f = (elapsed - (0.02 + p.phase * 0.365)) / p.life
      if f <= 0 || f >= 1 { continue }
      let ff = CGFloat(f)
      let k = ff * ff * (3.0 - 2.0 * ff)
      let curl = sin(ff * .pi) * 5.0
      let px = frame.minX + p.u * frame.width + p.dx * k + sin(p.seed + ff * 3.0) * curl
      let py = frame.minY + p.v * frame.height + p.dy * k + cos(p.seed + ff * 3.0) * curl
      let alpha = pow(max(0, sin(.pi * ff)), 1.25) * LumenV15Tokens.dissolveParticlePeakAlpha
      let sz = p.size * (1.0 - 0.35 * ff) * 8.0
      if let sprite = LumenSoftParticleSpriteCache.shared.sprite(r: p.r, g: p.g, b: p.b, glowEnabled: job.glowEnabled) {
        ctx.setAlpha(alpha)
        ctx.draw(sprite, in: CGRect(x: px - sz / 2, y: py - sz / 2, width: sz, height: sz))
      }
    }
    ctx.setAlpha(1.0)
    ctx.restoreGState()
  }

  private func drawAggregateJob(_ job: AggregateJob, now: TimeInterval, in ctx: CGContext) {
    guard let frame = job.anchorFrameProvider(), frame.width > 1, frame.height > 1 else { return }
    let clipRect = job.clipRectProvider()
    let t = max(0.0, min(1.0, (now - job.startTime) / max(0.01, job.duration)))
    let q = 1.0 - t // reverse dissolution field for cotton-light aggregation (§16.4, §18.4)

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
      let alpha = pow(max(0, sin(.pi * ff)), 1.25) * LumenV15Tokens.dissolveParticlePeakAlpha
      let sz = p.size * (1.0 - 0.35 * ff) * 8.0
      if let sprite = LumenSoftParticleSpriteCache.shared.sprite(r: p.r, g: p.g, b: p.b, glowEnabled: job.glowEnabled) {
        ctx.setAlpha(alpha)
        ctx.draw(sprite, in: CGRect(x: px - sz / 2, y: py - sz / 2, width: sz, height: sz))
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

  /// Draws `image` masked by a wide diagonal soft-feathered alpha gradient (68° / 138°).
  private func drawFeatheredMaskedSnapshot(
    _ image: CGImage,
    in frame: CGRect,
    front: CGFloat,
    reversed: Bool,
    alpha: CGFloat,
    clipRect: CGRect,
    ctx: CGContext
  ) {
    guard let maskImg = makeDiagonalMaskImage(width: 96, height: 108, front: front, reversed: reversed) else {
      drawFlippedSnapshot(image, in: frame, cornerRadius: LumenV15Tokens.orbitCardCorner, alpha: alpha, clipRect: clipRect, ctx: ctx)
      return
    }
    ctx.saveGState()
    ctx.clip(to: clipRect)
    let rounded = CGPath(roundedRect: frame, cornerWidth: LumenV15Tokens.orbitCardCorner, cornerHeight: LumenV15Tokens.orbitCardCorner, transform: nil)
    ctx.addPath(rounded)
    ctx.clip()
    ctx.setAlpha(alpha)
    // Flip local rect so both CGImage snapshot and mask align top-to-bottom
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
    // Mask values in device gray: 0 = transparent (dissolved), 1 = opaque (remaining)
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
