using System.Globalization;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;

namespace AihLumenClipboard;

/// <summary>
/// Centralized motion timing tokens honoring both the in-app motion toggle
/// and Windows reduced-motion setting (<see cref="SystemParameters.ClientAreaAnimation"/>).
/// </summary>
public static class LumenMotion
{
    public static bool IsEnabled =>
        LumenClipboardStore.Shared.Preferences.Motion && SystemParameters.ClientAreaAnimation;

    public static TimeSpan EnterDuration => TimeSpan.FromMilliseconds(IsEnabled ? 380 : 10);
    public static TimeSpan ExitDuration => TimeSpan.FromMilliseconds(IsEnabled ? 220 : 10);
    public static TimeSpan SwitchDuration => TimeSpan.FromMilliseconds(IsEnabled ? 280 : 10);
    public static TimeSpan RemoveDuration => TimeSpan.FromMilliseconds(IsEnabled ? 340 : 10);
    public static TimeSpan HoverDuration => TimeSpan.FromMilliseconds(IsEnabled ? 200 : 10);

    /// <summary>
    /// Evaluates a 1D cubic-bezier curve y(t) for control points (x1, y1, x2, y2).
    /// </summary>
    public static double EvalCubicBezier(double t, double x1, double y1, double x2, double y2)
    {
        t = Math.Clamp(t, 0.0, 1.0);
        if (t <= 0.0) return 0.0;
        if (t >= 1.0) return 1.0;

        // Solve u such that BezierX(u) == t via Newton-Raphson with binary clamp fallback.
        double lo = 0.0, hi = 1.0, u = t;
        for (var i = 0; i < 6; i++)
        {
            var x = SampleBezier(u, x1, x2) - t;
            if (Math.Abs(x) < 1e-5) break;
            var dx = SampleBezierDerivative(u, x1, x2);
            if (Math.Abs(dx) < 1e-5) break;
            u = Math.Clamp(u - x / dx, 0.0, 1.0);
        }
        var err = SampleBezier(u, x1, x2) - t;
        if (Math.Abs(err) > 1e-3)
        {
            for (var i = 0; i < 10; i++)
            {
                u = (lo + hi) * 0.5;
                if (SampleBezier(u, x1, x2) < t) lo = u;
                else hi = u;
            }
        }
        return SampleBezier(u, y1, y2);
    }

    private static double SampleBezier(double u, double p1, double p2)
    {
        var inv = 1.0 - u;
        return 3.0 * inv * inv * u * p1 + 3.0 * inv * u * u * p2 + u * u * u;
    }

    private static double SampleBezierDerivative(double u, double p1, double p2)
    {
        var inv = 1.0 - u;
        return 3.0 * inv * inv * p1 + 6.0 * inv * u * (p2 - p1) + 3.0 * u * u * (1.0 - p2);
    }
}

/// <summary>
/// Glacier Glass (Light) and Deep Sea Glass (Dark) design tokens matching Lumen V7.
/// All SolidColorBrushes are frozen for thread safety and zero per-frame allocations.
/// </summary>
public sealed class LumenPalette
{
    public bool IsDark { get; init; }
    public Color WindowBackgroundColor { get; init; }
    public Color SidebarTopColor { get; init; }
    public Color SidebarBottomColor { get; init; }
    public Color SurfaceColor { get; init; }
    public Color SurfaceElevatedColor { get; init; }
    public Color BorderColor { get; init; }
    public Color BorderStrongColor { get; init; }
    public Color InkColor { get; init; }
    public Color MutedColor { get; init; }
    public Color AccentColor { get; init; }
    public Color AccentSoftColor { get; init; }
    public Color AccentBorderColor { get; init; }
    public Color DangerColor { get; init; }
    public Color DangerSoftColor { get; init; }
    public Color SuccessColor { get; init; }
    public Color WarningColor { get; init; }

    public Color OrbitBackdropTopColor { get; init; }
    public Color OrbitBackdropBottomColor { get; init; }
    public Color OrbitTopSheenColor { get; init; }
    public Color OrbitCardTopColor { get; init; }
    public Color OrbitCardBottomColor { get; init; }
    public Color OrbitCardBorderColor { get; init; }
    public Color OrbitCardSelectedBorderColor { get; init; }
    public Color OrbitCardSelectedGlowColor { get; init; }
    public Color OrbitKeyBadgeBgColor { get; init; }
    public Color OrbitKeyBadgeTextColor { get; init; }
    public Color OrbitKeyBadgeSelectedBgColor { get; init; }

    public Color CodeBackgroundColor { get; init; }
    public Color CodeToolbarBgColor { get; init; }
    public Color CodeGutterTextColor { get; init; }
    public Color CodeBaseTextColor { get; init; }

    public SolidColorBrush WindowBackground => Brush(WindowBackgroundColor);
    public SolidColorBrush Surface => Brush(SurfaceColor);
    public SolidColorBrush SurfaceElevated => Brush(SurfaceElevatedColor);
    public SolidColorBrush Border => Brush(BorderColor);
    public SolidColorBrush BorderStrong => Brush(BorderStrongColor);
    public SolidColorBrush Ink => Brush(InkColor);
    public SolidColorBrush Muted => Brush(MutedColor);
    public SolidColorBrush Accent => Brush(AccentColor);
    public SolidColorBrush AccentSoft => Brush(AccentSoftColor);
    public SolidColorBrush AccentBorder => Brush(AccentBorderColor);
    public SolidColorBrush Danger => Brush(DangerColor);
    public SolidColorBrush DangerSoft => Brush(DangerSoftColor);
    public SolidColorBrush Success => Brush(SuccessColor);
    public SolidColorBrush Warning => Brush(WarningColor);
    public SolidColorBrush CodeBackground => Brush(CodeBackgroundColor);
    public SolidColorBrush CodeToolbarBackground => Brush(CodeToolbarBgColor);
    public SolidColorBrush CodeGutterText => Brush(CodeGutterTextColor);
    public SolidColorBrush CodeBaseText => Brush(CodeBaseTextColor);

    public static readonly LumenPalette Light = new()
    {
        IsDark = false,
        WindowBackgroundColor = Rgb(0.976, 0.980, 0.988),
        SidebarTopColor = Rgb(0.910, 0.925, 0.961),
        SidebarBottomColor = Rgb(0.945, 0.953, 0.969),
        SurfaceColor = Rgb(1.0, 1.0, 1.0),
        SurfaceElevatedColor = Rgb(0.945, 0.957, 0.980),
        BorderColor = Rgb(0.886, 0.902, 0.933),
        BorderStrongColor = Rgb(0.788, 0.824, 0.894),
        InkColor = Rgb(0.125, 0.149, 0.204),
        MutedColor = Rgb(0.478, 0.506, 0.565),
        AccentColor = Rgb(0.329, 0.427, 0.882),
        AccentSoftColor = Rgba(0.506, 0.580, 0.882, 0.16),
        AccentBorderColor = Rgba(0.506, 0.580, 0.882, 0.44),
        DangerColor = Rgb(0.788, 0.337, 0.404),
        DangerSoftColor = Rgba(0.831, 0.404, 0.467, 0.12),
        SuccessColor = Rgb(0.369, 0.710, 0.584),
        WarningColor = Rgb(0.875, 0.643, 0.294),

        OrbitBackdropTopColor = Rgba(0.890, 0.945, 0.996, 0.56),
        OrbitBackdropBottomColor = Rgba(0.620, 0.718, 0.867, 0.72),
        OrbitTopSheenColor = Rgba(0.950, 0.985, 1.0, 0.88),
        OrbitCardTopColor = Rgba(0.988, 0.992, 1.0, 0.95),
        OrbitCardBottomColor = Rgba(0.875, 0.914, 0.969, 0.92),
        OrbitCardBorderColor = Rgba(1.0, 1.0, 1.0, 0.70),
        OrbitCardSelectedBorderColor = Rgba(1.0, 1.0, 1.0, 0.98),
        OrbitCardSelectedGlowColor = Rgba(0.690, 0.847, 1.0, 0.88),
        OrbitKeyBadgeBgColor = Rgba(0.353, 0.451, 0.612, 0.14),
        OrbitKeyBadgeTextColor = Rgb(0.396, 0.463, 0.576),
        OrbitKeyBadgeSelectedBgColor = Rgb(0.396, 0.537, 0.843),

        CodeBackgroundColor = Rgb(0.082, 0.110, 0.173),
        CodeToolbarBgColor = Rgb(0.125, 0.165, 0.235),
        CodeGutterTextColor = Rgb(0.412, 0.478, 0.580),
        CodeBaseTextColor = Rgb(0.859, 0.902, 0.976)
    };

    public static readonly LumenPalette Dark = new()
    {
        IsDark = true,
        WindowBackgroundColor = Rgb(0.090, 0.106, 0.145),
        SidebarTopColor = Rgb(0.145, 0.176, 0.255),
        SidebarBottomColor = Rgb(0.125, 0.145, 0.192),
        SurfaceColor = Rgb(0.118, 0.149, 0.212),
        SurfaceElevatedColor = Rgb(0.153, 0.192, 0.267),
        BorderColor = Rgb(0.188, 0.216, 0.275),
        BorderStrongColor = Rgb(0.267, 0.314, 0.404),
        InkColor = Rgb(0.914, 0.929, 0.969),
        MutedColor = Rgb(0.553, 0.596, 0.667),
        AccentColor = Rgb(0.627, 0.690, 1.0),
        AccentSoftColor = Rgba(0.506, 0.584, 0.902, 0.22),
        AccentBorderColor = Rgba(0.569, 0.659, 0.969, 0.48),
        DangerColor = Rgb(0.961, 0.596, 0.678),
        DangerSoftColor = Rgba(0.831, 0.404, 0.467, 0.18),
        SuccessColor = Rgb(0.431, 0.796, 0.659),
        WarningColor = Rgb(0.945, 0.725, 0.388),

        OrbitBackdropTopColor = Rgba(0.082, 0.165, 0.278, 0.76),
        OrbitBackdropBottomColor = Rgba(0.063, 0.114, 0.212, 0.88),
        OrbitTopSheenColor = Rgba(0.761, 0.871, 1.0, 0.72),
        OrbitCardTopColor = Rgba(0.220, 0.298, 0.420, 0.92),
        OrbitCardBottomColor = Rgba(0.125, 0.192, 0.294, 0.94),
        OrbitCardBorderColor = Rgba(0.647, 0.765, 0.929, 0.34),
        OrbitCardSelectedBorderColor = Rgba(0.812, 0.922, 1.0, 0.96),
        OrbitCardSelectedGlowColor = Rgba(0.631, 0.792, 1.0, 0.74),
        OrbitKeyBadgeBgColor = Rgba(0.667, 0.769, 1.0, 0.16),
        OrbitKeyBadgeTextColor = Rgb(0.722, 0.800, 0.922),
        OrbitKeyBadgeSelectedBgColor = Rgb(0.459, 0.588, 0.855),

        CodeBackgroundColor = Rgb(0.082, 0.110, 0.173),
        CodeToolbarBgColor = Rgb(0.125, 0.165, 0.235),
        CodeGutterTextColor = Rgb(0.412, 0.478, 0.580),
        CodeBaseTextColor = Rgb(0.859, 0.902, 0.976)
    };

    public static LumenPalette Current(LumenVisualPreferences? prefs = null)
    {
        var p = prefs ?? LumenClipboardStore.Shared.Preferences;
        return p.Theme == LumenThemeMode.Dark ? Dark : Light;
    }

    public LinearGradientBrush CreateSidebarBrush()
    {
        var brush = new LinearGradientBrush(SidebarTopColor, SidebarBottomColor, new Point(0, 0), new Point(1, 1));
        brush.Freeze();
        return brush;
    }

    public LinearGradientBrush CreateOrbitCardBrush()
    {
        var brush = new LinearGradientBrush(OrbitCardTopColor, OrbitCardBottomColor, new Point(0, 0), new Point(1, 1));
        brush.Freeze();
        return brush;
    }

    public Color CategoryTintColor(LumenDisplayCategory category) => category switch
    {
        LumenDisplayCategory.Text => IsDark ? Rgb(0.635, 0.675, 0.886) : Rgb(0.478, 0.510, 0.690),
        LumenDisplayCategory.Code => IsDark ? Rgb(0.569, 0.749, 0.980) : Rgb(0.357, 0.533, 0.808),
        LumenDisplayCategory.Image => IsDark ? Rgb(0.765, 0.663, 0.976) : Rgb(0.569, 0.467, 0.796),
        LumenDisplayCategory.Link => IsDark ? Rgb(0.467, 0.816, 0.816) : Rgb(0.302, 0.596, 0.608),
        LumenDisplayCategory.Color => IsDark ? Rgb(0.937, 0.643, 0.765) : Rgb(0.773, 0.427, 0.576),
        LumenDisplayCategory.File => IsDark ? Rgb(0.898, 0.753, 0.518) : Rgb(0.690, 0.549, 0.341),
        _ => AccentColor
    };

    public SolidColorBrush SourceBadgeBrush(string source)
    {
        var lower = (source ?? string.Empty).ToLowerInvariant();
        if (lower.Contains("code") || lower.Contains("studio") || lower.Contains("cursor") || lower.Contains("rider"))
        {
            return Brush(Rgb(0.337, 0.541, 0.792));
        }
        if (lower.Contains("figma") || lower.Contains("sketch") || lower.Contains("photoshop"))
        {
            return Brush(Rgb(0.612, 0.514, 0.776));
        }
        if (lower.Contains("chrome") || lower.Contains("edge") || lower.Contains("firefox") || lower.Contains("arc"))
        {
            return Brush(Rgb(0.412, 0.620, 0.569));
        }
        if (lower.Contains("explorer") || lower.Contains("finder"))
        {
            return Brush(Rgb(0.482, 0.620, 0.812));
        }
        if (lower.Contains("note") || lower.Contains("备忘"))
        {
            return Brush(Rgb(0.886, 0.678, 0.349));
        }
        return Brush(Rgb(0.478, 0.580, 0.824));
    }

    public static SolidColorBrush Brush(Color c)
    {
        var b = new SolidColorBrush(c);
        b.Freeze();
        return b;
    }

    public static Color Rgb(double r, double g, double b)
        => Color.FromRgb((byte)Math.Round(r * 255), (byte)Math.Round(g * 255), (byte)Math.Round(b * 255));

    public static Color Rgba(double r, double g, double b, double a)
        => Color.FromArgb((byte)Math.Round(a * 255), (byte)Math.Round(r * 255), (byte)Math.Round(g * 255), (byte)Math.Round(b * 255));

    public static Color WithAlpha(Color c, double alpha)
        => Color.FromArgb((byte)Math.Round(Math.Clamp(alpha, 0, 1) * 255), c.R, c.G, c.B);
}

public static class LumenFonts
{
    public static readonly FontFamily Ui = new("Segoe UI Variable, Segoe UI, Microsoft YaHei UI, sans-serif");
    public static readonly FontFamily Mono = new("Cascadia Mono, Consolas, Courier New, monospace");
    public static readonly FontFamily Icons = new("Segoe Fluent Icons, Segoe MDL2 Assets");
}

/// <summary>
/// Pure WPF vector Lumen luminous spiral brand mark (zero HTML/SVG).
/// </summary>
public sealed class LumenBrandMarkControl : FrameworkElement
{
    public LumenBrandMarkControl(double size = 30)
    {
        Width = size;
        Height = size;
    }

    protected override void OnRender(DrawingContext dc)
    {
        var w = ActualWidth > 0 ? ActualWidth : Width;
        var h = ActualHeight > 0 ? ActualHeight : Height;
        if (w <= 0 || h <= 0) return;

        var radius = Math.Min(w, h) * 0.32;
        var rect = new Rect(0, 0, w, h);
        var grad = new LinearGradientBrush
        {
            StartPoint = new Point(0, 0),
            EndPoint = new Point(1, 1)
        };
        grad.GradientStops.Add(new GradientStop(LumenPalette.Rgb(0.737, 0.914, 1.0), 0.0));
        grad.GradientStops.Add(new GradientStop(LumenPalette.Rgb(0.506, 0.600, 0.980), 0.55));
        grad.GradientStops.Add(new GradientStop(LumenPalette.Rgb(0.725, 0.627, 0.992), 1.0));
        dc.DrawRoundedRectangle(grad, null, rect, radius, radius);

        var scale = Math.Min(w, h) / 24.0;
        var ox = (w - 24 * scale) * 0.5;
        var oy = (h - 24 * scale) * 0.5;

        var geom = new StreamGeometry();
        using (var ctx = geom.Open())
        {
            Point P(double x, double y) => new(ox + x * scale, oy + (24.0 - y) * scale);
            ctx.BeginFigure(P(4.5, 11), isFilled: false, isClosed: false);
            ctx.BezierTo(P(5.5, 16), P(9.5, 19), P(13.5, 19), true, true);
            ctx.BezierTo(P(18.0, 19), P(20.5, 16), P(20.5, 13), true, true);
            ctx.BezierTo(P(20.5, 8.5), P(16.0, 5.5), P(11.5, 5.5), true, true);
            ctx.BezierTo(P(8.5, 5.5), P(7.0, 6.8), P(7.0, 8.5), true, true);
            ctx.BezierTo(P(7.0, 11.5), P(10.5, 13.5), P(13.5, 13.5), true, true);
        }
        geom.Freeze();
        var pen = new Pen(Brushes.White, 1.9 * scale)
        {
            StartLineCap = PenLineCap.Round,
            EndLineCap = PenLineCap.Round,
            LineJoin = PenLineJoin.Round
        };
        dc.DrawGeometry(null, pen, geom);
    }
}

/// <summary>
/// Pure WPF vector procedural luminous cover art for audio/video items.
/// </summary>
public sealed class LumenAlbumCoverControl : FrameworkElement
{
    private int _seedIndex;
    private string _badgeText = "LUMEN";

    public int SeedIndex
    {
        get => _seedIndex;
        set { _seedIndex = value; InvalidateVisual(); }
    }

    public string BadgeText
    {
        get => _badgeText;
        set { _badgeText = value ?? string.Empty; InvalidateVisual(); }
    }

    protected override void OnRender(DrawingContext dc)
    {
        var w = ActualWidth;
        var h = ActualHeight;
        if (w <= 2 || h <= 2) return;

        (Color C0, Color C1, Color C2)[] palettes =
        {
            (LumenPalette.Rgb(0.208, 0.282, 0.443), LumenPalette.Rgb(0.698, 0.780, 0.906), LumenPalette.Rgb(0.973, 0.851, 0.839)),
            (LumenPalette.Rgb(0.192, 0.204, 0.322), LumenPalette.Rgb(0.569, 0.533, 0.776), LumenPalette.Rgb(0.902, 0.780, 0.937)),
            (LumenPalette.Rgb(0.137, 0.341, 0.373), LumenPalette.Rgb(0.604, 0.804, 0.800), LumenPalette.Rgb(0.890, 0.914, 0.776))
        };
        var pair = palettes[Math.Abs(_seedIndex) % palettes.Length];
        var clip = new RectangleGeometry(new Rect(0, 0, w, h), 14, 14);
        dc.PushClip(clip);

        var bg = new LinearGradientBrush(pair.C0, pair.C1, new Point(0, 0), new Point(1, 1));
        dc.DrawRectangle(bg, null, new Rect(0, 0, w, h));

        var glow = new RadialGradientBrush(LumenPalette.WithAlpha(pair.C2, 0.75), LumenPalette.WithAlpha(pair.C1, 0.0))
        {
            Center = new Point(0.66, 0.32),
            GradientOrigin = new Point(0.66, 0.32),
            RadiusX = 0.52,
            RadiusY = 0.52
        };
        dc.DrawRectangle(glow, null, new Rect(0, 0, w, h));

        var cx = w * 0.5;
        var cy = h * 0.5;
        var unit = Math.Min(w, h) / 220.0;
        var ringPen = new Pen(LumenPalette.Brush(LumenPalette.WithAlpha(pair.C2, 0.55)), Math.Max(0.65, unit * 0.85));
        for (var j = 0; j < 14; j++)
        {
            dc.PushTransform(new RotateTransform(j * 9 + _seedIndex * 22, cx, cy));
            var rx = (28 + j * 5) * unit;
            var ry = (13 + j * 3) * unit;
            dc.DrawEllipse(null, ringPen, new Point(cx, cy), rx, ry);
            dc.Pop();
        }

        var orbR = 17 * unit;
        dc.DrawEllipse(LumenPalette.Brush(LumenPalette.WithAlpha(pair.C2, 0.84)), null, new Point(cx, cy), orbR, orbR);

        if (!string.IsNullOrEmpty(_badgeText))
        {
            var dpi = VisualTreeHelper.GetDpi(this).PixelsPerDip;
            var ft = new FormattedText(
                _badgeText,
                CultureInfo.InvariantCulture,
                FlowDirection.LeftToRight,
                new Typeface(LumenFonts.Mono, FontStyles.Normal, FontWeights.SemiBold, FontStretches.Normal),
                Math.Max(8.5, 10.5 * unit),
                LumenPalette.Brush(LumenPalette.WithAlpha(Colors.White, 0.90)),
                dpi);
            dc.DrawText(ft, new Point(12 * unit, h - ft.Height - 10 * unit));
        }

        dc.Pop();
    }
}

/// <summary>
/// Pure WPF vector miniature Orbit material preview inside Settings.
/// </summary>
public sealed class LumenMiniOrbitPreviewControl : FrameworkElement
{
    protected override void OnRender(DrawingContext dc)
    {
        var w = ActualWidth;
        var h = ActualHeight;
        if (w <= 4 || h <= 4) return;

        var clip = new RectangleGeometry(new Rect(0, 0, w, h), 13, 13);
        dc.PushClip(clip);

        var bg = new LinearGradientBrush
        {
            StartPoint = new Point(0, 0),
            EndPoint = new Point(1, 1)
        };
        bg.GradientStops.Add(new GradientStop(LumenPalette.Rgb(0.090, 0.149, 0.255), 0.0));
        bg.GradientStops.Add(new GradientStop(LumenPalette.Rgb(0.333, 0.447, 0.643), 0.58));
        bg.GradientStops.Add(new GradientStop(LumenPalette.Rgb(0.557, 0.510, 0.714), 1.0));
        dc.DrawRectangle(bg, null, new Rect(0, 0, w, h));

        var dpi = VisualTreeHelper.GetDpi(this).PixelsPerDip;
        var ft = new FormattedText(
            "ORBIT / LIVE MATERIAL",
            CultureInfo.InvariantCulture,
            FlowDirection.LeftToRight,
            new Typeface(LumenFonts.Mono, FontStyles.Normal, FontWeights.SemiBold, FontStretches.Normal),
            10,
            LumenPalette.Brush(LumenPalette.WithAlpha(Colors.White, 0.76)),
            dpi);
        dc.DrawText(ft, new Point(16, 12));

        const int count = 5;
        const double cardW = 68;
        const double cardH = 72;
        const double gap = 10;
        var totalW = count * cardW + (count - 1) * gap;
        var startX = (w - totalW) * 0.5;
        for (var i = 0; i < count; i++)
        {
            var isCenter = i == 2;
            var x = startX + i * (cardW + gap);
            var y = h - cardH - (isCenter ? 20 : 12);
            var fill = LumenPalette.Brush(LumenPalette.WithAlpha(Colors.White, isCenter ? 0.36 : 0.20));
            var stroke = new Pen(LumenPalette.Brush(LumenPalette.WithAlpha(Colors.White, isCenter ? 0.92 : 0.45)), isCenter ? 1.5 : 1.0);
            dc.DrawRoundedRectangle(fill, stroke, new Rect(x, y, cardW, cardH), 10, 10);
        }

        dc.Pop();
    }
}

/// <summary>
/// Pure C#/WPF syntax highlighter emitting colored WPF <see cref="Run"/> spans (zero HTML/WebView).
/// </summary>
public static class LumenSyntaxHighlighter
{
    private static readonly Dictionary<string, HashSet<string>> KeywordsByLang = new(StringComparer.OrdinalIgnoreCase)
    {
        ["js"] = MakeSet("async function await return const let var new if else for while class import export from throw try catch true false null undefined switch case break continue"),
        ["ts"] = MakeSet("async function await return const let var new if else for while class import export from type interface extends implements readonly public private protected true false null string number boolean void"),
        ["go"] = MakeSet("package import func return if else for range var const type struct interface defer go select switch case default nil true false error map chan make len cap"),
        ["swift"] = MakeSet("import func return if else guard let var struct class final enum protocol extension private fileprivate public internal static override init deinit self Self true false nil switch case break continue where throw throws try catch async await in"),
        ["cs"] = MakeSet("using namespace public private protected internal static readonly sealed partial class struct record interface enum void var new return if else switch case break continue for foreach while do try catch finally throw async await true false null this base override virtual abstract get set init"),
        ["php"] = MakeSet("namespace use final class extends implements public private protected function return new if else foreach for while static true false null echo throw try catch"),
        ["py"] = MakeSet("from import as def async await return class if elif else for in while with try except finally raise True False None pass yield lambda and or not"),
        ["rust"] = MakeSet("fn let mut pub struct enum impl trait for in while loop if else match return use mod crate self Self true false Some None Ok Err async await"),
        ["sql"] = MakeSet("SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER LIMIT INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER DROP AS AND OR NOT IN IS NULL"),
        ["json"] = MakeSet("true false null"),
        ["css"] = MakeSet("important inherit initial unset none auto flex grid")
    };

    private static readonly Regex TokenRegex = new(
        @"(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|""(?:\\.|[^""\\])*""|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\$[A-Za-z_]\w*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)",
        RegexOptions.Compiled);

    private static HashSet<string> MakeSet(string words)
        => new(words.Split(' ', StringSplitOptions.RemoveEmptyEntries), StringComparer.Ordinal);

    /// <summary>
    /// Populates a WPF <see cref="FlowDocument"/> with syntax-colored spans and aligned line-number gutter.
    /// </summary>
    public static FlowDocument BuildCodeDocument(string source, string language, double fontSize = 13.0, bool includeLineNumbers = true, bool darkCanvas = true)
    {
        var clamped = source.Length > 48_000 ? source[..48_000] + "\n… (已截断)" : source;
        var doc = new FlowDocument
        {
            FontFamily = LumenFonts.Mono,
            FontSize = fontSize,
            PagePadding = new Thickness(16),
            Background = darkCanvas ? LumenPalette.Dark.CodeBackground : Brushes.Transparent,
            Foreground = darkCanvas ? LumenPalette.Dark.CodeBaseText : LumenPalette.Light.Ink
        };

        var lines = clamped.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
        var gutterWidth = Math.Max(3, lines.Length.ToString(CultureInfo.InvariantCulture).Length);
        var gutterBrush = LumenPalette.Dark.CodeGutterText;

        var paragraph = new Paragraph
        {
            Margin = new Thickness(0),
            LineHeight = fontSize * 1.52,
            LineStackingStrategy = LineStackingStrategy.BlockLineHeight
        };

        var lang = (language ?? "js").ToLowerInvariant();
        var keywords = KeywordsByLang.TryGetValue(lang, out var kw) ? kw : KeywordsByLang["js"];
        var palette = GetTokenBrushes(lang, darkCanvas);

        for (var lineIdx = 0; lineIdx < lines.Length; lineIdx++)
        {
            if (includeLineNumbers)
            {
                var prefix = (lineIdx + 1).ToString(CultureInfo.InvariantCulture).PadLeft(gutterWidth) + "   ";
                paragraph.Inlines.Add(new Run(prefix) { Foreground = gutterBrush });
            }
            AppendHighlightedInlines(paragraph.Inlines, lines[lineIdx], lang, keywords, palette);
            if (lineIdx < lines.Length - 1)
            {
                paragraph.Inlines.Add(new LineBreak());
            }
        }

        doc.Blocks.Add(paragraph);
        return doc;
    }

    /// <summary>
    /// Populates a WPF <see cref="TextBlock"/> with compact syntax-colored inline runs (for cards/inspector).
    /// </summary>
    public static void PopulateCodeTextBlock(TextBlock tb, string source, string language, double fontSize = 10.5, bool darkCanvas = true)
    {
        tb.Inlines.Clear();
        tb.FontFamily = LumenFonts.Mono;
        tb.FontSize = fontSize;
        var clamped = source.Length > 650 ? source[..650] : source;
        var lang = (language ?? "js").ToLowerInvariant();
        var keywords = KeywordsByLang.TryGetValue(lang, out var kw) ? kw : KeywordsByLang["js"];
        var palette = GetTokenBrushes(lang, darkCanvas);
        AppendHighlightedInlines(tb.Inlines, clamped.Replace("\r\n", "\n", StringComparison.Ordinal), lang, keywords, palette);
    }

    private readonly record struct SyntaxBrushes(
        SolidColorBrush Base,
        SolidColorBrush Comment,
        SolidColorBrush String,
        SolidColorBrush Number,
        SolidColorBrush Variable,
        SolidColorBrush Function,
        SolidColorBrush Keyword);

    private static SyntaxBrushes GetTokenBrushes(string lang, bool dark)
    {
        var baseB = LumenPalette.Brush(dark ? LumenPalette.Rgb(0.859, 0.902, 0.976) : LumenPalette.Rgb(0.165, 0.212, 0.302));
        var commentB = LumenPalette.Brush(dark ? LumenPalette.Rgb(0.471, 0.541, 0.651) : LumenPalette.Rgb(0.510, 0.576, 0.647));
        var strB = LumenPalette.Brush(dark ? LumenPalette.Rgb(0.651, 0.851, 0.608) : LumenPalette.Rgb(0.271, 0.584, 0.408));
        var numB = LumenPalette.Brush(dark ? LumenPalette.Rgb(0.953, 0.745, 0.525) : LumenPalette.Rgb(0.776, 0.545, 0.310));
        var varB = LumenPalette.Brush(dark ? LumenPalette.Rgb(0.922, 0.569, 0.678) : LumenPalette.Rgb(0.741, 0.325, 0.471));
        var funcB = LumenPalette.Brush(dark ? LumenPalette.Rgb(0.522, 0.784, 0.941) : LumenPalette.Rgb(0.231, 0.510, 0.741));
        var kwColor = lang switch
        {
            "go" => dark ? LumenPalette.Rgb(0.502, 0.863, 0.949) : LumenPalette.Rgb(0.196, 0.529, 0.678),
            "py" => dark ? LumenPalette.Rgb(0.949, 0.769, 0.471) : LumenPalette.Rgb(0.690, 0.478, 0.192),
            "cs" => dark ? LumenPalette.Rgb(0.576, 0.749, 1.0) : LumenPalette.Rgb(0.212, 0.435, 0.780),
            _ => dark ? LumenPalette.Rgb(0.776, 0.647, 1.0) : LumenPalette.Rgb(0.549, 0.416, 0.780)
        };
        return new SyntaxBrushes(baseB, commentB, strB, numB, varB, funcB, LumenPalette.Brush(kwColor));
    }

    private static void AppendHighlightedInlines(InlineCollection inlines, string text, string lang, HashSet<string> keywords, SyntaxBrushes b)
    {
        if (string.IsNullOrEmpty(text)) return;
        var pos = 0;
        foreach (Match match in TokenRegex.Matches(text))
        {
            if (match.Index > pos)
            {
                inlines.Add(new Run(text[pos..match.Index]) { Foreground = b.Base });
            }
            var token = match.Value;
            SolidColorBrush brush = b.Base;
            if (token.StartsWith("//", StringComparison.Ordinal)
                || token.StartsWith("/*", StringComparison.Ordinal)
                || ((lang is "py" or "sh" or "yaml") && token.StartsWith('#')))
            {
                brush = b.Comment;
            }
            else if (token.StartsWith('"') || token.StartsWith('\'') || token.StartsWith('`'))
            {
                brush = b.String;
            }
            else if (token.StartsWith('$'))
            {
                brush = b.Variable;
            }
            else if (char.IsDigit(token[0]))
            {
                brush = b.Number;
            }
            else if (keywords.Contains(token) || (lang == "sql" && keywords.Contains(token.ToUpperInvariant())))
            {
                brush = b.Keyword;
            }
            else if (match.Index + match.Length < text.Length && text[match.Index + match.Length] == '(')
            {
                brush = b.Function;
            }
            inlines.Add(new Run(token) { Foreground = brush });
            pos = match.Index + match.Length;
        }
        if (pos < text.Length)
        {
            inlines.Add(new Run(text[pos..]) { Foreground = b.Base });
        }
    }
}

/// <summary>
/// Clean native WPF toggle switch matching Lumen V7 pill aesthetics (no WebView/HTML).
/// </summary>
public sealed class LumenToggleSwitch : Border
{
    private readonly Border _knob;
    private readonly TranslateTransform _knobShift = new();
    private bool _isOn;

    public event Action<bool>? Toggled;

    public bool IsOn
    {
        get => _isOn;
        set
        {
            if (_isOn == value) return;
            _isOn = value;
            UpdateVisual(animate: false);
        }
    }

    public LumenToggleSwitch(bool initialOn, LumenPalette palette)
    {
        _isOn = initialOn;
        Width = 40;
        Height = 22;
        CornerRadius = new CornerRadius(11);
        Padding = new Thickness(3);
        Cursor = Cursors.Hand;
        VerticalAlignment = VerticalAlignment.Center;
        HorizontalAlignment = HorizontalAlignment.Right;

        _knob = new Border
        {
            Width = 16,
            Height = 16,
            CornerRadius = new CornerRadius(8),
            Background = Brushes.White,
            HorizontalAlignment = HorizontalAlignment.Left,
            RenderTransform = _knobShift
        };
        Child = _knob;

        MouseLeftButtonUp += (_, e) =>
        {
            e.Handled = true;
            _isOn = !_isOn;
            UpdateVisual(animate: true);
            Toggled?.Invoke(_isOn);
        };

        ApplyPalette(palette);
        UpdateVisual(animate: false);
    }

    private LumenPalette _palette = LumenPalette.Light;

    public void ApplyPalette(LumenPalette palette)
    {
        _palette = palette;
        UpdateVisual(animate: false);
    }

    private void UpdateVisual(bool animate)
    {
        Background = _isOn
            ? _palette.Accent
            : LumenPalette.Brush(_palette.IsDark ? LumenPalette.Rgb(0.25, 0.30, 0.39) : LumenPalette.Rgb(0.73, 0.78, 0.84));
        var targetX = _isOn ? 18.0 : 0.0;
        if (animate && LumenMotion.IsEnabled)
        {
            var anim = new DoubleAnimation(targetX, TimeSpan.FromMilliseconds(180))
            {
                EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
            };
            _knobShift.BeginAnimation(TranslateTransform.XProperty, anim, HandoffBehavior.SnapshotAndReplace);
        }
        else
        {
            _knobShift.BeginAnimation(TranslateTransform.XProperty, null);
            _knobShift.X = targetX;
        }
    }
}

/// <summary>
/// Shared WPF control factories obeying Lumen V7 and repo visual rules
/// (uniform 1px borders, rounded fills, semantic icons, zero left thick accent bars).
/// </summary>
public static class LumenUiFactory
{
    public static TextBlock CreateGlyph(string glyph, double size, Brush foreground)
    {
        return new TextBlock
        {
            Text = glyph,
            FontFamily = LumenFonts.Icons,
            FontSize = size,
            Foreground = foreground,
            VerticalAlignment = VerticalAlignment.Center,
            HorizontalAlignment = HorizontalAlignment.Center,
            TextAlignment = TextAlignment.Center
        };
    }

    public static Button CreateIconButton(string glyph, string tooltip, LumenPalette palette, Action onClick, double width = 30, double height = 28, Brush? tintOverride = null)
    {
        var border = new Border
        {
            Width = width,
            Height = height,
            CornerRadius = new CornerRadius(7),
            Background = Brushes.Transparent,
            Child = CreateGlyph(glyph, 13.5, tintOverride ?? palette.Muted)
        };
        var btn = CreateBorderlessButton(border, tooltip, onClick);
        btn.MouseEnter += (_, _) => border.Background = LumenPalette.Brush(LumenPalette.WithAlpha(palette.AccentColor, 0.14));
        btn.MouseLeave += (_, _) => border.Background = Brushes.Transparent;
        return btn;
    }

    public static Button CreatePillButton(string label, LumenPalette palette, Action onClick, bool darkSurface = false, bool primary = false, bool danger = false, string? glyph = null)
    {
        var bg = primary
            ? palette.Accent
            : (danger
                ? palette.DangerSoft
                : (darkSurface
                    ? LumenPalette.Brush(LumenPalette.WithAlpha(Colors.White, 0.08))
                    : palette.SurfaceElevated));
        var borderBrush = primary
            ? palette.Accent
            : (danger
                ? LumenPalette.Brush(LumenPalette.WithAlpha(palette.DangerColor, 0.38))
                : (darkSurface
                    ? LumenPalette.Brush(LumenPalette.WithAlpha(Colors.White, 0.16))
                    : palette.Border));
        var fg = primary
            ? Brushes.White
            : (danger ? palette.Danger : (darkSurface ? palette.CodeBaseText : palette.Ink));

        var stack = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center,
            HorizontalAlignment = HorizontalAlignment.Center
        };
        if (!string.IsNullOrEmpty(glyph))
        {
            var icon = CreateGlyph(glyph, 12.5, fg);
            icon.Margin = new Thickness(0, 0, 6, 0);
            stack.Children.Add(icon);
        }
        stack.Children.Add(new TextBlock
        {
            Text = label,
            FontFamily = LumenFonts.Ui,
            FontSize = primary ? 12.5 : 11.5,
            FontWeight = primary ? FontWeights.SemiBold : FontWeights.Medium,
            Foreground = fg,
            VerticalAlignment = VerticalAlignment.Center
        });

        var border = new Border
        {
            CornerRadius = new CornerRadius(primary ? 9 : 7),
            Background = bg,
            BorderBrush = borderBrush,
            BorderThickness = new Thickness(1),
            Padding = new Thickness(primary ? 14 : 10, primary ? 7 : 4, primary ? 14 : 10, primary ? 7 : 4),
            MinHeight = primary ? 34 : 26,
            Child = stack
        };

        var btn = CreateBorderlessButton(border, null, onClick);
        btn.MouseEnter += (_, _) =>
        {
            border.Opacity = 0.88;
        };
        btn.MouseLeave += (_, _) =>
        {
            border.Opacity = 1.0;
        };
        return btn;
    }

    public static Button CreateBorderlessButton(UIElement content, string? tooltip, Action onClick)
    {
        var tpl = new ControlTemplate(typeof(Button));
        var presenter = new FrameworkElementFactory(typeof(ContentPresenter));
        presenter.SetValue(FrameworkElement.HorizontalAlignmentProperty, HorizontalAlignment.Stretch);
        presenter.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Stretch);
        tpl.VisualTree = presenter;

        var btn = new Button
        {
            Content = content,
            Template = tpl,
            Background = Brushes.Transparent,
            BorderThickness = new Thickness(0),
            Cursor = Cursors.Hand,
            Focusable = false,
            ToolTip = string.IsNullOrEmpty(tooltip) ? null : tooltip
        };
        btn.Click += (_, e) =>
        {
            e.Handled = true;
            onClick();
        };
        return btn;
    }
}
