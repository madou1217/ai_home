package webuischeduledtasksapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/accountactivity"
	"github.com/madou1217/ai_home/internal/runtime/scheduledtasks"
)

type testAuthorizer struct{ allow bool }

func (a testAuthorizer) Authorized(_ *http.Request) bool { return a.allow }

func TestHandlerAuthAndLifecycle(t *testing.T) {
	var runs atomic.Int32
	svc, err := scheduledtasks.NewService(scheduledtasks.ServiceDependencies{
		AIHomeDir: t.TempDir(),
		Catalog:   accountactivity.BuiltinCatalog(),
		CustomRunner: func(_ context.Context, command string, _ string) scheduledtasks.EventResult {
			runs.Add(1)
			return scheduledtasks.EventResult{Status: "ok", Summary: command}
		},
	})
	if err != nil {
		t.Fatalf("NewService failed: %v", err)
	}

	unauth, _ := NewHandler(Dependencies{Authorizer: testAuthorizer{allow: false}, Service: svc})
	rec := httptest.NewRecorder()
	unauth.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, TasksPath, nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}

	h, err := NewHandler(Dependencies{Authorizer: testAuthorizer{allow: true}, Service: svc})
	if err != nil {
		t.Fatalf("NewHandler failed: %v", err)
	}

	// Preview invalid + valid
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, PreviewPath, bytes.NewBufferString(`{"schedule":{"kind":"daily","at":"08:30"}}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected preview 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	// Create task
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, TasksPath, bytes.NewBufferString(`{
		"name":"test-cmd",
		"eventId":"custom-command",
		"eventParams":{"command":"echo ok"},
		"schedule":{"kind":"daily","at":"08:30"}
	}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected upsert 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	var upsertResp struct {
		OK   bool                    `json:"ok"`
		Task scheduledtasks.TaskView `json:"task"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &upsertResp); err != nil || upsertResp.Task.ID == "" {
		t.Fatalf("unexpected upsert response: %s", rec.Body.String())
	}
	taskID := upsertResp.Task.ID

	// Trigger async run -> 202
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, ActionPrefix+taskID+"/run", nil))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected run 202, got %d body=%s", rec.Code, rec.Body.String())
	}
	deadline := time.Now().Add(2 * time.Second)
	for runs.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if runs.Load() != 1 {
		t.Fatalf("expected custom runner invoked once, got %d", runs.Load())
	}

	// Query records
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, RecordsPath+"?taskId="+taskID, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected records 200, got %d", rec.Code)
	}
	var recsResp struct {
		OK    bool `json:"ok"`
		Total int  `json:"total"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &recsResp); err != nil || recsResp.Total != 1 {
		t.Fatalf("expected 1 record, got %s", rec.Body.String())
	}

	// Toggle off -> 200
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, ActionPrefix+taskID+"/toggle", bytes.NewBufferString(`{"enabled":false}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected toggle 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	// Delete -> 200
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, ActionPrefix+taskID+"/delete", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected delete 200, got %d body=%s", rec.Code, rec.Body.String())
	}
}
