import AppKit
import Foundation
import QuartzCore

// MARK: - Shared Multi-Display Logical Rail State (§4, §14.2, A01–A04)

/// Single source of truth for the Orbit rail across one or more participating bottom viewports.
/// Every `OrbitViewport` reads from and writes to this shared state instead of duplicating lists.
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

  mutating func updateMetrics(for primaryPanelFrame: NSRect) {
    if isHorizontalRail {
      cardHeight = min(232, max(172, primaryPanelFrame.height - railTopInset - railBottomInset))
      cardWidth = min(222, max(178, round(primaryPanelFrame.width * 0.142)))
      cardGap = 12
    } else {
      cardWidth = max(196, primaryPanelFrame.width - 28)
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

/// Logical viewport slice assigned to one participating physical display.
struct OrbitViewportDescriptor: Equatable {
  let id: String
  let screenFrame: NSRect
  let visibleFrame: NSRect
  let panelFrame: NSRect
  let railRange: ClosedRange<CGFloat>
  let backingScaleFactor: CGFloat
  let showsOpticalDots: Bool
  let isPrimaryViewport: Bool
}

// MARK: - Display Topology Calculator (§4, A01–A04)

enum OrbitDisplayTopology {
  static func normalizePosition(_ raw: String) -> String {
    switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "left": return "left"
    case "right": return "right"
    default: return "bottom"
    }
  }

  static func activeScreen(from screens: [NSScreen] = NSScreen.screens) -> NSScreen? {
    let pointer = NSEvent.mouseLocation
    if let match = screens.first(where: { NSMouseInRect(pointer, $0.frame, false) }) {
      return match
    }
    return NSScreen.main ?? screens.first
  }

  /// Identifies the bottom-most horizontally contiguous screen group (excludes upper rows in 2x2 / stacked layouts).
  static func participatingBottomRowScreens(from screens: [NSScreen], activeScreen: NSScreen?) -> [NSScreen] {
    guard !screens.isEmpty else { return [] }
    guard screens.count > 1 else { return screens }

    let minBottomY = screens.map { $0.frame.minY }.min() ?? 0
    let bottomCandidates = screens
      .filter { abs($0.frame.minY - minBottomY) <= 120 }
      .sorted { $0.frame.minX < $1.frame.minX }
    guard !bottomCandidates.isEmpty else {
      return activeScreen.map { [$0] } ?? [screens[0]]
    }

    // Partition into horizontally contiguous groups (gap tolerance 32pt for mixed DPI rounding)
    var groups: [[NSScreen]] = []
    for screen in bottomCandidates {
      if var lastGroup = groups.last, let prev = lastGroup.last,
         screen.frame.minX - prev.frame.maxX <= 32 {
        lastGroup.append(screen)
        groups[groups.count - 1] = lastGroup
      } else {
        groups.append([screen])
      }
    }

    if let active = activeScreen,
       let matching = groups.first(where: { group in group.contains(where: { $0.frame == active.frame }) }) {
      return matching
    }
    return groups.max(by: { lhs, rhs in
      let lhsSpan = (lhs.last?.frame.maxX ?? 0) - (lhs.first?.frame.minX ?? 0)
      let rhsSpan = (rhs.last?.frame.maxX ?? 0) - (rhs.first?.frame.minX ?? 0)
      return lhsSpan < rhsSpan
    }) ?? bottomCandidates
  }

  /// Computes viewport descriptors for the active display topology.
  /// In P1 (`multiWindowEnabled = false`), activates the single-screen continuous bottom rail
  /// while keeping the full `OrbitViewportDescriptor` model ready for per-screen multi-display chaining.
  static func computeViewports(
    position rawPosition: String,
    screens: [NSScreen] = NSScreen.screens,
    multiWindowEnabled: Bool = false
  ) -> [OrbitViewportDescriptor] {
    let position = normalizePosition(rawPosition)
    let fallbackScreen = NSRect(x: 0, y: 0, width: 1440, height: 900)
    guard let active = activeScreen(from: screens) else {
      let panelFrame = NSRect(x: 0, y: 0, width: fallbackScreen.width, height: 274)
      return [
        OrbitViewportDescriptor(
          id: "fallback-0",
          screenFrame: fallbackScreen,
          visibleFrame: fallbackScreen,
          panelFrame: panelFrame,
          railRange: 0...panelFrame.width,
          backingScaleFactor: 2.0,
          showsOpticalDots: position == "bottom",
          isPrimaryViewport: true
        )
      ]
    }

    if position == "left" || position == "right" {
      let visible = active.visibleFrame
      let width = min(286, max(242, round(visible.width * 0.19)))
      let x = position == "left" ? visible.minX : visible.maxX - width
      let panelFrame = NSRect(x: x, y: visible.minY, width: width, height: visible.height)
      return [
        OrbitViewportDescriptor(
          id: screenIdentifier(active, fallbackIndex: 0),
          screenFrame: active.frame,
          visibleFrame: visible,
          panelFrame: panelFrame,
          railRange: 0...panelFrame.height,
          backingScaleFactor: active.backingScaleFactor,
          showsOpticalDots: false,
          isPrimaryViewport: true
        )
      ]
    }

    let participating: [NSScreen]
    if multiWindowEnabled {
      participating = participatingBottomRowScreens(from: screens, activeScreen: active)
    } else {
      participating = [active]
    }

    let commonHeight = participating
      .map { min(296, max(238, round($0.frame.height * 0.295))) }
      .min() ?? 274

    var descriptors: [OrbitViewportDescriptor] = []
    var railCursor: CGFloat = 0
    for (idx, screen) in participating.enumerated() {
      let frame = screen.frame
      let visible = screen.visibleFrame
      let panelFrame = NSRect(x: frame.minX, y: visible.minY, width: frame.width, height: commonHeight)
      let startX = railCursor
      let endX = railCursor + panelFrame.width
      railCursor = endX
      descriptors.append(
        OrbitViewportDescriptor(
          id: screenIdentifier(screen, fallbackIndex: idx),
          screenFrame: frame,
          visibleFrame: visible,
          panelFrame: panelFrame,
          railRange: startX...endX,
          backingScaleFactor: screen.backingScaleFactor,
          showsOpticalDots: idx == 0,
          isPrimaryViewport: (screen.frame == active.frame) || (idx == 0 && participating.count == 1)
        )
      )
    }
    return descriptors
  }

  private static func screenIdentifier(_ screen: NSScreen, fallbackIndex: Int) -> String {
    if let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
      return "display-\(number.uint32Value)"
    }
    return "display-\(fallbackIndex)"
  }
}

// MARK: - OrbitViewport (One Borderless Floating Window per Participating Display)

/// Encapsulates a single screen's native borderless floating NSPanel and its visual layers
/// (glass backdrop, optional 38 DIP Optical Dots column on leftmost viewport, continuous card rail,
/// soft dissolution/aggregation overlay, and transient toast).
final class OrbitViewport {
  private(set) var descriptor: OrbitViewportDescriptor
  let panel: LumenOrbitHostPanel
  let backdrop = LumenOrbitBackdropView()
  let opticalDots: LumenOrbitOpticalDotsView
  let dotBubble = LumenOpticalDotBubbleView()
  let railScroll = LumenOrbitRailScrollView()
  let railDocument = LumenFlippedView()
  let effectsOverlay = LumenOrbitEffectsOverlayView()
  let emptyLabel = NSTextField(labelWithString: "暂无剪贴板记录")
  let toastView = LumenToastBannerView()

  private var dotsWidthConstraint: NSLayoutConstraint?
  private var bubbleLeadingConstraint: NSLayoutConstraint?
  private var bubbleCenterYConstraint: NSLayoutConstraint?

  init(descriptor: OrbitViewportDescriptor) {
    self.descriptor = descriptor
    self.panel = LumenOrbitHostPanel(
      contentRect: descriptor.panelFrame,
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    self.opticalDots = LumenOrbitOpticalDotsView()

    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true

    buildHierarchy()
    applyDescriptor(descriptor, edgePosition: "bottom")
  }

  private func buildHierarchy() {
    panel.contentView = backdrop

    opticalDots.translatesAutoresizingMaskIntoConstraints = false
    opticalDots.bubbleView = dotBubble

    dotBubble.translatesAutoresizingMaskIntoConstraints = false

    railScroll.documentView = railDocument
    railScroll.drawsBackground = false
    railScroll.contentView.drawsBackground = false
    railScroll.borderType = .noBorder
    railScroll.hasHorizontalScroller = false
    railScroll.hasVerticalScroller = false
    railScroll.autohidesScrollers = true
    railScroll.translatesAutoresizingMaskIntoConstraints = false

    effectsOverlay.translatesAutoresizingMaskIntoConstraints = false

    emptyLabel.font = .systemFont(ofSize: 13.5, weight: .medium)
    emptyLabel.alignment = .center
    emptyLabel.isHidden = true
    emptyLabel.translatesAutoresizingMaskIntoConstraints = false

    toastView.translatesAutoresizingMaskIntoConstraints = false

    backdrop.addSubview(opticalDots)
    backdrop.addSubview(railScroll)
    backdrop.addSubview(emptyLabel)
    backdrop.addSubview(effectsOverlay)
    backdrop.addSubview(dotBubble)
    backdrop.addSubview(toastView)

    let dotsW = opticalDots.widthAnchor.constraint(equalToConstant: LumenV15Tokens.opticalDotsColumnWidth)
    dotsWidthConstraint = dotsW

    let bubbleLeading = dotBubble.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor, constant: LumenV15Tokens.opticalDotsColumnWidth + 4)
    let bubbleCenterY = dotBubble.centerYAnchor.constraint(equalTo: backdrop.topAnchor, constant: 120)
    bubbleLeadingConstraint = bubbleLeading
    bubbleCenterYConstraint = bubbleCenterY

    NSLayoutConstraint.activate([
      opticalDots.topAnchor.constraint(equalTo: backdrop.topAnchor),
      opticalDots.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor),
      opticalDots.bottomAnchor.constraint(equalTo: backdrop.bottomAnchor),
      dotsW,

      railScroll.topAnchor.constraint(equalTo: backdrop.topAnchor),
      railScroll.leadingAnchor.constraint(equalTo: opticalDots.trailingAnchor),
      railScroll.trailingAnchor.constraint(equalTo: backdrop.trailingAnchor),
      railScroll.bottomAnchor.constraint(equalTo: backdrop.bottomAnchor),

      effectsOverlay.topAnchor.constraint(equalTo: backdrop.topAnchor),
      effectsOverlay.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor),
      effectsOverlay.trailingAnchor.constraint(equalTo: backdrop.trailingAnchor),
      effectsOverlay.bottomAnchor.constraint(equalTo: backdrop.bottomAnchor),

      emptyLabel.centerXAnchor.constraint(equalTo: railScroll.centerXAnchor),
      emptyLabel.centerYAnchor.constraint(equalTo: railScroll.centerYAnchor),

      bubbleLeading,
      bubbleCenterY,

      toastView.topAnchor.constraint(equalTo: backdrop.topAnchor, constant: 10),
      toastView.centerXAnchor.constraint(equalTo: backdrop.centerXAnchor)
    ])

    opticalDots.onBubblePositionChanged = { [weak self] centerY, text, visible in
      guard let self else { return }
      if !text.isEmpty {
        self.dotBubble.updateText(text)
      }
      self.bubbleCenterYConstraint?.constant = centerY
      self.dotBubble.setVisible(visible && !text.isEmpty, animated: true)
    }
  }

  func applyDescriptor(_ next: OrbitViewportDescriptor, edgePosition: String) {
    descriptor = next
    backdrop.edgePosition = edgePosition
    let showDots = next.showsOpticalDots && edgePosition == "bottom"
    opticalDots.isHidden = !showDots
    dotsWidthConstraint?.constant = showDots ? LumenV15Tokens.opticalDotsColumnWidth : 0
    bubbleLeadingConstraint?.constant = LumenV15Tokens.opticalDotsColumnWidth + 4
    if !showDots {
      dotBubble.setVisible(false, animated: false)
    }
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

  /// Synchronizes this viewport's local horizontal scroll origin from the shared global `scrollOffset`.
  func syncScrollOffset(globalOffset: CGFloat, animated: Bool = false) {
    guard railScroll.isHorizontalRail else { return }
    let localOriginX = max(0, globalOffset - descriptor.railRange.lowerBound)
    if animated && LumenMotion.isEnabled {
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = 0.24
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.85, 0.25, 1)
        self.railScroll.contentView.animator().setBoundsOrigin(NSPoint(x: localOriginX, y: self.railScroll.contentView.bounds.origin.y))
      }
      railScroll.reflectScrolledClipView(railScroll.contentView)
    } else {
      railScroll.scrollHorizontalClamped(to: localOriginX)
    }
  }

  func currentGlobalScrollOffset() -> CGFloat {
    descriptor.railRange.lowerBound + railScroll.contentView.bounds.origin.x
  }
}
