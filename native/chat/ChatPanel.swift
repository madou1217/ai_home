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
  private var provider = ""
  private var target: [String: Any] = ["kind": "aih-server"]
  private var assistantItems: [String: String] = [:]
  private var assistantItemIDs = Set<String>()
  private var assistantMetadataByID: [String: String] = [:]
  private var assistantTurnByID: [String: String] = [:]
  private var turnMetrics: [String: [String: Any]] = [:]
  private var pendingServiceText = ""
  private var pendingServiceRequestID = ""
  private var failedDraftText = ""
  private var lastSubmittedText = ""
  private var pendingFileReferencePath = ""
  private var configured = false
  private var connectionTimeout: Timer?
  private var pinned = true

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
    content.pinHandler = { [weak self] value in
      guard let self else { return }
      self.pinned = value
      self.panel.level = self.pinned ? .floating : .normal
      self.content.setPinned(self.pinned)
    }
    content.setPinned(pinned)
    content.closeHandler = { [weak self] in self?.hide() }
  }

  func configure(_ event: [String: Any]) {
    configured = true
    if let configuredTarget = event["chatTarget"] as? [String: Any] { target = configuredTarget }
    else if let configuredTarget = event["serverTarget"] as? [String: Any] { target = configuredTarget }
    if let configuredModel = event["chatModel"] as? String { model = configuredModel }
    content.setState(state, sessionID: sessionID, model: model, provider: provider, message: "")
    if panel.isVisible && state == .disconnected {
      show()
      pendingServiceRequestID = requestID
      submitPendingServiceTextIfReady()
    }
  }

  func show() {
    if !panel.isVisible { panel.center() }
    panel.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    if state == .disconnected && configured { openSession() }
  }

  /// Shortcut actions enter through the same chat.open JSONL shell command as
  /// every other panel launch; the shortcut layer never owns a runtime.
  func openFromShortcut() { show() }

  /// Services supplies only selected text. The existing Chat Runtime session
  /// and identity guards remain the sole path for submitting it.
  func openFromService(text: String) {
    let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else { return }
    if state == .failed { closeSession() }
    pendingServiceText = normalized
    pendingServiceRequestID = ""
    content.setComposerText(normalized)
    show()
    pendingServiceRequestID = requestID
    submitPendingServiceTextIfReady()
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
    assistantItems.removeAll()
    assistantItemIDs.removeAll()
    assistantMetadataByID.removeAll()
    assistantTurnByID.removeAll()
    turnMetrics.removeAll()
    content.clearTranscript()
    setState(.connecting, message: "正在连接")
    let openingRequest = requestID
    connectionTimeout?.invalidate()
    connectionTimeout = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
      guard let self, self.requestID == openingRequest, self.state == .connecting else { return }
      self.setState(.failed, message: "连接超时，请重试")
    }
    emit(["type": "chat.open", "requestId": requestID, "target": target, "generation": sessionGeneration])
  }

  private func reconnect() {
    if state == .streaming || state == .stopping { return }
    let pending = pendingServiceText.isEmpty ? failedDraftText : pendingServiceText
    closeSession()
    pendingServiceText = pending
    failedDraftText = ""
    openSession()
    pendingServiceRequestID = requestID
  }

  private func sendCurrentMessage() {
    let text = content.currentText().trimmingCharacters(in: .whitespacesAndNewlines)
    submitMessage(text)
  }

  private func submitPendingServiceTextIfReady() {
    guard state == .idle, !sessionID.isEmpty, !requestID.isEmpty,
          !pendingServiceText.isEmpty, pendingServiceRequestID == requestID else { return }
    let text = pendingServiceText
    pendingServiceText = ""
    pendingServiceRequestID = ""
    submitMessage(text)
  }

  private func submitMessage(_ text: String) {
    guard !text.isEmpty, state == .idle, !sessionID.isEmpty, !requestID.isEmpty else { return }
    commandGeneration += 1
    commandID = UUID().uuidString
    assistantItems.removeAll()
    assistantItemIDs.removeAll()
    assistantMetadataByID.removeAll()
    assistantTurnByID.removeAll()
    turnMetrics.removeAll()
    failedDraftText = ""
    lastSubmittedText = text
    content.clearComposer()
    content.append(role: "你", text: text)
    setState(.streaming, message: "生成中")
    var event: [String: Any] = [
      "type": "chat.submit", "requestId": requestID, "sessionId": sessionID,
      "commandId": commandID, "generation": commandGeneration
    ]
    if shouldUseFileReference(text) {
      guard let path = persistLargeText(text) else {
        failedDraftText = text
        content.setComposerText(text)
        setState(.failed, message: "无法准备大文本附件，请重试")
        return
      }
      event["text"] = "[附件: selected-text.txt]"
      pendingFileReferencePath = path
      event["fileReference"] = ["name": "selected-text.txt", "mimeType": "text/plain", "path": path]
    } else {
      event["text"] = text
    }
    emit(event)
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
    connectionTimeout?.invalidate()
    connectionTimeout = nil
    guard !requestID.isEmpty else { return }
    if emitEvent { emit(["type": "chat.close", "requestId": requestID, "generation": sessionGeneration]) }
    sessionGeneration += 1
    commandGeneration += 1
    requestID = ""
    sessionID = ""
    commandID = ""
    assistantItems.removeAll()
    assistantItemIDs.removeAll()
    pendingServiceText = ""
    pendingServiceRequestID = ""
    if !pendingFileReferencePath.isEmpty {
      try? FileManager.default.removeItem(atPath: pendingFileReferencePath)
      pendingFileReferencePath = ""
    }
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
    let runtimeType = runtime["type"] as? String
    if isCommandEvent(runtimeType) {
      guard let wrapperCommand = wrapper["commandId"] as? String,
            let wrapperGeneration = integer(wrapper["generation"]),
            !commandID.isEmpty, wrapperCommand == commandID,
            wrapperGeneration == commandGeneration else { return }
    }
    if let incomingCommand = commandIdentity(runtime), !commandID.isEmpty,
       incomingCommand != commandID && isCommandEvent(runtimeType) { return }
    if sessionID.isEmpty { sessionID = incomingSession }
    if let runtimeModel = modelValue(runtime) { model = runtimeModel }
    if let source = runtime["source"] as? [String: Any], let runtimeProvider = source["provider"] as? String, !runtimeProvider.isEmpty { provider = runtimeProvider }
    let type = runtime["type"] as? String ?? ""
    switch type {
    case "session.created", "session.runtime.bound", "session.runtime.rebound", "session.snapshot.reset":
      if type == "session.snapshot.reset" { restoreSnapshot(runtime) }
      if state == .connecting {
        setState(.idle, message: "就绪")
        submitPendingServiceTextIfReady()
      }
    case "turn.queued", "turn.started":
      if state != .stopping { setState(.streaming, message: "正在回复") }
    case "turn.metrics.updated":
      let payload = runtime["payload"] as? [String: Any] ?? [:]
      if let turnID = runtime["turnId"] as? String {
        let metrics = payload["metrics"] as? [String: Any] ?? [:]
        turnMetrics[turnID] = (turnMetrics[turnID] ?? [:]).merging(metrics) { _, next in next }
        let metadata = metadataText(model: model, provider: provider, metrics: turnMetrics[turnID])
        content.updateAssistantMetadata(turnID: turnID, metadata: metadata)
        for (id, rowTurn) in assistantTurnByID where rowTurn == turnID { assistantMetadataByID[id] = metadata }
      }
    case "timeline.item.started", "timeline.item.updated", "timeline.item.completed":
      receiveTimelineItem(runtime)
    case "timeline.item.delta":
      let payload = runtime["payload"] as? [String: Any] ?? [:]
      let id = (runtime["itemId"] as? String) ?? (payload["itemId"] as? String) ?? ""
      guard assistantItemIDs.contains(id), let chunk = payload["chunk"] as? String, !chunk.isEmpty else { return }
      assistantItems[id, default: ""] += chunk
      content.upsertAssistant(id: id, text: assistantItems[id] ?? "", metadata: assistantMetadataByID[id] ?? "", turnID: assistantTurnByID[id] ?? "")
      if state != .stopping { setState(.streaming, message: "正在回复") }
    case "turn.interrupted":
      setState(.idle, message: "已停止")
      submitPendingServiceTextIfReady()
    case "turn.completed":
      setState(.idle, message: "就绪")
      submitPendingServiceTextIfReady()
    case "turn.failed", "stream.error", "run.lost":
      let payload = runtime["payload"] as? [String: Any] ?? [:]
      receiveError(["requestId": requestID, "sessionId": sessionID, "commandId": commandID,
                    "generation": commandGeneration,
                    "code": payload["error"] as? String ?? "chat_runtime_failed",
                    "message": payload["message"] as? String ?? "Chat 运行失败"])
    case "session.closed":
      setState(.disconnected, message: "会话已关闭")
    default:
      break
    }
  }

  private func receiveTimelineItem(_ runtime: [String: Any]) {
    guard let payload = runtime["payload"] as? [String: Any],
          let item = payload["item"] as? [String: Any],
          let id = item["id"] as? String, !id.isEmpty,
          item["kind"] as? String == "message" else { return }
    let detail = item["detail"] as? [String: Any] ?? [:]
    guard (detail["role"] as? String ?? item["role"] as? String) == "assistant" else { return }
    assistantItemIDs.insert(id)
    let itemModel = (detail["model"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? model
    let itemTurnID = item["turnId"] as? String ?? runtime["turnId"] as? String ?? ""
    let mergedMetrics = (turnMetrics[itemTurnID] ?? [:]).merging(detail["metrics"] as? [String: Any] ?? [:]) { _, next in next }
    let itemMetadata = metadataText(model: itemModel, provider: provider, metrics: mergedMetrics)
    assistantMetadataByID[id] = itemMetadata
    assistantTurnByID[id] = itemTurnID
    if let text = item["content"] as? String {
      assistantItems[id] = text
      if !text.isEmpty { content.upsertAssistant(id: id, text: text, metadata: itemMetadata, turnID: itemTurnID) }
    }
    if state != .stopping { setState(.streaming, message: "正在回复") }
  }

  private func receiveError(_ event: [String: Any]) {
    guard requestMatches(event) else { return }
    let activeCommand = state == .streaming || state == .stopping
    if activeCommand {
      guard !sessionID.isEmpty, !commandID.isEmpty,
            event["sessionId"] as? String == sessionID,
            event["commandId"] as? String == commandID,
            integer(event["generation"]) == commandGeneration else { return }
    } else {
      if let incomingSession = event["sessionId"] as? String, !sessionID.isEmpty, incomingSession != sessionID { return }
      if let incomingCommand = event["commandId"] as? String, !commandID.isEmpty, incomingCommand != commandID { return }
      if let generation = integer(event["generation"]), generation < sessionGeneration { return }
    }
    let message = (event["message"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "Chat 连接失败"
    failedDraftText = lastSubmittedText
    if !failedDraftText.isEmpty { content.setComposerText(failedDraftText) }
    setState(.failed, message: message.isEmpty ? "Chat 连接失败" : message)
  }

  private func restoreSnapshot(_ runtime: [String: Any]) {
    guard let payload = runtime["payload"] as? [String: Any], let timeline = payload["timeline"] as? [[String: Any]] else { return }
    let messages = timeline.compactMap { item -> (id: String, role: String, text: String, metadata: String, turnID: String)? in
      guard let text = item["content"] as? String, !text.isEmpty,
            item["kind"] as? String == "message" else { return nil }
      let detail = item["detail"] as? [String: Any]
      let role = (detail?["role"] as? String) ?? (item["role"] as? String)
      let displayRole = role == "user" ? "你" : "AIH"
      let itemModel = (detail?["model"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? model
      let metrics = detail?["metrics"] as? [String: Any]
      return (
        id: item["id"] as? String ?? "",
        role: displayRole,
        text: text,
        metadata: displayRole == "AIH" ? metadataText(model: itemModel, provider: provider, metrics: metrics) : "",
        turnID: item["turnId"] as? String ?? ""
      )
    }
    content.restoreMessages(messages)
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
    return type.hasPrefix("turn.") || type.hasPrefix("timeline.") || type == "stream.error"
  }

  private func modelValue(_ runtime: [String: Any]) -> String? {
    if let value = runtime["model"] as? String, !value.isEmpty { return value }
    if let payload = runtime["payload"] as? [String: Any], let value = payload["model"] as? String, !value.isEmpty { return value }
    return nil
  }

  private func shouldUseFileReference(_ text: String) -> Bool {
    text.count >= 12_000 || text.utf8.count >= 48 * 1024
  }

  private func persistLargeText(_ text: String) -> String? {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("aih-chat-\(UUID().uuidString).txt")
    do {
      try Data(text.utf8).write(to: url, options: .atomic)
      return url.path
    } catch {
      return nil
    }
  }

  private func metadataText(model: String, provider: String, metrics: [String: Any]?) -> String {
    var fields: [String] = []
    if !provider.isEmpty { fields.append(provider) }
    if !model.isEmpty { fields.append(model) }
    if let metrics {
      if let duration = number(metrics["durationMs"]) { fields.append(String(format: "用时 %.1fs", duration / 1000)) }
      if let ttft = number(metrics["ttftMs"]) { fields.append(String(format: "首字 %.1fs", ttft / 1000)) }
      if let rate = number(metrics["tokensPerSec"]) { fields.append(String(format: "%.1f tok/s", rate)) }
    }
    return fields.joined(separator: " · ")
  }

  private func number(_ value: Any?) -> Double? {
    if let value = value as? Double, value.isFinite, value >= 0 { return value }
    if let value = value as? NSNumber, value.doubleValue.isFinite, value.doubleValue >= 0 { return value.doubleValue }
    return nil
  }

  private func integer(_ value: Any?) -> Int? {
    if let number = value as? Int { return number }
    if let number = value as? NSNumber { return number.intValue }
    return nil
  }

  private func setState(_ next: ChatPanelState, message: String) {
    if next != .connecting {
      connectionTimeout?.invalidate()
      connectionTimeout = nil
    }
    state = next
    content.setState(next, sessionID: sessionID, model: model, provider: provider, message: message)
  }

  func windowWillClose(_ notification: Notification) {
    closeSession()
  }
}
