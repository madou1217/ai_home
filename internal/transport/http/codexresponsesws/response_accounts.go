package codexresponsesws

import (
	"sync"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// responseAccounts 记住每个已交付响应的账号归属。
//
// 上游的 previous_response_id 只在生成它的账号上可解析/可重放：账号池里同一
// 线程换号后，这个引用对新账号没有意义。保留归属有两个用途：
//  1. 续接请求优先钉回原账号（Eligibility 负责在账号不可用时回落到候选池）；
//  2. 确实换号时，由 statelessConnection 展开为完整上下文，而不是把引用发给
//     一个不认识它的上游。
//
// 只存响应 ID 与账号引用，不存正文；容量与 TTL 都有上限，最旧优先淘汰。
const (
	responseAccountTTL        = 12 * time.Hour
	maxResponseAccountEntries = 8192
)

type responseAccountEntry struct {
	account accountcore.AccountRef
	seenAt  time.Time
}

type responseAccounts struct {
	mu      sync.Mutex
	entries map[string]responseAccountEntry
}

func newResponseAccounts() *responseAccounts {
	return &responseAccounts{entries: make(map[string]responseAccountEntry)}
}

// Bind 记录一个响应的账号归属。
func (registry *responseAccounts) Bind(
	responseID string,
	account accountcore.AccountRef,
	now time.Time,
) {
	if registry == nil || responseID == "" {
		return
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	if len(registry.entries) >= maxResponseAccountEntries {
		registry.evictLocked(now)
	}
	registry.entries[responseID] = responseAccountEntry{account: account, seenAt: now}
}

// Lookup 返回响应最初由哪个账号交付；过期条目视为未命中。
func (registry *responseAccounts) Lookup(
	responseID string,
	now time.Time,
) (accountcore.AccountRef, bool) {
	if registry == nil || responseID == "" {
		return "", false
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	entry, found := registry.entries[responseID]
	if !found {
		return "", false
	}
	if now.Sub(entry.seenAt) > responseAccountTTL {
		delete(registry.entries, responseID)
		return "", false
	}
	return entry.account, true
}

func (registry *responseAccounts) evictLocked(now time.Time) {
	for id, entry := range registry.entries {
		if now.Sub(entry.seenAt) > responseAccountTTL {
			delete(registry.entries, id)
		}
	}
	for len(registry.entries) >= maxResponseAccountEntries {
		oldestID := ""
		var oldest time.Time
		for id, entry := range registry.entries {
			if oldestID == "" || entry.seenAt.Before(oldest) {
				oldestID = id
				oldest = entry.seenAt
			}
		}
		if oldestID == "" {
			return
		}
		delete(registry.entries, oldestID)
	}
}
