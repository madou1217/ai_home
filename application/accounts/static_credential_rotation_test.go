package accounts_test

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
)

// TestStaticCredentialRotatorKeepsAccountRefWhileChangingCredentialIdentity 验证密钥轮换不改变账号主键。
func TestStaticCredentialRotatorKeepsAccountRefWhileChangingCredentialIdentity(t *testing.T) {
	t.Parallel()

	catalog := testCatalog(t)
	initial, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: "rotation-old-key"})
	if err != nil {
		t.Fatalf("codex.NewAPIKeyAuth(initial) error = %v", err)
	}
	replacement, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: "rotation-new-key"})
	if err != nil {
		t.Fatalf("codex.NewAPIKeyAuth(replacement) error = %v", err)
	}
	store := newStaticRotationStore(t, catalog, initial)
	cleanup := &staticRotationCleanup{}
	clock := store.account.UpdatedAt().Add(time.Second)
	rotator, err := accountapp.NewStaticCredentialRotator(
		catalog,
		store,
		func() time.Time { return clock },
		cleanup,
	)
	if err != nil {
		t.Fatalf("NewStaticCredentialRotator() error = %v", err)
	}

	updated, err := rotator.Rotate(
		context.Background(),
		store.account.Ref(),
		replacement,
	)
	if err != nil {
		t.Fatalf("Rotate() error = %v", err)
	}
	replacementDerivedRef, err := accountcore.DeriveAccountRef(replacement)
	if err != nil {
		t.Fatalf("DeriveAccountRef(replacement) error = %v", err)
	}
	if replacementDerivedRef == store.account.Ref() {
		t.Fatal("测试新凭据没有形成不同的凭据身份")
	}
	if updated.Ref() != store.account.Ref() ||
		updated.CLIAccountID() != store.account.CLIAccountID() ||
		store.rotation.AccountRef() != store.account.Ref() ||
		store.rotation.Replacement() != replacement ||
		cleanup.calls != 1 ||
		cleanup.accountRef != store.account.Ref() {
		t.Fatalf(
			"rotation result=%#v command=%#v cleanup=%#v",
			updated,
			store.rotation,
			cleanup,
		)
	}
}

// TestStaticCredentialRotatorAllowsClaudeCredentialTypeSwitch 验证 Claude API Key 可切换为 Auth Token。
func TestStaticCredentialRotatorAllowsClaudeCredentialTypeSwitch(t *testing.T) {
	t.Parallel()

	catalog := testCatalog(t)
	initial, err := claude.NewAPIKeyAuth(claude.APIKeyInput{APIKey: "claude-old-key"})
	if err != nil {
		t.Fatalf("claude.NewAPIKeyAuth() error = %v", err)
	}
	replacement, err := claude.NewAuthTokenAuth(
		claude.AuthTokenInput{AuthToken: "claude-new-auth-token"},
	)
	if err != nil {
		t.Fatalf("claude.NewAuthTokenAuth() error = %v", err)
	}
	store := newStaticRotationStore(t, catalog, initial)
	rotator, err := accountapp.NewStaticCredentialRotator(
		catalog,
		store,
		func() time.Time { return store.account.UpdatedAt().Add(time.Second) },
		&staticRotationCleanup{},
	)
	if err != nil {
		t.Fatalf("NewStaticCredentialRotator() error = %v", err)
	}
	if _, err := rotator.Rotate(
		context.Background(),
		store.account.Ref(),
		replacement,
	); err != nil {
		t.Fatalf("Rotate() error = %v", err)
	}
	if _, ok := store.rotation.Replacement().(*claude.AuthTokenAuth); !ok {
		t.Fatalf("replacement type = %T", store.rotation.Replacement())
	}
}

// TestStaticCredentialRotatorRejectsOAuthAndCrossProviderBeforeDiscovery 验证错误类型不会访问上游目录。
func TestStaticCredentialRotatorRejectsOAuthAndCrossProviderBeforeDiscovery(t *testing.T) {
	t.Parallel()

	catalog := testCatalog(t)
	initial, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: "rotation-guard-key"})
	if err != nil {
		t.Fatalf("codex.NewAPIKeyAuth() error = %v", err)
	}
	store := newStaticRotationStore(t, catalog, initial)
	rotator, err := accountapp.NewStaticCredentialRotator(
		catalog,
		store,
		time.Now,
		&staticRotationCleanup{},
	)
	if err != nil {
		t.Fatalf("NewStaticCredentialRotator() error = %v", err)
	}
	currentOAuth, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:  "sk-ant-oat01-static-rotation-current",
		RefreshToken: "sk-ant-ort01-static-rotation-current",
		ExpiresAtMS:  1_800_000_000_000,
		Scopes:       []string{claude.InferenceScope},
		Identity: claude.OAuthIdentity{
			AccountUUID: "123e4567-e89b-12d3-a456-426614174321",
		},
	})
	if err != nil {
		t.Fatalf("claude.NewOAuthAuth() error = %v", err)
	}
	claudeKey, err := claude.NewAPIKeyAuth(claude.APIKeyInput{APIKey: "cross-provider-key"})
	if err != nil {
		t.Fatalf("claude.NewAPIKeyAuth() error = %v", err)
	}
	oauthStore := newStaticRotationStore(t, catalog, currentOAuth)
	oauthRotator, err := accountapp.NewStaticCredentialRotator(
		catalog,
		oauthStore,
		time.Now,
		&staticRotationCleanup{},
	)
	if err != nil {
		t.Fatalf("NewStaticCredentialRotator(oauth) error = %v", err)
	}
	_, err = oauthRotator.Rotate(
		context.Background(),
		oauthStore.account.Ref(),
		claudeKey,
	)
	if !errors.Is(err, accountapp.ErrStaticCredentialRotationUnsupported) {
		t.Fatalf("Rotate(current oauth) error = %v", err)
	}
	setupToken, err := claude.NewOAuthTokenAuth(
		claude.OAuthTokenInput{AccessToken: "unsupported-setup-token"},
	)
	if err != nil {
		t.Fatalf("claude.NewOAuthTokenAuth() error = %v", err)
	}
	_, err = rotator.Rotate(context.Background(), store.account.Ref(), setupToken)
	if !errors.Is(err, accountapp.ErrStaticCredentialRotationUnsupported) {
		t.Fatalf("Rotate(setup token) error = %v", err)
	}
	_, err = rotator.Rotate(context.Background(), store.account.Ref(), claudeKey)
	if !errors.Is(err, accountapp.ErrInvalidStaticCredentialRotation) {
		t.Fatalf("Rotate(cross provider) error = %v", err)
	}
	if store.rotateCalls != 0 || oauthStore.rotateCalls != 0 {
		t.Fatalf(
			"invalid rotation reached ports: static=%d oauth=%d",
			store.rotateCalls,
			oauthStore.rotateCalls,
		)
	}
}

// staticRotationStore 是静态轮换应用测试使用的可观察持久化端口。
type staticRotationStore struct {
	catalog     *providers.Catalog
	account     accountcore.Account
	snapshot    accountapp.CredentialSnapshot
	rotation    accountapp.StaticCredentialRotation
	rotateCalls int
}

// newStaticRotationStore 创建账号和初始凭据版本一致的测试存储。
func newStaticRotationStore(
	t *testing.T,
	catalog *providers.Catalog,
	credential accountapp.Credential,
) *staticRotationStore {
	t.Helper()
	createdAt := time.Date(2026, time.August, 1, 8, 0, 0, 0, time.UTC)
	alias, err := accountcore.NewCLIAccountID(7)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(catalog, accountcore.NewAccountInput{
		Identity:     credential,
		CLIAccountID: alias,
		CreatedAt:    createdAt,
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	snapshot, err := accountapp.NewCredentialSnapshot(
		account.Ref(),
		account.ProviderID(),
		credential,
		createdAt,
	)
	if err != nil {
		t.Fatalf("NewCredentialSnapshot() error = %v", err)
	}
	return &staticRotationStore{catalog: catalog, account: account, snapshot: snapshot}
}

// GetByRef 返回测试账号基础快照。
func (store *staticRotationStore) GetByRef(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountcore.Account, error) {
	if accountRef != store.account.Ref() {
		return accountcore.Account{}, accountapp.ErrAccountNotFound
	}
	return store.account, nil
}

// GetCredentialSnapshot 返回测试账号当前凭据绑定。
func (store *staticRotationStore) GetCredentialSnapshot(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialSnapshot, error) {
	if accountRef != store.account.Ref() {
		return accountapp.CredentialSnapshot{}, accountapp.ErrCredentialNotFound
	}
	return store.snapshot, nil
}

// RotateStaticCredential 记录命令并返回同一账号的新时间快照。
func (store *staticRotationStore) RotateStaticCredential(
	_ context.Context,
	rotation accountapp.StaticCredentialRotation,
) (accountcore.Account, error) {
	store.rotateCalls++
	store.rotation = rotation
	return accountcore.RestoreAccount(store.catalog, accountcore.RestoreAccountInput{
		Ref:          store.account.Ref(),
		ProviderID:   store.account.ProviderID(),
		CLIAccountID: store.account.CLIAccountID(),
		Enabled:      store.account.Enabled(),
		CreatedAt:    store.account.CreatedAt(),
		UpdatedAt:    rotation.UpdatedAt(),
	})
}

// staticRotationCleanup 记录提交后运行态清理。
type staticRotationCleanup struct {
	accountRef accountcore.AccountRef
	calls      int
}

// ForgetAccount 记录需要清理的稳定账号引用。
func (cleanup *staticRotationCleanup) ForgetAccount(accountRef accountcore.AccountRef) {
	cleanup.calls++
	cleanup.accountRef = accountRef
}
