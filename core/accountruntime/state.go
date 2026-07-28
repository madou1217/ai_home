package accountruntime

import (
	"errors"
	"time"
)

var (
	// ErrInvalidFailure 表示失败事件的类型、时间或恢复提示无效。
	ErrInvalidFailure = errors.New("账号运行态失败事件无效")
	// ErrInvalidRuntimeTime 表示运行态判断时间无法形成稳定 UTC 毫秒。
	ErrInvalidRuntimeTime = errors.New("账号运行态时间无效")
)

// Failure 是 Provider 适配器提交给运行态领域的低敏失败事件。
type Failure struct {
	kind       FailureKind
	occurredAt time.Time
	retryAfter time.Duration
}

// NewFailure 创建不包含响应正文、Token 或请求内容的失败事件。
func NewFailure(
	kind FailureKind,
	occurredAt time.Time,
	retryAfter time.Duration,
) (Failure, error) {
	if _, err := PolicyFor(kind); err != nil ||
		!isRuntimeTime(occurredAt) ||
		retryAfter < 0 ||
		retryAfter > MaxCooldownHint ||
		retryAfter%time.Millisecond != 0 {
		return Failure{}, ErrInvalidFailure
	}
	return Failure{
		kind:       kind,
		occurredAt: normalizeRuntimeTime(occurredAt),
		retryAfter: retryAfter,
	}, nil
}

// Kind 返回稳定失败分类。
func (failure Failure) Kind() FailureKind {
	return failure.kind
}

// OccurredAt 返回毫秒精度的 UTC 发生时间。
func (failure Failure) OccurredAt() time.Time {
	return failure.occurredAt
}

// RetryAfter 返回 Provider 明确给出的有限恢复提示。
func (failure Failure) RetryAfter() time.Duration {
	return failure.retryAfter
}

// Transition 描述失败事件应交给的状态边界和 cooldown 结果。
type Transition struct {
	action        FailureAction
	failureCount  uint8
	cooldownUntil time.Time
}

// Action 返回调用方必须执行的唯一状态动作。
func (transition Transition) Action() FailureAction {
	return transition.action
}

// FailureCount 返回当前同类连续失败次数。
func (transition Transition) FailureCount() uint8 {
	return transition.failureCount
}

// CoolingDown 判断当前事件是否已经触发模型 cooldown。
func (transition Transition) CoolingDown() bool {
	return !transition.cooldownUntil.IsZero()
}

// CooldownUntil 返回模型允许自动重试的最早时间。
func (transition Transition) CooldownUntil() time.Time {
	return transition.cooldownUntil
}

// ModelState 是单个账号与模型元组的紧凑瞬态状态。
//
// 硬阻塞和 quota 不存入该值；零值表示当前没有 streak 或 cooldown。
type ModelState struct {
	streakKind      FailureKind
	streakCount     uint8
	streakExpiresAt time.Time
	cooldownKind    FailureKind
	cooldownUntil   time.Time
}

// Apply 按固定策略计算一个失败事件的新不可变状态。
func (state ModelState) Apply(
	failure Failure,
) (ModelState, Transition, error) {
	policy, err := PolicyFor(failure.Kind())
	if err != nil || !isRuntimeTime(failure.OccurredAt()) {
		return ModelState{}, Transition{}, ErrInvalidFailure
	}
	state = state.prune(failure.OccurredAt())
	transition := Transition{action: policy.Action()}
	if !policy.EntersCooldown() {
		state.clearStreak()
		return state, transition, nil
	}

	count := uint8(1)
	if state.streakKind == failure.Kind() &&
		state.streakExpiresAt.After(failure.OccurredAt()) {
		count = saturatingIncrement(state.streakCount)
	}
	transition.failureCount = count
	if policy.FailureThreshold() > 1 {
		state.streakKind = failure.Kind()
		state.streakCount = count
		state.streakExpiresAt = failure.OccurredAt().Add(
			policy.FailureWindow(),
		)
	}
	if count < policy.FailureThreshold() {
		return state, transition, nil
	}

	cooldown := policy.DefaultCooldown()
	if failure.RetryAfter() > 0 {
		cooldown = failure.RetryAfter()
	}
	until := failure.OccurredAt().Add(cooldown)
	if !isRuntimeTime(until) {
		return ModelState{}, Transition{}, ErrInvalidFailure
	}
	until = normalizeRuntimeTime(until)
	if state.cooldownUntil.After(until) {
		until = state.cooldownUntil
	}
	state.cooldownKind = failure.Kind()
	state.cooldownUntil = until
	if policy.FailureThreshold() == 1 {
		state.clearStreak()
	} else if state.streakExpiresAt.Before(until) {
		state.streakExpiresAt = until
	}
	transition.cooldownUntil = until
	return state, transition, nil
}

// Evaluate 清理过期数据并返回当前模型的路由资格。
func (state ModelState) Evaluate(
	now time.Time,
) (ModelState, Eligibility, error) {
	if !isRuntimeTime(now) {
		return ModelState{}, Eligibility{}, ErrInvalidRuntimeTime
	}
	state = state.prune(normalizeRuntimeTime(now))
	if state.cooldownUntil.IsZero() {
		return state, AvailableEligibility(), nil
	}
	return state, modelCooldownEligibility(
		state.cooldownUntil,
		state.cooldownKind,
	), nil
}

// Succeed 清除当前账号与模型元组的全部瞬态失败状态。
func (state ModelState) Succeed() ModelState {
	return ModelState{}
}

// IsZero 判断该元组是否无需占用稀疏运行态索引。
func (state ModelState) IsZero() bool {
	return state == ModelState{}
}

// prune 删除已经到期的 streak 和 cooldown。
func (state ModelState) prune(now time.Time) ModelState {
	if !state.cooldownUntil.After(now) {
		state.cooldownKind = ""
		state.cooldownUntil = time.Time{}
	}
	if !state.streakExpiresAt.After(now) {
		state.clearStreak()
	}
	return state
}

// clearStreak 清除连续失败计数但保留仍生效的 cooldown。
func (state *ModelState) clearStreak() {
	state.streakKind = ""
	state.streakCount = 0
	state.streakExpiresAt = time.Time{}
}

// saturatingIncrement 防止长期重复故障让紧凑计数器回绕为零。
func saturatingIncrement(value uint8) uint8 {
	if value == ^uint8(0) {
		return value
	}
	return value + 1
}

// isRuntimeTime 判断时间能否安全参与跨进程毫秒级比较。
func isRuntimeTime(value time.Time) bool {
	return !value.IsZero() &&
		value.Year() >= 1970 &&
		value.Year() <= 9999
}

// normalizeRuntimeTime 把运行态时间统一为 UTC 毫秒精度。
func normalizeRuntimeTime(value time.Time) time.Time {
	return time.UnixMilli(value.UnixMilli()).UTC()
}
