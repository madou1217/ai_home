package inferencegateway

import (
	"context"
	"errors"
	"strings"
	"sync"
)

// DefaultProviderQueueLimit 与 Node serve 的 queueLimit 默认值一致。
const DefaultProviderQueueLimit = 200

// ErrProviderQueueFull 表示某一 Provider 的等待队列已满。
var ErrProviderQueueFull = errors.New("上游 Provider 队列已满")

// Claude API Key accounts can point at independent upstreams. One provider
// slot serializes every session, so keep a bounded multi-session default.
var defaultProviderLimits = map[string]int{
	"codex":    2,
	"gemini":   1,
	"claude":   8,
	"agy":      1,
	"opencode": 1,
}

var (
	providerLimitsMu     sync.RWMutex
	configuredLimits     map[string]int
	configuredQueueLimit int
)

// ConfigureProviderLimits 设置本进程的 Provider 并发与等待队列上限。
//
// limits 为空表示使用 Node 对齐默认值；显式值必须在 [1,32]，队列在 [1,5000]。
func ConfigureProviderLimits(limits map[string]int, queueLimit int) error {
	normalized := make(map[string]int, len(limits))
	for provider, limit := range limits {
		name := strings.ToLower(strings.TrimSpace(provider))
		if name == "" || limit < 1 || limit > 32 {
			return errors.New("Provider 并发数必须在 1 到 32 之间")
		}
		normalized[name] = limit
	}
	if queueLimit < 0 || queueLimit > 5000 {
		return errors.New("Provider 队列上限必须在 0 到 5000 之间")
	}
	providerLimitsMu.Lock()
	configuredLimits = normalized
	configuredQueueLimit = queueLimit
	providerLimitsMu.Unlock()
	return nil
}

func providerLimitSnapshot() (map[string]int, int) {
	providerLimitsMu.RLock()
	limits := configuredLimits
	queueLimit := configuredQueueLimit
	providerLimitsMu.RUnlock()
	if len(limits) == 0 {
		limits = defaultProviderLimits
	}
	if queueLimit <= 0 {
		queueLimit = DefaultProviderQueueLimit
	}
	copyLimits := make(map[string]int, len(limits))
	for provider, limit := range limits {
		copyLimits[provider] = limit
	}
	return copyLimits, queueLimit
}

type providerGate struct {
	mu         sync.Mutex
	limits     map[string]int
	queueLimit int
	waiting    map[string]int
	sems       map[string]chan struct{}
}

func newProviderGate() *providerGate {
	limits, queueLimit := providerLimitSnapshot()
	sems := make(map[string]chan struct{}, len(limits))
	for provider, limit := range limits {
		sems[provider] = make(chan struct{}, limit)
	}
	return &providerGate{
		limits:     limits,
		queueLimit: queueLimit,
		waiting:    make(map[string]int),
		sems:       sems,
	}
}

func (gate *providerGate) acquire(ctx context.Context, provider string) (func(), error) {
	if gate == nil {
		return func() {}, nil
	}
	provider = strings.ToLower(strings.TrimSpace(provider))
	sem := gate.sems[provider]
	if sem == nil {
		return func() {}, nil
	}
	gate.mu.Lock()
	gate.waiting[provider]++
	waiting := gate.waiting[provider]
	gate.mu.Unlock()
	if waiting > gate.queueLimit {
		gate.mu.Lock()
		gate.waiting[provider]--
		gate.mu.Unlock()
		return nil, ErrProviderQueueFull
	}
	select {
	case sem <- struct{}{}:
		gate.mu.Lock()
		gate.waiting[provider]--
		gate.mu.Unlock()
		return func() { <-sem }, nil
	case <-ctx.Done():
		gate.mu.Lock()
		gate.waiting[provider]--
		gate.mu.Unlock()
		return nil, ctx.Err()
	}
}
