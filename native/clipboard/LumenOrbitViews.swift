import AppKit
import CoreGraphics
import Foundation
import PDFKit
import QuartzCore

/// Non-activating borderless floating NSPanel dedicated to an Orbit screen-edge viewport.
final class LumenOrbitHostPanel: NSPanel {
  var onKeyEvent: ((NSEvent) -> Bool)?
  var onCancel: (() -> Void)?

  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }

  override func sendEvent(_ event: NSEvent) {
    if event.type == .keyDown, let handler = onKeyEvent, handler(event) {
      return
    }
    super.sendEvent(event)
  }

  override func cancelOperation(_ sender: Any?) {
    onCancel?()
  }
}

/// Translucent glass backdrop for Orbit with luminous specular edge, pointer spotlight,
/// and GPU-composited Core Animation ambient particle field.
final class LumenOrbitBackdropView: NSView {
  private let effectView = NSVisualEffectView()
  private let sheenOverlay = LumenOrbitSheenOverlayView()
  private let particleHost = NSView()
  private var emitterLayer: CAEmitterLayer?
  private var pointerTrackingArea: NSTrackingArea?

  var edgePosition: String = "bottom" {
    didSet {
      sheenOverlay.edgePosition = edgePosition
      sheenOverlay.needsDisplay = true
    }
  }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.masksToBounds = false

    effectView.blendingMode = .behindWindow
    effectView.state = .active
    effectView.translatesAutoresizingMaskIntoConstraints = false

    particleHost.wantsLayer = true
    particleHost.layer?.masksToBounds = true
    particleHost.translatesAutoresizingMaskIntoConstraints = false

    sheenOverlay.translatesAutoresizingMaskIntoConstraints = false

    addSubview(effectView)
    addSubview(particleHost)
    addSubview(sheenOverlay)

    NSLayoutConstraint.activate([
      effectView.topAnchor.constraint(equalTo: topAnchor),
      effectView.leadingAnchor.constraint(equalTo: leadingAnchor),
      effectView.trailingAnchor.constraint(equalTo: trailingAnchor),
      effectView.bottomAnchor.constraint(equalTo: bottomAnchor),

      particleHost.topAnchor.constraint(equalTo: topAnchor),
      particleHost.leadingAnchor.constraint(equalTo: leadingAnchor),
      particleHost.trailingAnchor.constraint(equalTo: trailingAnchor),
      particleHost.bottomAnchor.constraint(equalTo: bottomAnchor),

      sheenOverlay.topAnchor.constraint(equalTo: topAnchor),
      sheenOverlay.leadingAnchor.constraint(equalTo: leadingAnchor),
      sheenOverlay.trailingAnchor.constraint(equalTo: trailingAnchor),
      sheenOverlay.bottomAnchor.constraint(equalTo: bottomAnchor)
    ])
  }

  required init?(coder: NSCoder) { nil }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let existing = pointerTrackingArea {
      removeTrackingArea(existing)
    }
    let area = NSTrackingArea(
      rect: bounds,
      options: [.activeAlways, .mouseMoved, .mouseEnteredAndExited, .inVisibleRect],
      owner: self,
      userInfo: nil
    )
    addTrackingArea(area)
    pointerTrackingArea = area
  }

  override func mouseMoved(with event: NSEvent) {
    super.mouseMoved(with: event)
    let pt = convert(event.locationInWindow, from: nil)
    sheenOverlay.pointerLocation = pt
    sheenOverlay.needsDisplay = true
  }

  override func layout() {
    super.layout()
    updateEmitterGeometry()
  }

  func applyTheme(_ palette: LumenPalette, preferences: LumenVisualPreferences) {
    appearance = palette.nsAppearance
    effectView.appearance = palette.nsAppearance
    effectView.material = palette.isDark ? .hudWindow : .popover
    sheenOverlay.palette = palette
    sheenOverlay.glowEnabled = preferences.glow
    sheenOverlay.needsDisplay = true
    reconcileParticles(enabled: preferences.particles && LumenMotion.isEnabled, palette: palette)
  }

  private func reconcileParticles(enabled: Bool, palette: LumenPalette) {
    guard enabled else {
      emitterLayer?.removeFromSuperlayer()
      emitterLayer = nil
      return
    }
    if emitterLayer == nil {
      let emitter = CAEmitterLayer()
      emitter.emitterShape = .rectangle
      emitter.renderMode = .additive

      let cell = CAEmitterCell()
      cell.contents = Self.makeGlowParticleCGImage()
      cell.birthRate = 5.5
      cell.lifetime = 8.0
      cell.lifetimeRange = 3.0
      cell.velocity = 11
      cell.velocityRange = 8
      cell.emissionRange = .pi * 2
      cell.scale = 0.22
      cell.scaleRange = 0.24
      cell.alphaSpeed = -0.10
      cell.alphaRange = 0.45
      cell.color = (palette.isDark
        ? NSColor(srgbRed: 0.78, green: 0.90, blue: 1.0, alpha: 0.65)
        : NSColor(srgbRed: 0.95, green: 0.99, blue: 1.0, alpha: 0.85)).cgColor
      emitter.emitterCells = [cell]
      particleHost.layer?.addSublayer(emitter)
      emitterLayer = emitter
    }
    updateEmitterGeometry()
  }

  private func updateEmitterGeometry() {
    guard let emitter = emitterLayer else { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    emitter.frame = particleHost.bounds
    emitter.emitterPosition = CGPoint(x: particleHost.bounds.midX, y: particleHost.bounds.midY)
    emitter.emitterSize = CGSize(width: max(1, particleHost.bounds.width), height: max(1, particleHost.bounds.height))
    CATransaction.commit()
  }

  private static func makeGlowParticleCGImage() -> CGImage? {
    let size = 16
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
    let center = CGPoint(x: CGFloat(size) / 2, y: CGFloat(size) / 2)
    let colors = [
      NSColor.white.withAlphaComponent(0.95).cgColor,
      NSColor(srgbRed: 0.78, green: 0.92, blue: 1.0, alpha: 0.45).cgColor,
      NSColor.clear.cgColor
    ] as CFArray
    if let grad = CGGradient(colorsSpace: space, colors: colors, locations: [0, 0.35, 1]) {
      ctx.drawRadialGradient(grad, startCenter: center, startRadius: 0, endCenter: center, endRadius: CGFloat(size) / 2, options: [])
    }
    return ctx.makeImage()
  }
}

private final class LumenOrbitSheenOverlayView: NSView {
  var palette: LumenPalette = .light
  var edgePosition: String = "bottom"
  var glowEnabled: Bool = true
  var pointerLocation: NSPoint = .zero

  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  override func draw(_ dirtyRect: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    let space = CGColorSpaceCreateDeviceRGB()

    if let bg = CGGradient(
      colorsSpace: space,
      colors: [palette.orbitBackdropTop.cgColor, palette.orbitBackdropBottom.cgColor] as CFArray,
      locations: [0, 1]
    ) {
      ctx.drawLinearGradient(bg, start: CGPoint(x: 0, y: bounds.maxY), end: CGPoint(x: 0, y: 0), options: [])
    }

    if glowEnabled {
      let mx = pointerLocation == .zero ? bounds.midX : pointerLocation.x
      let spotCenter = edgePosition == "bottom"
        ? CGPoint(x: mx, y: bounds.maxY)
        : CGPoint(x: edgePosition == "left" ? bounds.maxX : 0, y: pointerLocation == .zero ? bounds.midY : pointerLocation.y)
      let spotColor = palette.isDark
        ? NSColor(srgbRed: 0.54, green: 0.72, blue: 1.0, alpha: 0.28)
        : NSColor(srgbRed: 0.91, green: 0.96, blue: 1.0, alpha: 0.55)
      if let radial = CGGradient(colorsSpace: space, colors: [spotColor.cgColor, NSColor.clear.cgColor] as CFArray, locations: [0, 1]) {
        ctx.drawRadialGradient(radial, startCenter: spotCenter, startRadius: 0, endCenter: spotCenter, endRadius: 340, options: [])
      }
    }

    ctx.setFillColor(palette.orbitTopSheen.withAlphaComponent(glowEnabled ? 0.88 : 0.35).cgColor)
    switch edgePosition {
    case "left":
      ctx.fill(CGRect(x: bounds.maxX - 1.5, y: 0, width: 1.5, height: bounds.height))
    case "right":
      ctx.fill(CGRect(x: 0, y: 0, width: 1.5, height: bounds.height))
    default:
      ctx.fill(CGRect(x: 0, y: bounds.maxY - 1.5, width: bounds.width, height: 1.5))
    }
  }
}

/// Horizontal/vertical wheel-friendly smooth rail scroll view:
/// - Shift + wheel routes to Optical Dots category switching (§3.3, A06).
/// - Normal wheel scrolls horizontally along the continuous card rail.
/// - Drag panning and animated focus centering update shared `scrollOffset`.
final class LumenOrbitRailScrollView: NSScrollView {
  var isHorizontalRail = true
  var onShiftWheel: ((NSEvent) -> Void)?
  var onScrollOffsetChanged: ((CGFloat) -> Void)?

  private var dragOriginWindow: NSPoint?
  private var dragStartClipOrigin: NSPoint = .zero
  private(set) var didDragPan = false

  override func scrollWheel(with event: NSEvent) {
    if event.modifierFlags.contains(.shift), let onShiftWheel {
      onShiftWheel(event)
      return
    }
    guard isHorizontalRail else {
      super.scrollWheel(with: event)
      return
    }
    if abs(event.scrollingDeltaY) > abs(event.scrollingDeltaX) && abs(event.scrollingDeltaY) > 0.1 {
      let scale: CGFloat = event.hasPreciseScrollingDeltas ? 1.0 : 18.0
      let nextX = contentView.bounds.origin.x - event.scrollingDeltaY * scale
      scrollHorizontalClamped(to: nextX)
      return
    }
    super.scrollWheel(with: event)
    onScrollOffsetChanged?(contentView.bounds.origin.x)
  }

  func scrollHorizontalClamped(to rawX: CGFloat) {
    guard let doc = documentView else { return }
    let maxX = max(0, doc.frame.width - contentView.bounds.width)
    let clamped = max(0, min(maxX, rawX))
    contentView.scroll(to: NSPoint(x: clamped, y: contentView.bounds.origin.y))
    reflectScrolledClipView(contentView)
    onScrollOffsetChanged?(clamped)
  }

  func scrollToRectAnimated(_ rect: NSRect, animated: Bool) {
    guard let doc = documentView else { return }
    let visible = contentView.bounds
    var target = visible.origin
    if isHorizontalRail {
      let pad: CGFloat = 24
      if rect.minX < visible.minX + pad {
        target.x = max(0, rect.minX - pad)
      } else if rect.maxX > visible.maxX - pad {
        target.x = min(max(0, doc.frame.width - visible.width), rect.maxX - visible.width + pad)
      }
    } else {
      let pad: CGFloat = 20
      if rect.minY < visible.minY + pad {
        target.y = max(0, rect.minY - pad)
      } else if rect.maxY > visible.maxY - pad {
        target.y = min(max(0, doc.frame.height - visible.height), rect.maxY - visible.height + pad)
      }
    }
    guard target != visible.origin else { return }
    if animated && LumenMotion.isEnabled {
      NSAnimationContext.runAnimationGroup({ ctx in
        ctx.duration = 0.24
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.85, 0.25, 1)
        self.contentView.animator().setBoundsOrigin(target)
      }, completionHandler: { [weak self] in
        guard let self else { return }
        self.reflectScrolledClipView(self.contentView)
        self.onScrollOffsetChanged?(self.contentView.bounds.origin.x)
      })
    } else {
      contentView.scroll(to: target)
      reflectScrolledClipView(contentView)
      onScrollOffsetChanged?(target.x)
    }
  }

  func beginRailDrag(with event: NSEvent) {
    dragOriginWindow = event.locationInWindow
    dragStartClipOrigin = contentView.bounds.origin
    didDragPan = false
  }

  func continueRailDrag(with event: NSEvent) {
    guard isHorizontalRail, let origin = dragOriginWindow else { return }
    let dx = event.locationInWindow.x - origin.x
    if abs(dx) > 7 {
      didDragPan = true
      scrollHorizontalClamped(to: dragStartClipOrigin.x - dx)
    }
  }

  @discardableResult
  func endRailDrag() -> Bool {
    let dragged = didDragPan
    dragOriginWindow = nil
    didDragPan = false
    return dragged
  }

  override func mouseDown(with event: NSEvent) {
    beginRailDrag(with: event)
    super.mouseDown(with: event)
  }

  override func mouseDragged(with event: NSEvent) {
    if isHorizontalRail, dragOriginWindow != nil {
      continueRailDrag(with: event)
      if didDragPan { return }
    }
    super.mouseDragged(with: event)
  }

  override func mouseUp(with event: NSEvent) {
    _ = endRailDrag()
    super.mouseUp(with: event)
  }
}

// MARK: - V15 Orbit Remove Affordance (§19.1, A38, A48, A68, A69)

/// Independent 28×28 DIP hit target hosting a 22×22 DIP circular optical surface
/// and a 13×13 DIP self-drawn round-cap X glyph.
/// Sibling of the card surface inside the shared lift container so it moves in lockstep
/// with the card lift (0 / -2 / -5 / -7 DIP) without independent drift.
final class LumenOrbitRemoveButton: NSView {
  var onRemove: (() -> Void)?

  private let surfaceLayer = CAGradientLayer()
  private let glyphView = NSImageView()
  private var trackingArea: NSTrackingArea?
  private var palette: LumenPalette = .light
  private var isRevealed = false
  private var isButtonHovered = false
  private var isPressed = false
  private var fadeWork: DispatchWorkItem?
  private var scaleWork: DispatchWorkItem?

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.masksToBounds = false
    alphaValue = 0

    surfaceLayer.cornerRadius = LumenV15Tokens.orbitCloseSurfaceSize / 2
    surfaceLayer.startPoint = CGPoint(x: 0.15, y: 1.0)
    surfaceLayer.endPoint = CGPoint(x: 0.85, y: 0.0)
    surfaceLayer.borderWidth = 0.65
    surfaceLayer.shadowOpacity = 0.22
    surfaceLayer.shadowRadius = 4
    surfaceLayer.shadowOffset = NSSize(width: 0, height: -1)
    layer?.addSublayer(surfaceLayer)

    glyphView.wantsLayer = true
    glyphView.imageScaling = .scaleProportionallyDown
    glyphView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(glyphView)

    NSLayoutConstraint.activate([
      glyphView.centerXAnchor.constraint(equalTo: centerXAnchor),
      glyphView.centerYAnchor.constraint(equalTo: centerYAnchor),
      glyphView.widthAnchor.constraint(equalToConstant: LumenV15Tokens.orbitCloseGlyphSize),
      glyphView.heightAnchor.constraint(equalToConstant: LumenV15Tokens.orbitCloseGlyphSize)
    ])

    setAccessibilityRole(.button)
    setAccessibilityLabel("移除记录")
    toolTip = "移除记录 (Delete)"
    applyVisualAppearance(animated: false)
  }

  required init?(coder: NSCoder) { nil }

  deinit {
    fadeWork?.cancel()
    scaleWork?.cancel()
  }

  var isInteractive: Bool { isRevealed }

  func configureAccessibility(itemTitle: String) {
    setAccessibilityLabel("移除 \(itemTitle)")
  }

  override func layout() {
    super.layout()
    let inset = LumenV15Tokens.orbitCloseSurfaceInset
    let circleRect = bounds.insetBy(dx: inset, dy: inset)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    surfaceLayer.frame = circleRect
    surfaceLayer.cornerRadius = min(circleRect.width, circleRect.height) / 2
    CATransaction.commit()
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let existing = trackingArea { removeTrackingArea(existing) }
    let area = NSTrackingArea(
      rect: bounds,
      options: [.activeAlways, .mouseEnteredAndExited, .inVisibleRect],
      owner: self,
      userInfo: nil
    )
    addTrackingArea(area)
    trackingArea = area
  }

  func applyTheme(_ next: LumenPalette) {
    palette = next
    applyVisualAppearance(animated: false)
  }

  /// Choreographed §19.1 reveal/hide:
  /// - Enter: opacity fades in after 145ms (100ms), scale enters after 85ms (240ms) from 0.80 → 1.0.
  /// - Leave: immediately fades out (100ms, delay 0ms) & scales down to 0.80 so header time can return +100ms later.
  func setRevealed(_ revealed: Bool, animated: Bool) {
    guard revealed != isRevealed else { return }
    isRevealed = revealed
    fadeWork?.cancel()
    scaleWork?.cancel()
    if !revealed {
      isButtonHovered = false
      isPressed = false
    }

    guard animated && LumenMotion.isEnabled else {
      alphaValue = revealed ? 1.0 : 0.0
      applyScaleAndGlyphTransform(animated: false)
      applyVisualAppearance(animated: false)
      return
    }

    if revealed {
      setCenteredScale(0.80, animated: false)
      let fWork = DispatchWorkItem { [weak self] in
        guard let self, self.isRevealed else { return }
        NSAnimationContext.runAnimationGroup { ctx in
          ctx.duration = LumenV15Tokens.orbitCloseFadeDuration
          self.animator().alphaValue = 1.0
        }
      }
      fadeWork = fWork
      DispatchQueue.main.asyncAfter(deadline: .now() + LumenV15Tokens.orbitCloseFadeDelay, execute: fWork)

      let sWork = DispatchWorkItem { [weak self] in
        guard let self, self.isRevealed else { return }
        self.applyScaleAndGlyphTransform(animated: true)
      }
      scaleWork = sWork
      DispatchQueue.main.asyncAfter(deadline: .now() + LumenV15Tokens.orbitCloseScaleDelay, execute: sWork)
    } else {
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = LumenV15Tokens.orbitCloseFadeDuration
        self.animator().alphaValue = 0.0
      }
      applyScaleAndGlyphTransform(animated: true)
      applyVisualAppearance(animated: true)
    }
  }

  override func mouseEntered(with event: NSEvent) {
    guard isRevealed else { return }
    isButtonHovered = true
    applyVisualAppearance(animated: true)
    applyScaleAndGlyphTransform(animated: true)
  }

  override func mouseExited(with event: NSEvent) {
    isButtonHovered = false
    isPressed = false
    applyVisualAppearance(animated: true)
    applyScaleAndGlyphTransform(animated: true)
  }

  override func mouseDown(with event: NSEvent) {
    guard isRevealed else { return }
    isPressed = true
    applyScaleAndGlyphTransform(animated: true)
  }

  override func mouseUp(with event: NSEvent) {
    guard isRevealed else { return }
    let wasPressed = isPressed
    isPressed = false
    let local = convert(event.locationInWindow, from: nil)
    applyScaleAndGlyphTransform(animated: true)
    if wasPressed && bounds.contains(local) {
      onRemove?()
    }
  }

  override func accessibilityPerformPress() -> Bool {
    guard isRevealed else { return false }
    onRemove?()
    return true
  }

  private func applyVisualAppearance(animated: Bool) {
    let isDark = palette.isDark
    let glyphColor: NSColor
    if isButtonHovered {
      glyphColor = isDark
        ? NSColor(srgbRed: 1.0, green: 0.878, blue: 0.902, alpha: 1.0) // #FFE0E6
        : NSColor(srgbRed: 0.651, green: 0.243, blue: 0.333, alpha: 1.0) // #A63E55
    } else {
      glyphColor = isDark
        ? NSColor(srgbRed: 0.851, green: 0.898, blue: 0.965, alpha: 1.0) // #D9E5F6
        : NSColor(srgbRed: 0.325, green: 0.392, blue: 0.482, alpha: 1.0) // #53647B
    }
    glyphView.image = LumenVectorGlyphs.actionImage(
      .orbitRemoveX,
      size: LumenV15Tokens.orbitCloseGlyphSize,
      color: glyphColor,
      strokeWidth: 1.9
    )

    CATransaction.begin()
    CATransaction.setDisableActions(!(animated && LumenMotion.isEnabled))
    CATransaction.setAnimationDuration(0.18)
    if isButtonHovered {
      if isDark {
        surfaceLayer.colors = [
          NSColor(srgbRed: 0.392, green: 0.267, blue: 0.329, alpha: 0.96).cgColor,
          NSColor(srgbRed: 0.392, green: 0.267, blue: 0.329, alpha: 0.96).cgColor
        ]
        surfaceLayer.borderColor = NSColor(srgbRed: 0.906, green: 0.651, blue: 0.710, alpha: 0.55).cgColor
      } else {
        surfaceLayer.colors = [
          NSColor(srgbRed: 1.0, green: 0.945, blue: 0.953, alpha: 0.98).cgColor,
          NSColor(srgbRed: 1.0, green: 0.945, blue: 0.953, alpha: 0.98).cgColor
        ]
        surfaceLayer.borderColor = NSColor.white.cgColor
        surfaceLayer.shadowColor = NSColor(srgbRed: 0.725, green: 0.412, blue: 0.506, alpha: 1.0).cgColor
        surfaceLayer.shadowRadius = 6
      }
    } else {
      if isDark {
        surfaceLayer.colors = [
          NSColor(srgbRed: 0.325, green: 0.388, blue: 0.482, alpha: 0.95).cgColor,
          NSColor(srgbRed: 0.224, green: 0.286, blue: 0.376, alpha: 0.95).cgColor
        ]
        surfaceLayer.borderColor = NSColor(srgbRed: 0.757, green: 0.831, blue: 0.937, alpha: 0.33).cgColor
        surfaceLayer.shadowColor = NSColor(srgbRed: 0.031, green: 0.059, blue: 0.145, alpha: 1.0).cgColor
        surfaceLayer.shadowRadius = 4
      } else {
        surfaceLayer.colors = [
          NSColor(srgbRed: 0.976, green: 0.984, blue: 1.0, alpha: 1.0).cgColor,
          NSColor(srgbRed: 0.894, green: 0.922, blue: 0.965, alpha: 0.94).cgColor
        ]
        surfaceLayer.borderColor = NSColor.white.withAlphaComponent(0.94).cgColor
        surfaceLayer.shadowColor = NSColor(srgbRed: 0.141, green: 0.231, blue: 0.361, alpha: 1.0).cgColor
        surfaceLayer.shadowRadius = 4
      }
    }
    CATransaction.commit()
  }

  private func applyScaleAndGlyphTransform(animated: Bool) {
    let targetScale: CGFloat
    if !isRevealed {
      targetScale = 0.80
    } else if isPressed {
      targetScale = 0.88
    } else if isButtonHovered {
      targetScale = 1.08
    } else {
      targetScale = 1.0
    }
    setCenteredScale(targetScale, animated: animated)

    // Rotate X 90° and tighten to 0.95 on button hover (§19.1)
    if let gl = glyphView.layer {
      let cx = glyphView.bounds.midX
      let cy = glyphView.bounds.midY
      var t = CATransform3DIdentity
      if isButtonHovered {
        t = CATransform3DTranslate(t, cx, cy, 0)
        t = CATransform3DRotate(t, .pi / 2, 0, 0, 1)
        t = CATransform3DScale(t, 0.95, 0.95, 1)
        t = CATransform3DTranslate(t, -cx, -cy, 0)
      }
      if animated && LumenMotion.isEnabled {
        let current = gl.presentation()?.transform ?? gl.transform
        let anim = CABasicAnimation(keyPath: "transform")
        anim.fromValue = NSValue(caTransform3D: current)
        anim.toValue = NSValue(caTransform3D: t)
        anim.duration = 0.28
        anim.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
        gl.transform = t
        gl.add(anim, forKey: "xRotate")
      } else {
        gl.removeAnimation(forKey: "xRotate")
        gl.transform = t
      }
    }
  }

  private func setCenteredScale(_ scale: CGFloat, animated: Bool) {
    guard let l = self.layer else { return }
    let cx = bounds.midX
    let cy = bounds.midY
    var t = CATransform3DIdentity
    if scale != 1.0 {
      t = CATransform3DTranslate(t, cx, cy, 0)
      t = CATransform3DScale(t, scale, scale, 1)
      t = CATransform3DTranslate(t, -cx, -cy, 0)
    }
    if animated && LumenMotion.isEnabled {
      let current = l.presentation()?.transform ?? l.transform
      let anim = CABasicAnimation(keyPath: "transform")
      anim.fromValue = NSValue(caTransform3D: current)
      anim.toValue = NSValue(caTransform3D: t)
      anim.duration = LumenV15Tokens.orbitCloseScaleDuration
      anim.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
      l.transform = t
      l.add(anim, forKey: "btnScale")
    } else {
      l.removeAnimation(forKey: "btnScale")
      l.transform = t
    }
  }
}

// MARK: - V15 Content-First Orbit Card (§18.2, §18.3, §19.1, A38, A48, A68, A69)

/// Individual V15 Orbit card slot with one shared lift coordinate system for both
/// the 16-corner card surface and the sibling 28×28 remove button.
final class LumenOrbitCardView: NSView {
  enum VisualState: Equatable {
    case idle
    case near
    case hovered
    case selected
  }

  let item: LumenClipboardItem
  let identity: LumenContentIdentity

  var quickKeyIndex: Int? {
    didSet { updateQuickKeyBadge() }
  }

  var visualState: VisualState = .idle {
    didSet {
      if visualState != oldValue {
        updateVisualState(animated: !suppressPropertyAnimation && LumenMotion.isEnabled)
      }
    }
  }

  var isKeyboardFocused: Bool = false {
    didSet {
      if isKeyboardFocused != oldValue {
        updateHeaderChoreography(animated: !suppressPropertyAnimation && LumenMotion.isEnabled)
      }
    }
  }

  /// Synchronized hover flag broadcast by `LumenOrbitDisplayCoordinator` across all mounted slices
  /// of a card straddling two physical displays so time-yield, X reveal, and lift stay lockstepped.
  var isCoordinatedHover: Bool = false {
    didSet {
      if isCoordinatedHover != oldValue {
        updateHeaderChoreography(animated: !suppressPropertyAnimation && LumenMotion.isEnabled)
      }
    }
  }

  private var suppressPropertyAnimation = false

  func syncCoordinatedState(visualState nextState: VisualState, keyboardFocused: Bool, coordinatedHover: Bool, animated: Bool) {
    let previousSuppress = suppressPropertyAnimation
    suppressPropertyAnimation = !animated
    visualState = nextState
    isKeyboardFocused = keyboardFocused
    isCoordinatedHover = coordinatedHover
    suppressPropertyAnimation = previousSuppress
  }

  var onSelectAndPaste: ((String) -> Void)?
  var onHoverFocus: ((String) -> Void)?
  var onHoverExit: ((String) -> Void)?
  var onRemoveRequested: ((String) -> Void)?
  var onContextMenuRequested: ((String, NSEvent) -> Void)?

  /// Clean card view without the floating remove button, used for texture-driven soft dissolution.
  var snapshotTargetView: NSView { cardSurface }

  private let liftContainer = NSView()
  private let cardSurface = NSView()
  private let cardLayer = CAGradientLayer()
  private let shineLayer = CAGradientLayer()

  // Header (34 DIP, type glyph + type label + tabular time)
  private let headerView = NSView()
  private let typeGlyphView = LumenIdentityGlyphView(size: 18)
  private let typeLabel = NSTextField(labelWithString: "")
  private let timeLabel = NSTextField(labelWithString: "")
  private var headerTrailingConstraint: NSLayoutConstraint?
  private var timeReturnWork: DispatchWorkItem?
  private var isTimeYielded = false

  // Sibling remove affordance in the same liftContainer
  private let removeButton = LumenOrbitRemoveButton()

  // Content-first body
  private let bodyHost = NSView()

  // Footer (source app icon + name + pin + quick key)
  private let footerView = NSView()
  private let sourceIconView = NSImageView()
  private let sourceFallbackBadge = NSView()
  private let sourceFallbackLetter = NSTextField(labelWithString: "")
  private let sourceLabel = NSTextField(labelWithString: "")
  private let pinIcon = NSImageView()
  private let keyBadge = NSTextField(labelWithString: "")

  private var trackingArea: NSTrackingArea?
  private(set) var isPointerInside = false
  private var currentLiftY: CGFloat = 0
  private var palette: LumenPalette = .light
  private var glowEnabled = true

  // Non-flipped wrapper guarantees +Y lift translation ALWAYS moves visually upward.
  override var isFlipped: Bool { false }

  init(item: LumenClipboardItem, keyIndex: Int?, palette: LumenPalette, glowEnabled: Bool) {
    self.item = item
    self.identity = item.contentIdentity
    self.quickKeyIndex = keyIndex
    self.palette = palette
    self.glowEnabled = glowEnabled
    super.init(frame: .zero)

    wantsLayer = true
    layer?.masksToBounds = false

    liftContainer.wantsLayer = true
    liftContainer.layer?.masksToBounds = false
    liftContainer.translatesAutoresizingMaskIntoConstraints = false

    cardSurface.wantsLayer = true
    cardSurface.layer?.cornerRadius = LumenV15Tokens.orbitCardCorner
    cardSurface.layer?.cornerCurve = .continuous
    cardSurface.layer?.masksToBounds = false
    cardSurface.layer?.shadowColor = NSColor(srgbRed: 0.04, green: 0.11, blue: 0.22, alpha: 1).cgColor
    cardSurface.layer?.shadowOpacity = 0.20
    cardSurface.layer?.shadowRadius = 11
    cardSurface.layer?.shadowOffset = NSSize(width: 0, height: -5)
    cardSurface.translatesAutoresizingMaskIntoConstraints = false

    cardLayer.cornerRadius = LumenV15Tokens.orbitCardCorner
    cardLayer.cornerCurve = .continuous
    cardLayer.masksToBounds = true
    cardLayer.startPoint = CGPoint(x: 0, y: 1)
    cardLayer.endPoint = CGPoint(x: 1, y: 0)
    cardSurface.layer?.addSublayer(cardLayer)

    shineLayer.cornerRadius = LumenV15Tokens.orbitCardCorner
    shineLayer.cornerCurve = .continuous
    shineLayer.startPoint = CGPoint(x: 0, y: 1)
    shineLayer.endPoint = CGPoint(x: 0.85, y: 0.2)
    shineLayer.colors = [
      NSColor.white.withAlphaComponent(0.28).cgColor,
      NSColor.clear.cgColor
    ]
    shineLayer.opacity = 0
    cardSurface.layer?.addSublayer(shineLayer)

    removeButton.translatesAutoresizingMaskIntoConstraints = false
    removeButton.configureAccessibility(itemTitle: item.displayTitle)
    removeButton.onRemove = { [weak self] in
      guard let self else { return }
      self.onRemoveRequested?(self.item.id)
    }

    addSubview(liftContainer)
    liftContainer.addSubview(cardSurface)
    liftContainer.addSubview(removeButton)

    NSLayoutConstraint.activate([
      liftContainer.topAnchor.constraint(equalTo: topAnchor),
      liftContainer.leadingAnchor.constraint(equalTo: leadingAnchor),
      liftContainer.trailingAnchor.constraint(equalTo: trailingAnchor),
      liftContainer.bottomAnchor.constraint(equalTo: bottomAnchor),

      cardSurface.topAnchor.constraint(equalTo: liftContainer.topAnchor),
      cardSurface.leadingAnchor.constraint(equalTo: liftContainer.leadingAnchor),
      cardSurface.trailingAnchor.constraint(equalTo: liftContainer.trailingAnchor),
      cardSurface.bottomAnchor.constraint(equalTo: liftContainer.bottomAnchor),

      // §19.1 exact anchor: 28×28 hit rect at top +4, right -7 relative to card border
      removeButton.topAnchor.constraint(equalTo: liftContainer.topAnchor, constant: LumenV15Tokens.orbitCloseAnchorTop),
      removeButton.trailingAnchor.constraint(equalTo: liftContainer.trailingAnchor, constant: -LumenV15Tokens.orbitCloseAnchorTrailing),
      removeButton.widthAnchor.constraint(equalToConstant: LumenV15Tokens.orbitCloseHitSize),
      removeButton.heightAnchor.constraint(equalToConstant: LumenV15Tokens.orbitCloseHitSize)
    ])

    buildCardContent()
    applyTheme(palette, glowEnabled: glowEnabled)
    updateQuickKeyBadge()
    updateVisualState(animated: false)
  }

  required init?(coder: NSCoder) { nil }

  deinit {
    timeReturnWork?.cancel()
  }

  override func layout() {
    super.layout()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    cardLayer.frame = cardSurface.bounds
    shineLayer.frame = cardSurface.bounds
    CATransaction.commit()
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let existing = trackingArea { removeTrackingArea(existing) }
    // Cover lifted upper area too so moving pointer to X never causes hover drop-out (§19.1)
    let hitBounds = bounds.insetBy(dx: -2, dy: -10)
    let area = NSTrackingArea(
      rect: hitBounds,
      options: [.activeAlways, .mouseEnteredAndExited, .inVisibleRect],
      owner: self,
      userInfo: nil
    )
    addTrackingArea(area)
    trackingArea = area
  }

  override func mouseEntered(with event: NSEvent) {
    isPointerInside = true
    updateHeaderChoreography(animated: true)
    onHoverFocus?(item.id)
  }

  override func mouseExited(with event: NSEvent) {
    isPointerInside = false
    updateHeaderChoreography(animated: true)
    onHoverExit?(item.id)
  }

  /// Strictly isolates X remove hit testing from card paste click (§3.4, §19.1, A38, A68).
  override func hitTest(_ point: NSPoint) -> NSView? {
    let local = convert(point, from: superview)
    // Account for liftContainer vertical translation (+currentLiftY in non-flipped coords)
    let liftedLocal = NSPoint(x: local.x, y: local.y - currentLiftY)
    guard bounds.contains(liftedLocal) else { return nil }
    if removeButton.isInteractive && removeButton.frame.contains(liftedLocal) {
      return removeButton
    }
    return self
  }

  override func mouseDown(with event: NSEvent) {
    if let rail = superview as? LumenOrbitRailViewportView {
      rail.beginRailDrag(with: event)
    } else {
      (enclosingScrollView as? LumenOrbitRailScrollView)?.beginRailDrag(with: event)
    }
  }

  override func mouseDragged(with event: NSEvent) {
    if let rail = superview as? LumenOrbitRailViewportView {
      rail.continueRailDrag(with: event)
    } else {
      (enclosingScrollView as? LumenOrbitRailScrollView)?.continueRailDrag(with: event)
    }
  }

  override func mouseUp(with event: NSEvent) {
    let wasDrag: Bool
    if let rail = superview as? LumenOrbitRailViewportView {
      wasDrag = rail.endRailDrag()
    } else {
      wasDrag = (enclosingScrollView as? LumenOrbitRailScrollView)?.endRailDrag() ?? false
    }
    if wasDrag { return }
    let pt = convert(event.locationInWindow, from: nil)
    let lifted = NSPoint(x: pt.x, y: pt.y - currentLiftY)
    if removeButton.isInteractive && removeButton.frame.contains(lifted) {
      return
    }
    if bounds.contains(lifted) {
      onSelectAndPaste?(item.id)
    }
  }

  override func rightMouseDown(with event: NSEvent) {
    onContextMenuRequested?(item.id, event)
  }

  // MARK: Card Content Construction

  private func buildCardContent() {
    headerView.translatesAutoresizingMaskIntoConstraints = false

    typeGlyphView.translatesAutoresizingMaskIntoConstraints = false

    typeLabel.stringValue = identity.displayName
    typeLabel.font = .systemFont(ofSize: 11, weight: .medium)
    typeLabel.lineBreakMode = .byTruncatingTail
    typeLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    typeLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
    typeLabel.translatesAutoresizingMaskIntoConstraints = false

    timeLabel.stringValue = item.relativeTime
    timeLabel.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
    timeLabel.alignment = .right
    timeLabel.lineBreakMode = .byClipping
    timeLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
    timeLabel.setContentHuggingPriority(.required, for: .horizontal)
    timeLabel.translatesAutoresizingMaskIntoConstraints = false

    headerView.addSubview(typeGlyphView)
    headerView.addSubview(typeLabel)
    headerView.addSubview(timeLabel)

    bodyHost.wantsLayer = true
    bodyHost.layer?.masksToBounds = true
    bodyHost.translatesAutoresizingMaskIntoConstraints = false

    footerView.translatesAutoresizingMaskIntoConstraints = false

    sourceIconView.imageScaling = .scaleProportionallyDown
    sourceIconView.translatesAutoresizingMaskIntoConstraints = false

    sourceFallbackBadge.wantsLayer = true
    sourceFallbackBadge.layer?.cornerRadius = 5
    sourceFallbackBadge.translatesAutoresizingMaskIntoConstraints = false
    sourceFallbackLetter.stringValue = String(item.sourceLabel.prefix(1)).uppercased()
    sourceFallbackLetter.font = .systemFont(ofSize: 9, weight: .bold)
    sourceFallbackLetter.textColor = .white
    sourceFallbackLetter.alignment = .center
    sourceFallbackLetter.translatesAutoresizingMaskIntoConstraints = false
    sourceFallbackBadge.addSubview(sourceFallbackLetter)

    if let appIcon = LumenSourceAppIconCache.shared.icon(forSourceApp: item.sourceLabel) {
      sourceIconView.image = appIcon
      sourceIconView.isHidden = false
      sourceFallbackBadge.isHidden = true
    } else {
      sourceIconView.isHidden = true
      sourceFallbackBadge.isHidden = false
    }

    sourceLabel.stringValue = item.sourceLabel
    sourceLabel.font = .systemFont(ofSize: 11, weight: .regular)
    sourceLabel.lineBreakMode = .byTruncatingTail
    sourceLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    sourceLabel.translatesAutoresizingMaskIntoConstraints = false

    pinIcon.isHidden = !item.pinned
    pinIcon.translatesAutoresizingMaskIntoConstraints = false

    keyBadge.font = .monospacedDigitSystemFont(ofSize: 10, weight: .medium)
    keyBadge.alignment = .right
    keyBadge.translatesAutoresizingMaskIntoConstraints = false

    footerView.addSubview(sourceIconView)
    footerView.addSubview(sourceFallbackBadge)
    footerView.addSubview(sourceLabel)
    footerView.addSubview(pinIcon)
    footerView.addSubview(keyBadge)

    cardSurface.addSubview(headerView)
    cardSurface.addSubview(bodyHost)
    cardSurface.addSubview(footerView)

    let timeTrail = timeLabel.trailingAnchor.constraint(
      equalTo: headerView.trailingAnchor,
      constant: -LumenV15Tokens.orbitHeaderInsetIdle
    )
    headerTrailingConstraint = timeTrail

    NSLayoutConstraint.activate([
      // §19.1 Header: 34 DIP, vertically centered
      headerView.topAnchor.constraint(equalTo: cardSurface.topAnchor, constant: 1),
      headerView.leadingAnchor.constraint(equalTo: cardSurface.leadingAnchor),
      headerView.trailingAnchor.constraint(equalTo: cardSurface.trailingAnchor),
      headerView.heightAnchor.constraint(equalToConstant: LumenV15Tokens.orbitHeaderHeight),

      typeGlyphView.leadingAnchor.constraint(equalTo: headerView.leadingAnchor, constant: LumenV15Tokens.orbitHeaderInsetIdle),
      typeGlyphView.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),
      typeGlyphView.widthAnchor.constraint(equalToConstant: 18),
      typeGlyphView.heightAnchor.constraint(equalToConstant: 18),

      typeLabel.leadingAnchor.constraint(equalTo: typeGlyphView.trailingAnchor, constant: 6),
      typeLabel.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),
      typeLabel.trailingAnchor.constraint(lessThanOrEqualTo: timeLabel.leadingAnchor, constant: -6),

      timeTrail,
      timeLabel.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),

      // Body (content-first)
      bodyHost.topAnchor.constraint(equalTo: headerView.bottomAnchor, constant: 2),
      bodyHost.leadingAnchor.constraint(equalTo: cardSurface.leadingAnchor, constant: 12),
      bodyHost.trailingAnchor.constraint(equalTo: cardSurface.trailingAnchor, constant: -12),
      bodyHost.bottomAnchor.constraint(equalTo: footerView.topAnchor, constant: -4),

      // Footer (30 DIP)
      footerView.leadingAnchor.constraint(equalTo: cardSurface.leadingAnchor),
      footerView.trailingAnchor.constraint(equalTo: cardSurface.trailingAnchor),
      footerView.bottomAnchor.constraint(equalTo: cardSurface.bottomAnchor, constant: -2),
      footerView.heightAnchor.constraint(equalToConstant: 30),

      sourceIconView.leadingAnchor.constraint(equalTo: footerView.leadingAnchor, constant: 12),
      sourceIconView.centerYAnchor.constraint(equalTo: footerView.centerYAnchor),
      sourceIconView.widthAnchor.constraint(equalToConstant: 16),
      sourceIconView.heightAnchor.constraint(equalToConstant: 16),

      sourceFallbackBadge.leadingAnchor.constraint(equalTo: footerView.leadingAnchor, constant: 12),
      sourceFallbackBadge.centerYAnchor.constraint(equalTo: footerView.centerYAnchor),
      sourceFallbackBadge.widthAnchor.constraint(equalToConstant: 16),
      sourceFallbackBadge.heightAnchor.constraint(equalToConstant: 16),
      sourceFallbackLetter.centerXAnchor.constraint(equalTo: sourceFallbackBadge.centerXAnchor),
      sourceFallbackLetter.centerYAnchor.constraint(equalTo: sourceFallbackBadge.centerYAnchor),

      sourceLabel.leadingAnchor.constraint(equalTo: sourceFallbackBadge.trailingAnchor, constant: 6),
      sourceLabel.centerYAnchor.constraint(equalTo: footerView.centerYAnchor),
      sourceLabel.trailingAnchor.constraint(lessThanOrEqualTo: pinIcon.leadingAnchor, constant: -6),

      keyBadge.trailingAnchor.constraint(equalTo: footerView.trailingAnchor, constant: -12),
      keyBadge.centerYAnchor.constraint(equalTo: footerView.centerYAnchor),

      pinIcon.trailingAnchor.constraint(equalTo: keyBadge.leadingAnchor, constant: -6),
      pinIcon.centerYAnchor.constraint(equalTo: footerView.centerYAnchor),
      pinIcon.widthAnchor.constraint(equalToConstant: 12),
      pinIcon.heightAnchor.constraint(equalToConstant: 12)
    ])

    populateBody()
  }

  private func populateBody() {
    bodyHost.subviews.forEach { $0.removeFromSuperview() }
    bodyHost.layer?.backgroundColor = NSColor.clear.cgColor
    bodyHost.layer?.cornerRadius = 0

    switch identity.family {
    case .color:
      let swatch = NSView()
      swatch.wantsLayer = true
      swatch.layer?.cornerRadius = 9
      swatch.layer?.cornerCurve = .continuous
      let parsed = LumenColorMath.parseAnyColor(item.effectiveText) ?? palette.accent
      swatch.layer?.backgroundColor = parsed.cgColor
      swatch.translatesAutoresizingMaskIntoConstraints = false

      let hexLbl = NSTextField(labelWithString: item.effectiveText.trimmingCharacters(in: .whitespacesAndNewlines).uppercased())
      hexLbl.font = .monospacedSystemFont(ofSize: 13.5, weight: .semibold)
      hexLbl.textColor = .white
      hexLbl.translatesAutoresizingMaskIntoConstraints = false

      let tagLbl = NSTextField(labelWithString: "HEX")
      tagLbl.font = .monospacedSystemFont(ofSize: 9, weight: .medium)
      tagLbl.textColor = NSColor.white.withAlphaComponent(0.82)
      tagLbl.translatesAutoresizingMaskIntoConstraints = false

      swatch.addSubview(hexLbl)
      swatch.addSubview(tagLbl)
      bodyHost.addSubview(swatch)

      NSLayoutConstraint.activate([
        swatch.topAnchor.constraint(equalTo: bodyHost.topAnchor, constant: 2),
        swatch.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        swatch.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        swatch.bottomAnchor.constraint(equalTo: bodyHost.bottomAnchor, constant: -2),
        hexLbl.leadingAnchor.constraint(equalTo: swatch.leadingAnchor, constant: 10),
        hexLbl.bottomAnchor.constraint(equalTo: swatch.bottomAnchor, constant: -9),
        tagLbl.trailingAnchor.constraint(equalTo: swatch.trailingAnchor, constant: -10),
        tagLbl.bottomAnchor.constraint(equalTo: swatch.bottomAnchor, constant: -10)
      ])

    case .image:
      let visual = NSView()
      visual.wantsLayer = true
      visual.layer?.cornerRadius = 9
      visual.layer?.cornerCurve = .continuous
      visual.layer?.masksToBounds = true
      visual.layer?.backgroundColor = palette.surfaceElevated.cgColor
      visual.translatesAutoresizingMaskIntoConstraints = false

      let iv = NSImageView()
      iv.imageScaling = .scaleProportionallyUpOrDown
      if let thumb = item.decodedThumbnailImage() {
        iv.image = thumb
      } else {
        iv.image = LumenVectorGlyphs.identityImage(for: identity, size: 36, isDark: palette.isDark)
        iv.imageScaling = .scaleNone
      }
      iv.translatesAutoresizingMaskIntoConstraints = false
      visual.addSubview(iv)

      let caption = makeBodyTitleLabel(item.displayTitle)
      bodyHost.addSubview(visual)
      bodyHost.addSubview(caption)

      NSLayoutConstraint.activate([
        visual.topAnchor.constraint(equalTo: bodyHost.topAnchor, constant: 2),
        visual.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        visual.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        visual.bottomAnchor.constraint(equalTo: caption.topAnchor, constant: -6),
        iv.topAnchor.constraint(equalTo: visual.topAnchor),
        iv.leadingAnchor.constraint(equalTo: visual.leadingAnchor),
        iv.trailingAnchor.constraint(equalTo: visual.trailingAnchor),
        iv.bottomAnchor.constraint(equalTo: visual.bottomAnchor),
        caption.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        caption.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        caption.bottomAnchor.constraint(equalTo: bodyHost.bottomAnchor, constant: -1)
      ])

    case .code:
      let title = makeBodyTitleLabel(item.displayTitle)
      let codeBox = NSView()
      codeBox.wantsLayer = true
      codeBox.layer?.cornerRadius = 8
      codeBox.layer?.cornerCurve = .continuous
      codeBox.layer?.masksToBounds = true
      codeBox.layer?.backgroundColor = palette.codeBackground.cgColor
      codeBox.translatesAutoresizingMaskIntoConstraints = false

      let snippet = item.effectiveText.split(separator: "\n", omittingEmptySubsequences: false).prefix(8).joined(separator: "\n")
      let codeLbl = NSTextField(wrappingLabelWithString: "")
      codeLbl.attributedStringValue = LumenSyntaxHighlighter.highlight(
        String(snippet.prefix(280)),
        language: identity.language ?? "unknown",
        fontSize: 10.5,
        darkCanvas: true,
        lineHeightMultiple: 1.5
      )
      codeLbl.translatesAutoresizingMaskIntoConstraints = false
      codeBox.addSubview(codeLbl)

      bodyHost.addSubview(title)
      bodyHost.addSubview(codeBox)

      NSLayoutConstraint.activate([
        title.topAnchor.constraint(equalTo: bodyHost.topAnchor, constant: 2),
        title.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        title.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        codeBox.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 5),
        codeBox.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        codeBox.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        codeBox.bottomAnchor.constraint(equalTo: bodyHost.bottomAnchor, constant: -1),
        codeLbl.topAnchor.constraint(equalTo: codeBox.topAnchor, constant: 8),
        codeLbl.leadingAnchor.constraint(equalTo: codeBox.leadingAnchor, constant: 8),
        codeLbl.trailingAnchor.constraint(equalTo: codeBox.trailingAnchor, constant: -8),
        codeLbl.bottomAnchor.constraint(lessThanOrEqualTo: codeBox.bottomAnchor, constant: -6)
      ])

    case .link:
      let raw = item.effectiveText.trimmingCharacters(in: .whitespacesAndNewlines)
      let parsedURL = URL(string: raw)
      let host = parsedURL?.host ?? raw
      let initialChar = String((host.replacingOccurrences(of: "www.", with: "")).prefix(1)).uppercased()

      let markLabel = NSTextField(labelWithString: initialChar.isEmpty ? "L" : initialChar)
      markLabel.font = .systemFont(ofSize: 24, weight: .bold)
      markLabel.textColor = identity.tintColor(isDark: palette.isDark)
      markLabel.translatesAutoresizingMaskIntoConstraints = false

      let extIcon = NSImageView(image: LumenVectorGlyphs.actionImage(.externalLink, size: 17, color: palette.muted.withAlphaComponent(0.7)))
      extIcon.translatesAutoresizingMaskIntoConstraints = false

      let markRow = NSStackView(views: [markLabel, extIcon])
      markRow.orientation = .horizontal
      markRow.alignment = .centerY
      markRow.spacing = 6
      markRow.translatesAutoresizingMaskIntoConstraints = false

      let titleLbl = makeBodyTitleLabel(item.displayTitle)
      titleLbl.maximumNumberOfLines = 2

      let hostLbl = NSTextField(labelWithString: host)
      hostLbl.font = .systemFont(ofSize: 10.5)
      hostLbl.textColor = palette.muted
      hostLbl.lineBreakMode = .byTruncatingMiddle
      hostLbl.translatesAutoresizingMaskIntoConstraints = false

      let pathLbl = NSTextField(wrappingLabelWithString: raw.replacingOccurrences(of: "^https?://", with: "", options: .regularExpression))
      pathLbl.font = .systemFont(ofSize: 11)
      pathLbl.textColor = palette.muted.withAlphaComponent(0.85)
      pathLbl.maximumNumberOfLines = 2
      pathLbl.lineBreakMode = .byTruncatingTail
      pathLbl.translatesAutoresizingMaskIntoConstraints = false

      let stack = NSStackView(views: [markRow, titleLbl, hostLbl, pathLbl])
      stack.orientation = .vertical
      stack.alignment = .leading
      stack.spacing = 4
      stack.translatesAutoresizingMaskIntoConstraints = false
      bodyHost.addSubview(stack)

      NSLayoutConstraint.activate([
        stack.topAnchor.constraint(equalTo: bodyHost.topAnchor, constant: 4),
        stack.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        stack.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        stack.bottomAnchor.constraint(lessThanOrEqualTo: bodyHost.bottomAnchor, constant: -2)
      ])

    case .audio, .video:
      let visual = NSView()
      visual.wantsLayer = true
      visual.layer?.cornerRadius = 9
      visual.layer?.cornerCurve = .continuous
      visual.layer?.masksToBounds = true
      visual.translatesAutoresizingMaskIntoConstraints = false

      let cover = LumenAlbumCoverView()
      cover.seedIndex = abs(item.id.hashValue) % 3
      cover.badgeText = identity.family == .audio ? "AUDIO" : "VIDEO"
      cover.translatesAutoresizingMaskIntoConstraints = false
      visual.addSubview(cover)

      var constraints: [NSLayoutConstraint] = [
        cover.topAnchor.constraint(equalTo: visual.topAnchor),
        cover.leadingAnchor.constraint(equalTo: visual.leadingAnchor),
        cover.trailingAnchor.constraint(equalTo: visual.trailingAnchor),
        cover.bottomAnchor.constraint(equalTo: visual.bottomAnchor)
      ]

      if identity.family == .video {
        let playBadge = NSView()
        playBadge.wantsLayer = true
        playBadge.layer?.cornerRadius = 15
        playBadge.layer?.backgroundColor = NSColor(srgbRed: 0.106, green: 0.176, blue: 0.294, alpha: 0.62).cgColor
        playBadge.translatesAutoresizingMaskIntoConstraints = false
        let playGlyph = NSImageView(image: LumenVectorGlyphs.identityImage(for: identity, size: 16, isDark: true, overrideColor: .white))
        playGlyph.translatesAutoresizingMaskIntoConstraints = false
        playBadge.addSubview(playGlyph)
        visual.addSubview(playBadge)
        constraints.append(contentsOf: [
          playBadge.centerXAnchor.constraint(equalTo: visual.centerXAnchor),
          playBadge.centerYAnchor.constraint(equalTo: visual.centerYAnchor),
          playBadge.widthAnchor.constraint(equalToConstant: 30),
          playBadge.heightAnchor.constraint(equalToConstant: 30),
          playGlyph.centerXAnchor.constraint(equalTo: playBadge.centerXAnchor),
          playGlyph.centerYAnchor.constraint(equalTo: playBadge.centerYAnchor)
        ])
      }

      let caption = makeBodyTitleLabel(item.displayTitle)
      bodyHost.addSubview(visual)
      bodyHost.addSubview(caption)

      constraints.append(contentsOf: [
        visual.topAnchor.constraint(equalTo: bodyHost.topAnchor, constant: 2),
        visual.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        visual.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        visual.bottomAnchor.constraint(equalTo: caption.topAnchor, constant: -6),
        caption.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        caption.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        caption.bottomAnchor.constraint(equalTo: bodyHost.bottomAnchor, constant: -1)
      ])
      NSLayoutConstraint.activate(constraints)

    case .collection where identity.subtype == "musicgroup":
      let visual = NSView()
      visual.wantsLayer = true
      visual.layer?.cornerRadius = 9
      visual.layer?.cornerCurve = .continuous
      visual.layer?.masksToBounds = true
      visual.layer?.backgroundColor = identity.tintColor(isDark: palette.isDark).withAlphaComponent(0.14).cgColor
      visual.translatesAutoresizingMaskIntoConstraints = false

      // Fanned 3-cover stack for audio collection (§7.1, §18.2)
      let coverCount = min(3, max(2, item.files.count))
      for i in 0..<coverCount {
        let mini = LumenAlbumCoverView()
        mini.seedIndex = (abs(item.id.hashValue) + i) % 3
        mini.badgeText = ""
        mini.layer?.cornerRadius = 7
        mini.translatesAutoresizingMaskIntoConstraints = false
        visual.addSubview(mini)
        let offsetX = CGFloat(i - 1) * 26
        let offsetY: CGFloat = (i == 1) ? -4 : 3
        NSLayoutConstraint.activate([
          mini.centerXAnchor.constraint(equalTo: visual.centerXAnchor, constant: offsetX),
          mini.centerYAnchor.constraint(equalTo: visual.centerYAnchor, constant: offsetY),
          mini.widthAnchor.constraint(equalToConstant: 62),
          mini.heightAnchor.constraint(equalToConstant: 62)
        ])
      }

      let caption = makeBodyTitleLabel(item.displayTitle)
      bodyHost.addSubview(visual)
      bodyHost.addSubview(caption)

      NSLayoutConstraint.activate([
        visual.topAnchor.constraint(equalTo: bodyHost.topAnchor, constant: 2),
        visual.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        visual.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        visual.bottomAnchor.constraint(equalTo: caption.topAnchor, constant: -6),
        caption.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        caption.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        caption.bottomAnchor.constraint(equalTo: bodyHost.bottomAnchor, constant: -1)
      ])

    case .document where identity.subtype == "pdf":
      let visual = NSView()
      visual.wantsLayer = true
      visual.layer?.cornerRadius = 9
      visual.layer?.cornerCurve = .continuous
      visual.layer?.masksToBounds = true
      visual.layer?.backgroundColor = (palette.isDark ? NSColor.white.withAlphaComponent(0.08) : NSColor(srgbRed: 0.765, green: 0.816, blue: 0.894, alpha: 0.28)).cgColor
      visual.translatesAutoresizingMaskIntoConstraints = false

      let iv = NSImageView()
      iv.imageScaling = .scaleProportionallyUpOrDown
      if let path = item.primaryFilePath, let doc = PDFDocument(url: URL(fileURLWithPath: path)), let page = doc.page(at: 0) {
        iv.image = page.thumbnail(of: NSSize(width: 140, height: 180), for: .cropBox)
      } else {
        iv.image = LumenVectorGlyphs.identityImage(for: identity, size: 42, isDark: palette.isDark)
        iv.imageScaling = .scaleNone
      }
      iv.translatesAutoresizingMaskIntoConstraints = false
      visual.addSubview(iv)

      let caption = makeBodyTitleLabel(item.displayTitle)
      bodyHost.addSubview(visual)
      bodyHost.addSubview(caption)

      NSLayoutConstraint.activate([
        visual.topAnchor.constraint(equalTo: bodyHost.topAnchor, constant: 2),
        visual.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        visual.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        visual.bottomAnchor.constraint(equalTo: caption.topAnchor, constant: -6),
        iv.topAnchor.constraint(equalTo: visual.topAnchor, constant: 5),
        iv.bottomAnchor.constraint(equalTo: visual.bottomAnchor, constant: -5),
        iv.centerXAnchor.constraint(equalTo: visual.centerXAnchor),
        iv.widthAnchor.constraint(lessThanOrEqualTo: visual.widthAnchor, constant: -12),
        caption.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        caption.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        caption.bottomAnchor.constraint(equalTo: bodyHost.bottomAnchor, constant: -1)
      ])

    case .document, .archive, .collection, .file:
      let visual = NSView()
      visual.wantsLayer = true
      visual.layer?.cornerRadius = 9
      visual.layer?.cornerCurve = .continuous
      visual.layer?.backgroundColor = identity.tintColor(isDark: palette.isDark).withAlphaComponent(palette.isDark ? 0.14 : 0.09).cgColor
      visual.translatesAutoresizingMaskIntoConstraints = false

      let glyph = LumenIdentityGlyphView(size: 42)
      glyph.configure(identity: identity, isDark: palette.isDark, size: 42)
      glyph.translatesAutoresizingMaskIntoConstraints = false

      let sizeLbl = NSTextField(labelWithString: item.formattedSize)
      sizeLbl.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
      sizeLbl.textColor = palette.muted
      sizeLbl.translatesAutoresizingMaskIntoConstraints = false

      let stack = NSStackView(views: [glyph, sizeLbl])
      stack.orientation = .vertical
      stack.alignment = .centerX
      stack.spacing = 6
      stack.translatesAutoresizingMaskIntoConstraints = false
      visual.addSubview(stack)

      let caption = makeBodyTitleLabel(item.displayTitle)
      bodyHost.addSubview(visual)
      bodyHost.addSubview(caption)

      NSLayoutConstraint.activate([
        visual.topAnchor.constraint(equalTo: bodyHost.topAnchor, constant: 2),
        visual.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        visual.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        visual.bottomAnchor.constraint(equalTo: caption.topAnchor, constant: -6),
        glyph.widthAnchor.constraint(equalToConstant: 42),
        glyph.heightAnchor.constraint(equalToConstant: 42),
        stack.centerXAnchor.constraint(equalTo: visual.centerXAnchor),
        stack.centerYAnchor.constraint(equalTo: visual.centerYAnchor),
        caption.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        caption.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        caption.bottomAnchor.constraint(equalTo: bodyHost.bottomAnchor, constant: -1)
      ])

    case .text:
      // Content-first text body: 13pt, line-height 1.56, no redundant title header (§18.3)
      let paragraph = NSMutableParagraphStyle()
      paragraph.lineHeightMultiple = 1.48
      paragraph.lineBreakMode = .byTruncatingTail
      let excerpt = NSTextField(wrappingLabelWithString: "")
      excerpt.attributedStringValue = NSAttributedString(
        string: String(item.effectiveText.prefix(280)),
        attributes: [
          .font: NSFont.systemFont(ofSize: 13, weight: .regular),
          .foregroundColor: palette.isDark ? NSColor(srgbRed: 0.90, green: 0.94, blue: 1.0, alpha: 0.95) : NSColor(srgbRed: 0.125, green: 0.196, blue: 0.294, alpha: 1.0),
          .paragraphStyle: paragraph
        ]
      )
      excerpt.maximumNumberOfLines = 6
      excerpt.translatesAutoresizingMaskIntoConstraints = false
      bodyHost.addSubview(excerpt)
      NSLayoutConstraint.activate([
        excerpt.topAnchor.constraint(equalTo: bodyHost.topAnchor, constant: 4),
        excerpt.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        excerpt.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        excerpt.bottomAnchor.constraint(lessThanOrEqualTo: bodyHost.bottomAnchor, constant: -2)
      ])
    }
  }

  private func makeBodyTitleLabel(_ text: String) -> NSTextField {
    let lbl = NSTextField(labelWithString: text)
    lbl.font = .systemFont(ofSize: 12.5, weight: .semibold)
    lbl.textColor = palette.ink
    lbl.lineBreakMode = .byTruncatingTail
    lbl.translatesAutoresizingMaskIntoConstraints = false
    return lbl
  }

  func applyTheme(_ next: LumenPalette, glowEnabled nextGlow: Bool) {
    palette = next
    glowEnabled = nextGlow
    cardLayer.colors = [next.orbitCardTop.cgColor, next.orbitCardBottom.cgColor]
    typeGlyphView.configure(identity: identity, isDark: next.isDark, size: 18)

    let metaInk = next.isDark
      ? NSColor(srgbRed: 0.706, green: 0.776, blue: 0.867, alpha: 1.0) // #B4C6DD
      : NSColor(srgbRed: 0.322, green: 0.412, blue: 0.518, alpha: 1.0) // #526984
    typeLabel.textColor = metaInk
    timeLabel.textColor = next.isDark ? metaInk : NSColor(srgbRed: 0.369, green: 0.443, blue: 0.541, alpha: 1.0)
    sourceFallbackBadge.layer?.backgroundColor = next.sourceBadgeColor(for: item.sourceLabel).cgColor
    sourceLabel.textColor = metaInk
    pinIcon.image = LumenVectorGlyphs.actionImage(.pinFilled, size: 12, color: next.accent)
    keyBadge.textColor = metaInk.withAlphaComponent(0.78)
    removeButton.applyTheme(next)

    populateBody()
    updateVisualState(animated: false)
  }

  private func updateQuickKeyBadge() {
    if let idx = quickKeyIndex, idx >= 0, idx < 9 {
      keyBadge.isHidden = false
      keyBadge.stringValue = "\(idx + 1)"
    } else {
      keyBadge.stringValue = ""
      keyBadge.isHidden = true
    }
  }

  /// §19.1 Header Choreography:
  /// - Enter: time yields 12 → 43 DIP (210ms, delay 0ms), remove X fades in after 145ms.
  /// - Leave: remove X exits immediately (delay 0ms), time returns 43 → 12 DIP after 100ms delay.
  /// - Time label NEVER changes opacity or truncates.
  private func updateHeaderChoreography(animated: Bool) {
    let shouldYield = isPointerInside || isCoordinatedHover || isKeyboardFocused
    guard shouldYield != isTimeYielded else { return }
    isTimeYielded = shouldYield
    timeReturnWork?.cancel()

    if shouldYield {
      animateHeaderTrailing(to: -LumenV15Tokens.orbitHeaderInsetHover, animated: animated)
      removeButton.setRevealed(true, animated: animated)
    } else {
      removeButton.setRevealed(false, animated: animated)
      if animated && LumenMotion.isEnabled {
        let work = DispatchWorkItem { [weak self] in
          guard let self, !self.isTimeYielded else { return }
          self.animateHeaderTrailing(to: -LumenV15Tokens.orbitHeaderInsetIdle, animated: true)
        }
        timeReturnWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + LumenV15Tokens.orbitTimeReturnDelay, execute: work)
      } else {
        animateHeaderTrailing(to: -LumenV15Tokens.orbitHeaderInsetIdle, animated: false)
      }
    }
  }

  private func animateHeaderTrailing(to constant: CGFloat, animated: Bool) {
    guard let constraint = headerTrailingConstraint else { return }
    if animated && LumenMotion.isEnabled {
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = LumenV15Tokens.orbitTimeYieldDuration
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 0.8, 0.22, 1.0)
        ctx.allowsImplicitAnimation = true
        constraint.animator().constant = constant
      }
    } else {
      constraint.constant = constant
    }
  }

  /// Unified §19.1 lift curve (320ms, cubic-bezier(.2,.9,.25,1.2)) shared by card & X button.
  private func updateVisualState(animated: Bool) {
    let isSelected = visualState == .selected
    let targetLiftY: CGFloat
    switch visualState {
    case .selected: targetLiftY = LumenV15Tokens.orbitLiftSelected
    case .hovered: targetLiftY = LumenV15Tokens.orbitLiftHover
    case .near: targetLiftY = LumenV15Tokens.orbitLiftNear
    case .idle: targetLiftY = LumenV15Tokens.orbitLiftIdle
    }
    currentLiftY = targetLiftY

    cardLayer.borderWidth = isSelected ? 1.5 : 1.0
    cardLayer.borderColor = (isSelected ? palette.orbitCardSelectedBorder : palette.orbitCardBorder).cgColor
    shineLayer.opacity = (glowEnabled && (isSelected || visualState == .hovered)) ? 0.60 : 0.0

    if let surfaceLayer = cardSurface.layer {
      surfaceLayer.shadowColor = (isSelected && glowEnabled
        ? palette.orbitCardSelectedGlow
        : NSColor(srgbRed: 0.04, green: 0.11, blue: 0.22, alpha: 1)).cgColor
      surfaceLayer.shadowOpacity = isSelected ? (glowEnabled ? 0.62 : 0.32) : 0.20
      surfaceLayer.shadowRadius = isSelected ? 18 : 11
    }

    if let outer = self.layer {
      outer.zPosition = isSelected ? 4 : (visualState == .hovered ? 2 : 0)
    }

    if let liftLayer = liftContainer.layer {
      let targetTransform = CATransform3DMakeTranslation(0, targetLiftY, 0)
      if animated && LumenMotion.isEnabled {
        let currentTransform = liftLayer.presentation()?.transform ?? liftLayer.transform
        let anim = CABasicAnimation(keyPath: "transform")
        anim.fromValue = NSValue(caTransform3D: currentTransform)
        anim.toValue = NSValue(caTransform3D: targetTransform)
        anim.duration = LumenV15Tokens.orbitLiftDuration
        anim.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.25, 1.2)
        liftLayer.removeAnimation(forKey: "orbitLift")
        liftLayer.transform = targetTransform
        liftLayer.add(anim, forKey: "orbitLift")
      } else {
        liftLayer.removeAnimation(forKey: "orbitLift")
        liftLayer.transform = targetTransform
      }
    }
  }
}
