using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AihTranslation;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Console.OutputEncoding = Encoding.UTF8;
        var fullApp = Environment.GetCommandLineArgs().Contains("--full-app", StringComparer.OrdinalIgnoreCase);
        using var context = new TranslationApplicationContext(fullApp);
        _ = Task.Run(() => ReadInputAsync(context));
        Application.Run(context);
    }

    private static async Task ReadInputAsync(TranslationApplicationContext context)
    {
        try
        {
            while (await Console.In.ReadLineAsync() is { } line)
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
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public TranslationApplicationContext(bool fullApp)
    {
        this.fullApp = fullApp;
        window = new TranslationWindow();
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
        var currentGeneration = ++generation;
        try
        {
            window.Hide();
            var clipboard = Clipboard.GetDataObject();
            try
            {
                Clipboard.Clear();
                SendKeys.SendWait("^c");
                var text = string.Empty;
                for (var attempt = 0; attempt < 12 && string.IsNullOrWhiteSpace(text); attempt++)
                {
                    Thread.Sleep(25);
                    if (Clipboard.ContainsText(TextDataFormat.UnicodeText)) text = Clipboard.GetText(TextDataFormat.UnicodeText).Trim();
                }
                if (string.IsNullOrWhiteSpace(text))
                {
                    Emit(new DesktopEvent { Version = 1, Type = "error", Code = "windows_clipboard_capture_failed", Message = "没有读取到选中文本", Retryable = true });
                    return;
                }
                window.BeginTranslation(text, target);
                Emit(new DesktopEvent { Version = 1, Type = "translate-intent", Id = Guid.NewGuid().ToString("N"), Text = text, Target = target, Generation = currentGeneration });
            }
            finally
            {
                try
                {
                    if (clipboard is not null) Clipboard.SetDataObject(clipboard, true);
                }
                catch (ExternalException error)
                {
                    Emit(new DesktopEvent { Version = 1, Type = "error", Code = "windows_clipboard_restore_failed", Message = error.Message, Retryable = true });
                }
            }
        }
        catch (ExternalException error)
        {
            Emit(new DesktopEvent { Version = 1, Type = "error", Code = "windows_clipboard_capture_failed", Message = error.Message, Retryable = true });
        }
    }

    private void OnWindowClosed()
    {
        hotKeyWindow.Dispose();
        window.Dispose();
        ExitThread();
    }

    private void Emit(DesktopEvent value)
    {
        var json = JsonSerializer.Serialize(value, JsonOptions);
        lock (outputLock)
        {
            Console.Out.WriteLine(json);
            Console.Out.Flush();
        }
    }

    private static string? GetString(JsonElement root, string name)
        => root.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String ? property.GetString() : null;
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
