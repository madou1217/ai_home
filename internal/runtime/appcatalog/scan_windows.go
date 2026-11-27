//go:build windows

package appcatalog

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/launcher"
	"github.com/madou1217/ai_home/internal/runtime/winshell"
)

const (
	windowsPlatformString = "windows"
	// windowsShellAppsTimeout bounds the Shell AppsFolder enumeration. The Shell
	// namespace can take a few seconds on machines with hundreds of Start entries.
	windowsShellAppsTimeout = 25 * time.Second
)

func platformSupported() bool {
	return true
}

// scanApps prefers the Shell AppsFolder namespace, which is the Start menu's
// authoritative list: it returns desktop shortcuts and UWP/Store apps together,
// with no cross-source duplicates. The .lnk walk remains as a fallback for
// machines where the Shell enumeration is unavailable.
func scanApps(ctx context.Context) ([]launcher.App, error) {
	if shellApps := scanWindowsShellApps(ctx); len(shellApps) > 0 {
		return shellApps, nil
	}
	return scanWindowsShortcutApps(ctx)
}

// scanWindowsShortcutApps walks the per-user and machine Start Menu shortcuts.
// It is only used when the Shell AppsFolder enumeration returns nothing.
func scanWindowsShortcutApps(ctx context.Context) ([]launcher.App, error) {
	apps := make([]launcher.App, 0, 256)
	seenLnk := make(map[string]struct{}, 256)
	seenName := make(map[string]struct{}, 256)

	for _, root := range windowsStartMenuRoots() {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if strings.EqualFold(d.Name(), "Startup") {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.EqualFold(filepath.Ext(d.Name()), ".lnk") {
				return nil
			}
			cleanPath := filepath.Clean(path)
			key := strings.ToLower(cleanPath)
			if _, dup := seenLnk[key]; dup {
				return nil
			}
			seenLnk[key] = struct{}{}

			base := d.Name()
			name := strings.TrimSpace(base[:len(base)-len(filepath.Ext(base))])
			if name == "" {
				return nil
			}
			if windowsUninstallEntry(name, cleanPath) {
				return nil
			}
			normName := strings.ToLower(name)
			if _, dup := seenName[normName]; dup {
				return nil
			}
			seenName[normName] = struct{}{}
			var modifiedAtMs int64
			if info, infoErr := d.Info(); infoErr == nil {
				modifiedAtMs = info.ModTime().UnixMilli()
			}
			apps = append(apps, launcher.App{
				ID:           launcher.AppID(windowsPlatformString, key),
				Name:         name,
				Subtitle:     cleanPath,
				Path:         cleanPath,
				Kind:         launcher.KindApp,
				Icon:         cleanPath,
				Aliases:      windowsSearchAliases(name, cleanPath),
				ModifiedAtMs: modifiedAtMs,
			})
			return nil
		})
	}
	return apps, nil
}

// windowsUninstallEntry reports whether a Start menu item is an uninstall
// shortcut (name "卸载…"/"Uninstall…" or an unins*.exe/uninstall.exe target).
func windowsUninstallEntry(name, target string) bool {
	trimmedName := strings.ToLower(strings.TrimSpace(name))
	for _, prefix := range []string{"uninstall", "unins", "卸载"} {
		if strings.HasPrefix(trimmedName, prefix) {
			return true
		}
	}

	stem := strings.ToLower(strings.TrimSpace(target))
	stem = strings.TrimPrefix(stem, `shell:AppsFolder\`)
	if idx := strings.LastIndexAny(stem, `\/`); idx >= 0 {
		stem = stem[idx+1:]
	}
	if idx := strings.LastIndex(stem, "."); idx > 0 {
		stem = stem[:idx]
	}
	return strings.HasPrefix(stem, "unins") || stem == "uninstall" || stem == "uninstaller"
}

func windowsStartMenuRoots() []string {
	var roots []string
	if programData := strings.TrimSpace(os.Getenv("ProgramData")); programData != "" {
		roots = append(roots, filepath.Join(programData, "Microsoft", "Windows", "Start Menu", "Programs"))
	}
	if appData := strings.TrimSpace(os.Getenv("APPDATA")); appData != "" {
		roots = append(roots, filepath.Join(appData, "Microsoft", "Windows", "Start Menu", "Programs"))
	}
	return roots
}

// scanWindowsShellApps enumerates shell:AppsFolder, the same namespace the Start
// menu renders (desktop shortcuts + UWP/Store apps), with duplicate names and
// duplicate executable targets removed.
//
// A temporary VBS executed by cscript is used instead of Get-StartApps: a child
// powershell.exe can stall under the desktop helper's scheduled-task context on
// some machines (observed 2026-11-26), which silently dropped every UWP entry.
// The Shell namespace enumerates reliably there and writes UTF-16LE itself, so
// no console code page or stdout encoding is involved.
func scanWindowsShellApps(ctx context.Context) []launcher.App {
	text, err := winshell.RunVBSReadText(ctx, windowsShellAppsVBS, windowsShellAppsTimeout)
	if err != nil || text == "" {
		return nil
	}

	seenName := make(map[string]struct{}, 256)
	seenTarget := make(map[string]struct{}, 256)
	result := make([]launcher.App, 0, 256)
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) != 2 {
			continue
		}
		name := strings.TrimSpace(parts[0])
		target := strings.TrimSpace(parts[1])
		if name == "" || target == "" {
			continue
		}
		// The Start menu also lists uninstall shortcuts; a launcher must not
		// offer them as apps (they also pollute alias matching, e.g. an
		// uninstaller inheriting WeChat's aliases from Weixin.exe).
		if windowsUninstallEntry(name, target) {
			continue
		}
		normName := strings.ToLower(name)
		if _, dup := seenName[normName]; dup {
			continue
		}

		app := launcher.App{Name: name}
		if strings.ContainsAny(target, `:\`) {
			// Desktop app exposed by the Shell with a real executable path.
			normTarget := strings.ToLower(filepath.Clean(target))
			if _, dup := seenTarget[normTarget]; dup {
				continue
			}
			seenTarget[normTarget] = struct{}{}
			var modifiedAtMs int64
			if info, statErr := os.Stat(target); statErr == nil {
				modifiedAtMs = info.ModTime().UnixMilli()
			}
			app.ID = launcher.AppID(windowsPlatformString, "path:"+normTarget)
			app.Subtitle = target
			app.Path = target
			app.Kind = launcher.KindApp
			app.Icon = target
			app.ModifiedAtMs = modifiedAtMs
		} else {
			// UWP/Store app or AUMID entry: launch through the AppsFolder shell path.
			normTarget := strings.ToLower(target)
			if _, dup := seenTarget[normTarget]; dup {
				continue
			}
			seenTarget[normTarget] = struct{}{}
			app.ID = launcher.AppID(windowsPlatformString, "uwp:"+normTarget)
			app.Path = `shell:AppsFolder\` + target
			app.Subtitle = app.Path
			app.Kind = launcher.KindUWP
		}
		seenName[normName] = struct{}{}
		app.Aliases = windowsSearchAliases(name, target)
		result = append(result, app)
	}
	return result
}

const windowsShellAppsVBS = `Set fso = CreateObject("Scripting.FileSystemObject")
Set out = fso.CreateTextFile("{{OUT}}", True, True)
On Error Resume Next
Set shell = CreateObject("Shell.Application")
If Err.Number <> 0 Then
  out.Close
  WScript.Quit 1
End If
Set folder = shell.NameSpace("shell:AppsFolder")
If Err.Number <> 0 Or folder Is Nothing Then
  out.Close
  WScript.Quit 1
End If
For Each item In folder.Items
  name = item.Name
  path = item.Path
  If Len(name) > 0 And Len(path) > 0 Then
    out.WriteLine name & vbTab & path
  End If
Next
out.Close
`
