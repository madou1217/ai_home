import AppKit
import CoreGraphics
import Foundation

// MARK: - V15 Ten Logical Categories (Fixed Order, §3.2)

/// Fixed ten-category logical taxonomy shared across Orbit Optical Dots 3.0,
/// Native Library sidebar navigation, and filtering.
enum LumenLogicalCategory: String, CaseIterable, Hashable {
  case all = "all"
  case text = "text"
  case code = "code"
  case link = "link"
  case image = "image"
  case color = "color"
  case document = "doc"
  case audio = "audio"
  case video = "video"
  case otherFile = "file"

  static let filterableCategories: [LumenLogicalCategory] = [
    .text, .code, .link, .image, .color, .document, .audio, .video, .otherFile
  ]

  var label: String {
    switch self {
    case .all: return "全部"
    case .text: return "文本"
    case .code: return "代码"
    case .link: return "链接"
    case .image: return "图片"
    case .color: return "颜色"
    case .document: return "文档"
    case .audio: return "音频"
    case .video: return "视频"
    case .otherFile: return "其他文件"
    }
  }

  var navGlyphID: String {
    switch self {
    case .all: return "all"
    case .text: return "text"
    case .code: return "lang-unknown"
    case .link: return "link"
    case .image: return "image"
    case .color: return "color"
    case .document: return "doc"
    case .audio: return "audio"
    case .video: return "video"
    case .otherFile: return "batch"
    }
  }
}

// MARK: - Content Identity Model (§18.1)

enum LumenContentFamily: String, Equatable, Hashable {
  case text
  case code
  case image
  case color
  case link
  case document
  case audio
  case video
  case archive
  case collection
  case file
}

enum LumenIdentityConfidence: String, Equatable {
  case confirmed
  case probable
  case unknown
}

enum LumenPreviewAvailability: String, Equatable {
  case ready
  case loading
  case unsupported
  case missing
  case locked
  case error
}

struct LumenContentIdentity: Equatable {
  let family: LumenContentFamily
  let subtype: String
  let language: String?
  let confidence: LumenIdentityConfidence
  let glyphID: String
  let displayName: String
  let logicalCategory: LumenLogicalCategory
  let rendererID: String?
  let previewAvailability: LumenPreviewAvailability
  let lightColorHex: String

  var lightTintColor: NSColor {
    LumenColorMath.color(hex: lightColorHex) ?? NSColor(srgbRed: 0.47, green: 0.50, blue: 0.69, alpha: 1)
  }

  var darkTintColor: NSColor {
    LumenColorMath.mix(lightTintColor, with: NSColor(srgbRed: 0.914, green: 0.957, blue: 1.0, alpha: 1.0), ratio: 0.23)
  }

  func tintColor(isDark: Bool) -> NSColor {
    isDark ? darkTintColor : lightTintColor
  }
}

// MARK: - Color Parsing & Mixing Utilities

enum LumenColorMath {
  static func color(hex raw: String) -> NSColor? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.hasPrefix("#") else { return nil }
    let hex = String(trimmed.dropFirst())
    guard hex.count == 3 || hex.count == 6 || hex.count == 8,
          hex.allSatisfy({ $0.isHexDigit }) else {
      return nil
    }
    let expanded: String
    if hex.count == 3 {
      expanded = hex.map { "\($0)\($0)" }.joined()
    } else {
      expanded = hex
    }
    var value: UInt64 = 0
    guard Scanner(string: expanded).scanHexInt64(&value) else { return nil }
    if expanded.count == 8 {
      return NSColor(
        srgbRed: CGFloat((value >> 24) & 0xFF) / 255.0,
        green: CGFloat((value >> 16) & 0xFF) / 255.0,
        blue: CGFloat((value >> 8) & 0xFF) / 255.0,
        alpha: CGFloat(value & 0xFF) / 255.0
      )
    }
    return NSColor(
      srgbRed: CGFloat((value >> 16) & 0xFF) / 255.0,
      green: CGFloat((value >> 8) & 0xFF) / 255.0,
      blue: CGFloat(value & 0xFF) / 255.0,
      alpha: 1.0
    )
  }

  static func parseAnyColor(_ raw: String) -> NSColor? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if let hexColor = color(hex: trimmed) {
      return hexColor
    }
    let lower = trimmed.lowercased()
    if lower.hasPrefix("rgb(") || lower.hasPrefix("rgba(") {
      return parseRGBFunction(lower)
    }
    if lower.hasPrefix("hsl(") || lower.hasPrefix("hsla(") {
      return parseHSLFunction(lower)
    }
    return nil
  }

  private static func parseRGBFunction(_ raw: String) -> NSColor? {
    guard let open = raw.firstIndex(of: "("),
          raw.hasSuffix(")") else { return nil }
    let inner = raw[raw.index(after: open)..<raw.index(before: raw.endIndex)]
    let parts = inner.split(whereSeparator: { $0 == "," || $0 == "/" }).map {
      $0.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    guard parts.count == 3 || parts.count == 4,
          let r = Double(parts[0]), let g = Double(parts[1]), let b = Double(parts[2]),
          (0...255).contains(r), (0...255).contains(g), (0...255).contains(b) else {
      return nil
    }
    var alpha = 1.0
    if parts.count == 4 {
      guard let a = Double(parts[3]), (0...1).contains(a) else { return nil }
      alpha = a
    }
    return NSColor(srgbRed: CGFloat(r / 255.0), green: CGFloat(g / 255.0), blue: CGFloat(b / 255.0), alpha: CGFloat(alpha))
  }

  private static func parseHSLFunction(_ raw: String) -> NSColor? {
    guard let open = raw.firstIndex(of: "("),
          raw.hasSuffix(")") else { return nil }
    let inner = raw[raw.index(after: open)..<raw.index(before: raw.endIndex)]
    let parts = inner.split(whereSeparator: { $0 == "," || $0 == "/" }).map {
      $0.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    guard parts.count == 3 || parts.count == 4 else { return nil }
    guard parts[1].hasSuffix("%"), parts[2].hasSuffix("%"),
          let h = Double(parts[0].replacingOccurrences(of: "deg", with: "")),
          let sPct = Double(parts[1].dropLast()),
          let lPct = Double(parts[2].dropLast()),
          (0...100).contains(sPct), (0...100).contains(lPct) else {
      return nil
    }
    var alpha = 1.0
    if parts.count == 4 {
      guard let a = Double(parts[3]), (0...1).contains(a) else { return nil }
      alpha = a
    }
    let hue = ((h.truncatingRemainder(dividingBy: 360)) + 360).truncatingRemainder(dividingBy: 360) / 360.0
    let s = sPct / 100.0
    let l = lPct / 100.0
    let q = l < 0.5 ? l * (1 + s) : l + s - l * s
    let p = 2 * l - q
    func hueToRGB(_ tRaw: Double) -> Double {
      var t = tRaw
      if t < 0 { t += 1 }
      if t > 1 { t -= 1 }
      if t < 1.0 / 6.0 { return p + (q - p) * 6 * t }
      if t < 0.5 { return q }
      if t < 2.0 / 3.0 { return p + (q - p) * (2.0 / 3.0 - t) * 6 }
      return p
    }
    let r = s == 0 ? l : hueToRGB(hue + 1.0 / 3.0)
    let g = s == 0 ? l : hueToRGB(hue)
    let b = s == 0 ? l : hueToRGB(hue - 1.0 / 3.0)
    return NSColor(srgbRed: CGFloat(r), green: CGFloat(g), blue: CGFloat(b), alpha: CGFloat(alpha))
  }

  static func mix(_ base: NSColor, with target: NSColor, ratio: CGFloat) -> NSColor {
    let clamped = max(0, min(1, ratio))
    let a = base.usingColorSpace(.sRGB) ?? base
    let b = target.usingColorSpace(.sRGB) ?? target
    return NSColor(
      srgbRed: a.redComponent * (1 - clamped) + b.redComponent * clamped,
      green: a.greenComponent * (1 - clamped) + b.greenComponent * clamped,
      blue: a.blueComponent * (1 - clamped) + b.blueComponent * clamped,
      alpha: a.alphaComponent * (1 - clamped) + b.alphaComponent * clamped
    )
  }

  static func hexString(from color: NSColor) -> String {
    let rgb = color.usingColorSpace(.sRGB) ?? color
    let r = Int((rgb.redComponent * 255).rounded())
    let g = Int((rgb.greenComponent * 255).rounded())
    let b = Int((rgb.blueComponent * 255).rounded())
    return String(format: "#%02X%02X%02X", max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)))
  }

  static func rgbString(from color: NSColor) -> String {
    let rgb = color.usingColorSpace(.sRGB) ?? color
    let r = Int((rgb.redComponent * 255).rounded())
    let g = Int((rgb.greenComponent * 255).rounded())
    let b = Int((rgb.blueComponent * 255).rounded())
    return "rgb(\(r), \(g), \(b))"
  }

  static func hslString(from color: NSColor) -> String {
    let rgb = color.usingColorSpace(.sRGB) ?? color
    let r = Double(rgb.redComponent)
    let g = Double(rgb.greenComponent)
    let b = Double(rgb.blueComponent)
    let maxVal = max(r, g, b)
    let minVal = min(r, g, b)
    let d = maxVal - minVal
    let l = (maxVal + minVal) / 2.0
    let s = d == 0 ? 0 : d / (1 - abs(2 * l - 1))
    var h = 0.0
    if d != 0 {
      if maxVal == r {
        h = (((g - b) / d).truncatingRemainder(dividingBy: 6) + 6).truncatingRemainder(dividingBy: 6) * 60
      } else if maxVal == g {
        h = ((b - r) / d + 2) * 60
      } else {
        h = ((r - g) / d + 4) * 60
      }
    }
    return "hsl(\(Int(h.rounded())), \(Int((s * 100).rounded()))%, \(Int((l * 100).rounded()))%)"
  }
}

// MARK: - Single Source of Truth: ContentIdentityRegistry (§18.1, §18.2)

struct LumenLanguageDescriptor {
  let id: String
  let displayName: String
  let monogram: String
  let colorHex: String
}

final class LumenContentIdentityRegistry {
  static let shared = LumenContentIdentityRegistry()

  struct OverrideEntry: Equatable {
    let family: LumenContentFamily
    let language: String?
  }

  private var userOverrides: [String: OverrideEntry] = [:]

  // V14 language registry (47 languages + unknown)
  static let languages: [String: LumenLanguageDescriptor] = {
    let specs: [(String, String, String, String)] = [
      ("js", "JavaScript", "JS", "#c99a25"),
      ("ts", "TypeScript", "TS", "#397ac5"),
      ("go", "Go", "GO", "#168fae"),
      ("php", "PHP", "php", "#7975bc"),
      ("py", "Python", "Py", "#397eac"),
      ("rs", "Rust", "Rs", "#b66b47"),
      ("sql", "SQL", "SQL", "#8a69bd"),
      ("sh", "Shell", ">_", "#378c72"),
      ("json", "JSON", "{ }", "#a28b43"),
      ("css", "CSS", "CSS", "#7762bd"),
      ("yaml", "YAML", "Y", "#ba6277"),
      ("html", "HTML", "HTML", "#c66a43"),
      ("svg", "SVG", "SVG", "#bc8a37"),
      ("md", "Markdown", "M↓", "#5a7fae"),
      ("csv", "CSV", "CSV", "#4a957e"),
      ("xml", "XML", "XML", "#b47d46"),
      ("java", "Java", "J", "#be704e"),
      ("cpp", "C++", "C++", "#557bb6"),
      ("c", "C", "C", "#617cae"),
      ("cs", "C#", "C#", "#8a65b9"),
      ("rb", "Ruby", "Rb", "#c2586c"),
      ("swift", "Swift", "Sw", "#da7955"),
      ("kt", "Kotlin", "Kt", "#9667cf"),
      ("dart", "Dart", "Da", "#3295b5"),
      ("lua", "Lua", "Lua", "#646ab9"),
      ("r", "R", "R", "#537fae"),
      ("ps1", "PowerShell", "PS", "#477db9"),
      ("bat", "Batch", "BAT", "#65778b"),
      ("fish", "Fish", "><", "#389a91"),
      ("zsh", "Zsh", "Z", "#688c66"),
      ("toml", "TOML", "T", "#a57852"),
      ("ini", "INI", "INI", "#8b819d"),
      ("docker", "Dockerfile", "D", "#348bbe"),
      ("make", "Makefile", "Mk", "#6f8a5e"),
      ("vue", "Vue", "V", "#339e83"),
      ("svelte", "Svelte", "S", "#dc7857"),
      ("jsx", "JSX", "JX", "#38a2b9"),
      ("tsx", "TSX", "TX", "#3b88be"),
      ("scala", "Scala", "Sc", "#bf5c5c"),
      ("ex", "Elixir", "Ex", "#886ab9"),
      ("hs", "Haskell", "λ", "#8072b4"),
      ("zig", "Zig", "Z", "#bb8a33"),
      ("pl", "Perl", "Pl", "#647db0"),
      ("proto", "Protobuf", "Pb", "#678d9b"),
      ("graphql", "GraphQL", "G", "#bd65a0"),
      ("diff", "Diff", "±", "#628d73"),
      ("unknown", "未知语言", "<>", "#7e8a9c")
    ]
    var map: [String: LumenLanguageDescriptor] = [:]
    for (id, name, mono, hex) in specs {
      map[id] = LumenLanguageDescriptor(id: id, displayName: name, monogram: mono, colorHex: hex)
    }
    return map
  }()

  private static let extensionToLanguage: [String: String] = [
    "js": "js", "mjs": "js", "cjs": "js",
    "ts": "ts", "mts": "ts", "cts": "ts",
    "jsx": "jsx", "tsx": "tsx",
    "go": "go",
    "php": "php",
    "py": "py", "pyw": "py",
    "rs": "rs",
    "sql": "sql",
    "sh": "sh", "bash": "sh", "shell": "sh",
    "zsh": "zsh", "fish": "fish",
    "json": "json", "jsonl": "json",
    "css": "css", "scss": "css", "less": "css",
    "yaml": "yaml", "yml": "yaml",
    "html": "html", "htm": "html",
    "svg": "svg",
    "md": "md", "markdown": "md",
    "xml": "xml", "plist": "xml",
    "java": "java",
    "cpp": "cpp", "cc": "cpp", "cxx": "cpp", "hpp": "cpp", "hxx": "cpp",
    "c": "c", "h": "c",
    "cs": "cs",
    "rb": "rb",
    "swift": "swift",
    "kt": "kt", "kts": "kt",
    "dart": "dart",
    "lua": "lua",
    "r": "r",
    "ps1": "ps1", "psm1": "ps1",
    "bat": "bat", "cmd": "bat",
    "toml": "toml",
    "ini": "ini", "conf": "ini", "cfg": "ini", "env": "ini",
    "vue": "vue",
    "svelte": "svelte",
    "scala": "scala",
    "ex": "ex", "exs": "ex",
    "hs": "hs",
    "zig": "zig",
    "pl": "pl", "pm": "pl", "raku": "pl",
    "proto": "proto",
    "graphql": "graphql", "gql": "graphql",
    "diff": "diff", "patch": "diff"
  ]

  private static let languageAliases: [String: String] = [
    "javascript": "js",
    "typescript": "ts",
    "python": "py",
    "rust": "rs",
    "golang": "go",
    "bash": "sh",
    "shell": "sh",
    "powershell": "ps1",
    "ruby": "rb",
    "csharp": "cs",
    "c++": "cpp",
    "c#": "cs",
    "markdown": "md",
    "kotlin": "kt",
    "yml": "yaml",
    "htm": "html"
  ]

  private static let pdfExtensions: Set<String> = ["pdf"]
  private static let wordExtensions: Set<String> = ["doc", "docx", "odt", "rtf"]
  private static let sheetExtensions: Set<String> = ["xls", "xlsx", "ods"]
  private static let slideExtensions: Set<String> = ["ppt", "pptx", "odp", "key"]
  private static let csvExtensions: Set<String> = ["csv", "tsv"]
  private static let audioExtensions: Set<String> = ["mp3", "wav", "flac", "aac", "m4a", "ogg", "opus", "aiff", "aif", "wma"]
  private static let videoExtensions: Set<String> = ["mp4", "mov", "webm", "mkv", "avi", "m4v"]
  private static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "heic", "avif", "icns"]
  private static let archiveExtensions: Set<String> = ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz"]
  private static let fontExtensions: Set<String> = ["ttf", "otf", "woff", "woff2"]
  private static let databaseExtensions: Set<String> = ["db", "sqlite", "sqlite3", "mdb"]
  private static let packageExtensions: Set<String> = ["dmg", "pkg", "exe", "msi", "appimage", "deb", "rpm", "apk"]
  private static let plainTextFileExtensions: Set<String> = ["txt", "log"]

  // Precompiled high-confidence structural language patterns (§18.1 — never misclassify prose).
  private static let reShebangBash = try? NSRegularExpression(pattern: #"^#![^\n]*(?:bash|/sh\b)"#, options: [.anchorsMatchLines])
  private static let reShebangZsh = try? NSRegularExpression(pattern: #"^#![^\n]*zsh\b"#, options: [.anchorsMatchLines])
  private static let reShebangFish = try? NSRegularExpression(pattern: #"^#![^\n]*fish\b"#, options: [.anchorsMatchLines])
  private static let reShebangPython = try? NSRegularExpression(pattern: #"^#![^\n]*python"#, options: [.anchorsMatchLines])
  private static let rePHP = try? NSRegularExpression(pattern: #"^\s*<\?php\b|\bnamespace\s+\w+\\\w+"#, options: [])
  private static let reGoPkg = try? NSRegularExpression(pattern: #"^\s*package\s+\w+"#, options: [.anchorsMatchLines])
  private static let reGoFunc = try? NSRegularExpression(pattern: #"\bfunc\s+(?:\([^)]+\)\s*)?\w+\s*\("#, options: [])
  private static let reRust = try? NSRegularExpression(pattern: #"\b(?:pub\s+)?fn\s+\w+\s*\(|\buse\s+\w+::"#, options: [])
  private static let reSQL = try? NSRegularExpression(pattern: #"\b(?:SELECT\s+.+\s+FROM\s+\w+|INSERT\s+INTO\s+\w+|CREATE\s+TABLE\s+\w+|UPDATE\s+\w+\s+SET\s+\w+)\b"#, options: [.caseInsensitive, .dotMatchesLineSeparators])
  private static let rePython = try? NSRegularExpression(pattern: #"^\s*(?:async\s+)?def\s+\w+\s*\(|^\s*from\s+[A-Za-z0-9_.]+\s+import\s+[A-Za-z0-9_*]+"#, options: [.anchorsMatchLines])
  private static let reShell = try? NSRegularExpression(pattern: #"^\s*(?:set\s+-[euo]+|export\s+[A-Z_][A-Z0-9_]*=|for\s+\w+\s+in\s+.+;\s*do\b)"#, options: [.anchorsMatchLines])
  private static let reSwift = try? NSRegularExpression(pattern: #"^\s*import\s+(?:AppKit|Foundation|SwiftUI|UIKit|CoreGraphics|QuartzCore)\b|^\s*(?:final\s+|public\s+|private\s+|internal\s+)?(?:struct|class|enum|protocol)\s+[A-Z]\w*[^{]*\{|^\s*(?:public\s+|private\s+|override\s+|static\s+)?func\s+\w+\s*\([^)]*\)\s*(?:->|\{)"#, options: [.anchorsMatchLines])
  private static let reTS = try? NSRegularExpression(pattern: #"\b(?:interface\s+[A-Z]\w*\s*\{|type\s+[A-Z]\w*\s*=)|\b\w+\s*:\s*(?:string|number|boolean|Promise<)\b"#, options: [])
  private static let reJS = try? NSRegularExpression(pattern: #"^\s*(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(|^\s*(?:export\s+)?(?:const|let)\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|\{|\[|new\s+)"#, options: [.anchorsMatchLines])
  private static let reCSS = try? NSRegularExpression(pattern: #"^\s*(?:transition|background|color|display|font-size|will-change|grid-template-columns|margin|padding)\s*:\s*[^;\n]+;"#, options: [.anchorsMatchLines])
  private static let reSVG = try? NSRegularExpression(pattern: #"^\s*<svg\b"#, options: [.caseInsensitive])
  private static let reHTML = try? NSRegularExpression(pattern: #"^\s*(?:<!doctype\s+html|<html\b)"#, options: [.caseInsensitive])
  private static let reXML = try? NSRegularExpression(pattern: #"^\s*<\?xml\b"#, options: [.caseInsensitive])
  private static let reMarkdownHeading = try? NSRegularExpression(pattern: #"^\s*#\s+\S"#, options: [.anchorsMatchLines])
  private static let reMarkdownSecondary = try? NSRegularExpression(pattern: #"\n\s*(?:##\s|\*\*|```)"#, options: [])
  private static let reCInclude = try? NSRegularExpression(pattern: #"^\s*#include\s*<[^>]+>"#, options: [.anchorsMatchLines])
  private static let reCPP = try? NSRegularExpression(pattern: #"\bstd::|\bnamespace\s+\w+"#, options: [])
  private static let reYAMLKey = try? NSRegularExpression(pattern: #"^[a-zA-Z_][\w-]*:\s*$"#, options: [.anchorsMatchLines])
  private static let reYAMLIndent = try? NSRegularExpression(pattern: #"^\s{2,}[a-zA-Z_][\w-]*:\s+\S"#, options: [.anchorsMatchLines])
  private static let reJava = try? NSRegularExpression(pattern: #"^\s*public\s+(?:final\s+)?class\s+[A-Z]\w*\s*\{"#, options: [.anchorsMatchLines])
  private static let reCSharp = try? NSRegularExpression(pattern: #"^\s*using\s+System(?:\.\w+)*;|public\s+class\s+[A-Z]\w*.*\{\s*get;"#, options: [.anchorsMatchLines])
  private static let reKotlin = try? NSRegularExpression(pattern: #"^\s*data\s+class\s+[A-Z]\w*\s*\(|^\s*fun\s+\w+\s*\([^)]*\)\s*(?:=|\{)"#, options: [.anchorsMatchLines])
  private static let reRuby = try? NSRegularExpression(pattern: #"^\s*def\s+\w+(?:\([^)]*\))?\s*\n[\s\S]*\n\s*end\s*$"#, options: [.anchorsMatchLines])

  private init() {}

  // MARK: User Overrides (§18.1 / A60)

  func setLanguageOverride(itemID: String, language: String) {
    let normalized = normalizeLanguageID(language)
    userOverrides[itemID] = OverrideEntry(family: .code, language: normalized)
  }

  func setFamilyOverride(itemID: String, family: LumenContentFamily, language: String? = nil) {
    userOverrides[itemID] = OverrideEntry(family: family, language: language.map { normalizeLanguageID($0) })
  }

  func clearOverride(itemID: String) {
    userOverrides.removeValue(forKey: itemID)
  }

  func normalizeLanguageID(_ raw: String) -> String {
    let lower = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if let alias = Self.languageAliases[lower] { return alias }
    if let ext = Self.extensionToLanguage[lower] { return ext }
    if Self.languages[lower] != nil { return lower }
    return "unknown"
  }

  func languageDescriptor(for langID: String) -> LumenLanguageDescriptor {
    let norm = normalizeLanguageID(langID)
    return Self.languages[norm] ?? Self.languages["unknown"]!
  }

  func languageDisplayName(_ langID: String) -> String {
    languageDescriptor(for: langID).displayName
  }

  // MARK: Primary Resolution APIs

  func identity(for item: LumenClipboardItem) -> LumenContentIdentity {
    // 1. User-confirmed override takes top priority (§18.1)
    if let userOverride = userOverrides[item.id] {
      if userOverride.family == .code {
        return makeCodeIdentity(language: userOverride.language ?? "unknown", confidence: .confirmed, availability: .ready)
      }
      if userOverride.family == .text {
        return makeTextIdentity(confidence: .confirmed)
      }
    }

    // 2. Server canonical kind + MIME + file metadata
    let normalizedKind = item.kind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let mime = item.mime.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

    switch normalizedKind {
    case "image":
      return makeIdentity(
        family: .image,
        subtype: imageSubtype(fromMIME: mime, path: item.primaryFilePath),
        language: nil,
        confidence: .confirmed,
        glyphID: "image",
        displayName: "图片",
        category: .image,
        rendererID: "native.image",
        availability: item.materialized ? .ready : .loading,
        colorHex: "#488d9a"
      )

    case "link":
      return makeIdentity(
        family: .link,
        subtype: "url",
        language: nil,
        confidence: .confirmed,
        glyphID: "link",
        displayName: "链接",
        category: .link,
        rendererID: "native.text",
        availability: .ready,
        colorHex: "#368e9c"
      )

    case "file":
      if item.files.count > 1 {
        return identity(forFileCollection: item.files, materialized: item.materialized)
      }
      if let path = item.primaryFilePath {
        return identity(forFilePath: path, mime: mime, materialized: item.materialized)
      }
      if !mime.isEmpty {
        return identity(forMIMEOnly: mime, materialized: item.materialized)
      }
      return makeUnknownFileIdentity(availability: item.materialized ? .unsupported : .missing)

    default:
      // Text / rich text clipboard item
      if mime.hasPrefix("image/") && mime != "image/svg+xml" {
        return makeIdentity(
          family: .image, subtype: imageSubtype(fromMIME: mime, path: nil), language: nil,
          confidence: .confirmed, glyphID: "image", displayName: "图片",
          category: .image, rendererID: "native.image", availability: .ready, colorHex: "#488d9a"
        )
      }
      let trimmed = item.effectiveText.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty && LumenColorMath.parseAnyColor(trimmed) != nil {
        return makeIdentity(
          family: .color,
          subtype: trimmed.hasPrefix("#") ? "hex" : "color",
          language: nil,
          confidence: .confirmed,
          glyphID: "color",
          displayName: "颜色",
          category: .color,
          rendererID: "native.color",
          availability: .ready,
          colorHex: "#8e73ba"
        )
      }
      if isSingleURL(trimmed) {
        return makeIdentity(
          family: .link,
          subtype: "url",
          language: nil,
          confidence: .confirmed,
          glyphID: "link",
          displayName: "链接",
          category: .link,
          rendererID: "native.text",
          availability: .ready,
          colorHex: "#368e9c"
        )
      }
      if let lang = detectHighConfidenceCodeLanguage(content: trimmed) {
        return makeCodeIdentity(language: lang, confidence: .probable, availability: .ready)
      }
      return makeTextIdentity(confidence: .confirmed)
    }
  }

  func identity(forFileCollection paths: [String], materialized: Bool = true) -> LumenContentIdentity {
    let clean = paths.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    guard clean.count > 1 else {
      if let only = clean.first {
        return identity(forFilePath: only, mime: "", materialized: materialized)
      }
      return makeUnknownFileIdentity(availability: .missing)
    }
    let children = clean.map { identity(forFilePath: $0, mime: "", materialized: materialized) }
    if children.allSatisfy({ $0.family == .audio }) {
      return makeIdentity(
        family: .collection,
        subtype: "musicgroup",
        language: nil,
        confidence: .confirmed,
        glyphID: "musicgroup",
        displayName: "音频集合",
        category: .audio,
        rendererID: "native.audio",
        availability: materialized ? .ready : .loading,
        colorHex: "#936ac3"
      )
    }
    if children.allSatisfy({ $0.family == .image }) {
      return makeIdentity(
        family: .collection,
        subtype: "imagegroup",
        language: nil,
        confidence: .confirmed,
        glyphID: "image",
        displayName: "图片集合",
        category: .image,
        rendererID: "native.image",
        availability: materialized ? .ready : .loading,
        colorHex: "#488d9a"
      )
    }
    if children.allSatisfy({ $0.family == .video }) {
      return makeIdentity(
        family: .collection,
        subtype: "videogroup",
        language: nil,
        confidence: .confirmed,
        glyphID: "video",
        displayName: "视频集合",
        category: .video,
        rendererID: "native.video",
        availability: materialized ? .ready : .loading,
        colorHex: "#657dbf"
      )
    }
    return makeIdentity(
      family: .collection,
      subtype: "batch",
      language: nil,
      confidence: .confirmed,
      glyphID: "batch",
      displayName: "文件集合",
      category: .otherFile,
      rendererID: "native.collection",
      availability: materialized ? .ready : .loading,
      colorHex: "#7c79b5"
    )
  }

  func identity(forFilePath path: String, mime rawMIME: String = "", materialized: Bool = true) -> LumenContentIdentity {
    let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
    let mime = rawMIME.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let url = URL(fileURLWithPath: trimmed)
    let fileName = url.lastPathComponent.lowercased()
    let ext = url.pathExtension.lowercased()

    // Check directory first
    var isDir: ObjCBool = false
    let existsOnDisk = FileManager.default.fileExists(atPath: trimmed, isDirectory: &isDir)
    if trimmed.hasSuffix("/") || (existsOnDisk && isDir.boolValue) {
      return makeIdentity(
        family: .file,
        subtype: "folder",
        language: nil,
        confidence: .confirmed,
        glyphID: "folder",
        displayName: "文件夹",
        category: .otherFile,
        rendererID: "native.file",
        availability: existsOnDisk ? .unsupported : .missing,
        colorHex: "#bd9652"
      )
    }

    let availability: LumenPreviewAvailability = materialized ? .ready : .loading

    // Special extensionless filenames (§18.1)
    if fileName == "dockerfile" {
      return makeCodeIdentity(language: "docker", confidence: .confirmed, availability: availability)
    }
    if fileName == "makefile" || fileName == "gnumakefile" {
      return makeCodeIdentity(language: "make", confidence: .confirmed, availability: availability)
    }

    // MIME + Extension classification for Documents (§3.2, §18.2)
    if Self.pdfExtensions.contains(ext) || mime == "application/pdf" {
      return makeIdentity(
        family: .document, subtype: "pdf", language: nil, confidence: .confirmed,
        glyphID: "pdf", displayName: "PDF", category: .document,
        rendererID: "native.pdfkit", availability: availability, colorHex: "#c6616c"
      )
    }
    if Self.wordExtensions.contains(ext)
      || mime == "application/msword"
      || mime == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      || mime == "application/vnd.oasis.opendocument.text"
      || mime == "application/rtf" {
      return makeIdentity(
        family: .document, subtype: ext.isEmpty ? "docx" : ext, language: nil, confidence: .confirmed,
        glyphID: "doc", displayName: "Word 文档", category: .document,
        rendererID: ext == "docx" ? "native.office" : nil,
        availability: ext == "docx" ? availability : .unsupported,
        colorHex: "#4b7fbd"
      )
    }
    if Self.sheetExtensions.contains(ext)
      || mime == "application/vnd.ms-excel"
      || mime == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      || mime == "application/vnd.oasis.opendocument.spreadsheet" {
      return makeIdentity(
        family: .document, subtype: ext.isEmpty ? "xlsx" : ext, language: nil, confidence: .confirmed,
        glyphID: "sheet", displayName: "Excel 工作簿", category: .document,
        rendererID: ext == "xlsx" ? "native.office" : nil,
        availability: ext == "xlsx" ? availability : .unsupported,
        colorHex: "#398c6e"
      )
    }
    if Self.slideExtensions.contains(ext)
      || mime == "application/vnd.ms-powerpoint"
      || mime == "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      || mime == "application/vnd.oasis.opendocument.presentation" {
      return makeIdentity(
        family: .document, subtype: ext.isEmpty ? "pptx" : ext, language: nil, confidence: .confirmed,
        glyphID: "slides", displayName: "演示文稿", category: .document,
        rendererID: ext == "pptx" ? "native.office" : nil,
        availability: ext == "pptx" ? availability : .unsupported,
        colorHex: "#bc7658"
      )
    }
    if Self.csvExtensions.contains(ext) || mime == "text/csv" || mime == "text/tab-separated-values" {
      return makeIdentity(
        family: .document, subtype: ext.isEmpty ? "csv" : ext, language: "csv", confidence: .confirmed,
        glyphID: "csv", displayName: "CSV 表格", category: .document,
        rendererID: "native.text", availability: availability, colorHex: "#4b957f"
      )
    }

    // Audio
    if Self.audioExtensions.contains(ext) || mime.hasPrefix("audio/") {
      return makeIdentity(
        family: .audio, subtype: ext.isEmpty ? "audio" : ext, language: nil, confidence: .confirmed,
        glyphID: "audio", displayName: "音频", category: .audio,
        rendererID: "native.audio", availability: availability, colorHex: "#8a65bd"
      )
    }

    // Video
    if Self.videoExtensions.contains(ext) || mime.hasPrefix("video/") {
      return makeIdentity(
        family: .video, subtype: ext.isEmpty ? "video" : ext, language: nil, confidence: .confirmed,
        glyphID: "video", displayName: "视频", category: .video,
        rendererID: "native.video", availability: availability, colorHex: "#657dbf"
      )
    }

    // SVG is treated as code/markup in V14/V15
    if ext == "svg" || mime == "image/svg+xml" {
      return makeCodeIdentity(language: "svg", confidence: .confirmed, availability: availability)
    }

    // Raster Images
    if Self.imageExtensions.contains(ext) || mime.hasPrefix("image/") {
      return makeIdentity(
        family: .image, subtype: ext.isEmpty ? "image" : ext, language: nil, confidence: .confirmed,
        glyphID: "image", displayName: "图片", category: .image,
        rendererID: "native.image", availability: availability, colorHex: "#488d9a"
      )
    }

    // Code & Markup files
    if let langID = Self.extensionToLanguage[ext] {
      return makeCodeIdentity(language: langID, confidence: .confirmed, availability: availability)
    }

    // Archives -> Other File (§3.2, §18.2)
    if Self.archiveExtensions.contains(ext)
      || mime == "application/zip"
      || mime == "application/x-zip-compressed"
      || mime == "application/x-rar-compressed"
      || mime == "application/x-7z-compressed"
      || mime == "application/x-tar"
      || mime == "application/gzip" {
      return makeIdentity(
        family: .archive, subtype: ext.isEmpty ? "archive" : ext, language: nil, confidence: .confirmed,
        glyphID: "archive", displayName: ext == "zip" ? "ZIP 压缩包" : "压缩包", category: .otherFile,
        rendererID: "native.file", availability: ext == "zip" ? availability : .unsupported, colorHex: "#b38a4f"
      )
    }

    // Fonts, Databases, Packages -> Other File with dedicated semantic glyphs (§18.2)
    if Self.fontExtensions.contains(ext) || mime.hasPrefix("font/") {
      return makeIdentity(
        family: .file, subtype: "font", language: nil, confidence: .confirmed,
        glyphID: "font", displayName: "字体", category: .otherFile,
        rendererID: "native.file", availability: .unsupported, colorHex: "#7b79b5"
      )
    }
    if Self.databaseExtensions.contains(ext) || mime == "application/x-sqlite3" {
      return makeIdentity(
        family: .file, subtype: "database", language: nil, confidence: .confirmed,
        glyphID: "database", displayName: "数据库", category: .otherFile,
        rendererID: "native.file", availability: .unsupported, colorHex: "#688ca4"
      )
    }
    if Self.packageExtensions.contains(ext) {
      return makeIdentity(
        family: .file, subtype: "package", language: nil, confidence: .confirmed,
        glyphID: "package", displayName: "安装包", category: .otherFile,
        rendererID: "native.file", availability: .unsupported, colorHex: "#6d8bb1"
      )
    }

    // Plain text files
    if Self.plainTextFileExtensions.contains(ext) || mime == "text/plain" {
      return makeTextIdentity(confidence: .confirmed)
    }

    return makeUnknownFileIdentity(availability: materialized ? .unsupported : .missing)
  }

  func identity(forCategory category: LumenLogicalCategory) -> LumenContentIdentity {
    switch category {
    case .all:
      return makeIdentity(
        family: .collection, subtype: "all", language: nil, confidence: .confirmed,
        glyphID: "all", displayName: "全部", category: .all,
        rendererID: nil, availability: .ready, colorHex: "#5273cf"
      )
    case .text:
      return makeTextIdentity(confidence: .confirmed)
    case .code:
      return makeCodeIdentity(language: "unknown", confidence: .confirmed, availability: .ready)
    case .link:
      return makeIdentity(
        family: .link, subtype: "url", language: nil, confidence: .confirmed,
        glyphID: "link", displayName: "链接", category: .link,
        rendererID: "native.text", availability: .ready, colorHex: "#368e9c"
      )
    case .image:
      return makeIdentity(
        family: .image, subtype: "image", language: nil, confidence: .confirmed,
        glyphID: "image", displayName: "图片", category: .image,
        rendererID: "native.image", availability: .ready, colorHex: "#488d9a"
      )
    case .color:
      return makeIdentity(
        family: .color, subtype: "hex", language: nil, confidence: .confirmed,
        glyphID: "color", displayName: "颜色", category: .color,
        rendererID: "native.color", availability: .ready, colorHex: "#8e73ba"
      )
    case .document:
      return makeIdentity(
        family: .document, subtype: "doc", language: nil, confidence: .confirmed,
        glyphID: "doc", displayName: "文档", category: .document,
        rendererID: "native.office", availability: .ready, colorHex: "#4b7fbd"
      )
    case .audio:
      return makeIdentity(
        family: .audio, subtype: "audio", language: nil, confidence: .confirmed,
        glyphID: "audio", displayName: "音频", category: .audio,
        rendererID: "native.audio", availability: .ready, colorHex: "#8a65bd"
      )
    case .video:
      return makeIdentity(
        family: .video, subtype: "video", language: nil, confidence: .confirmed,
        glyphID: "video", displayName: "视频", category: .video,
        rendererID: "native.video", availability: .ready, colorHex: "#657dbf"
      )
    case .otherFile:
      return makeIdentity(
        family: .collection, subtype: "batch", language: nil, confidence: .confirmed,
        glyphID: "batch", displayName: "其他文件", category: .otherFile,
        rendererID: "native.file", availability: .ready, colorHex: "#7c79b5"
      )
    }
  }

  /// Strict structural code detection for clipboard text without file extension.
  /// Returns `nil` for plain prose or ambiguous snippets so normal text is never misclassified as code (§18.1).
  func detectHighConfidenceCodeLanguage(content raw: String) -> String? {
    let sample = String(raw.prefix(12_000))
    let trimmed = sample.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.count >= 6 else { return nil }

    let hasNewline = trimmed.contains("\n")

    // Single-line or multi-line unambiguous headers / complete structured formats
    if matches(Self.reShebangBash, in: trimmed) { return "sh" }
    if matches(Self.reShebangZsh, in: trimmed) { return "zsh" }
    if matches(Self.reShebangFish, in: trimmed) { return "fish" }
    if matches(Self.reShebangPython, in: trimmed) { return "py" }
    if matches(Self.rePHP, in: trimmed) { return "php" }
    if matches(Self.reSVG, in: trimmed) { return "svg" }
    if matches(Self.reHTML, in: trimmed) { return "html" }
    if matches(Self.reXML, in: trimmed) { return "xml" }
    if matches(Self.reSQL, in: trimmed) { return "sql" }

    // Valid JSON object or array
    if (trimmed.hasPrefix("{") && trimmed.hasSuffix("}")) || (trimmed.hasPrefix("[") && trimmed.hasSuffix("]")) {
      if let data = trimmed.data(using: .utf8),
         (try? JSONSerialization.jsonObject(with: data)) != nil {
        return "json"
      }
    }

    // Require multi-line structure for all remaining heuristics so chat messages
    // containing words like "return", "go", "select", "let" stay plain text.
    guard hasNewline else { return nil }

    if matches(Self.reCInclude, in: trimmed) {
      return matches(Self.reCPP, in: trimmed) ? "cpp" : "c"
    }
    if matches(Self.reGoPkg, in: trimmed) && matches(Self.reGoFunc, in: trimmed) { return "go" }
    if matches(Self.reRust, in: trimmed) { return "rs" }
    if matches(Self.reSwift, in: trimmed) { return "swift" }
    if matches(Self.rePython, in: trimmed) { return "py" }
    if matches(Self.reShell, in: trimmed) { return "sh" }
    if matches(Self.reKotlin, in: trimmed) { return "kt" }
    if matches(Self.reCSharp, in: trimmed) { return "cs" }
    if matches(Self.reJava, in: trimmed) { return "java" }
    if matches(Self.reRuby, in: trimmed) { return "rb" }
    if matches(Self.reTS, in: trimmed) { return "ts" }
    if matches(Self.reJS, in: trimmed) { return "js" }
    if matches(Self.reCSS, in: trimmed) { return "css" }
    if matches(Self.reMarkdownHeading, in: trimmed) && matches(Self.reMarkdownSecondary, in: trimmed) { return "md" }
    if matches(Self.reYAMLKey, in: trimmed) && matches(Self.reYAMLIndent, in: trimmed) { return "yaml" }

    return nil
  }

  /// Resolves language for an already-known code item or file (returns `"unknown"`, never defaults to JS).
  func resolveCodeLanguage(fileName: String?, content: String) -> String {
    if let fileName {
      let lower = URL(fileURLWithPath: fileName).lastPathComponent.lowercased()
      if lower == "dockerfile" { return "docker" }
      if lower == "makefile" || lower == "gnumakefile" { return "make" }
      let ext = URL(fileURLWithPath: fileName).pathExtension.lowercased()
      if let mapped = Self.extensionToLanguage[ext] {
        return mapped
      }
    }
    return detectHighConfidenceCodeLanguage(content: content) ?? "unknown"
  }

  // MARK: Private Builders

  private func identity(forMIMEOnly mime: String, materialized: Bool) -> LumenContentIdentity {
    let avail: LumenPreviewAvailability = materialized ? .ready : .loading
    if mime == "application/pdf" {
      return makeIdentity(family: .document, subtype: "pdf", language: nil, confidence: .confirmed, glyphID: "pdf", displayName: "PDF", category: .document, rendererID: "native.pdfkit", availability: avail, colorHex: "#c6616c")
    }
    if mime.hasPrefix("audio/") {
      return makeIdentity(family: .audio, subtype: "audio", language: nil, confidence: .confirmed, glyphID: "audio", displayName: "音频", category: .audio, rendererID: "native.audio", availability: avail, colorHex: "#8a65bd")
    }
    if mime.hasPrefix("video/") {
      return makeIdentity(family: .video, subtype: "video", language: nil, confidence: .confirmed, glyphID: "video", displayName: "视频", category: .video, rendererID: "native.video", availability: avail, colorHex: "#657dbf")
    }
    if mime.hasPrefix("image/") {
      return makeIdentity(family: .image, subtype: imageSubtype(fromMIME: mime, path: nil), language: nil, confidence: .confirmed, glyphID: "image", displayName: "图片", category: .image, rendererID: "native.image", availability: avail, colorHex: "#488d9a")
    }
    return makeUnknownFileIdentity(availability: materialized ? .unsupported : .missing)
  }

  private func makeTextIdentity(confidence: LumenIdentityConfidence) -> LumenContentIdentity {
    makeIdentity(
      family: .text, subtype: "text", language: nil, confidence: confidence,
      glyphID: "text", displayName: "文本", category: .text,
      rendererID: "native.text", availability: .ready, colorHex: "#777eaf"
    )
  }

  private func makeCodeIdentity(language: String, confidence: LumenIdentityConfidence, availability: LumenPreviewAvailability) -> LumenContentIdentity {
    let desc = languageDescriptor(for: language)
    return makeIdentity(
      family: .code, subtype: desc.id, language: desc.id, confidence: desc.id == "unknown" ? .unknown : confidence,
      glyphID: "lang-\(desc.id)", displayName: desc.displayName, category: .code,
      rendererID: "native.code", availability: availability, colorHex: desc.colorHex
    )
  }

  private func makeUnknownFileIdentity(availability: LumenPreviewAvailability) -> LumenContentIdentity {
    makeIdentity(
      family: .file, subtype: "unknown", language: nil, confidence: .unknown,
      glyphID: "unknown", displayName: "未知文件", category: .otherFile,
      rendererID: "native.file", availability: availability, colorHex: "#8592a6"
    )
  }

  private func makeIdentity(
    family: LumenContentFamily,
    subtype: String,
    language: String?,
    confidence: LumenIdentityConfidence,
    glyphID: String,
    displayName: String,
    category: LumenLogicalCategory,
    rendererID: String?,
    availability: LumenPreviewAvailability,
    colorHex: String
  ) -> LumenContentIdentity {
    LumenContentIdentity(
      family: family,
      subtype: subtype,
      language: language,
      confidence: confidence,
      glyphID: glyphID,
      displayName: displayName,
      logicalCategory: category,
      rendererID: rendererID,
      previewAvailability: availability,
      lightColorHex: colorHex
    )
  }

  private func imageSubtype(fromMIME mime: String, path: String?) -> String {
    if let path {
      let ext = URL(fileURLWithPath: path).pathExtension.lowercased()
      if !ext.isEmpty { return ext }
    }
    if mime.hasPrefix("image/") {
      return String(mime.dropFirst("image/".count))
    }
    return "png"
  }

  private func isSingleURL(_ text: String) -> Bool {
    guard !text.isEmpty,
          !text.contains(where: { $0.isWhitespace || $0.isNewline }),
          (text.lowercased().hasPrefix("http://") || text.lowercased().hasPrefix("https://")),
          let url = URL(string: text),
          let host = url.host,
          !host.isEmpty else {
      return false
    }
    return true
  }

  private func matches(_ regex: NSRegularExpression?, in text: String) -> Bool {
    guard let regex else { return false }
    let range = NSRange(location: 0, length: (text as NSString).length)
    return regex.firstMatch(in: text, options: [], range: range) != nil
  }
}

// MARK: - Pure CoreGraphics Vector Glyph Renderer (24×24 Grid, §13.1, §18.2, §19.1)

enum LumenActionGlyph {
  case orbitRemoveX   // 24-grid M7.25 7.25 16.75 16.75 M16.75 7.25 7.25 16.75, stroke 1.9
  case copy
  case check
  case trash
  case pin
  case pinFilled
  case edit
  case expand
  case restore
  case sidebar
  case inspector
  case list
  case grid
  case plus
  case search
  case settings
  case clock
  case all
  case sparkles
  case sun
  case moon
  case chevronLeft
  case chevronRight
  case externalLink
}

enum LumenVectorGlyphs {
  static func actionImage(_ glyph: LumenActionGlyph, size: CGFloat, color: NSColor? = nil, strokeWidth: CGFloat? = nil) -> NSImage {
    let img = NSImage(size: NSSize(width: size, height: size), flipped: true) { rect in
      guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
      let drawColor = color ?? NSColor.labelColor
      ctx.saveGState()
      let scale = min(rect.width, rect.height) / 24.0
      ctx.translateBy(x: (rect.width - 24 * scale) / 2, y: (rect.height - 24 * scale) / 2)
      ctx.scaleBy(x: scale, y: scale)
      ctx.setStrokeColor(drawColor.cgColor)
      ctx.setFillColor(drawColor.cgColor)
      ctx.setLineCap(.round)
      ctx.setLineJoin(.round)
      ctx.setLineWidth(strokeWidth ?? (glyph == .orbitRemoveX ? 1.9 : 1.65))
      drawAction(glyph, in: ctx)
      ctx.restoreGState()
      return true
    }
    img.isTemplate = (color == nil)
    return img
  }

  static func identityImage(for identity: LumenContentIdentity, size: CGFloat, isDark: Bool, overrideColor: NSColor? = nil) -> NSImage {
    let tint = overrideColor ?? identity.tintColor(isDark: isDark)
    let img = NSImage(size: NSSize(width: size, height: size), flipped: true) { rect in
      guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
      ctx.saveGState()
      let scale = min(rect.width, rect.height) / 24.0
      ctx.translateBy(x: (rect.width - 24 * scale) / 2, y: (rect.height - 24 * scale) / 2)
      ctx.scaleBy(x: scale, y: scale)
      ctx.setStrokeColor(tint.cgColor)
      ctx.setFillColor(tint.cgColor)
      ctx.setLineCap(.round)
      ctx.setLineJoin(.round)
      ctx.setLineWidth(1.6)
      drawIdentity(glyphID: identity.glyphID, tint: tint, in: ctx)
      ctx.restoreGState()
      return true
    }
    img.isTemplate = false
    return img
  }

  // MARK: Action Paths (V11/V15 unified 24-unit grid)

  private static func drawAction(_ glyph: LumenActionGlyph, in ctx: CGContext) {
    switch glyph {
    case .orbitRemoveX:
      ctx.move(to: CGPoint(x: 7.25, y: 7.25))
      ctx.addLine(to: CGPoint(x: 16.75, y: 16.75))
      ctx.move(to: CGPoint(x: 16.75, y: 7.25))
      ctx.addLine(to: CGPoint(x: 7.25, y: 16.75))
      ctx.strokePath()

    case .copy:
      let front = CGPath(roundedRect: CGRect(x: 8.25, y: 8.25, width: 11.5, height: 11.5), cornerWidth: 2.65, cornerHeight: 2.65, transform: nil)
      ctx.addPath(front)
      ctx.strokePath()
      ctx.move(to: CGPoint(x: 15.75, y: 5.6))
      ctx.addLine(to: CGPoint(x: 15.75, y: 5.2))
      ctx.addQuadCurve(to: CGPoint(x: 13.8, y: 3.25), control: CGPoint(x: 15.75, y: 3.25))
      ctx.addLine(to: CGPoint(x: 5.6, y: 3.25))
      ctx.addQuadCurve(to: CGPoint(x: 3.25, y: 5.6), control: CGPoint(x: 3.25, y: 3.25))
      ctx.addLine(to: CGPoint(x: 3.25, y: 13.8))
      ctx.addQuadCurve(to: CGPoint(x: 5.2, y: 15.75), control: CGPoint(x: 3.25, y: 15.75))
      ctx.addLine(to: CGPoint(x: 5.6, y: 15.75))
      ctx.strokePath()

    case .check:
      ctx.move(to: CGPoint(x: 5, y: 12.5))
      ctx.addLine(to: CGPoint(x: 9.5, y: 17))
      ctx.addLine(to: CGPoint(x: 19, y: 6.5))
      ctx.strokePath()

    case .trash:
      ctx.move(to: CGPoint(x: 4.75, y: 6.75))
      ctx.addLine(to: CGPoint(x: 19.25, y: 6.75))
      ctx.move(to: CGPoint(x: 9, y: 6.75))
      ctx.addLine(to: CGPoint(x: 9, y: 5.2))
      ctx.addQuadCurve(to: CGPoint(x: 10.75, y: 3.5), control: CGPoint(x: 9, y: 3.5))
      ctx.addLine(to: CGPoint(x: 13.25, y: 3.5))
      ctx.addQuadCurve(to: CGPoint(x: 15, y: 5.2), control: CGPoint(x: 15, y: 3.5))
      ctx.addLine(to: CGPoint(x: 15, y: 6.75))
      ctx.move(to: CGPoint(x: 6.35, y: 7.1))
      ctx.addLine(to: CGPoint(x: 7.1, y: 17.65))
      ctx.addQuadCurve(to: CGPoint(x: 9.95, y: 20.3), control: CGPoint(x: 7.3, y: 20.3))
      ctx.addLine(to: CGPoint(x: 14.05, y: 20.3))
      ctx.addQuadCurve(to: CGPoint(x: 16.9, y: 17.65), control: CGPoint(x: 16.7, y: 20.3))
      ctx.addLine(to: CGPoint(x: 17.65, y: 7.1))
      ctx.move(to: CGPoint(x: 10, y: 10.75))
      ctx.addLine(to: CGPoint(x: 10, y: 16.15))
      ctx.move(to: CGPoint(x: 14, y: 10.75))
      ctx.addLine(to: CGPoint(x: 14, y: 16.15))
      ctx.strokePath()

    case .pin, .pinFilled:
      let head = CGMutablePath()
      head.move(to: CGPoint(x: 14.4, y: 4.4))
      head.addLine(to: CGPoint(x: 19.6, y: 9.6))
      head.addLine(to: CGPoint(x: 16.3, y: 10.3))
      head.addLine(to: CGPoint(x: 13.5, y: 14.5))
      head.addLine(to: CGPoint(x: 11.6, y: 15.1))
      head.addLine(to: CGPoint(x: 8.9, y: 12.4))
      head.addLine(to: CGPoint(x: 6.2, y: 9.7))
      head.addLine(to: CGPoint(x: 6.8, y: 7.8))
      head.addLine(to: CGPoint(x: 11.0, y: 5.0))
      head.closeSubpath()
      if glyph == .pinFilled {
        ctx.saveGState()
        ctx.setAlpha(0.28)
        ctx.addPath(head)
        ctx.fillPath()
        ctx.restoreGState()
      }
      ctx.addPath(head)
      ctx.strokePath()
      ctx.move(to: CGPoint(x: 10.1, y: 13.9))
      ctx.addLine(to: CGPoint(x: 4.1, y: 19.9))
      ctx.strokePath()

    case .edit:
      ctx.move(to: CGPoint(x: 5, y: 15.9))
      ctx.addLine(to: CGPoint(x: 15.7, y: 5.2))
      ctx.addQuadCurve(to: CGPoint(x: 18.8, y: 5.2), control: CGPoint(x: 17.2, y: 3.7))
      ctx.addQuadCurve(to: CGPoint(x: 18.8, y: 8.3), control: CGPoint(x: 20.3, y: 6.8))
      ctx.addLine(to: CGPoint(x: 8.1, y: 19))
      ctx.addLine(to: CGPoint(x: 5, y: 19))
      ctx.closePath()
      ctx.move(to: CGPoint(x: 13.9, y: 7))
      ctx.addLine(to: CGPoint(x: 17, y: 10.1))
      ctx.move(to: CGPoint(x: 5, y: 19))
      ctx.addLine(to: CGPoint(x: 19, y: 19))
      ctx.strokePath()

    case .expand:
      ctx.move(to: CGPoint(x: 9, y: 4.25))
      ctx.addLine(to: CGPoint(x: 6.25, y: 4.25))
      ctx.addQuadCurve(to: CGPoint(x: 4.25, y: 6.25), control: CGPoint(x: 4.25, y: 4.25))
      ctx.addLine(to: CGPoint(x: 4.25, y: 9))

      ctx.move(to: CGPoint(x: 15, y: 4.25))
      ctx.addLine(to: CGPoint(x: 17.75, y: 4.25))
      ctx.addQuadCurve(to: CGPoint(x: 19.75, y: 6.25), control: CGPoint(x: 19.75, y: 4.25))
      ctx.addLine(to: CGPoint(x: 19.75, y: 9))

      ctx.move(to: CGPoint(x: 4.25, y: 15))
      ctx.addLine(to: CGPoint(x: 4.25, y: 17.75))
      ctx.addQuadCurve(to: CGPoint(x: 6.25, y: 19.75), control: CGPoint(x: 4.25, y: 19.75))
      ctx.addLine(to: CGPoint(x: 9, y: 19.75))

      ctx.move(to: CGPoint(x: 19.75, y: 15))
      ctx.addLine(to: CGPoint(x: 19.75, y: 17.75))
      ctx.addQuadCurve(to: CGPoint(x: 17.75, y: 19.75), control: CGPoint(x: 19.75, y: 19.75))
      ctx.addLine(to: CGPoint(x: 15, y: 19.75))
      ctx.strokePath()

    case .restore:
      ctx.move(to: CGPoint(x: 9, y: 4.5))
      ctx.addLine(to: CGPoint(x: 9, y: 7.5))
      ctx.addQuadCurve(to: CGPoint(x: 7.5, y: 9), control: CGPoint(x: 9, y: 9))
      ctx.addLine(to: CGPoint(x: 4.5, y: 9))

      ctx.move(to: CGPoint(x: 15, y: 4.5))
      ctx.addLine(to: CGPoint(x: 15, y: 7.5))
      ctx.addQuadCurve(to: CGPoint(x: 16.5, y: 9), control: CGPoint(x: 15, y: 9))
      ctx.addLine(to: CGPoint(x: 19.5, y: 9))

      ctx.move(to: CGPoint(x: 9, y: 19.5))
      ctx.addLine(to: CGPoint(x: 9, y: 16.5))
      ctx.addQuadCurve(to: CGPoint(x: 7.5, y: 15), control: CGPoint(x: 9, y: 15))
      ctx.addLine(to: CGPoint(x: 4.5, y: 15))

      ctx.move(to: CGPoint(x: 15, y: 19.5))
      ctx.addLine(to: CGPoint(x: 15, y: 16.5))
      ctx.addQuadCurve(to: CGPoint(x: 16.5, y: 15), control: CGPoint(x: 15, y: 15))
      ctx.addLine(to: CGPoint(x: 19.5, y: 15))
      ctx.strokePath()

    case .sidebar:
      ctx.addPath(CGPath(roundedRect: CGRect(x: 3.5, y: 4.5, width: 17, height: 15), cornerWidth: 2.5, cornerHeight: 2.5, transform: nil))
      ctx.move(to: CGPoint(x: 9.2, y: 4.5))
      ctx.addLine(to: CGPoint(x: 9.2, y: 19.5))
      ctx.strokePath()

    case .inspector:
      ctx.addPath(CGPath(roundedRect: CGRect(x: 3.5, y: 4.5, width: 17, height: 15), cornerWidth: 2.5, cornerHeight: 2.5, transform: nil))
      ctx.move(to: CGPoint(x: 14.8, y: 4.5))
      ctx.addLine(to: CGPoint(x: 14.8, y: 19.5))
      ctx.strokePath()

    case .list:
      ctx.move(to: CGPoint(x: 5, y: 6.5))
      ctx.addLine(to: CGPoint(x: 19, y: 6.5))
      ctx.move(to: CGPoint(x: 5, y: 12))
      ctx.addLine(to: CGPoint(x: 19, y: 12))
      ctx.move(to: CGPoint(x: 5, y: 17.5))
      ctx.addLine(to: CGPoint(x: 19, y: 17.5))
      ctx.strokePath()

    case .grid, .all:
      for rect in [
        CGRect(x: 3.8, y: 3.8, width: 6.8, height: 6.8),
        CGRect(x: 13.4, y: 3.8, width: 6.8, height: 6.8),
        CGRect(x: 3.8, y: 13.4, width: 6.8, height: 6.8),
        CGRect(x: 13.4, y: 13.4, width: 6.8, height: 6.8)
      ] {
        ctx.addPath(CGPath(roundedRect: rect, cornerWidth: 1.6, cornerHeight: 1.6, transform: nil))
      }
      ctx.strokePath()

    case .plus:
      ctx.move(to: CGPoint(x: 12, y: 5.5))
      ctx.addLine(to: CGPoint(x: 12, y: 18.5))
      ctx.move(to: CGPoint(x: 5.5, y: 12))
      ctx.addLine(to: CGPoint(x: 18.5, y: 12))
      ctx.strokePath()

    case .search:
      ctx.strokeEllipse(in: CGRect(x: 4.25, y: 4.25, width: 12.3, height: 12.3))
      ctx.move(to: CGPoint(x: 15, y: 15))
      ctx.addLine(to: CGPoint(x: 19.8, y: 19.8))
      ctx.strokePath()

    case .settings:
      ctx.strokeEllipse(in: CGRect(x: 8.8, y: 8.8, width: 6.4, height: 6.4))
      ctx.strokeEllipse(in: CGRect(x: 4.5, y: 4.5, width: 15, height: 15))
      for deg in stride(from: 0, to: 360, by: 45) {
        let rad = CGFloat(deg) * .pi / 180
        ctx.move(to: CGPoint(x: 12 + cos(rad) * 7.5, y: 12 + sin(rad) * 7.5))
        ctx.addLine(to: CGPoint(x: 12 + cos(rad) * 9.8, y: 12 + sin(rad) * 9.8))
      }
      ctx.strokePath()

    case .clock:
      ctx.strokeEllipse(in: CGRect(x: 3.5, y: 3.5, width: 17, height: 17))
      ctx.move(to: CGPoint(x: 12, y: 7))
      ctx.addLine(to: CGPoint(x: 12, y: 12))
      ctx.addLine(to: CGPoint(x: 15.2, y: 14.2))
      ctx.strokePath()

    case .sparkles:
      ctx.move(to: CGPoint(x: 12, y: 2.8))
      ctx.addLine(to: CGPoint(x: 14.2, y: 9.8))
      ctx.addLine(to: CGPoint(x: 21.2, y: 12))
      ctx.addLine(to: CGPoint(x: 14.2, y: 14.2))
      ctx.addLine(to: CGPoint(x: 12, y: 21.2))
      ctx.addLine(to: CGPoint(x: 9.8, y: 14.2))
      ctx.addLine(to: CGPoint(x: 2.8, y: 12))
      ctx.addLine(to: CGPoint(x: 9.8, y: 9.8))
      ctx.closePath()
      ctx.strokePath()

    case .sun:
      ctx.strokeEllipse(in: CGRect(x: 8, y: 8, width: 8, height: 8))
      for deg in stride(from: 0, to: 360, by: 45) {
        let rad = CGFloat(deg) * .pi / 180
        ctx.move(to: CGPoint(x: 12 + cos(rad) * 6.8, y: 12 + sin(rad) * 6.8))
        ctx.addLine(to: CGPoint(x: 12 + cos(rad) * 9.5, y: 12 + sin(rad) * 9.5))
      }
      ctx.strokePath()

    case .moon:
      ctx.addArc(center: CGPoint(x: 12.2, y: 12.2), radius: 7.5, startAngle: 0.45, endAngle: 4.55, clockwise: false)
      ctx.addQuadCurve(to: CGPoint(x: 19.0, y: 15.5), control: CGPoint(x: 9.6, y: 14.4))
      ctx.strokePath()

    case .chevronLeft:
      ctx.move(to: CGPoint(x: 14.5, y: 6.75))
      ctx.addLine(to: CGPoint(x: 9.25, y: 12))
      ctx.addLine(to: CGPoint(x: 14.5, y: 17.25))
      ctx.strokePath()

    case .chevronRight:
      ctx.move(to: CGPoint(x: 9.5, y: 6.75))
      ctx.addLine(to: CGPoint(x: 14.75, y: 12))
      ctx.addLine(to: CGPoint(x: 9.5, y: 17.25))
      ctx.strokePath()

    case .externalLink:
      ctx.move(to: CGPoint(x: 14, y: 5))
      ctx.addLine(to: CGPoint(x: 19, y: 5))
      ctx.addLine(to: CGPoint(x: 19, y: 10))
      ctx.move(to: CGPoint(x: 10.5, y: 13.5))
      ctx.addLine(to: CGPoint(x: 19, y: 5))
      ctx.move(to: CGPoint(x: 18, y: 13.5))
      ctx.addLine(to: CGPoint(x: 18, y: 18))
      ctx.addQuadCurve(to: CGPoint(x: 16, y: 20), control: CGPoint(x: 18, y: 20))
      ctx.addLine(to: CGPoint(x: 6, y: 20))
      ctx.addQuadCurve(to: CGPoint(x: 4, y: 18), control: CGPoint(x: 4, y: 20))
      ctx.addLine(to: CGPoint(x: 4, y: 8))
      ctx.addQuadCurve(to: CGPoint(x: 6, y: 6), control: CGPoint(x: 4, y: 6))
      ctx.addLine(to: CGPoint(x: 10.5, y: 6))
      ctx.strokePath()
    }
  }

  // MARK: Content Identity Glyphs (V14 §18.2)

  private static func drawIdentity(glyphID: String, tint: NSColor, in ctx: CGContext) {
    if glyphID.hasPrefix("lang-") {
      let langID = String(glyphID.dropFirst("lang-".count))
      drawLanguageGlyph(langID: langID, tint: tint, in: ctx)
      return
    }
    switch glyphID {
    case "all":
      drawAction(.all, in: ctx)

    case "text":
      // T-shaped text symbol (§18.2)
      ctx.move(to: CGPoint(x: 5, y: 6))
      ctx.addLine(to: CGPoint(x: 19, y: 6))
      ctx.move(to: CGPoint(x: 12, y: 6))
      ctx.addLine(to: CGPoint(x: 12, y: 19))
      ctx.move(to: CGPoint(x: 9, y: 19))
      ctx.addLine(to: CGPoint(x: 15, y: 19))
      ctx.move(to: CGPoint(x: 5, y: 6))
      ctx.addLine(to: CGPoint(x: 5, y: 8.8))
      ctx.move(to: CGPoint(x: 19, y: 6))
      ctx.addLine(to: CGPoint(x: 19, y: 8.8))
      ctx.strokePath()

    case "image":
      ctx.addPath(CGPath(roundedRect: CGRect(x: 3.5, y: 4.5, width: 17, height: 15), cornerWidth: 3, cornerHeight: 3, transform: nil))
      ctx.strokePath()
      ctx.strokeEllipse(in: CGRect(x: 7.6, y: 7.6, width: 2.8, height: 2.8))
      ctx.move(to: CGPoint(x: 4.2, y: 17))
      ctx.addLine(to: CGPoint(x: 9, y: 13))
      ctx.addLine(to: CGPoint(x: 12, y: 16))
      ctx.addLine(to: CGPoint(x: 16, y: 11))
      ctx.addLine(to: CGPoint(x: 19.8, y: 16))
      ctx.strokePath()

    case "color":
      ctx.move(to: CGPoint(x: 12, y: 3.7))
      ctx.addCurve(to: CGPoint(x: 18.6, y: 14.7), control1: CGPoint(x: 15.4, y: 8.5), control2: CGPoint(x: 18.6, y: 11.3))
      ctx.addArc(center: CGPoint(x: 12, y: 14.7), radius: 6.6, startAngle: 0, endAngle: .pi, clockwise: false)
      ctx.addCurve(to: CGPoint(x: 12, y: 3.7), control1: CGPoint(x: 5.4, y: 11.3), control2: CGPoint(x: 8.6, y: 8.5))
      ctx.move(to: CGPoint(x: 8.4, y: 15.5))
      ctx.addQuadCurve(to: CGPoint(x: 10.9, y: 18.2), control: CGPoint(x: 8.4, y: 17.8))
      ctx.strokePath()

    case "link":
      ctx.addPath(CGPath(roundedRect: CGRect(x: 3.5, y: 4, width: 17, height: 16), cornerWidth: 3.8, cornerHeight: 3.8, transform: nil))
      ctx.move(to: CGPoint(x: 4, y: 8.5))
      ctx.addLine(to: CGPoint(x: 20, y: 8.5))
      ctx.move(to: CGPoint(x: 10, y: 15.5))
      ctx.addLine(to: CGPoint(x: 15, y: 10.5))
      ctx.move(to: CGPoint(x: 11, y: 10.5))
      ctx.addLine(to: CGPoint(x: 15, y: 10.5))
      ctx.addLine(to: CGPoint(x: 15, y: 14.5))
      ctx.strokePath()
      ctx.fillEllipse(in: CGRect(x: 5.9, y: 5.7, width: 1.2, height: 1.2))

    case "pdf":
      drawFoldedPageOutline(in: ctx)
      ctx.setLineWidth(1.35)
      ctx.move(to: CGPoint(x: 8.4, y: 16.5))
      ctx.addCurve(to: CGPoint(x: 16.0, y: 14.0), control1: CGPoint(x: 13.1, y: 15.5), control2: CGPoint(x: 16.0, y: 15.3))
      ctx.addCurve(to: CGPoint(x: 11.1, y: 16.6), control1: CGPoint(x: 16.0, y: 12.6), control2: CGPoint(x: 12.3, y: 14.4))
      ctx.addCurve(to: CGPoint(x: 11.8, y: 8.0), control1: CGPoint(x: 10.0, y: 13.0), control2: CGPoint(x: 10.4, y: 8.1))
      ctx.addCurve(to: CGPoint(x: 15.2, y: 16.2), control1: CGPoint(x: 13.1, y: 8.0), control2: CGPoint(x: 12.2, y: 13.8))
      ctx.strokePath()

    case "doc":
      drawFoldedPageOutline(in: ctx)
      ctx.move(to: CGPoint(x: 8.5, y: 11))
      ctx.addLine(to: CGPoint(x: 15.5, y: 11))
      ctx.move(to: CGPoint(x: 8.5, y: 14))
      ctx.addLine(to: CGPoint(x: 15.5, y: 14))
      ctx.move(to: CGPoint(x: 8.5, y: 17))
      ctx.addLine(to: CGPoint(x: 13.5, y: 17))
      ctx.strokePath()

    case "sheet":
      ctx.addPath(CGPath(roundedRect: CGRect(x: 4, y: 4, width: 16, height: 16), cornerWidth: 2.5, cornerHeight: 2.5, transform: nil))
      ctx.move(to: CGPoint(x: 4, y: 9))
      ctx.addLine(to: CGPoint(x: 20, y: 9))
      ctx.move(to: CGPoint(x: 4, y: 14.5))
      ctx.addLine(to: CGPoint(x: 20, y: 14.5))
      ctx.move(to: CGPoint(x: 10, y: 9))
      ctx.addLine(to: CGPoint(x: 10, y: 20))
      ctx.move(to: CGPoint(x: 15, y: 9))
      ctx.addLine(to: CGPoint(x: 15, y: 20))
      ctx.strokePath()

    case "csv":
      ctx.addPath(CGPath(roundedRect: CGRect(x: 4, y: 4, width: 16, height: 16), cornerWidth: 2.5, cornerHeight: 2.5, transform: nil))
      ctx.move(to: CGPoint(x: 4, y: 9))
      ctx.addLine(to: CGPoint(x: 20, y: 9))
      ctx.move(to: CGPoint(x: 4, y: 14))
      ctx.addLine(to: CGPoint(x: 20, y: 14))
      ctx.move(to: CGPoint(x: 10, y: 9))
      ctx.addLine(to: CGPoint(x: 10, y: 20))
      ctx.move(to: CGPoint(x: 15, y: 9))
      ctx.addLine(to: CGPoint(x: 15, y: 20))
      ctx.move(to: CGPoint(x: 6.2, y: 6.5))
      ctx.addLine(to: CGPoint(x: 11.4, y: 6.5))
      ctx.strokePath()

    case "slides":
      ctx.addPath(CGPath(roundedRect: CGRect(x: 3.5, y: 4, width: 17, height: 13), cornerWidth: 2, cornerHeight: 2, transform: nil))
      ctx.move(to: CGPoint(x: 12, y: 17))
      ctx.addLine(to: CGPoint(x: 12, y: 21))
      ctx.move(to: CGPoint(x: 8, y: 21))
      ctx.addLine(to: CGPoint(x: 16, y: 21))
      ctx.move(to: CGPoint(x: 7, y: 13))
      ctx.addLine(to: CGPoint(x: 10, y: 10))
      ctx.addLine(to: CGPoint(x: 13, y: 12))
      ctx.addLine(to: CGPoint(x: 17, y: 7))
      ctx.strokePath()

    case "audio":
      ctx.move(to: CGPoint(x: 9, y: 17))
      ctx.addLine(to: CGPoint(x: 9, y: 6))
      ctx.addLine(to: CGPoint(x: 19, y: 4))
      ctx.addLine(to: CGPoint(x: 19, y: 15))
      ctx.move(to: CGPoint(x: 9, y: 9))
      ctx.addLine(to: CGPoint(x: 19, y: 7))
      ctx.strokePath()
      ctx.strokeEllipse(in: CGRect(x: 3.8, y: 15.5, width: 5.2, height: 4.0))
      ctx.strokeEllipse(in: CGRect(x: 13.8, y: 13.5, width: 5.2, height: 4.0))

    case "musicgroup":
      ctx.move(to: CGPoint(x: 7, y: 16))
      ctx.addLine(to: CGPoint(x: 7, y: 6))
      ctx.addLine(to: CGPoint(x: 16, y: 4))
      ctx.addLine(to: CGPoint(x: 16, y: 14))
      ctx.move(to: CGPoint(x: 7, y: 9))
      ctx.addLine(to: CGPoint(x: 16, y: 7))
      ctx.move(to: CGPoint(x: 20, y: 8))
      ctx.addLine(to: CGPoint(x: 20, y: 17))
      ctx.addQuadCurve(to: CGPoint(x: 16, y: 21), control: CGPoint(x: 20, y: 21))
      ctx.addLine(to: CGPoint(x: 11, y: 21))
      ctx.strokePath()
      ctx.strokeEllipse(in: CGRect(x: 2.6, y: 14.7, width: 4.4, height: 3.4))
      ctx.strokeEllipse(in: CGRect(x: 11.6, y: 12.7, width: 4.4, height: 3.4))

    case "video":
      ctx.addPath(CGPath(roundedRect: CGRect(x: 3.5, y: 5, width: 17, height: 14), cornerWidth: 3, cornerHeight: 3, transform: nil))
      ctx.strokePath()
      ctx.move(to: CGPoint(x: 10, y: 9))
      ctx.addLine(to: CGPoint(x: 15.4, y: 12))
      ctx.addLine(to: CGPoint(x: 10, y: 15))
      ctx.closePath()
      ctx.fillPath()

    case "batch":
      ctx.addPath(CGPath(roundedRect: CGRect(x: 7, y: 3.5, width: 13, height: 15), cornerWidth: 2.5, cornerHeight: 2.5, transform: nil))
      ctx.move(to: CGPoint(x: 4, y: 7.5))
      ctx.addLine(to: CGPoint(x: 4, y: 19))
      ctx.addQuadCurve(to: CGPoint(x: 6, y: 21), control: CGPoint(x: 4, y: 21))
      ctx.addLine(to: CGPoint(x: 16, y: 21))
      ctx.move(to: CGPoint(x: 10, y: 8))
      ctx.addLine(to: CGPoint(x: 17, y: 8))
      ctx.move(to: CGPoint(x: 10, y: 12))
      ctx.addLine(to: CGPoint(x: 15, y: 12))
      ctx.strokePath()

    case "archive":
      ctx.addPath(CGPath(roundedRect: CGRect(x: 4, y: 4, width: 16, height: 16), cornerWidth: 3, cornerHeight: 3, transform: nil))
      ctx.move(to: CGPoint(x: 11, y: 4.5))
      ctx.addLine(to: CGPoint(x: 11, y: 7))
      ctx.addLine(to: CGPoint(x: 13, y: 7))
      ctx.addLine(to: CGPoint(x: 13, y: 10))
      ctx.addLine(to: CGPoint(x: 11, y: 10))
      ctx.addLine(to: CGPoint(x: 11, y: 13))
      ctx.addLine(to: CGPoint(x: 13, y: 13))
      ctx.addLine(to: CGPoint(x: 13, y: 15.5))
      ctx.addRect(CGRect(x: 10, y: 15.5, width: 4, height: 2.4))
      ctx.strokePath()

    case "folder":
      ctx.move(to: CGPoint(x: 3.5, y: 8))
      ctx.addLine(to: CGPoint(x: 3.5, y: 6.5))
      ctx.addQuadCurve(to: CGPoint(x: 5.5, y: 4.5), control: CGPoint(x: 3.5, y: 4.5))
      ctx.addLine(to: CGPoint(x: 10, y: 4.5))
      ctx.addLine(to: CGPoint(x: 12, y: 6.5))
      ctx.addLine(to: CGPoint(x: 18.5, y: 6.5))
      ctx.addQuadCurve(to: CGPoint(x: 20.5, y: 8.5), control: CGPoint(x: 20.5, y: 6.5))
      ctx.addLine(to: CGPoint(x: 20.5, y: 18))
      ctx.addQuadCurve(to: CGPoint(x: 18.5, y: 20), control: CGPoint(x: 20.5, y: 20))
      ctx.addLine(to: CGPoint(x: 5.5, y: 20))
      ctx.addQuadCurve(to: CGPoint(x: 3.5, y: 18), control: CGPoint(x: 3.5, y: 20))
      ctx.closePath()
      ctx.move(to: CGPoint(x: 4, y: 10))
      ctx.addLine(to: CGPoint(x: 20, y: 10))
      ctx.strokePath()

    case "font":
      ctx.move(to: CGPoint(x: 4, y: 19))
      ctx.addLine(to: CGPoint(x: 10, y: 5))
      ctx.addLine(to: CGPoint(x: 16, y: 19))
      ctx.move(to: CGPoint(x: 6.5, y: 14))
      ctx.addLine(to: CGPoint(x: 13.5, y: 14))
      ctx.move(to: CGPoint(x: 17, y: 13))
      ctx.addLine(to: CGPoint(x: 21, y: 13))
      ctx.move(to: CGPoint(x: 19, y: 13))
      ctx.addLine(to: CGPoint(x: 19, y: 19))
      ctx.strokePath()

    case "database":
      ctx.strokeEllipse(in: CGRect(x: 5, y: 3.5, width: 14, height: 5.6))
      ctx.move(to: CGPoint(x: 5, y: 6.3))
      ctx.addLine(to: CGPoint(x: 5, y: 18))
      ctx.addCurve(to: CGPoint(x: 19, y: 18), control1: CGPoint(x: 5, y: 21.5), control2: CGPoint(x: 19, y: 21.5))
      ctx.addLine(to: CGPoint(x: 19, y: 6.3))
      ctx.move(to: CGPoint(x: 5, y: 12))
      ctx.addCurve(to: CGPoint(x: 19, y: 12), control1: CGPoint(x: 5, y: 15.5), control2: CGPoint(x: 19, y: 15.5))
      ctx.strokePath()

    case "package":
      ctx.move(to: CGPoint(x: 12, y: 3))
      ctx.addLine(to: CGPoint(x: 21, y: 8))
      ctx.addLine(to: CGPoint(x: 21, y: 16))
      ctx.addLine(to: CGPoint(x: 12, y: 21))
      ctx.addLine(to: CGPoint(x: 3, y: 16))
      ctx.addLine(to: CGPoint(x: 3, y: 8))
      ctx.closePath()
      ctx.move(to: CGPoint(x: 3, y: 8))
      ctx.addLine(to: CGPoint(x: 12, y: 13))
      ctx.addLine(to: CGPoint(x: 21, y: 8))
      ctx.move(to: CGPoint(x: 12, y: 13))
      ctx.addLine(to: CGPoint(x: 12, y: 21))
      ctx.move(to: CGPoint(x: 8, y: 5.3))
      ctx.addLine(to: CGPoint(x: 16, y: 9.8))
      ctx.strokePath()

    default:
      // Neutral unknown file with '?' (§18.2)
      drawFoldedPageOutline(in: ctx)
      ctx.move(to: CGPoint(x: 10, y: 12))
      ctx.addCurve(to: CGPoint(x: 14, y: 12), control1: CGPoint(x: 10, y: 9.8), control2: CGPoint(x: 14, y: 9.8))
      ctx.addCurve(to: CGPoint(x: 12, y: 15.5), control1: CGPoint(x: 14, y: 13.4), control2: CGPoint(x: 12, y: 13.8))
      ctx.strokePath()
      ctx.fillEllipse(in: CGRect(x: 11.2, y: 17.2, width: 1.6, height: 1.6))
    }
  }

  private static func drawFoldedPageOutline(in ctx: CGContext) {
    ctx.move(to: CGPoint(x: 6, y: 3.5))
    ctx.addLine(to: CGPoint(x: 14, y: 3.5))
    ctx.addLine(to: CGPoint(x: 18, y: 7.5))
    ctx.addLine(to: CGPoint(x: 18, y: 20.5))
    ctx.addLine(to: CGPoint(x: 6, y: 20.5))
    ctx.closePath()
    ctx.move(to: CGPoint(x: 14, y: 3.5))
    ctx.addLine(to: CGPoint(x: 14, y: 7.5))
    ctx.addLine(to: CGPoint(x: 18, y: 7.5))
    ctx.strokePath()
  }

  private static func drawLanguageGlyph(langID: String, tint: NSColor, in ctx: CGContext) {
    switch langID {
    case "js", "ts":
      let bg = CGPath(roundedRect: CGRect(x: 3, y: 3, width: 18, height: 18), cornerWidth: 4, cornerHeight: 4, transform: nil)
      ctx.addPath(bg)
      ctx.fillPath()
      drawCenteredMonogram(langID == "js" ? "JS" : "TS", fontSize: 10.5, color: .white, in: ctx)

    case "php":
      ctx.fillEllipse(in: CGRect(x: 2, y: 5, width: 20, height: 14))
      drawCenteredMonogram("php", fontSize: 8.5, color: .white, in: ctx)

    case "go":
      ctx.move(to: CGPoint(x: 2.5, y: 8))
      ctx.addLine(to: CGPoint(x: 6.5, y: 8))
      ctx.move(to: CGPoint(x: 1.5, y: 12))
      ctx.addLine(to: CGPoint(x: 6.5, y: 12))
      ctx.move(to: CGPoint(x: 3.5, y: 16))
      ctx.addLine(to: CGPoint(x: 6.5, y: 16))
      ctx.addArc(center: CGPoint(x: 11.2, y: 12), radius: 3.6, startAngle: 0.45, endAngle: 5.8, clockwise: false)
      ctx.move(to: CGPoint(x: 11.2, y: 12))
      ctx.addLine(to: CGPoint(x: 14.8, y: 12))
      ctx.strokePath()
      ctx.strokeEllipse(in: CGRect(x: 16.0, y: 8.0, width: 5.8, height: 8.0))

    case "py":
      ctx.addPath(CGPath(roundedRect: CGRect(x: 5, y: 3.5, width: 11, height: 8), cornerWidth: 3, cornerHeight: 3, transform: nil))
      ctx.fillPath()
      ctx.saveGState()
      ctx.setAlpha(0.55)
      ctx.addPath(CGPath(roundedRect: CGRect(x: 8, y: 12.5, width: 11, height: 8), cornerWidth: 3, cornerHeight: 3, transform: nil))
      ctx.fillPath()
      ctx.restoreGState()
      ctx.setFillColor(NSColor.white.cgColor)
      ctx.fillEllipse(in: CGRect(x: 7.5, y: 5.5, width: 1.8, height: 1.8))
      ctx.fillEllipse(in: CGRect(x: 14.7, y: 16.5, width: 1.8, height: 1.8))

    case "rs":
      ctx.strokeEllipse(in: CGRect(x: 4.5, y: 4.5, width: 15, height: 15))
      for deg in stride(from: 0, to: 360, by: 45) {
        let rad = CGFloat(deg) * .pi / 180
        ctx.move(to: CGPoint(x: 12 + cos(rad) * 7.5, y: 12 + sin(rad) * 7.5))
        ctx.addLine(to: CGPoint(x: 12 + cos(rad) * 9.8, y: 12 + sin(rad) * 9.8))
      }
      ctx.move(to: CGPoint(x: 9.2, y: 15.8))
      ctx.addLine(to: CGPoint(x: 9.2, y: 8.4))
      ctx.addLine(to: CGPoint(x: 13.0, y: 8.4))
      ctx.addCurve(to: CGPoint(x: 13.0, y: 12.2), control1: CGPoint(x: 15.4, y: 8.4), control2: CGPoint(x: 15.4, y: 12.2))
      ctx.addLine(to: CGPoint(x: 9.2, y: 12.2))
      ctx.move(to: CGPoint(x: 12.6, y: 12.2))
      ctx.addLine(to: CGPoint(x: 15.2, y: 15.8))
      ctx.strokePath()

    case "sql":
      drawIdentity(glyphID: "database", tint: tint, in: ctx)

    case "sh", "zsh", "fish":
      ctx.addPath(CGPath(roundedRect: CGRect(x: 3, y: 4.5, width: 18, height: 15), cornerWidth: 3, cornerHeight: 3, transform: nil))
      ctx.move(to: CGPoint(x: 7, y: 9))
      ctx.addLine(to: CGPoint(x: 10.2, y: 12))
      ctx.addLine(to: CGPoint(x: 7, y: 15))
      ctx.move(to: CGPoint(x: 12.8, y: 15))
      ctx.addLine(to: CGPoint(x: 17, y: 15))
      ctx.strokePath()

    case "json":
      ctx.move(to: CGPoint(x: 9, y: 4.2))
      ctx.addCurve(to: CGPoint(x: 6, y: 9), control1: CGPoint(x: 6, y: 4.2), control2: CGPoint(x: 6, y: 6.2))
      ctx.addCurve(to: CGPoint(x: 3.5, y: 12), control1: CGPoint(x: 6, y: 11), control2: CGPoint(x: 4.8, y: 12))
      ctx.addCurve(to: CGPoint(x: 6, y: 15), control1: CGPoint(x: 4.8, y: 12), control2: CGPoint(x: 6, y: 13))
      ctx.addCurve(to: CGPoint(x: 9, y: 19.8), control1: CGPoint(x: 6, y: 17.8), control2: CGPoint(x: 6, y: 19.8))
      ctx.move(to: CGPoint(x: 15, y: 4.2))
      ctx.addCurve(to: CGPoint(x: 18, y: 9), control1: CGPoint(x: 18, y: 4.2), control2: CGPoint(x: 18, y: 6.2))
      ctx.addCurve(to: CGPoint(x: 20.5, y: 12), control1: CGPoint(x: 18, y: 11), control2: CGPoint(x: 19.2, y: 12))
      ctx.addCurve(to: CGPoint(x: 18, y: 15), control1: CGPoint(x: 19.2, y: 12), control2: CGPoint(x: 18, y: 13))
      ctx.addCurve(to: CGPoint(x: 15, y: 19.8), control1: CGPoint(x: 18, y: 17.8), control2: CGPoint(x: 18, y: 19.8))
      ctx.strokePath()

    case "css":
      ctx.move(to: CGPoint(x: 5, y: 3.5))
      ctx.addLine(to: CGPoint(x: 19, y: 3.5))
      ctx.addLine(to: CGPoint(x: 17.6, y: 19.2))
      ctx.addLine(to: CGPoint(x: 12, y: 21.2))
      ctx.addLine(to: CGPoint(x: 6.4, y: 19.2))
      ctx.closePath()
      ctx.fillPath()
      drawCenteredMonogram("CSS", fontSize: 7.4, color: .white, in: ctx)

    case "cpp", "c", "cs":
      ctx.move(to: CGPoint(x: 12, y: 2.2))
      ctx.addLine(to: CGPoint(x: 20.6, y: 7.1))
      ctx.addLine(to: CGPoint(x: 20.6, y: 16.9))
      ctx.addLine(to: CGPoint(x: 12, y: 21.8))
      ctx.addLine(to: CGPoint(x: 3.4, y: 16.9))
      ctx.addLine(to: CGPoint(x: 3.4, y: 7.1))
      ctx.closePath()
      ctx.fillPath()
      let mono = langID == "cpp" ? "C++" : (langID == "cs" ? "C#" : "C")
      drawCenteredMonogram(mono, fontSize: mono.count > 2 ? 7.6 : 10.5, color: .white, in: ctx)

    case "svg":
      ctx.move(to: CGPoint(x: 5, y: 17.5))
      ctx.addLine(to: CGPoint(x: 12, y: 5.5))
      ctx.addLine(to: CGPoint(x: 19, y: 17.5))
      ctx.closePath()
      ctx.strokePath()
      for pt in [CGPoint(x: 5, y: 17.5), CGPoint(x: 12, y: 5.5), CGPoint(x: 19, y: 17.5)] {
        ctx.setFillColor(NSColor.white.cgColor)
        ctx.fillEllipse(in: CGRect(x: pt.x - 1.8, y: pt.y - 1.8, width: 3.6, height: 3.6))
        ctx.strokeEllipse(in: CGRect(x: pt.x - 1.8, y: pt.y - 1.8, width: 3.6, height: 3.6))
      }

    case "md":
      ctx.addPath(CGPath(roundedRect: CGRect(x: 3, y: 5, width: 18, height: 14), cornerWidth: 2.2, cornerHeight: 2.2, transform: nil))
      ctx.move(to: CGPoint(x: 6.2, y: 15))
      ctx.addLine(to: CGPoint(x: 6.2, y: 9))
      ctx.addLine(to: CGPoint(x: 9, y: 12))
      ctx.addLine(to: CGPoint(x: 11.8, y: 9))
      ctx.addLine(to: CGPoint(x: 11.8, y: 15))
      ctx.move(to: CGPoint(x: 16, y: 9))
      ctx.addLine(to: CGPoint(x: 16, y: 15))
      ctx.move(to: CGPoint(x: 14, y: 13))
      ctx.addLine(to: CGPoint(x: 16, y: 15))
      ctx.addLine(to: CGPoint(x: 18, y: 13))
      ctx.strokePath()

    case "html", "unknown":
      ctx.move(to: CGPoint(x: 8.2, y: 7))
      ctx.addLine(to: CGPoint(x: 3.4, y: 12))
      ctx.addLine(to: CGPoint(x: 8.2, y: 17))
      ctx.move(to: CGPoint(x: 15.8, y: 7))
      ctx.addLine(to: CGPoint(x: 20.6, y: 12))
      ctx.addLine(to: CGPoint(x: 15.8, y: 17))
      ctx.move(to: CGPoint(x: 13.4, y: 5.2))
      ctx.addLine(to: CGPoint(x: 10.6, y: 18.8))
      ctx.strokePath()

    default:
      // Deliberately composed language monogram inside subtle rounded keycap
      let desc = LumenContentIdentityRegistry.shared.languageDescriptor(for: langID)
      ctx.saveGState()
      ctx.setFillColor(tint.withAlphaComponent(0.14).cgColor)
      let plate = CGPath(roundedRect: CGRect(x: 2.8, y: 2.8, width: 18.4, height: 18.4), cornerWidth: 4.5, cornerHeight: 4.5, transform: nil)
      ctx.addPath(plate)
      ctx.fillPath()
      ctx.setLineWidth(1.25)
      ctx.addPath(plate)
      ctx.strokePath()
      ctx.restoreGState()
      let mono = desc.monogram
      let fontSize: CGFloat = mono.count > 3 ? 7.2 : (mono.count > 2 ? 8.4 : (mono.count == 2 ? 10.2 : 12.2))
      drawCenteredMonogram(mono, fontSize: fontSize, color: tint, in: ctx)
    }
  }

  private static func drawCenteredMonogram(_ text: String, fontSize: CGFloat, color: NSColor, in ctx: CGContext) {
    let font = NSFont.systemFont(ofSize: fontSize, weight: .bold)
    let attrs: [NSAttributedString.Key: Any] = [
      .font: font,
      .foregroundColor: color,
      .kern: -0.35
    ]
    let str = NSAttributedString(string: text, attributes: attrs)
    let measured = str.size()
    let origin = NSPoint(x: (24 - measured.width) / 2.0, y: (24 - measured.height) / 2.0)
    str.draw(at: origin)
  }
}

/// Reusable vector view rendering any `LumenContentIdentity` glyph crisply at any scale.
final class LumenIdentityGlyphView: NSView {
  private let imageView = NSImageView()
  private var currentIdentity: LumenContentIdentity?
  private var currentIsDark = false
  private var overrideColor: NSColor?
  private var glyphSize: CGFloat

  init(size: CGFloat = 18) {
    self.glyphSize = size
    super.init(frame: NSRect(x: 0, y: 0, width: size, height: size))
    imageView.imageScaling = .scaleProportionallyDown
    imageView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(imageView)
    NSLayoutConstraint.activate([
      imageView.topAnchor.constraint(equalTo: topAnchor),
      imageView.leadingAnchor.constraint(equalTo: leadingAnchor),
      imageView.trailingAnchor.constraint(equalTo: trailingAnchor),
      imageView.bottomAnchor.constraint(equalTo: bottomAnchor)
    ])
  }

  required init?(coder: NSCoder) { nil }

  func configure(identity: LumenContentIdentity, isDark: Bool, size: CGFloat? = nil, overrideColor: NSColor? = nil) {
    if let size { self.glyphSize = size }
    self.currentIdentity = identity
    self.currentIsDark = isDark
    self.overrideColor = overrideColor
    imageView.image = LumenVectorGlyphs.identityImage(
      for: identity,
      size: glyphSize,
      isDark: isDark,
      overrideColor: overrideColor
    )
    setAccessibilityLabel(identity.displayName)
    toolTip = identity.displayName
  }
}

// MARK: - System Application Source Icon Resolver (§5.2, §18.2)

/// Resolves real macOS application icons via NSWorkspace / running applications,
/// caching by normalized source app name and falling back cleanly when unknown.
final class LumenSourceAppIconCache {
  static let shared = LumenSourceAppIconCache()

  private var iconCache: [String: NSImage] = [:]
  private var misses: Set<String> = []

  private init() {}

  func icon(forSourceApp name: String) -> NSImage? {
    let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !clean.isEmpty, clean != "本机", clean != "来源未知", clean != "Unknown" else {
      return nil
    }
    let key = clean.lowercased()
    if let cached = iconCache[key] { return cached }
    if misses.contains(key) { return nil }

    // 1. Check currently running applications (fast & exact for localized names)
    for app in NSWorkspace.shared.runningApplications {
      let localized = app.localizedName?.lowercased() ?? ""
      let bundleID = app.bundleIdentifier?.lowercased() ?? ""
      if localized == key || bundleID == key || (!localized.isEmpty && localized.contains(key)) {
        if let icon = app.icon {
          iconCache[key] = icon
          return icon
        }
      }
    }

    // 2. Check standard macOS application bundles
    let candidates: [String] = [
      "/Applications/\(clean).app",
      "/System/Applications/\(clean).app",
      "/System/Applications/Utilities/\(clean).app",
      "/System/Library/CoreServices/\(clean).app"
    ]
    for path in candidates where FileManager.default.fileExists(atPath: path) {
      let icon = NSWorkspace.shared.icon(forFile: path)
      iconCache[key] = icon
      return icon
    }

    misses.insert(key)
    return nil
  }
}
