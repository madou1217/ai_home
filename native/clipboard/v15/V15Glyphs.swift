import AppKit
import CoreGraphics
import Foundation

// MARK: - V15 Operation & Semantic Content Glyphs (24×24 Optical Grid)

/// Operation icons extracted from `docs/design/v15/paste-lumen-v15.html` (`paths`, V11/V12/V15).
enum V15ActionGlyph: String {
  case closeX     // V15 `paths.remove`: M7.25 7.25 16.75 16.75 M16.75 7.25 7.25 16.75
  case pin        // V11 `paths.pin`
  case check      // `paths.check`
  case external   // V10 link external arrow
  case play       // video play triangle
  case lock       // encrypted archive lock
  case more       // unknown source fallback
  case logo       // Lumen brand mark
}

/// Pure CoreGraphics vector glyph renderer for Paste Lumen V15.
/// All paths follow the exact 24×24 SVG grid from `paste-lumen-v15.html` (`v14Type`, `v14Shapes`, `paths`).
/// Never delegates to legacy V7 view helpers or SF Symbols for product iconography.
enum V15Glyphs {
  private static let cache = NSCache<NSString, NSImage>()

  // MARK: Direct CGPath for GPU-Animated Close X (`CAShapeLayer`)

  /// Exact V15 Close X path in top-down (flipped) coordinate space of `size × size` DIP.
  /// Source: `README-Lumen-V15.md` §19.1 (`M7.25 7.25 16.75 16.75 M16.75 7.25 7.25 16.75`),
  /// `paste-lumen-v15.html` line 194 (`13 × 13`, `stroke-width: 1.9`, `stroke-linecap: round`).
  static func closeXPath(in size: CGFloat) -> CGPath {
    let scale = size / 24.0
    let path = CGMutablePath()
    path.move(to: CGPoint(x: 7.25 * scale, y: 7.25 * scale))
    path.addLine(to: CGPoint(x: 16.75 * scale, y: 16.75 * scale))
    path.move(to: CGPoint(x: 16.75 * scale, y: 7.25 * scale))
    path.addLine(to: CGPoint(x: 7.25 * scale, y: 16.75 * scale))
    return path
  }

  /// Scaled stroke width corresponding to `1.9` grid units in a 24×24 viewBox rendered at `size` DIP.
  static func closeXStrokeWidth(for size: CGFloat) -> CGFloat {
    V15Tokens.Close.glyphGridStrokeWidth * (size / 24.0)
  }

  // MARK: Action Glyph Image

  static func actionImage(
    _ glyph: V15ActionGlyph,
    size: CGFloat,
    color: NSColor,
    strokeWidth: CGFloat = 1.65
  ) -> NSImage {
    let key = "act:\(glyph.rawValue):\(Int(round(size * 10))):\(Int(round(strokeWidth * 100))):\(colorKey(color))" as NSString
    if let cached = cache.object(forKey: key) {
      return cached
    }
    let img = NSImage(size: NSSize(width: size, height: size), flipped: true) { _ in
      guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
      let s = size / 24.0
      ctx.saveGState()
      ctx.scaleBy(x: s, y: s)
      ctx.setStrokeColor(color.cgColor)
      ctx.setFillColor(color.cgColor)
      ctx.setLineWidth(strokeWidth)
      ctx.setLineCap(.round)
      ctx.setLineJoin(.round)
      drawAction(glyph, in: ctx, color: color)
      ctx.restoreGState()
      return true
    }
    cache.setObject(img, forKey: key)
    return img
  }

  // MARK: Semantic Identity Glyph Image (§18.2, `v14Type` / `v14Shapes` / `v14Lang`)

  static func identityTintColor(for identity: LumenContentIdentity, isDark: Bool) -> NSColor {
    let base = V15Color.hex(identity.lightColorHex)
    // Source: `paste-lumen-v15.html` line 180 `.dark .v14-glyph { color: color-mix(in srgb, var(--glyph) 77%, #e9f4ff) }`
    return isDark ? V15Color.mix(base, with: V15Color.hex("#e9f4ff"), ratio: 0.23) : base
  }

  static func identityImage(
    for identity: LumenContentIdentity,
    size: CGFloat,
    isDark: Bool,
    overrideColor: NSColor? = nil
  ) -> NSImage {
    let tint = overrideColor ?? identityTintColor(for: identity, isDark: isDark)
    let key = "id:\(identity.glyphID):\(identity.language ?? ""):\(Int(round(size * 10))):\(colorKey(tint))" as NSString
    if let cached = cache.object(forKey: key) {
      return cached
    }
    let img = NSImage(size: NSSize(width: size, height: size), flipped: true) { _ in
      guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
      let s = size / 24.0
      ctx.saveGState()
      ctx.scaleBy(x: s, y: s)
      ctx.setStrokeColor(tint.cgColor)
      ctx.setFillColor(tint.cgColor)
      ctx.setLineWidth(1.6) // Source: `paste-lumen-v15.html` line 706 `stroke-width="1.6"`
      ctx.setLineCap(.round)
      ctx.setLineJoin(.round)
      drawIdentity(identity, in: ctx, color: tint)
      ctx.restoreGState()
      return true
    }
    cache.setObject(img, forKey: key)
    return img
  }

  // MARK: Action Paths (24×24 Top-Down Grid)

  private static func drawAction(_ glyph: V15ActionGlyph, in ctx: CGContext, color: NSColor) {
    switch glyph {
    case .closeX:
      ctx.setLineWidth(V15Tokens.Close.glyphGridStrokeWidth)
      ctx.move(to: CGPoint(x: 7.25, y: 7.25))
      ctx.addLine(to: CGPoint(x: 16.75, y: 16.75))
      ctx.move(to: CGPoint(x: 16.75, y: 7.25))
      ctx.addLine(to: CGPoint(x: 7.25, y: 16.75))
      ctx.strokePath()

    case .pin:
      ctx.saveGState()
      ctx.translateBy(x: 1.2, y: 1.2)
      ctx.scaleBy(x: 0.9, y: 0.9)
      ctx.move(to: CGPoint(x: 14.7, y: 3.6))
      ctx.addLine(to: CGPoint(x: 20.4, y: 9.3))
      ctx.addLine(to: CGPoint(x: 16.8, y: 10.1))
      ctx.addLine(to: CGPoint(x: 13.7, y: 14.7))
      ctx.addLine(to: CGPoint(x: 11.6, y: 15.35))
      ctx.addLine(to: CGPoint(x: 8.6, y: 12.35))
      ctx.addLine(to: CGPoint(x: 5.6, y: 9.35))
      ctx.addLine(to: CGPoint(x: 6.25, y: 7.25))
      ctx.addLine(to: CGPoint(x: 10.85, y: 4.15))
      ctx.closePath()
      ctx.strokePath()
      ctx.restoreGState()
      ctx.move(to: CGPoint(x: 10.1, y: 13.9))
      ctx.addLine(to: CGPoint(x: 4.1, y: 19.9))
      ctx.strokePath()

    case .check:
      ctx.move(to: CGPoint(x: 5, y: 12))
      ctx.addLine(to: CGPoint(x: 9, y: 16))
      ctx.addLine(to: CGPoint(x: 19, y: 6))
      ctx.strokePath()

    case .external:
      ctx.move(to: CGPoint(x: 14, y: 5))
      ctx.addLine(to: CGPoint(x: 19, y: 5))
      ctx.addLine(to: CGPoint(x: 19, y: 10))
      ctx.move(to: CGPoint(x: 19, y: 5))
      ctx.addLine(to: CGPoint(x: 10, y: 14))
      ctx.move(to: CGPoint(x: 17, y: 13))
      ctx.addLine(to: CGPoint(x: 17, y: 18))
      ctx.addArc(tangent1End: CGPoint(x: 17, y: 19), tangent2End: CGPoint(x: 16, y: 19), radius: 1)
      ctx.addLine(to: CGPoint(x: 6, y: 19))
      ctx.addArc(tangent1End: CGPoint(x: 5, y: 19), tangent2End: CGPoint(x: 5, y: 18), radius: 1)
      ctx.addLine(to: CGPoint(x: 5, y: 8))
      ctx.addArc(tangent1End: CGPoint(x: 5, y: 7), tangent2End: CGPoint(x: 6, y: 7), radius: 1)
      ctx.addLine(to: CGPoint(x: 11, y: 7))
      ctx.strokePath()

    case .play:
      ctx.move(to: CGPoint(x: 9, y: 7.5))
      ctx.addLine(to: CGPoint(x: 17.5, y: 12))
      ctx.addLine(to: CGPoint(x: 9, y: 16.5))
      ctx.closePath()
      ctx.fillPath()

    case .lock:
      let body = CGPath(roundedRect: CGRect(x: 5, y: 11, width: 14, height: 9), cornerWidth: 2, cornerHeight: 2, transform: nil)
      ctx.addPath(body)
      ctx.move(to: CGPoint(x: 8, y: 11))
      ctx.addLine(to: CGPoint(x: 8, y: 8))
      ctx.addArc(center: CGPoint(x: 12, y: 8), radius: 4, startAngle: .pi, endAngle: 0, clockwise: false)
      ctx.addLine(to: CGPoint(x: 16, y: 11))
      ctx.strokePath()

    case .more:
      for cx in [6.0, 12.0, 18.0] {
        ctx.fillEllipse(in: CGRect(x: cx - 1.35, y: 12 - 1.35, width: 2.7, height: 2.7))
      }

    case .logo:
      ctx.move(to: CGPoint(x: 4, y: 13))
      ctx.addCurve(to: CGPoint(x: 13, y: 5), control1: CGPoint(x: 5, y: 8), control2: CGPoint(x: 9, y: 5))
      ctx.addCurve(to: CGPoint(x: 21, y: 11), control1: CGPoint(x: 18, y: 5), control2: CGPoint(x: 21, y: 8))
      ctx.addCurve(to: CGPoint(x: 11, y: 19), control1: CGPoint(x: 21, y: 16), control2: CGPoint(x: 16, y: 19))
      ctx.addCurve(to: CGPoint(x: 6, y: 16), control1: CGPoint(x: 8, y: 19), control2: CGPoint(x: 6, y: 18))
      ctx.addCurve(to: CGPoint(x: 13, y: 11), control1: CGPoint(x: 6, y: 13), control2: CGPoint(x: 10, y: 11))
      ctx.addCurve(to: CGPoint(x: 17, y: 14), control1: CGPoint(x: 15, y: 11), control2: CGPoint(x: 17, y: 12))
      ctx.move(to: CGPoint(x: 5, y: 17))
      ctx.addLine(to: CGPoint(x: 3, y: 20))
      ctx.move(to: CGPoint(x: 16, y: 5))
      ctx.addLine(to: CGPoint(x: 19, y: 3))
      ctx.strokePath()
    }
  }

  // MARK: Semantic Identity Paths (24×24 Top-Down Grid)

  private static func drawIdentity(_ identity: LumenContentIdentity, in ctx: CGContext, color: NSColor) {
    if identity.glyphID.hasPrefix("lang-") {
      let lang = String(identity.glyphID.dropFirst(5))
      drawLanguageGlyph(lang, in: ctx, color: color)
      return
    }
    switch identity.glyphID {
    case "text":
      // v14Type.text: M5 6h14 M12 6v13 M9 19h6 M5 6v3 m14-3v3
      ctx.move(to: CGPoint(x: 5, y: 6))
      ctx.addLine(to: CGPoint(x: 19, y: 6))
      ctx.move(to: CGPoint(x: 12, y: 6))
      ctx.addLine(to: CGPoint(x: 12, y: 19))
      ctx.move(to: CGPoint(x: 9, y: 19))
      ctx.addLine(to: CGPoint(x: 15, y: 19))
      ctx.move(to: CGPoint(x: 5, y: 6))
      ctx.addLine(to: CGPoint(x: 5, y: 9))
      ctx.move(to: CGPoint(x: 19, y: 6))
      ctx.addLine(to: CGPoint(x: 19, y: 9))
      ctx.strokePath()

    case "image":
      // v14Type.image
      ctx.addPath(CGPath(roundedRect: CGRect(x: 3.5, y: 4.5, width: 17, height: 15), cornerWidth: 3, cornerHeight: 3, transform: nil))
      ctx.strokePath()
      ctx.strokeEllipse(in: CGRect(x: 7.6, y: 7.6, width: 2.8, height: 2.8))
      ctx.move(to: CGPoint(x: 4, y: 17))
      ctx.addLine(to: CGPoint(x: 9, y: 13))
      ctx.addLine(to: CGPoint(x: 12, y: 16))
      ctx.addLine(to: CGPoint(x: 16, y: 11))
      ctx.addLine(to: CGPoint(x: 20, y: 16))
      ctx.strokePath()

    case "color":
      // v14Type.color
      ctx.move(to: CGPoint(x: 12, y: 3.7))
      ctx.addCurve(to: CGPoint(x: 18.6, y: 14.7), control1: CGPoint(x: 15.4, y: 8.5), control2: CGPoint(x: 18.6, y: 11.3))
      ctx.addArc(center: CGPoint(x: 12, y: 14.7), radius: 6.6, startAngle: 0, endAngle: .pi, clockwise: false)
      ctx.addCurve(to: CGPoint(x: 12, y: 3.7), control1: CGPoint(x: 5.4, y: 11.3), control2: CGPoint(x: 8.6, y: 8.5))
      ctx.closePath()
      ctx.move(to: CGPoint(x: 8.3, y: 15.5))
      ctx.addCurve(to: CGPoint(x: 10.8, y: 18.2), control1: CGPoint(x: 8.3, y: 17.0), control2: CGPoint(x: 9.3, y: 18.0))
      ctx.strokePath()

    case "link":
      // v14Type.link
      ctx.addPath(CGPath(roundedRect: CGRect(x: 3.5, y: 4, width: 17, height: 16), cornerWidth: 4, cornerHeight: 4, transform: nil))
      ctx.move(to: CGPoint(x: 4, y: 8.5))
      ctx.addLine(to: CGPoint(x: 20, y: 8.5))
      ctx.move(to: CGPoint(x: 10, y: 15.5))
      ctx.addLine(to: CGPoint(x: 15, y: 10.5))
      ctx.move(to: CGPoint(x: 11, y: 10.5))
      ctx.addLine(to: CGPoint(x: 15, y: 10.5))
      ctx.addLine(to: CGPoint(x: 15, y: 14.5))
      ctx.strokePath()
      ctx.fillEllipse(in: CGRect(x: 5.8, y: 5.6, width: 1.4, height: 1.4))

    case "pdf":
      // v14Type.pdf: folded page + PDF ribbon
      drawFoldedPage(in: ctx)
      ctx.saveGState()
      ctx.setLineWidth(1.25)
      ctx.move(to: CGPoint(x: 8.4, y: 16.5))
      ctx.addCurve(to: CGPoint(x: 16.0, y: 14.0), control1: CGPoint(x: 13.1, y: 15.5), control2: CGPoint(x: 16.0, y: 15.3))
      ctx.addCurve(to: CGPoint(x: 11.1, y: 16.6), control1: CGPoint(x: 16.0, y: 12.6), control2: CGPoint(x: 12.3, y: 14.4))
      ctx.addCurve(to: CGPoint(x: 9.8, y: 15.7), control1: CGPoint(x: 9.6, y: 19.4), control2: CGPoint(x: 7.7, y: 17.5))
      ctx.addCurve(to: CGPoint(x: 11.7, y: 8.0), control1: CGPoint(x: 11.8, y: 14.1), control2: CGPoint(x: 13.1, y: 7.9))
      ctx.addCurve(to: CGPoint(x: 14.9, y: 15.2), control1: CGPoint(x: 10.0, y: 8.1), control2: CGPoint(x: 11.0, y: 13.3))
      ctx.strokePath()
      ctx.restoreGState()

    case "doc":
      // v14Type.doc
      drawFoldedPage(in: ctx)
      ctx.move(to: CGPoint(x: 8.5, y: 11))
      ctx.addLine(to: CGPoint(x: 15.5, y: 11))
      ctx.move(to: CGPoint(x: 8.5, y: 14))
      ctx.addLine(to: CGPoint(x: 15.5, y: 14))
      ctx.move(to: CGPoint(x: 8.5, y: 17))
      ctx.addLine(to: CGPoint(x: 13.5, y: 17))
      ctx.strokePath()

    case "sheet":
      drawGridSheet(in: ctx, hasHeaderRule: false)

    case "csv":
      drawGridSheet(in: ctx, hasHeaderRule: true)

    case "slides":
      // v14Type.slides
      ctx.addPath(CGPath(roundedRect: CGRect(x: 3.5, y: 4, width: 17, height: 13), cornerWidth: 2, cornerHeight: 2, transform: nil))
      ctx.move(to: CGPoint(x: 12, y: 17))
      ctx.addLine(to: CGPoint(x: 12, y: 21))
      ctx.move(to: CGPoint(x: 8, y: 21))
      ctx.addLine(to: CGPoint(x: 16, y: 21))
      ctx.move(to: CGPoint(x: 7, y: 13))
      ctx.addLine(to: CGPoint(x: 10, y: 10))
      ctx.addLine(to: CGPoint(x: 13, y: 12))
      ctx.addLine(to: CGPoint(x: 17, y: 7))
      ctx.strokePath()

    case "audio":
      // v14Type.audio
      ctx.move(to: CGPoint(x: 9, y: 17))
      ctx.addLine(to: CGPoint(x: 9, y: 6))
      ctx.addLine(to: CGPoint(x: 19, y: 4))
      ctx.addLine(to: CGPoint(x: 19, y: 15))
      ctx.move(to: CGPoint(x: 9, y: 9))
      ctx.addLine(to: CGPoint(x: 19, y: 7))
      ctx.strokePath()
      ctx.strokeEllipse(in: CGRect(x: 3.8, y: 15.5, width: 5.2, height: 4.0))
      ctx.strokeEllipse(in: CGRect(x: 13.8, y: 13.5, width: 5.2, height: 4.0))

    case "musicgroup":
      // v14Type.musicgroup
      ctx.move(to: CGPoint(x: 7, y: 16))
      ctx.addLine(to: CGPoint(x: 7, y: 6))
      ctx.addLine(to: CGPoint(x: 16, y: 4))
      ctx.addLine(to: CGPoint(x: 16, y: 14))
      ctx.move(to: CGPoint(x: 7, y: 9))
      ctx.addLine(to: CGPoint(x: 16, y: 7))
      ctx.move(to: CGPoint(x: 20, y: 8))
      ctx.addLine(to: CGPoint(x: 20, y: 17))
      ctx.addArc(tangent1End: CGPoint(x: 20, y: 21), tangent2End: CGPoint(x: 16, y: 21), radius: 4)
      ctx.addLine(to: CGPoint(x: 11, y: 21))
      ctx.strokePath()
      ctx.strokeEllipse(in: CGRect(x: 2.6, y: 14.7, width: 4.4, height: 3.4))
      ctx.strokeEllipse(in: CGRect(x: 11.6, y: 12.7, width: 4.4, height: 3.4))

    case "video":
      // v14Type.video
      ctx.addPath(CGPath(roundedRect: CGRect(x: 3.5, y: 5, width: 17, height: 14), cornerWidth: 3, cornerHeight: 3, transform: nil))
      ctx.strokePath()
      ctx.move(to: CGPoint(x: 10, y: 9))
      ctx.addLine(to: CGPoint(x: 15, y: 12))
      ctx.addLine(to: CGPoint(x: 10, y: 15))
      ctx.closePath()
      ctx.fillPath()

    case "batch":
      // v14Type.batch
      ctx.addPath(CGPath(roundedRect: CGRect(x: 7, y: 3.5, width: 13, height: 15), cornerWidth: 2.5, cornerHeight: 2.5, transform: nil))
      ctx.move(to: CGPoint(x: 4, y: 7))
      ctx.addLine(to: CGPoint(x: 4, y: 19))
      ctx.addArc(tangent1End: CGPoint(x: 4, y: 21), tangent2End: CGPoint(x: 6, y: 21), radius: 2)
      ctx.addLine(to: CGPoint(x: 16, y: 21))
      ctx.move(to: CGPoint(x: 10, y: 8))
      ctx.addLine(to: CGPoint(x: 17, y: 8))
      ctx.move(to: CGPoint(x: 10, y: 12))
      ctx.addLine(to: CGPoint(x: 15, y: 12))
      ctx.strokePath()

    case "archive":
      // v14Type.archive
      ctx.addPath(CGPath(roundedRect: CGRect(x: 4, y: 4, width: 16, height: 16), cornerWidth: 3, cornerHeight: 3, transform: nil))
      ctx.move(to: CGPoint(x: 11, y: 4))
      ctx.addLine(to: CGPoint(x: 11, y: 7))
      ctx.addLine(to: CGPoint(x: 13, y: 7))
      ctx.addLine(to: CGPoint(x: 13, y: 10))
      ctx.addLine(to: CGPoint(x: 11, y: 10))
      ctx.addLine(to: CGPoint(x: 11, y: 13))
      ctx.addLine(to: CGPoint(x: 13, y: 13))
      ctx.addLine(to: CGPoint(x: 13, y: 16))
      ctx.addRect(CGRect(x: 10, y: 16, width: 4, height: 2))
      ctx.strokePath()

    case "folder":
      // v14Type.folder
      ctx.move(to: CGPoint(x: 3.5, y: 8))
      ctx.addLine(to: CGPoint(x: 3.5, y: 6.5))
      ctx.addArc(tangent1End: CGPoint(x: 3.5, y: 4.5), tangent2End: CGPoint(x: 5.5, y: 4.5), radius: 2)
      ctx.addLine(to: CGPoint(x: 10.5, y: 4.5))
      ctx.addLine(to: CGPoint(x: 12.5, y: 6.5))
      ctx.addLine(to: CGPoint(x: 19, y: 6.5))
      ctx.addArc(tangent1End: CGPoint(x: 21, y: 6.5), tangent2End: CGPoint(x: 21, y: 8.5), radius: 2)
      ctx.addLine(to: CGPoint(x: 21, y: 18))
      ctx.addArc(tangent1End: CGPoint(x: 21, y: 20), tangent2End: CGPoint(x: 19, y: 20), radius: 2)
      ctx.addLine(to: CGPoint(x: 5.5, y: 20))
      ctx.addArc(tangent1End: CGPoint(x: 3.5, y: 20), tangent2End: CGPoint(x: 3.5, y: 18), radius: 2)
      ctx.closePath()
      ctx.move(to: CGPoint(x: 4, y: 10))
      ctx.addLine(to: CGPoint(x: 20, y: 10))
      ctx.strokePath()

    case "font":
      // v14Type.font
      ctx.move(to: CGPoint(x: 4, y: 19))
      ctx.addLine(to: CGPoint(x: 10, y: 5))
      ctx.addLine(to: CGPoint(x: 16, y: 19))
      ctx.move(to: CGPoint(x: 6.5, y: 14))
      ctx.addLine(to: CGPoint(x: 13.5, y: 14))
      ctx.move(to: CGPoint(x: 17, y: 13))
      ctx.addLine(to: CGPoint(x: 21, y: 13))
      ctx.move(to: CGPoint(x: 19, y: 13))
      ctx.addLine(to: CGPoint(x: 19, y: 19))
      ctx.strokePath()

    case "package":
      // v14Type.package
      ctx.move(to: CGPoint(x: 12, y: 3))
      ctx.addLine(to: CGPoint(x: 21, y: 8))
      ctx.addLine(to: CGPoint(x: 21, y: 16))
      ctx.addLine(to: CGPoint(x: 12, y: 21))
      ctx.addLine(to: CGPoint(x: 3, y: 16))
      ctx.addLine(to: CGPoint(x: 3, y: 8))
      ctx.closePath()
      ctx.move(to: CGPoint(x: 3, y: 8))
      ctx.addLine(to: CGPoint(x: 12, y: 13))
      ctx.addLine(to: CGPoint(x: 21, y: 8))
      ctx.move(to: CGPoint(x: 12, y: 13))
      ctx.addLine(to: CGPoint(x: 12, y: 21))
      ctx.move(to: CGPoint(x: 8, y: 5.3))
      ctx.addLine(to: CGPoint(x: 16, y: 9.8))
      ctx.strokePath()

    case "database":
      drawDatabaseCylinder(in: ctx)

    default:
      // v14Type.unknown
      drawFoldedPage(in: ctx)
      ctx.move(to: CGPoint(x: 10, y: 12))
      ctx.addArc(center: CGPoint(x: 12, y: 11.8), radius: 2, startAngle: .pi, endAngle: .pi * 0.25, clockwise: false)
      ctx.addLine(to: CGPoint(x: 12, y: 15.5))
      ctx.strokePath()
      ctx.fillEllipse(in: CGRect(x: 11.2, y: 17.1, width: 1.6, height: 1.6))
    }
  }

  private static func drawLanguageGlyph(_ lang: String, in ctx: CGContext, color: NSColor) {
    switch lang {
    case "js":
      // v14Shapes.js: filled rounded tile + white JS strokes
      ctx.addPath(CGPath(roundedRect: CGRect(x: 3, y: 3, width: 18, height: 18), cornerWidth: 4, cornerHeight: 4, transform: nil))
      ctx.fillPath()
      ctx.setStrokeColor(NSColor.white.cgColor)
      ctx.setLineWidth(1.7)
      ctx.move(to: CGPoint(x: 11, y: 8))
      ctx.addLine(to: CGPoint(x: 11, y: 15))
      ctx.addQuadCurve(to: CGPoint(x: 8, y: 18), control: CGPoint(x: 11, y: 18))
      ctx.addQuadCurve(to: CGPoint(x: 5.5, y: 16.3), control: CGPoint(x: 6, y: 18))
      ctx.move(to: CGPoint(x: 17.8, y: 9.2))
      ctx.addQuadCurve(to: CGPoint(x: 13.8, y: 10.3), control: CGPoint(x: 13.8, y: 6.8))
      ctx.addCurve(to: CGPoint(x: 18.3, y: 14.9), control1: CGPoint(x: 13.8, y: 12.4), control2: CGPoint(x: 18.3, y: 11.7))
      ctx.addQuadCurve(to: CGPoint(x: 13.3, y: 16.5), control: CGPoint(x: 18.3, y: 18.5))
      ctx.strokePath()

    case "ts":
      // v14Shapes.ts: filled rounded tile + white TS strokes
      ctx.addPath(CGPath(roundedRect: CGRect(x: 3, y: 3, width: 18, height: 18), cornerWidth: 4, cornerHeight: 4, transform: nil))
      ctx.fillPath()
      ctx.setStrokeColor(NSColor.white.cgColor)
      ctx.setLineWidth(1.6)
      ctx.move(to: CGPoint(x: 6, y: 9))
      ctx.addLine(to: CGPoint(x: 13, y: 9))
      ctx.move(to: CGPoint(x: 9.5, y: 9))
      ctx.addLine(to: CGPoint(x: 9.5, y: 17))
      ctx.move(to: CGPoint(x: 18.5, y: 9.9))
      ctx.addQuadCurve(to: CGPoint(x: 14.9, y: 10.9), control: CGPoint(x: 14.9, y: 7.8))
      ctx.addCurve(to: CGPoint(x: 18.9, y: 14.9), control1: CGPoint(x: 14.9, y: 12.8), control2: CGPoint(x: 18.9, y: 12.1))
      ctx.addQuadCurve(to: CGPoint(x: 14.3, y: 16.3), control: CGPoint(x: 18.9, y: 18.0))
      ctx.strokePath()

    case "go":
      // v14Shapes.go: speed lines + G + O
      ctx.move(to: CGPoint(x: 2.5, y: 8))
      ctx.addLine(to: CGPoint(x: 6.5, y: 8))
      ctx.move(to: CGPoint(x: 1.5, y: 12))
      ctx.addLine(to: CGPoint(x: 6.5, y: 12))
      ctx.move(to: CGPoint(x: 3.5, y: 16))
      ctx.addLine(to: CGPoint(x: 6.5, y: 16))
      ctx.move(to: CGPoint(x: 13, y: 9))
      ctx.addArc(center: CGPoint(x: 10.3, y: 12), radius: 3.8, startAngle: -.pi * 0.28, endAngle: .pi * 0.35, clockwise: true)
      ctx.addLine(to: CGPoint(x: 13, y: 12))
      ctx.addLine(to: CGPoint(x: 10, y: 12))
      ctx.strokePath()
      ctx.strokeEllipse(in: CGRect(x: 15.2, y: 7.9, width: 6.2, height: 8.2))

    case "php":
      // v14Shapes.php: filled oval + white php monogram
      ctx.fillEllipse(in: CGRect(x: 2, y: 5, width: 20, height: 14))
      drawMonogram("php", in: ctx, color: .white, fontSize: 8.5)

    case "py":
      // v14Shapes.py: dual interlocking shapes
      ctx.addPath(CGPath(roundedRect: CGRect(x: 5, y: 3, width: 10, height: 8), cornerWidth: 3, cornerHeight: 3, transform: nil))
      ctx.addPath(CGPath(roundedRect: CGRect(x: 2.5, y: 10.5, width: 8.5, height: 7.5), cornerWidth: 3, cornerHeight: 3, transform: nil))
      ctx.fillPath()
      ctx.saveGState()
      ctx.setFillColor(color.withAlphaComponent(color.alphaComponent * 0.52).cgColor)
      ctx.addPath(CGPath(roundedRect: CGRect(x: 12, y: 9, width: 9, height: 12), cornerWidth: 3, cornerHeight: 3, transform: nil))
      ctx.fillPath()
      ctx.restoreGState()
      ctx.setFillColor(NSColor.white.cgColor)
      ctx.fillEllipse(in: CGRect(x: 8.5, y: 5.4, width: 1.5, height: 1.5))
      ctx.fillEllipse(in: CGRect(x: 15.2, y: 17.5, width: 1.5, height: 1.5))

    case "rs":
      // v14Shapes.rs: gear ring + R
      ctx.strokeEllipse(in: CGRect(x: 4, y: 4, width: 16, height: 16))
      let ticks: [(CGPoint, CGPoint)] = [
        (CGPoint(x: 12, y: 2), CGPoint(x: 12, y: 4)),
        (CGPoint(x: 12, y: 20), CGPoint(x: 12, y: 22)),
        (CGPoint(x: 2, y: 12), CGPoint(x: 4, y: 12)),
        (CGPoint(x: 20, y: 12), CGPoint(x: 22, y: 12)),
        (CGPoint(x: 5, y: 5), CGPoint(x: 6.5, y: 6.5)),
        (CGPoint(x: 17.5, y: 17.5), CGPoint(x: 19, y: 19)),
        (CGPoint(x: 5, y: 19), CGPoint(x: 6.5, y: 17.5)),
        (CGPoint(x: 17.5, y: 6.5), CGPoint(x: 19, y: 5))
      ]
      for (a, b) in ticks {
        ctx.move(to: a)
        ctx.addLine(to: b)
      }
      ctx.move(to: CGPoint(x: 9, y: 16))
      ctx.addLine(to: CGPoint(x: 9, y: 8))
      ctx.addLine(to: CGPoint(x: 13, y: 8))
      ctx.addArc(center: CGPoint(x: 13, y: 10), radius: 2, startAngle: -.pi / 2, endAngle: .pi / 2, clockwise: false)
      ctx.addLine(to: CGPoint(x: 9, y: 12))
      ctx.move(to: CGPoint(x: 13, y: 12))
      ctx.addLine(to: CGPoint(x: 16, y: 16))
      ctx.strokePath()

    case "sh", "zsh", "fish", "ps1", "bat":
      // v14Shapes.sh: terminal prompt
      ctx.addPath(CGPath(roundedRect: CGRect(x: 3, y: 4.5, width: 18, height: 15), cornerWidth: 3, cornerHeight: 3, transform: nil))
      ctx.move(to: CGPoint(x: 7, y: 9))
      ctx.addLine(to: CGPoint(x: 10, y: 12))
      ctx.addLine(to: CGPoint(x: 7, y: 15))
      ctx.move(to: CGPoint(x: 13, y: 15))
      ctx.addLine(to: CGPoint(x: 17, y: 15))
      ctx.strokePath()

    case "sql":
      drawDatabaseCylinder(in: ctx)

    case "json":
      // v14Shapes.json: curly braces
      ctx.move(to: CGPoint(x: 9, y: 4))
      ctx.addCurve(to: CGPoint(x: 6, y: 9), control1: CGPoint(x: 6, y: 4), control2: CGPoint(x: 6, y: 6))
      ctx.addCurve(to: CGPoint(x: 3, y: 12), control1: CGPoint(x: 6, y: 11), control2: CGPoint(x: 5, y: 12))
      ctx.addCurve(to: CGPoint(x: 6, y: 15), control1: CGPoint(x: 5, y: 12), control2: CGPoint(x: 6, y: 13))
      ctx.addCurve(to: CGPoint(x: 9, y: 20), control1: CGPoint(x: 6, y: 18), control2: CGPoint(x: 6, y: 20))
      ctx.move(to: CGPoint(x: 15, y: 4))
      ctx.addCurve(to: CGPoint(x: 18, y: 9), control1: CGPoint(x: 18, y: 4), control2: CGPoint(x: 18, y: 6))
      ctx.addCurve(to: CGPoint(x: 21, y: 12), control1: CGPoint(x: 18, y: 11), control2: CGPoint(x: 19, y: 12))
      ctx.addCurve(to: CGPoint(x: 18, y: 15), control1: CGPoint(x: 19, y: 12), control2: CGPoint(x: 18, y: 13))
      ctx.addCurve(to: CGPoint(x: 15, y: 20), control1: CGPoint(x: 18, y: 18), control2: CGPoint(x: 18, y: 20))
      ctx.strokePath()

    case "css":
      // v14Shapes.css: shield + 3
      ctx.move(to: CGPoint(x: 5, y: 3.5))
      ctx.addLine(to: CGPoint(x: 19, y: 3.5))
      ctx.addLine(to: CGPoint(x: 17.6, y: 19.5))
      ctx.addLine(to: CGPoint(x: 12, y: 21.5))
      ctx.addLine(to: CGPoint(x: 6.4, y: 19.5))
      ctx.closePath()
      ctx.fillPath()
      ctx.setStrokeColor(NSColor.white.cgColor)
      ctx.setLineWidth(1.6)
      ctx.move(to: CGPoint(x: 8.5, y: 8))
      ctx.addLine(to: CGPoint(x: 15.5, y: 8))
      ctx.addLine(to: CGPoint(x: 15, y: 12))
      ctx.addLine(to: CGPoint(x: 9, y: 12))
      ctx.move(to: CGPoint(x: 15, y: 12))
      ctx.addLine(to: CGPoint(x: 14.6, y: 16))
      ctx.addLine(to: CGPoint(x: 12, y: 16.9))
      ctx.addLine(to: CGPoint(x: 9.3, y: 16))
      ctx.addLine(to: CGPoint(x: 9.1, y: 14.5))
      ctx.strokePath()

    case "yaml":
      // v14Shapes.yaml
      ctx.addPath(CGPath(roundedRect: CGRect(x: 4, y: 4, width: 16, height: 16), cornerWidth: 3, cornerHeight: 3, transform: nil))
      ctx.strokePath()
      ctx.setLineWidth(2.0)
      ctx.move(to: CGPoint(x: 8, y: 8))
      ctx.addLine(to: CGPoint(x: 12, y: 13))
      ctx.addLine(to: CGPoint(x: 16, y: 8))
      ctx.move(to: CGPoint(x: 12, y: 13))
      ctx.addLine(to: CGPoint(x: 12, y: 17))
      ctx.strokePath()

    case "html", "unknown":
      // v14Shapes.html / v14Shapes.unknown: code angle brackets + slash
      ctx.move(to: CGPoint(x: 8, y: 7))
      ctx.addLine(to: CGPoint(x: 3, y: 12))
      ctx.addLine(to: CGPoint(x: 8, y: 17))
      ctx.move(to: CGPoint(x: 16, y: 7))
      ctx.addLine(to: CGPoint(x: 21, y: 12))
      ctx.addLine(to: CGPoint(x: 16, y: 17))
      ctx.move(to: CGPoint(x: 13, y: 5))
      ctx.addLine(to: CGPoint(x: 11, y: 19))
      ctx.strokePath()

    case "svg":
      // v14Shapes.svg: triangle + 3 anchor nodes
      ctx.move(to: CGPoint(x: 5, y: 17))
      ctx.addLine(to: CGPoint(x: 12, y: 5))
      ctx.addLine(to: CGPoint(x: 19, y: 17))
      ctx.closePath()
      ctx.strokePath()
      for pt in [CGPoint(x: 5, y: 17), CGPoint(x: 12, y: 5), CGPoint(x: 19, y: 17)] {
        let r = CGRect(x: pt.x - 2, y: pt.y - 2, width: 4, height: 4)
        ctx.setFillColor(NSColor.white.cgColor)
        ctx.fillEllipse(in: r)
        ctx.strokeEllipse(in: r)
      }

    case "md":
      // v14Shapes.md: frame + M + down arrow
      ctx.addPath(CGPath(roundedRect: CGRect(x: 3, y: 5, width: 18, height: 14), cornerWidth: 2, cornerHeight: 2, transform: nil))
      ctx.move(to: CGPoint(x: 6, y: 15))
      ctx.addLine(to: CGPoint(x: 6, y: 9))
      ctx.addLine(to: CGPoint(x: 9, y: 12))
      ctx.addLine(to: CGPoint(x: 12, y: 9))
      ctx.addLine(to: CGPoint(x: 12, y: 15))
      ctx.move(to: CGPoint(x: 16, y: 9))
      ctx.addLine(to: CGPoint(x: 16, y: 15))
      ctx.move(to: CGPoint(x: 14, y: 13))
      ctx.addLine(to: CGPoint(x: 16, y: 15))
      ctx.addLine(to: CGPoint(x: 18, y: 13))
      ctx.strokePath()

    case "cpp", "c", "cs":
      // v14Shapes.cpp / c / cs: hexagon badge
      ctx.move(to: CGPoint(x: 12, y: 2))
      ctx.addLine(to: CGPoint(x: 21, y: 7))
      ctx.addLine(to: CGPoint(x: 21, y: 17))
      ctx.addLine(to: CGPoint(x: 12, y: 22))
      ctx.addLine(to: CGPoint(x: 3, y: 17))
      ctx.addLine(to: CGPoint(x: 3, y: 7))
      ctx.closePath()
      ctx.fillPath()
      let label = lang == "cpp" ? "C++" : (lang == "cs" ? "C#" : "C")
      drawMonogram(label, in: ctx, color: .white, fontSize: lang == "c" ? 11.5 : 8.2)

    case "java":
      // v14Shapes.java: cup + steam
      ctx.move(to: CGPoint(x: 6, y: 12))
      ctx.addLine(to: CGPoint(x: 16, y: 12))
      ctx.addLine(to: CGPoint(x: 16, y: 16))
      ctx.addArc(tangent1End: CGPoint(x: 16, y: 20), tangent2End: CGPoint(x: 12, y: 20), radius: 4)
      ctx.addLine(to: CGPoint(x: 10, y: 20))
      ctx.addArc(tangent1End: CGPoint(x: 6, y: 20), tangent2End: CGPoint(x: 6, y: 16), radius: 4)
      ctx.closePath()
      ctx.move(to: CGPoint(x: 16, y: 13))
      ctx.addLine(to: CGPoint(x: 18, y: 13))
      ctx.addArc(center: CGPoint(x: 18, y: 15), radius: 2, startAngle: -.pi / 2, endAngle: .pi / 2, clockwise: false)
      ctx.addLine(to: CGPoint(x: 16, y: 17))
      ctx.move(to: CGPoint(x: 4, y: 21))
      ctx.addLine(to: CGPoint(x: 20, y: 21))
      ctx.move(to: CGPoint(x: 11, y: 10))
      ctx.addCurve(to: CGPoint(x: 13, y: 2), control1: CGPoint(x: 7, y: 7), control2: CGPoint(x: 17, y: 6))
      ctx.move(to: CGPoint(x: 14, y: 10))
      ctx.addCurve(to: CGPoint(x: 16, y: 5), control1: CGPoint(x: 12, y: 8), control2: CGPoint(x: 17, y: 7))
      ctx.strokePath()

    default:
      // Source: `paste-lumen-v15.html` line 705 `v14Identity` monogram fallback
      let desc = LumenContentIdentityRegistry.shared.languageDescriptor(for: lang)
      let mono = desc.monogram
      let fontSize: CGFloat = mono.count > 3 ? 9 : (mono.count > 2 ? 10 : 13)
      drawMonogram(mono, in: ctx, color: color, fontSize: fontSize)
    }
  }

  private static func drawFoldedPage(in ctx: CGContext) {
    ctx.move(to: CGPoint(x: 6, y: 3.5))
    ctx.addLine(to: CGPoint(x: 14, y: 3.5))
    ctx.addLine(to: CGPoint(x: 18, y: 7.5))
    ctx.addLine(to: CGPoint(x: 18, y: 20.5))
    ctx.addLine(to: CGPoint(x: 6, y: 20.5))
    ctx.closePath()
    ctx.move(to: CGPoint(x: 14, y: 3.5))
    ctx.addLine(to: CGPoint(x: 14, y: 7.5))
    ctx.addLine(to: CGPoint(x: 18, y: 7.5))
    ctx.strokePath()
  }

  private static func drawGridSheet(in ctx: CGContext, hasHeaderRule: Bool) {
    ctx.addPath(CGPath(roundedRect: CGRect(x: 4, y: 4, width: 16, height: 16), cornerWidth: 2.5, cornerHeight: 2.5, transform: nil))
    ctx.move(to: CGPoint(x: 4, y: 9))
    ctx.addLine(to: CGPoint(x: 20, y: 9))
    ctx.move(to: CGPoint(x: 4, y: 14.5))
    ctx.addLine(to: CGPoint(x: 20, y: 14.5))
    ctx.move(to: CGPoint(x: 10, y: 9))
    ctx.addLine(to: CGPoint(x: 10, y: 20))
    ctx.move(to: CGPoint(x: 15, y: 9))
    ctx.addLine(to: CGPoint(x: 15, y: 20))
    if hasHeaderRule {
      ctx.move(to: CGPoint(x: 6, y: 6.5))
      ctx.addLine(to: CGPoint(x: 11, y: 6.5))
    }
    ctx.strokePath()
  }

  private static func drawDatabaseCylinder(in ctx: CGContext) {
    ctx.strokeEllipse(in: CGRect(x: 5, y: 3, width: 14, height: 6))
    ctx.move(to: CGPoint(x: 5, y: 6))
    ctx.addLine(to: CGPoint(x: 5, y: 18))
    ctx.addCurve(to: CGPoint(x: 19, y: 18), control1: CGPoint(x: 5, y: 21.5), control2: CGPoint(x: 19, y: 21.5))
    ctx.addLine(to: CGPoint(x: 19, y: 6))
    ctx.move(to: CGPoint(x: 5, y: 12))
    ctx.addCurve(to: CGPoint(x: 19, y: 12), control1: CGPoint(x: 5, y: 15.5), control2: CGPoint(x: 19, y: 15.5))
    ctx.strokePath()
  }

  private static func drawMonogram(_ text: String, in ctx: CGContext, color: NSColor, fontSize: CGFloat) {
    let font = NSFont.systemFont(ofSize: fontSize, weight: .bold)
    let attrs: [NSAttributedString.Key: Any] = [
      .font: font,
      .foregroundColor: color,
      .kern: -0.55
    ]
    let str = NSAttributedString(string: text, attributes: attrs)
    let measured = str.size()
    let origin = NSPoint(x: (24.0 - measured.width) / 2.0, y: (24.0 - measured.height) / 2.0)
    str.draw(at: origin)
  }

  private static func colorKey(_ color: NSColor) -> String {
    let rgb = color.usingColorSpace(.sRGB) ?? color
    return "\(Int((rgb.redComponent * 255).rounded()))_\(Int((rgb.greenComponent * 255).rounded()))_\(Int((rgb.blueComponent * 255).rounded()))_\(Int((rgb.alphaComponent * 255).rounded()))"
  }
}
