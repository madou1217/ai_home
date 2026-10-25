import AppKit

final class ChatPanel: NSObject, NSWindowDelegate {
  let emit: ([String: Any]) -> Void
  let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 440, height: 470), styleMask: [.titled, .closable, .resizable, .nonactivatingPanel], backing: .buffered, defer: false)
  let content = ChatPanelContent()

  private(set) var state: ChatPanelState = .disconnected
  private(set) var sessionGeneration = 0
  private(set) var commandGeneration = 0
  private var requestID = ""
  private var sessionID = ""
  private var commandID = ""
  private var model = ""
  private var target: [String: Any] = ["kind": "aih-server"]
  private var assistantText = ""
  private var configured = false

  init(emit: @escaping ([String: Any]) -> Void) {
    self.emit = emit
    super.init()
    panel.title = "AIH Chat"
    panel.delegate = self
    panel.level = .floating
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.minSize = NSSize(width: 360, height: 320)
    panel.maxSize = NSSize(width: 900, height: 1000)
    panel.contentView = content.root
    content.sendHandler = { [weak self] in self?.sendCurrentMessage() }
    content.stopHandler = { [weak self] in self?.stopCurrentMessage() }
    content.reconnectHandler = { [weak self] in self?.reconnect() }
  }

  func configure(_ event: [String: Any]) {
    configured = true
    if let configuredTarget = event["chatTarget"] as? [String: Any] { target = configuredTarget }
    else if let configuredTarget = event["serverTarget"] as? [String: Any] { target = configuredTarget }
    if let configuredModel = event["chatModel"] as? String { model = configuredModel }
    content.setState(state, sessionID: sessionID, model: model, message: "")
  }

  func show() {
    if !panel.isVisible { panel.center() }
    panel.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    if state == .disconnected && configured { openSession() }
  }

  func hide() { panel.orderOut(nil) }

  func close() {
    closeSession()
    panel.orderOut(nil)
  }

  // All actions below are JSONL projections. Provider CLIs, HTTP and runtime
  // credentials stay in the Node host; Swift only carries identity and text.
  private func openSession() {
    guard state == .disconnected || state == .failed else { return }
    sessionGeneration += 1
    commandGeneration += 1
    requestID = UUID().uuidString
    sessionID = ""
    commandID = ""
    assistantText = ""
    content.clearTranscript()
    setState(.connecting, message: "正在连接")
    emit(["type": "chat.open", "requestId": requestID, "target": target, "generation": sessionGeneration])
  }

  private func reconnect() {
    if state == .streaming || state == .stopping { return }
    closeSession(emitEvent: false)
    openSession()
  }

  private func sendCurrentMessage() {
    let text = content.currentText().trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, state == .idle, !sessionID.isEmpty, !requestID.isEmpty else { return }
    commandGeneration += 1
    commandID = UUID().uuidString
    assistantText = ""
    content.clearComposer()
    content.append(role: "你", text: text)
    setState(.streaming, message: "生成中")
    emit([
      "type": "chat.submit", "requestId": requestID, "sessionId": sessionID,
      "commandId": commandID, "text": text, "generation": commandGeneration
    ])
  }

  private func stopCurrentMessage() {
    guard state == .streaming, !sessionID.isEmpty, !commandID.isEmpty else { return }
    setState(.stopping, message: "正在停止")
    emit([
      "type": "chat.stop", "requestId": requestID, "sessionId": sessionID,
      "commandId": commandID, "generation": commandGeneration
    ])
  }

  private func closeSession(emitEvent: Bool = true) {
    guard !requestID.isEmpty else { return }
    if emitEvent { emit(["type": "chat.close", "requestId": requestID, "generation": sessionGeneration]) }
    sessionGeneration += 1
    commandGeneration += 1
    requestID = ""
    sessionID = ""
    commandID = ""
    assistantText = ""
    setState(.disconnected, message: "未连接")
  }

  func receive(_ event: [String: Any]) {
    guard let type = event["type"] as? String else { return }
    switch type {
    case "chat.open":
      configured = true
      if let incomingTarget = event["target"] as? [String: Any] { target = incomingTarget }
      if let incomingRequest = event["requestId"] as? String, incomingRequest == requestID {
        show()
      } else if state == .disconnected || state == .failed {
        openSession()
      } else {
        show()
      }
    case "chat.submit":
      // Host acknowledgements are identity-only; native never executes text.
      guard matches(event, session: true, command: true) else { return }
    case "chat.stop":
      guard matches(event, session: true, command: true) else { return }
      setState(.stopping, message: "正在停止")
    case "chat.close":
      guard requestMatches(event) else { return }
      closeSession(emitEvent: false)
      hide()
    case "chat.event":
      receiveRuntimeEvent(event)
    case "chat.error":
      receiveError(event)
    default:
      return
    }
  }

  private func receiveRuntimeEvent(_ wrapper: [String: Any]) {
    guard requestMatches(wrapper), let incomingSession = wrapper["sessionId"] as? String,
          let runtime = wrapper["event"] as? [String: Any] else { return }
    if !sessionID.isEmpty && incomingSession != sessionID { return }
    if let generation = integer(wrapper["generation"]), generation < sessionGeneration { return }
    if let generation = integer(runtime["generation"]), generation < sessionGeneration { return }
    if let runtimeSession = runtime["sessionId"] as? String, runtimeSession != incomingSession { return }
    if let incomingCommand = commandIdentity(runtime), !commandID.isEmpty,
       incomingCommand != commandID && isCommandEvent(runtime["type"] as? String) { return }
    if sessionID.isEmpty { sessionID = incomingSession }
    if let runtimeModel = modelValue(runtime) { model = runtimeModel }
    let type = runtime["type"] as? String ?? ""
    switch type {
    case "session.created", "session.runtime.bound", "session.runtime.rebound", "session.snapshot.reset":
      if type == "session.snapshot.reset" { restoreSnapshot(runtime) }
      setState(.idle, message: "就绪")
    case "turn.queued", "turn.started", "timeline.item.started", "timeline.item.updated":
      setState(.streaming, message: "生成中")
    case "timeline.item.delta":
      let payload = runtime["payload"] as? [String: Any] ?? [:]
      let chunk = payload["chunk"] as? String ?? ""
      if !chunk.isEmpty {
        assistantText += chunk
        content.replaceTranscriptWithAssistant(assistantText)
      }
      setState(.streaming, message: "生成中")
    case "turn.interrupted":
      setState(.idle, message: "已停止")
    case "turn.completed":
      setState(.idle, message: "就绪")
    case "turn.failed", "stream.error", "run.lost":
      let payload = runtime["payload"] as? [String: Any] ?? [:]
      receiveError(["requestId": requestID, "sessionId": sessionID, "commandId": commandID,
                    "code": payload["error"] as? String ?? "chat_runtime_failed",
                    "message": payload["message"] as? String ?? "Chat 运行失败"])
    case "session.closed":
      setState(.disconnected, message: "会话已关闭")
    default:
      break
    }
  }

  private func receiveError(_ event: [String: Any]) {
    guard requestMatches(event) else { return }
    if let incomingSession = event["sessionId"] as? String, !sessionID.isEmpty, incomingSession != sessionID { return }
    if let incomingCommand = event["commandId"] as? String, !commandID.isEmpty, incomingCommand != commandID { return }
    let message = (event["message"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "Chat 连接失败"
    setState(.failed, message: message.isEmpty ? "Chat 连接失败" : message)
  }

  private func restoreSnapshot(_ runtime: [String: Any]) {
    guard let payload = runtime["payload"] as? [String: Any], let timeline = payload["timeline"] as? [[String: Any]] else { return }
    let text = timeline.compactMap { item -> String? in
      guard let content = item["content"] as? String, !content.isEmpty else { return nil }
      let role = (item["kind"] as? String) == "user" ? "你" : "AIH"
      return "\(role)：\(content)"
    }.joined(separator: "\n\n")
    content.replaceTranscript(text)
  }

  private func matches(_ event: [String: Any], session: Bool, command: Bool) -> Bool {
    guard requestMatches(event) else { return false }
    if session, let incoming = event["sessionId"] as? String, !sessionID.isEmpty, incoming != sessionID { return false }
    if command, let incoming = event["commandId"] as? String, !commandID.isEmpty, incoming != commandID { return false }
    if let generation = integer(event["generation"]), generation < commandGeneration { return false }
    return true
  }

  private func requestMatches(_ event: [String: Any]) -> Bool {
    guard let incoming = event["requestId"] as? String, !incoming.isEmpty else { return false }
    return !requestID.isEmpty && incoming == requestID
  }

  private func commandIdentity(_ runtime: [String: Any]) -> String? {
    if let value = runtime["commandId"] as? String { return value }
    let payload = runtime["payload"] as? [String: Any]
    return payload?["commandId"] as? String
  }

  private func isCommandEvent(_ type: String?) -> Bool {
    guard let type else { return false }
    return type.hasPrefix("turn.") || type.hasPrefix("timeline.")
  }

  private func modelValue(_ runtime: [String: Any]) -> String? {
    if let value = runtime["model"] as? String, !value.isEmpty { return value }
    if let payload = runtime["payload"] as? [String: Any], let value = payload["model"] as? String, !value.isEmpty { return value }
    return nil
  }

  private func integer(_ value: Any?) -> Int? {
    if let number = value as? Int { return number }
    if let number = value as? NSNumber { return number.intValue }
    return nil
  }

  private func setState(_ next: ChatPanelState, message: String) {
    state = next
    content.setState(next, sessionID: sessionID, model: model, message: message)
  }

  func windowWillClose(_ notification: Notification) {
    closeSession()
  }
}

private extension ChatPanelContent {
  func replaceTranscriptWithAssistant(_ text: String) {
    let prefix = transcript.string.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? ""
    let userPrefix = prefix.hasPrefix("你：") ? prefix : ""
    replaceTranscript(userPrefix.isEmpty ? "AIH：\(text)" : "\(userPrefix)\n\nAIH：\(text)")
  }
}
