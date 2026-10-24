import AppKit
import ApplicationServices

func axValue(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
}

func axString(_ value: CFTypeRef?) -> String {
  guard let value = value else { return "" }
  if let string = value as? String { return string }
  if CFGetTypeID(value) == CFStringGetTypeID() { return value as! String }
  if let string = value as? NSString { return String(string) }
  return ""
}

func axElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
  guard let value = axValue(element, attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
  return (value as! AXUIElement)
}

func textFromAXRange(_ value: CFTypeRef?, full: String) -> String {
  guard let value = value, CFGetTypeID(value) == AXValueGetTypeID() else { return "" }
  var range = CFRange()
  guard AXValueGetValue(value as! AXValue, .cfRange, &range), range.length > 0,
        range.length <= 8000, range.location >= 0,
        range.location + range.length <= (full as NSString).length else { return "" }
  return (full as NSString).substring(with: NSRange(location: range.location, length: range.length))
}

struct SelectedText {
  let text: String
  let editable: Bool
}

// AX 不支持的画布/图片没有可读取的文字；绝不模拟 Cmd+C 或篡改用户剪贴板。
final class SelectionReader {
  var serverPort = 9527
  var webUIFocusUntil: Double = 0
  private(set) var lastOutcome = "idle"
  private(set) var lastApplication = ""
  private(set) var lastHitPID: pid_t = 0
  private(set) var lastFocusedPID: pid_t = 0
  private(set) var lastPoint = CGPoint.zero

  func applicationAt(_ point: CGPoint?) -> NSRunningApplication? {
    guard let point = point else { return NSWorkspace.shared.frontmostApplication }
    var element: AXUIElement?
    AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &element)
    var pid: pid_t = 0
    if let element = element { AXUIElementGetPid(element, &pid) }
    return pid > 0 ? NSRunningApplication(processIdentifier: pid) : NSWorkspace.shared.frontmostApplication
  }

  func isOwnPage(_ app: AXUIElement, _ focused: AXUIElement?) -> Bool {
    let window = axElement(app, kAXFocusedWindowAttribute)
    if let window = window, axString(axValue(window, kAXTitleAttribute)).contains("- AI Home") {
      lastOutcome = "webui-title"
      return true
    }
    var candidates = [app]
    if let window = window { candidates.append(window) }
    if let focused = focused { candidates.append(focused) }
    for element in candidates {
      for attribute in [kAXDocumentAttribute, "AXURL"] {
        let value = axValue(element, attribute)
        let raw = (value as? String) ?? (value as? URL)?.absoluteString ?? ""
        if let url = URL(string: raw), url.port == serverPort,
           ["localhost", "127.0.0.1", "::1"].contains(url.host ?? ""),
           url.path == "/ui" || url.path.hasPrefix("/ui/") { lastOutcome = "webui-url"; return true }
      }
    }
    // 焦点租约只作为页面无法暴露 URL 时的短暂保险，但不能压制已经由
    // AXSystemWide 识别出的其它应用；否则远程/滞后的 WebUI heartbeat 会
    // 把 TextEdit、终端等外部客户端误判为 aih 页面。
    return false
  }

  func read(explicit: Bool, application: NSRunningApplication? = nil, point: CGPoint? = nil) -> SelectedText? {
    lastOutcome = "no-focused-application"
    let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
    let quartzPoint = point ?? CGPoint(x: NSEvent.mouseLocation.x, y: primaryTop - NSEvent.mouseLocation.y)
    lastPoint = quartzPoint
    var hit: AXUIElement?
    AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(quartzPoint.x), Float(quartzPoint.y), &hit)
    var hitPID: pid_t = 0
    if let hit = hit { AXUIElementGetPid(hit, &hitPID) }
    lastHitPID = hitPID
    let hitApp = !explicit && hitPID > 0 ? NSRunningApplication(processIdentifier: hitPID) : nil
    let system = AXUIElementCreateSystemWide()
    let systemFocused = axElement(system, kAXFocusedUIElementAttribute)
    var focusedPID: pid_t = 0
    if let systemFocused = systemFocused { AXUIElementGetPid(systemFocused, &focusedPID) }
    lastFocusedPID = focusedPID
    let focusedApp = focusedPID > 0 ? NSRunningApplication(processIdentifier: focusedPID) : nil
    guard let front = application ?? hitApp ?? focusedApp ?? NSWorkspace.shared.frontmostApplication,
          front.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return nil }
    lastApplication = front.bundleIdentifier ?? "unknown"
    let app = AXUIElementCreateApplication(front.processIdentifier)
    AXUIElementSetMessagingTimeout(app, 0.25)
    // Chromium/Electron 按需暴露完整无障碍树。
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    let focused = axElement(app, kAXFocusedUIElementAttribute)
    if let focused = focused, axString(axValue(focused, kAXSubroleAttribute)) == kAXSecureTextFieldSubrole {
      lastOutcome = "secure-field"
      return nil
    }
    lastOutcome = "webui-owned"
    guard !isOwnPage(app, focused) else { return nil }
    lastOutcome = "selection-unavailable"
    var elements: [AXUIElement] = []
    // 以系统焦点节点为首选，鼠标命中节点作为网页阅读选区的补充。
    if let systemFocused = systemFocused, focusedPID == front.processIdentifier { elements.append(systemFocused) }
    if let hit = hit, hitPID == front.processIdentifier { elements.append(hit) }
    if let focused = focused { elements.append(focused) }
    if let window = axElement(app, kAXFocusedWindowAttribute) { elements.append(window) }
    var roles: [String] = []
    var queue: [(AXUIElement, Int)] = elements.map { ($0, 0) }
    var visited = 0
    var seen = Set<AXUIElement>()
    let deadline = Date().addingTimeInterval(0.6)
    while !queue.isEmpty && visited < 512 {
      if Date() > deadline { break }
      let (node, depth) = queue.removeFirst()
      if !seen.insert(node).inserted { continue }
      visited += 1
      let role = axValue(node, kAXRoleAttribute) as? String ?? ""
      if !roles.contains(role) { roles.append(role) }
      // 密码框即使显式快捷键也不读取。
      if axValue(node, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole { continue }
      var valueSettable = DarwinBoolean(false)
      AXUIElementIsAttributeSettable(node, kAXValueAttribute as CFString, &valueSettable)
      // 输入框/编辑器的已选文字同样是可翻译内容；只排除密码框上方，避免把
      //「任意客户端」错误收窄成只读网页。没有选区时自然会继续向父节点探查。
      if !explicit && valueSettable.boolValue && [kAXTextFieldRole, kAXTextAreaRole, "AXSearchField"].contains(role) {
        lastOutcome = "editing"
      }
      var text = axString(axValue(node, kAXSelectedTextAttribute))
      // Chromium/WebKit 的阅读选区常只暴露 TextMarkerRange，没有 SelectedText。
      if text.isEmpty, let marker = axValue(node, "AXSelectedTextMarkerRange") {
        var markerText: CFTypeRef?
        if AXUIElementCopyParameterizedAttributeValue(node, "AXStringForTextMarkerRange" as CFString, marker, &markerText) == .success {
          text = axString(markerText)
        }
      }
      if text.isEmpty {
        let full = axString(axValue(node, kAXValueAttribute))
        if !full.isEmpty {
          text = textFromAXRange(axValue(node, kAXSelectedTextRangeAttribute), full: full)
          if text.isEmpty, let ranges = axValue(node, "AXSelectedTextRanges"),
             CFGetTypeID(ranges) == CFArrayGetTypeID() {
            for range in (ranges as! [Any]) {
              text = textFromAXRange(range as CFTypeRef, full: full)
              if !text.isEmpty { break }
            }
          }
        }
      }
      text = text.trimmingCharacters(in: .whitespacesAndNewlines)
      if !text.isEmpty && text.utf16.count <= 8000 {
        lastOutcome = "offered"
        return SelectedText(text: text, editable: role == kAXTextAreaRole || role == kAXTextFieldRole)
      }
      // Chromium/WebKit 将可选中的 AXStaticText 放在命中节点的子树里；
      // 只沿父链会永远停在 AXWebArea/AXGroup。限制深度和节点数，避免
      // 对大型网页做无界遍历。
      if depth < 8, let value = axValue(node, kAXChildrenAttribute),
         CFGetTypeID(value) == CFArrayGetTypeID() {
        let children = (value as! [Any]).compactMap { child -> AXUIElement? in
          guard CFGetTypeID(child as CFTypeRef) == AXUIElementGetTypeID() else { return nil }
          return (child as! AXUIElement)
        }
        for child in children.reversed() { queue.insert((child, depth + 1), at: 0) }
      }
      if depth < 4, let parent = axElement(node, kAXParentAttribute),
         axString(axValue(parent, kAXRoleAttribute)) != kAXApplicationRole {
        queue.append((parent, depth + 1))
      }
    }
    if lastOutcome == "selection-unavailable" { lastOutcome = "selection-unavailable:\(roles.joined(separator: ","))" }
    return nil
  }
}
