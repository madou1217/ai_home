// Package accountusagefeed 保存最近上游尝试的 token 用量事件，供 Node 按序号增量拉取。
//
// Go 承接了几乎全部推理，但账号 Token 用量统计（Node 的 model-usage 库）只认网关写入的
// 带账号记录；此前 Go 流量完全不计入，账号页也没有逐条的消耗动效。这里只在内存里保留
// 一个有界环形缓冲：热路径 O(1) 追加、从不阻塞推理；Node 用 (bootID, seq) 游标去重续读。
package accountusagefeed

import (
	"strconv"
	"sync"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
)

// DefaultCapacity 覆盖 Node 轮询间隔内的突发请求量；溢出时 Node 从 Since 的 truncated 得知丢失。
const DefaultCapacity = 4096

// Event 是一次成功上游尝试的低敏用量记录，不含请求内容。
type Event struct {
	Seq        uint64
	AccountRef accountcore.AccountRef
	Model      string
	At         time.Time
	Usage      inference.Usage
}

// Feed 是并发安全的有界事件环。
type Feed struct {
	mu       sync.Mutex
	bootID   string
	next     uint64
	ring     []Event
	capacity int
}

// NewFeed 创建空事件环；bootID 区分进程实例，Node 据此在 Go 重启后重置游标。
func NewFeed(capacity int, now time.Time) *Feed {
	if capacity <= 0 {
		capacity = DefaultCapacity
	}
	return &Feed{
		bootID:   strconv.FormatInt(now.UnixNano(), 36),
		next:     1,
		ring:     make([]Event, 0, capacity),
		capacity: capacity,
	}
}

// BootID 返回本进程实例标识。
func (feed *Feed) BootID() string {
	if feed == nil {
		return ""
	}
	return feed.bootID
}

// Append 追加一条用量事件；非法输入或空用量静默忽略。
func (feed *Feed) Append(accountRef accountcore.AccountRef, model string, at time.Time, usage inference.Usage) {
	if feed == nil || !accountRef.IsValid() || !usage.IsValid() || usage.TotalTokens() == 0 {
		return
	}
	feed.mu.Lock()
	defer feed.mu.Unlock()
	event := Event{Seq: feed.next, AccountRef: accountRef, Model: model, At: at, Usage: usage}
	feed.next++
	if len(feed.ring) < feed.capacity {
		feed.ring = append(feed.ring, event)
		return
	}
	copy(feed.ring, feed.ring[1:])
	feed.ring[len(feed.ring)-1] = event
}

// Since 返回序号大于 after 的事件（升序）与当前最新序号；
// truncated 表示 after 之后有事件已被挤出环（调用方据此知道有丢失）。
func (feed *Feed) Since(after uint64) (events []Event, latest uint64, truncated bool) {
	if feed == nil {
		return nil, 0, false
	}
	feed.mu.Lock()
	defer feed.mu.Unlock()
	latest = feed.next - 1
	if len(feed.ring) > 0 && feed.ring[0].Seq > after+1 {
		truncated = true
	}
	for _, event := range feed.ring {
		if event.Seq > after {
			events = append(events, event)
		}
	}
	return events, latest, truncated
}
