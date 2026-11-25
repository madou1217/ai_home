//go:build linux

package appcatalog

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/application/launcher"
)

const (
	linuxPlatformString  = "linux"
	linuxMaxDesktopBytes = 256 * 1024
)

type linuxAppDir struct {
	path string
	kind launcher.Kind
}

func platformSupported() bool {
	return true
}

func scanApps(ctx context.Context) ([]launcher.App, error) {
	dirs := linuxApplicationDirs()
	seenDesktopID := make(map[string]struct{}, 128)
	apps := make([]launcher.App, 0, 128)

	for _, dir := range dirs {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		scanLinuxDir(ctx, dir, seenDesktopID, &apps)
	}
	return apps, nil
}

func linuxApplicationDirs() []linuxAppDir {
	home, _ := os.UserHomeDir()
	candidates := make([]linuxAppDir, 0, 8)

	if xdgHome := strings.TrimSpace(os.Getenv("XDG_DATA_HOME")); xdgHome != "" {
		candidates = append(candidates, linuxAppDir{
			path: filepath.Join(xdgHome, "applications"),
			kind: launcher.KindDesktop,
		})
	} else if home != "" {
		candidates = append(candidates, linuxAppDir{
			path: filepath.Join(home, ".local", "share", "applications"),
			kind: launcher.KindDesktop,
		})
	}

	xdgDirs := strings.TrimSpace(os.Getenv("XDG_DATA_DIRS"))
	if xdgDirs == "" {
		xdgDirs = "/usr/local/share:/usr/share"
	}
	for _, raw := range strings.Split(xdgDirs, ":") {
		base := strings.TrimSpace(raw)
		if base == "" {
			continue
		}
		appDir := filepath.Join(base, "applications")
		candidates = append(candidates, linuxAppDir{
			path: appDir,
			kind: inferLinuxDirKind(appDir),
		})
	}

	if home != "" {
		candidates = append(candidates, linuxAppDir{
			path: filepath.Join(home, ".local", "share", "flatpak", "exports", "share", "applications"),
			kind: launcher.KindFlatpak,
		})
	}
	candidates = append(candidates,
		linuxAppDir{
			path: "/var/lib/flatpak/exports/share/applications",
			kind: launcher.KindFlatpak,
		},
		linuxAppDir{
			path: "/var/lib/snapd/desktop/applications",
			kind: launcher.KindSnap,
		},
	)

	seenDir := make(map[string]struct{}, len(candidates))
	out := make([]linuxAppDir, 0, len(candidates))
	for _, cand := range candidates {
		clean := filepath.Clean(cand.path)
		if _, dup := seenDir[clean]; dup {
			continue
		}
		seenDir[clean] = struct{}{}
		cand.path = clean
		out = append(out, cand)
	}
	return out
}

func inferLinuxDirKind(dir string) launcher.Kind {
	lower := strings.ToLower(dir)
	switch {
	case strings.Contains(lower, "flatpak"):
		return launcher.KindFlatpak
	case strings.Contains(lower, "snapd"):
		return launcher.KindSnap
	default:
		return launcher.KindDesktop
	}
}

func scanLinuxDir(ctx context.Context, root linuxAppDir, seenDesktopID map[string]struct{}, apps *[]launcher.App) {
	entries, err := os.ReadDir(root.path)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if ctx.Err() != nil {
			return
		}
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		fullPath := filepath.Join(root.path, name)
		isDir := entry.IsDir()
		if !isDir && entry.Type()&os.ModeSymlink != 0 {
			if info, statErr := os.Stat(fullPath); statErr == nil && info.IsDir() {
				isDir = true
			}
		}
		if isDir {
			// Recurse one level deep into subdirectories per §7.
			subEntries, subErr := os.ReadDir(fullPath)
			if subErr != nil {
				continue
			}
			for _, sub := range subEntries {
				if ctx.Err() != nil {
					return
				}
				subName := sub.Name()
				if strings.HasPrefix(subName, ".") || !strings.HasSuffix(subName, ".desktop") {
					continue
				}
				subPath := filepath.Join(fullPath, subName)
				desktopID := name + "-" + subName
				maybeCollectDesktopFile(subPath, desktopID, root.kind, seenDesktopID, apps)
			}
			continue
		}
		if !strings.HasSuffix(name, ".desktop") {
			continue
		}
		maybeCollectDesktopFile(fullPath, name, root.kind, seenDesktopID, apps)
	}
}

func maybeCollectDesktopFile(
	fullPath string,
	desktopID string,
	kind launcher.Kind,
	seenDesktopID map[string]struct{},
	apps *[]launcher.App,
) {
	if _, dup := seenDesktopID[desktopID]; dup {
		return
	}
	info, err := os.Stat(fullPath)
	if err != nil || info.IsDir() {
		return
	}
	f, err := os.Open(fullPath)
	if err != nil {
		return
	}
	data, err := io.ReadAll(io.LimitReader(f, linuxMaxDesktopBytes))
	_ = f.Close()
	if err != nil {
		return
	}

	entry, ok := parseDesktopEntry(data)
	if !ok {
		return
	}
	// Mark higher-priority Desktop IDs as seen even when hidden/NoDisplay so they mask system entries.
	seenDesktopID[desktopID] = struct{}{}
	if entry.Type != "Application" || entry.Hidden || entry.NoDisplay {
		return
	}

	fallbackName := strings.TrimSuffix(filepath.Base(fullPath), ".desktop")
	displayName := entry.displayName(fallbackName)
	if displayName == "" {
		return
	}

	*apps = append(*apps, launcher.App{
		ID:        launcher.AppID(linuxPlatformString, desktopID),
		Name:      displayName,
		Subtitle:  entry.subtitle(fullPath),
		Path:      fullPath,
		Kind:      kind,
		Icon:      entry.Icon,
		Terminal:  entry.Terminal,
		DesktopID: desktopID,
		Exec:      entry.Exec,
	})
}
