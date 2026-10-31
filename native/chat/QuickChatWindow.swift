import AppKit
import WebKit

/// Quick Chat 是 WebUI chat/work 的快捷唤起壳：窗口里只有一个 WKWebView，加载
/// `/ui/chat/quick`。会话、模型、审批、附件、手机/平板/电脑的断点布局全部由 WebUI
/// 那一份实现负责，原生侧只做三件事：窗口（置顶、跨桌面、记住大小）、把管理密钥以
/// 同源 Server Profile 的形式注入 localStorage（不进 URL）、把划词内容作为引用投递给页面。
final class QuickChatWindow: NSObject, NSWindowDelegate, WKNavigationDelegate {
  let panel = NSPanel(
    contentRect: NSRect(x: 0, y: 0, width: 720, height: 680),
    // 不用 fullSizeContentView：内容从标题栏下方开始，红绿灯不会压住页面顶栏。
    styleMask: [.titled, .closable, .resizable, .nonactivatingPanel],
    backing: .buffered,
    defer: false
  )
  private var webView: WKWebView?
  private var origin = ""
  private var managementKey = ""
  private var mode = "chat"
  private var loadedURL = ""
  private var pageReady = false
  private var pendingReferences: [[String: String]] = []

  override init() {
    super.init()
    panel.title = "AIH Chat"
    panel.titleVisibility = .visible
    panel.titlebarAppearsTransparent = false
    panel.isMovableByWindowBackground = false
    panel.delegate = self
    panel.level = .floating
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    // 最小宽度对应 WebUI 的手机断点，拉宽后自动切到平板/电脑布局。
    panel.minSize = NSSize(width: 360, height: 420)
    panel.setFrameAutosaveName("AIHQuickChat")
  }

  /// `origin` 是当前选中的 AIH Server（与翻译同一个目标），`managementKey` 由 Node 宿主下发。
  func configure(origin nextOrigin: String, managementKey nextKey: String) {
    let normalized = nextOrigin.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let changed = normalized != origin || nextKey != managementKey
    origin = normalized
    managementKey = nextKey
    if changed, webView != nil {
      webView = nil
      loadedURL = ""
      pageReady = false
      if panel.isVisible { load() }
    }
  }

  func show(mode nextMode: String? = nil) {
    if let nextMode, nextMode == "chat" || nextMode == "work" { mode = nextMode }
    if !panel.isVisible && panel.frameAutosaveName.isEmpty == false && !panel.setFrameUsingName("AIHQuickChat") {
      panel.center()
    }
    load()
    panel.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  func toggle() {
    if panel.isVisible && panel.isKeyWindow { panel.orderOut(nil) } else { show() }
  }

  func hide() { panel.orderOut(nil) }

  /// 划词「引用到 Chat」：页面就绪前排队，就绪后按顺序投递。
  func reference(text: String, source: String) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { show(); return }
    pendingReferences.append(["text": trimmed, "source": source])
    show()
    flushReferences()
  }

  private func quickURL() -> URL? {
    guard !origin.isEmpty, var components = URLComponents(string: "\(origin)/ui/chat/quick") else { return nil }
    let dark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    components.queryItems = [
      URLQueryItem(name: "mode", value: mode),
      URLQueryItem(name: "embed", value: "desktop"),
      URLQueryItem(name: "theme", value: dark ? "dark" : "light")
    ]
    return components.url
  }

  private func makeWebView() -> WKWebView {
    let configuration = WKWebViewConfiguration()
    let controller = WKUserContentController()
    // 在页面任何脚本之前写入同源 Server Profile：WebUI 的鉴权只从 localStorage 里
    // 与页面同源的 profile 取管理密钥，密钥因此不出现在 URL、Referer 或日志里。
    if !managementKey.isEmpty, let profileJSON = profileScriptPayload() {
      let source = """
      (function(){try{
        var KEY='aih:control-plane-profiles:v1';
        var incoming=\(profileJSON);
        var list=[];try{list=JSON.parse(localStorage.getItem(KEY)||'[]')||[];}catch(e){list=[];}
        if(!Array.isArray(list))list=[];
        var found=false;
        list=list.map(function(p){if(p&&p.endpoint===incoming.endpoint){found=true;return Object.assign({},p,{managementKey:incoming.managementKey});}return p;});
        if(!found)list.push(incoming);
        localStorage.setItem(KEY,JSON.stringify(list));
      }catch(e){}})();
      """
      controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    configuration.userContentController = controller
    configuration.websiteDataStore = .default()
    let view = WKWebView(frame: panel.contentLayoutRect, configuration: configuration)
    view.navigationDelegate = self
    view.autoresizingMask = [.width, .height]
    view.setValue(false, forKey: "drawsBackground")
    return view
  }

  private func profileScriptPayload() -> String? {
    let profile: [String: Any] = [
      "id": "desktop-local",
      "name": "本机 AIH Server",
      "endpoint": origin,
      "managementKey": managementKey,
      "state": "online"
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: profile),
          let text = String(data: data, encoding: .utf8) else { return nil }
    return text
  }

  private func load() {
    guard let url = quickURL() else { return }
    if webView == nil {
      let view = makeWebView()
      webView = view
      panel.contentView = view
    }
    guard url.absoluteString != loadedURL else { return }
    loadedURL = url.absoluteString
    pageReady = false
    webView?.load(URLRequest(url: url))
  }

  private func flushReferences() {
    guard pageReady, let webView, !pendingReferences.isEmpty else { return }
    let items = pendingReferences
    pendingReferences.removeAll()
    for item in items {
      let message: [String: Any] = ["type": "aih-chat-reference", "text": item["text"] ?? "", "source": item["source"] ?? "desktop-selection"]
      guard let data = try? JSONSerialization.data(withJSONObject: message),
            let json = String(data: data, encoding: .utf8) else { continue }
      webView.evaluateJavaScript("window.postMessage(\(json), window.location.origin);", completionHandler: nil)
    }
  }

  // MARK: WKNavigationDelegate

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    pageReady = true
    flushReferences()
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    // 站内导航留在窗口里；外链交给系统浏览器，避免 Quick Chat 变成一个半成品浏览器。
    // 这个窗口只做 chat / work：同源但不是 /ui/chat 下的页面（账号、用量、工具箱等）
    // 也交给浏览器里的完整 WebUI，不在快捷窗口里打开。
    guard let url = navigationAction.request.url else { decisionHandler(.allow); return }
    let inlineScheme = url.scheme == "about" || url.scheme == "blob" || url.scheme == "data"
    let chatScope = url.absoluteString.hasPrefix(origin) && url.path.hasPrefix("/ui/chat")
    if inlineScheme || chatScope || navigationAction.targetFrame?.isMainFrame == false {
      decisionHandler(.allow)
    } else {
      NSWorkspace.shared.open(url)
      decisionHandler(.cancel)
    }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { loadedURL = "" }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { loadedURL = "" }

  // MARK: NSWindowDelegate

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    // 关闭只是收起：会话状态在 WebUI 里，下次唤起直接回到原处。
    panel.orderOut(nil)
    return false
  }
}
