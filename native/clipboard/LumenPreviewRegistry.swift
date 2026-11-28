import AppKit
import Foundation
import PDFKit

/// Resolved renderer category for any clipboard entry, collection member, or local file.
enum LumenPreviewKind: Equatable {
  case text
  case code(language: String)
  case image
  case color
  case link
  case pdf
  case office(format: String) // "docx", "xlsx", "pptx"
  case audio
  case video
  case collection
  case file

  var displayLabel: String {
    switch self {
    case .text: return "文本"
    case .code(let lang): return LumenClassifier.languageDisplayName(lang)
    case .image: return "图片"
    case .color: return "颜色"
    case .link: return "链接"
    case .pdf: return "PDF 文档"
    case .office(let fmt):
      switch fmt.lowercased() {
      case "docx": return "Word 文档"
      case "xlsx": return "Excel 工作簿"
      case "pptx": return "PowerPoint 演示文稿"
      default: return "Office 文档"
      }
    case .audio: return "音频"
    case .video: return "视频"
    case .collection: return "文件集合"
    case .file: return "文件"
    }
  }

  var badgeCode: String {
    switch self {
    case .text: return "TXT"
    case .code(let lang): return lang.uppercased()
    case .image: return "IMG"
    case .color: return "HEX"
    case .link: return "URL"
    case .pdf: return "PDF"
    case .office(let fmt):
      switch fmt.lowercased() {
      case "docx": return "DOC"
      case "xlsx": return "XLS"
      case "pptx": return "PPT"
      default: return "OFF"
      }
    case .audio: return "MP3"
    case .video: return "MP4"
    case .collection: return "SET"
    case .file: return "FILE"
    }
  }

  var isMedia: Bool {
    switch self {
    case .audio, .video: return true
    default: return false
    }
  }
}

/// Unified preview target consumable by any renderer in the registry.
struct LumenPreviewItem: Equatable {
  let id: String
  let title: String
  let subtitle: String
  let kind: LumenPreviewKind
  let clipboardItem: LumenClipboardItem?
  let fileIndex: Int?
  let localURL: URL?
  let byteSize: Int64
  let inlineText: String?
  let seedIndex: Int
  let collectionChildren: [LumenPreviewItem]

  var cacheKey: String {
    if let item = clipboardItem {
      if let idx = fileIndex {
        return "clip:\(item.id):file:\(idx)"
      }
      return "clip:\(item.id)"
    }
    if let url = localURL {
      return "local:\(url.path)"
    }
    return "inline:\(id)"
  }

  var sizeLabel: String {
    if !collectionChildren.isEmpty {
      return "\(collectionChildren.count) 个项目"
    }
    if byteSize > 0 {
      return LumenFormatters.byteCount(byteSize)
    }
    if let text = inlineText {
      return LumenFormatters.byteCount(Int64(text.utf8.count))
    }
    return clipboardItem?.formattedSize ?? "内容预览"
  }

  static func classify(filePath: String) -> LumenPreviewKind {
    let ext = URL(fileURLWithPath: filePath).pathExtension.lowercased()
    if ext == "pdf" { return .pdf }
    if LumenClassifier.officeExtensions.contains(ext) { return .office(format: ext) }
    if LumenClassifier.imageExtensions.contains(ext) { return .image }
    if LumenClassifier.audioExtensions.contains(ext) { return .audio }
    if LumenClassifier.videoExtensions.contains(ext) { return .video }
    if LumenClassifier.codeExtensions.contains(ext) {
      return .code(language: LumenClassifier.detectLanguage(fileName: filePath, content: ""))
    }
    if LumenClassifier.textExtensions.contains(ext) { return .text }
    return .file
  }

  static func classify(item: LumenClipboardItem) -> LumenPreviewKind {
    switch item.kind {
    case "image":
      return .image
    case "link":
      return .link
    case "file":
      if item.files.count > 1 {
        return .collection
      }
      if let path = item.primaryFilePath {
        return classify(filePath: path)
      }
      return .file
    default:
      let text = item.effectiveText.trimmingCharacters(in: .whitespacesAndNewlines)
      if LumenClassifier.parseHexColor(text) != nil {
        return .color
      }
      if LumenClassifier.looksLikeCode(text) {
        return .code(language: LumenClassifier.detectLanguage(fileName: nil, content: text))
      }
      return .text
    }
  }

  static func fromClipboardItem(_ item: LumenClipboardItem, seedIndex: Int = 0) -> LumenPreviewItem {
    let kind = classify(item: item)
    if item.kind == "file" && item.files.count > 1 {
      let children = item.files.enumerated().map { idx, path in
        fromIndexedFile(item: item, index: idx, path: path, seedIndex: idx)
      }
      return LumenPreviewItem(
        id: item.id,
        title: item.displayTitle,
        subtitle: "\(item.sourceLabel) · \(item.relativeTime)",
        kind: .collection,
        clipboardItem: item,
        fileIndex: nil,
        localURL: nil,
        byteSize: item.byteSize,
        inlineText: item.files.joined(separator: "\n"),
        seedIndex: seedIndex,
        collectionChildren: children
      )
    }
    let singleURL: URL?
    if item.kind == "file", let path = item.primaryFilePath, FileManager.default.fileExists(atPath: path) {
      singleURL = URL(fileURLWithPath: path)
    } else {
      singleURL = nil
    }
    return LumenPreviewItem(
      id: item.id,
      title: item.displayTitle,
      subtitle: "\(item.sourceLabel) · \(item.relativeTime)",
      kind: kind,
      clipboardItem: item,
      fileIndex: item.kind == "file" ? 0 : nil,
      localURL: singleURL,
      byteSize: item.byteSize,
      inlineText: item.kind == "text" || item.kind == "link" ? item.effectiveText : nil,
      seedIndex: seedIndex,
      collectionChildren: []
    )
  }

  private static func fromIndexedFile(item: LumenClipboardItem, index: Int, path: String, seedIndex: Int) -> LumenPreviewItem {
    let cleanPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
    let url = URL(fileURLWithPath: cleanPath)
    let exists = FileManager.default.fileExists(atPath: cleanPath)
    let size = (try? FileManager.default.attributesOfItem(atPath: cleanPath)[.size] as? Int64) ?? 0
    return LumenPreviewItem(
      id: "\(item.id)#\(index)",
      title: url.lastPathComponent,
      subtitle: item.sourceLabel,
      kind: classify(filePath: cleanPath),
      clipboardItem: item,
      fileIndex: index,
      localURL: exists ? url : nil,
      byteSize: size,
      inlineText: nil,
      seedIndex: seedIndex,
      collectionChildren: []
    )
  }

  /// Flattens clipboard items into a preview queue (multi-file items expand into members).
  static func flatten(_ items: [LumenClipboardItem]) -> [LumenPreviewItem] {
    var result: [LumenPreviewItem] = []
    for (idx, item) in items.enumerated() {
      let wrapped = fromClipboardItem(item, seedIndex: idx)
      if !wrapped.collectionChildren.isEmpty {
        result.append(contentsOf: wrapped.collectionChildren)
      } else {
        result.append(wrapped)
      }
    }
    return result
  }

  static func fromLocalURLs(_ urls: [URL]) -> [LumenPreviewItem] {
    urls.enumerated().map { idx, url in
      let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int64) ?? 0
      return LumenPreviewItem(
        id: "local:\(url.path)",
        title: url.lastPathComponent,
        subtitle: "本地文件",
        kind: classify(filePath: url.path),
        clipboardItem: nil,
        fileIndex: nil,
        localURL: url,
        byteSize: size,
        inlineText: nil,
        seedIndex: idx,
        collectionChildren: []
      )
    }
  }
}

// MARK: - Bounded Preview Cache

final class LumenServerPreviewBox: NSObject {
  let value: LumenServerPreview
  init(_ value: LumenServerPreview) { self.value = value }
}

final class LumenWaveformBox: NSObject {
  let peaks: [CGFloat]
  init(_ peaks: [CGFloat]) { self.peaks = peaks }
}

/// Bounded in-memory LRU cache shared across Inspector thumbnails and the Quick Look preview window.
final class LumenPreviewCache {
  static let shared = LumenPreviewCache()

  private let imageCache: NSCache<NSString, NSImage> = {
    let cache = NSCache<NSString, NSImage>()
    cache.countLimit = 96
    cache.totalCostLimit = 64 * 1024 * 1024
    return cache
  }()

  private let pdfCache: NSCache<NSString, PDFDocument> = {
    let cache = NSCache<NSString, PDFDocument>()
    cache.countLimit = 12
    return cache
  }()

  private let waveformCache: NSCache<NSString, LumenWaveformBox> = {
    let cache = NSCache<NSString, LumenWaveformBox>()
    cache.countLimit = 32
    return cache
  }()

  private let serverPreviewCache: NSCache<NSString, LumenServerPreviewBox> = {
    let cache = NSCache<NSString, LumenServerPreviewBox>()
    cache.countLimit = 48
    return cache
  }()

  private let textCache: NSCache<NSString, NSString> = {
    let cache = NSCache<NSString, NSString>()
    cache.countLimit = 64
    cache.totalCostLimit = 8 * 1024 * 1024
    return cache
  }()

  func image(for key: String) -> NSImage? {
    imageCache.object(forKey: key as NSString)
  }

  func storeImage(_ image: NSImage, for key: String) {
    let pxW = max(1, Int(image.size.width * 2))
    let pxH = max(1, Int(image.size.height * 2))
    imageCache.setObject(image, forKey: key as NSString, cost: pxW * pxH * 4)
  }

  func pdf(for key: String) -> PDFDocument? {
    pdfCache.object(forKey: key as NSString)
  }

  func storePDF(_ doc: PDFDocument, for key: String) {
    pdfCache.setObject(doc, forKey: key as NSString)
  }

  func waveform(for key: String) -> [CGFloat]? {
    waveformCache.object(forKey: key as NSString)?.peaks
  }

  func storeWaveform(_ peaks: [CGFloat], for key: String) {
    waveformCache.setObject(LumenWaveformBox(peaks), forKey: key as NSString)
  }

  func serverPreview(for key: String) -> LumenServerPreview? {
    serverPreviewCache.object(forKey: key as NSString)?.value
  }

  func storeServerPreview(_ preview: LumenServerPreview, for key: String) {
    serverPreviewCache.setObject(LumenServerPreviewBox(preview), forKey: key as NSString)
  }

  func text(for key: String) -> String? {
    textCache.object(forKey: key as NSString) as String?
  }

  func storeText(_ text: String, for key: String) {
    textCache.setObject(text as NSString, forKey: key as NSString, cost: text.utf8.count)
  }

  func clearAll() {
    imageCache.removeAllObjects()
    pdfCache.removeAllObjects()
    waveformCache.removeAllObjects()
    serverPreviewCache.removeAllObjects()
    textCache.removeAllObjects()
  }
}

// MARK: - Renderer Protocol & Registry

struct LumenPreviewContext {
  let store: LumenClipboardStore
  let cache: LumenPreviewCache
  let palette: LumenPalette
  let onStepQueue: (Int, Bool) -> Void
  let onSelectQueueIndex: (Int) -> Void
  let onToast: (String) -> Void
  let onCopyItem: (LumenPreviewItem) -> Void
}

/// Base class for all native preview renderers mounted inside the shared preview container.
class LumenPreviewRendererView: NSView {
  private(set) var currentItem: LumenPreviewItem?
  var currentContext: LumenPreviewContext?

  func load(item: LumenPreviewItem, context: LumenPreviewContext) {
    currentItem = item
    currentContext = context
  }

  func applyTheme(_ palette: LumenPalette) {}
  func zoomIn() {}
  func zoomOut() {}
  func resetZoom() {}
  func togglePlayPause() -> Bool { false }
  func stepPage(_ delta: Int) -> Bool { false }
  func copyPrimaryContent() {
    guard let item = currentItem else { return }
    currentContext?.onCopyItem(item)
  }
  func teardown() {}
}

protocol LumenPreviewRenderer {
  var rendererID: String { get }
  var priority: Int { get }
  func canRender(_ item: LumenPreviewItem) -> Bool
  func makeView(for item: LumenPreviewItem, context: LumenPreviewContext) -> LumenPreviewRendererView
}

/// Ordered registry resolving the best native renderer for each preview item.
final class LumenPreviewRegistry {
  static let shared: LumenPreviewRegistry = {
    let registry = LumenPreviewRegistry()
    registry.registerDefaultRenderers()
    return registry
  }()

  private var renderers: [LumenPreviewRenderer] = []

  func register(_ renderer: LumenPreviewRenderer) {
    renderers.removeAll { $0.rendererID == renderer.rendererID }
    renderers.append(renderer)
    renderers.sort { $0.priority > $1.priority }
  }

  func registeredIDs() -> [String] {
    renderers.map(\.rendererID)
  }

  func resolve(for item: LumenPreviewItem) -> LumenPreviewRenderer {
    if let match = renderers.first(where: { $0.canRender(item) }) {
      return match
    }
    return LumenFileFallbackRenderer()
  }

  func makeView(for item: LumenPreviewItem, context: LumenPreviewContext) -> LumenPreviewRendererView {
    let renderer = resolve(for: item)
    let view = renderer.makeView(for: item, context: context)
    view.load(item: item, context: context)
    return view
  }

  private func registerDefaultRenderers() {
    register(LumenPDFRenderer())
    register(LumenAudioRenderer())
    register(LumenVideoRenderer())
    register(LumenOfficeRenderer())
    register(LumenImageRenderer())
    register(LumenColorRenderer())
    register(LumenCodeRenderer())
    register(LumenCollectionRenderer())
    register(LumenTextRenderer())
    register(LumenFileFallbackRenderer())
  }
}
