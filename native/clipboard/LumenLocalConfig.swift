import Foundation
import SQLite3

/// Resolved local AIH Server connection parameters.
/// Credentials are always discovered from IPC configure, environment variables,
/// or local `~/.ai_home/aih.db` (`app_kv` -> `config:server`) — never hardcoded.
struct LumenEndpointConfig: Equatable {
  let origin: String
  let managementKey: String

  var isValid: Bool {
    !origin.isEmpty && !managementKey.isEmpty
  }
}

enum LumenLocalConfigLoader {
  private static let defaultHost = "127.0.0.1"
  private static let defaultPort = 9527

  /// Resolves the local server endpoint and management key using:
  /// 1. Explicit runtime parameters (e.g. IPC configure from aih-server)
  /// 2. Process environment (`AIH_SERVER_ORIGIN` / `AIH_SERVER_PORT` + `AIH_SERVER_MANAGEMENT_KEY`)
  /// 3. Local SQLite config (`~/.ai_home/aih.db`, table `app_kv`, key `config:server`)
  static func resolve(explicitOrigin: String = "", explicitKey: String = "") -> LumenEndpointConfig {
    let cleanExplicitOrigin = normalizeOrigin(explicitOrigin)
    let cleanExplicitKey = explicitKey.trimmingCharacters(in: .whitespacesAndNewlines)
    if !cleanExplicitOrigin.isEmpty && !cleanExplicitKey.isEmpty {
      return LumenEndpointConfig(origin: cleanExplicitOrigin, managementKey: cleanExplicitKey)
    }

    let env = ProcessInfo.processInfo.environment
    let envKey = (env["AIH_SERVER_MANAGEMENT_KEY"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let envOrigin = resolveOriginFromEnvironment(env)

    let dbConfig = readFromLocalSQLite(aiHomeDir: resolveAIHomeDir(env: env))

    let finalOrigin = !cleanExplicitOrigin.isEmpty ? cleanExplicitOrigin :
      (!envOrigin.isEmpty ? envOrigin : (dbConfig?.origin ?? "http://\(defaultHost):\(defaultPort)"))
    let finalKey = !cleanExplicitKey.isEmpty ? cleanExplicitKey :
      (!envKey.isEmpty ? envKey : (dbConfig?.managementKey ?? ""))

    return LumenEndpointConfig(origin: normalizeOrigin(finalOrigin), managementKey: finalKey)
  }

  static func resolveAIHomeDir(env: [String: String] = ProcessInfo.processInfo.environment) -> String {
    if let custom = env["AIH_HOME_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines), !custom.isEmpty {
      return (custom as NSString).expandingTildeInPath
    }
    return FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".ai_home", isDirectory: true)
      .path
  }

  static func normalizeOrigin(_ raw: String) -> String {
    raw.trimmingCharacters(in: .whitespacesAndNewlines)
      .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
  }

  private static func resolveOriginFromEnvironment(_ env: [String: String]) -> String {
    if let origin = env["AIH_SERVER_ORIGIN"]?.trimmingCharacters(in: .whitespacesAndNewlines), !origin.isEmpty {
      return normalizeOrigin(origin)
    }
    if let rawPort = env["AIH_SERVER_PORT"]?.trimmingCharacters(in: .whitespacesAndNewlines),
       let port = Int(rawPort), port >= 1 && port <= 65535 {
      let host = normalizeHost(env["AIH_SERVER_HOST"] ?? defaultHost)
      return "http://\(host):\(port)"
    }
    return ""
  }

  private static func normalizeHost(_ raw: String) -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty || trimmed == "0.0.0.0" || trimmed == "::" {
      return defaultHost
    }
    return trimmed
  }

  private static func readFromLocalSQLite(aiHomeDir: String) -> LumenEndpointConfig? {
    let dbPath = (aiHomeDir as NSString).appendingPathComponent("aih.db")
    guard FileManager.default.fileExists(atPath: dbPath) else { return nil }

    var db: OpaquePointer?
    let openFlags = SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX
    guard sqlite3_open_v2(dbPath, &db, openFlags, nil) == SQLITE_OK, let handle = db else {
      if let handle = db { sqlite3_close(handle) }
      return nil
    }
    defer { sqlite3_close(handle) }
    sqlite3_busy_timeout(handle, 2000)

    let sql = "SELECT value FROM app_kv WHERE key = 'config:server' LIMIT 1"
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK, let statement = stmt else {
      return nil
    }
    defer { sqlite3_finalize(statement) }

    guard sqlite3_step(statement) == SQLITE_ROW,
          let rawPtr = sqlite3_column_text(statement, 0) else {
      return nil
    }
    let jsonText = String(cString: rawPtr)
    guard let data = jsonText.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return nil
    }

    let host = normalizeHost(obj["host"] as? String ?? defaultHost)
    let port: Int
    if let intPort = obj["port"] as? Int, intPort >= 1 && intPort <= 65535 {
      port = intPort
    } else if let numPort = obj["port"] as? NSNumber, numPort.intValue >= 1 && numPort.intValue <= 65535 {
      port = numPort.intValue
    } else if let strPort = obj["port"] as? String, let parsed = Int(strPort), parsed >= 1 && parsed <= 65535 {
      port = parsed
    } else {
      port = defaultPort
    }
    let key = (obj["managementKey"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    return LumenEndpointConfig(origin: "http://\(host):\(port)", managementKey: key)
  }
}
