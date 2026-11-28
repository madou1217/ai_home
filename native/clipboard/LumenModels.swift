import AppKit
import Foundation

/// Visual smart category shown in Lumen sidebar, cards, and inspector.
/// Maps server canonical kinds (`text`, `link`, `image`, `file`) plus smart
/// client classification (`code`, `color`) without altering server storage.
enum LumenDisplayCategory: String, CaseIterable {
  case text
  case code
  case image
  case link
  case color
  case file

  var label: String {
    switch self {
    case .text: return "文本"
    case .code: return "代码"
    case .image: return "图片"
    case .link: return "链接"
    case .color: return "颜色"
    case .file: return "文件"
    }
  }

  var symbolName: String {
    switch self {
    // "textformat" has a localized glyph that renders as CJK text in zh_CN;
    // use a locale-neutral icon so the chip never reads as a label.
    case .text: return "text.alignleft"
    case .code: return "chevron.left.forwardslash.chevron.right"
    case .image: return "photo"
    case .link: return "link"
    case .color: return "drop.fill"
    case .file: return "doc.fill"
    }
  }
}

/// Persisted clipboard item returned by `/v1/management/webui/clipboard/items`.
struct LumenClipboardItem: Codable, Equatable {
  let id: String
  let sha256: String
  let kind: String
  let mime: String
  let byteSize: Int64
  let width: Int
  let height: Int
  let preview: String
  let thumbnailDataUrl: String
  let files: [String]
  let fileHashes: [String]
  let sourceDevice: String
  let sourceApp: String
  var pinned: Bool
  let deleted: Bool
  let seenCount: Int
  let createdAtMs: Int64
  let lastSeenAtMs: Int64
  let syncedAtMs: Int64
  let remoteId: String
  let materialized: Bool
  var text: String?
  var textTruncated: Bool?
  var blobPath: String?

  private enum CodingKeys: String, CodingKey {
    case id, sha256, kind, mime, byteSize, width, height, preview, thumbnailDataUrl
    case files, fileHashes, sourceDevice, sourceApp, pinned, deleted, seenCount
    case createdAtMs, lastSeenAtMs, syncedAtMs, remoteId, materialized
    case text, textTruncated, blobPath
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    sha256 = try c.decodeIfPresent(String.self, forKey: .sha256) ?? ""
    kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "text"
    mime = try c.decodeIfPresent(String.self, forKey: .mime) ?? ""
    byteSize = try c.decodeIfPresent(Int64.self, forKey: .byteSize) ?? 0
    width = try c.decodeIfPresent(Int.self, forKey: .width) ?? 0
    height = try c.decodeIfPresent(Int.self, forKey: .height) ?? 0
    preview = try c.decodeIfPresent(String.self, forKey: .preview) ?? ""
    thumbnailDataUrl = try c.decodeIfPresent(String.self, forKey: .thumbnailDataUrl) ?? ""
    files = try c.decodeIfPresent([String].self, forKey: .files) ?? []
    fileHashes = try c.decodeIfPresent([String].self, forKey: .fileHashes) ?? []
    sourceDevice = try c.decodeIfPresent(String.self, forKey: .sourceDevice) ?? ""
    sourceApp = try c.decodeIfPresent(String.self, forKey: .sourceApp) ?? ""
    pinned = try c.decodeIfPresent(Bool.self, forKey: .pinned) ?? false
    deleted = try c.decodeIfPresent(Bool.self, forKey: .deleted) ?? false
    seenCount = try c.decodeIfPresent(Int.self, forKey: .seenCount) ?? 1
    createdAtMs = try c.decodeIfPresent(Int64.self, forKey: .createdAtMs) ?? 0
    lastSeenAtMs = try c.decodeIfPresent(Int64.self, forKey: .lastSeenAtMs) ?? createdAtMs
    syncedAtMs = try c.decodeIfPresent(Int64.self, forKey: .syncedAtMs) ?? 0
    remoteId = try c.decodeIfPresent(String.self, forKey: .remoteId) ?? ""
    materialized = try c.decodeIfPresent(Bool.self, forKey: .materialized) ?? true
    text = try c.decodeIfPresent(String.self, forKey: .text)
    textTruncated = try c.decodeIfPresent(Bool.self, forKey: .textTruncated)
    blobPath = try c.decodeIfPresent(String.self, forKey: .blobPath)
  }

  var effectiveText: String {
    if let full = text, !full.isEmpty { return full }
    return preview
  }

  var primaryFilePath: String? {
    files.first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  }

  var contentIdentity: LumenContentIdentity {
    LumenContentIdentityRegistry.shared.identity(for: self)
  }

  var logicalCategory: LumenLogicalCategory {
    contentIdentity.logicalCategory
  }

  var displayCategory: LumenDisplayCategory {
    switch logicalCategory {
    case .image: return .image
    case .link: return .link
    case .code: return .code
    case .color: return .color
    case .document, .audio, .video, .otherFile: return .file
    case .all, .text: return .text
    }
  }

  var displayTitle: String {
    switch kind {
    case "file":
      if files.count > 1 {
        let first = URL(fileURLWithPath: files[0]).lastPathComponent
        return "\(files.count) 个文件 · \(first)"
      }
      if let path = primaryFilePath {
        return URL(fileURLWithPath: path).lastPathComponent
      }
      return preview.isEmpty ? "文件引用" : preview
    case "image":
      if width > 0 && height > 0 {
        return "图片 · \(width) × \(height)"
      }
      return preview.isEmpty ? "剪贴板图片" : preview
    case "link":
      let raw = effectiveText.trimmingCharacters(in: .whitespacesAndNewlines)
      if let url = URL(string: raw), let host = url.host, !host.isEmpty {
        let pathPart = url.path == "/" ? "" : url.path
        return host + pathPart
      }
      return raw.isEmpty ? "链接" : String(raw.prefix(72))
    default:
      let trimmed = effectiveText.trimmingCharacters(in: .whitespacesAndNewlines)
      if LumenClassifier.parseHexColor(trimmed) != nil {
        return trimmed.uppercased()
      }
      let firstLine = trimmed
        .split(whereSeparator: \.isNewline)
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .first { !$0.isEmpty } ?? ""
      if firstLine.isEmpty { return "空内容" }
      return firstLine.count > 72 ? String(firstLine.prefix(72)) + "…" : firstLine
    }
  }

  var hasKnownSourceApp: Bool {
    !LumenSourceAppResolver.isUnknown(sourceApp)
  }

  /// Display name for the application source (S01/S02, A10).
  /// Never falls back to `sourceDevice`; empty `sourceApp` always displays "来源未知".
  var sourceLabel: String {
    LumenSourceAppResolver.displayName(for: sourceApp)
  }

  /// Human-readable device label exclusively for the Inspector "来源设备" field.
  /// Resolves local device UUID to `status.deviceName` when available.
  var sourceDeviceLabel: String? {
    let clean = sourceDevice.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !clean.isEmpty else { return nil }
    if let status = LumenClipboardStore.shared.status {
      let localID = status.deviceId.trimmingCharacters(in: .whitespacesAndNewlines)
      let localName = status.deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
      if !localID.isEmpty && !localName.isEmpty && localID.caseInsensitiveCompare(clean) == .orderedSame {
        return localName
      }
    }
    return clean
  }

  var formattedSize: String {
    if kind == "file" && files.count > 1 {
      return "\(files.count) 项文件"
    }
    if kind == "file", let path = primaryFilePath {
      var isDir: ObjCBool = false
      let exists = FileManager.default.fileExists(atPath: path, isDirectory: &isDir)
      if path.hasSuffix("/") || (exists && isDir.boolValue) {
        return "未知"
      }
    }
    if byteSize <= 0 {
      if kind == "file" {
        if let path = primaryFilePath,
           let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int64),
           size > 0 {
          return LumenFormatters.byteCount(size)
        }
        return "未知"
      }
      if kind == "image", width > 0, height > 0 {
        return "\(width) × \(height)"
      }
      let utf8Len = effectiveText.utf8.count
      return utf8Len > 0 ? LumenFormatters.byteCount(Int64(utf8Len)) : "未知"
    }
    return LumenFormatters.byteCount(byteSize)
  }

  var timestampDate: Date {
    let ms = lastSeenAtMs > 0 ? lastSeenAtMs : createdAtMs
    return Date(timeIntervalSince1970: TimeInterval(ms) / 1000.0)
  }

  var relativeTime: String {
    LumenFormatters.relativeTime(fromMs: lastSeenAtMs > 0 ? lastSeenAtMs : createdAtMs)
  }

  var isToday: Bool {
    Calendar.current.isDateInToday(timestampDate)
  }

  var isYesterday: Bool {
    Calendar.current.isDateInYesterday(timestampDate)
  }

  func decodedThumbnailImage() -> NSImage? {
    guard !thumbnailDataUrl.isEmpty,
          let commaIndex = thumbnailDataUrl.firstIndex(of: ",") else {
      return nil
    }
    let b64 = String(thumbnailDataUrl[thumbnailDataUrl.index(after: commaIndex)...])
    guard let data = Data(base64Encoded: b64) else { return nil }
    return NSImage(data: data)
  }
}

struct LumenClipboardItemsResponse: Decodable {
  let items: [LumenClipboardItem]
}

struct LumenClipboardItemResponse: Decodable {
  let item: LumenClipboardItem
}

struct LumenBatchDeleteResponse: Decodable {
  let deleted: Int
}

struct LumenClipboardSettings: Codable, Equatable {
  var captureEnabled: Bool
  var syncEnabled: Bool
  var syncTargetProfileId: String
  var retentionDays: Int
  var maxItems: Int
  var maxItemBytes: Int64
  var quickOrbitPosition: String

  static let defaults = LumenClipboardSettings(
    captureEnabled: false,
    syncEnabled: false,
    syncTargetProfileId: "",
    retentionDays: 30,
    maxItems: 500,
    maxItemBytes: 8 * 1024 * 1024,
    quickOrbitPosition: "bottom"
  )

  private enum CodingKeys: String, CodingKey {
    case captureEnabled, syncEnabled, syncTargetProfileId, retentionDays, maxItems, maxItemBytes, quickOrbitPosition
  }

  init(captureEnabled: Bool, syncEnabled: Bool, syncTargetProfileId: String, retentionDays: Int, maxItems: Int, maxItemBytes: Int64, quickOrbitPosition: String) {
    self.captureEnabled = captureEnabled
    self.syncEnabled = syncEnabled
    self.syncTargetProfileId = syncTargetProfileId
    self.retentionDays = retentionDays
    self.maxItems = maxItems
    self.maxItemBytes = maxItemBytes
    self.quickOrbitPosition = quickOrbitPosition
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    captureEnabled = try c.decodeIfPresent(Bool.self, forKey: .captureEnabled) ?? false
    syncEnabled = try c.decodeIfPresent(Bool.self, forKey: .syncEnabled) ?? false
    syncTargetProfileId = try c.decodeIfPresent(String.self, forKey: .syncTargetProfileId) ?? ""
    retentionDays = try c.decodeIfPresent(Int.self, forKey: .retentionDays) ?? 30
    maxItems = try c.decodeIfPresent(Int.self, forKey: .maxItems) ?? 500
    maxItemBytes = try c.decodeIfPresent(Int64.self, forKey: .maxItemBytes) ?? (8 * 1024 * 1024)
    quickOrbitPosition = try c.decodeIfPresent(String.self, forKey: .quickOrbitPosition) ?? "bottom"
  }
}

struct LumenClipboardSettingsResponse: Decodable {
  let settings: LumenClipboardSettings
}

struct LumenCaptureStatus: Decodable {
  let enabled: Bool
  let supported: Bool
  let running: Bool
  let reason: String?
}

struct LumenSyncStatus: Decodable {
  let enabled: Bool
  let targetProfileId: String?
  let lastSyncAtMs: Int64?
  let lastError: String?
}

struct LumenTransportStatus: Decodable {
  let name: String
  let available: Bool
  let detail: String?
}

struct LumenClipboardStatus: Decodable {
  let platform: String
  let capture: LumenCaptureStatus
  let sync: LumenSyncStatus
  let deviceId: String
  let deviceName: String
  let keyFingerprint: String
  let transports: [LumenTransportStatus]
  let itemCount: Int
  let pinnedCount: Int
  let quickOrbitPosition: String

  private enum CodingKeys: String, CodingKey {
    case platform, capture, sync, deviceId, deviceName, keyFingerprint, transports, itemCount, pinnedCount, quickOrbitPosition
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    platform = try c.decodeIfPresent(String.self, forKey: .platform) ?? "darwin"
    capture = try c.decodeIfPresent(LumenCaptureStatus.self, forKey: .capture)
      ?? LumenCaptureStatus(enabled: false, supported: true, running: false, reason: nil)
    sync = try c.decodeIfPresent(LumenSyncStatus.self, forKey: .sync)
      ?? LumenSyncStatus(enabled: false, targetProfileId: nil, lastSyncAtMs: nil, lastError: nil)
    deviceId = try c.decodeIfPresent(String.self, forKey: .deviceId) ?? ""
    deviceName = try c.decodeIfPresent(String.self, forKey: .deviceName) ?? ""
    keyFingerprint = try c.decodeIfPresent(String.self, forKey: .keyFingerprint) ?? ""
    transports = try c.decodeIfPresent([LumenTransportStatus].self, forKey: .transports) ?? []
    itemCount = try c.decodeIfPresent(Int.self, forKey: .itemCount) ?? 0
    pinnedCount = try c.decodeIfPresent(Int.self, forKey: .pinnedCount) ?? 0
    quickOrbitPosition = try c.decodeIfPresent(String.self, forKey: .quickOrbitPosition) ?? "bottom"
  }
}

struct LumenServerProfile: Decodable, Equatable {
  let id: String
  let label: String
  let endpoint: String
  let active: Bool
}

struct LumenServerProfilesResponse: Decodable {
  let servers: [LumenServerProfile]
}

// MARK: - Server-Backed File & Office Structured Preview Models

struct LumenOfficeBlock: Decodable {
  let kind: String
  let text: String?
  let rows: [[String]]?
}

struct LumenDocumentPreview: Decodable {
  let title: String?
  let blocks: [LumenOfficeBlock]
}

struct LumenSheetPreview: Decodable {
  let name: String
  let rows: [[String]]
  let formulas: [String: String]?
}

struct LumenWorkbookPreview: Decodable {
  let sheets: [LumenSheetPreview]
}

struct LumenSlidePreview: Decodable {
  let number: Int
  let title: String?
  let lines: [String]
}

struct LumenPresentationPreview: Decodable {
  let slides: [LumenSlidePreview]
}

struct LumenOfficePreview: Decodable {
  let format: String
  let document: LumenDocumentPreview?
  let workbook: LumenWorkbookPreview?
  let presentation: LumenPresentationPreview?
}

struct LumenServerPreview: Decodable {
  let kind: String
  let mime: String?
  let text: String?
  let truncated: Bool?
  let index: Int
  let fileName: String?
  let fileSize: Int64?
  let office: LumenOfficePreview?
}

struct LumenServerPreviewResponse: Decodable {
  let preview: LumenServerPreview
}

// MARK: - Classification & Formatters

enum LumenClassifier {
  static let codeExtensions: Set<String> = [
    "swift", "go", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "php", "rs",
    "java", "kt", "c", "h", "cc", "cpp", "hpp", "cs", "rb", "sh", "zsh", "bash",
    "json", "jsonl", "yaml", "yml", "toml", "css", "scss", "sql", "xml", "html", "htm"
  ]

  static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "icns"]
  static let audioExtensions: Set<String> = ["mp3", "wav", "m4a", "aac", "ogg", "flac", "aiff", "aif"]
  static let videoExtensions: Set<String> = ["mp4", "m4v", "mov", "webm", "mkv"]
  static let officeExtensions: Set<String> = ["docx", "xlsx", "pptx"]
  static let textExtensions: Set<String> = ["txt", "md", "markdown", "log", "csv", "tsv", "ini", "conf", "env"]

  static func parseHexColor(_ raw: String) -> NSColor? {
    LumenColorMath.parseAnyColor(raw)
  }

  static func looksLikeCode(_ text: String) -> Bool {
    LumenContentIdentityRegistry.shared.detectHighConfidenceCodeLanguage(content: text) != nil
  }

  static func detectLanguage(fileName: String?, content: String) -> String {
    LumenContentIdentityRegistry.shared.resolveCodeLanguage(fileName: fileName, content: content)
  }

  static func languageDisplayName(_ lang: String) -> String {
    LumenContentIdentityRegistry.shared.languageDisplayName(lang)
  }
}

enum LumenFormatters {
  static func byteCount(_ bytes: Int64) -> String {
    if bytes < 1024 { return "\(bytes) B" }
    let kb = Double(bytes) / 1024.0
    if kb < 1024 { return String(format: "%.1f KB", kb) }
    let mb = kb / 1024.0
    if mb < 1024 { return String(format: "%.1f MB", mb) }
    return String(format: "%.2f GB", mb / 1024.0)
  }

  static func relativeTime(fromMs ms: Int64) -> String {
    guard ms > 0 else { return "刚刚" }
    let delta = Date().timeIntervalSince1970 - TimeInterval(ms) / 1000.0
    if delta < 45 { return "刚刚" }
    if delta < 3600 { return "\(max(1, Int(delta / 60))) 分钟前" }
    if delta < 86400 { return "\(max(1, Int(delta / 3600))) 小时前" }
    let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000.0)
    if Calendar.current.isDateInYesterday(date) { return "昨天" }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "zh_CN")
    formatter.dateFormat = "M/d HH:mm"
    return formatter.string(from: date)
  }

  static func mediaDuration(_ seconds: Double) -> String {
    guard seconds.isFinite && seconds >= 0 else { return "0:00" }
    let total = Int(seconds.rounded(.down))
    let mins = total / 60
    let secs = total % 60
    return String(format: "%d:%02d", mins, secs)
  }
}
