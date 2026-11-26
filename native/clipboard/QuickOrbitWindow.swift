import AppKit
import Foundation
import QuartzCore
import WebKit

private final class QuickOrbitHostPanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
}

private final class QuickOrbitScriptProxy: NSObject, WKScriptMessageHandler {
  weak var owner: QuickOrbitWindow?

  init(owner: QuickOrbitWindow) {
    self.owner = owner
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    owner?.handleScriptMessage(message)
  }
}

/// Borderless transparent floating Quick Orbit overlay panel loading
/// `/ui/paste/?mode=quick&embed=desktop&position=<position>`.
final class QuickOrbitWindow: NSObject, NSWindowDelegate, WKNavigationDelegate {
  let panel: NSPanel
  private var webView: WKWebView?
  private var origin = ""
  private var managementKey = ""
  private var enabled = false
  private var position = "bottom"
  private var loadedURL = ""
  private var pageReady = false
  private var isShowing = false
  private var animationToken = 0

  override init() {
    panel = QuickOrbitHostPanel(
      contentRect: NSRect(x: 0, y: 0, width: 1520, height: 438),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    super.init()
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.appearance = NSAppearance(named: .darkAqua)
    panel.delegate = self
  }

  var isAvailable: Bool { enabled && !origin.isEmpty && !managementKey.isEmpty }
  var isVisibleAndKey: Bool { isShowing && panel.isVisible && panel.isKeyWindow }

  func configure(origin nextOrigin: String, managementKey nextKey: String, enabled nextEnabled: Bool, position nextPosition: String) {
    let normalizedOrigin = nextOrigin
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let normalizedPosition = Self.normalizePosition(nextPosition)
    let changed = normalizedOrigin != origin || nextKey != managementKey || normalizedPosition != position
    origin = normalizedOrigin
    managementKey = nextKey
    enabled = nextEnabled
    position = normalizedPosition
    if !nextEnabled {
      hide()
    }
    if changed, webView != nil {
      teardownWebView()
      if isShowing && enabled {
        load()
        NSAnimationContext.runAnimationGroup({ context in
          context.duration = 0.36
          context.timingFunction = CAMediaTimingFunction(controlPoints: 0.16, 1, 0.3, 1)
          self.panel.animator().setFrame(self.targetFrame(), display: true)
        }, completionHandler: nil)
      }
    }
  }

  func toggle() {
    if isShowing {
      hide()
    } else {
      show()
    }
  }

  func show() {
    guard isAvailable else { return }
    animationToken += 1
    let token = animationToken
    isShowing = true

    let target = targetFrame()
    let start = offscreenFrame(from: target)
    load()
    if pageReady {
      webView?.evaluateJavaScript("window.__AIH_CLIPBOARD_REFRESH__ && window.__AIH_CLIPBOARD_REFRESH__();", completionHandler: nil)
    }

    panel.setFrame(start, display: false)
    panel.alphaValue = 0
    panel.makeKeyAndOrderFront(nil)
    panel.orderFrontRegardless()
    panel.makeKey()
    NSApp.activate(ignoringOtherApps: true)
    _ = NSRunningApplication.current.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    if let view = webView {
      panel.makeFirstResponder(view)
    }

    NSAnimationContext.runAnimationGroup({ context in
      context.duration = 0.42
      context.timingFunction = CAMediaTimingFunction(controlPoints: 0.16, 1, 0.3, 1)
      self.panel.animator().setFrame(target, display: true)
      self.panel.animator().alphaValue = 1
    }, completionHandler: { [weak self] in
      guard let self = self, self.animationToken == token else { return }
      self.panel.setFrame(target, display: true)
      self.panel.alphaValue = 1
      if let view = self.webView {
        self.panel.makeFirstResponder(view)
      }
    })
  }

  func hide() {
    guard isShowing || panel.isVisible else { return }
    animationToken += 1
    let token = animationToken
    isShowing = false

    let end = offscreenFrame(from: targetFrame())
    NSAnimationContext.runAnimationGroup({ context in
      context.duration = 0.26
      context.timingFunction = CAMediaTimingFunction(controlPoints: 0.7, 0, 0.84, 0)
      self.panel.animator().setFrame(end, display: true)
      self.panel.animator().alphaValue = 0
    }, completionHandler: { [weak self] in
      guard let self = self, self.animationToken == token else { return }
      self.panel.orderOut(nil)
      self.panel.alphaValue = 1
    })
  }

  func handleScriptMessage(_ message: WKScriptMessage) {
    guard message.name == "aihClipboard" else { return }
    if let body = message.body as? [String: Any], (body["type"] as? String) == "close" {
      hide()
    } else if let text = message.body as? String, text == "close" {
      hide()
    }
  }

  private static func normalizePosition(_ raw: String) -> String {
    switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "left": return "left"
    case "right": return "right"
    default: return "bottom"
    }
  }

  private func activeScreen() -> NSScreen? {
    let pointer = NSEvent.mouseLocation
    if let match = NSScreen.screens.first(where: { NSMouseInRect(pointer, $0.frame, false) }) {
      return match
    }
    return NSScreen.main ?? NSScreen.screens.first
  }

  private func targetFrame() -> NSRect {
    let visible = activeScreen()?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    switch position {
    case "left", "right":
      // Left/right are full-height vertical rails on the screen edge, not the
      // bottom card anchored to one side.
      let width = min(460, max(360, visible.width * 0.3))
      let height = min(780, max(480, visible.height - 36))
      let y = visible.minY + floor((visible.height - height) / 2)
      let x = position == "left" ? visible.minX + 18 : visible.maxX - width - 18
      return NSRect(x: x, y: y, width: width, height: height)
    default:
      let width = min(1520, max(360, visible.width - 48))
      let height: CGFloat = 472
      let x = visible.minX + floor((visible.width - width) / 2)
      return NSRect(x: x, y: visible.minY + 18, width: width, height: height)
    }
  }

  private func offscreenFrame(from target: NSRect) -> NSRect {
    switch position {
    case "left":
      return target.offsetBy(dx: -target.width - 28, dy: 0)
    case "right":
      return target.offsetBy(dx: target.width + 28, dy: 0)
    default:
      return target.offsetBy(dx: -70, dy: -target.height - 26)
    }
  }

  private func teardownWebView() {
    if let existing = webView {
      existing.configuration.userContentController.removeScriptMessageHandler(forName: "aihClipboard")
      existing.navigationDelegate = nil
      existing.removeFromSuperview()
    }
    webView = nil
    loadedURL = ""
    pageReady = false
  }

  private func quickURL() -> URL? {
    guard !origin.isEmpty, var components = URLComponents(string: "\(origin)/ui/paste/") else { return nil }
    components.queryItems = [
      URLQueryItem(name: "v", value: String(Int(Date().timeIntervalSince1970))),
      URLQueryItem(name: "mode", value: "quick"),
      URLQueryItem(name: "embed", value: "desktop"),
      URLQueryItem(name: "position", value: position)
    ]
    return components.url
  }

  private func bootstrapScriptSource() -> String? {
    let profile: [String: Any] = [
      "id": "desktop-local",
      "name": "本机 AIH Server",
      "endpoint": origin,
      "managementKey": managementKey,
      "state": "online"
    ]
    let bootstrap: [String: Any] = [
      "origin": origin,
      "managementKey": managementKey
    ]
    guard let profileData = try? JSONSerialization.data(withJSONObject: profile),
          let profileJSON = String(data: profileData, encoding: .utf8),
          let bootstrapData = try? JSONSerialization.data(withJSONObject: bootstrap),
          let bootstrapJSON = String(data: bootstrapData, encoding: .utf8) else {
      return nil
    }
    return """
    (function(){try{
      window.__AIH_CLIPBOARD__=\(bootstrapJSON);
      var KEY='aih:control-plane-profiles:v1';
      var incoming=\(profileJSON);
      var list=[];try{list=JSON.parse(localStorage.getItem(KEY)||'[]')||[];}catch(e){list=[];}
      if(!Array.isArray(list))list=[];
      var found=false;
      list=list.map(function(p){
        if(p&&p.endpoint===incoming.endpoint){
          found=true;
          return Object.assign({},p,{id:p.id||incoming.id,name:p.name||incoming.name,managementKey:incoming.managementKey,state:incoming.state});
        }
        return p;
      });
      if(!found)list.push(incoming);
      localStorage.setItem(KEY,JSON.stringify(list));
    }catch(e){}})();
    """
  }

  private func makeWebView() -> WKWebView {
    let configuration = WKWebViewConfiguration()
    let controller = WKUserContentController()
    controller.add(QuickOrbitScriptProxy(owner: self), name: "aihClipboard")
    if let source = bootstrapScriptSource() {
      controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    configuration.userContentController = controller
    configuration.websiteDataStore = .default()
    let view = WKWebView(frame: panel.contentLayoutRect, configuration: configuration)
    view.navigationDelegate = self
    view.autoresizingMask = [.width, .height]
    view.setValue(false, forKey: "drawsBackground")
    view.wantsLayer = true
    view.layer?.backgroundColor = NSColor.clear.cgColor
    return view
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

  // MARK: WKNavigationDelegate

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    pageReady = true
    if isShowing {
      panel.makeFirstResponder(webView)
    }
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = navigationAction.request.url else { decisionHandler(.allow); return }
    let inlineScheme = url.scheme == "about" || url.scheme == "blob" || url.scheme == "data"
    let pasteScope = url.absoluteString.hasPrefix(origin) && url.path.hasPrefix("/ui/paste")
    if inlineScheme || pasteScope || navigationAction.targetFrame?.isMainFrame == false {
      decisionHandler(.allow)
    } else {
      NSWorkspace.shared.open(url)
      decisionHandler(.cancel)
    }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    loadedURL = ""
    pageReady = false
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    loadedURL = ""
    pageReady = false
  }

  // MARK: NSWindowDelegate

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    hide()
    return false
  }
}
