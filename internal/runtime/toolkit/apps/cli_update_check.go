package apps

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// cliLatestVersionTTL 是成功查询「远程最新版本」后的复用窗口。启动路径每次
	// 都去 npm/brew 查询会拖慢交互启动，这里按天缓存。
	cliLatestVersionTTL = 24 * time.Hour
	// cliLatestVersionRetryAfter 是查询失败后的退避窗口：网络不可用时不要每次
	// 启动都等待超时。
	cliLatestVersionRetryAfter = 6 * time.Hour
)

// CLIUpdateStatus 是一次启动前的 CLI 版本检查结果。
type CLIUpdateStatus struct {
	Provider        string
	CurrentVersion  string
	LatestVersion   string
	UpdateAvailable bool
}

type cliVersionCache struct {
	Latest  map[string]cliLatestEntry  `json:"latest"`
	Current map[string]cliCurrentEntry `json:"current"`
}

type cliLatestEntry struct {
	Version   string `json:"version"`
	CheckedAt int64  `json:"checkedAt"`
}

type cliCurrentEntry struct {
	Version   string `json:"version"`
	Size      int64  `json:"size"`
	ModTime   int64  `json:"modTime"`
	CheckedAt int64  `json:"checkedAt"`
}

// CheckCLIUpdate 探测已安装 CLI 的实际版本与官方远程最新版本。
//
// 只在能给出确定事实时返回 ok=true：未安装、无法探测版本或没有可比较的版本源
// （例如 agy 只有安装脚本）都会静默返回 false，绝不猜版本。
func CheckCLIUpdate(ctx context.Context, provider string, opts Options) (CLIUpdateStatus, bool) {
	norm := strings.ToLower(strings.TrimSpace(provider))
	if norm == "" || ctx == nil {
		return CLIUpdateStatus{}, false
	}
	if err := ctx.Err(); err != nil {
		return CLIUpdateStatus{}, false
	}
	installed := ResolveProviderCLIPath(norm, opts)
	if installed == "" {
		return CLIUpdateStatus{}, false
	}
	current := cliCurrentVersion(ctx, installed, opts)
	if current == "" {
		return CLIUpdateStatus{}, false
	}
	source := ResolveCLIVersionSource(norm, "", opts)
	if source == nil {
		return CLIUpdateStatus{}, false
	}
	latest := cliLatestVersion(ctx, *source, opts)
	if latest == "" {
		return CLIUpdateStatus{}, false
	}
	return composeCLIUpdateStatus(norm, current, latest), true
}

// CachedCLIUpdateStatus 与 CheckCLIUpdate 判定相同，但只读本地缓存：
// 不访问网络、也不启动 CLI 探测版本。用于交互式启动前的零延迟提示。
func CachedCLIUpdateStatus(provider string, opts Options) (CLIUpdateStatus, bool) {
	norm := strings.ToLower(strings.TrimSpace(provider))
	if norm == "" {
		return CLIUpdateStatus{}, false
	}
	installed := ResolveProviderCLIPath(norm, opts)
	if installed == "" {
		return CLIUpdateStatus{}, false
	}
	info, statErr := os.Stat(installed)
	if statErr != nil {
		return CLIUpdateStatus{}, false
	}
	cache := readCLIVersionCache(opts)
	currentEntry, found := cache.Current[installed]
	if !found || currentEntry.Size != info.Size() || currentEntry.ModTime != info.ModTime().UnixNano() {
		return CLIUpdateStatus{}, false
	}
	current, valid := NormalizeVersionString(currentEntry.Version)
	if !valid {
		return CLIUpdateStatus{}, false
	}
	source := ResolveCLIVersionSource(norm, "", opts)
	if source == nil {
		return CLIUpdateStatus{}, false
	}
	key := versionSourceCacheKey(*source)
	latestEntry, found := cache.Latest[key]
	if !found || latestEntry.Version == "" {
		return CLIUpdateStatus{}, false
	}
	// 过期缓存不再用来提示：后台刷新失败时不能反复展示旧版本。
	age := time.Duration(nowUnix(opts)-latestEntry.CheckedAt) * time.Second
	if age >= cliLatestVersionTTL {
		return CLIUpdateStatus{}, false
	}
	latest, valid := NormalizeVersionString(latestEntry.Version)
	if !valid {
		return CLIUpdateStatus{}, false
	}
	return composeCLIUpdateStatus(norm, current, latest), true
}

func composeCLIUpdateStatus(provider, current, latest string) CLIUpdateStatus {
	status := CLIUpdateStatus{
		Provider:       provider,
		CurrentVersion: current,
		LatestVersion:  latest,
	}
	if comparison := CompareVersions(current, latest); comparison != nil && *comparison < 0 {
		status.UpdateAvailable = true
	}
	return status
}

// cliCurrentVersion 按可执行文件的 size+mtime 缓存本机版本探测结果。
func cliCurrentVersion(ctx context.Context, binaryPath string, opts Options) string {
	cache := readCLIVersionCache(opts)
	info, statErr := os.Stat(binaryPath)
	if statErr == nil {
		if entry, ok := cache.Current[binaryPath]; ok &&
			entry.Size == info.Size() &&
			entry.ModTime == info.ModTime().UnixNano() {
			if version, valid := NormalizeVersionString(entry.Version); valid {
				return version
			}
		}
	}
	version := probeCLIBinaryVersion(ctx, binaryPath, opts)
	if version == "" || statErr != nil {
		return version
	}
	cache.Current[binaryPath] = cliCurrentEntry{
		Version:   version,
		Size:      info.Size(),
		ModTime:   info.ModTime().UnixNano(),
		CheckedAt: nowUnix(opts),
	}
	writeCLIVersionCache(opts, cache)
	return version
}

// cliLatestVersion 缓存远程最新版本；失败也记录时间，避免网络不可用时每次都等超时。
func cliLatestVersion(ctx context.Context, source VersionSource, opts Options) string {
	key := versionSourceCacheKey(source)
	if key == "" {
		return ""
	}
	cache := readCLIVersionCache(opts)
	now := nowUnix(opts)
	if entry, ok := cache.Latest[key]; ok {
		age := time.Duration(now-entry.CheckedAt) * time.Second
		if entry.Version != "" && age < cliLatestVersionTTL {
			if version, valid := NormalizeVersionString(entry.Version); valid {
				return version
			}
		}
		if entry.Version == "" && age >= 0 && age < cliLatestVersionRetryAfter {
			return ""
		}
	}
	result := queryRemoteLatestVersion(ctx, source, opts)
	if !result.OK {
		cache.Latest[key] = cliLatestEntry{CheckedAt: now}
		writeCLIVersionCache(opts, cache)
		return ""
	}
	version, valid := NormalizeVersionString(result.LatestVersion)
	if !valid {
		cache.Latest[key] = cliLatestEntry{CheckedAt: now}
		writeCLIVersionCache(opts, cache)
		return ""
	}
	cache.Latest[key] = cliLatestEntry{Version: version, CheckedAt: now}
	writeCLIVersionCache(opts, cache)
	return version
}

func nowUnix(opts Options) int64 {
	return (&opts).nowTime().Unix()
}

func cliVersionCachePath(opts Options) string {
	aiHome := strings.TrimSpace(opts.AIHomeDir)
	if aiHome == "" {
		return ""
	}
	return filepath.Join(aiHome, "cache", "provider-cli-versions.json")
}

func readCLIVersionCache(opts Options) cliVersionCache {
	cache := cliVersionCache{
		Latest:  make(map[string]cliLatestEntry),
		Current: make(map[string]cliCurrentEntry),
	}
	path := cliVersionCachePath(opts)
	if path == "" {
		return cache
	}
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) == 0 || len(raw) > 512*1024 {
		return cache
	}
	var stored cliVersionCache
	if json.Unmarshal(raw, &stored) != nil {
		return cache
	}
	for key, entry := range stored.Latest {
		cache.Latest[key] = entry
	}
	for key, entry := range stored.Current {
		cache.Current[key] = entry
	}
	return cache
}

func writeCLIVersionCache(opts Options, cache cliVersionCache) {
	path := cliVersionCachePath(opts)
	if path == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	raw, err := json.Marshal(cache)
	if err != nil {
		return
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".provider-cli-versions-*.json")
	if err != nil {
		return
	}
	tempPath := temp.Name()
	if _, err = temp.Write(raw); err == nil {
		err = temp.Close()
	} else {
		_ = temp.Close()
	}
	if err == nil {
		err = os.Rename(tempPath, path)
	}
	if err != nil {
		_ = os.Remove(tempPath)
	}
}
