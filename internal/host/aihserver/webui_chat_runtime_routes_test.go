package aihserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
	"github.com/madou1217/ai_home/internal/transport/http/webuichatapi"
)

type chatRuntimeRouteAuthorizer struct {
	allow bool
}

func (a chatRuntimeRouteAuthorizer) Authorized(req *http.Request) bool {
	if a.allow {
		return true
	}
	return req != nil && req.Header.Get("Authorization") == "Bearer test-mgmt-key"
}

type chatRuntimeRouteCredential struct {
	provider string
}

func (c chatRuntimeRouteCredential) ProviderID() string   { return c.provider }
func (c chatRuntimeRouteCredential) IdentitySeed() string { return "seed-" + c.provider }
func (c chatRuntimeRouteCredential) String() string       { return "chat-runtime-test-credential" }
func (c chatRuntimeRouteCredential) GoString() string     { return "chatRuntimeRouteCredential" }

type chatRuntimeRouteCreds struct{}

func (chatRuntimeRouteCreds) ResolveObservedCredentialBinding(
	_ context.Context,
	ref accountcore.AccountRef,
) (accountapp.CredentialBinding, accountcredentials.CredentialObservation, error) {
	cred := chatRuntimeRouteCredential{provider: "opencode"}
	binding, err := accountapp.NewCredentialBinding(ref, "opencode", cred)
	if err != nil {
		return accountapp.CredentialBinding{}, accountcredentials.CredentialObservation{}, err
	}
	snap, err := accountapp.NewCredentialSnapshot(ref, "opencode", cred, time.Unix(1_700_000_000, 0))
	if err != nil {
		return accountapp.CredentialBinding{}, accountcredentials.CredentialObservation{}, err
	}
	obs, err := accountcredentials.NewCredentialObservation(snap)
	if err != nil {
		return accountapp.CredentialBinding{}, accountcredentials.CredentialObservation{}, err
	}
	return binding, obs, nil
}

func (chatRuntimeRouteCreds) IsCurrentCredentialObservation(
	context.Context,
	accountcredentials.CredentialObservation,
) (bool, error) {
	return true, nil
}

type chatRuntimeRouteCursor struct{}

func (chatRuntimeRouteCursor) Next(context.Context) (accountcore.AccountRef, bool, error) {
	return "", false, nil
}

type chatRuntimeRouteAccounts struct{}

func (chatRuntimeRouteAccounts) Accounts(context.Context, runtimecore.ModelID) (relaycore.AccountCursor, error) {
	return chatRuntimeRouteCursor{}, nil
}

type chatRuntimeRouteAttempts struct{}

func (chatRuntimeRouteAttempts) RecordSuccess(context.Context, runtimecore.ModelRoute, inferencegateway.AttemptSuccess) error {
	return nil
}

func (chatRuntimeRouteAttempts) RecordFailure(context.Context, runtimecore.ModelRoute, inferencegateway.AttemptFailure) error {
	return nil
}

type chatRuntimeRouteHTTPClient struct{}

func (chatRuntimeRouteHTTPClient) Do(*http.Request) (*http.Response, error) {
	return nil, context.Canceled
}

type chatRuntimeRouteProvider struct {
	relaycore.BaseProvider
}

func (p *chatRuntimeRouteProvider) Resolve(input relaycore.ResolveInput) (relaycore.Provider, bool) {
	if strings.EqualFold(strings.TrimSpace(input.ProviderID), p.ID()) {
		return p, true
	}
	return nil, false
}

func (chatRuntimeRouteProvider) AccessToken(accountapp.Credential) (string, error) {
	return "token", nil
}

func TestBuildWebUIChatRuntimeRoutes(t *testing.T) {
	t.Run("缺少鉴权或共享Handler时安全跳过", func(t *testing.T) {
		routes, err := buildWebUIChatRuntimeRoutes(webuiRouteDependencies{})
		if err != nil || len(routes) != 0 {
			t.Fatalf("buildWebUIChatRuntimeRoutes() = %+v, err = %v, want empty nil", routes, err)
		}
		routes2, err := BuildWebUIChatRuntimeCollectionRoutes(nil)
		if err != nil || len(routes2) != 0 {
			t.Fatalf("BuildWebUIChatRuntimeCollectionRoutes(nil) = %+v, err = %v", routes2, err)
		}
	})

	t.Run("挂载集合产物路由与mountWebUIChat无ServeMux冲突并端到端可用", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		tmp := t.TempDir()
		aiHome := filepath.Join(tmp, ".ai_home")
		cat, err := providers.NewCatalog(providers.BuiltinManifest())
		if err != nil {
			t.Fatalf("NewCatalog: %v", err)
		}

		rawHandler, err := newWebUIChatHandler(webuichatapi.Dependencies{
			Authorizer:  chatRuntimeRouteAuthorizer{},
			Accounts:    chatRuntimeRouteAccounts{},
			Credentials: chatRuntimeRouteCreds{},
			Provider:    &chatRuntimeRouteProvider{BaseProvider: relaycore.NewBaseProvider("opencode", "https://upstream.test/v1/chat/completions")},
			Client:      chatRuntimeRouteHTTPClient{},
			Attempts:    chatRuntimeRouteAttempts{},
			Clock:       func() time.Time { return time.Unix(1_700_000_000, 0) },
		})
		if err != nil {
			t.Fatalf("newWebUIChatHandler: %v", err)
		}
		chatHandler := rawHandler.(*webuichatapi.Handler)

		svc, err := AttachWebUIChatRuntime(ctx, chatHandler, webuiRouteDependencies{
			Authorizer:  chatRuntimeRouteAuthorizer{},
			AIHomeDir:   aiHome,
			HostHomeDir: tmp,
			Catalog:     cat,
		})
		if err != nil {
			t.Fatalf("AttachWebUIChatRuntime: %v", err)
		}
		defer func() { _ = svc.Close() }()

		routes, err := buildWebUIChatRuntimeRoutesWithHandler(webuiRouteDependencies{
			Authorizer: chatRuntimeRouteAuthorizer{},
			AIHomeDir:  aiHome,
		}, chatHandler)
		if err != nil {
			t.Fatalf("buildWebUIChatRuntimeRoutesWithHandler: %v", err)
		}
		if len(routes) != 4 {
			t.Fatalf("routes len = %d, want 4", len(routes))
		}

		mux := http.NewServeMux()
		mountWebUIChat(mux, chatHandler)
		for _, r := range routes {
			mux.Handle(r.Pattern, r.Handler)
		}

		// 未携带管理凭据返回 401
		unauthRec := httptest.NewRecorder()
		mux.ServeHTTP(unauthRec, httptest.NewRequest(http.MethodGet, "/v1/management/webui/chat/sessions", nil))
		if unauthRec.Code != http.StatusUnauthorized {
			t.Fatalf("unauthorized GET /sessions = %d, want 401", unauthRec.Code)
		}

		// POST 创建纯聊天会话 -> 201
		createReq := httptest.NewRequest(http.MethodPost, "/v1/management/webui/chat/sessions", strings.NewReader(`{"provider":"codex"}`))
		createReq.Header.Set("Authorization", "Bearer test-mgmt-key")
		createRec := httptest.NewRecorder()
		mux.ServeHTTP(createRec, createReq)
		if createRec.Code != http.StatusCreated {
			t.Fatalf("POST /sessions = %d (%s)", createRec.Code, createRec.Body.String())
		}
		var createBody map[string]any
		if err := json.Unmarshal(createRec.Body.Bytes(), &createBody); err != nil {
			t.Fatalf("unmarshal create: %v", err)
		}
		sessMap, _ := createBody["session"].(map[string]any)
		sessionID, _ := sessMap["sessionId"].(string)
		if sessionID == "" {
			t.Fatalf("missing sessionId in %v", createBody)
		}

		// GET /sessions 列表含刚创建的会话
		listReq := httptest.NewRequest(http.MethodGet, "/v1/management/webui/chat/sessions", nil)
		listReq.Header.Set("Authorization", "Bearer test-mgmt-key")
		listRec := httptest.NewRecorder()
		mux.ServeHTTP(listRec, listReq)
		if listRec.Code != http.StatusOK || !strings.Contains(listRec.Body.String(), sessionID) {
			t.Fatalf("GET /sessions = %d (%s)", listRec.Code, listRec.Body.String())
		}

		// GET /sessions/{id}/snapshot 走 mountWebUIChat 且读到同一运行时实例
		snapReq := httptest.NewRequest(http.MethodGet, webuichatapi.ManagementCollectionPath+sessionID+"/snapshot", nil)
		snapReq.Header.Set("Authorization", "Bearer test-mgmt-key")
		snapRec := httptest.NewRecorder()
		mux.ServeHTTP(snapRec, snapReq)
		if snapRec.Code != http.StatusOK {
			t.Fatalf("GET /snapshot = %d (%s)", snapRec.Code, snapRec.Body.String())
		}

		// GET /artifacts/missing -> 404 artifact_not_found
		artReq := httptest.NewRequest(http.MethodGet, webuichatapi.ArtifactCollectionPath+"missing", nil)
		artReq.Header.Set("Authorization", "Bearer test-mgmt-key")
		artRec := httptest.NewRecorder()
		mux.ServeHTTP(artRec, artReq)
		if artRec.Code != http.StatusNotFound {
			t.Fatalf("GET /artifacts/missing = %d (%s)", artRec.Code, artRec.Body.String())
		}

		// DELETE /sessions/{id} -> 200
		delReq := httptest.NewRequest(http.MethodDelete, webuichatapi.ManagementCollectionPath+sessionID, nil)
		delReq.Header.Set("Authorization", "Bearer test-mgmt-key")
		delRec := httptest.NewRecorder()
		mux.ServeHTTP(delRec, delReq)
		if delRec.Code != http.StatusOK {
			t.Fatalf("DELETE /sessions/{id} = %d (%s)", delRec.Code, delRec.Body.String())
		}
	})
}
