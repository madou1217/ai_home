import AppKit
import Foundation

/// One clipboard history row as returned by GET /v1/management/webui/clipboard/items.
/// The list endpoint never carries full text or blobs; text comes from the detail
/// route and binary content from /items/{id}/content.
struct ClipboardPanelRow {
  let id: String
  let kind: String
  let mime: String
  let preview: String
  let files: [String]
  let byteSize: Int64
  let width: Int
  let height: Int
  let createdAtMs: Int64
  let lastSeenAtMs: Int64
  let pinned: Bool
  let thumbnail: NSImage?

  init?(json: [String: Any]) {
    guard let id = json["id"] as? String, !id.isEmpty else { return nil }
    self.id = id
    kind = json["kind"] as? String ?? "text"
    mime = json["mime"] as? String ?? ""
    preview = json["preview"] as? String ?? ""
    files = (json["files"] as? [String]) ?? []
    byteSize = Self.int64(json["byteSize"])
    width = Int(Self.int64(json["width"]))
    height = Int(Self.int64(json["height"]))
    createdAtMs = Self.int64(json["createdAtMs"])
    lastSeenAtMs = Self.int64(json["lastSeenAtMs"])
    pinned = json["pinned"] as? Bool ?? false
    thumbnail = Self.decodeThumbnail(json["thumbnailDataUrl"] as? String)
  }

  private static func int64(_ value: Any?) -> Int64 {
    if let number = value as? NSNumber { return number.int64Value }
    if let text = value as? String, let parsed = Int64(text) { return parsed }
    return 0
  }

  private static func decodeThumbnail(_ raw: String?) -> NSImage? {
    guard let raw, let comma = raw.firstIndex(of: ",") else { return nil }
    let encoded = String(raw[raw.index(after: comma)...])
    guard let data = Data(base64Encoded: encoded) else { return nil }
    return NSImage(data: data)
  }

  /// Server ordering is last_seen_at_ms; created_at would show stale ages for re-copied items.
  var effectiveTimeMs: Int64 { lastSeenAtMs > 0 ? lastSeenAtMs : createdAtMs }

  var kindLabel: String {
    switch kind {
    case "image": return "图片"
    case "file": return "文件"
    case "link": return "链接"
    default: return "文本"
    }
  }

  /// Search matches preview, file paths, kind and id so keyboard filtering feels
  /// like the WebUI list without a server round trip per keystroke.
  func matches(_ query: String) -> Bool {
    guard !query.isEmpty else { return true }
    let needle = query.lowercased()
    if preview.lowercased().contains(needle) { return true }
    if id.lowercased().contains(needle) { return true }
    if kindLabel.contains(needle) { return true }
    return files.contains { $0.lowercased().contains(needle) }
  }
}

/// Detail payload from GET /items/{id}: list fields plus the truncated inline text.
struct ClipboardPanelDetail {
  let text: String
  let textTruncated: Bool

  init?(json: [String: Any]) {
    guard let item = json["item"] as? [String: Any] else { return nil }
    text = item["text"] as? String ?? ""
    textTruncated = item["textTruncated"] as? Bool ?? false
  }
}

enum ClipboardPanelFormat {
  static func time(_ milliseconds: Int64) -> String {
    guard milliseconds > 0 else { return "" }
    let date = Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1000)
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "zh_CN")
    if Calendar.current.isDateInToday(date) {
      formatter.dateFormat = "HH:mm"
    } else {
      formatter.dateFormat = "MM-dd HH:mm"
    }
    return formatter.string(from: date)
  }

  /// Compact relative time for the history rows; falls back to an absolute stamp
  /// beyond a week so old entries stay identifiable.
  static func relative(_ milliseconds: Int64) -> String? {
    guard milliseconds > 0 else { return nil }
    let date = Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1000)
    let elapsed = Date().timeIntervalSince(date)
    if elapsed < 60 { return "刚刚" }
    if elapsed < 3600 { return "\(Int(elapsed / 60)) 分钟前" }
    if elapsed < 86_400 { return "\(Int(elapsed / 3600)) 小时前" }
    if elapsed < 7 * 86_400 { return "\(Int(elapsed / 86_400)) 天前" }
    return time(milliseconds)
  }

  static func bytes(_ value: Int64) -> String {
    if value >= 1024 * 1024 {
      return String(format: "%.1f MiB", Double(value) / (1024 * 1024))
    }
    if value >= 1024 {
      return String(format: "%.1f KiB", Double(value) / 1024)
    }
    return "\(value) B"
  }
}