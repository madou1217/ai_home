import AppKit
import Foundation

/// Installed application entry returned by GET /v1/management/launcher/apps.
struct LauncherApp: Decodable {
  let id: String
  let name: String
  let subtitle: String
  let path: String
  let kind: String
  let icon: String
  let terminal: Bool
  let aliases: [String]
  let boost: Int

  private enum CodingKeys: String, CodingKey {
    case id, name, subtitle, path, kind, icon, terminal, aliases, boost
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    name = try container.decodeIfPresent(String.self, forKey: .name) ?? ""
    subtitle = try container.decodeIfPresent(String.self, forKey: .subtitle) ?? ""
    path = try container.decodeIfPresent(String.self, forKey: .path) ?? ""
    kind = try container.decodeIfPresent(String.self, forKey: .kind) ?? "app"
    icon = try container.decodeIfPresent(String.self, forKey: .icon) ?? ""
    terminal = try container.decodeIfPresent(Bool.self, forKey: .terminal) ?? false
    aliases = try container.decodeIfPresent([String].self, forKey: .aliases) ?? []
    boost = max(0, try container.decodeIfPresent(Int.self, forKey: .boost) ?? 0)
  }
}

/// Response payload for GET /v1/management/launcher/apps.
struct LauncherAppsResponse: Decodable {
  let platform: String
  let generatedAt: Int64
  let apps: [LauncherApp]
  let truncated: Bool

  private enum CodingKeys: String, CodingKey {
    case platform, generatedAt, apps, truncated
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    platform = try container.decodeIfPresent(String.self, forKey: .platform) ?? "darwin"
    generatedAt = try container.decodeIfPresent(Int64.self, forKey: .generatedAt) ?? 0
    apps = try container.decodeIfPresent([LauncherApp].self, forKey: .apps) ?? []
    truncated = try container.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
  }
}

/// Which field won the ranking evaluation; only `.name` matches highlight ranges in `app.name`.
enum LauncherMatchSource {
  case none
  case name
  case alias
  case subtitle
}

/// Filtered search result pairing an app with its ranking score and UTF-16 highlight ranges in `app.name`.
struct LauncherMatchResult {
  let app: LauncherApp
  let score: Int
  let matchSource: LauncherMatchSource
  let matchedRanges: [NSRange]
}

/// Local search and ranking implementation matching §6 + aliases.
/// Constants stay strictly synchronized with `application/launcher/rank.go`.
enum LauncherRanker {
  // 与 application/launcher/rank.go 同步
  static let scoreExactName = 1000
  static let scoreNamePrefixBase = 900
  static let scoreNamePrefixMaxPen = 50
  static let scoreWordPrefix = 800
  static let scoreAcronym = 750
  static let scoreSubstringBase = 700
  static let scoreSubstringMaxPen = 100
  static let scoreAlias = 650
  static let scoreSubsequenceBase = 600
  static let scoreSubseqMaxPen = 150
  static let scoreSubtitleOnly = 300

  static func normalizeQuery(_ raw: String) -> String {
    raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }

  /// Filters and sorts `apps` for instant zero-latency typing.
  /// When `query` is empty, preserves server order (which already applies `usage.json` recency).
  static func filter(_ apps: [LauncherApp], query rawQuery: String) -> [LauncherMatchResult] {
    let query = normalizeQuery(rawQuery)
    if query.isEmpty {
      return apps.map { LauncherMatchResult(app: $0, score: 0, matchSource: .none, matchedRanges: []) }
    }
    let queryChars = Array(query)
    var results: [(result: LauncherMatchResult, nameLower: String, serverIndex: Int)] = []
    results.reserveCapacity(apps.count)

    for (idx, app) in apps.enumerated() {
      let evaluation = evaluate(app: app, query: query, queryChars: queryChars)
      guard evaluation.score > 0 else { continue }
      results.append((
        result: LauncherMatchResult(
          app: app,
          score: evaluation.score + max(0, app.boost),
          matchSource: evaluation.source,
          matchedRanges: evaluation.ranges
        ),
        nameLower: normalizeQuery(app.name),
        serverIndex: idx
      ))
    }

    results.sort { lhs, rhs in
      if lhs.result.score != rhs.result.score {
        return lhs.result.score > rhs.result.score
      }
      if lhs.nameLower != rhs.nameLower {
        return lhs.nameLower < rhs.nameLower
      }
      if lhs.result.app.id != rhs.result.app.id {
        return lhs.result.app.id < rhs.result.app.id
      }
      return lhs.serverIndex < rhs.serverIndex
    }
    return results.map(\.result)
  }

  private struct IndexedChar {
    let lower: Character
    let nsRange: NSRange
  }

  private struct WordSpan {
    let start: Int
    let chars: [Character]
  }

  private static func evaluate(app: LauncherApp, query: String, queryChars: [Character]) -> (score: Int, source: LauncherMatchSource, ranges: [NSRange]) {
    let indexed = buildIndexedChars(app.name)
    let lowerChars = indexed.map(\.lower)
    var bestScore = 0
    var bestSource: LauncherMatchSource = .none
    var bestIndices: [Int] = []

    func consider(_ score: Int, _ indices: [Int]) {
      if score > bestScore {
        bestScore = score
        bestSource = .name
        bestIndices = indices
      }
    }

    if !lowerChars.isEmpty {
      // 1. Exact name match.
      if lowerChars == queryChars {
        consider(scoreExactName, Array(0..<lowerChars.count))
      }
      // 2. Name prefix match: 900 - min(nameLen - queryLen, 50).
      if hasPrefix(lowerChars, queryChars) {
        let pen = min(max(0, lowerChars.count - queryChars.count), scoreNamePrefixMaxPen)
        consider(scoreNamePrefixBase - pen, Array(0..<queryChars.count))
      }
      // 3 & 4. Word prefix (800) and acronym (750).
      let words = splitWords(lowerChars)
      if !words.isEmpty {
        for word in words {
          if hasPrefix(word.chars, queryChars) {
            consider(scoreWordPrefix, Array(word.start..<(word.start + queryChars.count)))
            break
          }
        }
        let initials = words.map { $0.chars[0] }
        if let acroPos = indexOf(initials, queryChars) {
          let indices = (acroPos..<(acroPos + queryChars.count)).map { words[$0].start }
          consider(scoreAcronym, indices)
        }
      }
      // 5. Name substring match: 700 - min(pos, 100).
      if let pos = indexOf(lowerChars, queryChars) {
        let pen = min(pos, scoreSubstringMaxPen)
        consider(scoreSubstringBase - pen, Array(pos..<(pos + queryChars.count)))
      }
      // 6. Name subsequence match: 600 - min(totalGaps, 150).
      if let subseq = subsequenceMatch(lowerChars, queryChars) {
        let pen = min(subseq.gaps, scoreSubseqMaxPen)
        consider(scoreSubsequenceBase - pen, subseq.indices)
      }
    }

    // 6b. Alias match (prefix/word-prefix/acronym/substring/subsequence): flat 650, max with name score.
    for alias in app.aliases {
      let aliasNorm = normalizeQuery(alias)
      guard !aliasNorm.isEmpty else { continue }
      if aliasMatches(Array(aliasNorm), queryChars) {
        if scoreAlias > bestScore {
          bestScore = scoreAlias
          bestSource = .alias
          bestIndices = []
        }
        break
      }
    }

    // 7. Subtitle-only match: 300.
    if bestScore == 0 {
      let subNorm = normalizeQuery(app.subtitle)
      if !subNorm.isEmpty && subNorm.contains(query) {
        return (scoreSubtitleOnly, .subtitle, [])
      }
    }

    guard bestSource == .name else {
      return (bestScore, bestSource, [])
    }
    let ranges = bestIndices.compactMap { idx -> NSRange? in
      guard idx >= 0, idx < indexed.count else { return nil }
      return indexed[idx].nsRange
    }
    return (bestScore, .name, ranges)
  }

  private static func buildIndexedChars(_ text: String) -> [IndexedChar] {
    var result: [IndexedChar] = []
    result.reserveCapacity(text.count)
    var index = text.startIndex
    while index < text.endIndex {
      let next = text.index(after: index)
      let ch = text[index]
      let lowered = String(ch).lowercased().first ?? ch
      let nsRange = NSRange(index..<next, in: text)
      result.append(IndexedChar(lower: lowered, nsRange: nsRange))
      index = next
    }
    return result
  }

  private static func isWordSeparator(_ ch: Character) -> Bool {
    ch.isWhitespace || ch == "-" || ch == "_" || ch == "/"
  }

  private static func splitWords(_ chars: [Character]) -> [WordSpan] {
    var words: [WordSpan] = []
    var start: Int?
    for (idx, ch) in chars.enumerated() {
      if isWordSeparator(ch) {
        if let s = start {
          words.append(WordSpan(start: s, chars: Array(chars[s..<idx])))
          start = nil
        }
      } else if start == nil {
        start = idx
      }
    }
    if let s = start {
      words.append(WordSpan(start: s, chars: Array(chars[s..<chars.count])))
    }
    return words
  }

  private static func hasPrefix(_ text: [Character], _ prefix: [Character]) -> Bool {
    guard !prefix.isEmpty, prefix.count <= text.count else { return false }
    for i in 0..<prefix.count where text[i] != prefix[i] {
      return false
    }
    return true
  }

  private static func indexOf(_ text: [Character], _ needle: [Character]) -> Int? {
    let nLen = needle.count
    guard nLen > 0, nLen <= text.count else { return nil }
    let limit = text.count - nLen
    for i in 0...limit {
      var matched = true
      for j in 0..<nLen where text[i + j] != needle[j] {
        matched = false
        break
      }
      if matched { return i }
    }
    return nil
  }

  private static func subsequenceMatch(_ text: [Character], _ query: [Character]) -> (gaps: Int, indices: [Int])? {
    guard !query.isEmpty, query.count <= text.count else { return nil }
    var qi = 0
    var prev = -1
    var gaps = 0
    var matched: [Int] = []
    matched.reserveCapacity(query.count)
    for (ti, ch) in text.enumerated() {
      if ch == query[qi] {
        if prev >= 0 {
          gaps += ti - prev - 1
        }
        prev = ti
        matched.append(ti)
        qi += 1
        if qi == query.count {
          return (gaps, matched)
        }
      }
    }
    return nil
  }

  private static func aliasMatches(_ aliasChars: [Character], _ queryChars: [Character]) -> Bool {
    guard !aliasChars.isEmpty, !queryChars.isEmpty else { return false }
    if hasPrefix(aliasChars, queryChars) || indexOf(aliasChars, queryChars) != nil {
      return true
    }
    let words = splitWords(aliasChars)
    if !words.isEmpty {
      for word in words where hasPrefix(word.chars, queryChars) {
        return true
      }
      let initials = words.map { $0.chars[0] }
      if indexOf(initials, queryChars) != nil {
        return true
      }
    }
    return subsequenceMatch(aliasChars, queryChars) != nil
  }
}

/// Asynchronous NSWorkspace file icon loader backed by a 64 MB NSCache.
final class LauncherIconCache {
  private let cache: NSCache<NSString, NSImage> = {
    let c = NSCache<NSString, NSImage>()
    c.totalCostLimit = 64 * 1024 * 1024
    return c
  }()
  private let queue = DispatchQueue(label: "com.meadeo.aih.launcher.icons", qos: .userInitiated)
  private let fallbackIcon: NSImage = {
    let image = NSImage(systemSymbolName: "app.fill", accessibilityDescription: nil)
      ?? NSImage(size: NSSize(width: 36, height: 36))
    image.size = NSSize(width: 36, height: 36)
    return image
  }()

  func cachedIcon(for path: String) -> NSImage? {
    guard !path.isEmpty else { return fallbackIcon }
    return cache.object(forKey: path as NSString)
  }

  func loadIcon(for path: String, completion: @escaping (NSImage) -> Void) {
    guard !path.isEmpty else {
      completion(fallbackIcon)
      return
    }
    if let existing = cache.object(forKey: path as NSString) {
      completion(existing)
      return
    }
    queue.async { [weak self] in
      guard let self else { return }
      let loaded = NSWorkspace.shared.icon(forFile: path)
      loaded.size = NSSize(width: 36, height: 36)
      // Approximate 2x RGBA bitmap footprint for 36x36pt icon (~20 KiB).
      self.cache.setObject(loaded, forKey: path as NSString, cost: 72 * 72 * 4)
      DispatchQueue.main.async {
        completion(loaded)
      }
    }
  }

  func clear() {
    cache.removeAllObjects()
  }
}

/// Lightweight HTTP client talking to local `/v1/management/launcher/*` with 5s timeout.
final class LauncherClient {
  enum ClientError: LocalizedError {
    case unconfigured
    case httpStatus(Int, String)
    case invalidPayload

    var errorDescription: String? {
      switch self {
      case .unconfigured:
        return "本机 Server 未连接"
      case .httpStatus(let code, let message):
        return message.isEmpty ? "HTTP \(code)" : message
      case .invalidPayload:
        return "返回数据格式无效"
      }
    }
  }

  private(set) var origin = ""
  private(set) var managementKey = ""

  func configure(origin nextOrigin: String, managementKey nextKey: String) -> Bool {
    let normalized = nextOrigin
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let changed = normalized != origin || nextKey != managementKey
    origin = normalized
    managementKey = nextKey
    return changed
  }

  var isConfigured: Bool {
    !origin.isEmpty && !managementKey.isEmpty
  }

  func fetchApps(refresh: Bool = false, completion: @escaping (Result<LauncherAppsResponse, Error>) -> Void) {
    let suffix = refresh ? "/v1/management/launcher/apps?refresh=1" : "/v1/management/launcher/apps"
    guard isConfigured, let url = URL(string: origin + suffix) else {
      DispatchQueue.main.async { completion(.failure(ClientError.unconfigured)) }
      return
    }
    var req = URLRequest(url: url)
    req.httpMethod = "GET"
    req.timeoutInterval = 5
    req.setValue("Bearer \(managementKey)", forHTTPHeaderField: "Authorization")
    req.setValue("application/json", forHTTPHeaderField: "Accept")

    URLSession.shared.dataTask(with: req) { data, response, error in
      if let error {
        DispatchQueue.main.async { completion(.failure(error)) }
        return
      }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      guard status == 200, let data else {
        let message = Self.parseErrorMessage(data)
        DispatchQueue.main.async { completion(.failure(ClientError.httpStatus(status, message))) }
        return
      }
      do {
        let decoded = try JSONDecoder().decode(LauncherAppsResponse.self, from: data)
        DispatchQueue.main.async { completion(.success(decoded)) }
      } catch {
        DispatchQueue.main.async { completion(.failure(ClientError.invalidPayload)) }
      }
    }.resume()
  }

  func openApp(id: String, completion: @escaping (Result<Void, Error>) -> Void) {
    guard isConfigured, let url = URL(string: origin + "/v1/management/launcher/open") else {
      DispatchQueue.main.async { completion(.failure(ClientError.unconfigured)) }
      return
    }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.timeoutInterval = 5
    req.setValue("Bearer \(managementKey)", forHTTPHeaderField: "Authorization")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    req.httpBody = try? JSONSerialization.data(withJSONObject: ["id": id])

    URLSession.shared.dataTask(with: req) { data, response, error in
      if let error {
        DispatchQueue.main.async { completion(.failure(error)) }
        return
      }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      if status == 200 {
        DispatchQueue.main.async { completion(.success(())) }
      } else {
        let message = Self.parseErrorMessage(data)
        DispatchQueue.main.async { completion(.failure(ClientError.httpStatus(status, message))) }
      }
    }.resume()
  }

  private static func parseErrorMessage(_ data: Data?) -> String {
    guard let data,
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return ""
    }
    if let message = obj["message"] as? String, !message.isEmpty {
      return message
    }
    if let err = obj["error"] as? String {
      return err
    }
    return ""
  }
}
