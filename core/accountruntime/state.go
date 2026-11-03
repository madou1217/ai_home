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
	lastFailureAt   time.Time
}

// ModelStateSnapshot 是 ModelState 的可持久化投影，用于跨进程恢复 cooldown。
//
// 该值只承载失败分类与时间，不含账号凭据、请求内容或 Provider 原文。字段全部导出
// 是因为它要经过持久化边界；从存储读回时必须经 RestoreModelState 重新校验，不能直接
// 构造 ModelState。
type ModelStateSnapshot struct {
	StreakKind      FailureKind
	StreakCount     uint8
	StreakExpiresAt time.Time
	CooldownKind    FailureKind
	CooldownUntil   time.Time
	LastFailureAt   time.Time
}

// Snapshot 返回当前状态的持久化投影。
func (state ModelState) Snapshot() ModelStateSnapshot {
	return ModelStateSnapshot{
		StreakKind:      state.streakKind,
		StreakCount:     state.streakCount,
		StreakExpiresAt: state.streakExpiresAt,
		CooldownKind:    state.cooldownKind,
		CooldownUntil:   state.cooldownUntil,
		LastFailureAt:   state.lastFailureAt,
	}
}

// RestoreModelState 校验持久化投影后重建不可变状态。
//
// streak 与 cooldown 都没有时返回零状态：这与 prune 的语义一致，只留下 lastFailureAt
// 的状态本来就会在下一次 Evaluate 被清空，不需要单独保留，也不算损坏。
func RestoreModelState(
	snapshot ModelStateSnapshot,
) (ModelState, error) {
	if !validPersistedStreak(snapshot) ||
		!validPersistedCooldown(snapshot) ||
		!validPersistedFailureTime(snapshot.LastFailureAt) {
		return ModelState{}, ErrInvalidFailure
	}
	state := ModelState{
		streakKind:    snapshot.StreakKind,
		streakCount:   snapshot.StreakCount,
		cooldownKind:  snapshot.CooldownKind,
		cooldownUntil: normalizeOptionalRuntimeTime(snapshot.CooldownUntil),
		streakExpiresAt: normalizeOptionalRuntimeTime(
			snapshot.StreakExpiresAt,
		),
		lastFailureAt: normalizeOptionalRuntimeTime(snapshot.LastFailureAt),
	}
	if state.streakExpiresAt.IsZero() && state.cooldownUntil.IsZero() {
		return ModelState{}, nil
	}
	if state.lastFailureAt.IsZero() {
		// lastFailureAt 只在 prune 的「streak 与 cooldown 都到期」分支被清零，因此
		// 有 streak 或 cooldown 却没有 lastFailureAt 的行不是本实现写出的。
		return ModelState{}, ErrInvalidFailure
	}
	return state, nil
}

// validPersistedStreak 要求 streak 的分类、计数和到期时间三者同时存在或同时缺席。
func validPersistedStreak(snapshot ModelStateSnapshot) bool {
	if snapshot.StreakKind == "" {
		return snapshot.StreakCount == 0 && snapshot.StreakExpiresAt.IsZero()
	}
	return isCooldownKind(snapshot.StreakKind) &&
		snapshot.StreakCount >= 1 &&
		isRuntimeTime(snapshot.StreakExpiresAt)
}

// validPersistedCooldown 要求 cooldown 的分类与解除时间同时存在或同时缺席。
func validPersistedCooldown(snapshot ModelStateSnapshot) bool {
	if snapshot.CooldownKind == "" {
		return snapshot.CooldownUntil.IsZero()
	}
	return isCooldownKind(snapshot.CooldownKind) &&
		isRuntimeTime(snapshot.CooldownUntil)
}

// validPersistedFailureTime 接受零值，否则要求可跨进程比较的毫秒时间。
func validPersistedFailureTime(value time.Time) bool {
	return value.IsZero() || isRuntimeTime(value)
}

// isCooldownKind 只接受会写入模型 cooldown 的失败分类。
func isCooldownKind(kind FailureKind) bool {
	policy, err := PolicyFor(kind)
	return err == nil && policy.EntersCooldown()
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
	if state.lastFailureAt.Before(failure.OccurredAt()) {
		state.lastFailureAt = failure.OccurredAt()
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

// Succeed 只允许未早于最后失败的成功清除当前元组瞬态状态。
func (state ModelState) Succeed(
	happenedAt time.Time,
) (ModelState, error) {
	if !isRuntimeTime(happenedAt) {
		return ModelState{}, ErrInvalidRuntimeTime
	}
	happenedAt = normalizeRuntimeTime(happenedAt)
	if state.lastFailureAt.After(happenedAt) {
		return state, nil
	}
	return ModelState{}, nil
}

// ActiveCooldown 返回 now 时仍生效的 cooldown 类型与解除时间；只读，不修改状态。
func (state ModelState) ActiveCooldown(now time.Time) (FailureKind, time.Time, bool) {
	if state.cooldownUntil.IsZero() || !state.cooldownUntil.After(now) {
		return "", time.Time{}, false
	}
	return state.cooldownKind, state.cooldownUntil, true
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
	if state.cooldownUntil.IsZero() && state.streakExpiresAt.IsZero() {
		state.lastFailureAt = time.Time{}
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

// normalizeOptionalRuntimeTime 保留零值语义，只对非零时间做毫秒归一。
//
// 不能直接对零值调用 normalizeRuntimeTime：零值会被换算成 1970 年附近的时间，
// 破坏 ModelState.IsZero 与 prune 的稀疏不变量。
func normalizeOptionalRuntimeTime(value time.Time) time.Time {
	if value.IsZero() {
		return time.Time{}
	}
	return normalizeRuntimeTime(value)
}
