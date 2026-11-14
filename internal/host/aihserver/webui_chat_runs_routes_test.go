package aihserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
	"github.com/madou1217/ai_home/internal/transport/http/webuichatapi"
)

func newTestWebUIChatRunsHandler(t *testing.T, allow bool) (*webuichatapi.Handler, func()) {
	t.Helper()
	tmp := t.TempDir()
	aiHome := filepath.Join(tmp, ".ai_home")
	cat, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	rawHandler, err := newWebUIChatHandler(webuichatapi.Dependencies{
		Authorizer:  chatRuntimeRouteAuthorizer{allow: allow},
		Accounts:    chatRuntimeRouteAccounts{},
		Credentials: chatRuntimeRouteCreds{},
		Provider:    &chatRuntimeRouteProvider{BaseProvider: relaycore.NewBaseProvider("opencode", "https://upstream.test/v1/chat/completions")},
		Client:      chatRuntimeRouteHTTPClient{},
		Attempts:    chatRuntimeRouteAttempts{},
		Clock:       func() time.Time { return time.Unix(1_700_000_000, 0) },
	})
	if err != nil {
		t.Fatalf("newWebUIChatHandler() error = %v", err)
	}
	handler := rawHandler.(*webuichatapi.Handler)
	svc, err := BuildWebUIChatRuntimeService(context.Background(), WebUIChatRuntimeBuildOptions{
		AIHomeDir:   aiHome,
		HostHomeDir: tmp,
		Catalog:     cat,
	})
	if err != nil {
		t.Fatalf("BuildWebUIChatRuntimeService() error = %v", err)
	}
	handler.AttachRuntime(svc, nil)
	return handler, func() { _ = svc.Close() }
}

func TestBuildWebUIChatRunsRoutesNilGuards(t *testing.T) {
	routes, err := BuildWebUIChatRunsRoutes(nil, nil)
	if err != nil || routes != nil {
		t.Fatalf("BuildWebUIChatRunsRoutes(nil, nil) = (%v, %v), want (nil, nil)", routes, err)
	}
	routes, err = buildWebUIChatRunsRoutes(webuiRouteDependencies{})
	if err != nil || routes != nil {
		t.Fatalf("buildWebUIChatRunsRoutes(empty) = (%v, %v), want (nil, nil)", routes, err)
	}
	handler, cleanup := newTestWebUIChatRunsHandler(t, true)
	defer cleanup()
	routes, err = buildWebUIChatRunsRoutesWithHandler(webuiRouteDependencies{}, handler)
	if err != nil || routes != nil {
		t.Fatalf("buildWebUIChatRunsRoutesWithHandler(no authorizer) = (%v, %v), want (nil, nil)", routes, err)
	}
}

func TestBuildWebUIChatRunsRoutesServeMuxCoexistence(t *testing.T) {
	handler, cleanup := newTestWebUIChatRunsHandler(t, true)
	defer cleanup()

	mux := http.NewServeMux()
	// 模拟 composition.go 中同一批 chat 路由同时挂载，验证 ServeMux 模式零冲突。
	mountWebUIChat(mux, handler)
	collectionRoutes, err := BuildWebUIChatRuntimeCollectionRoutes(handler)
	if err != nil {
		t.Fatalf("BuildWebUIChatRuntimeCollectionRoutes() error = %v", err)
	}
	for _, route := range collectionRoutes {
		mux.Handle(route.Pattern, route.Handler)
	}

	runsRoutes, err := buildWebUIChatRunsRoutesWithHandler(webuiRouteDependencies{
		Authorizer: chatRuntimeRouteAuthorizer{allow: true},
	}, handler)
	if err != nil {
		t.Fatalf("buildWebUIChatRunsRoutesWithHandler() error = %v", err)
	}
	if len(runsRoutes) != 9 {
		t.Fatalf("expected 9 runs routes, got %d", len(runsRoutes))
	}
	for _, route := range runsRoutes {
		mux.Handle(route.Pattern, route.Handler)
	}

	// 1. GET /v1/management/webui/chat/runs
	runsRec := httptest.NewRecorder()
	mux.ServeHTTP(runsRec, httptest.NewRequest(http.MethodGet, "/v1/management/webui/chat/runs", nil))
	if runsRec.Code != http.StatusOK {
		t.Fatalf("GET /runs status = %d, body = %s", runsRec.Code, runsRec.Body.String())
	}

	// 2. POST /v1/management/webui/chat/runs/{runId}/input -> missing run returns 404 (not 405)
	inputRec := httptest.NewRecorder()
	mux.ServeHTTP(inputRec, httptest.NewRequest(http.MethodPost, "/v1/management/webui/chat/runs/run-1/input", strings.NewReader(`{"input":"hi"}`)))
	if inputRec.Code != http.StatusNotFound {
		t.Fatalf("POST /runs/run-1/input status = %d, want 404, body = %s", inputRec.Code, inputRec.Body.String())
	}

	// 3. POST /v1/management/webui/chat/runs/{runId}/resize
	resizeRec := httptest.NewRecorder()
	mux.ServeHTTP(resizeRec, httptest.NewRequest(http.MethodPost, "/v1/management/webui/chat/runs/run-1/resize", strings.NewReader(`{"cols":80,"rows":24}`)))
	if resizeRec.Code != http.StatusNotFound {
		t.Fatalf("POST /runs/run-1/resize status = %d, want 404, body = %s", resizeRec.Code, resizeRec.Body.String())
	}

	// 4. POST /v1/management/webui/chat/runs/{runId}/abort -> idempotent 200 alreadyGone
	abortRec := httptest.NewRecorder()
	mux.ServeHTTP(abortRec, httptest.NewRequest(http.MethodPost, "/v1/management/webui/chat/runs/run-1/abort", nil))
	if abortRec.Code != http.StatusOK {
		t.Fatalf("POST /runs/run-1/abort status = %d, want 200, body = %s", abortRec.Code, abortRec.Body.String())
	}

	// 5. POST /v1/management/webui/chat/runs/{runId}/approvals/{approvalId} -> 200 alreadyResolved
	approvalDecideRec := httptest.NewRecorder()
	mux.ServeHTTP(approvalDecideRec, httptest.NewRequest(http.MethodPost, "/v1/management/webui/chat/runs/run-1/approvals/appr-1", strings.NewReader(`{"decision":"allow"}`)))
	if approvalDecideRec.Code != http.StatusOK {
		t.Fatalf("POST /runs/run-1/approvals/appr-1 status = %d, want 200, body = %s", approvalDecideRec.Code, approvalDecideRec.Body.String())
	}

	// 6. POST /v1/management/webui/chat/internal/approval-request -> invalid json hits handler (400)
	inboundRec := httptest.NewRecorder()
	mux.ServeHTTP(inboundRec, httptest.NewRequest(http.MethodPost, "/v1/management/webui/chat/internal/approval-request", strings.NewReader(`{`)))
	if inboundRec.Code != http.StatusBadRequest {
		t.Fatalf("POST /internal/approval-request status = %d, want 400, body = %s", inboundRec.Code, inboundRec.Body.String())
	}

	// 7. POST /v1/management/webui/chat/cli-install-confirmations/{confirmationId} -> unknown returns 404
	cliRec := httptest.NewRecorder()
	mux.ServeHTTP(cliRec, httptest.NewRequest(http.MethodPost, "/v1/management/webui/chat/cli-install-confirmations/conf-1", strings.NewReader(`{"decision":"confirm"}`)))
	if cliRec.Code != http.StatusNotFound {
		t.Fatalf("POST /cli-install-confirmations/conf-1 status = %d, want 404, body = %s", cliRec.Code, cliRec.Body.String())
	}

	// 8. POST /v1/management/webui/chat -> valid chat payload returns 409 chat_harness_required
	legacyRec := httptest.NewRecorder()
	mux.ServeHTTP(legacyRec, httptest.NewRequest(http.MethodPost, "/v1/management/webui/chat", strings.NewReader(`{"messages":[{"role":"user","content":"hi"}]}`)))
	if legacyRec.Code != http.StatusConflict {
		t.Fatalf("POST /chat status = %d, want 409, body = %s", legacyRec.Code, legacyRec.Body.String())
	}
}
