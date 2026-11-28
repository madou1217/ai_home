using System.Globalization;
using System.IO;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace AihLumenClipboard;

/// <summary>
/// Resolved local AIH Server connection parameters.
/// Credentials are always discovered from IPC configure, environment variables,
/// or local %USERPROFILE%\.ai_home\aih.db (app_kv -> config:server) — never hardcoded.
/// </summary>
public readonly record struct LumenEndpointConfig(string Origin, string ManagementKey)
{
    public bool IsValid => !string.IsNullOrWhiteSpace(Origin) && !string.IsNullOrWhiteSpace(ManagementKey);
}

public static class LumenLocalConfigLoader
{
    private const string DefaultHost = "127.0.0.1";
    private const int DefaultPort = 9527;

    /// <summary>
    /// Resolves (origin, managementKey) in strict contract order:
    /// 1. Explicit IPC configure parameters (clipboardOrigin, clipboardKey)
    /// 2. Process environment (AIH_SERVER_ORIGIN or AIH_SERVER_HOST + AIH_SERVER_PORT, AIH_SERVER_MANAGEMENT_KEY, AIH_HOME_DIR)
    /// 3. Local SQLite read-only lookup at &lt;AIH_HOME&gt;\aih.db (SELECT value FROM app_kv WHERE key = 'config:server')
    /// </summary>
    public static LumenEndpointConfig Resolve(string? explicitOrigin = null, string? explicitKey = null)
    {
        var cleanExplicitOrigin = NormalizeOrigin(explicitOrigin);
        var cleanExplicitKey = (explicitKey ?? string.Empty).Trim();
        if (!string.IsNullOrEmpty(cleanExplicitOrigin) && !string.IsNullOrEmpty(cleanExplicitKey))
        {
            return new LumenEndpointConfig(cleanExplicitOrigin, cleanExplicitKey);
        }

        var envOrigin = ResolveOriginFromEnvironment();
        var envKey = (Environment.GetEnvironmentVariable("AIH_SERVER_MANAGEMENT_KEY") ?? string.Empty).Trim();

        LumenEndpointConfig? dbConfig = null;
        if (string.IsNullOrEmpty(cleanExplicitOrigin) && string.IsNullOrEmpty(envOrigin)
            || string.IsNullOrEmpty(cleanExplicitKey) && string.IsNullOrEmpty(envKey))
        {
            dbConfig = ReadFromLocalSqlite(ResolveAiHomeDir());
        }

        var finalOrigin = !string.IsNullOrEmpty(cleanExplicitOrigin)
            ? cleanExplicitOrigin
            : (!string.IsNullOrEmpty(envOrigin)
                ? envOrigin
                : (dbConfig is { Origin.Length: > 0 } ? dbConfig.Value.Origin : $"http://{DefaultHost}:{DefaultPort}"));

        var finalKey = !string.IsNullOrEmpty(cleanExplicitKey)
            ? cleanExplicitKey
            : (!string.IsNullOrEmpty(envKey)
                ? envKey
                : (dbConfig?.ManagementKey ?? string.Empty));

        return new LumenEndpointConfig(NormalizeOrigin(finalOrigin), finalKey);
    }

    public static string ResolveAiHomeDir()
    {
        var custom = (Environment.GetEnvironmentVariable("AIH_HOME_DIR") ?? string.Empty).Trim();
        if (!string.IsNullOrEmpty(custom))
        {
            return Environment.ExpandEnvironmentVariables(custom);
        }
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (string.IsNullOrWhiteSpace(profile))
        {
            profile = Environment.GetEnvironmentVariable("USERPROFILE") ?? string.Empty;
        }
        return Path.Combine(profile, ".ai_home");
    }

    public static string NormalizeOrigin(string? raw)
        => string.IsNullOrWhiteSpace(raw) ? string.Empty : raw.Trim().TrimEnd('/');

    private static string ResolveOriginFromEnvironment()
    {
        var origin = (Environment.GetEnvironmentVariable("AIH_SERVER_ORIGIN") ?? string.Empty).Trim();
        if (!string.IsNullOrEmpty(origin))
        {
            return NormalizeOrigin(origin);
        }
        var rawPort = (Environment.GetEnvironmentVariable("AIH_SERVER_PORT") ?? string.Empty).Trim();
        if (int.TryParse(rawPort, NumberStyles.Integer, CultureInfo.InvariantCulture, out var port) && port is >= 1 and <= 65535)
        {
            var host = NormalizeHost(Environment.GetEnvironmentVariable("AIH_SERVER_HOST"));
            return $"http://{host}:{port}";
        }
        return string.Empty;
    }

    private static string NormalizeHost(string? raw)
    {
        var trimmed = (raw ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(trimmed) || trimmed == "0.0.0.0" || trimmed == "::")
        {
            return DefaultHost;
        }
        return trimmed;
    }

    private static LumenEndpointConfig? ReadFromLocalSqlite(string aiHomeDir)
    {
        if (string.IsNullOrWhiteSpace(aiHomeDir)) return null;
        var dbPath = Path.Combine(aiHomeDir, "aih.db");
        if (!File.Exists(dbPath)) return null;

        try
        {
            var csb = new SqliteConnectionStringBuilder
            {
                DataSource = dbPath,
                Mode = SqliteOpenMode.ReadOnly,
                Cache = SqliteCacheMode.Default,
                Pooling = false,
                DefaultTimeout = 2
            };

            using var conn = new SqliteConnection(csb.ConnectionString);
            conn.Open();

            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT value FROM app_kv WHERE key = 'config:server' LIMIT 1";
            var rawValue = cmd.ExecuteScalar() as string;
            if (string.IsNullOrWhiteSpace(rawValue)) return null;

            using var doc = JsonDocument.Parse(rawValue);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;

            var host = DefaultHost;
            if (root.TryGetProperty("host", out var hostProp) && hostProp.ValueKind == JsonValueKind.String)
            {
                host = NormalizeHost(hostProp.GetString());
            }

            var port = DefaultPort;
            if (root.TryGetProperty("port", out var portProp))
            {
                if (portProp.ValueKind == JsonValueKind.Number && portProp.TryGetInt32(out var intPort) && intPort is >= 1 and <= 65535)
                {
                    port = intPort;
                }
                else if (portProp.ValueKind == JsonValueKind.String
                    && int.TryParse(portProp.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)
                    && parsed is >= 1 and <= 65535)
                {
                    port = parsed;
                }
            }

            var key = string.Empty;
            if (root.TryGetProperty("managementKey", out var keyProp) && keyProp.ValueKind == JsonValueKind.String)
            {
                key = (keyProp.GetString() ?? string.Empty).Trim();
            }

            return new LumenEndpointConfig($"http://{host}:{port}", key);
        }
        catch
        {
            return null;
        }
    }
}
