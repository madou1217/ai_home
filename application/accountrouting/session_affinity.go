package accountrouting

import (
	"container/list"
	"sync"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// DefaultSessionAffinityTTL 与 Node 一致：会话绑定默认保留 30 分钟。
	DefaultSessionAffinityTTL = 30 * time.Minute
	// DefaultSessionAffinityMaxEntries 与 Node 一致：每个 Provider 最多保留 10,000 条绑定。
	DefaultSessionAffinityMaxEntries = 10_000
)

// SessionAffinity 按 (Provider, 会话键) 记住上一次选中的账号。
//
// 与 Node 的 state.sessionAffinity 同构：按 Provider 分桶，命中即续期，超过上限时按
// 插入顺序淘汰最旧的一条。它只影响选号起点，不改变候选快照、资格判定或凭据合同。
type SessionAffinity struct {
	mu         sync.Mutex
	ttl        time.Duration
	maxEntries int
	providers  map[string]*affinityBucket
}

// affinityBucket 是一个 Provider 的会话绑定分桶。
type affinityBucket struct {
	entries map[string]*affinityEntry
	order   *list.List
}

// affinityEntry 保存单个会话键的绑定账号、到期时间与淘汰顺序位置。
type affinityEntry struct {
	accountRef accountcore.AccountRef
	expiresAt  time.Time
	element    *list.Element
}

// NewSessionAffinity 创建使用默认 TTL 与容量上限的会话亲和存储。
func NewSessionAffinity() *SessionAffinity {
	return &SessionAffinity{
		ttl:        DefaultSessionAffinityTTL,
		maxEntries: DefaultSessionAffinityMaxEntries,
		providers:  make(map[string]*affinityBucket),
	}
}

// Lookup 返回会话键当前绑定的账号；命中时续期，未命中或已过期返回 false。
func (affinity *SessionAffinity) Lookup(
	providerID string,
	sessionKey string,
	now time.Time,
) (accountcore.AccountRef, bool) {
	if affinity == nil || providerID == "" || sessionKey == "" {
		return "", false
	}
	affinity.mu.Lock()
	defer affinity.mu.Unlock()
	bucket := affinity.providers[providerID]
	if bucket == nil {
		return "", false
	}
	affinity.purge(bucket, now)
	entry := bucket.entries[sessionKey]
	if entry == nil || !entry.accountRef.IsValid() {
		return "", false
	}
	entry.expiresAt = now.Add(affinity.ttl)
	return entry.accountRef, true
}

// Bind 把会话键绑定到账号；已存在的键只更新账号与到期时间，保持淘汰顺序。
func (affinity *SessionAffinity) Bind(
	providerID string,
	sessionKey string,
	accountRef accountcore.AccountRef,
	now time.Time,
) {
	if affinity == nil ||
		providerID == "" ||
		sessionKey == "" ||
		!accountRef.IsValid() {
		return
	}
	affinity.mu.Lock()
	defer affinity.mu.Unlock()
	bucket := affinity.providers[providerID]
	if bucket == nil {
		bucket = &affinityBucket{
			entries: make(map[string]*affinityEntry),
			order:   list.New(),
		}
		affinity.providers[providerID] = bucket
	}
	affinity.purge(bucket, now)
	if entry := bucket.entries[sessionKey]; entry != nil {
		entry.accountRef = accountRef
		entry.expiresAt = now.Add(affinity.ttl)
		return
	}
	for bucket.order.Len() >= affinity.maxEntries {
		oldest := bucket.order.Front()
		if oldest == nil {
			break
		}
		affinity.evict(bucket, oldest.Value.(string))
	}
	entry := &affinityEntry{
		accountRef: accountRef,
		expiresAt:  now.Add(affinity.ttl),
	}
	entry.element = bucket.order.PushBack(sessionKey)
	bucket.entries[sessionKey] = entry
}

// purge 删除分桶内所有已过期条目。
func (affinity *SessionAffinity) purge(bucket *affinityBucket, now time.Time) {
	for element := bucket.order.Front(); element != nil; {
		next := element.Next()
		sessionKey := element.Value.(string)
		entry := bucket.entries[sessionKey]
		if entry == nil || !entry.expiresAt.After(now) {
			affinity.evict(bucket, sessionKey)
		}
		element = next
	}
}

// evict 从分桶同时移除顺序节点和映射条目。
func (affinity *SessionAffinity) evict(bucket *affinityBucket, sessionKey string) {
	entry := bucket.entries[sessionKey]
	if entry == nil {
		return
	}
	if entry.element != nil {
		bucket.order.Remove(entry.element)
	}
	delete(bucket.entries, sessionKey)
}
