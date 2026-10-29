using System.Drawing.Drawing2D;
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

internal sealed class TranslationApplicationContext : ApplicationContext
{
    private const int HotKeyId = 0x4149;
    private readonly object outputLock = new();
    private readonly bool fullApp;
    private readonly TranslationWindow window;
    private readonly HotKeyWindow hotKeyWindow;
    private string target = "zh-Hans";
    private string shortcut = "Ctrl+Alt+T";
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
        // Helper mode keeps the window hidden, but protocol messages are
        // marshalled onto the WinForms UI thread through BeginInvoke. Create
        // the hidden form handle eagerly so that hello/configure events are
        // not dropped before the first visible window is shown.
        window.CreateControl();
        _ = window.Handle;
        hotKeyWindow = new HotKeyWindow(HotKeyId, OnHotKey, OnWindowClosed);
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
        var nextShortcut = GetString(root, "shortcut") ?? GetString(root, "nativeShortcut");
        if (!string.IsNullOrWhiteSpace(nextShortcut)) shortcut = nextShortcut;
        if (!hotKeyWindow.TryRegister(shortcut))
        {
            Emit(new DesktopEvent { Version = 1, Type = "error", Code = "windows_shortcut_registration_failed", Message = $"无法注册快捷键 {shortcut}", Retryable = false });
            return;
        }
        window.SetTarget(target);
        Emit(new DesktopEvent { Version = 1, Type = "status", Trusted = true, Platform = "win32", CaptureModes = new[] { "shortcut-clipboard" }, Permission = "clipboard-shortcut", Shortcut = shortcut });
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
        hotKeyWindow.Dispose();
        window.Dispose();
        ExitThread();
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
    private readonly int id;
    private readonly Action onHotKey;
    private readonly Action onClosed;
    private bool registered;

    public HotKeyWindow(int id, Action onHotKey, Action onClosed)
    {
        this.id = id;
        this.onHotKey = onHotKey;
        this.onClosed = onClosed;
        CreateHandle(new CreateParams());
    }

    public bool TryRegister(string value)
    {
        if (registered) UnregisterHotKey(Handle, id);
        registered = false;
        if (!TryParse(value, out var modifiers, out var key)) return false;
        registered = RegisterHotKey(Handle, id, modifiers, key);
        return registered;
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x0312 && m.WParam.ToInt32() == id) onHotKey();
        base.WndProc(ref m);
    }

    public void Dispose()
    {
        if (registered) UnregisterHotKey(Handle, id);
        registered = false;
        if (Handle != IntPtr.Zero) DestroyHandle();
        GC.SuppressFinalize(this);
    }

    private static bool TryParse(string value, out uint modifiers, out uint key)
    {
        modifiers = 0;
        key = 0;
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
                case "alt": case "option": modifiers |= 0x0001; break;
                case "shift": modifiers |= 0x0004; break;
                case "win": case "command": modifiers |= 0x0008; break;
                default: return false;
            }
        }
        var keyToken = tokens[^1];
        if (keyToken.Length == 1) { key = char.ToUpperInvariant(keyToken[0]); return true; }
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
    }

    public void SetStatus(string value) => status.Text = value;
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
