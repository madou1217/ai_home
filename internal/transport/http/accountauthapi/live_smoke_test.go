package accountauthapi_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/claudeoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/codexoauth"
	"github.com/madou1217/ai_home/internal/adapters/accounts/cliproxyapi"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sub2api"
	"github.com/madou1217/ai_home/internal/testsupport/accountmodels"
	"github.com/madou1217/ai_home/internal/transport/http/accountauthapi"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

const (
	smokeManagementKey   = "synthetic-oauth-live-smoke-management-key"
	smokeCodexAccess     = "synthetic-oauth-live-codex-access"
	smokeCodexRefresh    = "synthetic-oauth-live-codex-refresh"
	smokeCodexReauth     = "synthetic-oauth-live-codex-reauth"
	smokeCodexReauthRT   = "synthetic-oauth-live-codex-reauth-refresh"
	smokeCodexWrong      = "synthetic-oauth-live-codex-wrong"
	smokeCodexWrongRT    = "synthetic-oauth-live-codex-wrong-refresh"
	smokeClaudeAccess    = "sk-ant-oat01-synthetic-oauth-live-claude-access"
	smokeClaudeRefresh   = "sk-ant-ort01-synthetic-oauth-live-claude-refresh"
	smokeClaudeReauth    = "sk-ant-oat01-synthetic-oauth-live-claude-reauth"
	smokeClaudeReauthRT  = "sk-ant-ort01-synthetic-oauth-live-claude-reauth"
	smokeClaudeAccountID = "123e4567-e89b-12d3-a456-426614174555"
)

// TestOAuthJobLiveSmoke 使用真实 TCP、SQLite 和伪造 OAuth 上游验证两种 Provider 完整链路。
func TestOAuthJobLiveSmoke(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			handleFakeOAuthUpstream(t, response, request)
		},
	))
	defer upstream.Close()

	clock := newLiveClock()
	handler, store := newLiveManagementHandler(t, upstream.URL, clock.now)
	server := httptest.NewServer(handler)
	defer server.Close()

	codexJob := startLiveJob(t, server, "codex", "")
	codexCallback := "http://localhost:1455/auth/callback?code=codex-live-code&state=" +
		url.QueryEscape(codexJob.state)
	codexCompleted := completeLiveJob(
		t,
		server,
		codexJob.id,
		codexCallback,
	)
	codexAccount := assertCompletedJob(t, codexCompleted, "codex", 1)

	claudeJob := startLiveJob(t, server, "claude", "")
	claudeCompleted := completeLiveJob(
		t,
		server,
		claudeJob.id,
		"claude-live-code#"+claudeJob.state,
	)
	claudeAccount := assertCompletedJob(t, claudeCompleted, "claude", 1)

	clock.advance(2 * time.Second)
	codexReauthJob := startLiveJob(
		t,
		server,
		"codex",
		codexAccount.accountRef,
	)
	codexReauthCompleted := completeLiveJob(
		t,
		server,
		codexReauthJob.id,
		"http://localhost:1455/auth/callback?code=codex-reauth-code&state="+
			url.QueryEscape(codexReauthJob.state),
	)
	assertSameReauthenticatedAccount(
		t,
		codexReauthCompleted,
		codexAccount,
	)

	claudeReauthJob := startLiveJob(
		t,
		server,
		"claude",
		claudeAccount.accountRef,
	)
	claudeReauthCompleted := completeLiveJob(
		t,
		server,
		claudeReauthJob.id,
		"claude-reauth-code#"+claudeReauthJob.state,
	)
	assertSameReauthenticatedAccount(
		t,
		claudeReauthCompleted,
		claudeAccount,
	)

	clock.advance(2 * time.Second)
	wrongJob := startLiveJob(
		t,
		server,
		"codex",
		codexAccount.accountRef,
	)
	wrongCallback := submitLiveJobCallback(
		t,
		server,
		wrongJob.id,
		"http://localhost:1455/auth/callback?code=codex-wrong-code&state="+
			url.QueryEscape(wrongJob.state),
	)
	if wrongCallback.status != http.StatusConflict ||
		!strings.Contains(
			wrongCallback.responseBody,
			`"code":"reauthentication_identity_mismatch"`,
		) {
		t.Fatalf(
			"错误身份 reauth status=%d body=%s",
			wrongCallback.status,
			wrongCallback.responseBody,
		)
	}
	wrongJobStatus := performLiveRequest(
		t,
		server.Client(),
		http.MethodGet,
		server.URL+accountauthapi.CollectionPath+"/"+wrongJob.id,
		nil,
	)
	logLiveExchange(t, wrongJobStatus)
	if wrongJobStatus.status != http.StatusOK ||
		!strings.Contains(
			wrongJobStatus.responseBody,
			`"failure_code":"reauthentication_identity_mismatch"`,
		) {
		t.Fatalf(
			"错误身份 Job status=%d body=%s",
			wrongJobStatus.status,
			wrongJobStatus.responseBody,
		)
	}
	assertReauthenticationCredentials(
		t,
		store,
		codexAccount.accountRef,
		claudeAccount.accountRef,
	)

	listed := performLiveRequest(
		t,
		server.Client(),
		http.MethodGet,
		server.URL+accountsapi.CollectionPath+"?limit=10",
		nil,
	)
	logLiveExchange(t, listed)
	if listed.status != http.StatusOK {
		t.Fatalf("账号列表 status=%d body=%s", listed.status, listed.responseBody)
	}
	var listDocument struct {
		Data []struct {
			ProviderID       string `json:"provider_id"`
			CLIAccountID     int64  `json:"cli_account_id"`
			AuthKind         string `json:"auth_kind"`
			AuthMode         string `json:"auth_mode"`
			Email            string `json:"email"`
			SubscriptionKind string `json:"subscription_kind"`
		} `json:"data"`
	}
	decodeLiveJSON(t, listed.responseBody, &listDocument)
	if len(listDocument.Data) != 2 {
		t.Fatalf("账号列表 data = %#v", listDocument.Data)
	}
	found := make(map[string]struct {
		mode  string
		email string
		plan  string
	})
	for _, account := range listDocument.Data {
		if account.AuthKind != "oauth" || account.CLIAccountID != 1 {
			t.Fatalf("账号列表 OAuth 投影错误: %#v", account)
		}
		found[account.ProviderID] = struct {
			mode  string
			email string
			plan  string
		}{
			mode:  account.AuthMode,
			email: account.Email,
			plan:  account.SubscriptionKind,
		}
	}
	if found["codex"].email != "oauth-live-codex-reauth@example.invalid" ||
		found["codex"].plan != "pro" ||
		found["claude"].mode != "refreshable" ||
		found["claude"].email != "oauth-live-claude-reauth@example.invalid" ||
		found["claude"].plan != "pro" {
		t.Fatalf("账号列表 Provider 结果错误: %#v", found)
	}
	assertLiveCLIProxyAPIExport(
		t,
		server,
		codexAccount,
		smokeCodexReauth,
		smokeCodexReauthRT,
		"oauth-live-codex-reauth@example.invalid",
	)
	assertLiveCLIProxyAPIExport(
		t,
		server,
		claudeAccount,
		smokeClaudeReauth,
		smokeClaudeReauthRT,
		"oauth-live-claude-reauth@example.invalid",
	)

	for _, secret := range []string{
		smokeCodexAccess,
		smokeCodexRefresh,
		smokeCodexReauth,
		smokeCodexReauthRT,
		smokeCodexWrong,
		smokeCodexWrongRT,
		smokeClaudeAccess,
		smokeClaudeRefresh,
		smokeClaudeReauth,
		smokeClaudeReauthRT,
		"codex-live-code",
		"claude-live-code",
	} {
		if strings.Contains(codexCompleted.responseBody, secret) ||
			strings.Contains(claudeCompleted.responseBody, secret) ||
			strings.Contains(codexReauthCompleted.responseBody, secret) ||
			strings.Contains(claudeReauthCompleted.responseBody, secret) ||
			strings.Contains(wrongCallback.responseBody, secret) ||
			strings.Contains(wrongJobStatus.responseBody, secret) ||
			strings.Contains(listed.responseBody, secret) {
			t.Fatalf("公开 API 响应泄漏 OAuth 私有值")
		}
	}
}

// assertLiveCLIProxyAPIExport 验证 OAuth 最新快照经过真实 HTTP 与 SQLite 导出。
func assertLiveCLIProxyAPIExport(
	t *testing.T,
	server *httptest.Server,
	account completedLiveAccount,
	accessToken string,
	refreshToken string,
	email string,
) {
	t.Helper()

	exchange := performLiveRequest(
		t,
		server.Client(),
		http.MethodGet,
		server.URL+accountsapi.CollectionPath+"/"+account.accountRef+
			"/export/cliproxyapi",
		nil,
	)
	if exchange.status != http.StatusOK ||
		exchange.responseHeaders.Get("Content-Disposition") !=
			`attachment; filename="cliproxyapi-auth.json"` ||
		exchange.responseHeaders.Get("Cache-Control") != "no-store" {
		t.Fatalf(
			"%s CPA export status=%d headers=%#v",
			account.providerID,
			exchange.status,
			exchange.responseHeaders,
		)
	}
	var document struct {
		Type         string `json:"type"`
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		Email        string `json:"email"`
		Disabled     bool   `json:"disabled"`
	}
	decodeLiveJSON(t, exchange.responseBody, &document)
	if document.Type != account.providerID ||
		document.AccessToken != accessToken ||
		document.RefreshToken != refreshToken ||
		document.Email != email ||
		document.Disabled {
		t.Fatalf("%s CPA export document mismatch", account.providerID)
	}
	redacted := exchange
	redacted.responseBody = redactCLIProxyAPIAuth(t, exchange.responseBody)
	logLiveExchange(t, redacted)
}

// redactCLIProxyAPIAuth 隐藏 CPA auth 文件中的所有 OAuth 私有值。
func redactCLIProxyAPIAuth(t *testing.T, body string) string {
	t.Helper()

	var document map[string]any
	decodeLiveJSON(t, body, &document)
	for _, field := range []string{
		"id_token",
		"access_token",
		"refresh_token",
	} {
		if value, found := document[field].(string); found && value != "" {
			document[field] = "<redacted>"
		}
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("json.Marshal(redacted CPA auth) error = %v", err)
	}
	return string(encoded)
}

// liveJob 保存 smoke 提交回调所需但不会写入日志的短期值。
type liveJob struct {
	id    string
	state string
}

// startLiveJob 创建 OAuth Job，并从一次性授权 URL 提取测试 state。
func startLiveJob(
	t *testing.T,
	server *httptest.Server,
	providerID string,
	targetAccountRef string,
) liveJob {
	t.Helper()

	requestDocument := map[string]string{"provider_id": providerID}
	if targetAccountRef != "" {
		requestDocument["target_account_ref"] = targetAccountRef
	}
	payload, err := json.Marshal(requestDocument)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	exchange := performLiveRequest(
		t,
		server.Client(),
		http.MethodPost,
		server.URL+accountauthapi.CollectionPath,
		payload,
	)
	logLiveExchange(t, redactStartExchange(t, exchange))
	if exchange.status != http.StatusCreated {
		t.Fatalf("创建 %s Job status=%d body=%s", providerID, exchange.status, exchange.responseBody)
	}
	var document struct {
		Data struct {
			JobID            string `json:"job_id"`
			Purpose          string `json:"purpose"`
			TargetAccountRef string `json:"target_account_ref"`
			Status           string `json:"status"`
			AuthorizationURL string `json:"authorization_url"`
		} `json:"data"`
	}
	decodeLiveJSON(t, exchange.responseBody, &document)
	authorizationURL, err := url.Parse(document.Data.AuthorizationURL)
	expectedPurpose := "register"
	if targetAccountRef != "" {
		expectedPurpose = "reauth"
	}
	if err != nil ||
		document.Data.Status != "pending" ||
		document.Data.Purpose != expectedPurpose ||
		document.Data.TargetAccountRef != targetAccountRef ||
		len(document.Data.JobID) != 32 ||
		authorizationURL.Query().Get("state") == "" {
		t.Fatalf("创建 %s Job 响应无效", providerID)
	}
	return liveJob{
		id:    document.Data.JobID,
		state: authorizationURL.Query().Get("state"),
	}
}

// completeLiveJob 提交回调，但日志只显示脱敏后的 payload。
func completeLiveJob(
	t *testing.T,
	server *httptest.Server,
	jobID string,
	callback string,
) liveExchange {
	t.Helper()

	exchange := submitLiveJobCallback(t, server, jobID, callback)
	if exchange.status != http.StatusOK {
		t.Fatalf("完成 Job status=%d body=%s", exchange.status, exchange.responseBody)
	}
	return exchange
}

// submitLiveJobCallback 提交回调并只记录脱敏后的请求 payload。
func submitLiveJobCallback(
	t *testing.T,
	server *httptest.Server,
	jobID string,
	callback string,
) liveExchange {
	t.Helper()

	payload, err := json.Marshal(map[string]string{"callback": callback})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	exchange := performLiveRequest(
		t,
		server.Client(),
		http.MethodPost,
		server.URL+accountauthapi.CollectionPath+"/"+jobID+"/callback",
		payload,
	)
	redacted := exchange
	redacted.requestBody = `{"callback":"<redacted>"}`
	logLiveExchange(t, redacted)
	return exchange
}

// assertCompletedJob 校验 OAuth Job 成功后的公开账号身份。
func assertCompletedJob(
	t *testing.T,
	exchange liveExchange,
	providerID string,
	cliAccountID int64,
) completedLiveAccount {
	t.Helper()

	var document struct {
		Data struct {
			ProviderID   string `json:"provider_id"`
			Purpose      string `json:"purpose"`
			Status       string `json:"status"`
			AccountRef   string `json:"account_ref"`
			CLIAccountID int64  `json:"cli_account_id"`
		} `json:"data"`
	}
	decodeLiveJSON(t, exchange.responseBody, &document)
	if document.Data.ProviderID != providerID ||
		document.Data.Purpose != "register" ||
		document.Data.Status != "completed" ||
		!strings.HasPrefix(document.Data.AccountRef, "acct_") ||
		document.Data.CLIAccountID != cliAccountID {
		t.Fatalf("completed Job = %#v", document.Data)
	}
	return completedLiveAccount{
		providerID:   providerID,
		accountRef:   document.Data.AccountRef,
		cliAccountID: document.Data.CLIAccountID,
	}
}

// completedLiveAccount 保存注册后用于验证 reauth 身份不变的公开投影。
type completedLiveAccount struct {
	providerID   string
	accountRef   string
	cliAccountID int64
}

// assertSameReauthenticatedAccount 验证 reauth 结果保留账号引用和数字别名。
func assertSameReauthenticatedAccount(
	t *testing.T,
	exchange liveExchange,
	expected completedLiveAccount,
) {
	t.Helper()

	var document struct {
		Data struct {
			ProviderID       string `json:"provider_id"`
			Purpose          string `json:"purpose"`
			TargetAccountRef string `json:"target_account_ref"`
			Status           string `json:"status"`
			AccountRef       string `json:"account_ref"`
			CLIAccountID     int64  `json:"cli_account_id"`
		} `json:"data"`
	}
	decodeLiveJSON(t, exchange.responseBody, &document)
	if document.Data.ProviderID != expected.providerID ||
		document.Data.Purpose != "reauth" ||
		document.Data.TargetAccountRef != expected.accountRef ||
		document.Data.Status != "completed" ||
		document.Data.AccountRef != expected.accountRef ||
		document.Data.CLIAccountID != expected.cliAccountID {
		t.Fatalf("reauth completed Job = %#v", document.Data)
	}
}

// assertReauthenticationCredentials 验证成功替换后的 Token 存在且错误身份没有覆盖它。
func assertReauthenticationCredentials(
	t *testing.T,
	store *sqliteaccount.Store,
	codexAccountRef string,
	claudeAccountRef string,
) {
	t.Helper()

	codexRef, err := accountcore.ParseAccountRef(codexAccountRef)
	if err != nil {
		t.Fatalf("ParseAccountRef(codex) error = %v", err)
	}
	codexCredential, err := store.GetCredential(
		context.Background(),
		codexRef,
	)
	if err != nil {
		t.Fatalf("GetCredential(codex) error = %v", err)
	}
	codexOAuth, valid := codexCredential.(*codex.OAuthAuth)
	if !valid ||
		codexOAuth.AccessToken() != smokeCodexReauth ||
		codexOAuth.RefreshToken() != smokeCodexReauthRT {
		t.Fatalf("Codex reauth credential = %T", codexCredential)
	}
	codexProfile, err := store.GetProfile(context.Background(), codexRef)
	if err != nil {
		t.Fatalf("GetProfile(codex) error = %v", err)
	}
	if codexProfile.Profile().Email() !=
		"oauth-live-codex-reauth@example.invalid" {
		t.Fatalf("Codex reauth profile = %#v", codexProfile)
	}

	claudeRef, err := accountcore.ParseAccountRef(claudeAccountRef)
	if err != nil {
		t.Fatalf("ParseAccountRef(claude) error = %v", err)
	}
	claudeCredential, err := store.GetCredential(
		context.Background(),
		claudeRef,
	)
	if err != nil {
		t.Fatalf("GetCredential(claude) error = %v", err)
	}
	claudeOAuth, valid := claudeCredential.(*claude.OAuthAuth)
	if !valid ||
		claudeOAuth.AccessToken() != smokeClaudeReauth ||
		claudeOAuth.RefreshToken() != smokeClaudeReauthRT {
		t.Fatalf("Claude reauth credential = %T", claudeCredential)
	}
}

// newLiveManagementHandler 装配真实 SQLite、账号注册、OAuth Job 和两个 HTTP Handler。
func newLiveManagementHandler(
	t *testing.T,
	upstreamURL string,
	clock func() time.Time,
) (http.Handler, *sqliteaccount.Store) {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	store, err := sqliteaccount.Open(context.Background(), sqliteaccount.OpenOptions{
		AIHomeDir: t.TempDir(),
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open() error = %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("store.Close() error = %v", err)
		}
	})
	modelDiscovery, err := accountmodels.NewDiscovery(catalog)
	if err != nil {
		t.Fatalf("accountmodels.NewDiscovery() error = %v", err)
	}
	registrar, err := accountapp.NewRegistrar(
		catalog,
		store,
		modelDiscovery,
		clock,
	)
	if err != nil {
		t.Fatalf("accounts.NewRegistrar() error = %v", err)
	}
	reauthenticator, err := accountapp.NewReauthenticator(
		catalog,
		store,
		modelDiscovery,
		clock,
	)
	if err != nil {
		t.Fatalf("accounts.NewReauthenticator() error = %v", err)
	}
	management, err := accountapp.NewManagement(store, store, clock)
	if err != nil {
		t.Fatalf("accounts.NewManagement() error = %v", err)
	}
	providerDefaults, err := accountapp.NewProviderDefaults(catalog, store, clock)
	if err != nil {
		t.Fatalf("accounts.NewProviderDefaults() error = %v", err)
	}
	launchAccountSelector, err := accountapp.NewLaunchAccountSelector(catalog, store)
	if err != nil {
		t.Fatalf("accounts.NewLaunchAccountSelector() error = %v", err)
	}
	exportReader, err := accountapp.NewExportReader(store, store, store)
	if err != nil {
		t.Fatalf("accounts.NewExportReader() error = %v", err)
	}
	exporter, err := sub2api.NewExporter(exportReader, clock)
	if err != nil {
		t.Fatalf("sub2api.NewExporter() error = %v", err)
	}
	cliProxyAPIExporter, err := cliproxyapi.NewExporter(exportReader)
	if err != nil {
		t.Fatalf("cliproxyapi.NewExporter() error = %v", err)
	}
	modelManagement, err := accountapp.NewModelManagement(
		store,
		store,
		modelDiscovery,
		clock,
	)
	if err != nil {
		t.Fatalf("accounts.NewModelManagement() error = %v", err)
	}
	usage := liveUsageManagementStub{}
	credentialRotator, err := accountapp.NewStaticCredentialRotator(
		catalog,
		store,
		modelDiscovery,
		clock,
		usage,
	)
	if err != nil {
		t.Fatalf("accounts.NewStaticCredentialRotator() error = %v", err)
	}
	deleter, err := accountapp.NewDeleter(store, usage)
	if err != nil {
		t.Fatalf("accounts.NewDeleter() error = %v", err)
	}
	authorizer, err := accountsapi.NewBearerAuthorizer(
		func() string { return smokeManagementKey },
	)
	if err != nil {
		t.Fatalf("accountsapi.NewBearerAuthorizer() error = %v", err)
	}
	targetURL, err := url.Parse(upstreamURL)
	if err != nil {
		t.Fatalf("url.Parse(upstream) error = %v", err)
	}
	oauthClient := &http.Client{
		Timeout: time.Second,
		Transport: &rewriteTransport{
			target: targetURL,
			base:   http.DefaultTransport,
		},
	}
	codexProvider, err := codexoauth.New(oauthClient, clock)
	if err != nil {
		t.Fatalf("codexoauth.New() error = %v", err)
	}
	claudeProvider, err := claudeoauth.New(oauthClient, clock)
	if err != nil {
		t.Fatalf("claudeoauth.New() error = %v", err)
	}
	decoder := nativeaccount.NewDecoder()
	jobs, err := accountauth.NewService(accountauth.Dependencies{
		Providers: []accountauth.OAuthProvider{
			codexProvider,
			claudeProvider,
		},
		Decoder:    decoder,
		Registrar:  registrar,
		Reauth:     reauthenticator,
		Clock:      clock,
		GenerateID: accountauth.NewRandomJobID,
	})
	if err != nil {
		t.Fatalf("accountauth.NewService() error = %v", err)
	}
	authHandler, err := accountauthapi.NewHandler(accountauthapi.Dependencies{
		Jobs:       jobs,
		Authorizer: authorizer,
	})
	if err != nil {
		t.Fatalf("accountauthapi.NewHandler() error = %v", err)
	}
	credentialFactory := accountsapi.NewBuiltinAPIKeyCredentialFactory()
	accountsHandler, err := accountsapi.NewHandler(accountsapi.Dependencies{
		Management:          management,
		Models:              modelManagement,
		Usage:               usage,
		Deletion:            deleter,
		Defaults:            providerDefaults,
		Selections:          launchAccountSelector,
		CredentialRotation:  credentialRotator,
		Sub2APIExporter:     exporter,
		CLIProxyAPIExporter: cliProxyAPIExporter,
		Registrar:           registrar,
		APIKeys:             credentialFactory,
		StaticCredentials:   credentialFactory,
		NativeAccounts:      decoder,
		Sub2APIAccounts:     sub2api.NewDecoder(),
		Authorizer:          authorizer,
	})
	if err != nil {
		t.Fatalf("accountsapi.NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle(accountauthapi.CollectionPath, authHandler)
	mux.Handle(accountauthapi.CollectionPath+"/", authHandler)
	mux.Handle(accountsapi.CollectionPath, accountsHandler)
	mux.Handle(accountsapi.CollectionPath+"/", accountsHandler)
	mux.Handle(accountsapi.DefaultsPath+"/", accountsHandler)
	return mux, store
}

// liveUsageManagementStub 满足账号 Handler 的额度端口；本 OAuth smoke 不访问额度子资源。
type liveUsageManagementStub struct{}

// GetUsage 明确表示合成 OAuth 账号尚无额度快照。
func (liveUsageManagementStub) GetUsage(
	context.Context,
	accountcore.AccountRef,
) (usageapp.ReadResult, error) {
	return usageapp.ReadResult{}, usageapp.ErrSnapshotNotFound
}

// RefreshUsage 明确表示合成 OAuth 账号尚无额度快照。
func (liveUsageManagementStub) RefreshUsage(
	context.Context,
	accountcore.AccountRef,
) (usageapp.ReadResult, error) {
	return usageapp.ReadResult{}, usageapp.ErrSnapshotNotFound
}

// ForgetAccount 在 OAuth smoke 中不保存额度或运行态派生数据。
func (liveUsageManagementStub) ForgetAccount(accountcore.AccountRef) {}

// rewriteTransport 把官方 OAuth 请求透明转发到本地 fake upstream。
type rewriteTransport struct {
	target *url.URL
	base   http.RoundTripper
}

// RoundTrip 保留官方请求 path/body，只替换测试网络目标。
func (transport *rewriteTransport) RoundTrip(
	request *http.Request,
) (*http.Response, error) {
	cloned := request.Clone(request.Context())
	cloned.URL.Scheme = transport.target.Scheme
	cloned.URL.Host = transport.target.Host
	cloned.Host = transport.target.Host
	return transport.base.RoundTrip(cloned)
}

// handleFakeOAuthUpstream 提供 Codex Token、Claude Token 和 Claude Profile 响应。
func handleFakeOAuthUpstream(
	t *testing.T,
	response http.ResponseWriter,
	request *http.Request,
) {
	t.Helper()

	switch request.URL.Path {
	case "/oauth/token":
		if err := request.ParseForm(); err != nil {
			t.Fatalf("Codex ParseForm() error = %v", err)
		}
		if request.Form.Get("code_verifier") == "" {
			t.Fatal("Codex token request 缺少 code 或 verifier")
		}
		handleFakeCodexToken(t, response, request.Form.Get("code"))
	case "/v1/oauth/token":
		var input struct {
			Code         string `json:"code"`
			CodeVerifier string `json:"code_verifier"`
			State        string `json:"state"`
		}
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil ||
			input.CodeVerifier == "" ||
			input.State == "" {
			t.Fatal("Claude token request 无效")
		}
		handleFakeClaudeToken(t, response, input.Code)
	case "/api/oauth/profile":
		handleFakeClaudeProfile(
			t,
			response,
			request.Header.Get("Authorization"),
		)
	default:
		http.NotFound(response, request)
	}
}

// handleFakeCodexToken 按授权码返回注册、同身份 reauth 或错误身份产物。
func handleFakeCodexToken(
	t *testing.T,
	response http.ResponseWriter,
	code string,
) {
	t.Helper()

	userID := "oauth-live-codex-user"
	accountID := "oauth-live-codex-workspace"
	email := "oauth-live-codex@example.invalid"
	plan := "team"
	accessToken := smokeCodexAccess
	refreshToken := smokeCodexRefresh
	switch code {
	case "codex-live-code":
	case "codex-reauth-code":
		email = "oauth-live-codex-reauth@example.invalid"
		plan = "pro"
		accessToken = smokeCodexReauth
		refreshToken = smokeCodexReauthRT
	case "codex-wrong-code":
		userID = "oauth-live-codex-other-user"
		accountID = "oauth-live-codex-other-workspace"
		email = "oauth-live-codex-other@example.invalid"
		accessToken = smokeCodexWrong
		refreshToken = smokeCodexWrongRT
	default:
		http.Error(response, "unknown synthetic code", http.StatusBadRequest)
		return
	}
	writeUpstreamJSON(t, response, map[string]any{
		"id_token": liveCodexJWT(
			t,
			userID,
			accountID,
			email,
			plan,
		),
		"access_token":  accessToken,
		"refresh_token": refreshToken,
	})
}

// handleFakeClaudeToken 返回注册或同身份 reauth 的新 Token。
func handleFakeClaudeToken(
	t *testing.T,
	response http.ResponseWriter,
	code string,
) {
	t.Helper()

	var accessToken, refreshToken string
	switch code {
	case "claude-live-code":
		accessToken = smokeClaudeAccess
		refreshToken = smokeClaudeRefresh
	case "claude-reauth-code":
		accessToken = smokeClaudeReauth
		refreshToken = smokeClaudeReauthRT
	default:
		http.Error(response, "unknown synthetic code", http.StatusBadRequest)
		return
	}
	writeUpstreamJSON(t, response, map[string]any{
		"access_token":  accessToken,
		"refresh_token": refreshToken,
		"expires_in":    3600,
		"scope":         "user:profile user:inference",
	})
}

// handleFakeClaudeProfile 按 Access Token 返回同 UUID 的最新公开资料。
func handleFakeClaudeProfile(
	t *testing.T,
	response http.ResponseWriter,
	authorization string,
) {
	t.Helper()

	email := "oauth-live-claude@example.invalid"
	displayName := "OAuth Live Claude"
	organizationType := "claude_max"
	rateLimitTier := "default_claude_max_20x"
	switch authorization {
	case "Bearer " + smokeClaudeAccess:
	case "Bearer " + smokeClaudeReauth:
		email = "oauth-live-claude-reauth@example.invalid"
		displayName = "OAuth Live Claude Reauth"
		organizationType = "claude_pro"
		rateLimitTier = ""
	default:
		http.Error(response, "unknown synthetic bearer", http.StatusUnauthorized)
		return
	}
	writeUpstreamJSON(t, response, map[string]any{
		"account": map[string]any{
			"uuid":         smokeClaudeAccountID,
			"email":        email,
			"display_name": displayName,
			"created_at":   "2025-01-02T03:04:05Z",
		},
		"organization": map[string]any{
			"uuid":                    "123e4567-e89b-12d3-a456-426614174556",
			"name":                    "OAuth Live Org",
			"organization_type":       organizationType,
			"rate_limit_tier":         rateLimitTier,
			"billing_type":            "stripe_subscription",
			"has_extra_usage_enabled": true,
			"subscription_created_at": "2025-02-03T04:05:06Z",
		},
	})
}

// liveClockStub 为注册和 reauth 提供可单调推进的持久化时间。
type liveClockStub struct {
	mu      sync.Mutex
	current time.Time
}

// newLiveClock 创建 smoke 的固定初始时钟。
func newLiveClock() *liveClockStub {
	return &liveClockStub{
		current: time.Date(2026, 7, 27, 15, 0, 0, 0, time.UTC),
	}
}

// now 返回当前 smoke 时间。
func (clock *liveClockStub) now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.current
}

// advance 单调推进 smoke 时间。
func (clock *liveClockStub) advance(duration time.Duration) {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	clock.current = clock.current.Add(duration)
}

// liveCodexJWT 创建 fake 官方 token endpoint 返回的合成 ID Token。
func liveCodexJWT(
	t *testing.T,
	userID string,
	accountID string,
	email string,
	plan string,
) string {
	t.Helper()

	header, err := json.Marshal(map[string]any{"alg": "none", "typ": "JWT"})
	if err != nil {
		t.Fatalf("json.Marshal(header) error = %v", err)
	}
	payload, err := json.Marshal(map[string]any{
		"sub":   userID,
		"email": email,
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": accountID,
			"chatgpt_plan_type":  plan,
		},
	})
	if err != nil {
		t.Fatalf("json.Marshal(payload) error = %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(header) + "." +
		base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}

// liveExchange 保存真实 HTTP 请求和响应证据。
type liveExchange struct {
	method          string
	url             string
	requestBody     string
	status          int
	responseHeaders http.Header
	responseBody    string
}

// performLiveRequest 使用真实 HTTP Client 调用本地 Listener。
func performLiveRequest(
	t *testing.T,
	client *http.Client,
	method string,
	requestURL string,
	body []byte,
) liveExchange {
	t.Helper()

	request, err := http.NewRequestWithContext(
		context.Background(),
		method,
		requestURL,
		bytes.NewReader(body),
	)
	if err != nil {
		t.Fatalf("http.NewRequestWithContext() error = %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+smokeManagementKey)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("%s %s error = %v", method, requestURL, err)
	}
	defer func() {
		_ = response.Body.Close()
	}()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("io.ReadAll() error = %v", err)
	}
	return liveExchange{
		method:          method,
		url:             requestURL,
		requestBody:     strings.TrimSpace(string(body)),
		status:          response.StatusCode,
		responseHeaders: response.Header.Clone(),
		responseBody:    strings.TrimSpace(string(responseBody)),
	}
}

// redactStartExchange 隐藏创建响应授权 URL 中的 state 和 challenge。
func redactStartExchange(
	t *testing.T,
	exchange liveExchange,
) liveExchange {
	t.Helper()

	var document map[string]any
	decodeLiveJSON(t, exchange.responseBody, &document)
	data, valid := document["data"].(map[string]any)
	if !valid {
		t.Fatal("OAuth Job 创建响应缺少 data")
	}
	rawURL, valid := data["authorization_url"].(string)
	if !valid {
		t.Fatal("OAuth Job 创建响应缺少 authorization_url")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("url.Parse(authorization_url) error = %v", err)
	}
	data["authorization_url"] = parsed.Scheme + "://" + parsed.Host +
		parsed.Path + "?<redacted>"
	redacted, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("json.Marshal(redacted) error = %v", err)
	}
	exchange.responseBody = string(redacted)
	return exchange
}

// logLiveExchange 输出用户可核对的地址、payload、status 和 response。
func logLiveExchange(t *testing.T, exchange liveExchange) {
	t.Helper()

	t.Logf(
		"%s %s\npayload: %s\nstatus: %d\nresponse: %s",
		exchange.method,
		exchange.url,
		exchange.requestBody,
		exchange.status,
		exchange.responseBody,
	)
}

// decodeLiveJSON 解码 smoke 响应。
func decodeLiveJSON(t *testing.T, document string, target any) {
	t.Helper()

	if err := json.Unmarshal([]byte(document), target); err != nil {
		t.Fatalf("json.Unmarshal(response) error = %v body=%s", err, document)
	}
}

// writeUpstreamJSON 写入 fake OAuth 上游 JSON 响应。
func writeUpstreamJSON(
	t *testing.T,
	response http.ResponseWriter,
	document any,
) {
	t.Helper()

	response.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(response).Encode(document); err != nil {
		t.Fatalf("json.Encode() error = %v", err)
	}
}
