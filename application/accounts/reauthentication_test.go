package accounts_test

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
)

// TestReauthenticatorPreservesStableIdentity 验证新 Token 只替换同一账号的认证快照。
func TestReauthenticatorPreservesStableIdentity(t *testing.T) {
	t.Parallel()

	clock := func() time.Time {
		return time.Date(2026, time.July, 28, 1, 2, 3, 456_789_000, time.UTC)
	}
	originalCredential, originalProfile := newClaudeReauthValues(
		t,
		"123e4567-e89b-12d3-a456-426614174100",
		"original",
	)
	replacementCredential, replacementProfile := newClaudeReauthValues(
		t,
		"123e4567-e89b-12d3-a456-426614174100",
		"replacement",
	)
	accountRef, err := accountcore.DeriveAccountRef(originalCredential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(8)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(testCatalog(t), accountcore.NewAccountInput{
		Identity:     originalCredential,
		CLIAccountID: alias,
		CreatedAt:    clock().Add(-time.Hour),
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	store := &reauthenticationStoreStub{account: account}
	catalog := testCatalog(t)
	reauthenticator, err := accountapp.NewReauthenticator(
		catalog,
		store,
		clock,
	)
	if err != nil {
		t.Fatalf("NewReauthenticator() error = %v", err)
	}

	result, err := reauthenticator.Reauthenticate(
		context.Background(),
		accountRef,
		replacementCredential,
		replacementProfile,
	)
	if err != nil {
		t.Fatalf("Reauthenticate() error = %v", err)
	}
	if result.Ref() != accountRef ||
		result.CLIAccountID() != alias ||
		store.calls != 1 {
		t.Fatalf("Reauthenticate() result=%#v store=%#v", result, store)
	}
	command := store.reauthentication
	if command.AccountRef() != accountRef ||
		command.ProviderID() != "claude" ||
		command.Credential() != replacementCredential ||
		command.Profile().Profile() != replacementProfile ||
		!command.UpdatedAt().Equal(clock().UTC().Truncate(time.Millisecond)) ||
		!command.IsValid() {
		t.Fatalf("Reauthentication command = %#v", command)
	}
	if originalProfile.OAuthProfile().AccountUUID() !=
		replacementProfile.OAuthProfile().AccountUUID() {
		t.Fatal("测试夹具没有保持同一 Claude 账号身份")
	}
}

// TestReauthenticatorRejectsDifferentAccount 验证错误账号登录结果不会进入持久化端口。
func TestReauthenticatorRejectsDifferentAccount(t *testing.T) {
	t.Parallel()

	originalCredential, _ := newClaudeReauthValues(
		t,
		"123e4567-e89b-12d3-a456-426614174101",
		"original",
	)
	otherCredential, otherProfile := newClaudeReauthValues(
		t,
		"123e4567-e89b-12d3-a456-426614174102",
		"other",
	)
	accountRef, err := accountcore.DeriveAccountRef(originalCredential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	store := &reauthenticationStoreStub{}
	catalog := testCatalog(t)
	reauthenticator, err := accountapp.NewReauthenticator(
		catalog,
		store,
		time.Now,
	)
	if err != nil {
		t.Fatalf("NewReauthenticator() error = %v", err)
	}

	_, err = reauthenticator.Reauthenticate(
		context.Background(),
		accountRef,
		otherCredential,
		otherProfile,
	)
	if !errors.Is(err, accountapp.ErrReauthenticationIdentityMismatch) {
		t.Fatalf(
			"Reauthenticate() error = %v, want ErrReauthenticationIdentityMismatch",
			err,
		)
	}
	if store.calls != 0 {
		t.Fatalf("身份不匹配仍访问持久化端口: store=%d", store.calls)
	}
}

// TestReauthenticatorAllowsMissingOptionalProfile 验证可刷新凭据能够在公开资料
// 缺失时原地更新，且命令不会伪造或清空资料。
func TestReauthenticatorAllowsMissingOptionalProfile(t *testing.T) {
	t.Parallel()

	credential, _ := newClaudeReauthValues(
		t,
		"123e4567-e89b-12d3-a456-426614174103",
		"missing-profile",
	)
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(10)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(testCatalog(t), accountcore.NewAccountInput{
		Identity:     credential,
		CLIAccountID: alias,
		CreatedAt:    time.Now().Add(-time.Hour),
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	store := &reauthenticationStoreStub{account: account}
	catalog := testCatalog(t)
	reauthenticator, err := accountapp.NewReauthenticator(
		catalog,
		store,
		time.Now,
	)
	if err != nil {
		t.Fatalf("NewReauthenticator() error = %v", err)
	}

	result, err := reauthenticator.Reauthenticate(
		context.Background(),
		accountRef,
		credential,
		nil,
	)
	if err != nil {
		t.Fatalf("Reauthenticate() error = %v", err)
	}
	if result.Ref() != accountRef || store.calls != 1 ||
		store.reauthentication.HasProfile() {
		t.Fatalf("result=%#v store=%#v", result, store)
	}
}

// TestReauthenticatorAdvancesPastPersistedAccountVersion 验证并发重登在业务
// 时钟落后或同毫秒时仍生成严格递增的 CAS 版本。
func TestReauthenticatorAdvancesPastPersistedAccountVersion(t *testing.T) {
	t.Parallel()

	credential, _ := newClaudeReauthValues(
		t,
		"123e4567-e89b-12d3-a456-426614174105",
		"monotonic-version",
	)
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(11)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	persistedAt := time.Date(2026, time.August, 15, 6, 0, 0, 0, time.UTC)
	account, err := accountcore.NewAccount(testCatalog(t), accountcore.NewAccountInput{
		Identity:     credential,
		CLIAccountID: alias,
		CreatedAt:    persistedAt,
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	store := &reauthenticationStoreStub{account: account, target: account}
	reauthenticator, err := accountapp.NewReauthenticator(
		testCatalog(t),
		store,
		func() time.Time { return persistedAt },
	)
	if err != nil {
		t.Fatalf("NewReauthenticator() error = %v", err)
	}

	if _, err := reauthenticator.Reauthenticate(
		context.Background(),
		accountRef,
		credential,
		nil,
	); err != nil {
		t.Fatalf("Reauthenticate() error = %v", err)
	}
	if !store.reauthentication.UpdatedAt().Equal(persistedAt.Add(time.Millisecond)) ||
		store.targetCalls != 1 {
		t.Fatalf(
			"UpdatedAt=%s target_calls=%d",
			store.reauthentication.UpdatedAt(),
			store.targetCalls,
		)
	}
}

// TestReauthenticationOrdersOnlyProviderCredentialGeneration 验证凭据替换
// 只使用 Provider 凭据自身携带的非敏感时间事实。
func TestReauthenticationOrdersOnlyProviderCredentialGeneration(t *testing.T) {
	t.Parallel()

	const accountUUID = "123e4567-e89b-12d3-a456-426614174106"
	current := newClaudeGenerationCredential(
		t,
		accountUUID,
		"current",
		1_800_000_060_000,
	)
	tests := []struct {
		name     string
		incoming accountapp.Credential
		current  accountapp.Credential
		want     bool
		wantErr  error
	}{
		{
			name: "newer claude expiry",
			incoming: newClaudeGenerationCredential(
				t,
				accountUUID,
				"newer",
				1_800_000_120_000,
			),
			current: current,
			want:    true,
		},
		{
			name: "older claude expiry",
			incoming: newClaudeGenerationCredential(
				t,
				accountUUID,
				"older",
				1_800_000_000_000,
			),
			current: current,
		},
		{
			name:     "same claude expiry",
			incoming: current,
			current:  current,
		},
		{
			name:     "missing provider generation",
			incoming: unorderedReauthenticationCredential{label: "incoming"},
			current:  unorderedReauthenticationCredential{label: "current"},
			wantErr:  accountapp.ErrReauthenticationGenerationUnordered,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			accountRef, err := accountcore.DeriveAccountRef(test.incoming)
			if err != nil {
				t.Fatalf("DeriveAccountRef() error = %v", err)
			}
			command, err := accountapp.NewReauthentication(
				testCatalog(t),
				accountRef,
				test.incoming,
				nil,
				time.Date(2026, time.August, 15, 7, 0, 0, 0, time.UTC),
			)
			if err != nil {
				t.Fatalf("NewReauthentication() error = %v", err)
			}
			replace, err := command.ShouldReplaceCredential(test.current)
			if !errors.Is(err, test.wantErr) || replace != test.want {
				t.Fatalf(
					"ShouldReplaceCredential() = (%t, %v), want (%t, %v)",
					replace,
					err,
					test.want,
					test.wantErr,
				)
			}
		})
	}
}

// TestReauthenticatorValidatesTargetBeforeOAuth 验证授权开始前必须确认目标账号可原地认证。
func TestReauthenticatorValidatesTargetBeforeOAuth(t *testing.T) {
	t.Parallel()

	credential, _ := newClaudeReauthValues(
		t,
		"123e4567-e89b-12d3-a456-426614174104",
		"target",
	)
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(9)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(testCatalog(t), accountcore.NewAccountInput{
		Identity:     credential,
		CLIAccountID: alias,
		CreatedAt:    time.Now(),
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	store := &reauthenticationStoreStub{target: account}
	catalog := testCatalog(t)
	reauthenticator, err := accountapp.NewReauthenticator(
		catalog,
		store,
		time.Now,
	)
	if err != nil {
		t.Fatalf("NewReauthenticator() error = %v", err)
	}

	if err := reauthenticator.ValidateTarget(
		context.Background(),
		accountRef,
		"claude",
	); err != nil {
		t.Fatalf("ValidateTarget() error = %v", err)
	}
	if store.targetCalls != 1 {
		t.Fatalf("GetReauthenticationTarget() calls = %d", store.targetCalls)
	}
	if err := reauthenticator.ValidateTarget(
		context.Background(),
		accountRef,
		"codex",
	); !errors.Is(err, accountapp.ErrReauthenticationIdentityMismatch) {
		t.Fatalf(
			"ValidateTarget(provider mismatch) error = %v",
			err,
		)
	}
}

// TestReauthenticatorPropagatesUnsupportedTarget 验证静态凭据不会启动 OAuth reauth。
func TestReauthenticatorPropagatesUnsupportedTarget(t *testing.T) {
	t.Parallel()

	store := &reauthenticationStoreStub{
		targetErr: accountapp.ErrReauthenticationUnsupported,
	}
	catalog := testCatalog(t)
	reauthenticator, err := accountapp.NewReauthenticator(
		catalog,
		store,
		time.Now,
	)
	if err != nil {
		t.Fatalf("NewReauthenticator() error = %v", err)
	}
	accountRef, err := accountcore.ParseAccountRef("acct_1234567890abcdef1234")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}

	err = reauthenticator.ValidateTarget(
		context.Background(),
		accountRef,
		"codex",
	)
	if !errors.Is(err, accountapp.ErrReauthenticationUnsupported) {
		t.Fatalf("ValidateTarget() error = %v", err)
	}
}

// reauthenticationStoreStub 记录应用服务生成的重新认证命令。
type reauthenticationStoreStub struct {
	account          accountcore.Account
	target           accountcore.Account
	targetErr        error
	reauthentication accountapp.Reauthentication
	calls            int
	targetCalls      int
}

// GetReauthenticationTarget 返回测试预设的可原地重新认证账号。
func (store *reauthenticationStoreStub) GetReauthenticationTarget(
	_ context.Context,
	_ accountcore.AccountRef,
) (accountcore.Account, error) {
	store.targetCalls++
	if !store.target.IsValid() {
		return store.account, store.targetErr
	}
	return store.target, store.targetErr
}

// Reauthenticate 保存命令并返回预设账号。
func (store *reauthenticationStoreStub) Reauthenticate(
	_ context.Context,
	reauthentication accountapp.Reauthentication,
) (accountcore.Account, error) {
	store.calls++
	store.reauthentication = reauthentication
	return store.account, nil
}

// newClaudeReauthValues 创建同一 UUID 可更换 Token 的 Claude OAuth 测试值。
func newClaudeReauthValues(
	t *testing.T,
	accountUUID string,
	tokenLabel string,
) (*claude.OAuthAuth, claude.AccountProfile) {
	t.Helper()

	identity := claude.OAuthIdentity{AccountUUID: accountUUID}
	credential, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:  "sk-ant-oat01-" + tokenLabel,
		RefreshToken: "sk-ant-ort01-" + tokenLabel,
		ExpiresAtMS:  1_800_000_000_000,
		Scopes:       []string{claude.InferenceScope},
		Identity:     identity,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	oauthProfile, err := claude.NewOAuthProfile(claude.OAuthProfileInput{
		AccountUUID:      accountUUID,
		Email:            tokenLabel + "@example.invalid",
		OrganizationUUID: "123e4567-e89b-12d3-a456-426614174200",
		OrganizationName: "Reauth Test",
		DisplayName:      "Reauth " + tokenLabel,
		BillingType:      "stripe_subscription",
	})
	if err != nil {
		t.Fatalf("NewOAuthProfile() error = %v", err)
	}
	subscription, err := claude.NewSubscription(
		"max",
		"default_claude_max_20x",
	)
	if err != nil {
		t.Fatalf("NewSubscription() error = %v", err)
	}
	profile, err := claude.NewAccountProfile(oauthProfile, subscription)
	if err != nil {
		t.Fatalf("NewAccountProfile() error = %v", err)
	}
	return credential, profile
}

func newClaudeGenerationCredential(
	t *testing.T,
	accountUUID string,
	label string,
	expiresAtMS int64,
) *claude.OAuthAuth {
	t.Helper()

	credential, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:  "generation-" + label + "-access",
		RefreshToken: "generation-" + label + "-refresh",
		ExpiresAtMS:  expiresAtMS,
		Scopes:       []string{claude.InferenceScope},
		Identity: claude.OAuthIdentity{
			AccountUUID: accountUUID,
		},
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return credential
}

type unorderedReauthenticationCredential struct {
	label string
}

func (unorderedReauthenticationCredential) ProviderID() string { return "claude" }
func (unorderedReauthenticationCredential) IdentitySeed() string {
	return "claude:oauth:unordered-reauthentication-generation"
}
func (credential unorderedReauthenticationCredential) String() string {
	return "unorderedReauthenticationCredential<" + credential.label + ">"
}
func (credential unorderedReauthenticationCredential) GoString() string {
	return credential.String()
}
