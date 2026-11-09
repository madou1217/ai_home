package plugincontrolapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/plugincontrol"
)

type stubCommitter struct {
	revision  int64
	err       error
	calls     int
	operation plugincontrol.Operation
	expected  int64
	candidate []byte
}

func (committer *stubCommitter) Commit(
	_ context.Context,
	operation plugincontrol.Operation,
	expectedRevision int64,
	candidate []byte,
) (int64, error) {
	committer.calls++
	committer.operation = operation
	committer.expected = expectedRevision
	committer.candidate = append([]byte(nil), candidate...)
	return committer.revision, committer.err
}

func newStateHandler(t *testing.T, committer StateCommitter) *Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allowed: true},
		Installer:  &stubInstaller{},
		Committer:  committer,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func TestStateCommitSuccess(t *testing.T) {
	committer := &stubCommitter{revision: 8}
	handler := newStateHandler(t, committer)
	body := "{\"operation\":\"enable\",\"expectedRevision\":7,\"candidate\":{\"schemaVersion\":1,\"revision\":8,\"installed\":[],\"instances\":[],\"generations\":[]}}"
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, StatePath, strings.NewReader(body))
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if committer.calls != 1 || committer.operation != plugincontrol.OperationEnable || committer.expected != 7 {
		t.Fatalf("commit 参数 = %+v", committer)
	}
	if !strings.Contains(recorder.Body.String(), "\"revision\":8") {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}

func TestStateCommitRevisionConflict(t *testing.T) {
	committer := &stubCommitter{err: &plugincontrol.RevisionConflictError{Current: 3}}
	handler := newStateHandler(t, committer)
	body := "{\"operation\":\"disable\",\"expectedRevision\":7,\"candidate\":{\"schemaVersion\":1,\"revision\":8,\"installed\":[],\"instances\":[],\"generations\":[]}}"
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, StatePath, strings.NewReader(body)))
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "\"revision\":3") {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}

func TestStateCommitRejectsUnknownOperation(t *testing.T) {
	committer := &stubCommitter{}
	handler := newStateHandler(t, committer)
	body := "{\"operation\":\"upgrade\",\"expectedRevision\":1,\"candidate\":{}}"
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, StatePath, strings.NewReader(body)))
	if recorder.Code != http.StatusBadRequest || committer.calls != 0 {
		t.Fatalf("status = %d calls=%d body=%s", recorder.Code, committer.calls, recorder.Body.String())
	}
}

func TestStateCommitUnavailableWithoutCommitter(t *testing.T) {
	handler := newStateHandler(t, nil)
	body := "{\"operation\":\"enable\",\"expectedRevision\":1,\"candidate\":{}}"
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, StatePath, strings.NewReader(body)))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
}
