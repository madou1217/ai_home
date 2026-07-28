package accountruntime

import "time"

// EligibilityStatus 是账号参与指定模型征召前的稳定判定结果。
type EligibilityStatus string

const (
	// EligibilityAvailable 表示当前运行态允许继续解析凭据。
	EligibilityAvailable EligibilityStatus = "available"
	// EligibilityCredentialBlocked 表示必须更新凭据后才能再次征召。
	EligibilityCredentialBlocked EligibilityStatus = "credential_blocked"
	// EligibilityQuotaBlocked 表示必须等待新 usage 快照确认额度恢复。
	EligibilityQuotaBlocked EligibilityStatus = "quota_blocked"
	// EligibilityPolicyBlocked 表示账号、模型或地区策略当前不允许调用。
	EligibilityPolicyBlocked EligibilityStatus = "policy_blocked"
	// EligibilityModelCooldown 表示账号与目标模型仍在有限等待时间内。
	EligibilityModelCooldown EligibilityStatus = "model_cooldown"
)

// Eligibility 是不携带凭据和错误原文的路由资格值。
type Eligibility struct {
	status      EligibilityStatus
	retryAt     time.Time
	failureKind FailureKind
}

// AvailableEligibility 创建允许继续征召的资格值。
func AvailableEligibility() Eligibility {
	return Eligibility{status: EligibilityAvailable}
}

// CredentialBlockedEligibility 创建不会随时间自动恢复的凭据阻塞。
func CredentialBlockedEligibility() Eligibility {
	return Eligibility{status: EligibilityCredentialBlocked}
}

// QuotaBlockedEligibility 创建由 usage 快照负责解除的额度阻塞。
func QuotaBlockedEligibility() Eligibility {
	return Eligibility{status: EligibilityQuotaBlocked}
}

// PolicyBlockedEligibility 创建由外部策略变化负责解除的阻塞。
func PolicyBlockedEligibility() Eligibility {
	return Eligibility{status: EligibilityPolicyBlocked}
}

// modelCooldownEligibility 创建带明确恢复时间的模型 cooldown。
func modelCooldownEligibility(
	retryAt time.Time,
	failureKind FailureKind,
) Eligibility {
	return Eligibility{
		status:      EligibilityModelCooldown,
		retryAt:     retryAt,
		failureKind: failureKind,
	}
}

// Status 返回稳定资格状态。
func (eligibility Eligibility) Status() EligibilityStatus {
	return eligibility.status
}

// Eligible 判断当前资格是否允许继续访问凭据。
func (eligibility Eligibility) Eligible() bool {
	return eligibility.status == EligibilityAvailable
}

// RetryAt 只对模型 cooldown 返回有限恢复时间。
func (eligibility Eligibility) RetryAt() time.Time {
	return eligibility.retryAt
}

// FailureKind 返回触发模型 cooldown 的稳定低敏失败类型。
func (eligibility Eligibility) FailureKind() FailureKind {
	return eligibility.failureKind
}

// IsValid 判断资格状态和恢复时间是否匹配。
func (eligibility Eligibility) IsValid() bool {
	switch eligibility.status {
	case EligibilityAvailable,
		EligibilityCredentialBlocked,
		EligibilityQuotaBlocked,
		EligibilityPolicyBlocked:
		return eligibility.retryAt.IsZero() && eligibility.failureKind == ""
	case EligibilityModelCooldown:
		policy, err := PolicyFor(eligibility.failureKind)
		return isRuntimeTime(eligibility.retryAt) &&
			err == nil &&
			policy.EntersCooldown()
	default:
		return false
	}
}
