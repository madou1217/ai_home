package anthropicmessagesapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type tokenCountTestAuthorizer bool

func (a tokenCountTestAuthorizer) Authorized(_ *http.Request) bool { return bool(a) }

func newTokenCountTestHandler(t *testing.T, maxBodyBytes int64) *TokenCountHandler {
	t.Helper()
	handler, err := NewTokenCountHandler(TokenCountDependencies{
		Authorizer:   tokenCountTestAuthorizer(true),
		MaxBodyBytes: maxBodyBytes,
	})
	if err != nil {
		t.Fatalf("NewTokenCountHandler() error = %v", err)
	}
	return handler
}

func decodeTokenCountTestBody(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("response body is not JSON: %v; body=%q", err, response.Body.String())
	}
	return body
}

func TestTokenCountHandlerUsesNodeMethodErrorShape(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, CountTokensPath, nil)
	response := httptest.NewRecorder()

	newTokenCountTestHandler(t, 1024).ServeHTTP(response, request)

	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusMethodNotAllowed)
	}
	body := decodeTokenCountTestBody(t, response)
	if body["ok"] != false || body["error"] != "method_not_allowed" {
		t.Fatalf("body = %#v, want Node method error", body)
	}
	allowed, ok := body["allowed"].([]any)
	if !ok || len(allowed) != 1 || allowed[0] != "POST" {
		t.Fatalf("allowed = %#v, want [POST]", body["allowed"])
	}
}

func TestTokenCountHandlerUsesNodeBodyTooLargeErrorShape(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, CountTokensPath, strings.NewReader("{}"))
	response := httptest.NewRecorder()

	newTokenCountTestHandler(t, 1).ServeHTTP(response, request)

	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusRequestEntityTooLarge)
	}
	body := decodeTokenCountTestBody(t, response)
	if body["ok"] != false || body["error"] != "request_body_too_large" {
		t.Fatalf("body = %#v, want Node size error", body)
	}
}

func TestTokenCountHandlerUsesNodeUnauthorizedErrorShape(t *testing.T) {
	handler, err := NewTokenCountHandler(TokenCountDependencies{
		Authorizer:   tokenCountTestAuthorizer(false),
		MaxBodyBytes: 1024,
	})
	if err != nil {
		t.Fatalf("NewTokenCountHandler() error = %v", err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, CountTokensPath, io.Reader(strings.NewReader("{}"))))

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
	body := decodeTokenCountTestBody(t, response)
	if body["ok"] != false || body["error"] != "unauthorized_client" {
		t.Fatalf("body = %#v, want Node auth error", body)
	}
}
