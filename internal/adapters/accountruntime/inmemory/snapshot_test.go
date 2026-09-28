package inmemory

import (
	"context"
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

// TestRuntimeSnapshotProjectsBlocksAndActiveCooldowns 验证快照同时列出账号级硬阻塞、
// 模型级硬阻塞和仍生效的模型 cooldown，且健康账号不出现、cooldown 过期后消失。
func TestRuntimeSnapshotProjectsBlocksAndActiveCooldowns(t *testing.T) {
	t.Parallel()

	now := runtimeTestTime()
	runtime := newTestRuntime(t, func() time.Time { return now })
	credential := newTestRoute(t, 1, "gpt-5.6-sol")
	catalog := newTestRoute(t, 2, "gpt-5.6-terra")
	cooling := newTestRoute(t, 2, "gpt-5.4")
	healthy := newTestRoute(t, 3, "gpt-5.4")

	record := func(route runtimecore.ModelRoute, failure func() error) {
		t.Helper()
		if err := failure(); err != nil {
			t.Fatalf("RecordFailure(%s) error = %v", route.ModelID(), err)
		}
	}
	record(credential, func() error {
		return runtime.RecordFailure(context.Background(), credential,
			newBlockingFailure(t, runtimecore.FailureCredentialRejected, runtimecore.BlockScopeAccount))
	})
	record(catalog, func() error {
		return runtime.RecordFailure(context.Background(), catalog,
			newBlockingFailure(t, runtimecore.FailureModelUnsupported, runtimecore.BlockScopeAccountModel))
	})
	record(cooling, func() error {
		return runtime.RecordFailure(context.Background(), cooling,
			newCooldownFailure(t, runtimecore.FailureRateLimited, time.Minute))
	})
	if err := runtime.RecordSuccess(context.Background(), healthy, newRuntimeSuccess(t, now)); err != nil {
		t.Fatalf("RecordSuccess() error = %v", err)
	}

	snapshot := runtime.RuntimeSnapshot()
	if len(snapshot) != 2 {
		t.Fatalf("snapshot accounts = %d, want 2 (healthy account must be absent): %+v", len(snapshot), snapshot)
	}
	first, second := snapshot[0], snapshot[1]
	if first.AccountRef != credential.AccountRef() ||
		len(first.Blocks) != 1 || first.Blocks[0] != runtimecore.RecoveryCredentialsUpdated ||
		len(first.Models) != 0 {
		t.Fatalf("credential-blocked account view = %+v", first)
	}
	if second.AccountRef != catalog.AccountRef() || len(second.Blocks) != 0 || len(second.Models) != 2 {
		t.Fatalf("model-scoped account view = %+v", second)
	}
	// 模型按 ID 排序：gpt-5.4（cooldown）在 gpt-5.6-terra（目录阻塞）之前。
	cooldown, blocked := second.Models[0], second.Models[1]
	if cooldown.Model != cooling.ModelID() ||
		cooldown.CooldownKind != runtimecore.FailureRateLimited ||
		!cooldown.CooldownUntil.After(now) || len(cooldown.Blocks) != 0 {
		t.Fatalf("cooldown model view = %+v", cooldown)
	}
	if blocked.Model != catalog.ModelID() ||
		len(blocked.Blocks) != 1 || blocked.Blocks[0] != runtimecore.RecoveryModelCatalog ||
		!blocked.CooldownUntil.IsZero() {
		t.Fatalf("catalog-blocked model view = %+v", blocked)
	}

	now = cooldown.CooldownUntil
	for _, account := range runtime.RuntimeSnapshot() {
		for _, model := range account.Models {
			if model.CooldownKind != "" {
				t.Fatalf("expired cooldown still projected: %+v", model)
			}
		}
	}
}
