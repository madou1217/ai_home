package webuiaccountreauthapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	accountauth "github.com/madou1217/ai_home/application/accountauth"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

const (
	testProvider = "codex"
	testRefText  = "acct_0123456789abcdef0123"
	testJobID    = "0123456789abcdef0123456789abcdef"
)

var testTime = time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)

type testAuthorizer bool

func (authorizer testAuthorizer) Authorized(*http.Request) bool { return bool(authorizer) }

type stubDirectory struct {
	overview accountapp.AccountOverview
	err      error
}

func (directory stubDirectory) GetAccountOverview(
	_ context.Context,
	_ accountcore.AccountRef,
) (accountapp.AccountOverview, error) {
	if directory.err != nil {
		return accountapp.AccountOverview{}, directory.err
	}
	return directory.overview, nil
}

// stubJobs 同时实现 JobStarter 与 JobReader，模拟生产适配器。
type stubJobs struct {
	calls     int
	requests  []Request
	job       Job
	err       error
	active    map[string]bool
	activeErr error
}

func (jobs *stubJobs) Start(_ context.Context, request Request) (Job, error) {
	jobs.calls++
	jobs.requests = append(jobs.requests, request)
	if jobs.err != nil {
		return Job{}, jobs.err
	}
	return jobs.job, nil
}

func (jobs *stubJobs) Active(jobID string) (bool, error) {
	if jobs.activeErr != nil {
		return false, jobs.activeErr
	}
	return jobs.active[jobID], nil
}

// stubStarterOnly 只实现 JobStarter：用于验证没有读端口时仍能靠本地记录幂等。
type stubStarterOnly struct {
	calls int
	job   Job
	err   error
}

func (starter *stubStarterOnly) Start(_ context.Context, _ Request) (Job, error) {
	starter.calls++
	if starter.err != nil {
		return Job{}, starter.err
	}
	return starter.job, nil
}

func testAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	accountRef, err := accountcore.ParseAccountRef(testRefText)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return accountRef
}

func testOverview(
	t *testing.T,
	provider string,
	accountRef accountcore.AccountRef,
) accountapp.AccountOverview {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref:          accountRef,
		ProviderID:   provider,
		CLIAccountID: accountcore.CLIAccountID(1),
		Enabled:      true,
		CreatedAt:    testTime,
		UpdatedAt:    testTime,
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	overview, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{
		Account:          account,
		HasProfile:       true,
		DisplayName:      "重新认证账号",
		SubscriptionKind: "plus",
		ProfileUpdatedAt: testTime,
	})
	if err != nil {
		t.Fatalf("NewAccountOverview() error = %v", err)
	}
	return overview
}

func newReauthHandler(
	t *testing.T,
	authorizer Authorizer,
	directory AccountDirectory,
	jobs JobStarter,
) *Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer: authorizer,
		AIHomeDir:  t.TempDir(),
		Accounts:   directory,
		Jobs:       jobs,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func reauthPath(provider string, accountRef string) string {
	return Path + "/" + provider + "/" + accountRef + "/reauth"
}

// postReauth 走真实 ServeMux，确保 PathValue 的提取路径与生产一致。
func postReauth(t *testing.T, handler http.Handler, provider string, accountRef string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle("POST "+Path+ReauthSuffix, handler)
	request := httptest.NewRequest(http.MethodPost, reauthPath(provider, accountRef), nil)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	return recorder
}

func decodeBody(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("解析响应 JSON 失败: %v（正文 %q）", err, recorder.Body.String())
	}
	return payload
}

func assertText(t *testing.T, payload map[string]any, key string, want string) {
	t.Helper()
	got, ok := payload[key].(string)
	if !ok || got != want {
		t.Fatalf("%s = %v（%T），期望 %q", key, payload[key], payload[key], want)
	}
}

func assertBool(t *testing.T, payload map[string]any, key string, want bool) {
	t.Helper()
	got, ok := payload[key].(bool)
	if !ok || got != want {
		t.Fatalf("%s = %v（%T），期望 %v", key, payload[key], payload[key], want)
	}
}

// pendingJob 返回一个 10 分钟后过期的 pending 作业。
func pendingJob() Job {
	return Job{
		ID:               testJobID,
		ProviderID:       testProvider,
		Purpose:          string(accountauth.PurposeReauth),
		Status:           string(accountauth.StatusPending),
		AuthorizationURL: "https://example.test/oauth/authorize?state=abc",
		ExpiresAt:        time.Now().Add(10 * time.Minute),
	}
}

func TestNewHandlerRequiresDependencies(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("NewHandler() error = %v，期望 ErrInvalidDependencies", err)
	}
}

func TestServeHTTPRejectsUnauthorized(t *testing.T) {
	jobs := &stubJobs{job: pendingJob()}
	handler := newReauthHandler(t, testAuthorizer(false),
		stubDirectory{overview: testOverview(t, testProvider, testAccountRef(t))}, jobs)

	recorder := postReauth(t, handler, testProvider, testRefText)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d，期望 401", recorder.Code)
	}
	if got := recorder.Header().Get("WWW-Authenticate"); got != "Bearer" {
		t.Fatalf("WWW-Authenticate = %q，期望 Bearer", got)
	}
	assertText(t, decodeBody(t, recorder), "error", "unauthorized")
	if jobs.calls != 0 {
		t.Fatalf("未鉴权时不应创建作业，calls = %d", jobs.calls)
	}
}

func TestServeHTTPRejectsNonPost(t *testing.T) {
	jobs := &stubJobs{job: pendingJob()}
	handler := newReauthHandler(t, testAuthorizer(true),
		stubDirectory{overview: testOverview(t, testProvider, testAccountRef(t))}, jobs)

	request := httptest.NewRequest(http.MethodGet, reauthPath(testProvider, testRefText), nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d，期望 405", recorder.Code)
	}
	if got := recorder.Header().Get("Allow"); got != http.MethodPost {
		t.Fatalf("Allow = %q，期望 POST", got)
	}
	if jobs.calls != 0 {
		t.Fatalf("非 POST 不应创建作业，calls = %d", jobs.calls)
	}
}

func TestServeHTTPReturnsNotImplementedWithoutJobs(t *testing.T) {
	handler := newReauthHandler(t, testAuthorizer(true),
		stubDirectory{overview: testOverview(t, testProvider, testAccountRef(t))}, nil)

	recorder := postReauth(t, handler, testProvider, testRefText)
	if recorder.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d，期望 501", recorder.Code)
	}
	assertText(t, decodeBody(t, recorder), "error", "reauth_unavailable")
}

func TestServeHTTPReturnsNotFoundForUnknownAccount(t *testing.T) {
	jobs := &stubJobs{job: pendingJob()}
	handler := newReauthHandler(t, testAuthorizer(true),
		stubDirectory{err: accountapp.ErrAccountNotFound}, jobs)

	recorder := postReauth(t, handler, testProvider, testRefText)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d，期望 404", recorder.Code)
	}
	assertText(t, decodeBody(t, recorder), "error", "account_not_found")
	if jobs.calls != 0 {
		t.Fatalf("账号不存在时不应创建作业，calls = %d", jobs.calls)
	}
}

func TestServeHTTPReturnsNotFoundForProviderMismatch(t *testing.T) {
	accountRef := testAccountRef(t)
	jobs := &stubJobs{job: pendingJob()}
	handler := newReauthHandler(t, testAuthorizer(true),
		stubDirectory{overview: testOverview(t, "claude", accountRef)}, jobs)

	recorder := postReauth(t, handler, testProvider, testRefText)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d，期望 404", recorder.Code)
	}
	assertText(t, decodeBody(t, recorder), "error", "account_not_found")
	if jobs.calls != 0 {
		t.Fatalf("Provider 不匹配时不应创建作业，calls = %d", jobs.calls)
	}
}

func TestServeHTTPRejectsInvalidAccountPath(t *testing.T) {
	jobs := &stubJobs{job: pendingJob()}
	handler := newReauthHandler(t, testAuthorizer(true),
		stubDirectory{overview: testOverview(t, testProvider, testAccountRef(t))}, jobs)

	recorder := postReauth(t, handler, testProvider, "not-a-account-ref")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d，期望 400", recorder.Code)
	}
	assertText(t, decodeBody(t, recorder), "error", "invalid_account_path")
}

func TestServeHTTPStartsReauthJob(t *testing.T) {
	accountRef := testAccountRef(t)
	jobs := &stubJobs{job: pendingJob()}
	handler := newReauthHandler(t, testAuthorizer(true),
		stubDirectory{overview: testOverview(t, testProvider, accountRef)}, jobs)

	recorder := postReauth(t, handler, testProvider, testRefText)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d，期望 200（正文 %s）", recorder.Code, recorder.Body.String())
	}
	payload := decodeBody(t, recorder)
	assertBool(t, payload, "ok", true)
	assertText(t, payload, "provider", testProvider)
	assertText(t, payload, "accountRef", accountRef.String())
	assertText(t, payload, "accountLabel", "重新认证账号")
	assertText(t, payload, "purpose", string(accountauth.PurposeReauth))
	assertText(t, payload, "status", string(accountauth.StatusPending))
	assertText(t, payload, "jobId", testJobID)
	assertText(t, payload, "authorizationUrl", pendingJob().AuthorizationURL)
	assertBool(t, payload, "alreadyRunning", false)
	assertBool(t, payload, "partial", true)
	if _, ok := payload["expiresAt"].(float64); !ok {
		t.Fatalf("expiresAt 缺失或不是毫秒数字: %v", payload["expiresAt"])
	}
	if fields, ok := payload["unfilledFields"].([]any); !ok || len(fields) == 0 {
		t.Fatalf("unfilledFields 应显式列出 Node 独有键: %v", payload["unfilledFields"])
	}
	if jobs.calls != 1 || len(jobs.requests) != 1 {
		t.Fatalf("Start 调用次数 = %d，期望 1", jobs.calls)
	}
	if jobs.requests[0].ProviderID != testProvider || jobs.requests[0].AccountRef != accountRef {
		t.Fatalf("Start 请求 = %+v，期望 codex/%s", jobs.requests[0], accountRef)
	}
}

func TestServeHTTPReplaysActiveJobWithoutReader(t *testing.T) {
	jobs := &stubStarterOnly{job: pendingJob()}
	handler := newReauthHandler(t, testAuthorizer(true),
		stubDirectory{overview: testOverview(t, testProvider, testAccountRef(t))}, jobs)

	first := postReauth(t, handler, testProvider, testRefText)
	if first.Code != http.StatusOK {
		t.Fatalf("首次 status = %d，期望 200", first.Code)
	}
	// 第二次重复点击：应用层报告同一 Provider 已有作业。
	jobs.err = accountauth.ErrActiveJobExists
	second := postReauth(t, handler, testProvider, testRefText)
	if second.Code != http.StatusOK {
		t.Fatalf("重复请求 status = %d，期望 200（正文 %s）", second.Code, second.Body.String())
	}
	payload := decodeBody(t, second)
	assertText(t, payload, "jobId", testJobID)
	assertText(t, payload, "authorizationUrl", pendingJob().AuthorizationURL)
	assertBool(t, payload, "alreadyRunning", true)
	if jobs.calls != 2 {
		t.Fatalf("Start 调用次数 = %d，期望 2（第二次由应用层拒绝）", jobs.calls)
	}
}

func TestServeHTTPReplaysActiveJobWithReader(t *testing.T) {
	jobs := &stubJobs{job: pendingJob(), active: map[string]bool{testJobID: true}}
	handler := newReauthHandler(t, testAuthorizer(true),
		stubDirectory{overview: testOverview(t, testProvider, testAccountRef(t))}, jobs)

	if recorder := postReauth(t, handler, testProvider, testRefText); recorder.Code != http.StatusOK {
		t.Fatalf("首次 status = %d，期望 200", recorder.Code)
	}
	jobs.err = accountauth.ErrActiveJobExists
	recorder := postReauth(t, handler, testProvider, testRefText)
	if recorder.Code != http.StatusOK {
		t.Fatalf("重复请求 status = %d，期望 200（正文 %s）", recorder.Code, recorder.Body.String())
	}
	payload := decodeBody(t, recorder)
	assertText(t, payload, "jobId", testJobID)
	assertBool(t, payload, "alreadyRunning", true)
}

func TestServeHTTPDoesNotReplayFinishedJob(t *testing.T) {
	jobs := &stubJobs{job: pendingJob(), active: map[string]bool{testJobID: true}}
	handler := newReauthHandler(t, testAuthorizer(true),
		stubDirectory{overview: testOverview(t, testProvider, testAccountRef(t))}, jobs)

	if recorder := postReauth(t, handler, testProvider, testRefText); recorder.Code != http.StatusOK {
		t.Fatalf("首次 status = %d，期望 200", recorder.Code)
	}
	// 上次作业已经结束，新的 Start 又被拒绝：不能把终态作业当成幂等结果。
	jobs.err = accountauth.ErrActiveJobExists
	jobs.active[testJobID] = false
	recorder := postReauth(t, handler, testProvider, testRefText)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d，期望 409（正文 %s）", recorder.Code, recorder.Body.String())
	}
	payload := decodeBody(t, recorder)
	assertText(t, payload, "error", "reauth_account_failed")
	assertText(t, payload, "code", "oauth_job_already_running")
	// 终态作业已经被丢弃，不能在 409 里回填一个已经结束的 Job ID。
	if jobID, found := payload["jobId"]; found {
		t.Fatalf("终态作业不应出现在 409 响应里: %v", jobID)
	}
}

func TestServeHTTPMapsStartFailure(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		status int
		family string
		code   string
	}{
		{
			name:   "provider 没有 Go 登录流程",
			err:    accountauth.ErrUnsupportedProvider,
			status: http.StatusBadRequest,
			family: "reauth_unsupported",
			code:   "unsupported_provider",
		},
		{
			name:   "凭据不支持原地重新认证",
			err:    accountapp.ErrReauthenticationUnsupported,
			status: http.StatusBadRequest,
			family: "reauth_unsupported",
			code:   "reauth_unsupported",
		},
		{
			name:   "作业容量已满",
			err:    accountauth.ErrJobCapacity,
			status: http.StatusServiceUnavailable,
			family: "reauth_unavailable",
			code:   "oauth_job_capacity",
		},
		{
			name:   "未知失败",
			err:    errors.New("boom"),
			status: http.StatusInternalServerError,
			family: "reauth_account_failed",
			code:   "",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			jobs := &stubJobs{err: testCase.err}
			handler := newReauthHandler(t, testAuthorizer(true),
				stubDirectory{overview: testOverview(t, testProvider, testAccountRef(t))}, jobs)
			recorder := postReauth(t, handler, testProvider, testRefText)
			if recorder.Code != testCase.status {
				t.Fatalf("status = %d，期望 %d（正文 %s）",
					recorder.Code, testCase.status, recorder.Body.String())
			}
			payload := decodeBody(t, recorder)
			assertText(t, payload, "error", testCase.family)
			if testCase.code != "" {
				assertText(t, payload, "code", testCase.code)
			}
		})
	}
}


type metaStubDirectory struct {
	overview accountapp.AccountOverview
	isAPIKey bool
	authKind string
	authMode string
	cred     accountapp.Credential
}

func (dir metaStubDirectory) GetAccountOverview(context.Context, accountcore.AccountRef) (accountapp.AccountOverview, error) {
	return dir.overview, nil
}

func (dir metaStubDirectory) ReadCredentialMeta(context.Context, accountcore.AccountRef) (string, string, bool, error) {
	return dir.authKind, dir.authMode, dir.authKind != "" || dir.authMode != "", nil
}

func (dir metaStubDirectory) IsAPIKeyAccount(context.Context, accountcore.AccountRef) (bool, error) {
	return dir.isAPIKey, nil
}

func (dir metaStubDirectory) GetCredential(context.Context, accountcore.AccountRef) (accountapp.Credential, error) {
	return dir.cred, nil
}

func TestServeHTTPRejectsAPIKeyReauth(t *testing.T) {
	accountRef := testAccountRef(t)
	jobs := &stubJobs{job: pendingJob()}
	h := newReauthHandler(t, testAuthorizer(true), metaStubDirectory{
		overview: testOverview(t, "codex", accountRef),
		isAPIKey: true,
	}, jobs)
	rec := postReauth(t, h, "codex", testRefText)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	body := decodeBody(t, rec)
	assertText(t, body, "error", "reauth_unsupported")
	assertText(t, body, "code", "api_key_reauth_unsupported")
	if jobs.calls != 0 {
		t.Fatalf("jobs.calls = %d, want 0", jobs.calls)
	}
}

func TestServeHTTPInfersZCodeAndKiroSocialHints(t *testing.T) {
	accountRef := testAccountRef(t)

	// ZCode bigmodel credential
	zcodeId, err := accountcore.NewNativeSubjectIdentity("zcode", "zcode-u1")
	if err != nil {
		t.Fatal(err)
	}
	zcodeCred, err := accountcore.NewNativeCredential(zcodeId, []byte(`{"credentials":{"oauth:active_provider":"bigmodel"}}`))
	if err != nil {
		t.Fatal(err)
	}
	jobs := &stubJobs{job: Job{
		ID: testJobID, ProviderID: "zcode", Purpose: "reauth", AuthMode: "oauth-browser",
		AuthStrategy: "bigmodel:custom-scheme", Status: "pending",
		AuthorizationURL: "https://open.bigmodel.cn/authorize", ExpiresAt: time.Now().Add(time.Minute),
	}}
	h := newReauthHandler(t, testAuthorizer(true), metaStubDirectory{
		overview: testOverview(t, "zcode", accountRef),
		cred:     zcodeCred,
	}, jobs)
	rec := postReauth(t, h, "zcode", testRefText)
	if rec.Code != http.StatusOK {
		t.Fatalf("zcode status = %d: %s", rec.Code, rec.Body.String())
	}
	if jobs.requests[0].AuthStrategy != "bigmodel:custom-scheme" {
		t.Fatalf("AuthStrategy = %q, want bigmodel:custom-scheme", jobs.requests[0].AuthStrategy)
	}

	// Kiro social google credential
	kiroId, err := accountcore.NewNativeKiroIdentity("https://codewhisperer.us-east-1.amazonaws.com", "kiro-u1")
	if err != nil {
		t.Fatal(err)
	}
	kiroCred, err := accountcore.NewNativeCredential(kiroId, []byte(`{"sqlite":{"slots":{"kirocli:social:token":"{\"provider\":\"google\"}"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	kiroJobs := &stubJobs{job: Job{
		ID: testJobID, ProviderID: "kiro", Purpose: "reauth", AuthMode: "oauth-device",
		AuthStrategy: "social-oauth-device", PollIntervalMS: 2000, Status: "pending",
		AuthorizationURL: "https://prod.us-east-1.auth.desktop.kiro.dev/verify", UserCode: "K1R0",
		ExpiresAt: time.Now().Add(time.Minute),
	}}
	h2 := newReauthHandler(t, testAuthorizer(true), metaStubDirectory{
		overview: testOverview(t, "kiro", accountRef),
		cred:     kiroCred,
	}, kiroJobs)
	rec2 := postReauth(t, h2, "kiro", testRefText)
	if rec2.Code != http.StatusOK {
		t.Fatalf("kiro status = %d: %s", rec2.Code, rec2.Body.String())
	}
	if kiroJobs.requests[0].LoginProvider != "Google" || kiroJobs.requests[0].AuthStrategy != "social-oauth-device" {
		t.Fatalf("kiro req = %+v", kiroJobs.requests[0])
	}
	respBody := decodeBody(t, rec2)
	if poll, _ := respBody["pollIntervalMs"].(float64); poll != 2000 {
		t.Fatalf("pollIntervalMs = %v, want 2000", respBody["pollIntervalMs"])
	}
}
