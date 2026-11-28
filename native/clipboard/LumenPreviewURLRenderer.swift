import AppKit
import Foundation
import QuartzCore
import WebKit

// MARK: - URL Security Policy & Private Network Isolation (§7.0, §14.3, Q12, A28, A77)

enum LumenURLBlockReason: Equatable {
  case missingOrInvalidURL
  case unsupportedProtocol(String)
  case privateOrLocalTarget(host: String, detail: String)

  var title: String {
    switch self {
    case .missingOrInvalidURL:
      return "链接格式无效"
    case .unsupportedProtocol(let scheme):
      return "已阻止不安全协议 (\(scheme):)"
    case .privateOrLocalTarget:
      return "已阻止本机或私网目标"
    }
  }

  func explanation(redirectedFrom origin: URL?) -> String {
    let redirectSuffix: String
    if let origin {
      let originHost = origin.host ?? origin.absoluteString
      redirectSuffix = "（由 \(originHost) 重定向至此目标）"
    } else {
      redirectSuffix = ""
    }
    switch self {
    case .missingOrInvalidURL:
      return "该条目不是有效的 http/https 网址，已拒绝发起网络请求。"
    case .unsupportedProtocol(let scheme):
      return "隔离网页预览仅允许 http 与 https 协议，已拒绝 \(scheme): 协议以防止本地文件访问或脚本注入\(redirectSuffix)。"
    case .privateOrLocalTarget(let host, let detail):
      return "目标主机 \(host) 属于\(detail)\(redirectSuffix)。为避免剪贴板历史触发本地服务或内网探测，默认拒绝在隔离预览中加载。"
    }
  }
}

enum LumenURLPolicyVerdict: Equatable {
  case allowed(URL)
  case blocked(LumenURLBlockReason)
}

enum LumenURLFailureReason: Equatable {
  case offline
  case timeout
  case httpError(Int)
  case tlsError(String)
  case unreachable(String)
  case downloadBlocked(String)
  case processTerminated
  case generic(String)

  var title: String {
    switch self {
    case .offline:
      return "网络未连接"
    case .timeout:
      return "网页加载超时"
    case .httpError(let code):
      return "网页返回 HTTP \(code)"
    case .tlsError:
      return "安全连接验证失败"
    case .unreachable:
      return "无法连接到目标主机"
    case .downloadBlocked:
      return "已阻止文件下载响应"
    case .processTerminated:
      return "隔离渲染进程已中止"
    case .generic:
      return "网页加载失败"
    }
  }

  var detail: String {
    switch self {
    case .offline:
      return "当前处于离线状态或网络连接已断开，请检查网络后重试，或使用外部浏览器打开。"
    case .timeout:
      return "远端服务器在规定时间内未响应，可点击重试或改用外部浏览器打开。"
    case .httpError(let code):
      let desc = HTTPURLResponse.localizedString(forStatusCode: code)
      return "远端站点返回错误状态码 \(code)（\(desc)），未展示不完整页面。可重试或使用外部浏览器查看。"
    case .tlsError(let msg):
      return "无法建立受信任的加密连接：\(msg)"
    case .unreachable(let msg):
      return "无法解析或连接至目标服务器：\(msg)"
    case .downloadBlocked(let info):
      return "该地址返回了下载类响应（\(info)）。隔离预览禁止向磁盘写入任何文件，如需下载请改用外部浏览器打开。"
    case .processTerminated:
      return "隔离 WebView 渲染进程意外退出，临时会话已清理。可点击重试重新建立隔离进程。"
    case .generic(let msg):
      return msg.isEmpty ? "加载过程中发生未知错误，请重试或改用外部浏览器打开。" : msg
    }
  }
}

/// Pure, deterministic URL validator enforcing V15 §7.0 & §14.3 network boundaries:
/// - Only `http` / `https` schemes are permitted (`file:`, `javascript:`, `data:`, `blob:`, `about:`, etc. are rejected).
/// - Loopback, localhost, `.local`, link-local, RFC 1918 private, CGNAT, multicast, IPv6 ULA/link-local,
///   IPv4-mapped IPv6, and obfuscated integer/octal/hex IPv4 literals are rejected by default.
enum LumenURLSecurityPolicy {
  private static let blockedExactHosts: Set<String> = [
    "localhost",
    "ip6-localhost",
    "ip6-loopback",
    "localhost.localdomain",
    "broadcasthost",
    "metadata.google.internal",
    "metadata",
    "instance-data"
  ]

  private static let blockedHostSuffixes: [String] = [
    ".localhost",
    ".local",
    ".localdomain",
    ".internal",
    ".home.arpa"
  ]

  private enum IPv4ParseResult {
    case notIPv4
    case valid(UInt32)
    case malformedNumeric
  }

  static func evaluate(rawString: String) -> LumenURLPolicyVerdict {
    let trimmed = rawString.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return .blocked(.missingOrInvalidURL)
    }
    if trimmed.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) {
      return .blocked(.missingOrInvalidURL)
    }

    if let rawScheme = extractLeadingScheme(from: trimmed) {
      let lowerScheme = rawScheme.lowercased()
      if lowerScheme != "http" && lowerScheme != "https" {
        return .blocked(.unsupportedProtocol(lowerScheme))
      }
    }

    // Reject backslashes inside the authority component to prevent WHATWG vs RFC 3986 host parser differentials.
    if let schemeRange = trimmed.range(of: "://") {
      let afterScheme = trimmed[schemeRange.upperBound...]
      let authorityEnd = afterScheme.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) ?? afterScheme.endIndex
      if afterScheme[..<authorityEnd].contains("\\") {
        return .blocked(.missingOrInvalidURL)
      }
    }

    guard let url = parseNormalizedURL(from: trimmed) else {
      return .blocked(.missingOrInvalidURL)
    }
    return evaluate(url: url)
  }

  static func evaluate(url: URL) -> LumenURLPolicyVerdict {
    guard let rawScheme = url.scheme?.trimmingCharacters(in: .whitespacesAndNewlines),
          !rawScheme.isEmpty else {
      return .blocked(.missingOrInvalidURL)
    }
    let scheme = rawScheme.lowercased()
    guard scheme == "http" || scheme == "https" else {
      return .blocked(.unsupportedProtocol(scheme))
    }

    let components = URLComponents(url: url, resolvingAgainstBaseURL: true)
    let hosts = Set([url.host, components?.host].compactMap { $0 })
    guard !hosts.isEmpty else {
      return .blocked(.missingOrInvalidURL)
    }

    for candidate in hosts {
      if let reason = evaluateHost(candidate) {
        return .blocked(reason)
      }
    }
    return .allowed(url)
  }

  /// Extracts a safe `http`/`https` URL eligible for opening in the user's external browser.
  /// Dangerous schemes (`file:`, `javascript:`, `data:`, etc.) always return `nil`.
  static func externalOpenURL(from rawString: String) -> URL? {
    let trimmed = rawString.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty,
          let scheme = extractLeadingScheme(from: trimmed)?.lowercased(),
          (scheme == "http" || scheme == "https"),
          let url = parseNormalizedURL(from: trimmed),
          let host = url.host,
          !host.isEmpty else {
      return nil
    }
    return url
  }

  static func displayDomain(for rawString: String) -> String {
    let trimmed = rawString.trimmingCharacters(in: .whitespacesAndNewlines)
    if let url = parseNormalizedURL(from: trimmed), let host = url.host, !host.isEmpty {
      if let port = url.port {
        return "\(host):\(port)"
      }
      return host
    }
    if let scheme = extractLeadingScheme(from: trimmed)?.lowercased() {
      return "\(scheme):"
    }
    return "未知域名"
  }

  // MARK: - Internal Validation Helpers

  private static func parseNormalizedURL(from trimmed: String) -> URL? {
    if let direct = URL(string: trimmed) {
      return direct
    }
    // On macOS 12–13 Foundation, unencoded non-ASCII characters in path/query cause URL(string:) to return nil.
    // Encode only non-ASCII scalars after the authority without altering ASCII syntax or existing percent escapes.
    guard let schemeRange = trimmed.range(of: "://") else { return nil }
    let afterScheme = schemeRange.upperBound
    let splitIndex = trimmed[afterScheme...].firstIndex(of: "/")
      ?? trimmed[afterScheme...].firstIndex(of: "?")
      ?? trimmed[afterScheme...].firstIndex(of: "#")
      ?? trimmed.endIndex
    let prefix = String(trimmed[..<splitIndex])
    let suffix = percentEncodeNonASCII(String(trimmed[splitIndex...]))
    return URL(string: prefix + suffix)
  }

  private static func percentEncodeNonASCII(_ raw: String) -> String {
    var out = ""
    out.reserveCapacity(raw.utf8.count)
    for scalar in raw.unicodeScalars {
      if scalar.value < 0x80 {
        out.unicodeScalars.append(scalar)
      } else {
        for byte in String(scalar).utf8 {
          out += String(format: "%%%02X", byte)
        }
      }
    }
    return out
  }

  private static func extractLeadingScheme(from text: String) -> String? {
    guard let colonIdx = text.firstIndex(of: ":"), colonIdx > text.startIndex else {
      return nil
    }
    let prefix = text[..<colonIdx]
    guard let first = prefix.unicodeScalars.first, isASCIIAlpha(first) else {
      return nil
    }
    for scalar in prefix.unicodeScalars {
      let valid = isASCIIAlpha(scalar)
        || isASCIIDigit(scalar)
        || scalar == "+" || scalar == "-" || scalar == "."
      if !valid { return nil }
    }
    return String(prefix)
  }

  private static func evaluateHost(_ rawHost: String) -> LumenURLBlockReason? {
    var host = rawHost.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if host.hasPrefix("[") && host.hasSuffix("]") && host.count >= 2 {
      host = String(host.dropFirst().dropLast())
    }
    while host.hasSuffix(".") {
      host.removeLast()
    }
    guard !host.isEmpty else {
      return .missingOrInvalidURL
    }

    if host.contains(where: { $0.isWhitespace || $0 == "/" || $0 == "\\" || $0 == "@" }) {
      return .missingOrInvalidURL
    }

    // 1. Explicit local/metadata hostname checks
    if blockedExactHosts.contains(host) {
      return .privateOrLocalTarget(host: host, detail: "本机或保留主机名")
    }
    for suffix in blockedHostSuffixes where host.hasSuffix(suffix) {
      return .privateOrLocalTarget(host: host, detail: "局域网或本机域名（*\(suffix)）")
    }

    // 2. IPv6 literals (including zone IDs & IPv4-mapped IPv6)
    if host.contains(":") {
      guard let bytes = parseIPv6(host) else {
        return .missingOrInvalidURL
      }
      if let detail = classifyBlockedIPv6(bytes) {
        return .privateOrLocalTarget(host: host, detail: detail)
      }
      return nil
    }

    // 3. IPv4 literals (including shorthand, decimal uint32, octal, and hex obfuscation)
    switch parseIPv4(host) {
    case .valid(let addr):
      if let detail = classifyBlockedIPv4(addr) {
        return .privateOrLocalTarget(host: host, detail: detail)
      }
      return nil
    case .malformedNumeric:
      return .privateOrLocalTarget(host: host, detail: "无效或混淆的数字 IP 主机")
    case .notIPv4:
      break
    }

    // 4. Single-label hostnames (e.g. intranet / container / mDNS names without a public TLD dot)
    if !host.contains(".") {
      return .privateOrLocalTarget(host: host, detail: "单标签内网/本机主机名")
    }

    return nil
  }

  private static func parseIPv4(_ host: String) -> IPv4ParseResult {
    let parts = host.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    guard !parts.isEmpty else { return .notIPv4 }
    guard let last = parts.last, looksLikeNumericIPv4Label(last) else {
      return .notIPv4
    }
    guard parts.count <= 4 else {
      return .malformedNumeric
    }

    var values: [UInt64] = []
    values.reserveCapacity(parts.count)
    for part in parts {
      guard let val = parseIPv4Number(part) else {
        return .malformedNumeric
      }
      values.append(val)
    }

    let n = values.count
    for idx in 0..<(n - 1) where values[idx] > 255 {
      return .malformedNumeric
    }
    let maxLast = (UInt64(1) << UInt64((5 - n) * 8)) - 1
    guard values[n - 1] <= maxLast else {
      return .malformedNumeric
    }

    var addr: UInt32 = 0
    for idx in 0..<(n - 1) {
      addr |= UInt32(values[idx]) << UInt32((3 - idx) * 8)
    }
    addr |= UInt32(values[n - 1])
    return .valid(addr)
  }

  private static func looksLikeNumericIPv4Label(_ label: String) -> Bool {
    guard !label.isEmpty else { return false }
    if label.hasPrefix("0x") || label.hasPrefix("0X") {
      let rest = label.dropFirst(2)
      return !rest.isEmpty && rest.unicodeScalars.allSatisfy(isASCIIHexDigit)
    }
    return label.unicodeScalars.allSatisfy(isASCIIDigit)
  }

  private static func parseIPv4Number(_ label: String) -> UInt64? {
    guard !label.isEmpty else { return nil }
    if label.hasPrefix("0x") || label.hasPrefix("0X") {
      let rest = String(label.dropFirst(2))
      guard !rest.isEmpty, rest.unicodeScalars.allSatisfy(isASCIIHexDigit) else { return nil }
      return UInt64(rest, radix: 16)
    }
    if label.count > 1 && label.hasPrefix("0") {
      guard label.unicodeScalars.allSatisfy({ $0.value >= 0x30 && $0.value <= 0x37 }) else {
        return nil
      }
      return UInt64(label, radix: 8)
    }
    guard label.unicodeScalars.allSatisfy(isASCIIDigit) else { return nil }
    return UInt64(label, radix: 10)
  }

  private static func parseStrictDottedQuadIPv4(_ raw: String) -> UInt32? {
    let parts = raw.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 4 else { return nil }
    var addr: UInt32 = 0
    for (idx, part) in parts.enumerated() {
      guard !part.isEmpty,
            part.count <= 3,
            part.unicodeScalars.allSatisfy(isASCIIDigit),
            let val = UInt32(part),
            val <= 255 else {
        return nil
      }
      if part.count > 1 && part.hasPrefix("0") {
        return nil
      }
      addr |= val << UInt32((3 - idx) * 8)
    }
    return addr
  }

  private static func classifyBlockedIPv4(_ addr: UInt32) -> String? {
    let o0 = (addr >> 24) & 0xFF
    let o1 = (addr >> 16) & 0xFF
    let o2 = (addr >> 8) & 0xFF

    if o0 == 0 {
      return "未指定/本机网络地址 (0.0.0.0/8)"
    }
    if o0 == 10 {
      return "私网地址 (10.0.0.0/8)"
    }
    if o0 == 100 && (o1 & 0xC0) == 64 {
      return "运营商级共享私网地址 (100.64.0.0/10)"
    }
    if o0 == 127 {
      return "本机回环地址 (127.0.0.0/8)"
    }
    if o0 == 169 && o1 == 254 {
      return "链路本地 / 云元数据地址 (169.254.0.0/16)"
    }
    if o0 == 172 && (o1 & 0xF0) == 16 {
      return "私网地址 (172.16.0.0/12)"
    }
    if o0 == 192 && o1 == 0 && o2 == 0 {
      return "保留网络地址 (192.0.0.0/24)"
    }
    if o0 == 192 && o1 == 168 {
      return "私网地址 (192.168.0.0/16)"
    }
    if o0 == 198 && (o1 == 18 || o1 == 19) {
      return "基准测试保留网段 (198.18.0.0/15)"
    }
    if o0 >= 224 && o0 <= 239 {
      return "组播地址 (224.0.0.0/4)"
    }
    if o0 >= 240 {
      return "保留或广播地址 (240.0.0.0/4)"
    }
    return nil
  }

  private static func parseIPv6(_ raw: String) -> [UInt8]? {
    var clean = raw
    if let zoneIndex = clean.firstIndex(of: "%") {
      clean = String(clean[..<zoneIndex])
    }
    guard !clean.isEmpty, clean.contains(":") else { return nil }

    let compressedParts = clean.components(separatedBy: "::")
    guard compressedParts.count <= 2 else { return nil }

    let hextets: [UInt16]
    if compressedParts.count == 1 {
      guard let parsed = parseIPv6Hextets(compressedParts[0], allowTrailingIPv4: true),
            parsed.count == 8 else {
        return nil
      }
      hextets = parsed
    } else {
      guard let left = parseIPv6Hextets(compressedParts[0], allowTrailingIPv4: false),
            let right = parseIPv6Hextets(compressedParts[1], allowTrailingIPv4: true),
            left.count + right.count < 8 else {
        return nil
      }
      let zeroCount = 8 - left.count - right.count
      hextets = left + Array(repeating: 0, count: zeroCount) + right
    }

    var bytes: [UInt8] = []
    bytes.reserveCapacity(16)
    for word in hextets {
      bytes.append(UInt8((word >> 8) & 0xFF))
      bytes.append(UInt8(word & 0xFF))
    }
    return bytes
  }

  private static func parseIPv6Hextets(_ side: String, allowTrailingIPv4: Bool) -> [UInt16]? {
    if side.isEmpty { return [] }
    let tokens = side.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
    var out: [UInt16] = []
    for (idx, token) in tokens.enumerated() {
      guard !token.isEmpty else { return nil }
      if allowTrailingIPv4 && idx == tokens.count - 1 && token.contains(".") {
        guard let ipv4 = parseStrictDottedQuadIPv4(token) else { return nil }
        out.append(UInt16((ipv4 >> 16) & 0xFFFF))
        out.append(UInt16(ipv4 & 0xFFFF))
      } else {
        guard token.count <= 4,
              token.unicodeScalars.allSatisfy(isASCIIHexDigit),
              let val = UInt16(token, radix: 16) else {
          return nil
        }
        out.append(val)
      }
    }
    return out
  }

  private static func classifyBlockedIPv6(_ bytes: [UInt8]) -> String? {
    guard bytes.count == 16 else { return "无效 IPv6 地址" }

    let first12Zero = bytes[0..<12].allSatisfy { $0 == 0 }
    let first10Zero = bytes[0..<10].allSatisfy { $0 == 0 }

    // :: (unspecified) and ::1 (loopback)
    if first12Zero && bytes[12] == 0 && bytes[13] == 0 && bytes[14] == 0 {
      if bytes[15] == 0 { return "IPv6 未指定地址 (::)" }
      if bytes[15] == 1 { return "IPv6 本机回环地址 (::1)" }
    }

    // ::ffff:0:0/96 (IPv4-mapped IPv6)
    if first10Zero && bytes[10] == 0xFF && bytes[11] == 0xFF {
      let v4 = packIPv4(bytes[12], bytes[13], bytes[14], bytes[15])
      if let detail = classifyBlockedIPv4(v4) {
        return "IPv4 映射 IPv6 \(detail)"
      }
      return nil
    }

    // ::a.b.c.d (deprecated IPv4-compatible IPv6)
    if first12Zero {
      let v4 = packIPv4(bytes[12], bytes[13], bytes[14], bytes[15])
      if let detail = classifyBlockedIPv4(v4) {
        return "IPv4 兼容 IPv6 \(detail)"
      }
    }

    // 64:ff9b::/96 (NAT64 well-known prefix embedding IPv4)
    if bytes[0] == 0x00 && bytes[1] == 0x64 && bytes[2] == 0xFF && bytes[3] == 0x9B
      && bytes[4..<12].allSatisfy({ $0 == 0 }) {
      let v4 = packIPv4(bytes[12], bytes[13], bytes[14], bytes[15])
      if let detail = classifyBlockedIPv4(v4) {
        return "NAT64 映射 \(detail)"
      }
    }

    // 2002::/16 (6to4 embedding IPv4 in bytes 2..5)
    if bytes[0] == 0x20 && bytes[1] == 0x02 {
      let v4 = packIPv4(bytes[2], bytes[3], bytes[4], bytes[5])
      if let detail = classifyBlockedIPv4(v4) {
        return "6to4 映射 \(detail)"
      }
    }

    // fc00::/7 (Unique Local Address)
    if (bytes[0] & 0xFE) == 0xFC {
      return "IPv6 唯一本地地址 (fc00::/7)"
    }
    // fe80::/10 (Link-local)
    if bytes[0] == 0xFE && (bytes[1] & 0xC0) == 0x80 {
      return "IPv6 链路本地地址 (fe80::/10)"
    }
    // fec0::/10 (Deprecated site-local)
    if bytes[0] == 0xFE && (bytes[1] & 0xC0) == 0xC0 {
      return "IPv6 站点本地地址 (fec0::/10)"
    }
    // ff00::/8 (Multicast)
    if bytes[0] == 0xFF {
      return "IPv6 组播地址 (ff00::/8)"
    }
    return nil
  }

  private static func packIPv4(_ b0: UInt8, _ b1: UInt8, _ b2: UInt8, _ b3: UInt8) -> UInt32 {
    (UInt32(b0) << 24) | (UInt32(b1) << 16) | (UInt32(b2) << 8) | UInt32(b3)
  }

  private static func isASCIIAlpha(_ scalar: UnicodeScalar) -> Bool {
    (scalar.value >= 0x41 && scalar.value <= 0x5A) || (scalar.value >= 0x61 && scalar.value <= 0x7A)
  }

  private static func isASCIIDigit(_ scalar: UnicodeScalar) -> Bool {
    scalar.value >= 0x30 && scalar.value <= 0x39
  }

  private static func isASCIIHexDigit(_ scalar: UnicodeScalar) -> Bool {
    isASCIIDigit(scalar)
      || (scalar.value >= 0x41 && scalar.value <= 0x46)
      || (scalar.value >= 0x61 && scalar.value <= 0x66)
  }
}

// MARK: - Ephemeral In-Memory Session Title Cache (Never Persisted, Never Auto-Fetched)

/// Stores real page titles ONLY after the user explicitly loads a webpage during the current session.
/// Bounded to 64 entries and kept strictly in memory.
private final class LumenURLSessionTitleCache {
  static let shared = LumenURLSessionTitleCache()
  private var titles: [String: String] = [:]
  private var order: [String] = []
  private let limit = 64

  private init() {}

  func title(for rawURL: String) -> String? {
    let key = rawURL.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !key.isEmpty else { return nil }
    return titles[key]
  }

  func store(_ title: String, for rawURL: String) {
    let key = rawURL.trimmingCharacters(in: .whitespacesAndNewlines)
    let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !key.isEmpty, !cleanTitle.isEmpty else { return }
    if titles[key] == nil {
      order.append(key)
    }
    titles[key] = cleanTitle
    while order.count > limit {
      let oldest = order.removeFirst()
      titles.removeValue(forKey: oldest)
    }
  }
}

// MARK: - Reduce-Motion-Safe Thin Progress Bar

private final class LumenURLProgressBarView: NSView {
  private let fillLayer = CALayer()
  private var progressValue: CGFloat = 0

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.masksToBounds = true
    fillLayer.anchorPoint = CGPoint(x: 0, y: 0)
    layer?.addSublayer(fillLayer)
    setAccessibilityElement(true)
    setAccessibilityRole(.progressIndicator)
    setAccessibilityLabel("网页加载进度")
  }

  required init?(coder: NSCoder) { nil }

  func applyColor(_ color: NSColor) {
    fillLayer.backgroundColor = color.cgColor
  }

  func setProgress(_ fraction: Double) {
    let clamped = CGFloat(max(0.0, min(1.0, fraction)))
    progressValue = clamped
    setAccessibilityValue("\(Int((clamped * 100).rounded()))%")
    updateFillFrame()
  }

  override func layout() {
    super.layout()
    updateFillFrame()
  }

  private func updateFillFrame() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    fillLayer.frame = CGRect(x: 0, y: 0, width: bounds.width * progressValue, height: bounds.height)
    CATransaction.commit()
  }
}

// MARK: - Isolated URL Preview Renderer (Q12, A28, A36, A77)

/// Dedicated Quick Look renderer for `.link` clipboard items.
/// Uses an isolated, non-persistent, JavaScript-disabled `WKWebView` that NEVER loads automatically.
struct LumenURLRenderer: LumenPreviewRenderer {
  let rendererID = "native.webkit.url.isolated"
  let priority = 80 // Higher than LumenTextRenderer (70)

  func canRender(_ item: LumenPreviewItem) -> Bool {
    item.identity.family == .link && item.kind == .link
  }

  func makeView(for item: LumenPreviewItem, context: LumenPreviewContext) -> LumenPreviewRendererView {
    LumenURLRendererView(palette: context.palette)
  }
}

final class LumenURLRendererView: LumenPreviewRendererView, WKNavigationDelegate, WKUIDelegate {
  private enum ViewState {
    case idle(url: URL, cachedTitle: String?)
    case loading(url: URL)
    case loaded(url: URL, title: String?)
    case blocked(reason: LumenURLBlockReason, rawURL: String, redirectedFrom: URL?)
    case failed(reason: LumenURLFailureReason, url: URL)
  }

  private var palette: LumenPalette
  private var state: ViewState = .blocked(reason: .missingOrInvalidURL, rawURL: "", redirectedFrom: nil)
  private var rawURLString = ""
  private var initialAllowedURL: URL?
  private var activeURL: URL?
  private var loadGeneration = 0
  private var intentionalPolicyCancel = false

  // Address bar & chrome
  private let addressBar = NSView()
  private let addressDivider = NSView()
  private let statusPill = NSView()
  private let statusDot = NSView()
  private let statusLabel = NSTextField(labelWithString: "未加载")
  private let addressField = NSTextField(labelWithString: "")
  private let stopBtn = NSButton()
  private let reloadBtn = NSButton()
  private let copyURLBtn = NSButton()
  private let openExternalBtn = NSButton()
  private let progressBar = LumenURLProgressBarView()

  // Main stage
  private let stageHost = NSView()
  private let webContainer = NSView()
  private var webView: WKWebView?
  private var progressObservation: NSKeyValueObservation?

  // Structured state card (Idle / Loading / Blocked / Failed — compact clean card, zero Alert box, zero border-left bar)
  private let stateOverlay = NSView()
  private let stateCard = NSView()
  private let cardIdentityGlyph = LumenIdentityGlyphView(size: 36)
  private let cardStatusBadge = NSView()
  private let cardStatusIcon = NSImageView()
  private let loadingSpinner = NSProgressIndicator()
  private let cardTitleLabel = NSTextField(wrappingLabelWithString: "")
  private let cachedTitlePill = NSView()
  private let cachedTitleTag = NSTextField(labelWithString: "已缓存标题")
  private let domainLabel = NSTextField(labelWithString: "")
  private let urlBox = NSView()
  private let urlDisplayField = NSTextField(wrappingLabelWithString: "")
  private let cardDetailLabel = NSTextField(wrappingLabelWithString: "")
  private let loadWebBtn = NSButton()
  private let retryBtn = NSButton()
  private let cancelLoadBtn = NSButton()
  private let cardOpenExternalBtn = NSButton()
  private let cardCopyBtn = NSButton()

  init(palette: LumenPalette) {
    self.palette = palette
    super.init(frame: .zero)
    wantsLayer = true
    buildUI()
    applyTheme(palette)
  }

  required init?(coder: NSCoder) { nil }

  deinit {
    progressObservation?.invalidate()
    progressObservation = nil
    if let wv = webView {
      wv.stopLoading()
      wv.navigationDelegate = nil
      wv.uiDelegate = nil
      wv.removeFromSuperview()
      webView = nil
    }
  }

  // MARK: - UI Construction

  private func buildUI() {
    // 1. Address bar
    addressBar.wantsLayer = true
    addressBar.translatesAutoresizingMaskIntoConstraints = false
    addressDivider.wantsLayer = true
    addressDivider.translatesAutoresizingMaskIntoConstraints = false

    statusPill.wantsLayer = true
    statusPill.layer?.cornerRadius = 10
    statusPill.layer?.cornerCurve = .continuous
    statusPill.layer?.borderWidth = 1
    statusPill.translatesAutoresizingMaskIntoConstraints = false

    statusDot.wantsLayer = true
    statusDot.layer?.cornerRadius = 3
    statusDot.translatesAutoresizingMaskIntoConstraints = false

    statusLabel.font = .systemFont(ofSize: 11, weight: .semibold)
    statusLabel.translatesAutoresizingMaskIntoConstraints = false
    statusLabel.setContentHuggingPriority(.required, for: .horizontal)
    statusLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
    statusLabel.setAccessibilityElement(true)
    statusLabel.setAccessibilityRole(.staticText)
    statusLabel.setAccessibilityLabel("网页预览状态")

    statusPill.addSubview(statusDot)
    statusPill.addSubview(statusLabel)

    addressField.font = .monospacedSystemFont(ofSize: 11.5, weight: .regular)
    addressField.isEditable = false
    addressField.isSelectable = true
    addressField.lineBreakMode = .byTruncatingMiddle
    addressField.maximumNumberOfLines = 1
    addressField.translatesAutoresizingMaskIntoConstraints = false
    addressField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    addressField.setContentHuggingPriority(.defaultLow, for: .horizontal)
    addressField.setAccessibilityElement(true)
    addressField.setAccessibilityRole(.textField)
    addressField.setAccessibilityLabel("当前网址")

    configureToolbarButton(stopBtn, title: "停止", accessibility: "停止加载网页", action: #selector(stopLoadClicked))
    configureToolbarButton(reloadBtn, title: "重新加载", accessibility: "重新加载网页", action: #selector(reloadClicked))
    configureToolbarButton(copyURLBtn, title: "复制链接", accessibility: "复制完整网页链接", action: #selector(copyURLClicked))
    configureToolbarButton(openExternalBtn, title: "外部打开", accessibility: "在外部默认浏览器打开链接", action: #selector(openExternalClicked))

    let toolbarActions = NSStackView(views: [stopBtn, reloadBtn, copyURLBtn, openExternalBtn])
    toolbarActions.orientation = .horizontal
    toolbarActions.spacing = 6
    toolbarActions.translatesAutoresizingMaskIntoConstraints = false
    toolbarActions.setContentHuggingPriority(.required, for: .horizontal)
    toolbarActions.setContentCompressionResistancePriority(.required, for: .horizontal)

    addressBar.addSubview(statusPill)
    addressBar.addSubview(addressField)
    addressBar.addSubview(toolbarActions)
    addressBar.addSubview(addressDivider)

    progressBar.translatesAutoresizingMaskIntoConstraints = false
    progressBar.isHidden = true

    // 2. Main stage & WebView host
    stageHost.wantsLayer = true
    stageHost.translatesAutoresizingMaskIntoConstraints = false

    webContainer.wantsLayer = true
    webContainer.translatesAutoresizingMaskIntoConstraints = false
    webContainer.isHidden = true

    // 3. State overlay card
    stateOverlay.wantsLayer = true
    stateOverlay.translatesAutoresizingMaskIntoConstraints = false

    stateCard.wantsLayer = true
    stateCard.layer?.cornerRadius = 14
    stateCard.layer?.cornerCurve = .continuous
    stateCard.layer?.borderWidth = 1
    stateCard.translatesAutoresizingMaskIntoConstraints = false

    cardIdentityGlyph.translatesAutoresizingMaskIntoConstraints = false

    cardStatusBadge.wantsLayer = true
    cardStatusBadge.layer?.cornerRadius = 18
    cardStatusBadge.layer?.cornerCurve = .continuous
    cardStatusBadge.layer?.borderWidth = 1
    cardStatusBadge.translatesAutoresizingMaskIntoConstraints = false

    cardStatusIcon.imageScaling = .scaleProportionallyDown
    cardStatusIcon.translatesAutoresizingMaskIntoConstraints = false
    cardStatusBadge.addSubview(cardStatusIcon)

    loadingSpinner.style = .spinning
    loadingSpinner.controlSize = .small
    loadingSpinner.isDisplayedWhenStopped = false
    loadingSpinner.translatesAutoresizingMaskIntoConstraints = false
    cardStatusBadge.addSubview(loadingSpinner)

    cardTitleLabel.font = .systemFont(ofSize: 16, weight: .semibold)
    cardTitleLabel.maximumNumberOfLines = 2
    cardTitleLabel.lineBreakMode = .byTruncatingTail
    cardTitleLabel.translatesAutoresizingMaskIntoConstraints = false
    cardTitleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    cardTitleLabel.setAccessibilityElement(true)
    cardTitleLabel.setAccessibilityRole(.staticText)
    cardTitleLabel.setAccessibilityLabel("网页标题")

    cachedTitlePill.wantsLayer = true
    cachedTitlePill.layer?.cornerRadius = 5
    cachedTitlePill.layer?.cornerCurve = .continuous
    cachedTitlePill.translatesAutoresizingMaskIntoConstraints = false
    cachedTitlePill.setContentHuggingPriority(.required, for: .horizontal)
    cachedTitlePill.setContentCompressionResistancePriority(.required, for: .horizontal)

    cachedTitleTag.font = .systemFont(ofSize: 10.5, weight: .medium)
    cachedTitleTag.translatesAutoresizingMaskIntoConstraints = false
    cachedTitleTag.setContentHuggingPriority(.required, for: .horizontal)
    cachedTitleTag.setContentCompressionResistancePriority(.required, for: .horizontal)
    cachedTitleTag.setAccessibilityElement(true)
    cachedTitleTag.setAccessibilityRole(.staticText)
    cachedTitleTag.setAccessibilityLabel("标题来源")
    cachedTitlePill.addSubview(cachedTitleTag)

    domainLabel.font = .systemFont(ofSize: 12, weight: .medium)
    domainLabel.lineBreakMode = .byTruncatingMiddle
    domainLabel.maximumNumberOfLines = 1
    domainLabel.translatesAutoresizingMaskIntoConstraints = false
    domainLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    domainLabel.setAccessibilityElement(true)
    domainLabel.setAccessibilityRole(.staticText)
    domainLabel.setAccessibilityLabel("网页域名")

    let titleRow = NSStackView(views: [cardTitleLabel, cachedTitlePill])
    titleRow.orientation = .horizontal
    titleRow.alignment = .centerY
    titleRow.spacing = 8

    let headerMetaCol = NSStackView(views: [titleRow, domainLabel])
    headerMetaCol.orientation = .vertical
    headerMetaCol.alignment = .leading
    headerMetaCol.spacing = 4
    headerMetaCol.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    let iconHost = NSView()
    iconHost.translatesAutoresizingMaskIntoConstraints = false
    iconHost.addSubview(cardIdentityGlyph)
    iconHost.addSubview(cardStatusBadge)

    let cardHeaderRow = NSStackView(views: [iconHost, headerMetaCol])
    cardHeaderRow.orientation = .horizontal
    cardHeaderRow.alignment = .centerY
    cardHeaderRow.spacing = 12
    cardHeaderRow.translatesAutoresizingMaskIntoConstraints = false

    urlBox.wantsLayer = true
    urlBox.layer?.cornerRadius = 8
    urlBox.layer?.cornerCurve = .continuous
    urlBox.layer?.borderWidth = 1
    urlBox.translatesAutoresizingMaskIntoConstraints = false

    urlDisplayField.font = .monospacedSystemFont(ofSize: 11.5, weight: .regular)
    urlDisplayField.isEditable = false
    urlDisplayField.isSelectable = true
    urlDisplayField.maximumNumberOfLines = 3
    urlDisplayField.lineBreakMode = .byCharWrapping
    urlDisplayField.translatesAutoresizingMaskIntoConstraints = false
    urlDisplayField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    urlDisplayField.setAccessibilityElement(true)
    urlDisplayField.setAccessibilityRole(.textField)
    urlDisplayField.setAccessibilityLabel("完整网页地址")
    urlBox.addSubview(urlDisplayField)

    cardDetailLabel.font = .systemFont(ofSize: 12)
    cardDetailLabel.maximumNumberOfLines = 4
    cardDetailLabel.translatesAutoresizingMaskIntoConstraints = false
    cardDetailLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    cardDetailLabel.setAccessibilityElement(true)
    cardDetailLabel.setAccessibilityRole(.staticText)
    cardDetailLabel.setAccessibilityLabel("状态与隔离说明")

    configureCardButton(loadWebBtn, title: "加载网页", accessibility: "在隔离环境中主动加载此网页", isPrimary: true, action: #selector(loadWebClicked))
    configureCardButton(retryBtn, title: "重试", accessibility: "重新加载网页", isPrimary: true, action: #selector(retryClicked))
    configureCardButton(cancelLoadBtn, title: "取消加载", accessibility: "取消当前网页加载", isPrimary: false, action: #selector(stopLoadClicked))
    configureCardButton(cardOpenExternalBtn, title: "外部打开", accessibility: "在外部默认浏览器打开此链接", isPrimary: false, action: #selector(openExternalClicked))
    configureCardButton(cardCopyBtn, title: "复制链接", accessibility: "复制完整链接到剪贴板", isPrimary: false, action: #selector(copyURLClicked))

    let cardActions = NSStackView(views: [loadWebBtn, retryBtn, cancelLoadBtn, cardOpenExternalBtn, cardCopyBtn])
    cardActions.orientation = .horizontal
    cardActions.alignment = .centerY
    cardActions.spacing = 8
    cardActions.translatesAutoresizingMaskIntoConstraints = false

    let cardStack = NSStackView(views: [cardHeaderRow, urlBox, cardDetailLabel, cardActions])
    cardStack.orientation = .vertical
    cardStack.alignment = .leading
    cardStack.spacing = 12
    cardStack.setCustomSpacing(16, after: cardDetailLabel)
    cardStack.translatesAutoresizingMaskIntoConstraints = false

    stateCard.addSubview(cardStack)
    stateOverlay.addSubview(stateCard)

    stageHost.addSubview(webContainer)
    stageHost.addSubview(stateOverlay)
    stageHost.addSubview(progressBar)

    addSubview(addressBar)
    addSubview(stageHost)

    let preferredCardWidth = stateCard.widthAnchor.constraint(equalToConstant: 480)
    preferredCardWidth.priority = .defaultHigh

    NSLayoutConstraint.activate([
      addressBar.topAnchor.constraint(equalTo: topAnchor),
      addressBar.leadingAnchor.constraint(equalTo: leadingAnchor),
      addressBar.trailingAnchor.constraint(equalTo: trailingAnchor),
      addressBar.heightAnchor.constraint(equalToConstant: 44),

      statusPill.leadingAnchor.constraint(equalTo: addressBar.leadingAnchor, constant: 12),
      statusPill.centerYAnchor.constraint(equalTo: addressBar.centerYAnchor),
      statusPill.heightAnchor.constraint(equalToConstant: 22),

      statusDot.leadingAnchor.constraint(equalTo: statusPill.leadingAnchor, constant: 8),
      statusDot.centerYAnchor.constraint(equalTo: statusPill.centerYAnchor),
      statusDot.widthAnchor.constraint(equalToConstant: 6),
      statusDot.heightAnchor.constraint(equalToConstant: 6),

      statusLabel.leadingAnchor.constraint(equalTo: statusDot.trailingAnchor, constant: 6),
      statusLabel.trailingAnchor.constraint(equalTo: statusPill.trailingAnchor, constant: -8),
      statusLabel.centerYAnchor.constraint(equalTo: statusPill.centerYAnchor),

      addressField.leadingAnchor.constraint(equalTo: statusPill.trailingAnchor, constant: 10),
      addressField.trailingAnchor.constraint(lessThanOrEqualTo: toolbarActions.leadingAnchor, constant: -10),
      addressField.centerYAnchor.constraint(equalTo: addressBar.centerYAnchor),

      toolbarActions.trailingAnchor.constraint(equalTo: addressBar.trailingAnchor, constant: -12),
      toolbarActions.centerYAnchor.constraint(equalTo: addressBar.centerYAnchor),

      addressDivider.leadingAnchor.constraint(equalTo: addressBar.leadingAnchor),
      addressDivider.trailingAnchor.constraint(equalTo: addressBar.trailingAnchor),
      addressDivider.bottomAnchor.constraint(equalTo: addressBar.bottomAnchor),
      addressDivider.heightAnchor.constraint(equalToConstant: 1),

      stageHost.topAnchor.constraint(equalTo: addressBar.bottomAnchor),
      stageHost.leadingAnchor.constraint(equalTo: leadingAnchor),
      stageHost.trailingAnchor.constraint(equalTo: trailingAnchor),
      stageHost.bottomAnchor.constraint(equalTo: bottomAnchor),

      progressBar.topAnchor.constraint(equalTo: stageHost.topAnchor),
      progressBar.leadingAnchor.constraint(equalTo: stageHost.leadingAnchor),
      progressBar.trailingAnchor.constraint(equalTo: stageHost.trailingAnchor),
      progressBar.heightAnchor.constraint(equalToConstant: 2),

      webContainer.topAnchor.constraint(equalTo: stageHost.topAnchor),
      webContainer.leadingAnchor.constraint(equalTo: stageHost.leadingAnchor),
      webContainer.trailingAnchor.constraint(equalTo: stageHost.trailingAnchor),
      webContainer.bottomAnchor.constraint(equalTo: stageHost.bottomAnchor),

      stateOverlay.topAnchor.constraint(equalTo: stageHost.topAnchor),
      stateOverlay.leadingAnchor.constraint(equalTo: stageHost.leadingAnchor),
      stateOverlay.trailingAnchor.constraint(equalTo: stageHost.trailingAnchor),
      stateOverlay.bottomAnchor.constraint(equalTo: stageHost.bottomAnchor),

      stateCard.centerXAnchor.constraint(equalTo: stateOverlay.centerXAnchor),
      stateCard.centerYAnchor.constraint(equalTo: stateOverlay.centerYAnchor),
      preferredCardWidth,
      stateCard.widthAnchor.constraint(lessThanOrEqualToConstant: 540),
      stateCard.widthAnchor.constraint(greaterThanOrEqualToConstant: 360),
      stateCard.leadingAnchor.constraint(greaterThanOrEqualTo: stateOverlay.leadingAnchor, constant: 24),
      stateCard.trailingAnchor.constraint(lessThanOrEqualTo: stateOverlay.trailingAnchor, constant: -24),

      cachedTitleTag.topAnchor.constraint(equalTo: cachedTitlePill.topAnchor, constant: 2),
      cachedTitleTag.bottomAnchor.constraint(equalTo: cachedTitlePill.bottomAnchor, constant: -2),
      cachedTitleTag.leadingAnchor.constraint(equalTo: cachedTitlePill.leadingAnchor, constant: 6),
      cachedTitleTag.trailingAnchor.constraint(equalTo: cachedTitlePill.trailingAnchor, constant: -6),

      iconHost.widthAnchor.constraint(equalToConstant: 36),
      iconHost.heightAnchor.constraint(equalToConstant: 36),

      cardIdentityGlyph.centerXAnchor.constraint(equalTo: iconHost.centerXAnchor),
      cardIdentityGlyph.centerYAnchor.constraint(equalTo: iconHost.centerYAnchor),
      cardIdentityGlyph.widthAnchor.constraint(equalToConstant: 36),
      cardIdentityGlyph.heightAnchor.constraint(equalToConstant: 36),

      cardStatusBadge.topAnchor.constraint(equalTo: iconHost.topAnchor),
      cardStatusBadge.leadingAnchor.constraint(equalTo: iconHost.leadingAnchor),
      cardStatusBadge.trailingAnchor.constraint(equalTo: iconHost.trailingAnchor),
      cardStatusBadge.bottomAnchor.constraint(equalTo: iconHost.bottomAnchor),

      cardStatusIcon.centerXAnchor.constraint(equalTo: cardStatusBadge.centerXAnchor),
      cardStatusIcon.centerYAnchor.constraint(equalTo: cardStatusBadge.centerYAnchor),
      cardStatusIcon.widthAnchor.constraint(equalToConstant: 18),
      cardStatusIcon.heightAnchor.constraint(equalToConstant: 18),

      loadingSpinner.centerXAnchor.constraint(equalTo: cardStatusBadge.centerXAnchor),
      loadingSpinner.centerYAnchor.constraint(equalTo: cardStatusBadge.centerYAnchor),

      cardStack.topAnchor.constraint(equalTo: stateCard.topAnchor, constant: 22),
      cardStack.leadingAnchor.constraint(equalTo: stateCard.leadingAnchor, constant: 22),
      cardStack.trailingAnchor.constraint(equalTo: stateCard.trailingAnchor, constant: -22),
      cardStack.bottomAnchor.constraint(equalTo: stateCard.bottomAnchor, constant: -22),

      cardHeaderRow.widthAnchor.constraint(equalTo: cardStack.widthAnchor),
      urlBox.widthAnchor.constraint(equalTo: cardStack.widthAnchor),
      cardDetailLabel.widthAnchor.constraint(equalTo: cardStack.widthAnchor),

      urlDisplayField.topAnchor.constraint(equalTo: urlBox.topAnchor, constant: 9),
      urlDisplayField.leadingAnchor.constraint(equalTo: urlBox.leadingAnchor, constant: 11),
      urlDisplayField.trailingAnchor.constraint(equalTo: urlBox.trailingAnchor, constant: -11),
      urlDisplayField.bottomAnchor.constraint(equalTo: urlBox.bottomAnchor, constant: -9)
    ])
  }

  private func configureToolbarButton(_ btn: NSButton, title: String, accessibility: String, action: Selector) {
    btn.title = title
    btn.target = self
    btn.action = action
    btn.isBordered = false
    btn.wantsLayer = true
    btn.font = .systemFont(ofSize: 11.5, weight: .medium)
    btn.layer?.cornerRadius = 7
    btn.layer?.cornerCurve = .continuous
    btn.layer?.borderWidth = 1
    btn.translatesAutoresizingMaskIntoConstraints = false
    btn.heightAnchor.constraint(equalToConstant: 26).isActive = true
    btn.widthAnchor.constraint(greaterThanOrEqualToConstant: 56).isActive = true
    btn.toolTip = accessibility
    btn.setAccessibilityLabel(accessibility)
  }

  private func configureCardButton(_ btn: NSButton, title: String, accessibility: String, isPrimary: Bool, action: Selector) {
    btn.title = title
    btn.target = self
    btn.action = action
    btn.isBordered = false
    btn.wantsLayer = true
    btn.font = .systemFont(ofSize: 12.5, weight: isPrimary ? .semibold : .medium)
    btn.layer?.cornerRadius = 8
    btn.layer?.cornerCurve = .continuous
    btn.layer?.borderWidth = 1
    btn.translatesAutoresizingMaskIntoConstraints = false
    btn.heightAnchor.constraint(equalToConstant: 32).isActive = true
    btn.widthAnchor.constraint(greaterThanOrEqualToConstant: isPrimary ? 96 : 84).isActive = true
    btn.toolTip = accessibility
    btn.setAccessibilityLabel(accessibility)
  }

  // MARK: - Lifecycle & Item Loading (Never Auto-Connects)

  override func load(item: LumenPreviewItem, context: LumenPreviewContext) {
    super.load(item: item, context: context)
    loadGeneration += 1
    let gen = loadGeneration
    intentionalPolicyCancel = true
    destroyWebView()

    cardIdentityGlyph.configure(identity: item.identity, isDark: palette.isDark, size: 36)

    let initialText = (item.inlineText ?? item.clipboardItem?.effectiveText ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    applyRawURL(initialText)

    // Hydrate full URL from local store if preview text was truncated (local IPC only; never contacts remote URL).
    if let clip = item.clipboardItem, (clip.textTruncated == true || (clip.text ?? "").isEmpty) {
      context.store.hydrateItemDetail(id: clip.id) { [weak self] detailed in
        guard let self, self.loadGeneration == gen, let full = detailed?.effectiveText else { return }
        let trimmedFull = full.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedFull.isEmpty, trimmedFull != self.rawURLString else { return }
        // Only refresh unloaded/blocked state; never interrupt an active user-initiated load.
        switch self.state {
        case .idle, .blocked:
          self.applyRawURL(trimmedFull)
        case .loading, .loaded, .failed:
          break
        }
      }
    }
  }

  private func applyRawURL(_ trimmed: String) {
    rawURLString = trimmed
    activeURL = nil
    initialAllowedURL = nil

    switch LumenURLSecurityPolicy.evaluate(rawString: trimmed) {
    case .allowed(let url):
      initialAllowedURL = url
      activeURL = url
      let cachedTitle = LumenURLSessionTitleCache.shared.title(for: url.absoluteString)
      transition(to: .idle(url: url, cachedTitle: cachedTitle))
    case .blocked(let reason):
      transition(to: .blocked(reason: reason, rawURL: trimmed, redirectedFrom: nil))
    }
  }

  override func applyTheme(_ palette: LumenPalette) {
    self.palette = palette
    layer?.backgroundColor = palette.windowBackground.cgColor
    addressBar.layer?.backgroundColor = palette.surface.cgColor
    addressDivider.layer?.backgroundColor = palette.border.cgColor
    stageHost.layer?.backgroundColor = palette.windowBackground.cgColor
    webContainer.layer?.backgroundColor = palette.windowBackground.cgColor
    stateOverlay.layer?.backgroundColor = palette.windowBackground.cgColor

    stateCard.layer?.backgroundColor = palette.surface.cgColor
    stateCard.layer?.borderColor = palette.border.cgColor

    urlBox.layer?.backgroundColor = palette.surfaceElevated.cgColor
    urlBox.layer?.borderColor = palette.border.cgColor

    addressField.textColor = palette.ink
    cardTitleLabel.textColor = palette.ink
    domainLabel.textColor = palette.muted
    urlDisplayField.textColor = palette.ink
    cardDetailLabel.textColor = palette.muted
    cachedTitleTag.textColor = palette.accent
    cachedTitlePill.layer?.backgroundColor = palette.accentSoft.cgColor
    progressBar.applyColor(palette.accent)

    for btn in [stopBtn, reloadBtn, copyURLBtn, openExternalBtn, cancelLoadBtn, cardOpenExternalBtn, cardCopyBtn] {
      styleButtonTitle(btn, color: palette.ink)
      btn.layer?.borderColor = palette.border.cgColor
      btn.layer?.backgroundColor = palette.surfaceElevated.cgColor
    }
    let primaryForeground = palette.isDark
      ? NSColor(srgbRed: 0.08, green: 0.10, blue: 0.16, alpha: 1.0)
      : NSColor.white
    for primaryBtn in [loadWebBtn, retryBtn] {
      styleButtonTitle(primaryBtn, color: primaryForeground)
      primaryBtn.layer?.borderColor = palette.accent.cgColor
      primaryBtn.layer?.backgroundColor = palette.accent.cgColor
    }

    if let item = currentItem {
      cardIdentityGlyph.configure(identity: item.identity, isDark: palette.isDark, size: 36)
    }
    renderState()
  }

  private func styleButtonTitle(_ button: NSButton, color: NSColor) {
    let font = button.font ?? .systemFont(ofSize: 12, weight: .medium)
    let para = NSMutableParagraphStyle()
    para.alignment = .center
    button.contentTintColor = color
    button.attributedTitle = NSAttributedString(
      string: button.title,
      attributes: [
        .font: font,
        .foregroundColor: color,
        .paragraphStyle: para
      ]
    )
  }

  override func zoomIn() {
    guard let wv = webView, !webContainer.isHidden else { return }
    wv.magnification = min(3.0, wv.magnification + 0.15)
  }

  override func zoomOut() {
    guard let wv = webView, !webContainer.isHidden else { return }
    wv.magnification = max(0.5, wv.magnification - 0.15)
  }

  override func resetZoom() {
    guard let wv = webView, !webContainer.isHidden else { return }
    wv.magnification = 1.0
  }

  override func copyPrimaryContent() {
    if currentItem?.clipboardItem != nil {
      super.copyPrimaryContent()
    } else {
      copyURLClicked()
    }
  }

  override func teardown() {
    loadGeneration += 1
    intentionalPolicyCancel = true
    loadingSpinner.stopAnimation(nil)
    destroyWebView()
    super.teardown()
  }

  // MARK: - Isolated WKWebView Construction & Cleanup (§7.0, §14.3)

  private func beginIsolatedLoad(url: URL) {
    // Re-verify security policy immediately before any network call.
    switch LumenURLSecurityPolicy.evaluate(url: url) {
    case .blocked(let reason):
      destroyWebView()
      transition(to: .blocked(reason: reason, rawURL: url.absoluteString, redirectedFrom: nil))
      return
    case .allowed(let safeURL):
      loadGeneration += 1
      intentionalPolicyCancel = true
      destroyWebView()
      intentionalPolicyCancel = false
      activeURL = safeURL

      let config = WKWebViewConfiguration()
      // Strict per-load isolation: non-persistent data store, fresh process pool, zero scripts, JS disabled.
      config.websiteDataStore = .nonPersistent()
      config.processPool = WKProcessPool()
      config.userContentController = WKUserContentController()
      config.defaultWebpagePreferences.allowsContentJavaScript = false
      config.allowsAirPlayForMediaPlayback = false
      config.mediaTypesRequiringUserActionForPlayback = .all
      config.preferences.javaScriptCanOpenWindowsAutomatically = false
      config.preferences.isFraudulentWebsiteWarningEnabled = true

      let wv = WKWebView(frame: webContainer.bounds, configuration: config)
      wv.navigationDelegate = self
      wv.uiDelegate = self
      wv.allowsBackForwardNavigationGestures = false
      wv.allowsLinkPreview = false
      wv.allowsMagnification = true
      wv.translatesAutoresizingMaskIntoConstraints = false
      wv.setAccessibilityLabel("隔离网页预览内容")

      webContainer.addSubview(wv)
      NSLayoutConstraint.activate([
        wv.topAnchor.constraint(equalTo: webContainer.topAnchor),
        wv.leadingAnchor.constraint(equalTo: webContainer.leadingAnchor),
        wv.trailingAnchor.constraint(equalTo: webContainer.trailingAnchor),
        wv.bottomAnchor.constraint(equalTo: webContainer.bottomAnchor)
      ])
      webView = wv

      progressObservation = wv.observe(\.estimatedProgress, options: [.new]) { [weak self] view, _ in
        DispatchQueue.main.async {
          guard let self, self.webView === view else { return }
          self.progressBar.setProgress(max(0.08, view.estimatedProgress))
        }
      }

      transition(to: .loading(url: safeURL))
      progressBar.setProgress(0.10)
      wv.load(makeIsolatedRequest(for: safeURL))
    }
  }

  private func makeIsolatedRequest(for url: URL) -> URLRequest {
    var request = URLRequest(
      url: url,
      cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
      timeoutInterval: 20
    )
    request.httpShouldHandleCookies = false
    return request
  }

  private func destroyWebView() {
    progressObservation?.invalidate()
    progressObservation = nil
    guard let wv = webView else { return }
    let dataStore = wv.configuration.websiteDataStore
    wv.stopLoading()
    wv.navigationDelegate = nil
    wv.uiDelegate = nil
    wv.removeFromSuperview()
    webView = nil
    dataStore.removeData(
      ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
      modifiedSince: .distantPast
    ) {}
  }

  // MARK: - State Presentation (Zero Displacement Animations, Reduce-Motion-Safe)

  private func transition(to nextState: ViewState) {
    state = nextState
    renderState()
  }

  private func renderState() {
    let canOpenExternally = externalTargetURL() != nil
    let hasRawURL = !rawURLString.isEmpty

    copyURLBtn.isHidden = !hasRawURL
    cardCopyBtn.isHidden = !hasRawURL
    openExternalBtn.isHidden = !canOpenExternally
    cardOpenExternalBtn.isHidden = !canOpenExternally

    switch state {
    case .idle(let url, let cachedTitle):
      let domain = hostWithOptionalPort(url)
      let schemeBadge = url.scheme?.lowercased() == "https" ? "HTTPS" : "HTTP（未加密）"
      updateStatusPill(text: "未加载", tint: palette.muted)
      addressField.stringValue = url.absoluteString
      addressField.toolTip = url.absoluteString
      addressField.setAccessibilityValue(url.absoluteString)

      stopBtn.isHidden = true
      reloadBtn.isHidden = true
      progressBar.isHidden = true
      webContainer.isHidden = true
      stateOverlay.isHidden = false

      cardIdentityGlyph.isHidden = false
      cardStatusBadge.isHidden = true
      loadingSpinner.stopAnimation(nil)

      if let cachedTitle, !cachedTitle.isEmpty {
        cardTitleLabel.stringValue = cachedTitle
        cardTitleLabel.setAccessibilityValue(cachedTitle)
        cachedTitlePill.isHidden = false
      } else {
        cardTitleLabel.stringValue = domain
        cardTitleLabel.setAccessibilityValue(domain)
        cachedTitlePill.isHidden = true
      }
      domainLabel.stringValue = "\(schemeBadge) · \(domain)"
      domainLabel.setAccessibilityValue(domain)
      urlDisplayField.stringValue = url.absoluteString
      urlDisplayField.toolTip = url.absoluteString
      urlDisplayField.setAccessibilityValue(url.absoluteString)
      cardDetailLabel.stringValue = "默认不自动联网 · 独立非持久化会话 · 已禁用 JavaScript 与文件下载"
      cardDetailLabel.textColor = palette.muted

      loadWebBtn.isHidden = false
      retryBtn.isHidden = true
      cancelLoadBtn.isHidden = true

    case .loading(let url):
      let domain = hostWithOptionalPort(url)
      updateStatusPill(text: "加载中", tint: palette.accent)
      addressField.stringValue = url.absoluteString
      addressField.toolTip = url.absoluteString
      addressField.setAccessibilityValue(url.absoluteString)

      stopBtn.isHidden = false
      reloadBtn.isHidden = true
      progressBar.isHidden = false
      // Keep WebView hidden while provisional load is in progress so errors/blocks never flash fake success.
      webContainer.isHidden = true
      stateOverlay.isHidden = false

      cardIdentityGlyph.isHidden = true
      cardStatusBadge.isHidden = false
      cardStatusBadge.layer?.backgroundColor = palette.accentSoft.cgColor
      cardStatusBadge.layer?.borderColor = palette.accentBorder.cgColor
      if LumenMotion.isEnabled {
        cardStatusIcon.isHidden = true
        loadingSpinner.isHidden = false
        loadingSpinner.startAnimation(nil)
      } else {
        loadingSpinner.stopAnimation(nil)
        loadingSpinner.isHidden = true
        cardStatusIcon.isHidden = false
        cardStatusIcon.image = LumenVectorGlyphs.actionImage(.clock, size: 18, color: palette.accent)
      }

      cardTitleLabel.stringValue = "正在隔离环境中加载网页…"
      cardTitleLabel.setAccessibilityValue("正在加载 \(domain)")
      cachedTitlePill.isHidden = true
      domainLabel.stringValue = domain
      domainLabel.setAccessibilityValue(domain)
      urlDisplayField.stringValue = url.absoluteString
      urlDisplayField.toolTip = url.absoluteString
      urlDisplayField.setAccessibilityValue(url.absoluteString)
      cardDetailLabel.stringValue = "无持久化 Cookie 与本地存储，已禁用脚本执行；重定向仍受协议与私网安全策略约束。"
      cardDetailLabel.textColor = palette.muted

      loadWebBtn.isHidden = true
      retryBtn.isHidden = true
      cancelLoadBtn.isHidden = false

    case .loaded(let url, let title):
      updateStatusPill(text: "隔离预览 · 无脚本", tint: palette.success)
      addressField.stringValue = url.absoluteString
      addressField.toolTip = title.map { "\($0)\n\(url.absoluteString)" } ?? url.absoluteString
      addressField.setAccessibilityValue(url.absoluteString)

      stopBtn.isHidden = true
      reloadBtn.isHidden = false
      progressBar.isHidden = true
      loadingSpinner.stopAnimation(nil)
      webContainer.isHidden = false
      stateOverlay.isHidden = true

    case .blocked(let reason, let rawURL, let redirectedFrom):
      let displayURL = rawURL.isEmpty ? "（空链接）" : rawURL
      let domain = LumenURLSecurityPolicy.displayDomain(for: rawURL)
      updateStatusPill(text: "已阻止", tint: palette.danger)
      addressField.stringValue = displayURL
      addressField.toolTip = displayURL
      addressField.setAccessibilityValue(displayURL)

      stopBtn.isHidden = true
      reloadBtn.isHidden = true
      progressBar.isHidden = true
      webContainer.isHidden = true
      stateOverlay.isHidden = false

      cardIdentityGlyph.isHidden = true
      cardStatusBadge.isHidden = false
      cardStatusBadge.layer?.backgroundColor = palette.dangerSoft.cgColor
      cardStatusBadge.layer?.borderColor = palette.danger.withAlphaComponent(0.38).cgColor
      loadingSpinner.stopAnimation(nil)
      loadingSpinner.isHidden = true
      cardStatusIcon.isHidden = false
      cardStatusIcon.image = LumenVectorGlyphs.actionImage(.lock, size: 18, color: palette.danger)

      cardTitleLabel.stringValue = reason.title
      cardTitleLabel.setAccessibilityValue(reason.title)
      cachedTitlePill.isHidden = true
      domainLabel.stringValue = domain
      domainLabel.setAccessibilityValue(domain)
      urlDisplayField.stringValue = displayURL
      urlDisplayField.toolTip = displayURL
      urlDisplayField.setAccessibilityValue(displayURL)
      cardDetailLabel.stringValue = reason.explanation(redirectedFrom: redirectedFrom)
      cardDetailLabel.textColor = palette.danger

      loadWebBtn.isHidden = true
      retryBtn.isHidden = true
      cancelLoadBtn.isHidden = true

    case .failed(let reason, let url):
      let domain = hostWithOptionalPort(url)
      updateStatusPill(text: "加载失败", tint: palette.danger)
      addressField.stringValue = url.absoluteString
      addressField.toolTip = url.absoluteString
      addressField.setAccessibilityValue(url.absoluteString)

      stopBtn.isHidden = true
      reloadBtn.isHidden = false
      progressBar.isHidden = true
      webContainer.isHidden = true
      stateOverlay.isHidden = false

      cardIdentityGlyph.isHidden = true
      cardStatusBadge.isHidden = false
      cardStatusBadge.layer?.backgroundColor = palette.dangerSoft.cgColor
      cardStatusBadge.layer?.borderColor = palette.danger.withAlphaComponent(0.38).cgColor
      loadingSpinner.stopAnimation(nil)
      loadingSpinner.isHidden = true
      cardStatusIcon.isHidden = false
      cardStatusIcon.image = LumenVectorGlyphs.actionImage(.externalLink, size: 18, color: palette.danger)

      cardTitleLabel.stringValue = reason.title
      cardTitleLabel.setAccessibilityValue(reason.title)
      cachedTitlePill.isHidden = true
      domainLabel.stringValue = domain
      domainLabel.setAccessibilityValue(domain)
      urlDisplayField.stringValue = url.absoluteString
      urlDisplayField.toolTip = url.absoluteString
      urlDisplayField.setAccessibilityValue(url.absoluteString)
      cardDetailLabel.stringValue = reason.detail
      cardDetailLabel.textColor = palette.muted

      loadWebBtn.isHidden = true
      retryBtn.isHidden = false
      cancelLoadBtn.isHidden = true
    }
  }

  private func updateStatusPill(text: String, tint: NSColor) {
    statusLabel.stringValue = text
    statusLabel.setAccessibilityValue(text)
    statusLabel.textColor = tint
    statusDot.layer?.backgroundColor = tint.cgColor
    statusPill.layer?.backgroundColor = tint.withAlphaComponent(palette.isDark ? 0.16 : 0.10).cgColor
    statusPill.layer?.borderColor = tint.withAlphaComponent(palette.isDark ? 0.34 : 0.24).cgColor
  }

  private func hostWithOptionalPort(_ url: URL) -> String {
    let host = url.host ?? url.absoluteString
    if let port = url.port {
      return "\(host):\(port)"
    }
    return host
  }

  private func externalTargetURL() -> URL? {
    switch state {
    case .idle(let url, _), .loading(let url), .loaded(let url, _), .failed(_, let url):
      return url
    case .blocked(let reason, let rawURL, _):
      // Only allow external browser escape for blocked private/local http(s) URLs;
      // NEVER open dangerous non-http(s) schemes (file:, javascript:, data:) externally.
      if case .privateOrLocalTarget = reason {
        return LumenURLSecurityPolicy.externalOpenURL(from: rawURL)
      }
      return nil
    }
  }

  private func activeCopyString() -> String {
    switch state {
    case .idle(let url, _), .loading(let url), .loaded(let url, _), .failed(_, let url):
      return url.absoluteString
    case .blocked(_, let rawURL, _):
      return rawURL
    }
  }

  // MARK: - Actions

  @objc private func loadWebClicked() {
    guard let url = initialAllowedURL ?? activeURL else { return }
    beginIsolatedLoad(url: url)
  }

  @objc private func retryClicked() {
    guard let url = activeURL ?? initialAllowedURL else { return }
    beginIsolatedLoad(url: url)
  }

  @objc private func reloadClicked() {
    guard let url = activeURL ?? initialAllowedURL else { return }
    beginIsolatedLoad(url: url)
  }

  @objc private func stopLoadClicked() {
    intentionalPolicyCancel = true
    destroyWebView()
    if let url = initialAllowedURL ?? activeURL {
      let cached = LumenURLSessionTitleCache.shared.title(for: url.absoluteString)
      transition(to: .idle(url: url, cachedTitle: cached))
    }
  }

  @objc private func copyURLClicked() {
    let text = activeCopyString()
    guard !text.isEmpty else { return }
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setString(text, forType: .string)
    currentContext?.onToast("已复制链接")
  }

  @objc private func openExternalClicked() {
    guard let url = externalTargetURL() else { return }
    NSWorkspace.shared.open(url)
  }

  // MARK: - WKNavigationDelegate (Redirect, Protocol, Private-IP, Download & Error Enforcement)

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    preferences: WKWebpagePreferences,
    decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
  ) {
    // Always enforce JavaScript disabled on every navigation and redirect.
    preferences.allowsContentJavaScript = false

    guard webView === self.webView else {
      decisionHandler(.cancel, preferences)
      return
    }

    let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
    guard let targetURL = navigationAction.request.url else {
      decisionHandler(.cancel, preferences)
      return
    }

    // Block download-triggered navigations from touching disk.
    if navigationAction.shouldPerformDownload {
      decisionHandler(.cancel, preferences)
      if isMainFrame {
        intentionalPolicyCancel = true
        let blockedURL = activeURL ?? targetURL
        destroyWebView()
        transition(to: .failed(reason: .downloadBlocked("下载链接"), url: blockedURL))
      }
      return
    }

    // Enforce http/https + non-private-network policy for both main frame and subframes.
    switch LumenURLSecurityPolicy.evaluate(url: targetURL) {
    case .blocked(let reason):
      decisionHandler(.cancel, preferences)
      if isMainFrame {
        let origin = activeURL
        intentionalPolicyCancel = true
        destroyWebView()
        transition(to: .blocked(reason: reason, rawURL: targetURL.absoluteString, redirectedFrom: origin))
      }
      return

    case .allowed(let safeURL):
      if navigationAction.targetFrame == nil {
        // Popup/target="_blank": never open a separate unisolated window.
        // Only follow explicit user link clicks within the current isolated container.
        decisionHandler(.cancel, preferences)
        if navigationAction.navigationType == .linkActivated {
          activeURL = safeURL
          transition(to: .loading(url: safeURL))
          progressBar.setProgress(0.12)
          webView.load(makeIsolatedRequest(for: safeURL))
        }
        return
      }

      if isMainFrame {
        activeURL = safeURL
        addressField.stringValue = safeURL.absoluteString
        addressField.toolTip = safeURL.absoluteString
        addressField.setAccessibilityValue(safeURL.absoluteString)
      }
      decisionHandler(.allow, preferences)
    }
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationResponse: WKNavigationResponse,
    decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
  ) {
    guard webView === self.webView else {
      decisionHandler(.cancel)
      return
    }

    if let responseURL = navigationResponse.response.url,
       case .blocked(let reason) = LumenURLSecurityPolicy.evaluate(url: responseURL) {
      decisionHandler(.cancel)
      if navigationResponse.isForMainFrame {
        let origin = activeURL
        intentionalPolicyCancel = true
        destroyWebView()
        transition(to: .blocked(reason: reason, rawURL: responseURL.absoluteString, redirectedFrom: origin))
      }
      return
    }

    if !navigationResponse.isForMainFrame {
      decisionHandler(navigationResponse.canShowMIMEType ? .allow : .cancel)
      return
    }

    let resolvedURL = navigationResponse.response.url ?? activeURL ?? initialAllowedURL
    if let http = navigationResponse.response as? HTTPURLResponse {
      if let disposition = http.value(forHTTPHeaderField: "Content-Disposition")?.lowercased(),
         disposition.contains("attachment") {
        decisionHandler(.cancel)
        if let target = resolvedURL {
          intentionalPolicyCancel = true
          destroyWebView()
          transition(to: .failed(reason: .downloadBlocked("Content-Disposition: attachment"), url: target))
        }
        return
      }
      if http.statusCode >= 400 {
        decisionHandler(.cancel)
        if let target = resolvedURL {
          intentionalPolicyCancel = true
          destroyWebView()
          transition(to: .failed(reason: .httpError(http.statusCode), url: target))
        }
        return
      }
    }

    if !navigationResponse.canShowMIMEType {
      decisionHandler(.cancel)
      if let target = resolvedURL {
        let mime = navigationResponse.response.mimeType ?? "application/octet-stream"
        intentionalPolicyCancel = true
        destroyWebView()
        transition(to: .failed(reason: .downloadBlocked(mime), url: target))
      }
      return
    }

    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    guard webView === self.webView else { return }
    if let url = webView.url, case .allowed(let safeURL) = LumenURLSecurityPolicy.evaluate(url: url) {
      activeURL = safeURL
      transition(to: .loading(url: safeURL))
    }
  }

  func webView(_ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!) {
    guard webView === self.webView, let url = webView.url else { return }
    switch LumenURLSecurityPolicy.evaluate(url: url) {
    case .blocked(let reason):
      let origin = activeURL
      intentionalPolicyCancel = true
      destroyWebView()
      transition(to: .blocked(reason: reason, rawURL: url.absoluteString, redirectedFrom: origin))
    case .allowed(let safeURL):
      activeURL = safeURL
      transition(to: .loading(url: safeURL))
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard webView === self.webView, !intentionalPolicyCancel else { return }
    let finalURL = webView.url ?? activeURL ?? initialAllowedURL
    guard let finalURL else { return }

    if case .blocked(let reason) = LumenURLSecurityPolicy.evaluate(url: finalURL) {
      let origin = activeURL
      intentionalPolicyCancel = true
      destroyWebView()
      transition(to: .blocked(reason: reason, rawURL: finalURL.absoluteString, redirectedFrom: origin))
      return
    }

    activeURL = finalURL
    let pageTitle = webView.title?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let pageTitle, !pageTitle.isEmpty {
      LumenURLSessionTitleCache.shared.store(pageTitle, for: finalURL.absoluteString)
      if let initial = initialAllowedURL, initial.absoluteString != finalURL.absoluteString {
        LumenURLSessionTitleCache.shared.store(pageTitle, for: initial.absoluteString)
      }
    }
    transition(to: .loaded(url: finalURL, title: pageTitle?.isEmpty == false ? pageTitle : nil))
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    handleNavigationFailure(webView: webView, error: error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    handleNavigationFailure(webView: webView, error: error)
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    guard webView === self.webView else { return }
    let target = activeURL ?? initialAllowedURL
    intentionalPolicyCancel = true
    destroyWebView()
    if let target {
      transition(to: .failed(reason: .processTerminated, url: target))
    }
  }

  private func handleNavigationFailure(webView: WKWebView, error: Error) {
    guard webView === self.webView else { return }
    let nsError = error as NSError
    // Ignore cancellations triggered intentionally by our own security/download/HTTP policy or teardown.
    if intentionalPolicyCancel
      || (nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled)
      || (nsError.domain == "WebKitErrorDomain" && nsError.code == 102) {
      return
    }

    let target = activeURL ?? initialAllowedURL
    destroyWebView()
    guard let target else { return }
    transition(to: .failed(reason: classifyError(nsError), url: target))
  }

  private func classifyError(_ error: NSError) -> LumenURLFailureReason {
    if error.domain == NSURLErrorDomain {
      switch error.code {
      case NSURLErrorNotConnectedToInternet,
           NSURLErrorNetworkConnectionLost,
           NSURLErrorDataNotAllowed,
           NSURLErrorInternationalRoamingOff:
        return .offline
      case NSURLErrorTimedOut:
        return .timeout
      case NSURLErrorCannotFindHost,
           NSURLErrorDNSLookupFailed,
           NSURLErrorCannotConnectToHost:
        return .unreachable(error.localizedDescription)
      case NSURLErrorSecureConnectionFailed,
           NSURLErrorServerCertificateHasBadDate,
           NSURLErrorServerCertificateUntrusted,
           NSURLErrorServerCertificateHasUnknownRoot,
           NSURLErrorServerCertificateNotYetValid,
           NSURLErrorClientCertificateRejected,
           NSURLErrorClientCertificateRequired:
        return .tlsError(error.localizedDescription)
      default:
        break
      }
    }
    return .generic(error.localizedDescription)
  }

  // MARK: - WKUIDelegate (No Popups, No File Picker Exposure)

  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    // Never spawn an unisolated popup window.
    if webView === self.webView,
       navigationAction.navigationType == .linkActivated,
       let targetURL = navigationAction.request.url,
       case .allowed(let safeURL) = LumenURLSecurityPolicy.evaluate(url: targetURL) {
      activeURL = safeURL
      transition(to: .loading(url: safeURL))
      progressBar.setProgress(0.12)
      webView.load(makeIsolatedRequest(for: safeURL))
    }
    return nil
  }

  func webView(
    _ webView: WKWebView,
    runOpenPanelWith parameters: WKOpenPanelParameters,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping ([URL]?) -> Void
  ) {
    // Never expose local filesystem pickers to previewed web pages.
    completionHandler(nil)
  }
}
