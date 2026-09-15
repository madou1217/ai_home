package anthropicmessagesapi_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/transport/http/anthropicmessagesapi"
)

// TestTokenCountHandlerReturnsLocalEstimate 验证命中 count_tokens 后只做本地估算。
//
// 该路由不选账号、不发上游请求，因此这里不注入任何 Executor。
func TestTokenCountHandlerReturnsLocalEstimate(t *testing.T) {
	t.Parallel()

	handler := newTestTokenCountHandler(t)
	request := httptest.NewRequest(
		http.MethodPost,
		anthropicmessagesapi.CountTokensPath,
		strings.NewReader(`{"messages":[{"role":"user","content":"hello world"}]}`),
	)
	request.Header.Set("x-api-key", tokenCountTestKey)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	var document struct {
		InputTokens int `json:"input_tokens"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if document.InputTokens != 8 {
		t.Fatalf("input_tokens = %d, want 8", document.InputTokens)
	}
}

// TestTokenCountHandlerRequiresClientKey 验证计数路由与 Messages 共用同一鉴权闸门。
func TestTokenCountHandlerRequiresClientKey(t *testing.T) {
	t.Parallel()

	handler := newTestTokenCountHandler(t)
	response := httptest.NewRecorder()
	handler.ServeHTTP(
		response,
		httptest.NewRequest(
			http.MethodPost,
			anthropicmessagesapi.CountTokensPath,
			strings.NewReader(`{}`),
		),
	)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status=%d body=%s", response.Code, response.Body)
	}
	if !strings.Contains(response.Body.String(), `"type":"authentication_error"`) {
		t.Fatalf("unauthorized body = %s", response.Body)
	}
}

// TestTokenCountHandlerRejectsNonPost 验证只有 POST 是计数路由。
func TestTokenCountHandlerRejectsNonPost(t *testing.T) {
	t.Parallel()

	handler := newTestTokenCountHandler(t)
	request := httptest.NewRequest(
		http.MethodGet,
		anthropicmessagesapi.CountTokensPath,
		nil,
	)
	request.Header.Set("x-api-key", tokenCountTestKey)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status=%d body=%s", response.Code, response.Body)
	}
	if got := response.Header().Get("Allow"); got != http.MethodPost {
		t.Fatalf("allow = %q, want POST", got)
	}
}

// TestTokenCountHandlerFallsBackOnMalformedBody 验证不可解析正文按空请求兜底。
func TestTokenCountHandlerFallsBackOnMalformedBody(t *testing.T) {
	t.Parallel()

	handler := newTestTokenCountHandler(t)
	request := httptest.NewRequest(
		http.MethodPost,
		anthropicmessagesapi.CountTokensPath,
		strings.NewReader("{not json"),
	)
	request.Header.Set("x-api-key", tokenCountTestKey)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	if !strings.Contains(response.Body.String(), `"input_tokens":1`) {
		t.Fatalf("body = %s", response.Body)
	}
}

// TestTokenCountHandlerRejectsOversizedBody 验证请求体上限生效。
func TestTokenCountHandlerRejectsOversizedBody(t *testing.T) {
	t.Parallel()

	handler := newTestTokenCountHandlerWithLimit(t, 64)
	request := httptest.NewRequest(
		http.MethodPost,
		anthropicmessagesapi.CountTokensPath,
		strings.NewReader(`{"messages":[{"role":"user","content":"`+
			strings.Repeat("x", 256)+`"}]}`),
	)
	request.Header.Set("x-api-key", tokenCountTestKey)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized status=%d body=%s", response.Code, response.Body)
	}
}

// TestNewTokenCountHandlerRejectsMissingAuthorizer 验证缺少鉴权时不创建 Handler。
func TestNewTokenCountHandlerRejectsMissingAuthorizer(t *testing.T) {
	t.Parallel()

	if _, err := anthropicmessagesapi.NewTokenCountHandler(
		anthropicmessagesapi.TokenCountDependencies{},
	); err == nil {
		t.Fatal("expected error for missing authorizer")
	}
	if _, err := anthropicmessagesapi.NewTokenCountHandler(
		anthropicmessagesapi.TokenCountDependencies{
			Authorizer:   tokenCountAuthorizer{},
			MaxBodyBytes: -1,
		},
	); err == nil {
		t.Fatal("expected error for invalid body limit")
	}
}

// tokenCountTestKey 是本文件独立使用的客户端密钥，避免与同包其它测试文件耦合。
const tokenCountTestKey = "synthetic-token-count-key"

// tokenCountAuthorizer 只接受测试使用的固定客户端密钥。
type tokenCountAuthorizer struct{}

func (tokenCountAuthorizer) Authorized(request *http.Request) bool {
	return request.Header.Get("x-api-key") == tokenCountTestKey
}

// newTestTokenCountHandler 创建使用默认上限的本地计数 Handler。
func newTestTokenCountHandler(t *testing.T) http.Handler {
	t.Helper()
	return newTestTokenCountHandlerWithLimit(t, 0)
}

// newTestTokenCountHandlerWithLimit 创建可控制请求体上限的本地计数 Handler。
func newTestTokenCountHandlerWithLimit(t *testing.T, limit int64) http.Handler {
	t.Helper()

	handler, err := anthropicmessagesapi.NewTokenCountHandler(
		anthropicmessagesapi.TokenCountDependencies{
			Authorizer:   tokenCountAuthorizer{},
			MaxBodyBytes: limit,
		},
	)
	if err != nil {
		t.Fatalf("anthropicmessagesapi.NewTokenCountHandler() error = %v", err)
	}
	return handler
}
