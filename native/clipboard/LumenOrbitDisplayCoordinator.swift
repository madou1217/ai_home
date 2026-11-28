import AppKit
import Foundation
import QuartzCore

// MARK: - Logical Rail Slots (Unique Item IDs Shared Across All Viewports)

final class OrbitReservationSlot {
  let itemID: String
  let item: LumenClipboardItem
  var width: CGFloat
  var gap: CGFloat
  var reflowTaskID: UUID?
  var phase: String = "dissolve"

  init(item: LumenClipboardItem, width: CGFloat, gap: CGFloat) {
    self.itemID = item.id
    self.item = item
    self.width = width
    self.gap = gap
  }
}

enum OrbitRailSlot {
  case live(LumenClipboardItem)
  case reservation(OrbitReservationSlot)

  var itemID: String {
    switch self {
    case .live(let item): return item.id
    case .reservation(let res): return res.itemID
    }
  }
}

// MARK: - Multi-Display Continuous Bottom Rail Coordinator (§4, A01–A04, A70)

/// Coordinates 1..N borderless floating `OrbitViewport` panels across the participating bottom-row
/// contiguous display group as a SINGLE logical Orbit rail.
///
/// Guarantees:
/// - **Zero mirroring & zero duplicated logical IDs**: `slots` holds each clip at most once.
///   Each `OrbitViewport` mounts only the local card slices intersecting its `descriptor.railRange`,
///   positioned at `localX = (globalOriginX - state.scrollOffset) - descriptor.railRange.lowerBound`
///   and clipped cleanly by `railViewport.layer?.masksToBounds = true`.
/// - **Single Optical Dots 3.0 column**: Rendered exclusively on `leftmostViewport` (`viewports[0]`).
/// - **Unified hover / time-yield / X / lift**: Cards straddling a physical display seam synchronize
///   lift, time-yield, and X reveal across both slices with bezel-crossing hover coalescing.
/// - **Single shared animation clock**: `effectsEngine` runs one monotonic clock driving cross-bezel
///   soft dissolution particles, 420ms reservation reflow, capture aggregation, and animated scrolling.
/// - **Hot-plug & mixed-DPI resilience**: `handleDisplayTopologyChanged()` diffs displays by hardware ID,
///   rebuilds panels and scroll bounds in normalized DIP space, and preserves filter/selection/scroll state.
/// - **Single-screen parity**: When 1 display participates, exactly one `NSPanel` is created and managed.
final class LumenOrbitDisplayCoordinator: NSObject, NSWindowDelegate {
  private(set) var state = OrbitRailState()
  private(set) var viewports: [OrbitViewport] = []
  let effectsEngine = LumenOrbitEffectsEngine()

  private(set) var slots: [OrbitRailSlot] = []
  private var hoveredCardID: String?
  private var keyboardFocusedCardID: String?
  private var hoverClearWork: DispatchWorkItem?
  private var scrollAnimTaskID: UUID?
  private var transitionToken = 0
  private var screenObserver: NSObjectProtocol?

  // Callbacks to QuickOrbitWindow facade
  var onKeyEvent: ((NSEvent) -> Bool)?
  var onCancel: (() -> Void)?
  var onSelectCategory: ((LumenLogicalCategory) -> Void)?
  var onSelectAndPaste: ((String) -> Void)?
  var onRemoveRequested: ((String) -> Void)?
  var onContextMenuRequested: ((String, NSEvent, NSView) -> Void)?
  var onUndoRequested: (() -> Void)?
  var onPanelShouldClose: (() -> Void)?
  var onTopologyDidChange: (() -> Void)?

  /// Leftmost participating viewport — sole owner of the Optical Dots 3.0 column in bottom mode.
  var leftmostViewport: OrbitViewport { viewports[0] }

  /// Primary/active viewport (pointer screen if in participating group, otherwise main/leftmost).
  var primaryViewport: OrbitViewport {
    viewports.first(where: { $0.descriptor.isPrimaryViewport }) ?? viewports[0]
  }

  /// Active Optical Dots view (always hosted on `leftmostViewport`).
  var opticalDots: LumenOrbitOpticalDotsView { leftmostViewport.opticalDots }

  var isVisibleAndKey: Bool {
    state.visible && viewports.contains(where: { $0.panel.isVisible && $0.panel.isKeyWindow })
  }

  var isAnyPanelVisible: Bool {
    viewports.contains(where: { $0.panel.isVisible })
  }

  var liveItems: [LumenClipboardItem] {
    slots.compactMap {
      if case .live(let item) = $0 { return item }
      return nil
    }
  }

  var totalViewportRailSpan: CGFloat {
    if state.isHorizontalRail {
      return max(1, viewports.last?.descriptor.railRange.upperBound ?? primaryViewport.descriptor.railSpanWidth)
    }
    return max(1, primaryViewport.railViewport.bounds.height > 1 ? primaryViewport.railViewport.bounds.height : primaryViewport.descriptor.panelFrame.height)
  }

  override init() {
    super.init()
    rebuildViewportsForCurrentTopology(isShowing: false)

    screenObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.didChangeScreenParametersNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.handleDisplayTopologyChanged()
    }
  }

  deinit {
    hoverClearWork?.cancel()
    effectsEngine.stopAll()
    if let screenObserver {
      NotificationCenter.default.removeObserver(screenObserver)
    }
    for vp in viewports {
      vp.teardown()
    }
  }

  // MARK: State Mutators

  func setEdgePosition(_ position: String) {
    state.edgePosition = OrbitDisplayTopology.normalizePosition(position)
  }

  func setActiveFilter(_ filter: LumenLogicalCategory) {
    state.activeFilter = filter
  }

  func setSelectedClipID(_ id: String?) {
    state.selectedClipID = id
  }

  func setKeyboardFocusedCardID(_ id: String?) {
    keyboardFocusedCardID = id
  }

  func clearHoverAndFocus() {
    hoverClearWork?.cancel()
    hoveredCardID = nil
    keyboardFocusedCardID = nil
  }

  func containsGlobalScreenPoint(_ point: NSPoint) -> Bool {
    viewports.contains(where: { $0.panel.isVisible && NSMouseInRect(point, $0.panel.frame, false) })
  }

  /// Picks the viewport closest to the user's gaze (pointer viewport, falling back to primary)
  /// so toasts appear once on the active screen rather than duplicating across monitors.
  func activeToastViewport() -> OrbitViewport {
    let pointer = NSEvent.mouseLocation
    if let underPointer = viewports.first(where: { NSMouseInRect(pointer, $0.descriptor.screenFrame, false) }) {
      return underPointer
    }
    return primaryViewport
  }

  func showToast(message: String, showUndo: Bool = false) {
    let target = activeToastViewport()
    for vp in viewports where vp !== target {
      vp.toastView.isHidden = true
    }
    target.toastView.show(message: message, showUndo: showUndo)
  }

  // MARK: Multi-Display Topology & Viewport Lifecycle (§4, A01–A04)

  /// Recomputes participating bottom-row displays and diffs `viewports` by hardware display ID.
  /// Preserves logical `activeFilter`, `selectedClipID`, and `scrollOffset` (clamped to new span).
  func rebuildViewportsForCurrentTopology(isShowing: Bool) {
    let descriptors = OrbitDisplayTopology.computeViewports(
      position: state.edgePosition,
      multiWindowEnabled: true
    )

    var existingByID: [String: OrbitViewport] = [:]
    for vp in viewports {
      existingByID[vp.descriptor.id] = vp
    }

    var nextViewports: [OrbitViewport] = []
    nextViewports.reserveCapacity(descriptors.count)

    let palette = LumenPalette.current(LumenClipboardStore.shared.preferences)
    let prefs = LumenClipboardStore.shared.preferences

    for desc in descriptors {
      let vp: OrbitViewport
      if let reused = existingByID.removeValue(forKey: desc.id) {
        reused.applyDescriptor(desc, edgePosition: state.edgePosition)
        vp = reused
      } else {
        vp = OrbitViewport(descriptor: desc, edgePosition: state.edgePosition)
        wireViewport(vp)
        vp.effectsOverlay.attachEngine(effectsEngine)
        vp.applyTheme(palette, preferences: prefs)
      }
      nextViewports.append(vp)
    }

    // Tear down displays that are no longer part of the active bottom-row contiguous group
    for obsolete in existingByID.values {
      obsolete.teardown()
    }

    viewports = nextViewports
    state.updateMetrics(for: descriptors)

    // Ensure every viewport's overlay is attached to the single shared effects engine
    for vp in viewports {
      vp.effectsOverlay.attachEngine(effectsEngine)
    }

    if isShowing {
      for vp in viewports {
        vp.panel.setFrame(vp.descriptor.panelFrame, display: true)
      }
    }
  }

  func handleDisplayTopologyChanged() {
    state.topologyRevision += 1
    state.animationEpoch += 1
    cancelScrollAnimation()
    finalizeAllPendingReservations()
    effectsEngine.stopAll()

    let wasVisible = state.visible
    rebuildViewportsForCurrentTopology(isShowing: wasVisible)

    if wasVisible {
      // Order all participating panels front and ensure a valid participating panel remains key
      for vp in viewports {
        vp.panel.setFrame(vp.descriptor.panelFrame, display: true)
        vp.panel.alphaValue = 1
        vp.panel.orderFrontRegardless()
      }
      if !viewports.contains(where: { $0.panel.isKeyWindow }) {
        primaryViewport.panel.makeKeyAndOrderFront(nil)
      }
      syncMountedCardSlices(animated: false)
      updateCardVisualStates(animated: false)
      reconcileEmptyLabelVisibility()
    }
    onTopologyDidChange?()
  }

  func repositionVisibleViewportsInterruptibly() {
    transitionToken += 1
    state.animationEpoch += 1
    cancelScrollAnimation()
    finalizeAllPendingReservations()
    effectsEngine.stopAll()

    rebuildViewportsForCurrentTopology(isShowing: false)
    syncMountedCardSlices(animated: false)
    updateCardVisualStates(animated: false)
    reconcileEmptyLabelVisibility()

    for vp in viewports {
      vp.panel.orderFrontRegardless()
    }
    primaryViewport.panel.makeKeyAndOrderFront(nil)

    if LumenMotion.isEnabled {
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = 0.34
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.19, 1, 0.25, 1)
        for vp in self.viewports {
          vp.panel.animator().setFrame(vp.descriptor.panelFrame, display: true)
          vp.panel.animator().alphaValue = 1
        }
      }
    } else {
      for vp in viewports {
        vp.panel.setFrame(vp.descriptor.panelFrame, display: true)
        vp.panel.alphaValue = 1
      }
    }
  }

  func saveScrollOffsetForActiveFilter() {
    state.rememberScrollOffset(state.scrollOffset, for: state.activeFilter)
  }

  func showAllPanels(items: [LumenClipboardItem], restoreOffset: CGFloat, animatedArrival: Bool) {
    transitionToken += 1
    let token = transitionToken
    let wasVisible = isAnyPanelVisible
    state.visible = true
    state.animationEpoch += 1

    // Recompute display topology & DIP metrics BEFORE mounting slots so every card slice gets
    // exact target dimensions on frame 0 without duplicate mounting.
    rebuildViewportsForCurrentTopology(isShowing: false)
    slots = items.map { .live($0) }
    reconcileSelectionAndEmptyState()
    state.scrollOffset = max(0, restoreOffset)

    // Position panels at offscreen start frames before ordering front
    for vp in viewports {
      let startFrame = (wasVisible && vp.panel.isVisible) ? vp.panel.frame : vp.offscreenFrame(for: state.edgePosition)
      vp.panel.setFrame(startFrame, display: false)
      if !wasVisible || !vp.panel.isVisible {
        vp.panel.alphaValue = LumenMotion.isEnabled ? 0 : 1
      }
    }

    syncMountedCardSlices(animated: false)
    updateCardVisualStates(animated: false)
    reconcileEmptyLabelVisibility()

    // Order all participating bottom panels front simultaneously; make primary panel key for keyboard input
    for vp in viewports where vp !== primaryViewport {
      vp.panel.orderFrontRegardless()
    }
    primaryViewport.panel.makeKeyAndOrderFront(nil)
    primaryViewport.panel.orderFrontRegardless()
    primaryViewport.panel.makeKey()
    NSApp.activate(ignoringOtherApps: true)
    _ = NSRunningApplication.current.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])

    if LumenMotion.isEnabled {
      NSAnimationContext.runAnimationGroup({ ctx in
        ctx.duration = LumenMotion.enterDuration
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.19, 1.0, 0.25, 1.0)
        for vp in self.viewports {
          vp.panel.animator().setFrame(vp.descriptor.panelFrame, display: true)
          vp.panel.animator().alphaValue = 1
        }
      }, completionHandler: { [weak self] in
        guard let self, self.transitionToken == token else { return }
        for vp in self.viewports {
          vp.panel.setFrame(vp.descriptor.panelFrame, display: true)
          vp.panel.alphaValue = 1
        }
      })
      if !wasVisible && animatedArrival {
        animateCardsArrivalStagger()
      }
    } else {
      for vp in viewports {
        vp.panel.setFrame(vp.descriptor.panelFrame, display: true)
        vp.panel.alphaValue = 1
      }
    }
  }

  func hideAllPanels(completion: @escaping () -> Void) {
    transitionToken += 1
    let token = transitionToken
    state.visible = false
    cancelScrollAnimation()
    finalizeAllPendingReservations()
    effectsEngine.stopAll()
    for vp in viewports {
      vp.opticalDots.resetTransientState()
    }
    clearHoverAndFocus()

    let targets = viewports.map { ($0, $0.offscreenFrame(for: state.edgePosition)) }

    if LumenMotion.isEnabled {
      NSAnimationContext.runAnimationGroup({ ctx in
        ctx.duration = LumenMotion.exitDuration
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.4, 0, 0.5, 1)
        for (vp, endFrame) in targets {
          vp.panel.animator().setFrame(endFrame, display: true)
          vp.panel.animator().alphaValue = 0
        }
      }, completionHandler: { [weak self] in
        guard let self, self.transitionToken == token else { return }
        for vp in self.viewports {
          vp.panel.orderOut(nil)
          vp.panel.alphaValue = 1
        }
        completion()
      })
    } else {
      for vp in viewports {
        vp.panel.orderOut(nil)
        vp.panel.alphaValue = 1
      }
      completion()
    }
  }

  func applyTheme(_ palette: LumenPalette, preferences: LumenVisualPreferences) {
    for vp in viewports {
      vp.applyTheme(palette, preferences: preferences)
      for card in vp.mountedCards.values {
        card.applyTheme(palette, glowEnabled: preferences.glow)
      }
    }
  }

  // MARK: Viewport Wiring

  private func wireViewport(_ viewport: OrbitViewport) {
    viewport.panel.delegate = self
    viewport.panel.onKeyEvent = { [weak self] event in self?.onKeyEvent?(event) ?? false }
    viewport.panel.onCancel = { [weak self] in self?.onCancel?() }
    viewport.toastView.onUndo = { [weak self] in self?.onUndoRequested?() }
    viewport.opticalDots.onSelectCategory = { [weak self] next in
      self?.onSelectCategory?(next)
    }
    // Shift + Wheel on ANY participating bottom screen routes to the single leftmost Optical Dots column
    viewport.railViewport.onShiftWheel = { [weak self] event in
      self?.leftmostViewport.opticalDots.handleTypeWheel(event)
    }
    // Normal wheel / trackpad / drag on ANY participating bottom screen moves the single shared scrollOffset
    viewport.railViewport.onScrollDelta = { [weak self] delta in
      self?.scrollByDelta(delta)
    }
    viewport.railViewport.onDragPanBegan = { [weak self] in
      self?.cancelScrollAnimation()
      return self?.state.scrollOffset ?? 0
    }
    viewport.railViewport.onDragPanMoved = { [weak self] nextOffset in
      self?.setGlobalScrollOffset(nextOffset, animated: false)
    }
  }

  // MARK: Global Scroll Coordination (Single Shared Offset Across All Viewports, A03)

  func computeGlobalSlotGeometry() -> (frames: [NSRect], totalContentSpan: CGFloat) {
    var frames: [NSRect] = []
    frames.reserveCapacity(slots.count)

    if state.isHorizontalRail {
      var cursorX = state.railLeadingInset
      let y = state.railTopInset
      for (idx, slot) in slots.enumerated() {
        let w: CGFloat
        let g: CGFloat
        switch slot {
        case .live:
          w = state.cardWidth
          g = (idx == slots.count - 1) ? 0 : state.cardGap
        case .reservation(let res):
          w = res.width
          g = res.gap
        }
        frames.append(NSRect(x: cursorX, y: y, width: w, height: state.cardHeight))
        cursorX += w + g
      }
      let contentWidth = cursorX + state.railTrailingInset
      return (frames, contentWidth)
    } else {
      var cursorY: CGFloat = 16
      let viewportWidth = primaryViewport.railViewport.bounds.width > 1
        ? primaryViewport.railViewport.bounds.width
        : primaryViewport.descriptor.panelFrame.width
      let x = max(12, floor((viewportWidth - state.cardWidth) / 2))
      for (idx, slot) in slots.enumerated() {
        let h: CGFloat
        let g: CGFloat
        switch slot {
        case .live:
          h = state.cardHeight
          g = (idx == slots.count - 1) ? 0 : state.cardGap
        case .reservation(let res):
          let ratio = state.cardWidth > 0 ? (res.width / state.cardWidth) : 0
          h = state.cardHeight * ratio
          g = res.gap
        }
        frames.append(NSRect(x: x, y: cursorY, width: state.cardWidth, height: h))
        cursorY += h + g
      }
      return (frames, cursorY + 16)
    }
  }

  func maxScrollOffset(forTotalContentSpan totalContentSpan: CGFloat) -> CGFloat {
    max(0, totalContentSpan - totalViewportRailSpan)
  }

  func scrollByDelta(_ delta: CGFloat) {
    cancelScrollAnimation()
    setGlobalScrollOffset(state.scrollOffset + delta, animated: false)
  }

  func setGlobalScrollOffset(_ rawOffset: CGFloat, animated: Bool) {
    let (_, contentSpan) = computeGlobalSlotGeometry()
    let clamped = max(0, min(maxScrollOffset(forTotalContentSpan: contentSpan), rawOffset))

    cancelScrollAnimation()
    guard animated && LumenMotion.isEnabled && abs(clamped - state.scrollOffset) > 0.5 else {
      state.rememberScrollOffset(clamped, for: state.activeFilter)
      syncMountedCardSlices(animated: false)
      effectsEngine.invalidateOverlays()
      return
    }

    let startOffset = state.scrollOffset
    let startTime = CACurrentMediaTime()
    let duration: TimeInterval = 0.24
    scrollAnimTaskID = effectsEngine.addTickTask { [weak self] now in
      guard let self else { return false }
      let rawT = min(1.0, max(0.0, (now - startTime) / duration))
      let eased = LumenMotion.cubicBezier(rawT, 0.2, 0.85, 0.25, 1.0)
      let current = startOffset + (clamped - startOffset) * CGFloat(eased)
      self.state.rememberScrollOffset(current, for: self.state.activeFilter)
      self.syncMountedCardSlices(animated: false)
      self.effectsEngine.invalidateOverlays()
      if rawT >= 1.0 {
        self.scrollAnimTaskID = nil
        return false
      }
      return true
    }
  }

  func cancelScrollAnimation() {
    if let taskID = scrollAnimTaskID {
      effectsEngine.removeTickTask(taskID)
      scrollAnimTaskID = nil
    }
  }

  func scrollCardIntoView(itemID: String, animated: Bool) {
    guard let idx = slots.firstIndex(where: { $0.itemID == itemID }) else { return }
    let (frames, contentSpan) = computeGlobalSlotGeometry()
    guard idx < frames.count else { return }
    let rect = frames[idx]
    let visibleSpan = totalViewportRailSpan
    let maxOffset = maxScrollOffset(forTotalContentSpan: contentSpan)

    let itemMin = state.isHorizontalRail ? rect.minX : rect.minY
    let itemMax = state.isHorizontalRail ? rect.maxX : rect.maxY
    let pad: CGFloat = state.isHorizontalRail ? 24 : 20

    var target = state.scrollOffset
    if itemMin < state.scrollOffset + pad {
      target = max(0, itemMin - pad)
    } else if itemMax > state.scrollOffset + visibleSpan - pad {
      target = min(maxOffset, itemMax - visibleSpan + pad)
    }
    if abs(target - state.scrollOffset) > 0.5 {
      setGlobalScrollOffset(target, animated: animated)
    }
  }

  /// Returns a slot's current frame in GLOBAL scrolled rail coordinates (for cross-screen effects).
  func globalScrolledSlotRect(forItemID itemID: String) -> NSRect? {
    guard let idx = slots.firstIndex(where: { $0.itemID == itemID }) else { return nil }
    let (frames, _) = computeGlobalSlotGeometry()
    guard idx < frames.count else { return nil }
    let unscrolled = frames[idx]
    if state.isHorizontalRail {
      return unscrolled.offsetBy(dx: -state.scrollOffset, dy: 0)
    }
    return unscrolled.offsetBy(dx: 0, dy: -state.scrollOffset)
  }

  func isSlotVisibleAcrossAnyViewport(itemID: String) -> Bool {
    guard let scrolled = globalScrolledSlotRect(forItemID: itemID) else { return false }
    let span = totalViewportRailSpan
    if state.isHorizontalRail {
      return scrolled.maxX >= 0 && scrolled.minX <= span
    }
    return scrolled.maxY >= 0 && scrolled.minY <= span
  }

  // MARK: Logical Slot Reconciliation & Per-Viewport Card Slicing

  func replaceSlots(with items: [LumenClipboardItem], animated: Bool) {
    slots = items.map { .live($0) }
    reconcileSelectionAndEmptyState()
    syncMountedCardSlices(animated: animated)
    updateCardVisualStates(animated: false)
  }

  /// Reconciles live items against store while preserving in-flight deletion reservations at their visual slots.
  func reconcileSlots(with desiredItems: [LumenClipboardItem], animatedReflow: Bool) {
    var reservations: [(Int, OrbitReservationSlot)] = []
    for (idx, slot) in slots.enumerated() {
      if case .reservation(let res) = slot {
        reservations.append((idx, res))
      }
    }

    var nextSlots: [OrbitRailSlot] = desiredItems.map { .live($0) }
    for (pos, res) in reservations {
      let clamped = max(0, min(nextSlots.count, pos))
      nextSlots.insert(.reservation(res), at: clamped)
    }

    slots = nextSlots
    reconcileSelectionAndEmptyState()
    syncMountedCardSlices(animated: animatedReflow && reservations.isEmpty)
    updateCardVisualStates(animated: false)
  }

  func reconcileSelectionAndEmptyState() {
    let live = liveItems
    if let sel = state.selectedClipID, !live.contains(where: { $0.id == sel }) {
      state.selectedClipID = live.first?.id
    } else if state.selectedClipID == nil {
      state.selectedClipID = live.first?.id
    }
    reconcileEmptyLabelVisibility()
  }

  func reconcileEmptyLabelVisibility() {
    let isEmpty = slots.isEmpty
    let message = state.activeFilter == .all ? "暂无剪贴板记录" : "该类型暂无记录"
    let primary = primaryViewport
    for vp in viewports {
      let showHere = isEmpty && (vp === primary)
      vp.emptyLabel.isHidden = !showHere
      if showHere {
        vp.emptyLabel.stringValue = message
      }
    }
  }

  /// Core multi-display slicing & virtualization renderer (§4, §14.2, A01–A04, A70):
  /// Each viewport mounts ONLY the card views whose global scrolled rect intersects its `railRange`.
  /// Cards straddling a physical display seam are mounted as synchronized slices in both adjacent
  /// viewports with exact local X translation (`globalX - railRange.lowerBound`), clipped cleanly
  /// at panel edges so the two halves stitch continuously without ever duplicating logical IDs.
  func syncMountedCardSlices(animated: Bool, duration: TimeInterval = 0.36) {
    let (unscrolledFrames, totalContentSpan) = computeGlobalSlotGeometry()
    let maxOffset = maxScrollOffset(forTotalContentSpan: totalContentSpan)
    if state.scrollOffset > maxOffset {
      state.rememberScrollOffset(maxOffset, for: state.activeFilter)
    }

    let palette = LumenPalette.current(LumenClipboardStore.shared.preferences)
    let glow = LumenClipboardStore.shared.preferences.glow

    // Map live item IDs to quick-key index (0..<9 -> "1".."9")
    var quickKeyByID: [String: Int] = [:]
    var liveOrdinal = 0
    for slot in slots {
      if case .live(let item) = slot {
        if liveOrdinal < 9 {
          quickKeyByID[item.id] = liveOrdinal
        }
        liveOrdinal += 1
      }
    }

    let overscan: CGFloat = 6

    for vp in viewports {
      let vStart = vp.descriptor.railRange.lowerBound
      let vEnd = vp.descriptor.railRange.upperBound
      var keepIDs = Set<String>()

      for (idx, slot) in slots.enumerated() {
        guard idx < unscrolledFrames.count, case .live(let item) = slot else { continue }
        let unscrolled = unscrolledFrames[idx]
        let scrolled = state.isHorizontalRail
          ? unscrolled.offsetBy(dx: -state.scrollOffset, dy: 0)
          : unscrolled.offsetBy(dx: 0, dy: -state.scrollOffset)

        let intersects: Bool
        let localFrame: NSRect
        if state.isHorizontalRail {
          intersects = (scrolled.maxX >= vStart - overscan) && (scrolled.minX <= vEnd + overscan)
          localFrame = NSRect(
            x: scrolled.minX - vStart,
            y: scrolled.minY,
            width: scrolled.width,
            height: scrolled.height
          )
        } else {
          intersects = (scrolled.maxY >= vStart - overscan) && (scrolled.minY <= vEnd + overscan)
          localFrame = NSRect(
            x: scrolled.minX,
            y: scrolled.minY - vStart,
            width: scrolled.width,
            height: scrolled.height
          )
        }

        guard intersects else { continue }
        keepIDs.insert(item.id)

        let keyIdx = quickKeyByID[item.id]
        if let existing = vp.mountedCards[item.id], existing.item == item {
          existing.quickKeyIndex = keyIdx
          if animated && LumenMotion.isEnabled && existing.frame != .zero && existing.frame != localFrame {
            NSAnimationContext.runAnimationGroup { ctx in
              ctx.duration = duration
              ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.16, 1.0, 0.25, 1.0)
              existing.animator().frame = localFrame
            }
          } else {
            existing.frame = localFrame
          }
        } else {
          if let stale = vp.mountedCards.removeValue(forKey: item.id) {
            stale.removeFromSuperview()
          }
          let card = makeCardSlice(for: item, keyIndex: keyIdx, palette: palette, glow: glow)
          card.frame = localFrame
          card.alphaValue = effectsEngine.isAggregating(itemID: item.id) ? 0 : 1
          vp.railViewport.addSubview(card)
          vp.mountedCards[item.id] = card
          applyVisualState(to: card, itemID: item.id, animated: false)
        }
      }

      // Cull card views that have scrolled outside this viewport's interval or been deleted
      for (mountedID, card) in vp.mountedCards where !keepIDs.contains(mountedID) {
        card.removeFromSuperview()
        vp.mountedCards.removeValue(forKey: mountedID)
      }
    }
  }

  /// Returns all currently mounted slice views for a given logical clip ID (1 normally, 2 when straddling a bezel).
  func mountedSlices(for itemID: String) -> [LumenOrbitCardView] {
    viewports.compactMap { $0.mountedCards[itemID] }
  }

  func anyMountedSlice(for itemID: String) -> LumenOrbitCardView? {
    for vp in viewports {
      if let card = vp.mountedCards[itemID] { return card }
    }
    return nil
  }

  private func removeMountedSlices(for itemID: String) {
    for vp in viewports {
      if let card = vp.mountedCards.removeValue(forKey: itemID) {
        card.removeFromSuperview()
      }
    }
  }

  private func makeCardSlice(
    for item: LumenClipboardItem,
    keyIndex: Int?,
    palette: LumenPalette,
    glow: Bool
  ) -> LumenOrbitCardView {
    let card = LumenOrbitCardView(item: item, keyIndex: keyIndex, palette: palette, glowEnabled: glow)
    card.onSelectAndPaste = { [weak self] id in self?.onSelectAndPaste?(id) }
    card.onHoverFocus = { [weak self] id in
      self?.handleSliceHoverEntered(id: id)
    }
    card.onHoverExit = { [weak self] id in
      self?.handleSliceHoverExited(id: id)
    }
    card.onRemoveRequested = { [weak self] id in self?.onRemoveRequested?(id) }
    card.onContextMenuRequested = { [weak self, weak card] id, event in
      guard let self, let card else { return }
      self.onContextMenuRequested?(id, event, card)
    }
    return card
  }

  // MARK: Coordinated Hover, Focus & Lift Across Straddling Slices (§4, §19.1, A70)

  private func handleSliceHoverEntered(id: String) {
    hoverClearWork?.cancel()
    hoveredCardID = id
    leftmostViewport.opticalDots.clearKeyboardFocus()
    state.selectedClipID = id
    updateCardVisualStates(animated: true)
  }

  private func handleSliceHoverExited(id: String) {
    guard hoveredCardID == id else { return }
    hoverClearWork?.cancel()

    // Single-screen or non-straddling cards clear hover immediately (0ms latency);
    // cards straddling a physical display seam coalesce briefly (35ms) so gliding across the bezel
    // never flickers time-yield, X reveal, or lift between adjacent viewports.
    guard viewports.count > 1 && mountedSlices(for: id).count > 1 else {
      hoveredCardID = nil
      updateCardVisualStates(animated: true)
      return
    }

    let work = DispatchWorkItem { [weak self] in
      guard let self, self.hoveredCardID == id else { return }
      if self.isPointerInsideAnySlice(of: id) {
        return
      }
      self.hoveredCardID = nil
      self.updateCardVisualStates(animated: true)
    }
    hoverClearWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.035, execute: work)
  }

  private func isPointerInsideAnySlice(of itemID: String) -> Bool {
    let screenPoint = NSEvent.mouseLocation
    for vp in viewports {
      guard vp.panel.isVisible, let card = vp.mountedCards[itemID] else { continue }
      let winPt = vp.panel.convertPoint(fromScreen: screenPoint)
      let localPt = card.convert(winPt, from: nil)
      if card.bounds.insetBy(dx: -2, dy: -10).contains(localPt) {
        return true
      }
    }
    return false
  }

  func setFocused(id: String, scroll: Bool, fromKeyboard: Bool) {
    state.selectedClipID = id
    if fromKeyboard {
      keyboardFocusedCardID = id
    }
    updateCardVisualStates(animated: true)
    if scroll {
      scrollCardIntoView(itemID: id, animated: true)
    }
  }

  func updateCardVisualStates(animated: Bool = true) {
    let live = liveItems
    let selectedIndex = live.firstIndex(where: { $0.id == state.selectedClipID })
    var indexByID: [String: Int] = [:]
    indexByID.reserveCapacity(live.count)
    for (idx, item) in live.enumerated() {
      indexByID[item.id] = idx
    }

    for vp in viewports {
      for (id, card) in vp.mountedCards {
        let idx = indexByID[id]
        let nextState = computeVisualState(liveIndex: idx, selectedIndex: selectedIndex, itemID: id)
        card.syncCoordinatedState(
          visualState: nextState,
          keyboardFocused: keyboardFocusedCardID == id,
          coordinatedHover: hoveredCardID == id,
          animated: animated
        )
      }
    }
  }

  private func applyVisualState(to card: LumenOrbitCardView, itemID: String, animated: Bool) {
    let live = liveItems
    let selectedIndex = live.firstIndex(where: { $0.id == state.selectedClipID })
    let idx = live.firstIndex(where: { $0.id == itemID })
    let nextState = computeVisualState(liveIndex: idx, selectedIndex: selectedIndex, itemID: itemID)
    card.syncCoordinatedState(
      visualState: nextState,
      keyboardFocused: keyboardFocusedCardID == itemID,
      coordinatedHover: hoveredCardID == itemID,
      animated: animated
    )
  }

  private func computeVisualState(
    liveIndex: Int?,
    selectedIndex: Int?,
    itemID: String
  ) -> LumenOrbitCardView.VisualState {
    if let idx = liveIndex, idx == selectedIndex {
      return .selected
    }
    if hoveredCardID == itemID {
      return .hovered
    }
    if let idx = liveIndex, let sel = selectedIndex, abs(idx - sel) == 1 {
      return .near
    }
    return .idle
  }

  // MARK: Multi-Viewport Transitions (Arrival Stagger, Category Switch, Paste Lift)

  func animateCardsArrivalStagger() {
    let now = CACurrentMediaTime()
    let live = liveItems
    for (idx, item) in live.prefix(16).enumerated() {
      for card in mountedSlices(for: item.id) {
        guard let layer = card.layer else { continue }
        let group = CAAnimationGroup()
        group.beginTime = now + Double(idx) * 0.015
        group.duration = 0.36
        group.fillMode = .backwards
        group.timingFunction = CAMediaTimingFunction(controlPoints: 0.18, 0.86, 0.26, 1)

        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.0
        fade.toValue = 1.0

        let offset = CABasicAnimation(keyPath: "transform.translation.y")
        offset.fromValue = -22.0
        offset.toValue = 0.0

        group.animations = [fade, offset]
        layer.removeAnimation(forKey: "orbitArrival")
        layer.add(group, forKey: "orbitArrival")
      }
    }
  }

  /// Captures outgoing rail snapshots across ALL participating viewports and fades/slides them out
  /// synchronously while switching categories (§3.2, multi-screen consistent).
  func playCategoryExitGhosts(movingDown: Bool) {
    guard LumenMotion.isEnabled else { return }
    let shift: CGFloat = movingDown ? 24.0 : -24.0

    for vp in viewports {
      guard vp.panel.isVisible,
            let hostLayer = vp.backdrop.layer,
            vp.railViewport.bounds.width > 1,
            vp.railViewport.bounds.height > 1,
            let rep = vp.railViewport.bitmapImageRepForCachingDisplay(in: vp.railViewport.bounds) else { continue }
      rep.size = vp.railViewport.bounds.size
      vp.railViewport.cacheDisplay(in: vp.railViewport.bounds, to: rep)
      guard let cgImg = rep.cgImage else { continue }

      let ghost = CALayer()
      ghost.contents = cgImg
      ghost.frame = vp.backdrop.convert(vp.railViewport.bounds, from: vp.railViewport)
      ghost.zPosition = 12
      hostLayer.addSublayer(ghost)

      let exitFade = CABasicAnimation(keyPath: "opacity")
      exitFade.fromValue = 1.0
      exitFade.toValue = 0.0
      let exitMove = CABasicAnimation(keyPath: "transform.translation.y")
      exitMove.fromValue = 0.0
      exitMove.toValue = shift
      let group = CAAnimationGroup()
      group.animations = [exitFade, exitMove]
      group.duration = 0.21
      group.timingFunction = CAMediaTimingFunction(controlPoints: 0.35, 0.0, 0.3, 1.0)
      group.fillMode = .forwards
      group.isRemovedOnCompletion = false
      ghost.add(group, forKey: "typeExitGhost")
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.23) {
        ghost.removeFromSuperlayer()
      }
    }
  }

  func playCategoryEnterSlide(movingDown: Bool) {
    guard LumenMotion.isEnabled else { return }
    let enterFromY: CGFloat = movingDown ? -22.0 : 22.0
    for vp in viewports {
      guard let railLayer = vp.railViewport.layer else { continue }
      let fade = CABasicAnimation(keyPath: "opacity")
      fade.fromValue = 0.0
      fade.toValue = 1.0
      let slide = CABasicAnimation(keyPath: "transform.translation.y")
      slide.fromValue = enterFromY
      slide.toValue = 0.0
      let group = CAAnimationGroup()
      group.animations = [fade, slide]
      group.duration = 0.34
      group.timingFunction = CAMediaTimingFunction(controlPoints: 0.18, 0.85, 0.25, 1.0)
      railLayer.removeAnimation(forKey: "typeSwitchEnter")
      railLayer.add(group, forKey: "typeSwitchEnter")
    }
  }

  func playPasteLiftAnimation(for itemID: String) {
    guard LumenMotion.isEnabled else { return }
    for card in mountedSlices(for: itemID) {
      guard let layer = card.layer else { continue }
      let anim = CAAnimationGroup()
      anim.duration = 0.22
      let lift = CABasicAnimation(keyPath: "transform.translation.y")
      lift.fromValue = 7.0
      lift.toValue = 24.0
      let fade = CABasicAnimation(keyPath: "opacity")
      fade.fromValue = 1.0
      fade.toValue = 0.25
      anim.animations = [lift, fade]
      layer.add(anim, forKey: "orbitPasteLift")
    }
  }

  // MARK: Cross-Screen Live Capture Aggregation (§16.4, A40–A44)

  func insertLiveCapturedItems(
    _ matching: [LumenClipboardItem],
    particlesEnabled: Bool,
    glowEnabled: Bool
  ) -> Bool {
    let wasEmpty = liveItems.isEmpty
    let previousSelectedID = state.selectedClipID
    let prevScrollOffset = state.scrollOffset
    let scrolledAwayFromHead = state.isHorizontalRail && prevScrollOffset > 8

    // Snapshot previous global unscrolled X positions so cards pushed rightward across monitor seams
    // glide smoothly from their previous global X to their new global X.
    let (oldFrames, _) = computeGlobalSlotGeometry()
    var oldGlobalOriginByID: [String: CGPoint] = [:]
    for (idx, slot) in slots.enumerated() where idx < oldFrames.count {
      if case .live(let item) = slot {
        oldGlobalOriginByID[item.id] = oldFrames[idx].origin
      }
    }

    var insertedItems: [LumenClipboardItem] = []
    for item in matching.reversed() {
      if slots.contains(where: { $0.itemID == item.id }) { continue }
      slots.insert(.live(item), at: 0)
      insertedItems.append(item)
    }
    guard !insertedItems.isEmpty else { return false }

    if wasEmpty {
      state.selectedClipID = insertedItems.first?.id
    } else if let prev = previousSelectedID {
      state.selectedClipID = prev
    }
    reconcileSelectionAndEmptyState()

    if scrolledAwayFromHead {
      // Preserve viewport anchor synchronously across ALL participating screens without jumping (A41)
      let addedWidth = CGFloat(insertedItems.count) * (state.cardWidth + state.cardGap)
      state.rememberScrollOffset(prevScrollOffset + addedWidth, for: state.activeFilter)
      syncMountedCardSlices(animated: false)
      updateCardVisualStates(animated: false)
      return true
    }

    // At head & visible: lay out immediately, glide shifted cards rightward 460ms (even across bezels),
    // and aggregate arriving card(s) with shared cotton-light particles (A40).
    let (newFrames, _) = computeGlobalSlotGeometry()
    var newGlobalOriginByID: [String: CGPoint] = [:]
    for (idx, slot) in slots.enumerated() where idx < newFrames.count {
      if case .live(let item) = slot {
        newGlobalOriginByID[item.id] = newFrames[idx].origin
      }
    }

    syncMountedCardSlices(animated: false)
    updateCardVisualStates(animated: false)

    if LumenMotion.isEnabled {
      let insertedIDSet = Set(insertedItems.map(\.id))
      for vp in viewports {
        for (clipID, card) in vp.mountedCards {
          guard !insertedIDSet.contains(clipID),
                let oldOrigin = oldGlobalOriginByID[clipID],
                let newOrigin = newGlobalOriginByID[clipID] else { continue }
          let dx = newOrigin.x - oldOrigin.x
          let dy = newOrigin.y - oldOrigin.y
          guard abs(dx) > 0.5 || abs(dy) > 0.5 else { continue }
          let targetFrame = card.frame
          card.frame = targetFrame.offsetBy(dx: -dx, dy: -dy)
          NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.46
            ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.16, 1.0, 0.25, 1.0)
            card.animator().frame = targetFrame
          }
        }
      }

      let isDark = LumenPalette.current(LumenClipboardStore.shared.preferences).isDark
      for arriving in insertedItems {
        guard let sampleSlice = anyMountedSlice(for: arriving.id) else { continue }
        let clipID = arriving.id
        effectsEngine.startAggregation(
          itemID: clipID,
          cardView: sampleSlice.snapshotTargetView,
          fallbackTint: sampleSlice.identity.tintColor(isDark: isDark),
          particlesEnabled: particlesEnabled,
          glowEnabled: glowEnabled,
          globalAnchorFrameProvider: { [weak self] in
            self?.globalScrolledSlotRect(forItemID: clipID)
          },
          onSetTargetAlpha: { [weak self] alpha in
            guard let self else { return }
            for slice in self.mountedSlices(for: clipID) {
              slice.alphaValue = alpha
            }
          }
        )
      }
    }
    return true
  }

  // MARK: Cross-Screen Two-Phase Soft Dissolution & 420ms Reflow (§17.2, §18.4, A49–A51, A70)

  /// Initiates removal of `id` across 1..N displays:
  /// - Phase 0: Immediately replaces the live slot with a non-interactive reservation holding exact width+gap.
  /// - Phase 1: Renders ONE shared soft-light dissolution particle field in global coordinates across any
  ///   intersecting viewport(s), strictly waiting until every tail particle extinguishes.
  /// - Phase 2: Collapses reservation width+gap continuously over 420ms on the shared clock so cards on
  ///   downstream monitors glide smoothly leftward across physical display seams.
  /// Returns `true` if the item existed and removal began.
  func beginCardRemoval(
    id: String,
    particlesEnabled: Bool,
    glowEnabled: Bool
  ) -> Bool {
    guard let slotIdx = slots.firstIndex(where: {
      if case .live(let item) = $0 { return item.id == id }
      return false
    }), case .live(let item) = slots[slotIdx] else { return false }

    let liveBefore = liveItems
    let liveIdx = liveBefore.firstIndex(where: { $0.id == id }) ?? 0

    // Immediate focus transfer to next live card (or previous if last)
    if state.selectedClipID == id {
      if liveIdx + 1 < liveBefore.count {
        state.selectedClipID = liveBefore[liveIdx + 1].id
      } else if liveIdx > 0 {
        state.selectedClipID = liveBefore[liveIdx - 1].id
      } else {
        state.selectedClipID = nil
      }
    }
    if hoveredCardID == id { hoveredCardID = nil }
    if keyboardFocusedCardID == id { keyboardFocusedCardID = state.selectedClipID }

    effectsEngine.cancelAggregation(for: id)

    let sampleSlice = anyMountedSlice(for: id)
    let isVisible = (sampleSlice != nil) && isSlotVisibleAcrossAnyViewport(itemID: id)
    let shouldAnimate = LumenMotion.isEnabled && isVisible

    if !shouldAnimate {
      removeMountedSlices(for: id)
      slots.remove(at: slotIdx)
      reconcileSelectionAndEmptyState()
      syncMountedCardSlices(animated: false)
      updateCardVisualStates(animated: true)
      return true
    }

    // Phase 0: Non-interactive reservation occupying exact width & gap — neighbors stay pinned at 0px shift
    let isLastSlot = (slotIdx == slots.count - 1)
    let reservation = OrbitReservationSlot(
      item: item,
      width: state.cardWidth,
      gap: isLastSlot ? 0 : state.cardGap
    )
    slots[slotIdx] = .reservation(reservation)

    let isDark = LumenPalette.current(LumenClipboardStore.shared.preferences).isDark
    let tint = item.contentIdentity.tintColor(isDark: isDark)

    // Capture full unclipped card texture from any mounted slice BEFORE unmounting slices
    if let slice = sampleSlice {
      effectsEngine.startDissolve(
        itemID: id,
        cardView: slice.snapshotTargetView,
        fallbackTint: tint,
        particlesEnabled: particlesEnabled,
        glowEnabled: glowEnabled,
        globalAnchorFrameProvider: { [weak self] in
          self?.globalScrolledSlotRect(forItemID: id)
        },
        onParticlesFinished: { [weak self] in
          // Phase 2 begins STRICTLY after every tail particle extinguishes (A49, A65, A70)
          self?.beginReservationCollapse(reservation)
        }
      )
    }

    removeMountedSlices(for: id)
    reconcileSelectionAndEmptyState()
    updateCardVisualStates(animated: true)
    return true
  }

  private func beginReservationCollapse(_ reservation: OrbitReservationSlot) {
    guard slots.contains(where: { $0.itemID == reservation.itemID }) else { return }
    reservation.phase = "reflow"
    let startWidth = reservation.width
    let startGap = reservation.gap
    let startTime = CACurrentMediaTime()
    let duration = LumenV15Tokens.dissolveReflowDuration

    guard LumenMotion.isEnabled else {
      finishReservation(reservation)
      return
    }

    reservation.reflowTaskID = effectsEngine.addTickTask { [weak self, weak reservation] now in
      guard let self, let res = reservation else { return false }
      guard self.slots.contains(where: { $0.itemID == res.itemID }) else { return false }
      let rawT = min(1.0, max(0.0, (now - startTime) / max(0.01, duration)))
      let eased = LumenMotion.easeFluidPane(rawT)
      let remaining = CGFloat(1.0 - eased)
      res.width = startWidth * remaining
      res.gap = startGap * remaining
      self.syncMountedCardSlices(animated: false)
      self.effectsEngine.invalidateOverlays()
      if rawT >= 1.0 {
        self.finishReservation(res)
        return false
      }
      return true
    }
  }

  private func finishReservation(_ reservation: OrbitReservationSlot) {
    if let taskID = reservation.reflowTaskID {
      effectsEngine.removeTickTask(taskID)
      reservation.reflowTaskID = nil
    }
    slots.removeAll { $0.itemID == reservation.itemID }
    reconcileSelectionAndEmptyState()
    syncMountedCardSlices(animated: false)
    updateCardVisualStates(animated: true)
  }

  func finalizeAllPendingReservations() {
    var removedAny = false
    for slot in slots {
      if case .reservation(let res) = slot {
        effectsEngine.cancelDissolve(for: res.itemID)
        if let taskID = res.reflowTaskID {
          effectsEngine.removeTickTask(taskID)
          res.reflowTaskID = nil
        }
        removedAny = true
      }
    }
    if removedAny {
      slots.removeAll {
        if case .reservation = $0 { return true }
        return false
      }
      reconcileSelectionAndEmptyState()
      syncMountedCardSlices(animated: false)
      updateCardVisualStates(animated: false)
    }
  }

  func cancelReservation(for itemID: String) {
    guard let idx = slots.firstIndex(where: {
      if case .reservation(let r) = $0 { return r.itemID == itemID }
      return false
    }), case .reservation(let res) = slots[idx] else { return }

    effectsEngine.cancelDissolve(for: itemID)
    if let taskID = res.reflowTaskID {
      effectsEngine.removeTickTask(taskID)
      res.reflowTaskID = nil
    }
    slots.remove(at: idx)
  }

  func restoreItemInPlaceOrSequence(
    _ restored: LumenClipboardItem,
    desiredSequenceIndex: Int,
    particlesEnabled: Bool,
    glowEnabled: Bool
  ) {
    if let resIdx = slots.firstIndex(where: {
      if case .reservation(let r) = $0 { return r.itemID == restored.id }
      return false
    }), case .reservation(let res) = slots[resIdx] {
      effectsEngine.cancelDissolve(for: res.itemID)
      if let taskID = res.reflowTaskID {
        effectsEngine.removeTickTask(taskID)
        res.reflowTaskID = nil
      }
      slots[resIdx] = .live(restored)
    } else if !slots.contains(where: { $0.itemID == restored.id }) {
      let clamped = max(0, min(slots.count, desiredSequenceIndex))
      slots.insert(.live(restored), at: clamped)
    }

    state.selectedClipID = restored.id
    reconcileSelectionAndEmptyState()
    syncMountedCardSlices(animated: true, duration: 0.38)
    updateCardVisualStates(animated: true)
    scrollCardIntoView(itemID: restored.id, animated: true)

    if let sampleSlice = anyMountedSlice(for: restored.id) {
      let clipID = restored.id
      let isDark = LumenPalette.current(LumenClipboardStore.shared.preferences).isDark
      effectsEngine.startAggregation(
        itemID: clipID,
        cardView: sampleSlice.snapshotTargetView,
        fallbackTint: sampleSlice.identity.tintColor(isDark: isDark),
        particlesEnabled: particlesEnabled,
        glowEnabled: glowEnabled,
        globalAnchorFrameProvider: { [weak self] in
          self?.globalScrolledSlotRect(forItemID: clipID)
        },
        onSetTargetAlpha: { [weak self] alpha in
          guard let self else { return }
          for slice in self.mountedSlices(for: clipID) {
            slice.alphaValue = alpha
          }
        }
      )
    }
  }

  // MARK: NSWindowDelegate

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    onPanelShouldClose?()
    return false
  }
}
