import AppKit
import Foundation
import QuartzCore

/// Pure native Paste Lumen V15 Quick Orbit controller (zero WebView/HTML).
/// Public API preserved identically for `native/translation/main.swift` and `native/aihome-app/main.swift`
/// (`panel`, `isAvailable`, `isVisibleAndKey`, `configure`, `toggle`, `show`, `hide`, `onOpenWorkspace`).
/// Internally delegates multi-display bottom-rail chaining (1..N independent borderless floating panels
/// sharing a single logical state, scroll offset, filter, selection, and animation clock) to
/// `LumenOrbitDisplayCoordinator`.
final class QuickOrbitWindow: NSObject {
  private let store = LumenClipboardStore.shared
  private let coordinator = LumenOrbitDisplayCoordinator()

  /// Primary NSPanel exposed for host AppDelegate visibility checks (`native/translation/main.swift`, `native/aihome-app/main.swift`).
  var panel: NSPanel { coordinator.primaryViewport.panel }

  private var enabled = false
  private var previousApp: NSRunningApplication?
  private var outsideClickMonitor: Any?
  private var observerID: UUID?

  private var isContextMenuOpen = false
  private var suppressNextItemsUpdatedReconcile = false

  var onOpenWorkspace: (() -> Void)?
  var onOpenWorkspaceWithSelection: ((String?) -> Void)?

  override init() {
    super.init()
    wireCoordinator()
    applyTheme()

    observerID = store.addObserver { [weak self] event in
      guard let self else { return }
      switch event {
      case .itemsUpdated:
        self.updateOpticalDotsState(animated: false)
        if self.suppressNextItemsUpdatedReconcile {
          self.suppressNextItemsUpdatedReconcile = false
        } else if self.coordinator.state.visible {
          self.coordinator.reconcileSlots(with: self.filteredStoreItems(), animatedReflow: true)
        }
      case .itemsCaptured(let captured):
        self.handleLiveCapturedItems(captured)
      case .itemRestored(let restored, _):
        self.handleRestoredItem(restored)
      case .preferencesUpdated:
        self.applyTheme()
        if !LumenMotion.isEnabled || !self.store.preferences.particles {
          self.coordinator.finalizeAllPendingReservations()
        }
      case .settingsUpdated:
        let nextPos = OrbitDisplayTopology.normalizePosition(self.store.settings.quickOrbitPosition)
        if nextPos != self.coordinator.state.edgePosition {
          self.coordinator.setEdgePosition(nextPos)
          if self.coordinator.state.visible {
            self.coordinator.repositionVisibleViewportsInterruptibly()
            self.updateOpticalDotsState(animated: false)
          } else {
            self.coordinator.rebuildViewportsForCurrentTopology(isShowing: false)
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
    if let id = observerID { store.removeObserver(id) }
  }

  // MARK: Public API (Unchanged Contract for main.swift / aihome-app)

  var isAvailable: Bool {
    guard enabled else { return false }
    if !store.isConfigured {
      store.ensureConfiguredFromLocalConfig()
    }
    return store.isConfigured
  }

  var isVisibleAndKey: Bool {
    coordinator.isVisibleAndKey
  }

  func configure(origin nextOrigin: String, managementKey nextKey: String, enabled nextEnabled: Bool, position nextPosition: String) {
    let normalizedPosition = OrbitDisplayTopology.normalizePosition(nextPosition)
    let posChanged = normalizedPosition != coordinator.state.edgePosition
    enabled = nextEnabled
    coordinator.setEdgePosition(normalizedPosition)

    if !nextOrigin.isEmpty || !nextKey.isEmpty {
      store.configure(origin: nextOrigin, managementKey: nextKey)
    } else if nextEnabled {
      store.ensureConfiguredFromLocalConfig()
    }

    if !nextEnabled {
      hide()
      return
    }
    if posChanged && coordinator.state.visible {
      coordinator.repositionVisibleViewportsInterruptibly()
      updateOpticalDotsState(animated: false)
    } else if posChanged {
      coordinator.rebuildViewportsForCurrentTopology(isShowing: false)
    }
  }

  func toggle() {
    if coordinator.state.visible {
      hide()
    } else {
      show()
    }
  }

  func show() {
    store.ensureConfiguredFromLocalConfig()
    guard isAvailable else { return }

    let wasVisible = coordinator.isAnyPanelVisible
    if !wasVisible {
      let front = NSWorkspace.shared.frontmostApplication
      if front?.processIdentifier != ProcessInfo.processInfo.processIdentifier {
        previousApp = front
      }
    }

    let savedOffset = coordinator.state.savedScrollOffset(for: coordinator.state.activeFilter)
    coordinator.showAllPanels(items: filteredStoreItems(), restoreOffset: savedOffset, animatedArrival: !wasVisible)
    updateOpticalDotsState(animated: false)

    store.refreshItems()
    store.startLiveOrbitCapture()
    installOutsideClickMonitor()
  }

  func hide(restoreFocus: Bool = true) {
    guard coordinator.state.visible || coordinator.isAnyPanelVisible else { return }
    store.stopLiveOrbitCapture()
    removeOutsideClickMonitor()

    let appToRestore = restoreFocus ? previousApp : nil
    previousApp = nil

    coordinator.hideAllPanels {
      if let app = appToRestore, !app.isTerminated {
        _ = app.activate(options: [.activateIgnoringOtherApps])
      }
    }
  }

  // MARK: Coordinator Wiring & Theme

  private func wireCoordinator() {
    coordinator.onKeyEvent = { [weak self] event in self?.handleKeyDown(event) ?? false }
    coordinator.onCancel = { [weak self] in self?.handleEscapeChain() }
    coordinator.onSelectCategory = { [weak self] next in self?.selectCategory(next) }
    coordinator.onSelectAndPaste = { [weak self] id in self?.pasteAndDismiss(id: id) }
    coordinator.onRemoveRequested = { [weak self] id in self?.removeCardAnimated(id: id) }
    coordinator.onContextMenuRequested = { [weak self] id, event, anchorView in
      self?.presentContextMenu(for: id, event: event, anchorView: anchorView)
    }
    coordinator.onUndoRequested = { [weak self] in self?.undoLastDelete() }
    coordinator.onPanelShouldClose = { [weak self] in self?.hide(restoreFocus: true) }
    coordinator.onTopologyDidChange = { [weak self] in
      self?.updateOpticalDotsState(animated: false)
    }
  }

  private func applyTheme() {
    let palette = LumenPalette.current(store.preferences)
    coordinator.applyTheme(palette, preferences: store.preferences)
  }

  // MARK: Category Filtering & Optical Dots 3.0 (§3.2, A05, A06, A20–A23)

  private func filteredStoreItems(for category: LumenLogicalCategory? = nil) -> [LumenClipboardItem] {
    let target = category ?? coordinator.state.activeFilter
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
    coordinator.opticalDots.updateState(
      active: coordinator.state.activeFilter,
      counts: categoryCounts(),
      animated: animated
    )
  }

  private func selectCategory(_ next: LumenLogicalCategory) {
    guard next != coordinator.state.activeFilter else { return }
    let categories = LumenLogicalCategory.allCases
    let prevIdx = categories.firstIndex(of: coordinator.state.activeFilter) ?? 0
    let nextIdx = categories.firstIndex(of: next) ?? 0
    let movingDown = nextIdx > prevIdx

    // Persist outgoing category's global scroll offset & finalize transient reservations (§17.2)
    coordinator.cancelScrollAnimation()
    coordinator.finalizeAllPendingReservations()
    coordinator.effectsEngine.stopAll()
    coordinator.playCategoryExitGhosts(movingDown: movingDown)
    coordinator.saveScrollOffsetForActiveFilter()

    coordinator.setActiveFilter(next)
    coordinator.clearHoverAndFocus()

    let restoredOffset = coordinator.state.savedScrollOffset(for: next)
    coordinator.replaceSlots(with: filteredStoreItems(for: next), animated: false)
    coordinator.setGlobalScrollOffset(restoredOffset, animated: false)
    updateOpticalDotsState(animated: true)

    if let sel = coordinator.state.selectedClipID {
      coordinator.scrollCardIntoView(itemID: sel, animated: false)
    }
    coordinator.playCategoryEnterSlide(movingDown: movingDown)
  }

  // MARK: Real-Time Capture While Orbit Is Open (§16.4, A40–A44)

  private func handleLiveCapturedItems(_ captured: [LumenClipboardItem]) {
    updateOpticalDotsState(animated: true)
    guard coordinator.state.visible, !captured.isEmpty else { return }

    let activeFilter = coordinator.state.activeFilter
    let matching = captured.filter { activeFilter == .all || $0.logicalCategory == activeFilter }
    let nonMatching = captured.filter { activeFilter != .all && $0.logicalCategory != activeFilter }

    for item in nonMatching {
      coordinator.opticalDots.pulseCategoryDot(item.logicalCategory)
    }
    guard !matching.isEmpty else { return }

    let inserted = coordinator.insertLiveCapturedItems(
      matching,
      particlesEnabled: store.preferences.particles,
      glowEnabled: store.preferences.glow
    )
    if inserted {
      suppressNextItemsUpdatedReconcile = true
    }
  }

  // MARK: Two-Phase Soft Dissolution & 420ms Reflow (§17.2, §18.4, A39, A49–A51, A65–A66, A70–A71)

  private func removeCardAnimated(id: String) {
    let started = coordinator.beginCardRemoval(
      id: id,
      particlesEnabled: store.preferences.particles,
      glowEnabled: store.preferences.glow
    )
    guard started else { return }

    store.deleteItem(id: id) { [weak self] result in
      guard let self else { return }
      self.updateOpticalDotsState(animated: false)
      if case .success = result {
        self.coordinator.showToast(message: "已移除剪贴板记录", showUndo: self.store.canUndoDelete)
      }
    }
  }

  // MARK: Undo Restoration (§3.4, §17.2, A09, A50, A70)

  private func undoLastDelete() {
    let pendingTargetID = store.peekLastUndoItemID()
    store.undoLastDelete { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(let restored):
        if let prevID = pendingTargetID, prevID != restored.id {
          self.coordinator.cancelReservation(for: prevID)
        }
        self.coordinator.showToast(message: "已恢复记录", showUndo: self.store.canUndoDelete)
      case .failure(let err):
        self.coordinator.showToast(message: err.localizedDescription)
      }
    }
  }

  private func handleRestoredItem(_ restored: LumenClipboardItem) {
    updateOpticalDotsState(animated: true)
    guard coordinator.state.visible else { return }

    let activeFilter = coordinator.state.activeFilter
    let belongsToCurrentFilter = (activeFilter == .all) || (restored.logicalCategory == activeFilter)
    guard belongsToCurrentFilter else {
      coordinator.opticalDots.pulseCategoryDot(restored.logicalCategory)
      suppressNextItemsUpdatedReconcile = true
      return
    }
    suppressNextItemsUpdatedReconcile = true

    let filtered = filteredStoreItems()
    let desiredIdx = filtered.firstIndex(where: { $0.id == restored.id }) ?? 0
    coordinator.restoreItemInPlaceOrSequence(
      restored,
      desiredSequenceIndex: desiredIdx,
      particlesEnabled: store.preferences.particles,
      glowEnabled: store.preferences.glow
    )
  }

  // MARK: Paste & Context Menu

  private func pasteAndDismiss(id: String) {
    coordinator.playPasteLiftAnimation(for: id)
    store.copyToOSClipboard(id: id) { [weak self] result in
      switch result {
      case .success:
        self?.hide(restoreFocus: true)
      case .failure(let err):
        self?.coordinator.showToast(message: "复制失败：\(err.localizedDescription)")
      }
    }
  }

  private func presentContextMenu(for id: String, event: NSEvent, anchorView: NSView) {
    coordinator.setFocused(id: id, scroll: false, fromKeyboard: false)
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

    isContextMenuOpen = true
    NSMenu.popUpContextMenu(menu, with: event, for: anchorView)
    isContextMenuOpen = false
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
    let targetID = sender.representedObject as? String ?? coordinator.state.selectedClipID
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
      openLibraryFromOrbit(selectedID: coordinator.state.selectedClipID)
      return true
    }

    if mods.contains(.command) || mods.contains(.option) || mods.contains(.control) {
      return false
    }

    let dots = coordinator.opticalDots

    switch event.keyCode {
    case 53: // Esc chain: menu -> preview -> Orbit
      handleEscapeChain()
      return true

    case 48: // Tab / Shift+Tab switches keyboard focus between Optical Dots and active card
      if !dots.isHidden {
        if dots.hasKeyboardFocus {
          dots.clearKeyboardFocus()
          if let sel = coordinator.state.selectedClipID {
            coordinator.setFocused(id: sel, scroll: false, fromKeyboard: true)
          }
        } else {
          coordinator.setKeyboardFocusedCardID(nil)
          coordinator.updateCardVisualStates(animated: true)
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
      if let first = coordinator.liveItems.first {
        coordinator.setFocused(id: first.id, scroll: true, fromKeyboard: true)
      }
      return true

    case 119: // End -> last card in current category
      dots.clearKeyboardFocus()
      if let last = coordinator.liveItems.last {
        coordinator.setFocused(id: last.id, scroll: true, fromKeyboard: true)
      }
      return true

    case 36, 76: // Enter -> activate focused dot OR paste selected card (§3.3)
      if dots.hasKeyboardFocus {
        _ = dots.activateFocusedDot()
        return true
      }
      if let id = coordinator.state.selectedClipID {
        pasteAndDismiss(id: id)
      }
      return true

    case 49: // Space -> activate focused dot OR open Quick Look (§3.3)
      if dots.hasKeyboardFocus {
        _ = dots.activateFocusedDot()
        return true
      }
      if let id = coordinator.state.selectedClipID {
        let queue = filteredStoreItems()
        if !queue.isEmpty {
          LumenPreviewWindow.shared.open(clipboardItems: queue, initialID: id)
          return true
        }
      }
      return false

    case 51, 117: // Delete / Backspace -> remove selected record without closing Orbit
      if dots.hasKeyboardFocus { return true }
      if let id = coordinator.state.selectedClipID {
        removeCardAnimated(id: id)
      }
      return true

    default:
      if !dots.hasKeyboardFocus,
         let chars = event.charactersIgnoringModifiers, chars.count == 1,
         let digit = Int(chars), digit >= 1 && digit <= 9 {
        let live = coordinator.liveItems
        if digit - 1 < live.count {
          let target = live[digit - 1]
          coordinator.setFocused(id: target.id, scroll: true, fromKeyboard: true)
          pasteAndDismiss(id: target.id)
          return true
        }
      }
      return false
    }
  }

  private func stepCardFocus(_ delta: Int) {
    let live = coordinator.liveItems
    guard !live.isEmpty else { return }
    let idx = live.firstIndex(where: { $0.id == coordinator.state.selectedClipID }) ?? 0
    let next = max(0, min(live.count - 1, idx + delta))
    coordinator.setFocused(id: live[next].id, scroll: true, fromKeyboard: true)
  }

  private func installOutsideClickMonitor() {
    removeOutsideClickMonitor()
    outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
      guard let self, self.coordinator.state.visible, !self.isContextMenuOpen else { return }
      if LumenPreviewWindow.shared.isVisible { return }
      let point = NSEvent.mouseLocation
      if !self.coordinator.containsGlobalScreenPoint(point) {
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
}
