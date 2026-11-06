package accountauthapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
)

// fakeJobWriter 记录最后一次写入，便于断言归一化结果。
type fakeJobWriter struct {
	record accountauth.JobRecord
	calls  int
}

func (writer *fakeJobWriter) UpsertJob(_ context.Context, record accountauth.JobRecord) error {
	writer.record = record
	writer.calls++
	return nil
}

// fakeJobs 满足 Jobs 端口的空实现（PUT 路径不会用到）。
type fakeJobs struct{}

func (fakeJobs) Start(context.Context, accountauth.StartRequest) (accountauth.StartResult, error) {
	return accountauth.StartResult{}, nil
}
func (fakeJobs) Get(string) (accountauth.Job, error) { return accountauth.Job{}, nil }
func (fakeJobs) Complete(context.Context, string, string) (accountauth.Job, error) {
	return accountauth.Job{}, nil
}
func (fakeJobs) Cancel(string) (accountauth.Job, error) { return accountauth.Job{}, nil }

func newWriteTestHandler(t *testing.T, writer JobWriter) *Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Jobs:       fakeJobs{},
		Authorizer: testAuthorizer(true),
		JobWrites:  writer,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func TestPutOAuthJobUpsertsSnapshot(t *testing.T) {
	writer := &fakeJobWriter{}
	handler := newWriteTestHandler(t, writer)
	created := time.Date(2026, 11, 5, 6, 0, 0, 0, time.UTC).Format(time.RFC3339)
	body := map[string]any{
		"provider_id": "zcode",
		"purpose":     "register",
		"status":      "completed",
		"created_at":  created,
		"updated_at":  created,
		"target_ref":  "acct_0123456789abcdef0123",
	}
	encoded, _ := json.Marshal(body)
	request := httptest.NewRequest(http.MethodPut, JobsPath+"/job-1", bytes.NewReader(encoded))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if writer.calls != 1 || writer.record.ID != "job-1" || writer.record.ProviderID != "zcode" {
		t.Fatalf("写入结果不对: %#v", writer.record)
	}
	if writer.record.Status != accountauth.StatusCompleted {
		t.Fatalf("status = %q", writer.record.Status)
	}
}

func TestPutOAuthJobMapsTerminalAccountFields(t *testing.T) {
	writer := &fakeJobWriter{}
	handler := newWriteTestHandler(t, writer)
	created := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	finished := created.Add(75 * time.Second)
	encoded, _ := json.Marshal(map[string]any{
		"provider_id":    "codex",
		"purpose":        "register",
		"status":         "completed",
		"created_at":     created.Format(time.RFC3339),
		"updated_at":     finished.Format(time.RFC3339),
		"expires_at":     created.Add(10 * time.Minute).Format(time.RFC3339),
		"account_ref":    "acct_0123456789abcdef0123",
		"cli_account_id": 42,
		"finished_at":    finished.Format(time.RFC3339),
	})
	request := httptest.NewRequest(http.MethodPut, JobsPath+"/job-1", bytes.NewReader(encoded))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if writer.record.AccountRef != "acct_0123456789abcdef0123" ||
		writer.record.CLIAccountID != 42 ||
		!writer.record.FinishedAt.Equal(finished) {
		t.Fatalf("终态账号字段映射不对: %#v", writer.record)
	}
}

// 待办快照即使带了账号字段也不能落成结果：账号结果只在终态成立。
func TestPutOAuthJobPendingDropsTerminalAccountFields(t *testing.T) {
	writer := &fakeJobWriter{}
	handler := newWriteTestHandler(t, writer)
	created := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	encoded, _ := json.Marshal(map[string]any{
		"provider_id":    "codex",
		"purpose":        "register",
		"status":         "pending",
		"created_at":     created.Format(time.RFC3339),
		"updated_at":     created.Format(time.RFC3339),
		"expires_at":     created.Add(10 * time.Minute).Format(time.RFC3339),
		"account_ref":    "acct_0123456789abcdef0123",
		"cli_account_id": 42,
		"finished_at":    created.Format(time.RFC3339),
	})
	request := httptest.NewRequest(http.MethodPut, JobsPath+"/job-1", bytes.NewReader(encoded))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if writer.record.AccountRef != "" ||
		writer.record.CLIAccountID != 0 ||
		!writer.record.FinishedAt.IsZero() {
		t.Fatalf("pending 不应带终态账号字段: %#v", writer.record)
	}
}

func TestPutOAuthJobRejectsInvalidTerminalFields(t *testing.T) {
	cases := map[string]map[string]any{
		"finished_at 非法": {
			"status": "completed", "finished_at": "not-a-time",
		},
		"cli_account_id 为负": {
			"status": "completed", "cli_account_id": -1,
		},
	}
	for name, fields := range cases {
		writer := &fakeJobWriter{}
		handler := newWriteTestHandler(t, writer)
		body := map[string]any{"provider_id": "codex", "purpose": "register"}
		for key, value := range fields {
			body[key] = value
		}
		encoded, _ := json.Marshal(body)
		request := httptest.NewRequest(http.MethodPut, JobsPath+"/job-1", bytes.NewReader(encoded))
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400", name, recorder.Code)
		}
		if writer.calls != 0 {
			t.Fatalf("%s: 非法请求不应写库", name)
		}
	}
}

func TestPutOAuthJobRejectsInvalidStatus(t *testing.T) {
	writer := &fakeJobWriter{}
	handler := newWriteTestHandler(t, writer)
	encoded, _ := json.Marshal(map[string]any{
		"provider_id": "zcode", "purpose": "register", "status": "weird",
	})
	request := httptest.NewRequest(http.MethodPut, JobsPath+"/job-1", bytes.NewReader(encoded))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
	if writer.calls != 0 {
		t.Fatal("非法请求不应写库")
	}
}

func TestPutOAuthJobWithoutWriterReturns503(t *testing.T) {
	handler := newWriteTestHandler(t, nil)
	encoded, _ := json.Marshal(map[string]any{"provider_id": "zcode", "purpose": "register", "status": "pending"})
	request := httptest.NewRequest(http.MethodPut, JobsPath+"/job-1", bytes.NewReader(encoded))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
}
