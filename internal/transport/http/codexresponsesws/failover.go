package codexresponsesws

import (
	"encoding/json"
	"sync"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// 可重试上游终态的换号：Go 在首帧选定账号后对整条连接原样透传，账号中途容量不足、
// 限流或额度耗尽时，若把错误帧交给 Codex，客户端会把本轮当成最终失败，连接仍绑在
// 失败账号上。实测 Codex 0.159 在 1011 关闭后会静默新开连接并带完整上下文重发。
// 因此本轮尚未向客户端交出任何非预备帧时，已记入运行态的可重试失败不转发，改以 1011
// 关闭，让 Codex 自己在新连接上重新选号。已交出输出后照旧透传，绝不重放。
//
// 换号后完整上下文里的 reasoning.encrypted_content 只能被原账号解密，新账号会 400
// invalid_encrypted_content；按 Codex 的 session-id 记住上次服务的账号，账号变了就在
// 完整上下文请求（无 previous_response_id）里剥掉它。

const (
	maxHeldPreambleFrames        = 16
	sessionAccountTTL            = 12 * time.Hour
	maxSessionAccountEntries     = 4096
	retryableFailoverCloseReason = "retryable upstream failure"
)

// preambleEventTypes 是**不携带任何输出内容**的预备事件：只有它们可以在本轮
// 尚未交付内容时被扣留、随可重试失败一起丢弃，让 Codex 换号重连。
//
// 必须与 internal/adapters/codex/responses/response_state.go 里「无副作用」的那一支保持
// 同一集合 —— 那边把 created / in_progress / queued / metadata 一视同仁地当作
// 「不产生输出」（见 responseDecoder.Apply）。漏登记 response.metadata 会直接
// 关掉换号窗口：上游在 created → in_progress 之后、真正输出之前固定发一帧
// response.metadata（实测序列 created → in_progress → metadata → error），
// 它一旦被当成「已交付内容」就会 MarkCommitted，此后的容量不足 / 过载错误
// 因 !Committed() 不成立而**不再触发 1011 换号关闭**，只能把错误帧原样透传，
// Codex 侧表现为 "stream disconnected before completion: stream closed before
// response.completed"。
var preambleEventTypes = map[string]struct{}{
	"response.created":     {},
	"response.in_progress": {},
	"response.queued":      {},
	"response.metadata":    {},
}

// isRetryableFailoverKind 限定可以在尚未输出内容时安全交给 Codex 重连的失败。
// 账号凭据、模型目录和策略错误需要把真实终态交给客户端，不能把重连当作修复。
func isRetryableFailoverKind(kind runtimecore.FailureKind) bool {
	switch kind {
	case runtimecore.FailureRateLimited,
		runtimecore.FailureModelOverloaded,
		runtimecore.FailureUpstreamUnavailable,
		runtimecore.FailureRequestTimeout,
		runtimecore.FailureConnectionReset,
		runtimecore.FailureStreamDisconnected,
		runtimecore.FailureQuotaExhausted:
		return true
	default:
		return false
	}
}

// isPreambleEvent 只扣留没有输出项的预备帧，内嵌文字或工具调用必须立即交付。
func isPreambleEvent(payload []byte) bool {
	var event struct {
		Type     string `json:"type"`
		Response struct {
			Output []json.RawMessage `json:"output"`
		} `json:"response"`
	}
	if json.Unmarshal(payload, &event) != nil {
		return false
	}
	_, ok := preambleEventTypes[event.Type]
	return ok && len(event.Response.Output) == 0
}

// stripForeignReasoning 去掉完整上下文请求里 reasoning 项的 encrypted_content；
// 带 previous_response_id 的增量请求引用的是本连接（同账号）的响应，原样保留。
func stripForeignReasoning(payload []byte) []byte {
	var frame map[string]json.RawMessage
	if json.Unmarshal(payload, &frame) != nil {
		return payload
	}
	if previous, ok := frame["previous_response_id"]; ok && string(previous) != "null" && string(previous) != `""` {
		return payload
	}
	var input []map[string]json.RawMessage
	if json.Unmarshal(frame["input"], &input) != nil {
		return payload
	}
	changed := false
	for _, item := range input {
		var itemType string
		if json.Unmarshal(item["type"], &itemType) != nil || itemType != "reasoning" {
			continue
		}
		if _, ok := item["encrypted_content"]; ok {
			delete(item, "encrypted_content")
			changed = true
		}
	}
	if !changed {
		return payload
	}
	encodedInput, err := json.Marshal(input)
	if err != nil {
		return payload
	}
	frame["input"] = encodedInput
	rewritten, err := json.Marshal(frame)
	if err != nil {
		return payload
	}
	return rewritten
}

type sessionAccountEntry struct {
	account accountcore.AccountRef
	seenAt  time.Time
}

// sessionAccounts 记住每个 Codex 会话上次由哪个账号服务（只存账号引用，不存正文）。
type sessionAccounts struct {
	mu      sync.Mutex
	entries map[string]sessionAccountEntry
}

func newSessionAccounts() *sessionAccounts {
	return &sessionAccounts{entries: make(map[string]sessionAccountEntry)}
}

// Swap 记录本次账号并返回上次账号；会话标识为空时不记录。
func (registry *sessionAccounts) Swap(
	sessionID string,
	account accountcore.AccountRef,
	now time.Time,
) (accountcore.AccountRef, bool) {
	if registry == nil || sessionID == "" {
		return "", false
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	previous, found := registry.entries[sessionID]
	if found && now.Sub(previous.seenAt) > sessionAccountTTL {
		found = false
	}
	if len(registry.entries) >= maxSessionAccountEntries {
		for key, entry := range registry.entries {
			if now.Sub(entry.seenAt) > sessionAccountTTL || len(registry.entries) >= maxSessionAccountEntries {
				delete(registry.entries, key)
			}
			if len(registry.entries) < maxSessionAccountEntries/2 {
				break
			}
		}
	}
	registry.entries[sessionID] = sessionAccountEntry{account: account, seenAt: now}
	if !found {
		return "", false
	}
	return previous.account, true
}
