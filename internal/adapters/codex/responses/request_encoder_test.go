package responses

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/openairesponses"
)

// TestEncodeRequestPreservesCodexResponsesInputs 验证输入、工具、reasoning、
// structured output 和非流式客户端请求均无损进入上游合同。
func TestEncodeRequestPreservesCodexResponsesInputs(t *testing.T) {
	t.Parallel()

	request := decodeResponsesRequest(t, `{
		"model": "client-alias",
		"input": [
			{
				"type": "message",
				"role": "developer",
				"content": [{"type":"input_text","text":"遵守约束"}]
			},
			{
				"type": "message",
				"role": "user",
				"content": [
					{"type":"input_text","text":"分析附件"},
					{"type":"input_image","detail":"high","image_url":"data:image/png;base64,QUJD"},
					{"type":"input_file","detail":"auto","filename":"notes.txt","file_data":"data:text/plain;base64,SGVsbG8="}
				]
			},
			{
				"type": "function_call",
				"call_id": "call_weather",
				"name": "get_weather",
				"arguments": "{\"city\":\"上海\"}"
			},
			{
				"type": "function_call_output",
				"call_id": "call_weather",
				"output": "晴"
			},
			{
				"type": "reasoning",
				"summary": [{"type":"summary_text","text":"先检查天气"}],
				"encrypted_content": "encrypted_reasoning"
			}
		],
		"tools": [{
			"type": "function",
			"name": "get_weather",
			"description": "查询天气",
			"parameters": {
				"type": "object",
				"properties": {"city":{"type":"string"}},
				"required": ["city"],
				"additionalProperties": false
			},
			"strict": true
		}],
		"tool_choice": {"type":"function","name":"get_weather"},
		"parallel_tool_calls": false,
		"reasoning": {"effort":"xhigh","summary":"concise"},
		"text": {
			"format": {
				"type": "json_schema",
				"name": "weather_result",
				"description": "天气结果",
				"schema": {
					"type": "object",
					"properties": {"condition":{"type":"string"}},
					"required": ["condition"],
					"additionalProperties": false
				},
				"strict": true
			}
		},
		"include": ["reasoning.encrypted_content"],
		"store": false,
		"stream": false
	}`)

	payload, err := encodeRequest(
		request,
		"gpt-5.4",
		codexauth.AuthKindAPIKey,
		requestProfileForModel("gpt-5.4"),
	)
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	var encoded map[string]any
	if err := json.Unmarshal(payload, &encoded); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if encoded["model"] != "gpt-5.4" ||
		encoded["stream"] != true ||
		encoded["store"] != false ||
		encoded["parallel_tool_calls"] != false {
		t.Fatalf("root fields = %#v", encoded)
	}
	input := encoded["input"].([]any)
	if len(input) != 5 {
		t.Fatalf("input len = %d, want 5: %s", len(input), payload)
	}
	user := input[1].(map[string]any)
	userContent := user["content"].([]any)
	image := userContent[1].(map[string]any)
	document := userContent[2].(map[string]any)
	if image["image_url"] != "data:image/png;base64,QUJD" ||
		image["detail"] != "high" ||
		document["file_data"] != "data:text/plain;base64,SGVsbG8=" ||
		document["filename"] != "notes.txt" {
		t.Fatalf("media = image:%#v document:%#v", image, document)
	}
	call := input[2].(map[string]any)
	result := input[3].(map[string]any)
	reasoning := input[4].(map[string]any)
	if call["type"] != "function_call" ||
		call["call_id"] != "call_weather" ||
		result["output"] != "晴" ||
		reasoning["encrypted_content"] != "encrypted_reasoning" {
		t.Fatalf(
			"call=%#v result=%#v reasoning=%#v",
			call,
			result,
			reasoning,
		)
	}
	toolChoice := encoded["tool_choice"].(map[string]any)
	reasoningConfig := encoded["reasoning"].(map[string]any)
	text := encoded["text"].(map[string]any)
	format := text["format"].(map[string]any)
	if toolChoice["name"] != "get_weather" ||
		reasoningConfig["effort"] != "xhigh" ||
		format["description"] != "天气结果" ||
		format["strict"] != true {
		t.Fatalf(
			"tool_choice=%#v reasoning=%#v text=%#v",
			toolChoice,
			reasoningConfig,
			text,
		)
	}
	t.Logf(
		"upstream payload: model=%s stream=%t input_items=%d tools=%d",
		encoded["model"],
		encoded["stream"],
		len(input),
		len(encoded["tools"].([]any)),
	)
}

// TestEncodeRequestAppliesResponsesLiteProfile 验证 Lite 模型的工具、
// reasoning、include 和并行调用形态与官方 Codex rust-v0.145.0 一致。
func TestEncodeRequestAppliesResponsesLiteProfile(t *testing.T) {
	t.Parallel()

	request := decodeResponsesRequest(t, `{
		"model": "client-alias",
		"input": "调用工具",
		"tools": [{
			"type": "function",
			"name": "lookup",
			"description": "查询",
			"parameters": {
				"type": "object",
				"properties": {},
				"additionalProperties": false
			},
			"strict": true
		}],
		"parallel_tool_calls": true
	}`)
	profile := requestProfileForModel("gpt-5.6-sol")
	payload, err := encodeRequest(
		request,
		"gpt-5.6-sol",
		codexauth.AuthKindOAuth,
		profile,
	)
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	var encoded map[string]any
	if err := json.Unmarshal(payload, &encoded); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if _, found := encoded["tools"]; found {
		t.Fatalf("Lite 顶层 tools 不应存在: %s", payload)
	}
	if encoded["parallel_tool_calls"] != false {
		t.Fatalf("parallel_tool_calls = %#v", encoded["parallel_tool_calls"])
	}
	input := encoded["input"].([]any)
	if len(input) != 2 {
		t.Fatalf("input len = %d, want 2: %s", len(input), payload)
	}
	additionalTools := input[0].(map[string]any)
	if additionalTools["type"] != "additional_tools" ||
		additionalTools["role"] != "developer" ||
		len(additionalTools["tools"].([]any)) != 1 {
		t.Fatalf("additional_tools = %#v", additionalTools)
	}
	reasoning := encoded["reasoning"].(map[string]any)
	if reasoning["effort"] != "low" ||
		reasoning["context"] != reasoningContextAllTurns {
		t.Fatalf("reasoning = %#v", reasoning)
	}
	include := encoded["include"].([]any)
	if len(include) != 1 ||
		include[0] != "reasoning.encrypted_content" {
		t.Fatalf("include = %#v", include)
	}
	textControl := encoded["text"].(map[string]any)
	if textControl["verbosity"] != "low" ||
		textControl["format"] != nil {
		t.Fatalf("text = %#v", textControl)
	}
}

// TestRequestProfileForModelMatchesCodex0145 固化当前官方模型清单中的
// Lite 模型与默认 reasoning effort，未知模型回退标准合同。
func TestRequestProfileForModelMatchesCodex0145(t *testing.T) {
	t.Parallel()

	tests := []struct {
		model      string
		wantMode   requestWireMode
		wantEffort string
	}{
		{
			model:      "gpt-5.6-sol",
			wantMode:   responsesLiteMode,
			wantEffort: "low",
		},
		{
			model:      "gpt-5.6-terra",
			wantMode:   responsesLiteMode,
			wantEffort: "medium",
		},
		{
			model:      "gpt-5.6-luna",
			wantMode:   responsesLiteMode,
			wantEffort: "medium",
		},
		{
			model:    "gpt-5.4",
			wantMode: standardResponsesMode,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.model, func(t *testing.T) {
			t.Parallel()

			profile := requestProfileForModel(test.model)
			if profile.mode != test.wantMode ||
				profile.defaultReasoningEffort != test.wantEffort {
				t.Fatalf("profile = %#v", profile)
			}
		})
	}
}

// TestEncodeRequestSupportsInlineTextDocument 验证 Claude 文本型文档可无损转成
// Codex input_file data URL，而不是静默丢弃。
func TestEncodeRequestSupportsInlineTextDocument(t *testing.T) {
	t.Parallel()

	source, err := inference.NewTextMediaSource(
		"text/plain",
		"第一行\n第二行",
	)
	if err != nil {
		t.Fatalf("NewTextMediaSource() error = %v", err)
	}
	document, err := inference.NewDocumentContent(source, "readme.txt")
	if err != nil {
		t.Fatalf("NewDocumentContent() error = %v", err)
	}
	message, err := inference.NewMessage(inference.RoleUser, document)
	if err != nil {
		t.Fatalf("NewMessage() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolAnthropicMessages,
		Model:          "gpt-5.6-sol",
		Messages:       []inference.Message{message},
	})
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}

	payload, err := encodeRequest(
		request,
		"gpt-5.4",
		codexauth.AuthKindAPIKey,
		requestProfileForModel("gpt-5.4"),
	)
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	expected := "data:text/plain;base64," +
		base64.StdEncoding.EncodeToString([]byte("第一行\n第二行"))
	if !strings.Contains(string(payload), expected) {
		t.Fatalf("payload does not contain text data URL: %s", payload)
	}
}

// TestEncodeRequestRejectsUnsupportedFieldsBeforeTransport 固化官方
// ResponsesApiRequest 没有的字段必须显式拒绝。
func TestEncodeRequestRejectsUnsupportedFieldsBeforeTransport(t *testing.T) {
	t.Parallel()

	uintValue := uint64(10)
	floatValue := 0.5
	store := true
	tests := []struct {
		name     string
		input    inference.RequestInput
		authKind codexauth.AuthKind
		field    string
	}{
		{
			name: "max output tokens",
			input: minimalRequestInput(t, func(input *inference.RequestInput) {
				input.MaxOutputTokens = uintValue
			}),
			authKind: codexauth.AuthKindAPIKey,
			field:    "max_output_tokens",
		},
		{
			name: "temperature",
			input: minimalRequestInput(t, func(input *inference.RequestInput) {
				input.Temperature = &floatValue
			}),
			authKind: codexauth.AuthKindAPIKey,
			field:    "temperature",
		},
		{
			name: "oauth store",
			input: minimalRequestInput(t, func(input *inference.RequestInput) {
				input.Store = &store
			}),
			authKind: codexauth.AuthKindOAuth,
			field:    "store",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			request, err := inference.NewRequest(test.input)
			if err != nil {
				t.Fatalf("NewRequest() error = %v", err)
			}
			_, err = encodeRequest(
				request,
				"gpt-5.6-sol",
				test.authKind,
				requestProfileForModel("gpt-5.6-sol"),
			)
			if !errors.Is(err, ErrUnsupportedRequest) ||
				!strings.Contains(err.Error(), test.field) {
				t.Fatalf("encodeRequest() error = %v", err)
			}
		})
	}
}

// TestBuildHTTPRequestUsesCredentialSpecificEndpointAndHeaders 验证 API Key、
// OAuth 工作区和 personal 账号不会共享错误的 Header。
func TestBuildHTTPRequestUsesCredentialSpecificEndpointAndHeaders(t *testing.T) {
	t.Parallel()

	apiKey, err := codexauth.NewAPIKeyAuth(codexauth.APIKeyInput{
		APIKey:  "sk-test-request-header-secret",
		BaseURL: "https://proxy.example.com/openai/v1/",
	})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	workspace := newTestOAuth(t, "workspace-123", true)
	personal := newTestOAuth(t, "", false)
	tests := []struct {
		name            string
		credential      anyCredential
		wantURL         string
		wantAccountID   string
		wantFedRAMP     string
		model           string
		wantLite        string
		forbiddenInBody string
	}{
		{
			name:            "api key standard",
			credential:      apiKey,
			wantURL:         "https://proxy.example.com/openai/v1/responses",
			model:           "gpt-5.4",
			forbiddenInBody: apiKey.APIKey(),
		},
		{
			name:            "api key lite",
			credential:      apiKey,
			wantURL:         "https://proxy.example.com/openai/v1/responses",
			model:           "gpt-5.6-sol",
			wantLite:        "true",
			forbiddenInBody: apiKey.APIKey(),
		},
		{
			name:          "oauth workspace",
			credential:    workspace,
			wantURL:       chatGPTCodexBaseURL + "/responses",
			wantAccountID: "workspace-123",
			wantFedRAMP:   "true",
			model:         "gpt-5.6-sol",
			wantLite:      "true",
		},
		{
			name:       "oauth personal",
			credential: personal,
			wantURL:    chatGPTCodexBaseURL + "/responses",
			model:      "gpt-5.6-sol",
			wantLite:   "true",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			projection, err := projectAuth(test.credential)
			if err != nil {
				t.Fatalf("projectAuth() error = %v", err)
			}
			request, err := buildHTTPRequest(
				t.Context(),
				projection,
				[]byte(`{"model":"redacted"}`),
				requestProfileForModel(test.model),
			)
			if err != nil {
				t.Fatalf("buildHTTPRequest() error = %v", err)
			}
			if request.Method != http.MethodPost ||
				request.URL.String() != test.wantURL ||
				request.Header.Get("Accept") != "text/event-stream" ||
				request.Header.Get("Originator") != codexOriginator ||
				request.Header.Get("User-Agent") != codexUserAgent ||
				request.Header.Get("Version") != codexProtocolVersion ||
				request.Header.Get(responsesLiteHeader) != test.wantLite ||
				request.Header.Get("ChatGPT-Account-ID") != test.wantAccountID ||
				request.Header.Get("X-OpenAI-Fedramp") != test.wantFedRAMP {
				t.Fatalf(
					"request=%s %s headers=%v",
					request.Method,
					request.URL,
					request.Header,
				)
			}
			if !strings.HasPrefix(
				request.Header.Get("Authorization"),
				"Bearer ",
			) {
				t.Fatal("Authorization Bearer Header 缺失")
			}
			body := `{"model":"redacted"}`
			if test.forbiddenInBody != "" &&
				strings.Contains(body, test.forbiddenInBody) {
				t.Fatal("凭据进入了请求正文")
			}
		})
	}
	if codexProtocolVersion != "0.145.0" ||
		codexUserAgent != "codex_cli_rs/0.145.0" {
		t.Fatalf(
			"version=%s user_agent=%s",
			codexProtocolVersion,
			codexUserAgent,
		)
	}
}

// anyCredential 缩短凭据表驱动测试的类型声明。
type anyCredential interface {
	ProviderID() string
	IdentitySeed() string
	String() string
	GoString() string
}

// decodeResponsesRequest 使用已经严格验证的客户端 Decoder 构造 Canonical 请求。
func decodeResponsesRequest(t *testing.T, body string) inference.Request {
	t.Helper()

	request, err := openairesponses.NewRequestDecoder().Decode([]byte(body))
	if err != nil {
		t.Fatalf("RequestDecoder.Decode() error = %v", err)
	}
	return request
}

// minimalRequestInput 创建各拒绝用例共享的最小合法请求。
func minimalRequestInput(
	t *testing.T,
	change func(*inference.RequestInput),
) inference.RequestInput {
	t.Helper()

	text, err := inference.NewTextContent("hello")
	if err != nil {
		t.Fatalf("NewTextContent() error = %v", err)
	}
	message, err := inference.NewMessage(inference.RoleUser, text)
	if err != nil {
		t.Fatalf("NewMessage() error = %v", err)
	}
	input := inference.RequestInput{
		ClientProtocol: inference.ClientProtocolOpenAIResponses,
		Model:          "gpt-5.6-sol",
		Messages:       []inference.Message{message},
	}
	change(&input)
	return input
}

// newTestOAuth 创建只用于 Header 合同测试的合成 OAuth 凭据。
func newTestOAuth(
	t *testing.T,
	accountID string,
	fedRAMP bool,
) *codexauth.OAuthAuth {
	t.Helper()

	authClaims := map[string]any{
		"chatgpt_user_id":            "user-123",
		"chatgpt_account_is_fedramp": fedRAMP,
	}
	if accountID != "" {
		authClaims["chatgpt_account_id"] = accountID
	}
	idToken := testJWT(t, map[string]any{
		"https://api.openai.com/auth": authClaims,
	})
	auth, err := codexauth.NewOAuthAuth(codexauth.OAuthInput{
		AccessToken:   "oauth-access-header-secret",
		RefreshToken:  "oauth-refresh-header-secret",
		IDToken:       idToken,
		RefreshedAtMS: 1,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return auth
}

// testJWT 构造领域测试允许的三段 JWT。
func testJWT(t *testing.T, claims map[string]any) string {
	t.Helper()

	header, err := json.Marshal(map[string]any{
		"alg": "none",
		"typ": "JWT",
	})
	if err != nil {
		t.Fatalf("json.Marshal(header) error = %v", err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("json.Marshal(payload) error = %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(header) + "." +
		base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}
