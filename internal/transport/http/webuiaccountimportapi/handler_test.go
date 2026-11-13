package webuiaccountimportapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

type allowAll struct{}

func (allowAll) Authorized(*http.Request) bool { return true }

type denyAll struct{}

func (denyAll) Authorized(*http.Request) bool { return false }

// fakeImporter 按配置返回导入结果，并记录收到的条目。
type fakeImporter struct {
	mu      sync.Mutex
	results []accountsapi.AihAccountsImportResult
	calls   [][]accountsapi.AihAccountsImportEntry
	// gate 非空时阻塞到关闭，用来制造「活动作业」的时间窗口。
	gate chan struct{}
}

func (importer *fakeImporter) ImportAihAccounts(
	_ context.Context,
	entries []accountsapi.AihAccountsImportEntry,
) accountsapi.AihAccountsImportResult {
	if importer.gate != nil {
		<-importer.gate
	}
	importer.mu.Lock()
	defer importer.mu.Unlock()
	importer.calls = append(importer.calls, entries)
	if len(importer.results) == 0 {
		return emptyResult(len(entries))
	}
	result := importer.results[0]
	importer.results = importer.results[1:]
	return result
}

func emptyResult(total int) accountsapi.AihAccountsImportResult {
	return accountsapi.AihAccountsImportResult{
		Summary: map[string]int{
			"total": total, "created": 0, "updated": 0, "failed": 0, "skipped": 0,
		},
		Accounts: []accountsapi.AihAccountImportOutcome{},
	}
}

// recordingPublisher 把广播帧塞进 channel，测试据此等待终态。
type recordingPublisher struct {
	mu     sync.Mutex
	frames []any
	events chan any
}

func newRecordingPublisher() *recordingPublisher {
	return &recordingPublisher{events: make(chan any, 32)}
}

func (publisher *recordingPublisher) Publish(payload any) {
	publisher.mu.Lock()
	publisher.frames = append(publisher.frames, payload)
	publisher.mu.Unlock()
	select {
	case publisher.events <- payload:
	default:
	}
}

// waitForStatus 读广播直到出现目标状态的作业帧。
func (publisher *recordingPublisher) waitForStatus(t *testing.T, status string) importJobView {
	t.Helper()
	for range 16 {
		select {
		case frame := <-publisher.events:
			event, ok := frame.(importJobEvent)
			if ok && event.Job.Status == status {
				return event.Job
			}
		case <-timeoutAfter(t):
			t.Fatalf("等待作业状态 %s 超时", status)
		}
	}
	t.Fatalf("没有等到作业状态 %s", status)
	return importJobView{}
}

func timeoutAfter(t *testing.T) <-chan time.Time {
	t.Helper()
	return time.After(5 * time.Second)
}

func TestNewHandlerRejectsMissingDependencies(t *testing.T) {
	cases := []struct {
		name         string
		dependencies Dependencies
	}{
		{name: "缺少鉴权", dependencies: Dependencies{Importer: &fakeImporter{}, Publisher: newRecordingPublisher()}},
		{name: "缺少导入端口", dependencies: Dependencies{Authorizer: allowAll{}, Publisher: newRecordingPublisher()}},
		{name: "缺少事件发布", dependencies: Dependencies{Authorizer: allowAll{}, Importer: &fakeImporter{}}},
		{name: "全缺", dependencies: Dependencies{}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler, err := NewHandler(testCase.dependencies)
			if err == nil || handler != nil {
				t.Fatalf("期望依赖校验失败，得到 handler=%v err=%v", handler, err)
			}
		})
	}
}

func TestServeHTTPRequiresAuthorization(t *testing.T) {
	handler := mustHandler(t, Dependencies{
		Authorizer: denyAll{}, Importer: &fakeImporter{}, Publisher: newRecordingPublisher(),
	})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, strings.NewReader("{}")))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("期望 401，得到 %d", recorder.Code)
	}
}

func TestStartJobImportsDocumentsAndPublishesTerminalFrame(t *testing.T) {
	importer := &fakeImporter{results: []accountsapi.AihAccountsImportResult{{
		Summary: map[string]int{"total": 2, "created": 1, "updated": 1, "failed": 0, "skipped": 0},
		Accounts: []accountsapi.AihAccountImportOutcome{
			{Provider: "codex", AccountRef: "acct_new", Status: "created"},
			{Provider: "claude", AccountRef: "acct_old", Status: "updated"},
			{Provider: "codex", AccountRef: "acct_dup", Status: "unchanged"},
		},
	}}}
	publisher := newRecordingPublisher()
	handler := mustHandler(t, Dependencies{
		Authorizer: allowAll{}, Importer: importer, Publisher: publisher,
	})

	document := `{"kind":"aih-accounts","version":1,"accounts":[{"provider":"codex","accountRef":"acct_new","env":{"OPENAI_API_KEY":"sk-test"}}]}`
	body, err := json.Marshal(map[string]any{
		"files": []map[string]string{{"name": "accounts.json", "content": document}},
	})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, strings.NewReader(string(body))))
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("期望 202，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	var started startJobResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	if !started.OK || started.JobID == "" || started.Status != jobStatusQueued {
		t.Fatalf("创建响应不符合契约: %s", recorder.Body.String())
	}

	view := publisher.waitForStatus(t, jobStatusSucceeded)
	if view.ID != started.JobID {
		t.Fatalf("终态作业 id = %q，期望 %q", view.ID, started.JobID)
	}
	if view.Summary.Imported != 2 || view.Summary.Created != 1 || view.Summary.Updated != 1 {
		t.Fatalf("summary = %+v", view.Summary)
	}
	if len(view.Summary.Accounts) != 2 {
		t.Fatalf("只应记录 created/updated：%+v", view.Summary.Accounts)
	}
	if len(view.Summary.Providers) != 2 || view.Summary.Providers[0] != "claude" {
		t.Fatalf("providers 应去重并排序: %+v", view.Summary.Providers)
	}
	if view.FinishedAt == nil || view.Progress == nil || view.Progress.Percent != 100 {
		t.Fatalf("终态字段缺失: %+v", view)
	}
	if !strings.Contains(view.Logs, "导入完成：写入 2，失败 0。") {
		t.Fatalf("完成日志缺失: %q", view.Logs)
	}
	if view.Result == nil || len(view.Result.SourceResults) != 1 ||
		view.Result.SourceResults[0]["source"] != "accounts.json" {
		t.Fatalf("逐来源结果不符合契约: %+v", view.Result)
	}

	// GET 作业：快照与广播一致。
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path+"/jobs/"+started.JobID, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d", recorder.Code)
	}
	var fetched jobResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &fetched); err != nil {
		t.Fatal(err)
	}
	if fetched.Job.ID != started.JobID || fetched.Job.Status != jobStatusSucceeded {
		t.Fatalf("查询结果不一致: %+v", fetched.Job)
	}
}

func TestStartJobRejectsInvalidJSON(t *testing.T) {
	handler := mustHandler(t, Dependencies{
		Authorizer: allowAll{}, Importer: &fakeImporter{}, Publisher: newRecordingPublisher(),
	})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, strings.NewReader("{not json")))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("期望 400，得到 %d", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "invalid_import_data") {
		t.Fatalf("错误码不符合契约: %s", recorder.Body.String())
	}
}

func TestStartJobReportsActiveJob(t *testing.T) {
	gate := make(chan struct{})
	importer := &fakeImporter{gate: gate}
	publisher := newRecordingPublisher()
	handler := mustHandler(t, Dependencies{
		Authorizer: allowAll{}, Importer: importer, Publisher: publisher,
	})
	document := `[{"provider":"codex","env":{"OPENAI_API_KEY":"sk-test"}}]`
	body, err := json.Marshal(map[string]string{"content": document})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, strings.NewReader(string(body))))
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("期望 202，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	var started startJobResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	publisher.waitForStatus(t, jobStatusRunning)

	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, strings.NewReader(string(body))))
	if recorder.Code != http.StatusConflict {
		t.Fatalf("期望 409，得到 %d：%s", recorder.Code, recorder.Body.String())
	}
	var conflict activeJobResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &conflict); err != nil {
		t.Fatal(err)
	}
	if conflict.Error != "import_job_already_running" || conflict.JobID != started.JobID {
		t.Fatalf("冲突响应不符合契约: %s", recorder.Body.String())
	}
	close(gate)
	publisher.waitForStatus(t, jobStatusSucceeded)
}

func TestGetJobNotFound(t *testing.T) {
	handler := mustHandler(t, Dependencies{
		Authorizer: allowAll{}, Importer: &fakeImporter{}, Publisher: newRecordingPublisher(),
	})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path+"/jobs/missing", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("期望 404，得到 %d", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "job_not_found") {
		t.Fatalf("错误码不符合契约: %s", recorder.Body.String())
	}
}

func TestParseImportDocumentRecognizesOnlyNativeShapes(t *testing.T) {
	cases := []struct {
		name    string
		content string
		code    string
		count   int
	}{
		{
			name:    "文档",
			content: `{"kind":"aih-accounts","version":1,"accounts":[{"provider":"codex","env":{"OPENAI_API_KEY":"k"}}]}`,
			count:   1,
		},
		{
			name:    "字符串版本号",
			content: `{"kind":"aih-accounts","version":"1","accounts":[]}`,
			count:   0,
		},
		{
			name:    "单账号",
			content: `{"provider":"claude","nativeAuth":{"credentials":{}}}`,
			count:   1,
		},
		{
			name:    "账号数组",
			content: `[{"provider":"codex","env":{}},{"provider":"claude","env":{}}]`,
			count:   2,
		},
		{name: "坏 JSON", content: "{", code: importErrorInvalidJSON},
		{name: "其它格式", content: `{"accounts":[]}`, code: importErrorUnsupportedShape},
		{name: "数组里有别的东西", content: `[{"provider":"codex"}]`, code: importErrorUnsupportedShape},
		{
			name:    "版本不支持",
			content: `{"kind":"aih-accounts","version":2,"accounts":[]}`,
			code:    importErrorUnsupportedDoc,
		},
		{
			name:    "accounts 不是数组",
			content: `{"kind":"aih-accounts","version":1,"accounts":{}}`,
			code:    importErrorInvalidDocument,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			entries, code := parseImportDocument(testCase.content)
			if code != testCase.code {
				t.Fatalf("错误码 = %q，期望 %q", code, testCase.code)
			}
			if len(entries) != testCase.count {
				t.Fatalf("条目数 = %d，期望 %d", len(entries), testCase.count)
			}
		})
	}
}

func TestCollectDocumentsAcceptsUploadsAndPaste(t *testing.T) {
	paste := importPayload{Content: "  " + `{"provider":"codex","env":{}}` + "  "}
	documents := paste.collectDocuments()
	if len(documents) != 1 || documents[0].Name != pasteSourceName {
		t.Fatalf("粘贴内容应折叠成一个来源: %+v", documents)
	}
	if strings.HasPrefix(documents[0].Content, " ") {
		t.Fatalf("粘贴内容应去掉首尾空白: %q", documents[0].Content)
	}

	encoded := "eyJwcm92aWRlciI6ImNvZGV4IiwiZW52Ijp7fX0=" // {"provider":"codex","env":{}}
	files, err := json.Marshal(map[string]any{"files": []map[string]string{
		{"name": "data:text/plain,accounts.json", "contentBase64": "data:application/json;base64," + encoded},
		{"name": "notes.md", "contentBase64": encoded},
		{"name": "empty.txt", "content": ""},
	}})
	if err != nil {
		t.Fatal(err)
	}
	var payload importPayload
	if err := json.Unmarshal(files, &payload); err != nil {
		t.Fatal(err)
	}
	documents = payload.collectDocuments()
	if len(documents) != 1 || documents[0].Name != "data:text/plain,accounts.json" {
		t.Fatalf("只应保留 .json/.txt 且非空的文件: %+v", documents)
	}
	if !strings.Contains(documents[0].Content, `"provider":"codex"`) {
		t.Fatalf("base64 未正确解码: %q", documents[0].Content)
	}

	if documents := (importPayload{}).collectDocuments(); len(documents) != 0 {
		t.Fatalf("空负载不应产生来源: %+v", documents)
	}
}

func TestJobFailsWithoutContent(t *testing.T) {
	publisher := newRecordingPublisher()
	handler := mustHandler(t, Dependencies{
		Authorizer: allowAll{}, Importer: &fakeImporter{}, Publisher: publisher,
	})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, strings.NewReader(`{"mode":"upload"}`)))
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("期望 202，得到 %d", recorder.Code)
	}
	view := publisher.waitForStatus(t, jobStatusFailed)
	if view.Error != importErrorMissingContent {
		t.Fatalf("失败原因 = %q，期望 %q", view.Error, importErrorMissingContent)
	}
	if !strings.Contains(view.Logs, "导入失败："+importErrorMissingContent) {
		t.Fatalf("失败日志缺失: %q", view.Logs)
	}
}

func mustHandler(t *testing.T, dependencies Dependencies) *Handler {
	t.Helper()
	handler, err := NewHandler(dependencies)
	if err != nil {
		t.Fatal(err)
	}
	return handler
}
