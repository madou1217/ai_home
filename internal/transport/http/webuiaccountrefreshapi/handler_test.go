package webuiaccountrefreshapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

const (
	testProvider = "codex"
	testRefText  = "acct_0123456789abcdef0123"
)

var testTime = time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)

type testAuthorizer bool

func (authorizer testAuthorizer) Authorized(*http.Request) bool { return bool(authorizer) }

type stubDirectory struct {
	account accountcore.Account
	err     error
}

func (directory stubDirectory) GetByRef(
	_ context.Context,
	_ accountcore.AccountRef,
) (accountcore.Account, error) {
	if directory.err != nil {
		return accountcore.Account{}, directory.err
	}
	return directory.account, nil
}

type stubStatusRefresher struct {
	run func(ctx context.Context) error
}

func (stub stubStatusRefresher) RefreshAccountStatus(
	ctx context.Context,
	_ accountcore.AccountRef,
) error {
	if stub.run == nil {
		return nil
	}
	return stub.run(ctx)
}

type stubModelRefresher struct {
	run func(ctx context.Context) error
}

func (stub stubModelRefresher) RefreshAccountModels(
	ctx context.Context,
	_ accountcore.AccountRef,
) ([]accountapp.AccountModel, error) {
	if stub.run == nil {
		return nil, nil
	}
	return nil, stub.run(ctx)
}

type stubQuotaRefresher struct {
	run func(ctx context.Context) error
}

func (stub stubQuotaRefresher) RefreshUsage(
	ctx context.Context,
	_ accountcore.AccountRef,
) (accountusage.ReadResult, error) {
	if stub.run == nil {
		return accountusage.ReadResult{}, nil
	}
	return accountusage.ReadResult{}, stub.run(ctx)
}

func testAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	accountRef, err := accountcore.ParseAccountRef(testRefText)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return accountRef
}

func testAccount(t *testing.T, provider string) accountcore.Account {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref:          testAccountRef(t),
		ProviderID:   provider,
		CLIAccountID: accountcore.CLIAccountID(1),
		Enabled:      true,
		CreatedAt:    testTime,
		UpdatedAt:    testTime,
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	return account
}

func newRefreshHandler(t *testing.T, dependencies Dependencies) *Handler {
	t.Helper()
	handler, err := NewHandler(dependencies)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func newRefreshRequest(provider string, accountRef string) *http.Request {
	request := httptest.NewRequest(
		http.MethodPost,
		Path+"/"+provider+"/"+accountRef+"/refresh",
		nil,
	)
	request.SetPathValue("provider", provider)
	request.SetPathValue("accountRef", accountRef)
	return request
}

func postRefresh(
	t *testing.T,
	handler *Handler,
	provider string,
	accountRef string,
) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, newRefreshRequest(provider, accountRef))
	return recorder
}

func decodeRefreshResponse(t *testing.T, recorder *httptest.ResponseRecorder) Response {
	t.Helper()
	var payload Response
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode refresh body %q: %v", recorder.Body.String(), err)
	}
	return payload
}

func decodeRefreshError(t *testing.T, recorder *httptest.ResponseRecorder) errorResponse {
	t.Helper()
	var payload errorResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode error body %q: %v", recorder.Body.String(), err)
	}
	return payload
}

// decodeJSONMap 把响应体解成通用 map，用于逐字段断言 JSON 形状。
func decodeJSONMap(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("decode json body %q: %v", string(body), err)
	}
	return payload
}

// assertJSONKeys 断言 JSON 对象的键集合完全一致，多一个少一个都算契约漂移。
func assertJSONKeys(t *testing.T, payload map[string]any, want ...string) {
	t.Helper()
	got := make([]string, 0, len(payload))
	for key := range payload {
		got = append(got, key)
	}
	sort.Strings(got)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("JSON keys = %v, want %v (payload = %v)", got, want, payload)
	}
}

// allSucceeded 返回三段都成功的依赖。
func allSucceeded(t *testing.T) Dependencies {
	t.Helper()
	return Dependencies{
		Authorizer:      testAuthorizer(true),
		Accounts:        stubDirectory{account: testAccount(t, testProvider)},
		StatusRefresher: stubStatusRefresher{run: func(context.Context) error { return nil }},
		ModelRefresher:  stubModelRefresher{run: func(context.Context) error { return nil }},
		QuotaRefresher:  stubQuotaRefresher{run: func(context.Context) error { return nil }},
	}
}

func TestNewHandlerValidatesDependencies(t *testing.T) {
	validAuthorizer := testAuthorizer(true)
	validDirectory := stubDirectory{account: testAccount(t, testProvider)}
	cases := []struct {
		name         string
		dependencies Dependencies
	}{
		{name: "missing authorizer", dependencies: Dependencies{Accounts: validDirectory}},
		{name: "missing accounts", dependencies: Dependencies{Authorizer: validAuthorizer}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := NewHandler(testCase.dependencies); !errors.Is(err, ErrInvalidDependencies) {
				t.Fatalf("NewHandler() error = %v, want %v", err, ErrInvalidDependencies)
			}
		})
	}
}

func TestRefreshRejectsUnauthorized(t *testing.T) {
	handler := newRefreshHandler(t, Dependencies{
		Authorizer: testAuthorizer(false),
		Accounts:   stubDirectory{account: testAccount(t, testProvider)},
	})

	recorder := postRefresh(t, handler, testProvider, testRefText)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if challenge := recorder.Header().Get("WWW-Authenticate"); challenge != "Bearer" {
		t.Fatalf("WWW-Authenticate = %q, want Bearer", challenge)
	}
	if payload := decodeRefreshError(t, recorder); payload.Error != "unauthorized" {
		t.Fatalf("error = %q, want unauthorized", payload.Error)
	}
}

func TestRefreshRejectsMethod(t *testing.T) {
	handler := newRefreshHandler(t, allSucceeded(t))
	request := newRefreshRequest(testProvider, testRefText)
	request.Method = http.MethodGet
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if allow := recorder.Header().Get("Allow"); allow != http.MethodPost {
		t.Fatalf("Allow = %q, want %q", allow, http.MethodPost)
	}
}

func TestRefreshRejectsInvalidPath(t *testing.T) {
	cases := []struct {
		name     string
		provider string
		ref      string
	}{
		{name: "invalid provider", provider: "Codex!", ref: testRefText},
		{name: "invalid account ref", provider: testProvider, ref: "acct_short"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler := newRefreshHandler(t, Dependencies{
				Authorizer: testAuthorizer(true),
				Accounts:   stubDirectory{account: testAccount(t, testProvider)},
			})

			recorder := postRefresh(t, handler, testCase.provider, testCase.ref)

			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
			}
			if payload := decodeRefreshError(t, recorder); payload.Error != "invalid_account_path" {
				t.Fatalf("error = %q, want invalid_account_path", payload.Error)
			}
		})
	}
}

func TestRefreshRejectsUnknownAccount(t *testing.T) {
	handler := newRefreshHandler(t, Dependencies{
		Authorizer: testAuthorizer(true),
		Accounts:   stubDirectory{err: accountapp.ErrAccountNotFound},
	})

	recorder := postRefresh(t, handler, testProvider, testRefText)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if payload := decodeRefreshError(t, recorder); payload.Error != "account_not_found" {
		t.Fatalf("error = %q, want account_not_found", payload.Error)
	}
}

func TestRefreshRejectsProviderMismatch(t *testing.T) {
	handler := newRefreshHandler(t, Dependencies{
		Authorizer: testAuthorizer(true),
		Accounts:   stubDirectory{account: testAccount(t, "claude")},
	})

	recorder := postRefresh(t, handler, testProvider, testRefText)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if payload := decodeRefreshError(t, recorder); payload.Error != "account_not_found" {
		t.Fatalf("error = %q, want account_not_found", payload.Error)
	}
}

func TestRefreshSucceedsAllBranches(t *testing.T) {
	handler := newRefreshHandler(t, allSucceeded(t))

	recorder := postRefresh(t, handler, testProvider, testRefText)

	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	payload := decodeRefreshResponse(t, recorder)
	if !payload.OK || !payload.Accepted {
		t.Fatalf("payload = %+v, want ok/accepted", payload)
	}
	if payload.AlreadyRunning {
		t.Fatalf("alreadyRunning = true, want false for the first request")
	}
	job := payload.Job
	if job.Status != jobStatusSucceeded {
		t.Fatalf("job.status = %q, want succeeded", job.Status)
	}
	if job.Provider != testProvider || job.AccountRef != testRefText {
		t.Fatalf("job = %+v, want provider/accountRef 归一", job)
	}
	if job.Scope != JobScopeAccount {
		t.Fatalf("job.scope = %q, want %q", job.Scope, JobScopeAccount)
	}
	if job.Error != "" {
		t.Fatalf("job.error = %q, want empty", job.Error)
	}
	if len(job.FailedBranches) != 0 {
		t.Fatalf("failedBranches = %v, want empty", job.FailedBranches)
	}
	if job.FinishedAt == nil {
		t.Fatal("finishedAt = nil, want 终态毫秒")
	}
	if job.CreatedAt <= 0 || job.UpdatedAt < job.CreatedAt || *job.FinishedAt < job.UpdatedAt {
		t.Fatalf("时间戳不单调：%+v", job)
	}
	for _, name := range []string{BranchStatus, BranchModels, BranchUsage} {
		branch, found := job.Branches[name]
		if !found {
			t.Fatalf("branch %q missing from %+v", name, job.Branches)
		}
		if branch.Status != branchStatusSucceeded || branch.Error != "" {
			t.Fatalf("branch %q = %+v, want succeeded", name, branch)
		}
	}
}

func TestRefreshKeepsSuccessfulBranchesWhenStatusFails(t *testing.T) {
	dependencies := allSucceeded(t)
	dependencies.StatusRefresher = stubStatusRefresher{run: func(context.Context) error {
		return errors.New("凭据已失效")
	}}
	handler := newRefreshHandler(t, dependencies)

	recorder := postRefresh(t, handler, testProvider, testRefText)

	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	job := decodeRefreshResponse(t, recorder).Job
	// 只有一段失败时作业整体仍算成功：其它面已经刷新过了。
	if job.Status != jobStatusSucceeded {
		t.Fatalf("job.status = %q, want succeeded", job.Status)
	}
	if !reflect.DeepEqual(job.FailedBranches, []string{BranchStatus}) {
		t.Fatalf("failedBranches = %v, want [status]", job.FailedBranches)
	}
	if !strings.Contains(job.Error, "状态：") {
		t.Fatalf("job.error = %q, want 含「状态：」", job.Error)
	}
	if !strings.Contains(job.Error, "凭据已失效") {
		t.Fatalf("job.error = %q, want 带上游错误", job.Error)
	}
	if branch := job.Branches[BranchStatus]; branch.Status != branchStatusFailed ||
		branch.Error != "凭据已失效" {
		t.Fatalf("status branch = %+v, want failed 凭据已失效", branch)
	}
	for _, name := range []string{BranchModels, BranchUsage} {
		if branch := job.Branches[name]; branch.Status != branchStatusSucceeded {
			t.Fatalf("branch %q = %+v, want succeeded", name, branch)
		}
	}
}

func TestRefreshReportsAllFailedAsFailed(t *testing.T) {
	fail := func(context.Context) error { return errors.New("boom") }
	dependencies := allSucceeded(t)
	dependencies.StatusRefresher = stubStatusRefresher{run: fail}
	dependencies.ModelRefresher = stubModelRefresher{run: fail}
	dependencies.QuotaRefresher = stubQuotaRefresher{run: fail}
	handler := newRefreshHandler(t, dependencies)

	recorder := postRefresh(t, handler, testProvider, testRefText)

	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	job := decodeRefreshResponse(t, recorder).Job
	if job.Status != jobStatusFailed {
		t.Fatalf("job.status = %q, want failed", job.Status)
	}
	if !reflect.DeepEqual(job.FailedBranches,
		[]string{BranchStatus, BranchModels, BranchUsage}) {
		t.Fatalf("failedBranches = %v", job.FailedBranches)
	}
	for _, name := range []string{BranchStatus, BranchModels, BranchUsage} {
		if branch := job.Branches[name]; branch.Status != branchStatusFailed {
			t.Fatalf("branch %q = %+v, want failed", name, branch)
		}
	}
}

func TestRefreshMarksUnavailableBranches(t *testing.T) {
	handler := newRefreshHandler(t, Dependencies{
		Authorizer: testAuthorizer(true),
		Accounts:   stubDirectory{account: testAccount(t, testProvider)},
	})

	recorder := postRefresh(t, handler, testProvider, testRefText)

	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	job := decodeRefreshResponse(t, recorder).Job
	if job.Status != jobStatusFailed {
		t.Fatalf("job.status = %q, want failed when every refresher is missing", job.Status)
	}
	for _, name := range []string{BranchStatus, BranchModels, BranchUsage} {
		branch, found := job.Branches[name]
		if !found {
			t.Fatalf("branch %q missing from %+v", name, job.Branches)
		}
		if branch.Status != branchStatusFailed {
			t.Fatalf("branch %q = %+v, want failed", name, branch)
		}
		// 作业 JSON 只暴露 status/error，未接线必须能从文案里认出稳定错误码。
		if !strings.Contains(branch.Error, codeRefreshUnavailable) {
			t.Fatalf("branch %q error = %q, want 含 %q", name, branch.Error, codeRefreshUnavailable)
		}
	}
}

func TestRefreshRunsBranchesConcurrently(t *testing.T) {
	started := make(chan struct{}, 3)
	release := make(chan struct{})
	waitForPeers := func(ctx context.Context) error {
		started <- struct{}{}
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	dependencies := allSucceeded(t)
	dependencies.StatusRefresher = stubStatusRefresher{run: waitForPeers}
	dependencies.ModelRefresher = stubModelRefresher{run: waitForPeers}
	dependencies.QuotaRefresher = stubQuotaRefresher{run: waitForPeers}
	dependencies.Timeout = 2 * time.Second
	handler := newRefreshHandler(t, dependencies)
	recorder := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(recorder, newRefreshRequest(testProvider, testRefText))
		close(done)
	}()

	// 三段都进入刷新体之后才放行：串行实现会卡在第二段，这里会超时失败。
	for index := 0; index < 3; index++ {
		select {
		case <-started:
		case <-time.After(2 * time.Second):
			t.Fatal("三段刷新没有并发启动")
		}
	}
	close(release)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("刷新未在预期时间内完成")
	}

	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	job := decodeRefreshResponse(t, recorder).Job
	if job.Status != jobStatusSucceeded || len(job.FailedBranches) != 0 {
		t.Fatalf("job = %+v, want all branches succeeded", job)
	}
}

func TestRefreshMarksUnfinishedBranchesAsTimeout(t *testing.T) {
	blockUntilDone := func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	}
	dependencies := allSucceeded(t)
	dependencies.ModelRefresher = stubModelRefresher{run: blockUntilDone}
	dependencies.QuotaRefresher = stubQuotaRefresher{run: blockUntilDone}
	dependencies.Timeout = 50 * time.Millisecond
	handler := newRefreshHandler(t, dependencies)

	recorder := postRefresh(t, handler, testProvider, testRefText)

	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	job := decodeRefreshResponse(t, recorder).Job
	if job.Status != jobStatusSucceeded {
		t.Fatalf("job.status = %q, want succeeded when status branch succeeded", job.Status)
	}
	if branch := job.Branches[BranchStatus]; branch.Status != branchStatusSucceeded {
		t.Fatalf("status branch = %+v, want succeeded", branch)
	}
	for _, name := range []string{BranchModels, BranchUsage} {
		branch := job.Branches[name]
		if branch.Status != branchStatusFailed {
			t.Fatalf("branch %q = %+v, want failed（超时段）", name, branch)
		}
		if !strings.Contains(branch.Error, codeTimeout) {
			t.Fatalf("branch %q error = %q, want 含 %q", name, branch.Error, codeTimeout)
		}
	}
	if !reflect.DeepEqual(job.FailedBranches, []string{BranchModels, BranchUsage}) {
		t.Fatalf("failedBranches = %v, want [models usage]", job.FailedBranches)
	}
}

// gatedDirectory 让第二个请求在读完账号后停住，测试可以精确控制它进入复用分支的时机。
type gatedDirectory struct {
	account    accountcore.Account
	mu         sync.Mutex
	calls      int
	secondRead chan struct{}
	secondGate chan struct{}
}

func (directory *gatedDirectory) GetByRef(
	_ context.Context,
	_ accountcore.AccountRef,
) (accountcore.Account, error) {
	directory.mu.Lock()
	directory.calls++
	call := directory.calls
	directory.mu.Unlock()
	if call == 2 {
		close(directory.secondRead)
		<-directory.secondGate
	}
	return directory.account, nil
}

func TestRefreshReusesInflightRun(t *testing.T) {
	var calls atomic.Int64
	dependencies := allSucceeded(t)
	dependencies.StatusRefresher = stubStatusRefresher{run: func(context.Context) error {
		calls.Add(1)
		return nil
	}}
	handler := newRefreshHandler(t, dependencies)
	ref, err := accountcore.ParseAccountRef(testRefText)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}

	// 直接登记一次「正在执行」的刷新：复用判定只看 inflight 表，不依赖调度时序。
	expected := Job{ID: "inflight-job", Status: jobStatusSucceeded, Scope: JobScopeAccount}
	running := &inflightRun{done: make(chan struct{}), job: expected}
	handler.inflightMu.Lock()
	handler.inflight[testProvider+"\x00"+ref.String()] = running
	handler.inflightMu.Unlock()

	type result struct {
		job            Job
		alreadyRunning bool
	}
	results := make(chan result, 1)
	go func() {
		job, alreadyRunning := handler.refresh(context.Background(), testProvider, ref)
		results <- result{job: job, alreadyRunning: alreadyRunning}
	}()

	// 去重生效时第二个调用不会碰 Refresher，而是等待 done。
	time.Sleep(50 * time.Millisecond)
	if calls.Load() != 0 {
		t.Fatalf("Refresher 调用次数 = %d, want 0（复用不应重新执行）", calls.Load())
	}
	select {
	case got := <-results:
		t.Fatalf("刷新在 inflight 完成前返回: %+v", got)
	default:
	}

	close(running.done)
	select {
	case got := <-results:
		if !got.alreadyRunning {
			t.Fatal("alreadyRunning = false, want true")
		}
		if got.job.ID != expected.ID {
			t.Fatalf("复用应返回同一作业：%q != %q", got.job.ID, expected.ID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("复用调用未在期限内返回")
	}
	if calls.Load() != 0 {
		t.Fatalf("Refresher 调用次数 = %d, want 0", calls.Load())
	}
}

func TestRefreshResponseJSONShape(t *testing.T) {
	handler := newRefreshHandler(t, allSucceeded(t))
	recorder := postRefresh(t, handler, testProvider, testRefText)

	payload := decodeJSONMap(t, recorder.Body.Bytes())
	// durationMs 是 Go 侧附加字段（Node 的 202 没有），其余必须与 Node 同形。
	assertJSONKeys(t, payload, "ok", "accepted", "alreadyRunning", "job", "durationMs")

	job, ok := payload["job"].(map[string]any)
	if !ok {
		t.Fatalf("job = %v, want 对象", payload["job"])
	}
	// 全部成功时 failedBranches 缺省，job 的键集合与 Node serializeAccountRefreshJob 一致。
	assertJSONKeys(t, job,
		"id", "provider", "accountRef", "status", "createdAt", "updatedAt",
		"finishedAt", "error", "scope", "branches")
	if _, isNumber := job["finishedAt"].(float64); !isNumber {
		t.Fatalf("finishedAt = %v, want 毫秒数字", job["finishedAt"])
	}
	if _, isNumber := job["createdAt"].(float64); !isNumber {
		t.Fatalf("createdAt = %v, want 毫秒数字", job["createdAt"])
	}
	if _, isNumber := job["updatedAt"].(float64); !isNumber {
		t.Fatalf("updatedAt = %v, want 毫秒数字", job["updatedAt"])
	}
	if job["status"] != jobStatusSucceeded {
		t.Fatalf("status = %v, want succeeded", job["status"])
	}
	if job["scope"] != JobScopeAccount {
		t.Fatalf("scope = %v, want %q", job["scope"], JobScopeAccount)
	}

	branches, ok := job["branches"].(map[string]any)
	if !ok || len(branches) != 3 {
		t.Fatalf("branches = %v, want 三段", job["branches"])
	}
	for _, name := range []string{BranchStatus, BranchModels, BranchUsage} {
		branch, ok := branches[name].(map[string]any)
		if !ok {
			t.Fatalf("branch %q = %v, want 对象", name, branches[name])
		}
		assertJSONKeys(t, branch, "status", "error")
		if branch["error"] != "" {
			t.Fatalf("branch %q error = %v, want 空串", name, branch["error"])
		}
	}
}

func TestRefreshResponseJSONShapeOnPartialFailure(t *testing.T) {
	dependencies := allSucceeded(t)
	dependencies.StatusRefresher = stubStatusRefresher{run: func(context.Context) error {
		return errors.New("凭据已失效")
	}}
	handler := newRefreshHandler(t, dependencies)
	recorder := postRefresh(t, handler, testProvider, testRefText)

	job, ok := decodeJSONMap(t, recorder.Body.Bytes())["job"].(map[string]any)
	if !ok {
		t.Fatalf("job = %v, want 对象", recorder.Body.String())
	}
	// 有失败段时 failedBranches 必须出现，且是字符串数组。
	assertJSONKeys(t, job,
		"id", "provider", "accountRef", "status", "createdAt", "updatedAt",
		"finishedAt", "error", "failedBranches", "scope", "branches")
	failed, ok := job["failedBranches"].([]any)
	if !ok || len(failed) != 1 || failed[0] != BranchStatus {
		t.Fatalf("failedBranches = %v, want [status]", job["failedBranches"])
	}
	if errorText, _ := job["error"].(string); !strings.Contains(errorText, "状态：") {
		t.Fatalf("error = %v, want 含「状态：」", job["error"])
	}
}

func TestRefreshTruncatesLongError(t *testing.T) {
	longError := errors.New(strings.Repeat("错", maxErrorRunes+20))
	dependencies := allSucceeded(t)
	dependencies.StatusRefresher = stubStatusRefresher{run: func(context.Context) error {
		return longError
	}}
	handler := newRefreshHandler(t, dependencies)

	recorder := postRefresh(t, handler, testProvider, testRefText)

	job := decodeRefreshResponse(t, recorder).Job
	status := job.Branches[BranchStatus]
	if !utf8.ValidString(status.Error) {
		t.Fatalf("error is not valid UTF-8: %q", status.Error)
	}
	if runes := []rune(status.Error); len(runes) != maxErrorRunes+1 {
		t.Fatalf("error runes = %d, want %d", len(runes), maxErrorRunes+1)
	}
	if !strings.HasSuffix(status.Error, "…") {
		t.Fatalf("error = %q, want ellipsis suffix", status.Error)
	}
}

func TestRefreshSkipsNonCatalogModelsAndAPIKeyUsage(t *testing.T) {
	dependencies := allSucceeded(t)
	dependencies.SupportsModelCatalog = func(string) bool { return false }
	dependencies.IsAPIKeyAccount = func(context.Context, accountcore.AccountRef) bool { return true }
	handler := newRefreshHandler(t, dependencies)

	recorder := postRefresh(t, handler, testProvider, testRefText)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202: %s", recorder.Code, recorder.Body.String())
	}
	payload := decodeRefreshResponse(t, recorder)
	if payload.Job.Status != jobStatusSucceeded {
		t.Fatalf("job.status = %q, want %q", payload.Job.Status, jobStatusSucceeded)
	}
	if payload.Job.Branches[BranchModels].Status != branchStatusSkipped {
		t.Fatalf("models branch = %+v, want skipped", payload.Job.Branches[BranchModels])
	}
	if payload.Job.Branches[BranchUsage].Status != branchStatusSkipped {
		t.Fatalf("usage branch = %+v, want skipped", payload.Job.Branches[BranchUsage])
	}
	if payload.Job.Branches[BranchStatus].Status != branchStatusSucceeded {
		t.Fatalf("status branch = %+v, want succeeded", payload.Job.Branches[BranchStatus])
	}
}

func TestRefreshFailsWhenOnlyNonSkippedBranchFails(t *testing.T) {
	dependencies := allSucceeded(t)
	dependencies.SupportsModelCatalog = func(string) bool { return false }
	dependencies.IsAPIKeyAccount = func(context.Context, accountcore.AccountRef) bool { return true }
	dependencies.StatusRefresher = stubStatusRefresher{run: func(context.Context) error {
		return errors.New("status_failed")
	}}
	handler := newRefreshHandler(t, dependencies)

	recorder := postRefresh(t, handler, testProvider, testRefText)
	payload := decodeRefreshResponse(t, recorder)
	if payload.Job.Status != jobStatusFailed {
		t.Fatalf("job.status = %q, want %q when only non-skipped branch failed", payload.Job.Status, jobStatusFailed)
	}
}

func TestRefreshMarksRecoveredWhenRuntimeBecomesHealthy(t *testing.T) {
	var calls atomic.Int32
	dependencies := allSucceeded(t)
	dependencies.ReadRuntimeStatus = func(context.Context, accountcore.AccountRef) string {
		if calls.Add(1) == 1 {
			return "auth_invalid"
		}
		return "healthy"
	}
	handler := newRefreshHandler(t, dependencies)

	recorder := postRefresh(t, handler, testProvider, testRefText)
	payload := decodeRefreshResponse(t, recorder)
	if !payload.Job.Recovered {
		t.Fatalf("job.recovered = %v, want true", payload.Job.Recovered)
	}
}
