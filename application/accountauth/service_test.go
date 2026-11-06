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
			// 缺口（锁现状）：同一个 Job 的第二次 Complete 当前返回
			// ErrJobNotPending，而不是幂等地返回已完成的 Job。浏览器重复
			// 命中回调或客户端重试时会把成功登录报告成错误；切流前必须
			// 改成幂等（已 completed 的 Job 直接回放终态结果）。
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
			// 缺口（锁现状）：上游只给 access+refresh 时 exchangeTokens 把
			// 缺失 id_token 归类为 ErrProviderUnavailable，和网络故障同码。
			// 这会把上游合同破坏伪装成可重试故障，切流前应改成
			// provider_rejected / invalid_artifacts。
			name:              "missing_id_token",
			status:            http.StatusOK,
			body:              missingIDTokenBody,
			callback:          validServiceCallback,
			wantErr:           accountauth.ErrProviderUnavailable,
			wantStatus:        accountauth.StatusFailed,
			wantFailure:       "provider_unavailable",
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
				if _, repeatErr := service.Complete(ctx, start.Job().ID(), testCase.callback(state)); !errors.Is(repeatErr, accountauth.ErrJobNotPending) {
					t.Fatalf("第二次 Complete() error = %v, want %v", repeatErr, accountauth.ErrJobNotPending)
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
