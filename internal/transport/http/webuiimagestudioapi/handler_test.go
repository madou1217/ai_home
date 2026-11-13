package webuiimagestudioapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/images"
	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/modelsdev"
	"github.com/madou1217/ai_home/internal/runtime/imagestudio"
)

var tinyPNG = func() []byte {
	raw, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=")
	return raw
}()

type stubAuth struct{}

func (stubAuth) Authorized(r *http.Request) bool {
	return r.Header.Get("Authorization") == "Bearer studio-key"
}

type stubOverviews struct{ items []accountapp.AccountOverview }

func (s stubOverviews) ListAccountOverviews(_ context.Context) ([]accountapp.AccountOverview, error) {
	return s.items, nil
}

type stubModels struct{ cat accountapp.AccountModelCatalog }

func (s stubModels) ListAllAccountModels(_ context.Context) (accountapp.AccountModelCatalog, error) {
	return s.cat, nil
}

type stubElig struct{}

func (stubElig) CheckEligibility(_ context.Context, _ runtimecore.ModelRoute) (runtimecore.Eligibility, error) {
	return runtimecore.AvailableEligibility(), nil
}

type stubAccSrc struct{ acct images.Account }

func (s stubAccSrc) Candidates(_ context.Context, _ string, _ string, exclude []string) ([]images.Account, error) {
	for _, ex := range exclude {
		if ex == s.acct.AccountRef {
			return nil, errors.New("exhausted")
		}
	}
	return []images.Account{s.acct}, nil
}

func newTestStudioHandler(t *testing.T) (*Handler, *httptest.Server) {
	t.Helper()
	b64Tiny := base64.StdEncoding.EncodeToString(tinyPNG)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"created":1700000000,"data":[{"b64_json":"` + b64Tiny + `"}]}`))
	}))

	dbPath := filepath.Join(t.TempDir(), "app-state.db")
	store, err := imagestudio.NewStore(imagestudio.StoreOptions{DatabasePath: dbPath})
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	cat, _ := providers.NewCatalog(providers.BuiltinManifest())
	modalities, _ := modelsdev.New()
	now := time.Unix(1700000000, 0).UTC()
	ident, _ := accountcore.NewNativeSubjectIdentity("kimi", "studio-http-user")
	aliasID, _ := accountcore.NewCLIAccountID(1)
	acc, _ := accountcore.NewAccount(cat, accountcore.NewAccountInput{
		Identity:     ident,
		CLIAccountID: aliasID,
		CreatedAt:    now,
	})
	ov, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{
		Account:       acc,
		HasCredential: true,
		AuthKind:      "api_key",
		AuthMode:      "api_key",
	})
	if err != nil {
		t.Fatalf("NewAccountOverview: %v", err)
	}
	m, _ := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        acc.Ref(),
		ModelID:           "gpt-image-1",
		UpstreamAvailable: true,
		ManualPolicy:      accountapp.ModelPolicyInherit,
		UpdatedAt:         now,
	})

	svc, err := imagestudio.NewService(imagestudio.ServiceDependencies{
		Store: store,
		Catalog: imagestudio.CatalogDependencies{
			Accounts: stubOverviews{items: []accountapp.AccountOverview{ov}},
			AccountModels: stubModels{cat: accountapp.AccountModelCatalog{
				Sets: []accountapp.AccountModelSet{
					{AccountRef: acc.Ref(), ProviderID: "kimi", Models: []accountapp.AccountModel{m}},
				},
			}},
			Runtime:    stubElig{},
			Providers:  cat,
			Modalities: modalities,
		},
		Registry: images.NewRegistry("", "", images.NewFetcher(upstream.Client())),
		Accounts: stubAccSrc{acct: images.Account{
			Provider:   "kimi",
			AccountRef: acc.Ref().String(),
			APIKey:     "k",
			BaseURL:    upstream.URL,
			APIKeyMode: true,
		}},
		HTTP: upstream.Client(),
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	h, err := NewHandler(Dependencies{
		Authorizer: stubAuth{},
		Service:    svc,
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	return h, upstream
}

func TestImageStudioHTTPRoutesLifecycle(t *testing.T) {
	h, upstream := newTestStudioHandler(t)
	defer upstream.Close()

	doReq := func(method string, sub string, body []byte, authed bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, Path+sub, bytes.NewReader(body))
		if authed {
			req.Header.Set("Authorization", "Bearer studio-key")
		}
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	// 1. Auth check
	if rec := doReq(http.MethodGet, "/models", nil, false); rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 unauthorized, got %d", rec.Code)
	}

	// 2. GET /models
	recModels := doReq(http.MethodGet, "/models", nil, true)
	if recModels.Code != 200 {
		t.Fatalf("GET /models = %d %s", recModels.Code, recModels.Body.String())
	}
	var modelsResp struct {
		OK              bool   `json:"ok"`
		DefaultModelKey string `json:"defaultModelKey"`
	}
	if err := json.Unmarshal(recModels.Body.Bytes(), &modelsResp); err != nil || !modelsResp.OK || modelsResp.DefaultModelKey != "kimi:gpt-image-1" {
		t.Fatalf("GET /models parsed unexpected: %+v err=%v", modelsResp, err)
	}

	// 3. POST /sessions -> 201
	recCreate := doReq(http.MethodPost, "/sessions", []byte(`{}`), true)
	if recCreate.Code != http.StatusCreated {
		t.Fatalf("POST /sessions = %d %s", recCreate.Code, recCreate.Body.String())
	}
	var createResp struct {
		OK      bool                `json:"ok"`
		Session imagestudio.Session `json:"session"`
	}
	if err := json.Unmarshal(recCreate.Body.Bytes(), &createResp); err != nil || createResp.Session.ID == "" {
		t.Fatalf("POST /sessions body invalid: %s", recCreate.Body.String())
	}
	sessID := createResp.Session.ID

	// 4. POST /sessions/{id}/runs -> 200 + generated asset
	recRun := doReq(http.MethodPost, "/sessions/"+sessID+"/runs", []byte(`{"modelKey":"kimi:gpt-image-1","mode":"generation","prompt":"sunflower"}`), true)
	if recRun.Code != 200 {
		t.Fatalf("POST /runs = %d %s", recRun.Code, recRun.Body.String())
	}
	var runResp struct {
		OK         bool                `json:"ok"`
		RevisionID string              `json:"revisionId"`
		Session    imagestudio.Session `json:"session"`
	}
	if err := json.Unmarshal(recRun.Body.Bytes(), &runResp); err != nil || len(runResp.Session.Assets) != 1 {
		t.Fatalf("POST /runs body invalid: %s", recRun.Body.String())
	}
	assetID := runResp.Session.Assets[0].ID

	// 5. GET /sessions/{id}/assets/{assetId} binary & immutable headers
	recAsset := doReq(http.MethodGet, "/sessions/"+sessID+"/assets/"+assetID, nil, true)
	if recAsset.Code != 200 {
		t.Fatalf("GET /assets = %d %s", recAsset.Code, recAsset.Body.String())
	}
	if recAsset.Header().Get("Content-Type") != "image/png" ||
		recAsset.Header().Get("Cache-Control") != "private, max-age=31536000, immutable" ||
		recAsset.Header().Get("X-Content-Type-Options") != "nosniff" ||
		!bytes.Equal(recAsset.Body.Bytes(), tinyPNG) {
		t.Fatalf("GET /assets mismatch headers=%v len=%d", recAsset.Header(), recAsset.Body.Len())
	}

	// 6. PATCH /sessions/{id} + GET /sessions + DELETE /sessions/{id}
	recPatch := doReq(http.MethodPatch, "/sessions/"+sessID, []byte(`{"title":"Sunflower Art"}`), true)
	if recPatch.Code != 200 || !bytes.Contains(recPatch.Body.Bytes(), []byte("Sunflower Art")) {
		t.Fatalf("PATCH /sessions = %d %s", recPatch.Code, recPatch.Body.String())
	}
	recList := doReq(http.MethodGet, "/sessions", nil, true)
	if recList.Code != 200 || !bytes.Contains(recList.Body.Bytes(), []byte(sessID)) {
		t.Fatalf("GET /sessions = %d %s", recList.Code, recList.Body.String())
	}
	recDel := doReq(http.MethodDelete, "/sessions/"+sessID, nil, true)
	if recDel.Code != 200 || !bytes.Contains(recDel.Body.Bytes(), []byte(`"deletedSessionId"`)) {
		t.Fatalf("DELETE /sessions = %d %s", recDel.Code, recDel.Body.String())
	}
}
