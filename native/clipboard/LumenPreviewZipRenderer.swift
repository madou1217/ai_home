import AppKit
import Foundation

// MARK: - ZIP Safety Limits & Error Model (Q11, A26, A27, §12.4)

enum LumenZipLimits {
  static let maxArchiveBytes = 64 * 1024 * 1024         // 64 MiB archive cap
  static let maxDirectoryEntries = 2_000                // 2,000 visible entry cap
  static let maxMemberUncompressedBytes = 1 * 1024 * 1024 // 1 MiB read-only member cap
  static let maxTextPreviewChars = 12_000               // 12,000 character text display cap
  static let maxCompressionRatio: Double = 100.0        // Zip-bomb heuristic threshold
}

enum LumenZipError: LocalizedError {
  case archiveTooLarge(Int64)
  case unsupportedArchiveFormat(String)
  case zip64Unsupported
  case multiVolumeUnsupported
  case encryptedCentralDirectoryUnsupported
  case aesEncryptionUnsupported
  case strongEncryptionUnsupported
  case unsupportedCompressionMethod(UInt16)
  case pathTraversalBlocked(String)
  case memberTooLarge(Int64)
  case zipBombDetected
  case passwordRequired
  case wrongPassword
  case corruptData(String)

  var errorDescription: String? {
    switch self {
    case .archiveTooLarge(let size):
      return "归档体积（\(LumenFormatters.byteCount(size))）超过只读预览上限（64 MiB），为保证安全已停止加载。"
    case .unsupportedArchiveFormat(let fmt):
      return "暂不支持 \(fmt.uppercased()) 归档的内置目录解析与解密；当前原生预览支持标准 ZIP（Store / Deflate 与传统 ZipCrypto），且全程不写磁盘。"
    case .zip64Unsupported:
      return "检测到 ZIP64 超大归档结构，当前内置只读解析器暂不支持 ZIP64。"
    case .multiVolumeUnsupported:
      return "检测到分卷压缩包（Multi-disk ZIP），当前内置只读解析器暂不支持分卷归档。"
    case .encryptedCentralDirectoryUnsupported:
      return "该 ZIP 使用了加密中央目录，暂不支持解析。"
    case .aesEncryptionUnsupported:
      return "该成员使用 WinZip AES 加密算法，当前仅支持传统 ZipCrypto 密码校验。"
    case .strongEncryptionUnsupported:
      return "该成员使用强加密算法，当前仅支持传统 ZipCrypto 密码校验。"
    case .unsupportedCompressionMethod(let method):
      return "不支持的压缩算法（Method \(method)）；仅支持 Store (0) 与 Deflate (8)。"
    case .pathTraversalBlocked(let raw):
      return "已拦截不安全路径（\(raw)）：包含路径穿越或绝对路径，禁止读取。"
    case .memberTooLarge(let size):
      return "该成员解压体积为 \(LumenFormatters.byteCount(size))，超过内置只读预览上限（1 MiB）。"
    case .zipBombDetected:
      return "检测到异常高压缩比或超出 1 MiB 解压流上限（疑似压缩炸弹），已立即中止解压。"
    case .passwordRequired:
      return "该成员受 ZipCrypto 密码保护，请输入密码解锁只读预览。"
    case .wrongPassword:
      return "密码不正确或校验失败，请重新输入（密码不会保存或写入日志）。"
    case .corruptData(let detail):
      return "归档数据损坏或格式无法识别：\(detail)"
    }
  }
}

// MARK: - IEEE 802.3 CRC-32 & Traditional PKWARE ZipCrypto

enum LumenCRC32 {
  static let table: [UInt32] = {
    (0..<256).map { i -> UInt32 in
      var c = UInt32(i)
      for _ in 0..<8 {
        c = (c & 1) != 0 ? (0xEDB88320 ^ (c >> 1)) : (c >> 1)
      }
      return c
    }
  }()

  @inline(__always)
  static func update(_ crc: UInt32, byte: UInt8) -> UInt32 {
    (crc >> 8) ^ table[Int((crc ^ UInt32(byte)) & 0xFF)]
  }

  static func compute(_ bytes: [UInt8]) -> UInt32 {
    var crc: UInt32 = 0xFFFFFFFF
    for b in bytes {
      crc = update(crc, byte: b)
    }
    return crc ^ 0xFFFFFFFF
  }

  static func compute(_ data: Data) -> UInt32 {
    var crc: UInt32 = 0xFFFFFFFF
    for b in data {
      crc = update(crc, byte: b)
    }
    return crc ^ 0xFFFFFFFF
  }
}

/// Traditional PKWARE ZipCrypto stream cipher (AppNote §6.1).
/// Ephemeral value type: password bytes live only on stack during verification and are never logged or persisted.
struct LumenZipCrypto {
  private var k0: UInt32 = 0x12345678
  private var k1: UInt32 = 0x23456789
  private var k2: UInt32 = 0x34567890

  init(password: String) {
    for b in password.utf8 {
      updateKeys(b)
    }
  }

  private mutating func updateKeys(_ byte: UInt8) {
    k0 = LumenCRC32.update(k0, byte: byte)
    k1 = (k1 &+ (k0 & 0xFF)) &* 134775813 &+ 1
    k2 = LumenCRC32.update(k2, byte: UInt8(truncatingIfNeeded: k1 >> 24))
  }

  mutating func decryptByte(_ cipher: UInt8) -> UInt8 {
    let temp = (k2 & 0xFFFF) | 2
    let keystream = UInt8(truncatingIfNeeded: (temp &* (temp ^ 1)) >> 8)
    let plain = cipher ^ keystream
    updateKeys(plain)
    return plain
  }

  mutating func decryptPayload(
    from encryptedBytes: ArraySlice<UInt8>,
    expectedCheckByte: UInt8
  ) throws -> [UInt8] {
    guard encryptedBytes.count >= 12 else {
      throw LumenZipError.corruptData("加密载荷长度不足 12 字节")
    }
    var lastHeaderByte: UInt8 = 0
    var idx = encryptedBytes.startIndex
    for _ in 0..<12 {
      lastHeaderByte = decryptByte(encryptedBytes[idx])
      idx += 1
    }
    guard lastHeaderByte == expectedCheckByte else {
      throw LumenZipError.wrongPassword
    }
    var output: [UInt8] = []
    output.reserveCapacity(encryptedBytes.count - 12)
    while idx < encryptedBytes.endIndex {
      output.append(decryptByte(encryptedBytes[idx]))
      idx += 1
    }
    return output
  }
}

// MARK: - Bounded Streaming RFC 1951 Raw Inflate (Byte-Level Zip-Bomb Defense)

/// Pure-Swift RFC 1951 raw DEFLATE decoder enforcing a strict `maxOutputBytes` cap during decompression.
/// Even if a malicious ZIP lies about `uncompressedSize` in its header, decompression aborts immediately
/// on the first byte exceeding 1 MiB without allocating unbounded RAM.
enum LumenRawDeflateDecoder {
  private struct BitReader {
    let bytes: [UInt8]
    var bytePos: Int = 0
    var bitBuffer: UInt32 = 0
    var bitCount: Int = 0

    mutating func readBits(_ count: Int) throws -> Int {
      if count == 0 { return 0 }
      while bitCount < count {
        guard bytePos < bytes.count else {
          throw LumenZipError.corruptData("Deflate 数据流提前结束")
        }
        bitBuffer |= UInt32(bytes[bytePos]) << UInt32(bitCount)
        bytePos += 1
        bitCount += 8
      }
      let mask: UInt32 = (UInt32(1) << UInt32(count)) - 1
      let value = Int(bitBuffer & mask)
      bitBuffer >>= UInt32(count)
      bitCount -= count
      return value
    }

    mutating func alignToByte() {
      let drop = bitCount & 7
      if drop > 0 {
        bitBuffer >>= UInt32(drop)
        bitCount -= drop
      }
    }

    mutating func readAlignedByte() throws -> UInt8 {
      if bitCount >= 8 {
        let b = UInt8(truncatingIfNeeded: bitBuffer)
        bitBuffer >>= 8
        bitCount -= 8
        return b
      }
      guard bytePos < bytes.count else {
        throw LumenZipError.corruptData("Stored 块数据提前结束")
      }
      let b = bytes[bytePos]
      bytePos += 1
      return b
    }

    mutating func readAlignedUInt16LE() throws -> UInt16 {
      let lo = UInt16(try readAlignedByte())
      let hi = UInt16(try readAlignedByte())
      return lo | (hi << 8)
    }
  }

  private struct HuffmanTable {
    var counts: [Int] // length 16 (indices 0...15)
    var symbols: [Int]

    init(codeLengths: [Int]) throws {
      var counts = [Int](repeating: 0, count: 16)
      for len in codeLengths {
        if len < 0 || len > 15 {
          throw LumenZipError.corruptData("非法 Huffman 码长")
        }
        counts[len] += 1
      }
      counts[0] = 0
      var offsets = [Int](repeating: 0, count: 16)
      var total = 0
      for len in 1...15 {
        offsets[len] = total
        total += counts[len]
      }
      var symbols = [Int](repeating: 0, count: total)
      for (sym, len) in codeLengths.enumerated() where len > 0 {
        symbols[offsets[len]] = sym
        offsets[len] += 1
      }
      self.counts = counts
      self.symbols = symbols
    }

    func decode(from reader: inout BitReader) throws -> Int {
      var code = 0
      var first = 0
      var index = 0
      for len in 1...15 {
        code = (code << 1) | (try reader.readBits(1))
        let count = counts[len]
        if code - count < first {
          return symbols[index + (code - first)]
        }
        index += count
        first = (first + count) << 1
      }
      throw LumenZipError.corruptData("无效的 Huffman 符号")
    }
  }

  private static let lengthBases = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
    35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258
  ]
  private static let lengthExtras = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
    3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0
  ]
  private static let distBases = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
    257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577
  ]
  private static let distExtras = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13
  ]
  private static let codeLengthOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

  private static let fixedLitTable: HuffmanTable = {
    var lengths = [Int](repeating: 0, count: 288)
    for i in 0...143 { lengths[i] = 8 }
    for i in 144...255 { lengths[i] = 9 }
    for i in 256...279 { lengths[i] = 7 }
    for i in 280...287 { lengths[i] = 8 }
    return (try? HuffmanTable(codeLengths: lengths)) ?? HuffmanTableFallback()
  }()

  private static let fixedDistTable: HuffmanTable = {
    let lengths = [Int](repeating: 5, count: 30)
    return (try? HuffmanTable(codeLengths: lengths)) ?? HuffmanTableFallback()
  }()

  private static func HuffmanTableFallback() -> HuffmanTable {
    (try! HuffmanTable(codeLengths: [1]))
  }

  static func inflate(_ compressed: [UInt8], expectedSize: Int = 0, maxOutputBytes: Int) throws -> [UInt8] {
    var reader = BitReader(bytes: compressed)
    var output: [UInt8] = []
    if expectedSize > 0 && expectedSize <= maxOutputBytes {
      output.reserveCapacity(expectedSize)
    }

    var isFinalBlock = 0
    repeat {
      isFinalBlock = try reader.readBits(1)
      let blockType = try reader.readBits(2)

      switch blockType {
      case 0: // Uncompressed stored block
        reader.alignToByte()
        let len = try reader.readAlignedUInt16LE()
        let nlen = try reader.readAlignedUInt16LE()
        guard (len ^ 0xFFFF) == nlen else {
          throw LumenZipError.corruptData("Stored 块长度校验失败")
        }
        let byteLen = Int(len)
        guard output.count + byteLen <= maxOutputBytes else {
          throw LumenZipError.zipBombDetected
        }
        for _ in 0..<byteLen {
          output.append(try reader.readAlignedByte())
        }

      case 1: // Fixed Huffman codes
        try decodeHuffmanBlock(
          reader: &reader,
          litTable: fixedLitTable,
          distTable: fixedDistTable,
          output: &output,
          maxOutputBytes: maxOutputBytes
        )

      case 2: // Dynamic Huffman codes
        let hlit = (try reader.readBits(5)) + 257
        let hdist = (try reader.readBits(5)) + 1
        let hclen = (try reader.readBits(4)) + 4
        guard hlit <= 286 && hdist <= 30 else {
          throw LumenZipError.corruptData("动态 Huffman 表头超界")
        }
        var codeLenLengths = [Int](repeating: 0, count: 19)
        for i in 0..<hclen {
          codeLenLengths[codeLengthOrder[i]] = try reader.readBits(3)
        }
        let codeLenTable = try HuffmanTable(codeLengths: codeLenLengths)

        let totalCodes = hlit + hdist
        var allLengths = [Int](repeating: 0, count: totalCodes)
        var idx = 0
        while idx < totalCodes {
          let sym = try codeLenTable.decode(from: &reader)
          if sym < 16 {
            allLengths[idx] = sym
            idx += 1
          } else if sym == 16 {
            guard idx > 0 else { throw LumenZipError.corruptData("RLE 16 无前导码长") }
            let prev = allLengths[idx - 1]
            let repeatCount = 3 + (try reader.readBits(2))
            guard idx + repeatCount <= totalCodes else { throw LumenZipError.corruptData("RLE 16 超界") }
            for _ in 0..<repeatCount {
              allLengths[idx] = prev
              idx += 1
            }
          } else if sym == 17 {
            let repeatCount = 3 + (try reader.readBits(3))
            guard idx + repeatCount <= totalCodes else { throw LumenZipError.corruptData("RLE 17 超界") }
            idx += repeatCount
          } else if sym == 18 {
            let repeatCount = 11 + (try reader.readBits(7))
            guard idx + repeatCount <= totalCodes else { throw LumenZipError.corruptData("RLE 18 超界") }
            idx += repeatCount
          } else {
            throw LumenZipError.corruptData("未知动态码长符号 \(sym)")
          }
        }
        let litTable = try HuffmanTable(codeLengths: Array(allLengths[0..<hlit]))
        let distTable = try HuffmanTable(codeLengths: Array(allLengths[hlit..<totalCodes]))
        try decodeHuffmanBlock(
          reader: &reader,
          litTable: litTable,
          distTable: distTable,
          output: &output,
          maxOutputBytes: maxOutputBytes
        )

      default:
        throw LumenZipError.corruptData("保留的 Deflate 块类型 3")
      }
    } while isFinalBlock == 0

    return output
  }

  private static func decodeHuffmanBlock(
    reader: inout BitReader,
    litTable: HuffmanTable,
    distTable: HuffmanTable,
    output: inout [UInt8],
    maxOutputBytes: Int
  ) throws {
    while true {
      let sym = try litTable.decode(from: &reader)
      if sym < 256 {
        guard output.count < maxOutputBytes else {
          throw LumenZipError.zipBombDetected
        }
        output.append(UInt8(sym))
      } else if sym == 256 {
        break
      } else if sym <= 285 {
        let lenIdx = sym - 257
        let length = lengthBases[lenIdx] + (try reader.readBits(lengthExtras[lenIdx]))
        let distSym = try distTable.decode(from: &reader)
        guard distSym >= 0 && distSym < distBases.count else {
          throw LumenZipError.corruptData("无效的距离符号 \(distSym)")
        }
        let distance = distBases[distSym] + (try reader.readBits(distExtras[distSym]))
        guard distance > 0 && distance <= output.count else {
          throw LumenZipError.corruptData("回溯距离超出输出缓冲")
        }
        guard output.count + length <= maxOutputBytes else {
          throw LumenZipError.zipBombDetected
        }
        for _ in 0..<length {
          output.append(output[output.count - distance])
        }
      } else {
        throw LumenZipError.corruptData("非法文字长度符号 \(sym)")
      }
    }
  }
}

// MARK: - Read-Only Central Directory Parser & Tree Model

enum LumenZipEncryptionKind: Equatable {
  case none
  case zipCrypto
  case aesUnsupported
  case strongUnsupported
}

struct LumenZipEntry: Equatable {
  let id: String
  let rawPath: String
  let cleanPath: String
  let name: String
  let depth: Int
  let isDirectory: Bool
  let isSyntheticDirectory: Bool
  let isUnsafePath: Bool
  let compressionMethod: UInt16
  let generalFlag: UInt16
  let dosModTime: UInt16
  let crc32: UInt32
  let compressedSize: UInt32
  let uncompressedSize: UInt32
  let localHeaderOffset: UInt32
  let encryption: LumenZipEncryptionKind
  let childCount: Int

  var isEncrypted: Bool { encryption != .none }
}

final class LumenZipArchive {
  let rawBytes: [UInt8]
  let totalRawEntryCount: Int
  let entriesTruncated: Bool
  let treeNodes: [LumenZipEntry]
  let totalUncompressedBytes: Int64
  let encryptedFileCount: Int

  private init(
    rawBytes: [UInt8],
    totalRawEntryCount: Int,
    entriesTruncated: Bool,
    treeNodes: [LumenZipEntry],
    totalUncompressedBytes: Int64,
    encryptedFileCount: Int
  ) {
    self.rawBytes = rawBytes
    self.totalRawEntryCount = totalRawEntryCount
    self.entriesTruncated = entriesTruncated
    self.treeNodes = treeNodes
    self.totalUncompressedBytes = totalUncompressedBytes
    self.encryptedFileCount = encryptedFileCount
  }

  static func parse(data: Data) throws -> LumenZipArchive {
    if data.count > LumenZipLimits.maxArchiveBytes {
      throw LumenZipError.archiveTooLarge(Int64(data.count))
    }
    let bytes = Array(data)
    guard bytes.count >= 22 else {
      throw LumenZipError.corruptData("文件过小，不包含 ZIP 尾记录")
    }

    // Locate End of Central Directory (0x06054b50) scanning backward up to 65,557 bytes
    let minEOCDOffset = max(0, bytes.count - 65_557)
    var eocdOffset: Int?
    var scan = bytes.count - 22
    while scan >= minEOCDOffset {
      if readUInt32LE(bytes, at: scan) == 0x06054b50 {
        let commentLen = Int(readUInt16LE(bytes, at: scan + 20))
        if scan + 22 + commentLen == bytes.count {
          eocdOffset = scan
          break
        }
      }
      scan -= 1
    }
    guard let eocd = eocdOffset else {
      throw LumenZipError.corruptData("未找到有效的 ZIP 中央目录结束标记")
    }

    // Check ZIP64 EOCD Locator (0x07064b50) immediately preceding EOCD
    if eocd >= 20 && readUInt32LE(bytes, at: eocd - 20) == 0x07064b50 {
      throw LumenZipError.zip64Unsupported
    }

    let diskNumber = readUInt16LE(bytes, at: eocd + 4)
    let cdDisk = readUInt16LE(bytes, at: eocd + 6)
    let diskEntries = readUInt16LE(bytes, at: eocd + 8)
    let totalEntries16 = readUInt16LE(bytes, at: eocd + 10)
    let cdSize = readUInt32LE(bytes, at: eocd + 12)
    let cdOffset = readUInt32LE(bytes, at: eocd + 16)

    if diskNumber == 0xFFFF || cdDisk == 0xFFFF || diskEntries == 0xFFFF
      || totalEntries16 == 0xFFFF || cdSize == 0xFFFFFFFF || cdOffset == 0xFFFFFFFF {
      throw LumenZipError.zip64Unsupported
    }
    if diskNumber != 0 || cdDisk != 0 || diskEntries != totalEntries16 {
      throw LumenZipError.multiVolumeUnsupported
    }

    let cdStart = Int(cdOffset)
    let cdEnd = cdStart + Int(cdSize)
    guard cdStart >= 0 && cdEnd <= bytes.count && cdStart <= eocd else {
      throw LumenZipError.corruptData("中央目录偏移超出文件范围")
    }

    var rawEntries: [LumenZipEntry] = []
    rawEntries.reserveCapacity(min(Int(totalEntries16), LumenZipLimits.maxDirectoryEntries))

    var cursor = cdStart
    var totalUncompressed: Int64 = 0
    var encryptedCount = 0
    var parsedCount = 0
    var truncated = false

    while cursor < cdEnd && parsedCount < Int(totalEntries16) {
      guard cursor + 46 <= cdEnd else {
        throw LumenZipError.corruptData("中央目录记录不完整")
      }
      guard readUInt32LE(bytes, at: cursor) == 0x02014b50 else {
        throw LumenZipError.corruptData("中央目录记录签名不匹配")
      }

      let generalFlag = readUInt16LE(bytes, at: cursor + 8)
      let method = readUInt16LE(bytes, at: cursor + 10)
      let dosModTime = readUInt16LE(bytes, at: cursor + 12)
      let crc32 = readUInt32LE(bytes, at: cursor + 16)
      let compSize = readUInt32LE(bytes, at: cursor + 20)
      let uncompSize = readUInt32LE(bytes, at: cursor + 24)
      let nameLen = Int(readUInt16LE(bytes, at: cursor + 28))
      let extraLen = Int(readUInt16LE(bytes, at: cursor + 30))
      let commentLen = Int(readUInt16LE(bytes, at: cursor + 32))
      let extAttrs = readUInt32LE(bytes, at: cursor + 38)
      let localOffset = readUInt32LE(bytes, at: cursor + 42)

      if (generalFlag & 0x2000) != 0 {
        throw LumenZipError.encryptedCentralDirectoryUnsupported
      }
      if compSize == 0xFFFFFFFF || uncompSize == 0xFFFFFFFF || localOffset == 0xFFFFFFFF {
        throw LumenZipError.zip64Unsupported
      }

      let nameStart = cursor + 46
      let nameEnd = nameStart + nameLen
      let nextRecord = nameEnd + extraLen + commentLen
      guard nextRecord <= cdEnd else {
        throw LumenZipError.corruptData("中央目录文件名或扩展区越界")
      }

      // Inspect extra field for ZIP64 header (0x0001) or WinZip AES header (0x9901)
      var hasAESExtra = false
      var extraPos = nameEnd
      let extraEnd = nameEnd + extraLen
      while extraPos + 4 <= extraEnd {
        let headerID = readUInt16LE(bytes, at: extraPos)
        let dataLen = Int(readUInt16LE(bytes, at: extraPos + 2))
        if headerID == 0x9901 {
          hasAESExtra = true
        }
        extraPos += 4 + dataLen
      }

      let nameData = Data(bytes[nameStart..<nameEnd])
      let rawName: String
      if (generalFlag & 0x0800) != 0 {
        rawName = String(data: nameData, encoding: .utf8) ?? String(decoding: nameData, as: UTF8.self)
      } else {
        rawName = String(data: nameData, encoding: .utf8)
          ?? String(data: nameData, encoding: .isoLatin1)
          ?? String(decoding: nameData, as: UTF8.self)
      }

      // Skip macOS resource fork metadata noise (`__MACOSX/...`)
      let isMacOSXMeta = rawName == "__MACOSX/" || rawName.hasPrefix("__MACOSX/")
      parsedCount += 1
      cursor = nextRecord
      if isMacOSXMeta { continue }

      let isDir = rawName.hasSuffix("/") || ((extAttrs & 0x10) != 0 && uncompSize == 0)
      let (cleanPath, isUnsafe) = sanitizeEntryPath(rawName)

      let encKind: LumenZipEncryptionKind
      if method == 99 || hasAESExtra {
        encKind = .aesUnsupported
      } else if (generalFlag & 0x0040) != 0 {
        encKind = .strongUnsupported
      } else if (generalFlag & 0x0001) != 0 {
        encKind = .zipCrypto
      } else {
        encKind = .none
      }

      if !isDir {
        totalUncompressed += Int64(uncompSize)
        if encKind != .none { encryptedCount += 1 }
      }

      if rawEntries.count < LumenZipLimits.maxDirectoryEntries {
        let components = cleanPath.split(separator: "/").map(String.init)
        let baseName = components.last ?? cleanPath
        rawEntries.append(
          LumenZipEntry(
            id: "entry:\(parsedCount):\(rawName)",
            rawPath: rawName,
            cleanPath: cleanPath,
            name: baseName.isEmpty ? rawName : baseName,
            depth: max(0, components.count - 1),
            isDirectory: isDir,
            isSyntheticDirectory: false,
            isUnsafePath: isUnsafe,
            compressionMethod: method,
            generalFlag: generalFlag,
            dosModTime: dosModTime,
            crc32: crc32,
            compressedSize: compSize,
            uncompressedSize: uncompSize,
            localHeaderOffset: localOffset,
            encryption: encKind,
            childCount: 0
          )
        )
      } else {
        truncated = true
      }
    }

    let tree = buildHierarchicalTree(from: rawEntries, maxNodes: LumenZipLimits.maxDirectoryEntries)
    return LumenZipArchive(
      rawBytes: bytes,
      totalRawEntryCount: Int(totalEntries16),
      entriesTruncated: truncated || Int(totalEntries16) > LumenZipLimits.maxDirectoryEntries,
      treeNodes: tree,
      totalUncompressedBytes: totalUncompressed,
      encryptedFileCount: encryptedCount
    )
  }

  /// Extracts a single member purely in memory with path-traversal, size, zip-bomb, ZipCrypto, and CRC-32 checks.
  func extractMember(_ entry: LumenZipEntry, password: String?) throws -> Data {
    if entry.isUnsafePath {
      throw LumenZipError.pathTraversalBlocked(entry.rawPath)
    }
    if entry.isDirectory {
      return Data()
    }
    switch entry.encryption {
    case .aesUnsupported:
      throw LumenZipError.aesEncryptionUnsupported
    case .strongUnsupported:
      throw LumenZipError.strongEncryptionUnsupported
    case .zipCrypto:
      guard let password, !password.isEmpty else {
        throw LumenZipError.passwordRequired
      }
      return try extractPayload(entry: entry, password: password)
    case .none:
      return try extractPayload(entry: entry, password: nil)
    }
  }

  private func extractPayload(entry: LumenZipEntry, password: String?) throws -> Data {
    if Int(entry.uncompressedSize) > LumenZipLimits.maxMemberUncompressedBytes {
      throw LumenZipError.memberTooLarge(Int64(entry.uncompressedSize))
    }
    if entry.compressedSize >= 1024 && entry.uncompressedSize > 256 * 1024 {
      let ratio = Double(entry.uncompressedSize) / Double(max(1, entry.compressedSize))
      if ratio > LumenZipLimits.maxCompressionRatio {
        throw LumenZipError.zipBombDetected
      }
    }

    let locOffset = Int(entry.localHeaderOffset)
    guard locOffset >= 0 && locOffset + 30 <= rawBytes.count else {
      throw LumenZipError.corruptData("本地文件头偏移越界")
    }
    guard Self.readUInt32LE(rawBytes, at: locOffset) == 0x04034b50 else {
      throw LumenZipError.corruptData("本地文件头签名无效")
    }
    let locNameLen = Int(Self.readUInt16LE(rawBytes, at: locOffset + 26))
    let locExtraLen = Int(Self.readUInt16LE(rawBytes, at: locOffset + 28))
    let dataStart = locOffset + 30 + locNameLen + locExtraLen
    let dataEnd = dataStart + Int(entry.compressedSize)
    guard dataStart >= 0 && dataEnd <= rawBytes.count else {
      throw LumenZipError.corruptData("成员压缩数据越界")
    }

    let rawSlice = rawBytes[dataStart..<dataEnd]
    let compressedBytes: [UInt8]
    if let password {
      var crypto = LumenZipCrypto(password: password)
      let checkByte: UInt8 = ((entry.generalFlag & 0x0008) != 0)
        ? UInt8(truncatingIfNeeded: entry.dosModTime >> 8)
        : UInt8(truncatingIfNeeded: entry.crc32 >> 24)
      compressedBytes = try crypto.decryptPayload(from: rawSlice, expectedCheckByte: checkByte)
    } else {
      compressedBytes = Array(rawSlice)
    }

    let plainBytes: [UInt8]
    switch entry.compressionMethod {
    case 0: // Store
      guard compressedBytes.count <= LumenZipLimits.maxMemberUncompressedBytes else {
        throw LumenZipError.zipBombDetected
      }
      plainBytes = compressedBytes
    case 8: // Deflate (bounded streaming RFC 1951 inflate)
      do {
        plainBytes = try LumenRawDeflateDecoder.inflate(
          compressedBytes,
          expectedSize: Int(entry.uncompressedSize),
          maxOutputBytes: LumenZipLimits.maxMemberUncompressedBytes
        )
      } catch {
        // A 1/256 ZipCrypto check-byte collision surfaces as corrupt deflate stream -> report wrongPassword
        if entry.encryption == .zipCrypto {
          throw LumenZipError.wrongPassword
        }
        throw error
      }
    default:
      throw LumenZipError.unsupportedCompressionMethod(entry.compressionMethod)
    }

    let actualCRC = LumenCRC32.compute(plainBytes)
    if actualCRC != entry.crc32 {
      if entry.encryption == .zipCrypto {
        throw LumenZipError.wrongPassword
      }
      throw LumenZipError.corruptData("成员 CRC-32 校验失败")
    }

    return Data(plainBytes)
  }

  /// Detects path traversal (`..`, absolute leading `/` or `\`, drive letter `C:`, NUL bytes).
  private static func sanitizeEntryPath(_ raw: String) -> (clean: String, isUnsafe: Bool) {
    if raw.contains("\0") {
      return (raw.replacingOccurrences(of: "\0", with: "?"), true)
    }
    var unsafe = false
    if raw.hasPrefix("/") || raw.hasPrefix("\\") {
      unsafe = true
    }
    let normalizedSlashes = raw.replacingOccurrences(of: "\\", with: "/")
    let trimmed = normalizedSlashes.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let parts = trimmed.split(separator: "/").map(String.init)
    if let first = parts.first, first.count >= 2, first[first.index(first.startIndex, offsetBy: 1)] == ":" {
      unsafe = true
    }
    if parts.contains("..") {
      unsafe = true
    }
    return (trimmed.isEmpty ? raw : trimmed, unsafe)
  }

  /// Builds a clean depth-indented directory tree (folders first, alphabetical) synthesizing missing parent folders.
  private static func buildHierarchicalTree(from entries: [LumenZipEntry], maxNodes: Int) -> [LumenZipEntry] {
    var byPath: [String: LumenZipEntry] = [:]
    var directChildCounts: [String: Int] = [:]

    for entry in entries {
      if entry.isUnsafePath {
        byPath[entry.id] = entry
        continue
      }
      let key = entry.cleanPath
      if let existing = byPath[key] {
        // Prefer real entry over synthetic directory
        if existing.isSyntheticDirectory && !entry.isSyntheticDirectory {
          byPath[key] = entry
        }
      } else {
        byPath[key] = entry
      }

      // Synthesize implicit ancestor folders
      let parts = key.split(separator: "/").map(String.init)
      if parts.count > 1 {
        let parentPath = parts.dropLast().joined(separator: "/")
        directChildCounts[parentPath, default: 0] += 1
        var acc: [String] = []
        for idx in 0..<(parts.count - 1) {
          acc.append(parts[idx])
          let folderPath = acc.joined(separator: "/")
          if byPath[folderPath] == nil {
            byPath[folderPath] = LumenZipEntry(
              id: "dir:\(folderPath)",
              rawPath: folderPath + "/",
              cleanPath: folderPath,
              name: parts[idx],
              depth: idx,
              isDirectory: true,
              isSyntheticDirectory: true,
              isUnsafePath: false,
              compressionMethod: 0,
              generalFlag: 0,
              dosModTime: 0,
              crc32: 0,
              compressedSize: 0,
              uncompressedSize: 0,
              localHeaderOffset: 0,
              encryption: .none,
              childCount: 0
            )
            if idx > 0 {
              let grandParent = acc.dropLast().joined(separator: "/")
              directChildCounts[grandParent, default: 0] += 1
            }
          }
        }
      }
    }

    // Group by parent path so DFS emits exact tree hierarchy
    var childrenByParent: [String: [LumenZipEntry]] = [:]
    for entry in byPath.values {
      let updated = LumenZipEntry(
        id: entry.id,
        rawPath: entry.rawPath,
        cleanPath: entry.cleanPath,
        name: entry.name,
        depth: entry.isUnsafePath ? 0 : entry.depth,
        isDirectory: entry.isDirectory,
        isSyntheticDirectory: entry.isSyntheticDirectory,
        isUnsafePath: entry.isUnsafePath,
        compressionMethod: entry.compressionMethod,
        generalFlag: entry.generalFlag,
        dosModTime: entry.dosModTime,
        crc32: entry.crc32,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
        localHeaderOffset: entry.localHeaderOffset,
        encryption: entry.encryption,
        childCount: entry.isDirectory ? (directChildCounts[entry.cleanPath] ?? 0) : 0
      )
      let parentKey: String
      if updated.isUnsafePath {
        parentKey = ""
      } else {
        let parts = updated.cleanPath.split(separator: "/")
        parentKey = parts.count > 1 ? parts.dropLast().joined(separator: "/") : ""
      }
      childrenByParent[parentKey, default: []].append(updated)
    }

    for key in childrenByParent.keys {
      childrenByParent[key]?.sort { lhs, rhs in
        if lhs.isDirectory != rhs.isDirectory { return lhs.isDirectory && !rhs.isDirectory }
        return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
      }
    }

    var flattened: [LumenZipEntry] = []
    flattened.reserveCapacity(min(byPath.count, maxNodes))

    func walk(parent: String) {
      guard flattened.count < maxNodes, let children = childrenByParent[parent] else { return }
      for node in children {
        guard flattened.count < maxNodes else { return }
        flattened.append(node)
        if node.isDirectory && !node.isUnsafePath {
          walk(parent: node.cleanPath)
        }
      }
    }
    walk(parent: "")
    return flattened
  }

  private static func readUInt16LE(_ b: [UInt8], at offset: Int) -> UInt16 {
    UInt16(b[offset]) | (UInt16(b[offset + 1]) << 8)
  }

  private static func readUInt32LE(_ b: [UInt8], at offset: Int) -> UInt32 {
    UInt32(b[offset])
      | (UInt32(b[offset + 1]) << 8)
      | (UInt32(b[offset + 2]) << 16)
      | (UInt32(b[offset + 3]) << 24)
  }
}

// MARK: - Native Quick Look ZIP Archive Renderer (Q11, A26, A27, A64)

struct LumenZipRenderer: LumenPreviewRenderer {
  let rendererID = "native.appkit.zip"
  let priority = 92

  func canRender(_ item: LumenPreviewItem) -> Bool {
    if case .archive = item.kind { return true }
    return false
  }

  func makeView(for item: LumenPreviewItem, context: LumenPreviewContext) -> LumenPreviewRendererView {
    LumenZipRendererView(palette: context.palette)
  }
}

final class LumenZipRendererView: LumenPreviewRendererView, NSTableViewDataSource, NSTableViewDelegate, NSTextFieldDelegate {
  private let palette: LumenPalette
  private let toolbar = NSView()
  private let toolbarDivider = NSView()
  private let summaryGlyph = LumenIdentityGlyphView(size: 16)
  private let summaryLabel = NSTextField(labelWithString: "正在读取归档目录…")
  private let clearSecretBtn = NSButton()

  private let splitHost = NSView()
  private let treeScroll = NSScrollView()
  private let treeTable = NSTableView()
  private let splitDivider = NSView()
  private let detailPane = NSView()

  private var archive: LumenZipArchive?
  private var selectedRowIndex: Int = -1
  /// Ephemeral in-memory password & decrypted member cache — NEVER persisted or logged, cleared on teardown/switch.
  private var sessionPassword: String?
  private var decryptedCache: [String: Data] = [:]
  private var currentPreviewPlainText: String?
  private var loadGeneration = 0

  // Weak references for active inline password prompt
  private weak var inlinePasswordField: NSSecureTextField?
  private weak var inlinePasswordErrorLabel: NSTextField?

  init(palette: LumenPalette) {
    self.palette = palette
    super.init(frame: .zero)
    wantsLayer = true
    layer?.backgroundColor = palette.windowBackground.cgColor
    setupUI()
  }

  required init?(coder: NSCoder) { nil }

  deinit {
    teardown()
  }

  private func setupUI() {
    toolbar.wantsLayer = true
    toolbar.layer?.backgroundColor = palette.surface.cgColor
    toolbar.translatesAutoresizingMaskIntoConstraints = false

    toolbarDivider.wantsLayer = true
    toolbarDivider.layer?.backgroundColor = palette.border.cgColor
    toolbarDivider.translatesAutoresizingMaskIntoConstraints = false

    summaryGlyph.translatesAutoresizingMaskIntoConstraints = false
    summaryLabel.font = .monospacedDigitSystemFont(ofSize: 11.5, weight: .medium)
    summaryLabel.textColor = palette.muted
    summaryLabel.lineBreakMode = .byTruncatingTail
    summaryLabel.translatesAutoresizingMaskIntoConstraints = false

    clearSecretBtn.title = "锁定并清除解密缓存"
    clearSecretBtn.target = self
    clearSecretBtn.action = #selector(clearDecryptionStateClicked)
    clearSecretBtn.isBordered = false
    clearSecretBtn.wantsLayer = true
    clearSecretBtn.font = .systemFont(ofSize: 11, weight: .medium)
    clearSecretBtn.contentTintColor = palette.ink
    clearSecretBtn.layer?.cornerRadius = 7
    clearSecretBtn.layer?.borderWidth = 1
    clearSecretBtn.layer?.borderColor = palette.border.cgColor
    clearSecretBtn.layer?.backgroundColor = palette.surfaceElevated.cgColor
    clearSecretBtn.isHidden = true
    clearSecretBtn.translatesAutoresizingMaskIntoConstraints = false

    toolbar.addSubview(summaryGlyph)
    toolbar.addSubview(summaryLabel)
    toolbar.addSubview(clearSecretBtn)
    toolbar.addSubview(toolbarDivider)

    let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("zipTree"))
    col.resizingMask = .autoresizingMask
    treeTable.addTableColumn(col)
    treeTable.headerView = nil
    treeTable.rowHeight = 32
    treeTable.intercellSpacing = NSSize(width: 0, height: 2)
    treeTable.backgroundColor = .clear
    treeTable.selectionHighlightStyle = .none
    treeTable.dataSource = self
    treeTable.delegate = self
    treeTable.target = self
    treeTable.action = #selector(treeRowClicked)

    treeScroll.documentView = treeTable
    treeScroll.hasVerticalScroller = true
    treeScroll.autohidesScrollers = true
    treeScroll.drawsBackground = true
    treeScroll.backgroundColor = palette.sidebarBackgroundBottom
    treeScroll.borderType = .noBorder
    treeScroll.translatesAutoresizingMaskIntoConstraints = false

    splitDivider.wantsLayer = true
    splitDivider.layer?.backgroundColor = palette.border.cgColor
    splitDivider.translatesAutoresizingMaskIntoConstraints = false

    detailPane.wantsLayer = true
    detailPane.layer?.backgroundColor = palette.windowBackground.cgColor
    detailPane.translatesAutoresizingMaskIntoConstraints = false

    splitHost.translatesAutoresizingMaskIntoConstraints = false
    splitHost.addSubview(treeScroll)
    splitHost.addSubview(splitDivider)
    splitHost.addSubview(detailPane)

    addSubview(toolbar)
    addSubview(splitHost)

    NSLayoutConstraint.activate([
      toolbar.topAnchor.constraint(equalTo: topAnchor),
      toolbar.leadingAnchor.constraint(equalTo: leadingAnchor),
      toolbar.trailingAnchor.constraint(equalTo: trailingAnchor),
      toolbar.heightAnchor.constraint(equalToConstant: 40),

      summaryGlyph.leadingAnchor.constraint(equalTo: toolbar.leadingAnchor, constant: 14),
      summaryGlyph.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),
      summaryGlyph.widthAnchor.constraint(equalToConstant: 16),
      summaryGlyph.heightAnchor.constraint(equalToConstant: 16),

      summaryLabel.leadingAnchor.constraint(equalTo: summaryGlyph.trailingAnchor, constant: 8),
      summaryLabel.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),
      summaryLabel.trailingAnchor.constraint(lessThanOrEqualTo: clearSecretBtn.leadingAnchor, constant: -10),

      clearSecretBtn.trailingAnchor.constraint(equalTo: toolbar.trailingAnchor, constant: -12),
      clearSecretBtn.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),
      clearSecretBtn.heightAnchor.constraint(equalToConstant: 24),
      clearSecretBtn.widthAnchor.constraint(greaterThanOrEqualToConstant: 118),

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
      treeScroll.widthAnchor.constraint(equalToConstant: 296),

      splitDivider.topAnchor.constraint(equalTo: splitHost.topAnchor),
      splitDivider.leadingAnchor.constraint(equalTo: treeScroll.trailingAnchor),
      splitDivider.bottomAnchor.constraint(equalTo: splitHost.bottomAnchor),
      splitDivider.widthAnchor.constraint(equalToConstant: 1),

      detailPane.topAnchor.constraint(equalTo: splitHost.topAnchor),
      detailPane.leadingAnchor.constraint(equalTo: splitDivider.trailingAnchor),
      detailPane.trailingAnchor.constraint(equalTo: splitHost.trailingAnchor),
      detailPane.bottomAnchor.constraint(equalTo: splitHost.bottomAnchor)
    ])
  }

  override func load(item: LumenPreviewItem, context: LumenPreviewContext) {
    clearSecretsAndArchive()
    super.load(item: item, context: context)
    loadGeneration += 1
    let gen = loadGeneration

    summaryGlyph.configure(identity: item.identity, isDark: palette.isDark, size: 16)

    let format: String
    if case .archive(let fmt) = item.kind {
      format = fmt.lowercased()
    } else {
      format = item.identity.subtype.lowercased()
    }

    guard format == "zip" else {
      summaryLabel.stringValue = "\(item.identity.displayName) · 只读检视"
      showWholeArchiveNotice(
        identity: item.identity,
        title: item.title,
        message: LumenZipError.unsupportedArchiveFormat(format.isEmpty ? "ARCHIVE" : format).localizedDescription,
        localURL: item.localURL
      )
      return
    }

    summaryLabel.stringValue = "正在读取 ZIP 中央目录…"
    showDetailPlaceholder("正在读取中央目录（不解压至磁盘）…")

    if let url = item.localURL, FileManager.default.fileExists(atPath: url.path) {
      let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
      let fileSize = (attrs?[.size] as? Int64) ?? item.byteSize
      if fileSize > Int64(LumenZipLimits.maxArchiveBytes) {
        presentArchiveError(LumenZipError.archiveTooLarge(fileSize), item: item)
        return
      }
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        do {
          let data = try Data(contentsOf: url, options: .mappedIfSafe)
          let parsed = try LumenZipArchive.parse(data: data)
          DispatchQueue.main.async {
            guard let self, self.loadGeneration == gen else { return }
            self.applyParsedArchive(parsed, item: item)
          }
        } catch {
          DispatchQueue.main.async {
            guard let self, self.loadGeneration == gen else { return }
            self.presentArchiveError(error, item: item)
          }
        }
      }
      return
    }

    guard let clip = item.clipboardItem else {
      presentArchiveError(LumenZipError.corruptData("归档文件不可用"), item: item)
      return
    }
    if item.byteSize > Int64(LumenZipLimits.maxArchiveBytes) {
      presentArchiveError(LumenZipError.archiveTooLarge(item.byteSize), item: item)
      return
    }

    context.store.api.fetchItemFileData(id: clip.id, index: item.fileIndex ?? 0) { [weak self] result in
      guard let self, self.loadGeneration == gen else { return }
      switch result {
      case .success(let (data, _)):
        DispatchQueue.global(qos: .userInitiated).async {
          do {
            let parsed = try LumenZipArchive.parse(data: data)
            DispatchQueue.main.async {
              guard self.loadGeneration == gen else { return }
              self.applyParsedArchive(parsed, item: item)
            }
          } catch {
            DispatchQueue.main.async {
              guard self.loadGeneration == gen else { return }
              self.presentArchiveError(error, item: item)
            }
          }
        }
      case .failure(let err):
        self.presentArchiveError(err, item: item)
      }
    }
  }

  private func applyParsedArchive(_ parsed: LumenZipArchive, item: LumenPreviewItem) {
    archive = parsed
    treeScroll.isHidden = false
    splitDivider.isHidden = false

    var parts: [String] = ["ZIP 归档"]
    if parsed.entriesTruncated {
      parts.append("显示前 \(parsed.treeNodes.count) 项（共 \(parsed.totalRawEntryCount) 项）")
    } else {
      parts.append("\(parsed.treeNodes.count) 项")
    }
    parts.append("解压总计 \(LumenFormatters.byteCount(parsed.totalUncompressedBytes))")
    if parsed.encryptedFileCount > 0 {
      parts.append("加密 \(parsed.encryptedFileCount) 项")
    }
    parts.append("只读内存预览")
    summaryLabel.stringValue = parts.joined(separator: " · ")

    treeTable.reloadData()
    // Auto-select first non-directory member if available, otherwise first node
    if let firstFileIdx = parsed.treeNodes.firstIndex(where: { !$0.isDirectory }) {
      selectTreeRow(firstFileIdx)
    } else if !parsed.treeNodes.isEmpty {
      selectTreeRow(0)
    } else {
      showDetailPlaceholder("此 ZIP 归档为空目录")
    }
  }

  private func presentArchiveError(_ error: Error, item: LumenPreviewItem) {
    summaryLabel.stringValue = "\(item.identity.displayName) · 无法解析"
    showWholeArchiveNotice(
      identity: item.identity,
      title: item.title,
      message: error.localizedDescription,
      localURL: item.localURL
    )
  }

  private func showWholeArchiveNotice(identity: LumenContentIdentity, title: String, message: String, localURL: URL?) {
    treeScroll.isHidden = true
    splitDivider.isHidden = true
    detailPane.subviews.forEach { $0.removeFromSuperview() }
    currentPreviewPlainText = nil

    let glyph = LumenIdentityGlyphView(size: 52)
    glyph.configure(identity: identity, isDark: palette.isDark, size: 52)
    glyph.translatesAutoresizingMaskIntoConstraints = false

    let heading = NSTextField(labelWithString: title)
    heading.font = .systemFont(ofSize: 17, weight: .semibold)
    heading.textColor = palette.ink
    heading.alignment = .center
    heading.lineBreakMode = .byTruncatingMiddle

    let desc = NSTextField(wrappingLabelWithString: message)
    desc.font = .systemFont(ofSize: 12.5)
    desc.textColor = palette.muted
    desc.alignment = .center

    var views: [NSView] = [glyph, heading, desc]
    if localURL != nil {
      let revealBtn = makeCompactButton(title: "在访达中显示", action: #selector(revealArchiveInFinder))
      views.append(revealBtn)
    }

    let stack = NSStackView(views: views)
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 10
    stack.setCustomSpacing(16, after: desc)
    stack.translatesAutoresizingMaskIntoConstraints = false

    detailPane.addSubview(stack)
    NSLayoutConstraint.activate([
      glyph.widthAnchor.constraint(equalToConstant: 52),
      glyph.heightAnchor.constraint(equalToConstant: 52),
      heading.widthAnchor.constraint(lessThanOrEqualToConstant: 460),
      desc.widthAnchor.constraint(lessThanOrEqualToConstant: 460),
      stack.centerXAnchor.constraint(equalTo: detailPane.centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: detailPane.centerYAnchor)
    ])
  }

  // MARK: Tree Selection & Member Preview

  private func selectTreeRow(_ row: Int) {
    guard let archive, row >= 0, row < archive.treeNodes.count else { return }
    selectedRowIndex = row
    treeTable.reloadData()
    treeTable.scrollRowToVisible(row)
    renderMemberDetail(archive.treeNodes[row])
  }

  private func renderMemberDetail(_ entry: LumenZipEntry) {
    detailPane.subviews.forEach { $0.removeFromSuperview() }
    inlinePasswordField = nil
    inlinePasswordErrorLabel = nil
    currentPreviewPlainText = nil

    if entry.isUnsafePath {
      showMemberStatusCard(
        identity: LumenContentIdentityRegistry.shared.identity(forCategory: .otherFile),
        title: entry.rawPath,
        subtitle: "安全防护 · 已阻止读取",
        body: LumenZipError.pathTraversalBlocked(entry.rawPath).localizedDescription
      )
      return
    }

    if entry.isDirectory {
      let dirIdentity = LumenContentIdentity(
        family: .file, subtype: "folder", language: nil, confidence: .confirmed,
        glyphID: "folder", displayName: "文件夹", logicalCategory: .otherFile,
        rendererID: nil, previewAvailability: .ready, lightColorHex: "#6286bb"
      )
      showMemberStatusCard(
        identity: dirIdentity,
        title: entry.cleanPath + "/",
        subtitle: "归档目录 · 包含 \(entry.childCount) 个直接条目",
        body: "目录结构仅在内存中只读浏览，不会解压到本机磁盘。"
      )
      return
    }

    let memberIdentity = LumenContentIdentityRegistry.shared.identity(forFilePath: entry.cleanPath)

    if entry.encryption == .aesUnsupported {
      showMemberStatusCard(
        identity: memberIdentity,
        title: entry.cleanPath,
        subtitle: "\(memberIdentity.displayName) · \(LumenFormatters.byteCount(Int64(entry.uncompressedSize))) · AES 加密",
        body: LumenZipError.aesEncryptionUnsupported.localizedDescription
      )
      return
    }
    if entry.encryption == .strongUnsupported {
      showMemberStatusCard(
        identity: memberIdentity,
        title: entry.cleanPath,
        subtitle: "\(memberIdentity.displayName) · \(LumenFormatters.byteCount(Int64(entry.uncompressedSize))) · 强加密",
        body: LumenZipError.strongEncryptionUnsupported.localizedDescription
      )
      return
    }

    if Int(entry.uncompressedSize) > LumenZipLimits.maxMemberUncompressedBytes {
      showMemberStatusCard(
        identity: memberIdentity,
        title: entry.cleanPath,
        subtitle: "\(memberIdentity.displayName) · 原始 \(LumenFormatters.byteCount(Int64(entry.uncompressedSize))) · 压缩 \(LumenFormatters.byteCount(Int64(entry.compressedSize)))",
        body: LumenZipError.memberTooLarge(Int64(entry.uncompressedSize)).localizedDescription
      )
      return
    }

    if let cached = decryptedCache[entry.id] {
      renderDecryptedBytes(cached, for: entry, identity: memberIdentity)
      return
    }

    if entry.encryption == .zipCrypto {
      if let existingPassword = sessionPassword, let archive {
        do {
          let bytes = try archive.extractMember(entry, password: existingPassword)
          decryptedCache[entry.id] = bytes
          clearSecretBtn.isHidden = false
          renderDecryptedBytes(bytes, for: entry, identity: memberIdentity)
          return
        } catch {
          // Current session password didn't match this entry -> fall through to inline prompt
        }
      }
      showInlinePasswordPrompt(for: entry, identity: memberIdentity, initialError: nil)
      return
    }

    // Unencrypted member: extract in memory with full bounds + CRC-32 check
    do {
      guard let archive else { return }
      let bytes = try archive.extractMember(entry, password: nil)
      renderDecryptedBytes(bytes, for: entry, identity: memberIdentity)
    } catch {
      showMemberStatusCard(
        identity: memberIdentity,
        title: entry.cleanPath,
        subtitle: "\(memberIdentity.displayName) · \(LumenFormatters.byteCount(Int64(entry.uncompressedSize)))",
        body: error.localizedDescription
      )
    }
  }

  private func showInlinePasswordPrompt(for entry: LumenZipEntry, identity: LumenContentIdentity, initialError: String?) {
    detailPane.subviews.forEach { $0.removeFromSuperview() }

    let glyph = LumenIdentityGlyphView(size: 40)
    glyph.configure(identity: identity, isDark: palette.isDark, size: 40)
    glyph.translatesAutoresizingMaskIntoConstraints = false

    let lockBadge = NSImageView(image: LumenVectorGlyphs.actionImage(.lock, size: 15, color: palette.warning))
    lockBadge.translatesAutoresizingMaskIntoConstraints = false

    let titleRow = NSStackView(views: [lockBadge, NSTextField(labelWithString: entry.name)])
    titleRow.orientation = .horizontal
    titleRow.alignment = .centerY
    titleRow.spacing = 6
    if let titleFld = titleRow.arrangedSubviews.last as? NSTextField {
      titleFld.font = .systemFont(ofSize: 15, weight: .semibold)
      titleFld.textColor = palette.ink
      titleFld.lineBreakMode = .byTruncatingMiddle
    }

    let meta = NSTextField(labelWithString: "\(entry.cleanPath) · \(LumenFormatters.byteCount(Int64(entry.uncompressedSize))) · ZipCrypto 加密")
    meta.font = .monospacedDigitSystemFont(ofSize: 11.5, weight: .regular)
    meta.textColor = palette.muted
    meta.lineBreakMode = .byTruncatingMiddle

    let hint = NSTextField(labelWithString: "输入密码即可在内存中只读校验并预览；密码不落盘、不写日志，关闭即清除。")
    hint.font = .systemFont(ofSize: 11.5)
    hint.textColor = palette.muted

    let pwField = NSSecureTextField()
    pwField.placeholderString = "输入 ZipCrypto 解密密码"
    pwField.font = .systemFont(ofSize: 13)
    pwField.target = self
    pwField.action = #selector(submitInlinePassword)
    pwField.delegate = self
    pwField.translatesAutoresizingMaskIntoConstraints = false
    inlinePasswordField = pwField

    let unlockBtn = makeCompactButton(title: "解锁预览", action: #selector(submitInlinePassword), accent: true)

    let inputRow = NSStackView(views: [pwField, unlockBtn])
    inputRow.orientation = .horizontal
    inputRow.alignment = .centerY
    inputRow.spacing = 8
    inputRow.translatesAutoresizingMaskIntoConstraints = false

    let errLbl = NSTextField(labelWithString: initialError ?? "")
    errLbl.font = .systemFont(ofSize: 11.5, weight: .medium)
    errLbl.textColor = palette.danger
    errLbl.isHidden = (initialError == nil || initialError?.isEmpty == true)
    inlinePasswordErrorLabel = errLbl

    let stack = NSStackView(views: [glyph, titleRow, meta, hint, inputRow, errLbl])
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 9
    stack.setCustomSpacing(14, after: hint)
    stack.translatesAutoresizingMaskIntoConstraints = false

    detailPane.addSubview(stack)
    NSLayoutConstraint.activate([
      glyph.widthAnchor.constraint(equalToConstant: 40),
      glyph.heightAnchor.constraint(equalToConstant: 40),
      lockBadge.widthAnchor.constraint(equalToConstant: 15),
      lockBadge.heightAnchor.constraint(equalToConstant: 15),
      pwField.widthAnchor.constraint(equalToConstant: 240),
      stack.centerXAnchor.constraint(equalTo: detailPane.centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: detailPane.centerYAnchor),
      stack.leadingAnchor.constraint(greaterThanOrEqualTo: detailPane.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(lessThanOrEqualTo: detailPane.trailingAnchor, constant: -24)
    ])

    window?.makeFirstResponder(pwField)
  }

  @objc private func submitInlinePassword() {
    guard let archive,
          selectedRowIndex >= 0,
          selectedRowIndex < archive.treeNodes.count,
          let pwField = inlinePasswordField else { return }
    let entry = archive.treeNodes[selectedRowIndex]
    let candidate = pwField.stringValue
    guard !candidate.isEmpty else {
      inlinePasswordErrorLabel?.stringValue = "请输入密码后再试。"
      inlinePasswordErrorLabel?.isHidden = false
      return
    }

    do {
      let data = try archive.extractMember(entry, password: candidate)
      // Store password ONLY in ephemeral view memory (cleared on teardown/switch)
      sessionPassword = candidate
      decryptedCache[entry.id] = data
      clearSecretBtn.isHidden = false
      treeTable.reloadData()
      let identity = LumenContentIdentityRegistry.shared.identity(forFilePath: entry.cleanPath)
      renderDecryptedBytes(data, for: entry, identity: identity)
    } catch {
      pwField.stringValue = ""
      inlinePasswordErrorLabel?.stringValue = error.localizedDescription
      inlinePasswordErrorLabel?.isHidden = false
      window?.makeFirstResponder(pwField)
    }
  }

  private func renderDecryptedBytes(_ data: Data, for entry: LumenZipEntry, identity: LumenContentIdentity) {
    detailPane.subviews.forEach { $0.removeFromSuperview() }
    currentPreviewPlainText = nil

    // Header bar for selected member
    let header = NSView()
    header.wantsLayer = true
    header.layer?.backgroundColor = palette.surface.cgColor
    header.translatesAutoresizingMaskIntoConstraints = false
    let headerLine = NSView()
    headerLine.wantsLayer = true
    headerLine.layer?.backgroundColor = palette.border.cgColor
    headerLine.translatesAutoresizingMaskIntoConstraints = false

    let memberGlyph = LumenIdentityGlyphView(size: 16)
    memberGlyph.configure(identity: identity, isDark: palette.isDark, size: 16)
    memberGlyph.translatesAutoresizingMaskIntoConstraints = false

    let pathLbl = NSTextField(labelWithString: entry.cleanPath)
    pathLbl.font = .systemFont(ofSize: 12, weight: .semibold)
    pathLbl.textColor = palette.ink
    pathLbl.lineBreakMode = .byTruncatingMiddle
    pathLbl.translatesAutoresizingMaskIntoConstraints = false

    let metaText = "\(identity.displayName) · \(LumenFormatters.byteCount(Int64(data.count)))"
      + (entry.isEncrypted ? " · 已校验解锁" : "")
    let metaLbl = NSTextField(labelWithString: metaText)
    metaLbl.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
    metaLbl.textColor = palette.muted
    metaLbl.translatesAutoresizingMaskIntoConstraints = false

    let copyMemberBtn = makeCompactButton(title: "复制文本", action: #selector(copyMemberTextClicked))
    copyMemberBtn.isHidden = true

    header.addSubview(memberGlyph)
    header.addSubview(pathLbl)
    header.addSubview(metaLbl)
    header.addSubview(copyMemberBtn)
    header.addSubview(headerLine)

    let bodyHost = NSView()
    bodyHost.translatesAutoresizingMaskIntoConstraints = false

    detailPane.addSubview(header)
    detailPane.addSubview(bodyHost)

    NSLayoutConstraint.activate([
      header.topAnchor.constraint(equalTo: detailPane.topAnchor),
      header.leadingAnchor.constraint(equalTo: detailPane.leadingAnchor),
      header.trailingAnchor.constraint(equalTo: detailPane.trailingAnchor),
      header.heightAnchor.constraint(equalToConstant: 36),

      memberGlyph.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 12),
      memberGlyph.centerYAnchor.constraint(equalTo: header.centerYAnchor),
      memberGlyph.widthAnchor.constraint(equalToConstant: 16),
      memberGlyph.heightAnchor.constraint(equalToConstant: 16),

      pathLbl.leadingAnchor.constraint(equalTo: memberGlyph.trailingAnchor, constant: 7),
      pathLbl.centerYAnchor.constraint(equalTo: header.centerYAnchor),
      pathLbl.trailingAnchor.constraint(lessThanOrEqualTo: metaLbl.leadingAnchor, constant: -10),

      metaLbl.trailingAnchor.constraint(equalTo: copyMemberBtn.leadingAnchor, constant: -10),
      metaLbl.centerYAnchor.constraint(equalTo: header.centerYAnchor),

      copyMemberBtn.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -12),
      copyMemberBtn.centerYAnchor.constraint(equalTo: header.centerYAnchor),
      copyMemberBtn.heightAnchor.constraint(equalToConstant: 24),

      headerLine.leadingAnchor.constraint(equalTo: header.leadingAnchor),
      headerLine.trailingAnchor.constraint(equalTo: header.trailingAnchor),
      headerLine.bottomAnchor.constraint(equalTo: header.bottomAnchor),
      headerLine.heightAnchor.constraint(equalToConstant: 1),

      bodyHost.topAnchor.constraint(equalTo: header.bottomAnchor),
      bodyHost.leadingAnchor.constraint(equalTo: detailPane.leadingAnchor),
      bodyHost.trailingAnchor.constraint(equalTo: detailPane.trailingAnchor),
      bodyHost.bottomAnchor.constraint(equalTo: detailPane.bottomAnchor)
    ])

    // 1. Image member
    if identity.family == .image, let img = NSImage(data: data) {
      let iv = NSImageView(image: img)
      iv.imageScaling = .scaleProportionallyDown
      iv.translatesAutoresizingMaskIntoConstraints = false
      bodyHost.addSubview(iv)
      NSLayoutConstraint.activate([
        iv.topAnchor.constraint(equalTo: bodyHost.topAnchor, constant: 18),
        iv.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor, constant: 18),
        iv.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor, constant: -18),
        iv.bottomAnchor.constraint(equalTo: bodyHost.bottomAnchor, constant: -18)
      ])
      return
    }

    // 2. Check if data is clean UTF-8 text (reject binary NUL bytes)
    let hasBinaryNul = data.prefix(8192).contains(0)
    if !hasBinaryNul, let rawText = String(data: data, encoding: .utf8) {
      let truncated = rawText.count > LumenZipLimits.maxTextPreviewChars
      let shownText = truncated
        ? String(rawText.prefix(LumenZipLimits.maxTextPreviewChars)) + "\n\n…（已达到 12,000 字符只读预览上限）"
        : rawText
      currentPreviewPlainText = rawText
      copyMemberBtn.isHidden = false

      // 2a. CSV member -> native read-only CSV table (max 250 rows)
      if identity.subtype == "csv" {
        let table = LumenCSVTableView(palette: palette)
        table.loadCSV(text: rawText)
        table.translatesAutoresizingMaskIntoConstraints = false
        bodyHost.addSubview(table)
        NSLayoutConstraint.activate([
          table.topAnchor.constraint(equalTo: bodyHost.topAnchor),
          table.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
          table.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
          table.bottomAnchor.constraint(equalTo: bodyHost.bottomAnchor)
        ])
        return
      }

      // 2b. Code or plain text member
      let isCode = (identity.family == .code)
      let scroll = NSScrollView()
      scroll.hasVerticalScroller = true
      scroll.hasHorizontalScroller = isCode
      scroll.drawsBackground = true
      scroll.backgroundColor = isCode ? palette.codeBackground : palette.windowBackground
      scroll.borderType = .noBorder
      scroll.translatesAutoresizingMaskIntoConstraints = false

      let tv = NSTextView()
      tv.isEditable = false
      tv.isSelectable = true
      tv.drawsBackground = true
      tv.backgroundColor = isCode ? palette.codeBackground : palette.windowBackground
      tv.textContainerInset = NSSize(width: 16, height: 14)
      tv.isVerticallyResizable = true
      tv.isHorizontallyResizable = isCode
      tv.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
      tv.textContainer?.widthTracksTextView = !isCode
      if isCode {
        tv.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        let lang = identity.language ?? "unknown"
        let highlighted = LumenSyntaxHighlighter.highlight(shownText, language: lang, fontSize: 12.5, darkCanvas: true)
        tv.textStorage?.setAttributedString(highlighted)
      } else {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineHeightMultiple = 1.5
        tv.textStorage?.setAttributedString(NSAttributedString(string: shownText, attributes: [
          .font: NSFont.systemFont(ofSize: 13),
          .foregroundColor: palette.ink,
          .paragraphStyle: paragraph
        ]))
      }

      scroll.documentView = tv
      bodyHost.addSubview(scroll)
      NSLayoutConstraint.activate([
        scroll.topAnchor.constraint(equalTo: bodyHost.topAnchor),
        scroll.leadingAnchor.constraint(equalTo: bodyHost.leadingAnchor),
        scroll.trailingAnchor.constraint(equalTo: bodyHost.trailingAnchor),
        scroll.bottomAnchor.constraint(equalTo: bodyHost.bottomAnchor)
      ])
      return
    }

    // 3. Binary member summary (read-only, never executed)
    let info = NSTextField(wrappingLabelWithString: "二进制成员（\(identity.displayName)，\(LumenFormatters.byteCount(Int64(data.count)))，CRC-32: \(String(format: "%08X", entry.crc32))）。归档预览为只读模式，不执行或解压二进制内容。")
    info.font = .systemFont(ofSize: 12.5)
    info.textColor = palette.muted
    info.alignment = .center
    info.translatesAutoresizingMaskIntoConstraints = false
    bodyHost.addSubview(info)
    NSLayoutConstraint.activate([
      info.centerXAnchor.constraint(equalTo: bodyHost.centerXAnchor),
      info.centerYAnchor.constraint(equalTo: bodyHost.centerYAnchor),
      info.widthAnchor.constraint(lessThanOrEqualToConstant: 420)
    ])
  }

  private func showMemberStatusCard(identity: LumenContentIdentity, title: String, subtitle: String, body: String) {
    let glyph = LumenIdentityGlyphView(size: 44)
    glyph.configure(identity: identity, isDark: palette.isDark, size: 44)
    glyph.translatesAutoresizingMaskIntoConstraints = false

    let t = NSTextField(labelWithString: title)
    t.font = .systemFont(ofSize: 15, weight: .semibold)
    t.textColor = palette.ink
    t.alignment = .center
    t.lineBreakMode = .byTruncatingMiddle

    let sub = NSTextField(labelWithString: subtitle)
    sub.font = .monospacedDigitSystemFont(ofSize: 11.5, weight: .regular)
    sub.textColor = palette.muted
    sub.alignment = .center

    let desc = NSTextField(wrappingLabelWithString: body)
    desc.font = .systemFont(ofSize: 12.5)
    desc.textColor = palette.muted
    desc.alignment = .center

    let stack = NSStackView(views: [glyph, t, sub, desc])
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 8
    stack.translatesAutoresizingMaskIntoConstraints = false
    detailPane.addSubview(stack)
    NSLayoutConstraint.activate([
      glyph.widthAnchor.constraint(equalToConstant: 44),
      glyph.heightAnchor.constraint(equalToConstant: 44),
      t.widthAnchor.constraint(lessThanOrEqualToConstant: 440),
      desc.widthAnchor.constraint(lessThanOrEqualToConstant: 440),
      stack.centerXAnchor.constraint(equalTo: detailPane.centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: detailPane.centerYAnchor)
    ])
  }

  private func showDetailPlaceholder(_ text: String) {
    detailPane.subviews.forEach { $0.removeFromSuperview() }
    let lbl = NSTextField(labelWithString: text)
    lbl.font = .systemFont(ofSize: 13)
    lbl.textColor = palette.muted
    lbl.translatesAutoresizingMaskIntoConstraints = false
    detailPane.addSubview(lbl)
    NSLayoutConstraint.activate([
      lbl.centerXAnchor.constraint(equalTo: detailPane.centerXAnchor),
      lbl.centerYAnchor.constraint(equalTo: detailPane.centerYAnchor)
    ])
  }

  private func makeCompactButton(title: String, action: Selector, accent: Bool = false) -> NSButton {
    let btn = NSButton(title: title, target: self, action: action)
    btn.isBordered = false
    btn.wantsLayer = true
    btn.font = .systemFont(ofSize: 11.5, weight: .semibold)
    btn.contentTintColor = accent ? .white : palette.ink
    btn.attributedTitle = NSAttributedString(string: title, attributes: [
      .font: NSFont.systemFont(ofSize: 11.5, weight: .semibold),
      .foregroundColor: accent ? NSColor.white : palette.ink
    ])
    btn.layer?.cornerRadius = 7
    btn.layer?.cornerCurve = .continuous
    btn.layer?.borderWidth = 1
    btn.layer?.borderColor = (accent ? NSColor.white.withAlphaComponent(0.14) : palette.border).cgColor
    btn.layer?.backgroundColor = (accent ? palette.accent : palette.surfaceElevated).cgColor
    btn.translatesAutoresizingMaskIntoConstraints = false
    btn.heightAnchor.constraint(equalToConstant: 26).isActive = true
    btn.widthAnchor.constraint(greaterThanOrEqualToConstant: 78).isActive = true
    return btn
  }

  // MARK: Actions & Lifecycle Cleanup (Wipes Secrets & Decrypted Cache)

  @objc private func treeRowClicked() {
    let row = treeTable.clickedRow
    if row >= 0 { selectTreeRow(row) }
  }

  @objc private func clearDecryptionStateClicked() {
    sessionPassword = nil
    decryptedCache.removeAll()
    clearSecretBtn.isHidden = true
    treeTable.reloadData()
    if let archive, selectedRowIndex >= 0, selectedRowIndex < archive.treeNodes.count {
      renderMemberDetail(archive.treeNodes[selectedRowIndex])
    }
    currentContext?.onToast("已锁定归档并清除内存解密缓存")
  }

  @objc private func copyMemberTextClicked() {
    guard let text = currentPreviewPlainText else { return }
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setString(text, forType: .string)
    currentContext?.onToast("已复制成员文本")
  }

  @objc private func revealArchiveInFinder() {
    if let url = currentItem?.localURL {
      NSWorkspace.shared.activateFileViewerSelecting([url])
    }
  }

  private func clearSecretsAndArchive() {
    sessionPassword = nil
    decryptedCache.removeAll()
    currentPreviewPlainText = nil
    archive = nil
    selectedRowIndex = -1
    clearSecretBtn.isHidden = true
  }

  override func copyPrimaryContent() {
    if let text = currentPreviewPlainText {
      let pb = NSPasteboard.general
      pb.clearContents()
      pb.setString(text, forType: .string)
      currentContext?.onToast("已复制成员文本")
      return
    }
    super.copyPrimaryContent()
  }

  override func teardown() {
    loadGeneration += 1
    clearSecretsAndArchive()
    detailPane.subviews.forEach { $0.removeFromSuperview() }
  }

  // MARK: NSTableViewDataSource / Delegate

  func numberOfRows(in tableView: NSTableView) -> Int {
    archive?.treeNodes.count ?? 0
  }

  func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
    guard let archive, row < archive.treeNodes.count else { return nil }
    let entry = archive.treeNodes[row]
    let selected = row == selectedRowIndex

    let cell = NSView()
    cell.wantsLayer = true
    cell.layer?.cornerRadius = 7
    cell.layer?.cornerCurve = .continuous
    cell.layer?.backgroundColor = (selected ? palette.accentSoft : NSColor.clear).cgColor
    cell.layer?.borderWidth = selected ? 1 : 0
    cell.layer?.borderColor = (selected ? palette.accentBorder : NSColor.clear).cgColor

    let memberIdentity: LumenContentIdentity
    if entry.isDirectory {
      memberIdentity = LumenContentIdentity(
        family: .file, subtype: "folder", language: nil, confidence: .confirmed,
        glyphID: "folder", displayName: "文件夹", logicalCategory: .otherFile,
        rendererID: nil, previewAvailability: .ready, lightColorHex: "#6286bb"
      )
    } else {
      memberIdentity = LumenContentIdentityRegistry.shared.identity(forFilePath: entry.cleanPath)
    }

    let glyph = LumenIdentityGlyphView(size: 16)
    glyph.configure(identity: memberIdentity, isDark: palette.isDark, size: 16)
    glyph.translatesAutoresizingMaskIntoConstraints = false

    let nameLbl = NSTextField(labelWithString: entry.name)
    nameLbl.font = .systemFont(ofSize: 12, weight: selected ? .semibold : .regular)
    nameLbl.textColor = entry.isUnsafePath ? palette.danger : palette.ink
    nameLbl.lineBreakMode = .byTruncatingMiddle
    nameLbl.toolTip = entry.rawPath
    nameLbl.translatesAutoresizingMaskIntoConstraints = false

    let lockView = NSImageView()
    lockView.translatesAutoresizingMaskIntoConstraints = false
    if entry.isEncrypted {
      let isUnlocked = decryptedCache[entry.id] != nil
      lockView.image = LumenVectorGlyphs.actionImage(
        isUnlocked ? .unlock : .lock,
        size: 12,
        color: isUnlocked ? palette.success : palette.warning
      )
      lockView.isHidden = false
    } else {
      lockView.isHidden = true
    }

    let sizeText: String
    if entry.isUnsafePath {
      sizeText = "拦截"
    } else if entry.isDirectory {
      sizeText = "\(entry.childCount) 项"
    } else {
      sizeText = LumenFormatters.byteCount(Int64(entry.uncompressedSize))
    }
    let sizeLbl = NSTextField(labelWithString: sizeText)
    sizeLbl.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
    sizeLbl.textColor = entry.isUnsafePath ? palette.danger : palette.muted
    sizeLbl.alignment = .right
    sizeLbl.setContentCompressionResistancePriority(.required, for: .horizontal)
    sizeLbl.translatesAutoresizingMaskIntoConstraints = false

    cell.addSubview(glyph)
    cell.addSubview(nameLbl)
    cell.addSubview(lockView)
    cell.addSubview(sizeLbl)

    let indent = CGFloat(min(6, entry.depth)) * 13.0 + 10.0
    var constraints: [NSLayoutConstraint] = [
      glyph.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: indent),
      glyph.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
      glyph.widthAnchor.constraint(equalToConstant: 16),
      glyph.heightAnchor.constraint(equalToConstant: 16),

      nameLbl.leadingAnchor.constraint(equalTo: glyph.trailingAnchor, constant: 6),
      nameLbl.centerYAnchor.constraint(equalTo: cell.centerYAnchor),

      sizeLbl.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -10),
      sizeLbl.centerYAnchor.constraint(equalTo: cell.centerYAnchor)
    ]

    if entry.isEncrypted {
      constraints.append(contentsOf: [
        lockView.trailingAnchor.constraint(equalTo: sizeLbl.leadingAnchor, constant: -6),
        lockView.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        lockView.widthAnchor.constraint(equalToConstant: 12),
        lockView.heightAnchor.constraint(equalToConstant: 12),
        nameLbl.trailingAnchor.constraint(lessThanOrEqualTo: lockView.leadingAnchor, constant: -5)
      ])
    } else {
      constraints.append(nameLbl.trailingAnchor.constraint(lessThanOrEqualTo: sizeLbl.leadingAnchor, constant: -6))
    }

    NSLayoutConstraint.activate(constraints)
    return cell
  }
}
