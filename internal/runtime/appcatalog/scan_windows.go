//go:build windows

package appcatalog

import (
	"bytes"
	"context"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"

	"github.com/madou1217/ai_home/application/launcher"
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

func scanApps(ctx context.Context) ([]launcher.App, error) {
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
			name := base[:len(base)-len(filepath.Ext(base))]
			var modifiedAtMs int64
			if info, infoErr := d.Info(); infoErr == nil {
				modifiedAtMs = info.ModTime().UnixMilli()
			}
			seenName[strings.ToLower(strings.TrimSpace(name))] = struct{}{}
			apps = append(apps, launcher.App{
				ID:           launcher.AppID(windowsPlatformString, key),
				Name:         name,
				Subtitle:     cleanPath,
				Path:         cleanPath,
				Kind:         launcher.KindApp,
				Icon:         cleanPath,
				Terminal:     false,
				ModifiedAtMs: modifiedAtMs,
			})
			return nil
		})
	}

	apps = append(apps, scanWindowsShellApps(ctx, seenName)...)
	return apps, nil
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

// scanWindowsShellApps enumerates the Start menu through the Shell AppsFolder
// namespace, which returns desktop shortcuts and UWP/Store apps together.
//
// A temporary VBS executed by cscript is used instead of Get-StartApps: a child
// powershell.exe can stall under the desktop helper's scheduled-task context on
// some machines (observed 2026-11-26), which silently dropped every UWP entry.
// The Shell namespace enumerates reliably there and writes UTF-16LE itself, so
// no console code page or stdout encoding is involved.
func scanWindowsShellApps(ctx context.Context, existingNames map[string]struct{}) []launcher.App {
	dir, err := os.MkdirTemp("", "aih-startapps-")
	if err != nil {
		return nil
	}
	defer func() { _ = os.RemoveAll(dir) }()
	outPath := filepath.Join(dir, "apps.tsv")
	vbsPath := filepath.Join(dir, "enum.vbs")
	script := strings.ReplaceAll(windowsShellAppsVBS, "{{OUT}}", strings.ReplaceAll(outPath, `"`, `""`))
	if err := os.WriteFile(vbsPath, []byte(script), 0o600); err != nil {
		return nil
	}

	cctx, cancel := context.WithTimeout(ctx, windowsShellAppsTimeout)
	defer cancel()
	cscript := filepath.Join(strings.TrimSpace(os.Getenv("SystemRoot")), "System32", "cscript.exe")
	if _, statErr := os.Stat(cscript); statErr != nil {
		cscript = "cscript.exe"
	}
	cmd := exec.CommandContext(cctx, cscript, "//nologo", vbsPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	_ = cmd.Run()

	data, err := os.ReadFile(outPath)
	if err != nil || len(data) == 0 {
		return nil
	}
	text := decodeWindowsText(data)

	seenRow := make(map[string]struct{}, 256)
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
		normName := strings.ToLower(name)
		if _, dup := existingNames[normName]; dup {
			continue
		}
		if _, dup := seenRow[normName]; dup {
			continue
		}
		seenRow[normName] = struct{}{}

		if strings.ContainsAny(target, `:\`) {
			// Desktop app exposed by the Shell with a real executable path.
			var modifiedAtMs int64
			if info, statErr := os.Stat(target); statErr == nil {
				modifiedAtMs = info.ModTime().UnixMilli()
			}
			result = append(result, launcher.App{
				ID:           launcher.AppID(windowsPlatformString, "path:"+strings.ToLower(target)),
				Name:         name,
				Subtitle:     target,
				Path:         target,
				Kind:         launcher.KindApp,
				Icon:         target,
				ModifiedAtMs: modifiedAtMs,
			})
			continue
		}
		// UWP/Store app or AUMID entry: launch through the AppsFolder shell path.
		shellPath := `shell:AppsFolder\` + target
		result = append(result, launcher.App{
			ID:       launcher.AppID(windowsPlatformString, "uwp:"+strings.ToLower(target)),
			Name:     name,
			Subtitle: shellPath,
			Path:     shellPath,
			Kind:     launcher.KindUWP,
		})
	}
	return result
}

// decodeWindowsText converts the UTF-16LE output written by the VBS (with BOM)
// or UTF-8 data from a fallback tool into a Go string.
func decodeWindowsText(data []byte) string {
	if len(data) >= 2 && data[0] == 0xFF && data[1] == 0xFE {
		units := make([]uint16, 0, (len(data)-2)/2)
		for i := 2; i+1 < len(data); i += 2 {
			units = append(units, uint16(data[i])|uint16(data[i+1])<<8)
		}
		return string(utf16.Decode(units))
	}
	return string(bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF}))
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
