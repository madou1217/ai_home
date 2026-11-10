package webuicontrolplanebootstrapapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	_ "modernc.org/sqlite"
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

// reportingAuthorizer 额外实现 KeyConfiguredReporter，模拟已接线 Management Key 的宿主。
type reportingAuthorizer struct {
	allowed    bool
	configured bool
}

func (fake reportingAuthorizer) Authorized(*http.Request) bool { return fake.allowed }
func (fake reportingAuthorizer) ManagementKeyConfigured() bool { return fake.configured }

func newTestHandler(t *testing.T, authorizer Authorizer, aiHomeDir string, publicBaseURL func(*http.Request) string) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{Authorizer: authorizer, AIHomeDir: aiHomeDir, PublicBaseURL: publicBaseURL})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func newRequest(t *testing.T, method string, localPort int) *http.Request {
	t.Helper()
	request := httptest.NewRequest(method, Path, nil)
	if localPort > 0 {
		address := &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: localPort}
		request = request.WithContext(context.WithValue(request.Context(), http.LocalAddrContextKey, address))
	}
	return request
}

func serve(t *testing.T, handler http.Handler, request *http.Request) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	var payload map[string]any
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode %q: %v", recorder.Body.String(), err)
		}
	}
	return recorder, payload
}

// seedHome 建一个只有 app_kv 表的临时 app-state.db，模拟从未保存过 profile 的本机。
func seedHome(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(directory, appstate.DatabaseFileName))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec("CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)"); err != nil {
		t.Fatalf("schema: %v", err)
	}
	return directory
}

func seedProfiles(t *testing.T, directory string, payload string) {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(directory, appstate.DatabaseFileName))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec("INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, 0)", profilesKey, payload); err != nil {
		t.Fatalf("seed profiles: %v", err)
	}
}

func seedLocalProfileWithKey(t *testing.T, directory string, key string) {
	t.Helper()
	seedProfiles(t, directory, `{"version":2,"activeProfileId":"local","profiles":[{
		"id":"local","name":"本机网关","endpoint":"http://127.0.0.1:9527","state":"offline",
		"managementKey":"`+key+`","accountCount":42,"updatedAt":1700000000000
	}]}`)
}

func fixedBase(value string) func(*http.Request) string {
	return func(*http.Request) string { return value }
}

func TestNewHandlerRejectsMissingDependencies(t *testing.T) {
	if _, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{allowed: true}}); err == nil {
		t.Fatal("缺少 AIHomeDir 应失败")
	}
	if _, err := NewHandler(Dependencies{AIHomeDir: t.TempDir()}); err == nil {
		t.Fatal("缺少 Authorizer 应失败")
	}
}

func TestBootstrapRequiresAuthorization(t *testing.T) {
	handler := newTestHandler(t, fakeAuthorizer{}, seedHome(t), fixedBase("http://127.0.0.1:9527"))
	recorder, payload := serve(t, handler, newRequest(t, http.MethodGet, 0))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	if payload["ok"] != false || payload["error"] != "unauthorized" {
		t.Fatalf("payload = %#v", payload)
	}
	if recorder.Header().Get("WWW-Authenticate") != "Bearer" {
		t.Fatalf("缺少 WWW-Authenticate: %#v", recorder.Header())
	}
}

func TestBootstrapRejectsNonGet(t *testing.T) {
	handler := newTestHandler(t, reportingAuthorizer{allowed: true, configured: true}, seedHome(t), fixedBase("http://127.0.0.1:9527"))
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		recorder, payload := serve(t, handler, newRequest(t, method, 0))
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s status = %d", method, recorder.Code)
		}
		if recorder.Header().Get("Allow") != http.MethodGet {
			t.Fatalf("%s Allow = %q", method, recorder.Header().Get("Allow"))
		}
		if payload["error"] != "method_not_allowed" {
			t.Fatalf("%s payload = %#v", method, payload)
		}
	}
}

func TestBootstrapWithoutManagementKey(t *testing.T) {
	handler := newTestHandler(t, reportingAuthorizer{allowed: true}, seedHome(t), fixedBase("http://127.0.0.1:9527"))
	recorder, payload := serve(t, handler, newRequest(t, http.MethodGet, 0))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	if payload["ok"] != false || payload["error"] != "management_key_not_configured" {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestBootstrapConfiguredLocalProfile(t *testing.T) {
	handler := newTestHandler(t, reportingAuthorizer{allowed: true, configured: true}, seedHome(t), fixedBase("http://127.0.0.1:9527"))
	recorder, payload := serve(t, handler, newRequest(t, http.MethodGet, 0))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	if payload["ok"] != true || payload["managementKeyConfigured"] != true {
		t.Fatalf("payload = %#v", payload)
	}
	if payload["managementKeySource"] != managementKeySourceServer {
		t.Fatalf("managementKeySource = %#v", payload["managementKeySource"])
	}
	profile := payload["profile"].(map[string]any)
	if profile["id"] != "local" || profile["name"] != "local" {
		t.Fatalf("profile = %#v", profile)
	}
	if profile["endpoint"] != "http://127.0.0.1:9527" || profile["state"] != "ready" {
		t.Fatalf("profile = %#v", profile)
	}
	if _, exists := profile["managementKey"]; exists {
		t.Fatalf("不得回传 managementKey: %#v", profile)
	}
	if payload["activeProfileId"] != "local" {
		t.Fatalf("activeProfileId = %#v", payload["activeProfileId"])
	}
	hints := payload["endpoints"].([]any)
	if len(hints) != 1 || hints[0].(map[string]any)["source"] != "request" {
		t.Fatalf("endpoints = %#v", hints)
	}
	if warnings := payload["warnings"].([]any); len(warnings) != 1 {
		t.Fatalf("warnings = %#v", warnings)
	}
}

func TestBootstrapReusesStoredProfileWithoutLeakingKey(t *testing.T) {
	directory := seedHome(t)
	seedLocalProfileWithKey(t, directory, "old-key")
	handler := newTestHandler(t, reportingAuthorizer{allowed: true, configured: true}, directory, fixedBase("http://127.0.0.1:9527"))
	recorder, payload := serve(t, handler, newRequest(t, http.MethodGet, 0))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	profile := payload["profile"].(map[string]any)
	if profile["name"] != "本机网关" || profile["accountCount"] != float64(42) {
		t.Fatalf("profile 未沿用已存字段: %#v", profile)
	}
	if profile["state"] != "ready" {
		t.Fatalf("state = %#v", profile["state"])
	}
	if strings.Contains(recorder.Body.String(), "old-key") {
		t.Fatalf("响应体泄漏了已存 managementKey: %s", recorder.Body.String())
	}
}

// newRevealingHandler 只接 RevealManagementKey 这一个策略，其余依赖固定为已鉴权、已配置。
func newRevealingHandler(t *testing.T, aiHomeDir string, reveal func(*http.Request) bool) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer:          reportingAuthorizer{allowed: true, configured: true},
		AIHomeDir:           aiHomeDir,
		PublicBaseURL:       fixedBase("http://127.0.0.1:9527"),
		RevealManagementKey: reveal,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func TestBootstrapRevealsManagementKeyWhenAllowed(t *testing.T) {
	directory := seedHome(t)
	seedLocalProfileWithKey(t, directory, "stored-key-1234")
	handler := newRevealingHandler(t, directory, func(*http.Request) bool { return true })
	recorder, payload := serve(t, handler, newRequest(t, http.MethodGet, 0))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	profile := payload["profile"].(map[string]any)
	if profile["managementKey"] != "stored-key-1234" {
		t.Fatalf("managementKey = %#v", profile["managementKey"])
	}
	if payload["managementKeyConfigured"] != true {
		t.Fatalf("managementKeyConfigured = %#v", payload["managementKeyConfigured"])
	}
}

func TestBootstrapHidesManagementKeyWhenDenied(t *testing.T) {
	directory := seedHome(t)
	seedLocalProfileWithKey(t, directory, "stored-key-1234")
	handler := newRevealingHandler(t, directory, func(*http.Request) bool { return false })
	recorder, payload := serve(t, handler, newRequest(t, http.MethodGet, 0))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	profile := payload["profile"].(map[string]any)
	if _, exists := profile["managementKey"]; exists {
		t.Fatalf("策略拒绝时不得回传 managementKey: %#v", profile)
	}
	if strings.Contains(recorder.Body.String(), "stored-key-1234") {
		t.Fatalf("响应体出现 Key 明文: %s", recorder.Body.String())
	}
}

func TestBootstrapEndpointFollowsLoopbackHost(t *testing.T) {
	handler := newTestHandler(t, reportingAuthorizer{allowed: true, configured: true}, seedHome(t), fixedBase("http://localhost:19527"))
	_, payload := serve(t, handler, newRequest(t, http.MethodGet, 0))
	profile := payload["profile"].(map[string]any)
	if profile["endpoint"] != "http://localhost:19527" {
		t.Fatalf("endpoint = %#v", profile["endpoint"])
	}
	if hints := payload["endpoints"].([]any); len(hints) != 1 {
		t.Fatalf("loopback 请求不应重复给回环候选: %#v", hints)
	}
}

func TestBootstrapEndpointFallsBackToLoopbackPort(t *testing.T) {
	handler := newTestHandler(t, reportingAuthorizer{allowed: true, configured: true}, seedHome(t), fixedBase("http://192.168.1.9"))
	_, payload := serve(t, handler, newRequest(t, http.MethodGet, 10527))
	profile := payload["profile"].(map[string]any)
	if profile["endpoint"] != "http://127.0.0.1:10527" {
		t.Fatalf("endpoint = %#v", profile["endpoint"])
	}
	hints := payload["endpoints"].([]any)
	if len(hints) != 2 {
		t.Fatalf("endpoints = %#v", hints)
	}
	first := hints[0].(map[string]any)
	if first["endpoint"] != "http://192.168.1.9" || first["recommended"] != true {
		t.Fatalf("首选提示 = %#v", first)
	}
	second := hints[1].(map[string]any)
	if second["endpoint"] != "http://127.0.0.1:10527" || second["source"] != "loopback" {
		t.Fatalf("回环提示 = %#v", second)
	}
	if warnings := payload["warnings"].([]any); len(warnings) != 0 {
		t.Fatalf("warnings = %#v", warnings)
	}
}

func TestIsLoopbackHostName(t *testing.T) {
	cases := map[string]bool{
		"localhost":         true,
		"localhost:19527":   true,
		"127.0.0.1":         true,
		"127.0.0.1:9527":    true,
		"::1":               true,
		"[::1]":             true,
		"[::1]:9527":        true,
		"LOCALHOST:9527":    true,
		"":                  false,
		"192.168.1.9:9527":  false,
		"control.example.c": false,
		"127.0.0.2":         false,
	}
	for host, want := range cases {
		if got := isLoopbackHostName(host); got != want {
			t.Fatalf("isLoopbackHostName(%q) = %v, want %v", host, got, want)
		}
	}
}

func TestBootstrapReadsEndpointPortFromRequestHost(t *testing.T) {
	handler := newTestHandler(t, reportingAuthorizer{allowed: true, configured: true}, seedHome(t), nil)
	request := newRequest(t, http.MethodGet, 0)
	request.Host = "127.0.0.1:10600"
	_, payload := serve(t, handler, request)
	profile := payload["profile"].(map[string]any)
	if profile["endpoint"] != "http://127.0.0.1:10600" {
		t.Fatalf("endpoint = %#v", profile["endpoint"])
	}
}
