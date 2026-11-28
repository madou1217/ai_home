using System.Collections.Specialized;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shell;
using Microsoft.Win32;

namespace AihLumenClipboard;

/// <summary>
/// Shared floating native WPF Quick Look preview container used by both the App Management Window
/// and the Orbit Edge Rail. Owns queue navigation, keyboard routing, drag-and-drop local preview,
/// and mounts format-specific renderers via <see cref="LumenPreviewRegistry"/>.
/// </summary>
public sealed class LumenPreviewWindow : Window
{
    private static LumenPreviewWindow? _shared;
    public static LumenPreviewWindow Shared
    {
        get
        {
            LumenWpfHost.EnsureInitialized();
            if (_shared is null)
            {
                _shared = new LumenPreviewWindow();
            }
            return _shared;
        }
    }

    private readonly Border _shellBorder = new();
    private readonly Border _headerBar = new();
    private readonly TextBlock _titleLabel = new();
    private readonly TextBlock _subtitleLabel = new();
    private readonly TextBlock _counterLabel = new();
    private readonly Border _queuePane = new();
    private readonly ColumnDefinition _queueCol = new() { Width = new GridLength(0) };
    private readonly ColumnDefinition _queueDividerCol = new() { Width = new GridLength(0) };
    private readonly Border _queueDivider = new();
    private readonly TextBlock _queueHeaderLabel = new();
    private readonly StackPanel _queueListStack = new() { Orientation = Orientation.Vertical, Margin = new Thickness(8, 4, 8, 8) };
    private readonly Grid _stageContainer = new();
    private readonly Border _footerBar = new();
    private readonly TextBlock _footerLeftLabel = new();
    private readonly TextBlock _footerHintsLabel = new();

    private readonly List<LumenPreviewItem> _queue = new();
    private int _activeIndex;
    private IPreviewRendererView? _activeRendererView;
    private int _transitionToken;
    private Guid _themeObserverId;
    private bool _allowRealClose;

    public event Action<string>? ToastRequested;

    private LumenPreviewWindow()
    {
        Title = "Lumen Quick Look";
        Width = 1040;
        Height = 740;
        MinWidth = 720;
        MinHeight = 480;
        WindowStartupLocation = WindowStartupLocation.Manual;
        Topmost = true;
        ShowInTaskbar = false;
        AllowDrop = true;
        Background = Brushes.Transparent;

        var chrome = new WindowChrome
        {
            CaptionHeight = 52,
            CornerRadius = new CornerRadius(12),
            GlassFrameThickness = new Thickness(-1),
            ResizeBorderThickness = new Thickness(6),
            UseAeroCaptionButtons = false
        };
        WindowChrome.SetWindowChrome(this, chrome);
        LumenWpfHost.AttachWindowInterop(this);

        BuildLayout();
        ApplyTheme();

        SourceInitialized += (_, _) => ApplyDwmBackdrop();
        PreviewKeyDown += OnPreviewKeyDownHandler;
        DragOver += OnDragOverHandler;
        Drop += OnDropHandler;
        Closing += (_, e) =>
        {
            if (!_allowRealClose)
            {
                e.Cancel = true;
                CloseAnimated();
            }
        };

        _themeObserverId = LumenClipboardStore.Shared.AddObserver(ev =>
        {
            if (ev.Kind == LumenStoreEventKind.PreferencesUpdated)
            {
                ApplyTheme();
            }
        });
    }

    public bool IsPreviewVisible => IsVisible && Visibility == Visibility.Visible;

    public void Shutdown()
    {
        LumenClipboardStore.Shared.RemoveObserver(_themeObserverId);
        _activeRendererView?.Teardown();
        _activeRendererView = null;
        _allowRealClose = true;
        Close();
        if (ReferenceEquals(_shared, this)) _shared = null;
    }

    public void Open(IReadOnlyList<LumenClipboardItem> clipboardItems, string? initialId = null)
    {
        var flattened = LumenPreviewItem.Flatten(clipboardItems);
        if (flattened.Count == 0) return;
        var startIdx = 0;
        if (!string.IsNullOrEmpty(initialId))
        {
            var found = flattened.FindIndex(x =>
                string.Equals(x.Id, initialId, StringComparison.Ordinal) ||
                string.Equals(x.ClipboardItem?.Id, initialId, StringComparison.Ordinal));
            if (found >= 0) startIdx = found;
        }
        Present(flattened, startIdx);
    }

    public void PresentLocalFiles(IReadOnlyList<string> paths)
    {
        var items = LumenPreviewItem.FromLocalPaths(paths);
        if (items.Count == 0) return;
        Present(items, 0);
    }

    public void OpenLocalFilePicker(Window? owner = null)
    {
        var dlg = new OpenFileDialog
        {
            Title = "选择本地文件进行预览",
            Multiselect = true,
            CheckFileExists = true,
            Filter = "所有支持的文件|*.*|文档与表格|*.pdf;*.docx;*.xlsx;*.pptx;*.txt;*.md|媒体与图片|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.mp3;*.wav;*.m4a;*.flac;*.mp4;*.mov;*.webm"
        };
        var ok = owner is not null && owner.IsVisible ? dlg.ShowDialog(owner) : dlg.ShowDialog();
        if (ok == true && dlg.FileNames.Length > 0)
        {
            PresentLocalFiles(dlg.FileNames);
        }
    }

    private void Present(List<LumenPreviewItem> nextQueue, int startIndex)
    {
        _queue.Clear();
        _queue.AddRange(nextQueue);
        _activeIndex = Math.Clamp(startIndex, 0, Math.Max(0, _queue.Count - 1));
        UpdateQueueVisibility();
        RebuildQueueRows();
        MountActiveRenderer(animated: false);
        ShowAnimated();
    }

    public void CloseAnimated()
    {
        if (!IsVisible) return;
        var token = ++_transitionToken;
        _activeRendererView?.Teardown();
        _stageContainer.Children.Clear();
        _activeRendererView = null;

        if (!LumenMotion.IsEnabled)
        {
            Hide();
            _shellBorder.Opacity = 1;
            return;
        }

        var fade = new DoubleAnimation(0, LumenMotion.ExitDuration)
        {
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseIn }
        };
        fade.Completed += (_, _) =>
        {
            if (_transitionToken != token) return;
            Hide();
            _shellBorder.BeginAnimation(OpacityProperty, null);
            _shellBorder.Opacity = 1;
        };
        _shellBorder.BeginAnimation(OpacityProperty, fade, HandoffBehavior.SnapshotAndReplace);
    }

    private void ShowAnimated()
    {
        var token = ++_transitionToken;
        var wasVisible = IsVisible;
        if (!wasVisible)
        {
            PositionCenteredOnActiveMonitor();
            _shellBorder.Opacity = LumenMotion.IsEnabled ? 0 : 1;
        }

        Show();
        Activate();
        Focus();
        ApplyDwmBackdrop();

        if (LumenMotion.IsEnabled)
        {
            var fade = new DoubleAnimation(1, LumenMotion.EnterDuration)
            {
                EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
            };
            fade.Completed += (_, _) =>
            {
                if (_transitionToken != token) return;
                _shellBorder.BeginAnimation(OpacityProperty, null);
                _shellBorder.Opacity = 1;
            };
            _shellBorder.BeginAnimation(OpacityProperty, fade, HandoffBehavior.SnapshotAndReplace);
        }
        else
        {
            _shellBorder.BeginAnimation(OpacityProperty, null);
            _shellBorder.Opacity = 1;
        }
    }

    private void PositionCenteredOnActiveMonitor()
    {
        var monitors = LumenWin32.EnumerateMonitors();
        var mon = LumenWin32.GetActiveMonitor(monitors);
        var scaleX = mon.ScaleX;
        var scaleY = mon.ScaleY;
        var workW = mon.WorkAreaPx.Width / scaleX;
        var workH = mon.WorkAreaPx.Height / scaleY;
        var w = Math.Clamp(workW * 0.78, 760, 1080);
        var h = Math.Clamp(workH * 0.82, 540, 780);
        Width = w;
        Height = h;
        Left = (mon.WorkAreaPx.Left / scaleX) + Math.Max(0, (workW - w) * 0.5);
        Top = (mon.WorkAreaPx.Top / scaleY) + Math.Max(0, (workH - h) * 0.5);
    }

    private void ApplyDwmBackdrop()
    {
        var hwnd = new WindowInteropHelper(this).Handle;
        if (hwnd == IntPtr.Zero) return;
        var palette = LumenPalette.Current();
        var applied = LumenWin32.ApplyDwmBackdrop(hwnd, palette.IsDark, LumenWin32.DWMSBT_MAINWINDOW, LumenWin32.DWMWCP_ROUND, extendGlassFrame: true);
        _shellBorder.Background = applied
            ? LumenPalette.Brush(LumenPalette.WithAlpha(palette.SurfaceColor, palette.IsDark ? 0.86 : 0.90))
            : palette.Surface;
    }

    private void BuildLayout()
    {
        var rootGrid = new Grid();
        rootGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(54) });
        rootGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        rootGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(38) });

        // Header bar
        var headerGrid = new Grid { Margin = new Thickness(16, 0, 12, 0) };
        headerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        headerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        _titleLabel.FontFamily = LumenFonts.Ui;
        _titleLabel.FontSize = 14;
        _titleLabel.FontWeight = FontWeights.SemiBold;
        _titleLabel.TextTrimming = TextTrimming.CharacterEllipsis;

        _subtitleLabel.FontFamily = LumenFonts.Mono;
        _subtitleLabel.FontSize = 10;
        _subtitleLabel.FontWeight = FontWeights.Medium;
        _subtitleLabel.TextTrimming = TextTrimming.CharacterEllipsis;
        _subtitleLabel.Margin = new Thickness(0, 2, 0, 0);

        var idStack = new StackPanel { Orientation = Orientation.Vertical, VerticalAlignment = VerticalAlignment.Center };
        idStack.Children.Add(_titleLabel);
        idStack.Children.Add(_subtitleLabel);
        Grid.SetColumn(idStack, 0);
        headerGrid.Children.Add(idStack);

        var palette = LumenPalette.Current();
        _counterLabel.FontFamily = LumenFonts.Mono;
        _counterLabel.FontSize = 11.5;
        _counterLabel.VerticalAlignment = VerticalAlignment.Center;
        _counterLabel.Margin = new Thickness(6, 0, 6, 0);

        var actions = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        WindowChrome.SetIsHitTestVisibleInChrome(actions, true);
        actions.Children.Add(MakeChromeIcon("\uE76B", "上一项 (←)", () => StepQueue(-1)));
        actions.Children.Add(_counterLabel);
        actions.Children.Add(MakeChromeIcon("\uE76C", "下一项 (→)", () => StepQueue(1)));
        actions.Children.Add(MakeChromeIcon("\uE710", "导入本地文件", () => OpenLocalFilePicker(this)));
        actions.Children.Add(MakeChromeIcon("\uE8C8", "复制 (Ctrl+C)", () => _activeRendererView?.CopyPrimaryContent()));
        actions.Children.Add(MakeChromeIcon("\uE922", "最大化 / 还原", ToggleMaximize));
        actions.Children.Add(MakeChromeIcon("\uE8BB", "关闭 (Esc)", CloseAnimated));
        Grid.SetColumn(actions, 1);
        headerGrid.Children.Add(actions);

        _headerBar.BorderThickness = new Thickness(0, 0, 0, 1);
        _headerBar.Child = headerGrid;
        Grid.SetRow(_headerBar, 0);
        rootGrid.Children.Add(_headerBar);

        // Middle: Queue Sidebar | Divider | Stage
        var middle = new Grid();
        middle.ColumnDefinitions.Add(_queueCol);
        middle.ColumnDefinitions.Add(_queueDividerCol);
        middle.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        var queueGrid = new Grid();
        queueGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        queueGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        _queueHeaderLabel.FontFamily = LumenFonts.Ui;
        _queueHeaderLabel.FontSize = 11;
        _queueHeaderLabel.FontWeight = FontWeights.SemiBold;
        _queueHeaderLabel.Margin = new Thickness(14, 12, 12, 6);
        Grid.SetRow(_queueHeaderLabel, 0);
        queueGrid.Children.Add(_queueHeaderLabel);

        var queueScroll = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Content = _queueListStack
        };
        Grid.SetRow(queueScroll, 1);
        queueGrid.Children.Add(queueScroll);

        _queuePane.Child = queueGrid;
        Grid.SetColumn(_queuePane, 0);
        middle.Children.Add(_queuePane);

        Grid.SetColumn(_queueDivider, 1);
        middle.Children.Add(_queueDivider);

        Grid.SetColumn(_stageContainer, 2);
        middle.Children.Add(_stageContainer);

        Grid.SetRow(middle, 1);
        rootGrid.Children.Add(middle);

        // Footer bar
        var footerGrid = new Grid { Margin = new Thickness(16, 0, 16, 0) };
        footerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        footerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        footerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        _footerLeftLabel.FontFamily = LumenFonts.Ui;
        _footerLeftLabel.FontSize = 11;
        _footerLeftLabel.VerticalAlignment = VerticalAlignment.Center;
        _footerLeftLabel.TextTrimming = TextTrimming.CharacterEllipsis;
        Grid.SetColumn(_footerLeftLabel, 0);

        var footerImport = LumenUiFactory.CreateBorderlessButton(
            new TextBlock
            {
                Text = "＋ 本地文件预览",
                FontFamily = LumenFonts.Ui,
                FontSize = 11,
                FontWeight = FontWeights.Medium,
                Foreground = palette.Accent,
                VerticalAlignment = VerticalAlignment.Center
            },
            "打开本地文件",
            () => OpenLocalFilePicker(this));
        Grid.SetColumn(footerImport, 1);

        _footerHintsLabel.Text = "← → 切换 · Space 播放/暂停 · Ctrl+/− 缩放 · Esc 关闭";
        _footerHintsLabel.FontFamily = LumenFonts.Ui;
        _footerHintsLabel.FontSize = 10.5;
        _footerHintsLabel.VerticalAlignment = VerticalAlignment.Center;
        _footerHintsLabel.HorizontalAlignment = HorizontalAlignment.Right;
        Grid.SetColumn(_footerHintsLabel, 2);

        footerGrid.Children.Add(_footerLeftLabel);
        footerGrid.Children.Add(footerImport);
        footerGrid.Children.Add(_footerHintsLabel);

        _footerBar.BorderThickness = new Thickness(0, 1, 0, 0);
        _footerBar.Child = footerGrid;
        Grid.SetRow(_footerBar, 2);
        rootGrid.Children.Add(_footerBar);

        _shellBorder.BorderThickness = new Thickness(1);
        _shellBorder.Child = rootGrid;
        Content = _shellBorder;
    }

    private Button MakeChromeIcon(string glyph, string tip, Action onClick)
    {
        var palette = LumenPalette.Current();
        var btn = LumenUiFactory.CreateIconButton(glyph, tip, palette, onClick, 30, 30);
        btn.Margin = new Thickness(2, 0, 2, 0);
        return btn;
    }

    private void ApplyTheme()
    {
        var palette = LumenPalette.Current();
        _shellBorder.BorderBrush = palette.Border;
        _headerBar.Background = Brushes.Transparent;
        _headerBar.BorderBrush = palette.Border;
        _queuePane.Background = LumenPalette.Brush(LumenPalette.WithAlpha(palette.SidebarBottomColor, 0.72));
        _queueDivider.Background = palette.Border;
        _stageContainer.Background = palette.WindowBackground;
        _footerBar.Background = Brushes.Transparent;
        _footerBar.BorderBrush = palette.Border;

        _titleLabel.Foreground = palette.Ink;
        _subtitleLabel.Foreground = palette.Muted;
        _counterLabel.Foreground = palette.Muted;
        _queueHeaderLabel.Foreground = palette.Muted;
        _footerLeftLabel.Foreground = palette.Muted;
        _footerHintsLabel.Foreground = palette.Muted;

        ApplyDwmBackdrop();
        if (_queue.Count > 0)
        {
            RebuildQueueRows();
            MountActiveRenderer(animated: false);
        }
    }

    private void UpdateQueueVisibility()
    {
        var showQueue = _queue.Count > 1;
        _queueCol.Width = showQueue ? new GridLength(236) : new GridLength(0);
        _queueDividerCol.Width = showQueue ? new GridLength(1) : new GridLength(0);
        var audioOnly = _queue.Count > 0 && _queue.All(x => x.Kind.Tag == LumenPreviewKindTag.Audio);
        _queueHeaderLabel.Text = $"{(audioOnly ? "播放队列" : "文件集合")} · {_queue.Count}";
    }

    private void RebuildQueueRows()
    {
        _queueListStack.Children.Clear();
        var palette = LumenPalette.Current();
        for (var i = 0; i < _queue.Count; i++)
        {
            var idx = i;
            var item = _queue[i];
            var selected = i == _activeIndex;

            var rowGrid = new Grid();
            rowGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            rowGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            rowGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            UIElement thumb;
            if (item.Kind.Tag == LumenPreviewKindTag.Audio)
            {
                thumb = new LumenAlbumCoverControl { Width = 34, Height = 34, SeedIndex = item.SeedIndex, BadgeText = string.Empty };
            }
            else
            {
                thumb = new Border
                {
                    Width = 34,
                    Height = 34,
                    CornerRadius = new CornerRadius(7),
                    Background = palette.SurfaceElevated,
                    Child = new TextBlock
                    {
                        Text = item.Kind.BadgeCode,
                        FontFamily = LumenFonts.Mono,
                        FontSize = 9.5,
                        FontWeight = FontWeights.Bold,
                        Foreground = palette.Accent,
                        HorizontalAlignment = HorizontalAlignment.Center,
                        VerticalAlignment = VerticalAlignment.Center
                    }
                };
            }
            Grid.SetColumn(thumb, 0);

            var textStack = new StackPanel { Orientation = Orientation.Vertical, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(9, 0, 6, 0) };
            textStack.Children.Add(new TextBlock
            {
                Text = item.Title,
                FontFamily = LumenFonts.Ui,
                FontSize = 12,
                FontWeight = selected ? FontWeights.SemiBold : FontWeights.Medium,
                Foreground = palette.Ink,
                TextTrimming = TextTrimming.CharacterEllipsis
            });
            textStack.Children.Add(new TextBlock
            {
                Text = $"{item.Kind.DisplayLabel} · {item.SizeLabel}",
                FontFamily = LumenFonts.Ui,
                FontSize = 10,
                Foreground = palette.Muted,
                TextTrimming = TextTrimming.CharacterEllipsis,
                Margin = new Thickness(0, 2, 0, 0)
            });
            Grid.SetColumn(textStack, 1);

            var idxLbl = new TextBlock
            {
                Text = selected ? "●" : (i + 1).ToString("D2"),
                FontFamily = LumenFonts.Mono,
                FontSize = 10,
                FontWeight = FontWeights.SemiBold,
                Foreground = selected ? palette.Accent : palette.Muted,
                VerticalAlignment = VerticalAlignment.Center
            };
            Grid.SetColumn(idxLbl, 2);

            rowGrid.Children.Add(thumb);
            rowGrid.Children.Add(textStack);
            rowGrid.Children.Add(idxLbl);

            // Uniform 1px border + soft fill for selected queue entry (zero left accent bar).
            var cell = new Border
            {
                Height = 52,
                CornerRadius = new CornerRadius(9),
                Background = selected ? palette.AccentSoft : Brushes.Transparent,
                BorderBrush = selected ? palette.AccentBorder : Brushes.Transparent,
                BorderThickness = new Thickness(1),
                Padding = new Thickness(8, 0, 10, 0),
                Margin = new Thickness(0, 0, 0, 4),
                Child = rowGrid
            };
            _queueListStack.Children.Add(LumenUiFactory.CreateBorderlessButton(cell, null, () => SelectQueueIndex(idx)));
        }
    }

    private void MountActiveRenderer(bool animated)
    {
        if (_activeIndex < 0 || _activeIndex >= _queue.Count) return;
        var item = _queue[_activeIndex];
        var palette = LumenPalette.Current();

        _titleLabel.Text = item.Title;
        _subtitleLabel.Text = $"QUICK LOOK  /  {item.Kind.DisplayLabel.ToUpperInvariant()}";
        _counterLabel.Text = $"{_activeIndex + 1} / {_queue.Count}";
        _footerLeftLabel.Text = $"{item.Kind.DisplayLabel} · {item.SizeLabel}";

        // Synchronously tear down previous renderer before mounting the next (contract §4.2).
        _activeRendererView?.Teardown();
        _stageContainer.Children.Clear();
        _activeRendererView = null;

        var ctx = new LumenPreviewContext
        {
            Store = LumenClipboardStore.Shared,
            Cache = LumenPreviewCache.Shared,
            Palette = palette,
            OnStepQueue = (delta, _) => StepQueue(delta),
            OnSelectQueueIndex = SelectQueueIndex,
            OnToast = msg => ToastRequested?.Invoke(msg),
            OnCopyItem = CopyPreviewItem
        };

        var view = LumenPreviewRegistry.Shared.CreateView(item, ctx);
        _activeRendererView = view;
        _stageContainer.Children.Add(view.Visual);

        if (animated && LumenMotion.IsEnabled)
        {
            var slide = new TranslateTransform(0, 8);
            view.Visual.RenderTransform = slide;
            view.Visual.Opacity = 0.25;
            var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
            slide.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(0, LumenMotion.SwitchDuration) { EasingFunction = ease });
            view.Visual.BeginAnimation(OpacityProperty, new DoubleAnimation(1.0, LumenMotion.SwitchDuration) { EasingFunction = ease });
        }
    }

    private void SelectQueueIndex(int idx)
    {
        if (idx < 0 || idx >= _queue.Count || idx == _activeIndex) return;
        _activeIndex = idx;
        RebuildQueueRows();
        MountActiveRenderer(animated: true);
    }

    private void StepQueue(int delta)
    {
        var next = _activeIndex + delta;
        if (next < 0 || next >= _queue.Count) return;
        SelectQueueIndex(next);
    }

    private void CopyPreviewItem(LumenPreviewItem item)
    {
        if (item.ClipboardItem is { } clip)
        {
            _ = CopyClipboardItemAsync(clip.Id);
            return;
        }
        if (!string.IsNullOrEmpty(item.LocalPath) && File.Exists(item.LocalPath))
        {
            try
            {
                var list = new StringCollection { item.LocalPath };
                Clipboard.SetFileDropList(list);
                ToastRequested?.Invoke("已复制文件引用");
            }
            catch (Exception ex)
            {
                ToastRequested?.Invoke($"复制失败：{ex.Message}");
            }
        }
    }

    private async Task CopyClipboardItemAsync(string clipId)
    {
        var (ok, err) = await LumenClipboardStore.Shared.CopyToOsClipboardAsync(clipId).ConfigureAwait(false);
        LumenWpfHost.RunOnUi(() =>
        {
            ToastRequested?.Invoke(ok ? "已复制到剪贴板" : $"复制失败：{err}");
        });
    }

    private void ToggleMaximize()
    {
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
    }

    private void OnDragOverHandler(object sender, DragEventArgs e)
    {
        e.Effects = e.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None;
        e.Handled = true;
    }

    private void OnDropHandler(object sender, DragEventArgs e)
    {
        if (e.Data.GetData(DataFormats.FileDrop) is string[] files && files.Length > 0)
        {
            PresentLocalFiles(files);
        }
    }

    private void OnPreviewKeyDownHandler(object sender, KeyEventArgs e)
    {
        var mods = Keyboard.Modifiers;
        var ctrl = (mods & ModifierKeys.Control) != 0;

        switch (e.Key)
        {
            case Key.Escape:
                CloseAnimated();
                e.Handled = true;
                break;
            case Key.Left:
                if (_queue.Count > 1)
                {
                    StepQueue(-1);
                    e.Handled = true;
                }
                else if (_activeRendererView?.StepPage(-1) == true)
                {
                    e.Handled = true;
                }
                break;
            case Key.Right:
                if (_queue.Count > 1)
                {
                    StepQueue(1);
                    e.Handled = true;
                }
                else if (_activeRendererView?.StepPage(1) == true)
                {
                    e.Handled = true;
                }
                break;
            case Key.Space:
                if (_activeRendererView?.TogglePlayPause() != true)
                {
                    CloseAnimated();
                }
                e.Handled = true;
                break;
            case Key.PageUp:
            case Key.OemOpenBrackets:
                if (_activeRendererView?.StepPage(-1) == true) e.Handled = true;
                break;
            case Key.PageDown:
            case Key.OemCloseBrackets:
                if (_activeRendererView?.StepPage(1) == true) e.Handled = true;
                break;
            case Key.OemPlus:
            case Key.Add:
                if (ctrl)
                {
                    _activeRendererView?.ZoomIn();
                    e.Handled = true;
                }
                break;
            case Key.OemMinus:
            case Key.Subtract:
                if (ctrl)
                {
                    _activeRendererView?.ZoomOut();
                    e.Handled = true;
                }
                break;
            case Key.D0:
            case Key.NumPad0:
                if (ctrl)
                {
                    _activeRendererView?.ResetZoom();
                    e.Handled = true;
                }
                break;
            case Key.C:
                if (ctrl && Keyboard.FocusedElement is not TextBox && Keyboard.FocusedElement is not FlowDocumentScrollViewer)
                {
                    _activeRendererView?.CopyPrimaryContent();
                    e.Handled = true;
                }
                break;
            case Key.Enter:
                _activeRendererView?.CopyPrimaryContent();
                e.Handled = true;
                break;
        }
    }
}
