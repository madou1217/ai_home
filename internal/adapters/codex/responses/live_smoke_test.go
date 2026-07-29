package responses

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/codexoauth"
	"github.com/madou1217/ai_home/internal/adapters/codex/authfile"
)

const (
	// realCodexAuthFileEnv 要求调用者明确选择只读官方凭据文件。
	realCodexAuthFileEnv = "AIH_REAL_CODEX_AUTH_FILE"
	// realCodexAuthStdinEnv 允许测试通过内存管道读取一次性官方凭据 JSON。
	realCodexAuthStdinEnv = "AIH_REAL_CODEX_AUTH_STDIN"
	// maxRealCodexAuthBytes 限制本地凭据文件读取量，避免误选异常文件。
	maxRealCodexAuthBytes = 1 << 20
	// realCodexSmokeModel 是未显式覆盖时使用的当前 Codex 实测模型。
	realCodexSmokeModel = "gpt-5.6-sol"
	// realCodexSmokeAlias 确保真实请求必须先经过 RouteCatalog。
	realCodexSmokeAlias = "aih-real-route-smoke"
	// realCodexSmokePrompt 是唯一允许发送给真实上游的固定低敏文本。
	realCodexSmokePrompt = "Reply with exactly: AIH_REAL_ROUTE_OK"
	// realCodexSmokeExpected 是真实响应必须返回的固定文本。
	realCodexSmokeExpected = "AIH_REAL_ROUTE_OK"
)

// TestLiveCodexRouteCatalogSmoke 使用当前用户的官方 Codex auth.json，
// 贯通 RouteCatalog、Coordinator、Recruiter 和真实 Responses 上游。
func TestLiveCodexRouteCatalogSmoke(t *testing.T) {
	if os.Getenv("AIH_REAL_CODEX_SMOKE") != "1" {
		t.Skip("设置 AIH_REAL_CODEX_SMOKE=1 后才允许真实上游请求")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	credential := loadRealCodexCredential(t)
	credential, status := refreshRealCodexCredential(
		t,
		ctx,
		credential,
	)
	model := os.Getenv("AIH_REAL_CODEX_MODEL")
	if model == "" {
		model = realCodexSmokeModel
	}
	coordinator, recorder, transport := newRealCodexCoordinator(
		t,
		credential,
		model,
	)
	request := newRealCodexRequest(t)
	events := make([]inference.StreamEvent, 0, 16)

	err := coordinator.Execute(
		ctx,
		request,
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("真实 Codex Execute() error = %v", err)
	}
	output := completedText(events)
	if recorder.successes != 1 ||
		len(recorder.failures) != 0 ||
		len(events) == 0 ||
		events[len(events)-1].Kind() != inference.EventResponseCompleted ||
		strings.TrimSpace(output) != realCodexSmokeExpected {
		responseCode, safeMessage, retryable :=
			realCodexResponseFailure(events)
		runtimeKind, retryAfter :=
			realCodexAttemptFailure(recorder.failures)
		wireFingerprint := transport.fingerprint()
		t.Fatalf(
			"真实 Codex 结果异常: http_status=%d media_type=%s success=%d failures=%d events=%v response_code=%s safe_message=%q retryable=%t runtime_kind=%s retry_after=%s wire=%v output=%q",
			transport.statusCode,
			transport.mediaType,
			recorder.successes,
			len(recorder.failures),
			eventKindsForAdapter(events),
			responseCode,
			safeMessage,
			retryable,
			runtimeKind,
			retryAfter,
			wireFingerprint,
			output,
		)
	}
	t.Logf(
		"real_codex_route_smoke model=%s auth=%s expires_at=%s refreshed=%t events=%v output=%q",
		model,
		credential.Kind().String(),
		formatRealCodexExpiry(status.expiresAt),
		status.refreshed,
		eventKindsForAdapter(events),
		output,
	)
}

// TestLiveCodexAuthPreflight 只验证显式凭据源及脱敏元数据，不访问网络。
func TestLiveCodexAuthPreflight(t *testing.T) {
	if !hasRealCodexAuthSource() {
		t.Skip("显式选择 Codex auth.json 文件或标准输入后才检查真实凭据")
	}

	credential := loadRealCodexCredential(t)
	status := inspectRealCodexCredential(credential, time.Now())
	t.Logf(
		"real_codex_auth_preflight auth=%s expires_at=%s refresh_due=%t",
		credential.Kind().String(),
		formatRealCodexExpiry(status.expiresAt),
		status.refreshDue,
	)
}

// loadRealCodexCredential 只读取并解码显式凭据源，不输出任何 Token。
func loadRealCodexCredential(t *testing.T) codexauth.Auth {
	t.Helper()

	authFile := os.Getenv(realCodexAuthFileEnv)
	useStdin := os.Getenv(realCodexAuthStdinEnv) == "1"
	if (authFile == "" && !useStdin) ||
		(authFile != "" && useStdin) {
		t.Fatalf(
			"%s 和 %s 必须且只能选择一个",
			realCodexAuthFileEnv,
			realCodexAuthStdinEnv,
		)
	}
	if useStdin {
		return decodeRealCodexCredential(t, os.Stdin)
	}
	file, err := os.Open(authFile)
	if err != nil {
		t.Fatalf("打开 Codex auth.json 失败: %v", err)
	}
	defer func() {
		_ = file.Close()
	}()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		t.Fatal("Codex auth.json 必须是普通文件")
	}
	return decodeRealCodexCredential(t, file)
}

// hasRealCodexAuthSource 判断调用者是否显式选择了唯一凭据输入。
func hasRealCodexAuthSource() bool {
	authFile := os.Getenv(realCodexAuthFileEnv)
	useStdin := os.Getenv(realCodexAuthStdinEnv) == "1"
	return (authFile != "" && !useStdin) ||
		(authFile == "" && useStdin)
}

// decodeRealCodexCredential 有界读取并严格解码官方 Codex auth.json。
func decodeRealCodexCredential(
	t *testing.T,
	reader io.Reader,
) codexauth.Auth {
	t.Helper()

	data, err := io.ReadAll(io.LimitReader(
		reader,
		maxRealCodexAuthBytes+1,
	))
	if err != nil {
		t.Fatalf("读取 Codex auth.json 失败: %v", err)
	}
	defer clear(data)
	if len(data) > maxRealCodexAuthBytes {
		t.Fatal("Codex auth.json 超过安全读取上限")
	}
	credential, err := authfile.Decode(data, authfile.DecodeOptions{})
	if err != nil {
		t.Fatalf("解码 Codex auth.json 失败: %v", err)
	}
	return credential
}

// TestDecodeRealCodexCredentialFromReader 验证内存管道与文件使用同一严格 Decoder。
func TestDecodeRealCodexCredentialFromReader(t *testing.T) {
	original := newTestOAuth(t, "workspace-reader", false)
	payload, err := authfile.Encode(original)
	if err != nil {
		t.Fatalf("authfile.Encode() error = %v", err)
	}
	defer clear(payload)

	decoded := decodeRealCodexCredential(t, bytes.NewReader(payload))
	if decoded.Kind() != original.Kind() ||
		decoded.IdentitySeed() != original.IdentitySeed() {
		t.Fatalf(
			"标准输入凭据身份不一致: kind=%s",
			decoded.Kind().String(),
		)
	}
}

// realCodexCredentialStatus 是不包含账号身份和 Token 的测试状态。
type realCodexCredentialStatus struct {
	expiresAt  time.Time
	refreshDue bool
	refreshed  bool
}

// inspectRealCodexCredential 判断 OAuth Access Token 是否进入刷新窗口。
func inspectRealCodexCredential(
	credential accountapp.Credential,
	now time.Time,
) realCodexCredentialStatus {
	auth, valid := credential.(*codexauth.OAuthAuth)
	if !valid || auth == nil || auth.AccessExpiresAtMS() <= 0 {
		return realCodexCredentialStatus{}
	}
	expiresAt := time.UnixMilli(auth.AccessExpiresAtMS()).UTC()
	return realCodexCredentialStatus{
		expiresAt: expiresAt,
		refreshDue: expiresAt.Sub(now) <=
			accountcredentials.DefaultRefreshSkew,
	}
}

// refreshRealCodexCredential 在需要时调用官方刷新协议，结果只保留在内存。
func refreshRealCodexCredential(
	t *testing.T,
	ctx context.Context,
	credential codexauth.Auth,
) (codexauth.Auth, realCodexCredentialStatus) {
	t.Helper()

	status := inspectRealCodexCredential(credential, time.Now())
	if !status.refreshDue {
		return credential, status
	}
	provider, err := codexoauth.New(newRealCodexHTTPClient(), time.Now)
	if err != nil {
		t.Fatalf("codexoauth.New() error = %v", err)
	}
	refreshed, err := provider.Refresh(ctx, credential, time.Now().UTC())
	if err != nil {
		t.Fatalf("真实 Codex OAuth 刷新失败: %v", err)
	}
	auth, valid := refreshed.(codexauth.Auth)
	if !valid {
		t.Fatal("真实 Codex OAuth 刷新返回了非 Codex 凭据")
	}
	status = inspectRealCodexCredential(auth, time.Now())
	status.refreshed = true
	if status.refreshDue {
		t.Fatal("真实 Codex OAuth 刷新后 Access Token 仍不可用")
	}
	return auth, status
}

// formatRealCodexExpiry 返回不含身份信息的 UTC 过期时间。
func formatRealCodexExpiry(value time.Time) string {
	if value.IsZero() {
		return "unknown"
	}
	return value.UTC().Format(time.RFC3339)
}

// newRealCodexCoordinator 装配真实凭据但不持久化 Token 或响应。
func newRealCodexCoordinator(
	t *testing.T,
	credential accountapp.Credential,
	model string,
) (
	*inferencegateway.Coordinator,
	*adapterAttemptRecorder,
	*realCodexTransportDiagnostic,
) {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("accounts.DeriveAccountRef() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("accounts.NewCLIAccountID() error = %v", err)
	}
	account, err := accountapp.NewRoutingAccount(
		catalog,
		accountapp.RoutingAccountInput{
			Ref:          accountRef,
			ProviderID:   "codex",
			CLIAccountID: alias,
		},
	)
	if err != nil {
		t.Fatalf("accounts.NewRoutingAccount() error = %v", err)
	}
	recruiter, err := accountrouting.NewRecruiter(
		accountrouting.Dependencies{
			Candidates: adapterCandidateSource{account: account},
			Runtime:    adapterAvailableRuntime{},
			Credentials: adapterCredentialResolver{
				accountRef: accountRef,
				credential: credential,
			},
		},
	)
	if err != nil {
		t.Fatalf("accountrouting.NewRecruiter() error = %v", err)
	}
	resolver := newRealCodexRouteCatalog(t, model)
	transport := &realCodexTransportDiagnostic{
		client:    newRealCodexHTTPClient(),
		mediaType: "not_observed",
	}
	adapter, err := NewAdapter(transport, time.Now)
	if err != nil {
		t.Fatalf("responses.NewAdapter() error = %v", err)
	}
	upstreams, err := inferencegateway.NewUpstreamRegistry(adapter)
	if err != nil {
		t.Fatalf("NewUpstreamRegistry() error = %v", err)
	}
	recorder := &adapterAttemptRecorder{}
	coordinator, err := inferencegateway.NewCoordinator(
		inferencegateway.Dependencies{
			Catalog:   catalog,
			Routes:    resolver,
			Recruiter: recruiter,
			Upstreams: upstreams,
			Attempts:  recorder,
		},
	)
	if err != nil {
		t.Fatalf("NewCoordinator() error = %v", err)
	}
	return coordinator, recorder, transport
}

// newRealCodexRouteCatalog 创建 alias 到真实 Codex 模型的唯一规则。
func newRealCodexRouteCatalog(
	t *testing.T,
	model string,
) *inferencegateway.RouteCatalog {
	t.Helper()

	capabilities, err := inference.NewCapabilitySet(
		inference.CapabilityTextGeneration,
		inference.CapabilityStreaming,
	)
	if err != nil {
		t.Fatalf("inference.NewCapabilitySet() error = %v", err)
	}
	route, err := inferencegateway.NewRoute(
		inference.ProviderCodex,
		inference.ProtocolCodexResponses,
		model,
		capabilities,
	)
	if err != nil {
		t.Fatalf("inferencegateway.NewRoute() error = %v", err)
	}
	rule, err := inferencegateway.NewRouteRule(
		inferencegateway.RouteRuleInput{
			Pattern:  realCodexSmokeAlias,
			Scope:    inferencegateway.RouteScopeCodex,
			Route:    route,
			Priority: 0,
		},
	)
	if err != nil {
		t.Fatalf("inferencegateway.NewRouteRule() error = %v", err)
	}
	resolver, err := inferencegateway.NewRouteCatalog(rule)
	if err != nil {
		t.Fatalf("inferencegateway.NewRouteCatalog() error = %v", err)
	}
	return resolver
}

// newRealCodexRequest 创建固定低敏文本的流式 Canonical 请求。
func newRealCodexRequest(t *testing.T) inference.Request {
	t.Helper()

	text, err := inference.NewTextContent(realCodexSmokePrompt)
	if err != nil {
		t.Fatalf("inference.NewTextContent() error = %v", err)
	}
	message, err := inference.NewMessage(inference.RoleUser, text)
	if err != nil {
		t.Fatalf("inference.NewMessage() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolOpenAIResponses,
		Model:          realCodexSmokeAlias,
		Messages:       []inference.Message{message},
		Stream:         true,
	})
	if err != nil {
		t.Fatalf("inference.NewRequest() error = %v", err)
	}
	return request
}

// newRealCodexHTTPClient 禁止跨主机重定向并限制真实请求时长。
func newRealCodexHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 60 * time.Second,
		CheckRedirect: func(
			_ *http.Request,
			_ []*http.Request,
		) error {
			return http.ErrUseLastResponse
		},
	}
}

// completedText 返回最后一个普通文本完成事件。
func completedText(events []inference.StreamEvent) string {
	var output string
	for _, event := range events {
		completed, ok := event.(inference.TextCompletedEvent)
		if ok {
			output = completed.Text()
		}
	}
	return output
}
