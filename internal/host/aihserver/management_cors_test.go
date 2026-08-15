package aihserver

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestManagementBrowserAccessAllowsOnlyLoopbackManagementPreflight(t *testing.T) {
	t.Parallel()

	requests := []struct {
		name       string
		path       string
		origin     string
		method     string
		headers    string
		wantStatus int
		wantOrigin string
		wantNext   bool
	}{
		{
			name:       "localhost management",
			path:       "/v1/management/accounts",
			origin:     "http://localhost:8000",
			method:     http.MethodPost,
			headers:    "authorization, content-type",
			wantStatus: http.StatusNoContent,
			wantOrigin: "http://localhost:8000",
		},
		{
			name:       "ipv4 loopback management child",
			path:       "/v1/management/accounts/acct_0123456789abcdef0123/models/refresh",
			origin:     "https://127.0.0.2:9527",
			method:     http.MethodPost,
			headers:    "Authorization",
			wantStatus: http.StatusNoContent,
			wantOrigin: "https://127.0.0.2:9527",
		},
		{
			name:       "ipv6 loopback management",
			path:       "/v1/management/accounts",
			origin:     "http://[::1]:9527",
			method:     http.MethodGet,
			wantStatus: http.StatusNoContent,
			wantOrigin: "http://[::1]:9527",
		},
		{
			name:       "remote origin rejected",
			path:       "/v1/management/accounts",
			origin:     "https://example.com",
			method:     http.MethodGet,
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "lookalike hostname rejected",
			path:       "/v1/management/accounts",
			origin:     "http://127.0.0.1.example.com",
			method:     http.MethodGet,
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "inference never receives cors",
			path:       "/v1/responses",
			origin:     "http://localhost:8000",
			method:     http.MethodPost,
			wantStatus: http.StatusTeapot,
			wantNext:   true,
		},
		{
			name:       "similar prefix never receives cors",
			path:       "/v1/management-evil/accounts",
			origin:     "http://localhost:8000",
			method:     http.MethodGet,
			wantStatus: http.StatusTeapot,
			wantNext:   true,
		},
		{
			name:       "unknown request header rejected",
			path:       "/v1/management/accounts",
			origin:     "http://localhost:8000",
			method:     http.MethodGet,
			headers:    "x-api-key",
			wantStatus: http.StatusForbidden,
			wantOrigin: "http://localhost:8000",
		},
	}

	for _, item := range requests {
		item := item
		t.Run(item.name, func(t *testing.T) {
			t.Parallel()
			called := false
			handler := withManagementBrowserAccess(http.HandlerFunc(func(
				response http.ResponseWriter,
				_ *http.Request,
			) {
				called = true
				response.WriteHeader(http.StatusTeapot)
			}))
			request := httptest.NewRequest(http.MethodOptions, item.path, nil)
			request.Header.Set("Origin", item.origin)
			request.Header.Set("Access-Control-Request-Method", item.method)
			if item.headers != "" {
				request.Header.Set("Access-Control-Request-Headers", item.headers)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)

			if response.Code != item.wantStatus || called != item.wantNext {
				t.Fatalf("status=%d called=%t", response.Code, called)
			}
			if actual := response.Header().Get("Access-Control-Allow-Origin"); actual != item.wantOrigin {
				t.Fatalf("allow origin = %q, want %q", actual, item.wantOrigin)
			}
			if response.Header().Get("Access-Control-Allow-Credentials") != "" {
				t.Fatal("管理面 CORS 不得启用 Cookie 凭据")
			}
		})
	}
}

func TestManagementBrowserAccessForwardsAllowedActualRequest(t *testing.T) {
	t.Parallel()

	called := false
	handler := withManagementBrowserAccess(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		called = true
		if request.Method != http.MethodPatch {
			t.Fatalf("method = %s", request.Method)
		}
		response.WriteHeader(http.StatusAccepted)
	}))
	request := httptest.NewRequest(
		http.MethodPatch,
		"/v1/management/accounts/acct_0123456789abcdef0123",
		nil,
	)
	request.Header.Set("Origin", "http://127.0.0.1:8000")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if !called || response.Code != http.StatusAccepted {
		t.Fatalf("called=%t status=%d", called, response.Code)
	}
	if response.Header().Get("Access-Control-Allow-Origin") !=
		"http://127.0.0.1:8000" {
		t.Fatal("允许的实际请求缺少 CORS Origin")
	}
}
