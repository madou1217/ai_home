package webuiroutingweightsapi

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountrouting"
	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
	"github.com/madou1217/ai_home/internal/runtime/sessionactivity"
)

type stubAuthorizer struct {
	allow bool
}

func (authorizer stubAuthorizer) Authorized(*http.Request) bool {
	return authorizer.allow
}

type stubPoolSource struct {
	pools map[string][]PoolAccount
	err   error
}

func (source stubPoolSource) ListProviderPool(_ context.Context, provider string) ([]PoolAccount, error) {
	if source.err != nil {
		return nil, source.err
	}
	return append([]PoolAccount(nil), source.pools[provider]...), nil
}

type stubCatalogSource struct {
	catalog accountapp.AccountModelCatalog
	err     error
}

func (source stubCatalogSource) ListAllAccountModels(context.Context) (accountapp.AccountModelCatalog, error) {
	if source.err != nil {
		return accountapp.AccountModelCatalog{}, source.err
	}
	return source.catalog, nil
}

type stubSettingsSource struct {
	settings modelcatalogsettings.Settings
	err      error
}

func (source stubSettingsSource) LoadModelSettings(context.Context) (modelcatalogsettings.Settings, error) {
	if source.err != nil {
		return modelcatalogsettings.Settings{}, source.err
	}
	return source.settings, nil
}

type stubRuntimeSource struct {
	views       []runtimeapp.AccountView
	eligibility map[string]runtimecore.Eligibility
	checkErr    error
}

func (source stubRuntimeSource) RuntimeSnapshot() []runtimeapp.AccountView {
	return source.views
}

func (source stubRuntimeSource) CheckEligibility(_ context.Context, route runtimecore.ModelRoute) (runtimecore.Eligibility, error) {
	if source.checkErr != nil {
		return runtimecore.Eligibility{}, source.checkErr
	}
	if elig, ok := source.eligibility[route.AccountRef().String()]; ok {
		return elig, nil
	}
	return runtimecore.AvailableEligibility(), nil
}

type stubStateSource struct {
	states []runtimecore.AccountState
	err    error
}

func (source stubStateSource) ListAccountStates(context.Context) ([]runtimecore.AccountState, error) {
	if source.err != nil {
		return nil, source.err
	}
	return source.states, nil
}

type stubUsageGate struct {
	decisions map[string]accountrouting.UsageDecision
	err       error
}

func (gate stubUsageGate) EvaluateScheduling(
	_ context.Context,
	_ string,
	accountRef accountcore.AccountRef,
	_ runtimecore.ModelID,
) (accountrouting.UsageDecision, error) {
	if gate.err != nil {
		return accountrouting.UsageDecision{}, gate.err
	}
	return gate.decisions[accountRef.String()], nil
}

type stubActivitySource struct {
	loads map[string]sessionactivity.SelectionLoad
}

func (source stubActivitySource) SelectionLoad(provider, accountRef, _ string) sessionactivity.SelectionLoad {
	return source.loads[provider+":"+accountRef]
}

func floatPtr(value float64) *float64 { return &value }
func int64Ptr(value int64) *int64     { return &value }

func mustAccountRef(t *testing.T, raw string) accountcore.AccountRef {
	t.Helper()
	ref, err := accountcore.ParseAccountRef(raw)
	if err != nil {
		t.Fatalf("ParseAccountRef(%q): %v", raw, err)
	}
	return ref
}

func mustAccountModel(t *testing.T, refRaw, modelRaw string, upstream bool, policy accountapp.ModelManualPolicy) accountapp.AccountModel {
	t.Helper()
	model, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        mustAccountRef(t, refRaw),
		ModelID:           modelRaw,
		UpstreamAvailable: upstream,
		ManualPolicy:      policy,
		UpdatedAt:         time.UnixMilli(1700000000000).UTC(),
	})
	if err != nil {
		t.Fatalf("NewAccountModel(%q, %q): %v", refRaw, modelRaw, err)
	}
	return model
}

func mustAccountState(t *testing.T, refRaw string, payload map[string]any, updatedAt time.Time) runtimecore.AccountState {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("Marshal state payload: %v", err)
	}
	state, err := runtimecore.NewAccountState(runtimecore.AccountStateInput{
		AccountRef: mustAccountRef(t, refRaw),
		Document:   encoded,
		UpdatedAt:  updatedAt,
	})
	if err != nil {
		t.Fatalf("NewAccountState(%q): %v", refRaw, err)
	}
	return state
}

func TestNewHandlerValidation(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("expected ErrInvalidDependencies, got %v", err)
	}
	if _, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allow: true},
		Pool:       stubPoolSource{},
		Strategy:   "invalid-strategy",
	}); !errors.Is(err, accountrouting.ErrUnknownSelectionStrategy) {
		t.Fatalf("expected ErrUnknownSelectionStrategy, got %v", err)
	}
}

func TestHandlerAuthMethodQueryAndMissingPool(t *testing.T) {
	pool := stubPoolSource{
		pools: map[string][]PoolAccount{
			"codex": {
				{
					AccountRef:   "acct_bce322d860aba73ac8db",
					Provider:     "codex",
					CLIAccountID: int64Ptr(1),
					Email:        "alpha@example.com",
					Enabled:      true,
					Configured:   true,
				},
			},
		},
	}

	unauthHandler, err := NewHandler(Dependencies{Authorizer: stubAuthorizer{allow: false}, Pool: pool})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, Path+"?provider=codex&model=gpt-5", nil)
	unauthHandler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
	if got := rec.Header().Get("WWW-Authenticate"); got != "Bearer" {
		t.Fatalf("expected Bearer challenge, got %q", got)
	}

	handler, err := NewHandler(Dependencies{Authorizer: stubAuthorizer{allow: true}, Pool: pool})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, Path+"?provider=codex&model=gpt-5", nil)
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
	if got := rec.Header().Get("Allow"); got != http.MethodGet {
		t.Fatalf("expected Allow GET, got %q", got)
	}

	for _, target := range []string{
		Path,
		Path + "?provider=codex",
		Path + "?model=gpt-5",
		Path + "?provider=%20&model=gpt-5",
		Path + "?provider=codex&model=%20",
	} {
		rec = httptest.NewRecorder()
		req = httptest.NewRequest(http.MethodGet, target, nil)
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s expected 400, got %d", target, rec.Code)
		}
		var errBody errorResponse
		if decodeErr := json.Unmarshal(rec.Body.Bytes(), &errBody); decodeErr != nil {
			t.Fatalf("decode 400: %v", decodeErr)
		}
		if errBody.OK || errBody.Error != "invalid_query" || errBody.Message != "provider 和 model 必填" {
			t.Fatalf("unexpected 400 body: %+v", errBody)
		}
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, Path+"?provider=%20ClAuDe%20&model=claude-sonnet-4-6", nil)
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
	var notFound errorResponse
	if decodeErr := json.Unmarshal(rec.Body.Bytes(), &notFound); decodeErr != nil {
		t.Fatalf("decode 404: %v", decodeErr)
	}
	if notFound.Error != "provider_not_found" || notFound.Message != "没有 claude 账号池" {
		t.Fatalf("unexpected 404 body: %+v", notFound)
	}
}

func TestHandlerCatalogNarrowingStates(t *testing.T) {
	now := time.UnixMilli(1_760_000_000_000).UTC()
	refA := "acct_0ef9f22293687e568a91"
	refB := "acct_b92d3e392877107c76c2"
	refC := "acct_67bc245d6e9bd5f5d9a6"

	basePool := map[string][]PoolAccount{
		"codex": {
			{AccountRef: refA, Provider: "codex", CLIAccountID: int64Ptr(1), Email: "a@example.com", Enabled: true, Configured: true, RemainingPct: floatPtr(80)},
			{AccountRef: refB, Provider: "codex", CLIAccountID: int64Ptr(2), Email: "b@example.com", Enabled: true, Configured: true, RemainingPct: floatPtr(40)},
		},
		"agy": {
			{
				AccountRef:   refA,
				Provider:     "agy",
				CLIAccountID: int64Ptr(1),
				Email:        "fresh@example.com",
				Enabled:      true,
				Configured:   true,
				RemainingPct: floatPtr(90),
				UsageSnapshot: map[string]any{
					"capturedAt": float64(now.Add(-2 * time.Minute).UnixMilli()),
					"models": []map[string]any{
						{"model": "Claude Sonnet 4.6 (Thinking)", "remainingPct": 0.0, "resetAtMs": float64(now.Add(15 * time.Minute).UnixMilli())},
					},
				},
			},
			{
				AccountRef:   refB,
				Provider:     "agy",
				CLIAccountID: int64Ptr(2),
				Email:        "stale@example.com",
				Enabled:      true,
				Configured:   true,
				RemainingPct: floatPtr(70),
				UsageSnapshot: map[string]any{
					"capturedAt": float64(now.Add(-20 * time.Minute).UnixMilli()),
					"models": []map[string]any{
						{"model": "claude-sonnet-4-6", "remainingPct": 0.0, "resetAtMs": float64(now.Add(15 * time.Minute).UnixMilli())},
					},
				},
			},
		},
	}

	t.Run("unchecked when no catalog sets exist", func(t *testing.T) {
		handler, err := NewHandler(Dependencies{
			Authorizer: stubAuthorizer{allow: true},
			Pool:       stubPoolSource{pools: basePool},
			Now:        func() time.Time { return now },
		})
		if err != nil {
			t.Fatalf("NewHandler: %v", err)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Path+"?provider=codex&model=gpt-5", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
		}
		var resp Response
		if decodeErr := json.Unmarshal(rec.Body.Bytes(), &resp); decodeErr != nil {
			t.Fatalf("decode response: %v", decodeErr)
		}
		if resp.Catalog != "unchecked" || resp.EligibleCount != 2 || resp.TotalCount != 2 {
			t.Fatalf("unexpected unchecked response: %+v", resp)
		}
	})

	t.Run("complete when all accounts support version-matched model", func(t *testing.T) {
		catalog := accountapp.AccountModelCatalog{
			Sets: []accountapp.AccountModelSet{
				{
					AccountRef: mustAccountRef(t, refA),
					ProviderID: "codex",
					Models:     []accountapp.AccountModel{mustAccountModel(t, refA, "gpt-5.2", true, accountapp.ModelPolicyInherit)},
				},
				{
					AccountRef: mustAccountRef(t, refB),
					ProviderID: "codex",
					Models:     []accountapp.AccountModel{mustAccountModel(t, refB, "gpt-5-2", true, accountapp.ModelPolicyInherit)},
				},
			},
		}
		handler, _ := NewHandler(Dependencies{
			Authorizer: stubAuthorizer{allow: true},
			Pool:       stubPoolSource{pools: basePool},
			Catalog:    stubCatalogSource{catalog: catalog},
			Now:        func() time.Time { return now },
		})
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Path+"?provider=codex&model=gpt-5.2", nil))
		var resp Response
		_ = json.Unmarshal(rec.Body.Bytes(), &resp)
		if resp.Catalog != "complete" || resp.EligibleCount != 2 {
			t.Fatalf("expected complete catalog with 2 eligible, got %+v", resp)
		}
	})

	t.Run("filtered by missing model, partial unprobed account, and settings disable", func(t *testing.T) {
		pool := map[string][]PoolAccount{
			"codex": append(append([]PoolAccount(nil), basePool["codex"]...), PoolAccount{
				AccountRef: refC, Provider: "codex", Email: "c@example.com", Enabled: true, Configured: true, RemainingPct: floatPtr(60),
			}),
		}
		catalog := accountapp.AccountModelCatalog{
			Sets: []accountapp.AccountModelSet{
				{
					AccountRef: mustAccountRef(t, refA),
					ProviderID: "codex",
					Models:     []accountapp.AccountModel{mustAccountModel(t, refA, "gpt-5.2", true, accountapp.ModelPolicyInherit)},
				},
				{
					AccountRef: mustAccountRef(t, refB),
					ProviderID: "codex",
					Models:     []accountapp.AccountModel{mustAccountModel(t, refB, "gpt-4o", true, accountapp.ModelPolicyInherit)},
				},
			},
		}
		// refA has gpt-5.2 but is disabled via model-catalog-settings; refB has complete catalog without gpt-5.2; refC unprobed.
		settings := modelcatalogsettings.Settings{
			Version: modelcatalogsettings.SettingsVersion,
			AccountModels: []modelcatalogsettings.AccountModel{
				{ID: "gpt-5.2", Provider: "codex", AccountRef: refA, Enabled: false},
			},
		}
		handler, _ := NewHandler(Dependencies{
			Authorizer: stubAuthorizer{allow: true},
			Pool:       stubPoolSource{pools: pool},
			Catalog:    stubCatalogSource{catalog: catalog},
			Settings:   stubSettingsSource{settings: settings},
			Now:        func() time.Time { return now },
		})
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Path+"?provider=codex&model=gpt-5.2", nil))
		var resp Response
		_ = json.Unmarshal(rec.Body.Bytes(), &resp)
		if resp.Catalog != "filtered" || resp.EligibleCount != 1 || resp.TotalCount != 3 {
			t.Fatalf("expected filtered with refC surviving as unprobed fallback, got %+v", resp)
		}
		byRef := map[string]Candidate{}
		for _, item := range resp.Candidates {
			byRef[item.AccountRef] = item
		}
		if byRef[refA].Reason != "model_not_in_catalog" || byRef[refB].Reason != "model_not_in_catalog" || !byRef[refC].Eligible {
			t.Fatalf("unexpected candidate eligibility: %+v", byRef)
		}
	})

	t.Run("incomplete probe exempts negative exclusion and native image models stay complete", func(t *testing.T) {
		catalog := accountapp.AccountModelCatalog{
			Sets: []accountapp.AccountModelSet{
				{
					AccountRef:    mustAccountRef(t, refA),
					ProviderID:    "codex",
					LastErrorCode: "partial_timeout",
					Models:        []accountapp.AccountModel{mustAccountModel(t, refA, "gpt-4o", true, accountapp.ModelPolicyInherit)},
				},
			},
		}
		handler, _ := NewHandler(Dependencies{
			Authorizer: stubAuthorizer{allow: true},
			Pool:       stubPoolSource{pools: basePool},
			Catalog:    stubCatalogSource{catalog: catalog},
			Now:        func() time.Time { return now },
		})
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Path+"?provider=codex&model=gpt-5.2", nil))
		var resp Response
		_ = json.Unmarshal(rec.Body.Bytes(), &resp)
		if resp.Catalog != "unchecked" || resp.EligibleCount != 2 {
			t.Fatalf("incomplete probe should stay unchecked, got %+v", resp)
		}

		// Native image model bypasses text-only catalog exclusion.
		completeTextCatalog := accountapp.AccountModelCatalog{
			Sets: []accountapp.AccountModelSet{
				{AccountRef: mustAccountRef(t, refA), ProviderID: "codex", Models: []accountapp.AccountModel{mustAccountModel(t, refA, "gpt-5", true, accountapp.ModelPolicyInherit)}},
				{AccountRef: mustAccountRef(t, refB), ProviderID: "codex", Models: []accountapp.AccountModel{mustAccountModel(t, refB, "gpt-5", true, accountapp.ModelPolicyInherit)}},
			},
		}
		imgHandler, _ := NewHandler(Dependencies{
			Authorizer: stubAuthorizer{allow: true},
			Pool:       stubPoolSource{pools: basePool},
			Catalog:    stubCatalogSource{catalog: completeTextCatalog},
			Now:        func() time.Time { return now },
		})
		rec = httptest.NewRecorder()
		imgHandler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Path+"?provider=codex&model=gpt-image-2", nil))
		var imgResp Response
		_ = json.Unmarshal(rec.Body.Bytes(), &imgResp)
		if imgResp.Catalog != "complete" || imgResp.EligibleCount != 2 {
			t.Fatalf("native image model should be complete, got %+v", imgResp)
		}
	})

	t.Run("agy model window gate excludes fresh exhausted window and ignores stale", func(t *testing.T) {
		catalog := accountapp.AccountModelCatalog{
			Sets: []accountapp.AccountModelSet{
				{AccountRef: mustAccountRef(t, refA), ProviderID: "agy", Models: []accountapp.AccountModel{mustAccountModel(t, refA, "claude-sonnet-4-6", true, accountapp.ModelPolicyInherit)}},
				{AccountRef: mustAccountRef(t, refB), ProviderID: "agy", Models: []accountapp.AccountModel{mustAccountModel(t, refB, "claude-sonnet-4-6", true, accountapp.ModelPolicyInherit)}},
			},
		}
		handler, _ := NewHandler(Dependencies{
			Authorizer: stubAuthorizer{allow: true},
			Pool:       stubPoolSource{pools: basePool},
			Catalog:    stubCatalogSource{catalog: catalog},
			Now:        func() time.Time { return now },
		})
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Path+"?provider=agy&model=claude-sonnet-4-6", nil))
		var resp Response
		_ = json.Unmarshal(rec.Body.Bytes(), &resp)
		if resp.Catalog != "filtered" || resp.EligibleCount != 1 {
			t.Fatalf("expected agy filtered with 1 eligible, got %+v", resp)
		}
		if resp.Candidates[0].AccountRef != refB || !resp.Candidates[0].Eligible || resp.Candidates[0].Probability != 1 {
			t.Fatalf("expected refB eligible prob=1, got %+v", resp.Candidates[0])
		}
		if resp.Candidates[1].AccountRef != refA || resp.Candidates[1].Reason != "model_not_in_catalog" {
			t.Fatalf("expected refA excluded by window gate, got %+v", resp.Candidates[1])
		}
	})
}

func TestHandlerEligibilityExclusionsAndPriority(t *testing.T) {
	now := time.UnixMilli(1_760_000_000_000).UTC()
	futureMS := float64(now.Add(5 * time.Minute).UnixMilli())
	pastMS := float64(now.Add(-1 * time.Minute).UnixMilli())

	accounts := []PoolAccount{
		{AccountRef: "acct_82859e480ef8a76efd81", Provider: "codex", Email: "01@example.com", Enabled: false, Configured: true, RemainingPct: floatPtr(80)},
		{AccountRef: "acct_c25954347f017885c079", Provider: "codex", Email: "02@example.com", Enabled: true, Configured: true, RemainingPct: floatPtr(80)},
		{AccountRef: "acct_ed52a498cb8b8e718027", Provider: "codex", Email: "03@example.com", Enabled: true, Configured: true, RemainingPct: floatPtr(80)},
		{AccountRef: "acct_0ffa44d1280ae65fbb22", Provider: "codex", Email: "04@example.com", Enabled: true, Configured: true, RemainingPct: floatPtr(80)},
		{AccountRef: "acct_226e3647ac5296a84c7c", Provider: "codex", Email: "05@example.com", Enabled: true, Configured: true, RemainingPct: floatPtr(80)},
		{AccountRef: "acct_6099c5adafcb389d34bd", Provider: "codex", Email: "06@example.com", Enabled: true, Configured: true, RemainingPct: floatPtr(80)},
		{AccountRef: "acct_ff36264a53d5f29041c0", Provider: "codex", Email: "07@example.com", Enabled: true, Configured: true, RemainingPct: floatPtr(80)},
		{AccountRef: "acct_1c46185abfca21459bca", Provider: "codex", Email: "08@example.com", Enabled: true, Configured: true, RemainingPct: floatPtr(0)},
		{AccountRef: "acct_4696811a5f09f61a6aad", Provider: "codex", Email: "09@example.com", Enabled: true, Configured: true, APIKeyMode: true, RemainingPct: nil},
		{AccountRef: "acct_d6cb281d831fdf93d77e", Provider: "codex", Email: "10@example.com", Enabled: true, Configured: true, RemainingPct: floatPtr(50), SchedulableStatus: "blocked_by_policy"},
		{AccountRef: "acct_cfe4509e3987441c4465", Provider: "codex", Email: "11@example.com", Enabled: true, Configured: true, RemainingPct: floatPtr(4)},
		{AccountRef: "acct_4cec990466e25b1d17fa", Provider: "codex", Email: "12@example.com", Enabled: true, Configured: true, RemainingPct: floatPtr(70)},
	}

	states := []runtimecore.AccountState{
		mustAccountState(t, "acct_c25954347f017885c079", map[string]any{"authInvalidUntil": futureMS}, now),
		mustAccountState(t, "acct_0ffa44d1280ae65fbb22", map[string]any{
			"routingBlock": map[string]any{"kind": "billing_blocked", "reason": "billing", "observedAt": pastMS, "until": pastMS},
		}, now),
		mustAccountState(t, "acct_226e3647ac5296a84c7c", map[string]any{"cooldownUntil": futureMS, "lastFailureKind": "rate_limited"}, now),
		mustAccountState(t, "acct_6099c5adafcb389d34bd", map[string]any{
			"modelCooldowns": map[string]any{"gpt-5.2": futureMS},
		}, now),
		mustAccountState(t, "acct_ff36264a53d5f29041c0", map[string]any{
			"modelCooldowns": map[string]any{"gpt-5.2": pastMS},
			"modelFailureStreaks": map[string]any{
				"gpt-5.2": map[string]any{"kind": "model_capacity_unavailable", "count": 1},
			},
		}, now),
	}

	runtimeSource := stubRuntimeSource{
		views: []runtimeapp.AccountView{
			{
				AccountRef: mustAccountRef(t, "acct_ed52a498cb8b8e718027"),
				Blocks:     []runtimecore.RecoveryTrigger{runtimecore.RecoveryUsageSnapshot},
			},
		},
		eligibility: map[string]runtimecore.Eligibility{
			"acct_4cec990466e25b1d17fa": runtimecore.PolicyBlockedEligibility(),
		},
	}

	usageGate := stubUsageGate{
		decisions: map[string]accountrouting.UsageDecision{
			"acct_cfe4509e3987441c4465": {Blocked: true, Status: "blocked_by_policy", Reason: "usage_below_server_threshold"},
		},
	}

	activity := stubActivitySource{
		loads: map[string]sessionactivity.SelectionLoad{
			"codex:acct_0ffa44d1280ae65fbb22": {InFlight: 1, WindowMS: 10_000},
			"codex:acct_ff36264a53d5f29041c0": {ModelInFlight: 1, WindowMS: 10_000},
		},
	}

	handler, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allow: true},
		Pool:       stubPoolSource{pools: map[string][]PoolAccount{"codex": accounts}},
		Runtime:    runtimeSource,
		States:     stubStateSource{states: states},
		UsageGate:  usageGate,
		Activity:   activity,
		Now:        func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Path+"?provider=codex&model=gpt-5.2", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp Response
	if decodeErr := json.Unmarshal(rec.Body.Bytes(), &resp); decodeErr != nil {
		t.Fatalf("decode response: %v", decodeErr)
	}

	reasons := make(map[string]string, len(resp.Candidates))
	eligible := make(map[string]bool, len(resp.Candidates))
	for _, candidate := range resp.Candidates {
		reasons[candidate.AccountRef] = candidate.Reason
		eligible[candidate.AccountRef] = candidate.Eligible
	}

	expectedReasons := map[string]string{
		"acct_82859e480ef8a76efd81": "account_state_unavailable",
		"acct_c25954347f017885c079": "runtime_auth_invalid",
		"acct_ed52a498cb8b8e718027": "runtime_rate_limited",
		"acct_0ffa44d1280ae65fbb22": "routing_block_probe_in_flight",
		"acct_226e3647ac5296a84c7c": "runtime_rate_limited",
		"acct_6099c5adafcb389d34bd": "model_cooldown",
		"acct_ff36264a53d5f29041c0": "model_capacity_recovery_in_flight",
		"acct_1c46185abfca21459bca": "quota_exhausted",
		"acct_4696811a5f09f61a6aad": "",
		"acct_d6cb281d831fdf93d77e": "runtime_blocked",
		"acct_cfe4509e3987441c4465": "usage_gate",
		"acct_4cec990466e25b1d17fa": "runtime_blocked",
	}
	for ref, wantReason := range expectedReasons {
		if reasons[ref] != wantReason {
			t.Errorf("%s reason = %q, want %q", ref, reasons[ref], wantReason)
		}
		if eligible[ref] != (wantReason == "") {
			t.Errorf("%s eligible = %v, want %v", ref, eligible[ref], wantReason == "")
		}
	}
	if resp.EligibleCount != 1 || resp.Candidates[0].AccountRef != "acct_4696811a5f09f61a6aad" {
		t.Fatalf("expected only API key account eligible and sorted first, got %+v", resp.Candidates[0])
	}
}

func TestHandlerWeightsProbabilitiesStrategyAndSorting(t *testing.T) {
	pool := []PoolAccount{
		// remainingPct = 80, inFlight = 1, rate = 10, windowMs = 10000 -> pressure = 1 + 10/10 = 2 -> weight = 80 / 9
		{AccountRef: "acct_322ad38cb7744614c0fa", Provider: "codex", CLIAccountID: int64Ptr(3), Email: "Beta@example.com", Enabled: true, Configured: true, RemainingPct: floatPtr(80)},
		// remainingPct = nil (50), inFlight = 0, rate = 0 -> weight = 50
		{AccountRef: "acct_6a16dc700331393f6934", Provider: "codex", CLIAccountID: nil, Email: "alpha@example.com", Enabled: true, Configured: true, RemainingPct: nil},
		// remainingPct = 100, inFlight = 0, rate = 0 -> weight = 100
		{AccountRef: "acct_b8f3905f8d3a5dd4692e", Provider: "codex", CLIAccountID: int64Ptr(1), Email: "gamma@example.com", Enabled: true, Configured: true, RemainingPct: floatPtr(100)},
		// remainingPct = 0 -> ineligible quota_exhausted (weight=0, prob=0)
		{AccountRef: "acct_8c2d98d9ae5b9b5aa0f7", Provider: "codex", CLIAccountID: int64Ptr(2), Email: "a-disabled@example.com", Enabled: true, Configured: true, RemainingPct: floatPtr(0)},
		// same probability as unknown02? Add tiebreak check on email case-insensitive sorting:
		{AccountRef: "acct_66a0025896c417cb527f", Provider: "codex", CLIAccountID: int64Ptr(4), Email: "Zeta@example.com", Enabled: true, Configured: true, RemainingPct: nil},
	}

	activity := stubActivitySource{
		loads: map[string]sessionactivity.SelectionLoad{
			"codex:acct_322ad38cb7744614c0fa": {InFlight: 1, ModelInFlight: 1, Rate: 10, WindowMS: 10_000},
			"codex:acct_6a16dc700331393f6934": {InFlight: 0, ModelInFlight: 0, Rate: 0, WindowMS: 10_000},
			"codex:acct_b8f3905f8d3a5dd4692e": {InFlight: 0, ModelInFlight: 0, Rate: 0, WindowMS: 10_000},
			"codex:acct_66a0025896c417cb527f": {InFlight: 0, ModelInFlight: 0, Rate: 0, WindowMS: 10_000},
		},
	}

	handler, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allow: true},
		Pool:       stubPoolSource{pools: map[string][]PoolAccount{"codex": pool}},
		Activity:   activity,
		Strategy:   "round-robin",
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Path+"?provider=codex&model=gpt-5", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp Response
	if decodeErr := json.Unmarshal(rec.Body.Bytes(), &resp); decodeErr != nil {
		t.Fatalf("decode response: %v", decodeErr)
	}

	if resp.Strategy != "round-robin" || resp.EligibleCount != 4 || resp.TotalCount != 5 {
		t.Fatalf("unexpected header fields: %+v", resp)
	}

	wantBusyWeight := 80.0 / 9.0
	wantTotal := 100.0 + 50.0 + 50.0 + wantBusyWeight
	if math.Abs(resp.TotalWeight-wantTotal) > 1e-9 {
		t.Fatalf("TotalWeight = %v, want %v", resp.TotalWeight, wantTotal)
	}

	// Expected order:
	// 1. acct_b8f3905f8d3a5dd4692e (weight 100)
	// 2. acct_6a16dc700331393f6934 (weight 50, email alpha@)
	// 3. acct_66a0025896c417cb527f (weight 50, email Zeta@)
	// 4. acct_322ad38cb7744614c0fa (weight 80/9)
	// 5. acct_8c2d98d9ae5b9b5aa0f7 (ineligible)
	wantOrder := []string{
		"acct_b8f3905f8d3a5dd4692e",
		"acct_6a16dc700331393f6934",
		"acct_66a0025896c417cb527f",
		"acct_322ad38cb7744614c0fa",
		"acct_8c2d98d9ae5b9b5aa0f7",
	}
	for index, wantRef := range wantOrder {
		if resp.Candidates[index].AccountRef != wantRef {
			t.Fatalf("candidate[%d] = %s, want %s (full: %+v)", index, resp.Candidates[index].AccountRef, wantRef, resp.Candidates)
		}
	}

	if resp.Candidates[1].CLIAccountID != nil || resp.Candidates[1].RemainingPct != nil {
		t.Fatalf("expected nil cliAccountId & remainingPct for unknown02, got %+v", resp.Candidates[1])
	}
	if resp.Candidates[3].InFlight != 1 || resp.Candidates[3].ModelInFlight != 1 || resp.Candidates[3].Rate != 10 || resp.Candidates[3].WindowMS != 10_000 {
		t.Fatalf("expected activity metrics preserved for busy00001, got %+v", resp.Candidates[3])
	}
	if math.Abs(resp.Candidates[3].Probability-(wantBusyWeight/wantTotal)) > 1e-9 {
		t.Fatalf("busy probability = %v, want %v", resp.Candidates[3].Probability, wantBusyWeight/wantTotal)
	}
	if resp.Candidates[4].Weight != 0 || resp.Candidates[4].Probability != 0 {
		t.Fatalf("ineligible candidate must have 0 weight/prob, got %+v", resp.Candidates[4])
	}
}

func TestHandlerUsageGateErrorFailClosedAndRuntimeCooldown(t *testing.T) {
	now := time.UnixMilli(1_760_000_000_000).UTC()
	ref := "acct_d8dd8244fab4548e500f"
	modelID, _ := runtimecore.NewModelID("gpt-5")

	handler, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allow: true},
		Pool: stubPoolSource{
			pools: map[string][]PoolAccount{
				"codex": {
					{AccountRef: ref, Provider: "codex", Email: "cool@example.com", Enabled: true, Configured: true, RemainingPct: floatPtr(50)},
				},
			},
		},
		Runtime: stubRuntimeSource{
			views: []runtimeapp.AccountView{
				{
					AccountRef: mustAccountRef(t, ref),
					Models: []runtimeapp.ModelView{
						{Model: modelID, CooldownUntil: now.Add(30 * time.Second)},
					},
				},
			},
		},
		Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Path+"?provider=codex&model=gpt-5", nil))
	var resp Response
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.Candidates[0].Eligible || resp.Candidates[0].Reason != "model_cooldown" {
		t.Fatalf("expected Go RuntimeSnapshot model_cooldown, got %+v", resp.Candidates[0])
	}

	// Verify UsageGate error fails closed into usage_gate instead of leaking eligible.
	failHandler, _ := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allow: true},
		Pool: stubPoolSource{
			pools: map[string][]PoolAccount{
				"codex": {
					{AccountRef: ref, Provider: "codex", Email: "cool@example.com", Enabled: true, Configured: true, RemainingPct: floatPtr(50)},
				},
			},
		},
		UsageGate: stubUsageGate{err: errors.New("sqlite busy")},
		Now:       func() time.Time { return now },
	})
	rec = httptest.NewRecorder()
	failHandler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Path+"?provider=codex&model=gpt-5", nil))
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.Candidates[0].Eligible || resp.Candidates[0].Reason != "usage_gate" {
		t.Fatalf("expected fail-closed usage_gate on error, got %+v", resp.Candidates[0])
	}
}
