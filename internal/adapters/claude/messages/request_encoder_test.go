package messages

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/inference"
)

// TestEncodeRequestPreservesClaudeMessagesSemantics 验证 Canonical 请求的
// system、媒体、thinking、tools、缓存和采样配置均无损进入 Messages 线协议。
func TestEncodeRequestPreservesClaudeMessagesSemantics(t *testing.T) {
	t.Parallel()

	request := newCompleteClaudeRequest(t)
	encoded, err := encodeRequest(request, "claude-sonnet-4-6")
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}

	var payload map[string]any
	if err := json.Unmarshal(encoded.payload, &payload); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if payload["model"] != "claude-sonnet-4-6" ||
		payload["stream"] != true ||
		payload["max_tokens"] != float64(8192) ||
		payload["temperature"] != 1.0 ||
		payload["top_p"] != 0.9 ||
		payload["top_k"] != float64(40) {
		t.Fatalf("request root = %#v", payload)
	}
	system := payload["system"].([]any)
	if len(system) != 2 ||
		system[0].(map[string]any)["text"] != "system rule" ||
		system[1].(map[string]any)["text"] != "developer rule" {
		t.Fatalf("system = %#v", system)
	}
	messages := payload["messages"].([]any)
	if len(messages) != 3 {
		t.Fatalf("messages = %#v", messages)
	}
	assistant := messages[1].(map[string]any)["content"].([]any)
	thinking := assistant[0].(map[string]any)
	if thinking["type"] != "thinking" ||
		thinking["thinking"] != "private thought" ||
		thinking["signature"] != "signed-continuity" {
		t.Fatalf("thinking = %#v", thinking)
	}
	toolUse := assistant[1].(map[string]any)
	if toolUse["type"] != "tool_use" ||
		toolUse["id"] != "call_weather" ||
		toolUse["name"] != "weather" {
		t.Fatalf("tool_use = %#v", toolUse)
	}
	toolChoice := payload["tool_choice"].(map[string]any)
	if toolChoice["type"] != "tool" ||
		toolChoice["name"] != "weather" ||
		toolChoice["disable_parallel_tool_use"] != true {
		t.Fatalf("tool_choice = %#v", toolChoice)
	}
	outputConfig := payload["output_config"].(map[string]any)
	if outputConfig["effort"] != "high" ||
		outputConfig["format"].(map[string]any)["type"] != "json_schema" {
		t.Fatalf("output_config = %#v", outputConfig)
	}
	if !containsBeta(encoded.betaHeaders, betaStructuredOutputs) ||
		!containsBeta(encoded.betaHeaders, betaEffort) ||
		!containsBeta(encoded.betaHeaders, betaPromptCachingScope) ||
		containsBeta(encoded.betaHeaders, "redact-thinking-2026-02-12") {
		t.Fatalf("beta headers = %#v", encoded.betaHeaders)
	}
}

// TestEncodeRequestUsesClaudeCodeModelDefaultWhenClientOmitsMaxTokens 验证
// 跨协议客户端未声明输出上限时，Claude Adapter 使用当前模型策略，绝不回退到
// 一个跨模型共享的历史常量。
func TestEncodeRequestUsesClaudeCodeModelDefaultWhenClientOmitsMaxTokens(
	t *testing.T,
) {
	t.Parallel()

	tests := []struct {
		name     string
		model    string
		expected uint64
	}{
		{name: "opus 5", model: "claude-opus-5", expected: 64_000},
		{name: "sonnet 5", model: "claude-sonnet-5", expected: 64_000},
		{name: "fable 5", model: "claude-fable-5", expected: 64_000},
		{name: "opus 4.6", model: "claude-opus-4-6", expected: 64_000},
		{name: "opus 4.7", model: "claude-opus-4-7", expected: 64_000},
		{name: "opus 4.8", model: "claude-opus-4-8", expected: 64_000},
		{name: "sonnet 4.6", model: "claude-sonnet-4-6", expected: 32_000},
		{name: "haiku 4.5", model: "claude-haiku-4-5-20251001", expected: 32_000},
		{name: "legacy sonnet 3.5", model: "claude-3-5-sonnet-20241022", expected: 8_192},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			request, err := inference.NewRequest(inference.RequestInput{
				ClientProtocol: inference.ClientProtocolOpenAIResponses,
				Model:          "claude-alias",
				Messages: []inference.Message{
					mustMessage(t, inference.RoleUser, mustText(t, "reply")),
				},
			})
			if err != nil {
				t.Fatalf("inference.NewRequest() error = %v", err)
			}
			encoded, err := encodeRequest(request, test.model)
			if err != nil {
				t.Fatalf("encodeRequest() error = %v", err)
			}
			var payload struct {
				MaxTokens uint64 `json:"max_tokens"`
			}
			if err := json.Unmarshal(encoded.payload, &payload); err != nil {
				t.Fatalf("json.Unmarshal() error = %v", err)
			}
			if payload.MaxTokens != test.expected {
				t.Fatalf("max_tokens = %d, want %d", payload.MaxTokens, test.expected)
			}
		})
	}
}

// TestEncodeRequestRejectsBudgetThatExceedsModelDefault 验证 Adapter 不会为
// 容纳 thinking budget 而静默放大客户端未声明的输出上限。
func TestEncodeRequestRejectsBudgetThatExceedsModelDefault(t *testing.T) {
	t.Parallel()

	reasoning, err := inference.NewBudgetReasoning(
		32_000,
		inference.ReasoningSummaryAuto,
	)
	if err != nil {
		t.Fatalf("inference.NewBudgetReasoning() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolOpenAIResponses,
		Model:          "claude-alias",
		Messages: []inference.Message{
			mustMessage(t, inference.RoleUser, mustText(t, "think")),
		},
		Reasoning: &reasoning,
	})
	if err != nil {
		t.Fatalf("inference.NewRequest() error = %v", err)
	}
	if _, err := encodeRequest(request, "claude-sonnet-4-6"); !errors.Is(
		err,
		ErrUnsupportedRequest,
	) {
		t.Fatalf("encodeRequest() error = %v", err)
	}
}

// TestEncodeEffortReasoningEnablesAdaptiveThinking 验证 Responses effort
// 不会退化为只有强度参数、实际未启用 Claude thinking 的请求。
func TestEncodeEffortReasoningEnablesAdaptiveThinking(t *testing.T) {
	t.Parallel()

	reasoning, err := inference.NewEffortReasoning(
		inference.ReasoningEffortHigh,
		inference.ReasoningSummaryAuto,
	)
	if err != nil {
		t.Fatalf("NewEffortReasoning() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolOpenAIResponses,
		Model:          "claude-alias",
		Messages: []inference.Message{
			mustMessage(t, inference.RoleUser, mustText(t, "分析后回答")),
		},
		Reasoning:       &reasoning,
		MaxOutputTokens: 256,
	})
	if err != nil {
		t.Fatalf("inference.NewRequest() error = %v", err)
	}
	encoded, err := encodeRequest(request, "claude-sonnet-5")
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}

	var payload struct {
		Thinking struct {
			Type    string  `json:"type"`
			Display *string `json:"display"`
		} `json:"thinking"`
		OutputConfig struct {
			Effort string `json:"effort"`
		} `json:"output_config"`
	}
	if err := json.Unmarshal(encoded.payload, &payload); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if payload.Thinking.Type != "adaptive" ||
		payload.Thinking.Display != nil ||
		payload.OutputConfig.Effort != "high" ||
		!containsBeta(encoded.betaHeaders, betaInterleavedThinking) ||
		!containsBeta(encoded.betaHeaders, betaEffort) {
		t.Fatalf(
			"effort reasoning payload = %#v betas=%#v",
			payload,
			encoded.betaHeaders,
		)
	}
}

// TestEncodeOmittedReasoningEnablesRedactThinking 验证明确的 omitted 摘要
// 意图才开启 Claude redact-thinking，不依赖 Responses 输出 include。
func TestEncodeOmittedReasoningEnablesRedactThinking(t *testing.T) {
	t.Parallel()

	reasoning, err := inference.NewEffortReasoning(
		inference.ReasoningEffortLow,
		inference.ReasoningSummaryNone,
	)
	if err != nil {
		t.Fatalf("NewEffortReasoning() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolAnthropicMessages,
		Model:          "claude-alias",
		Messages: []inference.Message{
			mustMessage(t, inference.RoleUser, mustText(t, "分析后回答")),
		},
		Reasoning:       &reasoning,
		MaxOutputTokens: 512,
	})
	if err != nil {
		t.Fatalf("inference.NewRequest() error = %v", err)
	}
	encoded, err := encodeRequest(request, "claude-sonnet-5")
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}

	var payload struct {
		Thinking struct {
			Type    string  `json:"type"`
			Display *string `json:"display"`
		} `json:"thinking"`
	}
	if err := json.Unmarshal(encoded.payload, &payload); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if payload.Thinking.Type != "adaptive" ||
		payload.Thinking.Display == nil ||
		*payload.Thinking.Display != "omitted" ||
		!containsBeta(encoded.betaHeaders, betaInterleavedThinking) ||
		!containsBeta(encoded.betaHeaders, betaRedactThinking) {
		t.Fatalf(
			"omitted reasoning payload = %#v betas=%#v",
			payload,
			encoded.betaHeaders,
		)
	}
}

// TestEncodeRequestReplaysRedactedThinking 验证 Claude redacted 连续性只按原生
// redacted_thinking 回放，不经过 signature 或 Responses carrier。
func TestEncodeRequestReplaysRedactedThinking(t *testing.T) {
	t.Parallel()

	redacted, err := inference.NewRedactedReasoningContent("redacted-exact-1")
	if err != nil {
		t.Fatalf("NewRedactedReasoningContent() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol:  inference.ClientProtocolAnthropicMessages,
		Model:           "claude-opus-5",
		Messages:        []inference.Message{mustMessage(t, inference.RoleAssistant, redacted)},
		MaxOutputTokens: 1024,
	})
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	encoded, err := encodeRequest(request, "claude-opus-5")
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	var payload struct {
		Messages []struct {
			Content []struct {
				Type      string `json:"type"`
				Data      string `json:"data"`
				Signature string `json:"signature"`
			} `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(encoded.payload, &payload); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if len(payload.Messages) != 1 || len(payload.Messages[0].Content) != 1 {
		t.Fatalf("messages = %#v", payload.Messages)
	}
	content := payload.Messages[0].Content[0]
	if content.Type != "redacted_thinking" ||
		content.Data != "redacted-exact-1" ||
		content.Signature != "" {
		t.Fatalf("redacted content = %#v", content)
	}
}

// TestEncodeRequestRejectsSummaryWithoutClaudeSignature 验证可见摘要缺少可验证
// Claude signature 时不会被静默丢弃或伪装成 thinking。
func TestEncodeRequestRejectsSummaryWithoutClaudeSignature(t *testing.T) {
	t.Parallel()

	summary, err := inference.NewReasoningSummaryContent("只有摘要")
	if err != nil {
		t.Fatalf("NewReasoningSummaryContent() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol:  inference.ClientProtocolOpenAIResponses,
		Model:           "claude-opus-5",
		Messages:        []inference.Message{mustMessage(t, inference.RoleAssistant, summary)},
		MaxOutputTokens: 1024,
	})
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	if _, err := encodeRequest(request, "claude-opus-5"); !errors.Is(err, ErrUnsupportedRequest) {
		t.Fatalf("encodeRequest() error = %v, want ErrUnsupportedRequest", err)
	}
}

// TestProjectAuthUsesExactClaudeCredentialHeaders 验证允许直连的 Claude
// 凭据不会在 x-api-key、Bearer 和 OAuth beta 之间发生混用。
func TestProjectAuthUsesExactClaudeCredentialHeaders(t *testing.T) {
	t.Parallel()

	oauthToken, err := claudeauth.NewOAuthTokenAuth(
		claudeauth.OAuthTokenInput{
			AccessToken: "sk-ant-oat01-request-setup",
			BaseURL:     "https://oauth-relay.example/anthropic/v1",
		},
	)
	if err != nil {
		t.Fatalf("claude.NewOAuthTokenAuth() error = %v", err)
	}
	apiKey, err := claudeauth.NewAPIKeyAuth(claudeauth.APIKeyInput{
		APIKey:  "sk-ant-api03-request",
		BaseURL: "https://proxy.example/anthropic",
	})
	if err != nil {
		t.Fatalf("claude.NewAPIKeyAuth() error = %v", err)
	}
	authToken, err := claudeauth.NewAuthTokenAuth(
		claudeauth.AuthTokenInput{
			AuthToken: "third-party-bearer",
			BaseURL:   "https://proxy.example/anthropic/v1",
		},
	)
	if err != nil {
		t.Fatalf("claude.NewAuthTokenAuth() error = %v", err)
	}

	tests := []struct {
		name       string
		credential accountapp.Credential
		header     string
		secret     string
		oauthBeta  bool
		endpoint   string
	}{
		{
			name:       "custom oauth token endpoint",
			credential: oauthToken,
			header:     "Authorization",
			secret:     "Bearer sk-ant-oat01-request-setup",
			oauthBeta:  true,
			endpoint:   "https://oauth-relay.example/anthropic/v1/messages",
		},
		{
			name:       "api key",
			credential: apiKey,
			header:     "x-api-key",
			secret:     "sk-ant-api03-request",
			oauthBeta:  false,
			endpoint:   "https://proxy.example/anthropic/v1/messages",
		},
		{
			name:       "auth token",
			credential: authToken,
			header:     "Authorization",
			secret:     "Bearer third-party-bearer",
			oauthBeta:  false,
			endpoint:   "https://proxy.example/anthropic/v1/messages",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			profile, err := projectAuth(test.credential)
			if err != nil {
				t.Fatalf("projectAuth() error = %v", err)
			}
			if profile.headerName != test.header ||
				profile.headerValue != test.secret ||
				profile.oauthBeta != test.oauthBeta ||
				profile.endpoint != test.endpoint {
				t.Fatalf("profile = %#v", profile.safeSummary())
			}
			request, err := buildHTTPRequest(
				context.Background(),
				profile,
				encodedRequest{payload: []byte(`{}`)},
			)
			if err != nil {
				t.Fatalf("buildHTTPRequest() error = %v", err)
			}
			if request.URL.String() != test.endpoint ||
				request.Header.Get(test.header) != test.secret ||
				request.Header.Get("anthropic-version") !=
					anthropicVersion ||
				containsBeta(
					strings.Split(
						request.Header.Get("anthropic-beta"),
						",",
					),
					betaOAuth,
				) != test.oauthBeta {
				t.Fatalf(
					"request endpoint=%s headers=%v",
					request.URL,
					request.Header,
				)
			}
			if containsBeta(
				strings.Split(
					request.Header.Get("anthropic-beta"),
					",",
				),
				betaClaudeCode,
			) != test.oauthBeta {
				t.Fatalf(
					"Claude Code beta 与认证模式不一致: %v",
					request.Header,
				)
			}
			if test.header == "Authorization" &&
				request.Header.Get("x-api-key") != "" ||
				test.header == "x-api-key" &&
					request.Header.Get("Authorization") != "" {
				t.Fatalf("认证 Header 混用: %v", request.Header)
			}
			if request.Header.Get("x-app") != "" ||
				request.Header.Get("User-Agent") != "" ||
				request.Header.Get("X-Claude-Code-Session-Id") != "" ||
				request.URL.RawQuery != "" {
				t.Fatalf(
					"非原生 OAuth 凭据携带了 Claude Code 专属外层: url=%s headers=%v",
					request.URL,
					request.Header,
				)
			}
		})
	}
}

// TestEncodeRequestMapsNamespacedToolsReversibly 验证 Claude 扁平工具名同时
// 保留 namespace 身份、历史调用和指定工具选择，且同名子工具不会碰撞。
func TestEncodeRequestMapsNamespacedToolsReversibly(t *testing.T) {
	t.Parallel()

	gmailTool := mustNamespacedToolDefinition(t, "gmail", "Gmail", "search")
	calendarTool := mustNamespacedToolDefinition(t, "calendar", "Calendar", "search")
	calendarCall := mustNamespacedToolCall(
		t,
		"call_calendar",
		"calendar",
		"search",
		`{"query":"AIH"}`,
	)
	calendarResult, err := inference.NewToolResultContent(
		"call_calendar",
		false,
		mustText(t, "found"),
	)
	if err != nil {
		t.Fatalf("inference.NewToolResultContent() error = %v", err)
	}
	choice, err := inference.NewNamespacedToolChoice("calendar", "search")
	if err != nil {
		t.Fatalf("inference.NewNamespacedToolChoice() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolOpenAIResponses,
		Model:          "claude",
		Messages: []inference.Message{
			mustMessage(t, inference.RoleUser, mustText(t, "search")),
			mustMessage(t, inference.RoleAssistant, calendarCall),
			mustMessage(t, inference.RoleUser, calendarResult),
		},
		Tools:      []inference.ToolDefinition{gmailTool, calendarTool},
		ToolChoice: &choice,
	})
	if err != nil {
		t.Fatalf("inference.NewRequest() error = %v", err)
	}
	encoded, err := encodeRequest(request, "claude-opus-5")
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}

	var payload map[string]any
	if err := json.Unmarshal(encoded.payload, &payload); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	tools := payload["tools"].([]any)
	if len(tools) != 2 ||
		tools[0].(map[string]any)["name"] != "gmail__search" ||
		tools[1].(map[string]any)["name"] != "calendar__search" {
		t.Fatalf("tools = %#v", tools)
	}
	messages := payload["messages"].([]any)
	historyCall := messages[1].(map[string]any)["content"].([]any)[0].(map[string]any)
	toolChoice := payload["tool_choice"].(map[string]any)
	if historyCall["name"] != "calendar__search" ||
		toolChoice["name"] != "calendar__search" {
		t.Fatalf("history=%#v choice=%#v", historyCall, toolChoice)
	}
	gmailIdentity, err := encoded.toolNames.decode("gmail__search")
	if err != nil {
		t.Fatalf("decode(gmail) error = %v", err)
	}
	calendarIdentity, err := encoded.toolNames.decode("calendar__search")
	if err != nil {
		t.Fatalf("decode(calendar) error = %v", err)
	}
	if gmailIdentity == calendarIdentity ||
		gmailIdentity != gmailTool.Identity() ||
		calendarIdentity != calendarTool.Identity() {
		t.Fatalf(
			"identity mapping gmail=%#v calendar=%#v",
			gmailIdentity,
			calendarIdentity,
		)
	}
}

// TestEncodeRequestKeepsPromptCacheKeyOutOfClaudeMetadata 验证 Responses 的
// 缓存亲和键只转换为缓存意图，诊断 metadata 也不会泄漏到 Claude 请求。
func TestEncodeRequestKeepsPromptCacheKeyOutOfClaudeMetadata(t *testing.T) {
	t.Parallel()

	promptCacheKey := "cache_private_affinity"
	userID := "user-visible"
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolOpenAIResponses,
		Model:          "claude",
		Messages: []inference.Message{
			mustMessage(t, inference.RoleUser, mustText(t, "hello")),
		},
		PromptCacheKey: &promptCacheKey,
		ClientMetadata: map[string]string{
			"session_id": "session_private_diagnostic",
		},
		UserID: &userID,
	})
	if err != nil {
		t.Fatalf("inference.NewRequest() error = %v", err)
	}
	encoded, err := encodeRequest(request, "claude-opus-5")
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}

	var payload map[string]any
	if err := json.Unmarshal(encoded.payload, &payload); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	metadata := payload["metadata"].(map[string]any)
	if len(metadata) != 1 || metadata["user_id"] != userID {
		t.Fatalf("metadata = %#v", metadata)
	}
	if strings.Contains(string(encoded.payload), promptCacheKey) ||
		strings.Contains(string(encoded.payload), "session_private_diagnostic") {
		t.Fatalf("Claude payload 泄漏非语义字段: %s", encoded.payload)
	}
	cacheControl := payload["cache_control"].(map[string]any)
	if cacheControl["type"] != "ephemeral" {
		t.Fatalf("cache_control = %#v", cacheControl)
	}
}

// TestAnthropicEffortMapsCodexBoundaryLevels 验证两端不同的最低和最高
// reasoning 档位按明确规则收敛，不静默落到无关等级。
func TestAnthropicEffortMapsCodexBoundaryLevels(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		input    inference.ReasoningEffort
		expected string
	}{
		{name: "minimal to low", input: inference.ReasoningEffortMinimal, expected: "low"},
		{name: "xhigh to max", input: inference.ReasoningEffortXHigh, expected: "max"},
		{name: "max stays max", input: inference.ReasoningEffortMax, expected: "max"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			actual, err := anthropicEffort(test.input)
			if err != nil || actual != test.expected {
				t.Fatalf("anthropicEffort(%q) = (%q, %v)", test.input, actual, err)
			}
		})
	}
}

// TestProjectAuthRejectsOfficialOAuthWithoutNativeRuntime 验证官方 OAuth
// 不会由普通 Go HTTP 请求伪造 Claude Code 原生客户端证明。
func TestProjectAuthRejectsOfficialOAuthWithoutNativeRuntime(t *testing.T) {
	t.Parallel()

	refreshable, err := claudeauth.NewOAuthAuth(claudeauth.OAuthInput{
		AccessToken:  "sk-ant-oat01-request-oauth",
		RefreshToken: "sk-ant-ort01-request-oauth",
		ExpiresAtMS:  4_102_444_800_000,
		Scopes:       []string{claudeauth.InferenceScope},
		Identity: claudeauth.OAuthIdentity{
			AccountUUID: "123e4567-e89b-12d3-a456-426614174000",
		},
	})
	if err != nil {
		t.Fatalf("claude.NewOAuthAuth() error = %v", err)
	}
	setupToken, err := claudeauth.NewOAuthTokenAuth(
		claudeauth.OAuthTokenInput{
			AccessToken: "sk-ant-oat01-request-setup",
			BaseURL:     "https://api.anthropic.com/v1",
		},
	)
	if err != nil {
		t.Fatalf("claude.NewOAuthTokenAuth() error = %v", err)
	}

	tests := []struct {
		name       string
		credential accountapp.Credential
	}{
		{name: "refreshable oauth", credential: refreshable},
		{name: "official setup token", credential: setupToken},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			if _, err := projectAuth(test.credential); !errors.Is(
				err,
				ErrNativeTransportRequired,
			) {
				t.Fatalf("projectAuth() error = %v", err)
			}
		})
	}
}

// TestEncodeRequestRejectsUnrepresentableOptionsBeforeNetwork 验证 Provider
// 不支持的状态续接不会被静默丢弃。
func TestEncodeRequestRejectsUnrepresentableOptionsBeforeNetwork(
	t *testing.T,
) {
	t.Parallel()

	text := mustText(t, "hello")
	message := mustMessage(t, inference.RoleUser, text)
	continuation, err := inference.NewContinuation(
		inference.ContinuationPreviousResponse,
		"resp_previous",
	)
	if err != nil {
		t.Fatalf("inference.NewContinuation() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolOpenAIResponses,
		Model:          "claude",
		Messages:       []inference.Message{message},
		Continuation:   &continuation,
	})
	if err != nil {
		t.Fatalf("inference.NewRequest() error = %v", err)
	}
	if _, err := encodeRequest(request, "claude-sonnet-4-6"); !errors.Is(
		err,
		ErrUnsupportedRequest,
	) {
		t.Fatalf("encodeRequest() error = %v", err)
	}
}

// TestEncodeRequestDeclaresFilesBetaForFileReferences 验证直接输入和工具
// 结果中的 file_id 都会声明 Files API beta，且 Header 仍保持去重。
func TestEncodeRequestDeclaresFilesBetaForFileReferences(t *testing.T) {
	t.Parallel()

	source, err := inference.NewFileIDMediaSource("file_exact_1")
	if err != nil {
		t.Fatalf("inference.NewFileIDMediaSource() error = %v", err)
	}
	document, err := inference.NewDocumentContent(source, "reference")
	if err != nil {
		t.Fatalf("inference.NewDocumentContent() error = %v", err)
	}
	toolCall, err := inference.NewToolCallContent(
		"toolu_file",
		"inspect_file",
		[]byte(`{}`),
	)
	if err != nil {
		t.Fatalf("inference.NewToolCallContent() error = %v", err)
	}
	toolResult, err := inference.NewToolResultContent(
		"toolu_file",
		false,
		document,
	)
	if err != nil {
		t.Fatalf("inference.NewToolResultContent() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolAnthropicMessages,
		Model:          "claude",
		Messages: []inference.Message{
			mustMessage(t, inference.RoleUser, document),
			mustMessage(t, inference.RoleAssistant, toolCall),
			mustMessage(t, inference.RoleUser, toolResult),
		},
	})
	if err != nil {
		t.Fatalf("inference.NewRequest() error = %v", err)
	}
	encoded, err := encodeRequest(request, "claude-sonnet-4-6")
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	count := 0
	for _, beta := range encoded.betaHeaders {
		if beta == betaFilesAPI {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("files beta count = %d, headers=%v", count, encoded.betaHeaders)
	}
}

// TestEncodeRequestRejectsNonDefaultTemperatureWithThinking 验证预算和自适应
// thinking 不会发送 Anthropic 明确不兼容的采样温度。
func TestEncodeRequestRejectsNonDefaultTemperatureWithThinking(
	t *testing.T,
) {
	t.Parallel()

	reasoning, err := inference.NewBudgetReasoning(
		1024,
		inference.ReasoningSummaryAuto,
	)
	if err != nil {
		t.Fatalf("inference.NewBudgetReasoning() error = %v", err)
	}
	temperature := 0.5
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolAnthropicMessages,
		Model:          "claude",
		Messages: []inference.Message{
			mustMessage(t, inference.RoleUser, mustText(t, "think")),
		},
		Reasoning:       &reasoning,
		Temperature:     &temperature,
		MaxOutputTokens: 2048,
	})
	if err != nil {
		t.Fatalf("inference.NewRequest() error = %v", err)
	}
	if _, err := encodeRequest(request, "claude-sonnet-4-6"); !errors.Is(
		err,
		ErrUnsupportedRequest,
	) {
		t.Fatalf("encodeRequest() error = %v", err)
	}
}

// newCompleteClaudeRequest 创建覆盖当前 Claude Messages 能力的请求夹具。
func newCompleteClaudeRequest(t *testing.T) inference.Request {
	t.Helper()

	system := mustMessage(t, inference.RoleSystem, mustText(t, "system rule"))
	developer := mustMessage(
		t,
		inference.RoleDeveloper,
		mustText(t, "developer rule"),
	)
	imageSource, err := inference.NewBase64MediaSource(
		"image/png",
		"aGVsbG8=",
	)
	if err != nil {
		t.Fatalf("inference.NewBase64MediaSource() error = %v", err)
	}
	image, err := inference.NewImageContent(
		imageSource,
		inference.ImageDetailAuto,
	)
	if err != nil {
		t.Fatalf("inference.NewImageContent() error = %v", err)
	}
	user := mustMessage(
		t,
		inference.RoleUser,
		mustText(t, "inspect"),
		image,
	)
	thinking, err := inference.NewThinkingContent(
		"private thought",
		"signed-continuity",
	)
	if err != nil {
		t.Fatalf("inference.NewThinkingContent() error = %v", err)
	}
	toolCall, err := inference.NewToolCallContent(
		"call_weather",
		"weather",
		[]byte(`{"city":"Shanghai"}`),
	)
	if err != nil {
		t.Fatalf("inference.NewToolCallContent() error = %v", err)
	}
	assistant := mustMessage(
		t,
		inference.RoleAssistant,
		thinking,
		toolCall,
	)
	toolResult, err := inference.NewToolResultContent(
		"call_weather",
		false,
		mustText(t, "sunny"),
	)
	if err != nil {
		t.Fatalf("inference.NewToolResultContent() error = %v", err)
	}
	result := mustMessage(t, inference.RoleUser, toolResult)
	strict := true
	deferLoading := false
	eagerStreaming := true
	tool, err := inference.NewToolDefinitionWithOptions(
		"weather",
		"Read weather",
		[]byte(`{"type":"object","properties":{"city":{"type":"string"}}}`),
		inference.ToolDefinitionOptions{
			Strict:              &strict,
			AllowedCallers:      []inference.ToolCaller{inference.ToolCallerDirect},
			DeferLoading:        &deferLoading,
			EagerInputStreaming: &eagerStreaming,
			InputExamples:       [][]byte{[]byte(`{"city":"Shanghai"}`)},
		},
	)
	if err != nil {
		t.Fatalf("inference.NewToolDefinitionWithOptions() error = %v", err)
	}
	toolChoice, err := inference.NewNamedToolChoice("weather")
	if err != nil {
		t.Fatalf("inference.NewNamedToolChoice() error = %v", err)
	}
	parallel := false
	reasoning, err := inference.NewAdaptiveReasoningWithEffort(
		inference.ReasoningSummaryAuto,
		inference.ReasoningEffortHigh,
	)
	if err != nil {
		t.Fatalf("inference.NewAdaptiveReasoningWithEffort() error = %v", err)
	}
	structured, err := inference.NewStructuredOutput(
		"weather_result",
		"",
		[]byte(`{"type":"object","properties":{"summary":{"type":"string"}}}`),
		true,
	)
	if err != nil {
		t.Fatalf("inference.NewStructuredOutput() error = %v", err)
	}
	temperature := 1.0
	topP := 0.9
	topK := uint64(40)
	userID := "user-smoke"
	globalCache, err := inference.NewPromptCacheControl(
		inference.PromptCacheTTL1Hour,
		inference.PromptCacheScopeGlobal,
	)
	if err != nil {
		t.Fatalf("inference.NewPromptCacheControl() error = %v", err)
	}
	messageCache, err := inference.NewPromptCacheControl(
		inference.PromptCacheTTL5Minutes,
		inference.PromptCacheScopeDefault,
	)
	if err != nil {
		t.Fatalf("inference.NewPromptCacheControl() error = %v", err)
	}
	requestBreakpoint, err := inference.NewRequestPromptCacheBreakpoint(
		globalCache,
	)
	if err != nil {
		t.Fatalf("NewRequestPromptCacheBreakpoint() error = %v", err)
	}
	messageBreakpoint, err := inference.NewMessagePromptCacheBreakpoint(
		2,
		0,
		messageCache,
	)
	if err != nil {
		t.Fatalf("NewMessagePromptCacheBreakpoint() error = %v", err)
	}
	toolBreakpoint, err := inference.NewToolPromptCacheBreakpoint(
		0,
		messageCache,
	)
	if err != nil {
		t.Fatalf("NewToolPromptCacheBreakpoint() error = %v", err)
	}

	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol:            inference.ClientProtocolAnthropicMessages,
		Model:                     "claude-alias",
		Messages:                  []inference.Message{system, developer, user, assistant, result},
		Tools:                     []inference.ToolDefinition{tool},
		ToolChoice:                &toolChoice,
		ParallelToolCalls:         &parallel,
		Reasoning:                 &reasoning,
		StructuredOutput:          &structured,
		Stream:                    true,
		IncludeEncryptedReasoning: true,
		MaxOutputTokens:           8192,
		Temperature:               &temperature,
		TopP:                      &topP,
		TopK:                      &topK,
		UserID:                    &userID,
		PromptCacheBreakpoints: []inference.PromptCacheBreakpoint{
			requestBreakpoint,
			messageBreakpoint,
			toolBreakpoint,
		},
		StopSequences: []string{"<stop>"},
	})
	if err != nil {
		t.Fatalf("inference.NewRequest() error = %v", err)
	}
	return request
}

// mustText 创建测试文本。
func mustText(t *testing.T, value string) inference.TextContent {
	t.Helper()
	content, err := inference.NewTextContent(value)
	if err != nil {
		t.Fatalf("inference.NewTextContent() error = %v", err)
	}
	return content
}

// mustMessage 创建测试消息。
func mustMessage(
	t *testing.T,
	role inference.Role,
	contents ...inference.Content,
) inference.Message {
	t.Helper()
	message, err := inference.NewMessage(role, contents...)
	if err != nil {
		t.Fatalf("inference.NewMessage() error = %v", err)
	}
	return message
}

// mustNamespacedToolDefinition 创建测试用 namespaced 工具定义。
func mustNamespacedToolDefinition(
	t *testing.T,
	namespace string,
	namespaceDescription string,
	name string,
) inference.ToolDefinition {
	t.Helper()
	tool, err := inference.NewNamespacedToolDefinitionWithOptions(
		namespace,
		namespaceDescription,
		name,
		"Search records",
		[]byte(`{"type":"object"}`),
		inference.ToolDefinitionOptions{},
	)
	if err != nil {
		t.Fatalf("inference.NewNamespacedToolDefinitionWithOptions() error = %v", err)
	}
	return tool
}

// mustNamespacedToolCall 创建测试用 namespaced 历史工具调用。
func mustNamespacedToolCall(
	t *testing.T,
	callID string,
	namespace string,
	name string,
	arguments string,
) inference.ToolCallContent {
	t.Helper()
	content, err := inference.NewNamespacedToolCallContent(
		callID,
		namespace,
		name,
		[]byte(arguments),
	)
	if err != nil {
		t.Fatalf("inference.NewNamespacedToolCallContent() error = %v", err)
	}
	return content
}
