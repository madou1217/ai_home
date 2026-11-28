using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;

namespace AihLumenClipboard;

/// <summary>
/// Translucent Orbit glass backdrop with spectral gradient wash, pointer-following luminous
/// radial sheen, reflective 1.5px exposed-edge highlight, ambient floating micro-particles,
/// and release-light particle burst on card removal.
/// </summary>
public sealed class LumenOrbitBackdropControl : FrameworkElement
{
    private struct AmbientParticle
    {
        public double X;
        public double Y;
        public double Vx;
        public double Vy;
        public double Radius;
        public double Phase;
    }

    private struct BurstSpeck
    {
        public double StartX;
        public double StartY;
        public double Dx;
        public double Dy;
        public double Radius;
        public double StartMs;
        public double DurationMs;
    }

    private readonly AmbientParticle[] _ambient = new AmbientParticle[28];
    private readonly List<BurstSpeck> _bursts = new();
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private double _lastTickMs;
    private bool _renderingHooked;
    private bool _ambientSeeded;

    private LumenPalette _palette = LumenPalette.Light;
    private LumenVisualPreferences _prefs = new();
    private string _edgePosition = "bottom";
    private Point _pointer;
    private bool _hasPointer;
    private bool _isActive;

    public string EdgePosition
    {
        get => _edgePosition;
        set { _edgePosition = value; InvalidateVisual(); }
    }

    public LumenOrbitBackdropControl()
    {
        IsHitTestVisible = false;
    }

    public void ApplyTheme(LumenPalette palette, LumenVisualPreferences prefs)
    {
        _palette = palette;
        _prefs = prefs;
        UpdateRenderLoopState();
        InvalidateVisual();
    }

    public void SetActive(bool active)
    {
        _isActive = active;
        if (!active) _bursts.Clear();
        UpdateRenderLoopState();
    }

    public void UpdatePointer(Point localPos)
    {
        _pointer = localPos;
        _hasPointer = true;
        if (_prefs.Glow) InvalidateVisual();
    }

    public void SpawnReleaseLightBurst(Rect cardRect)
    {
        if (!_prefs.Particles || !_prefs.Glow || !LumenMotion.IsEnabled) return;
        const double goldenAngle = 2.39996;
        var now = _clock.Elapsed.TotalMilliseconds;
        for (var i = 0; i < 18; i++)
        {
            var r = (i % 4 == 0) ? 2.4 : 1.5;
            var sx = cardRect.Left + cardRect.Width * (0.15 + 0.70 * ((i * 7) % 17) / 17.0);
            var sy = cardRect.Top + cardRect.Height * (0.15 + 0.70 * ((i * 11) % 17) / 17.0);
            var angle = i * goldenAngle;
            var dx = Math.Cos(angle) * (18 + i * 2);
            var dy = Math.Sin(angle) * (14 + i * 2) - 24; // upward in WPF top-down coords
            _bursts.Add(new BurstSpeck
            {
                StartX = sx,
                StartY = sy,
                Dx = dx,
                Dy = dy,
                Radius = r,
                StartMs = now,
                DurationMs = 420 + i * 8
            });
        }
        UpdateRenderLoopState();
        InvalidateVisual();
    }

    private void UpdateRenderLoopState()
    {
        var wantLoop = _isActive && LumenMotion.IsEnabled && (_prefs.Particles || _bursts.Count > 0);
        if (wantLoop && !_renderingHooked)
        {
            _lastTickMs = _clock.Elapsed.TotalMilliseconds;
            CompositionTarget.Rendering += OnRenderFrame;
            _renderingHooked = true;
        }
        else if (!wantLoop && _renderingHooked)
        {
            CompositionTarget.Rendering -= OnRenderFrame;
            _renderingHooked = false;
        }
    }

    private void EnsureAmbientSeeded(double w, double h)
    {
        if (_ambientSeeded || w <= 20 || h <= 20) return;
        _ambientSeeded = true;
        for (var i = 0; i < _ambient.Length; i++)
        {
            var fx = ((i * 37 + 11) % 97) / 97.0;
            var fy = ((i * 53 + 7) % 89) / 89.0;
            var angle = i * 2.39996;
            _ambient[i] = new AmbientParticle
            {
                X = fx * w,
                Y = fy * h,
                Vx = Math.Cos(angle) * (7.0 + (i % 5) * 2.2),
                Vy = Math.Sin(angle) * (4.5 + (i % 4) * 1.8),
                Radius = (i % 3 == 0) ? 2.1 : 1.35,
                Phase = i * 0.73
            };
        }
    }

    private void OnRenderFrame(object? sender, EventArgs e)
    {
        var now = _clock.Elapsed.TotalMilliseconds;
        var dt = Math.Clamp((now - _lastTickMs) / 1000.0, 0.0, 0.05);
        _lastTickMs = now;

        var w = ActualWidth;
        var h = ActualHeight;
        if (w > 20 && h > 20 && _prefs.Particles)
        {
            EnsureAmbientSeeded(w, h);
            for (var i = 0; i < _ambient.Length; i++)
            {
                ref var p = ref _ambient[i];
                p.X += p.Vx * dt;
                p.Y += p.Vy * dt;
                if (p.X < -6) p.X = w + 6;
                else if (p.X > w + 6) p.X = -6;
                if (p.Y < -6) p.Y = h + 6;
                else if (p.Y > h + 6) p.Y = -6;
            }
        }

        for (var i = _bursts.Count - 1; i >= 0; i--)
        {
            if (now - _bursts[i].StartMs >= _bursts[i].DurationMs)
            {
                _bursts.RemoveAt(i);
            }
        }
        if (_bursts.Count == 0 && !_prefs.Particles)
        {
            UpdateRenderLoopState();
        }
        InvalidateVisual();
    }

    protected override void OnRender(DrawingContext dc)
    {
        var w = ActualWidth;
        var h = ActualHeight;
        if (w <= 2 || h <= 2) return;
        var bounds = new Rect(0, 0, w, h);

        // Spectral translucent wash over DWM Acrylic backdrop
        var wash = new LinearGradientBrush(_palette.OrbitBackdropTopColor, _palette.OrbitBackdropBottomColor, new Point(0, 0), new Point(0, 1));
        dc.DrawRectangle(wash, null, bounds);

        // Ambient floating particles
        if (_prefs.Particles && LumenMotion.IsEnabled && _isActive)
        {
            EnsureAmbientSeeded(w, h);
            var nowSec = _clock.Elapsed.TotalSeconds;
            var baseColor = _palette.IsDark
                ? LumenPalette.Rgb(0.78, 0.90, 1.0)
                : LumenPalette.Rgb(0.95, 0.99, 1.0);
            for (var i = 0; i < _ambient.Length; i++)
            {
                var p = _ambient[i];
                var alpha = (0.28 + 0.34 * (0.5 + 0.5 * Math.Sin(nowSec * 1.4 + p.Phase))) * (_palette.IsDark ? 0.85 : 1.0);
                var brush = LumenPalette.Brush(LumenPalette.WithAlpha(baseColor, alpha));
                dc.DrawEllipse(brush, null, new Point(p.X, p.Y), p.Radius, p.Radius);
            }
        }

        // Pointer-following luminous radial spotlight
        if (_prefs.Glow)
        {
            var spotX = _hasPointer ? _pointer.X : w * 0.5;
            var spotY = _hasPointer ? _pointer.Y : h * 0.5;
            var center = _edgePosition switch
            {
                "left" => new Point(w, spotY),
                "right" => new Point(0, spotY),
                _ => new Point(spotX, 0)
            };
            var spotColor = _palette.IsDark
                ? LumenPalette.Rgba(0.54, 0.72, 1.0, 0.28)
                : LumenPalette.Rgba(0.91, 0.96, 1.0, 0.56);
            var radial = new RadialGradientBrush(spotColor, Colors.Transparent)
            {
                MappingMode = BrushMappingMode.Absolute,
                Center = center,
                GradientOrigin = center,
                RadiusX = 340,
                RadiusY = 260
            };
            dc.DrawRectangle(radial, null, bounds);
        }

        // Reflective 1.5px specular edge highlight along exposed screen-edge boundary
        var edgeBrush = LumenPalette.Brush(LumenPalette.WithAlpha(_palette.OrbitTopSheenColor, _prefs.Glow ? 0.88 : 0.35));
        switch (_edgePosition)
        {
            case "left":
                dc.DrawRectangle(edgeBrush, null, new Rect(w - 1.5, 0, 1.5, h));
                break;
            case "right":
                dc.DrawRectangle(edgeBrush, null, new Rect(0, 0, 1.5, h));
                break;
            default:
                dc.DrawRectangle(edgeBrush, null, new Rect(0, 0, w, 1.5));
                break;
        }

        // Release-light burst specks on card removal
        if (_bursts.Count > 0)
        {
            var now = _clock.Elapsed.TotalMilliseconds;
            foreach (var b in _bursts)
            {
                var t = Math.Clamp((now - b.StartMs) / b.DurationMs, 0.0, 1.0);
                var eased = LumenMotion.EvalCubicBezier(t, 0.18, 0.75, 0.30, 1.0);
                var alpha = t < 0.22 ? (t / 0.22) * 0.95 : (1.0 - (t - 0.22) / 0.78) * 0.95;
                var scale = t < 0.22 ? (0.6 + (t / 0.22) * 0.65) : (1.25 - ((t - 0.22) / 0.78) * 1.05);
                var x = b.StartX + b.Dx * eased;
                var y = b.StartY + b.Dy * eased;
                var r = Math.Max(0.4, b.Radius * scale);
                var glowBrush = LumenPalette.Brush(LumenPalette.Rgba(0.76, 0.90, 1.0, alpha * 0.45));
                var coreBrush = LumenPalette.Brush(LumenPalette.Rgba(0.95, 0.99, 1.0, alpha));
                dc.DrawEllipse(glowBrush, null, new Point(x, y), r * 2.4, r * 2.4);
                dc.DrawEllipse(coreBrush, null, new Point(x, y), r, r);
            }
        }
    }
}

public enum LumenOrbitCardState
{
    Idle,
    Near,
    Hovered,
    Selected
}

/// <summary>
/// Individual clipboard card inside the Orbit edge rail with interruptible spring elevation,
/// quick-paste numeric badge (1-9), hover circular removal button, and rich preview body.
/// </summary>
public sealed class LumenOrbitCardControl : Border
{
    public LumenClipboardItem Item { get; }

    private readonly Border _shineOverlay;
    private readonly Border _sourceBadge;
    private readonly TextBlock _sourceLabel;
    private readonly TextBlock _timeLabel;
    private readonly Border _removeCircle;
    private readonly Button _removeButton;
    private readonly TextBlock _titleLabel;
    private readonly Border _bodyHost;
    private readonly TextBlock _footGlyph;
    private readonly TextBlock _footLabel;
    private readonly TextBlock _pinGlyph;
    private readonly Border _keyBadgeBorder;
    private readonly TextBlock _keyBadgeText;

    private readonly TranslateTransform _liftTransform = new(0, 0);
    private readonly ScaleTransform _scaleTransform = new(1, 1);
    private readonly DropShadowEffect _shadowEffect;

    private LumenPalette _palette;
    private bool _glowEnabled;
    private int? _quickKeyIndex;
    private LumenOrbitCardState _visualState = LumenOrbitCardState.Idle;
    private bool _isPointerInside;
    private bool _isDisposed;

    public event Action<string>? SelectAndPasteRequested;
    public event Action<string>? HoverFocusRequested;
    public event Action<string>? RemoveRequested;
    public event Action<string>? ContextMenuRequested;

    public int? QuickKeyIndex
    {
        get => _quickKeyIndex;
        set
        {
            _quickKeyIndex = value;
            UpdateQuickKeyBadge();
        }
    }

    public LumenOrbitCardState VisualState
    {
        get => _visualState;
        set
        {
            if (_visualState == value) return;
            _visualState = value;
            UpdateVisualState(animated: LumenMotion.IsEnabled);
        }
    }

    public LumenOrbitCardControl(LumenClipboardItem item, int? keyIndex, LumenPalette palette, bool glowEnabled)
    {
        Item = item;
        _quickKeyIndex = keyIndex;
        _palette = palette;
        _glowEnabled = glowEnabled;

        CornerRadius = new CornerRadius(18);
        BorderThickness = new Thickness(1);
        Cursor = Cursors.Hand;
        RenderTransformOrigin = new Point(0.5, 0.85);
        var group = new TransformGroup();
        group.Children.Add(_scaleTransform);
        group.Children.Add(_liftTransform);
        RenderTransform = group;

        _shadowEffect = new DropShadowEffect
        {
            Color = LumenPalette.Rgb(0.04, 0.11, 0.22),
            BlurRadius = 18,
            ShadowDepth = 5,
            Direction = 270,
            Opacity = 0.24
        };
        Effect = _shadowEffect;

        var cat = item.DisplayCategory;

        // Top-right specular shine layer
        _shineOverlay = new Border
        {
            CornerRadius = new CornerRadius(17),
            IsHitTestVisible = false,
            Opacity = 0,
            Background = new LinearGradientBrush(
                LumenPalette.Rgba(1, 1, 1, 0.30),
                Colors.Transparent,
                new Point(0, 0),
                new Point(0.85, 0.80))
        };

        var layout = new Grid();
        layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        layout.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        // Header row
        var headGrid = new Grid { Margin = new Thickness(12, 11, 10, 6) };
        headGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        headGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        headGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        _sourceBadge = new Border
        {
            Width = 22,
            Height = 22,
            CornerRadius = new CornerRadius(7),
            Child = LumenUiFactory.CreateGlyph(cat.GetGlyph(), 11, Brushes.White)
        };
        Grid.SetColumn(_sourceBadge, 0);

        _sourceLabel = new TextBlock
        {
            Text = item.SourceLabel,
            FontFamily = LumenFonts.Ui,
            FontSize = 10.5,
            FontWeight = FontWeights.Medium,
            TextTrimming = TextTrimming.CharacterEllipsis,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(7, 0, 6, 0)
        };
        Grid.SetColumn(_sourceLabel, 1);

        var topRight = new Grid { VerticalAlignment = VerticalAlignment.Center };
        _timeLabel = new TextBlock
        {
            Text = item.RelativeTime,
            FontFamily = LumenFonts.Mono,
            FontSize = 10,
            VerticalAlignment = VerticalAlignment.Center,
            HorizontalAlignment = HorizontalAlignment.Right
        };

        _removeCircle = new Border
        {
            Width = 23,
            Height = 23,
            CornerRadius = new CornerRadius(11.5),
            BorderThickness = new Thickness(1),
            Child = LumenUiFactory.CreateGlyph("\uE711", 9.5, palette.Ink)
        };
        _removeButton = LumenUiFactory.CreateBorderlessButton(_removeCircle, "移除记录 (Delete)", () => RemoveRequested?.Invoke(Item.Id));
        _removeButton.HorizontalAlignment = HorizontalAlignment.Right;
        _removeButton.Visibility = Visibility.Collapsed;
        _removeButton.Opacity = 0;

        topRight.Children.Add(_timeLabel);
        topRight.Children.Add(_removeButton);
        Grid.SetColumn(topRight, 2);

        headGrid.Children.Add(_sourceBadge);
        headGrid.Children.Add(_sourceLabel);
        headGrid.Children.Add(topRight);
        Grid.SetRow(headGrid, 0);

        // Title
        _titleLabel = new TextBlock
        {
            Text = item.DisplayTitle,
            FontFamily = LumenFonts.Ui,
            FontSize = 13.5,
            FontWeight = FontWeights.SemiBold,
            TextTrimming = TextTrimming.CharacterEllipsis,
            Margin = new Thickness(12, 0, 12, 6)
        };
        Grid.SetRow(_titleLabel, 1);

        // Body host
        _bodyHost = new Border
        {
            CornerRadius = new CornerRadius(10),
            ClipToBounds = true,
            Margin = new Thickness(12, 0, 12, 8)
        };
        Grid.SetRow(_bodyHost, 2);

        // Footer row
        var footGrid = new Grid { Margin = new Thickness(12, 0, 11, 10) };
        footGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        footGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        footGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        footGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        _footGlyph = LumenUiFactory.CreateGlyph(cat.GetGlyph(), 11, palette.Muted);
        Grid.SetColumn(_footGlyph, 0);

        _footLabel = new TextBlock
        {
            Text = cat.GetLabel(),
            FontFamily = LumenFonts.Ui,
            FontSize = 10.5,
            FontWeight = FontWeights.Medium,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(5, 0, 6, 0)
        };
        Grid.SetColumn(_footLabel, 1);

        _pinGlyph = LumenUiFactory.CreateGlyph("\uE840", 11, palette.Accent);
        _pinGlyph.Visibility = item.Pinned ? Visibility.Visible : Visibility.Collapsed;
        _pinGlyph.Margin = new Thickness(0, 0, 6, 0);
        Grid.SetColumn(_pinGlyph, 2);

        _keyBadgeText = new TextBlock
        {
            FontFamily = LumenFonts.Mono,
            FontSize = 10,
            FontWeight = FontWeights.SemiBold,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center
        };
        _keyBadgeBorder = new Border
        {
            MinWidth = 20,
            Height = 19,
            CornerRadius = new CornerRadius(5),
            Padding = new Thickness(4, 0, 4, 0),
            Child = _keyBadgeText
        };
        Grid.SetColumn(_keyBadgeBorder, 3);

        footGrid.Children.Add(_footGlyph);
        footGrid.Children.Add(_footLabel);
        footGrid.Children.Add(_pinGlyph);
        footGrid.Children.Add(_keyBadgeBorder);
        Grid.SetRow(footGrid, 3);

        layout.Children.Add(headGrid);
        layout.Children.Add(_titleLabel);
        layout.Children.Add(_bodyHost);
        layout.Children.Add(footGrid);

        var layers = new Grid();
        layers.Children.Add(layout);
        layers.Children.Add(_shineOverlay);
        Child = layers;

        MouseEnter += (_, _) =>
        {
            _isPointerInside = true;
            UpdateRemoveButtonVisibility(animated: true);
            HoverFocusRequested?.Invoke(Item.Id);
        };
        MouseLeave += (_, _) =>
        {
            _isPointerInside = false;
            UpdateRemoveButtonVisibility(animated: true);
        };
        MouseRightButtonUp += (_, e) =>
        {
            e.Handled = true;
            ContextMenuRequested?.Invoke(Item.Id);
        };

        PopulateBody();
        ApplyTheme(palette, glowEnabled);
        UpdateQuickKeyBadge();
        UpdateVisualState(animated: false);
    }

    public void TriggerPasteClick() => SelectAndPasteRequested?.Invoke(Item.Id);

    public void MarkRemoved() => _isDisposed = true;

    public void PlayRemoveAnimation(Action onCompleted)
    {
        if (!LumenMotion.IsEnabled)
        {
            onCompleted();
            return;
        }
        var dur = LumenMotion.RemoveDuration;
        var opacityAnim = new DoubleAnimationUsingKeyFrames { Duration = dur };
        opacityAnim.KeyFrames.Add(new LinearDoubleKeyFrame(1.0, KeyTime.FromPercent(0.0)));
        opacityAnim.KeyFrames.Add(new LinearDoubleKeyFrame(0.85, KeyTime.FromPercent(0.28)));
        opacityAnim.KeyFrames.Add(new LinearDoubleKeyFrame(0.0, KeyTime.FromPercent(1.0)));

        var scaleAnim = new DoubleAnimationUsingKeyFrames { Duration = dur };
        scaleAnim.KeyFrames.Add(new LinearDoubleKeyFrame(1.0, KeyTime.FromPercent(0.0)));
        scaleAnim.KeyFrames.Add(new LinearDoubleKeyFrame(0.95, KeyTime.FromPercent(0.28)));
        scaleAnim.KeyFrames.Add(new LinearDoubleKeyFrame(0.76, KeyTime.FromPercent(1.0)));

        var liftAnim = new DoubleAnimationUsingKeyFrames { Duration = dur };
        liftAnim.KeyFrames.Add(new LinearDoubleKeyFrame(-6.0, KeyTime.FromPercent(0.0)));
        liftAnim.KeyFrames.Add(new LinearDoubleKeyFrame(-18.0, KeyTime.FromPercent(0.28)));
        liftAnim.KeyFrames.Add(new LinearDoubleKeyFrame(22.0, KeyTime.FromPercent(1.0)));

        opacityAnim.Completed += (_, _) => onCompleted();
        BeginAnimation(OpacityProperty, opacityAnim, HandoffBehavior.SnapshotAndReplace);
        _scaleTransform.BeginAnimation(ScaleTransform.ScaleXProperty, scaleAnim, HandoffBehavior.SnapshotAndReplace);
        _scaleTransform.BeginAnimation(ScaleTransform.ScaleYProperty, scaleAnim, HandoffBehavior.SnapshotAndReplace);
        _liftTransform.BeginAnimation(TranslateTransform.YProperty, liftAnim, HandoffBehavior.SnapshotAndReplace);
    }

    public void PlayPasteLiftAnimation()
    {
        if (!LumenMotion.IsEnabled) return;
        var dur = TimeSpan.FromMilliseconds(220);
        var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
        _liftTransform.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(-26.0, dur) { EasingFunction = ease }, HandoffBehavior.SnapshotAndReplace);
        BeginAnimation(OpacityProperty, new DoubleAnimation(0.25, dur), HandoffBehavior.SnapshotAndReplace);
    }

    public void PlayArrivalStagger(int index)
    {
        if (!LumenMotion.IsEnabled) return;
        var delay = TimeSpan.FromMilliseconds(index * 16);
        var dur = TimeSpan.FromMilliseconds(360);
        var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
        Opacity = 0;
        _liftTransform.Y = 22;
        BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, dur) { BeginTime = delay, EasingFunction = ease }, HandoffBehavior.SnapshotAndReplace);
        _liftTransform.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(22, TargetLiftY(), dur) { BeginTime = delay, EasingFunction = ease }, HandoffBehavior.SnapshotAndReplace);
    }

    private void PopulateBody()
    {
        var kind = LumenPreviewItem.ClassifyItem(Item);
        switch (kind.Tag)
        {
            case LumenPreviewKindTag.Color:
                if (LumenClassifier.TryParseHexColor(Item.EffectiveText, out var sw))
                {
                    _bodyHost.Background = LumenPalette.Brush(sw);
                    _bodyHost.Child = new TextBlock
                    {
                        Text = Item.EffectiveText.Trim().ToUpperInvariant(),
                        FontFamily = LumenFonts.Mono,
                        FontSize = 12,
                        FontWeight = FontWeights.SemiBold,
                        Foreground = Brushes.White,
                        VerticalAlignment = VerticalAlignment.Bottom,
                        Margin = new Thickness(10, 0, 10, 8)
                    };
                }
                break;
            case LumenPreviewKindTag.Image:
                _bodyHost.Background = _palette.SurfaceElevated;
                if (Item.DecodeThumbnailImage() is { } bmp)
                {
                    _bodyHost.Child = new Image { Source = bmp, Stretch = Stretch.UniformToFill };
                }
                else
                {
                    _bodyHost.Child = LumenUiFactory.CreateGlyph("\uEB9F", 28, _palette.Muted);
                }
                break;
            case LumenPreviewKindTag.Code:
                _bodyHost.Background = _palette.CodeBackground;
                _bodyHost.Padding = new Thickness(8, 7, 8, 6);
                var tb = new TextBlock { TextWrapping = TextWrapping.Wrap, TextTrimming = TextTrimming.CharacterEllipsis };
                var lang = string.IsNullOrEmpty(kind.Subtype) ? "js" : kind.Subtype;
                var snip = Item.EffectiveText.Length > 260 ? Item.EffectiveText[..260] : Item.EffectiveText;
                LumenSyntaxHighlighter.PopulateCodeTextBlock(tb, snip, lang, 10, darkCanvas: true);
                _bodyHost.Child = tb;
                break;
            case LumenPreviewKindTag.Audio:
            case LumenPreviewKindTag.Video:
                _bodyHost.Child = new LumenAlbumCoverControl
                {
                    SeedIndex = Math.Abs(Item.Id.GetHashCode(StringComparison.Ordinal)) % 3,
                    BadgeText = kind.Tag == LumenPreviewKindTag.Audio ? "AUDIO" : "VIDEO"
                };
                break;
            case LumenPreviewKindTag.Pdf:
                _bodyHost.Background = LumenPalette.Brush(LumenPalette.WithAlpha(_palette.SurfaceElevatedColor, 0.72));
                var pdfImg = new Image { Stretch = Stretch.Uniform, Margin = new Thickness(4), Visibility = Visibility.Collapsed };
                var pdfFallback = LumenUiFactory.CreateGlyph("\uEA90", 30, _palette.Accent);
                var pdfGrid = new Grid();
                pdfGrid.Children.Add(pdfFallback);
                pdfGrid.Children.Add(pdfImg);
                _bodyHost.Child = pdfGrid;
                if (Item.PrimaryFilePath is { } pdfPath && File.Exists(pdfPath))
                {
                    _ = LumenPdfRenderer.RenderFirstPageThumbnailAsync(pdfPath, 160).ContinueWith(t =>
                    {
                        if (t.Status == TaskStatus.RanToCompletion && t.Result is { } thumb)
                        {
                            LumenWpfHost.RunOnUi(() =>
                            {
                                if (_isDisposed) return;
                                pdfImg.Source = thumb;
                                pdfImg.Visibility = Visibility.Visible;
                                pdfFallback.Visibility = Visibility.Collapsed;
                            });
                        }
                    }, TaskScheduler.Default);
                }
                break;
            case LumenPreviewKindTag.File:
            case LumenPreviewKindTag.Collection:
            case LumenPreviewKindTag.Office:
                _bodyHost.Background = LumenPalette.Brush(_palette.IsDark ? LumenPalette.WithAlpha(Colors.White, 0.08) : LumenPalette.WithAlpha(Colors.White, 0.56));
                _bodyHost.Padding = new Thickness(10, 8, 10, 8);
                var fileRow = new Grid { VerticalAlignment = VerticalAlignment.Center };
                fileRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                fileRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                var iconEl = LumenCollectionRendererView.CreateFileIconElement(Item.PrimaryFilePath, _palette, 32);
                Grid.SetColumn(iconEl, 0);
                var metaStack = new StackPanel { Orientation = Orientation.Vertical, Margin = new Thickness(8, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
                metaStack.Children.Add(new TextBlock
                {
                    Text = Item.DisplayTitle,
                    FontFamily = LumenFonts.Ui,
                    FontSize = 11.5,
                    FontWeight = FontWeights.SemiBold,
                    Foreground = _palette.Ink,
                    TextTrimming = TextTrimming.CharacterEllipsis
                });
                metaStack.Children.Add(new TextBlock
                {
                    Text = $"{kind.DisplayLabel} · {Item.FormattedSize}",
                    FontFamily = LumenFonts.Ui,
                    FontSize = 10,
                    Foreground = _palette.Muted,
                    Margin = new Thickness(0, 2, 0, 0)
                });
                Grid.SetColumn(metaStack, 1);
                fileRow.Children.Add(iconEl);
                fileRow.Children.Add(metaStack);
                _bodyHost.Child = fileRow;
                break;
            case LumenPreviewKindTag.Link:
                _bodyHost.Background = LumenPalette.Brush(_palette.IsDark ? LumenPalette.WithAlpha(Colors.White, 0.08) : LumenPalette.WithAlpha(Colors.White, 0.56));
                _bodyHost.Padding = new Thickness(10);
                var linkStack = new StackPanel { Orientation = Orientation.Vertical, VerticalAlignment = VerticalAlignment.Center };
                var linkGlyph = LumenUiFactory.CreateGlyph("\uE71B", 16, LumenPalette.Brush(_palette.CategoryTintColor(LumenDisplayCategory.Link)));
                linkGlyph.HorizontalAlignment = HorizontalAlignment.Left;
                linkStack.Children.Add(linkGlyph);
                var cleanUrl = Regex.Replace(Item.EffectiveText, @"^https?://", string.Empty, RegexOptions.IgnoreCase);
                linkStack.Children.Add(new TextBlock
                {
                    Text = cleanUrl,
                    FontFamily = LumenFonts.Ui,
                    FontSize = 11,
                    Foreground = _palette.Muted,
                    TextWrapping = TextWrapping.Wrap,
                    TextTrimming = TextTrimming.CharacterEllipsis,
                    MaxHeight = 52,
                    Margin = new Thickness(0, 6, 0, 0)
                });
                _bodyHost.Child = linkStack;
                break;
            default:
                var textSnippet = Item.EffectiveText.Length > 240 ? Item.EffectiveText[..240] : Item.EffectiveText;
                _bodyHost.Child = new TextBlock
                {
                    Text = textSnippet,
                    FontFamily = LumenFonts.Ui,
                    FontSize = 11.5,
                    LineHeight = 17.5,
                    Foreground = LumenPalette.Brush(_palette.IsDark ? LumenPalette.Rgb(0.78, 0.84, 0.92) : LumenPalette.Rgb(0.30, 0.36, 0.46)),
                    TextWrapping = TextWrapping.Wrap,
                    TextTrimming = TextTrimming.CharacterEllipsis
                };
                break;
        }
    }

    public void ApplyTheme(LumenPalette next, bool glowEnabled)
    {
        _palette = next;
        _glowEnabled = glowEnabled;
        Background = next.CreateOrbitCardBrush();
        _sourceBadge.Background = next.SourceBadgeBrush(Item.SourceLabel);
        _sourceLabel.Foreground = next.Muted;
        _timeLabel.Foreground = next.Muted;
        _titleLabel.Foreground = next.Ink;
        _footGlyph.Foreground = next.Muted;
        _footLabel.Foreground = next.Muted;
        _pinGlyph.Foreground = next.Accent;

        _removeCircle.Background = LumenPalette.Brush(next.IsDark
            ? LumenPalette.Rgba(0.19, 0.28, 0.40, 0.95)
            : LumenPalette.Rgba(0.93, 0.96, 1.0, 0.95));
        _removeCircle.BorderBrush = LumenPalette.Brush(next.IsDark
            ? LumenPalette.Rgba(0.71, 0.85, 1.0, 0.55)
            : Colors.White);
        if (_removeCircle.Child is TextBlock rt)
        {
            rt.Foreground = next.IsDark ? Brushes.White : LumenPalette.Brush(LumenPalette.Rgb(0.33, 0.40, 0.50));
        }

        UpdateVisualState(animated: false);
    }

    private void UpdateQuickKeyBadge()
    {
        if (_quickKeyIndex is >= 0 and < 9)
        {
            _keyBadgeBorder.Visibility = Visibility.Visible;
            _keyBadgeText.Text = (_quickKeyIndex.Value + 1).ToString();
        }
        else
        {
            _keyBadgeBorder.Visibility = Visibility.Collapsed;
        }
    }

    private void UpdateRemoveButtonVisibility(bool animated)
    {
        var show = _isPointerInside || _visualState == LumenOrbitCardState.Selected;
        if (show) _removeButton.Visibility = Visibility.Visible;
        var dur = TimeSpan.FromMilliseconds(animated && LumenMotion.IsEnabled ? 160 : 10);
        var btnAnim = new DoubleAnimation(show ? 1.0 : 0.0, dur);
        if (!show)
        {
            btnAnim.Completed += (_, _) =>
            {
                if (!_isPointerInside && _visualState != LumenOrbitCardState.Selected)
                {
                    _removeButton.Visibility = Visibility.Collapsed;
                }
            };
        }
        _removeButton.BeginAnimation(OpacityProperty, btnAnim, HandoffBehavior.SnapshotAndReplace);
        _timeLabel.BeginAnimation(OpacityProperty, new DoubleAnimation(show ? 0.0 : 1.0, dur), HandoffBehavior.SnapshotAndReplace);
    }

    private double TargetLiftY() => _visualState switch
    {
        LumenOrbitCardState.Selected => -9.0,
        LumenOrbitCardState.Hovered => -5.0,
        LumenOrbitCardState.Near => -2.0,
        _ => 0.0
    };

    private void UpdateVisualState(bool animated)
    {
        var isSelected = _visualState == LumenOrbitCardState.Selected;
        BorderThickness = new Thickness(isSelected ? 1.5 : 1.0);
        BorderBrush = LumenPalette.Brush(isSelected ? _palette.OrbitCardSelectedBorderColor : _palette.OrbitCardBorderColor);
        _shineOverlay.Opacity = (_glowEnabled && (isSelected || _visualState == LumenOrbitCardState.Hovered)) ? 0.65 : 0.0;

        _keyBadgeBorder.Background = LumenPalette.Brush(isSelected ? _palette.OrbitKeyBadgeSelectedBgColor : _palette.OrbitKeyBadgeBgColor);
        _keyBadgeText.Foreground = isSelected ? Brushes.White : LumenPalette.Brush(_palette.OrbitKeyBadgeTextColor);

        _shadowEffect.Color = isSelected && _glowEnabled
            ? _palette.OrbitCardSelectedGlowColor
            : LumenPalette.Rgb(0.04, 0.11, 0.22);
        _shadowEffect.Opacity = isSelected ? (_glowEnabled ? 0.68 : 0.36) : 0.22;
        _shadowEffect.BlurRadius = isSelected ? 24 : 16;
        Panel.SetZIndex(this, isSelected ? 10 : (_visualState == LumenOrbitCardState.Hovered ? 5 : 1));

        var targetY = TargetLiftY();
        if (animated && LumenMotion.IsEnabled)
        {
            var anim = new DoubleAnimation(targetY, LumenMotion.HoverDuration)
            {
                EasingFunction = new BackEase { EasingMode = EasingMode.EaseOut, Amplitude = 0.22 }
            };
            _liftTransform.BeginAnimation(TranslateTransform.YProperty, anim, HandoffBehavior.SnapshotAndReplace);
        }
        else
        {
            _liftTransform.BeginAnimation(TranslateTransform.YProperty, null);
            _liftTransform.Y = targetY;
        }
        UpdateRemoveButtonVisibility(animated);
    }
}
