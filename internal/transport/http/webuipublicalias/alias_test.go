package webuipublicalias

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestRewriteReplacesPrefixOnly 只替换前缀，其余路径段、查询串与方法保持原样。
func TestRewriteReplacesPrefixOnly(t *testing.T) {
	var seen struct {
		path   string
		query  string
		method string
		body   string
	}
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		seen.path = r.URL.Path
		seen.query = r.URL.RawQuery
		seen.method = r.Method
		seen.body = string(body)
		w.WriteHeader(http.StatusCreated)
	})
	handler := Rewrite("/v0/webui/translation", "/v1/management/webui/translation", inner)
	request := httptest.NewRequest(
		http.MethodPost,
		"/v0/webui/translation/stream?lang=en",
		strings.NewReader("payload"),
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusCreated {
		t.Fatalf("状态码 = %d", response.Code)
	}
	if seen.path != "/v1/management/webui/translation/stream" {
		t.Fatalf("路径 = %q", seen.path)
	}
	if seen.query != "lang=en" || seen.method != http.MethodPost || seen.body != "payload" {
		t.Fatalf("请求形状被改动: %+v", seen)
	}
}

// TestRewriteLeavesUnknownPathsUntouched 非前缀路径不猜测语义，交给目标处理器 404。
func TestRewriteLeavesUnknownPathsUntouched(t *testing.T) {
	var seenPath string
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		w.WriteHeader(http.StatusNotFound)
	})
	handler := Rewrite("/v0/webui/translation", "/v1/management/webui/translation", inner)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v0/webui/other", nil))
	if seenPath != "/v0/webui/other" {
		t.Fatalf("未匹配前缀时路径被改写: %q", seenPath)
	}
}

// TestRewriteNilHandlerReturns404 装配缺失时给出标准 404，而不是 panic。
func TestRewriteNilHandlerReturns404(t *testing.T) {
	response := httptest.NewRecorder()
	Rewrite("/v0/webui/x", "/v1/x", nil).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v0/webui/x", nil))
	if response.Code != http.StatusNotFound {
		t.Fatalf("状态码 = %d", response.Code)
	}
}
