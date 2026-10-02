package codexresponsesws

import (
	"encoding/json"
	"sync"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// 额度耗尽时的换号：Go 在首帧选定账号后对整条连接原样透传，账号中途耗尽时上游错误
// 被转给 Codex，Codex 报 "You've hit your usage limit" 并停下，连接仍绑在耗尽的账号上。
//
// 实测 Codex 0.159：连接以 1011 关闭（或 response.failed server_error）时会静默新开连接，
// 不带 previous_response_id、带完整上下文重发；只有额度错误帧会让它直接报错。因此本轮尚未
// 向客户端交出任何非预备帧时，额度耗尽（已记入运行态，重新选号会跳过该账号）不转发，改以
// 1011 关闭，让 Codex 自己在新连接上重试。已交出输出后照旧透传，绝不重放。
//
// 换号后完整上下文里的 reasoning.encrypted_content 只能被原账号解密，新账号会 400
// invalid_encrypted_content；按 Codex 的 session-id 记住上次服务的账号，账号变了就在
// 完整上下文请求（无 previous_response_id）里剥掉它。

const (
	maxHeldPreambleFrames    = 16
	sessionAccountTTL        = 12 * time.Hour
	maxSessionAccountEntries = 4096
	quotaFailoverCloseReason = "account quota exhausted"
)

var preambleEventTypes = map[string]struct{}{
	"response.created":     {},
	"response.in_progress": {},
	"response.queued":      {},
}

func upstreamEventType(payload []byte) string {
	var event struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(payload, &event) != nil {
		return ""
	}
	return event.Type
}

func isPreambleEvent(payload []byte) bool {
	_, ok := preambleEventTypes[upstreamEventType(payload)]
	return ok
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
