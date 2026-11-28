import AppKit
import Darwin
import Foundation

// MARK: - Folder Preview Limits & Safety Model (§7, A61, A77)

enum LumenFolderLimits {
  /// Default automatic expansion depth below root (Level 1 = root children, Level 2 = first subfolder level).
  static let defaultAutoExpandDepth = 2
  /// Hard node cap across the entire tree to guarantee bounded memory and responsive UI.
  static let maxTotalNodes = 5_000
  /// Maximum nesting depth permitted in the tree view to handle pathological deep paths deterministically.
  static let maxDepth = 32
  /// Per-directory / batch enumeration timeout (>2s reports an inline timeout row without blocking UI).
  static let scanTimeoutSeconds: TimeInterval = 2.0

  static let packageExtensions: Set<String> = [
    "app", "bundle", "framework", "kext", "plugin", "xpc",
    "xcodeproj", "xcworkspace", "playground", "rtfd",
    "pages", "numbers", "key", "appex", "prefpane",
    "qlgenerator", "mdimporter", "saver", "wdgt", "pkg", "mpkg"
  ]
}

enum LumenFolderScanError: Equatable {
  case notFound
  case permissionDenied
  case timedOut
  case notADirectory
  case ioError(String)

  var title: String {
    switch self {
    case .notFound: return "目录不存在或已移动"
    case .permissionDenied: return "没有权限访问此目录"
    case .timedOut: return "读取目录超时（> 2 秒）"
    case .notADirectory: return "目标不是有效目录"
    case .ioError: return "读取目录失败"
    }
  }

  var detail: String {
    switch self {
    case .notFound:
      return "目标路径在磁盘上不存在，可能已被移动、重命名或卸载。"
    case .permissionDenied:
      return "系统拒绝读取该目录内容（权限不足）。请检查 macOS 隐私与文件访问权限，或在访达中确认权限。"
    case .timedOut:
      return "目录扫描超过 2 秒未完成（可能位于较慢的网络卷或包含极大量条目），已自动停止以避免界面卡顿。"
    case .notADirectory:
      return "该路径指向的不是目录，无法作为文件夹树展开。"
    case .ioError(let msg):
      return msg.isEmpty ? "文件系统返回未知读取错误。" : msg
    }
  }

  var shortInlineTag: String {
    switch self {
    case .notFound: return "路径不存在"
    case .permissionDenied: return "权限不足"
    case .timedOut: return "读取超时 (>2s)"
    case .notADirectory: return "非目录"
    case .ioError: return "读取失败"
    }
  }

  var isRetryable: Bool {
    switch self {
    case .timedOut, .permissionDenied, .ioError:
      return true
    case .notFound, .notADirectory:
      return false
    }
  }
}

/// Thread-safe cooperative cancellation token for background directory scans.
private final class LumenFolderCancelToken {
  private let lock = NSLock()
  private var cancelled = false

  var isCancelled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelled
  }

  func cancel() {
    lock.lock()
    cancelled = true
    lock.unlock()
  }
}

/// Shared locale-aware date formatter for directory entry modification timestamps (main thread only).
private enum LumenFolderDateFormatter {
  static let shared: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale.current
    f.dateStyle = .short
    f.timeStyle = .short
    f.doesRelativeDateFormatting = true
    return f
  }()

  static func format(_ date: Date?) -> String {
    guard let date else { return "时间未知" }
    return shared.string(from: date)
  }
}

// MARK: - Read-Only Directory Tree Node Model

final class LumenFolderNode {
  enum Kind: Equatable {
    case directory(isPackage: Bool)
    case regularFile
    case symlink(target: String?, pointsOutsideRoot: Bool)
    case loadingPlaceholder
    case emptyNotice(hiddenCount: Int)
    case errorRow(LumenFolderScanError)
    case limitNotice(String)
  }

  enum LoadState: Equatable {
    case notLoaded
    case loading
    case loaded
    case failed(LumenFolderScanError)
  }

  let id: String
  let url: URL
  let name: String
  let relativePath: String
  let depth: Int
  let kind: Kind
  let isHidden: Bool
  /// Byte size is ONLY populated for real regular files; directories, symlinks, and unreadable entries stay `nil` (never path byte length or inode size).
  let byteSize: Int64?
  let modifiedAt: Date?
  let isReadable: Bool
  let identity: LumenContentIdentity

  var loadState: LoadState
  var children: [LumenFolderNode] = []
  var hiddenDirectCount: Int = 0
  weak var parent: LumenFolderNode?

  init(
    id: String,
    url: URL,
    name: String,
    relativePath: String,
    depth: Int,
    kind: Kind,
    isHidden: Bool,
    byteSize: Int64?,
    modifiedAt: Date?,
    isReadable: Bool,
    identity: LumenContentIdentity,
    loadState: LoadState = .notLoaded
  ) {
    self.id = id
    self.url = url
    self.name = name
    self.relativePath = relativePath
    self.depth = depth
    self.kind = kind
    self.isHidden = isHidden
    self.byteSize = byteSize
    self.modifiedAt = modifiedAt
    self.isReadable = isReadable
    self.identity = identity
    self.loadState = loadState
  }

  var isDirectory: Bool {
    if case .directory = kind { return true }
    return false
  }

  var isPackage: Bool {
    if case .directory(let isPkg) = kind { return isPkg }
    return false
  }

  var isSymlink: Bool {
    if case .symlink = kind { return true }
    return false
  }

  var isRealEntry: Bool {
    switch kind {
    case .directory, .regularFile, .symlink:
      return true
    case .loadingPlaceholder, .emptyNotice, .errorRow, .limitNotice:
      return false
    }
  }

  var isExpandableInTree: Bool {
    guard isDirectory && !isSymlink else { return false }
    if loadState == .notLoaded { return true }
    return !children.isEmpty
  }

  var formattedSizeText: String {
    switch kind {
    case .regularFile:
      if let size = byteSize, size >= 0 {
        return LumenFormatters.byteCount(size)
      }
      return "未知"
    case .directory(let isPkg):
      return isPkg ? "包" : "目录"
    case .symlink:
      return "链接"
    case .loadingPlaceholder, .emptyNotice, .errorRow, .limitNotice:
      return ""
    }
  }

  var displayTypeTag: String {
    switch kind {
    case .directory(let isPkg):
      return isPkg ? "程序包" : "文件夹"
    case .symlink(_, let outside):
      return outside ? "外部链接" : "符号链接"
    case .regularFile:
      return identity.displayName
    case .loadingPlaceholder:
      return "正在读取"
    case .emptyNotice:
      return "空目录"
    case .errorRow(let err):
      return err.shortInlineTag
    case .limitNotice:
      return "已截断"
    }
  }
}

// MARK: - Safe Read-Only Directory Scanner (Background, Symlink-Safe, Timeout & Limit Bounded)

private struct LumenFolderScannedEntry {
  let url: URL
  let name: String
  let relativePath: String
  let kind: LumenFolderNode.Kind
  let isHidden: Bool
  let byteSize: Int64?
  let modifiedAt: Date?
  let isReadable: Bool
  let identity: LumenContentIdentity
}

private struct LumenFolderScanOutcome {
  let entries: [LumenFolderScannedEntry]
  let hiddenSkippedCount: Int
  let error: LumenFolderScanError?
  let truncatedByLimit: Bool
}

/// Strictly read-only filesystem reader. Never writes, moves, deletes, executes, or follows symlinks outside root.
private enum LumenFolderScanner {
  private static let resourceKeys: Set<URLResourceKey> = [
    .isDirectoryKey,
    .isRegularFileKey,
    .isSymbolicLinkKey,
    .isPackageKey,
    .isHiddenKey,
    .fileSizeKey,
    .contentModificationDateKey,
    .isReadableKey
  ]

  static func canonicalRootPath(for url: URL) -> String {
    let resolved = url.resolvingSymlinksInPath().standardizedFileURL.path
    if resolved.count > 1 && resolved.hasSuffix("/") {
      return String(resolved.dropLast())
    }
    return resolved
  }

  static func isPathWithinRoot(_ candidatePath: String, canonicalRoot: String) -> Bool {
    var clean = candidatePath
    if clean.count > 1 && clean.hasSuffix("/") {
      clean.removeLast()
    }
    if canonicalRoot == "/" {
      return clean.hasPrefix("/")
    }
    return clean == canonicalRoot || clean.hasPrefix(canonicalRoot + "/")
  }

  static func isPackageDirectory(url: URL, resourceIsPackage: Bool?) -> Bool {
    if resourceIsPackage == true { return true }
    let ext = url.pathExtension.lowercased()
    return !ext.isEmpty && LumenFolderLimits.packageExtensions.contains(ext)
  }

  /// Synchronously inspects a single directory level on a background queue, respecting cancellation,
  /// remaining node budget, hidden-file visibility, symlink confinement, and the >2s timeout budget.
  static func scanDirectChildren(
    of dirURL: URL,
    relativeBase: String,
    canonicalRoot: String,
    includeHidden: Bool,
    remainingBudget: Int,
    deadline: CFAbsoluteTime,
    cancelToken: LumenFolderCancelToken
  ) -> LumenFolderScanOutcome {
    if cancelToken.isCancelled {
      return LumenFolderScanOutcome(entries: [], hiddenSkippedCount: 0, error: nil, truncatedByLimit: false)
    }
    if CFAbsoluteTimeGetCurrent() >= deadline {
      return LumenFolderScanOutcome(entries: [], hiddenSkippedCount: 0, error: .timedOut, truncatedByLimit: false)
    }

    let fm = FileManager.default
    var isDir: ObjCBool = false
    guard fm.fileExists(atPath: dirURL.path, isDirectory: &isDir) else {
      return LumenFolderScanOutcome(entries: [], hiddenSkippedCount: 0, error: .notFound, truncatedByLimit: false)
    }
    guard isDir.boolValue else {
      return LumenFolderScanOutcome(entries: [], hiddenSkippedCount: 0, error: .notADirectory, truncatedByLimit: false)
    }

    let rawURLs: [URL]
    do {
      rawURLs = try fm.contentsOfDirectory(
        at: dirURL,
        includingPropertiesForKeys: Array(resourceKeys),
        options: []
      )
    } catch {
      return LumenFolderScanOutcome(
        entries: [],
        hiddenSkippedCount: 0,
        error: classifyScanError(error),
        truncatedByLimit: false
      )
    }

    if cancelToken.isCancelled {
      return LumenFolderScanOutcome(entries: [], hiddenSkippedCount: 0, error: nil, truncatedByLimit: false)
    }

    var hiddenSkipped = 0
    var scanned: [LumenFolderScannedEntry] = []
    scanned.reserveCapacity(min(rawURLs.count, max(0, remainingBudget)))

    // Pre-sort by filename deterministically BEFORE applying remaining node budget so truncation is reproducible
    // across case-sensitive/case-insensitive volumes, CJK, and RTL names.
    let sortedURLs = rawURLs.sorted { lhs, rhs in
      let ln = lhs.lastPathComponent
      let rn = rhs.lastPathComponent
      let cmp = ln.localizedStandardCompare(rn)
      if cmp != .orderedSame { return cmp == .orderedAscending }
      return ln < rn
    }

    var truncated = false
    for (idx, childURL) in sortedURLs.enumerated() {
      if idx % 32 == 0 {
        if cancelToken.isCancelled {
          return LumenFolderScanOutcome(entries: [], hiddenSkippedCount: 0, error: nil, truncatedByLimit: false)
        }
        if CFAbsoluteTimeGetCurrent() >= deadline {
          return LumenFolderScanOutcome(
            entries: sortEntries(scanned),
            hiddenSkippedCount: hiddenSkipped,
            error: .timedOut,
            truncatedByLimit: false
          )
        }
      }

      let name = childURL.lastPathComponent
      let values = try? childURL.resourceValues(forKeys: resourceKeys)
      let isHidden = name.hasPrefix(".") || (values?.isHidden == true)

      if isHidden && !includeHidden {
        hiddenSkipped += 1
        continue
      }

      if scanned.count >= remainingBudget {
        truncated = true
        break
      }

      // Check symlink via both URLResourceValues and lstat-backed attributesOfItem (never follows symlink).
      let lstatAttrs = try? fm.attributesOfItem(atPath: childURL.path)
      let lstatType = lstatAttrs?[.type] as? FileAttributeType
      let lstatTypeRaw = (lstatAttrs?[.type] as? String) ?? lstatType?.rawValue
      let isSymlink = (values?.isSymbolicLink == true)
        || (lstatType == .typeSymbolicLink)
        || (lstatTypeRaw == FileAttributeType.typeSymbolicLink.rawValue)
      let relPath = relativeBase.isEmpty ? name : "\(relativeBase)/\(name)"
      let modifiedAt = values?.contentModificationDate
      let isReadable = values?.isReadable ?? fm.isReadableFile(atPath: childURL.path)

      if isSymlink {
        let dest = try? fm.destinationOfSymbolicLink(atPath: childURL.path)
        let outside: Bool
        if let rawDest = dest, !rawDest.isEmpty {
          let targetURL = rawDest.hasPrefix("/")
            ? URL(fileURLWithPath: rawDest)
            : childURL.deletingLastPathComponent().appendingPathComponent(rawDest)
          let lexicalPath = targetURL.standardizedFileURL.path
          let resolvedPath = targetURL.resolvingSymlinksInPath().standardizedFileURL.path
          outside = !isPathWithinRoot(lexicalPath, canonicalRoot: canonicalRoot)
            || !isPathWithinRoot(resolvedPath, canonicalRoot: canonicalRoot)
        } else {
          let resolvedTarget = childURL.resolvingSymlinksInPath().standardizedFileURL.path
          outside = !isPathWithinRoot(resolvedTarget, canonicalRoot: canonicalRoot)
        }
        let linkIdentity = LumenContentIdentity(
          family: .file,
          subtype: "symlink",
          language: nil,
          confidence: .confirmed,
          glyphID: "link",
          displayName: "符号链接",
          logicalCategory: .otherFile,
          rendererID: nil,
          previewAvailability: .unsupported,
          lightColorHex: "#6f86a8"
        )
        scanned.append(LumenFolderScannedEntry(
          url: childURL,
          name: name,
          relativePath: relPath,
          kind: .symlink(target: dest, pointsOutsideRoot: outside),
          isHidden: isHidden,
          byteSize: nil,
          modifiedAt: modifiedAt,
          isReadable: isReadable,
          identity: linkIdentity
        ))
        continue
      }

      let isDirectory = (values?.isDirectory == true)
        || (lstatType == .typeDirectory)
        || (lstatTypeRaw == FileAttributeType.typeDirectory.rawValue)
      if isDirectory {
        let isPkg = isPackageDirectory(url: childURL, resourceIsPackage: values?.isPackage)
        let baseIdentity = LumenContentIdentityRegistry.shared.identity(forFilePath: childURL.path, materialized: true)
        let dirIdentity: LumenContentIdentity
        if isPkg {
          dirIdentity = LumenContentIdentity(
            family: .file,
            subtype: "package",
            language: nil,
            confidence: .confirmed,
            glyphID: "package",
            displayName: "程序包",
            logicalCategory: .otherFile,
            rendererID: LumenFolderRenderer.rendererIDStatic,
            previewAvailability: .ready,
            lightColorHex: "#6d8bb1"
          )
        } else {
          dirIdentity = baseIdentity
        }
        scanned.append(LumenFolderScannedEntry(
          url: childURL,
          name: name,
          relativePath: relPath,
          kind: .directory(isPackage: isPkg),
          isHidden: isHidden,
          byteSize: nil, // Never report directory inode metadata block size as directory content size
          modifiedAt: modifiedAt,
          isReadable: isReadable,
          identity: dirIdentity
        ))
      } else {
        let regularSize: Int64?
        if let fileSize = values?.fileSize, fileSize >= 0 {
          regularSize = Int64(fileSize)
        } else if let attrSize = (try? fm.attributesOfItem(atPath: childURL.path)[.size] as? NSNumber)?.int64Value, attrSize >= 0 {
          regularSize = attrSize
        } else {
          regularSize = nil
        }
        let fileIdentity = LumenContentIdentityRegistry.shared.identity(forFilePath: childURL.path, materialized: isReadable)
        scanned.append(LumenFolderScannedEntry(
          url: childURL,
          name: name,
          relativePath: relPath,
          kind: .regularFile,
          isHidden: isHidden,
          byteSize: regularSize,
          modifiedAt: modifiedAt,
          isReadable: isReadable,
          identity: fileIdentity
        ))
      }
    }

    return LumenFolderScanOutcome(
      entries: sortEntries(scanned),
      hiddenSkippedCount: hiddenSkipped,
      error: nil,
      truncatedByLimit: truncated
    )
  }

  /// Deterministic ordering: directories/packages first, then files/symlinks; natural locale sort with exact Unicode tie-breaker.
  private static func sortEntries(_ entries: [LumenFolderScannedEntry]) -> [LumenFolderScannedEntry] {
    entries.sorted { lhs, rhs in
      let lDir: Bool
      if case .directory = lhs.kind { lDir = true } else { lDir = false }
      let rDir: Bool
      if case .directory = rhs.kind { rDir = true } else { rDir = false }
      if lDir != rDir { return lDir && !rDir }
      let cmp = lhs.name.localizedStandardCompare(rhs.name)
      if cmp != .orderedSame { return cmp == .orderedAscending }
      return lhs.name < rhs.name
    }
  }

  private static func classifyScanError(_ error: Error) -> LumenFolderScanError {
    let nsError = error as NSError
    if nsError.domain == NSCocoaErrorDomain {
      switch nsError.code {
      case NSFileReadNoPermissionError:
        return .permissionDenied
      case NSFileReadNoSuchFileError, NSFileNoSuchFileError:
        return .notFound
      default:
        break
      }
    }
    if nsError.domain == NSPOSIXErrorDomain {
      switch nsError.code {
      case Int(EACCES), Int(EPERM):
        return .permissionDenied
      case Int(ENOENT), Int(ENOTDIR):
        return .notFound
      case Int(ETIMEDOUT):
        return .timedOut
      default:
        break
      }
    }
    return .ioError(error.localizedDescription)
  }
}

// MARK: - Native Folder Preview Renderer (V15 §7, A61, A77)

struct LumenFolderRenderer: LumenPreviewRenderer {
  static let rendererIDStatic = "native.appkit.folder"

  let rendererID = LumenFolderRenderer.rendererIDStatic
  /// Higher than LumenZipRenderer (92) and LumenFileFallbackRenderer (0) so real directories
  /// (including folders with archive-like names or .app/.bundle packages) route cleanly here.
  let priority = 96

  func canRender(_ item: LumenPreviewItem) -> Bool {
    guard item.identity.family == .file || item.identity.family == .archive else {
      return false
    }
    if let path = Self.resolvedDirectoryPath(for: item) {
      var isDir: ObjCBool = false
      if FileManager.default.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue {
        return true
      }
    }
    // Also claim folder-typed entries whose path is currently missing/inaccessible so we render
    // an accurate readable error state rather than a generic "unsupported format" fallback.
    if item.identity.family == .file && item.identity.subtype == "folder" {
      return true
    }
    return false
  }

  func makeView(for item: LumenPreviewItem, context: LumenPreviewContext) -> LumenPreviewRendererView {
    LumenFolderRendererView(palette: context.palette)
  }

  static func resolvedDirectoryPath(for item: LumenPreviewItem) -> String? {
    if let local = item.localURL {
      return local.path
    }
    if let clipPath = item.clipboardItem?.primaryFilePath {
      let trimmed = clipPath.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? nil : trimmed
    }
    return nil
  }
}

// MARK: - Folder Renderer View (Split Tree + Reused Registry Member Preview)

final class LumenFolderRendererView: LumenPreviewRendererView,
                                     NSOutlineViewDataSource, NSOutlineViewDelegate,
                                     NSTableViewDataSource, NSTableViewDelegate {
  private var palette: LumenPalette

  // Top summary bar
  private let toolbar = NSView()
  private let toolbarDivider = NSView()
  private let summaryGlyph = LumenIdentityGlyphView(size: 16)
  private let summaryLabel = NSTextField(labelWithString: "正在读取文件夹…")
  private let toggleHiddenBtn = NSButton()
  private let revealRootBtn = NSButton()
  private let copyRootPathBtn = NSButton()

  // Split stage
  private let splitHost = NSView()
  private let treeScroll = NSScrollView()
  private let outlineView = NSOutlineView()
  private let splitDivider = NSView()
  private let rightPane = NSView()

  // Right pane: member breadcrumb bar (for mounted child renderer) + content stage
  private let memberHeaderBar = NSView()
  private let memberHeaderDivider = NSView()
  private let memberBreadcrumbLabel = NSTextField(labelWithString: "")
  private let memberRevealBtn = NSButton()
  private let memberCopyPathBtn = NSButton()
  private let memberStageHost = NSView()

  // Right pane: subdirectory children list view
  private let dirDetailView = NSView()
  private let dirHeaderBox = NSView()
  private let dirHeaderDivider = NSView()
  private let dirGlyph = LumenIdentityGlyphView(size: 28)
  private let dirTitleLabel = NSTextField(labelWithString: "")
  private let dirPackageBadge = NSTextField(labelWithString: " 程序包 ")
  private let dirSubtitleLabel = NSTextField(labelWithString: "")
  private let dirExpandPackageBtn = NSButton()
  private let dirRetryBtn = NSButton()
  private let dirRevealBtn = NSButton()
  private let dirCopyPathBtn = NSButton()
  private let dirTableScroll = NSScrollView()
  private let dirTable = NSTableView()
  private let dirEmptyLabel = NSTextField(wrappingLabelWithString: "")

  // Right pane: clean compact status / unsupported / symlink / error card (zero Alert banner, zero border-left bar)
  private let noticeOverlay = NSView()
  private let noticeCard = NSView()
  private let noticeIdentityGlyph = LumenIdentityGlyphView(size: 48)
  private let noticeStatusBadge = NSView()
  private let noticeStatusIcon = NSImageView()
  private let noticeSpinner = NSProgressIndicator()
  private let noticeTitleLabel = NSTextField(wrappingLabelWithString: "")
  private let noticeMetaLabel = NSTextField(labelWithString: "")
  private let noticePathBox = NSView()
  private let noticePathLabel = NSTextField(wrappingLabelWithString: "")
  private let noticeReasonLabel = NSTextField(wrappingLabelWithString: "")
  private let noticeRetryBtn = NSButton()
  private let noticeRevealBtn = NSButton()
  private let noticeOpenDefaultBtn = NSButton()
  private let noticeCopyPathBtn = NSButton()

  // State
  private var rootURL: URL?
  private var canonicalRootPath = ""
  private var rootNode: LumenFolderNode?
  private var nodeByID: [String: LumenFolderNode] = [:]
  private var selectedNode: LumenFolderNode?
  private var displayedDirChildren: [LumenFolderNode] = []
  private var activeMemberRendererView: LumenPreviewRendererView?

  private var showHiddenFiles = false
  private var totalLoadedRealNodes = 0
  private var reachedNodeLimit = false
  private var anyLoadError = false

  private var loadGeneration = 0
  private var activeCancelToken: LumenFolderCancelToken?
  private var pendingTimeoutTimers: [UUID: DispatchWorkItem] = [:]
  private let scanQueue = DispatchQueue(label: "com.meadeo.lumen.folder.scan", qos: .userInitiated)

  init(palette: LumenPalette) {
    self.palette = palette
    super.init(frame: .zero)
    wantsLayer = true
    buildUI()
    applyTheme(palette)
  }

  required init?(coder: NSCoder) { nil }

  deinit {
    teardown()
  }

  // MARK: - UI Construction

  private func buildUI() {
    // 1. Top summary bar
    toolbar.wantsLayer = true
    toolbar.translatesAutoresizingMaskIntoConstraints = false
    toolbarDivider.wantsLayer = true
    toolbarDivider.translatesAutoresizingMaskIntoConstraints = false

    summaryGlyph.translatesAutoresizingMaskIntoConstraints = false

    summaryLabel.font = .monospacedDigitSystemFont(ofSize: 11.5, weight: .medium)
    summaryLabel.lineBreakMode = .byTruncatingTail
    summaryLabel.maximumNumberOfLines = 1
    summaryLabel.translatesAutoresizingMaskIntoConstraints = false
    summaryLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    summaryLabel.setAccessibilityElement(true)
    summaryLabel.setAccessibilityRole(.staticText)
    summaryLabel.setAccessibilityLabel("文件夹统计摘要")

    configureToolbarButton(toggleHiddenBtn, title: "显示隐藏项", tip: "切换显示隐藏文件与点文件", action: #selector(toggleHiddenClicked))
    configureToolbarButton(revealRootBtn, title: "在访达中显示", tip: "在访达中显示此目录", action: #selector(revealRootClicked))
    configureToolbarButton(copyRootPathBtn, title: "复制路径", tip: "复制此目录完整路径", action: #selector(copyRootPathClicked))

    let toolbarActions = NSStackView(views: [toggleHiddenBtn, revealRootBtn, copyRootPathBtn])
    toolbarActions.orientation = .horizontal
    toolbarActions.spacing = 6
    toolbarActions.translatesAutoresizingMaskIntoConstraints = false
    toolbarActions.setContentHuggingPriority(.required, for: .horizontal)
    toolbarActions.setContentCompressionResistancePriority(.required, for: .horizontal)

    toolbar.addSubview(summaryGlyph)
    toolbar.addSubview(summaryLabel)
    toolbar.addSubview(toolbarActions)
    toolbar.addSubview(toolbarDivider)

    // 2. Left outline tree
    let treeCol = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("folderTree"))
    treeCol.minWidth = 300
    treeCol.resizingMask = .autoresizingMask
    outlineView.addTableColumn(treeCol)
    outlineView.outlineTableColumn = treeCol
    outlineView.headerView = nil
    outlineView.rowHeight = 38
    outlineView.indentationPerLevel = 14
    outlineView.intercellSpacing = NSSize(width: 0, height: 2)
    outlineView.backgroundColor = .clear
    outlineView.selectionHighlightStyle = .none
    outlineView.autoresizesOutlineColumn = true
    outlineView.dataSource = self
    outlineView.delegate = self
    outlineView.setAccessibilityLabel("文件夹安全目录树")

    treeScroll.documentView = outlineView
    treeScroll.hasVerticalScroller = true
    treeScroll.hasHorizontalScroller = true
    treeScroll.autohidesScrollers = true
    treeScroll.drawsBackground = true
    treeScroll.borderType = .noBorder
    treeScroll.translatesAutoresizingMaskIntoConstraints = false

    splitDivider.wantsLayer = true
    splitDivider.translatesAutoresizingMaskIntoConstraints = false

    rightPane.wantsLayer = true
    rightPane.translatesAutoresizingMaskIntoConstraints = false

    splitHost.translatesAutoresizingMaskIntoConstraints = false
    splitHost.addSubview(treeScroll)
    splitHost.addSubview(splitDivider)
    splitHost.addSubview(rightPane)

    // 3. Right pane: Member preview stage with breadcrumb header
    memberHeaderBar.wantsLayer = true
    memberHeaderBar.translatesAutoresizingMaskIntoConstraints = false
    memberHeaderBar.isHidden = true
    memberHeaderDivider.wantsLayer = true
    memberHeaderDivider.translatesAutoresizingMaskIntoConstraints = false

    memberBreadcrumbLabel.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
    memberBreadcrumbLabel.lineBreakMode = .byTruncatingMiddle
    memberBreadcrumbLabel.maximumNumberOfLines = 1
    memberBreadcrumbLabel.translatesAutoresizingMaskIntoConstraints = false
    memberBreadcrumbLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    memberBreadcrumbLabel.setAccessibilityElement(true)
    memberBreadcrumbLabel.setAccessibilityRole(.staticText)
    memberBreadcrumbLabel.setAccessibilityLabel("当前预览文件相对路径")

    configureToolbarButton(memberRevealBtn, title: "访达", tip: "在访达中显示当前选中项", action: #selector(revealSelectedClicked))
    configureToolbarButton(memberCopyPathBtn, title: "复制路径", tip: "复制当前选中项路径", action: #selector(copySelectedPathClicked))

    let memberActions = NSStackView(views: [memberRevealBtn, memberCopyPathBtn])
    memberActions.orientation = .horizontal
    memberActions.spacing = 6
    memberActions.translatesAutoresizingMaskIntoConstraints = false
    memberActions.setContentHuggingPriority(.required, for: .horizontal)

    memberHeaderBar.addSubview(memberBreadcrumbLabel)
    memberHeaderBar.addSubview(memberActions)
    memberHeaderBar.addSubview(memberHeaderDivider)

    memberStageHost.wantsLayer = true
    memberStageHost.translatesAutoresizingMaskIntoConstraints = false
    memberStageHost.isHidden = true

    // 4. Right pane: Subdirectory children list view
    dirDetailView.wantsLayer = true
    dirDetailView.translatesAutoresizingMaskIntoConstraints = false
    dirDetailView.isHidden = true

    dirHeaderBox.wantsLayer = true
    dirHeaderBox.translatesAutoresizingMaskIntoConstraints = false
    dirHeaderDivider.wantsLayer = true
    dirHeaderDivider.translatesAutoresizingMaskIntoConstraints = false

    dirGlyph.translatesAutoresizingMaskIntoConstraints = false

    dirTitleLabel.font = .systemFont(ofSize: 14, weight: .semibold)
    dirTitleLabel.lineBreakMode = .byTruncatingMiddle
    dirTitleLabel.maximumNumberOfLines = 1
    dirTitleLabel.translatesAutoresizingMaskIntoConstraints = false
    dirTitleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    dirTitleLabel.setAccessibilityElement(true)
    dirTitleLabel.setAccessibilityRole(.staticText)
    dirTitleLabel.setAccessibilityLabel("当前目录名称")

    dirPackageBadge.font = .systemFont(ofSize: 10.5, weight: .semibold)
    dirPackageBadge.wantsLayer = true
    dirPackageBadge.layer?.cornerRadius = 5
    dirPackageBadge.layer?.cornerCurve = .continuous
    dirPackageBadge.layer?.masksToBounds = true
    dirPackageBadge.translatesAutoresizingMaskIntoConstraints = false
    dirPackageBadge.setContentHuggingPriority(.required, for: .horizontal)
    dirPackageBadge.isHidden = true

    dirSubtitleLabel.font = .monospacedDigitSystemFont(ofSize: 11.5, weight: .regular)
    dirSubtitleLabel.lineBreakMode = .byTruncatingMiddle
    dirSubtitleLabel.maximumNumberOfLines = 1
    dirSubtitleLabel.translatesAutoresizingMaskIntoConstraints = false
    dirSubtitleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    dirSubtitleLabel.setAccessibilityElement(true)
    dirSubtitleLabel.setAccessibilityRole(.staticText)
    dirSubtitleLabel.setAccessibilityLabel("当前目录路径与统计")

    let dirTitleRow = NSStackView(views: [dirTitleLabel, dirPackageBadge])
    dirTitleRow.orientation = .horizontal
    dirTitleRow.alignment = .centerY
    dirTitleRow.spacing = 6

    let dirMetaCol = NSStackView(views: [dirTitleRow, dirSubtitleLabel])
    dirMetaCol.orientation = .vertical
    dirMetaCol.alignment = .leading
    dirMetaCol.spacing = 2
    dirMetaCol.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    let dirIdentityStack = NSStackView(views: [dirGlyph, dirMetaCol])
    dirIdentityStack.orientation = .horizontal
    dirIdentityStack.alignment = .centerY
    dirIdentityStack.spacing = 10
    dirIdentityStack.translatesAutoresizingMaskIntoConstraints = false

    configureToolbarButton(dirExpandPackageBtn, title: "浏览包内容", tip: "只读展开此程序包目录内容", action: #selector(expandSelectedPackageClicked))
    configureToolbarButton(dirRetryBtn, title: "重试读取", tip: "重新读取此目录", action: #selector(retrySelectedDirClicked))
    configureToolbarButton(dirRevealBtn, title: "在访达中显示", tip: "在访达中显示此目录", action: #selector(revealSelectedClicked))
    configureToolbarButton(dirCopyPathBtn, title: "复制路径", tip: "复制此目录完整路径", action: #selector(copySelectedPathClicked))

    let dirActions = NSStackView(views: [dirExpandPackageBtn, dirRetryBtn, dirRevealBtn, dirCopyPathBtn])
    dirActions.orientation = .horizontal
    dirActions.spacing = 6
    dirActions.translatesAutoresizingMaskIntoConstraints = false
    dirActions.setContentHuggingPriority(.required, for: .horizontal)

    dirHeaderBox.addSubview(dirIdentityStack)
    dirHeaderBox.addSubview(dirActions)
    dirHeaderBox.addSubview(dirHeaderDivider)

    let dirCol = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("dirChildren"))
    dirCol.resizingMask = .autoresizingMask
    dirTable.addTableColumn(dirCol)
    dirTable.headerView = nil
    dirTable.rowHeight = 40
    dirTable.intercellSpacing = NSSize(width: 0, height: 2)
    dirTable.backgroundColor = .clear
    dirTable.selectionHighlightStyle = .none
    dirTable.dataSource = self
    dirTable.delegate = self
    dirTable.target = self
    dirTable.action = #selector(dirChildSingleClicked)
    dirTable.doubleAction = #selector(dirChildDoubleClicked)
    dirTable.setAccessibilityLabel("目录子项列表")

    dirTableScroll.documentView = dirTable
    dirTableScroll.hasVerticalScroller = true
    dirTableScroll.autohidesScrollers = true
    dirTableScroll.drawsBackground = false
    dirTableScroll.borderType = .noBorder
    dirTableScroll.translatesAutoresizingMaskIntoConstraints = false

    dirEmptyLabel.font = .systemFont(ofSize: 12.5)
    dirEmptyLabel.alignment = .center
    dirEmptyLabel.maximumNumberOfLines = 4
    dirEmptyLabel.translatesAutoresizingMaskIntoConstraints = false
    dirEmptyLabel.isHidden = true

    dirDetailView.addSubview(dirHeaderBox)
    dirDetailView.addSubview(dirTableScroll)
    dirDetailView.addSubview(dirEmptyLabel)

    // 5. Right pane: Clean notice card (Unknown/Unsupported file, Symlink, Error, Loading)
    noticeOverlay.wantsLayer = true
    noticeOverlay.translatesAutoresizingMaskIntoConstraints = false
    noticeOverlay.isHidden = false

    noticeCard.wantsLayer = true
    noticeCard.layer?.cornerRadius = 14
    noticeCard.layer?.cornerCurve = .continuous
    noticeCard.layer?.borderWidth = 1
    noticeCard.translatesAutoresizingMaskIntoConstraints = false

    noticeIdentityGlyph.translatesAutoresizingMaskIntoConstraints = false

    noticeStatusBadge.wantsLayer = true
    noticeStatusBadge.layer?.cornerRadius = 22
    noticeStatusBadge.layer?.cornerCurve = .continuous
    noticeStatusBadge.layer?.borderWidth = 1
    noticeStatusBadge.translatesAutoresizingMaskIntoConstraints = false

    noticeStatusIcon.imageScaling = .scaleProportionallyDown
    noticeStatusIcon.translatesAutoresizingMaskIntoConstraints = false
    noticeStatusBadge.addSubview(noticeStatusIcon)

    noticeSpinner.style = .spinning
    noticeSpinner.controlSize = .small
    noticeSpinner.isDisplayedWhenStopped = false
    noticeSpinner.translatesAutoresizingMaskIntoConstraints = false
    noticeStatusBadge.addSubview(noticeSpinner)

    let noticeIconHost = NSView()
    noticeIconHost.translatesAutoresizingMaskIntoConstraints = false
    noticeIconHost.addSubview(noticeIdentityGlyph)
    noticeIconHost.addSubview(noticeStatusBadge)

    noticeTitleLabel.font = .systemFont(ofSize: 15.5, weight: .semibold)
    noticeTitleLabel.maximumNumberOfLines = 2
    noticeTitleLabel.lineBreakMode = .byTruncatingMiddle
    noticeTitleLabel.translatesAutoresizingMaskIntoConstraints = false
    noticeTitleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    noticeTitleLabel.setAccessibilityElement(true)
    noticeTitleLabel.setAccessibilityRole(.staticText)
    noticeTitleLabel.setAccessibilityLabel("项目名称或状态标题")

    noticeMetaLabel.font = .monospacedDigitSystemFont(ofSize: 11.5, weight: .medium)
    noticeMetaLabel.lineBreakMode = .byTruncatingTail
    noticeMetaLabel.maximumNumberOfLines = 1
    noticeMetaLabel.translatesAutoresizingMaskIntoConstraints = false
    noticeMetaLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    noticePathBox.wantsLayer = true
    noticePathBox.layer?.cornerRadius = 8
    noticePathBox.layer?.cornerCurve = .continuous
    noticePathBox.layer?.borderWidth = 1
    noticePathBox.translatesAutoresizingMaskIntoConstraints = false

    noticePathLabel.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
    noticePathLabel.isEditable = false
    noticePathLabel.isSelectable = true
    noticePathLabel.maximumNumberOfLines = 3
    noticePathLabel.lineBreakMode = .byCharWrapping
    noticePathLabel.translatesAutoresizingMaskIntoConstraints = false
    noticePathLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    noticePathLabel.setAccessibilityElement(true)
    noticePathLabel.setAccessibilityRole(.textField)
    noticePathLabel.setAccessibilityLabel("项目路径")
    noticePathBox.addSubview(noticePathLabel)

    noticeReasonLabel.font = .systemFont(ofSize: 12)
    noticeReasonLabel.maximumNumberOfLines = 5
    noticeReasonLabel.translatesAutoresizingMaskIntoConstraints = false
    noticeReasonLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    noticeReasonLabel.setAccessibilityElement(true)
    noticeReasonLabel.setAccessibilityRole(.staticText)
    noticeReasonLabel.setAccessibilityLabel("预览不可用或状态说明")

    configureCardButton(noticeRetryBtn, title: "重试", tip: "重新尝试读取", isPrimary: true, action: #selector(retrySelectedDirClicked))
    configureCardButton(noticeRevealBtn, title: "在访达中显示", tip: "在访达中显示该项目", isPrimary: false, action: #selector(revealSelectedClicked))
    configureCardButton(noticeOpenDefaultBtn, title: "默认应用打开", tip: "使用系统默认应用打开该文件", isPrimary: false, action: #selector(openSelectedWithDefaultClicked))
    configureCardButton(noticeCopyPathBtn, title: "复制路径", tip: "复制该项目完整路径", isPrimary: false, action: #selector(copySelectedPathClicked))

    let noticeActions = NSStackView(views: [noticeRetryBtn, noticeRevealBtn, noticeOpenDefaultBtn, noticeCopyPathBtn])
    noticeActions.orientation = .horizontal
    noticeActions.alignment = .centerY
    noticeActions.spacing = 8
    noticeActions.translatesAutoresizingMaskIntoConstraints = false

    let noticeHeaderCol = NSStackView(views: [noticeTitleLabel, noticeMetaLabel])
    noticeHeaderCol.orientation = .vertical
    noticeHeaderCol.alignment = .leading
    noticeHeaderCol.spacing = 3
    noticeHeaderCol.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    let noticeHeaderRow = NSStackView(views: [noticeIconHost, noticeHeaderCol])
    noticeHeaderRow.orientation = .horizontal
    noticeHeaderRow.alignment = .centerY
    noticeHeaderRow.spacing = 12
    noticeHeaderRow.translatesAutoresizingMaskIntoConstraints = false

    let noticeStack = NSStackView(views: [noticeHeaderRow, noticePathBox, noticeReasonLabel, noticeActions])
    noticeStack.orientation = .vertical
    noticeStack.alignment = .leading
    noticeStack.spacing = 12
    noticeStack.setCustomSpacing(16, after: noticeReasonLabel)
    noticeStack.translatesAutoresizingMaskIntoConstraints = false

    noticeCard.addSubview(noticeStack)
    noticeOverlay.addSubview(noticeCard)

    rightPane.addSubview(memberHeaderBar)
    rightPane.addSubview(memberStageHost)
    rightPane.addSubview(dirDetailView)
    rightPane.addSubview(noticeOverlay)

    addSubview(toolbar)
    addSubview(splitHost)

    let prefNoticeWidth = noticeCard.widthAnchor.constraint(equalToConstant: 460)
    prefNoticeWidth.priority = .defaultHigh

    NSLayoutConstraint.activate([
      toolbar.topAnchor.constraint(equalTo: topAnchor),
      toolbar.leadingAnchor.constraint(equalTo: leadingAnchor),
      toolbar.trailingAnchor.constraint(equalTo: trailingAnchor),
      toolbar.heightAnchor.constraint(equalToConstant: 42),

      summaryGlyph.leadingAnchor.constraint(equalTo: toolbar.leadingAnchor, constant: 14),
      summaryGlyph.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),
      summaryGlyph.widthAnchor.constraint(equalToConstant: 16),
      summaryGlyph.heightAnchor.constraint(equalToConstant: 16),

      summaryLabel.leadingAnchor.constraint(equalTo: summaryGlyph.trailingAnchor, constant: 8),
      summaryLabel.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),
      summaryLabel.trailingAnchor.constraint(lessThanOrEqualTo: toolbarActions.leadingAnchor, constant: -10),

      toolbarActions.trailingAnchor.constraint(equalTo: toolbar.trailingAnchor, constant: -12),
      toolbarActions.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),

      toolbarDivider.leadingAnchor.constraint(equalTo: toolbar.leadingAnchor),
      toolbarDivider.trailingAnchor.constraint(equalTo: toolbar.trailingAnchor),
      toolbarDivider.bottomAnchor.constraint(equalTo: toolbar.bottomAnchor),
      toolbarDivider.heightAnchor.constraint(equalToConstant: 1),

      splitHost.topAnchor.constraint(equalTo: toolbar.bottomAnchor),
      splitHost.leadingAnchor.constraint(equalTo: leadingAnchor),
      splitHost.trailingAnchor.constraint(equalTo: trailingAnchor),
      splitHost.bottomAnchor.constraint(equalTo: bottomAnchor),

      treeScroll.topAnchor.constraint(equalTo: splitHost.topAnchor),
      treeScroll.leadingAnchor.constraint(equalTo: splitHost.leadingAnchor),
      treeScroll.bottomAnchor.constraint(equalTo: splitHost.bottomAnchor),
      treeScroll.widthAnchor.constraint(equalToConstant: 332),

      splitDivider.topAnchor.constraint(equalTo: splitHost.topAnchor),
      splitDivider.leadingAnchor.constraint(equalTo: treeScroll.trailingAnchor),
      splitDivider.bottomAnchor.constraint(equalTo: splitHost.bottomAnchor),
      splitDivider.widthAnchor.constraint(equalToConstant: 1),

      rightPane.topAnchor.constraint(equalTo: splitHost.topAnchor),
      rightPane.leadingAnchor.constraint(equalTo: splitDivider.trailingAnchor),
      rightPane.trailingAnchor.constraint(equalTo: splitHost.trailingAnchor),
      rightPane.bottomAnchor.constraint(equalTo: splitHost.bottomAnchor),

      // Member header + stage
      memberHeaderBar.topAnchor.constraint(equalTo: rightPane.topAnchor),
      memberHeaderBar.leadingAnchor.constraint(equalTo: rightPane.leadingAnchor),
      memberHeaderBar.trailingAnchor.constraint(equalTo: rightPane.trailingAnchor),
      memberHeaderBar.heightAnchor.constraint(equalToConstant: 34),

      memberBreadcrumbLabel.leadingAnchor.constraint(equalTo: memberHeaderBar.leadingAnchor, constant: 12),
      memberBreadcrumbLabel.centerYAnchor.constraint(equalTo: memberHeaderBar.centerYAnchor),
      memberBreadcrumbLabel.trailingAnchor.constraint(lessThanOrEqualTo: memberActions.leadingAnchor, constant: -8),

      memberActions.trailingAnchor.constraint(equalTo: memberHeaderBar.trailingAnchor, constant: -10),
      memberActions.centerYAnchor.constraint(equalTo: memberHeaderBar.centerYAnchor),

      memberHeaderDivider.leadingAnchor.constraint(equalTo: memberHeaderBar.leadingAnchor),
      memberHeaderDivider.trailingAnchor.constraint(equalTo: memberHeaderBar.trailingAnchor),
      memberHeaderDivider.bottomAnchor.constraint(equalTo: memberHeaderBar.bottomAnchor),
      memberHeaderDivider.heightAnchor.constraint(equalToConstant: 1),

      memberStageHost.topAnchor.constraint(equalTo: memberHeaderBar.bottomAnchor),
      memberStageHost.leadingAnchor.constraint(equalTo: rightPane.leadingAnchor),
      memberStageHost.trailingAnchor.constraint(equalTo: rightPane.trailingAnchor),
      memberStageHost.bottomAnchor.constraint(equalTo: rightPane.bottomAnchor),

      // Subdirectory detail view
      dirDetailView.topAnchor.constraint(equalTo: rightPane.topAnchor),
      dirDetailView.leadingAnchor.constraint(equalTo: rightPane.leadingAnchor),
      dirDetailView.trailingAnchor.constraint(equalTo: rightPane.trailingAnchor),
      dirDetailView.bottomAnchor.constraint(equalTo: rightPane.bottomAnchor),

      dirHeaderBox.topAnchor.constraint(equalTo: dirDetailView.topAnchor),
      dirHeaderBox.leadingAnchor.constraint(equalTo: dirDetailView.leadingAnchor),
      dirHeaderBox.trailingAnchor.constraint(equalTo: dirDetailView.trailingAnchor),
      dirHeaderBox.heightAnchor.constraint(equalToConstant: 58),

      dirGlyph.widthAnchor.constraint(equalToConstant: 28),
      dirGlyph.heightAnchor.constraint(equalToConstant: 28),

      dirIdentityStack.leadingAnchor.constraint(equalTo: dirHeaderBox.leadingAnchor, constant: 14),
      dirIdentityStack.centerYAnchor.constraint(equalTo: dirHeaderBox.centerYAnchor),
      dirIdentityStack.trailingAnchor.constraint(lessThanOrEqualTo: dirActions.leadingAnchor, constant: -10),

      dirActions.trailingAnchor.constraint(equalTo: dirHeaderBox.trailingAnchor, constant: -12),
      dirActions.centerYAnchor.constraint(equalTo: dirHeaderBox.centerYAnchor),

      dirHeaderDivider.leadingAnchor.constraint(equalTo: dirHeaderBox.leadingAnchor),
      dirHeaderDivider.trailingAnchor.constraint(equalTo: dirHeaderBox.trailingAnchor),
      dirHeaderDivider.bottomAnchor.constraint(equalTo: dirHeaderBox.bottomAnchor),
      dirHeaderDivider.heightAnchor.constraint(equalToConstant: 1),

      dirTableScroll.topAnchor.constraint(equalTo: dirHeaderBox.bottomAnchor, constant: 6),
      dirTableScroll.leadingAnchor.constraint(equalTo: dirDetailView.leadingAnchor, constant: 10),
      dirTableScroll.trailingAnchor.constraint(equalTo: dirDetailView.trailingAnchor, constant: -10),
      dirTableScroll.bottomAnchor.constraint(equalTo: dirDetailView.bottomAnchor, constant: -8),

      dirEmptyLabel.centerXAnchor.constraint(equalTo: dirTableScroll.centerXAnchor),
      dirEmptyLabel.centerYAnchor.constraint(equalTo: dirTableScroll.centerYAnchor),
      dirEmptyLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 360),

      // Notice overlay card
      noticeOverlay.topAnchor.constraint(equalTo: rightPane.topAnchor),
      noticeOverlay.leadingAnchor.constraint(equalTo: rightPane.leadingAnchor),
      noticeOverlay.trailingAnchor.constraint(equalTo: rightPane.trailingAnchor),
      noticeOverlay.bottomAnchor.constraint(equalTo: rightPane.bottomAnchor),

      noticeCard.centerXAnchor.constraint(equalTo: noticeOverlay.centerXAnchor),
      noticeCard.centerYAnchor.constraint(equalTo: noticeOverlay.centerYAnchor),
      prefNoticeWidth,
      noticeCard.widthAnchor.constraint(lessThanOrEqualToConstant: 520),
      noticeCard.widthAnchor.constraint(greaterThanOrEqualToConstant: 320),
      noticeCard.leadingAnchor.constraint(greaterThanOrEqualTo: noticeOverlay.leadingAnchor, constant: 20),
      noticeCard.trailingAnchor.constraint(lessThanOrEqualTo: noticeOverlay.trailingAnchor, constant: -20),

      noticeIconHost.widthAnchor.constraint(equalToConstant: 48),
      noticeIconHost.heightAnchor.constraint(equalToConstant: 48),

      noticeIdentityGlyph.centerXAnchor.constraint(equalTo: noticeIconHost.centerXAnchor),
      noticeIdentityGlyph.centerYAnchor.constraint(equalTo: noticeIconHost.centerYAnchor),
      noticeIdentityGlyph.widthAnchor.constraint(equalToConstant: 48),
      noticeIdentityGlyph.heightAnchor.constraint(equalToConstant: 48),

      noticeStatusBadge.centerXAnchor.constraint(equalTo: noticeIconHost.centerXAnchor),
      noticeStatusBadge.centerYAnchor.constraint(equalTo: noticeIconHost.centerYAnchor),
      noticeStatusBadge.widthAnchor.constraint(equalToConstant: 44),
      noticeStatusBadge.heightAnchor.constraint(equalToConstant: 44),

      noticeStatusIcon.centerXAnchor.constraint(equalTo: noticeStatusBadge.centerXAnchor),
      noticeStatusIcon.centerYAnchor.constraint(equalTo: noticeStatusBadge.centerYAnchor),
      noticeStatusIcon.widthAnchor.constraint(equalToConstant: 20),
      noticeStatusIcon.heightAnchor.constraint(equalToConstant: 20),

      noticeSpinner.centerXAnchor.constraint(equalTo: noticeStatusBadge.centerXAnchor),
      noticeSpinner.centerYAnchor.constraint(equalTo: noticeStatusBadge.centerYAnchor),

      noticeStack.topAnchor.constraint(equalTo: noticeCard.topAnchor, constant: 22),
      noticeStack.leadingAnchor.constraint(equalTo: noticeCard.leadingAnchor, constant: 22),
      noticeStack.trailingAnchor.constraint(equalTo: noticeCard.trailingAnchor, constant: -22),
      noticeStack.bottomAnchor.constraint(equalTo: noticeCard.bottomAnchor, constant: -22),

      noticeHeaderRow.widthAnchor.constraint(equalTo: noticeStack.widthAnchor),
      noticePathBox.widthAnchor.constraint(equalTo: noticeStack.widthAnchor),
      noticeReasonLabel.widthAnchor.constraint(equalTo: noticeStack.widthAnchor),

      noticePathLabel.topAnchor.constraint(equalTo: noticePathBox.topAnchor, constant: 8),
      noticePathLabel.leadingAnchor.constraint(equalTo: noticePathBox.leadingAnchor, constant: 10),
      noticePathLabel.trailingAnchor.constraint(equalTo: noticePathBox.trailingAnchor, constant: -10),
      noticePathLabel.bottomAnchor.constraint(equalTo: noticePathBox.bottomAnchor, constant: -8)
    ])
  }

  private func configureToolbarButton(_ btn: NSButton, title: String, tip: String, action: Selector) {
    btn.title = title
    btn.target = self
    btn.action = action
    btn.isBordered = false
    btn.wantsLayer = true
    btn.font = .systemFont(ofSize: 11, weight: .medium)
    btn.layer?.cornerRadius = 7
    btn.layer?.cornerCurve = .continuous
    btn.layer?.borderWidth = 1
    btn.translatesAutoresizingMaskIntoConstraints = false
    btn.heightAnchor.constraint(equalToConstant: 24).isActive = true
    btn.widthAnchor.constraint(greaterThanOrEqualToConstant: 52).isActive = true
    btn.toolTip = tip
    btn.setAccessibilityLabel(tip)
  }

  private func configureCardButton(_ btn: NSButton, title: String, tip: String, isPrimary: Bool, action: Selector) {
    btn.title = title
    btn.target = self
    btn.action = action
    btn.isBordered = false
    btn.wantsLayer = true
    btn.font = .systemFont(ofSize: 12, weight: isPrimary ? .semibold : .medium)
    btn.layer?.cornerRadius = 8
    btn.layer?.cornerCurve = .continuous
    btn.layer?.borderWidth = 1
    btn.translatesAutoresizingMaskIntoConstraints = false
    btn.heightAnchor.constraint(equalToConstant: 30).isActive = true
    btn.widthAnchor.constraint(greaterThanOrEqualToConstant: 86).isActive = true
    btn.toolTip = tip
    btn.setAccessibilityLabel(tip)
  }

  private func styleButton(_ btn: NSButton, fg: NSColor, bg: NSColor, border: NSColor) {
    let font = btn.font ?? .systemFont(ofSize: 11.5, weight: .medium)
    let para = NSMutableParagraphStyle()
    para.alignment = .center
    btn.contentTintColor = fg
    btn.attributedTitle = NSAttributedString(
      string: btn.title,
      attributes: [
        .font: font,
        .foregroundColor: fg,
        .paragraphStyle: para
      ]
    )
    btn.layer?.backgroundColor = bg.cgColor
    btn.layer?.borderColor = border.cgColor
  }

  // MARK: - Lifecycle & Teardown

  override func load(item: LumenPreviewItem, context: LumenPreviewContext) {
    cancelPendingWorkAndClearCache()
    super.load(item: item, context: context)
    summaryGlyph.configure(identity: item.identity, isDark: palette.isDark, size: 16)

    guard let rawPath = LumenFolderRenderer.resolvedDirectoryPath(for: item) else {
      summaryLabel.stringValue = "\(item.identity.displayName) · 路径不可用 · 总大小 未知"
      showErrorCard(
        title: LumenFolderScanError.notFound.title,
        meta: "\(item.identity.displayName) · 总大小 未知",
        path: "（无可用本地路径）",
        reason: LumenFolderScanError.notFound.detail,
        canRetry: false,
        canReveal: false,
        canOpenDefault: false
      )
      return
    }

    let url = URL(fileURLWithPath: rawPath)
    rootURL = url
    canonicalRootPath = LumenFolderScanner.canonicalRootPath(for: url)
    startRootScan(for: url, sourceIdentity: item.identity)
  }

  override func applyTheme(_ palette: LumenPalette) {
    self.palette = palette
    layer?.backgroundColor = palette.windowBackground.cgColor
    toolbar.layer?.backgroundColor = palette.surface.cgColor
    toolbarDivider.layer?.backgroundColor = palette.border.cgColor
    treeScroll.backgroundColor = palette.sidebarBackgroundBottom
    splitDivider.layer?.backgroundColor = palette.border.cgColor
    rightPane.layer?.backgroundColor = palette.windowBackground.cgColor

    memberHeaderBar.layer?.backgroundColor = palette.surface.cgColor
    memberHeaderDivider.layer?.backgroundColor = palette.border.cgColor
    memberBreadcrumbLabel.textColor = palette.muted
    memberStageHost.layer?.backgroundColor = palette.windowBackground.cgColor

    dirDetailView.layer?.backgroundColor = palette.windowBackground.cgColor
    dirHeaderBox.layer?.backgroundColor = palette.surface.cgColor
    dirHeaderDivider.layer?.backgroundColor = palette.border.cgColor
    dirTitleLabel.textColor = palette.ink
    dirSubtitleLabel.textColor = palette.muted
    dirPackageBadge.textColor = palette.accent
    dirPackageBadge.layer?.backgroundColor = palette.accentSoft.cgColor
    dirEmptyLabel.textColor = palette.muted

    noticeOverlay.layer?.backgroundColor = palette.windowBackground.cgColor
    noticeCard.layer?.backgroundColor = palette.surface.cgColor
    noticeCard.layer?.borderColor = palette.border.cgColor
    noticeTitleLabel.textColor = palette.ink
    noticeMetaLabel.textColor = palette.muted
    noticePathBox.layer?.backgroundColor = palette.surfaceElevated.cgColor
    noticePathBox.layer?.borderColor = palette.border.cgColor
    noticePathLabel.textColor = palette.ink
    noticeReasonLabel.textColor = palette.muted

    summaryLabel.textColor = palette.muted

    refreshButtonThemes()
    if let item = currentItem {
      summaryGlyph.configure(identity: item.identity, isDark: palette.isDark, size: 16)
    }
    activeMemberRendererView?.applyTheme(palette)
    outlineView.reloadData()
    dirTable.reloadData()
  }

  private func refreshButtonThemes() {
    let neutralButtons = [
      revealRootBtn, copyRootPathBtn, memberRevealBtn, memberCopyPathBtn,
      dirExpandPackageBtn, dirRetryBtn, dirRevealBtn, dirCopyPathBtn,
      noticeRevealBtn, noticeOpenDefaultBtn, noticeCopyPathBtn
    ]
    for btn in neutralButtons {
      styleButton(btn, fg: palette.ink, bg: palette.surfaceElevated, border: palette.border)
    }
    if showHiddenFiles {
      toggleHiddenBtn.title = "隐藏点文件"
      styleButton(toggleHiddenBtn, fg: palette.accent, bg: palette.accentSoft, border: palette.accentBorder)
    } else {
      toggleHiddenBtn.title = "显示隐藏项"
      styleButton(toggleHiddenBtn, fg: palette.ink, bg: palette.surfaceElevated, border: palette.border)
    }
    let primaryFg = palette.isDark
      ? NSColor(srgbRed: 0.08, green: 0.10, blue: 0.16, alpha: 1.0)
      : NSColor.white
    styleButton(noticeRetryBtn, fg: primaryFg, bg: palette.accent, border: palette.accent)
  }

  override func zoomIn() { activeMemberRendererView?.zoomIn() }
  override func zoomOut() { activeMemberRendererView?.zoomOut() }
  override func resetZoom() { activeMemberRendererView?.resetZoom() }
  override func togglePlayPause() -> Bool { activeMemberRendererView?.togglePlayPause() ?? false }
  override func stepPage(_ delta: Int) -> Bool { activeMemberRendererView?.stepPage(delta) ?? false }

  override func copyPrimaryContent() {
    if let active = activeMemberRendererView {
      active.copyPrimaryContent()
      return
    }
    copySelectedPathClicked()
  }

  override func teardown() {
    cancelPendingWorkAndClearCache()
    super.teardown()
  }

  private func cancelPendingWorkAndClearCache() {
    loadGeneration += 1
    activeCancelToken?.cancel()
    activeCancelToken = nil
    for timer in pendingTimeoutTimers.values {
      timer.cancel()
    }
    pendingTimeoutTimers.removeAll()
    noticeSpinner.stopAnimation(nil)

    teardownActiveMemberRenderer()
    rootNode = nil
    nodeByID.removeAll()
    selectedNode = nil
    displayedDirChildren = []
    totalLoadedRealNodes = 0
    reachedNodeLimit = false
    anyLoadError = false
    outlineView.reloadData()
    dirTable.reloadData()
  }

  private func teardownActiveMemberRenderer() {
    activeMemberRendererView?.teardown()
    activeMemberRendererView?.removeFromSuperview()
    activeMemberRendererView = nil
  }

  // MARK: - Root & Lazy Directory Scanning

  private func startRootScan(for url: URL, sourceIdentity: LumenContentIdentity) {
    loadGeneration += 1
    let gen = loadGeneration
    activeCancelToken?.cancel()
    let token = LumenFolderCancelToken()
    activeCancelToken = token
    for timer in pendingTimeoutTimers.values {
      timer.cancel()
    }
    pendingTimeoutTimers.removeAll()
    teardownActiveMemberRenderer()

    totalLoadedRealNodes = 0
    reachedNodeLimit = false
    anyLoadError = false
    nodeByID.removeAll()
    selectedNode = nil
    displayedDirChildren = []

    let fm = FileManager.default
    var isDir: ObjCBool = false
    let exists = fm.fileExists(atPath: url.path, isDirectory: &isDir)
    let isReadable = fm.isReadableFile(atPath: url.path)
    let values = try? url.resourceValues(forKeys: [.isPackageKey, .contentModificationDateKey])
    let rootIsPkg = exists && isDir.boolValue && LumenFolderScanner.isPackageDirectory(url: url, resourceIsPackage: values?.isPackage)

    let root = LumenFolderNode(
      id: "root",
      url: url,
      name: url.lastPathComponent.isEmpty ? url.path : url.lastPathComponent,
      relativePath: "",
      depth: 0,
      kind: .directory(isPackage: rootIsPkg),
      isHidden: false,
      byteSize: nil,
      modifiedAt: values?.contentModificationDate,
      isReadable: isReadable,
      identity: sourceIdentity,
      loadState: .loading
    )
    rootNode = root
    nodeByID[root.id] = root
    selectedNode = root

    summaryLabel.stringValue = "\(sourceIdentity.displayName) · 正在安全扫描目录…"
    showLoadingCard(title: root.name, path: url.path)
    outlineView.reloadData()

    guard exists else {
      applyRootFailure(.notFound, root: root)
      return
    }
    guard isDir.boolValue else {
      applyRootFailure(.notADirectory, root: root)
      return
    }

    // Packages (.app / .bundle / etc.) are treated as directories but stay collapsed by default (§7, A77).
    if rootIsPkg {
      root.loadState = .notLoaded
      outlineView.reloadData()
      updateTopSummary()
      selectAndPresent(node: root, syncOutlineSelection: true)
      return
    }

    // Watchdog enforcing >2s timeout even if a remote/network filesystem stalls contentsOfDirectory.
    let watchdogID = UUID()
    let watchdog = DispatchWorkItem { [weak self] in
      guard let self, self.loadGeneration == gen, !token.isCancelled else { return }
      self.pendingTimeoutTimers.removeValue(forKey: watchdogID)
      token.cancel()
      self.applyRootFailure(.timedOut, root: root)
    }
    pendingTimeoutTimers[watchdogID] = watchdog
    DispatchQueue.main.asyncAfter(deadline: .now() + LumenFolderLimits.scanTimeoutSeconds, execute: watchdog)

    let includeHidden = showHiddenFiles
    let canonicalRoot = canonicalRootPath
    let deadline = CFAbsoluteTimeGetCurrent() + LumenFolderLimits.scanTimeoutSeconds

    scanQueue.async { [weak self] in
      let level1 = LumenFolderScanner.scanDirectChildren(
        of: url,
        relativeBase: "",
        canonicalRoot: canonicalRoot,
        includeHidden: includeHidden,
        remainingBudget: LumenFolderLimits.maxTotalNodes,
        deadline: deadline,
        cancelToken: token
      )

      // Level 2 automatic pre-scan for regular (non-package, non-symlink) subdirectories when budget & time remain.
      var level2ByRelPath: [String: LumenFolderScanOutcome] = [:]
      var budgetLeft = max(0, LumenFolderLimits.maxTotalNodes - level1.entries.count)
      if level1.error == nil && !level1.truncatedByLimit && budgetLeft > 0 && LumenFolderLimits.defaultAutoExpandDepth >= 2 {
        for entry in level1.entries {
          if token.isCancelled || CFAbsoluteTimeGetCurrent() >= deadline || budgetLeft <= 0 {
            break
          }
          // Packages (.app/.bundle) remain collapsed by default; symlinks are never expanded.
          guard case .directory(let isPkg) = entry.kind, !isPkg else { continue }
          let sub = LumenFolderScanner.scanDirectChildren(
            of: entry.url,
            relativeBase: entry.relativePath,
            canonicalRoot: canonicalRoot,
            includeHidden: includeHidden,
            remainingBudget: budgetLeft,
            deadline: deadline,
            cancelToken: token
          )
          level2ByRelPath[entry.relativePath] = sub
          budgetLeft = max(0, budgetLeft - sub.entries.count)
        }
      }

      DispatchQueue.main.async {
        guard let self, self.loadGeneration == gen, !token.isCancelled else { return }
        self.pendingTimeoutTimers.removeValue(forKey: watchdogID)?.cancel()
        self.applyInitialScanResults(root: root, level1: level1, level2ByRelPath: level2ByRelPath)
      }
    }
  }

  private func applyRootFailure(_ error: LumenFolderScanError, root: LumenFolderNode) {
    anyLoadError = true
    root.loadState = .failed(error)
    let errNode = makeSyntheticNode(
      id: "err:root",
      parent: root,
      name: error.title,
      kind: .errorRow(error)
    )
    root.children = [errNode]
    outlineView.reloadData()
    updateTopSummary()
    showErrorCard(
      title: error.title,
      meta: "\(root.identity.displayName) · 总大小 未知",
      path: root.url.path,
      reason: error.detail,
      canRetry: error.isRetryable,
      canReveal: FileManager.default.fileExists(atPath: root.url.path),
      canOpenDefault: false
    )
  }

  private func applyInitialScanResults(
    root: LumenFolderNode,
    level1: LumenFolderScanOutcome,
    level2ByRelPath: [String: LumenFolderScanOutcome]
  ) {
    if let err = level1.error, level1.entries.isEmpty {
      applyRootFailure(err, root: root)
      return
    }

    attachScanOutcome(level1, to: root)

    // Attach pre-scanned Level 2 subdirectories and mark them to expand automatically.
    var toAutoExpand: [LumenFolderNode] = []
    for child in root.children where child.isDirectory && !child.isPackage && !child.isSymlink {
      if let subOutcome = level2ByRelPath[child.relativePath] {
        attachScanOutcome(subOutcome, to: child)
        if !child.children.isEmpty {
          toAutoExpand.append(child)
        }
      }
    }

    outlineView.reloadData()
    for node in toAutoExpand {
      outlineView.expandItem(node)
    }

    updateTopSummary()
    selectAndPresent(node: root, syncOutlineSelection: false)
  }

  private func loadLazyChildren(for dirNode: LumenFolderNode, expandAfterLoad: Bool = false) {
    guard dirNode.isDirectory, !dirNode.isSymlink else { return }
    if dirNode.loadState == .loading { return }

    if dirNode.depth >= LumenFolderLimits.maxDepth {
      dirNode.loadState = .loaded
      let notice = makeSyntheticNode(
        id: "depth:\(dirNode.id)",
        parent: dirNode,
        name: "目录层级超过 \(LumenFolderLimits.maxDepth) 层，已停止继续展开",
        kind: .limitNotice("目录嵌套层级超过 \(LumenFolderLimits.maxDepth) 层限制，可在访达中查看更深路径。")
      )
      dirNode.children = [notice]
      outlineView.reloadItem(dirNode, reloadChildren: true)
      if selectedNode === dirNode {
        presentDirectoryDetail(for: dirNode)
      }
      return
    }

    let remaining = max(0, LumenFolderLimits.maxTotalNodes - totalLoadedRealNodes)
    if remaining <= 0 {
      reachedNodeLimit = true
      dirNode.loadState = .loaded
      let notice = makeSyntheticNode(
        id: "limit:\(dirNode.id)",
        parent: dirNode,
        name: "已达 \(LumenFolderLimits.maxTotalNodes) 节点上限，未继续展开",
        kind: .limitNotice("目录树已达到 \(LumenFolderLimits.maxTotalNodes) 个节点上限，未继续展开此子目录。")
      )
      dirNode.children = [notice]
      outlineView.reloadItem(dirNode, reloadChildren: true)
      updateTopSummary()
      if selectedNode === dirNode {
        presentDirectoryDetail(for: dirNode)
      }
      return
    }

    let gen = loadGeneration
    let token = activeCancelToken ?? {
      let t = LumenFolderCancelToken()
      activeCancelToken = t
      return t
    }()

    dirNode.loadState = .loading
    let placeholder = makeSyntheticNode(
      id: "loading:\(dirNode.id)",
      parent: dirNode,
      name: "正在读取子目录…",
      kind: .loadingPlaceholder
    )
    dirNode.children = [placeholder]
    outlineView.reloadItem(dirNode, reloadChildren: true)
    if selectedNode === dirNode {
      presentDirectoryDetail(for: dirNode)
    }

    let watchdogID = UUID()
    let localCancel = LumenFolderCancelToken()
    let watchdog = DispatchWorkItem { [weak self] in
      guard let self, self.loadGeneration == gen, !token.isCancelled else { return }
      self.pendingTimeoutTimers.removeValue(forKey: watchdogID)
      localCancel.cancel()
      self.applyChildLoadTimeout(for: dirNode)
    }
    pendingTimeoutTimers[watchdogID] = watchdog
    DispatchQueue.main.asyncAfter(deadline: .now() + LumenFolderLimits.scanTimeoutSeconds, execute: watchdog)

    let includeHidden = showHiddenFiles
    let canonicalRoot = canonicalRootPath
    let deadline = CFAbsoluteTimeGetCurrent() + LumenFolderLimits.scanTimeoutSeconds
    let dirURL = dirNode.url
    let relBase = dirNode.relativePath

    scanQueue.async { [weak self] in
      let outcome = LumenFolderScanner.scanDirectChildren(
        of: dirURL,
        relativeBase: relBase,
        canonicalRoot: canonicalRoot,
        includeHidden: includeHidden,
        remainingBudget: remaining,
        deadline: deadline,
        cancelToken: localCancel
      )
      DispatchQueue.main.async {
        guard let self, self.loadGeneration == gen, !token.isCancelled, !localCancel.isCancelled else { return }
        self.pendingTimeoutTimers.removeValue(forKey: watchdogID)?.cancel()
        self.attachScanOutcome(outcome, to: dirNode)
        self.outlineView.reloadItem(dirNode, reloadChildren: true)
        if expandAfterLoad {
          self.outlineView.expandItem(dirNode)
        }
        self.updateTopSummary()
        if self.selectedNode === dirNode {
          self.presentDirectoryDetail(for: dirNode)
        }
      }
    }
  }

  private func applyChildLoadTimeout(for dirNode: LumenFolderNode) {
    anyLoadError = true
    dirNode.loadState = .failed(.timedOut)
    let errNode = makeSyntheticNode(
      id: "timeout:\(dirNode.id)",
      parent: dirNode,
      name: LumenFolderScanError.timedOut.title,
      kind: .errorRow(.timedOut)
    )
    dirNode.children = [errNode]
    outlineView.reloadItem(dirNode, reloadChildren: true)
    updateTopSummary()
    if selectedNode === dirNode {
      presentDirectoryDetail(for: dirNode)
    }
  }

  private func attachScanOutcome(_ outcome: LumenFolderScanOutcome, to parentNode: LumenFolderNode) {
    parentNode.hiddenDirectCount = outcome.hiddenSkippedCount
    var built: [LumenFolderNode] = []
    built.reserveCapacity(outcome.entries.count + 2)

    for entry in outcome.entries {
      let nodeID = "n:\(entry.relativePath)"
      let child = LumenFolderNode(
        id: nodeID,
        url: entry.url,
        name: entry.name,
        relativePath: entry.relativePath,
        depth: parentNode.depth + 1,
        kind: entry.kind,
        isHidden: entry.isHidden,
        byteSize: entry.byteSize,
        modifiedAt: entry.modifiedAt,
        isReadable: entry.isReadable,
        identity: entry.identity,
        loadState: {
          if case .directory = entry.kind { return .notLoaded }
          return .loaded
        }()
      )
      child.parent = parentNode
      built.append(child)
      nodeByID[child.id] = child
      totalLoadedRealNodes += 1
    }

    if let err = outcome.error {
      anyLoadError = true
      parentNode.loadState = .failed(err)
      let errRow = makeSyntheticNode(
        id: "err:\(parentNode.id)",
        parent: parentNode,
        name: err.title,
        kind: .errorRow(err)
      )
      built.append(errRow)
    } else {
      parentNode.loadState = .loaded
    }

    if outcome.truncatedByLimit || totalLoadedRealNodes >= LumenFolderLimits.maxTotalNodes {
      reachedNodeLimit = true
      if outcome.truncatedByLimit {
        let limitRow = makeSyntheticNode(
          id: "limit:\(parentNode.id)",
          parent: parentNode,
          name: "已达 \(LumenFolderLimits.maxTotalNodes) 节点上限，剩余项已省略",
          kind: .limitNotice("目录树总节点数达到 \(LumenFolderLimits.maxTotalNodes) 上限，同级剩余条目已省略。")
        )
        built.append(limitRow)
      }
    }

    if built.isEmpty {
      let emptyTitle = outcome.hiddenSkippedCount > 0
        ? "仅含 \(outcome.hiddenSkippedCount) 个隐藏项"
        : "此目录为空"
      let emptyRow = makeSyntheticNode(
        id: "empty:\(parentNode.id)",
        parent: parentNode,
        name: emptyTitle,
        kind: .emptyNotice(hiddenCount: outcome.hiddenSkippedCount)
      )
      built.append(emptyRow)
    }

    parentNode.children = built
  }

  private func makeSyntheticNode(
    id: String,
    parent: LumenFolderNode,
    name: String,
    kind: LumenFolderNode.Kind
  ) -> LumenFolderNode {
    let synthIdentity = LumenContentIdentity(
      family: .file,
      subtype: "notice",
      language: nil,
      confidence: .unknown,
      glyphID: "unknown",
      displayName: "提示",
      logicalCategory: .otherFile,
      rendererID: nil,
      previewAvailability: .unsupported,
      lightColorHex: "#8592a6"
    )
    let node = LumenFolderNode(
      id: id,
      url: parent.url,
      name: name,
      relativePath: parent.relativePath,
      depth: parent.depth + 1,
      kind: kind,
      isHidden: false,
      byteSize: nil,
      modifiedAt: nil,
      isReadable: false,
      identity: synthIdentity,
      loadState: .loaded
    )
    node.parent = parent
    return node
  }

  // MARK: - Top Summary Calculation (Never Uses Path Byte Count or Inode Size)

  private func updateTopSummary() {
    guard let root = rootNode else {
      summaryLabel.stringValue = "文件夹 · 总大小 未知"
      return
    }
    let identityName = root.identity.displayName

    if root.isPackage && root.loadState == .notLoaded {
      summaryLabel.stringValue = "程序包 · 默认折叠 · 总大小 未知"
      summaryLabel.setAccessibilityValue(summaryLabel.stringValue)
      return
    }

    if case .failed(let err) = root.loadState, totalLoadedRealNodes == 0 {
      summaryLabel.stringValue = "\(identityName) · \(err.shortInlineTag) · 总大小 未知"
      return
    }

    var fileCount = 0
    var dirCount = 0
    var regularBytes: Int64 = 0
    var knownFileSizeCount = 0
    var unknownFileSizeCount = 0
    var hasUnexpandedDir = false

    func walk(_ node: LumenFolderNode) {
      for child in node.children {
        switch child.kind {
        case .directory:
          dirCount += 1
          if child.loadState != .loaded {
            hasUnexpandedDir = true
          } else {
            walk(child)
          }
        case .regularFile:
          fileCount += 1
          if let bytes = child.byteSize, bytes >= 0 {
            regularBytes += bytes
            knownFileSizeCount += 1
          } else {
            unknownFileSizeCount += 1
          }
        case .symlink:
          fileCount += 1
          unknownFileSizeCount += 1
        case .loadingPlaceholder, .emptyNotice, .errorRow, .limitNotice:
          break
        }
      }
    }
    walk(root)

    let totalItems = fileCount + dirCount
    let countText: String
    if reachedNodeLimit {
      countText = "已载入 \(totalItems) 项（达 \(LumenFolderLimits.maxTotalNodes) 上限）"
    } else if hasUnexpandedDir {
      countText = "已载入 \(totalItems) 项"
    } else if totalItems == 0 && root.hiddenDirectCount > 0 && !showHiddenFiles {
      countText = "0 项（含 \(root.hiddenDirectCount) 个隐藏项）"
    } else {
      countText = "\(totalItems) 项"
    }

    let isPartial = hasUnexpandedDir || reachedNodeLimit || anyLoadError || unknownFileSizeCount > 0 || (root.hiddenDirectCount > 0 && !showHiddenFiles)
    let sizeText: String
    if totalItems == 0 && !isPartial {
      sizeText = "总大小 0 B"
    } else if knownFileSizeCount == 0 {
      // Never fabricate size from directory inode or path UTF-8 byte count.
      sizeText = "总大小 未知"
    } else if isPartial {
      sizeText = "已载入文件 \(LumenFormatters.byteCount(regularBytes))（未含未展开项）"
    } else {
      sizeText = "总大小 \(LumenFormatters.byteCount(regularBytes))"
    }

    summaryLabel.stringValue = "\(identityName) · \(countText) · \(sizeText)"
    summaryLabel.setAccessibilityValue(summaryLabel.stringValue)
  }

  // MARK: - Selection & Right-Pane Preview Routing

  private func selectAndPresent(node: LumenFolderNode, syncOutlineSelection: Bool) {
    let previousNode = selectedNode
    selectedNode = node

    if syncOutlineSelection {
      // Ensure ancestors are expanded so the target row is visible in the outline tree.
      var ancestors: [LumenFolderNode] = []
      var cursor = node.parent
      while let anc = cursor {
        if anc === rootNode && !anc.isPackage {
          break
        }
        ancestors.append(anc)
        cursor = anc.parent
      }
      for anc in ancestors.reversed() {
        outlineView.expandItem(anc)
      }
      let row = outlineView.row(forItem: node)
      if row >= 0 {
        outlineView.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        outlineView.scrollRowToVisible(row)
      }
    }

    switch node.kind {
    case .directory:
      presentDirectoryDetail(for: node)

    case .regularFile:
      presentRegularFile(node)

    case .symlink(let target, let pointsOutsideRoot):
      teardownActiveMemberRenderer()
      let targetDesc = target.map { "目标：\($0)" } ?? "目标路径无法解析"
      let reason = pointsOutsideRoot
        ? "此符号链接指向当前根目录之外（\(targetDesc)）。为防止越界遍历与循环引用，已禁止展开或自动读取链接目标。"
        : "此条目为符号链接（\(targetDesc)）。为防止循环引用，安全目录树仅以链接形式展示并禁止展开。"
      showUnsupportedOrSymlinkCard(
        node: node,
        title: node.name,
        meta: "符号链接 · 大小 未知 · \(LumenFolderDateFormatter.format(node.modifiedAt))",
        path: node.url.path,
        reason: reason,
        useLockBadge: pointsOutsideRoot,
        canOpenDefault: false
      )

    case .errorRow(let err):
      teardownActiveMemberRenderer()
      showErrorCard(
        title: err.title,
        meta: "目录读取异常",
        path: node.url.path,
        reason: err.detail,
        canRetry: true,
        canReveal: FileManager.default.fileExists(atPath: node.url.path),
        canOpenDefault: false
      )

    case .limitNotice(let detail):
      teardownActiveMemberRenderer()
      showErrorCard(
        title: node.name,
        meta: "安全遍历上限",
        path: node.url.path,
        reason: detail,
        canRetry: false,
        canReveal: FileManager.default.fileExists(atPath: node.url.path),
        canOpenDefault: false
      )

    case .emptyNotice(let hiddenCount):
      teardownActiveMemberRenderer()
      let reason = hiddenCount > 0
        ? "此目录中有 \(hiddenCount) 个隐藏项目，默认不显示。点击顶部「显示隐藏项」可切换查看。"
        : "此文件夹下没有任何子文件或子目录。"
      showErrorCard(
        title: hiddenCount > 0 ? "仅包含隐藏项目" : "此文件夹为空",
        meta: "0 项 · 大小 0 B",
        path: node.url.path,
        reason: reason,
        canRetry: false,
        canReveal: true,
        canOpenDefault: false
      )

    case .loadingPlaceholder:
      teardownActiveMemberRenderer()
      showLoadingCard(title: node.parent?.name ?? "目录", path: node.url.path)
    }

    reloadOutlineRows(for: [previousNode, node])
  }

  private func reloadOutlineRows(for nodes: [LumenFolderNode?]) {
    var rows = IndexSet()
    let totalRows = outlineView.numberOfRows
    for candidate in nodes {
      guard let candidate else { continue }
      let idx = outlineView.row(forItem: candidate)
      if idx >= 0 && idx < totalRows {
        rows.insert(idx)
      }
    }
    guard !rows.isEmpty, outlineView.numberOfColumns > 0 else { return }
    outlineView.reloadData(forRowIndexes: rows, columnIndexes: IndexSet(integer: 0))
  }

  /// Reuses `LumenPreviewRegistry` for regular files; never duplicates file parsers or pretends unknown files rendered.
  private func presentRegularFile(_ node: LumenFolderNode) {
    teardownActiveMemberRenderer()

    let fm = FileManager.default
    guard fm.fileExists(atPath: node.url.path) else {
      showUnsupportedOrSymlinkCard(
        node: node,
        title: node.name,
        meta: "\(node.identity.displayName) · 大小 未知",
        path: node.url.path,
        reason: "该文件在磁盘上已不存在或已被移动，无法读取预览。",
        useLockBadge: true,
        canOpenDefault: false
      )
      return
    }
    guard node.isReadable && fm.isReadableFile(atPath: node.url.path) else {
      showUnsupportedOrSymlinkCard(
        node: node,
        title: node.name,
        meta: "\(node.identity.displayName) · \(node.formattedSizeText) · \(LumenFolderDateFormatter.format(node.modifiedAt))",
        path: node.url.path,
        reason: "当前没有读取此文件的权限（权限不足），无法预览内容。",
        useLockBadge: true,
        canOpenDefault: false
      )
      return
    }

    let memberKind = LumenPreviewItem.previewKind(for: node.identity, filePath: node.url.path)
    let memberItem = LumenPreviewItem(
      id: "folder-member:\(node.url.path)",
      title: node.name,
      subtitle: node.relativePath.isEmpty ? node.name : node.relativePath,
      kind: memberKind,
      identity: node.identity,
      clipboardItem: nil,
      fileIndex: nil,
      localURL: node.url,
      byteSize: node.byteSize ?? 0,
      inlineText: nil,
      seedIndex: 0,
      collectionChildren: []
    )

    let resolved = LumenPreviewRegistry.shared.resolve(
      for: memberItem,
      excluding: [LumenFolderRenderer.rendererIDStatic]
    )

    // Unknown or unsupported file format: show canonical identity glyph + explicit reason; NEVER fake rendered content (A61, A77).
    if resolved is LumenFileFallbackRenderer {
      let ext = node.url.pathExtension.isEmpty ? "无扩展名" : ".\(node.url.pathExtension.lowercased())"
      let reason = "暂不支持 \(node.identity.displayName)（\(ext)）的内置只读预览，未生成模拟内容。可在访达中定位或使用系统默认应用打开。"
      showUnsupportedOrSymlinkCard(
        node: node,
        title: node.name,
        meta: "\(node.identity.displayName) · \(node.formattedSizeText) · \(LumenFolderDateFormatter.format(node.modifiedAt))",
        path: node.url.path,
        reason: reason,
        useLockBadge: false,
        canOpenDefault: true
      )
      return
    }

    let baseCtx = currentContext
    let childContext = LumenPreviewContext(
      store: baseCtx?.store ?? LumenClipboardStore.shared,
      cache: baseCtx?.cache ?? LumenPreviewCache.shared,
      palette: palette,
      queueCount: 1,
      queueIndex: 0,
      onStepQueue: { _, _ in },
      onSelectQueueIndex: { _ in },
      onToast: { [weak self] msg in self?.currentContext?.onToast(msg) },
      onCopyItem: { [weak self] item in self?.copyMemberItem(item) }
    )

    let rendererView = resolved.makeView(for: memberItem, context: childContext)
    rendererView.load(item: memberItem, context: childContext)
    rendererView.translatesAutoresizingMaskIntoConstraints = false

    memberStageHost.addSubview(rendererView)
    NSLayoutConstraint.activate([
      rendererView.topAnchor.constraint(equalTo: memberStageHost.topAnchor),
      rendererView.leadingAnchor.constraint(equalTo: memberStageHost.leadingAnchor),
      rendererView.trailingAnchor.constraint(equalTo: memberStageHost.trailingAnchor),
      rendererView.bottomAnchor.constraint(equalTo: memberStageHost.bottomAnchor)
    ])
    activeMemberRendererView = rendererView

    let relDisplay = node.relativePath.isEmpty ? node.name : node.relativePath
    memberBreadcrumbLabel.stringValue = "\(relDisplay)  ·  \(node.formattedSizeText)  ·  \(LumenFolderDateFormatter.format(node.modifiedAt))"
    memberBreadcrumbLabel.toolTip = node.url.path

    noticeOverlay.isHidden = true
    dirDetailView.isHidden = true
    memberHeaderBar.isHidden = false
    memberStageHost.isHidden = false
  }

  private func presentDirectoryDetail(for dirNode: LumenFolderNode) {
    teardownActiveMemberRenderer()
    memberHeaderBar.isHidden = true
    memberStageHost.isHidden = true
    noticeOverlay.isHidden = true
    dirDetailView.isHidden = false

    dirGlyph.configure(identity: dirNode.identity, isDark: palette.isDark, size: 28)
    dirTitleLabel.stringValue = dirNode.name
    dirTitleLabel.toolTip = dirNode.url.path
    dirPackageBadge.isHidden = !dirNode.isPackage

    let pathText = dirNode.relativePath.isEmpty ? dirNode.url.path : dirNode.relativePath
    dirSubtitleLabel.toolTip = dirNode.url.path

    // Trigger lazy load automatically when selecting a regular (non-package) unloaded directory.
    // Packages (.app/.bundle) remain collapsed by default until user clicks expand or "浏览包内容".
    if dirNode.loadState == .notLoaded && !dirNode.isPackage {
      loadLazyChildren(for: dirNode, expandAfterLoad: false)
    }

    let realChildren = dirNode.children.filter { $0.isRealEntry }
    displayedDirChildren = realChildren

    let isFailed: Bool
    let failedError: LumenFolderScanError?
    if case .failed(let err) = dirNode.loadState {
      isFailed = true
      failedError = err
    } else {
      isFailed = false
      failedError = nil
    }

    dirExpandPackageBtn.isHidden = !(dirNode.isPackage && dirNode.loadState == .notLoaded)
    dirRetryBtn.isHidden = !isFailed

    if dirNode.isPackage && dirNode.loadState == .notLoaded {
      dirSubtitleLabel.stringValue = "\(pathText) · 程序包默认折叠 · 总大小 未知"
      dirEmptyLabel.stringValue = "「\(dirNode.name)」是 macOS 程序包（\(dirNode.url.pathExtension.isEmpty ? "Package" : ".\(dirNode.url.pathExtension)")），默认保持折叠。\n点击右上角「浏览包内容」或在左侧展开箭头可只读查看包内结构。"
      dirEmptyLabel.isHidden = false
      dirTableScroll.isHidden = true
    } else if dirNode.loadState == .loading {
      dirSubtitleLabel.stringValue = "\(pathText) · 正在读取…"
      dirEmptyLabel.stringValue = "正在只读扫描目录内容…"
      dirEmptyLabel.isHidden = false
      dirTableScroll.isHidden = true
    } else if let err = failedError, realChildren.isEmpty {
      dirSubtitleLabel.stringValue = "\(pathText) · \(err.shortInlineTag)"
      dirEmptyLabel.stringValue = "\(err.title)\n\(err.detail)"
      dirEmptyLabel.isHidden = false
      dirTableScroll.isHidden = true
    } else if realChildren.isEmpty {
      let hiddenNote = dirNode.hiddenDirectCount > 0 && !showHiddenFiles
        ? "此目录包含 \(dirNode.hiddenDirectCount) 个隐藏项目（默认隐藏）。点击顶部「显示隐藏项」可查看。"
        : "此目录为空，无子项目。"
      dirSubtitleLabel.stringValue = "\(pathText) · 0 项 · 总大小 0 B"
      dirEmptyLabel.stringValue = hiddenNote
      dirEmptyLabel.isHidden = false
      dirTableScroll.isHidden = true
    } else {
      let directFileBytes = realChildren.compactMap { $0.byteSize }.reduce(0, +)
      let hasDirectFiles = realChildren.contains { !$0.isDirectory && !$0.isSymlink && $0.byteSize != nil }
      let hasDirectSubdirs = realChildren.contains { $0.isDirectory || $0.isSymlink }
      let sizeFragment: String
      if !hasDirectFiles {
        sizeFragment = "总大小 未知"
      } else if hasDirectSubdirs {
        sizeFragment = "直属文件 \(LumenFormatters.byteCount(directFileBytes))"
      } else {
        sizeFragment = "总大小 \(LumenFormatters.byteCount(directFileBytes))"
      }
      dirSubtitleLabel.stringValue = "\(pathText) · \(realChildren.count) 项 · \(sizeFragment) · 双击打开"
      dirEmptyLabel.isHidden = true
      dirTableScroll.isHidden = false
    }

    dirTable.reloadData()
  }

  private func showLoadingCard(title: String, path: String) {
    memberHeaderBar.isHidden = true
    memberStageHost.isHidden = true
    dirDetailView.isHidden = true
    noticeOverlay.isHidden = false

    noticeIdentityGlyph.isHidden = true
    noticeStatusBadge.isHidden = false
    noticeStatusBadge.layer?.backgroundColor = palette.accentSoft.cgColor
    noticeStatusBadge.layer?.borderColor = palette.accentBorder.cgColor

    if LumenMotion.isEnabled {
      noticeStatusIcon.isHidden = true
      noticeSpinner.isHidden = false
      noticeSpinner.startAnimation(nil)
    } else {
      noticeSpinner.stopAnimation(nil)
      noticeSpinner.isHidden = true
      noticeStatusIcon.isHidden = false
      noticeStatusIcon.image = LumenVectorGlyphs.actionImage(.clock, size: 20, color: palette.accent)
    }

    noticeTitleLabel.stringValue = "正在扫描「\(title)」…"
    noticeMetaLabel.stringValue = "只读安全遍历 · 默认展开两层 · 上限 \(LumenFolderLimits.maxTotalNodes) 节点"
    noticePathLabel.stringValue = path
    noticePathLabel.toolTip = path
    noticeReasonLabel.stringValue = "不跟随越界符号链接，不写入或执行任何文件内容。"
    noticeReasonLabel.textColor = palette.muted

    noticeRetryBtn.isHidden = true
    noticeRevealBtn.isHidden = false
    noticeOpenDefaultBtn.isHidden = true
    noticeCopyPathBtn.isHidden = false
  }

  private func showUnsupportedOrSymlinkCard(
    node: LumenFolderNode,
    title: String,
    meta: String,
    path: String,
    reason: String,
    useLockBadge: Bool,
    canOpenDefault: Bool
  ) {
    memberHeaderBar.isHidden = true
    memberStageHost.isHidden = true
    dirDetailView.isHidden = true
    noticeOverlay.isHidden = false
    noticeSpinner.stopAnimation(nil)
    noticeSpinner.isHidden = true

    if useLockBadge {
      noticeIdentityGlyph.isHidden = true
      noticeStatusBadge.isHidden = false
      noticeStatusBadge.layer?.backgroundColor = palette.dangerSoft.cgColor
      noticeStatusBadge.layer?.borderColor = palette.danger.withAlphaComponent(0.38).cgColor
      noticeStatusIcon.isHidden = false
      noticeStatusIcon.image = LumenVectorGlyphs.actionImage(.lock, size: 20, color: palette.danger)
    } else {
      noticeStatusBadge.isHidden = true
      noticeIdentityGlyph.isHidden = false
      noticeIdentityGlyph.configure(identity: node.identity, isDark: palette.isDark, size: 48)
    }

    noticeTitleLabel.stringValue = title
    noticeTitleLabel.toolTip = title
    noticeMetaLabel.stringValue = meta
    noticePathLabel.stringValue = path
    noticePathLabel.toolTip = path
    noticeReasonLabel.stringValue = reason
    noticeReasonLabel.textColor = useLockBadge ? palette.danger : palette.muted

    noticeRetryBtn.isHidden = true
    noticeRevealBtn.isHidden = !FileManager.default.fileExists(atPath: path)
    noticeOpenDefaultBtn.isHidden = !canOpenDefault
    noticeCopyPathBtn.isHidden = path.isEmpty
  }

  private func showErrorCard(
    title: String,
    meta: String,
    path: String,
    reason: String,
    canRetry: Bool,
    canReveal: Bool,
    canOpenDefault: Bool
  ) {
    memberHeaderBar.isHidden = true
    memberStageHost.isHidden = true
    dirDetailView.isHidden = true
    noticeOverlay.isHidden = false
    noticeSpinner.stopAnimation(nil)
    noticeSpinner.isHidden = true

    noticeIdentityGlyph.isHidden = true
    noticeStatusBadge.isHidden = false
    noticeStatusBadge.layer?.backgroundColor = palette.dangerSoft.cgColor
    noticeStatusBadge.layer?.borderColor = palette.danger.withAlphaComponent(0.38).cgColor
    noticeStatusIcon.isHidden = false
    noticeStatusIcon.image = LumenVectorGlyphs.actionImage(.lock, size: 20, color: palette.danger)

    noticeTitleLabel.stringValue = title
    noticeMetaLabel.stringValue = meta
    noticePathLabel.stringValue = path
    noticePathLabel.toolTip = path
    noticeReasonLabel.stringValue = reason
    noticeReasonLabel.textColor = palette.danger

    noticeRetryBtn.isHidden = !canRetry
    noticeRevealBtn.isHidden = !canReveal
    noticeOpenDefaultBtn.isHidden = !canOpenDefault
    noticeCopyPathBtn.isHidden = path.isEmpty
  }

  private func copyMemberItem(_ item: LumenPreviewItem) {
    if let url = item.localURL {
      let pb = NSPasteboard.general
      pb.clearContents()
      pb.writeObjects([url as NSURL])
      currentContext?.onToast("已复制文件引用")
    }
  }

  // MARK: - Actions

  @objc private func toggleHiddenClicked() {
    showHiddenFiles.toggle()
    refreshButtonThemes()
    guard let url = rootURL, let item = currentItem else { return }
    startRootScan(for: url, sourceIdentity: item.identity)
  }

  @objc private func revealRootClicked() {
    guard let url = rootURL, FileManager.default.fileExists(atPath: url.path) else { return }
    NSWorkspace.shared.activateFileViewerSelecting([url])
  }

  @objc private func copyRootPathClicked() {
    guard let path = rootURL?.path, !path.isEmpty else { return }
    copyPathString(path)
  }

  @objc private func revealSelectedClicked() {
    let targetURL = selectedNode?.url ?? rootURL
    guard let targetURL, FileManager.default.fileExists(atPath: targetURL.path) else { return }
    NSWorkspace.shared.activateFileViewerSelecting([targetURL])
  }

  @objc private func copySelectedPathClicked() {
    let path = selectedNode?.url.path ?? rootURL?.path ?? ""
    guard !path.isEmpty else { return }
    copyPathString(path)
  }

  @objc private func openSelectedWithDefaultClicked() {
    guard let node = selectedNode, case .regularFile = node.kind else { return }
    guard FileManager.default.fileExists(atPath: node.url.path) else { return }
    NSWorkspace.shared.open(node.url)
  }

  @objc private func expandSelectedPackageClicked() {
    guard let node = selectedNode, node.isDirectory, !node.isSymlink else { return }
    loadLazyChildren(for: node, expandAfterLoad: true)
  }

  @objc private func retrySelectedDirClicked() {
    guard let node = selectedNode else {
      if let url = rootURL, let item = currentItem {
        startRootScan(for: url, sourceIdentity: item.identity)
      }
      return
    }
    if node === rootNode {
      if node.isPackage {
        node.loadState = .notLoaded
        loadLazyChildren(for: node, expandAfterLoad: true)
      } else if let url = rootURL, let item = currentItem {
        startRootScan(for: url, sourceIdentity: item.identity)
      }
      return
    }
    if case .errorRow = node.kind, let parent = node.parent {
      if parent === rootNode, let url = rootURL, let item = currentItem {
        startRootScan(for: url, sourceIdentity: item.identity)
      } else {
        parent.loadState = .notLoaded
        loadLazyChildren(for: parent, expandAfterLoad: true)
      }
      return
    }
    if node.isDirectory && !node.isSymlink {
      node.loadState = .notLoaded
      loadLazyChildren(for: node, expandAfterLoad: true)
    }
  }

  @objc private func dirChildSingleClicked() {
    let row = dirTable.clickedRow
    guard row >= 0, row < displayedDirChildren.count else { return }
    let count = dirTable.numberOfRows
    guard count > 0, dirTable.numberOfColumns > 0 else { return }
    dirTable.reloadData(forRowIndexes: IndexSet(integersIn: 0..<count), columnIndexes: IndexSet(integer: 0))
  }

  @objc private func dirChildDoubleClicked() {
    let row = dirTable.clickedRow
    guard row >= 0, row < displayedDirChildren.count else { return }
    let child = displayedDirChildren[row]
    selectAndPresent(node: child, syncOutlineSelection: true)
  }

  private func copyPathString(_ path: String) {
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setString(path, forType: .string)
    currentContext?.onToast("已复制路径")
  }

  // MARK: - NSOutlineViewDataSource & Delegate (Left Safe Directory Tree)

  func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
    if item == nil {
      guard let root = rootNode else { return 0 }
      return root.isPackage ? 1 : root.children.count
    }
    guard let node = item as? LumenFolderNode else { return 0 }
    return node.children.count
  }

  func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
    if item == nil, let root = rootNode {
      if root.isPackage {
        return root
      }
      if index < root.children.count {
        return root.children[index]
      }
    }
    if let node = item as? LumenFolderNode, index < node.children.count {
      return node.children[index]
    }
    return NSNull()
  }

  func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
    guard let node = item as? LumenFolderNode else { return false }
    return node.isExpandableInTree
  }

  func outlineView(_ outlineView: NSOutlineView, heightOfRowByItem item: Any) -> CGFloat {
    38
  }

  func outlineView(_ outlineView: NSOutlineView, shouldSelectItem item: Any) -> Bool {
    guard let node = item as? LumenFolderNode else { return false }
    if case .loadingPlaceholder = node.kind { return false }
    return true
  }

  func outlineViewItemWillExpand(_ notification: Notification) {
    guard let node = notification.userInfo?["NSObject"] as? LumenFolderNode else { return }
    guard node.isDirectory, !node.isSymlink else { return }
    if node.loadState == .notLoaded {
      loadLazyChildren(for: node, expandAfterLoad: false)
    }
  }

  func outlineViewSelectionDidChange(_ notification: Notification) {
    let row = outlineView.selectedRow
    guard row >= 0, let node = outlineView.item(atRow: row) as? LumenFolderNode else {
      if let root = rootNode {
        selectAndPresent(node: root, syncOutlineSelection: false)
      }
      return
    }
    if selectedNode !== node {
      selectAndPresent(node: node, syncOutlineSelection: false)
    }
  }

  func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
    guard let node = item as? LumenFolderNode else { return nil }
    let isSelected = (selectedNode === node)

    let cell = NSView()
    cell.wantsLayer = true
    cell.layer?.cornerRadius = 7
    cell.layer?.cornerCurve = .continuous
    cell.layer?.backgroundColor = (isSelected ? palette.accentSoft : NSColor.clear).cgColor
    cell.layer?.borderWidth = isSelected ? 1 : 0
    cell.layer?.borderColor = (isSelected ? palette.accentBorder : NSColor.clear).cgColor

    let iconView: NSView
    switch node.kind {
    case .errorRow, .limitNotice:
      let iv = NSImageView(image: LumenVectorGlyphs.actionImage(.lock, size: 15, color: palette.danger))
      iv.translatesAutoresizingMaskIntoConstraints = false
      iconView = iv
    case .loadingPlaceholder:
      let iv = NSImageView(image: LumenVectorGlyphs.actionImage(.clock, size: 15, color: palette.muted))
      iv.translatesAutoresizingMaskIntoConstraints = false
      iconView = iv
    case .emptyNotice:
      let iv = NSImageView(image: LumenVectorGlyphs.actionImage(.all, size: 14, color: palette.muted))
      iv.translatesAutoresizingMaskIntoConstraints = false
      iconView = iv
    case .symlink(_, let outside):
      let iv = NSImageView(image: LumenVectorGlyphs.actionImage(.externalLink, size: 15, color: outside ? palette.warning : palette.accent))
      iv.translatesAutoresizingMaskIntoConstraints = false
      iconView = iv
    case .directory, .regularFile:
      let glyph = LumenIdentityGlyphView(size: 16)
      glyph.configure(identity: node.identity, isDark: palette.isDark, size: 16)
      glyph.translatesAutoresizingMaskIntoConstraints = false
      iconView = glyph
    }

    let nameLabel = NSTextField(labelWithString: node.name)
    nameLabel.font = .systemFont(ofSize: 12, weight: isSelected ? .semibold : (node.isDirectory ? .medium : .regular))
    nameLabel.lineBreakMode = .byTruncatingMiddle
    nameLabel.maximumNumberOfLines = 1
    nameLabel.translatesAutoresizingMaskIntoConstraints = false
    nameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    nameLabel.toolTip = node.relativePath.isEmpty ? node.name : node.relativePath

    switch node.kind {
    case .errorRow:
      nameLabel.textColor = palette.danger
    case .emptyNotice, .loadingPlaceholder, .limitNotice:
      nameLabel.textColor = palette.muted
    default:
      nameLabel.textColor = node.isHidden ? palette.muted : palette.ink
    }

    let sizeLabel = NSTextField(labelWithString: node.formattedSizeText)
    sizeLabel.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .medium)
    sizeLabel.textColor = palette.muted
    sizeLabel.alignment = .right
    sizeLabel.translatesAutoresizingMaskIntoConstraints = false
    sizeLabel.setContentHuggingPriority(.required, for: .horizontal)
    sizeLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

    var metaParts: [String] = []
    if node.isRealEntry {
      metaParts.append(LumenFolderDateFormatter.format(node.modifiedAt))
    }
    if node.isPackage {
      metaParts.append("程序包")
    } else if case .symlink(_, let outside) = node.kind {
      metaParts.append(outside ? "外部符号链接（禁止展开）" : "符号链接（禁止展开）")
    }
    if node.isHidden {
      metaParts.append("隐藏")
    }
    if !node.isReadable && node.isRealEntry {
      metaParts.append("无权限")
    }

    let subLabel = NSTextField(labelWithString: metaParts.joined(separator: " · "))
    subLabel.font = .monospacedDigitSystemFont(ofSize: 9.5, weight: .regular)
    subLabel.textColor = palette.muted.withAlphaComponent(0.88)
    subLabel.lineBreakMode = .byTruncatingTail
    subLabel.maximumNumberOfLines = 1
    subLabel.translatesAutoresizingMaskIntoConstraints = false
    subLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    cell.addSubview(iconView)
    cell.addSubview(nameLabel)
    cell.addSubview(sizeLabel)
    cell.addSubview(subLabel)

    NSLayoutConstraint.activate([
      iconView.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 4),
      iconView.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
      iconView.widthAnchor.constraint(equalToConstant: 16),
      iconView.heightAnchor.constraint(equalToConstant: 16),

      nameLabel.topAnchor.constraint(equalTo: cell.topAnchor, constant: 4),
      nameLabel.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: 7),
      nameLabel.trailingAnchor.constraint(lessThanOrEqualTo: sizeLabel.leadingAnchor, constant: -6),

      sizeLabel.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -8),
      sizeLabel.centerYAnchor.constraint(equalTo: nameLabel.centerYAnchor),

      subLabel.topAnchor.constraint(equalTo: nameLabel.bottomAnchor, constant: 1),
      subLabel.leadingAnchor.constraint(equalTo: nameLabel.leadingAnchor),
      subLabel.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -8)
    ])

    cell.setAccessibilityElement(true)
    cell.setAccessibilityRole(.row)
    cell.setAccessibilityLabel("\(node.name)，\(node.displayTypeTag)，\(node.formattedSizeText)")
    return cell
  }

  // MARK: - NSTableViewDataSource & Delegate (Right Pane Directory Children List)

  func numberOfRows(in tableView: NSTableView) -> Int {
    displayedDirChildren.count
  }

  func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
    guard row < displayedDirChildren.count else { return nil }
    let child = displayedDirChildren[row]
    let highlighted = (tableView.selectedRow == row)

    let cell = NSView()
    cell.wantsLayer = true
    cell.layer?.cornerRadius = 8
    cell.layer?.cornerCurve = .continuous
    cell.layer?.backgroundColor = (highlighted ? palette.accentSoft : palette.surface).cgColor
    cell.layer?.borderWidth = 1
    cell.layer?.borderColor = (highlighted ? palette.accentBorder : palette.border.withAlphaComponent(0.75)).cgColor

    let iconHost: NSView
    if case .symlink(_, let outside) = child.kind {
      let iv = NSImageView(image: LumenVectorGlyphs.actionImage(.externalLink, size: 17, color: outside ? palette.warning : palette.accent))
      iv.translatesAutoresizingMaskIntoConstraints = false
      iconHost = iv
    } else {
      let glyph = LumenIdentityGlyphView(size: 18)
      glyph.configure(identity: child.identity, isDark: palette.isDark, size: 18)
      glyph.translatesAutoresizingMaskIntoConstraints = false
      iconHost = glyph
    }

    let nameLabel = NSTextField(labelWithString: child.name)
    nameLabel.font = .systemFont(ofSize: 12.5, weight: child.isDirectory ? .semibold : .medium)
    nameLabel.textColor = child.isHidden ? palette.muted : palette.ink
    nameLabel.lineBreakMode = .byTruncatingMiddle
    nameLabel.maximumNumberOfLines = 1
    nameLabel.translatesAutoresizingMaskIntoConstraints = false
    nameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    nameLabel.toolTip = child.url.path

    var badges: [String] = [child.displayTypeTag]
    if child.isHidden { badges.append("隐藏") }
    if !child.isReadable { badges.append("无权限") }

    let metaLabel = NSTextField(labelWithString: badges.joined(separator: " · "))
    metaLabel.font = .systemFont(ofSize: 10.5)
    metaLabel.textColor = palette.muted
    metaLabel.lineBreakMode = .byTruncatingTail
    metaLabel.translatesAutoresizingMaskIntoConstraints = false
    metaLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    let dateLabel = NSTextField(labelWithString: LumenFolderDateFormatter.format(child.modifiedAt))
    dateLabel.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
    dateLabel.textColor = palette.muted
    dateLabel.alignment = .right
    dateLabel.translatesAutoresizingMaskIntoConstraints = false
    dateLabel.setContentHuggingPriority(.required, for: .horizontal)
    dateLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

    let sizeLabel = NSTextField(labelWithString: child.formattedSizeText)
    sizeLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .medium)
    sizeLabel.textColor = palette.ink
    sizeLabel.alignment = .right
    sizeLabel.translatesAutoresizingMaskIntoConstraints = false
    sizeLabel.setContentHuggingPriority(.required, for: .horizontal)
    sizeLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

    cell.addSubview(iconHost)
    cell.addSubview(nameLabel)
    cell.addSubview(metaLabel)
    cell.addSubview(dateLabel)
    cell.addSubview(sizeLabel)

    NSLayoutConstraint.activate([
      iconHost.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 10),
      iconHost.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
      iconHost.widthAnchor.constraint(equalToConstant: 18),
      iconHost.heightAnchor.constraint(equalToConstant: 18),

      nameLabel.topAnchor.constraint(equalTo: cell.topAnchor, constant: 5),
      nameLabel.leadingAnchor.constraint(equalTo: iconHost.trailingAnchor, constant: 9),
      nameLabel.trailingAnchor.constraint(lessThanOrEqualTo: dateLabel.leadingAnchor, constant: -10),

      metaLabel.topAnchor.constraint(equalTo: nameLabel.bottomAnchor, constant: 1),
      metaLabel.leadingAnchor.constraint(equalTo: nameLabel.leadingAnchor),
      metaLabel.trailingAnchor.constraint(lessThanOrEqualTo: dateLabel.leadingAnchor, constant: -10),

      sizeLabel.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -10),
      sizeLabel.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
      sizeLabel.widthAnchor.constraint(greaterThanOrEqualToConstant: 56),

      dateLabel.trailingAnchor.constraint(equalTo: sizeLabel.leadingAnchor, constant: -12),
      dateLabel.centerYAnchor.constraint(equalTo: cell.centerYAnchor)
    ])

    cell.setAccessibilityElement(true)
    cell.setAccessibilityRole(.row)
    cell.setAccessibilityLabel("\(child.name)，\(child.displayTypeTag)，\(child.formattedSizeText)")
    return cell
  }
}
