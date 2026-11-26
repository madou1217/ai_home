package apps

import (
	"path"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

// ProviderResidueCriteria holds the client display names, Windows executable
// basenames, and expanded install roots used to match leftover shortcuts and
// Windows registry entries for a provider after uninstall.
type ProviderResidueCriteria struct {
	Provider        string
	ClientNames     []string
	ExcludeNames    []string
	ExecutableNames []string
	InstallRoots    []string
}

// ResidueCleanupResult is the JSON response for
// POST /v1/management/webui/toolkit/apps/cleanup and the internal uninstall
// cleanup helper.
type ResidueCleanupResult struct {
	OK               bool     `json:"ok"`
	Provider         string   `json:"provider,omitempty"`
	RemovedShortcuts []string `json:"removedShortcuts"`
	RemovedRegistry  []string `json:"removedRegistry"`
	RemovedDirs      []string `json:"removedDirs,omitempty"`
	KeptBroken       []string `json:"keptBroken"`
	Warnings         []string `json:"warnings,omitempty"`
	Error            string   `json:"error,omitempty"`
	Message          string   `json:"message,omitempty"`
}

func emptyResidueCleanupResult(provider string) ResidueCleanupResult {
	return ResidueCleanupResult{
		OK:               true,
		Provider:         provider,
		RemovedShortcuts: []string{},
		RemovedRegistry:  []string{},
		KeptBroken:       []string{},
	}
}

func normalizeResidueProvider(raw string) string {
	norm := strings.ToLower(strings.TrimSpace(raw))
	norm = strings.TrimSuffix(norm, "-desktop")
	return norm
}

// ResolveProviderResidueCriteria derives the client names, executable basenames,
// and expanded Windows install roots for one provider (when provider != "") or
// all known providers (when provider == ""). The second return value is false
// only when an explicit non-empty provider is unknown.
func ResolveProviderResidueCriteria(provider string, opts Options) ([]ProviderResidueCriteria, bool) {
	return resolveProviderResidueCriteria(provider, "", opts, false, false, nil)
}

// ResolveProviderResidueCriteriaForKind derives residue matching criteria scoped
// to a specific target kind ("desktop", "cli", or "" for both) plus optional
// pre-uninstall executable/install paths captured before the uninstaller ran.
func ResolveProviderResidueCriteriaForKind(provider, kind string, opts Options, extraInstallPaths ...string) ([]ProviderResidueCriteria, bool) {
	return resolveProviderResidueCriteria(provider, kind, opts, false, false, extraInstallPaths)
}

func resolveProviderResidueCriteria(
	provider string,
	kind string,
	opts Options,
	excludeLiveRoots bool,
	excludeLiveApps bool,
	extraInstallPaths []string,
) ([]ProviderResidueCriteria, bool) {
	cat := resolveCatalog(opts)
	winOpts := opts
	winOpts.Platform = platformWindows
	genericRoots := buildGenericWindowsContainerRoots(winOpts)

	normKind := normalizeLifecycleKind(kind)
	norm := normalizeResidueProvider(provider)
	if norm != "" {
		def, hasDef := resolveProviderDefinition(cat, norm)
		spec := getInstaller(norm)
		ide := getIDEClient(norm)
		if !hasDef && spec == nil && ide == nil {
			return nil, false
		}
		c := buildProviderResidueCriteria(norm, normKind, def, hasDef, spec, ide, winOpts, genericRoots, excludeLiveRoots, excludeLiveApps, extraInstallPaths)
		if isEmptyResidueCriteria(c) {
			return nil, true
		}
		return []ProviderResidueCriteria{c}, true
	}

	seen := make(map[string]struct{})
	var list []ProviderResidueCriteria
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
		c := buildProviderResidueCriteria(pid, normKind, def, hasDef, getInstaller(pid), getIDEClient(pid), winOpts, genericRoots, excludeLiveRoots, excludeLiveApps, nil)
		if !isEmptyResidueCriteria(c) {
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
	for _, standalone := range listStandaloneApps() {
		addProvider(standalone.Provider)
	}
	return list, true
}

func isEmptyResidueCriteria(c ProviderResidueCriteria) bool {
	return len(c.ClientNames) == 0 && len(c.ExecutableNames) == 0 && len(c.InstallRoots) == 0
}

func buildProviderResidueCriteria(
	provider string,
	kind string,
	def providers.Definition,
	hasDef bool,
	spec *providerInstallerSpec,
	ide *IDEClientSpec,
	winOpts Options,
	genericRoots map[string]struct{},
	excludeLiveRoots bool,
	excludeLiveApps bool,
	extraInstallPaths []string,
) ProviderResidueCriteria {
	includeDesktop := kind == "" || kind == "desktop"
	includeCLI := kind == "" || kind == "cli"

	var names []string
	var excludeNames []string
	var execNames []string
	var roots []string

	if includeDesktop {
		desktopLive := excludeLiveApps && hasLiveWindowsDesktop(def, hasDef, ide, winOpts)
		if !desktopLive {
			dNames, dExcludes, dExecs, dRoots := buildDesktopResiduePart(provider, def, hasDef, spec, ide, winOpts, genericRoots, excludeLiveRoots)
			names = append(names, dNames...)
			excludeNames = append(excludeNames, dExcludes...)
			execNames = append(execNames, dExecs...)
			roots = append(roots, dRoots...)
			if kind == "desktop" {
				// Prevent desktop uninstall from touching the provider's own CLI
				// registry entries or shortcuts if the CLI remains installed.
				excludeNames = append(excludeNames, cliClientDisplayNames(provider, spec)...)
			}
		}
	}

	if includeCLI {
		cliLive := excludeLiveApps && hasLiveWindowsCLI(provider, winOpts)
		if !cliLive {
			cNames, cExecs, cRoots := buildCLIResiduePart(provider, def, hasDef, spec, winOpts, genericRoots, excludeLiveRoots)
			names = append(names, cNames...)
			execNames = append(execNames, cExecs...)
			roots = append(roots, cRoots...)
		}
	}

	for _, rawExtra := range extraInstallPaths {
		expanded := strings.TrimSpace(rawExtra)
		if expanded == "" {
			continue
		}
		if excludeLiveRoots && fileExists(expanded) {
			continue
		}
		if root := deriveInstallRoot(expanded, genericRoots); root != "" {
			roots = append(roots, root)
		}
		if exe := normalizeWindowsExeBaseName(expanded); exe != "" {
			execNames = append(execNames, exe)
		}
	}

	return ProviderResidueCriteria{
		Provider:        provider,
		ClientNames:     uniqueStringsCaseInsensitive(names),
		ExcludeNames:    uniqueStringsCaseInsensitive(excludeNames),
		ExecutableNames: uniqueStringsCaseInsensitive(execNames),
		InstallRoots:    uniquePathsCaseInsensitive(roots),
	}
}

func buildDesktopResiduePart(
	provider string,
	def providers.Definition,
	hasDef bool,
	spec *providerInstallerSpec,
	ide *IDEClientSpec,
	winOpts Options,
	genericRoots map[string]struct{},
	excludeLiveRoots bool,
) (names, excludeNames, execNames, roots []string) {
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

	hasWindowsDesktop := false
	if hasDef && def.CLI != nil && def.CLI.DesktopClient != nil {
		dc := def.CLI.DesktopClient
		if dc.Windows != nil {
			hasWindowsDesktop = true
			names = append(names, dc.Windows.ClientName)
			names = append(names, dc.Windows.DisplayNames...)
			for _, candidate := range dc.Windows.ExecNames {
				if exe := normalizeWindowsExeBaseName(candidate); exe != "" {
					execNames = append(execNames, exe)
				}
			}
			for _, candidate := range dc.Windows.ProcessNames {
				if exe := normalizeWindowsExeBaseName(candidate); exe != "" {
					execNames = append(execNames, exe)
				}
			}
			for _, rawInstall := range dc.Windows.InstallPaths {
				expanded := expandDesktopToken(rawInstall, winOpts)
				if expanded == "" {
					continue
				}
				if exe := normalizeWindowsExeBaseName(expanded); exe != "" {
					execNames = append(execNames, exe)
				}
				if excludeLiveRoots && fileExists(expanded) {
					continue
				}
				if root := deriveInstallRoot(expanded, genericRoots); root != "" {
					roots = append(roots, root)
				}
			}
		}
		if !hasWindowsDesktop && dc.MacOS != nil {
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
		for _, candidate := range ide.WindowsExecutableNames {
			if exe := normalizeWindowsExeBaseName(candidate); exe != "" {
				execNames = append(execNames, exe)
			}
		}
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

	excludeNames = append(excludeNames, siblingDesktopExcludeNames(provider)...)
	return names, excludeNames, execNames, roots
}

func siblingDesktopExcludeNames(provider string) []string {
	switch provider {
	case "qoder":
		return []string{"Qoder CN", "Qoder CN IDE", "QoderCN"}
	case "codebuddy":
		return []string{"CodeBuddy CN", "CodeBuddyCN"}
	case "workbuddycn":
		return []string{"WorkBuddy AI"}
	default:
		return nil
	}
}

func buildCLIResiduePart(
	provider string,
	def providers.Definition,
	hasDef bool,
	spec *providerInstallerSpec,
	winOpts Options,
	genericRoots map[string]struct{},
	excludeLiveRoots bool,
) (names, execNames, roots []string) {
	if (spec == nil || spec.CLI == nil) && (!hasDef || def.CLI == nil || def.CLI.BinaryName == "") {
		return nil, nil, nil
	}
	names = append(names, cliClientDisplayNames(provider, spec)...)

	var rawBins []string
	if spec != nil && spec.CLI != nil {
		rawBins = append(rawBins, spec.CLI.BinaryNames...)
	}
	if hasDef && def.CLI != nil && def.CLI.BinaryName != "" {
		rawBins = append(rawBins, def.CLI.BinaryName)
	}
	if spec != nil && spec.ManagedApp != nil && spec.ManagedApp.BinaryName != "" {
		rawBins = append(rawBins, spec.ManagedApp.BinaryName)
	}
	for _, bin := range rawBins {
		if exe := normalizeCLIBinaryExeName(bin); exe != "" {
			execNames = append(execNames, exe)
		}
	}

	home := ResolveHostHome(winOpts)
	addRootCandidate := func(raw string) {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			return
		}
		if excludeLiveRoots && fileExists(trimmed) {
			return
		}
		if root := deriveInstallRoot(trimmed, genericRoots); root != "" {
			roots = append(roots, root)
		}
	}

	if provider == "codex" {
		addRootCandidate(codexInstallPrefix(winOpts))
	}
	if hasDef && def.CLI != nil && def.CLI.InstallRoot != nil && len(*def.CLI.InstallRoot) > 0 && home != "" {
		parts := append([]string{home}, (*def.CLI.InstallRoot)...)
		addRootCandidate(joinPlatformPath(platformWindows, parts...))
	}
	if spec != nil && spec.CLI != nil {
		for _, tree := range spec.CLI.CleanupTrees {
			addRootCandidate(tree)
		}
		for _, file := range spec.CLI.CleanupFiles {
			addRootCandidate(file)
		}
		if home != "" {
			for _, rel := range spec.CLI.CleanupHomeTrees {
				addRootCandidate(joinPlatformPath(platformWindows, home, rel))
			}
			for _, rel := range spec.CLI.CleanupHomeFiles {
				joined := joinPlatformPath(platformWindows, home, rel)
				addRootCandidate(joined)
				if !hasExecutableFileExt(joined) {
					addRootCandidate(joined + ".exe")
				}
			}
		}
		if spec.CLI.CollectPathEntries != nil {
			programsRoot := expandDesktopToken("{localAppData}/Programs", winOpts)
			progFilesRoot := expandDesktopToken("{programFiles}", winOpts)
			for _, entry := range spec.CLI.CollectPathEntries(winOpts) {
				trimmed := strings.TrimSpace(entry)
				if trimmed == "" {
					continue
				}
				// Skip desktop IDE directories (such as %LOCALAPPDATA%\Programs\Qoder
				// or %ProgramFiles%\Qoder\bin) where a bundled CLI lives inside the
				// Desktop app tree.
				if isUnderRoot(trimmed, programsRoot, true) {
					continue
				}
				if (provider == "qoder" || provider == "qodercn") && isUnderRoot(trimmed, progFilesRoot, true) {
					continue
				}
				addRootCandidate(trimmed)
			}
		}
	}
	return names, execNames, roots
}

func cliClientDisplayNames(provider string, spec *providerInstallerSpec) []string {
	if spec != nil && spec.ManagedApp != nil {
		return uniqueStringsCaseInsensitive([]string{spec.ManagedApp.ClientName, spec.ManagedApp.Name})
	}
	switch provider {
	case "claude":
		return []string{"Claude Code"}
	case "codex":
		return []string{"Codex CLI"}
	case "agy":
		return []string{"Antigravity CLI"}
	case "opencode":
		return []string{"OpenCode CLI"}
	case "kimi":
		return []string{"Kimi CLI", "Kimi Code CLI"}
	case "kiro":
		return []string{"Kiro CLI"}
	case "qoder":
		return []string{"Qoder CLI"}
	case "qodercn":
		return []string{"Qoder CN CLI"}
	case "zcode":
		return []string{"ZCode CLI"}
	case "codebuddy":
		return []string{"CodeBuddy Code", "CodeBuddy CLI"}
	case "codebuddycn":
		return []string{"CodeBuddy CN Code", "CodeBuddy CN CLI"}
	case "gemini":
		return []string{"Gemini CLI"}
	case "grok":
		return []string{"Grok CLI"}
	case "cline":
		return []string{"Cline", "Cline CLI"}
	default:
		return nil
	}
}

func hasLiveWindowsDesktop(def providers.Definition, hasDef bool, ide *IDEClientSpec, winOpts Options) bool {
	if hasDef && def.CLI != nil && def.CLI.DesktopClient != nil && def.CLI.DesktopClient.Windows != nil {
		for _, rawInstall := range def.CLI.DesktopClient.Windows.InstallPaths {
			expanded := expandDesktopToken(rawInstall, winOpts)
			if expanded != "" && fileExists(expanded) {
				return true
			}
		}
	}
	if ide != nil {
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
				if ideRootHasLiveExecutable(candidateRoot, ide.WindowsExecutableNames) {
					return true
				}
			}
		}
	}
	return false
}

func hasLiveWindowsCLI(provider string, winOpts Options) bool {
	if provider == "codex" {
		p, err := resolveOfficialCodex(winOpts)
		return err == nil && strings.TrimSpace(p) != ""
	}
	return strings.TrimSpace(ResolveProviderCLIPath(provider, winOpts)) != ""
}

func normalizeWindowsExeBaseName(raw string) string {
	base := strings.TrimSpace(windowsBaseName(raw))
	if base == "" {
		return ""
	}
	if strings.ToLower(path.Ext(base)) != ".exe" {
		return ""
	}
	if isGenericWindowsExecutable(base) {
		return ""
	}
	return base
}

func normalizeCLIBinaryExeName(raw string) string {
	base := strings.TrimSpace(windowsBaseName(raw))
	if base == "" {
		return ""
	}
	ext := strings.ToLower(path.Ext(base))
	switch ext {
	case "":
		base += ".exe"
	case ".exe":
		// keep as-is
	default:
		return ""
	}
	if isGenericWindowsExecutable(base) {
		return ""
	}
	return base
}

func isGenericWindowsExecutable(base string) bool {
	switch strings.ToLower(strings.TrimSpace(base)) {
	case "", "electron.exe", "node.exe", "npm.exe", "npm.cmd", "npx.exe", "npx.cmd",
		"cmd.exe", "powershell.exe", "pwsh.exe", "update.exe", "msiexec.exe",
		"rundll32.exe", "explorer.exe", "wscript.exe", "cscript.exe", "conhost.exe",
		"wt.exe", "unins000.exe", "uninstall.exe", "setup.exe":
		return true
	default:
		return false
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
	home := ResolveHostHome(winOpts)
	env := resolveEnvMap(winOpts)
	sysRoot := nonEmpty(envLookup(env, "SystemRoot", "WINDIR"), `C:\Windows`)
	raw := []string{
		home,
		expandDesktopToken("{localAppData}", winOpts),
		expandDesktopToken("{localAppData}/Programs", winOpts),
		expandDesktopToken("{localAppData}/Microsoft", winOpts),
		expandDesktopToken("{localAppData}/Microsoft/WindowsApps", winOpts),
		expandDesktopToken("{appData}", winOpts),
		expandDesktopToken("{appData}/npm", winOpts),
		expandDesktopToken("{programFiles}", winOpts),
		expandDesktopToken("{programFiles}/nodejs", winOpts),
		expandDesktopToken("{programFilesX86}", winOpts),
		expandDesktopToken("{programFilesX86}/nodejs", winOpts),
		sysRoot,
		joinPlatformPath(platformWindows, sysRoot, "System32"),
		joinPlatformPath(platformWindows, sysRoot, "SysWOW64"),
	}
	if home != "" {
		raw = append(raw,
			joinPlatformPath(platformWindows, home, ".local"),
			joinPlatformPath(platformWindows, home, ".local", "bin"),
			joinPlatformPath(platformWindows, home, ".local", "share"),
			joinPlatformPath(platformWindows, home, "bin"),
			joinPlatformPath(platformWindows, home, ".bun"),
			joinPlatformPath(platformWindows, home, ".bun", "bin"),
		)
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
