package accountcredentials

import (
	"context"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// awareStrategy 只实现账号感知刷新，用来验证 Resolver 优先走这条路径。
type awareStrategy struct {
	now  time.Time
	refs []accountcore.AccountRef
}

func (*awareStrategy) ProviderID() string { return "test" }

func (strategy *awareStrategy) ExpiresAt(accountapp.Credential) (time.Time, bool) {
	return strategy.now.Add(-time.Minute), true
}

func (*awareStrategy) Refresh(
	context.Context,
	accountapp.Credential,
	time.Time,
) (accountapp.Credential, error) {
	panic("普通 Refresh 不应被调用")
}

func (strategy *awareStrategy) RefreshWithAccount(
	_ context.Context,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	_ time.Time,
) (accountapp.Credential, error) {
	strategy.refs = append(strategy.refs, accountRef)
	return credential, nil
}

func TestResolverPrefersAccountAwareRefresh(t *testing.T) {
	now := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	credential := delegationCredential{providerID: "test", seed: "seed-1", access: "expired"}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	snapshot, err := accountapp.NewCredentialSnapshot(
		accountRef,
		credential.providerID,
		credential,
		now.Add(-time.Hour),
	)
	if err != nil {
		t.Fatalf("NewCredentialSnapshot() error = %v", err)
	}
	strategy := &awareStrategy{now: now}
	resolver, err := NewResolver(Dependencies{
		Store:      &delegationStore{snapshot: snapshot},
		Strategies: []RefreshStrategy{strategy},
		Clock:      func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewResolver() error = %v", err)
	}
	if _, err := resolver.Resolve(context.Background(), accountRef); err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if len(strategy.refs) != 1 || strategy.refs[0] != accountRef {
		t.Fatalf("aware refresh refs = %v, want %s", strategy.refs, accountRef)
	}
}
