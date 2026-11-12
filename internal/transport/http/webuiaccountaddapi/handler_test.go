package webuiaccountaddapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/accountauth"
)

// fakeJobs 是作业端口的内存替身：只记录调用，不做 OAuth。
type fakeJobs struct {
	started      StartRequest
	startResult  Started
	startErr     error
	job          JobSnapshot
	jobErr       error
	completedID  string
	completedURL string
	completeErr  error
	cancelledID  string
	cancelJob    JobSnapshot
	cancelErr    error
}

func (fake *fakeJobs) Start(_ context.Context, request StartRequest) (Started, error) {
	fake.started = request
	return fake.startResult, fake.startErr
}

func (fake *fakeJobs) GetJob(context.Context, string) (JobSnapshot, error) {
	return fake.job, fake.jobErr
}

func (fake *fakeJobs) Complete(_ context.Context, jobID, callback string) (JobSnapshot, error) {
	fake.completedID, fake.completedURL = jobID, callback
	return fake.job, fake.completeErr
}

func (fake *fakeJobs) Cancel(jobID string) (JobSnapshot, error) {
	fake.cancelledID = jobID
	return fake.cancelJob, fake.cancelErr
}

// allowAll 是测试用的鉴权策略。
type allowAll struct{}

func (allowAll) Authorized(*http.Request) bool { return true }

func newTestHandler(t *testing.T, jobs Jobs) *Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{Authorizer: allowAll{}, Jobs: jobs})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	return handler
}

func doRequest(handler *Handler, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func decodeBody[T any](t *testing.T, response *httptest.ResponseRecorder) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
		t.Fatalf("响应不是 JSON: %v (%s)", err, response.Body.String())
	}
	return value
}

// TestStartReturnsNodePendingShape 锁死创建响应里 Node 依赖的字段。
func TestStartReturnsNodePendingShape(t *testing.T) {
	jobs := &fakeJobs{startResult: Started{
		Job: JobSnapshot{
			ID: "abc", Provider: "codex", Purpose: "register", Status: "running",
			GoStatus: "pending", AuthMode: "oauth-browser",
			AuthProgressState: progressAuthURLReady, ExpiresAt: 1234,
		},
		AuthorizationURL: "https://auth.openai.com/oauth/authorize?redirect_uri=" +
			"http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s",
	}}
	handler := newTestHandler(t, jobs)
	response := doRequest(handler, http.MethodPost, Path,
		"{\"provider\":\" Codex \",\"authMode\":\"oauth-browser\"}")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d，期望 200：%s", response.Code, response.Body.String())
	}
	if jobs.started.ProviderID != "codex" {
		t.Fatalf("provider = %q，期望小写 codex", jobs.started.ProviderID)
	}
	var payload pendingResponse
	payload = decodeBody[pendingResponse](t, response)
	if !payload.OK || payload.JobID != "abc" || payload.DerivedBy != deriveByGo {
		t.Fatalf("pending 响应不合预期: %+v", payload)
	}
	if payload.PollIntervalMS != 1000 {
		t.Fatalf("pollIntervalMs = %d，期望 1000", payload.PollIntervalMS)
	}
	if payload.RedirectURI != "http://localhost:1455/auth/callback" {
		t.Fatalf("redirectUri = %q", payload.RedirectURI)
	}
	if payload.InstallRequired || payload.SetupPhase != "" {
		t.Fatalf("Go 作业不应声明安装步骤: %+v", payload)
	}
}

// TestStartRejectsNodeOnlyFlows 锁死回落边界：Node 专有的策略/登录方式必须明确拒绝。
func TestStartRejectsNodeOnlyFlows(t *testing.T) {
	cases := []struct {
		name string
		body string
		code string
	}{
		{"api-key", "{\"provider\":\"codex\",\"authMode\":\"api-key\"}", "unsupported_auth_mode"},
		{"refresh-token", "{\"provider\":\"kiro\",\"authMode\":\"oauth-refresh-token\"}", "unsupported_auth_mode"},
		{"strategy", "{\"provider\":\"agy\",\"authMode\":\"oauth-browser\",\"authStrategy\":\"native-cli\"}", "unsupported_auth_strategy"},
		{"social", "{\"provider\":\"kiro\",\"authMode\":\"oauth-device\",\"loginProvider\":\"Google\"}", "unsupported_login_provider"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			jobs := &fakeJobs{}
			response := doRequest(newTestHandler(t, jobs), http.MethodPost, Path, testCase.body)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d，期望 400", response.Code)
			}
			body := decodeBody[errorResponse](t, response)
			if body.Code != testCase.code {
				t.Fatalf("code = %q，期望 %q", body.Code, testCase.code)
			}
			if jobs.started.ProviderID != "" {
				t.Fatalf("被拒绝的请求不应创建作业: %+v", jobs.started)
			}
		})
	}
}

// TestStartAcceptsBuilderIDAlias 锁死 kiro 默认登录方式的归一：
// UI 发的是 builder-id，Go 的作业只认「空 loginProvider = Builder ID」。
func TestStartAcceptsBuilderIDAlias(t *testing.T) {
	jobs := &fakeJobs{startResult: Started{
		Job: JobSnapshot{
			ID: "job-kiro", Provider: "kiro", Purpose: "register", Status: "running",
			GoStatus: "pending", AuthMode: "oauth-device",
			AuthProgressState: progressAwaitingCode,
		},
		AuthorizationURL: "https://view.awsapps.com/start/#/device?user_code=ABCD",
		UserCode:         "ABCD",
	}}
	response := doRequest(newTestHandler(t, jobs), http.MethodPost, Path,
		"{\"provider\":\"kiro\",\"authMode\":\"oauth-device\",\"loginProvider\":\"builder-id\"}")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d，期望 200：%s", response.Code, response.Body.String())
	}
	if jobs.started.ProviderID != "kiro" {
		t.Fatalf("provider = %q，期望 kiro", jobs.started.ProviderID)
	}
}

// TestStartMapsUnsupportedProvider 锁死回落错误码：Node 只有看到这个码才回本地流程。
func TestStartMapsUnsupportedProvider(t *testing.T) {
	jobs := &fakeJobs{startErr: accountauth.ErrUnsupportedProvider}
	response := doRequest(newTestHandler(t, jobs), http.MethodPost, Path,
		"{\"provider\":\"gemini\",\"authMode\":\"oauth-browser\"}")
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d，期望 400", response.Code)
	}
	if body := decodeBody[errorResponse](t, response); body.Code != "unsupported_provider" {
		t.Fatalf("code = %q", body.Code)
	}
}

// TestStartReleasesJobOnAuthModeMismatch 锁死「先建后撤」：形态不一致不能留下空作业。
func TestStartReleasesJobOnAuthModeMismatch(t *testing.T) {
	jobs := &fakeJobs{startResult: Started{Job: JobSnapshot{
		ID: "job-1", Provider: "kiro", AuthMode: "oauth-device",
		AuthProgressState: progressAwaitingCode,
	}}}
	response := doRequest(newTestHandler(t, jobs), http.MethodPost, Path,
		"{\"provider\":\"kiro\",\"authMode\":\"oauth-browser\"}")
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d，期望 400", response.Code)
	}
	if jobs.cancelledID != "job-1" {
		t.Fatalf("mismatch 时必须取消刚创建的作业，cancelledID = %q", jobs.cancelledID)
	}
}

// TestCallbackMapsApplicationErrors 锁死回调错误码与 Node 文案分支的对接。
func TestCallbackMapsApplicationErrors(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"state", accountauth.ErrStateMismatch, http.StatusBadRequest, "state_mismatch"},
		{"expired", accountauth.ErrJobExpired, http.StatusGone, "job_expired"},
		{"upstream", accountauth.ErrProviderUnavailable, http.StatusBadGateway, "provider_unavailable"},
		{"missing", accountauth.ErrJobNotFound, http.StatusNotFound, "job_not_found"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			jobs := &fakeJobs{completeErr: testCase.err, jobErr: accountauth.ErrJobNotFound}
			response := doRequest(newTestHandler(t, jobs), http.MethodPost,
				Path+"/jobs/job-1/callback", "{\"callbackUrl\":\"http://localhost/cb?code=x\"}")
			if response.Code != testCase.status {
				t.Fatalf("status = %d，期望 %d", response.Code, testCase.status)
			}
			if body := decodeBody[errorResponse](t, response); body.Code != testCase.code {
				t.Fatalf("code = %q，期望 %q", body.Code, testCase.code)
			}
		})
	}
}

// TestCallbackForwardsRawURL 锁死回调原样转发：Go 是 state/PKCE 的唯一持有者。
func TestCallbackForwardsRawURL(t *testing.T) {
	jobs := &fakeJobs{job: JobSnapshot{ID: "job-1", Status: "succeeded", GoStatus: "completed"}}
	callback := "http://localhost:1455/auth/callback?code=abc&state=xyz"
	response := doRequest(newTestHandler(t, jobs), http.MethodPost,
		Path+"/jobs/job-1/callback", "{\"callbackUrl\":\""+callback+"\"}")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d：%s", response.Code, response.Body.String())
	}
	if jobs.completedURL != callback {
		t.Fatalf("转发回调 = %q，期望原样 %q", jobs.completedURL, callback)
	}
}

// TestCancelTerminalJobIsSuccess 锁死与 Node cancelJob 相同的「已结束也成功」。
func TestCancelTerminalJobIsSuccess(t *testing.T) {
	jobs := &fakeJobs{cancelErr: accountauth.ErrJobNotPending, cancelJob: JobSnapshot{
		ID: "job-1", Status: "succeeded", GoStatus: "completed",
	}}
	response := doRequest(newTestHandler(t, jobs), http.MethodPost, Path+"/jobs/job-1/cancel", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d，期望 200：%s", response.Code, response.Body.String())
	}
	if body := decodeBody[jobResponse](t, response); body.Job.Status != "succeeded" {
		t.Fatalf("终态取消不应改状态: %+v", body.Job)
	}
}

// TestCancelUnknownJobSynthesisesCancelled 锁死 Node 的 job_not_found 收尾语义。
func TestCancelUnknownJobSynthesisesCancelled(t *testing.T) {
	jobs := &fakeJobs{cancelErr: accountauth.ErrJobNotFound}
	response := doRequest(newTestHandler(t, jobs), http.MethodPost, Path+"/jobs/missing/cancel", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d，期望 200", response.Code)
	}
	body := decodeBody[jobResponse](t, response)
	if body.Job.ID != "missing" || body.Job.Status != "cancelled" || body.Job.AuthProgressState != progressCancelled {
		t.Fatalf("合成取消快照不合预期: %+v", body.Job)
	}
}

// TestInstallAndLocalImportKeepNodeBoundary 锁死 Go 作业的两条「不适用」结论。
func TestInstallAndLocalImportKeepNodeBoundary(t *testing.T) {
	jobs := &fakeJobs{job: JobSnapshot{ID: "job-1", Status: "running", GoStatus: "pending"}}

	install := doRequest(newTestHandler(t, jobs), http.MethodPost, Path+"/jobs/job-1/install", "")
	if install.Code != http.StatusBadRequest {
		t.Fatalf("install status = %d，期望 400", install.Code)
	}
	if body := decodeBody[errorResponse](t, install); body.Code != "install_not_required" || body.Job == nil {
		t.Fatalf("install 响应不合预期: %+v", body)
	}

	importResponse := doRequest(newTestHandler(t, jobs), http.MethodPost,
		Path+"/jobs/job-1/local-import", "{\"sourceId\":\"codex-host-local\"}")
	if importResponse.Code != http.StatusNotImplemented {
		t.Fatalf("local-import status = %d，期望 501", importResponse.Code)
	}
	if body := decodeBody[errorResponse](t, importResponse); body.Code != "local_import_unsupported" || body.Job == nil {
		t.Fatalf("local-import 响应不合预期: %+v", body)
	}

	missing := doRequest(newTestHandler(t, jobs), http.MethodPost, Path+"/jobs/job-1/local-import", "{}")
	if missing.Code != http.StatusBadRequest {
		t.Fatalf("missing sourceId status = %d，期望 400", missing.Code)
	}
}

// TestGetJobNotFound 锁死查询 404。
func TestGetJobNotFound(t *testing.T) {
	jobs := &fakeJobs{jobErr: accountauth.ErrJobNotFound}
	response := doRequest(newTestHandler(t, jobs), http.MethodGet, Path+"/jobs/missing", "")
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d，期望 404", response.Code)
	}
}

// TestUnauthorized 锁死鉴权先于业务。
func TestUnauthorized(t *testing.T) {
	handler, err := NewHandler(Dependencies{Authorizer: denyAll{}, Jobs: &fakeJobs{}})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	response := doRequest(handler, http.MethodPost, Path, "{}")
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d，期望 401", response.Code)
	}
}

type denyAll struct{}

func (denyAll) Authorized(*http.Request) bool { return false }

// TestNewHandlerValidatesDependencies 锁死失败关闭。
func TestNewHandlerValidatesDependencies(t *testing.T) {
	if _, err := NewHandler(Dependencies{Jobs: &fakeJobs{}}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("缺少 Authorizer 必须失败关闭: %v", err)
	}
	if _, err := NewHandler(Dependencies{Authorizer: allowAll{}}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("缺少 Jobs 必须失败关闭: %v", err)
	}
}
