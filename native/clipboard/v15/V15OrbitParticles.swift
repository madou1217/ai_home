import AppKit
import CoreGraphics
import Foundation
import QuartzCore

// MARK: - Cached Soft Radial Glow Sprites (§18.4, HTML `v13Sprite`)

/// Generates and caches premultiplied soft cotton-light radial glow sprites (32×32).
/// Strictly avoids sharp star/cross flares per `README-Lumen-V15.md` §18.4.
private final class V15SoftSpriteCache {
  static let shared = V15SoftSpriteCache()

  private var cache: [String: CGImage] = [:]
  private var insertionOrder: [String] = []
  private let capacity = 64

  private init() {}

  func sprite(for color: NSColor, glowEnabled: Bool) -> CGImage? {
    let rgb = color.usingColorSpace(.sRGB) ?? color
    // Quantize to 5-bit per channel so real-texture sampling stays cache-friendly
    let rq = Int((rgb.redComponent * 31).rounded())
    let gq = Int((rgb.greenComponent * 31).rounded())
    let bq = Int((rgb.blueComponent * 31).rounded())
    let key = "\(rq)_\(gq)_\(bq)_\(glowEnabled ? 1 : 0)"
    if let existing = cache[key] {
      return existing
    }

    let r = CGFloat(rq) / 31.0
    let g = CGFloat(gq) / 31.0
    let b = CGFloat(bq) / 31.0
    let size = 32
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(
      data: nil,
      width: size,
      height: size,
      bitsPerComponent: 8,
      bytesPerRow: 0,
      space: colorSpace,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }

    let center = CGPoint(x: 16, y: 16)
    if glowEnabled {
      // Source: `paste-lumen-v15.html` line 647 `v13Sprite`:
      // stops: 0.0 -> 0.88 (e0), 0.20 -> 0.60 (99), 0.44 -> 0.27 (44), 0.72 -> 0.07 (11), 1.0 -> 0.0
      let colors: [CGColor] = [
        NSColor(srgbRed: r, green: g, blue: b, alpha: 0.88).cgColor,
        NSColor(srgbRed: r, green: g, blue: b, alpha: 0.60).cgColor,
        NSColor(srgbRed: r, green: g, blue: b, alpha: 0.27).cgColor,
        NSColor(srgbRed: r, green: g, blue: b, alpha: 0.07).cgColor,
        NSColor(srgbRed: r, green: g, blue: b, alpha: 0.00).cgColor
      ]
      if let grad = CGGradient(colorsSpace: colorSpace, colors: colors as CFArray, locations: [0.0, 0.20, 0.44, 0.72, 1.0]) {
        ctx.drawRadialGradient(grad, startCenter: center, startRadius: 1.0, endCenter: center, endRadius: 15.0, options: [])
      }
    }

    let coreRadius: CGFloat = glowEnabled ? 1.4 : 3.0
    ctx.setFillColor(NSColor(srgbRed: r, green: g, blue: b, alpha: 0.64).cgColor)
    ctx.fillEllipse(in: CGRect(x: 16 - coreRadius, y: 16 - coreRadius, width: coreRadius * 2, height: coreRadius * 2))

    guard let image = ctx.makeImage() else { return nil }
    if insertionOrder.count >= capacity, let evicted = insertionOrder.first {
      insertionOrder.removeFirst()
      cache.removeValue(forKey: evicted)
    }
    cache[key] = image
    insertionOrder.append(key)
    return image
  }
}

// MARK: - Real Card Texture Color Sampler (§16.3, §18.4)

private struct V15TextureSampler {
  private let width: Int
  private let height: Int
  private let bytes: [UInt8]
  private let fallbackPalette: [NSColor]

  init(snapshot: CGImage?, fallbackPalette: [NSColor]) {
    self.fallbackPalette = fallbackPalette.isEmpty ? V15Tokens.Particles.fallbackPaletteDefault : fallbackPalette

    guard let cg = snapshot, cg.width > 0, cg.height > 0 else {
      self.width = 0
      self.height = 0
      self.bytes = []
      return
    }

    let sampleW = 32
    let sampleH = 32
    var buf = [UInt8](repeating: 0, count: sampleW * sampleH * 4)
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let ok = buf.withUnsafeMutableBytes { ptr -> Bool in
      guard let base = ptr.baseAddress,
            let ctx = CGContext(
              data: base,
              width: sampleW,
              height: sampleH,
              bitsPerComponent: 8,
              bytesPerRow: sampleW * 4,
              space: colorSpace,
              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
      ctx.interpolationQuality = .low
      ctx.draw(cg, in: CGRect(x: 0, y: 0, width: sampleW, height: sampleH))
      return true
    }

    if ok {
      self.width = sampleW
      self.height = sampleH
      self.bytes = buf
    } else {
      self.width = 0
      self.height = 0
      self.bytes = []
    }
  }

  func color(atNormalizedU u: CGFloat, v: CGFloat, fallbackIndex: Int) -> NSColor {
    guard width > 0, height > 0 else {
      return fallbackPalette[abs(fallbackIndex) % fallbackPalette.count]
    }
    let px = max(0, min(width - 1, Int((u * CGFloat(width - 1)).rounded())))
    // CoreGraphics bitmap buffer row 0 is top of image when drawn normally
    let py = max(0, min(height - 1, Int((v * CGFloat(height - 1)).rounded())))
    let offset = (py * width + px) * 4
    let a = CGFloat(bytes[offset + 3]) / 255.0
    guard a > 0.15 else {
      return fallbackPalette[abs(fallbackIndex) % fallbackPalette.count]
    }
    let r = min(1, (CGFloat(bytes[offset]) / 255.0) / a)
    let g = min(1, (CGFloat(bytes[offset + 1]) / 255.0) / a)
    let b = min(1, (CGFloat(bytes[offset + 2]) / 255.0) / a)
    let sampled = NSColor(srgbRed: r, green: g, blue: b, alpha: 1.0)
    // Lift dark content subtly into luminous cotton-dust range while preserving source hue
    let luminance = V15Color.relativeLuminance(of: sampled)
    let liftRatio: CGFloat = luminance < 0.25 ? 0.42 : 0.22
    return V15Color.mix(sampled, with: V15Color.hex("#eaf6ff"), ratio: liftRatio)
  }
}

// MARK: - Particle Field & Task Models

struct V15SoftParticle {
  let u: CGFloat
  let v: CGFloat
  let phase: Double
  let startDelay: TimeInterval
  let life: TimeInterval
  let dx: CGFloat
  let dy: CGFloat
  let baseSize: CGFloat
  let seed: CGFloat
  let color: NSColor
}

final class V15ParticleFieldTask {
  enum Kind {
    case dissolve
    case capture
  }

  let id = UUID()
  let itemID: String
  let kind: Kind
  let startTime: TimeInterval
  let holdDuration: TimeInterval
  let particlesEnabled: Bool
  let glowEnabled: Bool
  let snapshot: CGImage?
  let particles: [V15SoftParticle]
  let anchorProvider: () -> CGRect?
  let onFinished: () -> Void

  var isFinished = false

  init(
    itemID: String,
    kind: Kind,
    startTime: TimeInterval,
    holdDuration: TimeInterval,
    particlesEnabled: Bool,
    glowEnabled: Bool,
    snapshot: CGImage?,
    particles: [V15SoftParticle],
    anchorProvider: @escaping () -> CGRect?,
    onFinished: @escaping () -> Void
  ) {
    self.itemID = itemID
    self.kind = kind
    self.startTime = startTime
    self.holdDuration = holdDuration
    self.particlesEnabled = particlesEnabled
    self.glowEnabled = glowEnabled
    self.snapshot = snapshot
    self.particles = particles
    self.anchorProvider = anchorProvider
    self.onFinished = onFinished
  }
}

private final class V15ValueAnimationTask {
  let id = UUID()
  let startTime: TimeInterval
  let duration: TimeInterval
  let curve: V15CubicBezier
  let onUpdate: (Double) -> Void
  let onFinish: () -> Void

  init(
    startTime: TimeInterval,
    duration: TimeInterval,
    curve: V15CubicBezier,
    onUpdate: @escaping (Double) -> Void,
    onFinish: @escaping () -> Void
  ) {
    self.startTime = startTime
    self.duration = duration
    self.curve = curve
    self.onUpdate = onUpdate
    self.onFinish = onFinish
  }
}

// MARK: - Shared Single-Clock Multi-Display Particle & Motion Engine (§8, §17.2, §18.4)

/// Coordinates ALL active Orbit visual effects on ONE single monotonic clock (`CACurrentMediaTime()`):
/// - Two-phase soft dissolution (`480ms` diagonal front, `320–500ms` particles, peak alpha `0.58`,
///   `920ms` hold with strict reservation lock, followed by `420ms` reflow).
/// - Reverse soft capture / undo aggregation (`900ms`, peak alpha `0.58`).
/// - Cross-display reflow and smooth scroll interpolation.
/// Stops its run-loop timer automatically whenever idle so hidden/idle panels consume zero CPU/GPU.
final class V15OrbitParticleEngine {
  private(set) var fieldTasks: [V15ParticleFieldTask] = []
  private var valueTasks: [V15ValueAnimationTask] = []
  private var overlays: [WeakOverlayRef] = []
  private var tickTimer: Timer?

  private struct WeakOverlayRef {
    weak var view: V15OrbitParticlesOverlayView?
  }

  deinit {
    stopAll()
  }

  func attachOverlay(_ view: V15OrbitParticlesOverlayView) {
    overlays.removeAll { $0.view == nil || $0.view === view }
    overlays.append(WeakOverlayRef(view: view))
  }

  func detachOverlay(_ view: V15OrbitParticlesOverlayView) {
    overlays.removeAll { $0.view == nil || $0.view === view }
  }

  // MARK: Soft Dissolution (§17.2, §18.4, A39, A49–A51, A65)

  /// Begins soft cotton-dust dissolution for a deleted card.
  /// `onParticlesFinished` fires ONLY after BOTH `dissolve.hold` (920ms) AND every tail particle
  /// have fully extinguished, guaranteeing right-hand cards never move prematurely.
  @discardableResult
  func startDissolve(
    itemID: String,
    category: LumenLogicalCategory,
    swatchColor: NSColor?,
    snapshot: CGImage?,
    initialFrame: CGRect,
    particlesEnabled: Bool,
    glowEnabled: Bool,
    anchorProvider: @escaping () -> CGRect?,
    onParticlesFinished: @escaping () -> Void
  ) -> UUID {
    cancelFieldTasks(forItemID: itemID)

    let hold = particlesEnabled
      ? V15Tokens.Particles.dissolveHoldDuration
      : V15Tokens.Particles.dissolveNoParticlesHoldDuration

    let palette = paletteFor(category: category, swatchColor: swatchColor)
    var particles: [V15SoftParticle] = []

    if particlesEnabled && initialFrame.width > 8 && initialFrame.height > 8 {
      let sampler = V15TextureSampler(snapshot: snapshot, fallbackPalette: palette)
      // Grid matching `paste-lumen-v15.html` line 656 capped cleanly for 120Hz budget
      var nx = max(12, Int(round(initialFrame.width / 5.5)))
      var ny = max(15, Int(round(initialFrame.height / 5.5)))
      while nx * ny > 420 {
        nx = max(10, nx - 2)
        ny = max(12, ny - 2)
      }
      particles.reserveCapacity(nx * ny)

      for y in 0..<ny {
        for x in 0..<nx {
          let u = (CGFloat(x) + 0.18 + CGFloat.random(in: 0...0.64)) / CGFloat(nx)
          let v = (CGFloat(y) + 0.18 + CGFloat.random(in: 0...0.64)) / CGFloat(ny)
          let phase = Double(0.62 * u + 0.38 * (1.0 - v)) + Double.random(in: 0...0.12)
          let startDelay = V15Tokens.Particles.dissolveParticleStartBase
            + phase * V15Tokens.Particles.dissolveParticlePhaseSpan
          let life = V15Tokens.Particles.dissolveParticleLifeMin
            + Double.random(in: 0...V15Tokens.Particles.dissolveParticleLifeRange)
          // Clamp startDelay + life <= holdDuration so all tail particles extinguish cleanly on schedule
          let clampedLife = min(life, max(0.22, hold - startDelay))
          let dx = 8.0 + CGFloat.random(in: 0...37.0) + (u - 0.5) * 22.0
          let dy = -10.0 - CGFloat.random(in: 0...43.0) + (v - 0.5) * 18.0
          let size = 0.6 + pow(CGFloat.random(in: 0...1), 1.7) * 1.5
          let seed = CGFloat.random(in: 0...(2.0 * .pi))
          let color = sampler.color(atNormalizedU: u, v: v, fallbackIndex: x + y * 3)
          particles.append(V15SoftParticle(
            u: u, v: v, phase: phase, startDelay: startDelay, life: clampedLife,
            dx: dx, dy: dy, baseSize: size, seed: seed, color: color
          ))
        }
      }
    }

    let task = V15ParticleFieldTask(
      itemID: itemID,
      kind: .dissolve,
      startTime: CACurrentMediaTime(),
      holdDuration: hold,
      particlesEnabled: particlesEnabled,
      glowEnabled: glowEnabled,
      snapshot: snapshot,
      particles: particles,
      anchorProvider: anchorProvider,
      onFinished: onParticlesFinished
    )
    fieldTasks.append(task)
    ensureClockRunning()
    notifyOverlaysNeedsDisplay()
    return task.id
  }

  // MARK: Soft Capture / Undo Aggregation (§16.4, §18.4, A40, A50)

  /// Begins 900ms soft reverse particle aggregation for a newly captured or undone card.
  @discardableResult
  func startCapture(
    itemID: String,
    category: LumenLogicalCategory,
    swatchColor: NSColor?,
    snapshot: CGImage?,
    initialFrame: CGRect,
    glowEnabled: Bool,
    anchorProvider: @escaping () -> CGRect?,
    onFinished: @escaping () -> Void
  ) -> UUID {
    cancelFieldTasks(forItemID: itemID)
    // Keep at most 3 concurrent capture fields to prevent overload on burst copies (§16.4)
    let activeCaptures = fieldTasks.filter { $0.kind == .capture }
    if activeCaptures.count >= 3, let oldest = activeCaptures.first {
      cancelFieldTask(id: oldest.id)
    }

    let palette = paletteFor(category: category, swatchColor: swatchColor)
    let sampler = V15TextureSampler(snapshot: snapshot, fallbackPalette: palette)
    let count = min(380, max(160, Int((initialFrame.width * initialFrame.height) / 110.0)))
    var particles: [V15SoftParticle] = []
    particles.reserveCapacity(count)

    for i in 0..<count {
      var u = CGFloat.random(in: 0...1)
      let v = CGFloat.random(in: 0...1)
      if i % 4 == 0 {
        u = (i % 8 == 0) ? 0.025 : 0.975
      }
      let phase = Double(0.62 * u + 0.38 * (1.0 - v))
      let angle = CGFloat.random(in: 0...(2.0 * .pi))
      let dist = 15.0 + CGFloat.random(in: 0...62.0)
      let dx = cos(angle) * dist + 24.0
      let dy = sin(angle) * dist - 28.0
      let size = 0.5 + CGFloat.random(in: 0...1.35)
      let seed = CGFloat.random(in: 0...(2.0 * .pi))
      let color = sampler.color(atNormalizedU: u, v: v, fallbackIndex: i)
      particles.append(V15SoftParticle(
        u: u, v: v, phase: phase, startDelay: 0, life: 0.53,
        dx: dx, dy: dy, baseSize: size, seed: seed, color: color
      ))
    }

    let task = V15ParticleFieldTask(
      itemID: itemID,
      kind: .capture,
      startTime: CACurrentMediaTime(),
      holdDuration: V15Tokens.Particles.captureDuration,
      particlesEnabled: true,
      glowEnabled: glowEnabled,
      snapshot: snapshot,
      particles: particles,
      anchorProvider: anchorProvider,
      onFinished: onFinished
    )
    fieldTasks.append(task)
    ensureClockRunning()
    notifyOverlaysNeedsDisplay()
    return task.id
  }

  func cancelFieldTasks(forItemID itemID: String) {
    let matching = fieldTasks.filter { $0.itemID == itemID }
    guard !matching.isEmpty else { return }
    fieldTasks.removeAll { $0.itemID == itemID }
    for task in matching where !task.isFinished {
      task.isFinished = true
      if task.kind == .capture {
        task.onFinished()
      }
    }
    notifyOverlaysNeedsDisplay()
    stopClockIfIdle()
  }

  func cancelFieldTask(id: UUID) {
    guard let idx = fieldTasks.firstIndex(where: { $0.id == id }) else { return }
    let task = fieldTasks.remove(at: idx)
    if !task.isFinished {
      task.isFinished = true
      if task.kind == .capture {
        task.onFinished()
      }
    }
    notifyOverlaysNeedsDisplay()
    stopClockIfIdle()
  }

  // MARK: Shared Clock Value Animations (Reflow, Restore Expand, Smooth Scroll)

  @discardableResult
  func startValueAnimation(
    duration: TimeInterval,
    curve: V15CubicBezier,
    onUpdate: @escaping (Double) -> Void,
    onFinish: @escaping () -> Void
  ) -> UUID {
    if duration <= 0 || !V15Motion.isEnabled {
      onUpdate(1.0)
      onFinish()
      return UUID()
    }
    let task = V15ValueAnimationTask(
      startTime: CACurrentMediaTime(),
      duration: duration,
      curve: curve,
      onUpdate: onUpdate,
      onFinish: onFinish
    )
    valueTasks.append(task)
    ensureClockRunning()
    return task.id
  }

  func cancelValueAnimation(_ id: UUID?) {
    guard let id else { return }
    valueTasks.removeAll { $0.id == id }
    stopClockIfIdle()
  }

  func stopAll() {
    let pendingCaptures = fieldTasks.filter { $0.kind == .capture && !$0.isFinished }
    fieldTasks.removeAll()
    valueTasks.removeAll()
    tickTimer?.invalidate()
    tickTimer = nil
    for task in pendingCaptures {
      task.isFinished = true
      task.onFinished()
    }
    notifyOverlaysNeedsDisplay()
  }

  // MARK: Clock Tick

  private func ensureClockRunning() {
    guard tickTimer == nil else { return }
    let maxFPS = max(60, min(120, NSScreen.screens.map(\.maximumFramesPerSecond).max() ?? 60))
    let interval = 1.0 / Double(maxFPS)
    let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
      self?.tick()
    }
    RunLoop.main.add(timer, forMode: .common)
    tickTimer = timer
  }

  private func stopClockIfIdle() {
    if fieldTasks.isEmpty && valueTasks.isEmpty {
      tickTimer?.invalidate()
      tickTimer = nil
    }
  }

  private func tick() {
    let now = CACurrentMediaTime()

    // 1. Advance value animations (reflow, scroll, slot expand)
    if !valueTasks.isEmpty {
      var completed: [V15ValueAnimationTask] = []
      var remaining: [V15ValueAnimationTask] = []
      for task in valueTasks {
        let raw = max(0, min(1, (now - task.startTime) / max(0.001, task.duration)))
        let eased = task.curve.evaluate(raw)
        task.onUpdate(eased)
        if raw >= 1.0 {
          completed.append(task)
        } else {
          remaining.append(task)
        }
      }
      valueTasks = remaining
      for task in completed {
        task.onFinish()
      }
    }

    // 2. Check particle field completions (wait for hold AND all tail particles extinguished)
    if !fieldTasks.isEmpty {
      var completedFields: [V15ParticleFieldTask] = []
      var activeFields: [V15ParticleFieldTask] = []
      for task in fieldTasks {
        let elapsed = now - task.startTime
        let allParticlesDone: Bool
        switch task.kind {
        case .dissolve:
          if !task.particlesEnabled {
            allParticlesDone = elapsed >= task.holdDuration
          } else {
            let tailDone = !task.particles.contains { p in
              elapsed < (p.startDelay + p.life)
            }
            allParticlesDone = elapsed >= task.holdDuration && tailDone
          }
        case .capture:
          allParticlesDone = elapsed >= task.holdDuration
        }

        if allParticlesDone || task.anchorProvider() == nil {
          completedFields.append(task)
        } else {
          activeFields.append(task)
        }
      }
      fieldTasks = activeFields
      notifyOverlaysNeedsDisplay()

      for task in completedFields where !task.isFinished {
        task.isFinished = true
        task.onFinished()
      }
    }

    stopClockIfIdle()
  }

  private func notifyOverlaysNeedsDisplay() {
    overlays.removeAll { $0.view == nil }
    for ref in overlays {
      ref.view?.needsDisplay = true
    }
  }

  private func paletteFor(category: LumenLogicalCategory, swatchColor: NSColor?) -> [NSColor] {
    if category == .color, let swatch = swatchColor {
      return [swatch, swatch, V15Color.hex("#d9edff"), V15Color.hex("#ffffff")]
    }
    switch category {
    case .code: return V15Tokens.Particles.fallbackPaletteCode
    case .image: return V15Tokens.Particles.fallbackPaletteImage
    case .link: return V15Tokens.Particles.fallbackPaletteLink
    default: return V15Tokens.Particles.fallbackPaletteDefault
    }
  }
}

// MARK: - Per-Viewport Transparent Particle & Dissolve Ghost Overlay

/// Renders all active soft dissolution / capture ghosts and cotton-light particles intersecting
/// one physical display viewport's global `railRange`. Never intercepts pointer events.
final class V15OrbitParticlesOverlayView: NSView {
  override var isFlipped: Bool { true }

  private weak var engine: V15OrbitParticleEngine?
  var railRangeLowerBound: CGFloat = 0
  var railOriginOffsetX: CGFloat = 0 // 38 on leftmost screen (dots column), 0 on right screens

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.masksToBounds = true
  }

  required init?(coder: NSCoder) { nil }

  override func hitTest(_ point: NSPoint) -> NSView? {
    nil
  }

  func attachEngine(_ engine: V15OrbitParticleEngine) {
    self.engine = engine
    engine.attachOverlay(self)
  }

  func detachEngine() {
    engine?.detachOverlay(self)
    engine = nil
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let engine, !engine.fieldTasks.isEmpty,
          let ctx = NSGraphicsContext.current?.cgContext else {
      return
    }
    let now = CACurrentMediaTime()

    for task in engine.fieldTasks {
      guard let globalRect = task.anchorProvider() else { continue }
      // Project global rail coordinates into this display panel's local flipped space
      let localRect = CGRect(
        x: railOriginOffsetX + (globalRect.minX - railRangeLowerBound),
        y: globalRect.minY,
        width: globalRect.width,
        height: globalRect.height
      )
      // Cull tasks far outside this physical screen
      if localRect.maxX < -120 || localRect.minX > bounds.width + 120 {
        continue
      }

      switch task.kind {
      case .dissolve:
        drawDissolveTask(task, localRect: localRect, now: now, in: ctx)
      case .capture:
        drawCaptureTask(task, localRect: localRect, now: now, in: ctx)
      }
    }
  }

  private func drawDissolveTask(_ task: V15ParticleFieldTask, localRect: CGRect, now: TimeInterval, in ctx: CGContext) {
    let elapsed = max(0, now - task.startTime)
    let hold = max(0.001, task.holdDuration)

    // 1. Card ghost deconstruction
    if let snapshot = task.snapshot {
      if !task.particlesEnabled {
        let t = CGFloat(min(1.0, elapsed / hold))
        let scale = 1.0 - 0.045 * t
        let w = localRect.width * scale
        let h = localRect.height * scale
        let drawRect = CGRect(
          x: localRect.midX - w * 0.5,
          y: localRect.midY - h * 0.5 + 6.0 * t,
          width: w,
          height: h
        )
        ctx.saveGState()
        let safeR = max(0, min(V15Tokens.Card.cornerRadius, min(drawRect.width, drawRect.height) * 0.5))
        ctx.addPath(CGPath(roundedRect: drawRect, cornerWidth: safeR, cornerHeight: safeR, transform: nil))
        ctx.clip()
        ctx.setAlpha(1.0 - t)
        NSImage(cgImage: snapshot, size: drawRect.size).draw(in: drawRect)
        ctx.restoreGState()
      } else {
        // Source: `paste-lumen-v15.html` line 663:
        // `front = clamp(-0.13, 1.15, (elapsed - 0.015) / 0.48 * 1.30 - 0.19)`
        let rawFront = ((elapsed - V15Tokens.Particles.dissolveFrontStartDelay) / V15Tokens.Particles.dissolveFrontDuration) * 1.30 - 0.19
        let front = CGFloat(max(-0.13, min(1.15, rawFront)))
        let ghostAlpha = CGFloat(1.0 - 0.18 * min(1.0, elapsed / V15Tokens.Particles.dissolveFrontDuration))
        if front < 1.14 && ghostAlpha > 0.01 {
          drawFeatheredMaskedGhost(
            snapshot: snapshot,
            in: localRect,
            angleDegrees: V15Tokens.Particles.dissolveMaskAngleDegrees,
            front: front,
            bandHalfWidth: 0.23,
            innerStop1: -0.09,
            innerAlpha1: 0.18,
            innerStop2: 0.08,
            innerAlpha2: 0.66,
            opacity: ghostAlpha,
            in: ctx
          )
        }
      }
    }

    // 2. Soft cotton-dust particles (`peak alpha 0.58`, life `320–500ms`)
    guard task.particlesEnabled else { return }
    ctx.saveGState()
    ctx.clip(to: CGRect(x: railOriginOffsetX, y: 0, width: bounds.width - railOriginOffsetX, height: bounds.height))
    ctx.setBlendMode(.normal)

    for p in task.particles {
      let f = (elapsed - p.startDelay) / max(0.001, p.life)
      if f <= 0 || f >= 1 { continue }
      let fg = CGFloat(f)
      let k = fg * fg * (3.0 - 2.0 * fg) // smoothstep
      let curl = sin(fg * .pi) * 5.0
      let px = localRect.minX + p.u * localRect.width + p.dx * k + sin(p.seed + fg * 3.0) * curl
      let py = localRect.minY + p.v * localRect.height + p.dy * k + cos(p.seed + fg * 3.0) * curl
      let alpha = pow(sin(.pi * fg), 1.25) * V15Tokens.Particles.dissolvePeakAlpha
      if alpha <= 0.005 { continue }
      let sz = p.baseSize * (1.0 - 0.35 * fg) * 8.0
      guard let sprite = V15SoftSpriteCache.shared.sprite(for: p.color, glowEnabled: task.glowEnabled) else { continue }
      ctx.setAlpha(alpha)
      ctx.draw(sprite, in: CGRect(x: px - sz * 0.5, y: py - sz * 0.5, width: sz, height: sz))
    }
    ctx.restoreGState()
  }

  private func drawCaptureTask(_ task: V15ParticleFieldTask, localRect: CGRect, now: TimeInterval, in ctx: CGContext) {
    let elapsed = max(0, now - task.startTime)
    let t = max(0.0, min(1.0, elapsed / max(0.001, task.holdDuration)))
    let q = 1.0 - t // reverse field: starts dispersed, converges into card

    // 1. Revealing card ghost (`138deg` wide feather)
    if let snapshot = task.snapshot {
      let front = CGFloat(max(-0.20, min(1.20, (q - 0.08) / 0.72)))
      let ghostAlpha = CGFloat(1.0 - max(0.0, (q - 0.78) / 0.22))
      if ghostAlpha > 0.01 {
        drawFeatheredMaskedGhost(
          snapshot: snapshot,
          in: localRect,
          angleDegrees: V15Tokens.Particles.captureMaskAngleDegrees,
          front: front,
          bandHalfWidth: 0.25,
          innerStop1: -0.08,
          innerAlpha1: 0.30,
          innerStop2: 0.10,
          innerAlpha2: 0.72,
          opacity: ghostAlpha,
          in: ctx
        )
      }
    }

    // 2. Converging soft cotton-light particles (peak alpha 0.58)
    ctx.saveGState()
    ctx.clip(to: CGRect(x: railOriginOffsetX, y: 0, width: bounds.width - railOriginOffsetX, height: bounds.height))
    ctx.setBlendMode(.plusLighter)

    for p in task.particles {
      let f = (q - p.phase * 0.47) / 0.53
      if f <= 0 || f >= 1 { continue }
      let fg = CGFloat(f)
      let ease = 1.0 - pow(1.0 - fg, 2.0)
      let curl = sin(fg * .pi) * 12.0
      let px = localRect.minX + p.u * localRect.width + p.dx * ease + sin(p.seed + fg * 4.0) * curl
      let py = localRect.minY + p.v * localRect.height + p.dy * ease + cos(p.seed + fg * 4.0) * curl
      let alpha = pow(sin(.pi * fg), 1.25) * V15Tokens.Particles.capturePeakAlpha
      if alpha <= 0.005 { continue }
      let sz = p.baseSize * (1.0 - 0.35 * fg) * 8.0
      guard let sprite = V15SoftSpriteCache.shared.sprite(for: p.color, glowEnabled: task.glowEnabled) else { continue }
      ctx.setAlpha(alpha)
      ctx.draw(sprite, in: CGRect(x: px - sz * 0.5, y: py - sz * 0.5, width: sz, height: sz))
    }
    ctx.restoreGState()
  }

  private func drawFeatheredMaskedGhost(
    snapshot: CGImage,
    in rect: CGRect,
    angleDegrees: CGFloat,
    front: CGFloat,
    bandHalfWidth: CGFloat,
    innerStop1: CGFloat,
    innerAlpha1: CGFloat,
    innerStop2: CGFloat,
    innerAlpha2: CGFloat,
    opacity: CGFloat,
    in ctx: CGContext
  ) {
    guard rect.width > 0, rect.height > 0 else { return }
    ctx.saveGState()
    let corner = max(0, min(V15Tokens.Card.cornerRadius, min(rect.width, rect.height) * 0.5))
    ctx.addPath(CGPath(roundedRect: rect, cornerWidth: corner, cornerHeight: corner, transform: nil))
    ctx.clip()
    ctx.setAlpha(opacity)
    ctx.beginTransparencyLayer(in: rect, auxiliaryInfo: nil)

    NSImage(cgImage: snapshot, size: rect.size).draw(in: rect)

    ctx.setBlendMode(.destinationIn)
    let pts = V15Materials.gradientPoints(cssDegrees: angleDegrees, isFlipped: true)
    let startPt = CGPoint(x: rect.minX + pts.0.x * rect.width, y: rect.minY + pts.0.y * rect.height)
    let endPt = CGPoint(x: rect.minX + pts.1.x * rect.width, y: rect.minY + pts.1.y * rect.height)

    let l0 = max(0, min(1, front - bandHalfWidth))
    let l1 = max(l0, min(1, front + innerStop1))
    let l2 = max(l1, min(1, front + innerStop2))
    let l3 = max(l2, min(1, front + bandHalfWidth))

    let maskColors: [CGColor] = [
      NSColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.0).cgColor,
      NSColor(srgbRed: 1, green: 1, blue: 1, alpha: innerAlpha1).cgColor,
      NSColor(srgbRed: 1, green: 1, blue: 1, alpha: innerAlpha2).cgColor,
      NSColor(srgbRed: 1, green: 1, blue: 1, alpha: 1.0).cgColor
    ]
    if let grad = CGGradient(
      colorsSpace: CGColorSpaceCreateDeviceRGB(),
      colors: maskColors as CFArray,
      locations: [l0, l1, l2, l3]
    ) {
      ctx.drawLinearGradient(
        grad,
        start: startPt,
        end: endPt,
        options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
      )
    }

    ctx.endTransparencyLayer()
    ctx.restoreGState()
  }
}

// MARK: - Subtle Ambient Background Light Dust (Behind Rail, z-index: 0)

/// Gentle floating optical dust specks rendered behind cards when Orbit is visible and particles are on.
/// Strictly renders soft radial glows (zero cross/star flares per §18.4) and stops immediately when hidden.
final class V15OrbitAmbientParticlesView: NSView {
  override var isFlipped: Bool { true }

  private struct AmbientDust {
    let x: CGFloat
    let y: CGFloat
    let radius: CGFloat
    let phase: CGFloat
    let speed: CGFloat
  }

  private let specks: [AmbientDust]
  private var timer: Timer?
  private var isRunning = false
  private var glowEnabled = true

  override init(frame frameRect: NSRect) {
    self.specks = (0..<64).map { _ in
      AmbientDust(
        x: CGFloat.random(in: 0...1),
        y: CGFloat.random(in: 0...1),
        radius: CGFloat.random(in: 0.6...1.5),
        phase: CGFloat.random(in: 0...(2.0 * .pi)),
        speed: CGFloat.random(in: 0.25...0.85)
      )
    }
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.masksToBounds = true
  }

  required init?(coder: NSCoder) { nil }

  deinit {
    stop()
  }

  override func hitTest(_ point: NSPoint) -> NSView? {
    nil
  }

  func setActive(_ active: Bool, particlesEnabled: Bool, glowEnabled: Bool) {
    self.glowEnabled = glowEnabled
    let shouldRun = active && particlesEnabled && V15Motion.isEnabled
    isHidden = !(active && particlesEnabled)
    if shouldRun {
      start()
    } else {
      stop()
      needsDisplay = active && particlesEnabled
    }
  }

  private func start() {
    guard !isRunning else { return }
    isRunning = true
    // Ambient dust runs comfortably at 30fps matching HTML line 288 `if (t - lastFrame < 30)`
    let t = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
      self?.needsDisplay = true
    }
    RunLoop.main.add(t, forMode: .common)
    timer = t
  }

  func stop() {
    isRunning = false
    timer?.invalidate()
    timer = nil
  }

  override func draw(_ dirtyRect: NSRect) {
    guard !isHidden, bounds.width > 1, bounds.height > 1,
          let ctx = NSGraphicsContext.current?.cgContext else {
      return
    }
    let tm = V15Motion.isEnabled ? CGFloat(CACurrentMediaTime()) : 0
    let count = min(specks.count, max(12, Int(bounds.width / 12.0)))
    let dustColor = V15Color.hex("#effbff")
    guard let sprite = V15SoftSpriteCache.shared.sprite(for: dustColor, glowEnabled: glowEnabled) else { return }

    for i in 0..<count {
      let p = specks[i]
      let rawX = (p.x + tm * p.speed * 0.003).truncatingRemainder(dividingBy: 1.0)
      let x = rawX * bounds.width
      let y = (p.y + 0.055 * sin(tm * 0.5 + p.phase)) * bounds.height
      let wave = 0.5 + 0.5 * sin(tm * p.speed + p.phase)
      let alpha = (0.14 + 0.36 * wave * wave)
      let sz = p.radius * 7.0
      ctx.setAlpha(alpha)
      ctx.draw(sprite, in: CGRect(x: x - sz * 0.5, y: y - sz * 0.5, width: sz, height: sz))
    }
  }
}
