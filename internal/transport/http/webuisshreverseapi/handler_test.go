package webuisshreverseapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/runtime/sshtunnel"
)

type stubAuthorizer struct{ ok bool }

func (stub stubAuthorizer) Authorized(*http.Request) bool { return stub.ok }

type stubConnections struct {
	raw   string
	found bool
	err   error
}

func (stub stubConnections) ReadConnections(context.Context) (string, bool, error) {
	return stub.raw, stub.found, stub.err
}

type stubSupervisor struct {
	reconciled []byte
	status     []sshtunnel.Status
}

func (stub *stubSupervisor) Reconcile(raw []byte) error {
	stub.reconciled = append([]byte(nil), raw...)
	return nil
}
func (stub *stubSupervisor) Status() []sshtunnel.Status { return stub.status }

func TestGetStatusAndPostReconcile(t *testing.T) {
	supervisor := &stubSupervisor{status: []sshtunnel.Status{{ConnectionID: "c1", State: "open", RemotePort: 2222, LocalPort: 22}}}
	handler, err := NewHandler(Dependencies{
		Authorizer:  stubAuthorizer{ok: true},
		Connections: stubConnections{raw: `[{"id":"c1"}]`, found: true},
		Supervisor:  supervisor,
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != 200 || !strings.Contains(recorder.Body.String(), `"state":"open"`) {
		t.Fatalf("GET = %d %s", recorder.Code, recorder.Body.String())
	}
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, ReconcilePath, nil))
	if recorder.Code != 200 || string(supervisor.reconciled) != `[{"id":"c1"}]` {
		t.Fatalf("POST = %d %s raw=%s", recorder.Code, recorder.Body.String(), supervisor.reconciled)
	}
}

func TestUnauthorizedAndMissingDependencies(t *testing.T) {
	handler, err := NewHandler(Dependencies{Authorizer: stubAuthorizer{}, Connections: stubConnections{}, Supervisor: &stubSupervisor{}})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != 401 {
		t.Fatalf("status = %d", recorder.Code)
	}
	if _, err := NewHandler(Dependencies{}); err == nil {
		t.Fatal("missing deps should fail")
	}
}

func TestResponseIsJSON(t *testing.T) {
	handler, _ := NewHandler(Dependencies{Authorizer: stubAuthorizer{ok: true}, Connections: stubConnections{}, Supervisor: &stubSupervisor{}})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil || payload["ok"] != true {
		t.Fatalf("body = %s err=%v", recorder.Body.String(), err)
	}
}
