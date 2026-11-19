package codebuddy

import (
	"os"
	"sync"
	"time"
)

// sessionFactsCacheLimit 是会话事实缓存的条目上限。
const sessionFactsCacheLimit = 4096

// sessionFactsCacheEntry 缓存一个会话文件的解析结果。
//
// 用 size + mtime 校验失效：会话文件只追加，追加后 size/mtime 必变，
// 因此不需要任何显式失效通知。
type sessionFactsCacheEntry struct {
	size    int64
	modTime time.Time
	facts   sessionFacts
}

// sessionFactsCache 是进程级缓存。
//
// 代码库里的 CodeBuddy 会话单个文件可达数十 MB，列项目时每个会话都要读
// 512KB 头 + 最多 1MB 尾（实测 944 个文件共 1.4GB，单次列表约 900ms）。
// 头部与重命名事实一旦写入就不再变化，按 (size, mtime) 命中即可跳过读盘。
type sessionFactsCache struct {
	mu      sync.Mutex
	entries map[string]sessionFactsCacheEntry
	order   []string
}

var factsCache = &sessionFactsCache{entries: make(map[string]sessionFactsCacheEntry, 256)}

// cachedSessionFacts 返回会话事实；文件未变化时复用上次的解析结果。
func cachedSessionFacts(sessionPath string) sessionFacts {
	info, err := os.Stat(sessionPath)
	if err != nil {
		return readSessionFacts(sessionPath)
	}
	factsCache.mu.Lock()
	entry, ok := factsCache.entries[sessionPath]
	factsCache.mu.Unlock()
	if ok && entry.size == info.Size() && entry.modTime.Equal(info.ModTime()) {
		return entry.facts
	}

	facts := readSessionFacts(sessionPath)

	// readSessionFacts 内部也 stat 过一次，这里以调用前的快照为准：
	// 若读的过程中文件被追加，下一次调用会因 size 不同而重新解析。
	factsCache.mu.Lock()
	defer factsCache.mu.Unlock()
	if _, exists := factsCache.entries[sessionPath]; !exists {
		factsCache.order = append(factsCache.order, sessionPath)
		if len(factsCache.order) > sessionFactsCacheLimit {
			oldest := factsCache.order[0]
			factsCache.order = factsCache.order[1:]
			delete(factsCache.entries, oldest)
		}
	}
	factsCache.entries[sessionPath] = sessionFactsCacheEntry{
		size:    info.Size(),
		modTime: info.ModTime(),
		facts:   facts,
	}
	return facts
}
