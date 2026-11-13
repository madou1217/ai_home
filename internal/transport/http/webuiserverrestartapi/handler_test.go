package webuiserverrestartapi

import (
	"context"
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

type stubRestarter struct {
	outcome RestartOutcome
	err     error
	gotJob  RestartJob
}

func (s *stubRestarter) Restart(_ context.Context, job RestartJob) (RestartOutcome, error) {
	s.gotJob = job
	if s.err != nil {
		return RestartOutcome{}, s.err
	}
	return s.outcome, nil
}

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

func TestHandlerSuccessAndEventsSanitizesConfigAndPreservesFlags(t *testing.T) {
	cases := []struct {
		name              string
		appliedConfig     map[string]any
		wantAPIConfigured bool
		wantMgmtConfig    bool
	}{
		{
			name: "raw secrets redacted",
			appliedConfig: map[string]any{
				"port":          9527,
				"apiKey":        "client-secret",
				"managementKey": "mgmt-secret",
			},
			wantAPIConfigured: true,
			wantMgmtConfig:    true,
		},
		{
			name: "already sanitized public config preserves flags",
			appliedConfig: map[string]any{
				"port":                    9528,
				"apiKey":                  "",
				"managementKey":           "",
				"apiKeyConfigured":        false,
				"managementKeyConfigured": true,
			},
			wantAPIConfigured: false,
			wantMgmtConfig:    true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			restarter := &stubRestarter{
				outcome: RestartOutcome{
					PID:           4321,
					AppliedConfig: tc.appliedConfig,
				},
			}
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
			ev := events[2]
			if ev.PID != 4321 ||
				ev.Config["apiKey"] != "" ||
				ev.Config["managementKey"] != "" ||
				ev.Config["apiKeyConfigured"] != tc.wantAPIConfigured ||
				ev.Config["managementKeyConfigured"] != tc.wantMgmtConfig {
				t.Fatalf("unexpected started event payload: %+v", ev)
			}
		})
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
