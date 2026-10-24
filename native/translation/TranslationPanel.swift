import AppKit

final class TranslationPanel: NSObject, NSWindowDelegate {
  let emit: ([String: Any]) -> Void
  let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 300), styleMask: [.titled, .closable, .resizable, .nonactivatingPanel], backing: .buffered, defer: false)
  let trigger = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 34, height: 32), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
  let content = TranslationPanelContent()
  var selected = ""
  var offered = ""
  var requestID = ""
  var target = "zh-Hans"
  var defaultTarget = "zh-Hans"
  var autoCopy = false
  var copyScope = "selection"
  var serverPort = 9527
  private var sameLanguageResult = false
  var output = ""
  private var replacementElement: AXUIElement?
  private var replacementOriginal = ""
  private var replacementFinal = ""
  private var replacementAppliedState = false
  private var awaitingConfirmation = false
  private var startedAt = ProcessInfo.processInfo.systemUptime
  private var timer: Timer?
  private var visibilityRevisions: [ObjectIdentifier: Int] = [:]
  private var isPinned: Bool { content.pin.state == .on }

  init(emit: @escaping ([String: Any]) -> Void) {
    self.emit = emit
    super.init()
    panel.title = "AIH 划词翻译"
    panel.delegate = self
    panel.level = .floating
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.minSize = NSSize(width: 360, height: 260)
    panel.maxSize = NSSize(width: 900, height: 900)
    panel.contentView = content.root
    content.pin.target = self
    content.pin.action = #selector(togglePinned)
    content.targetMenu.target = self
    content.targetMenu.action = #selector(changeTarget)
    content.serverMenu.target = self
    content.serverMenu.action = #selector(changeServer)
    content.copy.target = self
    content.copy.action = #selector(copyOutput)
    content.replace.target = self
    content.replace.action = #selector(replaceOutput)
    content.retry.target = self
    content.retry.action = #selector(retryTranslation)
    content.override.target = self
    content.override.action = #selector(overrideTranslation)
    content.keepOriginal.target = self
    content.keepOriginal.action = #selector(keepOriginal)
    content.stop.target = self
    content.stop.action = #selector(cancel)
    let button = NSButton(title: "", target: self, action: #selector(acceptOffer))
    button.frame = NSRect(x: 0, y: 0, width: 36, height: 34)
    button.bezelStyle = .texturedRounded
    button.imagePosition = .imageOnly
    button.imageScaling = .scaleProportionallyDown
    // Use the macOS translation glyph rather than the generic book glyph. The
    // bubble communicates an action on selected text and remains legible at
    // the compact floating-trigger size.
    button.image = NSImage(systemSymbolName: "character.bubble.fill", accessibilityDescription: "翻译")
      ?? NSImage(systemSymbolName: "character.bubble", accessibilityDescription: "翻译")
      ?? NSImage(systemSymbolName: "translate", accessibilityDescription: "翻译")
    button.contentTintColor = .controlAccentColor
    button.toolTip = "翻译选中内容"
    button.setAccessibilityLabel("翻译选中内容")
    trigger.contentView = button
    trigger.level = .floating
    trigger.hidesOnDeactivate = false
    trigger.isReleasedWhenClosed = false
    trigger.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
  }

  func configure(_ event: [String: Any]) {
    defaultTarget = event["target"] as? String ?? "zh-Hans"
    autoCopy = event["autoCopy"] as? Bool ?? false
    copyScope = event["copyScope"] as? String ?? "selection"
    serverPort = event["port"] as? Int ?? serverPort
    let previous = panel.isVisible ? target : defaultTarget
    content.targetMenu.removeAllItems()
    content.serverMenu.removeAllItems()
    for server in event["serverTargets"] as? [[String: Any]] ?? [] {
      content.serverMenu.addItem(withTitle: server["label"] as? String ?? "AIH Server")
      content.serverMenu.lastItem?.representedObject = server
    }
    if let current = event["serverTarget"] as? [String: Any],
       let index = content.serverMenu.itemArray.firstIndex(where: {
         guard let candidate = $0.representedObject as? [String: Any] else { return false }
         let candidateKey = String(candidate["serverId"] as? String ?? candidate["origin"] as? String ?? "")
         let currentKey = String(current["serverId"] as? String ?? current["origin"] as? String ?? "")
         return candidateKey == currentKey
       }) {
      content.serverMenu.selectItem(at: index)
      if let label = current["label"] as? String {
        content.serverReady(label)
      }
    }
    for language in event["languages"] as? [[String: Any]] ?? [] {
      content.targetMenu.addItem(withTitle: language["label"] as? String ?? "")
      content.targetMenu.lastItem?.representedObject = language["code"] as? String
    }
    selectTarget(previous)
  }

  private func selectTarget(_ value: String) {
    target = value
    if let index = content.targetMenu.itemArray.firstIndex(where: { $0.representedObject as? String == value }) { content.targetMenu.selectItem(at: index) }
  }

  func place(_ window: NSWindow, at point: NSPoint) {
    let screen = NSScreen.screens.first(where: { $0.frame.contains(point) }) ?? NSScreen.main
    guard let frame = screen?.visibleFrame else { return }
    let size = window.frame.size
    window.setFrameOrigin(NSPoint(x: max(frame.minX + 8, min(point.x + 8, frame.maxX - size.width - 8)), y: max(frame.minY + 8, min(point.y - size.height - 8, frame.maxY - size.height - 8))))
  }

  func offer(_ selection: SelectedText, explicit: Bool, point: NSPoint? = nil) {
    offered = selection.text
    replacementElement = selection.element
    replacementOriginal = selection.fullValue
    replacementAppliedState = false
    if explicit { acceptOffer() }
    else { place(trigger, at: point ?? NSEvent.mouseLocation); show(trigger) }
  }

  @objc func acceptOffer() {
    if !panel.isVisible { selectTarget(defaultTarget) }
    selected = offered
    requestIntent()
  }

  @objc func requestIntent() {
    guard !selected.isEmpty else { return }
    awaitingConfirmation = true
    requestID = UUID().uuidString
    if !panel.isVisible || !isPinned { place(panel, at: NSEvent.mouseLocation) }
    hideTrigger()
    show(panel)
    content.begin(selected)
    // Detection is a separate busy phase. Confirmation actions stay hidden
    // until the helper returns an actual intent decision.
    content.showPreflight()
    emit(["type": "translate-intent", "id": requestID, "text": selected, "target": target])
  }

  @objc func translate() {
    guard !selected.isEmpty else { return }
    awaitingConfirmation = false
    sameLanguageResult = false
    emit(["type": "cancel"])
    requestID = UUID().uuidString
    output = ""
    content.setReplacementAvailable(false)
    content.begin(selected)
    startedAt = ProcessInfo.processInfo.systemUptime
    content.updateElapsed(0)
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
      guard let self = self else { return }
      self.content.updateElapsed(ProcessInfo.processInfo.systemUptime - self.startedAt)
    }
    if !panel.isVisible || !isPinned { place(panel, at: NSEvent.mouseLocation) }
    hideTrigger()
    show(panel)
    emit(["type": "translate", "id": requestID, "text": selected, "target": target, "targetPolicy": "explicit"])
  }

  // A retry starts with the same preflight as a new selection. This keeps the
  // source/target guard active after a timeout or an upstream failure instead
  // of silently bypassing the language confirmation state.
  @objc func retryTranslation() {
    guard !selected.isEmpty else { return }
    emit(["type": "cancel"])
    requestIntent()
  }

  @objc func overrideTranslation() { translate() }

  @objc func keepOriginal() {
    awaitingConfirmation = false
    emit(["type": "cancel"])
    requestID = ""
    finish()
    content.setPhase(.stopped)
    hide(panel)
  }

  func receive(_ event: [String: Any]) {
    let eventType = event["type"] as? String ?? ""
    // Target configuration errors are out-of-band events: they describe the
    // selected server profile rather than a translation request and therefore
    // do not carry the current request id. Keep request-scoped events guarded
    // so a late stream cannot overwrite a newer request, while still surfacing
    // a failed server switch immediately in the panel.
    if eventType != "server-target-error" && event["id"] as? String != requestID { return }
    switch eventType {
    case "confirmation":
      awaitingConfirmation = true
      let message = (event["state"] as? String) == "same_language"
        ? "原文与目标语言相同。请选择其它目标语言，或点击「仍然翻译」"
        : "目标语言需要确认。请选择目标语言，或点击「仍然翻译」"
      content.showConfirmation(message)
    case "start":
      panel.title = "\(event["fromLabel"] as? String ?? "自动检测") → \(event["toLabel"] as? String ?? target)"
      let from = event["from"] as? String ?? ""
      let to = event["to"] as? String ?? ""
      sameLanguageResult = !from.isEmpty && from == to
      content.model.stringValue = event["model"] as? String ?? "AIH Translation"
      content.model.toolTip = content.model.stringValue
    case "delta":
      output += event["content"] as? String ?? ""
      content.setOutput(output)
      if content.phase != .streaming { content.setPhase(.streaming) }
    case "attempt_start":
      content.model.stringValue = event["model"] as? String ?? "AIH Translation"
      content.model.toolTip = content.model.stringValue
    case "server-target-error":
      content.serverFailure(event["message"] as? String ?? "无法切换翻译服务")
    case "done":
      if let text = event["text"] as? String, !text.isEmpty { output = text; content.setOutput(text) }
      finish()
      content.setPhase(.done)
      content.setReplacementAvailable(replacementElement != nil)
      if autoCopy && !sameLanguageResult && event["type"] as? String == "done" && !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (copyScope == "all" || copyScope == "selection") {
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(output, forType: .string); content.autoCopied()
      }
    case "error":
      finish()
      let code = event["code"] as? String ?? ""
      let upstream = code == "translation_upstream_error" || code == "translation_upstream_unreachable" || code == "translation_upstream_timeout"
      let message = event["message"] as? String ?? "翻译失败，请重试"
      content.failure(upstream ? friendlyUpstreamFailure(message) : message)
    default: break
    }
  }

  private func friendlyUpstreamFailure(_ message: String) -> String {
    let lower = message.lowercased()
    if lower.contains("no_available_account") || lower.contains("没有可用于") {
      return "当前翻译模型暂时没有可用账号。请在高级设置中刷新模型目录，或选择其它模型。"
    }
    if lower.contains("model") && (lower.contains("not found") || lower.contains("unavailable")) {
      return "当前翻译模型不可用。请在高级设置中选择其它模型。"
    }
    if lower.contains("timeout") || lower.contains("超时") {
      return "翻译服务响应超时，请稍后重试或切换模型。"
    }
    return "当前翻译模型暂时不可用，请在高级设置中选择其它模型或稍后重试。"
  }

  @objc func replaceOutput() {
    guard let element = replacementElement, let range = currentSelectedRange(element), !output.isEmpty else { return }
    if replacementAppliedState {
      guard readAXValue(element) == replacementFinal else { content.failure("编辑器内容已改变，无法安全撤回"); return }
      guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, replacementOriginal as CFString) == .success else { content.failure("无法撤回原文"); return }
      replacementAppliedState = false
      content.replacementUndone()
      return
    }
    guard readAXValue(element) == replacementOriginal else { content.failure("原文已经被修改，未执行替换"); return }
    let full = replacementOriginal as NSString
    let nsRange = NSRange(location: range.location, length: range.length)
    guard nsRange.location >= 0, nsRange.length > 0, nsRange.location + nsRange.length <= full.length else { return }
    replacementFinal = full.replacingCharacters(in: nsRange, with: output)
    let steps = stride(from: 1, through: max(1, output.count), by: 2).map { index in
      let end = output.index(output.startIndex, offsetBy: min(index, output.count))
      return full.replacingCharacters(in: nsRange, with: String(output[..<end]))
    }
    for step in steps {
      guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, step as CFString) == .success else { content.failure("无法写入当前编辑器"); return }
      if !content.reducedMotion { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.025)) }
    }
    replacementAppliedState = true
    content.replacementApplied()
  }

  private func readAXValue(_ element: AXUIElement) -> String { var value: CFTypeRef?; return AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success ? (value as? String ?? "") : "" }
  private func currentSelectedRange(_ element: AXUIElement) -> CFRange? { var value: CFTypeRef?; guard AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &value) == .success, let value = value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }; var range = CFRange(); return AXValueGetValue(value as! AXValue, .cfRange, &range) ? range : nil }

  private func finish() {
    timer?.invalidate()
    timer = nil
    content.updateElapsed(ProcessInfo.processInfo.systemUptime - startedAt)
  }
  @objc func copyOutput() {
    guard !output.isEmpty else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(output, forType: .string)
    content.copied()
  }
  @objc func changeTarget() {
    target = content.targetMenu.selectedItem?.representedObject as? String ?? "zh-Hans"
    if panel.isVisible {
      emit(["type": "cancel"])
      requestIntent()
    }
  }
  @objc func changeServer() {
    guard let server = content.serverMenu.selectedItem?.representedObject as? [String: Any] else { return }
    let label = server["label"] as? String ?? "AIH Server"
    // Switching targets is a hard request boundary. Invalidate the current
    // request before asking the helper to reconfigure so late SSE events from
    // the previous server cannot overwrite the new target's panel.
    emit(["type": "cancel"])
    requestID = ""
    finish()
    content.setPhase(.stopped)
    content.serverSwitching(label)
    emit(["type": "server-target", "origin": server["origin"] as? String ?? "", "serverId": server["serverId"] as? String ?? "", "label": server["label"] as? String ?? "AIH Server"])
  }
  @objc func openSettings() {
    if let url = URL(string: "http://127.0.0.1:\(serverPort)/ui/studio/translation?settings=1") {
      NSWorkspace.shared.open(url)
    }
  }
  @objc func togglePinned() {
    panel.level = isPinned ? .statusBar : .floating
    content.pin.setAccessibilityLabel(isPinned ? "取消置顶" : "置顶面板")
    if isPinned, let screen = panel.screen ?? NSScreen.main {
      var frame = panel.frame
      frame.origin.y = screen.visibleFrame.maxY - frame.height - 12
      panel.setFrame(frame, display: true, animate: !content.reducedMotion)
      panel.orderFrontRegardless()
    }
  }
  private func show(_ window: NSWindow) {
    let key = ObjectIdentifier(window)
    visibilityRevisions[key, default: 0] += 1
    if window.isVisible { window.alphaValue = 1; window.orderFrontRegardless(); return }
    window.alphaValue = content.reducedMotion ? 1 : 0
    window.orderFrontRegardless()
    NSAnimationContext.runAnimationGroup { context in
      context.duration = content.reducedMotion ? 0 : 0.2
      window.animator().alphaValue = 1
    }
  }
  private func hide(_ window: NSWindow) {
    let key = ObjectIdentifier(window)
    visibilityRevisions[key, default: 0] += 1
    let revision = visibilityRevisions[key]
    guard window.isVisible else { return }
    if content.reducedMotion { window.orderOut(nil); return }
    NSAnimationContext.runAnimationGroup({ context in
      context.duration = 0.14
      window.animator().alphaValue = 0
    }, completionHandler: { [weak self] in
      guard self?.visibilityRevisions[key] == revision else { return }
      window.orderOut(nil)
      window.alphaValue = 1
    })
  }
  func hideTrigger() { hide(trigger) }
  @objc func cancel() {
    emit(["type": "cancel"])
    requestID = ""
    finish()
    content.setPhase(.stopped)
  }
  func close() {
    cancel()
    hideTrigger()
    hide(panel)
    content.pin.state = .off
    content.pin.setAccessibilityLabel("置顶面板")
    panel.level = .floating
  }
  func outsideClick() { hideTrigger(); if !isPinned { close() } }
  func windowShouldClose(_ sender: NSWindow) -> Bool { close(); return false }
}
