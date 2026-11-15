package webuiauth

import (
	"encoding/json"
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
		{name: "内部 ingress 带转发头被拒", request: withHeader(request(http.MethodPost, "/v0/webui/session-events/provider-hook", "127.0.0.1:5555"), "X-Forwarded-For", "1.2.3.4"), key: testKey, wantStatus: 401},
		{name: "内部 ingress 带跨节点头被拒", request: withHeader(request(http.MethodPost, "/v0/webui/internal/approval-request", "127.0.0.1:5555"), "X-Aih-Server-Id", "cp-remote"), key: testKey, wantStatus: 401},
		{name: "内部 ingress 非 POST", request: request(http.MethodGet, "/v0/webui/session-events/provider-hook", "127.0.0.1:1"), key: testKey, wantStatus: 401},
		{name: "本机引导", request: request(http.MethodGet, "/v0/webui/control-plane/bootstrap", "127.0.0.1:1"), key: testKey, wantOK: true},
		{name: "引导带转发头", request: withHeader(request(http.MethodGet, "/v0/webui/control-plane/bootstrap", "127.0.0.1:1"), "X-Forwarded-For", "1.2.3.4"), key: testKey, wantStatus: 401},
		{name: "引导带 Cf-Connecting-Ip 被拒", request: withHeader(request(http.MethodGet, "/v0/webui/control-plane/bootstrap", "127.0.0.1:1"), "Cf-Connecting-Ip", "1.2.3.4"), key: testKey, wantStatus: 401},
		{name: "引导带 X-Aih-Server-Id 被拒", request: withHeader(request(http.MethodGet, "/v0/webui/control-plane/bootstrap", "127.0.0.1:1"), "X-Aih-Server-Id", "cp-1"), key: testKey, wantStatus: 401},
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

func TestRequireManagementKeyInjectsBearerAndContextViaForLoopbackIngress(t *testing.T) {
	var seenAuth, seenVia string
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth = r.Header.Get("Authorization")
		seenVia = ViaFromContext(r.Context())
		w.WriteHeader(http.StatusNoContent)
	})
	handler := RequireManagementKey(func() string { return testKey }, next)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request(http.MethodPost, "/v0/webui/session-events/provider-hook", "127.0.0.1:7777"))

	if response.Code != http.StatusNoContent {
		t.Fatalf("状态码 = %d", response.Code)
	}
	if seenAuth != "Bearer "+testKey {
		t.Fatalf("下游 Authorization = %q", seenAuth)
	}
	if seenVia != ViaInternalLoopback {
		t.Fatalf("下游 Via = %q，期望 %q", seenVia, ViaInternalLoopback)
	}
}

func TestRequireManagementKeyLoopbackBootstrapWhenKeyEmpty(t *testing.T) {
	var isBootstrap bool
	var seenAuth string
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		isBootstrap = IsLoopbackBootstrap(r)
		seenAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNotFound)
	})
	server := httptest.NewServer(RequireManagementKey(func() string { return "" }, next))
	defer server.Close()

	resp, err := server.Client().Get(server.URL + "/v0/webui/control-plane/bootstrap")
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("状态码 = %d，期望 404", resp.StatusCode)
	}
	if !isBootstrap {
		t.Fatal("IsLoopbackBootstrap 应为 true")
	}
	if seenAuth != "" {
		t.Fatalf("未配密钥时不应注入空 Bearer，实际 = %q", seenAuth)
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

func TestRequireManagementKeyOrLoopbackHTTPServer(t *testing.T) {
	currentKey := testKey
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":         true,
			"via":        ViaFromContext(r.Context()),
			"isLoopback": IsLoopbackManagement(r),
		})
	})
	server := httptest.NewServer(RequireManagementKeyOrLoopback(func() string { return currentKey }, next))
	defer server.Close()

	// 1. 已配置密钥但未带 Bearer：即使本机回环也必须返回 401 unauthorized_management（绝不抛 500）
	resp, err := server.Client().Get(server.URL + "/v0/management/status")
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	var errBody map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&errBody)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized || errBody["error"] != "unauthorized_management" {
		t.Fatalf("未带密钥应 401 unauthorized_management，实际 status=%d body=%#v", resp.StatusCode, errBody)
	}
	if resp.Header.Get("WWW-Authenticate") != "Bearer" {
		t.Fatalf("缺少 WWW-Authenticate: %v", resp.Header)
	}

	// 2. 已配置密钥且带正确 Bearer：返回 200
	reqOK, _ := http.NewRequest(http.MethodGet, server.URL+"/v0/management/status", nil)
	reqOK.Header.Set("Authorization", "Bearer "+testKey)
	respOK, err := server.Client().Do(reqOK)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	_ = respOK.Body.Close()
	if respOK.StatusCode != http.StatusOK {
		t.Fatalf("正确密钥应 200，实际 %d", respOK.StatusCode)
	}

	// 3. 未配置密钥且本机直连回环：放行并标记 IsLoopbackManagement
	currentKey = ""
	respLoop, err := server.Client().Get(server.URL + "/v0/management/status")
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	var okBody map[string]any
	_ = json.NewDecoder(respLoop.Body).Decode(&okBody)
	_ = respLoop.Body.Close()
	if respLoop.StatusCode != http.StatusOK || okBody["isLoopback"] != true {
		t.Fatalf("未配密钥本机直连应 200，实际 status=%d body=%#v", respLoop.StatusCode, okBody)
	}

	// 4. 未配置密钥但带 X-Forwarded-For（同机反代）：拒绝 503
	reqProxied, _ := http.NewRequest(http.MethodGet, server.URL+"/v0/management/status", nil)
	reqProxied.Header.Set("X-Forwarded-For", "203.0.113.5")
	respProxied, err := server.Client().Do(reqProxied)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	var proxiedBody map[string]any
	_ = json.NewDecoder(respProxied.Body).Decode(&proxiedBody)
	_ = respProxied.Body.Close()
	if respProxied.StatusCode != http.StatusServiceUnavailable || proxiedBody["error"] != "management_key_not_configured" {
		t.Fatalf("反代未配密钥应 503，实际 status=%d body=%#v", respProxied.StatusCode, proxiedBody)
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
