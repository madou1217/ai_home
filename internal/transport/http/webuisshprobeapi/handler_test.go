package webuisshprobeapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/sshremote"
)

const testConnectionsJSON = `[
  {"id":"conn_1","label":"prod","host":"10.0.0.1","port":2222,"user":"deploy","authType":"password","password":"s3cret","identityFile":""},
  {"id":"conn_2","label":"stage","host":"10.0.0.2"}
]`

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

type fakeConnections struct {
	raw   string
	found bool
	err   error
	reads int
}

func (fake *fakeConnections) ReadConnections(context.Context) (string, bool, error) {
	fake.reads++
	return fake.raw, fake.found, fake.err
}

type proberCall struct {
	config  sshremote.Config
	timeout time.Duration
}

type fakeProber struct {
	result sshremote.ProbeResult
	err    error
	calls  []proberCall
}

func (prober *fakeProber) Probe(_ context.Context, config sshremote.Config, timeout time.Duration) (sshremote.ProbeResult, error) {
	prober.calls = append(prober.calls, proberCall{config: config, timeout: timeout})
	return prober.result, prober.err
}

func newTestHandler(t *testing.T, dependencies Dependencies) *Handler {
	t.Helper()
	if dependencies.Authorizer == nil {
		dependencies.Authorizer = fakeAuthorizer{allowed: true}
	}
	if dependencies.Connections == nil {
		dependencies.Connections = &fakeConnections{raw: testConnectionsJSON, found: true}
	}
	handler, err := NewHandler(dependencies)
	if err != nil {
		t.Fatalf("创建 Handler 失败: %v", err)
	}
	return handler
}

func serve(handler *Handler, method, target string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func decodeError(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("响应不是 JSON: %v (%s)", err, recorder.Body.String())
	}
	return payload
}

func TestProbeRequiresManagementKey(t *testing.T) {
	t.Parallel()
	handler := newTestHandler(t, Dependencies{
		Authorizer: fakeAuthorizer{allowed: false},
		Prober:     &fakeProber{},
	})
	recorder := serve(handler, http.MethodGet, Path+"?connectionId=conn_1")
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("状态 = %d, want 401", recorder.Code)
	}
	if decodeError(t, recorder)["error"] != "unauthorized" {
		t.Fatalf("响应 = %s", recorder.Body.String())
	}
}

func TestProbeRejectsNonGet(t *testing.T) {
	t.Parallel()
	handler := newTestHandler(t, Dependencies{Prober: &fakeProber{}})
	recorder := serve(handler, http.MethodPost, Path+"?connectionId=conn_1")
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("状态 = %d, want 405", recorder.Code)
	}
}

func TestProbeRequiresConnectionID(t *testing.T) {
	t.Parallel()
	handler := newTestHandler(t, Dependencies{Prober: &fakeProber{}})
	recorder := serve(handler, http.MethodGet, Path)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("状态 = %d, want 400", recorder.Code)
	}
	if decodeError(t, recorder)["error"] != "missing_connection" {
		t.Fatalf("响应 = %s", recorder.Body.String())
	}
}

func TestProbeUnknownConnection(t *testing.T) {
	t.Parallel()
	handler := newTestHandler(t, Dependencies{Prober: &fakeProber{}})
	recorder := serve(handler, http.MethodGet, Path+"?connectionId=conn_missing")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("状态 = %d, want 404", recorder.Code)
	}
}

func TestProbeUnavailableWithoutTransport(t *testing.T) {
	t.Parallel()
	handler := newTestHandler(t, Dependencies{})
	recorder := serve(handler, http.MethodGet, Path+"?connectionId=conn_1")
	if recorder.Code != http.StatusNotImplemented {
		t.Fatalf("状态 = %d, want 501", recorder.Code)
	}
}

func TestProbeExpandsSavedConnection(t *testing.T) {
	t.Parallel()
	prober := &fakeProber{result: sshremote.ProbeResult{
		Kind: "ssh", Host: "10.0.0.1", User: "deploy", Port: 2222,
		Status: "reachable", Platform: "Linux", Arch: "x86_64",
		Commands: map[string]bool{"node": true},
	}}
	handler := newTestHandler(t, Dependencies{Prober: prober})
	recorder := serve(handler, http.MethodGet, Path+"?connectionId=conn_1&timeoutMs=2500")
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态 = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if len(prober.calls) != 1 {
		t.Fatalf("Probe 调用次数 = %d", len(prober.calls))
	}
	call := prober.calls[0]
	if call.config.Host != "10.0.0.1" || call.config.Port != 2222 ||
		call.config.User != "deploy" || call.config.AuthType != "password" ||
		call.config.Password != "s3cret" {
		t.Fatalf("连接展开 = %#v", call.config)
	}
	if call.timeout != 2500*time.Millisecond {
		t.Fatalf("timeout = %v", call.timeout)
	}

	var payload struct {
		OK     bool                  `json:"ok"`
		Result sshremote.ProbeResult `json:"result"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if !payload.OK || payload.Result.Status != "reachable" || payload.Result.Port != 2222 {
		t.Fatalf("响应 = %#v", payload)
	}
}

func TestProbeDefaultsPortAndTimeout(t *testing.T) {
	t.Parallel()
	prober := &fakeProber{result: sshremote.ProbeResult{Status: "unreachable"}}
	handler := newTestHandler(t, Dependencies{Prober: prober})
	recorder := serve(handler, http.MethodGet, Path+"?connectionId=conn_2&timeoutMs=nonsense")
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态 = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	call := prober.calls[0]
	if call.config.Port != 22 {
		t.Fatalf("默认端口 = %d, want 22", call.config.Port)
	}
	if call.timeout != defaultTimeoutMs*time.Millisecond {
		t.Fatalf("默认超时 = %v", call.timeout)
	}
}

func TestProbeClampsTimeout(t *testing.T) {
	t.Parallel()
	prober := &fakeProber{result: sshremote.ProbeResult{Status: "unreachable"}}
	handler := newTestHandler(t, Dependencies{Prober: prober})
	recorder := serve(handler, http.MethodGet, Path+"?connectionId=conn_2&timeoutMs=999999")
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态 = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if got := prober.calls[0].timeout; got != maxTimeoutMs*time.Millisecond {
		t.Fatalf("超时上限 = %v", got)
	}
}

func TestProbeInvalidConnectionsJSON(t *testing.T) {
	t.Parallel()
	handler := newTestHandler(t, Dependencies{
		Connections: &fakeConnections{raw: "not json", found: true},
		Prober:      &fakeProber{},
	})
	recorder := serve(handler, http.MethodGet, Path+"?connectionId=conn_1")
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("状态 = %d, want 500", recorder.Code)
	}
	if !strings.Contains(decodeError(t, recorder)["error"].(string), "invalid") {
		t.Fatalf("响应 = %s", recorder.Body.String())
	}
}
