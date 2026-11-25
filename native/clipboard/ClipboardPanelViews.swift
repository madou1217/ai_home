import AppKit

/// Visual identity per clipboard kind. One table drives symbol, tint and label so
/// the list, preview header and filters can never drift apart.
enum ClipboardKindStyle {
  static func info(for kind: String) -> (symbol: String, tint: NSColor, label: String) {
    switch kind {
    case "image": return ("photo", .systemPurple, "图片")
    case "file": return ("doc", .systemOrange, "文件")
    case "link": return ("link", .systemTeal, "链接")
    default: return ("text.alignleft", .systemBlue, "文本")
    }
  }
}

/// Rounded tinted glyph tile. Image rows swap the glyph for the stored 64 KiB
/// thumbnail so the list itself previews visual content.
final class ClipboardGlyphTile: NSView {
  private let glyph = NSImageView()
  private let thumbnail = NSImageView()

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.cornerRadius = 9
    layer?.cornerCurve = .continuous

    glyph.imageScaling = .scaleProportionallyDown
    thumbnail.imageScaling = .scaleProportionallyUpOrDown
    thumbnail.wantsLayer = true
    thumbnail.layer?.cornerRadius = 7
    thumbnail.layer?.cornerCurve = .continuous
    thumbnail.layer?.masksToBounds = true
    for view in [glyph, thumbnail] {
      view.translatesAutoresizingMaskIntoConstraints = false
      addSubview(view)
    }
    NSLayoutConstraint.activate([
      glyph.centerXAnchor.constraint(equalTo: centerXAnchor),
      glyph.centerYAnchor.constraint(equalTo: centerYAnchor),
      glyph.widthAnchor.constraint(equalToConstant: 18),
      glyph.heightAnchor.constraint(equalToConstant: 18),
      thumbnail.topAnchor.constraint(equalTo: topAnchor, constant: 3),
      thumbnail.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 3),
      thumbnail.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -3),
      thumbnail.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -3)
    ])
  }

  required init?(coder: NSCoder) { nil }

  func apply(kind: String) {
    let style = ClipboardKindStyle.info(for: kind)
    apply(symbol: style.symbol, tint: style.tint)
  }

  func apply(symbol: String, tint: NSColor) {
    layer?.backgroundColor = tint.withAlphaComponent(0.16).cgColor
    glyph.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
    glyph.contentTintColor = tint
    glyph.isHidden = false
    thumbnail.isHidden = true
  }

  func applyThumbnail(_ image: NSImage) {
    thumbnail.image = image
    thumbnail.isHidden = false
    glyph.isHidden = true
    layer?.backgroundColor = NSColor.quaternaryLabelColor.withAlphaComponent(0.18).cgColor
  }
}

/// One history row: glyph tile, single-line preview, metadata. Selection is drawn
/// as a soft rounded card instead of the full-width system bar.
final class ClipboardPanelRowView: NSTableCellView {
  private let tile = ClipboardGlyphTile()
  private let titleLabel = NSTextField(labelWithString: "")
  private let metaLabel = NSTextField(labelWithString: "")
  private let pinView = NSImageView()
  private(set) var isChosen = false

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    titleLabel.translatesAutoresizingMaskIntoConstraints = false
    titleLabel.lineBreakMode = .byTruncatingTail
    titleLabel.font = .systemFont(ofSize: 13, weight: .medium)
    metaLabel.translatesAutoresizingMaskIntoConstraints = false
    metaLabel.lineBreakMode = .byTruncatingTail
    metaLabel.font = .systemFont(ofSize: 11)
    metaLabel.textColor = .secondaryLabelColor
    pinView.translatesAutoresizingMaskIntoConstraints = false
    pinView.image = NSImage(systemSymbolName: "pin.fill", accessibilityDescription: "置顶")
    pinView.contentTintColor = .systemOrange
    pinView.isHidden = true
    tile.translatesAutoresizingMaskIntoConstraints = false
    addSubview(tile)
    addSubview(titleLabel)
    addSubview(metaLabel)
    addSubview(pinView)
    NSLayoutConstraint.activate([
      tile.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
      tile.centerYAnchor.constraint(equalTo: centerYAnchor),
      tile.widthAnchor.constraint(equalToConstant: 38),
      tile.heightAnchor.constraint(equalToConstant: 38),

      titleLabel.leadingAnchor.constraint(equalTo: tile.trailingAnchor, constant: 10),
      titleLabel.topAnchor.constraint(equalTo: topAnchor, constant: 11),
      titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: pinView.leadingAnchor, constant: -6),

      metaLabel.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
      metaLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 3),
      metaLabel.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -10),

      pinView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
      pinView.centerYAnchor.constraint(equalTo: centerYAnchor),
      pinView.widthAnchor.constraint(equalToConstant: 11),
      pinView.heightAnchor.constraint(equalToConstant: 11)
    ])
  }

  required init?(coder: NSCoder) { nil }

  override func draw(_ dirtyRect: NSRect) {
    if isChosen {
      let card = bounds.insetBy(dx: 4, dy: 2)
      let path = NSBezierPath(roundedRect: card, xRadius: 10, yRadius: 10)
      NSColor.controlAccentColor.withAlphaComponent(0.16).setFill()
      path.fill()
      NSColor.controlAccentColor.withAlphaComponent(0.22).setStroke()
      path.lineWidth = 1
      path.stroke()
    }
    super.draw(dirtyRect)
  }

  func setChosen(_ chosen: Bool) {
    guard chosen != isChosen else { return }
    isChosen = chosen
    needsDisplay = true
  }

  func apply(_ row: ClipboardPanelRow) {
    tile.apply(kind: row.kind)
    if let thumb = row.thumbnail { tile.applyThumbnail(thumb) }
    let singleLine = row.preview.components(separatedBy: .newlines).joined(separator: " ")
    titleLabel.stringValue = singleLine.isEmpty ? ClipboardKindStyle.info(for: row.kind).label : singleLine
    let style = ClipboardKindStyle.info(for: row.kind)
    var parts = [style.label]
    if let relative = ClipboardPanelFormat.relative(row.effectiveTimeMs) { parts.append(relative) }
    if row.kind == "image", row.width > 0, row.height > 0 { parts.append("\(row.width)×\(row.height)") }
    else if row.byteSize > 0 { parts.append(ClipboardPanelFormat.bytes(row.byteSize)) }
    let meta = NSMutableAttributedString(
      string: style.label,
      attributes: [.foregroundColor: style.tint, .font: NSFont.systemFont(ofSize: 11, weight: .medium)]
    )
    let rest = parts.dropFirst().joined(separator: "   ")
    if !rest.isEmpty {
      meta.append(NSAttributedString(
        string: "   " + rest,
        attributes: [.foregroundColor: NSColor.secondaryLabelColor, .font: NSFont.systemFont(ofSize: 11)]
      ))
    }
    metaLabel.attributedStringValue = meta
    pinView.isHidden = !row.pinned
  }
}

/// Two hairline corner brackets in the Paste Nexus cyan, matching the WebUI HUD.
final class ClipboardBracketView: NSView {
  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  override func draw(_ dirtyRect: NSRect) {
    NSColor(srgbRed: 0.384, green: 0.929, blue: 1, alpha: 0.55).setStroke()
    let path = NSBezierPath()
    let arm: CGFloat = 18
    let tick: CGFloat = 10
    path.move(to: NSPoint(x: 0.5, y: bounds.height - 0.5))
    path.line(to: NSPoint(x: 0.5, y: bounds.height - tick))
    path.line(to: NSPoint(x: arm, y: bounds.height - tick))
    path.move(to: NSPoint(x: bounds.width - arm, y: 0.5))
    path.line(to: NSPoint(x: bounds.width - 0.5, y: 0.5))
    path.line(to: NSPoint(x: bounds.width - 0.5, y: tick))
    path.lineWidth = 1
    path.stroke()
  }
}

/// Panel subclass that owns key routing so Esc/↵/↑↓ work regardless of which
/// child control currently has focus. Escape is also handled by cancelOperation
/// for the responder chain path used by AppKit menus.
final class ClipboardHostPanel: NSPanel {
  var onKeyEvent: ((NSEvent) -> Bool)?

  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }

  override func sendEvent(_ event: NSEvent) {
    if event.type == .keyDown, let handler = onKeyEvent, handler(event) { return }
    super.sendEvent(event)
  }

  override func cancelOperation(_ sender: Any?) { orderOut(nil) }
}

/// Table view that forwards navigation/paste keys before AppKit type-select runs.
final class ClipboardPanelTableView: NSTableView {
  var keyHandler: ((NSEvent) -> Bool)?

  override func keyDown(with event: NSEvent) {
    if keyHandler?(event) == true { return }
    super.keyDown(with: event)
  }
}

/// Preview pane: kind badge + metadata + actions on top, content card below.
final class ClipboardPanelPreview: NSView {
  private let badge = NSTextField(labelWithString: "")
  private let badgeBox = NSView()
  private let metaLabel = NSTextField(labelWithString: "")
  private let pasteButton = NSButton(title: "粘贴", target: nil, action: nil)
  private let pinButton = NSButton(title: "", target: nil, action: nil)
  private let deleteButton = NSButton(title: "", target: nil, action: nil)
  private let separator = NSBox()
  private let textCard = NSView()
  private let scroll = NSScrollView()
  private let textView = NSTextView()
  private let imageCard = NSView()
  private let imageView = NSImageView()
  private let placeholder = NSTextField(labelWithString: "")
  private let placeholderGlyph = NSImageView()
  private let footer = NSTextField(labelWithString: "")

  var onPaste: (() -> Void)?
  var onPin: (() -> Void)?
  var onDelete: (() -> Void)?

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)

    badge.font = .systemFont(ofSize: 11, weight: .semibold)
    badgeBox.wantsLayer = true
    badgeBox.layer?.cornerRadius = 6
    badgeBox.layer?.cornerCurve = .continuous
    badgeBox.translatesAutoresizingMaskIntoConstraints = false
    badge.translatesAutoresizingMaskIntoConstraints = false
    badgeBox.addSubview(badge)

    metaLabel.font = .systemFont(ofSize: 11)
    metaLabel.textColor = .secondaryLabelColor
    metaLabel.lineBreakMode = .byTruncatingTail

    pasteButton.bezelStyle = .rounded
    pasteButton.controlSize = .small
    pasteButton.bezelColor = .controlAccentColor
    pasteButton.contentTintColor = .white
    pasteButton.font = .systemFont(ofSize: 11, weight: .semibold)
    pasteButton.target = self
    pasteButton.action = #selector(pasteTapped)

    pinButton.bezelStyle = .texturedRounded
    pinButton.controlSize = .small
    pinButton.image = NSImage(systemSymbolName: "pin", accessibilityDescription: "置顶")
    pinButton.target = self
    pinButton.action = #selector(pinTapped)

    deleteButton.bezelStyle = .texturedRounded
    deleteButton.controlSize = .small
    deleteButton.image = NSImage(systemSymbolName: "trash", accessibilityDescription: "删除")
    deleteButton.contentTintColor = .systemRed
    deleteButton.target = self
    deleteButton.action = #selector(deleteTapped)

    separator.boxType = .separator

    textCard.wantsLayer = true
    textCard.layer?.cornerRadius = 10
    textCard.layer?.cornerCurve = .continuous
    textCard.layer?.backgroundColor = NSColor.textBackgroundColor.withAlphaComponent(0.55).cgColor
    textCard.layer?.borderWidth = 1
    textCard.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.5).cgColor

    textView.isEditable = false
    textView.isSelectable = true
    textView.isRichText = false
    textView.drawsBackground = false
    textView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
    textView.textContainerInset = NSSize(width: 12, height: 12)
    textView.isVerticallyResizable = true
    textView.isHorizontallyResizable = false
    textView.autoresizingMask = [.width]
    textView.textContainer?.widthTracksTextView = true
    textView.minSize = NSSize(width: 0, height: 0)
    textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
    scroll.documentView = textView
    scroll.hasVerticalScroller = true
    scroll.drawsBackground = false
    scroll.borderType = .noBorder
    scroll.translatesAutoresizingMaskIntoConstraints = false
    textCard.addSubview(scroll)

    imageCard.wantsLayer = true
    imageCard.layer?.cornerRadius = 10
    imageCard.layer?.cornerCurve = .continuous
    imageCard.layer?.backgroundColor = NSColor.quaternaryLabelColor.withAlphaComponent(0.12).cgColor
    imageView.imageScaling = .scaleProportionallyDown
    imageView.imageAlignment = .alignCenter
    imageView.translatesAutoresizingMaskIntoConstraints = false
    imageCard.addSubview(imageView)

    placeholderGlyph.image = NSImage(systemSymbolName: "doc.on.clipboard", accessibilityDescription: nil)
    placeholderGlyph.contentTintColor = .tertiaryLabelColor
    placeholderGlyph.imageScaling = .scaleProportionallyDown
    placeholderGlyph.translatesAutoresizingMaskIntoConstraints = false
    placeholder.font = .systemFont(ofSize: 12)
    placeholder.textColor = .secondaryLabelColor
    placeholder.alignment = .center
    placeholder.lineBreakMode = .byWordWrapping
    placeholder.maximumNumberOfLines = 4
    placeholder.translatesAutoresizingMaskIntoConstraints = false

    footer.font = .systemFont(ofSize: 10.5)
    footer.textColor = .tertiaryLabelColor
    footer.lineBreakMode = .byTruncatingTail

    for view in [badgeBox, metaLabel, pasteButton, pinButton, deleteButton, separator, textCard, imageCard, placeholder, placeholderGlyph, footer] {
      view.translatesAutoresizingMaskIntoConstraints = false
      addSubview(view)
    }
    NSLayoutConstraint.activate([
      badgeBox.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      badgeBox.topAnchor.constraint(equalTo: topAnchor, constant: 14),
      badgeBox.heightAnchor.constraint(equalToConstant: 20),
      badge.leadingAnchor.constraint(equalTo: badgeBox.leadingAnchor, constant: 7),
      badge.trailingAnchor.constraint(equalTo: badgeBox.trailingAnchor, constant: -7),
      badge.centerYAnchor.constraint(equalTo: badgeBox.centerYAnchor),

      metaLabel.leadingAnchor.constraint(equalTo: badgeBox.trailingAnchor, constant: 8),
      metaLabel.centerYAnchor.constraint(equalTo: badgeBox.centerYAnchor),
      metaLabel.trailingAnchor.constraint(lessThanOrEqualTo: pasteButton.leadingAnchor, constant: -8),

      deleteButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
      deleteButton.centerYAnchor.constraint(equalTo: badgeBox.centerYAnchor),
      deleteButton.widthAnchor.constraint(equalToConstant: 30),
      pinButton.trailingAnchor.constraint(equalTo: deleteButton.leadingAnchor, constant: -6),
      pinButton.centerYAnchor.constraint(equalTo: badgeBox.centerYAnchor),
      pinButton.widthAnchor.constraint(equalToConstant: 30),
      pasteButton.trailingAnchor.constraint(equalTo: pinButton.leadingAnchor, constant: -8),
      pasteButton.centerYAnchor.constraint(equalTo: badgeBox.centerYAnchor),

      separator.topAnchor.constraint(equalTo: badgeBox.bottomAnchor, constant: 12),
      separator.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      separator.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),

      textCard.topAnchor.constraint(equalTo: separator.bottomAnchor, constant: 12),
      textCard.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
      textCard.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
      textCard.bottomAnchor.constraint(equalTo: footer.topAnchor, constant: -10),
      scroll.topAnchor.constraint(equalTo: textCard.topAnchor),
      scroll.leadingAnchor.constraint(equalTo: textCard.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: textCard.trailingAnchor),
      scroll.bottomAnchor.constraint(equalTo: textCard.bottomAnchor),

      imageCard.topAnchor.constraint(equalTo: textCard.topAnchor),
      imageCard.leadingAnchor.constraint(equalTo: textCard.leadingAnchor),
      imageCard.trailingAnchor.constraint(equalTo: textCard.trailingAnchor),
      imageCard.bottomAnchor.constraint(equalTo: textCard.bottomAnchor),
      imageView.topAnchor.constraint(equalTo: imageCard.topAnchor, constant: 8),
      imageView.leadingAnchor.constraint(equalTo: imageCard.leadingAnchor, constant: 8),
      imageView.trailingAnchor.constraint(equalTo: imageCard.trailingAnchor, constant: -8),
      imageView.bottomAnchor.constraint(equalTo: imageCard.bottomAnchor, constant: -8),

      placeholderGlyph.centerXAnchor.constraint(equalTo: centerXAnchor),
      placeholderGlyph.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -24),
      placeholderGlyph.widthAnchor.constraint(equalToConstant: 34),
      placeholderGlyph.heightAnchor.constraint(equalToConstant: 34),
      placeholder.topAnchor.constraint(equalTo: placeholderGlyph.bottomAnchor, constant: 10),
      placeholder.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 20),
      placeholder.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -20),

      footer.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      footer.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
      footer.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
      footer.heightAnchor.constraint(equalToConstant: 14)
    ])
    showPlaceholder("选择一条记录查看内容")
  }

  required init?(coder: NSCoder) { nil }

  @objc private func pasteTapped() { onPaste?() }
  @objc private func pinTapped() { onPin?() }
  @objc private func deleteTapped() { onDelete?() }

  private func setActionsVisible(_ visible: Bool) {
    pasteButton.isHidden = !visible
    pinButton.isHidden = !visible
    deleteButton.isHidden = !visible
  }

  func showPlaceholder(_ message: String) {
    badgeBox.isHidden = true
    metaLabel.isHidden = true
    separator.isHidden = true
    textCard.isHidden = true
    imageCard.isHidden = true
    placeholder.isHidden = false
    placeholderGlyph.isHidden = false
    placeholder.stringValue = message
    footer.stringValue = ""
    setActionsVisible(false)
  }

  func showText(kind: String, text: String, meta: String, footer note: String, pinned: Bool) {
    applyChrome(kind: kind, meta: meta, pinned: pinned)
    imageCard.isHidden = true
    textCard.isHidden = false
    textView.string = text
    textView.scrollToBeginningOfDocument(nil)
    footer.stringValue = note
  }

  func showImage(_ image: NSImage, kind: String, meta: String, footer note: String, pinned: Bool) {
    applyChrome(kind: kind, meta: meta, pinned: pinned)
    textCard.isHidden = true
    imageCard.isHidden = false
    imageView.image = image
    footer.stringValue = note
  }

  private func applyChrome(kind: String, meta: String, pinned: Bool) {
    let style = ClipboardKindStyle.info(for: kind)
    badge.stringValue = "  \(style.label)  "
    badge.textColor = style.tint
    badgeBox.layer?.backgroundColor = style.tint.withAlphaComponent(0.14).cgColor
    metaLabel.stringValue = meta
    pinButton.image = NSImage(systemSymbolName: pinned ? "pin.fill" : "pin", accessibilityDescription: "置顶")
    pinButton.contentTintColor = pinned ? .systemOrange : .secondaryLabelColor
    badgeBox.isHidden = false
    metaLabel.isHidden = false
    separator.isHidden = false
    placeholder.isHidden = true
    placeholderGlyph.isHidden = true
    setActionsVisible(true)
  }
}