package plugincontrolapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/plugincontrol"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

type stubAuthorizer struct{ allowed bool }

func (authorizer stubAuthorizer) Authorized(*http.Request) bool { return authorizer.allowed }

type stubInstaller struct {
	installResult   plugincontrol.InstallResult
	installErr      error
	uninstallResult plugincontrol.UninstallResult
	uninstallErr    error
	installCalls    int
	uninstallCalls  int
	lastFile        string
	lastOptions     plugincontrol.AcceptOptions
	lastInput       plugincontrol.UninstallInput
}

func (installer *stubInstaller) Install(_ context.Context, file string, options plugincontrol.AcceptOptions) (plugincontrol.InstallResult, error) {
	installer.installCalls++
	installer.lastFile = file
	installer.lastOptions = options
	return installer.installResult, installer.installErr
}

func (installer *stubInstaller) Uninstall(_ context.Context, input plugincontrol.UninstallInput) (plugincontrol.UninstallResult, error) {
	installer.uninstallCalls++
	installer.lastInput = input
	return installer.uninstallResult, installer.uninstallErr
}

func newTestHandler(t *testing.T, installer Installer, allowed bool) *Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{Authorizer: stubAuthorizer{allowed: allowed}, Installer: installer})
	if err != nil {
		t.Fatalf("创建 handler 失败: %v", err)
	}
	return handler
}

func perform(t *testing.T, handler *Handler, method string, path string, body string) (int, map[string]any) {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, path, reader)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	var payload map[string]any
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatalf("响应不是 JSON: %s (%v)", recorder.Body.String(), err)
		}
	}
	return recorder.Code, payload
}

func TestInstallSuccessResponseShape(t *testing.T) {
	signedAt := "2026-01-01T00:00:00.000Z"
	installer := &stubInstaller{installResult: plugincontrol.InstallResult{
		PluginID:    "aih.test.echo",
		Version:     "1.0.0",
		Digest:      "abc",
		Revision:    3,
		Signature:   plugincontrol.Signature{Status: "signed", KeyID: "k1", SignedAt: &signedAt},
		Permissions: json.RawMessage("{\"network\":[\"https://api.example.com\"]}"),
	}}
	handler := newTestHandler(t, installer, true)
	status, payload := perform(t, handler, http.MethodPost, InstallPath,
		`{"file":"/tmp/plugin.aih-plugin","requireSigned":true}`)
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if payload["ok"] != true || payload["pluginId"] != "aih.test.echo" || payload["version"] != "1.0.0" ||
		payload["digest"] != "abc" || payload["revision"] != float64(3) {
		t.Fatalf("响应字段不符: %+v", payload)
	}
	signature := payload["signature"].(map[string]any)
	if signature["status"] != "signed" || signature["keyId"] != "k1" || signature["signedAt"] != signedAt {
		t.Fatalf("签名响应不符: %+v", signature)
	}
	permissions := payload["permissions"].(map[string]any)
	if len(permissions["network"].([]any)) != 1 {
		t.Fatalf("权限响应不符: %+v", permissions)
	}
	if installer.lastFile != "/tmp/plugin.aih-plugin" || installer.lastOptions.RequireSigned != true {
		t.Fatalf("安装入参不符: %q %+v", installer.lastFile, installer.lastOptions)
	}
	if installer.lastOptions.HostVersion != "1.0.0" {
		t.Fatalf("缺省 hostVersion 不符: %s", installer.lastOptions.HostVersion)
	}
}

func TestInstallForwardsHostHeaders(t *testing.T) {
	installer := &stubInstaller{installResult: plugincontrol.InstallResult{PluginID: "p", Version: "1.0.0"}}
	handler := newTestHandler(t, installer, true)
	request := httptest.NewRequest(http.MethodPost, InstallPath, strings.NewReader(`{"file":"/tmp/x"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(HostVersionHeader, "1.2.3")
	request.Header.Set(NodeVersionHeader, "22.14.0")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	if installer.lastOptions.HostVersion != "1.2.3" || installer.lastOptions.NodeVersion != "22.14.0" {
		t.Fatalf("宿主事实未透传: %+v", installer.lastOptions)
	}
}

func TestUninstallSuccessShape(t *testing.T) {
	installer := &stubInstaller{uninstallResult: plugincontrol.UninstallResult{PluginID: "p", Version: "1.0.0", Revision: 4}}
	handler := newTestHandler(t, installer, true)
	status, payload := perform(t, handler, http.MethodPost, UninstallPath,
		`{"pluginId":"p","version":"1.0.0","expectedRevision":3}`)
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if payload["ok"] != true || payload["pluginId"] != "p" || payload["version"] != "1.0.0" || payload["revision"] != float64(4) {
		t.Fatalf("响应字段不符: %+v", payload)
	}
	if installer.lastInput.ExpectedRevision == nil || *installer.lastInput.ExpectedRevision != 3 {
		t.Fatalf("expectedRevision 未解析: %+v", installer.lastInput)
	}
}

func TestUninstallExpectedRevisionSemantics(t *testing.T) {
	cases := []struct {
		body     string
		expected *int64
		invalid  bool
	}{
		{body: `{"pluginId":"p"}`, expected: nil},
		{body: `{"pluginId":"p","expectedRevision":0}`, expected: int64Ptr(0)},
		{body: `{"pluginId":"p","expectedRevision":null}`, expected: int64Ptr(0)},
		{body: `{"pluginId":"p","expectedRevision":"2"}`, expected: int64Ptr(2)},
		{body: `{"pluginId":"p","expectedRevision":2.5}`, invalid: true},
		{body: `{"pluginId":"p","expectedRevision":"abc"}`, invalid: true},
		{body: `{"pluginId":"p","expectedRevision":{}}`, invalid: true},
	}
	for _, testCase := range cases {
		installer := &stubInstaller{uninstallResult: plugincontrol.UninstallResult{PluginID: "p", Version: "1.0.0"}}
		handler := newTestHandler(t, installer, true)
		status, payload := perform(t, handler, http.MethodPost, UninstallPath, testCase.body)
		if testCase.invalid {
			if status != http.StatusConflict || payload["error"] != plugincontrol.CodeRevisionConflict {
				t.Fatalf("非法 expectedRevision 应 409: %d %+v", status, payload)
			}
			if installer.uninstallCalls != 0 {
				t.Fatalf("非法 expectedRevision 不应进入写路径")
			}
			continue
		}
		if status != http.StatusOK {
			t.Fatalf("status = %d (%+v)", status, payload)
		}
		if testCase.expected == nil {
			if installer.lastInput.ExpectedRevision != nil {
				t.Fatalf("缺省 expectedRevision 应为 nil: %+v", installer.lastInput.ExpectedRevision)
			}
		} else if installer.lastInput.ExpectedRevision == nil || *installer.lastInput.ExpectedRevision != *testCase.expected {
			t.Fatalf("expectedRevision = %v, want %v", installer.lastInput.ExpectedRevision, *testCase.expected)
		}
	}
}

func int64Ptr(value int64) *int64 { return &value }

func TestErrorStatusMapping(t *testing.T) {
	cases := []struct {
		code   string
		status int
	}{
		{plugincontrol.CodeNotInstalled, http.StatusNotFound},
		{plugincontrol.CodeVersionConflict, http.StatusConflict},
		{plugincontrol.CodeInUse, http.StatusConflict},
		{plugincontrol.CodeRevisionConflict, http.StatusConflict},
		{"account_maintenance_busy", http.StatusServiceUnavailable},
		{"account_maintenance_in_progress", http.StatusServiceUnavailable},
		{plugincontrol.CodeStateUnavailable, http.StatusServiceUnavailable},
		{plugincontrol.CodeStateInvalid, http.StatusBadRequest},
	}
	for _, testCase := range cases {
		installer := &stubInstaller{installErr: pluginerr.New(testCase.code, "detail")}
		handler := newTestHandler(t, installer, true)
		status, payload := perform(t, handler, http.MethodPost, InstallPath, `{"file":"/tmp/x"}`)
		if status != testCase.status {
			t.Fatalf("%s status = %d, want %d", testCase.code, status, testCase.status)
		}
		if payload["ok"] != false || payload["error"] != testCase.code || payload["message"] != "detail" {
			t.Fatalf("%s 响应不符: %+v", testCase.code, payload)
		}
		if _, present := payload["diagnostics"]; !present {
			t.Fatalf("%s 缺少 diagnostics 字段", testCase.code)
		}
	}
}

func TestAuthAndMethodGuards(t *testing.T) {
	installer := &stubInstaller{}
	handler := newTestHandler(t, installer, false)
	status, payload := perform(t, handler, http.MethodPost, InstallPath, `{"file":"/tmp/x"}`)
	if status != http.StatusUnauthorized || payload["error"] != "unauthorized" {
		t.Fatalf("未授权响应不符: %d %+v", status, payload)
	}
	if installer.installCalls != 0 {
		t.Fatal("未授权时不得调用安装器")
	}
	allowed := newTestHandler(t, installer, true)
	status, payload = perform(t, allowed, http.MethodGet, InstallPath, "")
	if status != http.StatusMethodNotAllowed || payload["error"] != "method_not_allowed" {
		t.Fatalf("方法错误响应不符: %d %+v", status, payload)
	}
}

func TestDecodeErrors(t *testing.T) {
	installer := &stubInstaller{}
	handler := newTestHandler(t, installer, true)
	status, payload := perform(t, handler, http.MethodPost, InstallPath, "{broken")
	if status != http.StatusBadRequest || payload["error"] != "plugin_request_invalid" {
		t.Fatalf("非法 JSON 响应不符: %d %+v", status, payload)
	}
	oversized := `{"file":"` + strings.Repeat("x", maxBodyBytes) + `"}`
	request := httptest.NewRequest(http.MethodPost, InstallPath, strings.NewReader(oversized))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	var response map[string]any
	_ = json.Unmarshal(recorder.Body.Bytes(), &response)
	if recorder.Code != http.StatusBadRequest || response["error"] != "plugin_request_too_large" {
		t.Fatalf("超大请求响应不符: %d %+v", recorder.Code, response)
	}
}

func TestNewHandlerRejectsMissingDependencies(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); err == nil {
		t.Fatal("缺依赖必须拒绝装配")
	}
	if _, err := NewHandler(Dependencies{Authorizer: stubAuthorizer{allowed: true}}); err == nil {
		t.Fatal("缺 Installer 必须拒绝装配")
	}
}

func TestInstallAndUninstallEmitAuditEvents(t *testing.T) {
	var events []struct {
		op      string
		details map[string]any
	}
	installer := &stubInstaller{
		installResult: plugincontrol.InstallResult{
			PluginID:    "demo.plugin",
			Version:     "1.2.3",
			Digest:      "sha256:abc",
			Revision:    4,
			Signature:   plugincontrol.Signature{Status: "signed", KeyID: "key-1"},
			Permissions: json.RawMessage(`{"capabilities":["observe"]}`),
		},
		uninstallResult: plugincontrol.UninstallResult{
			PluginID: "demo.plugin",
			Version:  "1.2.3",
			Revision: 5,
		},
	}
	handler, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allowed: true},
		Installer:  installer,
		OnAudit: func(op string, details map[string]any) {
			events = append(events, struct {
				op      string
				details map[string]any
			}{op: op, details: details})
		},
	})
	if err != nil {
		t.Fatalf("创建 handler 失败: %v", err)
	}

	status, _ := perform(t, handler, http.MethodPost, InstallPath, `{"file":"/tmp/demo.aih-plugin"}`)
	if status != http.StatusOK {
		t.Fatalf("install 状态码异常: %d", status)
	}
	status, _ = perform(t, handler, http.MethodPost, UninstallPath, `{"pluginId":"demo.plugin","version":"1.2.3"}`)
	if status != http.StatusOK {
		t.Fatalf("uninstall 状态码异常: %d", status)
	}
	if len(events) != 2 {
		t.Fatalf("期望 2 条审计事件，实际 %d", len(events))
	}
	if events[0].op != "install" || events[0].details["pluginId"] != "demo.plugin" || events[0].details["signature"] != "signed" || events[0].details["keyId"] != "key-1" {
		t.Fatalf("install 审计详情异常: %+v", events[0])
	}
	if events[1].op != "uninstall" || events[1].details["pluginId"] != "demo.plugin" || events[1].details["version"] != "1.2.3" {
		t.Fatalf("uninstall 审计详情异常: %+v", events[1])
	}
}
