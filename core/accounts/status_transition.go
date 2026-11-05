package accounts

import (
	"errors"
	"math"
	"strings"
	"time"
)

// 本文件把 Node 的账号运行态状态转移落成 Go 的纯函数。
//
// 事实源是 lib/account/state-service.js 的四个写入口：
//   - recordRuntimeState：整份运行态文档替换 / 清空；
//   - recordRuntimeFailure：外部已分类的运行态失败写入；
//   - recordRuntimeSuccess / clearRuntimeBlock：成功证据撤销运行态阻塞。
//
// 被它们内联调用的规则也一并搬过来：lib/server/account-runtime-state.js 的
// normalizeAccountRuntime / clearBlockingAccountRuntimeState /
// clearAccountWideRuntimeState / deriveAccountRuntimeStatus，
// lib/account/quota-runtime-recovery.js 的额度快照恢复，
// lib/account/agy-auth-recovery.js 的 agy 不可恢复标记。
//
// 迁移口径是「原样搬运」：分支顺序、证据白名单、provider 特例、时间比较都保持与 Node
// 相同的顺序。这里刻意不做「更好的设计」——任何改良都会让并行期 Node/Go 的逐账号比对
// 出现无法解释的分歧，而那段比对正是切换读路径的前提。
//
// 状态形状与 Node 的 runtime_state 文档同构：账号级时间桶 + routingBlock + 按模型的
// 冷却/连败。零值表示「没有运行态文档」，对应 Node 的 runtimeState = null。
//
// 不在这里的 state-service 入口：getAccountState 只读；syncAccountBaseState /
// setOperationalStatus 写的是账号元数据与生命周期状态（up/down），不改变 runtime_state；
// deleteAccount / pruneMissing 是索引操作。status 的生命周期写入按计划 §7-d 单独切
// account_ui_state.status，不混进运行态转移。

var (
	// ErrInvalidStatusEvent 表示事件的时间、provider 或失败载荷不完整。
	ErrInvalidStatusEvent = errors.New("账号状态事件无效")
	// ErrUnknownStatusEventKind 表示调用方提交了未登记的状态事件。
	ErrUnknownStatusEventKind = errors.New("账号状态事件类型未知")
)

// StatusRecheckInterval 是一次失败观察形成的路由阻塞的默认复核间隔。
//
// 与 Node 的 ROUTING_BLOCK_RECHECK_MS 同值：上游没有给出恢复时刻时，阻塞不是永久态，
// 到期后由一次真实请求重新验证。core/accounts 不能反向依赖 core/accountruntime，
// 所以这里保留同值常量；跨层调用方应通过 StatusPolicy.BlockRecheckInterval 传入
// accountruntime.BlockRecheckInterval，避免两份值各自漂移。
const StatusRecheckInterval = 30 * time.Second

const (
	statusProviderCodex = "codex"
	statusProviderAgy   = "agy"

	statusAuthInvalid = "auth_invalid"

	// routingBlock 只接受 Node 认可的三种阻塞类型；其它 kind 在归一化时被丢弃。
	statusBlockBillingBlocked   = "billing_blocked"
	statusBlockQuotaExhausted   = "quota_exhausted"
	statusBlockPermissionDenied = "permission_denied"

	// agy 地区资格失败被记为 permission_denied + 这个 reason 片段。
	statusAgyRegionBlockReason = "agy_region_not_eligible"
	// agy 的这个失败是「用户没登录」，只有主动登录类证据能推翻。
	statusAgyNonRecoverableReason = "agy_not_signed_in"
	// 容量退避的连败记录要在冷却到期后继续保留，供下一次恢复探测判断退避倍数。
	statusModelCapacityUnavailableKind = "model_capacity_unavailable"
)

// StatusEventKind 是状态转移的唯一事件类型。
//
// 除 runtime_state / runtime_failure 外，其余值直接使用 Node 的 evidence 字符串：
// 证据名就是两端并行比对的键，改名会让日志与排查口径分叉。
type StatusEventKind string

const (
	// StatusEventRuntimeState 对应 recordRuntimeState：整份文档替换；State 为空表示清空。
	StatusEventRuntimeState StatusEventKind = "runtime_state"
	// StatusEventRuntimeFailure 对应 recordRuntimeFailure：写入一次已分类的失败观察。
	StatusEventRuntimeFailure StatusEventKind = "runtime_failure"

	// 以下证据全部来自 Node 的 RUNTIME_CLEAR_EVIDENCE，任何一个都能撤销账号级阻塞的
	// 相应部分；具体清到哪一层由下面的分支与 provider 决定。
	StatusEventDirectUsageSuccess             StatusEventKind = "direct_usage_success"
	StatusEventDirectRateLimitSuccess         StatusEventKind = "direct_rate_limit_success"
	StatusEventAgyOAuthCredentialsRecoverable StatusEventKind = "agy_oauth_credentials_recoverable"
	StatusEventAPIKeyConfigVerified           StatusEventKind = "api_key_config_verified"
	StatusEventCredentialConfigVerified       StatusEventKind = "credential_config_verified"
	StatusEventCredentialUpdateAfterFailure   StatusEventKind = "credential_update_after_failure"
	StatusEventLoginSuccess                   StatusEventKind = "login_success"
	StatusEventManualAdminClear               StatusEventKind = "manual_admin_clear"
	StatusEventModelsProbeSuccess             StatusEventKind = "models_probe_success"
	StatusEventNativeSessionSuccess           StatusEventKind = "native_session_success"
	StatusEventAccessTokenStillValid          StatusEventKind = "access_token_still_valid"
	StatusEventTokenRefreshSuccess            StatusEventKind = "token_refresh_success"
	StatusEventUpstreamSuccess                StatusEventKind = "upstream_success"
	StatusEventVerifiedUsageSuccess           StatusEventKind = "verified_usage_success"
	StatusEventAgyUsageProbeVerified          StatusEventKind = "agy_usage_probe_verified"
)

// StatusClearScope 是 manual_admin_clear 的作用范围。
//
// 零值表示清除整个账号运行态；StatusClearRoutingBlock 只摘掉当前路由阻塞，保留
// 其它失败类型与按模型的状态（WebUI 的「恢复调度」按钮走这条）。
type StatusClearScope string

const (
	// StatusClearRoutingBlock 只解除 routingBlock。
	StatusClearRoutingBlock StatusClearScope = "routing_block"
)

// StatusRoutingBlock 是账号级硬阻塞（账单 / 额度 / 权限）。
//
// 这几个失败没有永久态：每个阻塞都带复核时刻，到期后选号器只放行一个试探请求。
// RecheckManual 对应 Node 的 recheck: 'manual'——上游风控这类反复试探只会放大伤害的
// 情形只认人工恢复。
type StatusRoutingBlock struct {
	Kind          string
	Reason        string
	ObservedAt    time.Time
	Until         time.Time
	RecheckManual bool
}

// StatusModelFailureStreak 是按 (账号, 模型) 记录的连续失败。
type StatusModelFailureStreak struct {
	Kind       string
	Count      int
	ExpiresAt  time.Time
	Reason     string
	ObservedAt time.Time
}

// StatusState 是 Node runtime_state 文档的 Go 投影。
//
// 字段全部导出是因为它就是一份要跨层传递、与 Node 文档逐字段对齐的快照；调用方应把它
// 当作值使用，ApplyStatusEvent 不会修改传入值（内部的 map 会先复制）。
type StatusState struct {
	CooldownUntil       time.Time
	ConsecutiveFailures int
	SuccessCount        int
	FailCount           int
	LastError           string
	LastFailureKind     string
	LastFailureReason   string
	LastFailureAt       time.Time
	LastSuccessAt       time.Time

	RateLimitUntil          time.Time
	AuthInvalidUntil        time.Time
	OverloadUntil           time.Time
	NetworkUntil            time.Time
	ServiceUnavailableUntil time.Time
	UpstreamErrorUntil      time.Time

	RoutingBlock        *StatusRoutingBlock
	ModelCooldowns      map[string]time.Time
	ModelFailureStreaks map[string]StatusModelFailureStreak
}

// IsZero 判断当前是否等价于 Node 的 runtimeState = null。
func (state StatusState) IsZero() bool {
	return state.CooldownUntil.IsZero() &&
		state.ConsecutiveFailures == 0 &&
		state.SuccessCount == 0 &&
		state.FailCount == 0 &&
		state.LastError == "" &&
		state.LastFailureKind == "" &&
		state.LastFailureReason == "" &&
		state.LastFailureAt.IsZero() &&
		state.LastSuccessAt.IsZero() &&
		state.RateLimitUntil.IsZero() &&
		state.AuthInvalidUntil.IsZero() &&
		state.OverloadUntil.IsZero() &&
		state.NetworkUntil.IsZero() &&
		state.ServiceUnavailableUntil.IsZero() &&
		state.UpstreamErrorUntil.IsZero() &&
		state.RoutingBlock == nil &&
		len(state.ModelCooldowns) == 0 &&
		len(state.ModelFailureStreaks) == 0
}

// StatusFailure 是一次已经分类的上游失败观察。
//
// Kind 使用 Node 的失败词（runtime_state.lastFailureKind）。其中 billing_blocked /
// quota_exhausted / permission_denied 会形成 routingBlock，其余只写各自的时间桶。
// Cooldown 是上游给出的恢复提示；为 0 时按策略默认值复核。
type StatusFailure struct {
	Kind          string
	Reason        string
	Cooldown      time.Duration
	RecheckManual bool
}

// StatusUsageEntry 是一条额度窗口事实。
//
// RemainingPct 为 nil 表示 Node 里的 null 或空串（没有可信读数），不能用 0 代替：
// 0 是「明确用完」，两者对恢复判断的结论相反。
type StatusUsageEntry struct {
	RemainingPct *float64
}

// StatusUsageSnapshot 是触发 quota 恢复的那份额度快照。
type StatusUsageSnapshot struct {
	SchemaVersion  int
	Kind           string
	Source         string
	FallbackSource string
	CapturedAt     time.Time
	Entries        []StatusUsageEntry
}

// StatusEvent 是一个待应用的状态事件。
type StatusEvent struct {
	Kind StatusEventKind
	// At 是事件被观察到的时刻，也是本次转移的判定时刻。
	At time.Time
	// Failure 只用于 StatusEventRuntimeFailure。
	Failure *StatusFailure
	// State 只用于 StatusEventRuntimeState；nil 表示清空运行态。
	State *StatusState
	// Usage 只用于 quota / agy 地区恢复类证据。
	Usage *StatusUsageSnapshot
	// Scope 只用于 StatusEventManualAdminClear。
	Scope StatusClearScope
}

// StatusPolicy 是转移需要的静态配置。
type StatusPolicy struct {
	// Provider 是规范化 provider id（大小写不敏感）。
	Provider string
	// BlockRecheckInterval 缺失时使用 StatusRecheckInterval。
	BlockRecheckInterval time.Duration
}

// ApplyStatusEvent 对当前运行态应用一个事件，返回新运行态。
//
// 无转移时返回归一化后的当前值（Node 的 return false）；永不清空调用方传入的值。
// 只有结构性输入错误才返回 error，与 Node 的「证据不在白名单就静默不写」保持区别：
// 那种情况在 Go 里是未登记的事件类型，属于调用方 bug。
func ApplyStatusEvent(current StatusState, event StatusEvent, policy StatusPolicy) (StatusState, error) {
	provider := strings.ToLower(strings.TrimSpace(policy.Provider))
	if provider == "" {
		return StatusState{}, ErrInvalidStatusEvent
	}
	if !validStatusTime(event.At) {
		return StatusState{}, ErrInvalidStatusEvent
	}
	recheck := policy.BlockRecheckInterval
	if recheck <= 0 {
		recheck = StatusRecheckInterval
	}
	if !knownStatusEvent(event.Kind) {
		return StatusState{}, ErrUnknownStatusEventKind
	}

	now := normalizeStatusTime(event.At)
	state := normalizeStatusState(current, now, recheck)

	switch event.Kind {
	case StatusEventRuntimeState:
		// recordRuntimeState：Node 原样存调用方文档；Go 在边界立即归一，使从旧库读回的
		// 文档也满足同一不变量（Node 的写入方本来就会先归一）。
		if event.State == nil {
			return StatusState{}, nil
		}
		return normalizeStatusState(*event.State, now, recheck), nil
	case StatusEventRuntimeFailure:
		return applyStatusFailure(state, event, recheck)
	default:
		return clearStatusRuntime(state, provider, event, recheck), nil
	}
}

func knownStatusEvent(kind StatusEventKind) bool {
	switch kind {
	case StatusEventRuntimeState,
		StatusEventRuntimeFailure,
		StatusEventDirectUsageSuccess,
		StatusEventDirectRateLimitSuccess,
		StatusEventAgyOAuthCredentialsRecoverable,
		StatusEventAPIKeyConfigVerified,
		StatusEventCredentialConfigVerified,
		StatusEventCredentialUpdateAfterFailure,
		StatusEventLoginSuccess,
		StatusEventManualAdminClear,
		StatusEventModelsProbeSuccess,
		StatusEventNativeSessionSuccess,
		StatusEventAccessTokenStillValid,
		StatusEventTokenRefreshSuccess,
		StatusEventUpstreamSuccess,
		StatusEventVerifiedUsageSuccess,
		StatusEventAgyUsageProbeVerified:
		return true
	default:
		return false
	}
}

// applyStatusFailure 复刻 account-runtime-state.js 的 touchAccountFailureState。
//
// 它只更新失败时间、原因和对应的时间桶；连续失败计数由更上层的门禁维护，这里不越界。
// 失败 streak 的复用也不在这里判断——Node 在 markProxyAccountFailure 里做，Go 侧由
// accountruntime.ModelState 负责，两者不要重复记账。
func applyStatusFailure(state StatusState, event StatusEvent, recheck time.Duration) (StatusState, error) {
	failure := event.Failure
	if failure == nil || strings.TrimSpace(failure.Kind) == "" || failure.Cooldown < 0 {
		return StatusState{}, ErrInvalidStatusEvent
	}
	now := normalizeStatusTime(event.At)
	until := now.Add(failure.Cooldown)
	state.LastFailureKind = failure.Kind
	state.LastFailureReason = failure.Reason
	state.LastFailureAt = now

	switch failure.Kind {
	case statusBlockBillingBlocked, statusBlockQuotaExhausted, statusBlockPermissionDenied:
		reason := failure.Reason
		if reason == "" {
			// Node 在读取时用 reason || kind 兜底；这里直接写成归一后的值。
			reason = failure.Kind
		}
		block := StatusRoutingBlock{
			Kind:       failure.Kind,
			Reason:     reason,
			ObservedAt: now,
		}
		if failure.RecheckManual {
			block.RecheckManual = true
			state.RoutingBlock = &block
			return state, nil
		}
		recheckAt := now.Add(recheck)
		if failure.Cooldown > 0 {
			recheckAt = until
		}
		// 同类阻塞再次被观察到时复核时刻只往后推：更短的新观察不能把一个上游给出的
		// 恢复时刻提前（同 Node 的 Math.max）。
		if previous := state.RoutingBlock; previous != nil && previous.Kind == failure.Kind && previous.Until.After(recheckAt) {
			recheckAt = previous.Until
		}
		block.Until = recheckAt
		state.RoutingBlock = &block
		return state, nil
	}

	if until.After(state.CooldownUntil) {
		state.CooldownUntil = until
	}
	switch failure.Kind {
	case "rate_limited":
		state.RateLimitUntil = laterStatusTime(state.RateLimitUntil, until)
	case statusAuthInvalid:
		state.AuthInvalidUntil = laterStatusTime(state.AuthInvalidUntil, until)
	case "overloaded":
		state.OverloadUntil = laterStatusTime(state.OverloadUntil, until)
	case "timeout", "network_error":
		state.NetworkUntil = laterStatusTime(state.NetworkUntil, until)
	case "service_unavailable":
		state.ServiceUnavailableUntil = laterStatusTime(state.ServiceUnavailableUntil, until)
	case "upstream_server_error":
		state.UpstreamErrorUntil = laterStatusTime(state.UpstreamErrorUntil, until)
	}
	return state, nil
}

// clearStatusRuntime 复刻 clearRuntimeBlock 的分支树。
//
// 顺序不能调整：先做 agy 不可恢复闸门，再处理 codex 的额度/凭据证据，最后才是
// 「未到复核时刻的 routingBlock 只认人工清除」和三段人工清除。Node 的这个顺序来自
// 生产事故：到期的阻塞必须允许别的证据（例如凭据刷新）先撤销它能证明的部分，
// 但阻塞本身是否解除要单独判断。
func clearStatusRuntime(state StatusState, provider string, event StatusEvent, recheck time.Duration) StatusState {
	// 本地没有运行态时，Node 只清 Go 侧残留并在 base state 上返回成功；这里对应零值。
	if state.IsZero() {
		return StatusState{}
	}
	if !canClearStatusRuntime(provider, state, event.Kind, event.At) {
		return state
	}

	// codex 的 verified_usage_success 带快照时走额度恢复，不再落入通用清除：
	// 额度真相只撤销被新快照推翻的额度失败，不清凭据、权限、账单或网络状态。
	if provider == statusProviderCodex && event.Kind == StatusEventVerifiedUsageSuccess && event.Usage != nil {
		next := recoverQuotaStatusState(state, event.Usage)
		// 真额度接口成功也能证明凭据有效：快照比最后一次失败新，且当前派生结论是
		// auth_invalid 时，单独摘掉 authInvalidUntil（其它并发失败仍保留）。
		if trustedCodexSnapshot(event.Usage) &&
			event.Usage.CapturedAt.After(state.LastFailureAt) &&
			statusKind(state, event.At) == statusAuthInvalid {
			next.AuthInvalidUntil = time.Time{}
			next.CooldownUntil = maxStatusTime(
				next.RateLimitUntil,
				next.OverloadUntil,
				next.NetworkUntil,
				next.ServiceUnavailableUntil,
				next.UpstreamErrorUntil,
			)
		}
		return next
	}

	// agy 地区资格块：用量探测打的就是做资格判定的端点，所以「探测成功且不早于该失败」
	// 是「当前地区已可用」的直接证据。这一条不能落进下面的 routingBlock 硬闸门。
	if statusAgyRegionClearEvidence[event.Kind] &&
		provider == statusProviderAgy &&
		isStatusAgyRegionBlock(state) &&
		hasStatusProbeNewerThanFailure(event.Usage, state) {
		next := state
		next.RoutingBlock = nil
		return clearAccountWideStatusState(next, event.At, recheck)
	}

	// 未到复核时刻的路由阻塞只认人工清除：账单 / 权限 / 额度能不能用，只有真的用一次
	// 才知道，探测和刷新 token 都证明不了。
	if statusRoutingBlockActive(state.RoutingBlock, event.At) && event.Kind != StatusEventManualAdminClear {
		return state
	}

	// 人工「恢复调度」只摘路由阻塞。若最后失败就是这条阻塞，连失败时间一起复位，
	// 否则账号页会一直显示上一条阻塞原因。
	if event.Kind == StatusEventManualAdminClear && event.Scope == StatusClearRoutingBlock {
		block := state.RoutingBlock
		if block == nil {
			return state
		}
		next := state
		next.RoutingBlock = nil
		if next.LastFailureKind == block.Kind {
			next.LastFailureKind = ""
			next.LastFailureReason = ""
			next.LastError = ""
			next.LastFailureAt = time.Time{}
			next.ConsecutiveFailures = 0
			next.CooldownUntil = maxStatusTime(
				next.AuthInvalidUntil,
				next.RateLimitUntil,
				next.OverloadUntil,
				next.NetworkUntil,
				next.ServiceUnavailableUntil,
				next.UpstreamErrorUntil,
			)
		}
		return next
	}

	// 人工清除整份账号运行态：保留按模型的冷却/连败（别的模型不该被一起放出来）。
	if event.Kind == StatusEventManualAdminClear {
		next := state
		next.RoutingBlock = nil
		return clearAccountWideStatusState(next, event.At, recheck)
	}

	// codex 换凭据只推翻「旧凭据失效」这一条结论：并发的限流、网络失败和按模型状态
	// 都是独立事实，必须原样保留（2026-10-30 套餐升级后 auth_invalid 一直挂着，就是
	// 因为缺少这条只清 auth 的路径）。
	if provider == statusProviderCodex &&
		statusCredentialEvidence[event.Kind] &&
		statusKind(state, event.At) == statusAuthInvalid {
		next := state
		next.AuthInvalidUntil = time.Time{}
		if !next.CooldownUntil.After(state.AuthInvalidUntil) {
			next.CooldownUntil = maxStatusTime(
				next.RateLimitUntil,
				next.OverloadUntil,
				next.NetworkUntil,
				next.ServiceUnavailableUntil,
				next.UpstreamErrorUntil,
			)
		}
		if next.LastFailureKind == statusAuthInvalid {
			next.LastError = ""
			next.LastFailureKind = ""
			next.LastFailureReason = ""
			next.LastFailureAt = time.Time{}
			next.ConsecutiveFailures = 0
		}
		return next
	}

	// 到期阻塞只有「真实流量成功」能解除：探测、刷新 token、读用量都证明不了账单/权限。
	// 其它证据只清它们自己能证明的部分，阻塞保留给选号器放行一次试探请求。
	if state.RoutingBlock != nil && statusRecheckSuccessEvidence[event.Kind] {
		state.RoutingBlock = nil
	}
	return clearAccountWideStatusState(state, event.At, recheck)
}

// canClearStatusRuntime 是 agy 不可恢复认证失效的闸门。
//
// agy 的 agy_not_signed_in 不是「凭据过期」而是「用户没登录」：普通成功证据（例如
// 一次上游请求恰好走通）不能把它当成已恢复，只接受主动登录、人工清除和成功用量探测。
func canClearStatusRuntime(provider string, state StatusState, evidence StatusEventKind, now time.Time) bool {
	if provider != statusProviderAgy || !isStatusNonRecoverableAgyAuthInvalid(state, now) {
		return true
	}
	return statusNonRecoverableClearEvidence[evidence]
}

func isStatusNonRecoverableAgyAuthInvalid(state StatusState, now time.Time) bool {
	kind, reason := deriveStatus(state, now)
	return kind == statusAuthInvalid &&
		strings.ToLower(strings.TrimSpace(reason)) == statusAgyNonRecoverableReason
}

// isStatusAgyRegionBlock 只认 agy 的 permission_denied + 地区资格原因。
func isStatusAgyRegionBlock(state StatusState) bool {
	block := state.RoutingBlock
	return block != nil &&
		block.Kind == statusBlockPermissionDenied &&
		strings.Contains(block.Reason, statusAgyRegionBlockReason)
}

// hasStatusProbeNewerThanFailure 要求探测采集时间不早于最后一次失败。
func hasStatusProbeNewerThanFailure(usage *StatusUsageSnapshot, state StatusState) bool {
	if usage == nil || usage.CapturedAt.IsZero() {
		return false
	}
	return !usage.CapturedAt.Before(state.LastFailureAt)
}

// recoverQuotaStatusState 复刻 quota-runtime-recovery.js。
//
// 只删除「失败时间早于快照采集时间」的额度失败：快照采集之后又发生的额度失败说明
// 新快照已经过时，不能被它推翻。
func recoverQuotaStatusState(state StatusState, snapshot *StatusUsageSnapshot) StatusState {
	if !trustedAvailableCodexSnapshot(snapshot) {
		return state
	}
	capturedAt := normalizeStatusTime(snapshot.CapturedAt)
	next := cloneStatusState(state)
	changed := false
	for model, streak := range next.ModelFailureStreaks {
		failedAt := normalizeStatusTime(streak.ObservedAt)
		if failedAt.IsZero() {
			failedAt = next.LastFailureAt
		}
		if !isQuotaStatusFailure(streak.Kind, streak.Reason) ||
			failedAt.IsZero() ||
			!capturedAt.After(failedAt) {
			continue
		}
		delete(next.ModelCooldowns, model)
		delete(next.ModelFailureStreaks, model)
		changed = true
	}
	if block := next.RoutingBlock; block != nil &&
		block.Kind == statusBlockQuotaExhausted &&
		!block.ObservedAt.IsZero() &&
		capturedAt.After(block.ObservedAt) {
		next.RoutingBlock = nil
		changed = true
	}
	hasNewerQuotaFailure := false
	for _, streak := range next.ModelFailureStreaks {
		if isQuotaStatusFailure(streak.Kind, streak.Reason) {
			hasNewerQuotaFailure = true
			break
		}
	}
	if !hasNewerQuotaFailure &&
		isQuotaStatusFailure(next.LastFailureKind, next.LastFailureReason) &&
		!next.LastFailureAt.IsZero() &&
		capturedAt.After(next.LastFailureAt) {
		next.RateLimitUntil = time.Time{}
		next.CooldownUntil = maxStatusTime(
			next.AuthInvalidUntil,
			next.OverloadUntil,
			next.NetworkUntil,
			next.ServiceUnavailableUntil,
			next.UpstreamErrorUntil,
		)
		next.LastFailureKind = ""
		next.LastFailureReason = ""
		next.LastError = ""
		next.LastFailureAt = time.Time{}
		next.ConsecutiveFailures = 0
		changed = true
	}
	if !changed {
		return state
	}
	if len(next.ModelCooldowns) == 0 {
		next.ModelCooldowns = nil
	}
	if len(next.ModelFailureStreaks) == 0 {
		next.ModelFailureStreaks = nil
	}
	return next
}

func isQuotaStatusFailure(kind, reason string) bool {
	switch kind {
	case "usage_limit_reached", "insufficient_quota", "quota_exceeded", "quota_exhausted", "model_quota_exhausted":
		return true
	}
	switch reason {
	case "usage_limit_reached", "insufficient_quota", "quota_exceeded", "quota_exhausted", "model_quota_exhausted":
		return true
	}
	return false
}

// trustedCodexSnapshot 判断快照是否来自 codex app-server 的真实状态接口。
//
// schemaVersion / kind / source 三者同时校验，是为了排除兜底来源（fallbackSource）和
// 旧格式文档——用不可信快照解除阻塞会把账号提前放回可能仍然受限的池子。
func trustedCodexSnapshot(snapshot *StatusUsageSnapshot) bool {
	return snapshot != nil &&
		snapshot.SchemaVersion == 2 &&
		snapshot.Kind == "codex_oauth_status" &&
		snapshot.Source == "codex_app_server" &&
		snapshot.FallbackSource == "" &&
		!snapshot.CapturedAt.IsZero() &&
		len(snapshot.Entries) > 0
}

// trustedAvailableCodexSnapshot 额外要求每个窗口都有正的剩余比例。
func trustedAvailableCodexSnapshot(snapshot *StatusUsageSnapshot) bool {
	if !trustedCodexSnapshot(snapshot) {
		return false
	}
	for _, entry := range snapshot.Entries {
		if entry.RemainingPct == nil {
			return false
		}
		value := *entry.RemainingPct
		if math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
			return false
		}
	}
	return true
}

// deriveStatus 复刻 deriveAccountRuntimeStatus 的优先级。
//
// 顺序不能调整：routingBlock 是硬阻塞，优先于任何冷却；之后按固定顺序检查时间桶，
// 最后才是通用 cooldownUntil。返回空 kind 表示 healthy。
func deriveStatus(state StatusState, now time.Time) (string, string) {
	if statusRoutingBlockActive(state.RoutingBlock, now) {
		return state.RoutingBlock.Kind, state.RoutingBlock.Reason
	}
	reason := state.LastFailureReason
	if reason == "" {
		reason = state.LastError
	}
	ordered := []struct {
		status string
		until  time.Time
	}{
		{statusAuthInvalid, state.AuthInvalidUntil},
		{"rate_limited", state.RateLimitUntil},
		{"overloaded", state.OverloadUntil},
		{"transient_network", state.NetworkUntil},
		{"service_unavailable", state.ServiceUnavailableUntil},
		{"upstream_error", state.UpstreamErrorUntil},
	}
	for _, entry := range ordered {
		if entry.until.After(now) {
			return entry.status, reason
		}
	}
	if state.CooldownUntil.After(now) {
		status := state.LastFailureKind
		if status == "" {
			status = "cooling_down"
		}
		return status, reason
	}
	return "healthy", ""
}

// clearAccountWideStatusState 复刻 clearAccountWideRuntimeState。
//
// 清掉账号级阻塞字段，但保留 successCount / failCount / lastSuccessAt 与按模型状态。
// 如果清完只剩这些统计字段，Node 返回 null（不保留文档）；这里返回零值。
func clearAccountWideStatusState(state StatusState, now time.Time, recheck time.Duration) StatusState {
	state.CooldownUntil = time.Time{}
	state.ConsecutiveFailures = 0
	state.LastError = ""
	state.LastFailureKind = ""
	state.LastFailureReason = ""
	state.LastFailureAt = time.Time{}
	state.RateLimitUntil = time.Time{}
	state.AuthInvalidUntil = time.Time{}
	state.OverloadUntil = time.Time{}
	state.NetworkUntil = time.Time{}
	state.ServiceUnavailableUntil = time.Time{}
	state.UpstreamErrorUntil = time.Time{}
	state = normalizeStatusState(state, now, recheck)
	if state.RoutingBlock != nil || len(state.ModelCooldowns) > 0 || len(state.ModelFailureStreaks) > 0 {
		return state
	}
	return StatusState{}
}

// normalizeStatusState 复刻 normalizeAccountRuntime。
//
// Node 在每次写入前都做这一步，保证从旧库读出的文档也满足同样的不变量；Go 在函数
// 边界重做一次，读路径就不需要再各自记得归一化。
func normalizeStatusState(state StatusState, now time.Time, recheck time.Duration) StatusState {
	state = cloneStatusState(state)
	state.CooldownUntil = normalizeStatusTime(state.CooldownUntil)
	state.LastFailureAt = normalizeStatusTime(state.LastFailureAt)
	state.LastSuccessAt = normalizeStatusTime(state.LastSuccessAt)
	state.RateLimitUntil = normalizeStatusTime(state.RateLimitUntil)
	state.AuthInvalidUntil = normalizeStatusTime(state.AuthInvalidUntil)
	state.OverloadUntil = normalizeStatusTime(state.OverloadUntil)
	state.NetworkUntil = normalizeStatusTime(state.NetworkUntil)
	state.ServiceUnavailableUntil = normalizeStatusTime(state.ServiceUnavailableUntil)
	state.UpstreamErrorUntil = normalizeStatusTime(state.UpstreamErrorUntil)
	state.ConsecutiveFailures = maxStatusInt(state.ConsecutiveFailures)
	state.SuccessCount = maxStatusInt(state.SuccessCount)
	state.FailCount = maxStatusInt(state.FailCount)
	state.RoutingBlock = normalizeStatusRoutingBlock(state.RoutingBlock, recheck)
	normalizeStatusModelState(&state, now)
	return state
}

// normalizeStatusRoutingBlock 补齐历史数据缺失的复核时刻。
//
// 早期版本把没有 until 的阻塞写成「只能人工清除」，读出时按 observedAt + 复核间隔
// 补齐——任何写入路径都锁不死一个账号。recheck: 'manual' 是唯一的例外。
func normalizeStatusRoutingBlock(block *StatusRoutingBlock, recheck time.Duration) *StatusRoutingBlock {
	if block == nil {
		return nil
	}
	switch block.Kind {
	case statusBlockBillingBlocked, statusBlockQuotaExhausted, statusBlockPermissionDenied:
	default:
		// Node 的 normalizeRoutingBlock 对未知 kind 返回 null，派生时当作没有阻塞。
		return nil
	}
	normalized := StatusRoutingBlock{
		Kind:       block.Kind,
		Reason:     block.Reason,
		ObservedAt: normalizeStatusTime(block.ObservedAt),
	}
	if normalized.Reason == "" {
		normalized.Reason = normalized.Kind
	}
	if block.RecheckManual {
		normalized.RecheckManual = true
		return &normalized
	}
	normalized.Until = normalizeStatusTime(block.Until)
	if normalized.Until.IsZero() {
		normalized.Until = normalized.ObservedAt.Add(recheck)
	}
	return &normalized
}

// normalizeStatusModelState 归一化按模型的冷却与连败，并清掉过期项。
func normalizeStatusModelState(state *StatusState, now time.Time) {
	for model, until := range state.ModelCooldowns {
		normalized := normalizeStatusTime(until)
		if normalized.IsZero() {
			delete(state.ModelCooldowns, model)
			continue
		}
		state.ModelCooldowns[model] = normalized
	}
	for model, streak := range state.ModelFailureStreaks {
		streak.Kind = strings.TrimSpace(streak.Kind)
		streak.ExpiresAt = normalizeStatusTime(streak.ExpiresAt)
		streak.ObservedAt = normalizeStatusTime(streak.ObservedAt)
		if streak.Kind == "" || streak.Count < 1 || streak.ExpiresAt.IsZero() {
			delete(state.ModelFailureStreaks, model)
			continue
		}
		state.ModelFailureStreaks[model] = streak
	}

	for model, until := range state.ModelCooldowns {
		if until.After(now) {
			continue
		}
		delete(state.ModelCooldowns, model)
		// 容量退避要在冷却到期后继续记住连败，否则下一次恢复探测会退回最小退避。
		if streak, ok := state.ModelFailureStreaks[model]; !ok || streak.Kind != statusModelCapacityUnavailableKind {
			delete(state.ModelFailureStreaks, model)
		}
	}
	for model, streak := range state.ModelFailureStreaks {
		if streak.ExpiresAt.After(now) {
			continue
		}
		if until, ok := state.ModelCooldowns[model]; ok && until.After(now) {
			continue
		}
		delete(state.ModelFailureStreaks, model)
	}
	// 空的 map 与 nil 语义相同；归一成 nil 才能让零值判断和测试比较保持稳定。
	if len(state.ModelCooldowns) == 0 {
		state.ModelCooldowns = nil
	}
	if len(state.ModelFailureStreaks) == 0 {
		state.ModelFailureStreaks = nil
	}
}

// cloneStatusState 复制会被转移修改的引用字段，保证纯函数不污染调用方。
func cloneStatusState(state StatusState) StatusState {
	if state.RoutingBlock != nil {
		block := *state.RoutingBlock
		state.RoutingBlock = &block
	}
	if state.ModelCooldowns != nil {
		cooldowns := make(map[string]time.Time, len(state.ModelCooldowns))
		for model, until := range state.ModelCooldowns {
			cooldowns[model] = until
		}
		state.ModelCooldowns = cooldowns
	}
	if state.ModelFailureStreaks != nil {
		streaks := make(map[string]StatusModelFailureStreak, len(state.ModelFailureStreaks))
		for model, streak := range state.ModelFailureStreaks {
			streaks[model] = streak
		}
		state.ModelFailureStreaks = streaks
	}
	return state
}

func statusRoutingBlockActive(block *StatusRoutingBlock, now time.Time) bool {
	if block == nil {
		return false
	}
	if block.RecheckManual {
		return true
	}
	return block.Until.After(now)
}

// statusKind 是派生结论里只需要 kind 的场景的薄封装。
func statusKind(state StatusState, now time.Time) string {
	kind, _ := deriveStatus(state, now)
	return kind
}

func maxStatusInt(value int) int {
	if value < 0 {
		return 0
	}
	return value
}

func laterStatusTime(current, candidate time.Time) time.Time {
	if candidate.After(current) {
		return candidate
	}
	return current
}

func maxStatusTime(values ...time.Time) time.Time {
	var latest time.Time
	for _, value := range values {
		if value.After(latest) {
			latest = value
		}
	}
	return latest
}

const maxStatusUnixMilli = int64(253_402_300_799_999)

func validStatusTime(value time.Time) bool {
	if value.IsZero() {
		return false
	}
	return value.UnixMilli() >= 0 && value.UnixMilli() <= maxStatusUnixMilli
}

// normalizeStatusTime 把时间统一为 UTC 毫秒；0 与负数都表示「没有这个时刻」。
func normalizeStatusTime(value time.Time) time.Time {
	if value.IsZero() {
		return time.Time{}
	}
	unixMS := value.UnixMilli()
	if unixMS <= 0 {
		return time.Time{}
	}
	if unixMS > maxStatusUnixMilli {
		unixMS = maxStatusUnixMilli
	}
	return time.UnixMilli(unixMS).UTC()
}

// 证据白名单：全部来自 Node 的 RUNTIME_CLEAR_EVIDENCE。
var (
	statusCredentialEvidence = map[StatusEventKind]bool{
		StatusEventCredentialUpdateAfterFailure: true,
		StatusEventAccessTokenStillValid:        true,
	}
	statusRecheckSuccessEvidence = map[StatusEventKind]bool{
		StatusEventUpstreamSuccess:      true,
		StatusEventNativeSessionSuccess: true,
	}
	statusAgyRegionClearEvidence = map[StatusEventKind]bool{
		StatusEventVerifiedUsageSuccess:  true,
		StatusEventAgyUsageProbeVerified: true,
	}
	statusNonRecoverableClearEvidence = map[StatusEventKind]bool{
		StatusEventLoginSuccess:          true,
		StatusEventManualAdminClear:      true,
		StatusEventAgyUsageProbeVerified: true,
	}
)
