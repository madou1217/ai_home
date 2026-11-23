import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

struct SurfaceFailure: Error {
  let code: String
  init(_ code: String) { self.code = code }
}

// Shared terminal latch: capture failure synchronously prevents all queued
// input from beginning. A command already holding the latch may finish its
// paired down/up events before stop returns; no new command can then start.
final class InputGate {
  private let lock=NSRecursiveLock()
  private var stopped=false
  func stop(){lock.lock();stopped=true;lock.unlock()}
  func perform(_ action:() throws -> Void) throws {
    lock.lock();defer{lock.unlock()}
    if stopped {throw SurfaceFailure("browser_capture_stopped")}
    try action()
  }
}

final class BrowserInput {
  let gate=InputGate()
  let pid: pid_t
  private let identity: TaskBrowserIdentity
  private let parent: pid_t
  private let mouse = TaskWindowMouseEvents()
  var frame: CGRect = .zero
  var windowID: CGWindowID = 0
  var lastFrame = Date.distantPast
  var sequence: Int64 = 0
  var history: [Int64:Date] = [:]
  var enabled = false

  init(pid: pid_t) throws {
    let parent = getppid()
    identity = try TaskBrowserIdentity.read(pid, parent: parent)
    self.parent = parent
    self.pid = pid
  }

  func verifyWindow() throws {
    guard CGPreflightPostEventAccess(), (try? TaskBrowserIdentity.read(pid, parent: parent)) == identity else { throw SurfaceFailure("browser_input_permission_or_identity_lost") }
    guard enabled, windowID != 0, Date().timeIntervalSince(lastFrame) < 3 else { throw SurfaceFailure("browser_frame_stale") }
    guard let rows = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String:Any]], let row = rows.first, (row[kCGWindowOwnerPID as String] as? Int) == Int(pid), (row[kCGWindowIsOnscreen as String] as? Bool) == true, let bounds = row[kCGWindowBounds as String] as? [String:Any], let actual = CGRect(dictionaryRepresentation: bounds as CFDictionary), actual.width > 0, actual.height > 0 else { throw SurfaceFailure("browser_window_unavailable") }
    guard abs(actual.width-frame.width)<2, abs(actual.height-frame.height)<2 else { throw SurfaceFailure("browser_window_resized_reconnect") }
    // Input is pinned to the captured windowID, and keyboard commands raise that
    // window before posting events. Extra Edge windows (toolbars, Chat, OAuth
    // popups) must not abort the session: a single auxiliary window used to kill
    // every navigation and freeze the surface.
    frame = actual
  }

  // Synthetic keyboard events only reach the app's key window. A background
  // Edge window is not key, so Cmd+L, typed text and Return were dropped and
  // the omnibox kept the URL without navigating. Bring the captured window
  // forward before keyboard input; pointer and scroll events target the window
  // directly and must not steal focus from the WebUI.
  private func activateWindow() {
    guard let app = NSRunningApplication(processIdentifier: pid), !app.isActive else { return }
    let element = AXUIElementCreateApplication(pid)
    var frontmost: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXFrontmostAttribute as CFString, &frontmost) != .success || (frontmost as? Bool) != true {
      if AXUIElementSetAttributeValue(element, kAXFrontmostAttribute as CFString, kCFBooleanTrue) != .success {
        _ = app.activate(options: [])
      }
    }
    var value: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXWindowsAttribute as CFString, &value) == .success,
      let windows = value as? [AXUIElement] {
      for window in windows where windowMatchesCapture(window) {
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        _ = AXUIElementSetAttributeValue(element, kAXFocusedWindowAttribute as CFString, window)
        _ = AXUIElementSetAttributeValue(element, kAXMainAttribute as CFString, window)
        break
      }
    }
    usleep(150_000)
  }

  private func windowMatchesCapture(_ window: AXUIElement) -> Bool {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &value) == .success, let raw = value, CFGetTypeID(raw) == AXValueGetTypeID() else { return false }
    var size = CGSize.zero
    guard AXValueGetValue(raw as! AXValue, .cgSize, &size) else { return false }
    return abs(size.width - frame.width) < 8 && abs(size.height - frame.height) < 8
  }

  private func key(_ code: CGKeyCode, flags: CGEventFlags = []) {
    for down in [true, false] {
      guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { continue }
      event.flags = flags
      event.postToPid(pid)
    }
  }

  private func text(_ value: String) {
    let chars = Array(value.utf16)
    for down in [true, false] {
      guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { continue }
      chars.withUnsafeBufferPointer { ptr in event.keyboardSetUnicodeString(stringLength: ptr.count, unicodeString: ptr.baseAddress!) }
      event.postToPid(pid)
    }
  }

  func apply(_ command: [String:Any]) throws {
    try gate.perform { try applyWhileLive(command) }
  }

  private func applyWhileLive(_ command:[String:Any]) throws {
    try verifyWindow()
    guard let seen = command["frame"] as? Int64, let generated=history[seen], Date().timeIntervalSince(generated)<2.5 else {throw SurfaceFailure("browser_frame_stale")}
    let type = command["type"] as? String ?? ""
    if type == "navigate" || type == "key" || type == "text" { activateWindow() }
    switch type {
    case "navigate":
      let raw = command["url"] as? String ?? ""
      guard raw.count <= 8192, let url = URL(string: raw), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.user == nil, url.password == nil, url.host != nil, !raw.contains("\n"), !raw.contains("\r") else { throw SurfaceFailure("invalid_browser_url") }
      key(37, flags: .maskCommand)
      text(raw)
      key(36)
    case "text":
      let value = command["text"] as? String ?? ""
      guard !value.isEmpty, value.utf16.count <= 2048 else { throw SurfaceFailure("invalid_browser_text") }
      text(value)
    case "key":
      switch command["key"] as? String ?? "" {
      case "Enter": key(36)
      case "Tab": key(48)
      case "Backspace": key(51)
      case "Delete": key(117)
      case "Escape": key(53)
      case "ArrowLeft": key(123)
      case "ArrowRight": key(124)
      case "ArrowDown": key(125)
      case "ArrowUp": key(126)
      case "Home": key(115)
      case "End": key(119)
      case "PageUp": key(116)
      case "PageDown": key(121)
      case "back": key(33, flags: .maskCommand)
      case "forward": key(30, flags: .maskCommand)
      case "reload": key(15, flags: .maskCommand)
      default: throw SurfaceFailure("unsupported_browser_key")
      }
    case "pointer":
      guard let x = command["x"] as? Double, let y = command["y"] as? Double, x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y) else { throw SurfaceFailure("invalid_browser_pointer") }
      let point = CGPoint(x: min(x * frame.width, frame.width - 1), y: min(y * frame.height, frame.height - 1))
      try mouse.click(pid: pid, window: windowID, point: point, right: (command["button"] as? Int ?? 0) == 2)
    case "scroll":
      let dx = command["deltaX"] as? Double ?? 0
      let dy = command["deltaY"] as? Double ?? 0
      guard dx.isFinite, dy.isFinite, abs(dx) <= 2000, abs(dy) <= 2000 else { throw SurfaceFailure("invalid_browser_scroll") }
      try mouse.scroll(pid: pid, window: windowID, point: CGPoint(x: frame.width / 2, y: frame.height / 2), dx: dx, dy: dy)
    default: throw SurfaceFailure("unsupported_browser_command")
    }
  }
}
