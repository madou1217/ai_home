package apps

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/winshell"
)

// ShortcutResidueCriteria holds the client display names and Windows install
// root directories used to match leftover Start Menu / Desktop shortcuts for a
// provider after uninstall.
type ShortcutResidueCriteria struct {
	Provider     string
	ClientNames  []string
	InstallRoots []string
}

// ShortcutMatchResult partitions enumerated shortcuts into matched residue and
// unmatched broken shortcuts (reported for visibility, never deleted).
type ShortcutMatchResult struct {
	Matched    []winshell.Shortcut
	KeptBroken []winshell.Shortcut
}

// ShortcutCleanupResult is the JSON response for
// POST /v1/management/webui/toolkit/apps/cleanup and the internal cleanup helper.
type ShortcutCleanupResult struct {
	OK          bool     `json:"ok"`
	Provider    string   `json:"provider,omitempty"`
	Removed     []string `json:"removed"`
	RemovedDirs []string `json:"removedDirs,omitempty"`
	KeptBroken  []string `json:"keptBroken"`
	Warnings    []string `json:"warnings,omitempty"`
	Error       string   `json:"error,omitempty"`
	Message     string   `json:"message,omitempty"`
}

func normalizeShortcutProvider(raw string) string {
	norm := strings.ToLower(strings.TrimSpace(raw))
	norm = strings.TrimSuffix(norm, "-desktop")
	return norm
}

// ResolveShortcutResidueCriteria derives the client names and expanded Windows
// install roots for one provider (when provider != "") or all known providers
// (when provider == ""). The second return value is false only when an explicit
// non-empty provider is unknown.
func ResolveShortcutResidueCriteria(provider string, opts Options) ([]ShortcutResidueCriteria, bool) {
	return resolveShortcutResidueCriteria(provider, opts, false)
}

func resolveShortcutResidueCriteria(provider string, opts Options, excludeLiveRoots bool) ([]ShortcutResidueCriteria, bool) {
	cat := resolveCatalog(opts)
	winOpts := opts
	winOpts.Platform = platformWindows
	genericRoots := buildGenericWindowsContainerRoots(winOpts)

	norm := normalizeShortcutProvider(provider)
	if norm != "" {
		def, hasDef := resolveProviderDefinition(cat, norm)
		spec := getInstaller(norm)
		ide := getIDEClient(norm)
		if !hasDef && spec == nil && ide == nil {
			return nil, false
		}
		c := buildProviderShortcutCriteria(norm, def, hasDef, spec, ide, winOpts, genericRoots, excludeLiveRoots)
		if len(c.ClientNames) == 0 && len(c.InstallRoots) == 0 {
			return nil, true
		}
		return []ShortcutResidueCriteria{c}, true
	}

	seen := make(map[string]struct{})
	var list []ShortcutResidueCriteria
	addProvider := func(id string) {
		pid := strings.ToLower(strings.TrimSpace(id))
		if pid == "" {
			return
		}
		if _, dup := seen[pid]; dup {
			return
		}
		seen[pid] = struct{}{}
		def, hasDef := resolveProviderDefinition(cat, pid)
		c := buildProviderShortcutCriteria(pid, def, hasDef, getInstaller(pid), getIDEClient(pid), winOpts, genericRoots, excludeLiveRoots)
		if len(c.ClientNames) > 0 || len(c.InstallRoots) > 0 {
			list = append(list, c)
		}
	}
	if cat != nil {
		for _, def := range cat.List() {
			addProvider(def.ID)
		}
	}
	for _, ide := range listIDEClients() {
		addProvider(ide.ID)
	}
	return list, true
}

func buildProviderShortcutCriteria(
	provider string,
	def providers.Definition,
	hasDef bool,
	spec *providerInstallerSpec,
	ide *IDEClientSpec,
	winOpts Options,
	genericRoots map[string]struct{},
	excludeLiveRoots bool,
) ShortcutResidueCriteria {
	var names []string
	var roots []string

	addBundleNames := func(bundles []string) {
		for _, b := range bundles {
			trimmed := strings.TrimSpace(b)
			if trimmed == "" {
				continue
			}
			if strings.HasSuffix(strings.ToLower(trimmed), ".app") {
				trimmed = strings.TrimSpace(trimmed[:len(trimmed)-4])
			}
			if trimmed != "" {
				names = append(names, trimmed)
			}
		}
	}

	if hasDef && def.CLI != nil && def.CLI.DesktopClient != nil {
		dc := def.CLI.DesktopClient
		if dc.Windows != nil {
			names = append(names, dc.Windows.ClientName)
			names = append(names, dc.Windows.DisplayNames...)
			for _, rawInstall := range dc.Windows.InstallPaths {
				expanded := expandDesktopToken(rawInstall, winOpts)
				if expanded == "" {
					continue
				}
				if excludeLiveRoots && fileExists(expanded) {
					continue
				}
				root := deriveInstallRoot(expanded, genericRoots)
				if root != "" {
					roots = append(roots, root)
				}
			}
		}
		if dc.MacOS != nil {
			names = append(names, dc.MacOS.ClientName)
			addBundleNames(dc.MacOS.BundleNames)
		}
	}

	if spec != nil && spec.Desktop != nil {
		if winDesc := spec.Desktop[platformWindows]; winDesc != nil {
			names = append(names, winDesc.WindowsDisplayNames...)
		}
	}

	if ide != nil {
		names = append(names, ide.Name)
		names = append(names, ide.WindowsDisplayNames...)
		addBundleNames(ide.MacBundleNames)
		bases := []string{
			expandDesktopToken("{localAppData}/Programs", winOpts),
			expandDesktopToken("{programFiles}", winOpts),
			expandDesktopToken("{programFilesX86}", winOpts),
		}
		for _, base := range uniqueStringsCaseInsensitive(bases) {
			for _, prog := range ide.WindowsProgramNames {
				prog = strings.TrimSpace(prog)
				if prog == "" {
					continue
				}
				candidateRoot := joinPlatformPath(platformWindows, base, prog)
				if excludeLiveRoots && ideRootHasLiveExecutable(candidateRoot, ide.WindowsExecutableNames) {
					continue
				}
				if root := deriveInstallRoot(candidateRoot, genericRoots); root != "" {
					roots = append(roots, root)
				}
			}
		}
	}

	return ShortcutResidueCriteria{
		Provider:     provider,
		ClientNames:  uniqueStringsCaseInsensitive(names),
		InstallRoots: uniquePathsCaseInsensitive(roots),
	}
}

func ideRootHasLiveExecutable(root string, execNames []string) bool {
	for _, exe := range execNames {
		exe = strings.TrimSpace(exe)
		if exe == "" {
			continue
		}
		if fileExists(joinPlatformPath(platformWindows, root, exe)) {
			return true
		}
	}
	return false
}

func buildGenericWindowsContainerRoots(winOpts Options) map[string]struct{} {
	raw := []string{
		ResolveHostHome(winOpts),
		expandDesktopToken("{localAppData}", winOpts),
		expandDesktopToken("{localAppData}/Programs", winOpts),
		expandDesktopToken("{appData}", winOpts),
		expandDesktopToken("{programFiles}", winOpts),
		expandDesktopToken("{programFilesX86}", winOpts),
	}
	set := make(map[string]struct{}, len(raw))
	for _, item := range raw {
		if norm := normalizeMatchPath(item); norm != "" {
			set[norm] = struct{}{}
		}
	}
	return set
}

func deriveInstallRoot(expanded string, genericRoots map[string]struct{}) string {
	trimmed := strings.TrimSpace(expanded)
	if trimmed == "" {
		return ""
	}
	candidate := trimmed
	if hasExecutableFileExt(trimmed) {
		parent := windowsParentDir(trimmed)
		if parent != "" {
			if normParent := normalizeMatchPath(parent); normParent != "" && !isUnsafeContainerRoot(normParent, genericRoots) {
				candidate = parent
			}
		}
	}
	norm := normalizeMatchPath(candidate)
	if norm == "" || isUnsafeContainerRoot(norm, genericRoots) {
		return ""
	}
	return candidate
}

func isUnsafeContainerRoot(norm string, genericRoots map[string]struct{}) bool {
	if norm == "" || norm == "/" || len(norm) <= 2 {
		return true
	}
	if _, ok := genericRoots[norm]; ok {
		return true
	}
	return false
}

// MatchShortcutResidue evaluates enumerated Windows shortcuts against provider
// residue criteria without performing any filesystem I/O.
//
// A shortcut is selected for removal only if it is a .lnk file AND satisfies:
//
//	(a) TargetPath is located under any InstallRoot (case-insensitive); OR
//	(b) TargetPath does not exist (broken) AND shortcut display name (without
//	    .lnk) equals any ClientName or starts with "<ClientName> "
//	    (case-insensitive).
//
// Unmatched broken .lnk shortcuts are returned in KeptBroken for reporting only.
func MatchShortcutResidue(shortcuts []winshell.Shortcut, criteria []ShortcutResidueCriteria) ShortcutMatchResult {
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

func matchesAnyCriteria(sc winshell.Shortcut, name string, broken bool, criteria []ShortcutResidueCriteria) bool {
	target := strings.TrimSpace(sc.TargetPath)
	for _, c := range criteria {
		if target != "" && isUnderAnyRoot(target, c.InstallRoots, false) {
			return true
		}
		if broken && shortcutNameMatchesAnyClient(name, c.ClientNames) {
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

func shortcutNameMatchesAnyClient(name string, clientNames []string) bool {
	name = strings.TrimSpace(name)
	if name == "" {
		return false
	}
	for _, client := range clientNames {
		client = strings.TrimSpace(client)
		if client == "" {
			continue
		}
		if strings.EqualFold(name, client) {
			return true
		}
		if len(name) > len(client) && strings.EqualFold(name[:len(client)], client) && name[len(client)] == ' ' {
			return true
		}
	}
	return false
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
