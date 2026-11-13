package webuiserverrestartapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type stubAuthorizer struct{ allow bool }

func (s stubAuthorizer) Authorized(_ *http.Request) bool { return s.allow }

func TestHandlerAuthMethodAndUnavailable(t *testing.T) {
	hUnauth, _ := NewHandler(Dependencies{Authorizer: stubAuthorizer{allow: false}})
	rec := httptest.NewRecorder()
	hUnauth.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, Path, nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}

	hNoRestarter, _ := NewHandler(Dependencies{Authorizer: stubAuthorizer{allow: true}})
	rec = httptest.NewRecorder()
	hNoRestarter.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Path, nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	hNoRestarter.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, Path, nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when restarter nil, got %d", rec.Code)
	}
}

func TestHostRestarterSuccessAndEvents(t *testing.T) {
	var gotAuth, gotPath string
	nodeSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":            true,
			"pid":           4321,
			"appliedConfig": map[string]any{"port": 9527, "managementKey": "secret"},
		})
	}))
	defer nodeSrv.Close()

	restarter := NewHostRestarter(HostRestarterOptions{
		BaseURL:       nodeSrv.URL,
		ManagementKey: func() string { return "internal-key" },
	})

	var mu sync.Mutex
	var events []RestartEvent
	h, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allow: true},
		Restarter:  restarter,
		Now:        func() time.Time { return time.UnixMilli(1700000000000) },
		EmitEvent: func(ev RestartEvent) {
			mu.Lock()
			events = append(events, ev)
			mu.Unlock()
		},
	})
	if err != nil {
		t.Fatalf("NewHandler failed: %v", err)
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, Path, nil))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"restarting":true`) {
		t.Fatalf("expected restarting:true, got %s", rec.Body.String())
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(events)
		mu.Unlock()
		if n >= 3 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(events) < 3 || events[0].Status != "queued" || events[1].Status != "starting" || events[2].Status != "started" {
		t.Fatalf("unexpected event sequence: %+v", events)
	}
	if events[2].PID != 4321 || events[2].Config["managementKey"] != "" || events[2].Config["managementKeyConfigured"] != true {
		t.Fatalf("unexpected started event payload: %+v", events[2])
	}
	if gotAuth != "Bearer internal-key" || gotPath != InternalRestartPath {
		t.Fatalf("unexpected bridge call: auth=%q path=%q", gotAuth, gotPath)
	}
}

type failingRestarter struct{}

func (failingRestarter) Restart(_ context.Context, _ RestartJob) (RestartOutcome, error) {
	return RestartOutcome{}, errors.New("boom")
}

func TestHandlerEmitsFailedEventOnRestarterError(t *testing.T) {
	var mu sync.Mutex
	var lastStatus string
	h, _ := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allow: true},
		Restarter:  failingRestarter{},
		EmitEvent: func(ev RestartEvent) {
			mu.Lock()
			lastStatus = ev.Status
			mu.Unlock()
		},
	})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, Path, nil))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d", rec.Code)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		st := lastStatus
		mu.Unlock()
		if st == "failed" {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("expected failed event emitted, last=%q", lastStatus)
}
