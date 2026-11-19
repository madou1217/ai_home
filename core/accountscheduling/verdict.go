// Package accountscheduling 定义"账号能否被调度"的跨 Provider 契约。
//
// 这里只放契约：谁能调度、为什么不能、还有多少、什么时候再试、这次该花哪一档额度。
// 具体规则由各 Provider 的策略实现（application/accountscheduling.Policy），
// 调度器本身不写任何 Provider 专属分支。
package accountscheduling

import (
	"strings"
	"time"
)

// Reason 是稳定的调度阻塞原因码，直接作为管理面/WebUI 的对外码。
//
// 空值表示可调度。码值一旦对外就不要再改语义；新增 Provider 只加码，不加分支。
type Reason string

const (
	// ReasonAccountDisabled 表示账号被禁用或缺少可用凭据。
	ReasonAccountDisabled Reason = "account_state_unavailable"
	// ReasonRuntimeAuthInvalid 表示凭据失效，需要重新登录。
	ReasonRuntimeAuthInvalid Reason = "runtime_auth_invalid"
	// ReasonRuntimeRateLimited 表示上游限流。
	ReasonRuntimeRateLimited Reason = "runtime_rate_limited"
	// ReasonRuntimeServiceUnavailable 表示上游不可用。
	ReasonRuntimeServiceUnavailable Reason = "runtime_service_unavailable"
	// ReasonRuntimeBlocked 表示未归类的运行态阻塞。
	ReasonRuntimeBlocked Reason = "runtime_blocked"
	// ReasonAccountCooldown 表示账号整体处于冷却。
	ReasonAccountCooldown Reason = "account_cooldown"
	// ReasonRoutingBlockProbe 表示硬阻塞到期后的单请求试探期，其余并发让路。
	ReasonRoutingBlockProbe Reason = "routing_block_probe_in_flight"
	// ReasonCoolingDown 表示未归类的冷却。
	ReasonCoolingDown Reason = "cooling_down"
	// ReasonQuotaExhausted 表示额度耗尽。
	ReasonQuotaExhausted Reason = "quota_exhausted"
	// ReasonUsageGate 表示被选号前额度门禁拦下（阈值/窗口）。
	ReasonUsageGate Reason = "usage_gate"
	// ReasonModelNotInCatalog 表示该账号的模型目录里没有这个模型。
	ReasonModelNotInCatalog Reason = "model_not_in_catalog"
	// ReasonModelCooldown 表示该账号的这个模型处于冷却。
	ReasonModelCooldown Reason = "model_cooldown"
	// ReasonModelCapacityRecovery 表示模型容量恢复中的单请求试探期。
	ReasonModelCapacityRecovery Reason = "model_capacity_recovery_in_flight"
	// ReasonPolicyBlocked 表示 Provider 策略基于自身的静态事实拒绝。
	ReasonPolicyBlocked Reason = "policy_blocked"
)

// Verdict 是一次调度判定。
//
// 约定：Reason 为空即可调度；Bucket 只表达"这次该花哪一档额度"，
// 由账号策略给出，调度器不做二次选择。
type Verdict struct {
	Reason     Reason
	RetryAfter time.Time
	Bucket     string
}

// Schedulable 表示该账号（该模型）当前可以被调度。
func (verdict Verdict) Schedulable() bool { return strings.TrimSpace(string(verdict.Reason)) == "" }

// Blocked 构造一个被拒判定。
func Blocked(reason Reason) Verdict { return Verdict{Reason: reason} }

// BlockedUntil 构造一个带恢复时间的被拒判定。
func BlockedUntil(reason Reason, until time.Time) Verdict {
	return Verdict{Reason: reason, RetryAfter: until}
}

// Allowed 构造一个可调度判定，bucket 为空表示不需要区分档位。
func Allowed(bucket string) Verdict { return Verdict{Bucket: strings.TrimSpace(bucket)} }

// Bucket 是账号的一档额度。同一账号可以有多档（credits/活动赠送/套餐窗口），
// 用哪个由账号策略决定，调度器只按策略返回的顺序取第一档。
type Bucket struct {
	// ID 是策略内稳定的档位标识，用于观测与回执。
	ID string
	// RemainingBasisPoints 是剩余比例（万分比）；Known=false 表示未知。
	RemainingBasisPoints uint16
	Known                bool
	// Exhausted 表示这一档明确已经耗尽。
	Exhausted bool
	// ResetAt 是这一档的恢复时间；零值表示不会自动恢复（需要续费/换号）。
	ResetAt time.Time
}

// Usable 表示这一档现在还能花。
func (bucket Bucket) Usable() bool {
	return !bucket.Exhausted && (!bucket.Known || bucket.RemainingBasisPoints > 0)
}
