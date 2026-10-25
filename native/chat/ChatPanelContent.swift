import AppKit

enum ChatPanelState: Equatable {
  case disconnected
  case connecting
  case idle
  case streaming
  case stopping
  case failed
}

private final class ChatBubbleView: NSVisualEffectView {
  let label = NSTextField(wrappingLabelWithString: "")

  init(role: String, text: String) {
    super.init(frame: .zero)
    material = role == "你" ? .contentBackground : .sidebar
    blendingMode = .withinWindow
    state = .active
    wantsLayer = true
    layer?.cornerRadius = 12
    layer?.borderWidth = 1
    layer?.borderColor = (role == "你" ? NSColor.controlAccentColor : NSColor.separatorColor).withAlphaComponent(0.28).cgColor
    label.stringValue = text
    label.font = .systemFont(ofSize: 13)
    label.textColor = .labelColor
    label.lineBreakMode = .byWordWrapping
    label.maximumNumberOfLines = 0
    label.setAccessibilityLabel(role == "你" ? "用户消息" : "AIH 消息")
    label.translatesAutoresizingMaskIntoConstraints = false
    addSubview(label)
    NSLayoutConstraint.activate([
      label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
      label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      label.topAnchor.constraint(equalTo: topAnchor, constant: 9),
      label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -9)
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

private final class ChatMessageRow: NSStackView {
  init(role: String, text: String) {
    super.init(frame: .zero)
    orientation = .horizontal
    alignment = .top
    spacing = 8
    let avatar = NSTextField(labelWithString: role == "你" ? "你" : "✦")
    avatar.alignment = .center
    avatar.font = .systemFont(ofSize: 11, weight: .semibold)
    avatar.textColor = role == "你" ? .secondaryLabelColor : .controlAccentColor
    avatar.wantsLayer = true
    avatar.layer?.cornerRadius = 9
    avatar.layer?.backgroundColor = (role == "你" ? NSColor.separatorColor : NSColor.controlAccentColor).withAlphaComponent(0.14).cgColor
    avatar.widthAnchor.constraint(equalToConstant: 26).isActive = true
    avatar.heightAnchor.constraint(equalToConstant: 26).isActive = true
    let bubble = ChatBubbleView(role: role, text: text)
    bubble.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    let spacer = NSView()
    spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    if role == "你" {
      addArrangedSubview(spacer)
      addArrangedSubview(bubble)
      addArrangedSubview(avatar)
    } else {
      addArrangedSubview(avatar)
      addArrangedSubview(bubble)
      addArrangedSubview(spacer)
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

final class ChatComposerTextView: NSTextView {
  var submitHandler: (() -> Void)?

  override func keyDown(with event: NSEvent) {
    if event.keyCode == 36 && !event.modifierFlags.contains(.shift) {
      submitHandler?()
      return
    }
    super.keyDown(with: event)
  }
}

// WebUI-aligned native surface. ChatPanel owns lifecycle; this object owns only layout and presentation.
final class ChatPanelContent: NSObject, NSTextViewDelegate {
  let root = NSVisualEffectView()
  let transcript = NSStackView()
  let composer = ChatComposerTextView()
  let sendStop = NSButton(title: "发送", target: nil, action: nil)
  let reconnect = NSButton(title: "重新连接", target: nil, action: nil)
  let stateLabel = NSTextField(labelWithString: "未连接")
  let sessionLabel = NSTextField(labelWithString: "会话：未连接")
  let modelLabel = NSTextField(labelWithString: "模型：—")
  let placeholderLabel = NSTextField(labelWithString: "发送消息…")
  let scroll = NSScrollView()
  let emptyState = NSTextField(wrappingLabelWithString: "选择一段文字开始 Chat，或直接输入消息")

  private(set) var state: ChatPanelState = .disconnected
  private var transcriptLines: [(role: String, text: String)] = []
  private var assistantLineIndex: Int?
  private var composerHeight: NSLayoutConstraint!
  var sendHandler: (() -> Void)?
  var stopHandler: (() -> Void)?
  var reconnectHandler: (() -> Void)?
  var reducedMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

  override init() {
    super.init()
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
      stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
      stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 14),
      stack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -14)
    ])

    let heading = NSTextField(labelWithString: "AIH Chat")
    heading.font = .systemFont(ofSize: 15, weight: .semibold)
    let icon = NSTextField(labelWithString: "✦")
    icon.font = .systemFont(ofSize: 15, weight: .medium)
    icon.textColor = .controlAccentColor
    let headingSpacer = NSView()
    headingSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    stateLabel.font = .systemFont(ofSize: 11, weight: .medium)
    stateLabel.alignment = .center
    stateLabel.textColor = .secondaryLabelColor
    let headingRow = NSStackView(views: [icon, heading, headingSpacer, stateLabel])
    headingRow.spacing = 7

    sessionLabel.font = .systemFont(ofSize: 10)
    sessionLabel.textColor = .secondaryLabelColor
    sessionLabel.lineBreakMode = .byTruncatingMiddle
    sessionLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    modelLabel.font = .systemFont(ofSize: 10)
    modelLabel.textColor = .tertiaryLabelColor
    modelLabel.lineBreakMode = .byTruncatingMiddle
    modelLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    let statusRow = NSStackView(views: [sessionLabel, modelLabel])
    statusRow.spacing = 8

    transcript.orientation = .vertical
    transcript.alignment = .leading
    transcript.spacing = 10
    transcript.edgeInsets = NSEdgeInsets(top: 10, left: 2, bottom: 14, right: 2)
    transcript.setAccessibilityLabel("Chat 对话")
    let transcriptContainer = NSView()
    transcript.translatesAutoresizingMaskIntoConstraints = false
    transcriptContainer.addSubview(transcript)
    NSLayoutConstraint.activate([
      transcript.leadingAnchor.constraint(equalTo: transcriptContainer.leadingAnchor),
      transcript.trailingAnchor.constraint(equalTo: transcriptContainer.trailingAnchor),
      transcript.topAnchor.constraint(equalTo: transcriptContainer.topAnchor),
      transcript.bottomAnchor.constraint(equalTo: transcriptContainer.bottomAnchor)
    ])
    emptyState.font = .systemFont(ofSize: 12)
    emptyState.textColor = .tertiaryLabelColor
    emptyState.alignment = .center
    emptyState.maximumNumberOfLines = 2
    emptyState.translatesAutoresizingMaskIntoConstraints = false
    transcriptContainer.addSubview(emptyState)
    NSLayoutConstraint.activate([
      emptyState.centerXAnchor.constraint(equalTo: transcriptContainer.centerXAnchor),
      emptyState.centerYAnchor.constraint(equalTo: transcriptContainer.centerYAnchor),
      emptyState.leadingAnchor.constraint(greaterThanOrEqualTo: transcriptContainer.leadingAnchor, constant: 28),
      emptyState.trailingAnchor.constraint(lessThanOrEqualTo: transcriptContainer.trailingAnchor, constant: -28)
    ])
    scroll.documentView = transcriptContainer
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.borderType = .noBorder
    scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 210).isActive = true
    scroll.setContentHuggingPriority(.defaultLow, for: .vertical)

    let composerShell = NSVisualEffectView()
    composerShell.material = .contentBackground
    composerShell.blendingMode = .withinWindow
    composerShell.state = .active
    composerShell.wantsLayer = true
    composerShell.layer?.cornerRadius = 12
    composerShell.layer?.borderWidth = 1
    composerShell.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.45).cgColor
    composerShell.translatesAutoresizingMaskIntoConstraints = false
    composer.translatesAutoresizingMaskIntoConstraints = false
    composer.isRichText = false
    composer.isAutomaticQuoteSubstitutionEnabled = false
    composer.isAutomaticDataDetectionEnabled = false
    composer.drawsBackground = false
    composer.font = .systemFont(ofSize: 13)
    composer.textContainerInset = NSSize(width: 10, height: 9)
    composer.textContainer?.widthTracksTextView = true
    composer.isVerticallyResizable = false
    composer.isHorizontallyResizable = false
    composer.delegate = self
    composer.submitHandler = { [weak self] in self?.sendHandler?() }
    composer.setAccessibilityLabel("Chat 输入")
    composerHeight = composer.heightAnchor.constraint(equalToConstant: 42)
    composerHeight.isActive = true
    placeholderLabel.font = .systemFont(ofSize: 13)
    placeholderLabel.textColor = .tertiaryLabelColor
    placeholderLabel.translatesAutoresizingMaskIntoConstraints = false
    composerShell.addSubview(composer)
    composerShell.addSubview(placeholderLabel)
    NSLayoutConstraint.activate([
      composer.leadingAnchor.constraint(equalTo: composerShell.leadingAnchor),
      composer.trailingAnchor.constraint(equalTo: composerShell.trailingAnchor),
      composer.topAnchor.constraint(equalTo: composerShell.topAnchor),
      composer.bottomAnchor.constraint(equalTo: composerShell.bottomAnchor),
      placeholderLabel.leadingAnchor.constraint(equalTo: composerShell.leadingAnchor, constant: 12),
      placeholderLabel.topAnchor.constraint(equalTo: composerShell.topAnchor, constant: 9)
    ])

    sendStop.bezelStyle = .texturedRounded
    sendStop.controlSize = .regular
    sendStop.imagePosition = .imageOnly
    sendStop.target = self
    sendStop.action = #selector(sendOrStop)
    reconnect.bezelStyle = .texturedRounded
    reconnect.controlSize = .small
    reconnect.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: "重新连接")
    reconnect.target = self
    reconnect.action = #selector(reconnectChat)
    let composerRow = NSStackView(views: [composerShell, sendStop, reconnect])
    composerRow.spacing = 7
    composerRow.alignment = .bottom
    composerShell.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    for row in [headingRow, statusRow, transcriptContainer, composerRow] {
      stack.addArrangedSubview(row)
      row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }
    setState(.disconnected, sessionID: "", model: "", message: "")
  }

  @objc private func sendOrStop() { state == .streaming ? stopHandler?() : sendHandler?() }
  @objc private func reconnectChat() { reconnectHandler?() }

  func textViewDidChange(_ notification: Notification) {
    let lineCount = max(1, min(6, composer.string.components(separatedBy: "\n").count))
    composerHeight.constant = CGFloat(42 + max(0, lineCount - 1) * 16)
    placeholderLabel.isHidden = !composer.string.isEmpty
    updateControls()
  }

  func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
    // Enter handling lives in ChatComposerTextView so Shift+Enter remains a newline.
    commandSelector == #selector(NSResponder.insertNewline(_:))
  }

  func setState(_ next: ChatPanelState, sessionID: String, model: String, message: String) {
    state = next
    let labels: [ChatPanelState: String] = [
      .disconnected: "未连接", .connecting: "正在连接", .idle: "已连接",
      .streaming: "生成中", .stopping: "正在停止", .failed: "连接失败"
    ]
    stateLabel.stringValue = message.isEmpty ? (labels[next] ?? "") : message
    stateLabel.textColor = next == .failed ? .systemRed : next == .streaming ? .controlAccentColor : .secondaryLabelColor
    sessionLabel.stringValue = sessionID.isEmpty ? "会话：未连接" : "会话：\(sessionID)"
    sessionLabel.toolTip = sessionID
    modelLabel.stringValue = model.isEmpty ? "模型：—" : "模型：\(model)"
    modelLabel.toolTip = model
    updateControls()
    if !reducedMotion { animate(stateLabel) }
  }

  private func updateControls() {
    let canSend = state == .idle && !composer.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    let canStop = state == .streaming
    sendStop.image = NSImage(systemSymbolName: canStop ? "stop.fill" : "arrow.up", accessibilityDescription: nil)
    sendStop.contentTintColor = canStop ? .systemRed : .controlAccentColor
    sendStop.isEnabled = canSend || canStop
    composer.isEditable = state == .idle
    reconnect.isHidden = !(state == .disconnected || state == .failed)
    reconnect.isEnabled = state == .disconnected || state == .failed
  }

  func clearTranscript() {
    transcriptLines = []
    assistantLineIndex = nil
    renderTranscript()
  }

  func append(role: String, text: String) {
    guard !text.isEmpty else { return }
    assistantLineIndex = nil
    transcriptLines.append((role, text))
    renderTranscript()
    scrollToBottom()
  }

  func replaceTranscript(_ text: String) {
    transcriptLines = text.isEmpty ? [] : [("AIH", text)]
    assistantLineIndex = text.isEmpty ? nil : 0
    renderTranscript()
    scrollToBottom()
  }

  func currentText() -> String { composer.string }

  func setComposerText(_ text: String) {
    composer.string = text
    textViewDidChange(Notification(name: NSTextView.didChangeNotification))
  }

  func clearComposer() {
    composer.string = ""
    textViewDidChange(Notification(name: NSTextView.didChangeNotification))
  }

  func replaceCurrentAssistant(_ text: String) {
    guard !text.isEmpty else { return }
    if let index = assistantLineIndex, transcriptLines.indices.contains(index) {
      transcriptLines[index].text = text
    } else {
      transcriptLines.append(("AIH", text))
      assistantLineIndex = transcriptLines.index(before: transcriptLines.endIndex)
    }
    renderTranscript()
    scrollToBottom()
  }

  private func renderTranscript() {
    transcript.arrangedSubviews.forEach { $0.removeFromSuperview() }
    emptyState.isHidden = !transcriptLines.isEmpty
    for line in transcriptLines {
      let row = ChatMessageRow(role: line.role, text: line.text)
      row.widthAnchor.constraint(equalTo: transcript.widthAnchor).isActive = true
      transcript.addArrangedSubview(row)
      if !reducedMotion { animate(row) }
    }
  }

  private func scrollToBottom() {
    guard let document = scroll.documentView else { return }
    document.layoutSubtreeIfNeeded()
    scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, document.bounds.height - scroll.contentView.bounds.height)))
    scroll.reflectScrolledClipView(scroll.contentView)
  }

  private func animate(_ view: NSView) {
    guard !reducedMotion else { view.alphaValue = 1; return }
    view.alphaValue = 0.35
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.18
      context.timingFunction = CAMediaTimingFunction(name: .easeOut)
      view.animator().alphaValue = 1
    }
  }
}
