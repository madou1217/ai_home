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
		!containsBeta(encoded.betaHeaders, betaRedactThinking) {
		t.Fatalf("beta headers = %#v", encoded.betaHeaders)
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
		})
	}
}

// TestProjectAuthRequiresNativeTransportForOfficialOAuth 验证官方 OAuth
// 不会被误投影为普通 Bearer 请求。
func TestProjectAuthRequiresNativeTransportForOfficialOAuth(t *testing.T) {
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
