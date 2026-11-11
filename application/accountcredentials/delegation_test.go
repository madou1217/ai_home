package accountcredentials

import (
	"context"
	"sync"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

type delegationStrategy struct{ exempt bool }

func (delegationStrategy) ProviderID() string { return "test" }
func (delegationStrategy) ExpiresAt(accountapp.Credential) (time.Time, bool) {
	return time.Time{}, false
}
func (strategy delegationStrategy) Refresh(
	context.Context,
	accountapp.Credential,
	time.Time,
) (accountapp.Credential, error) {
	return nil, nil
}
func (strategy delegationStrategy) RefreshesDespiteDelegation() bool { return strategy.exempt }

func TestRefreshDelegationExemptOnlyForOptedInStrategies(t *testing.T) {
	if refreshDelegationExempt(delegationStrategy{}) {
		t.Fatalf("普通策略不应绕过宿主委托")
	}
	if !refreshDelegationExempt(delegationStrategy{exempt: true}) {
		t.Fatalf("显式声明豁免的策略必须自行刷新")
	}
}

// delegationCredential 是只改变 Access Token、身份种子稳定的测试凭据。
type delegationCredential struct {
	providerID string
	seed       string
	access     string
}

func (credential delegationCredential) ProviderID() string   { return credential.providerID }
func (credential delegationCredential) IdentitySeed() string { return credential.seed }
func (credential delegationCredential) String() string       { return "delegationCredential" }
func (credential delegationCredential) GoString() string     { return "delegationCredential" }

// dueDelegationStrategy 让凭据始终处于刷新窗口内，并统计真实刷新次数。
type dueDelegationStrategy struct {
	now       time.Time
	refreshes int
}

func (*dueDelegationStrategy) ProviderID() string { return "test" }

func (strategy *dueDelegationStrategy) ExpiresAt(
	accountapp.Credential,
) (time.Time, bool) {
	return strategy.now.Add(-time.Minute), true
}

func (strategy *dueDelegationStrategy) Refresh(
	_ context.Context,
	credential accountapp.Credential,
	_ time.Time,
) (accountapp.Credential, error) {
	strategy.refreshes++
	refreshed := credential.(delegationCredential)
	refreshed.access = "refreshed"
	return refreshed, nil
}

// delegationStore 提供 resolver 需要的 CAS 语义版本化读写。
type delegationStore struct {
	mu       sync.Mutex
	snapshot accountapp.CredentialSnapshot
	writes   int
}

func (store *delegationStore) GetCredentialSnapshot(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialSnapshot, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.snapshot.AccountRef() != accountRef {
		return accountapp.CredentialSnapshot{}, accountapp.ErrCredentialNotFound
	}
	return store.snapshot, nil
}

func (store *delegationStore) ReplaceCredential(
	_ context.Context,
	replacement accountapp.CredentialReplacement,
) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if !store.snapshot.UpdatedAt().Equal(replacement.ExpectedUpdatedAt()) {
		return accountapp.ErrCredentialConflict
	}
	next, err := accountapp.NewCredentialSnapshot(
		replacement.AccountRef(),
		replacement.Credential().ProviderID(),
		replacement.Credential(),
		replacement.UpdatedAt(),
	)
	if err != nil {
		return err
	}
	store.snapshot = next
	store.writes++
	return nil
}

// TestDelegatedRefreshRespectsAccountOwnership 守住宿主委托的刷新所有权边界：
// 宿主台账里的账号仍由宿主刷新，Go 独有账号（OwnsRefresh=true）必须由本进程刷新。
func TestDelegatedRefreshRespectsAccountOwnership(t *testing.T) {
	now := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	credential := delegationCredential{
		providerID: "test",
		seed:       "seed-1",
		access:     "expired",
	}
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

	testCases := []struct {
		name          string
		ownsRefresh   func(accountcore.AccountRef) bool
		wantRefreshes int
	}{
		{
			name: "宿主拥有的账号在委托模式下不刷新",
			ownsRefresh: func(accountcore.AccountRef) bool {
				return false
			},
			wantRefreshes: 0,
		},
		{
			name: "Go 独有账号在委托模式下仍刷新并写回",
			ownsRefresh: func(ref accountcore.AccountRef) bool {
				return ref == accountRef
			},
			wantRefreshes: 1,
		},
		{
			name:          "未注入归属判定时退化到原有委托语义",
			ownsRefresh:   nil,
			wantRefreshes: 0,
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			strategy := &dueDelegationStrategy{now: now}
			store := &delegationStore{snapshot: snapshot}
			resolver, err := NewResolver(Dependencies{
				Store:            store,
				Strategies:       []RefreshStrategy{strategy},
				Clock:            func() time.Time { return now },
				RefreshDelegated: true,
				OwnsRefresh:      testCase.ownsRefresh,
			})
			if err != nil {
				t.Fatalf("NewResolver() error = %v", err)
			}

			result, err := resolver.Resolve(context.Background(), accountRef)
			if err != nil {
				t.Fatalf("Resolve() error = %v", err)
			}
			if strategy.refreshes != testCase.wantRefreshes {
				t.Fatalf(
					"策略刷新次数 = %d, want %d",
					strategy.refreshes,
					testCase.wantRefreshes,
				)
			}
			wantRefreshed := testCase.wantRefreshes == 1
			if result.Refreshed() != wantRefreshed {
				t.Fatalf("Refreshed() = %v, want %v", result.Refreshed(), wantRefreshed)
			}

			store.mu.Lock()
			writes := store.writes
			stored, _ := store.snapshot.Credential().(delegationCredential)
			store.mu.Unlock()
			if writes != testCase.wantRefreshes {
				t.Fatalf("CAS 写回次数 = %d, want %d", writes, testCase.wantRefreshes)
			}
			wantAccess := "expired"
			if wantRefreshed {
				wantAccess = "refreshed"
			}
			if stored.access != wantAccess {
				t.Fatalf("写回 Access Token = %q, want %q", stored.access, wantAccess)
			}
		})
	}
}
