package main

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	defaultClipOrbitOrigin = "http://127.0.0.1:9527"
	clipOrbitQuickSize     = "1520,472"
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
	release, locked := acquireOrbitLaunchLock(cmdRuntime)
	if locked {
		defer release()
	} else {
		_ = activateExistingOrbitWindow(cmdRuntime)
		return nil
	}
	if activateExistingOrbitWindow(cmdRuntime) {
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
	} else if options.position == "left" || options.position == "right" {
		size = "460,780"
		if options.position == "right" {
			x := clipOrbitScreenWidth() - 500
			if x < 20 {
				x = 20
			}
			position = fmt.Sprintf("%d,110", x)
		} else {
			position = "40,110"
		}
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

func clipOrbitScreenWidth() int {
	if runtime.GOOS != "windows" {
		return 1920
	}
	out, err := exec.Command("powershell", "-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width").Output()
	if err != nil {
		return 1920
	}
	width, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || width < 640 {
		return 1920
	}
	return width
}

// acquireOrbitLaunchLock prevents a burst of clip orbit invocations from opening
// several app windows. The lock is released immediately after launch; a stale
// lock older than 15 seconds is ignored.
func acquireOrbitLaunchLock(cmdRuntime commandRuntime) (func(), bool) {
	home, err := resolveAIHomeDir(cmdRuntime)
	if err != nil {
		return func() {}, true
	}
	dir := filepath.Join(home, "run")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return func() {}, true
	}
	lockPath := filepath.Join(dir, "clip-orbit.lock")
	for attempt := 0; attempt < 2; attempt++ {
		file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_, _ = fmt.Fprintf(file, "%d %d", os.Getpid(), time.Now().Unix())
			_ = file.Close()
			return func() { _ = os.Remove(lockPath) }, true
		}
		if info, statErr := os.Stat(lockPath); statErr == nil && time.Since(info.ModTime()) < 15*time.Second {
			return func() {}, false
		}
		_ = os.Remove(lockPath)
	}
	return func() {}, true
}

// activateExistingOrbitWindow brings an already-open HUD app window to the
// front instead of opening another one.
func activateExistingOrbitWindow(cmdRuntime commandRuntime) bool {
	switch runtime.GOOS {
	case "windows":
		command := `$w=New-Object -ComObject WScript.Shell; if($w.AppActivate('Paste // Nexus')){exit 0}; exit 1`
		return exec.Command("powershell", "-NoProfile", "-Command", command).Run() == nil
	case "darwin":
		script := `tell application "System Events" to tell process "Microsoft Edge" to get name of every window`
		out, err := exec.Command("osascript", "-e", script).Output()
		if err != nil || !strings.Contains(string(out), "Paste // Nexus") {
			return false
		}
		_ = exec.Command("osascript", "-e", `tell application "Microsoft Edge" to activate`).Run()
		return true
	default:
		path, err := exec.LookPath("wmctrl")
		if err != nil {
			return false
		}
		return exec.Command(path, "-a", "Paste // Nexus").Run() == nil
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
