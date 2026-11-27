package responseswebsocket

import (
	"encoding/json"
	"sync"
	"time"
)

// responseJournal 保存本进程已交付的 Codex 响应上下文，供跨连接、跨账号的
// previous_response_id 续接展开为无状态请求。
//
// 为什么必须由中继自己保存：账号池里的上一轮响应只存在于当时那个账号的上游
// 存储中（官方 ChatGPT 账号则按账号隔离）。换号、重连或把请求转给另一台 aih
// 之后，同一个 previous_response_id 在新账号上要么找不到，要么被上游以
// "persisted response cannot replay" 拒绝。把完整上下文留在本进程并展开，
// 就不依赖任何一个账号的持久化语义；展开时同时剥掉旧账号无法验证的加密推理。
//
// 只保留 ID 与 items，不落盘；容量与条目数都有上限，超限按最旧优先淘汰。
const (
	responseJournalTTL        = 2 * time.Hour
	responseJournalMaxEntries = 2048
	responseJournalMaxBytes   = 64 * 1024 * 1024
)

type responseJournalEntry struct {
	items    []json.RawMessage
	bytes    int
	recorded time.Time
}

type responseJournal struct {
	mu      sync.Mutex
	entries map[string]responseJournalEntry
	bytes   int
	clock   func() time.Time
}

func newResponseJournal() *responseJournal {
	return &responseJournal{
		entries: make(map[string]responseJournalEntry),
		clock:   time.Now,
	}
}

// Store 记录一次已完成响应的完整上下文（请求输入 + 响应输出）。
func (journal *responseJournal) Store(responseID string, items []json.RawMessage) {
	if journal == nil || responseID == "" || len(items) == 0 {
		return
	}
	size := 0
	for _, item := range items {
		size += len(item)
	}
	if size > responseJournalMaxBytes {
		return
	}
	now := journal.clock()
	journal.mu.Lock()
	defer journal.mu.Unlock()
	journal.evictExpiredLocked(now)
	if previous, found := journal.entries[responseID]; found {
		journal.bytes -= previous.bytes
		delete(journal.entries, responseID)
	}
	for len(journal.entries) >= responseJournalMaxEntries || journal.bytes+size > responseJournalMaxBytes {
		if !journal.evictOldestLocked() {
			break
		}
	}
	journal.entries[responseID] = responseJournalEntry{
		items:    append([]json.RawMessage(nil), items...),
		bytes:    size,
		recorded: now,
	}
	journal.bytes += size
}

// Lookup 返回该响应记录的完整上下文；过期条目视为未命中。
func (journal *responseJournal) Lookup(responseID string) ([]json.RawMessage, bool) {
	if journal == nil || responseID == "" {
		return nil, false
	}
	now := journal.clock()
	journal.mu.Lock()
	defer journal.mu.Unlock()
	entry, found := journal.entries[responseID]
	if !found {
		return nil, false
	}
	if now.Sub(entry.recorded) > responseJournalTTL {
		delete(journal.entries, responseID)
		journal.bytes -= entry.bytes
		return nil, false
	}
	return append([]json.RawMessage(nil), entry.items...), true
}

func (journal *responseJournal) evictExpiredLocked(now time.Time) {
	for id, entry := range journal.entries {
		if now.Sub(entry.recorded) > responseJournalTTL {
			delete(journal.entries, id)
			journal.bytes -= entry.bytes
		}
	}
}

func (journal *responseJournal) evictOldestLocked() bool {
	oldestID := ""
	var oldest time.Time
	for id, entry := range journal.entries {
		if oldestID == "" || entry.recorded.Before(oldest) {
			oldestID = id
			oldest = entry.recorded
		}
	}
	if oldestID == "" {
		return false
	}
	journal.bytes -= journal.entries[oldestID].bytes
	delete(journal.entries, oldestID)
	return true
}
