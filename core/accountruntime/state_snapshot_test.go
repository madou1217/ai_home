package accountruntime

import (
	"errors"
	"testing"
	"time"
)

// TestModelStateSnapshotRoundTripsThroughPersistence 验证 cooldown 与 streak 都能
// 无损地经过持久化投影往返，且不改变路由资格。
func TestModelStateSnapshotRoundTripsThroughPersistence(t *testing.T) {
	t.Parallel()

	now := runtimeTestTime()
	failure := newRuntimeTestFailure(
		t,
		FailureRequestTimeout,
		now,
		0,
	)
	first, _, err := (ModelState{}).Apply(failure)
	if err != nil {
		t.Fatalf("Apply(first) error = %v", err)
	}
	streaked, transition, err := first.Apply(
		newRuntimeTestFailure(t, FailureRequestTimeout, now.Add(time.Second), 0),
	)
	if err != nil {
		t.Fatalf("Apply(second) error = %v", err)
	}
	if !transition.CoolingDown() {
		t.Fatalf("第二次超时未触发 cooldown: %#v", transition)
	}

	restored, err := RestoreModelState(streaked.Snapshot())
	if err != nil {
		t.Fatalf("RestoreModelState() error = %v", err)
	}
	if restored != streaked {
		t.Fatalf("RestoreModelState() = %#v, want %#v", restored, streaked)
	}

	_, wantEligibility, err := streaked.Evaluate(now.Add(2 * time.Second))
	if err != nil {
		t.Fatalf("Evaluate(original) error = %v", err)
	}
	_, gotEligibility, err := restored.Evaluate(now.Add(2 * time.Second))
	if err != nil {
		t.Fatalf("Evaluate(restored) error = %v", err)
	}
	if gotEligibility != wantEligibility {
		t.Fatalf(
			"恢复后资格 = %#v, want %#v",
			gotEligibility,
			wantEligibility,
		)
	}
}

// TestRestoreModelStateRejectsCorruptSnapshots 验证损坏的持久化行不会变成可用状态。
func TestRestoreModelStateRejectsCorruptSnapshots(t *testing.T) {
	t.Parallel()

	now := runtimeTestTime()
	valid := ModelStateSnapshot{
		CooldownKind:  FailureRateLimited,
		CooldownUntil: now.Add(5 * time.Minute),
		LastFailureAt: now,
	}
	if _, err := RestoreModelState(valid); err != nil {
		t.Fatalf("合法快照被拒绝: %v", err)
	}

	cases := map[string]ModelStateSnapshot{
		"未知失败分类": {
			CooldownKind:  "made_up_kind",
			CooldownUntil: now.Add(time.Minute),
			LastFailureAt: now,
		},
		"硬阻塞分类伪装成冷却": {
			CooldownKind:  FailureCredentialRejected,
			CooldownUntil: now.Add(time.Minute),
			LastFailureAt: now,
		},
		"冷却分类缺少解除时间": {
			CooldownKind:  FailureRateLimited,
			LastFailureAt: now,
		},
		"冷却时间缺少分类": {
			CooldownUntil: now.Add(time.Minute),
			LastFailureAt: now,
		},
		"streak 缺少计数": {
			StreakKind:      FailureRequestTimeout,
			StreakExpiresAt: now.Add(time.Minute),
			LastFailureAt:   now,
		},
		"streak 计数为零却留下分类": {
			StreakKind:    FailureRequestTimeout,
			StreakCount:   0,
			LastFailureAt: now,
		},
		"有冷却却没有失败时间": {
			CooldownKind:  FailureRateLimited,
			CooldownUntil: now.Add(time.Minute),
		},
		"超出可比较范围的时间": {
			CooldownKind:  FailureRateLimited,
			CooldownUntil: time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC),
			LastFailureAt: now,
		},
	}
	for name, snapshot := range cases {
		if _, err := RestoreModelState(snapshot); !errors.Is(
			err,
			ErrInvalidFailure,
		) {
			t.Fatalf("%s: error = %v, want ErrInvalidFailure", name, err)
		}
	}
}

// TestRestoreModelStateCollapsesStateWithoutCooldownOrStreak 验证只留下失败时间的
// 快照按 prune 语义收敛为零状态，不算损坏。
func TestRestoreModelStateCollapsesStateWithoutCooldownOrStreak(t *testing.T) {
	t.Parallel()

	restored, err := RestoreModelState(ModelStateSnapshot{
		LastFailureAt: runtimeTestTime(),
	})
	if err != nil {
		t.Fatalf("RestoreModelState() error = %v", err)
	}
	if !restored.IsZero() {
		t.Fatalf("RestoreModelState() = %#v, want 零状态", restored)
	}
}
