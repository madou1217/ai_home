package messages

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/claude/nativeauth"
)

const (
	// realClaudeAPIKeyFileEnv 显式选择只含 API Key 的普通文件。
	realClaudeAPIKeyFileEnv = "AIH_REAL_CLAUDE_API_KEY_FILE"
	// realClaudeAPIBaseURLEnv 可覆盖 API Key 账号绑定的兼容端点。
	realClaudeAPIBaseURLEnv = "AIH_REAL_CLAUDE_API_BASE_URL"
	// realClaudeCredentialsEnv 显式选择官方 secure storage 文件。
	realClaudeCredentialsEnv = "AIH_REAL_CLAUDE_CREDENTIALS_FILE"
	// realClaudeConfigEnv 显式选择包含 oauthAccount 的官方全局配置。
	realClaudeConfigEnv = "AIH_REAL_CLAUDE_CONFIG_FILE"
	// maxRealClaudeArtifactBytes 限制每个本地 artifact 的读取量。
	maxRealClaudeArtifactBytes = 1 << 20
	// realClaudeSmokeModel 是未显式覆盖时使用的真实验收模型。
	realClaudeSmokeModel = "claude-opus-5"
	// realClaudeSmokeAlias 确保真实请求必须先经过 RouteCatalog。
	realClaudeSmokeAlias = "aih-real-claude-route-smoke"
	// realClaudeSmokePrompt 是唯一允许发送给真实上游的固定低敏文本。
	realClaudeSmokePrompt = "Reply with exactly: AIH_REAL_CLAUDE_OK"
	// realClaudeSmokeExpected 是真实响应必须返回的固定文本。
	realClaudeSmokeExpected = "AIH_REAL_CLAUDE_OK"
)

// TestLiveClaudeRouteCatalogSmoke 使用显式选择的 Claude API Key，
// 贯通 RouteCatalog、Coordinator、Recruiter 和真实 Messages API。
//
// 订阅 OAuth 不允许进入本测试；它必须由原生 Claude Relay 单独验收。
func TestLiveClaudeRouteCatalogSmoke(t *testing.T) {
	if os.Getenv("AIH_REAL_CLAUDE_SMOKE") != "1" {
		t.Skip("设置 AIH_REAL_CLAUDE_SMOKE=1 后才允许真实上游请求")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	credential := loadRealClaudeAPIKeyCredential(t)
	model := os.Getenv("AIH_REAL_CLAUDE_MODEL")
	if model == "" {
		model = realClaudeSmokeModel
	}
	coordinator, recorder, transport := newRealClaudeCoordinator(
		t,
		credential,
		model,
	)
	events := make([]inference.StreamEvent, 0, 16)

	err := coordinator.Execute(
		ctx,
		newRealClaudeRequest(t),
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("真实 Claude Execute() error = %v", err)
	}
	output := completedClaudeText(events)
	if recorder.successes != 1 ||
		len(recorder.failures) != 0 ||
		len(events) == 0 ||
		events[len(events)-1].Kind() != inference.EventResponseCompleted ||
		strings.TrimSpace(output) != realClaudeSmokeExpected {
		runtimeKind := "none"
		retryAfter := time.Duration(0)
		if len(recorder.failures) > 0 {
			runtimeKind = string(recorder.failures[0].RuntimeKind())
			retryAfter = recorder.failures[0].RetryAfter()
		}
		t.Fatalf(
			"真实 Claude 结果异常: method=%s endpoint=%s http_status=%d media_type=%s successes=%d failures=%d runtime_kind=%s retry_after=%s events=%s output=%q",
			transport.method,
			transport.endpoint,
			transport.statusCode,
			transport.mediaType,
			recorder.successes,
			len(recorder.failures),
			runtimeKind,
			retryAfter,
			eventKinds(events),
			output,
		)
	}
	t.Logf(
		"real_claude_route_smoke method=%s endpoint=%s model=%s max_tokens=64 stream=true http_status=%d media_type=%s auth=api_key events=%s output=%q",
		transport.method,
		transport.endpoint,
		model,
		transport.statusCode,
		transport.mediaType,
		eventKinds(events),
		output,
	)
}

// TestLiveClaudeAuthPreflight 只验证显式 artifact 和脱敏元数据，不访问网络。
func TestLiveClaudeAuthPreflight(t *testing.T) {
	if !hasRealClaudeArtifacts() {
		t.Skip("显式选择 Claude credentials 和 global config 后才检查真实凭据")
	}

	credential := loadRealClaudeCredential(t)
	t.Logf(
		"real_claude_auth_preflight auth=%s expires_at=%s refresh_due=%t",
		credential.Kind().String(),
		time.UnixMilli(credential.ExpiresAtMS()).
			UTC().
			Format(time.RFC3339),
		time.Until(
			time.UnixMilli(credential.ExpiresAtMS()),
		) <= 5*time.Minute,
	)
}

// TestCanonicalizeRealClaudeCredentialsDropsRuntimeExtensions 验证真实测试
// 投影不会把旧运行时的 snake_case 镜像带入生产 strict Decoder。
func TestCanonicalizeRealClaudeCredentialsDropsRuntimeExtensions(
	t *testing.T,
) {
	t.Parallel()

	canonical, err := canonicalizeRealClaudeCredentials([]byte(`{
		"claudeAiOauth":{
			"accessToken":"synthetic-access",
			"refreshToken":"synthetic-refresh",
			"expiresAt":4102444800000,
			"scopes":["user:inference"],
			"subscriptionType":null,
			"rateLimitTier":null,
			"access_token":"must-be-dropped",
			"account":{"uuid":"must-be-dropped"}
		}
	}`))
	if err != nil {
		t.Fatalf("canonicalizeRealClaudeCredentials() error = %v", err)
	}
	if strings.Contains(string(canonical), "access_token") ||
		strings.Contains(string(canonical), "account") ||
		!strings.Contains(string(canonical), "accessToken") {
		t.Fatalf("canonical projection contains unexpected fields")
	}
}

// loadRealClaudeAPIKeyCredential 从显式文件创建只用于真实 smoke 的凭据。
func loadRealClaudeAPIKeyCredential(t *testing.T) *claudeauth.APIKeyAuth {
	t.Helper()

	path := os.Getenv(realClaudeAPIKeyFileEnv)
	if path == "" {
		t.Fatalf("%s 必须指定", realClaudeAPIKeyFileEnv)
	}
	data := readRealClaudeArtifact(t, path)
	defer clear(data)
	apiKey := strings.TrimRight(string(data), "\r\n")
	if apiKey == "" || strings.TrimSpace(apiKey) != apiKey {
		t.Fatal("Claude API Key 文件格式无效")
	}
	credential, err := claudeauth.NewAPIKeyAuth(claudeauth.APIKeyInput{
		APIKey:  apiKey,
		BaseURL: os.Getenv(realClaudeAPIBaseURLEnv),
	})
	if err != nil {
		t.Fatalf("创建 Claude API Key 凭据失败: %v", err)
	}
	return credential
}

// loadRealClaudeCredential 严格组合显式选择的两个官方 artifact。
func loadRealClaudeCredential(t *testing.T) *claudeauth.OAuthAuth {
	t.Helper()

	if !hasRealClaudeArtifacts() {
		t.Fatalf(
			"%s 和 %s 必须同时指定",
			realClaudeCredentialsEnv,
			realClaudeConfigEnv,
		)
	}
	rawCredentials := readRealClaudeArtifact(
		t,
		os.Getenv(realClaudeCredentialsEnv),
	)
	defer clear(rawCredentials)
	credentials, err := canonicalizeRealClaudeCredentials(rawCredentials)
	if err != nil {
		t.Fatalf("规范化 Claude 测试凭据失败: %v", err)
	}
	defer clear(credentials)
	config := readRealClaudeArtifact(
		t,
		os.Getenv(realClaudeConfigEnv),
	)
	defer clear(config)
	decoded, err := nativeauth.DecodeOAuth(credentials, config)
	if err != nil {
		t.Fatalf("解码 Claude 官方 artifact 失败: %v", err)
	}
	return decoded.Auth
}

// realClaudeOAuthProjection 只声明官方 secure storage 的 Canonical 字段。
//
// 当前旧运行时可能在同一文件追加 snake_case 镜像和账号扩展；真实测试只在内存中
// 投影官方字段，再交给生产 strict Decoder，不把历史字段兼容带入 Adapter。
type realClaudeOAuthProjection struct {
	AccessToken           json.RawMessage `json:"accessToken"`
	RefreshToken          json.RawMessage `json:"refreshToken"`
	ExpiresAt             json.RawMessage `json:"expiresAt"`
	RefreshTokenExpiresAt json.RawMessage `json:"refreshTokenExpiresAt,omitempty"`
	ClientID              json.RawMessage `json:"clientId,omitempty"`
	Scopes                json.RawMessage `json:"scopes"`
	SubscriptionType      json.RawMessage `json:"subscriptionType"`
	RateLimitTier         json.RawMessage `json:"rateLimitTier"`
}

// canonicalizeRealClaudeCredentials 丢弃测试源中的非官方附加字段。
func canonicalizeRealClaudeCredentials(data []byte) ([]byte, error) {
	var envelope struct {
		OAuth json.RawMessage `json:"claudeAiOauth"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil ||
		len(envelope.OAuth) == 0 {
		return nil, ErrInvalidInvocation
	}
	var oauth realClaudeOAuthProjection
	if err := json.Unmarshal(envelope.OAuth, &oauth); err != nil {
		return nil, ErrInvalidInvocation
	}
	canonical, err := json.Marshal(struct {
		OAuth realClaudeOAuthProjection `json:"claudeAiOauth"`
	}{OAuth: oauth})
	if err != nil {
		return nil, ErrInvalidInvocation
	}
	return canonical, nil
}

// hasRealClaudeArtifacts 判断调用者是否显式选择了完整凭据来源。
func hasRealClaudeArtifacts() bool {
	return os.Getenv(realClaudeCredentialsEnv) != "" &&
		os.Getenv(realClaudeConfigEnv) != ""
}

// readRealClaudeArtifact 有界读取单个普通文件。
func readRealClaudeArtifact(t *testing.T, path string) []byte {
	t.Helper()

	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("打开 Claude artifact 失败: %v", err)
	}
	defer func() {
		_ = file.Close()
	}()
	info, err := file.Stat()
	if err != nil ||
		!info.Mode().IsRegular() ||
		info.Size() <= 0 ||
		info.Size() > maxRealClaudeArtifactBytes {
		t.Fatal("Claude artifact 必须是安全上限内的普通文件")
	}
	data, err := io.ReadAll(io.LimitReader(
		file,
		maxRealClaudeArtifactBytes+1,
	))
	if err != nil || len(data) > maxRealClaudeArtifactBytes {
		clear(data)
		t.Fatal("读取 Claude artifact 失败或超过安全上限")
	}
	return data
}

// newRealClaudeCoordinator 装配真实凭据但不持久化 Token 或响应。
func newRealClaudeCoordinator(
	t *testing.T,
	credential accountapp.Credential,
	model string,
) (
	*inferencegateway.Coordinator,
	*claudeAttemptRecorder,
	*realClaudeTransportDiagnostic,
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
			ProviderID:   "claude",
			CLIAccountID: alias,
		},
	)
	if err != nil {
		t.Fatalf("accounts.NewRoutingAccount() error = %v", err)
	}
	recruiter, err := accountrouting.NewRecruiter(
		accountrouting.Dependencies{
			Candidates: claudeCandidateSource{account: account},
			Runtime:    claudeAvailableRuntime{},
			Credentials: claudeCredentialResolver{
				accountRef: accountRef,
				credential: credential,
			},
		},
	)
	if err != nil {
		t.Fatalf("accountrouting.NewRecruiter() error = %v", err)
	}
	transport := &realClaudeTransportDiagnostic{
		client: newRealClaudeHTTPClient(),
	}
	adapter, err := NewAdapter(transport, time.Now)
	if err != nil {
		t.Fatalf("messages.NewAdapter() error = %v", err)
	}
	upstreams, err := inferencegateway.NewUpstreamRegistry(adapter)
	if err != nil {
		t.Fatalf("NewUpstreamRegistry() error = %v", err)
	}
	recorder := &claudeAttemptRecorder{}
	coordinator, err := inferencegateway.NewCoordinator(
		inferencegateway.Dependencies{
			Catalog:   catalog,
			Routes:    newRealClaudeRouteCatalog(t, model),
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

// newRealClaudeRouteCatalog 创建 alias 到真实 Claude 模型的唯一规则。
func newRealClaudeRouteCatalog(
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
		inference.ProviderClaude,
		inference.ProtocolClaudeMessages,
		model,
		capabilities,
	)
	if err != nil {
		t.Fatalf("inferencegateway.NewRoute() error = %v", err)
	}
	rule, err := inferencegateway.NewRouteRule(
		inferencegateway.RouteRuleInput{
			Pattern:  realClaudeSmokeAlias,
			Scope:    inferencegateway.RouteScopeAll,
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

// newRealClaudeRequest 创建固定低敏文本的流式 Canonical 请求。
func newRealClaudeRequest(t *testing.T) inference.Request {
	t.Helper()

	message := mustMessage(
		t,
		inference.RoleUser,
		mustText(t, realClaudeSmokePrompt),
	)
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol:  inference.ClientProtocolOpenAIResponses,
		Model:           realClaudeSmokeAlias,
		Messages:        []inference.Message{message},
		Stream:          true,
		MaxOutputTokens: 64,
	})
	if err != nil {
		t.Fatalf("inference.NewRequest() error = %v", err)
	}
	return request
}

// newRealClaudeHTTPClient 禁止重定向并限制真实请求总时长。
func newRealClaudeHTTPClient() *http.Client {
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

// realClaudeTransportDiagnostic 只记录不含 Header、Token 和正文的传输摘要。
type realClaudeTransportDiagnostic struct {
	client     *http.Client
	method     string
	endpoint   string
	statusCode int
	mediaType  string
}

// Do 透传真实请求并保存低敏 HTTP 结果。
func (transport *realClaudeTransportDiagnostic) Do(
	request *http.Request,
) (*http.Response, error) {
	transport.method = request.Method
	transport.endpoint = request.URL.String()
	response, err := transport.client.Do(request)
	if response != nil {
		transport.statusCode = response.StatusCode
		transport.mediaType = response.Header.Get("Content-Type")
	}
	return response, err
}
