import AppKit

final class TranslationPanel: NSObject, NSWindowDelegate, NSComboBoxDelegate {
  let emit: ([String: Any]) -> Void
  let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 480, height: 440), styleMask: [.titled, .closable, .resizable, .nonactivatingPanel], backing: .buffered, defer: false)
  let trigger = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 38, height: 38), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
  let content = TranslationPanelContent()
  var selected = ""
  var offered = ""
  var requestID = ""
  var target = "zh-Hans"
  var defaultTarget = "zh-Hans"
  private var modelCandidates: [[String: Any]] = []
  private var selectedModel = ""
  private var selectedProvider = ""
  private var modelWasEdited = false
  private var modelScope = ""
  private var pendingModelConfiguration: [String: Any]?
  var autoCopy = false
  var copyScope = "selection"
  var serverPort = 9527
  private var sameLanguageResult = false
  var output = ""
  private var offeredSelection: SelectedText?
  private var replacementRange: CFRange?
  private var replacementElement: AXUIElement?
  private var replacementApplicationPID: pid_t = 0
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
    panel.level = .normal
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.minSize = NSSize(width: 420, height: 360)
    panel.maxSize = NSSize(width: 760, height: 900)
    panel.contentView = content.root
    content.modelPicker.delegate = self
    content.modelPicker.target = self
    content.modelPicker.action = #selector(commitModel)
    content.settingsButton.target = self
    content.settingsButton.action = #selector(openSettings)
    content.pin.target = self
    content.pin.action = #selector(togglePinned)
    content.settingsHandler = { [weak self] event in self?.emit(event) }
    content.targetMenu.target = self
    content.targetMenu.action = #selector(changeTarget)
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
    let button = TranslationTriggerButton(title: "", target: self, action: #selector(acceptOffer))
    button.frame = NSRect(x: 0, y: 0, width: 38, height: 38)
    button.isBordered = false
    button.imagePosition = .imageOnly
    button.image = NSImage(systemSymbolName: "character.bubble.fill", accessibilityDescription: "翻译选中内容")
    button.contentTintColor = .controlAccentColor
    button.toolTip = "翻译选中内容"
    button.setAccessibilityLabel("翻译选中内容")
    let surface = NSVisualEffectView(frame: button.frame)
    surface.material = .popover
    surface.state = .active
    surface.wantsLayer = true
    surface.layer?.cornerRadius = 19
    surface.layer?.masksToBounds = true
    surface.addSubview(button)
    trigger.isOpaque = false
    trigger.backgroundColor = .clear
    trigger.hasShadow = true
    trigger.contentView = surface
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
    content.settingsTarget = defaultTarget
    content.settingsAutoCopy = autoCopy
    content.settingsExecutionTarget = event["executionTarget"] as? String ?? "aih-server"
    content.settingsShortcut = event["shortcut"] as? String ?? ShortcutRegistry.defaultTranslationShortcut
    content.settingsChatShortcut = event["chatShortcut"] as? String ?? ShortcutRegistry.defaultChatShortcut
    content.settingsShortcutEnabled = event["shortcutEnabled"] as? Bool ?? true
    content.settingsChatShortcutEnabled = event["chatShortcutEnabled"] as? Bool ?? true
    content.settingsServerTargets = event["serverTargets"] as? [[String: Any]] ?? []
    content.settingsServerTarget = event["serverTarget"] as? [String: Any]
    let previous = panel.isVisible ? target : defaultTarget
    content.targetMenu.removeAllItems()
    content.settingsLanguages = []
    for language in event["languages"] as? [[String: Any]] ?? [] {
      let label = language["label"] as? String ?? ""
      let code = language["code"] as? String ?? ""
      content.settingsLanguages.append((label, code))
      content.targetMenu.addItem(withTitle: label)
      content.targetMenu.lastItem?.representedObject = code
    }
    selectTarget(previous)
    configureModels(event)
  }

  private func scopeForModels(_ event: [String: Any]) -> String {
    let server = event["serverTarget"] as? [String: Any] ?? [:]
    return "\(event["executionTarget"] as? String ?? "aih-server"):\(server["origin"] as? String ?? ""):\(server["serverId"] as? String ?? "")"
  }

  private func modelTitle(_ candidate: [String: Any]) -> String {
    let id = candidate["id"] as? String ?? ""
    let provider = candidate["provider"] as? String ?? ""
    return provider.isEmpty ? id : "\(id) · \(provider)"
  }

  private func configureModels(_ event: [String: Any]) {
    // Catalog completion must not replace text while the user is editing it.
    if content.modelPicker.currentEditor() != nil {
      pendingModelConfiguration = event
      return
    }
    let scope = scopeForModels(event)
    if scope != modelScope { modelWasEdited = false; modelScope = scope }
    modelCandidates = event["models"] as? [[String: Any]] ?? []
    content.modelPicker.removeAllItems()
    content.modelPicker.addItems(withObjectValues: modelCandidates.map(modelTitle))
    if !modelWasEdited {
      let defaults = [event["defaultModel"] as? String, event["model"] as? String]
      selectedModel = defaults.compactMap { $0 }.first(where: { !$0.isEmpty }) ?? ""
      let providers = [event["defaultProvider"] as? String, event["provider"] as? String]
      selectedProvider = providers.compactMap { $0 }.first(where: { !$0.isEmpty }) ?? ""
    }
    content.modelPicker.stringValue = selectedModel
    content.modelPicker.toolTip = selectedModel.isEmpty ? "使用已配置的默认模型；也可选择或填写模型 ID" : selectedModel
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
    offeredSelection = selection
    if explicit { acceptOffer() }
    else { place(trigger, at: point ?? NSEvent.mouseLocation); show(trigger) }
  }

  @objc func acceptOffer() {
    if !panel.isVisible { selectTarget(defaultTarget) }
    selected = offered
    replacementElement = offeredSelection?.element
    replacementRange = offeredSelection?.selectedRange
    replacementApplicationPID = 0
    if let element = replacementElement { AXUIElementGetPid(element, &replacementApplicationPID) }
    replacementOriginal = offeredSelection?.fullValue ?? ""
    replacementAppliedState = false
    requestIntent()
  }

  @objc func requestIntent() {
    guard !selected.isEmpty else { return }
    emit(["type": "cancel"])
    awaitingConfirmation = true
    requestID = UUID().uuidString
    if !panel.isVisible { place(panel, at: NSEvent.mouseLocation) }
    hideTrigger()
    show(panel)
    output = ""
    content.begin(selected)
    startElapsedTimer(reset: true)
    // Detection is a separate busy phase. Confirmation actions stay hidden
    // until the helper returns an actual intent decision.
    content.showPreflight()
    emit(["type": "translate-intent", "id": requestID, "text": selected, "target": target, "model": modelWasEdited ? selectedModel : "", "provider": modelWasEdited ? selectedProvider : ""])
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
    // Human confirmation time is never included in model execution latency.
    startElapsedTimer(reset: true)
    if !panel.isVisible { place(panel, at: NSEvent.mouseLocation) }
    hideTrigger()
    show(panel)
    emit(["type": "translate", "id": requestID, "text": selected, "target": target, "targetPolicy": "explicit", "model": modelWasEdited ? selectedModel : "", "provider": modelWasEdited ? selectedProvider : ""])
  }

  /// Standalone full-app host entry point. The Node host sends this event
  /// before streaming the result so the panel has a request identity to guard
  /// against stale response frames.
  func beginHostTranslation(text: String, target: String, id: String) {
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !id.isEmpty else { return }
    selected = text
    offered = text
    offeredSelection = nil
    replacementElement = nil
    replacementRange = nil
    replacementAppliedState = false
    self.target = target.isEmpty ? defaultTarget : target
    requestID = id
    output = ""
    awaitingConfirmation = false
    content.begin(text)
    startElapsedTimer(reset: true)
    if !panel.isVisible { place(panel, at: NSEvent.mouseLocation) }
    hideTrigger()
    show(panel)
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
    if eventType != "server-target-error" && eventType != "cancel" && event["id"] as? String != requestID { return }
    switch eventType {
    case "confirmation":
      timer?.invalidate()
      timer = nil
      awaitingConfirmation = true
      let sameLanguage = (event["state"] as? String) == "same_language"
      let message = sameLanguage
        ? "原文与目标语言相同。请选择其它目标语言，或点击「仍然翻译」"
        : "目标语言需要确认。请选择目标语言后再开始翻译"
      content.showConfirmation(message, allowsOverride: sameLanguage)
    case "start":
      awaitingConfirmation = false
      let needsExecutionClock = content.phase == .preflight || content.phase == .confirmation
      content.setPhase(.waiting)
      if needsExecutionClock || timer == nil { startElapsedTimer(reset: true) }
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
      awaitingConfirmation = false
      content.setPhase(.waiting)
      content.model.stringValue = event["model"] as? String ?? "AIH Translation"
      content.model.toolTip = content.model.stringValue
    case "server-target-error":
      content.serverFailure(event["message"] as? String ?? "无法切换翻译服务")
    case "cancel":
      // A remote WebUI target switch cancels work owned by this helper. Treat
      // it like a local stop so the old request cannot remain visually busy
      // or accept a late response after the server configuration changes.
      awaitingConfirmation = false
      requestID = ""
      finish()
      content.setPhase(.stopped)
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
    guard let element = replacementElement, let range = replacementRange, !output.isEmpty else { return }
    if replacementAppliedState {
      undoAppliedReplacement(element)
      return
    }
    guard let currentRange = currentSelectedRange(element), currentRange.location == range.location, currentRange.length == range.length else {
      content.failure("原文选区已改变，未执行替换")
      return
    }
    guard readAXValue(element) == replacementOriginal else { content.failure("原文已经被修改，未执行替换"); return }
    let full = replacementOriginal as NSString
    let nsRange = NSRange(location: range.location, length: range.length)
    guard nsRange.location >= 0, nsRange.length > 0, nsRange.location + nsRange.length <= full.length else { return }
    replacementFinal = full.replacingCharacters(in: nsRange, with: output)
    // Write one complete snapshot. Animating partial AX values can lose the
    // final character and permits user edits to race a nested run loop.
    guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, replacementFinal as CFString) == .success else {
      content.failure("无法写入当前编辑器")
      return
    }
    replacementAppliedState = true
    content.replacementApplied()
  }

  /// Observe the host's native undo shortcut without stealing it from the
  /// editor. If the editor already handled Cmd/Ctrl-Z, its value no longer
  /// matches replacementFinal and this becomes a no-op. Otherwise we restore
  /// the exact pre-replacement snapshot after the host has had a chance to
  /// process its own undo stack.
  func undoReplacementAfterHostShortcut(frontmostPID: pid_t) {
    guard replacementAppliedState, replacementApplicationPID == frontmostPID else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
      guard let self = self, self.replacementAppliedState, let element = self.replacementElement else { return }
      guard self.readAXValue(element) == self.replacementFinal else { return }
      self.undoAppliedReplacement(element)
    }
  }

  private func undoAppliedReplacement(_ element: AXUIElement) {
    guard readAXValue(element) == replacementFinal else { content.failure("编辑器内容已改变，无法安全撤回"); return }
    guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, replacementOriginal as CFString) == .success else { content.failure("无法撤回原文"); return }
    replacementAppliedState = false
    content.replacementUndone()
  }

  private func readAXValue(_ element: AXUIElement) -> String { var value: CFTypeRef?; return AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success ? (value as? String ?? "") : "" }
  private func currentSelectedRange(_ element: AXUIElement) -> CFRange? { var value: CFTypeRef?; guard AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &value) == .success, let value = value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }; var range = CFRange(); return AXValueGetValue(value as! AXValue, .cfRange, &range) ? range : nil }

  private func finish() {
    timer?.invalidate()
    timer = nil
    content.updateElapsed(ProcessInfo.processInfo.systemUptime - startedAt)
  }

  private func startElapsedTimer(reset: Bool) {
    if reset {
      startedAt = ProcessInfo.processInfo.systemUptime
      content.updateElapsed(0)
    }
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
      guard let self = self else { return }
      self.content.updateElapsed(ProcessInfo.processInfo.systemUptime - self.startedAt)
    }
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
  @objc func openSettings() {
    content.showSettings()
  }
  @objc func togglePinned() {
    // Pin changes stacking and dismissal only. Never move or resize the window.
    panel.level = isPinned ? .floating : .normal
    content.updatePin(isPinned)
    if isPinned { panel.orderFrontRegardless() }
  }

  func comboBoxSelectionDidChange(_ notification: Notification) {
    let index = content.modelPicker.indexOfSelectedItem
    guard modelCandidates.indices.contains(index) else { return }
    let candidate = modelCandidates[index]
    selectedModel = candidate["id"] as? String ?? ""
    selectedProvider = candidate["provider"] as? String ?? ""
    modelWasEdited = true
    // AppKit commits the selected string after sending its delegate callback.
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      self.content.modelPicker.stringValue = self.selectedModel
      self.restartForModel()
    }
  }

  @objc func commitModel() {
    let value = content.modelPicker.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let candidate = modelCandidates.first(where: { modelTitle($0) == value })
    let model = candidate?["id"] as? String ?? value
    let provider = candidate?["provider"] as? String ?? ""
    guard model != selectedModel || (candidate != nil && provider != selectedProvider) else { return }
    selectedModel = model
    selectedProvider = provider
    modelWasEdited = true
    restartForModel()
  }

  func controlTextDidEndEditing(_ notification: Notification) {
    let pending = pendingModelConfiguration
    pendingModelConfiguration = nil
    // A server switch invalidates a draft belonging to the previous server.
    if pending == nil || scopeForModels(pending!) == modelScope { commitModel() }
    if let pending = pending {
      DispatchQueue.main.async { [weak self] in self?.configureModels(pending) }
    }
  }

  private func restartForModel() {
    content.modelPicker.toolTip = selectedModel
    if panel.isVisible && !selected.isEmpty { retryTranslation() }
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
    content.updatePin(false)
    panel.level = .normal
  }
  func outsideClick() { hideTrigger(); if !isPinned { close() } }
  func windowShouldClose(_ sender: NSWindow) -> Bool { close(); return false }
}
