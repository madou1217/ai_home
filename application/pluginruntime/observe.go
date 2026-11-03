package pluginruntime

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"
)

// CapabilityObserve 是尝试观察的能力名。
const CapabilityObserve = "observe"

const (
	defaultObserveCapacity = 256
	observeInvokeTimeout   = time.Second
)

// Pin 是一个请求固定的插件代次，由入口闸门放进 request context；
// 推理链路记录尝试终态时据此投递观察事件（规划 §4.3：best-effort，不阻塞请求）。
type Pin struct {
	Generation int64
	Projection Projection
	observer   *Observer
	committed  func() bool
	mu         sync.Mutex
	attempts   int
	lastEnd    time.Time
}

type pinKey struct{}

// NewPin 创建请求固定的代次；committed 报告响应头是否已经写给客户端。
func NewPin(generation int64, projection Projection, observer *Observer, started time.Time, committed func() bool) *Pin {
	return &Pin{Generation: generation, Projection: projection, observer: observer, committed: committed, lastEnd: started}
}

// WithPin 把代次固定到请求上下文。
func WithPin(ctx context.Context, pin *Pin) context.Context {
	return context.WithValue(ctx, pinKey{}, pin)
}

// PinFrom 读取请求固定的代次；没有时为 nil。
func PinFrom(ctx context.Context) *Pin {
	if ctx == nil {
		return nil
	}
	pin, _ := ctx.Value(pinKey{}).(*Pin)
	return pin
}

// ObserveAttempt 在尝试终态记录点调用：请求固定的代次有 observe 贡献时排队一条低敏摘要。
//
// 与 Node 的键集合一致（type, generation, provider, model, attempt, accountRef, outcome, error,
// durationMs, committed）。取值上 Go 在记录失败时不知道之后是否换号，所以成功记 "return"、
// 失败一律记 "error"（error 字段是运行态失败分类），不会出现 Node 的 "retry_next"。
// committed：成功一律为 true；失败取记录时响应头是否已写出（能区分输出中途断开）。
func ObserveAttempt(ctx context.Context, accountRef string, model string, success bool, failureKind string) {
	pin := PinFrom(ctx)
	if pin == nil || pin.observer == nil || !pin.Projection.Has(CapabilityObserve) {
		return
	}
	now := time.Now()
	pin.mu.Lock()
	index := pin.attempts
	pin.attempts++
	started := pin.lastEnd
	pin.lastEnd = now
	pin.mu.Unlock()
	committed := success || (pin.committed != nil && pin.committed())
	outcome := "return"
	errorText := ""
	if !success {
		outcome = "error"
		errorText = truncateRunes(failureKind, 300)
	}
	pin.observer.enqueue(observation{
		generation: pin.Generation,
		projection: pin.Projection,
		accountRef: accountRef,
		event: map[string]any{
			"type":       "gateway.attempt",
			"generation": pin.Generation,
			"model":      model,
			"attempt":    index,
			"outcome":    outcome,
			"error":      errorText,
			"durationMs": now.Sub(started).Milliseconds(),
			"committed":  committed,
		},
	})
}

type observation struct {
	generation int64
	projection Projection
	accountRef string
	event      map[string]any
}

// ObserverStats 是观察投递计数。
type ObserverStats struct {
	Queued    int   `json:"queued"`
	Delivered int64 `json:"delivered"`
	Dropped   int64 `json:"dropped"`
	Failed    int64 `json:"failed"`
}

// Observer 用一个有界队列和一个 worker 异步投递观察事件：队列满时丢弃并计数，
// 代次已卸载（Node 释放了租约）时也计为丢弃；永远不阻塞记录点。
type Observer struct {
	invoker   Invoker
	registry  *Registry
	accounts  *accountDescriptions
	queue     chan observation
	delivered atomic.Int64
	dropped   atomic.Int64
	failed    atomic.Int64
	stop      chan struct{}
	done      chan struct{}
	closeOnce sync.Once
}

// NewObserver 创建并启动投递 worker；capacity<=0 时用默认 256。
func NewObserver(invoker Invoker, registry *Registry, describe AccountDescriber, capacity int) *Observer {
	if capacity <= 0 {
		capacity = defaultObserveCapacity
	}
	observer := &Observer{
		invoker: invoker, registry: registry, accounts: newAccountDescriptions(describe),
		queue: make(chan observation, capacity), stop: make(chan struct{}), done: make(chan struct{}),
	}
	go observer.run()
	return observer
}

func (observer *Observer) enqueue(item observation) {
	select {
	case observer.queue <- item:
	default:
		observer.dropped.Add(1)
	}
}

func (observer *Observer) run() {
	defer close(observer.done)
	for {
		select {
		case <-observer.stop:
			return
		case item := <-observer.queue:
			observer.deliver(item)
		}
	}
}

func (observer *Observer) deliver(item observation) {
	event := make(map[string]any, len(item.event)+2)
	for key, value := range item.event {
		event[key] = value
	}
	event["provider"] = observer.accounts.get(item.accountRef).Provider
	event["accountRef"] = observer.registry.NodeAccountRef(item.accountRef)
	for _, contribution := range item.projection.ByCapability(CapabilityObserve) {
		ctx, cancel := context.WithTimeout(context.Background(), observeInvokeTimeout)
		_, err := observer.invoker.Invoke(ctx, item.generation, contribution.ID, event, observeInvokeTimeout)
		cancel()
		switch {
		case err == nil:
			observer.delivered.Add(1)
		case errorCode(err) == "plugin_generation_unknown":
			observer.dropped.Add(1)
			return
		default:
			observer.failed.Add(1)
		}
	}
}

// Stats 返回投递计数。
func (observer *Observer) Stats() ObserverStats {
	if observer == nil {
		return ObserverStats{}
	}
	return ObserverStats{Queued: len(observer.queue), Delivered: observer.delivered.Load(), Dropped: observer.dropped.Load(), Failed: observer.failed.Load()}
}

// Close 停止 worker（未投递的事件丢弃）。
func (observer *Observer) Close() {
	if observer == nil {
		return
	}
	observer.closeOnce.Do(func() {
		close(observer.stop)
		<-observer.done
	})
}

func errorCode(err error) string {
	var coded interface{ ErrorCode() string }
	if errors.As(err, &coded) {
		return coded.ErrorCode()
	}
	return ""
}
