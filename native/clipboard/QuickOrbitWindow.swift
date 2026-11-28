import AppKit
import Foundation
import QuartzCore

/// Pure native Paste Lumen V15 Quick Orbit controller (zero WebView/HTML).
/// Orchestrates `OrbitRailState` across `OrbitViewport` instances, Optical Dots 3.0,
/// V15 content-first cards with synchronized X choreography, two-phase texture-driven
/// Soft Dissolution + 420ms reflow, real-time capture aggregation, and full keyboard/pointer map.
final class QuickOrbitWindow: NSObject, NSWindowDelegate {
  private final class ReservationSlot {
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

  private enum RailSlot {
    case live(LumenOrbitCardView)
    case reservation(ReservationSlot)

    var itemID: String {
      switch self {
      case .live(let card): return card.item.id
      case .reservation(let res): return res.itemID
      }
    }
  }

  private let store = LumenClipboardStore.shared
  private var state = OrbitRailState()
  private var viewports: [OrbitViewport] = []

  /// Primary NSPanel exposed for host AppDelegate visibility checks (`native/translation/main.swift`, `native/aihome-app/main.swift`).
  var panel: NSPanel { primaryViewport.panel }
  private var primaryViewport: OrbitViewport { viewports[0] }

  private var enabled = false
  private var transitionToken = 0
  private var previousApp: NSRunningApplication?
  private var outsideClickMonitor: Any?
  private var screenObserver: NSObjectProtocol?
  private var observerID: UUID?

  private var slots: [RailSlot] = []
  private var hoveredCardID: String?
  private var keyboardFocusedCardID: String?
  private var isContextMenuOpen = false
  private var suppressNextItemsUpdatedReconcile = false

  var onOpenWorkspace: (() -> Void)?
  var onOpenWorkspaceWithSelection: ((String?) -> Void)?

  override init() {
    let initialDescriptors = OrbitDisplayTopology.computeViewports(position: "bottom", multiWindowEnabled: false)
    let first = OrbitViewport(descriptor: initialDescriptors[0])
    self.viewports = [first]
    super.init()

    wireViewport(first)
    applyTheme()

    screenObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.didChangeScreenParametersNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.handleDisplayTopologyChanged()
    }

    observerID = store.addObserver { [weak self] event in
      guard let self else { return }
      switch event {
      case .itemsUpdated:
        self.updateOpticalDotsState(animated: false)
        if self.suppressNextItemsUpdatedReconcile {
          self.suppressNextItemsUpdatedReconcile = false
        } else if self.state.visible {
          self.reconcileLiveCardsWithStore(animatedReflow: true)
        }
      case .itemsCaptured(let captured):
        self.handleLiveCapturedItems(captured)
      case .itemRestored(let restored, _):
        self.handleRestoredItem(restored)
      case .preferencesUpdated:
        self.applyTheme()
        if !LumenMotion.isEnabled || !self.store.preferences.particles {
          self.finalizeAllPendingReservations()
        }
      case .settingsUpdated:
        let nextPos = OrbitDisplayTopology.normalizePosition(self.store.settings.quickOrbitPosition)
        if nextPos != self.state.edgePosition {
          self.state.edgePosition = nextPos
          if self.state.visible {
            self.repositionVisibleViewportsInterruptibly()
          } else {
            self.refreshViewportDescriptors()
          }
        }
      default:
        break
      }
    }
  }

  deinit {
    store.stopLiveOrbitCapture()
    removeOutsideClickMonitor()
    if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
    if let id = observerID { store.removeObserver(id) }
  }

  var isAvailable: Bool {
    guard enabled else { return false }
    if !store.isConfigured {
      store.ensureConfiguredFromLocalConfig()
    }
    return store.isConfigured
  }

  var isVisibleAndKey: Bool {
    state.visible && viewports.contains(where: { $0.panel.isVisible && $0.panel.isKeyWindow })
  }

  func configure(origin nextOrigin: String, managementKey nextKey: String, enabled nextEnabled: Bool, position nextPosition: String) {
    let normalizedPosition = OrbitDisplayTopology.normalizePosition(nextPosition)
    let posChanged = normalizedPosition != state.edgePosition
    enabled = nextEnabled
    state.edgePosition = normalizedPosition

    if !nextOrigin.isEmpty || !nextKey.isEmpty {
      store.configure(origin: nextOrigin, managementKey: nextKey)
    } else if nextEnabled {
      store.ensureConfiguredFromLocalConfig()
    }

    if !nextEnabled {
      hide()
      return
    }
    if posChanged && state.visible {
      repositionVisibleViewportsInterruptibly()
    } else if posChanged {
      refreshViewportDescriptors()
    }
  }

  func toggle() {
    if state.visible {
      hide()
    } else {
      show()
    }
  }

  func show() {
    store.ensureConfiguredFromLocalConfig()
    guard isAvailable else { return }

    transitionToken += 1
    let token = transitionToken
    let wasVisible = primaryViewport.panel.isVisible
    state.visible = true
    state.animationEpoch += 1

    if !wasVisible {
      let front = NSWorkspace.shared.frontmostApplication
      if front?.processIdentifier != ProcessInfo.processInfo.processIdentifier {
        previousApp = front
      }
    }

    refreshViewportDescriptors()
    let target = primaryViewport.descriptor.panelFrame
    let start = wasVisible ? primaryViewport.panel.frame : primaryViewport.offscreenFrame(for: state.edgePosition)

    state.updateMetrics(for: target)
    primaryViewport.railScroll.isHorizontalRail = state.isHorizontalRail
    rebuildSlotsFromStore(animated: false)
    updateOpticalDotsState(animated: false)
    store.refreshItems()
    store.startLiveOrbitCapture()

    primaryViewport.panel.setFrame(start, display: false)
    if !wasVisible {
      primaryViewport.panel.alphaValue = LumenMotion.isEnabled ? 0 : 1
    }
    primaryViewport.panel.makeKeyAndOrderFront(nil)
    primaryViewport.panel.orderFrontRegardless()
    primaryViewport.panel.makeKey()
    NSApp.activate(ignoringOtherApps: true)
    _ = NSRunningApplication.current.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    installOutsideClickMonitor()

    primaryViewport.syncScrollOffset(globalOffset: state.savedScrollOffset(for: state.activeFilter), animated: false)

    if LumenMotion.isEnabled {
      NSAnimationContext.runAnimationGroup({ ctx in
        ctx.duration = LumenMotion.enterDuration
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.19, 1.0, 0.25, 1.0)
        self.primaryViewport.panel.animator().setFrame(target, display: true)
        self.primaryViewport.panel.animator().alphaValue = 1
      }, completionHandler: { [weak self] in
        guard let self, self.transitionToken == token else { return }
        self.primaryViewport.panel.setFrame(target, display: true)
        self.primaryViewport.panel.alphaValue = 1
      })
      if !wasVisible {
        animateCardsArrivalStagger()
      }
    } else {
      primaryViewport.panel.setFrame(target, display: true)
      primaryViewport.panel.alphaValue = 1
    }
  }

  func hide(restoreFocus: Bool = true) {
    guard state.visible || primaryViewport.panel.isVisible else { return }
    transitionToken += 1
    let token = transitionToken
    state.visible = false
    store.stopLiveOrbitCapture()
    removeOutsideClickMonitor()
    finalizeAllPendingReservations()
    primaryViewport.effectsOverlay.stopAll()
    primaryViewport.opticalDots.resetTransientState()
    hoveredCardID = nil
    keyboardFocusedCardID = nil

    let end = primaryViewport.offscreenFrame(for: state.edgePosition)
    let appToRestore = restoreFocus ? previousApp : nil
    previousApp = nil

    if LumenMotion.isEnabled {
      NSAnimationContext.runAnimationGroup({ ctx in
        ctx.duration = LumenMotion.exitDuration
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.4, 0, 0.5, 1)
        self.primaryViewport.panel.animator().setFrame(end, display: true)
        self.primaryViewport.panel.animator().alphaValue = 0
      }, completionHandler: { [weak self] in
        guard let self, self.transitionToken == token else { return }
        self.primaryViewport.panel.orderOut(nil)
        self.primaryViewport.panel.alphaValue = 1
        if let app = appToRestore, !app.isTerminated {
          _ = app.activate(options: [.activateIgnoringOtherApps])
        }
      })
    } else {
      primaryViewport.panel.orderOut(nil)
      primaryViewport.panel.alphaValue = 1
      if let app = appToRestore, !app.isTerminated {
        _ = app.activate(options: [.activateIgnoringOtherApps])
      }
    }
  }

  // MARK: Viewport Wiring & Display Topology

  private func wireViewport(_ viewport: OrbitViewport) {
    viewport.panel.delegate = self
    viewport.panel.onKeyEvent = { [weak self] event in self?.handleKeyDown(event) ?? false }
    viewport.panel.onCancel = { [weak self] in self?.handleEscapeChain() }
    viewport.toastView.onUndo = { [weak self] in self?.undoLastDelete() }
    viewport.opticalDots.onSelectCategory = { [weak self] next in
      self?.selectCategory(next)
    }
    viewport.railScroll.onShiftWheel = { [weak self] event in
      self?.primaryViewport.opticalDots.handleTypeWheel(event)
    }
    viewport.railScroll.onScrollOffsetChanged = { [weak self] localX in
      guard let self else { return }
      let globalX = viewport.descriptor.railRange.lowerBound + localX
      self.state.rememberScrollOffset(globalX, for: self.state.activeFilter)
    }
  }

  private func refreshViewportDescriptors() {
    let descriptors = OrbitDisplayTopology.computeViewports(position: state.edgePosition, multiWindowEnabled: false)
    guard let first = descriptors.first else { return }
    primaryViewport.applyDescriptor(first, edgePosition: state.edgePosition)
  }

  private func handleDisplayTopologyChanged() {
    state.topologyRevision += 1
    finalizeAllPendingReservations()
    primaryViewport.effectsOverlay.stopAll()
    refreshViewportDescriptors()
    let target = primaryViewport.descriptor.panelFrame
    state.updateMetrics(for: target)
    primaryViewport.railScroll.isHorizontalRail = state.isHorizontalRail
    if state.visible {
      primaryViewport.panel.setFrame(target, display: true)
      layoutSlots(animated: false)
      primaryViewport.syncScrollOffset(globalOffset: state.scrollOffset, animated: false)
    }
  }

  private func repositionVisibleViewportsInterruptibly() {
    transitionToken += 1
    finalizeAllPendingReservations()
    refreshViewportDescriptors()
    let target = primaryViewport.descriptor.panelFrame
    state.updateMetrics(for: target)
    primaryViewport.railScroll.isHorizontalRail = state.isHorizontalRail
    layoutSlots(animated: true)
    if LumenMotion.isEnabled {
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = 0.34
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.19, 1, 0.25, 1)
        self.primaryViewport.panel.animator().setFrame(target, display: true)
      }
    } else {
      primaryViewport.panel.setFrame(target, display: true)
    }
  }

  private func applyTheme() {
    let palette = LumenPalette.current(store.preferences)
    for vp in viewports {
      vp.applyTheme(palette, preferences: store.preferences)
    }
    for slot in slots {
      if case .live(let card) = slot {
        card.applyTheme(palette, glowEnabled: store.preferences.glow)
      }
    }
  }

  // MARK: Category Filtering & Optical Dots 3.0 (§3.2, A05, A06, A20–A23)

  private func filteredStoreItems(for category: LumenLogicalCategory? = nil) -> [LumenClipboardItem] {
    let target = category ?? state.activeFilter
    if target == .all { return store.items }
    return store.items.filter { $0.logicalCategory == target }
  }

  private func categoryCounts() -> [LumenLogicalCategory: Int] {
    var counts: [LumenLogicalCategory: Int] = [.all: store.items.count]
    for item in store.items {
      counts[item.logicalCategory, default: 0] += 1
    }
    return counts
  }

  private func updateOpticalDotsState(animated: Bool) {
    primaryViewport.opticalDots.updateState(
      active: state.activeFilter,
      counts: categoryCounts(),
      animated: animated
    )
  }

  private func selectCategory(_ next: LumenLogicalCategory) {
    guard next != state.activeFilter else { return }
    let categories = LumenLogicalCategory.allCases
    let prevIdx = categories.firstIndex(of: state.activeFilter) ?? 0
    let nextIdx = categories.firstIndex(of: next) ?? 0
    let movingDown = nextIdx > prevIdx

    // Save current filter's scroll offset & finalize transient reservations (§17.2)
    state.rememberScrollOffset(primaryViewport.currentGlobalScrollOffset(), for: state.activeFilter)
    finalizeAllPendingReservations()
    primaryViewport.effectsOverlay.stopAll()

    // Bidirectional exit ghost of outgoing rail before mounting new category (§3.2)
    if LumenMotion.isEnabled,
       let hostLayer = primaryViewport.backdrop.layer,
       let rep = primaryViewport.railScroll.bitmapImageRepForCachingDisplay(in: primaryViewport.railScroll.bounds) {
      rep.size = primaryViewport.railScroll.bounds.size
      primaryViewport.railScroll.cacheDisplay(in: primaryViewport.railScroll.bounds, to: rep)
      if let cgImg = rep.cgImage {
        let ghost = CALayer()
        ghost.contents = cgImg
        ghost.frame = primaryViewport.backdrop.convert(primaryViewport.railScroll.bounds, from: primaryViewport.railScroll)
        ghost.zPosition = 12
        hostLayer.addSublayer(ghost)

        let shift: CGFloat = movingDown ? 24.0 : -24.0
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

    state.activeFilter = next
    hoveredCardID = nil
    keyboardFocusedCardID = nil

    rebuildSlotsFromStore(animated: false)
    let savedOffset = state.savedScrollOffset(for: next)
    state.scrollOffset = savedOffset
    primaryViewport.syncScrollOffset(globalOffset: savedOffset, animated: false)
    updateOpticalDotsState(animated: true)

    // Ensure selected item is visible if valid
    if let sel = state.selectedClipID, let card = liveCard(for: sel) {
      primaryViewport.railScroll.scrollToRectAnimated(card.frame, animated: false)
    }

    // Bidirectional enter animation (opposite direction of travel, §3.2)
    if LumenMotion.isEnabled, let docLayer = primaryViewport.railDocument.layer {
      let enterFromY: CGFloat = movingDown ? -22.0 : 22.0
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
      docLayer.removeAnimation(forKey: "typeSwitchEnter")
      docLayer.add(group, forKey: "typeSwitchEnter")
    }
  }

  // MARK: Rail Slots, Card Reconciliation & Layout

  private var liveCards: [LumenOrbitCardView] {
    slots.compactMap {
      if case .live(let card) = $0 { return card }
      return nil
    }
  }

  private func liveCard(for id: String) -> LumenOrbitCardView? {
    for slot in slots {
      if case .live(let card) = slot, card.item.id == id {
        return card
      }
    }
    return nil
  }

  private func makeCard(for item: LumenClipboardItem, keyIndex: Int?) -> LumenOrbitCardView {
    let palette = LumenPalette.current(store.preferences)
    let card = LumenOrbitCardView(item: item, keyIndex: keyIndex, palette: palette, glowEnabled: store.preferences.glow)
    card.onSelectAndPaste = { [weak self] id in self?.pasteAndDismiss(id: id) }
    card.onHoverFocus = { [weak self] id in
      guard let self else { return }
      self.hoveredCardID = id
      self.primaryViewport.opticalDots.clearKeyboardFocus()
      self.setFocused(id: id, scroll: false, fromKeyboard: false)
    }
    card.onHoverExit = { [weak self] id in
      guard let self else { return }
      if self.hoveredCardID == id {
        self.hoveredCardID = nil
        self.updateCardVisualStates()
      }
    }
    card.onRemoveRequested = { [weak self] id in self?.removeCardAnimated(id: id) }
    card.onContextMenuRequested = { [weak self] id, event in self?.presentContextMenu(for: id, event: event) }
    return card
  }

  private func rebuildSlotsFromStore(animated: Bool) {
    let items = filteredStoreItems()
    let palette = LumenPalette.current(store.preferences)
    let glow = store.preferences.glow

    var existingByID: [String: LumenOrbitCardView] = [:]
    for slot in slots {
      if case .live(let card) = slot {
        existingByID[card.item.id] = card
      }
    }
    slots.removeAll()

    for (idx, item) in items.enumerated() {
      let keyIdx: Int? = idx < 9 ? idx : nil
      if let reused = existingByID.removeValue(forKey: item.id), reused.item == item {
        reused.quickKeyIndex = keyIdx
        reused.applyTheme(palette, glowEnabled: glow)
        slots.append(.live(reused))
      } else {
        if let stale = existingByID.removeValue(forKey: item.id) {
          stale.removeFromSuperview()
        }
        let card = makeCard(for: item, keyIndex: keyIdx)
        primaryViewport.railDocument.addSubview(card)
        slots.append(.live(card))
      }
    }
    for obsolete in existingByID.values {
      obsolete.removeFromSuperview()
    }

    reconcileSelectionAndEmptyState()
    layoutSlots(animated: animated)
    updateCardVisualStates()
  }

  /// Reconciles live cards against store while keeping active deletion reservations intact (§17.2).
  private func reconcileLiveCardsWithStore(animatedReflow: Bool) {
    let desiredItems = filteredStoreItems()
    let palette = LumenPalette.current(store.preferences)
    let glow = store.preferences.glow

    var existingCards: [String: LumenOrbitCardView] = [:]
    var reservationIndexPositions: [(Int, ReservationSlot)] = []
    for (slotIdx, slot) in slots.enumerated() {
      switch slot {
      case .live(let card):
        existingCards[card.item.id] = card
      case .reservation(let res):
        reservationIndexPositions.append((slotIdx, res))
      }
    }

    var nextSlots: [RailSlot] = []
    nextSlots.reserveCapacity(desiredItems.count + reservationIndexPositions.count)
    for (idx, item) in desiredItems.enumerated() {
      let keyIdx: Int? = idx < 9 ? idx : nil
      if let reused = existingCards.removeValue(forKey: item.id), reused.item == item {
        reused.quickKeyIndex = keyIdx
        reused.applyTheme(palette, glowEnabled: glow)
        nextSlots.append(.live(reused))
      } else {
        if let stale = existingCards.removeValue(forKey: item.id) {
          stale.removeFromSuperview()
        }
        let card = makeCard(for: item, keyIndex: keyIdx)
        primaryViewport.railDocument.addSubview(card)
        nextSlots.append(.live(card))
      }
    }
    for obsolete in existingCards.values {
      obsolete.removeFromSuperview()
    }

    // Re-insert active deletion reservations at their tracked visual indices so adjacent cards never jump
    for (pos, res) in reservationIndexPositions {
      let clamped = max(0, min(nextSlots.count, pos))
      nextSlots.insert(.reservation(res), at: clamped)
    }

    slots = nextSlots
    reconcileSelectionAndEmptyState()
    layoutSlots(animated: animatedReflow && reservationIndexPositions.isEmpty)
    updateCardVisualStates()
  }

  private func reconcileSelectionAndEmptyState() {
    let live = liveCards
    if slots.isEmpty {
      primaryViewport.emptyLabel.isHidden = false
      primaryViewport.emptyLabel.stringValue = state.activeFilter == .all ? "暂无剪贴板记录" : "该类型暂无记录"
    } else {
      primaryViewport.emptyLabel.isHidden = true
    }

    if let sel = state.selectedClipID, !live.contains(where: { $0.item.id == sel }) {
      state.selectedClipID = live.first?.item.id
    } else if state.selectedClipID == nil {
      state.selectedClipID = live.first?.item.id
    }

    for (idx, card) in live.enumerated() {
      card.quickKeyIndex = idx < 9 ? idx : nil
    }
  }

  private func computeSlotFrames() -> (frames: [NSRect], docSize: NSSize) {
    let horizontal = state.isHorizontalRail
    var frames: [NSRect] = []
    frames.reserveCapacity(slots.count)

    if horizontal {
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
      let docW = max(primaryViewport.railScroll.bounds.width, cursorX + state.railTrailingInset)
      let docH = max(primaryViewport.railScroll.bounds.height, state.cardHeight + state.railTopInset + state.railBottomInset)
      return (frames, NSSize(width: docW, height: docH))
    } else {
      var cursorY: CGFloat = 16
      let x = max(12, floor((primaryViewport.railScroll.bounds.width - state.cardWidth) / 2))
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
      let docW = max(primaryViewport.railScroll.bounds.width, state.cardWidth + 24)
      let docH = max(primaryViewport.railScroll.bounds.height, cursorY + 16)
      return (frames, NSSize(width: docW, height: docH))
    }
  }

  private func layoutSlots(animated: Bool, duration: TimeInterval = 0.36) {
    let (frames, docSize) = computeSlotFrames()
    primaryViewport.railDocument.frame = NSRect(origin: .zero, size: docSize)

    for (idx, slot) in slots.enumerated() {
      guard idx < frames.count else { continue }
      let target = frames[idx]
      if case .live(let card) = slot {
        if animated && LumenMotion.isEnabled && card.frame != .zero && card.frame != target {
          NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = duration
            ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.16, 1.0, 0.25, 1.0)
            card.animator().frame = target
          }
        } else {
          card.frame = target
        }
      }
    }
  }

  /// Converts a slot index's live rect into `effectsOverlay` coordinates so ghosts & soft particles
  /// move seamlessly with the rail if the user scrolls or captures during dissolution (§17.2, A51).
  private func slotRectInEffectsOverlay(forItemID itemID: String) -> NSRect? {
    guard let idx = slots.firstIndex(where: { $0.itemID == itemID }) else { return nil }
    let (frames, _) = computeSlotFrames()
    guard idx < frames.count else { return nil }
    let docRect = frames[idx]
    return primaryViewport.effectsOverlay.convert(docRect, from: primaryViewport.railDocument)
  }

  private func railClipRectInEffectsOverlay() -> NSRect {
    primaryViewport.effectsOverlay.convert(primaryViewport.railScroll.bounds, from: primaryViewport.railScroll)
  }

  private func animateCardsArrivalStagger() {
    let now = CACurrentMediaTime()
    for (idx, card) in liveCards.prefix(12).enumerated() {
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

  private func setFocused(id: String, scroll: Bool, fromKeyboard: Bool) {
    state.selectedClipID = id
    if fromKeyboard {
      keyboardFocusedCardID = id
    }
    updateCardVisualStates()
    if scroll, let card = liveCard(for: id) {
      primaryViewport.railScroll.scrollToRectAnimated(card.frame, animated: true)
    }
  }

  private func updateCardVisualStates() {
    let live = liveCards
    let selectedIndex = live.firstIndex(where: { $0.item.id == state.selectedClipID })
    for (idx, card) in live.enumerated() {
      card.isKeyboardFocused = (keyboardFocusedCardID == card.item.id)
      if idx == selectedIndex {
        card.visualState = .selected
      } else if hoveredCardID == card.item.id {
        card.visualState = .hovered
      } else if let sel = selectedIndex, abs(idx - sel) == 1 {
        card.visualState = .near
      } else {
        card.visualState = .idle
      }
    }
  }

  // MARK: Real-Time Capture While Orbit Is Open (§16.4, A40–A44)

  private func handleLiveCapturedItems(_ captured: [LumenClipboardItem]) {
    updateOpticalDotsState(animated: true)
    // Never open Orbit automatically or steal focus if hidden or Quick Look is open (§16.4, A43, A44)
    guard state.visible, !captured.isEmpty else { return }

    let matching = captured.filter { state.activeFilter == .all || $0.logicalCategory == state.activeFilter }
    let nonMatching = captured.filter { state.activeFilter != .all && $0.logicalCategory != state.activeFilter }

    for item in nonMatching {
      primaryViewport.opticalDots.pulseCategoryDot(item.logicalCategory)
    }
    guard !matching.isEmpty else { return }

    let wasEmpty = liveCards.isEmpty
    let previousSelectedID = state.selectedClipID
    let prevScrollX = primaryViewport.railScroll.contentView.bounds.origin.x
    let scrolledAwayFromHead = state.isHorizontalRail && prevScrollX > 8

    var insertedCards: [LumenOrbitCardView] = []
    for item in matching.reversed() {
      // Avoid duplicates if already reconciled
      if slots.contains(where: { $0.itemID == item.id }) { continue }
      let card = makeCard(for: item, keyIndex: nil)
      primaryViewport.railDocument.addSubview(card)
      slots.insert(.live(card), at: 0)
      insertedCards.append(card)
    }
    guard !insertedCards.isEmpty else { return }
    suppressNextItemsUpdatedReconcile = true

    // Preserve existing selectedClipID; only select newly captured item if rail was previously empty (§16.4, A40)
    if wasEmpty {
      state.selectedClipID = insertedCards.first?.item.id
    } else if let prev = previousSelectedID {
      state.selectedClipID = prev
    }
    reconcileSelectionAndEmptyState()

    if scrolledAwayFromHead {
      // Preserve viewport anchor synchronously without jumping or playing offscreen particles (§16.4, A41)
      let addedWidth = CGFloat(insertedCards.count) * (state.cardWidth + state.cardGap)
      layoutSlots(animated: false)
      primaryViewport.railScroll.scrollHorizontalClamped(to: prevScrollX + addedWidth)
      updateCardVisualStates()
      return
    }

    // At head & visible: lay out immediately to establish slot, slide older cards rightward 460ms,
    // and aggregate arriving card(s) with cotton-light particles (§16.4, A40).
    let oldFrames: [String: NSRect] = Dictionary(uniqueKeysWithValues: liveCards.compactMap { card in
      card.frame != .zero ? (card.item.id, card.frame) : nil
    })
    layoutSlots(animated: false)
    updateCardVisualStates()

    if LumenMotion.isEnabled {
      for card in liveCards {
        guard !insertedCards.contains(where: { $0.item.id == card.item.id }),
              let oldFrame = oldFrames[card.item.id],
              oldFrame != card.frame else { continue }
        let targetFrame = card.frame
        card.frame = oldFrame
        NSAnimationContext.runAnimationGroup { ctx in
          ctx.duration = 0.46
          ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.16, 1.0, 0.25, 1.0)
          card.animator().frame = targetFrame
        }
      }

      for arriving in insertedCards {
        let clipID = arriving.item.id
        primaryViewport.effectsOverlay.startAggregation(
          itemID: clipID,
          cardView: arriving.snapshotTargetView,
          fallbackTint: arriving.identity.tintColor(isDark: LumenPalette.current(store.preferences).isDark),
          particlesEnabled: store.preferences.particles,
          glowEnabled: store.preferences.glow,
          anchorFrameProvider: { [weak self] in
            self?.slotRectInEffectsOverlay(forItemID: clipID)
          },
          clipRectProvider: { [weak self] in
            self?.railClipRectInEffectsOverlay() ?? .zero
          }
        )
      }
    }
  }

  // MARK: Two-Phase Soft Dissolution & 420ms Reflow (§17.2, §18.4, A39, A49–A51, A65–A66, A71)

  private func removeCardAnimated(id: String) {
    guard let slotIdx = slots.firstIndex(where: {
      if case .live(let c) = $0 { return c.item.id == id }
      return false
    }) else { return }
    guard case .live(let card) = slots[slotIdx] else { return }

    let item = card.item
    let liveListBefore = liveCards
    let liveIdx = liveListBefore.firstIndex(where: { $0.item.id == id }) ?? 0

    // Immediate focus transfer to next live card (or previous if last)
    if state.selectedClipID == id {
      if liveIdx + 1 < liveListBefore.count {
        state.selectedClipID = liveListBefore[liveIdx + 1].item.id
      } else if liveIdx > 0 {
        state.selectedClipID = liveListBefore[liveIdx - 1].item.id
      } else {
        state.selectedClipID = nil
      }
    }
    if hoveredCardID == id { hoveredCardID = nil }
    if keyboardFocusedCardID == id { keyboardFocusedCardID = state.selectedClipID }

    // Cancel any in-flight arrival aggregation on this item
    primaryViewport.effectsOverlay.cancelAggregation(for: id)

    let visibleRect = primaryViewport.railScroll.contentView.bounds
    let isVisible = card.frame.intersects(visibleRect)
    let shouldAnimate = LumenMotion.isEnabled && isVisible

    if !shouldAnimate {
      // Reduce Motion or offscreen: immediate removal without decorative wait (§17.2)
      card.removeFromSuperview()
      slots.remove(at: slotIdx)
      reconcileSelectionAndEmptyState()
      layoutSlots(animated: false)
      updateCardVisualStates()
      commitStoreDelete(id: id)
      return
    }

    // Phase 0: Replace live card with non-interactive reservation occupying EXACT width & gap.
    // Adjacent cards DO NOT move by even 1px while dissolution & particles run (A49).
    let isLastSlot = (slotIdx == slots.count - 1)
    let reservation = ReservationSlot(
      item: item,
      width: state.cardWidth,
      gap: isLastSlot ? 0 : state.cardGap
    )
    slots[slotIdx] = .reservation(reservation)

    // Capture live card visual before removing card view from hierarchy
    let snapshotSource = card.snapshotTargetView
    let tint = card.identity.tintColor(isDark: LumenPalette.current(store.preferences).isDark)

    // Launch Phase 1: Texture-driven soft dissolution (front ≈ 480ms, particles 320–500ms, peak alpha ≈ 0.58)
    primaryViewport.effectsOverlay.startDissolve(
      itemID: id,
      cardView: snapshotSource,
      fallbackTint: tint,
      particlesEnabled: store.preferences.particles,
      glowEnabled: store.preferences.glow,
      anchorFrameProvider: { [weak self] in
        self?.slotRectInEffectsOverlay(forItemID: id)
      },
      clipRectProvider: { [weak self] in
        self?.railClipRectInEffectsOverlay() ?? .zero
      },
      onParticlesFinished: { [weak self] in
        // Phase 2 begins STRICTLY after every tail particle has extinguished (§17.2, A49, A65)
        self?.beginReservationCollapse(reservation)
      }
    )

    card.removeFromSuperview()
    reconcileSelectionAndEmptyState()
    updateCardVisualStates()

    // Commit data transaction immediately (decoupled from visual reservation, §17.2)
    commitStoreDelete(id: id)
  }

  private func commitStoreDelete(id: String) {
    store.deleteItem(id: id) { [weak self] result in
      guard let self else { return }
      self.updateOpticalDotsState(animated: false)
      if case .success = result {
        self.primaryViewport.toastView.show(message: "已移除剪贴板记录", showUndo: self.store.canUndoDelete)
      }
    }
  }

  /// Phase 2: Continuous 420ms slot width + gap collapse with fluid cubic-bezier(.28,.58,.26,1).
  private func beginReservationCollapse(_ reservation: ReservationSlot) {
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

    reservation.reflowTaskID = primaryViewport.effectsOverlay.addTickTask { [weak self, weak reservation] now in
      guard let self, let res = reservation else { return false }
      guard self.slots.contains(where: { $0.itemID == res.itemID }) else { return false }
      let rawT = min(1.0, max(0.0, (now - startTime) / max(0.01, duration)))
      let eased = LumenMotion.easeFluidPane(rawT)
      let remaining = CGFloat(1.0 - eased)
      res.width = startWidth * remaining
      res.gap = startGap * remaining
      self.layoutSlots(animated: false)
      if rawT >= 1.0 {
        self.finishReservation(res)
        return false
      }
      return true
    }
  }

  private func finishReservation(_ reservation: ReservationSlot) {
    if let taskID = reservation.reflowTaskID {
      primaryViewport.effectsOverlay.removeTickTask(taskID)
      reservation.reflowTaskID = nil
    }
    slots.removeAll { $0.itemID == reservation.itemID }
    reconcileSelectionAndEmptyState()
    layoutSlots(animated: false)
    updateCardVisualStates()
  }

  private func finalizeAllPendingReservations() {
    var removedAny = false
    for slot in slots {
      if case .reservation(let res) = slot {
        primaryViewport.effectsOverlay.cancelDissolve(for: res.itemID)
        if let taskID = res.reflowTaskID {
          primaryViewport.effectsOverlay.removeTickTask(taskID)
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
      layoutSlots(animated: false)
      updateCardVisualStates()
    }
  }

  // MARK: Undo Restoration (§3.4, §17.2, A09, A50)

  private func undoLastDelete() {
    let pendingTargetID = store.peekLastUndoItemID()
    store.undoLastDelete { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(let restored):
        // Also cancel any pending reservation matched by previous ID if server minted a new ID
        if let prevID = pendingTargetID, prevID != restored.id {
          self.cancelAndReuseReservationIfNeeded(oldID: prevID, restored: restored)
        }
        self.primaryViewport.toastView.show(message: "已恢复记录", showUndo: self.store.canUndoDelete)
      case .failure(let err):
        self.primaryViewport.toastView.show(message: err.localizedDescription)
      }
    }
  }

  private func cancelAndReuseReservationIfNeeded(oldID: String, restored: LumenClipboardItem) {
    guard let idx = slots.firstIndex(where: {
      if case .reservation(let r) = $0 { return r.itemID == oldID }
      return false
    }), case .reservation(let res) = slots[idx] else { return }

    primaryViewport.effectsOverlay.cancelDissolve(for: oldID)
    if let taskID = res.reflowTaskID {
      primaryViewport.effectsOverlay.removeTickTask(taskID)
      res.reflowTaskID = nil
    }
    slots.remove(at: idx)
  }

  private func handleRestoredItem(_ restored: LumenClipboardItem) {
    updateOpticalDotsState(animated: true)
    guard state.visible else { return }

    // A09: If restored item does NOT belong to current category filter, only update counts!
    let belongsToCurrentFilter = (state.activeFilter == .all) || (restored.logicalCategory == state.activeFilter)
    guard belongsToCurrentFilter else {
      primaryViewport.opticalDots.pulseCategoryDot(restored.logicalCategory)
      suppressNextItemsUpdatedReconcile = true
      return
    }
    suppressNextItemsUpdatedReconcile = true

    // Check if an active reservation exists for this item (undo mid-dissolve or mid-reflow, A50)
    if let resIdx = slots.firstIndex(where: {
      if case .reservation(let r) = $0 { return r.itemID == restored.id }
      return false
    }), case .reservation(let res) = slots[resIdx] {
      primaryViewport.effectsOverlay.cancelDissolve(for: res.itemID)
      if let taskID = res.reflowTaskID {
        primaryViewport.effectsOverlay.removeTickTask(taskID)
        res.reflowTaskID = nil
      }
      let card = makeCard(for: restored, keyIndex: nil)
      primaryViewport.railDocument.addSubview(card)
      slots[resIdx] = .live(card)
    } else {
      // Reconcile into its exact original filtered sequence position
      let filtered = filteredStoreItems()
      let desiredIdx = filtered.firstIndex(where: { $0.id == restored.id }) ?? 0
      if !slots.contains(where: { $0.itemID == restored.id }) {
        let card = makeCard(for: restored, keyIndex: nil)
        primaryViewport.railDocument.addSubview(card)
        let clamped = max(0, min(slots.count, desiredIdx))
        slots.insert(.live(card), at: clamped)
      }
    }

    state.selectedClipID = restored.id
    reconcileSelectionAndEmptyState()
    layoutSlots(animated: true, duration: 0.38)
    updateCardVisualStates()

    if let card = liveCard(for: restored.id) {
      primaryViewport.railScroll.scrollToRectAnimated(card.frame, animated: true)
      primaryViewport.effectsOverlay.startAggregation(
        itemID: restored.id,
        cardView: card.snapshotTargetView,
        fallbackTint: card.identity.tintColor(isDark: LumenPalette.current(store.preferences).isDark),
        particlesEnabled: store.preferences.particles,
        glowEnabled: store.preferences.glow,
        anchorFrameProvider: { [weak self] in
          self?.slotRectInEffectsOverlay(forItemID: restored.id)
        },
        clipRectProvider: { [weak self] in
          self?.railClipRectInEffectsOverlay() ?? .zero
        }
      )
    }
  }

  // MARK: Paste & Context Menu

  private func pasteAndDismiss(id: String) {
    if LumenMotion.isEnabled, let card = liveCard(for: id), let layer = card.layer {
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

    store.copyToOSClipboard(id: id) { [weak self] result in
      switch result {
      case .success:
        self?.hide(restoreFocus: true)
      case .failure(let err):
        self?.primaryViewport.toastView.show(message: "复制失败：\(err.localizedDescription)")
      }
    }
  }

  private func presentContextMenu(for id: String, event: NSEvent) {
    setFocused(id: id, scroll: false, fromKeyboard: false)
    let menu = NSMenu(title: "Orbit 卡片")
    let pasteItem = NSMenuItem(title: "复制到剪贴板 (↵)", action: #selector(menuPaste(_:)), keyEquivalent: "")
    pasteItem.target = self
    pasteItem.representedObject = id
    menu.addItem(pasteItem)

    let peekItem = NSMenuItem(title: "完整预览 (Space)", action: #selector(menuPeek(_:)), keyEquivalent: "")
    peekItem.target = self
    peekItem.representedObject = id
    menu.addItem(peekItem)

    let pinTitle = (store.items.first(where: { $0.id == id })?.pinned == true) ? "取消固定" : "固定记录"
    let pinItem = NSMenuItem(title: pinTitle, action: #selector(menuPin(_:)), keyEquivalent: "")
    pinItem.target = self
    pinItem.representedObject = id
    menu.addItem(pinItem)

    let openAppItem = NSMenuItem(title: "在管理窗口查看 (⌥↵)", action: #selector(menuOpenWorkspace(_:)), keyEquivalent: "")
    openAppItem.target = self
    openAppItem.representedObject = id
    menu.addItem(openAppItem)

    menu.addItem(NSMenuItem.separator())

    let delItem = NSMenuItem(title: "移除记录 (Del)", action: #selector(menuRemove(_:)), keyEquivalent: "")
    delItem.target = self
    delItem.representedObject = id
    menu.addItem(delItem)

    if let card = liveCard(for: id) {
      isContextMenuOpen = true
      NSMenu.popUpContextMenu(menu, with: event, for: card)
      isContextMenuOpen = false
    }
  }

  @objc private func menuPaste(_ sender: NSMenuItem) {
    if let id = sender.representedObject as? String { pasteAndDismiss(id: id) }
  }

  @objc private func menuPeek(_ sender: NSMenuItem) {
    if let id = sender.representedObject as? String {
      let queue = filteredStoreItems()
      if !queue.isEmpty {
        LumenPreviewWindow.shared.open(clipboardItems: queue, initialID: id)
      }
    }
  }

  @objc private func menuPin(_ sender: NSMenuItem) {
    if let id = sender.representedObject as? String {
      store.togglePin(id: id)
    }
  }

  @objc private func menuOpenWorkspace(_ sender: NSMenuItem) {
    let targetID = sender.representedObject as? String ?? state.selectedClipID
    openLibraryFromOrbit(selectedID: targetID)
  }

  @objc private func menuRemove(_ sender: NSMenuItem) {
    if let id = sender.representedObject as? String { removeCardAnimated(id: id) }
  }

  private func openLibraryFromOrbit(selectedID: String?) {
    hide(restoreFocus: false)
    if let handler = onOpenWorkspaceWithSelection {
      handler(selectedID)
    } else {
      onOpenWorkspace?()
    }
  }

  // MARK: Full V15 Keyboard Map (§3.3)

  private func handleEscapeChain() {
    if isContextMenuOpen {
      isContextMenuOpen = false
      return
    }
    if LumenPreviewWindow.shared.isVisible {
      LumenPreviewWindow.shared.closeAnimated()
      return
    }
    hide(restoreFocus: true)
  }

  private func handleKeyDown(_ event: NSEvent) -> Bool {
    let mods = event.modifierFlags.intersection([.command, .option, .control, .shift])

    // ⌘⌥V toggle Orbit (covers standalone AI Home.app where ShortcutRegistry is absent)
    if mods == [.command, .option], event.keyCode == 9 { // V
      hide(restoreFocus: true)
      return true
    }

    // ⌘Z Undo
    if mods == .command, event.charactersIgnoringModifiers?.lowercased() == "z" {
      if store.canUndoDelete {
        undoLastDelete()
      }
      return true
    }

    // ⌥Enter Open in Library preserving record identity (§3.3)
    if mods == .option, (event.keyCode == 36 || event.keyCode == 76) {
      openLibraryFromOrbit(selectedID: state.selectedClipID)
      return true
    }

    if mods.contains(.command) || mods.contains(.option) || mods.contains(.control) {
      return false
    }

    let dots = primaryViewport.opticalDots

    switch event.keyCode {
    case 53: // Esc chain: menu -> preview -> Orbit
      handleEscapeChain()
      return true

    case 48: // Tab / Shift+Tab switches keyboard focus between Optical Dots and active card
      if !dots.isHidden {
        if dots.hasKeyboardFocus {
          dots.clearKeyboardFocus()
          if let sel = state.selectedClipID {
            setFocused(id: sel, scroll: false, fromKeyboard: true)
          }
        } else {
          keyboardFocusedCardID = nil
          updateCardVisualStates()
          dots.focusActiveDot()
        }
        return true
      }
      return false

    case 126: // Up arrow -> previous category (or dot focus up)
      if dots.hasKeyboardFocus {
        dots.moveKeyboardFocus(by: -1)
      } else {
        dots.stepCategory(by: -1)
      }
      return true

    case 125: // Down arrow -> next category (or dot focus down)
      if dots.hasKeyboardFocus {
        dots.moveKeyboardFocus(by: 1)
      } else {
        dots.stepCategory(by: 1)
      }
      return true

    case 123: // Left arrow -> previous card
      dots.clearKeyboardFocus()
      stepCardFocus(-1)
      return true

    case 124: // Right arrow -> next card
      dots.clearKeyboardFocus()
      stepCardFocus(1)
      return true

    case 115: // Home -> first card in current category
      dots.clearKeyboardFocus()
      if let first = liveCards.first {
        setFocused(id: first.item.id, scroll: true, fromKeyboard: true)
      }
      return true

    case 119: // End -> last card in current category
      dots.clearKeyboardFocus()
      if let last = liveCards.last {
        setFocused(id: last.item.id, scroll: true, fromKeyboard: true)
      }
      return true

    case 36, 76: // Enter -> activate focused dot OR paste selected card (§3.3)
      if dots.hasKeyboardFocus {
        _ = dots.activateFocusedDot()
        return true
      }
      if let id = state.selectedClipID {
        pasteAndDismiss(id: id)
      }
      return true

    case 49: // Space -> activate focused dot OR open Quick Look (§3.3)
      if dots.hasKeyboardFocus {
        _ = dots.activateFocusedDot()
        return true
      }
      if let id = state.selectedClipID {
        let queue = filteredStoreItems()
        if !queue.isEmpty {
          LumenPreviewWindow.shared.open(clipboardItems: queue, initialID: id)
          return true
        }
      }
      return false

    case 51, 117: // Delete / Backspace -> remove selected record without closing Orbit
      if dots.hasKeyboardFocus { return true }
      if let id = state.selectedClipID {
        removeCardAnimated(id: id)
      }
      return true

    default:
      if !dots.hasKeyboardFocus,
         let chars = event.charactersIgnoringModifiers, chars.count == 1,
         let digit = Int(chars), digit >= 1 && digit <= 9 {
        let live = liveCards
        if digit - 1 < live.count {
          let target = live[digit - 1]
          setFocused(id: target.item.id, scroll: true, fromKeyboard: true)
          pasteAndDismiss(id: target.item.id)
          return true
        }
      }
      return false
    }
  }

  private func stepCardFocus(_ delta: Int) {
    let live = liveCards
    guard !live.isEmpty else { return }
    let idx = live.firstIndex(where: { $0.item.id == state.selectedClipID }) ?? 0
    let next = max(0, min(live.count - 1, idx + delta))
    setFocused(id: live[next].item.id, scroll: true, fromKeyboard: true)
  }

  private func installOutsideClickMonitor() {
    removeOutsideClickMonitor()
    outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
      guard let self, self.state.visible, !self.isContextMenuOpen else { return }
      if LumenPreviewWindow.shared.isVisible { return }
      let point = NSEvent.mouseLocation
      let insideAnyViewport = self.viewports.contains(where: { NSMouseInRect(point, $0.panel.frame, false) })
      if !insideAnyViewport {
        self.hide(restoreFocus: false)
      }
    }
  }

  private func removeOutsideClickMonitor() {
    if let monitor = outsideClickMonitor {
      NSEvent.removeMonitor(monitor)
      outsideClickMonitor = nil
    }
  }

  // MARK: NSWindowDelegate

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    hide(restoreFocus: true)
    return false
  }
}
