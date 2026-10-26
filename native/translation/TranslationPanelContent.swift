import AppKit
import QuartzCore

enum TranslationPhase { case preflight, waiting, confirmation, streaming, done, stopped, failed }

// 仅负责布局与反馈，窗口和请求生命周期由 TranslationPanel 持有。
final class TranslationPanelContent {
  let root = NSVisualEffectView()
  let targetMenu = NSPopUpButton()
  let pin = NSButton(title: "", target: nil, action: nil)
  let settingsButton = NSButton(title: "", target: nil, action: nil)
  let modelPicker = NSComboBox()
  let stop = NSButton(title: "停止", target: nil, action: nil)
  let copy = NSButton(title: "复制", target: nil, action: nil)
  let replace = NSButton(title: "替换原文", target: nil, action: nil)
  let retry = NSButton(title: "重新翻译", target: nil, action: nil)
  let override = NSButton(title: "仍然翻译", target: nil, action: nil)
  let keepOriginal = NSButton(title: "保持原文", target: nil, action: nil)
  let textView = NSTextView()
  let source = NSTextField(labelWithString: "")
  let phaseLabel = NSTextField(labelWithString: "准备翻译")
  let elapsed = NSTextField(labelWithString: "")
  let model = NSTextField(labelWithString: "AIH Translation")
  let hint = NSTextField(wrappingLabelWithString: "")
  let spinner = NSProgressIndicator()
  let scroll = NSScrollView()
  private(set) var phase = TranslationPhase.waiting
  private var hasOutput = false
  private var firstOutput = true
  private var copyRevision = 0
  private var serverSwitchPending = false
  private var confirmationAllowsOverride = false
  private var settingsWindow: TranslationSettingsWindow?
  var settingsHandler: (([String: Any]) -> Void)?
  var settingsTarget = "zh-Hans"
  var settingsAutoCopy = false
  var settingsExecutionTarget = "aih-server"
  var settingsShortcut = ShortcutRegistry.defaultTranslationShortcut
  var settingsChatShortcut = ShortcutRegistry.defaultChatShortcut
  var settingsShortcutEnabled = true
  var settingsChatShortcutEnabled = true
  var settingsLanguages: [(String, String)] = []
  var settingsServerTargets: [[String: Any]] = []
  var settingsServerTarget: [String: Any]?
  private var pendingShortcutStatus = ""
  var reducedMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

  init() {
    root.material = .popover
    root.blendingMode = .behindWindow
    root.state = .active
    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 10
    stack.translatesAutoresizingMaskIntoConstraints = false
    root.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
      stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
      stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 16),
      stack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -16)
    ])
    let heading = NSTextField(labelWithString: "译为")
    heading.textColor = .secondaryLabelColor
    heading.font = .systemFont(ofSize: 12)
    targetMenu.setAccessibilityLabel("目标语言")
    targetMenu.setContentHuggingPriority(.defaultLow, for: .horizontal)
    targetMenu.toolTip = "选择译文目标语言"
    pin.setButtonType(.toggle)
    for button in [pin, settingsButton] {
      button.bezelStyle = .recessed
      button.isBordered = false
      button.imagePosition = .imageOnly
      button.widthAnchor.constraint(equalToConstant: 28).isActive = true
      button.heightAnchor.constraint(equalToConstant: 28).isActive = true
    }
    updatePin(false)
    settingsButton.image = NSImage(systemSymbolName: "slider.horizontal.3", accessibilityDescription: "翻译设置")
    settingsButton.toolTip = "翻译设置 · ⌘,"
    settingsButton.setAccessibilityLabel("翻译设置")
    let headerSpacer = NSView()
    headerSpacer.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
    let controls = NSStackView(views: [heading, targetMenu, headerSpacer, pin, settingsButton])
    controls.spacing = 8
    spinner.style = .spinning
    spinner.controlSize = .small
    spinner.isDisplayedWhenStopped = false
    spinner.widthAnchor.constraint(equalToConstant: 14).isActive = true
    spinner.heightAnchor.constraint(equalToConstant: 14).isActive = true
    phaseLabel.font = .systemFont(ofSize: 11, weight: .medium)
    elapsed.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
    elapsed.textColor = .secondaryLabelColor
    let spacer = NSView()
    spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let status = NSStackView(views: [spinner, phaseLabel, spacer, elapsed])
    status.spacing = 6
    source.font = .systemFont(ofSize: 12)
    source.textColor = .secondaryLabelColor
    source.lineBreakMode = .byTruncatingTail
    source.cell?.usesSingleLineMode = false
    source.cell?.wraps = true
    source.maximumNumberOfLines = 2
    source.heightAnchor.constraint(lessThanOrEqualToConstant: 36).isActive = true
    // The preview is allowed to truncate within the chosen window width.
    // Its intrinsic single-line width must never enlarge the NSPanel.
    source.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    source.setContentHuggingPriority(.defaultLow, for: .horizontal)
    hint.font = .systemFont(ofSize: 12)
    hint.textColor = .secondaryLabelColor
    hint.maximumNumberOfLines = 2
    hint.lineBreakMode = .byTruncatingTail
    hint.heightAnchor.constraint(lessThanOrEqualToConstant: 36).isActive = true
    hint.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    textView.isEditable = false
    textView.isSelectable = true
    textView.drawsBackground = false
    textView.font = .systemFont(ofSize: 16)
    textView.textColor = .labelColor
    textView.textContainerInset = NSSize(width: 0, height: 10)
    textView.isHorizontallyResizable = false
    textView.isVerticallyResizable = true
    textView.minSize = .zero
    textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
    textView.autoresizingMask = [.width]
    textView.textContainer?.containerSize = NSSize(width: 440, height: CGFloat.greatestFiniteMagnitude)
    textView.textContainer?.widthTracksTextView = true
    textView.textContainer?.lineBreakMode = .byWordWrapping
    textView.setAccessibilityLabel("译文")
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.hasHorizontalScroller = false
    scroll.autohidesScrollers = true
    scroll.borderType = .noBorder
    scroll.documentView = textView
    scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 82).isActive = true
    scroll.setContentHuggingPriority(.defaultLow, for: .vertical)
    modelPicker.isEditable = true
    modelPicker.completes = true
    modelPicker.numberOfVisibleItems = 8
    modelPicker.placeholderString = "默认模型 · 可输入模型 ID"
    modelPicker.font = .systemFont(ofSize: 12)
    modelPicker.setAccessibilityLabel("翻译模型，可选择或手动输入模型 ID")
    modelPicker.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    modelPicker.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let modelHeading = NSTextField(labelWithString: "模型")
    modelHeading.font = .systemFont(ofSize: 12)
    modelHeading.textColor = .secondaryLabelColor
    let modelRow = NSStackView(views: [modelHeading, modelPicker])
    modelRow.spacing = 8
    model.font = .systemFont(ofSize: 10)
    model.textColor = .tertiaryLabelColor
    model.lineBreakMode = .byTruncatingMiddle
    model.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    for button in [stop, retry, override, keepOriginal, replace, copy] {
      button.bezelStyle = .rounded
      button.controlSize = .small
      button.imagePosition = .imageLeading
    }
    stop.image = NSImage(systemSymbolName: "stop.fill", accessibilityDescription: nil)
    retry.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: nil)
    copy.image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: nil)
    replace.image = NSImage(systemSymbolName: "arrow.down.doc", accessibilityDescription: nil)
    stop.setAccessibilityLabel("停止翻译")
    retry.setAccessibilityLabel("重新翻译")
    override.setAccessibilityLabel("仍然翻译")
    keepOriginal.setAccessibilityLabel("保持原文")
    replace.setAccessibilityLabel("替换原文")
    replace.toolTip = "替换原文；完成后可用 ⌘Z / Ctrl+Z 撤回"
    copy.setAccessibilityLabel("复制译文")
    let actionSpacer = NSView()
    actionSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let footer = NSStackView(views: [stop, retry, override, keepOriginal, actionSpacer, replace, copy])
    footer.spacing = 6
    for row in [controls, modelRow, source, status, hint, scroll, model, footer] {
      stack.addArrangedSubview(row)
      row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }
    setPhase(.waiting, animated: false)
  }

  func begin(_ text: String) {
    copyRevision += 1
    confirmationAllowsOverride = false
    source.stringValue = text.replacingOccurrences(of: "\n", with: " ")
    source.toolTip = text
    textView.string = ""
    hasOutput = false
    firstOutput = true
    copy.title = "复制"
    copy.image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: nil)
    hint.textColor = .secondaryLabelColor
    model.stringValue = ""
    replace.title = "替换原文"
    replace.image = NSImage(systemSymbolName: "arrow.down.doc", accessibilityDescription: nil)
    setPhase(.waiting)
    scroll.contentView.scroll(to: .zero)
  }

  func setOutput(_ text: String) {
    // Append deltas without resetting the reader's selection or scroll position.
    let visibleOrigin = scroll.contentView.bounds.origin
    let selectedRanges = textView.selectedRanges
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineSpacing = 5
    paragraph.paragraphSpacing = 12
    paragraph.lineBreakMode = .byWordWrapping
    let attributes: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: 16), .foregroundColor: NSColor.labelColor,
      .paragraphStyle: paragraph
    ]
    let previous = textView.string
    if text.hasPrefix(previous), let storage = textView.textStorage {
      storage.append(NSAttributedString(string: String(text.dropFirst(previous.count)), attributes: attributes))
    } else {
      textView.textStorage?.setAttributedString(NSAttributedString(string: text, attributes: attributes))
    }
    if !previous.isEmpty {
      let length = (text as NSString).length
      textView.selectedRanges = selectedRanges.filter { NSMaxRange($0.rangeValue) <= length }
      scroll.contentView.scroll(to: visibleOrigin)
      scroll.reflectScrolledClipView(scroll.contentView)
    }
    hasOutput = !text.isEmpty
    if firstOutput && hasOutput {
      firstOutput = false
      fadeIn(textView)
    }
    if hasOutput && copy.isHidden { copy.isHidden = false; fadeIn(copy) }
  }

  private func fadeIn(_ view: NSView) {
    guard !reducedMotion else { view.alphaValue = 1; return }
    view.alphaValue = 0.35
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.18
      view.animator().alphaValue = 1
    }
  }

  func setPhase(_ next: TranslationPhase, animated: Bool = true) {
    phase = next
    elapsed.isHidden = next == .preflight || next == .confirmation
    let busy = next == .preflight || next == .waiting || next == .streaming
    let labels: [TranslationPhase: String] = [.preflight: "正在准备翻译", .waiting: "等待模型响应", .confirmation: "需要确认目标语言", .streaming: "正在生成译文", .done: "翻译完成", .stopped: "已停止", .failed: "翻译失败"]
    phaseLabel.stringValue = labels[next] ?? ""
    phaseLabel.textColor = next == .failed ? .systemRed : next == .done ? .secondaryLabelColor : busy ? .controlAccentColor : .secondaryLabelColor
    hint.stringValue = next == .preflight ? "正在确认原文与目标语言…" : next == .waiting ? "译文即将出现，生成后会实时显示" : next == .confirmation ? "请选择其它目标语言，或明确选择仍然翻译" : next == .stopped && !hasOutput ? "已停止生成，可以重新翻译" : ""
    hint.isHidden = hint.stringValue.isEmpty
    if busy && !reducedMotion { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
    stop.isHidden = !busy
    retry.isHidden = busy || next == .confirmation
    override.isHidden = next != .confirmation || !confirmationAllowsOverride
    keepOriginal.isHidden = next != .confirmation
    retry.title = next == .failed ? "重试" : "重新翻译"
    copy.isHidden = !hasOutput
    replace.isHidden = true
    if animated { fadeIn(phaseLabel); if !busy { fadeIn(retry) } }
  }

  func setReplacementAvailable(_ available: Bool) {
    replace.isHidden = !available || !hasOutput
    if available { fadeIn(replace) }
  }

  func replacementApplied() {
    replace.title = "已替换（点击撤回）"
    replace.image = NSImage(systemSymbolName: "arrow.uturn.backward", accessibilityDescription: nil)
    fadeIn(replace)
  }

  func replacementUndone() {
    replace.title = "替换原文"
    replace.image = NSImage(systemSymbolName: "arrow.down.doc", accessibilityDescription: nil)
    fadeIn(replace)
  }

  func showConfirmation(_ message: String, allowsOverride: Bool) {
    confirmationAllowsOverride = allowsOverride
    // Only a confirmed same-language pair may bypass the guard. Missing or
    // low-confidence language information must be resolved through the target
    // picker; showing an override there would make the panel look ready while
    // the request is still ambiguous.
    setPhase(.confirmation)
    hint.stringValue = message
    hint.textColor = .secondaryLabelColor
    hint.isHidden = false
  }

  func showPreflight(_ message: String = "正在确认原文与目标语言…") {
    setPhase(.preflight)
    hint.stringValue = message
    hint.textColor = .secondaryLabelColor
    hint.isHidden = false
  }

  func serverSwitching(_ label: String) {
    serverSwitchPending = true
    model.stringValue = "正在切换：\(label)"
    model.toolTip = model.stringValue
    hint.stringValue = "正在连接翻译服务…"
    hint.textColor = .secondaryLabelColor
    hint.isHidden = false
  }

  func serverReady(_ label: String) {
    guard serverSwitchPending else { return }
    serverSwitchPending = false
    model.stringValue = "服务：\(label)"
    model.toolTip = model.stringValue
    hint.stringValue = "翻译服务已就绪"
    hint.textColor = .systemGreen
    hint.isHidden = false
    fadeIn(hint)
  }

  func serverFailure(_ message: String) {
    serverSwitchPending = false
    failure(message)
  }

  func updatePin(_ pinned: Bool) {
    pin.image = NSImage(systemSymbolName: pinned ? "pin.fill" : "pin", accessibilityDescription: nil)
    pin.contentTintColor = pinned ? .controlAccentColor : .secondaryLabelColor
    pin.setAccessibilityLabel(pinned ? "取消置顶" : "置顶面板")
    pin.toolTip = pinned ? "已置顶 · 点击取消" : "保持在其他窗口上方，不改变位置"
    fadeIn(pin)
  }

  func updateElapsed(_ seconds: TimeInterval) {
    guard phase != .confirmation && phase != .preflight else { elapsed.stringValue = ""; return }
    elapsed.stringValue = seconds < 1 ? String(format: "%.0f ms", max(0, seconds) * 1000) : String(format: "%.1f s", seconds)
    if phase == .waiting && seconds >= 8 {
      phaseLabel.stringValue = "仍在等待模型响应"
      hint.stringValue = "尚未收到译文。可以停止，或换一个模型重试。"
      hint.textColor = .secondaryLabelColor
      hint.isHidden = false
    }
  }

  func failure(_ message: String) {
    setPhase(.failed)
    hint.stringValue = message
    hint.textColor = .systemRed
    hint.isHidden = false
  }

  func autoCopied() {
    copyRevision += 1
    let revision = copyRevision
    copy.title = "已自动复制"
    copy.image = NSImage(systemSymbolName: "checkmark", accessibilityDescription: nil)
    fadeIn(copy)
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [weak self] in
      guard let self = self, self.copyRevision == revision else { return }
      self.copy.title = "复制"
      self.copy.image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: nil)
    }
  }

  func copied() {
    copyRevision += 1
    let revision = copyRevision
    copy.title = "已复制"
    copy.image = NSImage(systemSymbolName: "checkmark", accessibilityDescription: nil)
    fadeIn(copy)
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [weak self] in
      guard let self = self, self.copyRevision == revision else { return }
      self.copy.title = "复制"
      self.copy.image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: nil)
    }
  }

  /// Raises the single native settings window. Configuration is intentionally
  /// passed as value state so this view never needs to open or embed WebUI.
  func showSettings() {
    if let settingsWindow = settingsWindow {
      settingsWindow.present(on: NSScreen.main)
      return
    }
    guard let settingsHandler = settingsHandler else { return }
    let created = TranslationSettingsWindow(
      target: settingsTarget,
      autoCopyEnabled: settingsAutoCopy,
      executionTarget: settingsExecutionTarget,
      shortcut: settingsShortcut,
      chatShortcut: settingsChatShortcut,
      shortcutEnabled: settingsShortcutEnabled,
      chatShortcutEnabled: settingsChatShortcutEnabled,
      shortcutStatus: pendingShortcutStatus,
      languages: settingsLanguages,
      serverTargets: settingsServerTargets,
      selectedServerTarget: settingsServerTarget,
      reducedMotion: reducedMotion,
      emit: settingsHandler,
      onClosed: { [weak self] in self?.settingsWindow = nil }
    )
    settingsWindow = created
    created.setShortcutStatus(pendingShortcutStatus)
    created.present(on: NSScreen.main)
  }

  /// Keep shortcut registration failures visible without stopping the helper
  /// or replacing the host application's menus.
  func showShortcutStatus(_ message: String) {
    pendingShortcutStatus = message
    hint.stringValue = message
    hint.textColor = .systemRed
    hint.isHidden = false
    fadeIn(hint)
    settingsWindow?.setShortcutStatus(message)
  }
}

// The selection entry is a circular system-material control, without a nested bezel.
final class TranslationTriggerButton: NSButton {
  private var hoverTracking: NSTrackingArea?
  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let area = hoverTracking { removeTrackingArea(area) }
    let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
    addTrackingArea(area)
    hoverTracking = area
  }
  override func mouseEntered(with event: NSEvent) { setHovered(true) }
  override func mouseExited(with event: NSEvent) { setHovered(false) }
  private func setHovered(_ value: Bool) {
    wantsLayer = true
    layer?.cornerRadius = 19
    let color = (value ? NSColor.controlAccentColor.withAlphaComponent(0.12) : NSColor.clear).cgColor
    if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
      let animation = CABasicAnimation(keyPath: "backgroundColor")
      animation.fromValue = layer?.presentation()?.backgroundColor ?? layer?.backgroundColor
      animation.toValue = color
      animation.duration = 0.12
      layer?.add(animation, forKey: "hover")
    }
    layer?.backgroundColor = color
  }
}
