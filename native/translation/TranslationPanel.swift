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
    content.copy.target = self
    content.copy.action = #selector(copyOutput)
    content.replace.target = self
    content.replace.action = #selector(replaceOutput)
    content.retry.target = self
    content.retry.action = #selector(translate)
    content.override.target = self
    content.override.action = #selector(overrideTranslation)
    content.keepOriginal.target = self
    content.keepOriginal.action = #selector(keepOriginal)
    content.stop.target = self
    content.stop.action = #selector(cancel)
    let button = NSButton(title: "译", target: self, action: #selector(acceptOffer))
    button.frame = NSRect(x: 0, y: 0, width: 34, height: 32)
    button.font = .systemFont(ofSize: 14, weight: .semibold)
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
    let previous = panel.isVisible ? target : defaultTarget
    content.targetMenu.removeAllItems()
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
    content.showConfirmation("正在确认原文与目标语言…")
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

  @objc func overrideTranslation() { translate() }

  @objc func keepOriginal() {
    awaitingConfirmation = false
    emit(["type": "cancel"])
    content.setPhase(.stopped)
    hide(panel)
  }

  func receive(_ event: [String: Any]) {
    guard event["id"] as? String == requestID else { return }
    switch event["type"] as? String {
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
      content.failure(event["message"] as? String ?? "翻译失败，请重试")
    default: break
    }
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
      if awaitingConfirmation { requestIntent() }
      else { translate() }
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
