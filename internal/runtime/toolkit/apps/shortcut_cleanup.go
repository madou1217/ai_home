package apps

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/winshell"
)

// ShortcutMatchResult partitions enumerated shortcuts into matched residue and
// unmatched broken shortcuts (reported for visibility, never deleted).
type ShortcutMatchResult struct {
	Matched    []winshell.Shortcut
	KeptBroken []winshell.Shortcut
}

// MatchShortcutResidue evaluates enumerated Windows shortcuts against provider
// residue criteria without performing any filesystem I/O.
//
// A shortcut is selected for removal only if it is a .lnk file AND satisfies:
//
//	(a) TargetPath is located under any InstallRoot (case-insensitive); OR
//	(b) TargetPath does not exist (broken) AND shortcut display name (without
//	    .lnk) equals any ClientName or starts with "<ClientName> "
//	    (case-insensitive, excluding ExcludeNames).
//
// Unmatched broken .lnk shortcuts are returned in KeptBroken for reporting only.
func MatchShortcutResidue(shortcuts []winshell.Shortcut, criteria []ProviderResidueCriteria) ShortcutMatchResult {
	var res ShortcutMatchResult
	seen := make(map[string]struct{}, len(shortcuts))
	for _, sc := range shortcuts {
		linkPath := strings.TrimSpace(sc.LinkPath)
		if linkPath == "" || !isWindowsLnkPath(linkPath) {
			continue
		}
		key := normalizeMatchPath(linkPath)
		if key == "" {
			continue
		}
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}

		broken := isBrokenShortcut(sc)
		name := shortcutDisplayName(sc)
		if matchesAnyCriteria(sc, name, broken, criteria) {
			res.Matched = append(res.Matched, sc)
		} else if broken {
			res.KeptBroken = append(res.KeptBroken, sc)
		}
	}
	sortShortcutsByLinkPath(res.Matched)
	sortShortcutsByLinkPath(res.KeptBroken)
	return res
}

func matchesAnyCriteria(sc winshell.Shortcut, name string, broken bool, criteria []ProviderResidueCriteria) bool {
	target := strings.TrimSpace(sc.TargetPath)
	for _, c := range criteria {
		if target != "" && isUnderAnyRoot(target, c.InstallRoots, false) {
			return true
		}
		if broken && shortcutNameMatchesAnyClient(name, c.ClientNames, c.ExcludeNames) {
			return true
		}
	}
	return false
}

// RemoveMatchedShortcuts deletes matched .lnk files and prunes any parent
// directories that become empty strictly beneath startMenuRoots.
func RemoveMatchedShortcuts(matched []winshell.Shortcut, startMenuRoots []string) (removed []string, removedDirs []string, warnings []string) {
	removed = []string{}
	seenLinks := make(map[string]struct{}, len(matched))
	seenDirs := make(map[string]struct{})
	for _, sc := range matched {
		linkPath := strings.TrimSpace(sc.LinkPath)
		if linkPath == "" || !isWindowsLnkPath(linkPath) {
			continue
		}
		key := normalizeMatchPath(linkPath)
		if _, dup := seenLinks[key]; dup {
			continue
		}
		seenLinks[key] = struct{}{}

		if err := os.Remove(linkPath); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			warnings = append(warnings, fmt.Sprintf("删除快捷方式失败 %s: %v", linkPath, err))
			continue
		}
		removed = append(removed, linkPath)

		dir := filepath.Dir(linkPath)
		for dir != "" && isUnderAnyRoot(dir, startMenuRoots, true) {
			entries, readErr := os.ReadDir(dir)
			if readErr != nil || len(entries) != 0 {
				break
			}
			if rmErr := os.Remove(dir); rmErr != nil {
				break
			}
			dirKey := normalizeMatchPath(dir)
			if _, dup := seenDirs[dirKey]; !dup {
				seenDirs[dirKey] = struct{}{}
				removedDirs = append(removedDirs, dir)
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	sortPathsCaseInsensitive(removed)
	sortPathsCaseInsensitive(removedDirs)
	return removed, removedDirs, warnings
}

func isBrokenShortcut(sc winshell.Shortcut) bool {
	return strings.TrimSpace(sc.TargetPath) != "" && !sc.TargetExists
}

func isWindowsLnkPath(raw string) bool {
	return strings.HasSuffix(strings.ToLower(strings.TrimSpace(raw)), ".lnk")
}

func shortcutDisplayName(sc winshell.Shortcut) string {
	name := strings.TrimSpace(sc.Name)
	if name == "" {
		name = windowsBaseName(sc.LinkPath)
	}
	if strings.HasSuffix(strings.ToLower(name), ".lnk") {
		name = strings.TrimSpace(name[:len(name)-4])
	}
	return name
}

func shortcutNameMatchesAnyClient(name string, clientNames, excludeNames []string) bool {
	name = strings.TrimSpace(name)
	if name == "" {
		return false
	}
	for _, excluded := range excludeNames {
		if shortcutNameMatchesOne(name, excluded) {
			return false
		}
	}
	for _, client := range clientNames {
		if shortcutNameMatchesOne(name, client) {
			return true
		}
	}
	return false
}

func shortcutNameMatchesOne(name, client string) bool {
	client = strings.TrimSpace(client)
	if client == "" {
		return false
	}
	if strings.EqualFold(name, client) {
		return true
	}
	return len(name) > len(client) && strings.EqualFold(name[:len(client)], client) && name[len(client)] == ' '
}

func isUnderAnyRoot(target string, roots []string, strict bool) bool {
	for _, root := range roots {
		if isUnderRoot(target, root, strict) {
			return true
		}
	}
	return false
}

func isUnderRoot(target, root string, strict bool) bool {
	nt := normalizeMatchPath(target)
	nr := normalizeMatchPath(root)
	if nt == "" || nr == "" {
		return false
	}
	if nt == nr {
		return !strict
	}
	if nr == "/" {
		return strings.HasPrefix(nt, "/")
	}
	return strings.HasPrefix(nt, nr+"/")
}

func normalizeMatchPath(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	s = strings.ReplaceAll(s, "\\", "/")
	unc := strings.HasPrefix(s, "//")
	cleaned := path.Clean(s)
	if unc && !strings.HasPrefix(cleaned, "//") {
		cleaned = "/" + cleaned
	}
	if len(cleaned) > 1 {
		cleaned = strings.TrimRight(cleaned, "/")
	}
	return strings.ToLower(cleaned)
}

func windowsBaseName(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	s = strings.ReplaceAll(s, "\\", "/")
	s = strings.TrimRight(s, "/")
	if s == "" {
		return ""
	}
	return path.Base(s)
}

func windowsParentDir(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	useBackslash := strings.Contains(s, "\\")
	slashed := strings.ReplaceAll(s, "\\", "/")
	unc := strings.HasPrefix(slashed, "//")
	dir := path.Dir(slashed)
	if dir == "." || dir == "/" || dir == slashed {
		return ""
	}
	if unc && !strings.HasPrefix(dir, "//") {
		dir = "/" + dir
	}
	if useBackslash {
		return strings.ReplaceAll(dir, "/", "\\")
	}
	return dir
}

func hasExecutableFileExt(raw string) bool {
	ext := strings.ToLower(path.Ext(windowsBaseName(raw)))
	switch ext {
	case ".exe", ".cmd", ".bat", ".com", ".msi", ".ps1", ".lnk":
		return true
	default:
		return false
	}
}

func uniqueStringsCaseInsensitive(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, item := range values {
		trimmed := strings.TrimSpace(item)
		if trimmed == "" {
			continue
		}
		key := strings.ToLower(trimmed)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

func uniquePathsCaseInsensitive(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, item := range values {
		trimmed := strings.TrimSpace(item)
		if trimmed == "" {
			continue
		}
		key := normalizeMatchPath(trimmed)
		if key == "" {
			continue
		}
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

func sortShortcutsByLinkPath(items []winshell.Shortcut) {
	sort.Slice(items, func(i, j int) bool {
		li := strings.ToLower(items[i].LinkPath)
		lj := strings.ToLower(items[j].LinkPath)
		if li != lj {
			return li < lj
		}
		return items[i].LinkPath < items[j].LinkPath
	})
}

func sortPathsCaseInsensitive(items []string) {
	sort.Slice(items, func(i, j int) bool {
		li := strings.ToLower(items[i])
		lj := strings.ToLower(items[j])
		if li != lj {
			return li < lj
		}
		return items[i] < items[j]
	})
}

func shortcutLinkPaths(items []winshell.Shortcut) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, item.LinkPath)
	}
	return out
}
