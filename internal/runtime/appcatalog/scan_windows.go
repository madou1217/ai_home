//go:build windows

package appcatalog

import (
	"bytes"
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/madou1217/ai_home/application/launcher"
)

const (
	windowsPlatformString = "windows"
	windowsUWPTimeout     = 8 * time.Second
)

func platformSupported() bool {
	return true
}

func scanApps(ctx context.Context) ([]launcher.App, error) {
	apps := make([]launcher.App, 0, 128)
	seenLnk := make(map[string]struct{}, 128)

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

	uwpApps := scanWindowsStartApps(ctx)
	apps = append(apps, uwpApps...)
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

type startAppRow struct {
	Name  string `json:"Name"`
	AppID string `json:"AppID"`
}

func scanWindowsStartApps(ctx context.Context) []launcher.App {
	psCtx, cancel := context.WithTimeout(ctx, windowsUWPTimeout)
	defer cancel()

	cmd := exec.CommandContext(
		psCtx,
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-WindowStyle", "Hidden",
		"-Command",
		"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-StartApps | ConvertTo-Json -Compress",
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		// Per §7: PowerShell UWP discovery fails silently without blocking Start Menu apps.
		return nil
	}
	trimmed := bytes.TrimSpace(bytes.TrimPrefix(out, []byte{0xef, 0xbb, 0xbf}))
	if len(trimmed) == 0 {
		return nil
	}

	var rows []startAppRow
	if trimmed[0] == '[' {
		if err := json.Unmarshal(trimmed, &rows); err != nil {
			return nil
		}
	} else {
		var single startAppRow
		if err := json.Unmarshal(trimmed, &single); err != nil {
			return nil
		}
		rows = []startAppRow{single}
	}

	seenAppID := make(map[string]struct{}, len(rows))
	result := make([]launcher.App, 0, len(rows))
	for _, row := range rows {
		name := strings.TrimSpace(row.Name)
		appID := strings.TrimSpace(row.AppID)
		if name == "" || appID == "" {
			continue
		}
		normID := strings.ToLower(appID)
		if _, dup := seenAppID[normID]; dup {
			continue
		}
		seenAppID[normID] = struct{}{}

		shellPath := `shell:AppsFolder\` + appID
		result = append(result, launcher.App{
			ID:           launcher.AppID(windowsPlatformString, normID),
			Name:         name,
			Subtitle:     shellPath,
			Path:         shellPath,
			Kind:         launcher.KindUWP,
			Icon:         "",
			Terminal:     false,
			ModifiedAtMs: 0,
		})
	}
	return result
}
