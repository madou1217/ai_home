import AppKit
import CoreGraphics
import Foundation
import PDFKit
import QuartzCore

// MARK: - V15 Orbit Close Affordance (.clip-remove + ::before + .ico)

/// Independent 28×28 DIP circular close affordance anchored at `top: 4, right: 7` inside
/// the card's shared `liftContainer` coordinate space (`README-Lumen-V15.md` §19.1,
/// `paste-lumen-v15.html` lines 192–205).
///
/// Strict guarantees:
/// - Hit area `28 × 28`; optical circular surface `22 × 22` (`3` DIP inset on all 4 sides).
/// - Vector X `13 × 13`, `1.9` grid-unit stroke, round caps (`M7.25 7.25 16.75 16.75 M16.75 7.25 7.25 16.75`).
/// - Default: `opacity: 0`, `scale: 0.80`, non-hittable (`pointer-events: none`).
/// - Reveal: `opacity -> 1` (100ms, delay 145ms), `scale -> 1` (240ms, delay 85ms).
/// - Hover: `scale: 1.08`, warm rose circle `#fff1f3` (light) / `#644454` (dark), X rotates `90°` + `scale(0.95)`.
/// - Press: `scale: 0.88`; Focus-visible: `2` DIP `#6c9eff` ring (`1` DIP offset).
/// - Click is strictly isolated and NEVER propagates to card paste.
final class V15OrbitCloseButton: NSView {
  override var isFlipped: Bool { true }

  private let transformHostLayer = CALayer()
  private let focusRingLayer = CALayer()
  private let surfaceShadowLayer = CALayer()
  private let surfaceClipLayer = CALayer()
  private let surfaceGradientLayer = CAGradientLayer()
  private let surfaceHoverFillLayer = CALayer()
  private let surfaceBorderLayer = CALayer()
  private let glyphLayer = CAShapeLayer()

  private var isDark = false
  private var isRevealed = false
  private var isHovered = false
  private var isPressed = false
  private var isKeyboardFocused = false
  private var isSuppressed = false

  private var revealScaleWork: DispatchWorkItem?
  private var revealOpacityWork: DispatchWorkItem?

  var onActivate: (() -> Void)?
  var onPointerHoverChanged: ((Bool) -> Void)?

  override init(frame frameRect: NSRect) {
    let hit = V15Tokens.Close.hitSize
    super.init(frame: NSRect(x: 0, y: 0, width: hit, height: hit))
    wantsLayer = true
    layer?.masksToBounds = false

    // Centered transform host keeps NSView.frame untouched while scaling around exact center (14, 14)
    transformHostLayer.anchorPoint = CGPoint(x: 0.5, y: 0.5)
    transformHostLayer.bounds = CGRect(x: 0, y: 0, width: hit, height: hit)
    transformHostLayer.position = CGPoint(x: hit * 0.5, y: hit * 0.5)
    transformHostLayer.masksToBounds = false
    layer?.addSublayer(transformHostLayer)

    // Focus-visible ring (`outline: 2px solid #6c9eff; outline-offset: 1px`)
    focusRingLayer.borderWidth = V15Tokens.Close.focusRingWidth
    focusRingLayer.borderColor = V15Tokens.Close.focusRingColor.cgColor
    focusRingLayer.backgroundColor = NSColor.clear.cgColor
    focusRingLayer.opacity = 0
    transformHostLayer.addSublayer(focusRingLayer)

    // 22×22 circular shadow host (3 DIP inset inside 28×28 hit box)
    surfaceShadowLayer.backgroundColor = NSColor.clear.cgColor
    transformHostLayer.addSublayer(surfaceShadowLayer)

    surfaceClipLayer.masksToBounds = true
    transformHostLayer.addSublayer(surfaceClipLayer)

    let gradPts = V15Materials.gradientPoints(cssDegrees: V15Tokens.Close.surfaceGradientDegrees, isFlipped: true)
    surfaceGradientLayer.startPoint = gradPts.0
    surfaceGradientLayer.endPoint = gradPts.1
    surfaceClipLayer.addSublayer(surfaceGradientLayer)

    surfaceHoverFillLayer.opacity = 0
    surfaceClipLayer.addSublayer(surfaceHoverFillLayer)

    surfaceBorderLayer.borderWidth = V15Tokens.Close.lightInnerBorderWidth
    surfaceBorderLayer.backgroundColor = NSColor.clear.cgColor
    transformHostLayer.addSublayer(surfaceBorderLayer)

    // 13×13 crisp vector X CAShapeLayer for GPU-smooth 90° rotation
    let gSize = V15Tokens.Close.glyphSize
    glyphLayer.bounds = CGRect(x: 0, y: 0, width: gSize, height: gSize)
    glyphLayer.path = V15Glyphs.closeXPath(in: gSize)
    glyphLayer.fillColor = NSColor.clear.cgColor
    glyphLayer.lineWidth = V15Glyphs.closeXStrokeWidth(for: gSize)
    glyphLayer.lineCap = .round
    glyphLayer.lineJoin = .round
    glyphLayer.contentsScale = NSScreen.main?.backingScaleFactor ?? 2.0
    transformHostLayer.addSublayer(glyphLayer)

    setAccessibilityRole(.button)
    setAccessibilityElement(true)
    setAccessibilityHelp("移除此条剪贴板历史记录，不删除原文件")
    toolTip = "移除记录 (Delete)"

    let tracking = NSTrackingArea(
      rect: .zero,
      options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
      owner: self,
      userInfo: nil
    )
    addTrackingArea(tracking)

    applyAppearance(isDark: V15Motion.isDarkTheme, animated: false)
    applyHiddenImmediate()
  }

  required init?(coder: NSCoder) { nil }

  deinit {
    cancelPendingRevealTimers()
  }

  override func viewDidChangeBackingProperties() {
    super.viewDidChangeBackingProperties()
    let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2.0
    glyphLayer.contentsScale = scale
  }

  override func layout() {
    super.layout()
    CATransaction.begin()
    CATransaction.setDisableActions(true)

    let hit = bounds
    transformHostLayer.bounds = CGRect(origin: .zero, size: hit.size)
    transformHostLayer.position = CGPoint(x: hit.midX, y: hit.midY)

    let localBounds = transformHostLayer.bounds
    let inset = V15Tokens.Close.surfaceInset
    let circleRect = localBounds.insetBy(dx: inset, dy: inset)
    let circleRadius = V15Tokens.Close.surfaceSize * 0.5

    let ringInset = -(V15Tokens.Close.focusRingOffset + V15Tokens.Close.focusRingWidth * 0.5)
    let ringRect = localBounds.insetBy(dx: ringInset, dy: ringInset)
    focusRingLayer.frame = ringRect
    focusRingLayer.cornerRadius = ringRect.width * 0.5

    surfaceShadowLayer.frame = circleRect
    surfaceShadowLayer.cornerRadius = circleRadius
    surfaceClipLayer.frame = circleRect
    surfaceClipLayer.cornerRadius = circleRadius
    surfaceGradientLayer.frame = surfaceClipLayer.bounds
    surfaceHoverFillLayer.frame = surfaceClipLayer.bounds
    surfaceBorderLayer.frame = circleRect
    surfaceBorderLayer.cornerRadius = circleRadius

    glyphLayer.position = CGPoint(x: localBounds.midX, y: localBounds.midY)

    applyCircleShadow()
    CATransaction.commit()
  }

  override func hitTest(_ point: NSPoint) -> NSView? {
    // Strictly match `pointer-events: none` when hidden or suppressed
    guard isRevealed && !isSuppressed else { return nil }
    return bounds.contains(point) ? self : nil
  }

  // MARK: Pointer Isolation (Never Propagate to Card Paste)

  override func mouseEntered(with event: NSEvent) {
    guard isRevealed && !isSuppressed else { return }
    isHovered = true
    applyInteractiveState(animated: true)
    onPointerHoverChanged?(true)
  }

  override func mouseExited(with event: NSEvent) {
    isHovered = false
    isPressed = false
    applyInteractiveState(animated: true)
    onPointerHoverChanged?(false)
  }

  override func mouseDown(with event: NSEvent) {
    guard isRevealed && !isSuppressed else { return }
    isPressed = true
    applyInteractiveState(animated: true)
  }

  override func mouseUp(with event: NSEvent) {
    let wasPressed = isPressed
    isPressed = false
    applyInteractiveState(animated: true)
    guard wasPressed && isRevealed && !isSuppressed else { return }
    let local = convert(event.locationInWindow, from: nil)
    if bounds.contains(local) {
      onActivate?()
    }
  }

  override func accessibilityPerformPress() -> Bool {
    guard !isSuppressed else { return false }
    onActivate?()
    return true
  }

  // MARK: State Transitions

  func configureAccessibility(itemTitle: String) {
    setAccessibilityLabel("移除 \(itemTitle)")
  }

  func applyAppearance(isDark: Bool, animated: Bool) {
    self.isDark = isDark
    let duration: TimeInterval = (animated && V15Motion.isEnabled) ? V15Tokens.Close.surfaceColorDuration : 0
    CATransaction.begin()
    CATransaction.setDisableActions(duration == 0)
    CATransaction.setAnimationDuration(duration)

    if isDark {
      surfaceGradientLayer.colors = [
        V15Tokens.Close.darkSurfaceStart.cgColor,
        V15Tokens.Close.darkSurfaceEnd.cgColor
      ]
      surfaceHoverFillLayer.backgroundColor = V15Tokens.Close.darkHoverSurfaceFill.cgColor
    } else {
      surfaceGradientLayer.colors = [
        V15Tokens.Close.lightSurfaceStart.cgColor,
        V15Tokens.Close.lightSurfaceEnd.cgColor
      ]
      surfaceHoverFillLayer.backgroundColor = V15Tokens.Close.lightHoverSurfaceFill.cgColor
    }
    applyInteractiveColorsAndShadow()
    CATransaction.commit()
  }

  func setSuppressed(_ suppressed: Bool) {
    isSuppressed = suppressed
    if suppressed {
      cancelPendingRevealTimers()
      isHovered = false
      isPressed = false
      applyHiddenImmediate()
    }
  }

  func setKeyboardFocused(_ focused: Bool, animated: Bool) {
    guard isKeyboardFocused != focused else { return }
    isKeyboardFocused = focused
    let useAnim = animated && V15Motion.isEnabled
    CATransaction.begin()
    CATransaction.setDisableActions(!useAnim)
    CATransaction.setAnimationDuration(0.16)
    focusRingLayer.opacity = focused ? 1.0 : 0.0
    CATransaction.commit()
  }

  func setRevealed(_ revealed: Bool, animated: Bool) {
    guard !isSuppressed else {
      applyHiddenImmediate()
      return
    }
    let effective = revealed || isKeyboardFocused
    guard effective != isRevealed else { return }
    isRevealed = effective
    cancelPendingRevealTimers()

    if !effective {
      isHovered = false
      isPressed = false
    }

    let useAnim = animated && V15Motion.isEnabled
    if !useAnim {
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      transformHostLayer.opacity = effective ? 1.0 : 0.0
      applyScaleTransform(effective ? currentVisibleScale() : V15Tokens.Close.hiddenScale)
      applyInteractiveColorsAndShadow()
      applyGlyphHoverTransform(animated: false)
      CATransaction.commit()
      return
    }

    if effective {
      // Source: `paste-lumen-v15.html` line 195:
      // opacity delay 145ms (100ms duration), scale delay 85ms (240ms duration)
      let scaleWork = DispatchWorkItem { [weak self] in
        guard let self, self.isRevealed, !self.isSuppressed else { return }
        self.animateButtonScale(to: self.currentVisibleScale(), duration: V15Tokens.Close.scaleDuration)
      }
      revealScaleWork = scaleWork
      DispatchQueue.main.asyncAfter(deadline: .now() + V15Tokens.Close.revealScaleDelay, execute: scaleWork)

      let opacityWork = DispatchWorkItem { [weak self] in
        guard let self, self.isRevealed, !self.isSuppressed else { return }
        CATransaction.begin()
        CATransaction.setAnimationDuration(V15Tokens.Close.opacityDuration)
        CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .easeOut))
        self.transformHostLayer.opacity = 1.0
        CATransaction.commit()
      }
      revealOpacityWork = opacityWork
      DispatchQueue.main.asyncAfter(deadline: .now() + V15Tokens.Close.revealOpacityDelay, execute: opacityWork)
    } else {
      // Leave: zero delay, opacity fades out in 100ms, scale shrinks back to 0.80 in 240ms
      CATransaction.begin()
      CATransaction.setAnimationDuration(V15Tokens.Close.opacityDuration)
      CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .easeIn))
      transformHostLayer.opacity = 0.0
      CATransaction.commit()

      animateButtonScale(to: V15Tokens.Close.hiddenScale, duration: V15Tokens.Close.scaleDuration)
      applyInteractiveState(animated: true)
    }
  }

  private func cancelPendingRevealTimers() {
    revealScaleWork?.cancel()
    revealScaleWork = nil
    revealOpacityWork?.cancel()
    revealOpacityWork = nil
  }

  private func applyHiddenImmediate() {
    isRevealed = false
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    transformHostLayer.opacity = 0.0
    focusRingLayer.opacity = 0.0
    applyScaleTransform(V15Tokens.Close.hiddenScale)
    applyInteractiveColorsAndShadow()
    applyGlyphHoverTransform(animated: false)
    CATransaction.commit()
  }

  private func currentVisibleScale() -> CGFloat {
    if isPressed { return V15Tokens.Close.pressScale }
    if isHovered { return V15Tokens.Close.hoverScale }
    return V15Tokens.Close.revealedScale
  }

  private func applyInteractiveState(animated: Bool) {
    let useAnim = animated && V15Motion.isEnabled

    if isRevealed {
      let targetScale = currentVisibleScale()
      if useAnim {
        animateButtonScale(to: targetScale, duration: isPressed ? 0.14 : V15Tokens.Close.scaleDuration)
      } else {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        applyScaleTransform(targetScale)
        CATransaction.commit()
      }
    }

    CATransaction.begin()
    CATransaction.setDisableActions(!useAnim)
    CATransaction.setAnimationDuration(V15Tokens.Close.surfaceColorDuration)
    applyInteractiveColorsAndShadow()
    CATransaction.commit()

    applyGlyphHoverTransform(animated: useAnim)
  }

  private func applyInteractiveColorsAndShadow() {
    surfaceHoverFillLayer.opacity = isHovered ? 1.0 : 0.0
    if isDark {
      surfaceBorderLayer.borderColor = V15Tokens.Close.darkInnerBorderColor.cgColor
      glyphLayer.strokeColor = (isHovered
        ? V15Tokens.Close.darkHoverGlyphColor
        : V15Tokens.Close.darkGlyphColor).cgColor
    } else {
      surfaceBorderLayer.borderColor = (isHovered
        ? V15Tokens.Close.lightHoverBorderColor
        : V15Tokens.Close.lightInnerBorderColor).cgColor
      glyphLayer.strokeColor = (isHovered
        ? V15Tokens.Close.lightHoverGlyphColor
        : V15Tokens.Close.lightGlyphColor).cgColor
    }
    applyCircleShadow()
  }

  private func applyCircleShadow() {
    let radius = V15Tokens.Close.surfaceSize * 0.5
    let spec: V15ShadowSpec
    if isDark {
      spec = V15Tokens.Close.darkSurfaceShadow
    } else {
      spec = isHovered ? V15Tokens.Close.lightHoverShadow : V15Tokens.Close.lightSurfaceShadow
    }
    V15Materials.applyShadow(to: surfaceShadowLayer, spec: spec, cornerRadius: radius)
  }

  private func applyGlyphHoverTransform(animated: Bool) {
    let target: CATransform3D
    if isHovered {
      let rot = CATransform3DMakeRotation(V15Tokens.Close.hoverGlyphRotationRadians, 0, 0, 1)
      let scl = CATransform3DMakeScale(V15Tokens.Close.hoverGlyphScale, V15Tokens.Close.hoverGlyphScale, 1)
      target = CATransform3DConcat(scl, rot)
    } else {
      target = CATransform3DIdentity
    }
    CATransaction.begin()
    CATransaction.setDisableActions(!animated)
    CATransaction.setAnimationDuration(V15Tokens.Close.glyphHoverDuration)
    CATransaction.setAnimationTimingFunction(V15Tokens.Close.glyphHoverCurve.timingFunction)
    glyphLayer.transform = target
    CATransaction.commit()
  }

  private func animateButtonScale(to scale: CGFloat, duration: TimeInterval) {
    CATransaction.begin()
    CATransaction.setAnimationDuration(duration)
    CATransaction.setAnimationTimingFunction(V15Tokens.Close.scaleCurve.timingFunction)
    applyScaleTransform(scale)
    CATransaction.commit()
  }

  private func applyScaleTransform(_ scale: CGFloat) {
    transformHostLayer.transform = CATransform3DMakeScale(scale, scale, 1.0)
  }
}

// MARK: - Language-Aware Code Syntax Highlighter (Orbit Mini Code Box, §18.2 / A60)

private enum V15OrbitCodeHighlighter {
  private static let keywordSets: [String: Set<String>] = [
    "js": ["async", "await", "function", "const", "let", "var", "return", "if", "else", "for", "while", "import", "export", "from", "default", "class", "new", "try", "catch", "true", "false", "null"],
    "ts": ["async", "await", "function", "const", "let", "var", "return", "if", "else", "interface", "type", "enum", "export", "import", "from", "class", "public", "private", "readonly", "string", "number", "boolean", "void", "true", "false"],
    "go": ["package", "import", "func", "type", "struct", "interface", "return", "if", "else", "for", "range", "go", "defer", "chan", "select", "case", "var", "const", "map", "nil", "true", "false"],
    "py": ["def", "async", "await", "class", "import", "from", "return", "if", "elif", "else", "for", "in", "while", "with", "as", "try", "except", "None", "True", "False", "lambda", "yield"],
    "rs": ["fn", "pub", "let", "mut", "struct", "enum", "impl", "trait", "use", "mod", "match", "if", "else", "for", "in", "return", "async", "await", "Self", "self", "true", "false"],
    "swift": ["struct", "class", "enum", "let", "var", "func", "return", "import", "if", "else", "guard", "for", "in", "switch", "case", "async", "await", "public", "private", "final", "true", "false", "nil"],
    "php": ["function", "class", "public", "private", "protected", "return", "if", "else", "foreach", "as", "namespace", "use", "new", "echo", "true", "false", "null"],
    "sql": ["SELECT", "FROM", "WHERE", "INSERT", "INTO", "UPDATE", "SET", "DELETE", "CREATE", "TABLE", "JOIN", "LEFT", "ON", "GROUP", "BY", "ORDER", "LIMIT", "AS", "AND", "OR", "NULL"],
    "sh": ["if", "then", "else", "fi", "for", "in", "do", "done", "export", "local", "return", "set", "echo", "case", "esac"],
    "css": ["display", "position", "transition", "transform", "background", "color", "border", "padding", "margin", "flex", "grid", "opacity", "width", "height"]
  ]

  static func attributedString(code raw: String, language: String) -> NSAttributedString {
    let lines = raw.split(separator: "\n", omittingEmptySubsequences: false).prefix(V15Tokens.Body.codeMaxLines)
    let snippet = lines.joined(separator: "\n")

    let font = NSFont.monospacedSystemFont(ofSize: V15Tokens.Body.codeFontSize, weight: .regular)
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineHeightMultiple = V15Tokens.Body.codeLineHeightMultiple
    paragraph.lineBreakMode = .byTruncatingTail

    let baseAttrs: [NSAttributedString.Key: Any] = [
      .font: font,
      .foregroundColor: V15Tokens.Body.codeTextColor,
      .paragraphStyle: paragraph,
      .ligature: 0 // §18.3: disable programming ligatures
    ]
    let attr = NSMutableAttributedString(string: snippet, attributes: baseAttrs)

    // §18.2 / A60: Never color unrecognized snippets as JavaScript
    let lang = language.lowercased()
    guard lang != "unknown", !snippet.isEmpty else {
      return attr
    }

    let nsText = snippet as NSString
    let fullRange = NSRange(location: 0, length: nsText.length)

    // Numbers
    applyRegex(#"\b\d+(?:\.\d+)?\b"#, in: nsText, range: fullRange, color: V15Tokens.Body.codeNumber, to: attr)

    // Keywords
    let keywords = keywordSets[lang] ?? keywordSets["js"] ?? []
    let kwColor: NSColor
    switch lang {
    case "go": kwColor = V15Tokens.Body.codeKeywordGo
    case "py": kwColor = V15Tokens.Body.codeKeywordPy
    default: kwColor = V15Tokens.Body.codeKeyword
    }
    if !keywords.isEmpty {
      let pattern: String
      if lang == "sql" {
        pattern = "(?i)\\b(" + keywords.joined(separator: "|") + ")\\b"
      } else {
        pattern = "\\b(" + keywords.joined(separator: "|") + ")\\b"
      }
      applyRegex(pattern, in: nsText, range: fullRange, color: kwColor, to: attr)
    }

    if lang == "php" {
      applyRegex(#"\$[A-Za-z_]\w*"#, in: nsText, range: fullRange, color: V15Tokens.Body.codeVariablePhp, to: attr)
    }

    // Strings
    applyRegex(#""(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'"#, in: nsText, range: fullRange, color: V15Tokens.Body.codeString, to: attr)

    // Comments
    applyRegex(#"//[^\n]*|#[^\n]*|--[^\n]*"#, in: nsText, range: fullRange, color: V15Tokens.Body.codeComment, to: attr)

    return attr
  }

  private static func applyRegex(
    _ pattern: String,
    in text: NSString,
    range: NSRange,
    color: NSColor,
    to attr: NSMutableAttributedString
  ) {
    guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else { return }
    for match in regex.matches(in: text as String, options: [], range: range) {
      attr.addAttribute(.foregroundColor, value: color, range: match.range)
    }
  }
}

// MARK: - V15 Orbit Card Item View (.rail-item + .clip.v10card + sibling .clip-remove)

/// Complete V15 Orbit rail item hosting BOTH the card surface and the sibling close affordance
/// inside a single `liftContainer` coordinate space (`README-Lumen-V15.md` §19.1).
final class V15OrbitCardItemView: NSView {
  override var isFlipped: Bool { true }

  enum LiftState: Equatable {
    case idle     // 0 DIP
    case near     // -2 DIP
    case hovered  // -5 DIP
    case selected // -7 DIP

    var offsetY: CGFloat {
      switch self {
      case .idle: return V15Tokens.Card.liftDefault
      case .near: return V15Tokens.Card.liftNear
      case .hovered: return V15Tokens.Card.liftHover
      case .selected: return V15Tokens.Card.liftSelected
      }
    }
  }

  private(set) var item: LumenClipboardItem
  private(set) var identity: LumenContentIdentity
  private var slotIndex: Int = 0
  private var isDark = false
  private var glowEnabled = true
  private var isSelected = false
  private var isNear = false
  private var isHovered = false
  private var isKeyboardCardFocused = false
  private var isKeyboardCloseFocused = false
  private var currentLift: CGFloat = 0

  // Shared single lift coordinate space (`cardSurfaceView` + sibling `closeButton`)
  private let liftContainer = V15FlippedContainerView()
  private let cardSurfaceView = V15CardSurfaceView()
  private let closeButton = V15OrbitCloseButton()

  // Header (.clip-head: exact 34 DIP height, y = 1 inside 1 DIP border -> center y = 18 == close hit 4+14)
  private let headerView = V15FlippedContainerView()
  private let kindGlyphView = NSImageView()
  private let kindLabel = NSTextField(labelWithString: "")
  private let timeLabel = NSTextField(labelWithString: "")
  private var headerTrailingConstraint: NSLayoutConstraint?
  private var headerYieldLeaveWork: DispatchWorkItem?
  private var isHeaderYielded = false

  // Body (.clip-main)
  private let bodyContainer = V15FlippedContainerView()
  private var bodyCacheKey = ""
  private var asyncImageToken = 0

  // Footer (.clip-foot: min-height 31 DIP, padding 8 12 10)
  private let footerView = V15FlippedContainerView()
  private let sourceIconBox = V15FlippedContainerView()
  private let sourceIconImageView = NSImageView()
  private let sourceNameLabel = NSTextField(labelWithString: "")
  private let pinIconView = NSImageView()
  private let keyBadgeView = V15FlippedContainerView()
  private let keyBadgeLabel = NSTextField(labelWithString: "")

  // Pointer drag/click isolation
  private var mouseDownLocationInWindow: NSPoint?

  // Callbacks
  var onHoverChanged: ((String, Bool) -> Void)?
  var onPasteRequested: ((String) -> Void)?
  var onRemoveRequested: ((String) -> Void)?
  var onContextMenuRequested: ((String, NSEvent, NSView) -> Void)?

  init(item: LumenClipboardItem, frame: NSRect) {
    self.item = item
    self.identity = item.contentIdentity
    super.init(frame: frame)
    wantsLayer = true
    layer?.masksToBounds = false

    buildHierarchy()
    configureTracking()
    update(item: item, slotIndex: 0, isDark: V15Motion.isDarkTheme, glowEnabled: V15Motion.glowEnabled)
  }

  required init?(coder: NSCoder) { nil }

  deinit {
    headerYieldLeaveWork?.cancel()
  }

  private func buildHierarchy() {
    liftContainer.wantsLayer = true
    liftContainer.layer?.masksToBounds = false
    liftContainer.frame = bounds
    addSubview(liftContainer)

    cardSurfaceView.frame = bounds
    liftContainer.addSubview(cardSurfaceView)

    // Sibling close button in exact same liftContainer coordinate space (never nested inside card click)
    closeButton.onActivate = { [weak self] in
      guard let self else { return }
      self.onRemoveRequested?(self.item.id)
    }
    closeButton.onPointerHoverChanged = { [weak self] entering in
      guard let self else { return }
      if entering {
        self.onHoverChanged?(self.item.id, true)
      }
    }
    liftContainer.addSubview(closeButton)

    // Header inside cardSurfaceView.contentClipView
    headerView.translatesAutoresizingMaskIntoConstraints = false
    cardSurfaceView.contentClipView.addSubview(headerView)

    kindGlyphView.imageScaling = .scaleProportionallyDown
    kindGlyphView.translatesAutoresizingMaskIntoConstraints = false
    headerView.addSubview(kindGlyphView)

    kindLabel.font = .systemFont(ofSize: V15Tokens.Header.kindFontSize, weight: .medium)
    kindLabel.lineBreakMode = .byTruncatingTail
    kindLabel.maximumNumberOfLines = 1
    kindLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    kindLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
    kindLabel.translatesAutoresizingMaskIntoConstraints = false
    headerView.addSubview(kindLabel)

    timeLabel.font = .monospacedDigitSystemFont(ofSize: V15Tokens.Header.timeFontSize, weight: .regular)
    timeLabel.alignment = .right
    timeLabel.lineBreakMode = .byClipping
    timeLabel.maximumNumberOfLines = 1
    timeLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
    timeLabel.setContentHuggingPriority(.required, for: .horizontal)
    timeLabel.translatesAutoresizingMaskIntoConstraints = false
    headerView.addSubview(timeLabel)

    let b = V15Tokens.Card.borderWidth
    let trailingConstraint = timeLabel.trailingAnchor.constraint(
      equalTo: headerView.trailingAnchor,
      constant: -V15Tokens.Header.paddingRightDefault
    )
    headerTrailingConstraint = trailingConstraint

    NSLayoutConstraint.activate([
      headerView.topAnchor.constraint(equalTo: cardSurfaceView.contentClipView.topAnchor, constant: b),
      headerView.leadingAnchor.constraint(equalTo: cardSurfaceView.contentClipView.leadingAnchor, constant: b),
      headerView.trailingAnchor.constraint(equalTo: cardSurfaceView.contentClipView.trailingAnchor, constant: -b),
      headerView.heightAnchor.constraint(equalToConstant: V15Tokens.Header.height),

      kindGlyphView.leadingAnchor.constraint(equalTo: headerView.leadingAnchor, constant: V15Tokens.Header.paddingLeft),
      kindGlyphView.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),
      kindGlyphView.widthAnchor.constraint(equalToConstant: V15Tokens.Header.glyphSize),
      kindGlyphView.heightAnchor.constraint(equalToConstant: V15Tokens.Header.glyphSize),

      kindLabel.leadingAnchor.constraint(equalTo: kindGlyphView.trailingAnchor, constant: V15Tokens.Header.gap),
      kindLabel.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),
      kindLabel.trailingAnchor.constraint(lessThanOrEqualTo: timeLabel.leadingAnchor, constant: -V15Tokens.Header.gap),

      timeLabel.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),
      trailingConstraint
    ])

    // Body (.clip-main)
    bodyContainer.wantsLayer = true
    bodyContainer.layer?.masksToBounds = true
    bodyContainer.translatesAutoresizingMaskIntoConstraints = false
    cardSurfaceView.contentClipView.addSubview(bodyContainer)

    // Footer (.clip-foot)
    footerView.translatesAutoresizingMaskIntoConstraints = false
    cardSurfaceView.contentClipView.addSubview(footerView)

    sourceIconBox.wantsLayer = true
    sourceIconBox.layer?.cornerRadius = V15Tokens.Footer.sourceIconCornerRadius
    sourceIconBox.layer?.masksToBounds = true
    sourceIconBox.translatesAutoresizingMaskIntoConstraints = false
    footerView.addSubview(sourceIconBox)

    sourceIconImageView.imageScaling = .scaleProportionallyUpOrDown
    sourceIconImageView.translatesAutoresizingMaskIntoConstraints = false
    sourceIconBox.addSubview(sourceIconImageView)

    sourceNameLabel.font = .systemFont(ofSize: V15Tokens.Footer.sourceNameFontSize, weight: .regular)
    sourceNameLabel.lineBreakMode = .byTruncatingTail
    sourceNameLabel.maximumNumberOfLines = 1
    sourceNameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    sourceNameLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
    sourceNameLabel.translatesAutoresizingMaskIntoConstraints = false
    footerView.addSubview(sourceNameLabel)

    pinIconView.image = V15Glyphs.actionImage(.pin, size: V15Tokens.Footer.pinGlyphSize, color: V15Tokens.Footer.pinColor)
    pinIconView.translatesAutoresizingMaskIntoConstraints = false
    footerView.addSubview(pinIconView)

    keyBadgeView.wantsLayer = true
    keyBadgeView.layer?.cornerRadius = V15Tokens.Footer.keyCornerRadius
    keyBadgeView.layer?.masksToBounds = false
    keyBadgeView.translatesAutoresizingMaskIntoConstraints = false
    footerView.addSubview(keyBadgeView)

    keyBadgeLabel.font = .monospacedDigitSystemFont(ofSize: V15Tokens.Footer.keyFontSize, weight: .medium)
    keyBadgeLabel.alignment = .center
    keyBadgeLabel.translatesAutoresizingMaskIntoConstraints = false
    keyBadgeView.addSubview(keyBadgeLabel)

    NSLayoutConstraint.activate([
      footerView.leadingAnchor.constraint(equalTo: cardSurfaceView.contentClipView.leadingAnchor, constant: b),
      footerView.trailingAnchor.constraint(equalTo: cardSurfaceView.contentClipView.trailingAnchor, constant: -b),
      footerView.bottomAnchor.constraint(equalTo: cardSurfaceView.contentClipView.bottomAnchor, constant: -b),
      footerView.heightAnchor.constraint(equalToConstant: V15Tokens.Footer.minHeight),

      bodyContainer.topAnchor.constraint(equalTo: headerView.bottomAnchor, constant: V15Tokens.Body.paddingTop),
      bodyContainer.leadingAnchor.constraint(equalTo: cardSurfaceView.contentClipView.leadingAnchor, constant: b + V15Tokens.Body.paddingHorizontal),
      bodyContainer.trailingAnchor.constraint(equalTo: cardSurfaceView.contentClipView.trailingAnchor, constant: -(b + V15Tokens.Body.paddingHorizontal)),
      bodyContainer.bottomAnchor.constraint(equalTo: footerView.topAnchor, constant: -V15Tokens.Body.paddingBottom),

      sourceIconBox.leadingAnchor.constraint(equalTo: footerView.leadingAnchor, constant: V15Tokens.Footer.paddingHorizontal),
      sourceIconBox.centerYAnchor.constraint(equalTo: footerView.centerYAnchor),
      sourceIconBox.widthAnchor.constraint(equalToConstant: V15Tokens.Footer.sourceIconSize),
      sourceIconBox.heightAnchor.constraint(equalToConstant: V15Tokens.Footer.sourceIconSize),

      sourceIconImageView.topAnchor.constraint(equalTo: sourceIconBox.topAnchor),
      sourceIconImageView.bottomAnchor.constraint(equalTo: sourceIconBox.bottomAnchor),
      sourceIconImageView.leadingAnchor.constraint(equalTo: sourceIconBox.leadingAnchor),
      sourceIconImageView.trailingAnchor.constraint(equalTo: sourceIconBox.trailingAnchor),

      sourceNameLabel.leadingAnchor.constraint(equalTo: sourceIconBox.trailingAnchor, constant: V15Tokens.Footer.gap),
      sourceNameLabel.centerYAnchor.constraint(equalTo: footerView.centerYAnchor),
      sourceNameLabel.trailingAnchor.constraint(lessThanOrEqualTo: pinIconView.leadingAnchor, constant: -V15Tokens.Footer.gap),

      pinIconView.centerYAnchor.constraint(equalTo: footerView.centerYAnchor),
      pinIconView.trailingAnchor.constraint(equalTo: keyBadgeView.leadingAnchor, constant: -V15Tokens.Footer.gap),
      pinIconView.widthAnchor.constraint(equalToConstant: V15Tokens.Footer.pinGlyphSize),
      pinIconView.heightAnchor.constraint(equalToConstant: V15Tokens.Footer.pinGlyphSize),

      keyBadgeView.trailingAnchor.constraint(equalTo: footerView.trailingAnchor, constant: -V15Tokens.Footer.paddingHorizontal),
      keyBadgeView.centerYAnchor.constraint(equalTo: footerView.centerYAnchor),
      keyBadgeView.widthAnchor.constraint(greaterThanOrEqualToConstant: V15Tokens.Footer.keyMinWidth),
      keyBadgeView.heightAnchor.constraint(equalToConstant: V15Tokens.Footer.keyHeight),

      keyBadgeLabel.leadingAnchor.constraint(equalTo: keyBadgeView.leadingAnchor, constant: 4),
      keyBadgeLabel.trailingAnchor.constraint(equalTo: keyBadgeView.trailingAnchor, constant: -4),
      keyBadgeLabel.centerYAnchor.constraint(equalTo: keyBadgeView.centerYAnchor)
    ])

    setAccessibilityRole(.button)
    setAccessibilityElement(true)
  }

  private func configureTracking() {
    let tracking = NSTrackingArea(
      rect: .zero,
      options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect],
      owner: self,
      userInfo: nil
    )
    addTrackingArea(tracking)
  }

  private var lastLayoutSize: NSSize = .zero

  override func layout() {
    super.layout()
    if lastLayoutSize != bounds.size {
      lastLayoutSize = bounds.size
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      liftContainer.layer?.transform = CATransform3DIdentity
      liftContainer.frame = bounds
      liftContainer.layer?.transform = CATransform3DMakeTranslation(0, currentLift, 0)
      CATransaction.commit()
    }
    cardSurfaceView.frame = liftContainer.bounds
    // Source: `README-Lumen-V15.md` §19.1 `close.anchor`: top 4, right 7 relative to card outer edge
    closeButton.frame = NSRect(
      x: liftContainer.bounds.width - V15Tokens.Close.rightOffset - V15Tokens.Close.hitSize,
      y: V15Tokens.Close.topOffset,
      width: V15Tokens.Close.hitSize,
      height: V15Tokens.Close.hitSize
    )
  }

  // MARK: Data Binding & Visual States

  func update(item nextItem: LumenClipboardItem, slotIndex: Int, isDark: Bool, glowEnabled: Bool) {
    let themeChanged = (self.isDark != isDark) || (self.glowEnabled != glowEnabled)
    self.item = nextItem
    self.identity = nextItem.contentIdentity
    self.slotIndex = slotIndex
    self.isDark = isDark
    self.glowEnabled = glowEnabled

    kindGlyphView.image = V15Glyphs.identityImage(
      for: identity,
      size: V15Tokens.Header.glyphSize,
      isDark: isDark
    )
    kindLabel.stringValue = identity.displayName
    kindLabel.textColor = isDark ? V15Tokens.Header.kindDarkColor : V15Tokens.Header.kindLightColor
    timeLabel.stringValue = nextItem.relativeTime
    timeLabel.textColor = isDark ? V15Tokens.Header.timeDarkColor : V15Tokens.Header.timeLightColor

    let sourceName = V15SourceAttribution.displayName(for: nextItem)
    sourceNameLabel.stringValue = sourceName
    sourceNameLabel.textColor = isDark ? V15Tokens.Footer.sourceDarkColor : V15Tokens.Footer.sourceLightColor

    if let appIcon = V15SourceAttribution.systemIcon(for: nextItem) {
      sourceIconBox.layer?.backgroundColor = NSColor.clear.cgColor
      sourceIconImageView.image = appIcon
    } else {
      sourceIconBox.layer?.backgroundColor = V15Tokens.Footer.sourceFallbackBackground.cgColor
      sourceIconImageView.image = V15Glyphs.actionImage(.more, size: 11, color: .white, strokeWidth: 1.8)
    }

    pinIconView.isHidden = !nextItem.pinned
    updateShortcutBadge()
    closeButton.configureAccessibility(itemTitle: nextItem.displayTitle)
    closeButton.applyAppearance(isDark: isDark, animated: false)

    let nextBodyKey = "\(nextItem.id):\(nextItem.sha256):\(identity.glyphID):\(isDark ? 1 : 0):\(nextItem.effectiveText.prefix(64).hashValue):\(nextItem.files.count)"
    if nextBodyKey != bodyCacheKey || themeChanged {
      bodyCacheKey = nextBodyKey
      rebuildBodyContent()
    }

    setAccessibilityLabel("\(identity.displayName)，\(nextItem.displayTitle)，来源 \(sourceName)，\(nextItem.relativeTime)")
    applyCardAndCloseStates(animated: false)
  }

  func updateSlotIndex(_ index: Int) {
    slotIndex = index
    updateShortcutBadge()
  }

  func setInteractionState(
    selected: Bool,
    near: Bool,
    hovered: Bool,
    keyboardCardFocused: Bool,
    keyboardCloseFocused: Bool,
    animated: Bool
  ) {
    let changed = (isSelected != selected)
      || (isNear != near)
      || (isHovered != hovered)
      || (isKeyboardCardFocused != keyboardCardFocused)
      || (isKeyboardCloseFocused != keyboardCloseFocused)
    isSelected = selected
    isNear = near
    isHovered = hovered
    isKeyboardCardFocused = keyboardCardFocused
    isKeyboardCloseFocused = keyboardCloseFocused

    if changed {
      applyCardAndCloseStates(animated: animated)
    }
  }

  func setSuppressCloseForMotion(_ suppressed: Bool) {
    closeButton.setSuppressed(suppressed)
  }

  /// Captures a crisp bitmap snapshot of the card surface (excluding the close button)
  /// for real-texture soft dissolution and capture aggregation.
  func captureSnapshotImage() -> CGImage? {
    layoutSubtreeIfNeeded()
    let rect = cardSurfaceView.bounds
    guard rect.width > 1, rect.height > 1,
          let rep = cardSurfaceView.bitmapImageRepForCachingDisplay(in: rect) else {
      return nil
    }
    cardSurfaceView.cacheDisplay(in: rect, to: rep)
    return rep.cgImage
  }

  /// Plays brief paste lift confirmation (`translateY(-22) scale(.96) opacity .3`, HTML line 21).
  func playPasteConfirmation() {
    closeButton.setSuppressed(true)
    guard V15Motion.isEnabled, let layer = liftContainer.layer else { return }
    CATransaction.begin()
    CATransaction.setAnimationDuration(V15Tokens.Card.pasteFeedbackDuration)
    CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .easeOut))
    var t = CATransform3DIdentity
    let cx = bounds.midX
    let cy = bounds.midY
    t = CATransform3DTranslate(t, cx, cy + V15Tokens.Card.pasteLiftOffsetY, 0)
    t = CATransform3DScale(t, V15Tokens.Card.pasteLiftScale, V15Tokens.Card.pasteLiftScale, 1)
    t = CATransform3DTranslate(t, -cx, -cy, 0)
    layer.transform = t
    layer.opacity = V15Tokens.Card.pasteLiftOpacity
    CATransaction.commit()
  }

  /// Restores card opacity, lift transform, and close affordance after dismiss or paste failure.
  func resetPasteConfirmation() {
    closeButton.setSuppressed(false)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    liftContainer.layer?.opacity = 1.0
    liftContainer.layer?.transform = CATransform3DMakeTranslation(0, currentLift, 0)
    CATransaction.commit()
  }

  // MARK: Private State Application

  private func resolveLiftState() -> LiftState {
    // Exact CSS cascade precedence (`paste-lumen-v15.html` lines 185–188):
    // selected (-7) > hover/focus-within (-5) > near (-2) > default (0)
    if isSelected { return .selected }
    if isHovered || isKeyboardCardFocused || isKeyboardCloseFocused { return .hovered }
    if isNear { return .near }
    return .idle
  }

  private func applyCardAndCloseStates(animated: Bool) {
    let revealAffordance = isHovered || isKeyboardCardFocused || isKeyboardCloseFocused

    // 1. Unified lift in single shared coordinate space (320ms cubic-bezier(.2,.9,.25,1.2))
    let targetLift = resolveLiftState().offsetY
    if abs(targetLift - currentLift) > 0.01 {
      currentLift = targetLift
      let useAnim = animated && V15Motion.isEnabled
      CATransaction.begin()
      if !useAnim {
        CATransaction.setDisableActions(true)
      } else {
        CATransaction.setAnimationDuration(V15Tokens.Card.liftDuration)
        CATransaction.setAnimationTimingFunction(V15Tokens.Card.liftCurve.timingFunction)
      }
      liftContainer.layer?.transform = CATransform3DMakeTranslation(0, targetLift, 0)
      CATransaction.commit()
    }

    // 2. Card glass material, shadow, border, specular sheen
    cardSurfaceView.applyState(
      isDark: isDark,
      isSelected: isSelected,
      isHovered: isHovered || isKeyboardCardFocused,
      glowEnabled: glowEnabled,
      animated: animated
    )

    // 3. Header time-yield (`padding-right`: 12 <-> 43, 210ms, leave delay 100ms)
    updateHeaderTimeYield(expanded: revealAffordance, animated: animated)

    // 4. Close affordance reveal + focus-visible state
    closeButton.setKeyboardFocused(isKeyboardCloseFocused, animated: animated)
    closeButton.setRevealed(revealAffordance, animated: animated)

    // 5. Footer shortcut key badge
    updateShortcutBadge()
  }

  private func updateHeaderTimeYield(expanded: Bool, animated: Bool) {
    headerYieldLeaveWork?.cancel()
    headerYieldLeaveWork = nil

    guard expanded != isHeaderYielded else { return }
    let targetInset = expanded ? V15Tokens.Header.paddingRightHover : V15Tokens.Header.paddingRightDefault
    let useAnim = animated && V15Motion.isEnabled

    let applyInset: () -> Void = { [weak self] in
      guard let self, let constraint = self.headerTrailingConstraint else { return }
      self.isHeaderYielded = expanded
      if !useAnim {
        constraint.constant = -targetInset
        self.headerView.layoutSubtreeIfNeeded()
        return
      }
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = V15Tokens.Header.yieldDuration
        ctx.timingFunction = V15Tokens.Header.yieldCurve.timingFunction
        ctx.allowsImplicitAnimation = true
        constraint.animator().constant = -targetInset
        self.headerView.layoutSubtreeIfNeeded()
      }
    }

    if expanded || !useAnim {
      applyInset()
    } else {
      // Source: `paste-lumen-v15.html` line 190 -> leave delay `100ms` so X hides before time glides back
      let work = DispatchWorkItem { [weak self] in
        guard let self else { return }
        if !(self.isHovered || self.isKeyboardCardFocused || self.isKeyboardCloseFocused) {
          applyInset()
        }
      }
      headerYieldLeaveWork = work
      DispatchQueue.main.asyncAfter(deadline: .now() + V15Tokens.Header.yieldLeaveDelay, execute: work)
    }
  }

  private func updateShortcutBadge() {
    guard slotIndex >= 0 && slotIndex < 9 else {
      keyBadgeView.isHidden = true
      return
    }
    keyBadgeView.isHidden = false
    keyBadgeLabel.stringValue = "\(slotIndex + 1)"

    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if isSelected {
      let bg = isDark ? V15Tokens.Footer.keySelectedDarkBackground : V15Tokens.Footer.keySelectedLightBackground
      keyBadgeView.layer?.backgroundColor = bg.cgColor
      keyBadgeLabel.textColor = V15Tokens.Footer.keySelectedTextColor
      keyBadgeView.alphaValue = 1.0
      if glowEnabled, let layer = keyBadgeView.layer {
        V15Materials.applyShadow(to: layer, spec: V15Tokens.Footer.keySelectedGlow, cornerRadius: V15Tokens.Footer.keyCornerRadius)
      } else if let layer = keyBadgeView.layer {
        V15Materials.clearShadow(on: layer)
      }
    } else {
      keyBadgeView.layer?.backgroundColor = NSColor.clear.cgColor
      keyBadgeLabel.textColor = isDark ? V15Tokens.Footer.sourceDarkColor : V15Tokens.Footer.sourceLightColor
      keyBadgeView.alphaValue = V15Tokens.Footer.keyUnselectedOpacity
      if let layer = keyBadgeView.layer {
        V15Materials.clearShadow(on: layer)
      }
    }
    CATransaction.commit()
  }

  // MARK: Pointer Events (Isolated from Close Button)

  override func mouseEntered(with event: NSEvent) {
    onHoverChanged?(item.id, true)
  }

  override func mouseExited(with event: NSEvent) {
    onHoverChanged?(item.id, false)
  }

  override func mouseMoved(with event: NSEvent) {
    let pt = cardSurfaceView.convert(event.locationInWindow, from: nil)
    cardSurfaceView.updateSpecularPoint(pt)
    onHoverChanged?(item.id, true)
  }

  override func mouseDown(with event: NSEvent) {
    let localInLift = liftContainer.convert(event.locationInWindow, from: nil)
    if closeButton.hitTest(closeButton.convert(localInLift, from: liftContainer)) != nil {
      return
    }
    mouseDownLocationInWindow = event.locationInWindow
    super.mouseDown(with: event)
  }

  override func mouseUp(with event: NSEvent) {
    defer { mouseDownLocationInWindow = nil }
    guard let start = mouseDownLocationInWindow else {
      super.mouseUp(with: event)
      return
    }
    let dx = abs(event.locationInWindow.x - start.x)
    let dy = abs(event.locationInWindow.y - start.y)
    guard dx <= V15Tokens.Rail.dragPanThreshold && dy <= V15Tokens.Rail.dragPanThreshold else {
      super.mouseUp(with: event)
      return
    }
    let localInLift = liftContainer.convert(event.locationInWindow, from: nil)
    if closeButton.hitTest(closeButton.convert(localInLift, from: liftContainer)) != nil {
      return
    }
    if bounds.contains(convert(event.locationInWindow, from: nil)) {
      super.mouseUp(with: event)
      onPasteRequested?(item.id)
    } else {
      super.mouseUp(with: event)
    }
  }

  override func rightMouseDown(with event: NSEvent) {
    onContextMenuRequested?(item.id, event, self)
  }

  override func accessibilityPerformPress() -> Bool {
    onPasteRequested?(item.id)
    return true
  }

  // MARK: Content-First Body Builder (V10/V14/V15 Card Layouts)

  private func rebuildBodyContent() {
    asyncImageToken += 1
    for sub in bodyContainer.subviews {
      sub.removeFromSuperview()
    }

    let ink = isDark ? V15Tokens.Card.darkInk : V15Tokens.Card.lightInk
    let secondaryInk = isDark ? V15Tokens.Card.darkSecondaryInk : V15Tokens.Card.lightSecondaryInk

    switch identity.family {
    case .text:
      buildTextBody(text: item.effectiveText, ink: ink)

    case .code:
      let lang = identity.language ?? "unknown"
      buildCodeBody(title: item.displayTitle, code: item.effectiveText, language: lang, ink: ink)

    case .color:
      let raw = item.effectiveText.trimmingCharacters(in: .whitespacesAndNewlines)
      let color = LumenClassifier.parseHexColor(raw) ?? V15Color.hex("#7898e8")
      buildColorSwatchBody(color: color, hexLabel: raw.uppercased(), title: item.displayTitle, ink: ink)

    case .image:
      buildImageBody(title: item.displayTitle, ink: ink)

    case .link:
      buildLinkBody(rawURL: item.effectiveText.trimmingCharacters(in: .whitespacesAndNewlines), ink: ink, secondaryInk: secondaryInk)

    case .document:
      buildDocumentBody(title: item.displayTitle, ink: ink, secondaryInk: secondaryInk)

    case .audio:
      buildMediaBody(title: item.displayTitle, isVideo: false, isMusicGroup: false, ink: ink)

    case .video:
      buildMediaBody(title: item.displayTitle, isVideo: true, isMusicGroup: false, ink: ink)

    case .collection:
      if identity.glyphID == "musicgroup" {
        buildMediaBody(title: item.displayTitle, isVideo: false, isMusicGroup: true, ink: ink)
      } else {
        buildFileCollectionBody(title: item.displayTitle, files: item.files, ink: ink, secondaryInk: secondaryInk)
      }

    case .archive, .file:
      if item.files.count > 1 {
        buildFileCollectionBody(title: item.displayTitle, files: item.files, ink: ink, secondaryInk: secondaryInk)
      } else {
        buildSemanticTileBody(title: item.displayTitle, ink: ink)
      }
    }
  }

  private func makeTitleLabel(_ text: String, ink: NSColor, maxLines: Int = 1) -> NSTextField {
    let field = NSTextField(labelWithString: text)
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineHeightMultiple = V15Tokens.Body.titleLineHeightMultiple
    paragraph.lineBreakMode = .byTruncatingTail
    field.attributedStringValue = NSAttributedString(
      string: text,
      attributes: [
        .font: NSFont.systemFont(ofSize: V15Tokens.Body.titleFontSize, weight: .semibold),
        .foregroundColor: ink,
        .kern: V15Tokens.Body.titleKern,
        .paragraphStyle: paragraph
      ]
    )
    field.maximumNumberOfLines = maxLines
    field.lineBreakMode = .byTruncatingTail
    field.translatesAutoresizingMaskIntoConstraints = false
    return field
  }

  private func buildTextBody(text: String, ink: NSColor) {
    let field = NSTextField(wrappingLabelWithString: text)
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineHeightMultiple = V15Tokens.Body.textLineHeightMultiple
    paragraph.lineBreakMode = .byTruncatingTail
    field.attributedStringValue = NSAttributedString(
      string: text,
      attributes: [
        .font: NSFont.systemFont(ofSize: V15Tokens.Body.textFontSize, weight: .regular),
        .foregroundColor: ink,
        .kern: V15Tokens.Body.textKern,
        .paragraphStyle: paragraph
      ]
    )
    field.maximumNumberOfLines = V15Tokens.Body.textMaxLines
    field.cell?.truncatesLastVisibleLine = true
    field.translatesAutoresizingMaskIntoConstraints = false
    bodyContainer.addSubview(field)
    NSLayoutConstraint.activate([
      field.topAnchor.constraint(equalTo: bodyContainer.topAnchor),
      field.leadingAnchor.constraint(equalTo: bodyContainer.leadingAnchor),
      field.trailingAnchor.constraint(equalTo: bodyContainer.trailingAnchor),
      field.bottomAnchor.constraint(lessThanOrEqualTo: bodyContainer.bottomAnchor)
    ])
  }

  private func buildCodeBody(title: String, code: String, language: String, ink: NSColor) {
    let titleLabel = makeTitleLabel(title, ink: ink)
    let codeBox = V15FlippedContainerView()
    codeBox.wantsLayer = true
    codeBox.layer?.backgroundColor = V15Tokens.Body.codeBackground.cgColor
    codeBox.layer?.cornerRadius = V15Tokens.Body.codeCornerRadius
    codeBox.layer?.masksToBounds = true
    codeBox.translatesAutoresizingMaskIntoConstraints = false

    let codeLabel = NSTextField(wrappingLabelWithString: "")
    codeLabel.attributedStringValue = V15OrbitCodeHighlighter.attributedString(code: code, language: language)
    codeLabel.maximumNumberOfLines = V15Tokens.Body.codeMaxLines
    codeLabel.cell?.truncatesLastVisibleLine = true
    codeLabel.translatesAutoresizingMaskIntoConstraints = false
    codeBox.addSubview(codeLabel)

    bodyContainer.addSubview(titleLabel)
    bodyContainer.addSubview(codeBox)

    let pad = V15Tokens.Body.codePadding
    NSLayoutConstraint.activate([
      titleLabel.topAnchor.constraint(equalTo: bodyContainer.topAnchor),
      titleLabel.leadingAnchor.constraint(equalTo: bodyContainer.leadingAnchor),
      titleLabel.trailingAnchor.constraint(equalTo: bodyContainer.trailingAnchor),

      codeBox.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: V15Tokens.Body.gap),
      codeBox.leadingAnchor.constraint(equalTo: bodyContainer.leadingAnchor),
      codeBox.trailingAnchor.constraint(equalTo: bodyContainer.trailingAnchor),
      codeBox.bottomAnchor.constraint(equalTo: bodyContainer.bottomAnchor),

      codeLabel.topAnchor.constraint(equalTo: codeBox.topAnchor, constant: pad),
      codeLabel.leadingAnchor.constraint(equalTo: codeBox.leadingAnchor, constant: pad),
      codeLabel.trailingAnchor.constraint(equalTo: codeBox.trailingAnchor, constant: -pad),
      codeLabel.bottomAnchor.constraint(lessThanOrEqualTo: codeBox.bottomAnchor, constant: -pad)
    ])
  }

  private func buildColorSwatchBody(color: NSColor, hexLabel: String, title: String, ink: NSColor) {
    let swatch = V15FlippedContainerView()
    swatch.wantsLayer = true
    swatch.layer?.backgroundColor = color.cgColor
    swatch.layer?.cornerRadius = V15Tokens.Body.visualCornerRadius
    swatch.layer?.masksToBounds = true
    swatch.translatesAutoresizingMaskIntoConstraints = false

    let fgColor: NSColor = V15Color.relativeLuminance(of: color) > 0.62
      ? V15Color.hex("#1d2b40")
      : V15Color.hex("#ffffff")

    let hexField = NSTextField(labelWithString: hexLabel)
    hexField.font = .monospacedSystemFont(ofSize: V15Tokens.Body.swatchFontSize, weight: .semibold)
    hexField.textColor = fgColor
    hexField.translatesAutoresizingMaskIntoConstraints = false
    swatch.addSubview(hexField)

    let unitField = NSTextField(labelWithString: "HEX")
    unitField.font = .monospacedSystemFont(ofSize: V15Tokens.Body.swatchBadgeFontSize, weight: .medium)
    unitField.textColor = fgColor.withAlphaComponent(0.70)
    unitField.translatesAutoresizingMaskIntoConstraints = false
    swatch.addSubview(unitField)

    let titleLabel = makeTitleLabel(title, ink: ink)

    bodyContainer.addSubview(swatch)
    bodyContainer.addSubview(titleLabel)

    NSLayoutConstraint.activate([
      swatch.topAnchor.constraint(equalTo: bodyContainer.topAnchor),
      swatch.leadingAnchor.constraint(equalTo: bodyContainer.leadingAnchor),
      swatch.trailingAnchor.constraint(equalTo: bodyContainer.trailingAnchor),
      swatch.bottomAnchor.constraint(equalTo: titleLabel.topAnchor, constant: -V15Tokens.Body.gap),

      hexField.leadingAnchor.constraint(equalTo: swatch.leadingAnchor, constant: 11),
      hexField.bottomAnchor.constraint(equalTo: swatch.bottomAnchor, constant: -10),
      unitField.trailingAnchor.constraint(equalTo: swatch.trailingAnchor, constant: -11),
      unitField.bottomAnchor.constraint(equalTo: swatch.bottomAnchor, constant: -11),

      titleLabel.leadingAnchor.constraint(equalTo: bodyContainer.leadingAnchor),
      titleLabel.trailingAnchor.constraint(equalTo: bodyContainer.trailingAnchor),
      titleLabel.bottomAnchor.constraint(equalTo: bodyContainer.bottomAnchor)
    ])
  }

  private func buildImageBody(title: String, ink: NSColor) {
    let visual = V15FlippedContainerView()
    visual.wantsLayer = true
    visual.layer?.cornerRadius = V15Tokens.Body.visualCornerRadius
    visual.layer?.masksToBounds = true
    visual.layer?.backgroundColor = (isDark ? V15Tokens.Body.paperWellDarkBackground : V15Tokens.Body.paperWellLightBackground).cgColor
    visual.translatesAutoresizingMaskIntoConstraints = false

    let imageView = NSImageView()
    imageView.imageScaling = .scaleAxesIndependently
    imageView.translatesAutoresizingMaskIntoConstraints = false
    visual.addSubview(imageView)

    let fallbackGlyph = NSImageView()
    fallbackGlyph.image = V15Glyphs.identityImage(for: identity, size: V15Tokens.Body.visualTileGlyphSize, isDark: isDark)
    fallbackGlyph.translatesAutoresizingMaskIntoConstraints = false
    visual.addSubview(fallbackGlyph)

    let titleLabel = makeTitleLabel(title, ink: ink)

    bodyContainer.addSubview(visual)
    bodyContainer.addSubview(titleLabel)

    NSLayoutConstraint.activate([
      visual.topAnchor.constraint(equalTo: bodyContainer.topAnchor),
      visual.leadingAnchor.constraint(equalTo: bodyContainer.leadingAnchor),
      visual.trailingAnchor.constraint(equalTo: bodyContainer.trailingAnchor),
      visual.bottomAnchor.constraint(equalTo: titleLabel.topAnchor, constant: -V15Tokens.Body.gap),

      imageView.topAnchor.constraint(equalTo: visual.topAnchor),
      imageView.bottomAnchor.constraint(equalTo: visual.bottomAnchor),
      imageView.leadingAnchor.constraint(equalTo: visual.leadingAnchor),
      imageView.trailingAnchor.constraint(equalTo: visual.trailingAnchor),

      fallbackGlyph.centerXAnchor.constraint(equalTo: visual.centerXAnchor),
      fallbackGlyph.centerYAnchor.constraint(equalTo: visual.centerYAnchor),
      fallbackGlyph.widthAnchor.constraint(equalToConstant: V15Tokens.Body.visualTileGlyphSize),
      fallbackGlyph.heightAnchor.constraint(equalToConstant: V15Tokens.Body.visualTileGlyphSize),

      titleLabel.leadingAnchor.constraint(equalTo: bodyContainer.leadingAnchor),
      titleLabel.trailingAnchor.constraint(equalTo: bodyContainer.trailingAnchor),
      titleLabel.bottomAnchor.constraint(equalTo: bodyContainer.bottomAnchor)
    ])

    let applyImage: (NSImage) -> Void = { img in
      imageView.image = img
      imageView.imageScaling = .scaleProportionallyUpOrDown
      fallbackGlyph.isHidden = true
    }

    let cacheKey = "clip:\(item.id)"
    if let cached = LumenPreviewCache.shared.image(for: cacheKey) {
      applyImage(cached)
    } else if let decoded = item.decodedThumbnailImage() {
      LumenPreviewCache.shared.storeImage(decoded, for: cacheKey)
      applyImage(decoded)
    } else if let path = item.primaryFilePath, FileManager.default.fileExists(atPath: path), let fileImg = NSImage(contentsOfFile: path) {
      LumenPreviewCache.shared.storeImage(fileImg, for: cacheKey)
      applyImage(fileImg)
    } else if item.kind == "image" {
      let token = asyncImageToken
      let targetID = item.id
      LumenClipboardStore.shared.api.fetchItemContent(id: targetID, retriesRemaining: 1) { [weak self] result in
        guard let self, self.asyncImageToken == token, self.item.id == targetID else { return }
        if case .success(let (data, _)) = result, let img = NSImage(data: data) {
          LumenPreviewCache.shared.storeImage(img, for: cacheKey)
          applyImage(img)
        }
      }
    }
  }

  private func buildLinkBody(rawURL: String, ink: NSColor, secondaryInk: NSColor) {
    let parsed = URL(string: rawURL)
    let host = (parsed?.host ?? rawURL).replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression)
    let markText = host.split(separator: ".").first.map { String($0).capitalized } ?? "URL"
    let pathSummary = parsed.map { url -> String in
      let p = url.path == "/" ? "" : url.path
      return p.isEmpty ? rawURL : (host + p)
    } ?? rawURL

    let markRow = NSStackView()
    markRow.orientation = .horizontal
    markRow.alignment = .centerY
    markRow.spacing = 6
    markRow.translatesAutoresizingMaskIntoConstraints = false

    let markLabel = NSTextField(labelWithString: markText)
    markLabel.font = .systemFont(ofSize: V15Tokens.Body.linkMarkFontSize, weight: .bold)
    markLabel.textColor = ink
    markLabel.lineBreakMode = .byTruncatingTail
    markRow.addArrangedSubview(markLabel)

    let extIcon = NSImageView()
    extIcon.image = V15Glyphs.actionImage(.external, size: 16, color: ink.withAlphaComponent(0.45))
    extIcon.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      extIcon.widthAnchor.constraint(equalToConstant: 16),
      extIcon.heightAnchor.constraint(equalToConstant: 16)
    ])
    markRow.addArrangedSubview(extIcon)

    let titleLabel = makeTitleLabel(item.displayTitle, ink: ink, maxLines: 2)

    let domainLabel = NSTextField(labelWithString: host)
    domainLabel.font = .systemFont(ofSize: V15Tokens.Body.linkDomainFontSize, weight: .regular)
    domainLabel.textColor = secondaryInk.withAlphaComponent(0.75)
    domainLabel.lineBreakMode = .byTruncatingTail
    domainLabel.translatesAutoresizingMaskIntoConstraints = false

    let descLabel = NSTextField(wrappingLabelWithString: pathSummary)
    descLabel.font = .systemFont(ofSize: V15Tokens.Body.linkDescFontSize, weight: .regular)
    descLabel.textColor = secondaryInk.withAlphaComponent(0.72)
    descLabel.maximumNumberOfLines = 3
    descLabel.cell?.truncatesLastVisibleLine = true
    descLabel.translatesAutoresizingMaskIntoConstraints = false

    let stack = NSStackView(views: [markRow, titleLabel, domainLabel, descLabel])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 4
    stack.translatesAutoresizingMaskIntoConstraints = false
    bodyContainer.addSubview(stack)

    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: bodyContainer.topAnchor, constant: 2),
      stack.leadingAnchor.constraint(equalTo: bodyContainer.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: bodyContainer.trailingAnchor),
      stack.bottomAnchor.constraint(lessThanOrEqualTo: bodyContainer.bottomAnchor)
    ])
  }

  private func buildDocumentBody(title: String, ink: NSColor, secondaryInk: NSColor) {
    let paperWell = V15FlippedContainerView()
    paperWell.wantsLayer = true
    paperWell.layer?.cornerRadius = V15Tokens.Body.visualCornerRadius
    paperWell.layer?.masksToBounds = true
    paperWell.layer?.backgroundColor = (isDark ? V15Tokens.Body.paperWellDarkBackground : V15Tokens.Body.paperWellLightBackground).cgColor
    paperWell.translatesAutoresizingMaskIntoConstraints = false

    let titleLabel = makeTitleLabel(title, ink: ink)
    bodyContainer.addSubview(paperWell)
    bodyContainer.addSubview(titleLabel)

    NSLayoutConstraint.activate([
      paperWell.topAnchor.constraint(equalTo: bodyContainer.topAnchor),
      paperWell.leadingAnchor.constraint(equalTo: bodyContainer.leadingAnchor),
      paperWell.trailingAnchor.constraint(equalTo: bodyContainer.trailingAnchor),
      paperWell.bottomAnchor.constraint(equalTo: titleLabel.topAnchor, constant: -V15Tokens.Body.gap),

      titleLabel.leadingAnchor.constraint(equalTo: bodyContainer.leadingAnchor),
      titleLabel.trailingAnchor.constraint(equalTo: bodyContainer.trailingAnchor),
      titleLabel.bottomAnchor.constraint(equalTo: bodyContainer.bottomAnchor)
    ])

    // Try real first-page PDF thumbnail if local PDF exists
    if identity.subtype == "pdf", let path = item.primaryFilePath, FileManager.default.fileExists(atPath: path) {
      let thumbKey = "v15pdfthumb:\(path)"
      let pageView = NSImageView()
      pageView.imageScaling = .scaleProportionallyDown
      pageView.translatesAutoresizingMaskIntoConstraints = false
      paperWell.addSubview(pageView)
      NSLayoutConstraint.activate([
        pageView.topAnchor.constraint(equalTo: paperWell.topAnchor, constant: 5),
        pageView.centerXAnchor.constraint(equalTo: paperWell.centerXAnchor),
        pageView.widthAnchor.constraint(equalTo: paperWell.widthAnchor, multiplier: 0.78),
        pageView.bottomAnchor.constraint(equalTo: paperWell.bottomAnchor)
      ])
      if let cached = LumenPreviewCache.shared.image(for: thumbKey) {
        pageView.image = cached
        return
      }
      if let doc = PDFDocument(url: URL(fileURLWithPath: path)), let page = doc.page(at: 0) {
        let rendered = page.thumbnail(of: NSSize(width: 240, height: 320), for: .mediaBox)
        LumenPreviewCache.shared.storeImage(rendered, for: thumbKey)
        pageView.image = rendered
        return
      }
    }

    let glyph = NSImageView()
    glyph.image = V15Glyphs.identityImage(for: identity, size: V15Tokens.Body.visualTileGlyphSize, isDark: isDark)
    glyph.translatesAutoresizingMaskIntoConstraints = false
    paperWell.addSubview(glyph)
    NSLayoutConstraint.activate([
      glyph.centerXAnchor.constraint(equalTo: paperWell.centerXAnchor),
      glyph.centerYAnchor.constraint(equalTo: paperWell.centerYAnchor),
      glyph.widthAnchor.constraint(equalToConstant: V15Tokens.Body.visualTileGlyphSize),
      glyph.heightAnchor.constraint(equalToConstant: V15Tokens.Body.visualTileGlyphSize)
    ])
  }

  private func buildMediaBody(title: String, isVideo: Bool, isMusicGroup: Bool, ink: NSColor) {
    let visual = V15GradientFillView(
      cssDegrees: 135,
      colors: isVideo
        ? [V15Color.hex("#1b2a42"), V15Color.hex("#2c4161")]
        : [V15Color.hex("#9baed544"), V15Color.hex("#b9a9d944")]
    )
    visual.layer?.cornerRadius = V15Tokens.Body.visualCornerRadius
    visual.layer?.masksToBounds = true
    visual.translatesAutoresizingMaskIntoConstraints = false

    if isMusicGroup {
      // `.v10covers`: 3-card tilted cover fan
      let coverColors = [V15Color.hex("#6a7ec4"), V15Color.hex("#8a65bd"), V15Color.hex("#5f92b5")]
      let angles: [CGFloat] = [-8, 0, 7]
      let xOffsets: [CGFloat] = [-26, 0, 26]
      let yOffsets: [CGFloat] = [3, -5, 3]
      for idx in 0..<3 {
        let tile = V15FlippedContainerView()
        tile.wantsLayer = true
        tile.layer?.backgroundColor = coverColors[idx].cgColor
        tile.layer?.cornerRadius = 7
        tile.layer?.zPosition = idx == 1 ? 2 : 1
        tile.translatesAutoresizingMaskIntoConstraints = false
        let note = NSImageView()
        note.image = V15Glyphs.identityImage(
          for: LumenContentIdentityRegistry.shared.identity(forCategory: .audio),
          size: 20,
          isDark: true,
          overrideColor: .white
        )
        note.translatesAutoresizingMaskIntoConstraints = false
        tile.addSubview(note)
        visual.addSubview(tile)
        NSLayoutConstraint.activate([
          tile.centerXAnchor.constraint(equalTo: visual.centerXAnchor, constant: xOffsets[idx]),
          tile.centerYAnchor.constraint(equalTo: visual.centerYAnchor, constant: yOffsets[idx]),
          tile.widthAnchor.constraint(equalToConstant: 46),
          tile.heightAnchor.constraint(equalToConstant: 46),
          note.centerXAnchor.constraint(equalTo: tile.centerXAnchor),
          note.centerYAnchor.constraint(equalTo: tile.centerYAnchor),
          note.widthAnchor.constraint(equalToConstant: 20),
          note.heightAnchor.constraint(equalToConstant: 20)
        ])
        let rad = angles[idx] * .pi / 180.0
        tile.layer?.transform = CATransform3DMakeRotation(rad, 0, 0, 1)
      }
    } else if isVideo {
      let badge = V15FlippedContainerView()
      badge.wantsLayer = true
      badge.layer?.backgroundColor = V15Tokens.Body.videoPlayBadgeBackground.cgColor
      badge.layer?.cornerRadius = V15Tokens.Body.videoPlayBadgeSize * 0.5
      badge.translatesAutoresizingMaskIntoConstraints = false
      let playIcon = NSImageView()
      playIcon.image = V15Glyphs.actionImage(.play, size: 16, color: .white)
      playIcon.translatesAutoresizingMaskIntoConstraints = false
      badge.addSubview(playIcon)
      visual.addSubview(badge)
      NSLayoutConstraint.activate([
        badge.centerXAnchor.constraint(equalTo: visual.centerXAnchor),
        badge.centerYAnchor.constraint(equalTo: visual.centerYAnchor),
        badge.widthAnchor.constraint(equalToConstant: V15Tokens.Body.videoPlayBadgeSize),
        badge.heightAnchor.constraint(equalToConstant: V15Tokens.Body.videoPlayBadgeSize),
        playIcon.centerXAnchor.constraint(equalTo: badge.centerXAnchor, constant: 1),
        playIcon.centerYAnchor.constraint(equalTo: badge.centerYAnchor),
        playIcon.widthAnchor.constraint(equalToConstant: 16),
        playIcon.heightAnchor.constraint(equalToConstant: 16)
      ])
    } else {
      let glyph = NSImageView()
      glyph.image = V15Glyphs.identityImage(for: identity, size: V15Tokens.Body.visualTileGlyphSize, isDark: isDark)
      glyph.translatesAutoresizingMaskIntoConstraints = false
      visual.addSubview(glyph)
      NSLayoutConstraint.activate([
        glyph.centerXAnchor.constraint(equalTo: visual.centerXAnchor),
        glyph.centerYAnchor.constraint(equalTo: visual.centerYAnchor),
        glyph.widthAnchor.constraint(equalToConstant: V15Tokens.Body.visualTileGlyphSize),
        glyph.heightAnchor.constraint(equalToConstant: V15Tokens.Body.visualTileGlyphSize)
      ])
    }

    let titleLabel = makeTitleLabel(title, ink: ink)
    bodyContainer.addSubview(visual)
    bodyContainer.addSubview(titleLabel)

    NSLayoutConstraint.activate([
      visual.topAnchor.constraint(equalTo: bodyContainer.topAnchor),
      visual.leadingAnchor.constraint(equalTo: bodyContainer.leadingAnchor),
      visual.trailingAnchor.constraint(equalTo: bodyContainer.trailingAnchor),
      visual.bottomAnchor.constraint(equalTo: titleLabel.topAnchor, constant: -V15Tokens.Body.gap),

      titleLabel.leadingAnchor.constraint(equalTo: bodyContainer.leadingAnchor),
      titleLabel.trailingAnchor.constraint(equalTo: bodyContainer.trailingAnchor),
      titleLabel.bottomAnchor.constraint(equalTo: bodyContainer.bottomAnchor)
    ])
  }

  private func buildFileCollectionBody(title: String, files: [String], ink: NSColor, secondaryInk: NSColor) {
    let titleLabel = makeTitleLabel(title, ink: ink)
    let listStack = NSStackView()
    listStack.orientation = .vertical
    listStack.alignment = .leading
    listStack.spacing = 6
    listStack.translatesAutoresizingMaskIntoConstraints = false

    for path in files.prefix(4) {
      let memberIdentity = LumenContentIdentityRegistry.shared.identity(forFilePath: path)
      let row = NSStackView()
      row.orientation = .horizontal
      row.alignment = .centerY
      row.spacing = 5

      let icon = NSImageView()
      icon.image = V15Glyphs.identityImage(for: memberIdentity, size: 13, isDark: isDark)
      icon.translatesAutoresizingMaskIntoConstraints = false
      NSLayoutConstraint.activate([
        icon.widthAnchor.constraint(equalToConstant: 13),
        icon.heightAnchor.constraint(equalToConstant: 13)
      ])

      let name = NSTextField(labelWithString: URL(fileURLWithPath: path).lastPathComponent)
      name.font = .systemFont(ofSize: 10.5, weight: .regular)
      name.textColor = secondaryInk
      name.lineBreakMode = .byTruncatingMiddle

      row.addArrangedSubview(icon)
      row.addArrangedSubview(name)
      listStack.addArrangedSubview(row)
    }

    if files.count > 4 {
      let more = NSTextField(labelWithString: "共 \(files.count) 项")
      more.font = .systemFont(ofSize: 10, weight: .medium)
      more.textColor = secondaryInk.withAlphaComponent(0.75)
      listStack.addArrangedSubview(more)
    }

    bodyContainer.addSubview(titleLabel)
    bodyContainer.addSubview(listStack)

    NSLayoutConstraint.activate([
      titleLabel.topAnchor.constraint(equalTo: bodyContainer.topAnchor),
      titleLabel.leadingAnchor.constraint(equalTo: bodyContainer.leadingAnchor),
      titleLabel.trailingAnchor.constraint(equalTo: bodyContainer.trailingAnchor),

      listStack.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 7),
      listStack.leadingAnchor.constraint(equalTo: bodyContainer.leadingAnchor),
      listStack.trailingAnchor.constraint(equalTo: bodyContainer.trailingAnchor),
      listStack.bottomAnchor.constraint(lessThanOrEqualTo: bodyContainer.bottomAnchor)
    ])
  }

  private func buildSemanticTileBody(title: String, ink: NSColor) {
    let titleLabel = makeTitleLabel(title, ink: ink)
    let well = V15FlippedContainerView()
    well.wantsLayer = true
    well.layer?.cornerRadius = V15Tokens.Body.visualCornerRadius
    well.layer?.backgroundColor = (isDark ? V15Tokens.Body.paperWellDarkBackground : V15Tokens.Body.paperWellLightBackground).cgColor
    well.translatesAutoresizingMaskIntoConstraints = false

    let glyph = NSImageView()
    glyph.image = V15Glyphs.identityImage(for: identity, size: V15Tokens.Body.visualTileGlyphSize, isDark: isDark)
    glyph.translatesAutoresizingMaskIntoConstraints = false
    well.addSubview(glyph)

    bodyContainer.addSubview(titleLabel)
    bodyContainer.addSubview(well)

    NSLayoutConstraint.activate([
      titleLabel.topAnchor.constraint(equalTo: bodyContainer.topAnchor),
      titleLabel.leadingAnchor.constraint(equalTo: bodyContainer.leadingAnchor),
      titleLabel.trailingAnchor.constraint(equalTo: bodyContainer.trailingAnchor),

      well.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: V15Tokens.Body.gap),
      well.leadingAnchor.constraint(equalTo: bodyContainer.leadingAnchor),
      well.trailingAnchor.constraint(equalTo: bodyContainer.trailingAnchor),
      well.bottomAnchor.constraint(equalTo: bodyContainer.bottomAnchor),

      glyph.centerXAnchor.constraint(equalTo: well.centerXAnchor),
      glyph.centerYAnchor.constraint(equalTo: well.centerYAnchor),
      glyph.widthAnchor.constraint(equalToConstant: V15Tokens.Body.visualTileGlyphSize),
      glyph.heightAnchor.constraint(equalToConstant: V15Tokens.Body.visualTileGlyphSize)
    ])
  }
}

private final class V15GradientFillView: NSView {
  override var isFlipped: Bool { true }
  private let gradientLayer = CAGradientLayer()

  init(cssDegrees: CGFloat, colors: [NSColor]) {
    super.init(frame: .zero)
    wantsLayer = true
    let pts = V15Materials.gradientPoints(cssDegrees: cssDegrees, isFlipped: true)
    gradientLayer.startPoint = pts.0
    gradientLayer.endPoint = pts.1
    gradientLayer.colors = colors.map(\.cgColor)
    layer?.addSublayer(gradientLayer)
  }

  required init?(coder: NSCoder) { nil }

  override func layout() {
    super.layout()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    gradientLayer.frame = bounds
    CATransaction.commit()
  }
}

// MARK: - V15 Orbit Rail Viewport Strip (.shared-orbit .rail)

/// Horizontal clipped viewport slice of the single logical Orbit rail on one physical display.
/// Routes wheel/trackpad/drag-pan to the shared global `scrollOffset` and `Shift + Wheel`
/// to the leftmost Optical Dots navigator.
final class V15OrbitRailViewportView: NSView {
  override var isFlipped: Bool { true }

  let emptyLabel = NSTextField(labelWithString: "该类型暂无记录")

  private var dragStartWindowX: CGFloat?
  private var dragStartScrollOffset: CGFloat = 0
  private var isDraggingRail = false

  var onScrollDelta: ((CGFloat) -> Void)?
  var onShiftWheel: ((NSEvent) -> Void)?
  var onDragPanBegan: (() -> CGFloat)?
  var onDragPanMoved: ((CGFloat) -> Void)?
  var onPointerMovedX: ((CGFloat) -> Void)?

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    // Clip cleanly across display seams (A01–A04, A70)
    layer?.masksToBounds = true

    emptyLabel.font = .systemFont(ofSize: 13, weight: .medium)
    emptyLabel.textColor = V15Tokens.Shell.emptyTextColor
    emptyLabel.alignment = .center
    emptyLabel.isHidden = true
    let shadow = NSShadow()
    shadow.shadowColor = V15Tokens.Shell.emptyTextShadowColor
    shadow.shadowBlurRadius = 8
    shadow.shadowOffset = NSSize(width: 0, height: -1)
    emptyLabel.shadow = shadow
    emptyLabel.translatesAutoresizingMaskIntoConstraints = false
    addSubview(emptyLabel)

    NSLayoutConstraint.activate([
      emptyLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
      emptyLabel.centerYAnchor.constraint(equalTo: centerYAnchor)
    ])

    let tracking = NSTrackingArea(
      rect: .zero,
      options: [.mouseMoved, .activeAlways, .inVisibleRect],
      owner: self,
      userInfo: nil
    )
    addTrackingArea(tracking)

    setAccessibilityRole(.group)
    setAccessibilityLabel("跨屏连续剪贴板历史")
  }

  required init?(coder: NSCoder) { nil }

  override func scrollWheel(with event: NSEvent) {
    // Shift + Wheel switches category via Optical Dots (§3.3, A06)
    if event.modifierFlags.contains(.shift) {
      onShiftWheel?(event)
      return
    }
    let dx = event.scrollingDeltaX
    let dy = event.scrollingDeltaY
    let raw: CGFloat
    if abs(dy) > abs(dx) {
      raw = event.hasPreciseScrollingDeltas ? -dy : (-dy * 18.0)
    } else {
      raw = event.hasPreciseScrollingDeltas ? -dx : (-dx * 18.0)
    }
    if abs(raw) > 0.01 {
      onScrollDelta?(raw)
    }
  }

  override func mouseMoved(with event: NSEvent) {
    let pt = convert(event.locationInWindow, from: nil)
    onPointerMovedX?(pt.x)
  }

  override func mouseDown(with event: NSEvent) {
    // Do not initiate rail drag from the close affordance
    let local = convert(event.locationInWindow, from: nil)
    if hitTest(local) is V15OrbitCloseButton {
      return
    }
    dragStartWindowX = event.locationInWindow.x
    dragStartScrollOffset = onDragPanBegan?() ?? 0
    isDraggingRail = false
  }

  override func mouseDragged(with event: NSEvent) {
    guard let startX = dragStartWindowX else { return }
    let deltaX = event.locationInWindow.x - startX
    if !isDraggingRail && abs(deltaX) > V15Tokens.Rail.dragPanThreshold {
      isDraggingRail = true
    }
    if isDraggingRail {
      onDragPanMoved?(dragStartScrollOffset - deltaX)
    }
  }

  override func mouseUp(with event: NSEvent) {
    dragStartWindowX = nil
    isDraggingRail = false
  }
}
