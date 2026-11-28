import AppKit
import Foundation
import QuartzCore

private final class LumenWorkspaceHostWindow: NSWindow {
  var onKeyEvent: ((NSEvent) -> Bool)?

  override func sendEvent(_ event: NSEvent) {
    if event.type == .keyDown, let handler = onKeyEvent, handler(event) {
      return
    }
    super.sendEvent(event)
  }
}

/// Pure native AppKit management window for Paste Lumen V7.
/// Strictly zero WebView/HTML. Shares `LumenClipboardStore` and `LumenPreviewWindow`
/// with the separate Orbit NSPanel surface.
final class ClipboardWorkspaceWindow: NSObject,
  NSWindowDelegate,
  NSTableViewDataSource,
  NSTableViewDelegate,
  NSCollectionViewDataSource,
  NSCollectionViewDelegate,
  NSSearchFieldDelegate
{
  private enum SortOrder: Int {
    case newest = 0
    case oldest = 1
    case title = 2
  }

  private enum HistoryRowEntry {
    case sectionHeader(title: String, count: Int)
    case item(LumenClipboardItem)
  }

  let window: NSWindow
  private let hostWindow: LumenWorkspaceHostWindow
  private let store = LumenClipboardStore.shared

  private var enabled = true
  private var hasPositioned = false
  private var observerID: UUID?

  // Navigation & filter state
  private var activeNav: LumenNavDestination = .all
  private var searchQuery = ""
  private var sortOrder: SortOrder = .newest
  private var isListMode = true
  private var sidebarHidden = false
  private var inspectorHidden = false

  private var filteredItems: [LumenClipboardItem] = []
  private var listRows: [HistoryRowEntry] = []
  private var selectedID: String?
  private var multiSelectedIDs: Set<String> = []
  private var selectionAnchorID: String?

  // Views
  private let rootContainer = NSView()
  private let sidebarView = LumenSidebarView()
  private let sidebarDivider = NSView()
  private let workspaceContainer = NSView()
  private let toolbarView = NSView()
  private let toolbarDivider = NSView()
  private let headingLabel = NSTextField(labelWithString: "所有记录")
  private let subHeadingLabel = NSTextField(labelWithString: "0 条内容")
  private let searchField = NSSearchField()
  private let sortPopup = NSPopUpButton()
  private let viewSegment = NSSegmentedControl()
  private let themeButton = NSButton()
  private let orbitLaunchButton = NSButton()
  private let splitView = NSSplitView()
  private let historyHost = NSView()
  private let listScroll = NSScrollView()
  private let listTable = NSTableView()
  private let galleryScroll = NSScrollView()
  private let galleryCollection = NSCollectionView()
  private let emptyLabel = NSTextField(labelWithString: "暂无剪贴板记录")
  private let inspectorView = LumenInspectorView()
  private let settingsView = LumenSettingsView()
  private let footerBar = NSView()
  private let footerDivider = NSView()
  private let footerLeft = NSTextField(labelWithString: "")
  private let footerRight = NSTextField(labelWithString: "↑ ↓ 导航 · Space 预览 · ↵ 复制 · ⌘F 搜索")
  private let toastView = LumenToastBannerView()
  private let newClipSheet = LumenNewClipSheet()

  private var sidebarWidthConstraint: NSLayoutConstraint?
  private var leftToolsLeadingConstraint: NSLayoutConstraint?

  var onOpenOrbit: (() -> Void)?
  var onQuickOrbitPositionChanged: ((String) -> Void)?

  override init() {
    hostWindow = LumenWorkspaceHostWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1220, height: 800),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window = hostWindow
    super.init()
    window.title = "Lumen 剪贴板"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.isReleasedWhenClosed = false
    window.minSize = NSSize(width: 820, height: 540)
    window.delegate = self
    window.setFrameAutosaveName("AIHClipboardWorkspaceV7")
    hostWindow.onKeyEvent = { [weak self] event in self?.handleWindowKey(event) ?? false }

    buildLayout()
    wireCallbacks()
    applyTheme()

    observerID = store.addObserver { [weak self] event in
      guard let self else { return }
      switch event {
      case .itemsUpdated:
        self.rebuildFilteredState()
      case .itemsCaptured, .itemRestored:
        break
      case .settingsUpdated:
        if self.activeNav == .settings { self.settingsView.reload() }
        self.updateSidebar()
      case .statusUpdated, .connectionUpdated:
        self.updateSidebar()
        if self.activeNav == .settings { self.settingsView.reload() }
      case .preferencesUpdated:
        self.applyTheme()
        self.rebuildFilteredState()
        if self.activeNav == .settings { self.settingsView.reload() }
      case .error(let msg):
        if self.window.isVisible {
          self.toastView.show(message: msg, showUndo: false)
        }
      }
    }
  }

  deinit {
    if let id = observerID { store.removeObserver(id) }
  }

  var isAvailable: Bool {
    if !enabled { return false }
    if !store.isConfigured {
      store.ensureConfiguredFromLocalConfig()
    }
    return store.isConfigured
  }

  var isKeyWindow: Bool { window.isVisible && window.isKeyWindow }

  func configure(origin nextOrigin: String, managementKey nextKey: String, enabled nextEnabled: Bool) {
    enabled = nextEnabled
    if !nextOrigin.isEmpty || !nextKey.isEmpty {
      store.configure(origin: nextOrigin, managementKey: nextKey)
    } else if nextEnabled {
      store.ensureConfiguredFromLocalConfig()
    }
    if window.isVisible && nextEnabled {
      store.refreshAll()
    }
  }

  func show() {
    store.ensureConfiguredFromLocalConfig()
    guard isAvailable else { return }
    if !hasPositioned {
      hasPositioned = true
      if !window.setFrameUsingName("AIHClipboardWorkspaceV7") {
        window.setContentSize(NSSize(width: 1220, height: 800))
        window.center()
      }
    }
    store.refreshAll()
    rebuildFilteredState()
    window.makeKeyAndOrderFront(nil)
    // Navigation must work on open; the search field would otherwise take the
    // key view loop's initial responder and swallow arrows and Space.
    window.makeFirstResponder(listTable)
    NSApp.activate(ignoringOtherApps: true)
    _ = NSRunningApplication.current.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
  }

  func hide() {
    window.orderOut(nil)
  }

  // MARK: Layout

  private func buildLayout() {
    rootContainer.wantsLayer = true
    window.contentView = rootContainer

    sidebarView.translatesAutoresizingMaskIntoConstraints = false
    sidebarDivider.wantsLayer = true
    sidebarDivider.translatesAutoresizingMaskIntoConstraints = false

    workspaceContainer.wantsLayer = true
    workspaceContainer.translatesAutoresizingMaskIntoConstraints = false

    // Top workspace toolbar
    toolbarView.wantsLayer = true
    toolbarView.translatesAutoresizingMaskIntoConstraints = false
    toolbarDivider.wantsLayer = true
    toolbarDivider.translatesAutoresizingMaskIntoConstraints = false

    let toggleSidebarBtn = makeToolbarIconButton("sidebar.leading", tip: "切换侧边栏", action: #selector(toggleSidebar))
    let addBtn = makeToolbarIconButton("plus", tip: "新建文本记录 (⌘N)", action: #selector(openNewClipSheet))
    let localFileBtn = makeToolbarIconButton("doc.badge.plus", tip: "预览本地文件", action: #selector(openLocalPreview))

    headingLabel.font = .systemFont(ofSize: 14, weight: .semibold)
    headingLabel.translatesAutoresizingMaskIntoConstraints = false
    subHeadingLabel.font = .systemFont(ofSize: 10.5)
    subHeadingLabel.translatesAutoresizingMaskIntoConstraints = false
    let titleStack = NSStackView(views: [headingLabel, subHeadingLabel])
    titleStack.orientation = .vertical
    titleStack.alignment = .leading
    titleStack.spacing = 1

    let leftTools = NSStackView(views: [toggleSidebarBtn, titleStack, addBtn, localFileBtn])
    leftTools.orientation = .horizontal
    leftTools.alignment = .centerY
    leftTools.spacing = 10
    leftTools.translatesAutoresizingMaskIntoConstraints = false

    searchField.placeholderString = "搜索记录 (⌘F)"
    searchField.delegate = self
    searchField.sendsSearchStringImmediately = true
    searchField.translatesAutoresizingMaskIntoConstraints = false
    searchField.widthAnchor.constraint(equalToConstant: 210).isActive = true

    sortPopup.addItems(withTitles: ["最新优先", "最早优先", "按标题"])
    sortPopup.target = self
    sortPopup.action = #selector(sortChanged)
    sortPopup.font = .systemFont(ofSize: 11.5)
    sortPopup.isBordered = false
    sortPopup.translatesAutoresizingMaskIntoConstraints = false

    viewSegment.segmentCount = 2
    viewSegment.setImage(LumenIcons.symbol("list.bullet", size: 13), forSegment: 0)
    viewSegment.setImage(LumenIcons.symbol("square.grid.2x2", size: 13), forSegment: 1)
    viewSegment.selectedSegment = 0
    viewSegment.trackingMode = .selectOne
    viewSegment.target = self
    viewSegment.action = #selector(viewModeChanged)
    viewSegment.translatesAutoresizingMaskIntoConstraints = false

    let toggleInspectorBtn = makeToolbarIconButton("sidebar.trailing", tip: "切换预览面板", action: #selector(toggleInspector))

    themeButton.isBordered = false
    themeButton.wantsLayer = true
    themeButton.target = self
    themeButton.action = #selector(toggleThemeClicked)
    themeButton.toolTip = "切换外观"
    themeButton.layer?.cornerRadius = 7
    themeButton.translatesAutoresizingMaskIntoConstraints = false
    themeButton.widthAnchor.constraint(equalToConstant: 30).isActive = true
    themeButton.heightAnchor.constraint(equalToConstant: 28).isActive = true

    orbitLaunchButton.title = "Orbit"
    orbitLaunchButton.image = LumenIcons.symbol("sparkles", size: 12)
    orbitLaunchButton.imagePosition = .imageLeading
    orbitLaunchButton.isBordered = false
    orbitLaunchButton.wantsLayer = true
    orbitLaunchButton.font = .systemFont(ofSize: 11.5, weight: .semibold)
    orbitLaunchButton.toolTip = "呼出 Orbit 快捷浮层"
    orbitLaunchButton.target = self
    orbitLaunchButton.action = #selector(launchOrbitClicked)
    orbitLaunchButton.layer?.cornerRadius = 7
    orbitLaunchButton.layer?.borderWidth = 1
    orbitLaunchButton.translatesAutoresizingMaskIntoConstraints = false
    orbitLaunchButton.heightAnchor.constraint(equalToConstant: 28).isActive = true
    orbitLaunchButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 66).isActive = true

    let rightTools = NSStackView(views: [searchField, sortPopup, viewSegment, toggleInspectorBtn, themeButton, orbitLaunchButton])
    rightTools.orientation = .horizontal
    rightTools.alignment = .centerY
    rightTools.spacing = 8
    rightTools.translatesAutoresizingMaskIntoConstraints = false

    toolbarView.addSubview(leftTools)
    toolbarView.addSubview(rightTools)
    toolbarView.addSubview(toolbarDivider)

    // History list table
    let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("historyRow"))
    col.resizingMask = .autoresizingMask
    listTable.addTableColumn(col)
    listTable.headerView = nil
    listTable.backgroundColor = .clear
    listTable.selectionHighlightStyle = .none
    listTable.allowsMultipleSelection = false
    listTable.intercellSpacing = NSSize(width: 0, height: 3)
    listTable.dataSource = self
    listTable.delegate = self
    listTable.target = self
    listTable.action = #selector(listRowClicked)
    listTable.doubleAction = #selector(listRowDoubleClicked)
    listTable.menu = makeContextMenu()

    listScroll.documentView = listTable
    listScroll.hasVerticalScroller = true
    listScroll.autohidesScrollers = true
    listScroll.drawsBackground = false
    listScroll.borderType = .noBorder
    listScroll.translatesAutoresizingMaskIntoConstraints = false

    // History gallery collection
    let flow = NSCollectionViewFlowLayout()
    flow.itemSize = NSSize(width: 176, height: 174)
    flow.minimumInteritemSpacing = 10
    flow.minimumLineSpacing = 10
    flow.sectionInset = NSEdgeInsets(top: 12, left: 14, bottom: 16, right: 14)
    galleryCollection.collectionViewLayout = flow
    galleryCollection.register(LumenGalleryCardItem.self, forItemWithIdentifier: LumenGalleryCardItem.reuseID)
    galleryCollection.backgroundColors = [.clear]
    galleryCollection.isSelectable = false
    galleryCollection.dataSource = self
    galleryCollection.delegate = self

    galleryScroll.documentView = galleryCollection
    galleryScroll.hasVerticalScroller = true
    galleryScroll.autohidesScrollers = true
    galleryScroll.drawsBackground = false
    galleryScroll.borderType = .noBorder
    galleryScroll.isHidden = true
    galleryScroll.translatesAutoresizingMaskIntoConstraints = false

    emptyLabel.font = .systemFont(ofSize: 13)
    emptyLabel.alignment = .center
    emptyLabel.isHidden = true
    emptyLabel.translatesAutoresizingMaskIntoConstraints = false

    historyHost.wantsLayer = true
    historyHost.translatesAutoresizingMaskIntoConstraints = false
    historyHost.addSubview(listScroll)
    historyHost.addSubview(galleryScroll)
    historyHost.addSubview(emptyLabel)

    NSLayoutConstraint.activate([
      listScroll.topAnchor.constraint(equalTo: historyHost.topAnchor, constant: 6),
      listScroll.leadingAnchor.constraint(equalTo: historyHost.leadingAnchor, constant: 6),
      listScroll.trailingAnchor.constraint(equalTo: historyHost.trailingAnchor, constant: -6),
      listScroll.bottomAnchor.constraint(equalTo: historyHost.bottomAnchor),

      galleryScroll.topAnchor.constraint(equalTo: historyHost.topAnchor),
      galleryScroll.leadingAnchor.constraint(equalTo: historyHost.leadingAnchor),
      galleryScroll.trailingAnchor.constraint(equalTo: historyHost.trailingAnchor),
      galleryScroll.bottomAnchor.constraint(equalTo: historyHost.bottomAnchor),

      emptyLabel.centerXAnchor.constraint(equalTo: historyHost.centerXAnchor),
      emptyLabel.centerYAnchor.constraint(equalTo: historyHost.centerYAnchor)
    ])

    // SplitView (History | Inspector)
    splitView.isVertical = true
    splitView.dividerStyle = .thin
    splitView.translatesAutoresizingMaskIntoConstraints = false
    splitView.addArrangedSubview(historyHost)
    splitView.addArrangedSubview(inspectorView)
    splitView.setHoldingPriority(.defaultLow, forSubviewAt: 0)
    splitView.setHoldingPriority(.defaultHigh, forSubviewAt: 1)
    inspectorView.widthAnchor.constraint(greaterThanOrEqualToConstant: 290).isActive = true
    historyHost.widthAnchor.constraint(greaterThanOrEqualToConstant: 320).isActive = true

    settingsView.isHidden = true
    settingsView.translatesAutoresizingMaskIntoConstraints = false

    // Footer bar
    footerBar.wantsLayer = true
    footerBar.translatesAutoresizingMaskIntoConstraints = false
    footerDivider.wantsLayer = true
    footerDivider.translatesAutoresizingMaskIntoConstraints = false
    footerLeft.font = .systemFont(ofSize: 10.5)
    footerLeft.translatesAutoresizingMaskIntoConstraints = false
    footerRight.font = .systemFont(ofSize: 10.5)
    footerRight.translatesAutoresizingMaskIntoConstraints = false
    footerBar.addSubview(footerDivider)
    footerBar.addSubview(footerLeft)
    footerBar.addSubview(footerRight)

    toastView.translatesAutoresizingMaskIntoConstraints = false

    workspaceContainer.addSubview(toolbarView)
    workspaceContainer.addSubview(splitView)
    workspaceContainer.addSubview(settingsView)
    workspaceContainer.addSubview(footerBar)
    workspaceContainer.addSubview(toastView)

    rootContainer.addSubview(sidebarView)
    rootContainer.addSubview(sidebarDivider)
    rootContainer.addSubview(workspaceContainer)

    let sideWidth = sidebarView.widthAnchor.constraint(equalToConstant: 204)
    sidebarWidthConstraint = sideWidth
    let leftToolsLeading = leftTools.leadingAnchor.constraint(equalTo: toolbarView.leadingAnchor, constant: 14)
    leftToolsLeadingConstraint = leftToolsLeading

    NSLayoutConstraint.activate([
      sidebarView.topAnchor.constraint(equalTo: rootContainer.topAnchor, constant: 28),
      sidebarView.leadingAnchor.constraint(equalTo: rootContainer.leadingAnchor),
      sidebarView.bottomAnchor.constraint(equalTo: rootContainer.bottomAnchor),
      sideWidth,

      sidebarDivider.topAnchor.constraint(equalTo: rootContainer.topAnchor),
      sidebarDivider.leadingAnchor.constraint(equalTo: sidebarView.trailingAnchor),
      sidebarDivider.bottomAnchor.constraint(equalTo: rootContainer.bottomAnchor),
      sidebarDivider.widthAnchor.constraint(equalToConstant: 1),

      workspaceContainer.topAnchor.constraint(equalTo: rootContainer.topAnchor),
      workspaceContainer.leadingAnchor.constraint(equalTo: sidebarDivider.trailingAnchor),
      workspaceContainer.trailingAnchor.constraint(equalTo: rootContainer.trailingAnchor),
      workspaceContainer.bottomAnchor.constraint(equalTo: rootContainer.bottomAnchor),

      toolbarView.topAnchor.constraint(equalTo: workspaceContainer.topAnchor),
      toolbarView.leadingAnchor.constraint(equalTo: workspaceContainer.leadingAnchor),
      toolbarView.trailingAnchor.constraint(equalTo: workspaceContainer.trailingAnchor),
      toolbarView.heightAnchor.constraint(equalToConstant: 56),

      leftToolsLeading,
      leftTools.centerYAnchor.constraint(equalTo: toolbarView.centerYAnchor),
      rightTools.trailingAnchor.constraint(equalTo: toolbarView.trailingAnchor, constant: -14),
      rightTools.centerYAnchor.constraint(equalTo: toolbarView.centerYAnchor),
      leftTools.trailingAnchor.constraint(lessThanOrEqualTo: rightTools.leadingAnchor, constant: -10),

      toolbarDivider.leadingAnchor.constraint(equalTo: toolbarView.leadingAnchor),
      toolbarDivider.trailingAnchor.constraint(equalTo: toolbarView.trailingAnchor),
      toolbarDivider.bottomAnchor.constraint(equalTo: toolbarView.bottomAnchor),
      toolbarDivider.heightAnchor.constraint(equalToConstant: 1),

      splitView.topAnchor.constraint(equalTo: toolbarView.bottomAnchor),
      splitView.leadingAnchor.constraint(equalTo: workspaceContainer.leadingAnchor),
      splitView.trailingAnchor.constraint(equalTo: workspaceContainer.trailingAnchor),
      splitView.bottomAnchor.constraint(equalTo: footerBar.topAnchor),

      settingsView.topAnchor.constraint(equalTo: toolbarView.bottomAnchor),
      settingsView.leadingAnchor.constraint(equalTo: workspaceContainer.leadingAnchor),
      settingsView.trailingAnchor.constraint(equalTo: workspaceContainer.trailingAnchor),
      settingsView.bottomAnchor.constraint(equalTo: footerBar.topAnchor),

      footerBar.leadingAnchor.constraint(equalTo: workspaceContainer.leadingAnchor),
      footerBar.trailingAnchor.constraint(equalTo: workspaceContainer.trailingAnchor),
      footerBar.bottomAnchor.constraint(equalTo: workspaceContainer.bottomAnchor),
      footerBar.heightAnchor.constraint(equalToConstant: 28),

      footerDivider.topAnchor.constraint(equalTo: footerBar.topAnchor),
      footerDivider.leadingAnchor.constraint(equalTo: footerBar.leadingAnchor),
      footerDivider.trailingAnchor.constraint(equalTo: footerBar.trailingAnchor),
      footerDivider.heightAnchor.constraint(equalToConstant: 1),

      footerLeft.leadingAnchor.constraint(equalTo: footerBar.leadingAnchor, constant: 14),
      footerLeft.centerYAnchor.constraint(equalTo: footerBar.centerYAnchor),
      footerRight.trailingAnchor.constraint(equalTo: footerBar.trailingAnchor, constant: -14),
      footerRight.centerYAnchor.constraint(equalTo: footerBar.centerYAnchor),

      toastView.topAnchor.constraint(equalTo: toolbarView.bottomAnchor, constant: 12),
      toastView.centerXAnchor.constraint(equalTo: workspaceContainer.centerXAnchor)
    ])
  }

  private func wireCallbacks() {
    sidebarView.onSelectDestination = { [weak self] dest in
      self?.selectDestination(dest)
    }

    inspectorView.onCopySingle = { [weak self] item in self?.copyItem(item) }
    inspectorView.onPreviewSingle = { [weak self] item in
      guard let self else { return }
      // Carry the whole filtered list so the preview queue can step through it.
      let queue = self.filteredItems.isEmpty ? [item] : self.filteredItems
      self.openPreview(items: queue, initialID: item.id)
    }
    inspectorView.onPinSingle = { [weak self] item in self?.togglePin(item) }
    inspectorView.onDeleteSingle = { [weak self] item in self?.deleteSingle(item) }
    inspectorView.onBatchPreview = { [weak self] items in self?.openPreview(items: items, initialID: self?.selectedID) }
    inspectorView.onBatchPin = { [weak self] items in self?.batchPin(items) }
    inspectorView.onBatchDelete = { [weak self] items in self?.batchDelete(items) }
    inspectorView.onClearSelection = { [weak self] in
      self?.multiSelectedIDs.removeAll()
      self?.reloadHistoryPresentation()
      self?.renderInspector()
    }

    settingsView.onPatchServerSettings = { [weak self] patch in
      self?.store.patchSettings(patch) { result in
        if case .success(let updated) = result {
          self?.onQuickOrbitPositionChanged?(updated.quickOrbitPosition)
          self?.toastView.show(message: "设置已保存")
        }
      }
    }
    settingsView.onApplyPreferences = { [weak self] next in
      self?.store.updatePreferences { prefs in prefs = next }
    }
    settingsView.onTriggerSync = { [weak self] in
      self?.store.api.triggerSync { result in
        switch result {
        case .success: self?.toastView.show(message: "同步已完成")
        case .failure(let err): self?.toastView.show(message: "同步失败：\(err.localizedDescription)")
        }
      }
    }
    settingsView.onClearAllItems = { [weak self] in
      self?.confirmClearAll()
    }

    toastView.onUndo = { [weak self] in
      self?.undoDelete()
    }
    LumenPreviewWindow.shared.onToast = { [weak self] msg in
      if self?.window.isVisible == true {
        self?.toastView.show(message: msg)
      }
    }
  }

  private func makeToolbarIconButton(_ symbol: String, tip: String, action: Selector) -> NSButton {
    let btn = NSButton()
    btn.isBordered = false
    btn.wantsLayer = true
    btn.image = LumenIcons.symbol(symbol, size: 14, weight: .medium, description: tip)
    btn.toolTip = tip
    btn.target = self
    btn.action = action
    btn.layer?.cornerRadius = 7
    btn.translatesAutoresizingMaskIntoConstraints = false
    btn.widthAnchor.constraint(equalToConstant: 30).isActive = true
    btn.heightAnchor.constraint(equalToConstant: 28).isActive = true
    return btn
  }

  private func makeContextMenu() -> NSMenu {
    let menu = NSMenu(title: "条目操作")
    menu.addItem(withTitle: "复制到剪贴板", action: #selector(contextCopy), keyEquivalent: "")
    menu.addItem(withTitle: "完整预览", action: #selector(contextPreview), keyEquivalent: "")
    menu.addItem(withTitle: "固定 / 取消固定", action: #selector(contextPin), keyEquivalent: "")
    menu.addItem(NSMenuItem.separator())
    menu.addItem(withTitle: "移除记录", action: #selector(contextDelete), keyEquivalent: "")
    menu.items.forEach { $0.target = self }
    return menu
  }

  // MARK: Theme & State Sync

  private func applyTheme() {
    let palette = LumenPalette.current(store.preferences)
    window.appearance = palette.nsAppearance
    window.backgroundColor = palette.windowBackground
    rootContainer.layer?.backgroundColor = palette.windowBackground.cgColor
    sidebarDivider.layer?.backgroundColor = palette.border.cgColor
    workspaceContainer.layer?.backgroundColor = palette.windowBackground.cgColor
    toolbarView.layer?.backgroundColor = palette.windowBackground.cgColor
    toolbarDivider.layer?.backgroundColor = palette.border.cgColor
    historyHost.layer?.backgroundColor = palette.windowBackground.cgColor
    footerBar.layer?.backgroundColor = palette.sidebarBackgroundBottom.cgColor
    footerDivider.layer?.backgroundColor = palette.border.cgColor

    headingLabel.textColor = palette.ink
    subHeadingLabel.textColor = palette.muted
    emptyLabel.textColor = palette.muted
    footerLeft.textColor = palette.muted
    footerRight.textColor = palette.muted

    themeButton.image = LumenIcons.symbol(palette.isDark ? "sun.max" : "moon", size: 14, weight: .medium)
    themeButton.contentTintColor = palette.muted
    orbitLaunchButton.contentTintColor = palette.accent
    orbitLaunchButton.layer?.backgroundColor = palette.accentSoft.cgColor
    orbitLaunchButton.layer?.borderColor = palette.accentBorder.cgColor

    updateSidebar()
    renderInspector()
  }

  private func updateSidebar() {
    sidebarView.update(
      active: activeNav,
      items: store.items,
      connected: store.connected,
      status: store.status,
      palette: LumenPalette.current(store.preferences)
    )
  }

  private func selectDestination(_ dest: LumenNavDestination) {
    activeNav = dest
    multiSelectedIDs.removeAll()
    selectionAnchorID = nil
    let isSettings = dest == .settings
    splitView.isHidden = isSettings
    settingsView.isHidden = !isSettings
    searchField.isHidden = isSettings
    sortPopup.isHidden = isSettings
    viewSegment.isHidden = isSettings
    headingLabel.stringValue = dest.title
    if isSettings {
      subHeadingLabel.stringValue = "自定义 Lumen 原生体验"
      store.refreshSettings()
      store.refreshStatus()
      store.refreshServers()
      settingsView.reload()
    } else {
      rebuildFilteredState()
    }
    updateSidebar()
  }

  private func rebuildFilteredState() {
    updateSidebar()
    guard activeNav != .settings else { return }

    let q = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    var list = store.items.filter { item in
      switch activeNav {
      case .all: return true
      case .pinned: return item.pinned
      case .recent: return item.isToday || item.isYesterday
      case .category(let cat): return item.displayCategory == cat
      case .settings: return false
      }
    }
    if !q.isEmpty {
      list = list.filter { item in
        item.displayTitle.lowercased().contains(q)
          || item.effectiveText.lowercased().contains(q)
          || item.sourceLabel.lowercased().contains(q)
          || item.files.contains(where: { $0.lowercased().contains(q) })
      }
    }
    switch sortOrder {
    case .newest:
      break
    case .oldest:
      list.reverse()
    case .title:
      list.sort { $0.displayTitle.localizedCaseInsensitiveCompare($1.displayTitle) == .orderedAscending }
    }

    filteredItems = list
    let validIDs = Set(list.map(\.id))
    multiSelectedIDs = multiSelectedIDs.intersection(validIDs)
    if let sel = selectedID, !validIDs.contains(sel) {
      selectedID = list.first?.id
    } else if selectedID == nil {
      selectedID = list.first?.id
    }

    // Group rows for list view
    listRows = []
    if sortOrder == .title {
      if !list.isEmpty {
        listRows.append(.sectionHeader(title: "按标题", count: list.count))
        listRows.append(contentsOf: list.map { .item($0) })
      }
    } else {
      let today = list.filter(\.isToday)
      let yesterday = list.filter { !$0.isToday && $0.isYesterday }
      let earlier = list.filter { !$0.isToday && !$0.isYesterday }
      let sections: [(String, [LumenClipboardItem])] = sortOrder == .oldest
        ? [("更早", earlier), ("昨天", yesterday), ("今天", today)]
        : [("今天", today), ("昨天", yesterday), ("更早", earlier)]
      for (name, group) in sections where !group.isEmpty {
        listRows.append(.sectionHeader(title: name, count: group.count))
        listRows.append(contentsOf: group.map { .item($0) })
      }
    }

    headingLabel.stringValue = activeNav.title
    subHeadingLabel.stringValue = "\(list.count) 条内容"
    emptyLabel.isHidden = !list.isEmpty
    emptyLabel.stringValue = q.isEmpty ? "暂无剪贴板记录" : "没有匹配“\(searchQuery)”的记录"

    reloadHistoryPresentation()
    renderInspector()
    updateFooter()
  }

  private func reloadHistoryPresentation() {
    listScroll.isHidden = !isListMode
    galleryScroll.isHidden = isListMode
    if isListMode {
      listTable.reloadData()
    } else {
      galleryCollection.reloadData()
    }
    updateFooter()
  }

  private func renderInspector() {
    let palette = LumenPalette.current(store.preferences)
    if multiSelectedIDs.count > 1 {
      let batch = filteredItems.filter { multiSelectedIDs.contains($0.id) }
      inspectorView.render(single: nil, batch: batch, palette: palette)
      return
    }
    let active = filteredItems.first(where: { $0.id == selectedID })
    if let active, (active.kind == "text" || active.kind == "link"), active.text == nil {
      store.hydrateItemDetail(id: active.id) { [weak self] _ in
        self?.renderInspectorIfStillSelected(active.id)
      }
    }
    inspectorView.render(single: active, batch: [], palette: palette)
  }

  private func renderInspectorIfStillSelected(_ id: String) {
    guard selectedID == id, multiSelectedIDs.count <= 1 else { return }
    let palette = LumenPalette.current(store.preferences)
    let active = filteredItems.first(where: { $0.id == id })
    inspectorView.render(single: active, batch: [], palette: palette)
  }

  private func updateFooter() {
    let total = store.items.count
    let pinned = store.items.filter(\.pinned).count
    let multi = multiSelectedIDs.count > 1 ? " · 已选 \(multiSelectedIDs.count) 条" : ""
    footerLeft.stringValue = "\(total) 条记录 · \(pinned) 条固定\(multi)"
  }

  // MARK: Selection Logic (Single + Cmd Toggle + Shift Range)

  private func chooseItem(id: String, modifiers: NSEvent.ModifierFlags, scrollVisible: Bool = false) {
    if modifiers.contains(.shift), let anchor = selectionAnchorID,
       let a = filteredItems.firstIndex(where: { $0.id == anchor }),
       let b = filteredItems.firstIndex(where: { $0.id == id }) {
      let low = min(a, b), high = max(a, b)
      multiSelectedIDs = Set(filteredItems[low...high].map(\.id))
    } else if modifiers.contains(.command) {
      if multiSelectedIDs.isEmpty, let prev = selectedID {
        multiSelectedIDs.insert(prev)
      }
      if multiSelectedIDs.contains(id) {
        multiSelectedIDs.remove(id)
      } else {
        multiSelectedIDs.insert(id)
      }
      selectionAnchorID = id
    } else {
      multiSelectedIDs.removeAll()
      selectionAnchorID = id
    }
    if multiSelectedIDs.count == 1, let only = multiSelectedIDs.first {
      selectedID = only
    } else {
      selectedID = id
    }
    reloadHistoryPresentation()
    renderInspector()
    if scrollVisible {
      scrollSelectionIntoView()
    }
  }

  private func isItemSelected(_ id: String) -> Bool {
    if !multiSelectedIDs.isEmpty {
      return multiSelectedIDs.contains(id)
    }
    return selectedID == id
  }

  private func scrollSelectionIntoView() {
    guard let sel = selectedID else { return }
    if isListMode {
      if let row = listRows.firstIndex(where: { if case .item(let it) = $0 { return it.id == sel } else { return false } }) {
        listTable.scrollRowToVisible(row)
      }
    } else if let idx = filteredItems.firstIndex(where: { $0.id == sel }) {
      galleryCollection.scrollToItems(at: Set([IndexPath(item: idx, section: 0)]), scrollPosition: .centeredVertically)
    }
  }

  // MARK: Actions

  private func copyItem(_ item: LumenClipboardItem) {
    store.copyToOSClipboard(id: item.id) { [weak self] result in
      switch result {
      case .success: self?.toastView.show(message: "已复制到剪贴板")
      case .failure(let err): self?.toastView.show(message: "复制失败：\(err.localizedDescription)")
      }
    }
  }

  private func openPreview(items: [LumenClipboardItem], initialID: String?) {
    guard !items.isEmpty else { return }
    LumenPreviewWindow.shared.open(clipboardItems: items, initialID: initialID)
  }

  private func togglePin(_ item: LumenClipboardItem) {
    let next = !item.pinned
    store.setPinned(id: item.id, pinned: next) { [weak self] result in
      if case .success = result {
        self?.toastView.show(message: next ? "已固定记录" : "已取消固定")
      }
    }
  }

  private func deleteSingle(_ item: LumenClipboardItem) {
    let idx = filteredItems.firstIndex(where: { $0.id == item.id })
    if let idx {
      selectedID = idx + 1 < filteredItems.count ? filteredItems[idx + 1].id : (idx > 0 ? filteredItems[idx - 1].id : nil)
    }
    multiSelectedIDs.remove(item.id)
    store.deleteItem(id: item.id) { [weak self] result in
      if case .success = result {
        self?.toastView.show(message: "已移除剪贴板记录", showUndo: self?.store.canUndoDelete == true)
      }
    }
  }

  private func batchPin(_ items: [LumenClipboardItem]) {
    let ids = items.map(\.id)
    store.batchSetPinned(ids: ids, pinned: true) { [weak self] in
      self?.toastView.show(message: "已固定 \(ids.count) 条记录")
    }
  }

  private func batchDelete(_ items: [LumenClipboardItem]) {
    let ids = items.map(\.id)
    multiSelectedIDs.removeAll()
    store.batchDelete(ids: ids) { [weak self] result in
      if case .success(let deleted) = result {
        self?.toastView.show(message: "已移除 \(deleted) 条记录", showUndo: self?.store.canUndoDelete == true)
      }
    }
  }

  private func undoDelete() {
    store.undoLastDelete { [weak self] result in
      switch result {
      case .success(let restored):
        self?.selectedID = restored.id
        self?.toastView.show(message: "已恢复记录", showUndo: self?.store.canUndoDelete == true)
      case .failure(let err):
        self?.toastView.show(message: err.localizedDescription)
      }
    }
  }

  private func confirmClearAll() {
    let ids = store.items.map(\.id)
    guard !ids.isEmpty else {
      toastView.show(message: "当前没有可清空的记录")
      return
    }
    let alert = NSAlert()
    alert.messageText = "清空全部剪贴板记录？"
    alert.informativeText = "将通过管理接口移除当前列表中的 \(ids.count) 条记录。"
    alert.alertStyle = .warning
    alert.addButton(withTitle: "确认清空")
    alert.addButton(withTitle: "取消")
    alert.beginSheetModal(for: window) { [weak self] response in
      if response == .alertFirstButtonReturn {
        self?.store.batchDelete(ids: ids) { result in
          if case .success(let count) = result {
            self?.toastView.show(message: "已清空 \(count) 条记录")
          }
        }
      }
    }
  }

  @objc private func toggleSidebar() {
    sidebarHidden.toggle()
    sidebarWidthConstraint?.constant = sidebarHidden ? 0 : 204
    leftToolsLeadingConstraint?.constant = sidebarHidden ? 78 : 14
    sidebarView.isHidden = sidebarHidden
    sidebarDivider.isHidden = sidebarHidden
  }

  @objc private func toggleInspector() {
    inspectorHidden.toggle()
    inspectorView.isHidden = inspectorHidden
  }

  @objc private func toggleThemeClicked() {
    store.updatePreferences { prefs in
      prefs.theme = prefs.theme == .light ? .dark : .light
    }
  }

  @objc private func launchOrbitClicked() {
    onOpenOrbit?()
  }

  @objc private func openNewClipSheet() {
    newClipSheet.present(over: window, palette: LumenPalette.current(store.preferences)) { [weak self] text in
      self?.store.createTextItem(text: text) { result in
        switch result {
        case .success(let created):
          self?.selectedID = created.id
          if self?.activeNav == .settings { self?.selectDestination(.all) }
          self?.toastView.show(message: "已保存新记录")
        case .failure(let err):
          self?.toastView.show(message: "保存失败：\(err.localizedDescription)")
        }
      }
    }
  }

  @objc private func openLocalPreview() {
    LumenPreviewWindow.shared.openLocalFilePicker()
  }

  @objc private func sortChanged() {
    sortOrder = SortOrder(rawValue: sortPopup.indexOfSelectedItem) ?? .newest
    rebuildFilteredState()
  }

  @objc private func viewModeChanged() {
    isListMode = viewSegment.selectedSegment == 0
    reloadHistoryPresentation()
  }

  @objc private func listRowClicked() {
    let row = listTable.clickedRow
    guard row >= 0, row < listRows.count, case .item(let item) = listRows[row] else { return }
    chooseItem(id: item.id, modifiers: NSApp.currentEvent?.modifierFlags ?? [])
  }

  @objc private func listRowDoubleClicked() {
    let row = listTable.clickedRow
    guard row >= 0, row < listRows.count, case .item(let item) = listRows[row] else { return }
    copyItem(item)
  }

  private func contextTargetItem() -> LumenClipboardItem? {
    let clicked = listTable.clickedRow
    if isListMode, clicked >= 0, clicked < listRows.count, case .item(let item) = listRows[clicked] {
      return item
    }
    return filteredItems.first(where: { $0.id == selectedID })
  }

  @objc private func contextCopy() { if let item = contextTargetItem() { copyItem(item) } }
  @objc private func contextPreview() {
    guard let item = contextTargetItem() else { return }
    let queue = filteredItems.isEmpty ? [item] : filteredItems
    openPreview(items: queue, initialID: item.id)
  }
  @objc private func contextPin() { if let item = contextTargetItem() { togglePin(item) } }
  @objc private func contextDelete() { if let item = contextTargetItem() { deleteSingle(item) } }

  // MARK: Keyboard Navigation

  private func handleWindowKey(_ event: NSEvent) -> Bool {
    guard activeNav != .settings else { return false }
    let mods = event.modifierFlags.intersection([.command, .option, .control, .shift])
    let isEditingSearch = ((window.firstResponder as? NSTextView)?.delegate as? NSSearchField) === searchField

    if mods == .command, event.charactersIgnoringModifiers?.lowercased() == "f" {
      window.makeFirstResponder(searchField)
      return true
    }
    if mods == .command, event.charactersIgnoringModifiers?.lowercased() == "n" {
      openNewClipSheet()
      return true
    }
    if isEditingSearch {
      if event.keyCode == 53 { // Esc leaves search
        window.makeFirstResponder(listTable)
        return true
      }
      return false
    }
    if mods == .command, event.charactersIgnoringModifiers?.lowercased() == "a" {
      multiSelectedIDs = Set(filteredItems.map(\.id))
      reloadHistoryPresentation()
      renderInspector()
      return true
    }
    if mods == .command, event.charactersIgnoringModifiers?.lowercased() == "z", store.canUndoDelete {
      undoDelete()
      return true
    }
    if mods.isEmpty, event.charactersIgnoringModifiers == "/" {
      window.makeFirstResponder(searchField)
      return true
    }
    if mods.contains(.command) || mods.contains(.option) || mods.contains(.control) {
      return false
    }

    switch event.keyCode {
    case 126, 123: // Up / Left
      stepSelection(-1, modifiers: event.modifierFlags)
      return true
    case 125, 124: // Down / Right
      stepSelection(1, modifiers: event.modifierFlags)
      return true
    case 115: // Home
      if let first = filteredItems.first { chooseItem(id: first.id, modifiers: event.modifierFlags, scrollVisible: true) }
      return true
    case 119: // End
      if let last = filteredItems.last { chooseItem(id: last.id, modifiers: event.modifierFlags, scrollVisible: true) }
      return true
    case 49: // Space -> Quick Look single or batch
      if multiSelectedIDs.count > 1 {
        let batch = filteredItems.filter { multiSelectedIDs.contains($0.id) }
        openPreview(items: batch, initialID: selectedID)
      } else if let item = filteredItems.first(where: { $0.id == selectedID }) {
        openPreview(items: filteredItems, initialID: item.id)
      }
      return true
    case 36: // Enter -> Copy
      if let item = filteredItems.first(where: { $0.id == selectedID }) {
        copyItem(item)
        return true
      }
      return false
    case 51, 117: // Backspace / Forward Delete
      if multiSelectedIDs.count > 1 {
        batchDelete(filteredItems.filter { multiSelectedIDs.contains($0.id) })
      } else if let item = filteredItems.first(where: { $0.id == selectedID }) {
        deleteSingle(item)
      }
      return true
    case 53: // Esc -> clear multi-select
      if !multiSelectedIDs.isEmpty {
        multiSelectedIDs.removeAll()
        reloadHistoryPresentation()
        renderInspector()
        return true
      }
      return false
    default:
      return false
    }
  }

  private func stepSelection(_ delta: Int, modifiers: NSEvent.ModifierFlags) {
    guard !filteredItems.isEmpty else { return }
    let idx = filteredItems.firstIndex(where: { $0.id == selectedID }) ?? 0
    let next = max(0, min(filteredItems.count - 1, idx + delta))
    chooseItem(id: filteredItems[next].id, modifiers: modifiers, scrollVisible: true)
  }

  // MARK: NSSearchFieldDelegate

  func controlTextDidChange(_ obj: Notification) {
    guard let field = obj.object as? NSSearchField, field === searchField else { return }
    searchQuery = field.stringValue
    multiSelectedIDs.removeAll()
    rebuildFilteredState()
  }

  // MARK: NSTableViewDataSource / Delegate

  func numberOfRows(in tableView: NSTableView) -> Int { listRows.count }

  func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
    guard row < listRows.count else { return 58 }
    switch listRows[row] {
    case .sectionHeader: return 28
    case .item: return 58
    }
  }

  func tableView(_ tableView: NSTableView, isGroupRow row: Int) -> Bool {
    guard row < listRows.count else { return false }
    if case .sectionHeader = listRows[row] { return true }
    return false
  }

  func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
    guard row < listRows.count else { return nil }
    let palette = LumenPalette.current(store.preferences)
    switch listRows[row] {
    case .sectionHeader(let title, let count):
      let box = NSView()
      let left = NSTextField(labelWithString: title)
      left.font = .systemFont(ofSize: 10.5, weight: .semibold)
      left.textColor = palette.muted
      left.translatesAutoresizingMaskIntoConstraints = false
      let right = NSTextField(labelWithString: "\(count) 条")
      right.font = .systemFont(ofSize: 10)
      right.textColor = palette.muted
      right.translatesAutoresizingMaskIntoConstraints = false
      box.addSubview(left)
      box.addSubview(right)
      NSLayoutConstraint.activate([
        left.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 12),
        left.centerYAnchor.constraint(equalTo: box.centerYAnchor),
        right.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -12),
        right.centerYAnchor.constraint(equalTo: box.centerYAnchor)
      ])
      return box
    case .item(let item):
      let view = (tableView.makeView(withIdentifier: NSUserInterfaceItemIdentifier("LumenHistoryRow"), owner: nil) as? LumenHistoryRowView) ?? LumenHistoryRowView()
      view.identifier = NSUserInterfaceItemIdentifier("LumenHistoryRow")
      view.configure(item: item, selected: isItemSelected(item.id), palette: palette)
      return view
    }
  }

  // MARK: NSCollectionViewDataSource

  func collectionView(_ collectionView: NSCollectionView, numberOfItemsInSection section: Int) -> Int {
    filteredItems.count
  }

  func collectionView(_ collectionView: NSCollectionView, itemForRepresentedObjectAt indexPath: IndexPath) -> NSCollectionViewItem {
    let cell = collectionView.makeItem(withIdentifier: LumenGalleryCardItem.reuseID, for: indexPath)
    guard let card = cell as? LumenGalleryCardItem, indexPath.item < filteredItems.count else { return cell }
    let item = filteredItems[indexPath.item]
    card.configure(item: item, selected: isItemSelected(item.id), palette: LumenPalette.current(store.preferences))
    card.onSingleClick = { [weak self] event in
      self?.chooseItem(id: item.id, modifiers: event.modifierFlags)
    }
    card.onDoubleClick = { [weak self] in
      self?.copyItem(item)
    }
    card.onRightClick = { [weak self] event in
      guard let self else { return }
      self.chooseItem(id: item.id, modifiers: [])
      let menu = self.makeContextMenu()
      NSMenu.popUpContextMenu(menu, with: event, for: card.view)
    }
    return card
  }

  // MARK: NSWindowDelegate

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    window.orderOut(nil)
    return false
  }
}
