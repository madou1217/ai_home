import AppKit
import Foundation

// MARK: - Models

struct ClipboardItemModel: Decodable {
  let id: String
  let kind: String
  let mime: String?
  let preview: String?
  let thumbnailDataUrl: String?
  let files: [String]?
  let pinned: Bool?
  let createdAtMs: Int64?
  let lastSeenAtMs: Int64?
  let byteSize: Int64?
  let width: Int?
  let height: Int?

  var safeMime: String { mime ?? "" }
  var safePreview: String { preview ?? "" }
  var safeFiles: [String] { files ?? [] }
  var isPinned: Bool { pinned ?? false }
  var safeByteSize: Int64 { byteSize ?? 0 }
  var effectiveTimeMs: Int64 { lastSeenAtMs ?? createdAtMs ?? 0 }

  var kindLabel: String {
    switch kind {
    case "link": return "链接"
    case "image": return "图片"
    case "file": return "文件"
    default: return "文本"
    }
  }

  func thumbnailImage() -> NSImage? {
    guard let raw = thumbnailDataUrl, raw.hasPrefix("data:image/"),
          let markerRange = raw.range(of: ";base64,") else {
      return nil
    }
    let b64 = String(raw[markerRange.upperBound...])
    guard let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) else {
      return nil
    }
    return NSImage(data: data)
  }

  func matches(query lowercased: String) -> Bool {
    if lowercased.isEmpty { return true }
    if safePreview.lowercased().contains(lowercased) { return true }
    if kind.lowercased().contains(lowercased) { return true }
    if kindLabel.lowercased().contains(lowercased) { return true }
    for filePath in safeFiles {
      if filePath.lowercased().contains(lowercased) { return true }
    }
    return false
  }
}

private struct ClipboardItemsResponse: Decodable {
  let items: [ClipboardItemModel]?
}

// MARK: - Formatting Helpers

private func clipboardRelativeTime(_ tsMs: Int64, now: Date = Date()) -> String {
  guard tsMs > 0 else { return "-" }
  let date = Date(timeIntervalSince1970: Double(tsMs) / 1000.0)
  let delta = max(0, now.timeIntervalSince(date))
  if delta < 60 { return "刚刚" }
  if delta < 3600 { return "\(Int(delta / 60)) 分钟前" }
  let calendar = Calendar.current
  if calendar.isDateInToday(date) {
    return "\(Int(delta / 3600)) 小时前"
  }
  if calendar.isDateInYesterday(date) {
    return "昨天"
  }
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "zh_CN")
  let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
  formatter.dateFormat = sameYear ? "MM-dd" : "yyyy-MM-dd"
  return formatter.string(from: date)
}

private func clipboardFormatBytes(_ bytes: Int64) -> String {
  if bytes >= 1024 * 1024 {
    return String(format: "%.1f MiB", Double(bytes) / (1024.0 * 1024.0))
  }
  if bytes >= 1024 {
    return String(format: "%.1f KiB", Double(bytes) / 1024.0)
  }
  return "\(bytes) B"
}

private func clipboardIsPNG(_ data: Data) -> Bool {
  let magic: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
  guard data.count >= magic.count else { return false }
  return data.prefix(magic.count).elementsEqual(magic)
}

// MARK: - API Client

private enum ClipboardAPIError: LocalizedError {
  case notConfigured
  case invalidURL
  case httpError(Int)
  case emptyBody

  var errorDescription: String? {
    switch self {
    case .notConfigured: return "需要先在本机 Server 配置管理密钥"
    case .invalidURL: return "剪贴板服务地址无效"
    case .httpError(let code): return "请求失败 (HTTP \(code))"
    case .emptyBody: return "响应内容为空"
    }
  }
}

private final class ClipboardAPIClient {
  private var origin: String = ""
  private var managementKey: String = ""
  private let session: URLSession
  private var itemsTask: URLSessionDataTask?
  private var contentTask: URLSessionDataTask?

  init() {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 10
    config.timeoutIntervalForResource = 10
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    self.session = URLSession(configuration: config)
  }

  deinit {
    session.invalidateAndCancel()
  }

  var isConfigured: Bool {
    !origin.isEmpty && !managementKey.isEmpty
  }

  func configure(origin nextOrigin: String, managementKey nextKey: String) {
    origin = nextOrigin
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    managementKey = nextKey.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  func fetchItems(limit: Int = 50, completion: @escaping (Result<[ClipboardItemModel], Error>) -> Void) {
    itemsTask?.cancel()
    guard isConfigured else {
      DispatchQueue.main.async { completion(.failure(ClipboardAPIError.notConfigured)) }
      return
    }
    guard let url = URL(string: "\(origin)/v1/management/webui/clipboard/items?limit=\(limit)") else {
      DispatchQueue.main.async { completion(.failure(ClipboardAPIError.invalidURL)) }
      return
    }
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.setValue("Bearer \(managementKey)", forHTTPHeaderField: "Authorization")

    let task = session.dataTask(with: request) { data, response, error in
      if let urlError = error as? URLError, urlError.code == .cancelled {
        return
      }
      if let error = error {
        DispatchQueue.main.async { completion(.failure(error)) }
        return
      }
      if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
        DispatchQueue.main.async { completion(.failure(ClipboardAPIError.httpError(http.statusCode))) }
        return
      }
      guard let data = data else {
        DispatchQueue.main.async { completion(.failure(ClipboardAPIError.emptyBody)) }
        return
      }
      do {
        let decoded = try JSONDecoder().decode(ClipboardItemsResponse.self, from: data)
        let list = decoded.items ?? []
        DispatchQueue.main.async { completion(.success(list)) }
      } catch {
        DispatchQueue.main.async { completion(.failure(error)) }
      }
    }
    itemsTask = task
    task.resume()
  }

  func fetchContent(id: String, cancelPrevious: Bool = true, completion: @escaping (Result<Data, Error>) -> Void) {
    if cancelPrevious {
      contentTask?.cancel()
    }
    guard isConfigured else {
      DispatchQueue.main.async { completion(.failure(ClipboardAPIError.notConfigured)) }
      return
    }
    let encodedID = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
    guard let url = URL(string: "\(origin)/v1/management/webui/clipboard/items/\(encodedID)/content") else {
      DispatchQueue.main.async { completion(.failure(ClipboardAPIError.invalidURL)) }
      return
    }
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.setValue("Bearer \(managementKey)", forHTTPHeaderField: "Authorization")

    let task = session.dataTask(with: request) { data, response, error in
      if let urlError = error as? URLError, urlError.code == .cancelled {
        return
      }
      if let error = error {
        DispatchQueue.main.async { completion(.failure(error)) }
        return
      }
      if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
        DispatchQueue.main.async { completion(.failure(ClipboardAPIError.httpError(http.statusCode))) }
        return
      }
      DispatchQueue.main.async { completion(.success(data ?? Data())) }
    }
    if cancelPrevious {
      contentTask = task
    }
    task.resume()
  }
}

// MARK: - Flipped Clip View

private final class ClipboardFlippedClipView: NSClipView {
  override var isFlipped: Bool { true }
}

// MARK: - Preview View

final class ClipboardPreviewView: NSView {
  var onCopy: (() -> Void)?

  private let metaLabel = NSTextField(labelWithString: "")
  private let copyButton = NSButton(title: "复制", target: nil, action: nil)
  private let divider = NSBox()
  private let emptyLabel = NSTextField(labelWithString: "选择左侧条目查看预览")
  private let noteLabel = NSTextField(labelWithString: "")

  private let textScrollView: NSScrollView
  private let textView: NSTextView

  private let imageView = NSImageView()

  private let fileScrollView = NSScrollView()
  private let fileStackView = NSStackView()

  override init(frame frameRect: NSRect) {
    let scroll = NSTextView.scrollableTextView()
    self.textScrollView = scroll
    self.textView = (scroll.documentView as? NSTextView) ?? NSTextView(frame: NSRect(x: 0, y: 0, width: 420, height: 360))
    super.init(frame: frameRect)
    buildUI()
  }

  required init?(coder: NSCoder) {
    let scroll = NSTextView.scrollableTextView()
    self.textScrollView = scroll
    self.textView = (scroll.documentView as? NSTextView) ?? NSTextView(frame: NSRect(x: 0, y: 0, width: 420, height: 360))
    super.init(coder: coder)
    buildUI()
  }

  private func buildUI() {
    wantsLayer = true

    metaLabel.font = NSFont.systemFont(ofSize: 12, weight: .regular)
    metaLabel.textColor = .secondaryLabelColor
    metaLabel.lineBreakMode = .byTruncatingTail
    metaLabel.maximumNumberOfLines = 1
    metaLabel.translatesAutoresizingMaskIntoConstraints = false
    metaLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    copyButton.bezelStyle = .rounded
    copyButton.controlSize = .small
    copyButton.target = self
    copyButton.action = #selector(copyButtonClicked(_:))
    copyButton.translatesAutoresizingMaskIntoConstraints = false
    copyButton.isEnabled = false

    divider.boxType = .separator
    divider.translatesAutoresizingMaskIntoConstraints = false

    emptyLabel.font = NSFont.systemFont(ofSize: 13, weight: .regular)
    emptyLabel.textColor = .secondaryLabelColor
    emptyLabel.alignment = .center
    emptyLabel.translatesAutoresizingMaskIntoConstraints = false

    noteLabel.font = NSFont.systemFont(ofSize: 11, weight: .regular)
    noteLabel.textColor = .secondaryLabelColor
    noteLabel.lineBreakMode = .byTruncatingTail
    noteLabel.maximumNumberOfLines = 1
    noteLabel.translatesAutoresizingMaskIntoConstraints = false
    noteLabel.isHidden = true

    // Text preview
    textView.isEditable = false
    textView.isSelectable = true
    textView.isRichText = false
    textView.drawsBackground = true
    textView.backgroundColor = .textBackgroundColor
    textView.textColor = .labelColor
    textView.font = NSFont.monospacedSystemFont(ofSize: 12.5, weight: .regular)
    textView.textContainerInset = NSSize(width: 10, height: 10)
    textView.isVerticallyResizable = true
    textView.isHorizontallyResizable = false
    textView.autoresizingMask = [.width]
    textView.textContainer?.widthTracksTextView = true
    textView.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)

    textScrollView.documentView = textView
    textScrollView.hasVerticalScroller = true
    textScrollView.hasHorizontalScroller = false
    textScrollView.borderType = .bezelBorder
    textScrollView.translatesAutoresizingMaskIntoConstraints = false
    textScrollView.isHidden = true

    // Image preview
    imageView.imageScaling = .scaleProportionallyDown
    imageView.imageAlignment = .alignCenter
    imageView.imageFrameStyle = .grayBezel
    imageView.translatesAutoresizingMaskIntoConstraints = false
    imageView.isHidden = true

    // File list preview (NSTextField list inside flipped scroll view)
    fileScrollView.contentView = ClipboardFlippedClipView()
    fileStackView.orientation = .vertical
    fileStackView.alignment = .leading
    fileStackView.spacing = 6
    fileStackView.edgeInsets = NSEdgeInsets(top: 10, left: 10, bottom: 10, right: 10)
    fileStackView.translatesAutoresizingMaskIntoConstraints = false

    fileScrollView.documentView = fileStackView
    fileScrollView.hasVerticalScroller = true
    fileScrollView.hasHorizontalScroller = false
    fileScrollView.borderType = .bezelBorder
    fileScrollView.drawsBackground = true
    fileScrollView.backgroundColor = .textBackgroundColor
    fileScrollView.translatesAutoresizingMaskIntoConstraints = false
    fileScrollView.isHidden = true

    addSubview(metaLabel)
    addSubview(copyButton)
    addSubview(divider)
    addSubview(emptyLabel)
    addSubview(textScrollView)
    addSubview(imageView)
    addSubview(fileScrollView)
    addSubview(noteLabel)

    NSLayoutConstraint.activate([
      metaLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
      metaLabel.centerYAnchor.constraint(equalTo: copyButton.centerYAnchor),
      metaLabel.trailingAnchor.constraint(lessThanOrEqualTo: copyButton.leadingAnchor, constant: -8),

      copyButton.topAnchor.constraint(equalTo: topAnchor, constant: 10),
      copyButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),

      divider.topAnchor.constraint(equalTo: copyButton.bottomAnchor, constant: 10),
      divider.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
      divider.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),

      emptyLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
      emptyLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
      emptyLabel.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 16),
      emptyLabel.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -16),

      textScrollView.topAnchor.constraint(equalTo: divider.bottomAnchor, constant: 10),
      textScrollView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
      textScrollView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      textScrollView.bottomAnchor.constraint(equalTo: noteLabel.topAnchor, constant: -6),

      imageView.topAnchor.constraint(equalTo: divider.bottomAnchor, constant: 10),
      imageView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
      imageView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      imageView.bottomAnchor.constraint(equalTo: noteLabel.topAnchor, constant: -6),

      fileScrollView.topAnchor.constraint(equalTo: divider.bottomAnchor, constant: 10),
      fileScrollView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
      fileScrollView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      fileScrollView.bottomAnchor.constraint(equalTo: noteLabel.topAnchor, constant: -6),

      fileStackView.topAnchor.constraint(equalTo: fileScrollView.contentView.topAnchor),
      fileStackView.leadingAnchor.constraint(equalTo: fileScrollView.contentView.leadingAnchor),
      fileStackView.trailingAnchor.constraint(equalTo: fileScrollView.contentView.trailingAnchor),

      noteLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
      noteLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      noteLabel.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
      noteLabel.heightAnchor.constraint(equalToConstant: 16)
    ])
  }

  @objc private func copyButtonClicked(_ sender: Any?) {
    onCopy?()
  }

  private func hideContentViews() {
    emptyLabel.isHidden = true
    textScrollView.isHidden = true
    imageView.isHidden = true
    fileScrollView.isHidden = true
    noteLabel.isHidden = true
  }

  private func updateMeta(for item: ClipboardItemModel) {
    var parts = [item.kindLabel, clipboardFormatBytes(item.safeByteSize)]
    if item.kind == "image", let w = item.width, let h = item.height, w > 0, h > 0 {
      parts.append("\(w)×\(h)")
    }
    parts.append(clipboardRelativeTime(item.effectiveTimeMs))
    if item.isPinned {
      parts.append("已置顶")
    }
    metaLabel.stringValue = parts.joined(separator: " · ")
  }

  func showEmpty(_ message: String) {
    hideContentViews()
    metaLabel.stringValue = ""
    copyButton.isEnabled = false
    emptyLabel.stringValue = message
    emptyLabel.isHidden = false
  }

  func showText(_ text: String, for item: ClipboardItemModel, note: String? = nil) {
    hideContentViews()
    updateMeta(for: item)
    copyButton.isEnabled = true
    textView.string = text
    textView.scrollToBeginningOfDocument(nil)
    textScrollView.isHidden = false
    if let note = note, !note.isEmpty {
      noteLabel.stringValue = note
      noteLabel.isHidden = false
    }
  }

  func showImage(_ image: NSImage?, for item: ClipboardItemModel, note: String? = nil) {
    hideContentViews()
    updateMeta(for: item)
    copyButton.isEnabled = true
    imageView.image = image
    if image != nil {
      imageView.isHidden = false
    } else {
      emptyLabel.stringValue = note ?? "正在加载图片..."
      emptyLabel.isHidden = false
    }
    if let note = note, !note.isEmpty, image != nil {
      noteLabel.stringValue = note
      noteLabel.isHidden = false
    }
  }

  func showFiles(_ files: [String], for item: ClipboardItemModel) {
    hideContentViews()
    updateMeta(for: item)
    copyButton.isEnabled = !files.isEmpty
    for arranged in fileStackView.arrangedSubviews {
      fileStackView.removeArrangedSubview(arranged)
      arranged.removeFromSuperview()
    }
    if files.isEmpty {
      emptyLabel.stringValue = "无文件路径"
      emptyLabel.isHidden = false
      return
    }
    for path in files {
      let field = NSTextField(wrappingLabelWithString: path)
      field.isSelectable = true
      field.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
      field.textColor = .labelColor
      field.translatesAutoresizingMaskIntoConstraints = false
      fileStackView.addArrangedSubview(field)
      field.widthAnchor.constraint(lessThanOrEqualTo: fileStackView.widthAnchor, constant: -20).isActive = true
    }
    fileScrollView.isHidden = false
  }
}

// MARK: - Host Panel (Keyboard Routing)

private final class ClipboardHostPanel: NSPanel {
  var onKeyEvent: ((NSEvent) -> Bool)?

  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }

  override func sendEvent(_ event: NSEvent) {
    if event.type == .keyDown, let handler = onKeyEvent, handler(event) {
      return
    }
    super.sendEvent(event)
  }

  override func cancelOperation(_ sender: Any?) {
    orderOut(nil)
  }
}

// MARK: - Row Cell

private final class ClipboardRowCellView: NSTableCellView {
  private let kindBadge = NSTextField(labelWithString: "")
  private let pinBadge = NSTextField(labelWithString: "★")
  private let timeLabel = NSTextField(labelWithString: "")
  private let previewLabel = NSTextField(labelWithString: "")
  private let thumbView = NSImageView()
  private var thumbWidthConstraint: NSLayoutConstraint?

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    buildUI()
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    buildUI()
  }

  private func buildUI() {
    kindBadge.font = NSFont.systemFont(ofSize: 11, weight: .medium)
    kindBadge.textColor = .secondaryLabelColor
    kindBadge.translatesAutoresizingMaskIntoConstraints = false

    pinBadge.font = NSFont.systemFont(ofSize: 11, weight: .regular)
    pinBadge.textColor = .systemOrange
    pinBadge.translatesAutoresizingMaskIntoConstraints = false
    pinBadge.isHidden = true

    timeLabel.font = NSFont.systemFont(ofSize: 11, weight: .regular)
    timeLabel.textColor = .tertiaryLabelColor
    timeLabel.alignment = .right
    timeLabel.translatesAutoresizingMaskIntoConstraints = false

    previewLabel.font = NSFont.systemFont(ofSize: 12.5, weight: .regular)
    previewLabel.textColor = .labelColor
    previewLabel.lineBreakMode = .byTruncatingTail
    previewLabel.maximumNumberOfLines = 1
    previewLabel.translatesAutoresizingMaskIntoConstraints = false
    previewLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    thumbView.imageScaling = .scaleProportionallyUpOrDown
    thumbView.wantsLayer = true
    thumbView.layer?.cornerRadius = 3
    thumbView.layer?.masksToBounds = true
    thumbView.translatesAutoresizingMaskIntoConstraints = false
    thumbView.isHidden = true

    addSubview(thumbView)
    addSubview(kindBadge)
    addSubview(pinBadge)
    addSubview(timeLabel)
    addSubview(previewLabel)

    let thumbW = thumbView.widthAnchor.constraint(equalToConstant: 0)
    thumbWidthConstraint = thumbW

    NSLayoutConstraint.activate([
      thumbView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
      thumbView.centerYAnchor.constraint(equalTo: centerYAnchor),
      thumbView.heightAnchor.constraint(equalToConstant: 32),
      thumbW,

      kindBadge.topAnchor.constraint(equalTo: topAnchor, constant: 6),
      kindBadge.leadingAnchor.constraint(equalTo: thumbView.trailingAnchor, constant: 6),

      pinBadge.centerYAnchor.constraint(equalTo: kindBadge.centerYAnchor),
      pinBadge.leadingAnchor.constraint(equalTo: kindBadge.trailingAnchor, constant: 4),

      timeLabel.centerYAnchor.constraint(equalTo: kindBadge.centerYAnchor),
      timeLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
      timeLabel.leadingAnchor.constraint(greaterThanOrEqualTo: pinBadge.trailingAnchor, constant: 6),

      previewLabel.topAnchor.constraint(equalTo: kindBadge.bottomAnchor, constant: 4),
      previewLabel.leadingAnchor.constraint(equalTo: thumbView.trailingAnchor, constant: 6),
      previewLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8)
    ])
  }

  func configure(with item: ClipboardItemModel, thumbnail: NSImage?, now: Date) {
    kindBadge.stringValue = item.kindLabel
    pinBadge.isHidden = !item.isPinned
    timeLabel.stringValue = clipboardRelativeTime(item.effectiveTimeMs, now: now)
    previewLabel.stringValue = item.safePreview.isEmpty ? "(\(item.kindLabel))" : item.safePreview

    if let thumb = thumbnail {
      thumbView.image = thumb
      thumbView.isHidden = false
      thumbWidthConstraint?.constant = 32
    } else {
      thumbView.image = nil
      thumbView.isHidden = true
      thumbWidthConstraint?.constant = 0
    }
  }
}

// MARK: - Main Clipboard Panel Controller

final class ClipboardPanel: NSObject, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate {
  private static let autosaveName = "AIHClipboardPanel"
  private static let cellIdentifier = NSUserInterfaceItemIdentifier("ClipboardItemCell")

  private let panel: ClipboardHostPanel
  private let api = ClipboardAPIClient()

  private let searchField = NSSearchField()
  private let reloadButton = NSButton(title: "刷新", target: nil, action: nil)
  private let statusLabel = NSTextField(labelWithString: "")
  private let topDivider = NSBox()
  private let columnDivider = NSBox()

  private let listScrollView = NSScrollView()
  private let tableView = NSTableView()
  private let previewView = ClipboardPreviewView()

  private var allItems: [ClipboardItemModel] = []
  private var filteredItems: [ClipboardItemModel] = []
  private var thumbnailCache: [String: NSImage] = [:]
  private var contentCache: [String: Data] = [:]
  private var currentPreviewID: String = ""

  override init() {
    panel = ClipboardHostPanel(
      contentRect: NSRect(x: 0, y: 0, width: 760, height: 560),
      styleMask: [.titled, .closable, .resizable, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    super.init()
    configureWindow()
    buildLayout()
  }

  private func configureWindow() {
    panel.title = "AIH 剪贴板"
    panel.titleVisibility = .visible
    panel.titlebarAppearsTransparent = false
    panel.level = .floating
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.minSize = NSSize(width: 520, height: 380)
    panel.setFrameAutosaveName(Self.autosaveName)
    panel.delegate = self
    panel.onKeyEvent = { [weak self] event in
      self?.handleKeyDown(event) ?? false
    }
  }

  private func buildLayout() {
    guard let contentView = panel.contentView else { return }

    searchField.placeholderString = "搜索剪贴板历史..."
    searchField.delegate = self
    searchField.target = self
    searchField.action = #selector(searchFieldAction(_:))
    searchField.translatesAutoresizingMaskIntoConstraints = false

    reloadButton.bezelStyle = .rounded
    reloadButton.controlSize = .small
    reloadButton.target = self
    reloadButton.action = #selector(reloadClicked(_:))
    reloadButton.translatesAutoresizingMaskIntoConstraints = false

    statusLabel.font = NSFont.systemFont(ofSize: 11.5, weight: .regular)
    statusLabel.textColor = .secondaryLabelColor
    statusLabel.lineBreakMode = .byTruncatingTail
    statusLabel.maximumNumberOfLines = 1
    statusLabel.translatesAutoresizingMaskIntoConstraints = false
    statusLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    topDivider.boxType = .separator
    topDivider.translatesAutoresizingMaskIntoConstraints = false

    columnDivider.boxType = .separator
    columnDivider.translatesAutoresizingMaskIntoConstraints = false

    let column = NSTableColumn(identifier: Self.cellIdentifier)
    column.width = 278
    column.resizingMask = .autoresizingMask
    tableView.addTableColumn(column)
    tableView.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
    tableView.headerView = nil
    tableView.rowHeight = 52
    tableView.intercellSpacing = NSSize(width: 0, height: 2)
    tableView.selectionHighlightStyle = .regular
    tableView.usesAlternatingRowBackgroundColors = false
    tableView.dataSource = self
    tableView.delegate = self
    tableView.target = self
    tableView.doubleAction = #selector(tableDoubleClicked(_:))

    listScrollView.documentView = tableView
    listScrollView.hasVerticalScroller = true
    listScrollView.hasHorizontalScroller = false
    listScrollView.borderType = .noBorder
    listScrollView.drawsBackground = true
    listScrollView.backgroundColor = .controlBackgroundColor
    listScrollView.translatesAutoresizingMaskIntoConstraints = false

    previewView.translatesAutoresizingMaskIntoConstraints = false
    previewView.onCopy = { [weak self] in
      self?.copySelected(closeAfter: false)
    }

    contentView.addSubview(searchField)
    contentView.addSubview(reloadButton)
    contentView.addSubview(statusLabel)
    contentView.addSubview(topDivider)
    contentView.addSubview(listScrollView)
    contentView.addSubview(columnDivider)
    contentView.addSubview(previewView)

    NSLayoutConstraint.activate([
      searchField.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 10),
      searchField.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 12),
      searchField.widthAnchor.constraint(equalToConstant: 268),

      reloadButton.centerYAnchor.constraint(equalTo: searchField.centerYAnchor),
      reloadButton.leadingAnchor.constraint(equalTo: searchField.trailingAnchor, constant: 10),

      statusLabel.centerYAnchor.constraint(equalTo: searchField.centerYAnchor),
      statusLabel.leadingAnchor.constraint(equalTo: reloadButton.trailingAnchor, constant: 10),
      statusLabel.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -12),

      topDivider.topAnchor.constraint(equalTo: searchField.bottomAnchor, constant: 10),
      topDivider.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
      topDivider.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),

      listScrollView.topAnchor.constraint(equalTo: topDivider.bottomAnchor),
      listScrollView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
      listScrollView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
      listScrollView.widthAnchor.constraint(equalToConstant: 280),

      columnDivider.topAnchor.constraint(equalTo: topDivider.bottomAnchor),
      columnDivider.leadingAnchor.constraint(equalTo: listScrollView.trailingAnchor),
      columnDivider.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
      columnDivider.widthAnchor.constraint(equalToConstant: 1),

      previewView.topAnchor.constraint(equalTo: topDivider.bottomAnchor),
      previewView.leadingAnchor.constraint(equalTo: columnDivider.trailingAnchor),
      previewView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
      previewView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor)
    ])

    previewView.showEmpty("选择左侧条目查看预览")
  }

  // MARK: - Public Interface

  func configure(origin: String, managementKey: String) {
    api.configure(origin: origin, managementKey: managementKey)
    if panel.isVisible {
      reload()
    }
  }

  func toggle() {
    if panel.isVisible && panel.isKeyWindow {
      panel.orderOut(nil)
    } else {
      showAndReload()
    }
  }

  func closeIfKey() -> Bool {
    guard panel.isVisible && panel.isKeyWindow else { return false }
    panel.orderOut(nil)
    return true
  }

  func hide() {
    panel.orderOut(nil)
  }

  private func showAndReload() {
    if !panel.isVisible && !panel.setFrameUsingName(Self.autosaveName) {
      panel.center()
    }
    panel.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    panel.makeFirstResponder(searchField)
    reload()
  }

  // MARK: - Data Loading & Filtering

  private func setStatus(_ text: String, isError: Bool = false) {
    statusLabel.stringValue = text
    statusLabel.textColor = isError ? .systemRed : .secondaryLabelColor
  }

  private func reload() {
    guard api.isConfigured else {
      allItems = []
      filteredItems = []
      thumbnailCache = [:]
      contentCache = [:]
      currentPreviewID = ""
      tableView.reloadData()
      setStatus("需要先在本机 Server 配置管理密钥", isError: true)
      previewView.showEmpty("需要先在本机 Server 配置管理密钥")
      return
    }
    setStatus("正在加载...")
    api.fetchItems(limit: 50) { [weak self] result in
      guard let self = self else { return }
      switch result {
      case .success(let items):
        self.allItems = items
        self.contentCache = [:]
        var nextThumbs: [String: NSImage] = [:]
        for item in items {
          if let thumb = item.thumbnailImage() {
            nextThumbs[item.id] = thumb
          }
        }
        self.thumbnailCache = nextThumbs
        self.applyFilter(preservingID: self.selectedItem()?.id)
        self.setStatus("共 \(items.count) 条")
      case .failure(let error):
        self.setStatus(error.localizedDescription, isError: true)
      }
    }
  }

  private func applyFilter(preservingID preferredID: String?) {
    let query = searchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if query.isEmpty {
      filteredItems = allItems
    } else {
      filteredItems = allItems.filter { $0.matches(query: query) }
    }
    tableView.reloadData()

    guard !filteredItems.isEmpty else {
      currentPreviewID = ""
      previewView.showEmpty(allItems.isEmpty ? "暂无剪贴板记录" : "无匹配条目")
      return
    }

    var targetRow = 0
    if let preferredID = preferredID,
       let idx = filteredItems.firstIndex(where: { $0.id == preferredID }) {
      targetRow = idx
    }
    tableView.selectRowIndexes(IndexSet(integer: targetRow), byExtendingSelection: false)
    tableView.scrollRowToVisible(targetRow)
    updatePreviewForSelection()
  }

  private func selectedItem() -> ClipboardItemModel? {
    let row = tableView.selectedRow
    guard row >= 0 && row < filteredItems.count else { return nil }
    return filteredItems[row]
  }

  private func updatePreviewForSelection() {
    guard let item = selectedItem() else {
      currentPreviewID = ""
      previewView.showEmpty("选择左侧条目查看预览")
      return
    }
    currentPreviewID = item.id

    if item.kind == "file" {
      previewView.showFiles(item.safeFiles, for: item)
      return
    }

    if let cached = contentCache[item.id] {
      renderLoadedContent(cached, for: item)
      return
    }

    if item.kind == "image" {
      previewView.showImage(thumbnailCache[item.id], for: item, note: "正在加载原图...")
    } else {
      previewView.showText(item.safePreview, for: item, note: "正在加载完整内容...")
    }

    let expectedID = item.id
    api.fetchContent(id: expectedID, cancelPrevious: true) { [weak self] result in
      guard let self = self, self.currentPreviewID == expectedID else { return }
      switch result {
      case .success(let data):
        self.contentCache[expectedID] = data
        self.renderLoadedContent(data, for: item)
      case .failure(let error):
        if item.kind == "image" {
          self.previewView.showImage(self.thumbnailCache[expectedID], for: item, note: error.localizedDescription)
        } else {
          self.previewView.showText(item.safePreview, for: item, note: error.localizedDescription)
        }
      }
    }
  }

  private func renderLoadedContent(_ data: Data, for item: ClipboardItemModel) {
    if item.kind == "image" {
      let image = NSImage(data: data) ?? thumbnailCache[item.id]
      previewView.showImage(image, for: item, note: image == nil ? "无法解码图片" : nil)
    } else {
      let text = String(data: data, encoding: .utf8) ?? item.safePreview
      previewView.showText(text, for: item)
    }
  }

  // MARK: - Copy to Pasteboard

  private func copySelected(closeAfter: Bool) {
    guard let item = selectedItem() else { return }
    if item.kind == "file" {
      let joined = item.safeFiles.joined(separator: "\n")
      guard !joined.isEmpty else { return }
      writeStringToPasteboard(joined)
      finishCopy(closeAfter: closeAfter)
      return
    }
    if let cached = contentCache[item.id] {
      writePayloadToPasteboard(item: item, data: cached)
      finishCopy(closeAfter: closeAfter)
      return
    }
    setStatus("正在复制...")
    api.fetchContent(id: item.id, cancelPrevious: false) { [weak self] result in
      guard let self = self else { return }
      switch result {
      case .success(let data):
        self.contentCache[item.id] = data
        self.writePayloadToPasteboard(item: item, data: data)
        self.finishCopy(closeAfter: closeAfter)
      case .failure(let error):
        if item.kind != "image" && !item.safePreview.isEmpty {
          self.writeStringToPasteboard(item.safePreview)
          self.finishCopy(closeAfter: closeAfter)
        } else {
          self.setStatus("复制失败：\(error.localizedDescription)", isError: true)
        }
      }
    }
  }

  private func writeStringToPasteboard(_ text: String) {
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setString(text, forType: .string)
  }

  private func writePayloadToPasteboard(item: ClipboardItemModel, data: Data) {
    let pb = NSPasteboard.general
    pb.clearContents()
    if item.kind == "image" {
      if clipboardIsPNG(data) {
        pb.setData(data, forType: .png)
      } else if let img = NSImage(data: data), let tiff = img.tiffRepresentation {
        pb.setData(tiff, forType: .tiff)
      } else {
        pb.setData(data, forType: .png)
      }
      return
    }
    let text = String(data: data, encoding: .utf8) ?? item.safePreview
    pb.setString(text, forType: .string)
  }

  private func finishCopy(closeAfter: Bool) {
    setStatus("已复制")
    if closeAfter {
      panel.orderOut(nil)
    }
  }

  // MARK: - Keyboard & Actions

  private func handleKeyDown(_ event: NSEvent) -> Bool {
    let mods = event.modifierFlags.intersection([.command, .option, .control, .shift])
    // Cmd-R reloads list.
    if event.keyCode == 15 && mods == [.command] {
      reload()
      return true
    }
    // Esc closes panel.
    if event.keyCode == 53 && mods.isEmpty {
      panel.orderOut(nil)
      return true
    }
    // Up / Down navigate table rows even while search field has focus.
    if event.keyCode == 126 && mods.isEmpty {
      moveSelection(delta: -1)
      return true
    }
    if event.keyCode == 125 && mods.isEmpty {
      moveSelection(delta: 1)
      return true
    }
    // Enter / Numpad Enter copies selected item and closes.
    if (event.keyCode == 36 || event.keyCode == 76) && mods.isEmpty {
      if selectedItem() != nil {
        copySelected(closeAfter: true)
      }
      return true
    }
    return false
  }

  private func moveSelection(delta: Int) {
    guard !filteredItems.isEmpty else { return }
    let current = tableView.selectedRow
    let base = current < 0 ? 0 : current
    let next = max(0, min(filteredItems.count - 1, base + delta))
    guard next != current else { return }
    tableView.selectRowIndexes(IndexSet(integer: next), byExtendingSelection: false)
    tableView.scrollRowToVisible(next)
    updatePreviewForSelection()
  }

  @objc private func reloadClicked(_ sender: Any?) {
    reload()
  }

  @objc private func searchFieldAction(_ sender: Any?) {
    applyFilter(preservingID: selectedItem()?.id)
  }

  @objc private func tableDoubleClicked(_ sender: Any?) {
    if selectedItem() != nil {
      copySelected(closeAfter: true)
    }
  }

  // MARK: - NSSearchFieldDelegate

  func controlTextDidChange(_ obj: Notification) {
    applyFilter(preservingID: selectedItem()?.id)
  }

  // MARK: - NSTableViewDataSource & NSTableViewDelegate

  func numberOfRows(in tableView: NSTableView) -> Int {
    filteredItems.count
  }

  func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
    guard row >= 0 && row < filteredItems.count else { return nil }
    let item = filteredItems[row]
    let cell: ClipboardRowCellView
    if let reused = tableView.makeView(withIdentifier: Self.cellIdentifier, owner: self) as? ClipboardRowCellView {
      cell = reused
    } else {
      cell = ClipboardRowCellView()
      cell.identifier = Self.cellIdentifier
    }
    cell.configure(with: item, thumbnail: thumbnailCache[item.id], now: Date())
    return cell
  }

  func tableViewSelectionDidChange(_ notification: Notification) {
    updatePreviewForSelection()
  }

  // MARK: - NSWindowDelegate

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    panel.orderOut(nil)
    return false
  }
}
