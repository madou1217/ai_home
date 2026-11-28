import AppKit
import CoreGraphics
import Foundation
import QuartzCore

/// Floating contextual pill showing the hovered or active category name + count
/// beside the 38 DIP Optical Dots column. Non-interactive (`hitTest` returns nil).
final class LumenOpticalDotBubbleView: NSView {
  private let label = NSTextField(labelWithString: "")

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.cornerRadius = 7
    layer?.cornerCurve = .continuous
    layer?.shadowColor = NSColor(srgbRed: 0.08, green: 0.16, blue: 0.28, alpha: 1).cgColor
    layer?.shadowOpacity = 0.22
    layer?.shadowRadius = 10
    layer?.shadowOffset = NSSize(width: 0, height: -3)
    alphaValue = 0
    isHidden = true

    label.font = .monospacedDigitSystemFont(ofSize: 11.5, weight: .medium)
    label.alignment = .center
    label.lineBreakMode = .byClipping
    label.translatesAutoresizingMaskIntoConstraints = false
    addSubview(label)

    NSLayoutConstraint.activate([
      label.topAnchor.constraint(equalTo: topAnchor, constant: 6),
      label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
      label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 9),
      label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -9)
    ])
  }

  required init?(coder: NSCoder) { nil }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  func applyTheme(_ palette: LumenPalette) {
    if palette.isDark {
      layer?.backgroundColor = NSColor(srgbRed: 0.145, green: 0.212, blue: 0.314, alpha: 0.94).cgColor
      layer?.borderWidth = 0.75
      layer?.borderColor = NSColor(srgbRed: 0.76, green: 0.87, blue: 1.0, alpha: 0.22).cgColor
      label.textColor = NSColor(srgbRed: 0.93, green: 0.96, blue: 1.0, alpha: 1.0)
    } else {
      layer?.backgroundColor = NSColor(srgbRed: 0.137, green: 0.196, blue: 0.286, alpha: 0.92).cgColor
      layer?.borderWidth = 0.75
      layer?.borderColor = NSColor.white.withAlphaComponent(0.18).cgColor
      label.textColor = NSColor(srgbRed: 0.94, green: 0.97, blue: 1.0, alpha: 1.0)
    }
  }

  func updateText(_ text: String) {
    label.stringValue = text
    invalidateIntrinsicContentSize()
  }

  func setVisible(_ visible: Bool, animated: Bool) {
    if visible { isHidden = false }
    let duration: TimeInterval = (animated && LumenMotion.isEnabled) ? 0.16 : 0.01
    NSAnimationContext.runAnimationGroup({ ctx in
      ctx.duration = duration
      self.animator().alphaValue = visible ? 1.0 : 0.0
    }, completionHandler: { [weak self] in
      guard let self else { return }
      if !visible && self.alphaValue <= 0.01 {
        self.isHidden = true
      }
    })
  }
}

/// Optical Dots 3.0 (§3.2, §3.3, A05, A06, A20, A22, A23):
/// - Fixed 38 DIP left vertical rail over 10 logical categories (no wrap).
/// - Five-dot sliding window in steady state; empty categories keep their slot at low brightness.
/// - Hover wakes the dock, shows floating label + count, and plays directional neighbor scale/opacity
///   stagger WITHOUT changing the active filter; returns to low-brightness sleep ~900ms after exit.
/// - Zero rings, ripples, trails, or connecting lines.
final class LumenOrbitOpticalDotsView: NSView {
  private let categories = LumenLogicalCategory.allCases // 10 fixed logical categories
  private let visibleCount = LumenV15Tokens.opticalDotsVisibleCount // 5
  private let stepHeight: CGFloat = 32
  private let dotDiameter: CGFloat = 5

  private var dotLayers: [CALayer] = []
  private var trackingArea: NSTrackingArea?
  private var palette: LumenPalette = .light
  private var glowEnabled = true

  private(set) var activeCategory: LumenLogicalCategory = .all
  private var countsByCategory: [LumenLogicalCategory: Int] = [:]
  private var hoveredIndex: Int?
  private(set) var keyboardFocusedIndex: Int?
  private var isPointerInside = false
  private var isFeedbackAwake = false
  private var sleepWork: DispatchWorkItem?

  // Wheel accumulation state (42pt threshold, 180ms reset)
  private var wheelAccumulator: CGFloat = 0
  private var lastWheelTimestamp: TimeInterval = 0

  /// Optional external bubble view hosted above the rail so it never gets clipped by the 38 DIP column.
  weak var bubbleView: LumenOpticalDotBubbleView?

  var onSelectCategory: ((LumenLogicalCategory) -> Void)?
  var onBubblePositionChanged: ((CGFloat, String, Bool) -> Void)?

  override var isFlipped: Bool { true }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.masksToBounds = false
    setAccessibilityRole(.group)
    setAccessibilityLabel("剪贴板类型切换")

    for _ in categories {
      let dot = CALayer()
      dot.bounds = CGRect(x: 0, y: 0, width: dotDiameter, height: dotDiameter)
      dot.cornerRadius = dotDiameter / 2
      dot.opacity = 0
      layer?.addSublayer(dot)
      dotLayers.append(dot)
    }
  }

  required init?(coder: NSCoder) { nil }

  deinit {
    sleepWork?.cancel()
  }

  var isAwake: Bool {
    isPointerInside || isFeedbackAwake || keyboardFocusedIndex != nil
  }

  var hasKeyboardFocus: Bool {
    keyboardFocusedIndex != nil
  }

  var activeIndex: Int {
    categories.firstIndex(of: activeCategory) ?? 0
  }

  func windowStart(for index: Int) -> Int {
    max(0, min(categories.count - visibleCount, index - 2))
  }

  func visibleRange() -> Range<Int> {
    let start = windowStart(for: activeIndex)
    return start..<(start + visibleCount)
  }

  func applyTheme(_ next: LumenPalette, glowEnabled nextGlow: Bool) {
    palette = next
    glowEnabled = nextGlow
    bubbleView?.applyTheme(next)
    updateDotAppearances(animated: false)
  }

  func updateState(active: LumenLogicalCategory, counts: [LumenLogicalCategory: Int], animated: Bool) {
    let prevIndex = activeIndex
    activeCategory = active
    countsByCategory = counts
    let nextIndex = activeIndex

    if let focused = keyboardFocusedIndex, !visibleRange().contains(focused) {
      keyboardFocusedIndex = nextIndex
    }

    layoutDots(animated: animated && prevIndex != nextIndex)
    updateDotAppearances(animated: animated)

    if prevIndex != nextIndex {
      wakeTemporarily(duration: LumenV15Tokens.opticalDotsSleepDelay)
      playDotWave(from: prevIndex, to: nextIndex, isHover: false)
      emitBubble(forIndex: nextIndex, visible: true)
    } else if isAwake {
      let displayIdx = hoveredIndex ?? keyboardFocusedIndex ?? nextIndex
      emitBubble(forIndex: displayIdx, visible: true)
    }
  }

  /// Steps category up (-1) or down (+1) without wrapping at endpoints (§3.2, A20).
  func stepCategory(by delta: Int) {
    let current = activeIndex
    let target = max(0, min(categories.count - 1, current + delta))
    if target == current {
      // Boundary feedback without wrapping
      wakeTemporarily(duration: LumenV15Tokens.opticalDotsSleepDelay)
      playDotWave(from: current, to: current, isHover: false)
      emitBubble(forIndex: current, visible: true)
      return
    }
    let nextCategory = categories[target]
    if keyboardFocusedIndex != nil {
      keyboardFocusedIndex = target
    }
    onSelectCategory?(nextCategory)
  }

  /// Keyboard focus entry into the visible optical dots window (§3.3).
  func focusActiveDot() {
    keyboardFocusedIndex = activeIndex
    sleepWork?.cancel()
    updateDotAppearances(animated: true)
    emitBubble(forIndex: activeIndex, visible: true)
  }

  func clearKeyboardFocus() {
    guard keyboardFocusedIndex != nil else { return }
    keyboardFocusedIndex = nil
    updateDotAppearances(animated: true)
    if !isPointerInside {
      scheduleSleep(after: LumenV15Tokens.opticalDotsSleepDelay)
    }
  }

  /// Moves keyboard focus within the visible dots or steps the window when focused on dots.
  func moveKeyboardFocus(by delta: Int) {
    let current = keyboardFocusedIndex ?? activeIndex
    let target = max(0, min(categories.count - 1, current + delta))
    let prev = current
    keyboardFocusedIndex = target
    if !visibleRange().contains(target) {
      // Switching window keeps focused dot visible
      onSelectCategory?(categories[target])
      return
    }
    wakeTemporarily(duration: LumenV15Tokens.opticalDotsSleepDelay)
    if prev != target {
      playDotWave(from: prev, to: target, isHover: true)
    }
    updateDotAppearances(animated: true)
    emitBubble(forIndex: target, visible: true)
  }

  /// Activates the currently keyboard-focused dot (Enter / Space while dot is focused).
  @discardableResult
  func activateFocusedDot() -> Bool {
    guard let idx = keyboardFocusedIndex, idx >= 0, idx < categories.count else { return false }
    let cat = categories[idx]
    if cat == activeCategory {
      wakeTemporarily(duration: LumenV15Tokens.opticalDotsSleepDelay)
      playDotWave(from: idx, to: idx, isHover: false)
      emitBubble(forIndex: idx, visible: true)
    } else {
      onSelectCategory?(cat)
    }
    return true
  }

  /// Subtle scale feedback on a non-selected visible dot when a clip arrives in another category (§16.4, A41).
  func pulseCategoryDot(_ category: LumenLogicalCategory) {
    guard LumenMotion.isEnabled,
          let idx = categories.firstIndex(of: category),
          visibleRange().contains(idx),
          idx < dotLayers.count else {
      return
    }
    let dot = dotLayers[idx]
    let anim = CAKeyframeAnimation(keyPath: "transform.scale")
    let currentScale = targetScale(for: idx)
    anim.values = [currentScale, 1.9, currentScale]
    anim.keyTimes = [0, 0.4, 1]
    anim.duration = 0.30
    anim.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
    dot.add(anim, forKey: "captureDotPulse")
  }

  /// Shared wheel handler called both when scrolling directly over the dots and on Shift+Wheel over the rail (§3.3).
  func handleTypeWheel(_ event: NSEvent) {
    let rawDeltaY = abs(event.scrollingDeltaY) >= abs(event.scrollingDeltaX)
      ? event.scrollingDeltaY
      : event.scrollingDeltaX
    let scale: CGFloat = event.hasPreciseScrollingDeltas ? 1.0 : 16.0
    // Scrolling down advances to the next category (+1); scrolling up moves to previous (-1).
    let oriented = (event.isDirectionInvertedFromDevice ? rawDeltaY : -rawDeltaY) * scale
    guard abs(oriented) > 0.05 else { return }

    let now = CACurrentMediaTime()
    if now - lastWheelTimestamp > 0.18 || (wheelAccumulator != 0 && (oriented > 0) != (wheelAccumulator > 0)) {
      wheelAccumulator = 0
    }
    lastWheelTimestamp = now
    wheelAccumulator += oriented

    if abs(wheelAccumulator) >= LumenV15Tokens.opticalDotsWheelThreshold {
      let step = wheelAccumulator > 0 ? 1 : -1
      wheelAccumulator = 0
      stepCategory(by: step)
    }
  }

  func resetTransientState() {
    sleepWork?.cancel()
    sleepWork = nil
    hoveredIndex = nil
    keyboardFocusedIndex = nil
    isPointerInside = false
    isFeedbackAwake = false
    wheelAccumulator = 0
    updateDotAppearances(animated: false)
    emitBubble(forIndex: activeIndex, visible: false)
  }

  // MARK: Layout & Geometry

  override func layout() {
    super.layout()
    layoutDots(animated: false)
  }

  private func windowOriginY() -> CGFloat {
    let totalWindowH = CGFloat(visibleCount) * stepHeight
    return floor((bounds.height - totalWindowH) / 2.0)
  }

  private func dotCenterY(for index: Int) -> CGFloat {
    let start = windowStart(for: activeIndex)
    let localSlot = CGFloat(index - start)
    return windowOriginY() + (localSlot + 0.5) * stepHeight
  }

  private func layoutDots(animated: Bool) {
    let range = visibleRange()
    let centerX = bounds.width / 2.0
    let shouldAnimate = animated && LumenMotion.isEnabled

    CATransaction.begin()
    CATransaction.setDisableActions(!shouldAnimate)
    if shouldAnimate {
      CATransaction.setAnimationDuration(0.42)
      CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1))
    }
    for (idx, dot) in dotLayers.enumerated() {
      dot.position = CGPoint(x: centerX, y: dotCenterY(for: idx))
      dot.isHidden = !range.contains(idx)
    }
    CATransaction.commit()
  }

  // MARK: Visual States & Kinetic Wave

  private func targetScale(for index: Int) -> CGFloat {
    let range = visibleRange()
    guard range.contains(index) else { return 0.5 }
    let isOn = index == activeIndex
    let isHovered = hoveredIndex == index || keyboardFocusedIndex == index
    let start = range.lowerBound
    let isEdge = (index == start && start > 0) || (index == start + visibleCount - 1 && start + visibleCount < categories.count)

    if !isAwake {
      return isOn ? 1.12 : 0.78
    }
    if isOn {
      return isHovered ? 1.85 : 1.80
    }
    if isHovered {
      return 1.65
    }
    if isEdge {
      return 0.72
    }
    return 1.0
  }

  private func targetOpacity(for index: Int) -> Float {
    let range = visibleRange()
    guard range.contains(index) else { return 0 }
    let isOn = index == activeIndex
    let isHovered = hoveredIndex == index || keyboardFocusedIndex == index
    let isZero = count(for: index) == 0

    if !isAwake {
      if isOn { return 0.43 }
      return isZero ? 0.13 : 0.24
    }
    if isOn || isHovered { return 1.0 }
    return isZero ? 0.26 : 0.65
  }

  private func updateDotAppearances(animated: Bool) {
    let range = visibleRange()
    let shouldAnimate = animated && LumenMotion.isEnabled
    let baseColor = palette.isDark
      ? NSColor(srgbRed: 0.839, green: 0.918, blue: 1.0, alpha: 1.0)
      : NSColor(srgbRed: 0.906, green: 0.953, blue: 1.0, alpha: 1.0)
    let activeColor = palette.isDark
      ? NSColor.white
      : NSColor(srgbRed: 0.961, green: 0.980, blue: 1.0, alpha: 1.0)

    CATransaction.begin()
    CATransaction.setDisableActions(!shouldAnimate)
    if shouldAnimate {
      CATransaction.setAnimationDuration(0.28)
      CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(controlPoints: 0.2, 0.75, 0.2, 1))
    }
    for (idx, dot) in dotLayers.enumerated() {
      let visible = range.contains(idx)
      dot.isHidden = !visible
      guard visible else {
        dot.opacity = 0
        continue
      }
      let isOn = idx == activeIndex
      let isFocus = keyboardFocusedIndex == idx
      let sc = targetScale(for: idx)
      dot.transform = CATransform3DMakeScale(sc, sc, 1)
      dot.opacity = targetOpacity(for: idx)
      dot.backgroundColor = (isOn ? activeColor : baseColor).cgColor
      if isAwake && glowEnabled && (isOn || isFocus) {
        dot.shadowColor = NSColor(srgbRed: 0.784, green: 0.918, blue: 1.0, alpha: 1.0).cgColor
        dot.shadowOpacity = 0.92
        dot.shadowRadius = 5.5
        dot.shadowOffset = .zero
      } else {
        dot.shadowOpacity = 0
        dot.shadowRadius = 0
      }
    }
    CATransaction.commit()
  }

  /// Kinetic neighbor stagger matching V10/V15 `v10DotWave`:
  /// only dot scale & opacity respond along travel direction — strictly no rings or ripples.
  private func playDotWave(from prev: Int, to next: Int, isHover: Bool) {
    guard LumenMotion.isEnabled else { return }
    let range = visibleRange()
    let dir = (next >= prev) ? 1 : -1
    let now = CACurrentMediaTime()

    for idx in range where abs(idx - next) <= 4 {
      guard idx < dotLayers.count else { continue }
      let dot = dotLayers[idx]
      let endScale = targetScale(for: idx)
      let endOpacity = targetOpacity(for: idx)
      let startScale: CGFloat = (dot.presentation()?.value(forKeyPath: "transform.scale.x") as? NSNumber).map { CGFloat($0.doubleValue) } ?? endScale
      let startOpacity: Float = dot.presentation()?.opacity ?? endOpacity
      let peakScale: CGFloat = (idx == next) ? 2.15 : max(1.10, 1.62 - CGFloat(abs(idx - next)) * 0.17)
      let midScale: CGFloat = (idx == prev && idx != next) ? 1.05 : peakScale
      let midOpacity: Float = (idx == next) ? 1.0 : 0.85

      let distance = dir > 0 ? (idx - min(prev, next)) : (max(prev, next) - idx)
      let delay = Double(max(0, distance)) * 0.026
      let duration: TimeInterval = isHover ? 0.29 : 0.385

      let scaleAnim = CAKeyframeAnimation(keyPath: "transform.scale")
      scaleAnim.values = [startScale, midScale, endScale]
      scaleAnim.keyTimes = [0.0, 0.42, 1.0]

      let opAnim = CAKeyframeAnimation(keyPath: "opacity")
      opAnim.values = [startOpacity, midOpacity, endOpacity]
      opAnim.keyTimes = [0.0, 0.42, 1.0]

      let group = CAAnimationGroup()
      group.animations = [scaleAnim, opAnim]
      group.duration = duration
      group.beginTime = now + delay
      group.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.78, 0.24, 1.0)
      group.fillMode = .backwards

      dot.removeAnimation(forKey: "kineticWave")
      dot.add(group, forKey: "kineticWave")
    }
  }

  private func wakeTemporarily(duration: TimeInterval) {
    isFeedbackAwake = true
    sleepWork?.cancel()
    updateDotAppearances(animated: true)
    scheduleSleep(after: duration)
  }

  private func scheduleSleep(after delay: TimeInterval) {
    sleepWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.isFeedbackAwake = false
      if !self.isPointerInside && self.keyboardFocusedIndex == nil {
        self.updateDotAppearances(animated: true)
        self.emitBubble(forIndex: self.activeIndex, visible: false)
      }
    }
    sleepWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
  }

  private func count(for index: Int) -> Int {
    guard index >= 0, index < categories.count else { return 0 }
    return countsByCategory[categories[index], default: 0]
  }

  private func emitBubble(forIndex index: Int, visible: Bool) {
    guard index >= 0, index < categories.count else { return }
    let range = visibleRange()
    guard range.contains(index) else {
      onBubblePositionChanged?(dotCenterY(for: activeIndex), "", false)
      return
    }
    let cat = categories[index]
    let n = count(for: index)
    let text = "\(cat.label) · \(n)"
    onBubblePositionChanged?(dotCenterY(for: index), text, visible)
  }

  // MARK: Pointer & Wheel Interaction

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let existing = trackingArea {
      removeTrackingArea(existing)
    }
    let area = NSTrackingArea(
      rect: bounds,
      options: [.activeAlways, .mouseEnteredAndExited, .mouseMoved, .inVisibleRect],
      owner: self,
      userInfo: nil
    )
    addTrackingArea(area)
    trackingArea = area
  }

  private func hitDotIndex(at localPoint: NSPoint) -> Int? {
    let originY = windowOriginY()
    let totalH = CGFloat(visibleCount) * stepHeight
    guard localPoint.y >= originY - 6, localPoint.y <= originY + totalH + 6 else { return nil }
    let slot = Int(floor((localPoint.y - originY) / stepHeight))
    let clampedSlot = max(0, min(visibleCount - 1, slot))
    let idx = windowStart(for: activeIndex) + clampedSlot
    return (idx >= 0 && idx < categories.count) ? idx : nil
  }

  override func mouseEntered(with event: NSEvent) {
    isPointerInside = true
    sleepWork?.cancel()
    let pt = convert(event.locationInWindow, from: nil)
    let idx = hitDotIndex(at: pt) ?? activeIndex
    hoveredIndex = idx
    updateDotAppearances(animated: true)
    emitBubble(forIndex: idx, visible: true)
  }

  override func mouseMoved(with event: NSEvent) {
    let pt = convert(event.locationInWindow, from: nil)
    guard let idx = hitDotIndex(at: pt) else { return }
    let prev = hoveredIndex ?? idx
    if prev != idx {
      hoveredIndex = idx
      updateDotAppearances(animated: true)
      playDotWave(from: prev, to: idx, isHover: true)
      emitBubble(forIndex: idx, visible: true)
    } else if !isPointerInside {
      isPointerInside = true
      sleepWork?.cancel()
      updateDotAppearances(animated: true)
      emitBubble(forIndex: idx, visible: true)
    }
  }

  override func mouseExited(with event: NSEvent) {
    isPointerInside = false
    hoveredIndex = nil
    updateDotAppearances(animated: true)
    if keyboardFocusedIndex == nil {
      scheduleSleep(after: LumenV15Tokens.opticalDotsSleepDelay)
    }
  }

  override func mouseDown(with event: NSEvent) {
    let pt = convert(event.locationInWindow, from: nil)
    guard let idx = hitDotIndex(at: pt) else { return }
    let cat = categories[idx]
    if cat == activeCategory {
      wakeTemporarily(duration: LumenV15Tokens.opticalDotsSleepDelay)
      playDotWave(from: idx, to: idx, isHover: false)
      emitBubble(forIndex: idx, visible: true)
    } else {
      onSelectCategory?(cat)
    }
  }

  override func scrollWheel(with event: NSEvent) {
    handleTypeWheel(event)
  }
}
