import AppKit
import CoreGraphics
import Foundation
import QuartzCore

// MARK: - External Non-Overlapping Category Bubble Panel (.type-bubble)

/// Floating non-interactive category label anchored directly above the leftmost Orbit panel's
/// 38 DIP Optical Dots column so the label NEVER overflows the dot column onto Orbit cards
/// (`README-Lumen-V15.md` §3.2, A05/A06/A20/A22/A23).
/// Exact styling from `lumen-v15-exact-tokens.md` `.type-bubble`.
final class V15OpticalDotBubblePanel {
  private let panel: NSPanel
  private let containerView = V15FlippedContainerView()
  private let pillLayer = CALayer()
  private let label = NSTextField(labelWithString: "")

  private var isDark = false
  private var isShown = false
  private let shadowMargin: CGFloat = 18

  init() {
    panel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: 120, height: 48),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.ignoresMouseEvents = true
    panel.isReleasedWhenClosed = false
    panel.hidesOnDeactivate = false
    panel.level = .statusBar
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]

    containerView.wantsLayer = true
    containerView.layer?.masksToBounds = false
    panel.contentView = containerView

    pillLayer.cornerRadius = V15Tokens.Dots.bubbleCornerRadius
    pillLayer.masksToBounds = false
    containerView.layer?.addSublayer(pillLayer)

    label.font = .systemFont(ofSize: V15Tokens.Dots.bubbleFontSize, weight: .medium)
    label.lineBreakMode = .byTruncatingTail
    label.alignment = .center
    label.isBordered = false
    label.drawsBackground = false
    label.isEditable = false
    label.isSelectable = false
    containerView.addSubview(label)

    applyAppearance(isDark: V15Motion.isDarkTheme)
  }

  func applyAppearance(isDark: Bool) {
    self.isDark = isDark
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if isDark {
      pillLayer.backgroundColor = V15Tokens.Dots.bubbleDarkBackground.cgColor
      pillLayer.borderWidth = 1
      pillLayer.borderColor = V15Tokens.Dots.bubbleDarkBorderColor.cgColor
      label.textColor = V15Tokens.Dots.bubbleDarkTextColor
    } else {
      pillLayer.backgroundColor = V15Tokens.Dots.bubbleLightBackground.cgColor
      pillLayer.borderWidth = 0
      pillLayer.borderColor = NSColor.clear.cgColor
      label.textColor = V15Tokens.Dots.bubbleLightTextColor
    }
    CATransaction.commit()
  }

  func show(text: String, anchorWindowFrame: NSRect, screenVisibleFrame: NSRect?) {
    label.stringValue = text
    label.sizeToFit()

    let pillW = ceil(label.frame.width) + V15Tokens.Dots.bubblePaddingHorizontal * 2
    let pillH = ceil(label.frame.height) + V15Tokens.Dots.bubblePaddingVertical * 2
    let panelW = pillW + shadowMargin * 2
    let panelH = pillH + shadowMargin * 2

    // Anchor directly above the leftmost Orbit panel's dot column so the label
    // never overlaps or presses onto any card in the rail.
    var targetX = anchorWindowFrame.minX + 6 - shadowMargin
    var targetY = anchorWindowFrame.maxY + 6 - shadowMargin
    if let vis = screenVisibleFrame {
      targetX = max(vis.minX - shadowMargin + 4, min(vis.maxX - panelW + shadowMargin - 4, targetX))
      targetY = min(vis.maxY - panelH + shadowMargin - 4, targetY)
    }

    let nextFrame = NSRect(x: round(targetX), y: round(targetY), width: panelW, height: panelH)
    let pillRect = CGRect(x: shadowMargin, y: shadowMargin, width: pillW, height: pillH)

    CATransaction.begin()
    CATransaction.setDisableActions(true)
    containerView.frame = NSRect(origin: .zero, size: nextFrame.size)
    pillLayer.frame = pillRect
    V15Materials.applyShadow(
      to: pillLayer,
      spec: V15Tokens.Dots.bubbleShadow,
      cornerRadius: V15Tokens.Dots.bubbleCornerRadius
    )
    label.frame = NSRect(
      x: pillRect.minX + V15Tokens.Dots.bubblePaddingHorizontal,
      y: pillRect.minY + floor((pillH - label.frame.height) * 0.5),
      width: ceil(label.frame.width),
      height: ceil(label.frame.height)
    )
    CATransaction.commit()

    let wasShown = isShown
    isShown = true

    if !wasShown {
      panel.setFrame(nextFrame, display: true)
      panel.alphaValue = V15Motion.isEnabled ? 0 : 1
      panel.orderFrontRegardless()
      if V15Motion.isEnabled {
        let slideAnim = CABasicAnimation(keyPath: "transform.translation.x")
        slideAnim.fromValue = -5.0
        slideAnim.toValue = 0.0
        slideAnim.duration = V15Tokens.Dots.bubbleTransformDuration
        slideAnim.timingFunction = V15Tokens.Dots.bubbleTransformCurve.timingFunction
        containerView.layer?.add(slideAnim, forKey: "v15BubbleSlide")

        NSAnimationContext.runAnimationGroup { ctx in
          ctx.duration = V15Tokens.Dots.bubbleOpacityDuration
          ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
          self.panel.animator().alphaValue = 1
        }
      }
    } else {
      panel.setFrame(nextFrame, display: true)
      panel.alphaValue = 1
      panel.orderFrontRegardless()
    }
  }

  func hide(immediate: Bool = false) {
    guard isShown || panel.isVisible else { return }
    isShown = false
    if immediate || !V15Motion.isEnabled {
      panel.orderOut(nil)
      panel.alphaValue = 0
      return
    }
    NSAnimationContext.runAnimationGroup({ ctx in
      ctx.duration = V15Tokens.Dots.bubbleOpacityDuration
      ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
      self.panel.animator().alphaValue = 0
    }, completionHandler: { [weak self] in
      guard let self, !self.isShown else { return }
      self.panel.orderOut(nil)
    })
  }

  func teardown() {
    isShown = false
    panel.orderOut(nil)
    panel.close()
  }
}

// MARK: - Single Optical Dot Cell (.type-dot)

private final class V15OpticalDotCell: NSView {
  override var isFlipped: Bool { true }

  let category: LumenLogicalCategory
  let categoryIndex: Int

  private let dotLayer = CALayer()
  private let focusRingLayer = CALayer()

  private var isVisibleInWindow = true
  private var isActive = false
  private var isEmpty = false
  private var isEdge = false
  private var isAwake = false
  private var isHovered = false
  private var isPressed = false
  private var isKeyboardFocused = false
  private var isDark = false
  private var glowEnabled = true

  var onHoverEnter: ((Int) -> Void)?
  var onClick: ((LumenLogicalCategory) -> Void)?

  init(category: LumenLogicalCategory, index: Int) {
    self.category = category
    self.categoryIndex = index
    super.init(frame: NSRect(
      x: 0,
      y: CGFloat(index) * V15Tokens.Dots.stepHeight,
      width: V15Tokens.Dots.columnWidth,
      height: V15Tokens.Dots.stepHeight
    ))
    wantsLayer = true
    layer?.masksToBounds = false

    // Keyboard focus-visible ring (`paste-lumen-v15.html` `.type-dot:focus-visible`)
    focusRingLayer.borderWidth = 1
    focusRingLayer.borderColor = V15Color.hex("#ffffff99").cgColor
    focusRingLayer.cornerRadius = 9
    focusRingLayer.opacity = 0
    layer?.addSublayer(focusRingLayer)

    // Sole optical indicator: 5×5 circle (zero halo rings, zero ripples, zero spines)
    let d = V15Tokens.Dots.dotDiameter
    dotLayer.bounds = CGRect(x: 0, y: 0, width: d, height: d)
    dotLayer.cornerRadius = d * 0.5
    layer?.addSublayer(dotLayer)

    setAccessibilityRole(.radioButton)
    setAccessibilityElement(true)

    let tracking = NSTrackingArea(
      rect: .zero,
      options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
      owner: self,
      userInfo: nil
    )
    addTrackingArea(tracking)
  }

  required init?(coder: NSCoder) { nil }

  override func layout() {
    super.layout()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    dotLayer.position = CGPoint(x: bounds.midX, y: bounds.midY)
    focusRingLayer.frame = bounds.insetBy(dx: 6, dy: 4)
    CATransaction.commit()
  }

  override func hitTest(_ point: NSPoint) -> NSView? {
    // Non-visible dots outside the 5-dot sliding window are strictly non-interactive (§3.2, A20)
    guard isVisibleInWindow else { return nil }
    return super.hitTest(point)
  }

  override func mouseEntered(with event: NSEvent) {
    guard isVisibleInWindow else { return }
    isHovered = true
    applyVisualState(animated: true)
    onHoverEnter?(categoryIndex)
  }

  override func mouseExited(with event: NSEvent) {
    isHovered = false
    isPressed = false
    applyVisualState(animated: true)
  }

  override func mouseDown(with event: NSEvent) {
    guard isVisibleInWindow else { return }
    isPressed = true
    applyVisualState(animated: true)
  }

  override func mouseUp(with event: NSEvent) {
    let wasPressed = isPressed
    isPressed = false
    applyVisualState(animated: true)
    guard isVisibleInWindow, wasPressed else { return }
    let local = convert(event.locationInWindow, from: nil)
    if bounds.contains(local) {
      onClick?(category)
    }
  }

  override func accessibilityPerformPress() -> Bool {
    guard isVisibleInWindow else { return false }
    onClick?(category)
    return true
  }

  func configure(
    visibleInWindow: Bool,
    active: Bool,
    empty: Bool,
    edge: Bool,
    awake: Bool,
    keyboardFocused: Bool,
    count: Int,
    isDark: Bool,
    glowEnabled: Bool,
    animated: Bool
  ) {
    self.isVisibleInWindow = visibleInWindow
    self.isActive = active
    self.isEmpty = empty
    self.isEdge = edge
    self.isAwake = awake
    self.isKeyboardFocused = keyboardFocused
    self.isDark = isDark
    self.glowEnabled = glowEnabled

    if !visibleInWindow {
      isHovered = false
      isPressed = false
    }

    setAccessibilityElement(visibleInWindow)
    setAccessibilityEnabled(visibleInWindow)
    setAccessibilityLabel("\(category.label) · \(count) 条")
    setAccessibilityValue(active ? 1 : 0)

    applyVisualState(animated: animated)
  }

  func targetScale() -> CGFloat {
    if isPressed { return V15Tokens.Dots.pressScale }
    if isAwake {
      if isActive {
        return isHovered ? V15Tokens.Dots.hoverActiveScale : V15Tokens.Dots.awakeActiveScale
      }
      if isHovered || isKeyboardFocused {
        return V15Tokens.Dots.hoverScale
      }
      return V15Tokens.Dots.awakeScale
    }
    if isActive { return V15Tokens.Dots.idleActiveScale }
    if isEdge { return V15Tokens.Dots.idleEdgeScale }
    return V15Tokens.Dots.idleScale
  }

  func targetOpacity() -> Float {
    if !isVisibleInWindow { return 0.0 }
    if isAwake {
      if isActive || isHovered || isKeyboardFocused { return V15Tokens.Dots.awakeActiveOpacity }
      if isEmpty { return V15Tokens.Dots.awakeEmptyOpacity }
      return V15Tokens.Dots.awakeOpacity
    }
    if isActive { return V15Tokens.Dots.idleActiveOpacity }
    if isEmpty { return V15Tokens.Dots.idleEmptyOpacity }
    return V15Tokens.Dots.idleOpacity
  }

  func applyVisualState(animated: Bool) {
    let scale = targetScale()
    let opacity = targetOpacity()
    let color: NSColor
    if isActive {
      color = isDark ? V15Tokens.Dots.darkActiveDotColor : V15Tokens.Dots.lightActiveDotColor
    } else {
      color = isDark ? V15Tokens.Dots.darkDotColor : V15Tokens.Dots.lightDotColor
    }

    let useAnim = animated && V15Motion.isEnabled
    CATransaction.begin()
    if !useAnim {
      CATransaction.setDisableActions(true)
    } else {
      CATransaction.setAnimationDuration(V15Tokens.Dots.scaleDuration)
      CATransaction.setAnimationTimingFunction(V15Tokens.Dots.scaleCurve.timingFunction)
    }

    dotLayer.backgroundColor = color.cgColor
    dotLayer.opacity = opacity
    dotLayer.transform = CATransform3DMakeScale(scale, scale, 1.0)
    focusRingLayer.opacity = (isVisibleInWindow && isKeyboardFocused) ? 1.0 : 0.0

    if glowEnabled && isActive && isVisibleInWindow {
      let spec = isAwake ? V15Tokens.Dots.awakeActiveGlow : V15Tokens.Dots.idleActiveGlow
      V15Materials.applyShadow(to: dotLayer, spec: spec, cornerRadius: V15Tokens.Dots.dotDiameter * 0.5)
    } else {
      V15Materials.clearShadow(on: dotLayer)
    }
    CATransaction.commit()
  }

  /// Directional stagger pulse during pointer sweep or category switch (A05/A22/A23).
  func playScalePulse(from fromScale: CGFloat, peak peakScale: CGFloat, peakOpacity: Float, duration: TimeInterval, delay: TimeInterval) {
    guard isVisibleInWindow, V15Motion.isEnabled else { return }
    let endScale = targetScale()
    let endOpacity = targetOpacity()
    let beginTime = CACurrentMediaTime() + delay

    let scaleAnim = CAKeyframeAnimation(keyPath: "transform.scale")
    scaleAnim.values = [fromScale, peakScale, endScale]
    scaleAnim.keyTimes = [0.0, 0.35, 1.0]
    scaleAnim.duration = duration
    scaleAnim.beginTime = beginTime
    scaleAnim.timingFunction = CAMediaTimingFunction(controlPoints: 0.18, 0.80, 0.25, 1.00)
    scaleAnim.fillMode = .backwards
    dotLayer.removeAnimation(forKey: "v15DotPulseScale")
    dotLayer.add(scaleAnim, forKey: "v15DotPulseScale")

    let alphaAnim = CAKeyframeAnimation(keyPath: "opacity")
    alphaAnim.values = [max(0.45, endOpacity), peakOpacity, endOpacity]
    alphaAnim.keyTimes = [0.0, 0.35, 1.0]
    alphaAnim.duration = duration
    alphaAnim.beginTime = beginTime
    alphaAnim.timingFunction = CAMediaTimingFunction(controlPoints: 0.18, 0.80, 0.25, 1.00)
    alphaAnim.fillMode = .backwards
    dotLayer.removeAnimation(forKey: "v15DotPulseAlpha")
    dotLayer.add(alphaAnim, forKey: "v15DotPulseAlpha")
  }
}

// MARK: - V15 Optical Dots 3.0 Navigator (.type-dock)

/// Strict V15 Optical Dots 3.0 vertical 5-point sliding navigator (`38` DIP column,
/// `26` DIP step, `5 × 26 = 130` DIP visible window, fixed 10 categories, non-wrapping).
///
/// Guarantees:
/// - Strict clipping to `width = 38` DIP (`masksToBounds = true`); labels are rendered in
///   an external floating `V15OpticalDotBubblePanel` above the dot column so no label can
///   ever spill out of the column onto Orbit cards (A05/A06/A20/A22/A23).
/// - Zero halo rings, zero ripples, zero spines.
/// - Hover wakes the dots and sweeps neighbor scale/opacity without auto-filtering.
/// - Returns to dormant low-brightness state 900ms after leaving hotzone / finishing input.
final class V15OpticalDotsView: NSView {
  override var isFlipped: Bool { true }

  private let categories = LumenLogicalCategory.allCases
  private let windowClipView = V15FlippedContainerView()
  private let trackView = V15FlippedContainerView()
  private var cells: [V15OpticalDotCell] = []
  private let bubblePanel = V15OpticalDotBubblePanel()

  private(set) var activeCategory: LumenLogicalCategory = .all
  private var categoryCounts: [LumenLogicalCategory: Int] = [:]
  private var isDark = false
  private var glowEnabled = true

  private var isPointerInside = false
  private var isFeedbackAwake = false
  private var hoveredIndex: Int?
  private var keyboardFocusedIndex: Int?
  private var sleepWork: DispatchWorkItem?

  // Wheel accumulator (`paste-lumen-v15.html` `typeWheel`: 42px threshold, 180ms reset)
  private var wheelAccumulator: CGFloat = 0
  private var lastWheelTime: TimeInterval = 0

  var onSelectCategory: ((LumenLogicalCategory) -> Void)?

  var hasKeyboardFocus: Bool {
    keyboardFocusedIndex != nil
  }

  private var isAwake: Bool {
    isPointerInside || isFeedbackAwake || keyboardFocusedIndex != nil
  }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    // Strictly clip column to 38 DIP so nothing can ever bleed onto card #0
    layer?.masksToBounds = true

    windowClipView.wantsLayer = true
    windowClipView.layer?.masksToBounds = true
    addSubview(windowClipView)

    trackView.wantsLayer = true
    trackView.layer?.masksToBounds = false
    windowClipView.addSubview(trackView)

    for (idx, cat) in categories.enumerated() {
      let cell = V15OpticalDotCell(category: cat, index: idx)
      cell.onHoverEnter = { [weak self] hoveredIdx in
        self?.handleCellHover(hoveredIdx)
      }
      cell.onClick = { [weak self] selectedCat in
        self?.handleCellClick(selectedCat)
      }
      trackView.addSubview(cell)
      cells.append(cell)
    }

    setAccessibilityRole(.group)
    setAccessibilityLabel("剪贴板类型切换")

    let tracking = NSTrackingArea(
      rect: .zero,
      options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
      owner: self,
      userInfo: nil
    )
    addTrackingArea(tracking)

    refreshLayoutAndCells(animated: false)
  }

  required init?(coder: NSCoder) { nil }

  deinit {
    sleepWork?.cancel()
    bubblePanel.teardown()
  }

  override func layout() {
    super.layout()
    let winH = V15Tokens.Dots.windowHeight
    let winY = floor((bounds.height - winH) * 0.5)
    windowClipView.frame = NSRect(x: 0, y: max(0, winY), width: V15Tokens.Dots.columnWidth, height: winH)
    trackView.frame = NSRect(
      x: 0,
      y: 0,
      width: V15Tokens.Dots.columnWidth,
      height: CGFloat(categories.count) * V15Tokens.Dots.stepHeight
    )
    for (idx, cell) in cells.enumerated() {
      cell.frame = NSRect(
        x: 0,
        y: CGFloat(idx) * V15Tokens.Dots.stepHeight,
        width: V15Tokens.Dots.columnWidth,
        height: V15Tokens.Dots.stepHeight
      )
    }
    applyTrackSlide(animated: false)
  }

  // MARK: Public State API

  func applyAppearance(isDark: Bool, glowEnabled: Bool) {
    self.isDark = isDark
    self.glowEnabled = glowEnabled
    bubblePanel.applyAppearance(isDark: isDark)
    refreshLayoutAndCells(animated: false)
  }

  func updateState(active: LumenLogicalCategory, counts: [LumenLogicalCategory: Int], animated: Bool) {
    let prevIndex = categories.firstIndex(of: activeCategory) ?? 0
    let nextIndex = categories.firstIndex(of: active) ?? 0
    let changed = active != activeCategory

    activeCategory = active
    categoryCounts = counts

    if let focused = keyboardFocusedIndex {
      let start = windowStartIndex(for: nextIndex)
      if focused < start || focused >= start + V15Tokens.Dots.visibleCount {
        keyboardFocusedIndex = nextIndex
      }
    }

    if changed {
      triggerFeedbackWake(forCategoryIndex: nextIndex)
    }
    refreshLayoutAndCells(animated: animated)

    if changed && animated {
      playSwitchStagger(prevIndex: prevIndex, nextIndex: nextIndex)
    }
  }

  func stepCategory(by delta: Int) {
    let currentIdx = categories.firstIndex(of: activeCategory) ?? 0
    // Non-wrapping head/tail clamp (A06, A20)
    let nextIdx = max(0, min(categories.count - 1, currentIdx + delta))
    if nextIdx == currentIdx {
      triggerFeedbackWake(forCategoryIndex: currentIdx)
      refreshLayoutAndCells(animated: true)
      playSwitchStagger(prevIndex: currentIdx, nextIndex: currentIdx)
      return
    }
    onSelectCategory?(categories[nextIdx])
  }

  /// Handles wheel on either the Optical Dots column or `Shift + Wheel` on the card rail.
  func handleTypeWheel(_ event: NSEvent) {
    let rawDelta = abs(event.scrollingDeltaY) >= abs(event.scrollingDeltaX)
      ? event.scrollingDeltaY
      : event.scrollingDeltaX
    guard abs(rawDelta) > 0.01 else { return }

    // Normalize line-based mouse wheels vs precise trackpad pixel deltas
    var normalized = event.hasPreciseScrollingDeltas ? -rawDelta : (-rawDelta * 16.0)
    if abs(normalized) < 0.01 { return }
    // Clamp absurd single-tick spikes
    normalized = max(-240, min(240, normalized))

    let now = CACurrentMediaTime()
    let sameDirection = (wheelAccumulator == 0) || ((normalized > 0) == (wheelAccumulator > 0))
    if (now - lastWheelTime) > V15Tokens.Dots.wheelResetInterval || !sameDirection {
      wheelAccumulator = 0
    }
    lastWheelTime = now
    wheelAccumulator += normalized

    if abs(wheelAccumulator) >= V15Tokens.Dots.wheelAccumulatorThreshold {
      let step = wheelAccumulator > 0 ? 1 : -1
      wheelAccumulator = 0
      stepCategory(by: step)
    }
  }

  /// Brief scale pulse on a visible dot when a real-time capture arrives in another category (A41).
  func pulseCategoryDot(_ category: LumenLogicalCategory) {
    guard let idx = categories.firstIndex(of: category) else { return }
    let start = windowStartIndex(for: categories.firstIndex(of: activeCategory) ?? 0)
    guard idx >= start && idx < start + V15Tokens.Dots.visibleCount else { return }
    cells[idx].playScalePulse(from: 1.0, peak: 1.9, peakOpacity: 1.0, duration: 0.30, delay: 0)
  }

  // MARK: Keyboard Focus Navigation (§3.3)

  func focusActiveDot() {
    let idx = categories.firstIndex(of: activeCategory) ?? 0
    keyboardFocusedIndex = idx
    sleepWork?.cancel()
    refreshLayoutAndCells(animated: true)
    showBubble(forIndex: idx)
  }

  func moveKeyboardFocus(by delta: Int) {
    let activeIdx = categories.firstIndex(of: activeCategory) ?? 0
    let start = windowStartIndex(for: activeIdx)
    let end = start + V15Tokens.Dots.visibleCount - 1
    let current = keyboardFocusedIndex ?? activeIdx
    let next = max(start, min(end, current + delta))
    keyboardFocusedIndex = next
    refreshLayoutAndCells(animated: true)
    showBubble(forIndex: next)
  }

  @discardableResult
  func activateFocusedDot() -> Bool {
    guard let idx = keyboardFocusedIndex, idx >= 0, idx < categories.count else { return false }
    let cat = categories[idx]
    if cat == activeCategory {
      triggerFeedbackWake(forCategoryIndex: idx)
      refreshLayoutAndCells(animated: true)
    } else {
      onSelectCategory?(cat)
    }
    return true
  }

  func clearKeyboardFocus() {
    guard keyboardFocusedIndex != nil else { return }
    keyboardFocusedIndex = nil
    scheduleSleepIfDormant()
    refreshLayoutAndCells(animated: true)
  }

  func resetTransientState() {
    sleepWork?.cancel()
    sleepWork = nil
    isPointerInside = false
    isFeedbackAwake = false
    hoveredIndex = nil
    keyboardFocusedIndex = nil
    wheelAccumulator = 0
    bubblePanel.hide(immediate: true)
    refreshLayoutAndCells(animated: false)
  }

  func teardown() {
    sleepWork?.cancel()
    sleepWork = nil
    bubblePanel.teardown()
  }

  // MARK: Pointer & Scroll Events

  override func mouseEntered(with event: NSEvent) {
    isPointerInside = true
    sleepWork?.cancel()
    refreshLayoutAndCells(animated: true)
    let idx = hoveredIndex ?? (categories.firstIndex(of: activeCategory) ?? 0)
    showBubble(forIndex: idx)
  }

  override func mouseExited(with event: NSEvent) {
    isPointerInside = false
    hoveredIndex = nil
    scheduleSleepIfDormant()
    refreshLayoutAndCells(animated: true)
  }

  override func scrollWheel(with event: NSEvent) {
    handleTypeWheel(event)
  }

  // MARK: Internals

  private func windowStartIndex(for activeIdx: Int) -> Int {
    // Source: `paste-lumen-v15.html` line 252 `dotStart(i)`
    max(0, min(categories.count - V15Tokens.Dots.visibleCount, activeIdx - 2))
  }

  private func handleCellHover(_ nextIndex: Int) {
    let prevHover = hoveredIndex
    hoveredIndex = nextIndex
    isPointerInside = true
    sleepWork?.cancel()

    showBubble(forIndex: nextIndex)
    refreshLayoutAndCells(animated: true)

    // Directional neighbor stagger when sweeping pointer across visible dots (A05/A22/A23)
    // Does NOT change active category.
    if let prev = prevHover, prev != nextIndex, V15Motion.isEnabled {
      let dir = nextIndex > prev ? 1 : -1
      let activeIdx = categories.firstIndex(of: activeCategory) ?? 0
      let start = windowStartIndex(for: activeIdx)
      for j in start..<(start + V15Tokens.Dots.visibleCount) {
        let dist = abs(j - nextIndex)
        guard dist <= 2 else { continue }
        let stepDir = j == nextIndex ? dir : (j > nextIndex ? 1 : -1)
        let delay = TimeInterval(dist) * V15Tokens.Dots.hoverStaggerPerStep
          + (stepDir == dir ? 0 : V15Tokens.Dots.hoverStaggerReversePenalty)
        let peak: CGFloat = (j == nextIndex) ? 1.80 : 1.40
        cells[j].playScalePulse(
          from: 1.05,
          peak: peak,
          peakOpacity: 1.0,
          duration: V15Tokens.Dots.hoverStaggerDuration,
          delay: delay
        )
      }
    }
  }

  private func handleCellClick(_ category: LumenLogicalCategory) {
    if category == activeCategory {
      let idx = categories.firstIndex(of: category) ?? 0
      triggerFeedbackWake(forCategoryIndex: idx)
      refreshLayoutAndCells(animated: true)
      return
    }
    onSelectCategory?(category)
  }

  private func triggerFeedbackWake(forCategoryIndex index: Int) {
    isFeedbackAwake = true
    showBubble(forIndex: index)
    scheduleSleepTimer()
  }

  private func scheduleSleepIfDormant() {
    guard !isPointerInside && keyboardFocusedIndex == nil else { return }
    if isFeedbackAwake {
      scheduleSleepTimer()
    } else {
      // Leaving hotzone schedules 900ms dormancy return (`README-Lumen-V15.md` §3.2)
      isFeedbackAwake = true
      scheduleSleepTimer()
    }
  }

  private func scheduleSleepTimer() {
    sleepWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.isFeedbackAwake = false
      if !self.isPointerInside && self.keyboardFocusedIndex == nil {
        self.bubblePanel.hide(immediate: false)
      }
      self.refreshLayoutAndCells(animated: true)
    }
    sleepWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + V15Tokens.Dots.sleepDelay, execute: work)
  }

  private func showBubble(forIndex index: Int) {
    guard !isHidden, let hostWindow = window, hostWindow.isVisible,
          index >= 0, index < categories.count else {
      return
    }
    let cat = categories[index]
    let count = categoryCounts[cat] ?? 0
    bubblePanel.show(
      text: "\(cat.label) · \(count)",
      anchorWindowFrame: hostWindow.frame,
      screenVisibleFrame: hostWindow.screen?.visibleFrame
    )
  }

  private func playSwitchStagger(prevIndex: Int, nextIndex: Int) {
    guard V15Motion.isEnabled else { return }
    let start = windowStartIndex(for: nextIndex)
    for j in start..<(start + V15Tokens.Dots.visibleCount) {
      let dist = abs(j - nextIndex)
      let delay = TimeInterval(dist) * V15Tokens.Dots.switchPulsePerStep
      let peak: CGFloat = (j == nextIndex) ? 2.05 : 1.55
      cells[j].playScalePulse(
        from: 1.0,
        peak: peak,
        peakOpacity: 1.0,
        duration: V15Tokens.Dots.switchPulseDuration,
        delay: delay
      )
    }
  }

  private func applyTrackSlide(animated: Bool) {
    let activeIdx = categories.firstIndex(of: activeCategory) ?? 0
    let start = windowStartIndex(for: activeIdx)
    let offsetY = -CGFloat(start) * V15Tokens.Dots.stepHeight
    let useAnim = animated && V15Motion.isEnabled

    CATransaction.begin()
    if !useAnim {
      CATransaction.setDisableActions(true)
    } else {
      CATransaction.setAnimationDuration(V15Tokens.Dots.trackSlideDuration)
      CATransaction.setAnimationTimingFunction(V15Tokens.Dots.trackSlideCurve.timingFunction)
    }
    trackView.layer?.transform = CATransform3DMakeTranslation(0, offsetY, 0)
    CATransaction.commit()
  }

  private func refreshLayoutAndCells(animated: Bool) {
    let activeIdx = categories.firstIndex(of: activeCategory) ?? 0
    let start = windowStartIndex(for: activeIdx)
    let awake = isAwake

    applyTrackSlide(animated: animated)

    for (idx, cell) in cells.enumerated() {
      let visible = (idx >= start && idx < start + V15Tokens.Dots.visibleCount)
      let isActive = (idx == activeIdx)
      let count = categoryCounts[cell.category] ?? 0
      let isEdge = (idx == start && start > 0)
        || (idx == start + V15Tokens.Dots.visibleCount - 1 && start + V15Tokens.Dots.visibleCount < categories.count)
      cell.configure(
        visibleInWindow: visible,
        active: isActive,
        empty: count == 0,
        edge: isEdge,
        awake: awake,
        keyboardFocused: keyboardFocusedIndex == idx,
        count: count,
        isDark: isDark,
        glowEnabled: glowEnabled,
        animated: animated
      )
    }
  }
}
