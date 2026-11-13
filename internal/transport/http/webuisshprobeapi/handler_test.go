package webuisshprobeapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"os"
	"path/filepath"
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

func TestProbeRejectsUnsupportedMethod(t *testing.T) {
	t.Parallel()
	handler := newTestHandler(t, Dependencies{Prober: &fakeProber{}})
	recorder := serve(handler, http.MethodPut, Path+"?connectionId=conn_1")
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


func postProbe(handler *Handler, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestProbePostInlineTargetAndDefaults(t *testing.T) {
	t.Parallel()
	prober := &fakeProber{result: sshremote.ProbeResult{Status: "reachable", Host: "10.0.0.9", Port: 22}}
	handler := newTestHandler(t, Dependencies{Prober: prober})
	recorder := postProbe(handler, `{"host":"10.0.0.9","user":"alice","authType":"password","password":"pw"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	if len(prober.calls) != 1 {
		t.Fatalf("calls = %d", len(prober.calls))
	}
	call := prober.calls[0]
	if call.config.Host != "10.0.0.9" || call.config.User != "alice" || call.config.Port != 22 || call.config.Password != "pw" {
		t.Fatalf("config = %#v", call.config)
	}
	if call.timeout != defaultPostTimeoutMs*time.Millisecond {
		t.Fatalf("timeout = %v, want %v", call.timeout, defaultPostTimeoutMs*time.Millisecond)
	}
}

func TestProbePostSavedConnectionUsesAuthoritativeDBAndEgressJump(t *testing.T) {
	t.Parallel()
	prober := &fakeProber{result: sshremote.ProbeResult{Status: "reachable"}}
	connectionsJSON := `[
		{"id":"conn_jump","host":"jump.example.com","port":22,"user":"bastion","authType":"agent"},
		{"id":"conn_target","host":"10.0.0.5","port":2222,"user":"dev","authType":"password","password":"real","egressConnectionId":"conn_jump"}
	]`
	handler := newTestHandler(t, Dependencies{
		Connections: &fakeConnections{raw: connectionsJSON, found: true},
		Prober:      prober,
	})
	// Client tries overriding host/password alongside connectionId; saved record must win.
	recorder := postProbe(handler, `{"connectionId":"conn_target","host":"evil.example.com","password":"wrong","timeoutMs":8000}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	call := prober.calls[0]
	if call.config.Host != "10.0.0.5" || call.config.Password != "real" || call.config.Jump == nil || call.config.Jump.Host != "jump.example.com" {
		t.Fatalf("config = %#v", call.config)
	}
	if call.timeout != 8000*time.Millisecond {
		t.Fatalf("timeout = %v", call.timeout)
	}
}

func TestProbePostValidationErrorsAndIdentityCheck(t *testing.T) {
	t.Parallel()
	homeDir := t.TempDir()
	outsideKey := filepath.Join(homeDir, "outside")
	if err := os.WriteFile(outsideKey, []byte("KEY"), 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}
	prober := &fakeProber{}
	cyclicJSON := `[
		{"id":"conn_a","host":"a","egressConnectionId":"conn_b"},
		{"id":"conn_b","host":"b","egressConnectionId":"conn_a"}
	]`
	handler := newTestHandler(t, Dependencies{
		Connections: &fakeConnections{raw: cyclicJSON, found: true},
		HostHomeDir: homeDir,
		Prober:      prober,
	})

	rec := postProbe(handler, `{}`)
	if rec.Code != http.StatusBadRequest || decodeError(t, rec)["error"] != "missing_host" {
		t.Fatalf("empty body = %d %s", rec.Code, rec.Body.String())
	}

	rec = postProbe(handler, `{"connectionId":"conn_missing"}`)
	if rec.Code != http.StatusNotFound || decodeError(t, rec)["error"] != "not_found" {
		t.Fatalf("missing conn = %d %s", rec.Code, rec.Body.String())
	}

	rec = postProbe(handler, `{"connectionId":"conn_a"}`)
	if rec.Code != http.StatusConflict || decodeError(t, rec)["error"] != "egress_connection_invalid" {
		t.Fatalf("cycle egress = %d %s", rec.Code, rec.Body.String())
	}

	rec = postProbe(handler, `{"host":"10.0.0.1","authType":"key-file","identityFile":"`+filepath.ToSlash(outsideKey)+`"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("identity error status = %d body = %s", rec.Code, rec.Body.String())
	}
	errBody := decodeError(t, rec)
	if errBody["error"] != "invalid_identity_file" || errBody["reason"] != "identity_file_outside_ssh_dir" {
		t.Fatalf("identity err = %#v", errBody)
	}
	if len(prober.calls) != 0 {
		t.Fatalf("prober should not have been called: %d", len(prober.calls))
	}
}
