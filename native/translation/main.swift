import AppKit
import ApplicationServices

func emit(_ event: [String: Any]) {
  guard let bytes = try? JSONSerialization.data(withJSONObject: event), let text = String(data: bytes, encoding: .utf8) else { return }
  print(text)
  fflush(stdout)
}

final class TranslationApp: NSObject, NSApplicationDelegate {
  let fullApp = CommandLine.arguments.contains("--full-app")
  let reader = SelectionReader()
  let panel = TranslationPanel(emit: emit)
  let chatPanel = ChatPanel(emit: emit)
  lazy var shortcutRegistry = ShortcutRegistry { [weak self] message in
    guard let self = self else { return }
    emit(["type": "status", "trusted": AXIsProcessTrusted(), "detail": message])
    self.panel.content.showShortcutStatus(message)
  }
  var monitors: [Any] = []
  var lastTrusted: Bool?
  var selectionToken = 0
  var selectionApplicationPID: pid_t = 0
  var activationObserver: NSObjectProtocol?
  var contextSelection: SelectedText?
  let contextMenu = NSMenu()

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(fullApp ? .regular : .accessory)
    if fullApp {
      panel.configure([
        "target": "zh-Hans",
        "autoCopy": false,
        "executionTarget": "direct-provider",
        "languages": [["label": "简体中文", "code": "zh-Hans"]],
        "serverTargets": []
      ])
      panel.openSettings()
    }
    registerShortcuts()
    // Register the same action as a macOS Services provider. This makes
    // “AIH 翻译选中内容” available from Services in TextEdit, browsers and
    // other AX-aware apps, while the global monitor below keeps the compact
    // contextual menu available when the host app exposes no Services UI.
    NSApp.servicesProvider = self
    // Register the provider explicitly as well as assigning the app-level
    // provider.  The helper is a dynamically built, hidden app under AIH's
    // run directory; explicit registration makes the Services daemon bind the
    // provider name to this live process instead of relying only on the bundle
    // metadata discovered by LaunchServices.
    // The legacy registration API uses a provider *name*, not the bundle
    // identifier. Use the same human-readable name that LaunchServices shows
    // for this helper so older Services hosts can resolve it as well.
    NSRegisterServicesProvider(self, "AIH Translation")
    NSUpdateDynamicServices()
    contextMenu.autoenablesItems = false
    if !fullApp { updateTrust() }
    activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
    ) { [weak self] notification in
      guard let self = self else { return }
      let active = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
      if active?.processIdentifier != self.selectionApplicationPID {
        self.selectionToken += 1
        self.panel.hideTrigger()
      }
    }
    Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      if self?.fullApp != true && getppid() == 1 { NSApp.terminate(nil) }
      if self?.fullApp != true { self?.updateTrust() }
    }
    DispatchQueue.global(qos: .utility).async { [weak self] in
      while let line = readLine() {
        guard line.utf8.count < 100000, let bytes = line.data(using: .utf8), let event = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any] else { continue }
        DispatchQueue.main.async { self?.receive(event) }
      }
      // A standalone app is not owned by a pipe. EOF only terminates the
      // helper; the full app keeps its settings shell alive.
      if self?.fullApp != true { DispatchQueue.main.async { NSApp.terminate(nil) } }
    }
  }

  func registerShortcuts(translation: String = ShortcutRegistry.defaultTranslationShortcut,
                         chat: String = ShortcutRegistry.defaultChatShortcut,
                         translationEnabled: Bool = true,
                         chatEnabled: Bool = true) {
    _ = shortcutRegistry.update([
      ShortcutDescriptor(id: "settings", label: "翻译设置", shortcut: "⌘,") { [weak self] in
        self?.panel.openSettings()
      },
      ShortcutDescriptor(id: "translation", label: "翻译", shortcut: translation, enabled: translationEnabled) { [weak self] in
        guard let self = self else { return }
        let application = NSWorkspace.shared.frontmostApplication
        if let selection = self.reader.read(explicit: true, application: application) {
          self.panel.offer(selection, explicit: true)
        }
        emit(["type": "selection-state", "outcome": self.reader.lastOutcome, "application": self.reader.lastApplication])
      },
      ShortcutDescriptor(id: "chat", label: "Chat", shortcut: chat, enabled: chatEnabled) { [weak self] in
        self?.chatPanel.openFromShortcut()
      }
    ])
  }

  func updateTrust() {
    let trusted = AXIsProcessTrusted()
    if trusted != lastTrusted {
      lastTrusted = trusted
      emit(["type": "status", "trusted": trusted])
      monitors.forEach { NSEvent.removeMonitor($0) }
      monitors = []
      if trusted { installMonitors() }
      else { panel.close() }
    }
  }

  func installMonitors() {
    if let monitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .keyDown, .scrollWheel], handler: { [weak self] event in
      guard let self = self else { return }
      if event.type == .leftMouseDown {
        self.selectionToken += 1
        self.panel.outsideClick()
      } else if event.type == .leftMouseUp {
        emit(["type": "selection-state", "outcome": "mouse-up"])
        let token = self.selectionToken
        // 全局监听副本的 eventTargetUnixProcessID 指向本 helper，不能用来定位选词应用。
        let point = event.cgEvent?.location
        let application = self.reader.applicationAt(point)
        self.selectionApplicationPID = application?.processIdentifier ?? 0
        // CGEvent/AX 使用屏幕左上原点；AppKit 面板位置使用主屏左下原点。
        let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
        let panelPoint = point.map { NSPoint(x: $0.x, y: primaryTop - $0.y) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
          guard token == self.selectionToken, AXIsProcessTrusted() else { return }
          if let selection = self.reader.read(explicit: false, application: application, point: point) {
            self.panel.offer(selection, explicit: false, point: panelPoint)
          }
          emit(["type": "selection-state", "outcome": self.reader.lastOutcome, "application": self.reader.lastApplication,
                "hitPID": self.reader.lastHitPID, "focusPID": self.reader.lastFocusedPID,
                "x": self.reader.lastPoint.x, "y": self.reader.lastPoint.y])
        }
      } else if event.type == .rightMouseDown {
        self.selectionToken += 1
        self.panel.hideTrigger()
      } else if event.type == .rightMouseUp {
        // Never replace the host application's right-click menu. Translation
        // is exposed through Services and the explicit shortcut instead.
        self.contextSelection = nil
      } else if event.type == .scrollWheel {
        self.selectionToken += 1
        self.panel.hideTrigger()
      }
      else if event.type == .keyDown {
        if event.keyCode == 53 {
          self.selectionToken += 1
          self.panel.close()
        }
        else if event.keyCode == 6,
                event.modifierFlags.contains(.command) || event.modifierFlags.contains(.control) {
          // Let the host editor handle its own undo first. If the AX write
          // was not recorded by that editor, the panel restores its exact
          // pre-replacement snapshot after the event has propagated.
          let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
          self.panel.undoReplacementAfterHostShortcut(frontmostPID: pid)
        }
      }
    }) { monitors.append(monitor) }
    if let monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown], handler: { [weak self] event in
      if event.type == .keyDown && event.keyCode == 53 {
        self?.selectionToken += 1
        self?.panel.close()
        return nil
      }
      return event
    }) { monitors.append(monitor) }
    emit(["type": "selection-state", "outcome": "monitors-\(monitors.count)"])
  }


  /// macOS Services entry point. The pasteboard is the authoritative text
  /// payload; AX is only used to retain an editable range when the source app
  /// exposes one, so Services can still work in apps with a partial AX tree.
  @objc func translateSelectedText(_ pboard: NSPasteboard, userData: String, error: AutoreleasingUnsafeMutablePointer<NSString?>) {
    guard let raw = pboard.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
      error.pointee = "AIH 未收到可翻译的选中文本" as NSString
      return
    }
    let application = NSWorkspace.shared.frontmostApplication
    let selection = reader.read(explicit: true, application: application)
      ?? SelectedText(text: raw, editable: false, element: nil, fullValue: raw, selectedRange: nil)
    contextSelection = selection
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      self.contextSelection = nil
      self.panel.offer(selection, explicit: true)
    }
  }

  /// macOS Services entry point for Chat. The pasteboard carries only the
  /// selected text; ChatPanel owns the JSONL request/session identity.
  @objc func chatSelectedText(_ pboard: NSPasteboard, userData: String, error: AutoreleasingUnsafeMutablePointer<NSString?>) {
    guard let raw = pboard.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
      error.pointee = "AIH 未收到可发送到 Chat 的选中文本" as NSString
      return
    }
    DispatchQueue.main.async { [weak self] in
      self?.chatPanel.openFromService(text: raw)
    }
  }

  func receive(_ event: [String: Any]) {
    switch event["type"] as? String {
    case "hello":
      let version = event["version"] as? Int ?? 1
      if version == 1 {
        emit(["version": 1, "type": "ready"])
      } else {
        emit(["version": 1, "type": "error", "code": "desktop_protocol_version_unsupported", "message": "桌面协议版本不受支持", "retryable": false])
      }
    case "configure":
      panel.configure(event)
      chatPanel.configure(event)
      registerShortcuts(
        translation: event["shortcut"] as? String ?? ShortcutRegistry.defaultTranslationShortcut,
        chat: event["chatShortcut"] as? String ?? ShortcutRegistry.defaultChatShortcut,
        translationEnabled: event["shortcutEnabled"] as? Bool ?? true,
        chatEnabled: event["chatShortcutEnabled"] as? Bool ?? true
      )
      reader.serverPort = event["port"] as? Int ?? reader.serverPort
    case "webui-focus":
      reader.webUIFocusUntil = event["until"] as? Double ?? 0
      // 心跳并非原生焦点的权威：后台/自动化页面仍可能上报聚焦。
      // 取词前由真实 AX 窗口 URL/title 判断是否交还 WebUI。
    case "request-permission":
      _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
      if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") { NSWorkspace.shared.open(url) }
    case "host-translate":
      guard fullApp,
            let text = event["text"] as? String,
            let id = event["id"] as? String else { return }
      panel.beginHostTranslation(text: text, target: event["target"] as? String ?? "zh-Hans", id: id)
    case "chat.open", "chat.submit", "chat.stop", "chat.close", "chat.event", "chat.error":
      chatPanel.receive(event)
    default: panel.receive(event)
    }
  }
}

let app = NSApplication.shared
let delegate = TranslationApp()
app.delegate = delegate
app.run()
