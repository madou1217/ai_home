import AppKit
import CoreGraphics
import Foundation

/// Centralized motion preference check honoring both app preference and macOS Reduce Motion.
enum LumenMotion {
  static var isEnabled: Bool {
    LumenClipboardStore.shared.preferences.motion && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
  }

  static var enterDuration: TimeInterval { isEnabled ? 0.38 : 0.01 }
  static var exitDuration: TimeInterval { isEnabled ? 0.22 : 0.01 }
  static var switchDuration: TimeInterval { isEnabled ? 0.28 : 0.01 }
  static var removeDuration: TimeInterval { isEnabled ? 0.34 : 0.01 }
  static var hoverDuration: TimeInterval { isEnabled ? 0.20 : 0.01 }
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
  let orbitCardSelectedBorder: NSColor
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
    muted: NSColor(srgbRed: 0.478, green: 0.506, blue: 0.565, alpha: 1.0),
    accent: NSColor(srgbRed: 0.329, green: 0.427, blue: 0.882, alpha: 1.0),
    accentSoft: NSColor(srgbRed: 0.506, green: 0.580, blue: 0.882, alpha: 0.16),
    accentBorder: NSColor(srgbRed: 0.506, green: 0.580, blue: 0.882, alpha: 0.42),
    danger: NSColor(srgbRed: 0.788, green: 0.337, blue: 0.404, alpha: 1.0),
    dangerSoft: NSColor(srgbRed: 0.831, green: 0.404, blue: 0.467, alpha: 0.12),
    success: NSColor(srgbRed: 0.369, green: 0.710, blue: 0.584, alpha: 1.0),
    warning: NSColor(srgbRed: 0.875, green: 0.643, blue: 0.294, alpha: 1.0),

    orbitBackdropTop: NSColor(srgbRed: 0.890, green: 0.945, blue: 0.996, alpha: 0.42),
    orbitBackdropBottom: NSColor(srgbRed: 0.620, green: 0.718, blue: 0.867, alpha: 0.56),
    orbitTopSheen: NSColor(srgbRed: 0.950, green: 0.985, blue: 1.0, alpha: 0.88),
    orbitCardTop: NSColor(srgbRed: 0.988, green: 0.992, blue: 1.0, alpha: 0.94),
    orbitCardBottom: NSColor(srgbRed: 0.875, green: 0.914, blue: 0.969, alpha: 0.90),
    orbitCardBorder: NSColor(srgbRed: 1.0, green: 1.0, blue: 1.0, alpha: 0.65),
    orbitCardSelectedBorder: NSColor(srgbRed: 1.0, green: 1.0, blue: 1.0, alpha: 0.98),
    orbitCardSelectedGlow: NSColor(srgbRed: 0.690, green: 0.847, blue: 1.0, alpha: 0.85),
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
    muted: NSColor(srgbRed: 0.553, green: 0.596, blue: 0.667, alpha: 1.0),
    accent: NSColor(srgbRed: 0.627, green: 0.690, blue: 1.0, alpha: 1.0),
    accentSoft: NSColor(srgbRed: 0.506, green: 0.584, blue: 0.902, alpha: 0.20),
    accentBorder: NSColor(srgbRed: 0.569, green: 0.659, blue: 0.969, alpha: 0.46),
    danger: NSColor(srgbRed: 0.961, green: 0.596, blue: 0.678, alpha: 1.0),
    dangerSoft: NSColor(srgbRed: 0.831, green: 0.404, blue: 0.467, alpha: 0.18),
    success: NSColor(srgbRed: 0.431, green: 0.796, blue: 0.659, alpha: 1.0),
    warning: NSColor(srgbRed: 0.945, green: 0.725, blue: 0.388, alpha: 1.0),

    orbitBackdropTop: NSColor(srgbRed: 0.082, green: 0.165, blue: 0.278, alpha: 0.66),
    orbitBackdropBottom: NSColor(srgbRed: 0.063, green: 0.114, blue: 0.212, alpha: 0.82),
    orbitTopSheen: NSColor(srgbRed: 0.761, green: 0.871, blue: 1.0, alpha: 0.70),
    orbitCardTop: NSColor(srgbRed: 0.220, green: 0.298, blue: 0.420, alpha: 0.88),
    orbitCardBottom: NSColor(srgbRed: 0.125, green: 0.192, blue: 0.294, alpha: 0.90),
    orbitCardBorder: NSColor(srgbRed: 0.647, green: 0.765, blue: 0.929, alpha: 0.32),
    orbitCardSelectedBorder: NSColor(srgbRed: 0.812, green: 0.922, blue: 1.0, alpha: 0.96),
    orbitCardSelectedGlow: NSColor(srgbRed: 0.631, green: 0.792, blue: 1.0, alpha: 0.70),
    orbitKeyBadgeBackground: NSColor(srgbRed: 0.667, green: 0.769, blue: 1.0, alpha: 0.14),
    orbitKeyBadgeText: NSColor(srgbRed: 0.722, green: 0.800, blue: 0.922, alpha: 1.0),
    orbitKeyBadgeSelectedBackground: NSColor(srgbRed: 0.459, green: 0.588, blue: 0.855, alpha: 1.0),

    codeBackground: NSColor(srgbRed: 0.082, green: 0.110, blue: 0.173, alpha: 1.0),
    codeToolbarBackground: NSColor(srgbRed: 0.125, green: 0.165, blue: 0.235, alpha: 1.0),
    codeGutterText: NSColor(srgbRed: 0.412, green: 0.478, blue: 0.580, alpha: 1.0),
    codeBaseText: NSColor(srgbRed: 0.859, green: 0.902, blue: 0.976, alpha: 1.0)
  )

  func categoryTint(_ category: LumenDisplayCategory) -> NSColor {
    switch category {
    case .text: return isDark ? NSColor(srgbRed: 0.635, green: 0.675, blue: 0.886, alpha: 1) : NSColor(srgbRed: 0.478, green: 0.510, blue: 0.690, alpha: 1)
    case .code: return isDark ? NSColor(srgbRed: 0.569, green: 0.749, blue: 0.980, alpha: 1) : NSColor(srgbRed: 0.357, green: 0.533, blue: 0.808, alpha: 1)
    case .image: return isDark ? NSColor(srgbRed: 0.765, green: 0.663, blue: 0.976, alpha: 1) : NSColor(srgbRed: 0.569, green: 0.467, blue: 0.796, alpha: 1)
    case .link: return isDark ? NSColor(srgbRed: 0.467, green: 0.816, blue: 0.816, alpha: 1) : NSColor(srgbRed: 0.302, green: 0.596, blue: 0.608, alpha: 1)
    case .color: return isDark ? NSColor(srgbRed: 0.937, green: 0.643, blue: 0.765, alpha: 1) : NSColor(srgbRed: 0.773, green: 0.427, blue: 0.576, alpha: 1)
    case .file: return isDark ? NSColor(srgbRed: 0.898, green: 0.753, blue: 0.518, alpha: 1) : NSColor(srgbRed: 0.690, green: 0.549, blue: 0.341, alpha: 1)
    }
  }

  func sourceBadgeColor(for source: String) -> NSColor {
    let lower = source.lowercased()
    if lower.contains("code") || lower.contains("xcode") || lower.contains("cursor") {
      return NSColor(srgbRed: 0.337, green: 0.541, blue: 0.792, alpha: 1)
    }
    if lower.contains("figma") || lower.contains("sketch") || lower.contains("preview") {
      return NSColor(srgbRed: 0.612, green: 0.514, blue: 0.776, alpha: 1)
    }
    if lower.contains("chrome") || lower.contains("safari") || lower.contains("arc") || lower.contains("firefox") {
      return NSColor(srgbRed: 0.412, green: 0.620, blue: 0.569, alpha: 1)
    }
    if lower.contains("finder") {
      return NSColor(srgbRed: 0.482, green: 0.620, blue: 0.812, alpha: 1)
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
enum LumenSyntaxHighlighter {
  private static let keywordsByLang: [String: Set<String>] = [
    "js": Set("async function await return const let var new if else for while class import export from throw try catch true false null undefined switch case break continue".split(separator: " ").map(String.init)),
    "ts": Set("async function await return const let var new if else for while class import export from type interface extends implements readonly public private protected true false null string number boolean void".split(separator: " ").map(String.init)),
    "go": Set("package import func return if else for range var const type struct interface defer go select switch case default nil true false error map chan make len cap".split(separator: " ").map(String.init)),
    "swift": Set("import func return if else guard let var struct class final enum protocol extension private fileprivate public internal static override init deinit self Self true false nil switch case break continue where throw throws try catch async await in".split(separator: " ").map(String.init)),
    "php": Set("namespace use final class extends implements public private protected function return new if else foreach for while static true false null echo throw try catch".split(separator: " ").map(String.init)),
    "py": Set("from import as def async await return class if elif else for in while with try except finally raise True False None pass yield lambda and or not".split(separator: " ").map(String.init)),
    "rust": Set("fn let mut pub struct enum impl trait for in while loop if else match return use mod crate self Self true false Some None Ok Err async await".split(separator: " ").map(String.init)),
    "sql": Set("SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER LIMIT INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER DROP AS AND OR NOT IN IS NULL".split(separator: " ").map(String.init)),
    "json": Set(["true", "false", "null"]),
    "css": Set(["important", "inherit", "initial", "unset", "none", "auto", "flex", "grid"])
  ]

  private static let tokenRegex: NSRegularExpression? = try? NSRegularExpression(
    pattern: #"(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\$[A-Za-z_]\w*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)"#,
    options: []
  )

  static func highlight(_ source: String, language: String, fontSize: CGFloat = 12.5, darkCanvas: Bool = true) -> NSAttributedString {
    let clamped = source.count > 48_000 ? String(source.prefix(48_000)) + "\n… (已截断)" : source
    let lang = language.lowercased()
    let font = NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
    let baseColor = darkCanvas
      ? NSColor(srgbRed: 0.859, green: 0.902, blue: 0.976, alpha: 1.0)
      : NSColor(srgbRed: 0.165, green: 0.212, blue: 0.302, alpha: 1.0)

    let paragraph = NSMutableParagraphStyle()
    paragraph.lineHeightMultiple = 1.45

    let attributed = NSMutableAttributedString(
      string: clamped,
      attributes: [
        .font: font,
        .foregroundColor: baseColor,
        .paragraphStyle: paragraph
      ]
    )

    guard let regex = tokenRegex else { return attributed }
    let nsText = clamped as NSString
    let fullRange = NSRange(location: 0, length: nsText.length)
    let keywords = keywordsByLang[lang] ?? keywordsByLang["js"] ?? []

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
    let kwColor: NSColor
    switch lang {
    case "go":
      kwColor = darkCanvas ? NSColor(srgbRed: 0.502, green: 0.863, blue: 0.949, alpha: 1) : NSColor(srgbRed: 0.196, green: 0.529, blue: 0.678, alpha: 1)
    case "py":
      kwColor = darkCanvas ? NSColor(srgbRed: 0.949, green: 0.769, blue: 0.471, alpha: 1) : NSColor(srgbRed: 0.690, green: 0.478, blue: 0.192, alpha: 1)
    default:
      kwColor = darkCanvas ? NSColor(srgbRed: 0.776, green: 0.647, blue: 1.0, alpha: 1) : NSColor(srgbRed: 0.549, green: 0.416, blue: 0.780, alpha: 1)
    }

    regex.enumerateMatches(in: clamped, options: [], range: fullRange) { match, _, _ in
      guard let match else { return }
      let range = match.range
      let token = nsText.substring(with: range)
      if token.hasPrefix("//") || token.hasPrefix("/*") || ((lang == "py" || lang == "sh" || lang == "yaml") && token.hasPrefix("#")) {
        attributed.addAttribute(.foregroundColor, value: commentColor, range: range)
      } else if token.hasPrefix("\"") || token.hasPrefix("'") || token.hasPrefix("`") {
        attributed.addAttribute(.foregroundColor, value: stringColor, range: range)
      } else if token.hasPrefix("$") {
        attributed.addAttribute(.foregroundColor, value: varColor, range: range)
      } else if let first = token.first, first.isNumber {
        attributed.addAttribute(.foregroundColor, value: numberColor, range: range)
      } else if keywords.contains(token) || (lang == "sql" && keywords.contains(token.uppercased())) {
        attributed.addAttribute(.foregroundColor, value: kwColor, range: range)
      } else if range.upperBound < nsText.length {
        let nextChar = nsText.character(at: range.upperBound)
        if nextChar == 40 { // '('
          attributed.addAttribute(.foregroundColor, value: funcColor, range: range)
        }
      }
    }

    return attributed
  }
}
