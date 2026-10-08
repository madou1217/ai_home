package accountrouting

import (
	"fmt"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// affinityTestRef 创建用于会话亲和测试的规范账号引用。
func affinityTestRef(value int) accountcore.AccountRef {
	ref, err := accountcore.ParseAccountRef(fmt.Sprintf("acct_%020x", value))
	if err != nil {
		panic(err)
	}
	return ref
}

// TestSessionAffinityBindsAndRefreshes 验证命中续期且账号可回读。
func TestSessionAffinityBindsAndRefreshes(t *testing.T) {
	t.Parallel()

	affinity := NewSessionAffinity()
	base := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	first := affinityTestRef(1)
	affinity.Bind("codex", "session-a", first, base)

	if _, found := affinity.Lookup("codex", "session-a", base); !found {
		t.Fatalf("Lookup(immediate) not found")
	}
	// TTL 内命中后续期：过期边界重新从命中时刻计算。
	refreshed := base.Add(DefaultSessionAffinityTTL - time.Minute)
	bound, found := affinity.Lookup("codex", "session-a", refreshed)
	if !found || bound != first {
		t.Fatalf("Lookup(refresh) = %q, %v", bound, found)
	}
	if _, found := affinity.Lookup(
		"codex",
		"session-a",
		refreshed.Add(DefaultSessionAffinityTTL-time.Minute),
	); !found {
		t.Fatalf("Lookup(after refresh) expired too early")
	}
}

// TestSessionAffinityExpiresAndIsolatesProviders 验证 TTL 过期与 Provider 分桶隔离。
func TestSessionAffinityExpiresAndIsolatesProviders(t *testing.T) {
	t.Parallel()

	affinity := NewSessionAffinity()
	base := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	affinity.Bind("codex", "shared-key", affinityTestRef(1), base)
	affinity.Bind("claude", "shared-key", affinityTestRef(2), base)

	if _, found := affinity.Lookup("codex", "shared-key", base); !found {
		t.Fatalf("codex bucket lost its binding")
	}
	bound, found := affinity.Lookup("claude", "shared-key", base)
	if !found || bound != affinityTestRef(2) {
		t.Fatalf("claude bucket = %q, %v", bound, found)
	}
	if _, found := affinity.Lookup(
		"codex",
		"shared-key",
		base.Add(DefaultSessionAffinityTTL+time.Second),
	); found {
		t.Fatalf("expired binding still resolves")
	}
}

// TestSessionAffinityRebindsExistingKeyInPlace 验证重复绑定更新账号而不改变淘汰顺序。
func TestSessionAffinityRebindsExistingKeyInPlace(t *testing.T) {
	t.Parallel()

	affinity := NewSessionAffinity()
	base := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	affinity.Bind("codex", "session-a", affinityTestRef(1), base)
	affinity.Bind("codex", "session-a", affinityTestRef(9), base)
	bound, found := affinity.Lookup("codex", "session-a", base)
	if !found || bound != affinityTestRef(9) {
		t.Fatalf("rebind = %q, %v", bound, found)
	}
}

// TestSessionAffinityEvictsOldestWhenFull 验证超出容量时按插入顺序淘汰最旧绑定。
func TestSessionAffinityEvictsOldestWhenFull(t *testing.T) {
	t.Parallel()

	affinity := NewSessionAffinity()
	affinity.maxEntries = 2
	base := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	affinity.Bind("codex", "session-a", affinityTestRef(1), base)
	affinity.Bind("codex", "session-b", affinityTestRef(2), base)
	affinity.Bind("codex", "session-c", affinityTestRef(3), base)

	if _, found := affinity.Lookup("codex", "session-a", base); found {
		t.Fatalf("oldest binding was not evicted")
	}
	for _, key := range []string{"session-b", "session-c"} {
		if _, found := affinity.Lookup("codex", key, base); !found {
			t.Fatalf("binding %q missing after eviction", key)
		}
	}
}

// TestSessionAffinityIgnoresInvalidInput 验证空 Provider/会话键/账号不写入状态。
func TestSessionAffinityIgnoresInvalidInput(t *testing.T) {
	t.Parallel()

	affinity := NewSessionAffinity()
	base := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	affinity.Bind("", "session-a", affinityTestRef(1), base)
	affinity.Bind("codex", "", affinityTestRef(1), base)
	affinity.Bind("codex", "session-a", "", base)
	if _, found := affinity.Lookup("codex", "session-a", base); found {
		t.Fatalf("invalid input wrote a binding")
	}
	var nilAffinity *SessionAffinity
	if _, found := nilAffinity.Lookup("codex", "session-a", base); found {
		t.Fatalf("nil affinity resolved a binding")
	}
}
