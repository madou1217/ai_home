using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Shell;

namespace AihLumenClipboard;

/// <summary>
/// Separate native WPF App Management Window for Paste Lumen V7 (zero WebView/HTML).
/// Shares <see cref="LumenClipboardStore.Shared"/> and <see cref="LumenPreviewWindow.Shared"/>
/// with the separate <see cref="QuickOrbitWindow"/> edge rail surface.
/// </summary>
public sealed class ClipboardWorkspaceWindow : Window
{
    private enum SortOrder { Newest = 0, Oldest = 1, Title = 2 }

    private readonly LumenClipboardStore _store = LumenClipboardStore.Shared;
    private readonly Border _shellBorder = new();
    private readonly ColumnDefinition _sidebarCol = new() { Width = new GridLength(208) };
    private readonly ColumnDefinition _sidebarDividerCol = new() { Width = new GridLength(1) };
    private readonly LumenSidebarControl _sidebar = new();
    private readonly Border _sidebarDivider = new();

    private readonly Border _toolbarBorder = new();
    private readonly TextBlock _headingLabel = new();
    private readonly TextBlock _subHeadingLabel = new();
    private readonly Border _searchPill = new();
    private readonly TextBox _searchBox = new();
    private readonly TextBlock _searchPlaceholder = new();
    private readonly ComboBox _sortCombo = new();
    private readonly Border _viewTogglePill = new();
    private readonly Button _listModeBtn;
    private readonly Button _galleryModeBtn;
    private readonly Border _listModePill;
    private readonly Border _galleryModePill;
    private readonly TextBlock _themeGlyph;
    private readonly Border _orbitPill;
    private readonly TextBlock _orbitText;

    private readonly Grid _splitGrid = new();
    private readonly ColumnDefinition _inspectorCol = new() { Width = new GridLength(370), MinWidth = 290 };
    private readonly ColumnDefinition _splitterCol = new() { Width = new GridLength(5) };
    private readonly GridSplitter _splitter = new();
    private readonly Border _historyHost = new();
    private readonly ScrollViewer _listScroll = new();
    private readonly StackPanel _listStack = new() { Orientation = Orientation.Vertical, Margin = new Thickness(6, 4, 6, 12) };
    private readonly ScrollViewer _galleryScroll = new();
    private readonly WrapPanel _galleryWrap = new() { Orientation = Orientation.Horizontal, Margin = new Thickness(10, 8, 10, 14) };
    private readonly TextBlock _emptyLabel = new();

    private readonly LumenInspectorControl _inspector = new();
    private readonly LumenSettingsControl _settingsView = new();

    private readonly Border _footerBar = new();
    private readonly TextBlock _footerLeft = new();
    private readonly TextBlock _footerRight = new();
    private readonly LumenToastBanner _toast = new();

    private bool _enabled = true;
    private bool _hasPositioned;
    private bool _allowRealClose;
    private Guid _observerId;

    private LumenNavDestination _activeNav = LumenNavDestination.All;
    private string _searchQuery = string.Empty;
    private SortOrder _sortOrder = SortOrder.Newest;
    private bool _isListMode = true;
    private bool _sidebarHidden;
    private bool _inspectorHidden;

    private List<LumenClipboardItem> _filteredItems = new();
    private string? _selectedId;
    private readonly HashSet<string> _multiSelectedIds = new(StringComparer.Ordinal);
    private string? _selectionAnchorId;
    private readonly Dictionary<string, FrameworkElement> _itemVisuals = new(StringComparer.Ordinal);

    public event Action? OpenOrbitRequested;
    public event Action<string>? QuickOrbitPositionChanged;

    public ClipboardWorkspaceWindow()
    {
        LumenWpfHost.EnsureInitialized();

        Title = "Lumen 剪贴板";
        Width = 1220;
        Height = 800;
        MinWidth = 820;
        MinHeight = 540;
        WindowStartupLocation = WindowStartupLocation.Manual;
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

        var palette = LumenPalette.Current(_store.Preferences);
        _listModePill = new Border { Width = 28, Height = 24, CornerRadius = new CornerRadius(6), Child = LumenUiFactory.CreateGlyph("\uE8FD", 12.5, palette.Ink) };
        _galleryModePill = new Border { Width = 28, Height = 24, CornerRadius = new CornerRadius(6), Child = LumenUiFactory.CreateGlyph("\uF0E2", 12.5, palette.Muted) };
        _listModeBtn = LumenUiFactory.CreateBorderlessButton(_listModePill, "列表视图", () => SetListMode(true));
        _galleryModeBtn = LumenUiFactory.CreateBorderlessButton(_galleryModePill, "画廊视图", () => SetListMode(false));

        _themeGlyph = LumenUiFactory.CreateGlyph(palette.IsDark ? "\uE706" : "\uE708", 13.5, palette.Muted);
        _orbitText = new TextBlock
        {
            Text = "Orbit",
            FontFamily = LumenFonts.Ui,
            FontSize = 11.5,
            FontWeight = FontWeights.SemiBold,
            VerticalAlignment = VerticalAlignment.Center
        };
        var orbitRow = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        var orbitGlyph = LumenUiFactory.CreateGlyph("\uE734", 12, palette.Accent);
        orbitGlyph.Margin = new Thickness(0, 0, 5, 0);
        orbitRow.Children.Add(orbitGlyph);
        orbitRow.Children.Add(_orbitText);
        _orbitPill = new Border
        {
            Height = 28,
            Padding = new Thickness(10, 0, 10, 0),
            CornerRadius = new CornerRadius(7),
            BorderThickness = new Thickness(1),
            Child = orbitRow
        };

        BuildLayout();
        WireCallbacks();
        ApplyTheme();

        SourceInitialized += (_, _) => ApplyDwmBackdrop();
        PreviewKeyDown += OnWindowPreviewKeyDown;
        Closing += (_, e) =>
        {
            if (!_allowRealClose)
            {
                e.Cancel = true;
                Hide();
            }
        };

        _observerId = _store.AddObserver(HandleStoreEvent);
    }

    public bool IsAvailable
    {
        get
        {
            if (!_enabled) return false;
            if (!_store.IsConfigured) _store.EnsureConfiguredFromLocalConfig();
            return _store.IsConfigured;
        }
    }

    public void Configure(string? origin, string? managementKey, bool enabled)
    {
        _enabled = enabled;
        if (!string.IsNullOrWhiteSpace(origin) || !string.IsNullOrWhiteSpace(managementKey))
        {
            _store.Configure(origin, managementKey);
        }
        else if (enabled)
        {
            _store.EnsureConfiguredFromLocalConfig();
        }
        if (IsVisible && enabled)
        {
            _store.RefreshAll();
        }
    }

    public void ShowWorkspace()
    {
        if (!_enabled) return;
        _store.EnsureConfiguredFromLocalConfig();
        if (!_hasPositioned)
        {
            _hasPositioned = true;
            PositionCenteredOnActiveMonitor();
        }
        if (_store.IsConfigured)
        {
            _store.RefreshAll();
        }
        RebuildFilteredState();
        UpdateFooter();

        if (WindowState == WindowState.Minimized)
        {
            WindowState = WindowState.Normal;
        }
        Show();
        Activate();
        ApplyDwmBackdrop();
    }

    public void Shutdown()
    {
        _store.RemoveObserver(_observerId);
        _allowRealClose = true;
        Close();
    }

    private void PositionCenteredOnActiveMonitor()
    {
        var monitors = LumenWin32.EnumerateMonitors();
        var mon = LumenWin32.GetActiveMonitor(monitors);
        var scaleX = mon.ScaleX;
        var scaleY = mon.ScaleY;
        var workW = mon.WorkAreaPx.Width / scaleX;
        var workH = mon.WorkAreaPx.Height / scaleY;
        Width = Math.Clamp(1220, 820, workW - 40);
        Height = Math.Clamp(800, 540, workH - 40);
        Left = (mon.WorkAreaPx.Left / scaleX) + Math.Max(0, (workW - Width) * 0.5);
        Top = (mon.WorkAreaPx.Top / scaleY) + Math.Max(0, (workH - Height) * 0.5);
    }

    private void ApplyDwmBackdrop()
    {
        var hwnd = new WindowInteropHelper(this).Handle;
        if (hwnd == IntPtr.Zero) return;
        var palette = LumenPalette.Current(_store.Preferences);
        var applied = LumenWin32.ApplyDwmBackdrop(hwnd, palette.IsDark, LumenWin32.DWMSBT_MAINWINDOW, LumenWin32.DWMWCP_ROUND, extendGlassFrame: true);
        _shellBorder.Background = applied
            ? LumenPalette.Brush(LumenPalette.WithAlpha(palette.WindowBackgroundColor, palette.IsDark ? 0.88 : 0.92))
            : palette.WindowBackground;
    }

    private void BuildLayout()
    {
        var root = new Grid();
        root.ColumnDefinitions.Add(_sidebarCol);
        root.ColumnDefinitions.Add(_sidebarDividerCol);
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        Grid.SetColumn(_sidebar, 0);
        Grid.SetColumn(_sidebarDivider, 1);
        root.Children.Add(_sidebar);
        root.Children.Add(_sidebarDivider);

        // Right Workspace Pane
        var workspace = new Grid();
        workspace.RowDefinitions.Add(new RowDefinition { Height = new GridLength(56) });
        workspace.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        workspace.RowDefinitions.Add(new RowDefinition { Height = new GridLength(28) });

        // Top toolbar (also acts as draggable WindowChrome caption strip outside interactive controls)
        var toolbarGrid = new Grid { Margin = new Thickness(12, 0, 10, 0) };
        toolbarGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        toolbarGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        toolbarGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var palette = LumenPalette.Current(_store.Preferences);
        var leftTools = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        WindowChrome.SetIsHitTestVisibleInChrome(leftTools, true);

        var toggleSideBtn = LumenUiFactory.CreateIconButton("\uE700", "切换侧边栏", palette, ToggleSidebar, 30, 28);
        leftTools.Children.Add(toggleSideBtn);

        _headingLabel.Text = "所有记录";
        _headingLabel.FontFamily = LumenFonts.Ui;
        _headingLabel.FontSize = 14;
        _headingLabel.FontWeight = FontWeights.SemiBold;
        _subHeadingLabel.Text = "0 条内容";
        _subHeadingLabel.FontFamily = LumenFonts.Ui;
        _subHeadingLabel.FontSize = 10.5;
        var titleStack = new StackPanel { Orientation = Orientation.Vertical, Margin = new Thickness(10, 0, 10, 0), VerticalAlignment = VerticalAlignment.Center };
        titleStack.Children.Add(_headingLabel);
        titleStack.Children.Add(_subHeadingLabel);
        leftTools.Children.Add(titleStack);

        var addBtn = LumenUiFactory.CreateIconButton("\uE710", "新建文本记录 (Ctrl+N)", palette, OpenNewClipDialog, 30, 28);
        addBtn.Margin = new Thickness(0, 0, 4, 0);
        var localBtn = LumenUiFactory.CreateIconButton("\uE8E5", "预览本地文件", palette, () => LumenPreviewWindow.Shared.OpenLocalFilePicker(this), 30, 28);
        leftTools.Children.Add(addBtn);
        leftTools.Children.Add(localBtn);

        Grid.SetColumn(leftTools, 0);
        toolbarGrid.Children.Add(leftTools);

        // Right toolbar controls + custom caption buttons
        var rightTools = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        WindowChrome.SetIsHitTestVisibleInChrome(rightTools, true);

        // Search box
        var searchInner = new Grid { VerticalAlignment = VerticalAlignment.Center };
        searchInner.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        searchInner.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var searchGlyph = LumenUiFactory.CreateGlyph("\uE721", 12, palette.Muted);
        searchGlyph.Margin = new Thickness(8, 0, 6, 0);
        Grid.SetColumn(searchGlyph, 0);

        var searchTextHost = new Grid { VerticalAlignment = VerticalAlignment.Center };
        _searchPlaceholder.Text = "搜索记录 (Ctrl+F)";
        _searchPlaceholder.FontFamily = LumenFonts.Ui;
        _searchPlaceholder.FontSize = 12;
        _searchPlaceholder.IsHitTestVisible = false;
        _searchPlaceholder.VerticalAlignment = VerticalAlignment.Center;
        _searchBox.Background = Brushes.Transparent;
        _searchBox.BorderThickness = new Thickness(0);
        _searchBox.FontFamily = LumenFonts.Ui;
        _searchBox.FontSize = 12;
        _searchBox.VerticalContentAlignment = VerticalAlignment.Center;
        _searchBox.TextChanged += (_, _) =>
        {
            _searchQuery = _searchBox.Text ?? string.Empty;
            _searchPlaceholder.Visibility = string.IsNullOrEmpty(_searchQuery) ? Visibility.Visible : Visibility.Collapsed;
            _multiSelectedIds.Clear();
            RebuildFilteredState();
        };
        searchTextHost.Children.Add(_searchPlaceholder);
        searchTextHost.Children.Add(_searchBox);
        Grid.SetColumn(searchTextHost, 1);

        searchInner.Children.Add(searchGlyph);
        searchInner.Children.Add(searchTextHost);

        _searchPill.Width = 204;
        _searchPill.Height = 30;
        _searchPill.CornerRadius = new CornerRadius(8);
        _searchPill.BorderThickness = new Thickness(1);
        _searchPill.Padding = new Thickness(0, 0, 8, 0);
        _searchPill.Margin = new Thickness(0, 0, 8, 0);
        _searchPill.Child = searchInner;
        rightTools.Children.Add(_searchPill);

        _sortCombo.Width = 92;
        _sortCombo.Height = 28;
        _sortCombo.FontFamily = LumenFonts.Ui;
        _sortCombo.FontSize = 11.5;
        _sortCombo.VerticalContentAlignment = VerticalAlignment.Center;
        _sortCombo.Margin = new Thickness(0, 0, 8, 0);
        _sortCombo.Items.Add("最新优先");
        _sortCombo.Items.Add("最早优先");
        _sortCombo.Items.Add("按标题");
        _sortCombo.SelectedIndex = 0;
        _sortCombo.SelectionChanged += (_, _) =>
        {
            _sortOrder = (SortOrder)Math.Clamp(_sortCombo.SelectedIndex, 0, 2);
            RebuildFilteredState();
        };
        rightTools.Children.Add(_sortCombo);

        var segStack = new StackPanel { Orientation = Orientation.Horizontal };
        segStack.Children.Add(_listModeBtn);
        segStack.Children.Add(_galleryModeBtn);
        _viewTogglePill.CornerRadius = new CornerRadius(8);
        _viewTogglePill.Padding = new Thickness(2);
        _viewTogglePill.Margin = new Thickness(0, 0, 8, 0);
        _viewTogglePill.Child = segStack;
        rightTools.Children.Add(_viewTogglePill);

        var inspBtn = LumenUiFactory.CreateIconButton("\uE8A0", "切换预览面板", palette, ToggleInspector, 30, 28);
        inspBtn.Margin = new Thickness(0, 0, 4, 0);
        rightTools.Children.Add(inspBtn);

        var themeBtnBorder = new Border { Width = 30, Height = 28, CornerRadius = new CornerRadius(7), Child = _themeGlyph };
        var themeBtn = LumenUiFactory.CreateBorderlessButton(themeBtnBorder, "切换浅色/深色外观", ToggleTheme);
        themeBtn.Margin = new Thickness(0, 0, 6, 0);
        rightTools.Children.Add(themeBtn);

        var orbitBtn = LumenUiFactory.CreateBorderlessButton(_orbitPill, "呼出 Orbit 快捷浮层", () => OpenOrbitRequested?.Invoke());
        orbitBtn.Margin = new Thickness(0, 0, 10, 0);
        rightTools.Children.Add(orbitBtn);

        // Native window caption buttons
        rightTools.Children.Add(LumenUiFactory.CreateIconButton("\uE921", "最小化", palette, () => WindowState = WindowState.Minimized, 28, 28));
        rightTools.Children.Add(LumenUiFactory.CreateIconButton("\uE922", "最大化 / 还原", palette, () => WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized, 28, 28));
        var closeBtn = LumenUiFactory.CreateIconButton("\uE8BB", "关闭窗口", palette, Hide, 28, 28);
        rightTools.Children.Add(closeBtn);

        Grid.SetColumn(rightTools, 2);
        toolbarGrid.Children.Add(rightTools);

        _toolbarBorder.BorderThickness = new Thickness(0, 0, 0, 1);
        _toolbarBorder.Child = toolbarGrid;
        Grid.SetRow(_toolbarBorder, 0);
        workspace.Children.Add(_toolbarBorder);

        // Middle: Split (History | GridSplitter | Inspector) + Settings overlay + Toast
        var contentHost = new Grid();

        _splitGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star), MinWidth = 320 });
        _splitGrid.ColumnDefinitions.Add(_splitterCol);
        _splitGrid.ColumnDefinitions.Add(_inspectorCol);

        _listScroll.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        _listScroll.HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled;
        _listScroll.Content = _listStack;

        _galleryScroll.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        _galleryScroll.HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled;
        _galleryScroll.Visibility = Visibility.Collapsed;
        _galleryScroll.Content = _galleryWrap;

        _emptyLabel.Text = "暂无剪贴板记录";
        _emptyLabel.FontFamily = LumenFonts.Ui;
        _emptyLabel.FontSize = 13;
        _emptyLabel.HorizontalAlignment = HorizontalAlignment.Center;
        _emptyLabel.VerticalAlignment = VerticalAlignment.Center;
        _emptyLabel.Visibility = Visibility.Collapsed;

        var historyGrid = new Grid();
        historyGrid.Children.Add(_listScroll);
        historyGrid.Children.Add(_galleryScroll);
        historyGrid.Children.Add(_emptyLabel);
        _historyHost.Child = historyGrid;

        _splitter.Width = 5;
        _splitter.HorizontalAlignment = HorizontalAlignment.Stretch;
        _splitter.VerticalAlignment = VerticalAlignment.Stretch;
        _splitter.ResizeBehavior = GridResizeBehavior.PreviousAndNext;
        _splitter.Cursor = Cursors.SizeWE;

        Grid.SetColumn(_historyHost, 0);
        Grid.SetColumn(_splitter, 1);
        Grid.SetColumn(_inspector, 2);
        _splitGrid.Children.Add(_historyHost);
        _splitGrid.Children.Add(_splitter);
        _splitGrid.Children.Add(_inspector);

        _settingsView.Visibility = Visibility.Collapsed;

        _toast.Margin = new Thickness(0, 12, 0, 0);
        Panel.SetZIndex(_toast, 100);

        contentHost.Children.Add(_splitGrid);
        contentHost.Children.Add(_settingsView);
        contentHost.Children.Add(_toast);

        Grid.SetRow(contentHost, 1);
        workspace.Children.Add(contentHost);

        // Footer bar
        var footerGrid = new Grid { Margin = new Thickness(14, 0, 14, 0) };
        _footerLeft.FontFamily = LumenFonts.Ui;
        _footerLeft.FontSize = 10.5;
        _footerLeft.VerticalAlignment = VerticalAlignment.Center;
        _footerLeft.HorizontalAlignment = HorizontalAlignment.Left;

        _footerRight.Text = "↑ ↓ 导航 · Space 预览 · ↵ 复制 · Ctrl+F 搜索 · Ctrl+N 新建";
        _footerRight.FontFamily = LumenFonts.Ui;
        _footerRight.FontSize = 10.5;
        _footerRight.VerticalAlignment = VerticalAlignment.Center;
        _footerRight.HorizontalAlignment = HorizontalAlignment.Right;

        footerGrid.Children.Add(_footerLeft);
        footerGrid.Children.Add(_footerRight);
        _footerBar.BorderThickness = new Thickness(0, 1, 0, 0);
        _footerBar.Child = footerGrid;
        Grid.SetRow(_footerBar, 2);
        workspace.Children.Add(_footerBar);

        Grid.SetColumn(workspace, 2);
        root.Children.Add(workspace);

        _shellBorder.BorderThickness = new Thickness(1);
        _shellBorder.Child = root;
        Content = _shellBorder;
    }

    private void WireCallbacks()
    {
        _sidebar.DestinationSelected += SelectDestination;

        _inspector.CopySingleRequested += item => _ = CopyItemAsync(item);
        _inspector.PreviewSingleRequested += item => OpenPreview(new[] { item }, item.Id);
        _inspector.PinSingleRequested += item => _ = TogglePinAsync(item);
        _inspector.DeleteSingleRequested += item => _ = DeleteSingleAsync(item);
        _inspector.BatchPreviewRequested += items => OpenPreview(items, _selectedId);
        _inspector.BatchPinRequested += items => _ = BatchPinAsync(items);
        _inspector.BatchDeleteRequested += items => _ = BatchDeleteAsync(items);
        _inspector.ClearSelectionRequested += () =>
        {
            _multiSelectedIds.Clear();
            ReloadHistoryPresentation();
            RenderInspector();
        };

        _settingsView.PatchServerSettingsRequested += patch => _ = PatchSettingsAsync(patch);
        _settingsView.ApplyPreferencesRequested += next => _store.UpdatePreferences(_ => next);
        _settingsView.TriggerSyncRequested += () => _ = TriggerSyncAsync();
        _settingsView.ClearAllItemsRequested += ConfirmClearAll;

        _toast.UndoRequested += () => _ = UndoDeleteAsync();
        LumenPreviewWindow.Shared.ToastRequested += msg =>
        {
            if (IsVisible) _toast.ShowToast(msg);
        };
    }

    private void HandleStoreEvent(LumenStoreEvent ev)
    {
        switch (ev.Kind)
        {
            case LumenStoreEventKind.ItemsUpdated:
                RebuildFilteredState();
                break;
            case LumenStoreEventKind.SettingsUpdated:
                if (_activeNav.Kind == LumenNavKind.Settings) _settingsView.Reload();
                UpdateSidebar();
                break;
            case LumenStoreEventKind.StatusUpdated:
            case LumenStoreEventKind.ConnectionUpdated:
                UpdateSidebar();
                if (_activeNav.Kind == LumenNavKind.Settings) _settingsView.Reload();
                break;
            case LumenStoreEventKind.PreferencesUpdated:
                ApplyTheme();
                RebuildFilteredState();
                if (_activeNav.Kind == LumenNavKind.Settings) _settingsView.Reload();
                break;
            case LumenStoreEventKind.Error:
                if (IsVisible && !string.IsNullOrWhiteSpace(ev.Message))
                {
                    _toast.ShowToast(ev.Message);
                }
                break;
        }
    }

    private void ApplyTheme()
    {
        var palette = LumenPalette.Current(_store.Preferences);
        _shellBorder.BorderBrush = palette.Border;
        _sidebarDivider.Background = palette.Border;
        _toolbarBorder.BorderBrush = palette.Border;
        _toolbarBorder.Background = Brushes.Transparent;
        _historyHost.Background = palette.WindowBackground;
        _splitter.Background = palette.Border;
        _footerBar.Background = LumenPalette.Brush(palette.SidebarBottomColor);
        _footerBar.BorderBrush = palette.Border;

        _headingLabel.Foreground = palette.Ink;
        _subHeadingLabel.Foreground = palette.Muted;
        _emptyLabel.Foreground = palette.Muted;
        _footerLeft.Foreground = palette.Muted;
        _footerRight.Foreground = palette.Muted;

        _searchPill.Background = palette.Surface;
        _searchPill.BorderBrush = palette.Border;
        _searchBox.Foreground = palette.Ink;
        _searchBox.CaretBrush = palette.Ink;
        _searchPlaceholder.Foreground = palette.Muted;

        _viewTogglePill.Background = palette.SurfaceElevated;
        UpdateViewToggleStyles(palette);

        _themeGlyph.Text = palette.IsDark ? "\uE706" : "\uE708";
        _themeGlyph.Foreground = palette.Muted;

        _orbitPill.Background = palette.AccentSoft;
        _orbitPill.BorderBrush = palette.AccentBorder;
        _orbitText.Foreground = palette.Accent;

        ApplyDwmBackdrop();
        UpdateSidebar();
        RenderInspector();
    }

    private void UpdateViewToggleStyles(LumenPalette palette)
    {
        _listModePill.Background = _isListMode ? palette.Surface : Brushes.Transparent;
        _galleryModePill.Background = !_isListMode ? palette.Surface : Brushes.Transparent;
        if (_listModePill.Child is TextBlock lt) lt.Foreground = _isListMode ? palette.Accent : palette.Muted;
        if (_galleryModePill.Child is TextBlock gt) gt.Foreground = !_isListMode ? palette.Accent : palette.Muted;
    }

    private void UpdateSidebar()
    {
        _sidebar.UpdateState(
            _activeNav,
            _store.Items,
            _store.Connected,
            _store.Status,
            LumenPalette.Current(_store.Preferences));
    }

    private void SelectDestination(LumenNavDestination dest)
    {
        _activeNav = dest;
        _multiSelectedIds.Clear();
        _selectionAnchorId = null;

        var isSettings = dest.Kind == LumenNavKind.Settings;
        _splitGrid.Visibility = isSettings ? Visibility.Collapsed : Visibility.Visible;
        _settingsView.Visibility = isSettings ? Visibility.Visible : Visibility.Collapsed;
        _searchPill.Visibility = isSettings ? Visibility.Collapsed : Visibility.Visible;
        _sortCombo.Visibility = isSettings ? Visibility.Collapsed : Visibility.Visible;
        _viewTogglePill.Visibility = isSettings ? Visibility.Collapsed : Visibility.Visible;

        _headingLabel.Text = dest.Title;
        if (isSettings)
        {
            _subHeadingLabel.Text = "自定义 Lumen 原生体验";
            _ = _store.RefreshSettingsAsync();
            _ = _store.RefreshStatusAsync();
            _ = _store.RefreshServersAsync();
            _settingsView.Reload();
        }
        else
        {
            RebuildFilteredState();
        }
        UpdateSidebar();
    }

    private void RebuildFilteredState()
    {
        UpdateSidebar();
        if (_activeNav.Kind == LumenNavKind.Settings) return;

        var q = _searchQuery.Trim().ToLowerInvariant();
        var list = _store.Items.Where(item => _activeNav.Kind switch
        {
            LumenNavKind.All => true,
            LumenNavKind.Pinned => item.Pinned,
            LumenNavKind.Recent => item.IsToday || item.IsYesterday,
            LumenNavKind.Category => item.DisplayCategory == _activeNav.Category,
            _ => false
        }).ToList();

        if (!string.IsNullOrEmpty(q))
        {
            list = list.Where(item =>
                item.DisplayTitle.ToLowerInvariant().Contains(q, StringComparison.Ordinal)
                || item.EffectiveText.ToLowerInvariant().Contains(q, StringComparison.Ordinal)
                || item.SourceLabel.ToLowerInvariant().Contains(q, StringComparison.Ordinal)
                || item.SafeFiles.Any(f => f.ToLowerInvariant().Contains(q, StringComparison.Ordinal))).ToList();
        }

        switch (_sortOrder)
        {
            case SortOrder.Oldest:
                list.Reverse();
                break;
            case SortOrder.Title:
                list.Sort((a, b) => string.Compare(a.DisplayTitle, b.DisplayTitle, StringComparison.CurrentCultureIgnoreCase));
                break;
        }

        _filteredItems = list;
        var validIds = new HashSet<string>(list.Select(x => x.Id), StringComparer.Ordinal);
        _multiSelectedIds.IntersectWith(validIds);

        if (_selectedId is null || !validIds.Contains(_selectedId))
        {
            _selectedId = list.Count > 0 ? list[0].Id : null;
        }

        _headingLabel.Text = _activeNav.Title;
        _subHeadingLabel.Text = $"{list.Count} 条内容";
        _emptyLabel.Visibility = list.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        _emptyLabel.Text = string.IsNullOrEmpty(q) ? "暂无剪贴板记录" : $"没有匹配“{_searchQuery}”的记录";

        ReloadHistoryPresentation();
        RenderInspector();
        UpdateFooter();
    }

    private void ReloadHistoryPresentation()
    {
        var palette = LumenPalette.Current(_store.Preferences);
        _listScroll.Visibility = _isListMode ? Visibility.Visible : Visibility.Collapsed;
        _galleryScroll.Visibility = _isListMode ? Visibility.Collapsed : Visibility.Visible;
        _itemVisuals.Clear();

        if (_isListMode)
        {
            _listStack.Children.Clear();
            if (_sortOrder == SortOrder.Title)
            {
                if (_filteredItems.Count > 0)
                {
                    _listStack.Children.Add(MakeSectionHeader("按标题", _filteredItems.Count, palette));
                    foreach (var item in _filteredItems) AppendListRow(item, palette);
                }
            }
            else
            {
                var today = _filteredItems.Where(x => x.IsToday).ToList();
                var yesterday = _filteredItems.Where(x => !x.IsToday && x.IsYesterday).ToList();
                var earlier = _filteredItems.Where(x => !x.IsToday && !x.IsYesterday).ToList();
                (string Name, List<LumenClipboardItem> Group)[] sections = _sortOrder == SortOrder.Oldest
                    ? new[] { ("更早", earlier), ("昨天", yesterday), ("今天", today) }
                    : new[] { ("今天", today), ("昨天", yesterday), ("更早", earlier) };

                foreach (var (name, group) in sections)
                {
                    if (group.Count == 0) continue;
                    _listStack.Children.Add(MakeSectionHeader(name, group.Count, palette));
                    foreach (var item in group) AppendListRow(item, palette);
                }
            }
        }
        else
        {
            _galleryWrap.Children.Clear();
            foreach (var item in _filteredItems)
            {
                var captured = item;
                var card = LumenHistoryItemFactory.CreateGalleryCard(
                    captured,
                    IsItemSelected(captured.Id),
                    palette,
                    _ => ChooseItem(captured.Id, Keyboard.Modifiers),
                    () => _ = CopyItemAsync(captured),
                    () => ShowItemContextMenu(captured));
                _itemVisuals[captured.Id] = card;
                _galleryWrap.Children.Add(card);
            }
        }

        UpdateFooter();
    }

    private void AppendListRow(LumenClipboardItem item, LumenPalette palette)
    {
        var captured = item;
        var row = LumenHistoryItemFactory.CreateListRow(
            captured,
            IsItemSelected(captured.Id),
            palette,
            _ => ChooseItem(captured.Id, Keyboard.Modifiers),
            () => _ = CopyItemAsync(captured),
            () => ShowItemContextMenu(captured));
        _itemVisuals[captured.Id] = row;
        _listStack.Children.Add(row);
    }

    private static Grid MakeSectionHeader(string title, int count, LumenPalette palette)
    {
        var g = new Grid { Height = 28, Margin = new Thickness(12, 4, 12, 2) };
        g.Children.Add(new TextBlock
        {
            Text = title,
            FontFamily = LumenFonts.Ui,
            FontSize = 10.5,
            FontWeight = FontWeights.SemiBold,
            Foreground = palette.Muted,
            VerticalAlignment = VerticalAlignment.Center,
            HorizontalAlignment = HorizontalAlignment.Left
        });
        g.Children.Add(new TextBlock
        {
            Text = $"{count} 条",
            FontFamily = LumenFonts.Mono,
            FontSize = 10,
            Foreground = palette.Muted,
            VerticalAlignment = VerticalAlignment.Center,
            HorizontalAlignment = HorizontalAlignment.Right
        });
        return g;
    }

    private void ShowItemContextMenu(LumenClipboardItem item)
    {
        if (!IsItemSelected(item.Id))
        {
            ChooseItem(item.Id, ModifierKeys.None);
        }
        var menu = new ContextMenu();
        var copyItem = new MenuItem { Header = "复制到剪贴板 (↵)" };
        copyItem.Click += (_, _) => _ = CopyItemAsync(item);
        var previewItem = new MenuItem { Header = "完整预览 (Space)" };
        previewItem.Click += (_, _) => OpenPreview(new[] { item }, item.Id);
        var pinItem = new MenuItem { Header = item.Pinned ? "取消固定" : "固定记录" };
        pinItem.Click += (_, _) => _ = TogglePinAsync(item);
        var delItem = new MenuItem { Header = "移除记录 (Delete)" };
        delItem.Click += (_, _) => _ = DeleteSingleAsync(item);

        menu.Items.Add(copyItem);
        menu.Items.Add(previewItem);
        menu.Items.Add(pinItem);
        menu.Items.Add(new Separator());
        menu.Items.Add(delItem);
        menu.IsOpen = true;
    }

    private void RenderInspector()
    {
        var palette = LumenPalette.Current(_store.Preferences);
        if (_multiSelectedIds.Count > 1)
        {
            var batch = _filteredItems.Where(x => _multiSelectedIds.Contains(x.Id)).ToList();
            _inspector.Render(null, batch, palette);
            return;
        }
        var active = _filteredItems.FirstOrDefault(x => string.Equals(x.Id, _selectedId, StringComparison.Ordinal));
        if (active is not null && active.Kind is "text" or "link" && active.Text is null)
        {
            var id = active.Id;
            _ = _store.HydrateItemDetailAsync(id).ContinueWith(_ =>
            {
                LumenWpfHost.RunOnUi(() =>
                {
                    if (string.Equals(_selectedId, id, StringComparison.Ordinal) && _multiSelectedIds.Count <= 1)
                    {
                        var refreshed = _filteredItems.FirstOrDefault(x => string.Equals(x.Id, id, StringComparison.Ordinal));
                        _inspector.Render(refreshed, Array.Empty<LumenClipboardItem>(), LumenPalette.Current(_store.Preferences));
                    }
                });
            }, TaskScheduler.Default);
        }
        _inspector.Render(active, Array.Empty<LumenClipboardItem>(), palette);
    }

    private void UpdateFooter()
    {
        var total = _store.Items.Count;
        var pinned = _store.Items.Count(x => x.Pinned);
        var multi = _multiSelectedIds.Count > 1 ? $" · 已选 {_multiSelectedIds.Count} 条" : string.Empty;
        _footerLeft.Text = $"{total} 条记录 · {pinned} 条固定{multi}";
    }

    // MARK: Selection Logic (Single + Ctrl Toggle + Shift Range)

    private void ChooseItem(string id, ModifierKeys modifiers, bool scrollVisible = false)
    {
        if ((modifiers & ModifierKeys.Shift) != 0 && _selectionAnchorId is not null)
        {
            var a = _filteredItems.FindIndex(x => string.Equals(x.Id, _selectionAnchorId, StringComparison.Ordinal));
            var b = _filteredItems.FindIndex(x => string.Equals(x.Id, id, StringComparison.Ordinal));
            if (a >= 0 && b >= 0)
            {
                var lo = Math.Min(a, b);
                var hi = Math.Max(a, b);
                _multiSelectedIds.Clear();
                for (var i = lo; i <= hi; i++) _multiSelectedIds.Add(_filteredItems[i].Id);
            }
        }
        else if ((modifiers & ModifierKeys.Control) != 0)
        {
            if (_multiSelectedIds.Count == 0 && _selectedId is not null)
            {
                _multiSelectedIds.Add(_selectedId);
            }
            if (!_multiSelectedIds.Remove(id))
            {
                _multiSelectedIds.Add(id);
            }
            _selectionAnchorId = id;
        }
        else
        {
            _multiSelectedIds.Clear();
            _selectionAnchorId = id;
        }

        _selectedId = _multiSelectedIds.Count == 1 ? _multiSelectedIds.First() : id;
        ReloadHistoryPresentation();
        RenderInspector();
        if (scrollVisible && _selectedId is not null && _itemVisuals.TryGetValue(_selectedId, out var fe))
        {
            fe.BringIntoView();
        }
    }

    private bool IsItemSelected(string id)
        => _multiSelectedIds.Count > 0 ? _multiSelectedIds.Contains(id) : string.Equals(_selectedId, id, StringComparison.Ordinal);

    // MARK: Actions

    private async Task CopyItemAsync(LumenClipboardItem item)
    {
        var (ok, err) = await _store.CopyToOsClipboardAsync(item.Id).ConfigureAwait(false);
        LumenWpfHost.RunOnUi(() => _toast.ShowToast(ok ? "已复制到剪贴板" : $"复制失败：{err}"));
    }

    private static void OpenPreview(IReadOnlyList<LumenClipboardItem> items, string? initialId)
    {
        if (items.Count == 0) return;
        LumenPreviewWindow.Shared.Open(items, initialId);
    }

    private async Task TogglePinAsync(LumenClipboardItem item)
    {
        var next = !item.Pinned;
        var (ok, _, _) = await _store.SetPinnedAsync(item.Id, next).ConfigureAwait(false);
        if (ok)
        {
            LumenWpfHost.RunOnUi(() => _toast.ShowToast(next ? "已固定记录" : "已取消固定"));
        }
    }

    private async Task DeleteSingleAsync(LumenClipboardItem item)
    {
        var idx = _filteredItems.FindIndex(x => string.Equals(x.Id, item.Id, StringComparison.Ordinal));
        if (idx >= 0)
        {
            _selectedId = idx + 1 < _filteredItems.Count
                ? _filteredItems[idx + 1].Id
                : (idx > 0 ? _filteredItems[idx - 1].Id : null);
        }
        _multiSelectedIds.Remove(item.Id);
        var (ok, _) = await _store.DeleteItemAsync(item.Id).ConfigureAwait(false);
        if (ok)
        {
            LumenWpfHost.RunOnUi(() => _toast.ShowToast("已移除剪贴板记录", showUndo: _store.CanUndoDelete));
        }
    }

    private async Task BatchPinAsync(IReadOnlyList<LumenClipboardItem> items)
    {
        var ids = items.Select(x => x.Id).ToList();
        await _store.BatchSetPinnedAsync(ids, true).ConfigureAwait(false);
        LumenWpfHost.RunOnUi(() => _toast.ShowToast($"已固定 {ids.Count} 条记录"));
    }

    private async Task BatchDeleteAsync(IReadOnlyList<LumenClipboardItem> items)
    {
        var ids = items.Select(x => x.Id).ToList();
        _multiSelectedIds.Clear();
        var (ok, deleted, _) = await _store.BatchDeleteAsync(ids).ConfigureAwait(false);
        if (ok)
        {
            LumenWpfHost.RunOnUi(() => _toast.ShowToast($"已移除 {deleted} 条记录", showUndo: _store.CanUndoDelete));
        }
    }

    private async Task UndoDeleteAsync()
    {
        var (ok, restored, err) = await _store.UndoLastDeleteAsync().ConfigureAwait(false);
        LumenWpfHost.RunOnUi(() =>
        {
            if (ok && restored is not null)
            {
                _selectedId = restored.Id;
                _toast.ShowToast("已恢复记录", showUndo: _store.CanUndoDelete);
            }
            else if (!string.IsNullOrEmpty(err))
            {
                _toast.ShowToast(err);
            }
        });
    }

    private async Task PatchSettingsAsync(Dictionary<string, object?> patch)
    {
        var (ok, updated, _) = await _store.PatchSettingsAsync(patch).ConfigureAwait(false);
        if (ok && updated is not null)
        {
            LumenWpfHost.RunOnUi(() =>
            {
                QuickOrbitPositionChanged?.Invoke(updated.QuickOrbitPosition);
                _toast.ShowToast("设置已保存");
            });
        }
    }

    private async Task TriggerSyncAsync()
    {
        try
        {
            await _store.Api.TriggerSyncAsync().ConfigureAwait(false);
            LumenWpfHost.RunOnUi(() => _toast.ShowToast("同步已完成"));
        }
        catch (Exception ex)
        {
            LumenWpfHost.RunOnUi(() => _toast.ShowToast($"同步失败：{ex.Message}"));
        }
    }

    private void ConfirmClearAll()
    {
        var ids = _store.Items.Select(x => x.Id).ToList();
        if (ids.Count == 0)
        {
            _toast.ShowToast("当前没有可清空的记录");
            return;
        }
        var res = MessageBox.Show(
            this,
            $"将通过管理接口移除当前列表中的 {ids.Count} 条记录，是否确认清空？",
            "清空全部剪贴板记录",
            MessageBoxButton.YesNo,
            MessageBoxImage.Warning,
            MessageBoxResult.No);
        if (res == MessageBoxResult.Yes)
        {
            _ = ClearAllConfirmedAsync(ids);
        }
    }

    private async Task ClearAllConfirmedAsync(List<string> ids)
    {
        var (ok, count, _) = await _store.BatchDeleteAsync(ids).ConfigureAwait(false);
        if (ok)
        {
            LumenWpfHost.RunOnUi(() => _toast.ShowToast($"已清空 {count} 条记录"));
        }
    }

    private void ToggleSidebar()
    {
        _sidebarHidden = !_sidebarHidden;
        _sidebarCol.Width = _sidebarHidden ? new GridLength(0) : new GridLength(208);
        _sidebarDividerCol.Width = _sidebarHidden ? new GridLength(0) : new GridLength(1);
    }

    private void ToggleInspector()
    {
        _inspectorHidden = !_inspectorHidden;
        _inspectorCol.MinWidth = _inspectorHidden ? 0 : 290;
        _inspectorCol.Width = _inspectorHidden ? new GridLength(0) : new GridLength(370);
        _splitterCol.Width = _inspectorHidden ? new GridLength(0) : new GridLength(5);
    }

    private void ToggleTheme()
    {
        _store.UpdatePreferences(p => p with { Theme = p.Theme == LumenThemeMode.Light ? LumenThemeMode.Dark : LumenThemeMode.Light });
    }

    private void SetListMode(bool listMode)
    {
        _isListMode = listMode;
        UpdateViewToggleStyles(LumenPalette.Current(_store.Preferences));
        ReloadHistoryPresentation();
    }

    private void OpenNewClipDialog()
    {
        var dlg = new LumenNewClipDialog(LumenPalette.Current(_store.Preferences)) { Owner = this };
        if (dlg.ShowDialog() == true && !string.IsNullOrWhiteSpace(dlg.ResultText))
        {
            _ = CreateClipAsync(dlg.ResultText);
        }
    }

    private async Task CreateClipAsync(string text)
    {
        var (ok, created, err) = await _store.CreateTextItemAsync(text).ConfigureAwait(false);
        LumenWpfHost.RunOnUi(() =>
        {
            if (ok && created is not null)
            {
                _selectedId = created.Id;
                if (_activeNav.Kind == LumenNavKind.Settings) SelectDestination(LumenNavDestination.All);
                _toast.ShowToast("已保存新记录");
            }
            else
            {
                _toast.ShowToast($"保存失败：{err}");
            }
        });
    }

    // MARK: Unified Keyboard Contract (§5)

    private void OnWindowPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (_activeNav.Kind == LumenNavKind.Settings) return;
        var mods = Keyboard.Modifiers;
        var ctrl = (mods & ModifierKeys.Control) != 0;
        var alt = (mods & ModifierKeys.Alt) != 0;
        var editingSearch = ReferenceEquals(Keyboard.FocusedElement, _searchBox);

        if (ctrl && !alt && e.Key == Key.F)
        {
            _searchBox.Focus();
            _searchBox.SelectAll();
            e.Handled = true;
            return;
        }
        if (ctrl && !alt && e.Key == Key.N)
        {
            OpenNewClipDialog();
            e.Handled = true;
            return;
        }
        if (editingSearch)
        {
            if (e.Key == Key.Escape)
            {
                Keyboard.ClearFocus();
                _historyHost.Focus();
                e.Handled = true;
            }
            return;
        }
        if (ctrl && !alt && e.Key == Key.A)
        {
            _multiSelectedIds.Clear();
            foreach (var item in _filteredItems) _multiSelectedIds.Add(item.Id);
            ReloadHistoryPresentation();
            RenderInspector();
            e.Handled = true;
            return;
        }
        if (ctrl && !alt && e.Key == Key.Z && _store.CanUndoDelete)
        {
            _ = UndoDeleteAsync();
            e.Handled = true;
            return;
        }
        if (!ctrl && !alt && e.Key == Key.OemQuestion)
        {
            _searchBox.Focus();
            e.Handled = true;
            return;
        }
        if (ctrl || alt) return;

        switch (e.Key)
        {
            case Key.Up:
            case Key.Left:
                StepSelection(-1, mods);
                e.Handled = true;
                break;
            case Key.Down:
            case Key.Right:
                StepSelection(1, mods);
                e.Handled = true;
                break;
            case Key.Home:
                if (_filteredItems.Count > 0) ChooseItem(_filteredItems[0].Id, mods, scrollVisible: true);
                e.Handled = true;
                break;
            case Key.End:
                if (_filteredItems.Count > 0) ChooseItem(_filteredItems[^1].Id, mods, scrollVisible: true);
                e.Handled = true;
                break;
            case Key.Space:
                if (_multiSelectedIds.Count > 1)
                {
                    var batch = _filteredItems.Where(x => _multiSelectedIds.Contains(x.Id)).ToList();
                    OpenPreview(batch, _selectedId);
                }
                else if (_filteredItems.FirstOrDefault(x => string.Equals(x.Id, _selectedId, StringComparison.Ordinal)) is { } item)
                {
                    OpenPreview(new[] { item }, item.Id);
                }
                e.Handled = true;
                break;
            case Key.Enter:
                if (_filteredItems.FirstOrDefault(x => string.Equals(x.Id, _selectedId, StringComparison.Ordinal)) is { } copyTarget)
                {
                    _ = CopyItemAsync(copyTarget);
                    e.Handled = true;
                }
                break;
            case Key.Delete:
            case Key.Back:
                if (_multiSelectedIds.Count > 1)
                {
                    var batch = _filteredItems.Where(x => _multiSelectedIds.Contains(x.Id)).ToList();
                    _ = BatchDeleteAsync(batch);
                }
                else if (_filteredItems.FirstOrDefault(x => string.Equals(x.Id, _selectedId, StringComparison.Ordinal)) is { } delTarget)
                {
                    _ = DeleteSingleAsync(delTarget);
                }
                e.Handled = true;
                break;
            case Key.Escape:
                if (_multiSelectedIds.Count > 0)
                {
                    _multiSelectedIds.Clear();
                    ReloadHistoryPresentation();
                    RenderInspector();
                    e.Handled = true;
                }
                break;
        }
    }

    private void StepSelection(int delta, ModifierKeys mods)
    {
        if (_filteredItems.Count == 0) return;
        var idx = _filteredItems.FindIndex(x => string.Equals(x.Id, _selectedId, StringComparison.Ordinal));
        if (idx < 0) idx = 0;
        var next = Math.Clamp(idx + delta, 0, _filteredItems.Count - 1);
        ChooseItem(_filteredItems[next].Id, mods, scrollVisible: true);
    }
}
