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

/// Pure native AppKit management window for Paste Lumen V15 (zero WebView/HTML).
/// Features:
/// - 10 logical categories with live counts & ContentIdentityRegistry vector glyphs
/// - Zero prototype global footer bar or sidebar "本地资料库" block (§17.3, A54)
/// - Continuous interruptible 380ms left/right panel collapse with non-squishing clipping containers
/// - Lag-free custom splitter drag + keyboard width adjustment (§17.3, A52, A53)
/// - Preserved selection & scroll context across list/gallery toggle, search, and live captures
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

  private struct PaneAnimation {
    let startTime: TimeInterval
    let duration: TimeInterval
    let fromValue: CGFloat
    let toValue: CGFloat
    let onUpdate: (CGFloat, Double) -> Void
    let onFinish: () -> Void
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
  private var sidebarCollapsed = false
  private var inspectorCollapsed = false
  private var preferredInspectorWidth: CGFloat = LumenV15Tokens.inspectorDefaultWidth

  private var filteredItems: [LumenClipboardItem] = []
  private var listRows: [HistoryRowEntry] = []
  private var selectedID: String?
  private var multiSelectedIDs: Set<String> = []
  private var selectionAnchorID: String?

  // Continuous interruptible pane animators (§17.3)
  private var sidebarAnim: PaneAnimation?
  private var inspectorAnim: PaneAnimation?
  private var paneTimer: Timer?

  // Views
  private let rootContainer = NSView()
  private let sidebarClipView = NSView()
  private let sidebarView = LumenSidebarView()
  private let sidebarDivider = NSView()
  private let workspaceContainer = NSView()
  private let toolbarView = NSView()
  private let toolbarDivider = NSView()
  private let toggleSidebarBtn = LumenIconActionButton(glyph: .sidebar, glyphSize: 16, tip: "切换侧边栏")
  private let addBtn = LumenIconActionButton(glyph: .plus, glyphSize: 16, tip: "新建文本记录 (⌘N)")
  private let headingLabel = NSTextField(labelWithString: "所有记录")
  private let subHeadingLabel = NSTextField(labelWithString: "0 条内容")
  private let searchField = NSSearchField()
  private let sortPopup = NSPopUpButton()
  private let viewSegment = NSSegmentedControl()
  private let toggleInspectorBtn = LumenIconActionButton(glyph: .inspector, glyphSize: 16, tip: "切换预览面板")
  private let themeButton = LumenIconActionButton(glyph: .moon, glyphSize: 16, tip: "切换外观")
  private let orbitLaunchButton = NSButton()

  private let contentArea = NSView()
  private let historyHost = NSView()
  private let listScroll = NSScrollView()
  private let listTable = NSTableView()
  private let galleryScroll = NSScrollView()
  private let galleryCollection = NSCollectionView()
  private let emptyLabel = NSTextField(labelWithString: "暂无剪贴板记录")
  private let splitterView = LumenPaneSplitterView()
  private let inspectorClipView = NSView()
  private let inspectorView = LumenInspectorView()
  private let settingsView = LumenSettingsView()
  private let toastView = LumenToastBannerView()
  private let newClipSheet = LumenNewClipSheet()

  // Animated layout constraints
  private var sidebarWidthConstraint: NSLayoutConstraint?
  private var sidebarLeadingConstraint: NSLayoutConstraint?
  private var sidebarDividerWidthConstraint: NSLayoutConstraint?
  private var leftToolsLeadingConstraint: NSLayoutConstraint?
  private var splitterWidthConstraint: NSLayoutConstraint?
  private var inspectorWidthConstraint: NSLayoutConstraint?
  private var inspectorInnerWidthConstraint: NSLayoutConstraint?
  private var inspectorInnerLeadingConstraint: NSLayoutConstraint?

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
    window.setFrameAutosaveName("AIHClipboardWorkspaceV15")
    hostWindow.onKeyEvent = { [weak self] event in self?.handleWindowKey(event) ?? false }

    buildLayout()
    wireCallbacks()
    applyTheme()
    updatePaneAccessibilityAndButtons()

    observerID = store.addObserver { [weak self] event in
      guard let self else { return }
      switch event {
      case .itemsUpdated:
        self.rebuildFilteredState(preserveScrollAndSearchFocus: true)
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
        self.rebuildFilteredState(preserveScrollAndSearchFocus: true)
        if self.activeNav == .settings { self.settingsView.reload() }
      case .error(let msg):
        if self.window.isVisible {
          self.toastView.show(message: msg, showUndo: false)
        }
      }
    }
  }

  deinit {
    paneTimer?.invalidate()
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
    show(selectingItemID: nil)
  }

  func show(selectingItemID targetID: String?) {
    store.ensureConfiguredFromLocalConfig()
    guard isAvailable else { return }
    if !hasPositioned {
      hasPositioned = true
      if !window.setFrameUsingName("AIHClipboardWorkspaceV15") {
        window.setContentSize(NSSize(width: 1220, height: 800))
        window.center()
      }
    }
    if let targetID {
      selectedID = targetID
      multiSelectedIDs.removeAll()
      if activeNav == .settings {
        activeNav = .all
        selectDestination(.all)
      }
    }
    store.refreshAll()
    rebuildFilteredState(preserveScrollAndSearchFocus: false)
    if targetID != nil {
      scrollSelectionIntoView()
    }
    window.makeKeyAndOrderFront(nil)
    window.makeFirstResponder(listTable)
    NSApp.activate(ignoringOtherApps: true)
    _ = NSRunningApplication.current.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
  }

  func hide() {
    window.orderOut(nil)
  }

  // MARK: Layout (Continuous 3-Pane, Zero Global Footer Bar — §17.3, A52–A54)

  private func buildLayout() {
    rootContainer.wantsLayer = true
    window.contentView = rootContainer

    // Clipping container for smooth non-squishing left sidebar collapse
    sidebarClipView.wantsLayer = true
    sidebarClipView.layer?.masksToBounds = true
    sidebarClipView.translatesAutoresizingMaskIntoConstraints = false

    sidebarView.translatesAutoresizingMaskIntoConstraints = false
    sidebarClipView.addSubview(sidebarView)

    sidebarDivider.wantsLayer = true
    sidebarDivider.translatesAutoresizingMaskIntoConstraints = false

    workspaceContainer.wantsLayer = true
    workspaceContainer.translatesAutoresizingMaskIntoConstraints = false

    // Top workspace toolbar
    toolbarView.wantsLayer = true
    toolbarView.translatesAutoresizingMaskIntoConstraints = false
    toolbarDivider.wantsLayer = true
    toolbarDivider.translatesAutoresizingMaskIntoConstraints = false

    for btn in [toggleSidebarBtn, addBtn, toggleInspectorBtn, themeButton] {
      btn.translatesAutoresizingMaskIntoConstraints = false
      btn.widthAnchor.constraint(equalToConstant: 32).isActive = true
      btn.heightAnchor.constraint(equalToConstant: 30).isActive = true
    }

    headingLabel.font = .systemFont(ofSize: 14.5, weight: .semibold)
    headingLabel.translatesAutoresizingMaskIntoConstraints = false
    subHeadingLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
    subHeadingLabel.translatesAutoresizingMaskIntoConstraints = false
    let titleStack = NSStackView(views: [headingLabel, subHeadingLabel])
    titleStack.orientation = .vertical
    titleStack.alignment = .leading
    titleStack.spacing = 1

    let leftTools = NSStackView(views: [toggleSidebarBtn, titleStack, addBtn])
    leftTools.orientation = .horizontal
    leftTools.alignment = .centerY
    leftTools.spacing = 10
    leftTools.translatesAutoresizingMaskIntoConstraints = false

    searchField.placeholderString = "搜索内容或来源 (⌘F)"
    searchField.delegate = self
    searchField.sendsSearchStringImmediately = true
    searchField.translatesAutoresizingMaskIntoConstraints = false
    searchField.widthAnchor.constraint(equalToConstant: 214).isActive = true

    sortPopup.addItems(withTitles: ["最新优先", "最早优先", "按标题"])
    sortPopup.target = self
    sortPopup.action = #selector(sortChanged)
    sortPopup.font = .systemFont(ofSize: 11.5)
    sortPopup.isBordered = false
    sortPopup.translatesAutoresizingMaskIntoConstraints = false

    viewSegment.segmentCount = 2
    viewSegment.setImage(LumenVectorGlyphs.actionImage(.list, size: 15), forSegment: 0)
    viewSegment.setImage(LumenVectorGlyphs.actionImage(.grid, size: 15), forSegment: 1)
    viewSegment.selectedSegment = 0
    viewSegment.trackingMode = .selectOne
    viewSegment.target = self
    viewSegment.action = #selector(viewModeChanged)
    viewSegment.translatesAutoresizingMaskIntoConstraints = false

    orbitLaunchButton.title = " Orbit"
    orbitLaunchButton.image = LumenVectorGlyphs.actionImage(.sparkles, size: 13)
    orbitLaunchButton.imagePosition = .imageLeading
    orbitLaunchButton.isBordered = false
    orbitLaunchButton.wantsLayer = true
    orbitLaunchButton.font = .systemFont(ofSize: 11.5, weight: .semibold)
    orbitLaunchButton.toolTip = "呼出 Orbit 快捷浮层 (⌘⌥V)"
    orbitLaunchButton.target = self
    orbitLaunchButton.action = #selector(launchOrbitClicked)
    orbitLaunchButton.layer?.cornerRadius = 8
    orbitLaunchButton.layer?.cornerCurve = .continuous
    orbitLaunchButton.layer?.borderWidth = 1
    orbitLaunchButton.translatesAutoresizingMaskIntoConstraints = false
    orbitLaunchButton.heightAnchor.constraint(equalToConstant: 28).isActive = true
    orbitLaunchButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 70).isActive = true

    let rightTools = NSStackView(views: [searchField, sortPopup, viewSegment, toggleInspectorBtn, themeButton, orbitLaunchButton])
    rightTools.orientation = .horizontal
    rightTools.alignment = .centerY
    rightTools.spacing = 7
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
    flow.itemSize = NSSize(width: 184, height: 196)
    flow.minimumInteritemSpacing = 12
    flow.minimumLineSpacing = 12
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

    // Custom lag-free splitter + clipping Inspector container (§17.3, A52, A53)
    splitterView.translatesAutoresizingMaskIntoConstraints = false

    inspectorClipView.wantsLayer = true
    inspectorClipView.layer?.masksToBounds = true
    inspectorClipView.translatesAutoresizingMaskIntoConstraints = false

    inspectorView.translatesAutoresizingMaskIntoConstraints = false
    inspectorClipView.addSubview(inspectorView)

    contentArea.wantsLayer = true
    contentArea.translatesAutoresizingMaskIntoConstraints = false
    contentArea.addSubview(historyHost)
    contentArea.addSubview(splitterView)
    contentArea.addSubview(inspectorClipView)

    settingsView.isHidden = true
    settingsView.translatesAutoresizingMaskIntoConstraints = false

    toastView.translatesAutoresizingMaskIntoConstraints = false

    // §17.3 / A54: Zero global bottom footer bar! contentArea & settingsView reach bottomAnchor directly.
    workspaceContainer.addSubview(toolbarView)
    workspaceContainer.addSubview(contentArea)
    workspaceContainer.addSubview(settingsView)
    workspaceContainer.addSubview(toastView)

    rootContainer.addSubview(sidebarClipView)
    rootContainer.addSubview(sidebarDivider)
    rootContainer.addSubview(workspaceContainer)

    let sideW = sidebarClipView.widthAnchor.constraint(equalToConstant: LumenV15Tokens.sidebarExpandedWidth)
    let sideLead = sidebarView.leadingAnchor.constraint(equalTo: sidebarClipView.leadingAnchor, constant: 0)
    let sideDivW = sidebarDivider.widthAnchor.constraint(equalToConstant: 1)
    let leftLead = leftTools.leadingAnchor.constraint(equalTo: toolbarView.leadingAnchor, constant: 14)

    let splitW = splitterView.widthAnchor.constraint(equalToConstant: 5)
    let inspW = inspectorClipView.widthAnchor.constraint(equalToConstant: preferredInspectorWidth)
    let inspInnerW = inspectorView.widthAnchor.constraint(equalToConstant: preferredInspectorWidth)
    let inspInnerLead = inspectorView.leadingAnchor.constraint(equalTo: inspectorClipView.leadingAnchor, constant: 0)

    sidebarWidthConstraint = sideW
    sidebarLeadingConstraint = sideLead
    sidebarDividerWidthConstraint = sideDivW
    leftToolsLeadingConstraint = leftLead
    splitterWidthConstraint = splitW
    inspectorWidthConstraint = inspW
    inspectorInnerWidthConstraint = inspInnerW
    inspectorInnerLeadingConstraint = inspInnerLead

    NSLayoutConstraint.activate([
      sidebarClipView.topAnchor.constraint(equalTo: rootContainer.topAnchor, constant: 28),
      sidebarClipView.leadingAnchor.constraint(equalTo: rootContainer.leadingAnchor),
      sidebarClipView.bottomAnchor.constraint(equalTo: rootContainer.bottomAnchor),
      sideW,

      // Inner sidebar keeps fixed width so text never squishes while collapsing
      sidebarView.topAnchor.constraint(equalTo: sidebarClipView.topAnchor),
      sideLead,
      sidebarView.widthAnchor.constraint(equalToConstant: LumenV15Tokens.sidebarExpandedWidth),
      sidebarView.bottomAnchor.constraint(equalTo: sidebarClipView.bottomAnchor),

      sidebarDivider.topAnchor.constraint(equalTo: rootContainer.topAnchor),
      sidebarDivider.leadingAnchor.constraint(equalTo: sidebarClipView.trailingAnchor),
      sidebarDivider.bottomAnchor.constraint(equalTo: rootContainer.bottomAnchor),
      sideDivW,

      workspaceContainer.topAnchor.constraint(equalTo: rootContainer.topAnchor),
      workspaceContainer.leadingAnchor.constraint(equalTo: sidebarDivider.trailingAnchor),
      workspaceContainer.trailingAnchor.constraint(equalTo: rootContainer.trailingAnchor),
      workspaceContainer.bottomAnchor.constraint(equalTo: rootContainer.bottomAnchor),

      toolbarView.topAnchor.constraint(equalTo: workspaceContainer.topAnchor),
      toolbarView.leadingAnchor.constraint(equalTo: workspaceContainer.leadingAnchor),
      toolbarView.trailingAnchor.constraint(equalTo: workspaceContainer.trailingAnchor),
      toolbarView.heightAnchor.constraint(equalToConstant: 52),

      leftLead,
      leftTools.centerYAnchor.constraint(equalTo: toolbarView.centerYAnchor),
      rightTools.trailingAnchor.constraint(equalTo: toolbarView.trailingAnchor, constant: -14),
      rightTools.centerYAnchor.constraint(equalTo: toolbarView.centerYAnchor),
      leftTools.trailingAnchor.constraint(lessThanOrEqualTo: rightTools.leadingAnchor, constant: -10),

      toolbarDivider.leadingAnchor.constraint(equalTo: toolbarView.leadingAnchor),
      toolbarDivider.trailingAnchor.constraint(equalTo: toolbarView.trailingAnchor),
      toolbarDivider.bottomAnchor.constraint(equalTo: toolbarView.bottomAnchor),
      toolbarDivider.heightAnchor.constraint(equalToConstant: 1),

      contentArea.topAnchor.constraint(equalTo: toolbarView.bottomAnchor),
      contentArea.leadingAnchor.constraint(equalTo: workspaceContainer.leadingAnchor),
      contentArea.trailingAnchor.constraint(equalTo: workspaceContainer.trailingAnchor),
      contentArea.bottomAnchor.constraint(equalTo: workspaceContainer.bottomAnchor),

      historyHost.topAnchor.constraint(equalTo: contentArea.topAnchor),
      historyHost.leadingAnchor.constraint(equalTo: contentArea.leadingAnchor),
      historyHost.bottomAnchor.constraint(equalTo: contentArea.bottomAnchor),
      historyHost.trailingAnchor.constraint(equalTo: splitterView.leadingAnchor),

      splitterView.topAnchor.constraint(equalTo: contentArea.topAnchor),
      splitterView.bottomAnchor.constraint(equalTo: contentArea.bottomAnchor),
      splitterView.trailingAnchor.constraint(equalTo: inspectorClipView.leadingAnchor),
      splitW,

      inspectorClipView.topAnchor.constraint(equalTo: contentArea.topAnchor),
      inspectorClipView.trailingAnchor.constraint(equalTo: contentArea.trailingAnchor),
      inspectorClipView.bottomAnchor.constraint(equalTo: contentArea.bottomAnchor),
      inspW,

      // Inner inspector maintains natural width during collapse so content never stretches
      inspectorView.topAnchor.constraint(equalTo: inspectorClipView.topAnchor),
      inspInnerLead,
      inspInnerW,
      inspectorView.bottomAnchor.constraint(equalTo: inspectorClipView.bottomAnchor),

      settingsView.topAnchor.constraint(equalTo: toolbarView.bottomAnchor),
      settingsView.leadingAnchor.constraint(equalTo: workspaceContainer.leadingAnchor),
      settingsView.trailingAnchor.constraint(equalTo: workspaceContainer.trailingAnchor),
      settingsView.bottomAnchor.constraint(equalTo: workspaceContainer.bottomAnchor),

      toastView.topAnchor.constraint(equalTo: toolbarView.bottomAnchor, constant: 12),
      toastView.centerXAnchor.constraint(equalTo: workspaceContainer.centerXAnchor)
    ])
  }

  private func wireCallbacks() {
    sidebarView.onSelectDestination = { [weak self] dest in
      self?.selectDestination(dest)
    }

    toggleSidebarBtn.onClick = { [weak self] in self?.toggleSidebar() }
    addBtn.onClick = { [weak self] in self?.openNewClipSheet() }
    toggleInspectorBtn.onClick = { [weak self] in self?.toggleInspector() }
    themeButton.onClick = { [weak self] in self?.toggleThemeClicked() }

    // Lag-free splitter dragging (§17.3, A53)
    splitterView.onDragStateChanged = { [weak self] dragging in
      guard let self else { return }
      if dragging {
        self.inspectorAnim = nil
      }
    }
    splitterView.onDragDelta = { [weak self] dx in
      self?.adjustInspectorWidthImmediately(delta: -dx)
    }
    splitterView.onKeyboardStep = { [weak self] delta in
      self?.adjustInspectorWidthImmediately(delta: delta)
    }

    inspectorView.onCopySingle = { [weak self] item in self?.copyItem(item) }
    inspectorView.onPreviewSingle = { [weak self] item in
      guard let self else { return }
      let queue = self.filteredItems.isEmpty ? [item] : self.filteredItems
      self.openPreview(items: queue, initialID: item.id)
    }
    inspectorView.onPinSingle = { [weak self] item in self?.togglePin(item) }
    inspectorView.onEditSingle = { [weak self] item in self?.openEditClipSheet(for: item) }
    inspectorView.onDeleteSingle = { [weak self] item in self?.deleteSingle(item) }
    inspectorView.onBatchPreview = { [weak self] items in self?.openPreview(items: items, initialID: self?.selectedID) }
    inspectorView.onBatchPin = { [weak self] items in self?.batchPin(items) }
    inspectorView.onBatchDelete = { [weak self] items in self?.batchDelete(items) }
    inspectorView.onClearSelection = { [weak self] in
      self?.multiSelectedIDs.removeAll()
      self?.reloadHistoryPresentation(preserveScroll: true)
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

  // MARK: Continuous Interruptible Panel Collapse & Splitter (§17.3, A52, A53)

  private func ensurePaneTimerRunning() {
    guard paneTimer == nil else { return }
    let timer = Timer(timeInterval: 1.0 / 90.0, repeats: true) { [weak self] _ in
      self?.tickPaneAnimations()
    }
    RunLoop.main.add(timer, forMode: .common)
    paneTimer = timer
  }

  private func stopPaneTimerIfIdle() {
    if sidebarAnim == nil && inspectorAnim == nil {
      paneTimer?.invalidate()
      paneTimer = nil
    }
  }

  private func tickPaneAnimations() {
    let now = CACurrentMediaTime()

    if let anim = sidebarAnim {
      let rawT = min(1.0, max(0.0, (now - anim.startTime) / max(0.001, anim.duration)))
      let eased = LumenMotion.easeFluidPane(rawT)
      let current = anim.fromValue + (anim.toValue - anim.fromValue) * CGFloat(eased)
      anim.onUpdate(current, eased)
      if rawT >= 1.0 {
        sidebarAnim = nil
        anim.onFinish()
      }
    }

    if let anim = inspectorAnim {
      let rawT = min(1.0, max(0.0, (now - anim.startTime) / max(0.001, anim.duration)))
      let eased = LumenMotion.easeFluidPane(rawT)
      let current = anim.fromValue + (anim.toValue - anim.fromValue) * CGFloat(eased)
      anim.onUpdate(current, eased)
      if rawT >= 1.0 {
        inspectorAnim = nil
        anim.onFinish()
      }
    }

    stopPaneTimerIfIdle()
  }

  private func toggleSidebar() {
    sidebarCollapsed.toggle()
    let targetW: CGFloat = sidebarCollapsed ? 0 : LumenV15Tokens.sidebarExpandedWidth
    let currentW = sidebarWidthConstraint?.constant ?? (sidebarCollapsed ? LumenV15Tokens.sidebarExpandedWidth : 0)

    // Move focus out if firstResponder was inside collapsing sidebar (§17.3)
    if sidebarCollapsed, let fr = window.firstResponder as? NSView, fr.isDescendant(of: sidebarClipView) {
      window.makeFirstResponder(listTable)
    }

    sidebarClipView.isHidden = false
    sidebarDivider.isHidden = false
    updatePaneAccessibilityAndButtons()

    guard LumenMotion.isEnabled else {
      sidebarAnim = nil
      applySidebarWidth(targetW)
      finalizeSidebarState()
      return
    }

    sidebarAnim = PaneAnimation(
      startTime: CACurrentMediaTime(),
      duration: LumenMotion.paneCollapseDuration,
      fromValue: currentW,
      toValue: targetW,
      onUpdate: { [weak self] width, _ in
        self?.applySidebarWidth(width)
      },
      onFinish: { [weak self] in
        self?.finalizeSidebarState()
      }
    )
    ensurePaneTimerRunning()
  }

  private func applySidebarWidth(_ width: CGFloat) {
    let clamped = max(0, min(LumenV15Tokens.sidebarExpandedWidth, width))
    let openRatio = clamped / LumenV15Tokens.sidebarExpandedWidth
    sidebarWidthConstraint?.constant = clamped
    sidebarDividerWidthConstraint?.constant = openRatio > 0.05 ? 1 : 0
    // Slight outward slide & fade avoids cramped clipping feel
    sidebarLeadingConstraint?.constant = -10.0 * (1.0 - openRatio)
    sidebarView.alphaValue = openRatio
    // Smoothly clear macOS traffic lights (14 -> 78) as sidebar retracts
    leftToolsLeadingConstraint?.constant = 14.0 + 64.0 * (1.0 - openRatio)
  }

  private func finalizeSidebarState() {
    let collapsed = sidebarCollapsed
    applySidebarWidth(collapsed ? 0 : LumenV15Tokens.sidebarExpandedWidth)
    sidebarClipView.isHidden = collapsed
    sidebarDivider.isHidden = collapsed
    updatePaneAccessibilityAndButtons()
  }

  private func toggleInspector() {
    inspectorCollapsed.toggle()
    let maxAllowed = max(LumenV15Tokens.inspectorMinWidth, min(LumenV15Tokens.inspectorMaxWidth, contentArea.bounds.width - 320))
    let expandedW = max(LumenV15Tokens.inspectorMinWidth, min(maxAllowed, preferredInspectorWidth))
    let targetW: CGFloat = inspectorCollapsed ? 0 : expandedW
    let currentW = inspectorWidthConstraint?.constant ?? (inspectorCollapsed ? expandedW : 0)

    if inspectorCollapsed, let fr = window.firstResponder as? NSView, fr.isDescendant(of: inspectorClipView) {
      window.makeFirstResponder(listTable)
    }

    inspectorInnerWidthConstraint?.constant = expandedW
    inspectorClipView.isHidden = false
    splitterView.isHidden = false
    updatePaneAccessibilityAndButtons()

    guard LumenMotion.isEnabled else {
      inspectorAnim = nil
      applyInspectorWidth(targetW, naturalWidth: expandedW)
      finalizeInspectorState(naturalWidth: expandedW)
      return
    }

    inspectorAnim = PaneAnimation(
      startTime: CACurrentMediaTime(),
      duration: LumenMotion.paneCollapseDuration,
      fromValue: currentW,
      toValue: targetW,
      onUpdate: { [weak self] width, _ in
        self?.applyInspectorWidth(width, naturalWidth: expandedW)
      },
      onFinish: { [weak self] in
        self?.finalizeInspectorState(naturalWidth: expandedW)
      }
    )
    ensurePaneTimerRunning()
  }

  private func applyInspectorWidth(_ width: CGFloat, naturalWidth: CGFloat) {
    let clamped = max(0, width)
    let openRatio = naturalWidth > 1 ? min(1, clamped / naturalWidth) : 0
    inspectorWidthConstraint?.constant = clamped
    splitterWidthConstraint?.constant = openRatio > 0.05 ? 5 : 0
    inspectorInnerLeadingConstraint?.constant = 12.0 * (1.0 - openRatio)
    inspectorView.alphaValue = openRatio
    splitterView.alphaValue = openRatio
  }

  private func finalizeInspectorState(naturalWidth: CGFloat) {
    let collapsed = inspectorCollapsed
    applyInspectorWidth(collapsed ? 0 : naturalWidth, naturalWidth: naturalWidth)
    inspectorClipView.isHidden = collapsed
    splitterView.isHidden = collapsed
    updatePaneAccessibilityAndButtons()
  }

  /// Immediate pointer-tracking resize with zero easing lag (§17.3, A53).
  private func adjustInspectorWidthImmediately(delta: CGFloat) {
    guard !inspectorCollapsed else { return }
    inspectorAnim = nil
    let available = max(LumenV15Tokens.inspectorMinWidth, contentArea.bounds.width - 320)
    let upper = min(LumenV15Tokens.inspectorMaxWidth, available)
    let current = inspectorWidthConstraint?.constant ?? preferredInspectorWidth
    let next = max(LumenV15Tokens.inspectorMinWidth, min(upper, current + delta))
    preferredInspectorWidth = next
    inspectorWidthConstraint?.constant = next
    inspectorInnerWidthConstraint?.constant = next
    inspectorInnerLeadingConstraint?.constant = 0
    inspectorView.alphaValue = 1
  }

  private func updatePaneAccessibilityAndButtons() {
    let palette = LumenPalette.current(store.preferences)
    sidebarClipView.setAccessibilityElement(!sidebarCollapsed)
    inspectorClipView.setAccessibilityElement(!inspectorCollapsed)
    splitterView.setAccessibilityElement(!inspectorCollapsed)
    splitterView.setAccessibilityEnabled(!inspectorCollapsed)

    toggleSidebarBtn.configure(palette: palette, toggledOn: sidebarCollapsed)
    toggleSidebarBtn.setAccessibilityExpanded(!sidebarCollapsed)
    toggleSidebarBtn.setAccessibilityValue(sidebarCollapsed ? "已收起" : "已展开")
    toggleInspectorBtn.configure(palette: palette, toggledOn: inspectorCollapsed)
    toggleInspectorBtn.setAccessibilityExpanded(!inspectorCollapsed)
    toggleInspectorBtn.setAccessibilityValue(inspectorCollapsed ? "已收起" : "已展开")
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
    splitterView.applyTheme(palette)

    headingLabel.textColor = palette.ink
    subHeadingLabel.textColor = palette.muted
    emptyLabel.textColor = palette.muted

    addBtn.configure(palette: palette)
    themeButton.configure(glyph: palette.isDark ? .sun : .moon, tip: "切换外观", palette: palette)
    orbitLaunchButton.image = LumenVectorGlyphs.actionImage(.sparkles, size: 13, color: palette.accent)
    orbitLaunchButton.contentTintColor = palette.accent
    orbitLaunchButton.attributedTitle = NSAttributedString(string: " Orbit", attributes: [
      .font: NSFont.systemFont(ofSize: 11.5, weight: .semibold),
      .foregroundColor: palette.accent
    ])
    orbitLaunchButton.layer?.backgroundColor = palette.accentSoft.cgColor
    orbitLaunchButton.layer?.borderColor = palette.accentBorder.cgColor

    updatePaneAccessibilityAndButtons()
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
    contentArea.isHidden = isSettings
    settingsView.isHidden = !isSettings
    searchField.isHidden = isSettings
    sortPopup.isHidden = isSettings
    viewSegment.isHidden = isSettings
    toggleInspectorBtn.isHidden = isSettings
    headingLabel.stringValue = dest.title
    if isSettings {
      subHeadingLabel.stringValue = "自定义 Lumen 原生体验"
      store.refreshSettings()
      store.refreshStatus()
      store.refreshServers()
      settingsView.reload()
    } else {
      rebuildFilteredState(preserveScrollAndSearchFocus: false)
    }
    updateSidebar()
  }

  private func rebuildFilteredState(preserveScrollAndSearchFocus: Bool) {
    updateSidebar()
    guard activeNav != .settings else { return }

    // Preserve search field selection & history scroll position on live updates (§16.4, §17.3, A44, A53)
    let savedListOrigin = listScroll.contentView.bounds.origin
    let savedGalleryOrigin = galleryScroll.contentView.bounds.origin

    let q = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    var list = store.items.filter { item in
      switch activeNav {
      case .all: return true
      case .pinned: return item.pinned
      case .recent: return item.isToday || item.isYesterday
      case .category(let cat): return cat == .all || item.logicalCategory == cat
      case .settings: return false
      }
    }
    if !q.isEmpty {
      list = list.filter { item in
        item.displayTitle.lowercased().contains(q)
          || item.effectiveText.lowercased().contains(q)
          || item.sourceLabel.lowercased().contains(q)
          || item.contentIdentity.displayName.lowercased().contains(q)
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

    // Time groups for list view
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

    reloadHistoryPresentation(preserveScroll: false)
    if preserveScrollAndSearchFocus {
      if isListMode {
        let maxY = max(0, (listScroll.documentView?.frame.height ?? 0) - listScroll.contentView.bounds.height)
        listScroll.contentView.scroll(to: NSPoint(x: savedListOrigin.x, y: min(savedListOrigin.y, maxY)))
        listScroll.reflectScrolledClipView(listScroll.contentView)
      } else {
        let maxY = max(0, (galleryScroll.documentView?.frame.height ?? 0) - galleryScroll.contentView.bounds.height)
        galleryScroll.contentView.scroll(to: NSPoint(x: savedGalleryOrigin.x, y: min(savedGalleryOrigin.y, maxY)))
        galleryScroll.reflectScrolledClipView(galleryScroll.contentView)
      }
    }
    renderInspector()
  }

  private func reloadHistoryPresentation(preserveScroll: Bool) {
    let savedListOrigin = listScroll.contentView.bounds.origin
    let savedGalleryOrigin = galleryScroll.contentView.bounds.origin

    listScroll.isHidden = !isListMode
    galleryScroll.isHidden = isListMode
    if isListMode {
      listTable.reloadData()
      if preserveScroll {
        listScroll.contentView.scroll(to: savedListOrigin)
        listScroll.reflectScrolledClipView(listScroll.contentView)
      }
    } else {
      galleryCollection.reloadData()
      if preserveScroll {
        galleryScroll.contentView.scroll(to: savedGalleryOrigin)
        galleryScroll.reflectScrolledClipView(galleryScroll.contentView)
      }
    }
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
    reloadHistoryPresentation(preserveScroll: true)
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
      case .success:
        self?.inspectorView.showCopySucceededFeedback()
        self?.toastView.show(message: "已复制到剪贴板")
      case .failure(let err):
        self?.toastView.show(message: "复制失败：\(err.localizedDescription)")
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
        self?.scrollSelectionIntoView()
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

  private func toggleThemeClicked() {
    store.updatePreferences { prefs in
      prefs.theme = prefs.theme == .light ? .dark : .light
    }
  }

  @objc private func launchOrbitClicked() {
    onOpenOrbit?()
  }

  private func openNewClipSheet() {
    newClipSheet.present(over: window, initialText: "", title: "新建剪贴板记录", palette: LumenPalette.current(store.preferences)) { [weak self] text in
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

  private func openEditClipSheet(for item: LumenClipboardItem) {
    newClipSheet.present(over: window, initialText: item.effectiveText, title: "编辑记录", palette: LumenPalette.current(store.preferences)) { [weak self] updatedText in
      self?.store.updateTextItem(id: item.id, newText: updatedText) { result in
        switch result {
        case .success(let saved):
          self?.selectedID = saved.id
          self?.toastView.show(message: "已更新记录")
        case .failure(let err):
          self?.toastView.show(message: "更新失败：\(err.localizedDescription)")
        }
      }
    }
  }

  @objc private func sortChanged() {
    sortOrder = SortOrder(rawValue: sortPopup.indexOfSelectedItem) ?? .newest
    rebuildFilteredState(preserveScrollAndSearchFocus: false)
    scrollSelectionIntoView()
  }

  @objc private func viewModeChanged() {
    isListMode = viewSegment.selectedSegment == 0
    reloadHistoryPresentation(preserveScroll: false)
    // Preserve selected record & bring it into view on List <-> Gallery switch (§17.3, A53)
    scrollSelectionIntoView()
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
    let mods = event.modifierFlags.intersection([.command, .option, .control, .shift])

    // ⌘⌥V opens Orbit from Library (standalone AI Home.app)
    if mods == [.command, .option], event.keyCode == 9 {
      onOpenOrbit?()
      return true
    }

    guard activeNav != .settings else { return false }
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
      reloadHistoryPresentation(preserveScroll: true)
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
    case 36, 76: // Enter -> Copy
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
        reloadHistoryPresentation(preserveScroll: true)
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
    rebuildFilteredState(preserveScrollAndSearchFocus: true)
  }

  // MARK: NSTableViewDataSource / Delegate

  func numberOfRows(in tableView: NSTableView) -> Int { listRows.count }

  func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
    guard row < listRows.count else { return 60 }
    switch listRows[row] {
    case .sectionHeader: return 28
    case .item: return 60
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
      left.font = .systemFont(ofSize: 11, weight: .semibold)
      left.textColor = palette.muted
      left.translatesAutoresizingMaskIntoConstraints = false
      let right = NSTextField(labelWithString: "\(count) 条")
      right.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
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

  func windowDidResize(_ notification: Notification) {
    // Keep preferredInspectorWidth safely clamped if window narrows below history minimum
    guard !inspectorCollapsed, inspectorAnim == nil else { return }
    let available = max(LumenV15Tokens.inspectorMinWidth, contentArea.bounds.width - 320)
    let clamped = min(preferredInspectorWidth, available)
    if let current = inspectorWidthConstraint?.constant, abs(current - clamped) > 0.5 {
      inspectorWidthConstraint?.constant = clamped
      inspectorInnerWidthConstraint?.constant = clamped
    }
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    window.orderOut(nil)
    return false
  }
}
