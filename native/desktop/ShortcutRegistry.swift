import AppKit

/// A native action descriptor. The registry owns only key matching and conflict
/// validation; callers provide the action so provider/runtime behavior remains
/// outside the shortcut layer.
struct ShortcutDescriptor {
  let id: String
  let label: String
  let shortcut: String
  let enabled: Bool
  let action: () -> Void

  init(id: String, label: String, shortcut: String, enabled: Bool = true, action: @escaping () -> Void) {
    self.id = id
    self.label = label
    self.shortcut = shortcut
    self.enabled = enabled
    self.action = action
  }
}

struct ShortcutConflict {
  let shortcut: String
  let actionIDs: [String]
  let message: String
}

/// Global shortcuts are intentionally represented as descriptors instead of
/// provider-specific branches. A failed monitor registration is observable,
/// but never tears down the translation helper.
final class ShortcutRegistry {
  // The chatShortcut setting is intentionally independent from translation.
  static let defaultTranslationShortcut = "⌘⌥T"
  static let defaultChatShortcut = "⌘⌥C"

  private struct Binding: Hashable {
    let keyCode: UInt16
    let modifiers: NSEvent.ModifierFlags

    static func == (lhs: Binding, rhs: Binding) -> Bool {
      lhs.keyCode == rhs.keyCode && lhs.modifiers.rawValue == rhs.modifiers.rawValue
    }

    func hash(into hasher: inout Hasher) {
      hasher.combine(keyCode)
      hasher.combine(modifiers.rawValue)
    }
  }

  private var descriptors: [ShortcutDescriptor] = []
  private var monitors: [Any] = []
  private(set) var conflicts: [ShortcutConflict] = []
  private(set) var registrationError: String?
  private let status: (String) -> Void

  init(status: @escaping (String) -> Void = { _ in }) {
    self.status = status
  }

  @discardableResult
  func register(_ next: [ShortcutDescriptor]) -> Bool {
    unregister()
    descriptors = next
    conflicts = conflictsFor(next)
    if !conflicts.isEmpty {
      let message = conflicts.map(\.message).joined(separator: "；")
      registrationError = message
      status(message)
    } else {
      registrationError = nil
    }

    let active = next.filter { $0.enabled && binding(for: $0.shortcut) != nil && !isConflicted($0) }
    guard !active.isEmpty else {
      if next.contains(where: { $0.enabled }) && registrationError == nil {
        registrationError = "没有可用的桌面快捷键"
        status(registrationError!)
      }
      return registrationError == nil
    }

    let handler: (NSEvent) -> Void = { [weak self] event in
      guard let self = self else { return }
      guard let descriptor = self.descriptors.first(where: { descriptor in
        descriptor.enabled && !self.isConflicted(descriptor) && self.matches(event, descriptor: descriptor)
      }) else { return }
      descriptor.action()
    }
    if let monitor = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown], handler: handler) {
      monitors.append(monitor)
    } else {
      registrationError = "无法注册全局快捷键；辅助功能助手仍在运行"
      status(registrationError!)
    }
    // Global monitors do not receive events from this helper itself. The local
    // monitor covers the full-app settings shell without changing host events.
    if let monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown], handler: { event in
      handler(event)
      return event
    }) {
      monitors.append(monitor)
    } else if registrationError == nil {
      registrationError = "无法注册本地快捷键；辅助功能助手仍在运行"
      status(registrationError!)
    }
    return registrationError == nil
  }

  func unregister() {
    monitors.forEach { NSEvent.removeMonitor($0) }
    monitors.removeAll()
  }

  func update(_ next: [ShortcutDescriptor]) -> Bool { register(next) }

  private func isConflicted(_ descriptor: ShortcutDescriptor) -> Bool {
    conflicts.contains { $0.actionIDs.contains(descriptor.id) }
  }

  private func conflictsFor(_ values: [ShortcutDescriptor]) -> [ShortcutConflict] {
    var grouped: [Binding: [ShortcutDescriptor]] = [:]
    for descriptor in values where descriptor.enabled {
      guard let binding = binding(for: descriptor.shortcut) else { continue }
      grouped[binding, default: []].append(descriptor)
    }
    return grouped.values.filter { $0.count > 1 }.map { descriptors in
      let ids = descriptors.map { $0.id }
      let shortcut = descriptors.map { $0.shortcut }.joined(separator: " / ")
      return ShortcutConflict(shortcut: shortcut, actionIDs: ids, message: "快捷键冲突：\(descriptors.map { $0.label }.joined(separator: "、"))")
    }
  }

  private func matches(_ event: NSEvent, descriptor: ShortcutDescriptor) -> Bool {
    guard let expected = binding(for: descriptor.shortcut), event.keyCode == expected.keyCode else { return false }
    let relevant: NSEvent.ModifierFlags = [.command, .option, .control, .shift]
    return event.modifierFlags.intersection(relevant) == expected.modifiers
  }

  private func binding(for value: String) -> Binding? {
    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else { return nil }
    var modifiers: NSEvent.ModifierFlags = []
    var key = ""
    for scalar in normalized.unicodeScalars {
      switch scalar {
      case "⌘": modifiers.insert(.command)
      case "⌥": modifiers.insert(.option)
      case "⌃": modifiers.insert(.control)
      case "⇧": modifiers.insert(.shift)
      default: key.append(String(scalar))
      }
    }
    let tokens = key.lowercased().split(separator: "+").map(String.init)
    let keyToken = tokens.last?.trimmingCharacters(in: .whitespacesAndNewlines) ?? key.lowercased()
    let tokenModifiers = tokens.dropLast().reduce(modifiers) { result, token in
      var next = result
      switch token {
      case "cmd", "command": next.insert(.command)
      case "alt", "option", "opt": next.insert(.option)
      case "ctrl", "control": next.insert(.control)
      case "shift": next.insert(.shift)
      default: break
      }
      return next
    }
    guard let keyCode = keyCode(for: keyToken) else { return nil }
    return Binding(keyCode: keyCode, modifiers: tokenModifiers)
  }

  private func keyCode(for value: String) -> UInt16? {
    let codes: [String: UInt16] = [
      "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8,
      "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
      "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
      "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33,
      "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46
    ]
    return codes[value]
  }
}
