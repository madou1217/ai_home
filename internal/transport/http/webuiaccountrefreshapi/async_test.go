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
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/transport/http/webuirefreshjobstore"
)

const (
	asyncTestProvider = "codex"
	asyncTestRefText  = "acct_0123456789abcdef0123"
)

var asyncTestTime = time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)

type asyncTestAuthorizer bool

func (authorizer asyncTestAuthorizer) Authorized(*http.Request) bool { return bool(authorizer) }

type asyncTestDirectory struct {
	account accountcore.Account
	err     error
}

func (directory asyncTestDirectory) GetByRef(
	_ context.Context,
	_ accountcore.AccountRef,
) (accountcore.Account, error) {
	if directory.err != nil {
		return accountcore.Account{}, directory.err
	}
	return directory.account, nil
}

type asyncTestStatusRefresher struct {
	run func(ctx context.Context) error
}

func (stub asyncTestStatusRefresher) RefreshAccountStatus(
	ctx context.Context,
	_ accountcore.AccountRef,
) error {
	if stub.run == nil {
		return nil
	}
	return stub.run(ctx)
}

type asyncTestModelRefresher struct {
	run func(ctx context.Context) error
}

func (stub asyncTestModelRefresher) RefreshAccountModels(
	ctx context.Context,
	_ accountcore.AccountRef,
) ([]accountapp.AccountModel, error) {
	if stub.run == nil {
		return nil, nil
	}
	return nil, stub.run(ctx)
}

type asyncTestQuotaRefresher struct {
	run func(ctx context.Context) error
}

func (stub asyncTestQuotaRefresher) RefreshUsage(
	ctx context.Context,
	_ accountcore.AccountRef,
) (accountusage.ReadResult, error) {
	if stub.run == nil {
		return accountusage.ReadResult{}, nil
	}
	return accountusage.ReadResult{}, stub.run(ctx)
}

func asyncTestAccount(t *testing.T, provider string) accountcore.Account {
	t.Helper()
	ref, err := accountcore.ParseAccountRef(asyncTestRefText)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref:          ref,
		ProviderID:   provider,
		CLIAccountID: accountcore.CLIAccountID(1),
		Enabled:      true,
		CreatedAt:    asyncTestTime,
		UpdatedAt:    asyncTestTime,
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	return account
}

// newAsyncTestHandler 用真实同步执行器 + 作业表组装异步入口。
func newAsyncTestHandler(t *testing.T, dependencies Dependencies) *AsyncHandler {
	t.Helper()
	executor, err := NewHandler(dependencies)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	handler, err := NewAsyncHandler(executor, webuirefreshjobstore.New(webuirefreshjobstore.Options{}))
	if err != nil {
		t.Fatalf("NewAsyncHandler() error = %v", err)
	}
	return handler
}

func asyncRefreshRequest(provider string, accountRef string) *http.Request {
	request := httptest.NewRequest(
		http.MethodPost,
		Path+"/"+provider+"/"+accountRef+"/refresh",
		nil,
	)
	request.SetPathValue("provider", provider)
	request.SetPathValue("accountRef", accountRef)
	return request
}

func asyncJobRequest(jobID string) *http.Request {
	request := httptest.NewRequest(
		http.MethodGet,
		webuirefreshjobstore.JobsPath+"/"+jobID,
		nil,
	)
	request.SetPathValue(jobIDParam, jobID)
	return request
}

func asyncDecodeResponse(t *testing.T, recorder *httptest.ResponseRecorder) AsyncResponse {
	t.Helper()
	var payload AsyncResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response body %q: %v", recorder.Body.String(), err)
	}
	return payload
}

func asyncDecodeMap(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("decode json body %q: %v", string(body), err)
	}
	return payload
}

func asyncMarshalMap(t *testing.T, value any) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	return asyncDecodeMap(t, encoded)
}

func asyncAssertKeys(t *testing.T, payload map[string]any, want ...string) {
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

// asyncWaitTerminal 轮询作业直到终态；用于验证异步执行确实会推进。
func asyncWaitTerminal(t *testing.T, handler *AsyncHandler, jobID string) AsyncJob {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		recorder := httptest.NewRecorder()
		handler.ServeJob(recorder, asyncJobRequest(jobID))
		if recorder.Code != http.StatusOK {
			t.Fatalf("查询作业 status = %d, body = %s", recorder.Code, recorder.Body.String())
		}
		var payload AsyncJobResponse
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode job body %q: %v", recorder.Body.String(), err)
		}
		if payload.Job.Status == jobStatusSucceeded || payload.Job.Status == jobStatusFailed {
			return payload.Job
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("作业 %q 未在预期时间内进入终态", jobID)
	return AsyncJob{}
}

// asyncGetJobRaw 返回 200 响应里的 job 对象（去掉 {ok, job} 外壳）。
func asyncGetJobRaw(t *testing.T, handler *AsyncHandler, jobID string) map[string]any {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeJob(recorder, asyncJobRequest(jobID))
	if recorder.Code != http.StatusOK {
		t.Fatalf("查询作业 status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	body := asyncDecodeMap(t, recorder.Body.Bytes())
	job, ok := body["job"].(map[string]any)
	if !ok {
		t.Fatalf("job = %v, want 对象", body["job"])
	}
	return job
}

func TestNewAsyncHandlerValidatesDependencies(t *testing.T) {
	executor, err := NewHandler(Dependencies{
		Authorizer: asyncTestAuthorizer(true),
		Accounts:   asyncTestDirectory{account: asyncTestAccount(t, asyncTestProvider)},
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	jobs := webuirefreshjobstore.New(webuirefreshjobstore.Options{})
	cases := []struct {
		name     string
		executor *Handler
		jobs     *webuirefreshjobstore.Store
	}{
		{name: "missing executor", jobs: jobs},
		{name: "missing jobs", executor: executor},
		{name: "executor without dependencies", executor: &Handler{}, jobs: jobs},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := NewAsyncHandler(testCase.executor, testCase.jobs)
			if !errors.Is(err, ErrInvalidAsyncDependencies) {
				t.Fatalf("NewAsyncHandler() error = %v, want %v", err, ErrInvalidAsyncDependencies)
			}
		})
	}
	if _, err := NewAsyncHandler(executor, jobs); err != nil {
		t.Fatalf("NewAsyncHandler() error = %v", err)
	}
}

func TestAsyncRefreshReturnsQueuedWithoutWaiting(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{}, 1)
	blocking := func(ctx context.Context) error {
		select {
		case entered <- struct{}{}:
		default:
		}
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	handler := newAsyncTestHandler(t, Dependencies{
		Authorizer:      asyncTestAuthorizer(true),
		Accounts:        asyncTestDirectory{account: asyncTestAccount(t, asyncTestProvider)},
		StatusRefresher: asyncTestStatusRefresher{run: blocking},
		ModelRefresher:  asyncTestModelRefresher{run: func(context.Context) error { return nil }},
		QuotaRefresher:  asyncTestQuotaRefresher{run: func(context.Context) error { return nil }},
		Timeout:         2 * time.Second,
	})

	recorder := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(recorder, asyncRefreshRequest(asyncTestProvider, asyncTestRefText))
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("202 响应被作业执行阻塞")
	}
	// 作业已经进入执行体，但刷新还没完成：此时响应必须已经返回。
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("作业没有开始执行")
	}

	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	payload := asyncDecodeResponse(t, recorder)
	if !payload.OK || !payload.Accepted {
		t.Fatalf("payload = %+v, want ok+accepted", payload)
	}
	if payload.AlreadyRunning {
		t.Fatalf("alreadyRunning = true, want false")
	}
	if payload.Job.Status != "queued" {
		t.Fatalf("job.status = %q, want queued", payload.Job.Status)
	}
	if payload.Job.FinishedAt != nil {
		t.Fatalf("job.finishedAt = %v, want nil", *payload.Job.FinishedAt)
	}
	if payload.Job.ID == "" {
		t.Fatal("job.id 为空")
	}
	if payload.Job.Provider != asyncTestProvider || payload.Job.AccountRef != asyncTestRefText {
		t.Fatalf("job = %+v", payload.Job)
	}
	if payload.Job.Scope != JobScopeAccount {
		t.Fatalf("job.scope = %q, want %q", payload.Job.Scope, JobScopeAccount)
	}

	close(release)
	if job := asyncWaitTerminal(t, handler, payload.Job.ID); job.Status != jobStatusSucceeded {
		t.Fatalf("job.status = %q, want %q", job.Status, jobStatusSucceeded)
	}
}

func TestAsyncRefreshPollReachesTerminalState(t *testing.T) {
	handler := newAsyncTestHandler(t, Dependencies{
		Authorizer:      asyncTestAuthorizer(true),
		Accounts:        asyncTestDirectory{account: asyncTestAccount(t, asyncTestProvider)},
		StatusRefresher: asyncTestStatusRefresher{},
		ModelRefresher:  asyncTestModelRefresher{},
		QuotaRefresher:  asyncTestQuotaRefresher{},
	})

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, asyncRefreshRequest(asyncTestProvider, asyncTestRefText))
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	accepted := asyncDecodeResponse(t, recorder)

	job := asyncWaitTerminal(t, handler, accepted.Job.ID)
	if job.Status != jobStatusSucceeded {
		t.Fatalf("job.status = %q, want %q", job.Status, jobStatusSucceeded)
	}
	if job.FinishedAt == nil || *job.FinishedAt <= 0 {
		t.Fatalf("job.finishedAt = %v, want 毫秒时间戳", job.FinishedAt)
	}
	if job.Error != "" {
		t.Fatalf("job.error = %q, want 空", job.Error)
	}
	if len(job.FailedBranches) != 0 {
		t.Fatalf("job.failedBranches = %v, want 空", job.FailedBranches)
	}
	for _, name := range []string{BranchStatus, BranchModels, BranchUsage} {
		branch, found := job.Branches[name]
		if !found {
			t.Fatalf("branch %q 缺失: %+v", name, job.Branches)
		}
		if branch.Status != branchStatusSucceeded || branch.Error != "" {
			t.Fatalf("branch %q = %+v, want succeeded", name, branch)
		}
	}
}

func TestAsyncRefreshReusesActiveJob(t *testing.T) {
	release := make(chan struct{})
	blocking := func(ctx context.Context) error {
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	handler := newAsyncTestHandler(t, Dependencies{
		Authorizer:      asyncTestAuthorizer(true),
		Accounts:        asyncTestDirectory{account: asyncTestAccount(t, asyncTestProvider)},
		StatusRefresher: asyncTestStatusRefresher{run: blocking},
		ModelRefresher:  asyncTestModelRefresher{},
		QuotaRefresher:  asyncTestQuotaRefresher{},
		Timeout:         2 * time.Second,
	})

	firstRecorder := httptest.NewRecorder()
	handler.ServeHTTP(firstRecorder, asyncRefreshRequest(asyncTestProvider, asyncTestRefText))
	if firstRecorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", firstRecorder.Code, firstRecorder.Body.String())
	}
	first := asyncDecodeResponse(t, firstRecorder)

	secondRecorder := httptest.NewRecorder()
	handler.ServeHTTP(secondRecorder, asyncRefreshRequest(asyncTestProvider, asyncTestRefText))
	if secondRecorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", secondRecorder.Code, secondRecorder.Body.String())
	}
	second := asyncDecodeResponse(t, secondRecorder)

	if !second.AlreadyRunning {
		t.Fatalf("alreadyRunning = false, want true")
	}
	if second.Job.ID != first.Job.ID {
		t.Fatalf("job.id = %q, want 复用 %q", second.Job.ID, first.Job.ID)
	}
	if second.Job.Status == jobStatusSucceeded || second.Job.Status == jobStatusFailed {
		t.Fatalf("job.status = %q, 活动作业不该是终态", second.Job.Status)
	}

	close(release)
	job := asyncWaitTerminal(t, handler, first.Job.ID)
	if job.ID != first.Job.ID {
		t.Fatalf("job.id = %q, want %q", job.ID, first.Job.ID)
	}
	if job.Status != jobStatusSucceeded {
		t.Fatalf("job.status = %q, want %q", job.Status, jobStatusSucceeded)
	}
}

func TestAsyncRefreshSurfacesJobFailure(t *testing.T) {
	fail := func(context.Context) error { return errors.New("boom") }
	handler := newAsyncTestHandler(t, Dependencies{
		Authorizer:      asyncTestAuthorizer(true),
		Accounts:        asyncTestDirectory{account: asyncTestAccount(t, asyncTestProvider)},
		StatusRefresher: asyncTestStatusRefresher{run: fail},
		ModelRefresher:  asyncTestModelRefresher{run: fail},
		QuotaRefresher:  asyncTestQuotaRefresher{run: fail},
	})

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, asyncRefreshRequest(asyncTestProvider, asyncTestRefText))
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	accepted := asyncDecodeResponse(t, recorder)

	job := asyncWaitTerminal(t, handler, accepted.Job.ID)
	if job.Status != jobStatusFailed {
		t.Fatalf("job.status = %q, want %q", job.Status, jobStatusFailed)
	}
	if !strings.Contains(job.Error, "boom") {
		t.Fatalf("job.error = %q, want 含 boom", job.Error)
	}
	wantFailed := []string{BranchStatus, BranchModels, BranchUsage}
	if !reflect.DeepEqual(job.FailedBranches, wantFailed) {
		t.Fatalf("job.failedBranches = %v, want %v", job.FailedBranches, wantFailed)
	}
	for _, name := range wantFailed {
		branch, found := job.Branches[name]
		if !found {
			t.Fatalf("branch %q 缺失: %+v", name, job.Branches)
		}
		if branch.Status != branchStatusFailed || branch.Error != "boom" {
			t.Fatalf("branch %q = %+v, want failed boom", name, branch)
		}
	}

	jobRaw := asyncGetJobRaw(t, handler, job.ID)
	if _, found := jobRaw["failedBranches"]; !found {
		t.Fatalf("failedBranches 未透出: %v", jobRaw)
	}
	if _, found := jobRaw["recovered"]; found {
		t.Fatalf("recovered 不该出现: %v", jobRaw)
	}
}

func TestAsyncRefreshRejectsInvalidRequests(t *testing.T) {
	cases := []struct {
		name       string
		authorized bool
		method     string
		provider   string
		ref        string
		directory  asyncTestDirectory
		wantStatus int
		wantError  string
		wantAllow  string
	}{
		{
			name:       "unauthorized",
			authorized: false,
			method:     http.MethodPost,
			provider:   asyncTestProvider,
			ref:        asyncTestRefText,
			directory:  asyncTestDirectory{account: asyncTestAccount(t, asyncTestProvider)},
			wantStatus: http.StatusUnauthorized,
			wantError:  "unauthorized",
		},
		{
			name:       "method not allowed",
			authorized: true,
			method:     http.MethodGet,
			provider:   asyncTestProvider,
			ref:        asyncTestRefText,
			directory:  asyncTestDirectory{account: asyncTestAccount(t, asyncTestProvider)},
			wantStatus: http.StatusMethodNotAllowed,
			wantError:  "method_not_allowed",
			wantAllow:  http.MethodPost,
		},
		{
			name:       "invalid provider",
			authorized: true,
			method:     http.MethodPost,
			provider:   "Codex!",
			ref:        asyncTestRefText,
			directory:  asyncTestDirectory{account: asyncTestAccount(t, asyncTestProvider)},
			wantStatus: http.StatusBadRequest,
			wantError:  "invalid_account_path",
		},
		{
			name:       "invalid account ref",
			authorized: true,
			method:     http.MethodPost,
			provider:   asyncTestProvider,
			ref:        "acct_short",
			directory:  asyncTestDirectory{account: asyncTestAccount(t, asyncTestProvider)},
			wantStatus: http.StatusBadRequest,
			wantError:  "invalid_account_path",
		},
		{
			name:       "unknown account",
			authorized: true,
			method:     http.MethodPost,
			provider:   asyncTestProvider,
			ref:        asyncTestRefText,
			directory:  asyncTestDirectory{err: accountapp.ErrAccountNotFound},
			wantStatus: http.StatusNotFound,
			wantError:  "account_not_found",
		},
		{
			name:       "provider mismatch",
			authorized: true,
			method:     http.MethodPost,
			provider:   asyncTestProvider,
			ref:        asyncTestRefText,
			directory:  asyncTestDirectory{account: asyncTestAccount(t, "claude")},
			wantStatus: http.StatusNotFound,
			wantError:  "account_not_found",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler := newAsyncTestHandler(t, Dependencies{
				Authorizer: asyncTestAuthorizer(testCase.authorized),
				Accounts:   testCase.directory,
			})
			request := asyncRefreshRequest(testCase.provider, testCase.ref)
			request.Method = testCase.method
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)

			if recorder.Code != testCase.wantStatus {
				t.Fatalf("status = %d, want %d, body = %s",
					recorder.Code, testCase.wantStatus, recorder.Body.String())
			}
			if testCase.wantAllow != "" {
				if allow := recorder.Header().Get("Allow"); allow != testCase.wantAllow {
					t.Fatalf("Allow = %q, want %q", allow, testCase.wantAllow)
				}
			}
			if testCase.wantStatus == http.StatusUnauthorized {
				if challenge := recorder.Header().Get("WWW-Authenticate"); challenge != "Bearer" {
					t.Fatalf("WWW-Authenticate = %q, want Bearer", challenge)
				}
			}
			payload := asyncDecodeMap(t, recorder.Body.Bytes())
			if payload["error"] != testCase.wantError {
				t.Fatalf("error = %v, want %q", payload["error"], testCase.wantError)
			}
		})
	}
}

func TestAsyncJobRejectsInvalidRequests(t *testing.T) {
	handler := newAsyncTestHandler(t, Dependencies{
		Authorizer: asyncTestAuthorizer(true),
		Accounts:   asyncTestDirectory{account: asyncTestAccount(t, asyncTestProvider)},
	})
	cases := []struct {
		name       string
		authorized bool
		method     string
		jobID      string
		wantStatus int
		wantError  string
		wantAllow  string
	}{
		{
			name:       "unauthorized",
			authorized: false,
			method:     http.MethodGet,
			jobID:      "job-any",
			wantStatus: http.StatusUnauthorized,
			wantError:  "unauthorized",
		},
		{
			name:       "method not allowed",
			authorized: true,
			method:     http.MethodPut,
			jobID:      "job-any",
			wantStatus: http.StatusMethodNotAllowed,
			wantError:  "method_not_allowed",
			wantAllow:  http.MethodGet,
		},
		{
			name:       "empty job id",
			authorized: true,
			method:     http.MethodGet,
			jobID:      "",
			wantStatus: http.StatusBadRequest,
			wantError:  codeInvalidRefreshJobPath,
		},
		{
			name:       "unknown job",
			authorized: true,
			method:     http.MethodGet,
			jobID:      "job-unknown",
			wantStatus: http.StatusNotFound,
			wantError:  codeRefreshJobNotFound,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			caseHandler := handler
			if !testCase.authorized {
				caseHandler = newAsyncTestHandler(t, Dependencies{
					Authorizer: asyncTestAuthorizer(false),
					Accounts:   asyncTestDirectory{account: asyncTestAccount(t, asyncTestProvider)},
				})
			}
			request := asyncJobRequest(testCase.jobID)
			request.Method = testCase.method
			recorder := httptest.NewRecorder()
			caseHandler.ServeJob(recorder, request)

			if recorder.Code != testCase.wantStatus {
				t.Fatalf("status = %d, want %d, body = %s",
					recorder.Code, testCase.wantStatus, recorder.Body.String())
			}
			if testCase.wantAllow != "" {
				if allow := recorder.Header().Get("Allow"); allow != testCase.wantAllow {
					t.Fatalf("Allow = %q, want %q", allow, testCase.wantAllow)
				}
			}
			payload := asyncDecodeMap(t, recorder.Body.Bytes())
			if payload["error"] != testCase.wantError {
				t.Fatalf("error = %v, want %q", payload["error"], testCase.wantError)
			}
		})
	}
}

func TestAsyncRefreshJobJSONShapeMatchesNode(t *testing.T) {
	release := make(chan struct{})
	blocking := func(ctx context.Context) error {
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	handler := newAsyncTestHandler(t, Dependencies{
		Authorizer:      asyncTestAuthorizer(true),
		Accounts:        asyncTestDirectory{account: asyncTestAccount(t, asyncTestProvider)},
		StatusRefresher: asyncTestStatusRefresher{run: blocking},
		ModelRefresher:  asyncTestModelRefresher{},
		QuotaRefresher:  asyncTestQuotaRefresher{},
		Timeout:         2 * time.Second,
	})

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, asyncRefreshRequest(asyncTestProvider, asyncTestRefText))
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	acceptedBody := asyncDecodeMap(t, recorder.Body.Bytes())
	queued, ok := acceptedBody["job"].(map[string]any)
	if !ok {
		t.Fatalf("job = %v, want 对象", acceptedBody["job"])
	}
	asyncAssertKeys(t, queued,
		"id", "provider", "accountRef", "status", "createdAt", "updatedAt",
		"finishedAt", "error", "scope")
	if queued["finishedAt"] != nil {
		t.Fatalf("finishedAt = %v, want null", queued["finishedAt"])
	}
	if queued["status"] != "queued" {
		t.Fatalf("status = %v, want queued", queued["status"])
	}
	if queued["scope"] != JobScopeAccount {
		t.Fatalf("scope = %v, want %q", queued["scope"], JobScopeAccount)
	}
	jobID, _ := queued["id"].(string)

	close(release)
	asyncWaitTerminal(t, handler, jobID)

	terminal := asyncGetJobRaw(t, handler, jobID)
	asyncAssertKeys(t, terminal,
		"id", "provider", "accountRef", "status", "createdAt", "updatedAt",
		"finishedAt", "error", "scope", "branches")
	if _, ok := terminal["finishedAt"].(float64); !ok {
		t.Fatalf("finishedAt = %v, want 毫秒数字", terminal["finishedAt"])
	}
	branches, ok := terminal["branches"].(map[string]any)
	if !ok || len(branches) != 3 {
		t.Fatalf("branches = %v, want 三段", terminal["branches"])
	}
	for _, name := range []string{BranchStatus, BranchModels, BranchUsage} {
		branch, ok := branches[name].(map[string]any)
		if !ok {
			t.Fatalf("branch %q = %v, want 对象", name, branches[name])
		}
		asyncAssertKeys(t, branch, "status", "error")
	}
	if _, found := terminal["recovered"]; found {
		t.Fatalf("recovered 不该出现: %v", terminal)
	}
	if _, found := terminal["failedBranches"]; found {
		t.Fatalf("failedBranches 不该出现: %v", terminal)
	}
}

func TestJobFromSnapshotSerializesScopes(t *testing.T) {
	finished := int64(1700000000123)
	accountJob := jobFromSnapshot(webuirefreshjobstore.Snapshot{
		ID:         "job-account",
		Provider:   asyncTestProvider,
		AccountRef: asyncTestRefText,
		Status:     jobStatusSucceeded,
		CreatedAt:  1,
		UpdatedAt:  2,
		FinishedAt: &finished,
		Scope:      JobScopeAccount,
		Branches: map[string]webuirefreshjobstore.Branch{
			BranchStatus: {Status: branchStatusSucceeded},
			BranchModels: {Status: branchStatusFailed, Error: "上游 500"},
		},
		FailedBranches: []string{BranchModels},
	})
	payload := asyncMarshalMap(t, accountJob)
	asyncAssertKeys(t, payload,
		"id", "provider", "accountRef", "status", "createdAt", "updatedAt",
		"finishedAt", "error", "failedBranches", "scope", "branches")
	if payload["finishedAt"] != float64(finished) {
		t.Fatalf("finishedAt = %v, want %d", payload["finishedAt"], finished)
	}
	branches, ok := payload["branches"].(map[string]any)
	if !ok {
		t.Fatalf("branches = %v, want 对象", payload["branches"])
	}
	models, ok := branches[BranchModels].(map[string]any)
	if !ok {
		t.Fatalf("models = %v, want 对象", branches[BranchModels])
	}
	asyncAssertKeys(t, models, "status", "error")
	if models["error"] != "上游 500" {
		t.Fatalf("models.error = %v, want 上游 500", models["error"])
	}
	// Node 的 serializeAccountRefreshJob 对成功段也输出空 error，不省略字段。
	status, ok := branches[BranchStatus].(map[string]any)
	if !ok {
		t.Fatalf("status = %v, want 对象", branches[BranchStatus])
	}
	if status["error"] != "" {
		t.Fatalf("status.error = %v, want 空串", status["error"])
	}

	usageJob := jobFromSnapshot(webuirefreshjobstore.Snapshot{
		ID:         "job-usage",
		Provider:   asyncTestProvider,
		AccountRef: asyncTestRefText,
		Status:     jobStatusSucceeded,
		CreatedAt:  1,
		UpdatedAt:  2,
		FinishedAt: &finished,
		Scope:      "usage",
		Recovered:  true,
		Branches: map[string]webuirefreshjobstore.Branch{
			BranchUsage: {Status: branchStatusSucceeded},
		},
	})
	payload = asyncMarshalMap(t, usageJob)
	asyncAssertKeys(t, payload,
		"id", "provider", "accountRef", "status", "createdAt", "updatedAt",
		"finishedAt", "error", "recovered", "scope")
	if payload["scope"] != "usage" {
		t.Fatalf("scope = %v, want usage", payload["scope"])
	}
	if payload["recovered"] != true {
		t.Fatalf("recovered = %v, want true", payload["recovered"])
	}
	if _, found := payload["branches"]; found {
		t.Fatalf("usage 作业不该输出 branches: %v", payload)
	}

	queuedJob := jobFromSnapshot(webuirefreshjobstore.Snapshot{
		ID:     "job-queued",
		Scope:  JobScopeAccount,
		Status: "queued",
	})
	payload = asyncMarshalMap(t, queuedJob)
	if payload["finishedAt"] != nil {
		t.Fatalf("finishedAt = %v, want null", payload["finishedAt"])
	}
	if _, found := payload["branches"]; found {
		t.Fatalf("队列中的作业没有分段明细: %v", payload)
	}
}
