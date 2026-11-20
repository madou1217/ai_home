import AppKit
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
    guard let windows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String:Any]] else { throw SurfaceFailure("browser_window_unavailable") }
    let count=windows.filter { row in
      guard (row[kCGWindowOwnerPID as String] as? Int)==Int(pid), (row[kCGWindowLayer as String] as? Int)==0,
        (row[kCGWindowIsOnscreen as String] as? Bool)==true,
        let box=row[kCGWindowBounds as String] as? [String:Any], let rect=CGRect(dictionaryRepresentation:box as CFDictionary) else {return false}
      return rect.width>=100 && rect.height>=80
    }.count
    guard count==1 else { throw SurfaceFailure("browser_multiple_windows_not_supported") }
    frame = actual
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
