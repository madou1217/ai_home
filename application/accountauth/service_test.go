package accountauth_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/codexoauth"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

const (
	serviceRedirectURI       = "http://localhost:1455/auth/callback"
	serviceJobID             = "0123456789abcdef0123456789abcdef"
	serviceAccountID         = "ws_accountauth_test"
	serviceAuthorizationCode = "test-authorization-code"
	serviceCLIAccountID      = 7
)

// serviceNow 固定 Job 与 artifact 时间，避免测试依赖真实时钟。
func serviceNow() time.Time {
	return time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
}

// serviceJWT 生成只有 payload 参与解析的测试 JWT。
func serviceJWT(payload string) string {
	encode := base64.RawURLEncoding.EncodeToString
	return encode([]byte(`{"alg":"none","typ":"JWT"}`)) + "." +
		encode([]byte(payload)) + ".sig"
}

// serviceTokens 返回一组 claim 完整的官方 Token。
func serviceTokens() map[string]string {
	idToken := serviceJWT(`{"sub":"user-accountauth-test","email":"accountauth@example.com","https://api.openai.com/auth":{"chatgpt_user_id":"user-accountauth-test","chatgpt_account_id":"ws_accountauth_test","chatgpt_plan_type":"plus"}}`)
	accessToken := serviceJWT(`{"sub":"user-accountauth-test","exp":4102444800}`)
	refreshToken := serviceJWT(`{"sub":"user-accountauth-test","exp":4102444800}`)
	return map[string]string{
		"id_token":      idToken,
		"access_token":  accessToken,
		"refresh_token": refreshToken,
	}
}

// serviceTokenBody 用真实 JSON 编码构造上游响应。
func serviceTokenBody(t *testing.T, fields map[string]string) string {
	t.Helper()
	body, err := json.Marshal(fields)
	if err != nil {
		t.Fatalf("marshal token body: %v", err)
	}
	return string(body)
}

// fakeTokenUpstream 记录假 token 端点的调用次数。
type fakeTokenUpstream struct {
	status int
	body   string
	calls  int
}

func (upstream *fakeTokenUpstream) serve(w http.ResponseWriter, _ *http.Request) {
	upstream.calls++
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(upstream.status)
	_, _ = io.WriteString(w, upstream.body)
}

// fixedHostTransport 把生产 token 端点重写到本机 httptest 服务，
// 这样服务级测试仍然通过 codexoauth.New 使用真实 Provider。
type fixedHostTransport struct {
	target *url.URL
}

func (transport fixedHostTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	rewritten := request.Clone(request.Context())
	rewritten.URL.Scheme = transport.target.Scheme
	rewritten.URL.Host = transport.target.Host
	rewritten.Host = ""
	return http.DefaultTransport.RoundTrip(rewritten)
}

func newRewritingClient(t *testing.T, server *httptest.Server) *http.Client {
	t.Helper()
	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("解析 httptest URL 失败: %v", err)
	}
	return &http.Client{Transport: fixedHostTransport{target: target}}
}

// recordingRegistrar 统计注册次数，并把真实凭据换成可查询的账号快照。
type recordingRegistrar struct {
	catalog    *providers.Catalog
	now        time.Time
	calls      int
	credential accountapp.Credential
	profile    accountapp.PublicProfile
	account    accountcore.Account
}

func (registrar *recordingRegistrar) Register(
	_ context.Context,
	credential accountapp.Credential,
	profile accountapp.PublicProfile,
) (accountcore.Account, error) {
	registrar.calls++
	registrar.credential = credential
	registrar.profile = profile
	ref, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		return accountcore.Account{}, err
	}
	account, err := accountcore.RestoreAccount(registrar.catalog, accountcore.RestoreAccountInput{
		Ref:          ref,
		ProviderID:   credential.ProviderID(),
		CLIAccountID: serviceCLIAccountID,
		Enabled:      true,
		CreatedAt:    registrar.now,
		UpdatedAt:    registrar.now,
	})
	if err != nil {
		return accountcore.Account{}, err
	}
	registrar.account = account
	return account, nil
}

// stubReauth 让注册 Job 永远不会走到 reauth 分支。
type stubReauth struct{}

func (stubReauth) ValidateTarget(context.Context, accountcore.AccountRef, string) error {
	return nil
}

func (stubReauth) Reauthenticate(
	context.Context,
	accountcore.AccountRef,
	accountapp.Credential,
	accountapp.PublicProfile,
) (accountcore.Account, error) {
	return accountcore.Account{}, accountauth.ErrInvalidStartRequest
}

// stubClaudeProvider 满足 Service 要求两个 Provider 注册的边界，流程不被调用。
type stubClaudeProvider struct{}

func (stubClaudeProvider) ProviderID() string { return "claude" }

func (stubClaudeProvider) Begin(context.Context) (accountauth.OAuthFlow, error) {
	return stubClaudeFlow{}, nil
}

type stubClaudeFlow struct{}

func (stubClaudeFlow) AuthorizationURL() string { return "https://claude.ai/oauth/authorize" }

func (stubClaudeFlow) Exchange(context.Context, string) ([]byte, error) {
	return nil, accountauth.ErrProviderUnavailable
}

// newTestService 用真实的 codexoauth Provider 与 nativeaccount Decoder 组装服务。
func newTestService(t *testing.T, client *http.Client, registrar accountauth.Registrar) *accountauth.Service {
	t.Helper()
	now := serviceNow()
	codexProvider, err := codexoauth.New(client, func() time.Time { return now })
	if err != nil {
		t.Fatalf("codexoauth.New() error = %v", err)
	}
	service, err := accountauth.NewService(accountauth.Dependencies{
		Providers:  []accountauth.OAuthProvider{codexProvider, stubClaudeProvider{}},
		Decoder:    nativeaccount.NewDecoder(),
		Registrar:  registrar,
		Reauth:     stubReauth{},
		Clock:      func() time.Time { return now },
		GenerateID: func() (string, error) { return serviceJobID, nil },
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	return service
}

// authorizationState 从 Begin 产出的授权地址取回本次 state。
func authorizationState(t *testing.T, authorizationURL string) string {
	t.Helper()
	parsed, err := url.Parse(authorizationURL)
	if err != nil {
		t.Fatalf("授权 URL 无法解析: %v", err)
	}
	state := parsed.Query().Get("state")
	if state == "" {
		t.Fatal("授权 URL 缺少 state")
	}
	return state
}

// validServiceCallback 生成与官方 redirect 完全匹配的回调 URL。
func validServiceCallback(state string) string {
	return serviceRedirectURI +
		"?code=" + url.QueryEscape(serviceAuthorizationCode) +
		"&state=" + url.QueryEscape(state)
}

// loginCase 描述一个完整 Begin→Complete 场景的输入与期望。
type loginCase struct {
	name              string
	status            int
	body              string
	callback          func(state string) string
	completeTwice     bool
	wantErr           error
	wantStatus        accountauth.Status
	wantFailure       string
	wantTokenCalls    int
	wantRegistrations int
	wantAccountID     string
}

// TestLoginFlowTable 覆盖 Codex 登录的服务级行为：
// 成功注册、坏 state、坏 redirect、上游 4xx/5xx、重复回调与缺失 id_token。
func TestLoginFlowTable(t *testing.T) {
	tokens := serviceTokens()
	fullBody := serviceTokenBody(t, tokens)
	missingIDTokenBody := serviceTokenBody(t, map[string]string{
		"access_token":  tokens["access_token"],
		"refresh_token": tokens["refresh_token"],
	})

	testCases := []loginCase{
		{
			name:              "good_callback",
			status:            http.StatusOK,
			body:              fullBody,
			callback:          validServiceCallback,
			wantStatus:        accountauth.StatusCompleted,
			wantTokenCalls:    1,
			wantRegistrations: 1,
			wantAccountID:     serviceAccountID,
		},
		{
			name:   "state_mismatch",
			status: http.StatusOK,
			body:   fullBody,
			callback: func(string) string {
				return validServiceCallback("forged-state")
			},
			wantErr:           accountauth.ErrStateMismatch,
			wantStatus:        accountauth.StatusFailed,
			wantFailure:       "state_mismatch",
			wantTokenCalls:    0,
			wantRegistrations: 0,
		},
		{
			name:   "redirect_scheme_mismatch",
			status: http.StatusOK,
			body:   fullBody,
			callback: func(state string) string {
				return strings.Replace(validServiceCallback(state), "http://", "https://", 1)
			},
			wantErr:           accountauth.ErrInvalidCallback,
			wantStatus:        accountauth.StatusFailed,
			wantFailure:       "invalid_callback",
			wantTokenCalls:    0,
			wantRegistrations: 0,
		},
		{
			name:   "redirect_host_mismatch",
			status: http.StatusOK,
			body:   fullBody,
			callback: func(state string) string {
				return strings.Replace(validServiceCallback(state), "localhost:1455", "evil.example:1455", 1)
			},
			wantErr:           accountauth.ErrInvalidCallback,
			wantStatus:        accountauth.StatusFailed,
			wantFailure:       "invalid_callback",
			wantTokenCalls:    0,
			wantRegistrations: 0,
		},
		{
			name:   "redirect_path_mismatch",
			status: http.StatusOK,
			body:   fullBody,
			callback: func(state string) string {
				return strings.Replace(validServiceCallback(state), "/auth/callback?", "/auth/callback/extra?", 1)
			},
			wantErr:           accountauth.ErrInvalidCallback,
			wantStatus:        accountauth.StatusFailed,
			wantFailure:       "invalid_callback",
			wantTokenCalls:    0,
			wantRegistrations: 0,
		},
		{
			name:              "upstream_4xx",
			status:            http.StatusBadRequest,
			body:              `{"error":"invalid_grant"}`,
			callback:          validServiceCallback,
			wantErr:           accountauth.ErrProviderRejected,
			wantStatus:        accountauth.StatusFailed,
			wantFailure:       "provider_rejected",
			wantTokenCalls:    1,
			wantRegistrations: 0,
		},
		{
			name:              "upstream_5xx",
			status:            http.StatusServiceUnavailable,
			body:              "",
			callback:          validServiceCallback,
			wantErr:           accountauth.ErrProviderUnavailable,
			wantStatus:        accountauth.StatusFailed,
			wantFailure:       "provider_unavailable",
			wantTokenCalls:    1,
			wantRegistrations: 0,
		},
		{
			// 重复回调必须幂等回放：浏览器重复命中回调或客户端网络重试
			// 不应再次交换 Token 或重复注册账号；第二次 Complete 直接返回
			// 第一次的终态快照（account_ref / cli_account_id 等字段不变）。
			name:              "duplicate_callback",
			status:            http.StatusOK,
			body:              fullBody,
			callback:          validServiceCallback,
			completeTwice:     true,
			wantStatus:        accountauth.StatusCompleted,
			wantTokenCalls:    1,
			wantRegistrations: 1,
			wantAccountID:     serviceAccountID,
		},
		{
			// 上游只给 access+refresh 是合同破坏：归类为不可重试的
			// provider_rejected，重试不会让上游补上 id_token。
			name:              "missing_id_token",
			status:            http.StatusOK,
			body:              missingIDTokenBody,
			callback:          validServiceCallback,
			wantErr:           accountauth.ErrProviderRejected,
			wantStatus:        accountauth.StatusFailed,
			wantFailure:       "provider_rejected",
			wantTokenCalls:    1,
			wantRegistrations: 0,
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			ctx := context.Background()
			upstream := &fakeTokenUpstream{status: testCase.status, body: testCase.body}
			server := httptest.NewServer(http.HandlerFunc(upstream.serve))
			t.Cleanup(server.Close)

			catalog, err := providers.NewCatalog(providers.BuiltinManifest())
			if err != nil {
				t.Fatalf("NewCatalog() error = %v", err)
			}
			registrar := &recordingRegistrar{catalog: catalog, now: serviceNow()}
			service := newTestService(t, newRewritingClient(t, server), registrar)

			start, err := service.Start(ctx, accountauth.StartRequest{ProviderID: "codex"})
			if err != nil {
				t.Fatalf("Start() error = %v", err)
			}
			state := authorizationState(t, start.AuthorizationURL())
			job, err := service.Complete(ctx, start.Job().ID(), testCase.callback(state))

			if testCase.wantErr != nil {
				if !errors.Is(err, testCase.wantErr) {
					t.Fatalf("Complete() error = %v, want %v", err, testCase.wantErr)
				}
			} else if err != nil {
				t.Fatalf("Complete() error = %v", err)
			}
			if job.Status() != testCase.wantStatus {
				t.Fatalf("Job.Status() = %q, want %q", job.Status(), testCase.wantStatus)
			}
			if job.FailureCode() != testCase.wantFailure {
				t.Fatalf("Job.FailureCode() = %q, want %q", job.FailureCode(), testCase.wantFailure)
			}
			if upstream.calls != testCase.wantTokenCalls {
				t.Fatalf("token 端点调用次数 = %d, want %d", upstream.calls, testCase.wantTokenCalls)
			}
			if registrar.calls != testCase.wantRegistrations {
				t.Fatalf("注册次数 = %d, want %d", registrar.calls, testCase.wantRegistrations)
			}

			if testCase.wantAccountID != "" {
				credential, ok := registrar.credential.(*codex.OAuthAuth)
				if !ok {
					t.Fatalf("注册凭据类型 = %T, want *codex.OAuthAuth", registrar.credential)
				}
				if credential.UpstreamAccountID() != testCase.wantAccountID {
					t.Fatalf("凭据 account_id = %q, want %q", credential.UpstreamAccountID(), testCase.wantAccountID)
				}
				if credential.Email() != "accountauth@example.com" {
					t.Fatalf("凭据 email = %q", credential.Email())
				}
				if job.AccountRef() != registrar.account.Ref() {
					t.Fatalf("Job.AccountRef() = %q, want %q", job.AccountRef(), registrar.account.Ref())
				}
				if job.CLIAccountID().Int64() != serviceCLIAccountID {
					t.Fatalf("Job.CLIAccountID() = %d, want %d", job.CLIAccountID().Int64(), serviceCLIAccountID)
				}
				stored, getErr := service.GetJob(ctx, start.Job().ID())
				if getErr != nil || stored.Status() != accountauth.StatusCompleted {
					t.Fatalf("GetJob() = (%q, %v), want completed", stored.Status(), getErr)
				}
			}

			if testCase.completeTwice {
				replay, repeatErr := service.Complete(
					ctx,
					start.Job().ID(),
					testCase.callback(state),
				)
				if repeatErr != nil {
					t.Fatalf("第二次 Complete() error = %v, want nil（终态回放）", repeatErr)
				}
				if replay.Status() != job.Status() ||
					replay.AccountRef() != job.AccountRef() ||
					replay.CLIAccountID() != job.CLIAccountID() ||
					replay.FailureCode() != job.FailureCode() {
					t.Fatalf(
						"第二次 Complete() 回放 = %+v, want %+v",
						replay,
						job,
					)
				}
				if upstream.calls != testCase.wantTokenCalls {
					t.Fatalf("第二次回调后 token 调用 = %d, want %d", upstream.calls, testCase.wantTokenCalls)
				}
				if registrar.calls != testCase.wantRegistrations {
					t.Fatalf("第二次回调后注册次数 = %d, want %d", registrar.calls, testCase.wantRegistrations)
				}
			}
		})
	}
}

// gatedTokenUpstream 把 token 交换挂在 release 之前，用来构造
// 「唯一执行者仍处于 processing、第二个 Complete 已经到达」的并发时序。
type gatedTokenUpstream struct {
	body    string
	started chan struct{}
	release chan struct{}
	calls   atomic.Int32
}

func newGatedTokenUpstream(body string) *gatedTokenUpstream {
	return &gatedTokenUpstream{
		body:    body,
		started: make(chan struct{}, 1),
		release: make(chan struct{}),
	}
}

func (upstream *gatedTokenUpstream) serve(w http.ResponseWriter, _ *http.Request) {
	upstream.calls.Add(1)
	select {
	case upstream.started <- struct{}{}:
	default:
	}
	<-upstream.release
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, upstream.body)
}

// newCodexLoginFixture 组装真实 codex Provider、httptest token 端点与记录型注册器。
func newCodexLoginFixture(
	t *testing.T,
	handler http.Handler,
) (*accountauth.Service, *recordingRegistrar) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	registrar := &recordingRegistrar{catalog: catalog, now: serviceNow()}
	return newTestService(t, newRewritingClient(t, server), registrar), registrar
}

// TestCompleteReplaysFailedJobWithSameCode 验证失败终态也是幂等回放：
// 第二次 Complete 不再调用 token 端点，返回与第一次相同的 failure_code。
func TestCompleteReplaysFailedJobWithSameCode(t *testing.T) {
	ctx := context.Background()
	upstream := &fakeTokenUpstream{status: http.StatusServiceUnavailable}
	service, registrar := newCodexLoginFixture(
		t,
		http.HandlerFunc(upstream.serve),
	)

	start, err := service.Start(ctx, accountauth.StartRequest{ProviderID: "codex"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	callback := validServiceCallback(
		authorizationState(t, start.AuthorizationURL()),
	)
	first, err := service.Complete(ctx, start.Job().ID(), callback)
	if !errors.Is(err, accountauth.ErrProviderUnavailable) {
		t.Fatalf("第一次 Complete() error = %v, want %v", err, accountauth.ErrProviderUnavailable)
	}
	if first.Status() != accountauth.StatusFailed ||
		first.FailureCode() != "provider_unavailable" {
		t.Fatalf("第一次 Complete() = %+v", first)
	}

	replay, err := service.Complete(ctx, start.Job().ID(), callback)
	if err != nil {
		t.Fatalf("失败终态回放不应重新报错: %v", err)
	}
	if replay.Status() != accountauth.StatusFailed ||
		replay.FailureCode() != first.FailureCode() ||
		!replay.FinishedAt().Equal(first.FinishedAt()) {
		t.Fatalf("失败终态回放 = %+v, want %+v", replay, first)
	}
	if upstream.calls != 1 {
		t.Fatalf("第二次 Complete() 重新调用了 token 端点: calls = %d", upstream.calls)
	}
	if registrar.calls != 0 {
		t.Fatalf("失败回放不应注册账号: calls = %d", registrar.calls)
	}
}

// TestCompleteIsIdempotentForConcurrentCalls 验证两个并发 Complete 只有一个
// 执行 token 交换与账号注册，另一个等待后拿到完全一致的终态快照。
func TestCompleteIsIdempotentForConcurrentCalls(t *testing.T) {
	ctx := context.Background()
	upstream := newGatedTokenUpstream(serviceTokenBody(t, serviceTokens()))
	service, registrar := newCodexLoginFixture(
		t,
		http.HandlerFunc(upstream.serve),
	)

	start, err := service.Start(ctx, accountauth.StartRequest{ProviderID: "codex"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	jobID := start.Job().ID()
	callback := validServiceCallback(
		authorizationState(t, start.AuthorizationURL()),
	)

	type completeResult struct {
		job accountauth.Job
		err error
	}
	results := make(chan completeResult, 2)
	complete := func() {
		job, completeErr := service.Complete(ctx, jobID, callback)
		results <- completeResult{job: job, err: completeErr}
	}
	var wait sync.WaitGroup
	wait.Add(1)
	go func() {
		defer wait.Done()
		complete()
	}()
	select {
	case <-upstream.started:
	case <-time.After(5 * time.Second):
		t.Fatal("第一个 Complete 没有进入 token 交换")
	}

	wait.Add(1)
	go func() {
		defer wait.Done()
		complete()
	}()
	// 唯一执行者仍被挂起时，第二个调用必须等待，而不是提前返回 job_not_pending。
	select {
	case early := <-results:
		t.Fatalf(
			"第二个 Complete 在唯一执行者完成前返回: job=%+v err=%v",
			early.job,
			early.err,
		)
	case <-time.After(50 * time.Millisecond):
	}

	close(upstream.release)
	wait.Wait()
	close(results)

	var completed []accountauth.Job
	for result := range results {
		if result.err != nil {
			t.Fatalf("Complete() error = %v", result.err)
		}
		completed = append(completed, result.job)
	}
	if len(completed) != 2 {
		t.Fatalf("Complete() 返回 %d 个结果, want 2", len(completed))
	}
	for _, job := range completed {
		if job.Status() != accountauth.StatusCompleted {
			t.Fatalf("Job.Status() = %q, want completed", job.Status())
		}
		if job.AccountRef() != registrar.account.Ref() {
			t.Fatalf("Job.AccountRef() = %q, want %q", job.AccountRef(), registrar.account.Ref())
		}
		if job.CLIAccountID() != registrar.account.CLIAccountID() {
			t.Fatalf("Job.CLIAccountID() = %d, want %d", job.CLIAccountID(), registrar.account.CLIAccountID())
		}
	}
	if completed[0].AccountRef() != completed[1].AccountRef() ||
		completed[0].CLIAccountID() != completed[1].CLIAccountID() ||
		!completed[0].FinishedAt().Equal(completed[1].FinishedAt()) {
		t.Fatalf("并发 Complete 结果不一致: %+v / %+v", completed[0], completed[1])
	}
	if upstream.calls.Load() != 1 {
		t.Fatalf("token 端点调用次数 = %d, want 1", upstream.calls.Load())
	}
	if registrar.calls != 1 {
		t.Fatalf("注册次数 = %d, want 1", registrar.calls)
	}
}
