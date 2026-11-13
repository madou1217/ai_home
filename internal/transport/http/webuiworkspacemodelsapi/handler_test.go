package webuiworkspacemodelsapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/modelsdev"
)

type staticAuthorizer struct{ allow bool }

func (a staticAuthorizer) Authorized(*http.Request) bool { return a.allow }

type fakeStore struct {
	catalog   accountapp.AccountModelCatalog
	overviews []accountapp.AccountOverview
}

func (f *fakeStore) ListAllAccountModels(context.Context) (accountapp.AccountModelCatalog, error) {
	return f.catalog, nil
}

func (f *fakeStore) ListAccountOverviews(_ context.Context, query accountapp.OverviewQuery) ([]accountapp.AccountOverview, error) {
	if query.AfterRef() != "" {
		return nil, nil
	}
	return f.overviews, nil
}

type fakeRefresher struct {
	calledRefs []accountcore.AccountRef
	onRefresh  func(ref accountcore.AccountRef)
}

func (f *fakeRefresher) RefreshAccountModels(_ context.Context, ref accountcore.AccountRef) ([]accountapp.AccountModel, error) {
	f.calledRefs = append(f.calledRefs, ref)
	if f.onRefresh != nil {
		f.onRefresh(ref)
	}
	return nil, nil
}

func mustAccountOverview(t *testing.T, refStr, provider string) accountapp.AccountOverview {
	t.Helper()
	ref, err := accountcore.ParseAccountRef(refStr)
	if err != nil {
		t.Fatalf("ParseAccountRef: %v", err)
	}
	cliID, _ := accountcore.NewCLIAccountID(1)
	now := time.Unix(1700000000, 0).UTC()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog: %v", err)
	}
	acc, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref:          ref,
		ProviderID:   provider,
		CLIAccountID: cliID,
		Enabled:      true,
		CreatedAt:    now,
		UpdatedAt:    now,
	})
	if err != nil {
		t.Fatalf("RestoreAccount: %v", err)
	}
	overview, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{Account: acc})
	if err != nil {
		t.Fatalf("NewAccountOverview: %v", err)
	}
	return overview
}

func TestWorkspaceModelsFullContractAndColdProbe(t *testing.T) {
	ctx := context.Background()
	aiHome := t.TempDir()
	dbPath, _ := appstate.DatabasePath(aiHome)
	_ = os.MkdirAll(aiHome, 0o755)

	refA := "acct_0123456789abcdef0123"
	refB := "acct_0123456789abcdef0456"
	parsedA, _ := accountcore.ParseAccountRef(refA)
	parsedB, _ := accountcore.ParseAccountRef(refB)

	mA1, _ := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        parsedA,
		ModelID:           "gpt-5",
		UpstreamAvailable: true,
		ManualPolicy:      accountapp.ModelPolicyInherit,
		UpdatedAt:         time.Unix(1700000000, 0).UTC(),
	})
	mA2, _ := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        parsedA,
		ModelID:           "gpt-5-mini",
		UpstreamAvailable: true,
		ManualPolicy:      accountapp.ModelPolicyInherit,
		UpdatedAt:         time.Unix(1700000000, 0).UTC(),
	})

	store := &fakeStore{
		overviews: []accountapp.AccountOverview{
			mustAccountOverview(t, refA, "codex"),
			mustAccountOverview(t, refB, "claude"),
		},
		catalog: accountapp.AccountModelCatalog{
			Generation:  2,
			UpdatedAtMS: 1700000005000,
			Sets: []accountapp.AccountModelSet{
				{
					AccountRef:     parsedA,
					ProviderID:     "codex",
					Models:         []accountapp.AccountModel{mA1, mA2},
					LastAttemptAt:  time.Unix(1700000005, 0).UTC(),
					LastSource:     "remote",
					LastModelCount: 2,
				},
			},
		},
	}

	// Settings disables gpt-5-mini, adds manual custom-model, and sets gpt-5 as default.
	settingsJSON := `{
		"version": 5,
		"updatedAt": 1700000001000,
		"accountModels": [
			{"id":"gpt-5","provider":"codex","accountRef":"` + refA + `","enabled":true,"defaultModel":true},
			{"id":"gpt-5-mini","provider":"codex","accountRef":"` + refA + `","enabled":false},
			{"id":"custom-codex","provider":"codex","accountRef":"` + refA + `","enabled":true,"manual":true}
		]
	}`
	if err := appstate.WriteKV(ctx, dbPath, "model-catalog-settings", settingsJSON, 100); err != nil {
		t.Fatal(err)
	}
	snapshotJSON := `{"version":2,"updatedAt":1700000002000,"labels":{"codex":{"gpt-5":"GPT-5"}}}`
	if err := appstate.WriteKV(ctx, dbPath, "cache:webui-models-snapshot.json", snapshotJSON, 100); err != nil {
		t.Fatal(err)
	}

	modalIndex, err := modelsdev.New()
	if err != nil {
		t.Fatalf("modelsdev.New: %v", err)
	}

	refresher := &fakeRefresher{
		onRefresh: func(ref accountcore.AccountRef) {
			if ref == parsedB {
				mB, _ := accountapp.NewAccountModel(accountapp.AccountModelInput{
					AccountRef:        parsedB,
					ModelID:           "claude-sonnet-4-5",
					UpstreamAvailable: true,
					ManualPolicy:      accountapp.ModelPolicyInherit,
					UpdatedAt:         time.Unix(1700000010, 0).UTC(),
				})
				store.catalog.Sets = append(store.catalog.Sets, accountapp.AccountModelSet{
					AccountRef:     parsedB,
					ProviderID:     "claude",
					Models:         []accountapp.AccountModel{mB},
					LastAttemptAt:  time.Unix(1700000010, 0).UTC(),
					LastSource:     "remote",
					LastModelCount: 1,
				})
			}
		},
	}

	handler, err := NewHandler(Dependencies{
		Authorizer:     staticAuthorizer{allow: true},
		AiHomeDir:      aiHome,
		Store:          store,
		ModelRefresher: refresher,
		MetadataIndex:  modalIndex,
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}

	// 1. Unscoped read returns full WebUiModelsResponse shape.
	req := httptest.NewRequest(http.MethodGet, Path, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		OK                     bool                         `json:"ok"`
		Cached                 bool                         `json:"cached"`
		Models                 map[string][]string          `json:"models"`
		ByAccountRef           map[string][]string          `json:"byAccountRef"`
		SelectableByAccountRef map[string][]string          `json:"selectableByAccountRef"`
		DefaultByAccountRef    map[string]string            `json:"defaultByAccountRef"`
		Labels                 map[string]map[string]string `json:"labels"`
		Metadata               map[string]map[string]any    `json:"metadata"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !resp.OK || !resp.Cached {
		t.Fatalf("expected ok & cached=true: %s", rec.Body.String())
	}
	if !slices.Equal(resp.SelectableByAccountRef[refA], []string{"custom-codex", "gpt-5"}) {
		t.Fatalf("unexpected selectableByAccountRef: %+v", resp.SelectableByAccountRef)
	}
	if resp.DefaultByAccountRef[refA] != "gpt-5" {
		t.Fatalf("unexpected defaultByAccountRef: %+v", resp.DefaultByAccountRef)
	}
	if resp.Labels["codex"]["gpt-5"] != "GPT-5" || resp.Metadata["gpt-5"] == nil {
		t.Fatalf("missing label or metadata: labels=%+v meta=%+v", resp.Labels, resp.Metadata)
	}
	if !slices.Contains(resp.Models["codex"], "custom-codex") {
		t.Fatalf("manual model missing from models[codex]: %+v", resp.Models)
	}

	// 2. Scoped unknown accountRef -> 404.
	req404 := httptest.NewRequest(http.MethodGet, Path+"?accountRef=acct_missing", nil)
	rec404 := httptest.NewRecorder()
	handler.ServeHTTP(rec404, req404)
	if rec404.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown accountRef, got %d", rec404.Code)
	}

	// 3. Cold scoped accountRef triggers bounded cold probe once.
	_ = filepath.Clean(aiHome)
	reqCold := httptest.NewRequest(http.MethodGet, Path+"?accountRef="+refB, nil)
	recCold := httptest.NewRecorder()
	handler.ServeHTTP(recCold, reqCold)
	if recCold.Code != http.StatusOK || len(refresher.calledRefs) != 1 || refresher.calledRefs[0] != parsedB {
		t.Fatalf("expected cold probe for refB: code=%d called=%+v body=%s", recCold.Code, refresher.calledRefs, recCold.Body.String())
	}
	var coldResp struct {
		Cached                 bool                `json:"cached"`
		SelectableByAccountRef map[string][]string `json:"selectableByAccountRef"`
	}
	_ = json.Unmarshal(recCold.Body.Bytes(), &coldResp)
	if coldResp.Cached || !slices.Equal(coldResp.SelectableByAccountRef[refB], []string{"claude-sonnet-4-5"}) {
		t.Fatalf("unexpected cold response: %+v", coldResp)
	}
}
