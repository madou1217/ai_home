package webuiaccountquotastatsapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/core/usageledger"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountquotastatsapi"
)

type allowAuth struct{ allow bool }

func (a allowAuth) Authorized(*http.Request) bool { return a.allow }

func TestQuotaStatsHandlerWindowAndDayBucketsWithRealSQLite(t *testing.T) {
	ctx := context.Background()
	aiHomeDir := t.TempDir()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{AIHomeDir: aiHomeDir, Catalog: catalog})
	if err != nil {
		t.Fatalf("sqliteaccount.Open() error = %v", err)
	}
	defer func() { _ = store.Close() }()

	now := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	auth, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: "sk-test-quota-stats-key"})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	account, err := accountcore.NewAccount(catalog, accountcore.NewAccountInput{
		Identity:     auth,
		CLIAccountID: accountcore.CLIAccountID(1),
		CreatedAt:    now.Add(-48 * time.Hour),
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	registration, err := accountapp.NewRegistration(account, auth, now.Add(-48*time.Hour))
	if err != nil {
		t.Fatalf("NewRegistration() error = %v", err)
	}
	if err := store.Register(ctx, registration); err != nil {
		t.Fatalf("store.Register() error = %v", err)
	}
	defaultRel, err := accountcore.NewProviderDefault(codex.ProviderID, account.Ref(), now)
	if err != nil {
		t.Fatalf("NewProviderDefault() error = %v", err)
	}
	if _, err := store.SetProviderDefault(ctx, defaultRel); err != nil {
		t.Fatalf("SetProviderDefault() error = %v", err)
	}

	usageVal, err := inference.NewUsage(inference.UsageInput{InputTokens: 1200, OutputTokens: 800})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	rec, err := usageledger.NewRecord(usageledger.RecordInput{
		AccountRef: account.Ref(),
		Provider:   codex.ProviderID,
		Model:      "gpt-5",
		SessionID:  "sess-1",
		OccurredAt: now.Add(-6 * time.Hour),
		Usage:      usageVal,
	})
	if err != nil {
		t.Fatalf("NewRecord() error = %v", err)
	}
	if err := store.AppendUsageRecord(ctx, rec); err != nil {
		t.Fatalf("AppendUsageRecord() error = %v", err)
	}

	quotaService, err := usageapp.NewQuotaStatsService(usageapp.QuotaStatsDependencies{
		Samples:   store,
		Usage:     store,
		Ledger:    store,
		Events:    store,
		Snapshots: store,
		Clock:     func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewQuotaStatsService() error = %v", err)
	}

	handler, err := webuiaccountquotastatsapi.NewHandler(webuiaccountquotastatsapi.Dependencies{
		Authorizer:   allowAuth{allow: true},
		AIHomeDir:    aiHomeDir,
		QuotaStats:   quotaService,
		UsageBuckets: store,
		Now:          func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}

	t.Run("no window dimension falls back to day buckets and resolves CLI numeric ID", func(t *testing.T) {
		httpRec := httptest.NewRecorder()
		req := httptest.NewRequest(
			http.MethodGet,
			"/v0/webui/accounts/codex/1/quota-stats?rangeDays=7",
			nil,
		)
		handler.ServeHTTP(httpRec, req)
		if httpRec.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", httpRec.Code, httpRec.Body.String())
		}
		var payload struct {
			OK           bool    `json:"ok"`
			Provider     string  `json:"provider"`
			AccountRef   string  `json:"accountRef"`
			Granularity  string  `json:"granularity"`
			EmptyReason  *string `json:"emptyReason"`
			UsageBuckets []struct {
				Tokens       int64 `json:"tokens"`
				RequestCount int64 `json:"requestCount"`
			} `json:"usageBuckets"`
			UsageSummary *struct {
				BucketCount  int   `json:"bucketCount"`
				TotalTokens  int64 `json:"totalTokens"`
				RequestCount int64 `json:"requestCount"`
			} `json:"usageSummary"`
			Dimensions []any `json:"dimensions"`
			Windows    []any `json:"windows"`
		}
		if err := json.Unmarshal(httpRec.Body.Bytes(), &payload); err != nil {
			t.Fatalf("unmarshal error = %v", err)
		}
		if !payload.OK || payload.Provider != "codex" || payload.AccountRef != account.Ref().String() {
			t.Fatalf("unexpected identity = %#v", payload)
		}
		if payload.Granularity != "day" {
			t.Fatalf("granularity = %q, want day", payload.Granularity)
		}
		if payload.EmptyReason != nil {
			t.Fatalf("emptyReason = %v, want nil when usage exists", *payload.EmptyReason)
		}
		if payload.UsageSummary == nil || payload.UsageSummary.TotalTokens != 2000 || payload.UsageSummary.RequestCount != 1 {
			t.Fatalf("usageSummary = %#v", payload.UsageSummary)
		}
		if payload.Dimensions == nil || payload.Windows == nil {
			t.Fatalf("dimensions/windows must be non-nil slices")
		}
	})

	t.Run("window snapshot dimension defaults to window granularity and resolves default ref", func(t *testing.T) {
		entryInput := usagecore.EntryInput{
			LimitID:              "codex",
			LimitName:            "Codex",
			Bucket:               "5h",
			Kind:                 usagecore.KindWindow,
			Scope:                usagecore.ScopeAccount,
			HasRemaining:         true,
			RemainingBasisPoints: 6400,
			WindowSeconds:        5 * 60 * 60,
			ResetAt:              now.Add(3 * time.Hour),
			Availability:         usagecore.AvailabilityAvailable,
		}
		snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
			AccountRef: account.Ref(),
			ProviderID: codex.ProviderID,
			Source:     "codex_quota",
			CapturedAt: now.Add(-5 * time.Minute),
			Entries:    []usagecore.EntryInput{entryInput},
		})
		if err != nil {
			t.Fatalf("NewSnapshot() error = %v", err)
		}
		if err := store.ReplaceUsageSnapshot(ctx, snapshot); err != nil {
			t.Fatalf("ReplaceUsageSnapshot() error = %v", err)
		}

		httpRec := httptest.NewRecorder()
		req := httptest.NewRequest(
			http.MethodGet,
			"/v1/management/webui/accounts/codex/default/quota-stats?rangeDays=30",
			nil,
		)
		handler.ServeHTTP(httpRec, req)
		if httpRec.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", httpRec.Code, httpRec.Body.String())
		}
		var payload struct {
			OK            bool   `json:"ok"`
			AccountRef    string `json:"accountRef"`
			Granularity   string `json:"granularity"`
			WindowMinutes int64  `json:"windowMinutes"`
			Current       *struct {
				RemainingPct *float64 `json:"remainingPct"`
			} `json:"current"`
			UsageBuckets []any `json:"usageBuckets"`
			UsageSummary any   `json:"usageSummary"`
		}
		if err := json.Unmarshal(httpRec.Body.Bytes(), &payload); err != nil {
			t.Fatalf("unmarshal error = %v", err)
		}
		if payload.Granularity != "window" || payload.WindowMinutes != 300 {
			t.Fatalf("granularity=%q windowMinutes=%d", payload.Granularity, payload.WindowMinutes)
		}
		if payload.Current == nil || payload.Current.RemainingPct == nil || *payload.Current.RemainingPct != 64.0 {
			t.Fatalf("current = %#v", payload.Current)
		}
		if payload.UsageBuckets == nil || len(payload.UsageBuckets) != 0 || payload.UsageSummary != nil {
			t.Fatalf("window mode usageBuckets/usageSummary = %#v / %#v", payload.UsageBuckets, payload.UsageSummary)
		}
	})

	t.Run("invalid granularity or unknown account returns deterministic errors", func(t *testing.T) {
		badGranRec := httptest.NewRecorder()
		badGranReq := httptest.NewRequest(
			http.MethodGet,
			"/v0/webui/accounts/codex/"+account.Ref().String()+"/quota-stats?granularity=month",
			nil,
		)
		handler.ServeHTTP(badGranRec, badGranReq)
		if badGranRec.Code != http.StatusBadRequest {
			t.Fatalf("bad granularity status = %d", badGranRec.Code)
		}

		notFoundRec := httptest.NewRecorder()
		notFoundReq := httptest.NewRequest(
			http.MethodGet,
			"/v0/webui/accounts/claude/"+account.Ref().String()+"/quota-stats",
			nil,
		)
		handler.ServeHTTP(notFoundRec, notFoundReq)
		if notFoundRec.Code != http.StatusNotFound {
			t.Fatalf("wrong provider status = %d, body = %s", notFoundRec.Code, notFoundRec.Body.String())
		}
	})
}
