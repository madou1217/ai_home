package accountcredentials

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// identityChangingStrategy 模拟刷新换回另一个稳定身份（如 id_token 邮箱变了）。
type identityChangingStrategy struct {
	now time.Time
}

func (*identityChangingStrategy) ProviderID() string { return "test" }

func (strategy *identityChangingStrategy) ExpiresAt(accountapp.Credential) (time.Time, bool) {
	return strategy.now.Add(-time.Minute), true
}

func (strategy *identityChangingStrategy) Refresh(
	_ context.Context,
	credential accountapp.Credential,
	_ time.Time,
) (accountapp.Credential, error) {
	refreshed := credential.(delegationCredential)
	refreshed.seed = "seed-2"
	refreshed.access = "refreshed"
	return refreshed, nil
}

// reKeyTestStore 在内存里完成迁移并记录回调，验证 resolver 的接线而不是 SQL。
type reKeyTestStore struct {
	delegationStore
	rekeyed []accountcore.AccountRef
}

func (store *reKeyTestStore) ReKeyAccount(
	_ context.Context,
	_ accountcore.AccountRef,
	credential accountapp.Credential,
	updatedAt time.Time,
) (accountapp.CredentialSnapshot, error) {
	ref, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	snapshot, err := accountapp.NewCredentialSnapshot(
		ref,
		credential.ProviderID(),
		credential,
		updatedAt,
	)
	if err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	store.mu.Lock()
	store.snapshot = snapshot
	store.rekeyed = append(store.rekeyed, ref)
	store.mu.Unlock()
	return snapshot, nil
}

func newReKeyResolverFixture(t *testing.T) (time.Time, delegationCredential, accountcore.AccountRef, *delegationStore) {
	t.Helper()
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
	return now, credential, accountRef, &delegationStore{snapshot: snapshot}
}

func TestRefreshReKeysGoOwnedAccountWhenIdentityChanges(t *testing.T) {
	now, _, oldRef, base := newReKeyResolverFixture(t)
	store := &reKeyTestStore{delegationStore: *base}
	var previous, current accountcore.AccountRef
	var refreshedRef accountcore.AccountRef
	resolver, err := NewResolver(Dependencies{
		Store:       store,
		Strategies:  []RefreshStrategy{&identityChangingStrategy{now: now}},
		Clock:       func() time.Time { return now },
		ReKeyStore:  store,
		OwnsRefresh: func(accountcore.AccountRef) bool { return true },
		OnAccountReKeyed: func(from, to accountcore.AccountRef, providerID string) {
			previous, current = from, to
			if providerID != "test" {
				t.Errorf("providerID = %q, want test", providerID)
			}
		},
		OnCredentialRefreshed: func(ref accountcore.AccountRef, _ accountapp.Credential) {
			refreshedRef = ref
		},
	})
	if err != nil {
		t.Fatalf("NewResolver() error = %v", err)
	}
	result, err := resolver.Resolve(context.Background(), oldRef)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	newRef, err := accountcore.DeriveAccountRef(delegationCredential{
		providerID: "test",
		seed:       "seed-2",
		access:     "refreshed",
	})
	if err != nil {
		t.Fatalf("DeriveAccountRef(new) error = %v", err)
	}
	if result.Binding().AccountRef() != newRef {
		t.Fatalf("resolved ref = %s, want %s", result.Binding().AccountRef(), newRef)
	}
	if previous != oldRef || current != newRef || refreshedRef != newRef {
		t.Fatalf("callbacks = %s -> %s, refreshed=%s", previous, current, refreshedRef)
	}
	if len(store.rekeyed) != 1 || store.rekeyed[0] != newRef {
		t.Fatalf("rekeyed = %v", store.rekeyed)
	}
}

func TestRefreshRejectsIdentityChangeWhenReKeyNotAllowed(t *testing.T) {
	now, _, oldRef, base := newReKeyResolverFixture(t)
	store := &reKeyTestStore{delegationStore: *base}
	resolver, err := NewResolver(Dependencies{
		Store:            store,
		Strategies:       []RefreshStrategy{&identityChangingStrategy{now: now}},
		Clock:            func() time.Time { return now },
		RefreshDelegated: true,
		OwnsRefresh:      func(accountcore.AccountRef) bool { return true },
		ReKeyStore:       nil,
	})
	if err != nil {
		t.Fatalf("NewResolver() error = %v", err)
	}
	if _, err := resolver.Resolve(context.Background(), oldRef); !errors.Is(
		err,
		accountapp.ErrReauthenticationIdentityMismatch,
	) {
		t.Fatalf("Resolve() error = %v, want identity mismatch", err)
	}
	if len(store.rekeyed) != 0 {
		t.Fatalf("account without rekey support must not be rekeyed: %v", store.rekeyed)
	}
}

// 宿主拥有的账号在委托模式下根本不刷新；身份变化只能由宿主处理。
func TestDelegatedHostOwnedAccountNeverReKeys(t *testing.T) {
	now, _, oldRef, base := newReKeyResolverFixture(t)
	store := &reKeyTestStore{delegationStore: *base}
	resolver, err := NewResolver(Dependencies{
		Store:            store,
		Strategies:       []RefreshStrategy{&identityChangingStrategy{now: now}},
		Clock:            func() time.Time { return now },
		RefreshDelegated: true,
		OwnsRefresh:      func(accountcore.AccountRef) bool { return false },
		ReKeyStore:       store,
	})
	if err != nil {
		t.Fatalf("NewResolver() error = %v", err)
	}
	result, err := resolver.Resolve(context.Background(), oldRef)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if result.Binding().AccountRef() != oldRef {
		t.Fatalf("ref = %s, want unchanged %s", result.Binding().AccountRef(), oldRef)
	}
	if len(store.rekeyed) != 0 {
		t.Fatalf("host-owned account must not be rekeyed: %v", store.rekeyed)
	}
}

func TestRefreshRejectsIdentityChangeWithoutReKeyStore(t *testing.T) {
	now, _, oldRef, base := newReKeyResolverFixture(t)
	resolver, err := NewResolver(Dependencies{
		Store:      base,
		Strategies: []RefreshStrategy{&identityChangingStrategy{now: now}},
		Clock:      func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewResolver() error = %v", err)
	}
	if _, err := resolver.Resolve(context.Background(), oldRef); !errors.Is(
		err,
		accountapp.ErrReauthenticationIdentityMismatch,
	) {
		t.Fatalf("Resolve() error = %v, want identity mismatch", err)
	}
}
