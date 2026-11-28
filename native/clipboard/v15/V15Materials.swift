import AppKit
import CoreGraphics
import Foundation
import QuartzCore

// MARK: - V15 Optical Material Helpers (Gradients, Shadows, Specular Sheen)

enum V15Materials {

  /// Converts a CSS `linear-gradient(<deg>deg, ...)` angle into exact `CAGradientLayer`
  /// unit-square `(startPoint, endPoint)` coordinates.
  ///
  /// CSS convention: `0deg` points north (up), `90deg` points east (right), `140deg` points
  /// toward lower-right. When `isFlipped == true` (+Y downward, matching CSS), the direction
  /// vector is `(sin(θ), -cos(θ))`.
  static func gradientPoints(cssDegrees: CGFloat, isFlipped: Bool = true) -> (CGPoint, CGPoint) {
    let rad = cssDegrees * .pi / 180.0
    let dx = sin(rad)
    let dy = isFlipped ? -cos(rad) : cos(rad)
    let start = CGPoint(x: 0.5 - dx * 0.5, y: 0.5 - dy * 0.5)
    let end = CGPoint(x: 0.5 + dx * 0.5, y: 0.5 + dy * 0.5)
    return (start, end)
  }

  /// Applies an exact CSS `box-shadow` spec to a `CALayer`.
  /// - `CALayer.shadowOffset.height` is always in non-flipped Quartz coordinates on macOS
  ///   (negative height shifts shadow downward).
  /// - CSS blur radius maps to CoreAnimation Gaussian `shadowRadius = blurRadius / 2.0`.
  /// - Alpha is placed in `shadowOpacity` with opaque RGB `shadowColor` to avoid premultiplication drift.
  static func applyShadow(to layer: CALayer, spec: V15ShadowSpec, cornerRadius: CGFloat? = nil) {
    let rgb = spec.color.usingColorSpace(.sRGB) ?? spec.color
    let opaque = NSColor(srgbRed: rgb.redComponent, green: rgb.greenComponent, blue: rgb.blueComponent, alpha: 1.0)
    layer.shadowColor = opaque.cgColor
    layer.shadowOpacity = Float(rgb.alphaComponent)
    layer.shadowOffset = CGSize(width: spec.offsetX, height: -spec.offsetY)
    layer.shadowRadius = spec.blurRadius * 0.5
    if let r = cornerRadius, layer.bounds.width > 0, layer.bounds.height > 0 {
      let safeR = max(0, min(r, min(layer.bounds.width, layer.bounds.height) * 0.5))
      layer.shadowPath = CGPath(roundedRect: layer.bounds, cornerWidth: safeR, cornerHeight: safeR, transform: nil)
    }
  }

  static func clearShadow(on layer: CALayer) {
    layer.shadowOpacity = 0
    layer.shadowRadius = 0
    layer.shadowOffset = .zero
    layer.shadowPath = nil
  }

  /// Renders a cached soft radial specular spotlight image for pointer-reactive glass sheen.
  static func makeRadialGlowImage(color: NSColor, diameter: CGFloat = 128) -> CGImage? {
    let rgb = color.usingColorSpace(.sRGB) ?? color
    return makeMultiStopRadialImage(
      stops: [
        (0.00, NSColor(srgbRed: rgb.redComponent, green: rgb.greenComponent, blue: rgb.blueComponent, alpha: rgb.alphaComponent)),
        (0.45, NSColor(srgbRed: rgb.redComponent, green: rgb.greenComponent, blue: rgb.blueComponent, alpha: rgb.alphaComponent * 0.36)),
        (1.00, NSColor(srgbRed: rgb.redComponent, green: rgb.greenComponent, blue: rgb.blueComponent, alpha: 0))
      ],
      width: Int(max(16, diameter.rounded())),
      height: Int(max(16, diameter.rounded()))
    )
  }

  /// Renders a multi-stop elliptical radial gradient image (used for `.orbit:after` specular highlight).
  static func makeMultiStopRadialImage(stops: [(CGFloat, NSColor)], width: Int, height: Int) -> CGImage? {
    let w = max(8, width)
    let h = max(8, height)
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(
      data: nil,
      width: w,
      height: h,
      bitsPerComponent: 8,
      bytesPerRow: 0,
      space: colorSpace,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }

    let cgColors = stops.map { $0.1.cgColor }
    let locs = stops.map { $0.0 }
    guard let grad = CGGradient(colorsSpace: colorSpace, colors: cgColors as CFArray, locations: locs) else {
      return nil
    }
    ctx.saveGState()
    ctx.scaleBy(x: CGFloat(w), y: CGFloat(h))
    let center = CGPoint(x: 0.5, y: 0.5)
    ctx.drawRadialGradient(grad, startCenter: center, startRadius: 0, endCenter: center, endRadius: 0.5, options: [])
    ctx.restoreGState()
    return ctx.makeImage()
  }
}

/// Non-interactive flipped overlay view guaranteed to composite strictly above earlier sibling views.
final class V15PassthroughView: NSView {
  override var isFlipped: Bool { true }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

// MARK: - V15 Orbit Shelf Backdrop (.orbit / :before / :after)

/// Borderless luminous glass shelf backing each participating bottom display viewport.
/// Implements:
/// - True behind-window blur + saturation (`NSVisualEffectView`, `.fullScreenUI` + `.darkAqua`
///   to avoid macOS `.popover`'s opaque light-mode white wash so the frosted glass gradient
///   and low-brightness Optical Dots stay crisp and legible)
/// - Dedicated `glassOverlayView` strictly above `blurView` hosting:
///   - `linear-gradient(180deg, #e6f4ff39, #b3d0ed55 42%, #9bb3db68)` (light) /
///     `linear-gradient(180deg, #152a4770, #101d36a8)` (dark)
///   - `.orbit:before`: pointer radial glow (`#e8f5ff9e` 37%), secondary violet glow (`80% 100%`, `#c5b8ff44` 45%),
///     and `100deg` oblique sheen (`#fff0 → #d8f5ff22 43% → #fff0`)
///   - `inset 0 1px 0 #f6fcff` (light) / `#c2deff75` (dark)
///   - `.orbit:after`: `2px` glowing hairline (`90deg #e9faff12 → #d8efff70 20% → #e6edff90 70% → #fff0`),
///     4-stop pointer radial specular (`white 0%, #d4f2ff 7%, #afd6ff70 16%, transparent 42%`),
///     and `0 0 14px 2px #c7e8ff60` top halo glow
/// - Static Reduce Transparency fallback (§19.2)
final class V15OrbitBackdropView: NSView {
  override var isFlipped: Bool { true }

  private let blurView = NSVisualEffectView()
  private let glassOverlayView = V15PassthroughView()

  private let tintLayer = CAGradientLayer()
  private let pointerGlowLayer = CALayer()
  private let secondaryGlowLayer = CALayer()
  private let obliqueSheenLayer = CAGradientLayer()
  private let topInsetLineLayer = CALayer()
  private let topRimBaseLayer = CAGradientLayer()
  private let topRimPointerLayer = CALayer()

  private var isDark = false
  private var glowEnabled = true
  private var pointerLocalXRatio: CGFloat = 0.5

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.masksToBounds = true

    blurView.blendingMode = .behindWindow
    blurView.state = .active
    // `.fullScreenUI` with `.darkAqua` yields authentic translucent behind-window blur + saturation
    // without macOS Light Mode `.popover`'s opaque ~85% white fill that washes out glass & optical dots.
    blurView.material = .fullScreenUI
    blurView.appearance = NSAppearance(named: .darkAqua)
    blurView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(blurView)

    glassOverlayView.wantsLayer = true
    glassOverlayView.layer?.masksToBounds = true
    glassOverlayView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(glassOverlayView)

    NSLayoutConstraint.activate([
      blurView.topAnchor.constraint(equalTo: topAnchor),
      blurView.bottomAnchor.constraint(equalTo: bottomAnchor),
      blurView.leadingAnchor.constraint(equalTo: leadingAnchor),
      blurView.trailingAnchor.constraint(equalTo: trailingAnchor),

      glassOverlayView.topAnchor.constraint(equalTo: topAnchor),
      glassOverlayView.bottomAnchor.constraint(equalTo: bottomAnchor),
      glassOverlayView.leadingAnchor.constraint(equalTo: leadingAnchor),
      glassOverlayView.trailingAnchor.constraint(equalTo: trailingAnchor)
    ])

    let tintPoints = V15Materials.gradientPoints(cssDegrees: 180, isFlipped: true)
    tintLayer.startPoint = tintPoints.0
    tintLayer.endPoint = tintPoints.1
    glassOverlayView.layer?.addSublayer(tintLayer)

    pointerGlowLayer.contentsGravity = .resize
    glassOverlayView.layer?.addSublayer(pointerGlowLayer)

    secondaryGlowLayer.contentsGravity = .resize
    glassOverlayView.layer?.addSublayer(secondaryGlowLayer)

    // `.orbit:before` oblique sheen: `linear-gradient(100deg, #fff0, #d8f5ff22 43%, #fff0)`
    let obliquePts = V15Materials.gradientPoints(cssDegrees: V15Tokens.Shell.lightObliqueSheenDegrees, isFlipped: true)
    obliqueSheenLayer.startPoint = obliquePts.0
    obliqueSheenLayer.endPoint = obliquePts.1
    obliqueSheenLayer.colors = [
      V15Color.hex("#ffffff00").cgColor,
      V15Tokens.Shell.lightObliqueSheenPeak.cgColor,
      V15Color.hex("#ffffff00").cgColor
    ]
    obliqueSheenLayer.locations = [
      0.0,
      NSNumber(value: Double(V15Tokens.Shell.lightObliqueSheenPeakLocation)),
      1.0
    ]
    glassOverlayView.layer?.addSublayer(obliqueSheenLayer)

    glassOverlayView.layer?.addSublayer(topInsetLineLayer)

    let rimPoints = V15Materials.gradientPoints(cssDegrees: 90, isFlipped: true)
    topRimBaseLayer.startPoint = rimPoints.0
    topRimBaseLayer.endPoint = rimPoints.1
    topRimBaseLayer.masksToBounds = false
    topRimBaseLayer.colors = V15Tokens.Shell.topSpecularStops.map { $0.1.cgColor }
    topRimBaseLayer.locations = V15Tokens.Shell.topSpecularStops.map { NSNumber(value: Double($0.0)) }
    V15Materials.applyShadow(to: topRimBaseLayer, spec: V15Tokens.Shell.topSpecularGlowShadow)
    glassOverlayView.layer?.addSublayer(topRimBaseLayer)

    topRimPointerLayer.contentsGravity = .resize
    topRimPointerLayer.contents = V15Materials.makeMultiStopRadialImage(
      stops: [
        (0.00, V15Tokens.Shell.topSpecularPointerPeak),
        (0.167, V15Tokens.Shell.topSpecularPointerMid),      // 7% / 42%
        (0.381, V15Tokens.Shell.topSpecularPointerOuter),    // 16% / 42%
        (1.00, V15Color.hex("#afd6ff00"))                   // 42% / 42%
      ],
      width: 256,
      height: 16
    )
    glassOverlayView.layer?.addSublayer(topRimPointerLayer)

    applyAppearance(isDark: V15Motion.isDarkTheme, glowEnabled: V15Motion.glowEnabled)
  }

  required init?(coder: NSCoder) { nil }

  override func layout() {
    super.layout()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let w = bounds.width
    let rimH = V15Tokens.Shell.topSpecularHeight
    let spread = V15Tokens.Shell.topSpecularGlowSpread
    tintLayer.frame = bounds
    obliqueSheenLayer.frame = bounds
    topInsetLineLayer.frame = CGRect(x: 0, y: 0, width: w, height: 1)
    topRimBaseLayer.frame = CGRect(x: 0, y: 0, width: w, height: rimH)
    if w > 0 {
      // Exact CSS `box-shadow: 0 0 14px 2px #c7e8ff60` spread expansion across full top hairline
      topRimBaseLayer.shadowPath = CGPath(
        rect: CGRect(x: -spread, y: -spread, width: w + spread * 2, height: rimH + spread * 2),
        transform: nil
      )
    }
    layoutGlowLayers()
    CATransaction.commit()
  }

  func applyAppearance(isDark: Bool, glowEnabled: Bool) {
    self.isDark = isDark
    self.glowEnabled = glowEnabled
    let reduceTransparency = V15Motion.isReduceTransparencyActive

    CATransaction.begin()
    CATransaction.setDisableActions(true)

    blurView.isHidden = reduceTransparency
    // Keep `.fullScreenUI` + `.darkAqua` across both themes so behind-window blur stays true
    // translucent glass without Light Mode `.popover`'s opaque white wash.
    blurView.appearance = NSAppearance(named: .darkAqua)
    blurView.material = .fullScreenUI

    if reduceTransparency {
      let solid = isDark
        ? V15Tokens.Shell.darkReduceTransparencyFill.cgColor
        : V15Tokens.Shell.lightReduceTransparencyFill.cgColor
      tintLayer.colors = [solid, solid]
      tintLayer.locations = [0, 1]
    } else if isDark {
      tintLayer.colors = [
        V15Tokens.Shell.darkGradientTop.cgColor,
        V15Tokens.Shell.darkGradientBottom.cgColor
      ]
      tintLayer.locations = [0, 1]
    } else {
      tintLayer.colors = [
        V15Tokens.Shell.lightGradientTop.cgColor,
        V15Tokens.Shell.lightGradientMid.cgColor,
        V15Tokens.Shell.lightGradientBottom.cgColor
      ]
      tintLayer.locations = [
        0,
        NSNumber(value: Double(V15Tokens.Shell.lightGradientMidLocation)),
        1
      ]
    }

    topInsetLineLayer.backgroundColor = (isDark
      ? V15Tokens.Shell.darkTopInsetLine
      : V15Tokens.Shell.lightTopInsetLine).cgColor

    let glowOpacity: Float = glowEnabled ? 1.0 : 0.25
    pointerGlowLayer.opacity = glowOpacity
    secondaryGlowLayer.opacity = glowOpacity
    obliqueSheenLayer.opacity = (!isDark && glowEnabled) ? 1.0 : 0.0
    topRimBaseLayer.opacity = glowOpacity
    topRimPointerLayer.opacity = glowEnabled ? 1.0 : 0.0

    pointerGlowLayer.contents = V15Materials.makeRadialGlowImage(
      color: isDark ? V15Tokens.Shell.darkPointerGlow : V15Tokens.Shell.lightPointerGlow,
      diameter: 128
    )
    secondaryGlowLayer.contents = V15Materials.makeRadialGlowImage(
      color: isDark ? V15Tokens.Shell.darkSecondaryGlow : V15Tokens.Shell.lightSecondaryGlow,
      diameter: 128
    )

    layoutGlowLayers()
    CATransaction.commit()
  }

  func updatePointerX(_ localX: CGFloat) {
    guard bounds.width > 1 else { return }
    let clamped = max(0, min(1, localX / bounds.width))
    guard abs(clamped - pointerLocalXRatio) > 0.002 else { return }
    pointerLocalXRatio = clamped
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    layoutGlowLayers()
    CATransaction.commit()
  }

  private func layoutGlowLayers() {
    let w = max(1, bounds.width)
    let h = max(1, bounds.height)
    let mx = pointerLocalXRatio * w

    // `.orbit:before`: `radial-gradient(ellipse at mx 0%, #e8f5ff9e, transparent 37%)` (dark: `35%`)
    let glowW = w * (isDark ? 0.70 : 0.74)
    let glowH = max(160, h * 0.92)
    pointerGlowLayer.frame = CGRect(x: mx - glowW * 0.5, y: -glowH * 0.48, width: glowW, height: glowH)

    // `.orbit:before`: `radial-gradient(ellipse at 80% 100%, #c5b8ff44, transparent 45%)`
    let secW = w * 0.90
    let secH = max(150, h * 0.90)
    secondaryGlowLayer.frame = CGRect(x: w * 0.80 - secW * 0.5, y: h - secH * 0.50, width: secW, height: secH)

    // `.orbit:after`: `radial-gradient(ellipse at mx 50%, ..., transparent 42%)` -> width = 84% of shelf
    let rimSpotW = w * 0.84
    topRimPointerLayer.frame = CGRect(
      x: mx - rimSpotW * 0.5,
      y: 0,
      width: rimSpotW,
      height: V15Tokens.Shell.topSpecularHeight
    )
  }
}

// MARK: - V15 Card Glass Surface Layers (.clip.v10card)

/// Encapsulates the exact multi-layer optical material of a V15 Orbit card:
/// - Outer shadow host (`0 6px 18px #142a4220` default per curated `lumen-v15-exact-tokens.md`; selected halo + deeper shadow)
/// - Clipped rounded body (`cornerRadius = 16`, `border = 1px #ffffff95` light / `#9fb8df4a` dark)
/// - 2-stop `155deg` `CAGradientLayer` (`#fbfdfff5 → #e2eaf6ed` light; `145deg #344660ef → #202e44f2` dark)
/// - Pointer-reactive radial specular sheen (`.clip:before`, opacity 0 -> 0.65)
/// - Selected oblique light pass & top inset specular (`.clip.selected:after`)
final class V15CardSurfaceView: NSView {
  override var isFlipped: Bool { true }

  private let shadowLayer = CALayer()
  private let glowLayer = CALayer()
  private let backgroundClipLayer = CALayer()
  private let gradientLayer = CAGradientLayer()

  /// Clipped content host (`cornerRadius = 16`, `masksToBounds = true`) so inner card
  /// subviews clip cleanly to rounded corners while outer card shadows stay unclipped.
  let contentClipView: NSView = {
    let view = V15FlippedContainerView()
    view.wantsLayer = true
    view.layer?.cornerRadius = V15Tokens.Card.cornerRadius
    view.layer?.masksToBounds = true
    return view
  }()

  /// Dedicated passthrough view strictly above `contentClipView` hosting `.clip:before` sheen,
  /// `.clip.selected:after` (`inset 0 0 0 1px #fff`, `inset 0 1px 7px #fff9`, `122deg` `lightPass`),
  /// and crisp outer card border so subviews can never paint over optical highlights.
  private let opticalOverlayView = V15PassthroughView()
  private let specularSheenLayer = CALayer()
  private let selectedInnerTopGlowLayer = CAGradientLayer()
  private let selectedLightPassLayer = CAGradientLayer()
  private let selectedInnerRingLayer = CALayer()
  private let borderOverlayLayer = CALayer()

  private var isDark = false
  private var isSelected = false
  private var isHovered = false
  private var glowEnabled = true
  private var shinePoint = CGPoint(x: 0.5, y: 0.0)

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.masksToBounds = false

    shadowLayer.backgroundColor = NSColor.clear.cgColor
    layer?.addSublayer(shadowLayer)

    glowLayer.backgroundColor = NSColor.clear.cgColor
    layer?.addSublayer(glowLayer)

    backgroundClipLayer.cornerRadius = V15Tokens.Card.cornerRadius
    backgroundClipLayer.masksToBounds = true
    layer?.addSublayer(backgroundClipLayer)

    let lightPts = V15Materials.gradientPoints(cssDegrees: V15Tokens.Card.lightGradientDegrees, isFlipped: true)
    gradientLayer.startPoint = lightPts.0
    gradientLayer.endPoint = lightPts.1
    backgroundClipLayer.addSublayer(gradientLayer)

    contentClipView.frame = bounds
    contentClipView.autoresizingMask = [.width, .height]
    addSubview(contentClipView)

    opticalOverlayView.wantsLayer = true
    opticalOverlayView.layer?.cornerRadius = V15Tokens.Card.cornerRadius
    opticalOverlayView.layer?.masksToBounds = true
    opticalOverlayView.frame = bounds
    opticalOverlayView.autoresizingMask = [.width, .height]
    addSubview(opticalOverlayView)

    specularSheenLayer.contentsGravity = .resize
    specularSheenLayer.opacity = 0
    opticalOverlayView.layer?.addSublayer(specularSheenLayer)

    // `.rail .clip.selected:after` -> `box-shadow: inset 0 1px 7px #fff9` (dark `#c7e0ff4a`)
    selectedInnerTopGlowLayer.startPoint = CGPoint(x: 0.5, y: 0)
    selectedInnerTopGlowLayer.endPoint = CGPoint(x: 0.5, y: 1)
    selectedInnerTopGlowLayer.opacity = 0
    opticalOverlayView.layer?.addSublayer(selectedInnerTopGlowLayer)

    // `.rail .clip.selected:after` -> `linear-gradient(122deg, transparent 10%, #fff3 30%, transparent 48%)`
    let passPts = V15Materials.gradientPoints(cssDegrees: V15Tokens.Card.selectedLightPassDegrees, isFlipped: true)
    selectedLightPassLayer.startPoint = passPts.0
    selectedLightPassLayer.endPoint = passPts.1
    selectedLightPassLayer.colors = [
      V15Color.hex("#ffffff00").cgColor,
      V15Tokens.Card.selectedLightPassPeakColor.cgColor,
      V15Color.hex("#ffffff00").cgColor
    ]
    selectedLightPassLayer.locations = [0.10, 0.30, 0.48]
    selectedLightPassLayer.opacity = 0
    opticalOverlayView.layer?.addSublayer(selectedLightPassLayer)

    // `.rail .clip.selected:after` -> `inset 0 0 0 1px #fff` (dark `#bcd9ff`)
    selectedInnerRingLayer.borderWidth = 1
    selectedInnerRingLayer.backgroundColor = NSColor.clear.cgColor
    selectedInnerRingLayer.opacity = 0
    opticalOverlayView.layer?.addSublayer(selectedInnerRingLayer)

    // Outer 1px border (`#ffffff95` light / `#9fb8df4a` dark; selected `#f8fcff` / `#d4eaff`)
    borderOverlayLayer.cornerRadius = V15Tokens.Card.cornerRadius
    borderOverlayLayer.borderWidth = V15Tokens.Card.borderWidth
    borderOverlayLayer.backgroundColor = NSColor.clear.cgColor
    opticalOverlayView.layer?.addSublayer(borderOverlayLayer)
  }

  required init?(coder: NSCoder) { nil }

  override func layout() {
    super.layout()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let r = V15Tokens.Card.cornerRadius
    shadowLayer.frame = bounds
    glowLayer.frame = bounds
    backgroundClipLayer.frame = bounds
    gradientLayer.frame = bounds
    contentClipView.frame = bounds
    opticalOverlayView.frame = bounds
    selectedInnerTopGlowLayer.frame = CGRect(x: 0, y: 0, width: bounds.width, height: V15Tokens.Card.selectedInnerHighlightHeight)
    selectedLightPassLayer.frame = bounds
    selectedInnerRingLayer.frame = bounds.insetBy(dx: 1, dy: 1)
    selectedInnerRingLayer.cornerRadius = max(0, r - 1)
    borderOverlayLayer.frame = bounds

    if bounds.width > 0, bounds.height > 0 {
      let safeR = max(0, min(r, min(bounds.width, bounds.height) * 0.5))
      let path = CGPath(roundedRect: bounds, cornerWidth: safeR, cornerHeight: safeR, transform: nil)
      shadowLayer.shadowPath = path
      glowLayer.shadowPath = path
    }
    updateSheenFrame()
    CATransaction.commit()
  }

  func applyState(isDark: Bool, isSelected: Bool, isHovered: Bool, glowEnabled: Bool, animated: Bool) {
    let wasSelected = self.isSelected
    let themeChanged = self.isDark != isDark || self.glowEnabled != glowEnabled
    self.isDark = isDark
    self.isSelected = isSelected
    self.isHovered = isHovered
    self.glowEnabled = glowEnabled

    let duration: TimeInterval = (animated && V15Motion.isEnabled) ? 0.25 : 0.0
    CATransaction.begin()
    CATransaction.setDisableActions(duration == 0)
    CATransaction.setAnimationDuration(duration)

    if themeChanged || gradientLayer.colors == nil {
      if isDark {
        let pts = V15Materials.gradientPoints(cssDegrees: V15Tokens.Card.darkGradientDegrees, isFlipped: true)
        gradientLayer.startPoint = pts.0
        gradientLayer.endPoint = pts.1
        gradientLayer.colors = [
          V15Tokens.Card.darkGradientStart.cgColor,
          V15Tokens.Card.darkGradientEnd.cgColor
        ]
        gradientLayer.locations = [0, 1]
        selectedInnerTopGlowLayer.colors = [
          V15Tokens.Card.darkSelectedInnerHighlight.cgColor,
          V15Color.hex("#c7e0ff1f").cgColor,
          V15Color.hex("#c7e0ff00").cgColor
        ]
        selectedInnerTopGlowLayer.locations = [0.0, 0.40, 1.0]
        selectedInnerRingLayer.borderColor = V15Tokens.Card.darkSelectedInnerRing.cgColor
        specularSheenLayer.contents = V15Materials.makeRadialGlowImage(color: V15Tokens.Card.darkSpecularSheen, diameter: 128)
      } else {
        let pts = V15Materials.gradientPoints(cssDegrees: V15Tokens.Card.lightGradientDegrees, isFlipped: true)
        gradientLayer.startPoint = pts.0
        gradientLayer.endPoint = pts.1
        gradientLayer.colors = [
          V15Tokens.Card.lightGradientStart.cgColor,
          V15Tokens.Card.lightGradientEnd.cgColor
        ]
        gradientLayer.locations = [0, 1]
        selectedInnerTopGlowLayer.colors = [
          V15Tokens.Card.lightSelectedInnerHighlight.cgColor,
          V15Color.hex("#ffffff44").cgColor,
          V15Color.hex("#ffffff00").cgColor
        ]
        selectedInnerTopGlowLayer.locations = [0.0, 0.40, 1.0]
        selectedInnerRingLayer.borderColor = V15Tokens.Card.lightSelectedInnerRing.cgColor
        specularSheenLayer.contents = V15Materials.makeRadialGlowImage(color: V15Tokens.Card.lightSpecularSheen, diameter: 128)
      }
    }

    let r = V15Tokens.Card.cornerRadius
    if isSelected {
      borderOverlayLayer.borderColor = (isDark
        ? V15Tokens.Card.darkSelectedBorderColor
        : V15Tokens.Card.lightSelectedBorderColor).cgColor
      V15Materials.applyShadow(
        to: shadowLayer,
        spec: isDark ? V15Tokens.Card.darkSelectedShadow : V15Tokens.Card.lightSelectedShadow,
        cornerRadius: r
      )
      if glowEnabled {
        V15Materials.applyShadow(
          to: glowLayer,
          spec: isDark ? V15Tokens.Card.darkSelectedGlow : V15Tokens.Card.lightSelectedGlow,
          cornerRadius: r
        )
      } else {
        V15Materials.clearShadow(on: glowLayer)
      }
    } else {
      borderOverlayLayer.borderColor = (isDark
        ? V15Tokens.Card.darkBorderColor
        : V15Tokens.Card.lightBorderColor).cgColor
      V15Materials.applyShadow(
        to: shadowLayer,
        spec: isDark ? V15Tokens.Card.darkShadow : V15Tokens.Card.lightShadow,
        cornerRadius: r
      )
      V15Materials.clearShadow(on: glowLayer)
    }

    let showSheen = glowEnabled && (isHovered || isSelected)
    let showSelectedAfter = glowEnabled && isSelected
    specularSheenLayer.opacity = showSheen ? V15Tokens.Card.specularSheenActiveOpacity : 0.0
    selectedLightPassLayer.opacity = showSelectedAfter ? V15Tokens.Card.selectedLightPassSteadyOpacity : 0.0
    selectedInnerTopGlowLayer.opacity = showSelectedAfter ? 0.90 : 0.0
    selectedInnerRingLayer.opacity = showSelectedAfter ? 0.95 : 0.0

    CATransaction.commit()

    // `.rail .clip.selected:after` `@keyframes lightPass .85s ease-out both` (0 -> 1.0 @ 40% -> 0.38)
    if isSelected && !wasSelected && glowEnabled && V15Motion.isEnabled {
      let anim = CAKeyframeAnimation(keyPath: "opacity")
      anim.values = [0.0, 1.0, Double(V15Tokens.Card.selectedLightPassSteadyOpacity)]
      anim.keyTimes = [0.0, 0.40, 1.0]
      anim.duration = V15Tokens.Card.selectedLightPassDuration
      anim.timingFunction = CAMediaTimingFunction(name: .easeOut)
      selectedLightPassLayer.removeAnimation(forKey: "v15LightPass")
      selectedLightPassLayer.add(anim, forKey: "v15LightPass")
    } else if !isSelected {
      selectedLightPassLayer.removeAnimation(forKey: "v15LightPass")
    }
  }

  func updateSpecularPoint(_ localPoint: CGPoint) {
    guard bounds.width > 1, bounds.height > 1 else { return }
    shinePoint = CGPoint(
      x: max(0, min(1, localPoint.x / bounds.width)),
      y: max(0, min(1, localPoint.y / bounds.height))
    )
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    updateSheenFrame()
    CATransaction.commit()
  }

  private func updateSheenFrame() {
    let diameter = max(bounds.width, bounds.height) * 0.92
    let cx = shinePoint.x * bounds.width
    let cy = shinePoint.y * bounds.height
    specularSheenLayer.frame = CGRect(
      x: cx - diameter * 0.5,
      y: cy - diameter * 0.5,
      width: diameter,
      height: diameter
    )
  }
}

final class V15FlippedContainerView: NSView {
  override var isFlipped: Bool { true }
}

// MARK: - V15 Floating Toast Banner (.toast)

/// Temporary floating toast shown above the active Orbit viewport (e.g. removal + undo prompt).
/// Source: `paste-lumen-v15.html` `.toast` (`#20324de8`, radius 13, border `1px #ffffff38`, shadow `0 8px 28px #10213a4d`).
final class V15ToastBannerView: NSView {
  override var isFlipped: Bool { true }

  private let pillLayer = CALayer()
  private let stackView = NSStackView()
  private let iconView = NSImageView()
  private let messageLabel = NSTextField(labelWithString: "")
  private let undoButton = NSButton(title: "撤销", target: nil, action: nil)

  private var hideWork: DispatchWorkItem?
  var onUndo: (() -> Void)?

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.masksToBounds = false
    isHidden = true
    alphaValue = 0

    pillLayer.backgroundColor = V15Tokens.Toast.background.cgColor
    pillLayer.cornerRadius = V15Tokens.Toast.cornerRadius
    pillLayer.borderWidth = 1
    pillLayer.borderColor = V15Tokens.Toast.borderColor.cgColor
    layer?.addSublayer(pillLayer)

    iconView.image = V15Glyphs.actionImage(.check, size: 15, color: V15Tokens.Toast.textColor, strokeWidth: 1.8)
    iconView.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      iconView.widthAnchor.constraint(equalToConstant: 15),
      iconView.heightAnchor.constraint(equalToConstant: 15)
    ])

    messageLabel.font = .systemFont(ofSize: V15Tokens.Toast.fontSize, weight: .medium)
    messageLabel.textColor = V15Tokens.Toast.textColor
    messageLabel.lineBreakMode = .byTruncatingTail

    undoButton.isBordered = false
    undoButton.target = self
    undoButton.action = #selector(handleUndoClick)
    undoButton.attributedTitle = NSAttributedString(
      string: "撤销",
      attributes: [
        .font: NSFont.systemFont(ofSize: V15Tokens.Toast.fontSize, weight: .medium),
        .foregroundColor: V15Tokens.Toast.actionColor,
        .underlineStyle: NSUnderlineStyle.single.rawValue
      ]
    )

    stackView.orientation = .horizontal
    stackView.alignment = .centerY
    stackView.spacing = V15Tokens.Toast.gap
    stackView.detachesHiddenViews = true
    stackView.translatesAutoresizingMaskIntoConstraints = false
    stackView.addArrangedSubview(iconView)
    stackView.addArrangedSubview(messageLabel)
    stackView.addArrangedSubview(undoButton)
    addSubview(stackView)

    NSLayoutConstraint.activate([
      stackView.topAnchor.constraint(equalTo: topAnchor, constant: V15Tokens.Toast.paddingVertical),
      stackView.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -V15Tokens.Toast.paddingVertical),
      stackView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: V15Tokens.Toast.paddingHorizontal),
      stackView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -V15Tokens.Toast.paddingHorizontal)
    ])
  }

  required init?(coder: NSCoder) { nil }

  override func layout() {
    super.layout()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    pillLayer.frame = bounds
    V15Materials.applyShadow(to: pillLayer, spec: V15Tokens.Toast.shadow, cornerRadius: V15Tokens.Toast.cornerRadius)
    CATransaction.commit()
  }

  func show(message: String, showUndo: Bool) {
    hideWork?.cancel()
    messageLabel.stringValue = message
    undoButton.isHidden = !showUndo
    isHidden = false
    needsLayout = true
    layoutSubtreeIfNeeded()

    if V15Motion.isEnabled {
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = 0.25
        ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
        self.animator().alphaValue = 1.0
      }
    } else {
      alphaValue = 1.0
    }

    let work = DispatchWorkItem { [weak self] in
      self?.dismiss()
    }
    hideWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + V15Tokens.Toast.autoDismissDelay, execute: work)
  }

  func dismiss(immediate: Bool = false) {
    hideWork?.cancel()
    hideWork = nil
    guard !isHidden else { return }
    if immediate || !V15Motion.isEnabled {
      alphaValue = 0
      isHidden = true
      return
    }
    NSAnimationContext.runAnimationGroup({ ctx in
      ctx.duration = 0.22
      ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
      self.animator().alphaValue = 0
    }, completionHandler: { [weak self] in
      guard let self, self.alphaValue <= 0.01 else { return }
      self.isHidden = true
    })
  }

  @objc private func handleUndoClick() {
    dismiss(immediate: true)
    onUndo?()
  }
}
