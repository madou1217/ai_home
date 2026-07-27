package sqliteaccount

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

// TestReauthenticateAtomicallyReplacesCredentialProfileAndAccountVersion 验证三张表同步推进。
func TestReauthenticateAtomicallyReplacesCredentialProfileAndAccountVersion(
	t *testing.T,
) {
	t.Parallel()

	store := openTestStore(t)
	originalCredential, originalProfile := newCodexReauthenticationValues(
		t,
		"original",
		"plus",
	)
	account := registerReauthenticationFixture(
		t,
		store,
		originalCredential,
		originalProfile,
	)
	replacementCredential, replacementProfile := newCodexReauthenticationValues(
		t,
		"replacement",
		"team",
	)
	updatedAt := testAccountTime().Add(2 * time.Second)
	command := newReauthenticationCommand(
		t,
		store,
		account.Ref(),
		replacementCredential,
		replacementProfile,
		updatedAt,
	)

	result, err := store.Reauthenticate(context.Background(), command)
	if err != nil {
		t.Fatalf("Reauthenticate() error = %v", err)
	}
	if result.Ref() != account.Ref() ||
		result.CLIAccountID() != account.CLIAccountID() ||
		!result.UpdatedAt().Equal(updatedAt) {
		t.Fatalf("Reauthenticate() result = %#v", result)
	}
	storedCredential, err := store.GetCredential(
		context.Background(),
		account.Ref(),
	)
	if err != nil {
		t.Fatalf("GetCredential() error = %v", err)
	}
	assertCredentialSecret(
		t,
		storedCredential,
		"codex-replacement-refresh-secret",
	)
	storedProfile, err := store.GetProfile(context.Background(), account.Ref())
	if err != nil {
		t.Fatalf("GetProfile() error = %v", err)
	}
	if storedProfile.Profile().Email() != "replacement@example.invalid" ||
		storedProfile.Profile().SubscriptionKind() != codex.PlanFamilyBusiness.String() ||
		!storedProfile.UpdatedAt().Equal(updatedAt) {
		t.Fatalf("GetProfile() = %#v", storedProfile)
	}
	assertReauthenticationVersions(t, store, account.Ref(), updatedAt.UnixMilli())
}

// TestGetReauthenticationTargetRejectsTokenBoundCredentials 验证静态身份不进入 OAuth 流程。
func TestGetReauthenticationTargetRejectsTokenBoundCredentials(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		credential accountapp.Credential
	}{
		{
			name:       "codex api key",
			credential: mustCodexAPIKey(t, "sk-test-reauth-static"),
		},
		{
			name:       "claude setup token",
			credential: mustClaudeOAuthToken(t, "sk-ant-oat01-reauth-static"),
		},
	}
	for index, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			store := openTestStore(t)
			account := newAccountForCredential(
				t,
				store,
				test.credential,
				int64(index+1),
			)
			registerAccountWithCredential(t, store, account, test.credential)

			_, err := store.GetReauthenticationTarget(
				context.Background(),
				account.Ref(),
			)
			if !errors.Is(err, accountapp.ErrReauthenticationUnsupported) {
				t.Fatalf(
					"GetReauthenticationTarget() error = %v",
					err,
				)
			}
		})
	}
}

// TestReauthenticateCreatesMissingProfile 验证历史上没有资料的 OAuth 账号可被补全。
func TestReauthenticateCreatesMissingProfile(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	originalCredential, _ := newCodexReauthenticationValues(
		t,
		"missing-profile-original",
		"plus",
	)
	account := newAccountForCredential(t, store, originalCredential, 1)
	registerAccountWithCredential(t, store, account, originalCredential)
	replacementCredential, replacementProfile := newCodexReauthenticationValues(
		t,
		"missing-profile-replacement",
		"pro",
	)
	updatedAt := testAccountTime().Add(2 * time.Second)
	command := newReauthenticationCommand(
		t,
		store,
		account.Ref(),
		replacementCredential,
		replacementProfile,
		updatedAt,
	)

	if _, err := store.Reauthenticate(
		context.Background(),
		command,
	); err != nil {
		t.Fatalf("Reauthenticate() error = %v", err)
	}
	profile, err := store.GetProfile(context.Background(), account.Ref())
	if err != nil {
		t.Fatalf("GetProfile() error = %v", err)
	}
	if profile.Profile().Email() !=
		"missing-profile-replacement@example.invalid" {
		t.Fatalf("GetProfile() = %#v", profile)
	}
	assertReauthenticationVersions(t, store, account.Ref(), updatedAt.UnixMilli())
}

// TestReauthenticateRejectsStaleVersionWithoutMutation 验证旧 OAuth 结果不能覆盖当前快照。
func TestReauthenticateRejectsStaleVersionWithoutMutation(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	originalCredential, originalProfile := newCodexReauthenticationValues(
		t,
		"original-stale",
		"plus",
	)
	account := registerReauthenticationFixture(
		t,
		store,
		originalCredential,
		originalProfile,
	)
	replacementCredential, replacementProfile := newCodexReauthenticationValues(
		t,
		"replacement-stale",
		"team",
	)
	command := newReauthenticationCommand(
		t,
		store,
		account.Ref(),
		replacementCredential,
		replacementProfile,
		testAccountTime(),
	)

	_, err := store.Reauthenticate(context.Background(), command)
	if !errors.Is(err, accountapp.ErrReauthenticationConflict) {
		t.Fatalf("Reauthenticate() error = %v", err)
	}
	assertStoredReauthenticationFixture(
		t,
		store,
		account,
		"codex-original-stale-refresh-secret",
		codex.PlanFamilyPlus.String(),
	)
}

// TestReauthenticateRollsBackCredentialWhenProfileWriteFails 验证任一写入失败都保留旧快照。
func TestReauthenticateRollsBackCredentialWhenProfileWriteFails(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	originalCredential, originalProfile := newCodexReauthenticationValues(
		t,
		"original-rollback",
		"plus",
	)
	account := registerReauthenticationFixture(
		t,
		store,
		originalCredential,
		originalProfile,
	)
	const rejectProfileUpdate = `
		CREATE TRIGGER reject_reauthentication_profile
		BEFORE UPDATE ON account_profiles
		BEGIN
			SELECT RAISE(ABORT, 'forced profile failure');
		END`
	if _, err := store.db.Exec(rejectProfileUpdate); err != nil {
		t.Fatalf("CREATE TRIGGER error = %v", err)
	}
	replacementCredential, replacementProfile := newCodexReauthenticationValues(
		t,
		"replacement-rollback",
		"team",
	)
	command := newReauthenticationCommand(
		t,
		store,
		account.Ref(),
		replacementCredential,
		replacementProfile,
		testAccountTime().Add(2*time.Second),
	)

	if _, err := store.Reauthenticate(
		context.Background(),
		command,
	); err == nil {
		t.Fatal("Reauthenticate() error = nil")
	}
	assertStoredReauthenticationFixture(
		t,
		store,
		account,
		"codex-original-rollback-refresh-secret",
		codex.PlanFamilyPlus.String(),
	)
}

// registerReauthenticationFixture 原子注册带凭据和资料的 OAuth 测试账号。
func registerReauthenticationFixture(
	t *testing.T,
	store *Store,
	credential accountapp.Credential,
	profile accountapp.PublicProfile,
) accountcore.Account {
	t.Helper()

	request := newRegistrationRequest(t, store, credential, profile)
	account, err := store.RegisterNew(context.Background(), request)
	if err != nil {
		t.Fatalf("RegisterNew() error = %v", err)
	}
	return account
}

// newReauthenticationCommand 创建经过应用层身份校验的测试命令。
func newReauthenticationCommand(
	t *testing.T,
	store *Store,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	profile accountapp.PublicProfile,
	updatedAt time.Time,
) accountapp.Reauthentication {
	t.Helper()

	command, err := accountapp.NewReauthentication(
		store.catalog,
		accountRef,
		credential,
		profile,
		updatedAt,
	)
	if err != nil {
		t.Fatalf("NewReauthentication() error = %v", err)
	}
	return command
}

// newCodexReauthenticationValues 创建稳定身份相同但 Token 和套餐不同的测试值。
func newCodexReauthenticationValues(
	t *testing.T,
	label string,
	plan string,
) (*codex.OAuthAuth, codex.AccountProfile) {
	t.Helper()

	credential, err := codex.NewOAuthAuth(codex.OAuthInput{
		AccessToken: testJWT(t, map[string]any{
			"exp": 2_000_000_000,
		}),
		RefreshToken: "codex-" + label + "-refresh-secret",
		IDToken: testJWT(t, map[string]any{
			"sub":   "codex-user",
			"email": label + "@example.invalid",
			"https://api.openai.com/auth": map[string]any{
				"chatgpt_user_id":    "codex-user",
				"chatgpt_account_id": "codex-workspace",
				"chatgpt_plan_type":  plan,
			},
		}),
		RefreshedAtMS:     1_700_000_000_000,
		ExplicitAccountID: "codex-workspace",
	})
	if err != nil {
		t.Fatalf("codex.NewOAuthAuth() error = %v", err)
	}
	profile, err := codex.NewAccountProfile(credential.Profile())
	if err != nil {
		t.Fatalf("codex.NewAccountProfile() error = %v", err)
	}
	return credential, profile
}

// assertStoredReauthenticationFixture 验证失败后账号、凭据和资料仍是注册版本。
func assertStoredReauthenticationFixture(
	t *testing.T,
	store *Store,
	expectedAccount accountcore.Account,
	expectedSecret string,
	expectedSubscription string,
) {
	t.Helper()

	account, err := store.GetByRef(context.Background(), expectedAccount.Ref())
	if err != nil {
		t.Fatalf("GetByRef() error = %v", err)
	}
	if account != expectedAccount {
		t.Fatalf("GetByRef() = %#v, want %#v", account, expectedAccount)
	}
	credential, err := store.GetCredential(
		context.Background(),
		expectedAccount.Ref(),
	)
	if err != nil {
		t.Fatalf("GetCredential() error = %v", err)
	}
	assertCredentialSecret(t, credential, expectedSecret)
	profile, err := store.GetProfile(
		context.Background(),
		expectedAccount.Ref(),
	)
	if err != nil {
		t.Fatalf("GetProfile() error = %v", err)
	}
	if profile.Profile().SubscriptionKind() != expectedSubscription {
		t.Fatalf("GetProfile() = %#v", profile)
	}
}

// assertReauthenticationVersions 验证三张表使用同一个业务更新时间。
func assertReauthenticationVersions(
	t *testing.T,
	store *Store,
	accountRef accountcore.AccountRef,
	expected int64,
) {
	t.Helper()

	var accountUpdatedAt, credentialUpdatedAt, profileUpdatedAt int64
	const query = `
		SELECT a.updated_at_ms, c.updated_at_ms, p.updated_at_ms
		FROM accounts AS a
		INNER JOIN account_credentials AS c ON c.account_ref = a.account_ref
		INNER JOIN account_profiles AS p ON p.account_ref = a.account_ref
		WHERE a.account_ref = ?`
	err := store.db.QueryRow(query, accountRef.String()).Scan(
		&accountUpdatedAt,
		&credentialUpdatedAt,
		&profileUpdatedAt,
	)
	if err != nil {
		t.Fatalf("query reauthentication versions error = %v", err)
	}
	if accountUpdatedAt != expected ||
		credentialUpdatedAt != expected ||
		profileUpdatedAt != expected {
		t.Fatalf(
			"versions = (%d, %d, %d), want %d",
			accountUpdatedAt,
			credentialUpdatedAt,
			profileUpdatedAt,
			expected,
		)
	}
}
