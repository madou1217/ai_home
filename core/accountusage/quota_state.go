package accountusage

import "strings"

// QuotaState 是账号级额度状态；字段与 Node 的 deriveQuotaState 输出同构。
//
// 该状态只描述「额度事实」，不包含运行态阻塞与探针失败：那些由调用方（Node 运行池 /
// in-memory 探针状态）叠加，避免把瞬时网络错误固化进数据库。
type QuotaState struct {
	Status              string
	Reason              string
	RemainingPct        *float64
	HasNumericRemaining bool
}

// QuotaStateInput 是派生账号级额度状态所需的全部事实。
type QuotaStateInput struct {
	// Kind 是 Provider 快照类型（例如 codex_oauth_status）。
	Kind string
	// FallbackSource 是采集降级来源（例如 auth_json / account_read）。
	FallbackSource string
	// PlanType 是套餐类型（例如 team / free）。
	PlanType string
	// Remaining 是归一化快照推导出的账号级剩余额度。
	Remaining Remaining
}

const (
	// QuotaStateAvailable 表示仍有已知剩余额度。
	QuotaStateAvailable = "available"
	// QuotaStateExhausted 表示已知剩余额度为零。
	QuotaStateExhausted = "exhausted"
	// QuotaStatePending 表示快照存在但还没有可用的数值额度。
	QuotaStatePending = "pending"
	// QuotaStateNotApplicable 表示该账号没有可消耗的额度池。
	QuotaStateNotApplicable = "not_applicable"
)

// DeriveQuotaState 按与 Node 相同的口径派生账号级额度状态。
//
// 只覆盖「有快照」的账号：Provider 不支持额度、API Key 模式与探针失败在调用方更早判定，
// 不属于这里的事实。Codex 的 Team/Free 账号在上游不返回 rate limits 时仍然是可用账号，
// 必须以 pending 进入账号池等待下次刷新，而不是被当成不可用。
func DeriveQuotaState(input QuotaStateInput) QuotaState {
	if input.Remaining.Known {
		pct := float64(input.Remaining.BasisPoints) / 100
		status := QuotaStateAvailable
		if input.Remaining.BasisPoints == 0 {
			status = QuotaStateExhausted
		}
		return QuotaState{
			Status:              status,
			RemainingPct:        &pct,
			HasNumericRemaining: true,
		}
	}
	kind := strings.TrimSpace(input.Kind)
	fallbackSource := strings.TrimSpace(input.FallbackSource)
	planType := strings.ToLower(strings.TrimSpace(input.PlanType))
	if kind == "codex_oauth_status" {
		switch fallbackSource {
		case "auth_json":
			return QuotaState{Status: QuotaStatePending, Reason: "auth_metadata_only"}
		case "account_read":
			switch planType {
			case "team":
				return QuotaState{
					Status: QuotaStatePending,
					Reason: "codex_team_plan_pending_rate_limits",
				}
			case "free":
				return QuotaState{
					Status: QuotaStatePending,
					Reason: "codex_free_plan_pending_rate_limits",
				}
			}
		}
	}
	return QuotaState{
		Status: QuotaStatePending,
		Reason: "provider_returned_no_numeric_usage",
	}
}
