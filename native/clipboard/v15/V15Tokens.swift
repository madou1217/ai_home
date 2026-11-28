import AppKit
import CoreGraphics
import Foundation
import QuartzCore

// MARK: - V15 Motion & Accessibility Capabilities (§8, §18.4, §19.1, A16)

/// Standalone V15 motion and transparency capability resolver.
/// Respects system Reduce Motion / Reduce Transparency with highest priority
/// over in-app preferences without referencing any legacy V7 theme helpers.
enum V15Motion {
  static var isEnabled: Bool {
    LumenClipboardStore.shared.preferences.motion
      && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
  }

  static var isReduceMotionActive: Bool {
    !isEnabled
  }

  static var isReduceTransparencyActive: Bool {
    NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
  }

  static var particlesEnabled: Bool {
    LumenClipboardStore.shared.preferences.particles && isEnabled
  }

  static var glowEnabled: Bool {
    LumenClipboardStore.shared.preferences.glow
  }

  static var isDarkTheme: Bool {
    LumenClipboardStore.shared.preferences.theme == .dark
  }
}

// MARK: - Exact Hex Color Parser & sRGB Color Math

/// Exact sRGB color parser supporting `#RGB`, `#RGBA`, `#RRGGBB`, and `#RRGGBBAA`
/// verbatim from `docs/architecture/lumen-v15-exact-tokens.md` and `paste-lumen-v15.html`.
enum V15Color {
  static func hex(_ raw: String) -> NSColor {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let stripped = trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed
    let expanded: String
    switch stripped.count {
    case 3:
      expanded = stripped.map { "\($0)\($0)" }.joined() + "ff"
    case 4:
      expanded = stripped.map { "\($0)\($0)" }.joined()
    case 6:
      expanded = stripped + "ff"
    case 8:
      expanded = stripped
    default:
      return NSColor(srgbRed: 0, green: 0, blue: 0, alpha: 1)
    }

    var value: UInt64 = 0
    guard Scanner(string: expanded).scanHexInt64(&value) else {
      return NSColor(srgbRed: 0, green: 0, blue: 0, alpha: 1)
    }
    let r = CGFloat((value >> 24) & 0xFF) / 255.0
    let g = CGFloat((value >> 16) & 0xFF) / 255.0
    let b = CGFloat((value >> 8) & 0xFF) / 255.0
    let a = CGFloat(value & 0xFF) / 255.0
    return NSColor(srgbRed: r, green: g, blue: b, alpha: a)
  }

  static func mix(_ base: NSColor, with target: NSColor, ratio: CGFloat) -> NSColor {
    let t = max(0, min(1, ratio))
    let a = base.usingColorSpace(.sRGB) ?? base
    let b = target.usingColorSpace(.sRGB) ?? target
    return NSColor(
      srgbRed: a.redComponent * (1 - t) + b.redComponent * t,
      green: a.greenComponent * (1 - t) + b.greenComponent * t,
      blue: a.blueComponent * (1 - t) + b.blueComponent * t,
      alpha: a.alphaComponent * (1 - t) + b.alphaComponent * t
    )
  }

  /// Relative WCAG luminance for adaptive text contrast over arbitrary color swatches.
  static func relativeLuminance(of color: NSColor) -> CGFloat {
    let rgb = color.usingColorSpace(.sRGB) ?? color
    func linear(_ c: CGFloat) -> CGFloat {
      c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * linear(rgb.redComponent)
      + 0.7152 * linear(rgb.greenComponent)
      + 0.0722 * linear(rgb.blueComponent)
  }
}

// MARK: - Cubic Bezier Evaluator (Shared by CA Animations & Frame-Driven Motion)

struct V15CubicBezier {
  let x1: Double
  let y1: Double
  let x2: Double
  let y2: Double

  var timingFunction: CAMediaTimingFunction {
    CAMediaTimingFunction(
      controlPoints: Float(x1),
      Float(y1),
      Float(x2),
      Float(y2)
    )
  }

  /// Evaluates CSS cubic-bezier(x1, y1, x2, y2) at normalized time `x` in [0, 1].
  func evaluate(_ x: Double) -> Double {
    if x <= 0 { return 0 }
    if x >= 1 { return 1 }

    // Newton-Raphson + bisection solve for parameter t where Bx(t) = x
    var t = x
    for _ in 0..<8 {
      let cx = sampleX(t) - x
      let dx = sampleDerivativeX(t)
      if abs(cx) < 1e-6 { break }
      if abs(dx) < 1e-6 { break }
      t = max(0, min(1, t - cx / dx))
    }
    if abs(sampleX(t) - x) > 1e-4 {
      var lo = 0.0
      var hi = 1.0
      t = x
      for _ in 0..<14 {
        let mid = sampleX(t)
        if abs(mid - x) < 1e-6 { break }
        if x > mid { lo = t } else { hi = t }
        t = 0.5 * (lo + hi)
      }
    }
    return sampleY(t)
  }

  private func sampleX(_ t: Double) -> Double {
    let u = 1.0 - t
    return 3.0 * u * u * t * x1 + 3.0 * u * t * t * x2 + t * t * t
  }

  private func sampleY(_ t: Double) -> Double {
    let u = 1.0 - t
    return 3.0 * u * u * t * y1 + 3.0 * u * t * t * y2 + t * t * t
  }

  private func sampleDerivativeX(_ t: Double) -> Double {
    let u = 1.0 - t
    return 3.0 * u * u * x1 + 6.0 * u * t * (x2 - x1) + 3.0 * t * t * (1.0 - x2)
  }
}

// MARK: - V15 Shadow Descriptor

struct V15ShadowSpec {
  let offsetX: CGFloat
  let offsetY: CGFloat // CSS +Y downward; V15Materials converts to macOS CALayer (-offsetY)
  let blurRadius: CGFloat // CSS blur radius in DIP
  let color: NSColor
}

// MARK: - Exact Extracted V15 Visual Tokens

/// Verbatim visual tokens extracted from:
/// - `docs/architecture/lumen-v15-exact-tokens.md`
/// - `docs/design/v15/paste-lumen-v15.html` (all 9 `<style>` blocks, final effective cascade)
/// - `docs/design/v15/README-Lumen-V15.md` (§19 > §18 > §17 > §16)
///
/// Every constant is expressed in macOS logical points (1 pt == 1 DIP == 1 CSS px at 100% scale).
enum V15Tokens {

  // MARK: Orbit Shell (.orbit / .shared-orbit)

  enum Shell {
    /// Source: `paste-lumen-v15.html` `.orbit` -> `height: clamp(218px, 31vh, 302px)`
    static let minHeight: CGFloat = 218
    static let maxHeight: CGFloat = 302
    static let viewportHeightRatio: CGFloat = 0.31

    /// Source: `paste-lumen-v15.html` `.orbit` (light) -> `linear-gradient(180deg, #e6f4ff39, #b3d0ed55 42%, #9bb3db68)`
    static let lightGradientTop = V15Color.hex("#e6f4ff39")
    static let lightGradientMid = V15Color.hex("#b3d0ed55")
    static let lightGradientMidLocation: CGFloat = 0.42
    static let lightGradientBottom = V15Color.hex("#9bb3db68")

    /// Source: `paste-lumen-v15.html` `.dark .orbit` -> `linear-gradient(180deg, #152a4770, #101d36a8)`
    static let darkGradientTop = V15Color.hex("#152a4770")
    static let darkGradientBottom = V15Color.hex("#101d36a8")

    /// Source: Reduce Transparency static fallback (`README-Lumen-V15.md` §19.2)
    static let lightReduceTransparencyFill = V15Color.hex("#dbe7f7f2")
    static let darkReduceTransparencyFill = V15Color.hex("#132036f5")

    /// Source: `paste-lumen-v15.html` `.orbit` -> `inset 0 1px 0 #f6fcff`, `0 -12px 80px #101f3f36`
    /// `.dark .orbit` -> `inset 0 1px 0 #c2deff75`, `0 -10px 70px #060b2355`
    static let lightTopInsetLine = V15Color.hex("#f6fcff")
    static let darkTopInsetLine = V15Color.hex("#c2deff75")
    static let lightOuterShadow = V15ShadowSpec(
      offsetX: 0,
      offsetY: -12,
      blurRadius: 80,
      color: V15Color.hex("#101f3f36")
    )
    static let darkOuterShadow = V15ShadowSpec(
      offsetX: 0,
      offsetY: -10,
      blurRadius: 70,
      color: V15Color.hex("#060b2355")
    )

    /// Source: `paste-lumen-v15.html` `.orbit:after` -> `height: 2px`,
    /// `linear-gradient(90deg, #e9faff12, #d8efff70 20%, #e6edff90 70%, #fff0)`,
    /// `radial-gradient(ellipse at mx 50%, white 0%, #d4f2ff 7%, #afd6ff70 16%, transparent 42%)`,
    /// `box-shadow: 0 0 14px 2px #c7e8ff60`
    static let topSpecularHeight: CGFloat = 2
    static let topSpecularGlowSpread: CGFloat = 2
    static let topSpecularStops: [(CGFloat, NSColor)] = [
      (0.00, V15Color.hex("#e9faff12")),
      (0.20, V15Color.hex("#d8efff70")),
      (0.70, V15Color.hex("#e6edff90")),
      (1.00, V15Color.hex("#ffffff00"))
    ]
    static let topSpecularPointerPeak = V15Color.hex("#ffffff")
    static let topSpecularPointerMid = V15Color.hex("#d4f2ff")
    static let topSpecularPointerOuter = V15Color.hex("#afd6ff70")
    static let topSpecularGlowColor = V15Color.hex("#c7e8ff60")
    static let topSpecularGlowShadow = V15ShadowSpec(
      offsetX: 0,
      offsetY: 0,
      blurRadius: 14,
      color: V15Color.hex("#c7e8ff60")
    )

    /// Source: `paste-lumen-v15.html` `.orbit:before` / `.dark .orbit:before`:
    /// `radial-gradient(ellipse at mx 0%, #e8f5ff9e, transparent 37%)`,
    /// `radial-gradient(ellipse at 80% 100%, #c5b8ff44, transparent 45%)`,
    /// `linear-gradient(100deg, #fff0, #d8f5ff22 43%, #fff0)`
    static let lightPointerGlow = V15Color.hex("#e8f5ff9e")
    static let lightSecondaryGlow = V15Color.hex("#c5b8ff44")
    static let lightObliqueSheenDegrees: CGFloat = 100
    static let lightObliqueSheenPeak = V15Color.hex("#d8f5ff22")
    static let lightObliqueSheenPeakLocation: CGFloat = 0.43
    static let darkPointerGlow = V15Color.hex("#8ab8ff55")
    static let darkSecondaryGlow = V15Color.hex("#9378e42b")

    /// Source: `paste-lumen-v15.html` `.orbit` enter/exit transitions
    /// `.orbit` open: `0.52s cubic-bezier(.19,1,.25,1)` / opacity `0.38s`
    /// `.shared-orbit.pasting` exit: `0.32s cubic-bezier(.4,0,.5,1)` / opacity `0.25s`
    static let enterDuration: TimeInterval = 0.52
    static let enterCurve = V15CubicBezier(x1: 0.19, y1: 1.0, x2: 0.25, y2: 1.0)
    static let exitDuration: TimeInterval = 0.32
    static let exitCurve = V15CubicBezier(x1: 0.40, y1: 0.0, x2: 0.50, y2: 1.0)

    /// Source: `paste-lumen-v15.html` `.shared-orbit.open .rail-item` -> `orbitArrival .48s cubic-bezier(.18,.86,.26,1)` + `15ms` stagger
    static let cardArrivalDuration: TimeInterval = 0.48
    static let cardArrivalCurve = V15CubicBezier(x1: 0.18, y1: 0.86, x2: 0.26, y2: 1.0)
    static let cardArrivalStagger: TimeInterval = 0.015
    static let cardArrivalMaxStaggerIndex: Int = 12
    static let cardArrivalOffsetY: CGFloat = 20

    /// Source: `paste-lumen-v15.html` `.orbit-empty` -> `color: #f1f5ff; text-shadow: 0 1px 8px #23344f`
    static let emptyTextColor = V15Color.hex("#f1f5ff")
    static let emptyTextShadowColor = V15Color.hex("#23344f")

    static func height(forScreenHeight screenHeight: CGFloat) -> CGFloat {
      min(maxHeight, max(minHeight, round(screenHeight * viewportHeightRatio)))
    }
  }

  // MARK: Orbit Rail (.shared-orbit .rail)

  enum Rail {
    /// Source: `lumen-v15-exact-tokens.md` `.shared-orbit .rail` -> `margin-left: 38px` (leftmost display only)
    static let leftShiftForDots: CGFloat = 38
    /// Source: `lumen-v15-exact-tokens.md` `.shared-orbit .rail` -> `padding-left: 12px; scroll-padding-left: 12px`
    static let paddingLeft: CGFloat = 12
    /// Source: `lumen-v15-exact-tokens.md` `.shared-orbit .rail` -> `padding: 27px 25px 21px` (trailing inset)
    static let paddingRight: CGFloat = 25
    /// Source: `lumen-v15-exact-tokens.md` `.shared-orbit .rail` -> `padding-top: 22px`
    static let paddingTop: CGFloat = 22
    /// Source: `lumen-v15-exact-tokens.md` `.shared-orbit .rail` -> `padding-bottom: 15px`
    static let paddingBottom: CGFloat = 15
    /// Source: `lumen-v15-exact-tokens.md` `.shared-orbit .rail` -> `gap: 13px`
    static let gap: CGFloat = 13

    /// Source: `paste-lumen-v15.html` `rail.pointermove` -> `Math.abs(e.clientX - startX) > 7`
    static let dragPanThreshold: CGFloat = 7
    /// Source: `paste-lumen-v15.html` `v12Insert` -> `scroll > 8` preserves viewport anchor
    static let preserveViewportScrollThreshold: CGFloat = 8

    /// Source: `paste-lumen-v15.html` `setOrbitType` -> outgoing ghost `210ms` ±24px, incoming rail `370ms` ±22px
    static let categoryExitDuration: TimeInterval = 0.21
    static let categoryExitCurve = V15CubicBezier(x1: 0.35, y1: 0.0, x2: 0.30, y2: 1.0)
    static let categoryExitOffsetY: CGFloat = 24
    static let categoryEnterDuration: TimeInterval = 0.37
    static let categoryEnterCurve = V15CubicBezier(x1: 0.18, y1: 0.85, x2: 0.25, y2: 1.0)
    static let categoryEnterOffsetY: CGFloat = 22
  }

  // MARK: Orbit Card (.clip + .rail .clip.v10card + .shared-orbit .rail-item .clip.v10card)

  enum Card {
    /// Source: `lumen-v15-exact-tokens.md` (curated 5dee6f4a) Orbit card -> `width: clamp(166px, 14.3vw, 220px)`
    static let minWidth: CGFloat = 166
    static let maxWidth: CGFloat = 220
    static let widthRailRatio: CGFloat = 0.143

    /// Source: `lumen-v15-exact-tokens.md` (curated 5dee6f4a) Orbit card -> `min-height: 148px; max-height: 242px`
    static let maxHeight: CGFloat = 242
    static let minHeight: CGFloat = 148

    /// Source: `lumen-v15-exact-tokens.md` (curated 5dee6f4a) Orbit card & `README-Lumen-V15.md` §19.1 -> `border-radius: 16px`
    static let cornerRadius: CGFloat = 16

    /// Source: `lumen-v15-exact-tokens.md` (curated 5dee6f4a) Orbit card -> `border: 1px solid #ffffff95`
    static let borderWidth: CGFloat = 1
    static let lightBorderColor = V15Color.hex("#ffffff95")
    /// Source: `lumen-v15-exact-tokens.md` (curated 5dee6f4a) Dark `.dark .clip.v10card` -> `border-color: #9fb8df4a`
    static let darkBorderColor = V15Color.hex("#9fb8df4a")
    /// Source: `paste-lumen-v15.html` line 96 `.rail .clip.v10card.selected` / `.dark .rail .clip.v10card.selected`
    static let lightSelectedBorderColor = V15Color.hex("#f8fcff")
    static let darkSelectedBorderColor = V15Color.hex("#d4eaff")

    /// Source: `lumen-v15-exact-tokens.md` (curated 5dee6f4a) Orbit card ->
    /// `background: linear-gradient(155deg, #fbfdfff5, #e2eaf6ed)`
    static let lightGradientDegrees: CGFloat = 155
    static let lightGradientStart = V15Color.hex("#fbfdfff5")
    static let lightGradientEnd = V15Color.hex("#e2eaf6ed")

    /// Source: `lumen-v15-exact-tokens.md` (curated 5dee6f4a) Dark `.dark .clip.v10card` ->
    /// `background: linear-gradient(145deg, #344660ef, #202e44f2)`
    static let darkGradientDegrees: CGFloat = 145
    static let darkGradientStart = V15Color.hex("#344660ef")
    static let darkGradientEnd = V15Color.hex("#202e44f2")

    /// Source: `lumen-v15-exact-tokens.md` (curated 5dee6f4a) Orbit card ->
    /// `box-shadow: 0 6px 18px #142a4220`
    static let lightShadow = V15ShadowSpec(
      offsetX: 0,
      offsetY: 6,
      blurRadius: 18,
      color: V15Color.hex("#142a4220")
    )
    /// Source: `paste-lumen-v15.html` line 11 `.rail .clip.selected:after` ->
    /// `border: 1px solid #fff` (`inset 0 0 0 1px #fff`), `box-shadow: inset 0 1px 7px #fff9`,
    /// `background: linear-gradient(122deg, transparent 10%, #fff3 30%, transparent 48%)`,
    /// `animation: lightPass .85s ease-out both` (dark: `border-color: #bcd9ff`, `inset 0 1px 7px #c7e0ff4a`)
    static let lightSelectedInnerRing = V15Color.hex("#ffffff")
    static let darkSelectedInnerRing = V15Color.hex("#bcd9ff")
    static let lightSelectedInnerHighlight = V15Color.hex("#ffffff99")
    static let darkSelectedInnerHighlight = V15Color.hex("#c7e0ff4a")
    static let selectedInnerHighlightHeight: CGFloat = 8
    static let selectedLightPassDegrees: CGFloat = 122
    static let selectedLightPassDuration: TimeInterval = 0.85
    static let selectedLightPassPeakColor = V15Color.hex("#ffffff33")
    static let selectedLightPassSteadyOpacity: Float = 0.38

    /// Source: `paste-lumen-v15.html` line 96 `.rail .clip.v10card.selected` ->
    /// `box-shadow: 0 0 0 1px #f8fcff, 0 0 19px #c9edff8c, 0 12px 27px #173b5840`
    static let lightSelectedShadow = V15ShadowSpec(
      offsetX: 0,
      offsetY: 12,
      blurRadius: 27,
      color: V15Color.hex("#173b5840")
    )
    static let lightSelectedGlow = V15ShadowSpec(
      offsetX: 0,
      offsetY: 0,
      blurRadius: 19,
      color: V15Color.hex("#c9edff8c")
    )
    /// Source: `paste-lumen-v15.html` line 96 `.dark .rail .clip.v10card.selected` ->
    /// `box-shadow: 0 0 0 1px #d4eaff, 0 0 17px #94caff70, 0 12px 25px #0005`
    static let darkShadow = V15ShadowSpec(
      offsetX: 0,
      offsetY: 6,
      blurRadius: 18,
      color: V15Color.hex("#050a1844")
    )
    static let darkSelectedShadow = V15ShadowSpec(
      offsetX: 0,
      offsetY: 12,
      blurRadius: 25,
      color: V15Color.hex("#00000055")
    )
    static let darkSelectedGlow = V15ShadowSpec(
      offsetX: 0,
      offsetY: 0,
      blurRadius: 17,
      color: V15Color.hex("#94caff70")
    )

    /// Source: `paste-lumen-v15.html` `.clip:before` / `.dark .rail .clip:before`
    static let lightSpecularSheen = V15Color.hex("#ffffff99")
    static let darkSpecularSheen = V15Color.hex("#b3d3ff55")
    static let specularSheenActiveOpacity: Float = 0.65

    /// Source: `lumen-v15-exact-tokens.md` (curated 5dee6f4a) Orbit card -> `color: #20324b` / Dark `#eaf1ff`
    static let lightInk = V15Color.hex("#20324b")
    static let darkInk = V15Color.hex("#eaf1ff")
    static let lightSecondaryInk = V15Color.hex("#4c5c75")
    static let darkSecondaryInk = V15Color.hex("#c1d0e5")

    /// Source: `paste-lumen-v15.html` line 185–189 & `README-Lumen-V15.md` §19.1 `close.lift`
    /// `--v15-lift: 0px / -2px / -5px / -7px`, `320ms cubic-bezier(.2,.9,.25,1.2)`
    static let liftDefault: CGFloat = 0
    static let liftNear: CGFloat = -2
    static let liftHover: CGFloat = -5
    static let liftSelected: CGFloat = -7
    static let liftDuration: TimeInterval = 0.32
    static let liftCurve = V15CubicBezier(x1: 0.20, y1: 0.90, x2: 0.25, y2: 1.20)

    /// Source: `paste-lumen-v15.html` `.shared-orbit.pasting .clip.selected` -> `translateY(-22px) scale(.96); opacity: .3`
    static let pasteLiftOffsetY: CGFloat = -22
    static let pasteLiftScale: CGFloat = 0.96
    static let pasteLiftOpacity: Float = 0.30
    static let pasteFeedbackDuration: TimeInterval = 0.25

    static func width(forRailWidth railWidth: CGFloat) -> CGFloat {
      min(maxWidth, max(minWidth, round(railWidth * widthRailRatio)))
    }

    static func height(forPanelHeight panelHeight: CGFloat) -> CGFloat {
      min(maxHeight, max(minHeight, panelHeight - Rail.paddingTop - Rail.paddingBottom))
    }
  }

  // MARK: Card Header (.clip-head / .v10kind / .time)

  enum Header {
    /// Source: `lumen-v15-exact-tokens.md` `.clip-head` & `README-Lumen-V15.md` §19.1 `orbit.header.height`
    /// `height: 34px; min-height: 34px; flex: 0 0 34px`
    static let height: CGFloat = 34
    /// Source: `paste-lumen-v15.html` line 190 & `README-Lumen-V15.md` §19.1 `orbit.header.inset`
    /// Default horizontal padding: `0 12px`
    static let paddingLeft: CGFloat = 12
    static let paddingRightDefault: CGFloat = 12
    /// Source: `paste-lumen-v15.html` line 191 & `README-Lumen-V15.md` §19.1 `orbit.header.inset`
    /// Hover/focus-within right padding: `43px` (yields 9 DIP clearance to 28 DIP close hit, 12 DIP to 22 DIP circle)
    static let paddingRightHover: CGFloat = 43

    /// Source: `lumen-v15-exact-tokens.md` `.clip-head` -> `gap: 7px; font-size: 10px; color: #61728a`
    static let gap: CGFloat = 7
    /// Source: `paste-lumen-v15.html` line 182 `.clip .clip-head .v14-glyph` -> `width: 18px; height: 18px`
    static let glyphSize: CGFloat = 18
    /// Source: `lumen-v15-exact-tokens.md` (curated 5dee6f4a) Orbit card header -> `font-size: 10px; color: #61728a` (Dark `#a9bbd4`)
    static let kindFontSize: CGFloat = 10
    static let kindLightColor = V15Color.hex("#61728a")
    static let kindDarkColor = V15Color.hex("#a9bbd4")

    /// Source: `lumen-v15-exact-tokens.md` (curated 5dee6f4a) Orbit card time -> `font-size: 10.5px; font-variant-numeric: tabular-nums`
    static let timeFontSize: CGFloat = 10.5
    static let timeLightColor = V15Color.hex("#61728a")
    static let timeDarkColor = V15Color.hex("#a9bbd4")

    /// Source: `paste-lumen-v15.html` line 190–191 ->
    /// `transition: padding-right 210ms cubic-bezier(.22,.8,.22,1) 100ms` (enter delay `0ms`, leave delay `100ms`)
    static let yieldDuration: TimeInterval = 0.21
    static let yieldLeaveDelay: TimeInterval = 0.10
    static let yieldCurve = V15CubicBezier(x1: 0.22, y1: 0.80, x2: 0.22, y2: 1.00)
  }

  // MARK: Close Affordance (.clip-remove + ::before + .ico)

  enum Close {
    /// Source: `paste-lumen-v15.html` line 192 & `README-Lumen-V15.md` §19.1 `close.hit` / `close.anchor`
    /// Hit area: `28 × 28`, `top: calc(4px + var(--v15-lift)); right: 7px`
    static let hitSize: CGFloat = 28
    static let topOffset: CGFloat = 4
    static let rightOffset: CGFloat = 7

    /// Source: `paste-lumen-v15.html` line 193 & `README-Lumen-V15.md` §19.1 `close.surface`
    /// True circular optical surface: `22 × 22` (`inset: 3px` inside `28 × 28` hit box)
    static let surfaceInset: CGFloat = 3
    static let surfaceSize: CGFloat = 22
    static let surfaceGradientDegrees: CGFloat = 145

    /// Source: `paste-lumen-v15.html` line 194 & `README-Lumen-V15.md` §19.1 `close.glyph`
    /// X glyph: `13 × 13` DIP, stroke width `1.9` on 24-unit grid, round caps
    static let glyphSize: CGFloat = 13
    static let glyphGridStrokeWidth: CGFloat = 1.9

    /// Source: `lumen-v15-exact-tokens.md` `.clip-remove::before` & `paste-lumen-v15.html` line 193
    /// Light surface: `linear-gradient(145deg, #f9fbffff, #e4ebf6f0)`, inset `0.6px #ffffffef`, shadow `0 1px 4px #243b5c22`
    static let lightSurfaceStart = V15Color.hex("#f9fbffff")
    static let lightSurfaceEnd = V15Color.hex("#e4ebf6f0")
    static let lightInnerBorderWidth: CGFloat = 0.6
    static let lightInnerBorderColor = V15Color.hex("#ffffffef")
    static let lightSurfaceShadow = V15ShadowSpec(
      offsetX: 0,
      offsetY: 1,
      blurRadius: 4,
      color: V15Color.hex("#243b5c22")
    )

    /// Source: `paste-lumen-v15.html` line 196–197 `.clip-remove:hover` / `:hover::before`
    static let lightGlyphColor = V15Color.hex("#53647b")
    static let lightHoverGlyphColor = V15Color.hex("#a63e55")
    static let lightHoverSurfaceFill = V15Color.hex("#fff1f3")
    static let lightHoverBorderColor = V15Color.hex("#ffffff")
    static let lightHoverShadow = V15ShadowSpec(
      offsetX: 0,
      offsetY: 2,
      blurRadius: 7,
      color: V15Color.hex("#b9698130")
    )

    /// Source: `lumen-v15-exact-tokens.md` `.clip-remove::before` Dark & `paste-lumen-v15.html` lines 201–204
    /// Dark surface: `linear-gradient(145deg, #53637b, #394960)`, inset `0.6px #c1d4ef55`, shadow `0 1px 5px #080f252e`
    static let darkSurfaceStart = V15Color.hex("#53637b")
    static let darkSurfaceEnd = V15Color.hex("#394960")
    static let darkInnerBorderColor = V15Color.hex("#c1d4ef55")
    static let darkSurfaceShadow = V15ShadowSpec(
      offsetX: 0,
      offsetY: 1,
      blurRadius: 5,
      color: V15Color.hex("#080f252e")
    )
    static let darkGlyphColor = V15Color.hex("#d9e5f6")
    static let darkHoverGlyphColor = V15Color.hex("#ffe0e6")
    static let darkHoverSurfaceFill = V15Color.hex("#644454")

    /// Source: `paste-lumen-v15.html` lines 192–200
    /// Default: `opacity: 0; scale(.80); pointer-events: none`
    /// Revealed: `opacity: 1` (100ms, delay 145ms), `scale(1)` (240ms, delay 85ms)
    /// Hover: `scale(1.08)`, glyph `rotate(90deg) scale(.95)` (280ms)
    /// Press: `scale(.88)`
    /// Focus-visible: `outline: 2px solid #6c9eff; outline-offset: 1px`
    static let hiddenScale: CGFloat = 0.80
    static let revealedScale: CGFloat = 1.00
    static let hoverScale: CGFloat = 1.08
    static let pressScale: CGFloat = 0.88
    static let hoverGlyphRotationRadians: CGFloat = .pi / 2.0
    static let hoverGlyphScale: CGFloat = 0.95

    static let opacityDuration: TimeInterval = 0.10
    static let revealOpacityDelay: TimeInterval = 0.145
    static let scaleDuration: TimeInterval = 0.24
    static let revealScaleDelay: TimeInterval = 0.085
    static let scaleCurve = V15CubicBezier(x1: 0.20, y1: 0.80, x2: 0.20, y2: 1.00)
    static let glyphHoverDuration: TimeInterval = 0.28
    static let glyphHoverCurve = V15CubicBezier(x1: 0.20, y1: 0.80, x2: 0.20, y2: 1.00)
    static let surfaceColorDuration: TimeInterval = 0.18
    static let glyphColorDuration: TimeInterval = 0.16

    static let focusRingWidth: CGFloat = 2
    static let focusRingOffset: CGFloat = 1
    static let focusRingColor = V15Color.hex("#6c9eff")
  }

  // MARK: Card Body & Footer (.clip-main / .v10text / .v10title / .v10code / .clip-foot / .key)

  enum Body {
    /// Source: `paste-lumen-v15.html` lines 96, 99, 116 `.v10card .clip-main` -> `padding: 6px 12px 3px; gap: 5px`
    static let paddingTop: CGFloat = 6
    static let paddingHorizontal: CGFloat = 12
    static let paddingBottom: CGFloat = 3
    static let gap: CGFloat = 5

    /// Source: `paste-lumen-v15.html` line 180 & `README-Lumen-V15.md` §18.3
    /// `.clip .v10title` -> `font-size: 12.5px; line-height: 1.35; font-weight: 590; letter-spacing: -.15px`
    static let titleFontSize: CGFloat = 12.5
    static let titleLineHeightMultiple: CGFloat = 1.35
    static let titleKern: CGFloat = -0.15

    /// Source: `paste-lumen-v15.html` line 180 & `README-Lumen-V15.md` §18.3
    /// `.clip .v10text` -> `font-size: 13px; line-height: 1.56; letter-spacing: -.07px; -webkit-line-clamp: 6`
    static let textFontSize: CGFloat = 13
    static let textLineHeightMultiple: CGFloat = 1.56
    static let textKern: CGFloat = -0.07
    static let textMaxLines: Int = 6

    /// Source: `lumen-v15-exact-tokens.md` `.v10text/.v10title/.v10code` lines 167–178
    /// `font-size: 10.5px; line-height: 1.5; background: #24344c; border-radius: 9px; padding: 9px; color: #d3e8fa`
    static let codeFontSize: CGFloat = 10.5
    static let codeLineHeightMultiple: CGFloat = 1.5
    static let codeBackground = V15Color.hex("#24344c")
    static let codeCornerRadius: CGFloat = 9
    static let codePadding: CGFloat = 9
    static let codeTextColor = V15Color.hex("#d3e8fa")
    static let codeMaxLines: Int = 9

    /// Source: `paste-lumen-v15.html` line 96 `.v10code` syntax token colors
    static let codeKeyword = V15Color.hex("#c5a4ff")
    static let codeKeywordGo = V15Color.hex("#6bdad6")
    static let codeKeywordPy = V15Color.hex("#f1ba8d")
    static let codeString = V15Color.hex("#a8d7a2")
    static let codeFunction = V15Color.hex("#9acbff")
    static let codeComment = V15Color.hex("#8797ac")
    static let codeNumber = V15Color.hex("#edb58a")
    static let codeVariablePhp = V15Color.hex("#ffbb9f")

    /// Source: `paste-lumen-v15.html` line 96 `.v10visual` / `.v10visual.paper` / `.v10card .v10visual .v14-glyph.tile`
    static let visualCornerRadius: CGFloat = 9
    static let visualTileGlyphSize: CGFloat = 42
    static let paperWellLightBackground = V15Color.hex("#c3d0e444")
    static let paperWellDarkBackground = V15Color.hex("#ffffff14")
    static let swatchFontSize: CGFloat = 14
    static let swatchBadgeFontSize: CGFloat = 9
    static let linkMarkFontSize: CGFloat = 22
    static let linkDomainFontSize: CGFloat = 10
    static let linkDescFontSize: CGFloat = 11.5
    static let videoPlayBadgeSize: CGFloat = 32
    static let videoPlayBadgeBackground = V15Color.hex("#1b2d4b88")
  }

  enum Footer {
    /// Source: `lumen-v15-exact-tokens.md` `.clip-foot/.key` lines 189–205 & `paste-lumen-v15.html` line 116
    /// `padding: 8px 12px 10px; min-height: 31px; gap: 6px`
    static let minHeight: CGFloat = 31
    static let paddingTop: CGFloat = 8
    static let paddingHorizontal: CGFloat = 12
    static let paddingBottom: CGFloat = 10
    static let gap: CGFloat = 6

    /// Source: `paste-lumen-v15.html` line 96 `.v10card .clip-foot .source` -> `width: 16px; height: 16px; border-radius: 5px`
    static let sourceIconSize: CGFloat = 16
    static let sourceIconCornerRadius: CGFloat = 5
    /// Source: `lumen-v15-exact-tokens.md` `.app-origin` -> `background: #8296b4`
    static let sourceFallbackBackground = V15Color.hex("#8296b4")
    /// Source: `lumen-v15-exact-tokens.md` (curated 5dee6f4a) Orbit card footer ->
    /// `padding: 8px 12px 10px; gap: 6px; font-size: 10px; color: #78869d; min-height: 31px`
    /// (Dark `.dark .rail .clip-foot`: `#a9bbd4`)
    static let sourceNameFontSize: CGFloat = 10
    static let sourceLightColor = V15Color.hex("#78869d")
    static let sourceDarkColor = V15Color.hex("#a9bbd4")

    /// Source: `paste-lumen-v15.html` `.clip .pinmini` -> `color: #6589d7`, `.clip-foot .ico` `12 × 12`
    static let pinGlyphSize: CGFloat = 12
    static let pinColor = V15Color.hex("#6589d7")

    /// Source: `paste-lumen-v15.html` lines 4, 7, 11 `.clip-foot .key` / `.dark .rail .key` / `.rail .clip.selected .key`
    /// `margin-left: auto; font-size: 10px; border-radius: 5px; min-width: 19px; height: 19px;`
    /// Light unselected: `background: #5a739c13; color: #657693`
    /// Dark unselected:  `background: #aac4ff15; color: #b1c5e5`
    /// Selected:         `background: #7596da; color: #ffffff; box-shadow: 0 0 10px #80aaff80`
    static let keyMinWidth: CGFloat = 19
    static let keyHeight: CGFloat = 19
    static let keyCornerRadius: CGFloat = 5
    static let keyFontSize: CGFloat = 10
    static let keyLightBackground = V15Color.hex("#5a739c13")
    static let keyLightTextColor = V15Color.hex("#657693")
    static let keyDarkBackground = V15Color.hex("#aac4ff15")
    static let keyDarkTextColor = V15Color.hex("#b1c5e5")
    static let keySelectedBackground = V15Color.hex("#7596da")
    static let keySelectedTextColor = V15Color.hex("#ffffff")
    static let keySelectedGlow = V15ShadowSpec(
      offsetX: 0,
      offsetY: 0,
      blurRadius: 10,
      color: V15Color.hex("#80aaff80")
    )
  }

  // MARK: Optical Dots 3.0 (.type-dock / .type-dot / .type-bubble)

  enum Dots {
    /// Source: `lumen-v15-exact-tokens.md` `.type-dock` lines 220–233
    /// `width: 38px; --step: 26px; height: calc(var(--step) * 5) = 130px`
    static let columnWidth: CGFloat = 38
    static let stepHeight: CGFloat = 26
    static let visibleCount: Int = 5
    static let windowHeight: CGFloat = stepHeight * CGFloat(visibleCount)

    /// Source: `lumen-v15-exact-tokens.md` `.type-dot i` lines 257–291 & `paste-lumen-v15.html` line 95
    static let dotDiameter: CGFloat = 5
    static let lightDotColor = V15Color.hex("#e7f3ff")
    static let lightActiveDotColor = V15Color.hex("#f5faff")
    static let darkDotColor = V15Color.hex("#d6eaff")
    static let darkActiveDotColor = V15Color.hex("#ffffff")

    static let idleScale: CGFloat = 0.78
    static let idleEdgeScale: CGFloat = 0.70
    static let idleOpacity: Float = 0.24
    static let idleEmptyOpacity: Float = 0.13
    static let idleActiveScale: CGFloat = 1.12
    static let idleActiveOpacity: Float = 0.43
    static let idleActiveGlow = V15ShadowSpec(
      offsetX: 0,
      offsetY: 0,
      blurRadius: 5,
      color: V15Color.hex("#e1f4ff50")
    )

    static let awakeScale: CGFloat = 1.00
    static let awakeOpacity: Float = 0.65
    static let awakeEmptyOpacity: Float = 0.26
    static let awakeActiveScale: CGFloat = 1.80
    static let awakeActiveOpacity: Float = 1.00
    static let awakeActiveGlow = V15ShadowSpec(
      offsetX: 0,
      offsetY: 0,
      blurRadius: 9,
      color: V15Color.hex("#c8eaff")
    )
    static let hoverScale: CGFloat = 1.65
    static let hoverActiveScale: CGFloat = 1.85
    static let pressScale: CGFloat = 0.85

    /// Source: `paste-lumen-v15.html` lines 54, 95, 255, 258, 259
    static let trackSlideDuration: TimeInterval = 0.46
    static let trackSlideCurve = V15CubicBezier(x1: 0.18, y1: 0.86, x2: 0.22, y2: 1.00)
    static let scaleDuration: TimeInterval = 0.32
    static let scaleCurve = V15CubicBezier(x1: 0.20, y1: 0.75, x2: 0.20, y2: 1.00)
    static let opacityDuration: TimeInterval = 0.26
    static let sleepDelay: TimeInterval = 0.90
    static let hoverStaggerDuration: TimeInterval = 0.28
    static let hoverStaggerPerStep: TimeInterval = 0.040
    static let hoverStaggerReversePenalty: TimeInterval = 0.020
    static let switchPulseDuration: TimeInterval = 0.36
    static let switchPulsePerStep: TimeInterval = 0.045
    static let wheelAccumulatorThreshold: CGFloat = 42
    static let wheelResetInterval: TimeInterval = 0.18

    /// Source: `lumen-v15-exact-tokens.md` `.type-bubble` lines 294–320
    /// `background: #f5f9ffed; color: #415a7d; border-radius: 7px; padding: 6px 9px; font-size: 11px; font-weight: 500`
    /// `box-shadow: 0 6px 18px #1d36552c; transition: opacity .25s, transform .4s cubic-bezier(.18,.86,.22,1)`
    static let bubbleLightBackground = V15Color.hex("#f5f9ffed")
    static let bubbleLightTextColor = V15Color.hex("#415a7d")
    static let bubbleDarkBackground = V15Color.hex("#263b58ef")
    static let bubbleDarkTextColor = V15Color.hex("#e8f3ff")
    static let bubbleDarkBorderColor = V15Color.hex("#b2cced66")
    static let bubbleCornerRadius: CGFloat = 7
    static let bubblePaddingVertical: CGFloat = 6
    static let bubblePaddingHorizontal: CGFloat = 9
    static let bubbleFontSize: CGFloat = 11
    static let bubbleShadow = V15ShadowSpec(
      offsetX: 0,
      offsetY: 6,
      blurRadius: 18,
      color: V15Color.hex("#1d36552c")
    )
    static let bubbleOpacityDuration: TimeInterval = 0.25
    static let bubbleTransformDuration: TimeInterval = 0.40
    static let bubbleTransformCurve = V15CubicBezier(x1: 0.18, y1: 0.86, x2: 0.22, y2: 1.00)
  }

  // MARK: Soft Dissolution & Capture Particles (§18.4, HTML lines 614–665)

  enum Particles {
    /// Source: `README-Lumen-V15.md` §18.4 & `paste-lumen-v15.html` lines 655–664
    /// `dissolve.front = 480ms`, `particle.life = 320–500ms`, `peak alpha = 0.58`, `hold = 920ms`, `reflow = 420ms`
    static let dissolveFrontDuration: TimeInterval = 0.48
    static let dissolveFrontStartDelay: TimeInterval = 0.015
    static let dissolveParticleLifeMin: TimeInterval = 0.32
    static let dissolveParticleLifeRange: TimeInterval = 0.18 // 320..500ms
    static let dissolveParticleStartBase: TimeInterval = 0.020
    static let dissolveParticlePhaseSpan: TimeInterval = 0.365
    static let dissolvePeakAlpha: CGFloat = 0.58
    static let dissolveHoldDuration: TimeInterval = 0.92
    static let dissolveNoParticlesHoldDuration: TimeInterval = 0.18
    static let dissolveReflowDuration: TimeInterval = 0.42
    static let dissolveReflowCurve = V15CubicBezier(x1: 0.28, y1: 0.58, x2: 0.26, y2: 1.00)
    static let dissolveMaskAngleDegrees: CGFloat = 68

    /// Source: `README-Lumen-V15.md` §18.4 & `paste-lumen-v15.html` line 618 `v12Particles(..., enter: true)`
    static let captureDuration: TimeInterval = 0.90
    static let capturePeakAlpha: CGFloat = 0.58
    static let captureMaskAngleDegrees: CGFloat = 138
    static let captureReflowDuration: TimeInterval = 0.46
    static let captureReflowCurve = V15CubicBezier(x1: 0.16, y1: 1.00, x2: 0.25, y2: 1.00)
    static let restoreSlotExpandDuration: TimeInterval = 0.38

    /// Source: `paste-lumen-v15.html` line 646 `v13Palette`
    static let fallbackPaletteCode: [NSColor] = [
      V15Color.hex("#a5c8f5"), V15Color.hex("#b6a1eb"), V15Color.hex("#91d6cb"), V15Color.hex("#f4f9ff")
    ]
    static let fallbackPaletteImage: [NSColor] = [
      V15Color.hex("#88addb"), V15Color.hex("#c5c8f2"), V15Color.hex("#f4e1f6"), V15Color.hex("#e7f8ff")
    ]
    static let fallbackPaletteLink: [NSColor] = [
      V15Color.hex("#b0dce5"), V15Color.hex("#9bb9e9"), V15Color.hex("#f0f8ff")
    ]
    static let fallbackPaletteDefault: [NSColor] = [
      V15Color.hex("#a9c8eb"), V15Color.hex("#c6d7f5"), V15Color.hex("#edf7ff"), V15Color.hex("#f8fdff")
    ]
  }

  // MARK: Toast Banner (.toast)

  enum Toast {
    /// Source: `paste-lumen-v15.html` line 6 `.toast` ->
    /// `padding: 11px 17px; background: #20324de8; color: white; font-size: 12px; border: 1px solid #ffffff38; border-radius: 13px; box-shadow: 0 8px 28px #10213a4d`
    static let background = V15Color.hex("#20324de8")
    static let borderColor = V15Color.hex("#ffffff38")
    static let textColor = V15Color.hex("#ffffff")
    static let actionColor = V15Color.hex("#b9d9ff")
    static let cornerRadius: CGFloat = 13
    static let paddingVertical: CGFloat = 11
    static let paddingHorizontal: CGFloat = 17
    static let fontSize: CGFloat = 12
    static let gap: CGFloat = 9
    static let autoDismissDelay: TimeInterval = 3.2
    static let shadow = V15ShadowSpec(
      offsetX: 0,
      offsetY: 8,
      blurRadius: 28,
      color: V15Color.hex("#10213a4d")
    )
  }
}

// MARK: - V15 Source Application Attribution Resolver (§5.1, §5.2, S01, A10)

/// Self-contained source app name and real macOS icon resolver for V15 surfaces.
/// Strictly never substitutes a device UUID for an unknown source application.
enum V15SourceAttribution {
  static let unknownLabel = "来源未知"

  private static let lock = NSLock()
  private static var resolvedNameCache: [String: String] = [:]

  static func displayName(for item: LumenClipboardItem) -> String {
    let raw = item.sourceApp.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !raw.isEmpty, raw != unknownLabel else { return unknownLabel }

    lock.lock()
    if let cached = resolvedNameCache[raw] {
      lock.unlock()
      return cached
    }
    lock.unlock()

    let resolved: String
    if looksLikeBundleID(raw) {
      resolved = resolveBundleIDName(raw)
    } else {
      resolved = raw
    }

    lock.lock()
    resolvedNameCache[raw] = resolved
    lock.unlock()
    return resolved
  }

  static func systemIcon(for item: LumenClipboardItem) -> NSImage? {
    let raw = item.sourceApp.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !raw.isEmpty, raw != unknownLabel else { return nil }
    if let icon = LumenSourceAppIconCache.shared.icon(forSourceApp: raw) {
      return icon
    }
    if looksLikeBundleID(raw),
       let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: raw) {
      return NSWorkspace.shared.icon(forFile: url.path)
    }
    let resolved = displayName(for: item)
    if resolved != raw && resolved != unknownLabel {
      return LumenSourceAppIconCache.shared.icon(forSourceApp: resolved)
    }
    return nil
  }

  private static func looksLikeBundleID(_ value: String) -> Bool {
    guard value.contains("."),
          !value.contains(where: { $0.isWhitespace || $0.isNewline }),
          !value.contains("/"),
          !value.contains("\\") else {
      return false
    }
    return value.split(separator: ".").count >= 2
  }

  private static func resolveBundleIDName(_ bundleID: String) -> String {
    for app in NSWorkspace.shared.runningApplications {
      if let bid = app.bundleIdentifier,
         bid.caseInsensitiveCompare(bundleID) == .orderedSame,
         let name = app.localizedName?.trimmingCharacters(in: .whitespacesAndNewlines),
         !name.isEmpty {
        return name
      }
    }
    if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) {
      if let bundle = Bundle(url: url) {
        if let display = (bundle.localizedInfoDictionary?["CFBundleDisplayName"] as? String)?
          .trimmingCharacters(in: .whitespacesAndNewlines), !display.isEmpty {
          return display
        }
        if let name = (bundle.localizedInfoDictionary?["CFBundleName"] as? String)?
          .trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
          return name
        }
      }
      let fsName = FileManager.default.displayName(atPath: url.path)
      let trimmed = fsName.lowercased().hasSuffix(".app") && fsName.count > 4
        ? String(fsName.dropLast(4))
        : fsName
      if !trimmed.isEmpty { return trimmed }
    }
    let segments = bundleID.split(separator: ".").map(String.init)
    if segments.count == 2, ["app", "exe"].contains(segments[1].lowercased()) {
      return segments[0]
    }
    return segments.last ?? bundleID
  }
}
