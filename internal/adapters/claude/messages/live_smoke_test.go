package messages

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strconv"
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
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/openairesponses"
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
	// realClaudeOAuthSmokeEnv 显式授权一次官方 OAuth 真实诊断请求。
	realClaudeOAuthSmokeEnv = "AIH_REAL_CLAUDE_OAUTH_SMOKE"
	// realClaudeReasoningSmokeEnv 显式授权两轮 reasoning 连续性真实请求。
	realClaudeReasoningSmokeEnv = "AIH_REAL_CLAUDE_REASONING_SMOKE"
	// realClaudeRedactedThinkingSmokeEnv 显式授权一次 redacted thinking 请求。
	realClaudeRedactedThinkingSmokeEnv = "AIH_REAL_CLAUDE_REDACTED_THINKING_SMOKE"
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
	// realClaudeReasoningModel 是账号模型目录中用于 reasoning 验收的当前模型。
	realClaudeReasoningModel = "claude-sonnet-5"
	// realClaudeReasoningPrompt 触发最小 reasoning，同时约束公开回答。
	realClaudeReasoningPrompt = "Compute 17 * 19, then reply with exactly: AIH_REAL_CLAUDE_REASONING_OK"
	// realClaudeReasoningExpected 是第一轮公开回答的固定值。
	realClaudeReasoningExpected = "AIH_REAL_CLAUDE_REASONING_OK"
	// realClaudeReplayPrompt 要求第二轮只返回固定连续性验收值。
	realClaudeReplayPrompt = "Reply with exactly: AIH_REAL_CLAUDE_REPLAY_OK"
	// realClaudeReplayExpected 是第二轮公开回答的固定值。
	realClaudeReplayExpected = "AIH_REAL_CLAUDE_REPLAY_OK"
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

// TestLiveClaudeOAuthRouteCatalogDiagnostic 使用显式官方 artifact 发起一次
// OAuth Messages 请求，并在失败时只报告低敏协议指纹。
func TestLiveClaudeOAuthRouteCatalogDiagnostic(t *testing.T) {
	if os.Getenv(realClaudeOAuthSmokeEnv) != "1" {
		t.Skip("设置 AIH_REAL_CLAUDE_OAUTH_SMOKE=1 后才允许真实 OAuth 请求")
	}

	credential := loadRealClaudeCredential(t)
	expiresAt := time.UnixMilli(credential.ExpiresAtMS())
	if !expiresAt.After(time.Now().Add(time.Minute)) {
		t.Fatalf(
			"Claude OAuth artifact 已过期或即将过期: expires_at=%s",
			expiresAt.UTC().Format(time.RFC3339),
		)
	}
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
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	executeErr := coordinator.Execute(
		ctx,
		newRealClaudeRequest(t),
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	fingerprint := strings.Join(transport.fingerprint(), "|")
	output := completedClaudeText(events)
	runtimeKind := "none"
	retryAfter := time.Duration(0)
	if len(recorder.failures) > 0 {
		runtimeKind = string(recorder.failures[len(recorder.failures)-1].RuntimeKind())
		retryAfter = recorder.failures[len(recorder.failures)-1].RetryAfter()
	}
	t.Logf(
		"real_claude_oauth_diagnostic method=%s endpoint=%s model=%s max_tokens=64 stream=true http_status=%d media_type=%s successes=%d failures=%d runtime_kind=%s retry_after=%s events=%s fingerprint=%s output_match=%t",
		transport.method,
		transport.endpoint,
		model,
		transport.statusCode,
		transport.mediaType,
		recorder.successes,
		len(recorder.failures),
		runtimeKind,
		retryAfter,
		eventKinds(events),
		fingerprint,
		strings.TrimSpace(output) == realClaudeSmokeExpected,
	)
	if executeErr != nil {
		t.Fatalf("真实 Claude OAuth Execute() error = %v", executeErr)
	}
	if recorder.successes != 1 ||
		len(recorder.failures) != 0 ||
		len(events) == 0 ||
		events[len(events)-1].Kind() != inference.EventResponseCompleted ||
		strings.TrimSpace(output) != realClaudeSmokeExpected {
		t.Fatal("真实 Claude OAuth 结果未满足成功合同，详见低敏诊断日志")
	}
}

// TestLiveClaudeReasoningContinuitySmoke 使用官方 OAuth artifact 做两轮受控请求：
// 第一轮验证 thinking/signature，第二轮验证 Responses 历史可回放到 Claude。
func TestLiveClaudeReasoningContinuitySmoke(t *testing.T) {
	if os.Getenv(realClaudeReasoningSmokeEnv) != "1" {
		t.Skip("设置 AIH_REAL_CLAUDE_REASONING_SMOKE=1 后才允许真实 reasoning 请求")
	}

	credential := loadRealClaudeCredential(t)
	expiresAt := time.UnixMilli(credential.ExpiresAtMS())
	if !expiresAt.After(time.Now().Add(time.Minute)) {
		t.Fatalf(
			"Claude OAuth artifact 已过期或即将过期: expires_at=%s",
			expiresAt.UTC().Format(time.RFC3339),
		)
	}
	model := os.Getenv("AIH_REAL_CLAUDE_MODEL")
	if model == "" {
		model = realClaudeReasoningModel
	}

	firstRequest := newRealClaudeReasoningRequest(t)
	firstEvents, firstRecorder, firstTransport, firstErr := executeRealClaudeRequest(
		t,
		credential,
		model,
		firstRequest,
	)
	firstFingerprint := strings.Join(firstTransport.fingerprint(), "|")
	firstOutputMatch := strings.TrimSpace(completedClaudeText(firstEvents)) ==
		realClaudeReasoningExpected
	if firstErr != nil ||
		firstRecorder.successes != 1 ||
		len(firstRecorder.failures) != 0 ||
		!hasReasoningDelta(firstEvents, inference.ReasoningDeltaThinking) ||
		!hasReasoningDelta(firstEvents, inference.ReasoningDeltaSignature) ||
		!hasCompletedThinking(firstEvents) ||
		!firstOutputMatch {
		t.Logf(
			"real_claude_reasoning_first method=%s endpoint=%s model=%s max_tokens=512 stream=true http_status=%d media_type=%s successes=%d failures=%d reasoning_deltas=%s events=%s fingerprint=%s output_match=%t",
			firstTransport.method,
			firstTransport.endpoint,
			model,
			firstTransport.statusCode,
			firstTransport.mediaType,
			firstRecorder.successes,
			len(firstRecorder.failures),
			reasoningDeltaKinds(firstEvents),
			eventKinds(firstEvents),
			firstFingerprint,
			firstOutputMatch,
		)
		if firstErr != nil {
			t.Fatalf("真实 Claude reasoning 第一轮失败: %v", firstErr)
		}
		t.Fatal("真实 Claude reasoning 第一轮未满足 thinking/signature 合同")
	}

	firstResponse := aggregateRealClaudeResponses(t, firstRequest, firstEvents)
	defer clear(firstResponse)
	replayRequest := decodeRealClaudeReplayRequest(t, firstResponse)
	secondEvents, secondRecorder, secondTransport, secondErr := executeRealClaudeRequest(
		t,
		credential,
		model,
		replayRequest,
	)
	secondFingerprint := strings.Join(secondTransport.fingerprint(), "|")
	secondOutputMatch := strings.TrimSpace(completedClaudeText(secondEvents)) ==
		realClaudeReplayExpected
	if secondErr != nil ||
		secondRecorder.successes != 1 ||
		len(secondRecorder.failures) != 0 ||
		!secondOutputMatch {
		t.Logf(
			"real_claude_reasoning_replay method=%s endpoint=%s model=%s max_tokens=512 stream=false http_status=%d media_type=%s successes=%d failures=%d reasoning_deltas=%s events=%s fingerprint=%s output_match=%t",
			secondTransport.method,
			secondTransport.endpoint,
			model,
			secondTransport.statusCode,
			secondTransport.mediaType,
			secondRecorder.successes,
			len(secondRecorder.failures),
			reasoningDeltaKinds(secondEvents),
			eventKinds(secondEvents),
			secondFingerprint,
			secondOutputMatch,
		)
		if secondErr != nil {
			t.Fatalf("真实 Claude reasoning 回放失败: %v", secondErr)
		}
		t.Fatal("真实 Claude reasoning 回放未满足成功合同")
	}

	secondResponse := aggregateRealClaudeResponses(t, replayRequest, secondEvents)
	defer clear(secondResponse)
	if bytes.Contains(secondResponse, []byte(`"encrypted_content"`)) {
		t.Fatal("未声明 include 的非流式 Responses 响应泄漏 encrypted_content")
	}
	t.Logf(
		"real_claude_reasoning_continuity endpoint=%s model=%s first_http_status=%d first_stream=true first_reasoning_deltas=%s first_usage=%s first_output_match=%t replay_http_status=%d replay_stream=false replay_reasoning_deltas=%s replay_usage=%s replay_output_match=%t replay_encrypted_content_omitted=true",
		firstTransport.endpoint,
		model,
		firstTransport.statusCode,
		reasoningDeltaKinds(firstEvents),
		usageEventShape(firstEvents),
		firstOutputMatch,
		secondTransport.statusCode,
		reasoningDeltaKinds(secondEvents),
		usageEventShape(secondEvents),
		secondOutputMatch,
	)
}

// TestLiveClaudeRedactedThinkingSmoke 使用官方 OAuth artifact 发起一次
// omitted thinking 请求，验证真实上游返回独立 redacted_thinking 块。
func TestLiveClaudeRedactedThinkingSmoke(t *testing.T) {
	if os.Getenv(realClaudeRedactedThinkingSmokeEnv) != "1" {
		t.Skip("设置 AIH_REAL_CLAUDE_REDACTED_THINKING_SMOKE=1 后才允许真实请求")
	}

	credential := loadRealClaudeCredential(t)
	expiresAt := time.UnixMilli(credential.ExpiresAtMS())
	if !expiresAt.After(time.Now().Add(time.Minute)) {
		t.Fatalf(
			"Claude OAuth artifact 已过期或即将过期: expires_at=%s",
			expiresAt.UTC().Format(time.RFC3339),
		)
	}
	model := os.Getenv("AIH_REAL_CLAUDE_MODEL")
	if model == "" {
		model = realClaudeReasoningModel
	}

	events, recorder, transport, executeErr := executeRealClaudeRequest(
		t,
		credential,
		model,
		newRealClaudeRedactedThinkingRequest(t),
	)
	fingerprint := strings.Join(transport.fingerprint(), "|")
	outputMatch := strings.TrimSpace(completedClaudeText(events)) ==
		realClaudeReasoningExpected
	redacted := hasCompletedRedactedThinking(events)
	t.Logf(
		"real_claude_redacted_thinking method=%s endpoint=%s model=%s max_tokens=512 stream=true http_status=%d media_type=%s successes=%d failures=%d redacted_completed=%t events=%s fingerprint=%s output_match=%t",
		transport.method,
		transport.endpoint,
		model,
		transport.statusCode,
		transport.mediaType,
		recorder.successes,
		len(recorder.failures),
		redacted,
		eventKinds(events),
		fingerprint,
		outputMatch,
	)
	if executeErr != nil {
		t.Fatalf("真实 Claude redacted thinking 请求失败: %v", executeErr)
	}
	if recorder.successes != 1 ||
		len(recorder.failures) != 0 ||
		!redacted ||
		!outputMatch {
		t.Fatal("真实 Claude redacted thinking 未满足成功合同")
	}
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
			Catalog:        catalog,
			Routes:         newRealClaudeRouteCatalog(t, model),
			Recruiter:      recruiter,
			Upstreams:      upstreams,
			Attempts:       recorder,
			ModelRefreshes: claudeModelRefreshScheduler{},
			// 真实 smoke 每次只允许调用一个账号，禁止测试代码自动重试。
			UpstreamAttemptLimit: 1,
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
		inference.CapabilityReasoning,
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

// newRealClaudeReasoningRequest 创建 Responses effort 驱动的流式 reasoning 请求。
func newRealClaudeReasoningRequest(t *testing.T) inference.Request {
	t.Helper()

	reasoning, err := inference.NewEffortReasoning(
		inference.ReasoningEffortLow,
		inference.ReasoningSummaryAuto,
	)
	if err != nil {
		t.Fatalf("inference.NewEffortReasoning() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolOpenAIResponses,
		Model:          realClaudeSmokeAlias,
		Messages: []inference.Message{mustMessage(
			t,
			inference.RoleUser,
			mustText(t, realClaudeReasoningPrompt),
		)},
		Reasoning:                 &reasoning,
		Stream:                    true,
		IncludeEncryptedReasoning: true,
		MaxOutputTokens:           512,
	})
	if err != nil {
		t.Fatalf("inference.NewRequest() error = %v", err)
	}
	return request
}

// newRealClaudeRedactedThinkingRequest 创建明确要求 omitted thinking 的请求。
func newRealClaudeRedactedThinkingRequest(t *testing.T) inference.Request {
	t.Helper()

	reasoning, err := inference.NewEffortReasoning(
		inference.ReasoningEffortLow,
		inference.ReasoningSummaryNone,
	)
	if err != nil {
		t.Fatalf("inference.NewEffortReasoning() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolAnthropicMessages,
		Model:          realClaudeSmokeAlias,
		Messages: []inference.Message{mustMessage(
			t,
			inference.RoleUser,
			mustText(t, realClaudeReasoningPrompt),
		)},
		Reasoning:       &reasoning,
		Stream:          true,
		MaxOutputTokens: 512,
	})
	if err != nil {
		t.Fatalf("inference.NewRequest() error = %v", err)
	}
	return request
}

// executeRealClaudeRequest 通过同一生产 Coordinator 执行一次真实请求。
func executeRealClaudeRequest(
	t *testing.T,
	credential accountapp.Credential,
	model string,
	request inference.Request,
) (
	[]inference.StreamEvent,
	*claudeAttemptRecorder,
	*realClaudeTransportDiagnostic,
	error,
) {
	t.Helper()

	coordinator, recorder, transport := newRealClaudeCoordinator(
		t,
		credential,
		model,
	)
	events := make([]inference.StreamEvent, 0, 32)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	err := coordinator.Execute(
		ctx,
		request,
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	return events, recorder, transport, err
}

// aggregateRealClaudeResponses 用生产非流式 Renderer 聚合真实事件。
func aggregateRealClaudeResponses(
	t *testing.T,
	request inference.Request,
	events []inference.StreamEvent,
) []byte {
	t.Helper()

	aggregator := openairesponses.NewResponseAggregator(request, time.Now().UTC())
	for _, event := range events {
		if err := aggregator.Add(event); err != nil {
			t.Fatalf("聚合真实 Responses 事件失败: kind=%s error=%v", event.Kind(), err)
		}
	}
	body, err := aggregator.Marshal()
	if err != nil {
		t.Fatalf("编码真实 Responses 响应失败: %v", err)
	}
	return body
}

// decodeRealClaudeReplayRequest 把真实 Responses 输出作为下一轮历史重新解码。
func decodeRealClaudeReplayRequest(
	t *testing.T,
	firstResponse []byte,
) inference.Request {
	t.Helper()

	var response struct {
		Output []json.RawMessage `json:"output"`
	}
	if err := json.Unmarshal(firstResponse, &response); err != nil ||
		len(response.Output) == 0 {
		t.Fatal("真实 Responses 输出无法形成回放历史")
	}
	user, err := json.Marshal(map[string]any{
		"type": "message",
		"role": "user",
		"content": []map[string]string{{
			"type": "input_text",
			"text": realClaudeReplayPrompt,
		}},
	})
	if err != nil {
		t.Fatalf("编码真实回放用户消息失败: %v", err)
	}
	defer clear(user)
	input := append([]json.RawMessage(nil), response.Output...)
	input = append(input, json.RawMessage(user))
	body, err := json.Marshal(struct {
		Model           string            `json:"model"`
		Input           []json.RawMessage `json:"input"`
		Reasoning       map[string]string `json:"reasoning"`
		Stream          bool              `json:"stream"`
		MaxOutputTokens uint64            `json:"max_output_tokens"`
	}{
		Model: realClaudeSmokeAlias,
		Input: input,
		Reasoning: map[string]string{
			"effort":  string(inference.ReasoningEffortLow),
			"summary": string(inference.ReasoningSummaryAuto),
		},
		Stream:          false,
		MaxOutputTokens: 512,
	})
	if err != nil {
		t.Fatalf("编码真实 Responses 回放请求失败: %v", err)
	}
	defer clear(body)
	adapter, err := openairesponses.NewAdapter(time.Now)
	if err != nil {
		t.Fatalf("openairesponses.NewAdapter() error = %v", err)
	}
	request, err := adapter.Decode(body)
	if err != nil {
		t.Fatalf("解码真实 Responses 回放请求失败: %v", err)
	}
	return request
}

// hasReasoningDelta 判断事件流是否包含指定 reasoning 增量类别。
func hasReasoningDelta(
	events []inference.StreamEvent,
	kind inference.ReasoningDeltaKind,
) bool {
	for _, event := range events {
		if delta, ok := event.(inference.ReasoningDeltaEvent); ok &&
			delta.DeltaKind() == kind {
			return true
		}
	}
	return false
}

// hasCompletedThinking 验证事件流保留完整的 Claude thinking 和 signature。
func hasCompletedThinking(events []inference.StreamEvent) bool {
	for _, event := range events {
		completed, ok := event.(inference.ReasoningCompletedEvent)
		if !ok {
			continue
		}
		content := completed.Content()
		if content.ReasoningKind() == inference.ReasoningThinking &&
			content.Text() != "" &&
			content.Signature() != "" {
			return true
		}
	}
	return false
}

// hasCompletedRedactedThinking 验证事件流保留非空 Claude redacted 数据。
func hasCompletedRedactedThinking(events []inference.StreamEvent) bool {
	for _, event := range events {
		completed, ok := event.(inference.ReasoningCompletedEvent)
		if !ok {
			continue
		}
		content := completed.Content()
		if content.ReasoningKind() == inference.ReasoningRedacted &&
			content.RedactedData() != "" {
			return true
		}
	}
	return false
}

// reasoningDeltaKinds 只输出 reasoning 增量种类，不输出正文。
func reasoningDeltaKinds(events []inference.StreamEvent) string {
	kinds := make([]string, 0, 2)
	seen := make(map[inference.ReasoningDeltaKind]struct{}, 2)
	for _, event := range events {
		delta, ok := event.(inference.ReasoningDeltaEvent)
		if !ok {
			continue
		}
		kind := delta.DeltaKind()
		if _, exists := seen[kind]; exists {
			continue
		}
		seen[kind] = struct{}{}
		kinds = append(kinds, string(kind))
	}
	if len(kinds) == 0 {
		return "none"
	}
	return strings.Join(kinds, "+")
}

// usageEventShape 只报告 usage 事件是否存在，不报告账号额度或 token 数值。
func usageEventShape(events []inference.StreamEvent) string {
	updated := false
	completed := false
	for _, event := range events {
		switch event.(type) {
		case inference.UsageUpdatedEvent:
			updated = true
		case inference.ResponseCompletedEvent:
			completed = true
		}
	}
	return "updated=" + strconv.FormatBool(updated) +
		",completed=" + strconv.FormatBool(completed)
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
