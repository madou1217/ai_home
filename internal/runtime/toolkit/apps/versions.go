package apps

import (
	"context"
	"encoding/json"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

const timeSecond = time.Second

var (
	semverRe        = regexp.MustCompile(`v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?`)
	wingetVersionRe = regexp.MustCompile(`(?im)^\s*(?:Version|版本)\s*:\s*(\S+)`)
	plistShortRe    = regexp.MustCompile(`<key>\s*CFBundleShortVersionString\s*</key>\s*<string>([^<]+)</string>`)
	plistBundleRe   = regexp.MustCompile(`<key>\s*CFBundleVersion\s*</key>\s*<string>([^<]+)</string>`)
)

// NormalizeVersionString 解析并规范化主语义化版本号（major.minor.patch[-pre]）。
func NormalizeVersionString(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", false
	}
	m := semverRe.FindStringSubmatch(trimmed)
	if len(m) < 4 {
		return "", false
	}
	base := m[1] + "." + m[2] + "." + m[3]
	if m[4] != "" {
		return base + "-" + m[4], true
	}
	return base, true
}

// CompareVersions 比较两个语义化版本号，不可比时返回 nil。
func CompareVersions(leftRaw, rightRaw string) *int {
	lm := semverRe.FindStringSubmatch(strings.TrimSpace(leftRaw))
	rm := semverRe.FindStringSubmatch(strings.TrimSpace(rightRaw))
	if len(lm) < 4 || len(rm) < 4 {
		return nil
	}
	for i := 1; i <= 3; i++ {
		l, errL := strconv.Atoi(lm[i])
		r, errR := strconv.Atoi(rm[i])
		if errL != nil || errR != nil {
			return nil
		}
		if l != r {
			diff := 1
			if l < r {
				diff = -1
			}
			return &diff
		}
	}
	// 正式版高于同三段 pre-release。
	diff := 0
	if lm[4] == "" && rm[4] != "" {
		diff = 1
	} else if lm[4] != "" && rm[4] == "" {
		diff = -1
	} else if lm[4] != rm[4] {
		if lm[4] > rm[4] {
			diff = 1
		} else {
			diff = -1
		}
	}
	return &diff
}

func (m *Manager) versionCacheKey(kind, targetPath string, opts Options) string {
	return resolvePlatform(opts) + ":" + kind + ":" + strings.TrimSpace(targetPath)
}

func (m *Manager) getCachedVersion(kind, targetPath string, opts Options) (string, bool) {
	if m == nil {
		return "", false
	}
	key := m.versionCacheKey(kind, targetPath, opts)
	now := (&opts).nowTime()
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.versionCache[key]
	if !ok || now.Sub(entry.at) >= versionCacheTTL {
		return "", false
	}
	return entry.value, true
}

func (m *Manager) setCachedVersion(kind, targetPath, val string, opts Options) {
	if m == nil {
		return
	}
	key := m.versionCacheKey(kind, targetPath, opts)
	m.mu.Lock()
	m.versionCache[key] = versionEntry{at: (&opts).nowTime(), value: strings.TrimSpace(val)}
	m.mu.Unlock()
}

func (m *Manager) getDeferredCLIVersion(ctx context.Context, binaryPath string, opts Options) string {
	normPath := strings.TrimSpace(binaryPath)
	if normPath == "" {
		return ""
	}
	if opts.ProbeVersions == "sync" {
		val := probeCLIBinaryVersion(ctx, normPath, opts)
		m.setCachedVersion("binary", normPath, val, opts)
		if val == "" {
			return "未探测到"
		}
		return val
	}
	if val, ok := m.getCachedVersion("binary", normPath, opts); ok {
		if val == "" {
			return "未探测到"
		}
		return val
	}
	m.scheduleVersionProbe("binary", normPath, opts, func(probeCtx context.Context) string {
		return probeCLIBinaryVersion(probeCtx, normPath, opts)
	})
	return "探测中"
}

func (m *Manager) getDeferredDesktopVersion(ctx context.Context, rec *DesktopRecord, opts Options) string {
	if rec == nil {
		return ""
	}
	if strings.TrimSpace(rec.Version) != "" {
		if v, ok := NormalizeVersionString(rec.Version); ok {
			return v
		}
		return strings.TrimSpace(rec.Version)
	}
	target := nonEmpty(rec.BundlePath, nonEmpty(rec.ExecutablePath, rec.DisplayPath))
	if target == "" {
		return ""
	}
	if opts.ProbeVersions == "sync" {
		val := probeDesktopVersion(ctx, rec, opts)
		m.setCachedVersion("desktop", target, val, opts)
		return val
	}
	if val, ok := m.getCachedVersion("desktop", target, opts); ok {
		return val
	}
	m.scheduleVersionProbe("desktop", target, opts, func(probeCtx context.Context) string {
		return probeDesktopVersion(probeCtx, rec, opts)
	})
	return "探测中"
}

func (m *Manager) scheduleVersionProbe(kind, target string, opts Options, probe func(context.Context) string) {
	if m == nil {
		return
	}
	key := m.versionCacheKey(kind, target, opts)
	m.mu.Lock()
	if _, active := m.versionFlight[key]; active {
		m.mu.Unlock()
		return
	}
	m.versionFlight[key] = struct{}{}
	m.mu.Unlock()

	go func() {
		defer func() {
			m.mu.Lock()
			delete(m.versionFlight, key)
			m.mu.Unlock()
		}()
		probeCtx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		val := strings.TrimSpace(probe(probeCtx))
		m.setCachedVersion(kind, target, val, opts)
		m.MarkInventoryStale()
	}()
}

func probeCLIBinaryVersion(ctx context.Context, binaryPath string, opts Options) string {
	if strings.HasSuffix(strings.ToLower(binaryPath), ".cjs") {
		nodeBin := nonEmpty(opts.NodeExecPath, "node")
		res := opts.exec().Run(ctx, nodeBin, []string{binaryPath, "--version"}, environment.ExecOptions{Timeout: 3 * time.Second})
		if res.OK {
			if v, ok := NormalizeVersionString(res.Stdout + "\n" + res.Stderr); ok {
				return v
			}
		}
		return ""
	}
	for _, flag := range []string{"--version", "-v"} {
		res := opts.exec().Run(ctx, binaryPath, []string{flag}, environment.ExecOptions{Timeout: 3 * time.Second})
		if res.OK {
			if v, ok := NormalizeVersionString(res.Stdout + "\n" + res.Stderr); ok {
				return v
			}
		}
	}
	return ""
}

func probeDesktopVersion(ctx context.Context, rec *DesktopRecord, opts Options) string {
	if rec == nil {
		return ""
	}
	p := resolvePlatform(opts)
	if p == platformMacOS && rec.BundlePath != "" {
		if v := readMacAppBundleVersion(ctx, rec.BundlePath, opts); v != "" {
			return v
		}
	}
	if p == platformWindows && rec.ExecutablePath != "" {
		script := `(Get-Item -LiteralPath ` + powershellQuote(rec.ExecutablePath) + `).VersionInfo.ProductVersion`
		res := opts.exec().Run(ctx, windowsPowerShell, []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script}, environment.ExecOptions{Timeout: 3 * time.Second})
		if res.OK {
			if v, ok := NormalizeVersionString(res.Stdout); ok {
				return v
			}
		}
	}
	if rec.ExecutablePath != "" {
		res := opts.exec().Run(ctx, rec.ExecutablePath, []string{"--version"}, environment.ExecOptions{Timeout: 3 * time.Second})
		if res.OK {
			if v, ok := NormalizeVersionString(res.Stdout + "\n" + res.Stderr); ok {
				return v
			}
		}
	}
	return ""
}

func readMacAppBundleVersion(ctx context.Context, bundlePath string, opts Options) string {
	plistPath := joinPlatformPath(platformMacOS, bundlePath, "Contents", "Info.plist")
	if raw, err := os.ReadFile(plistPath); err == nil {
		text := string(raw)
		if m := plistShortRe.FindStringSubmatch(text); len(m) == 2 {
			return strings.TrimSpace(m[1])
		}
		if m := plistBundleRe.FindStringSubmatch(text); len(m) == 2 {
			return strings.TrimSpace(m[1])
		}
	}
	// 处理二进制 plist：用 plutil -convert xml1 -o - 抽取版本号。
	res := opts.exec().Run(ctx, "plutil", []string{"-convert", "xml1", "-o", "-", plistPath}, environment.ExecOptions{Timeout: 2 * time.Second})
	if res.OK {
		if m := plistShortRe.FindStringSubmatch(res.Stdout); len(m) == 2 {
			return strings.TrimSpace(m[1])
		}
		if m := plistBundleRe.FindStringSubmatch(res.Stdout); len(m) == 2 {
			return strings.TrimSpace(m[1])
		}
	}
	return ""
}

// CheckManagedAppUpdate 查询应用对应的官方远程最新版本并比较本地版本。
func (m *Manager) CheckManagedAppUpdate(ctx context.Context, app AppView, opts Options) UpdateCheckResult {
	var currentVer *string
	if parsed, ok := NormalizeVersionString(app.Version); ok {
		currentVer = &parsed
	}
	src := normalizeVersionSource(app.VersionSource)
	if src == nil && app.Pkg != "" {
		src = normalizeVersionSource(&VersionSource{Type: "npm", PackageName: app.Pkg})
	}
	base := UpdateCheckResult{
		OK:             true,
		AppID:          app.ID,
		Provider:       app.Provider,
		CurrentVersion: currentVer,
		Status:         "unavailable",
	}
	if src == nil {
		base.Error = "latest_version_source_unavailable"
		base.Message = "当前应用没有可验证的官方远程版本源。"
		return base
	}
	latest := m.getLatestVersion(ctx, *src, opts)
	if !latest.OK {
		base.OK = false
		base.Error = "latest_version_unavailable"
		base.Message = nonEmpty(latest.Error, "无法读取官方最新版")
		return base
	}
	latestVer := latest.LatestVersion
	base.LatestVersion = &latestVer
	var curStr string
	if currentVer != nil {
		curStr = *currentVer
	}
	cmp := CompareVersions(curStr, latestVer)
	if cmp == nil {
		base.Status = "unknown"
		return base
	}
	base.UpdateAvailable = *cmp < 0
	if base.UpdateAvailable {
		base.Status = "available"
	} else {
		base.Status = "current"
	}
	return base
}

func versionSourceCacheKey(src VersionSource) string {
	switch src.Type {
	case "npm":
		return "npm:" + strings.ToLower(src.PackageName)
	case "homebrew_cask":
		return "homebrew_cask:" + strings.ToLower(src.Cask)
	case "winget":
		return "winget:" + strings.ToLower(src.ID)
	default:
		return ""
	}
}

func (m *Manager) getLatestVersion(ctx context.Context, src VersionSource, opts Options) latestQueryResult {
	key := versionSourceCacheKey(src)
	if key == "" {
		return latestQueryResult{OK: false, Error: "unsupported_version_source"}
	}
	now := (&opts).nowTime()
	if m != nil {
		m.mu.Lock()
		if cached, ok := m.latestCache[key]; ok && now.Sub(cached.at) < latestVersionCacheTTL {
			m.mu.Unlock()
			return cached.value
		}
		if call := m.latestFlight[key]; call != nil {
			m.mu.Unlock()
			<-call.done
			return call.value
		}
		call := &latestCall{done: make(chan struct{})}
		m.latestFlight[key] = call
		m.mu.Unlock()

		res := queryRemoteLatestVersion(ctx, src, opts)
		m.mu.Lock()
		call.value = res
		m.latestCache[key] = latestEntry{at: (&opts).nowTime(), value: res}
		if m.latestFlight[key] == call {
			delete(m.latestFlight, key)
		}
		m.mu.Unlock()
		close(call.done)
		return res
	}
	return queryRemoteLatestVersion(ctx, src, opts)
}

func queryRemoteLatestVersion(ctx context.Context, src VersionSource, opts Options) latestQueryResult {
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = 12 * time.Second
	}
	execOpts := environment.ExecOptions{Timeout: timeout}
	switch src.Type {
	case "npm":
		cmd, userCfg := npmCommand(opts)
		res := opts.exec().Run(ctx, cmd, []string{"view", src.PackageName, "version", "--userconfig=" + userCfg, "--registry=" + NPMRegistry}, execOpts)
		if res.OK {
			if v, ok := NormalizeVersionString(res.Stdout); ok {
				return latestQueryResult{OK: true, LatestVersion: v}
			}
		}
		return latestQueryResult{OK: false, Error: nonEmpty(strings.TrimSpace(res.Stderr), nonEmpty(res.Message, "latest_version_unavailable"))}

	case "homebrew_cask":
		res := opts.exec().Run(ctx, "brew", []string{"info", "--cask", "--json=v2", src.Cask}, execOpts)
		if res.OK {
			if v := ParseHomebrewCaskVersion(res.Stdout); v != "" {
				return latestQueryResult{OK: true, LatestVersion: v}
			}
		}
		return latestQueryResult{OK: false, Error: nonEmpty(strings.TrimSpace(res.Stderr), nonEmpty(res.Message, "latest_version_unavailable"))}

	case "winget":
		cmd := "winget"
		if resolvePlatform(opts) == platformWindows {
			cmd = "winget.exe"
		}
		res := opts.exec().Run(ctx, cmd, []string{"show", "--id", src.ID, "--exact", "--source", "winget", "--accept-source-agreements", "--disable-interactivity"}, execOpts)
		if res.OK {
			if v := ParseWingetLatestVersion(res.Stdout + "\n" + res.Stderr); v != "" {
				return latestQueryResult{OK: true, LatestVersion: v}
			}
		}
		return latestQueryResult{OK: false, Error: nonEmpty(strings.TrimSpace(res.Stderr), nonEmpty(res.Message, "latest_version_unavailable"))}
	default:
		return latestQueryResult{OK: false, Error: "unsupported_version_source"}
	}
}

// ParseHomebrewCaskVersion 从 brew info --cask --json=v2 提取版本号。
func ParseHomebrewCaskVersion(output string) string {
	var parsed struct {
		Casks []struct {
			Version string `json:"version"`
		} `json:"casks"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(output)), &parsed) != nil || len(parsed.Casks) == 0 {
		return ""
	}
	v, _ := NormalizeVersionString(parsed.Casks[0].Version)
	return v
}

// ParseWingetLatestVersion 从 winget show 输出解析版本号。
func ParseWingetLatestVersion(output string) string {
	m := wingetVersionRe.FindStringSubmatch(output)
	if len(m) != 2 {
		return ""
	}
	v, _ := NormalizeVersionString(m[1])
	return v
}
