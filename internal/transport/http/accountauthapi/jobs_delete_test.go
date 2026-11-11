package accountauthapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeJobRemover 记录删除参数，并可按用例返回「不存在」或存储故障。
type fakeJobRemover struct {
	jobID   string
	deleted bool
	err     error
}

func (remover *fakeJobRemover) DeleteJob(
	_ context.Context,
	jobID string,
) (bool, error) {
	remover.jobID = jobID
	return remover.deleted, remover.err
}

func newDeleteTestHandler(t *testing.T, remover JobRemover) *Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Jobs:       stubJobs{},
		Authorizer: testAuthorizer(true),
		JobDeletes: remover,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func TestDeleteOAuthJobRemovesSnapshot(t *testing.T) {
	remover := &fakeJobRemover{deleted: true}
	handler := newDeleteTestHandler(t, remover)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodDelete, JobsPath+"/job-1", nil),
	)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("DELETE status = %d, want 204, body = %s", recorder.Code, recorder.Body.String())
	}
	if remover.jobID != "job-1" {
		t.Fatalf("DeleteJob() jobID = %q, want job-1", remover.jobID)
	}
}

func TestDeleteOAuthJobReturnsNotFound(t *testing.T) {
	handler := newDeleteTestHandler(t, &fakeJobRemover{deleted: false})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodDelete, JobsPath+"/missing", nil),
	)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("DELETE status = %d, want 404", recorder.Code)
	}
	if body := recorder.Body.String(); !strings.Contains(body, "oauth_job_not_found") {
		t.Fatalf("DELETE body = %s", body)
	}
}

func TestDeleteOAuthJobHidesStoreErrors(t *testing.T) {
	handler := newDeleteTestHandler(t, &fakeJobRemover{
		err: errors.New("database is locked: /secret/path"),
	})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodDelete, JobsPath+"/job-1", nil),
	)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("DELETE status = %d, want 500", recorder.Code)
	}
	if body := recorder.Body.String(); strings.Contains(body, "database is locked") {
		t.Fatalf("DELETE 泄漏了存储错误: %s", body)
	}
}

func TestDeleteOAuthJobWithoutRemoverReturns503(t *testing.T) {
	handler := newDeleteTestHandler(t, nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodDelete, JobsPath+"/job-1", nil),
	)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("DELETE status = %d, want 503", recorder.Code)
	}
}

func TestDeleteOAuthJobRequiresManagementKey(t *testing.T) {
	handler, err := NewHandler(Dependencies{
		Jobs:       stubJobs{},
		Authorizer: testAuthorizer(false),
		JobDeletes: &fakeJobRemover{deleted: true},
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodDelete, JobsPath+"/job-1", nil),
	)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("DELETE status = %d, want 401", recorder.Code)
	}
}
