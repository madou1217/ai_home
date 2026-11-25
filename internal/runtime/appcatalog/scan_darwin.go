//go:build darwin

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
	darwinMaxDepth       = 3
	darwinMaxPlistBytes  = 1 << 20
	darwinPlatformString = "darwin"
)

func platformSupported() bool {
	return true
}

func scanApps(ctx context.Context) ([]launcher.App, error) {
	roots := darwinScanRoots()
	seenRealApp := make(map[string]struct{}, 128)
	visitedDirs := make(map[string]struct{}, 64)
	apps := make([]launcher.App, 0, 128)

	var walk func(dir string, depth int)
	walk = func(dir string, depth int) {
		if ctx.Err() != nil || depth > darwinMaxDepth {
			return
		}
		realDir, err := filepath.EvalSymlinks(dir)
		if err != nil || realDir == "" {
			realDir = filepath.Clean(dir)
		}
		if _, visited := visitedDirs[realDir]; visited {
			return
		}
		visitedDirs[realDir] = struct{}{}

		entries, err := os.ReadDir(dir)
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
			fullPath := filepath.Join(dir, name)
			isDir := entry.IsDir()
			if !isDir && entry.Type()&os.ModeSymlink != 0 {
				if info, statErr := os.Stat(fullPath); statErr == nil && info.IsDir() {
					isDir = true
				}
			}
			if !isDir {
				continue
			}
			if hasAppBundleSuffix(name) {
				realPath, symErr := filepath.EvalSymlinks(fullPath)
				if symErr != nil || realPath == "" {
					realPath = filepath.Clean(fullPath)
				}
				if _, dup := seenRealApp[realPath]; dup {
					continue
				}
				seenRealApp[realPath] = struct{}{}

				displayName := darwinBundleBaseName(name)
				meta := readDarwinAppPlist(fullPath)
				if meta.isBackgroundHelper() {
					continue
				}
				aliases := filterDarwinAppAliases(meta.Names, displayName)
				apps = append(apps, launcher.App{
					ID:       launcher.AppID(darwinPlatformString, realPath),
					Name:     displayName,
					Subtitle: fullPath,
					Path:     fullPath,
					Kind:     launcher.KindApp,
					Icon:     fullPath,
					Terminal: false,
					Aliases:  aliases,
				})
				// Never recurse inside a .app bundle.
				continue
			}
			if depth < darwinMaxDepth {
				walk(fullPath, depth+1)
			}
		}
	}

	for _, root := range roots {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		walk(root, 1)
	}
	return apps, nil
}

func darwinScanRoots() []string {
	roots := []string{
		"/Applications",
		"/System/Applications",
		"/System/Applications/Utilities",
	}
	if home, err := os.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
		roots = append(roots, filepath.Join(home, "Applications"))
	}
	return roots
}

func hasAppBundleSuffix(name string) bool {
	return len(name) > 4 && strings.EqualFold(name[len(name)-4:], ".app")
}

func darwinBundleBaseName(dirName string) string {
	if hasAppBundleSuffix(dirName) {
		return dirName[:len(dirName)-4]
	}
	return dirName
}

func readDarwinAppPlist(bundlePath string) infoPlistMeta {
	plistPath := filepath.Join(bundlePath, "Contents", "Info.plist")
	f, err := os.Open(plistPath)
	if err != nil {
		return infoPlistMeta{}
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(io.LimitReader(f, darwinMaxPlistBytes))
	if err != nil {
		return infoPlistMeta{}
	}
	return parseInfoPlist(data)
}

func filterDarwinAppAliases(raw []string, primaryName string) []string {
	if len(raw) == 0 {
		return nil
	}
	seen := map[string]struct{}{
		strings.ToLower(strings.TrimSpace(primaryName)): {},
	}
	aliases := make([]string, 0, min(len(raw), launcher.MaxAliases))
	for _, candidate := range raw {
		trimmed := strings.TrimSpace(candidate)
		if trimmed == "" {
			continue
		}
		key := strings.ToLower(trimmed)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		aliases = append(aliases, trimmed)
		if len(aliases) >= launcher.MaxAliases {
			break
		}
	}
	if len(aliases) == 0 {
		return nil
	}
	return aliases
}
