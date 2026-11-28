import AppKit
import CoreGraphics
import Foundation

/// Centralized V15 design tokens (§13, §17, §18, §19.1) in DIP / macOS points.
enum LumenV15Tokens {
  // Orbit card & close affordance (§19.1)
  static let orbitCardCorner: CGFloat = 16
  static let orbitHeaderHeight: CGFloat = 34
  static let orbitHeaderInsetIdle: CGFloat = 12
  static let orbitHeaderInsetHover: CGFloat = 43
  static let orbitCloseHitSize: CGFloat = 28
  static let orbitCloseSurfaceSize: CGFloat = 22
  static let orbitCloseSurfaceInset: CGFloat = 3
  static let orbitCloseGlyphSize: CGFloat = 13
  static let orbitCloseAnchorTop: CGFloat = 4
  static let orbitCloseAnchorTrailing: CGFloat = 7
  static let orbitLiftIdle: CGFloat = 0
  static let orbitLiftNear: CGFloat = 2
  static let orbitLiftHover: CGFloat = 5
  static let orbitLiftSelected: CGFloat = 7

  // Optical Dots 3.0 (§3.2)
  static let opticalDotsColumnWidth: CGFloat = 38
  static let opticalDotsVisibleCount: Int = 5
  static let opticalDotsWheelThreshold: CGFloat = 42
  static let opticalDotsSleepDelay: TimeInterval = 0.90

  // Choreography timings (§17, §18.4, §19.1)
  static let orbitLiftDuration: TimeInterval = 0.32
  static let orbitTimeYieldDuration: TimeInterval = 0.21
  static let orbitTimeReturnDelay: TimeInterval = 0.10
  static let orbitCloseFadeDelay: TimeInterval = 0.145
  static let orbitCloseFadeDuration: TimeInterval = 0.10
  static let orbitCloseScaleDelay: TimeInterval = 0.085
  static let orbitCloseScaleDuration: TimeInterval = 0.24
  static let dissolveFrontDuration: TimeInterval = 0.48
  static let dissolveHoldDuration: TimeInterval = 0.92
  static let dissolveNoParticlesHold: TimeInterval = 0.18
  static let dissolveReflowDuration: TimeInterval = 0.42
  static let dissolveParticleLifeMin: TimeInterval = 0.32
  static let dissolveParticleLifeMax: TimeInterval = 0.50
  static let dissolveParticlePeakAlpha: CGFloat = 0.58
  static let captureAggregateDuration: TimeInterval = 0.90

  // Library V15 (§13.1, §17.3)
  static let sidebarExpandedWidth: CGFloat = 208
  static let inspectorDefaultWidth: CGFloat = 344
  static let inspectorMinWidth: CGFloat = 300
  static let inspectorMaxWidth: CGFloat = 600
  static let inspectorToolbarHeight: CGFloat = 48
  static let inspectorActionHitSize: CGFloat = 32
  static let inspectorActionGlyphSize: CGFloat = 18
  static let inspectorActionSpacing: CGFloat = 5
  static let inspectorCopyMinWidth: CGFloat = 88
  static let inspectorCopyMaxWidth: CGFloat = 112
  static let inspectorCopyHeight: CGFloat = 34
  static let paneCollapseDuration: TimeInterval = 0.38
}

/// Centralized motion preference check honoring both app preference and macOS Reduce Motion.
enum LumenMotion {
  static var isEnabled: Bool {
    LumenClipboardStore.shared.preferences.motion && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
  }

  static var enterDuration: TimeInterval { isEnabled ? 0.40 : 0.01 }
  static var exitDuration: TimeInterval { isEnabled ? 0.22 : 0.01 }
  static var switchDuration: TimeInterval { isEnabled ? 0.28 : 0.01 }
  static var removeDuration: TimeInterval { isEnabled ? LumenV15Tokens.dissolveReflowDuration : 0.01 }
  static var hoverDuration: TimeInterval { isEnabled ? 0.20 : 0.01 }
  static var paneCollapseDuration: TimeInterval { isEnabled ? LumenV15Tokens.paneCollapseDuration : 0.01 }

  /// Evaluates a cubic-bezier timing curve (Newton-Raphson) for display-ticked animations.
  static func cubicBezier(_ t: Double, _ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) -> Double {
    let clamped = max(0, min(1, t))
    if clamped == 0 || clamped == 1 { return clamped }
    var u = clamped
    for _ in 0..<6 {
      let inv = 1 - u
      let x = 3 * inv * inv * u * x1 + 3 * inv * u * u * x2 + u * u * u
      let dx = 3 * inv * inv * x1 + 6 * inv * u * (x2 - x1) + 3 * u * u * (1 - x2)
      if abs(dx) < 1e-6 { break }
      u = max(0, min(1, u - (x - clamped) / dx))
    }
    let inv = 1 - u
    return 3 * inv * inv * u * y1 + 3 * inv * u * u * y2 + u * u * u
  }

  static func easeFluidPane(_ t: Double) -> Double {
    cubicBezier(t, 0.28, 0.58, 0.26, 1.0)
  }
}

/// Glacier Glass (Light) & Deep Sea Glass (Dark) design tokens faithful to Lumen V7.
struct LumenPalette {
  let isDark: Bool
  let windowBackground: NSColor
  let sidebarBackgroundTop: NSColor
  let sidebarBackgroundBottom: NSColor
  let surface: NSColor
  let surfaceElevated: NSColor
  let border: NSColor
  let borderStrong: NSColor
  let ink: NSColor
  let muted: NSColor
  let accent: NSColor
  let accentSoft: NSColor
  let accentBorder: NSColor
  let danger: NSColor
  let dangerSoft: NSColor
  let success: NSColor
  let warning: NSColor

  // Orbit translucent rail palette
  let orbitBackdropTop: NSColor
  let orbitBackdropBottom: NSColor
  let orbitTopSheen: NSColor
  let orbitCardTop: NSColor
  let orbitCardBottom: NSColor
  let orbitCardBorder: NSColor
  let orbitCardHoverBorder: NSColor
  let orbitCardSelectedBorder: NSColor
  let orbitCardInnerHighlight: NSColor
  let orbitCardShadowColor: NSColor
  let orbitCardSelectedGlow: NSColor
  let orbitKeyBadgeBackground: NSColor
  let orbitKeyBadgeText: NSColor
  let orbitKeyBadgeSelectedBackground: NSColor

  // Code surface (always dark editorial slate for high contrast)
  let codeBackground: NSColor
  let codeToolbarBackground: NSColor
  let codeGutterText: NSColor
  let codeBaseText: NSColor

  static func current(_ prefs: LumenVisualPreferences = LumenClipboardStore.shared.preferences) -> LumenPalette {
    prefs.theme == .dark ? .dark : .light
  }

  var nsAppearance: NSAppearance? {
    NSAppearance(named: isDark ? .darkAqua : .aqua)
  }

  static let light = LumenPalette(
    isDark: false,
    windowBackground: NSColor(srgbRed: 0.976, green: 0.980, blue: 0.988, alpha: 1.0),
    sidebarBackgroundTop: NSColor(srgbRed: 0.910, green: 0.925, blue: 0.961, alpha: 1.0),
    sidebarBackgroundBottom: NSColor(srgbRed: 0.945, green: 0.953, blue: 0.969, alpha: 1.0),
    surface: NSColor(srgbRed: 1.0, green: 1.0, blue: 1.0, alpha: 1.0),
    surfaceElevated: NSColor(srgbRed: 0.945, green: 0.957, blue: 0.980, alpha: 1.0),
    border: NSColor(srgbRed: 0.886, green: 0.902, blue: 0.933, alpha: 1.0),
    borderStrong: NSColor(srgbRed: 0.788, green: 0.824, blue: 0.894, alpha: 1.0),
    ink: NSColor(srgbRed: 0.125, green: 0.149, blue: 0.204, alpha: 1.0),
    muted: NSColor(srgbRed: 0.345, green: 0.420, blue: 0.514, alpha: 1.0), // #586B83 (§13.1 >=4.5:1)
    accent: NSColor(srgbRed: 0.322, green: 0.396, blue: 0.729, alpha: 1.0), // #5265BA
    accentSoft: NSColor(srgbRed: 0.506, green: 0.580, blue: 0.882, alpha: 0.16),
    accentBorder: NSColor(srgbRed: 0.506, green: 0.580, blue: 0.882, alpha: 0.42),
    danger: NSColor(srgbRed: 0.702, green: 0.278, blue: 0.349, alpha: 1.0), // #B34759 (§13.1)
    dangerSoft: NSColor(srgbRed: 0.831, green: 0.404, blue: 0.467, alpha: 0.12),
    success: NSColor(srgbRed: 0.369, green: 0.710, blue: 0.584, alpha: 1.0),
    warning: NSColor(srgbRed: 0.875, green: 0.643, blue: 0.294, alpha: 1.0),

    orbitBackdropTop: NSColor(srgbRed: 0.890, green: 0.945, blue: 0.996, alpha: 0.42),
    orbitBackdropBottom: NSColor(srgbRed: 0.620, green: 0.718, blue: 0.867, alpha: 0.56),
    orbitTopSheen: NSColor(srgbRed: 0.950, green: 0.985, blue: 1.0, alpha: 0.88),
    orbitCardTop: NSColor(srgbRed: 0.992, green: 0.996, blue: 1.0, alpha: 0.96),
    orbitCardBottom: NSColor(srgbRed: 0.914, green: 0.941, blue: 0.980, alpha: 0.93),
    orbitCardBorder: NSColor(srgbRed: 0.416, green: 0.518, blue: 0.663, alpha: 0.34),
    orbitCardHoverBorder: NSColor(srgbRed: 0.365, green: 0.486, blue: 0.678, alpha: 0.48),
    orbitCardSelectedBorder: NSColor(srgbRed: 0.369, green: 0.545, blue: 0.902, alpha: 0.88),
    orbitCardInnerHighlight: NSColor(srgbRed: 1.0, green: 1.0, blue: 1.0, alpha: 0.82),
    orbitCardShadowColor: NSColor(srgbRed: 0.067, green: 0.145, blue: 0.275, alpha: 1.0),
    orbitCardSelectedGlow: NSColor(srgbRed: 0.565, green: 0.753, blue: 0.988, alpha: 0.85),
    orbitKeyBadgeBackground: NSColor(srgbRed: 0.353, green: 0.451, blue: 0.612, alpha: 0.12),
    orbitKeyBadgeText: NSColor(srgbRed: 0.396, green: 0.463, blue: 0.576, alpha: 1.0),
    orbitKeyBadgeSelectedBackground: NSColor(srgbRed: 0.396, green: 0.537, blue: 0.843, alpha: 1.0),

    codeBackground: NSColor(srgbRed: 0.082, green: 0.110, blue: 0.173, alpha: 1.0),
    codeToolbarBackground: NSColor(srgbRed: 0.125, green: 0.165, blue: 0.235, alpha: 1.0),
    codeGutterText: NSColor(srgbRed: 0.412, green: 0.478, blue: 0.580, alpha: 1.0),
    codeBaseText: NSColor(srgbRed: 0.859, green: 0.902, blue: 0.976, alpha: 1.0)
  )

  static let dark = LumenPalette(
    isDark: true,
    windowBackground: NSColor(srgbRed: 0.090, green: 0.106, blue: 0.145, alpha: 1.0),
    sidebarBackgroundTop: NSColor(srgbRed: 0.145, green: 0.176, blue: 0.255, alpha: 1.0),
    sidebarBackgroundBottom: NSColor(srgbRed: 0.125, green: 0.145, blue: 0.192, alpha: 1.0),
    surface: NSColor(srgbRed: 0.118, green: 0.149, blue: 0.212, alpha: 1.0),
    surfaceElevated: NSColor(srgbRed: 0.153, green: 0.192, blue: 0.267, alpha: 1.0),
    border: NSColor(srgbRed: 0.188, green: 0.216, blue: 0.275, alpha: 1.0),
    borderStrong: NSColor(srgbRed: 0.267, green: 0.314, blue: 0.404, alpha: 1.0),
    ink: NSColor(srgbRed: 0.914, green: 0.929, blue: 0.969, alpha: 1.0),
    muted: NSColor(srgbRed: 0.647, green: 0.718, blue: 0.804, alpha: 1.0), // #A5B7CD (§13.1 >=4.5:1)
    accent: NSColor(srgbRed: 0.627, green: 0.690, blue: 1.0, alpha: 1.0),
    accentSoft: NSColor(srgbRed: 0.506, green: 0.584, blue: 0.902, alpha: 0.20),
    accentBorder: NSColor(srgbRed: 0.569, green: 0.659, blue: 0.969, alpha: 0.46),
    danger: NSColor(srgbRed: 0.941, green: 0.627, blue: 0.671, alpha: 1.0), // #F0A0AB (§13.1)
    dangerSoft: NSColor(srgbRed: 0.831, green: 0.404, blue: 0.467, alpha: 0.18),
    success: NSColor(srgbRed: 0.431, green: 0.796, blue: 0.659, alpha: 1.0),
    warning: NSColor(srgbRed: 0.945, green: 0.725, blue: 0.388, alpha: 1.0),

    orbitBackdropTop: NSColor(srgbRed: 0.082, green: 0.165, blue: 0.278, alpha: 0.66),
    orbitBackdropBottom: NSColor(srgbRed: 0.063, green: 0.114, blue: 0.212, alpha: 0.82),
    orbitTopSheen: NSColor(srgbRed: 0.761, green: 0.871, blue: 1.0, alpha: 0.70),
    orbitCardTop: NSColor(srgbRed: 0.212, green: 0.282, blue: 0.392, alpha: 0.94),
    orbitCardBottom: NSColor(srgbRed: 0.125, green: 0.180, blue: 0.271, alpha: 0.95),
    orbitCardBorder: NSColor(srgbRed: 0.624, green: 0.722, blue: 0.875, alpha: 0.38),
    orbitCardHoverBorder: NSColor(srgbRed: 0.722, green: 0.827, blue: 0.969, alpha: 0.56),
    orbitCardSelectedBorder: NSColor(srgbRed: 0.812, green: 0.922, blue: 1.0, alpha: 0.96),
    orbitCardInnerHighlight: NSColor(srgbRed: 0.878, green: 0.941, blue: 1.0, alpha: 0.14),
    orbitCardShadowColor: NSColor(srgbRed: 0.012, green: 0.027, blue: 0.075, alpha: 1.0),
    orbitCardSelectedGlow: NSColor(srgbRed: 0.631, green: 0.792, blue: 1.0, alpha: 0.72),
    orbitKeyBadgeBackground: NSColor(srgbRed: 0.667, green: 0.769, blue: 1.0, alpha: 0.14),
    orbitKeyBadgeText: NSColor(srgbRed: 0.722, green: 0.800, blue: 0.922, alpha: 1.0),
    orbitKeyBadgeSelectedBackground: NSColor(srgbRed: 0.459, green: 0.588, blue: 0.855, alpha: 1.0),

    codeBackground: NSColor(srgbRed: 0.082, green: 0.110, blue: 0.173, alpha: 1.0),
    codeToolbarBackground: NSColor(srgbRed: 0.125, green: 0.165, blue: 0.235, alpha: 1.0),
    codeGutterText: NSColor(srgbRed: 0.412, green: 0.478, blue: 0.580, alpha: 1.0),
    codeBaseText: NSColor(srgbRed: 0.859, green: 0.902, blue: 0.976, alpha: 1.0)
  )

  func categoryTint(_ category: LumenLogicalCategory) -> NSColor {
    LumenContentIdentityRegistry.shared.identity(forCategory: category).tintColor(isDark: isDark)
  }

  func categoryTint(_ category: LumenDisplayCategory) -> NSColor {
    switch category {
    case .text: return categoryTint(LumenLogicalCategory.text)
    case .code: return categoryTint(LumenLogicalCategory.code)
    case .image: return categoryTint(LumenLogicalCategory.image)
    case .link: return categoryTint(LumenLogicalCategory.link)
    case .color: return categoryTint(LumenLogicalCategory.color)
    case .file: return categoryTint(LumenLogicalCategory.otherFile)
    }
  }

  func sourceBadgeColor(for source: String) -> NSColor {
    let clean = source.trimmingCharacters(in: .whitespacesAndNewlines)
    if clean.isEmpty || clean == "来源未知" || clean == "Unknown" {
      return isDark
        ? NSColor(srgbRed: 0.420, green: 0.490, blue: 0.588, alpha: 1)
        : NSColor(srgbRed: 0.510, green: 0.588, blue: 0.706, alpha: 1)
    }
    let lower = clean.lowercased()
    if lower.contains("code") || lower.contains("xcode") || lower.contains("cursor") {
      return NSColor(srgbRed: 0.337, green: 0.541, blue: 0.792, alpha: 1)
    }
    if lower.contains("figma") || lower.contains("sketch") || lower.contains("preview") {
      return NSColor(srgbRed: 0.612, green: 0.514, blue: 0.776, alpha: 1)
    }
    if lower.contains("chrome") || lower.contains("safari") || lower.contains("arc") || lower.contains("firefox") {
      return NSColor(srgbRed: 0.412, green: 0.620, blue: 0.569, alpha: 1)
    }
    if lower.contains("finder") || lower.contains("访达") {
      return NSColor(srgbRed: 0.482, green: 0.620, blue: 0.812, alpha: 1)
    }
    if lower.contains("wechat") || lower.contains("微信") {
      return NSColor(srgbRed: 0.157, green: 0.678, blue: 0.439, alpha: 1)
    }
    if lower.contains("notes") || lower.contains("备忘") {
      return NSColor(srgbRed: 0.886, green: 0.678, blue: 0.349, alpha: 1)
    }
    return NSColor(srgbRed: 0.478, green: 0.580, blue: 0.824, alpha: 1)
  }
}

enum LumenIcons {
  static func symbol(_ name: String, size: CGFloat = 15, weight: NSFont.Weight = .medium, description: String? = nil) -> NSImage {
    let base = NSImage(systemSymbolName: name, accessibilityDescription: description)
      ?? NSImage(systemSymbolName: "doc", accessibilityDescription: description)
      ?? NSImage(size: NSSize(width: size, height: size))
    let config = NSImage.SymbolConfiguration(pointSize: size, weight: weight)
    let configured = base.withSymbolConfiguration(config) ?? base
    configured.isTemplate = true
    return configured
  }
}

/// CoreGraphics-drawn Lumen luminous spiral mark (pure native vector, zero HTML/SVG).
final class LumenBrandMarkView: NSView {
  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
  }

  required init?(coder: NSCoder) { nil }

  override func draw(_ dirtyRect: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    let rect = bounds
    let radius = min(rect.width, rect.height) * 0.32
    let clip = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
    ctx.saveGState()
    ctx.addPath(clip)
    ctx.clip()

    let space = CGColorSpaceCreateDeviceRGB()
    let colors = [
      NSColor(srgbRed: 0.737, green: 0.914, blue: 1.0, alpha: 1).cgColor,
      NSColor(srgbRed: 0.506, green: 0.600, blue: 0.980, alpha: 1).cgColor,
      NSColor(srgbRed: 0.725, green: 0.627, blue: 0.992, alpha: 1).cgColor
    ] as CFArray
    if let gradient = CGGradient(colorsSpace: space, colors: colors, locations: [0.0, 0.55, 1.0]) {
      ctx.drawLinearGradient(
        gradient,
        start: CGPoint(x: 0, y: rect.maxY),
        end: CGPoint(x: rect.maxX, y: 0),
        options: []
      )
    }

    // Draw crisp white orbital glyph
    let scale = min(rect.width, rect.height) / 24.0
    ctx.translateBy(x: (rect.width - 24 * scale) / 2, y: (rect.height - 24 * scale) / 2)
    ctx.scaleBy(x: scale, y: scale)
    ctx.setStrokeColor(NSColor.white.cgColor)
    ctx.setLineWidth(1.9)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)

    // Stylized orbit curve (flipped Y for AppKit bottom-up coords)
    let orbit = CGMutablePath()
    orbit.move(to: CGPoint(x: 4.5, y: 11))
    orbit.addCurve(to: CGPoint(x: 13.5, y: 19), control1: CGPoint(x: 5.5, y: 16), control2: CGPoint(x: 9.5, y: 19))
    orbit.addCurve(to: CGPoint(x: 20.5, y: 13), control1: CGPoint(x: 18.0, y: 19), control2: CGPoint(x: 20.5, y: 16))
    orbit.addCurve(to: CGPoint(x: 11.5, y: 5.5), control1: CGPoint(x: 20.5, y: 8.5), control2: CGPoint(x: 16.0, y: 5.5))
    orbit.addCurve(to: CGPoint(x: 7.0, y: 8.5), control1: CGPoint(x: 8.5, y: 5.5), control2: CGPoint(x: 7.0, y: 6.8))
    orbit.addCurve(to: CGPoint(x: 13.5, y: 13.5), control1: CGPoint(x: 7.0, y: 11.5), control2: CGPoint(x: 10.5, y: 13.5))
    ctx.addPath(orbit)
    ctx.strokePath()

    ctx.restoreGState()
  }
}

/// CoreGraphics-drawn luminous abstract cover art for audio tracks and visual placeholders.
final class LumenAlbumCoverView: NSView {
  var seedIndex: Int = 0 { didSet { needsDisplay = true } }
  var badgeText: String = "LUMEN" { didSet { needsDisplay = true } }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.cornerRadius = 16
    layer?.cornerCurve = .continuous
    layer?.masksToBounds = true
  }

  required init?(coder: NSCoder) { nil }

  override func draw(_ dirtyRect: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    let palettes: [(NSColor, NSColor, NSColor)] = [
      (NSColor(srgbRed: 0.208, green: 0.282, blue: 0.443, alpha: 1),
       NSColor(srgbRed: 0.698, green: 0.780, blue: 0.906, alpha: 1),
       NSColor(srgbRed: 0.973, green: 0.851, blue: 0.839, alpha: 1)),
      (NSColor(srgbRed: 0.192, green: 0.204, blue: 0.322, alpha: 1),
       NSColor(srgbRed: 0.569, green: 0.533, blue: 0.776, alpha: 1),
       NSColor(srgbRed: 0.902, green: 0.780, blue: 0.937, alpha: 1)),
      (NSColor(srgbRed: 0.137, green: 0.341, blue: 0.373, alpha: 1),
       NSColor(srgbRed: 0.604, green: 0.804, blue: 0.800, alpha: 1),
       NSColor(srgbRed: 0.890, green: 0.914, blue: 0.776, alpha: 1))
    ]
    let pair = palettes[abs(seedIndex) % palettes.count]
    let space = CGColorSpaceCreateDeviceRGB()
    if let grad = CGGradient(colorsSpace: space, colors: [pair.0.cgColor, pair.1.cgColor] as CFArray, locations: [0, 1]) {
      ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: bounds.maxY), end: CGPoint(x: bounds.maxX, y: 0), options: [])
    }
    let glowCenter = CGPoint(x: bounds.width * 0.66, y: bounds.height * 0.68)
    if let rad = CGGradient(colorsSpace: space, colors: [pair.2.withAlphaComponent(0.75).cgColor, pair.1.withAlphaComponent(0).cgColor] as CFArray, locations: [0, 1]) {
      ctx.drawRadialGradient(rad, startCenter: glowCenter, startRadius: 0, endCenter: glowCenter, endRadius: bounds.width * 0.48, options: [])
    }

    let cx = bounds.midX
    let cy = bounds.midY
    let unit = min(bounds.width, bounds.height) / 220.0
    ctx.setStrokeColor(pair.2.withAlphaComponent(0.55).cgColor)
    ctx.setLineWidth(max(0.65, unit * 0.8))
    for j in 0..<14 {
      ctx.saveGState()
      ctx.translateBy(x: cx, y: cy)
      ctx.rotate(by: CGFloat(j * 9 + seedIndex * 22) * .pi / 180.0)
      let rx = CGFloat(28 + j * 5) * unit
      let ry = CGFloat(13 + j * 3) * unit
      ctx.strokeEllipse(in: CGRect(x: -rx, y: -ry, width: rx * 2, height: ry * 2))
      ctx.restoreGState()
    }
    let orbR = 17 * unit
    ctx.setFillColor(pair.2.withAlphaComponent(0.82).cgColor)
    ctx.fillEllipse(in: CGRect(x: cx - orbR, y: cy - orbR, width: orbR * 2, height: orbR * 2))

    let attrs: [NSAttributedString.Key: Any] = [
      .font: NSFont.monospacedSystemFont(ofSize: max(8.5, 10 * unit), weight: .semibold),
      .foregroundColor: NSColor.white.withAlphaComponent(0.88),
      .kern: 2.2
    ]
    NSAttributedString(string: badgeText, attributes: attrs).draw(at: NSPoint(x: 12 * unit, y: 12 * unit))
  }
}

/// Pure Swift/AppKit syntax highlighter returning styled `NSAttributedString` (no HTML/WebView).
/// Supports distinct lexical rules & palettes for JS/TS/Go/PHP/Python/JSON/CSS/HTML/SVG/Markdown plus
/// Rust, SQL, Shell (sh/zsh/fish), YAML, XML, Java, C, C++, C#, Ruby, Swift, Kotlin, Dart, Lua,
/// TOML, INI, Dockerfile, Makefile, GraphQL, and Diff. Unknown languages remain strictly neutral (§18.2, A29, A59).
enum LumenSyntaxHighlighter {
  private static let keywordsByLang: [String: Set<String>] = [
    "js": Set("async function await return const let var new if else for while do class extends super import export default from throw try catch finally true false null undefined switch case break continue typeof instanceof in of yield".split(separator: " ").map(String.init)),
    "jsx": Set("async function await return const let var new if else for while class extends import export default from throw try catch true false null undefined switch case break continue".split(separator: " ").map(String.init)),
    "ts": Set("async function await return const let var new if else for while class import export default from type interface extends implements readonly public private protected abstract enum namespace declare keyof infer as is true false null undefined string number boolean void never unknown any".split(separator: " ").map(String.init)),
    "tsx": Set("async function await return const let var new if else for while class import export default from type interface extends implements readonly public private protected enum keyof as true false null undefined string number boolean void".split(separator: " ").map(String.init)),
    "go": Set("package import func return if else for range var const type struct interface defer go select switch case default break continue fallthrough goto nil true false error map chan make len cap append copy delete new".split(separator: " ").map(String.init)),
    "swift": Set("import func return if else guard let var struct class actor final enum protocol extension private fileprivate public internal open static override mutating nonmutating init deinit self Self super true false nil switch case default break continue where throw throws rethrows try catch async await in weak unowned lazy convenience required typealias associatedtype".split(separator: " ").map(String.init)),
    "php": Set("namespace use final abstract class interface trait extends implements public private protected function fn return new if elseif else foreach for while do switch case break continue static true false null echo print throw try catch finally match readonly".split(separator: " ").map(String.init)),
    "py": Set("from import as def async await return class if elif else for in while with try except finally raise True False None pass break continue yield lambda and or not is del global nonlocal assert match case".split(separator: " ").map(String.init)),
    "rs": Set("fn let mut const static pub struct enum union impl trait type for in while loop if else match return break continue use mod crate super self Self true false Some None Ok Err async await unsafe extern dyn where move ref as Box Vec String Result Option".split(separator: " ").map(String.init)),
    "sql": Set("SELECT DISTINCT FROM WHERE JOIN LEFT RIGHT INNER OUTER FULL CROSS ON USING GROUP BY ORDER HAVING LIMIT OFFSET FETCH INSERT INTO VALUES UPDATE SET DELETE CREATE ALTER DROP TABLE INDEX VIEW TRIGGER PROCEDURE FUNCTION DATABASE SCHEMA AS AND OR NOT IN EXISTS BETWEEN LIKE ILIKE IS NULL TRUE FALSE DESC ASC COUNT SUM AVG MIN MAX CASE WHEN THEN ELSE END UNION ALL PRIMARY KEY FOREIGN REFERENCES CONSTRAINT DEFAULT UNIQUE CHECK".split(separator: " ").map(String.init)),
    "sh": Set("if then else elif fi for do done while until in function export local readonly declare typeset echo printf read exit return set unset trap shift case esac break continue source eval exec test true false".split(separator: " ").map(String.init)),
    "zsh": Set("if then else elif fi for foreach do done while until in function export local typeset autoload zmodload echo print printf exit return set setopt unsetopt case esac break continue source true false".split(separator: " ").map(String.init)),
    "fish": Set("if else end for in while function set set_color echo printf return switch case begin break continue and or not status string test true false".split(separator: " ").map(String.init)),
    "yaml": Set("true false null yes no on off y n ~".split(separator: " ").map(String.init)),
    "json": Set(["true", "false", "null"]),
    "css": Set("important inherit initial unset none auto flex grid block inline inline-block solid dashed relative absolute fixed sticky hidden visible center space-between".split(separator: " ").map(String.init)),
    "java": Set("package import public private protected class interface enum record abstract final static synchronized volatile transient native strictfp void new return if else for while do switch case default break continue try catch finally throw throws extends implements this super instanceof boolean byte char short int long float double String var true false null".split(separator: " ").map(String.init)),
    "cpp": Set("include define ifdef ifndef endif pragma int char short long float double void bool auto const constexpr consteval mutable static extern inline virtual override final explicit friend template typename class struct union enum namespace using std public private protected return if else for while do switch case default break continue try catch throw new delete sizeof alignof decltype noexcept static_cast dynamic_cast reinterpret_cast const_cast true false nullptr this".split(separator: " ").map(String.init)),
    "c": Set("include define ifdef ifndef endif pragma int char short long float double void signed unsigned const volatile static extern register inline struct union enum typedef return if else for while do switch case default break continue goto sizeof _Bool _Atomic NULL true false".split(separator: " ").map(String.init)),
    "cs": Set("using namespace class struct interface record enum delegate event public private protected internal static readonly const sealed abstract virtual override partial async await return var dynamic object string char int long float double decimal bool void new if else for foreach while do switch case default break continue try catch finally throw get set init value yield ref out in is as typeof nameof sizeof true false null this base".split(separator: " ").map(String.init)),
    "rb": Set("def end class module require require_relative include extend prepend attr_reader attr_writer attr_accessor puts print raise begin rescue ensure retry if elsif else unless case when while until for in do yield return break next redo super self nil true false and or not private protected public".split(separator: " ").map(String.init)),
    "kt": Set("package import fun val var class data sealed inner enum object companion interface abstract open final override private protected internal public suspend inline noinline crossinline reified lateinit const return if else when for while do try catch finally throw is as in out by where this super true false null Unit Nothing Any".split(separator: " ").map(String.init)),
    "dart": Set("import export part library show hide deferred as class mixin extension enum abstract sealed base final interface const var late dynamic void Function Future Stream async await sync yield return if else for in while do switch case default break continue try on catch finally rethrow throw new this super extends implements with required factory get set operator true false null".split(separator: " ").map(String.init)),
    "lua": Set("local function end if then else elseif for in do while repeat until break goto return nil true false and or not self".split(separator: " ").map(String.init)),
    "toml": Set(["true", "false"]),
    "ini": Set(["true", "false", "yes", "no", "on", "off"]),
    "docker": Set("FROM RUN CMD LABEL MAINTAINER EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS".split(separator: " ").map(String.init)),
    "make": Set("ifeq ifneq ifdef ifndef else endif include sinclude define endef undefine export unexport override private vpath".split(separator: " ").map(String.init)),
    "graphql": Set("query mutation subscription fragment on type interface union enum input scalar extend implements directive schema repeatable true false null".split(separator: " ").map(String.init))
  ]

  private static let tokenRegex: NSRegularExpression? = try? NSRegularExpression(
    pattern: #"(\/\/[^\n]*|\/\*[\s\S]*?\*\/|--\[\[[\s\S]*?\]\]|--[^\n]*|#[^\n]*|;[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|@[A-Za-z_]\w*|\$\{?[A-Za-z_]\w*\}?|\$\([A-Za-z0-9_.-]+\)|:[A-Za-z_]\w*\b|\b0x[0-9A-Fa-f]+\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)"#,
    options: []
  )

  private static let markupRegex: NSRegularExpression? = try? NSRegularExpression(
    pattern: #"(<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z][\w:-]*|\/?>|"[^"\n]*"|'[^'\n]*'|\b[A-Za-z_][\w:-]*(?=\s*=))"#,
    options: []
  )

  private static let sectionHeaderRegex: NSRegularExpression? = try? NSRegularExpression(
    pattern: #"^\s*\[{1,2}[^\]\n]+\]{1,2}"#,
    options: [.anchorsMatchLines]
  )

  private static let yamlKeyRegex: NSRegularExpression? = try? NSRegularExpression(
    pattern: #"^(\s*-?\s*)([A-Za-z0-9_.-]+)(?=\s*:)"#,
    options: [.anchorsMatchLines]
  )

  private static let kvKeyRegex: NSRegularExpression? = try? NSRegularExpression(
    pattern: #"^(\s*)([A-Za-z0-9_.-]+)(?=\s*=)"#,
    options: [.anchorsMatchLines]
  )

  private static let makeTargetRegex: NSRegularExpression? = try? NSRegularExpression(
    pattern: #"^([A-Za-z0-9_./%-]+|\.[A-Z]+)(?=\s*:(?!=))"#,
    options: [.anchorsMatchLines]
  )

  private static let cPreprocessorRegex: NSRegularExpression? = try? NSRegularExpression(
    pattern: #"^\s*#\s*(?:include|define|undef|ifdef|ifndef|if|elif|else|endif|pragma|error|warning)\b"#,
    options: [.anchorsMatchLines]
  )

  static func highlight(_ source: String, language: String, fontSize: CGFloat = 12.5, darkCanvas: Bool = true, lineHeightMultiple: CGFloat = 1.48) -> NSAttributedString {
    let clamped = source.count > 48_000 ? String(source.prefix(48_000)) + "\n… (已截断)" : source
    let lang = LumenContentIdentityRegistry.shared.normalizeLanguageID(language)
    let font = NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
    let baseColor = darkCanvas
      ? NSColor(srgbRed: 0.859, green: 0.902, blue: 0.976, alpha: 1.0)
      : NSColor(srgbRed: 0.165, green: 0.212, blue: 0.302, alpha: 1.0)

    let paragraph = NSMutableParagraphStyle()
    paragraph.lineHeightMultiple = lineHeightMultiple

    let attributed = NSMutableAttributedString(
      string: clamped,
      attributes: [
        .font: font,
        .foregroundColor: baseColor,
        .paragraphStyle: paragraph,
        .ligature: 0
      ]
    )

    // Unknown language stays strictly neutral — never apply JavaScript highlighting (§18.2, A29, A59).
    if lang == "unknown" {
      return attributed
    }

    let nsText = clamped as NSString
    let fullRange = NSRange(location: 0, length: nsText.length)

    let commentColor = darkCanvas
      ? NSColor(srgbRed: 0.471, green: 0.541, blue: 0.651, alpha: 1)
      : NSColor(srgbRed: 0.510, green: 0.576, blue: 0.647, alpha: 1)
    let stringColor = darkCanvas
      ? NSColor(srgbRed: 0.651, green: 0.851, blue: 0.608, alpha: 1)
      : NSColor(srgbRed: 0.271, green: 0.584, blue: 0.408, alpha: 1)
    let numberColor = darkCanvas
      ? NSColor(srgbRed: 0.953, green: 0.745, blue: 0.525, alpha: 1)
      : NSColor(srgbRed: 0.776, green: 0.545, blue: 0.310, alpha: 1)
    let varColor = darkCanvas
      ? NSColor(srgbRed: 0.922, green: 0.569, blue: 0.678, alpha: 1)
      : NSColor(srgbRed: 0.741, green: 0.325, blue: 0.471, alpha: 1)
    let funcColor = darkCanvas
      ? NSColor(srgbRed: 0.522, green: 0.784, blue: 0.941, alpha: 1)
      : NSColor(srgbRed: 0.231, green: 0.510, blue: 0.741, alpha: 1)
    let kwColor = keywordAccentColor(for: lang, darkCanvas: darkCanvas)

    // Special line-oriented diff highlighting (additions / deletions / hunks / headers)
    if lang == "diff" {
      highlightDiff(clamped, into: attributed, darkCanvas: darkCanvas, font: font)
      return attributed
    }

    // XML / HTML / SVG markup mode
    if lang == "html" || lang == "svg" || lang == "xml" {
      markupRegex?.enumerateMatches(in: clamped, options: [], range: fullRange) { match, _, _ in
        guard let match else { return }
        let range = match.range
        let token = nsText.substring(with: range)
        if token.hasPrefix("<!--") {
          attributed.addAttribute(.foregroundColor, value: commentColor, range: range)
        } else if token.hasPrefix("<![CDATA[") {
          attributed.addAttribute(.foregroundColor, value: stringColor, range: range)
        } else if token.hasPrefix("<?") {
          attributed.addAttribute(.foregroundColor, value: numberColor, range: range)
        } else if token.hasPrefix("\"") || token.hasPrefix("'") {
          attributed.addAttribute(.foregroundColor, value: stringColor, range: range)
        } else if token.hasPrefix("<") || token.hasSuffix(">") {
          attributed.addAttribute(.foregroundColor, value: kwColor, range: range)
        } else {
          attributed.addAttribute(.foregroundColor, value: funcColor, range: range)
        }
      }
      return attributed
    }

    // Structural pre-passes for YAML keys, TOML/INI sections & keys, Makefile targets, C/C++ preprocessor
    if lang == "yaml" {
      yamlKeyRegex?.enumerateMatches(in: clamped, options: [], range: fullRange) { match, _, _ in
        guard let match, match.numberOfRanges >= 3 else { return }
        attributed.addAttribute(.foregroundColor, value: funcColor, range: match.range(at: 2))
      }
    } else if lang == "toml" || lang == "ini" {
      sectionHeaderRegex?.enumerateMatches(in: clamped, options: [], range: fullRange) { match, _, _ in
        guard let match else { return }
        attributed.addAttribute(.foregroundColor, value: kwColor, range: match.range)
      }
      kvKeyRegex?.enumerateMatches(in: clamped, options: [], range: fullRange) { match, _, _ in
        guard let match, match.numberOfRanges >= 3 else { return }
        attributed.addAttribute(.foregroundColor, value: funcColor, range: match.range(at: 2))
      }
    } else if lang == "make" {
      makeTargetRegex?.enumerateMatches(in: clamped, options: [], range: fullRange) { match, _, _ in
        guard let match else { return }
        attributed.addAttribute(.foregroundColor, value: funcColor, range: match.range)
      }
    } else if lang == "c" || lang == "cpp" {
      cPreprocessorRegex?.enumerateMatches(in: clamped, options: [], range: fullRange) { match, _, _ in
        guard let match else { return }
        attributed.addAttribute(.foregroundColor, value: kwColor, range: match.range)
      }
    }

    guard let regex = tokenRegex else { return attributed }
    let keywords = keywordsByLang[lang] ?? []
    let hashCommentLangs: Set<String> = ["py", "sh", "zsh", "fish", "yaml", "rb", "toml", "ini", "docker", "make", "graphql", "r", "pl"]
    let slashCommentLangs: Set<String> = ["js", "jsx", "ts", "tsx", "go", "php", "rs", "java", "c", "cpp", "cs", "swift", "kt", "dart", "css"]
    let dashCommentLangs: Set<String> = ["sql", "lua"]
    let semicolonCommentLangs: Set<String> = ["ini"]
    let caseInsensitiveKWLangs: Set<String> = ["sql", "docker", "yaml", "ini"]

    regex.enumerateMatches(in: clamped, options: [], range: fullRange) { match, _, _ in
      guard let match else { return }
      let range = match.range
      let token = nsText.substring(with: range)

      if (slashCommentLangs.contains(lang) && (token.hasPrefix("//") || token.hasPrefix("/*")))
        || (lang == "sql" && token.hasPrefix("/*"))
        || (dashCommentLangs.contains(lang) && token.hasPrefix("--"))
        || (hashCommentLangs.contains(lang) && token.hasPrefix("#"))
        || (semicolonCommentLangs.contains(lang) && token.hasPrefix(";")) {
        attributed.addAttribute(.foregroundColor, value: commentColor, range: range)
      } else if token.hasPrefix("\"") || token.hasPrefix("'") || token.hasPrefix("`") {
        attributed.addAttribute(.foregroundColor, value: stringColor, range: range)
      } else if token.hasPrefix("$") {
        attributed.addAttribute(.foregroundColor, value: varColor, range: range)
      } else if token.hasPrefix("@") {
        // Decorators / Annotations / GraphQL directives (@Override, @objc, @deprecated)
        attributed.addAttribute(.foregroundColor, value: numberColor, range: range)
      } else if lang == "rb" && token.hasPrefix(":") {
        attributed.addAttribute(.foregroundColor, value: varColor, range: range)
      } else if let first = token.first, first.isNumber {
        attributed.addAttribute(.foregroundColor, value: numberColor, range: range)
      } else if keywords.contains(token)
        || (caseInsensitiveKWLangs.contains(lang) && (keywords.contains(token.uppercased()) || keywords.contains(token.lowercased()))) {
        attributed.addAttribute(.foregroundColor, value: kwColor, range: range)
      } else if range.upperBound < nsText.length, !["yaml", "toml", "ini"].contains(lang) {
        let nextChar = nsText.character(at: range.upperBound)
        if nextChar == 40 { // '('
          attributed.addAttribute(.foregroundColor, value: funcColor, range: range)
        }
      }
    }

    return attributed
  }

  private static func keywordAccentColor(for lang: String, darkCanvas: Bool) -> NSColor {
    switch lang {
    case "go", "dart", "docker":
      return darkCanvas ? NSColor(srgbRed: 0.420, green: 0.855, blue: 0.839, alpha: 1) : NSColor(srgbRed: 0.196, green: 0.529, blue: 0.678, alpha: 1)
    case "py", "toml":
      return darkCanvas ? NSColor(srgbRed: 0.945, green: 0.729, blue: 0.553, alpha: 1) : NSColor(srgbRed: 0.690, green: 0.478, blue: 0.192, alpha: 1)
    case "rs", "swift", "java", "html", "xml":
      return darkCanvas ? NSColor(srgbRed: 0.937, green: 0.675, blue: 0.533, alpha: 1) : NSColor(srgbRed: 0.714, green: 0.420, blue: 0.278, alpha: 1)
    case "sh", "zsh", "fish", "make":
      return darkCanvas ? NSColor(srgbRed: 0.486, green: 0.855, blue: 0.706, alpha: 1) : NSColor(srgbRed: 0.180, green: 0.545, blue: 0.431, alpha: 1)
    case "rb", "yaml", "graphql":
      return darkCanvas ? NSColor(srgbRed: 0.945, green: 0.584, blue: 0.725, alpha: 1) : NSColor(srgbRed: 0.725, green: 0.275, blue: 0.467, alpha: 1)
    case "c", "cpp", "cs", "lua":
      return darkCanvas ? NSColor(srgbRed: 0.569, green: 0.761, blue: 1.0, alpha: 1) : NSColor(srgbRed: 0.275, green: 0.451, blue: 0.761, alpha: 1)
    default:
      return darkCanvas ? NSColor(srgbRed: 0.776, green: 0.647, blue: 1.0, alpha: 1) : NSColor(srgbRed: 0.549, green: 0.416, blue: 0.780, alpha: 1)
    }
  }

  private static func highlightDiff(_ source: String, into attributed: NSMutableAttributedString, darkCanvas: Bool, font: NSFont) {
    let addedFg = darkCanvas ? NSColor(srgbRed: 0.576, green: 0.894, blue: 0.663, alpha: 1) : NSColor(srgbRed: 0.125, green: 0.498, blue: 0.243, alpha: 1)
    let addedBg = darkCanvas ? NSColor(srgbRed: 0.180, green: 0.480, blue: 0.290, alpha: 0.22) : NSColor(srgbRed: 0.200, green: 0.720, blue: 0.360, alpha: 0.14)
    let removedFg = darkCanvas ? NSColor(srgbRed: 0.969, green: 0.584, blue: 0.620, alpha: 1) : NSColor(srgbRed: 0.722, green: 0.173, blue: 0.239, alpha: 1)
    let removedBg = darkCanvas ? NSColor(srgbRed: 0.620, green: 0.200, blue: 0.250, alpha: 0.22) : NSColor(srgbRed: 0.850, green: 0.240, blue: 0.300, alpha: 0.12)
    let hunkFg = darkCanvas ? NSColor(srgbRed: 0.549, green: 0.796, blue: 0.980, alpha: 1) : NSColor(srgbRed: 0.220, green: 0.451, blue: 0.761, alpha: 1)
    let headerFg = darkCanvas ? NSColor(srgbRed: 0.953, green: 0.784, blue: 0.525, alpha: 1) : NSColor(srgbRed: 0.678, green: 0.443, blue: 0.153, alpha: 1)
    let boldFont = NSFont.monospacedSystemFont(ofSize: font.pointSize, weight: .semibold)

    let ns = source as NSString
    var pos = 0
    while pos < ns.length {
      let lineRange = ns.lineRange(for: NSRange(location: pos, length: 0))
      let line = ns.substring(with: lineRange)
      if line.hasPrefix("diff ") || line.hasPrefix("index ") || line.hasPrefix("+++ ") || line.hasPrefix("--- ") {
        attributed.addAttributes([.foregroundColor: headerFg, .font: boldFont], range: lineRange)
      } else if line.hasPrefix("@@") {
        attributed.addAttributes([.foregroundColor: hunkFg, .font: boldFont], range: lineRange)
      } else if line.hasPrefix("+") {
        attributed.addAttributes([.foregroundColor: addedFg, .backgroundColor: addedBg], range: lineRange)
      } else if line.hasPrefix("-") {
        attributed.addAttributes([.foregroundColor: removedFg, .backgroundColor: removedBg], range: lineRange)
      }
      pos = lineRange.upperBound
    }
  }
}
