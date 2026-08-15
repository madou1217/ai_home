package accounts_test

import (
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

func TestOverviewQueryUsesBoundedKeysetPagination(t *testing.T) {
	t.Parallel()

	query, err := accountapp.NewOverviewQuery("", 0)
	if err != nil {
		t.Fatalf("NewOverviewQuery() error = %v", err)
	}
	if query.AfterRef() != "" || query.Limit() != accountapp.DefaultOverviewLimit {
		t.Fatalf("OverviewQuery 字段错误: %#v", query)
	}
	if _, err := accountapp.NewOverviewQuery(
		"bad",
		1,
	); !errors.Is(err, accountapp.ErrInvalidOverview) {
		t.Fatalf("invalid cursor error = %v", err)
	}
}

func TestAccountOverviewKeepsOnlyPublicScalarMetadata(t *testing.T) {
	t.Parallel()

	auth, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: "sk-test-overview"})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	createdAt := time.Date(2026, time.July, 27, 0, 0, 0, 0, time.UTC)
	account, err := accountcore.NewAccount(testCatalog(t), accountcore.NewAccountInput{
		Identity:     auth,
		CLIAccountID: alias,
		CreatedAt:    createdAt,
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	overview, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{
		Account:          account,
		HasCredential:    true,
		AuthKind:         "api_key",
		HasProfile:       true,
		DisplayName:      "Owner",
		Email:            "owner@example.com",
		SubscriptionKind: "plus",
		SubscriptionRaw:  "plus",
		ProfileUpdatedAt: createdAt,
	})
	if err != nil {
		t.Fatalf("NewAccountOverview() error = %v", err)
	}
	if overview.Account() != account ||
		!overview.HasCredential() ||
		overview.AuthKind() != "api_key" ||
		!overview.HasProfile() ||
		overview.Email() != "owner@example.com" {
		t.Fatalf("AccountOverview 字段错误: %#v", overview)
	}
}

func TestAccountOverviewKeepsPersistedModelAndUsageEvidence(t *testing.T) {
	t.Parallel()

	auth, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: "sk-test-derived-overview"})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	capturedAt := time.Date(2026, time.August, 15, 2, 0, 0, 0, time.UTC)
	account, err := accountcore.NewAccount(testCatalog(t), accountcore.NewAccountInput{
		Identity:     auth,
		CLIAccountID: alias,
		CreatedAt:    capturedAt,
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	modelSummary, err := accountapp.NewAccountModelSummary(accountapp.AccountModelSummaryInput{
		Known:          true,
		StoredCount:    3,
		EffectiveCount: 2,
		UpdatedAt:      capturedAt,
	})
	if err != nil {
		t.Fatalf("NewAccountModelSummary() error = %v", err)
	}
	usageSnapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: account.Ref(),
		ProviderID: codex.ProviderID,
		Source:     "codex_wham_usage",
		CapturedAt: capturedAt,
		Entries: []usagecore.EntryInput{{
			Bucket:               "primary",
			Kind:                 usagecore.KindWindow,
			Scope:                usagecore.ScopeAccount,
			HasRemaining:         true,
			RemainingBasisPoints: 7_500,
			Availability:         usagecore.AvailabilityAvailable,
			WindowSeconds:        18_000,
		}},
	})
	if err != nil {
		t.Fatalf("NewSnapshot() error = %v", err)
	}

	overview, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{
		Account:          account,
		ModelSummary:     modelSummary,
		HasUsageSnapshot: true,
		UsageSnapshot:    usageSnapshot,
	})
	if err != nil {
		t.Fatalf("NewAccountOverview() error = %v", err)
	}
	storedUsage, found := overview.UsageSnapshot()
	if overview.ModelSummary() != modelSummary ||
		!found ||
		!storedUsage.IsValid() ||
		storedUsage.AccountRef() != account.Ref() {
		t.Fatalf("AccountOverview 派生快照错误: %#v", overview)
	}
}

func TestAccountModelSummaryRejectsImpossibleCounts(t *testing.T) {
	t.Parallel()

	modelSummary, err := accountapp.NewAccountModelSummary(accountapp.AccountModelSummaryInput{
		Known:          true,
		StoredCount:    1,
		EffectiveCount: 2,
		UpdatedAt:      time.Date(2026, time.August, 15, 2, 0, 0, 0, time.UTC),
	})
	if !errors.Is(err, accountapp.ErrInvalidOverview) || modelSummary.IsKnown() {
		t.Fatalf("invalid model summary = %#v error=%v", modelSummary, err)
	}
}

func TestAccountOverviewRejectsInconsistentOptionalRows(t *testing.T) {
	t.Parallel()

	_, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{
		HasCredential: false,
		AuthKind:      "oauth",
	})
	if !errors.Is(err, accountapp.ErrInvalidOverview) {
		t.Fatalf("NewAccountOverview() error = %v, want ErrInvalidOverview", err)
	}
}
