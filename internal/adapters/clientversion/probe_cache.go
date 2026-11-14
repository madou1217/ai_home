package clientversion

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ProbeCache 持久化「本机 CLI 探测」的结果及其 CLI 身份。
//
// 只有内存缓存时，每次进程重启都要重新执行 `codex --version`：Codex 是 Node 垫片，
// 单次 0.25–1.2 秒，而 Start 又是同步探测（先探完再服务）。身份不变时这个值必然相同，
// 直接复用；CLI 升级 / 换安装位置 / PATH 变化都会改变身份，下次探测立刻失效重探。
//
// 与 LearnedStore 的区别：LearnedStore 记录「从真实客户端学到」的最高版本（单调不降，
// 永远不因降级回退）；ProbeCache 记录「本机 CLI 现在自报什么」，可以随升级变化。
type ProbeCache struct {
	path    string
	mu      sync.Mutex
	entries map[string]probeCacheEntry
}

type probeCacheEntry struct {
	Version    string `json:"version"`
	Identity   string `json:"identity"`
	DetectedAt string `json:"detectedAt,omitempty"`
}

// NewProbeCache 打开（或延迟创建）探测快照文件；路径为空时只在内存中生效。
func NewProbeCache(path string) *ProbeCache {
	cache := &ProbeCache{path: path, entries: make(map[string]probeCacheEntry)}
	if path == "" {
		return cache
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		return cache
	}
	var stored map[string]probeCacheEntry
	if json.Unmarshal(payload, &stored) != nil {
		return cache
	}
	for provider, entry := range stored {
		if version, ok := Parse(entry.Version); ok && version.String() == entry.Version && entry.Identity != "" {
			cache.entries[provider] = entry
		}
	}
	return cache
}

// Lookup 返回身份完全一致时的缓存版本；身份不同（或没有缓存）时返回 false。
func (cache *ProbeCache) Lookup(provider, identity string) (Version, bool) {
	if cache == nil || identity == "" {
		return Version{}, false
	}
	cache.mu.Lock()
	entry, ok := cache.entries[provider]
	cache.mu.Unlock()
	if !ok || entry.Identity != identity {
		return Version{}, false
	}
	version, valid := Parse(entry.Version)
	if !valid {
		return Version{}, false
	}
	return version, true
}

// Store 记录一次成功探测的版本与当时计算出的 CLI 身份。
func (cache *ProbeCache) Store(provider, identity string, version Version) {
	if cache == nil || identity == "" || version.IsZero() {
		return
	}
	cache.mu.Lock()
	previous, exists := cache.entries[provider]
	unchanged := exists && previous.Version == version.String() && previous.Identity == identity
	if !unchanged {
		cache.entries[provider] = probeCacheEntry{
			Version:    version.String(),
			Identity:   identity,
			DetectedAt: time.Now().UTC().Format(time.RFC3339),
		}
	}
	path := cache.path
	var payload []byte
	if !unchanged && path != "" {
		payload, _ = json.MarshalIndent(cache.entries, "", "  ")
	}
	cache.mu.Unlock()
	if unchanged || len(payload) == 0 {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return
	}
	temporary := path + ".tmp"
	if os.WriteFile(temporary, payload, 0o600) != nil {
		return
	}
	_ = os.Rename(temporary, path)
}

// ProbeIdentity 用候选命令的文件元数据（存在性、大小、mtime）描述「本机 CLI 是谁」。
//
// 只做 stat，不起子进程；裸命令名按 PATH 解析到真实文件，PATH 变化也会改变身份。
// 任一候选无法 stat 时记为 missing——新增/删除安装位置同样会改变身份。
func ProbeIdentity(commands []string) string {
	parts := make([]string, 0, len(commands))
	for _, command := range commands {
		trimmed := strings.TrimSpace(command)
		if trimmed == "" {
			continue
		}
		resolved := trimmed
		if !strings.ContainsRune(trimmed, filepath.Separator) {
			found, err := exec.LookPath(trimmed)
			if err != nil {
				parts = append(parts, trimmed+"=missing")
				continue
			}
			resolved = found
		}
		stat, err := os.Stat(resolved)
		if err != nil {
			parts = append(parts, trimmed+"=missing")
			continue
		}
		parts = append(parts, trimmed+"="+resolved+":"+
			strconv.FormatInt(stat.Size(), 10)+":"+strconv.FormatInt(stat.ModTime().UnixNano(), 10))
	}
	return strings.Join(parts, "|")
}
