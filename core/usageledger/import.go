package usageledger

import (
	"strings"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// ImportEvent 是一条从 Node 历史用量导入的 token 事实。
//
// 与 Record 的区别：Record 由推理链路在成功时产生，字段已经过 inference.Usage 校验；
// 这里的数据来自 Node 的 model_usage_records（event_key 作为幂等键），可能包含
// 已删除账号或早期口径的行，所以逐条校验、坏行跳过而不是整批失败。
type ImportEvent struct {
	SourceKey             string
	AccountRef            accountcore.AccountRef
	Provider              string
	Model                 string
	SessionID             string
	OccurredAt            time.Time
	InputTokens           int
	OutputTokens          int
	CachedInputTokens     int
	CacheWriteInputTokens int
	ReasoningTokens       int
	TotalTokens           int
}

// IsValid 复核与 usage_ledger 表 CHECK 约束同口径的不变量。
func (event ImportEvent) IsValid() bool {
	provider := strings.TrimSpace(strings.ToLower(event.Provider))
	model := strings.TrimSpace(event.Model)
	sessionID := strings.TrimSpace(event.SessionID)
	if strings.TrimSpace(event.SourceKey) == "" || len(event.SourceKey) > 200 {
		return false
	}
	if !event.AccountRef.IsValid() || provider == "" || model == "" ||
		len(provider) > 64 || len(model) > 256 || len(sessionID) > 256 {
		return false
	}
	if event.OccurredAt.IsZero() || event.InputTokens < 0 || event.OutputTokens < 0 ||
		event.CachedInputTokens < 0 || event.CacheWriteInputTokens < 0 ||
		event.ReasoningTokens < 0 || event.TotalTokens < 1 {
		return false
	}
	if event.CachedInputTokens+event.CacheWriteInputTokens > event.InputTokens {
		return false
	}
	if event.ReasoningTokens > event.OutputTokens {
		return false
	}
	return event.TotalTokens == event.InputTokens+event.OutputTokens
}
