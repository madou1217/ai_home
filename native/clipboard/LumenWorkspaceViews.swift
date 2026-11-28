import AppKit
import CoreGraphics
import Foundation
import PDFKit
import QuartzCore

/// Top-down flipped container for NSScrollView document views so scroll starts at top.
final class LumenFlippedView: NSView {
  override var isFlipped: Bool { true }
}

/// Sidebar navigation destinations matching Lumen V7.
enum LumenNavDestination: Hashable {
  case all
  case recent
  case pinned
  case category(LumenDisplayCategory)
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

// MARK: - Sidebar View

final class LumenSidebarView: NSView {
  private let gradientLayer = CAGradientLayer()
  private let brandMark = LumenBrandMarkView()
  private let brandTitle = NSTextField(labelWithString: "Lumen")
  private let brandSub = NSTextField(labelWithString: "Clipboard, reimagined.")
  private let scrollView = NSScrollView()
  private let navStack = NSStackView()
  private let bottomDivider = NSView()
  private let settingsButton = NSButton()
  private let statusDot = NSView()
  private let statusTitle = NSTextField(labelWithString: "本地资料库")
  private let statusSub = NSTextField(labelWithString: "等待连接")

  private var buttonsByDest: [LumenNavDestination: (NSButton, NSTextField?)] = [:]
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
    navStack.spacing = 3
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
    addNavRow(.all, symbol: "square.stack.3d.up", showCount: true)
    addNavRow(.recent, symbol: "clock", showCount: false)
    addNavRow(.pinned, symbol: "pin", showCount: true)

    let spacer = NSView()
    spacer.translatesAutoresizingMaskIntoConstraints = false
    spacer.heightAnchor.constraint(equalToConstant: 12).isActive = true
    navStack.addArrangedSubview(spacer)

    addSectionHeader("智能分类")
    for category in LumenDisplayCategory.allCases {
      addNavRow(.category(category), symbol: category.symbolName, showCount: true)
    }

    bottomDivider.wantsLayer = true
    bottomDivider.translatesAutoresizingMaskIntoConstraints = false

    configureNavButton(settingsButton, dest: .settings, title: "偏好设置", symbol: "gearshape", countLabel: nil)
    buttonsByDest[.settings] = (settingsButton, nil)

    statusDot.wantsLayer = true
    statusDot.layer?.cornerRadius = 3.5
    statusDot.translatesAutoresizingMaskIntoConstraints = false
    statusTitle.font = .systemFont(ofSize: 11, weight: .semibold)
    statusTitle.translatesAutoresizingMaskIntoConstraints = false
    statusSub.font = .systemFont(ofSize: 10)
    statusSub.lineBreakMode = .byTruncatingTail
    statusSub.translatesAutoresizingMaskIntoConstraints = false

    let statusText = NSStackView(views: [statusTitle, statusSub])
    statusText.orientation = .vertical
    statusText.alignment = .leading
    statusText.spacing = 1
    statusText.translatesAutoresizingMaskIntoConstraints = false

    let statusRow = NSStackView(views: [statusDot, statusText])
    statusRow.orientation = .horizontal
    statusRow.alignment = .centerY
    statusRow.spacing = 8
    statusRow.translatesAutoresizingMaskIntoConstraints = false

    addSubview(brandRow)
    addSubview(scrollView)
    addSubview(bottomDivider)
    addSubview(settingsButton)
    addSubview(statusRow)

    NSLayoutConstraint.activate([
      brandMark.widthAnchor.constraint(equalToConstant: 32),
      brandMark.heightAnchor.constraint(equalToConstant: 32),
      brandRow.topAnchor.constraint(equalTo: topAnchor, constant: 16),
      brandRow.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
      brandRow.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),

      scrollView.topAnchor.constraint(equalTo: brandRow.bottomAnchor, constant: 16),
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
      settingsButton.bottomAnchor.constraint(equalTo: statusRow.topAnchor, constant: -8),
      settingsButton.heightAnchor.constraint(equalToConstant: 34),

      statusDot.widthAnchor.constraint(equalToConstant: 7),
      statusDot.heightAnchor.constraint(equalToConstant: 7),
      statusRow.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
      statusRow.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      statusRow.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12)
    ])
  }

  private func addSectionHeader(_ text: String) {
    let label = NSTextField(labelWithString: text)
    label.font = .systemFont(ofSize: 10, weight: .semibold)
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

  private func addNavRow(_ dest: LumenNavDestination, symbol: String, showCount: Bool) {
    let btn = NSButton()
    let countLbl: NSTextField? = showCount ? NSTextField(labelWithString: "0") : nil
    configureNavButton(btn, dest: dest, title: dest.title, symbol: symbol, countLabel: countLbl)
    buttonsByDest[dest] = (btn, countLbl)
    navStack.addArrangedSubview(btn)
    btn.widthAnchor.constraint(equalTo: navStack.widthAnchor).isActive = true
    btn.heightAnchor.constraint(equalToConstant: 33).isActive = true
  }

  private func configureNavButton(_ btn: NSButton, dest: LumenNavDestination, title: String, symbol: String, countLabel: NSTextField?) {
    btn.title = ""
    btn.isBordered = false
    btn.wantsLayer = true
    btn.layer?.cornerRadius = 8
    btn.layer?.cornerCurve = .continuous
    btn.target = self
    btn.action = #selector(navButtonClicked(_:))
    btn.tag = tagForDestination(dest)
    btn.translatesAutoresizingMaskIntoConstraints = false

    let icon = NSImageView(image: LumenIcons.symbol(symbol, size: 14, weight: .medium))
    icon.tag = 101
    icon.translatesAutoresizingMaskIntoConstraints = false

    let label = NSTextField(labelWithString: title)
    label.tag = 102
    label.font = .systemFont(ofSize: 12.5, weight: .medium)
    label.lineBreakMode = .byTruncatingTail
    label.translatesAutoresizingMaskIntoConstraints = false

    btn.addSubview(icon)
    btn.addSubview(label)

    var constraints: [NSLayoutConstraint] = [
      icon.leadingAnchor.constraint(equalTo: btn.leadingAnchor, constant: 10),
      icon.centerYAnchor.constraint(equalTo: btn.centerYAnchor),
      icon.widthAnchor.constraint(equalToConstant: 18),
      icon.heightAnchor.constraint(equalToConstant: 18),
      label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 8),
      label.centerYAnchor.constraint(equalTo: btn.centerYAnchor)
    ]

    if let countLabel {
      countLabel.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
      countLabel.alignment = .right
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
    case .category(let cat): return 100 + (LumenDisplayCategory.allCases.firstIndex(of: cat) ?? 0)
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
      if idx >= 0, idx < LumenDisplayCategory.allCases.count {
        return .category(LumenDisplayCategory.allCases[idx])
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
    statusTitle.textColor = palette.ink
    statusSub.textColor = palette.muted

    let capturing = status?.capture.running == true
    statusDot.layer?.backgroundColor = (connected ? (capturing ? palette.success : palette.warning) : palette.muted).cgColor
    statusTitle.stringValue = connected ? (capturing ? "本机实时采集" : "本地资料库") : "未连接服务"
    statusSub.stringValue = "\(items.count) 条记录 · \(items.filter(\.pinned).count) 固定"

    var counts: [LumenDisplayCategory: Int] = [:]
    for item in items {
      counts[item.displayCategory, default: 0] += 1
    }

    for (dest, pair) in buttonsByDest {
      let (btn, countLbl) = pair
      let isSelected = dest == activeDestination
      // Express active selection with full rounded pill + crisp 1px border (no thick left bar).
      btn.layer?.backgroundColor = (isSelected ? palette.accentSoft : NSColor.clear).cgColor
      btn.layer?.borderWidth = isSelected ? 1 : 0
      btn.layer?.borderColor = (isSelected ? palette.accentBorder : NSColor.clear).cgColor

      if let icon = btn.viewWithTag(101) as? NSImageView {
        icon.contentTintColor = isSelected ? palette.accent : palette.muted
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

// MARK: - History List Row View (No Left Accent Bar)

final class LumenHistoryRowView: NSView {
  private let thumbBox = NSView()
  private let thumbImage = NSImageView()
  private let titleLabel = NSTextField(labelWithString: "")
  private let excerptLabel = NSTextField(labelWithString: "")
  private let timeLabel = NSTextField(labelWithString: "")
  private let pinIcon = NSImageView()

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.cornerRadius = 9
    layer?.cornerCurve = .continuous

    thumbBox.wantsLayer = true
    thumbBox.layer?.cornerRadius = 8
    thumbBox.layer?.masksToBounds = true
    thumbBox.translatesAutoresizingMaskIntoConstraints = false

    thumbImage.imageScaling = .scaleProportionallyUpOrDown
    thumbImage.translatesAutoresizingMaskIntoConstraints = false
    thumbBox.addSubview(thumbImage)

    titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
    titleLabel.lineBreakMode = .byTruncatingTail
    titleLabel.translatesAutoresizingMaskIntoConstraints = false

    excerptLabel.font = .systemFont(ofSize: 11.5)
    excerptLabel.lineBreakMode = .byTruncatingTail
    excerptLabel.translatesAutoresizingMaskIntoConstraints = false

    timeLabel.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
    timeLabel.alignment = .right
    timeLabel.translatesAutoresizingMaskIntoConstraints = false

    pinIcon.image = LumenIcons.symbol("pin.fill", size: 11)
    pinIcon.translatesAutoresizingMaskIntoConstraints = false

    addSubview(thumbBox)
    addSubview(titleLabel)
    addSubview(excerptLabel)
    addSubview(timeLabel)
    addSubview(pinIcon)

    NSLayoutConstraint.activate([
      thumbBox.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
      thumbBox.centerYAnchor.constraint(equalTo: centerYAnchor),
      thumbBox.widthAnchor.constraint(equalToConstant: 40),
      thumbBox.heightAnchor.constraint(equalToConstant: 40),

      thumbImage.centerXAnchor.constraint(equalTo: thumbBox.centerXAnchor),
      thumbImage.centerYAnchor.constraint(equalTo: thumbBox.centerYAnchor),
      thumbImage.widthAnchor.constraint(lessThanOrEqualTo: thumbBox.widthAnchor),
      thumbImage.heightAnchor.constraint(lessThanOrEqualTo: thumbBox.heightAnchor),

      titleLabel.topAnchor.constraint(equalTo: topAnchor, constant: 10),
      titleLabel.leadingAnchor.constraint(equalTo: thumbBox.trailingAnchor, constant: 10),
      titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: timeLabel.leadingAnchor, constant: -10),

      excerptLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 3),
      excerptLabel.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
      excerptLabel.trailingAnchor.constraint(lessThanOrEqualTo: timeLabel.leadingAnchor, constant: -10),

      timeLabel.topAnchor.constraint(equalTo: topAnchor, constant: 11),
      timeLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      timeLabel.widthAnchor.constraint(greaterThanOrEqualToConstant: 56),

      pinIcon.topAnchor.constraint(equalTo: timeLabel.bottomAnchor, constant: 5),
      pinIcon.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      pinIcon.widthAnchor.constraint(equalToConstant: 12),
      pinIcon.heightAnchor.constraint(equalToConstant: 12)
    ])
  }

  required init?(coder: NSCoder) { nil }

  func configure(item: LumenClipboardItem, selected: Bool, palette: LumenPalette) {
    let cat = item.displayCategory
    layer?.backgroundColor = (selected ? palette.accentSoft : NSColor.clear).cgColor
    layer?.borderWidth = selected ? 1 : 0
    layer?.borderColor = (selected ? palette.accentBorder : NSColor.clear).cgColor

    titleLabel.stringValue = item.displayTitle
    titleLabel.textColor = palette.ink
    excerptLabel.textColor = palette.muted
    if cat == .image || cat == .file {
      excerptLabel.stringValue = "\(cat.label) · \(item.sourceLabel) · \(item.formattedSize)"
    } else {
      let compact = item.effectiveText.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
      // Single-line records would otherwise repeat the title verbatim.
      excerptLabel.stringValue = compact == item.displayTitle ? "" : compact
    }
    timeLabel.stringValue = item.relativeTime
    timeLabel.textColor = palette.muted
    pinIcon.isHidden = !item.pinned
    pinIcon.contentTintColor = palette.accent

    if cat == .color, let swatch = LumenClassifier.parseHexColor(item.effectiveText) {
      thumbBox.layer?.backgroundColor = swatch.cgColor
      thumbImage.image = nil
    } else if cat == .image, let img = item.decodedThumbnailImage() {
      thumbBox.layer?.backgroundColor = palette.surfaceElevated.cgColor
      thumbImage.image = img
      thumbImage.contentTintColor = nil
    } else if item.kind == "file", let path = item.primaryFilePath, FileManager.default.fileExists(atPath: path) {
      thumbBox.layer?.backgroundColor = palette.surfaceElevated.cgColor
      thumbImage.image = NSWorkspace.shared.icon(forFile: path)
      thumbImage.contentTintColor = nil
    } else {
      let tint = palette.categoryTint(cat)
      thumbBox.layer?.backgroundColor = tint.withAlphaComponent(0.16).cgColor
      thumbImage.image = LumenIcons.symbol(cat.symbolName, size: 17, weight: .medium)
      thumbImage.contentTintColor = tint
    }
  }
}

// MARK: - History Gallery Card (NSCollectionViewItem)

final class LumenGalleryCardItem: NSCollectionViewItem {
  static let reuseID = NSUserInterfaceItemIdentifier("LumenGalleryCardItem")

  private let cardView = NSView()
  private let sourceDot = NSView()
  private let sourceLabel = NSTextField(labelWithString: "")
  private let timeLabel = NSTextField(labelWithString: "")
  private let titleLabel = NSTextField(labelWithString: "")
  private let bodyHost = NSView()
  private let footIcon = NSImageView()
  private let footLabel = NSTextField(labelWithString: "")
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
    cardView.layer?.cornerRadius = 12
    cardView.layer?.cornerCurve = .continuous
    cardView.layer?.masksToBounds = true
    cardView.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(cardView)

    sourceDot.wantsLayer = true
    sourceDot.layer?.cornerRadius = 5
    sourceDot.translatesAutoresizingMaskIntoConstraints = false

    sourceLabel.font = .systemFont(ofSize: 10.5, weight: .medium)
    sourceLabel.lineBreakMode = .byTruncatingTail
    sourceLabel.translatesAutoresizingMaskIntoConstraints = false

    timeLabel.font = .monospacedDigitSystemFont(ofSize: 10, weight: .regular)
    timeLabel.alignment = .right
    timeLabel.translatesAutoresizingMaskIntoConstraints = false

    titleLabel.font = .systemFont(ofSize: 12.5, weight: .semibold)
    titleLabel.lineBreakMode = .byTruncatingTail
    titleLabel.translatesAutoresizingMaskIntoConstraints = false

    bodyHost.wantsLayer = true
    bodyHost.layer?.cornerRadius = 8
    bodyHost.layer?.masksToBounds = true
    bodyHost.translatesAutoresizingMaskIntoConstraints = false

    footIcon.translatesAutoresizingMaskIntoConstraints = false
    footLabel.font = .systemFont(ofSize: 10)
    footLabel.translatesAutoresizingMaskIntoConstraints = false
    pinIcon.image = LumenIcons.symbol("pin.fill", size: 11)
    pinIcon.translatesAutoresizingMaskIntoConstraints = false

    for sub in [sourceDot, sourceLabel, timeLabel, titleLabel, bodyHost, footIcon, footLabel, pinIcon] {
      cardView.addSubview(sub)
    }

    NSLayoutConstraint.activate([
      cardView.topAnchor.constraint(equalTo: container.topAnchor, constant: 2),
      cardView.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 2),
      cardView.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -2),
      cardView.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -2),

      sourceDot.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 10),
      sourceDot.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
      sourceDot.widthAnchor.constraint(equalToConstant: 14),
      sourceDot.heightAnchor.constraint(equalToConstant: 14),

      sourceLabel.leadingAnchor.constraint(equalTo: sourceDot.trailingAnchor, constant: 6),
      sourceLabel.centerYAnchor.constraint(equalTo: sourceDot.centerYAnchor),
      sourceLabel.trailingAnchor.constraint(lessThanOrEqualTo: timeLabel.leadingAnchor, constant: -6),

      timeLabel.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
      timeLabel.centerYAnchor.constraint(equalTo: sourceDot.centerYAnchor),

      titleLabel.topAnchor.constraint(equalTo: sourceDot.bottomAnchor, constant: 8),
      titleLabel.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
      titleLabel.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),

      bodyHost.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 6),
      bodyHost.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
      bodyHost.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
      bodyHost.bottomAnchor.constraint(equalTo: footLabel.topAnchor, constant: -8),

      footIcon.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
      footIcon.bottomAnchor.constraint(equalTo: cardView.bottomAnchor, constant: -9),
      footIcon.widthAnchor.constraint(equalToConstant: 12),
      footIcon.heightAnchor.constraint(equalToConstant: 12),

      footLabel.leadingAnchor.constraint(equalTo: footIcon.trailingAnchor, constant: 5),
      footLabel.centerYAnchor.constraint(equalTo: footIcon.centerYAnchor),

      pinIcon.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
      pinIcon.centerYAnchor.constraint(equalTo: footIcon.centerYAnchor),
      pinIcon.widthAnchor.constraint(equalToConstant: 12),
      pinIcon.heightAnchor.constraint(equalToConstant: 12)
    ])
  }

  func configure(item: LumenClipboardItem, selected: Bool, palette: LumenPalette) {
    let cat = item.displayCategory
    cardView.layer?.backgroundColor = palette.surface.cgColor
    cardView.layer?.borderWidth = selected ? 2 : 1
    cardView.layer?.borderColor = (selected ? palette.accent : palette.border).cgColor

    sourceDot.layer?.backgroundColor = palette.sourceBadgeColor(for: item.sourceLabel).cgColor
    sourceLabel.stringValue = item.sourceLabel
    sourceLabel.textColor = palette.muted
    timeLabel.stringValue = item.relativeTime
    timeLabel.textColor = palette.muted
    titleLabel.stringValue = item.displayTitle
    titleLabel.textColor = palette.ink
    footIcon.image = LumenIcons.symbol(cat.symbolName, size: 11)
    footIcon.contentTintColor = palette.muted
    footLabel.stringValue = cat.label
    footLabel.textColor = palette.muted
    pinIcon.isHidden = !item.pinned
    pinIcon.contentTintColor = palette.accent

    bodyHost.subviews.forEach { $0.removeFromSuperview() }
    bodyHost.layer?.backgroundColor = NSColor.clear.cgColor

    switch cat {
    case .color:
      if let swatch = LumenClassifier.parseHexColor(item.effectiveText) {
        bodyHost.layer?.backgroundColor = swatch.cgColor
      }
    case .image:
      bodyHost.layer?.backgroundColor = palette.surfaceElevated.cgColor
      let iv = NSImageView(image: item.decodedThumbnailImage() ?? LumenIcons.symbol("photo", size: 28))
      iv.imageScaling = .scaleProportionallyUpOrDown
      iv.translatesAutoresizingMaskIntoConstraints = false
      bodyHost.addSubview(iv)
      NSLayoutConstraint.activate([
        iv.topAnchor.constraint(equalTo: bodyHost.topAnchor),
        iv.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        iv.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        iv.bottomAnchor.constraint(equalTo: bodyHost.bottomAnchor)
      ])
    case .code:
      bodyHost.layer?.backgroundColor = palette.codeBackground.cgColor
      let lang = LumenClassifier.detectLanguage(fileName: item.primaryFilePath, content: item.effectiveText)
      let lbl = NSTextField(wrappingLabelWithString: "")
      lbl.attributedStringValue = LumenSyntaxHighlighter.highlight(String(item.effectiveText.prefix(240)), language: lang, fontSize: 10, darkCanvas: true)
      lbl.translatesAutoresizingMaskIntoConstraints = false
      bodyHost.addSubview(lbl)
      NSLayoutConstraint.activate([
        lbl.topAnchor.constraint(equalTo: bodyHost.topAnchor, constant: 6),
        lbl.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor, constant: 7),
        lbl.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor, constant: -7),
        lbl.bottomAnchor.constraint(lessThanOrEqualTo: bodyHost.bottomAnchor, constant: -6)
      ])
    case .file:
      bodyHost.layer?.backgroundColor = palette.surfaceElevated.cgColor
      let icon = NSImageView(image: item.primaryFilePath.flatMap { FileManager.default.fileExists(atPath: $0) ? NSWorkspace.shared.icon(forFile: $0) : nil } ?? LumenIcons.symbol("doc.fill", size: 24))
      icon.translatesAutoresizingMaskIntoConstraints = false
      let meta = NSTextField(labelWithString: item.formattedSize)
      meta.font = .systemFont(ofSize: 11)
      meta.textColor = palette.muted
      meta.translatesAutoresizingMaskIntoConstraints = false
      let st = NSStackView(views: [icon, meta])
      st.orientation = .vertical
      st.alignment = .centerX
      st.spacing = 4
      st.translatesAutoresizingMaskIntoConstraints = false
      bodyHost.addSubview(st)
      NSLayoutConstraint.activate([
        icon.widthAnchor.constraint(equalToConstant: 34),
        icon.heightAnchor.constraint(equalToConstant: 34),
        st.centerXAnchor.constraint(equalTo: bodyHost.centerXAnchor),
        st.centerYAnchor.constraint(equalTo: bodyHost.centerYAnchor)
      ])
    default:
      let excerpt = NSTextField(wrappingLabelWithString: String(item.effectiveText.prefix(180)))
      excerpt.font = .systemFont(ofSize: 11.5)
      excerpt.textColor = palette.muted
      excerpt.maximumNumberOfLines = 4
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

// MARK: - Inspector View (Single & Batch Multi-Select)

final class LumenInspectorView: NSView {
  var onCopySingle: ((LumenClipboardItem) -> Void)?
  var onPreviewSingle: ((LumenClipboardItem) -> Void)?
  var onPinSingle: ((LumenClipboardItem) -> Void)?
  var onDeleteSingle: ((LumenClipboardItem) -> Void)?
  var onBatchPreview: (([LumenClipboardItem]) -> Void)?
  var onBatchPin: (([LumenClipboardItem]) -> Void)?
  var onBatchDelete: (([LumenClipboardItem]) -> Void)?
  var onClearSelection: (() -> Void)?

  private var currentSingle: LumenClipboardItem?
  private var currentBatch: [LumenClipboardItem] = []

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
  }

  required init?(coder: NSCoder) { nil }

  func render(single: LumenClipboardItem?, batch: [LumenClipboardItem], palette: LumenPalette) {
    currentSingle = single
    currentBatch = batch
    subviews.forEach { $0.removeFromSuperview() }
    layer?.backgroundColor = palette.windowBackground.cgColor

    if batch.count > 1 {
      buildBatchView(items: batch, palette: palette)
      return
    }
    guard let item = single else {
      let empty = NSTextField(labelWithString: "选择一条记录查看预览与详情")
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

  private func buildBatchView(items: [LumenClipboardItem], palette: LumenPalette) {
    let topBar = NSView()
    topBar.translatesAutoresizingMaskIntoConstraints = false
    let title = NSTextField(labelWithString: "多选批量操作")
    title.font = .systemFont(ofSize: 12.5, weight: .semibold)
    title.textColor = palette.ink
    title.translatesAutoresizingMaskIntoConstraints = false
    let cancelBtn = makeActionIconButton("xmark", tip: "取消多选", action: #selector(clearBatchClicked), tint: palette.muted)
    topBar.addSubview(title)
    topBar.addSubview(cancelBtn)

    let icon = NSImageView(image: LumenIcons.symbol("square.stack.3d.up.fill", size: 44, weight: .light))
    icon.contentTintColor = palette.accent
    icon.translatesAutoresizingMaskIntoConstraints = false

    let countTitle = NSTextField(labelWithString: "\(items.count) 条记录")
    countTitle.font = .systemFont(ofSize: 22, weight: .semibold)
    countTitle.textColor = palette.ink

    let sub = NSTextField(labelWithString: "对所选记录执行批量预览、固定或清理")
    sub.font = .systemFont(ofSize: 12)
    sub.textColor = palette.muted

    let previewBtn = makePrimaryButton("批量预览 · \(items.count) 项", symbol: "arrow.up.left.and.arrow.down.right", action: #selector(batchPreviewClicked), palette: palette)
    let pinBtn = makeSecondaryButton("批量固定", symbol: "pin", action: #selector(batchPinClicked), palette: palette, danger: false)
    let delBtn = makeSecondaryButton("批量移除", symbol: "trash", action: #selector(batchDeleteClicked), palette: palette, danger: true)

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
      topBar.heightAnchor.constraint(equalToConstant: 44),
      title.leadingAnchor.constraint(equalTo: topBar.leadingAnchor, constant: 16),
      title.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
      cancelBtn.trailingAnchor.constraint(equalTo: topBar.trailingAnchor, constant: -12),
      cancelBtn.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),

      previewBtn.widthAnchor.constraint(equalToConstant: 210),
      centerStack.centerXAnchor.constraint(equalTo: centerXAnchor),
      centerStack.centerYAnchor.constraint(equalTo: centerYAnchor)
    ])
  }

  private func buildSingleView(item: LumenClipboardItem, palette: LumenPalette) {
    let previewKind = LumenPreviewItem.classify(item: item)

    // Top inspector toolbar
    let topBar = NSView()
    topBar.translatesAutoresizingMaskIntoConstraints = false
    let typeIcon = NSImageView(image: LumenIcons.symbol(item.displayCategory.symbolName, size: 13))
    typeIcon.contentTintColor = palette.muted
    typeIcon.translatesAutoresizingMaskIntoConstraints = false
    let headerTitle = NSTextField(labelWithString: "\(previewKind.displayLabel)预览")
    headerTitle.font = .systemFont(ofSize: 12.5, weight: .semibold)
    headerTitle.textColor = palette.ink
    headerTitle.translatesAutoresizingMaskIntoConstraints = false

    let expandBtn = makeActionIconButton("arrow.up.left.and.arrow.down.right", tip: "完整预览 (Space)", action: #selector(previewSingleClicked), tint: palette.muted)
    let pinBtn = makeActionIconButton(item.pinned ? "pin.fill" : "pin", tip: item.pinned ? "取消固定" : "固定", action: #selector(pinSingleClicked), tint: item.pinned ? palette.accent : palette.muted)
    let delBtn = makeActionIconButton("trash", tip: "移除记录 (Delete)", action: #selector(deleteSingleClicked), tint: palette.danger)

    let rightTools = NSStackView(views: [expandBtn, pinBtn, delBtn])
    rightTools.orientation = .horizontal
    rightTools.spacing = 4
    rightTools.translatesAutoresizingMaskIntoConstraints = false

    topBar.addSubview(typeIcon)
    topBar.addSubview(headerTitle)
    topBar.addSubview(rightTools)

    // Scrollable middle (hero + caption + metadata)
    let scroll = NSScrollView()
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.drawsBackground = false
    scroll.borderType = .noBorder
    scroll.translatesAutoresizingMaskIntoConstraints = false

    let docView = LumenFlippedView()
    docView.translatesAutoresizingMaskIntoConstraints = false

    let hero = makeHeroPreview(item: item, kind: previewKind, palette: palette)
    let captionTitle = NSTextField(wrappingLabelWithString: item.displayTitle)
    captionTitle.font = .systemFont(ofSize: 18, weight: .semibold)
    captionTitle.textColor = palette.ink
    captionTitle.isSelectable = true

    let captionSub = NSTextField(labelWithString: "\(item.sourceLabel) · \(item.relativeTime)")
    captionSub.font = .systemFont(ofSize: 11.5)
    captionSub.textColor = palette.muted

    let metaGrid = makeMetaGrid(item: item, kind: previewKind, palette: palette)

    let middleStack = NSStackView(views: [hero, captionTitle, captionSub, metaGrid])
    middleStack.orientation = .vertical
    middleStack.alignment = .leading
    middleStack.spacing = 8
    middleStack.setCustomSpacing(14, after: hero)
    middleStack.setCustomSpacing(14, after: captionSub)
    middleStack.translatesAutoresizingMaskIntoConstraints = false

    docView.addSubview(middleStack)
    scroll.documentView = docView

    // Bottom action bar
    let bottomBar = NSView()
    bottomBar.wantsLayer = true
    bottomBar.translatesAutoresizingMaskIntoConstraints = false
    let bottomLine = NSView()
    bottomLine.wantsLayer = true
    bottomLine.layer?.backgroundColor = palette.border.cgColor
    bottomLine.translatesAutoresizingMaskIntoConstraints = false

    let copyBtn = makePrimaryButton("复制内容 ↵", symbol: "doc.on.doc", action: #selector(copySingleClicked), palette: palette)
    let peekBtn = makeSecondaryButton("快速预览", symbol: "eye", action: #selector(previewSingleClicked), palette: palette, danger: false)

    bottomBar.addSubview(bottomLine)
    bottomBar.addSubview(copyBtn)
    bottomBar.addSubview(peekBtn)

    addSubview(topBar)
    addSubview(scroll)
    addSubview(bottomBar)

    NSLayoutConstraint.activate([
      topBar.topAnchor.constraint(equalTo: topAnchor),
      topBar.leadingAnchor.constraint(equalTo: leadingAnchor),
      topBar.trailingAnchor.constraint(equalTo: trailingAnchor),
      topBar.heightAnchor.constraint(equalToConstant: 44),
      typeIcon.leadingAnchor.constraint(equalTo: topBar.leadingAnchor, constant: 16),
      typeIcon.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
      headerTitle.leadingAnchor.constraint(equalTo: typeIcon.trailingAnchor, constant: 6),
      headerTitle.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
      rightTools.trailingAnchor.constraint(equalTo: topBar.trailingAnchor, constant: -12),
      rightTools.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),

      scroll.topAnchor.constraint(equalTo: topBar.bottomAnchor),
      scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
      scroll.bottomAnchor.constraint(equalTo: bottomBar.topAnchor),

      docView.widthAnchor.constraint(equalTo: scroll.widthAnchor),
      middleStack.topAnchor.constraint(equalTo: docView.topAnchor, constant: 4),
      middleStack.leadingAnchor.constraint(equalTo: docView.leadingAnchor, constant: 16),
      middleStack.trailingAnchor.constraint(equalTo: docView.trailingAnchor, constant: -16),
      middleStack.bottomAnchor.constraint(equalTo: docView.bottomAnchor, constant: -16),

      hero.widthAnchor.constraint(equalTo: middleStack.widthAnchor),
      hero.heightAnchor.constraint(greaterThanOrEqualToConstant: 200),
      metaGrid.widthAnchor.constraint(equalTo: middleStack.widthAnchor),

      bottomBar.leadingAnchor.constraint(equalTo: leadingAnchor),
      bottomBar.trailingAnchor.constraint(equalTo: trailingAnchor),
      bottomBar.bottomAnchor.constraint(equalTo: bottomAnchor),
      bottomBar.heightAnchor.constraint(equalToConstant: 60),
      bottomLine.topAnchor.constraint(equalTo: bottomBar.topAnchor),
      bottomLine.leadingAnchor.constraint(equalTo: bottomBar.leadingAnchor),
      bottomLine.trailingAnchor.constraint(equalTo: bottomBar.trailingAnchor),
      bottomLine.heightAnchor.constraint(equalToConstant: 1),

      copyBtn.leadingAnchor.constraint(equalTo: bottomBar.leadingAnchor, constant: 16),
      copyBtn.centerYAnchor.constraint(equalTo: bottomBar.centerYAnchor),
      peekBtn.leadingAnchor.constraint(equalTo: copyBtn.trailingAnchor, constant: 8),
      peekBtn.trailingAnchor.constraint(equalTo: bottomBar.trailingAnchor, constant: -16),
      peekBtn.centerYAnchor.constraint(equalTo: bottomBar.centerYAnchor),
      peekBtn.widthAnchor.constraint(equalToConstant: 108)
    ])
  }

  private func makeHeroPreview(item: LumenClipboardItem, kind: LumenPreviewKind, palette: LumenPalette) -> NSView {
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

    switch kind {
    case .color:
      let swatch = NSView()
      swatch.wantsLayer = true
      swatch.layer?.cornerRadius = 10
      swatch.layer?.backgroundColor = (LumenClassifier.parseHexColor(item.effectiveText) ?? palette.accent).cgColor
      swatch.translatesAutoresizingMaskIntoConstraints = false
      let hex = NSTextField(labelWithString: item.effectiveText.trimmingCharacters(in: .whitespacesAndNewlines).uppercased())
      hex.font = .monospacedSystemFont(ofSize: 20, weight: .semibold)
      hex.textColor = .white
      hex.translatesAutoresizingMaskIntoConstraints = false
      swatch.addSubview(hex)
      box.addSubview(swatch)
      NSLayoutConstraint.activate([
        swatch.topAnchor.constraint(equalTo: box.topAnchor, constant: 16),
        swatch.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 16),
        swatch.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -16),
        swatch.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -16),
        swatch.heightAnchor.constraint(equalToConstant: 170),
        hex.leadingAnchor.constraint(equalTo: swatch.leadingAnchor, constant: 16),
        hex.bottomAnchor.constraint(equalTo: swatch.bottomAnchor, constant: -14)
      ])
    case .image:
      let iv = NSImageView()
      iv.imageScaling = .scaleProportionallyUpOrDown
      iv.image = LumenPreviewCache.shared.image(for: "clip:\(item.id)") ?? item.decodedThumbnailImage() ?? LumenIcons.symbol("photo", size: 40)
      iv.translatesAutoresizingMaskIntoConstraints = false
      box.addSubview(iv)
      NSLayoutConstraint.activate([
        iv.topAnchor.constraint(equalTo: box.topAnchor, constant: 14),
        iv.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 14),
        iv.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -14),
        iv.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -14),
        iv.heightAnchor.constraint(equalToConstant: 196)
      ])
    case .pdf:
      let iv = NSImageView()
      iv.imageScaling = .scaleProportionallyUpOrDown
      if let path = item.primaryFilePath, let doc = PDFDocument(url: URL(fileURLWithPath: path)), let page = doc.page(at: 0) {
        iv.image = page.thumbnail(of: NSSize(width: 280, height: 360), for: .cropBox)
      } else {
        iv.image = LumenIcons.symbol("doc.richtext", size: 48)
        iv.contentTintColor = palette.accent
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
      cover.badgeText = kind == .audio ? "AUDIO" : "VIDEO"
      cover.translatesAutoresizingMaskIntoConstraints = false
      box.addSubview(cover)
      NSLayoutConstraint.activate([
        cover.centerXAnchor.constraint(equalTo: box.centerXAnchor),
        cover.topAnchor.constraint(equalTo: box.topAnchor, constant: 20),
        cover.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -20),
        cover.widthAnchor.constraint(equalToConstant: 164),
        cover.heightAnchor.constraint(equalToConstant: 164)
      ])
    case .code(let lang):
      box.layer?.backgroundColor = palette.codeBackground.cgColor
      let lbl = NSTextField(wrappingLabelWithString: "")
      lbl.attributedStringValue = LumenSyntaxHighlighter.highlight(String(item.effectiveText.prefix(700)), language: lang, fontSize: 11.5, darkCanvas: true)
      lbl.translatesAutoresizingMaskIntoConstraints = false
      box.addSubview(lbl)
      NSLayoutConstraint.activate([
        lbl.topAnchor.constraint(equalTo: box.topAnchor, constant: 16),
        lbl.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 16),
        lbl.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -16),
        lbl.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -16)
      ])
    case .collection, .file, .office:
      let icon = NSImageView(image: item.primaryFilePath.flatMap { FileManager.default.fileExists(atPath: $0) ? NSWorkspace.shared.icon(forFile: $0) : nil } ?? LumenIcons.symbol("doc.fill", size: 42))
      icon.contentTintColor = palette.accent
      icon.translatesAutoresizingMaskIntoConstraints = false
      let name = NSTextField(wrappingLabelWithString: item.displayTitle)
      name.font = .systemFont(ofSize: 15, weight: .semibold)
      name.textColor = palette.ink
      name.alignment = .center
      let hint = NSTextField(labelWithString: "\(kind.displayLabel) · \(item.formattedSize) · 点击完整预览")
      hint.font = .systemFont(ofSize: 11)
      hint.textColor = palette.muted
      let st = NSStackView(views: [icon, name, hint])
      st.orientation = .vertical
      st.alignment = .centerX
      st.spacing = 8
      st.translatesAutoresizingMaskIntoConstraints = false
      box.addSubview(st)
      NSLayoutConstraint.activate([
        icon.widthAnchor.constraint(equalToConstant: 56),
        icon.heightAnchor.constraint(equalToConstant: 56),
        st.centerXAnchor.constraint(equalTo: box.centerXAnchor),
        st.centerYAnchor.constraint(equalTo: box.centerYAnchor),
        st.leadingAnchor.constraint(greaterThanOrEqualTo: box.leadingAnchor, constant: 18),
        st.trailingAnchor.constraint(lessThanOrEqualTo: box.trailingAnchor, constant: -18)
      ])
    default:
      let lbl = NSTextField(wrappingLabelWithString: String(item.effectiveText.prefix(500)))
      lbl.font = .systemFont(ofSize: 14.5)
      lbl.textColor = palette.ink
      lbl.translatesAutoresizingMaskIntoConstraints = false
      box.addSubview(lbl)
      NSLayoutConstraint.activate([
        lbl.topAnchor.constraint(equalTo: box.topAnchor, constant: 18),
        lbl.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 18),
        lbl.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -18),
        lbl.bottomAnchor.constraint(lessThanOrEqualTo: box.bottomAnchor, constant: -18)
      ])
    }
    return box
  }

  private func makeMetaGrid(item: LumenClipboardItem, kind: LumenPreviewKind, palette: LumenPalette) -> NSView {
    let entries: [(String, String)] = [
      ("内容类型", kind.displayLabel),
      ("大小", item.formattedSize),
      ("来源", item.sourceLabel),
      ("收藏状态", item.pinned ? "已固定" : "未固定"),
      ("落盘状态", item.materialized ? "已就绪" : "远端按需拉取"),
      ("出现次数", "\(max(1, item.seenCount)) 次")
    ]
    let grid = NSStackView()
    grid.orientation = .vertical
    grid.spacing = 10
    grid.translatesAutoresizingMaskIntoConstraints = false

    for rowStart in stride(from: 0, to: entries.count, by: 2) {
      let row = NSStackView()
      row.orientation = .horizontal
      row.distribution = .fillEqually
      row.spacing = 12
      for offset in 0..<2 where rowStart + offset < entries.count {
        let (k, v) = entries[rowStart + offset]
        let kl = NSTextField(labelWithString: k)
        kl.font = .systemFont(ofSize: 10.5)
        kl.textColor = palette.muted
        let vl = NSTextField(labelWithString: v)
        vl.font = .systemFont(ofSize: 12, weight: .medium)
        vl.textColor = palette.ink
        vl.lineBreakMode = .byTruncatingTail
        let cell = NSStackView(views: [kl, vl])
        cell.orientation = .vertical
        cell.alignment = .leading
        cell.spacing = 2
        row.addArrangedSubview(cell)
      }
      grid.addArrangedSubview(row)
      row.widthAnchor.constraint(equalTo: grid.widthAnchor).isActive = true
    }
    return grid
  }

  private func makeActionIconButton(_ symbol: String, tip: String, action: Selector, tint: NSColor) -> NSButton {
    let btn = NSButton()
    btn.isBordered = false
    btn.wantsLayer = true
    btn.image = LumenIcons.symbol(symbol, size: 14, weight: .medium, description: tip)
    btn.contentTintColor = tint
    btn.toolTip = tip
    btn.target = self
    btn.action = action
    btn.layer?.cornerRadius = 7
    btn.translatesAutoresizingMaskIntoConstraints = false
    btn.widthAnchor.constraint(equalToConstant: 28).isActive = true
    btn.heightAnchor.constraint(equalToConstant: 28).isActive = true
    return btn
  }

  private func makePrimaryButton(_ title: String, symbol: String, action: Selector, palette: LumenPalette) -> NSButton {
    let btn = NSButton(title: " \(title)", target: self, action: action)
    btn.image = LumenIcons.symbol(symbol, size: 13, weight: .semibold)
    btn.imagePosition = .imageLeading
    btn.isBordered = false
    btn.wantsLayer = true
    btn.font = .systemFont(ofSize: 12.5, weight: .semibold)
    btn.contentTintColor = .white
    btn.attributedTitle = NSAttributedString(string: " \(title)", attributes: [
      .font: NSFont.systemFont(ofSize: 12.5, weight: .semibold),
      .foregroundColor: NSColor.white
    ])
    btn.layer?.cornerRadius = 9
    btn.layer?.cornerCurve = .continuous
    btn.layer?.backgroundColor = palette.accent.cgColor
    btn.translatesAutoresizingMaskIntoConstraints = false
    btn.heightAnchor.constraint(equalToConstant: 36).isActive = true
    return btn
  }

  private func makeSecondaryButton(_ title: String, symbol: String, action: Selector, palette: LumenPalette, danger: Bool) -> NSButton {
    let btn = NSButton(title: " \(title)", target: self, action: action)
    btn.image = LumenIcons.symbol(symbol, size: 13, weight: .medium)
    btn.imagePosition = .imageLeading
    btn.isBordered = false
    btn.wantsLayer = true
    let color = danger ? palette.danger : palette.ink
    btn.contentTintColor = color
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
    btn.heightAnchor.constraint(equalToConstant: 36).isActive = true
    return btn
  }

  @objc private func copySingleClicked() { if let item = currentSingle { onCopySingle?(item) } }
  @objc private func previewSingleClicked() { if let item = currentSingle { onPreviewSingle?(item) } }
  @objc private func pinSingleClicked() { if let item = currentSingle { onPinSingle?(item) } }
  @objc private func deleteSingleClicked() { if let item = currentSingle { onDeleteSingle?(item) } }
  @objc private func batchPreviewClicked() { onBatchPreview?(currentBatch) }
  @objc private func batchPinClicked() { onBatchPin?(currentBatch) }
  @objc private func batchDeleteClicked() { onBatchDelete?(currentBatch) }
  @objc private func clearBatchClicked() { onClearSelection?() }
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

    addHeading("快捷浮层", subtitle: "原生 NSPanel 贴边轨道，支持中断式 Core Animation 过渡与卡片移除动效。", palette: palette)

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
      ("本机剪贴板自动采集", "开启后后台记录复制的文本、图片与文件引用。", captureSwitch),
      ("高光粒子", "Orbit 轨道背景浮光粒子与卡片移除释放光点。", particlesSwitch),
      ("动态光感", "焦点卡片微光边界与随指针移动的高光镜面反射。", glowSwitch),
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

// MARK: - Native New Text Clip Sheet

final class LumenNewClipSheet: NSObject {
  private let sheet: NSWindow
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
    let heading = NSTextField(labelWithString: "输入文本、代码或链接")
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

  func present(over parent: NSWindow, palette: LumenPalette, completion: @escaping (String) -> Void) {
    onSave = completion
    sheet.appearance = palette.nsAppearance
    textView.string = ""
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
