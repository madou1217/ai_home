package apps

import (
	"fmt"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// RegistryScope identifies whether a Windows registry entry comes from the
// writable per-user hive (HKCU) or the read-only machine-wide hive (HKLM).
type RegistryScope string

const (
	RegistryScopeHKCU RegistryScope = "HKCU"
	RegistryScopeHKLM RegistryScope = "HKLM"

	RegPathUninstall      = `Software\Microsoft\Windows\CurrentVersion\Uninstall`
	RegPathUninstallWOW64 = `Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`
	RegPathAppPaths       = `Software\Microsoft\Windows\CurrentVersion\App Paths`
	RegPathRun            = `Software\Microsoft\Windows\CurrentVersion\Run`
	RegPathRunOnce        = `Software\Microsoft\Windows\CurrentVersion\RunOnce`
)

// RegistryUninstallEntry describes one subkey under
// <Scope>\Software\[WOW6432Node\]Microsoft\Windows\CurrentVersion\Uninstall\<SubKey>.
type RegistryUninstallEntry struct {
	Scope                RegistryScope
	ParentPath           string
	SubKey               string
	DisplayName          string
	InstallLocation      string
	DisplayIcon          string
	UninstallString      string
	QuietUninstallString string
	DisplayVersion       string
}

// FullPath returns the canonical registry path for logging and reporting.
func (e RegistryUninstallEntry) FullPath() string {
	parent := nonEmpty(e.ParentPath, RegPathUninstall)
	return fmt.Sprintf(`%s\%s\%s`, nonEmpty(string(e.Scope), string(RegistryScopeHKCU)), parent, e.SubKey)
}

// RegistryAppPathEntry describes one subkey under
// <Scope>\Software\Microsoft\Windows\CurrentVersion\App Paths\<ExeName>.
type RegistryAppPathEntry struct {
	Scope       RegistryScope
	ParentPath  string
	ExeName     string
	DefaultPath string
	Path        string
}

// FullPath returns the canonical registry path for logging and reporting.
func (e RegistryAppPathEntry) FullPath() string {
	parent := nonEmpty(e.ParentPath, RegPathAppPaths)
	return fmt.Sprintf(`%s\%s\%s`, nonEmpty(string(e.Scope), string(RegistryScopeHKCU)), parent, e.ExeName)
}

// RegistryRunEntry describes one named value under
// <Scope>\Software\Microsoft\Windows\CurrentVersion\Run or RunOnce.
type RegistryRunEntry struct {
	Scope     RegistryScope
	KeyPath   string
	ValueName string
	Command   string
}

// FullPath returns the canonical registry key::value identifier for logging and reporting.
func (e RegistryRunEntry) FullPath() string {
	keyPath := nonEmpty(e.KeyPath, RegPathRun)
	return fmt.Sprintf(`%s\%s::%s`, nonEmpty(string(e.Scope), string(RegistryScopeHKCU)), keyPath, e.ValueName)
}

// RegistryCandidates bundles registry entries enumerated from the allowlisted
// Windows registry locations so matching stays completely pure and testable on
// any OS without registry I/O.
type RegistryCandidates struct {
	Uninstall []RegistryUninstallEntry
	AppPaths  []RegistryAppPathEntry
	Run       []RegistryRunEntry
}

// RegistryMatchResult partitions matched registry entries into writable HKCU
// deletion targets and read-only HKLM findings (which are reported as warnings
// and never modified).
type RegistryMatchResult struct {
	RemoveUninstall []RegistryUninstallEntry
	RemoveAppPaths  []RegistryAppPathEntry
	RemoveRun       []RegistryRunEntry
	AdminSkipped    []string
}

// MatchRegistryResidue evaluates enumerated Windows registry candidates against
// provider residue criteria without performing any registry or filesystem I/O.
//
// Matching rules (strict allowlist only):
//   - Uninstall\<key>: DisplayName equals a ClientName or contains it at
//     case-insensitive word boundaries (excluding ExcludeNames), OR any of
//     InstallLocation / DisplayIcon / UninstallString / QuietUninstallString
//     resolves under an InstallRoot.
//   - App Paths\<exe>: exe basename equals an ExecutableName (case-insensitive),
//     OR DefaultPath resolves under an InstallRoot.
//   - Run / RunOnce values: ValueName equals a ClientName (case-insensitive),
//     OR Command executable path resolves under an InstallRoot.
//
// HKLM matches are never scheduled for removal; they are returned in
// AdminSkipped so callers emit an explicit "需要管理员权限，已跳过" warning.
func MatchRegistryResidue(candidates RegistryCandidates, criteria []ProviderResidueCriteria) RegistryMatchResult {
	var res RegistryMatchResult
	if len(criteria) == 0 {
		return res
	}

	seenUninstall := make(map[string]struct{}, len(candidates.Uninstall))
	seenAppPaths := make(map[string]struct{}, len(candidates.AppPaths))
	seenRun := make(map[string]struct{}, len(candidates.Run))
	seenAdmin := make(map[string]struct{})

	addAdmin := func(fullPath string) {
		key := strings.ToLower(strings.TrimSpace(fullPath))
		if key == "" {
			return
		}
		if _, dup := seenAdmin[key]; dup {
			return
		}
		seenAdmin[key] = struct{}{}
		res.AdminSkipped = append(res.AdminSkipped, fullPath)
	}

	for _, entry := range candidates.Uninstall {
		subKey := strings.TrimSpace(entry.SubKey)
		if !isValidRegistrySubKeyName(subKey) {
			continue
		}
		entry.SubKey = subKey
		entry.ParentPath = nonEmpty(entry.ParentPath, RegPathUninstall)
		if !matchesAnyUninstallCriteria(entry, criteria) {
			continue
		}
		fullPath := entry.FullPath()
		if entry.Scope == RegistryScopeHKLM {
			addAdmin(fullPath)
			continue
		}
		if entry.Scope != RegistryScopeHKCU || !isAllowedHKCUKeyParent(entry.ParentPath) {
			continue
		}
		dedup := strings.ToLower(fullPath)
		if _, dup := seenUninstall[dedup]; dup {
			continue
		}
		seenUninstall[dedup] = struct{}{}
		res.RemoveUninstall = append(res.RemoveUninstall, entry)
	}

	for _, entry := range candidates.AppPaths {
		exeName := strings.TrimSpace(entry.ExeName)
		if !isValidRegistrySubKeyName(exeName) {
			continue
		}
		entry.ExeName = exeName
		entry.ParentPath = nonEmpty(entry.ParentPath, RegPathAppPaths)
		if !matchesAnyAppPathCriteria(entry, criteria) {
			continue
		}
		fullPath := entry.FullPath()
		if entry.Scope == RegistryScopeHKLM {
			addAdmin(fullPath)
			continue
		}
		if entry.Scope != RegistryScopeHKCU || !isAllowedHKCUKeyParent(entry.ParentPath) {
			continue
		}
		dedup := strings.ToLower(fullPath)
		if _, dup := seenAppPaths[dedup]; dup {
			continue
		}
		seenAppPaths[dedup] = struct{}{}
		res.RemoveAppPaths = append(res.RemoveAppPaths, entry)
	}

	for _, entry := range candidates.Run {
		valueName := strings.TrimSpace(entry.ValueName)
		if valueName == "" {
			continue
		}
		entry.KeyPath = nonEmpty(entry.KeyPath, RegPathRun)
		if !matchesAnyRunCriteria(entry, criteria) {
			continue
		}
		fullPath := entry.FullPath()
		if entry.Scope == RegistryScopeHKLM {
			addAdmin(fullPath)
			continue
		}
		if entry.Scope != RegistryScopeHKCU || !isAllowedHKCURunPath(entry.KeyPath) {
			continue
		}
		dedup := strings.ToLower(fullPath)
		if _, dup := seenRun[dedup]; dup {
			continue
		}
		seenRun[dedup] = struct{}{}
		res.RemoveRun = append(res.RemoveRun, entry)
	}

	sort.Slice(res.RemoveUninstall, func(i, j int) bool {
		return strings.ToLower(res.RemoveUninstall[i].FullPath()) < strings.ToLower(res.RemoveUninstall[j].FullPath())
	})
	sort.Slice(res.RemoveAppPaths, func(i, j int) bool {
		return strings.ToLower(res.RemoveAppPaths[i].FullPath()) < strings.ToLower(res.RemoveAppPaths[j].FullPath())
	})
	sort.Slice(res.RemoveRun, func(i, j int) bool {
		return strings.ToLower(res.RemoveRun[i].FullPath()) < strings.ToLower(res.RemoveRun[j].FullPath())
	})
	sortPathsCaseInsensitive(res.AdminSkipped)
	return res
}

func matchesAnyUninstallCriteria(entry RegistryUninstallEntry, criteria []ProviderResidueCriteria) bool {
	paths := uninstallEntryCandidatePaths(entry)
	for _, c := range criteria {
		if matchesUninstallDisplayName(entry.DisplayName, c.ClientNames, c.ExcludeNames) {
			return true
		}
		for _, p := range paths {
			if p != "" && isUnderAnyRoot(p, c.InstallRoots, false) {
				return true
			}
		}
	}
	return false
}

func uninstallEntryCandidatePaths(entry RegistryUninstallEntry) []string {
	var out []string
	if p := cleanRegistryDirPath(entry.InstallLocation); p != "" {
		out = append(out, p)
	}
	if p := extractRegistryIconPath(entry.DisplayIcon); p != "" {
		out = append(out, p)
	}
	if p := extractWindowsCommandPath(entry.UninstallString); p != "" {
		out = append(out, p)
	}
	if p := extractWindowsCommandPath(entry.QuietUninstallString); p != "" {
		out = append(out, p)
	}
	return out
}

func matchesAnyAppPathCriteria(entry RegistryAppPathEntry, criteria []ProviderResidueCriteria) bool {
	exeBase := strings.TrimSpace(windowsBaseName(entry.ExeName))
	defaultPath := extractWindowsCommandPath(entry.DefaultPath)
	if defaultPath == "" {
		defaultPath = cleanRegistryDirPath(entry.DefaultPath)
	}
	for _, c := range criteria {
		if exeBase != "" && matchesAnyExecutableName(exeBase, c.ExecutableNames) {
			return true
		}
		if defaultPath != "" && isUnderAnyRoot(defaultPath, c.InstallRoots, false) {
			return true
		}
	}
	return false
}

func matchesAnyRunCriteria(entry RegistryRunEntry, criteria []ProviderResidueCriteria) bool {
	valName := strings.TrimSpace(entry.ValueName)
	cmdPath := extractWindowsCommandPath(entry.Command)
	for _, c := range criteria {
		if valName != "" && matchesExactClientName(valName, c.ClientNames) {
			return true
		}
		if cmdPath != "" && isUnderAnyRoot(cmdPath, c.InstallRoots, false) {
			return true
		}
	}
	return false
}

func matchesExactClientName(value string, clientNames []string) bool {
	value = strings.TrimSpace(value)
	if value == "" {
		return false
	}
	for _, client := range clientNames {
		client = strings.TrimSpace(client)
		if client != "" && strings.EqualFold(value, client) {
			return true
		}
	}
	return false
}

func matchesAnyExecutableName(exeBase string, executableNames []string) bool {
	exeBase = strings.TrimSpace(exeBase)
	if exeBase == "" {
		return false
	}
	for _, item := range executableNames {
		item = strings.TrimSpace(item)
		if item != "" && strings.EqualFold(exeBase, item) {
			return true
		}
	}
	return false
}

func matchesUninstallDisplayName(displayName string, clientNames, excludeNames []string) bool {
	displayName = strings.TrimSpace(displayName)
	if displayName == "" {
		return false
	}
	for _, excluded := range excludeNames {
		if containsWordBoundaryFold(displayName, excluded) {
			return false
		}
	}
	for _, client := range clientNames {
		if containsWordBoundaryFold(displayName, client) {
			return true
		}
	}
	return false
}

// containsWordBoundaryFold reports whether haystack equals needle or contains
// needle at case-insensitive word boundaries. Very short needles (< 3 runes,
// such as "Pi") require an exact case-insensitive match to avoid matching
// unrelated product names like "Raspberry Pi Imager".
func containsWordBoundaryFold(haystack, needle string) bool {
	h := strings.ToLower(strings.TrimSpace(haystack))
	n := strings.ToLower(strings.TrimSpace(needle))
	if h == "" || n == "" {
		return false
	}
	if h == n {
		return true
	}
	if utf8.RuneCountInString(n) < 3 {
		return false
	}
	offset := 0
	for offset <= len(h)-len(n) {
		idx := strings.Index(h[offset:], n)
		if idx < 0 {
			return false
		}
		start := offset + idx
		end := start + len(n)
		leftOK := start == 0
		if !leftOK {
			prev, _ := utf8.DecodeLastRuneInString(h[:start])
			leftOK = !isRegistryWordRune(prev)
		}
		rightOK := end == len(h)
		if !rightOK {
			next, _ := utf8.DecodeRuneInString(h[end:])
			rightOK = !isRegistryWordRune(next)
		}
		if leftOK && rightOK {
			return true
		}
		_, step := utf8.DecodeRuneInString(h[start:])
		if step <= 0 {
			step = 1
		}
		offset = start + step
	}
	return false
}

func isRegistryWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_'
}

func cleanRegistryDirPath(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	s = strings.Trim(s, `"`)
	return strings.TrimSpace(s)
}

func extractRegistryIconPath(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	if strings.HasPrefix(s, `"`) {
		if end := strings.Index(s[1:], `"`); end >= 0 {
			s = strings.TrimSpace(s[1 : 1+end])
		} else {
			s = strings.TrimSpace(strings.TrimPrefix(s, `"`))
		}
	}
	s = stripTrailingIconIndex(s)
	s = strings.Trim(strings.TrimSpace(s), `"`)
	return strings.TrimSpace(s)
}

func stripTrailingIconIndex(s string) string {
	comma := strings.LastIndex(s, ",")
	if comma <= 0 {
		return s
	}
	suffix := strings.TrimSpace(s[comma+1:])
	if suffix == "" {
		return s
	}
	if strings.HasPrefix(suffix, "-") {
		suffix = suffix[1:]
	}
	if suffix == "" {
		return s
	}
	for i := 0; i < len(suffix); i++ {
		if suffix[i] < '0' || suffix[i] > '9' {
			return s
		}
	}
	return strings.TrimSpace(s[:comma])
}

var windowsCommandExts = []string{".exe", ".com", ".bat", ".cmd", ".msi", ".ps1", ".vbs", ".msc", ".lnk"}

// extractWindowsCommandPath extracts the leading executable path from a Windows
// command string (quoted or unquoted, including unquoted paths containing
// spaces such as `C:\Program Files\App\Uninstall App.exe /S`).
func extractWindowsCommandPath(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	if strings.HasPrefix(s, `"`) {
		if end := strings.Index(s[1:], `"`); end >= 0 {
			return strings.TrimSpace(s[1 : 1+end])
		}
		s = strings.TrimSpace(strings.TrimPrefix(s, `"`))
	}

	lower := strings.ToLower(s)
	bestEnd := -1
	for _, ext := range windowsCommandExts {
		searchFrom := 0
		for searchFrom < len(lower) {
			rel := strings.Index(lower[searchFrom:], ext)
			if rel < 0 {
				break
			}
			pos := searchFrom + rel
			end := pos + len(ext)
			if pos > 0 && (end == len(lower) || lower[end] == ' ' || lower[end] == '\t' || lower[end] == ',') {
				if bestEnd < 0 || end < bestEnd {
					bestEnd = end
				}
				break
			}
			searchFrom = pos + 1
		}
	}
	if bestEnd > 0 {
		return strings.TrimSpace(s[:bestEnd])
	}

	// Unquoted plain path without recognized executable extension: stop before
	// common CLI flag separators when present.
	for _, sep := range []string{" /", " -", "\t/", "\t-"} {
		if idx := strings.Index(s, sep); idx > 0 {
			return strings.TrimSpace(s[:idx])
		}
	}
	if strings.ContainsAny(s, `\/:`) {
		return s
	}
	if idx := strings.IndexAny(s, " \t"); idx > 0 {
		return strings.TrimSpace(s[:idx])
	}
	return s
}

func formatHKLMRegistrySkippedWarning(fullPath string) string {
	return fmt.Sprintf("注册表残留 %s 需要管理员权限，已跳过", strings.TrimSpace(fullPath))
}

func isValidRegistrySubKeyName(subKey string) bool {
	s := strings.TrimSpace(subKey)
	if s == "" || s == "." || s == ".." {
		return false
	}
	return !strings.ContainsAny(s, `\/`)
}

func isAllowedHKCUKeyParent(parent string) bool {
	switch {
	case strings.EqualFold(strings.TrimSpace(parent), RegPathUninstall):
		return true
	case strings.EqualFold(strings.TrimSpace(parent), RegPathAppPaths):
		return true
	default:
		return false
	}
}

func isAllowedHKCURunPath(keyPath string) bool {
	switch {
	case strings.EqualFold(strings.TrimSpace(keyPath), RegPathRun):
		return true
	case strings.EqualFold(strings.TrimSpace(keyPath), RegPathRunOnce):
		return true
	default:
		return false
	}
}
