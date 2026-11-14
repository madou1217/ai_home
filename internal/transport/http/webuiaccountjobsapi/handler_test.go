package webuiaccountjobsapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	accountauth "github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountjobsapi"
)

type allowAuth struct{ allow bool }

func (a allowAuth) Authorized(*http.Request) bool { return a.allow }

type fakeJobStore struct {
	jobs map[string]accountauth.Job
}

func (s fakeJobStore) GetJob(_ context.Context, jobID string) (accountauth.Job, error) {
	job, found := s.jobs[jobID]
	if !found {
		return accountauth.Job{}, accountauth.ErrJobNotFound
	}
	return job, nil
}

type jobPayload struct {
	OK        bool           `json:"ok"`
	Recovered bool           `json:"recovered"`
	Job       map[string]any `json:"job"`
}

func newJobsHandler(t *testing.T, jobs map[string]accountauth.Job) *webuiaccountjobsapi.Handler {
	t.Helper()
	handler, err := webuiaccountjobsapi.NewHandler(webuiaccountjobsapi.Dependencies{
		Authorizer: allowAuth{allow: true},
		Jobs:       fakeJobStore{jobs: jobs},
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func getJob(t *testing.T, handler http.Handler, jobID string) jobPayload {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(
		http.MethodGet,
		webuiaccountjobsapi.Path+"/"+jobID,
		nil,
	))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var payload jobPayload
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal error = %v", err)
	}
	if !payload.OK || payload.Job == nil {
		t.Fatalf("unexpected payload = %#v", payload)
	}
	return payload
}

func TestAccountJobDetailSerializesPersistedSnapshots(t *testing.T) {
	createdAt := time.UnixMilli(1_760_000_000_000).UTC()
	expiresAt := createdAt.Add(5 * time.Minute)
	finishedAt := createdAt.Add(30 * time.Second)
	targetRef := "acct_0123456789abcdef0123"

	completed := accountauth.RestoreJob(accountauth.JobRecord{
		ID:           "job-browser-1",
		ProviderID:   "codex",
		Purpose:      accountauth.PurposeReauth,
		TargetRef:    targetRef,
		Status:       accountauth.StatusCompleted,
		CreatedAt:    createdAt,
		ExpiresAt:    expiresAt,
		UpdatedAt:    finishedAt,
		FinishedAt:   finishedAt,
		AccountRef:   targetRef,
		CLIAccountID: 2,
	})
	failed := accountauth.RestoreJob(accountauth.JobRecord{
		ID:         "job_device_1",
		ProviderID: "qwen",
		Purpose:    accountauth.PurposeRegister,
		Status:     accountauth.StatusFailed,
		CreatedAt:  createdAt,
		ExpiresAt:  expiresAt,
		UpdatedAt:  finishedAt,
		FinishedAt: finishedAt,
		ErrorCode:  "provider_rejected",
	})
	handler := newJobsHandler(t, map[string]accountauth.Job{
		completed.ID(): completed,
		failed.ID():    failed,
	})

	t.Run("completed job exposes status, time, account ref and reauth", func(t *testing.T) {
		payload := getJob(t, handler, "job-browser-1")
		if !payload.Recovered {
			t.Fatalf("recovered = false, want true for persisted snapshot")
		}
		job := payload.Job
		if job["id"] != "job-browser-1" || job["provider"] != "codex" {
			t.Fatalf("identity fields = %#v", job)
		}
		if job["status"] != "succeeded" || job["goStatus"] != "completed" || job["authProgressState"] != "completed" {
			t.Fatalf("status fields = %#v", job)
		}
		if job["updatedAt"] != float64(finishedAt.UnixMilli()) {
			t.Fatalf("updatedAt = %v, want %d", job["updatedAt"], finishedAt.UnixMilli())
		}
		if job["accountRef"] != targetRef || job["reauth"] != true {
			t.Fatalf("accountRef/reauth = %#v", job)
		}
		if job["expiresAt"] != float64(expiresAt.UnixMilli()) {
			t.Fatalf("expiresAt = %v, want %d", job["expiresAt"], expiresAt.UnixMilli())
		}
		if job["error"] != "" || job["failureCode"] != "" {
			t.Fatalf("error fields = %#v", job)
		}
		attempts, ok := job["installAttempts"].([]any)
		if !ok || attempts == nil || len(attempts) != 0 {
			t.Fatalf("installAttempts must be non-nil empty array, got %#v", job["installAttempts"])
		}
	})

	t.Run("failed job exposes stable failure code", func(t *testing.T) {
		payload := getJob(t, handler, "job_device_1")
		job := payload.Job
		if job["status"] != "failed" || job["authProgressState"] != "failed" {
			t.Fatalf("status fields = %#v", job)
		}
		if job["error"] != "provider_rejected" || job["failureCode"] != "provider_rejected" {
			t.Fatalf("error fields = %#v", job)
		}
		if job["reauth"] != false {
			t.Fatalf("reauth = %v, want false", job["reauth"])
		}
	})

	t.Run("unknown job returns 404", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(
			http.MethodGet,
			webuiaccountjobsapi.Path+"/missing",
			nil,
		))
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
		}
	})
}

func TestAccountJobsAuthAndMethod(t *testing.T) {
	handler := newJobsHandler(t, nil)

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, webuiaccountjobsapi.Path+"/job", nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d, want 405", recorder.Code)
	}

	unauthorized, err := webuiaccountjobsapi.NewHandler(webuiaccountjobsapi.Dependencies{
		Authorizer: allowAuth{allow: false},
		Jobs:       fakeJobStore{},
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	recorder = httptest.NewRecorder()
	unauthorized.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, webuiaccountjobsapi.Path+"/job", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d, want 401", recorder.Code)
	}
}
