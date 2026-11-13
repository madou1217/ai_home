package apps

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/providerconfigs"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

func resolveCatalog(opts Options) *providers.Catalog {
	if opts.Catalog != nil {
		return opts.Catalog
	}
	cat, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil
	}
	return cat
}

func resolveProviderDefinition(cat *providers.Catalog, provider string) (providers.Definition, bool) {
	if cat == nil {
		return providers.Definition{}, false
	}
	return cat.Get(strings.ToLower(strings.TrimSpace(provider)))
}

// ResolveProviderCLIPath 解析原生 CLI 可执行文件绝对路径；保持各安装器优先目录顺序。
func ResolveProviderCLIPath(provider string, opts Options) string {
	norm := strings.ToLower(strings.TrimSpace(provider))
	if norm == "" {
		return ""
	}
	cat := resolveCatalog(opts)
	def, _ := resolveProviderDefinition(cat, norm)
	spec := getInstaller(norm)

	var binaryNames []string
	if spec != nil && spec.CLI != nil {
		binaryNames = append(binaryNames, spec.CLI.BinaryNames...)
	}
	if def.CLI != nil && def.CLI.BinaryName != "" {
		binaryNames = append(binaryNames, def.CLI.BinaryName)
	}
	binaryNames = append(binaryNames, norm)
	binaryNames = uniqueStrings(binaryNames)

	p := resolvePlatform(opts)
	var candidateDirs []string
	if spec != nil && spec.CLI != nil && spec.CLI.CollectPathEntries != nil {
		candidateDirs = append(candidateDirs, spec.CLI.CollectPathEntries(opts)...)
	}
	env := resolveEnvMap(opts)
	if rawPath := envLookup(env, "PATH", "Path"); rawPath != "" {
		sep := ":"
		if p == platformWindows {
			sep = ";"
		}
		for _, entry := range strings.Split(rawPath, sep) {
			if strings.TrimSpace(entry) != "" {
				candidateDirs = append(candidateDirs, strings.TrimSpace(entry))
			}
		}
	}
	if p != platformWindows {
		home := ResolveHostHome(opts)
		if home != "" {
			candidateDirs = append(candidateDirs, joinPlatformPath(p, home, ".local", "bin"), joinPlatformPath(p, home, "bin"))
		}
		candidateDirs = append(candidateDirs, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin")
	}
	candidateDirs = uniqueStrings(candidateDirs)

	// macOS 上的 Kiro bundle 同目录下同时有 kiro-cli 与 kiro-cli-chat 时优先选用 kiro-cli-chat。
	orderedNames := binaryNames
	if norm == "kiro" && p == platformMacOS {
		orderedNames = uniqueStrings(append([]string{"kiro-cli-chat"}, binaryNames...))
	}

	for _, dir := range candidateDirs {
		if path := findExecutableInDir(p, dir, orderedNames); path != "" {
			return preferKiroChatSibling(p, norm, path)
		}
	}

	if opts.LookPath != nil {
		for _, name := range orderedNames {
			if found, err := opts.LookPath(name); err == nil && strings.TrimSpace(found) != "" {
				return preferKiroChatSibling(p, norm, strings.TrimSpace(found))
			}
		}
	} else {
		for _, name := range orderedNames {
			if found, err := exec.LookPath(name); err == nil && strings.TrimSpace(found) != "" {
				return preferKiroChatSibling(p, norm, strings.TrimSpace(found))
			}
		}
	}
	return ""
}

func preferKiroChatSibling(platform, provider, candidate string) string {
	if provider != "kiro" || platform != platformMacOS || strings.HasSuffix(candidate, "kiro-cli-chat") {
		return candidate
	}
	sibling := joinPlatformPath(platform, dirPlatformPath(platform, candidate), "kiro-cli-chat")
	if isExecutableFile(platform, sibling) {
		return sibling
	}
	return candidate
}

func findExecutableInDir(platform, dir string, names []string) string {
	if !dirExists(dir) {
		// 如果 CollectPathEntries 指向的就是某个具体文件，直接校验该文件。
		if isExecutableFile(platform, dir) {
			return dir
		}
		return ""
	}
	exts := []string{""}
	if platform == platformWindows {
		exts = []string{"", ".exe", ".cmd", ".bat", ".ps1"}
	}
	for _, name := range names {
		for _, ext := range exts {
			target := joinPlatformPath(platform, dir, name+ext)
			if isExecutableFile(platform, target) {
				return target
			}
		}
	}
	return ""
}

func isExecutableFile(platform, target string) bool {
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		return false
	}
	if platform == platformWindows {
		return true
	}
	if strings.HasSuffix(strings.ToLower(target), ".cjs") {
		return true
	}
	return info.Mode().Perm()&0o111 != 0
}

func resolveDesktopConfig(def providers.Definition, platform string) *providers.DesktopPlatform {
	if def.CLI == nil || def.CLI.DesktopClient == nil {
		return nil
	}
	switch platform {
	case platformMacOS:
		return def.CLI.DesktopClient.MacOS
	case platformWindows:
		return def.CLI.DesktopClient.Windows
	case platformLinux:
		return def.CLI.DesktopClient.Linux
	default:
		return nil
	}
}

func expandDesktopToken(token string, opts Options) string {
	p := resolvePlatform(opts)
	home := ResolveHostHome(opts)
	env := resolveEnvMap(opts)
	localAppData := nonEmpty(envLookup(env, "LOCALAPPDATA"), joinPlatformPath(p, home, "AppData", "Local"))
	appData := nonEmpty(envLookup(env, "APPDATA"), joinPlatformPath(p, home, "AppData", "Roaming"))
	progFiles := nonEmpty(envLookup(env, "ProgramFiles", "PROGRAMFILES"), `C:\Program Files`)
	progFilesX86 := nonEmpty(envLookup(env, "ProgramFiles(x86)"), `C:\Program Files (x86)`)

	replacer := strings.NewReplacer(
		"{hostHomeDir}", home,
		"{localAppData}", localAppData,
		"{appData}", appData,
		"{programFiles}", progFiles,
		"{programFilesX86}", progFilesX86,
	)
	return strings.TrimSpace(replacer.Replace(token))
}

func desktopCandidateMatchesRecord(ctx context.Context, provider string, candidate string, cfg *providers.DesktopPlatform, opts Options) *DesktopRecord {
	if candidate == "" || !pathExists(candidate) {
		return nil
	}
	p := resolvePlatform(opts)
	info, err := os.Stat(candidate)
	if err != nil {
		return nil
	}
	clientName := nonEmpty(cfg.ClientName, provider)
	if info.IsDir() && p == platformMacOS && strings.HasSuffix(strings.ToLower(candidate), ".app") {
		execNames := uniqueStrings(append([]string{}, cfg.ExecNames...))
		execPath := ""
		for _, name := range execNames {
			pExec := joinPlatformPath(p, candidate, "Contents", "MacOS", name)
			if fileExists(pExec) {
				execPath = pExec
				break
			}
		}
		if execPath == "" {
			if entries, err := os.ReadDir(joinPlatformPath(p, candidate, "Contents", "MacOS")); err == nil {
				for _, entry := range entries {
					if !entry.IsDir() {
						execPath = joinPlatformPath(p, candidate, "Contents", "MacOS", entry.Name())
						break
					}
				}
			}
		}
		return &DesktopRecord{
			Provider:       provider,
			ClientName:     clientName,
			BundlePath:     candidate,
			DisplayPath:    candidate,
			ExecutablePath: nonEmpty(execPath, candidate),
			Version:        readMacAppBundleVersion(ctx, candidate, opts),
		}
	}
	if !info.IsDir() {
		return &DesktopRecord{
			Provider:       provider,
			ClientName:     clientName,
			ExecutablePath: candidate,
			DisplayPath:    candidate,
		}
	}
	_ = ctx
	return nil
}

// FindDesktopClientRecord 定位桌面应用（或 IDE）安装记录。
func FindDesktopClientRecord(ctx context.Context, provider string, opts Options) *DesktopRecord {
	norm := strings.ToLower(strings.TrimSpace(provider))
	if ide := getIDEClient(norm); ide != nil {
		return findIDEClientRecord(ctx, ide, opts)
	}
	p := resolvePlatform(opts)
	cat := resolveCatalog(opts)
	def, ok := resolveProviderDefinition(cat, norm)
	if !ok {
		return nil
	}
	cfg := resolveDesktopConfig(def, p)
	if cfg == nil {
		return nil
	}

	if installed := strings.TrimSpace(opts.InstalledPath); installed != "" {
		if rec := desktopCandidateMatchesRecord(ctx, norm, installed, cfg, opts); rec != nil {
			return rec
		}
	}

	if p == platformWindows {
		if rec := findWindowsRegisteredDesktopClient(ctx, norm, cfg, opts); rec != nil {
			return rec
		}
	}

	for _, raw := range cfg.InstallPaths {
		candidate := expandDesktopToken(raw, opts)
		if rec := desktopCandidateMatchesRecord(ctx, norm, candidate, cfg, opts); rec != nil {
			return rec
		}
	}

	if p == platformMacOS {
		if bundle := findMacDesktopBundle(cfg, opts); bundle != "" {
			if rec := desktopCandidateMatchesRecord(ctx, norm, bundle, cfg, opts); rec != nil {
				return rec
			}
		}
	}

	if p == platformWindows || p == platformLinux {
		resolver := "which"
		if p == platformWindows {
			resolver = "where.exe"
		}
		for _, execName := range cfg.ExecNames {
			res := opts.exec().Run(ctx, resolver, []string{execName}, environment.ExecOptions{Timeout: 3 * timeSecond})
			if !res.OK {
				continue
			}
			for _, line := range strings.Split(res.Stdout, "\n") {
				cand := strings.TrimSpace(line)
				if cand != "" && fileExists(cand) {
					return &DesktopRecord{
						Provider:       norm,
						ClientName:     nonEmpty(cfg.ClientName, execName),
						ExecutablePath: cand,
						DisplayPath:    cand,
					}
				}
			}
		}
	}
	return nil
}

func findMacDesktopBundle(cfg *providers.DesktopPlatform, opts Options) string {
	home := ResolveHostHome(opts)
	roots := []string{"/Applications"}
	if home != "" {
		roots = append(roots, joinPlatformPath(platformMacOS, home, "Applications"))
	}
	var patterns []string
	for _, raw := range cfg.PathIncludes {
		if trimmed := strings.ToLower(strings.TrimSpace(raw)); trimmed != "" {
			patterns = append(patterns, trimmed)
		}
	}
	if cfg.ClientName != "" {
		patterns = append(patterns, strings.ToLower(strings.TrimSpace(cfg.ClientName)))
	}
	for _, root := range roots {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), ".app") {
				continue
			}
			lowerName := strings.ToLower(entry.Name())
			for _, pat := range patterns {
				if strings.Contains(lowerName, pat) {
					full := joinPlatformPath(platformMacOS, root, entry.Name())
					return full
				}
			}
		}
	}
	return ""
}

func findWindowsRegisteredDesktopClient(ctx context.Context, provider string, cfg *providers.DesktopPlatform, opts Options) *DesktopRecord {
	if len(cfg.DisplayNames) == 0 {
		return nil
	}
	var quoted []string
	for _, name := range cfg.DisplayNames {
		if strings.TrimSpace(name) != "" {
			quoted = append(quoted, powershellQuote(strings.TrimSpace(name)))
		}
	}
	if len(quoted) == 0 {
		return nil
	}
	script := "$names = @(" + strings.Join(quoted, ", ") + `); $roots = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'); $entry = Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue | Where-Object { $d = [string]$_.DisplayName; $names | Where-Object { $d -eq $_ -or $d -like ('*' + $_ + '*') } } | Select-Object -First 1; if ($entry) { [pscustomobject]@{ InstallLocation=[string]$entry.InstallLocation; DisplayIcon=[string]$entry.DisplayIcon; DisplayVersion=[string]$entry.DisplayVersion } | ConvertTo-Json -Compress }`
	res := opts.exec().Run(ctx, windowsPowerShell, []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script}, environment.ExecOptions{Timeout: 3 * timeSecond})
	if !res.OK || strings.TrimSpace(res.Stdout) == "" {
		return nil
	}
	var parsed struct {
		InstallLocation string `json:"InstallLocation"`
		DisplayIcon     string `json:"DisplayIcon"`
		DisplayVersion  string `json:"DisplayVersion"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &parsed); err != nil {
		return nil
	}
	iconPath := strings.Trim(strings.Split(parsed.DisplayIcon, ",")[0], `" `)
	for _, execName := range cfg.ExecNames {
		if parsed.InstallLocation != "" {
			cand := joinPlatformPath(platformWindows, parsed.InstallLocation, execName)
			if fileExists(cand) {
				return &DesktopRecord{Provider: provider, ClientName: nonEmpty(cfg.ClientName, provider), ExecutablePath: cand, DisplayPath: cand, Version: strings.TrimSpace(parsed.DisplayVersion)}
			}
		}
	}
	if iconPath != "" && fileExists(iconPath) && strings.HasSuffix(strings.ToLower(iconPath), ".exe") {
		return &DesktopRecord{Provider: provider, ClientName: nonEmpty(cfg.ClientName, provider), ExecutablePath: iconPath, DisplayPath: iconPath, Version: strings.TrimSpace(parsed.DisplayVersion)}
	}
	return nil
}

func findIDEClientRecord(ctx context.Context, client *IDEClientSpec, opts Options) *DesktopRecord {
	p := resolvePlatform(opts)
	home := ResolveHostHome(opts)
	env := resolveEnvMap(opts)
	if home == "" {
		return nil
	}
	var candidates []string
	switch p {
	case platformMacOS:
		for _, bundle := range client.MacBundleNames {
			candidates = append(candidates, joinPlatformPath(p, "/Applications", bundle), joinPlatformPath(p, home, "Applications", bundle))
		}
	case platformWindows:
		localAppData := nonEmpty(envLookup(env, "LOCALAPPDATA"), joinPlatformPath(p, home, "AppData", "Local"))
		progFiles := envLookup(env, "ProgramFiles")
		roots := uniqueStrings([]string{joinPlatformPath(p, localAppData, "Programs"), progFiles, joinPlatformPath(p, home, "AppData", "Local", "Programs")})
		for _, r := range roots {
			for _, pn := range client.WindowsProgramNames {
				for _, en := range client.WindowsExecutableNames {
					candidates = append(candidates, joinPlatformPath(p, r, pn, en))
				}
			}
		}
	default:
		for _, en := range client.LinuxExecutableNames {
			candidates = append(candidates, joinPlatformPath(p, "/usr/bin", en), joinPlatformPath(p, "/usr/local/bin", en), joinPlatformPath(p, home, ".local", "bin", en))
		}
	}
	for _, cand := range uniqueStrings(candidates) {
		if !pathExists(cand) {
			continue
		}
		if p == platformMacOS {
			execPath := ""
			for _, en := range client.MacExecutableNames {
				probe := joinPlatformPath(p, cand, "Contents", "MacOS", en)
				if fileExists(probe) {
					execPath = probe
					break
				}
			}
			if execPath == "" && len(client.MacExecutableNames) > 0 {
				execPath = joinPlatformPath(p, cand, "Contents", "MacOS", client.MacExecutableNames[0])
			}
			return &DesktopRecord{
				Provider:       client.ID,
				ClientName:     client.Name,
				BundlePath:     cand,
				DisplayPath:    cand,
				ExecutablePath: execPath,
				Version:        readMacAppBundleVersion(ctx, cand, opts),
			}
		}
		return &DesktopRecord{Provider: client.ID, ClientName: client.Name, ExecutablePath: cand, DisplayPath: cand}
	}
	return nil
}

func resolveIDEExtensionRoots(client *IDEClientSpec, opts Options) []string {
	home := ResolveHostHome(opts)
	p := resolvePlatform(opts)
	env := resolveEnvMap(opts)
	if client == nil || home == "" {
		return nil
	}
	roots := []string{joinPlatformPath(p, home, "."+client.ID, "extensions")}
	if client.RemoteServerDirName != "" {
		roots = append(roots, joinPlatformPath(p, home, client.RemoteServerDirName, "extensions"))
	}
	appData := envLookup(env, "APPDATA")
	if p == platformWindows && appData != "" {
		roots = append(roots, joinPlatformPath(p, appData, client.ConfigDirectoryName, "User", "extensions"))
	}
	if p == platformMacOS {
		roots = append(roots, joinPlatformPath(p, home, "Library", "Application Support", client.ConfigDirectoryName, "User", "extensions"))
	}
	return uniqueStrings(roots)
}

var compactAlphaNumRe = regexp.MustCompile(`[^a-z0-9]+`)

func compactExtensionText(value string) string {
	return compactAlphaNumRe.ReplaceAllString(strings.ToLower(strings.TrimSpace(value)), "")
}

func extensionTextTokens(value string) []string {
	parts := compactAlphaNumRe.Split(strings.ToLower(strings.TrimSpace(value)), -1)
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func discoverIDEIntegrationProviders(client *IDEClientSpec, cat *providers.Catalog, opts Options) []string {
	if client == nil || cat == nil {
		return nil
	}
	defs := cat.List()
	detected := make(map[string]struct{})
	for _, root := range resolveIDEExtensionRoots(client, opts) {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			dirName := entry.Name()
			manifestPath := filepath.Join(root, dirName, "package.json")
			var parts []string
			parts = append(parts, dirName)
			if raw, err := os.ReadFile(manifestPath); err == nil {
				var m struct {
					Name        string   `json:"name"`
					Publisher   string   `json:"publisher"`
					DisplayName string   `json:"displayName"`
					Description string   `json:"description"`
					Keywords    []string `json:"keywords"`
				}
				if json.Unmarshal(raw, &m) == nil {
					parts = append(parts, m.Name, m.Publisher, m.DisplayName, m.Description)
					parts = append(parts, m.Keywords...)
				}
			}
			extText := strings.Join(parts, " ")
			compactText := compactExtensionText(extText)
			tokens := extensionTextTokens(extText)
			for _, def := range defs {
				if extensionMatchesProvider(def, compactText, tokens) {
					detected[def.ID] = struct{}{}
				}
			}
		}
	}
	var out []string
	for _, def := range defs {
		if _, ok := detected[def.ID]; ok {
			out = append(out, def.ID)
		}
	}
	return out
}

func extensionMatchesProvider(def providers.Definition, compactText string, tokens []string) bool {
	aliases := uniqueStrings([]string{def.ID, def.Presentation.Label})
	for _, raw := range aliases {
		compact := compactExtensionText(raw)
		if len(compact) < 4 {
			continue
		}
		if strings.Contains(compactText, compact) {
			return true
		}
		for _, tok := range tokens {
			if tok == compact {
				return true
			}
		}
	}
	return false
}

// GetProviderConfigPath 解析 CLI/Desktop/IDE 主配置文件路径。
func GetProviderConfigPath(provider string, cat *providers.Catalog, opts Options) string {
	norm := strings.ToLower(strings.TrimSpace(provider))
	home := ResolveHostHome(opts)
	if home == "" || norm == "" {
		return ""
	}
	p := resolvePlatform(opts)
	env := resolveEnvMap(opts)
	appData := nonEmpty(envLookup(env, "APPDATA"), joinPlatformPath(p, home, "AppData", "Roaming"))
	configHome := nonEmpty(envLookup(env, "XDG_CONFIG_HOME"), joinPlatformPath(p, home, ".config"))
	if p == platformWindows && envLookup(env, "XDG_CONFIG_HOME") == "" {
		configHome = appData
	}

	if ide := getIDEClient(norm); ide != nil {
		if p == platformMacOS {
			return joinPlatformPath(p, home, "Library", "Application Support", ide.ConfigDirectoryName, "User", "settings.json")
		}
		if p == platformWindows {
			return joinPlatformPath(p, appData, ide.ConfigDirectoryName, "User", "settings.json")
		}
		return joinPlatformPath(p, configHome, ide.ConfigDirectoryName, "User", "settings.json")
	}

	if def, ok := resolveProviderDefinition(cat, norm); ok && def.CLI != nil {
		globalDir := strings.Trim(strings.TrimSpace(def.CLI.GlobalDir), "/\\")
		if globalDir == "" {
			globalDir = "." + norm
		}
		segs := strings.FieldsFunc(globalDir, func(r rune) bool { return r == '/' || r == '\\' })
		var root string
		if len(segs) > 0 && segs[0] == ".config" {
			parts := append([]string{configHome}, segs[1:]...)
			root = joinPlatformPath(p, parts...)
		} else {
			parts := append([]string{home}, segs...)
			root = joinPlatformPath(p, parts...)
		}
		if sub := strings.TrimSpace(def.CLI.ConfigSubDir); sub != "" {
			subSegs := strings.FieldsFunc(sub, func(r rune) bool { return r == '/' || r == '\\' })
			root = joinPlatformPath(p, append([]string{root}, subSegs...)...)
		}
		if file := strings.TrimSpace(def.CLI.ConfigFile); file != "" {
			return joinPlatformPath(p, root, file)
		}
		return root
	}

	if strings.HasSuffix(norm, "-desktop") {
		baseProvider := strings.TrimSuffix(norm, "-desktop")
		if spec := getInstaller(baseProvider); spec != nil && spec.DesktopConfigPath != nil {
			return spec.DesktopConfigPath(p, home, configHome)
		}
	}
	return joinPlatformPath(p, home, "."+norm)
}

func configFormatForPath(target string) string {
	raw := strings.TrimSpace(target)
	base := strings.ToLower(basePlatformPath("", raw))
	if base == ".env" || strings.HasPrefix(base, ".env.") {
		return "dotenv"
	}
	ext := strings.ToLower(filepath.Ext(base))
	switch ext {
	case ".toml":
		return "toml"
	case ".jsonc":
		return "jsonc"
	case ".json":
		return "json"
	case ".yaml", ".yml":
		return "yaml"
	case ".ini", ".properties":
		return "ini"
	case ".sh", ".bash", ".zsh":
		return "shellscript"
	default:
		if strings.HasPrefix(ext, ".") && len(ext) > 1 {
			return ext[1:]
		}
		return "text"
	}
}

func countProviderConfigFiles(ctx context.Context, cat *providers.Catalog, hostHome, aiHome string) map[string]int {
	counts := make(map[string]int)
	if cat == nil {
		return counts
	}
	resp := providerconfigs.NewService(cat, hostHome, aiHome).ListProviders(ctx, false)
	for _, p := range resp.Providers {
		counts[p.ID] = len(p.Files)
	}
	return counts
}

// ListManagedApps 返回工具箱内全部 CLI / Desktop / IDE 应用状态，并带短期 SWR 缓存。
func (m *Manager) ListManagedApps(ctx context.Context, opts Options) ListResult {
	shouldCache := (opts.CacheInventory == nil || *opts.CacheInventory) &&
		!opts.RefreshInventory &&
		opts.ProbeVersions != "sync"
	if !shouldCache {
		return m.buildManagedApps(ctx, opts)
	}
	key := m.inventoryCacheKey(opts)
	now := (&opts).nowTime()

	m.mu.Lock()
	cached, hasCached := m.inventoryCache[key]
	if hasCached && now.Sub(cached.at) < inventoryCacheTTL {
		m.mu.Unlock()
		return cached.value
	}
	inFlight := m.inventoryFlight[key]
	if hasCached && now.Sub(cached.at) < inventoryCacheMaxStale {
		if inFlight == nil {
			m.startInventoryBuildLocked(key, opts)
		}
		m.mu.Unlock()
		return cached.value
	}
	if inFlight == nil {
		inFlight = m.startInventoryBuildLocked(key, opts)
	}
	m.mu.Unlock()

	select {
	case <-inFlight.done:
		return inFlight.value
	case <-ctx.Done():
		return m.buildManagedApps(ctx, opts)
	}
}

func (m *Manager) startInventoryBuildLocked(key string, opts Options) *inventoryCall {
	call := &inventoryCall{done: make(chan struct{})}
	m.inventoryFlight[key] = call
	go func() {
		defer close(call.done)
		val := m.buildManagedApps(context.Background(), opts)
		m.mu.Lock()
		call.value = val
		m.inventoryCache[key] = inventoryEntry{at: (&opts).nowTime(), value: val}
		if m.inventoryFlight[key] == call {
			delete(m.inventoryFlight, key)
		}
		m.mu.Unlock()
	}()
	return call
}

// InvalidateCache 清空或按 key 失效应用清单缓存（写操作/作业完成时调用）。
func (m *Manager) InvalidateCache(cacheKey string) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if strings.TrimSpace(cacheKey) == "" {
		clear(m.inventoryCache)
		return
	}
	delete(m.inventoryCache, strings.TrimSpace(cacheKey))
}

// MarkInventoryStale 将清单缓存标记为过期以触发下次请求后台重建。
func (m *Manager) MarkInventoryStale() {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	cutoff := time.Now().Add(-inventoryCacheTTL)
	for k, entry := range m.inventoryCache {
		if entry.at.After(cutoff) {
			entry.at = cutoff
			m.inventoryCache[k] = entry
		}
	}
}

func (m *Manager) inventoryCacheKey(opts Options) string {
	if explicit := strings.TrimSpace(opts.InventoryCacheKey); explicit != "" {
		return explicit
	}
	env := resolveEnvMap(opts)
	b, _ := json.Marshal(struct {
		Platform string `json:"platform"`
		Home     string `json:"home"`
		AppData  string `json:"appData"`
		Config   string `json:"configHome"`
	}{
		Platform: resolvePlatform(opts),
		Home:     ResolveHostHome(opts),
		AppData:  envLookup(env, "APPDATA"),
		Config:   envLookup(env, "XDG_CONFIG_HOME"),
	})
	return string(b)
}

func (m *Manager) buildManagedApps(ctx context.Context, opts Options) ListResult {
	cat := resolveCatalog(opts)
	p := resolvePlatform(opts)
	home := ResolveHostHome(opts)
	configCounts := countProviderConfigFiles(ctx, cat, home, opts.AIHomeDir)

	var defs []providers.Definition
	defMap := make(map[string]providers.Definition)
	if cat != nil {
		defs = cat.List()
		for _, d := range defs {
			defMap[d.ID] = d
		}
	}

	var cliOrder []struct {
		id    string
		order int
	}
	seenCLI := make(map[string]struct{})
	for _, d := range defs {
		if d.Clients.CLI && d.CLI != nil {
			seenCLI[d.ID] = struct{}{}
			cliOrder = append(cliOrder, struct {
				id    string
				order int
			}{id: d.ID, order: d.CLI.Order})
		}
	}
	sort.Slice(cliOrder, func(i, j int) bool {
		if cliOrder[i].order != cliOrder[j].order {
			return cliOrder[i].order < cliOrder[j].order
		}
		return cliOrder[i].id < cliOrder[j].id
	})
	cliList := make([]string, 0, len(cliOrder)+2)
	for _, item := range cliOrder {
		cliList = append(cliList, item.id)
	}
	for _, standalone := range listStandaloneApps() {
		if _, exists := seenCLI[standalone.ID]; !exists {
			cliList = append(cliList, standalone.ID)
		}
	}

	var resultApps []AppView
	for _, providerID := range cliList {
		def := defMap[providerID]
		spec := getInstaller(providerID)
		var standalone *StandaloneAppSpec
		if spec != nil {
			standalone = spec.ManagedApp
		}
		binaryName := providerID
		pkg := ""
		if def.CLI != nil {
			if def.CLI.BinaryName != "" {
				binaryName = def.CLI.BinaryName
			}
			pkg = def.CLI.Package
		}
		if standalone != nil {
			if standalone.BinaryName != "" {
				binaryName = standalone.BinaryName
			}
			if standalone.Pkg != "" {
				pkg = standalone.Pkg
			}
		}

		cliPath := ResolveProviderCLIPath(providerID, opts)
		installed := cliPath != ""
		ver := ""
		if installed {
			ver = m.getDeferredCLIVersion(ctx, cliPath, opts)
		}
		cfgPath := ""
		if def.ID != "" || standalone != nil {
			cfgPath = GetProviderConfigPath(providerID, cat, opts)
		}
		cfgExists := cfgPath != "" && pathExists(cfgPath)
		hookDiag := DiagnoseProviderHooks(ctx, providerID, cat, opts)

		categories := []string{"ALL", "CLI Code"}
		if standalone != nil {
			categories = append(categories, standalone.Categories...)
		}
		categories = uniqueStrings(categories)

		label := nonEmpty(def.Presentation.Label, "")
		if label == "" && standalone != nil {
			label = nonEmpty(standalone.ClientName, standalone.Name)
		}
		if label == "" {
			label = providerID
		}
		displayName := label
		if standalone != nil && standalone.Name != "" {
			displayName = standalone.Name
		}

		syncMode := hookDiag.SyncMode
		if syncMode == "" {
			syncMode = "polling"
		}
		missingEvents := hookDiag.MissingEvents
		if missingEvents == nil {
			missingEvents = []string{}
		}

		canUpdate := len(ResolveLifecyclePlans(providerID, "cli", "update", opts, cliPath, nil)) > 0
		canUninstall := len(ResolveLifecyclePlans(providerID, "cli", "uninstall", opts, cliPath, nil)) > 0

		resultApps = append(resultApps, AppView{
			ID:                providerID,
			Name:              displayName,
			Provider:          providerID,
			ClientID:          providerID,
			ClientName:        label,
			Type:              "cli",
			Categories:        categories,
			BinaryName:        binaryName,
			CLIPath:           cliPath,
			ConfigExists:      cfgExists,
			ConfigFileCount:   configCounts[providerID],
			ConfigName:        basePlatformPath(p, cfgPath),
			ConfigFormat:      configFormatForPath(cfgPath),
			Installed:         installed,
			Version:           nonEmpty(ver, ternaryStr(installed, "未探测到", "-")),
			VersionSource:     ResolveCLIVersionSource(providerID, pkg, opts),
			Pkg:               pkg,
			DefaultModel:      "",
			SupportedModels:   []string{},
			HookSupported:     hookDiag.Supported,
			HookInstalled:     hookDiag.Installed,
			SyncMode:          syncMode,
			HookReason:        hookDiag.Reason,
			HookMissingEvents: missingEvents,
			InstallAvailable:  isCLIInstallSupported(providerID),
			CanUpdate:         canUpdate,
			CanUninstall:      canUninstall,
		})
	}

	// Desktop 应用与 IDE 客户端
	for _, d := range defs {
		desktopCfg := resolveDesktopConfig(d, p)
		if !d.Clients.Desktop || desktopCfg == nil {
			continue
		}
		label := nonEmpty(d.Presentation.Label, d.ID)
		clientName := nonEmpty(desktopCfg.ClientName, label)
		appID := d.ID + "-desktop"
		rec := FindDesktopClientRecord(ctx, d.ID, opts)
		cfgPath := GetProviderConfigPath(appID, cat, opts)
		installed := rec != nil
		ver := m.getDeferredDesktopVersion(ctx, rec, opts)
		dispPath := ""
		binName := clientName
		if rec != nil {
			dispPath = rec.DisplayPath
			if dispPath != "" {
				binName = basePlatformPath(p, dispPath)
			}
		}
		hostLaunchLabel := ""
		if d.ID == "claude" {
			hostLaunchLabel = "通过 AIH Server 打开"
		}
		resultApps = append(resultApps, AppView{
			ID:                appID,
			Name:              clientName,
			Provider:          d.ID,
			ClientID:          appID,
			ClientName:        clientName,
			ConfigProvider:    d.ID,
			Type:              "desktop",
			Categories:        []string{"ALL", "Desktop"},
			BinaryName:        binName,
			CLIPath:           dispPath,
			ConfigExists:      cfgPath != "" && pathExists(cfgPath),
			ConfigFileCount:   configCounts[d.ID],
			ConfigName:        basePlatformPath(p, cfgPath),
			ConfigFormat:      configFormatForPath(cfgPath),
			Installed:         installed,
			Version:           nonEmpty(ver, ternaryStr(installed, "未探测到", "-")),
			VersionSource:     ResolveDesktopVersionSource(d.ID, opts),
			DefaultModel:      "-",
			SupportedModels:   []string{},
			HookSupported:     false,
			HookInstalled:     false,
			SyncMode:          "unavailable",
			HookMissingEvents: []string{},
			InstallAvailable:  HasDesktopInstallPlan(d.ID, opts),
			CanUpdate:         len(ResolveLifecyclePlans(d.ID, "desktop", "update", opts, "", rec)) > 0,
			CanUninstall:      len(ResolveLifecyclePlans(d.ID, "desktop", "uninstall", opts, "", rec)) > 0,
			HostLaunchLabel:   hostLaunchLabel,
		})
	}

	for _, ide := range listIDEClients() {
		rec := FindDesktopClientRecord(ctx, ide.ID, opts)
		cfgPath := GetProviderConfigPath(ide.ID, cat, opts)
		installed := rec != nil
		ver := m.getDeferredDesktopVersion(ctx, rec, opts)
		dispPath := ""
		binName := ide.BinaryName
		if rec != nil {
			dispPath = rec.DisplayPath
			if dispPath != "" {
				binName = basePlatformPath(p, dispPath)
			}
		}
		integrations := discoverIDEIntegrationProviders(ide, cat, opts)
		if integrations == nil {
			integrations = []string{}
		}
		resultApps = append(resultApps, AppView{
			ID:                   ide.ID,
			Name:                 ide.Name,
			Provider:             ide.ID,
			ClientID:             ide.ID,
			ClientName:           ide.Name,
			ConfigProvider:       ide.ID,
			Type:                 "ide",
			Categories:           []string{"ALL", "IDE"},
			BinaryName:           binName,
			CLIPath:              dispPath,
			ConfigExists:         cfgPath != "" && pathExists(cfgPath),
			ConfigFileCount:      configCounts[ide.ID],
			ConfigName:           basePlatformPath(p, cfgPath),
			ConfigFormat:         configFormatForPath(cfgPath),
			Installed:            installed,
			Version:              nonEmpty(ver, ternaryStr(installed, "未探测到", "-")),
			VersionSource:        ResolveDesktopVersionSource(ide.ID, opts),
			DefaultModel:         "-",
			SupportedModels:      []string{},
			HookSupported:        false,
			HookInstalled:        false,
			SyncMode:             "unavailable",
			HookMissingEvents:    []string{},
			InstallAvailable:     HasDesktopInstallPlan(ide.ID, opts),
			CanUpdate:            len(ResolveLifecyclePlans(ide.ID, "desktop", "update", opts, "", rec)) > 0,
			CanUninstall:         len(ResolveLifecyclePlans(ide.ID, "desktop", "uninstall", opts, "", rec)) > 0,
			IntegrationProviders: integrations,
		})
	}

	installedCount := 0
	for _, item := range resultApps {
		if item.Installed {
			installedCount++
		}
	}
	return ListResult{
		OK:             true,
		Total:          len(resultApps),
		InstalledCount: installedCount,
		Apps:           resultApps,
	}
}

// RefreshManagedAppVersion 仅针对单个 appId 做同步本地版本探测，不拖慢全量列表。
func (m *Manager) RefreshManagedAppVersion(ctx context.Context, appID string, opts Options) RefreshVersionResult {
	norm := strings.TrimSpace(appID)
	invOpts := opts
	invOpts.ProbeVersions = ""
	inv := m.ListManagedApps(ctx, invOpts)
	var found *AppView
	for i := range inv.Apps {
		if inv.Apps[i].ID == norm {
			copyItem := inv.Apps[i]
			found = &copyItem
			break
		}
	}
	if found == nil {
		return RefreshVersionResult{OK: false, Error: "app_not_found", AppID: norm}
	}

	syncOpts := opts
	syncOpts.ProbeVersions = "sync"
	var version string
	if found.Type == "cli" && found.CLIPath != "" {
		version = m.getDeferredCLIVersion(ctx, found.CLIPath, syncOpts)
	} else if found.Type == "desktop" || found.Type == "ide" {
		rec := FindDesktopClientRecord(ctx, found.Provider, syncOpts)
		version = m.getDeferredDesktopVersion(ctx, rec, syncOpts)
		if rec != nil {
			found.CLIPath = rec.DisplayPath
			if rec.DisplayPath != "" {
				found.BinaryName = basePlatformPath(resolvePlatform(syncOpts), rec.DisplayPath)
			}
		}
	}
	cleanVer := ""
	if parsed, ok := NormalizeVersionString(version); ok {
		cleanVer = parsed
	} else if version != "" && version != "未探测到" && version != "探测中" && version != "-" {
		cleanVer = version
	}
	found.Version = nonEmpty(version, ternaryStr(found.Installed, "未探测到", "-"))
	var currentPtr *string
	if cleanVer != "" {
		currentPtr = &cleanVer
	}
	return RefreshVersionResult{
		OK:             true,
		App:            found,
		CurrentVersion: currentPtr,
	}
}

func ternaryStr(cond bool, yes, no string) string {
	if cond {
		return yes
	}
	return no
}
