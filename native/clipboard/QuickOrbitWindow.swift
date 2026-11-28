import AppKit
import Foundation
import QuartzCore

/// Pure native borderless floating Quick Orbit NSPanel surface (zero WebView/HTML).
/// Renders as a continuous screen-edge rail (`bottom` | `left` | `right`) with
/// card removal, release-light burst, and interruptible Core Animation transitions.
final class QuickOrbitWindow: NSObject, NSWindowDelegate {
  let panel: NSPanel
  private let hostPanel: LumenOrbitHostPanel
  private let store = LumenClipboardStore.shared

  private let backdrop = LumenOrbitBackdropView()
  private let railScroll = LumenOrbitRailScrollView()
  private let railDocument = LumenFlippedView()
  private let emptyLabel = NSTextField(labelWithString: "暂无剪贴板记录")
  private let toastView = LumenToastBannerView()

  private var enabled = false
  private var position = "bottom"
  private var isShowing = false
  private var transitionToken = 0
  private var previousApp: NSRunningApplication?
  private var outsideClickMonitor: Any?
  private var observerID: UUID?

  private var cards: [LumenOrbitCardView] = []
  private var removingIDs: Set<String> = []
  private var selectedID: String?
  private var cardWidth: CGFloat = 196
  private var cardHeight: CGFloat = 216
  private let cardGap: CGFloat = 13
  private let railPaddingX: CGFloat = 24
  private let railPaddingY: CGFloat = 20

  var onOpenWorkspace: (() -> Void)?

  override init() {
    hostPanel = LumenOrbitHostPanel(
      contentRect: NSRect(x: 0, y: 0, width: 1440, height: 270),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel = hostPanel
    super.init()

    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.delegate = self

    hostPanel.onKeyEvent = { [weak self] event in self?.handleKeyDown(event) ?? false }
    hostPanel.onCancel = { [weak self] in self?.hide() }

    buildContent()
    applyTheme()

    observerID = store.addObserver { [weak self] event in
      guard let self else { return }
      switch event {
      case .itemsUpdated:
        if self.isShowing {
          self.syncCardsFromStore(animatedReflow: true)
        }
      case .preferencesUpdated:
        self.applyTheme()
      case .settingsUpdated:
        let nextPos = Self.normalizePosition(self.store.settings.quickOrbitPosition)
        if nextPos != self.position {
          self.position = nextPos
          self.backdrop.edgePosition = nextPos
          if self.isShowing {
            self.repositionVisiblePanelInterruptibly()
          }
        }
      default:
        break
      }
    }
  }

  deinit {
    removeOutsideClickMonitor()
    if let id = observerID { store.removeObserver(id) }
  }

  var isAvailable: Bool {
    guard enabled else { return false }
    if !store.isConfigured {
      store.ensureConfiguredFromLocalConfig()
    }
    return store.isConfigured
  }

  var isVisibleAndKey: Bool { isShowing && panel.isVisible && panel.isKeyWindow }

  func configure(origin nextOrigin: String, managementKey nextKey: String, enabled nextEnabled: Bool, position nextPosition: String) {
    let normalizedPosition = Self.normalizePosition(nextPosition)
    let posChanged = normalizedPosition != position
    enabled = nextEnabled
    position = normalizedPosition
    backdrop.edgePosition = normalizedPosition

    if !nextOrigin.isEmpty || !nextKey.isEmpty {
      store.configure(origin: nextOrigin, managementKey: nextKey)
    } else if nextEnabled {
      store.ensureConfiguredFromLocalConfig()
    }

    if !nextEnabled {
      hide()
      return
    }
    if posChanged && isShowing {
      repositionVisiblePanelInterruptibly()
    }
  }

  func toggle() {
    if isShowing {
      hide()
    } else {
      show()
    }
  }

  func show() {
    store.ensureConfiguredFromLocalConfig()
    guard isAvailable else { return }

    // Interrupt any in-flight hide/show animation from its current live frame & opacity.
    transitionToken += 1
    let token = transitionToken
    let wasVisible = panel.isVisible
    isShowing = true

    if !wasVisible {
      let front = NSWorkspace.shared.frontmostApplication
      if front?.processIdentifier != ProcessInfo.processInfo.processIdentifier {
        previousApp = front
      }
    }

    let target = targetFrame()
    let start = wasVisible ? panel.frame : offscreenFrame(from: target)

    updateRailMetrics(for: target)
    syncCardsFromStore(animatedReflow: false)
    store.refreshItems()

    panel.setFrame(start, display: false)
    if !wasVisible {
      panel.alphaValue = LumenMotion.isEnabled ? 0 : 1
    }
    panel.makeKeyAndOrderFront(nil)
    panel.orderFrontRegardless()
    panel.makeKey()
    NSApp.activate(ignoringOtherApps: true)
    _ = NSRunningApplication.current.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    installOutsideClickMonitor()

    if LumenMotion.isEnabled {
      NSAnimationContext.runAnimationGroup({ ctx in
        ctx.duration = LumenMotion.enterDuration
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.19, 1.0, 0.25, 1.0)
        self.panel.animator().setFrame(target, display: true)
        self.panel.animator().alphaValue = 1
      }, completionHandler: { [weak self] in
        guard let self, self.transitionToken == token else { return }
        self.panel.setFrame(target, display: true)
        self.panel.alphaValue = 1
      })
      if !wasVisible {
        animateCardsArrivalStagger()
      }
    } else {
      panel.setFrame(target, display: true)
      panel.alphaValue = 1
    }
  }

  func hide(restoreFocus: Bool = true) {
    guard isShowing || panel.isVisible else { return }
    transitionToken += 1
    let token = transitionToken
    isShowing = false
    removeOutsideClickMonitor()

    let end = offscreenFrame(from: targetFrame())
    let appToRestore = restoreFocus ? previousApp : nil
    previousApp = nil

    if LumenMotion.isEnabled {
      NSAnimationContext.runAnimationGroup({ ctx in
        ctx.duration = LumenMotion.exitDuration
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.4, 0, 0.5, 1)
        self.panel.animator().setFrame(end, display: true)
        self.panel.animator().alphaValue = 0
      }, completionHandler: { [weak self] in
        guard let self, self.transitionToken == token else { return }
        self.panel.orderOut(nil)
        self.panel.alphaValue = 1
        if let app = appToRestore, !app.isTerminated {
          _ = app.activate(options: [.activateIgnoringOtherApps])
        }
      })
    } else {
      panel.orderOut(nil)
      panel.alphaValue = 1
      if let app = appToRestore, !app.isTerminated {
        _ = app.activate(options: [.activateIgnoringOtherApps])
      }
    }
  }

  // MARK: Layout & Screen-Edge Geometry

  private func buildContent() {
    panel.contentView = backdrop

    railScroll.documentView = railDocument
    railScroll.drawsBackground = false
    railScroll.contentView.drawsBackground = false
    railScroll.borderType = .noBorder
    railScroll.hasHorizontalScroller = false
    railScroll.hasVerticalScroller = false
    railScroll.autohidesScrollers = true
    railScroll.translatesAutoresizingMaskIntoConstraints = false

    emptyLabel.font = .systemFont(ofSize: 13.5, weight: .medium)
    emptyLabel.alignment = .center
    emptyLabel.isHidden = true
    emptyLabel.translatesAutoresizingMaskIntoConstraints = false

    toastView.translatesAutoresizingMaskIntoConstraints = false
    toastView.onUndo = { [weak self] in self?.undoLastDelete() }

    backdrop.addSubview(railScroll)
    backdrop.addSubview(emptyLabel)
    backdrop.addSubview(toastView)

    NSLayoutConstraint.activate([
      railScroll.topAnchor.constraint(equalTo: backdrop.topAnchor),
      railScroll.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor),
      railScroll.trailingAnchor.constraint(equalTo: backdrop.trailingAnchor),
      railScroll.bottomAnchor.constraint(equalTo: backdrop.bottomAnchor),

      emptyLabel.centerXAnchor.constraint(equalTo: backdrop.centerXAnchor),
      emptyLabel.centerYAnchor.constraint(equalTo: backdrop.centerYAnchor),

      toastView.topAnchor.constraint(equalTo: backdrop.topAnchor, constant: 10),
      toastView.centerXAnchor.constraint(equalTo: backdrop.centerXAnchor)
    ])
  }

  private func applyTheme() {
    let palette = LumenPalette.current(store.preferences)
    panel.appearance = palette.nsAppearance
    backdrop.applyTheme(palette, preferences: store.preferences)
    emptyLabel.textColor = palette.isDark ? NSColor(srgbRed: 0.90, green: 0.94, blue: 1.0, alpha: 0.85) : palette.ink
    for card in cards {
      card.applyTheme(palette, glowEnabled: store.preferences.glow)
    }
  }

  private static func normalizePosition(_ raw: String) -> String {
    switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "left": return "left"
    case "right": return "right"
    default: return "bottom"
    }
  }

  private func activeScreen() -> NSScreen? {
    let pointer = NSEvent.mouseLocation
    if let match = NSScreen.screens.first(where: { NSMouseInRect(pointer, $0.frame, false) }) {
      return match
    }
    return NSScreen.main ?? NSScreen.screens.first
  }

  /// Computes a continuous screen-edge rail frame:
  /// - `bottom`: spans the full lowest screen row continuously when macOS uses a unified
  ///   desktop space (`!NSScreen.screensHaveSeparateSpaces`), or spans edge-to-edge across the
  ///   active screen's bottom edge when displays have separate Spaces (avoiding Space clipping).
  /// - `left` / `right`: full-height continuous vertical rail flush against the chosen screen edge.
  private func targetFrame() -> NSRect {
    let fallback = NSRect(x: 0, y: 0, width: 1440, height: 900)
    guard let active = activeScreen() else {
      return NSRect(x: 0, y: 0, width: fallback.width, height: 272)
    }
    switch position {
    case "left", "right":
      let visible = active.visibleFrame
      let width = min(278, max(236, round(visible.width * 0.19)))
      let x = position == "left" ? visible.minX : visible.maxX - width
      return NSRect(x: x, y: visible.minY, width: width, height: visible.height)
    default:
      let screens = NSScreen.screens
      if !NSScreen.screensHaveSeparateSpaces && screens.count > 1 {
        let minBottomY = screens.map { $0.frame.minY }.min() ?? active.frame.minY
        let bottomRow = screens.filter { abs($0.frame.minY - minBottomY) <= 80 }
        if !bottomRow.isEmpty {
          let unionMinX = bottomRow.map { $0.frame.minX }.min() ?? active.frame.minX
          let unionMaxX = bottomRow.map { $0.frame.maxX }.max() ?? active.frame.maxX
          let minVisibleY = bottomRow.map { $0.visibleFrame.minY }.max() ?? active.visibleFrame.minY
          let minScreenH = bottomRow.map { $0.frame.height }.min() ?? active.frame.height
          let height = min(292, max(232, round(minScreenH * 0.29)))
          return NSRect(x: unionMinX, y: minVisibleY, width: unionMaxX - unionMinX, height: height)
        }
      }
      let frame = active.frame
      let visible = active.visibleFrame
      let height = min(292, max(232, round(frame.height * 0.29)))
      return NSRect(x: frame.minX, y: visible.minY, width: frame.width, height: height)
    }
  }

  private func offscreenFrame(from target: NSRect) -> NSRect {
    switch position {
    case "left":
      return target.offsetBy(dx: -target.width - 24, dy: 0)
    case "right":
      return target.offsetBy(dx: target.width + 24, dy: 0)
    default:
      return target.offsetBy(dx: 0, dy: -target.height - 24)
    }
  }

  private func repositionVisiblePanelInterruptibly() {
    transitionToken += 1
    let target = targetFrame()
    updateRailMetrics(for: target)
    layoutCards(animated: true)
    if LumenMotion.isEnabled {
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = 0.34
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.19, 1, 0.25, 1)
        self.panel.animator().setFrame(target, display: true)
      }
    } else {
      panel.setFrame(target, display: true)
    }
  }

  private func updateRailMetrics(for frame: NSRect) {
    let horizontal = position == "bottom"
    railScroll.isHorizontalRail = horizontal
    if horizontal {
      cardHeight = min(232, max(168, frame.height - railPaddingY * 2 - 8))
      cardWidth = min(214, max(172, round(frame.width * 0.14)))
    } else {
      cardWidth = max(196, frame.width - 28)
      cardHeight = 186
    }
  }

  // MARK: Rail Cards, Removal & Interruptible Reflow

  private func syncCardsFromStore(animatedReflow: Bool) {
    let palette = LumenPalette.current(store.preferences)
    let glow = store.preferences.glow
    let activeItems = store.items.filter { !removingIDs.contains($0.id) }

    var existingByID: [String: LumenOrbitCardView] = [:]
    for card in cards { existingByID[card.item.id] = card }

    var nextCards: [LumenOrbitCardView] = []
    nextCards.reserveCapacity(activeItems.count)

    for (idx, item) in activeItems.enumerated() {
      if let reused = existingByID.removeValue(forKey: item.id), reused.item == item {
        reused.quickKeyIndex = idx < 9 ? idx : nil
        reused.applyTheme(palette, glowEnabled: glow)
        nextCards.append(reused)
      } else {
        if let stale = existingByID.removeValue(forKey: item.id) {
          stale.removeFromSuperview()
        }
        let card = LumenOrbitCardView(item: item, keyIndex: idx < 9 ? idx : nil, palette: palette, glowEnabled: glow)
        card.onSelectAndPaste = { [weak self] id in self?.pasteAndDismiss(id: id) }
        card.onHoverFocus = { [weak self] id in self?.setFocused(id: id, scroll: false) }
        card.onRemoveRequested = { [weak self] id in self?.removeCardAnimated(id: id) }
        card.onContextMenuRequested = { [weak self] id, event in self?.presentContextMenu(for: id, event: event) }
        railDocument.addSubview(card)
        nextCards.append(card)
      }
    }
    for obsolete in existingByID.values where !removingIDs.contains(obsolete.item.id) {
      obsolete.removeFromSuperview()
    }

    cards = nextCards
    emptyLabel.isHidden = !cards.isEmpty
    if let sel = selectedID, !cards.contains(where: { $0.item.id == sel }) {
      selectedID = cards.first?.item.id
    } else if selectedID == nil {
      selectedID = cards.first?.item.id
    }
    layoutCards(animated: animatedReflow)
    updateCardVisualStates()
  }

  private func cardFrame(at index: Int) -> NSRect {
    if position == "bottom" {
      let x = railPaddingX + CGFloat(index) * (cardWidth + cardGap)
      let y = railPaddingY + 6
      return NSRect(x: x, y: y, width: cardWidth, height: cardHeight)
    } else {
      let x = floor((railScroll.bounds.width - cardWidth) / 2)
      let y = 16 + CGFloat(index) * (cardHeight + cardGap)
      return NSRect(x: max(12, x), y: y, width: cardWidth, height: cardHeight)
    }
  }

  private func layoutCards(animated: Bool) {
    let horizontal = position == "bottom"
    if horizontal {
      let totalW = railPaddingX * 2 + CGFloat(cards.count) * cardWidth + CGFloat(max(0, cards.count - 1)) * cardGap
      let docW = max(railScroll.bounds.width, totalW)
      let docH = max(railScroll.bounds.height, cardHeight + railPaddingY * 2 + 12)
      railDocument.frame = NSRect(x: 0, y: 0, width: docW, height: docH)
    } else {
      let totalH = 32 + CGFloat(cards.count) * cardHeight + CGFloat(max(0, cards.count - 1)) * cardGap
      let docW = max(railScroll.bounds.width, cardWidth + 24)
      let docH = max(railScroll.bounds.height, totalH)
      railDocument.frame = NSRect(x: 0, y: 0, width: docW, height: docH)
    }

    for (idx, card) in cards.enumerated() {
      card.quickKeyIndex = idx < 9 ? idx : nil
      let target = cardFrame(at: idx)
      if animated && LumenMotion.isEnabled && card.frame != .zero && card.frame != target {
        NSAnimationContext.runAnimationGroup { ctx in
          ctx.duration = LumenMotion.removeDuration
          ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 0.85, 0.25, 1)
          card.animator().frame = target
        }
      } else {
        card.frame = target
      }
    }
  }

  private func animateCardsArrivalStagger() {
    let now = CACurrentMediaTime()
    for (idx, card) in cards.prefix(12).enumerated() {
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

  private func setFocused(id: String, scroll: Bool) {
    selectedID = id
    updateCardVisualStates()
    if scroll, let card = cards.first(where: { $0.item.id == id }) {
      railScroll.scrollToRectAnimated(card.frame, animated: true)
    }
  }

  private func updateCardVisualStates() {
    let selectedIndex = cards.firstIndex(where: { $0.item.id == selectedID })
    for (idx, card) in cards.enumerated() {
      if idx == selectedIndex {
        card.visualState = .selected
      } else if let sel = selectedIndex, abs(idx - sel) == 1 {
        card.visualState = .near
      } else {
        card.visualState = .idle
      }
    }
  }

  private func removeCardAnimated(id: String) {
    guard !removingIDs.contains(id),
          let idx = cards.firstIndex(where: { $0.item.id == id }) else { return }
    let card = cards[idx]
    removingIDs.insert(id)
    cards.remove(at: idx)

    if selectedID == id {
      selectedID = idx < cards.count ? cards[idx].item.id : cards.last?.item.id
    }

    // Spawn luminous particle burst when enabled
    if store.preferences.particles && store.preferences.glow && LumenMotion.isEnabled,
       let hostLayer = backdrop.layer {
      let cardRectInBackdrop = backdrop.convert(card.bounds, from: card)
      LumenOrbitReleaseLightEffect.burst(in: hostLayer, from: cardRectInBackdrop)
    }

    // Animate removing card out while remaining cards interruptibly reflow closed
    if LumenMotion.isEnabled, let layer = card.layer {
      let group = CAAnimationGroup()
      group.duration = LumenMotion.removeDuration
      group.timingFunction = CAMediaTimingFunction(controlPoints: 0.25, 0.8, 0.25, 1)
      group.fillMode = .forwards
      group.isRemovedOnCompletion = false

      let opacity = CAKeyframeAnimation(keyPath: "opacity")
      opacity.values = [1.0, 0.85, 0.0]
      opacity.keyTimes = [0.0, 0.28, 1.0]

      let scale = CAKeyframeAnimation(keyPath: "transform.scale")
      scale.values = [1.0, 0.95, 0.76]
      scale.keyTimes = [0.0, 0.28, 1.0]

      let lift = CAKeyframeAnimation(keyPath: "transform.translation.y")
      lift.values = [6.0, 18.0, -22.0]
      lift.keyTimes = [0.0, 0.28, 1.0]

      group.animations = [opacity, scale, lift]
      layer.add(group, forKey: "orbitCardRemove")

      DispatchQueue.main.asyncAfter(deadline: .now() + LumenMotion.removeDuration) { [weak self] in
        card.removeFromSuperview()
        self?.removingIDs.remove(id)
      }
    } else {
      card.removeFromSuperview()
      removingIDs.remove(id)
    }

    emptyLabel.isHidden = !cards.isEmpty
    layoutCards(animated: true)
    updateCardVisualStates()

    store.deleteItem(id: id) { [weak self] result in
      if case .success = result {
        self?.toastView.show(message: "已移除剪贴板记录", showUndo: self?.store.canUndoDelete == true)
      }
    }
  }

  private func undoLastDelete() {
    store.undoLastDelete { [weak self] result in
      switch result {
      case .success(let restored):
        self?.selectedID = restored.id
        self?.syncCardsFromStore(animatedReflow: true)
        self?.toastView.show(message: "已恢复记录", showUndo: self?.store.canUndoDelete == true)
      case .failure(let err):
        self?.toastView.show(message: err.localizedDescription)
      }
    }
  }

  private func pasteAndDismiss(id: String) {
    if LumenMotion.isEnabled,
       let card = cards.first(where: { $0.item.id == id }),
       let layer = card.layer {
      let anim = CAAnimationGroup()
      anim.duration = 0.22
      let lift = CABasicAnimation(keyPath: "transform.translation.y")
      lift.fromValue = 9.0
      lift.toValue = 26.0
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
        self?.toastView.show(message: "复制失败：\(err.localizedDescription)")
      }
    }
  }

  // MARK: Context Menu & Quick Look

  private func presentContextMenu(for id: String, event: NSEvent) {
    setFocused(id: id, scroll: false)
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

    let openAppItem = NSMenuItem(title: "在 Lumen 资料库中打开", action: #selector(menuOpenWorkspace), keyEquivalent: "")
    openAppItem.target = self
    menu.addItem(openAppItem)

    menu.addItem(NSMenuItem.separator())

    let delItem = NSMenuItem(title: "移除记录 (Del)", action: #selector(menuRemove(_:)), keyEquivalent: "")
    delItem.target = self
    delItem.representedObject = id
    menu.addItem(delItem)

    if let card = cards.first(where: { $0.item.id == id }) {
      NSMenu.popUpContextMenu(menu, with: event, for: card)
    }
  }

  @objc private func menuPaste(_ sender: NSMenuItem) {
    if let id = sender.representedObject as? String { pasteAndDismiss(id: id) }
  }

  @objc private func menuPeek(_ sender: NSMenuItem) {
    if let id = sender.representedObject as? String,
       let item = store.items.first(where: { $0.id == id }) {
      LumenPreviewWindow.shared.open(clipboardItems: [item], initialID: item.id)
    }
  }

  @objc private func menuPin(_ sender: NSMenuItem) {
    if let id = sender.representedObject as? String {
      store.togglePin(id: id)
    }
  }

  @objc private func menuOpenWorkspace() {
    hide(restoreFocus: false)
    onOpenWorkspace?()
  }

  @objc private func menuRemove(_ sender: NSMenuItem) {
    if let id = sender.representedObject as? String { removeCardAnimated(id: id) }
  }

  // MARK: Keyboard & Outside-Click Handling

  private func handleKeyDown(_ event: NSEvent) -> Bool {
    let mods = event.modifierFlags.intersection([.command, .option, .control, .shift])

    if mods == .command, event.charactersIgnoringModifiers?.lowercased() == "z", store.canUndoDelete {
      undoLastDelete()
      return true
    }
    if mods.contains(.command) || mods.contains(.option) || mods.contains(.control) {
      return false
    }

    switch event.keyCode {
    case 53: // Esc
      hide(restoreFocus: true)
      return true
    case 123, 126: // Left / Up
      stepFocus(-1)
      return true
    case 124, 125: // Right / Down
      stepFocus(1)
      return true
    case 115: // Home
      if let first = cards.first { setFocused(id: first.item.id, scroll: true) }
      return true
    case 119: // End
      if let last = cards.last { setFocused(id: last.item.id, scroll: true) }
      return true
    case 36: // Enter
      if let id = selectedID { pasteAndDismiss(id: id) }
      return true
    case 49: // Space -> shared native Quick Look
      if let id = selectedID, let item = store.items.first(where: { $0.id == id }) {
        LumenPreviewWindow.shared.open(clipboardItems: [item], initialID: item.id)
        return true
      }
      return false
    case 51, 117: // Delete / Backspace
      if let id = selectedID { removeCardAnimated(id: id) }
      return true
    default:
      if let chars = event.charactersIgnoringModifiers, chars.count == 1,
         let digit = Int(chars), digit >= 1 && digit <= 9, digit - 1 < cards.count {
        let target = cards[digit - 1]
        setFocused(id: target.item.id, scroll: true)
        pasteAndDismiss(id: target.item.id)
        return true
      }
      return false
    }
  }

  private func stepFocus(_ delta: Int) {
    guard !cards.isEmpty else { return }
    let idx = cards.firstIndex(where: { $0.item.id == selectedID }) ?? 0
    let next = max(0, min(cards.count - 1, idx + delta))
    setFocused(id: cards[next].item.id, scroll: true)
  }

  private func installOutsideClickMonitor() {
    removeOutsideClickMonitor()
    outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
      guard let self, self.isShowing, self.panel.isVisible else { return }
      if LumenPreviewWindow.shared.isVisible { return }
      let point = NSEvent.mouseLocation
      if !NSMouseInRect(point, self.panel.frame, false) {
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
