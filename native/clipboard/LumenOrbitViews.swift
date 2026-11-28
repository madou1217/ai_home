import AppKit
import CoreGraphics
import Foundation
import PDFKit
import QuartzCore

/// Non-activating borderless floating NSPanel dedicated to the Orbit screen-edge rail.
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

    // Base translucent spectral wash
    if let bg = CGGradient(
      colorsSpace: space,
      colors: [palette.orbitBackdropTop.cgColor, palette.orbitBackdropBottom.cgColor] as CFArray,
      locations: [0, 1]
    ) {
      ctx.drawLinearGradient(bg, start: CGPoint(x: 0, y: bounds.maxY), end: CGPoint(x: 0, y: 0), options: [])
    }

    // Pointer-following luminous radial sheen
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

    // Reflective 1.5pt glass edge line along the exposed screen-edge boundary
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

/// Horizontal/vertical wheel-friendly smooth rail scroll view (supports vertical mouse-wheel -> horizontal scroll + drag pan).
final class LumenOrbitRailScrollView: NSScrollView {
  var isHorizontalRail = true
  private var dragOriginWindow: NSPoint?
  private var dragStartClipOrigin: NSPoint = .zero
  private(set) var didDragPan = false

  override func scrollWheel(with event: NSEvent) {
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
  }

  func scrollHorizontalClamped(to rawX: CGFloat) {
    guard let doc = documentView else { return }
    let maxX = max(0, doc.frame.width - contentView.bounds.width)
    let clamped = max(0, min(maxX, rawX))
    contentView.scroll(to: NSPoint(x: clamped, y: contentView.bounds.origin.y))
    reflectScrolledClipView(contentView)
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
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = 0.24
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.85, 0.25, 1)
        self.contentView.animator().setBoundsOrigin(target)
      }
      reflectScrolledClipView(contentView)
    } else {
      contentView.scroll(to: target)
      reflectScrolledClipView(contentView)
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

/// Individual clipboard card inside the Orbit rail with hover/focus elevation,
/// quick-paste numeric key badge (1-9), and circular top-right removal button.
final class LumenOrbitCardView: NSView {
  enum VisualState: Equatable {
    case idle
    case near
    case hovered
    case selected
  }

  let item: LumenClipboardItem
  var quickKeyIndex: Int? {
    didSet { updateQuickKeyBadge() }
  }
  var visualState: VisualState = .idle {
    didSet {
      if visualState != oldValue {
        updateVisualState(animated: LumenMotion.isEnabled)
      }
    }
  }

  var onSelectAndPaste: ((String) -> Void)?
  var onHoverFocus: ((String) -> Void)?
  var onRemoveRequested: ((String) -> Void)?
  var onContextMenuRequested: ((String, NSEvent) -> Void)?

  private let cardLayer = CAGradientLayer()
  private let shineLayer = CAGradientLayer()
  private let sourceBadge = NSView()
  private let sourceIcon = NSImageView()
  private let sourceLabel = NSTextField(labelWithString: "")
  private let timeLabel = NSTextField(labelWithString: "")
  private let removeButton = NSButton()
  private let titleLabel = NSTextField(labelWithString: "")
  private let bodyHost = NSView()
  private let footIcon = NSImageView()
  private let footLabel = NSTextField(labelWithString: "")
  private let pinIcon = NSImageView()
  private let keyBadge = NSTextField(labelWithString: "")

  private var trackingArea: NSTrackingArea?
  private var isPointerInside = false
  private var palette: LumenPalette = .light
  private var glowEnabled = true

  init(item: LumenClipboardItem, keyIndex: Int?, palette: LumenPalette, glowEnabled: Bool) {
    self.item = item
    self.quickKeyIndex = keyIndex
    self.palette = palette
    self.glowEnabled = glowEnabled
    super.init(frame: .zero)
    wantsLayer = true
    layer?.cornerRadius = 18
    layer?.cornerCurve = .continuous
    layer?.masksToBounds = false
    layer?.shadowColor = NSColor(srgbRed: 0.04, green: 0.11, blue: 0.22, alpha: 1).cgColor
    layer?.shadowOpacity = 0.22
    layer?.shadowRadius = 12
    layer?.shadowOffset = NSSize(width: 0, height: -5)

    cardLayer.cornerRadius = 18
    cardLayer.cornerCurve = .continuous
    cardLayer.masksToBounds = true
    cardLayer.startPoint = CGPoint(x: 0, y: 1)
    cardLayer.endPoint = CGPoint(x: 1, y: 0)
    layer?.addSublayer(cardLayer)

    shineLayer.cornerRadius = 18
    shineLayer.cornerCurve = .continuous
    shineLayer.startPoint = CGPoint(x: 0, y: 1)
    shineLayer.endPoint = CGPoint(x: 0.85, y: 0.2)
    shineLayer.colors = [
      NSColor.white.withAlphaComponent(0.28).cgColor,
      NSColor.clear.cgColor
    ]
    shineLayer.opacity = 0
    layer?.addSublayer(shineLayer)

    buildContent()
    applyTheme(palette, glowEnabled: glowEnabled)
    updateQuickKeyBadge()
    updateVisualState(animated: false)
  }

  required init?(coder: NSCoder) { nil }

  override func layout() {
    super.layout()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    cardLayer.frame = bounds
    shineLayer.frame = bounds
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

  override func mouseEntered(with event: NSEvent) {
    isPointerInside = true
    updateRemoveButtonVisibility(animated: true)
    onHoverFocus?(item.id)
  }

  override func mouseExited(with event: NSEvent) {
    isPointerInside = false
    updateRemoveButtonVisibility(animated: true)
  }

  override func hitTest(_ point: NSPoint) -> NSView? {
    let local = convert(point, from: superview)
    guard bounds.contains(local) else { return nil }
    if !removeButton.isHidden && removeButton.frame.insetBy(dx: -4, dy: -4).contains(local) {
      return removeButton
    }
    return self
  }

  override func mouseDown(with event: NSEvent) {
    (enclosingScrollView as? LumenOrbitRailScrollView)?.beginRailDrag(with: event)
  }

  override func mouseDragged(with event: NSEvent) {
    (enclosingScrollView as? LumenOrbitRailScrollView)?.continueRailDrag(with: event)
  }

  override func mouseUp(with event: NSEvent) {
    let wasDrag = (enclosingScrollView as? LumenOrbitRailScrollView)?.endRailDrag() ?? false
    if wasDrag { return }
    let pt = convert(event.locationInWindow, from: nil)
    if !removeButton.isHidden && removeButton.frame.insetBy(dx: -4, dy: -4).contains(pt) {
      return
    }
    if bounds.contains(pt) {
      onSelectAndPaste?(item.id)
    }
  }

  override func rightMouseDown(with event: NSEvent) {
    onContextMenuRequested?(item.id, event)
  }

  private func buildContent() {
    let cat = item.displayCategory

    sourceBadge.wantsLayer = true
    sourceBadge.layer?.cornerRadius = 7
    sourceBadge.translatesAutoresizingMaskIntoConstraints = false
    sourceIcon.image = LumenIcons.symbol(cat.symbolName, size: 11, weight: .semibold)
    sourceIcon.contentTintColor = .white
    sourceIcon.translatesAutoresizingMaskIntoConstraints = false
    sourceBadge.addSubview(sourceIcon)

    sourceLabel.stringValue = item.sourceLabel
    sourceLabel.font = .systemFont(ofSize: 10.5, weight: .medium)
    sourceLabel.lineBreakMode = .byTruncatingTail
    sourceLabel.translatesAutoresizingMaskIntoConstraints = false

    timeLabel.stringValue = item.relativeTime
    timeLabel.font = .monospacedDigitSystemFont(ofSize: 10, weight: .regular)
    timeLabel.alignment = .right
    timeLabel.translatesAutoresizingMaskIntoConstraints = false

    removeButton.isBordered = false
    removeButton.wantsLayer = true
    removeButton.image = LumenIcons.symbol("xmark", size: 10.5, weight: .bold, description: "移除记录")
    removeButton.toolTip = "移除记录 (Delete)"
    removeButton.target = self
    removeButton.action = #selector(removeButtonClicked)
    removeButton.layer?.cornerRadius = 12
    removeButton.layer?.borderWidth = 1
    removeButton.alphaValue = 0
    removeButton.isHidden = true
    removeButton.translatesAutoresizingMaskIntoConstraints = false

    titleLabel.stringValue = item.displayTitle
    titleLabel.font = .systemFont(ofSize: 13.5, weight: .semibold)
    titleLabel.lineBreakMode = .byTruncatingTail
    titleLabel.translatesAutoresizingMaskIntoConstraints = false

    bodyHost.wantsLayer = true
    bodyHost.layer?.cornerRadius = 10
    bodyHost.layer?.masksToBounds = true
    bodyHost.translatesAutoresizingMaskIntoConstraints = false

    footIcon.image = LumenIcons.symbol(cat.symbolName, size: 11, weight: .medium)
    footIcon.translatesAutoresizingMaskIntoConstraints = false

    footLabel.stringValue = cat.label
    footLabel.font = .systemFont(ofSize: 10.5, weight: .medium)
    footLabel.translatesAutoresizingMaskIntoConstraints = false

    pinIcon.image = LumenIcons.symbol("pin.fill", size: 11)
    pinIcon.isHidden = !item.pinned
    pinIcon.translatesAutoresizingMaskIntoConstraints = false

    keyBadge.font = .monospacedDigitSystemFont(ofSize: 10, weight: .semibold)
    keyBadge.alignment = .center
    keyBadge.wantsLayer = true
    keyBadge.layer?.cornerRadius = 5
    keyBadge.translatesAutoresizingMaskIntoConstraints = false

    for v in [sourceBadge, sourceLabel, timeLabel, removeButton, titleLabel, bodyHost, footIcon, footLabel, pinIcon, keyBadge] {
      addSubview(v)
    }

    NSLayoutConstraint.activate([
      sourceBadge.topAnchor.constraint(equalTo: topAnchor, constant: 11),
      sourceBadge.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
      sourceBadge.widthAnchor.constraint(equalToConstant: 22),
      sourceBadge.heightAnchor.constraint(equalToConstant: 22),
      sourceIcon.centerXAnchor.constraint(equalTo: sourceBadge.centerXAnchor),
      sourceIcon.centerYAnchor.constraint(equalTo: sourceBadge.centerYAnchor),

      sourceLabel.leadingAnchor.constraint(equalTo: sourceBadge.trailingAnchor, constant: 7),
      sourceLabel.centerYAnchor.constraint(equalTo: sourceBadge.centerYAnchor),
      sourceLabel.trailingAnchor.constraint(lessThanOrEqualTo: timeLabel.leadingAnchor, constant: -6),

      timeLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      timeLabel.centerYAnchor.constraint(equalTo: sourceBadge.centerYAnchor),

      removeButton.topAnchor.constraint(equalTo: topAnchor, constant: 8),
      removeButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
      removeButton.widthAnchor.constraint(equalToConstant: 24),
      removeButton.heightAnchor.constraint(equalToConstant: 24),

      titleLabel.topAnchor.constraint(equalTo: sourceBadge.bottomAnchor, constant: 8),
      titleLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
      titleLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),

      bodyHost.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 6),
      bodyHost.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
      bodyHost.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      bodyHost.bottomAnchor.constraint(equalTo: footLabel.topAnchor, constant: -9),

      footIcon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
      footIcon.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -11),
      footIcon.widthAnchor.constraint(equalToConstant: 12),
      footIcon.heightAnchor.constraint(equalToConstant: 12),

      footLabel.leadingAnchor.constraint(equalTo: footIcon.trailingAnchor, constant: 5),
      footLabel.centerYAnchor.constraint(equalTo: footIcon.centerYAnchor),

      keyBadge.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -11),
      keyBadge.centerYAnchor.constraint(equalTo: footIcon.centerYAnchor),
      keyBadge.widthAnchor.constraint(equalToConstant: 20),
      keyBadge.heightAnchor.constraint(equalToConstant: 19),

      pinIcon.trailingAnchor.constraint(equalTo: keyBadge.leadingAnchor, constant: -6),
      pinIcon.centerYAnchor.constraint(equalTo: footIcon.centerYAnchor),
      pinIcon.widthAnchor.constraint(equalToConstant: 12),
      pinIcon.heightAnchor.constraint(equalToConstant: 12)
    ])

    populateBody()
  }

  private func populateBody() {
    bodyHost.subviews.forEach { $0.removeFromSuperview() }
    let kind = LumenPreviewItem.classify(item: item)
    switch kind {
    case .color:
      if let swatch = LumenClassifier.parseHexColor(item.effectiveText) {
        bodyHost.layer?.backgroundColor = swatch.cgColor
        let hex = NSTextField(labelWithString: item.effectiveText.trimmingCharacters(in: .whitespacesAndNewlines).uppercased())
        hex.font = .monospacedSystemFont(ofSize: 12, weight: .semibold)
        hex.textColor = .white
        hex.translatesAutoresizingMaskIntoConstraints = false
        bodyHost.addSubview(hex)
        NSLayoutConstraint.activate([
          hex.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor, constant: 10),
          hex.bottomAnchor.constraint(equalTo: bodyHost.bottomAnchor, constant: -8)
        ])
      }
    case .image:
      bodyHost.layer?.backgroundColor = palette.surfaceElevated.cgColor
      let iv = NSImageView(image: item.decodedThumbnailImage() ?? LumenIcons.symbol("photo", size: 28))
      iv.imageScaling = .scaleProportionallyUpOrDown
      iv.translatesAutoresizingMaskIntoConstraints = false
      bodyHost.addSubview(iv)
      NSLayoutConstraint.activate([
        iv.topAnchor.constraint(equalTo: bodyHost.topAnchor),
        iv.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        iv.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        iv.bottomAnchor.constraint(equalTo: bodyHost.bottomAnchor)
      ])
    case .code(let lang):
      bodyHost.layer?.backgroundColor = palette.codeBackground.cgColor
      let lbl = NSTextField(wrappingLabelWithString: "")
      lbl.attributedStringValue = LumenSyntaxHighlighter.highlight(String(item.effectiveText.prefix(260)), language: lang, fontSize: 10, darkCanvas: true)
      lbl.translatesAutoresizingMaskIntoConstraints = false
      bodyHost.addSubview(lbl)
      NSLayoutConstraint.activate([
        lbl.topAnchor.constraint(equalTo: bodyHost.topAnchor, constant: 7),
        lbl.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor, constant: 8),
        lbl.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor, constant: -8),
        lbl.bottomAnchor.constraint(lessThanOrEqualTo: bodyHost.bottomAnchor, constant: -6)
      ])
    case .audio, .video:
      let cover = LumenAlbumCoverView()
      cover.seedIndex = abs(item.id.hashValue) % 3
      cover.badgeText = kind == .audio ? "AUDIO" : "VIDEO"
      cover.translatesAutoresizingMaskIntoConstraints = false
      bodyHost.addSubview(cover)
      NSLayoutConstraint.activate([
        cover.topAnchor.constraint(equalTo: bodyHost.topAnchor),
        cover.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        cover.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        cover.bottomAnchor.constraint(equalTo: bodyHost.bottomAnchor)
      ])
    case .pdf:
      bodyHost.layer?.backgroundColor = palette.surfaceElevated.withAlphaComponent(0.65).cgColor
      let iv = NSImageView()
      iv.imageScaling = .scaleProportionallyUpOrDown
      if let path = item.primaryFilePath, let doc = PDFDocument(url: URL(fileURLWithPath: path)), let page = doc.page(at: 0) {
        iv.image = page.thumbnail(of: NSSize(width: 140, height: 180), for: .cropBox)
      } else {
        iv.image = LumenIcons.symbol("doc.richtext", size: 30)
        iv.contentTintColor = palette.accent
      }
      iv.translatesAutoresizingMaskIntoConstraints = false
      bodyHost.addSubview(iv)
      NSLayoutConstraint.activate([
        iv.topAnchor.constraint(equalTo: bodyHost.topAnchor, constant: 4),
        iv.bottomAnchor.constraint(equalTo: bodyHost.bottomAnchor, constant: -4),
        iv.centerXAnchor.constraint(equalTo: bodyHost.centerXAnchor),
        iv.widthAnchor.constraint(lessThanOrEqualTo: bodyHost.widthAnchor, constant: -8)
      ])
    case .file, .collection, .office:
      bodyHost.layer?.backgroundColor = (palette.isDark ? NSColor.white.withAlphaComponent(0.08) : NSColor.white.withAlphaComponent(0.55)).cgColor
      let icon = NSImageView(image: item.primaryFilePath.flatMap { FileManager.default.fileExists(atPath: $0) ? NSWorkspace.shared.icon(forFile: $0) : nil } ?? LumenIcons.symbol("doc.fill", size: 26))
      icon.translatesAutoresizingMaskIntoConstraints = false
      let name = NSTextField(labelWithString: item.displayTitle)
      name.font = .systemFont(ofSize: 11.5, weight: .semibold)
      name.textColor = palette.ink
      name.lineBreakMode = .byTruncatingMiddle
      let size = NSTextField(labelWithString: "\(kind.displayLabel) · \(item.formattedSize)")
      size.font = .systemFont(ofSize: 10)
      size.textColor = palette.muted
      let textStack = NSStackView(views: [name, size])
      textStack.orientation = .vertical
      textStack.alignment = .leading
      textStack.spacing = 2
      let row = NSStackView(views: [icon, textStack])
      row.orientation = .horizontal
      row.alignment = .centerY
      row.spacing = 8
      row.translatesAutoresizingMaskIntoConstraints = false
      bodyHost.addSubview(row)
      NSLayoutConstraint.activate([
        icon.widthAnchor.constraint(equalToConstant: 34),
        icon.heightAnchor.constraint(equalToConstant: 34),
        row.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor, constant: 10),
        row.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor, constant: -10),
        row.centerYAnchor.constraint(equalTo: bodyHost.centerYAnchor)
      ])
    case .link:
      bodyHost.layer?.backgroundColor = (palette.isDark ? NSColor.white.withAlphaComponent(0.08) : NSColor.white.withAlphaComponent(0.55)).cgColor
      let icon = NSImageView(image: LumenIcons.symbol("link", size: 18, weight: .medium))
      icon.contentTintColor = palette.categoryTint(.link)
      let urlLabel = NSTextField(wrappingLabelWithString: item.effectiveText.replacingOccurrences(of: "^https?://", with: "", options: .regularExpression))
      urlLabel.font = .systemFont(ofSize: 11)
      urlLabel.textColor = palette.muted
      urlLabel.maximumNumberOfLines = 3
      urlLabel.lineBreakMode = .byTruncatingTail
      let st = NSStackView(views: [icon, urlLabel])
      st.orientation = .vertical
      st.alignment = .leading
      st.spacing = 6
      st.translatesAutoresizingMaskIntoConstraints = false
      bodyHost.addSubview(st)
      NSLayoutConstraint.activate([
        st.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor, constant: 10),
        st.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor, constant: -10),
        st.centerYAnchor.constraint(equalTo: bodyHost.centerYAnchor)
      ])
    default:
      let excerpt = NSTextField(wrappingLabelWithString: String(item.effectiveText.prefix(240)))
      excerpt.font = .systemFont(ofSize: 11.5)
      excerpt.textColor = palette.isDark ? NSColor(srgbRed: 0.78, green: 0.84, blue: 0.92, alpha: 1) : NSColor(srgbRed: 0.30, green: 0.36, blue: 0.46, alpha: 1)
      excerpt.maximumNumberOfLines = 5
      excerpt.lineBreakMode = .byTruncatingTail
      excerpt.translatesAutoresizingMaskIntoConstraints = false
      bodyHost.addSubview(excerpt)
      NSLayoutConstraint.activate([
        excerpt.topAnchor.constraint(equalTo: bodyHost.topAnchor, constant: 2),
        excerpt.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        excerpt.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        excerpt.bottomAnchor.constraint(lessThanOrEqualTo: bodyHost.bottomAnchor)
      ])
    }
  }

  func applyTheme(_ next: LumenPalette, glowEnabled nextGlow: Bool) {
    palette = next
    glowEnabled = nextGlow
    cardLayer.colors = [next.orbitCardTop.cgColor, next.orbitCardBottom.cgColor]
    sourceBadge.layer?.backgroundColor = next.sourceBadgeColor(for: item.sourceLabel).cgColor
    sourceLabel.textColor = next.muted
    timeLabel.textColor = next.muted
    titleLabel.textColor = next.ink
    footIcon.contentTintColor = next.muted
    footLabel.textColor = next.muted
    pinIcon.contentTintColor = next.accent

    removeButton.layer?.backgroundColor = (next.isDark
      ? NSColor(srgbRed: 0.19, green: 0.28, blue: 0.40, alpha: 0.95)
      : NSColor(srgbRed: 0.93, green: 0.96, blue: 1.0, alpha: 0.95)).cgColor
    removeButton.layer?.borderColor = (next.isDark
      ? NSColor(srgbRed: 0.71, green: 0.85, blue: 1.0, alpha: 0.55)
      : NSColor.white).cgColor
    removeButton.contentTintColor = next.isDark ? .white : NSColor(srgbRed: 0.33, green: 0.40, blue: 0.50, alpha: 1)

    updateVisualState(animated: false)
  }

  private func updateQuickKeyBadge() {
    if let idx = quickKeyIndex, idx >= 0, idx < 9 {
      keyBadge.isHidden = false
      keyBadge.stringValue = "\(idx + 1)"
    } else {
      keyBadge.isHidden = true
    }
  }

  private func updateRemoveButtonVisibility(animated: Bool) {
    let show = isPointerInside || visualState == .selected
    if show { removeButton.isHidden = false }
    NSAnimationContext.runAnimationGroup({ ctx in
      ctx.duration = (animated && LumenMotion.isEnabled) ? 0.16 : 0.01
      self.removeButton.animator().alphaValue = show ? 1 : 0
      self.timeLabel.animator().alphaValue = show ? 0 : 1
    }, completionHandler: { [weak self] in
      guard let self else { return }
      if !show { self.removeButton.isHidden = true }
    })
  }

  private func updateVisualState(animated: Bool) {
    let isSelected = visualState == .selected
    let targetLiftY: CGFloat
    switch visualState {
    case .selected: targetLiftY = 9
    case .hovered: targetLiftY = 5
    case .near: targetLiftY = 2
    case .idle: targetLiftY = 0
    }

    cardLayer.borderWidth = isSelected ? 1.5 : 1.0
    cardLayer.borderColor = (isSelected ? palette.orbitCardSelectedBorder : palette.orbitCardBorder).cgColor
    shineLayer.opacity = (glowEnabled && (isSelected || visualState == .hovered)) ? 0.65 : 0.0

    keyBadge.layer?.backgroundColor = (isSelected ? palette.orbitKeyBadgeSelectedBackground : palette.orbitKeyBadgeBackground).cgColor
    keyBadge.textColor = isSelected ? .white : palette.orbitKeyBadgeText

    if let layer = self.layer {
      layer.shadowColor = (isSelected && glowEnabled ? palette.orbitCardSelectedGlow : NSColor(srgbRed: 0.04, green: 0.11, blue: 0.22, alpha: 1)).cgColor
      layer.shadowOpacity = isSelected ? (glowEnabled ? 0.68 : 0.35) : 0.20
      layer.shadowRadius = isSelected ? 18 : 11
      layer.zPosition = isSelected ? 4 : (visualState == .hovered ? 2 : 0)

      let targetTransform = CATransform3DMakeTranslation(0, targetLiftY, 0)
      if animated && LumenMotion.isEnabled {
        let currentTransform = layer.presentation()?.transform ?? layer.transform
        let anim = CASpringAnimation(keyPath: "transform")
        anim.fromValue = NSValue(caTransform3D: currentTransform)
        anim.toValue = NSValue(caTransform3D: targetTransform)
        anim.damping = 19
        anim.stiffness = 280
        anim.mass = 0.85
        anim.duration = min(0.32, anim.settlingDuration)
        layer.removeAnimation(forKey: "orbitLift")
        layer.transform = targetTransform
        layer.add(anim, forKey: "orbitLift")
      } else {
        layer.removeAnimation(forKey: "orbitLift")
        layer.transform = targetTransform
      }
    }
    updateRemoveButtonVisibility(animated: animated)
  }

  @objc private func removeButtonClicked() {
    onRemoveRequested?(item.id)
  }
}

/// Core Animation radial burst of luminous micro-specks played on card removal.
enum LumenOrbitReleaseLightEffect {
  static func burst(in parentLayer: CALayer, from cardFrame: CGRect) {
    let host = CALayer()
    host.frame = parentLayer.bounds
    host.zPosition = 20
    parentLayer.addSublayer(host)

    let goldenAngle: CGFloat = 2.39996
    for i in 0..<18 {
      let speck = CALayer()
      let sz: CGFloat = (i % 4 == 0) ? 3.5 : 2.2
      let x = cardFrame.minX + cardFrame.width * (0.15 + 0.70 * CGFloat((i * 7) % 17) / 17.0)
      let y = cardFrame.minY + cardFrame.height * (0.15 + 0.70 * CGFloat((i * 11) % 17) / 17.0)
      speck.frame = CGRect(x: x, y: y, width: sz, height: sz)
      speck.cornerRadius = sz / 2
      speck.backgroundColor = NSColor(srgbRed: 0.94, green: 0.985, blue: 1.0, alpha: 1).cgColor
      speck.shadowColor = NSColor(srgbRed: 0.76, green: 0.90, blue: 1.0, alpha: 1).cgColor
      speck.shadowOpacity = 0.9
      speck.shadowRadius = 4
      speck.shadowOffset = .zero
      speck.opacity = 0
      host.addSublayer(speck)

      let angle = CGFloat(i) * goldenAngle
      let dx = cos(angle) * CGFloat(18 + i * 2)
      let dy = sin(angle) * CGFloat(14 + i * 2) + 22 // upward in AppKit coords

      let duration = 0.42 + Double(i) * 0.008
      let opacityAnim = CAKeyframeAnimation(keyPath: "opacity")
      opacityAnim.values = [0.0, 0.95, 0.0]
      opacityAnim.keyTimes = [0.0, 0.22, 1.0]

      let moveAnim = CABasicAnimation(keyPath: "position")
      moveAnim.fromValue = NSValue(point: NSPoint(x: x, y: y))
      moveAnim.toValue = NSValue(point: NSPoint(x: x + dx, y: y + dy))

      let scaleAnim = CAKeyframeAnimation(keyPath: "transform.scale")
      scaleAnim.values = [0.6, 1.25, 0.2]
      scaleAnim.keyTimes = [0.0, 0.22, 1.0]

      let group = CAAnimationGroup()
      group.animations = [opacityAnim, moveAnim, scaleAnim]
      group.duration = duration
      group.timingFunction = CAMediaTimingFunction(controlPoints: 0.18, 0.75, 0.3, 1)
      group.fillMode = .forwards
      group.isRemovedOnCompletion = false
      speck.add(group, forKey: "releaseBurst")
    }

    DispatchQueue.main.asyncAfter(deadline: .now() + 0.62) {
      host.removeFromSuperlayer()
    }
  }
}
