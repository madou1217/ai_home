import AppKit
import ApplicationServices
import CoreGraphics

// AI Home.app is the single macOS TCC owner. In service mode it supervises
// aih-server (launchd starts it this way); when opened normally it shows a
// one-window onboarding UI that requests Screen Recording and Accessibility
// from a foreground app, so macOS can list and prompt for it directly.

let arguments = Array(CommandLine.arguments.dropFirst())

if let serviceIndex = arguments.firstIndex(of: "--service") {
  runService(Array(arguments[(serviceIndex + 1)...]))
} else {
  runOnboarding()
}

func runService(_ raw: [String]) -> Never {
  var args = raw
  if args.first == "--" { args.removeFirst() }
  guard let target = args.first else {
    FileHandle.standardError.write(Data("ai-home: missing server\n".utf8))
    exit(64)
  }
  let process = Process()
  process.executableURL = URL(fileURLWithPath: target)
  process.arguments = Array(args.dropFirst())
  process.standardInput = FileHandle.standardInput
  process.standardOutput = FileHandle.standardOutput
  process.standardError = FileHandle.standardError
  do {
    try process.run()
  } catch {
    FileHandle.standardError.write(Data("ai-home: \(error)\n".utf8))
    exit(1)
  }
  // 服务模式没有运行 run loop，信号源必须挂在独立的串行队列上；
  // 主队列的 DispatchSource 在 waitUntilExit 期间永远不会触发，监督器
  // 收到的 SIGTERM 就传不到子进程（launchctl kill 只能杀掉包装器）。
  let signals = [SIGTERM, SIGINT, SIGHUP]
  let signalQueue = DispatchQueue(label: "com.meadeo.aihome.service.signals")
  var sources: [DispatchSourceSignal] = []
  for item in signals {
    let source = DispatchSource.makeSignalSource(signal: item, queue: signalQueue)
    source.setEventHandler {
      if process.isRunning { process.terminate() }
    }
    source.resume()
    signal(item, SIG_IGN)
    sources.append(source)
  }
  process.waitUntilExit()
  for source in sources { source.cancel() }
  exit(process.terminationStatus)
}

func runOnboarding() -> Never {
  let app = NSApplication.shared
  app.setActivationPolicy(.regular)
  let delegate = OnboardingDelegate()
  app.delegate = delegate
  app.run()
  exit(0)
}

final class OnboardingDelegate: NSObject, NSApplicationDelegate {
  private var window: NSWindow!
  private var screenLabel: NSTextField!
  private var inputLabel: NSTextField!
  private var hint: NSTextField!
  private var timer: Timer?

  func applicationDidFinishLaunching(_ notification: Notification) {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 540, height: 380),
      styleMask: [.titled, .closable, .miniaturizable],
      backing: .buffered,
      defer: false
    )
    window.title = "AI Home 授权"
    window.center()
    window.isReleasedWhenClosed = false
    window.contentView = buildContent()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    refresh()
    timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
      self?.refresh()
    }
  }

  private func buildContent() -> NSView {
    let view = NSView(frame: NSRect(x: 0, y: 0, width: 540, height: 380))
    let title = NSTextField(labelWithString: "账号浏览器需要两项系统授权")
    title.font = .systemFont(ofSize: 20, weight: .semibold)
    title.frame = NSRect(x: 28, y: 320, width: 484, height: 28)
    view.addSubview(title)

    let body = NSTextField(wrappingLabelWithString: "屏幕录制用于读取浏览器画面，辅助功能用于发送点击与键盘。两项都授权后，点“完成”即可；之后升级 AI Home 不再需要重复授权。")
    body.textColor = .secondaryLabelColor
    body.frame = NSRect(x: 28, y: 250, width: 484, height: 58)
    view.addSubview(body)

    screenLabel = NSTextField(labelWithString: "")
    screenLabel.frame = NSRect(x: 28, y: 200, width: 300, height: 22)
    view.addSubview(screenLabel)
    let screenButton = button("请求屏幕录制", action: #selector(requestScreen), x: 330, y: 194)
    view.addSubview(screenButton)
    let screenSettings = button("打开设置", action: #selector(openScreenSettings), x: 438, y: 194)
    view.addSubview(screenSettings)

    inputLabel = NSTextField(labelWithString: "")
    inputLabel.frame = NSRect(x: 28, y: 158, width: 300, height: 22)
    view.addSubview(inputLabel)
    let inputButton = button("请求辅助功能", action: #selector(requestInput), x: 330, y: 152)
    view.addSubview(inputButton)
    let inputSettings = button("打开设置", action: #selector(openInputSettings), x: 438, y: 152)
    view.addSubview(inputSettings)

    hint = NSTextField(wrappingLabelWithString: "授权后如果状态没有立刻变化，点“重新检查”，或重启 AI Home。")
    hint.textColor = .secondaryLabelColor
    hint.frame = NSRect(x: 28, y: 96, width: 484, height: 36)
    view.addSubview(hint)

    let recheck = button("重新检查", action: #selector(recheck), x: 28, y: 40)
    recheck.frame = NSRect(x: 28, y: 40, width: 110, height: 32)
    view.addSubview(recheck)
    let done = button("完成", action: #selector(closeWindow), x: 420, y: 40)
    done.keyEquivalent = "\r"
    done.frame = NSRect(x: 420, y: 40, width: 92, height: 32)
    view.addSubview(done)
    return view
  }

  private func button(_ title: String, action: Selector, x: CGFloat, y: CGFloat) -> NSButton {
    let item = NSButton(title: title, target: self, action: action)
    item.bezelStyle = .rounded
    item.frame = NSRect(x: x, y: y, width: 100, height: 28)
    return item
  }

  private func refresh() {
    let screen = CGPreflightScreenCaptureAccess()
    let input = AXIsProcessTrusted()
    screenLabel.stringValue = (screen ? "✓ " : "○ ") + "屏幕录制"
    screenLabel.textColor = screen ? .systemGreen : .labelColor
    inputLabel.stringValue = (input ? "✓ " : "○ ") + "辅助功能"
    inputLabel.textColor = input ? .systemGreen : .labelColor
    hint.stringValue = screen && input
      ? "两项授权已就绪，可以关闭此窗口。"
      : "授权后如果状态没有立刻变化，点“重新检查”，或重启 AI Home。"
  }

  @objc private func requestScreen() {
    _ = CGRequestScreenCaptureAccess()
    refresh()
  }

  @objc private func requestInput() {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
    refresh()
  }

  @objc private func openScreenSettings() {
    openPane("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
  }

  @objc private func openInputSettings() {
    openPane("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
  }

  private func openPane(_ value: String) {
    if let url = URL(string: value) { NSWorkspace.shared.open(url) }
  }

  @objc private func recheck() { refresh() }

  @objc private func closeWindow() {
    timer?.invalidate()
    NSApp.terminate(nil)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
