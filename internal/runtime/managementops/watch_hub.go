package managementops

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

const (
	// watchPollInterval 与 Node management-live.js (1500ms) 对齐。
	watchPollInterval = 1500 * time.Millisecond
	watchQueueSize    = 64
)

type watchSubscriber struct {
	events chan []byte
	done   chan struct{}
	once   sync.Once
}

func newWatchSubscriber() *watchSubscriber {
	return &watchSubscriber{
		events: make(chan []byte, watchQueueSize),
		done:   make(chan struct{}),
	}
}

func (sub *watchSubscriber) close() {
	sub.once.Do(func() {
		close(sub.done)
	})
}

// WatchHub 管理 /v0/management/watch SSE 订阅与增量去重广播。
type WatchHub struct {
	service *ManagementService

	mu             sync.Mutex
	subscribers    map[*watchSubscriber]struct{}
	revision       int64
	lastSerialized string
	polling        bool
	stopPoll       chan struct{}
}

// NewWatchHub 构造管理面实时监听枢纽。
func NewWatchHub(service *ManagementService) *WatchHub {
	return &WatchHub{
		service:     service,
		subscribers: make(map[*watchSubscriber]struct{}),
	}
}

// Subscribe 注册一个新的 SSE 订阅者，并立即推入 connected 帧与当前全量快照。
func (hub *WatchHub) Subscribe(ctx context.Context) (<-chan []byte, func()) {
	sub := newWatchSubscriber()
	connected, _ := json.Marshal(map[string]any{"type": "connected"})
	sub.events <- connected

	_, payload := hub.captureSnapshot(ctx)
	if encoded, err := json.Marshal(payload); err == nil {
		sub.events <- encoded
	}

	hub.mu.Lock()
	hub.subscribers[sub] = struct{}{}
	shouldStartPoller := !hub.polling && len(hub.subscribers) > 0
	if shouldStartPoller {
		hub.polling = true
		stopCh := make(chan struct{})
		hub.stopPoll = stopCh
		go hub.runPoller(stopCh)
	}
	hub.mu.Unlock()

	cancel := func() {
		hub.removeSubscriber(sub)
	}
	return sub.events, cancel
}

func (hub *WatchHub) removeSubscriber(sub *watchSubscriber) {
	if hub == nil || sub == nil {
		return
	}
	sub.close()
	hub.mu.Lock()
	delete(hub.subscribers, sub)
	if len(hub.subscribers) == 0 && hub.polling {
		hub.polling = false
		if hub.stopPoll != nil {
			close(hub.stopPoll)
			hub.stopPoll = nil
		}
	}
	hub.mu.Unlock()
}

func (hub *WatchHub) runPoller(stopCh <-chan struct{}) {
	ticker := time.NewTicker(watchPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stopCh:
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			changed, payload := hub.captureSnapshot(ctx)
			cancel()
			if changed {
				hub.broadcast(payload)
			}
		}
	}
}

// NotifySnapshot 捕获一次最新管理快照，并在内容变化或 force=true 时广播给活跃监听者。
func (hub *WatchHub) NotifySnapshot(ctx context.Context, force bool) bool {
	if hub == nil {
		return false
	}
	changed, payload := hub.captureSnapshot(ctx)
	hub.mu.Lock()
	hasWatchers := len(hub.subscribers) > 0
	hub.mu.Unlock()
	if !hasWatchers || (!changed && !force) {
		return false
	}
	hub.broadcast(payload)
	return true
}

// EmitEvent 直接向当前监听者推送一条异步实时事件（例如重启/关停事件）。
func (hub *WatchHub) EmitEvent(payload any) bool {
	if hub == nil || payload == nil {
		return false
	}
	hub.mu.Lock()
	hasWatchers := len(hub.subscribers) > 0
	hub.mu.Unlock()
	if !hasWatchers {
		return false
	}
	hub.broadcast(payload)
	return true
}

func (hub *WatchHub) captureSnapshot(ctx context.Context) (bool, WatchSnapshotPayload) {
	status := hub.service.Status(ctx)
	metrics := hub.service.Metrics(ctx)
	accountsResp, _ := hub.service.Accounts(ctx)
	accounts := accountsResp.Accounts
	if accounts == nil {
		accounts = []ManagementAccount{}
	}

	comparableStatus := status
	comparableStatus.UptimeSec = 0
	comparableMetrics := metrics
	comparableMetrics.Memory = nil
	comparableMetrics.RequestBodyBudget = nil
	comparableBytes, _ := json.Marshal(struct {
		Status   StatusResponse      `json:"status"`
		Metrics  MetricsResponse     `json:"metrics"`
		Accounts []ManagementAccount `json:"accounts"`
	}{
		Status:   comparableStatus,
		Metrics:  comparableMetrics,
		Accounts: accounts,
	})
	comparable := string(comparableBytes)

	hub.mu.Lock()
	changed := comparable != hub.lastSerialized
	if changed {
		hub.lastSerialized = comparable
		hub.revision++
	}
	rev := hub.revision
	hub.mu.Unlock()

	return changed, WatchSnapshotPayload{
		Type:     "snapshot",
		Revision: rev,
		Status:   status,
		Metrics:  metrics,
		Accounts: accounts,
	}
}

func (hub *WatchHub) broadcast(payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return
	}
	hub.mu.Lock()
	targets := make([]*watchSubscriber, 0, len(hub.subscribers))
	for sub := range hub.subscribers {
		targets = append(targets, sub)
	}
	hub.mu.Unlock()

	for _, sub := range targets {
		select {
		case <-sub.done:
			continue
		case sub.events <- encoded:
		default:
			// 丢弃积压旧帧后重推最新帧，避免慢消费者阻塞整个广播组。
			select {
			case <-sub.events:
			default:
			}
			select {
			case sub.events <- encoded:
			case <-sub.done:
			default:
			}
		}
	}
}
