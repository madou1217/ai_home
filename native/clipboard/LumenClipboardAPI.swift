import AppKit
import Foundation

/// HTTP client speaking directly to `/v1/management/webui/clipboard/*`.
final class LumenClipboardAPIClient {
  enum APIError: LocalizedError {
    case unconfigured
    case pendingMaterialization
    case httpStatus(Int, String)
    case invalidPayload

    var errorDescription: String? {
      switch self {
      case .unconfigured:
        return "本机 AIH Server 或管理密钥未配置"
      case .pendingMaterialization:
        return "正在从源设备获取内容，请稍候"
      case .httpStatus(let code, let message):
        return message.isEmpty ? "请求失败 (HTTP \(code))" : message
      case .invalidPayload:
        return "服务端返回格式无法解析"
      }
    }
  }

  private(set) var config = LumenEndpointConfig(origin: "", managementKey: "")
  private let session: URLSession

  init() {
    let configuration = URLSessionConfiguration.default
    configuration.timeoutIntervalForRequest = 12
    configuration.timeoutIntervalForResource = 30
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    session = URLSession(configuration: configuration)
  }

  @discardableResult
  func configure(_ next: LumenEndpointConfig) -> Bool {
    let changed = next != config
    config = next
    return changed
  }

  var isConfigured: Bool { config.isValid }

  func authorizedRequest(path: String, method: String = "GET", queryItems: [URLQueryItem] = [], jsonBody: Any? = nil, timeout: TimeInterval = 12) -> URLRequest? {
    guard isConfigured, var components = URLComponents(string: config.origin + "/v1/management/webui/clipboard" + path) else {
      return nil
    }
    if !queryItems.isEmpty {
      components.queryItems = queryItems
    }
    guard let url = components.url else { return nil }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = timeout
    request.setValue("Bearer \(config.managementKey)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let jsonBody {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try? JSONSerialization.data(withJSONObject: jsonBody)
    }
    return request
  }

  func itemFileStreamURL(itemID: String, index: Int) -> URL? {
    guard isConfigured, var components = URLComponents(string: config.origin + "/v1/management/webui/clipboard/items/\(encodeSegment(itemID))/file") else {
      return nil
    }
    components.queryItems = [URLQueryItem(name: "index", value: String(max(0, index)))]
    return components.url
  }

  func authHeaders() -> [String: String] {
    guard !config.managementKey.isEmpty else { return [:] }
    return ["Authorization": "Bearer \(config.managementKey)"]
  }

  func listItems(limit: Int = 200, query: String = "", kind: String = "", completion: @escaping (Result<[LumenClipboardItem], Error>) -> Void) {
    var items = [URLQueryItem(name: "limit", value: String(min(max(1, limit), 200)))]
    if !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
    if !kind.isEmpty { items.append(URLQueryItem(name: "kind", value: kind)) }
    guard let req = authorizedRequest(path: "/items", queryItems: items) else {
      DispatchQueue.main.async { completion(.failure(APIError.unconfigured)) }
      return
    }
    performJSON(req, as: LumenClipboardItemsResponse.self) { result in
      completion(result.map(\.items))
    }
  }

  func getItemDetail(id: String, completion: @escaping (Result<LumenClipboardItem, Error>) -> Void) {
    guard let req = authorizedRequest(path: "/items/\(encodeSegment(id))") else {
      DispatchQueue.main.async { completion(.failure(APIError.unconfigured)) }
      return
    }
    performJSON(req, as: LumenClipboardItemResponse.self) { result in
      completion(result.map(\.item))
    }
  }

  func fetchItemContent(id: String, retriesRemaining: Int = 3, completion: @escaping (Result<(Data, String), Error>) -> Void) {
    guard let req = authorizedRequest(path: "/items/\(encodeSegment(id))/content", timeout: 20) else {
      DispatchQueue.main.async { completion(.failure(APIError.unconfigured)) }
      return
    }
    session.dataTask(with: req) { [weak self] data, response, error in
      if let error {
        DispatchQueue.main.async { completion(.failure(error)) }
        return
      }
      let http = response as? HTTPURLResponse
      let status = http?.statusCode ?? 0
      if status == 409, retriesRemaining > 0, let self {
        self.materializeItem(id: id) { _ in
          DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.8) {
            self.fetchItemContent(id: id, retriesRemaining: retriesRemaining - 1, completion: completion)
          }
        }
        return
      }
      guard status == 200, let data else {
        let msg = Self.parseErrorMessage(data)
        DispatchQueue.main.async {
          completion(.failure(status == 409 ? APIError.pendingMaterialization : APIError.httpStatus(status, msg)))
        }
        return
      }
      let mime = http?.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream"
      DispatchQueue.main.async { completion(.success((data, mime))) }
    }.resume()
  }

  func fetchItemFileData(id: String, index: Int, completion: @escaping (Result<(Data, String), Error>) -> Void) {
    guard let req = authorizedRequest(
      path: "/items/\(encodeSegment(id))/file",
      queryItems: [URLQueryItem(name: "index", value: String(max(0, index)))],
      timeout: 25
    ) else {
      DispatchQueue.main.async { completion(.failure(APIError.unconfigured)) }
      return
    }
    session.dataTask(with: req) { data, response, error in
      if let error {
        DispatchQueue.main.async { completion(.failure(error)) }
        return
      }
      let http = response as? HTTPURLResponse
      let status = http?.statusCode ?? 0
      guard status == 200, let data else {
        let msg = Self.parseErrorMessage(data)
        DispatchQueue.main.async { completion(.failure(APIError.httpStatus(status, msg))) }
        return
      }
      let mime = http?.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream"
      DispatchQueue.main.async { completion(.success((data, mime))) }
    }.resume()
  }

  func fetchFilePreview(id: String, index: Int? = nil, completion: @escaping (Result<LumenServerPreview, Error>) -> Void) {
    var query: [URLQueryItem] = []
    if let index { query.append(URLQueryItem(name: "index", value: String(max(0, index)))) }
    guard let req = authorizedRequest(path: "/items/\(encodeSegment(id))/preview", queryItems: query, timeout: 15) else {
      DispatchQueue.main.async { completion(.failure(APIError.unconfigured)) }
      return
    }
    performJSON(req, as: LumenServerPreviewResponse.self) { result in
      completion(result.map(\.preview))
    }
  }

  func materializeItem(id: String, completion: @escaping (Result<Bool, Error>) -> Void) {
    guard let req = authorizedRequest(path: "/items/\(encodeSegment(id))/materialize", method: "POST") else {
      DispatchQueue.main.async { completion(.failure(APIError.unconfigured)) }
      return
    }
    session.dataTask(with: req) { data, response, error in
      if let error {
        DispatchQueue.main.async { completion(.failure(error)) }
        return
      }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      guard status == 200, let data,
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        let msg = Self.parseErrorMessage(data)
        DispatchQueue.main.async { completion(.failure(APIError.httpStatus(status, msg))) }
        return
      }
      let ready = (obj["state"] as? String) == "ready"
      DispatchQueue.main.async { completion(.success(ready)) }
    }.resume()
  }

  /// Writes an item to the OS clipboard via the existing server HTTP API.
  /// Automatically requests materialization and retries if the item is a synced stub.
  func copyItemToOSClipboard(id: String, retriesRemaining: Int = 3, completion: @escaping (Result<Void, Error>) -> Void) {
    guard let req = authorizedRequest(path: "/items/\(encodeSegment(id))/copy", method: "POST") else {
      DispatchQueue.main.async { completion(.failure(APIError.unconfigured)) }
      return
    }
    session.dataTask(with: req) { [weak self] data, response, error in
      if let error {
        DispatchQueue.main.async { completion(.failure(error)) }
        return
      }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      if status == 200 {
        DispatchQueue.main.async { completion(.success(())) }
        return
      }
      if status == 409, retriesRemaining > 0, let self {
        self.materializeItem(id: id) { matResult in
          switch matResult {
          case .success(let ready):
            let delay: TimeInterval = ready ? 0.05 : 0.8
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + delay) {
              self.copyItemToOSClipboard(id: id, retriesRemaining: retriesRemaining - 1, completion: completion)
            }
          case .failure(let err):
            DispatchQueue.main.async { completion(.failure(err)) }
          }
        }
        return
      }
      let msg = Self.parseErrorMessage(data)
      DispatchQueue.main.async {
        completion(.failure(status == 409 ? APIError.pendingMaterialization : APIError.httpStatus(status, msg)))
      }
    }.resume()
  }

  func ingestText(_ text: String, kind: String? = nil, sourceApp: String = "Lumen", completion: @escaping (Result<LumenClipboardItem, Error>) -> Void) {
    var payload: [String: Any] = [
      "text": text,
      "sourceApp": sourceApp
    ]
    if let kind, !kind.isEmpty {
      payload["kind"] = kind
    }
    ingestRaw(payload: payload, completion: completion)
  }

  func ingestFiles(_ files: [String], sourceApp: String = "Lumen", completion: @escaping (Result<LumenClipboardItem, Error>) -> Void) {
    let payload: [String: Any] = [
      "kind": "file",
      "files": files,
      "sourceApp": sourceApp
    ]
    ingestRaw(payload: payload, completion: completion)
  }

  func ingestImage(data: Data, mime: String, width: Int, height: Int, sourceApp: String = "Lumen", completion: @escaping (Result<LumenClipboardItem, Error>) -> Void) {
    var payload: [String: Any] = [
      "kind": "image",
      "mime": mime.isEmpty ? "image/png" : mime,
      "dataBase64": data.base64EncodedString(),
      "sourceApp": sourceApp
    ]
    if width > 0 { payload["width"] = width }
    if height > 0 { payload["height"] = height }
    ingestRaw(payload: payload, completion: completion)
  }

  private func ingestRaw(payload: [String: Any], completion: @escaping (Result<LumenClipboardItem, Error>) -> Void) {
    guard let req = authorizedRequest(path: "/items", method: "POST", jsonBody: payload) else {
      DispatchQueue.main.async { completion(.failure(APIError.unconfigured)) }
      return
    }
    performJSON(req, as: LumenClipboardItemResponse.self, acceptedStatuses: [200, 201]) { result in
      completion(result.map(\.item))
    }
  }

  func setPinned(id: String, pinned: Bool, completion: @escaping (Result<LumenClipboardItem, Error>) -> Void) {
    guard let req = authorizedRequest(path: "/items/\(encodeSegment(id))/pin", method: "POST", jsonBody: ["pinned": pinned]) else {
      DispatchQueue.main.async { completion(.failure(APIError.unconfigured)) }
      return
    }
    performJSON(req, as: LumenClipboardItemResponse.self) { result in
      completion(result.map(\.item))
    }
  }

  func deleteItem(id: String, completion: @escaping (Result<Void, Error>) -> Void) {
    guard let req = authorizedRequest(path: "/items/\(encodeSegment(id))", method: "DELETE") else {
      DispatchQueue.main.async { completion(.failure(APIError.unconfigured)) }
      return
    }
    performStatusOnly(req, completion: completion)
  }

  func batchDeleteItems(ids: [String], completion: @escaping (Result<Int, Error>) -> Void) {
    guard !ids.isEmpty else {
      DispatchQueue.main.async { completion(.success(0)) }
      return
    }
    guard let req = authorizedRequest(path: "/items/batch-delete", method: "POST", jsonBody: ["ids": ids]) else {
      DispatchQueue.main.async { completion(.failure(APIError.unconfigured)) }
      return
    }
    performJSON(req, as: LumenBatchDeleteResponse.self) { result in
      completion(result.map(\.deleted))
    }
  }

  func getSettings(completion: @escaping (Result<LumenClipboardSettings, Error>) -> Void) {
    guard let req = authorizedRequest(path: "/settings") else {
      DispatchQueue.main.async { completion(.failure(APIError.unconfigured)) }
      return
    }
    performJSON(req, as: LumenClipboardSettingsResponse.self) { result in
      completion(result.map(\.settings))
    }
  }

  func patchSettings(_ patch: [String: Any], completion: @escaping (Result<LumenClipboardSettings, Error>) -> Void) {
    guard let req = authorizedRequest(path: "/settings", method: "PATCH", jsonBody: patch) else {
      DispatchQueue.main.async { completion(.failure(APIError.unconfigured)) }
      return
    }
    performJSON(req, as: LumenClipboardSettingsResponse.self) { result in
      completion(result.map(\.settings))
    }
  }

  func getStatus(completion: @escaping (Result<LumenClipboardStatus, Error>) -> Void) {
    guard let req = authorizedRequest(path: "/status") else {
      DispatchQueue.main.async { completion(.failure(APIError.unconfigured)) }
      return
    }
    performJSON(req, as: LumenClipboardStatus.self, completion: completion)
  }

  func listServers(completion: @escaping (Result<[LumenServerProfile], Error>) -> Void) {
    guard let req = authorizedRequest(path: "/servers") else {
      DispatchQueue.main.async { completion(.failure(APIError.unconfigured)) }
      return
    }
    performJSON(req, as: LumenServerProfilesResponse.self) { result in
      completion(result.map(\.servers))
    }
  }

  func triggerSync(completion: @escaping (Result<Void, Error>) -> Void) {
    guard let req = authorizedRequest(path: "/sync-run", method: "POST") else {
      DispatchQueue.main.async { completion(.failure(APIError.unconfigured)) }
      return
    }
    performStatusOnly(req, completion: completion)
  }

  private func encodeSegment(_ raw: String) -> String {
    raw.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? raw
  }

  private func performJSON<T: Decodable>(_ req: URLRequest, as type: T.Type, acceptedStatuses: Set<Int> = [200], completion: @escaping (Result<T, Error>) -> Void) {
    session.dataTask(with: req) { data, response, error in
      if let error {
        DispatchQueue.main.async { completion(.failure(error)) }
        return
      }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      guard acceptedStatuses.contains(status), let data else {
        let msg = Self.parseErrorMessage(data)
        DispatchQueue.main.async { completion(.failure(APIError.httpStatus(status, msg))) }
        return
      }
      do {
        let decoded = try JSONDecoder().decode(T.self, from: data)
        DispatchQueue.main.async { completion(.success(decoded)) }
      } catch {
        DispatchQueue.main.async { completion(.failure(APIError.invalidPayload)) }
      }
    }.resume()
  }

  private func performStatusOnly(_ req: URLRequest, completion: @escaping (Result<Void, Error>) -> Void) {
    session.dataTask(with: req) { data, response, error in
      if let error {
        DispatchQueue.main.async { completion(.failure(error)) }
        return
      }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      if (200..<300).contains(status) {
        DispatchQueue.main.async { completion(.success(())) }
      } else {
        let msg = Self.parseErrorMessage(data)
        DispatchQueue.main.async { completion(.failure(APIError.httpStatus(status, msg))) }
      }
    }.resume()
  }

  private static func parseErrorMessage(_ data: Data?) -> String {
    guard let data,
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return ""
    }
    if let nested = obj["error"] as? [String: Any], let msg = nested["message"] as? String, !msg.isEmpty {
      return msg
    }
    if let msg = obj["message"] as? String, !msg.isEmpty {
      return msg
    }
    if let err = obj["error"] as? String, !err.isEmpty {
      return err
    }
    return ""
  }
}

/// Persistent Server-Sent Events subscriber for `/v1/management/webui/clipboard/events`.
final class LumenSSEClient: NSObject, URLSessionDataDelegate {
  private var session: URLSession?
  private var task: URLSessionDataTask?
  private var buffer = Data()
  private var config = LumenEndpointConfig(origin: "", managementKey: "")
  private var running = false
  private var reconnectWork: DispatchWorkItem?
  private var backoffSeconds: TimeInterval = 1.5
  var onClipboardChanged: (() -> Void)?
  var onConnectionChanged: ((Bool) -> Void)?

  func start(config next: LumenEndpointConfig) {
    let changed = next != config
    config = next
    guard config.isValid else {
      stop()
      return
    }
    if running && !changed { return }
    stop()
    running = true
    backoffSeconds = 1.5
    connect()
  }

  func stop() {
    running = false
    reconnectWork?.cancel()
    reconnectWork = nil
    task?.cancel()
    task = nil
    session?.invalidateAndCancel()
    session = nil
    buffer.removeAll(keepingCapacity: false)
  }

  private func connect() {
    guard running, config.isValid,
          let url = URL(string: config.origin + "/v1/management/webui/clipboard/events") else {
      return
    }
    let cfg = URLSessionConfiguration.default
    cfg.timeoutIntervalForRequest = 120
    cfg.timeoutIntervalForResource = 0
    cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
    let nextSession = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    session = nextSession

    var req = URLRequest(url: url)
    req.httpMethod = "GET"
    req.setValue("Bearer \(config.managementKey)", forHTTPHeaderField: "Authorization")
    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    let dataTask = nextSession.dataTask(with: req)
    task = dataTask
    dataTask.resume()
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 200 {
      backoffSeconds = 1.5
      DispatchQueue.main.async { [weak self] in self?.onConnectionChanged?(true) }
      completionHandler(.allow)
    } else {
      completionHandler(.cancel)
    }
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    buffer.append(data)
    while let range = buffer.range(of: Data([0x0A, 0x0A])) {
      let frameData = buffer.subdata(in: 0..<range.lowerBound)
      buffer.removeSubrange(0..<range.upperBound)
      if let frame = String(data: frameData, encoding: .utf8),
         frame.contains("event: clipboard") {
        DispatchQueue.main.async { [weak self] in
          self?.onClipboardChanged?()
        }
      }
    }
    if buffer.count > 65_536 {
      buffer.removeAll(keepingCapacity: false)
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard running else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self, self.running else { return }
      self.onConnectionChanged?(false)
      self.scheduleReconnect()
    }
  }

  private func scheduleReconnect() {
    reconnectWork?.cancel()
    let delay = backoffSeconds
    backoffSeconds = min(backoffSeconds * 1.6, 15.0)
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.running else { return }
      self.session?.invalidateAndCancel()
      self.session = nil
      self.connect()
    }
    reconnectWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
  }
}

/// Shared visual preferences persisted locally across App window, Orbit, and Preview.
struct LumenVisualPreferences: Equatable {
  enum ThemeMode: String {
    case light
    case dark
  }

  var theme: ThemeMode
  var particles: Bool
  var glow: Bool
  var motion: Bool

  private enum Keys {
    static let theme = "lumen.v7.theme"
    static let particles = "lumen.v7.particles"
    static let glow = "lumen.v7.glow"
    static let motion = "lumen.v7.motion"
  }

  static func load() -> LumenVisualPreferences {
    let ud = UserDefaults.standard
    let rawTheme = ud.string(forKey: Keys.theme) ?? "light"
    let theme = ThemeMode(rawValue: rawTheme) ?? .light
    let particles = ud.object(forKey: Keys.particles) == nil ? true : ud.bool(forKey: Keys.particles)
    let glow = ud.object(forKey: Keys.glow) == nil ? true : ud.bool(forKey: Keys.glow)
    let motion = ud.object(forKey: Keys.motion) == nil ? true : ud.bool(forKey: Keys.motion)
    return LumenVisualPreferences(theme: theme, particles: particles, glow: glow, motion: motion)
  }

  func save() {
    let ud = UserDefaults.standard
    ud.set(theme.rawValue, forKey: Keys.theme)
    ud.set(particles, forKey: Keys.particles)
    ud.set(glow, forKey: Keys.glow)
    ud.set(motion, forKey: Keys.motion)
  }
}

struct LumenUndoEntry {
  let item: LumenClipboardItem
  let originalIndex: Int
  let anchorAfterID: String?
  let fullText: String?
  let imageData: Data?
}

/// Shared reactive clipboard store backing the App Management Window, Orbit Panel, and Preview Container.
final class LumenClipboardStore {
  static let shared = LumenClipboardStore()

  enum ChangeEvent {
    case itemsUpdated
    case itemsCaptured([LumenClipboardItem])
    case itemRestored(LumenClipboardItem, logicalIndex: Int)
    case settingsUpdated
    case statusUpdated
    case preferencesUpdated
    case connectionUpdated
    case error(String)
  }

  let api = LumenClipboardAPIClient()
  private let sse = LumenSSEClient()
  private var observers: [UUID: (ChangeEvent) -> Void] = [:]

  private(set) var items: [LumenClipboardItem] = []
  private(set) var settings: LumenClipboardSettings = .defaults
  private(set) var status: LumenClipboardStatus?
  private(set) var servers: [LumenServerProfile] = []
  private(set) var connected = false
  private(set) var lastError: String?
  private(set) var preferences: LumenVisualPreferences = LumenVisualPreferences.load()
  private var undoStack: [LumenUndoEntry] = []
  private var detailCache: [String: LumenClipboardItem] = [:]
  private var imagePayloadCache: [String: Data] = [:]
  private var restoredOrderHints: [String: (anchorAfterID: String?, fallbackIndex: Int)] = [:]
  private var recentlyRestoredIDs: Set<String> = []
  private var hasLoadedInitialItems = false
  private var refreshDebounceWork: DispatchWorkItem?
  private var isRefreshingItems = false
  private var pendingFollowupRefresh = false

  // Active live NSPasteboard observer while Orbit is open (§16.4)
  private var liveCaptureTimer: Timer?
  private var lastPasteboardChangeCount: Int = NSPasteboard.general.changeCount
  private var selfWriteSuppressUntil: TimeInterval = 0
  private var isIngestingPasteboard = false

  var onQuickOrbitPositionChanged: ((String) -> Void)?

  private init() {
    sse.onClipboardChanged = { [weak self] in
      self?.scheduleDebouncedRefresh()
    }
    sse.onConnectionChanged = { [weak self] online in
      guard let self else { return }
      if self.connected != online {
        self.connected = online
        self.notify(.connectionUpdated)
      }
    }
  }

  var isConfigured: Bool { api.isConfigured }
  var canUndoDelete: Bool { !undoStack.isEmpty }

  @discardableResult
  func addObserver(_ handler: @escaping (ChangeEvent) -> Void) -> UUID {
    let id = UUID()
    observers[id] = handler
    return id
  }

  func removeObserver(_ id: UUID) {
    observers.removeValue(forKey: id)
  }

  private func notify(_ event: ChangeEvent) {
    for handler in observers.values {
      handler(event)
    }
  }

  func configure(origin: String, managementKey: String) {
    let resolved = LumenLocalConfigLoader.resolve(explicitOrigin: origin, explicitKey: managementKey)
    let changed = api.configure(resolved)
    if resolved.isValid {
      sse.start(config: resolved)
      if changed || items.isEmpty {
        refreshAll()
      }
    } else {
      sse.stop()
      connected = false
      notify(.connectionUpdated)
    }
  }

  func ensureConfiguredFromLocalConfig() {
    guard !api.isConfigured else { return }
    let resolved = LumenLocalConfigLoader.resolve()
    if resolved.isValid {
      configure(origin: resolved.origin, managementKey: resolved.managementKey)
    }
  }

  func updatePreferences(_ mutate: (inout LumenVisualPreferences) -> Void) {
    var next = preferences
    mutate(&next)
    guard next != preferences else { return }
    preferences = next
    preferences.save()
    notify(.preferencesUpdated)
  }

  func refreshAll() {
    refreshItems()
    refreshSettings()
    refreshStatus()
    refreshServers()
  }

  private func scheduleDebouncedRefresh() {
    refreshDebounceWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      self?.refreshItems()
      self?.refreshStatus()
    }
    refreshDebounceWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.16, execute: work)
  }

  func notifyIdentityChanged() {
    notify(.itemsUpdated)
  }

  func peekLastUndoItemID() -> String? {
    undoStack.last?.item.id
  }

  func markSelfClipboardWrite(duration: TimeInterval = 1.6) {
    selfWriteSuppressUntil = max(selfWriteSuppressUntil, Date().timeIntervalSince1970 + duration)
    lastPasteboardChangeCount = NSPasteboard.general.changeCount
  }

  func startLiveOrbitCapture() {
    lastPasteboardChangeCount = NSPasteboard.general.changeCount
    guard liveCaptureTimer == nil else { return }
    let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
      self?.pollLocalPasteboardIfNeeded()
    }
    RunLoop.main.add(timer, forMode: .common)
    liveCaptureTimer = timer
  }

  func stopLiveOrbitCapture() {
    liveCaptureTimer?.invalidate()
    liveCaptureTimer = nil
  }

  private func pollLocalPasteboardIfNeeded() {
    guard settings.captureEnabled, api.isConfigured, !isIngestingPasteboard else { return }
    let pb = NSPasteboard.general
    let current = pb.changeCount
    guard current != lastPasteboardChangeCount else { return }
    lastPasteboardChangeCount = current
    if Date().timeIntervalSince1970 < selfWriteSuppressUntil { return }

    let myPID = ProcessInfo.processInfo.processIdentifier
    let frontApp = NSWorkspace.shared.frontmostApplication
    let sourceApp = (frontApp != nil && frontApp?.processIdentifier != myPID) ? (frontApp?.localizedName ?? "") : ""

    if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
      let paths = urls.map(\.path).filter { !$0.isEmpty }
      if !paths.isEmpty {
        isIngestingPasteboard = true
        api.ingestFiles(paths, sourceApp: sourceApp) { [weak self] result in
          self?.handleLiveCapturedResult(result)
        }
        return
      }
    }

    if let pngData = pb.data(forType: .png), !pngData.isEmpty {
      let img = NSImage(data: pngData)
      let width = Int(img?.size.width.rounded() ?? 0)
      let height = Int(img?.size.height.rounded() ?? 0)
      isIngestingPasteboard = true
      api.ingestImage(data: pngData, mime: "image/png", width: width, height: height, sourceApp: sourceApp) { [weak self] result in
        self?.handleLiveCapturedResult(result)
      }
      return
    }

    if let tiffData = pb.data(forType: .tiff),
       let rep = NSBitmapImageRep(data: tiffData),
       let pngData = rep.representation(using: .png, properties: [:]) {
      isIngestingPasteboard = true
      api.ingestImage(data: pngData, mime: "image/png", width: rep.pixelsWide, height: rep.pixelsHigh, sourceApp: sourceApp) { [weak self] result in
        self?.handleLiveCapturedResult(result)
      }
      return
    }

    if let text = pb.string(forType: .string), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      let kind = (trimmed.lowercased().hasPrefix("http://") || trimmed.lowercased().hasPrefix("https://"))
        && !trimmed.contains(where: { $0.isWhitespace || $0.isNewline }) ? "link" : "text"
      isIngestingPasteboard = true
      api.ingestText(text, kind: kind, sourceApp: sourceApp) { [weak self] result in
        self?.handleLiveCapturedResult(result, inlineText: text)
      }
    }
  }

  private func handleLiveCapturedResult(_ result: Result<LumenClipboardItem, Error>, inlineText: String? = nil) {
    isIngestingPasteboard = false
    guard case .success(var captured) = result else { return }
    if let inlineText {
      captured.text = inlineText
      detailCache[captured.id] = captured
    }
    let existedAtHead = items.first?.id == captured.id
    let alreadyExisted = items.contains(where: { $0.id == captured.id })
    restoredOrderHints.removeValue(forKey: captured.id)
    items.removeAll { $0.id == captured.id }
    items.insert(captured, at: 0)
    notify(.itemsUpdated)
    if !existedAtHead || !alreadyExisted {
      notify(.itemsCaptured([captured]))
    }
    refreshStatus()
  }

  func refreshItems(completion: (() -> Void)? = nil) {
    guard api.isConfigured else {
      completion?()
      return
    }
    if isRefreshingItems {
      pendingFollowupRefresh = true
      completion?()
      return
    }
    isRefreshingItems = true
    api.listItems(limit: 200) { [weak self] result in
      guard let self else { return }
      self.isRefreshingItems = false
      switch result {
      case .success(let fetched):
        let oldIDs = Set(self.items.map(\.id))
        var merged: [LumenClipboardItem] = fetched.map { item in
          if let cached = self.detailCache[item.id], let cachedText = cached.text {
            var updated = item
            updated.text = cachedText
            updated.textTruncated = cached.textTruncated
            updated.blobPath = cached.blobPath
            return updated
          }
          return item
        }
        merged = self.applyRestoredOrderHints(to: merged)
        let newlyCaptured: [LumenClipboardItem]
        if self.hasLoadedInitialItems {
          newlyCaptured = merged.filter { item in
            !oldIDs.contains(item.id) && !self.recentlyRestoredIDs.contains(item.id)
          }
        } else {
          newlyCaptured = []
        }
        self.items = merged
        self.hasLoadedInitialItems = true
        self.connected = true
        self.lastError = nil
        self.notify(.itemsUpdated)
        if !newlyCaptured.isEmpty {
          self.notify(.itemsCaptured(newlyCaptured))
        }
      case .failure(let error):
        self.lastError = error.localizedDescription
        self.notify(.error(error.localizedDescription))
      }
      completion?()
      if self.pendingFollowupRefresh {
        self.pendingFollowupRefresh = false
        self.refreshItems()
      }
    }
  }

  private func applyRestoredOrderHints(to list: [LumenClipboardItem]) -> [LumenClipboardItem] {
    guard !restoredOrderHints.isEmpty else { return list }
    var ordered = list
    let activeIDs = Set(ordered.map(\.id))
    restoredOrderHints = restoredOrderHints.filter { activeIDs.contains($0.key) }
    for (itemID, hint) in restoredOrderHints {
      guard let currentIdx = ordered.firstIndex(where: { $0.id == itemID }) else { continue }
      let moving = ordered.remove(at: currentIdx)
      let targetIdx: Int
      if let afterID = hint.anchorAfterID,
         let anchorIdx = ordered.firstIndex(where: { $0.id == afterID }) {
        targetIdx = anchorIdx
      } else {
        targetIdx = max(0, min(ordered.count, hint.fallbackIndex))
      }
      ordered.insert(moving, at: targetIdx)
    }
    return ordered
  }

  func hydrateItemDetail(id: String, completion: @escaping (LumenClipboardItem?) -> Void) {
    if let cached = detailCache[id], cached.text != nil {
      completion(cached)
      return
    }
    api.getItemDetail(id: id) { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(let detailed):
        self.detailCache[id] = detailed
        if let idx = self.items.firstIndex(where: { $0.id == id }) {
          self.items[idx] = detailed
          self.notify(.itemsUpdated)
        }
        completion(detailed)
      case .failure:
        completion(self.items.first(where: { $0.id == id }))
      }
    }
  }

  func refreshSettings() {
    guard api.isConfigured else { return }
    api.getSettings { [weak self] result in
      guard let self else { return }
      if case .success(let loaded) = result {
        self.settings = loaded
        self.notify(.settingsUpdated)
      }
    }
  }

  func patchSettings(_ patch: [String: Any], completion: ((Result<LumenClipboardSettings, Error>) -> Void)? = nil) {
    api.patchSettings(patch) { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(let updated):
        let prevPos = self.settings.quickOrbitPosition
        self.settings = updated
        self.notify(.settingsUpdated)
        if prevPos != updated.quickOrbitPosition {
          self.onQuickOrbitPositionChanged?(updated.quickOrbitPosition)
        }
        self.refreshStatus()
      case .failure(let error):
        self.notify(.error(error.localizedDescription))
      }
      completion?(result)
    }
  }

  func refreshStatus() {
    guard api.isConfigured else { return }
    api.getStatus { [weak self] result in
      guard let self else { return }
      if case .success(let next) = result {
        self.status = next
        self.connected = true
        self.notify(.statusUpdated)
      }
    }
  }

  func refreshServers() {
    guard api.isConfigured else { return }
    api.listServers { [weak self] result in
      guard let self else { return }
      if case .success(let list) = result {
        self.servers = list
        self.notify(.settingsUpdated)
      }
    }
  }

  func copyToOSClipboard(id: String, completion: @escaping (Result<Void, Error>) -> Void) {
    markSelfClipboardWrite()
    api.copyItemToOSClipboard(id: id) { [weak self] result in
      if case .success = result {
        self?.markSelfClipboardWrite()
      }
      completion(result)
    }
  }

  func togglePin(id: String, completion: ((Result<LumenClipboardItem, Error>) -> Void)? = nil) {
    guard let existing = items.first(where: { $0.id == id }) else { return }
    setPinned(id: id, pinned: !existing.pinned, completion: completion)
  }

  func setPinned(id: String, pinned: Bool, completion: ((Result<LumenClipboardItem, Error>) -> Void)? = nil) {
    api.setPinned(id: id, pinned: pinned) { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(let updated):
        if let idx = self.items.firstIndex(where: { $0.id == id }) {
          var merged = updated
          merged.text = self.items[idx].text
          self.items[idx] = merged
          self.notify(.itemsUpdated)
        }
        self.refreshStatus()
      case .failure(let error):
        self.notify(.error(error.localizedDescription))
      }
      completion?(result)
    }
  }

  func batchSetPinned(ids: [String], pinned: Bool, completion: @escaping () -> Void) {
    let group = DispatchGroup()
    for id in ids {
      group.enter()
      api.setPinned(id: id, pinned: pinned) { _ in group.leave() }
    }
    group.notify(queue: .main) { [weak self] in
      self?.refreshItems(completion: completion)
      self?.refreshStatus()
    }
  }

  private func resolveImageDataForUndo(item: LumenClipboardItem) -> Data? {
    if let cached = imagePayloadCache[item.id] {
      return cached
    }
    let blobPath = detailCache[item.id]?.blobPath ?? item.blobPath
    if let blobPath, !blobPath.isEmpty, let data = try? Data(contentsOf: URL(fileURLWithPath: blobPath)), !data.isEmpty {
      return data
    }
    if let cachedImg = LumenPreviewCache.shared.image(for: "clip:\(item.id)"),
       let tiff = cachedImg.tiffRepresentation,
       let rep = NSBitmapImageRep(data: tiff),
       let png = rep.representation(using: .png, properties: [:]) {
      return png
    }
    return nil
  }

  func deleteItem(id: String, optimistic: Bool = true, completion: ((Result<Void, Error>) -> Void)? = nil) {
    let removedIndex = items.firstIndex(where: { $0.id == id })
    let removedItem = removedIndex.map { items[$0] }
    let anchorAfterID: String? = removedIndex.flatMap { idx in
      (idx + 1 < items.count) ? items[idx + 1].id : nil
    }
    if let removedItem, let idx = removedIndex {
      let cachedText = detailCache[id]?.text ?? removedItem.text ?? (removedItem.kind == "text" || removedItem.kind == "link" ? removedItem.preview : nil)
      let imageData = removedItem.kind == "image" ? resolveImageDataForUndo(item: removedItem) : nil
      undoStack.append(LumenUndoEntry(
        item: removedItem,
        originalIndex: idx,
        anchorAfterID: anchorAfterID,
        fullText: cachedText,
        imageData: imageData
      ))
      if undoStack.count > 40 { undoStack.removeFirst() }
    }
    if optimistic, let idx = removedIndex {
      items.remove(at: idx)
      notify(.itemsUpdated)
    }
    api.deleteItem(id: id) { [weak self] result in
      guard let self else { return }
      switch result {
      case .success:
        self.detailCache.removeValue(forKey: id)
        if !optimistic {
          self.items.removeAll { $0.id == id }
          self.notify(.itemsUpdated)
        }
        self.refreshStatus()
      case .failure(let error):
        if optimistic, let removedItem, let idx = removedIndex {
          self.items.insert(removedItem, at: min(idx, self.items.count))
          self.notify(.itemsUpdated)
        }
        self.notify(.error(error.localizedDescription))
      }
      completion?(result)
    }
  }

  func batchDelete(ids: [String], completion: @escaping (Result<Int, Error>) -> Void) {
    let idSet = Set(ids)
    for (idx, item) in items.enumerated() where idSet.contains(item.id) {
      let text = detailCache[item.id]?.text ?? item.text ?? (item.kind == "text" || item.kind == "link" ? item.preview : nil)
      let afterID = (idx + 1 < items.count) ? items[idx + 1].id : nil
      let imageData = item.kind == "image" ? resolveImageDataForUndo(item: item) : nil
      undoStack.append(LumenUndoEntry(
        item: item,
        originalIndex: idx,
        anchorAfterID: afterID,
        fullText: text,
        imageData: imageData
      ))
    }
    if undoStack.count > 40 { undoStack.removeFirst(undoStack.count - 40) }
    items.removeAll { idSet.contains($0.id) }
    notify(.itemsUpdated)

    api.batchDeleteItems(ids: ids) { [weak self] result in
      guard let self else { return }
      switch result {
      case .success:
        ids.forEach { self.detailCache.removeValue(forKey: $0) }
        self.refreshStatus()
      case .failure(let error):
        self.refreshItems()
        self.notify(.error(error.localizedDescription))
      }
      completion(result)
    }
  }

  func createTextItem(text: String, completion: @escaping (Result<LumenClipboardItem, Error>) -> Void) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let kind = (trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://")) ? "link" : "text"
    api.ingestText(text, kind: kind, sourceApp: "Lumen") { [weak self] result in
      guard let self else { return }
      if case .success(let created) = result {
        self.items.removeAll { $0.id == created.id }
        var enriched = created
        enriched.text = text
        self.detailCache[created.id] = enriched
        self.items.insert(enriched, at: 0)
        self.notify(.itemsUpdated)
        self.refreshStatus()
      }
      completion(result)
    }
  }

  /// Replaces a text/link clip with edited text while preserving pinned status.
  func updateTextItem(id: String, newText: String, completion: @escaping (Result<LumenClipboardItem, Error>) -> Void) {
    let existing = items.first(where: { $0.id == id })
    let originalIdx = items.firstIndex(where: { $0.id == id }) ?? 0
    let anchorAfter = (originalIdx + 1 < items.count) ? items[originalIdx + 1].id : nil
    let trimmed = newText.trimmingCharacters(in: .whitespacesAndNewlines)
    let kind = (trimmed.lowercased().hasPrefix("http://") || trimmed.lowercased().hasPrefix("https://"))
      && !trimmed.contains(where: { $0.isWhitespace || $0.isNewline }) ? "link" : "text"
    let source = (existing?.sourceApp.isEmpty == false) ? existing!.sourceApp : "Lumen"

    api.ingestText(newText, kind: kind, sourceApp: source) { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(var created):
        created.text = newText
        self.detailCache[created.id] = created
        if created.id != id {
          self.items.removeAll { $0.id == id }
          self.api.deleteItem(id: id) { _ in }
        }
        self.restoredOrderHints[created.id] = (anchorAfterID: anchorAfter, fallbackIndex: originalIdx)
        self.items.removeAll { $0.id == created.id }
        let targetIdx: Int
        if let anchorAfter, let pos = self.items.firstIndex(where: { $0.id == anchorAfter }) {
          targetIdx = pos
        } else {
          targetIdx = max(0, min(self.items.count, originalIdx))
        }
        self.items.insert(created, at: targetIdx)
        if existing?.pinned == true && !created.pinned {
          self.setPinned(id: created.id, pinned: true)
        }
        self.notify(.itemsUpdated)
        self.refreshStatus()
        completion(.success(created))
      case .failure(let err):
        completion(.failure(err))
      }
    }
  }

  /// Restores the last deleted clip to its original logical position (§3.4, §17.2, A09, A50).
  func undoLastDelete(completion: @escaping (Result<LumenClipboardItem, Error>) -> Void) {
    guard let entry = undoStack.popLast() else {
      completion(.failure(LumenClipboardAPIClient.APIError.invalidPayload))
      return
    }
    let source = entry.item.sourceApp.isEmpty ? "Lumen" : entry.item.sourceApp
    let handleRestore: (Result<LumenClipboardItem, Error>) -> Void = { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(var restored):
        if let text = entry.fullText, !text.isEmpty {
          restored.text = text
          self.detailCache[restored.id] = restored
        }
        if let imgData = entry.imageData {
          self.imagePayloadCache[restored.id] = imgData
        }
        self.recentlyRestoredIDs.insert(restored.id)
        self.restoredOrderHints[restored.id] = (anchorAfterID: entry.anchorAfterID, fallbackIndex: entry.originalIndex)
        self.items.removeAll { $0.id == restored.id }
        let targetIdx: Int
        if let afterID = entry.anchorAfterID,
           let anchorPos = self.items.firstIndex(where: { $0.id == afterID }) {
          targetIdx = anchorPos
        } else {
          targetIdx = max(0, min(self.items.count, entry.originalIndex))
        }
        self.items.insert(restored, at: targetIdx)
        if entry.item.pinned && !restored.pinned {
          self.setPinned(id: restored.id, pinned: true)
        }
        self.notify(.itemsUpdated)
        self.notify(.itemRestored(restored, logicalIndex: targetIdx))
        self.refreshStatus()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
          self?.recentlyRestoredIDs.remove(restored.id)
        }
        completion(.success(restored))
      case .failure(let err):
        completion(.failure(err))
      }
    }

    switch entry.item.kind {
    case "file" where !entry.item.files.isEmpty:
      api.ingestFiles(entry.item.files, sourceApp: source, completion: handleRestore)
    case "image":
      if let data = entry.imageData {
        api.ingestImage(data: data, mime: entry.item.mime, width: entry.item.width, height: entry.item.height, sourceApp: source, completion: handleRestore)
      } else {
        completion(.failure(LumenClipboardAPIClient.APIError.httpStatus(400, "图片原数据未缓存，无法撤销恢复")))
      }
    default:
      guard let body = entry.fullText, !body.isEmpty else {
        completion(.failure(LumenClipboardAPIClient.APIError.httpStatus(400, "该类型条目不支持撤销恢复")))
        return
      }
      api.ingestText(body, kind: entry.item.kind, sourceApp: source, completion: handleRestore)
    }
  }
}
