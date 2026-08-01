package sqliteaccount

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestStoreSetsGetsReplacesAndClearsProviderDefault 验证单 Provider 唯一关系和同目标幂等语义。
func TestStoreSetsGetsReplacesAndClearsProviderDefault(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	first := registerDefaultTestAccount(
		t,
		store,
		mustCodexAPIKey(t, "provider-default-first"),
	)
	second := registerDefaultTestAccount(
		t,
		store,
		mustCodexAPIKey(t, "provider-default-second"),
	)
	firstChangedAt := testAccountTime().Add(time.Minute)
	firstDefault := newProviderDefault(t, "codex", first.Ref(), firstChangedAt)

	set, err := store.SetProviderDefault(ctx, firstDefault)
	if err != nil {
		t.Fatalf("SetProviderDefault(first) error = %v", err)
	}
	got, err := store.GetProviderDefault(ctx, "codex")
	if err != nil || got != set {
		t.Fatalf("GetProviderDefault(first) = (%#v, %v)", got, err)
	}
	duplicate := newProviderDefault(
		t,
		"codex",
		first.Ref(),
		firstChangedAt.Add(time.Minute),
	)
	idempotent, err := store.SetProviderDefault(ctx, duplicate)
	if err != nil || idempotent != firstDefault {
		t.Fatalf("SetProviderDefault(same) = (%#v, %v)", idempotent, err)
	}

	secondDefault := newProviderDefault(
		t,
		"codex",
		second.Ref(),
		firstChangedAt.Add(2*time.Minute),
	)
	replaced, err := store.SetProviderDefault(ctx, secondDefault)
	if err != nil || replaced != secondDefault {
		t.Fatalf("SetProviderDefault(second) = (%#v, %v)", replaced, err)
	}
	got, err = store.GetProviderDefault(ctx, "codex")
	if err != nil || got != secondDefault {
		t.Fatalf("GetProviderDefault(second) = (%#v, %v)", got, err)
	}
	if err := store.ClearProviderDefault(ctx, "codex"); err != nil {
		t.Fatalf("ClearProviderDefault() error = %v", err)
	}
	if err := store.ClearProviderDefault(ctx, "codex"); err != nil {
		t.Fatalf("ClearProviderDefault(idempotent) error = %v", err)
	}
	if _, err := store.GetProviderDefault(ctx, "codex"); !errors.Is(
		err,
		accountapp.ErrProviderDefaultNotFound,
	) {
		t.Fatalf("GetProviderDefault(cleared) error = %v", err)
	}
}

// TestStoreRejectsIneligibleProviderDefaultTargets 验证跨 Provider、停用和无凭据目标均失败关闭。
func TestStoreRejectsIneligibleProviderDefaultTargets(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	codexAccount := registerDefaultTestAccount(
		t,
		store,
		mustCodexAPIKey(t, "provider-default-eligibility"),
	)
	changedAt := testAccountTime().Add(time.Minute)
	wrongProvider := newProviderDefault(t, "claude", codexAccount.Ref(), changedAt)
	if _, err := store.SetProviderDefault(ctx, wrongProvider); !errors.Is(
		err,
		accountapp.ErrProviderDefaultMismatch,
	) {
		t.Fatalf("SetProviderDefault(provider mismatch) error = %v", err)
	}
	if _, err := store.SetEnabled(
		ctx,
		codexAccount.Ref(),
		false,
		changedAt,
	); err != nil {
		t.Fatalf("SetEnabled(false) error = %v", err)
	}
	disabled := newProviderDefault(
		t,
		"codex",
		codexAccount.Ref(),
		changedAt.Add(time.Minute),
	)
	if _, err := store.SetProviderDefault(ctx, disabled); !errors.Is(
		err,
		accountapp.ErrProviderDefaultDisabled,
	) {
		t.Fatalf("SetProviderDefault(disabled) error = %v", err)
	}

	unconfigured := newCodexAPIKeyAccount(
		t,
		store,
		2,
		"provider-default-unconfigured",
	)
	if err := store.Create(ctx, unconfigured); err != nil {
		t.Fatalf("Create(unconfigured) error = %v", err)
	}
	withoutCredential := newProviderDefault(
		t,
		"codex",
		unconfigured.Ref(),
		changedAt.Add(2*time.Minute),
	)
	if _, err := store.SetProviderDefault(ctx, withoutCredential); !errors.Is(
		err,
		accountapp.ErrProviderDefaultUnconfigured,
	) {
		t.Fatalf("SetProviderDefault(unconfigured) error = %v", err)
	}
	missingRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	missing := newProviderDefault(
		t,
		"codex",
		missingRef,
		changedAt.Add(3*time.Minute),
	)
	if _, err := store.SetProviderDefault(ctx, missing); !errors.Is(
		err,
		accountapp.ErrAccountNotFound,
	) {
		t.Fatalf("SetProviderDefault(missing) error = %v", err)
	}
}

// TestStoreClearsProviderDefaultWhenAccountIsDisabledOrDeleted 验证生命周期联动不会留下失效选择。
func TestStoreClearsProviderDefaultWhenAccountIsDisabledOrDeleted(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	account := registerDefaultTestAccount(
		t,
		store,
		mustClaudeAPIKey(t, "provider-default-lifecycle"),
	)
	firstDefault := newProviderDefault(
		t,
		"claude",
		account.Ref(),
		testAccountTime().Add(time.Minute),
	)
	if _, err := store.SetProviderDefault(ctx, firstDefault); err != nil {
		t.Fatalf("SetProviderDefault() error = %v", err)
	}
	if _, err := store.SetEnabled(
		ctx,
		account.Ref(),
		false,
		testAccountTime().Add(2*time.Minute),
	); err != nil {
		t.Fatalf("SetEnabled(false) error = %v", err)
	}
	assertProviderDefaultMissing(t, store, "claude")
	if _, err := store.SetEnabled(
		ctx,
		account.Ref(),
		true,
		testAccountTime().Add(3*time.Minute),
	); err != nil {
		t.Fatalf("SetEnabled(true) error = %v", err)
	}
	assertProviderDefaultMissing(t, store, "claude")

	secondDefault := newProviderDefault(
		t,
		"claude",
		account.Ref(),
		testAccountTime().Add(4*time.Minute),
	)
	if _, err := store.SetProviderDefault(ctx, secondDefault); err != nil {
		t.Fatalf("SetProviderDefault(after enable) error = %v", err)
	}
	if err := store.DeleteAccount(ctx, account.Ref()); err != nil {
		t.Fatalf("DeleteAccount() error = %v", err)
	}
	assertProviderDefaultMissing(t, store, "claude")
}

// registerDefaultTestAccount 注册带凭据的默认账号测试目标。
func registerDefaultTestAccount(
	t *testing.T,
	store *Store,
	credential accountapp.Credential,
) accountcore.Account {
	t.Helper()

	account, err := store.RegisterNew(
		context.Background(),
		newRegistrationRequest(t, store, credential, nil),
	)
	if err != nil {
		t.Fatalf("RegisterNew() error = %v", err)
	}
	return account
}

// newProviderDefault 创建测试使用的规范默认关系。
func newProviderDefault(
	t *testing.T,
	providerID string,
	accountRef accountcore.AccountRef,
	updatedAt time.Time,
) accountcore.ProviderDefault {
	t.Helper()

	providerDefault, err := accountcore.NewProviderDefault(
		providerID,
		accountRef,
		updatedAt,
	)
	if err != nil {
		t.Fatalf("NewProviderDefault() error = %v", err)
	}
	return providerDefault
}

// assertProviderDefaultMissing 验证 Provider 当前没有默认启动账号。
func assertProviderDefaultMissing(t *testing.T, store *Store, providerID string) {
	t.Helper()

	if _, err := store.GetProviderDefault(
		context.Background(),
		providerID,
	); !errors.Is(err, accountapp.ErrProviderDefaultNotFound) {
		t.Fatalf("GetProviderDefault(%s) error = %v", providerID, err)
	}
}
