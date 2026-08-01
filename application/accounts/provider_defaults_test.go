package accounts_test

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestProviderDefaultsDelegatesCanonicalSetGetAndClear 验证默认账号用例保持稳定身份并只读取一次时钟。
func TestProviderDefaultsDelegatesCanonicalSetGetAndClear(t *testing.T) {
	t.Parallel()

	account := newManagementTestAccount(t)
	changedAt := time.Date(2026, time.August, 1, 8, 0, 0, 987_654_321, time.UTC)
	store := &providerDefaultStoreStub{}
	clockCalls := 0
	defaults, err := accountapp.NewProviderDefaults(
		testCatalog(t),
		store,
		func() time.Time {
			clockCalls++
			return changedAt
		},
	)
	if err != nil {
		t.Fatalf("NewProviderDefaults() error = %v", err)
	}

	setResult, err := defaults.Set(
		context.Background(),
		"codex",
		account.Ref(),
	)
	if err != nil {
		t.Fatalf("Set() error = %v", err)
	}
	getResult, err := defaults.Get(context.Background(), "codex")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if err := defaults.Clear(context.Background(), "codex"); err != nil {
		t.Fatalf("Clear() error = %v", err)
	}
	wantTime := time.UnixMilli(changedAt.UnixMilli()).UTC()
	if setResult != getResult ||
		setResult.ProviderID() != "codex" ||
		setResult.AccountRef() != account.Ref() ||
		!setResult.UpdatedAt().Equal(wantTime) ||
		store.setCalls != 1 ||
		store.getProviderID != "codex" ||
		store.clearProviderID != "codex" ||
		clockCalls != 1 {
		t.Fatalf(
			"defaults set=%#v get=%#v store=%#v clockCalls=%d",
			setResult,
			getResult,
			store,
			clockCalls,
		)
	}
}

// TestProviderDefaultsRejectsInvalidDependenciesAndRequests 验证非规范输入不会进入存储端口。
func TestProviderDefaultsRejectsInvalidDependenciesAndRequests(t *testing.T) {
	t.Parallel()

	store := &providerDefaultStoreStub{}
	clock := func() time.Time { return time.Now() }
	if _, err := accountapp.NewProviderDefaults(nil, store, clock); !errors.Is(
		err,
		accountapp.ErrInvalidProviderDefaultDependencies,
	) {
		t.Fatalf("NewProviderDefaults(nil catalog) error = %v", err)
	}
	if _, err := accountapp.NewProviderDefaults(testCatalog(t), nil, clock); !errors.Is(
		err,
		accountapp.ErrInvalidProviderDefaultDependencies,
	) {
		t.Fatalf("NewProviderDefaults(nil store) error = %v", err)
	}
	if _, err := accountapp.NewProviderDefaults(testCatalog(t), store, nil); !errors.Is(
		err,
		accountapp.ErrInvalidProviderDefaultDependencies,
	) {
		t.Fatalf("NewProviderDefaults(nil clock) error = %v", err)
	}

	defaults, err := accountapp.NewProviderDefaults(testCatalog(t), store, clock)
	if err != nil {
		t.Fatalf("NewProviderDefaults() error = %v", err)
	}
	validRef := newManagementTestAccount(t).Ref()
	for _, providerID := range []string{"Codex", "gemini", "unknown", ""} {
		if _, err := defaults.Get(context.Background(), providerID); !errors.Is(
			err,
			accountapp.ErrInvalidProviderDefault,
		) {
			t.Fatalf("Get(%q) error = %v", providerID, err)
		}
	}
	if _, err := defaults.Set(context.Background(), "codex", accountcore.AccountRef("invalid")); !errors.Is(
		err,
		accountapp.ErrInvalidProviderDefault,
	) {
		t.Fatalf("Set(invalid ref) error = %v", err)
	}
	if err := defaults.Clear(context.Background(), "Codex"); !errors.Is(
		err,
		accountapp.ErrInvalidProviderDefault,
	) {
		t.Fatalf("Clear(non-canonical) error = %v", err)
	}
	if store.getCalls != 0 || store.setCalls != 0 || store.clearCalls != 0 {
		t.Fatalf("invalid requests reached store: %#v validRef=%s", store, validRef)
	}
}

// providerDefaultStoreStub 是默认账号用例使用的可观察存储替身。
type providerDefaultStoreStub struct {
	value           accountcore.ProviderDefault
	getProviderID   string
	clearProviderID string
	getCalls        int
	setCalls        int
	clearCalls      int
	err             error
}

// GetProviderDefault 返回最近一次写入的默认关系。
func (store *providerDefaultStoreStub) GetProviderDefault(
	_ context.Context,
	providerID string,
) (accountcore.ProviderDefault, error) {
	store.getCalls++
	store.getProviderID = providerID
	return store.value, store.err
}

// SetProviderDefault 记录并返回默认关系。
func (store *providerDefaultStoreStub) SetProviderDefault(
	_ context.Context,
	providerDefault accountcore.ProviderDefault,
) (accountcore.ProviderDefault, error) {
	store.setCalls++
	store.value = providerDefault
	return providerDefault, store.err
}

// ClearProviderDefault 记录需要清除的规范 Provider。
func (store *providerDefaultStoreStub) ClearProviderDefault(
	_ context.Context,
	providerID string,
) error {
	store.clearCalls++
	store.clearProviderID = providerID
	return store.err
}
