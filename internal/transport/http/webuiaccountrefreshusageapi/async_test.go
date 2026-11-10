package webuiaccountrefreshusageapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/madou1217/ai_home/internal/transport/http/webuirefreshjobstore"
)

// gatedProbe 是「已经开始、还没结束」的假探测端口：用来验证 202 在探测完成前
// 就返回，以及同账号的第二个请求复用活动作业。
type gatedProbe struct {
	started chan struct{}
	gate    chan struct{}
	once    sync.Once
	calls   atomic.Int32
	err     error
}

func newGatedProbe() *gatedProbe {
	return &gatedProbe{started: make(chan struct{}, 8), gate: make(chan struct{})}
}

func (probe *gatedProbe) ProbeQuota(ctx context.Context, _ string, _ string) (Snapshot, error) {
	probe.calls.Add(1)
	probe.started <- struct{}{}
	select {
	case <-probe.gate:
	case <-ctx.Done():
		return Snapshot{}, ctx.Err()
	}
	return validSnapshot(), probe.err
}

// waitStarted 等到探测真正开始；探测没被调用时直接失败，避免测试假通过。
func (probe *gatedProbe) waitStarted(t *testing.T) {
	t.Helper()
	select {
	case <-probe.started:
	case <-time.After(2 * time.Second):
		t.Fatal("作业登记后没有开始探测")
	}
}

// unblock 放行探测；重复调用安全。
func (probe *gatedProbe) unblock() { probe.once.Do(func() { close(probe.gate) }) }

// newAsyncTestHandler 组装一个只挂 POST refresh-usage 的异步入口，并返回共享作业表。
func newAsyncTestHandler(
	t *testing.T,
	accounts AccountLookup,
	probe QuotaProbe,
	timeout time.Duration,
) (*AsyncHandler, *webuirefreshjobstore.Store, http.Handler) {
	t.Helper()
	executor := newRawHandler(t, accounts, probe, timeout)
	jobs := webuirefreshjobstore.New(webuirefreshjobstore.Options{})
	async, err := NewAsyncHandler(executor, jobs)
	if err != nil {
		t.Fatalf("NewAsyncHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("POST "+Path+RefreshUsageSuffix, async)
	return async, jobs, mux
}

// waitForJobTerminal 轮询作业表直到作业进入终态；超时直接失败。
func waitForJobTerminal(
	t *testing.T,
	jobs *webuirefreshjobstore.Store,
	id string,
) webuirefreshjobstore.Snapshot {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		snapshot, found := jobs.Get(id)
		if !found {
			t.Fatalf("作业 %s 不在作业表里", id)
		}
		switch snapshot.Status {
		case webuirefreshjobstore.StatusSucceeded, webuirefreshjobstore.StatusFailed:
			return snapshot
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("作业 %s 在 3s 内没有进入终态", id)
	return webuirefreshjobstore.Snapshot{}
}

// jobView 取出响应里的 job 对象。
func jobView(t *testing.T, decoded map[string]any) map[string]any {
	t.Helper()
	job, ok := decoded["job"].(map[string]any)
	if !ok {
		t.Fatalf("响应里没有 job 对象: %v", decoded)
	}
	return job
}

// jobID 取出响应里的作业标识。
func jobID(t *testing.T, job map[string]any) string {
	t.Helper()
	id, ok := job["id"].(string)
	if !ok || id == "" {
		t.Fatalf("job.id = %v", job["id"])
	}
	return id
}

func TestAsyncRefreshUsageReturnsQueuedJobImmediately(t *testing.T) {
	probe := newGatedProbe()
	_, jobs, handler := newAsyncTestHandler(t, knownAccounts(), probe, 0)

	startedAt := time.Now()
	recorder, decoded := postRefreshUsage(t, handler, testProvider, testAccountRef)
	elapsed := time.Since(startedAt)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if elapsed > 2*time.Second {
		t.Fatalf("202 必须在探测完成前返回，实际等了 %v", elapsed)
	}
	if decoded["ok"] != true || decoded["accepted"] != true || decoded["alreadyRunning"] != false {
		t.Fatalf("body = %v", decoded)
	}
	job := jobView(t, decoded)
	if job["status"] != webuirefreshjobstore.StatusQueued {
		t.Fatalf("job.status = %v, want queued", job["status"])
	}
	if value, present := job["finishedAt"]; !present || value != nil {
		t.Fatalf("finishedAt = %v (present=%v)，未完成必须是 null", value, present)
	}
	assertNoStore(t, recorder)

	probe.waitStarted(t)
	// 探测还没结束，作业必须仍是活动状态且没有终态时间。
	if snapshot, found := jobs.Get(jobID(t, job)); !found || snapshot.FinishedAt != nil {
		t.Fatalf("未完成的作业不应有 finishedAt: %+v (found=%v)", snapshot, found)
	}

	probe.unblock()
	snapshot := waitForJobTerminal(t, jobs, jobID(t, job))
	if snapshot.Status != webuirefreshjobstore.StatusSucceeded {
		t.Fatalf("终态 = %q, error = %q", snapshot.Status, snapshot.Error)
	}
}

func TestAsyncRefreshUsageCompletesWithSucceededJob(t *testing.T) {
	probe := &fakeProbe{snapshot: validSnapshot()}
	_, jobs, handler := newAsyncTestHandler(t, knownAccounts(), probe, 0)

	// 路径里的 provider 大小写归一后才是作业身份，与同步入口同一口径。
	recorder, decoded := postRefreshUsage(t, handler, "CODEX", testAccountRef)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	job := jobView(t, decoded)
	snapshot := waitForJobTerminal(t, jobs, jobID(t, job))
	if snapshot.Status != webuirefreshjobstore.StatusSucceeded {
		t.Fatalf("终态 = %q, error = %q", snapshot.Status, snapshot.Error)
	}
	if snapshot.Provider != testProvider || snapshot.AccountRef != testAccountRef ||
		snapshot.Scope != UsageJobScope {
		t.Fatalf("作业身份 = %+v", snapshot)
	}
	if snapshot.FinishedAt == nil || *snapshot.FinishedAt < snapshot.CreatedAt {
		t.Fatalf("finishedAt = %v, createdAt = %d", snapshot.FinishedAt, snapshot.CreatedAt)
	}
	if snapshot.Error != "" {
		t.Fatalf("成功作业不得带 error: %q", snapshot.Error)
	}
	if len(snapshot.FailedBranches) != 0 || len(snapshot.Branches) != 0 {
		t.Fatalf("额度作业不得有分段明细: %+v", snapshot)
	}
	if probe.receivedProvider != testProvider || probe.receivedRef != testAccountRef {
		t.Fatalf("probe received %q/%q", probe.receivedProvider, probe.receivedRef)
	}
}

func TestAsyncRefreshUsageRecordsProbeFailure(t *testing.T) {
	probe := &fakeProbe{err: errors.New("upstream 500")}
	_, jobs, handler := newAsyncTestHandler(t, knownAccounts(), probe, 0)

	recorder, decoded := postRefreshUsage(t, handler, testProvider, testAccountRef)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	snapshot := waitForJobTerminal(t, jobs, jobID(t, jobView(t, decoded)))
	if snapshot.Status != webuirefreshjobstore.StatusFailed {
		t.Fatalf("终态 = %q, want failed", snapshot.Status)
	}
	if snapshot.Error != "upstream 500" {
		t.Fatalf("error = %q", snapshot.Error)
	}
	if snapshot.FinishedAt == nil {
		t.Fatal("失败作业必须有 finishedAt")
	}
	// 探测失败只影响作业结果，不该伪造分段失败明细。
	if len(snapshot.FailedBranches) != 0 || len(snapshot.Branches) != 0 {
		t.Fatalf("额度作业不得有分段明细: %+v", snapshot)
	}
}

func TestAsyncRefreshUsageTruncatesProbeError(t *testing.T) {
	probe := &fakeProbe{err: errors.New(strings.Repeat("额度探测失败", 200))}
	_, jobs, handler := newAsyncTestHandler(t, knownAccounts(), probe, 0)

	recorder, decoded := postRefreshUsage(t, handler, testProvider, testAccountRef)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	snapshot := waitForJobTerminal(t, jobs, jobID(t, jobView(t, decoded)))
	if got := len([]rune(snapshot.Error)); got != maxJobErrorRunes {
		t.Fatalf("error 长度 = %d, want %d", got, maxJobErrorRunes)
	}
	// 按 rune 截断：不能把多字节字符切成半个。
	if !utf8.ValidString(snapshot.Error) {
		t.Fatalf("error 不是合法 UTF-8: %q", snapshot.Error)
	}
}

func TestAsyncRefreshUsageWithoutProbeReturnsNotImplemented(t *testing.T) {
	_, jobs, handler := newAsyncTestHandler(t, knownAccounts(), nil, 0)

	recorder, decoded := postRefreshUsage(t, handler, testProvider, testAccountRef)
	if recorder.Code != http.StatusNotImplemented ||
		decoded["error"] != "quota_refresh_unavailable" {
		t.Fatalf("status = %d, error = %v", recorder.Code, decoded["error"])
	}
	// 未接线的端口不能留下一条注定失败的作业记录。
	if count := jobs.Len(); count != 0 {
		t.Fatalf("作业表条数 = %d, want 0", count)
	}
}

func TestAsyncRefreshUsageReusesActiveJob(t *testing.T) {
	probe := newGatedProbe()
	_, jobs, handler := newAsyncTestHandler(t, knownAccounts(), probe, 0)

	_, first := postRefreshUsage(t, handler, testProvider, testAccountRef)
	firstJob := jobView(t, first)
	probe.waitStarted(t)

	recorder, second := postRefreshUsage(t, handler, testProvider, testAccountRef)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if second["alreadyRunning"] != true {
		t.Fatalf("alreadyRunning = %v, want true", second["alreadyRunning"])
	}
	secondJob := jobView(t, second)
	if jobID(t, secondJob) != jobID(t, firstJob) {
		t.Fatalf("复用作业 id = %v, want %v", secondJob["id"], firstJob["id"])
	}
	switch secondJob["status"] {
	case webuirefreshjobstore.StatusQueued, webuirefreshjobstore.StatusRunning:
	default:
		t.Fatalf("复用作业状态 = %v", secondJob["status"])
	}
	if count := jobs.Len(); count != 1 {
		t.Fatalf("作业表条数 = %d, want 1", count)
	}

	probe.unblock()
	if snapshot := waitForJobTerminal(t, jobs, jobID(t, firstJob)); snapshot.Status !=
		webuirefreshjobstore.StatusSucceeded {
		t.Fatalf("终态 = %q, error = %q", snapshot.Status, snapshot.Error)
	}
	// 复用意味着上游只被打一次。
	if calls := probe.calls.Load(); calls != 1 {
		t.Fatalf("探测次数 = %d, want 1", calls)
	}
}

func TestAsyncRefreshUsageRejectsUnauthorized(t *testing.T) {
	probe := newGatedProbe()
	executor, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: false},
		Accounts:   knownAccounts(),
		QuotaProbe: probe,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	jobs := webuirefreshjobstore.New(webuirefreshjobstore.Options{})
	async, err := NewAsyncHandler(executor, jobs)
	if err != nil {
		t.Fatalf("NewAsyncHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("POST "+Path+RefreshUsageSuffix, async)

	recorder, decoded := postRefreshUsage(t, mux, testProvider, testAccountRef)
	if recorder.Code != http.StatusUnauthorized || decoded["error"] != "unauthorized" {
		t.Fatalf("status = %d, error = %v", recorder.Code, decoded["error"])
	}
	if challenge := recorder.Header().Get("WWW-Authenticate"); challenge != "Bearer" {
		t.Fatalf("WWW-Authenticate = %q, want Bearer", challenge)
	}
	if jobs.Len() != 0 || probe.calls.Load() != 0 {
		t.Fatalf("未鉴权请求不得登记作业或触发探测")
	}
}

func TestAsyncRefreshUsageRejectsNonPost(t *testing.T) {
	probe := newGatedProbe()
	async, _, _ := newAsyncTestHandler(t, knownAccounts(), probe, 0)

	request := httptest.NewRequest(http.MethodGet, "/irrelevant", nil)
	request.SetPathValue("provider", testProvider)
	request.SetPathValue("accountRef", testAccountRef)
	recorder := httptest.NewRecorder()
	async.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if allow := recorder.Header().Get("Allow"); allow != http.MethodPost {
		t.Fatalf("Allow = %q", allow)
	}
	var decoded map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("decode %q: %v", recorder.Body.String(), err)
	}
	if decoded["error"] != "method_not_allowed" {
		t.Fatalf("error = %v", decoded["error"])
	}
	if probe.calls.Load() != 0 {
		t.Fatal("非 POST 不得触发探测")
	}
}

func TestAsyncRefreshUsageRejectsEmptyPath(t *testing.T) {
	probe := newGatedProbe()
	async, jobs, _ := newAsyncTestHandler(t, knownAccounts(), probe, 0)

	request := httptest.NewRequest(http.MethodPost, "/irrelevant", nil)
	request.SetPathValue("provider", testProvider)
	request.SetPathValue("accountRef", "   ")
	recorder := httptest.NewRecorder()
	async.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var decoded map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("decode %q: %v", recorder.Body.String(), err)
	}
	if decoded["error"] != "invalid_account_path" {
		t.Fatalf("error = %v", decoded["error"])
	}
	if jobs.Len() != 0 || probe.calls.Load() != 0 {
		t.Fatal("空账号路径不得登记作业或触发探测")
	}
}

func TestAsyncRefreshUsageRejectsUnknownAccountAndProviderMismatch(t *testing.T) {
	probe := newGatedProbe()
	_, unknownJobs, unknownHandler := newAsyncTestHandler(t, fakeAccounts{}, probe, 0)
	recorder, decoded := postRefreshUsage(t, unknownHandler, testProvider, testAccountRef)
	if recorder.Code != http.StatusNotFound || decoded["error"] != "account_not_found" {
		t.Fatalf("unknown: status = %d, error = %v", recorder.Code, decoded["error"])
	}
	if unknownJobs.Len() != 0 {
		t.Fatal("账号不存在时不得登记作业")
	}

	_, mismatchJobs, mismatchHandler := newAsyncTestHandler(t, knownAccounts(), probe, 0)
	recorder, decoded = postRefreshUsage(t, mismatchHandler, "claude", testAccountRef)
	if recorder.Code != http.StatusNotFound || decoded["error"] != "account_not_found" {
		t.Fatalf("mismatch: status = %d, error = %v", recorder.Code, decoded["error"])
	}
	if mismatchJobs.Len() != 0 {
		t.Fatal("Provider 不匹配时不得登记作业")
	}
	if probe.calls.Load() != 0 {
		t.Fatalf("探测次数 = %d, want 0", probe.calls.Load())
	}
}

func TestAsyncRefreshUsageMapsLookupFailure(t *testing.T) {
	probe := newGatedProbe()
	_, jobs, handler := newAsyncTestHandler(t, fakeAccounts{err: errors.New("db locked")}, probe, 0)

	recorder, decoded := postRefreshUsage(t, handler, testProvider, testAccountRef)
	if recorder.Code != http.StatusInternalServerError || decoded["error"] != "account_lookup_failed" {
		t.Fatalf("status = %d, error = %v", recorder.Code, decoded["error"])
	}
	if jobs.Len() != 0 || probe.calls.Load() != 0 {
		t.Fatal("账号读取失败时不得登记作业或触发探测")
	}
}

func TestAsyncRefreshUsageFailsClosedWithoutDependencies(t *testing.T) {
	var nilHandler *AsyncHandler
	for name, handler := range map[string]*AsyncHandler{
		"nil_handler":  nilHandler,
		"zero_handler": {},
	} {
		t.Run(name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/", nil))
			if recorder.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
			}
			var decoded map[string]any
			if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
				t.Fatalf("decode %q: %v", recorder.Body.String(), err)
			}
			if decoded["error"] != "quota_refresh_unavailable" {
				t.Fatalf("error = %v", decoded["error"])
			}
		})
	}
}

// TestAsyncRefreshUsageJobJSONOmitsBranches 锁定 usage 作业的 JSON 形状：没有
// branches/failedBranches/recovered，finishedAt 未完成是 null，error 始终存在。
func TestAsyncRefreshUsageJobJSONOmitsBranches(t *testing.T) {
	probe := &fakeProbe{snapshot: validSnapshot()}
	_, jobs, handler := newAsyncTestHandler(t, knownAccounts(), probe, 0)

	recorder, decoded := postRefreshUsage(t, handler, testProvider, testAccountRef)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	job := jobView(t, decoded)
	if job["scope"] != UsageJobScope {
		t.Fatalf("job.scope = %v, want %q", job["scope"], UsageJobScope)
	}
	for _, key := range []string{"branches", "failedBranches", "recovered"} {
		if value, present := job[key]; present {
			t.Fatalf("usage 作业不得携带 %s（%v）", key, value)
		}
	}
	if message, present := job["error"]; !present || message != "" {
		t.Fatalf("error = %v (present=%v)，成功路径必须是空串", message, present)
	}

	// 终态同样不带 branches：额度作业没有分段明细。
	snapshot := waitForJobTerminal(t, jobs, jobID(t, job))
	raw, err := json.Marshal(jobFromSnapshot(snapshot))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var finished map[string]any
	if err := json.Unmarshal(raw, &finished); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	for _, key := range []string{"branches", "failedBranches", "recovered"} {
		if value, present := finished[key]; present {
			t.Fatalf("终态 usage 作业不得携带 %s（%v）", key, value)
		}
	}
	if finished["scope"] != UsageJobScope {
		t.Fatalf("终态 scope = %v", finished["scope"])
	}
	if finishedAt, _ := finished["finishedAt"].(float64); finishedAt <= 0 {
		t.Fatalf("终态 finishedAt = %v, want 毫秒时间戳", finished["finishedAt"])
	}
}

func TestAsyncRefreshUsageAppliesExecutorTimeout(t *testing.T) {
	probe := &fakeProbe{waitForContext: true}
	_, jobs, handler := newAsyncTestHandler(t, knownAccounts(), probe, 20*time.Millisecond)

	before := time.Now()
	recorder, decoded := postRefreshUsage(t, handler, testProvider, testAccountRef)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	snapshot := waitForJobTerminal(t, jobs, jobID(t, jobView(t, decoded)))
	if snapshot.Status != webuirefreshjobstore.StatusFailed {
		t.Fatalf("终态 = %q, want failed", snapshot.Status)
	}
	if !strings.Contains(snapshot.Error, "deadline exceeded") {
		t.Fatalf("error = %q, want 超时摘要", snapshot.Error)
	}
	if probe.observedDeadline.IsZero() {
		t.Fatal("探测必须收到带截止时间的 ctx")
	}
	if remaining := probe.observedDeadline.Sub(before); remaining <= 0 || remaining > time.Second {
		t.Fatalf("deadline = %v, want ≈20ms", remaining)
	}
}

func TestNewAsyncHandlerRejectsMissingDependencies(t *testing.T) {
	executor := newRawHandler(t, knownAccounts(), &fakeProbe{}, 0)
	jobs := webuirefreshjobstore.New(webuirefreshjobstore.Options{})

	if _, err := NewAsyncHandler(nil, jobs); !errors.Is(err, ErrInvalidAsyncDependencies) {
		t.Fatalf("nil executor error = %v", err)
	}
	if _, err := NewAsyncHandler(executor, nil); !errors.Is(err, ErrInvalidAsyncDependencies) {
		t.Fatalf("nil jobs error = %v", err)
	}
	// 执行器缺鉴权/账号端口时也不能接受：否则作业会被接受再在后台失败。
	if _, err := NewAsyncHandler(&Handler{}, jobs); !errors.Is(err, ErrInvalidAsyncDependencies) {
		t.Fatalf("zero executor error = %v", err)
	}
}
