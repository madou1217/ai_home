package webuihousekeepingapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/runtime/persistent"
	"github.com/madou1217/ai_home/internal/runtime/remotebackup"
)

type stubAuthorizer struct {
	allow bool
}

func (s stubAuthorizer) Authorized(*http.Request) bool {
	return s.allow
}

type stubBackupController struct {
	status       remotebackup.BackupStatus
	statusErr    error
	triggerRet   bool
	triggerCalls []string
	runNowResult remotebackup.BackupRunResult
	runNowErr    error
	runNowCalls  []struct {
		reason    string
		force     bool
		full      bool
		targetIDs []string
	}
}

func (s *stubBackupController) Status(context.Context) (remotebackup.BackupStatus, error) {
	return s.status, s.statusErr
}

func (s *stubBackupController) Trigger(reason string) bool {
	s.triggerCalls = append(s.triggerCalls, reason)
	return s.triggerRet
}

func (s *stubBackupController) RunNow(_ context.Context, reason string, force bool, full bool, targetIDs []string) (remotebackup.BackupRunResult, error) {
	s.runNowCalls = append(s.runNowCalls, struct {
		reason    string
		force     bool
		full      bool
		targetIDs []string
	}{reason: reason, force: force, full: full, targetIDs: targetIDs})
	return s.runNowResult, s.runNowErr
}

type stubJanitorController struct {
	result remotebackup.BackupRunResult
	jRes   persistent.JanitorRunResult
	err    error
	calls  int
}

func (s *stubJanitorController) RunNow(context.Context) (persistent.JanitorRunResult, error) {
	s.calls++
	return s.jRes, s.err
}

func TestNewHandlerRejectsMissingDependencies(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("expected ErrInvalidDependencies without authorizer, got %v", err)
	}
	if _, err := NewHandler(Dependencies{Authorizer: stubAuthorizer{allow: true}}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("expected ErrInvalidDependencies without controllers, got %v", err)
	}
}

func TestHandlerAuthAndMethodValidation(t *testing.T) {
	h, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allow: false},
		Backup:     &stubBackupController{},
		Janitor:    &stubJanitorController{},
	})
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, BackupStatusPath, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized || rec.Header().Get("WWW-Authenticate") != "Bearer" {
		t.Fatalf("unauthorized status=%d auth=%q", rec.Code, rec.Header().Get("WWW-Authenticate"))
	}

	hAuthed, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allow: true},
		Backup:     &stubBackupController{},
		Janitor:    &stubJanitorController{},
	})
	if err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		method string
		path   string
		want   int
	}{
		{http.MethodPost, BackupStatusPath, http.StatusMethodNotAllowed},
		{http.MethodGet, BackupTriggerPath, http.StatusMethodNotAllowed},
		{http.MethodGet, JanitorRunPath, http.StatusMethodNotAllowed},
		{http.MethodGet, "/v1/management/webui/backup/unknown", http.StatusNotFound},
	} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		w := httptest.NewRecorder()
		hAuthed.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Fatalf("%s %s status=%d want=%d", tc.method, tc.path, w.Code, tc.want)
		}
	}
}

func TestHandlerBackupStatusTriggerAndJanitorRun(t *testing.T) {
	backup := &stubBackupController{
		status: remotebackup.BackupStatus{
			Enabled:         true,
			SchedulerActive: true,
			IntervalMinutes: 360,
			DebounceSeconds: 15,
			Targets: []remotebackup.TargetStatusSummary{
				{ID: "prod", Strategy: "ssh", Enabled: true, Host: "10.0.0.1", Port: 22, Username: "ops"},
			},
		},
		triggerRet:   true,
		runNowResult: remotebackup.BackupRunResult{OK: true, Accounts: 3},
	}
	janitor := &stubJanitorController{
		jRes: persistent.JanitorRunResult{
			Ran:      true,
			Sessions: persistent.ReapResult{Closed: 2, Kept: []persistent.SessionRow{{Name: "s1"}}},
		},
	}
	h, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allow: true},
		Backup:     backup,
		Janitor:    janitor,
	})
	if err != nil {
		t.Fatal(err)
	}

	// 1. GET backup status
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, BackupStatusPath, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("GET status = %d body=%s", w.Code, w.Body.String())
	}
	var statusResp struct {
		OK     bool                      `json:"ok"`
		Status remotebackup.BackupStatus `json:"status"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &statusResp); err != nil || !statusResp.OK || len(statusResp.Status.Targets) != 1 {
		t.Fatalf("unexpected statusResp = %+v, err=%v", statusResp, err)
	}

	// 2. POST trigger debounced (runNow: false)
	w = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, BackupTriggerPath, strings.NewReader(`{"reason":"lifecycle","force":false,"runNow":false}`))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("POST debounced = %d body=%s", w.Code, w.Body.String())
	}
	var debResp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &debResp); err != nil || debResp["mode"] != "debounced" || debResp["scheduled"] != true {
		t.Fatalf("debResp = %+v, err=%v", debResp, err)
	}
	if len(backup.triggerCalls) != 1 || backup.triggerCalls[0] != "lifecycle" {
		t.Fatalf("triggerCalls = %v", backup.triggerCalls)
	}

	// 3. POST trigger immediate (runNow: true)
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, BackupTriggerPath, strings.NewReader(`{"reason":"manual-force","force":true,"runNow":true,"targetIds":["prod"]}`))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("POST runNow = %d body=%s", w.Code, w.Body.String())
	}
	if len(backup.runNowCalls) != 1 || backup.runNowCalls[0].reason != "manual-force" || !backup.runNowCalls[0].force || len(backup.runNowCalls[0].targetIDs) != 1 {
		t.Fatalf("runNowCalls = %+v", backup.runNowCalls)
	}

	// 4. Reject unknown JSON field and non-JSON media type
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, BackupTriggerPath, strings.NewReader(`{"unknownField":1}`))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for unknown field, got %d", w.Code)
	}

	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, BackupTriggerPath, strings.NewReader(`{"reason":"x"}`))
	req.Header.Set("Content-Type", "text/plain")
	h.ServeHTTP(w, req)
	if w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("expected 415 for text/plain, got %d", w.Code)
	}

	// 5. POST janitor run with empty body
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, JanitorRunPath, nil))
	if w.Code != http.StatusOK || janitor.calls != 1 {
		t.Fatalf("POST janitor = %d calls=%d body=%s", w.Code, janitor.calls, w.Body.String())
	}

	// 6. Fail-closed 503 when optional sub-controller missing, 500 when controller returns error
	hOnlyJanitor, _ := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allow: true},
		Janitor:    &stubJanitorController{err: errors.New("tmux failed")},
	})
	w = httptest.NewRecorder()
	hOnlyJanitor.ServeHTTP(w, httptest.NewRequest(http.MethodGet, BackupStatusPath, nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when backup missing, got %d", w.Code)
	}
	w = httptest.NewRecorder()
	hOnlyJanitor.ServeHTTP(w, httptest.NewRequest(http.MethodPost, JanitorRunPath, nil))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on janitor error, got %d", w.Code)
	}
}
