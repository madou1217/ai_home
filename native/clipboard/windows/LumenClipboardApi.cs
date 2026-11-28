using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows.Threading;

namespace AihLumenClipboard;

public sealed class LumenApiException : Exception
{
    public int StatusCode { get; }
    public bool IsPendingMaterialization { get; }

    public LumenApiException(string message, int statusCode = 0, bool isPendingMaterialization = false)
        : base(message)
    {
        StatusCode = statusCode;
        IsPendingMaterialization = isPendingMaterialization;
    }
}

/// <summary>
/// HTTP client targeting /v1/management/webui/clipboard/* with Bearer authorization.
/// Never writes to OS clipboard directly; delegates authoritative OS clipboard writes
/// (including PNG images and CF_HDROP file lists) to POST /items/{id}/copy.
/// </summary>
public sealed class LumenClipboardApiClient : IDisposable
{
    private const string BasePath = "/v1/management/webui/clipboard";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private readonly HttpClient _http;
    private readonly string _tempMediaDir;
    private readonly ConcurrentDictionary<string, string> _cachedMediaFiles = new(StringComparer.Ordinal);
    private LumenEndpointConfig _config = new(string.Empty, string.Empty);

    public LumenClipboardApiClient()
    {
        _http = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(25)
        };
        _tempMediaDir = Path.Combine(Path.GetTempPath(), $"aih-lumen-media-{Environment.ProcessId}");
    }

    public LumenEndpointConfig Config => _config;
    public bool IsConfigured => _config.IsValid;

    public bool Configure(LumenEndpointConfig next)
    {
        var changed = next != _config;
        _config = next;
        return changed;
    }

    private HttpRequestMessage CreateAuthorizedRequest(HttpMethod method, string relativePath, object? jsonBody = null)
    {
        if (!IsConfigured)
        {
            throw new LumenApiException("本机 AIH Server 或管理密钥未配置");
        }
        var url = _config.Origin + BasePath + relativePath;
        var req = new HttpRequestMessage(method, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.ManagementKey);
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (jsonBody is not null)
        {
            var payload = JsonSerializer.Serialize(jsonBody, JsonOptions);
            req.Content = new StringContent(payload, Encoding.UTF8, "application/json");
        }
        return req;
    }

    public async Task<List<LumenClipboardItem>> ListItemsAsync(int limit = 200, string query = "", string kind = "", CancellationToken ct = default)
    {
        var parts = new List<string> { $"limit={Math.Clamp(limit, 1, 200)}" };
        if (!string.IsNullOrWhiteSpace(query)) parts.Add("q=" + Uri.EscapeDataString(query.Trim()));
        if (!string.IsNullOrWhiteSpace(kind)) parts.Add("kind=" + Uri.EscapeDataString(kind.Trim()));
        var path = "/items?" + string.Join("&", parts);
        using var req = CreateAuthorizedRequest(HttpMethod.Get, path);
        var resp = await SendJsonAsync<LumenClipboardItemsResponse>(req, ct).ConfigureAwait(false);
        return resp.Items ?? new List<LumenClipboardItem>();
    }

    public async Task<LumenClipboardItem> GetItemDetailAsync(string id, CancellationToken ct = default)
    {
        using var req = CreateAuthorizedRequest(HttpMethod.Get, $"/items/{Uri.EscapeDataString(id)}");
        var resp = await SendJsonAsync<LumenClipboardItemResponse>(req, ct).ConfigureAwait(false);
        return resp.Item ?? throw new LumenApiException("服务端返回格式无法解析");
    }

    public async Task<(byte[] Data, string Mime)> FetchItemContentAsync(string id, int retriesRemaining = 3, CancellationToken ct = default)
    {
        using var req = CreateAuthorizedRequest(HttpMethod.Get, $"/items/{Uri.EscapeDataString(id)}/content");
        using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
        var status = (int)resp.StatusCode;
        if (status == 409 && retriesRemaining > 0)
        {
            var ready = await MaterializeItemAsync(id, ct).ConfigureAwait(false);
            await Task.Delay(ready ? 60 : 800, ct).ConfigureAwait(false);
            return await FetchItemContentAsync(id, retriesRemaining - 1, ct).ConfigureAwait(false);
        }
        var data = await resp.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            if (status == 409)
            {
                throw new LumenApiException("正在从源设备获取内容，请稍候", 409, isPendingMaterialization: true);
            }
            throw new LumenApiException(ParseErrorMessage(data, status), status);
        }
        var mime = resp.Content.Headers.ContentType?.MediaType ?? "application/octet-stream";
        return (data, mime);
    }

    public async Task<(byte[] Data, string Mime)> FetchItemFileDataAsync(string id, int index, CancellationToken ct = default)
    {
        var safeIndex = Math.Max(0, index);
        using var req = CreateAuthorizedRequest(HttpMethod.Get, $"/items/{Uri.EscapeDataString(id)}/file?index={safeIndex}");
        using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
        var data = await resp.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
        var status = (int)resp.StatusCode;
        if (!resp.IsSuccessStatusCode)
        {
            throw new LumenApiException(ParseErrorMessage(data, status), status);
        }
        var mime = resp.Content.Headers.ContentType?.MediaType ?? "application/octet-stream";
        return (data, mime);
    }

    /// <summary>
    /// Downloads an authenticated /items/{id}/file stream to a bounded process-scoped temp cache
    /// so WPF MediaPlayer / MediaElement / NAudio can seek without leaking Bearer tokens in URLs.
    /// </summary>
    public async Task<string> DownloadFileToTempCacheAsync(string id, int index, string? fileNameHint, CancellationToken ct = default)
    {
        var key = $"{id}#{Math.Max(0, index)}";
        if (_cachedMediaFiles.TryGetValue(key, out var existing) && File.Exists(existing))
        {
            return existing;
        }
        var (data, mime) = await FetchItemFileDataAsync(id, index, ct).ConfigureAwait(false);
        Directory.CreateDirectory(_tempMediaDir);
        PruneTempCacheIfNeeded();

        var ext = !string.IsNullOrWhiteSpace(fileNameHint) ? Path.GetExtension(fileNameHint) : string.Empty;
        if (string.IsNullOrWhiteSpace(ext))
        {
            ext = MimeToExtension(mime);
        }
        var hashHex = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..16];
        var targetPath = Path.Combine(_tempMediaDir, hashHex + ext);
        await File.WriteAllBytesAsync(targetPath, data, ct).ConfigureAwait(false);
        _cachedMediaFiles[key] = targetPath;
        return targetPath;
    }

    public async Task<LumenServerPreview> FetchFilePreviewAsync(string id, int? index = null, CancellationToken ct = default)
    {
        var suffix = index.HasValue ? $"?index={Math.Max(0, index.Value)}" : string.Empty;
        using var req = CreateAuthorizedRequest(HttpMethod.Get, $"/items/{Uri.EscapeDataString(id)}/preview{suffix}");
        var resp = await SendJsonAsync<LumenServerPreviewResponse>(req, ct).ConfigureAwait(false);
        return resp.Preview ?? throw new LumenApiException("服务端预览数据为空");
    }

    public async Task<bool> MaterializeItemAsync(string id, CancellationToken ct = default)
    {
        using var req = CreateAuthorizedRequest(HttpMethod.Post, $"/items/{Uri.EscapeDataString(id)}/materialize");
        using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
        var raw = await resp.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
        var status = (int)resp.StatusCode;
        if (!resp.IsSuccessStatusCode)
        {
            throw new LumenApiException(ParseErrorMessage(raw, status), status);
        }
        try
        {
            using var doc = JsonDocument.Parse(raw);
            return doc.RootElement.TryGetProperty("state", out var state)
                && string.Equals(state.GetString(), "ready", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Authoritative OS clipboard write via POST /items/{id}/copy.
    /// Automatically requests /materialize and retries on 409 clipboard_content_pending.
    /// </summary>
    public async Task CopyItemToOsClipboardAsync(string id, int retriesRemaining = 3, CancellationToken ct = default)
    {
        using var req = CreateAuthorizedRequest(HttpMethod.Post, $"/items/{Uri.EscapeDataString(id)}/copy");
        using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
        var status = (int)resp.StatusCode;
        if (resp.IsSuccessStatusCode) return;

        if (status == 409 && retriesRemaining > 0)
        {
            var ready = await MaterializeItemAsync(id, ct).ConfigureAwait(false);
            await Task.Delay(ready ? 50 : 800, ct).ConfigureAwait(false);
            await CopyItemToOsClipboardAsync(id, retriesRemaining - 1, ct).ConfigureAwait(false);
            return;
        }
        var raw = await resp.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
        if (status == 409)
        {
            throw new LumenApiException("正在从源设备获取内容，请稍候", 409, isPendingMaterialization: true);
        }
        throw new LumenApiException(ParseErrorMessage(raw, status), status);
    }

    public async Task<LumenClipboardItem> IngestTextAsync(string text, string? kind = null, string sourceApp = "Lumen", CancellationToken ct = default)
    {
        var payload = new Dictionary<string, object?>
        {
            ["text"] = text,
            ["sourceApp"] = string.IsNullOrWhiteSpace(sourceApp) ? "Lumen" : sourceApp
        };
        if (!string.IsNullOrWhiteSpace(kind))
        {
            payload["kind"] = kind;
        }
        using var req = CreateAuthorizedRequest(HttpMethod.Post, "/items", payload);
        var resp = await SendJsonAsync<LumenClipboardItemResponse>(req, ct).ConfigureAwait(false);
        return resp.Item ?? throw new LumenApiException("服务端返回格式无法解析");
    }

    public async Task<LumenClipboardItem> SetPinnedAsync(string id, bool pinned, CancellationToken ct = default)
    {
        using var req = CreateAuthorizedRequest(HttpMethod.Post, $"/items/{Uri.EscapeDataString(id)}/pin", new { pinned });
        var resp = await SendJsonAsync<LumenClipboardItemResponse>(req, ct).ConfigureAwait(false);
        return resp.Item ?? throw new LumenApiException("服务端返回格式无法解析");
    }

    public async Task DeleteItemAsync(string id, CancellationToken ct = default)
    {
        using var req = CreateAuthorizedRequest(HttpMethod.Delete, $"/items/{Uri.EscapeDataString(id)}");
        await SendStatusOnlyAsync(req, ct).ConfigureAwait(false);
    }

    public async Task<int> BatchDeleteItemsAsync(IReadOnlyList<string> ids, CancellationToken ct = default)
    {
        if (ids.Count == 0) return 0;
        using var req = CreateAuthorizedRequest(HttpMethod.Post, "/items/batch-delete", new { ids });
        var resp = await SendJsonAsync<LumenBatchDeleteResponse>(req, ct).ConfigureAwait(false);
        return resp.Deleted;
    }

    public async Task<LumenClipboardSettings> GetSettingsAsync(CancellationToken ct = default)
    {
        using var req = CreateAuthorizedRequest(HttpMethod.Get, "/settings");
        var resp = await SendJsonAsync<LumenClipboardSettingsResponse>(req, ct).ConfigureAwait(false);
        return resp.Settings ?? LumenClipboardSettings.Defaults();
    }

    public async Task<LumenClipboardSettings> PatchSettingsAsync(Dictionary<string, object?> patch, CancellationToken ct = default)
    {
        using var req = CreateAuthorizedRequest(HttpMethod.Patch, "/settings", patch);
        var resp = await SendJsonAsync<LumenClipboardSettingsResponse>(req, ct).ConfigureAwait(false);
        return resp.Settings ?? LumenClipboardSettings.Defaults();
    }

    public async Task<LumenClipboardStatus> GetStatusAsync(CancellationToken ct = default)
    {
        using var req = CreateAuthorizedRequest(HttpMethod.Get, "/status");
        return await SendJsonAsync<LumenClipboardStatus>(req, ct).ConfigureAwait(false);
    }

    public async Task<List<LumenServerProfile>> ListServersAsync(CancellationToken ct = default)
    {
        using var req = CreateAuthorizedRequest(HttpMethod.Get, "/servers");
        var resp = await SendJsonAsync<LumenServerProfilesResponse>(req, ct).ConfigureAwait(false);
        return resp.Servers ?? new List<LumenServerProfile>();
    }

    public async Task TriggerSyncAsync(CancellationToken ct = default)
    {
        using var req = CreateAuthorizedRequest(HttpMethod.Post, "/sync-run");
        await SendStatusOnlyAsync(req, ct).ConfigureAwait(false);
    }

    private async Task<T> SendJsonAsync<T>(HttpRequestMessage req, CancellationToken ct)
    {
        using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
        var data = await resp.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
        var status = (int)resp.StatusCode;
        if (!resp.IsSuccessStatusCode)
        {
            throw new LumenApiException(ParseErrorMessage(data, status), status);
        }
        try
        {
            var decoded = JsonSerializer.Deserialize<T>(data, JsonOptions);
            return decoded ?? throw new LumenApiException("服务端返回格式无法解析", status);
        }
        catch (JsonException)
        {
            throw new LumenApiException("服务端返回格式无法解析", status);
        }
    }

    private async Task SendStatusOnlyAsync(HttpRequestMessage req, CancellationToken ct)
    {
        using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
        if (resp.IsSuccessStatusCode) return;
        var data = await resp.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
        var status = (int)resp.StatusCode;
        throw new LumenApiException(ParseErrorMessage(data, status), status);
    }

    private static string ParseErrorMessage(byte[] data, int status)
    {
        if (data.Length > 0)
        {
            try
            {
                using var doc = JsonDocument.Parse(data);
                var root = doc.RootElement;
                if (root.TryGetProperty("error", out var err))
                {
                    if (err.ValueKind == JsonValueKind.Object && err.TryGetProperty("message", out var nestedMsg) && nestedMsg.ValueKind == JsonValueKind.String)
                    {
                        var text = nestedMsg.GetString();
                        if (!string.IsNullOrWhiteSpace(text)) return text;
                    }
                    else if (err.ValueKind == JsonValueKind.String)
                    {
                        var text = err.GetString();
                        if (!string.IsNullOrWhiteSpace(text)) return text;
                    }
                }
                if (root.TryGetProperty("message", out var msg) && msg.ValueKind == JsonValueKind.String)
                {
                    var text = msg.GetString();
                    if (!string.IsNullOrWhiteSpace(text)) return text;
                }
            }
            catch { }
        }
        return status > 0 ? $"请求失败 (HTTP {status})" : "请求失败";
    }

    private void PruneTempCacheIfNeeded()
    {
        try
        {
            if (_cachedMediaFiles.Count <= 16) return;
            var dirInfo = new DirectoryInfo(_tempMediaDir);
            if (!dirInfo.Exists) return;
            var files = dirInfo.GetFiles().OrderBy(f => f.LastAccessTimeUtc).ToList();
            while (files.Count > 12)
            {
                var victim = files[0];
                files.RemoveAt(0);
                try { victim.Delete(); } catch { }
            }
        }
        catch { }
    }

    private static string MimeToExtension(string mime) => mime.ToLowerInvariant() switch
    {
        "audio/mpeg" => ".mp3",
        "audio/wav" => ".wav",
        "audio/mp4" => ".m4a",
        "audio/ogg" => ".ogg",
        "audio/flac" => ".flac",
        "audio/aiff" => ".aiff",
        "video/mp4" => ".mp4",
        "video/quicktime" => ".mov",
        "video/webm" => ".webm",
        "application/pdf" => ".pdf",
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        _ => ".bin"
    };

    public void CleanupTempCache()
    {
        _cachedMediaFiles.Clear();
        try
        {
            if (Directory.Exists(_tempMediaDir))
            {
                Directory.Delete(_tempMediaDir, recursive: true);
            }
        }
        catch { }
    }

    public void Dispose()
    {
        CleanupTempCache();
        _http.Dispose();
    }
}

/// <summary>
/// Persistent Server-Sent Events subscriber for /v1/management/webui/clipboard/events
/// with exponential reconnect backoff (1.5s -> 15s).
/// </summary>
public sealed class LumenSseClient : IDisposable
{
    private readonly HttpClient _http;
    private CancellationTokenSource? _cts;
    private LumenEndpointConfig _config = new(string.Empty, string.Empty);
    private bool _running;

    public event Action? ClipboardChanged;
    public event Action<bool>? ConnectionChanged;

    public LumenSseClient()
    {
        _http = new HttpClient
        {
            Timeout = Timeout.InfiniteTimeSpan
        };
    }

    public void Start(LumenEndpointConfig next)
    {
        var changed = next != _config;
        _config = next;
        if (!next.IsValid)
        {
            Stop();
            return;
        }
        if (_running && !changed) return;
        Stop();
        _running = true;
        var cts = new CancellationTokenSource();
        _cts = cts;
        _ = Task.Run(() => RunLoopAsync(next, cts.Token), cts.Token);
    }

    public void Stop()
    {
        _running = false;
        var prev = Interlocked.Exchange(ref _cts, null);
        if (prev is not null)
        {
            try { prev.Cancel(); } catch { }
            prev.Dispose();
        }
    }

    private async Task RunLoopAsync(LumenEndpointConfig cfg, CancellationToken ct)
    {
        var backoffMs = 1500.0;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, cfg.Origin + "/v1/management/webui/clipboard/events");
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", cfg.ManagementKey);
                req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));

                using var resp = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
                if (resp.StatusCode == HttpStatusCode.OK)
                {
                    backoffMs = 1500.0;
                    LumenWpfHost.RunOnUi(() => ConnectionChanged?.Invoke(true));

                    await using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
                    using var reader = new StreamReader(stream, Encoding.UTF8);
                    var eventName = string.Empty;
                    while (!ct.IsCancellationRequested)
                    {
                        var line = await reader.ReadLineAsync(ct).ConfigureAwait(false);
                        if (line is null) break;
                        if (line.Length == 0)
                        {
                            if (string.Equals(eventName, "clipboard", StringComparison.Ordinal))
                            {
                                LumenWpfHost.RunOnUi(() => ClipboardChanged?.Invoke());
                            }
                            eventName = string.Empty;
                            continue;
                        }
                        if (line.StartsWith("event:", StringComparison.Ordinal))
                        {
                            eventName = line[6..].Trim();
                        }
                    }
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch
            {
                // Fall through to reconnect backoff.
            }

            if (ct.IsCancellationRequested) break;
            LumenWpfHost.RunOnUi(() => ConnectionChanged?.Invoke(false));
            try
            {
                await Task.Delay((int)backoffMs, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            backoffMs = Math.Min(backoffMs * 1.6, 15_000.0);
        }
    }

    public void Dispose()
    {
        Stop();
        _http.Dispose();
    }
}

public enum LumenThemeMode
{
    Light,
    Dark
}

/// <summary>
/// Shared visual preferences persisted locally across App Management Window, Orbit, and Preview.
/// </summary>
public sealed record LumenVisualPreferences(
    LumenThemeMode Theme = LumenThemeMode.Light,
    bool Particles = true,
    bool Glow = true,
    bool Motion = true)
{
    private sealed class StoredPrefs
    {
        [JsonPropertyName("theme")] public string Theme { get; set; } = "light";
        [JsonPropertyName("particles")] public bool Particles { get; set; } = true;
        [JsonPropertyName("glow")] public bool Glow { get; set; } = true;
        [JsonPropertyName("motion")] public bool Motion { get; set; } = true;
    }

    private static string FilePath()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(localAppData))
        {
            localAppData = Path.GetTempPath();
        }
        return Path.Combine(localAppData, "AIHome", "lumen-v7-prefs.json");
    }

    public static LumenVisualPreferences Load()
    {
        try
        {
            var path = FilePath();
            if (!File.Exists(path)) return new LumenVisualPreferences();
            var raw = File.ReadAllText(path, Encoding.UTF8);
            var stored = JsonSerializer.Deserialize<StoredPrefs>(raw);
            if (stored is null) return new LumenVisualPreferences();
            var mode = string.Equals(stored.Theme, "dark", StringComparison.OrdinalIgnoreCase)
                ? LumenThemeMode.Dark
                : LumenThemeMode.Light;
            return new LumenVisualPreferences(mode, stored.Particles, stored.Glow, stored.Motion);
        }
        catch
        {
            return new LumenVisualPreferences();
        }
    }

    public void Save()
    {
        try
        {
            var path = FilePath();
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            var stored = new StoredPrefs
            {
                Theme = Theme == LumenThemeMode.Dark ? "dark" : "light",
                Particles = Particles,
                Glow = Glow,
                Motion = Motion
            };
            var json = JsonSerializer.Serialize(stored, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(path, json, new UTF8Encoding(false));
        }
        catch
        {
            // Non-fatal if local profile directory is read-only.
        }
    }
}

public enum LumenStoreEventKind
{
    ItemsUpdated,
    SettingsUpdated,
    StatusUpdated,
    PreferencesUpdated,
    ConnectionUpdated,
    Error
}

public readonly record struct LumenStoreEvent(LumenStoreEventKind Kind, string? Message = null);

public sealed record LumenUndoEntry(LumenClipboardItem Item, string? FullText);

/// <summary>
/// Shared reactive clipboard store backing the App Management Window, Orbit Edge Rail, and Preview Container.
/// </summary>
public sealed class LumenClipboardStore : IDisposable
{
    public static LumenClipboardStore Shared { get; } = new();

    public LumenClipboardApiClient Api { get; } = new();
    private readonly LumenSseClient _sse = new();
    private readonly Dictionary<Guid, Action<LumenStoreEvent>> _observers = new();
    private readonly List<LumenClipboardItem> _items = new();
    private readonly Dictionary<string, LumenClipboardItem> _detailCache = new(StringComparer.Ordinal);
    private readonly List<LumenUndoEntry> _undoStack = new();
    private DispatcherTimer? _refreshDebounceTimer;
    private bool _isRefreshingItems;

    public IReadOnlyList<LumenClipboardItem> Items => _items;
    public LumenClipboardSettings Settings { get; private set; } = LumenClipboardSettings.Defaults();
    public LumenClipboardStatus? Status { get; private set; }
    public IReadOnlyList<LumenServerProfile> Servers { get; private set; } = Array.Empty<LumenServerProfile>();
    public bool Connected { get; private set; }
    public string? LastError { get; private set; }
    public LumenVisualPreferences Preferences { get; private set; } = LumenVisualPreferences.Load();

    public bool IsConfigured => Api.IsConfigured;
    public bool CanUndoDelete => _undoStack.Count > 0;

    public event Action<string>? QuickOrbitPositionChanged;

    private LumenClipboardStore()
    {
        _sse.ClipboardChanged += ScheduleDebouncedRefresh;
        _sse.ConnectionChanged += online =>
        {
            if (Connected != online)
            {
                Connected = online;
                Notify(new LumenStoreEvent(LumenStoreEventKind.ConnectionUpdated));
            }
        };
    }

    public Guid AddObserver(Action<LumenStoreEvent> handler)
    {
        var id = Guid.NewGuid();
        _observers[id] = handler;
        return id;
    }

    public void RemoveObserver(Guid id) => _observers.Remove(id);

    private void Notify(LumenStoreEvent ev)
    {
        LumenWpfHost.RunOnUi(() =>
        {
            foreach (var handler in _observers.Values.ToArray())
            {
                handler(ev);
            }
        });
    }

    public void Configure(string? origin, string? managementKey)
    {
        var resolved = LumenLocalConfigLoader.Resolve(origin, managementKey);
        var changed = Api.Configure(resolved);
        if (resolved.IsValid)
        {
            _sse.Start(resolved);
            if (changed || _items.Count == 0)
            {
                RefreshAll();
            }
        }
        else
        {
            _sse.Stop();
            Connected = false;
            Notify(new LumenStoreEvent(LumenStoreEventKind.ConnectionUpdated));
        }
    }

    public void EnsureConfiguredFromLocalConfig()
    {
        if (Api.IsConfigured) return;
        var resolved = LumenLocalConfigLoader.Resolve();
        if (resolved.IsValid)
        {
            Configure(resolved.Origin, resolved.ManagementKey);
        }
    }

    public void UpdatePreferences(Func<LumenVisualPreferences, LumenVisualPreferences> transform)
    {
        var next = transform(Preferences);
        if (next == Preferences) return;
        Preferences = next;
        Preferences.Save();
        Notify(new LumenStoreEvent(LumenStoreEventKind.PreferencesUpdated));
    }

    public void RefreshAll()
    {
        _ = RefreshItemsAsync();
        _ = RefreshSettingsAsync();
        _ = RefreshStatusAsync();
        _ = RefreshServersAsync();
    }

    private void ScheduleDebouncedRefresh()
    {
        LumenWpfHost.RunOnUi(() =>
        {
            if (_refreshDebounceTimer is null)
            {
                _refreshDebounceTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(160) };
                _refreshDebounceTimer.Tick += (_, _) =>
                {
                    _refreshDebounceTimer?.Stop();
                    _ = RefreshItemsAsync();
                    _ = RefreshStatusAsync();
                };
            }
            _refreshDebounceTimer.Stop();
            _refreshDebounceTimer.Start();
        });
    }

    public async Task RefreshItemsAsync()
    {
        if (!Api.IsConfigured || _isRefreshingItems) return;
        _isRefreshingItems = true;
        try
        {
            var fetched = await Api.ListItemsAsync(limit: 200).ConfigureAwait(false);
            LumenWpfHost.RunOnUi(() =>
            {
                _items.Clear();
                foreach (var item in fetched)
                {
                    if (_detailCache.TryGetValue(item.Id, out var cached) && cached.Text is not null)
                    {
                        item.Text = cached.Text;
                        item.TextTruncated = cached.TextTruncated;
                        item.BlobPath = cached.BlobPath;
                    }
                    _items.Add(item);
                }
                Connected = true;
                LastError = null;
                Notify(new LumenStoreEvent(LumenStoreEventKind.ItemsUpdated));
            });
        }
        catch (Exception ex)
        {
            LastError = ex.Message;
            Notify(new LumenStoreEvent(LumenStoreEventKind.Error, ex.Message));
        }
        finally
        {
            _isRefreshingItems = false;
        }
    }

    public async Task<LumenClipboardItem?> HydrateItemDetailAsync(string id)
    {
        if (_detailCache.TryGetValue(id, out var cached) && cached.Text is not null)
        {
            return cached;
        }
        try
        {
            var detailed = await Api.GetItemDetailAsync(id).ConfigureAwait(false);
            LumenWpfHost.RunOnUi(() =>
            {
                _detailCache[id] = detailed;
                var idx = _items.FindIndex(x => string.Equals(x.Id, id, StringComparison.Ordinal));
                if (idx >= 0)
                {
                    _items[idx] = detailed;
                    Notify(new LumenStoreEvent(LumenStoreEventKind.ItemsUpdated));
                }
            });
            return detailed;
        }
        catch
        {
            return _items.FirstOrDefault(x => string.Equals(x.Id, id, StringComparison.Ordinal));
        }
    }

    public async Task RefreshSettingsAsync()
    {
        if (!Api.IsConfigured) return;
        try
        {
            var loaded = await Api.GetSettingsAsync().ConfigureAwait(false);
            LumenWpfHost.RunOnUi(() =>
            {
                var prevPos = Settings.QuickOrbitPosition;
                Settings = loaded;
                Notify(new LumenStoreEvent(LumenStoreEventKind.SettingsUpdated));
                if (!string.Equals(prevPos, loaded.QuickOrbitPosition, StringComparison.OrdinalIgnoreCase))
                {
                    QuickOrbitPositionChanged?.Invoke(loaded.QuickOrbitPosition);
                }
            });
        }
        catch { }
    }

    public async Task<(bool Ok, LumenClipboardSettings? Settings, string? Error)> PatchSettingsAsync(Dictionary<string, object?> patch)
    {
        try
        {
            var updated = await Api.PatchSettingsAsync(patch).ConfigureAwait(false);
            LumenWpfHost.RunOnUi(() =>
            {
                var prevPos = Settings.QuickOrbitPosition;
                Settings = updated;
                Notify(new LumenStoreEvent(LumenStoreEventKind.SettingsUpdated));
                if (!string.Equals(prevPos, updated.QuickOrbitPosition, StringComparison.OrdinalIgnoreCase))
                {
                    QuickOrbitPositionChanged?.Invoke(updated.QuickOrbitPosition);
                }
                _ = RefreshStatusAsync();
            });
            return (true, updated, null);
        }
        catch (Exception ex)
        {
            Notify(new LumenStoreEvent(LumenStoreEventKind.Error, ex.Message));
            return (false, null, ex.Message);
        }
    }

    public async Task RefreshStatusAsync()
    {
        if (!Api.IsConfigured) return;
        try
        {
            var next = await Api.GetStatusAsync().ConfigureAwait(false);
            LumenWpfHost.RunOnUi(() =>
            {
                Status = next;
                Connected = true;
                Notify(new LumenStoreEvent(LumenStoreEventKind.StatusUpdated));
            });
        }
        catch { }
    }

    public async Task RefreshServersAsync()
    {
        if (!Api.IsConfigured) return;
        try
        {
            var list = await Api.ListServersAsync().ConfigureAwait(false);
            LumenWpfHost.RunOnUi(() =>
            {
                Servers = list;
                Notify(new LumenStoreEvent(LumenStoreEventKind.SettingsUpdated));
            });
        }
        catch { }
    }

    public async Task<(bool Ok, string? Error)> CopyToOsClipboardAsync(string id)
    {
        try
        {
            await Api.CopyItemToOsClipboardAsync(id).ConfigureAwait(false);
            return (true, null);
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }

    public async Task<(bool Ok, LumenClipboardItem? Item, string? Error)> TogglePinAsync(string id)
    {
        var existing = _items.FirstOrDefault(x => string.Equals(x.Id, id, StringComparison.Ordinal));
        if (existing is null) return (false, null, "记录不存在");
        return await SetPinnedAsync(id, !existing.Pinned).ConfigureAwait(false);
    }

    public async Task<(bool Ok, LumenClipboardItem? Item, string? Error)> SetPinnedAsync(string id, bool pinned)
    {
        try
        {
            var updated = await Api.SetPinnedAsync(id, pinned).ConfigureAwait(false);
            LumenWpfHost.RunOnUi(() =>
            {
                var idx = _items.FindIndex(x => string.Equals(x.Id, id, StringComparison.Ordinal));
                if (idx >= 0)
                {
                    updated.Text = _items[idx].Text;
                    _items[idx] = updated;
                    Notify(new LumenStoreEvent(LumenStoreEventKind.ItemsUpdated));
                }
                _ = RefreshStatusAsync();
            });
            return (true, updated, null);
        }
        catch (Exception ex)
        {
            Notify(new LumenStoreEvent(LumenStoreEventKind.Error, ex.Message));
            return (false, null, ex.Message);
        }
    }

    public async Task BatchSetPinnedAsync(IReadOnlyList<string> ids, bool pinned)
    {
        var tasks = ids.Select(id => Api.SetPinnedAsync(id, pinned)).ToArray();
        try { await Task.WhenAll(tasks).ConfigureAwait(false); } catch { }
        await RefreshItemsAsync().ConfigureAwait(false);
        await RefreshStatusAsync().ConfigureAwait(false);
    }

    public async Task<(bool Ok, string? Error)> DeleteItemAsync(string id, bool optimistic = true)
    {
        LumenClipboardItem? removedItem = null;
        var removedIndex = -1;
        LumenWpfHost.RunOnUi(() =>
        {
            removedIndex = _items.FindIndex(x => string.Equals(x.Id, id, StringComparison.Ordinal));
            if (removedIndex >= 0)
            {
                removedItem = _items[removedIndex];
                var cachedText = _detailCache.TryGetValue(id, out var det) ? det.Text : null;
                var fullText = cachedText ?? removedItem.Text ?? (removedItem.Kind is "text" or "link" ? removedItem.Preview : null);
                _undoStack.Add(new LumenUndoEntry(removedItem.Clone(), fullText));
                if (_undoStack.Count > 25) _undoStack.RemoveAt(0);
                if (optimistic)
                {
                    _items.RemoveAt(removedIndex);
                    Notify(new LumenStoreEvent(LumenStoreEventKind.ItemsUpdated));
                }
            }
        });

        try
        {
            await Api.DeleteItemAsync(id).ConfigureAwait(false);
            LumenWpfHost.RunOnUi(() =>
            {
                _detailCache.Remove(id);
                if (!optimistic)
                {
                    _items.RemoveAll(x => string.Equals(x.Id, id, StringComparison.Ordinal));
                    Notify(new LumenStoreEvent(LumenStoreEventKind.ItemsUpdated));
                }
                _ = RefreshStatusAsync();
            });
            return (true, null);
        }
        catch (Exception ex)
        {
            LumenWpfHost.RunOnUi(() =>
            {
                if (optimistic && removedItem is not null && removedIndex >= 0)
                {
                    _items.Insert(Math.Min(removedIndex, _items.Count), removedItem);
                    Notify(new LumenStoreEvent(LumenStoreEventKind.ItemsUpdated));
                }
                Notify(new LumenStoreEvent(LumenStoreEventKind.Error, ex.Message));
            });
            return (false, ex.Message);
        }
    }

    public async Task<(bool Ok, int Deleted, string? Error)> BatchDeleteAsync(IReadOnlyList<string> ids)
    {
        var idSet = new HashSet<string>(ids, StringComparer.Ordinal);
        LumenWpfHost.RunOnUi(() =>
        {
            foreach (var item in _items)
            {
                if (!idSet.Contains(item.Id)) continue;
                var cachedText = _detailCache.TryGetValue(item.Id, out var det) ? det.Text : null;
                var fullText = cachedText ?? item.Text ?? (item.Kind is "text" or "link" ? item.Preview : null);
                _undoStack.Add(new LumenUndoEntry(item.Clone(), fullText));
            }
            if (_undoStack.Count > 40)
            {
                _undoStack.RemoveRange(0, _undoStack.Count - 40);
            }
            _items.RemoveAll(x => idSet.Contains(x.Id));
            Notify(new LumenStoreEvent(LumenStoreEventKind.ItemsUpdated));
        });

        try
        {
            var deleted = await Api.BatchDeleteItemsAsync(ids).ConfigureAwait(false);
            LumenWpfHost.RunOnUi(() =>
            {
                foreach (var id in ids) _detailCache.Remove(id);
                _ = RefreshStatusAsync();
            });
            return (true, deleted, null);
        }
        catch (Exception ex)
        {
            await RefreshItemsAsync().ConfigureAwait(false);
            Notify(new LumenStoreEvent(LumenStoreEventKind.Error, ex.Message));
            return (false, 0, ex.Message);
        }
    }

    public async Task<(bool Ok, LumenClipboardItem? Item, string? Error)> CreateTextItemAsync(string text)
    {
        var trimmed = (text ?? string.Empty).Trim();
        var kind = trimmed.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            || trimmed.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
            ? "link"
            : "text";
        try
        {
            var created = await Api.IngestTextAsync(text ?? string.Empty, kind, "Lumen").ConfigureAwait(false);
            LumenWpfHost.RunOnUi(() =>
            {
                _items.RemoveAll(x => string.Equals(x.Id, created.Id, StringComparison.Ordinal));
                created.Text = text;
                _detailCache[created.Id] = created;
                _items.Insert(0, created);
                Notify(new LumenStoreEvent(LumenStoreEventKind.ItemsUpdated));
                _ = RefreshStatusAsync();
            });
            return (true, created, null);
        }
        catch (Exception ex)
        {
            return (false, null, ex.Message);
        }
    }

    /// <summary>
    /// Restores the most recently deleted text/link clip via POST /items.
    /// </summary>
    public async Task<(bool Ok, LumenClipboardItem? Restored, string? Error)> UndoLastDeleteAsync()
    {
        if (_undoStack.Count == 0)
        {
            return (false, null, "没有可撤销的删除记录");
        }
        var entry = _undoStack[^1];
        _undoStack.RemoveAt(_undoStack.Count - 1);

        if (entry.Item.Kind is not ("text" or "link") || string.IsNullOrEmpty(entry.FullText))
        {
            return (false, null, "该类型条目不支持撤销恢复");
        }

        try
        {
            var sourceApp = string.IsNullOrWhiteSpace(entry.Item.SourceApp) ? "Lumen" : entry.Item.SourceApp;
            var restored = await Api.IngestTextAsync(entry.FullText, entry.Item.Kind, sourceApp).ConfigureAwait(false);
            if (entry.Item.Pinned)
            {
                _ = await SetPinnedAsync(restored.Id, true).ConfigureAwait(false);
            }
            await RefreshItemsAsync().ConfigureAwait(false);
            await RefreshStatusAsync().ConfigureAwait(false);
            return (true, restored, null);
        }
        catch (Exception ex)
        {
            return (false, null, ex.Message);
        }
    }

    public void Dispose()
    {
        _sse.Dispose();
        Api.Dispose();
    }
}
