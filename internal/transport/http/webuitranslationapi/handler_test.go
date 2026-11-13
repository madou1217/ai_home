package webuitranslationapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/modelsdev"
	"github.com/madou1217/ai_home/internal/runtime/translation"
)

type stubAuthorizer struct {
	allow bool
}

func (a stubAuthorizer) Authorized(r *http.Request) bool {
	return a.allow && r.Header.Get("Authorization") == "Bearer test-secret"
}

type stubOverviews struct {
	items []accountapp.AccountOverview
}

func (s stubOverviews) ListAccountOverviews(_ context.Context) ([]accountapp.AccountOverview, error) {
	return s.items, nil
}

type stubModels struct {
	cat accountapp.AccountModelCatalog
}

func (s stubModels) ListAllAccountModels(_ context.Context) (accountapp.AccountModelCatalog, error) {
	return s.cat, nil
}

type stubElig struct{}

func (stubElig) CheckEligibility(_ context.Context, _ runtimecore.ModelRoute) (runtimecore.Eligibility, error) {
	return runtimecore.AvailableEligibility(), nil
}

func newTestCatalogDeps(t *testing.T, dbPath string) translation.CatalogDependencies {
	t.Helper()
	cat, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog: %v", err)
	}
	modalities, err := modelsdev.New()
	if err != nil {
		t.Fatalf("modelsdev.New: %v", err)
	}
	now := time.Unix(1700000000, 0).UTC()
	ident, err := accountcore.NewNativeSubjectIdentity("kimi", "u-test-1")
	if err != nil {
		t.Fatalf("NewNativeSubjectIdentity: %v", err)
	}
	cliID, _ := accountcore.NewCLIAccountID(1)
	acc, err := accountcore.NewAccount(cat, accountcore.NewAccountInput{
		Identity:     ident,
		CLIAccountID: cliID,
		CreatedAt:    now,
	})
	if err != nil {
		t.Fatalf("NewAccount: %v", err)
	}
	ov, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{
		Account:       acc,
		HasCredential: true,
		AuthKind:      "oauth",
		AuthMode:      "oauth",
	})
	if err != nil {
		t.Fatalf("NewAccountOverview: %v", err)
	}
	policyAuto := accountapp.ModelPolicyInherit
	m, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        acc.Ref(),
		ModelID:           "kimi-k2",
		UpstreamAvailable: true,
		ManualPolicy:      policyAuto,
		UpdatedAt:         now,
	})
	if err != nil {
		t.Fatalf("NewAccountModel: %v", err)
	}
	return translation.CatalogDependencies{
		Accounts: stubOverviews{items: []accountapp.AccountOverview{ov}},
		AccountModels: stubModels{cat: accountapp.AccountModelCatalog{
			Sets: []accountapp.AccountModelSet{
				{AccountRef: acc.Ref(), ProviderID: "kimi", Models: []accountapp.AccountModel{m}},
			},
		}},
		Runtime:      stubElig{},
		Providers:    cat,
		Modalities:   modalities,
		DatabasePath: dbPath,
	}
}

func newTestHandler(t *testing.T, gwURL string) *Handler {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "app-state.db")
	h, err := NewHandler(Dependencies{
		Authorizer:   stubAuthorizer{allow: true},
		DatabasePath: dbPath,
		Catalog:      newTestCatalogDeps(t, dbPath),
		Gateway: translation.GatewayConfig{
			BaseURL:   func() string { return gwURL },
			ClientKey: func() string { return "gw-key" },
		},
		Now: func() time.Time { return time.UnixMilli(1700000100000) },
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	return h
}

func TestHandlerAuthAndCORS(t *testing.T) {
	h := newTestHandler(t, "")

	// Unauthenticated OPTIONS returns 204 + extension CORS
	reqOpt := httptest.NewRequest(http.MethodOptions, Path+"/settings", nil)
	reqOpt.Header.Set("Origin", "chrome-extension://abcdef")
	recOpt := httptest.NewRecorder()
	h.ServeHTTP(recOpt, reqOpt)
	if recOpt.Code != http.StatusNoContent {
		t.Fatalf("OPTIONS status = %d, want 204", recOpt.Code)
	}
	if recOpt.Header().Get("Access-Control-Allow-Origin") != "chrome-extension://abcdef" {
		t.Fatalf("missing extension CORS header: %v", recOpt.Header())
	}

	// Non-extension origin does not get ACAO
	reqBad := httptest.NewRequest(http.MethodGet, Path+"/languages", nil)
	reqBad.Header.Set("Origin", "https://evil.example")
	recBad := httptest.NewRecorder()
	h.ServeHTTP(recBad, reqBad)
	if recBad.Code != http.StatusUnauthorized {
		t.Fatalf("unauth status = %d, want 401", recBad.Code)
	}
	if recBad.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("must not reflect non-extension Origin")
	}
}

func TestHandlerEndpointsCRUDAndStream(t *testing.T) {
	gwSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		for _, chunk := range []string{
			`data: {"choices":[{"delta":{"content":"你好，"}}]}`,
			`data: {"choices":[{"delta":{"content":"Go"}}],"usage":{"prompt_tokens":6,"completion_tokens":3,"total_tokens":9}}`,
			`data: [DONE]`,
		} {
			_, _ = fmt.Fprintf(w, "%s\n\n", chunk)
			if flusher != nil {
				flusher.Flush()
			}
		}
	}))
	defer gwSrv.Close()

	h := newTestHandler(t, gwSrv.URL)
	doReq := func(method string, target string, body []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, Path+target, bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer test-secret")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	// 1. GET /languages
	if rec := doReq(http.MethodGet, "/languages", nil); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"zh-Hans"`) {
		t.Fatalf("GET /languages = %d %s", rec.Code, rec.Body.String())
	}

	// 2. POST /detect
	if rec := doReq(http.MethodPost, "/detect", []byte(`{"text":"这是一段简体中文文本。"}`)); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"zh-Hans"`) {
		t.Fatalf("POST /detect = %d %s", rec.Code, rec.Body.String())
	}

	// 3. GET /models
	if rec := doReq(http.MethodGet, "/models", nil); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"kimi-k2"`) {
		t.Fatalf("GET /models = %d %s", rec.Code, rec.Body.String())
	}

	// 4. POST /settings + GET /settings
	recSet := doReq(http.MethodPost, "/settings", []byte(`{"source":"en","target":"zh-CN","model":"kimi-k2","provider":"kimi"}`))
	if recSet.Code != 200 || !strings.Contains(recSet.Body.String(), `"target":"zh-Hans"`) {
		t.Fatalf("POST /settings = %d %s", recSet.Code, recSet.Body.String())
	}
	recGet := doReq(http.MethodGet, "/settings", nil)
	if recGet.Code != 200 || !strings.Contains(recGet.Body.String(), `"kimi-k2"`) {
		t.Fatalf("GET /settings = %d %s", recGet.Code, recGet.Body.String())
	}

	// 5. POST /providers + GET /providers
	recProv := doReq(http.MethodPost, "/providers", []byte(`{"provider":"deepl","config":{"apiKey":"sec-123"}}`))
	if recProv.Code != 200 || strings.Contains(recProv.Body.String(), "sec-123") || !strings.Contains(recProv.Body.String(), `"configured":true`) {
		t.Fatalf("POST /providers = %d %s", recProv.Code, recProv.Body.String())
	}

	// 6. POST /stream 拦截同语言需确认 -> 409
	recConf := doReq(http.MethodPost, "/stream", []byte(`{"text":"你好，这是一段简体中文测试内容。","source":"auto","target":"zh-CN"}`))
	if recConf.Code != 409 || !strings.Contains(recConf.Body.String(), "translation_target_confirmation_required") {
		t.Fatalf("same-language /stream = %d %s", recConf.Code, recConf.Body.String())
	}

	// 7. POST /stream 成功 SSE 输出
	recStream := doReq(http.MethodPost, "/stream", []byte(`{"text":"Hello Go world from client","source":"en","target":"zh-CN","model":"kimi-k2","provider":"kimi"}`))
	if recStream.Code != 200 {
		t.Fatalf("POST /stream status = %d body=%s", recStream.Code, recStream.Body.String())
	}
	sseBody := recStream.Body.String()
	if !strings.Contains(sseBody, `"type":"start"`) ||
		!strings.Contains(sseBody, `"type":"delta"`) ||
		!strings.Contains(sseBody, `"text":"你好，Go"`) ||
		!strings.Contains(sseBody, `"type":"done"`) {
		t.Fatalf("unexpected SSE output: %s", sseBody)
	}

	// 8. Oversized text -> 413
	hugePayload, _ := json.Marshal(map[string]any{
		"text":   strings.Repeat("a", MaxTranslationInputChars+1),
		"target": "zh-CN",
	})
	recHuge := doReq(http.MethodPost, "/stream", hugePayload)
	if recHuge.Code != 413 || !strings.Contains(recHuge.Body.String(), "translation_input_too_large") {
		t.Fatalf("oversized text status = %d %s", recHuge.Code, recHuge.Body.String())
	}
}
