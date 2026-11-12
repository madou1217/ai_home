// 本文件复刻 lib/account/agy-auth-recovery.js。
//
// agy 的 auth_invalid 有两条完全不同的结论，必须分开：
//
//  1. 不可恢复（isNonRecoverableAgyAuthInvalidBlock）：原因记录为 agy_not_signed_in。
//     这不是「token 过期」而是「用户没登录」，普通流量成功、刷新 token、读用量都不能
//     推翻它，只认登录成功 / 人工清除 / 成功用量探测。这条闸门已经落在
//     core/accounts/status_transition.go 的 canClearStatusRuntime 里（本包不重复实现）。
//
//  2. 可恢复（canRecoverAgyAuthInvalidBlock）：auth_invalid 但**没有任何记录原因**，
//     说明是旧版本留下的空块；此时本地 OAuth 凭据仍可用（access token 未过期或持有
//     refresh token）就足以证明「不是认证问题」。静态凭据只能修这种旧块——有原因的
//     失败必须等主动证据（登录 / 刷新 / 上游流量 / 用量探测）成功，否则一个过期的
//     access token 会反复把真实失败洗成健康。
package authmeta

import (
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/accounts/agy"
)

const (
	// RecoverableOAuthEvidence 是 Node 的 AGY_RECOVERABLE_OAUTH_EVIDENCE。
	// 它是并行期两端对拍的键，也是 Go 侧 core/accounts 里同名的证据值
	// （StatusEventAgyOAuthCredentialsRecoverable）。
	RecoverableOAuthEvidence = "agy_oauth_credentials_recoverable"

	// nonRecoverableAuthInvalidReasonNotSignedIn 对应 Node 的
	// AGY_NON_RECOVERABLE_AUTH_INVALID_REASONS 唯一成员。
	nonRecoverableAuthInvalidReasonNotSignedIn = "agy_not_signed_in"

	// runtimeStatusAuthInvalid 是运行态里的认证失效状态词。
	runtimeStatusAuthInvalid = "auth_invalid"
	// runtimeStatusHealthy 是 ResolveRuntimeStatus 恢复后返回的状态词。
	runtimeStatusHealthy = "healthy"
)

// RuntimeStatus 是 Node runtimeStatus 的最小投影。
//
// Node 的运行时对象可能来自 account_runtime_state（status/until/reason），也可能来自
// 运行池记录（带 detail / lastFailureReason / lastError）。这些字段都参与「失败原因」
// 的归一化，缺一个就会把「有原因的失败」误判成「无原因旧块」。
type RuntimeStatus struct {
	Status            string
	UntilMS           int64
	Reason            string
	Detail            string
	LastFailureReason string
	LastError         string
}

// NewRuntimeStatus 是给调用点用的便捷构造器（Node 的 {status, until, reason}）。
func NewRuntimeStatus(status string, untilMS int64, reason string) RuntimeStatus {
	return RuntimeStatus{Status: status, UntilMS: untilMS, Reason: reason}
}

// IsAuthInvalid 复刻 isAuthInvalidRuntimeStatus：状态词大小写/空白不敏感。
func (status RuntimeStatus) IsAuthInvalid() bool {
	return status.IsStatus(runtimeStatusAuthInvalid)
}

// IsStatus 判断运行态是否为指定状态词。
func (status RuntimeStatus) IsStatus(value string) bool {
	return NormalizeStatus(status.Status) == NormalizeStatus(value)
}

// NormalizeReason 复刻 normalizeRuntimeReason：
// 按 reason → detail → lastFailureReason → lastError 取**第一个非空字符串**
// （空白串在 JS 里是真值，会被选中；所以它在 trim 之后就是空原因）。
// 这是「旧空块」判定的关键：把 trim 提前到选字段之前会改变结论。
func (status RuntimeStatus) NormalizeReason() string {
	for _, value := range []string{
		status.Reason,
		status.Detail,
		status.LastFailureReason,
		status.LastError,
	} {
		if value != "" {
			return strings.ToLower(strings.TrimSpace(value))
		}
	}
	return ""
}

// NormalizeStatus 复刻 normalizeRuntimeStatus：接受状态对象或裸字符串，统一小写去空白。
func NormalizeStatus(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

// IsNonRecoverableAuthInvalidBlock 复刻 isNonRecoverableAgyAuthInvalidBlock。
func IsNonRecoverableAuthInvalidBlock(provider string, status RuntimeStatus) bool {
	return isAgyProvider(provider) &&
		status.IsAuthInvalid() &&
		status.NormalizeReason() == nonRecoverableAuthInvalidReasonNotSignedIn
}

// CanRecoverAuthInvalidBlock 复刻 canRecoverAgyAuthInvalidBlock。
//
// 三个条件必须同时成立：agy、auth_invalid、没有任何记录原因（旧块），且本地凭据仍
// 可恢复。有原因的失败一律不在这里恢复。
func CanRecoverAuthInvalidBlock(
	provider string,
	status RuntimeStatus,
	metadata Metadata,
	now time.Time,
) bool {
	return isAgyProvider(provider) &&
		status.IsAuthInvalid() &&
		status.NormalizeReason() == "" &&
		HasRecoverableCredentials(metadata, now)
}

// ResolveRuntimeStatus 复刻 resolveAgyRuntimeStatus：
// 可恢复时对外呈现 healthy（until=0、reason 为空），否则原样返回。
func ResolveRuntimeStatus(
	provider string,
	status RuntimeStatus,
	metadata Metadata,
	now time.Time,
) RuntimeStatus {
	if !CanRecoverAuthInvalidBlock(provider, status, metadata, now) {
		return status
	}
	return RuntimeStatus{Status: runtimeStatusHealthy}
}

// isAgyProvider 复刻 isAgyProvider：大小写与空白不敏感。
func isAgyProvider(provider string) bool {
	return strings.ToLower(strings.TrimSpace(provider)) == agy.ProviderID
}
