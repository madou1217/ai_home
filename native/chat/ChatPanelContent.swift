import AppKit

enum ChatPanelState: Equatable {
  case disconnected, connecting, idle, streaming, stopping, failed
}

private enum ChatPalette {
  static let accent = NSColor(name: nil) { appearance in
    appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
      ? NSColor(srgbRed: 0, green: 0.94, blue: 1, alpha: 1)
      : NSColor(srgbRed: 0, green: 0.43, blue: 0.49, alpha: 1)
  }
}

private final class ChatSurface: NSView {
  var fill: NSColor = .windowBackgroundColor
  var border: NSColor = .clear
  override var wantsUpdateLayer: Bool { true }
  override func updateLayer() {
    layer?.backgroundColor = fill.cgColor
    layer?.borderColor = border.cgColor
    layer?.borderWidth = 1
    layer?.cornerRadius = 4
  }
}

private final class ChatDocument: NSView {
  override var isFlipped: Bool { true }
}

/// Each message retains its text system while streaming, preserving selection.
private final class ChatMessageRow: NSView {
  let textView = NSTextView()
  private var textHeight: NSLayoutConstraint!
  private var lastWidth: CGFloat = 0
  private var horizontalInset: CGFloat = 24
  private let surface = ChatSurface()

  init(role: String, text: String) {
    super.init(frame: .zero)
    let isUser = role == "你" || role == "user"
    horizontalInset = isUser ? 52 : 24
    surface.fill = isUser ? .controlBackgroundColor : .clear
    surface.border = isUser ? ChatPalette.accent.withAlphaComponent(0.2) : .clear
    surface.wantsLayer = true
    surface.translatesAutoresizingMaskIntoConstraints = false
    addSubview(surface)
    let author = NSTextField(labelWithString: isUser ? "YOU" : "AIH")
    author.font = .monospacedSystemFont(ofSize: 10, weight: .semibold)
    author.textColor = isUser ? .secondaryLabelColor : ChatPalette.accent
    author.translatesAutoresizingMaskIntoConstraints = false
    textView.isEditable = false
    textView.isSelectable = true
    textView.isRichText = false
    textView.drawsBackground = false
    textView.font = .systemFont(ofSize: 13)
    textView.textColor = .labelColor
    textView.textContainerInset = .zero
    textView.textContainer?.lineFragmentPadding = 0
    textView.textContainer?.widthTracksTextView = true
    textView.textContainer?.heightTracksTextView = false
    textView.isHorizontallyResizable = false
    textView.isVerticallyResizable = false
    textView.translatesAutoresizingMaskIntoConstraints = false
    textView.setAccessibilityLabel(isUser ? "用户消息" : "AIH 回复")
    surface.addSubview(author)
    surface.addSubview(textView)
    textHeight = textView.heightAnchor.constraint(equalToConstant: 20)
    NSLayoutConstraint.activate([
      surface.leadingAnchor.constraint(equalTo: leadingAnchor, constant: isUser ? 28 : 0),
      surface.trailingAnchor.constraint(equalTo: trailingAnchor),
      surface.topAnchor.constraint(equalTo: topAnchor),
      surface.bottomAnchor.constraint(equalTo: bottomAnchor),
      author.leadingAnchor.constraint(equalTo: surface.leadingAnchor, constant: 12),
      author.topAnchor.constraint(equalTo: surface.topAnchor, constant: 10),
      author.trailingAnchor.constraint(lessThanOrEqualTo: surface.trailingAnchor, constant: -12),
      textView.leadingAnchor.constraint(equalTo: surface.leadingAnchor, constant: 12),
      textView.trailingAnchor.constraint(equalTo: surface.trailingAnchor, constant: -12),
      textView.topAnchor.constraint(equalTo: author.bottomAnchor, constant: 7),
      textView.bottomAnchor.constraint(equalTo: surface.bottomAnchor, constant: -12),
      textHeight
    ])
    update(text)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func update(_ text: String) {
    let old = textView.string
    let selection = textView.selectedRange()
    if text.hasPrefix(old), let storage = textView.textStorage {
      let suffix = String(text.dropFirst(old.count))
      let paragraph = NSMutableParagraphStyle()
      paragraph.lineSpacing = 4
      storage.append(NSAttributedString(string: suffix, attributes: [
        .font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor.labelColor,
        .paragraphStyle: paragraph
      ]))
    } else {
      textView.string = text
    }
    if NSMaxRange(selection) <= (text as NSString).length { textView.setSelectedRange(selection) }
    measureText()
  }

  func prepare(width: CGFloat) {
    setFrameSize(NSSize(width: width, height: frame.height))
  }

  override func setFrameSize(_ newSize: NSSize) {
    super.setFrameSize(newSize)
    if abs(lastWidth - (newSize.width - horizontalInset)) > 0.5 { measureText() }
  }

  private func measureText() {
    guard let container = textView.textContainer, let manager = textView.layoutManager else { return }
    lastWidth = bounds.width - horizontalInset
    guard lastWidth > 1 else { return }
    container.containerSize = NSSize(width: lastWidth, height: CGFloat.greatestFiniteMagnitude)
    manager.ensureLayout(for: container)
    textHeight.constant = max(20, ceil(manager.usedRect(for: container).height))
  }
}

final class ChatComposerTextView: NSTextView {
  var submitHandler: (() -> Void)?
  var layoutHandler: (() -> Void)?

  override func keyDown(with event: NSEvent) {
    // An IME owns Return while composing. Shift/Option + Return remain native newlines.
    if (event.keyCode == 36 || event.keyCode == 76), !hasMarkedText(),
       event.modifierFlags.intersection([.shift, .option, .control]).isEmpty {
      submitHandler?()
      return
    }
    super.keyDown(with: event)
  }

  override func setFrameSize(_ newSize: NSSize) {
    let changed = abs(frame.width - newSize.width) > 0.5
    super.setFrameSize(newSize)
    if changed { layoutHandler?() }
  }
}

/// Presentation only; ChatPanel remains the owner of session and command identity.
final class ChatPanelContent: NSObject, NSTextViewDelegate {
  let root = NSVisualEffectView()
  let transcript = NSStackView()
  let composer = ChatComposerTextView()
  let sendStop = NSButton(title: "发送", target: nil, action: nil)
  let reconnect = NSButton(title: "重试", target: nil, action: nil)
  let pin = NSButton()
  let stateLabel = NSTextField(labelWithString: "未连接")
  let sessionLabel = NSTextField(labelWithString: "新对话")
  let modelLabel = NSTextField(labelWithString: "")
  let placeholderLabel = NSTextField(labelWithString: "输入消息，或从选中文字开始…")
  let scroll = NSScrollView()
  let emptyState = NSTextField(wrappingLabelWithString: "有什么想聊的？\n输入问题，或选中文字后使用 AIH Chat。")

  private let composerScroll = NSScrollView()
  private let progress = NSProgressIndicator()
  private let document = ChatDocument()
  private var rows: [ChatMessageRow] = []
  private var assistantRow: ChatMessageRow?
  private var assistantRows: [String: ChatMessageRow] = [:]
  private let composerHint = NSTextField(labelWithString: "↵ 发送 · ⇧↵ 换行")
  private var composerHeight: NSLayoutConstraint!
  private var measuringComposer = false
  private var stateStartedAt = Date()
  private var stateMessage = ""
  private var statusTimer: Timer?
  private var pinned = true
  private(set) var state: ChatPanelState = .disconnected
  var sendHandler: (() -> Void)?
  var stopHandler: (() -> Void)?
  var reconnectHandler: (() -> Void)?
  var pinHandler: ((Bool) -> Void)?
  var closeHandler: (() -> Void)?
  var reducedMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

  override init() {
    super.init()
    root.material = .windowBackground
    root.blendingMode = .withinWindow
    root.state = .active
    buildHeader()
    buildTimeline()
    buildComposer()
    setPinned(true)
    setState(.disconnected, sessionID: "", model: "", message: "")
  }

  deinit { statusTimer?.invalidate() }

  private func buildHeader() {
    let heading = NSTextField(labelWithString: "AIH / CHAT")
    heading.font = .monospacedSystemFont(ofSize: 11, weight: .semibold)
    heading.textColor = ChatPalette.accent
    sessionLabel.font = .systemFont(ofSize: 11)
    sessionLabel.textColor = .secondaryLabelColor
    sessionLabel.lineBreakMode = .byTruncatingTail
    let spacer = NSView()
    spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    configureIcon(pin, symbol: "pin.fill", label: "取消置顶", action: #selector(togglePin))
    let close = NSButton()
    configureIcon(close, symbol: "xmark", label: "收起 Chat", action: #selector(closeChat))
    let header = NSStackView(views: [heading, sessionLabel, spacer, pin, close])
    header.spacing = 8
    header.alignment = .centerY
    mount(header)
    NSLayoutConstraint.activate([
      header.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 14),
      header.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -10),
      header.topAnchor.constraint(equalTo: root.topAnchor, constant: 5),
      header.heightAnchor.constraint(equalToConstant: 32)
    ])
    let divider = NSBox()
    divider.boxType = .separator
    mount(divider)
    NSLayoutConstraint.activate([
      divider.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      divider.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      divider.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 5)
    ])
    progress.style = .spinning
    progress.controlSize = .small
    progress.isDisplayedWhenStopped = false
    progress.widthAnchor.constraint(equalToConstant: 12).isActive = true
    progress.heightAnchor.constraint(equalToConstant: 12).isActive = true
    stateLabel.font = .monospacedSystemFont(ofSize: 10, weight: .regular)
    stateLabel.lineBreakMode = .byTruncatingTail
    stateLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    modelLabel.font = .monospacedSystemFont(ofSize: 10, weight: .regular)
    modelLabel.textColor = .secondaryLabelColor
    modelLabel.lineBreakMode = .byTruncatingMiddle
    modelLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    reconnect.bezelStyle = .inline
    reconnect.font = .systemFont(ofSize: 11)
    reconnect.contentTintColor = ChatPalette.accent
    reconnect.target = self
    reconnect.action = #selector(reconnectChat)
    let statusSpacer = NSView()
    statusSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let status = NSStackView(views: [progress, stateLabel, reconnect, statusSpacer, modelLabel])
    status.spacing = 6
    mount(status)
    NSLayoutConstraint.activate([
      status.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 14),
      status.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -14),
      status.topAnchor.constraint(equalTo: divider.bottomAnchor, constant: 6),
      status.heightAnchor.constraint(equalToConstant: 22)
    ])
    stateLabel.toolTip = "连接与回复状态"
  }

  private func buildTimeline() {
    transcript.orientation = .vertical
    transcript.alignment = .leading
    transcript.spacing = 14
    transcript.translatesAutoresizingMaskIntoConstraints = false
    transcript.setAccessibilityLabel("Chat 对话")
    document.translatesAutoresizingMaskIntoConstraints = false
    document.addSubview(transcript)
    scroll.documentView = document
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.borderType = .noBorder
    mount(scroll)
    let preferredHeight = document.heightAnchor.constraint(equalTo: transcript.heightAnchor, constant: 28)
    preferredHeight.priority = .defaultHigh
    NSLayoutConstraint.activate([
      scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      scroll.topAnchor.constraint(equalTo: root.topAnchor, constant: 78),
      document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
      document.heightAnchor.constraint(greaterThanOrEqualTo: scroll.contentView.heightAnchor),
      preferredHeight,
      transcript.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 12),
      transcript.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -12),
      transcript.topAnchor.constraint(equalTo: document.topAnchor, constant: 12),
      transcript.bottomAnchor.constraint(lessThanOrEqualTo: document.bottomAnchor, constant: -16)
    ])
    emptyState.font = .systemFont(ofSize: 13)
    emptyState.textColor = .secondaryLabelColor
    emptyState.alignment = .center
    emptyState.maximumNumberOfLines = 3
    mount(emptyState)
    NSLayoutConstraint.activate([
      emptyState.centerXAnchor.constraint(equalTo: scroll.centerXAnchor),
      emptyState.centerYAnchor.constraint(equalTo: scroll.centerYAnchor, constant: -8),
      emptyState.widthAnchor.constraint(lessThanOrEqualTo: scroll.widthAnchor, constant: -48)
    ])
  }

  private func buildComposer() {
    let shell = ChatSurface()
    shell.fill = .controlBackgroundColor
    shell.border = .separatorColor
    shell.wantsLayer = true
    mount(shell)
    composer.isRichText = false
    composer.allowsUndo = true
    composer.isAutomaticQuoteSubstitutionEnabled = false
    composer.isAutomaticDataDetectionEnabled = false
    composer.drawsBackground = false
    composer.font = .systemFont(ofSize: 13)
    composer.textColor = .labelColor
    composer.insertionPointColor = ChatPalette.accent
    composer.textContainerInset = NSSize(width: 8, height: 10)
    composer.textContainer?.widthTracksTextView = true
    composer.isVerticallyResizable = true
    composer.isHorizontallyResizable = false
    composer.autoresizingMask = [.width]
    composer.minSize = NSSize(width: 0, height: 44)
    composer.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
    composer.delegate = self
    composer.submitHandler = { [weak self] in
      guard let self, self.canSubmit else { return }
      self.sendHandler?()
    }
    composer.layoutHandler = { [weak self] in self?.measureComposer() }
    composer.setAccessibilityLabel("Chat 输入")
    composerScroll.documentView = composer
    composerScroll.drawsBackground = false
    composerScroll.hasVerticalScroller = true
    composerScroll.autohidesScrollers = true
    composerScroll.borderType = .noBorder
    composerScroll.translatesAutoresizingMaskIntoConstraints = false
    shell.addSubview(composerScroll)
    composerHeight = composerScroll.heightAnchor.constraint(equalToConstant: 52)
    placeholderLabel.font = .systemFont(ofSize: 13)
    placeholderLabel.textColor = .placeholderTextColor
    placeholderLabel.translatesAutoresizingMaskIntoConstraints = false
    shell.addSubview(placeholderLabel)
    composerHint.font = .systemFont(ofSize: 10)
    composerHint.textColor = .secondaryLabelColor
    let spacer = NSView()
    spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    configureIcon(sendStop, symbol: "arrow.up", label: "发送消息", action: #selector(sendOrStop))
    let tools = NSStackView(views: [composerHint, spacer, sendStop])
    tools.translatesAutoresizingMaskIntoConstraints = false
    shell.addSubview(tools)
    NSLayoutConstraint.activate([
      shell.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
      shell.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),
      shell.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -12),
      scroll.bottomAnchor.constraint(equalTo: shell.topAnchor, constant: -8),
      composerScroll.leadingAnchor.constraint(equalTo: shell.leadingAnchor, constant: 1),
      composerScroll.trailingAnchor.constraint(equalTo: shell.trailingAnchor, constant: -1),
      composerScroll.topAnchor.constraint(equalTo: shell.topAnchor, constant: 1),
      composerHeight,
      placeholderLabel.leadingAnchor.constraint(equalTo: shell.leadingAnchor, constant: 14),
      placeholderLabel.topAnchor.constraint(equalTo: shell.topAnchor, constant: 10),
      placeholderLabel.trailingAnchor.constraint(lessThanOrEqualTo: shell.trailingAnchor, constant: -12),
      tools.leadingAnchor.constraint(equalTo: shell.leadingAnchor, constant: 12),
      tools.trailingAnchor.constraint(equalTo: shell.trailingAnchor, constant: -8),
      tools.topAnchor.constraint(equalTo: composerScroll.bottomAnchor),
      tools.heightAnchor.constraint(equalToConstant: 28),
      tools.bottomAnchor.constraint(equalTo: shell.bottomAnchor, constant: -6)
    ])
  }

  private func mount(_ view: NSView) {
    view.translatesAutoresizingMaskIntoConstraints = false
    root.addSubview(view)
  }

  private func configureIcon(_ button: NSButton, symbol: String, label: String, action: Selector) {
    button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
    button.imagePosition = .imageOnly
    button.bezelStyle = .texturedRounded
    button.isBordered = false
    button.toolTip = label
    button.setAccessibilityLabel(label)
    button.target = self
    button.action = action
    button.widthAnchor.constraint(equalToConstant: 26).isActive = true
    button.heightAnchor.constraint(equalToConstant: 26).isActive = true
  }

  @objc private func sendOrStop() {
    if state == .streaming { stopHandler?() }
    else if canSubmit { sendHandler?() }
  }
  @objc private func reconnectChat() { reconnectHandler?() }
  @objc private func closeChat() { closeHandler?() }
  @objc private func togglePin() { setPinned(!pinned); pinHandler?(pinned) }

  func setPinned(_ value: Bool) {
    pinned = value
    pin.image = NSImage(systemSymbolName: value ? "pin.fill" : "pin", accessibilityDescription: value ? "取消置顶" : "置顶")
    pin.contentTintColor = value ? ChatPalette.accent : .secondaryLabelColor
    pin.toolTip = value ? "取消置顶" : "保持窗口置顶"
    pin.setAccessibilityLabel(pin.toolTip)
  }

  func textDidChange(_ notification: Notification) {
    placeholderLabel.isHidden = !composer.string.isEmpty
    measureComposer()
    updateControls()
  }

  private func measureComposer() {
    guard !measuringComposer, composerHeight != nil,
          let manager = composer.layoutManager, let container = composer.textContainer,
          composer.bounds.width > 1 else { return }
    measuringComposer = true
    defer { measuringComposer = false }
    manager.ensureLayout(for: container)
    composerHeight.constant = min(132, max(52, ceil(manager.usedRect(for: container).height) + 20))
  }

  func setState(_ next: ChatPanelState, sessionID: String, model: String, message: String) {
    let changed = state != next
    state = next
    stateMessage = message
    if changed {
      stateStartedAt = Date()
      statusTimer?.invalidate()
      statusTimer = nil
      if next == .connecting || next == .streaming || next == .stopping {
        statusTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.updateStatusText() }
      }
    }
    sessionLabel.stringValue = sessionID.isEmpty ? "新对话" : "对话中"
    sessionLabel.toolTip = nil
    modelLabel.stringValue = model
    modelLabel.toolTip = model
    updateStatusText()
    updateControls()
    if changed { animate(stateLabel) }
  }

  private func updateStatusText() {
    let seconds = Int(Date().timeIntervalSince(stateStartedAt))
    let defaults: [ChatPanelState: String] = [
      .disconnected: "未连接", .connecting: "正在连接", .idle: "就绪",
      .streaming: "正在回复", .stopping: "正在停止", .failed: "连接失败"
    ]
    let base = stateMessage.isEmpty ? defaults[state] ?? "" : stateMessage
    let busy = state == .connecting || state == .streaming || state == .stopping
    stateLabel.stringValue = busy && seconds >= 5 ? "\(base) · \(seconds)s" : base
    stateLabel.toolTip = stateLabel.stringValue
    stateLabel.textColor = state == .failed ? .systemRed : busy ? ChatPalette.accent : .secondaryLabelColor
    if busy { progress.startAnimation(nil) } else { progress.stopAnimation(nil) }
    progress.isHidden = !busy
  }

  private var canSubmit: Bool {
    state == .idle && composer.string.utf16.count <= 8000
      && !composer.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private func updateControls() {
    let canSend = canSubmit
    let count = composer.string.utf16.count
    composerHint.stringValue = count > 8000 ? "\(count) / 8000 · 请缩短消息" : "↵ 发送 · ⇧↵ 换行"
    composerHint.textColor = count > 8000 ? .systemRed : .secondaryLabelColor
    let canStop = state == .streaming
    let actionLabel = canStop ? "停止回复" : "发送消息"
    sendStop.image = NSImage(systemSymbolName: canStop ? "stop.fill" : "arrow.up", accessibilityDescription: actionLabel)
    sendStop.toolTip = actionLabel
    sendStop.setAccessibilityLabel(actionLabel)
    sendStop.contentTintColor = canStop ? .systemRed : ChatPalette.accent
    sendStop.isEnabled = canSend || canStop
    // Drafting remains available during connection and generation.
    composer.isEditable = true
    reconnect.isHidden = !(state == .disconnected || state == .failed)
    reconnect.isEnabled = !reconnect.isHidden
  }

  func clearTranscript() {
    for row in rows { transcript.removeArrangedSubview(row); row.removeFromSuperview() }
    rows.removeAll()
    assistantRow = nil
    assistantRows.removeAll()
    emptyState.isHidden = false
  }

  func append(role: String, text: String) {
    guard !text.isEmpty else { return }
    assistantRow = nil
    _ = addRow(role: role, text: text)
    scrollToBottom()
  }

  func restoreMessages(_ messages: [(role: String, text: String)]) {
    clearTranscript()
    for message in messages where !message.text.isEmpty { _ = addRow(role: message.role, text: message.text, animated: false) }
    scrollToBottom()
  }

  func replaceTranscript(_ text: String) {
    restoreMessages(text.isEmpty ? [] : [(role: "AIH", text: text)])
  }

  func currentText() -> String { composer.string }
  func setComposerText(_ text: String) {
    composer.string = text
    textDidChange(Notification(name: NSText.didChangeNotification))
  }
  func clearComposer() { setComposerText("") }

  func upsertAssistant(id: String, text: String) {
    guard !id.isEmpty else { return }
    let follow = isNearBottom
    if let row = assistantRows[id] {
      row.update(text)
    } else if !text.isEmpty {
      assistantRows[id] = addRow(role: "AIH", text: text)
    }
    if follow { scrollToBottom() }
  }

  func replaceCurrentAssistant(_ text: String) {
    guard !text.isEmpty else { return }
    let follow = isNearBottom
    if let row = assistantRow { row.update(text) }
    else { assistantRow = addRow(role: "AIH", text: text) }
    if follow { scrollToBottom() }
  }

  private func addRow(role: String, text: String, animated: Bool = true) -> ChatMessageRow {
    let row = ChatMessageRow(role: role, text: text)
    row.prepare(width: transcript.bounds.width)
    row.translatesAutoresizingMaskIntoConstraints = false
    transcript.addArrangedSubview(row)
    row.widthAnchor.constraint(equalTo: transcript.widthAnchor).isActive = true
    rows.append(row)
    emptyState.isHidden = true
    if animated { animate(row) }
    return row
  }

  private var isNearBottom: Bool {
    document.bounds.height - scroll.contentView.bounds.maxY < 96
  }

  private func scrollToBottom() {
    root.layoutSubtreeIfNeeded()
    scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, document.bounds.height - scroll.contentView.bounds.height)))
    scroll.reflectScrolledClipView(scroll.contentView)
  }

  private func animate(_ view: NSView) {
    guard !reducedMotion else { view.alphaValue = 1; return }
    view.alphaValue = 0.35
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.16
      context.timingFunction = CAMediaTimingFunction(name: .easeOut)
      view.animator().alphaValue = 1
    }
  }
}
