package webuiauth

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testKey = "0123456789abcdef0123456789abcdef"

func request(method, path, remote string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader("{}"))
	req.RemoteAddr = remote
	req.Host = "127.0.0.1:9527"
	return req
}

func TestAuthorize(t *testing.T) {
	cases := []struct {
		name       string
		request    *http.Request
		key        string
		wantOK     bool
		wantStatus int
	}{
		{name: "缺少配置", request: request(http.MethodGet, "/v0/webui/accounts", "127.0.0.1:1"), key: "", wantStatus: 503},
		{name: "缺少凭据", request: request(http.MethodGet, "/v0/webui/accounts", "127.0.0.1:1"), key: testKey, wantStatus: 401},
		{name: "错误凭据", request: withBearer(request(http.MethodGet, "/v0/webui/accounts", "127.0.0.1:1"), "nope"), key: testKey, wantStatus: 401},
		{name: "正确凭据", request: withBearer(request(http.MethodGet, "/v0/webui/accounts", "10.0.0.9:1"), testKey), key: testKey, wantOK: true},
		{name: "回环内部 ingress", request: request(http.MethodPost, "/v0/webui/session-events/provider-hook", "127.0.0.1:5555"), key: testKey, wantOK: true},
		{name: "内部 ingress 非回环", request: request(http.MethodPost, "/v0/webui/session-events/provider-hook", "10.0.0.9:1"), key: testKey, wantStatus: 401},
		{name: "内部 ingress 非 POST", request: request(http.MethodGet, "/v0/webui/session-events/provider-hook", "127.0.0.1:1"), key: testKey, wantStatus: 401},
		{name: "本机引导", request: request(http.MethodGet, "/v0/webui/control-plane/bootstrap", "127.0.0.1:1"), key: testKey, wantOK: true},
		{name: "引导带转发头", request: withHeader(request(http.MethodGet, "/v0/webui/control-plane/bootstrap", "127.0.0.1:1"), "X-Forwarded-For", "1.2.3.4"), key: testKey, wantStatus: 401},
		{name: "引导非本机 Host", request: func() *http.Request {
			req := request(http.MethodGet, "/v0/webui/control-plane/bootstrap", "127.0.0.1:1")
			req.Host = "aih.example.com"
			return req
		}(), key: testKey, wantStatus: 401},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			result := Authorize(testCase.request, testCase.key)
			if result.OK != testCase.wantOK {
				t.Fatalf("OK = %v，期望 %v（reason=%s）", result.OK, testCase.wantOK, result.Reason)
			}
			if !testCase.wantOK && result.StatusCode != testCase.wantStatus {
				t.Fatalf("状态码 = %d，期望 %d", result.StatusCode, testCase.wantStatus)
			}
		})
	}
}

func TestRequireManagementKeyInjectsBearerForLoopbackIngress(t *testing.T) {
	var seen string
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	})
	handler := RequireManagementKey(func() string { return testKey }, next)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request(http.MethodPost, "/v0/webui/session-events/provider-hook", "127.0.0.1:7777"))

	if response.Code != http.StatusNoContent {
		t.Fatalf("状态码 = %d", response.Code)
	}
	if seen != "Bearer "+testKey {
		t.Fatalf("下游 Authorization = %q", seen)
	}
}

func TestRequireManagementKeyRejectsWithStableJSON(t *testing.T) {
	handler := RequireManagementKey(func() string { return testKey }, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("下游不应被调用")
	}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request(http.MethodGet, "/v0/webui/accounts", "10.0.0.9:1"))

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("状态码 = %d", response.Code)
	}
	body, _ := io.ReadAll(response.Body)
	if !strings.Contains(string(body), `"webui_unauthorized"`) {
		t.Fatalf("响应体 = %s", body)
	}
}

func withBearer(req *http.Request, token string) *http.Request {
	req.Header.Set("Authorization", "Bearer "+token)
	return req
}

func withHeader(req *http.Request, name, value string) *http.Request {
	req.Header.Set(name, value)
	return req
}
