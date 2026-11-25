import AppKit
import Foundation
import WebKit

/// Full desktop workspace window for Paste // Nexus, backed by a WKWebView
/// loading `/ui/paste/?mode=workspace&embed=desktop`.
final class ClipboardWorkspaceWindow: NSObject, NSWindowDelegate, WKNavigationDelegate {
  let window: NSWindow
  private var webView: WKWebView?
  private var origin = ""
  private var managementKey = ""
  private var enabled = false
  private var loadedURL = ""
  private var pageReady = false
  private var hasPositioned = false

  override init() {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    super.init()
    window.title = "AIH 剪贴板"
    window.isReleasedWhenClosed = false
    window.minSize = NSSize(width: 720, height: 520)
    window.appearance = NSAppearance(named: .darkAqua)
    window.backgroundColor = NSColor(srgbRed: 0.031, green: 0.043, blue: 0.082, alpha: 1)
    window.delegate = self
    window.setFrameAutosaveName("AIHClipboardWorkspace")
  }

  var isAvailable: Bool { enabled && !origin.isEmpty && !managementKey.isEmpty }
  var isKeyWindow: Bool { window.isVisible && window.isKeyWindow }

  func configure(origin nextOrigin: String, managementKey nextKey: String, enabled nextEnabled: Bool) {
    let normalized = nextOrigin
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let changed = normalized != origin || nextKey != managementKey
    origin = normalized
    managementKey = nextKey
    enabled = nextEnabled
    if changed, webView != nil {
      teardownWebView()
      if window.isVisible {
        load()
      }
    }
  }

  func show() {
    guard isAvailable else { return }
    if !hasPositioned {
      hasPositioned = true
      if !window.setFrameUsingName("AIHClipboardWorkspace") {
        window.setContentSize(NSSize(width: 1280, height: 860))
        window.center()
      }
    }
    load()
    if pageReady {
      webView?.evaluateJavaScript("window.__AIH_CLIPBOARD_REFRESH__ && window.__AIH_CLIPBOARD_REFRESH__();", completionHandler: nil)
    }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    _ = NSRunningApplication.current.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
  }

  func hide() {
    window.orderOut(nil)
  }

  private func teardownWebView() {
    webView?.navigationDelegate = nil
    webView?.removeFromSuperview()
    webView = nil
    loadedURL = ""
    pageReady = false
  }

  private func workspaceURL() -> URL? {
    guard !origin.isEmpty, var components = URLComponents(string: "\(origin)/ui/paste/") else { return nil }
    components.queryItems = [
      URLQueryItem(name: "mode", value: "workspace"),
      URLQueryItem(name: "embed", value: "desktop")
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
    if let source = bootstrapScriptSource() {
      controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    configuration.userContentController = controller
    configuration.websiteDataStore = .default()
    let view = WKWebView(frame: window.contentLayoutRect, configuration: configuration)
    view.navigationDelegate = self
    view.autoresizingMask = [.width, .height]
    view.setValue(false, forKey: "drawsBackground")
    return view
  }

  private func load() {
    guard let url = workspaceURL() else { return }
    if webView == nil {
      let view = makeWebView()
      webView = view
      window.contentView = view
    }
    guard url.absoluteString != loadedURL else { return }
    loadedURL = url.absoluteString
    pageReady = false
    webView?.load(URLRequest(url: url))
  }

  // MARK: WKNavigationDelegate

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    pageReady = true
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
    window.orderOut(nil)
    return false
  }
}
