import AppKit

enum ChatPanelState: Equatable {
  case disconnected
  case connecting
  case idle
  case streaming
  case stopping
  case failed
}

// The content object owns only layout and state-derived controls. ChatPanel
// owns the request/session lifecycle and supplies the JSONL callbacks.
final class ChatPanelContent: NSObject {
  let root = NSVisualEffectView()
  let transcript = NSTextView()
  let composer = NSTextField()
  let sendStop = NSButton(title: "发送", target: nil, action: nil)
  let reconnect = NSButton(title: "重新连接", target: nil, action: nil)
  let stateLabel = NSTextField(labelWithString: "未连接")
  let sessionLabel = NSTextField(labelWithString: "会话：未连接")
  let modelLabel = NSTextField(labelWithString: "模型：—")
  let scroll = NSScrollView()

  private(set) var state: ChatPanelState = .disconnected
  private var transcriptRevision = 0
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
    stack.spacing = 8
    stack.translatesAutoresizingMaskIntoConstraints = false
    root.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 14),
      stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -14),
      stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 12),
      stack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -12)
    ])

    let heading = NSTextField(labelWithString: "Chat")
    heading.font = .systemFont(ofSize: 14, weight: .semibold)
    heading.setContentHuggingPriority(.required, for: .horizontal)
    stateLabel.font = .systemFont(ofSize: 11, weight: .medium)
    stateLabel.textColor = .secondaryLabelColor
    let headingSpacer = NSView()
    headingSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let headingRow = NSStackView(views: [heading, headingSpacer, stateLabel])
    headingRow.spacing = 8

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

    transcript.isEditable = false
    transcript.isSelectable = true
    transcript.drawsBackground = false
    transcript.font = .systemFont(ofSize: 13)
    transcript.textContainerInset = NSSize(width: 0, height: 4)
    transcript.isHorizontallyResizable = false
    transcript.isVerticallyResizable = true
    transcript.autoresizingMask = [.width]
    transcript.textContainer?.widthTracksTextView = true
    transcript.setAccessibilityLabel("Chat 对话")
    scroll.documentView = transcript
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.borderType = .noBorder
    scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 170).isActive = true
    scroll.setContentHuggingPriority(.defaultLow, for: .vertical)

    composer.placeholderString = "输入消息…"
    composer.font = .systemFont(ofSize: 13)
    composer.lineBreakMode = .byTruncatingTail
    composer.setAccessibilityLabel("Chat 输入")
    composer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    composer.target = self
    composer.action = #selector(submitFromComposer)

    sendStop.bezelStyle = .rounded
    sendStop.controlSize = .small
    sendStop.imagePosition = .imageLeading
    sendStop.setAccessibilityLabel("发送 Chat 消息")
    sendStop.target = self
    sendStop.action = #selector(sendOrStop)
    reconnect.bezelStyle = .rounded
    reconnect.controlSize = .small
    reconnect.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: nil)
    reconnect.setAccessibilityLabel("重新连接 Chat")
    reconnect.target = self
    reconnect.action = #selector(reconnectChat)
    let composerRow = NSStackView(views: [composer, sendStop, reconnect])
    composerRow.spacing = 6
    composerRow.alignment = .centerY

    for row in [headingRow, statusRow, scroll, composerRow] {
      stack.addArrangedSubview(row)
      row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }
    composer.widthAnchor.constraint(greaterThanOrEqualToConstant: 160).isActive = true
    setState(.disconnected, sessionID: "", model: "", message: "")
  }

  @objc private func submitFromComposer() { sendHandler?() }

  @objc private func sendOrStop() {
    if state == .streaming { stopHandler?() } else { sendHandler?() }
  }

  @objc private func reconnectChat() { reconnectHandler?() }

  func setState(_ next: ChatPanelState, sessionID: String, model: String, message: String) {
    state = next
    let labels: [ChatPanelState: String] = [
      .disconnected: "未连接", .connecting: "正在连接", .idle: "就绪",
      .streaming: "生成中", .stopping: "正在停止", .failed: "连接失败"
    ]
    stateLabel.stringValue = message.isEmpty ? (labels[next] ?? "") : message
    stateLabel.textColor = next == .failed ? .systemRed : next == .streaming ? .controlAccentColor : .secondaryLabelColor
    sessionLabel.stringValue = sessionID.isEmpty ? "会话：未连接" : "会话：(sessionID)"
    sessionLabel.toolTip = sessionID
    modelLabel.stringValue = model.isEmpty ? "模型：—" : "模型：(model)"
    modelLabel.toolTip = model

    let canSend = next == .idle && !composer.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    let canStop = next == .streaming
    sendStop.title = canStop ? "停止" : "发送"
    sendStop.image = canStop
      ? NSImage(systemSymbolName: "stop.fill", accessibilityDescription: nil)
      : NSImage(systemSymbolName: "arrow.up.circle.fill", accessibilityDescription: nil)
    sendStop.setAccessibilityLabel(canStop ? "停止 Chat 生成" : "发送 Chat 消息")
    sendStop.isEnabled = canSend || canStop
    composer.isEnabled = next == .idle
    reconnect.isHidden = !(next == .disconnected || next == .failed)
    reconnect.isEnabled = next == .disconnected || next == .failed
    if !reducedMotion { fadeIn(stateLabel) }
  }

  func clearTranscript() {
    transcriptRevision += 1
    transcript.string = ""
    scroll.contentView.scroll(to: .zero)
  }

  func append(role: String, text: String) {
    let value = text
    guard !value.isEmpty else { return }
    let prefix = transcript.string.isEmpty ? "" : "\n\n"
    let line = "\(prefix)\(role)：\(value)"
    transcript.textStorage?.append(NSAttributedString(string: line))
    transcriptRevision += 1
    scrollToBottom()
    if !reducedMotion { fadeIn(transcript) }
  }

  func replaceTranscript(_ text: String) {
    transcript.string = text
    transcriptRevision += 1
    scrollToBottom()
  }

  func currentText() -> String { composer.stringValue }

  func clearComposer() { composer.stringValue = "" }

  private func scrollToBottom() {
    transcript.layoutManager?.ensureLayout(for: transcript.textContainer!)
    let length = transcript.string.utf16.count
    transcript.scrollRangeToVisible(NSRange(location: length, length: 0))
  }

  private func fadeIn(_ view: NSView) {
    guard !reducedMotion else { view.alphaValue = 1; return }
    view.alphaValue = 0.45
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.14
      view.animator().alphaValue = 1
    }
  }
}
