//go:build windows

package applaunch

import (
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"

	"github.com/madou1217/ai_home/application/launcher"
)

// resolveChromiumExecutable finds the real browser binary behind a Start Menu
// shortcut or shell:AppsFolder entry.
//
// shell:AppsFolder cannot forward Chromium arguments: `start` activates the
// registered app and drops `--proxy-server`/`--user-data-dir`. Launching the
// executable directly is the only way to make per-instance proxy flags work.
// Resolution order: App Paths registry (authoritative install location), then
// the standard vendor directories.
func resolveChromiumExecutable(app launcher.App) string {
	exeName := chromiumExeName(app)
	if exeName == "" {
		return ""
	}
	if path := appPathFromRegistry(exeName); path != "" {
		return path
	}
	for _, candidate := range standardChromiumPaths(exeName) {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}

func chromiumExeName(app launcher.App) string {
	haystack := strings.ToLower(app.Name + " " + app.Path + " " + strings.Join(app.Aliases, " "))
	switch {
	case strings.Contains(haystack, "msedge"), strings.Contains(haystack, "microsoft edge"):
		return "msedge.exe"
	case strings.Contains(haystack, "brave"):
		return "brave.exe"
	case strings.Contains(haystack, "vivaldi"):
		return "vivaldi.exe"
	case strings.Contains(haystack, "opera"):
		return "opera.exe"
	case strings.Contains(haystack, "chrome"), strings.Contains(haystack, "chromium"):
		return "chrome.exe"
	default:
		return ""
	}
}

func appPathFromRegistry(exeName string) string {
	subkey := `SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\` + exeName
	roots := []registry.Key{registry.CURRENT_USER, registry.LOCAL_MACHINE}
	views := []uint32{registry.WOW64_64KEY, registry.WOW64_32KEY}
	for _, root := range roots {
		for _, view := range views {
			key, err := registry.OpenKey(root, subkey, registry.QUERY_VALUE|view)
			if err != nil {
				continue
			}
			value, _, valueErr := key.GetStringValue("")
			_ = key.Close()
			value = strings.Trim(strings.TrimSpace(value), `"`)
			if valueErr == nil && value != "" {
				if info, statErr := os.Stat(value); statErr == nil && !info.IsDir() {
					return value
				}
			}
		}
	}
	return ""
}

func standardChromiumPaths(exeName string) []string {
	roots := make([]string, 0, 3)
	for _, envName := range []string{"ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"} {
		if value := strings.TrimSpace(os.Getenv(envName)); value != "" {
			roots = append(roots, value)
		}
	}
	relatives := []string{}
	switch exeName {
	case "chrome.exe":
		relatives = []string{
			`Google\Chrome\Application\chrome.exe`,
			`Google\Chrome Beta\Application\chrome.exe`,
			`Google\Chrome Dev\Application\chrome.exe`,
		}
	case "msedge.exe":
		relatives = []string{`Microsoft\Edge\Application\msedge.exe`}
	case "brave.exe":
		relatives = []string{`BraveSoftware\Brave-Browser\Application\brave.exe`}
	case "vivaldi.exe":
		relatives = []string{`Vivaldi\Application\vivaldi.exe`}
	case "opera.exe":
		relatives = []string{`Programs\Opera\opera.exe`, `Opera\opera.exe`}
	}
	candidates := make([]string, 0, len(roots)*len(relatives))
	for _, root := range roots {
		for _, relative := range relatives {
			candidates = append(candidates, filepath.Join(root, relative))
		}
	}
	return candidates
}
