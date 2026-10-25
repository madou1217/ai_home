import AppKit

enum TranslationPhase { case preflight, waiting, confirmation, streaming, done, stopped, failed }

// 仅负责布局与反馈，窗口和请求生命周期由 TranslationPanel 持有。
final class TranslationPanelContent {
  let root = NSVisualEffectView()
  let targetMenu = NSPopUpButton()
  let pin = NSButton(checkboxWithTitle: "置顶", target: nil, action: nil)
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
    stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false
    root.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
      stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 12),
      stack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -12)
    ])
    let heading = NSTextField(labelWithString: "译为")
    heading.textColor = .secondaryLabelColor
    heading.font = .systemFont(ofSize: 12)
    targetMenu.setAccessibilityLabel("目标语言")
    targetMenu.setContentHuggingPriority(.defaultLow, for: .horizontal)
    targetMenu.toolTip = "选择译文目标语言"
    pin.setAccessibilityLabel("置顶面板")
    pin.toolTip = "固定面板并保持在其他窗口上方"
    let controls = NSStackView(views: [heading, targetMenu, pin])
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
    source.font = .systemFont(ofSize: 11)
    source.textColor = .secondaryLabelColor
    source.lineBreakMode = .byTruncatingTail
    source.maximumNumberOfLines = 1
    hint.font = .systemFont(ofSize: 12)
    hint.textColor = .secondaryLabelColor
    textView.isEditable = false
    textView.isSelectable = true
    textView.drawsBackground = false
    textView.font = .systemFont(ofSize: 15)
    textView.textContainerInset = NSSize(width: 0, height: 4)
    textView.isHorizontallyResizable = false
    textView.isVerticallyResizable = true
    textView.autoresizingMask = [.width]
    textView.textContainer?.widthTracksTextView = true
    textView.setAccessibilityLabel("译文")
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.borderType = .noBorder
    scroll.documentView = textView
    scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 82).isActive = true
    scroll.setContentHuggingPriority(.defaultLow, for: .vertical)
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
    let footer = NSStackView(views: [model, stop, retry, override, keepOriginal, replace, copy])
    footer.spacing = 6
    for row in [controls, status, source, hint, scroll, footer] {
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
    model.stringValue = "正在连接翻译服务"
    setPhase(.waiting)
    scroll.contentView.scroll(to: .zero)
  }

  func setOutput(_ text: String) {
    textView.string = text
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
    let busy = next == .preflight || next == .waiting || next == .streaming
    let labels: [TranslationPhase: String] = [.preflight: "正在识别语言", .waiting: "正在翻译", .confirmation: "需要确认目标语言", .streaming: "正在生成译文", .done: "翻译完成", .stopped: "已停止", .failed: "翻译失败"]
    phaseLabel.stringValue = labels[next] ?? ""
    phaseLabel.textColor = next == .failed ? .systemRed : next == .done ? .systemGreen : busy ? .controlAccentColor : .secondaryLabelColor
    hint.stringValue = next == .preflight ? "正在确认原文与目标语言…" : next == .waiting ? "译文即将出现，生成后会实时显示" : next == .confirmation ? "请选择其它目标语言，或明确选择仍然翻译" : next == .stopped && !hasOutput ? "已停止生成，可以重新翻译" : ""
    hint.isHidden = hint.stringValue.isEmpty
    if busy && !reducedMotion { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
    stop.isHidden = !busy
    retry.isHidden = busy
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
    hint.stringValue = message
    hint.textColor = .secondaryLabelColor
    hint.isHidden = false
    // Only a confirmed same-language pair may bypass the guard. Missing or
    // low-confidence language information must be resolved through the target
    // picker; showing an override there would make the panel look ready while
    // the request is still ambiguous.
    setPhase(.confirmation)
  }

  func showPreflight(_ message: String = "正在确认原文与目标语言…") {
    hint.stringValue = message
    hint.textColor = .secondaryLabelColor
    hint.isHidden = false
    setPhase(.preflight)
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

  func updateElapsed(_ seconds: TimeInterval) {
    elapsed.stringValue = String(format: "%.1fs", seconds)
    if (phase == .preflight || phase == .waiting || phase == .streaming) && seconds >= 6 {
      phaseLabel.stringValue = phase == .preflight ? "语言识别较慢" : "模型响应较慢"
      phaseLabel.textColor = .systemOrange
      hint.stringValue = phase == .preflight ? "识别耗时较长，你可以继续等待或停止" : "仍在生成，你可以继续等待或停止"
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
