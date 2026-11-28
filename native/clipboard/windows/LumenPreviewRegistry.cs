using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media.Imaging;
using Windows.Data.Pdf;

namespace AihLumenClipboard;

public enum LumenPreviewKindTag
{
    Text,
    Code,
    Image,
    Color,
    Link,
    Pdf,
    Office,
    Audio,
    Video,
    Collection,
    File
}

/// <summary>
/// Canonical preview classification matching the cross-platform Paste Lumen V7 contract.
/// </summary>
public readonly record struct LumenPreviewKind(LumenPreviewKindTag Tag, string Subtype = "")
{
    public static readonly LumenPreviewKind Text = new(LumenPreviewKindTag.Text);
    public static readonly LumenPreviewKind Image = new(LumenPreviewKindTag.Image);
    public static readonly LumenPreviewKind Color = new(LumenPreviewKindTag.Color);
    public static readonly LumenPreviewKind Link = new(LumenPreviewKindTag.Link);
    public static readonly LumenPreviewKind Pdf = new(LumenPreviewKindTag.Pdf);
    public static readonly LumenPreviewKind Audio = new(LumenPreviewKindTag.Audio);
    public static readonly LumenPreviewKind Video = new(LumenPreviewKindTag.Video);
    public static readonly LumenPreviewKind Collection = new(LumenPreviewKindTag.Collection);
    public static readonly LumenPreviewKind File = new(LumenPreviewKindTag.File);

    public static LumenPreviewKind Code(string language) => new(LumenPreviewKindTag.Code, language ?? "js");
    public static LumenPreviewKind Office(string format) => new(LumenPreviewKindTag.Office, (format ?? string.Empty).ToLowerInvariant());

    public bool IsMedia => Tag is LumenPreviewKindTag.Audio or LumenPreviewKindTag.Video;

    public string DisplayLabel => Tag switch
    {
        LumenPreviewKindTag.Text => "文本",
        LumenPreviewKindTag.Code => LumenClassifier.LanguageDisplayName(Subtype),
        LumenPreviewKindTag.Image => "图片",
        LumenPreviewKindTag.Color => "颜色",
        LumenPreviewKindTag.Link => "链接",
        LumenPreviewKindTag.Pdf => "PDF 文档",
        LumenPreviewKindTag.Office => Subtype.ToLowerInvariant() switch
        {
            "docx" => "Word 文档",
            "xlsx" => "Excel 工作簿",
            "pptx" => "PowerPoint 演示文稿",
            _ => "Office 文档"
        },
        LumenPreviewKindTag.Audio => "音频",
        LumenPreviewKindTag.Video => "视频",
        LumenPreviewKindTag.Collection => "文件集合",
        _ => "文件"
    };

    public string BadgeCode => Tag switch
    {
        LumenPreviewKindTag.Text => "TXT",
        LumenPreviewKindTag.Code => string.IsNullOrEmpty(Subtype) ? "CODE" : Subtype.ToUpperInvariant(),
        LumenPreviewKindTag.Image => "IMG",
        LumenPreviewKindTag.Color => "HEX",
        LumenPreviewKindTag.Link => "URL",
        LumenPreviewKindTag.Pdf => "PDF",
        LumenPreviewKindTag.Office => Subtype.ToLowerInvariant() switch
        {
            "docx" => "DOC",
            "xlsx" => "XLS",
            "pptx" => "PPT",
            _ => "OFF"
        },
        LumenPreviewKindTag.Audio => "MP3",
        LumenPreviewKindTag.Video => "MP4",
        LumenPreviewKindTag.Collection => "SET",
        _ => "FILE"
    };
}

/// <summary>
/// Unified preview target consumable by any renderer in <see cref="LumenPreviewRegistry"/>.
/// </summary>
public sealed class LumenPreviewItem
{
    public string Id { get; init; } = string.Empty;
    public string Title { get; init; } = string.Empty;
    public string Subtitle { get; init; } = string.Empty;
    public LumenPreviewKind Kind { get; init; } = LumenPreviewKind.File;
    public LumenClipboardItem? ClipboardItem { get; init; }
    public int? FileIndex { get; init; }
    public string? LocalPath { get; init; }
    public long ByteSize { get; init; }
    public string? InlineText { get; init; }
    public int SeedIndex { get; init; }
    public IReadOnlyList<LumenPreviewItem> CollectionChildren { get; init; } = Array.Empty<LumenPreviewItem>();

    public string CacheKey
    {
        get
        {
            if (ClipboardItem is not null)
            {
                return FileIndex.HasValue
                    ? $"clip:{ClipboardItem.Id}:file:{FileIndex.Value}"
                    : $"clip:{ClipboardItem.Id}";
            }
            if (!string.IsNullOrEmpty(LocalPath))
            {
                return $"local:{LocalPath}";
            }
            return $"inline:{Id}";
        }
    }

    public string SizeLabel
    {
        get
        {
            if (CollectionChildren.Count > 0) return $"{CollectionChildren.Count} 个项目";
            if (ByteSize > 0) return LumenFormatters.ByteCount(ByteSize);
            if (!string.IsNullOrEmpty(InlineText)) return LumenFormatters.ByteCount(System.Text.Encoding.UTF8.GetByteCount(InlineText));
            return ClipboardItem?.FormattedSize ?? "内容预览";
        }
    }

    public static LumenPreviewKind ClassifyFilePath(string filePath)
    {
        var ext = Path.GetExtension(filePath).TrimStart('.').ToLowerInvariant();
        if (ext == "pdf") return LumenPreviewKind.Pdf;
        if (LumenClassifier.OfficeExtensions.Contains(ext)) return LumenPreviewKind.Office(ext);
        if (LumenClassifier.ImageExtensions.Contains(ext)) return LumenPreviewKind.Image;
        if (LumenClassifier.AudioExtensions.Contains(ext)) return LumenPreviewKind.Audio;
        if (LumenClassifier.VideoExtensions.Contains(ext)) return LumenPreviewKind.Video;
        if (LumenClassifier.CodeExtensions.Contains(ext))
        {
            return LumenPreviewKind.Code(LumenClassifier.DetectLanguage(filePath, string.Empty));
        }
        if (LumenClassifier.TextExtensions.Contains(ext)) return LumenPreviewKind.Text;
        return LumenPreviewKind.File;
    }

    public static LumenPreviewKind ClassifyItem(LumenClipboardItem item)
    {
        switch (item.Kind)
        {
            case "image":
                return LumenPreviewKind.Image;
            case "link":
                return LumenPreviewKind.Link;
            case "file":
                if (item.SafeFiles.Count > 1) return LumenPreviewKind.Collection;
                if (item.PrimaryFilePath is { } path) return ClassifyFilePath(path);
                return LumenPreviewKind.File;
            default:
                var text = item.EffectiveText.Trim();
                if (LumenClassifier.TryParseHexColor(text, out _)) return LumenPreviewKind.Color;
                if (LumenClassifier.LooksLikeCode(text))
                {
                    return LumenPreviewKind.Code(LumenClassifier.DetectLanguage(null, text));
                }
                return LumenPreviewKind.Text;
        }
    }

    public static LumenPreviewItem FromClipboardItem(LumenClipboardItem item, int seedIndex = 0)
    {
        var kind = ClassifyItem(item);
        if (item.Kind == "file" && item.SafeFiles.Count > 1)
        {
            var children = new List<LumenPreviewItem>(item.SafeFiles.Count);
            for (var i = 0; i < item.SafeFiles.Count; i++)
            {
                children.Add(FromIndexedFile(item, i, item.SafeFiles[i], i));
            }
            return new LumenPreviewItem
            {
                Id = item.Id,
                Title = item.DisplayTitle,
                Subtitle = $"{item.SourceLabel} · {item.RelativeTime}",
                Kind = LumenPreviewKind.Collection,
                ClipboardItem = item,
                FileIndex = null,
                LocalPath = null,
                ByteSize = item.ByteSize,
                InlineText = string.Join("\n", item.SafeFiles),
                SeedIndex = seedIndex,
                CollectionChildren = children
            };
        }

        string? singlePath = null;
        if (item.Kind == "file" && item.PrimaryFilePath is { } p && File.Exists(p))
        {
            singlePath = p;
        }
        return new LumenPreviewItem
        {
            Id = item.Id,
            Title = item.DisplayTitle,
            Subtitle = $"{item.SourceLabel} · {item.RelativeTime}",
            Kind = kind,
            ClipboardItem = item,
            FileIndex = item.Kind == "file" ? 0 : null,
            LocalPath = singlePath,
            ByteSize = item.ByteSize,
            InlineText = item.Kind is "text" or "link" ? item.EffectiveText : null,
            SeedIndex = seedIndex
        };
    }

    private static LumenPreviewItem FromIndexedFile(LumenClipboardItem item, int index, string rawPath, int seedIndex)
    {
        var clean = rawPath.Trim();
        var exists = !string.IsNullOrEmpty(clean) && File.Exists(clean);
        long size = 0;
        if (exists)
        {
            try { size = new FileInfo(clean).Length; } catch { }
        }
        var name = Path.GetFileName(clean);
        return new LumenPreviewItem
        {
            Id = $"{item.Id}#{index}",
            Title = string.IsNullOrEmpty(name) ? clean : name,
            Subtitle = item.SourceLabel,
            Kind = ClassifyFilePath(clean),
            ClipboardItem = item,
            FileIndex = index,
            LocalPath = exists ? clean : null,
            ByteSize = size,
            SeedIndex = seedIndex
        };
    }

    public static List<LumenPreviewItem> Flatten(IReadOnlyList<LumenClipboardItem> items)
    {
        var result = new List<LumenPreviewItem>();
        for (var i = 0; i < items.Count; i++)
        {
            var wrapped = FromClipboardItem(items[i], i);
            if (wrapped.CollectionChildren.Count > 0)
            {
                result.AddRange(wrapped.CollectionChildren);
            }
            else
            {
                result.Add(wrapped);
            }
        }
        return result;
    }

    public static List<LumenPreviewItem> FromLocalPaths(IReadOnlyList<string> paths)
    {
        var result = new List<LumenPreviewItem>(paths.Count);
        for (var i = 0; i < paths.Count; i++)
        {
            var p = paths[i].Trim();
            if (string.IsNullOrEmpty(p) || !File.Exists(p)) continue;
            long size = 0;
            try { size = new FileInfo(p).Length; } catch { }
            result.Add(new LumenPreviewItem
            {
                Id = $"local:{p}",
                Title = Path.GetFileName(p),
                Subtitle = "本地文件",
                Kind = ClassifyFilePath(p),
                LocalPath = p,
                ByteSize = size,
                SeedIndex = i
            });
        }
        return result;
    }
}

// MARK: - Bounded Preview Cache

/// <summary>
/// Holds a WinRT <see cref="PdfDocument"/> alongside its open backing stream so lazy page rendering remains valid.
/// </summary>
public sealed class LumenCachedPdfDocument : IDisposable
{
    public PdfDocument Document { get; }
    private readonly IDisposable? _backingStream;
    private readonly IDisposable? _winrtStream;
    private int _disposed;

    public LumenCachedPdfDocument(PdfDocument document, IDisposable? backingStream, IDisposable? winrtStream = null)
    {
        Document = document;
        _backingStream = backingStream;
        _winrtStream = winrtStream;
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        try { _winrtStream?.Dispose(); } catch { }
        try { _backingStream?.Dispose(); } catch { }
    }
}

internal sealed class LumenBoundedLruCache<TValue>
{
    private sealed class Entry
    {
        public string Key { get; init; } = string.Empty;
        public TValue Value { get; init; } = default!;
        public long Cost { get; init; }
    }

    private readonly object _lock = new();
    private readonly int _maxCount;
    private readonly long _maxCost;
    private readonly Action<TValue>? _onEvict;
    private readonly Dictionary<string, LinkedListNode<Entry>> _map = new(StringComparer.Ordinal);
    private readonly LinkedList<Entry> _lru = new();
    private long _totalCost;

    public LumenBoundedLruCache(int maxCount, long maxCost = long.MaxValue, Action<TValue>? onEvict = null)
    {
        _maxCount = Math.Max(1, maxCount);
        _maxCost = Math.Max(1, maxCost);
        _onEvict = onEvict;
    }

    public bool TryGet(string key, out TValue value)
    {
        lock (_lock)
        {
            if (_map.TryGetValue(key, out var node))
            {
                _lru.Remove(node);
                _lru.AddFirst(node);
                value = node.Value.Value;
                return true;
            }
        }
        value = default!;
        return false;
    }

    public void Set(string key, TValue value, long cost = 1)
    {
        List<TValue>? evicted = null;
        cost = Math.Max(1, cost);
        lock (_lock)
        {
            if (_map.TryGetValue(key, out var existing))
            {
                _totalCost -= existing.Value.Cost;
                _lru.Remove(existing);
                _map.Remove(key);
                if (!ReferenceEquals(existing.Value.Value, value))
                {
                    evicted ??= new List<TValue>();
                    evicted.Add(existing.Value.Value);
                }
            }

            var node = new LinkedListNode<Entry>(new Entry { Key = key, Value = value, Cost = cost });
            _lru.AddFirst(node);
            _map[key] = node;
            _totalCost += cost;

            while (_lru.Count > _maxCount || (_totalCost > _maxCost && _lru.Count > 1))
            {
                var tail = _lru.Last;
                if (tail is null) break;
                _lru.RemoveLast();
                _map.Remove(tail.Value.Key);
                _totalCost -= tail.Value.Cost;
                evicted ??= new List<TValue>();
                evicted.Add(tail.Value.Value);
            }
        }

        if (evicted is not null && _onEvict is not null)
        {
            foreach (var v in evicted) _onEvict(v);
        }
    }

    public void Clear()
    {
        List<TValue>? all = null;
        lock (_lock)
        {
            if (_onEvict is not null && _lru.Count > 0)
            {
                all = _lru.Select(e => e.Value).ToList();
            }
            _map.Clear();
            _lru.Clear();
            _totalCost = 0;
        }
        if (all is not null && _onEvict is not null)
        {
            foreach (var v in all) _onEvict(v);
        }
    }
}

/// <summary>
/// Shared bounded LRU cache across Inspector thumbnails, Orbit cards, and Quick Look Preview.
/// Budgets match §3.4 of docs/architecture/paste-lumen-v7-native-contract.md.
/// </summary>
public sealed class LumenPreviewCache
{
    public static LumenPreviewCache Shared { get; } = new();

    private readonly LumenBoundedLruCache<BitmapSource> _images = new(96, 64L * 1024 * 1024);
    private readonly LumenBoundedLruCache<LumenCachedPdfDocument> _pdfs = new(12, long.MaxValue, doc => doc.Dispose());
    private readonly LumenBoundedLruCache<double[]> _waveforms = new(32);
    private readonly LumenBoundedLruCache<LumenServerPreview> _serverPreviews = new(48);
    private readonly LumenBoundedLruCache<string> _texts = new(48, 8L * 1024 * 1024);

    public BitmapSource? GetImage(string key) => _images.TryGet(key, out var bmp) ? bmp : null;

    public void StoreImage(BitmapSource image, string key)
    {
        var cost = Math.Max(1L, (long)Math.Max(1, image.PixelWidth) * Math.Max(1, image.PixelHeight) * 4L);
        _images.Set(key, image, cost);
    }

    public LumenCachedPdfDocument? GetPdf(string key) => _pdfs.TryGet(key, out var doc) ? doc : null;
    public void StorePdf(LumenCachedPdfDocument doc, string key) => _pdfs.Set(key, doc);

    public double[]? GetWaveform(string key) => _waveforms.TryGet(key, out var peaks) ? peaks : null;
    public void StoreWaveform(double[] peaks, string key) => _waveforms.Set(key, peaks);

    public LumenServerPreview? GetServerPreview(string key) => _serverPreviews.TryGet(key, out var preview) ? preview : null;
    public void StoreServerPreview(LumenServerPreview preview, string key) => _serverPreviews.Set(key, preview);

    public string? GetText(string key) => _texts.TryGet(key, out var text) ? text : null;

    public void StoreText(string text, string key)
    {
        var cost = Math.Max(1L, System.Text.Encoding.UTF8.GetByteCount(text ?? string.Empty));
        _texts.Set(key, text ?? string.Empty, cost);
    }

    public void ClearAll()
    {
        _images.Clear();
        _pdfs.Clear();
        _waveforms.Clear();
        _serverPreviews.Clear();
        _texts.Clear();
    }
}

// MARK: - Renderer Interface & Priority Registry

public sealed class LumenPreviewContext
{
    public required LumenClipboardStore Store { get; init; }
    public required LumenPreviewCache Cache { get; init; }
    public required LumenPalette Palette { get; init; }
    public required Action<int, bool> OnStepQueue { get; init; }
    public required Action<int> OnSelectQueueIndex { get; init; }
    public required Action<string> OnToast { get; init; }
    public required Action<LumenPreviewItem> OnCopyItem { get; init; }
}

public interface IPreviewRendererView
{
    FrameworkElement Visual { get; }
    void Load(LumenPreviewItem item, LumenPreviewContext ctx);
    void ApplyTheme(LumenPalette palette);
    void ZoomIn();
    void ZoomOut();
    void ResetZoom();
    bool TogglePlayPause();
    bool StepPage(int delta);
    void CopyPrimaryContent();
    void Teardown();
}

public interface IPreviewRenderer
{
    string RendererId { get; }
    int Priority { get; }
    bool CanRender(LumenPreviewItem item);
    IPreviewRendererView CreateView(LumenPreviewItem item, LumenPreviewContext ctx);
}

public abstract class LumenPreviewRendererViewBase : Grid, IPreviewRendererView
{
    protected LumenPreviewItem? CurrentItem { get; private set; }
    protected LumenPreviewContext? CurrentContext { get; private set; }
    protected int LoadGeneration { get; private set; }

    public FrameworkElement Visual => this;

    protected int NextGeneration() => ++LoadGeneration;
    protected bool IsCurrentGeneration(int gen) => gen == LoadGeneration;

    public virtual void Load(LumenPreviewItem item, LumenPreviewContext ctx)
    {
        CurrentItem = item;
        CurrentContext = ctx;
    }

    public virtual void ApplyTheme(LumenPalette palette) { }
    public virtual void ZoomIn() { }
    public virtual void ZoomOut() { }
    public virtual void ResetZoom() { }
    public virtual bool TogglePlayPause() => false;
    public virtual bool StepPage(int delta) => false;

    public virtual void CopyPrimaryContent()
    {
        if (CurrentItem is not null)
        {
            CurrentContext?.OnCopyItem(CurrentItem);
        }
    }

    public virtual void Teardown()
    {
        LoadGeneration++;
    }
}

/// <summary>
/// Priority-ordered registry resolving the best native WPF renderer for any preview item.
/// Priority order: pdf(100) -> audio(95) -> video(94) -> office(90) -> image(88) ->
/// color(86) -> code(84) -> collection(82) -> text/link(70) -> file fallback(0).
/// </summary>
public sealed class LumenPreviewRegistry
{
    public static LumenPreviewRegistry Shared { get; } = CreateDefault();

    private readonly List<IPreviewRenderer> _renderers = new();

    private static LumenPreviewRegistry CreateDefault()
    {
        var registry = new LumenPreviewRegistry();
        registry.Register(new LumenPdfRenderer());
        registry.Register(new LumenAudioRenderer());
        registry.Register(new LumenVideoRenderer());
        registry.Register(new LumenOfficeRenderer());
        registry.Register(new LumenImageRenderer());
        registry.Register(new LumenColorRenderer());
        registry.Register(new LumenCodeRenderer());
        registry.Register(new LumenCollectionRenderer());
        registry.Register(new LumenTextRenderer());
        registry.Register(new LumenFileFallbackRenderer());
        return registry;
    }

    public void Register(IPreviewRenderer renderer)
    {
        _renderers.RemoveAll(r => string.Equals(r.RendererId, renderer.RendererId, StringComparison.Ordinal));
        _renderers.Add(renderer);
        _renderers.Sort((a, b) => b.Priority.CompareTo(a.Priority));
    }

    public IReadOnlyList<string> RegisteredIds() => _renderers.Select(r => r.RendererId).ToArray();

    public IPreviewRenderer Resolve(LumenPreviewItem item)
    {
        foreach (var renderer in _renderers)
        {
            if (renderer.CanRender(item)) return renderer;
        }
        return new LumenFileFallbackRenderer();
    }

    public IPreviewRendererView CreateView(LumenPreviewItem item, LumenPreviewContext ctx)
    {
        var renderer = Resolve(item);
        var view = renderer.CreateView(item, ctx);
        view.Load(item, ctx);
        return view;
    }
}
