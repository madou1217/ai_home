import AppKit
import QuartzCore

/// AIH HUD palette shared across the macOS launcher surface (§2.4).
enum LauncherPalette {
  static let background = NSColor(srgbRed: 0.031, green: 0.043, blue: 0.082, alpha: 0.90)
  static let panelTop = NSColor(srgbRed: 0.063, green: 0.090, blue: 0.153, alpha: 0.88)
  static let panelBottom = NSColor(srgbRed: 0.031, green: 0.043, blue: 0.082, alpha: 0.94)
  static let cyan = NSColor(srgbRed: 0.384, green: 0.929, blue: 1.0, alpha: 1.0)
  static let purple = NSColor(srgbRed: 0.694, green: 0.545, blue: 1.0, alpha: 1.0)
  static let textPrimary = NSColor(srgbRed: 0.910, green: 0.929, blue: 0.973, alpha: 1.0)
  static let textMuted = NSColor(srgbRed: 0.518, green: 0.576, blue: 0.682, alpha: 1.0)
  static let textHint = NSColor(srgbRed: 0.431, green: 0.498, blue: 0.608, alpha: 1.0)
  static let separator = NSColor(srgbRed: 0.384, green: 0.929, blue: 1.0, alpha: 0.14)
  static let errorSoft = NSColor(srgbRed: 1.0, green: 0.56, blue: 0.56, alpha: 0.95)
}

/// Non-activating panel subclass that routes navigation/confirm/escape keys consistently.
final class LauncherHostPanel: NSPanel {
  var onKeyEvent: ((NSEvent) -> Bool)?
  var onCancel: (() -> Void)?

  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }

  override func sendEvent(_ event: NSEvent) {
    if event.type == .keyDown, let handler = onKeyEvent, handler(event) { return }
    super.sendEvent(event)
  }

  override func cancelOperation(_ sender: Any?) {
    onCancel?()
  }
}

/// Frosted dark glass surface with rounded clipping, subtle top cyan inner glow, and 1px full cyan border.
final class LauncherBackdropView: NSView {
  private let effectView = NSVisualEffectView()
  private let overlayView = LauncherGlassOverlayView()

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    appearance = NSAppearance(named: .darkAqua)
    layer?.cornerRadius = 16
    layer?.cornerCurve = .continuous
    layer?.masksToBounds = true
    layer?.borderWidth = 1
    layer?.borderColor = LauncherPalette.cyan.withAlphaComponent(0.36).cgColor

    effectView.material = .hudWindow
    effectView.blendingMode = .behindWindow
    effectView.state = .active
    effectView.appearance = NSAppearance(named: .darkAqua)
    effectView.translatesAutoresizingMaskIntoConstraints = false

    overlayView.translatesAutoresizingMaskIntoConstraints = false

    addSubview(effectView)
    addSubview(overlayView)
    NSLayoutConstraint.activate([
      effectView.topAnchor.constraint(equalTo: topAnchor),
      effectView.leadingAnchor.constraint(equalTo: leadingAnchor),
      effectView.trailingAnchor.constraint(equalTo: trailingAnchor),
      effectView.bottomAnchor.constraint(equalTo: bottomAnchor),
      overlayView.topAnchor.constraint(equalTo: topAnchor),
      overlayView.leadingAnchor.constraint(equalTo: leadingAnchor),
      overlayView.trailingAnchor.constraint(equalTo: trailingAnchor),
      overlayView.bottomAnchor.constraint(equalTo: bottomAnchor)
    ])
  }

  required init?(coder: NSCoder) { nil }
}

/// Draws the dark translucent gradient and top cyan/purple inner ambient glow without blocking hit-testing.
private final class LauncherGlassOverlayView: NSView {
  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  override func draw(_ dirtyRect: NSRect) {
    let baseGradient = NSGradient(colors: [LauncherPalette.panelTop, LauncherPalette.panelBottom])
    baseGradient?.draw(in: bounds, angle: -90)

    let cyanGlow = NSGradient(colors: [
      LauncherPalette.cyan.withAlphaComponent(0.11),
      LauncherPalette.cyan.withAlphaComponent(0.0)
    ])
    let cyanRect = NSRect(x: bounds.minX, y: bounds.maxY - 170, width: bounds.width * 0.65, height: 170)
    cyanGlow?.draw(in: cyanRect, relativeCenterPosition: NSPoint(x: -0.65, y: 1.0))

    let purpleGlow = NSGradient(colors: [
      LauncherPalette.purple.withAlphaComponent(0.07),
      LauncherPalette.purple.withAlphaComponent(0.0)
    ])
    let purpleRect = NSRect(x: bounds.maxX - bounds.width * 0.5, y: bounds.maxY - 140, width: bounds.width * 0.5, height: 140)
    purpleGlow?.draw(in: purpleRect, relativeCenterPosition: NSPoint(x: 0.7, y: 1.0))

    // Subtle 1px full-perimeter inner sheen inside the outer cyan border.
    let insetRect = bounds.insetBy(dx: 1.5, dy: 1.5)
    let innerPath = NSBezierPath(roundedRect: insetRect, xRadius: 14.5, yRadius: 14.5)
    LauncherPalette.cyan.withAlphaComponent(0.10).setStroke()
    innerPath.lineWidth = 1
    innerPath.stroke()
  }
}

/// Top eyebrow (`AIH LAUNCH`) + result counter and borderless 21pt search input row.
final class LauncherSearchHeaderView: NSView {
  let eyebrowLabel = NSTextField(labelWithString: "AIH LAUNCH")
  let countLabel = NSTextField(labelWithString: "")
  let searchIcon = NSImageView()
  let searchField = NSTextField()
  private let separatorView = NSView()

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true

    eyebrowLabel.font = .monospacedSystemFont(ofSize: 9.5, weight: .semibold)
    eyebrowLabel.textColor = LauncherPalette.cyan.withAlphaComponent(0.88)

    countLabel.font = .monospacedSystemFont(ofSize: 10.5, weight: .regular)
    countLabel.textColor = LauncherPalette.textMuted
    countLabel.alignment = .right
    countLabel.lineBreakMode = .byTruncatingTail

    if let symbol = NSImage(systemSymbolName: "magnifyingglass", accessibilityDescription: "搜索") {
      searchIcon.image = symbol.withSymbolConfiguration(.init(pointSize: 17, weight: .medium))
    }
    searchIcon.contentTintColor = LauncherPalette.cyan.withAlphaComponent(0.82)
    searchIcon.imageScaling = .scaleProportionallyDown

    searchField.isEditable = true
    searchField.isSelectable = true
    searchField.isBordered = false
    searchField.isBezeled = false
    searchField.drawsBackground = false
    searchField.focusRingType = .none
    searchField.font = .systemFont(ofSize: 21, weight: .regular)
    searchField.textColor = LauncherPalette.textPrimary
    searchField.usesSingleLineMode = true
    searchField.cell?.isScrollable = true
    searchField.lineBreakMode = .byTruncatingTail
    searchField.placeholderAttributedString = NSAttributedString(
      string: "搜索应用…",
      attributes: [
        .foregroundColor: LauncherPalette.textMuted.withAlphaComponent(0.75),
        .font: NSFont.systemFont(ofSize: 21, weight: .regular)
      ]
    )

    separatorView.wantsLayer = true
    separatorView.layer?.backgroundColor = LauncherPalette.separator.cgColor

    for view in [eyebrowLabel, countLabel, searchIcon, searchField, separatorView] {
      view.translatesAutoresizingMaskIntoConstraints = false
      addSubview(view)
    }

    NSLayoutConstraint.activate([
      eyebrowLabel.topAnchor.constraint(equalTo: topAnchor, constant: 13),
      eyebrowLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),

      countLabel.centerYAnchor.constraint(equalTo: eyebrowLabel.centerYAnchor),
      countLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
      countLabel.leadingAnchor.constraint(greaterThanOrEqualTo: eyebrowLabel.trailingAnchor, constant: 12),

      searchIcon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
      searchIcon.topAnchor.constraint(equalTo: eyebrowLabel.bottomAnchor, constant: 12),
      searchIcon.widthAnchor.constraint(equalToConstant: 20),
      searchIcon.heightAnchor.constraint(equalToConstant: 20),

      searchField.leadingAnchor.constraint(equalTo: searchIcon.trailingAnchor, constant: 12),
      searchField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
      searchField.centerYAnchor.constraint(equalTo: searchIcon.centerYAnchor),
      searchField.heightAnchor.constraint(equalToConstant: 28),

      separatorView.topAnchor.constraint(equalTo: searchField.bottomAnchor, constant: 11),
      separatorView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      separatorView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
      separatorView.heightAnchor.constraint(equalToConstant: 1),
      separatorView.bottomAnchor.constraint(equalTo: bottomAnchor)
    ])
  }

  required init?(coder: NSCoder) { nil }
}

/// Transparent table row container so the sliding highlight layer behind rows renders cleanly.
final class LauncherTableRowView: NSTableRowView {
  override var isEmphasized: Bool {
    get { false }
    set {}
  }

  override func drawBackground(in dirtyRect: NSRect) {}
  override func drawSelection(in dirtyRect: NSRect) {}
}

/// Table view subclass forwarding keyboard navigation before AppKit type-select.
final class LauncherTableView: NSTableView {
  var keyHandler: ((NSEvent) -> Bool)?

  override func keyDown(with event: NSEvent) {
    if keyHandler?(event) == true { return }
    super.keyDown(with: event)
  }
}

/// Single application row: 36px rounded icon, 15pt semibold name with cyan match highlights,
/// 12pt muted subtitle, and right-aligned `↵` indicator shown when selected.
final class LauncherRowView: NSTableCellView {
  private let iconContainer = NSView()
  private let iconView = NSImageView()
  private let nameLabel = NSTextField(labelWithString: "")
  private let subtitleLabel = NSTextField(labelWithString: "")
  private let enterBadgeBox = NSView()
  private let enterBadge = NSTextField(labelWithString: "↵")
  private var representedAppID = ""

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true

    iconContainer.wantsLayer = true
    iconContainer.layer?.cornerRadius = 9
    iconContainer.layer?.cornerCurve = .continuous
    iconContainer.layer?.masksToBounds = true
    iconContainer.layer?.backgroundColor = NSColor(srgbRed: 0.10, green: 0.15, blue: 0.24, alpha: 0.55).cgColor

    iconView.imageScaling = .scaleProportionallyUpOrDown
    iconView.translatesAutoresizingMaskIntoConstraints = false
    iconContainer.addSubview(iconView)

    nameLabel.font = .systemFont(ofSize: 15, weight: .semibold)
    nameLabel.textColor = LauncherPalette.textPrimary
    nameLabel.lineBreakMode = .byTruncatingTail
    nameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    subtitleLabel.font = .systemFont(ofSize: 12, weight: .regular)
    subtitleLabel.textColor = LauncherPalette.textMuted
    subtitleLabel.lineBreakMode = .byTruncatingMiddle
    subtitleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    enterBadgeBox.wantsLayer = true
    enterBadgeBox.layer?.cornerRadius = 6
    enterBadgeBox.layer?.cornerCurve = .continuous
    enterBadgeBox.layer?.backgroundColor = LauncherPalette.cyan.withAlphaComponent(0.14).cgColor
    enterBadgeBox.layer?.borderWidth = 1
    enterBadgeBox.layer?.borderColor = LauncherPalette.cyan.withAlphaComponent(0.35).cgColor
    enterBadgeBox.alphaValue = 0

    enterBadge.font = .monospacedSystemFont(ofSize: 12.5, weight: .semibold)
    enterBadge.textColor = LauncherPalette.cyan
    enterBadge.alignment = .center
    enterBadge.translatesAutoresizingMaskIntoConstraints = false
    enterBadgeBox.addSubview(enterBadge)

    for view in [iconContainer, nameLabel, subtitleLabel, enterBadgeBox] {
      view.translatesAutoresizingMaskIntoConstraints = false
      addSubview(view)
    }

    NSLayoutConstraint.activate([
      iconContainer.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
      iconContainer.centerYAnchor.constraint(equalTo: centerYAnchor),
      iconContainer.widthAnchor.constraint(equalToConstant: 36),
      iconContainer.heightAnchor.constraint(equalToConstant: 36),

      iconView.topAnchor.constraint(equalTo: iconContainer.topAnchor),
      iconView.leadingAnchor.constraint(equalTo: iconContainer.leadingAnchor),
      iconView.trailingAnchor.constraint(equalTo: iconContainer.trailingAnchor),
      iconView.bottomAnchor.constraint(equalTo: iconContainer.bottomAnchor),

      enterBadgeBox.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
      enterBadgeBox.centerYAnchor.constraint(equalTo: centerYAnchor),
      enterBadgeBox.widthAnchor.constraint(equalToConstant: 26),
      enterBadgeBox.heightAnchor.constraint(equalToConstant: 22),

      enterBadge.centerXAnchor.constraint(equalTo: enterBadgeBox.centerXAnchor),
      enterBadge.centerYAnchor.constraint(equalTo: enterBadgeBox.centerYAnchor),

      nameLabel.leadingAnchor.constraint(equalTo: iconContainer.trailingAnchor, constant: 12),
      nameLabel.topAnchor.constraint(equalTo: topAnchor, constant: 7),
      nameLabel.trailingAnchor.constraint(lessThanOrEqualTo: enterBadgeBox.leadingAnchor, constant: -10),

      subtitleLabel.leadingAnchor.constraint(equalTo: nameLabel.leadingAnchor),
      subtitleLabel.topAnchor.constraint(equalTo: nameLabel.bottomAnchor, constant: 2),
      subtitleLabel.trailingAnchor.constraint(lessThanOrEqualTo: enterBadgeBox.leadingAnchor, constant: -10)
    ])
  }

  required init?(coder: NSCoder) { nil }

  func apply(_ match: LauncherMatchResult, iconCache: LauncherIconCache, selected: Bool) {
    let app = match.app
    representedAppID = app.id

    let attributed = NSMutableAttributedString(
      string: app.name,
      attributes: [
        .font: NSFont.systemFont(ofSize: 15, weight: .semibold),
        .foregroundColor: LauncherPalette.textPrimary
      ]
    )
    let utf16Length = (app.name as NSString).length
    for range in match.matchedRanges where range.location >= 0 && NSMaxRange(range) <= utf16Length {
      attributed.addAttributes([
        .foregroundColor: LauncherPalette.cyan,
        .font: NSFont.systemFont(ofSize: 15, weight: .bold)
      ], range: range)
    }
    nameLabel.attributedStringValue = attributed
    subtitleLabel.stringValue = app.subtitle.isEmpty ? "应用程序" : app.subtitle
    setSelected(selected, animated: false)

    let iconPath = app.icon.isEmpty ? app.path : app.icon
    if let cached = iconCache.cachedIcon(for: iconPath) {
      iconView.contentTintColor = nil
      iconView.image = cached
    } else {
      iconView.image = NSImage(systemSymbolName: "app.fill", accessibilityDescription: nil)
      iconView.contentTintColor = LauncherPalette.textMuted
      let expectedID = app.id
      iconCache.loadIcon(for: iconPath) { [weak self] image in
        guard let self, self.representedAppID == expectedID else { return }
        self.iconView.contentTintColor = nil
        self.iconView.image = image
      }
    }
  }

  func setSelected(_ selected: Bool, animated: Bool) {
    let targetAlpha: CGFloat = selected ? 1.0 : 0.0
    if animated {
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = 0.11
        ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
        self.enterBadgeBox.animator().alphaValue = targetAlpha
      }
    } else {
      enterBadgeBox.alphaValue = targetAlpha
    }
  }
}

/// Inline empty/loading indicator (never a large Alert box).
final class LauncherEmptyStateView: NSView {
  private let glyph = NSImageView()
  private let label = NSTextField(labelWithString: "没有找到应用")

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    if let symbol = NSImage(systemSymbolName: "magnifyingglass", accessibilityDescription: nil) {
      glyph.image = symbol.withSymbolConfiguration(.init(pointSize: 20, weight: .regular))
    }
    glyph.contentTintColor = LauncherPalette.textMuted.withAlphaComponent(0.75)

    label.font = .systemFont(ofSize: 13.5, weight: .medium)
    label.textColor = LauncherPalette.textMuted
    label.alignment = .center

    let stack = NSStackView(views: [glyph, label])
    stack.orientation = .horizontal
    stack.alignment = .centerY
    stack.spacing = 8
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)

    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: centerYAnchor)
    ])
  }

  required init?(coder: NSCoder) { nil }

  func setMessage(_ text: String, symbol: String = "magnifyingglass") {
    label.stringValue = text
    if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) {
      glyph.image = image.withSymbolConfiguration(.init(pointSize: 18, weight: .regular))
    }
  }
}

/// Compact bottom bar with keyboard hints on the left and inline weak status on the right.
final class LauncherFooterView: NSView {
  private let separatorView = NSView()
  let hintsLabel = NSTextField(labelWithString: "↑↓ 选择    ↵ 打开    esc 关闭    ⌥Space 切换")
  let statusLabel = NSTextField(labelWithString: "")

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true

    separatorView.wantsLayer = true
    separatorView.layer?.backgroundColor = LauncherPalette.separator.cgColor

    hintsLabel.font = .systemFont(ofSize: 10.5, weight: .regular)
    hintsLabel.textColor = LauncherPalette.textHint
    hintsLabel.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)

    statusLabel.font = .systemFont(ofSize: 10.5, weight: .medium)
    statusLabel.textColor = LauncherPalette.textMuted
    statusLabel.alignment = .right
    statusLabel.lineBreakMode = .byTruncatingTail
    statusLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    for view in [separatorView, hintsLabel, statusLabel] {
      view.translatesAutoresizingMaskIntoConstraints = false
      addSubview(view)
    }

    NSLayoutConstraint.activate([
      separatorView.topAnchor.constraint(equalTo: topAnchor),
      separatorView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      separatorView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
      separatorView.heightAnchor.constraint(equalToConstant: 1),

      hintsLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
      hintsLabel.centerYAnchor.constraint(equalTo: centerYAnchor, constant: 1),

      statusLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
      statusLabel.centerYAnchor.constraint(equalTo: hintsLabel.centerYAnchor),
      statusLabel.leadingAnchor.constraint(greaterThanOrEqualTo: hintsLabel.trailingAnchor, constant: 12),

      heightAnchor.constraint(equalToConstant: 32)
    ])
  }

  required init?(coder: NSCoder) { nil }

  func setStatus(_ message: String, isError: Bool = false) {
    statusLabel.stringValue = message
    statusLabel.textColor = isError ? LauncherPalette.errorSoft : LauncherPalette.textMuted
  }
}
