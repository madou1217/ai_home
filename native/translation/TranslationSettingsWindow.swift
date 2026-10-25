import AppKit

/// Small native settings surface shared by the translation helper and the full
/// desktop shell. It owns only transient window state; persistence stays with
/// the process that launched the helper.
final class TranslationSettingsWindow: NSObject, NSWindowDelegate {
  let window: NSWindow
  private let emit: ([String: Any]) -> Void
  private let reducedMotion: Bool
  private let targetMenu = NSPopUpButton()
  private let autoCopy = NSButton(checkboxWithTitle: "翻译完成后自动复制", target: nil, action: nil)
  private let executionMenu = NSPopUpButton()
  private let saveButton = NSButton(title: "保存", target: nil, action: nil)
  private let closeButton = NSButton(title: "取消", target: nil, action: nil)
  private let shortcutValue = NSTextField(labelWithString: "⌘⌥T")
  private var isClosing = false
  private var onClosed: (() -> Void)?
  private var serverTargetsByKey: [String: [String: Any]] = [:]

  init(target: String, autoCopyEnabled: Bool, executionTarget: String, languages: [(String, String)], serverTargets: [[String: Any]], selectedServerTarget: [String: Any]?, reducedMotion: Bool, emit: @escaping ([String: Any]) -> Void, onClosed: (() -> Void)? = nil) {
    self.emit = emit
    self.reducedMotion = reducedMotion
    self.onClosed = onClosed
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 300), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    super.init()
    window.title = "AIH 翻译设置"
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.level = .floating
    window.collectionBehavior = [.fullScreenAuxiliary]
    window.contentView = makeView()

    let items = languages.isEmpty ? [("简体中文", "zh-Hans")] : languages
    for (label, code) in items {
      targetMenu.addItem(withTitle: label)
      targetMenu.lastItem?.representedObject = code
    }
    if let index = targetMenu.itemArray.firstIndex(where: { $0.representedObject as? String == target }) { targetMenu.selectItem(at: index) }
    if targetMenu.selectedItem == nil { targetMenu.selectItem(at: 0) }
    autoCopy.state = autoCopyEnabled ? .on : .off
    var options = serverTargets
    if let selectedServerTarget, !options.contains(where: { targetKey($0) == targetKey(selectedServerTarget) }) { options.insert(selectedServerTarget, at: 0) }
    if options.isEmpty { options = [["kind": "aih-server", "label": "本机 AIH Server", "origin": "http://127.0.0.1:9527"]] }
    for (index, target) in options.enumerated() {
      let key = targetKey(target).isEmpty ? "aih-server-\(index)" : targetKey(target)
      serverTargetsByKey[key] = target
      executionMenu.addItem(withTitle: String(target["label"] as? String ?? "AIH Server").isEmpty ? "AIH Server" : target["label"] as? String ?? "AIH Server")
      executionMenu.lastItem?.representedObject = key
    }
    executionMenu.addItem(withTitle: "Provider 直连")
    executionMenu.lastItem?.representedObject = "direct-provider"
    let selectedKey = executionTarget == "direct-provider" ? "direct-provider" : targetKey(selectedServerTarget ?? options[0])
    if let index = executionMenu.itemArray.firstIndex(where: { $0.representedObject as? String == selectedKey }) { executionMenu.selectItem(at: index) }
    targetMenu.setAccessibilityLabel("默认目标语言")
    autoCopy.setAccessibilityLabel("翻译完成后自动复制")
    executionMenu.setAccessibilityLabel("翻译执行目标")
    saveButton.target = self
    saveButton.action = #selector(save)
    closeButton.target = self
    closeButton.action = #selector(close)
    saveButton.keyEquivalent = "\r"
    closeButton.keyEquivalent = "\u{1b}"
  }

  private func targetKey(_ target: [String: Any]) -> String {
    let serverId = String(target["serverId"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let origin = String(target["origin"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    return serverId.isEmpty ? origin : serverId
  }

  private func makeView() -> NSView {
    let root = NSView()
    let title = NSTextField(labelWithString: "翻译")
    title.font = .boldSystemFont(ofSize: 18)
    let subtitle = NSTextField(wrappingLabelWithString: "设置会保存到当前 AIH 桌面环境。")
    subtitle.textColor = .secondaryLabelColor
    let targetLabel = NSTextField(labelWithString: "目标语言")
    let executionLabel = NSTextField(labelWithString: "执行目标")
    let shortcutLabel = NSTextField(labelWithString: "快捷键")
    shortcutValue.alignment = .right
    shortcutValue.textColor = .secondaryLabelColor
    let shortcutRow = NSStackView(views: [shortcutLabel, NSView(), shortcutValue])
    shortcutRow.orientation = .horizontal
    shortcutRow.spacing = 8
    let fields = NSStackView(views: [targetLabel, targetMenu, autoCopy, executionLabel, executionMenu, shortcutRow])
    fields.orientation = .vertical
    fields.alignment = .leading
    fields.spacing = 10
    let buttons = NSStackView(views: [NSView(), closeButton, saveButton])
    buttons.orientation = .horizontal
    buttons.spacing = 8
    let stack = NSStackView(views: [title, subtitle, fields, NSView(), buttons])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 10
    stack.translatesAutoresizingMaskIntoConstraints = false
    root.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
      stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 20),
      stack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -20),
      targetMenu.widthAnchor.constraint(equalToConstant: 240),
      executionMenu.widthAnchor.constraint(equalToConstant: 240)
    ])
    return root
  }

  func present(on screen: NSScreen? = NSScreen.main) {
    if window.isVisible {
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      return
    }
    if let visibleFrame = screen?.visibleFrame {
      window.setFrameOrigin(NSPoint(x: visibleFrame.midX - window.frame.width / 2, y: visibleFrame.midY - window.frame.height / 2))
    } else {
      window.center()
    }
    window.alphaValue = reducedMotion ? 1 : 0
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    NSAnimationContext.runAnimationGroup { context in
      context.duration = reducedMotion ? 0 : 0.18
      window.animator().alphaValue = 1
    }
  }

  @objc private func save() {
    let executionKey = executionMenu.selectedItem?.representedObject as? String ?? ""
    var patch: [String: Any] = [
      "target": targetMenu.selectedItem?.representedObject as? String ?? "zh-Hans",
      "autoCopy": autoCopy.state == .on,
      "executionTarget": executionKey == "direct-provider" ? "direct-provider" : "aih-server"
    ]
    if executionKey != "direct-provider", let selectedTarget = serverTargetsByKey[executionKey] {
      patch["serverTarget"] = selectedTarget
    }
    emit(["version": 1, "type": "settings", "action": "save", "patch": patch])
    closeWindow(emitClose: false)
  }

  @objc private func close() {
    emit(["version": 1, "type": "settings", "action": "close"])
    closeWindow(emitClose: false)
  }

  private func closeWindow(emitClose: Bool) {
    guard !isClosing else { return }
    isClosing = true
    if emitClose { emit(["version": 1, "type": "settings", "action": "close"]) }
    let finish = { [weak self] in
      guard let self = self else { return }
      self.window.orderOut(nil)
      self.window.alphaValue = 1
      self.isClosing = false
      self.onClosed?()
    }
    if reducedMotion {
      finish()
    } else {
      NSAnimationContext.runAnimationGroup({ context in
        context.duration = 0.14
        self.window.animator().alphaValue = 0
      }, completionHandler: finish)
    }
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    emit(["version": 1, "type": "settings", "action": "close"])
    closeWindow(emitClose: false)
    return false
  }
}
