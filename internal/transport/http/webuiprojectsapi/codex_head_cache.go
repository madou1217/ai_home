package webuiprojectsapi

import (
	"os"
	"sync"
	"time"
)

// codexHeadCacheLimit 是 rollout 文件头解析结果的条目上限。
const codexHeadCacheLimit = 4096

// codexHeadCacheEntry 缓存一个 rollout 文件头的解析结果。
//
// 用 size + mtime 校验：文件被追加或改写后自动失效，不需要显式失效通知。
type codexHeadCacheEntry struct {
	size     int64
	modTime  time.Time
	title    string
	hasTitle bool
	meta     codexRolloutMeta
	hasMeta  bool
}

// codexHeadCache 是进程级的 rollout 文件头缓存。
//
// 一个会话 rollout 中位数约 0.9MB，列项目时若每个会话都重读 1MB 头，几百个
// 会话就会累积成接近秒级的扫描（实测 ~900ms）。文件头一旦写下就不变，
// 按 (size, mtime) 命中即可跳过全部读盘。
type codexHeadCache struct {
	mu      sync.Mutex
	entries map[string]codexHeadCacheEntry
	order   []string
}

var codexHeads = &codexHeadCache{entries: make(map[string]codexHeadCacheEntry, 256)}

// lookup 返回与当前文件状态匹配的缓存项。
func (cache *codexHeadCache) lookup(path string) (codexHeadCacheEntry, bool) {
	info, err := os.Stat(path)
	if err != nil {
		return codexHeadCacheEntry{}, false
	}
	cache.mu.Lock()
	entry, ok := cache.entries[path]
	cache.mu.Unlock()
	if !ok || entry.size != info.Size() || !entry.modTime.Equal(info.ModTime()) {
		return codexHeadCacheEntry{}, false
	}
	return entry, true
}

// store 写入/合并缓存项；超过上限时按写入顺序淘汰最旧的一条。
func (cache *codexHeadCache) store(path string, entry codexHeadCacheEntry) {
	info, err := os.Stat(path)
	if err != nil {
		return
	}
	entry.size = info.Size()
	entry.modTime = info.ModTime()
	cache.mu.Lock()
	defer cache.mu.Unlock()
	existing, exists := cache.entries[path]
	if exists {
		if !entry.hasTitle && existing.hasTitle {
			entry.title, entry.hasTitle = existing.title, true
		}
		if !entry.hasMeta && existing.hasMeta {
			entry.meta, entry.hasMeta = existing.meta, true
		}
	} else {
		cache.order = append(cache.order, path)
		if len(cache.order) > codexHeadCacheLimit {
			oldest := cache.order[0]
			cache.order = cache.order[1:]
			delete(cache.entries, oldest)
		}
	}
	cache.entries[path] = entry
}

// cachedCodexFallbackTitle 读取 rollout 文件里的兜底标题（最多 1MB），带缓存。
func cachedCodexFallbackTitle(path string) string {
	if entry, ok := codexHeads.lookup(path); ok && entry.hasTitle {
		return entry.title
	}
	title := readCodexFallbackTitle(path)
	codexHeads.store(path, codexHeadCacheEntry{title: title, hasTitle: true})
	return title
}

// cachedCodexSessionMeta 读取 rollout 文件第一行的 session_meta，带缓存。
func cachedCodexSessionMeta(path string) (codexRolloutMeta, bool) {
	if entry, ok := codexHeads.lookup(path); ok && entry.hasMeta {
		return entry.meta, true
	}
	meta, ok := readCodexSessionMeta(path)
	if ok {
		codexHeads.store(path, codexHeadCacheEntry{meta: meta, hasMeta: true})
	}
	return meta, ok
}
