package sqliteaccount

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
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
		1_700_000_000_000,
	)
	account := registerReauthenticationFixture(
		t,
		store,
		originalCredential,
		originalProfile,
	)
	usage := newUsageStoreSnapshot(
		t,
		account.Ref(),
		testAccountTime(),
		[]usagecore.EntryInput{{
			Bucket:       "primary",
			Kind:         usagecore.KindWindow,
			Scope:        usagecore.ScopeAccount,
			Availability: usagecore.AvailabilityExhausted,
		}},
	)
	if err := store.ReplaceUsageSnapshot(context.Background(), usage); err != nil {
		t.Fatalf("ReplaceUsageSnapshot() error = %v", err)
	}
	providerDefault := newProviderDefault(
		t,
		"codex",
		account.Ref(),
		testAccountTime().Add(time.Second),
	)
	if _, err := store.SetProviderDefault(
		context.Background(),
		providerDefault,
	); err != nil {
		t.Fatalf("SetProviderDefault() error = %v", err)
	}
	replacementCredential, replacementProfile := newCodexReauthenticationValues(
		t,
		"replacement",
		"team",
		1_700_000_060_000,
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
	assertStoredModelIDs(t, store, account.Ref(), "test-model")
	if _, err := store.GetUsageSnapshot(
		context.Background(),
		account.Ref(),
	); !errors.Is(err, usageapp.ErrSnapshotNotFound) {
		t.Fatalf("GetUsageSnapshot(after reauthentication) error = %v", err)
	}
	defaultAfterReauthentication, err := store.GetProviderDefault(
		context.Background(),
		"codex",
	)
	if err != nil || defaultAfterReauthentication != providerDefault {
		t.Fatalf(
			"GetProviderDefault(after reauthentication) = (%#v, %v)",
			defaultAfterReauthentication,
			err,
		)
	}
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
		1_700_000_000_000,
	)
	account := newAccountForCredential(t, store, originalCredential, 1)
	registerAccountWithCredential(t, store, account, originalCredential)
	replacementCredential, replacementProfile := newCodexReauthenticationValues(
		t,
		"missing-profile-replacement",
		"pro",
		1_700_000_060_000,
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

// TestReauthenticatePreservesMissingProfileWhenOnlyCredentialIsAvailable 验证
// profileless OAuth 更新只替换凭据，不伪造公开资料。
func TestReauthenticatePreservesMissingProfileWhenOnlyCredentialIsAvailable(
	t *testing.T,
) {
	t.Parallel()

	newCredential := func(
		accessToken string,
		refreshToken string,
		expiresAtMS int64,
	) *claude.OAuthAuth {
		credential, err := claude.NewOAuthAuth(claude.OAuthInput{
			AccessToken:  accessToken,
			RefreshToken: refreshToken,
			ExpiresAtMS:  expiresAtMS,
			Scopes:       []string{claude.InferenceScope},
			Identity: claude.OAuthIdentity{
				AccountUUID: "123e4567-e89b-12d3-a456-426614174397",
			},
		})
		if err != nil {
			t.Fatalf("NewOAuthAuth() error = %v", err)
		}
		return credential
	}

	store := openTestStore(t)
	original := newCredential(
		"profileless-old-access",
		"profileless-old-refresh",
		4_102_444_800_000,
	)
	account := newAccountForCredential(t, store, original, 1)
	registerAccountWithCredential(t, store, account, original)
	replacement := newCredential(
		"profileless-new-access",
		"profileless-new-refresh",
		4_102_444_860_000,
	)
	updatedAt := testAccountTime().Add(2 * time.Second)
	command := newReauthenticationCommand(
		t,
		store,
		account.Ref(),
		replacement,
		nil,
		updatedAt,
	)

	result, err := store.Reauthenticate(context.Background(), command)
	if err != nil {
		t.Fatalf("Reauthenticate() error = %v", err)
	}
	stored, err := store.GetCredential(context.Background(), account.Ref())
	if err != nil {
		t.Fatalf("GetCredential() error = %v", err)
	}
	storedOAuth, valid := stored.(*claude.OAuthAuth)
	if !valid || storedOAuth.AccessToken() != "profileless-new-access" ||
		storedOAuth.RefreshToken() != "profileless-new-refresh" ||
		result.Ref() != account.Ref() || !result.UpdatedAt().Equal(updatedAt) {
		t.Fatalf("result=%#v stored=%T", result, stored)
	}
	if _, err := store.GetProfile(
		context.Background(),
		account.Ref(),
	); !errors.Is(err, accountapp.ErrProfileNotFound) {
		t.Fatalf("GetProfile() error = %v, want ErrProfileNotFound", err)
	}
}

// TestReauthenticatePreservesExistingProfileWhenReplacementOmitsIt 验证新
// artifact 没有资料时只推进凭据，不清空上次可信公开快照。
func TestReauthenticatePreservesExistingProfileWhenReplacementOmitsIt(
	t *testing.T,
) {
	t.Parallel()

	store := openTestStore(t)
	originalCredential, originalProfile := newCodexReauthenticationValues(
		t,
		"preserved-profile-original",
		"plus",
		1_700_000_000_000,
	)
	account := registerReauthenticationFixture(
		t,
		store,
		originalCredential,
		originalProfile,
	)
	replacementCredential, _ := newCodexReauthenticationValues(
		t,
		"preserved-profile-replacement",
		"team",
		1_700_000_060_000,
	)
	updatedAt := testAccountTime().Add(2 * time.Second)
	command := newReauthenticationCommand(
		t,
		store,
		account.Ref(),
		replacementCredential,
		nil,
		updatedAt,
	)

	if _, err := store.Reauthenticate(context.Background(), command); err != nil {
		t.Fatalf("Reauthenticate() error = %v", err)
	}
	storedProfile, err := store.GetProfile(context.Background(), account.Ref())
	if err != nil {
		t.Fatalf("GetProfile() error = %v", err)
	}
	if storedProfile.Profile().Email() !=
		"preserved-profile-original@example.invalid" ||
		storedProfile.Profile().SubscriptionKind() !=
			codex.PlanFamilyPlus.String() ||
		!storedProfile.UpdatedAt().Equal(testAccountTime()) {
		t.Fatalf("GetProfile() = %#v", storedProfile)
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
		"codex-preserved-profile-replacement-refresh-secret",
	)
}

// TestReauthenticateRejectsStaleVersionWithoutMutation 验证旧 OAuth 结果不能覆盖当前快照。
func TestReauthenticateRejectsStaleVersionWithoutMutation(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	originalCredential, originalProfile := newCodexReauthenticationValues(
		t,
		"original-stale",
		"plus",
		1_700_000_000_000,
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
		1_700_000_060_000,
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

// TestReauthenticateKeepsNewerCredentialWhenOlderGenerationArrivesLate 验证
// 事务内 generation 仲裁不会让晚到旧凭据推进账号或资料 metadata。
func TestReauthenticateKeepsNewerCredentialWhenOlderGenerationArrivesLate(
	t *testing.T,
) {
	t.Parallel()

	store := openTestStore(t)
	currentCredential, currentProfile := newCodexReauthenticationValues(
		t,
		"current-generation",
		"team",
		1_700_000_120_000,
	)
	account := registerReauthenticationFixture(
		t,
		store,
		currentCredential,
		currentProfile,
	)
	olderCredential, olderProfile := newCodexReauthenticationValues(
		t,
		"older-generation",
		"plus",
		1_700_000_060_000,
	)
	command := newReauthenticationCommand(
		t,
		store,
		account.Ref(),
		olderCredential,
		olderProfile,
		testAccountTime().Add(2*time.Second),
	)

	result, err := store.Reauthenticate(context.Background(), command)
	if err != nil {
		t.Fatalf("Reauthenticate() error = %v", err)
	}
	if result != account {
		t.Fatalf("Reauthenticate() result = %#v, want %#v", result, account)
	}
	assertStoredReauthenticationFixture(
		t,
		store,
		account,
		"codex-current-generation-refresh-secret",
		codex.PlanFamilyBusiness.String(),
	)
}

// TestReauthenticateRejectsCredentialsWithoutComparableGeneration 验证没有
// Provider 代际时间的 OAuth 更新失败关闭，不使用命令时间猜新旧。
func TestReauthenticateRejectsCredentialsWithoutComparableGeneration(
	t *testing.T,
) {
	t.Parallel()

	store := openTestStore(t)
	currentCredential, currentProfile := newCodexReauthenticationValues(
		t,
		"unordered-current",
		"plus",
		0,
	)
	account := registerReauthenticationFixture(
		t,
		store,
		currentCredential,
		currentProfile,
	)
	incomingCredential, incomingProfile := newCodexReauthenticationValues(
		t,
		"unordered-incoming",
		"team",
		0,
	)
	command := newReauthenticationCommand(
		t,
		store,
		account.Ref(),
		incomingCredential,
		incomingProfile,
		testAccountTime().Add(2*time.Second),
	)

	_, err := store.Reauthenticate(context.Background(), command)
	if !errors.Is(err, accountapp.ErrReauthenticationGenerationUnordered) {
		t.Fatalf("Reauthenticate() error = %v", err)
	}
	assertStoredReauthenticationFixture(
		t,
		store,
		account,
		"codex-unordered-current-refresh-secret",
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
		1_700_000_000_000,
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
		1_700_000_060_000,
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
	models, err := accountapp.NormalizeDiscoveredModels([]string{"test-model"})
	if err != nil {
		t.Fatalf("NormalizeDiscoveredModels() error = %v", err)
	}
	if _, err := store.ReplaceDiscoveredModels(
		context.Background(),
		account.Ref(),
		models,
		testAccountTime().Add(time.Millisecond),
	); err != nil {
		t.Fatalf("ReplaceDiscoveredModels() error = %v", err)
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
	refreshedAtMS int64,
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
		RefreshedAtMS:     refreshedAtMS,
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
	assertStoredModelIDs(t, store, expectedAccount.Ref(), "test-model")
}

// assertStoredModelIDs 验证事务成功或回滚后的模型快照。
func assertStoredModelIDs(
	t *testing.T,
	store *Store,
	accountRef accountcore.AccountRef,
	expected ...string,
) {
	t.Helper()

	models, err := store.ListAccountModels(context.Background(), accountRef)
	if err != nil {
		t.Fatalf("ListAccountModels() error = %v", err)
	}
	if len(models) != len(expected) {
		t.Fatalf("model count=%d want=%d models=%#v", len(models), len(expected), models)
	}
	for index, modelID := range expected {
		if models[index].ModelID().String() != modelID {
			t.Fatalf("model[%d]=%s want=%s", index, models[index].ModelID(), modelID)
		}
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
