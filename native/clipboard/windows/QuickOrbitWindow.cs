using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shell;

namespace AihLumenClipboard;

/// <summary>
/// Separate native borderless non-activating topmost WPF edge rail Window (zero WebView/HTML).
/// Configured with WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW and WM_MOUSEACTIVATE -> MA_NOACTIVATE so
/// it never steals OS foreground focus, spans the continuous multi-monitor bottom band (or left/right edge)
/// with Per-Monitor V2 DPI physical pixel placement, DWM Acrylic backdrop, interruptible enter/exit
/// transitions, concurrent card removal + reflow, and foreground focus restoration.
/// </summary>
public sealed class QuickOrbitWindow : Window
{
    private const double CardGap = 13.0;
    private const double RailPaddingX = 24.0;
    private const double RailPaddingY = 20.0;

    private readonly LumenClipboardStore _store = LumenClipboardStore.Shared;
    private readonly Grid _rootGrid = new();
    private readonly LumenOrbitBackdropControl _backdrop = new();
    private readonly ScrollViewer _railScroll = new();
    private readonly Canvas _railCanvas = new();
    private readonly TextBlock _emptyLabel = new();
    private readonly LumenToastBanner _toast = new();
    private readonly LumenOrbitInputHook _inputHook = new();

    private readonly List<LumenOrbitCardControl> _cards = new();
    private readonly HashSet<string> _removingIds = new(StringComparer.Ordinal);
    private string? _selectedId;

    private bool _enabled;
    private string _position = "bottom";
    private bool _isShowing;
    private bool _allowRealClose;
    private int _transitionToken;
    private IntPtr _previousForegroundHwnd = IntPtr.Zero;
    private Guid _observerId;

    private double _cardWidth = 196.0;
    private double _cardHeight = 216.0;
    private double _lastRailWidthDip = 1280.0;
    private double _lastRailHeightDip = 264.0;

    // Interruptible window-frame transition state
    private enum FrameAnimMode { None, Entering, Exiting, Repositioning }
    private FrameAnimMode _frameAnimMode = FrameAnimMode.None;
    private readonly Stopwatch _animClock = Stopwatch.StartNew();
    private double _animStartMs;
    private double _animDurationMs;
    private LumenWin32.RECT _animFromPx;
    private LumenWin32.RECT _animToPx;
    private double _animFromOpacity;
    private double _animToOpacity;
    private int _animToken;
    private IntPtr _pendingRestoreHwnd = IntPtr.Zero;
    private bool _frameLoopAttached;

    // Horizontal rail drag-pan state
    private bool _draggingRail;
    private bool _didDragPan;
    private Point _dragStartViewport;
    private double _dragStartScrollX;
    private LumenOrbitCardControl? _mouseDownCard;

    public event Action? OpenWorkspaceRequested;

    public QuickOrbitWindow()
    {
        LumenWpfHost.EnsureInitialized();

        Title = "Lumen Quick Orbit";
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        Topmost = true;
        ShowInTaskbar = false;
        ShowActivated = false;
        Focusable = false;
        WindowStartupLocation = WindowStartupLocation.Manual;
        Background = Brushes.Transparent;

        var chrome = new WindowChrome
        {
            CaptionHeight = 0,
            CornerRadius = new CornerRadius(0),
            GlassFrameThickness = new Thickness(-1),
            ResizeBorderThickness = new Thickness(0),
            UseAeroCaptionButtons = false
        };
        WindowChrome.SetWindowChrome(this, chrome);
        LumenWpfHost.AttachWindowInterop(this);

        BuildContent();
        ApplyTheme();

        SourceInitialized += OnSourceInitialized;
        PreviewKeyDown += OnLocalPreviewKeyDown;
        Closing += (_, e) =>
        {
            if (!_allowRealClose)
            {
                e.Cancel = true;
                HideOrbit(restoreFocus: true);
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

    public bool IsOrbitVisible => _isShowing && IsVisible;

    public void Configure(string? origin, string? managementKey, bool enabled, string? position)
    {
        var normalized = NormalizePosition(position);
        var posChanged = !string.Equals(normalized, _position, StringComparison.Ordinal);
        _enabled = enabled;
        _position = normalized;
        _backdrop.EdgePosition = normalized;

        if (!string.IsNullOrWhiteSpace(origin) || !string.IsNullOrWhiteSpace(managementKey))
        {
            _store.Configure(origin, managementKey);
        }
        else if (enabled)
        {
            _store.EnsureConfiguredFromLocalConfig();
        }

        if (!enabled)
        {
            HideOrbit(restoreFocus: false);
            return;
        }
        if (posChanged && _isShowing)
        {
            RepositionVisibleInterruptibly();
        }
    }

    public void Toggle()
    {
        if (_isShowing) HideOrbit(restoreFocus: true);
        else ShowOrbit();
    }

    public void ShowOrbit()
    {
        _store.EnsureConfiguredFromLocalConfig();
        if (!IsAvailable) return;

        var token = ++_transitionToken;
        var wasVisible = IsVisible;
        _isShowing = true;

        var myHwnd = new WindowInteropHelper(this).Handle;
        if (!wasVisible)
        {
            var fg = LumenWin32.GetCurrentForegroundWindow();
            if (fg != IntPtr.Zero && fg != myHwnd)
            {
                _previousForegroundHwnd = fg;
            }
        }

        var (targetPx, scale) = ComputeTargetBoundsPx();
        var startPx = wasVisible && myHwnd != IntPtr.Zero && LumenWin32.TryGetWindowBoundsPx(myHwnd, out var liveRect)
            ? liveRect
            : ComputeOffscreenBoundsPx(targetPx);

        _lastRailWidthDip = Math.Max(220, targetPx.Width / scale);
        _lastRailHeightDip = Math.Max(180, targetPx.Height / scale);
        UpdateRailMetrics(_lastRailWidthDip, _lastRailHeightDip);
        SyncCardsFromStore(animatedReflow: false);
        _ = _store.RefreshItemsAsync();

        if (!wasVisible)
        {
            _rootGrid.Opacity = LumenMotion.IsEnabled ? 0.0 : 1.0;
            // Pre-position before showing to avoid flash at (0,0).
            Left = startPx.Left / scale;
            Top = startPx.Top / scale;
            Width = Math.Max(1, startPx.Width / scale);
            Height = Math.Max(1, startPx.Height / scale);
            Show();
        }

        myHwnd = new WindowInteropHelper(this).Handle;
        if (myHwnd != IntPtr.Zero)
        {
            LumenWin32.ApplyNonActivatingToolWindowStyle(myHwnd);
            ApplyDwmBackdrop();
            LumenWin32.SetBoundsPhysicalPx(myHwnd, startPx.Left, startPx.Top, startPx.Width, startPx.Height, topmost: true, noActivate: true);
        }

        _backdrop.SetActive(true);
        InstallInputHook();

        if (LumenMotion.IsEnabled)
        {
            StartInterruptibleFrameTransition(
                FrameAnimMode.Entering,
                token,
                startPx,
                targetPx,
                _rootGrid.Opacity,
                1.0,
                LumenMotion.EnterDuration.TotalMilliseconds,
                IntPtr.Zero);
            if (!wasVisible)
            {
                AnimateCardsArrivalStagger();
            }
        }
        else
        {
            StopFrameTransition();
            if (myHwnd != IntPtr.Zero)
            {
                LumenWin32.SetBoundsPhysicalPx(myHwnd, targetPx.Left, targetPx.Top, targetPx.Width, targetPx.Height, topmost: true, noActivate: true);
            }
            _rootGrid.Opacity = 1.0;
        }
    }

    public void HideOrbit(bool restoreFocus = true)
    {
        if (!_isShowing && !IsVisible) return;
        var token = ++_transitionToken;
        _isShowing = false;
        _inputHook.Uninstall();
        _backdrop.SetActive(false);

        var restoreHwnd = restoreFocus ? _previousForegroundHwnd : IntPtr.Zero;
        _previousForegroundHwnd = IntPtr.Zero;

        var myHwnd = new WindowInteropHelper(this).Handle;
        var (targetPx, _) = ComputeTargetBoundsPx();
        var endPx = ComputeOffscreenBoundsPx(targetPx);
        var startPx = myHwnd != IntPtr.Zero && LumenWin32.TryGetWindowBoundsPx(myHwnd, out var liveRect)
            ? liveRect
            : targetPx;

        if (LumenMotion.IsEnabled && IsVisible)
        {
            StartInterruptibleFrameTransition(
                FrameAnimMode.Exiting,
                token,
                startPx,
                endPx,
                _rootGrid.Opacity,
                0.0,
                LumenMotion.ExitDuration.TotalMilliseconds,
                restoreHwnd);
        }
        else
        {
            StopFrameTransition();
            Hide();
            _rootGrid.Opacity = 1.0;
            if (restoreHwnd != IntPtr.Zero)
            {
                LumenWin32.RestoreForegroundWindow(restoreHwnd);
            }
        }
    }

    public void Shutdown()
    {
        _store.RemoveObserver(_observerId);
        _inputHook.Dispose();
        StopFrameTransition();
        _backdrop.SetActive(false);
        _allowRealClose = true;
        Close();
    }

    // MARK: Win32 Hooks & DWM Acrylic

    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        var hwnd = new WindowInteropHelper(this).Handle;
        if (hwnd == IntPtr.Zero) return;
        LumenWin32.ApplyNonActivatingToolWindowStyle(hwnd);
        ApplyDwmBackdrop();

        if (HwndSource.FromHwnd(hwnd) is { } source)
        {
            source.AddHook(WndProc);
        }
    }

    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        switch (msg)
        {
            case LumenWin32.WM_MOUSEACTIVATE:
                // Never activate Orbit on mouse click so the foreground editor keeps focus.
                handled = true;
                return new IntPtr(LumenWin32.MA_NOACTIVATE);
            case LumenWin32.WM_NCCALCSIZE:
                // Remove non-client border so the rail sits 100% flush on the screen edge.
                handled = true;
                return IntPtr.Zero;
            case LumenWin32.WM_DISPLAYCHANGE:
            case LumenWin32.WM_DPICHANGED:
                if (_isShowing)
                {
                    LumenWpfHost.RunOnUi(RepositionVisibleInterruptibly);
                }
                break;
        }
        return IntPtr.Zero;
    }

    private void ApplyDwmBackdrop()
    {
        var hwnd = new WindowInteropHelper(this).Handle;
        if (hwnd == IntPtr.Zero) return;
        var palette = LumenPalette.Current(_store.Preferences);
        _ = LumenWin32.ApplyDwmBackdrop(
            hwnd,
            palette.IsDark,
            LumenWin32.DWMSBT_TRANSIENTWINDOW, // Native Windows 11 Acrylic
            LumenWin32.DWMWCP_DONOTROUND,      // Flush screen-edge rail
            extendGlassFrame: true,
            allowWin10AcrylicFallback: true);
    }

    // MARK: Multi-Monitor Continuous Bottom Band & Edge Geometry

    private static string NormalizePosition(string? raw) => (raw ?? string.Empty).Trim().ToLowerInvariant() switch
    {
        "left" => "left",
        "right" => "right",
        _ => "bottom"
    };

    private (LumenWin32.RECT BoundsPx, double Scale) ComputeTargetBoundsPx()
    {
        var monitors = LumenWin32.EnumerateMonitors();
        var active = LumenWin32.GetActiveMonitor(monitors);
        var scale = active.ScaleX;

        if (_position is "left" or "right")
        {
            var work = active.WorkAreaPx;
            var workWidthDip = work.Width / scale;
            var widthDip = Math.Clamp(Math.Round(workWidthDip * 0.19), 236.0, 278.0);
            var widthPx = (int)Math.Round(widthDip * scale);
            var xPx = _position == "left" ? work.Left : work.Right - widthPx;
            return (new LumenWin32.RECT
            {
                Left = xPx,
                Top = work.Top,
                Right = xPx + widthPx,
                Bottom = work.Bottom
            }, scale);
        }

        // Bottom continuous rail: compute the lowest horizontal display band across all monitors.
        var maxBottomPx = monitors.Max(m => m.BoundsPx.Bottom);
        var bottomRow = monitors
            .Where(m => Math.Abs(m.BoundsPx.Bottom - maxBottomPx) <= (int)Math.Round(100 * m.ScaleY))
            .ToList();
        if (bottomRow.Count == 0) bottomRow.Add(active);

        var unionLeftPx = bottomRow.Min(m => m.WorkAreaPx.Left);
        var unionRightPx = bottomRow.Max(m => m.WorkAreaPx.Right);
        var bottomEdgePx = bottomRow.Min(m => m.WorkAreaPx.Bottom);
        var minScreenHeightDip = bottomRow.Min(m => m.BoundsPx.Height / m.ScaleY);
        var heightDip = Math.Clamp(Math.Round(minScreenHeightDip * 0.29), 232.0, 292.0);
        var anchorScale = bottomRow.Min(m => m.ScaleY);
        var heightPx = (int)Math.Round(heightDip * anchorScale);

        return (new LumenWin32.RECT
        {
            Left = unionLeftPx,
            Top = bottomEdgePx - heightPx,
            Right = unionRightPx,
            Bottom = bottomEdgePx
        }, anchorScale);
    }

    private LumenWin32.RECT ComputeOffscreenBoundsPx(LumenWin32.RECT target)
    {
        const int margin = 28;
        return _position switch
        {
            "left" => new LumenWin32.RECT
            {
                Left = target.Left - target.Width - margin,
                Top = target.Top,
                Right = target.Left - margin,
                Bottom = target.Bottom
            },
            "right" => new LumenWin32.RECT
            {
                Left = target.Right + margin,
                Top = target.Top,
                Right = target.Right + target.Width + margin,
                Bottom = target.Bottom
            },
            _ => new LumenWin32.RECT
            {
                Left = target.Left,
                Top = target.Bottom + margin,
                Right = target.Right,
                Bottom = target.Bottom + target.Height + margin
            }
        };
    }

    private void RepositionVisibleInterruptibly()
    {
        var token = ++_transitionToken;
        var myHwnd = new WindowInteropHelper(this).Handle;
        var (targetPx, scale) = ComputeTargetBoundsPx();
        var startPx = myHwnd != IntPtr.Zero && LumenWin32.TryGetWindowBoundsPx(myHwnd, out var live)
            ? live
            : targetPx;

        _lastRailWidthDip = Math.Max(220, targetPx.Width / scale);
        _lastRailHeightDip = Math.Max(180, targetPx.Height / scale);
        UpdateRailMetrics(_lastRailWidthDip, _lastRailHeightDip);
        LayoutCards(animated: true);

        if (LumenMotion.IsEnabled)
        {
            StartInterruptibleFrameTransition(
                FrameAnimMode.Repositioning,
                token,
                startPx,
                targetPx,
                _rootGrid.Opacity,
                1.0,
                340.0,
                IntPtr.Zero);
        }
        else if (myHwnd != IntPtr.Zero)
        {
            LumenWin32.SetBoundsPhysicalPx(myHwnd, targetPx.Left, targetPx.Top, targetPx.Width, targetPx.Height, topmost: true, noActivate: true);
        }
    }

    private void StartInterruptibleFrameTransition(
        FrameAnimMode mode,
        int token,
        LumenWin32.RECT fromPx,
        LumenWin32.RECT toPx,
        double fromOpacity,
        double toOpacity,
        double durationMs,
        IntPtr restoreOnExitHwnd)
    {
        _frameAnimMode = mode;
        _animToken = token;
        _animFromPx = fromPx;
        _animToPx = toPx;
        _animFromOpacity = fromOpacity;
        _animToOpacity = toOpacity;
        _animDurationMs = Math.Max(10.0, durationMs);
        _animStartMs = _animClock.Elapsed.TotalMilliseconds;
        _pendingRestoreHwnd = restoreOnExitHwnd;

        if (!_frameLoopAttached)
        {
            CompositionTarget.Rendering += OnFrameAnimationTick;
            _frameLoopAttached = true;
        }
    }

    private void StopFrameTransition()
    {
        _frameAnimMode = FrameAnimMode.None;
        if (_frameLoopAttached)
        {
            CompositionTarget.Rendering -= OnFrameAnimationTick;
            _frameLoopAttached = false;
        }
    }

    private void OnFrameAnimationTick(object? sender, EventArgs e)
    {
        if (_frameAnimMode == FrameAnimMode.None || _animToken != _transitionToken)
        {
            StopFrameTransition();
            return;
        }

        var t = Math.Clamp((_animClock.Elapsed.TotalMilliseconds - _animStartMs) / _animDurationMs, 0.0, 1.0);
        var eased = _frameAnimMode == FrameAnimMode.Exiting
            ? LumenMotion.EvalCubicBezier(t, 0.40, 0.0, 0.50, 1.0)
            : LumenMotion.EvalCubicBezier(t, 0.19, 1.0, 0.25, 1.0);

        int Lerp(int a, int b) => (int)Math.Round(a + (b - a) * eased);
        var x = Lerp(_animFromPx.Left, _animToPx.Left);
        var y = Lerp(_animFromPx.Top, _animToPx.Top);
        var w = Lerp(_animFromPx.Width, _animToPx.Width);
        var h = Lerp(_animFromPx.Height, _animToPx.Height);

        var hwnd = new WindowInteropHelper(this).Handle;
        if (hwnd != IntPtr.Zero)
        {
            LumenWin32.SetBoundsPhysicalPx(hwnd, x, y, w, h, topmost: true, noActivate: true);
        }
        _rootGrid.Opacity = Math.Clamp(_animFromOpacity + (_animToOpacity - _animFromOpacity) * eased, 0.0, 1.0);

        if (t >= 1.0)
        {
            var finishedMode = _frameAnimMode;
            var restore = _pendingRestoreHwnd;
            _pendingRestoreHwnd = IntPtr.Zero;
            StopFrameTransition();
            if (finishedMode == FrameAnimMode.Exiting && _animToken == _transitionToken)
            {
                Hide();
                _rootGrid.Opacity = 1.0;
                if (restore != IntPtr.Zero)
                {
                    LumenWin32.RestoreForegroundWindow(restore);
                }
            }
            else if (_animToken == _transitionToken)
            {
                _rootGrid.Opacity = 1.0;
            }
        }
    }

    // MARK: UI Content & Rail Layout

    private void BuildContent()
    {
        _railScroll.HorizontalScrollBarVisibility = ScrollBarVisibility.Hidden;
        _railScroll.VerticalScrollBarVisibility = ScrollBarVisibility.Hidden;
        _railScroll.Background = Brushes.Transparent;
        _railScroll.Content = _railCanvas;
        _railScroll.PreviewMouseWheel += OnRailMouseWheel;
        _railScroll.PreviewMouseMove += OnRailMouseMove;
        _railScroll.PreviewMouseLeftButtonUp += OnRailMouseLeftButtonUp;

        _emptyLabel.Text = "暂无剪贴板记录";
        _emptyLabel.FontFamily = LumenFonts.Ui;
        _emptyLabel.FontSize = 13.5;
        _emptyLabel.FontWeight = FontWeights.Medium;
        _emptyLabel.HorizontalAlignment = HorizontalAlignment.Center;
        _emptyLabel.VerticalAlignment = VerticalAlignment.Center;
        _emptyLabel.Visibility = Visibility.Collapsed;

        _toast.Margin = new Thickness(0, 10, 0, 0);
        _toast.UndoRequested += () => _ = UndoLastDeleteAsync();
        Panel.SetZIndex(_toast, 50);

        _rootGrid.Children.Add(_backdrop);
        _rootGrid.Children.Add(_railScroll);
        _rootGrid.Children.Add(_emptyLabel);
        _rootGrid.Children.Add(_toast);
        _rootGrid.MouseMove += (_, e) => _backdrop.UpdatePointer(e.GetPosition(_rootGrid));

        Content = _rootGrid;
    }

    private void HandleStoreEvent(LumenStoreEvent ev)
    {
        switch (ev.Kind)
        {
            case LumenStoreEventKind.ItemsUpdated:
                if (_isShowing) SyncCardsFromStore(animatedReflow: true);
                break;
            case LumenStoreEventKind.PreferencesUpdated:
                ApplyTheme();
                break;
            case LumenStoreEventKind.SettingsUpdated:
                var nextPos = NormalizePosition(_store.Settings.QuickOrbitPosition);
                if (!string.Equals(nextPos, _position, StringComparison.Ordinal))
                {
                    _position = nextPos;
                    _backdrop.EdgePosition = nextPos;
                    if (_isShowing) RepositionVisibleInterruptibly();
                }
                break;
        }
    }

    private void ApplyTheme()
    {
        var palette = LumenPalette.Current(_store.Preferences);
        _backdrop.ApplyTheme(palette, _store.Preferences);
        _emptyLabel.Foreground = palette.IsDark
            ? LumenPalette.Brush(LumenPalette.Rgba(0.90, 0.94, 1.0, 0.85))
            : palette.Ink;
        foreach (var card in _cards)
        {
            card.ApplyTheme(palette, _store.Preferences.Glow);
        }
        ApplyDwmBackdrop();
    }

    private void UpdateRailMetrics(double railW, double railH)
    {
        var horizontal = _position == "bottom";
        if (horizontal)
        {
            _cardHeight = Math.Clamp(railH - RailPaddingY * 2 - 8, 168, 232);
            _cardWidth = Math.Clamp(Math.Round(railW * 0.14), 172, 214);
        }
        else
        {
            _cardWidth = Math.Max(196, railW - 28);
            _cardHeight = 186;
        }
    }

    private void SyncCardsFromStore(bool animatedReflow)
    {
        var palette = LumenPalette.Current(_store.Preferences);
        var glow = _store.Preferences.Glow;
        var activeItems = _store.Items.Where(x => !_removingIds.Contains(x.Id)).ToList();

        var existing = new Dictionary<string, LumenOrbitCardControl>(StringComparer.Ordinal);
        foreach (var c in _cards) existing[c.Item.Id] = c;

        var nextCards = new List<LumenOrbitCardControl>(activeItems.Count);
        for (var idx = 0; idx < activeItems.Count; idx++)
        {
            var item = activeItems[idx];
            if (existing.TryGetValue(item.Id, out var reused) && reused.Item.ContentEquals(item))
            {
                existing.Remove(item.Id);
                reused.QuickKeyIndex = idx < 9 ? idx : null;
                reused.ApplyTheme(palette, glow);
                nextCards.Add(reused);
            }
            else
            {
                if (existing.Remove(item.Id, out var stale))
                {
                    stale.MarkRemoved();
                    _railCanvas.Children.Remove(stale);
                }
                var card = new LumenOrbitCardControl(item, idx < 9 ? idx : null, palette, glow);
                card.SelectAndPasteRequested += id => _ = PasteAndDismissAsync(id);
                card.HoverFocusRequested += id => SetFocused(id, scroll: false);
                card.RemoveRequested += RemoveCardAnimated;
                card.ContextMenuRequested += PresentContextMenu;
                card.PreviewMouseLeftButtonDown += OnCardMouseLeftButtonDown;
                _railCanvas.Children.Add(card);
                nextCards.Add(card);
            }
        }

        foreach (var obsolete in existing.Values)
        {
            if (!_removingIds.Contains(obsolete.Item.Id))
            {
                obsolete.MarkRemoved();
                _railCanvas.Children.Remove(obsolete);
            }
        }

        _cards.Clear();
        _cards.AddRange(nextCards);
        _emptyLabel.Visibility = _cards.Count == 0 ? Visibility.Visible : Visibility.Collapsed;

        if (_selectedId is null || !_cards.Any(c => string.Equals(c.Item.Id, _selectedId, StringComparison.Ordinal)))
        {
            _selectedId = _cards.Count > 0 ? _cards[0].Item.Id : null;
        }

        LayoutCards(animated: animatedReflow);
        UpdateCardVisualStates();
    }

    private Rect CardRectAt(int index)
    {
        if (_position == "bottom")
        {
            var x = RailPaddingX + index * (_cardWidth + CardGap);
            var y = RailPaddingY + 6;
            return new Rect(x, y, _cardWidth, _cardHeight);
        }
        var vx = Math.Max(12, (_lastRailWidthDip - _cardWidth) * 0.5);
        var vy = 16 + index * (_cardHeight + CardGap);
        return new Rect(vx, vy, _cardWidth, _cardHeight);
    }

    private void LayoutCards(bool animated)
    {
        var horizontal = _position == "bottom";
        if (horizontal)
        {
            var totalW = RailPaddingX * 2 + _cards.Count * _cardWidth + Math.Max(0, _cards.Count - 1) * CardGap;
            _railCanvas.Width = Math.Max(_lastRailWidthDip, totalW);
            _railCanvas.Height = Math.Max(_lastRailHeightDip, _cardHeight + RailPaddingY * 2 + 12);
        }
        else
        {
            var totalH = 32 + _cards.Count * _cardHeight + Math.Max(0, _cards.Count - 1) * CardGap;
            _railCanvas.Width = Math.Max(_lastRailWidthDip, _cardWidth + 24);
            _railCanvas.Height = Math.Max(_lastRailHeightDip, totalH);
        }

        for (var i = 0; i < _cards.Count; i++)
        {
            var card = _cards[i];
            card.QuickKeyIndex = i < 9 ? i : null;
            var rect = CardRectAt(i);
            card.Width = rect.Width;
            card.Height = rect.Height;

            var prevX = Canvas.GetLeft(card);
            var prevY = Canvas.GetTop(card);
            var hasPrev = !double.IsNaN(prevX) && !double.IsNaN(prevY);

            if (animated && LumenMotion.IsEnabled && hasPrev && (Math.Abs(prevX - rect.X) > 0.5 || Math.Abs(prevY - rect.Y) > 0.5))
            {
                var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
                card.BeginAnimation(Canvas.LeftProperty, new DoubleAnimation(rect.X, LumenMotion.RemoveDuration) { EasingFunction = ease }, HandoffBehavior.SnapshotAndReplace);
                card.BeginAnimation(Canvas.TopProperty, new DoubleAnimation(rect.Y, LumenMotion.RemoveDuration) { EasingFunction = ease }, HandoffBehavior.SnapshotAndReplace);
            }
            else
            {
                card.BeginAnimation(Canvas.LeftProperty, null);
                card.BeginAnimation(Canvas.TopProperty, null);
                Canvas.SetLeft(card, rect.X);
                Canvas.SetTop(card, rect.Y);
            }
        }
    }

    private void AnimateCardsArrivalStagger()
    {
        var limit = Math.Min(_cards.Count, 12);
        for (var i = 0; i < limit; i++)
        {
            _cards[i].PlayArrivalStagger(i);
        }
    }

    private void SetFocused(string id, bool scroll)
    {
        _selectedId = id;
        UpdateCardVisualStates();
        if (scroll)
        {
            var idx = _cards.FindIndex(c => string.Equals(c.Item.Id, id, StringComparison.Ordinal));
            if (idx >= 0) ScrollToCard(CardRectAt(idx));
        }
    }

    private void ScrollToCard(Rect rect)
    {
        if (_position == "bottom")
        {
            var left = _railScroll.HorizontalOffset;
            var viewW = _railScroll.ViewportWidth > 0 ? _railScroll.ViewportWidth : _lastRailWidthDip;
            const double pad = 24;
            if (rect.Left < left + pad)
            {
                _railScroll.ScrollToHorizontalOffset(Math.Max(0, rect.Left - pad));
            }
            else if (rect.Right > left + viewW - pad)
            {
                _railScroll.ScrollToHorizontalOffset(Math.Max(0, rect.Right - viewW + pad));
            }
        }
        else
        {
            var top = _railScroll.VerticalOffset;
            var viewH = _railScroll.ViewportHeight > 0 ? _railScroll.ViewportHeight : _lastRailHeightDip;
            const double pad = 20;
            if (rect.Top < top + pad)
            {
                _railScroll.ScrollToVerticalOffset(Math.Max(0, rect.Top - pad));
            }
            else if (rect.Bottom > top + viewH - pad)
            {
                _railScroll.ScrollToVerticalOffset(Math.Max(0, rect.Bottom - viewH + pad));
            }
        }
    }

    private void UpdateCardVisualStates()
    {
        var selIdx = _cards.FindIndex(c => string.Equals(c.Item.Id, _selectedId, StringComparison.Ordinal));
        for (var i = 0; i < _cards.Count; i++)
        {
            if (i == selIdx) _cards[i].VisualState = LumenOrbitCardState.Selected;
            else if (selIdx >= 0 && Math.Abs(i - selIdx) == 1) _cards[i].VisualState = LumenOrbitCardState.Near;
            else _cards[i].VisualState = LumenOrbitCardState.Idle;
        }
    }

    // MARK: Card Removal, Reflow & Paste

    private void RemoveCardAnimated(string id)
    {
        if (_removingIds.Contains(id)) return;
        var idx = _cards.FindIndex(c => string.Equals(c.Item.Id, id, StringComparison.Ordinal));
        if (idx < 0) return;

        var card = _cards[idx];
        _removingIds.Add(id);
        _cards.RemoveAt(idx);

        if (string.Equals(_selectedId, id, StringComparison.Ordinal))
        {
            _selectedId = idx < _cards.Count ? _cards[idx].Item.Id : (_cards.Count > 0 ? _cards[^1].Item.Id : null);
        }

        // Release-light burst in backdrop coordinates
        try
        {
            var topLeft = card.TranslatePoint(new Point(0, 0), _rootGrid);
            _backdrop.SpawnReleaseLightBurst(new Rect(topLeft, new Size(card.ActualWidth > 0 ? card.ActualWidth : _cardWidth, card.ActualHeight > 0 ? card.ActualHeight : _cardHeight)));
        }
        catch { }

        card.IsHitTestVisible = false;
        card.PlayRemoveAnimation(() =>
        {
            card.MarkRemoved();
            _railCanvas.Children.Remove(card);
            _removingIds.Remove(id);
        });

        _emptyLabel.Visibility = _cards.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        LayoutCards(animated: true);
        UpdateCardVisualStates();

        _ = DeleteCardOnServerAsync(id);
    }

    private async Task DeleteCardOnServerAsync(string id)
    {
        var (ok, _) = await _store.DeleteItemAsync(id).ConfigureAwait(false);
        if (ok)
        {
            LumenWpfHost.RunOnUi(() => _toast.ShowToast("已移除剪贴板记录", showUndo: _store.CanUndoDelete));
        }
    }

    private async Task UndoLastDeleteAsync()
    {
        var (ok, restored, err) = await _store.UndoLastDeleteAsync().ConfigureAwait(false);
        LumenWpfHost.RunOnUi(() =>
        {
            if (ok && restored is not null)
            {
                _selectedId = restored.Id;
                SyncCardsFromStore(animatedReflow: true);
                _toast.ShowToast("已恢复记录", showUndo: _store.CanUndoDelete);
            }
            else if (!string.IsNullOrEmpty(err))
            {
                _toast.ShowToast(err);
            }
        });
    }

    private async Task PasteAndDismissAsync(string id)
    {
        var card = _cards.FirstOrDefault(c => string.Equals(c.Item.Id, id, StringComparison.Ordinal));
        card?.PlayPasteLiftAnimation();

        var (ok, err) = await _store.CopyToOsClipboardAsync(id).ConfigureAwait(false);
        LumenWpfHost.RunOnUi(() =>
        {
            if (ok)
            {
                HideOrbit(restoreFocus: true);
            }
            else
            {
                _toast.ShowToast($"复制失败：{err}");
            }
        });
    }

    // MARK: Rail Wheel, Drag-Pan & Context Menu

    private void OnRailMouseWheel(object sender, MouseWheelEventArgs e)
    {
        if (_position == "bottom")
        {
            var next = _railScroll.HorizontalOffset - e.Delta * 0.9;
            _railScroll.ScrollToHorizontalOffset(Math.Clamp(next, 0, Math.Max(0, _railScroll.ScrollableWidth)));
            e.Handled = true;
        }
    }

    private void OnCardMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (sender is not LumenOrbitCardControl card) return;
        // Let the remove button handle its own click without starting drag.
        if (e.OriginalSource is DependencyObject dep && IsInsideButton(dep)) return;

        _mouseDownCard = card;
        _draggingRail = _position == "bottom";
        _didDragPan = false;
        _dragStartViewport = e.GetPosition(_railScroll);
        _dragStartScrollX = _railScroll.HorizontalOffset;
    }

    private void OnRailMouseMove(object sender, MouseEventArgs e)
    {
        if (!_draggingRail || e.LeftButton != MouseButtonState.Pressed) return;
        var cur = e.GetPosition(_railScroll);
        var dx = cur.X - _dragStartViewport.X;
        if (Math.Abs(dx) > 7)
        {
            _didDragPan = true;
            _railScroll.ScrollToHorizontalOffset(Math.Clamp(_dragStartScrollX - dx, 0, Math.Max(0, _railScroll.ScrollableWidth)));
        }
    }

    private void OnRailMouseLeftButtonUp(object sender, MouseButtonEventArgs e)
    {
        var wasDrag = _didDragPan;
        var card = _mouseDownCard;
        _draggingRail = false;
        _didDragPan = false;
        _mouseDownCard = null;
        if (!wasDrag && card is not null)
        {
            card.TriggerPasteClick();
        }
    }

    private static bool IsInsideButton(DependencyObject source)
    {
        var cur = source;
        while (cur is not null)
        {
            if (cur is Button) return true;
            cur = VisualTreeHelper.GetParent(cur);
        }
        return false;
    }

    private void PresentContextMenu(string id)
    {
        SetFocused(id, scroll: false);
        var item = _store.Items.FirstOrDefault(x => string.Equals(x.Id, id, StringComparison.Ordinal));
        var menu = new ContextMenu();

        var paste = new MenuItem { Header = "复制到剪贴板 (↵)" };
        paste.Click += (_, _) => _ = PasteAndDismissAsync(id);
        var peek = new MenuItem { Header = "完整预览 (Space)" };
        peek.Click += (_, _) =>
        {
            if (item is not null) LumenPreviewWindow.Shared.Open(new[] { item }, item.Id);
        };
        var pin = new MenuItem { Header = item?.Pinned == true ? "取消固定" : "固定记录" };
        pin.Click += (_, _) => _ = _store.TogglePinAsync(id);
        var openApp = new MenuItem { Header = "在 Lumen 资料库中打开" };
        openApp.Click += (_, _) =>
        {
            HideOrbit(restoreFocus: false);
            OpenWorkspaceRequested?.Invoke();
        };
        var remove = new MenuItem { Header = "移除记录 (Delete)" };
        remove.Click += (_, _) => RemoveCardAnimated(id);

        menu.Items.Add(paste);
        menu.Items.Add(peek);
        menu.Items.Add(pin);
        menu.Items.Add(openApp);
        menu.Items.Add(new Separator());
        menu.Items.Add(remove);
        menu.IsOpen = true;
    }

    // MARK: Non-Activating Global Input Hook & Unified Keyboard Contract (§5)

    private void InstallInputHook()
    {
        _inputHook.Install(HandleGlobalVirtualKey, HandleGlobalMouseDown);
    }

    private void HandleGlobalMouseDown(int screenX, int screenY)
    {
        if (!_isShowing || !IsVisible) return;
        if (LumenPreviewWindow.Shared.IsPreviewVisible) return;
        var myHwnd = new WindowInteropHelper(this).Handle;
        if (myHwnd != IntPtr.Zero && LumenWin32.TryGetWindowBoundsPx(myHwnd, out var rect))
        {
            if (!rect.Contains(screenX, screenY))
            {
                HideOrbit(restoreFocus: false);
            }
        }
    }

    private bool HandleGlobalVirtualKey(int vkCode, bool ctrl, bool alt, bool shift)
    {
        if (!_isShowing || !IsVisible) return false;
        if (LumenPreviewWindow.Shared.IsPreviewVisible) return false;
        if (alt) return false;

        // Ctrl+Z undo
        if (ctrl && vkCode == 0x5A) // 'Z'
        {
            if (_store.CanUndoDelete)
            {
                LumenWpfHost.RunOnUi(() => _ = UndoLastDeleteAsync());
                return true;
            }
            return false;
        }
        if (ctrl) return false;

        switch (vkCode)
        {
            case 0x1B: // VK_ESCAPE
                LumenWpfHost.RunOnUi(() => HideOrbit(restoreFocus: true));
                return true;
            case 0x25: // VK_LEFT
            case 0x26: // VK_UP
                LumenWpfHost.RunOnUi(() => StepFocus(-1));
                return true;
            case 0x27: // VK_RIGHT
            case 0x28: // VK_DOWN
                LumenWpfHost.RunOnUi(() => StepFocus(1));
                return true;
            case 0x24: // VK_HOME
                LumenWpfHost.RunOnUi(() => { if (_cards.Count > 0) SetFocused(_cards[0].Item.Id, scroll: true); });
                return true;
            case 0x23: // VK_END
                LumenWpfHost.RunOnUi(() => { if (_cards.Count > 0) SetFocused(_cards[^1].Item.Id, scroll: true); });
                return true;
            case 0x0D: // VK_RETURN
                LumenWpfHost.RunOnUi(() => { if (_selectedId is not null) _ = PasteAndDismissAsync(_selectedId); });
                return true;
            case 0x20: // VK_SPACE -> open shared Quick Look
                LumenWpfHost.RunOnUi(OpenSelectedInPreview);
                return true;
            case 0x2E: // VK_DELETE
            case 0x08: // VK_BACK
                LumenWpfHost.RunOnUi(() => { if (_selectedId is not null) RemoveCardAnimated(_selectedId); });
                return true;
            default:
                // Top-row digits '1'..'9' (0x31..0x39) and Numpad 1..9 (0x61..0x69)
                var digit = vkCode is >= 0x31 and <= 0x39 ? vkCode - 0x30
                    : (vkCode is >= 0x61 and <= 0x69 ? vkCode - 0x60 : 0);
                if (digit is >= 1 and <= 9)
                {
                    LumenWpfHost.RunOnUi(() => QuickSelectDigit(digit));
                    return true;
                }
                return false;
        }
    }

    private void OnLocalPreviewKeyDown(object sender, KeyEventArgs e)
    {
        var vk = KeyInterop.VirtualKeyFromKey(e.Key);
        var mods = Keyboard.Modifiers;
        if (HandleGlobalVirtualKey(vk, (mods & ModifierKeys.Control) != 0, (mods & ModifierKeys.Alt) != 0, (mods & ModifierKeys.Shift) != 0))
        {
            e.Handled = true;
        }
    }

    private void StepFocus(int delta)
    {
        if (_cards.Count == 0) return;
        var idx = _cards.FindIndex(c => string.Equals(c.Item.Id, _selectedId, StringComparison.Ordinal));
        if (idx < 0) idx = 0;
        var next = Math.Clamp(idx + delta, 0, _cards.Count - 1);
        SetFocused(_cards[next].Item.Id, scroll: true);
    }

    private void QuickSelectDigit(int digit)
    {
        if (digit < 1 || digit > _cards.Count) return;
        var target = _cards[digit - 1];
        SetFocused(target.Item.Id, scroll: true);
        _ = PasteAndDismissAsync(target.Item.Id);
    }

    private void OpenSelectedInPreview()
    {
        if (_selectedId is null) return;
        var item = _store.Items.FirstOrDefault(x => string.Equals(x.Id, _selectedId, StringComparison.Ordinal));
        if (item is not null)
        {
            LumenPreviewWindow.Shared.Open(new[] { item }, item.Id);
        }
    }
}
