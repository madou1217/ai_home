// Package failureprovenance 提供进程内的失败命中环形缓冲。
//
// 它是"最近一次失败命中了哪条语义"的可观测面：分类值对象与运行态写入保持
// 无状态，这里只保存低敏快照供管理 API 与 CLI 读取。容量固定，写入永不阻塞
// 请求路径；溢出只增加 dropped 计数。
package failureprovenance

import (
	"sync"
	"sync/atomic"
)

// DefaultCapacity 是默认保留的最近命中条数。
const DefaultCapacity = 512

// Event 是一次失败分类命中记录。
type Event struct {
	AtMS            int64  `json:"atMs"`
	Provider        string `json:"provider"`
	AccountRef      string `json:"accountRef"`
	Model           string `json:"model"`
	Source          string `json:"source"`
	SignalID        string `json:"signalId"`
	HTTPStatus      int    `json:"httpStatus,omitempty"`
	ErrorType       string `json:"errorType,omitempty"`
	ErrorCode       string `json:"errorCode,omitempty"`
	Semantic        string `json:"semantic"`
	Action          string `json:"action"`
	Recorded        bool   `json:"recorded"`
	CooldownUntilMS int64  `json:"cooldownUntilMs,omitempty"`
}

// Filter 是快照过滤条件；空字段表示不限制。
type Filter struct {
	Provider   string
	AccountRef string
	Semantic   string
}

// Ring 是有界并发安全的命中缓冲。
type Ring struct {
	mu      sync.Mutex
	entries []Event
	next    int
	count   int
	dropped uint64
}

// NewRing 创建指定容量的环形缓冲。
func NewRing(capacity int) *Ring {
	if capacity <= 0 {
		capacity = DefaultCapacity
	}
	return &Ring{entries: make([]Event, capacity)}
}

var defaultRing = NewRing(DefaultCapacity)

// Record 写入默认缓冲；nil 安全。
func Record(event Event) {
	defaultRing.Record(event)
}

// Snapshot 读取默认缓冲。
func Snapshot(limit int, filter Filter) ([]Event, uint64) {
	return defaultRing.Snapshot(limit, filter)
}

// Dropped 返回默认缓冲因容量不足丢弃的条数。
func Dropped() uint64 {
	return atomic.LoadUint64(&defaultRing.dropped)
}

// Record 写入一条记录。
func (ring *Ring) Record(event Event) {
	if ring == nil {
		return
	}
	ring.mu.Lock()
	defer ring.mu.Unlock()
	if ring.count == len(ring.entries) {
		atomic.AddUint64(&ring.dropped, 1)
	}
	ring.entries[ring.next] = event
	ring.next = (ring.next + 1) % len(ring.entries)
	if ring.count < len(ring.entries) {
		ring.count++
	}
}

// Snapshot 按时间倒序返回最近 limit 条匹配记录。
func (ring *Ring) Snapshot(limit int, filter Filter) ([]Event, uint64) {
	if ring == nil {
		return nil, 0
	}
	ring.mu.Lock()
	defer ring.mu.Unlock()
	if limit <= 0 || limit > ring.count {
		limit = ring.count
	}
	result := make([]Event, 0, limit)
	capacity := len(ring.entries)
	for offset := 1; offset <= ring.count && len(result) < limit; offset++ {
		index := (ring.next - offset + capacity) % capacity
		event := ring.entries[index]
		if !filter.matches(event) {
			continue
		}
		result = append(result, event)
	}
	return result, atomic.LoadUint64(&ring.dropped)
}

func (filter Filter) matches(event Event) bool {
	if filter.Provider != "" && filter.Provider != event.Provider {
		return false
	}
	if filter.AccountRef != "" && filter.AccountRef != event.AccountRef {
		return false
	}
	if filter.Semantic != "" && filter.Semantic != event.Semantic {
		return false
	}
	return true
}