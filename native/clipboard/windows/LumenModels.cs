using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json.Serialization;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace AihLumenClipboard;

/// <summary>
/// Smart visual category displayed in sidebar, history rows, gallery cards, and inspector.
/// Maps server canonical kinds (text, link, image, file) plus client smart categories (code, color).
/// </summary>
public enum LumenDisplayCategory
{
    Text,
    Code,
    Image,
    Link,
    Color,
    File
}

public static class LumenDisplayCategoryExtensions
{
    public static readonly LumenDisplayCategory[] AllCategories =
    {
        LumenDisplayCategory.Text,
        LumenDisplayCategory.Code,
        LumenDisplayCategory.Image,
        LumenDisplayCategory.Link,
        LumenDisplayCategory.Color,
        LumenDisplayCategory.File
    };

    public static string GetLabel(this LumenDisplayCategory category) => category switch
    {
        LumenDisplayCategory.Text => "文本",
        LumenDisplayCategory.Code => "代码",
        LumenDisplayCategory.Image => "图片",
        LumenDisplayCategory.Link => "链接",
        LumenDisplayCategory.Color => "颜色",
        LumenDisplayCategory.File => "文件",
        _ => "文本"
    };

    /// <summary>
    /// Segoe MDL2 Assets / Segoe Fluent Icons semantic glyphs (never vendor logos).
    /// </summary>
    public static string GetGlyph(this LumenDisplayCategory category) => category switch
    {
        LumenDisplayCategory.Text => "\uE8D2",  // Font / text
        LumenDisplayCategory.Code => "\uE943",  // Code
        LumenDisplayCategory.Image => "\uEB9F", // Photo
        LumenDisplayCategory.Link => "\uE71B",  // Link
        LumenDisplayCategory.Color => "\uE790", // Color / palette
        LumenDisplayCategory.File => "\uE8A5",  // Document
        _ => "\uE8A5"
    };
}

/// <summary>
/// Persisted clipboard item returned by /v1/management/webui/clipboard/items.
/// </summary>
public sealed class LumenClipboardItem
{
    [JsonPropertyName("id")] public string Id { get; set; } = string.Empty;
    [JsonPropertyName("sha256")] public string Sha256 { get; set; } = string.Empty;
    [JsonPropertyName("kind")] public string Kind { get; set; } = "text";
    [JsonPropertyName("mime")] public string Mime { get; set; } = string.Empty;
    [JsonPropertyName("byteSize")] public long ByteSize { get; set; }
    [JsonPropertyName("width")] public int Width { get; set; }
    [JsonPropertyName("height")] public int Height { get; set; }
    [JsonPropertyName("preview")] public string Preview { get; set; } = string.Empty;
    [JsonPropertyName("thumbnailDataUrl")] public string ThumbnailDataUrl { get; set; } = string.Empty;
    [JsonPropertyName("files")] public List<string>? Files { get; set; }
    [JsonPropertyName("fileHashes")] public List<string>? FileHashes { get; set; }
    [JsonPropertyName("sourceDevice")] public string SourceDevice { get; set; } = string.Empty;
    [JsonPropertyName("sourceApp")] public string SourceApp { get; set; } = string.Empty;
    [JsonPropertyName("pinned")] public bool Pinned { get; set; }
    [JsonPropertyName("deleted")] public bool Deleted { get; set; }
    [JsonPropertyName("seenCount")] public int SeenCount { get; set; } = 1;
    [JsonPropertyName("createdAtMs")] public long CreatedAtMs { get; set; }
    [JsonPropertyName("lastSeenAtMs")] public long LastSeenAtMs { get; set; }
    [JsonPropertyName("syncedAtMs")] public long SyncedAtMs { get; set; }
    [JsonPropertyName("remoteId")] public string RemoteId { get; set; } = string.Empty;
    [JsonPropertyName("materialized")] public bool Materialized { get; set; } = true;
    [JsonPropertyName("text")] public string? Text { get; set; }
    [JsonPropertyName("textTruncated")] public bool? TextTruncated { get; set; }
    [JsonPropertyName("blobPath")] public string? BlobPath { get; set; }

    [JsonIgnore]
    public IReadOnlyList<string> SafeFiles => Files ?? (IReadOnlyList<string>)Array.Empty<string>();

    [JsonIgnore]
    public string EffectiveText => !string.IsNullOrEmpty(Text) ? Text : (Preview ?? string.Empty);

    [JsonIgnore]
    public string? PrimaryFilePath
    {
        get
        {
            if (Files is null) return null;
            foreach (var f in Files)
            {
                if (!string.IsNullOrWhiteSpace(f)) return f.Trim();
            }
            return null;
        }
    }

    [JsonIgnore]
    public LumenDisplayCategory DisplayCategory
    {
        get
        {
            switch (Kind)
            {
                case "image":
                    return LumenDisplayCategory.Image;
                case "link":
                    return LumenDisplayCategory.Link;
                case "file":
                    if (SafeFiles.Count == 1 && PrimaryFilePath is { } path)
                    {
                        var ext = Path.GetExtension(path).TrimStart('.').ToLowerInvariant();
                        if (LumenClassifier.CodeExtensions.Contains(ext))
                        {
                            return LumenDisplayCategory.Code;
                        }
                    }
                    return LumenDisplayCategory.File;
                default:
                    var body = EffectiveText.Trim();
                    if (LumenClassifier.TryParseHexColor(body, out _))
                    {
                        return LumenDisplayCategory.Color;
                    }
                    if (LumenClassifier.LooksLikeCode(body))
                    {
                        return LumenDisplayCategory.Code;
                    }
                    return LumenDisplayCategory.Text;
            }
        }
    }

    [JsonIgnore]
    public string DisplayTitle
    {
        get
        {
            switch (Kind)
            {
                case "file":
                    if (SafeFiles.Count > 1)
                    {
                        var first = SafeFileName(SafeFiles[0]);
                        return $"{SafeFiles.Count} 个文件 · {first}";
                    }
                    if (PrimaryFilePath is { } path)
                    {
                        return SafeFileName(path);
                    }
                    return string.IsNullOrEmpty(Preview) ? "文件引用" : Preview;
                case "image":
                    if (Width > 0 && Height > 0)
                    {
                        return $"图片 · {Width} × {Height}";
                    }
                    return string.IsNullOrEmpty(Preview) ? "剪贴板图片" : Preview;
                case "link":
                    var raw = EffectiveText.Trim();
                    if (Uri.TryCreate(raw, UriKind.Absolute, out var uri) && !string.IsNullOrEmpty(uri.Host))
                    {
                        var pathPart = uri.AbsolutePath == "/" ? string.Empty : uri.AbsolutePath;
                        return uri.Host + pathPart;
                    }
                    if (string.IsNullOrEmpty(raw)) return "链接";
                    return raw.Length > 72 ? raw[..72] : raw;
                default:
                    var trimmed = EffectiveText.Trim();
                    if (LumenClassifier.TryParseHexColor(trimmed, out _))
                    {
                        return trimmed.ToUpperInvariant();
                    }
                    var firstLine = ExtractFirstNonEmptyLine(trimmed);
                    if (string.IsNullOrEmpty(firstLine)) return "空内容";
                    return firstLine.Length > 72 ? firstLine[..72] + "…" : firstLine;
            }
        }
    }

    [JsonIgnore]
    public string SourceLabel
    {
        get
        {
            if (!string.IsNullOrWhiteSpace(SourceApp)) return SourceApp.Trim();
            if (!string.IsNullOrWhiteSpace(SourceDevice)) return SourceDevice.Trim();
            return "本机";
        }
    }

    [JsonIgnore]
    public string FormattedSize
    {
        get
        {
            if (Kind == "file" && SafeFiles.Count > 1)
            {
                return $"{SafeFiles.Count} 项文件";
            }
            if (ByteSize <= 0)
            {
                if (Kind == "image" && Width > 0 && Height > 0)
                {
                    return $"{Width} × {Height}";
                }
                return $"{Encoding.UTF8.GetByteCount(EffectiveText)} B";
            }
            return LumenFormatters.ByteCount(ByteSize);
        }
    }

    [JsonIgnore]
    public DateTime LocalTimestamp
    {
        get
        {
            var ms = LastSeenAtMs > 0 ? LastSeenAtMs : CreatedAtMs;
            if (ms <= 0) return DateTime.Now;
            try
            {
                return DateTimeOffset.FromUnixTimeMilliseconds(ms).LocalDateTime;
            }
            catch
            {
                return DateTime.Now;
            }
        }
    }

    [JsonIgnore]
    public string RelativeTime => LumenFormatters.RelativeTime(LastSeenAtMs > 0 ? LastSeenAtMs : CreatedAtMs);

    [JsonIgnore]
    public bool IsToday => LocalTimestamp.Date == DateTime.Today;

    [JsonIgnore]
    public bool IsYesterday => LocalTimestamp.Date == DateTime.Today.AddDays(-1);

    public BitmapImage? DecodeThumbnailImage()
    {
        if (string.IsNullOrWhiteSpace(ThumbnailDataUrl)) return null;
        var comma = ThumbnailDataUrl.IndexOf(',');
        if (comma < 0 || comma + 1 >= ThumbnailDataUrl.Length) return null;
        try
        {
            var bytes = Convert.FromBase64String(ThumbnailDataUrl[(comma + 1)..]);
            return LumenFormatters.DecodeBitmapImage(bytes);
        }
        catch
        {
            return null;
        }
    }

    public bool ContentEquals(LumenClipboardItem other)
    {
        return string.Equals(Id, other.Id, StringComparison.Ordinal)
            && string.Equals(Sha256, other.Sha256, StringComparison.Ordinal)
            && string.Equals(Kind, other.Kind, StringComparison.Ordinal)
            && Pinned == other.Pinned
            && Deleted == other.Deleted
            && SeenCount == other.SeenCount
            && LastSeenAtMs == other.LastSeenAtMs
            && Materialized == other.Materialized
            && string.Equals(Preview, other.Preview, StringComparison.Ordinal)
            && string.Equals(Text, other.Text, StringComparison.Ordinal);
    }

    public LumenClipboardItem Clone()
    {
        return new LumenClipboardItem
        {
            Id = Id,
            Sha256 = Sha256,
            Kind = Kind,
            Mime = Mime,
            ByteSize = ByteSize,
            Width = Width,
            Height = Height,
            Preview = Preview,
            ThumbnailDataUrl = ThumbnailDataUrl,
            Files = Files is not null ? new List<string>(Files) : null,
            FileHashes = FileHashes is not null ? new List<string>(FileHashes) : null,
            SourceDevice = SourceDevice,
            SourceApp = SourceApp,
            Pinned = Pinned,
            Deleted = Deleted,
            SeenCount = SeenCount,
            CreatedAtMs = CreatedAtMs,
            LastSeenAtMs = LastSeenAtMs,
            SyncedAtMs = SyncedAtMs,
            RemoteId = RemoteId,
            Materialized = Materialized,
            Text = Text,
            TextTruncated = TextTruncated,
            BlobPath = BlobPath
        };
    }

    private static string SafeFileName(string raw)
    {
        var trimmed = raw.Trim();
        var name = Path.GetFileName(trimmed);
        return string.IsNullOrEmpty(name) ? trimmed : name;
    }

    private static string ExtractFirstNonEmptyLine(string text)
    {
        using var reader = new StringReader(text);
        while (reader.ReadLine() is { } line)
        {
            var t = line.Trim();
            if (t.Length > 0) return t;
        }
        return string.Empty;
    }
}

public sealed class LumenClipboardItemsResponse
{
    [JsonPropertyName("items")] public List<LumenClipboardItem>? Items { get; set; }
}

public sealed class LumenClipboardItemResponse
{
    [JsonPropertyName("item")] public LumenClipboardItem? Item { get; set; }
}

public sealed class LumenBatchDeleteResponse
{
    [JsonPropertyName("deleted")] public int Deleted { get; set; }
}

public sealed class LumenClipboardSettings
{
    [JsonPropertyName("captureEnabled")] public bool CaptureEnabled { get; set; }
    [JsonPropertyName("syncEnabled")] public bool SyncEnabled { get; set; }
    [JsonPropertyName("syncTargetProfileId")] public string SyncTargetProfileId { get; set; } = string.Empty;
    [JsonPropertyName("retentionDays")] public int RetentionDays { get; set; } = 30;
    [JsonPropertyName("maxItems")] public int MaxItems { get; set; } = 500;
    [JsonPropertyName("maxItemBytes")] public long MaxItemBytes { get; set; } = 8 * 1024 * 1024;
    [JsonPropertyName("quickOrbitPosition")] public string QuickOrbitPosition { get; set; } = "bottom";

    public static LumenClipboardSettings Defaults() => new()
    {
        CaptureEnabled = false,
        SyncEnabled = false,
        SyncTargetProfileId = string.Empty,
        RetentionDays = 30,
        MaxItems = 500,
        MaxItemBytes = 8 * 1024 * 1024,
        QuickOrbitPosition = "bottom"
    };
}

public sealed class LumenClipboardSettingsResponse
{
    [JsonPropertyName("settings")] public LumenClipboardSettings? Settings { get; set; }
}

public sealed class LumenCaptureStatus
{
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }
    [JsonPropertyName("supported")] public bool Supported { get; set; } = true;
    [JsonPropertyName("running")] public bool Running { get; set; }
    [JsonPropertyName("reason")] public string? Reason { get; set; }
}

public sealed class LumenSyncStatus
{
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }
    [JsonPropertyName("targetProfileId")] public string? TargetProfileId { get; set; }
    [JsonPropertyName("lastSyncAtMs")] public long? LastSyncAtMs { get; set; }
    [JsonPropertyName("lastError")] public string? LastError { get; set; }
}

public sealed class LumenTransportStatus
{
    [JsonPropertyName("name")] public string Name { get; set; } = string.Empty;
    [JsonPropertyName("available")] public bool Available { get; set; }
    [JsonPropertyName("detail")] public string? Detail { get; set; }
}

public sealed class LumenClipboardStatus
{
    [JsonPropertyName("platform")] public string Platform { get; set; } = "windows";
    [JsonPropertyName("capture")] public LumenCaptureStatus Capture { get; set; } = new();
    [JsonPropertyName("sync")] public LumenSyncStatus Sync { get; set; } = new();
    [JsonPropertyName("deviceId")] public string DeviceId { get; set; } = string.Empty;
    [JsonPropertyName("deviceName")] public string DeviceName { get; set; } = string.Empty;
    [JsonPropertyName("keyFingerprint")] public string KeyFingerprint { get; set; } = string.Empty;
    [JsonPropertyName("transports")] public List<LumenTransportStatus> Transports { get; set; } = new();
    [JsonPropertyName("itemCount")] public int ItemCount { get; set; }
    [JsonPropertyName("pinnedCount")] public int PinnedCount { get; set; }
    [JsonPropertyName("quickOrbitPosition")] public string QuickOrbitPosition { get; set; } = "bottom";
}

public sealed class LumenServerProfile
{
    [JsonPropertyName("id")] public string Id { get; set; } = string.Empty;
    [JsonPropertyName("label")] public string Label { get; set; } = string.Empty;
    [JsonPropertyName("endpoint")] public string Endpoint { get; set; } = string.Empty;
    [JsonPropertyName("active")] public bool Active { get; set; }
}

public sealed class LumenServerProfilesResponse
{
    [JsonPropertyName("servers")] public List<LumenServerProfile>? Servers { get; set; }
}

// MARK: - Server-Backed Structured Office & File Preview Models

public sealed class LumenOfficeBlock
{
    [JsonPropertyName("kind")] public string Kind { get; set; } = "p";
    [JsonPropertyName("text")] public string? Text { get; set; }
    [JsonPropertyName("rows")] public List<List<string>>? Rows { get; set; }
}

public sealed class LumenDocumentPreview
{
    [JsonPropertyName("title")] public string? Title { get; set; }
    [JsonPropertyName("blocks")] public List<LumenOfficeBlock> Blocks { get; set; } = new();
}

public sealed class LumenSheetPreview
{
    [JsonPropertyName("name")] public string Name { get; set; } = "Sheet1";
    [JsonPropertyName("rows")] public List<List<string>> Rows { get; set; } = new();
    [JsonPropertyName("formulas")] public Dictionary<string, string>? Formulas { get; set; }
}

public sealed class LumenWorkbookPreview
{
    [JsonPropertyName("sheets")] public List<LumenSheetPreview> Sheets { get; set; } = new();
}

public sealed class LumenSlidePreview
{
    [JsonPropertyName("number")] public int Number { get; set; }
    [JsonPropertyName("title")] public string? Title { get; set; }
    [JsonPropertyName("lines")] public List<string> Lines { get; set; } = new();
}

public sealed class LumenPresentationPreview
{
    [JsonPropertyName("slides")] public List<LumenSlidePreview> Slides { get; set; } = new();
}

public sealed class LumenOfficePreview
{
    [JsonPropertyName("format")] public string Format { get; set; } = string.Empty;
    [JsonPropertyName("document")] public LumenDocumentPreview? Document { get; set; }
    [JsonPropertyName("workbook")] public LumenWorkbookPreview? Workbook { get; set; }
    [JsonPropertyName("presentation")] public LumenPresentationPreview? Presentation { get; set; }
}

public sealed class LumenServerPreview
{
    [JsonPropertyName("kind")] public string Kind { get; set; } = "none";
    [JsonPropertyName("mime")] public string? Mime { get; set; }
    [JsonPropertyName("text")] public string? Text { get; set; }
    [JsonPropertyName("truncated")] public bool Truncated { get; set; }
    [JsonPropertyName("index")] public int Index { get; set; }
    [JsonPropertyName("fileName")] public string? FileName { get; set; }
    [JsonPropertyName("fileSize")] public long FileSize { get; set; }
    [JsonPropertyName("office")] public LumenOfficePreview? Office { get; set; }
}

public sealed class LumenServerPreviewResponse
{
    [JsonPropertyName("preview")] public LumenServerPreview? Preview { get; set; }
}

// MARK: - Classification & Formatters

public static class LumenClassifier
{
    public static readonly HashSet<string> CodeExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "swift", "go", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "php", "rs",
        "java", "kt", "c", "h", "cc", "cpp", "hpp", "cs", "rb", "sh", "zsh", "bash", "ps1",
        "json", "jsonl", "yaml", "yml", "toml", "css", "scss", "sql", "xml", "html", "htm"
    };

    public static readonly HashSet<string> ImageExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "ico"
    };

    public static readonly HashSet<string> AudioExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "mp3", "wav", "m4a", "aac", "ogg", "flac", "aiff", "aif", "wma"
    };

    public static readonly HashSet<string> VideoExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "mp4", "m4v", "mov", "webm", "mkv", "wmv", "avi"
    };

    public static readonly HashSet<string> OfficeExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "docx", "xlsx", "pptx"
    };

    public static readonly HashSet<string> TextExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "txt", "md", "markdown", "log", "csv", "tsv", "ini", "conf", "env"
    };

    public static bool TryParseHexColor(string? raw, out Color color)
    {
        color = default;
        if (string.IsNullOrWhiteSpace(raw)) return false;
        var trimmed = raw.Trim();
        if (!trimmed.StartsWith('#')) return false;
        var hex = trimmed[1..];
        if (hex.Length is not (3 or 6 or 8)) return false;
        foreach (var ch in hex)
        {
            if (!Uri.IsHexDigit(ch)) return false;
        }
        if (hex.Length == 3)
        {
            hex = $"{hex[0]}{hex[0]}{hex[1]}{hex[1]}{hex[2]}{hex[2]}";
        }
        if (!ulong.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var val))
        {
            return false;
        }
        if (hex.Length == 8)
        {
            var r = (byte)((val >> 24) & 0xFF);
            var g = (byte)((val >> 16) & 0xFF);
            var b = (byte)((val >> 8) & 0xFF);
            var a = (byte)(val & 0xFF);
            color = Color.FromArgb(a, r, g, b);
            return true;
        }
        color = Color.FromRgb(
            (byte)((val >> 16) & 0xFF),
            (byte)((val >> 8) & 0xFF),
            (byte)(val & 0xFF));
        return true;
    }

    public static bool LooksLikeCode(string text)
    {
        if (string.IsNullOrEmpty(text) || text.Length < 12) return false;
        if ((text.StartsWith('{') && text.EndsWith('}')) || (text.StartsWith('[') && text.EndsWith(']')))
        {
            if (text.Contains("\":", StringComparison.Ordinal) || text.Contains("\",", StringComparison.Ordinal))
            {
                return true;
            }
        }
        string[] markers =
        {
            "func ", "function ", "async function", "const ", "let ", "import ", "package ",
            "class ", "struct ", "enum ", "def ", "return ", "SELECT ", "<?php", "#!/",
            "=>", "::", "->", "interface ", "protocol ", "public ", "private ", "namespace ", "using "
        };
        var hits = 0;
        foreach (var marker in markers)
        {
            if (text.Contains(marker, StringComparison.Ordinal))
            {
                hits++;
                if (hits >= 2) return true;
            }
        }
        if (text.Contains('\n') && text.Contains('{') && text.Contains('}')
            && (text.Contains(';') || text.Contains("func ", StringComparison.Ordinal) || text.Contains("def ", StringComparison.Ordinal)))
        {
            return true;
        }
        return false;
    }

    public static string DetectLanguage(string? fileName, string content)
    {
        if (!string.IsNullOrWhiteSpace(fileName))
        {
            var ext = Path.GetExtension(fileName).TrimStart('.').ToLowerInvariant();
            switch (ext)
            {
                case "go": return "go";
                case "swift": return "swift";
                case "cs": return "cs";
                case "ts":
                case "tsx": return "ts";
                case "js":
                case "jsx":
                case "mjs":
                case "cjs": return "js";
                case "py": return "py";
                case "php": return "php";
                case "json":
                case "jsonl": return "json";
                case "css":
                case "scss": return "css";
                case "rs": return "rust";
                case "sql": return "sql";
                case "sh":
                case "zsh":
                case "bash":
                case "ps1": return "sh";
                case "yaml":
                case "yml": return "yaml";
                case "xml":
                case "html":
                case "htm": return "xml";
            }
        }
        var trimmed = (content ?? string.Empty).Trim();
        if (trimmed.StartsWith("<?php", StringComparison.Ordinal)) return "php";
        if (trimmed.StartsWith("package ", StringComparison.Ordinal) && content!.Contains("func ", StringComparison.Ordinal)) return "go";
        if (content!.Contains("using System", StringComparison.Ordinal) || content.Contains("namespace ", StringComparison.Ordinal)) return "cs";
        if (content.Contains("import AppKit", StringComparison.Ordinal) || content.Contains("import Foundation", StringComparison.Ordinal) || content.Contains("final class ", StringComparison.Ordinal)) return "swift";
        if (content.Contains("def ", StringComparison.Ordinal) && (content.Contains("import ", StringComparison.Ordinal) || content.Contains("from ", StringComparison.Ordinal))) return "py";
        if ((trimmed.StartsWith('{') || trimmed.StartsWith('[')) && content.Contains("\":", StringComparison.Ordinal)) return "json";
        if (content.Contains("interface ", StringComparison.Ordinal) || content.Contains(": string", StringComparison.Ordinal) || content.Contains(": number", StringComparison.Ordinal)) return "ts";
        if (content.Contains("SELECT ", StringComparison.OrdinalIgnoreCase) && content.Contains("FROM ", StringComparison.OrdinalIgnoreCase)) return "sql";
        if (content.Contains("transition:", StringComparison.Ordinal) || content.Contains("display:", StringComparison.Ordinal)) return "css";
        return "js";
    }

    public static string LanguageDisplayName(string lang) => (lang ?? string.Empty).ToLowerInvariant() switch
    {
        "go" => "Go",
        "swift" => "Swift",
        "cs" => "C#",
        "ts" => "TypeScript",
        "js" => "JavaScript",
        "py" => "Python",
        "php" => "PHP",
        "json" => "JSON",
        "css" => "CSS",
        "rust" => "Rust",
        "sql" => "SQL",
        "sh" => "Shell",
        "yaml" => "YAML",
        "xml" => "XML / HTML",
        _ => string.IsNullOrWhiteSpace(lang) ? "CODE" : lang.ToUpperInvariant()
    };

    public static (double Hue, double Saturation, double Brightness) RgbToHsb(Color color)
    {
        double r = color.R / 255.0;
        double g = color.G / 255.0;
        double b = color.B / 255.0;
        double max = Math.Max(r, Math.Max(g, b));
        double min = Math.Min(r, Math.Min(g, b));
        double delta = max - min;

        double hue = 0;
        if (delta > 0.00001)
        {
            if (Math.Abs(max - r) < 0.00001)
            {
                hue = 60.0 * (((g - b) / delta) % 6.0);
            }
            else if (Math.Abs(max - g) < 0.00001)
            {
                hue = 60.0 * (((b - r) / delta) + 2.0);
            }
            else
            {
                hue = 60.0 * (((r - g) / delta) + 4.0);
            }
            if (hue < 0) hue += 360.0;
        }
        double sat = max <= 0.00001 ? 0 : delta / max;
        return (hue, sat * 100.0, max * 100.0);
    }
}

public static class LumenFormatters
{
    public static string ByteCount(long bytes)
    {
        if (bytes < 1024) return $"{bytes} B";
        var kb = bytes / 1024.0;
        if (kb < 1024) return $"{kb:F1} KB";
        var mb = kb / 1024.0;
        if (mb < 1024) return $"{mb:F1} MB";
        return $"{mb / 1024.0:F2} GB";
    }

    public static string RelativeTime(long ms)
    {
        if (ms <= 0) return "刚刚";
        DateTimeOffset dto;
        try
        {
            dto = DateTimeOffset.FromUnixTimeMilliseconds(ms);
        }
        catch
        {
            return "刚刚";
        }
        var delta = (DateTimeOffset.UtcNow - dto).TotalSeconds;
        if (delta < 45) return "刚刚";
        if (delta < 3600) return $"{Math.Max(1, (int)(delta / 60))} 分钟前";
        if (delta < 86400) return $"{Math.Max(1, (int)(delta / 3600))} 小时前";
        var local = dto.LocalDateTime;
        if (local.Date == DateTime.Today.AddDays(-1)) return "昨天";
        return local.ToString("M/d HH:mm", CultureInfo.InvariantCulture);
    }

    public static string MediaDuration(double seconds)
    {
        if (!double.IsFinite(seconds) || seconds < 0) return "0:00";
        var total = (int)Math.Floor(seconds);
        var mins = total / 60;
        var secs = total % 60;
        return $"{mins}:{secs:D2}";
    }

    public static BitmapImage? DecodeBitmapImage(byte[] data, int decodePixelWidth = 0)
    {
        if (data is null || data.Length == 0) return null;
        try
        {
            using var ms = new MemoryStream(data, writable: false);
            var bmp = new BitmapImage();
            bmp.BeginInit();
            bmp.CacheOption = BitmapCacheOption.OnLoad;
            if (decodePixelWidth > 0)
            {
                bmp.DecodePixelWidth = decodePixelWidth;
            }
            bmp.StreamSource = ms;
            bmp.EndInit();
            bmp.Freeze();
            return bmp;
        }
        catch
        {
            return null;
        }
    }

    public static BitmapImage? DecodeBitmapImageFromFile(string path, int decodePixelWidth = 0)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return null;
        try
        {
            var bytes = File.ReadAllBytes(path);
            return DecodeBitmapImage(bytes, decodePixelWidth);
        }
        catch
        {
            return null;
        }
    }
}
