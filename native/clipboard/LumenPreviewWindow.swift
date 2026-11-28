import AppKit
import Foundation
import QuartzCore

private final class LumenPreviewHostPanel: NSPanel {
  var onKeyEvent: ((NSEvent) -> Bool)?
  var onDropFileURLs: (([URL]) -> Void)?

  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }

  override func sendEvent(_ event: NSEvent) {
    if event.type == .keyDown, let handler = onKeyEvent, handler(event) {
      return
    }
    super.sendEvent(event)
  }
}

private final class LumenPreviewDropView: NSView {
  var onDropFileURLs: (([URL]) -> Void)?

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    registerForDraggedTypes([.fileURL])
  }

  required init?(coder: NSCoder) { nil }

  override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
    sender.draggingPasteboard.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) ? .copy : []
  }

  override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
    guard let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
          !urls.isEmpty else {
      return false
    }
    onDropFileURLs?(urls)
    return true
  }
}

/// Shared native Quick Look preview window container used by both the App Management Window
/// and the Orbit overlay. Owns queue navigation, keyboard routing, drag/drop local preview,
/// and mounts format-specific renderers via `LumenPreviewRegistry`.
final class LumenPreviewWindow: NSObject, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate {
  static let shared = LumenPreviewWindow()

  private let panel: LumenPreviewHostPanel
  private let rootView = LumenPreviewDropView()
  private let headerBar = NSView()
  private let headerLine = NSView()
  private let titleLabel = NSTextField(labelWithString: "")
  private let subtitleLabel = NSTextField(labelWithString: "")
  private let counterLabel = NSTextField(labelWithString: "")
  private let queueContainer = NSView()
  private let queueHeaderLabel = NSTextField(labelWithString: "")
  private let queueScroll = NSScrollView()
  private let queueTable = NSTableView()
  private let queueDivider = NSView()
  private let stageContainer = NSView()
  private let footerBar = NSView()
  private let footerLine = NSView()
  private let footerLeftLabel = NSTextField(labelWithString: "")
  private let footerHintsLabel = NSTextField(labelWithString: "← → 切换 · Space 播放/暂停 · ⌘+/− 缩放 · Esc 关闭")
  private var queueWidthConstraint: NSLayoutConstraint?

  private var queue: [LumenPreviewItem] = []
  private var activeIndex = 0
  private var activeRendererView: LumenPreviewRendererView?
  private var isMaximized = false
  private var savedFrame: NSRect?
  private var transitionToken = 0
  private var themeObserverID: UUID?

  var onToast: ((String) -> Void)?

  private override init() {
    panel = LumenPreviewHostPanel(
      contentRect: NSRect(x: 0, y: 0, width: 1040, height: 740),
      styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    super.init()
    panel.title = "Lumen Quick Look"
    panel.titleVisibility = .hidden
    panel.titlebarAppearsTransparent = true
    panel.isReleasedWhenClosed = false
    panel.minSize = NSSize(width: 720, height: 480)
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.delegate = self
    panel.onKeyEvent = { [weak self] event in self?.handleKeyEvent(event) ?? false }
    rootView.onDropFileURLs = { [weak self] urls in self?.presentLocalFiles(urls) }

    buildLayout()
    applyTheme()

    themeObserverID = LumenClipboardStore.shared.addObserver { [weak self] event in
      if case .preferencesUpdated = event {
        self?.applyTheme()
      }
    }
  }

  deinit {
    if let id = themeObserverID {
      LumenClipboardStore.shared.removeObserver(id)
    }
  }

  var isVisible: Bool { panel.isVisible }

  func open(clipboardItems: [LumenClipboardItem], initialID: String? = nil) {
    let flattened = LumenPreviewItem.flatten(clipboardItems)
    guard !flattened.isEmpty else { return }
    let startIdx: Int
    if let initialID, let found = flattened.firstIndex(where: { $0.id == initialID || $0.clipboardItem?.id == initialID }) {
      startIdx = found
    } else {
      startIdx = 0
    }
    present(queue: flattened, startIndex: startIdx)
  }

  func presentLocalFiles(_ urls: [URL]) {
    let items = LumenPreviewItem.fromLocalURLs(urls)
    guard !items.isEmpty else { return }
    present(queue: items, startIndex: 0)
  }

  func openLocalFilePicker() {
    let openPanel = NSOpenPanel()
    openPanel.canChooseFiles = true
    openPanel.canChooseDirectories = false
    openPanel.allowsMultipleSelection = true
    openPanel.title = "选择本地文件进行预览"
    if panel.isVisible {
      openPanel.beginSheetModal(for: panel) { [weak self] response in
        if response == .OK, !openPanel.urls.isEmpty {
          self?.presentLocalFiles(openPanel.urls)
        }
      }
    } else if openPanel.runModal() == .OK, !openPanel.urls.isEmpty {
      presentLocalFiles(openPanel.urls)
    }
  }

  private func present(queue nextQueue: [LumenPreviewItem], startIndex: Int) {
    queue = nextQueue
    activeIndex = max(0, min(nextQueue.count - 1, startIndex))
    updateQueueVisibility()
    queueTable.reloadData()
    mountActiveRenderer(animated: false)
    showAnimated()
  }

  func closeAnimated() {
    guard panel.isVisible else { return }
    transitionToken += 1
    let token = transitionToken
    activeRendererView?.teardown()
    activeRendererView?.removeFromSuperview()
    activeRendererView = nil

    guard LumenMotion.isEnabled else {
      panel.orderOut(nil)
      return
    }
    NSAnimationContext.runAnimationGroup({ ctx in
      ctx.duration = LumenMotion.exitDuration
      ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
      self.panel.animator().alphaValue = 0
    }, completionHandler: { [weak self] in
      guard let self, self.transitionToken == token else { return }
      self.panel.orderOut(nil)
      self.panel.alphaValue = 1
    })
  }

  private func showAnimated() {
    transitionToken += 1
    let token = transitionToken
    let wasVisible = panel.isVisible
    if !wasVisible {
      positionCenteredOnActiveScreen()
      panel.alphaValue = LumenMotion.isEnabled ? 0 : 1
    }
    panel.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    if !wasVisible && LumenMotion.isEnabled {
      NSAnimationContext.runAnimationGroup({ ctx in
        ctx.duration = LumenMotion.enterDuration
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.16, 1, 0.3, 1)
        self.panel.animator().alphaValue = 1
      }, completionHandler: { [weak self] in
        guard let self, self.transitionToken == token else { return }
        self.panel.alphaValue = 1
      })
    }
  }

  private func positionCenteredOnActiveScreen() {
    let pointer = NSEvent.mouseLocation
    let screen = NSScreen.screens.first(where: { NSMouseInRect(pointer, $0.frame, false) }) ?? NSScreen.main ?? NSScreen.screens.first
    guard let visible = screen?.visibleFrame else {
      panel.center()
      return
    }
    let width = min(1060, max(760, visible.width * 0.78))
    let height = min(760, max(540, visible.height * 0.82))
    let x = round(visible.midX - width / 2)
    let y = round(visible.midY - height / 2)
    panel.setFrame(NSRect(x: x, y: y, width: width, height: height), display: false)
  }

  // MARK: Layout & Theme

  private func buildLayout() {
    rootView.wantsLayer = true
    panel.contentView = rootView

    headerBar.wantsLayer = true
    headerBar.translatesAutoresizingMaskIntoConstraints = false
    headerLine.wantsLayer = true
    headerLine.translatesAutoresizingMaskIntoConstraints = false

    titleLabel.font = .systemFont(ofSize: 14, weight: .semibold)
    titleLabel.lineBreakMode = .byTruncatingTail
    titleLabel.translatesAutoresizingMaskIntoConstraints = false

    subtitleLabel.font = .monospacedSystemFont(ofSize: 10, weight: .medium)
    subtitleLabel.lineBreakMode = .byTruncatingTail
    subtitleLabel.translatesAutoresizingMaskIntoConstraints = false

    let identityStack = NSStackView(views: [titleLabel, subtitleLabel])
    identityStack.orientation = .vertical
    identityStack.alignment = .leading
    identityStack.spacing = 2
    identityStack.translatesAutoresizingMaskIntoConstraints = false

    let prevBtn = makeHeaderIconButton("chevron.left", tip: "上一项 (←)", action: #selector(stepPrevClicked))
    let nextBtn = makeHeaderIconButton("chevron.right", tip: "下一项 (→)", action: #selector(stepNextClicked))
    let importBtn = makeHeaderIconButton("plus", tip: "导入本地文件", action: #selector(importLocalClicked))
    let copyBtn = makeHeaderIconButton("doc.on.doc", tip: "复制 (⌘C)", action: #selector(copyActiveClicked))
    let maxBtn = makeHeaderIconButton("arrow.up.left.and.arrow.down.right", tip: "最大化/还原", action: #selector(toggleMaximize))

    counterLabel.font = .monospacedDigitSystemFont(ofSize: 11.5, weight: .medium)
    counterLabel.translatesAutoresizingMaskIntoConstraints = false

    let actionsStack = NSStackView(views: [prevBtn, counterLabel, nextBtn, importBtn, copyBtn, maxBtn])
    actionsStack.orientation = .horizontal
    actionsStack.spacing = 6
    actionsStack.translatesAutoresizingMaskIntoConstraints = false

    headerBar.addSubview(identityStack)
    headerBar.addSubview(actionsStack)
    headerBar.addSubview(headerLine)

    // Queue sidebar
    queueContainer.wantsLayer = true
    queueContainer.translatesAutoresizingMaskIntoConstraints = false
    queueDivider.wantsLayer = true
    queueDivider.translatesAutoresizingMaskIntoConstraints = false

    queueHeaderLabel.font = .systemFont(ofSize: 11, weight: .semibold)
    queueHeaderLabel.translatesAutoresizingMaskIntoConstraints = false

    let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("queue"))
    col.resizingMask = .autoresizingMask
    queueTable.addTableColumn(col)
    queueTable.headerView = nil
    queueTable.rowHeight = 52
    queueTable.intercellSpacing = NSSize(width: 0, height: 4)
    queueTable.backgroundColor = .clear
    queueTable.selectionHighlightStyle = .none
    queueTable.dataSource = self
    queueTable.delegate = self
    queueTable.target = self
    queueTable.action = #selector(queueRowClicked)

    queueScroll.documentView = queueTable
    queueScroll.hasVerticalScroller = true
    queueScroll.drawsBackground = false
    queueScroll.borderType = .noBorder
    queueScroll.translatesAutoresizingMaskIntoConstraints = false

    queueContainer.addSubview(queueHeaderLabel)
    queueContainer.addSubview(queueScroll)

    // Renderer stage
    stageContainer.wantsLayer = true
    stageContainer.translatesAutoresizingMaskIntoConstraints = false

    // Footer bar
    footerBar.wantsLayer = true
    footerBar.translatesAutoresizingMaskIntoConstraints = false
    footerLine.wantsLayer = true
    footerLine.translatesAutoresizingMaskIntoConstraints = false

    footerLeftLabel.font = .systemFont(ofSize: 11)
    footerLeftLabel.lineBreakMode = .byTruncatingTail
    footerLeftLabel.translatesAutoresizingMaskIntoConstraints = false

    let footerImportBtn = NSButton(title: "＋ 本地文件预览", target: self, action: #selector(importLocalClicked))
    footerImportBtn.isBordered = false
    footerImportBtn.font = .systemFont(ofSize: 11, weight: .medium)
    footerImportBtn.translatesAutoresizingMaskIntoConstraints = false

    footerHintsLabel.font = .systemFont(ofSize: 10.5)
    footerHintsLabel.translatesAutoresizingMaskIntoConstraints = false

    footerBar.addSubview(footerLine)
    footerBar.addSubview(footerLeftLabel)
    footerBar.addSubview(footerImportBtn)
    footerBar.addSubview(footerHintsLabel)

    rootView.addSubview(headerBar)
    rootView.addSubview(queueContainer)
    rootView.addSubview(queueDivider)
    rootView.addSubview(stageContainer)
    rootView.addSubview(footerBar)

    let qWidth = queueContainer.widthAnchor.constraint(equalToConstant: 236)
    queueWidthConstraint = qWidth

    NSLayoutConstraint.activate([
      headerBar.topAnchor.constraint(equalTo: rootView.topAnchor),
      headerBar.leadingAnchor.constraint(equalTo: rootView.leadingAnchor),
      headerBar.trailingAnchor.constraint(equalTo: rootView.trailingAnchor),
      headerBar.heightAnchor.constraint(equalToConstant: 56),

      identityStack.leadingAnchor.constraint(equalTo: headerBar.leadingAnchor, constant: 78),
      identityStack.centerYAnchor.constraint(equalTo: headerBar.centerYAnchor),
      identityStack.trailingAnchor.constraint(lessThanOrEqualTo: actionsStack.leadingAnchor, constant: -14),

      actionsStack.trailingAnchor.constraint(equalTo: headerBar.trailingAnchor, constant: -16),
      actionsStack.centerYAnchor.constraint(equalTo: headerBar.centerYAnchor),

      headerLine.leadingAnchor.constraint(equalTo: headerBar.leadingAnchor),
      headerLine.trailingAnchor.constraint(equalTo: headerBar.trailingAnchor),
      headerLine.bottomAnchor.constraint(equalTo: headerBar.bottomAnchor),
      headerLine.heightAnchor.constraint(equalToConstant: 1),

      queueContainer.topAnchor.constraint(equalTo: headerBar.bottomAnchor),
      queueContainer.leadingAnchor.constraint(equalTo: rootView.leadingAnchor),
      queueContainer.bottomAnchor.constraint(equalTo: footerBar.topAnchor),
      qWidth,

      queueHeaderLabel.topAnchor.constraint(equalTo: queueContainer.topAnchor, constant: 12),
      queueHeaderLabel.leadingAnchor.constraint(equalTo: queueContainer.leadingAnchor, constant: 14),
      queueHeaderLabel.trailingAnchor.constraint(equalTo: queueContainer.trailingAnchor, constant: -12),

      queueScroll.topAnchor.constraint(equalTo: queueHeaderLabel.bottomAnchor, constant: 8),
      queueScroll.leadingAnchor.constraint(equalTo: queueContainer.leadingAnchor, constant: 8),
      queueScroll.trailingAnchor.constraint(equalTo: queueContainer.trailingAnchor, constant: -8),
      queueScroll.bottomAnchor.constraint(equalTo: queueContainer.bottomAnchor, constant: -8),

      queueDivider.topAnchor.constraint(equalTo: headerBar.bottomAnchor),
      queueDivider.leadingAnchor.constraint(equalTo: queueContainer.trailingAnchor),
      queueDivider.bottomAnchor.constraint(equalTo: footerBar.topAnchor),
      queueDivider.widthAnchor.constraint(equalToConstant: 1),

      stageContainer.topAnchor.constraint(equalTo: headerBar.bottomAnchor),
      stageContainer.leadingAnchor.constraint(equalTo: queueDivider.trailingAnchor),
      stageContainer.trailingAnchor.constraint(equalTo: rootView.trailingAnchor),
      stageContainer.bottomAnchor.constraint(equalTo: footerBar.topAnchor),

      footerBar.leadingAnchor.constraint(equalTo: rootView.leadingAnchor),
      footerBar.trailingAnchor.constraint(equalTo: rootView.trailingAnchor),
      footerBar.bottomAnchor.constraint(equalTo: rootView.bottomAnchor),
      footerBar.heightAnchor.constraint(equalToConstant: 38),

      footerLine.topAnchor.constraint(equalTo: footerBar.topAnchor),
      footerLine.leadingAnchor.constraint(equalTo: footerBar.leadingAnchor),
      footerLine.trailingAnchor.constraint(equalTo: footerBar.trailingAnchor),
      footerLine.heightAnchor.constraint(equalToConstant: 1),

      footerLeftLabel.leadingAnchor.constraint(equalTo: footerBar.leadingAnchor, constant: 16),
      footerLeftLabel.centerYAnchor.constraint(equalTo: footerBar.centerYAnchor),

      footerImportBtn.centerXAnchor.constraint(equalTo: footerBar.centerXAnchor),
      footerImportBtn.centerYAnchor.constraint(equalTo: footerBar.centerYAnchor),

      footerHintsLabel.trailingAnchor.constraint(equalTo: footerBar.trailingAnchor, constant: -16),
      footerHintsLabel.centerYAnchor.constraint(equalTo: footerBar.centerYAnchor)
    ])
  }

  private func makeHeaderIconButton(_ symbol: String, tip: String, action: Selector) -> NSButton {
    let btn = NSButton()
    btn.isBordered = false
    btn.wantsLayer = true
    btn.image = LumenIcons.symbol(symbol, size: 14, weight: .medium, description: tip)
    btn.toolTip = tip
    btn.target = self
    btn.action = action
    btn.layer?.cornerRadius = 8
    btn.translatesAutoresizingMaskIntoConstraints = false
    btn.widthAnchor.constraint(equalToConstant: 30).isActive = true
    btn.heightAnchor.constraint(equalToConstant: 30).isActive = true
    return btn
  }

  private func applyTheme() {
    let palette = LumenPalette.current()
    panel.appearance = palette.nsAppearance
    panel.backgroundColor = palette.surface
    rootView.layer?.backgroundColor = palette.surface.cgColor
    headerBar.layer?.backgroundColor = palette.surface.cgColor
    headerLine.layer?.backgroundColor = palette.border.cgColor
    queueContainer.layer?.backgroundColor = palette.sidebarBackgroundBottom.cgColor
    queueDivider.layer?.backgroundColor = palette.border.cgColor
    stageContainer.layer?.backgroundColor = palette.windowBackground.cgColor
    footerBar.layer?.backgroundColor = palette.surface.cgColor
    footerLine.layer?.backgroundColor = palette.border.cgColor
    titleLabel.textColor = palette.ink
    subtitleLabel.textColor = palette.muted
    counterLabel.textColor = palette.muted
    queueHeaderLabel.textColor = palette.muted
    footerLeftLabel.textColor = palette.muted
    footerHintsLabel.textColor = palette.muted
    if !queue.isEmpty {
      queueTable.reloadData()
      mountActiveRenderer(animated: false)
    }
  }

  // MARK: Queue & Renderer Mounting

  private func updateQueueVisibility() {
    let showQueue = queue.count > 1
    queueContainer.isHidden = !showQueue
    queueDivider.isHidden = !showQueue
    queueWidthConstraint?.constant = showQueue ? 236 : 0
    let audioOnly = !queue.isEmpty && queue.allSatisfy { $0.kind == .audio }
    queueHeaderLabel.stringValue = "\(audioOnly ? "播放队列" : "文件集合") · \(queue.count)"
  }

  private func mountActiveRenderer(animated: Bool) {
    guard activeIndex >= 0, activeIndex < queue.count else { return }
    let item = queue[activeIndex]
    let palette = LumenPalette.current()

    titleLabel.stringValue = item.title
    subtitleLabel.stringValue = "QUICK LOOK  /  \(item.kind.displayLabel.uppercased())"
    counterLabel.stringValue = "\(activeIndex + 1) / \(queue.count)"
    footerLeftLabel.stringValue = "\(item.kind.displayLabel) · \(item.sizeLabel)"

    activeRendererView?.teardown()
    activeRendererView?.removeFromSuperview()

    let ctx = LumenPreviewContext(
      store: LumenClipboardStore.shared,
      cache: LumenPreviewCache.shared,
      palette: palette,
      onStepQueue: { [weak self] delta, _ in self?.stepQueue(delta) },
      onSelectQueueIndex: { [weak self] idx in self?.selectQueueIndex(idx) },
      onToast: { [weak self] msg in self?.onToast?(msg) },
      onCopyItem: { [weak self] previewItem in self?.copyPreviewItem(previewItem) }
    )
    let view = LumenPreviewRegistry.shared.makeView(for: item, context: ctx)
    view.translatesAutoresizingMaskIntoConstraints = false
    stageContainer.addSubview(view)
    NSLayoutConstraint.activate([
      view.topAnchor.constraint(equalTo: stageContainer.topAnchor),
      view.leadingAnchor.constraint(equalTo: stageContainer.leadingAnchor),
      view.trailingAnchor.constraint(equalTo: stageContainer.trailingAnchor),
      view.bottomAnchor.constraint(equalTo: stageContainer.bottomAnchor)
    ])
    activeRendererView = view

    if animated && LumenMotion.isEnabled, let layer = view.layer {
      let group = CAAnimationGroup()
      group.duration = LumenMotion.switchDuration
      group.timingFunction = CAMediaTimingFunction(controlPoints: 0.16, 1, 0.3, 1)
      let fade = CABasicAnimation(keyPath: "opacity")
      fade.fromValue = 0.25
      fade.toValue = 1.0
      let slide = CABasicAnimation(keyPath: "transform.translation.y")
      slide.fromValue = -8.0
      slide.toValue = 0.0
      group.animations = [fade, slide]
      layer.add(group, forKey: "lumenPreviewSwap")
    }
  }

  private func selectQueueIndex(_ idx: Int) {
    guard idx >= 0, idx < queue.count, idx != activeIndex else { return }
    activeIndex = idx
    queueTable.reloadData()
    queueTable.scrollRowToVisible(idx)
    mountActiveRenderer(animated: true)
  }

  private func stepQueue(_ delta: Int) {
    let next = activeIndex + delta
    guard next >= 0, next < queue.count else { return }
    selectQueueIndex(next)
  }

  private func copyPreviewItem(_ item: LumenPreviewItem) {
    if let clip = item.clipboardItem {
      LumenClipboardStore.shared.copyToOSClipboard(id: clip.id) { [weak self] result in
        switch result {
        case .success: self?.onToast?("已复制到剪贴板")
        case .failure(let err): self?.onToast?("复制失败：\(err.localizedDescription)")
        }
      }
      return
    }
    if let url = item.localURL {
      let pb = NSPasteboard.general
      pb.clearContents()
      pb.writeObjects([url as NSURL])
      onToast?("已复制文件引用")
    }
  }

  // MARK: Actions & Keyboard Navigation

  @objc private func stepPrevClicked() { stepQueue(-1) }
  @objc private func stepNextClicked() { stepQueue(1) }
  @objc private func importLocalClicked() { openLocalFilePicker() }
  @objc private func copyActiveClicked() { activeRendererView?.copyPrimaryContent() }

  @objc private func toggleMaximize() {
    if isMaximized, let saved = savedFrame {
      isMaximized = false
      panel.setFrame(saved, display: true, animate: LumenMotion.isEnabled)
    } else {
      savedFrame = panel.frame
      isMaximized = true
      if let visible = panel.screen?.visibleFrame {
        let target = visible.insetBy(dx: 16, dy: 16)
        panel.setFrame(target, display: true, animate: LumenMotion.isEnabled)
      }
    }
  }

  @objc private func queueRowClicked() {
    let row = queueTable.clickedRow
    if row >= 0 { selectQueueIndex(row) }
  }

  private func handleKeyEvent(_ event: NSEvent) -> Bool {
    let mods = event.modifierFlags.intersection([.command, .option, .control, .shift])
    switch event.keyCode {
    case 53: // Esc
      closeAnimated()
      return true
    case 123: // Left arrow
      if queue.count > 1 {
        stepQueue(-1)
        return true
      }
      return activeRendererView?.stepPage(-1) ?? false
    case 124: // Right arrow
      if queue.count > 1 {
        stepQueue(1)
        return true
      }
      return activeRendererView?.stepPage(1) ?? false
    case 49: // Space
      if activeRendererView?.togglePlayPause() == true {
        return true
      }
      closeAnimated()
      return true
    case 116, 33: // PageUp / [
      return activeRendererView?.stepPage(-1) ?? false
    case 121, 30: // PageDown / ]
      return activeRendererView?.stepPage(1) ?? false
    case 24 where mods == .command: // Cmd +
      activeRendererView?.zoomIn()
      return true
    case 27 where mods == .command: // Cmd -
      activeRendererView?.zoomOut()
      return true
    case 29 where mods == .command: // Cmd 0
      activeRendererView?.resetZoom()
      return true
    case 8 where mods == .command: // Cmd C
      if panel.firstResponder is NSTextView { return false }
      activeRendererView?.copyPrimaryContent()
      return true
    case 36: // Enter
      activeRendererView?.copyPrimaryContent()
      return true
    default:
      return false
    }
  }

  // MARK: NSTableViewDataSource / Delegate

  func numberOfRows(in tableView: NSTableView) -> Int { queue.count }

  func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
    guard row < queue.count else { return nil }
    let item = queue[row]
    let selected = row == activeIndex
    let palette = LumenPalette.current()

    let cell = NSView()
    cell.wantsLayer = true
    cell.layer?.cornerRadius = 9
    cell.layer?.cornerCurve = .continuous
    cell.layer?.backgroundColor = (selected ? palette.accentSoft : NSColor.clear).cgColor
    cell.layer?.borderWidth = selected ? 1 : 0
    cell.layer?.borderColor = (selected ? palette.accentBorder : NSColor.clear).cgColor

    let thumbBox = NSView()
    thumbBox.wantsLayer = true
    thumbBox.layer?.cornerRadius = 7
    thumbBox.layer?.backgroundColor = palette.surfaceElevated.cgColor
    thumbBox.layer?.masksToBounds = true
    thumbBox.translatesAutoresizingMaskIntoConstraints = false

    if item.kind == .audio {
      let miniCover = LumenAlbumCoverView()
      miniCover.seedIndex = item.seedIndex
      miniCover.badgeText = ""
      miniCover.translatesAutoresizingMaskIntoConstraints = false
      thumbBox.addSubview(miniCover)
      NSLayoutConstraint.activate([
        miniCover.topAnchor.constraint(equalTo: thumbBox.topAnchor),
        miniCover.leadingAnchor.constraint(equalTo: thumbBox.leadingAnchor),
        miniCover.trailingAnchor.constraint(equalTo: thumbBox.trailingAnchor),
        miniCover.bottomAnchor.constraint(equalTo: thumbBox.bottomAnchor)
      ])
    } else {
      let badge = NSTextField(labelWithString: item.kind.badgeCode)
      badge.font = .monospacedSystemFont(ofSize: 9.5, weight: .bold)
      badge.textColor = palette.accent
      badge.alignment = .center
      badge.translatesAutoresizingMaskIntoConstraints = false
      thumbBox.addSubview(badge)
      NSLayoutConstraint.activate([
        badge.centerXAnchor.constraint(equalTo: thumbBox.centerXAnchor),
        badge.centerYAnchor.constraint(equalTo: thumbBox.centerYAnchor)
      ])
    }

    let nameLabel = NSTextField(labelWithString: item.title)
    nameLabel.font = .systemFont(ofSize: 12, weight: selected ? .semibold : .medium)
    nameLabel.textColor = palette.ink
    nameLabel.lineBreakMode = .byTruncatingMiddle
    nameLabel.translatesAutoresizingMaskIntoConstraints = false

    let subLabel = NSTextField(labelWithString: "\(item.kind.displayLabel) · \(item.sizeLabel)")
    subLabel.font = .systemFont(ofSize: 10)
    subLabel.textColor = palette.muted
    subLabel.lineBreakMode = .byTruncatingTail
    subLabel.translatesAutoresizingMaskIntoConstraints = false

    let idxLabel = NSTextField(labelWithString: selected ? "●" : String(format: "%02d", row + 1))
    idxLabel.font = .monospacedDigitSystemFont(ofSize: 10, weight: .semibold)
    idxLabel.textColor = selected ? palette.accent : palette.muted
    idxLabel.translatesAutoresizingMaskIntoConstraints = false

    cell.addSubview(thumbBox)
    cell.addSubview(nameLabel)
    cell.addSubview(subLabel)
    cell.addSubview(idxLabel)

    NSLayoutConstraint.activate([
      thumbBox.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 8),
      thumbBox.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
      thumbBox.widthAnchor.constraint(equalToConstant: 34),
      thumbBox.heightAnchor.constraint(equalToConstant: 34),

      nameLabel.topAnchor.constraint(equalTo: cell.topAnchor, constant: 9),
      nameLabel.leadingAnchor.constraint(equalTo: thumbBox.trailingAnchor, constant: 9),
      nameLabel.trailingAnchor.constraint(lessThanOrEqualTo: idxLabel.leadingAnchor, constant: -6),

      subLabel.topAnchor.constraint(equalTo: nameLabel.bottomAnchor, constant: 2),
      subLabel.leadingAnchor.constraint(equalTo: nameLabel.leadingAnchor),
      subLabel.trailingAnchor.constraint(lessThanOrEqualTo: idxLabel.leadingAnchor, constant: -6),

      idxLabel.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -10),
      idxLabel.centerYAnchor.constraint(equalTo: cell.centerYAnchor)
    ])
    return cell
  }

  // MARK: NSWindowDelegate

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    closeAnimated()
    return false
  }
}
