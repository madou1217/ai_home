import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import QuartzCore

/// C-convention CGEventTap callback forwarding directly to the owning LauncherPanel.
private let launcherEventTapCallback: CGEventTapCallBack = { proxy, type, event, refcon in
  guard let refcon else { return Unmanaged.passUnretained(event) }
  let owner = Unmanaged<LauncherPanel>.fromOpaque(refcon).takeUnretainedValue()
  return owner.handleTapEvent(proxy: proxy, type: type, event: event)
}

/// Native macOS application launcher panel (⌥Space) backed by `/v1/management/launcher/*`.
/// Installs a CGEventTap to swallow ⌥Space (preventing NBSP leaks into active text inputs)
/// and falls back gracefully to ShortcutRegistry global monitoring if tap creation fails.
final class LauncherPanel: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSTextFieldDelegate, NSWindowDelegate {
  private static let panelWidth: CGFloat = 680
  private static let panelHeight: CGFloat = 520
  private static let rowHeight: CGFloat = 50
  private static let cacheTTL: TimeInterval = 300

  private let emit: ([String: Any]) -> Void
  let panel = LauncherHostPanel(
    contentRect: NSRect(x: 0, y: 0, width: LauncherPanel.panelWidth, height: LauncherPanel.panelHeight),
    styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel],
    backing: .buffered,
    defer: false
  )

  private let backdrop = LauncherBackdropView()
  private let header = LauncherSearchHeaderView()
  private let tableScroll = NSScrollView()
  private let tableView = LauncherTableView()
  private let emptyState = LauncherEmptyStateView()
  private let footer = LauncherFooterView()
  private let selectionLayer: CALayer = {
    let layer = CALayer()
    layer.cornerRadius = 10
    layer.cornerCurve = .continuous
    layer.backgroundColor = LauncherPalette.cyan.withAlphaComponent(0.14).cgColor
    layer.borderWidth = 1
    layer.borderColor = LauncherPalette.cyan.withAlphaComponent(0.36).cgColor
    layer.opacity = 0
    layer.zPosition = -1
    return layer
  }()

  private let client = LauncherClient()
  private let iconCache = LauncherIconCache()

  private var enabled = false
  private var configuredShortcut = ShortcutRegistry.defaultLauncherShortcut
  private var tapKeyCode: UInt16 = 49
  private var tapModifiers: CGEventFlags = .maskAlternate
  private var eventTap: CFMachPort?
  private var eventTapSource: CFRunLoopSource?
  private(set) var isEventTapActive = false
  private var reportedTapFallback = false

  private var cachedApps: [LauncherApp] = []
  private var visibleResults: [LauncherMatchResult] = []
  private var selectedIndex = -1
  private var lastFetchedAt: Date?
  private var isFetching = false
  private var fetchGeneration = 0

  private var previousApp: NSRunningApplication?
  private var outsideClickMonitor: Any?
  private var visibilityGeneration = 0
  private var isHiding = false
  private var transientStatusWorkItem: DispatchWorkItem?

  init(emit: @escaping ([String: Any]) -> Void) {
    self.emit = emit
    super.init()
    panel.title = "AIH Launch"
    panel.appearance = NSAppearance(named: .darkAqua)
    panel.titleVisibility = .hidden
    panel.titlebarAppearsTransparent = true
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.isMovableByWindowBackground = false
    panel.delegate = self
    panel.level = .floating
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    for buttonType: NSWindow.ButtonType in [.closeButton, .miniaturizeButton, .zoomButton] {
      panel.standardWindowButton(buttonType)?.isHidden = true
    }
    panel.onKeyEvent = { [weak self] event in self?.handlePanelKey(event) ?? false }
    panel.onCancel = { [weak self] in self?.hide(restoreFocus: true) }
    buildContent()
  }

  deinit {
    destroyEventTap()
    removeOutsideClickMonitor()
  }

  // MARK: Configuration

  var isAvailable: Bool {
    enabled && client.isConfigured
  }

  func configure(origin nextOrigin: String, managementKey nextKey: String, shortcut nextShortcut: String, enabled nextEnabled: Bool) {
    let endpointChanged = client.configure(origin: nextOrigin, managementKey: nextKey)
    let normalizedShortcut = nextShortcut.trimmingCharacters(in: .whitespacesAndNewlines)
    let resolvedShortcut = normalizedShortcut.isEmpty ? ShortcutRegistry.defaultLauncherShortcut : normalizedShortcut
    let shortcutChanged = resolvedShortcut != configuredShortcut
    configuredShortcut = resolvedShortcut
    enabled = nextEnabled

    if let parsed = Self.parseShortcut(resolvedShortcut) {
      tapKeyCode = parsed.keyCode
      tapModifiers = parsed.modifiers
    } else {
      tapKeyCode = 49
      tapModifiers = .maskAlternate
    }

    footer.hintsLabel.stringValue = "↑↓ 选择    ↵ 打开    esc 关闭    \(resolvedShortcut) 切换"

    if endpointChanged {
      cachedApps = []
      visibleResults = []
      lastFetchedAt = nil
      iconCache.clear()
    }

    if !isAvailable {
      destroyEventTap()
      reportedTapFallback = false
      hide(restoreFocus: false)
      return
    }

    if shortcutChanged || !isEventTapActive {
      reconcileEventTap()
    }
    if panel.isVisible && endpointChanged {
      refreshAppsInBackground(force: true)
    }
  }

  // MARK: CGEventTap (swallows ⌥Space so NBSP is never typed into active inputs)

  func reconcileEventTap() {
    guard isAvailable else {
      destroyEventTap()
      return
    }
    if isEventTapActive, let tap = eventTap {
      CGEvent.tapEnable(tap: tap, enable: true)
      return
    }
    destroyEventTap()
    let mask = CGEventMask(1) << CGEventMask(CGEventType.keyDown.rawValue)
    guard let tap = CGEvent.tapCreate(
      tap: .cgSessionEventTap,
      place: .headInsertEventTap,
      options: .defaultTap,
      eventsOfInterest: mask,
      callback: launcherEventTapCallback,
      userInfo: Unmanaged.passUnretained(self).toOpaque()
    ) else {
      isEventTapActive = false
      if !reportedTapFallback {
        reportedTapFallback = true
        emit([
          "type": "status",
          "trusted": AXIsProcessTrusted(),
          "detail": "启动器 CGEventTap 创建失败，已回退全局监听（\(configuredShortcut) 可能输入空格）"
        ])
      }
      return
    }
    guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
      CFMachPortInvalidate(tap)
      isEventTapActive = false
      return
    }
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    eventTap = tap
    eventTapSource = source
    isEventTapActive = true
    reportedTapFallback = false
  }

  func destroyEventTap() {
    if let tap = eventTap {
      CGEvent.tapEnable(tap: tap, enable: false)
      CFMachPortInvalidate(tap)
    }
    if let source = eventTapSource {
      CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
    }
    eventTapSource = nil
    eventTap = nil
    isEventTapActive = false
  }

  fileprivate func handleTapEvent(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      if let tap = eventTap {
        CGEvent.tapEnable(tap: tap, enable: true)
      }
      return Unmanaged.passUnretained(event)
    }
    guard type == .keyDown, isAvailable else {
      return Unmanaged.passUnretained(event)
    }
    let rawKeyCode = event.getIntegerValueField(.keyboardEventKeycode)
    guard rawKeyCode >= 0 && rawKeyCode <= Int64(UInt16.max) else {
      return Unmanaged.passUnretained(event)
    }
    let keyCode = UInt16(rawKeyCode)
    let relevant: CGEventFlags = [.maskCommand, .maskAlternate, .maskControl, .maskShift]
    let flags = event.flags.intersection(relevant)
    guard keyCode == tapKeyCode && flags == tapModifiers else {
      return Unmanaged.passUnretained(event)
    }
    let isRepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
    if !isRepeat {
      DispatchQueue.main.async { [weak self] in
        self?.toggle()
      }
    }
    // Returning nil swallows the keyDown so Option+Space never inserts NBSP.
    return nil
  }

  private static func parseShortcut(_ value: String) -> (keyCode: UInt16, modifiers: CGEventFlags)? {
    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else { return nil }
    var modifiers: CGEventFlags = []
    var rest = ""
    for scalar in normalized.unicodeScalars {
      switch scalar {
      case "⌘": modifiers.insert(.maskCommand)
      case "⌥": modifiers.insert(.maskAlternate)
      case "⌃": modifiers.insert(.maskControl)
      case "⇧": modifiers.insert(.maskShift)
      default: rest.append(String(scalar))
      }
    }
    let tokens = rest.lowercased().split(separator: "+").map(String.init)
    let keyToken = tokens.last?.trimmingCharacters(in: .whitespacesAndNewlines) ?? rest.lowercased()
    for token in tokens.dropLast() {
      switch token.trimmingCharacters(in: .whitespacesAndNewlines) {
      case "cmd", "command": modifiers.insert(.maskCommand)
      case "alt", "option", "opt": modifiers.insert(.maskAlternate)
      case "ctrl", "control": modifiers.insert(.maskControl)
      case "shift": modifiers.insert(.maskShift)
      default: break
      }
    }
    guard let keyCode = Self.keyCodeMap[keyToken] else { return nil }
    return (keyCode, modifiers)
  }

  private static let keyCodeMap: [String: UInt16] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8,
    "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
    "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33,
    "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, ",": 43, "n": 45, "m": 46,
    "space": 49
  ]

  // MARK: Visibility & Animations

  func toggle() {
    if panel.isVisible && !isHiding {
      hide(restoreFocus: true)
    } else {
      show()
    }
  }

  func show() {
    visibilityGeneration += 1
    isHiding = false
    clearTransientStatus()

    if !panel.isVisible {
      let front = NSWorkspace.shared.frontmostApplication
      if front?.processIdentifier != ProcessInfo.processInfo.processIdentifier {
        previousApp = front
      }
    }

    positionOnMouseScreen()
    header.searchField.stringValue = ""
    applyFilter(animateRows: false)

    let needsRefresh = cachedApps.isEmpty
      || lastFetchedAt == nil
      || Date().timeIntervalSince(lastFetchedAt ?? .distantPast) > Self.cacheTTL
    if needsRefresh {
      refreshAppsInBackground(force: false)
    }

    panel.alphaValue = 0
    panel.makeKeyAndOrderFront(nil)
    panel.orderFrontRegardless()
    panel.makeKey()
    NSApp.activate(ignoringOtherApps: true)
    _ = NSRunningApplication.current.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    panel.layoutIfNeeded()
    updateSelectionHighlight(animated: false)
    panel.makeFirstResponder(header.searchField)

    installOutsideClickMonitor()
    animateEntrance()
    animateVisibleRowsStagger()
  }

  func hide(restoreFocus: Bool = true) {
    guard panel.isVisible, !isHiding else { return }
    removeOutsideClickMonitor()
    clearTransientStatus()
    isHiding = true
    visibilityGeneration += 1
    let gen = visibilityGeneration

    NSAnimationContext.runAnimationGroup({ context in
      context.duration = 0.12
      context.timingFunction = CAMediaTimingFunction(name: .easeIn)
      self.panel.animator().alphaValue = 0
    }, completionHandler: { [weak self] in
      guard let self, self.visibilityGeneration == gen else { return }
      self.isHiding = false
      self.panel.orderOut(nil)
      self.panel.alphaValue = 1
      let appToRestore = self.previousApp
      self.previousApp = nil
      if restoreFocus, let app = appToRestore, !app.isTerminated {
        _ = app.activate(options: [.activateIgnoringOtherApps])
      }
    })
  }

  /// Escape belongs to the active IME composition session when marked text is present.
  func shouldLetEscapeThrough() -> Bool {
    guard panel.isKeyWindow else { return false }
    return (panel.firstResponder as? NSTextInputClient)?.hasMarkedText() == true
  }

  /// Claims Escape from the global/local monitor when the launcher panel is key.
  func handleGlobalEscape() -> Bool {
    guard !shouldLetEscapeThrough(), panel.isKeyWindow else { return false }
    hide(restoreFocus: true)
    return true
  }

  private func positionOnMouseScreen() {
    let mouse = NSEvent.mouseLocation
    let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) })
      ?? NSScreen.main
      ?? NSScreen.screens.first
    guard let screen else {
      panel.center()
      return
    }
    let visible = screen.visibleFrame
    let x = round(visible.midX - Self.panelWidth / 2)
    let topOffset = round(visible.height * 0.18)
    let y = round(max(visible.minY + 24, visible.maxY - topOffset - Self.panelHeight))
    panel.setFrame(NSRect(x: x, y: y, width: Self.panelWidth, height: Self.panelHeight), display: false)
  }

  private func animateEntrance() {
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.16
      context.timingFunction = CAMediaTimingFunction(name: .easeOut)
      self.panel.animator().alphaValue = 1
    }
    guard let layer = backdrop.layer else { return }
    let cx = backdrop.bounds.midX
    let cy = backdrop.bounds.midY
    var startTransform = CATransform3DIdentity
    // Bottom-up AppKit layer coords: start 10pt lower and 0.96x centered, then spring upward to identity.
    startTransform = CATransform3DTranslate(startTransform, cx, cy - 10, 0)
    startTransform = CATransform3DScale(startTransform, 0.96, 0.96, 1)
    startTransform = CATransform3DTranslate(startTransform, -cx, -cy, 0)

    let spring = CASpringAnimation(keyPath: "transform")
    spring.damping = 18
    spring.stiffness = 220
    spring.mass = 0.8
    spring.fromValue = NSValue(caTransform3D: startTransform)
    spring.toValue = NSValue(caTransform3D: CATransform3DIdentity)
    spring.duration = min(max(spring.settlingDuration, 0.16), 0.36)
    layer.removeAnimation(forKey: "launcherEntrance")
    layer.transform = CATransform3DIdentity
    layer.add(spring, forKey: "launcherEntrance")
  }

  private func animateVisibleRowsStagger() {
    guard !visibleResults.isEmpty else { return }
    tableView.layoutSubtreeIfNeeded()
    let count = min(visibleResults.count, 8)
    let now = CACurrentMediaTime()
    for row in 0..<count {
      guard let rowView = tableView.rowView(atRow: row, makeIfNecessary: false) else { continue }
      rowView.wantsLayer = true
      guard let layer = rowView.layer else { continue }
      let delay = Double(row) * 0.012
      let group = CAAnimationGroup()
      group.beginTime = now + delay
      group.duration = 0.14
      group.fillMode = .backwards
      group.timingFunction = CAMediaTimingFunction(name: .easeOut)

      let fade = CABasicAnimation(keyPath: "opacity")
      fade.fromValue = 0.0
      fade.toValue = 1.0

      // NSTableView is flipped: +6pt moves down, so animating +6 -> 0 slides each row up 6px.
      let slide = CABasicAnimation(keyPath: "transform")
      slide.fromValue = NSValue(caTransform3D: CATransform3DMakeTranslation(0, 6, 0))
      slide.toValue = NSValue(caTransform3D: CATransform3DIdentity)

      group.animations = [fade, slide]
      layer.removeAnimation(forKey: "launcherStagger")
      layer.add(group, forKey: "launcherStagger")
    }
  }

  private func installOutsideClickMonitor() {
    removeOutsideClickMonitor()
    outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
      guard let self, self.panel.isVisible else { return }
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

  // MARK: Layout

  private func buildContent() {
    panel.contentView = backdrop

    header.searchField.delegate = self

    let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("launcherMain"))
    column.width = Self.panelWidth
    column.resizingMask = .autoresizingMask
    tableView.addTableColumn(column)
    tableView.headerView = nil
    tableView.rowHeight = Self.rowHeight
    tableView.intercellSpacing = NSSize(width: 0, height: 2)
    tableView.style = .plain
    tableView.allowsMultipleSelection = false
    tableView.allowsEmptySelection = true
    tableView.selectionHighlightStyle = .none
    tableView.backgroundColor = .clear
    tableView.focusRingType = .none
    tableView.wantsLayer = true
    tableView.dataSource = self
    tableView.delegate = self
    tableView.target = self
    tableView.action = #selector(handleRowClick)
    tableView.keyHandler = { [weak self] event in self?.handlePanelKey(event) ?? false }

    tableScroll.documentView = tableView
    tableScroll.hasVerticalScroller = true
    tableScroll.autohidesScrollers = true
    tableScroll.drawsBackground = false
    tableScroll.borderType = .noBorder
    tableScroll.scrollerStyle = .overlay
    tableScroll.contentInsets = NSEdgeInsets(top: 6, left: 0, bottom: 6, right: 0)
    tableScroll.automaticallyAdjustsContentInsets = false

    emptyState.isHidden = true

    for view in [header, tableScroll, emptyState, footer] {
      view.translatesAutoresizingMaskIntoConstraints = false
      backdrop.addSubview(view)
    }

    NSLayoutConstraint.activate([
      header.topAnchor.constraint(equalTo: backdrop.topAnchor),
      header.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor),
      header.trailingAnchor.constraint(equalTo: backdrop.trailingAnchor),

      tableScroll.topAnchor.constraint(equalTo: header.bottomAnchor),
      tableScroll.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor),
      tableScroll.trailingAnchor.constraint(equalTo: backdrop.trailingAnchor),
      tableScroll.bottomAnchor.constraint(equalTo: footer.topAnchor),

      emptyState.topAnchor.constraint(equalTo: tableScroll.topAnchor),
      emptyState.leadingAnchor.constraint(equalTo: tableScroll.leadingAnchor),
      emptyState.trailingAnchor.constraint(equalTo: tableScroll.trailingAnchor),
      emptyState.bottomAnchor.constraint(equalTo: tableScroll.bottomAnchor),

      footer.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor),
      footer.trailingAnchor.constraint(equalTo: backdrop.trailingAnchor),
      footer.bottomAnchor.constraint(equalTo: backdrop.bottomAnchor)
    ])
  }

  // MARK: Data & Filtering

  private func refreshAppsInBackground(force: Bool) {
    guard client.isConfigured else {
      footer.setStatus("本机 Server 未连接", isError: false)
      updateEmptyAndCountState()
      return
    }
    if isFetching && !force { return }
    isFetching = true
    fetchGeneration += 1
    let gen = fetchGeneration
    let hadApps = !cachedApps.isEmpty
    if !hadApps {
      emptyState.setMessage("正在加载应用…", symbol: "arrow.triangle.2.circlepath")
      emptyState.isHidden = false
      footer.setStatus("正在扫描应用…", isError: false)
    }

    client.fetchApps(refresh: force) { [weak self] result in
      guard let self, self.fetchGeneration == gen else { return }
      self.isFetching = false
      switch result {
      case .success(let payload):
        self.cachedApps = payload.apps
        self.lastFetchedAt = Date()
        self.footer.setStatus("", isError: false)
        self.applyFilter(animateRows: !hadApps && self.panel.isVisible)
      case .failure(let error):
        if self.cachedApps.isEmpty {
          self.footer.setStatus("加载失败：\(error.localizedDescription)", isError: true)
          self.updateEmptyAndCountState()
        } else {
          self.footer.setStatus("刷新失败，已显示缓存", isError: false)
        }
      }
    }
  }

  private func applyFilter(animateRows: Bool) {
    let query = header.searchField.stringValue
    visibleResults = LauncherRanker.filter(cachedApps, query: query)
    tableView.reloadData()

    if visibleResults.isEmpty {
      selectedIndex = -1
      tableView.deselectAll(nil)
      updateSelectionHighlight(animated: false)
    } else {
      selectRow(0, animated: false, scroll: true)
    }

    updateEmptyAndCountState()
    if animateRows {
      animateVisibleRowsStagger()
    }
  }

  private func updateEmptyAndCountState() {
    if visibleResults.isEmpty {
      header.countLabel.stringValue = isFetching ? "加载中…" : "0 个应用"
      emptyState.setMessage(isFetching && cachedApps.isEmpty ? "正在加载应用…" : "没有找到应用")
      emptyState.isHidden = false
    } else {
      let query = header.searchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
      header.countLabel.stringValue = query.isEmpty
        ? "\(visibleResults.count) 个应用"
        : "\(visibleResults.count) / \(cachedApps.count)"
      emptyState.isHidden = true
    }
  }

  private func selectRow(_ index: Int, animated: Bool, scroll: Bool) {
    guard index >= 0, index < visibleResults.count else { return }
    let previous = selectedIndex
    selectedIndex = index
    if tableView.selectedRow != index {
      tableView.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
    }
    if scroll {
      tableView.scrollRowToVisible(index)
    }
    if previous >= 0, previous < visibleResults.count, previous != index,
       let prevView = tableView.view(atColumn: 0, row: previous, makeIfNecessary: false) as? LauncherRowView {
      prevView.setSelected(false, animated: animated)
    }
    if let nextView = tableView.view(atColumn: 0, row: index, makeIfNecessary: false) as? LauncherRowView {
      nextView.setSelected(true, animated: animated)
    }
    updateSelectionHighlight(animated: animated)
  }

  private func moveSelection(_ delta: Int) {
    guard !visibleResults.isEmpty else { return }
    let base = selectedIndex >= 0 ? selectedIndex : 0
    let next = max(0, min(visibleResults.count - 1, base + delta))
    guard next != selectedIndex else { return }
    selectRow(next, animated: true, scroll: true)
  }

  private func updateSelectionHighlight(animated: Bool) {
    if selectionLayer.superlayer == nil, let hostLayer = tableView.layer {
      hostLayer.insertSublayer(selectionLayer, at: 0)
    }
    guard selectedIndex >= 0, selectedIndex < visibleResults.count else {
      CATransaction.begin()
      CATransaction.setDisableActions(!animated)
      selectionLayer.opacity = 0
      CATransaction.commit()
      return
    }
    let rowRect = tableView.rect(ofRow: selectedIndex)
    guard !rowRect.isEmpty else { return }
    let targetFrame = rowRect.insetBy(dx: 10, dy: 2)
    let targetBounds = CGRect(origin: .zero, size: targetFrame.size)
    let targetPosition = CGPoint(x: targetFrame.midX, y: targetFrame.midY)

    if animated && selectionLayer.opacity > 0.01 {
      let currentLayer = selectionLayer.presentation() ?? selectionLayer
      let move = CABasicAnimation(keyPath: "position")
      move.fromValue = NSValue(point: currentLayer.position)
      move.toValue = NSValue(point: targetPosition)
      move.duration = 0.12
      move.timingFunction = CAMediaTimingFunction(name: .easeOut)

      let resize = CABasicAnimation(keyPath: "bounds")
      resize.fromValue = NSValue(rect: currentLayer.bounds)
      resize.toValue = NSValue(rect: targetBounds)
      resize.duration = 0.12
      resize.timingFunction = CAMediaTimingFunction(name: .easeOut)

      let fade = CABasicAnimation(keyPath: "opacity")
      fade.fromValue = currentLayer.opacity
      fade.toValue = Float(1.0)
      fade.duration = 0.12
      fade.timingFunction = CAMediaTimingFunction(name: .easeOut)

      CATransaction.begin()
      CATransaction.setDisableActions(true)
      selectionLayer.bounds = targetBounds
      selectionLayer.position = targetPosition
      selectionLayer.opacity = 1
      CATransaction.commit()

      selectionLayer.add(move, forKey: "slidePosition")
      selectionLayer.add(resize, forKey: "slideBounds")
      selectionLayer.add(fade, forKey: "slideOpacity")
    } else {
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      selectionLayer.bounds = targetBounds
      selectionLayer.position = targetPosition
      selectionLayer.opacity = 1
      CATransaction.commit()
    }
  }

  // MARK: Launching

  @objc private func handleRowClick() {
    let clicked = tableView.clickedRow
    guard clicked >= 0, clicked < visibleResults.count else { return }
    selectRow(clicked, animated: true, scroll: false)
    openApp(visibleResults[clicked].app)
  }

  private func openSelected() {
    guard selectedIndex >= 0, selectedIndex < visibleResults.count else { return }
    openApp(visibleResults[selectedIndex].app)
  }

  private func openApp(_ app: LauncherApp) {
    client.openApp(id: app.id) { [weak self] result in
      guard let self else { return }
      switch result {
      case .success:
        // Invalidate TTL on next show so updated usage recency is reflected promptly.
        self.lastFetchedAt = nil
        self.hide(restoreFocus: false)
      case .failure:
        self.openFallbackLocally(app)
      }
    }
  }

  private func openFallbackLocally(_ app: LauncherApp) {
    guard !app.path.isEmpty, FileManager.default.fileExists(atPath: app.path) else {
      showTransientError("无法打开 \(app.name)")
      return
    }
    let url = URL(fileURLWithPath: app.path)
    let config = NSWorkspace.OpenConfiguration()
    NSWorkspace.shared.openApplication(at: url, configuration: config) { [weak self] _, error in
      DispatchQueue.main.async {
        guard let self else { return }
        if error != nil {
          self.showTransientError("无法打开 \(app.name)")
        } else {
          self.hide(restoreFocus: false)
        }
      }
    }
  }

  private func showTransientError(_ message: String) {
    clearTransientStatus()
    footer.setStatus(message, isError: true)
    let work = DispatchWorkItem { [weak self] in
      self?.footer.setStatus("", isError: false)
    }
    transientStatusWorkItem = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.8, execute: work)
  }

  private func clearTransientStatus() {
    transientStatusWorkItem?.cancel()
    transientStatusWorkItem = nil
    footer.setStatus("", isError: false)
  }

  // MARK: Keyboard & IME

  private func handlePanelKey(_ event: NSEvent) -> Bool {
    if let input = panel.firstResponder as? NSTextInputClient, input.hasMarkedText() {
      return false
    }
    switch event.keyCode {
    case 53:
      hide(restoreFocus: true)
      return true
    case 36, 76:
      openSelected()
      return true
    case 125:
      moveSelection(1)
      return true
    case 126:
      moveSelection(-1)
      return true
    default:
      return false
    }
  }

  func controlTextDidChange(_ notification: Notification) {
    applyFilter(animateRows: true)
  }

  func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
    if textView.hasMarkedText() { return false }
    switch commandSelector {
    case #selector(NSResponder.moveUp(_:)):
      moveSelection(-1)
      return true
    case #selector(NSResponder.moveDown(_:)):
      moveSelection(1)
      return true
    case #selector(NSResponder.insertNewline(_:)):
      openSelected()
      return true
    case #selector(NSResponder.cancelOperation(_:)):
      hide(restoreFocus: true)
      return true
    default:
      return false
    }
  }

  // MARK: NSTableViewDataSource / NSTableViewDelegate

  func numberOfRows(in tableView: NSTableView) -> Int {
    visibleResults.count
  }

  func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
    LauncherTableRowView()
  }

  func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
    guard row >= 0, row < visibleResults.count else { return nil }
    let identifier = NSUserInterfaceItemIdentifier("LauncherRowView")
    let view = (tableView.makeView(withIdentifier: identifier, owner: self) as? LauncherRowView) ?? {
      let created = LauncherRowView()
      created.identifier = identifier
      return created
    }()
    view.apply(visibleResults[row], iconCache: iconCache, selected: row == selectedIndex)
    return view
  }

  func tableViewSelectionDidChange(_ notification: Notification) {
    let row = tableView.selectedRow
    if row >= 0, row < visibleResults.count, row != selectedIndex {
      selectRow(row, animated: true, scroll: false)
    }
  }

  // MARK: NSWindowDelegate

  func windowDidResignKey(_ notification: Notification) {
    if panel.isVisible && !isHiding {
      hide(restoreFocus: false)
    }
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    hide(restoreFocus: true)
    return false
  }
}
