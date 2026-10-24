import AppKit

enum TranslationPhase { case waiting, confirmation, streaming, done, stopped, failed }

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
    let busy = next == .waiting || next == .streaming
    let labels: [TranslationPhase: String] = [.waiting: "正在翻译", .confirmation: "需要确认目标语言", .streaming: "正在生成译文", .done: "翻译完成", .stopped: "已停止", .failed: "翻译失败"]
    phaseLabel.stringValue = labels[next] ?? ""
    phaseLabel.textColor = next == .failed ? .systemRed : next == .done ? .systemGreen : busy ? .controlAccentColor : .secondaryLabelColor
    hint.stringValue = next == .waiting ? "译文即将出现，生成后会实时显示" : next == .confirmation ? "请选择其它目标语言，或明确选择仍然翻译" : next == .stopped && !hasOutput ? "已停止生成，可以重新翻译" : ""
    hint.isHidden = hint.stringValue.isEmpty
    if busy && !reducedMotion { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
    stop.isHidden = !busy
    retry.isHidden = busy
    override.isHidden = next != .confirmation
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

  func showConfirmation(_ message: String) {
    hint.stringValue = message
    hint.textColor = .secondaryLabelColor
    hint.isHidden = false
    setPhase(.confirmation)
  }

  func updateElapsed(_ seconds: TimeInterval) {
    elapsed.stringValue = String(format: "%.1fs", seconds)
    if phase == .waiting && seconds >= 6 {
      phaseLabel.stringValue = "仍在等待译文"
      hint.stringValue = "模型响应较慢，你可以继续等待或停止"
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
}
