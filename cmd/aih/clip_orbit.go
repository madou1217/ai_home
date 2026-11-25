package main

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	defaultClipOrbitOrigin = "http://127.0.0.1:9527"
	clipOrbitQuickSize     = "1520,438"
	clipOrbitWorkspaceSize = "1440,900"
)

type clipOrbitOptions struct {
	workspace bool
	position  string
	printOnly bool
	browser   string
}

// runClipOrbit opens the Paste Nexus workspace or the Quick Orbit card on
// desktops that have no native helper (Windows/Linux) and as a secondary entry
// on macOS. A Chromium --app window keeps the HUD chrome minimal; when no
// Chromium is available it falls back to the system browser.
func runClipOrbit(args []string, cmdRuntime commandRuntime) error {
	options := clipOrbitOptions{position: "bottom"}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--workspace" || arg == "--full":
			options.workspace = true
		case arg == "--quick":
			options.workspace = false
		case arg == "--print":
			options.printOnly = true
		case arg == "--position" && i+1 < len(args):
			i++
			options.position = strings.ToLower(strings.TrimSpace(args[i]))
		case strings.HasPrefix(arg, "--position="):
			options.position = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(arg, "--position=")))
		case arg == "--browser" && i+1 < len(args):
			i++
			options.browser = strings.TrimSpace(args[i])
		case strings.HasPrefix(arg, "--browser="):
			options.browser = strings.TrimSpace(strings.TrimPrefix(arg, "--browser="))
		default:
			return fmt.Errorf("unknown flag for `aih clip orbit`: %s", arg)
		}
	}
	switch options.position {
	case "bottom", "left", "right":
	default:
		return fmt.Errorf("invalid --position: %s (want bottom|left|right)", options.position)
	}

	origin := clipOrbitOrigin(cmdRuntime)
	target, err := url.Parse(strings.TrimRight(origin, "/") + "/ui/paste/")
	if err != nil {
		return err
	}
	query := target.Query()
	if options.workspace {
		query.Set("mode", "workspace")
	} else {
		query.Set("mode", "quick")
		query.Set("embed", "browser")
		query.Set("position", options.position)
	}
	target.RawQuery = query.Encode()

	name, launchArgs := clipOrbitCommand(options, target.String())
	if options.printOnly {
		_, _ = fmt.Fprintln(cmdRuntime.stdout, name+" "+strings.Join(launchArgs, " "))
		return nil
	}
	cmd := exec.Command(name, launchArgs...)
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("打开 Paste Nexus 失败: %w", err)
	}
	return cmd.Process.Release()
}

func clipOrbitOrigin(cmdRuntime commandRuntime) string {
	if value, ok := cmdRuntime.lookupEnv("AIH_SERVER_BASE_URL"); ok {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return defaultClipOrbitOrigin
}

func clipOrbitCommand(options clipOrbitOptions, target string) (string, []string) {
	size := clipOrbitQuickSize
	position := "200,600"
	if options.workspace {
		size = clipOrbitWorkspaceSize
		position = "200,80"
	}
	if browser, ok := clipOrbitBrowser(options.browser); ok {
		return browser, []string{
			"--app=" + target,
			"--window-size=" + size,
			"--window-position=" + position,
			"--new-window",
		}
	}
	switch runtime.GOOS {
	case "darwin":
		return "/usr/bin/open", []string{target}
	case "windows":
		return "rundll32", []string{"url.dll,FileProtocolHandler", target}
	default:
		return "xdg-open", []string{target}
	}
}

func clipOrbitBrowser(explicit string) (string, bool) {
	if strings.TrimSpace(explicit) != "" {
		if _, err := os.Stat(explicit); err == nil {
			return explicit, true
		}
		if path, err := exec.LookPath(explicit); err == nil {
			return path, true
		}
		return explicit, true
	}
	for _, candidate := range clipOrbitBrowserCandidates() {
		if strings.ContainsRune(candidate, '/') || strings.ContainsRune(candidate, '\\') {
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				return candidate, true
			}
			continue
		}
		if path, err := exec.LookPath(candidate); err == nil {
			return path, true
		}
	}
	return "", false
}

func clipOrbitBrowserCandidates() []string {
	switch runtime.GOOS {
	case "darwin":
		return []string{
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		}
	case "windows":
		localAppData := os.Getenv("LOCALAPPDATA")
		programFiles := os.Getenv("ProgramFiles")
		programFilesX86 := os.Getenv("ProgramFiles(x86)")
		return []string{
			filepath.Join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
			filepath.Join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
			filepath.Join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
			filepath.Join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
			"msedge.exe", "chrome.exe",
		}
	default:
		return []string{
			"microsoft-edge", "microsoft-edge-stable",
			"google-chrome", "google-chrome-stable",
			"chromium", "chromium-browser", "brave-browser",
		}
	}
}

// runClipShortcut installs (or prints) a desktop launcher for `clip orbit`.
// Windows gets a Start Menu shortcut with Ctrl+Alt+V; Linux gets a .desktop
// entry to bind in the desktop environment; macOS already has the native panel.
func runClipShortcut(args []string, cmdRuntime commandRuntime) error {
	action := "print"
	for _, arg := range args {
		switch arg {
		case "install":
			action = "install"
		case "print":
			action = "print"
		default:
			return fmt.Errorf("unknown argument for `aih clip shortcut`: %s", arg)
		}
	}
	executable, err := os.Executable()
	if err != nil {
		executable = "aih"
	}
	home, _ := cmdRuntime.userHomeDir()
	switch runtime.GOOS {
	case "darwin":
		_, _ = fmt.Fprintln(cmdRuntime.stdout, "macOS 已内置原生 ⌘⌥V Quick Orbit；无需安装桌面快捷方式。")
		return nil
	case "windows":
		link := filepath.Join(home, "Desktop", "AIH Quick Orbit.lnk")
		script := fmt.Sprintf(`$W=New-Object -ComObject WScript.Shell; $S=$W.CreateShortcut('%s'); $S.TargetPath='%s'; $S.Arguments='clip orbit'; $S.WorkingDirectory='%s'; $S.Hotkey='CTRL+ALT+V'; $S.WindowStyle=7; $S.Save()`,
			strings.ReplaceAll(link, "'", "''"),
			strings.ReplaceAll(executable, "'", "''"),
			strings.ReplaceAll(filepath.Dir(executable), "'", "''"))
		if action == "print" {
			_, _ = fmt.Fprintln(cmdRuntime.stdout, "powershell -NoProfile -Command \""+script+"\"")
			_, _ = fmt.Fprintln(cmdRuntime.stdout, "目标:", link, "快捷键: Ctrl+Alt+V")
			return nil
		}
		cmd := exec.Command("powershell", "-NoProfile", "-Command", script)
		cmd.Stdout = cmdRuntime.stdout
		cmd.Stderr = cmdRuntime.stderr
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("安装 Windows 快捷方式失败: %w", err)
		}
		_, _ = fmt.Fprintln(cmdRuntime.stdout, "已安装:", link, "快捷键 Ctrl+Alt+V")
		return nil
	default:
		entry := filepath.Join(home, ".local", "share", "applications", "aih-clip-orbit.desktop")
		content := strings.Join([]string{
			"[Desktop Entry]",
			"Type=Application",
			"Name=AIH Quick Orbit",
			"Comment=Paste Nexus clipboard overlay",
			"Exec=\"" + executable + "\" clip orbit",
			"Terminal=false",
			"Categories=Utility;",
			"",
		}, "\n")
		if action == "print" {
			_, _ = fmt.Fprintln(cmdRuntime.stdout, "写入:", entry)
			_, _ = fmt.Fprint(cmdRuntime.stdout, content)
			_, _ = fmt.Fprintln(cmdRuntime.stdout, "然后在桌面环境的键盘设置里把快捷键绑到该启动器（建议 Ctrl+Alt+V）。")
			return nil
		}
		if err := os.MkdirAll(filepath.Dir(entry), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(entry, []byte(content), 0o644); err != nil {
			return err
		}
		_, _ = fmt.Fprintln(cmdRuntime.stdout, "已写入:", entry)
		_, _ = fmt.Fprintln(cmdRuntime.stdout, "请在 GNOME/KDE 快捷键设置中绑定 Ctrl+Alt+V 到 “AIH Quick Orbit”。")
		return nil
	}
}
