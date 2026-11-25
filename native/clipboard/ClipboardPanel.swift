import AppKit
import Foundation

/// Native clipboard history panel backed by the local AIH Server management API.
/// Capture, de-duplication, storage and encrypted sync stay in the Go runtime;
/// this panel is the desktop face of the same data the WebUI shows.
final class ClipboardPanel: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate, NSSplitViewDelegate, NSWindowDelegate {
  private let emit: ([String: Any]) -> Void
  let panel = ClipboardHostPanel(
    contentRect: NSRect(x: 0, y: 0, width: 860, height: 600),
    styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel],
    backing: .buffered,
    defer: false
  )

  private let background = ClipboardBackdropView()
  private let brackets = ClipboardBracketView()
  private let headerIcon = ClipboardGlyphTile()
  private let eyebrowLabel = NSTextField(labelWithString: "PASTE // NEXUS")
  private let titleLabel = NSTextField(labelWithString: "剪贴板")
  private let subtitleLabel = NSTextField(labelWithString: "")
  private let searchField = NSSearchField()
  private let filter = NSSegmentedControl(labels: ["全部", "文本", "链接", "图片", "文件"], trackingMode: .selectOne, target: nil, action: nil)
  private let splitView = NSSplitView()
  private let tableScroll = NSScrollView()
  private let tableView = ClipboardPanelTableView()
  private let preview = ClipboardPanelPreview()
  private let footerSeparator = NSBox()
  private let hintsLabel = NSTextField(labelWithString: "↑↓ 选择    ↵ 粘贴    ⌘P 置顶    ⌘⌫ 删除    esc 关闭")
  private let statusLabel = NSTextField(labelWithString: "")

  private var origin = ""
  private var managementKey = ""
  private var enabled = false

  private var rows: [ClipboardPanelRow] = []
  private var visibleRows: [ClipboardPanelRow] = []
  private var selectedID = ""
  private let contentCache: NSCache<NSString, NSData> = {
    let cache = NSCache<NSString, NSData>()
    cache.totalCostLimit = 32 * 1024 * 1024
    return cache
  }()
  private var previewGeneration = 0
  private var listGeneration = 0
  private var firstShow = true
  private var suppressSelectionPreview = false

  init(emit: @escaping ([String: Any]) -> Void) {
    self.emit = emit
    super.init()
    panel.title = "AIH 剪贴板"
    panel.appearance = NSAppearance(named: .darkAqua)
    panel.titleVisibility = .hidden
    panel.titlebarAppearsTransparent = true
    panel.isMovableByWindowBackground = true
    panel.delegate = self
    panel.level = .floating
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.minSize = NSSize(width: 640, height: 420)
    panel.setFrameAutosaveName("AIHClipboardPanel")
    panel.onKeyEvent = { [weak self] event in self?.handleTableKey(event) ?? false }
    buildContent()
  }

  // MARK: Configuration

  func configure(origin nextOrigin: String, managementKey nextKey: String, enabled nextEnabled: Bool) {
    let normalized = nextOrigin.trimmingCharacters(in: .whitespacesAndNewlines)
      .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let changed = normalized != origin || nextKey != managementKey
    origin = normalized
    managementKey = nextKey
    enabled = nextEnabled
    updateSubtitle()
    if !nextEnabled { hide() }
    if changed {
      contentCache.removeAllObjects()
      if panel.isVisible {
        rows = []
        selectedID = ""
        reloadList()
      }
    }
  }

  var isAvailable: Bool { enabled && !origin.isEmpty && !managementKey.isEmpty }

  // MARK: Visibility

  func toggle() {
    if panel.isVisible { hide() } else { show() }
  }

  func show() {
    if firstShow {
      firstShow = false
      if !panel.setFrameUsingName("AIHClipboardPanel") { panel.center() }
    }
    searchField.stringValue = ""
    filter.selectedSegment = 0
    applyFilter()
    reloadList()
    panel.makeKeyAndOrderFront(nil)
    panel.orderFrontRegardless()
    NSApp.activate(ignoringOtherApps: true)
    _ = NSRunningApplication.current.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    panel.layoutIfNeeded()
    if splitView.arrangedSubviews.count > 1, splitView.arrangedSubviews[0].frame.width < 200 {
      splitView.setPosition(340, ofDividerAt: 0)
    }
    panel.makeFirstResponder(searchField)  }

  func hide() {
    panel.orderOut(nil)
  }

  /// Called from the global key monitor: only claims Escape when this panel is key.
  func closeIfKey() -> Bool {
    guard panel.isKeyWindow else { return false }
    hide()
    return true
  }

  // MARK: Layout

  private func buildContent() {
    background.appearance = NSAppearance(named: .darkAqua)
    panel.backgroundColor = NSColor(srgbRed: 0.031, green: 0.043, blue: 0.082, alpha: 1)
    panel.contentView = background

    headerIcon.apply(symbol: "doc.on.clipboard.fill", tint: .controlAccentColor)
    headerIcon.layer?.cornerRadius = 8
    eyebrowLabel.font = .monospacedSystemFont(ofSize: 9, weight: .medium)
    eyebrowLabel.textColor = NSColor(srgbRed: 0.384, green: 0.929, blue: 1, alpha: 0.9)
    titleLabel.font = .systemFont(ofSize: 16, weight: .semibold)
    titleLabel.textColor = NSColor(srgbRed: 0.91, green: 0.93, blue: 0.97, alpha: 1)
    subtitleLabel.font = .systemFont(ofSize: 11)
    subtitleLabel.textColor = NSColor(srgbRed: 0.52, green: 0.58, blue: 0.68, alpha: 1)

    searchField.placeholderString = "搜索剪贴板…"
    searchField.delegate = self
    searchField.sendsWholeSearchString = false
    searchField.sendsSearchStringImmediately = true
    searchField.controlSize = .large

    filter.target = self
    filter.action = #selector(filterChanged)
    filter.selectedSegment = 0
    filter.controlSize = .small

    let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("main"))
    column.width = 300
    tableView.addTableColumn(column)
    tableView.headerView = nil
    tableView.rowHeight = 58
    tableView.intercellSpacing = NSSize(width: 0, height: 2)
    tableView.style = .plain
    tableView.allowsMultipleSelection = false
    tableView.selectionHighlightStyle = .none
    tableView.backgroundColor = .clear
    tableView.focusRingType = .none
    tableView.dataSource = self
    tableView.delegate = self
    tableView.target = self
    tableView.doubleAction = #selector(handleDoubleClick)
    tableView.keyHandler = { [weak self] event in self?.handleTableKey(event) ?? false }
    tableScroll.documentView = tableView
    tableScroll.hasVerticalScroller = true
    tableScroll.drawsBackground = false
    tableScroll.borderType = .noBorder
    tableScroll.scrollerStyle = .overlay

    let leftPane = NSView()
    leftPane.translatesAutoresizingMaskIntoConstraints = false
    leftPane.widthAnchor.constraint(greaterThanOrEqualToConstant: 260).isActive = true
    leftPane.widthAnchor.constraint(lessThanOrEqualToConstant: 460).isActive = true
    filter.translatesAutoresizingMaskIntoConstraints = false
    tableScroll.translatesAutoresizingMaskIntoConstraints = false
    leftPane.addSubview(filter)
    leftPane.addSubview(tableScroll)
    NSLayoutConstraint.activate([
      filter.topAnchor.constraint(equalTo: leftPane.topAnchor),
      filter.leadingAnchor.constraint(equalTo: leftPane.leadingAnchor, constant: 12),
      filter.trailingAnchor.constraint(equalTo: leftPane.trailingAnchor, constant: -8),
      tableScroll.topAnchor.constraint(equalTo: filter.bottomAnchor, constant: 8),
      tableScroll.leadingAnchor.constraint(equalTo: leftPane.leadingAnchor),
      tableScroll.trailingAnchor.constraint(equalTo: leftPane.trailingAnchor),
      tableScroll.bottomAnchor.constraint(equalTo: leftPane.bottomAnchor)
    ])

    splitView.isVertical = true
    splitView.dividerStyle = .thin
    splitView.delegate = self
    splitView.addArrangedSubview(leftPane)
    splitView.addArrangedSubview(preview)
    splitView.setPosition(330, ofDividerAt: 0)

    preview.onPaste = { [weak self] in self?.pasteSelected() }
    preview.onPin = { [weak self] in self?.pinSelected() }
    preview.onDelete = { [weak self] in self?.confirmDeleteSelected() }
    preview.showPlaceholder("选择一条记录查看内容")

    footerSeparator.boxType = .separator
    hintsLabel.font = .systemFont(ofSize: 10.5)
    hintsLabel.textColor = NSColor(srgbRed: 0.43, green: 0.50, blue: 0.60, alpha: 1)
    statusLabel.font = .systemFont(ofSize: 10.5)
    statusLabel.textColor = NSColor(srgbRed: 0.52, green: 0.58, blue: 0.68, alpha: 1)
    statusLabel.alignment = .right
    statusLabel.lineBreakMode = .byTruncatingTail

    for view in [headerIcon, eyebrowLabel, titleLabel, subtitleLabel, searchField, splitView, footerSeparator, hintsLabel, statusLabel] {
      view.translatesAutoresizingMaskIntoConstraints = false
      background.addSubview(view)
    }
    NSLayoutConstraint.activate([
      headerIcon.leadingAnchor.constraint(equalTo: background.leadingAnchor, constant: 18),
      headerIcon.topAnchor.constraint(equalTo: background.topAnchor, constant: 38),
      headerIcon.widthAnchor.constraint(equalToConstant: 30),
      headerIcon.heightAnchor.constraint(equalToConstant: 30),

      eyebrowLabel.leadingAnchor.constraint(equalTo: headerIcon.trailingAnchor, constant: 10),
      eyebrowLabel.topAnchor.constraint(equalTo: headerIcon.topAnchor, constant: -1),
      titleLabel.leadingAnchor.constraint(equalTo: eyebrowLabel.leadingAnchor),
      titleLabel.topAnchor.constraint(equalTo: eyebrowLabel.bottomAnchor, constant: 1),
      subtitleLabel.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
      subtitleLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 1),
      subtitleLabel.trailingAnchor.constraint(lessThanOrEqualTo: searchField.leadingAnchor, constant: -12),

      searchField.trailingAnchor.constraint(equalTo: background.trailingAnchor, constant: -18),
      searchField.centerYAnchor.constraint(equalTo: headerIcon.centerYAnchor),
      searchField.widthAnchor.constraint(equalToConstant: 250),
      searchField.heightAnchor.constraint(equalToConstant: 28),

      splitView.topAnchor.constraint(equalTo: headerIcon.bottomAnchor, constant: 14),
      splitView.leadingAnchor.constraint(equalTo: background.leadingAnchor, constant: 10),
      splitView.trailingAnchor.constraint(equalTo: background.trailingAnchor, constant: -10),
      splitView.bottomAnchor.constraint(equalTo: footerSeparator.topAnchor, constant: -6),

      footerSeparator.leadingAnchor.constraint(equalTo: background.leadingAnchor, constant: 16),
      footerSeparator.trailingAnchor.constraint(equalTo: background.trailingAnchor, constant: -16),
      footerSeparator.bottomAnchor.constraint(equalTo: background.bottomAnchor, constant: -26),
      hintsLabel.leadingAnchor.constraint(equalTo: background.leadingAnchor, constant: 18),
      hintsLabel.topAnchor.constraint(equalTo: footerSeparator.bottomAnchor, constant: 5),
      statusLabel.trailingAnchor.constraint(equalTo: background.trailingAnchor, constant: -18),
      statusLabel.centerYAnchor.constraint(equalTo: hintsLabel.centerYAnchor),
      statusLabel.leadingAnchor.constraint(greaterThanOrEqualTo: hintsLabel.trailingAnchor, constant: 12)
    ])
    brackets.translatesAutoresizingMaskIntoConstraints = false
    background.addSubview(brackets)
    NSLayoutConstraint.activate([
      brackets.leadingAnchor.constraint(equalTo: background.leadingAnchor, constant: 1),
      brackets.trailingAnchor.constraint(equalTo: background.trailingAnchor, constant: -1),
      brackets.topAnchor.constraint(equalTo: background.topAnchor, constant: 1),
      brackets.bottomAnchor.constraint(equalTo: background.bottomAnchor, constant: -1)
    ])
    updateSubtitle()
  }

  private func updateSubtitle() {
    subtitleLabel.stringValue = rows.isEmpty ? "本机剪贴板历史" : "\(rows.count) 条记录 · 本机"
  }

  // MARK: Networking

  private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil, completion: @escaping (Data?, Int, Error?) -> Void) {
    guard !origin.isEmpty, !managementKey.isEmpty, let url = URL(string: origin + path) else {
      completion(nil, 0, NSError(domain: "aih.clipboard", code: 1, userInfo: [NSLocalizedDescriptionKey: "本机 Server 未连接"]))
      return
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = 6
    request.setValue("Bearer \(managementKey)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    }
    URLSession.shared.dataTask(with: request) { data, response, error in
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      DispatchQueue.main.async { completion(data, status, error) }
    }.resume()
  }

  private func reloadList() {
    listGeneration += 1
    let generation = listGeneration
    guard !origin.isEmpty, !managementKey.isEmpty else {
      rows = []
      visibleRows = []
      tableView.reloadData()
      preview.showPlaceholder("本机 AIH Server 未连接")
      statusLabel.stringValue = "需要本机 Server 的管理密钥"
      updateSubtitle()
      return
    }
    statusLabel.stringValue = "正在加载…"
    request("/v1/management/webui/clipboard/items?limit=50") { [weak self] data, status, error in
      guard let self, generation == self.listGeneration else { return }
      if let error {
        self.statusLabel.stringValue = "加载失败：\(error.localizedDescription)"
        return
      }
      guard status == 200, let data,
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let raw = object["items"] as? [[String: Any]] else {
        self.statusLabel.stringValue = status == 401 ? "管理密钥无效" : "加载失败（HTTP \(status)）"
        return
      }
      self.rows = raw.compactMap(ClipboardPanelRow.init(json:))
      self.updateSubtitle()
      self.applyFilter()
      if self.visibleRows.isEmpty {
        self.statusLabel.stringValue = self.rows.isEmpty ? "尚无可粘贴内容" : "没有匹配的记录"
        self.preview.showPlaceholder(self.rows.isEmpty ? "剪贴板为空\n复制任意文本、图片或文件后会出现在这里" : "没有匹配的记录")
      } else {
        self.statusLabel.stringValue = ""
      }
    }
  }

  private func loadDetail(_ row: ClipboardPanelRow, generation: Int) {
    if row.kind == "image" {
      loadContent(row) { [weak self] data in
        guard let self, generation == self.previewGeneration else { return }
        if let data, let image = NSImage(data: data) {
          let dimensions = row.width > 0 && row.height > 0 ? "\(row.width)×\(row.height) · " : ""
          let meta = "\(dimensions)\(ClipboardPanelFormat.bytes(row.byteSize)) · \(ClipboardPanelFormat.relative(row.effectiveTimeMs) ?? "")"
          self.preview.showImage(image, kind: row.kind, meta: meta, footer: "↵ 粘贴图片到当前应用", pinned: row.pinned)
        } else {
          self.preview.showPlaceholder("图片内容不可用")
        }
      }
      return
    }
    if row.kind == "file" {
      let meta = "\(row.files.count) 个文件 · \(ClipboardPanelFormat.relative(row.effectiveTimeMs) ?? "")"
      let body = row.files.map { "▸ " + $0 }.joined(separator: "\n")
      preview.showText(kind: row.kind, text: body, meta: meta, footer: "↵ 复制文件路径", pinned: row.pinned)
      return
    }
    preview.showPlaceholder("正在读取…")
    guard let encoded = row.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return }
    request("/v1/management/webui/clipboard/items/\(encoded)") { [weak self] data, status, _ in
      guard let self, generation == self.previewGeneration else { return }
      guard status == 200, let data,
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let detail = ClipboardPanelDetail(json: object) else {
        self.preview.showPlaceholder("无法读取条目详情")
        return
      }
      let meta = "\(ClipboardPanelFormat.bytes(row.byteSize)) · \(ClipboardPanelFormat.relative(row.effectiveTimeMs) ?? "")"
      let note = detail.textTruncated ? "预览前 64 KiB · ↵ 复制完整内容" : "↵ 复制到剪贴板"
      self.preview.showText(kind: row.kind, text: detail.text, meta: meta, footer: note, pinned: row.pinned)
    }
  }

  private func loadContent(_ row: ClipboardPanelRow, completion: @escaping (Data?) -> Void) {
    if let cached = contentCache.object(forKey: row.id as NSString) {
      completion(cached as Data)
      return
    }
    guard let encoded = row.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else {
      completion(nil)
      return
    }
    request("/v1/management/webui/clipboard/items/\(encoded)/content") { [weak self] data, status, _ in
      guard let self, status == 200, let data else {
        completion(nil)
        return
      }
      self.contentCache.setObject(data as NSData, forKey: row.id as NSString, cost: data.count)
      completion(data)
    }
  }

  // MARK: Filtering and selection

  @objc private func filterChanged() {
    applyFilter()
  }

  private var filterKind: String? {
    switch filter.selectedSegment {
    case 1: return "text"
    case 2: return "link"
    case 3: return "image"
    case 4: return "file"
    default: return nil
    }
  }

  private func applyFilter() {
    let query = searchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let kind = filterKind
    visibleRows = rows.filter { row in
      if let kind, row.kind != kind { return false }
      return row.matches(query)
    }
    tableView.reloadData()
    if let index = visibleRows.firstIndex(where: { $0.id == selectedID }) {
      selectRow(index, notify: false)
    } else if !visibleRows.isEmpty {
      selectRow(0, notify: true)
    } else {
      selectedID = ""
      preview.showPlaceholder(query.isEmpty ? "剪贴板为空" : "没有匹配的记录")
    }
  }

  private func selectRow(_ index: Int, notify: Bool) {
    guard index >= 0, index < visibleRows.count else { return }
    if tableView.selectedRow != index {
      suppressSelectionPreview = true
      tableView.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
      suppressSelectionPreview = false
    }
    tableView.scrollRowToVisible(index)
    refreshChosenRows()
    if notify { updatePreviewForSelection() }
  }

  private func refreshChosenRows() {
    for row in 0..<visibleRows.count {
      guard let view = tableView.view(atColumn: 0, row: row, makeIfNecessary: false) as? ClipboardPanelRowView else { continue }
      view.setChosen(row == tableView.selectedRow)
    }
  }

  private func moveSelection(_ delta: Int) {
    guard !visibleRows.isEmpty else { return }
    let current = tableView.selectedRow >= 0 ? tableView.selectedRow : 0
    let next = max(0, min(visibleRows.count - 1, current + delta))
    guard next != current || tableView.selectedRow < 0 else { return }
    selectRow(next, notify: true)
  }

  private var currentRow: ClipboardPanelRow? {
    let index = tableView.selectedRow
    guard index >= 0, index < visibleRows.count else { return nil }
    return visibleRows[index]
  }

  private func updatePreviewForSelection() {
    guard let row = currentRow else { return }
    selectedID = row.id
    previewGeneration += 1
    loadDetail(row, generation: previewGeneration)
  }

  // MARK: Actions

  @objc private func handleDoubleClick() {
    pasteSelected()
  }

  private func pasteSelected() {
    guard let row = currentRow else { return }
    switch row.kind {
    case "file":
      pasteFiles(row)
    case "image":
      loadContent(row) { [weak self] data in
        guard let self, let data else {
          self?.statusLabel.stringValue = "图片内容读取失败"
          return
        }
        self.writeImage(row, data: data)
      }
    default:
      loadContent(row) { [weak self] data in
        guard let self, let data else {
          self?.statusLabel.stringValue = "内容读取失败"
          return
        }
        self.writeText(row, data: data)
      }
    }
  }

  private func pinSelected() {
    guard let row = currentRow else { return }
    guard let encoded = row.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return }
    request("/v1/management/webui/clipboard/items/\(encoded)/pin", method: "POST", body: ["pinned": !row.pinned]) { [weak self] _, status, _ in
      guard let self else { return }
      if status == 200 {
        self.statusLabel.stringValue = row.pinned ? "已取消置顶" : "已置顶"
        self.selectedID = row.id
        self.reloadList()
      } else {
        self.statusLabel.stringValue = "更新置顶失败（HTTP \(status)）"
      }
    }
  }

  private func confirmDeleteSelected() {
    guard let row = currentRow else { return }
    let alert = NSAlert()
    alert.messageText = "删除这条剪贴板记录？"
    alert.informativeText = row.preview
    alert.alertStyle = .warning
    alert.addButton(withTitle: "删除")
    alert.addButton(withTitle: "取消")
    guard let encoded = row.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return }
    alert.beginSheetModal(for: panel) { [weak self] response in
      guard response == .alertFirstButtonReturn, let self else { return }
      self.contentCache.removeObject(forKey: row.id as NSString)
      self.request("/v1/management/webui/clipboard/items/\(encoded)", method: "DELETE") { [weak self] _, status, _ in
        guard let self else { return }
        if status == 200 {
          self.statusLabel.stringValue = "已删除"
          self.selectedID = ""
          self.reloadList()
        } else {
          self.statusLabel.stringValue = "删除失败（HTTP \(status)）"
        }
      }
    }
  }

  private func writeText(_ row: ClipboardPanelRow, data: Data) {
    let text = String(data: data, encoding: .utf8) ?? row.preview
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.setString(text, forType: .string)
    finishPaste(row)
  }

  private func writeImage(_ row: ClipboardPanelRow, data: Data) {
    guard let image = NSImage(data: data) else {
      statusLabel.stringValue = "无法解码图片"
      return
    }
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    if row.mime.lowercased().contains("png") {
      pasteboard.setData(data, forType: .png)
      if let tiff = image.tiffRepresentation { pasteboard.setData(tiff, forType: .tiff) }
    } else if let tiff = image.tiffRepresentation {
      pasteboard.setData(tiff, forType: .tiff)
    } else {
      pasteboard.writeObjects([image])
    }
    finishPaste(row)
  }

  private func pasteFiles(_ row: ClipboardPanelRow) {
    let paths = row.files.filter { !$0.isEmpty }
    guard !paths.isEmpty else {
      statusLabel.stringValue = "文件路径为空"
      return
    }
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    let urls = paths.map { URL(fileURLWithPath: $0) }
    let existing = urls.filter { FileManager.default.fileExists(atPath: $0.path) }
    if existing.count == urls.count {
      pasteboard.writeObjects(existing as [NSURL])
    } else {
      pasteboard.setString(paths.joined(separator: "\n"), forType: .string)
    }
    finishPaste(row)
  }

  private func finishPaste(_ row: ClipboardPanelRow) {
    emit(["type": "clipboard-pasted", "kind": row.kind, "id": row.id])
    hide()
  }

  // MARK: Keyboard

  private func handleTableKey(_ event: NSEvent) -> Bool {
    // Let the field editor/IME consume keys while composing (Pinyin candidates etc.).
    if let input = panel.firstResponder as? NSTextInputClient, input.hasMarkedText() {
      return false
    }
    let command = event.modifierFlags.contains(.command)
    switch event.keyCode {
    case 36, 76:
      pasteSelected()
      return true
    case 53:
      hide()
      return true
    case 125:
      moveSelection(1)
      return true
    case 126:
      moveSelection(-1)
      return true
    case 51, 117:
      if command {
        // While editing a non-empty search query, ⌘⌫ belongs to the text field.
        if searchField.currentEditor() != nil && !searchField.stringValue.isEmpty { return false }
        confirmDeleteSelected()
        return true
      }
      return false
    case 35:
      if command {
        pinSelected()
        return true
      }
      return false
    case 3:
      if command {
        panel.makeFirstResponder(searchField)
        return true
      }
      return false
    default:
      return false
    }
  }

  func controlTextDidChange(_ notification: Notification) {
    applyFilter()
  }

  func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
    switch commandSelector {
    case #selector(NSResponder.moveUp(_:)): moveSelection(-1); return true
    case #selector(NSResponder.moveDown(_:)): moveSelection(1); return true
    case #selector(NSResponder.insertNewline(_:)): pasteSelected(); return true
    case #selector(NSResponder.cancelOperation(_:)): hide(); return true
    default: return false
    }
  }

  // MARK: NSTableViewDataSource / Delegate

  func numberOfRows(in tableView: NSTableView) -> Int { visibleRows.count }

  func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
    guard row >= 0, row < visibleRows.count else { return nil }
    let view = ClipboardPanelRowView()
    view.apply(visibleRows[row])
    view.setChosen(row == tableView.selectedRow)
    return view
  }

  func tableViewSelectionDidChange(_ notification: Notification) {
    refreshChosenRows()
    guard !suppressSelectionPreview else { return }
    updatePreviewForSelection()
  }

  // MARK: NSSplitViewDelegate

  func splitView(_ splitView: NSSplitView, constrainMinCoordinate proposedMinimumPosition: CGFloat, ofSubviewAt dividerIndex: Int) -> CGFloat {
    max(proposedMinimumPosition, 260)
  }

  func splitView(_ splitView: NSSplitView, constrainMaxCoordinate proposedMaximumPosition: CGFloat, ofSubviewAt dividerIndex: Int) -> CGFloat {
    min(proposedMaximumPosition, splitView.bounds.width - 320)
  }

  // MARK: NSWindowDelegate

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    hide()
    return false
  }
}