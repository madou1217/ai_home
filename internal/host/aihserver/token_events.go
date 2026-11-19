package aihserver

import (
	"sync"
	"time"

	"github.com/madou1217/ai_home/core/usageledger"
	"github.com/madou1217/ai_home/internal/runtime/sessionactivity"
)

// tokenEventBus 把 Go 推理结算的 token 用量注入账号实时流。
//
// 账号实时 Hub 在路由装配阶段才创建，而用量账本在更早的组合根里；用一个小型
// 晚绑定总线连接两者，避免把 HTTP handler 反向注入应用层。没有订阅者时 Publish
// 是空操作，不影响记账结果。
type tokenEventBus struct {
	mu      sync.RWMutex
	publish func(any)
}

func newTokenEventBus() *tokenEventBus {
	return &tokenEventBus{}
}

// SetPublisher 在账号实时 Hub 创建后绑定广播入口。
func (bus *tokenEventBus) SetPublisher(publish func(any)) {
	if bus == nil {
		return
	}
	bus.mu.Lock()
	bus.publish = publish
	bus.mu.Unlock()
}

// PublishTokenConsumed 广播一条 token-consumed 帧（字段与 Node 同名）。
func (bus *tokenEventBus) PublishTokenConsumed(record usageledger.Record) {
	if bus == nil || !record.IsValid() {
		return
	}
	bus.mu.RLock()
	publish := bus.publish
	bus.mu.RUnlock()
	if publish == nil {
		return
	}
	usage := record.Usage()
	input := usage.InputTokens() + usage.CachedInputTokens() + usage.CacheWriteInputTokens()
	output := usage.OutputTokens() + usage.ReasoningTokens()
	total := usage.TotalTokens()
	if total == 0 {
		total = input + output
	}
	if total == 0 {
		return
	}
	publish(map[string]any{
		"type":       "token-consumed",
		"provider":   record.Provider(),
		"accountRef": record.AccountRef().String(),
		"model":      record.Model(),
		"tokens": map[string]any{
			"input":  input,
			"output": output,
			"total":  total,
		},
		"occurredAt": record.OccurredAt().UnixMilli(),
	})
}

// PublishAccountActivity 广播账号活动快照变化（字段与 Node account-activity 帧同名）。
func (bus *tokenEventBus) PublishAccountActivity(snapshot map[string]sessionactivity.AccountSnapshot) {
	if bus == nil || len(snapshot) == 0 {
		return
	}
	bus.mu.RLock()
	publish := bus.publish
	bus.mu.RUnlock()
	if publish == nil {
		return
	}
	publish(map[string]any{
		"type":     "account-activity",
		"activity": snapshot,
		"at":       time.Now().UnixMilli(),
	})
}

// PublishAuthJob 广播一条 auth-job 帧。
func (bus *tokenEventBus) PublishAuthJob(job any) {
	bus.publishMessage(map[string]any{"type": "auth-job", "job": job})
}

// PublishRefreshJob 广播一条 account-refresh-job 帧。
func (bus *tokenEventBus) PublishRefreshJob(job any) {
	bus.publishMessage(map[string]any{"type": "account-refresh-job", "job": job})
}

func (bus *tokenEventBus) publishMessage(payload map[string]any) {
	if bus == nil || payload == nil {
		return
	}
	bus.mu.RLock()
	publish := bus.publish
	bus.mu.RUnlock()
	if publish != nil {
		publish(payload)
	}
}
