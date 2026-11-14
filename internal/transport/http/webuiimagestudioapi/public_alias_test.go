package webuiimagestudioapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type stubAliasAuthorizer struct {
	allowed bool
	calls   int
}

func (stub *stubAliasAuthorizer) Authorized(*http.Request) bool {
	stub.calls++
	return stub.allowed
}

// TestPublicAliasRewritesPrefixAndKeepsRequest 验证浏览器前缀被改写成管理前缀，
// 方法、查询串与请求体原样保留。
func TestPublicAliasRewritesPrefixAndKeepsRequest(t *testing.T) {
	var seen struct {
		path   string
		raw    string
		method string
		query  string
		body   string
	}
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		seen.path = r.URL.Path
		seen.raw = r.URL.RawQuery
		seen.method = r.Method
		seen.query = r.URL.RawQuery
		seen.body = string(body)
		w.WriteHeader(http.StatusNoContent)
	})
	handler := NewPublicAlias(inner)
	request := httptest.NewRequest(
		http.MethodPatch,
		PublicPath+"/sessions/abc?x=1&y=2",
		strings.NewReader(`{"title":"x"}`),
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("状态码 = %d", response.Code)
	}
	if seen.path != Path+"/sessions/abc" {
		t.Fatalf("改写后路径 = %q", seen.path)
	}
	if seen.method != http.MethodPatch {
		t.Fatalf("方法 = %q", seen.method)
	}
	if seen.query != "x=1&y=2" {
		t.Fatalf("查询串 = %q", seen.query)
	}
	if seen.body != `{"title":"x"}` {
		t.Fatalf("请求体 = %q", seen.body)
	}
}

// TestPublicAliasKeepsManagementKeyGate 证明公开前缀没有绕过鉴权：
// 未带 Bearer 仍然 401，且内部处理器不会被调用。
func TestPublicAliasKeepsManagementKeyGate(t *testing.T) {
	authorizer := &stubAliasAuthorizer{allowed: false}
	handler, err := NewHandler(Dependencies{Authorizer: authorizer})
	if err != nil {
		t.Fatalf("构造处理器失败: %v", err)
	}
	public := NewPublicAlias(handler)

	request := httptest.NewRequest(http.MethodGet, PublicPath+"/models", nil)
	response := httptest.NewRecorder()
	public.ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("状态码 = %d，期望 401", response.Code)
	}
	if authorizer.calls != 1 {
		t.Fatalf("鉴权调用次数 = %d，期望 1", authorizer.calls)
	}
}

// TestPublicAliasWithoutHandlerReturns503 装配缺失时给出稳定 503，而不是 panic。
func TestPublicAliasWithoutHandlerReturns503(t *testing.T) {
	response := httptest.NewRecorder()
	NewPublicAlias(nil).ServeHTTP(response, httptest.NewRequest(http.MethodGet, PublicPath+"/models", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("状态码 = %d，期望 503", response.Code)
	}
}
