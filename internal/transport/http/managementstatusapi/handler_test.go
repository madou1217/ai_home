package managementstatusapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type testAuthorizer bool

func (authorizer testAuthorizer) Authorized(*http.Request) bool { return bool(authorizer) }

type testSource struct {
	snapshot Snapshot
}

func (source testSource) Snapshot() Snapshot { return source.snapshot }

func TestHandlerReturnsOnlyAuthoritativeStatusProjection(t *testing.T) {
	handler, err := NewHandler(testAuthorizer(true), testSource{snapshot: Snapshot{
		Backend:               "go-core",
		ProviderMode:          "account-pool",
		Strategy:              "round-robin",
		Accounts:              map[string]int{"codex": 2, "claude": 0},
		ModelCount:            12,
		RouteCount:            4,
		InferenceCatalogReady: true,
		InferenceCatalogStale: false,
	}})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, Path, nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	for _, fragment := range []string{
		`"backend":"go-core"`,
		`"provider_mode":"account-pool"`,
		`"strategy":"round-robin"`,
		`"total_accounts":2`,
		`"active_accounts":2`,
		`"models_cached":12`,
		`"route_count":4`,
		`"inference_catalog_ready":true`,
	} {
		if !strings.Contains(body, fragment) {
			t.Fatalf("body missing %s: %s", fragment, body)
		}
	}
	if strings.Contains(body, `"uptime_sec"`) || strings.Contains(body, `"success_rate"`) {
		t.Fatalf("body contains unsupported synthetic fields: %s", body)
	}
}

func TestHandlerRejectsUnauthorizedAndWrongMethod(t *testing.T) {
	handler, err := NewHandler(testAuthorizer(false), testSource{})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, Path, nil))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", response.Code)
	}
	handler, _ = NewHandler(testAuthorizer(true), testSource{})
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, Path, nil))
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("method status = %d", response.Code)
	}
}
