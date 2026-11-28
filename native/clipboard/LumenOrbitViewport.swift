import AppKit
import Foundation
import QuartzCore

// MARK: - Shared Multi-Display Logical Rail State (§4, §14.2, A01–A04, A70)

/// Single source of truth for the Orbit rail across one or more participating bottom viewports.
/// Every `OrbitViewport` renders only the local coordinate slice of this shared state —
/// logical clip IDs, scroll position, active filter, selection, and animation clock are never duplicated.
struct OrbitRailState {
  var visible = false
  var edgePosition = "bottom"
  var activeFilter: LumenLogicalCategory = .all
  var selectedClipID: String?
  var scrollOffset: CGFloat = 0
  var perFilterOffsets: [LumenLogicalCategory: CGFloat] = [:]
  var topologyRevision = 0
  var animationEpoch = 0

  var cardWidth: CGFloat = 196
  var cardHeight: CGFloat = 216
  var cardGap: CGFloat = 12
  var opticalDotsWidth: CGFloat = LumenV15Tokens.opticalDotsColumnWidth
  var railLeadingInset: CGFloat = 12
  var railTrailingInset: CGFloat = 24
  var railTopInset: CGFloat = 22
  var railBottomInset: CGFloat = 14

  var isHorizontalRail: Bool {
    edgePosition == "bottom"
  }

  /// Updates unified DIP card dimensions from the active viewport group.
  /// All participating displays share identical DIP cardWidth/cardHeight/cardGap so cards
  /// stitch seamlessly across monitor seams even under mixed backingScaleFactor (1x / 2x).
  mutating func updateMetrics(for descriptors: [OrbitViewportDescriptor]) {
    guard let reference = descriptors.first(where: { $0.isPrimaryViewport }) ?? descriptors.first else { return }
    if isHorizontalRail {
      let commonH = descriptors.map { $0.panelFrame.height }.min() ?? reference.panelFrame.height
      cardHeight = min(232, max(172, commonH - railTopInset - railBottomInset))
      // Derive logical card width from primary screen's width (not summed width) so cards keep
      // comfortable proportions whether 1, 2, 3, or N screens participate.
      cardWidth = min(222, max(178, round(reference.panelFrame.width * 0.142)))
      cardGap = 12
    } else {
      cardWidth = max(196, reference.panelFrame.width - 28)
      cardHeight = 192
      cardGap = 12
    }
  }

  mutating func rememberScrollOffset(_ offset: CGFloat, for filter: LumenLogicalCategory) {
    scrollOffset = max(0, offset)
    perFilterOffsets[filter] = scrollOffset
  }

  func savedScrollOffset(for filter: LumenLogicalCategory) -> CGFloat {
    perFilterOffsets[filter] ?? 0
  }
}

// MARK: - Normalized Logical Screen Geometry & Viewport Descriptor

/// Platform-normalized logical display geometry (DIP / macOS points).
/// AppKit's `NSScreen.frame` and `NSScreen.visibleFrame` already express coordinates in a single
/// global DIP plane with +Y pointing upward, normalizing heterogeneous DPI scales (1x/2x/scaled).
struct OrbitScreenGeometry: Equatable {
  let id: String
  let frame: NSRect
  let visibleFrame: NSRect
  let backingScaleFactor: CGFloat
  let isMainScreen: Bool

  init(screen: NSScreen, fallbackIndex: Int, isMainScreen: Bool) {
    self.id = OrbitDisplayTopology.screenIdentifier(screen, fallbackIndex: fallbackIndex)
    self.frame = screen.frame
    self.visibleFrame = screen.visibleFrame
    self.backingScaleFactor = screen.backingScaleFactor
    self.isMainScreen = isMainScreen
  }

  init(id: String, frame: NSRect, visibleFrame: NSRect, backingScaleFactor: CGFloat = 2.0, isMainScreen: Bool = false) {
    self.id = id
    self.frame = frame
    self.visibleFrame = visibleFrame
    self.backingScaleFactor = backingScaleFactor
    self.isMainScreen = isMainScreen
  }
}

/// Logical viewport slice assigned to one participating physical display.
struct OrbitViewportDescriptor: Equatable {
  let id: String
  let viewportIndex: Int
  let totalViewportCount: Int
  let screenFrame: NSRect
  let visibleFrame: NSRect
  let panelFrame: NSRect
  /// Global card-rail coordinate interval rendered by this viewport's `railViewport`:
  /// - Viewport 0 (leftmost, bottom mode) starts at 0 and spans `panelFrame.width - opticalDotsWidth`.
  /// - Subsequent bottom viewports start where the previous ended and span their full `panelFrame.width`.
  /// - Card local X inside `railViewport` = `(globalCardOriginX - scrollOffset) - railRange.lowerBound`.
  let railRange: ClosedRange<CGFloat>
  let backingScaleFactor: CGFloat
  let showsOpticalDots: Bool
  let isPrimaryViewport: Bool

  var railSpanWidth: CGFloat {
    max(0, railRange.upperBound - railRange.lowerBound)
  }
}

// MARK: - Multi-Display Bottom-Row Contiguous Topology Algorithm (§4, A01–A04, A70)

/// Explicit, deterministic display topology selector for Paste Lumen V15 multi-screen Orbit.
///
/// Rules (§4, §14.2, A01–A04):
/// 1. **Bottom-edge exposure**: Exclude any display whose bottom edge is occluded underneath
///    by another display (e.g., upper row of vertical 1×2, 2×2, 2×3, or stacked layouts).
/// 2. **Bottom-most row & horizontal contiguity**: Partition bottom-exposed displays into
///    horizontally contiguous groups whose physical side edges touch (within 32 DIP tolerance
///    for mixed-DPI logical rounding) and whose bottom edges stay aligned enough to form a
///    continuous bottom rail (within 140 DIP bottom-edge step tolerance and overlapping rail bands).
///    Never bridge across empty non-screen space and NEVER mirror the same rail across disconnected groups.
/// 3. **Winning group selection**: If multiple disconnected groups exist, prefer the group
///    containing the active/pointer screen; otherwise choose the group with the largest combined
///    horizontal logical span (tie-breaking by main screen, then leftmost origin).
/// 4. **Mixed DPI & macOS Separate Spaces**: Coordinates are normalized in AppKit logical points (DIP).
///    Each participating display receives its own independent borderless floating `NSPanel` configured
///    with `.canJoinAllSpaces` and `.fullScreenAuxiliary`, so under `NSScreen.screensHaveSeparateSpaces`
///    every participating display renders its slice on its own active Space without Space-switching
///    or WindowServer cross-screen clipping.
enum OrbitDisplayTopology {
  /// Horizontal gap tolerance (DIP) between adjacent screen edges to absorb mixed-DPI rounding.
  static let horizontalContiguityTolerance: CGFloat = 32
  /// Maximum vertical step (DIP) between two bottom edges to still qualify as one continuous bottom rail.
  static let bottomEdgeAlignmentTolerance: CGFloat = 140
  /// Minimum horizontal overlap ratio (of narrower screen) for a lower display to occlude an upper display.
  static let verticalOcclusionOverlapRatio: CGFloat = 0.25

  static func normalizePosition(_ raw: String) -> String {
    switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "left": return "left"
    case "right": return "right"
    default: return "bottom"
    }
  }

  static func screenIdentifier(_ screen: NSScreen, fallbackIndex: Int) -> String {
    if let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
      return "display-\(number.uint32Value)"
    }
    return "display-\(fallbackIndex)"
  }

  static func activeScreen(from screens: [NSScreen] = NSScreen.screens) -> NSScreen? {
    let pointer = NSEvent.mouseLocation
    if let match = screens.first(where: { NSMouseInRect(pointer, $0.frame, false) }) {
      return match
    }
    return NSScreen.main ?? screens.first
  }

  static func geometries(from screens: [NSScreen] = NSScreen.screens) -> [OrbitScreenGeometry] {
    let mainFrame = NSScreen.main?.frame
    return screens.enumerated().map { idx, screen in
      OrbitScreenGeometry(
        screen: screen,
        fallbackIndex: idx,
        isMainScreen: mainFrame.map { $0 == screen.frame } ?? (idx == 0)
      )
    }
  }

  /// Step 1: Returns `true` iff `candidate` has NO other display positioned underneath it
  /// overlapping its horizontal span (AppKit coordinates: smaller `minY` is lower on screen).
  static func isBottomEdgeExposed(_ candidate: OrbitScreenGeometry, among all: [OrbitScreenGeometry]) -> Bool {
    for other in all where other.id != candidate.id {
      // `other` must sit strictly lower than `candidate`
      let isBelow = other.frame.minY < candidate.frame.minY - 1 && other.frame.midY < candidate.frame.midY
      guard isBelow else { continue }
      let overlapMinX = max(candidate.frame.minX, other.frame.minX)
      let overlapMaxX = min(candidate.frame.maxX, other.frame.maxX)
      let overlapWidth = overlapMaxX - overlapMinX
      let threshold = min(candidate.frame.width, other.frame.width) * verticalOcclusionOverlapRatio
      if overlapWidth >= threshold {
        return false
      }
    }
    return true
  }

  /// Step 2: Extracts displays whose bottom edge is exposed and sits in the bottom-most physical tier.
  /// Excludes upper rows in vertical stacks and 2×2 / N×M matrices (A02).
  static func extractBottomRowCandidates(from all: [OrbitScreenGeometry]) -> [OrbitScreenGeometry] {
    guard !all.isEmpty else { return [] }
    guard all.count > 1 else { return all }

    let exposed = all.filter { isBottomEdgeExposed($0, among: all) }
    let pool = exposed.isEmpty ? all : exposed
    let globalMinBottomY = pool.map(\.frame.minY).min() ?? 0

    // Keep displays belonging to the bottom-most exposed tier (within alignment tolerance).
    // This excludes elevated wing displays whose bottom sits far above the bottom row while
    // retaining bottom-aligned mixed-height monitors (e.g., 1440p + 1080p side by side).
    let bottomTier = pool.filter { abs($0.frame.minY - globalMinBottomY) <= bottomEdgeAlignmentTolerance }
    return (bottomTier.isEmpty ? pool : bottomTier).sorted { lhs, rhs in
      if abs(lhs.frame.minX - rhs.frame.minX) > 0.5 {
        return lhs.frame.minX < rhs.frame.minX
      }
      return lhs.frame.minY < rhs.frame.minY
    }
  }

  /// Step 3: Returns `true` iff `left` and `right` (already ordered by `minX`) form a seamless
  /// horizontally contiguous bottom-rail pair with no non-screen void between them.
  static func areHorizontallyContiguousBottomNeighbors(_ left: OrbitScreenGeometry, _ right: OrbitScreenGeometry) -> Bool {
    // Must be side-by-side (not stacked on the same X column) and have no empty gap > tolerance
    let horizontalGap = right.frame.minX - left.frame.maxX
    guard horizontalGap <= horizontalContiguityTolerance && horizontalGap >= -horizontalContiguityTolerance else {
      return false
    }
    // Bottom edges must stay collinear enough to stitch cards continuously without broken baseline
    guard abs(right.frame.minY - left.frame.minY) <= bottomEdgeAlignmentTolerance else {
      return false
    }
    // Bottom rail vertical bands must overlap meaningfully (prevents diagonal corner-touching screens from chaining)
    let leftBandH = railHeightForScreen(left.frame)
    let rightBandH = railHeightForScreen(right.frame)
    let commonH = min(leftBandH, rightBandH)
    let overlapMinY = max(left.visibleFrame.minY, right.visibleFrame.minY)
    let overlapMaxY = min(left.visibleFrame.minY + commonH, right.visibleFrame.minY + commonH)
    return (overlapMaxY - overlapMinY) >= commonH * 0.45
  }

  /// Step 4: Partitions sorted bottom-row candidates into horizontally contiguous groups.
  /// Disconnected screens are NEVER merged across void space.
  static func partitionContiguousBottomGroups(_ sortedBottomCandidates: [OrbitScreenGeometry]) -> [[OrbitScreenGeometry]] {
    var groups: [[OrbitScreenGeometry]] = []
    for screen in sortedBottomCandidates {
      if var current = groups.last, let prev = current.last,
         areHorizontallyContiguousBottomNeighbors(prev, screen) {
        current.append(screen)
        groups[groups.count - 1] = current
      } else {
        groups.append([screen])
      }
    }
    return groups
  }

  /// Step 5: Selects exactly ONE participating contiguous group (never mirrors across disconnected groups):
  /// 1. Prefer the group containing `preferredScreenID` (pointer/active screen).
  /// 2. Otherwise select the group with the largest combined horizontal logical span
  ///    (tie-breaking by containing main screen, then leftmost origin).
  static func selectWinningBottomGroup(
    from groups: [[OrbitScreenGeometry]],
    preferredScreenID: String?
  ) -> [OrbitScreenGeometry] {
    guard !groups.isEmpty else { return [] }
    if let preferredID = preferredScreenID,
       let matching = groups.first(where: { group in group.contains(where: { $0.id == preferredID }) }) {
      return matching
    }
    return groups.max(by: { lhs, rhs in
      let lhsSpan = lhs.reduce(CGFloat(0)) { $0 + $1.frame.width }
      let rhsSpan = rhs.reduce(CGFloat(0)) { $0 + $1.frame.width }
      if abs(lhsSpan - rhsSpan) > 1.0 {
        return lhsSpan < rhsSpan
      }
      let lhsHasMain = lhs.contains(where: \.isMainScreen)
      let rhsHasMain = rhs.contains(where: \.isMainScreen)
      if lhsHasMain != rhsHasMain {
        return !lhsHasMain && rhsHasMain
      }
      return (lhs.first?.frame.minX ?? 0) > (rhs.first?.frame.minX ?? 0)
    }) ?? groups[0]
  }

  /// Pure end-to-end participating bottom-row selector operating on normalized geometries.
  static func participatingBottomRowGeometries(
    from all: [OrbitScreenGeometry],
    preferredScreenID: String?
  ) -> [OrbitScreenGeometry] {
    let candidates = extractBottomRowCandidates(from: all)
    let groups = partitionContiguousBottomGroups(candidates)
    return selectWinningBottomGroup(from: groups, preferredScreenID: preferredScreenID)
  }

  static func railHeightForScreen(_ screenFrame: NSRect) -> CGFloat {
    min(296, max(238, round(screenFrame.height * 0.295)))
  }

  /// Computes per-screen `OrbitViewportDescriptor` slices for the live display topology.
  /// - Single screen: produces exactly 1 descriptor (behavior 100% identical to single-screen Orbit).
  /// - Multi-screen horizontal bottom rail (`multiWindowEnabled == true`): produces 1 descriptor per
  ///   participating bottom-row contiguous display, ordered left-to-right with contiguous `railRange`
  ///   intervals and `showsOpticalDots == true` ONLY on index 0 (leftmost participating display).
  static func computeViewports(
    position rawPosition: String,
    screens: [NSScreen] = NSScreen.screens,
    multiWindowEnabled: Bool = true
  ) -> [OrbitViewportDescriptor] {
    let allGeos = geometries(from: screens)
    let active = activeScreen(from: screens)
    let preferredID: String? = active.flatMap { act in
      allGeos.first(where: { $0.frame == act.frame })?.id
    }
    return computeViewports(
      position: rawPosition,
      geometries: allGeos,
      preferredScreenID: preferredID,
      multiWindowEnabled: multiWindowEnabled
    )
  }

  /// Pure geometry overload so topology calculations are deterministic and self-contained.
  static func computeViewports(
    position rawPosition: String,
    geometries allGeos: [OrbitScreenGeometry],
    preferredScreenID: String?,
    multiWindowEnabled: Bool = true
  ) -> [OrbitViewportDescriptor] {
    let position = normalizePosition(rawPosition)
    let fallbackFrame = NSRect(x: 0, y: 0, width: 1440, height: 900)
    guard !allGeos.isEmpty else {
      let panelFrame = NSRect(x: 0, y: 0, width: fallbackFrame.width, height: 274)
      let railWidth = max(1, panelFrame.width - LumenV15Tokens.opticalDotsColumnWidth)
      return [
        OrbitViewportDescriptor(
          id: "fallback-0",
          viewportIndex: 0,
          totalViewportCount: 1,
          screenFrame: fallbackFrame,
          visibleFrame: fallbackFrame,
          panelFrame: panelFrame,
          railRange: 0...railWidth,
          backingScaleFactor: 2.0,
          showsOpticalDots: position == "bottom",
          isPrimaryViewport: true
        )
      ]
    }

    let preferredGeo = allGeos.first(where: { $0.id == preferredScreenID })
      ?? allGeos.first(where: \.isMainScreen)
      ?? allGeos[0]

    // Vertical left/right side rails always anchor to the single active screen.
    if position == "left" || position == "right" {
      let visible = preferredGeo.visibleFrame
      let width = min(286, max(242, round(visible.width * 0.19)))
      let x = position == "left" ? visible.minX : visible.maxX - width
      let panelFrame = NSRect(x: x, y: visible.minY, width: width, height: visible.height)
      return [
        OrbitViewportDescriptor(
          id: preferredGeo.id,
          viewportIndex: 0,
          totalViewportCount: 1,
          screenFrame: preferredGeo.frame,
          visibleFrame: visible,
          panelFrame: panelFrame,
          railRange: 0...max(1, panelFrame.height),
          backingScaleFactor: preferredGeo.backingScaleFactor,
          showsOpticalDots: false,
          isPrimaryViewport: true
        )
      ]
    }

    let participating: [OrbitScreenGeometry]
    if multiWindowEnabled && allGeos.count > 1 {
      participating = participatingBottomRowGeometries(from: allGeos, preferredScreenID: preferredGeo.id)
    } else {
      participating = [preferredGeo]
    }

    // Unified logical rail height & collinear bottom baseline across participating displays:
    // Taking `max(visibleFrame.minY)` ensures side-by-side monitors stay razor-level across the bezel
    // even when macOS Dock occupies the bottom of only one display (or displays have a small vertical offset),
    // while clamping keeps every panel strictly inside its own display's visible bounds.
    let commonHeight = participating
      .map { railHeightForScreen($0.frame) }
      .min() ?? 274
    let sharedBaselineY = participating.map { $0.visibleFrame.minY }.max() ?? 0

    // Identify primary viewport (contains pointer/active screen if inside the winning group, else leftmost).
    let primaryID = participating.first(where: { $0.id == preferredGeo.id })?.id
      ?? participating.first(where: \.isMainScreen)?.id
      ?? participating[0].id

    var descriptors: [OrbitViewportDescriptor] = []
    descriptors.reserveCapacity(participating.count)
    var railCursor: CGFloat = 0

    for (idx, geo) in participating.enumerated() {
      let showsDots = (idx == 0)
      let maxSafeY = max(geo.visibleFrame.minY, geo.visibleFrame.maxY - commonHeight)
      let panelY = max(geo.visibleFrame.minY, min(maxSafeY, sharedBaselineY))
      let panelFrame = NSRect(
        x: geo.frame.minX,
        y: panelY,
        width: geo.frame.width,
        height: commonHeight
      )
      // Optical Dots (38 DIP) occupy only the leftmost screen's leading edge;
      // the continuous card rail occupies the remaining width on screen 0 and full width on screens 1..<N.
      let railStripWidth = max(1, panelFrame.width - (showsDots ? LumenV15Tokens.opticalDotsColumnWidth : 0))
      let startX = railCursor
      let endX = railCursor + railStripWidth
      railCursor = endX

      descriptors.append(
        OrbitViewportDescriptor(
          id: geo.id,
          viewportIndex: idx,
          totalViewportCount: participating.count,
          screenFrame: geo.frame,
          visibleFrame: geo.visibleFrame,
          panelFrame: panelFrame,
          railRange: startX...endX,
          backingScaleFactor: geo.backingScaleFactor,
          showsOpticalDots: showsDots,
          isPrimaryViewport: geo.id == primaryID
        )
      )
    }
    return descriptors
  }
}

// MARK: - Per-Viewport Clipped Rail Canvas (Unified Global Scroll & Cross-Bezel Drag)

/// Clipping card-rail container hosted inside each participating `OrbitViewport`.
/// Does NOT own an independent scroll offset: all wheel, trackpad momentum, Shift+wheel,
/// and drag-pan events forward directly to `LumenOrbitDisplayCoordinator`, which updates
/// the single global `OrbitRailState.scrollOffset` and repositions all viewports in lockstep.
final class LumenOrbitRailViewportView: NSView {
  var isHorizontalRail = true
  var onShiftWheel: ((NSEvent) -> Void)?
  /// Signed scroll delta in global logical points (+ increases `scrollOffset` / moves cards leftward).
  var onScrollDelta: ((CGFloat) -> Void)?
  /// Drag pan callbacks using global screen coordinates so dragging smoothly crosses physical monitor bezels.
  var onDragPanBegan: (() -> CGFloat)?
  var onDragPanMoved: ((CGFloat) -> Void)?

  private var dragOriginScreen: NSPoint?
  private var dragStartGlobalOffset: CGFloat = 0
  private(set) var didDragPan = false

  override var isFlipped: Bool { true }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.masksToBounds = true
  }

  required init?(coder: NSCoder) { nil }

  override func scrollWheel(with event: NSEvent) {
    if event.modifierFlags.contains(.shift), let onShiftWheel {
      onShiftWheel(event)
      return
    }
    let scale: CGFloat = event.hasPreciseScrollingDeltas ? 1.0 : 18.0
    if isHorizontalRail {
      let dx = event.scrollingDeltaX
      let dy = event.scrollingDeltaY
      if abs(dy) > abs(dx) && abs(dy) > 0.05 {
        onScrollDelta?(-dy * scale)
      } else if abs(dx) > 0.05 {
        onScrollDelta?(-dx * scale)
      }
    } else {
      let dy = event.scrollingDeltaY
      if abs(dy) > 0.05 {
        onScrollDelta?(-dy * scale)
      }
    }
  }

  func beginRailDrag(with event: NSEvent) {
    _ = event
    dragOriginScreen = NSEvent.mouseLocation
    dragStartGlobalOffset = onDragPanBegan?() ?? 0
    didDragPan = false
  }

  func continueRailDrag(with event: NSEvent) {
    _ = event
    guard let origin = dragOriginScreen else { return }
    let current = NSEvent.mouseLocation
    let delta = isHorizontalRail ? (current.x - origin.x) : (origin.y - current.y)
    if abs(delta) > 7 {
      didDragPan = true
      onDragPanMoved?(dragStartGlobalOffset - delta)
    }
  }

  @discardableResult
  func endRailDrag() -> Bool {
    let dragged = didDragPan
    dragOriginScreen = nil
    didDragPan = false
    return dragged
  }

  override func mouseDown(with event: NSEvent) {
    beginRailDrag(with: event)
    super.mouseDown(with: event)
  }

  override func mouseDragged(with event: NSEvent) {
    if dragOriginScreen != nil {
      continueRailDrag(with: event)
      if didDragPan { return }
    }
    super.mouseDragged(with: event)
  }

  override func mouseUp(with event: NSEvent) {
    _ = endRailDrag()
    super.mouseUp(with: event)
  }
}

// MARK: - OrbitViewport (One Borderless Floating NSPanel per Participating Display)

/// Encapsulates a single participating display's native borderless floating `NSPanel` and its layers:
/// - `backdrop`: translucent optical glass background & top sheen
/// - `opticalDots` + `dotBubble`: rendered ONLY on the leftmost participating viewport (`descriptor.showsOpticalDots`)
/// - `railViewport`: locally clipped card-rail canvas mounting ONLY card slices intersecting `descriptor.railRange`
/// - `effectsOverlay`: non-interactive particle/dissolution slice renderer bound to the single `LumenOrbitEffectsEngine`
/// - `emptyLabel` + `toastView`: displayed only on the designated active/primary viewport (never duplicated)
final class OrbitViewport {
  private(set) var descriptor: OrbitViewportDescriptor
  let panel: LumenOrbitHostPanel
  let backdrop = LumenOrbitBackdropView()
  let opticalDots = LumenOrbitOpticalDotsView()
  let dotBubble = LumenOpticalDotBubbleView()
  let railViewport = LumenOrbitRailViewportView()
  let effectsOverlay = LumenOrbitEffectsOverlayView()
  let emptyLabel = NSTextField(labelWithString: "暂无剪贴板记录")
  let toastView = LumenToastBannerView()

  /// Currently mounted card view slices intersecting this viewport's `railRange`, keyed by logical clip ID.
  var mountedCards: [String: LumenOrbitCardView] = [:]

  private var dotsWidthConstraint: NSLayoutConstraint?
  private var bubbleLeadingConstraint: NSLayoutConstraint?
  private var bubbleCenterYConstraint: NSLayoutConstraint?

  init(descriptor: OrbitViewportDescriptor, edgePosition: String = "bottom") {
    self.descriptor = descriptor
    self.panel = LumenOrbitHostPanel(
      contentRect: descriptor.panelFrame,
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )

    // macOS Separate Spaces note:
    // When `NSScreen.screensHaveSeparateSpaces` is enabled (macOS default), each display owns an
    // independent Space. Creating one non-activating floating NSPanel per participating bottom display
    // with `[.canJoinAllSpaces, .fullScreenAuxiliary]` lets every participating screen display its own
    // rail slice simultaneously on its active Space without triggering Space switches or cross-screen clipping.
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = (descriptor.totalViewportCount == 1)

    buildHierarchy()
    applyDescriptor(descriptor, edgePosition: edgePosition)
  }

  private func buildHierarchy() {
    panel.contentView = backdrop

    opticalDots.translatesAutoresizingMaskIntoConstraints = false
    opticalDots.bubbleView = dotBubble

    dotBubble.translatesAutoresizingMaskIntoConstraints = false

    railViewport.translatesAutoresizingMaskIntoConstraints = false

    effectsOverlay.translatesAutoresizingMaskIntoConstraints = false

    emptyLabel.font = .systemFont(ofSize: 13.5, weight: .medium)
    emptyLabel.alignment = .center
    emptyLabel.isHidden = true
    emptyLabel.translatesAutoresizingMaskIntoConstraints = false

    toastView.translatesAutoresizingMaskIntoConstraints = false

    backdrop.addSubview(opticalDots)
    backdrop.addSubview(railViewport)
    backdrop.addSubview(emptyLabel)
    backdrop.addSubview(effectsOverlay)
    backdrop.addSubview(dotBubble)
    backdrop.addSubview(toastView)

    let dotsW = opticalDots.widthAnchor.constraint(equalToConstant: LumenV15Tokens.opticalDotsColumnWidth)
    dotsWidthConstraint = dotsW

    // Constrain hover label strictly within the 38 DIP optical-dots column (x ∈ [2, 36])
    // so it never overflows onto or occludes the first card (§3.1/§3.2, A05/A23).
    let bubbleLeading = dotBubble.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor, constant: 2)
    let bubbleWidth = dotBubble.widthAnchor.constraint(equalToConstant: LumenOpticalDotBubbleView.maxColumnWidth)
    let bubbleCenterY = dotBubble.centerYAnchor.constraint(equalTo: backdrop.topAnchor, constant: 48)
    bubbleLeadingConstraint = bubbleLeading
    bubbleCenterYConstraint = bubbleCenterY

    NSLayoutConstraint.activate([
      opticalDots.topAnchor.constraint(equalTo: backdrop.topAnchor),
      opticalDots.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor),
      opticalDots.bottomAnchor.constraint(equalTo: backdrop.bottomAnchor),
      dotsW,

      railViewport.topAnchor.constraint(equalTo: backdrop.topAnchor),
      railViewport.leadingAnchor.constraint(equalTo: opticalDots.trailingAnchor),
      railViewport.trailingAnchor.constraint(equalTo: backdrop.trailingAnchor),
      railViewport.bottomAnchor.constraint(equalTo: backdrop.bottomAnchor),

      effectsOverlay.topAnchor.constraint(equalTo: backdrop.topAnchor),
      effectsOverlay.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor),
      effectsOverlay.trailingAnchor.constraint(equalTo: backdrop.trailingAnchor),
      effectsOverlay.bottomAnchor.constraint(equalTo: backdrop.bottomAnchor),

      emptyLabel.centerXAnchor.constraint(equalTo: railViewport.centerXAnchor),
      emptyLabel.centerYAnchor.constraint(equalTo: railViewport.centerYAnchor),

      bubbleLeading,
      bubbleWidth,
      bubbleCenterY,

      toastView.topAnchor.constraint(equalTo: backdrop.topAnchor, constant: 10),
      toastView.centerXAnchor.constraint(equalTo: backdrop.centerXAnchor)
    ])

    opticalDots.onBubblePositionChanged = { [weak self] centerY, text, visible in
      guard let self else { return }
      if !text.isEmpty {
        self.dotBubble.updateText(text)
      }
      if let constraint = self.bubbleCenterYConstraint, abs(constraint.constant - centerY) > 0.25 {
        constraint.constant = centerY
      }
      self.dotBubble.setVisible(visible && !text.isEmpty, animated: true)
    }
  }

  /// Leading offset of `railViewport` inside `backdrop` / `effectsOverlay` (38 DIP on leftmost bottom screen, 0 on others).
  var railLeadingOffsetInOverlay: CGFloat {
    (descriptor.showsOpticalDots && railViewport.isHorizontalRail) ? LumenV15Tokens.opticalDotsColumnWidth : 0
  }

  /// Visible card-rail clip rectangle in `effectsOverlay` coordinates (excludes Optical Dots column on viewport 0).
  func railClipRectInOverlay() -> NSRect {
    effectsOverlay.convert(railViewport.bounds, from: railViewport)
  }

  func applyDescriptor(_ next: OrbitViewportDescriptor, edgePosition: String) {
    descriptor = next
    backdrop.edgePosition = edgePosition
    railViewport.isHorizontalRail = (edgePosition == "bottom")
    // Suppress side panel drop-shadow on multi-screen rails so WindowServer doesn't paint a dark
    // vertical seam onto the neighboring display; single-screen retains full native shadow.
    panel.hasShadow = (next.totalViewportCount == 1)

    let showDots = next.showsOpticalDots && edgePosition == "bottom"
    opticalDots.isHidden = !showDots
    dotsWidthConstraint?.constant = showDots ? LumenV15Tokens.opticalDotsColumnWidth : 0
    bubbleLeadingConstraint?.constant = 2
    if !showDots {
      opticalDots.resetTransientState()
      dotBubble.setVisible(false, animated: false)
    }
    effectsOverlay.viewportRailRange = next.railRange
    effectsOverlay.railLeadingInsetInOverlay = showDots ? LumenV15Tokens.opticalDotsColumnWidth : 0
    effectsOverlay.isHorizontalRail = railViewport.isHorizontalRail
  }

  func applyTheme(_ palette: LumenPalette, preferences: LumenVisualPreferences) {
    panel.appearance = palette.nsAppearance
    backdrop.applyTheme(palette, preferences: preferences)
    opticalDots.applyTheme(palette, glowEnabled: preferences.glow)
    emptyLabel.textColor = palette.isDark
      ? NSColor(srgbRed: 0.90, green: 0.94, blue: 1.0, alpha: 0.85)
      : palette.ink
  }

  func offscreenFrame(for edgePosition: String) -> NSRect {
    let target = descriptor.panelFrame
    switch edgePosition {
    case "left":
      return target.offsetBy(dx: -target.width - 24, dy: 0)
    case "right":
      return target.offsetBy(dx: target.width + 24, dy: 0)
    default:
      return target.offsetBy(dx: 0, dy: -target.height - 24)
    }
  }

  func removeAllMountedCards() {
    for card in mountedCards.values {
      card.removeFromSuperview()
    }
    mountedCards.removeAll()
  }

  func teardown() {
    removeAllMountedCards()
    opticalDots.resetTransientState()
    effectsOverlay.detachEngine()
    panel.orderOut(nil)
  }
}
