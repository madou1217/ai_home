// Package clauderelay 管理原生 Claude Relay 的短期账号绑定租约。
//
// 租约只存在于当前 Go Server 内存，不持久化凭据，也不把可变 CLI ID 当身份。
package clauderelay

import (
	"container/heap"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"sync"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// DefaultLeaseTTL 让单次 CLI 会话可长期运行，同时限制泄漏窗口。
	DefaultLeaseTTL = 24 * time.Hour
	// DefaultMaxLeases 限制单进程租约内存占用。
	DefaultMaxLeases = 10_000
	relayTokenBytes  = 32
	maxIssueAttempts = 3
)

var (
	// ErrInvalidDependencies 表示 Registry 缺少随机源、时钟或边界无效。
	ErrInvalidDependencies = errors.New("Claude Relay 租约依赖无效")
	// ErrInvalidAccountRef 表示调用方没有提供稳定账号身份。
	ErrInvalidAccountRef = errors.New("Claude Relay 租约账号无效")
	// ErrLeaseCapacity 表示清理过期项后仍达到租约上限。
	ErrLeaseCapacity = errors.New("Claude Relay 租约容量已满")
	// ErrTokenGeneration 表示安全随机源无法生成唯一 Token。
	ErrTokenGeneration = errors.New("Claude Relay Token 生成失败")
)

// Dependencies 集中声明 Registry 的安全随机源、时钟和边界。
type Dependencies struct {
	Random    io.Reader
	Clock     func() time.Time
	TTL       time.Duration
	MaxLeases int
}

// Lease 是只向可信本地调用方交付一次的账号绑定结果。
type Lease struct {
	token      string
	accountRef accountcore.AccountRef
	expiresAt  time.Time
}

// Token 返回应只投影到目标 Claude 进程环境的短期密钥。
func (lease Lease) Token() string {
	return lease.token
}

// AccountRef 返回 Token 在服务端绑定的稳定账号身份。
func (lease Lease) AccountRef() accountcore.AccountRef {
	return lease.accountRef
}

// ExpiresAt 返回租约的绝对 UTC 到期时间。
func (lease Lease) ExpiresAt() time.Time {
	return lease.expiresAt
}

// IsValid 重新检查跨层传递后的租约不变量。
func (lease Lease) IsValid() bool {
	return lease.token != "" &&
		lease.accountRef.IsValid() &&
		!lease.expiresAt.IsZero() &&
		lease.expiresAt.Location() == time.UTC
}

// leaseRecord 只保存 Token 摘要，避免内存快照直接暴露原文。
type leaseRecord struct {
	accountRef accountcore.AccountRef
	expiresAt  time.Time
}

// leaseExpiry 是最小堆中的到期索引，不保存 Token 原文。
type leaseExpiry struct {
	digest    [sha256.Size]byte
	expiresAt time.Time
}

// leaseExpiryHeap 让签发时的过期清理从全表扫描降为 O(log n)。
type leaseExpiryHeap []leaseExpiry

// Len 返回当前到期索引数量。
func (items leaseExpiryHeap) Len() int {
	return len(items)
}

// Less 让堆顶始终是最早到期项。
func (items leaseExpiryHeap) Less(left, right int) bool {
	return items[left].expiresAt.Before(items[right].expiresAt)
}

// Swap 交换两个到期索引。
func (items leaseExpiryHeap) Swap(left, right int) {
	items[left], items[right] = items[right], items[left]
}

// Push 向堆尾追加一个类型确定的到期索引。
func (items *leaseExpiryHeap) Push(value any) {
	*items = append(*items, value.(leaseExpiry))
}

// Pop 移除堆尾并清空旧引用。
func (items *leaseExpiryHeap) Pop() any {
	previous := *items
	last := len(previous) - 1
	value := previous[last]
	previous[last] = leaseExpiry{}
	*items = previous[:last]
	return value
}

// LeaseRegistry 是并发安全、有界、进程内的 Relay Token 真相源。
type LeaseRegistry struct {
	mu        sync.Mutex
	randomMu  sync.Mutex
	random    io.Reader
	clock     func() time.Time
	ttl       time.Duration
	maxLeases int
	leases    map[[sha256.Size]byte]leaseRecord
	expiries  leaseExpiryHeap
}

// NewLeaseRegistry 创建不启动后台 goroutine 的惰性清理注册表。
func NewLeaseRegistry(
	dependencies Dependencies,
) (*LeaseRegistry, error) {
	ttl := dependencies.TTL
	if ttl == 0 {
		ttl = DefaultLeaseTTL
	}
	maxLeases := dependencies.MaxLeases
	if maxLeases == 0 {
		maxLeases = DefaultMaxLeases
	}
	if dependencies.Random == nil ||
		dependencies.Clock == nil ||
		ttl < time.Minute ||
		ttl > 7*24*time.Hour ||
		maxLeases < 1 ||
		maxLeases > 100_000 {
		return nil, ErrInvalidDependencies
	}
	return &LeaseRegistry{
		random:    dependencies.Random,
		clock:     dependencies.Clock,
		ttl:       ttl,
		maxLeases: maxLeases,
		leases:    make(map[[sha256.Size]byte]leaseRecord),
	}, nil
}

// Issue 为一个稳定 AccountRef 创建不可转移的随机租约。
func (registry *LeaseRegistry) Issue(
	accountRef accountcore.AccountRef,
) (Lease, error) {
	if registry == nil ||
		registry.random == nil ||
		registry.clock == nil ||
		!accountRef.IsValid() {
		return Lease{}, ErrInvalidAccountRef
	}
	now, err := registry.currentTime()
	if err != nil {
		return Lease{}, err
	}
	for range maxIssueAttempts {
		token, digest, err := registry.generateToken()
		if err != nil {
			return Lease{}, err
		}
		registry.mu.Lock()
		registry.pruneExpiredLocked(now)
		if len(registry.leases) >= registry.maxLeases {
			registry.mu.Unlock()
			return Lease{}, ErrLeaseCapacity
		}
		if _, duplicated := registry.leases[digest]; duplicated {
			registry.mu.Unlock()
			continue
		}
		expiresAt := now.Add(registry.ttl).UTC()
		registry.leases[digest] = leaseRecord{
			accountRef: accountRef,
			expiresAt:  expiresAt,
		}
		heap.Push(&registry.expiries, leaseExpiry{
			digest:    digest,
			expiresAt: expiresAt,
		})
		registry.mu.Unlock()
		return Lease{
			token:      token,
			accountRef: accountRef,
			expiresAt:  expiresAt,
		}, nil
	}
	return Lease{}, ErrTokenGeneration
}

// ResolveRelayToken 返回仍有效的服务端账号绑定。
func (registry *LeaseRegistry) ResolveRelayToken(
	token string,
) (accountcore.AccountRef, bool) {
	if registry == nil || registry.clock == nil || token == "" {
		return "", false
	}
	now, err := registry.currentTime()
	if err != nil {
		return "", false
	}
	digest := sha256.Sum256([]byte(token))
	registry.mu.Lock()
	defer registry.mu.Unlock()

	record, found := registry.leases[digest]
	if !found {
		return "", false
	}
	if !record.expiresAt.After(now) {
		delete(registry.leases, digest)
		return "", false
	}
	return record.accountRef, record.accountRef.IsValid()
}

// Revoke 立即移除目标进程持有的单个 Token。
func (registry *LeaseRegistry) Revoke(token string) {
	if registry == nil || token == "" {
		return
	}
	digest := sha256.Sum256([]byte(token))
	registry.mu.Lock()
	delete(registry.leases, digest)
	registry.compactExpiriesLocked()
	registry.mu.Unlock()
}

// generateToken 从注入的密码学随机源读取固定熵并只保存摘要。
func (registry *LeaseRegistry) generateToken() (
	string,
	[sha256.Size]byte,
	error,
) {
	raw := make([]byte, relayTokenBytes)
	registry.randomMu.Lock()
	_, err := io.ReadFull(registry.random, raw)
	registry.randomMu.Unlock()
	if err != nil {
		clear(raw)
		return "", [sha256.Size]byte{}, ErrTokenGeneration
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	clear(raw)
	return token, sha256.Sum256([]byte(token)), nil
}

// currentTime 返回可形成确定到期时间的 UTC 时钟值。
func (registry *LeaseRegistry) currentTime() (time.Time, error) {
	now := registry.clock().UTC()
	if now.IsZero() || now.UnixMilli() <= 0 || now.Year() > 9999 {
		return time.Time{}, ErrInvalidDependencies
	}
	return now, nil
}

// pruneExpiredLocked 从最早到期项开始释放，不扫描仍有效的 Map。
func (registry *LeaseRegistry) pruneExpiredLocked(now time.Time) {
	for len(registry.expiries) > 0 {
		next := registry.expiries[0]
		if next.expiresAt.After(now) {
			return
		}
		_ = heap.Pop(&registry.expiries)
		record, found := registry.leases[next.digest]
		if found && record.expiresAt.Equal(next.expiresAt) {
			delete(registry.leases, next.digest)
		}
	}
}

// compactExpiriesLocked 限制已撤销项在堆中的惰性残留，保持内存有界。
func (registry *LeaseRegistry) compactExpiriesLocked() {
	if len(registry.expiries) <= registry.maxLeases*2 {
		return
	}
	compacted := make(
		leaseExpiryHeap,
		0,
		len(registry.leases),
	)
	for digest, record := range registry.leases {
		compacted = append(compacted, leaseExpiry{
			digest:    digest,
			expiresAt: record.expiresAt,
		})
	}
	heap.Init(&compacted)
	registry.expiries = compacted
}
