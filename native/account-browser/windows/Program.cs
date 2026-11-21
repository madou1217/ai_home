using System.Drawing;
using System.Diagnostics;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;

internal static class Program
{
    private const string BrowserError = "browser_window_unavailable";
    private static readonly object OutputGate = new();
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Contains("--preflight", StringComparer.OrdinalIgnoreCase))
        {
            // Windows does not expose the macOS permission APIs used by the
            // Darwin helper. Report capability only; Start still verifies the
            // supervisor-owned signed Edge PID and visible window.
            Emit(new { type = "preflight", screenCapture = true, eventPosting = true });
            return 0;
        }
        if (args.Length != 1 || !int.TryParse(args[0], out var pid) || pid <= 1)
        {
            Emit(new { type = "error", error = "browser_identity_unavailable" });
            return 2;
        }
        if (!IsStableEdgeProcess(pid))
        {
            Emit(new { type = "error", error = "browser_identity_unavailable" });
            return 4;
        }
        var hwnd = FindWindow(pid, TimeSpan.FromSeconds(8));
        if (hwnd == IntPtr.Zero)
        {
            Emit(new { type = "error", error = BrowserError });
            return 3;
        }

        using var stop = new CancellationTokenSource();
        var capture = new CaptureLoop(hwnd, stop.Token);
        var captureTask = Task.Run(() => capture.RunAsync());
        Emit(new { type = "ready", width = capture.Width, height = capture.Height });

        try
        {
            string? line;
            while ((line = Console.ReadLine()) is not null)
            {
                if (line.Length > 16_384) break;
                Command? command;
                try { command = JsonSerializer.Deserialize<Command>(line, JsonOptions); }
                catch (JsonException) { break; }
                if (command is null) break;
                if (command.Type == "close") break;
                if (!capture.Apply(command)) break;
            }
        }
        finally
        {
            stop.Cancel();
            capture.Stop();
            try { captureTask.Wait(TimeSpan.FromSeconds(2)); } catch { }
        }
        return 0;
    }

    private static void Emit(object value)
    {
        var json = JsonSerializer.Serialize(value, JsonOptions);
        lock (OutputGate)
        {
            Console.WriteLine(json);
            Console.Out.Flush();
        }
    }

    private static bool IsStableEdgeProcess(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            var image = process.MainModule?.FileName?.Replace('/', '\\');
            return !string.IsNullOrWhiteSpace(image)
                && image.EndsWith("\\Microsoft\\Edge\\Application\\msedge.exe", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static IntPtr FindWindow(int pid, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            IntPtr found = IntPtr.Zero;
            Native.EnumWindows((hwnd, _) =>
            {
                Native.GetWindowThreadProcessId(hwnd, out var owner);
                if (owner == (uint)pid && Native.IsWindowVisible(hwnd) && Native.GetWindowRect(hwnd, out var rect)
                    && rect.Width >= 700 && rect.Height >= 400)
                {
                    found = hwnd;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            if (found != IntPtr.Zero) return found;
            Thread.Sleep(100);
        }
        return IntPtr.Zero;
    }

    private sealed class CaptureLoop
    {
        private readonly IntPtr hwnd;
        private readonly CancellationToken token;
        private long frame;
        private Task? task;
        private int lastPointerX;
        private int lastPointerY;
        private volatile bool stopped;
        public int Width { get; private set; } = 1200;
        public int Height { get; private set; } = 900;

        public CaptureLoop(IntPtr hwnd, CancellationToken token)
        {
            this.hwnd = hwnd;
            this.token = token;
        }

        public Task RunAsync()
        {
            task = Task.Run(async () =>
            {
                while (!token.IsCancellationRequested && !stopped)
                {
                    try
                    {
                        if (!Native.IsWindow(hwnd) || !Native.GetWindowRect(hwnd, out var rect))
                        {
                            Emit(new { type = "error", error = BrowserError });
                            return;
                        }
                        using var bitmap = Capture(rect);
                        if (bitmap is not null)
                        {
                            var data = Encode(bitmap);
                            Interlocked.Increment(ref frame);
                            Emit(new { type = "frame", frame, data, width = bitmap.Width, height = bitmap.Height });
                        }
                    }
                    catch
                    {
                        Emit(new { type = "error", error = "browser_capture_unavailable" });
                        return;
                    }
                    await Task.Delay(125, token).ConfigureAwait(false);
                }
            }, token);
            return task;
        }

        private Bitmap? Capture(Native.RECT rect)
        {
            var width = Math.Clamp(rect.Width, 1, 4096);
            var height = Math.Clamp(rect.Height, 1, 4096);
            Width = width;
            Height = height;
            var bitmap = new Bitmap(width, height, PixelFormat.Format32bppPArgb);
            using var graphics = Graphics.FromImage(bitmap);
            var hdc = graphics.GetHdc();
            try
            {
                // Do not fall back to CopyFromScreen: when the window is occluded
                // that would capture unrelated desktop content. A failed native
                // window capture is a hard error, not a reason to leak the desktop.
                if (!Native.PrintWindow(hwnd, hdc, 2))
                {
                    throw new InvalidOperationException("PrintWindow failed");
                }
            }
            finally { graphics.ReleaseHdc(hdc); }
            return bitmap;
        }

        private static string Encode(Bitmap bitmap)
        {
            using var stream = new MemoryStream();
            bitmap.Save(stream, ImageFormat.Jpeg);
            return Convert.ToBase64String(stream.ToArray());
        }

        public bool Apply(Command command)
        {
            if (stopped || !Native.IsWindow(hwnd)) return false;
            try
            {
                if (!Native.SetForegroundWindow(hwnd) || Native.GetForegroundWindow() != hwnd)
                {
                    throw new InvalidOperationException("browser window is not foreground");
                }
                switch (command.Type)
                {
                    case "navigate":
                        Native.KeyChord(hwnd, Native.VK_L, Native.MOD_CONTROL);
                        Native.UnicodeText(command.Url ?? string.Empty);
                        Native.KeyPress(hwnd, Native.VK_RETURN);
                        return true;
                    case "text":
                        Native.UnicodeText(command.Text ?? string.Empty);
                        return true;
                    case "key":
                        return ApplyKey(command.Key ?? string.Empty);
                    case "pointer":
                        return ApplyPointer(command);
                    case "scroll":
                        if (lastPointerX == 0 && lastPointerY == 0 && Native.GetWindowRect(hwnd, out var scrollRect))
                        {
                            lastPointerX = scrollRect.Left + scrollRect.Width / 2;
                            lastPointerY = scrollRect.Top + scrollRect.Height / 2;
                        }
                        Native.SetCursorPos(lastPointerX, lastPointerY);
                        Native.Scroll(hwnd, (int)Math.Clamp(command.DeltaY, -2000, 2000));
                        return true;
                    default:
                        return false;
                }
            }
            catch
            {
                Emit(new { type = "error", error = "browser_input_unavailable" });
                return false;
            }
        }

        private static bool ApplyKey(string key)
        {
            var vk = key switch
            {
                "Enter" => Native.VK_RETURN,
                "Tab" => Native.VK_TAB,
                "Backspace" => Native.VK_BACK,
                "Delete" => Native.VK_DELETE,
                "Escape" => Native.VK_ESCAPE,
                "ArrowLeft" => Native.VK_LEFT,
                "ArrowRight" => Native.VK_RIGHT,
                "ArrowUp" => Native.VK_UP,
                "ArrowDown" => Native.VK_DOWN,
                "Home" => Native.VK_HOME,
                "End" => Native.VK_END,
                "PageUp" => Native.VK_PRIOR,
                "PageDown" => Native.VK_NEXT,
                "back" => Native.VK_LEFT,
                "forward" => Native.VK_RIGHT,
                "reload" => Native.VK_F5,
                _ => 0
            };
            if (vk == 0) return false;
            if (key is "back" or "forward") Native.KeyChord(IntPtr.Zero, vk, Native.MOD_ALT);
            else Native.KeyPress(IntPtr.Zero, vk);
            return true;
        }

        private bool ApplyPointer(Command command)
        {
            if (!Native.GetWindowRect(hwnd, out var rect)) return false;
            var x = rect.Left + (int)Math.Round(Math.Clamp(command.X, 0, 1) * rect.Width);
            var y = rect.Top + (int)Math.Round(Math.Clamp(command.Y, 0, 1) * rect.Height);
            lastPointerX = x;
            lastPointerY = y;
            Native.Click(x, y, command.Button == 2);
            return true;
        }

        public void Stop() => stopped = true;
    }

    private sealed class Command
    {
        public string Type { get; set; } = string.Empty;
        public string? Url { get; set; }
        public string? Text { get; set; }
        public string? Key { get; set; }
        public double X { get; set; }
        public double Y { get; set; }
        public double DeltaY { get; set; }
        public int Button { get; set; }
    }

    private static class Native
    {
        public const int VK_L = 0x4C, VK_RETURN = 0x0D, VK_TAB = 0x09, VK_BACK = 0x08, VK_DELETE = 0x2E;
        public const int VK_ESCAPE = 0x1B, VK_LEFT = 0x25, VK_RIGHT = 0x27, VK_UP = 0x26, VK_DOWN = 0x28;
        public const int VK_HOME = 0x24, VK_END = 0x23, VK_PRIOR = 0x21, VK_NEXT = 0x22, VK_F5 = 0x74;
        public const uint MOD_ALT = 0x0001, MOD_CONTROL = 0x0002;

        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; public int Width => Right - Left; public int Height => Bottom - Top; }
        [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint Type; public InputUnion Data; }
        [StructLayout(LayoutKind.Explicit)] private struct InputUnion { [FieldOffset(0)] public KEYBDINPUT Keyboard; [FieldOffset(0)] public MOUSEINPUT Mouse; }
        [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT { public ushort Vk, Scan; public uint Flags, Time; public IntPtr ExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT { public int Dx, Dy; public uint MouseData, Flags, Time; public IntPtr ExtraInfo; }
        private const uint INPUT_KEYBOARD = 1, INPUT_MOUSE = 0, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
        private const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004, MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010, MOUSEEVENTF_WHEEL = 0x0800;

        public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extra);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] private static extern uint SendInput(uint count, INPUT[] inputs, int size);

        public static void KeyPress(IntPtr _, int vk) => SendKeys(new[] { Key(vk, 0), Key(vk, KEYEVENTF_KEYUP) });
        public static void KeyChord(IntPtr _, int vk, uint modifier)
        {
            var modVk = modifier == MOD_CONTROL ? 0x11 : 0x12;
            SendKeys(new[] { Key(modVk, 0), Key(vk, 0), Key(vk, KEYEVENTF_KEYUP), Key(modVk, KEYEVENTF_KEYUP) });
        }
        private static INPUT Key(int vk, uint flags) => new() { Type = INPUT_KEYBOARD, Data = new InputUnion { Keyboard = new KEYBDINPUT { Vk = (ushort)vk, Flags = flags } } };
        public static void UnicodeText(string text)
        {
            var list = new List<INPUT>(text.Length * 2);
            foreach (var code in text.EnumerateRunes())
            {
                var value = code.Value <= 0xFFFF ? new[] { (ushort)code.Value } : char.ConvertFromUtf32(code.Value).Select(c => (ushort)c).ToArray();
                foreach (var unit in value) { list.Add(new INPUT { Type = INPUT_KEYBOARD, Data = new InputUnion { Keyboard = new KEYBDINPUT { Scan = unit, Flags = KEYEVENTF_UNICODE } } }); list.Add(new INPUT { Type = INPUT_KEYBOARD, Data = new InputUnion { Keyboard = new KEYBDINPUT { Scan = unit, Flags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } } }); }
            }
            SendKeys(list.ToArray());
        }
        private static void SendKeys(INPUT[] inputs) { if (inputs.Length > 0 && SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>()) != inputs.Length) throw new InvalidOperationException("SendInput failed"); }
        public static void Click(int x, int y, bool right) { SetCursorPos(x, y); var down = right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN; var up = right ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP; SendMouse(down); SendMouse(up); }
        public static void Scroll(IntPtr _, int delta) { var input = new INPUT { Type = INPUT_MOUSE, Data = new InputUnion { Mouse = new MOUSEINPUT { MouseData = (uint)delta, Flags = MOUSEEVENTF_WHEEL } } }; if (SendInput(1, new[] { input }, Marshal.SizeOf<INPUT>()) != 1) throw new InvalidOperationException("SendInput failed"); }
        private static void SendMouse(uint flags) { var input = new INPUT { Type = INPUT_MOUSE, Data = new InputUnion { Mouse = new MOUSEINPUT { Flags = flags } } }; if (SendInput(1, new[] { input }, Marshal.SizeOf<INPUT>()) != 1) throw new InvalidOperationException("SendInput failed"); }
    }
}
