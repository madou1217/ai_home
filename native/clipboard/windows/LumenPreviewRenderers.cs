using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using System.Xml.Linq;
using NAudio.Wave;
using Windows.Data.Pdf;
using Windows.Storage.Streams;

namespace AihLumenClipboard;

internal static class LumenRendererChrome
{
    public static Border CreateToolbar(LumenPalette palette, bool darkOverride, out DockPanel contentPanel)
    {
        contentPanel = new DockPanel
        {
            LastChildFill = false,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(14, 0, 14, 0)
        };
        return new Border
        {
            Height = 42,
            Background = darkOverride ? palette.CodeToolbarBackground : palette.Surface,
            BorderBrush = darkOverride ? LumenPalette.Brush(LumenPalette.WithAlpha(Colors.White, 0.10)) : palette.Border,
            BorderThickness = new Thickness(0, 0, 0, 1),
            Child = contentPanel
        };
    }

    public static TextBlock CreateStatusText(string text, LumenPalette palette, bool darkOverride = false)
    {
        return new TextBlock
        {
            Text = text,
            FontFamily = LumenFonts.Ui,
            FontSize = 11.5,
            FontWeight = FontWeights.Medium,
            Foreground = darkOverride ? LumenPalette.Brush(LumenPalette.WithAlpha(palette.CodeBaseTextColor, 0.84)) : palette.Muted,
            VerticalAlignment = VerticalAlignment.Center,
            TextTrimming = TextTrimming.CharacterEllipsis
        };
    }
}

// ============================================================================
// 1. Native Windows.Data.Pdf Renderer (Priority 100)
// ============================================================================

public sealed class LumenPdfRenderer : IPreviewRenderer
{
    public string RendererId => "native.winrt.pdf";
    public int Priority => 100;
    public bool CanRender(LumenPreviewItem item) => item.Kind.Tag == LumenPreviewKindTag.Pdf;
    public IPreviewRendererView CreateView(LumenPreviewItem item, LumenPreviewContext ctx) => new LumenPdfRendererView(ctx.Palette);

    /// <summary>
    /// Renders page 0 thumbnail of a local PDF file via Windows.Data.Pdf for Inspector / Orbit cards.
    /// </summary>
    public static async Task<BitmapImage?> RenderFirstPageThumbnailAsync(string localPath, uint targetWidth = 260)
    {
        if (string.IsNullOrWhiteSpace(localPath) || !File.Exists(localPath)) return null;
        var thumbKey = $"pdfthumb:{localPath}:{targetWidth}";
        if (LumenPreviewCache.Shared.GetImage(thumbKey) is BitmapImage cached) return cached;

        try
        {
            await using var fs = new FileStream(localPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var ras = fs.AsRandomAccessStream();
            var doc = await PdfDocument.LoadFromStreamAsync(ras).AsTask().ConfigureAwait(false);
            if (doc.PageCount == 0) return null;
            using var page = doc.GetPage(0);
            var aspect = page.Size.Width > 1 ? page.Size.Height / page.Size.Width : 1.35;
            using var outStream = new InMemoryRandomAccessStream();
            await page.RenderToStreamAsync(outStream, new PdfPageRenderOptions
            {
                DestinationWidth = targetWidth,
                DestinationHeight = (uint)Math.Max(1, Math.Round(targetWidth * aspect))
            }).AsTask().ConfigureAwait(false);
            outStream.Seek(0);
            using var readStream = outStream.AsStreamForRead();
            using var ms = new MemoryStream();
            await readStream.CopyToAsync(ms).ConfigureAwait(false);
            var bmp = LumenFormatters.DecodeBitmapImage(ms.ToArray());
            if (bmp is not null)
            {
                LumenPreviewCache.Shared.StoreImage(bmp, thumbKey);
            }
            return bmp;
        }
        catch
        {
            return null;
        }
    }
}

public sealed class LumenPdfRendererView : LumenPreviewRendererViewBase
{
    private readonly LumenPalette _palette;
    private readonly TextBlock _infoLabel;
    private readonly TextBlock _pageLabel;
    private readonly TextBlock _zoomLabel;
    private readonly StackPanel _thumbRailStack = new() { Orientation = Orientation.Vertical, Margin = new Thickness(8) };
    private readonly ScrollViewer _pageScroll = new() { HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    private readonly Image _pageImage = new() { Stretch = Stretch.Uniform, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
    private readonly Border _pagePaper = new();
    private readonly TextBlock _emptyLabel = new();

    private readonly List<Border> _thumbBorders = new();
    private LumenCachedPdfDocument? _cachedDoc;
    private uint _currentPageIndex;
    private double _zoomPercent = 100.0;
    private bool _fitMode = true;
    private int _pageRenderGen;

    public LumenPdfRendererView(LumenPalette palette)
    {
        _palette = palette;
        Background = palette.WindowBackground;

        RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        var toolbar = LumenRendererChrome.CreateToolbar(palette, false, out var bar);
        _infoLabel = LumenRendererChrome.CreateStatusText("PDF 文档", palette);
        _pageLabel = LumenRendererChrome.CreateStatusText("第 1 / 1 页", palette);
        _pageLabel.Margin = new Thickness(6, 0, 6, 0);
        _zoomLabel = LumenRendererChrome.CreateStatusText("适配", palette);
        _zoomLabel.Margin = new Thickness(6, 0, 6, 0);

        DockPanel.SetDock(_infoLabel, Dock.Left);
        bar.Children.Add(_infoLabel);

        var zoomPanel = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        zoomPanel.Children.Add(LumenUiFactory.CreatePillButton("−", palette, ZoomOut));
        zoomPanel.Children.Add(_zoomLabel);
        zoomPanel.Children.Add(LumenUiFactory.CreatePillButton("+", palette, ZoomIn));
        var fitBtn = LumenUiFactory.CreatePillButton("适配", palette, ResetZoom);
        fitBtn.Margin = new Thickness(6, 0, 0, 0);
        zoomPanel.Children.Add(fitBtn);
        DockPanel.SetDock(zoomPanel, Dock.Right);
        bar.Children.Add(zoomPanel);

        var navPanel = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(16, 0, 16, 0)
        };
        navPanel.Children.Add(LumenUiFactory.CreatePillButton("‹", palette, () => _ = StepPage(-1)));
        navPanel.Children.Add(_pageLabel);
        navPanel.Children.Add(LumenUiFactory.CreatePillButton("›", palette, () => _ = StepPage(1)));
        DockPanel.SetDock(navPanel, Dock.Right);
        bar.Children.Add(navPanel);

        SetRow(toolbar, 0);
        Children.Add(toolbar);

        var body = new Grid();
        body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(116) });
        body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1) });
        body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        var railScroll = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Background = palette.Surface,
            Content = _thumbRailStack
        };
        SetColumn(railScroll, 0);
        body.Children.Add(railScroll);

        var divider = new Border { Background = palette.Border };
        SetColumn(divider, 1);
        body.Children.Add(divider);

        _pagePaper.Background = Brushes.White;
        _pagePaper.CornerRadius = new CornerRadius(4);
        _pagePaper.BorderBrush = palette.Border;
        _pagePaper.BorderThickness = new Thickness(1);
        _pagePaper.Margin = new Thickness(24);
        _pagePaper.HorizontalAlignment = HorizontalAlignment.Center;
        _pagePaper.VerticalAlignment = VerticalAlignment.Center;
        _pagePaper.Child = _pageImage;

        _pageScroll.Content = _pagePaper;
        _pageScroll.SizeChanged += (_, _) =>
        {
            if (_fitMode && _cachedDoc is not null) ApplyPageSizing();
        };

        var stage = new Grid();
        stage.Children.Add(_pageScroll);

        _emptyLabel.Text = "正在加载 PDF…";
        _emptyLabel.FontFamily = LumenFonts.Ui;
        _emptyLabel.FontSize = 13;
        _emptyLabel.Foreground = palette.Muted;
        _emptyLabel.HorizontalAlignment = HorizontalAlignment.Center;
        _emptyLabel.VerticalAlignment = VerticalAlignment.Center;
        stage.Children.Add(_emptyLabel);

        SetColumn(stage, 2);
        body.Children.Add(stage);

        SetRow(body, 1);
        Children.Add(body);
    }

    public override void Load(LumenPreviewItem item, LumenPreviewContext ctx)
    {
        base.Load(item, ctx);
        var gen = NextGeneration();
        _cachedDoc = null;
        _currentPageIndex = 0;
        _zoomPercent = 100.0;
        _fitMode = true;
        _zoomLabel.Text = "适配";
        _thumbRailStack.Children.Clear();
        _thumbBorders.Clear();
        _pageImage.Source = null;
        _emptyLabel.Visibility = Visibility.Visible;
        _emptyLabel.Text = "正在加载 PDF…";

        if (ctx.Cache.GetPdf(item.CacheKey) is { } cached)
        {
            ApplyDocument(cached, gen);
            return;
        }
        _ = LoadPdfAsync(item, ctx, gen);
    }

    private async Task LoadPdfAsync(LumenPreviewItem item, LumenPreviewContext ctx, int gen)
    {
        try
        {
            LumenCachedPdfDocument? loaded = null;
            if (!string.IsNullOrEmpty(item.LocalPath) && File.Exists(item.LocalPath))
            {
                var fs = new FileStream(item.LocalPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                var ras = fs.AsRandomAccessStream();
                try
                {
                    var doc = await PdfDocument.LoadFromStreamAsync(ras).AsTask().ConfigureAwait(false);
                    loaded = new LumenCachedPdfDocument(doc, fs, ras);
                }
                catch
                {
                    ras.Dispose();
                    fs.Dispose();
                    throw;
                }
            }
            else if (item.ClipboardItem is { } clip)
            {
                var (bytes, _) = await ctx.Store.Api.FetchItemFileDataAsync(clip.Id, item.FileIndex ?? 0).ConfigureAwait(false);
                var ms = new MemoryStream(bytes, writable: false);
                var ras = ms.AsRandomAccessStream();
                try
                {
                    var doc = await PdfDocument.LoadFromStreamAsync(ras).AsTask().ConfigureAwait(false);
                    loaded = new LumenCachedPdfDocument(doc, ms, ras);
                }
                catch
                {
                    ras.Dispose();
                    ms.Dispose();
                    throw;
                }
            }

            LumenWpfHost.RunOnUi(() =>
            {
                if (!IsCurrentGeneration(gen))
                {
                    loaded?.Dispose();
                    return;
                }
                if (loaded is null)
                {
                    _emptyLabel.Text = "PDF 文件不可用";
                    return;
                }
                ctx.Cache.StorePdf(loaded, item.CacheKey);
                ApplyDocument(loaded, gen);
            });
        }
        catch (Exception ex)
        {
            LumenWpfHost.RunOnUi(() =>
            {
                if (!IsCurrentGeneration(gen)) return;
                _emptyLabel.Text = $"无法解析 PDF：{ex.Message}";
            });
        }
    }

    private void ApplyDocument(LumenCachedPdfDocument cached, int gen)
    {
        _cachedDoc = cached;
        _currentPageIndex = 0;
        _emptyLabel.Visibility = Visibility.Collapsed;
        var count = cached.Document.PageCount;
        _infoLabel.Text = $"PDF · {count} 页";
        BuildThumbnailRail(cached.Document, gen);
        SelectPage(0);
    }

    private void BuildThumbnailRail(PdfDocument doc, int gen)
    {
        _thumbRailStack.Children.Clear();
        _thumbBorders.Clear();
        var maxThumbPages = Math.Min(doc.PageCount, 60u);
        for (uint i = 0; i < maxThumbPages; i++)
        {
            var pageIdx = i;
            var img = new Image { Width = 78, Height = 102, Stretch = Stretch.Uniform };
            var num = new TextBlock
            {
                Text = (pageIdx + 1).ToString(CultureInfo.InvariantCulture),
                FontFamily = LumenFonts.Mono,
                FontSize = 10,
                Foreground = _palette.Muted,
                HorizontalAlignment = HorizontalAlignment.Center,
                Margin = new Thickness(0, 4, 0, 0)
            };
            var inner = new StackPanel { Orientation = Orientation.Vertical, HorizontalAlignment = HorizontalAlignment.Center };
            inner.Children.Add(new Border
            {
                Background = Brushes.White,
                BorderBrush = _palette.Border,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(3),
                Child = img
            });
            inner.Children.Add(num);

            var card = new Border
            {
                CornerRadius = new CornerRadius(8),
                BorderThickness = new Thickness(1.5),
                BorderBrush = Brushes.Transparent,
                Background = Brushes.Transparent,
                Padding = new Thickness(6),
                Margin = new Thickness(0, 0, 0, 6),
                Cursor = Cursors.Hand,
                Child = inner
            };
            card.MouseLeftButtonUp += (_, _) => SelectPage(pageIdx);
            _thumbBorders.Add(card);
            _thumbRailStack.Children.Add(card);

            _ = RenderPageBitmapAsync(doc, pageIdx, 156).ContinueWith(t =>
            {
                if (t.Status == TaskStatus.RanToCompletion && t.Result is { } bmp)
                {
                    LumenWpfHost.RunOnUi(() =>
                    {
                        if (IsCurrentGeneration(gen)) img.Source = bmp;
                    });
                }
            }, TaskScheduler.Default);
        }
    }

    private void SelectPage(uint index)
    {
        if (_cachedDoc is null || _cachedDoc.Document.PageCount == 0) return;
        _currentPageIndex = Math.Min(index, _cachedDoc.Document.PageCount - 1);
        _pageLabel.Text = $"第 {_currentPageIndex + 1} / {_cachedDoc.Document.PageCount} 页";

        for (var i = 0; i < _thumbBorders.Count; i++)
        {
            var selected = i == (int)_currentPageIndex;
            _thumbBorders[i].BorderBrush = selected ? _palette.Accent : Brushes.Transparent;
            _thumbBorders[i].Background = selected ? _palette.AccentSoft : Brushes.Transparent;
        }

        var renderGen = ++_pageRenderGen;
        var doc = _cachedDoc.Document;
        var targetPx = (uint)Math.Clamp(Math.Round(1200 * (_zoomPercent / 100.0)), 640, 2600);
        _ = RenderPageBitmapAsync(doc, _currentPageIndex, targetPx).ContinueWith(t =>
        {
            if (t.Status == TaskStatus.RanToCompletion && t.Result is { } bmp)
            {
                LumenWpfHost.RunOnUi(() =>
                {
                    if (renderGen != _pageRenderGen || _cachedDoc is null) return;
                    _pageImage.Source = bmp;
                    ApplyPageSizing();
                });
            }
        }, TaskScheduler.Default);
    }

    private void ApplyPageSizing()
    {
        if (_pageImage.Source is not BitmapSource bmp) return;
        var viewW = Math.Max(300, _pageScroll.ViewportWidth - 56);
        var viewH = Math.Max(260, _pageScroll.ViewportHeight - 56);
        var aspect = bmp.PixelWidth > 0 ? (double)bmp.PixelHeight / bmp.PixelWidth : 1.4;
        if (_fitMode)
        {
            var fitW = Math.Min(viewW, viewH / Math.Max(0.1, aspect));
            _pageImage.Width = Math.Max(180, fitW);
            _pageImage.Height = _pageImage.Width * aspect;
        }
        else
        {
            var baseW = Math.Min(760, viewW);
            _pageImage.Width = Math.Max(180, baseW * (_zoomPercent / 100.0));
            _pageImage.Height = _pageImage.Width * aspect;
        }
    }

    private static async Task<BitmapImage?> RenderPageBitmapAsync(PdfDocument doc, uint pageIndex, uint widthPx)
    {
        try
        {
            using var page = doc.GetPage(pageIndex);
            var aspect = page.Size.Width > 1 ? page.Size.Height / page.Size.Width : 1.4;
            using var outStream = new InMemoryRandomAccessStream();
            await page.RenderToStreamAsync(outStream, new PdfPageRenderOptions
            {
                DestinationWidth = widthPx,
                DestinationHeight = (uint)Math.Max(1, Math.Round(widthPx * aspect))
            }).AsTask().ConfigureAwait(false);
            outStream.Seek(0);
            using var readStream = outStream.AsStreamForRead();
            using var ms = new MemoryStream();
            await readStream.CopyToAsync(ms).ConfigureAwait(false);
            return LumenFormatters.DecodeBitmapImage(ms.ToArray());
        }
        catch
        {
            return null;
        }
    }

    public override bool StepPage(int delta)
    {
        if (_cachedDoc is null || _cachedDoc.Document.PageCount == 0) return false;
        var next = (long)_currentPageIndex + delta;
        if (next < 0 || next >= _cachedDoc.Document.PageCount) return false;
        SelectPage((uint)next);
        return true;
    }

    public override void ZoomIn()
    {
        _fitMode = false;
        _zoomPercent = Math.Min(250, _zoomPercent + 25);
        _zoomLabel.Text = $"{(int)_zoomPercent}%";
        SelectPage(_currentPageIndex);
    }

    public override void ZoomOut()
    {
        _fitMode = false;
        _zoomPercent = Math.Max(50, _zoomPercent - 25);
        _zoomLabel.Text = $"{(int)_zoomPercent}%";
        SelectPage(_currentPageIndex);
    }

    public override void ResetZoom()
    {
        _fitMode = true;
        _zoomPercent = 100;
        _zoomLabel.Text = "适配";
        ApplyPageSizing();
    }

    public override void Teardown()
    {
        base.Teardown();
        _pageRenderGen++;
        _cachedDoc = null;
        _pageImage.Source = null;
    }
}

// ============================================================================
// 2. Native MediaPlayer + NAudio Peak Waveform Renderer (Priority 95)
// ============================================================================

public sealed class LumenAudioRenderer : IPreviewRenderer
{
    public string RendererId => "native.wpf.audio";
    public int Priority => 95;
    public bool CanRender(LumenPreviewItem item) => item.Kind.Tag == LumenPreviewKindTag.Audio;
    public IPreviewRendererView CreateView(LumenPreviewItem item, LumenPreviewContext ctx) => new LumenAudioRendererView(ctx.Palette);
}

/// <summary>
/// Interactive 66-bar GPU-rendered WPF vector waveform control with click and drag scrub seek.
/// </summary>
public sealed class LumenWaveformControl : FrameworkElement
{
    private double[] _peaks = BuildFallbackPeaks();
    private double _progress;
    private bool _dragging;

    public Brush PlayedBrush { get; set; } = LumenPalette.Light.Accent;
    public Brush UnplayedBrush { get; set; } = LumenPalette.Brush(LumenPalette.WithAlpha(LumenPalette.Light.MutedColor, 0.35));
    public event Action<double>? SeekFractionRequested;

    public double[] Peaks
    {
        get => _peaks;
        set { _peaks = value is { Length: > 0 } ? value : BuildFallbackPeaks(); InvalidateVisual(); }
    }

    public double Progress
    {
        get => _progress;
        set { _progress = Math.Clamp(value, 0, 1); InvalidateVisual(); }
    }

    public LumenWaveformControl()
    {
        Cursor = Cursors.Hand;
        MouseLeftButtonDown += (_, e) =>
        {
            _dragging = true;
            CaptureMouse();
            EmitSeek(e.GetPosition(this).X);
        };
        MouseMove += (_, e) =>
        {
            if (_dragging) EmitSeek(e.GetPosition(this).X);
        };
        MouseLeftButtonUp += (_, _) =>
        {
            if (_dragging)
            {
                _dragging = false;
                ReleaseMouseCapture();
            }
        };
    }

    private void EmitSeek(double x)
    {
        var frac = Math.Clamp(x / Math.Max(1.0, ActualWidth), 0.0, 1.0);
        SeekFractionRequested?.Invoke(frac);
    }

    private static double[] BuildFallbackPeaks()
    {
        var vals = new double[66];
        for (var i = 0; i < vals.Length; i++)
        {
            var wave = Math.Abs(Math.Sin(i * 1.73) * Math.Cos(i * 0.21));
            vals[i] = 0.24 + wave * 0.72;
        }
        return vals;
    }

    protected override void OnRender(DrawingContext dc)
    {
        var w = ActualWidth;
        var h = ActualHeight;
        if (w <= 4 || h <= 4 || _peaks.Length == 0) return;

        var count = _peaks.Length;
        const double gap = 3.0;
        var totalGap = gap * (count - 1);
        var barW = Math.Clamp((w - totalGap) / count, 2.0, 5.5);
        var contentW = barW * count + totalGap;
        var startX = (w - contentW) * 0.5;
        var maxH = Math.Max(8.0, h - 6.0);

        for (var i = 0; i < count; i++)
        {
            var norm = Math.Clamp(_peaks[i], 0.12, 1.0);
            var barH = maxH * norm;
            var x = startX + i * (barW + gap);
            var y = (h - barH) * 0.5;
            var frac = count > 1 ? (double)i / (count - 1) : 0.0;
            var brush = frac <= _progress ? PlayedBrush : UnplayedBrush;
            dc.DrawRoundedRectangle(brush, null, new Rect(x, y, barW, barH), barW * 0.5, barW * 0.5);
        }
    }
}

public sealed class LumenAudioRendererView : LumenPreviewRendererViewBase
{
    private readonly LumenPalette _palette;
    private readonly LumenAlbumCoverControl _cover = new() { Width = 184, Height = 184 };
    private readonly ScaleTransform _coverScale = new(1, 1);
    private readonly TextBlock _titleLabel = new();
    private readonly TextBlock _subtitleLabel = new();
    private readonly LumenWaveformControl _waveform = new() { Width = 440, Height = 46 };
    private readonly TextBlock _nowLabel = new();
    private readonly TextBlock _durationLabel = new();
    private readonly Slider _seekSlider = new() { Minimum = 0, Maximum = 1000, Width = 340, VerticalAlignment = VerticalAlignment.Center };
    private readonly Slider _volumeSlider = new() { Minimum = 0, Maximum = 1, Value = 0.75, Width = 110, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock _playGlyph;
    private readonly TextBlock _repeatGlyph;
    private readonly TextBlock _statusLabel = new();

    private MediaPlayer? _player;
    private DispatcherTimer? _progressTimer;
    private double _durationSeconds;
    private bool _repeatEnabled;
    private bool _isPlaying;
    private bool _updatingSlider;

    public LumenAudioRendererView(LumenPalette palette)
    {
        _palette = palette;
        Background = palette.WindowBackground;

        _cover.RenderTransformOrigin = new Point(0.5, 0.5);
        _cover.RenderTransform = _coverScale;

        _titleLabel.FontFamily = LumenFonts.Ui;
        _titleLabel.FontSize = 21;
        _titleLabel.FontWeight = FontWeights.SemiBold;
        _titleLabel.Foreground = palette.Ink;
        _titleLabel.TextAlignment = TextAlignment.Center;
        _titleLabel.MaxWidth = 520;
        _titleLabel.TextTrimming = TextTrimming.CharacterEllipsis;
        _titleLabel.Margin = new Thickness(0, 16, 0, 2);

        _subtitleLabel.FontFamily = LumenFonts.Ui;
        _subtitleLabel.FontSize = 12;
        _subtitleLabel.Foreground = palette.Muted;
        _subtitleLabel.TextAlignment = TextAlignment.Center;
        _subtitleLabel.Margin = new Thickness(0, 0, 0, 14);

        _waveform.PlayedBrush = palette.Accent;
        _waveform.UnplayedBrush = LumenPalette.Brush(LumenPalette.WithAlpha(palette.MutedColor, 0.35));
        _waveform.SeekFractionRequested += SeekToFraction;

        _nowLabel.Text = "0:00";
        _nowLabel.FontFamily = LumenFonts.Mono;
        _nowLabel.FontSize = 11;
        _nowLabel.Foreground = palette.Muted;
        _nowLabel.Width = 42;
        _nowLabel.VerticalAlignment = VerticalAlignment.Center;

        _durationLabel.Text = "0:00";
        _durationLabel.FontFamily = LumenFonts.Mono;
        _durationLabel.FontSize = 11;
        _durationLabel.Foreground = palette.Muted;
        _durationLabel.Width = 42;
        _durationLabel.TextAlignment = TextAlignment.Right;
        _durationLabel.VerticalAlignment = VerticalAlignment.Center;

        _seekSlider.ValueChanged += (_, _) =>
        {
            if (!_updatingSlider) SeekToFraction(_seekSlider.Value / 1000.0);
        };

        var progressRow = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Center,
            Margin = new Thickness(0, 10, 0, 12)
        };
        progressRow.Children.Add(_nowLabel);
        progressRow.Children.Add(_seekSlider);
        progressRow.Children.Add(_durationLabel);

        _repeatGlyph = LumenUiFactory.CreateGlyph("\uE8EE", 15, palette.Ink);
        var repeatBtn = MakeTransportCircle(_repeatGlyph, 36, Brushes.Transparent, "单曲循环", () =>
        {
            _repeatEnabled = !_repeatEnabled;
            _repeatGlyph.Foreground = _repeatEnabled ? palette.Accent : palette.Ink;
        });

        var prevBtn = MakeTransportCircle(LumenUiFactory.CreateGlyph("\uE892", 15, palette.Ink), 36, Brushes.Transparent, "上一首", () => CurrentContext?.OnStepQueue(-1, true));
        _playGlyph = LumenUiFactory.CreateGlyph("\uE768", 20, Brushes.White);
        var playBtn = MakeTransportCircle(_playGlyph, 52, palette.Accent, "播放/暂停 (Space)", () => _ = TogglePlayPause());
        var nextBtn = MakeTransportCircle(LumenUiFactory.CreateGlyph("\uE893", 15, palette.Ink), 36, Brushes.Transparent, "下一首", () => CurrentContext?.OnStepQueue(1, true));

        var controlsRow = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center
        };
        foreach (var ctrl in new UIElement[] { repeatBtn, prevBtn, playBtn, nextBtn })
        {
            if (ctrl is FrameworkElement fe) fe.Margin = new Thickness(8, 0, 8, 0);
            controlsRow.Children.Add(ctrl);
        }

        _volumeSlider.ValueChanged += (_, _) =>
        {
            if (_player is not null) _player.Volume = _volumeSlider.Value;
        };

        var volRow = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Center,
            Margin = new Thickness(0, 12, 0, 0)
        };
        var volIcon = LumenUiFactory.CreateGlyph("\uE767", 13, palette.Muted);
        volIcon.Margin = new Thickness(0, 0, 8, 0);
        volRow.Children.Add(volIcon);
        volRow.Children.Add(_volumeSlider);

        _statusLabel.FontFamily = LumenFonts.Ui;
        _statusLabel.FontSize = 11;
        _statusLabel.Foreground = palette.Muted;
        _statusLabel.HorizontalAlignment = HorizontalAlignment.Center;
        _statusLabel.Margin = new Thickness(0, 8, 0, 0);

        var stack = new StackPanel
        {
            Orientation = Orientation.Vertical,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(24)
        };
        stack.Children.Add(_cover);
        stack.Children.Add(_titleLabel);
        stack.Children.Add(_subtitleLabel);
        stack.Children.Add(_waveform);
        stack.Children.Add(progressRow);
        stack.Children.Add(controlsRow);
        stack.Children.Add(volRow);
        stack.Children.Add(_statusLabel);

        Children.Add(stack);
    }

    private static Button MakeTransportCircle(UIElement content, double diameter, Brush bg, string tip, Action onClick)
    {
        var border = new Border
        {
            Width = diameter,
            Height = diameter,
            CornerRadius = new CornerRadius(diameter * 0.5),
            Background = bg,
            Child = content
        };
        return LumenUiFactory.CreateBorderlessButton(border, tip, onClick);
    }

    public override void Load(LumenPreviewItem item, LumenPreviewContext ctx)
    {
        Teardown();
        base.Load(item, ctx);
        var gen = NextGeneration();

        _cover.SeedIndex = item.SeedIndex;
        _cover.BadgeText = $"LUMEN / {(item.SeedIndex % 99) + 1:D2}";
        _titleLabel.Text = Path.GetFileNameWithoutExtension(item.Title);
        _subtitleLabel.Text = $"{item.Subtitle} · {item.SizeLabel}";
        _statusLabel.Text = string.Empty;
        _nowLabel.Text = "0:00";
        _durationLabel.Text = "0:00";
        _durationSeconds = 0;
        _updatingSlider = true;
        _seekSlider.Value = 0;
        _updatingSlider = false;
        _waveform.Progress = 0;

        if (!string.IsNullOrEmpty(item.LocalPath) && File.Exists(item.LocalPath))
        {
            OpenMediaFile(item.LocalPath, item.CacheKey, ctx.Cache, gen);
            return;
        }
        if (item.ClipboardItem is { } clip)
        {
            _statusLabel.Text = "正在缓冲音频…";
            _ = LoadRemoteAudioAsync(clip.Id, item.FileIndex ?? 0, item.Title, item.CacheKey, ctx, gen);
        }
        else
        {
            _statusLabel.Text = "音频文件不可用";
        }
    }

    private async Task LoadRemoteAudioAsync(string clipId, int fileIndex, string title, string cacheKey, LumenPreviewContext ctx, int gen)
    {
        try
        {
            var localPath = await ctx.Store.Api.DownloadFileToTempCacheAsync(clipId, fileIndex, title).ConfigureAwait(false);
            LumenWpfHost.RunOnUi(() =>
            {
                if (!IsCurrentGeneration(gen)) return;
                _statusLabel.Text = string.Empty;
                OpenMediaFile(localPath, cacheKey, ctx.Cache, gen);
            });
        }
        catch (Exception ex)
        {
            LumenWpfHost.RunOnUi(() =>
            {
                if (!IsCurrentGeneration(gen)) return;
                _statusLabel.Text = $"音频加载失败：{ex.Message}";
            });
        }
    }

    private void OpenMediaFile(string localPath, string cacheKey, LumenPreviewCache cache, int gen)
    {
        DecodeWaveformAsync(localPath, cacheKey, cache, gen);

        var player = new MediaPlayer { Volume = _volumeSlider.Value };
        player.MediaOpened += (_, _) =>
        {
            if (!IsCurrentGeneration(gen)) return;
            if (player.NaturalDuration.HasTimeSpan)
            {
                _durationSeconds = player.NaturalDuration.TimeSpan.TotalSeconds;
                _durationLabel.Text = LumenFormatters.MediaDuration(_durationSeconds);
            }
        };
        player.MediaEnded += (_, _) =>
        {
            if (!IsCurrentGeneration(gen)) return;
            if (_repeatEnabled)
            {
                player.Position = TimeSpan.Zero;
                player.Play();
            }
            else
            {
                SetPlayingUi(false);
                CurrentContext?.OnStepQueue(1, true);
            }
        };
        player.MediaFailed += (_, e) =>
        {
            if (!IsCurrentGeneration(gen)) return;
            _statusLabel.Text = $"解码失败：{e.ErrorException?.Message ?? "格式不支持"}";
            SetPlayingUi(false);
        };
        player.Open(new Uri(localPath, UriKind.Absolute));
        _player = player;

        _progressTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(80) };
        _progressTimer.Tick += (_, _) =>
        {
            if (_player is null) return;
            if (_durationSeconds <= 0 && _player.NaturalDuration.HasTimeSpan)
            {
                _durationSeconds = _player.NaturalDuration.TimeSpan.TotalSeconds;
                _durationLabel.Text = LumenFormatters.MediaDuration(_durationSeconds);
            }
            var cur = _player.Position.TotalSeconds;
            _nowLabel.Text = LumenFormatters.MediaDuration(cur);
            if (_durationSeconds > 0)
            {
                var frac = Math.Clamp(cur / _durationSeconds, 0.0, 1.0);
                _updatingSlider = true;
                _seekSlider.Value = frac * 1000.0;
                _updatingSlider = false;
                _waveform.Progress = frac;
            }
        };
        _progressTimer.Start();
    }

    private void DecodeWaveformAsync(string filePath, string cacheKey, LumenPreviewCache cache, int gen)
    {
        if (cache.GetWaveform(cacheKey) is { } cached)
        {
            _waveform.Peaks = cached;
            return;
        }
        _ = Task.Run(() =>
        {
            try
            {
                using var reader = new AudioFileReader(filePath);
                var totalBytes = reader.Length;
                if (totalBytes <= 0) return;
                const int barCount = 66;
                var blockAlign = Math.Max(1, reader.WaveFormat.BlockAlign);
                var peaks = new double[barCount];
                var sampleBuf = new float[2048];
                for (var i = 0; i < barCount; i++)
                {
                    var rawPos = (long)((double)i * totalBytes / barCount);
                    var aligned = (rawPos / blockAlign) * blockAlign;
                    if (aligned >= totalBytes) aligned = Math.Max(0, totalBytes - blockAlign);
                    reader.Position = aligned;
                    var read = reader.Read(sampleBuf, 0, sampleBuf.Length);
                    if (read <= 0)
                    {
                        peaks[i] = 0.15;
                        continue;
                    }
                    double sumSq = 0;
                    var step = Math.Max(1, read / 128);
                    var samples = 0;
                    for (var s = 0; s < read; s += step)
                    {
                        var v = sampleBuf[s];
                        sumSq += v * v;
                        samples++;
                    }
                    peaks[i] = Math.Sqrt(sumSq / Math.Max(1, samples));
                }
                var peakMax = Math.Max(0.001, peaks.Max());
                for (var i = 0; i < barCount; i++)
                {
                    peaks[i] = Math.Pow(peaks[i] / peakMax, 0.72);
                }
                LumenWpfHost.RunOnUi(() =>
                {
                    if (!IsCurrentGeneration(gen)) return;
                    cache.StoreWaveform(peaks, cacheKey);
                    _waveform.Peaks = peaks;
                });
            }
            catch
            {
                // Keep deterministic fallback waveform bars if codec is unavailable.
            }
        });
    }

    private void SetPlayingUi(bool playing)
    {
        _isPlaying = playing;
        _playGlyph.Text = playing ? "\uE769" : "\uE768";
        var target = playing ? 1.035 : 1.0;
        if (LumenMotion.IsEnabled)
        {
            var anim = new DoubleAnimation(target, TimeSpan.FromMilliseconds(320))
            {
                EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
            };
            _coverScale.BeginAnimation(ScaleTransform.ScaleXProperty, anim, HandoffBehavior.SnapshotAndReplace);
            _coverScale.BeginAnimation(ScaleTransform.ScaleYProperty, anim, HandoffBehavior.SnapshotAndReplace);
        }
        else
        {
            _coverScale.BeginAnimation(ScaleTransform.ScaleXProperty, null);
            _coverScale.BeginAnimation(ScaleTransform.ScaleYProperty, null);
            _coverScale.ScaleX = target;
            _coverScale.ScaleY = target;
        }
    }

    private void SeekToFraction(double fraction)
    {
        if (_player is null || _durationSeconds <= 0) return;
        var clamped = Math.Clamp(fraction, 0.0, 1.0);
        _player.Position = TimeSpan.FromSeconds(_durationSeconds * clamped);
        _waveform.Progress = clamped;
        _updatingSlider = true;
        _seekSlider.Value = clamped * 1000.0;
        _updatingSlider = false;
    }

    public override bool TogglePlayPause()
    {
        if (_player is null) return false;
        if (_isPlaying)
        {
            _player.Pause();
            SetPlayingUi(false);
        }
        else
        {
            if (_durationSeconds > 0 && _player.Position.TotalSeconds >= _durationSeconds - 0.1)
            {
                _player.Position = TimeSpan.Zero;
            }
            _player.Play();
            SetPlayingUi(true);
        }
        return true;
    }

    public override void Teardown()
    {
        base.Teardown();
        if (_progressTimer is not null)
        {
            _progressTimer.Stop();
            _progressTimer = null;
        }
        if (_player is not null)
        {
            try
            {
                _player.Stop();
                _player.Close();
            }
            catch { }
            _player = null;
        }
        _isPlaying = false;
    }
}

// ============================================================================
// 3. Native WPF MediaElement Video Renderer (Priority 94)
// ============================================================================

public sealed class LumenVideoRenderer : IPreviewRenderer
{
    public string RendererId => "native.wpf.video";
    public int Priority => 94;
    public bool CanRender(LumenPreviewItem item) => item.Kind.Tag == LumenPreviewKindTag.Video;
    public IPreviewRendererView CreateView(LumenPreviewItem item, LumenPreviewContext ctx) => new LumenVideoRendererView(ctx.Palette);
}

public sealed class LumenVideoRendererView : LumenPreviewRendererViewBase
{
    private readonly LumenPalette _palette;
    private readonly TextBlock _infoLabel;
    private readonly MediaElement _mediaElement;
    private readonly TextBlock _playGlyph;
    private readonly TextBlock _timeLabel;
    private readonly Slider _seekSlider = new() { Minimum = 0, Maximum = 1000, VerticalAlignment = VerticalAlignment.Center };
    private readonly Slider _volumeSlider = new() { Minimum = 0, Maximum = 1, Value = 0.8, Width = 86, VerticalAlignment = VerticalAlignment.Center };
    private DispatcherTimer? _timer;
    private double _durationSeconds;
    private bool _isPlaying;
    private bool _updatingSlider;

    public LumenVideoRendererView(LumenPalette palette)
    {
        _palette = palette;
        Background = palette.WindowBackground;

        RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        var toolbar = LumenRendererChrome.CreateToolbar(palette, false, out var bar);
        _infoLabel = LumenRendererChrome.CreateStatusText("视频预览", palette);
        DockPanel.SetDock(_infoLabel, Dock.Left);
        bar.Children.Add(_infoLabel);

        var badge = LumenRendererChrome.CreateStatusText("WPF MediaElement 原生控件", palette);
        DockPanel.SetDock(badge, Dock.Right);
        bar.Children.Add(badge);

        SetRow(toolbar, 0);
        Children.Add(toolbar);

        _mediaElement = new MediaElement
        {
            LoadedBehavior = MediaState.Manual,
            UnloadedBehavior = MediaState.Manual,
            Stretch = Stretch.Uniform,
            ScrubbingEnabled = true,
            Volume = _volumeSlider.Value
        };
        _mediaElement.MouseLeftButtonUp += (_, _) => _ = TogglePlayPause();
        _mediaElement.MediaOpened += (_, _) =>
        {
            if (_mediaElement.NaturalDuration.HasTimeSpan)
            {
                _durationSeconds = _mediaElement.NaturalDuration.TimeSpan.TotalSeconds;
            }
            var parts = new List<string> { "视频预览" };
            if (_mediaElement.NaturalVideoWidth > 0 && _mediaElement.NaturalVideoHeight > 0)
            {
                parts.Add($"{_mediaElement.NaturalVideoWidth} × {_mediaElement.NaturalVideoHeight}");
            }
            if (_durationSeconds > 0)
            {
                parts.Add(LumenFormatters.MediaDuration(_durationSeconds));
            }
            _infoLabel.Text = string.Join(" · ", parts);
            UpdateTimeLabel();
        };
        _mediaElement.MediaEnded += (_, _) =>
        {
            _isPlaying = false;
            _playGlyph.Text = "\uE768";
        };
        _mediaElement.MediaFailed += (_, e) =>
        {
            _infoLabel.Text = $"视频解码失败：{e.ErrorException?.Message ?? "格式不支持"}";
            _isPlaying = false;
            _playGlyph.Text = "\uE768";
        };

        var stage = new Border
        {
            Background = LumenPalette.Brush(LumenPalette.Rgb(0.067, 0.094, 0.153)),
            Padding = new Thickness(14),
            Child = _mediaElement
        };
        SetRow(stage, 1);
        Children.Add(stage);

        _playGlyph = LumenUiFactory.CreateGlyph("\uE768", 14, palette.Ink);
        var playBtn = LumenUiFactory.CreateBorderlessButton(
            new Border
            {
                Width = 30,
                Height = 28,
                CornerRadius = new CornerRadius(7),
                Background = palette.SurfaceElevated,
                BorderBrush = palette.Border,
                BorderThickness = new Thickness(1),
                Child = _playGlyph
            },
            "播放 / 暂停 (Space)",
            () => _ = TogglePlayPause());

        _timeLabel = new TextBlock
        {
            Text = "0:00 / 0:00",
            FontFamily = LumenFonts.Mono,
            FontSize = 11,
            Foreground = palette.Muted,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(10, 0, 10, 0)
        };

        _seekSlider.ValueChanged += (_, _) =>
        {
            if (_updatingSlider || _durationSeconds <= 0) return;
            var target = TimeSpan.FromSeconds(_durationSeconds * (_seekSlider.Value / 1000.0));
            _mediaElement.Position = target;
            UpdateTimeLabel();
        };
        _volumeSlider.ValueChanged += (_, _) => _mediaElement.Volume = _volumeSlider.Value;

        var transport = new Grid { Margin = new Thickness(14, 0, 14, 0) };
        transport.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        transport.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        transport.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        transport.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        transport.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        SetColumn(playBtn, 0);
        SetColumn(_timeLabel, 1);
        SetColumn(_seekSlider, 2);
        var volIcon = LumenUiFactory.CreateGlyph("\uE767", 13, palette.Muted);
        volIcon.Margin = new Thickness(10, 0, 6, 0);
        SetColumn(volIcon, 3);
        SetColumn(_volumeSlider, 4);

        transport.Children.Add(playBtn);
        transport.Children.Add(_timeLabel);
        transport.Children.Add(_seekSlider);
        transport.Children.Add(volIcon);
        transport.Children.Add(_volumeSlider);

        var transportBar = new Border
        {
            Height = 42,
            Background = palette.Surface,
            BorderBrush = palette.Border,
            BorderThickness = new Thickness(0, 1, 0, 0),
            Child = transport
        };
        SetRow(transportBar, 2);
        Children.Add(transportBar);
    }

    public override void Load(LumenPreviewItem item, LumenPreviewContext ctx)
    {
        Teardown();
        base.Load(item, ctx);
        var gen = NextGeneration();
        _durationSeconds = 0;
        _infoLabel.Text = $"视频预览 · {item.SizeLabel}";

        if (!string.IsNullOrEmpty(item.LocalPath) && File.Exists(item.LocalPath))
        {
            OpenVideo(item.LocalPath);
            return;
        }
        if (item.ClipboardItem is { } clip)
        {
            _infoLabel.Text = "正在缓冲视频…";
            _ = LoadRemoteVideoAsync(clip.Id, item.FileIndex ?? 0, item.Title, ctx, gen);
        }
        else
        {
            _infoLabel.Text = "视频文件不可用";
        }
    }

    private async Task LoadRemoteVideoAsync(string clipId, int fileIndex, string title, LumenPreviewContext ctx, int gen)
    {
        try
        {
            var localPath = await ctx.Store.Api.DownloadFileToTempCacheAsync(clipId, fileIndex, title).ConfigureAwait(false);
            LumenWpfHost.RunOnUi(() =>
            {
                if (!IsCurrentGeneration(gen)) return;
                OpenVideo(localPath);
            });
        }
        catch (Exception ex)
        {
            LumenWpfHost.RunOnUi(() =>
            {
                if (!IsCurrentGeneration(gen)) return;
                _infoLabel.Text = $"视频加载失败：{ex.Message}";
            });
        }
    }

    private void OpenVideo(string localPath)
    {
        _mediaElement.Source = new Uri(localPath, UriKind.Absolute);
        _mediaElement.Play();
        _mediaElement.Pause();
        _isPlaying = false;
        _playGlyph.Text = "\uE768";

        _timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(100) };
        _timer.Tick += (_, _) =>
        {
            if (_durationSeconds <= 0 && _mediaElement.NaturalDuration.HasTimeSpan)
            {
                _durationSeconds = _mediaElement.NaturalDuration.TimeSpan.TotalSeconds;
            }
            UpdateTimeLabel();
            if (_durationSeconds > 0)
            {
                var frac = Math.Clamp(_mediaElement.Position.TotalSeconds / _durationSeconds, 0.0, 1.0);
                _updatingSlider = true;
                _seekSlider.Value = frac * 1000.0;
                _updatingSlider = false;
            }
        };
        _timer.Start();
    }

    private void UpdateTimeLabel()
    {
        var cur = LumenFormatters.MediaDuration(_mediaElement.Position.TotalSeconds);
        var tot = LumenFormatters.MediaDuration(_durationSeconds);
        _timeLabel.Text = $"{cur} / {tot}";
    }

    public override bool TogglePlayPause()
    {
        if (_mediaElement.Source is null) return false;
        if (_isPlaying)
        {
            _mediaElement.Pause();
            _isPlaying = false;
            _playGlyph.Text = "\uE768";
        }
        else
        {
            if (_durationSeconds > 0 && _mediaElement.Position.TotalSeconds >= _durationSeconds - 0.1)
            {
                _mediaElement.Position = TimeSpan.Zero;
            }
            _mediaElement.Play();
            _isPlaying = true;
            _playGlyph.Text = "\uE769";
        }
        return true;
    }

    public override void Teardown()
    {
        base.Teardown();
        if (_timer is not null)
        {
            _timer.Stop();
            _timer = null;
        }
        try
        {
            _mediaElement.Stop();
            _mediaElement.Close();
            _mediaElement.Source = null;
        }
        catch { }
        _isPlaying = false;
    }
}

// ============================================================================
// 4. Server-Backed Structured Office Renderer (DOCX/XLSX/PPTX) (Priority 90)
// ============================================================================

public sealed class LumenOfficeRenderer : IPreviewRenderer
{
    public string RendererId => "server.office.structured";
    public int Priority => 90;
    public bool CanRender(LumenPreviewItem item) => item.Kind.Tag == LumenPreviewKindTag.Office;
    public IPreviewRendererView CreateView(LumenPreviewItem item, LumenPreviewContext ctx) => new LumenOfficeRendererView(ctx.Palette);
}

public sealed class LumenSheetRowView
{
    public int RowNumber { get; }
    public string[] Cells { get; }

    public LumenSheetRowView(int rowNumber, string[] cells)
    {
        RowNumber = rowNumber;
        Cells = cells;
    }
}

public sealed class LumenOfficeRendererView : LumenPreviewRendererViewBase
{
    private readonly LumenPalette _palette;
    private readonly TextBlock _infoLabel;
    private readonly TextBlock _zoomLabel;
    private readonly Grid _bodyHost = new();
    private double _zoomPercent = 100.0;

    // DOCX
    private FlowDocumentScrollViewer? _docViewer;
    private Border? _docPaper;

    // XLSX
    private LumenWorkbookPreview? _workbook;
    private TextBlock? _cellRefLabel;
    private TextBox? _formulaBox;

    // PPTX
    private LumenPresentationPreview? _presentation;
    private int _activeSlideIndex;
    private TextBlock? _slideTitle;
    private FlowDocumentScrollViewer? _slideBody;
    private TextBlock? _slideCounter;

    public LumenOfficeRendererView(LumenPalette palette)
    {
        _palette = palette;
        Background = palette.WindowBackground;

        RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        var toolbar = LumenRendererChrome.CreateToolbar(palette, false, out var bar);
        _infoLabel = LumenRendererChrome.CreateStatusText("Office 文档预览", palette);
        _zoomLabel = LumenRendererChrome.CreateStatusText("100%", palette);
        _zoomLabel.Margin = new Thickness(6, 0, 6, 0);

        DockPanel.SetDock(_infoLabel, Dock.Left);
        bar.Children.Add(_infoLabel);

        var right = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        right.Children.Add(LumenUiFactory.CreatePillButton("−", palette, ZoomOut));
        right.Children.Add(_zoomLabel);
        right.Children.Add(LumenUiFactory.CreatePillButton("+", palette, ZoomIn));
        var extBtn = LumenUiFactory.CreatePillButton("外部打开", palette, OpenExternal);
        extBtn.Margin = new Thickness(8, 0, 0, 0);
        right.Children.Add(extBtn);
        DockPanel.SetDock(right, Dock.Right);
        bar.Children.Add(right);

        SetRow(toolbar, 0);
        Children.Add(toolbar);

        SetRow(_bodyHost, 1);
        Children.Add(_bodyHost);
    }

    public override void Load(LumenPreviewItem item, LumenPreviewContext ctx)
    {
        base.Load(item, ctx);
        var gen = NextGeneration();
        _zoomPercent = 100.0;
        _zoomLabel.Text = "100%";
        ShowStatus("正在从本机服务解析结构化预览…");

        if (ctx.Cache.GetServerPreview(item.CacheKey) is { } cached)
        {
            RenderServerPreview(cached);
            return;
        }
        _ = LoadOfficeAsync(item, ctx, gen);
    }

    private async Task LoadOfficeAsync(LumenPreviewItem item, LumenPreviewContext ctx, int gen)
    {
        try
        {
            LumenServerPreview? preview = null;
            if (item.ClipboardItem is { } clip)
            {
                preview = await ctx.Store.Api.FetchFilePreviewAsync(clip.Id, item.FileIndex).ConfigureAwait(false);
            }
            else if (!string.IsNullOrEmpty(item.LocalPath) && File.Exists(item.LocalPath))
            {
                preview = await Task.Run(() => LocalOoxmlPreviewParser.TryParse(item.LocalPath)).ConfigureAwait(false);
            }

            LumenWpfHost.RunOnUi(() =>
            {
                if (!IsCurrentGeneration(gen)) return;
                if (preview is null)
                {
                    ShowStatus("本地 Office 文件暂无法提取结构化预览，可使用右上角“外部打开”。");
                    return;
                }
                ctx.Cache.StoreServerPreview(preview, item.CacheKey);
                RenderServerPreview(preview);
            });
        }
        catch (Exception ex)
        {
            LumenWpfHost.RunOnUi(() =>
            {
                if (!IsCurrentGeneration(gen)) return;
                ShowStatus($"结构化预览不可用：{ex.Message}");
            });
        }
    }

    private void ClearBody()
    {
        _bodyHost.Children.Clear();
        _docViewer = null;
        _docPaper = null;
        _workbook = null;
        _cellRefLabel = null;
        _formulaBox = null;
        _presentation = null;
        _slideTitle = null;
        _slideBody = null;
        _slideCounter = null;
    }

    private void ShowStatus(string message)
    {
        ClearBody();
        _bodyHost.Children.Add(new TextBlock
        {
            Text = message,
            FontFamily = LumenFonts.Ui,
            FontSize = 13,
            Foreground = _palette.Muted,
            TextWrapping = TextWrapping.Wrap,
            TextAlignment = TextAlignment.Center,
            MaxWidth = 520,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center
        });
    }

    private void RenderServerPreview(LumenServerPreview preview)
    {
        ClearBody();
        if (preview.Office is { } office)
        {
            if (office.Document is { Blocks.Count: > 0 } doc)
            {
                _infoLabel.Text = $"Word · 结构化内容预览 ({doc.Blocks.Count} 段落)";
                RenderDocx(doc);
                return;
            }
            if (office.Workbook is { Sheets.Count: > 0 } wb)
            {
                _infoLabel.Text = $"Excel · {wb.Sheets.Count} 个工作表";
                RenderWorkbook(wb);
                return;
            }
            if (office.Presentation is { Slides.Count: > 0 } pres)
            {
                _infoLabel.Text = $"PowerPoint · {pres.Slides.Count} 页幻灯片";
                RenderPresentation(pres);
                return;
            }
        }
        if (!string.IsNullOrWhiteSpace(preview.Text))
        {
            _infoLabel.Text = "文档文本预览";
            RenderPlainText(preview.Text);
        }
        else
        {
            ShowStatus("此文档暂无可提取的结构化预览，可使用右上角“外部打开”。");
        }
    }

    private void RenderDocx(LumenDocumentPreview docPreview)
    {
        var ink = LumenPalette.Brush(LumenPalette.Rgb(0.15, 0.21, 0.30));
        var subInk = LumenPalette.Brush(LumenPalette.Rgb(0.35, 0.42, 0.52));

        var flowDoc = new FlowDocument
        {
            FontFamily = LumenFonts.Ui,
            FontSize = 13.5,
            Foreground = ink,
            Background = Brushes.White,
            PagePadding = new Thickness(38, 34, 38, 34)
        };

        foreach (var block in docPreview.Blocks)
        {
            switch (block.Kind)
            {
                case "h1":
                    flowDoc.Blocks.Add(new Paragraph(new Run(block.Text ?? string.Empty))
                    {
                        FontSize = 22,
                        FontWeight = FontWeights.Bold,
                        Foreground = ink,
                        Margin = new Thickness(0, 8, 0, 10)
                    });
                    break;
                case "h2":
                    flowDoc.Blocks.Add(new Paragraph(new Run(block.Text ?? string.Empty))
                    {
                        FontSize = 16.5,
                        FontWeight = FontWeights.SemiBold,
                        Foreground = ink,
                        Margin = new Thickness(0, 8, 0, 6)
                    });
                    break;
                case "quote":
                    // Uniform 1px border + soft rounded fill (zero left accent bar).
                    var quoteBox = new Border
                    {
                        Background = LumenPalette.Brush(LumenPalette.Rgb(0.933, 0.953, 1.0)),
                        BorderBrush = LumenPalette.Brush(LumenPalette.Rgb(0.78, 0.84, 0.96)),
                        BorderThickness = new Thickness(1),
                        CornerRadius = new CornerRadius(8),
                        Padding = new Thickness(14, 10, 14, 10),
                        Child = new TextBlock
                        {
                            Text = block.Text ?? string.Empty,
                            FontFamily = LumenFonts.Ui,
                            FontSize = 13.5,
                            FontStyle = FontStyles.Italic,
                            Foreground = subInk,
                            TextWrapping = TextWrapping.Wrap
                        }
                    };
                    flowDoc.Blocks.Add(new BlockUIContainer(quoteBox) { Margin = new Thickness(0, 6, 0, 10) });
                    break;
                case "table":
                    if (block.Rows is { Count: > 0 })
                    {
                        flowDoc.Blocks.Add(BuildFlowTable(block.Rows));
                    }
                    break;
                default:
                    flowDoc.Blocks.Add(new Paragraph(new Run(block.Text ?? string.Empty))
                    {
                        FontSize = 13.5,
                        LineHeight = 22,
                        Margin = new Thickness(0, 0, 0, 10)
                    });
                    break;
            }
        }

        var viewer = new FlowDocumentScrollViewer
        {
            Document = flowDoc,
            IsToolBarVisible = false,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            Background = Brushes.Transparent
        };
        _docViewer = viewer;

        var paper = new Border
        {
            Width = 640,
            Background = Brushes.White,
            CornerRadius = new CornerRadius(8),
            BorderBrush = LumenPalette.Brush(LumenPalette.Rgb(0.85, 0.88, 0.93)),
            BorderThickness = new Thickness(1),
            Margin = new Thickness(24, 20, 24, 24),
            Child = viewer
        };
        _docPaper = paper;
        _bodyHost.Children.Add(paper);
    }

    private static Table BuildFlowTable(List<List<string>> rows)
    {
        var table = new Table
        {
            CellSpacing = 0,
            BorderBrush = LumenPalette.Brush(LumenPalette.Rgb(0.86, 0.89, 0.93)),
            BorderThickness = new Thickness(1),
            Margin = new Thickness(0, 6, 0, 12)
        };
        var colCount = Math.Max(1, rows.Max(r => r.Count));
        for (var c = 0; c < colCount; c++)
        {
            table.Columns.Add(new TableColumn());
        }
        var group = new TableRowGroup();
        var cellBorder = LumenPalette.Brush(LumenPalette.Rgb(0.88, 0.90, 0.94));
        var headerBg = LumenPalette.Brush(LumenPalette.Rgb(0.933, 0.949, 0.976));
        var cellInk = LumenPalette.Brush(LumenPalette.Rgb(0.16, 0.22, 0.31));

        for (var rIdx = 0; rIdx < Math.Min(rows.Count, 40); rIdx++)
        {
            var srcRow = rows[rIdx];
            var tr = new TableRow { Background = rIdx == 0 ? headerBg : Brushes.White };
            for (var cIdx = 0; cIdx < colCount; cIdx++)
            {
                var txt = cIdx < srcRow.Count ? srcRow[cIdx] : string.Empty;
                var cell = new TableCell(new Paragraph(new Run(txt))
                {
                    Margin = new Thickness(0),
                    FontSize = 12,
                    FontWeight = rIdx == 0 ? FontWeights.SemiBold : FontWeights.Normal,
                    Foreground = cellInk
                })
                {
                    BorderBrush = cellBorder,
                    BorderThickness = new Thickness(0.5),
                    Padding = new Thickness(8, 6, 8, 6)
                };
                tr.Cells.Add(cell);
            }
            group.Rows.Add(tr);
        }
        table.RowGroups.Add(group);
        return table;
    }

    private void RenderWorkbook(LumenWorkbookPreview wb)
    {
        _workbook = wb;

        var layout = new Grid();
        layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        layout.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        // Formula bar
        var refLabel = new TextBlock
        {
            Text = "A1",
            FontFamily = LumenFonts.Mono,
            FontSize = 11.5,
            FontWeight = FontWeights.SemiBold,
            Foreground = LumenPalette.Brush(LumenPalette.Rgb(0.15, 0.24, 0.26)),
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center
        };
        _cellRefLabel = refLabel;
        var refPill = new Border
        {
            Width = 54,
            Height = 24,
            Background = Brushes.White,
            BorderBrush = LumenPalette.Brush(LumenPalette.Rgb(0.83, 0.87, 0.85)),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(4),
            Child = refLabel
        };
        var fxLabel = new TextBlock
        {
            Text = "ƒx",
            FontFamily = LumenFonts.Ui,
            FontSize = 12,
            FontWeight = FontWeights.SemiBold,
            Foreground = LumenPalette.Brush(LumenPalette.Rgb(0.33, 0.44, 0.39)),
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(10, 0, 8, 0)
        };
        var formulaBox = new TextBox
        {
            IsReadOnly = true,
            FontFamily = LumenFonts.Mono,
            FontSize = 12,
            Foreground = LumenPalette.Brush(LumenPalette.Rgb(0.15, 0.23, 0.26)),
            Background = Brushes.White,
            BorderBrush = LumenPalette.Brush(LumenPalette.Rgb(0.83, 0.87, 0.85)),
            BorderThickness = new Thickness(1),
            Padding = new Thickness(6, 3, 6, 3),
            VerticalContentAlignment = VerticalAlignment.Center
        };
        _formulaBox = formulaBox;

        var fGrid = new Grid { Margin = new Thickness(10, 6, 10, 6) };
        fGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        fGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        fGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        SetColumn(refPill, 0);
        SetColumn(fxLabel, 1);
        SetColumn(formulaBox, 2);
        fGrid.Children.Add(refPill);
        fGrid.Children.Add(fxLabel);
        fGrid.Children.Add(formulaBox);

        var formulaBar = new Border
        {
            Background = LumenPalette.Brush(LumenPalette.Rgb(0.945, 0.961, 0.953)),
            BorderBrush = LumenPalette.Brush(LumenPalette.Rgb(0.84, 0.88, 0.86)),
            BorderThickness = new Thickness(0, 0, 0, 1),
            Child = fGrid
        };
        SetRow(formulaBar, 0);
        layout.Children.Add(formulaBar);

        // Native WPF TabControl with one DataGrid per worksheet
        var tabControl = new TabControl
        {
            TabStripPlacement = Dock.Bottom,
            Background = Brushes.White,
            BorderThickness = new Thickness(0)
        };

        for (var sIdx = 0; sIdx < wb.Sheets.Count; sIdx++)
        {
            var sheet = wb.Sheets[sIdx];
            var sheetIndex = sIdx;
            var grid = BuildSheetDataGrid(sheet, sheetIndex);
            var tabItem = new TabItem
            {
                Header = sheet.Name,
                Content = grid,
                FontFamily = LumenFonts.Ui,
                FontSize = 12
            };
            tabControl.Items.Add(tabItem);
        }

        tabControl.SelectionChanged += (_, _) =>
        {
            var idx = tabControl.SelectedIndex;
            if (idx >= 0 && idx < wb.Sheets.Count)
            {
                UpdateFormulaBar(idx, 0, 0);
            }
        };

        SetRow(tabControl, 1);
        layout.Children.Add(tabControl);
        _bodyHost.Children.Add(layout);

        if (wb.Sheets.Count > 0)
        {
            tabControl.SelectedIndex = 0;
            UpdateFormulaBar(0, 0, 0);
        }
    }

    private DataGrid BuildSheetDataGrid(LumenSheetPreview sheet, int sheetIndex)
    {
        var colCount = Math.Max(6, sheet.Rows.Count > 0 ? sheet.Rows.Max(r => r.Count) : 6);
        var rowCount = Math.Max(16, sheet.Rows.Count);
        var rowViews = new List<LumenSheetRowView>(rowCount);
        for (var r = 0; r < rowCount; r++)
        {
            var cells = new string[colCount];
            if (r < sheet.Rows.Count)
            {
                var src = sheet.Rows[r];
                for (var c = 0; c < Math.Min(colCount, src.Count); c++)
                {
                    cells[c] = src[c] ?? string.Empty;
                }
            }
            for (var c = 0; c < colCount; c++)
            {
                cells[c] ??= string.Empty;
            }
            rowViews.Add(new LumenSheetRowView(r + 1, cells));
        }

        var grid = new DataGrid
        {
            AutoGenerateColumns = false,
            IsReadOnly = true,
            CanUserAddRows = false,
            CanUserDeleteRows = false,
            CanUserReorderColumns = false,
            CanUserSortColumns = false,
            SelectionUnit = DataGridSelectionUnit.Cell,
            SelectionMode = DataGridSelectionMode.Single,
            HeadersVisibility = DataGridHeadersVisibility.Column,
            GridLinesVisibility = DataGridGridLinesVisibility.All,
            HorizontalGridLinesBrush = LumenPalette.Brush(LumenPalette.Rgb(0.89, 0.92, 0.90)),
            VerticalGridLinesBrush = LumenPalette.Brush(LumenPalette.Rgb(0.89, 0.92, 0.90)),
            Background = Brushes.White,
            RowBackground = Brushes.White,
            AlternatingRowBackground = LumenPalette.Brush(LumenPalette.Rgb(0.984, 0.992, 0.988)),
            Foreground = LumenPalette.Brush(LumenPalette.Rgb(0.15, 0.23, 0.26)),
            FontFamily = LumenFonts.Ui,
            FontSize = 12,
            RowHeight = 27,
            BorderThickness = new Thickness(0),
            ItemsSource = rowViews
        };

        var rowNumStyle = new Style(typeof(TextBlock));
        rowNumStyle.Setters.Add(new Setter(TextBlock.TextAlignmentProperty, TextAlignment.Center));
        rowNumStyle.Setters.Add(new Setter(TextBlock.ForegroundProperty, LumenPalette.Brush(LumenPalette.Rgb(0.45, 0.52, 0.48))));
        rowNumStyle.Setters.Add(new Setter(TextBlock.FontFamilyProperty, LumenFonts.Mono));
        rowNumStyle.Setters.Add(new Setter(TextBlock.VerticalAlignmentProperty, VerticalAlignment.Center));

        grid.Columns.Add(new DataGridTextColumn
        {
            Header = "#",
            Width = new DataGridLength(44),
            Binding = new Binding(nameof(LumenSheetRowView.RowNumber)),
            ElementStyle = rowNumStyle
        });

        var cellStyle = new Style(typeof(TextBlock));
        cellStyle.Setters.Add(new Setter(TextBlock.VerticalAlignmentProperty, VerticalAlignment.Center));
        cellStyle.Setters.Add(new Setter(TextBlock.PaddingProperty, new Thickness(6, 0, 6, 0)));
        cellStyle.Setters.Add(new Setter(TextBlock.TextTrimmingProperty, TextTrimming.CharacterEllipsis));

        for (var c = 0; c < colCount; c++)
        {
            grid.Columns.Add(new DataGridTextColumn
            {
                Header = ColumnLetter(c),
                MinWidth = 86,
                Width = new DataGridLength(116),
                Binding = new Binding($"{nameof(LumenSheetRowView.Cells)}[{c}]"),
                ElementStyle = cellStyle
            });
        }

        grid.CurrentCellChanged += (_, _) =>
        {
            if (grid.CurrentCell.Item is LumenSheetRowView rowView && grid.CurrentCell.Column is not null)
            {
                var colIdx = grid.CurrentCell.Column.DisplayIndex - 1;
                if (colIdx >= 0)
                {
                    UpdateFormulaBar(sheetIndex, rowView.RowNumber - 1, colIdx);
                }
            }
        };

        return grid;
    }

    private void UpdateFormulaBar(int sheetIndex, int row, int col)
    {
        if (_workbook is null || sheetIndex < 0 || sheetIndex >= _workbook.Sheets.Count) return;
        var sheet = _workbook.Sheets[sheetIndex];
        var cellRef = $"{ColumnLetter(col)}{row + 1}";
        if (_cellRefLabel is not null) _cellRefLabel.Text = cellRef;
        if (_formulaBox is null) return;
        if (sheet.Formulas is not null && sheet.Formulas.TryGetValue(cellRef, out var formula) && !string.IsNullOrEmpty(formula))
        {
            _formulaBox.Text = formula;
        }
        else if (row >= 0 && row < sheet.Rows.Count && col >= 0 && col < sheet.Rows[row].Count)
        {
            _formulaBox.Text = sheet.Rows[row][col];
        }
        else
        {
            _formulaBox.Text = string.Empty;
        }
    }

    private static string ColumnLetter(int index)
    {
        var n = index + 1;
        var sb = new StringBuilder();
        while (n > 0)
        {
            var rem = (n - 1) % 26;
            sb.Insert(0, (char)('A' + rem));
            n = (n - 1) / 26;
        }
        return sb.ToString();
    }

    private void RenderPresentation(LumenPresentationPreview pres)
    {
        _presentation = pres;
        _activeSlideIndex = 0;

        var title = new TextBlock
        {
            FontFamily = LumenFonts.Ui,
            FontSize = 24,
            FontWeight = FontWeights.Bold,
            Foreground = LumenPalette.Brush(LumenPalette.Rgb(0.14, 0.20, 0.30)),
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(36, 32, 36, 16)
        };
        _slideTitle = title;

        var bodyViewer = new FlowDocumentScrollViewer
        {
            IsToolBarVisible = false,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            Background = Brushes.Transparent,
            Margin = new Thickness(32, 0, 32, 24)
        };
        _slideBody = bodyViewer;

        var slideGrid = new Grid();
        slideGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        slideGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        SetRow(title, 0);
        SetRow(bodyViewer, 1);
        slideGrid.Children.Add(title);
        slideGrid.Children.Add(bodyViewer);

        var card = new Border
        {
            Width = 660,
            Height = 400,
            Background = Brushes.White,
            CornerRadius = new CornerRadius(12),
            BorderBrush = _palette.Border,
            BorderThickness = new Thickness(1),
            Child = slideGrid
        };

        _slideCounter = LumenRendererChrome.CreateStatusText($"第 1 / {pres.Slides.Count} 页", _palette);
        _slideCounter.Margin = new Thickness(10, 0, 10, 0);

        var navRow = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Center,
            Margin = new Thickness(0, 16, 0, 0)
        };
        navRow.Children.Add(LumenUiFactory.CreatePillButton("‹ 上一页", _palette, () => _ = StepPage(-1)));
        navRow.Children.Add(_slideCounter);
        navRow.Children.Add(LumenUiFactory.CreatePillButton("下一页 ›", _palette, () => _ = StepPage(1)));

        var outer = new StackPanel
        {
            Orientation = Orientation.Vertical,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(24)
        };
        outer.Children.Add(card);
        outer.Children.Add(navRow);

        _bodyHost.Children.Add(outer);
        UpdateActiveSlide();
    }

    private void UpdateActiveSlide()
    {
        if (_presentation is null || _presentation.Slides.Count == 0) return;
        _activeSlideIndex = Math.Clamp(_activeSlideIndex, 0, _presentation.Slides.Count - 1);
        var slide = _presentation.Slides[_activeSlideIndex];
        if (_slideTitle is not null)
        {
            _slideTitle.Text = string.IsNullOrWhiteSpace(slide.Title) ? $"第 {slide.Number} 页" : slide.Title;
        }
        if (_slideBody is not null)
        {
            var doc = new FlowDocument
            {
                FontFamily = LumenFonts.Ui,
                FontSize = 15,
                Foreground = LumenPalette.Brush(LumenPalette.Rgb(0.25, 0.32, 0.42)),
                PagePadding = new Thickness(4)
            };
            foreach (var line in slide.Lines)
            {
                doc.Blocks.Add(new Paragraph(new Run("• " + line)) { Margin = new Thickness(0, 0, 0, 10), LineHeight = 24 });
            }
            _slideBody.Document = doc;
        }
        if (_slideCounter is not null)
        {
            _slideCounter.Text = $"第 {_activeSlideIndex + 1} / {_presentation.Slides.Count} 页";
        }
    }

    private void RenderPlainText(string text)
    {
        var doc = new FlowDocument(new Paragraph(new Run(text)) { LineHeight = 22 })
        {
            FontFamily = LumenFonts.Ui,
            FontSize = 13.5,
            Foreground = _palette.Ink,
            PagePadding = new Thickness(28, 24, 28, 24)
        };
        _bodyHost.Children.Add(new FlowDocumentScrollViewer
        {
            Document = doc,
            IsToolBarVisible = false,
            Background = Brushes.Transparent,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto
        });
    }

    private void OpenExternal()
    {
        if (!string.IsNullOrEmpty(CurrentItem?.LocalPath) && File.Exists(CurrentItem.LocalPath))
        {
            try
            {
                Process.Start(new ProcessStartInfo(CurrentItem.LocalPath) { UseShellExecute = true });
            }
            catch { }
        }
    }

    public override bool StepPage(int delta)
    {
        if (_presentation is null || _presentation.Slides.Count == 0) return false;
        var next = _activeSlideIndex + delta;
        if (next < 0 || next >= _presentation.Slides.Count) return false;
        _activeSlideIndex = next;
        UpdateActiveSlide();
        return true;
    }

    public override void ZoomIn()
    {
        _zoomPercent = Math.Min(180, _zoomPercent + 20);
        ApplyDocZoom();
    }

    public override void ZoomOut()
    {
        _zoomPercent = Math.Max(60, _zoomPercent - 20);
        ApplyDocZoom();
    }

    public override void ResetZoom()
    {
        _zoomPercent = 100;
        ApplyDocZoom();
    }

    private void ApplyDocZoom()
    {
        _zoomLabel.Text = $"{(int)_zoomPercent}%";
        if (_docViewer is not null) _docViewer.Zoom = _zoomPercent;
        if (_docPaper is not null) _docPaper.Width = 640 * (_zoomPercent / 100.0);
    }
}

/// <summary>
/// Bounded local OOXML extractor used only when previewing drag-and-drop local Office files
/// without a server clipboard item ID (mirrors Go clipboardpreview/preview.go schema).
/// </summary>
internal static class LocalOoxmlPreviewParser
{
    private static readonly Regex CellRefRegex = new(@"^([A-Z]+)(\d+)$", RegexOptions.Compiled);
    private static readonly Regex SlideNumRegex = new(@"slide(\d+)\.xml$", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    public static LumenServerPreview? TryParse(string filePath)
    {
        try
        {
            var info = new FileInfo(filePath);
            if (!info.Exists || info.Length <= 0 || info.Length > 16 * 1024 * 1024) return null;
            var ext = info.Extension.ToLowerInvariant();
            using var zip = ZipFile.OpenRead(filePath);
            return ext switch
            {
                ".docx" => ParseDocx(zip, info),
                ".xlsx" => ParseXlsx(zip, info),
                ".pptx" => ParsePptx(zip, info),
                _ => null
            };
        }
        catch
        {
            return null;
        }
    }

    private static XDocument? ReadXml(ZipArchive zip, string entryPath)
    {
        var entry = zip.GetEntry(entryPath);
        if (entry is null || entry.Length > 4 * 1024 * 1024) return null;
        using var stream = entry.Open();
        return XDocument.Load(stream);
    }

    private static LumenServerPreview? ParseDocx(ZipArchive zip, FileInfo info)
    {
        var doc = ReadXml(zip, "word/document.xml");
        var body = doc?.Descendants().FirstOrDefault(e => e.Name.LocalName == "body");
        if (body is null) return null;

        var blocks = new List<LumenOfficeBlock>();
        string? title = null;
        foreach (var elem in body.Elements())
        {
            if (blocks.Count >= 400) break;
            if (elem.Name.LocalName == "p")
            {
                var styleVal = elem.Descendants().FirstOrDefault(e => e.Name.LocalName == "pStyle")
                    ?.Attributes().FirstOrDefault(a => a.Name.LocalName == "val")?.Value?.ToLowerInvariant() ?? string.Empty;
                var kind = "p";
                if (styleVal.Contains("heading1") || styleVal.Contains("title")) kind = "h1";
                else if (styleVal.Contains("heading") || styleVal.Contains("subtitle")) kind = "h2";
                else if (styleVal.Contains("quote")) kind = "quote";

                var text = string.Concat(elem.Descendants().Where(e => e.Name.LocalName == "t").Select(e => e.Value)).Trim();
                if (!string.IsNullOrEmpty(text))
                {
                    if (title is null && kind == "h1") title = text;
                    blocks.Add(new LumenOfficeBlock { Kind = kind, Text = text });
                }
            }
            else if (elem.Name.LocalName == "tbl")
            {
                var rows = new List<List<string>>();
                foreach (var tr in elem.Elements().Where(e => e.Name.LocalName == "tr").Take(60))
                {
                    var row = new List<string>();
                    foreach (var tc in tr.Elements().Where(e => e.Name.LocalName == "tc").Take(20))
                    {
                        var cellText = string.Join("\n", tc.Elements().Where(e => e.Name.LocalName == "p")
                            .Select(p => string.Concat(p.Descendants().Where(d => d.Name.LocalName == "t").Select(d => d.Value)).Trim())
                            .Where(s => s.Length > 0));
                        row.Add(cellText);
                    }
                    if (row.Count > 0) rows.Add(row);
                }
                if (rows.Count > 0) blocks.Add(new LumenOfficeBlock { Kind = "table", Rows = rows });
            }
        }
        if (blocks.Count == 0) return null;
        return new LumenServerPreview
        {
            Kind = "text",
            FileName = info.Name,
            FileSize = info.Length,
            Office = new LumenOfficePreview
            {
                Format = "docx",
                Document = new LumenDocumentPreview { Title = title, Blocks = blocks }
            }
        };
    }

    private static LumenServerPreview? ParseXlsx(ZipArchive zip, FileInfo info)
    {
        var shared = new List<string>();
        var sst = ReadXml(zip, "xl/sharedStrings.xml");
        if (sst is not null)
        {
            foreach (var si in sst.Descendants().Where(e => e.Name.LocalName == "si"))
            {
                shared.Add(string.Concat(si.Descendants().Where(e => e.Name.LocalName == "t").Select(e => e.Value)));
            }
        }

        var rels = new Dictionary<string, string>(StringComparer.Ordinal);
        var relsDoc = ReadXml(zip, "xl/_rels/workbook.xml.rels");
        if (relsDoc is not null)
        {
            foreach (var rel in relsDoc.Descendants().Where(e => e.Name.LocalName == "Relationship"))
            {
                var id = rel.Attribute("Id")?.Value ?? string.Empty;
                var target = rel.Attribute("Target")?.Value ?? string.Empty;
                if (!string.IsNullOrEmpty(id) && !string.IsNullOrEmpty(target)) rels[id] = target;
            }
        }

        var wbDoc = ReadXml(zip, "xl/workbook.xml");
        if (wbDoc is null) return null;

        var sheets = new List<LumenSheetPreview>();
        foreach (var sh in wbDoc.Descendants().Where(e => e.Name.LocalName == "sheet").Take(12))
        {
            var name = sh.Attribute("name")?.Value ?? $"Sheet{sheets.Count + 1}";
            var relId = sh.Attributes().FirstOrDefault(a => a.Name.LocalName == "id")?.Value ?? string.Empty;
            if (!rels.TryGetValue(relId, out var target)) continue;
            var entryName = target.TrimStart('/');
            if (!entryName.StartsWith("xl/", StringComparison.OrdinalIgnoreCase)) entryName = "xl/" + entryName;
            var sheetXml = ReadXml(zip, entryName);
            if (sheetXml is null) continue;

            var gridMap = new Dictionary<int, Dictionary<int, string>>();
            var formulas = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            int maxRow = -1, maxCol = -1;
            var count = 0;

            foreach (var c in sheetXml.Descendants().Where(e => e.Name.LocalName == "c"))
            {
                if (++count > 10000) break;
                var cellRef = c.Attribute("r")?.Value ?? string.Empty;
                var m = CellRefRegex.Match(cellRef.ToUpperInvariant());
                if (!m.Success) continue;
                var col = 0;
                foreach (var ch in m.Groups[1].Value) col = col * 26 + (ch - 'A') + 1;
                if (!int.TryParse(m.Groups[2].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var rowNum)) continue;
                var rIdx = rowNum - 1;
                var cIdx = col - 1;
                if (rIdx < 0 || cIdx < 0 || rIdx >= 250 || cIdx >= 40) continue;

                var type = c.Attribute("t")?.Value ?? string.Empty;
                var val = c.Elements().FirstOrDefault(e => e.Name.LocalName == "v")?.Value ?? string.Empty;
                if (type == "s" && int.TryParse(val, out var sIdx) && sIdx >= 0 && sIdx < shared.Count)
                {
                    val = shared[sIdx];
                }
                else if (type == "inlineStr")
                {
                    val = string.Concat(c.Descendants().Where(e => e.Name.LocalName == "t").Select(e => e.Value));
                }
                else if (type == "b")
                {
                    val = val == "1" ? "TRUE" : "FALSE";
                }
                var f = c.Elements().FirstOrDefault(e => e.Name.LocalName == "f")?.Value?.Trim();
                if (!string.IsNullOrEmpty(f)) formulas[cellRef] = "=" + f;

                if (!gridMap.TryGetValue(rIdx, out var rowDict))
                {
                    rowDict = new Dictionary<int, string>();
                    gridMap[rIdx] = rowDict;
                }
                rowDict[cIdx] = val;
                if (rIdx > maxRow) maxRow = rIdx;
                if (cIdx > maxCol) maxCol = cIdx;
            }

            var rows = new List<List<string>>();
            for (var r = 0; r <= maxRow; r++)
            {
                var line = new List<string>(maxCol + 1);
                gridMap.TryGetValue(r, out var rowDict);
                for (var c = 0; c <= maxCol; c++)
                {
                    line.Add(rowDict is not null && rowDict.TryGetValue(c, out var v) ? v : string.Empty);
                }
                rows.Add(line);
            }
            sheets.Add(new LumenSheetPreview { Name = name, Rows = rows, Formulas = formulas.Count > 0 ? formulas : null });
        }

        if (sheets.Count == 0) return null;
        return new LumenServerPreview
        {
            Kind = "text",
            FileName = info.Name,
            FileSize = info.Length,
            Office = new LumenOfficePreview
            {
                Format = "xlsx",
                Workbook = new LumenWorkbookPreview { Sheets = sheets }
            }
        };
    }

    private static LumenServerPreview? ParsePptx(ZipArchive zip, FileInfo info)
    {
        var slideEntries = zip.Entries
            .Where(e => e.FullName.StartsWith("ppt/slides/slide", StringComparison.OrdinalIgnoreCase)
                     && e.FullName.EndsWith(".xml", StringComparison.OrdinalIgnoreCase))
            .Select(e =>
            {
                var m = SlideNumRegex.Match(e.FullName);
                var num = m.Success && int.TryParse(m.Groups[1].Value, out var n) ? n : 9999;
                return (Entry: e, Num: num);
            })
            .OrderBy(x => x.Num)
            .Take(30)
            .ToList();

        var slides = new List<LumenSlidePreview>();
        foreach (var (entry, _) in slideEntries)
        {
            var xml = ReadXml(zip, entry.FullName);
            if (xml is null) continue;
            var lines = xml.Descendants()
                .Where(e => e.Name.LocalName == "p")
                .Select(p => string.Concat(p.Descendants().Where(t => t.Name.LocalName == "t").Select(t => t.Value)).Trim())
                .Where(s => s.Length > 0)
                .ToList();
            if (lines.Count == 0) continue;
            slides.Add(new LumenSlidePreview
            {
                Number = slides.Count + 1,
                Title = lines[0],
                Lines = lines.Skip(1).ToList()
            });
        }
        if (slides.Count == 0) return null;
        return new LumenServerPreview
        {
            Kind = "text",
            FileName = info.Name,
            FileSize = info.Length,
            Office = new LumenOfficePreview
            {
                Format = "pptx",
                Presentation = new LumenPresentationPreview { Slides = slides }
            }
        };
    }
}

// ============================================================================
// 5. Native WPF Image Renderer with Zoom & Pan (Priority 88)
// ============================================================================

public sealed class LumenImageRenderer : IPreviewRenderer
{
    public string RendererId => "native.wpf.image";
    public int Priority => 88;
    public bool CanRender(LumenPreviewItem item) => item.Kind.Tag == LumenPreviewKindTag.Image;
    public IPreviewRendererView CreateView(LumenPreviewItem item, LumenPreviewContext ctx) => new LumenImageRendererView(ctx.Palette);
}

public sealed class LumenImageRendererView : LumenPreviewRendererViewBase
{
    private readonly LumenPalette _palette;
    private readonly TextBlock _infoLabel;
    private readonly TextBlock _zoomLabel;
    private readonly ScrollViewer _scrollView = new();
    private readonly Image _image = new() { Stretch = Stretch.Uniform };
    private readonly ScaleTransform _scaleTransform = new(1, 1);
    private double _zoomFactor = 1.0;
    private bool _fitMode = true;
    private bool _panning;
    private Point _panStart;
    private double _panStartH;
    private double _panStartV;

    public LumenImageRendererView(LumenPalette palette)
    {
        _palette = palette;
        Background = palette.WindowBackground;

        RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        var toolbar = LumenRendererChrome.CreateToolbar(palette, false, out var bar);
        _infoLabel = LumenRendererChrome.CreateStatusText("图片预览", palette);
        _zoomLabel = LumenRendererChrome.CreateStatusText("适配", palette);
        _zoomLabel.Margin = new Thickness(6, 0, 6, 0);

        DockPanel.SetDock(_infoLabel, Dock.Left);
        bar.Children.Add(_infoLabel);

        var controls = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        controls.Children.Add(LumenUiFactory.CreatePillButton("−", palette, ZoomOut));
        controls.Children.Add(_zoomLabel);
        controls.Children.Add(LumenUiFactory.CreatePillButton("+", palette, ZoomIn));
        var fitBtn = LumenUiFactory.CreatePillButton("适配", palette, ResetZoom);
        fitBtn.Margin = new Thickness(6, 0, 0, 0);
        controls.Children.Add(fitBtn);
        DockPanel.SetDock(controls, Dock.Right);
        bar.Children.Add(controls);

        SetRow(toolbar, 0);
        Children.Add(toolbar);

        var frame = new Border
        {
            CornerRadius = new CornerRadius(10),
            ClipToBounds = true,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(24),
            LayoutTransform = _scaleTransform,
            Child = _image
        };

        _scrollView.Content = frame;
        _scrollView.HorizontalScrollBarVisibility = ScrollBarVisibility.Auto;
        _scrollView.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        _scrollView.Background = Brushes.Transparent;
        _scrollView.SizeChanged += (_, _) => { if (_fitMode) ApplySizing(); };
        _scrollView.PreviewMouseWheel += (_, e) =>
        {
            if ((Keyboard.Modifiers & ModifierKeys.Control) != 0)
            {
                e.Handled = true;
                if (e.Delta > 0) ZoomIn(); else ZoomOut();
            }
        };
        _scrollView.PreviewMouseLeftButtonDown += (_, e) =>
        {
            if (!_fitMode && _zoomFactor > 1.01)
            {
                _panning = true;
                _panStart = e.GetPosition(_scrollView);
                _panStartH = _scrollView.HorizontalOffset;
                _panStartV = _scrollView.VerticalOffset;
                _scrollView.Cursor = Cursors.ScrollAll;
                _scrollView.CaptureMouse();
            }
        };
        _scrollView.PreviewMouseMove += (_, e) =>
        {
            if (!_panning) return;
            var cur = e.GetPosition(_scrollView);
            _scrollView.ScrollToHorizontalOffset(_panStartH - (cur.X - _panStart.X));
            _scrollView.ScrollToVerticalOffset(_panStartV - (cur.Y - _panStart.Y));
        };
        _scrollView.PreviewMouseLeftButtonUp += (_, _) =>
        {
            if (_panning)
            {
                _panning = false;
                _scrollView.Cursor = Cursors.Arrow;
                _scrollView.ReleaseMouseCapture();
            }
        };

        SetRow(_scrollView, 1);
        Children.Add(_scrollView);
    }

    public override void Load(LumenPreviewItem item, LumenPreviewContext ctx)
    {
        base.Load(item, ctx);
        var gen = NextGeneration();
        _zoomFactor = 1.0;
        _fitMode = true;
        _scaleTransform.ScaleX = 1.0;
        _scaleTransform.ScaleY = 1.0;
        _zoomLabel.Text = "适配";

        if (ctx.Cache.GetImage(item.CacheKey) is { } cached)
        {
            PresentImage(cached, item);
            return;
        }
        if (item.ClipboardItem?.DecodeThumbnailImage() is { } thumb)
        {
            PresentImage(thumb, item);
        }
        _ = LoadFullImageAsync(item, ctx, gen);
    }

    private async Task LoadFullImageAsync(LumenPreviewItem item, LumenPreviewContext ctx, int gen)
    {
        try
        {
            BitmapImage? bmp = null;
            if (!string.IsNullOrEmpty(item.LocalPath) && File.Exists(item.LocalPath))
            {
                bmp = await Task.Run(() => LumenFormatters.DecodeBitmapImageFromFile(item.LocalPath)).ConfigureAwait(false);
            }
            else if (item.ClipboardItem is { } clip)
            {
                var (data, _) = clip.Kind == "file"
                    ? await ctx.Store.Api.FetchItemFileDataAsync(clip.Id, item.FileIndex ?? 0).ConfigureAwait(false)
                    : await ctx.Store.Api.FetchItemContentAsync(clip.Id).ConfigureAwait(false);
                bmp = await Task.Run(() => LumenFormatters.DecodeBitmapImage(data)).ConfigureAwait(false);
            }

            if (bmp is not null)
            {
                LumenWpfHost.RunOnUi(() =>
                {
                    if (!IsCurrentGeneration(gen)) return;
                    ctx.Cache.StoreImage(bmp, item.CacheKey);
                    PresentImage(bmp, item);
                });
            }
        }
        catch (Exception ex)
        {
            LumenWpfHost.RunOnUi(() =>
            {
                if (!IsCurrentGeneration(gen)) return;
                _infoLabel.Text = $"图片加载失败：{ex.Message}";
            });
        }
    }

    private void PresentImage(BitmapSource bmp, LumenPreviewItem item)
    {
        _image.Source = bmp;
        _infoLabel.Text = $"图片 · {bmp.PixelWidth} × {bmp.PixelHeight} · {item.SizeLabel}";
        ApplySizing();
    }

    private void ApplySizing()
    {
        if (_image.Source is not BitmapSource bmp) return;
        var vw = Math.Max(200, _scrollView.ViewportWidth - 52);
        var vh = Math.Max(180, _scrollView.ViewportHeight - 52);
        var fitScale = Math.Min(1.0, Math.Min(vw / Math.Max(1, bmp.PixelWidth), vh / Math.Max(1, bmp.PixelHeight)));
        _image.Width = Math.Max(48, bmp.PixelWidth * fitScale);
        _image.Height = Math.Max(48, bmp.PixelHeight * fitScale);
    }

    public override void ZoomIn()
    {
        _fitMode = false;
        _zoomFactor = Math.Min(4.0, _zoomFactor + 0.25);
        _scaleTransform.ScaleX = _zoomFactor;
        _scaleTransform.ScaleY = _zoomFactor;
        _zoomLabel.Text = $"{(int)Math.Round(_zoomFactor * 100)}%";
    }

    public override void ZoomOut()
    {
        _fitMode = false;
        _zoomFactor = Math.Max(0.25, _zoomFactor - 0.25);
        _scaleTransform.ScaleX = _zoomFactor;
        _scaleTransform.ScaleY = _zoomFactor;
        _zoomLabel.Text = $"{(int)Math.Round(_zoomFactor * 100)}%";
    }

    public override void ResetZoom()
    {
        _fitMode = true;
        _zoomFactor = 1.0;
        _scaleTransform.ScaleX = 1.0;
        _scaleTransform.ScaleY = 1.0;
        _zoomLabel.Text = "适配";
        ApplySizing();
    }
}

// ============================================================================
// 6. Native Color Swatch Renderer (Priority 86)
// ============================================================================

public sealed class LumenColorRenderer : IPreviewRenderer
{
    public string RendererId => "native.wpf.color";
    public int Priority => 86;
    public bool CanRender(LumenPreviewItem item) => item.Kind.Tag == LumenPreviewKindTag.Color;
    public IPreviewRendererView CreateView(LumenPreviewItem item, LumenPreviewContext ctx) => new LumenColorRendererView(ctx.Palette);
}

public sealed class LumenColorRendererView : LumenPreviewRendererViewBase
{
    private readonly LumenPalette _palette;
    private readonly Border _swatch;
    private readonly TextBox _hexBox;
    private readonly TextBox _rgbBox;
    private readonly TextBox _hsbBox;

    public LumenColorRendererView(LumenPalette palette)
    {
        _palette = palette;
        Background = palette.WindowBackground;

        _swatch = new Border
        {
            Width = 360,
            Height = 210,
            CornerRadius = new CornerRadius(18),
            BorderBrush = LumenPalette.Brush(LumenPalette.WithAlpha(Colors.White, 0.28)),
            BorderThickness = new Thickness(1)
        };

        _hexBox = MakeReadOnlyMonoBox(28, FontWeights.Bold, palette.Ink);
        _hexBox.Margin = new Thickness(0, 18, 0, 6);
        _rgbBox = MakeReadOnlyMonoBox(13, FontWeights.Normal, palette.Muted);
        _rgbBox.Margin = new Thickness(0, 2, 0, 2);
        _hsbBox = MakeReadOnlyMonoBox(13, FontWeights.Normal, palette.Muted);
        _hsbBox.Margin = new Thickness(0, 2, 0, 14);

        var copyBtn = LumenUiFactory.CreatePillButton("复制色值", palette, CopyPrimaryContent);

        var stack = new StackPanel
        {
            Orientation = Orientation.Vertical,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center
        };
        stack.Children.Add(_swatch);
        stack.Children.Add(_hexBox);
        stack.Children.Add(_rgbBox);
        stack.Children.Add(_hsbBox);
        stack.Children.Add(copyBtn);

        Children.Add(stack);
    }

    private static TextBox MakeReadOnlyMonoBox(double size, FontWeight weight, Brush fg) => new()
    {
        IsReadOnly = true,
        BorderThickness = new Thickness(0),
        Background = Brushes.Transparent,
        FontFamily = LumenFonts.Mono,
        FontSize = size,
        FontWeight = weight,
        Foreground = fg,
        HorizontalAlignment = HorizontalAlignment.Center,
        TextAlignment = TextAlignment.Center
    };

    public override void Load(LumenPreviewItem item, LumenPreviewContext ctx)
    {
        base.Load(item, ctx);
        var raw = (item.InlineText ?? item.Title).Trim();
        var color = LumenClassifier.TryParseHexColor(raw, out var parsed) ? parsed : _palette.AccentColor;
        _swatch.Background = LumenPalette.Brush(color);
        _hexBox.Text = raw.ToUpperInvariant();
        _rgbBox.Text = $"RGB({color.R}, {color.G}, {color.B})";
        var (h, s, b) = LumenClassifier.RgbToHsb(color);
        _hsbBox.Text = string.Format(CultureInfo.InvariantCulture, "HSB({0:F0}°, {1:F0}%, {2:F0}%)", h, s, b);
    }
}

// ============================================================================
// 7. Native Syntax-Highlighted Code Renderer (Priority 84)
// ============================================================================

public sealed class LumenCodeRenderer : IPreviewRenderer
{
    public string RendererId => "native.wpf.code";
    public int Priority => 84;
    public bool CanRender(LumenPreviewItem item) => item.Kind.Tag == LumenPreviewKindTag.Code;
    public IPreviewRendererView CreateView(LumenPreviewItem item, LumenPreviewContext ctx) => new LumenCodeRendererView(ctx.Palette);
}

public sealed class LumenCodeRendererView : LumenPreviewRendererViewBase
{
    private readonly LumenPalette _palette;
    private readonly TextBlock _infoLabel;
    private readonly FlowDocumentScrollViewer _viewer;
    private string _codeContent = string.Empty;
    private string _language = "js";
    private double _fontSize = 13.0;

    public LumenCodeRendererView(LumenPalette palette)
    {
        _palette = palette;
        Background = palette.CodeBackground;

        RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        var toolbar = LumenRendererChrome.CreateToolbar(palette, darkOverride: true, out var bar);
        _infoLabel = LumenRendererChrome.CreateStatusText("代码预览", palette, darkOverride: true);
        DockPanel.SetDock(_infoLabel, Dock.Left);
        bar.Children.Add(_infoLabel);

        var right = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        var smaller = LumenUiFactory.CreatePillButton("A−", palette, ZoomOut, darkSurface: true);
        var larger = LumenUiFactory.CreatePillButton("A+", palette, ZoomIn, darkSurface: true);
        larger.Margin = new Thickness(6, 0, 6, 0);
        var copyBtn = LumenUiFactory.CreatePillButton("复制代码", palette, CopyPrimaryContent, darkSurface: true);
        right.Children.Add(smaller);
        right.Children.Add(larger);
        right.Children.Add(copyBtn);
        DockPanel.SetDock(right, Dock.Right);
        bar.Children.Add(right);

        SetRow(toolbar, 0);
        Children.Add(toolbar);

        _viewer = new FlowDocumentScrollViewer
        {
            IsToolBarVisible = false,
            Background = palette.CodeBackground,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto
        };
        SetRow(_viewer, 1);
        Children.Add(_viewer);
    }

    public override void Load(LumenPreviewItem item, LumenPreviewContext ctx)
    {
        base.Load(item, ctx);
        var gen = NextGeneration();
        _language = string.IsNullOrEmpty(item.Kind.Subtype) ? "js" : item.Kind.Subtype;

        if (ctx.Cache.GetText(item.CacheKey) is { } cached)
        {
            ApplyCode(cached);
            return;
        }
        if (!string.IsNullOrEmpty(item.InlineText))
        {
            ApplyCode(item.InlineText);
        }
        _ = LoadFullCodeAsync(item, ctx, gen);
    }

    private async Task LoadFullCodeAsync(LumenPreviewItem item, LumenPreviewContext ctx, int gen)
    {
        try
        {
            string? text = null;
            if (!string.IsNullOrEmpty(item.LocalPath) && File.Exists(item.LocalPath))
            {
                text = await Task.Run(() => ReadBoundedUtf8(item.LocalPath, 128_000)).ConfigureAwait(false);
            }
            else if (item.ClipboardItem is { } clip)
            {
                if (clip.Kind == "file")
                {
                    var (data, _) = await ctx.Store.Api.FetchItemFileDataAsync(clip.Id, item.FileIndex ?? 0).ConfigureAwait(false);
                    text = Encoding.UTF8.GetString(data);
                }
                else
                {
                    var detailed = await ctx.Store.HydrateItemDetailAsync(clip.Id).ConfigureAwait(false);
                    text = detailed?.EffectiveText;
                }
            }
            if (text is not null)
            {
                LumenWpfHost.RunOnUi(() =>
                {
                    if (!IsCurrentGeneration(gen)) return;
                    ctx.Cache.StoreText(text, item.CacheKey);
                    ApplyCode(text);
                });
            }
        }
        catch { }
    }

    internal static string ReadBoundedUtf8(string path, int maxBytes)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        var buf = new byte[(int)Math.Min(maxBytes, fs.Length)];
        var read = fs.Read(buf, 0, buf.Length);
        return Encoding.UTF8.GetString(buf, 0, read);
    }

    private void ApplyCode(string source)
    {
        _codeContent = source ?? string.Empty;
        var lineCount = Math.Max(1, _codeContent.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n').Length);
        var langTitle = LumenClassifier.LanguageDisplayName(_language);
        _infoLabel.Text = $"● {langTitle} · {lineCount} 行 · UTF-8";
        _viewer.Document = LumenSyntaxHighlighter.BuildCodeDocument(_codeContent, _language, _fontSize, includeLineNumbers: true, darkCanvas: true);
    }

    public override void ZoomIn()
    {
        _fontSize = Math.Min(22, _fontSize + 1.5);
        ApplyCode(_codeContent);
    }

    public override void ZoomOut()
    {
        _fontSize = Math.Max(9.5, _fontSize - 1.5);
        ApplyCode(_codeContent);
    }

    public override void ResetZoom()
    {
        _fontSize = 13.0;
        ApplyCode(_codeContent);
    }
}

// ============================================================================
// 8. Native Collection Overview Renderer (Priority 82)
// ============================================================================

public sealed class LumenCollectionRenderer : IPreviewRenderer
{
    public string RendererId => "native.wpf.collection";
    public int Priority => 82;
    public bool CanRender(LumenPreviewItem item) => item.Kind.Tag == LumenPreviewKindTag.Collection;
    public IPreviewRendererView CreateView(LumenPreviewItem item, LumenPreviewContext ctx) => new LumenCollectionRendererView(ctx.Palette);
}

public sealed class LumenCollectionRendererView : LumenPreviewRendererViewBase
{
    private readonly LumenPalette _palette;
    private readonly StackPanel _stack = new() { Orientation = Orientation.Vertical, Margin = new Thickness(28, 24, 28, 24) };

    public LumenCollectionRendererView(LumenPalette palette)
    {
        _palette = palette;
        Background = palette.WindowBackground;
        Children.Add(new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Content = _stack
        });
    }

    public override void Load(LumenPreviewItem item, LumenPreviewContext ctx)
    {
        base.Load(item, ctx);
        _stack.Children.Clear();
        _stack.Children.Add(new TextBlock
        {
            Text = $"文件集合 · {item.CollectionChildren.Count} 项",
            FontFamily = LumenFonts.Ui,
            FontSize = 18,
            FontWeight = FontWeights.SemiBold,
            Foreground = _palette.Ink,
            Margin = new Thickness(0, 0, 0, 14)
        });

        for (var i = 0; i < item.CollectionChildren.Count; i++)
        {
            var idx = i;
            var child = item.CollectionChildren[i];
            var iconEl = CreateFileIconElement(child.LocalPath, _palette);

            var rowGrid = new Grid();
            rowGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            rowGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            rowGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            SetColumn(iconEl, 0);
            var name = new TextBlock
            {
                Text = child.Title,
                FontFamily = LumenFonts.Ui,
                FontSize = 13,
                FontWeight = FontWeights.Medium,
                Foreground = _palette.Ink,
                VerticalAlignment = VerticalAlignment.Center,
                TextTrimming = TextTrimming.CharacterEllipsis,
                Margin = new Thickness(12, 0, 12, 0)
            };
            SetColumn(name, 1);
            var meta = new TextBlock
            {
                Text = $"{child.Kind.DisplayLabel} · {child.SizeLabel}",
                FontFamily = LumenFonts.Ui,
                FontSize = 11,
                Foreground = _palette.Muted,
                VerticalAlignment = VerticalAlignment.Center
            };
            SetColumn(meta, 2);

            rowGrid.Children.Add(iconEl);
            rowGrid.Children.Add(name);
            rowGrid.Children.Add(meta);

            var rowBorder = new Border
            {
                Height = 48,
                CornerRadius = new CornerRadius(10),
                Background = _palette.Surface,
                BorderBrush = _palette.Border,
                BorderThickness = new Thickness(1),
                Padding = new Thickness(12, 0, 14, 0),
                Margin = new Thickness(0, 0, 0, 8),
                Child = rowGrid
            };
            var btn = LumenUiFactory.CreateBorderlessButton(rowBorder, null, () => CurrentContext?.OnSelectQueueIndex(idx));
            btn.MouseEnter += (_, _) => rowBorder.BorderBrush = _palette.AccentBorder;
            btn.MouseLeave += (_, _) => rowBorder.BorderBrush = _palette.Border;
            _stack.Children.Add(btn);
        }
    }

    internal static UIElement CreateFileIconElement(string? path, LumenPalette palette, double size = 28)
    {
        var bmp = LumenWin32.ExtractShellIcon(path);
        if (bmp is not null)
        {
            return new Image
            {
                Source = bmp,
                Width = size,
                Height = size,
                Stretch = Stretch.Uniform,
                VerticalAlignment = VerticalAlignment.Center
            };
        }
        return new Border
        {
            Width = size,
            Height = size,
            CornerRadius = new CornerRadius(6),
            Background = palette.AccentSoft,
            Child = LumenUiFactory.CreateGlyph("\uE8A5", size * 0.55, palette.Accent)
        };
    }
}

// ============================================================================
// 9. Native Text & Link Renderer (Priority 70)
// ============================================================================

public sealed class LumenTextRenderer : IPreviewRenderer
{
    public string RendererId => "native.wpf.text";
    public int Priority => 70;
    public bool CanRender(LumenPreviewItem item) => item.Kind.Tag is LumenPreviewKindTag.Text or LumenPreviewKindTag.Link;
    public IPreviewRendererView CreateView(LumenPreviewItem item, LumenPreviewContext ctx) => new LumenTextRendererView(ctx.Palette);
}

public sealed class LumenTextRendererView : LumenPreviewRendererViewBase
{
    private readonly LumenPalette _palette;
    private readonly TextBlock _infoLabel;
    private readonly Button _openLinkBtn;
    private readonly FlowDocumentScrollViewer _viewer;
    private string _content = string.Empty;
    private string? _activeUrl;
    private double _fontSize = 15.0;

    public LumenTextRendererView(LumenPalette palette)
    {
        _palette = palette;
        Background = palette.WindowBackground;

        RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        var toolbar = LumenRendererChrome.CreateToolbar(palette, false, out var bar);
        _infoLabel = LumenRendererChrome.CreateStatusText("文本预览", palette);
        DockPanel.SetDock(_infoLabel, Dock.Left);
        bar.Children.Add(_infoLabel);

        _openLinkBtn = LumenUiFactory.CreatePillButton("打开链接", palette, OpenUrl);
        _openLinkBtn.Visibility = Visibility.Collapsed;
        _openLinkBtn.Margin = new Thickness(0, 0, 8, 0);

        var right = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        right.Children.Add(_openLinkBtn);
        right.Children.Add(LumenUiFactory.CreatePillButton("复制内容", palette, CopyPrimaryContent));
        DockPanel.SetDock(right, Dock.Right);
        bar.Children.Add(right);

        SetRow(toolbar, 0);
        Children.Add(toolbar);

        _viewer = new FlowDocumentScrollViewer
        {
            IsToolBarVisible = false,
            Background = Brushes.Transparent,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto
        };
        SetRow(_viewer, 1);
        Children.Add(_viewer);
    }

    public override void Load(LumenPreviewItem item, LumenPreviewContext ctx)
    {
        base.Load(item, ctx);
        var gen = NextGeneration();
        _activeUrl = null;
        _openLinkBtn.Visibility = Visibility.Collapsed;

        if (ctx.Cache.GetText(item.CacheKey) is { } cached)
        {
            ApplyText(cached, item.Kind.Tag == LumenPreviewKindTag.Link);
            return;
        }
        if (!string.IsNullOrEmpty(item.InlineText))
        {
            ApplyText(item.InlineText, item.Kind.Tag == LumenPreviewKindTag.Link);
        }
        _ = LoadFullTextAsync(item, ctx, gen);
    }

    private async Task LoadFullTextAsync(LumenPreviewItem item, LumenPreviewContext ctx, int gen)
    {
        try
        {
            string? text = null;
            if (!string.IsNullOrEmpty(item.LocalPath) && File.Exists(item.LocalPath))
            {
                text = await Task.Run(() => LumenCodeRendererView.ReadBoundedUtf8(item.LocalPath, 128_000)).ConfigureAwait(false);
            }
            else if (item.ClipboardItem is { } clip)
            {
                if (clip.Kind == "file")
                {
                    var (data, _) = await ctx.Store.Api.FetchItemFileDataAsync(clip.Id, item.FileIndex ?? 0).ConfigureAwait(false);
                    text = Encoding.UTF8.GetString(data);
                }
                else
                {
                    var detailed = await ctx.Store.HydrateItemDetailAsync(clip.Id).ConfigureAwait(false);
                    text = detailed?.EffectiveText;
                }
            }
            if (text is not null)
            {
                LumenWpfHost.RunOnUi(() =>
                {
                    if (!IsCurrentGeneration(gen)) return;
                    ctx.Cache.StoreText(text, item.CacheKey);
                    ApplyText(text, item.Kind.Tag == LumenPreviewKindTag.Link);
                });
            }
        }
        catch { }
    }

    private void ApplyText(string text, bool isLink)
    {
        _content = text ?? string.Empty;
        var doc = new FlowDocument(new Paragraph(new Run(_content))
        {
            Margin = new Thickness(0),
            LineHeight = _fontSize * 1.58
        })
        {
            FontFamily = LumenFonts.Ui,
            FontSize = _fontSize,
            Foreground = _palette.Ink,
            PagePadding = new Thickness(28, 24, 28, 24)
        };
        _viewer.Document = doc;

        var lines = Math.Max(1, _content.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n').Length);
        var bytes = Encoding.UTF8.GetByteCount(_content);
        _infoLabel.Text = $"{(isLink ? "链接" : "文本")} · {_content.Length} 字 · {lines} 行 · {LumenFormatters.ByteCount(bytes)}";

        var trimmed = _content.Trim();
        if (isLink && Uri.TryCreate(trimmed, UriKind.Absolute, out var uri)
            && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
        {
            _activeUrl = uri.AbsoluteUri;
            _openLinkBtn.Visibility = Visibility.Visible;
        }
    }

    private void OpenUrl()
    {
        if (string.IsNullOrEmpty(_activeUrl)) return;
        try
        {
            Process.Start(new ProcessStartInfo(_activeUrl) { UseShellExecute = true });
        }
        catch { }
    }

    public override void ZoomIn()
    {
        _fontSize = Math.Min(26, _fontSize + 2);
        ApplyText(_content, _activeUrl is not null);
    }

    public override void ZoomOut()
    {
        _fontSize = Math.Max(11, _fontSize - 2);
        ApplyText(_content, _activeUrl is not null);
    }

    public override void ResetZoom()
    {
        _fontSize = 15.0;
        ApplyText(_content, _activeUrl is not null);
    }
}

// ============================================================================
// 10. Native Shell File Fallback Renderer (Priority 0)
// ============================================================================

public sealed class LumenFileFallbackRenderer : IPreviewRenderer
{
    public string RendererId => "native.wpf.file.fallback";
    public int Priority => 0;
    public bool CanRender(LumenPreviewItem item) => true;
    public IPreviewRendererView CreateView(LumenPreviewItem item, LumenPreviewContext ctx) => new LumenFileFallbackRendererView(ctx.Palette);
}

public sealed class LumenFileFallbackRendererView : LumenPreviewRendererViewBase
{
    private readonly LumenPalette _palette;
    private readonly Border _iconHost = new() { Width = 72, Height = 72, HorizontalAlignment = HorizontalAlignment.Center };
    private readonly TextBlock _nameLabel = new();
    private readonly TextBlock _metaLabel = new();

    public LumenFileFallbackRendererView(LumenPalette palette)
    {
        _palette = palette;
        Background = palette.WindowBackground;

        _nameLabel.FontFamily = LumenFonts.Ui;
        _nameLabel.FontSize = 18;
        _nameLabel.FontWeight = FontWeights.SemiBold;
        _nameLabel.Foreground = palette.Ink;
        _nameLabel.TextAlignment = TextAlignment.Center;
        _nameLabel.MaxWidth = 520;
        _nameLabel.TextTrimming = TextTrimming.CharacterEllipsis;
        _nameLabel.Margin = new Thickness(0, 12, 0, 6);

        _metaLabel.FontFamily = LumenFonts.Ui;
        _metaLabel.FontSize = 12.5;
        _metaLabel.Foreground = palette.Muted;
        _metaLabel.TextAlignment = TextAlignment.Center;
        _metaLabel.TextWrapping = TextWrapping.Wrap;
        _metaLabel.MaxWidth = 480;
        _metaLabel.Margin = new Thickness(0, 0, 0, 18);

        var actions = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center };
        var reveal = LumenUiFactory.CreatePillButton("在资源管理器中显示", palette, RevealInExplorer);
        var open = LumenUiFactory.CreatePillButton("默认应用打开", palette, OpenWithDefault);
        open.Margin = new Thickness(10, 0, 10, 0);
        var copy = LumenUiFactory.CreatePillButton("复制引用", palette, CopyPrimaryContent);
        actions.Children.Add(reveal);
        actions.Children.Add(open);
        actions.Children.Add(copy);

        var stack = new StackPanel
        {
            Orientation = Orientation.Vertical,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(24)
        };
        stack.Children.Add(_iconHost);
        stack.Children.Add(_nameLabel);
        stack.Children.Add(_metaLabel);
        stack.Children.Add(actions);

        Children.Add(stack);
    }

    public override void Load(LumenPreviewItem item, LumenPreviewContext ctx)
    {
        base.Load(item, ctx);
        _iconHost.Child = LumenCollectionRendererView.CreateFileIconElement(item.LocalPath, _palette, 64);
        _nameLabel.Text = item.Title;
        _metaLabel.Text = !string.IsNullOrEmpty(item.LocalPath)
            ? $"{item.LocalPath}\n{item.SizeLabel} · 尚无此格式的内置渲染器，可调用系统默认应用打开。"
            : $"{item.SizeLabel} · 尚无此格式的内置渲染器。";
    }

    private void RevealInExplorer()
    {
        if (string.IsNullOrEmpty(CurrentItem?.LocalPath) || !File.Exists(CurrentItem.LocalPath)) return;
        try
        {
            Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{CurrentItem.LocalPath}\"") { UseShellExecute = true });
        }
        catch { }
    }

    private void OpenWithDefault()
    {
        if (string.IsNullOrEmpty(CurrentItem?.LocalPath) || !File.Exists(CurrentItem.LocalPath)) return;
        try
        {
            Process.Start(new ProcessStartInfo(CurrentItem.LocalPath) { UseShellExecute = true });
        }
        catch { }
    }
}
