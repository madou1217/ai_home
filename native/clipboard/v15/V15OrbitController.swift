import AppKit
import CoreGraphics
import Foundation
import QuartzCore

// MARK: - Logical Slot Model (Single Source of Truth Across All Participating Displays)

private final class V15OrbitReservationSlot {
  let itemID: String
  let item: LumenClipboardItem
  var width: CGFloat
  var gap: CGFloat
  var reflowAnimID: UUID?
  var isReflowing = false

  init(item: LumenClipboardItem, width: CGFloat, gap: CGFloat) {
    self.itemID = item.id
    self.item = item
    self.width = width
    self.gap = gap
  }
}

private enum V15OrbitRailSlot {
  case live(LumenClipboardItem)
  case reservation(V15OrbitReservationSlot)

  var itemID: String {
    switch self {
    case .live(let item): return item.id
    case .reservation(let res): return res.itemID
    }
  }
}

// MARK: - Multi-Display Bottom-Row Continuous Topology (§4, §14.2, A01–A04, A70)

struct V15ScreenGeometry: Equatable {
  let id: String
  let frame: NSRect
  let visibleFrame: NSRect
  let backingScaleFactor: CGFloat
  let isMainScreen: Bool

  init(screen: NSScreen, fallbackIndex: Int, isMainScreen: Bool) {
    self.id = V15DisplayTopology.screenIdentifier(screen, fallbackIndex: fallbackIndex)
    self.frame = screen.frame
    self.visibleFrame = screen.visibleFrame
    self.backingScaleFactor = screen.backingScaleFactor
    self.isMainScreen = isMainScreen
  }
}

struct V15ViewportDescriptor: Equatable {
  let id: String
  let viewportIndex: Int
  let totalViewportCount: Int
  let screenFrame: NSRect
  let visibleFrame: NSRect
  let panelFrame: NSRect
  /// Global rail X interval covered by this display's clipped rail strip:
  /// - Screen 0 (leftmost): `0...(panelFrame.width - 38)` (Optical Dots occupy `0..<38`).
  /// - Screen k > 0: contiguous continuation `prevUpper...(prevUpper + panelFrame.width)`.
  let railRange: ClosedRange<CGFloat>
  let backingScaleFactor: CGFloat
  let showsOpticalDots: Bool
  let isPrimaryViewport: Bool

  var railSpanWidth: CGFloat {
    max(1, railRange.upperBound - railRange.lowerBound)
  }
}

enum V15DisplayTopology {
  static let horizontalContiguityTolerance: CGFloat = 32
  static let bottomEdgeAlignmentTolerance: CGFloat = 140
  static let verticalOcclusionOverlapRatio: CGFloat = 0.25

  static func screenIdentifier(_ screen: NSScreen, fallbackIndex: Int) -> String {
    if let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
      return "v15-display-\(number.uint32Value)"
    }
    return "v15-display-\(fallbackIndex)"
  }

  static func activeScreen(from screens: [NSScreen] = NSScreen.screens) -> NSScreen? {
    let pointer = NSEvent.mouseLocation
    if let match = screens.first(where: { NSMouseInRect(pointer, $0.frame, false) }) {
      return match
    }
    return NSScreen.main ?? screens.first
  }

  static func geometries(from screens: [NSScreen] = NSScreen.screens) -> [V15ScreenGeometry] {
    let mainFrame = NSScreen.main?.frame
    return screens.enumerated().map { idx, screen in
      V15ScreenGeometry(
        screen: screen,
        fallbackIndex: idx,
        isMainScreen: mainFrame.map { $0 == screen.frame } ?? (idx == 0)
      )
    }
  }

  /// Excludes upper-row displays occluded underneath by another display (e.g., 1×2, 2×2).
  static func isBottomEdgeExposed(_ candidate: V15ScreenGeometry, among all: [V15ScreenGeometry]) -> Bool {
    for other in all where other.id != candidate.id {
      let isBelow = other.frame.minY < candidate.frame.minY - 1 && other.frame.midY < candidate.frame.midY
      guard isBelow else { continue }
      let overlap = min(candidate.frame.maxX, other.frame.maxX) - max(candidate.frame.minX, other.frame.minX)
      if overlap >= min(candidate.frame.width, other.frame.width) * verticalOcclusionOverlapRatio {
        return false
      }
    }
    return true
  }

  static func extractBottomRowCandidates(from all: [V15ScreenGeometry]) -> [V15ScreenGeometry] {
    guard all.count > 1 else { return all }
    let exposed = all.filter { isBottomEdgeExposed($0, among: all) }
    let pool = exposed.isEmpty ? all : exposed
    let globalMinY = pool.map(\.frame.minY).min() ?? 0
    let bottomTier = pool.filter { abs($0.frame.minY - globalMinY) <= bottomEdgeAlignmentTolerance }
    return (bottomTier.isEmpty ? pool : bottomTier).sorted { lhs, rhs in
      if abs(lhs.frame.minX - rhs.frame.minX) > 0.5 {
        return lhs.frame.minX < rhs.frame.minX
      }
      return lhs.frame.minY < rhs.frame.minY
    }
  }

  static func areHorizontallyContiguous(_ left: V15ScreenGeometry, _ right: V15ScreenGeometry) -> Bool {
    let horizontalGap = right.frame.minX - left.frame.maxX
    guard abs(horizontalGap) <= horizontalContiguityTolerance else { return false }
    guard abs(right.frame.minY - left.frame.minY) <= bottomEdgeAlignmentTolerance else { return false }

    let commonH = min(
      V15Tokens.Shell.height(forScreenHeight: left.frame.height),
      V15Tokens.Shell.height(forScreenHeight: right.frame.height)
    )
    let overlapMinY = max(left.visibleFrame.minY, right.visibleFrame.minY)
    let overlapMaxY = min(left.visibleFrame.minY + commonH, right.visibleFrame.minY + commonH)
    return (overlapMaxY - overlapMinY) >= commonH * 0.45
  }

  static func partitionContiguousGroups(_ sorted: [V15ScreenGeometry]) -> [[V15ScreenGeometry]] {
    var groups: [[V15ScreenGeometry]] = []
    for geo in sorted {
      if var last = groups.last, let prev = last.last, areHorizontallyContiguous(prev, geo) {
        last.append(geo)
        groups[groups.count - 1] = last
      } else {
        groups.append([geo])
      }
    }
    return groups
  }

  static func selectWinningGroup(from groups: [[V15ScreenGeometry]], preferredID: String?) -> [V15ScreenGeometry] {
    guard !groups.isEmpty else { return [] }
    if let preferredID,
       let match = groups.first(where: { group in group.contains(where: { $0.id == preferredID }) }) {
      return match
    }
    return groups.max(by: { lhs, rhs in
      let lhsSpan = lhs.reduce(CGFloat(0)) { $0 + $1.frame.width }
      let rhsSpan = rhs.reduce(CGFloat(0)) { $0 + $1.frame.width }
      if abs(lhsSpan - rhsSpan) > 1.0 { return lhsSpan < rhsSpan }
      let lhsMain = lhs.contains(where: \.isMainScreen)
      let rhsMain = rhs.contains(where: \.isMainScreen)
      if lhsMain != rhsMain { return !lhsMain && rhsMain }
      return (lhs.first?.frame.minX ?? 0) > (rhs.first?.frame.minX ?? 0)
    }) ?? groups[0]
  }

  static func computeViewports(screens: [NSScreen] = NSScreen.screens) -> [V15ViewportDescriptor] {
    let allGeos = geometries(from: screens)
    guard !allGeos.isEmpty else {
      let fallbackFrame = NSRect(x: 0, y: 0, width: 1440, height: 900)
      let h = V15Tokens.Shell.height(forScreenHeight: fallbackFrame.height)
      let panelFrame = NSRect(x: 0, y: 0, width: fallbackFrame.width, height: h)
      let railSpan = max(1, panelFrame.width - V15Tokens.Rail.leftShiftForDots)
      return [
        V15ViewportDescriptor(
          id: "v15-fallback-0",
          viewportIndex: 0,
          totalViewportCount: 1,
          screenFrame: fallbackFrame,
          visibleFrame: fallbackFrame,
          panelFrame: panelFrame,
          railRange: 0...railSpan,
          backingScaleFactor: 2.0,
          showsOpticalDots: true,
          isPrimaryViewport: true
        )
      ]
    }

    let active = activeScreen(from: screens)
    let preferredID = active.flatMap { act in allGeos.first(where: { $0.frame == act.frame })?.id }
    let participating: [V15ScreenGeometry]
    if allGeos.count > 1 {
      let candidates = extractBottomRowCandidates(from: allGeos)
      let groups = partitionContiguousGroups(candidates)
      participating = selectWinningGroup(from: groups, preferredID: preferredID)
    } else {
      participating = allGeos
    }

    let commonHeight = participating
      .map { V15Tokens.Shell.height(forScreenHeight: $0.frame.height) }
      .min() ?? V15Tokens.Shell.height(forScreenHeight: 900)
    let sharedBaselineY = participating.map(\.visibleFrame.minY).max() ?? 0
    let primaryID = participating.first(where: { $0.id == preferredID })?.id
      ?? participating.first(where: \.isMainScreen)?.id
      ?? participating[0].id

    var result: [V15ViewportDescriptor] = []
    result.reserveCapacity(participating.count)
    var cursor: CGFloat = 0

    for (idx, geo) in participating.enumerated() {
      let showsDots = (idx == 0)
      let maxSafeY = max(geo.visibleFrame.minY, geo.visibleFrame.maxY - commonHeight)
      let panelY = max(geo.visibleFrame.minY, min(maxSafeY, sharedBaselineY))
      let panelFrame = NSRect(x: geo.frame.minX, y: panelY, width: geo.frame.width, height: commonHeight)
      let stripWidth = max(1, panelFrame.width - (showsDots ? V15Tokens.Rail.leftShiftForDots : 0))
      let range = cursor...(cursor + stripWidth)
      cursor += stripWidth

      result.append(V15ViewportDescriptor(
        id: geo.id,
        viewportIndex: idx,
        totalViewportCount: participating.count,
        screenFrame: geo.frame,
        visibleFrame: geo.visibleFrame,
        panelFrame: panelFrame,
        railRange: range,
        backingScaleFactor: geo.backingScaleFactor,
        showsOpticalDots: showsDots,
        isPrimaryViewport: geo.id == primaryID
      ))
    }

    return result
  }
}

// MARK: - Shared Logical Rail State

private struct V15OrbitRailState {
  var visible = false
  var activeFilter: LumenLogicalCategory = .all
  var selectedClipID: String?
  var scrollOffset: CGFloat = 0
  var perFilterOffsets: [LumenLogicalCategory: CGFloat] = [:]
  var topologyRevision = 0
  var animationEpoch = 0

  var cardWidth: CGFloat = 200
  var cardHeight: CGFloat = 242
  var cardOriginY: CGFloat = V15Tokens.Rail.paddingTop

  mutating func updateMetrics(for descriptors: [V15ViewportDescriptor]) {
    guard let reference = descriptors.first(where: \.isPrimaryViewport) ?? descriptors.first else { return }
    let commonH = descriptors.map(\.panelFrame.height).min() ?? reference.panelFrame.height
    cardWidth = V15Tokens.Card.width(forRailWidth: reference.railSpanWidth)
    cardHeight = V15Tokens.Card.height(forPanelHeight: commonH)
    let availableVertical = max(cardHeight, commonH - V15Tokens.Rail.paddingTop - V15Tokens.Rail.paddingBottom)
    cardOriginY = V15Tokens.Rail.paddingTop + floor((availableVertical - cardHeight) * 0.5)
  }

  mutating func rememberScrollOffset(_ offset: CGFloat, for filter: LumenLogicalCategory) {
    scrollOffset = max(0, offset)
    perFilterOffsets[filter] = scrollOffset
  }

  func savedScrollOffset(for filter: LumenLogicalCategory) -> CGFloat {
    perFilterOffsets[filter] ?? 0
  }
}

// MARK: - Per-Display Transparent Borderless NSPanel & Viewport

private final class V15OrbitHostPanel: NSPanel {
  var onKeyEvent: ((NSEvent) -> Bool)?
  var onCancel: (() -> Void)?

  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }

  override func sendEvent(_ event: NSEvent) {
    if event.type == .keyDown, let handler = onKeyEvent, handler(event) {
      return
    }
    super.sendEvent(event)
  }

  override func cancelOperation(_ sender: Any?) {
    onCancel?()
  }
}

private final class V15OrbitViewport {
  var descriptor: V15ViewportDescriptor
  let panel: V15OrbitHostPanel
  let rootView = V15FlippedContainerView()
  let backdropView = V15OrbitBackdropView()
  let ambientParticlesView = V15OrbitAmbientParticlesView()
  let opticalDotsView = V15OpticalDotsView()
  let railViewport = V15OrbitRailViewportView()
  let particlesOverlay = V15OrbitParticlesOverlayView()
  let toastView = V15ToastBannerView()

  var mountedCards: [String: V15OrbitCardItemView] = [:]

  init(descriptor: V15ViewportDescriptor) {
    self.descriptor = descriptor
    panel = V15OrbitHostPanel(
      contentRect: descriptor.panelFrame,
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    panel.isReleasedWhenClosed = false
    panel.hidesOnDeactivate = false
    panel.acceptsMouseMovedEvents = true

    rootView.wantsLayer = true
    rootView.layer?.masksToBounds = true
    panel.contentView = rootView

    rootView.addSubview(backdropView)
    rootView.addSubview(ambientParticlesView)
    rootView.addSubview(railViewport)
    rootView.addSubview(opticalDotsView)
    rootView.addSubview(particlesOverlay)
    rootView.addSubview(toastView)

    toastView.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      toastView.centerXAnchor.constraint(equalTo: rootView.centerXAnchor),
      toastView.topAnchor.constraint(equalTo: rootView.topAnchor, constant: 10)
    ])

    applyDescriptor(descriptor)
  }

  func applyDescriptor(_ next: V15ViewportDescriptor) {
    descriptor = next
    let size = next.panelFrame.size
    let bounds = NSRect(origin: .zero, size: size)
    let dotsWidth: CGFloat = next.showsOpticalDots ? V15Tokens.Rail.leftShiftForDots : 0

    rootView.frame = bounds
    backdropView.frame = bounds
    ambientParticlesView.frame = bounds
    opticalDotsView.isHidden = !next.showsOpticalDots
    opticalDotsView.frame = NSRect(x: 0, y: 0, width: dotsWidth, height: size.height)
    railViewport.frame = NSRect(x: dotsWidth, y: 0, width: max(1, size.width - dotsWidth), height: size.height)
    particlesOverlay.frame = bounds
    particlesOverlay.railRangeLowerBound = next.railRange.lowerBound
    particlesOverlay.railOriginOffsetX = dotsWidth
  }

  func applyAppearance(isDark: Bool, particlesEnabled: Bool, glowEnabled: Bool, isVisible: Bool) {
    backdropView.applyAppearance(isDark: isDark, glowEnabled: glowEnabled)
    ambientParticlesView.setActive(isVisible, particlesEnabled: particlesEnabled, glowEnabled: glowEnabled)
    opticalDotsView.applyAppearance(isDark: isDark, glowEnabled: glowEnabled)
  }

  func offscreenFrame() -> NSRect {
    NSRect(
      x: descriptor.panelFrame.minX,
      y: descriptor.panelFrame.minY - descriptor.panelFrame.height - 16,
      width: descriptor.panelFrame.width,
      height: descriptor.panelFrame.height
    )
  }

  func teardown() {
    ambientParticlesView.stop()
    opticalDotsView.teardown()
    particlesOverlay.detachEngine()
    for card in mountedCards.values {
      card.removeFromSuperview()
    }
    mountedCards.removeAll()
    panel.orderOut(nil)
    panel.close()
  }
}

// MARK: - V15 Orbit Controller (Strict V15 Rewrite, Zero Legacy V7 UI Reuse)

/// Pure Paste Lumen V15 macOS Orbit controller.
/// Coordinates 1..N transparent bottom-edge `NSPanel` viewports across the contiguous bottom
/// display row as ONE logical rail with:
/// - Single 38 DIP Optical Dots 3.0 column on the leftmost display (`V15OpticalDotsView`).
/// - Shared global scroll offset, active filter, selection, hover coalescing, and monotonic clock.
/// - Exact V15 card/header/close/lift optical coordinate system (`V15OrbitRail.swift`).
/// - Real-texture two-phase soft dissolution (`480ms` front / `320–500ms` particles / `0.58` alpha /
///   `920ms` hold / `420ms` reflow) and `900ms` real-time capture aggregation (`V15OrbitParticles.swift`).
/// - Full README §3.3 keyboard, pointer, accessibility, and Reduce Motion support.
final class V15OrbitController: NSObject, NSWindowDelegate {
  private enum KeyboardFocusTarget: Equatable {
    case none
    case dots
    case card(String)
    case closeButton(String)
  }

  private let store = LumenClipboardStore.shared
  private let particleEngine = V15OrbitParticleEngine()

  private var state = V15OrbitRailState()
  private var viewports: [V15OrbitViewport] = []
  private var slots: [V15OrbitRailSlot] = []
  private var aggregatingIDs: Set<String> = []

  private var enabled = false
  private var previousApp: NSRunningApplication?
  private var outsideClickMonitor: Any?
  private var storeObserverID: UUID?
  private var screenObserver: NSObjectProtocol?

  private var hoveredCardID: String?
  private var hoverClearWork: DispatchWorkItem?
  private var keyboardFocus: KeyboardFocusTarget = .none
  private var scrollAnimID: UUID?
  private var transitionToken = 0
  private var isContextMenuOpen = false
  private var suppressNextItemsUpdatedReconcile = false

  // MARK: Public API (Compatible with `native/aihome-app/main.swift`)

  var onOpenWorkspace: (() -> Void)?
  var onOpenWorkspaceWithSelection: ((String?) -> Void)?

  /// Primary participating panel exposed for host AppDelegate visibility checks.
  var panel: NSPanel {
    primaryViewport.panel
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

  private var leftmostViewport: V15OrbitViewport {
    viewports[0]
  }

  private var primaryViewport: V15OrbitViewport {
    viewports.first(where: \.descriptor.isPrimaryViewport) ?? viewports[0]
  }

  private var isAnyPanelVisible: Bool {
    viewports.contains(where: \.panel.isVisible)
  }

  private var liveItems: [LumenClipboardItem] {
    slots.compactMap {
      if case .live(let item) = $0 { return item }
      return nil
    }
  }

  private var totalViewportRailSpan: CGFloat {
    max(1, viewports.last?.descriptor.railRange.upperBound ?? primaryViewport.descriptor.railSpanWidth)
  }

  override init() {
    super.init()
    rebuildViewports(isShowing: false)
    applyThemeToAllViewports()

    storeObserverID = store.addObserver { [weak self] event in
      self?.handleStoreEvent(event)
    }
    screenObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.didChangeScreenParametersNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.handleDisplayTopologyChanged()
    }
  }

  deinit {
    store.stopLiveOrbitCapture()
    removeOutsideClickMonitor()
    hoverClearWork?.cancel()
    particleEngine.stopAll()
    if let id = storeObserverID {
      store.removeObserver(id)
    }
    if let screenObserver {
      NotificationCenter.default.removeObserver(screenObserver)
    }
    for vp in viewports {
      vp.teardown()
    }
  }

  // MARK: Configuration & Lifecycle

  func configure(origin nextOrigin: String, managementKey nextKey: String, enabled nextEnabled: Bool, position nextPosition: String) {
    _ = nextPosition // V15 Orbit is anchored strictly to the bottom contiguous display row (§3.1, §4)
    enabled = nextEnabled

    if !nextOrigin.isEmpty || !nextKey.isEmpty {
      store.configure(origin: nextOrigin, managementKey: nextKey)
    } else if nextEnabled {
      store.ensureConfiguredFromLocalConfig()
    }

    if !nextEnabled {
      hide(restoreFocus: false)
    }
  }

  func toggle() {
    if state.visible {
      hide(restoreFocus: true)
    } else {
      show()
    }
  }

  func show() {
    store.ensureConfiguredFromLocalConfig()
    guard isAvailable else { return }

    let wasVisible = isAnyPanelVisible
    if !wasVisible {
      let front = NSWorkspace.shared.frontmostApplication
      if front?.processIdentifier != ProcessInfo.processInfo.processIdentifier {
        previousApp = front
      }
    }

    transitionToken += 1
    let token = transitionToken
    state.visible = true
    state.animationEpoch += 1

    rebuildViewports(isShowing: false)
    slots = filteredStoreItems().map { .live($0) }
    reconcileSelection()
    state.scrollOffset = clampedScrollOffset(state.savedScrollOffset(for: state.activeFilter))

    for vp in viewports {
      let startFrame = (wasVisible && vp.panel.isVisible) ? vp.panel.frame : vp.offscreenFrame()
      vp.panel.setFrame(startFrame, display: false)
      if !wasVisible || !vp.panel.isVisible {
        vp.panel.alphaValue = V15Motion.isEnabled ? 0 : 1
      }
    }

    applyThemeToAllViewports()
    for vp in viewports {
      for card in vp.mountedCards.values {
        card.resetPasteConfirmation()
      }
    }
    syncMountedCardSlices(animated: false)
    updateAllCardStates(animated: false)
    updateEmptyLabels()
    updateOpticalDots(animated: false)

    for vp in viewports where vp !== primaryViewport {
      vp.panel.orderFrontRegardless()
    }
    primaryViewport.panel.makeKeyAndOrderFront(nil)
    primaryViewport.panel.orderFrontRegardless()
    primaryViewport.panel.makeKey()
    NSApp.activate(ignoringOtherApps: true)
    _ = NSRunningApplication.current.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])

    if V15Motion.isEnabled {
      NSAnimationContext.runAnimationGroup({ ctx in
        ctx.duration = V15Tokens.Shell.enterDuration
        ctx.timingFunction = V15Tokens.Shell.enterCurve.timingFunction
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
      if !wasVisible {
        animateCardsArrivalStagger()
      }
    } else {
      for vp in viewports {
        vp.panel.setFrame(vp.descriptor.panelFrame, display: true)
        vp.panel.alphaValue = 1
      }
    }

    store.refreshItems()
    store.startLiveOrbitCapture()
    installOutsideClickMonitor()
  }

  func hide(restoreFocus: Bool = true) {
    guard state.visible || isAnyPanelVisible else { return }
    transitionToken += 1
    let token = transitionToken

    state.visible = false
    state.rememberScrollOffset(state.scrollOffset, for: state.activeFilter)
    store.stopLiveOrbitCapture()
    removeOutsideClickMonitor()
    cancelScrollAnimation()
    finalizeAllPendingReservations()
    particleEngine.stopAll()
    clearTransientInteractions()

    for vp in viewports {
      vp.ambientParticlesView.stop()
      vp.opticalDotsView.resetTransientState()
      vp.toastView.dismiss(immediate: true)
    }

    let appToRestore = restoreFocus ? previousApp : nil
    previousApp = nil

    let completeHide: () -> Void = {
      if let app = appToRestore, !app.isTerminated {
        _ = app.activate(options: [.activateIgnoringOtherApps])
      }
    }

    if V15Motion.isEnabled {
      let targets = viewports.map { ($0, $0.offscreenFrame()) }
      NSAnimationContext.runAnimationGroup({ ctx in
        ctx.duration = V15Tokens.Shell.exitDuration
        ctx.timingFunction = V15Tokens.Shell.exitCurve.timingFunction
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
        completeHide()
      })
    } else {
      for vp in viewports {
        vp.panel.orderOut(nil)
        vp.panel.alphaValue = 1
      }
      completeHide()
    }
  }

  // MARK: Store Events & Live Capture (§16.4, A40–A44)

  private func handleStoreEvent(_ event: LumenClipboardStore.ChangeEvent) {
    switch event {
    case .itemsUpdated:
      updateOpticalDots(animated: false)
      if suppressNextItemsUpdatedReconcile {
        suppressNextItemsUpdatedReconcile = false
      } else if state.visible {
        reconcileSlotsWithStore(filteredStoreItems())
      }

    case .itemsCaptured(let captured):
      handleLiveCapturedItems(captured)

    case .itemRestored(let restored, _):
      handleRestoredItem(restored)

    case .preferencesUpdated:
      applyThemeToAllViewports()
      if !V15Motion.isEnabled || !store.preferences.particles {
        finalizeAllPendingReservations()
        particleEngine.stopAll()
      }
      updateAllCardStates(animated: false)

    default:
      break
    }
  }

  private func handleLiveCapturedItems(_ captured: [LumenClipboardItem]) {
    updateOpticalDots(animated: true)
    // Never auto-pop Orbit when hidden, and never disturb Quick Look or steal focus (A43, A44)
    guard state.visible, !captured.isEmpty else { return }

    let filter = state.activeFilter
    let matching = captured.filter { filter == .all || $0.logicalCategory == filter }
    let nonMatching = captured.filter { filter != .all && $0.logicalCategory != filter }

    // Non-matching category: NEVER switch user's active filter; only pulse dot if visible (A41)
    for item in nonMatching {
      leftmostViewport.opticalDotsView.pulseCategoryDot(item.logicalCategory)
    }
    guard !matching.isEmpty else { return }

    suppressNextItemsUpdatedReconcile = true
    let wasEmpty = liveItems.isEmpty
    let oldGlobalX = captureLiveSlotGlobalXMap()
    let scrolledAway = state.scrollOffset > V15Tokens.Rail.preserveViewportScrollThreshold

    var insertedItems: [LumenClipboardItem] = []
    for item in matching.reversed() {
      if slots.contains(where: { $0.itemID == item.id }) { continue }
      slots.insert(.live(item), at: 0)
      insertedItems.append(item)
    }
    guard !insertedItems.isEmpty else { return }

    // Preserve existing selectedClipID; select new clip ONLY if list was previously empty (A40)
    if wasEmpty || state.selectedClipID == nil {
      state.selectedClipID = insertedItems.last?.id ?? liveItems.first?.id
    }

    // Preserve scrolled viewport anchor when user is browsing older items (A41)
    if scrolledAway {
      let addedSpan = CGFloat(insertedItems.count) * (state.cardWidth + V15Tokens.Rail.gap)
      state.scrollOffset = clampedScrollOffset(state.scrollOffset + addedSpan)
    }

    syncMountedCardSlices(animated: false)
    updateAllCardStates(animated: false)
    updateEmptyLabels()

    // Smoothly shift existing visible cards right when inserting at head (A40)
    if !scrolledAway && V15Motion.isEnabled {
      animateHorizontalShiftFrom(oldGlobalX: oldGlobalX, excludingIDs: Set(insertedItems.map(\.id)))
    }

    // Play 900ms soft capture aggregation ONLY when new item is visible in viewport (A40, A41)
    if !scrolledAway {
      for item in insertedItems {
        startCaptureAggregationIfVisible(for: item)
      }
    }
  }

  private func startCaptureAggregationIfVisible(for item: LumenClipboardItem) {
    guard let globalFrame = globalFrame(forSlotID: item.id) else { return }
    let visibleStart = state.scrollOffset
    let visibleEnd = visibleStart + totalViewportRailSpan
    guard globalFrame.maxX > visibleStart && globalFrame.minX < visibleEnd else { return }

    guard V15Motion.isEnabled else { return }

    if store.preferences.particles {
      let snapshot = captureSnapshot(forItemID: item.id)
      let swatchColor = item.logicalCategory == .color ? LumenClassifier.parseHexColor(item.effectiveText) : nil
      aggregatingIDs.insert(item.id)
      setMountedCardOpacity(itemID: item.id, opacity: 0)

      particleEngine.startCapture(
        itemID: item.id,
        category: item.logicalCategory,
        swatchColor: swatchColor,
        snapshot: snapshot,
        initialFrame: globalFrame,
        glowEnabled: store.preferences.glow,
        anchorProvider: { [weak self] in
          self?.globalFrame(forSlotID: item.id)
        },
        onFinished: { [weak self] in
          guard let self else { return }
          self.aggregatingIDs.remove(item.id)
          self.setMountedCardOpacity(itemID: item.id, opacity: 1)
        }
      )
    } else {
      // Particles off, motion on: gentle slide/fade entrance (300ms)
      for vp in viewports {
        guard let card = vp.mountedCards[item.id], let layer = card.layer else { continue }
        let anim = CABasicAnimation(keyPath: "transform.translation.y")
        anim.fromValue = 12.0
        anim.toValue = 0.0
        anim.duration = 0.30
        anim.timingFunction = CAMediaTimingFunction(controlPoints: 0.20, 0.80, 0.20, 1.00)
        layer.add(anim, forKey: "v15CaptureRise")

        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.0
        fade.toValue = 1.0
        fade.duration = 0.30
        layer.add(fade, forKey: "v15CaptureFade")
      }
    }
  }

  // MARK: Two-Phase Soft Dissolution & 420ms Reflow (§17.2, §18.4, A39, A49–A51, A65)

  private func removeCard(id: String) {
    guard let slotIdx = slots.firstIndex(where: {
      if case .live(let item) = $0 { return item.id == id }
      return false
    }) else { return }
    guard case .live(let item) = slots[slotIdx] else { return }

    // Clear hover/focus targeting this item immediately
    if hoveredCardID == id { hoveredCardID = nil }
    if case .card(let fid) = keyboardFocus, fid == id { keyboardFocus = .none }
    if case .closeButton(let fid) = keyboardFocus, fid == id { keyboardFocus = .none }

    let globalRect = globalFrame(forSlotID: id)
    let isVisibleInRail: Bool
    if let rect = globalRect {
      let visStart = state.scrollOffset
      let visEnd = visStart + totalViewportRailSpan
      isVisibleInRail = rect.maxX > visStart && rect.minX < visEnd
    } else {
      isVisibleInRail = false
    }

    // Advance logical selection to next available live item (or previous if last)
    let liveBefore = liveItems
    let liveIdx = liveBefore.firstIndex(where: { $0.id == id }) ?? 0
    let wasSelected = (state.selectedClipID == id)

    let useTwoPhase = V15Motion.isEnabled && isVisibleInRail && globalRect != nil
    let snapshot = useTwoPhase ? captureSnapshot(forItemID: id) : nil

    // Suppress close button & unmount live card immediately
    for vp in viewports {
      if let card = vp.mountedCards.removeValue(forKey: id) {
        card.setSuppressCloseForMotion(true)
        card.removeFromSuperview()
      }
    }
    aggregatingIDs.remove(id)
    particleEngine.cancelFieldTasks(forItemID: id)

    if useTwoPhase, let rect = globalRect {
      // Phase 1: Lock exact layout footprint in a non-interactive reservation slot
      // so right-hand cards NEVER change x coordinate until particles finish extinguishing!
      let reservation = V15OrbitReservationSlot(item: item, width: state.cardWidth, gap: V15Tokens.Rail.gap)
      slots[slotIdx] = .reservation(reservation)

      let swatchColor = item.logicalCategory == .color ? LumenClassifier.parseHexColor(item.effectiveText) : nil
      particleEngine.startDissolve(
        itemID: id,
        category: item.logicalCategory,
        swatchColor: swatchColor,
        snapshot: snapshot,
        initialFrame: rect,
        particlesEnabled: store.preferences.particles,
        glowEnabled: store.preferences.glow,
        anchorProvider: { [weak self] in
          self?.globalFrame(forSlotID: id)
        },
        onParticlesFinished: { [weak self, weak reservation] in
          guard let self, let reservation else { return }
          // Phase 2: Only after 920ms hold + tail particles extinguished -> 420ms continuous reflow
          self.beginReservationReflow(reservation)
        }
      )
    } else {
      // Reduce Motion or offscreen item: remove slot immediately without waiting for particles
      slots.remove(at: slotIdx)
    }

    // Update selection & indices immediately (store transaction decoupled from visual hold)
    let liveAfter = liveItems
    if wasSelected {
      state.selectedClipID = liveAfter.isEmpty ? nil : liveAfter[min(liveIdx, liveAfter.count - 1)].id
    }
    syncMountedCardSlices(animated: false)
    updateAllCardStates(animated: true)
    updateEmptyLabels()

    suppressNextItemsUpdatedReconcile = true
    store.deleteItem(id: id) { [weak self] result in
      guard let self else { return }
      self.updateOpticalDots(animated: false)
      if case .success = result {
        self.showToast(message: "已移除剪贴板记录", showUndo: self.store.canUndoDelete)
      }
    }
  }

  private func beginReservationReflow(_ reservation: V15OrbitReservationSlot) {
    guard slots.contains(where: {
      if case .reservation(let r) = $0 { return r === reservation }
      return false
    }) else { return }
    guard !reservation.isReflowing else { return }
    reservation.isReflowing = true

    let startW = reservation.width
    let startGap = reservation.gap

    reservation.reflowAnimID = particleEngine.startValueAnimation(
      duration: V15Tokens.Particles.dissolveReflowDuration,
      curve: V15Tokens.Particles.dissolveReflowCurve,
      onUpdate: { [weak self, weak reservation] progress in
        guard let self, let reservation else { return }
        let remaining = CGFloat(max(0.0, 1.0 - progress))
        reservation.width = startW * remaining
        reservation.gap = startGap * remaining
        self.state.scrollOffset = self.clampedScrollOffset(self.state.scrollOffset)
        self.syncMountedCardSlices(animated: false)
      },
      onFinish: { [weak self, weak reservation] in
        guard let self, let reservation else { return }
        self.slots.removeAll {
          if case .reservation(let r) = $0 { return r === reservation }
          return false
        }
        self.state.scrollOffset = self.clampedScrollOffset(self.state.scrollOffset)
        self.syncMountedCardSlices(animated: false)
        self.updateAllCardStates(animated: false)
        self.updateEmptyLabels()
      }
    )
  }

  private func finalizeAllPendingReservations() {
    var removedAny = false
    for slot in slots {
      if case .reservation(let res) = slot {
        particleEngine.cancelFieldTasks(forItemID: res.itemID)
        particleEngine.cancelValueAnimation(res.reflowAnimID)
        res.reflowAnimID = nil
        removedAny = true
      }
    }
    if removedAny {
      slots.removeAll {
        if case .reservation = $0 { return true }
        return false
      }
      state.scrollOffset = clampedScrollOffset(state.scrollOffset)
    }
  }

  // MARK: Undo Restoration (§3.4, §17.2, A09, A50)

  private func undoLastDelete() {
    let pendingTargetID = store.peekLastUndoItemID()
    store.undoLastDelete { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(let restored):
        // Cancel any lingering reservation keyed by old pre-reingest ID
        if let prevID = pendingTargetID, prevID != restored.id {
          self.cancelReservationAndReplaceIfNeeded(oldID: prevID, with: restored)
        }
        self.showToast(message: "已恢复记录", showUndo: self.store.canUndoDelete)
      case .failure(let err):
        self.showToast(message: err.localizedDescription, showUndo: false)
      }
    }
  }

  private func cancelReservationAndReplaceIfNeeded(oldID: String, with restored: LumenClipboardItem) {
    guard let idx = slots.firstIndex(where: {
      if case .reservation(let r) = $0 { return r.itemID == oldID }
      return false
    }) else { return }
    if case .reservation(let res) = slots[idx] {
      particleEngine.cancelFieldTasks(forItemID: res.itemID)
      particleEngine.cancelValueAnimation(res.reflowAnimID)
      res.reflowAnimID = nil
    }
    slots.remove(at: idx)
  }

  private func handleRestoredItem(_ restored: LumenClipboardItem) {
    updateOpticalDots(animated: true)
    guard state.visible else { return }

    let belongsToFilter = (state.activeFilter == .all) || (restored.logicalCategory == state.activeFilter)
    guard belongsToFilter else {
      // Cross-category undo: update counts & pulse dot without polluting current filter (A09)
      leftmostViewport.opticalDotsView.pulseCategoryDot(restored.logicalCategory)
      suppressNextItemsUpdatedReconcile = true
      return
    }
    suppressNextItemsUpdatedReconcile = true

    // Case 1: Undo during active dissolve or reflow -> reclaim original reservation slot in place (A50)
    if let resIdx = slots.firstIndex(where: {
      if case .reservation(let r) = $0 { return r.itemID == restored.id }
      return false
    }), case .reservation(let res) = slots[resIdx] {
      particleEngine.cancelFieldTasks(forItemID: res.itemID)
      particleEngine.cancelValueAnimation(res.reflowAnimID)
      res.reflowAnimID = nil
      slots[resIdx] = .live(restored)
      state.selectedClipID = restored.id
      syncMountedCardSlices(animated: false)
      updateAllCardStates(animated: true)
      updateEmptyLabels()
      startCaptureAggregationIfVisible(for: restored)
      scrollCardIntoView(itemID: restored.id, animated: true)
      return
    }

    // Case 2: Already finalized -> reinsert at original logical sequence position
    let oldGlobalX = captureLiveSlotGlobalXMap()
    let filtered = filteredStoreItems()
    let desiredLiveIndex = filtered.firstIndex(where: { $0.id == restored.id }) ?? 0

    if !slots.contains(where: { $0.itemID == restored.id }) {
      let insertionSlotIdx = slotIndex(forLiveIndex: desiredLiveIndex)
      slots.insert(.live(restored), at: insertionSlotIdx)
    }

    state.selectedClipID = restored.id
    syncMountedCardSlices(animated: false)
    updateAllCardStates(animated: true)
    updateEmptyLabels()
    if V15Motion.isEnabled {
      animateHorizontalShiftFrom(oldGlobalX: oldGlobalX, excludingIDs: [restored.id])
    }
    scrollCardIntoView(itemID: restored.id, animated: true)
    startCaptureAggregationIfVisible(for: restored)
  }

  // MARK: Category Switching & Optical Dots (§3.2, A05, A06, A20–A23)

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

  private func updateOpticalDots(animated: Bool) {
    leftmostViewport.opticalDotsView.updateState(
      active: state.activeFilter,
      counts: categoryCounts(),
      animated: animated
    )
  }

  private func selectCategory(_ next: LumenLogicalCategory) {
    guard next != state.activeFilter else { return }
    let allCats = LumenLogicalCategory.allCases
    let prevIdx = allCats.firstIndex(of: state.activeFilter) ?? 0
    let nextIdx = allCats.firstIndex(of: next) ?? 0
    let movingDown = nextIdx > prevIdx

    cancelScrollAnimation()
    finalizeAllPendingReservations()
    particleEngine.stopAll()
    playCategoryExitSlide(movingDown: movingDown)

    state.rememberScrollOffset(state.scrollOffset, for: state.activeFilter)
    state.activeFilter = next
    clearTransientInteractions(preserveDotsFocus: keyboardFocus == .dots)

    slots = filteredStoreItems(for: next).map { .live($0) }
    reconcileSelection()
    state.scrollOffset = clampedScrollOffset(state.savedScrollOffset(for: next))

    syncMountedCardSlices(animated: false)
    updateAllCardStates(animated: false)
    updateEmptyLabels()
    updateOpticalDots(animated: true)

    if let sel = state.selectedClipID {
      scrollCardIntoView(itemID: sel, animated: false)
    }
    playCategoryEnterSlide(movingDown: movingDown)
  }

  private func playCategoryExitSlide(movingDown: Bool) {
    guard V15Motion.isEnabled else { return }
    let dy: CGFloat = movingDown ? -V15Tokens.Rail.categoryExitOffsetY : V15Tokens.Rail.categoryExitOffsetY
    for vp in viewports {
      let rect = vp.railViewport.bounds
      guard rect.width > 1, rect.height > 1,
            let rep = vp.railViewport.bitmapImageRepForCachingDisplay(in: rect) else { continue }
      vp.railViewport.cacheDisplay(in: rect, to: rep)
      guard let cg = rep.cgImage else { continue }

      let ghost = CALayer()
      ghost.frame = vp.railViewport.frame
      ghost.contents = cg
      ghost.zPosition = 20
      vp.rootView.layer?.addSublayer(ghost)

      CATransaction.begin()
      CATransaction.setCompletionBlock {
        ghost.removeFromSuperlayer()
      }
      let move = CABasicAnimation(keyPath: "transform.translation.y")
      move.fromValue = 0.0
      move.toValue = dy
      move.duration = V15Tokens.Rail.categoryExitDuration
      move.timingFunction = V15Tokens.Rail.categoryExitCurve.timingFunction
      move.fillMode = .forwards
      move.isRemovedOnCompletion = false

      let fade = CABasicAnimation(keyPath: "opacity")
      fade.fromValue = 1.0
      fade.toValue = 0.0
      fade.duration = V15Tokens.Rail.categoryExitDuration
      fade.timingFunction = V15Tokens.Rail.categoryExitCurve.timingFunction
      fade.fillMode = .forwards
      fade.isRemovedOnCompletion = false

      ghost.add(move, forKey: "v15CatExitMove")
      ghost.add(fade, forKey: "v15CatExitFade")
      CATransaction.commit()
    }
  }

  private func playCategoryEnterSlide(movingDown: Bool) {
    guard V15Motion.isEnabled else { return }
    let fromY: CGFloat = movingDown ? V15Tokens.Rail.categoryEnterOffsetY : -V15Tokens.Rail.categoryEnterOffsetY
    for vp in viewports {
      guard let layer = vp.railViewport.layer else { continue }
      let move = CABasicAnimation(keyPath: "transform.translation.y")
      move.fromValue = fromY
      move.toValue = 0.0
      move.duration = V15Tokens.Rail.categoryEnterDuration
      move.timingFunction = V15Tokens.Rail.categoryEnterCurve.timingFunction

      let fade = CABasicAnimation(keyPath: "opacity")
      fade.fromValue = 0.0
      fade.toValue = 1.0
      fade.duration = V15Tokens.Rail.categoryEnterDuration
      fade.timingFunction = V15Tokens.Rail.categoryEnterCurve.timingFunction

      layer.removeAnimation(forKey: "v15CatEnterMove")
      layer.removeAnimation(forKey: "v15CatEnterFade")
      layer.add(move, forKey: "v15CatEnterMove")
      layer.add(fade, forKey: "v15CatEnterFade")
    }
  }

  // MARK: Multi-Display Viewport Construction & Hot-Plug (§4, A01–A04, A70)

  private func rebuildViewports(isShowing: Bool) {
    let descriptors = V15DisplayTopology.computeViewports()
    var existingByID: [String: V15OrbitViewport] = [:]
    for vp in viewports {
      existingByID[vp.descriptor.id] = vp
    }

    var nextList: [V15OrbitViewport] = []
    nextList.reserveCapacity(descriptors.count)

    for desc in descriptors {
      let vp: V15OrbitViewport
      if let reused = existingByID.removeValue(forKey: desc.id) {
        reused.applyDescriptor(desc)
        vp = reused
      } else {
        vp = V15OrbitViewport(descriptor: desc)
        wireViewport(vp)
        vp.particlesOverlay.attachEngine(particleEngine)
      }
      nextList.append(vp)
    }

    for obsolete in existingByID.values {
      obsolete.teardown()
    }

    viewports = nextList
    state.updateMetrics(for: descriptors)

    for vp in viewports {
      vp.particlesOverlay.attachEngine(particleEngine)
      if isShowing {
        vp.panel.setFrame(vp.descriptor.panelFrame, display: true)
      }
    }
  }

  private func handleDisplayTopologyChanged() {
    state.topologyRevision += 1
    state.animationEpoch += 1
    cancelScrollAnimation()
    finalizeAllPendingReservations()
    particleEngine.stopAll()

    let wasVisible = state.visible
    rebuildViewports(isShowing: wasVisible)
    applyThemeToAllViewports()
    state.scrollOffset = clampedScrollOffset(state.scrollOffset)

    if wasVisible {
      for vp in viewports {
        vp.panel.setFrame(vp.descriptor.panelFrame, display: true)
        vp.panel.alphaValue = 1
        vp.panel.orderFrontRegardless()
      }
      if !viewports.contains(where: \.panel.isKeyWindow) {
        primaryViewport.panel.makeKeyAndOrderFront(nil)
      }
      syncMountedCardSlices(animated: false)
      updateAllCardStates(animated: false)
      updateEmptyLabels()
      updateOpticalDots(animated: false)
    }
  }

  private func wireViewport(_ vp: V15OrbitViewport) {
    vp.panel.delegate = self
    vp.panel.onKeyEvent = { [weak self] event in self?.handleKeyDown(event) ?? false }
    vp.panel.onCancel = { [weak self] in self?.handleEscapeChain() }
    vp.toastView.onUndo = { [weak self] in self?.undoLastDelete() }
    vp.opticalDotsView.onSelectCategory = { [weak self] cat in self?.selectCategory(cat) }
    vp.railViewport.onShiftWheel = { [weak self] event in
      self?.leftmostViewport.opticalDotsView.handleTypeWheel(event)
    }
    vp.railViewport.onScrollDelta = { [weak self] delta in
      self?.scrollByDelta(delta)
    }
    vp.railViewport.onDragPanBegan = { [weak self] in
      self?.cancelScrollAnimation()
      return self?.state.scrollOffset ?? 0
    }
    vp.railViewport.onDragPanMoved = { [weak self] nextOffset in
      self?.setGlobalScrollOffset(nextOffset, animated: false)
    }
    vp.railViewport.onPointerMovedX = { [weak vp] localX in
      guard let vp else { return }
      let offset = vp.descriptor.showsOpticalDots ? V15Tokens.Rail.leftShiftForDots : 0
      vp.backdropView.updatePointerX(offset + localX)
    }
  }

  private func applyThemeToAllViewports() {
    let isDark = V15Motion.isDarkTheme
    let particles = store.preferences.particles
    let glow = store.preferences.glow
    for vp in viewports {
      vp.applyAppearance(isDark: isDark, particlesEnabled: particles, glowEnabled: glow, isVisible: state.visible)
      for card in vp.mountedCards.values {
        if let idx = liveItems.firstIndex(where: { $0.id == card.item.id }) {
          card.update(item: card.item, slotIndex: idx, isDark: isDark, glowEnabled: glow)
        }
      }
    }
  }

  // MARK: Global Rail Geometry, Virtualization & Scroll Sync (A01–A03, A17)

  private func computeGlobalSlotGeometry() -> (frames: [CGRect], totalSpan: CGFloat) {
    var frames: [CGRect] = []
    frames.reserveCapacity(slots.count)
    var cursorX = V15Tokens.Rail.paddingLeft
    let y = state.cardOriginY

    for (idx, slot) in slots.enumerated() {
      let w: CGFloat
      let g: CGFloat
      switch slot {
      case .live:
        w = state.cardWidth
        g = (idx < slots.count - 1) ? V15Tokens.Rail.gap : 0
      case .reservation(let res):
        w = res.width
        g = (idx < slots.count - 1) ? res.gap : 0
      }
      frames.append(CGRect(x: cursorX, y: y, width: w, height: state.cardHeight))
      cursorX += w + g
    }
    let totalSpan = cursorX + V15Tokens.Rail.paddingRight
    return (frames, totalSpan)
  }

  private func globalFrame(forSlotID itemID: String) -> CGRect? {
    guard let idx = slots.firstIndex(where: { $0.itemID == itemID }) else { return nil }
    let (frames, _) = computeGlobalSlotGeometry()
    guard idx < frames.count else { return nil }
    let raw = frames[idx]
    return CGRect(x: raw.minX - state.scrollOffset, y: raw.minY, width: raw.width, height: raw.height)
  }

  private func maxScrollOffset(forTotalSpan totalSpan: CGFloat? = nil) -> CGFloat {
    let span = totalSpan ?? computeGlobalSlotGeometry().totalSpan
    return max(0, span - totalViewportRailSpan)
  }

  private func clampedScrollOffset(_ proposed: CGFloat, totalSpan: CGFloat? = nil) -> CGFloat {
    max(0, min(maxScrollOffset(forTotalSpan: totalSpan), proposed))
  }

  private func scrollByDelta(_ delta: CGFloat) {
    cancelScrollAnimation()
    setGlobalScrollOffset(state.scrollOffset + delta, animated: false)
  }

  private func setGlobalScrollOffset(_ target: CGFloat, animated: Bool) {
    let clamped = clampedScrollOffset(target)
    if !animated || !V15Motion.isEnabled || abs(clamped - state.scrollOffset) < 0.5 {
      state.scrollOffset = clamped
      syncMountedCardSlices(animated: false)
      return
    }
    cancelScrollAnimation()
    let start = state.scrollOffset
    scrollAnimID = particleEngine.startValueAnimation(
      duration: 0.28,
      curve: V15CubicBezier(x1: 0.18, y1: 0.85, x2: 0.25, y2: 1.00),
      onUpdate: { [weak self] p in
        guard let self else { return }
        self.state.scrollOffset = start + (clamped - start) * CGFloat(p)
        self.syncMountedCardSlices(animated: false)
      },
      onFinish: { [weak self] in
        guard let self else { return }
        self.state.scrollOffset = clamped
        self.scrollAnimID = nil
        self.syncMountedCardSlices(animated: false)
      }
    )
  }

  private func cancelScrollAnimation() {
    particleEngine.cancelValueAnimation(scrollAnimID)
    scrollAnimID = nil
  }

  private func scrollCardIntoView(itemID: String, animated: Bool) {
    guard let idx = slots.firstIndex(where: { $0.itemID == itemID }) else { return }
    let (frames, totalSpan) = computeGlobalSlotGeometry()
    guard idx < frames.count else { return }
    let rect = frames[idx]
    let visLeft = state.scrollOffset
    let visRight = visLeft + totalViewportRailSpan

    var target = state.scrollOffset
    if rect.minX < visLeft + 18 {
      target = rect.minX - V15Tokens.Rail.paddingRight
    } else if rect.maxX > visRight - 18 {
      target = rect.maxX - totalViewportRailSpan + V15Tokens.Rail.paddingRight
    } else {
      return
    }
    setGlobalScrollOffset(clampedScrollOffset(target, totalSpan: totalSpan), animated: animated)
  }

  /// Mounts ONLY the live card slices intersecting each display's `railRange` (with 1-card buffer),
  /// positioning each at `localX = (globalX - scrollOffset) - railRange.lowerBound`.
  private func syncMountedCardSlices(animated: Bool) {
    let (frames, totalSpan) = computeGlobalSlotGeometry()
    state.scrollOffset = clampedScrollOffset(state.scrollOffset, totalSpan: totalSpan)

    let isDark = V15Motion.isDarkTheme
    let glow = store.preferences.glow
    let margin = state.cardWidth + V15Tokens.Rail.gap

    var liveIndexByID: [String: Int] = [:]
    var liveCounter = 0
    for slot in slots {
      if case .live(let item) = slot {
        liveIndexByID[item.id] = liveCounter
        liveCounter += 1
      }
    }

    for vp in viewports {
      let range = vp.descriptor.railRange
      var activeIDs: Set<String> = []

      for (idx, slot) in slots.enumerated() {
        guard case .live(let item) = slot, idx < frames.count else { continue }
        let globalRect = frames[idx]
        let scrolledMinX = globalRect.minX - state.scrollOffset
        let scrolledMaxX = globalRect.maxX - state.scrollOffset

        guard scrolledMaxX >= range.lowerBound - margin && scrolledMinX <= range.upperBound + margin else {
          continue
        }

        let localFrame = NSRect(
          x: scrolledMinX - range.lowerBound,
          y: globalRect.minY,
          width: globalRect.width,
          height: globalRect.height
        )
        let liveIdx = liveIndexByID[item.id] ?? 0
        activeIDs.insert(item.id)

        if let existing = vp.mountedCards[item.id] {
          existing.frame = localFrame
          existing.update(item: item, slotIndex: liveIdx, isDark: isDark, glowEnabled: glow)
          existing.alphaValue = aggregatingIDs.contains(item.id) ? 0 : 1
        } else {
          let card = V15OrbitCardItemView(item: item, frame: localFrame)
          card.update(item: item, slotIndex: liveIdx, isDark: isDark, glowEnabled: glow)
          card.alphaValue = aggregatingIDs.contains(item.id) ? 0 : 1
          wireCard(card)
          vp.railViewport.addSubview(card)
          vp.mountedCards[item.id] = card
        }
      }

      // Recycle off-screen slices for virtualization (A17)
      let staleIDs = vp.mountedCards.keys.filter { !activeIDs.contains($0) }
      for stale in staleIDs {
        vp.mountedCards.removeValue(forKey: stale)?.removeFromSuperview()
      }
    }

    updateAllCardStates(animated: animated)
  }

  private func wireCard(_ card: V15OrbitCardItemView) {
    card.onHoverChanged = { [weak self] itemID, entered in
      self?.handleCardHoverChanged(itemID: itemID, entered: entered)
    }
    card.onPasteRequested = { [weak self] itemID in
      self?.pasteAndDismiss(id: itemID)
    }
    card.onRemoveRequested = { [weak self] itemID in
      self?.removeCard(id: itemID)
    }
    card.onContextMenuRequested = { [weak self] itemID, event, anchorView in
      self?.presentContextMenu(for: itemID, event: event, anchorView: anchorView)
    }
  }

  private func updateAllCardStates(animated: Bool) {
    let live = liveItems
    let selIdx = live.firstIndex(where: { $0.id == state.selectedClipID })

    for vp in viewports {
      for (id, card) in vp.mountedCards {
        let idx = live.firstIndex(where: { $0.id == id })
        let isSelected = (id == state.selectedClipID)
        let isNear = selIdx.flatMap { s in idx.map { abs($0 - s) == 1 } } ?? false
        let isHovered = (id == hoveredCardID)
        let isKeyCard = (keyboardFocus == .card(id))
        let isKeyClose = (keyboardFocus == .closeButton(id))

        card.layer?.zPosition = isSelected ? 3 : (isHovered || isKeyCard || isKeyClose ? 2 : 1)
        card.setInteractionState(
          selected: isSelected,
          near: isNear,
          hovered: isHovered,
          keyboardCardFocused: isKeyCard,
          keyboardCloseFocused: isKeyClose,
          animated: animated
        )
      }
    }
  }

  private func handleCardHoverChanged(itemID: String, entered: Bool) {
    if entered {
      hoverClearWork?.cancel()
      hoverClearWork = nil
      if hoveredCardID != itemID {
        hoveredCardID = itemID
        // Following HTML line 272: hovering a card smoothly aligns selection focus to hovered card
        if state.selectedClipID != itemID {
          state.selectedClipID = itemID
        }
        updateAllCardStates(animated: true)
      }
    } else if hoveredCardID == itemID {
      // 36ms bezel-crossing coalescing prevents flicker when pointer crosses a display seam
      hoverClearWork?.cancel()
      let work = DispatchWorkItem { [weak self] in
        guard let self, self.hoveredCardID == itemID else { return }
        self.hoveredCardID = nil
        self.updateAllCardStates(animated: true)
      }
      hoverClearWork = work
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.036, execute: work)
    }
  }

  private func reconcileSlotsWithStore(_ storeItems: [LumenClipboardItem]) {
    var nextSlots: [V15OrbitRailSlot] = []
    let reservationByID: [String: V15OrbitReservationSlot] = Dictionary(
      uniqueKeysWithValues: slots.compactMap { slot in
        if case .reservation(let r) = slot { return (r.itemID, r) }
        return nil
      }
    )

    // Keep live items in store order while preserving any active visual reservations in-place
    let pendingReservations = slots.enumerated().compactMap { (idx, slot) -> (Int, V15OrbitReservationSlot)? in
      if case .reservation(let r) = slot { return (idx, r) }
      return nil
    }
    let filteredStore = storeItems.filter { reservationByID[$0.id] == nil }

    for item in filteredStore {
      nextSlots.append(.live(item))
    }
    for (origIdx, res) in pendingReservations {
      let target = max(0, min(nextSlots.count, origIdx))
      nextSlots.insert(.reservation(res), at: target)
    }

    slots = nextSlots
    reconcileSelection()
    syncMountedCardSlices(animated: false)
    updateEmptyLabels()
  }

  private func reconcileSelection() {
    let live = liveItems
    if let sel = state.selectedClipID, live.contains(where: { $0.id == sel }) {
      return
    }
    state.selectedClipID = live.first?.id
  }

  private func updateEmptyLabels() {
    let isEmpty = slots.isEmpty
    for vp in viewports {
      vp.railViewport.emptyLabel.isHidden = !(isEmpty && vp === primaryViewport)
    }
  }

  private func animateCardsArrivalStagger() {
    guard V15Motion.isEnabled else { return }
    let live = liveItems
    for vp in viewports {
      for (id, card) in vp.mountedCards {
        guard let idx = live.firstIndex(where: { $0.id == id }), let layer = card.layer else { continue }
        let clampedIdx = min(idx, V15Tokens.Shell.cardArrivalMaxStaggerIndex)
        let delay = TimeInterval(clampedIdx) * V15Tokens.Shell.cardArrivalStagger
        let beginTime = CACurrentMediaTime() + delay

        let move = CABasicAnimation(keyPath: "transform.translation.y")
        move.fromValue = V15Tokens.Shell.cardArrivalOffsetY
        move.toValue = 0.0
        move.duration = V15Tokens.Shell.cardArrivalDuration
        move.beginTime = beginTime
        move.timingFunction = V15Tokens.Shell.cardArrivalCurve.timingFunction
        move.fillMode = .backwards

        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.0
        fade.toValue = 1.0
        fade.duration = V15Tokens.Shell.cardArrivalDuration
        fade.beginTime = beginTime
        fade.timingFunction = V15Tokens.Shell.cardArrivalCurve.timingFunction
        fade.fillMode = .backwards

        layer.add(move, forKey: "v15ArrivalMove")
        layer.add(fade, forKey: "v15ArrivalFade")
      }
    }
  }

  private func captureLiveSlotGlobalXMap() -> [String: CGFloat] {
    let (frames, _) = computeGlobalSlotGeometry()
    var map: [String: CGFloat] = [:]
    for (idx, slot) in slots.enumerated() where idx < frames.count {
      if case .live(let item) = slot {
        map[item.id] = frames[idx].minX - state.scrollOffset
      }
    }
    return map
  }

  private func animateHorizontalShiftFrom(oldGlobalX: [String: CGFloat], excludingIDs: Set<String>) {
    let (frames, _) = computeGlobalSlotGeometry()
    var newGlobalX: [String: CGFloat] = [:]
    for (idx, slot) in slots.enumerated() where idx < frames.count {
      if case .live(let item) = slot {
        newGlobalX[item.id] = frames[idx].minX - state.scrollOffset
      }
    }

    for vp in viewports {
      for (id, card) in vp.mountedCards {
        guard !excludingIDs.contains(id),
              let prevX = oldGlobalX[id],
              let nextX = newGlobalX[id],
              let layer = card.layer else { continue }
        let dx = prevX - nextX
        guard abs(dx) > 0.5 else { continue }
        let anim = CABasicAnimation(keyPath: "transform.translation.x")
        anim.fromValue = dx
        anim.toValue = 0.0
        anim.duration = V15Tokens.Particles.captureReflowDuration
        anim.timingFunction = V15Tokens.Particles.captureReflowCurve.timingFunction
        layer.removeAnimation(forKey: "v15ReflowShiftX")
        layer.add(anim, forKey: "v15ReflowShiftX")
      }
    }
  }

  private func captureSnapshot(forItemID itemID: String) -> CGImage? {
    for vp in viewports {
      if let card = vp.mountedCards[itemID], let cg = card.captureSnapshotImage() {
        return cg
      }
    }
    return nil
  }

  private func setMountedCardOpacity(itemID: String, opacity: CGFloat) {
    for vp in viewports {
      vp.mountedCards[itemID]?.alphaValue = opacity
    }
  }

  private func slotIndex(forLiveIndex desiredLiveIdx: Int) -> Int {
    var seenLive = 0
    for (idx, slot) in slots.enumerated() {
      if seenLive >= desiredLiveIdx { return idx }
      if case .live = slot { seenLive += 1 }
    }
    return slots.count
  }

  private func clearTransientInteractions(preserveDotsFocus: Bool = false) {
    hoverClearWork?.cancel()
    hoverClearWork = nil
    hoveredCardID = nil
    if !preserveDotsFocus {
      keyboardFocus = .none
      leftmostViewport.opticalDotsView.clearKeyboardFocus()
    }
  }

  // MARK: Paste, Toast & Native Context Menu

  private func pasteAndDismiss(id: String) {
    state.selectedClipID = id
    for vp in viewports {
      vp.mountedCards[id]?.playPasteConfirmation()
    }
    store.copyToOSClipboard(id: id) { [weak self] result in
      guard let self else { return }
      switch result {
      case .success:
        self.hide(restoreFocus: true)
      case .failure(let err):
        for vp in self.viewports {
          vp.mountedCards[id]?.resetPasteConfirmation()
        }
        self.syncMountedCardSlices(animated: false)
        self.showToast(message: "复制失败：\(err.localizedDescription)", showUndo: false)
      }
    }
  }

  private func showToast(message: String, showUndo: Bool) {
    let pointer = NSEvent.mouseLocation
    let target = viewports.first(where: { NSMouseInRect(pointer, $0.descriptor.screenFrame, false) }) ?? primaryViewport
    for vp in viewports where vp !== target {
      vp.toastView.dismiss(immediate: true)
    }
    target.toastView.show(message: message, showUndo: showUndo)
  }

  private func presentContextMenu(for id: String, event: NSEvent, anchorView: NSView) {
    state.selectedClipID = id
    updateAllCardStates(animated: false)

    let menu = NSMenu(title: "Orbit 卡片")
    let pasteItem = NSMenuItem(title: "复制到剪贴板 (↵)", action: #selector(menuPaste(_:)), keyEquivalent: "")
    pasteItem.target = self
    pasteItem.representedObject = id
    menu.addItem(pasteItem)

    let peekItem = NSMenuItem(title: "完整预览 (Space)", action: #selector(menuPeek(_:)), keyEquivalent: "")
    peekItem.target = self
    peekItem.representedObject = id
    menu.addItem(peekItem)

    let isPinned = store.items.first(where: { $0.id == id })?.pinned == true
    let pinItem = NSMenuItem(title: isPinned ? "取消固定" : "固定记录", action: #selector(menuPin(_:)), keyEquivalent: "")
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
      openQuickLook(for: id)
    }
  }

  @objc private func menuPin(_ sender: NSMenuItem) {
    if let id = sender.representedObject as? String {
      store.togglePin(id: id)
    }
  }

  @objc private func menuOpenWorkspace(_ sender: NSMenuItem) {
    let targetID = (sender.representedObject as? String) ?? state.selectedClipID
    openWorkspacePreservingSelection(targetID)
  }

  @objc private func menuRemove(_ sender: NSMenuItem) {
    if let id = sender.representedObject as? String { removeCard(id: id) }
  }

  private func openQuickLook(for id: String) {
    let queue = filteredStoreItems()
    guard !queue.isEmpty else { return }
    LumenPreviewWindow.shared.open(clipboardItems: queue, initialID: id)
  }

  private func openWorkspacePreservingSelection(_ id: String?) {
    hide(restoreFocus: false)
    if let handler = onOpenWorkspaceWithSelection {
      handler(id)
    } else {
      onOpenWorkspace?()
    }
  }

  // MARK: Full README §3.3 Keyboard Map & Accessibility Traversal

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

    // ⌥V or ⌘⌥V toggles Orbit off (§3.3)
    if (mods == .option || mods == [.command, .option]), event.keyCode == 9 {
      hide(restoreFocus: true)
      return true
    }

    // ⌘Z Undo (§3.3, A09, A50)
    if mods == .command, event.charactersIgnoringModifiers?.lowercased() == "z" {
      if store.canUndoDelete {
        undoLastDelete()
      }
      return true
    }

    // ⌥Enter opens Native Library preserving selected record identity (§3.3, A21)
    if mods == .option, (event.keyCode == 36 || event.keyCode == 76) {
      openWorkspacePreservingSelection(state.selectedClipID)
      return true
    }

    if mods.contains(.command) || mods.contains(.option) || mods.contains(.control) {
      return false
    }

    let dots = leftmostViewport.opticalDotsView

    switch event.keyCode {
    case 53: // Esc chain: menu -> preview -> Orbit
      handleEscapeChain()
      return true

    case 48: // Tab / Shift+Tab cycles focus across Optical Dots <-> Card <-> Close Button (§19.1)
      cycleKeyboardFocus(reverse: mods.contains(.shift))
      return true

    case 126: // Up Arrow -> previous category (or dot keyboard focus up)
      if keyboardFocus == .dots {
        dots.moveKeyboardFocus(by: -1)
      } else {
        dots.stepCategory(by: -1)
      }
      return true

    case 125: // Down Arrow -> next category (or dot keyboard focus down)
      if keyboardFocus == .dots {
        dots.moveKeyboardFocus(by: 1)
      } else {
        dots.stepCategory(by: 1)
      }
      return true

    case 123: // Left Arrow -> previous card
      stepCardSelection(-1)
      return true

    case 124: // Right Arrow -> next card
      stepCardSelection(1)
      return true

    case 115: // Home -> first card in current category
      if let first = liveItems.first {
        selectCardByKeyboard(first.id)
      }
      return true

    case 119: // End -> last card in current category
      if let last = liveItems.last {
        selectCardByKeyboard(last.id)
      }
      return true

    case 36, 76: // Enter -> activate focused dot OR remove focused X OR paste selected card
      switch keyboardFocus {
      case .dots:
        _ = dots.activateFocusedDot()
      case .closeButton(let targetID):
        removeCard(id: targetID)
      case .card(let targetID):
        pasteAndDismiss(id: targetID)
      case .none:
        if let id = state.selectedClipID {
          pasteAndDismiss(id: id)
        }
      }
      return true

    case 49: // Space -> activate focused dot OR remove focused X OR open Quick Look
      switch keyboardFocus {
      case .dots:
        _ = dots.activateFocusedDot()
        return true
      case .closeButton(let targetID):
        removeCard(id: targetID)
        return true
      case .card(let targetID):
        openQuickLook(for: targetID)
        return true
      case .none:
        if let id = state.selectedClipID {
          openQuickLook(for: id)
          return true
        }
        return false
      }

    case 51, 117: // Delete / Backspace -> remove selected record without closing Orbit
      if keyboardFocus == .dots { return true }
      if let id = state.selectedClipID {
        removeCard(id: id)
      }
      return true

    default:
      // 1–9 quick paste for first 9 cards in active category (§3.3)
      if keyboardFocus != .dots,
         let chars = event.charactersIgnoringModifiers, chars.count == 1,
         let digit = Int(chars), digit >= 1 && digit <= 9 {
        let live = liveItems
        if digit - 1 < live.count {
          let target = live[digit - 1]
          state.selectedClipID = target.id
          scrollCardIntoView(itemID: target.id, animated: true)
          pasteAndDismiss(id: target.id)
          return true
        }
      }
      return false
    }
  }

  private func cycleKeyboardFocus(reverse: Bool) {
    let dots = leftmostViewport.opticalDotsView
    let currentCardID = state.selectedClipID ?? liveItems.first?.id

    switch keyboardFocus {
    case .none:
      if reverse {
        dots.focusActiveDot()
        keyboardFocus = .dots
      } else if let id = currentCardID {
        dots.clearKeyboardFocus()
        keyboardFocus = .card(id)
        scrollCardIntoView(itemID: id, animated: true)
      } else {
        dots.focusActiveDot()
        keyboardFocus = .dots
      }

    case .card(let id):
      if reverse {
        dots.focusActiveDot()
        keyboardFocus = .dots
      } else {
        dots.clearKeyboardFocus()
        keyboardFocus = .closeButton(id)
      }

    case .closeButton(let id):
      if reverse {
        dots.clearKeyboardFocus()
        keyboardFocus = .card(id)
      } else {
        dots.focusActiveDot()
        keyboardFocus = .dots
      }

    case .dots:
      dots.clearKeyboardFocus()
      if let id = currentCardID {
        keyboardFocus = reverse ? .closeButton(id) : .card(id)
        scrollCardIntoView(itemID: id, animated: true)
      } else {
        keyboardFocus = .none
      }
    }
    updateAllCardStates(animated: true)
  }

  private func stepCardSelection(_ delta: Int) {
    let live = liveItems
    guard !live.isEmpty else { return }
    let idx = live.firstIndex(where: { $0.id == state.selectedClipID }) ?? 0
    let next = max(0, min(live.count - 1, idx + delta))
    selectCardByKeyboard(live[next].id)
  }

  private func selectCardByKeyboard(_ id: String) {
    leftmostViewport.opticalDotsView.clearKeyboardFocus()
    state.selectedClipID = id
    keyboardFocus = .card(id)
    scrollCardIntoView(itemID: id, animated: true)
    updateAllCardStates(animated: true)
  }

  // MARK: Global Outside-Click Dismiss Monitor

  private func installOutsideClickMonitor() {
    removeOutsideClickMonitor()
    outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
      guard let self, self.state.visible, !self.isContextMenuOpen else { return }
      if LumenPreviewWindow.shared.isVisible { return }
      let pt = NSEvent.mouseLocation
      let insideAnyPanel = self.viewports.contains(where: { $0.panel.isVisible && NSMouseInRect(pt, $0.panel.frame, false) })
      if !insideAnyPanel {
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
