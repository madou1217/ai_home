package accountscheduling

import (
	"math"
	"strings"
	"time"

	schedcore "github.com/madou1217/ai_home/core/accountscheduling"
)

// modelFailureCapacity 表示"模型容量不足"的失败类别（与运行态持久化口径一致）。
const modelFailureCapacity = "model_capacity_unavailable"

// DefaultPolicy 是所有 Provider 共用的通用规则：静态事实 + 运行态阻塞 + 冷却 + 额度。
//
// 它不包含任何 Provider 专属知识：Provider 需要不同语义时实现自己的 Policy 并注册，
// 而不是在这里加分支。
type DefaultPolicy struct {
	providerID string
	// now 可注入，便于按调用方时钟判定；默认 time.Now。
	now func() time.Time
}

// NewDefaultPolicy 构造通用策略。
func NewDefaultPolicy(providerID string) *DefaultPolicy {
	return &DefaultPolicy{providerID: strings.TrimSpace(providerID), now: time.Now}
}

// ProviderID 返回该策略适用的 Provider。
func (policy *DefaultPolicy) ProviderID() string { return policy.providerID }

// EvaluateAccount 判定账号整体能否接客。
func (policy *DefaultPolicy) EvaluateAccount(evidence Evidence) schedcore.Verdict {
	if !evidence.Account.Enabled {
		return schedcore.Blocked(schedcore.ReasonAccountDisabled)
	}
	for _, reason := range evidence.Observed.AccountReasons {
		if verdict := blockedBy(reason); !verdict.Schedulable() {
			return verdict
		}
	}
	now := policy.clock()
	if reason := strings.TrimSpace(evidence.Observed.RoutingBlockReason); reason != "" {
		return schedcore.Blocked(schedcore.Reason(reason))
	}
	// 路由硬阻塞到期后进入单请求试探期：已有在途请求时其余并发不蜂拥。
	if until := evidence.Observed.RoutingBlockUntil; !until.IsZero() && !until.After(now) &&
		evidence.Observed.AccountInFlight > 0 {
		return schedcore.Blocked(schedcore.ReasonRoutingBlockProbe)
	}
	if !evidence.Observed.AccountCooldownUntil.IsZero() && evidence.Observed.AccountCooldownUntil.After(now) {
		return schedcore.BlockedUntil(schedcore.ReasonAccountCooldown, evidence.Observed.AccountCooldownUntil)
	}
	if !evidence.Account.APIKeyMode {
		if remaining := evidence.Account.RemainingPct; remaining != nil && !math.IsNaN(*remaining) && *remaining <= 0 {
			return schedcore.Blocked(schedcore.ReasonQuotaExhausted)
		}
		if strings.EqualFold(strings.TrimSpace(evidence.Account.QuotaStatus), "exhausted") ||
			strings.TrimSpace(evidence.Account.SchedulableStatus) == "blocked_by_quota" {
			return schedcore.Blocked(schedcore.ReasonQuotaExhausted)
		}
	}
	if !allowsLiveRuntimeRecheck(evidence.Account.SchedulableStatus) {
		return schedcore.Blocked(schedcore.ReasonRuntimeBlocked)
	}
	return schedcore.Allowed("")
}

// EvaluateModel 判定该账号的这个模型能否接客。
//
// 模型级失败只代表"这一对（账号, 模型）"不可用：账号仍然保留，调度器换模型即可。
func (policy *DefaultPolicy) EvaluateModel(evidence Evidence) schedcore.Verdict {
	// 目录/设置收窄是"这个账号对这个模型"的事实：只拦这一对，账号继续参与其他模型。
	if evidence.Model.Excluded {
		reason := evidence.Model.ExcludeReason
		if strings.TrimSpace(string(reason)) == "" {
			reason = schedcore.ReasonModelNotInCatalog
		}
		return schedcore.Blocked(reason)
	}
	if evidence.Model.CatalogKnown && !evidence.Model.InCatalog {
		return schedcore.Blocked(schedcore.ReasonModelNotInCatalog)
	}
	now := policy.clock()
	if !evidence.Observed.ModelCooldownUntil.IsZero() && evidence.Observed.ModelCooldownUntil.After(now) {
		return schedcore.BlockedUntil(schedcore.ReasonModelCooldown, evidence.Observed.ModelCooldownUntil)
	}
	if strings.TrimSpace(evidence.Observed.ModelFailureKind) == modelFailureCapacity && evidence.Observed.ModelInFlight > 0 {
		return schedcore.Blocked(schedcore.ReasonModelCapacityRecovery)
	}
	for _, reason := range evidence.Observed.ModelReasons {
		if verdict := blockedBy(reason); !verdict.Schedulable() {
			return verdict
		}
	}
	if until := evidence.Observed.RuntimeModelCooldownUntil; !until.IsZero() && until.After(now) {
		return schedcore.BlockedUntil(schedcore.ReasonModelCooldown, until)
	}
	if verdict := blockedBy(evidence.Eligibility.Route); !verdict.Schedulable() {
		return verdict
	}
	if verdict := blockedBy(evidence.Eligibility.UsageGate); !verdict.Schedulable() {
		return verdict
	}
	return schedcore.Allowed("")
}

// QuotaPlan 交付账号自己的额度档位顺序（按快照原序：聚合档在前）。
//
// API Key 模式没有额度档位语义，返回空表示不区分档位、也不据此拦截。
func (policy *DefaultPolicy) QuotaPlan(evidence Evidence) []schedcore.Bucket {
	if evidence.Account.APIKeyMode {
		return nil
	}
	return evidence.Buckets
}

func (policy *DefaultPolicy) clock() time.Time {
	if policy != nil && policy.now != nil {
		return policy.now()
	}
	return time.Now()
}

// blockedBy 把原因码转成判定；空码即放行。
func blockedBy(reason schedcore.Reason) schedcore.Verdict {
	if strings.TrimSpace(string(reason)) == "" {
		return schedcore.Allowed("")
	}
	return schedcore.Blocked(reason)
}

// allowsLiveRuntimeRecheck 只放行"没有阻塞"或"仍可实时复核"的静态状态。
func allowsLiveRuntimeRecheck(schedulableStatus string) bool {
	status := strings.TrimSpace(schedulableStatus)
	return status == "" ||
		status == "schedulable" ||
		status == "blocked_by_runtime_status"
}
