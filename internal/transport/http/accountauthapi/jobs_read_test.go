package accountauthapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
)

type testAuthorizer bool

func (authorizer testAuthorizer) Authorized(*http.Request) bool {
	return bool(authorizer)
}

// stubJobs 只满足写接口的构造约束，读接口测试永远不会调用它。
type stubJobs struct{}

func (stubJobs) Start(
	context.Context,
	accountauth.StartRequest,
) (accountauth.StartResult, error) {
	return accountauth.StartResult{}, errors.New("写接口不应被读测试调用")
}

func (stubJobs) Get(string) (accountauth.Job, error) {
	return accountauth.Job{}, accountauth.ErrJobNotFound
}

func (stubJobs) Complete(
	context.Context,
	string,
	string,
) (accountauth.Job, error) {
	return accountauth.Job{}, errors.New("写接口不应被读测试调用")
}

func (stubJobs) Cancel(string) (accountauth.Job, error) {
	return accountauth.Job{}, errors.New("写接口不应被读测试调用")
}

// fakeJobReader 记录调用参数，让测试能断言 active 过滤确实透传到存储层。
type fakeJobReader struct {
	records    map[string]accountauth.JobRecord
	list       []accountauth.JobRecord
	getErr     error
	listErr    error
	activeOnly []bool
}

func (reader *fakeJobReader) GetJob(
	_ context.Context,
	jobID string,
) (accountauth.JobRecord, bool, error) {
	if reader.getErr != nil {
		return accountauth.JobRecord{}, false, reader.getErr
	}
	record, found := reader.records[jobID]
	return record, found, nil
}

func (reader *fakeJobReader) ListJobs(
	_ context.Context,
	activeOnly bool,
) ([]accountauth.JobRecord, error) {
	reader.activeOnly = append(reader.activeOnly, activeOnly)
	if reader.listErr != nil {
		return nil, reader.listErr
	}
	return reader.list, nil
}

func newTestHandler(
	t *testing.T,
	authorized bool,
	reader JobReader,
) *Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Jobs:       stubJobs{},
		JobRecords: reader,
		Authorizer: testAuthorizer(authorized),
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func sampleRecord() accountauth.JobRecord {
	return accountauth.JobRecord{
		ID:         "0123456789abcdef0123456789abcdef",
		ProviderID: "codex",
		Purpose:    accountauth.PurposeReauth,
		TargetRef:  "codex:2",
		Status:     accountauth.StatusFailed,
		CreatedAt:  time.Date(2026, 11, 5, 3, 4, 5, 0, time.UTC),
		ExpiresAt:  time.Date(2026, 11, 5, 3, 14, 5, 0, time.UTC),
		UpdatedAt:  time.Date(2026, 11, 5, 3, 9, 5, 0, time.UTC),
		ErrorCode:  "provider_rejected",
		// 错误消息来自持久化列，必须逐字投影给运维，不能在适配器里截断或改写。
		ErrorMessage: "官方授权被拒绝",
	}
}

func TestJobRecordReadReturnsPublicSnapshot(t *testing.T) {
	record := sampleRecord()
	handler := newTestHandler(t, true, &fakeJobReader{
		records: map[string]accountauth.JobRecord{record.ID: record},
	})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(
		recorder,
		httptest.NewRequest(
			http.MethodGet,
			JobsPath+"/"+record.ID,
			nil,
		),
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("JSON 解析失败: %v", err)
	}
	expected := map[string]string{
		"job_id":        record.ID,
		"provider_id":   "codex",
		"purpose":       "reauth",
		"target_ref":    "codex:2",
		"status":        "failed",
		"error_code":    "provider_rejected",
		"error_message": "官方授权被拒绝",
	}
	for key, want := range expected {
		if got, _ := payload.Data[key].(string); got != want {
			t.Fatalf("%s = %q, want %q", key, got, want)
		}
	}
	for _, key := range []string{"created_at", "expires_at", "updated_at"} {
		raw, _ := payload.Data[key].(string)
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			t.Fatalf("%s = %q 不是 RFC3339: %v", key, raw, err)
		}
		if !parsed.Equal(recordTime(record, key)) {
			t.Fatalf("%s = %v, want %v", key, parsed, recordTime(record, key))
		}
	}
	// 公开投影必须只有契约字段：多出来的键往往意味着有人把内部字段漏了出来。
	if len(payload.Data) != 10 {
		t.Fatalf("暴露字段数 = %d, payload = %#v", len(payload.Data), payload.Data)
	}
	for _, forbidden := range []string{
		"authorization_url",
		"state",
		"code_verifier",
		"access_token",
		"refresh_token",
	} {
		if _, found := payload.Data[forbidden]; found {
			t.Fatalf("公开投影泄漏了 %s", forbidden)
		}
	}
}

func recordTime(record accountauth.JobRecord, key string) time.Time {
	switch key {
	case "created_at":
		return record.CreatedAt
	case "expires_at":
		return record.ExpiresAt
	default:
		return record.UpdatedAt
	}
}

func TestJobRecordReadReturnsNotFoundForUnknownJob(t *testing.T) {
	handler := newTestHandler(t, true, &fakeJobReader{})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, JobsPath+"/unknown", nil),
	)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	assertErrorCode(t, recorder, "oauth_job_not_found")
}

func TestJobRecordReadRejectsMalformedPath(t *testing.T) {
	handler := newTestHandler(t, true, &fakeJobReader{})
	for _, target := range []string{JobsPath + "/", JobsPath + "/a/b"} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(
			recorder,
			httptest.NewRequest(http.MethodGet, target, nil),
		)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d", target, recorder.Code)
		}
		assertErrorCode(t, recorder, "invalid_job_path")
	}
}

func TestJobReadRequiresManagementKey(t *testing.T) {
	handler := newTestHandler(t, false, &fakeJobReader{})
	for _, target := range []string{JobsPath, JobsPath + "/any"} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(
			recorder,
			httptest.NewRequest(http.MethodGet, target, nil),
		)
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("%s status = %d", target, recorder.Code)
		}
		if recorder.Header().Get("WWW-Authenticate") != "Bearer" {
			t.Fatalf("%s 缺少 WWW-Authenticate", target)
		}
		assertErrorCode(t, recorder, "unauthorized")
	}
}

func TestJobCollectionAcceptsOnlyActiveOne(t *testing.T) {
	reader := &fakeJobReader{}
	handler := newTestHandler(t, true, reader)
	for _, target := range []string{
		JobsPath + "?active=1",
		JobsPath + "?active=1&active=1",
		JobsPath + "?active=0",
		JobsPath + "?active=true",
		JobsPath + "?active=",
		JobsPath + "?active=1&provider=codex",
	} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(
			recorder,
			httptest.NewRequest(http.MethodGet, target, nil),
		)
		want := http.StatusOK
		if target != JobsPath+"?active=1" {
			want = http.StatusBadRequest
		}
		if recorder.Code != want {
			t.Fatalf("%s status = %d, want %d", target, recorder.Code, want)
		}
		if want == http.StatusBadRequest {
			assertErrorCode(t, recorder, "invalid_query")
		}
	}
	if len(reader.activeOnly) != 1 || !reader.activeOnly[0] {
		t.Fatalf("activeOnly 调用序列 = %v, 期望只透传一次 true", reader.activeOnly)
	}

	// 不带参数表示「全部 Job」，不能因为省略就把过滤条件变成活动优先。
	handler.ServeHTTP(
		httptest.NewRecorder(),
		httptest.NewRequest(http.MethodGet, JobsPath, nil),
	)
	if len(reader.activeOnly) != 2 || reader.activeOnly[1] {
		t.Fatalf("无参数时 activeOnly = %v, 期望 false", reader.activeOnly)
	}
}

func TestJobCollectionOrdersByUpdatedAtAndCapsResults(t *testing.T) {
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	records := make([]accountauth.JobRecord, 0, 150)
	for index := 0; index < 150; index++ {
		records = append(records, accountauth.JobRecord{
			ID:         formatTestID(index),
			ProviderID: "claude",
			Purpose:    accountauth.PurposeRegister,
			Status:     accountauth.StatusPending,
			CreatedAt:  base,
			ExpiresAt:  base.Add(10 * time.Minute),
			// 故意乱序写入，验证排序发生在适配器而不是依赖存储层的顺序。
			UpdatedAt: base.Add(time.Duration(index) * time.Second),
		})
	}
	// 打乱：把最旧的记录放到第一个位置。
	records[0], records[149] = records[149], records[0]
	handler := newTestHandler(t, true, &fakeJobReader{list: records})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, JobsPath, nil),
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Data []jobRecordView `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("JSON 解析失败: %v", err)
	}
	if len(payload.Data) != maxListedJobs {
		t.Fatalf("列表长度 = %d, want %d", len(payload.Data), maxListedJobs)
	}
	if payload.Data[0].JobID != formatTestID(149) {
		t.Fatalf("首条 = %s, want 最新记录", payload.Data[0].JobID)
	}
	if payload.Data[len(payload.Data)-1].JobID != formatTestID(50) {
		t.Fatalf("末条 = %s, want 第 100 新记录", payload.Data[len(payload.Data)-1].JobID)
	}
	for index := 1; index < len(payload.Data); index++ {
		if payload.Data[index].UpdatedAt > payload.Data[index-1].UpdatedAt {
			t.Fatalf("第 %d 条未按 updated_at 倒序", index)
		}
	}
}

func formatTestID(value int) string {
	return fmt.Sprintf("%032x", value)
}

func TestJobCollectionReturnsEmptyArray(t *testing.T) {
	handler := newTestHandler(t, true, &fakeJobReader{})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, JobsPath, nil),
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	var payload struct {
		Data []jobRecordView `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("JSON 解析失败: %v", err)
	}
	if payload.Data == nil {
		t.Fatalf("空列表被序列化成 null, body = %s", recorder.Body.String())
	}
	if len(payload.Data) != 0 {
		t.Fatalf("空列表长度 = %d", len(payload.Data))
	}
}

func TestJobReadFailsClosedWithoutReader(t *testing.T) {
	handler := newTestHandler(t, true, nil)
	for _, target := range []string{JobsPath, JobsPath + "/any"} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(
			recorder,
			httptest.NewRequest(http.MethodGet, target, nil),
		)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s status = %d", target, recorder.Code)
		}
		assertErrorCode(t, recorder, "job_store_unavailable")
	}
}

func TestJobReadHidesStoreErrors(t *testing.T) {
	boom := errors.New("数据库错误：包含内部路径 /var/db/aih.db")
	handler := newTestHandler(t, true, &fakeJobReader{
		getErr:  boom,
		listErr: boom,
	})
	for _, target := range []string{JobsPath, JobsPath + "/any"} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(
			recorder,
			httptest.NewRequest(http.MethodGet, target, nil),
		)
		if recorder.Code != http.StatusInternalServerError {
			t.Fatalf("%s status = %d", target, recorder.Code)
		}
		assertErrorCode(t, recorder, "internal_error")
		if body := recorder.Body.String(); strings.Contains(body, "/var/db/aih.db") {
			t.Fatalf("响应泄漏了内部错误文本: %s", body)
		}
	}
}

func TestJobReadRejectsNonGetMethods(t *testing.T) {
	handler := newTestHandler(t, true, &fakeJobReader{})
	for _, target := range []string{JobsPath, JobsPath + "/any"} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(
			recorder,
			httptest.NewRequest(http.MethodPost, target, nil),
		)
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s status = %d", target, recorder.Code)
		}
		if recorder.Header().Get("Allow") != http.MethodGet {
			t.Fatalf("%s Allow = %q", target, recorder.Header().Get("Allow"))
		}
	}
}

// TestLegacyCollectionStillRoutes 守住分发顺序：新增只读集合不能吞掉原有写接口。
func TestLegacyCollectionStillRoutes(t *testing.T) {
	handler := newTestHandler(t, true, &fakeJobReader{})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(
		recorder,
		httptest.NewRequest(
			http.MethodGet,
			CollectionPath+"/0123456789abcdef0123456789abcdef",
			nil,
		),
	)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	assertErrorCode(t, recorder, "job_not_found")
}

func assertErrorCode(t *testing.T, recorder *httptest.ResponseRecorder, want string) {
	t.Helper()
	var payload errorResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("错误 envelope 解析失败: %v, body = %s", err, recorder.Body.String())
	}
	if payload.Error.Code != want {
		t.Fatalf("error.code = %q, want %q", payload.Error.Code, want)
	}
}
