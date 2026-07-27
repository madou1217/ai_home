package sqliteaccount

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

func TestProfileStoreRoundTripsCodexAndClaudeProfiles(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		credential accountapp.Credential
		profile    accountapp.PublicProfile
	}{
		{
			name:       "codex",
			credential: newTestCodexOAuth(t),
			profile:    newTestCodexAccountProfile(t),
		},
		{
			name:       "claude",
			credential: newTestClaudeOAuth(t),
			profile:    newTestClaudeAccountProfile(t, "max", "default_claude_max_20x"),
		},
	}

	for index, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			store := openTestStore(t)
			account := newAccountForCredential(t, store, test.credential, int64(index+1))
			registerAccountWithCredential(t, store, account, test.credential)
			snapshot := newProfileSnapshot(t, store, test.profile, testAccountTime())
			if snapshot.AccountRef() != account.Ref() {
				t.Fatalf(
					"profile ref = %s, want account ref %s",
					snapshot.AccountRef(),
					account.Ref(),
				)
			}
			if err := store.UpsertProfile(context.Background(), snapshot); err != nil {
				t.Fatalf("UpsertProfile() error = %v", err)
			}
			restored, err := store.GetProfile(context.Background(), account.Ref())
			if err != nil {
				t.Fatalf("GetProfile() error = %v", err)
			}
			if restored.AccountRef() != account.Ref() ||
				restored.Profile().IdentitySeed() != test.profile.IdentitySeed() ||
				restored.Profile().DisplayName() != test.profile.DisplayName() ||
				restored.Profile().Email() != test.profile.Email() ||
				restored.Profile().SubscriptionKind() != test.profile.SubscriptionKind() ||
				restored.Profile().SubscriptionRaw() != test.profile.SubscriptionRaw() ||
				!restored.UpdatedAt().Equal(snapshot.UpdatedAt()) {
				t.Fatalf("恢复公开资料错误: %#v", restored)
			}
		})
	}
}

func TestProfileStoreRejectsMissingAccountAndStaleSnapshot(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	missingProfile := newCodexAccountProfile(
		t,
		"missing-profile-user",
		codex.PersonalAccountID,
		"plus",
	)
	missingSnapshot := newProfileSnapshot(t, store, missingProfile, testAccountTime())
	if err := store.UpsertProfile(
		context.Background(),
		missingSnapshot,
	); !errors.Is(err, accountapp.ErrAccountNotFound) {
		t.Fatalf("missing account error = %v, want ErrAccountNotFound", err)
	}

	credential := newTestCodexOAuth(t)
	account := newAccountForCredential(t, store, credential, 1)
	registerAccountWithCredential(t, store, account, credential)
	currentProfile := newCodexAccountProfile(
		t,
		"codex-user",
		"codex-workspace",
		"pro",
	)
	current := newProfileSnapshot(
		t,
		store,
		currentProfile,
		testAccountTime().Add(2*time.Second),
	)
	if err := store.UpsertProfile(context.Background(), current); err != nil {
		t.Fatalf("UpsertProfile(current) error = %v", err)
	}
	staleProfile := newCodexAccountProfile(
		t,
		"codex-user",
		"codex-workspace",
		"team",
	)
	stale := newProfileSnapshot(
		t,
		store,
		staleProfile,
		testAccountTime().Add(time.Second),
	)
	if err := store.UpsertProfile(
		context.Background(),
		stale,
	); !errors.Is(err, accountapp.ErrProfileConflict) {
		t.Fatalf("UpsertProfile(stale) error = %v, want ErrProfileConflict", err)
	}
	restored, err := store.GetProfile(context.Background(), account.Ref())
	if err != nil {
		t.Fatalf("GetProfile() error = %v", err)
	}
	if restored.Profile().SubscriptionKind() != codex.PlanFamilyPro.String() {
		t.Fatalf("stale profile overwrote current: %#v", restored)
	}
}

func TestProfileStoreRejectsDivergentEqualVersionAndAllowsIdempotency(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	credential := newTestCodexOAuth(t)
	account := newAccountForCredential(t, store, credential, 1)
	registerAccountWithCredential(t, store, account, credential)
	first := newProfileSnapshot(
		t,
		store,
		newTestCodexAccountProfile(t),
		testAccountTime(),
	)
	if err := store.UpsertProfile(context.Background(), first); err != nil {
		t.Fatalf("UpsertProfile(first) error = %v", err)
	}
	if err := store.UpsertProfile(context.Background(), first); err != nil {
		t.Fatalf("UpsertProfile(idempotent) error = %v", err)
	}
	divergent := newProfileSnapshot(
		t,
		store,
		newCodexAccountProfile(t, "codex-user", "codex-workspace", "pro"),
		testAccountTime(),
	)
	if err := store.UpsertProfile(
		context.Background(),
		divergent,
	); !errors.Is(err, accountapp.ErrProfileConflict) {
		t.Fatalf("UpsertProfile(divergent) error = %v, want ErrProfileConflict", err)
	}
}

// TestProfileStoreRejectsTamperedProfileIdentity 验证公开资料身份与账号主键不一致时失败关闭。
func TestProfileStoreRejectsTamperedProfileIdentity(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	credential := newTestCodexOAuth(t)
	account := newAccountForCredential(t, store, credential, 1)
	registerAccountWithCredential(t, store, account, credential)
	snapshot := newProfileSnapshot(
		t,
		store,
		newTestCodexAccountProfile(t),
		testAccountTime(),
	)
	if err := store.UpsertProfile(context.Background(), snapshot); err != nil {
		t.Fatalf("UpsertProfile() error = %v", err)
	}
	const tamperedProfile = `{
		"user_id":"another-user",
		"account_id":"codex-workspace",
		"is_fedramp":false
	}`
	if _, err := store.db.Exec(
		"UPDATE account_profiles SET profile_json = ? WHERE account_ref = ?",
		tamperedProfile,
		account.Ref().String(),
	); err != nil {
		t.Fatalf("tamper profile error = %v", err)
	}
	if _, err := store.GetProfile(
		context.Background(),
		account.Ref(),
	); !errors.Is(err, ErrInvalidProfileDocument) {
		t.Fatalf("GetProfile() error = %v, want ErrInvalidProfileDocument", err)
	}
}

func TestProfileStoreConcurrentUpdatesKeepNewestSnapshot(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	credential := newTestCodexOAuth(t)
	account := newAccountForCredential(t, store, credential, 1)
	registerAccountWithCredential(t, store, account, credential)
	profiles := []accountapp.ProfileSnapshot{
		newProfileSnapshot(
			t,
			store,
			newCodexAccountProfile(t, "codex-user", "codex-workspace", "plus"),
			testAccountTime().Add(time.Second),
		),
		newProfileSnapshot(
			t,
			store,
			newCodexAccountProfile(t, "codex-user", "codex-workspace", "pro"),
			testAccountTime().Add(2*time.Second),
		),
	}

	start := make(chan struct{})
	errs := make([]error, len(profiles))
	var waitGroup sync.WaitGroup
	waitGroup.Add(len(profiles))
	for index, profile := range profiles {
		go func() {
			defer waitGroup.Done()
			<-start
			errs[index] = store.UpsertProfile(context.Background(), profile)
		}()
	}
	close(start)
	waitGroup.Wait()
	for _, err := range errs {
		if err != nil && !errors.Is(err, accountapp.ErrProfileConflict) {
			t.Fatalf("concurrent UpsertProfile() error = %v", err)
		}
	}
	restored, err := store.GetProfile(context.Background(), account.Ref())
	if err != nil {
		t.Fatalf("GetProfile() error = %v", err)
	}
	if restored.Profile().SubscriptionKind() != codex.PlanFamilyPro.String() {
		t.Fatalf("newest profile was not preserved: %#v", restored)
	}
}

func TestProfileCodecRejectsUnknownDuplicateAndTrailingJSON(t *testing.T) {
	t.Parallel()

	registry := newProfileRegistry()
	tests := [][]byte{
		[]byte(`{"user_id":"user","account_id":"personal","is_fedramp":false,"extra":true}`),
		[]byte(`{"user_id":"first","user_id":"second","account_id":"personal","is_fedramp":false}`),
		[]byte(`{"user_id":"user","account_id":"personal","is_fedramp":false}{}`),
	}
	for _, payload := range tests {
		_, err := registry.Decode(codex.ProviderID, encodedProfile{
			email:            "owner@example.com",
			subscriptionKind: "plus",
			subscriptionRaw:  "plus",
			json:             payload,
		})
		if !errors.Is(err, ErrInvalidProfileDocument) {
			t.Fatalf("Decode(%s) error = %v, want ErrInvalidProfileDocument", payload, err)
		}
	}
}

func registerAccountWithCredential(
	t *testing.T,
	store *Store,
	account accountcore.Account,
	credential accountapp.Credential,
) {
	t.Helper()

	registration, err := accountapp.NewRegistration(account, credential, testAccountTime())
	if err != nil {
		t.Fatalf("NewRegistration() error = %v", err)
	}
	if err := store.Register(context.Background(), registration); err != nil {
		t.Fatalf("Register() error = %v", err)
	}
}

func newProfileSnapshot(
	t *testing.T,
	store *Store,
	profile accountapp.PublicProfile,
	updatedAt time.Time,
) accountapp.ProfileSnapshot {
	t.Helper()

	snapshot, err := accountapp.NewProfileSnapshot(store.catalog, profile, updatedAt)
	if err != nil {
		t.Fatalf("NewProfileSnapshot() error = %v", err)
	}
	return snapshot
}

func newTestCodexAccountProfile(t *testing.T) codex.AccountProfile {
	t.Helper()
	return newCodexAccountProfile(t, "codex-user", "codex-workspace", "plus")
}

func newCodexAccountProfile(
	t *testing.T,
	userID string,
	accountID string,
	plan string,
) codex.AccountProfile {
	t.Helper()

	profile, err := codex.NewAccountProfile(codex.Profile{
		UserID:    userID,
		AccountID: accountID,
		Email:     "codex@example.com",
		Plan:      codex.ParsePlan(plan),
	})
	if err != nil {
		t.Fatalf("codex.NewAccountProfile() error = %v", err)
	}
	return profile
}

func newTestClaudeAccountProfile(
	t *testing.T,
	subscriptionType string,
	rateLimitTier string,
) claude.AccountProfile {
	t.Helper()

	extraUsageEnabled := true
	oauth, err := claude.NewOAuthProfile(claude.OAuthProfileInput{
		AccountUUID:             "123e4567-e89b-12d3-a456-426614174000",
		Email:                   "claude@example.com",
		OrganizationUUID:        "223e4567-e89b-12d3-a456-426614174000",
		OrganizationName:        "AI Home",
		OrganizationRole:        "admin",
		WorkspaceRole:           "developer",
		DisplayName:             "Claude Owner",
		HasExtraUsageEnabled:    &extraUsageEnabled,
		BillingType:             "stripe_subscription",
		AccountCreatedAtMS:      1_700_000_000_000,
		SubscriptionCreatedAtMS: 1_710_000_000_000,
	})
	if err != nil {
		t.Fatalf("claude.NewOAuthProfile() error = %v", err)
	}
	subscription, err := claude.NewSubscription(subscriptionType, rateLimitTier)
	if err != nil {
		t.Fatalf("claude.NewSubscription() error = %v", err)
	}
	profile, err := claude.NewAccountProfile(oauth, subscription)
	if err != nil {
		t.Fatalf("claude.NewAccountProfile() error = %v", err)
	}
	return profile
}
