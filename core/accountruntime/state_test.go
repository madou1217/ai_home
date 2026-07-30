package accountruntime

import (
	"errors"
	"testing"
	"time"
)

// TestModelStateAppliesImmediateCooldown 验证明确瞬态故障立即形成模型级 cooldown。
func TestModelStateAppliesImmediateCooldown(t *testing.T) {
	t.Parallel()

	now := runtimeTestTime()
	failure := newRuntimeTestFailure(
		t,
		FailureRateLimited,
		now,
		2*time.Minute,
	)

	state, transition, err := (ModelState{}).Apply(failure)
	if err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	if !transition.CoolingDown() ||
		transition.Action() != ActionModelCooldown ||
		transition.FailureCount() != 1 ||
		!transition.CooldownUntil().Equal(now.Add(2*time.Minute)) {
		t.Fatalf("Apply() transition = %#v", transition)
	}

	activeState, eligibility, err := state.Evaluate(now.Add(time.Minute))
	if err != nil {
		t.Fatalf("Evaluate(active) error = %v", err)
	}
	if eligibility.Status() != EligibilityModelCooldown ||
		eligibility.Eligible() ||
		eligibility.FailureKind() != FailureRateLimited ||
		!eligibility.RetryAt().Equal(now.Add(2*time.Minute)) ||
		activeState.IsZero() {
		t.Fatalf(
			"Evaluate(active) state=%#v eligibility=%#v",
			activeState,
			eligibility,
		)
	}

	expiredState, eligibility, err := state.Evaluate(now.Add(2 * time.Minute))
	if err != nil {
		t.Fatalf("Evaluate(expired) error = %v", err)
	}
	if !eligibility.Eligible() || !expiredState.IsZero() {
		t.Fatalf(
			"Evaluate(expired) state=%#v eligibility=%#v",
			expiredState,
			eligibility,
		)
	}
}

// TestModelStateRequiresSameTransientFailureKind 验证网络类故障只有同类连续失败才触发。
func TestModelStateRequiresSameTransientFailureKind(t *testing.T) {
	t.Parallel()

	now := runtimeTestTime()
	first := newRuntimeTestFailure(
		t,
		FailureStreamDisconnected,
		now,
		0,
	)
	state, transition, err := (ModelState{}).Apply(first)
	if err != nil {
		t.Fatalf("Apply(first) error = %v", err)
	}
	if transition.CoolingDown() || transition.FailureCount() != 1 {
		t.Fatalf("Apply(first) transition = %#v", transition)
	}

	different := newRuntimeTestFailure(
		t,
		FailureConnectionReset,
		now.Add(10*time.Second),
		0,
	)
	state, transition, err = state.Apply(different)
	if err != nil {
		t.Fatalf("Apply(different) error = %v", err)
	}
	if transition.CoolingDown() || transition.FailureCount() != 1 {
		t.Fatalf("Apply(different) transition = %#v", transition)
	}

	secondSame := newRuntimeTestFailure(
		t,
		FailureConnectionReset,
		now.Add(20*time.Second),
		0,
	)
	_, transition, err = state.Apply(secondSame)
	if err != nil {
		t.Fatalf("Apply(secondSame) error = %v", err)
	}
	if !transition.CoolingDown() ||
		transition.FailureCount() != 2 ||
		!transition.CooldownUntil().Equal(now.Add(50*time.Second)) {
		t.Fatalf("Apply(secondSame) transition = %#v", transition)
	}
}

// TestModelStateExpiresFailureStreak 验证过期 streak 不参与下一次失败累计。
func TestModelStateExpiresFailureStreak(t *testing.T) {
	t.Parallel()

	now := runtimeTestTime()
	first := newRuntimeTestFailure(t, FailureRequestTimeout, now, 0)
	state, _, err := (ModelState{}).Apply(first)
	if err != nil {
		t.Fatalf("Apply(first) error = %v", err)
	}
	afterWindow := newRuntimeTestFailure(
		t,
		FailureRequestTimeout,
		now.Add(time.Minute),
		0,
	)
	_, transition, err := state.Apply(afterWindow)
	if err != nil {
		t.Fatalf("Apply(afterWindow) error = %v", err)
	}
	if transition.CoolingDown() || transition.FailureCount() != 1 {
		t.Fatalf("Apply(afterWindow) transition = %#v", transition)
	}
}

// TestModelStateDoesNotCarryStreakAcrossAnotherFailureKind 验证直接 cooldown 也会切断旧 streak。
func TestModelStateDoesNotCarryStreakAcrossAnotherFailureKind(t *testing.T) {
	t.Parallel()

	now := runtimeTestTime()
	timeout := newRuntimeTestFailure(t, FailureRequestTimeout, now, 0)
	state, _, err := (ModelState{}).Apply(timeout)
	if err != nil {
		t.Fatalf("Apply(timeout) error = %v", err)
	}
	rateLimit := newRuntimeTestFailure(
		t,
		FailureRateLimited,
		now.Add(5*time.Second),
		5*time.Second,
	)
	state, _, err = state.Apply(rateLimit)
	if err != nil {
		t.Fatalf("Apply(rateLimit) error = %v", err)
	}
	state, eligibility, err := state.Evaluate(now.Add(10 * time.Second))
	if err != nil || !eligibility.Eligible() {
		t.Fatalf(
			"Evaluate() state=%#v eligibility=%#v error=%v",
			state,
			eligibility,
			err,
		)
	}
	nextTimeout := newRuntimeTestFailure(
		t,
		FailureRequestTimeout,
		now.Add(20*time.Second),
		0,
	)
	_, transition, err := state.Apply(nextTimeout)
	if err != nil {
		t.Fatalf("Apply(nextTimeout) error = %v", err)
	}
	if transition.CoolingDown() || transition.FailureCount() != 1 {
		t.Fatalf("Apply(nextTimeout) transition = %#v", transition)
	}
}

// TestModelStateKeepsNonCooldownFailuresOut 验证硬阻塞和请求错误不会写入 cooldown。
func TestModelStateKeepsNonCooldownFailuresOut(t *testing.T) {
	t.Parallel()

	now := runtimeTestTime()
	tests := []struct {
		kind   FailureKind
		action FailureAction
	}{
		{FailureCredentialRejected, ActionCredentialBlock},
		{FailureQuotaExhausted, ActionQuotaBlock},
		{FailureWorkspaceDeactivated, ActionPolicyBlock},
		{FailurePermissionDenied, ActionPolicyBlock},
		{FailureInvalidRequest, ActionNoStateChange},
		{FailureUnclassified, ActionNoStateChange},
	}
	for _, test := range tests {
		test := test
		t.Run(string(test.kind), func(t *testing.T) {
			t.Parallel()

			failure := newRuntimeTestFailure(t, test.kind, now, 0)
			state, transition, err := (ModelState{}).Apply(failure)
			if err != nil {
				t.Fatalf("Apply() error = %v", err)
			}
			if transition.Action() != test.action ||
				transition.CoolingDown() ||
				!state.IsZero() {
				t.Fatalf(
					"Apply() state=%#v transition=%#v",
					state,
					transition,
				)
			}
		})
	}
}

// TestModelStateSuccessClearsTransientState 验证成功只需清除当前模型元组状态。
func TestModelStateSuccessClearsTransientState(t *testing.T) {
	t.Parallel()

	failure := newRuntimeTestFailure(
		t,
		FailureModelOverloaded,
		runtimeTestTime(),
		0,
	)
	state, _, err := (ModelState{}).Apply(failure)
	if err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	if state.IsZero() {
		t.Fatal("Apply() state unexpectedly empty")
	}
	if succeeded := state.Succeed(); !succeeded.IsZero() {
		t.Fatalf("Succeed() state = %#v", succeeded)
	}
}

// TestFailureRejectsInvalidCooldownHint 验证长期或非毫秒提示不能进入 cooldown。
func TestFailureRejectsInvalidCooldownHint(t *testing.T) {
	t.Parallel()

	for _, retryAfter := range []time.Duration{
		MaxCooldownHint + time.Second,
		time.Nanosecond,
	} {
		_, err := NewFailure(
			FailureRateLimited,
			runtimeTestTime(),
			retryAfter,
		)
		if !errors.Is(err, ErrInvalidFailure) {
			t.Fatalf(
				"NewFailure(%s) error = %v, want ErrInvalidFailure",
				retryAfter,
				err,
			)
		}
	}
}

// newRuntimeTestFailure 创建确定性失败事件。
func newRuntimeTestFailure(
	t *testing.T,
	kind FailureKind,
	occurredAt time.Time,
	retryAfter time.Duration,
) Failure {
	t.Helper()

	failure, err := NewFailure(kind, occurredAt, retryAfter)
	if err != nil {
		t.Fatalf("NewFailure() error = %v", err)
	}
	return failure
}

// runtimeTestTime 返回运行态测试共享的毫秒精度 UTC 时间。
func runtimeTestTime() time.Time {
	return time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
}
