using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AihTranslation;

internal static class ProtocolIo
{
    internal static readonly StreamReader Input = new(
        Console.OpenStandardInput(),
        new UTF8Encoding(false),
        detectEncodingFromByteOrderMarks: true,
        bufferSize: 4096,
        leaveOpen: true);
    internal static readonly StreamWriter Output = new(
        Console.OpenStandardOutput(),
        new UTF8Encoding(false),
        bufferSize: 4096,
        leaveOpen: true)
    {
        AutoFlush = true
    };

}

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        if (Environment.GetCommandLineArgs().Contains("--protocol-only", StringComparer.OrdinalIgnoreCase))
        {
            TranslationProtocolOnly.Run();
            return;
        }
        ApplicationConfiguration.Initialize();
        // A WinExe launched with redirected pipes (the normal AIH helper mode)
        // may not have a console handle. Setting OutputEncoding calls the
        // Windows console API and throws when that handle is unavailable;
        // protocol output must still be allowed to start in that mode.
        try
        {
            Console.OutputEncoding = Encoding.UTF8;
        }
        catch (IOException) { }
        catch (InvalidOperationException) { }
        var fullApp = Environment.GetCommandLineArgs().Contains("--full-app", StringComparer.OrdinalIgnoreCase);
        using var context = new TranslationApplicationContext(fullApp);
        _ = Task.Run(() => ReadInputAsync(context));
        Application.Run(context);
    }

    private static async Task ReadInputAsync(TranslationApplicationContext context)
    {
        try
        {
            while (await ProtocolIo.Input.ReadLineAsync() is { } line)
            {
                if (line.Length > 100_000) continue;
                context.Post(line);
            }
        }
        catch (Exception error)
        {
            context.PostError("windows_input_failed", error.Message);
        }
        finally
        {
            if (!context.IsFullApp) context.PostExit();
        }
    }
}


// Does not initialize WinForms, windows, hotkeys, clipboard or permission APIs.
internal static class TranslationProtocolOnly
{
    internal static void Run()
    {
        var greeted = false;
        var configured = false;
        var fullApp = Environment.GetCommandLineArgs().Contains("--full-app", StringComparer.OrdinalIgnoreCase);
        void Emit(object value) => ProtocolIo.Output.WriteLine(JsonSerializer.Serialize(value));
        void Fail(string code) => Emit(new { version = 1, type = "error", code, message = code, retryable = false });
        void Status() => Emit(new {
            version = 1, type = "status", platform = "win32", protocolOnly = true,
            mode = fullApp ? "full-app" : "helper", trusted = false, permission = "none",
            captureModes = Array.Empty<string>(), configured,
            detail = "protocol-only; desktop capture and permissions disabled"
        });
        bool Receive(string line)
        {
            if (line.Length == 0) return true;
            if (Encoding.UTF8.GetByteCount(line) > 100_000) { Fail("desktop_protocol_too_large"); return true; }
            try
            {
                using var doc = JsonDocument.Parse(line);
                var message = doc.RootElement;
                if (message.ValueKind != JsonValueKind.Object || !message.TryGetProperty("type", out var typeValue) || typeValue.ValueKind != JsonValueKind.String)
                { Fail("desktop_protocol_invalid"); return true; }
                if (message.TryGetProperty("version", out var version) &&
                    (version.ValueKind != JsonValueKind.Number || !version.TryGetDouble(out var number) || number != 1))
                { Fail("desktop_protocol_version_unsupported"); return true; }
                var type = typeValue.GetString();
                if (type == "shutdown") { Emit(new { version = 1, type = "shutdown", protocolOnly = true }); return false; }
                if (type == "hello")
                {
                    greeted = true;
                    Emit(new { version = 1, type = "ready", protocolOnly = true });
                    Status(); return true;
                }
                if (!greeted) { Fail("desktop_protocol_handshake_required"); return true; }
                switch (type)
                {
                    case "configure": configured = true; Status(); break;
                    case "status": Status(); break;
                    default: Fail("desktop_protocol_only_unsupported"); break;
                }
            }
            catch (JsonException) { Fail("desktop_protocol_invalid"); }
            return true;
        }
        var line = new StringBuilder();
        var oversized = false;
        int ch;
        while ((ch = ProtocolIo.Input.Read()) != -1)
        {
            if (ch == '\n')
            {
                if (oversized) Fail("desktop_protocol_too_large");
                else if (!Receive(line.ToString())) return;
                line.Clear(); oversized = false;
            }
            else if (!oversized)
            {
                if (line.Length >= 100_000) { line.Clear(); oversized = true; }
                else line.Append((char)ch);
            }
        }
        if (oversized) Fail("desktop_protocol_too_large");
        else if (line.Length > 0) Receive(line.ToString());
    }
}

internal sealed class TranslationApplicationContext : ApplicationContext
{
    private const int HotKeyId = 0x4149;
    private const int LauncherHotKeyId = 0x414A;
    private readonly object outputLock = new();
    private readonly bool fullApp;
    private readonly TranslationWindow window;
    private readonly LauncherWindow launcherWindow;
    private readonly HotKeyWindow hotKeyWindow;
    private readonly LowLevelLauncherHook launcherHook = new();
    private string target = "zh-Hans";
    private string shortcut = "Ctrl+Alt+T";
    private string launcherShortcut = "Alt+Space";
    private string launcherOrigin = string.Empty;
    private string launcherKey = string.Empty;
    private bool launcherEnabled;
    private int generation;
    private bool captureInProgress;
    private IDataObject? originalClipboard;
    private string? originalClipboardText;
    private bool clipboardSnapshotTaken;
    private IntPtr captureTargetWindow;
    private System.Windows.Forms.Timer? captureTimer;
    private int captureAttempts;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public TranslationApplicationContext(bool fullApp)
    {
        this.fullApp = fullApp;
        window = new TranslationWindow();
        launcherWindow = new LauncherWindow();
        // Helper mode keeps the window hidden, but protocol messages are
        // marshalled onto the WinForms UI thread through BeginInvoke. Create
        // the hidden form handle eagerly so that hello/configure events are
        // not dropped before the first visible window is shown.
        window.CreateControl();
        _ = window.Handle;
        hotKeyWindow = new HotKeyWindow();
        if (fullApp)
        {
            window.SetStatus("桌面翻译已就绪");
            window.Show();
            window.CenterWindow();
        }
    }

    public bool IsFullApp => fullApp;

    public void Post(string line)
    {
        if (window.IsDisposed) return;
        try
        {
            window.BeginInvoke((Action)(() => HandleLine(line)));
        }
        catch (InvalidOperationException) { }
    }

    public void PostError(string code, string message)
    {
        Post(JsonSerializer.Serialize(new DesktopEvent { Version = 1, Type = "error", Code = code, Message = message }, JsonOptions));
    }

    public void PostExit()
    {
        try { window.BeginInvoke((Action)ExitThread); }
        catch (InvalidOperationException) { ExitThread(); }
    }

    private void HandleLine(string line)
    {
        JsonDocument? document = null;
        try
        {
            document = JsonDocument.Parse(line);
            var root = document.RootElement;
            var type = GetString(root, "type");
            if (root.TryGetProperty("version", out var version) && version.GetInt32() != 1)
            {
                Emit(new DesktopEvent { Version = 1, Type = "error", Code = "desktop_protocol_version_unsupported", Message = "桌面协议版本不受支持", Retryable = false });
                return;
            }
            switch (type)
            {
                case "hello":
                    Emit(new DesktopEvent { Version = 1, Type = "ready" });
                    Emit(new DesktopEvent { Version = 1, Type = "status", Trusted = true, Platform = "win32", CaptureModes = new[] { "shortcut-clipboard" }, Permission = "clipboard-shortcut", Shortcut = shortcut });
                    break;
                case "configure":
                    Configure(root);
                    break;
                case "cancel":
                    generation++;
                    FinishCapture();
                    window.SetStatus("已停止");
                    break;
                case "settings":
                    if (GetString(root, "action") == "save" && root.TryGetProperty("patch", out var patch)) Configure(patch);
                    break;
                case "request-permission":
                    Emit(new DesktopEvent { Version = 1, Type = "status", Trusted = true, Platform = "win32", CaptureModes = new[] { "shortcut-clipboard" }, Permission = "clipboard-shortcut", Shortcut = shortcut, Detail = "Windows 取词使用快捷键和剪贴板，不需要辅助功能授权" });
                    break;
                case "start":
                    window.SetStatus("正在翻译…");
                    break;
                case "attempt_start":
                    window.SetStatus("正在连接翻译服务…");
                    break;
                case "delta":
                    window.AppendOutput(GetString(root, "content") ?? string.Empty);
                    break;
                case "done":
                    if (root.TryGetProperty("text", out var doneText)) window.SetOutput(doneText.GetString() ?? string.Empty);
                    window.SetStatus("翻译完成");
                    break;
                case "error":
                    window.SetStatus(GetString(root, "message") ?? "翻译失败");
                    break;
                case "launcher-show":
                    launcherWindow.ShowLauncher();
                    break;
            }
        }
        catch (Exception)
        {
            Emit(new DesktopEvent
            {
                Version = 1,
                Type = "error",
                Code = "desktop_protocol_invalid",
                Message = "桌面协议消息格式无效",
                Retryable = false
            });
        }
        finally { document?.Dispose(); }
    }

    private void Configure(JsonElement root)
    {
        var nextTarget = GetString(root, "target");
        if (!string.IsNullOrWhiteSpace(nextTarget)) target = nextTarget;
        var nextTheme = GetString(root, "readingTheme");
        if (!string.IsNullOrWhiteSpace(nextTheme)) window.SetReadingTheme(nextTheme);
        var nextShortcut = GetString(root, "shortcut") ?? GetString(root, "nativeShortcut");
        if (!string.IsNullOrWhiteSpace(nextShortcut)) shortcut = nextShortcut;

        var translationRegistered = hotKeyWindow.TryRegister(HotKeyId, shortcut, OnHotKey, out _);
        if (!translationRegistered)
        {
            Emit(new DesktopEvent { Version = 1, Type = "error", Code = "windows_shortcut_registration_failed", Message = $"无法注册快捷键 {shortcut}", Retryable = false });
        }
        window.SetTarget(target);

        var launcherDetail = ConfigureLauncher(root);
        if (translationRegistered || !string.IsNullOrEmpty(launcherDetail))
        {
            Emit(new DesktopEvent
            {
                Version = 1,
                Type = "status",
                Trusted = true,
                Platform = "win32",
                CaptureModes = new[] { "shortcut-clipboard" },
                Permission = "clipboard-shortcut",
                Shortcut = shortcut,
                Detail = string.IsNullOrEmpty(launcherDetail) ? null : launcherDetail
            });
        }
    }

    private string? ConfigureLauncher(JsonElement root)
    {
        var hasLauncherFields = root.TryGetProperty("launcherEnabled", out _)
            || root.TryGetProperty("launcherShortcut", out _)
            || root.TryGetProperty("launcherOrigin", out _)
            || root.TryGetProperty("launcherKey", out _);
        if (!hasLauncherFields) return null;

        var nextShortcut = GetString(root, "launcherShortcut");
        if (!string.IsNullOrWhiteSpace(nextShortcut)) launcherShortcut = nextShortcut.Trim();
        var nextOrigin = GetString(root, "launcherOrigin");
        if (nextOrigin is not null) launcherOrigin = nextOrigin.Trim();
        var nextKey = GetString(root, "launcherKey");
        if (nextKey is not null) launcherKey = nextKey.Trim();
        if (root.TryGetProperty("launcherEnabled", out var enabledProp) &&
            (enabledProp.ValueKind == JsonValueKind.True || enabledProp.ValueKind == JsonValueKind.False))
        {
            launcherEnabled = enabledProp.GetBoolean();
        }

        var available = launcherEnabled && !string.IsNullOrWhiteSpace(launcherOrigin) && !string.IsNullOrWhiteSpace(launcherKey);
        launcherWindow.Configure(launcherOrigin, launcherKey, launcherShortcut, available);

        hotKeyWindow.Unregister(LauncherHotKeyId);
        launcherHook.Uninstall();

        if (!available)
        {
            return null;
        }

        launcherWindow.WarmCatalog();

        if (hotKeyWindow.TryRegister(LauncherHotKeyId, launcherShortcut, OnLauncherHotKey, out var regErr))
        {
            return null;
        }

        if (launcherHook.TryInstall(window, launcherShortcut, OnLauncherHotKey, out var hookErr))
        {
            return $"启动器 {launcherShortcut} 注册热键失败（错误 {regErr}），已自动启用低级键盘钩子拦截";
        }

        return $"启动器快捷键 {launcherShortcut} 不可用（RegisterHotKey={regErr}, Hook={hookErr}），建议改用 Ctrl+Space 或使用 CLI aih launch";
    }

    private void OnLauncherHotKey()
    {
        if (!launcherWindow.IsDisposed)
        {
            launcherWindow.ToggleLauncher();
        }
    }

    private void OnHotKey()
    {
        if (captureInProgress) return;
        var currentGeneration = ++generation;
        captureInProgress = true;
        // RegisterHotKey delivers the callback while the foreground app is
        // still the source of the selection. Keep that HWND before hiding or
        // focusing any AIH UI so Ctrl+C is sent back to the real editor.
        captureTargetWindow = GetForegroundWindow();
        window.Hide();
        captureTimer = new System.Windows.Forms.Timer { Interval = 100 };
        captureTimer.Tick += (_, _) => BeginClipboardCapture(currentGeneration);
        captureTimer.Start();
    }

    private void BeginClipboardCapture(int currentGeneration)
    {
        StopCaptureTimer();
        if (currentGeneration != generation)
        {
            FinishCapture();
            return;
        }
        try
        {
            originalClipboard = Clipboard.GetDataObject();
            originalClipboardText = Clipboard.ContainsText(TextDataFormat.UnicodeText)
                ? Clipboard.GetText(TextDataFormat.UnicodeText)
                : null;
            clipboardSnapshotTaken = true;
            Clipboard.Clear();
            if (captureTargetWindow != IntPtr.Zero) SetForegroundWindow(captureTargetWindow);
            SendCtrlC();
            captureAttempts = 0;
            captureTimer = new System.Windows.Forms.Timer { Interval = 40 };
            captureTimer.Tick += (_, _) => PollClipboard(currentGeneration);
            captureTimer.Start();
        }
        catch (ExternalException error)
        {
            Emit(new DesktopEvent { Version = 1, Type = "error", Code = "windows_clipboard_capture_failed", Message = error.Message, Retryable = true });
            FinishCapture();
        }
    }

    private void PollClipboard(int currentGeneration)
    {
        if (currentGeneration != generation)
        {
            FinishCapture();
            return;
        }
        try
        {
            var text = Clipboard.ContainsText(TextDataFormat.UnicodeText)
                ? Clipboard.GetText(TextDataFormat.UnicodeText).Trim()
                : string.Empty;
            // The clipboard was cleared before sending Ctrl+C, so matching the
            // previous text is still a valid new selection.
            if (!string.IsNullOrWhiteSpace(text))
            {
                StopCaptureTimer();
                window.BeginTranslation(text, target);
                Emit(new DesktopEvent { Version = 1, Type = "translate-intent", Id = Guid.NewGuid().ToString("N"), Text = text, Target = target, Generation = currentGeneration });
                FinishCapture();
                return;
            }
            captureAttempts++;
            if (captureAttempts < 25) return;
            Emit(new DesktopEvent { Version = 1, Type = "error", Code = "windows_clipboard_capture_failed", Message = "没有读取到选中文本", Retryable = true });
            FinishCapture();
        }
        catch (ExternalException error)
        {
            Emit(new DesktopEvent { Version = 1, Type = "error", Code = "windows_clipboard_capture_failed", Message = error.Message, Retryable = true });
            FinishCapture();
        }
    }

    private void StopCaptureTimer()
    {
        if (captureTimer is null) return;
        captureTimer.Stop();
        captureTimer.Dispose();
        captureTimer = null;
    }

    private void FinishCapture()
    {
        StopCaptureTimer();
        if (!clipboardSnapshotTaken)
        {
            captureTargetWindow = IntPtr.Zero;
            captureAttempts = 0;
            captureInProgress = false;
            return;
        }
        var restoreText = originalClipboardText;
        var restoreObject = originalClipboard;
        var restored = false;
        if (restoreText is not null)
        {
            // The foreground editor may still own the clipboard for a short
            // interval after Ctrl+C. Prefer the captured text and retry while
            // that ownership is released; this is more reliable than replaying
            // a delayed IDataObject from another process.
            for (var attempt = 0; attempt < 8 && !restored; attempt++)
            {
                try
                {
                    Clipboard.SetText(restoreText, TextDataFormat.UnicodeText);
                    restored = true;
                }
                catch (ExternalException)
                {
                    Thread.Sleep(25);
                }
            }
            for (var attempt = 0; attempt < 8 && !restored; attempt++)
            {
                restored = TryRestoreClipboardTextNative(restoreText, window.Handle);
                if (!restored) Thread.Sleep(25);
            }
        }
        if (!restored && restoreObject is not null)
        {
            for (var attempt = 0; attempt < 4 && !restored; attempt++)
            {
                try
                {
                    Clipboard.SetDataObject(restoreObject, true);
                    restored = true;
                }
                catch (ExternalException)
                {
                    Thread.Sleep(25);
                }
            }
        }
        if (!restored && restoreObject is null && restoreText is null)
        {
            try { Clipboard.Clear(); restored = true; }
            catch (ExternalException) { }
        }
        if (!restored)
        {
            Emit(new DesktopEvent { Version = 1, Type = "error", Code = "windows_clipboard_restore_failed", Message = "Requested Clipboard operation did not succeed.", Retryable = true });
        }
        originalClipboard = null;
        originalClipboardText = null;
        clipboardSnapshotTaken = false;
        captureTargetWindow = IntPtr.Zero;
        captureAttempts = 0;
        captureInProgress = false;
    }

    private void OnWindowClosed()
    {
        FinishCapture();
        launcherHook.Dispose();
        hotKeyWindow.Dispose();
        launcherWindow.Dispose();
        window.Dispose();
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            FinishCapture();
            launcherHook.Dispose();
            hotKeyWindow.Dispose();
            if (!launcherWindow.IsDisposed) launcherWindow.Dispose();
            if (!window.IsDisposed) window.Dispose();
        }
        base.Dispose(disposing);
    }

    private void Emit(DesktopEvent value)
    {
        var json = JsonSerializer.Serialize(value, JsonOptions);
        lock (outputLock)
        {
            ProtocolIo.Output.WriteLine(json);
        }
    }

    private static string? GetString(JsonElement root, string name)
        => root.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String ? property.GetString() : null;

    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);

    private static void SendCtrlC()
    {
        const byte vkControl = 0x11;
        const byte vkC = 0x43;
        const uint keyUp = 0x0002;
        keybd_event(vkControl, 0, 0, UIntPtr.Zero);
        keybd_event(vkC, 0, 0, UIntPtr.Zero);
        keybd_event(vkC, 0, keyUp, UIntPtr.Zero);
        keybd_event(vkControl, 0, keyUp, UIntPtr.Zero);
    }

    [DllImport("user32.dll")] private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);

    private static bool TryRestoreClipboardTextNative(string value, IntPtr owner)
    {
        const uint globalMoveable = 0x0002;
        const uint globalZeroInit = 0x0040;
        const uint unicodeTextFormat = 13;
        var bytes = Encoding.Unicode.GetBytes(value + "\0");
        if (!OpenClipboard(owner)) return false;
        IntPtr memory = IntPtr.Zero;
        try
        {
            if (!EmptyClipboard()) return false;
            memory = GlobalAlloc(globalMoveable | globalZeroInit, (UIntPtr)bytes.Length);
            if (memory == IntPtr.Zero) return false;
            var locked = GlobalLock(memory);
            if (locked == IntPtr.Zero) return false;
            try { Marshal.Copy(bytes, 0, locked, bytes.Length); }
            finally { GlobalUnlock(memory); }
            if (SetClipboardData(unicodeTextFormat, memory) == IntPtr.Zero) return false;
            memory = IntPtr.Zero;
            return true;
        }
        finally
        {
            CloseClipboard();
            if (memory != IntPtr.Zero) GlobalFree(memory);
        }
    }

    [DllImport("user32.dll", SetLastError = true)] private static extern bool OpenClipboard(IntPtr newOwner);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)] private static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetClipboardData(uint format, IntPtr data);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalFree(IntPtr memory);
}

internal sealed class HotKeyWindow : NativeWindow, IDisposable
{
    private readonly Dictionary<int, Action> handlers = new();
    private readonly HashSet<int> registeredIds = new();

    public HotKeyWindow()
    {
        CreateHandle(new CreateParams());
    }

    public bool TryRegister(int id, string value, Action callback, out int win32Error)
    {
        win32Error = 0;
        Unregister(id);
        if (!TryParse(value, out var modifiers, out var key))
        {
            return false;
        }
        if (!RegisterHotKey(Handle, id, modifiers, key))
        {
            win32Error = Marshal.GetLastWin32Error();
            return false;
        }
        handlers[id] = callback;
        registeredIds.Add(id);
        return true;
    }

    public void Unregister(int id)
    {
        handlers.Remove(id);
        if (registeredIds.Remove(id) && Handle != IntPtr.Zero)
        {
            UnregisterHotKey(Handle, id);
        }
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x0312 && handlers.TryGetValue(m.WParam.ToInt32(), out var callback))
        {
            callback();
        }
        base.WndProc(ref m);
    }

    public void Dispose()
    {
        if (Handle != IntPtr.Zero)
        {
            foreach (var id in registeredIds.ToArray())
            {
                UnregisterHotKey(Handle, id);
            }
            registeredIds.Clear();
            handlers.Clear();
            DestroyHandle();
        }
        GC.SuppressFinalize(this);
    }

    internal static bool TryParse(string value, out uint modifiers, out uint key)
    {
        modifiers = 0;
        key = 0;
        if (string.IsNullOrWhiteSpace(value)) return false;
        var tokens = value.Replace("⌘", "Win+", StringComparison.OrdinalIgnoreCase)
            .Replace("⌥", "Alt+", StringComparison.OrdinalIgnoreCase)
            .Replace("⌃", "Ctrl+", StringComparison.OrdinalIgnoreCase)
            .Replace("⇧", "Shift+", StringComparison.OrdinalIgnoreCase)
            .Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (tokens.Length == 0) return false;
        foreach (var token in tokens[..^1])
        {
            switch (token.ToLowerInvariant())
            {
                case "ctrl": case "control": modifiers |= 0x0002; break;
                case "alt": case "option": case "opt": modifiers |= 0x0001; break;
                case "shift": modifiers |= 0x0004; break;
                case "win": case "command": case "cmd": modifiers |= 0x0008; break;
                default: return false;
            }
        }
        var keyToken = tokens[^1].Trim();
        if (keyToken.Equals("space", StringComparison.OrdinalIgnoreCase))
        {
            key = 0x20;
            return true;
        }
        if (keyToken.Length == 1)
        {
            key = char.ToUpperInvariant(keyToken[0]);
            return true;
        }
        if (keyToken.StartsWith("F", StringComparison.OrdinalIgnoreCase) && int.TryParse(keyToken[1..], out var f) && f is >= 1 and <= 24)
        {
            key = (uint)(0x70 + f - 1);
            return true;
        }
        return false;
    }

    [DllImport("user32.dll", SetLastError = true)] private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool UnregisterHotKey(IntPtr hWnd, int id);
}

/// Low-level WH_KEYBOARD_LL fallback when RegisterHotKey fails (e.g. Alt+Space claimed by system menu).
/// Uses a static delegate root so the unmanaged callback pointer is never collected by GC.
internal sealed class LowLevelLauncherHook : IDisposable
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;
    private const uint LLKHF_ALTDOWN = 0x20;
    private const int VK_SHIFT = 0x10;
    private const int VK_CONTROL = 0x11;
    private const int VK_MENU = 0x12;
    private const int VK_LWIN = 0x5B;
    private const int VK_RWIN = 0x5C;

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
    private static readonly LowLevelKeyboardProc StaticHookProc = HookCallback;
    private static LowLevelLauncherHook? activeInstance;

    private IntPtr hookHandle = IntPtr.Zero;
    private Control? marshallControl;
    private Action? onTrigger;
    private uint targetModifiers = 0x0001;
    private uint targetVk = 0x20;
    private bool keyHeld;

    public bool IsInstalled => hookHandle != IntPtr.Zero;

    public bool TryInstall(Control uiControl, string shortcut, Action callback, out int win32Error)
    {
        win32Error = 0;
        Uninstall();
        if (!HotKeyWindow.TryParse(shortcut, out var mods, out var vk))
        {
            return false;
        }
        targetModifiers = mods;
        targetVk = vk;
        marshallControl = uiControl;
        onTrigger = callback;
        keyHeld = false;
        activeInstance = this;

        var moduleHandle = GetModuleHandle(null);
        hookHandle = SetWindowsHookEx(WH_KEYBOARD_LL, StaticHookProc, moduleHandle, 0);
        if (hookHandle == IntPtr.Zero)
        {
            win32Error = Marshal.GetLastWin32Error();
            activeInstance = null;
            marshallControl = null;
            onTrigger = null;
            return false;
        }
        return true;
    }

    public void Uninstall()
    {
        if (hookHandle != IntPtr.Zero)
        {
            UnhookWindowsHookEx(hookHandle);
            hookHandle = IntPtr.Zero;
        }
        if (ReferenceEquals(activeInstance, this))
        {
            activeInstance = null;
        }
        marshallControl = null;
        onTrigger = null;
        keyHeld = false;
    }

    public void Dispose()
    {
        Uninstall();
        GC.SuppressFinalize(this);
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        var inst = activeInstance;
        if (nCode >= 0 && inst is not null && lParam != IntPtr.Zero)
        {
            var msg = wParam.ToInt32();
            var kb = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
            if (msg == WM_KEYUP || msg == WM_SYSKEYUP)
            {
                if (kb.vkCode == inst.targetVk)
                {
                    inst.keyHeld = false;
                }
            }
            else if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN)
            {
                if (kb.vkCode == inst.targetVk && ReadCurrentModifiers(kb.flags) == inst.targetModifiers)
                {
                    if (!inst.keyHeld)
                    {
                        inst.keyHeld = true;
                        var ctrl = inst.marshallControl;
                        var action = inst.onTrigger;
                        if (ctrl is not null && action is not null && !ctrl.IsDisposed && ctrl.IsHandleCreated)
                        {
                            try { ctrl.BeginInvoke(action); }
                            catch (InvalidOperationException) { }
                        }
                    }
                    // Return 1 to swallow Alt+Space so the system window menu never opens.
                    return (IntPtr)1;
                }
            }
        }
        return CallNextHookEx(inst?.hookHandle ?? IntPtr.Zero, nCode, wParam, lParam);
    }

    private static uint ReadCurrentModifiers(uint llFlags)
    {
        uint mods = 0;
        if ((llFlags & LLKHF_ALTDOWN) != 0 || (GetAsyncKeyState(VK_MENU) & 0x8000) != 0) mods |= 0x0001;
        if ((GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0) mods |= 0x0002;
        if ((GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0) mods |= 0x0004;
        if ((GetAsyncKeyState(VK_LWIN) & 0x8000) != 0 || (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0) mods |= 0x0008;
        return mods;
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

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);
}

internal sealed class TranslationWindow : Form
{
    private readonly Label status = new();
    private readonly Label targetLabel = new();
    private readonly RichTextBox output = new();

    public TranslationWindow()
    {
        Text = "AIH 翻译";
        Width = 520;
        Height = 360;
        MinimumSize = new Size(420, 280);
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        TopMost = true;
        BackColor = Color.FromArgb(14, 22, 34);
        ForeColor = Color.White;
        Padding = new Padding(18);

        var header = new Panel { Dock = DockStyle.Top, Height = 36 };
        var brand = new Label { Text = "AIH / 翻译", AutoSize = true, Font = new Font("Segoe UI", 11, FontStyle.Bold), ForeColor = Color.FromArgb(116, 239, 255), Location = new Point(0, 4) };
        targetLabel.AutoSize = true;
        targetLabel.ForeColor = Color.FromArgb(168, 184, 202);
        targetLabel.Location = new Point(0, 25);
        var close = new Button { Text = "×", FlatStyle = FlatStyle.Flat, Width = 28, Height = 28, Dock = DockStyle.Right, ForeColor = Color.FromArgb(168, 184, 202), BackColor = Color.Transparent };
        close.FlatAppearance.BorderSize = 0;
        close.Click += (_, _) => Hide();
        header.Controls.Add(close);
        header.Controls.Add(targetLabel);
        header.Controls.Add(brand);

        output.Dock = DockStyle.Fill;
        output.ReadOnly = true;
        output.BorderStyle = BorderStyle.None;
        output.BackColor = Color.FromArgb(9, 15, 25);
        output.ForeColor = Color.FromArgb(236, 242, 250);
        output.Font = new Font("Segoe UI", 12);
        output.Padding = new Padding(10);

        status.Dock = DockStyle.Bottom;
        status.Height = 24;
        status.ForeColor = Color.FromArgb(142, 160, 180);
        status.Text = "等待快捷键…";
        Controls.Add(output);
        Controls.Add(status);
        Controls.Add(header);
        Deactivate += (_, _) => { if (!TopMost) Hide(); };
    }

    public void SetTarget(string value) => targetLabel.Text = $"目标语言 · {value}";

    public void CenterWindow()
    {
        var screen = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 800);
        Location = new Point(screen.Left + Math.Max(0, (screen.Width - Width) / 2), screen.Top + Math.Max(0, (screen.Height - Height) / 2));
    }

    public void BeginTranslation(string source, string target)
    {
        SetTarget(target);
        output.Clear();
        ApplyReadingTheme();
        SetStatus("正在准备翻译…");
        var screen = Screen.FromPoint(Cursor.Position).WorkingArea;
        Location = new Point(Math.Max(screen.Left + 12, Math.Min(Cursor.Position.X - Width / 2, screen.Right - Width - 12)), Math.Max(screen.Top + 12, Math.Min(Cursor.Position.Y + 16, screen.Bottom - Height - 12)));
        Show();
        Activate();
    }

    public void AppendOutput(string value)
    {
        if (string.IsNullOrEmpty(value)) return;
        output.AppendText(value);
        SetStatus("正在生成译文…");
    }

    public void SetOutput(string value)
    {
        output.Text = value;
        ApplyReadingTheme();
    }

    public void SetStatus(string value) => status.Text = value;

    // Same theme ids as the macOS panel and the browser extension (reading-themes.js).
    // WinForms RichTextBox can express underline and background tint; frame-only
    // styles stay plain.
    private string readingTheme = "plain";

    public void SetReadingTheme(string value)
    {
        readingTheme = value ?? "plain";
        ApplyReadingTheme();
    }

    private void ApplyReadingTheme()
    {
        var underline = readingTheme.StartsWith("underline-", StringComparison.Ordinal) || readingTheme == "cyberpunk";
        output.BackColor = readingTheme switch
        {
            "soft" => Color.FromArgb(20, 27, 38),
            "hud" => Color.FromArgb(10, 30, 38),
            "cyberpunk" => Color.FromArgb(28, 14, 40),
            _ => Color.FromArgb(9, 15, 25),
        };
        output.SelectAll();
        output.SelectionFont = new Font(output.Font, underline ? FontStyle.Underline : FontStyle.Regular);
        output.Select(output.TextLength, 0);
        output.SelectionFont = new Font(output.Font, underline ? FontStyle.Underline : FontStyle.Regular);
    }
}

internal sealed class DesktopEvent
{
    public int Version { get; set; }
    public string? Type { get; set; }
    public string? Id { get; set; }
    public string? Code { get; set; }
    public string? Message { get; set; }
    public bool? Retryable { get; set; }
    public bool? Trusted { get; set; }
    public string? Detail { get; set; }
    public string? Platform { get; set; }
    public string[]? CaptureModes { get; set; }
    public string? Permission { get; set; }
    public string? Shortcut { get; set; }
    public string? Text { get; set; }
    public string? Target { get; set; }
    public int? Generation { get; set; }
}

internal sealed class LauncherApp
{
    [JsonPropertyName("id")] public string Id { get; set; } = string.Empty;
    [JsonPropertyName("name")] public string Name { get; set; } = string.Empty;
    [JsonPropertyName("subtitle")] public string Subtitle { get; set; } = string.Empty;
    [JsonPropertyName("path")] public string Path { get; set; } = string.Empty;
    [JsonPropertyName("kind")] public string Kind { get; set; } = "app";
    [JsonPropertyName("icon")] public string Icon { get; set; } = string.Empty;
    [JsonPropertyName("terminal")] public bool Terminal { get; set; }
    [JsonPropertyName("aliases")] public List<string>? Aliases { get; set; }
}

internal sealed class LauncherAppsResponse
{
    [JsonPropertyName("platform")] public string Platform { get; set; } = "windows";
    [JsonPropertyName("generatedAt")] public long GeneratedAt { get; set; }
    [JsonPropertyName("apps")] public List<LauncherApp>? Apps { get; set; }
    [JsonPropertyName("truncated")] public bool Truncated { get; set; }
}

internal enum LauncherMatchSource
{
    None,
    Name,
    Alias,
    Subtitle
}

internal sealed class LauncherMatchResult
{
    public LauncherApp App { get; }
    public int Score { get; }
    public LauncherMatchSource MatchSource { get; }
    public HashSet<int> MatchedIndices { get; }

    public LauncherMatchResult(LauncherApp app, int score, LauncherMatchSource matchSource, HashSet<int> matchedIndices)
    {
        App = app;
        Score = score;
        MatchSource = matchSource;
        MatchedIndices = matchedIndices;
    }
}

/// Local search and ranking matching §6 + aliases.
/// Constants stay strictly synchronized with `application/launcher/rank.go`.
internal static class LauncherRanker
{
    // 与 application/launcher/rank.go 同步
    public const int ScoreExactName = 1000;
    public const int ScoreNamePrefixBase = 900;
    public const int ScoreNamePrefixMaxPen = 50;
    public const int ScoreWordPrefix = 800;
    public const int ScoreAcronym = 750;
    public const int ScoreSubstringBase = 700;
    public const int ScoreSubstringMaxPen = 100;
    public const int ScoreAlias = 650;
    public const int ScoreSubsequenceBase = 600;
    public const int ScoreSubseqMaxPen = 150;
    public const int ScoreSubtitleOnly = 300;

    public static string NormalizeQuery(string? raw)
        => string.IsNullOrWhiteSpace(raw) ? string.Empty : raw.Trim().ToLowerInvariant();

    public static List<LauncherMatchResult> Filter(IReadOnlyList<LauncherApp> apps, string? rawQuery)
    {
        var query = NormalizeQuery(rawQuery);
        if (query.Length == 0)
        {
            var all = new List<LauncherMatchResult>(apps.Count);
            for (var i = 0; i < apps.Count; i++)
            {
                all.Add(new LauncherMatchResult(apps[i], 0, LauncherMatchSource.None, new HashSet<int>()));
            }
            return all;
        }

        var scored = new List<(LauncherMatchResult Result, string NameLower, int ServerIndex)>(apps.Count);
        for (var i = 0; i < apps.Count; i++)
        {
            var app = apps[i];
            var eval = Evaluate(app, query);
            if (eval.Score <= 0) continue;
            scored.Add((
                new LauncherMatchResult(app, eval.Score, eval.Source, eval.Indices),
                NormalizeQuery(app.Name),
                i
            ));
        }

        scored.Sort((a, b) =>
        {
            var cmp = b.Result.Score.CompareTo(a.Result.Score);
            if (cmp != 0) return cmp;
            cmp = string.CompareOrdinal(a.NameLower, b.NameLower);
            if (cmp != 0) return cmp;
            cmp = string.CompareOrdinal(a.Result.App.Id, b.Result.App.Id);
            if (cmp != 0) return cmp;
            return a.ServerIndex.CompareTo(b.ServerIndex);
        });

        var output = new List<LauncherMatchResult>(scored.Count);
        for (var i = 0; i < scored.Count; i++)
        {
            output.Add(scored[i].Result);
        }
        return output;
    }

    private readonly struct WordSpan
    {
        public readonly int Start;
        public readonly int Length;
        public WordSpan(int start, int length) { Start = start; Length = length; }
    }

    private static (int Score, LauncherMatchSource Source, HashSet<int> Indices) Evaluate(LauncherApp app, string query)
    {
        var name = app.Name ?? string.Empty;
        var lowerChars = new char[name.Length];
        for (var i = 0; i < name.Length; i++)
        {
            lowerChars[i] = char.ToLowerInvariant(name[i]);
        }
        var lowerName = new string(lowerChars);

        var bestScore = 0;
        var bestSource = LauncherMatchSource.None;
        List<int>? bestIndices = null;

        void Consider(int score, List<int> indices)
        {
            if (score > bestScore)
            {
                bestScore = score;
                bestSource = LauncherMatchSource.Name;
                bestIndices = indices;
            }
        }

        if (lowerName.Length > 0)
        {
            if (string.Equals(lowerName, query, StringComparison.Ordinal))
            {
                Consider(ScoreExactName, RangeList(0, lowerName.Length));
            }
            if (lowerName.StartsWith(query, StringComparison.Ordinal))
            {
                var pen = Math.Min(Math.Max(0, lowerName.Length - query.Length), ScoreNamePrefixMaxPen);
                Consider(ScoreNamePrefixBase - pen, RangeList(0, query.Length));
            }
            var words = SplitWords(lowerName);
            if (words.Count > 0)
            {
                for (var w = 0; w < words.Count; w++)
                {
                    var span = words[w];
                    if (span.Length >= query.Length &&
                        string.CompareOrdinal(lowerName, span.Start, query, 0, query.Length) == 0)
                    {
                        Consider(ScoreWordPrefix, RangeList(span.Start, query.Length));
                        break;
                    }
                }
                var initials = new char[words.Count];
                for (var w = 0; w < words.Count; w++) initials[w] = lowerName[words[w].Start];
                var initialsStr = new string(initials);
                var acroPos = initialsStr.IndexOf(query, StringComparison.Ordinal);
                if (acroPos >= 0)
                {
                    var acroIndices = new List<int>(query.Length);
                    for (var k = 0; k < query.Length; k++) acroIndices.Add(words[acroPos + k].Start);
                    Consider(ScoreAcronym, acroIndices);
                }
            }
            var subPos = lowerName.IndexOf(query, StringComparison.Ordinal);
            if (subPos >= 0)
            {
                var pen = Math.Min(subPos, ScoreSubstringMaxPen);
                Consider(ScoreSubstringBase - pen, RangeList(subPos, query.Length));
            }
            if (TrySubsequence(lowerName, query, out var gaps, out var seqIndices))
            {
                var pen = Math.Min(gaps, ScoreSubseqMaxPen);
                Consider(ScoreSubsequenceBase - pen, seqIndices);
            }
        }

        if (app.Aliases is { Count: > 0 })
        {
            for (var i = 0; i < app.Aliases.Count; i++)
            {
                var aliasNorm = NormalizeQuery(app.Aliases[i]);
                if (aliasNorm.Length == 0) continue;
                if (AliasMatches(aliasNorm, query))
                {
                    if (ScoreAlias > bestScore)
                    {
                        bestScore = ScoreAlias;
                        bestSource = LauncherMatchSource.Alias;
                        bestIndices = null;
                    }
                    break;
                }
            }
        }

        if (bestScore == 0)
        {
            var subNorm = NormalizeQuery(app.Subtitle);
            if (subNorm.Length > 0 && subNorm.Contains(query, StringComparison.Ordinal))
            {
                return (ScoreSubtitleOnly, LauncherMatchSource.Subtitle, new HashSet<int>());
            }
        }

        var set = bestSource == LauncherMatchSource.Name && bestIndices is not null
            ? new HashSet<int>(bestIndices)
            : new HashSet<int>();
        return (bestScore, bestSource, set);
    }

    private static bool AliasMatches(string aliasNorm, string query)
    {
        if (aliasNorm.StartsWith(query, StringComparison.Ordinal) || aliasNorm.Contains(query, StringComparison.Ordinal))
        {
            return true;
        }
        var words = SplitWords(aliasNorm);
        if (words.Count > 0)
        {
            var initials = new char[words.Count];
            for (var i = 0; i < words.Count; i++)
            {
                var span = words[i];
                if (span.Length >= query.Length &&
                    string.CompareOrdinal(aliasNorm, span.Start, query, 0, query.Length) == 0)
                {
                    return true;
                }
                initials[i] = aliasNorm[span.Start];
            }
            if (new string(initials).Contains(query, StringComparison.Ordinal))
            {
                return true;
            }
        }
        return TrySubsequence(aliasNorm, query, out _, out _);
    }

    private static bool IsWordSeparator(char ch)
        => char.IsWhiteSpace(ch) || ch == '-' || ch == '_' || ch == '/';

    private static List<WordSpan> SplitWords(string text)
    {
        var words = new List<WordSpan>();
        var start = -1;
        for (var i = 0; i < text.Length; i++)
        {
            if (IsWordSeparator(text[i]))
            {
                if (start >= 0)
                {
                    words.Add(new WordSpan(start, i - start));
                    start = -1;
                }
            }
            else if (start < 0)
            {
                start = i;
            }
        }
        if (start >= 0)
        {
            words.Add(new WordSpan(start, text.Length - start));
        }
        return words;
    }

    private static bool TrySubsequence(string text, string query, out int gaps, out List<int> indices)
    {
        gaps = 0;
        indices = new List<int>(query.Length);
        if (query.Length == 0 || query.Length > text.Length) return false;
        var qi = 0;
        var prev = -1;
        for (var ti = 0; ti < text.Length; ti++)
        {
            if (text[ti] == query[qi])
            {
                if (prev >= 0) gaps += ti - prev - 1;
                prev = ti;
                indices.Add(ti);
                qi++;
                if (qi == query.Length) return true;
            }
        }
        return false;
    }

    private static List<int> RangeList(int start, int length)
    {
        var list = new List<int>(length);
        for (var i = 0; i < length; i++) list.Add(start + i);
        return list;
    }
}

internal sealed class LauncherSearchTextBox : TextBox
{
    private const int WM_PAINT = 0x000F;
    public string Placeholder { get; set; } = "搜索应用…";
    public Color PlaceholderColor { get; set; } = Color.FromArgb(132, 147, 174);

    protected override void WndProc(ref Message m)
    {
        base.WndProc(ref m);
        if (m.Msg == WM_PAINT && string.IsNullOrEmpty(Text) && !string.IsNullOrEmpty(Placeholder))
        {
            using var g = Graphics.FromHwnd(Handle);
            var rect = new Rectangle(2, 0, Math.Max(0, ClientSize.Width - 4), ClientSize.Height);
            TextRenderer.DrawText(
                g,
                Placeholder,
                Font,
                rect,
                PlaceholderColor,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix
            );
        }
    }
}

internal sealed class LauncherWindow : Form
{
    private const int LogicalWidth = 720;
    private const int LogicalHeight = 540;
    private const int VisibleRowsMax = 8;
    private const int LogicalHeaderHeight = 84;
    private const int LogicalListTopPadding = 8;
    private const int LogicalRowHeight = 51;
    private const int LogicalFooterHeight = 34;
    private const double CacheTtlSeconds = 300.0;
    private const double EnterDurationMs = 180.0;
    private const double ExitDurationMs = 110.0;
    private const double StaggerStepMs = 12.0;
    private const double StaggerRowDurationMs = 140.0;
    private const double HighlightSlideDurationMs = 120.0;

    private static readonly Color BgTop = Color.FromArgb(245, 16, 23, 39);
    private static readonly Color BgBottom = Color.FromArgb(250, 8, 11, 21);
    private static readonly Color SearchBg = Color.FromArgb(14, 21, 36);
    private static readonly Color Cyan = Color.FromArgb(98, 237, 255);
    private static readonly Color Purple = Color.FromArgb(177, 139, 255);
    private static readonly Color BorderCyan = Color.FromArgb(62, 98, 237, 255);
    private static readonly Color SeparatorCyan = Color.FromArgb(36, 98, 237, 255);
    private static readonly Color TextPrimary = Color.FromArgb(232, 237, 248);
    private static readonly Color TextMuted = Color.FromArgb(132, 147, 174);
    private static readonly Color TextHint = Color.FromArgb(110, 127, 155);
    private static readonly Color ErrorSoft = Color.FromArgb(255, 143, 143);

    private readonly HttpClient httpClient = new() { Timeout = TimeSpan.FromSeconds(5) };
    private readonly LauncherSearchTextBox searchBox = new();
    private readonly System.Windows.Forms.Timer animTimer = new() { Interval = 16 };
    private readonly System.Windows.Forms.Timer errorTimer = new() { Interval = 1800 };
    private readonly Stopwatch animClock = Stopwatch.StartNew();
    private readonly Dictionary<string, Bitmap?> iconCache = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> iconLoading = new(StringComparer.OrdinalIgnoreCase);

    private string origin = string.Empty;
    private string managementKey = string.Empty;
    private string shortcutHint = "Alt+Space";
    private bool launcherAvailable;

    private List<LauncherApp> cachedApps = new();
    private List<LauncherMatchResult> visibleResults = new();
    private DateTime lastFetchedUtc = DateTime.MinValue;
    private bool isFetching;
    private int fetchGeneration;

    private int selectedIndex = -1;
    private int scrollOffset;
    private int hoverIndex = -1;

    private string statusMessage = string.Empty;
    private bool statusIsError;

    private IntPtr previousForegroundWindow = IntPtr.Zero;
    private DateTime suppressDeactivateUntilUtc = DateTime.MinValue;
    private bool acrylicEnabled;

    private enum AnimPhase { Idle, Showing, Hiding }
    private AnimPhase animPhase = AnimPhase.Idle;
    private double phaseStartMs;
    private int targetTop;
    private bool pendingRestoreFocus;

    private double staggerStartMs = -10_000;
    private bool staggerActive;

    private float highlightFromY;
    private float highlightToY;
    private float highlightCurrentY;
    private double highlightStartMs;
    private bool highlightAnimating;
    private bool highlightVisible;

    private Font? eyebrowFont;
    private Font? countFont;
    private Font? nameFont;
    private Font? nameBoldFont;
    private Font? subtitleFont;
    private Font? badgeFont;
    private Font? hintFont;
    private Font? emptyFont;
    private Font? searchFont;
    private int cachedFontDpi;

    public LauncherWindow()
    {
        Text = "AIH Launch";
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        DoubleBuffered = true;
        KeyPreview = true;
        BackColor = Color.FromArgb(11, 18, 32);
        ForeColor = TextPrimary;

        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);

        searchBox.BorderStyle = BorderStyle.None;
        searchBox.Multiline = false;
        searchBox.ImeMode = ImeMode.On;
        searchBox.BackColor = SearchBg;
        searchBox.ForeColor = TextPrimary;
        searchBox.Placeholder = "搜索应用…";
        searchBox.PlaceholderColor = TextMuted;
        searchBox.TextChanged += OnSearchTextChanged;
        Controls.Add(searchBox);

        animTimer.Tick += OnAnimationTick;
        errorTimer.Tick += (_, _) =>
        {
            errorTimer.Stop();
            statusMessage = string.Empty;
            statusIsError = false;
            Invalidate();
        };

        Deactivate += (_, _) =>
        {
            if (Visible && animPhase != AnimPhase.Hiding && DateTime.UtcNow >= suppressDeactivateUntilUtc)
            {
                HideAnimated(restoreFocus: false);
            }
        };

        EnsureFonts();
        LayoutSearchBox();
    }

    private float DpiScale => Math.Max(1f, DeviceDpi / 96f);
    private int S(float px) => (int)Math.Round(px * DpiScale);
    private float Sf(float px) => px * DpiScale;

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            const int WS_EX_TOOLWINDOW = 0x00000080;
            cp.ExStyle |= WS_EX_TOOLWINDOW;
            return cp;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        ApplyWindowEffects();
    }

    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        base.OnDpiChanged(e);
        EnsureFonts();
        Size = new Size(S(LogicalWidth), S(LogicalHeight));
        LayoutSearchBox();
        SnapHighlightToSelection();
        Invalidate();
    }

    private void ApplyWindowEffects()
    {
        try
        {
            var preference = DWMWCP_ROUND;
            _ = DwmSetWindowAttribute(Handle, DWMWA_WINDOW_CORNER_PREFERENCE, ref preference, sizeof(int));
        }
        catch { }
        acrylicEnabled = TryEnableAcrylic();
    }

    private bool TryEnableAcrylic()
    {
        try
        {
            var accent = new AccentPolicy
            {
                AccentState = ACCENT_ENABLE_ACRYLICBLURBEHIND,
                AccentFlags = 2,
                GradientColor = AcrylicGradientColor,
                AnimationId = 0
            };
            var size = Marshal.SizeOf<AccentPolicy>();
            var ptr = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(accent, ptr, false);
                var data = new WindowCompositionAttributeData
                {
                    Attribute = WCA_ACCENT_POLICY,
                    Data = ptr,
                    SizeOfData = size
                };
                return SetWindowCompositionAttribute(Handle, ref data) != 0;
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

    private void EnsureFonts()
    {
        var dpi = DeviceDpi > 0 ? DeviceDpi : 96;
        if (cachedFontDpi == dpi && nameFont is not null) return;
        cachedFontDpi = dpi;

        DisposeFonts();
        eyebrowFont = new Font("Consolas", Sf(10f), FontStyle.Bold, GraphicsUnit.Pixel);
        countFont = new Font("Consolas", Sf(11f), FontStyle.Regular, GraphicsUnit.Pixel);
        nameFont = new Font("Segoe UI Semibold", Sf(15f), FontStyle.Regular, GraphicsUnit.Pixel);
        nameBoldFont = new Font("Segoe UI", Sf(15f), FontStyle.Bold, GraphicsUnit.Pixel);
        subtitleFont = new Font("Segoe UI", Sf(12f), FontStyle.Regular, GraphicsUnit.Pixel);
        badgeFont = new Font("Consolas", Sf(13f), FontStyle.Bold, GraphicsUnit.Pixel);
        hintFont = new Font("Segoe UI", Sf(11f), FontStyle.Regular, GraphicsUnit.Pixel);
        emptyFont = new Font("Segoe UI", Sf(14f), FontStyle.Regular, GraphicsUnit.Pixel);

        var nextSearchFont = new Font("Segoe UI", Sf(20f), FontStyle.Regular, GraphicsUnit.Pixel);
        searchBox.Font = nextSearchFont;
        searchFont?.Dispose();
        searchFont = nextSearchFont;
    }

    private void DisposeFonts()
    {
        eyebrowFont?.Dispose(); eyebrowFont = null;
        countFont?.Dispose(); countFont = null;
        nameFont?.Dispose(); nameFont = null;
        nameBoldFont?.Dispose(); nameBoldFont = null;
        subtitleFont?.Dispose(); subtitleFont = null;
        badgeFont?.Dispose(); badgeFont = null;
        hintFont?.Dispose(); hintFont = null;
        emptyFont?.Dispose(); emptyFont = null;
        searchFont?.Dispose(); searchFont = null;
    }

    private void LayoutSearchBox()
    {
        var left = S(50);
        var rightMargin = S(22);
        var top = S(42);
        var height = S(30);
        searchBox.Bounds = new Rectangle(left, top, Math.Max(S(100), ClientSize.Width - left - rightMargin), height);
    }

    // MARK: Configuration & Data

    public void Configure(string nextOrigin, string nextKey, string nextShortcut, bool available)
    {
        var normalized = nextOrigin.Trim().TrimEnd('/');
        var changed = !string.Equals(normalized, origin, StringComparison.Ordinal) ||
                      !string.Equals(nextKey, managementKey, StringComparison.Ordinal);
        origin = normalized;
        managementKey = nextKey;
        shortcutHint = string.IsNullOrWhiteSpace(nextShortcut) ? "Alt+Space" : nextShortcut.Trim();
        launcherAvailable = available;

        if (changed)
        {
            cachedApps.Clear();
            visibleResults.Clear();
            lastFetchedUtc = DateTime.MinValue;
            ClearIconCache();
        }
        if (!available)
        {
            HideImmediately();
        }
        else if (Visible && changed)
        {
            _ = RefreshCatalogAsync(force: true);
        }
    }

    public void WarmCatalog()
    {
        if (!launcherAvailable) return;
        if (cachedApps.Count == 0 || (DateTime.UtcNow - lastFetchedUtc).TotalSeconds > CacheTtlSeconds)
        {
            _ = RefreshCatalogAsync(force: false);
        }
    }

    public void ToggleLauncher()
    {
        if (Visible && animPhase != AnimPhase.Hiding)
        {
            HideAnimated(restoreFocus: true);
        }
        else
        {
            ShowLauncher();
        }
    }

    public void ShowLauncher()
    {
        errorTimer.Stop();
        statusMessage = string.Empty;
        statusIsError = false;

        if (!Visible || animPhase == AnimPhase.Hiding)
        {
            var fg = GetForegroundWindow();
            if (fg != IntPtr.Zero && fg != Handle)
            {
                previousForegroundWindow = fg;
            }
        }

        if (!IsHandleCreated) CreateHandle();
        var dpiBefore = DeviceDpi;
        PositionOnCursorScreen();
        if (DeviceDpi != dpiBefore)
        {
            PositionOnCursorScreen();
        }
        EnsureFonts();
        LayoutSearchBox();

        searchBox.TextChanged -= OnSearchTextChanged;
        searchBox.Text = string.Empty;
        searchBox.TextChanged += OnSearchTextChanged;

        ApplyFilter(startStagger: false);

        var needsRefresh = cachedApps.Count == 0 || (DateTime.UtcNow - lastFetchedUtc).TotalSeconds > CacheTtlSeconds;
        if (needsRefresh)
        {
            _ = RefreshCatalogAsync(force: false);
        }

        Opacity = 0.0;
        Location = new Point(Location.X, targetTop + S(10));
        suppressDeactivateUntilUtc = DateTime.UtcNow.AddMilliseconds(240);

        if (!Visible)
        {
            Show();
        }
        ForceForeground();
        searchBox.Focus();

        var now = animClock.Elapsed.TotalMilliseconds;
        animPhase = AnimPhase.Showing;
        phaseStartMs = now;
        staggerStartMs = now;
        staggerActive = visibleResults.Count > 0;
        SnapHighlightToSelection();
        EnsureAnimTimerRunning();
        Invalidate();
    }

    public void HideImmediately()
    {
        animTimer.Stop();
        errorTimer.Stop();
        animPhase = AnimPhase.Idle;
        staggerActive = false;
        highlightAnimating = false;
        if (Visible) base.Hide();
        Opacity = 1.0;
    }

    private void HideAnimated(bool restoreFocus)
    {
        if (!Visible || animPhase == AnimPhase.Hiding) return;
        errorTimer.Stop();
        pendingRestoreFocus = restoreFocus;
        animPhase = AnimPhase.Hiding;
        phaseStartMs = animClock.Elapsed.TotalMilliseconds;
        staggerActive = false;
        EnsureAnimTimerRunning();
    }

    private void PositionOnCursorScreen()
    {
        var area = Screen.FromPoint(Cursor.Position).WorkingArea;
        var w = S(LogicalWidth);
        var h = S(LogicalHeight);
        Size = new Size(w, h);
        var x = area.Left + Math.Max(0, (area.Width - w) / 2);
        var topInset = (int)Math.Round(area.Height * 0.18);
        var y = area.Top + topInset;
        var maxTop = area.Bottom - h - S(16);
        if (y > maxTop) y = Math.Max(area.Top + S(16), maxTop);
        targetTop = y;
        Location = new Point(x, y);
    }

    private async Task RefreshCatalogAsync(bool force)
    {
        if (string.IsNullOrWhiteSpace(origin) || string.IsNullOrWhiteSpace(managementKey))
        {
            statusMessage = "本机 Server 未连接";
            statusIsError = false;
            Invalidate();
            return;
        }
        if (isFetching && !force) return;
        isFetching = true;
        var gen = ++fetchGeneration;
        var hadCached = cachedApps.Count > 0;
        if (!hadCached && Visible)
        {
            statusMessage = "正在扫描应用…";
            statusIsError = false;
            Invalidate();
        }

        try
        {
            var suffix = force ? "/v1/management/launcher/apps?refresh=1" : "/v1/management/launcher/apps";
            using var req = new HttpRequestMessage(HttpMethod.Get, origin + suffix);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", managementKey);
            req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

            using var resp = await httpClient.SendAsync(req).ConfigureAwait(true);
            var body = await resp.Content.ReadAsStringAsync().ConfigureAwait(true);
            if (IsDisposed || gen != fetchGeneration) return;

            if (!resp.IsSuccessStatusCode)
            {
                var errMsg = ExtractErrorMessage(body);
                statusMessage = hadCached ? "刷新失败，已显示缓存" : $"加载失败（{(string.IsNullOrEmpty(errMsg) ? $"HTTP {(int)resp.StatusCode}" : errMsg)}）";
                statusIsError = !hadCached;
                Invalidate();
                return;
            }

            var decoded = JsonSerializer.Deserialize<LauncherAppsResponse>(body);
            cachedApps = decoded?.Apps ?? new List<LauncherApp>();
            lastFetchedUtc = DateTime.UtcNow;
            statusMessage = string.Empty;
            statusIsError = false;
            ApplyFilter(startStagger: !hadCached && Visible);
        }
        catch (Exception ex)
        {
            if (IsDisposed || gen != fetchGeneration) return;
            statusMessage = hadCached ? "刷新失败，已显示缓存" : $"加载失败：{ex.Message}";
            statusIsError = !hadCached;
            Invalidate();
        }
        finally
        {
            if (gen == fetchGeneration) isFetching = false;
        }
    }

    private void OnSearchTextChanged(object? sender, EventArgs e)
    {
        searchBox.Invalidate();
        ApplyFilter(startStagger: true);
    }

    private void ApplyFilter(bool startStagger)
    {
        visibleResults = LauncherRanker.Filter(cachedApps, searchBox.Text);
        scrollOffset = 0;
        hoverIndex = -1;
        selectedIndex = visibleResults.Count > 0 ? 0 : -1;
        SnapHighlightToSelection();
        if (startStagger && visibleResults.Count > 0 && Visible)
        {
            staggerStartMs = animClock.Elapsed.TotalMilliseconds;
            staggerActive = true;
            EnsureAnimTimerRunning();
        }
        Invalidate();
    }

    private void MoveSelection(int delta)
    {
        if (visibleResults.Count == 0) return;
        var baseIdx = selectedIndex >= 0 ? selectedIndex : 0;
        var next = Math.Clamp(baseIdx + delta, 0, visibleResults.Count - 1);
        if (next == selectedIndex) return;

        var oldY = highlightVisible ? highlightCurrentY : RowTopY(baseIdx);
        selectedIndex = next;
        EnsureSelectionVisible();
        var newY = RowTopY(selectedIndex);

        highlightFromY = oldY;
        highlightToY = newY;
        highlightStartMs = animClock.Elapsed.TotalMilliseconds;
        highlightAnimating = true;
        highlightVisible = true;
        EnsureAnimTimerRunning();
        Invalidate();
    }

    private void EnsureSelectionVisible()
    {
        if (selectedIndex < 0) return;
        if (selectedIndex < scrollOffset)
        {
            scrollOffset = selectedIndex;
        }
        else if (selectedIndex >= scrollOffset + VisibleRowsMax)
        {
            scrollOffset = selectedIndex - VisibleRowsMax + 1;
        }
        var maxScroll = Math.Max(0, visibleResults.Count - VisibleRowsMax);
        scrollOffset = Math.Clamp(scrollOffset, 0, maxScroll);
    }

    private float RowTopY(int index)
    {
        var visualRow = index - scrollOffset;
        return S(LogicalHeaderHeight + LogicalListTopPadding) + visualRow * S(LogicalRowHeight);
    }

    private void SnapHighlightToSelection()
    {
        if (selectedIndex < 0 || selectedIndex >= visibleResults.Count)
        {
            highlightVisible = false;
            highlightAnimating = false;
            return;
        }
        EnsureSelectionVisible();
        highlightCurrentY = RowTopY(selectedIndex);
        highlightFromY = highlightCurrentY;
        highlightToY = highlightCurrentY;
        highlightAnimating = false;
        highlightVisible = true;
    }

    // MARK: Animation Loop (16ms Timer)

    private void EnsureAnimTimerRunning()
    {
        if (!animTimer.Enabled) animTimer.Start();
    }

    private void OnAnimationTick(object? sender, EventArgs e)
    {
        var now = animClock.Elapsed.TotalMilliseconds;
        var keepRunning = false;

        if (animPhase == AnimPhase.Showing)
        {
            var t = Math.Clamp((now - phaseStartMs) / EnterDurationMs, 0.0, 1.0);
            var eased = EaseOutCubic(t);
            Opacity = eased;
            var offset = (int)Math.Round(S(10) * (1.0 - eased));
            var nextTop = targetTop + offset;
            if (Top != nextTop) Top = nextTop;
            if (t < 1.0) keepRunning = true;
            else
            {
                Opacity = 1.0;
                Top = targetTop;
                animPhase = AnimPhase.Idle;
            }
        }
        else if (animPhase == AnimPhase.Hiding)
        {
            var t = Math.Clamp((now - phaseStartMs) / ExitDurationMs, 0.0, 1.0);
            Opacity = Math.Max(0.0, 1.0 - t * t);
            if (t < 1.0) keepRunning = true;
            else
            {
                animPhase = AnimPhase.Idle;
                animTimer.Stop();
                base.Hide();
                Opacity = 1.0;
                var prev = previousForegroundWindow;
                previousForegroundWindow = IntPtr.Zero;
                if (pendingRestoreFocus && prev != IntPtr.Zero)
                {
                    SetForegroundWindow(prev);
                }
                return;
            }
        }

        if (staggerActive)
        {
            var totalStagger = VisibleRowsMax * StaggerStepMs + StaggerRowDurationMs;
            if (now - staggerStartMs < totalStagger) keepRunning = true;
            else staggerActive = false;
        }

        if (highlightAnimating)
        {
            var ht = Math.Clamp((now - highlightStartMs) / HighlightSlideDurationMs, 0.0, 1.0);
            var he = (float)EaseOutCubic(ht);
            highlightCurrentY = highlightFromY + (highlightToY - highlightFromY) * he;
            if (ht < 1.0) keepRunning = true;
            else
            {
                highlightCurrentY = highlightToY;
                highlightAnimating = false;
            }
        }

        if (!keepRunning) animTimer.Stop();
        Invalidate();
    }

    private static double EaseOutCubic(double t)
    {
        var inv = 1.0 - t;
        return 1.0 - inv * inv * inv;
    }

    // MARK: Keyboard & Mouse Input

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (!e.Handled)
        {
            OnLauncherKeyDown(this, e);
        }
        base.OnKeyDown(e);
    }

    private void OnLauncherKeyDown(object? sender, KeyEventArgs e)
    {
        // Let IME composition consume keys without intercepting them.
        if (e.KeyCode == Keys.ProcessKey) return;

        switch (e.KeyCode)
        {
            case Keys.Escape:
                e.Handled = true;
                e.SuppressKeyPress = true;
                HideAnimated(restoreFocus: true);
                break;
            case Keys.Up:
                e.Handled = true;
                e.SuppressKeyPress = true;
                MoveSelection(-1);
                break;
            case Keys.Down:
                e.Handled = true;
                e.SuppressKeyPress = true;
                MoveSelection(1);
                break;
            case Keys.PageUp:
                e.Handled = true;
                e.SuppressKeyPress = true;
                MoveSelection(-VisibleRowsMax);
                break;
            case Keys.PageDown:
                e.Handled = true;
                e.SuppressKeyPress = true;
                MoveSelection(VisibleRowsMax);
                break;
            case Keys.Enter:
                e.Handled = true;
                e.SuppressKeyPress = true;
                if (selectedIndex >= 0 && selectedIndex < visibleResults.Count)
                {
                    _ = OpenAppAsync(visibleResults[selectedIndex].App);
                }
                break;
        }
    }

    protected override void OnMouseWheel(MouseEventArgs e)
    {
        base.OnMouseWheel(e);
        if (visibleResults.Count <= VisibleRowsMax) return;
        var deltaRows = e.Delta > 0 ? -1 : 1;
        var maxScroll = Math.Max(0, visibleResults.Count - VisibleRowsMax);
        var nextScroll = Math.Clamp(scrollOffset + deltaRows, 0, maxScroll);
        if (nextScroll != scrollOffset)
        {
            scrollOffset = nextScroll;
            if (selectedIndex >= 0)
            {
                highlightCurrentY = RowTopY(selectedIndex);
                highlightToY = highlightCurrentY;
                highlightAnimating = false;
            }
            Invalidate();
        }
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        var idx = HitTestRow(e.Location);
        if (idx != hoverIndex)
        {
            hoverIndex = idx;
            Cursor = idx >= 0 ? Cursors.Hand : Cursors.Default;
            Invalidate();
        }
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        if (hoverIndex >= 0)
        {
            hoverIndex = -1;
            Cursor = Cursors.Default;
            Invalidate();
        }
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left) return;
        var idx = HitTestRow(e.Location);
        if (idx >= 0 && idx < visibleResults.Count)
        {
            selectedIndex = idx;
            SnapHighlightToSelection();
            Invalidate();
            _ = OpenAppAsync(visibleResults[idx].App);
        }
    }

    private int HitTestRow(Point point)
    {
        var listTop = S(LogicalHeaderHeight + LogicalListTopPadding);
        var rowH = S(LogicalRowHeight);
        var listBottom = ClientSize.Height - S(LogicalFooterHeight);
        if (point.Y < listTop || point.Y >= listBottom) return -1;
        var visualRow = (point.Y - listTop) / rowH;
        if (visualRow < 0 || visualRow >= VisibleRowsMax) return -1;
        var idx = scrollOffset + visualRow;
        return idx >= 0 && idx < visibleResults.Count ? idx : -1;
    }

    // MARK: App Launch + Fallback

    private async Task OpenAppAsync(LauncherApp app)
    {
        var openedViaApi = false;
        if (!string.IsNullOrWhiteSpace(origin) && !string.IsNullOrWhiteSpace(managementKey))
        {
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Post, origin + "/v1/management/launcher/open");
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", managementKey);
                req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
                req.Content = new StringContent(JsonSerializer.Serialize(new { id = app.Id }), Encoding.UTF8, "application/json");

                using var resp = await httpClient.SendAsync(req).ConfigureAwait(true);
                if (resp.IsSuccessStatusCode)
                {
                    openedViaApi = true;
                }
            }
            catch
            {
                openedViaApi = false;
            }
        }

        if (IsDisposed) return;

        if (openedViaApi)
        {
            lastFetchedUtc = DateTime.MinValue;
            HideAnimated(restoreFocus: false);
            return;
        }

        // Local ShellExecute fallback when Server API is unreachable or failed.
        if (!string.IsNullOrWhiteSpace(app.Path))
        {
            try
            {
                Process.Start(new ProcessStartInfo(app.Path) { UseShellExecute = true });
                HideAnimated(restoreFocus: false);
                return;
            }
            catch { }
        }

        ShowTransientError($"无法打开 {app.Name}");
    }

    private void ShowTransientError(string message)
    {
        errorTimer.Stop();
        statusMessage = message;
        statusIsError = true;
        errorTimer.Start();
        Invalidate();
    }

    private static string ExtractErrorMessage(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("message", out var msg) && msg.ValueKind == JsonValueKind.String)
            {
                return msg.GetString() ?? string.Empty;
            }
            if (doc.RootElement.TryGetProperty("error", out var err) && err.ValueKind == JsonValueKind.String)
            {
                return err.GetString() ?? string.Empty;
            }
        }
        catch { }
        return string.Empty;
    }

    // MARK: Icons

    private Bitmap? GetOrLoadIcon(LauncherApp app)
    {
        if (string.Equals(app.Kind, "uwp", StringComparison.OrdinalIgnoreCase)) return null;
        var iconPath = string.IsNullOrWhiteSpace(app.Icon) ? app.Path : app.Icon;
        if (string.IsNullOrWhiteSpace(iconPath)) return null;

        if (iconCache.TryGetValue(iconPath, out var cached)) return cached;
        if (!iconLoading.Add(iconPath)) return null;

        _ = Task.Run(() =>
        {
            Bitmap? bmp = null;
            try
            {
                if (File.Exists(iconPath))
                {
                    using var icon = System.Drawing.Icon.ExtractAssociatedIcon(iconPath);
                    if (icon is not null)
                    {
                        bmp = icon.ToBitmap();
                    }
                }
            }
            catch { bmp = null; }

            if (IsDisposed || !IsHandleCreated)
            {
                bmp?.Dispose();
                return;
            }
            try
            {
                BeginInvoke((Action)(() =>
                {
                    iconLoading.Remove(iconPath);
                    if (IsDisposed)
                    {
                        bmp?.Dispose();
                        return;
                    }
                    iconCache[iconPath] = bmp;
                    if (Visible) Invalidate();
                }));
            }
            catch (InvalidOperationException)
            {
                bmp?.Dispose();
            }
        });
        return null;
    }

    private void ClearIconCache()
    {
        foreach (var bmp in iconCache.Values) bmp?.Dispose();
        iconCache.Clear();
        iconLoading.Clear();
    }

    // MARK: GDI+ Custom Painting

    protected override void OnPaint(PaintEventArgs e)
    {
        if (ClientSize.Width <= 2 || ClientSize.Height <= 2) return;
        EnsureFonts();
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

        var rect = new RectangleF(0, 0, ClientSize.Width, ClientSize.Height);
        var radius = Sf(14f);

        // Panel backdrop gradient (slightly lighter alpha when Acrylic blur is active).
        var topColor = acrylicEnabled ? Color.FromArgb(204, 16, 23, 39) : BgTop;
        var bottomColor = acrylicEnabled ? Color.FromArgb(224, 8, 11, 21) : BgBottom;
        using (var bgBrush = new LinearGradientBrush(rect, topColor, bottomColor, 90f))
        {
            g.FillRectangle(bgBrush, rect);
        }

        // Subtle top-left cyan ambient glow (no left accent bar).
        using (var glowPath = new GraphicsPath())
        {
            glowPath.AddEllipse(-Sf(120), -Sf(100), Sf(460), Sf(260));
            using var glowBrush = new PathGradientBrush(glowPath)
            {
                CenterColor = Color.FromArgb(28, 98, 237, 255),
                SurroundColors = new[] { Color.FromArgb(0, 98, 237, 255) }
            };
            g.FillPath(glowBrush, glowPath);
        }

        // Search input container background pill (subtle inset matching searchBox.BackColor).
        var searchBarRect = new RectangleF(S(14), S(35), ClientSize.Width - S(28), S(42));
        using (var searchPath = CreateRoundedRect(searchBarRect, Sf(10f)))
        using (var searchBrush = new SolidBrush(SearchBg))
        using (var searchBorder = new Pen(Color.FromArgb(30, 98, 237, 255), 1f))
        {
            g.FillPath(searchBrush, searchPath);
            g.DrawPath(searchBorder, searchPath);
        }

        DrawHeader(g);
        DrawList(g);
        DrawFooter(g);

        // Crisp 1px full-perimeter cyan border (#62EDFF @ 24%).
        var borderRect = new RectangleF(0.5f, 0.5f, ClientSize.Width - 1f, ClientSize.Height - 1f);
        using var borderPath = CreateRoundedRect(borderRect, radius);
        using var borderPen = new Pen(BorderCyan, 1f);
        g.DrawPath(borderPen, borderPath);
    }

    private void DrawHeader(Graphics g)
    {
        using var eyebrowBrush = new SolidBrush(Color.FromArgb(225, Cyan));
        g.DrawString("AIH LAUNCH", eyebrowFont!, eyebrowBrush, new PointF(S(20), S(12)));

        var countText = visibleResults.Count == 0
            ? (isFetching ? "加载中…" : "0 个应用")
            : (string.IsNullOrWhiteSpace(searchBox.Text)
                ? $"{visibleResults.Count} 个应用"
                : $"{visibleResults.Count} / {cachedApps.Count}");
        using var countBrush = new SolidBrush(TextMuted);
        using var rightFmt = new StringFormat { Alignment = StringAlignment.Far };
        g.DrawString(countText, countFont!, countBrush, new RectangleF(S(180), S(12), ClientSize.Width - S(200), S(18)), rightFmt);

        // Magnifying glass vector icon in search row.
        var iconX = Sf(25f);
        var iconY = Sf(48f);
        var circleD = Sf(13f);
        using var glassPen = new Pen(Color.FromArgb(210, Cyan), Sf(1.8f)) { StartCap = LineCap.Round, EndCap = LineCap.Round };
        g.DrawEllipse(glassPen, iconX, iconY, circleD, circleD);
        g.DrawLine(glassPen, iconX + circleD * 0.78f, iconY + circleD * 0.78f, iconX + Sf(16.5f), iconY + Sf(16.5f));

        // 1px functional separator between search row and results list.
        using var sepPen = new Pen(SeparatorCyan, 1f);
        var sepY = S(LogicalHeaderHeight);
        g.DrawLine(sepPen, S(16), sepY, ClientSize.Width - S(16), sepY);
    }

    private void DrawList(Graphics g)
    {
        var listTop = S(LogicalHeaderHeight + LogicalListTopPadding);
        var listBottom = ClientSize.Height - S(LogicalFooterHeight);
        var listRect = new RectangleF(0, listTop, ClientSize.Width, Math.Max(0, listBottom - listTop));

        if (visibleResults.Count == 0)
        {
            var msg = isFetching && cachedApps.Count == 0 ? "正在加载应用…" : "没有找到应用";
            using var emptyBrush = new SolidBrush(TextMuted);
            using var centerFmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
            g.DrawString(msg, emptyFont!, emptyBrush, listRect, centerFmt);
            return;
        }

        var listState = g.Save();
        g.SetClip(listRect);

        var rowH = S(LogicalRowHeight);
        var now = animClock.Elapsed.TotalMilliseconds;

        // Sliding rounded selection highlight card (behind selected row).
        if (highlightVisible && selectedIndex >= scrollOffset && selectedIndex < scrollOffset + VisibleRowsMax)
        {
            var hlRect = new RectangleF(S(12), highlightCurrentY + S(2), ClientSize.Width - S(24), rowH - S(4));
            if (hlRect.Width > 1 && hlRect.Height > 1)
            {
                using var hlPath = CreateRoundedRect(hlRect, Sf(10f));
                using var hlBrush = new LinearGradientBrush(
                    hlRect,
                    Color.FromArgb(40, 98, 237, 255),
                    Color.FromArgb(24, 177, 139, 255),
                    0f);
                using var hlBorder = new Pen(Color.FromArgb(96, 98, 237, 255), 1f);
                g.FillPath(hlBrush, hlPath);
                g.DrawPath(hlBorder, hlPath);
            }
        }

        var endIndex = Math.Min(visibleResults.Count, scrollOffset + VisibleRowsMax);
        for (var idx = scrollOffset; idx < endIndex; idx++)
        {
            var visualRow = idx - scrollOffset;
            var baseY = listTop + visualRow * rowH;
            var alphaFactor = 1.0f;
            var slideY = 0.0f;

            if (staggerActive && visualRow < VisibleRowsMax)
            {
                var rowElapsed = now - staggerStartMs - visualRow * StaggerStepMs;
                var rt = Math.Clamp(rowElapsed / StaggerRowDurationMs, 0.0, 1.0);
                var re = (float)EaseOutCubic(rt);
                alphaFactor = re;
                slideY = Sf(6f) * (1.0f - re);
            }
            if (alphaFactor <= 0.01f) continue;

            var rowY = baseY + slideY;
            var isSelected = idx == selectedIndex;
            var isHovered = idx == hoverIndex && !isSelected;

            if (isHovered)
            {
                var hovRect = new RectangleF(S(12), rowY + S(2), ClientSize.Width - S(24), rowH - S(4));
                using var hovPath = CreateRoundedRect(hovRect, Sf(10f));
                using var hovBrush = new SolidBrush(Color.FromArgb((int)(18 * alphaFactor), 232, 237, 248));
                g.FillPath(hovBrush, hovPath);
            }

            DrawAppRow(g, visibleResults[idx], rowY, rowH, isSelected, alphaFactor);
        }

        // Slim overlay scrollbar thumb when list exceeds 8 visible rows.
        if (visibleResults.Count > VisibleRowsMax)
        {
            var trackTop = listTop + S(4);
            var trackH = Math.Max(S(24), (listBottom - listTop) - S(8));
            var thumbH = Math.Max(S(26), (int)Math.Round(trackH * (VisibleRowsMax / (double)visibleResults.Count)));
            var maxScroll = Math.Max(1, visibleResults.Count - VisibleRowsMax);
            var thumbY = trackTop + (int)Math.Round((trackH - thumbH) * (scrollOffset / (double)maxScroll));
            var thumbRect = new RectangleF(ClientSize.Width - S(7), thumbY, Sf(3.5f), thumbH);
            using var thumbPath = CreateRoundedRect(thumbRect, Sf(2f));
            using var thumbBrush = new SolidBrush(Color.FromArgb(72, 98, 237, 255));
            g.FillPath(thumbBrush, thumbPath);
        }

        g.Restore(listState);
    }

    private void DrawAppRow(Graphics g, LauncherMatchResult match, float rowY, int rowH, bool isSelected, float alpha)
    {
        var app = match.App;
        var iconSize = S(36);
        var iconX = S(22);
        var iconY = rowY + (rowH - iconSize) / 2f;
        var iconRect = new RectangleF(iconX, iconY, iconSize, iconSize);

        var bmp = GetOrLoadIcon(app);
        if (bmp is not null)
        {
            var state = g.Save();
            using var clipPath = CreateRoundedRect(iconRect, Sf(9f));
            g.SetClip(clipPath, CombineMode.Intersect);
            g.DrawImage(bmp, iconRect);
            g.Restore(state);
        }
        else
        {
            DrawGenericAppIcon(g, iconRect, string.Equals(app.Kind, "uwp", StringComparison.OrdinalIgnoreCase), alpha);
        }

        var badgeW = S(26);
        var badgeH = S(22);
        var badgeRightMargin = S(22);
        var textLeft = iconX + iconSize + S(12);
        var textRight = ClientSize.Width - badgeRightMargin - (isSelected ? badgeW + S(10) : S(6));
        var textMaxWidth = Math.Max(S(60), textRight - textLeft);

        var nameY = rowY + S(6);
        DrawHighlightedName(g, app.Name, match, textLeft, nameY, textMaxWidth, alpha);

        var subY = rowY + S(27);
        var subText = string.IsNullOrWhiteSpace(app.Subtitle) ? "应用程序" : app.Subtitle;
        using var subBrush = new SolidBrush(Color.FromArgb((int)(255 * alpha), TextMuted));
        using var subFmt = new StringFormat(StringFormatFlags.NoWrap) { Trimming = StringTrimming.EllipsisPath };
        g.DrawString(subText, subtitleFont!, subBrush, new RectangleF(textLeft, subY, textMaxWidth, S(18)), subFmt);

        if (isSelected)
        {
            var badgeX = ClientSize.Width - badgeRightMargin - badgeW;
            var badgeY = rowY + (rowH - badgeH) / 2f;
            var badgeRect = new RectangleF(badgeX, badgeY, badgeW, badgeH);
            using var badgePath = CreateRoundedRect(badgeRect, Sf(6f));
            using var badgeFill = new SolidBrush(Color.FromArgb((int)(38 * alpha), 98, 237, 255));
            using var badgeBorder = new Pen(Color.FromArgb((int)(92 * alpha), 98, 237, 255), 1f);
            using var badgeTextBrush = new SolidBrush(Color.FromArgb((int)(255 * alpha), Cyan));
            using var badgeFmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
            g.FillPath(badgeFill, badgePath);
            g.DrawPath(badgeBorder, badgePath);
            g.DrawString("↵", badgeFont!, badgeTextBrush, badgeRect, badgeFmt);
        }
    }

    private void DrawHighlightedName(Graphics g, string name, LauncherMatchResult match, float x, float y, float maxWidth, float alpha)
    {
        if (string.IsNullOrEmpty(name)) return;
        var a = (int)Math.Clamp(255 * alpha, 0, 255);

        if (match.MatchSource != LauncherMatchSource.Name || match.MatchedIndices.Count == 0)
        {
            using var normalBrush = new SolidBrush(Color.FromArgb(a, TextPrimary));
            using var fmt = new StringFormat(StringFormatFlags.NoWrap) { Trimming = StringTrimming.EllipsisCharacter };
            g.DrawString(name, nameFont!, normalBrush, new RectangleF(x, y, maxWidth, S(21)), fmt);
            return;
        }

        using var primaryBrush = new SolidBrush(Color.FromArgb(a, TextPrimary));
        using var highlightBrush = new SolidBrush(Color.FromArgb(a, Cyan));
        using var fmtTypo = new StringFormat(StringFormat.GenericTypographic);
        fmtTypo.FormatFlags |= StringFormatFlags.MeasureTrailingSpaces | StringFormatFlags.NoWrap;

        var cursorX = x;
        var rightLimit = x + maxWidth;
        var idx = 0;
        while (idx < name.Length && cursorX < rightLimit)
        {
            var hl = match.MatchedIndices.Contains(idx);
            var start = idx;
            while (idx < name.Length && match.MatchedIndices.Contains(idx) == hl) idx++;
            var segment = name.Substring(start, idx - start);
            var font = hl ? nameBoldFont! : nameFont!;
            var brush = hl ? highlightBrush : primaryBrush;
            var segSize = g.MeasureString(segment, font, int.MaxValue, fmtTypo);

            if (cursorX + segSize.Width <= rightLimit)
            {
                g.DrawString(segment, font, brush, new PointF(cursorX, y), fmtTypo);
                cursorX += segSize.Width;
            }
            else
            {
                using var clipFmt = new StringFormat(fmtTypo) { Trimming = StringTrimming.EllipsisCharacter };
                g.DrawString(segment, font, brush, new RectangleF(cursorX, y, Math.Max(0, rightLimit - cursorX), S(21)), clipFmt);
                break;
            }
        }
    }

    private void DrawGenericAppIcon(Graphics g, RectangleF rect, bool isUwp, float alpha)
    {
        if (rect.Width <= 1 || rect.Height <= 1) return;
        using var path = CreateRoundedRect(rect, Sf(9f));
        using var fill = new LinearGradientBrush(
            rect,
            Color.FromArgb((int)Math.Clamp(56 * alpha, 0, 255), isUwp ? Cyan : Purple),
            Color.FromArgb((int)Math.Clamp(36 * alpha, 0, 255), isUwp ? Purple : Cyan),
            45f);
        using var border = new Pen(Color.FromArgb((int)Math.Clamp(88 * alpha, 0, 255), Cyan), 1f);
        g.FillPath(fill, path);
        g.DrawPath(border, path);

        // Four-square geometric app tile glyph.
        var pad = Sf(9f);
        var gap = Sf(3f);
        var tile = (rect.Width - pad * 2 - gap) / 2f;
        using var tileBrush = new SolidBrush(Color.FromArgb((int)Math.Clamp(210 * alpha, 0, 255), isUwp ? Cyan : TextPrimary));
        for (var r = 0; r < 2; r++)
        {
            for (var c = 0; c < 2; c++)
            {
                var tr = new RectangleF(rect.X + pad + c * (tile + gap), rect.Y + pad + r * (tile + gap), tile, tile);
                using var tp = CreateRoundedRect(tr, Sf(2f));
                g.FillPath(tileBrush, tp);
            }
        }
    }

    private void DrawFooter(Graphics g)
    {
        var footerTop = ClientSize.Height - S(LogicalFooterHeight);
        using var sepPen = new Pen(SeparatorCyan, 1f);
        g.DrawLine(sepPen, S(16), footerTop, ClientSize.Width - S(16), footerTop);

        var hints = $"↑↓ 选择    ↵ 打开    Esc 关闭    {shortcutHint} 切换";
        using var hintBrush = new SolidBrush(TextHint);
        using var leftFmt = new StringFormat(StringFormatFlags.NoWrap) { LineAlignment = StringAlignment.Center };
        var footerRect = new RectangleF(S(20), footerTop, ClientSize.Width - S(40), S(LogicalFooterHeight));
        g.DrawString(hints, hintFont!, hintBrush, footerRect, leftFmt);

        if (!string.IsNullOrEmpty(statusMessage))
        {
            using var statusBrush = new SolidBrush(statusIsError ? ErrorSoft : TextMuted);
            using var rightFmt = new StringFormat(StringFormatFlags.NoWrap)
            {
                Alignment = StringAlignment.Far,
                LineAlignment = StringAlignment.Center,
                Trimming = StringTrimming.EllipsisCharacter
            };
            var statusRect = new RectangleF(ClientSize.Width * 0.45f, footerTop, ClientSize.Width * 0.55f - S(20), S(LogicalFooterHeight));
            g.DrawString(statusMessage, hintFont!, statusBrush, statusRect, rightFmt);
        }
    }

    private static GraphicsPath CreateRoundedRect(RectangleF bounds, float radius)
    {
        var path = new GraphicsPath();
        var d = Math.Min(radius * 2f, Math.Min(bounds.Width, bounds.Height));
        if (d <= 0.5f)
        {
            path.AddRectangle(bounds);
            return path;
        }
        path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
        path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
        path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
        path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            animTimer.Stop();
            animTimer.Dispose();
            errorTimer.Stop();
            errorTimer.Dispose();
            httpClient.Dispose();
            ClearIconCache();
            DisposeFonts();
        }
        base.Dispose(disposing);
    }

    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const int DWMWCP_ROUND = 2;
    private const int WCA_ACCENT_POLICY = 19;
    private const int ACCENT_ENABLE_ACRYLICBLURBEHIND = 4;
    private const uint AcrylicGradientColor = 0xCC0B1220;

    [StructLayout(LayoutKind.Sequential)]
    private struct AccentPolicy
    {
        public int AccentState;
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

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    [DllImport("user32.dll")]
    private static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WindowCompositionAttributeData data);

    private void ForceForeground()
    {
        var fg = GetForegroundWindow();
        var fgThread = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out _) : 0;
        var curThread = GetCurrentThreadId();
        var attached = false;
        if (fgThread != 0 && fgThread != curThread)
        {
            attached = AttachThreadInput(curThread, fgThread, true);
        }
        try
        {
            TopMost = true;
            Activate();
            BringToFront();
            SetForegroundWindow(Handle);
        }
        finally
        {
            if (attached) AttachThreadInput(curThread, fgThread, false);
        }
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
}
