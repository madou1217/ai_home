import AppKit
import CoreGraphics
import Foundation
import PDFKit
import QuartzCore

/// Top-down flipped container for NSScrollView document views so scroll starts at top.
final class LumenFlippedView: NSView {
  override var isFlipped: Bool { true }
}

/// Sidebar navigation destinations matching Lumen V15 (10 logical categories).
enum LumenNavDestination: Hashable {
  case all
  case recent
  case pinned
  case category(LumenLogicalCategory)
  case settings

  var title: String {
    switch self {
    case .all: return "所有记录"
    case .recent: return "最近记录"
    case .pinned: return "已固定"
    case .category(let cat): return cat.label
    case .settings: return "偏好设置"
    }
  }
}

// MARK: - Unified Interactive Vector Action Button (32×32 Hit Target, Neutral-to-Danger Hover, §13.1)

final class LumenIconActionButton: NSView {
  var onClick: (() -> Void)?

  private let glyphView = NSImageView()
  private var trackingArea: NSTrackingArea?
  private var glyph: LumenActionGlyph
  private var glyphSize: CGFloat
  private var normalTint: NSColor = .secondaryLabelColor
  private var hoverTint: NSColor = .labelColor
  private var hoverBg: NSColor = NSColor.labelColor.withAlphaComponent(0.08)
  private var activeBg: NSColor = .clear
  private var isDanger = false
  private var isHovered = false
  private var isPressed = false
  var isEnabled = true {
    didSet { updateAppearance(animated: false) }
  }
  var isToggledOn = false {
    didSet { updateAppearance(animated: false) }
  }

  init(glyph: LumenActionGlyph, glyphSize: CGFloat = 18, tip: String, isDanger: Bool = false) {
    self.glyph = glyph
    self.glyphSize = glyphSize
    self.isDanger = isDanger
    super.init(frame: .zero)
    wantsLayer = true
    layer?.cornerRadius = 9
    layer?.cornerCurve = .continuous

    glyphView.imageScaling = .scaleProportionallyDown
    glyphView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(glyphView)
    NSLayoutConstraint.activate([
      glyphView.centerXAnchor.constraint(equalTo: centerXAnchor),
      glyphView.centerYAnchor.constraint(equalTo: centerYAnchor),
      glyphView.widthAnchor.constraint(equalToConstant: glyphSize),
      glyphView.heightAnchor.constraint(equalToConstant: glyphSize)
    ])

    toolTip = tip
    setAccessibilityRole(.button)
    setAccessibilityLabel(tip)
  }

  required init?(coder: NSCoder) { nil }

  func configure(glyph nextGlyph: LumenActionGlyph? = nil, tip: String? = nil, palette: LumenPalette, toggledOn: Bool = false, enabled: Bool = true) {
    if let nextGlyph { glyph = nextGlyph }
    if let tip {
      toolTip = tip
      setAccessibilityLabel(tip)
    }
    isToggledOn = toggledOn
    isEnabled = enabled
    normalTint = toggledOn ? palette.accent : palette.muted
    hoverTint = isDanger ? palette.danger : (toggledOn ? palette.accent : palette.ink)
    hoverBg = isDanger
      ? palette.danger.withAlphaComponent(palette.isDark ? 0.18 : 0.10)
      : (palette.isDark ? NSColor.white.withAlphaComponent(0.09) : NSColor(srgbRed: 0.56, green: 0.67, blue: 0.85, alpha: 0.16))
    activeBg = toggledOn ? palette.accentSoft : .clear
    updateAppearance(animated: false)
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let existing = trackingArea { removeTrackingArea(existing) }
    let area = NSTrackingArea(
      rect: bounds,
      options: [.activeAlways, .mouseEnteredAndExited, .inVisibleRect],
      owner: self,
      userInfo: nil
    )
    addTrackingArea(area)
    trackingArea = area
  }

  override func mouseEntered(with event: NSEvent) {
    guard isEnabled else { return }
    isHovered = true
    updateAppearance(animated: true)
  }

  override func mouseExited(with event: NSEvent) {
    isHovered = false
    isPressed = false
    updateAppearance(animated: true)
  }

  override func mouseDown(with event: NSEvent) {
    guard isEnabled else { return }
    isPressed = true
    updateAppearance(animated: true)
  }

  override func mouseUp(with event: NSEvent) {
    guard isEnabled else { return }
    let wasPressed = isPressed
    isPressed = false
    let local = convert(event.locationInWindow, from: nil)
    updateAppearance(animated: true)
    if wasPressed && bounds.contains(local) {
      onClick?()
    }
  }

  override func accessibilityPerformPress() -> Bool {
    guard isEnabled else { return false }
    onClick?()
    return true
  }

  private func updateAppearance(animated: Bool) {
    let color: NSColor
    if !isEnabled {
      color = normalTint.withAlphaComponent(0.35)
    } else if isHovered {
      color = hoverTint
    } else {
      color = normalTint
    }
    glyphView.image = LumenVectorGlyphs.actionImage(glyph, size: glyphSize, color: color)

    let bg: NSColor = (!isEnabled) ? .clear : (isHovered ? hoverBg : activeBg)
    CATransaction.begin()
    CATransaction.setDisableActions(!(animated && LumenMotion.isEnabled))
    CATransaction.setAnimationDuration(0.16)
    layer?.backgroundColor = bg.cgColor
    CATransaction.commit()

    if let l = layer {
      let cx = bounds.midX
      let cy = bounds.midY
      let sc: CGFloat = isPressed ? 0.91 : 1.0
      var t = CATransform3DIdentity
      if sc != 1.0 {
        t = CATransform3DTranslate(t, cx, cy, 0)
        t = CATransform3DScale(t, sc, sc, 1)
        t = CATransform3DTranslate(t, -cx, -cy, 0)
      }
      if animated && LumenMotion.isEnabled {
        let cur = l.presentation()?.transform ?? l.transform
        let anim = CABasicAnimation(keyPath: "transform")
        anim.fromValue = NSValue(caTransform3D: cur)
        anim.toValue = NSValue(caTransform3D: t)
        anim.duration = 0.18
        anim.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.78, 0.24, 1)
        l.transform = t
        l.add(anim, forKey: "btnPress")
      } else {
        l.removeAnimation(forKey: "btnPress")
        l.transform = t
      }
    }
  }
}

// MARK: - Lag-Free Draggable Inspector Splitter (§17.3, A53)

final class LumenPaneSplitterView: NSView {
  var onDragDelta: ((CGFloat) -> Void)?
  var onDragStateChanged: ((Bool) -> Void)?
  var onKeyboardStep: ((CGFloat) -> Void)?

  private let hairline = NSView()
  private var trackingArea: NSTrackingArea?
  private var lastWindowX: CGFloat?
  private var isHovered = false
  private var isDragging = false
  private var cursorPushed = false
  private var palette: LumenPalette = .light

  override var acceptsFirstResponder: Bool { true }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true

    hairline.wantsLayer = true
    hairline.translatesAutoresizingMaskIntoConstraints = false
    addSubview(hairline)
    NSLayoutConstraint.activate([
      hairline.centerXAnchor.constraint(equalTo: centerXAnchor),
      hairline.topAnchor.constraint(equalTo: topAnchor),
      hairline.bottomAnchor.constraint(equalTo: bottomAnchor),
      hairline.widthAnchor.constraint(equalToConstant: 1)
    ])

    setAccessibilityRole(.splitter)
    setAccessibilityLabel("调整预览面板宽度")
  }

  required init?(coder: NSCoder) { nil }

  func applyTheme(_ next: LumenPalette) {
    palette = next
    updateHairlineColor()
  }

  private func updateHairlineColor() {
    if isDragging || isHovered {
      hairline.layer?.backgroundColor = palette.accent.withAlphaComponent(0.65).cgColor
    } else {
      hairline.layer?.backgroundColor = palette.border.cgColor
    }
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let existing = trackingArea { removeTrackingArea(existing) }
    let area = NSTrackingArea(
      rect: bounds,
      options: [.activeAlways, .mouseEnteredAndExited, .cursorUpdate, .inVisibleRect],
      owner: self,
      userInfo: nil
    )
    addTrackingArea(area)
    trackingArea = area
  }

  private func pushResizeCursor() {
    guard !cursorPushed else { return }
    cursorPushed = true
    NSCursor.resizeLeftRight.push()
  }

  private func popResizeCursor() {
    guard cursorPushed else { return }
    cursorPushed = false
    NSCursor.pop()
  }

  override func viewWillMove(toWindow newWindow: NSWindow?) {
    super.viewWillMove(toWindow: newWindow)
    if newWindow == nil {
      isHovered = false
      isDragging = false
      popResizeCursor()
    }
  }

  override func cursorUpdate(with event: NSEvent) {
    NSCursor.resizeLeftRight.set()
  }

  override func mouseEntered(with event: NSEvent) {
    isHovered = true
    pushResizeCursor()
    updateHairlineColor()
  }

  override func mouseExited(with event: NSEvent) {
    isHovered = false
    if !isDragging {
      popResizeCursor()
    }
    updateHairlineColor()
  }

  override func mouseDown(with event: NSEvent) {
    isDragging = true
    lastWindowX = event.locationInWindow.x
    pushResizeCursor()
    onDragStateChanged?(true)
    updateHairlineColor()
  }

  override func mouseDragged(with event: NSEvent) {
    guard isDragging, let prevX = lastWindowX else { return }
    let currentX = event.locationInWindow.x
    let dx = currentX - prevX
    lastWindowX = currentX
    if abs(dx) > 0.1 {
      onDragDelta?(dx)
    }
  }

  override func mouseUp(with event: NSEvent) {
    if isDragging {
      isDragging = false
      lastWindowX = nil
      onDragStateChanged?(false)
      if !isHovered {
        popResizeCursor()
      }
      updateHairlineColor()
    }
  }

  override func keyDown(with event: NSEvent) {
    switch event.keyCode {
    case 123: // Left widens inspector
      onKeyboardStep?(20)
    case 124: // Right narrows inspector
      onKeyboardStep?(-20)
    default:
      super.keyDown(with: event)
    }
  }
}

// MARK: - V15 Sidebar View (Ten Categories, Zero Prototype Status Block — §17.3, A54)

final class LumenSidebarView: NSView {
  private let gradientLayer = CAGradientLayer()
  private let brandMark = LumenBrandMarkView()
  private let brandTitle = NSTextField(labelWithString: "Lumen")
  private let brandSub = NSTextField(labelWithString: "Clipboard, reimagined.")
  private let scrollView = NSScrollView()
  private let navStack = NSStackView()
  private let bottomDivider = NSView()
  private let settingsButton = NSButton()

  private var buttonsByDest: [LumenNavDestination: (button: NSButton, countLabel: NSTextField?, iconView: NSView)] = [:]
  private var activeDestination: LumenNavDestination = .all
  var onSelectDestination: ((LumenNavDestination) -> Void)?

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    gradientLayer.startPoint = CGPoint(x: 0, y: 1)
    gradientLayer.endPoint = CGPoint(x: 1, y: 0)
    layer?.insertSublayer(gradientLayer, at: 0)
    buildUI()
  }

  required init?(coder: NSCoder) { nil }

  override func layout() {
    super.layout()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    gradientLayer.frame = bounds
    CATransaction.commit()
  }

  private func buildUI() {
    brandMark.translatesAutoresizingMaskIntoConstraints = false
    brandTitle.font = .systemFont(ofSize: 17, weight: .bold)
    brandTitle.translatesAutoresizingMaskIntoConstraints = false
    brandSub.font = .systemFont(ofSize: 10)
    brandSub.translatesAutoresizingMaskIntoConstraints = false

    let brandText = NSStackView(views: [brandTitle, brandSub])
    brandText.orientation = .vertical
    brandText.alignment = .leading
    brandText.spacing = 1
    brandText.translatesAutoresizingMaskIntoConstraints = false

    let brandRow = NSStackView(views: [brandMark, brandText])
    brandRow.orientation = .horizontal
    brandRow.alignment = .centerY
    brandRow.spacing = 10
    brandRow.translatesAutoresizingMaskIntoConstraints = false

    navStack.orientation = .vertical
    navStack.alignment = .leading
    navStack.spacing = 2
    navStack.translatesAutoresizingMaskIntoConstraints = false

    let docView = LumenFlippedView()
    docView.translatesAutoresizingMaskIntoConstraints = false
    docView.addSubview(navStack)

    scrollView.documentView = docView
    scrollView.hasVerticalScroller = true
    scrollView.autohidesScrollers = true
    scrollView.drawsBackground = false
    scrollView.borderType = .noBorder
    scrollView.translatesAutoresizingMaskIntoConstraints = false

    addSectionHeader("资料库")
    addActionNavRow(.all, actionGlyph: .all, showCount: true)
    addActionNavRow(.pinned, actionGlyph: .pin, showCount: true)
    addActionNavRow(.recent, actionGlyph: .clock, showCount: false)

    let spacer = NSView()
    spacer.translatesAutoresizingMaskIntoConstraints = false
    spacer.heightAnchor.constraint(equalToConstant: 12).isActive = true
    navStack.addArrangedSubview(spacer)

    // Ten-category navigation: "所有记录" covers `.all`, followed by all 9 logical categories in fixed order (§3.2, §18.2)
    addSectionHeader("内容类型")
    for category in LumenLogicalCategory.filterableCategories {
      addCategoryNavRow(category)
    }

    bottomDivider.wantsLayer = true
    bottomDivider.translatesAutoresizingMaskIntoConstraints = false

    let settingsIcon = NSImageView()
    settingsIcon.imageScaling = .scaleProportionallyDown
    settingsIcon.translatesAutoresizingMaskIntoConstraints = false
    configureNavButton(settingsButton, dest: .settings, title: "偏好设置", iconView: settingsIcon, countLabel: nil)
    buttonsByDest[.settings] = (settingsButton, nil, settingsIcon)

    // §17.3 / A54: No prototype "本地资料库 / xxx 条记录" footer status block.
    // Only the divider and 偏好设置 remain at the bottom of the sidebar.
    addSubview(brandRow)
    addSubview(scrollView)
    addSubview(bottomDivider)
    addSubview(settingsButton)

    NSLayoutConstraint.activate([
      brandMark.widthAnchor.constraint(equalToConstant: 32),
      brandMark.heightAnchor.constraint(equalToConstant: 32),
      brandRow.topAnchor.constraint(equalTo: topAnchor, constant: 14),
      brandRow.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
      brandRow.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),

      scrollView.topAnchor.constraint(equalTo: brandRow.bottomAnchor, constant: 14),
      scrollView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
      scrollView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
      scrollView.bottomAnchor.constraint(equalTo: bottomDivider.topAnchor, constant: -8),

      docView.widthAnchor.constraint(equalTo: scrollView.widthAnchor),
      navStack.topAnchor.constraint(equalTo: docView.topAnchor),
      navStack.leadingAnchor.constraint(equalTo: docView.leadingAnchor),
      navStack.trailingAnchor.constraint(equalTo: docView.trailingAnchor),
      navStack.bottomAnchor.constraint(equalTo: docView.bottomAnchor, constant: -8),

      bottomDivider.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
      bottomDivider.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      bottomDivider.bottomAnchor.constraint(equalTo: settingsButton.topAnchor, constant: -8),
      bottomDivider.heightAnchor.constraint(equalToConstant: 1),

      settingsButton.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
      settingsButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
      settingsButton.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
      settingsButton.heightAnchor.constraint(equalToConstant: 34)
    ])
  }

  private func addSectionHeader(_ text: String) {
    let label = NSTextField(labelWithString: text)
    label.font = .systemFont(ofSize: 11, weight: .medium)
    label.textColor = LumenPalette.current().muted
    label.translatesAutoresizingMaskIntoConstraints = false
    let wrap = NSView()
    wrap.translatesAutoresizingMaskIntoConstraints = false
    wrap.addSubview(label)
    NSLayoutConstraint.activate([
      label.topAnchor.constraint(equalTo: wrap.topAnchor, constant: 4),
      label.bottomAnchor.constraint(equalTo: wrap.bottomAnchor, constant: -4),
      label.leadingAnchor.constraint(equalTo: wrap.leadingAnchor, constant: 10)
    ])
    navStack.addArrangedSubview(wrap)
    wrap.widthAnchor.constraint(equalTo: navStack.widthAnchor).isActive = true
  }

  private func addActionNavRow(_ dest: LumenNavDestination, actionGlyph: LumenActionGlyph, showCount: Bool) {
    let btn = NSButton()
    let icon = NSImageView()
    icon.image = LumenVectorGlyphs.actionImage(actionGlyph, size: 16)
    icon.imageScaling = .scaleProportionallyDown
    icon.translatesAutoresizingMaskIntoConstraints = false
    let countLbl: NSTextField? = showCount ? NSTextField(labelWithString: "0") : nil
    configureNavButton(btn, dest: dest, title: dest.title, iconView: icon, countLabel: countLbl)
    buttonsByDest[dest] = (btn, countLbl, icon)
    navStack.addArrangedSubview(btn)
    btn.widthAnchor.constraint(equalTo: navStack.widthAnchor).isActive = true
    btn.heightAnchor.constraint(equalToConstant: 32).isActive = true
  }

  private func addCategoryNavRow(_ category: LumenLogicalCategory) {
    let dest = LumenNavDestination.category(category)
    let btn = NSButton()
    let glyphView = LumenIdentityGlyphView(size: 17)
    glyphView.translatesAutoresizingMaskIntoConstraints = false
    let countLbl = NSTextField(labelWithString: "0")
    configureNavButton(btn, dest: dest, title: category.label, iconView: glyphView, countLabel: countLbl)
    buttonsByDest[dest] = (btn, countLbl, glyphView)
    navStack.addArrangedSubview(btn)
    btn.widthAnchor.constraint(equalTo: navStack.widthAnchor).isActive = true
    btn.heightAnchor.constraint(equalToConstant: 31).isActive = true
  }

  private func configureNavButton(_ btn: NSButton, dest: LumenNavDestination, title: String, iconView: NSView, countLabel: NSTextField?) {
    btn.title = ""
    btn.isBordered = false
    btn.wantsLayer = true
    btn.layer?.cornerRadius = 9
    btn.layer?.cornerCurve = .continuous
    btn.target = self
    btn.action = #selector(navButtonClicked(_:))
    btn.tag = tagForDestination(dest)
    btn.setAccessibilityLabel(title)
    btn.translatesAutoresizingMaskIntoConstraints = false

    let label = NSTextField(labelWithString: title)
    label.tag = 102
    label.font = .systemFont(ofSize: 12.5, weight: .medium)
    label.lineBreakMode = .byTruncatingTail
    label.translatesAutoresizingMaskIntoConstraints = false

    btn.addSubview(iconView)
    btn.addSubview(label)

    var constraints: [NSLayoutConstraint] = [
      iconView.leadingAnchor.constraint(equalTo: btn.leadingAnchor, constant: 10),
      iconView.centerYAnchor.constraint(equalTo: btn.centerYAnchor),
      iconView.widthAnchor.constraint(equalToConstant: 17),
      iconView.heightAnchor.constraint(equalToConstant: 17),
      label.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: 9),
      label.centerYAnchor.constraint(equalTo: btn.centerYAnchor)
    ]

    if let countLabel {
      countLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
      countLabel.alignment = .right
      countLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
      countLabel.translatesAutoresizingMaskIntoConstraints = false
      btn.addSubview(countLabel)
      constraints.append(contentsOf: [
        countLabel.trailingAnchor.constraint(equalTo: btn.trailingAnchor, constant: -10),
        countLabel.centerYAnchor.constraint(equalTo: btn.centerYAnchor),
        label.trailingAnchor.constraint(lessThanOrEqualTo: countLabel.leadingAnchor, constant: -6)
      ])
    } else {
      constraints.append(label.trailingAnchor.constraint(lessThanOrEqualTo: btn.trailingAnchor, constant: -10))
    }
    NSLayoutConstraint.activate(constraints)
  }

  private func tagForDestination(_ dest: LumenNavDestination) -> Int {
    switch dest {
    case .all: return 1
    case .recent: return 2
    case .pinned: return 3
    case .settings: return 4
    case .category(let cat): return 100 + (LumenLogicalCategory.allCases.firstIndex(of: cat) ?? 0)
    }
  }

  private func destinationForTag(_ tag: Int) -> LumenNavDestination {
    switch tag {
    case 1: return .all
    case 2: return .recent
    case 3: return .pinned
    case 4: return .settings
    default:
      let idx = tag - 100
      if idx >= 0, idx < LumenLogicalCategory.allCases.count {
        return .category(LumenLogicalCategory.allCases[idx])
      }
      return .all
    }
  }

  @objc private func navButtonClicked(_ sender: NSButton) {
    let dest = destinationForTag(sender.tag)
    onSelectDestination?(dest)
  }

  func update(active: LumenNavDestination, items: [LumenClipboardItem], connected: Bool, status: LumenClipboardStatus?, palette: LumenPalette) {
    activeDestination = active
    gradientLayer.colors = [palette.sidebarBackgroundTop.cgColor, palette.sidebarBackgroundBottom.cgColor]
    brandTitle.textColor = palette.ink
    brandSub.textColor = palette.muted
    bottomDivider.layer?.backgroundColor = palette.border.cgColor

    var counts: [LumenLogicalCategory: Int] = [:]
    for item in items {
      counts[item.logicalCategory, default: 0] += 1
    }

    for (dest, tuple) in buttonsByDest {
      let (btn, countLbl, iconView) = tuple
      let isSelected = dest == activeDestination

      // Active state via subtle rounded pill + 1px border (no thick left bar)
      btn.layer?.backgroundColor = (isSelected ? palette.accentSoft : NSColor.clear).cgColor
      btn.layer?.borderWidth = isSelected ? 1 : 0
      btn.layer?.borderColor = (isSelected ? palette.accentBorder : NSColor.clear).cgColor

      switch dest {
      case .category(let cat):
        if let glyph = iconView as? LumenIdentityGlyphView {
          let id = LumenContentIdentityRegistry.shared.identity(forCategory: cat)
          glyph.configure(identity: id, isDark: palette.isDark, size: 17, overrideColor: isSelected ? palette.accent : nil)
        }
      case .all:
        (iconView as? NSImageView)?.image = LumenVectorGlyphs.actionImage(.all, size: 16, color: isSelected ? palette.accent : palette.muted)
      case .pinned:
        (iconView as? NSImageView)?.image = LumenVectorGlyphs.actionImage(isSelected ? .pinFilled : .pin, size: 16, color: isSelected ? palette.accent : palette.muted)
      case .recent:
        (iconView as? NSImageView)?.image = LumenVectorGlyphs.actionImage(.clock, size: 16, color: isSelected ? palette.accent : palette.muted)
      case .settings:
        (iconView as? NSImageView)?.image = LumenVectorGlyphs.actionImage(.settings, size: 16, color: isSelected ? palette.accent : palette.muted)
      }

      if let label = btn.viewWithTag(102) as? NSTextField {
        label.textColor = isSelected ? palette.accent : palette.ink
        label.font = .systemFont(ofSize: 12.5, weight: isSelected ? .semibold : .regular)
      }
      if let countLbl {
        countLbl.textColor = isSelected ? palette.accent : palette.muted
        switch dest {
        case .all: countLbl.stringValue = "\(items.count)"
        case .pinned: countLbl.stringValue = "\(items.filter(\.pinned).count)"
        case .category(let cat): countLbl.stringValue = "\(counts[cat, default: 0])"
        default: break
        }
      }
    }
  }
}

// MARK: - V15 History List Row View (ContentIdentityRegistry Glyphs + Source Column, No Left Bar)

final class LumenHistoryRowView: NSView {
  private let thumbBox = NSView()
  private let thumbImage = NSImageView()
  private let thumbGlyph = LumenIdentityGlyphView(size: 25)
  private let cornerBadge = NSView()
  private let cornerGlyph = LumenIdentityGlyphView(size: 12)
  private let titleLabel = NSTextField(labelWithString: "")
  private let excerptLabel = NSTextField(labelWithString: "")
  private let sourceIconView = NSImageView()
  private let sourceFallback = NSView()
  private let sourceLetter = NSTextField(labelWithString: "")
  private let sourceLabel = NSTextField(labelWithString: "")
  private let timeLabel = NSTextField(labelWithString: "")
  private let pinIcon = NSImageView()

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.cornerRadius = 10
    layer?.cornerCurve = .continuous

    thumbBox.wantsLayer = true
    thumbBox.layer?.cornerRadius = 10
    thumbBox.layer?.cornerCurve = .continuous
    thumbBox.layer?.masksToBounds = true
    thumbBox.layer?.borderWidth = 1
    thumbBox.translatesAutoresizingMaskIntoConstraints = false

    thumbImage.imageScaling = .scaleProportionallyUpOrDown
    thumbImage.translatesAutoresizingMaskIntoConstraints = false
    thumbGlyph.translatesAutoresizingMaskIntoConstraints = false

    cornerBadge.wantsLayer = true
    cornerBadge.layer?.cornerRadius = 4
    cornerBadge.layer?.shadowColor = NSColor(srgbRed: 0.1, green: 0.17, blue: 0.29, alpha: 1).cgColor
    cornerBadge.layer?.shadowOpacity = 0.22
    cornerBadge.layer?.shadowRadius = 2
    cornerBadge.layer?.shadowOffset = NSSize(width: 0, height: -1)
    cornerBadge.isHidden = true
    cornerBadge.translatesAutoresizingMaskIntoConstraints = false
    cornerGlyph.translatesAutoresizingMaskIntoConstraints = false
    cornerBadge.addSubview(cornerGlyph)

    thumbBox.addSubview(thumbImage)
    thumbBox.addSubview(thumbGlyph)
    thumbBox.addSubview(cornerBadge)

    // §18.3 typography: List title 13pt / 600, subtitle 11pt / 400, source 11pt, time 11pt tabular
    titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
    titleLabel.lineBreakMode = .byTruncatingTail
    titleLabel.translatesAutoresizingMaskIntoConstraints = false

    excerptLabel.font = .systemFont(ofSize: 11, weight: .regular)
    excerptLabel.lineBreakMode = .byTruncatingTail
    excerptLabel.translatesAutoresizingMaskIntoConstraints = false

    sourceIconView.imageScaling = .scaleProportionallyDown
    sourceIconView.translatesAutoresizingMaskIntoConstraints = false

    sourceFallback.wantsLayer = true
    sourceFallback.layer?.cornerRadius = 4
    sourceFallback.translatesAutoresizingMaskIntoConstraints = false
    sourceLetter.font = .systemFont(ofSize: 8.5, weight: .bold)
    sourceLetter.textColor = .white
    sourceLetter.alignment = .center
    sourceLetter.translatesAutoresizingMaskIntoConstraints = false
    sourceFallback.addSubview(sourceLetter)

    sourceLabel.font = .systemFont(ofSize: 11, weight: .regular)
    sourceLabel.lineBreakMode = .byTruncatingTail
    sourceLabel.translatesAutoresizingMaskIntoConstraints = false

    timeLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
    timeLabel.alignment = .right
    timeLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
    timeLabel.translatesAutoresizingMaskIntoConstraints = false

    pinIcon.translatesAutoresizingMaskIntoConstraints = false

    for sub in [thumbBox, titleLabel, excerptLabel, sourceIconView, sourceFallback, sourceLabel, timeLabel, pinIcon] {
      addSubview(sub)
    }

    NSLayoutConstraint.activate([
      thumbBox.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
      thumbBox.centerYAnchor.constraint(equalTo: centerYAnchor),
      thumbBox.widthAnchor.constraint(equalToConstant: 40),
      thumbBox.heightAnchor.constraint(equalToConstant: 40),

      thumbImage.topAnchor.constraint(equalTo: thumbBox.topAnchor),
      thumbImage.leadingAnchor.constraint(equalTo: thumbBox.leadingAnchor),
      thumbImage.trailingAnchor.constraint(equalTo: thumbBox.trailingAnchor),
      thumbImage.bottomAnchor.constraint(equalTo: thumbBox.bottomAnchor),

      thumbGlyph.centerXAnchor.constraint(equalTo: thumbBox.centerXAnchor),
      thumbGlyph.centerYAnchor.constraint(equalTo: thumbBox.centerYAnchor),
      thumbGlyph.widthAnchor.constraint(equalToConstant: 25),
      thumbGlyph.heightAnchor.constraint(equalToConstant: 25),

      cornerBadge.trailingAnchor.constraint(equalTo: thumbBox.trailingAnchor, constant: -2),
      cornerBadge.bottomAnchor.constraint(equalTo: thumbBox.bottomAnchor, constant: -2),
      cornerBadge.widthAnchor.constraint(equalToConstant: 15),
      cornerBadge.heightAnchor.constraint(equalToConstant: 15),
      cornerGlyph.centerXAnchor.constraint(equalTo: cornerBadge.centerXAnchor),
      cornerGlyph.centerYAnchor.constraint(equalTo: cornerBadge.centerYAnchor),
      cornerGlyph.widthAnchor.constraint(equalToConstant: 12),
      cornerGlyph.heightAnchor.constraint(equalToConstant: 12),

      titleLabel.topAnchor.constraint(equalTo: topAnchor, constant: 10),
      titleLabel.leadingAnchor.constraint(equalTo: thumbBox.trailingAnchor, constant: 10),
      titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: sourceFallback.leadingAnchor, constant: -10),

      excerptLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 3),
      excerptLabel.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
      excerptLabel.trailingAnchor.constraint(lessThanOrEqualTo: sourceFallback.leadingAnchor, constant: -10),

      sourceIconView.centerYAnchor.constraint(equalTo: centerYAnchor),
      sourceIconView.widthAnchor.constraint(equalToConstant: 15),
      sourceIconView.heightAnchor.constraint(equalToConstant: 15),
      sourceIconView.leadingAnchor.constraint(equalTo: sourceFallback.leadingAnchor),

      sourceFallback.centerYAnchor.constraint(equalTo: centerYAnchor),
      sourceFallback.widthAnchor.constraint(equalToConstant: 15),
      sourceFallback.heightAnchor.constraint(equalToConstant: 15),
      sourceFallback.trailingAnchor.constraint(equalTo: sourceLabel.leadingAnchor, constant: -5),
      sourceLetter.centerXAnchor.constraint(equalTo: sourceFallback.centerXAnchor),
      sourceLetter.centerYAnchor.constraint(equalTo: sourceFallback.centerYAnchor),

      sourceLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
      sourceLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 66),
      sourceLabel.trailingAnchor.constraint(equalTo: timeLabel.leadingAnchor, constant: -10),

      timeLabel.topAnchor.constraint(equalTo: topAnchor, constant: 11),
      timeLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      timeLabel.widthAnchor.constraint(greaterThanOrEqualToConstant: 58),

      pinIcon.topAnchor.constraint(equalTo: timeLabel.bottomAnchor, constant: 5),
      pinIcon.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      pinIcon.widthAnchor.constraint(equalToConstant: 12),
      pinIcon.heightAnchor.constraint(equalToConstant: 12)
    ])
  }

  required init?(coder: NSCoder) { nil }

  func configure(item: LumenClipboardItem, selected: Bool, palette: LumenPalette) {
    let identity = item.contentIdentity
    let tint = identity.tintColor(isDark: palette.isDark)

    layer?.backgroundColor = (selected ? palette.accentSoft : NSColor.clear).cgColor
    layer?.borderWidth = selected ? 1 : 0
    layer?.borderColor = (selected ? palette.accentBorder : NSColor.clear).cgColor

    titleLabel.stringValue = item.displayTitle
    titleLabel.toolTip = item.displayTitle
    titleLabel.textColor = palette.ink

    excerptLabel.textColor = palette.muted
    excerptLabel.stringValue = rowSubtitle(for: item, identity: identity)

    if let appIcon = LumenSourceAppIconCache.shared.icon(for: item) {
      sourceIconView.image = appIcon
      sourceIconView.isHidden = false
      sourceFallback.isHidden = true
    } else {
      sourceIconView.isHidden = true
      sourceFallback.isHidden = false
      sourceFallback.layer?.backgroundColor = palette.sourceBadgeColor(for: item.sourceLabel).cgColor
      sourceLetter.stringValue = item.hasKnownSourceApp ? String(item.sourceLabel.prefix(1)).uppercased() : "?"
    }
    sourceLabel.stringValue = item.sourceLabel
    sourceLabel.toolTip = item.sourceLabel
    sourceLabel.textColor = palette.muted

    timeLabel.stringValue = item.relativeTime
    timeLabel.textColor = palette.muted
    pinIcon.isHidden = !item.pinned
    pinIcon.image = LumenVectorGlyphs.actionImage(.pinFilled, size: 12, color: palette.accent)

    thumbBox.layer?.borderColor = palette.border.withAlphaComponent(0.65).cgColor
    cornerBadge.layer?.backgroundColor = (palette.isDark
      ? NSColor(srgbRed: 0.14, green: 0.18, blue: 0.25, alpha: 0.92)
      : NSColor(srgbRed: 0.96, green: 0.97, blue: 0.98, alpha: 0.94)).cgColor

    if identity.family == .color, let swatch = LumenColorMath.parseAnyColor(item.effectiveText) {
      thumbBox.layer?.backgroundColor = swatch.cgColor
      thumbImage.isHidden = true
      thumbGlyph.isHidden = true
      cornerBadge.isHidden = false
      cornerGlyph.configure(identity: identity, isDark: palette.isDark, size: 12)
    } else if identity.family == .image, let img = item.decodedThumbnailImage() {
      thumbBox.layer?.backgroundColor = palette.surfaceElevated.cgColor
      thumbImage.image = img
      thumbImage.isHidden = false
      thumbGlyph.isHidden = true
      cornerBadge.isHidden = false
      cornerGlyph.configure(identity: identity, isDark: palette.isDark, size: 12)
    } else {
      thumbBox.layer?.backgroundColor = tint.withAlphaComponent(palette.isDark ? 0.14 : 0.09).cgColor
      thumbImage.isHidden = true
      thumbGlyph.isHidden = false
      cornerBadge.isHidden = true
      thumbGlyph.configure(identity: identity, isDark: palette.isDark, size: 25)
    }
  }

  /// Non-repeating subtitle metadata per §18.3 (`v14RowMeta`).
  private func rowSubtitle(for item: LumenClipboardItem, identity: LumenContentIdentity) -> String {
    switch identity.family {
    case .code:
      let lines = max(1, item.effectiveText.split(separator: "\n", omittingEmptySubsequences: false).count)
      return "\(identity.displayName) · \(lines) 行"
    case .link:
      let raw = item.effectiveText.trimmingCharacters(in: .whitespacesAndNewlines)
      return URL(string: raw)?.host ?? raw
    case .color:
      return item.effectiveText.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    case .text:
      if item.kind == "file" {
        return ["文本文件", item.formattedSize].filter { !$0.isEmpty }.joined(separator: " · ")
      }
      let compact = item.effectiveText.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
      return compact == item.displayTitle ? "文本 · \(item.effectiveText.count) 字符" : compact
    default:
      let parts = [identity.displayName, item.formattedSize].filter { !$0.isEmpty }
      return parts.joined(separator: " · ")
    }
  }
}

// MARK: - V15 History Gallery Card (NSCollectionViewItem using ContentIdentityRegistry)

final class LumenGalleryCardItem: NSCollectionViewItem {
  static let reuseID = NSUserInterfaceItemIdentifier("LumenGalleryCardItem")

  private let cardView = NSView()
  private let typeGlyph = LumenIdentityGlyphView(size: 16)
  private let typeLabel = NSTextField(labelWithString: "")
  private let timeLabel = NSTextField(labelWithString: "")
  private let bodyHost = NSView()
  private let sourceIconView = NSImageView()
  private let sourceDot = NSView()
  private let sourceLabel = NSTextField(labelWithString: "")
  private let pinIcon = NSImageView()

  var onSingleClick: ((NSEvent) -> Void)?
  var onDoubleClick: (() -> Void)?
  var onRightClick: ((NSEvent) -> Void)?

  override func loadView() {
    let container = LumenCardClickView()
    container.onClick = { [weak self] event in
      if event.clickCount >= 2 { self?.onDoubleClick?() } else { self?.onSingleClick?(event) }
    }
    container.onRightClick = { [weak self] event in self?.onRightClick?(event) }
    self.view = container

    cardView.wantsLayer = true
    cardView.layer?.cornerRadius = 14
    cardView.layer?.cornerCurve = .continuous
    cardView.layer?.masksToBounds = true
    cardView.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(cardView)

    typeGlyph.translatesAutoresizingMaskIntoConstraints = false

    typeLabel.font = .systemFont(ofSize: 11, weight: .medium)
    typeLabel.lineBreakMode = .byTruncatingTail
    typeLabel.translatesAutoresizingMaskIntoConstraints = false

    timeLabel.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
    timeLabel.alignment = .right
    timeLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
    timeLabel.translatesAutoresizingMaskIntoConstraints = false

    bodyHost.wantsLayer = true
    bodyHost.layer?.masksToBounds = true
    bodyHost.translatesAutoresizingMaskIntoConstraints = false

    sourceIconView.imageScaling = .scaleProportionallyDown
    sourceIconView.translatesAutoresizingMaskIntoConstraints = false

    sourceDot.wantsLayer = true
    sourceDot.layer?.cornerRadius = 4
    sourceDot.translatesAutoresizingMaskIntoConstraints = false

    sourceLabel.font = .systemFont(ofSize: 11, weight: .regular)
    sourceLabel.lineBreakMode = .byTruncatingTail
    sourceLabel.translatesAutoresizingMaskIntoConstraints = false

    pinIcon.translatesAutoresizingMaskIntoConstraints = false

    for sub in [typeGlyph, typeLabel, timeLabel, bodyHost, sourceIconView, sourceDot, sourceLabel, pinIcon] {
      cardView.addSubview(sub)
    }

    NSLayoutConstraint.activate([
      cardView.topAnchor.constraint(equalTo: container.topAnchor, constant: 2),
      cardView.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 2),
      cardView.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -2),
      cardView.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -2),

      typeGlyph.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 10),
      typeGlyph.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
      typeGlyph.widthAnchor.constraint(equalToConstant: 16),
      typeGlyph.heightAnchor.constraint(equalToConstant: 16),

      typeLabel.leadingAnchor.constraint(equalTo: typeGlyph.trailingAnchor, constant: 6),
      typeLabel.centerYAnchor.constraint(equalTo: typeGlyph.centerYAnchor),
      typeLabel.trailingAnchor.constraint(lessThanOrEqualTo: timeLabel.leadingAnchor, constant: -6),

      timeLabel.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
      timeLabel.centerYAnchor.constraint(equalTo: typeGlyph.centerYAnchor),

      bodyHost.topAnchor.constraint(equalTo: typeGlyph.bottomAnchor, constant: 8),
      bodyHost.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
      bodyHost.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
      bodyHost.bottomAnchor.constraint(equalTo: sourceLabel.topAnchor, constant: -8),

      sourceIconView.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
      sourceIconView.bottomAnchor.constraint(equalTo: cardView.bottomAnchor, constant: -9),
      sourceIconView.widthAnchor.constraint(equalToConstant: 14),
      sourceIconView.heightAnchor.constraint(equalToConstant: 14),

      sourceDot.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
      sourceDot.bottomAnchor.constraint(equalTo: cardView.bottomAnchor, constant: -9),
      sourceDot.widthAnchor.constraint(equalToConstant: 14),
      sourceDot.heightAnchor.constraint(equalToConstant: 14),

      sourceLabel.leadingAnchor.constraint(equalTo: sourceDot.trailingAnchor, constant: 6),
      sourceLabel.centerYAnchor.constraint(equalTo: sourceDot.centerYAnchor),
      sourceLabel.trailingAnchor.constraint(lessThanOrEqualTo: pinIcon.leadingAnchor, constant: -6),

      pinIcon.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
      pinIcon.centerYAnchor.constraint(equalTo: sourceDot.centerYAnchor),
      pinIcon.widthAnchor.constraint(equalToConstant: 12),
      pinIcon.heightAnchor.constraint(equalToConstant: 12)
    ])
  }

  func configure(item: LumenClipboardItem, selected: Bool, palette: LumenPalette) {
    let identity = item.contentIdentity
    cardView.layer?.backgroundColor = palette.surface.cgColor
    cardView.layer?.borderWidth = selected ? 1.5 : 1
    cardView.layer?.borderColor = (selected ? palette.accent : palette.border).cgColor

    typeGlyph.configure(identity: identity, isDark: palette.isDark, size: 16)
    typeLabel.stringValue = identity.displayName
    typeLabel.textColor = palette.muted
    timeLabel.stringValue = item.relativeTime
    timeLabel.textColor = palette.muted

    if let appIcon = LumenSourceAppIconCache.shared.icon(for: item) {
      sourceIconView.image = appIcon
      sourceIconView.isHidden = false
      sourceDot.isHidden = true
    } else {
      sourceIconView.isHidden = true
      sourceDot.isHidden = false
      sourceDot.layer?.backgroundColor = palette.sourceBadgeColor(for: item.sourceLabel).cgColor
    }
    sourceLabel.stringValue = item.sourceLabel
    sourceLabel.toolTip = item.sourceLabel
    sourceLabel.textColor = palette.muted
    pinIcon.isHidden = !item.pinned
    pinIcon.image = LumenVectorGlyphs.actionImage(.pinFilled, size: 12, color: palette.accent)

    bodyHost.subviews.forEach { $0.removeFromSuperview() }
    bodyHost.layer?.backgroundColor = NSColor.clear.cgColor
    bodyHost.layer?.cornerRadius = 0

    switch identity.family {
    case .color:
      let swatch = NSView()
      swatch.wantsLayer = true
      swatch.layer?.cornerRadius = 8
      swatch.layer?.backgroundColor = (LumenColorMath.parseAnyColor(item.effectiveText) ?? palette.accent).cgColor
      swatch.translatesAutoresizingMaskIntoConstraints = false
      let hex = NSTextField(labelWithString: item.effectiveText.trimmingCharacters(in: .whitespacesAndNewlines).uppercased())
      hex.font = .monospacedSystemFont(ofSize: 12, weight: .semibold)
      hex.textColor = .white
      hex.translatesAutoresizingMaskIntoConstraints = false
      swatch.addSubview(hex)
      bodyHost.addSubview(swatch)
      NSLayoutConstraint.activate([
        swatch.topAnchor.constraint(equalTo: bodyHost.topAnchor),
        swatch.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        swatch.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        swatch.bottomAnchor.constraint(equalTo: bodyHost.bottomAnchor),
        hex.leadingAnchor.constraint(equalTo: swatch.leadingAnchor, constant: 9),
        hex.bottomAnchor.constraint(equalTo: swatch.bottomAnchor, constant: -8)
      ])

    case .image:
      let box = NSView()
      box.wantsLayer = true
      box.layer?.cornerRadius = 8
      box.layer?.masksToBounds = true
      box.layer?.backgroundColor = palette.surfaceElevated.cgColor
      box.translatesAutoresizingMaskIntoConstraints = false
      let iv = NSImageView(image: item.decodedThumbnailImage() ?? LumenVectorGlyphs.identityImage(for: identity, size: 32, isDark: palette.isDark))
      iv.imageScaling = item.decodedThumbnailImage() != nil ? .scaleProportionallyUpOrDown : .scaleNone
      iv.translatesAutoresizingMaskIntoConstraints = false
      box.addSubview(iv)
      let caption = NSTextField(labelWithString: item.displayTitle)
      caption.font = .systemFont(ofSize: 12, weight: .semibold)
      caption.textColor = palette.ink
      caption.lineBreakMode = .byTruncatingTail
      caption.translatesAutoresizingMaskIntoConstraints = false
      bodyHost.addSubview(box)
      bodyHost.addSubview(caption)
      NSLayoutConstraint.activate([
        box.topAnchor.constraint(equalTo: bodyHost.topAnchor),
        box.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        box.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        box.bottomAnchor.constraint(equalTo: caption.topAnchor, constant: -5),
        iv.topAnchor.constraint(equalTo: box.topAnchor),
        iv.leadingAnchor.constraint(equalTo: box.leadingAnchor),
        iv.trailingAnchor.constraint(equalTo: box.trailingAnchor),
        iv.bottomAnchor.constraint(equalTo: box.bottomAnchor),
        caption.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        caption.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        caption.bottomAnchor.constraint(equalTo: bodyHost.bottomAnchor)
      ])

    case .code:
      let title = NSTextField(labelWithString: item.displayTitle)
      title.font = .systemFont(ofSize: 12, weight: .semibold)
      title.textColor = palette.ink
      title.lineBreakMode = .byTruncatingTail
      title.translatesAutoresizingMaskIntoConstraints = false
      let codeBox = NSView()
      codeBox.wantsLayer = true
      codeBox.layer?.cornerRadius = 8
      codeBox.layer?.masksToBounds = true
      codeBox.layer?.backgroundColor = palette.codeBackground.cgColor
      codeBox.translatesAutoresizingMaskIntoConstraints = false
      let lbl = NSTextField(wrappingLabelWithString: "")
      lbl.attributedStringValue = LumenSyntaxHighlighter.highlight(String(item.effectiveText.prefix(240)), language: identity.language ?? "unknown", fontSize: 10, darkCanvas: true)
      lbl.translatesAutoresizingMaskIntoConstraints = false
      codeBox.addSubview(lbl)
      bodyHost.addSubview(title)
      bodyHost.addSubview(codeBox)
      NSLayoutConstraint.activate([
        title.topAnchor.constraint(equalTo: bodyHost.topAnchor),
        title.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        title.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        codeBox.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 4),
        codeBox.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        codeBox.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        codeBox.bottomAnchor.constraint(equalTo: bodyHost.bottomAnchor),
        lbl.topAnchor.constraint(equalTo: codeBox.topAnchor, constant: 6),
        lbl.leadingAnchor.constraint(equalTo: codeBox.leadingAnchor, constant: 7),
        lbl.trailingAnchor.constraint(equalTo: codeBox.trailingAnchor, constant: -7),
        lbl.bottomAnchor.constraint(lessThanOrEqualTo: codeBox.bottomAnchor, constant: -6)
      ])

    case .document, .audio, .video, .archive, .collection, .file:
      let tile = NSView()
      tile.wantsLayer = true
      tile.layer?.cornerRadius = 8
      tile.layer?.backgroundColor = identity.tintColor(isDark: palette.isDark).withAlphaComponent(palette.isDark ? 0.14 : 0.09).cgColor
      tile.translatesAutoresizingMaskIntoConstraints = false
      let glyph = LumenIdentityGlyphView(size: 36)
      glyph.configure(identity: identity, isDark: palette.isDark, size: 36)
      glyph.translatesAutoresizingMaskIntoConstraints = false
      let meta = NSTextField(labelWithString: item.formattedSize)
      meta.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
      meta.textColor = palette.muted
      let st = NSStackView(views: [glyph, meta])
      st.orientation = .vertical
      st.alignment = .centerX
      st.spacing = 4
      st.translatesAutoresizingMaskIntoConstraints = false
      tile.addSubview(st)
      let caption = NSTextField(labelWithString: item.displayTitle)
      caption.font = .systemFont(ofSize: 12, weight: .semibold)
      caption.textColor = palette.ink
      caption.lineBreakMode = .byTruncatingTail
      caption.translatesAutoresizingMaskIntoConstraints = false
      bodyHost.addSubview(tile)
      bodyHost.addSubview(caption)
      NSLayoutConstraint.activate([
        tile.topAnchor.constraint(equalTo: bodyHost.topAnchor),
        tile.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        tile.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        tile.bottomAnchor.constraint(equalTo: caption.topAnchor, constant: -5),
        glyph.widthAnchor.constraint(equalToConstant: 36),
        glyph.heightAnchor.constraint(equalToConstant: 36),
        st.centerXAnchor.constraint(equalTo: tile.centerXAnchor),
        st.centerYAnchor.constraint(equalTo: tile.centerYAnchor),
        caption.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        caption.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        caption.bottomAnchor.constraint(equalTo: bodyHost.bottomAnchor)
      ])

    default:
      let excerpt = NSTextField(wrappingLabelWithString: String(item.effectiveText.prefix(200)))
      excerpt.font = .systemFont(ofSize: 12.5)
      excerpt.textColor = palette.ink.withAlphaComponent(0.88)
      excerpt.maximumNumberOfLines = 5
      excerpt.lineBreakMode = .byTruncatingTail
      excerpt.translatesAutoresizingMaskIntoConstraints = false
      bodyHost.addSubview(excerpt)
      NSLayoutConstraint.activate([
        excerpt.topAnchor.constraint(equalTo: bodyHost.topAnchor, constant: 2),
        excerpt.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        excerpt.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        excerpt.bottomAnchor.constraint(lessThanOrEqualTo: bodyHost.bottomAnchor)
      ])
    }
  }
}

private final class LumenCardClickView: NSView {
  var onClick: ((NSEvent) -> Void)?
  var onRightClick: ((NSEvent) -> Void)?

  override func mouseDown(with event: NSEvent) {
    onClick?(event)
  }

  override func rightMouseDown(with event: NSEvent) {
    onRightClick?(event)
  }
}

// MARK: - V15 Inspector View (48 DIP Toolbar, 32×32 Hit Targets, 88×34 Copy Button, Zero Redundancy)

final class LumenInspectorView: NSView {
  var onCopySingle: ((LumenClipboardItem) -> Void)?
  var onPreviewSingle: ((LumenClipboardItem) -> Void)?
  var onPinSingle: ((LumenClipboardItem) -> Void)?
  var onEditSingle: ((LumenClipboardItem) -> Void)?
  var onDeleteSingle: ((LumenClipboardItem) -> Void)?
  var onBatchPreview: (([LumenClipboardItem]) -> Void)?
  var onBatchPin: (([LumenClipboardItem]) -> Void)?
  var onBatchDelete: (([LumenClipboardItem]) -> Void)?
  var onClearSelection: (() -> Void)?

  private var currentSingle: LumenClipboardItem?
  private var currentBatch: [LumenClipboardItem] = []
  private weak var activeCopyButton: NSButton?
  private var copyResetWork: DispatchWorkItem?
  private var lastPalette: LumenPalette = .light

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
  }

  required init?(coder: NSCoder) { nil }

  deinit {
    copyResetWork?.cancel()
  }

  func render(single: LumenClipboardItem?, batch: [LumenClipboardItem], palette: LumenPalette) {
    currentSingle = single
    currentBatch = batch
    lastPalette = palette
    copyResetWork?.cancel()
    activeCopyButton = nil
    subviews.forEach { $0.removeFromSuperview() }
    layer?.backgroundColor = palette.windowBackground.cgColor

    if batch.count > 1 {
      buildBatchView(items: batch, palette: palette)
      return
    }
    guard let item = single else {
      let empty = NSTextField(labelWithString: "选择一条记录查看详情")
      empty.font = .systemFont(ofSize: 13)
      empty.textColor = palette.muted
      empty.translatesAutoresizingMaskIntoConstraints = false
      addSubview(empty)
      NSLayoutConstraint.activate([
        empty.centerXAnchor.constraint(equalTo: centerXAnchor),
        empty.centerYAnchor.constraint(equalTo: centerYAnchor)
      ])
      return
    }
    buildSingleView(item: item, palette: palette)
  }

  /// Displays transient check + "已复制" feedback for 1.1s ONLY after a verified copy (§13.1, §13.3).
  func showCopySucceededFeedback() {
    guard let btn = activeCopyButton else { return }
    copyResetWork?.cancel()
    btn.image = LumenVectorGlyphs.actionImage(.check, size: 16, color: .white)
    btn.attributedTitle = NSAttributedString(string: " 已复制", attributes: [
      .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
      .foregroundColor: NSColor.white
    ])
    if LumenMotion.isEnabled, let layer = btn.layer {
      let cx = btn.bounds.midX
      let cy = btn.bounds.midY
      func scaled(_ s: CGFloat) -> NSValue {
        var t = CATransform3DIdentity
        t = CATransform3DTranslate(t, cx, cy, 0)
        t = CATransform3DScale(t, s, s, 1)
        t = CATransform3DTranslate(t, -cx, -cy, 0)
        return NSValue(caTransform3D: t)
      }
      let anim = CAKeyframeAnimation(keyPath: "transform")
      anim.values = [scaled(0.93), scaled(1.035), NSValue(caTransform3D: CATransform3DIdentity)]
      anim.keyTimes = [0, 0.55, 1]
      anim.duration = 0.26
      layer.add(anim, forKey: "copyConfirm")
    }
    let work = DispatchWorkItem { [weak self, weak btn] in
      guard let self, let btn, btn === self.activeCopyButton else { return }
      btn.image = LumenVectorGlyphs.actionImage(.copy, size: 16, color: .white)
      btn.attributedTitle = NSAttributedString(string: " 复制", attributes: [
        .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
        .foregroundColor: NSColor.white
      ])
    }
    copyResetWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.1, execute: work)
  }

  private func buildBatchView(items: [LumenClipboardItem], palette: LumenPalette) {
    let topBar = NSView()
    topBar.translatesAutoresizingMaskIntoConstraints = false
    let title = NSTextField(labelWithString: "多选批量操作")
    title.font = .systemFont(ofSize: 12.5, weight: .semibold)
    title.textColor = palette.ink
    title.translatesAutoresizingMaskIntoConstraints = false

    let cancelBtn = LumenIconActionButton(glyph: .orbitRemoveX, glyphSize: 16, tip: "取消多选")
    cancelBtn.configure(palette: palette)
    cancelBtn.onClick = { [weak self] in self?.onClearSelection?() }
    cancelBtn.translatesAutoresizingMaskIntoConstraints = false

    topBar.addSubview(title)
    topBar.addSubview(cancelBtn)

    let icon = NSImageView(image: LumenVectorGlyphs.actionImage(.all, size: 42, color: palette.accent))
    icon.translatesAutoresizingMaskIntoConstraints = false

    let countTitle = NSTextField(labelWithString: "已选择 \(items.count) 条记录")
    countTitle.font = .systemFont(ofSize: 20, weight: .semibold)
    countTitle.textColor = palette.ink

    let sub = NSTextField(labelWithString: "批量预览、固定或清理当前所选历史记录")
    sub.font = .systemFont(ofSize: 12)
    sub.textColor = palette.muted

    let previewBtn = makeSecondaryButton("批量预览 · \(items.count) 项", glyph: .expand, action: #selector(batchPreviewClicked), palette: palette, danger: false)
    let pinBtn = makeSecondaryButton("批量固定", glyph: .pin, action: #selector(batchPinClicked), palette: palette, danger: false)
    let delBtn = makeSecondaryButton("批量移除", glyph: .trash, action: #selector(batchDeleteClicked), palette: palette, danger: true)

    let rowButtons = NSStackView(views: [pinBtn, delBtn])
    rowButtons.orientation = .horizontal
    rowButtons.spacing = 8

    let centerStack = NSStackView(views: [icon, countTitle, sub, previewBtn, rowButtons])
    centerStack.orientation = .vertical
    centerStack.alignment = .centerX
    centerStack.spacing = 12
    centerStack.setCustomSpacing(20, after: sub)
    centerStack.translatesAutoresizingMaskIntoConstraints = false

    addSubview(topBar)
    addSubview(centerStack)

    NSLayoutConstraint.activate([
      topBar.topAnchor.constraint(equalTo: topAnchor),
      topBar.leadingAnchor.constraint(equalTo: leadingAnchor),
      topBar.trailingAnchor.constraint(equalTo: trailingAnchor),
      topBar.heightAnchor.constraint(equalToConstant: LumenV15Tokens.inspectorToolbarHeight),
      title.leadingAnchor.constraint(equalTo: topBar.leadingAnchor, constant: 17),
      title.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
      cancelBtn.trailingAnchor.constraint(equalTo: topBar.trailingAnchor, constant: -12),
      cancelBtn.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
      cancelBtn.widthAnchor.constraint(equalToConstant: LumenV15Tokens.inspectorActionHitSize),
      cancelBtn.heightAnchor.constraint(equalToConstant: LumenV15Tokens.inspectorActionHitSize),

      previewBtn.widthAnchor.constraint(equalToConstant: 210),
      centerStack.centerXAnchor.constraint(equalTo: centerXAnchor),
      centerStack.centerYAnchor.constraint(equalTo: centerYAnchor)
    ])
  }

  private func buildSingleView(item: LumenClipboardItem, palette: LumenPalette) {
    let identity = item.contentIdentity

    // Top Inspector Toolbar: 48 DIP high, 32×32 hit targets, 18 DIP glyphs, 5 DIP spacing (§13.1, §18.2)
    let topBar = NSView()
    topBar.translatesAutoresizingMaskIntoConstraints = false
    let topLine = NSView()
    topLine.wantsLayer = true
    topLine.layer?.backgroundColor = palette.border.cgColor
    topLine.translatesAutoresizingMaskIntoConstraints = false

    let typeGlyph = LumenIdentityGlyphView(size: 19)
    typeGlyph.configure(identity: identity, isDark: palette.isDark, size: 19)
    typeGlyph.translatesAutoresizingMaskIntoConstraints = false

    // Display semantic identity name directly — no redundant "预览" suffix (§13.1, §18.2)
    let headerTitle = NSTextField(labelWithString: identity.displayName)
    headerTitle.font = .systemFont(ofSize: 12.5, weight: .semibold)
    headerTitle.textColor = palette.ink
    headerTitle.lineBreakMode = .byTruncatingTail
    headerTitle.translatesAutoresizingMaskIntoConstraints = false

    // Order left to right (§13.1): Preview, Pin, Edit, Delete
    let expandBtn = LumenIconActionButton(glyph: .expand, glyphSize: LumenV15Tokens.inspectorActionGlyphSize, tip: "完整预览 (Space)")
    expandBtn.configure(palette: palette)
    expandBtn.onClick = { [weak self] in
      if let current = self?.currentSingle { self?.onPreviewSingle?(current) }
    }

    let pinBtn = LumenIconActionButton(glyph: item.pinned ? .pinFilled : .pin, glyphSize: LumenV15Tokens.inspectorActionGlyphSize, tip: item.pinned ? "取消固定" : "固定")
    pinBtn.configure(palette: palette, toggledOn: item.pinned)
    pinBtn.onClick = { [weak self] in
      if let current = self?.currentSingle { self?.onPinSingle?(current) }
    }

    let isTextEditable = (item.kind == "text" || item.kind == "link")
    let editBtn = LumenIconActionButton(glyph: .edit, glyphSize: LumenV15Tokens.inspectorActionGlyphSize, tip: isTextEditable ? "编辑文本" : "非文本记录不可直接编辑")
    editBtn.configure(palette: palette, enabled: isTextEditable)
    editBtn.onClick = { [weak self] in
      if let current = self?.currentSingle, isTextEditable { self?.onEditSingle?(current) }
    }

    let delBtn = LumenIconActionButton(glyph: .trash, glyphSize: LumenV15Tokens.inspectorActionGlyphSize, tip: "移除记录 (Delete)", isDanger: true)
    delBtn.configure(palette: palette)
    delBtn.onClick = { [weak self] in
      if let current = self?.currentSingle { self?.onDeleteSingle?(current) }
    }

    for btn in [expandBtn, pinBtn, editBtn, delBtn] {
      btn.translatesAutoresizingMaskIntoConstraints = false
      btn.widthAnchor.constraint(equalToConstant: LumenV15Tokens.inspectorActionHitSize).isActive = true
      btn.heightAnchor.constraint(equalToConstant: LumenV15Tokens.inspectorActionHitSize).isActive = true
    }

    let rightTools = NSStackView(views: [expandBtn, pinBtn, editBtn, delBtn])
    rightTools.orientation = .horizontal
    rightTools.spacing = LumenV15Tokens.inspectorActionSpacing
    rightTools.translatesAutoresizingMaskIntoConstraints = false

    topBar.addSubview(typeGlyph)
    topBar.addSubview(headerTitle)
    topBar.addSubview(rightTools)
    topBar.addSubview(topLine)

    // Scrollable middle: Hero + Caption + Source/Time + Non-Redundant Metadata
    let scroll = NSScrollView()
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.drawsBackground = false
    scroll.borderType = .noBorder
    scroll.translatesAutoresizingMaskIntoConstraints = false

    let docView = LumenFlippedView()
    docView.translatesAutoresizingMaskIntoConstraints = false

    let hero = makeHeroPreview(item: item, identity: identity, palette: palette)

    let captionTitle = NSTextField(wrappingLabelWithString: item.displayTitle)
    captionTitle.font = .systemFont(ofSize: 20, weight: .semibold)
    captionTitle.textColor = palette.ink
    captionTitle.isSelectable = true

    let sourceRow = makeSourceTimeRow(item: item, palette: palette)
    let metaRow = makeNonRedundantMetaRow(item: item, identity: identity, palette: palette)

    let middleStack = NSStackView(views: [hero, captionTitle, sourceRow, metaRow])
    middleStack.orientation = .vertical
    middleStack.alignment = .leading
    middleStack.spacing = 7
    middleStack.setCustomSpacing(16, after: hero)
    middleStack.setCustomSpacing(12, after: sourceRow)
    middleStack.translatesAutoresizingMaskIntoConstraints = false

    docView.addSubview(middleStack)
    scroll.documentView = docView

    // Bottom action bar (§13.1, A32): Right-aligned Enter hint + 88×34 content-width Copy button ONLY.
    let bottomBar = NSView()
    bottomBar.wantsLayer = true
    bottomBar.translatesAutoresizingMaskIntoConstraints = false
    let bottomLine = NSView()
    bottomLine.wantsLayer = true
    bottomLine.layer?.backgroundColor = palette.border.cgColor
    bottomLine.translatesAutoresizingMaskIntoConstraints = false

    let enterHint = NSTextField(labelWithString: "Enter")
    enterHint.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
    enterHint.textColor = palette.muted
    enterHint.alignment = .center
    enterHint.wantsLayer = true
    enterHint.layer?.cornerRadius = 5
    enterHint.layer?.borderWidth = 1
    enterHint.layer?.borderColor = palette.border.cgColor
    enterHint.translatesAutoresizingMaskIntoConstraints = false

    let copyBtn = makeCompactCopyButton(palette: palette)
    activeCopyButton = copyBtn

    bottomBar.addSubview(bottomLine)
    bottomBar.addSubview(enterHint)
    bottomBar.addSubview(copyBtn)

    addSubview(topBar)
    addSubview(scroll)
    addSubview(bottomBar)

    NSLayoutConstraint.activate([
      topBar.topAnchor.constraint(equalTo: topAnchor),
      topBar.leadingAnchor.constraint(equalTo: leadingAnchor),
      topBar.trailingAnchor.constraint(equalTo: trailingAnchor),
      topBar.heightAnchor.constraint(equalToConstant: LumenV15Tokens.inspectorToolbarHeight),
      typeGlyph.leadingAnchor.constraint(equalTo: topBar.leadingAnchor, constant: 17),
      typeGlyph.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
      typeGlyph.widthAnchor.constraint(equalToConstant: 19),
      typeGlyph.heightAnchor.constraint(equalToConstant: 19),
      headerTitle.leadingAnchor.constraint(equalTo: typeGlyph.trailingAnchor, constant: 7),
      headerTitle.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
      headerTitle.trailingAnchor.constraint(lessThanOrEqualTo: rightTools.leadingAnchor, constant: -8),
      rightTools.trailingAnchor.constraint(equalTo: topBar.trailingAnchor, constant: -12),
      rightTools.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
      topLine.leadingAnchor.constraint(equalTo: topBar.leadingAnchor),
      topLine.trailingAnchor.constraint(equalTo: topBar.trailingAnchor),
      topLine.bottomAnchor.constraint(equalTo: topBar.bottomAnchor),
      topLine.heightAnchor.constraint(equalToConstant: 1),

      scroll.topAnchor.constraint(equalTo: topBar.bottomAnchor),
      scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
      scroll.bottomAnchor.constraint(equalTo: bottomBar.topAnchor),

      docView.widthAnchor.constraint(equalTo: scroll.widthAnchor),
      middleStack.topAnchor.constraint(equalTo: docView.topAnchor, constant: 14),
      middleStack.leadingAnchor.constraint(equalTo: docView.leadingAnchor, constant: 18),
      middleStack.trailingAnchor.constraint(equalTo: docView.trailingAnchor, constant: -18),
      middleStack.bottomAnchor.constraint(equalTo: docView.bottomAnchor, constant: -16),

      hero.widthAnchor.constraint(equalTo: middleStack.widthAnchor),
      hero.heightAnchor.constraint(greaterThanOrEqualToConstant: 196),
      metaRow.widthAnchor.constraint(equalTo: middleStack.widthAnchor),

      bottomBar.leadingAnchor.constraint(equalTo: leadingAnchor),
      bottomBar.trailingAnchor.constraint(equalTo: trailingAnchor),
      bottomBar.bottomAnchor.constraint(equalTo: bottomAnchor),
      bottomBar.heightAnchor.constraint(equalToConstant: 56),
      bottomLine.topAnchor.constraint(equalTo: bottomBar.topAnchor),
      bottomLine.leadingAnchor.constraint(equalTo: bottomBar.leadingAnchor),
      bottomLine.trailingAnchor.constraint(equalTo: bottomBar.trailingAnchor),
      bottomLine.heightAnchor.constraint(equalToConstant: 1),

      copyBtn.trailingAnchor.constraint(equalTo: bottomBar.trailingAnchor, constant: -18),
      copyBtn.centerYAnchor.constraint(equalTo: bottomBar.centerYAnchor),
      copyBtn.widthAnchor.constraint(greaterThanOrEqualToConstant: LumenV15Tokens.inspectorCopyMinWidth),
      copyBtn.widthAnchor.constraint(lessThanOrEqualToConstant: LumenV15Tokens.inspectorCopyMaxWidth),
      copyBtn.heightAnchor.constraint(equalToConstant: LumenV15Tokens.inspectorCopyHeight),

      enterHint.trailingAnchor.constraint(equalTo: copyBtn.leadingAnchor, constant: -10),
      enterHint.centerYAnchor.constraint(equalTo: copyBtn.centerYAnchor),
      enterHint.widthAnchor.constraint(equalToConstant: 44),
      enterHint.heightAnchor.constraint(equalToConstant: 22)
    ])
  }

  private func makeSourceTimeRow(item: LumenClipboardItem, palette: LumenPalette) -> NSView {
    let row = NSStackView()
    row.orientation = .horizontal
    row.alignment = .centerY
    row.spacing = 6

    if let appIcon = LumenSourceAppIconCache.shared.icon(for: item) {
      let iv = NSImageView(image: appIcon)
      iv.imageScaling = .scaleProportionallyDown
      iv.translatesAutoresizingMaskIntoConstraints = false
      iv.widthAnchor.constraint(equalToConstant: 16).isActive = true
      iv.heightAnchor.constraint(equalToConstant: 16).isActive = true
      row.addArrangedSubview(iv)
    } else {
      let dot = NSView()
      dot.wantsLayer = true
      dot.layer?.cornerRadius = 4
      dot.layer?.backgroundColor = palette.sourceBadgeColor(for: item.sourceLabel).cgColor
      dot.translatesAutoresizingMaskIntoConstraints = false
      dot.widthAnchor.constraint(equalToConstant: 15).isActive = true
      dot.heightAnchor.constraint(equalToConstant: 15).isActive = true
      row.addArrangedSubview(dot)
    }

    let label = NSTextField(labelWithString: "\(item.sourceLabel) · \(item.relativeTime)")
    label.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
    label.textColor = palette.muted
    label.toolTip = item.sourceLabel
    row.addArrangedSubview(label)
    return row
  }

  /// Non-redundant metadata strip (§13.1, A32, S01/S02, A10):
  /// NEVER repeats Content Type, Pin status, or Source App.
  /// Device identifier / name appears ONLY here under "来源设备".
  private func makeNonRedundantMetaRow(item: LumenClipboardItem, identity: LumenContentIdentity, palette: LumenPalette) -> NSView {
    var entries: [(String, String)] = []
    entries.append(("大小", item.formattedSize))
    if identity.family == .code {
      let lines = max(1, item.effectiveText.split(separator: "\n", omittingEmptySubsequences: false).count)
      entries.append(("行数", "\(lines) 行"))
    } else if identity.family == .text {
      entries.append(("字符", "\(item.effectiveText.count)"))
    } else if identity.family == .image && item.width > 0 && item.height > 0 {
      entries.append(("尺寸", "\(item.width) × \(item.height)"))
    }
    if !item.materialized {
      entries.append(("状态", "远端按需拉取"))
    }
    if item.seenCount > 1 {
      entries.append(("次数", "\(item.seenCount) 次"))
    }

    let metricsRow = NSStackView()
    metricsRow.orientation = .horizontal
    metricsRow.alignment = .centerY
    metricsRow.spacing = 18
    metricsRow.translatesAutoresizingMaskIntoConstraints = false

    for (k, v) in entries {
      let kl = NSTextField(labelWithString: k)
      kl.font = .systemFont(ofSize: 11, weight: .regular)
      kl.textColor = palette.muted
      let vl = NSTextField(labelWithString: v)
      vl.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
      vl.textColor = palette.ink
      let pair = NSStackView(views: [kl, vl])
      pair.orientation = .horizontal
      pair.alignment = .firstBaseline
      pair.spacing = 6
      metricsRow.addArrangedSubview(pair)
    }

    guard let deviceName = item.sourceDeviceLabel else {
      return metricsRow
    }

    let container = NSStackView()
    container.orientation = .vertical
    container.alignment = .leading
    container.spacing = 8
    container.translatesAutoresizingMaskIntoConstraints = false
    container.addArrangedSubview(metricsRow)

    let devKey = NSTextField(labelWithString: "来源设备")
    devKey.font = .systemFont(ofSize: 11, weight: .regular)
    devKey.textColor = palette.muted
    devKey.setContentCompressionResistancePriority(.required, for: .horizontal)
    devKey.setContentHuggingPriority(.required, for: .horizontal)

    let devVal = NSTextField(labelWithString: deviceName)
    devVal.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
    devVal.textColor = palette.ink
    devVal.lineBreakMode = .byTruncatingMiddle
    devVal.toolTip = deviceName
    devVal.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    let deviceRow = NSStackView(views: [devKey, devVal])
    deviceRow.orientation = .horizontal
    deviceRow.alignment = .firstBaseline
    deviceRow.spacing = 8
    deviceRow.translatesAutoresizingMaskIntoConstraints = false
    container.addArrangedSubview(deviceRow)
    deviceRow.widthAnchor.constraint(lessThanOrEqualTo: container.widthAnchor).isActive = true

    return container
  }

  private func makeHeroPreview(item: LumenClipboardItem, identity: LumenContentIdentity, palette: LumenPalette) -> NSView {
    let box = LumenCardClickView()
    box.wantsLayer = true
    box.layer?.cornerRadius = 13
    box.layer?.cornerCurve = .continuous
    box.layer?.backgroundColor = palette.surface.cgColor
    box.layer?.borderWidth = 1
    box.layer?.borderColor = palette.border.cgColor
    box.layer?.masksToBounds = true
    box.translatesAutoresizingMaskIntoConstraints = false
    box.toolTip = "单击打开完整预览"
    box.onClick = { [weak self] _ in
      if let current = self?.currentSingle { self?.onPreviewSingle?(current) }
    }

    switch identity.family {
    case .color:
      let parsed = LumenColorMath.parseAnyColor(item.effectiveText) ?? palette.accent
      let swatch = NSView()
      swatch.wantsLayer = true
      swatch.layer?.cornerRadius = 10
      swatch.layer?.backgroundColor = parsed.cgColor
      swatch.translatesAutoresizingMaskIntoConstraints = false
      let hex = NSTextField(labelWithString: LumenColorMath.hexString(from: parsed))
      hex.font = .monospacedSystemFont(ofSize: 20, weight: .semibold)
      hex.textColor = .white
      hex.translatesAutoresizingMaskIntoConstraints = false
      let subVals = NSTextField(labelWithString: "\(LumenColorMath.rgbString(from: parsed))  ·  \(LumenColorMath.hslString(from: parsed))")
      subVals.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
      subVals.textColor = NSColor.white.withAlphaComponent(0.86)
      subVals.translatesAutoresizingMaskIntoConstraints = false
      swatch.addSubview(hex)
      swatch.addSubview(subVals)
      box.addSubview(swatch)
      NSLayoutConstraint.activate([
        swatch.topAnchor.constraint(equalTo: box.topAnchor, constant: 14),
        swatch.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 14),
        swatch.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -14),
        swatch.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -14),
        swatch.heightAnchor.constraint(equalToConstant: 170),
        hex.leadingAnchor.constraint(equalTo: swatch.leadingAnchor, constant: 14),
        hex.bottomAnchor.constraint(equalTo: subVals.topAnchor, constant: -3),
        subVals.leadingAnchor.constraint(equalTo: swatch.leadingAnchor, constant: 14),
        subVals.trailingAnchor.constraint(lessThanOrEqualTo: swatch.trailingAnchor, constant: -14),
        subVals.bottomAnchor.constraint(equalTo: swatch.bottomAnchor, constant: -12)
      ])

    case .image:
      let iv = NSImageView()
      iv.imageScaling = .scaleProportionallyUpOrDown
      iv.image = LumenPreviewCache.shared.image(for: "clip:\(item.id)")
        ?? item.decodedThumbnailImage()
        ?? LumenVectorGlyphs.identityImage(for: identity, size: 48, isDark: palette.isDark)
      iv.translatesAutoresizingMaskIntoConstraints = false
      box.addSubview(iv)
      NSLayoutConstraint.activate([
        iv.topAnchor.constraint(equalTo: box.topAnchor, constant: 14),
        iv.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 14),
        iv.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -14),
        iv.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -14),
        iv.heightAnchor.constraint(equalToConstant: 196)
      ])

    case .code:
      // §18.3 Inspector Code: top-left aligned, 12.5pt, lineHeight 1.75, aligned line numbers, scrollable
      box.layer?.backgroundColor = palette.codeBackground.cgColor
      let codeScroll = NSScrollView()
      codeScroll.hasVerticalScroller = true
      codeScroll.hasHorizontalScroller = true
      codeScroll.autohidesScrollers = true
      codeScroll.drawsBackground = false
      codeScroll.borderType = .noBorder
      codeScroll.translatesAutoresizingMaskIntoConstraints = false

      let codeDoc = LumenFlippedView()
      codeDoc.translatesAutoresizingMaskIntoConstraints = false

      let lines = item.effectiveText.split(separator: "\n", omittingEmptySubsequences: false).prefix(48)
      let gutterText = (1...max(1, lines.count)).map { String($0) }.joined(separator: "\n")
      let gutterParagraph = NSMutableParagraphStyle()
      gutterParagraph.lineHeightMultiple = 1.65
      gutterParagraph.alignment = .right
      let gutterLabel = NSTextField(wrappingLabelWithString: "")
      gutterLabel.attributedStringValue = NSAttributedString(string: gutterText, attributes: [
        .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular),
        .foregroundColor: palette.codeGutterText.withAlphaComponent(0.72),
        .paragraphStyle: gutterParagraph
      ])
      gutterLabel.translatesAutoresizingMaskIntoConstraints = false

      let codeLabel = NSTextField(wrappingLabelWithString: "")
      codeLabel.attributedStringValue = LumenSyntaxHighlighter.highlight(
        lines.joined(separator: "\n"),
        language: identity.language ?? "unknown",
        fontSize: 12.5,
        darkCanvas: true,
        lineHeightMultiple: 1.65
      )
      codeLabel.translatesAutoresizingMaskIntoConstraints = false

      codeDoc.addSubview(gutterLabel)
      codeDoc.addSubview(codeLabel)
      codeScroll.documentView = codeDoc
      box.addSubview(codeScroll)

      NSLayoutConstraint.activate([
        codeScroll.topAnchor.constraint(equalTo: box.topAnchor, constant: 12),
        codeScroll.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 12),
        codeScroll.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -12),
        codeScroll.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -12),
        codeScroll.heightAnchor.constraint(equalToConstant: 210),

        codeDoc.widthAnchor.constraint(greaterThanOrEqualTo: codeScroll.widthAnchor),
        gutterLabel.topAnchor.constraint(equalTo: codeDoc.topAnchor, constant: 2),
        gutterLabel.leadingAnchor.constraint(equalTo: codeDoc.leadingAnchor, constant: 2),
        gutterLabel.widthAnchor.constraint(equalToConstant: 28),
        gutterLabel.bottomAnchor.constraint(lessThanOrEqualTo: codeDoc.bottomAnchor, constant: -4),

        codeLabel.topAnchor.constraint(equalTo: codeDoc.topAnchor, constant: 2),
        codeLabel.leadingAnchor.constraint(equalTo: gutterLabel.trailingAnchor, constant: 12),
        codeLabel.trailingAnchor.constraint(equalTo: codeDoc.trailingAnchor, constant: -6),
        codeLabel.bottomAnchor.constraint(equalTo: codeDoc.bottomAnchor, constant: -4)
      ])

    case .document where identity.subtype == "pdf":
      let iv = NSImageView()
      iv.imageScaling = .scaleProportionallyUpOrDown
      if let path = item.primaryFilePath, let doc = PDFDocument(url: URL(fileURLWithPath: path)), let page = doc.page(at: 0) {
        iv.image = page.thumbnail(of: NSSize(width: 280, height: 360), for: .cropBox)
      } else {
        iv.image = LumenVectorGlyphs.identityImage(for: identity, size: 52, isDark: palette.isDark)
        iv.imageScaling = .scaleNone
      }
      iv.translatesAutoresizingMaskIntoConstraints = false
      box.addSubview(iv)
      NSLayoutConstraint.activate([
        iv.topAnchor.constraint(equalTo: box.topAnchor, constant: 14),
        iv.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -14),
        iv.centerXAnchor.constraint(equalTo: box.centerXAnchor),
        iv.heightAnchor.constraint(equalToConstant: 196),
        iv.widthAnchor.constraint(lessThanOrEqualTo: box.widthAnchor, constant: -28)
      ])

    case .audio, .video:
      let cover = LumenAlbumCoverView()
      cover.seedIndex = abs(item.id.hashValue) % 3
      cover.badgeText = identity.family == .audio ? "AUDIO" : "VIDEO"
      cover.translatesAutoresizingMaskIntoConstraints = false
      box.addSubview(cover)
      NSLayoutConstraint.activate([
        cover.centerXAnchor.constraint(equalTo: box.centerXAnchor),
        cover.topAnchor.constraint(equalTo: box.topAnchor, constant: 18),
        cover.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -18),
        cover.widthAnchor.constraint(equalToConstant: 164),
        cover.heightAnchor.constraint(equalToConstant: 164)
      ])

    case .document, .archive, .collection, .file:
      let glyph = LumenIdentityGlyphView(size: 52)
      glyph.configure(identity: identity, isDark: palette.isDark, size: 52)
      glyph.translatesAutoresizingMaskIntoConstraints = false
      let name = NSTextField(wrappingLabelWithString: item.displayTitle)
      name.font = .systemFont(ofSize: 14.5, weight: .semibold)
      name.textColor = palette.ink
      name.alignment = .center
      let hint = NSTextField(labelWithString: "\(item.formattedSize) · 单击展开预览")
      hint.font = .systemFont(ofSize: 11)
      hint.textColor = palette.muted
      let st = NSStackView(views: [glyph, name, hint])
      st.orientation = .vertical
      st.alignment = .centerX
      st.spacing = 8
      st.translatesAutoresizingMaskIntoConstraints = false
      box.addSubview(st)
      NSLayoutConstraint.activate([
        glyph.widthAnchor.constraint(equalToConstant: 52),
        glyph.heightAnchor.constraint(equalToConstant: 52),
        st.centerXAnchor.constraint(equalTo: box.centerXAnchor),
        st.centerYAnchor.constraint(equalTo: box.centerYAnchor),
        st.leadingAnchor.constraint(greaterThanOrEqualTo: box.leadingAnchor, constant: 18),
        st.trailingAnchor.constraint(lessThanOrEqualTo: box.trailingAnchor, constant: -18)
      ])

    default:
      let paragraph = NSMutableParagraphStyle()
      paragraph.lineHeightMultiple = 1.5
      let lbl = NSTextField(wrappingLabelWithString: "")
      lbl.attributedStringValue = NSAttributedString(string: String(item.effectiveText.prefix(700)), attributes: [
        .font: NSFont.systemFont(ofSize: 13.5, weight: .regular),
        .foregroundColor: palette.ink,
        .paragraphStyle: paragraph
      ])
      lbl.translatesAutoresizingMaskIntoConstraints = false
      box.addSubview(lbl)
      NSLayoutConstraint.activate([
        lbl.topAnchor.constraint(equalTo: box.topAnchor, constant: 16),
        lbl.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 16),
        lbl.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -16),
        lbl.bottomAnchor.constraint(lessThanOrEqualTo: box.bottomAnchor, constant: -16)
      ])
    }
    return box
  }

  private func makeCompactCopyButton(palette: LumenPalette) -> NSButton {
    let btn = NSButton(title: " 复制", target: self, action: #selector(copySingleClicked))
    btn.image = LumenVectorGlyphs.actionImage(.copy, size: 16, color: .white)
    btn.imagePosition = .imageLeading
    btn.isBordered = false
    btn.wantsLayer = true
    btn.toolTip = "复制到剪贴板 (Enter)"
    btn.setAccessibilityLabel("复制到剪贴板")
    btn.attributedTitle = NSAttributedString(string: " 复制", attributes: [
      .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
      .foregroundColor: NSColor.white
    ])
    btn.layer?.cornerRadius = 9
    btn.layer?.cornerCurve = .continuous
    btn.layer?.backgroundColor = NSColor(srgbRed: 0.349, green: 0.427, blue: 0.761, alpha: 1.0).cgColor
    btn.layer?.borderWidth = 1
    btn.layer?.borderColor = NSColor.white.withAlphaComponent(0.14).cgColor
    btn.translatesAutoresizingMaskIntoConstraints = false
    return btn
  }

  private func makeSecondaryButton(_ title: String, glyph: LumenActionGlyph, action: Selector, palette: LumenPalette, danger: Bool) -> NSButton {
    let btn = NSButton(title: " \(title)", target: self, action: action)
    let color = danger ? palette.danger : palette.ink
    btn.image = LumenVectorGlyphs.actionImage(glyph, size: 15, color: color)
    btn.imagePosition = .imageLeading
    btn.isBordered = false
    btn.wantsLayer = true
    btn.attributedTitle = NSAttributedString(string: " \(title)", attributes: [
      .font: NSFont.systemFont(ofSize: 12, weight: .medium),
      .foregroundColor: color
    ])
    btn.layer?.cornerRadius = 9
    btn.layer?.cornerCurve = .continuous
    btn.layer?.backgroundColor = (danger ? palette.dangerSoft : palette.surface).cgColor
    btn.layer?.borderWidth = 1
    btn.layer?.borderColor = (danger ? palette.danger.withAlphaComponent(0.35) : palette.border).cgColor
    btn.translatesAutoresizingMaskIntoConstraints = false
    btn.heightAnchor.constraint(equalToConstant: 34).isActive = true
    return btn
  }

  @objc private func copySingleClicked() { if let item = currentSingle { onCopySingle?(item) } }
  @objc private func batchPreviewClicked() { onBatchPreview?(currentBatch) }
  @objc private func batchPinClicked() { onBatchPin?(currentBatch) }
  @objc private func batchDeleteClicked() { onBatchDelete?(currentBatch) }
}

// MARK: - Native Settings View (Orbit / Appearance / Sync & Data)

final class LumenSettingsView: NSView {
  enum Tab: Int {
    case orbit = 0
    case appearance = 1
    case data = 2
  }

  private let scrollView = NSScrollView()
  private let docView = LumenFlippedView()
  private let rootStack = NSStackView()
  private let tabControl = NSSegmentedControl(labels: ["Orbit 浮层", "外观材质", "同步与数据"], trackingMode: .selectOne, target: nil, action: nil)
  private let bodyStack = NSStackView()
  private var activeTab: Tab = .orbit

  var onPatchServerSettings: (([String: Any]) -> Void)?
  var onApplyPreferences: ((LumenVisualPreferences) -> Void)?
  var onTriggerSync: (() -> Void)?
  var onClearAllItems: (() -> Void)?

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    setupUI()
  }

  required init?(coder: NSCoder) { nil }

  private func setupUI() {
    tabControl.selectedSegment = 0
    tabControl.target = self
    tabControl.action = #selector(tabChanged)
    tabControl.segmentStyle = .rounded
    tabControl.translatesAutoresizingMaskIntoConstraints = false

    bodyStack.orientation = .vertical
    bodyStack.alignment = .leading
    bodyStack.spacing = 14
    bodyStack.translatesAutoresizingMaskIntoConstraints = false

    rootStack.orientation = .vertical
    rootStack.alignment = .leading
    rootStack.spacing = 18
    rootStack.translatesAutoresizingMaskIntoConstraints = false
    rootStack.addArrangedSubview(tabControl)
    rootStack.addArrangedSubview(bodyStack)

    docView.translatesAutoresizingMaskIntoConstraints = false
    docView.addSubview(rootStack)

    scrollView.hasVerticalScroller = true
    scrollView.drawsBackground = false
    scrollView.borderType = .noBorder
    scrollView.documentView = docView
    scrollView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(scrollView)

    NSLayoutConstraint.activate([
      scrollView.topAnchor.constraint(equalTo: topAnchor),
      scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
      scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
      scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),

      docView.widthAnchor.constraint(equalTo: scrollView.widthAnchor),
      rootStack.topAnchor.constraint(equalTo: docView.topAnchor, constant: 22),
      rootStack.centerXAnchor.constraint(equalTo: docView.centerXAnchor),
      rootStack.widthAnchor.constraint(lessThanOrEqualToConstant: 720),
      rootStack.leadingAnchor.constraint(greaterThanOrEqualTo: docView.leadingAnchor, constant: 24),
      rootStack.trailingAnchor.constraint(lessThanOrEqualTo: docView.trailingAnchor, constant: -24),
      rootStack.bottomAnchor.constraint(equalTo: docView.bottomAnchor, constant: -28),

      tabControl.widthAnchor.constraint(equalTo: rootStack.widthAnchor),
      bodyStack.widthAnchor.constraint(equalTo: rootStack.widthAnchor)
    ])
  }

  @objc private func tabChanged() {
    activeTab = Tab(rawValue: tabControl.selectedSegment) ?? .orbit
    reload()
  }

  func reload() {
    let store = LumenClipboardStore.shared
    let palette = LumenPalette.current(store.preferences)
    layer?.backgroundColor = palette.windowBackground.cgColor
    bodyStack.arrangedSubviews.forEach { $0.removeFromSuperview() }

    switch activeTab {
    case .orbit:
      buildOrbitTab(store: store, palette: palette)
    case .appearance:
      buildAppearanceTab(store: store, palette: palette)
    case .data:
      buildDataTab(store: store, palette: palette)
    }
  }

  private func buildOrbitTab(store: LumenClipboardStore, palette: LumenPalette) {
    let hero = LumenMiniOrbitPreviewView()
    hero.translatesAutoresizingMaskIntoConstraints = false
    bodyStack.addArrangedSubview(hero)
    hero.widthAnchor.constraint(equalTo: bodyStack.widthAnchor).isActive = true
    hero.heightAnchor.constraint(equalToConstant: 132).isActive = true

    addHeading("快捷浮层", subtitle: "原生 NSPanel 贴边连续轨道，支持 Optical Dots 3.0 与棉柔光学粒子动效。", palette: palette)

    let posPopup = NSPopUpButton()
    posPopup.addItems(withTitles: ["底部连续轨道", "左侧边栏轨道", "右侧边栏轨道"])
    let posMap = ["bottom", "left", "right"]
    posPopup.selectItem(at: posMap.firstIndex(of: store.settings.quickOrbitPosition) ?? 0)
    posPopup.target = self
    posPopup.action = #selector(orbitPositionChanged(_:))

    let captureSwitch = makeSwitch(on: store.settings.captureEnabled, action: #selector(captureToggled(_:)))
    let particlesSwitch = makeSwitch(on: store.preferences.particles, action: #selector(particlesToggled(_:)))
    let glowSwitch = makeSwitch(on: store.preferences.glow, action: #selector(glowToggled(_:)))
    let motionSwitch = makeSwitch(on: store.preferences.motion, action: #selector(motionToggled(_:)))

    let group = makeSettingsGroup(rows: [
      ("贴边位置", "同步写入服务端配置 quickOrbitPosition，并在菜单栏保持一致。", posPopup),
      ("本机剪贴板自动采集", "开启后后台及 Orbit 激活期间实时记录复制内容。", captureSwitch),
      ("棉柔光学粒子", "卡片移除时的纹理驱动解构粒子与新记录聚合效果。", particlesSwitch),
      ("动态光感", "焦点卡片微光边界、随指针高光与光点唤醒光泽。", glowSwitch),
      ("流畅动效", "关闭后即时切换；始终尊重系统“减弱动态效果”。", motionSwitch)
    ], palette: palette)
    bodyStack.addArrangedSubview(group)
    group.widthAnchor.constraint(equalTo: bodyStack.widthAnchor).isActive = true
  }

  private func buildAppearanceTab(store: LumenClipboardStore, palette: LumenPalette) {
    addHeading("窗口外观", subtitle: "App 管理窗口、Orbit 快捷浮层与 Quick Look 预览窗口共享同一主题。", palette: palette)

    let lightTile = makeThemeTile(title: "冰川玻璃 · 浅色", dark: false, active: store.preferences.theme == .light, palette: palette)
    let darkTile = makeThemeTile(title: "深海玻璃 · 深色", dark: true, active: store.preferences.theme == .dark, palette: palette)
    let row = NSStackView(views: [lightTile, darkTile])
    row.orientation = .horizontal
    row.distribution = .fillEqually
    row.spacing = 14
    bodyStack.addArrangedSubview(row)
    row.widthAnchor.constraint(equalTo: bodyStack.widthAnchor).isActive = true
  }

  private func buildDataTab(store: LumenClipboardStore, palette: LumenPalette) {
    addHeading("同步与数据", subtitle: "通过本机 AIH Server 管理接口持久化；管理密钥仅从本机配置读取。", palette: palette)

    let retentionPopup = NSPopUpButton()
    let retentionValues = [7, 30, 90, 365]
    retentionPopup.addItems(withTitles: ["7 天", "30 天", "90 天", "365 天"])
    retentionPopup.selectItem(at: retentionValues.firstIndex(of: store.settings.retentionDays) ?? 1)
    retentionPopup.target = self
    retentionPopup.action = #selector(retentionChanged(_:))

    let maxItemsPopup = NSPopUpButton()
    let maxValues = [200, 500, 1000, 2000]
    maxItemsPopup.addItems(withTitles: ["200 条", "500 条", "1000 条", "2000 条"])
    maxItemsPopup.selectItem(at: maxValues.firstIndex(of: store.settings.maxItems) ?? 1)
    maxItemsPopup.target = self
    maxItemsPopup.action = #selector(maxItemsChanged(_:))

    let syncSwitch = makeSwitch(on: store.settings.syncEnabled, action: #selector(syncToggled(_:)))

    let serverPopup = NSPopUpButton()
    serverPopup.addItem(withTitle: "未选择目标服务器")
    for server in store.servers {
      serverPopup.addItem(withTitle: "\(server.label) (\(server.endpoint))")
    }
    if let idx = store.servers.firstIndex(where: { $0.id == store.settings.syncTargetProfileId }) {
      serverPopup.selectItem(at: idx + 1)
    }
    serverPopup.target = self
    serverPopup.action = #selector(syncTargetChanged(_:))

    let syncNowBtn = NSButton(title: "立即同步", target: self, action: #selector(syncNowClicked))
    syncNowBtn.bezelStyle = .rounded

    let clearBtn = NSButton(title: "清空当前列表", target: self, action: #selector(clearAllClicked))
    clearBtn.bezelStyle = .rounded

    let originLabel = NSTextField(labelWithString: store.api.config.origin.isEmpty ? "未配置" : store.api.config.origin)
    originLabel.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
    originLabel.textColor = palette.muted

    let deviceLabel = NSTextField(labelWithString: store.status?.deviceName ?? "本机")
    deviceLabel.font = .systemFont(ofSize: 12)
    deviceLabel.textColor = palette.muted

    let group = makeSettingsGroup(rows: [
      ("本机服务端点", "从 IPC 或 ~/.ai_home/aih.db 读取，绝不硬编码密钥。", originLabel),
      ("当前设备", "剪贴板历史来源设备标识。", deviceLabel),
      ("历史保留天数", "超过保留期的未固定记录自动清理。", retentionPopup),
      ("最大条目上限", "本地 SQLite 资料库最大保存条数。", maxItemsPopup),
      ("跨设备加密同步", "启用后自动将新条目同步至选定中继服务器。", syncSwitch),
      ("同步目标服务器", "从 AIH 控制平面服务器配置读取。", serverPopup),
      ("手动同步", "立即执行一次增量双向同步。", syncNowBtn),
      ("清空历史记录", "通过批量删除接口清理当前列表中的所有记录。", clearBtn)
    ], palette: palette)
    bodyStack.addArrangedSubview(group)
    group.widthAnchor.constraint(equalTo: bodyStack.widthAnchor).isActive = true
  }

  private func addHeading(_ title: String, subtitle: String, palette: LumenPalette) {
    let h = NSTextField(labelWithString: title)
    h.font = .systemFont(ofSize: 18, weight: .semibold)
    h.textColor = palette.ink
    let p = NSTextField(wrappingLabelWithString: subtitle)
    p.font = .systemFont(ofSize: 12)
    p.textColor = palette.muted
    bodyStack.addArrangedSubview(h)
    bodyStack.addArrangedSubview(p)
  }

  private func makeSwitch(on: Bool, action: Selector) -> NSSwitch {
    let sw = NSSwitch()
    sw.state = on ? .on : .off
    sw.target = self
    sw.action = action
    return sw
  }

  private func makeSettingsGroup(rows: [(String, String, NSView)], palette: LumenPalette) -> NSView {
    let box = NSView()
    box.wantsLayer = true
    box.layer?.cornerRadius = 12
    box.layer?.cornerCurve = .continuous
    box.layer?.backgroundColor = palette.surface.cgColor
    box.layer?.borderWidth = 1
    box.layer?.borderColor = palette.border.cgColor
    box.translatesAutoresizingMaskIntoConstraints = false

    let stack = NSStackView()
    stack.orientation = .vertical
    stack.spacing = 0
    stack.translatesAutoresizingMaskIntoConstraints = false
    box.addSubview(stack)

    for (idx, item) in rows.enumerated() {
      let row = NSView()
      row.translatesAutoresizingMaskIntoConstraints = false
      let title = NSTextField(labelWithString: item.0)
      title.font = .systemFont(ofSize: 13, weight: .semibold)
      title.textColor = palette.ink
      let desc = NSTextField(wrappingLabelWithString: item.1)
      desc.font = .systemFont(ofSize: 11)
      desc.textColor = palette.muted
      let left = NSStackView(views: [title, desc])
      left.orientation = .vertical
      left.alignment = .leading
      left.spacing = 2
      left.translatesAutoresizingMaskIntoConstraints = false
      let control = item.2
      control.translatesAutoresizingMaskIntoConstraints = false

      row.addSubview(left)
      row.addSubview(control)
      var c: [NSLayoutConstraint] = [
        row.heightAnchor.constraint(greaterThanOrEqualToConstant: 58),
        left.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 16),
        left.topAnchor.constraint(equalTo: row.topAnchor, constant: 10),
        left.bottomAnchor.constraint(equalTo: row.bottomAnchor, constant: -10),
        left.trailingAnchor.constraint(lessThanOrEqualTo: control.leadingAnchor, constant: -16),
        control.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -16),
        control.centerYAnchor.constraint(equalTo: row.centerYAnchor)
      ]
      if idx < rows.count - 1 {
        let sep = NSView()
        sep.wantsLayer = true
        sep.layer?.backgroundColor = palette.border.cgColor
        sep.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(sep)
        c.append(contentsOf: [
          sep.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 16),
          sep.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -16),
          sep.bottomAnchor.constraint(equalTo: row.bottomAnchor),
          sep.heightAnchor.constraint(equalToConstant: 1)
        ])
      }
      NSLayoutConstraint.activate(c)
      stack.addArrangedSubview(row)
      row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }

    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: box.topAnchor),
      stack.leadingAnchor.constraint(equalTo: box.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: box.trailingAnchor),
      stack.bottomAnchor.constraint(equalTo: box.bottomAnchor)
    ])
    return box
  }

  private func makeThemeTile(title: String, dark: Bool, active: Bool, palette: LumenPalette) -> NSView {
    let btn = NSButton(title: "", target: self, action: dark ? #selector(selectDarkTheme) : #selector(selectLightTheme))
    btn.isBordered = false
    btn.wantsLayer = true
    btn.layer?.cornerRadius = 12
    btn.layer?.cornerCurve = .continuous
    btn.layer?.backgroundColor = palette.surface.cgColor
    btn.layer?.borderWidth = active ? 2 : 1
    btn.layer?.borderColor = (active ? palette.accent : palette.border).cgColor
    btn.translatesAutoresizingMaskIntoConstraints = false

    let mock = NSView()
    mock.wantsLayer = true
    mock.layer?.cornerRadius = 7
    mock.layer?.masksToBounds = true
    mock.layer?.backgroundColor = (dark ? LumenPalette.dark.windowBackground : LumenPalette.light.windowBackground).cgColor
    mock.translatesAutoresizingMaskIntoConstraints = false

    let side = NSView()
    side.wantsLayer = true
    side.layer?.backgroundColor = (dark ? LumenPalette.dark.sidebarBackgroundTop : LumenPalette.light.sidebarBackgroundTop).cgColor
    side.translatesAutoresizingMaskIntoConstraints = false
    mock.addSubview(side)

    let label = NSTextField(labelWithString: title)
    label.font = .systemFont(ofSize: 12.5, weight: active ? .semibold : .medium)
    label.textColor = palette.ink
    label.translatesAutoresizingMaskIntoConstraints = false

    btn.addSubview(mock)
    btn.addSubview(label)

    NSLayoutConstraint.activate([
      btn.heightAnchor.constraint(equalToConstant: 118),
      mock.topAnchor.constraint(equalTo: btn.topAnchor, constant: 10),
      mock.leadingAnchor.constraint(equalTo: btn.leadingAnchor, constant: 10),
      mock.trailingAnchor.constraint(equalTo: btn.trailingAnchor, constant: -10),
      mock.heightAnchor.constraint(equalToConstant: 72),
      side.topAnchor.constraint(equalTo: mock.topAnchor),
      side.leadingAnchor.constraint(equalTo: mock.leadingAnchor),
      side.bottomAnchor.constraint(equalTo: mock.bottomAnchor),
      side.widthAnchor.constraint(equalTo: mock.widthAnchor, multiplier: 0.28),
      label.topAnchor.constraint(equalTo: mock.bottomAnchor, constant: 8),
      label.leadingAnchor.constraint(equalTo: btn.leadingAnchor, constant: 12)
    ])
    return btn
  }

  @objc private func orbitPositionChanged(_ sender: NSPopUpButton) {
    let values = ["bottom", "left", "right"]
    let pos = values[max(0, min(values.count - 1, sender.indexOfSelectedItem))]
    onPatchServerSettings?(["quickOrbitPosition": pos])
  }

  @objc private func captureToggled(_ sender: NSSwitch) {
    onPatchServerSettings?(["captureEnabled": sender.state == .on])
  }

  @objc private func particlesToggled(_ sender: NSSwitch) {
    var next = LumenClipboardStore.shared.preferences
    next.particles = sender.state == .on
    onApplyPreferences?(next)
  }

  @objc private func glowToggled(_ sender: NSSwitch) {
    var next = LumenClipboardStore.shared.preferences
    next.glow = sender.state == .on
    onApplyPreferences?(next)
  }

  @objc private func motionToggled(_ sender: NSSwitch) {
    var next = LumenClipboardStore.shared.preferences
    next.motion = sender.state == .on
    onApplyPreferences?(next)
  }

  @objc private func selectLightTheme() {
    var next = LumenClipboardStore.shared.preferences
    next.theme = .light
    onApplyPreferences?(next)
  }

  @objc private func selectDarkTheme() {
    var next = LumenClipboardStore.shared.preferences
    next.theme = .dark
    onApplyPreferences?(next)
  }

  @objc private func retentionChanged(_ sender: NSPopUpButton) {
    let values = [7, 30, 90, 365]
    onPatchServerSettings?(["retentionDays": values[max(0, min(values.count - 1, sender.indexOfSelectedItem))]])
  }

  @objc private func maxItemsChanged(_ sender: NSPopUpButton) {
    let values = [200, 500, 1000, 2000]
    onPatchServerSettings?(["maxItems": values[max(0, min(values.count - 1, sender.indexOfSelectedItem))]])
  }

  @objc private func syncToggled(_ sender: NSSwitch) {
    onPatchServerSettings?(["syncEnabled": sender.state == .on])
  }

  @objc private func syncTargetChanged(_ sender: NSPopUpButton) {
    let idx = sender.indexOfSelectedItem - 1
    let servers = LumenClipboardStore.shared.servers
    let profileID = (idx >= 0 && idx < servers.count) ? servers[idx].id : ""
    onPatchServerSettings?(["syncTargetProfileId": profileID])
  }

  @objc private func syncNowClicked() { onTriggerSync?() }
  @objc private func clearAllClicked() { onClearAllItems?() }
}

/// CoreGraphics miniature Orbit live-material preview inside Settings.
private final class LumenMiniOrbitPreviewView: NSView {
  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.cornerRadius = 13
    layer?.cornerCurve = .continuous
    layer?.masksToBounds = true
  }

  required init?(coder: NSCoder) { nil }

  override func draw(_ dirtyRect: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    let space = CGColorSpaceCreateDeviceRGB()
    let bgColors = [
      NSColor(srgbRed: 0.090, green: 0.149, blue: 0.255, alpha: 1).cgColor,
      NSColor(srgbRed: 0.333, green: 0.447, blue: 0.643, alpha: 1).cgColor,
      NSColor(srgbRed: 0.557, green: 0.510, blue: 0.714, alpha: 1).cgColor
    ] as CFArray
    if let grad = CGGradient(colorsSpace: space, colors: bgColors, locations: [0, 0.58, 1]) {
      ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: bounds.maxY), end: CGPoint(x: bounds.maxX, y: 0), options: [])
    }

    let labelAttrs: [NSAttributedString.Key: Any] = [
      .font: NSFont.monospacedSystemFont(ofSize: 9.5, weight: .semibold),
      .foregroundColor: NSColor.white.withAlphaComponent(0.72),
      .kern: 1.6
    ]
    NSAttributedString(string: "ORBIT / LIVE MATERIAL", attributes: labelAttrs).draw(at: NSPoint(x: 16, y: bounds.height - 24))

    let cardCount = 5
    let cardW: CGFloat = 68
    let cardH: CGFloat = 72
    let gap: CGFloat = 10
    let totalW = CGFloat(cardCount) * cardW + CGFloat(cardCount - 1) * gap
    let startX = (bounds.width - totalW) / 2
    for i in 0..<cardCount {
      let isCenter = i == 2
      let x = startX + CGFloat(i) * (cardW + gap)
      let y: CGFloat = isCenter ? 22 : 12
      let rect = CGRect(x: x, y: y, width: cardW, height: cardH)
      let path = CGPath(roundedRect: rect, cornerWidth: 10, cornerHeight: 10, transform: nil)
      ctx.saveGState()
      ctx.addPath(path)
      ctx.setFillColor(NSColor.white.withAlphaComponent(isCenter ? 0.36 : 0.20).cgColor)
      ctx.fillPath()
      ctx.addPath(path)
      ctx.setStrokeColor(NSColor.white.withAlphaComponent(isCenter ? 0.92 : 0.45).cgColor)
      ctx.setLineWidth(isCenter ? 1.5 : 1.0)
      ctx.strokePath()
      ctx.restoreGState()
    }
  }
}

// MARK: - Compact Floating Toast Banner

final class LumenToastBannerView: NSView {
  private let messageLabel = NSTextField(labelWithString: "")
  private let undoButton = NSButton(title: "撤销", target: nil, action: nil)
  private var hideWork: DispatchWorkItem?
  var onUndo: (() -> Void)?

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.cornerRadius = 12
    layer?.cornerCurve = .continuous
    layer?.backgroundColor = NSColor(srgbRed: 0.125, green: 0.196, blue: 0.302, alpha: 0.94).cgColor
    layer?.borderWidth = 1
    layer?.borderColor = NSColor.white.withAlphaComponent(0.22).cgColor
    isHidden = true
    alphaValue = 0

    messageLabel.font = .systemFont(ofSize: 12, weight: .medium)
    messageLabel.textColor = .white
    messageLabel.translatesAutoresizingMaskIntoConstraints = false

    undoButton.isBordered = false
    undoButton.target = self
    undoButton.action = #selector(undoClicked)
    undoButton.attributedTitle = NSAttributedString(string: "撤销", attributes: [
      .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
      .foregroundColor: NSColor(srgbRed: 0.725, green: 0.851, blue: 1.0, alpha: 1),
      .underlineStyle: NSUnderlineStyle.single.rawValue
    ])
    undoButton.translatesAutoresizingMaskIntoConstraints = false

    let stack = NSStackView(views: [messageLabel, undoButton])
    stack.orientation = .horizontal
    stack.spacing = 10
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)

    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: topAnchor, constant: 9),
      stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -9),
      stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 15),
      stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -15)
    ])
  }

  required init?(coder: NSCoder) { nil }

  func show(message: String, showUndo: Bool = false) {
    hideWork?.cancel()
    messageLabel.stringValue = message
    undoButton.isHidden = !showUndo
    isHidden = false
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = LumenMotion.isEnabled ? 0.18 : 0.01
      self.animator().alphaValue = 1
    }
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      NSAnimationContext.runAnimationGroup({ ctx in
        ctx.duration = LumenMotion.isEnabled ? 0.22 : 0.01
        self.animator().alphaValue = 0
      }, completionHandler: { [weak self] in
        self?.isHidden = true
      })
    }
    hideWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 3.2, execute: work)
  }

  @objc private func undoClicked() {
    hideWork?.cancel()
    isHidden = true
    alphaValue = 0
    onUndo?()
  }
}

// MARK: - Native New / Edit Text Clip Sheet

final class LumenNewClipSheet: NSObject {
  private let sheet: NSWindow
  private let heading = NSTextField(labelWithString: "输入文本、代码或链接")
  private let textView = NSTextView()
  private var onSave: ((String) -> Void)?

  override init() {
    sheet = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 480, height: 290),
      styleMask: [.titled, .closable],
      backing: .buffered,
      defer: false
    )
    super.init()
    sheet.title = "新建剪贴板记录"
    buildUI()
  }

  private func buildUI() {
    let root = NSView(frame: NSRect(x: 0, y: 0, width: 480, height: 290))
    heading.font = .systemFont(ofSize: 14, weight: .semibold)
    heading.translatesAutoresizingMaskIntoConstraints = false

    textView.isEditable = true
    textView.isSelectable = true
    textView.isRichText = false
    textView.font = .systemFont(ofSize: 13)
    textView.textContainerInset = NSSize(width: 8, height: 8)

    let scroll = NSScrollView()
    scroll.hasVerticalScroller = true
    scroll.borderType = .bezelBorder
    scroll.documentView = textView
    scroll.translatesAutoresizingMaskIntoConstraints = false

    let cancelBtn = NSButton(title: "取消", target: self, action: #selector(cancelClicked))
    cancelBtn.bezelStyle = .rounded
    cancelBtn.keyEquivalent = "\u{1b}"
    let saveBtn = NSButton(title: "保存", target: self, action: #selector(saveClicked))
    saveBtn.bezelStyle = .rounded
    saveBtn.keyEquivalent = "\r"

    let buttons = NSStackView(views: [cancelBtn, saveBtn])
    buttons.orientation = .horizontal
    buttons.spacing = 8
    buttons.translatesAutoresizingMaskIntoConstraints = false

    root.addSubview(heading)
    root.addSubview(scroll)
    root.addSubview(buttons)

    NSLayoutConstraint.activate([
      heading.topAnchor.constraint(equalTo: root.topAnchor, constant: 18),
      heading.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),

      scroll.topAnchor.constraint(equalTo: heading.bottomAnchor, constant: 10),
      scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
      scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
      scroll.bottomAnchor.constraint(equalTo: buttons.topAnchor, constant: -14),

      buttons.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
      buttons.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -16)
    ])
    sheet.contentView = root
  }

  func present(over parent: NSWindow, initialText: String = "", title: String = "新建剪贴板记录", palette: LumenPalette, completion: @escaping (String) -> Void) {
    onSave = completion
    sheet.title = title
    heading.stringValue = initialText.isEmpty ? "输入文本、代码或链接" : "编辑记录内容"
    sheet.appearance = palette.nsAppearance
    textView.string = initialText
    parent.beginSheet(sheet, completionHandler: nil)
    sheet.makeFirstResponder(textView)
  }

  @objc private func cancelClicked() {
    sheet.sheetParent?.endSheet(sheet)
  }

  @objc private func saveClicked() {
    let text = textView.string
    sheet.sheetParent?.endSheet(sheet)
    if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      onSave?(text)
    }
  }
}
