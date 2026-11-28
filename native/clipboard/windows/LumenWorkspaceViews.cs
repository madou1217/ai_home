using System.IO;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace AihLumenClipboard;

public enum LumenNavKind
{
    All,
    Recent,
    Pinned,
    Category,
    Settings
}

public readonly record struct LumenNavDestination(LumenNavKind Kind, LumenDisplayCategory Category = LumenDisplayCategory.Text)
{
    public static readonly LumenNavDestination All = new(LumenNavKind.All);
    public static readonly LumenNavDestination Recent = new(LumenNavKind.Recent);
    public static readonly LumenNavDestination Pinned = new(LumenNavKind.Pinned);
    public static readonly LumenNavDestination Settings = new(LumenNavKind.Settings);
    public static LumenNavDestination ForCategory(LumenDisplayCategory cat) => new(LumenNavKind.Category, cat);

    public string Title => Kind switch
    {
        LumenNavKind.All => "所有记录",
        LumenNavKind.Recent => "最近记录",
        LumenNavKind.Pinned => "已固定",
        LumenNavKind.Category => Category.GetLabel(),
        LumenNavKind.Settings => "偏好设置",
        _ => "所有记录"
    };
}

// ============================================================================
// Sidebar Control (Zero Left Accent Bar — Uniform 1px Rounded Pills)
// ============================================================================

public sealed class LumenSidebarControl : Border
{
    private sealed class NavRowRef
    {
        public required Border Pill { get; init; }
        public required TextBlock Icon { get; init; }
        public required TextBlock Label { get; init; }
        public TextBlock? Count { get; init; }
    }

    private readonly TextBlock _brandTitle = new();
    private readonly TextBlock _brandSub = new();
    private readonly StackPanel _navStack = new() { Orientation = Orientation.Vertical };
    private readonly Border _bottomDivider = new() { Height = 1, Margin = new Thickness(12, 8, 12, 8) };
    private readonly Ellipse _statusDot = new() { Width = 7, Height = 7, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock _statusTitle = new();
    private readonly TextBlock _statusSub = new();
    private readonly Dictionary<LumenNavDestination, NavRowRef> _rows = new();
    private readonly List<TextBlock> _sectionHeaders = new();

    public event Action<LumenNavDestination>? DestinationSelected;

    public LumenSidebarControl()
    {
        var layout = new Grid();
        layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        layout.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        // Brand header
        var brandRow = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Margin = new Thickness(14, 16, 12, 16),
            VerticalAlignment = VerticalAlignment.Center
        };
        brandRow.Children.Add(new LumenBrandMarkControl(32));
        var brandText = new StackPanel { Orientation = Orientation.Vertical, Margin = new Thickness(10, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
        _brandTitle.Text = "Lumen";
        _brandTitle.FontFamily = LumenFonts.Ui;
        _brandTitle.FontSize = 17;
        _brandTitle.FontWeight = FontWeights.Bold;
        _brandSub.Text = "Clipboard, reimagined.";
        _brandSub.FontFamily = LumenFonts.Ui;
        _brandSub.FontSize = 10;
        brandText.Children.Add(_brandTitle);
        brandText.Children.Add(_brandSub);
        brandRow.Children.Add(brandText);
        Grid.SetRow(brandRow, 0);
        layout.Children.Add(brandRow);

        // Nav scroll
        AddSectionHeader("资料库");
        AddNavRow(LumenNavDestination.All, "\uE8FD", showCount: true);
        AddNavRow(LumenNavDestination.Recent, "\uE823", showCount: false);
        AddNavRow(LumenNavDestination.Pinned, "\uE718", showCount: true);

        _navStack.Children.Add(new Border { Height = 12 });
        AddSectionHeader("智能分类");
        foreach (var cat in LumenDisplayCategoryExtensions.AllCategories)
        {
            AddNavRow(LumenNavDestination.ForCategory(cat), cat.GetGlyph(), showCount: true);
        }

        var scroll = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Padding = new Thickness(8, 0, 8, 4),
            Content = _navStack
        };
        Grid.SetRow(scroll, 1);
        layout.Children.Add(scroll);

        Grid.SetRow(_bottomDivider, 2);
        layout.Children.Add(_bottomDivider);

        var settingsBtn = BuildNavButton(LumenNavDestination.Settings, "\uE713", showCount: false);
        settingsBtn.Margin = new Thickness(8, 0, 8, 8);
        Grid.SetRow(settingsBtn, 3);
        layout.Children.Add(settingsBtn);

        // Bottom live status row
        var statusRow = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Margin = new Thickness(14, 0, 12, 12),
            VerticalAlignment = VerticalAlignment.Center
        };
        statusRow.Children.Add(_statusDot);
        var statusText = new StackPanel { Orientation = Orientation.Vertical, Margin = new Thickness(8, 0, 0, 0) };
        _statusTitle.Text = "本地资料库";
        _statusTitle.FontFamily = LumenFonts.Ui;
        _statusTitle.FontSize = 11;
        _statusTitle.FontWeight = FontWeights.SemiBold;
        _statusSub.Text = "等待连接";
        _statusSub.FontFamily = LumenFonts.Ui;
        _statusSub.FontSize = 10;
        _statusSub.TextTrimming = TextTrimming.CharacterEllipsis;
        statusText.Children.Add(_statusTitle);
        statusText.Children.Add(_statusSub);
        statusRow.Children.Add(statusText);
        Grid.SetRow(statusRow, 4);
        layout.Children.Add(statusRow);

        Child = layout;
    }

    private void AddSectionHeader(string title)
    {
        var tb = new TextBlock
        {
            Text = title,
            FontFamily = LumenFonts.Ui,
            FontSize = 10,
            FontWeight = FontWeights.SemiBold,
            Margin = new Thickness(10, 4, 10, 6)
        };
        _sectionHeaders.Add(tb);
        _navStack.Children.Add(tb);
    }

    private void AddNavRow(LumenNavDestination dest, string glyph, bool showCount)
    {
        var btn = BuildNavButton(dest, glyph, showCount);
        btn.Margin = new Thickness(0, 0, 0, 3);
        _navStack.Children.Add(btn);
    }

    private Button BuildNavButton(LumenNavDestination dest, string glyph, bool showCount)
    {
        var g = new Grid { VerticalAlignment = VerticalAlignment.Center };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(24) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var icon = LumenUiFactory.CreateGlyph(glyph, 14, LumenPalette.Light.Muted);
        Grid.SetColumn(icon, 0);
        var label = new TextBlock
        {
            Text = dest.Title,
            FontFamily = LumenFonts.Ui,
            FontSize = 12.5,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(4, 0, 6, 0),
            TextTrimming = TextTrimming.CharacterEllipsis
        };
        Grid.SetColumn(label, 1);

        TextBlock? countLbl = null;
        if (showCount)
        {
            countLbl = new TextBlock
            {
                Text = "0",
                FontFamily = LumenFonts.Mono,
                FontSize = 10.5,
                VerticalAlignment = VerticalAlignment.Center
            };
            Grid.SetColumn(countLbl, 2);
            g.Children.Add(countLbl);
        }
        g.Children.Add(icon);
        g.Children.Add(label);

        var pill = new Border
        {
            Height = 33,
            CornerRadius = new CornerRadius(8),
            BorderThickness = new Thickness(1),
            BorderBrush = Brushes.Transparent,
            Background = Brushes.Transparent,
            Padding = new Thickness(8, 0, 10, 0),
            Child = g
        };
        _rows[dest] = new NavRowRef { Pill = pill, Icon = icon, Label = label, Count = countLbl };
        return LumenUiFactory.CreateBorderlessButton(pill, null, () => DestinationSelected?.Invoke(dest));
    }

    public void UpdateState(
        LumenNavDestination active,
        IReadOnlyList<LumenClipboardItem> items,
        bool connected,
        LumenClipboardStatus? status,
        LumenPalette palette)
    {
        Background = palette.CreateSidebarBrush();
        _brandTitle.Foreground = palette.Ink;
        _brandSub.Foreground = palette.Muted;
        _bottomDivider.Background = palette.Border;
        _statusTitle.Foreground = palette.Ink;
        _statusSub.Foreground = palette.Muted;
        foreach (var h in _sectionHeaders) h.Foreground = palette.Muted;

        var capturing = status?.Capture.Running == true;
        _statusDot.Fill = connected ? (capturing ? palette.Success : palette.Warning) : palette.Muted;
        _statusTitle.Text = connected ? (capturing ? "本机实时采集" : "本地资料库") : "未连接服务";
        var pinnedCount = items.Count(x => x.Pinned);
        _statusSub.Text = $"{items.Count} 条记录 · {pinnedCount} 固定";

        var counts = new Dictionary<LumenDisplayCategory, int>();
        foreach (var item in items)
        {
            var c = item.DisplayCategory;
            counts[c] = counts.GetValueOrDefault(c) + 1;
        }

        foreach (var (dest, row) in _rows)
        {
            var selected = dest == active;
            row.Pill.Background = selected ? palette.AccentSoft : Brushes.Transparent;
            row.Pill.BorderBrush = selected ? palette.AccentBorder : Brushes.Transparent;
            row.Icon.Foreground = selected ? palette.Accent : palette.Muted;
            row.Label.Foreground = selected ? palette.Accent : palette.Ink;
            row.Label.FontWeight = selected ? FontWeights.SemiBold : FontWeights.Normal;
            if (row.Count is not null)
            {
                row.Count.Foreground = selected ? palette.Accent : palette.Muted;
                row.Count.Text = dest.Kind switch
                {
                    LumenNavKind.All => items.Count.ToString(),
                    LumenNavKind.Pinned => pinnedCount.ToString(),
                    LumenNavKind.Category => counts.GetValueOrDefault(dest.Category).ToString(),
                    _ => string.Empty
                };
            }
        }
    }
}

// ============================================================================
// History List Row & Gallery Card (Zero Left Accent Bar)
// ============================================================================

public static class LumenHistoryItemFactory
{
    public static Border CreateListRow(
        LumenClipboardItem item,
        bool selected,
        LumenPalette palette,
        Action<MouseButtonEventArgs> onClick,
        Action onDoubleClick,
        Action onRightClick)
    {
        var cat = item.DisplayCategory;
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        // 40x40 thumbnail / swatch / shell icon / glyph box
        var thumb = new Border
        {
            Width = 40,
            Height = 40,
            CornerRadius = new CornerRadius(8),
            ClipToBounds = true,
            VerticalAlignment = VerticalAlignment.Center
        };
        if (cat == LumenDisplayCategory.Color && LumenClassifier.TryParseHexColor(item.EffectiveText, out var swatch))
        {
            thumb.Background = LumenPalette.Brush(swatch);
        }
        else if (cat == LumenDisplayCategory.Image && item.DecodeThumbnailImage() is { } imgBmp)
        {
            thumb.Background = palette.SurfaceElevated;
            thumb.Child = new Image { Source = imgBmp, Stretch = Stretch.UniformToFill };
        }
        else if (item.Kind == "file" && item.PrimaryFilePath is { } fp && LumenWin32.ExtractShellIcon(fp) is { } shellIcon)
        {
            thumb.Background = palette.SurfaceElevated;
            thumb.Child = new Image { Source = shellIcon, Width = 28, Height = 28, Stretch = Stretch.Uniform };
        }
        else
        {
            var tint = palette.CategoryTintColor(cat);
            thumb.Background = LumenPalette.Brush(LumenPalette.WithAlpha(tint, 0.16));
            thumb.Child = LumenUiFactory.CreateGlyph(cat.GetGlyph(), 17, LumenPalette.Brush(tint));
        }
        Grid.SetColumn(thumb, 0);

        var mid = new StackPanel
        {
            Orientation = Orientation.Vertical,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(10, 0, 10, 0)
        };
        mid.Children.Add(new TextBlock
        {
            Text = item.DisplayTitle,
            FontFamily = LumenFonts.Ui,
            FontSize = 13,
            FontWeight = FontWeights.SemiBold,
            Foreground = palette.Ink,
            TextTrimming = TextTrimming.CharacterEllipsis
        });
        var excerpt = cat is LumenDisplayCategory.Image or LumenDisplayCategory.File
            ? $"{cat.GetLabel()} · {item.SourceLabel} · {item.FormattedSize}"
            : Regex.Replace(item.EffectiveText, @"\s+", " ").Trim();
        mid.Children.Add(new TextBlock
        {
            Text = excerpt,
            FontFamily = LumenFonts.Ui,
            FontSize = 11.5,
            Foreground = palette.Muted,
            TextTrimming = TextTrimming.CharacterEllipsis,
            Margin = new Thickness(0, 2, 0, 0)
        });
        Grid.SetColumn(mid, 1);

        var right = new StackPanel
        {
            Orientation = Orientation.Vertical,
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Center
        };
        right.Children.Add(new TextBlock
        {
            Text = item.RelativeTime,
            FontFamily = LumenFonts.Mono,
            FontSize = 10.5,
            Foreground = palette.Muted,
            HorizontalAlignment = HorizontalAlignment.Right
        });
        if (item.Pinned)
        {
            var pin = LumenUiFactory.CreateGlyph("\uE840", 11, palette.Accent);
            pin.HorizontalAlignment = HorizontalAlignment.Right;
            pin.Margin = new Thickness(0, 4, 0, 0);
            right.Children.Add(pin);
        }
        Grid.SetColumn(right, 2);

        grid.Children.Add(thumb);
        grid.Children.Add(mid);
        grid.Children.Add(right);

        var row = new Border
        {
            Height = 58,
            CornerRadius = new CornerRadius(9),
            Background = selected ? palette.AccentSoft : Brushes.Transparent,
            BorderBrush = selected ? palette.AccentBorder : Brushes.Transparent,
            BorderThickness = new Thickness(1),
            Padding = new Thickness(10, 0, 12, 0),
            Margin = new Thickness(4, 1.5, 4, 1.5),
            Cursor = Cursors.Hand,
            Child = grid
        };
        row.MouseEnter += (_, _) => { if (!selected) row.Background = LumenPalette.Brush(LumenPalette.WithAlpha(palette.AccentColor, 0.07)); };
        row.MouseLeave += (_, _) => { if (!selected) row.Background = Brushes.Transparent; };
        row.MouseLeftButtonDown += (_, e) =>
        {
            if (e.ClickCount >= 2) onDoubleClick();
            else onClick(e);
            e.Handled = true;
        };
        row.MouseRightButtonUp += (_, e) =>
        {
            onRightClick();
            e.Handled = true;
        };
        return row;
    }

    public static Border CreateGalleryCard(
        LumenClipboardItem item,
        bool selected,
        LumenPalette palette,
        Action<MouseButtonEventArgs> onClick,
        Action onDoubleClick,
        Action onRightClick)
    {
        var cat = item.DisplayCategory;
        var layout = new Grid();
        layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        layout.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        // Header
        var head = new DockPanel { LastChildFill = true, Margin = new Thickness(10, 9, 10, 4) };
        var dot = new Border
        {
            Width = 14,
            Height = 14,
            CornerRadius = new CornerRadius(4),
            Background = palette.SourceBadgeBrush(item.SourceLabel),
            Margin = new Thickness(0, 0, 6, 0),
            VerticalAlignment = VerticalAlignment.Center
        };
        DockPanel.SetDock(dot, Dock.Left);
        var timeLbl = new TextBlock
        {
            Text = item.RelativeTime,
            FontFamily = LumenFonts.Mono,
            FontSize = 10,
            Foreground = palette.Muted,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(4, 0, 0, 0)
        };
        DockPanel.SetDock(timeLbl, Dock.Right);
        var srcLbl = new TextBlock
        {
            Text = item.SourceLabel,
            FontFamily = LumenFonts.Ui,
            FontSize = 10.5,
            FontWeight = FontWeights.Medium,
            Foreground = palette.Muted,
            TextTrimming = TextTrimming.CharacterEllipsis,
            VerticalAlignment = VerticalAlignment.Center
        };
        head.Children.Add(dot);
        head.Children.Add(timeLbl);
        head.Children.Add(srcLbl);
        Grid.SetRow(head, 0);

        var titleLbl = new TextBlock
        {
            Text = item.DisplayTitle,
            FontFamily = LumenFonts.Ui,
            FontSize = 12.5,
            FontWeight = FontWeights.SemiBold,
            Foreground = palette.Ink,
            TextTrimming = TextTrimming.CharacterEllipsis,
            Margin = new Thickness(10, 2, 10, 6)
        };
        Grid.SetRow(titleLbl, 1);

        var body = new Border
        {
            CornerRadius = new CornerRadius(8),
            ClipToBounds = true,
            Margin = new Thickness(10, 0, 10, 6)
        };
        PopulateCardPreviewBody(body, item, palette);
        Grid.SetRow(body, 2);

        // Footer
        var foot = new DockPanel { LastChildFill = false, Margin = new Thickness(10, 0, 10, 8) };
        var catGlyph = LumenUiFactory.CreateGlyph(cat.GetGlyph(), 11, palette.Muted);
        catGlyph.Margin = new Thickness(0, 0, 5, 0);
        DockPanel.SetDock(catGlyph, Dock.Left);
        var catLbl = new TextBlock
        {
            Text = cat.GetLabel(),
            FontFamily = LumenFonts.Ui,
            FontSize = 10,
            Foreground = palette.Muted,
            VerticalAlignment = VerticalAlignment.Center
        };
        DockPanel.SetDock(catLbl, Dock.Left);
        foot.Children.Add(catGlyph);
        foot.Children.Add(catLbl);
        if (item.Pinned)
        {
            var pin = LumenUiFactory.CreateGlyph("\uE840", 11, palette.Accent);
            DockPanel.SetDock(pin, Dock.Right);
            foot.Children.Add(pin);
        }
        Grid.SetRow(foot, 3);

        layout.Children.Add(head);
        layout.Children.Add(titleLbl);
        layout.Children.Add(body);
        layout.Children.Add(foot);

        var card = new Border
        {
            Width = 178,
            Height = 176,
            CornerRadius = new CornerRadius(12),
            Background = palette.Surface,
            BorderBrush = selected ? palette.Accent : palette.Border,
            BorderThickness = new Thickness(selected ? 2 : 1),
            Margin = new Thickness(5),
            Cursor = Cursors.Hand,
            Child = layout
        };
        card.MouseLeftButtonDown += (_, e) =>
        {
            if (e.ClickCount >= 2) onDoubleClick();
            else onClick(e);
            e.Handled = true;
        };
        card.MouseRightButtonUp += (_, e) =>
        {
            onRightClick();
            e.Handled = true;
        };
        return card;
    }

    private static void PopulateCardPreviewBody(Border body, LumenClipboardItem item, LumenPalette palette)
    {
        var cat = item.DisplayCategory;
        switch (cat)
        {
            case LumenDisplayCategory.Color:
                if (LumenClassifier.TryParseHexColor(item.EffectiveText, out var sw))
                {
                    body.Background = LumenPalette.Brush(sw);
                }
                break;
            case LumenDisplayCategory.Image:
                body.Background = palette.SurfaceElevated;
                if (item.DecodeThumbnailImage() is { } bmp)
                {
                    body.Child = new Image { Source = bmp, Stretch = Stretch.UniformToFill };
                }
                else
                {
                    body.Child = LumenUiFactory.CreateGlyph("\uEB9F", 26, palette.Muted);
                }
                break;
            case LumenDisplayCategory.Code:
                body.Background = palette.CodeBackground;
                body.Padding = new Thickness(7, 6, 7, 6);
                var lang = LumenClassifier.DetectLanguage(item.PrimaryFilePath, item.EffectiveText);
                var codeTb = new TextBlock { TextWrapping = TextWrapping.Wrap, TextTrimming = TextTrimming.CharacterEllipsis };
                var snippet = item.EffectiveText.Length > 220 ? item.EffectiveText[..220] : item.EffectiveText;
                LumenSyntaxHighlighter.PopulateCodeTextBlock(codeTb, snippet, lang, 10, darkCanvas: true);
                body.Child = codeTb;
                break;
            case LumenDisplayCategory.File:
                body.Background = palette.SurfaceElevated;
                var st = new StackPanel { Orientation = Orientation.Vertical, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
                st.Children.Add(LumenCollectionRendererView.CreateFileIconElement(item.PrimaryFilePath, palette, 32));
                st.Children.Add(new TextBlock
                {
                    Text = item.FormattedSize,
                    FontFamily = LumenFonts.Ui,
                    FontSize = 10.5,
                    Foreground = palette.Muted,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    Margin = new Thickness(0, 4, 0, 0)
                });
                body.Child = st;
                break;
            default:
                var previewText = item.EffectiveText.Length > 180 ? item.EffectiveText[..180] : item.EffectiveText;
                body.Child = new TextBlock
                {
                    Text = previewText,
                    FontFamily = LumenFonts.Ui,
                    FontSize = 11.5,
                    Foreground = palette.Muted,
                    TextWrapping = TextWrapping.Wrap,
                    TextTrimming = TextTrimming.CharacterEllipsis
                };
                break;
        }
    }
}

// ============================================================================
// Inspector Control (Single Item & Batch Multi-Select)
// ============================================================================

public sealed class LumenInspectorControl : Border
{
    public event Action<LumenClipboardItem>? CopySingleRequested;
    public event Action<LumenClipboardItem>? PreviewSingleRequested;
    public event Action<LumenClipboardItem>? PinSingleRequested;
    public event Action<LumenClipboardItem>? DeleteSingleRequested;
    public event Action<IReadOnlyList<LumenClipboardItem>>? BatchPreviewRequested;
    public event Action<IReadOnlyList<LumenClipboardItem>>? BatchPinRequested;
    public event Action<IReadOnlyList<LumenClipboardItem>>? BatchDeleteRequested;
    public event Action? ClearSelectionRequested;

    private int _renderGeneration;

    public void Render(LumenClipboardItem? single, IReadOnlyList<LumenClipboardItem> batch, LumenPalette palette)
    {
        var gen = ++_renderGeneration;
        Background = palette.WindowBackground;

        if (batch.Count > 1)
        {
            Child = BuildBatchView(batch, palette);
            return;
        }
        if (single is null)
        {
            Child = new TextBlock
            {
                Text = "选择一条记录查看预览与详情",
                FontFamily = LumenFonts.Ui,
                FontSize = 13,
                Foreground = palette.Muted,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };
            return;
        }
        Child = BuildSingleView(single, palette, gen);
    }

    private UIElement BuildBatchView(IReadOnlyList<LumenClipboardItem> items, LumenPalette palette)
    {
        var grid = new Grid();
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(44) });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        var top = new DockPanel { LastChildFill = false, Margin = new Thickness(16, 0, 12, 0), VerticalAlignment = VerticalAlignment.Center };
        var title = new TextBlock { Text = "多选批量操作", FontFamily = LumenFonts.Ui, FontSize = 12.5, FontWeight = FontWeights.SemiBold, Foreground = palette.Ink, VerticalAlignment = VerticalAlignment.Center };
        DockPanel.SetDock(title, Dock.Left);
        var cancelBtn = LumenUiFactory.CreateIconButton("\uE711", "取消多选 (Esc)", palette, () => ClearSelectionRequested?.Invoke(), 28, 28);
        DockPanel.SetDock(cancelBtn, Dock.Right);
        top.Children.Add(title);
        top.Children.Add(cancelBtn);
        Grid.SetRow(top, 0);
        grid.Children.Add(top);

        var center = new StackPanel
        {
            Orientation = Orientation.Vertical,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(20)
        };
        var icon = LumenUiFactory.CreateGlyph("\uE8FD", 42, palette.Accent);
        icon.Margin = new Thickness(0, 0, 0, 12);
        center.Children.Add(icon);
        center.Children.Add(new TextBlock
        {
            Text = $"{items.Count} 条记录",
            FontFamily = LumenFonts.Ui,
            FontSize = 22,
            FontWeight = FontWeights.SemiBold,
            Foreground = palette.Ink,
            HorizontalAlignment = HorizontalAlignment.Center
        });
        center.Children.Add(new TextBlock
        {
            Text = "对所选记录执行批量预览、固定或清理",
            FontFamily = LumenFonts.Ui,
            FontSize = 12,
            Foreground = palette.Muted,
            HorizontalAlignment = HorizontalAlignment.Center,
            Margin = new Thickness(0, 6, 0, 20)
        });

        var previewBtn = LumenUiFactory.CreatePillButton($"批量预览 · {items.Count} 项", palette, () => BatchPreviewRequested?.Invoke(items), primary: true, glyph: "\uE740");
        previewBtn.MinWidth = 216;
        center.Children.Add(previewBtn);

        var rowBtns = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 10, 0, 0) };
        var pinBtn = LumenUiFactory.CreatePillButton("批量固定", palette, () => BatchPinRequested?.Invoke(items), glyph: "\uE718");
        pinBtn.Margin = new Thickness(0, 0, 8, 0);
        var delBtn = LumenUiFactory.CreatePillButton("批量移除", palette, () => BatchDeleteRequested?.Invoke(items), danger: true, glyph: "\uE74D");
        rowBtns.Children.Add(pinBtn);
        rowBtns.Children.Add(delBtn);
        center.Children.Add(rowBtns);

        Grid.SetRow(center, 1);
        grid.Children.Add(center);
        return grid;
    }

    private UIElement BuildSingleView(LumenClipboardItem item, LumenPalette palette, int gen)
    {
        var kind = LumenPreviewItem.ClassifyItem(item);
        var root = new Grid();
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(44) });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(60) });

        // Top toolbar
        var top = new DockPanel { LastChildFill = false, Margin = new Thickness(16, 0, 12, 0), VerticalAlignment = VerticalAlignment.Center };
        var typeGlyph = LumenUiFactory.CreateGlyph(item.DisplayCategory.GetGlyph(), 13, palette.Muted);
        typeGlyph.Margin = new Thickness(0, 0, 6, 0);
        DockPanel.SetDock(typeGlyph, Dock.Left);
        var heading = new TextBlock
        {
            Text = $"{kind.DisplayLabel}预览",
            FontFamily = LumenFonts.Ui,
            FontSize = 12.5,
            FontWeight = FontWeights.SemiBold,
            Foreground = palette.Ink,
            VerticalAlignment = VerticalAlignment.Center
        };
        DockPanel.SetDock(heading, Dock.Left);

        var rightTools = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        rightTools.Children.Add(LumenUiFactory.CreateIconButton("\uE740", "完整预览 (Space)", palette, () => PreviewSingleRequested?.Invoke(item), 28, 28));
        rightTools.Children.Add(LumenUiFactory.CreateIconButton(item.Pinned ? "\uE840" : "\uE718", item.Pinned ? "取消固定" : "固定", palette, () => PinSingleRequested?.Invoke(item), 28, 28, item.Pinned ? palette.Accent : palette.Muted));
        rightTools.Children.Add(LumenUiFactory.CreateIconButton("\uE74D", "移除记录 (Delete)", palette, () => DeleteSingleRequested?.Invoke(item), 28, 28, palette.Danger));
        DockPanel.SetDock(rightTools, Dock.Right);

        top.Children.Add(typeGlyph);
        top.Children.Add(heading);
        top.Children.Add(rightTools);
        Grid.SetRow(top, 0);
        root.Children.Add(top);

        // Middle scrollable hero + caption + metadata
        var middle = new StackPanel { Orientation = Orientation.Vertical, Margin = new Thickness(16, 4, 16, 16) };
        var hero = BuildHeroPreview(item, kind, palette, gen);
        hero.Margin = new Thickness(0, 0, 0, 14);
        middle.Children.Add(hero);

        middle.Children.Add(new TextBox
        {
            Text = item.DisplayTitle,
            IsReadOnly = true,
            BorderThickness = new Thickness(0),
            Background = Brushes.Transparent,
            FontFamily = LumenFonts.Ui,
            FontSize = 17.5,
            FontWeight = FontWeights.SemiBold,
            Foreground = palette.Ink,
            TextWrapping = TextWrapping.Wrap,
            Padding = new Thickness(0)
        });
        middle.Children.Add(new TextBlock
        {
            Text = $"{item.SourceLabel} · {item.RelativeTime}",
            FontFamily = LumenFonts.Ui,
            FontSize = 11.5,
            Foreground = palette.Muted,
            Margin = new Thickness(0, 4, 0, 14)
        });
        middle.Children.Add(BuildMetaGrid(item, kind, palette));

        var scroll = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Content = middle
        };
        Grid.SetRow(scroll, 1);
        root.Children.Add(scroll);

        // Bottom bar
        var bottomGrid = new Grid { Margin = new Thickness(16, 0, 16, 0), VerticalAlignment = VerticalAlignment.Center };
        bottomGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        bottomGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(8) });
        bottomGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var copyBtn = LumenUiFactory.CreatePillButton("复制内容 ↵", palette, () => CopySingleRequested?.Invoke(item), primary: true, glyph: "\uE8C8");
        copyBtn.HorizontalAlignment = HorizontalAlignment.Stretch;
        Grid.SetColumn(copyBtn, 0);

        var peekBtn = LumenUiFactory.CreatePillButton("快速预览", palette, () => PreviewSingleRequested?.Invoke(item), glyph: "\uE7B3");
        peekBtn.MinWidth = 104;
        Grid.SetColumn(peekBtn, 2);

        bottomGrid.Children.Add(copyBtn);
        bottomGrid.Children.Add(peekBtn);

        var bottomBar = new Border
        {
            BorderBrush = palette.Border,
            BorderThickness = new Thickness(0, 1, 0, 0),
            Child = bottomGrid
        };
        Grid.SetRow(bottomBar, 2);
        root.Children.Add(bottomBar);

        return root;
    }

    private Border BuildHeroPreview(LumenClipboardItem item, LumenPreviewKind kind, LumenPalette palette, int gen)
    {
        var box = new Border
        {
            MinHeight = 196,
            CornerRadius = new CornerRadius(13),
            Background = palette.Surface,
            BorderBrush = palette.Border,
            BorderThickness = new Thickness(1),
            ClipToBounds = true,
            Cursor = Cursors.Hand,
            ToolTip = "单击打开完整预览"
        };
        box.MouseLeftButtonUp += (_, _) => PreviewSingleRequested?.Invoke(item);

        switch (kind.Tag)
        {
            case LumenPreviewKindTag.Color:
                var swColor = LumenClassifier.TryParseHexColor(item.EffectiveText, out var c) ? c : palette.AccentColor;
                box.Padding = new Thickness(16);
                box.Child = new Border
                {
                    Height = 166,
                    CornerRadius = new CornerRadius(10),
                    Background = LumenPalette.Brush(swColor),
                    Child = new TextBlock
                    {
                        Text = item.EffectiveText.Trim().ToUpperInvariant(),
                        FontFamily = LumenFonts.Mono,
                        FontSize = 20,
                        FontWeight = FontWeights.SemiBold,
                        Foreground = Brushes.White,
                        VerticalAlignment = VerticalAlignment.Bottom,
                        Margin = new Thickness(16, 0, 16, 14)
                    }
                };
                break;
            case LumenPreviewKindTag.Image:
                box.Padding = new Thickness(14);
                var imgSrc = LumenPreviewCache.Shared.GetImage($"clip:{item.Id}") ?? item.DecodeThumbnailImage();
                box.Child = imgSrc is not null
                    ? new Image { Source = imgSrc, Height = 192, Stretch = Stretch.Uniform }
                    : LumenUiFactory.CreateGlyph("\uEB9F", 40, palette.Muted);
                break;
            case LumenPreviewKindTag.Pdf:
                box.Padding = new Thickness(14);
                var pdfImg = new Image { Height = 192, Stretch = Stretch.Uniform, Visibility = Visibility.Collapsed };
                var pdfFallback = LumenUiFactory.CreateGlyph("\uEA90", 44, palette.Accent);
                var pdfHost = new Grid();
                pdfHost.Children.Add(pdfFallback);
                pdfHost.Children.Add(pdfImg);
                box.Child = pdfHost;
                if (item.PrimaryFilePath is { } pdfPath && File.Exists(pdfPath))
                {
                    _ = LumenPdfRenderer.RenderFirstPageThumbnailAsync(pdfPath, 280).ContinueWith(t =>
                    {
                        if (t.Status == TaskStatus.RanToCompletion && t.Result is { } bmp)
                        {
                            LumenWpfHost.RunOnUi(() =>
                            {
                                if (gen != _renderGeneration) return;
                                pdfImg.Source = bmp;
                                pdfImg.Visibility = Visibility.Visible;
                                pdfFallback.Visibility = Visibility.Collapsed;
                            });
                        }
                    }, TaskScheduler.Default);
                }
                break;
            case LumenPreviewKindTag.Audio:
            case LumenPreviewKindTag.Video:
                box.Padding = new Thickness(18);
                box.Child = new LumenAlbumCoverControl
                {
                    Width = 162,
                    Height = 162,
                    SeedIndex = Math.Abs(item.Id.GetHashCode(StringComparison.Ordinal)) % 3,
                    BadgeText = kind.Tag == LumenPreviewKindTag.Audio ? "AUDIO" : "VIDEO",
                    HorizontalAlignment = HorizontalAlignment.Center
                };
                break;
            case LumenPreviewKindTag.Code:
                box.Background = palette.CodeBackground;
                box.Padding = new Thickness(16);
                var codeTb = new TextBlock { TextWrapping = TextWrapping.Wrap, MaxHeight = 220, TextTrimming = TextTrimming.CharacterEllipsis };
                var lang = string.IsNullOrEmpty(kind.Subtype) ? "js" : kind.Subtype;
                LumenSyntaxHighlighter.PopulateCodeTextBlock(codeTb, item.EffectiveText, lang, 11.5, darkCanvas: true);
                box.Child = codeTb;
                break;
            case LumenPreviewKindTag.Collection:
            case LumenPreviewKindTag.File:
            case LumenPreviewKindTag.Office:
                box.Padding = new Thickness(18);
                var fStack = new StackPanel { Orientation = Orientation.Vertical, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
                fStack.Children.Add(LumenCollectionRendererView.CreateFileIconElement(item.PrimaryFilePath, palette, 54));
                fStack.Children.Add(new TextBlock
                {
                    Text = item.DisplayTitle,
                    FontFamily = LumenFonts.Ui,
                    FontSize = 14.5,
                    FontWeight = FontWeights.SemiBold,
                    Foreground = palette.Ink,
                    TextAlignment = TextAlignment.Center,
                    TextWrapping = TextWrapping.Wrap,
                    Margin = new Thickness(0, 10, 0, 4)
                });
                fStack.Children.Add(new TextBlock
                {
                    Text = $"{kind.DisplayLabel} · {item.FormattedSize} · 点击完整预览",
                    FontFamily = LumenFonts.Ui,
                    FontSize = 11,
                    Foreground = palette.Muted,
                    TextAlignment = TextAlignment.Center
                });
                box.Child = fStack;
                break;
            default:
                box.Padding = new Thickness(18);
                var snippet = item.EffectiveText.Length > 520 ? item.EffectiveText[..520] + "…" : item.EffectiveText;
                box.Child = new TextBlock
                {
                    Text = snippet,
                    FontFamily = LumenFonts.Ui,
                    FontSize = 14,
                    LineHeight = 22,
                    Foreground = palette.Ink,
                    TextWrapping = TextWrapping.Wrap
                };
                break;
        }
        return box;
    }

    private static Grid BuildMetaGrid(LumenClipboardItem item, LumenPreviewKind kind, LumenPalette palette)
    {
        (string Key, string Val)[] entries =
        {
            ("内容类型", kind.DisplayLabel),
            ("大小", item.FormattedSize),
            ("来源", item.SourceLabel),
            ("收藏状态", item.Pinned ? "已固定" : "未固定"),
            ("落盘状态", item.Materialized ? "已就绪" : "远端按需拉取"),
            ("出现次数", $"{Math.Max(1, item.SeenCount)} 次")
        };

        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(12) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        var rows = (entries.Length + 1) / 2;
        for (var r = 0; r < rows; r++)
        {
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        }

        for (var i = 0; i < entries.Length; i++)
        {
            var r = i / 2;
            var c = (i % 2) * 2;
            var cell = new StackPanel { Orientation = Orientation.Vertical, Margin = new Thickness(0, 0, 0, 10) };
            cell.Children.Add(new TextBlock { Text = entries[i].Key, FontFamily = LumenFonts.Ui, FontSize = 10.5, Foreground = palette.Muted });
            cell.Children.Add(new TextBlock
            {
                Text = entries[i].Val,
                FontFamily = LumenFonts.Ui,
                FontSize = 12,
                FontWeight = FontWeights.Medium,
                Foreground = palette.Ink,
                TextTrimming = TextTrimming.CharacterEllipsis,
                Margin = new Thickness(0, 2, 0, 0)
            });
            Grid.SetRow(cell, r);
            Grid.SetColumn(cell, c);
            grid.Children.Add(cell);
        }
        return grid;
    }
}

// ============================================================================
// Native Settings Control (Orbit / Appearance / Sync & Data)
// ============================================================================

public sealed class LumenSettingsControl : ScrollViewer
{
    public enum SettingsTab { Orbit, Appearance, Data }

    private readonly StackPanel _rootStack = new() { Orientation = Orientation.Vertical, MaxWidth = 720, Margin = new Thickness(24, 22, 24, 28) };
    private readonly Border _tabStrip = new() { CornerRadius = new CornerRadius(10), Padding = new Thickness(4), Margin = new Thickness(0, 0, 0, 18) };
    private readonly StackPanel _bodyStack = new() { Orientation = Orientation.Vertical };
    private SettingsTab _activeTab = SettingsTab.Orbit;

    public event Action<Dictionary<string, object?>>? PatchServerSettingsRequested;
    public event Action<LumenVisualPreferences>? ApplyPreferencesRequested;
    public event Action? TriggerSyncRequested;
    public event Action? ClearAllItemsRequested;

    public LumenSettingsControl()
    {
        VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled;
        _rootStack.Children.Add(_tabStrip);
        _rootStack.Children.Add(_bodyStack);
        Content = _rootStack;
    }

    public void Reload()
    {
        var store = LumenClipboardStore.Shared;
        var palette = LumenPalette.Current(store.Preferences);
        Background = palette.WindowBackground;

        BuildTabStrip(palette);
        _bodyStack.Children.Clear();
        switch (_activeTab)
        {
            case SettingsTab.Orbit:
                BuildOrbitTab(store, palette);
                break;
            case SettingsTab.Appearance:
                BuildAppearanceTab(store, palette);
                break;
            case SettingsTab.Data:
                BuildDataTab(store, palette);
                break;
        }
    }

    private void BuildTabStrip(LumenPalette palette)
    {
        _tabStrip.Background = palette.SurfaceElevated;
        var grid = new Grid();
        (SettingsTab Tab, string Title)[] tabs =
        {
            (SettingsTab.Orbit, "Orbit 浮层"),
            (SettingsTab.Appearance, "外观材质"),
            (SettingsTab.Data, "同步与数据")
        };
        for (var i = 0; i < tabs.Length; i++)
        {
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var item = tabs[i];
            var on = _activeTab == item.Tab;
            var pill = new Border
            {
                CornerRadius = new CornerRadius(7),
                Background = on ? palette.Surface : Brushes.Transparent,
                BorderBrush = on ? palette.Border : Brushes.Transparent,
                BorderThickness = new Thickness(1),
                Padding = new Thickness(0, 8, 0, 8),
                Child = new TextBlock
                {
                    Text = item.Title,
                    FontFamily = LumenFonts.Ui,
                    FontSize = 12,
                    FontWeight = on ? FontWeights.SemiBold : FontWeights.Normal,
                    Foreground = on ? palette.Accent : palette.Muted,
                    HorizontalAlignment = HorizontalAlignment.Center
                }
            };
            var btn = LumenUiFactory.CreateBorderlessButton(pill, null, () =>
            {
                _activeTab = item.Tab;
                Reload();
            });
            Grid.SetColumn(btn, i);
            grid.Children.Add(btn);
        }
        _tabStrip.Child = grid;
    }

    private void BuildOrbitTab(LumenClipboardStore store, LumenPalette palette)
    {
        var hero = new LumenMiniOrbitPreviewControl { Height = 132, Margin = new Thickness(0, 0, 0, 18) };
        _bodyStack.Children.Add(hero);

        AddHeading("快捷浮层", "独立原生 WPF 无边框置顶贴边轨道（WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW），支持 DWM Acrylic、多屏连续底栏、中断式动效与焦点恢复。", palette);

        var posBox = MakeComboBox(new[] { "底部连续轨道", "左侧边栏轨道", "右侧边栏轨道" },
            Array.IndexOf(new[] { "bottom", "left", "right" }, store.Settings.QuickOrbitPosition) switch { >= 0 and var i => i, _ => 0 },
            idx =>
            {
                string[] vals = { "bottom", "left", "right" };
                PatchServerSettingsRequested?.Invoke(new Dictionary<string, object?> { ["quickOrbitPosition"] = vals[Math.Clamp(idx, 0, 2)] });
            });

        var capSw = new LumenToggleSwitch(store.Settings.CaptureEnabled, palette);
        capSw.Toggled += on => PatchServerSettingsRequested?.Invoke(new Dictionary<string, object?> { ["captureEnabled"] = on });

        var partSw = new LumenToggleSwitch(store.Preferences.Particles, palette);
        partSw.Toggled += on => ApplyPreferencesRequested?.Invoke(store.Preferences with { Particles = on });

        var glowSw = new LumenToggleSwitch(store.Preferences.Glow, palette);
        glowSw.Toggled += on => ApplyPreferencesRequested?.Invoke(store.Preferences with { Glow = on });

        var motSw = new LumenToggleSwitch(store.Preferences.Motion, palette);
        motSw.Toggled += on => ApplyPreferencesRequested?.Invoke(store.Preferences with { Motion = on });

        _bodyStack.Children.Add(MakeSettingsGroup(new (string, string, UIElement)[]
        {
            ("贴边位置", "同步写入服务端配置 quickOrbitPosition，并在系统托盘菜单保持一致。", posBox),
            ("本机剪贴板自动采集", "开启后后台记录复制的文本、图片与文件引用。", capSw),
            ("高光粒子", "Orbit 轨道背景浮光粒子与卡片移除释放光点。", partSw),
            ("动态光感", "焦点卡片微光边界与随指针移动的高光镜面反射。", glowSw),
            ("流畅动效", "关闭后即时切换；始终尊重 Windows 系统动画开关。", motSw)
        }, palette));
    }

    private void BuildAppearanceTab(LumenClipboardStore store, LumenPalette palette)
    {
        AddHeading("窗口外观", "App 管理窗口、Orbit 快捷浮层与 Quick Look 预览窗口共享同一主题与 DWM 材质。", palette);

        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(14) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        var lightTile = MakeThemeTile("冰川玻璃 · 浅色", false, store.Preferences.Theme == LumenThemeMode.Light, palette,
            () => ApplyPreferencesRequested?.Invoke(store.Preferences with { Theme = LumenThemeMode.Light }));
        var darkTile = MakeThemeTile("深海玻璃 · 深色", true, store.Preferences.Theme == LumenThemeMode.Dark, palette,
            () => ApplyPreferencesRequested?.Invoke(store.Preferences with { Theme = LumenThemeMode.Dark }));
        Grid.SetColumn(lightTile, 0);
        Grid.SetColumn(darkTile, 2);
        grid.Children.Add(lightTile);
        grid.Children.Add(darkTile);
        _bodyStack.Children.Add(grid);
    }

    private void BuildDataTab(LumenClipboardStore store, LumenPalette palette)
    {
        AddHeading("同步与数据", "通过本机 AIH Server 管理接口持久化；管理密钥仅从 IPC、环境变量或本机 %USERPROFILE%\\.ai_home\\aih.db 只读读取。", palette);

        int[] retVals = { 7, 30, 90, 365 };
        var retBox = MakeComboBox(new[] { "7 天", "30 天", "90 天", "365 天" },
            Array.IndexOf(retVals, store.Settings.RetentionDays) switch { >= 0 and var i => i, _ => 1 },
            idx => PatchServerSettingsRequested?.Invoke(new Dictionary<string, object?> { ["retentionDays"] = retVals[Math.Clamp(idx, 0, retVals.Length - 1)] }));

        int[] maxVals = { 200, 500, 1000, 2000 };
        var maxBox = MakeComboBox(new[] { "200 条", "500 条", "1000 条", "2000 条" },
            Array.IndexOf(maxVals, store.Settings.MaxItems) switch { >= 0 and var i => i, _ => 1 },
            idx => PatchServerSettingsRequested?.Invoke(new Dictionary<string, object?> { ["maxItems"] = maxVals[Math.Clamp(idx, 0, maxVals.Length - 1)] }));

        var syncSw = new LumenToggleSwitch(store.Settings.SyncEnabled, palette);
        syncSw.Toggled += on => PatchServerSettingsRequested?.Invoke(new Dictionary<string, object?> { ["syncEnabled"] = on });

        var serverLabels = new List<string> { "未选择目标服务器" };
        var selectedServerIdx = 0;
        for (var i = 0; i < store.Servers.Count; i++)
        {
            var s = store.Servers[i];
            serverLabels.Add($"{s.Label} ({s.Endpoint})");
            if (string.Equals(s.Id, store.Settings.SyncTargetProfileId, StringComparison.Ordinal))
            {
                selectedServerIdx = i + 1;
            }
        }
        var serverBox = MakeComboBox(serverLabels.ToArray(), selectedServerIdx, idx =>
        {
            var profileId = idx > 0 && idx - 1 < store.Servers.Count ? store.Servers[idx - 1].Id : string.Empty;
            PatchServerSettingsRequested?.Invoke(new Dictionary<string, object?> { ["syncTargetProfileId"] = profileId });
        });

        var syncNowBtn = LumenUiFactory.CreatePillButton("立即同步", palette, () => TriggerSyncRequested?.Invoke());
        var clearBtn = LumenUiFactory.CreatePillButton("清空当前列表", palette, () => ClearAllItemsRequested?.Invoke(), danger: true);

        var originLabel = new TextBlock
        {
            Text = string.IsNullOrEmpty(store.Api.Config.Origin) ? "未配置" : store.Api.Config.Origin,
            FontFamily = LumenFonts.Mono,
            FontSize = 11,
            Foreground = palette.Muted,
            VerticalAlignment = VerticalAlignment.Center
        };
        var deviceLabel = new TextBlock
        {
            Text = string.IsNullOrWhiteSpace(store.Status?.DeviceName) ? Environment.MachineName : store.Status.DeviceName,
            FontFamily = LumenFonts.Ui,
            FontSize = 12,
            Foreground = palette.Muted,
            VerticalAlignment = VerticalAlignment.Center
        };

        _bodyStack.Children.Add(MakeSettingsGroup(new (string, string, UIElement)[]
        {
            ("本机服务端点", "从 IPC、环境变量或 %USERPROFILE%\\.ai_home\\aih.db 只读解析，绝不硬编码密钥。", originLabel),
            ("当前设备", "剪贴板历史来源设备标识。", deviceLabel),
            ("历史保留天数", "超过保留期的未固定记录自动清理。", retBox),
            ("最大条目上限", "本地 SQLite 资料库最大保存条数。", maxBox),
            ("跨设备加密同步", "启用后自动将新条目同步至选定中继服务器。", syncSw),
            ("同步目标服务器", "从 AIH 控制平面服务器配置读取。", serverBox),
            ("手动同步", "立即执行一次增量双向同步。", syncNowBtn),
            ("清空历史记录", "通过批量删除接口清理当前列表中的所有记录。", clearBtn)
        }, palette));
    }

    private void AddHeading(string title, string subtitle, LumenPalette palette)
    {
        _bodyStack.Children.Add(new TextBlock
        {
            Text = title,
            FontFamily = LumenFonts.Ui,
            FontSize = 18,
            FontWeight = FontWeights.SemiBold,
            Foreground = palette.Ink
        });
        _bodyStack.Children.Add(new TextBlock
        {
            Text = subtitle,
            FontFamily = LumenFonts.Ui,
            FontSize = 12,
            Foreground = palette.Muted,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 4, 0, 14)
        });
    }

    private static ComboBox MakeComboBox(string[] options, int selectedIdx, Action<int> onChanged)
    {
        var box = new ComboBox
        {
            MinWidth = 156,
            FontFamily = LumenFonts.Ui,
            FontSize = 12,
            VerticalAlignment = VerticalAlignment.Center
        };
        foreach (var opt in options) box.Items.Add(opt);
        box.SelectedIndex = Math.Clamp(selectedIdx, 0, Math.Max(0, options.Length - 1));
        box.SelectionChanged += (_, _) =>
        {
            if (box.SelectedIndex >= 0) onChanged(box.SelectedIndex);
        };
        return box;
    }

    private static Border MakeSettingsGroup((string Title, string Desc, UIElement Control)[] rows, LumenPalette palette)
    {
        var stack = new StackPanel { Orientation = Orientation.Vertical };
        for (var i = 0; i < rows.Length; i++)
        {
            var (title, desc, control) = rows[i];
            var rowGrid = new Grid { MinHeight = 58, Margin = new Thickness(16, 8, 16, 8) };
            rowGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            rowGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(16) });
            rowGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            var left = new StackPanel { Orientation = Orientation.Vertical, VerticalAlignment = VerticalAlignment.Center };
            left.Children.Add(new TextBlock { Text = title, FontFamily = LumenFonts.Ui, FontSize = 13, FontWeight = FontWeights.SemiBold, Foreground = palette.Ink });
            left.Children.Add(new TextBlock { Text = desc, FontFamily = LumenFonts.Ui, FontSize = 11, Foreground = palette.Muted, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 2, 0, 0) });

            Grid.SetColumn(left, 0);
            Grid.SetColumn(control, 2);
            rowGrid.Children.Add(left);
            rowGrid.Children.Add(control);

            stack.Children.Add(rowGrid);
            if (i < rows.Length - 1)
            {
                stack.Children.Add(new Border { Height = 1, Background = palette.Border, Margin = new Thickness(16, 0, 16, 0) });
            }
        }
        return new Border
        {
            CornerRadius = new CornerRadius(12),
            Background = palette.Surface,
            BorderBrush = palette.Border,
            BorderThickness = new Thickness(1),
            Child = stack
        };
    }

    private static Button MakeThemeTile(string title, bool dark, bool active, LumenPalette palette, Action onSelect)
    {
        var mockGrid = new Grid { Height = 72 };
        mockGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(0.28, GridUnitType.Star) });
        mockGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(0.72, GridUnitType.Star) });
        var mockSide = new Border { Background = LumenPalette.Brush(dark ? LumenPalette.Dark.SidebarTopColor : LumenPalette.Light.SidebarTopColor) };
        var mockBody = new Border { Background = LumenPalette.Brush(dark ? LumenPalette.Dark.WindowBackgroundColor : LumenPalette.Light.WindowBackgroundColor) };
        Grid.SetColumn(mockSide, 0);
        Grid.SetColumn(mockBody, 1);
        mockGrid.Children.Add(mockSide);
        mockGrid.Children.Add(mockBody);

        var inner = new StackPanel { Orientation = Orientation.Vertical, Margin = new Thickness(10) };
        inner.Children.Add(new Border { CornerRadius = new CornerRadius(7), ClipToBounds = true, Child = mockGrid });
        inner.Children.Add(new TextBlock
        {
            Text = title,
            FontFamily = LumenFonts.Ui,
            FontSize = 12.5,
            FontWeight = active ? FontWeights.SemiBold : FontWeights.Medium,
            Foreground = palette.Ink,
            Margin = new Thickness(2, 8, 2, 0)
        });

        var card = new Border
        {
            CornerRadius = new CornerRadius(12),
            Background = palette.Surface,
            BorderBrush = active ? palette.Accent : palette.Border,
            BorderThickness = new Thickness(active ? 2 : 1),
            Child = inner
        };
        return LumenUiFactory.CreateBorderlessButton(card, null, onSelect);
    }
}

// ============================================================================
// Compact Floating Toast Banner
// ============================================================================

public sealed class LumenToastBanner : Border
{
    private readonly TextBlock _messageLabel = new();
    private readonly Button _undoBtn;
    private DispatcherTimer? _hideTimer;

    public event Action? UndoRequested;

    public LumenToastBanner()
    {
        CornerRadius = new CornerRadius(12);
        Background = LumenPalette.Brush(LumenPalette.Rgba(0.125, 0.196, 0.302, 0.94));
        BorderBrush = LumenPalette.Brush(LumenPalette.WithAlpha(Colors.White, 0.22));
        BorderThickness = new Thickness(1);
        Padding = new Thickness(15, 9, 15, 9);
        HorizontalAlignment = HorizontalAlignment.Center;
        VerticalAlignment = VerticalAlignment.Top;
        Visibility = Visibility.Collapsed;
        Opacity = 0;

        _messageLabel.FontFamily = LumenFonts.Ui;
        _messageLabel.FontSize = 12;
        _messageLabel.FontWeight = FontWeights.Medium;
        _messageLabel.Foreground = Brushes.White;
        _messageLabel.VerticalAlignment = VerticalAlignment.Center;

        var undoText = new TextBlock
        {
            Text = "撤销",
            FontFamily = LumenFonts.Ui,
            FontSize = 12,
            FontWeight = FontWeights.SemiBold,
            Foreground = LumenPalette.Brush(LumenPalette.Rgb(0.725, 0.851, 1.0)),
            TextDecorations = TextDecorations.Underline,
            Margin = new Thickness(10, 0, 0, 0),
            VerticalAlignment = VerticalAlignment.Center
        };
        _undoBtn = LumenUiFactory.CreateBorderlessButton(undoText, null, () =>
        {
            _hideTimer?.Stop();
            Visibility = Visibility.Collapsed;
            Opacity = 0;
            UndoRequested?.Invoke();
        });

        var row = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        row.Children.Add(_messageLabel);
        row.Children.Add(_undoBtn);
        Child = row;
    }

    public void ShowToast(string message, bool showUndo = false)
    {
        _hideTimer?.Stop();
        _messageLabel.Text = message;
        _undoBtn.Visibility = showUndo ? Visibility.Visible : Visibility.Collapsed;
        Visibility = Visibility.Visible;

        var fadeIn = new DoubleAnimation(1.0, TimeSpan.FromMilliseconds(LumenMotion.IsEnabled ? 180 : 10));
        BeginAnimation(OpacityProperty, fadeIn, HandoffBehavior.SnapshotAndReplace);

        _hideTimer ??= new DispatcherTimer { Interval = TimeSpan.FromSeconds(3.2) };
        _hideTimer.Tick -= OnHideTick;
        _hideTimer.Tick += OnHideTick;
        _hideTimer.Stop();
        _hideTimer.Start();
    }

    private void OnHideTick(object? sender, EventArgs e)
    {
        _hideTimer?.Stop();
        var fadeOut = new DoubleAnimation(0.0, TimeSpan.FromMilliseconds(LumenMotion.IsEnabled ? 220 : 10));
        fadeOut.Completed += (_, _) => Visibility = Visibility.Collapsed;
        BeginAnimation(OpacityProperty, fadeOut, HandoffBehavior.SnapshotAndReplace);
    }
}

// ============================================================================
// Native Modal New Clip Sheet (Ctrl+N)
// ============================================================================

public sealed class LumenNewClipDialog : Window
{
    private readonly TextBox _inputBox = new();
    public string ResultText { get; private set; } = string.Empty;

    public LumenNewClipDialog(LumenPalette palette)
    {
        Title = "新建剪贴板记录";
        Width = 500;
        Height = 310;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        Background = palette.Surface;
        LumenWpfHost.AttachWindowInterop(this);

        SourceInitialized += (_, _) =>
        {
            var hwnd = new System.Windows.Interop.WindowInteropHelper(this).Handle;
            _ = LumenWin32.ApplyDwmBackdrop(hwnd, palette.IsDark, LumenWin32.DWMSBT_MAINWINDOW, LumenWin32.DWMWCP_ROUND, extendGlassFrame: false);
        };

        var root = new Grid { Margin = new Thickness(20, 18, 20, 16) };
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        var heading = new TextBlock
        {
            Text = "输入文本、代码或链接",
            FontFamily = LumenFonts.Ui,
            FontSize = 14.5,
            FontWeight = FontWeights.SemiBold,
            Foreground = palette.Ink,
            Margin = new Thickness(0, 0, 0, 10)
        };
        Grid.SetRow(heading, 0);
        root.Children.Add(heading);

        _inputBox.AcceptsReturn = true;
        _inputBox.AcceptsTab = true;
        _inputBox.TextWrapping = TextWrapping.Wrap;
        _inputBox.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        _inputBox.FontFamily = LumenFonts.Ui;
        _inputBox.FontSize = 13;
        _inputBox.Background = palette.WindowBackground;
        _inputBox.Foreground = palette.Ink;
        _inputBox.CaretBrush = palette.Ink;
        _inputBox.BorderBrush = palette.Border;
        _inputBox.BorderThickness = new Thickness(1);
        _inputBox.Padding = new Thickness(10);
        Grid.SetRow(_inputBox, 1);
        root.Children.Add(_inputBox);

        var actions = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 14, 0, 0)
        };
        var cancelBtn = LumenUiFactory.CreatePillButton("取消", palette, () => { DialogResult = false; Close(); });
        cancelBtn.Margin = new Thickness(0, 0, 8, 0);
        var saveBtn = LumenUiFactory.CreatePillButton("保存 (Ctrl+Enter)", palette, CommitAndClose, primary: true);
        actions.Children.Add(cancelBtn);
        actions.Children.Add(saveBtn);
        Grid.SetRow(actions, 2);
        root.Children.Add(actions);

        Content = root;
        Loaded += (_, _) => _inputBox.Focus();
        PreviewKeyDown += (_, e) =>
        {
            if (e.Key == Key.Escape)
            {
                DialogResult = false;
                Close();
                e.Handled = true;
            }
            else if (e.Key == Key.Enter && (Keyboard.Modifiers & ModifierKeys.Control) != 0)
            {
                CommitAndClose();
                e.Handled = true;
            }
        };
    }

    private void CommitAndClose()
    {
        ResultText = _inputBox.Text ?? string.Empty;
        DialogResult = !string.IsNullOrWhiteSpace(ResultText);
        Close();
    }
}
