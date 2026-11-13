package webuiaccountauthapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/accountauth"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/kirooauth"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountaddapi"
)

type stubAuthorizer struct {
	allow bool
}

func (stub stubAuthorizer) Authorized(request *http.Request) bool {
	return stub.allow && request != nil
}

type fakeZCodeFlow struct {
	url          string
	state        string
	authStrategy string
	artifacts    []byte
	account      accountauth.Account
}

func (flow *fakeZCodeFlow) AuthorizationURL() string { return flow.url }
func (flow *fakeZCodeFlow) OAuthState() string       { return flow.state }
func (flow *fakeZCodeFlow) AuthStrategy() string     { return flow.authStrategy }
func (flow *fakeZCodeFlow) AccountClaims() accountauth.Account {
	return flow.account
}
func (flow *fakeZCodeFlow) Exchange(_ context.Context, callbackURL string) ([]byte, error) {
	if strings.Contains(callbackURL, "code=ok") {
		return flow.artifacts, nil
	}
	return nil, accountauth.ErrInvalidCallback
}

type fakeZCodeProvider struct {
	flow *fakeZCodeFlow
}

func (provider fakeZCodeProvider) ProviderID() string { return "zcode" }
func (provider fakeZCodeProvider) Begin(context.Context) (accountauth.OAuthFlow, error) {
	return provider.flow, nil
}

type fakeBaselineAuthProvider struct{ id string }

func (p fakeBaselineAuthProvider) ProviderID() string { return p.id }
func (p fakeBaselineAuthProvider) Begin(context.Context) (accountauth.OAuthFlow, error) {
	return &fakeZCodeFlow{url: "https://auth.example.com/" + p.id}, nil
}

type stubKiroLocalLoginClient struct {
	result kirooauth.ImportResult
	err    error
}

func (stub stubKiroLocalLoginClient) ImportIDELocal(context.Context, string) (kirooauth.ImportResult, error) {
	return stub.result, stub.err
}

func openTestDeps(t *testing.T, nodePort string) (Dependencies, *sqliteaccount.Store, *accountauth.Service, string) {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	aiHomeDir := t.TempDir()
	store, err := sqliteaccount.Open(context.Background(), sqliteaccount.OpenOptions{
		AIHomeDir: aiHomeDir,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	hostHomeDir := t.TempDir()
	registrar, err := accountapp.NewRegistrar(catalog, store, time.Now)
	if err != nil {
		t.Fatalf("NewRegistrar() error = %v", err)
	}
	reauth, err := accountapp.NewReauthenticator(catalog, store, time.Now)
	if err != nil {
		t.Fatalf("NewReauthenticator() error = %v", err)
	}
	zcodeArtifacts := []byte(`{"native_auth_json":{"credentials":{"zcodejwttoken":"zcode-jwt-token","oauth:zai:access_token":"{\"access_token\":\"zai-at\",\"user_id\":\"9001\",\"username\":\"zcode-user\"}","oauth:zai:user_info":"{\"user_id\":\"uuid-zcode-9001\",\"username\":\"zcode-user\"}"}}}`)
	authJobs, err := accountauth.NewService(accountauth.Dependencies{
		Providers: []accountauth.OAuthProvider{
			fakeZCodeProvider{flow: &fakeZCodeFlow{
				url:          "https://auth.example.com/authorize?state=zstate-123",
				state:        "zstate-123",
				authStrategy: "zai:custom-scheme",
				artifacts:    zcodeArtifacts,
				account:      accountauth.Account{Email: "zcode@example.com", DisplayName: "zcode-user"},
			}},
			fakeBaselineAuthProvider{id: "codex"},
			fakeBaselineAuthProvider{id: "claude"},
			fakeBaselineAuthProvider{id: "kiro"},
		},
		Decoder:    nativeaccount.NewDecoder(),
		Registrar:  registrar,
		Reauth:     reauth,
		Clock:      time.Now,
		GenerateID: accountauth.NewRandomJobID,
		JobStore:   store,
	})
	if err != nil {
		t.Fatalf("accountauth.NewService() error = %v", err)
	}
	nodeURL := ""
	if nodePort != "" {
		nodeURL = "http://127.0.0.1:" + nodePort
	}
	deps := Dependencies{
		Authorizer:  stubAuthorizer{allow: true},
		Catalog:     catalog,
		Store:       store,
		AuthJobs:    authJobs,
		HostHomeDir: hostHomeDir,
		NodeBaseURL: nodeURL,
		Clock:       time.Now,
	}
	return deps, store, authJobs, hostHomeDir
}

func buildTestKiroSocialArtifact(t *testing.T) []byte {
	t.Helper()
	endpoint := "https://codewhisperer.us-east-1.amazonaws.com"
	accessToken := "kiro-at-local-1234"
	refreshToken := "kiro-rt-local-1234"
	bindingRaw, err := json.Marshal([]string{endpoint, accessToken, refreshToken})
	if err != nil {
		t.Fatalf("json.Marshal(binding) error = %v", err)
	}
	digest := sha256.Sum256(bindingRaw)
	nativeDoc := map[string]any{
		"auth": map[string]any{
			"accessToken":  accessToken,
			"refreshToken": refreshToken,
			"expiresAt":    time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
			"region":       "us-east-1",
			"profileArn":   "arn:aws:codewhisperer:us-east-1:123456789012:profile/TEST",
			"authMethod":   "social",
			"provider":     "Google",
		},
		"identityEvidence": map[string]any{
			"version":      1,
			"source":       "aws-codewhisperer:GetUsageLimits",
			"endpoint":     endpoint,
			"subject":      "kiro-user-ide-1",
			"email":        "ide@example.com",
			"tokenBinding": hex.EncodeToString(digest[:]),
			"observedAtMs": time.Now().UnixMilli(),
		},
	}
	envelope := map[string]any{"native_auth_json": nativeDoc}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	return encoded
}

func TestZCodeURLCallback(t *testing.T) {
	deps, _, authJobs, _ := openTestDeps(t, "")
	handler, err := NewHandler(deps)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}

	t.Run("未授权返回401", func(t *testing.T) {
		unauthDeps := deps
		unauthDeps.Authorizer = stubAuthorizer{allow: false}
		unauthHandler, _ := NewHandler(unauthDeps)
		req := httptest.NewRequest(http.MethodPost, ZCodeURLCallbackPath, bytes.NewBufferString(`{"url":"zcode://cb?state=s&code=ok","state":"s"}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		unauthHandler.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
	})

	t.Run("无匹配作业返回404", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, ZCodeURLCallbackPath, bytes.NewBufferString(`{"url":"zcode://cb?state=unknown&code=ok","state":"unknown"}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404, body=%s", rec.Code, rec.Body.String())
		}
	})

	t.Run("匹配在途ZCode作业并完成注册", func(t *testing.T) {
		started, err := authJobs.Start(context.Background(), accountauth.StartRequest{
			ProviderID: "zcode",
		})
		if err != nil {
			t.Fatalf("Start() error = %v", err)
		}
		req := httptest.NewRequest(http.MethodPost, ZCodeURLCallbackPath, bytes.NewBufferString(`{"url":"zcode://cb?state=zstate-123&code=ok","state":"zstate-123"}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200, body=%s", rec.Code, rec.Body.String())
		}
		var resp struct {
			OK      bool `json:"ok"`
			Handled bool `json:"handled"`
			Job     struct {
				ID     string `json:"id"`
				Status string `json:"status"`
			} `json:"job"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("Unmarshal() error = %v", err)
		}
		if !resp.OK || !resp.Handled || resp.Job.ID != started.Job().ID() || resp.Job.Status != "succeeded" {
			t.Fatalf("unexpected response: %+v", resp)
		}
	})
}

func TestStaticAccounts(t *testing.T) {
	deps, store, _, _ := openTestDeps(t, "25801")
	handler, err := NewHandler(deps)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}

	postStatic := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, StaticAccountPath, bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	t.Run("Codex APIKey写入与不入池偏好及幂等重入", func(t *testing.T) {
		payload := `{"provider":"codex","authMode":"api-key","config":{"apiKey":"sk-codex-static-1","baseUrl":"https://api.example.com/v1"},"aliasPoolParticipates":false}`
		rec := postStatic(payload)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200, body=%s", rec.Code, rec.Body.String())
		}
		var resp struct {
			OK         bool   `json:"ok"`
			AccountRef string `json:"accountRef"`
			Created    bool   `json:"created"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("Unmarshal() error = %v", err)
		}
		if !resp.OK || !resp.Created || resp.AccountRef == "" {
			t.Fatalf("unexpected response: %+v", resp)
		}
		ref, err := accountcore.ParseAccountRef(resp.AccountRef)
		if err != nil {
			t.Fatalf("ParseAccountRef() error = %v", err)
		}
		exclusions, err := store.LoadRoutingExclusions(context.Background())
		if err != nil {
			t.Fatalf("LoadRoutingExclusions() error = %v", err)
		}
		if !exclusions[ref.String()] {
			t.Fatalf("expected routing exclusion for %s, got %+v", ref, exclusions)
		}
		repeat := postStatic(payload)
		if repeat.Code != http.StatusOK {
			t.Fatalf("repeat status = %d, want 200, body=%s", repeat.Code, repeat.Body.String())
		}
		var repeatResp struct {
			AccountRef string `json:"accountRef"`
			Created    bool   `json:"created"`
		}
		_ = json.Unmarshal(repeat.Body.Bytes(), &repeatResp)
		if repeatResp.AccountRef != resp.AccountRef || repeatResp.Created {
			t.Fatalf("repeat = %+v, want same ref & created=false", repeatResp)
		}
	})

	t.Run("自中继Loopback端点被拒绝", func(t *testing.T) {
		rec := postStatic(`{"provider":"codex","authMode":"api-key","config":{"apiKey":"sk-loop","baseUrl":"http://127.0.0.1:25801/v1"}}`)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "self_relay_account_not_allowed") {
			t.Fatalf("status = %d, body = %s, want 400 self_relay_account_not_allowed", rec.Code, rec.Body.String())
		}
	})

	t.Run("Gemini APIKey拒绝BaseURL并允许Vertex占位", func(t *testing.T) {
		badGemini := postStatic(`{"provider":"gemini","authMode":"api-key","config":{"apiKey":"gem-key-1","baseUrl":"https://custom.example.com"}}`)
		if badGemini.Code != http.StatusBadRequest || !strings.Contains(badGemini.Body.String(), "base_url_unsupported") {
			t.Fatalf("badGemini = %d %s", badGemini.Code, badGemini.Body.String())
		}
		vertex := postStatic(`{"provider":"gemini","authMode":"vertex-ai","config":{"projectId":"proj-1","location":"us-central1","placeholder":true}}`)
		if vertex.Code != http.StatusOK || !strings.Contains(vertex.Body.String(), `"placeholder":true`) {
			t.Fatalf("vertex = %d %s", vertex.Code, vertex.Body.String())
		}
	})

	t.Run("Claude AuthToken与通用StaticAPIKey", func(t *testing.T) {
		claudeRec := postStatic(`{"provider":"claude","authMode":"auth-token","config":{"authToken":"sk-ant-at-1","baseUrl":"https://claude.example.com"}}`)
		if claudeRec.Code != http.StatusOK {
			t.Fatalf("claudeRec = %d %s", claudeRec.Code, claudeRec.Body.String())
		}
		kimiRec := postStatic(`{"provider":"kimi","authMode":"api-key","config":{"apiKey":"sk-moonshot-1","baseUrl":"https://api.moonshot.ai/v1"}}`)
		if kimiRec.Code != http.StatusOK {
			t.Fatalf("kimiRec = %d %s", kimiRec.Code, kimiRec.Body.String())
		}
	})
}

func TestLocalImport(t *testing.T) {
	deps, _, _, hostHomeDir := openTestDeps(t, "")
	handler, err := NewHandler(deps)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}

	postLocal := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, LocalImportPath, bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	t.Run("需要登录任务的来源返回403", func(t *testing.T) {
		rec := postLocal(`{"provider":"kiro","sourceId":"kiro-ide-local"}`)
		if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "auth_source_requires_login_job") {
			t.Fatalf("rec = %d %s", rec.Code, rec.Body.String())
		}
		clineRec := postLocal(`{"provider":"cline","sourceId":"cline-host-scan"}`)
		if clineRec.Code != http.StatusForbidden || !strings.Contains(clineRec.Body.String(), "auth_source_requires_login_job") {
			t.Fatalf("clineRec = %d %s", clineRec.Code, clineRec.Body.String())
		}
	})

	t.Run("OpenCode本机直接导入及重复导入拦截", func(t *testing.T) {
		openCodePath := filepath.Join(hostHomeDir, ".local", "share", "opencode", "auth.json")
		if err := os.MkdirAll(filepath.Dir(openCodePath), 0o700); err != nil {
			t.Fatalf("MkdirAll() error = %v", err)
		}
		if err := os.WriteFile(openCodePath, []byte(`{"opencode":{"type":"api","key":"sk-opencode-local-1"}}`), 0o600); err != nil {
			t.Fatalf("WriteFile() error = %v", err)
		}
		rec := postLocal(`{"provider":"opencode","sourceId":"opencode-host-local"}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("rec = %d %s", rec.Code, rec.Body.String())
		}
		dup := postLocal(`{"provider":"opencode","sourceId":"opencode-host-local"}`)
		if dup.Code != http.StatusConflict || !strings.Contains(dup.Body.String(), "auth_source_already_imported") {
			t.Fatalf("dup = %d %s", dup.Code, dup.Body.String())
		}
	})
}

func TestNewKiroJobLocalImporter(t *testing.T) {
	_, _, authJobs, hostHomeDir := openTestDeps(t, "")
	started, err := authJobs.Start(context.Background(), accountauth.StartRequest{
		ProviderID: "kiro",
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	jobView := webuiaccountaddapi.NewJobView(started.Job())

	prodImporter := NewKiroJobLocalImporter(authJobs, hostHomeDir)
	if _, err := prodImporter.CompleteLocalImport(context.Background(), jobView, "other-source"); !errors.Is(err, webuiaccountaddapi.ErrUnsupportedLocalSource) {
		t.Fatalf("err = %v, want ErrUnsupportedLocalSource", err)
	}
	if _, err := prodImporter.CompleteLocalImport(context.Background(), jobView, "kiro-ide-local"); !errors.Is(err, webuiaccountaddapi.ErrLocalSourceUnavailable) {
		t.Fatalf("err = %v, want ErrLocalSourceUnavailable", err)
	}

	kiroArtifacts := buildTestKiroSocialArtifact(t)
	stubImporter := newKiroJobLocalImporterWithLogin(authJobs, hostHomeDir, stubKiroLocalLoginClient{
		result: kirooauth.ImportResult{
			Artifacts: kiroArtifacts,
			Account:   accountauth.Account{Email: "ide@example.com", DisplayName: "ide@example.com"},
		},
	})
	completed, err := stubImporter.CompleteLocalImport(context.Background(), jobView, "kiro-ide-local")
	if err != nil {
		t.Fatalf("CompleteLocalImport() error = %v", err)
	}
	if completed.Status != "succeeded" || completed.AccountRef == "" {
		t.Fatalf("completed = %+v, want succeeded with accountRef", completed)
	}
}
