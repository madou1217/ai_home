using System.Windows;
using System.Windows.Threading;

namespace AihLumenClipboard;

/// <summary>
/// Standalone Windows native WPF entry point for Paste Lumen V7 (<c>aih-lumen.exe</c>,
/// or <c>aih-translation.exe --lumen | --clipboard | --orbit</c>).
/// Hosts the separate App Management Window (<see cref="ClipboardWorkspaceWindow"/>),
/// the separate non-activating Orbit Edge Rail (<see cref="QuickOrbitWindow"/>),
/// and the shared Quick Look Preview Window (<see cref="LumenPreviewWindow"/>)
/// on one shared reactive <see cref="LumenClipboardStore"/>.
/// </summary>
public static class LumenStandaloneEntry
{
    [STAThread]
    public static void Main(string[] args)
    {
        RunStandalone(args ?? Array.Empty<string>());
    }

    public static void RunStandalone(string[] args)
    {
        var openOrbitFirst = false;
        var previewPaths = new List<string>();
        var collectPreview = false;

        foreach (var raw in args)
        {
            var arg = (raw ?? string.Empty).Trim();
            if (string.IsNullOrEmpty(arg)) continue;
            if (arg.Equals("--orbit", StringComparison.OrdinalIgnoreCase))
            {
                openOrbitFirst = true;
                collectPreview = false;
                continue;
            }
            if (arg.Equals("--lumen", StringComparison.OrdinalIgnoreCase)
                || arg.Equals("--clipboard", StringComparison.OrdinalIgnoreCase))
            {
                collectPreview = false;
                continue;
            }
            if (arg.Equals("--preview", StringComparison.OrdinalIgnoreCase))
            {
                collectPreview = true;
                continue;
            }
            if (collectPreview && !arg.StartsWith("--", StringComparison.Ordinal))
            {
                previewPaths.Add(arg);
            }
        }

        LumenWpfHost.EnsureInitialized(winFormsHosted: false);
        var app = Application.Current!;
        app.ShutdownMode = ShutdownMode.OnExplicitShutdown;

        var config = LumenLocalConfigLoader.Resolve();
        if (config.IsValid)
        {
            LumenClipboardStore.Shared.Configure(config.Origin, config.ManagementKey);
        }

        var workspace = new ClipboardWorkspaceWindow();
        var orbit = new QuickOrbitWindow();
        var preview = LumenPreviewWindow.Shared;

        workspace.Configure(config.Origin, config.ManagementKey, enabled: true);
        orbit.Configure(config.Origin, config.ManagementKey, enabled: true, position: "bottom");

        workspace.OpenOrbitRequested += () => orbit.Toggle();
        orbit.OpenWorkspaceRequested += () => workspace.ShowWorkspace();
        workspace.QuickOrbitPositionChanged += nextPos =>
        {
            var latest = LumenLocalConfigLoader.Resolve(config.Origin, config.ManagementKey);
            orbit.Configure(latest.Origin, latest.ManagementKey, enabled: true, position: nextPos);
        };

        var shuttingDown = false;
        var launched = false;

        void ShutdownAll()
        {
            if (shuttingDown) return;
            shuttingDown = true;
            try { preview.Shutdown(); } catch { }
            try { orbit.Shutdown(); } catch { }
            try { workspace.Shutdown(); } catch { }
            try { LumenPreviewCache.Shared.ClearAll(); } catch { }
            try { LumenClipboardStore.Shared.Dispose(); } catch { }
            if (!app.Dispatcher.HasShutdownStarted)
            {
                app.Shutdown();
            }
        }

        void ScheduleExitCheck()
        {
            if (!launched || shuttingDown) return;
            _ = app.Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() =>
            {
                if (shuttingDown) return;
                if (!workspace.IsVisible && !orbit.IsOrbitVisible && !orbit.IsVisible && !preview.IsPreviewVisible)
                {
                    ShutdownAll();
                }
            }));
        }

        workspace.IsVisibleChanged += (_, _) =>
        {
            if (!workspace.IsVisible) ScheduleExitCheck();
        };
        orbit.IsVisibleChanged += (_, _) =>
        {
            if (!orbit.IsVisible) ScheduleExitCheck();
        };
        preview.IsVisibleChanged += (_, _) =>
        {
            if (!preview.IsVisible) ScheduleExitCheck();
        };

        app.Exit += (_, _) =>
        {
            if (!shuttingDown)
            {
                shuttingDown = true;
                try { preview.Shutdown(); } catch { }
                try { orbit.Shutdown(); } catch { }
                try { workspace.Shutdown(); } catch { }
                try { LumenPreviewCache.Shared.ClearAll(); } catch { }
                try { LumenClipboardStore.Shared.Dispose(); } catch { }
            }
        };

        app.Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(() =>
        {
            launched = true;
            if (previewPaths.Count > 0)
            {
                preview.PresentLocalFiles(previewPaths);
                if (!preview.IsPreviewVisible)
                {
                    workspace.ShowWorkspace();
                }
            }
            else if (openOrbitFirst)
            {
                if (orbit.IsAvailable)
                {
                    orbit.ShowOrbit();
                }
                else
                {
                    // Fall back to the App Management Window when server credentials are not configured yet.
                    workspace.ShowWorkspace();
                }
            }
            else
            {
                workspace.ShowWorkspace();
            }
        }));

        app.Run();
    }
}
