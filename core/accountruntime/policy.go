// Package accountruntime 定义账号与模型运行态的纯领域规则。
//
// 该包只区分失败动作、短期模型 cooldown 和路由资格，不依赖数据库、
// HTTP 状态码、Provider SDK、Server 或具体时钟实现。
package accountruntime

import (
	"errors"
	"time"
)

const (
	// MaxCooldownHint 是瞬态故障允许携带的最长显式恢复提示。
	//
	// 超过一天的限制必须进入 quota 或 policy 阻塞，不能伪装成长 cooldown。
	MaxCooldownHint = 24 * time.Hour
)

var (
	// ErrUnknownFailureKind 表示 Provider 适配器提交了未注册的失败分类。
	ErrUnknownFailureKind = errors.New("账号运行态失败类型未知")
)

// FailureKind 是 Codex 与 Claude 上游结果的稳定低敏分类。
type FailureKind string

const (
	// FailureRateLimited 表示普通请求速率限制，不包含额度窗口耗尽。
	FailureRateLimited FailureKind = "rate_limited"
	// FailureModelOverloaded 表示目标模型容量不足或 Claude 529。
	FailureModelOverloaded FailureKind = "model_overloaded"
	// FailureUpstreamUnavailable 表示目标模型对应的上游 5xx 暂时不可用。
	FailureUpstreamUnavailable FailureKind = "upstream_unavailable"
	// FailureRequestTimeout 表示请求在上游完成前超时。
	FailureRequestTimeout FailureKind = "request_timeout"
	// FailureConnectionReset 表示连接被重置或等价网络断开。
	FailureConnectionReset FailureKind = "connection_reset"
	// FailureStreamDisconnected 表示流在协议完成事件前中断。
	FailureStreamDisconnected FailureKind = "stream_disconnected"
	// FailureCredentialRejected 表示上游拒绝当前账号凭据。
	FailureCredentialRejected FailureKind = "credential_rejected"
	// FailureReauthenticationRequired 表示 Refresh Token 已失效。
	FailureReauthenticationRequired FailureKind = "reauthentication_required"
	// FailureQuotaExhausted 表示明确的额度窗口或模型额度已经耗尽。
	FailureQuotaExhausted FailureKind = "quota_exhausted"
	// FailureBillingBlocked 表示账号账单状态阻止继续使用。
	FailureBillingBlocked FailureKind = "billing_blocked"
	// FailureWorkspaceDeactivated 表示 Provider 工作区或账号已停用。
	FailureWorkspaceDeactivated FailureKind = "workspace_deactivated"
	// FailureModelUnsupported 表示账号或 Provider 不支持目标模型。
	FailureModelUnsupported FailureKind = "model_unsupported"
	// FailureRegionUnsupported 表示当前地区不允许调用目标能力。
	FailureRegionUnsupported FailureKind = "region_unsupported"
	// FailureInvalidRequest 表示当前请求参数或上下文无效。
	FailureInvalidRequest FailureKind = "invalid_request"
	// FailureNotFound 表示当前请求访问的上游资源不存在。
	FailureNotFound FailureKind = "not_found"
	// FailureSafetyRejected 表示当前内容被 Provider 安全策略拒绝。
	FailureSafetyRejected FailureKind = "safety_rejected"
	// FailureMalformedResponse 表示响应结构无法按目标协议解释。
	FailureMalformedResponse FailureKind = "malformed_response"
	// FailureRequestCancelled 表示调用方主动取消当前请求。
	FailureRequestCancelled FailureKind = "request_cancelled"
	// FailureUnclassified 表示已有证据不足以确定稳定失败类型。
	FailureUnclassified FailureKind = "unclassified"
)

// FailureAction 描述一个失败应交给哪个单一状态边界处理。
type FailureAction string

const (
	// ActionNoStateChange 表示只结束当前请求，不修改账号运行态。
	ActionNoStateChange FailureAction = "no_state_change"
	// ActionCredentialBlock 表示凭据必须更新后才能解除的硬阻塞。
	ActionCredentialBlock FailureAction = "credential_block"
	// ActionQuotaBlock 表示等待明确 reset 或新 usage 快照的额度阻塞。
	ActionQuotaBlock FailureAction = "quota_block"
	// ActionPolicyBlock 表示等待账号、模型或地区策略变化的硬阻塞。
	ActionPolicyBlock FailureAction = "policy_block"
	// ActionModelCooldown 表示当前账号与模型元组可在有限时间后自动重试。
	ActionModelCooldown FailureAction = "model_cooldown"
)

// FailurePolicy 是一个失败类型不可变的状态动作合同。
type FailurePolicy struct {
	action          FailureAction
	threshold       uint8
	defaultCooldown time.Duration
	failureWindow   time.Duration
}

// PolicyFor 返回失败类型唯一允许的状态动作。
func PolicyFor(kind FailureKind) (FailurePolicy, error) {
	switch kind {
	case FailureRateLimited:
		return modelCooldownPolicy(1, 5*time.Minute, 0), nil
	case FailureModelOverloaded:
		return modelCooldownPolicy(1, time.Minute, 0), nil
	case FailureUpstreamUnavailable:
		return modelCooldownPolicy(1, 30*time.Second, 0), nil
	case FailureRequestTimeout,
		FailureConnectionReset,
		FailureStreamDisconnected:
		return modelCooldownPolicy(2, 30*time.Second, time.Minute), nil
	case FailureCredentialRejected, FailureReauthenticationRequired:
		return blockingPolicy(ActionCredentialBlock), nil
	case FailureQuotaExhausted, FailureBillingBlocked:
		return blockingPolicy(ActionQuotaBlock), nil
	case FailureWorkspaceDeactivated,
		FailureModelUnsupported,
		FailureRegionUnsupported:
		return blockingPolicy(ActionPolicyBlock), nil
	case FailureInvalidRequest,
		FailureNotFound,
		FailureSafetyRejected,
		FailureMalformedResponse,
		FailureRequestCancelled,
		FailureUnclassified:
		return blockingPolicy(ActionNoStateChange), nil
	default:
		return FailurePolicy{}, ErrUnknownFailureKind
	}
}

// Action 返回该失败唯一允许的状态动作。
func (policy FailurePolicy) Action() FailureAction {
	return policy.action
}

// FailureThreshold 返回触发 cooldown 所需的同类连续失败次数。
func (policy FailurePolicy) FailureThreshold() uint8 {
	return policy.threshold
}

// DefaultCooldown 返回没有 Provider 恢复提示时的短期等待时长。
func (policy FailurePolicy) DefaultCooldown() time.Duration {
	return policy.defaultCooldown
}

// FailureWindow 返回同类失败允许累计的最长时间窗口。
func (policy FailurePolicy) FailureWindow() time.Duration {
	return policy.failureWindow
}

// EntersCooldown 判断该策略是否属于有限时间自动恢复。
func (policy FailurePolicy) EntersCooldown() bool {
	return policy.action == ActionModelCooldown
}

// modelCooldownPolicy 创建只作用于账号与模型元组的瞬态策略。
func modelCooldownPolicy(
	threshold uint8,
	defaultCooldown time.Duration,
	failureWindow time.Duration,
) FailurePolicy {
	return FailurePolicy{
		action:          ActionModelCooldown,
		threshold:       threshold,
		defaultCooldown: defaultCooldown,
		failureWindow:   failureWindow,
	}
}

// blockingPolicy 创建不会写入 cooldown 的显式状态动作。
func blockingPolicy(action FailureAction) FailurePolicy {
	return FailurePolicy{action: action}
}
