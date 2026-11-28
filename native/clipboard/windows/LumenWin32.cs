using System.Collections.Concurrent;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace AihLumenClipboard;

/// <summary>
/// Coordinates WPF Application lifetime and optional WinForms modeless keyboard interop
/// so the pure WPF Paste Lumen V7 library has zero direct dependency on System.Windows.Forms.
/// </summary>
public static class LumenWpfHost
{
    private static readonly object InitLock = new();
    private static Action<Window>? _modelessKeyboardInterop;
    private static bool _isWinFormsHosted;

    public static bool IsWinFormsHosted => _isWinFormsHosted;

    /// <summary>
    /// Ensures a WPF <see cref="Application"/> exists on the current STA thread.
    /// Pass <paramref name="modelessKeyboardInterop"/> (e.g. ElementHost.EnableModelessKeyboardInterop)
    /// when hosting WPF windows inside a WinForms message pump.
    /// </summary>
    public static void EnsureInitialized(bool winFormsHosted = false, Action<Window>? modelessKeyboardInterop = null)
    {
        lock (InitLock)
        {
            _isWinFormsHosted = winFormsHosted;
            if (modelessKeyboardInterop is not null)
            {
                _modelessKeyboardInterop = modelessKeyboardInterop;
            }
            if (Application.Current is null)
            {
                _ = new Application
                {
                    ShutdownMode = ShutdownMode.OnExplicitShutdown
                };
            }
        }
    }

    public static void AttachWindowInterop(Window window)
    {
        if (_isWinFormsHosted && _modelessKeyboardInterop is not null)
        {
            _modelessKeyboardInterop(window);
        }
    }

    public static void RunOnUi(Action action)
    {
        var dispatcher = Application.Current?.Dispatcher;
        if (dispatcher is null || dispatcher.HasShutdownStarted || dispatcher.HasShutdownFinished)
        {
            action();
            return;
        }
        if (dispatcher.CheckAccess())
        {
            action();
        }
        else
        {
            _ = dispatcher.BeginInvoke(DispatcherPriority.Normal, action);
        }
    }
}

/// <summary>
/// Physical pixel geometry and Per-Monitor V2 DPI descriptor for one Windows display.
/// </summary>
public readonly record struct LumenMonitorInfo(
    IntPtr Handle,
    LumenWin32.RECT BoundsPx,
    LumenWin32.RECT WorkAreaPx,
    uint DpiX,
    uint DpiY,
    bool IsPrimary)
{
    public double ScaleX => DpiX > 0 ? DpiX / 96.0 : 1.0;
    public double ScaleY => DpiY > 0 ? DpiY / 96.0 : 1.0;
}

/// <summary>
/// Win32 / DWM / Shell / Monitor P/Invoke helpers for native Windows 10/11 surfaces.
/// </summary>
public static class LumenWin32
{
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    public const int WS_EX_NOACTIVATE = 0x08000000;

    public const int WM_NCCALCSIZE = 0x0083;
    public const int WM_MOUSEACTIVATE = 0x0021;
    public const int WM_DISPLAYCHANGE = 0x007E;
    public const int WM_DPICHANGED = 0x02E0;
    public const int MA_NOACTIVATE = 3;

    public static readonly IntPtr HWND_TOPMOST = new(-1);
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOZORDER = 0x0004;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_FRAMECHANGED = 0x0020;
    public const uint SWP_SHOWWINDOW = 0x0040;

    private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const int DWMWA_SYSTEMBACKDROP_TYPE = 38;

    public const int DWMWCP_DEFAULT = 0;
    public const int DWMWCP_DONOTROUND = 1;
    public const int DWMWCP_ROUND = 2;

    public const int DWMSBT_AUTO = 0;
    public const int DWMSBT_NONE = 1;
    public const int DWMSBT_MAINWINDOW = 2;      // Mica
    public const int DWMSBT_TRANSIENTWINDOW = 3; // Acrylic
    public const int DWMSBT_TABBEDWINDOW = 4;    // Mica Alt

    private const uint MONITORINFOF_PRIMARY = 0x00000001;
    private const uint MONITOR_DEFAULTTONEAREST = 0x00000002;
    private const int MDT_EFFECTIVE_DPI = 0;

    private const uint SHGFI_ICON = 0x000000100;
    private const uint SHGFI_LARGEICON = 0x000000000;
    private const uint SHGFI_USEFILEATTRIBUTES = 0x000000010;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;

    private static readonly ConcurrentDictionary<string, BitmapSource?> ShellIconCache = new(StringComparer.OrdinalIgnoreCase);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;

        public int Width => Right - Left;
        public int Height => Bottom - Top;

        public bool Contains(int x, int y) => x >= Left && x < Right && y >= Top && y < Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MARGINS
    {
        public int LeftWidth;
        public int RightWidth;
        public int TopHeight;
        public int BottomHeight;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    private enum AccentState
    {
        ACCENT_DISABLED = 0,
        ACCENT_ENABLE_GRADIENT = 1,
        ACCENT_ENABLE_TRANSPARENTGRADIENT = 2,
        ACCENT_ENABLE_BLURBEHIND = 3,
        ACCENT_ENABLE_ACRYLICBLURBEHIND = 4,
        ACCENT_INVALID_STATE = 5
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AccentPolicy
    {
        public AccentState AccentState;
        public int AccentFlags;
        public uint GradientColor;
        public int AnimationId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WindowCompositionAttributeData
    {
        public int Attribute;
        public IntPtr Data;
        public int SizeOfData;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHFILEINFO
    {
        public IntPtr hIcon;
        public int iIcon;
        public uint dwAttributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szDisplayName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)]
        public string szTypeName;
    }

    private delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdcMonitor, ref RECT lprcMonitor, IntPtr dwData);

    /// <summary>
    /// Applies DWM dark mode, corner preference, full-frame glass extension, and Mica/Acrylic backdrop.
    /// Returns true if a native DWM backdrop (Win11 SystemBackdrop or Win10 Acrylic) succeeded.
    /// </summary>
    public static bool ApplyDwmBackdrop(
        IntPtr hwnd,
        bool darkMode,
        int backdropType,
        int cornerPreference,
        bool extendGlassFrame = true,
        bool allowWin10AcrylicFallback = false)
    {
        if (hwnd == IntPtr.Zero) return false;
        var backdropApplied = false;
        try
        {
            var dark = darkMode ? 1 : 0;
            _ = DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, sizeof(int));

            var corner = cornerPreference;
            _ = DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref corner, sizeof(int));

            if (extendGlassFrame)
            {
                var margins = new MARGINS { LeftWidth = -1, RightWidth = -1, TopHeight = -1, BottomHeight = -1 };
                _ = DwmExtendFrameIntoClientArea(hwnd, ref margins);
            }

            if (OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22621))
            {
                var sbt = backdropType;
                if (DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, ref sbt, sizeof(int)) == 0)
                {
                    backdropApplied = true;
                }
            }

            if (!backdropApplied && allowWin10AcrylicFallback)
            {
                // ABGR tint for Windows 10 SetWindowCompositionAttribute acrylic fallback.
                uint tintAbgr = darkMode ? 0xB028180Eu : 0x80F6EBDCu;
                backdropApplied = TryApplyWin10Acrylic(hwnd, tintAbgr);
            }
        }
        catch
        {
            // Older Windows builds or remote desktop sessions without DWM composition gracefully fall back.
        }
        return backdropApplied;
    }

    private static bool TryApplyWin10Acrylic(IntPtr hwnd, uint abgrTint)
    {
        try
        {
            var accent = new AccentPolicy
            {
                AccentState = AccentState.ACCENT_ENABLE_ACRYLICBLURBEHIND,
                AccentFlags = 2,
                GradientColor = abgrTint,
                AnimationId = 0
            };
            var size = Marshal.SizeOf<AccentPolicy>();
            var ptr = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(accent, ptr, false);
                var data = new WindowCompositionAttributeData
                {
                    Attribute = 19, // WCA_ACCENT_POLICY
                    Data = ptr,
                    SizeOfData = size
                };
                return SetWindowCompositionAttribute(hwnd, ref data) != 0;
            }
            finally
            {
                Marshal.FreeHGlobal(ptr);
            }
        }
        catch
        {
            return false;
        }
    }

    public static void ApplyNonActivatingToolWindowStyle(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return;
        var exStyle = GetWindowLongPtrSafe(hwnd, GWL_EXSTYLE).ToInt64();
        exStyle |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
        SetWindowLongPtrSafe(hwnd, GWL_EXSTYLE, new IntPtr(exStyle));
        SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    }

    public static void SetBoundsPhysicalPx(IntPtr hwnd, int x, int y, int width, int height, bool topmost, bool noActivate)
    {
        if (hwnd == IntPtr.Zero) return;
        uint flags = SWP_NOACTIVATE;
        if (!noActivate) flags = 0;
        if (!topmost) flags |= SWP_NOZORDER;
        SetWindowPos(hwnd, topmost ? HWND_TOPMOST : IntPtr.Zero, x, y, Math.Max(1, width), Math.Max(1, height), flags);
    }

    public static bool TryGetWindowBoundsPx(IntPtr hwnd, out RECT rect)
    {
        rect = default;
        return hwnd != IntPtr.Zero && GetWindowRect(hwnd, out rect);
    }

    public static IntPtr GetCurrentForegroundWindow() => GetForegroundWindow();

    /// <summary>
    /// Restores foreground activation to a previously recorded window without throwing if it closed.
    /// </summary>
    public static void RestoreForegroundWindow(IntPtr targetHwnd)
    {
        if (targetHwnd == IntPtr.Zero || !IsWindow(targetHwnd)) return;
        try
        {
            var currentFg = GetForegroundWindow();
            if (currentFg == targetHwnd) return;
            var fgThread = currentFg != IntPtr.Zero ? GetWindowThreadProcessId(currentFg, out _) : 0;
            var targetThread = GetWindowThreadProcessId(targetHwnd, out _);
            var curThread = GetCurrentThreadId();
            var attachedFg = false;
            var attachedTarget = false;
            try
            {
                if (fgThread != 0 && fgThread != curThread)
                {
                    attachedFg = AttachThreadInput(curThread, fgThread, true);
                }
                if (targetThread != 0 && targetThread != curThread && targetThread != fgThread)
                {
                    attachedTarget = AttachThreadInput(curThread, targetThread, true);
                }
                SetForegroundWindow(targetHwnd);
            }
            finally
            {
                if (attachedTarget) AttachThreadInput(curThread, targetThread, false);
                if (attachedFg) AttachThreadInput(curThread, fgThread, false);
            }
        }
        catch
        {
            // Best-effort focus restoration.
        }
    }

    public static POINT GetCursorPositionPx()
    {
        return GetCursorPos(out var pt) ? pt : default;
    }

    public static List<LumenMonitorInfo> EnumerateMonitors()
    {
        var list = new List<LumenMonitorInfo>();
        MonitorEnumProc callback = (IntPtr hMon, IntPtr _, ref RECT _, IntPtr _) =>
        {
            var info = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
            if (GetMonitorInfoW(hMon, ref info))
            {
                uint dpiX = 96, dpiY = 96;
                try
                {
                    if (GetDpiForMonitor(hMon, MDT_EFFECTIVE_DPI, out var x, out var y) == 0 && x > 0 && y > 0)
                    {
                        dpiX = x;
                        dpiY = y;
                    }
                }
                catch { }
                list.Add(new LumenMonitorInfo(
                    hMon,
                    info.rcMonitor,
                    info.rcWork,
                    dpiX,
                    dpiY,
                    (info.dwFlags & MONITORINFOF_PRIMARY) != 0));
            }
            return true;
        };
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
        if (list.Count == 0)
        {
            list.Add(new LumenMonitorInfo(
                IntPtr.Zero,
                new RECT { Left = 0, Top = 0, Right = 1920, Bottom = 1080 },
                new RECT { Left = 0, Top = 0, Right = 1920, Bottom = 1040 },
                96,
                96,
                true));
        }
        return list;
    }

    public static LumenMonitorInfo GetActiveMonitor(List<LumenMonitorInfo> monitors)
    {
        var cursor = GetCursorPositionPx();
        foreach (var mon in monitors)
        {
            if (mon.BoundsPx.Contains(cursor.X, cursor.Y))
            {
                return mon;
            }
        }
        var fg = GetForegroundWindow();
        if (fg != IntPtr.Zero)
        {
            var hMon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
            foreach (var mon in monitors)
            {
                if (mon.Handle == hMon) return mon;
            }
        }
        foreach (var mon in monitors)
        {
            if (mon.IsPrimary) return mon;
        }
        return monitors[0];
    }

    public static double GetDpiScaleForWindow(Window window)
    {
        var dpi = VisualTreeHelper.GetDpi(window);
        return dpi.DpiScaleX > 0 ? dpi.DpiScaleX : 1.0;
    }

    /// <summary>
    /// Extracts a frozen WPF <see cref="BitmapSource"/> shell icon via SHGetFileInfoW and destroys the HICON immediately.
    /// </summary>
    public static BitmapSource? ExtractShellIcon(string? filePath)
    {
        if (string.IsNullOrWhiteSpace(filePath)) return null;
        var cacheKey = File.Exists(filePath)
            ? filePath
            : "ext:" + Path.GetExtension(filePath).ToLowerInvariant();
        if (ShellIconCache.TryGetValue(cacheKey, out var cached)) return cached;

        BitmapSource? result = null;
        try
        {
            var shfi = new SHFILEINFO();
            uint flags = SHGFI_ICON | SHGFI_LARGEICON;
            uint attrs = 0;
            if (!File.Exists(filePath) && !Directory.Exists(filePath))
            {
                flags |= SHGFI_USEFILEATTRIBUTES;
                attrs = FILE_ATTRIBUTE_NORMAL;
            }
            var ret = SHGetFileInfoW(filePath, attrs, ref shfi, (uint)Marshal.SizeOf<SHFILEINFO>(), flags);
            if (ret != IntPtr.Zero && shfi.hIcon != IntPtr.Zero)
            {
                try
                {
                    var src = Imaging.CreateBitmapSourceFromHIcon(
                        shfi.hIcon,
                        Int32Rect.Empty,
                        BitmapSizeOptions.FromEmptyOptions());
                    src.Freeze();
                    result = src;
                }
                finally
                {
                    DestroyIcon(shfi.hIcon);
                }
            }
        }
        catch
        {
            result = null;
        }

        if (ShellIconCache.Count > 256)
        {
            ShellIconCache.Clear();
        }
        ShellIconCache[cacheKey] = result;
        return result;
    }

    private static IntPtr GetWindowLongPtrSafe(IntPtr hWnd, int nIndex)
        => IntPtr.Size == 8 ? GetWindowLongPtr64(hWnd, nIndex) : new IntPtr(GetWindowLong32(hWnd, nIndex));

    private static IntPtr SetWindowLongPtrSafe(IntPtr hWnd, int nIndex, IntPtr dwNewLong)
        => IntPtr.Size == 8 ? SetWindowLongPtr64(hWnd, nIndex, dwNewLong) : new IntPtr(SetWindowLong32(hWnd, nIndex, dwNewLong.ToInt32()));

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    [DllImport("dwmapi.dll")]
    private static extern int DwmExtendFrameIntoClientArea(IntPtr hWnd, ref MARGINS pMarInset);

    [DllImport("user32.dll")]
    private static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WindowCompositionAttributeData data);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW", SetLastError = true)]
    private static extern int GetWindowLong32(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongW", SetLastError = true)]
    private static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, [MarshalAs(UnmanagedType.Bool)] bool fAttach);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumProc lpfnEnum, IntPtr dwData);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMonitorInfoW(IntPtr hMonitor, ref MONITORINFO lpmi);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

    [DllImport("shcore.dll")]
    private static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SHGetFileInfoW(string pszPath, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyIcon(IntPtr hIcon);
}

/// <summary>
/// Temporary WH_KEYBOARD_LL + WH_MOUSE_LL monitor installed ONLY while the non-activating
/// Orbit rail is visible, allowing full keyboard control (arrows, 1-9, Enter, Space, Delete,
/// Ctrl+Z, Esc) and outside-click dismissal without ever stealing OS focus from the active editor.
/// Uses static delegate roots so GC never collects unmanaged hook callbacks.
/// </summary>
internal sealed class LumenOrbitInputHook : IDisposable
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int VK_CONTROL = 0x11;
    private const int VK_MENU = 0x12;
    private const int VK_SHIFT = 0x10;
    private const int VK_LWIN = 0x5B;
    private const int VK_RWIN = 0x5C;

    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    private static readonly HookProc StaticKeyboardProc = KeyboardCallback;
    private static readonly HookProc StaticMouseProc = MouseCallback;
    private static LumenOrbitInputHook? _active;

    private IntPtr _kbHook = IntPtr.Zero;
    private IntPtr _mouseHook = IntPtr.Zero;
    private Func<int, bool, bool, bool, bool>? _onKeyDown;
    private Action<int, int>? _onMouseDown;

    public bool IsInstalled => _kbHook != IntPtr.Zero || _mouseHook != IntPtr.Zero;

    public void Install(
        Func<int, bool, bool, bool, bool> onKeyDown,
        Action<int, int> onMouseDown)
    {
        Uninstall();
        _onKeyDown = onKeyDown;
        _onMouseDown = onMouseDown;
        _active = this;
        var module = GetModuleHandleW(null);
        _kbHook = SetWindowsHookExW(WH_KEYBOARD_LL, StaticKeyboardProc, module, 0);
        _mouseHook = SetWindowsHookExW(WH_MOUSE_LL, StaticMouseProc, module, 0);
    }

    public void Uninstall()
    {
        if (_kbHook != IntPtr.Zero)
        {
            UnhookWindowsHookEx(_kbHook);
            _kbHook = IntPtr.Zero;
        }
        if (_mouseHook != IntPtr.Zero)
        {
            UnhookWindowsHookEx(_mouseHook);
            _mouseHook = IntPtr.Zero;
        }
        if (ReferenceEquals(_active, this))
        {
            _active = null;
        }
        _onKeyDown = null;
        _onMouseDown = null;
    }

    public void Dispose()
    {
        Uninstall();
        GC.SuppressFinalize(this);
    }

    private static IntPtr KeyboardCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        var inst = _active;
        if (nCode >= 0 && inst is not null && lParam != IntPtr.Zero)
        {
            var msg = wParam.ToInt32();
            if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN)
            {
                var kb = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
                var ctrl = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
                var alt = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
                var shift = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
                var win = (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0 || (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0;
                if (!win && !alt && inst._onKeyDown is not null)
                {
                    var handled = inst._onKeyDown((int)kb.vkCode, ctrl, alt, shift);
                    if (handled)
                    {
                        return new IntPtr(1);
                    }
                }
            }
        }
        return CallNextHookEx(inst?._kbHook ?? IntPtr.Zero, nCode, wParam, lParam);
    }

    private static IntPtr MouseCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        var inst = _active;
        if (nCode >= 0 && inst is not null && lParam != IntPtr.Zero)
        {
            var msg = wParam.ToInt32();
            if (msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN)
            {
                var ms = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
                var cb = inst._onMouseDown;
                if (cb is not null)
                {
                    var x = ms.pt.X;
                    var y = ms.pt.Y;
                    LumenWpfHost.RunOnUi(() => cb(x, y));
                }
            }
        }
        return CallNextHookEx(inst?._mouseHook ?? IntPtr.Zero, nCode, wParam, lParam);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT
    {
        public LumenWin32.POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr SetWindowsHookExW(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr GetModuleHandleW(string? lpModuleName);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);
}
