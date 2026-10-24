import AppKit
import ApplicationServices

func emit(_ event: [String: Any]) {
  guard let bytes = try? JSONSerialization.data(withJSONObject: event), let text = String(data: bytes, encoding: .utf8) else { return }
  print(text)
  fflush(stdout)
}

final class TranslationApp: NSObject, NSApplicationDelegate {
  let reader = SelectionReader()
  let panel = TranslationPanel(emit: emit)
  var monitors: [Any] = []
  var lastTrusted: Bool?
  var selectionToken = 0
  var selectionApplicationPID: pid_t = 0
  var activationObserver: NSObjectProtocol?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    updateTrust()
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
      if getppid() == 1 { NSApp.terminate(nil) }
      self?.updateTrust()
    }
    DispatchQueue.global(qos: .utility).async { [weak self] in
      while let line = readLine() {
        guard line.utf8.count < 100000, let bytes = line.data(using: .utf8), let event = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any] else { continue }
        DispatchQueue.main.async { self?.receive(event) }
      }
      DispatchQueue.main.async { NSApp.terminate(nil) }
    }
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
    if let monitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp, .keyDown, .scrollWheel], handler: { [weak self] event in
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
      } else if event.type == .scrollWheel {
        self.selectionToken += 1
        self.panel.hideTrigger()
      }
      else if event.type == .keyDown {
        if event.keyCode == 53 {
          self.selectionToken += 1
          self.panel.close()
        }
        else if event.keyCode == 17, event.modifierFlags.contains(.command), event.modifierFlags.contains(.option) {
          let application = NSWorkspace.shared.frontmostApplication
          if let selection = self.reader.read(explicit: true, application: application) { self.panel.offer(selection, explicit: true) }
          emit(["type": "selection-state", "outcome": self.reader.lastOutcome, "application": self.reader.lastApplication])
        }
      }
    }) { monitors.append(monitor) }
    if let monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown], handler: { [weak self] event in
      if event.type == .keyDown && event.keyCode == 53 {
        self?.selectionToken += 1
        self?.panel.close()
        return nil
      }
      return event
    }) { monitors.append(monitor) }
    emit(["type": "selection-state", "outcome": "monitors-\(monitors.count)"])
  }

  func receive(_ event: [String: Any]) {
    switch event["type"] as? String {
    case "configure":
      panel.configure(event)
      reader.serverPort = event["port"] as? Int ?? 9527
    case "webui-focus":
      reader.webUIFocusUntil = event["until"] as? Double ?? 0
      // 心跳并非原生焦点的权威：后台/自动化页面仍可能上报聚焦。
      // 取词前由真实 AX 窗口 URL/title 判断是否交还 WebUI。
    case "request-permission":
      _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
      if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") { NSWorkspace.shared.open(url) }
    default: panel.receive(event)
    }
  }
}

let app = NSApplication.shared
let delegate = TranslationApp()
app.delegate = delegate
app.run()
