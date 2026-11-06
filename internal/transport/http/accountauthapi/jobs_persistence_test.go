package accountauthapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

// 这组测试用真实 sqlite 适配器串起「Node 推送 → Go 落库 → 重启后 GET 回放」，
// 保证终态账号结果不是只活在进程内存里的近似值。

func openJobPersistenceStore(t *testing.T, aiHomeDir string) *sqliteaccount.Store {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	store, err := sqliteaccount.Open(context.Background(), sqliteaccount.OpenOptions{
		AIHomeDir: aiHomeDir,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func newPersistenceHandler(t *testing.T, store *sqliteaccount.Store) *Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Jobs:       fakeJobs{},
		Authorizer: testAuthorizer(true),
		JobRecords: store,
		JobWrites:  store,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func readJobPayload(t *testing.T, handler *Handler, jobID string) map[string]any {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, JobsPath+"/"+jobID, nil),
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("GET %s status = %d, body = %s", jobID, recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("JSON 解析失败: %v", err)
	}
	return payload.Data
}

func assertCompletedJobView(
	t *testing.T,
	handler *Handler,
	jobID string,
	accountRef string,
	cliAccountID int64,
	finishedAt time.Time,
) {
	t.Helper()
	data := readJobPayload(t, handler, jobID)
	if data["status"] != "completed" {
		t.Fatalf("status = %v, want completed", data["status"])
	}
	if data["account_ref"] != accountRef {
		t.Fatalf("account_ref = %v, want %q", data["account_ref"], accountRef)
	}
	if got, _ := data["cli_account_id"].(float64); int64(got) != cliAccountID {
		t.Fatalf("cli_account_id = %v, want %d", data["cli_account_id"], cliAccountID)
	}
	raw, _ := data["finished_at"].(string)
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		t.Fatalf("finished_at = %q 不是 RFC3339: %v", raw, err)
	}
	if !parsed.Equal(finishedAt) {
		t.Fatalf("finished_at = %s, want %s", parsed, finishedAt)
	}
}

func TestJobAccountResultSurvivesRestart(t *testing.T) {
	aiHomeDir := t.TempDir()
	store := openJobPersistenceStore(t, aiHomeDir)
	ctx := context.Background()
	createdAt := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	finishedAt := createdAt.Add(75 * time.Second)
	const jobID = "job-account-result"
	const accountRef = "acct_0123456789abcdef0123"
	handler := newPersistenceHandler(t, store)

	putJob := func(target *Handler, body map[string]any) {
		t.Helper()
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("JSON 编码失败: %v", err)
		}
		recorder := httptest.NewRecorder()
		target.ServeHTTP(
			recorder,
			httptest.NewRequest(http.MethodPut, JobsPath+"/"+jobID, bytes.NewReader(encoded)),
		)
		if recorder.Code != http.StatusOK {
			t.Fatalf("PUT %s status = %d, body = %s", jobID, recorder.Code, recorder.Body.String())
		}
	}

	// 1) 待办快照不带账号字段：落库为零值，读投影也不出现这三个键。
	putJob(handler, map[string]any{
		"provider_id": "codex",
		"purpose":     "register",
		"status":      "pending",
		"created_at":  createdAt.Format(time.RFC3339),
		"updated_at":  createdAt.Format(time.RFC3339),
		"expires_at":  createdAt.Add(10 * time.Minute).Format(time.RFC3339),
	})
	record, found, err := store.GetJob(ctx, jobID)
	if err != nil || !found {
		t.Fatalf("GetJob() after pending = %v, %v", found, err)
	}
	if record.AccountRef != "" || record.CLIAccountID != 0 || !record.FinishedAt.IsZero() {
		t.Fatalf("pending 快照不应带账号结果: %#v", record)
	}
	pendingView := readJobPayload(t, handler, jobID)
	for _, key := range []string{"account_ref", "cli_account_id", "finished_at"} {
		if _, present := pendingView[key]; present {
			t.Fatalf("pending 投影不应输出 %s: %#v", key, pendingView)
		}
	}

	// 2) 成功终态：三个字段必须真的落到 v29 的列。
	putJob(handler, map[string]any{
		"provider_id":    "codex",
		"purpose":        "register",
		"status":         "completed",
		"created_at":     createdAt.Format(time.RFC3339),
		"updated_at":     finishedAt.Format(time.RFC3339),
		"expires_at":     createdAt.Add(10 * time.Minute).Format(time.RFC3339),
		"account_ref":    accountRef,
		"cli_account_id": 42,
		"finished_at":    finishedAt.Format(time.RFC3339),
	})
	record, found, err = store.GetJob(ctx, jobID)
	if err != nil || !found {
		t.Fatalf("GetJob() after completed = %v, %v", found, err)
	}
	if record.AccountRef != accountRef ||
		record.CLIAccountID != 42 ||
		!record.FinishedAt.Equal(finishedAt) {
		t.Fatalf("终态账号结果未落库: %#v", record)
	}

	// 3) 重启第一步：新 Handler + 同一 store。
	assertCompletedJobView(t, newPersistenceHandler(t, store), jobID, accountRef, 42, finishedAt)

	// 4) 重启第二步：关闭并重开同一个 aih.db，模拟真正的进程重启。
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	reopened := openJobPersistenceStore(t, aiHomeDir)
	assertCompletedJobView(t, newPersistenceHandler(t, reopened), jobID, accountRef, 42, finishedAt)
}
