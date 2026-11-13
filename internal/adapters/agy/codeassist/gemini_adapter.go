package codeassist

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"runtime"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/gemini"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/attemptfailure"
	sharedsse "github.com/madou1217/ai_home/internal/adapters/sse"
)

const (
	// geminiCodeAssistBaseURL 是 Gemini CLI 的 Code Assist 数据面。
	geminiCodeAssistBaseURL = "https://cloudcode-pa.googleapis.com/v1internal"
	// geminiClientVersion 与 Node DEFAULT_GEMINI_CODE_ASSIST_CLIENT_VERSION 同值。
	geminiClientVersion = "0.42.0"
)

var (
	// ErrGeminiCredential 表示账号凭据不是可用的 Gemini OAuth artifact。
	ErrGeminiCredential = errors.New("Gemini Code Assist 凭据无效")
	// ErrGeminiProject 表示 loadCodeAssist 没有返回可用项目。
	ErrGeminiProject = errors.New("Gemini Code Assist 项目不可用")
)

// GeminiAdapter 把 Gemini CLI OAuth 账号接到 Code Assist 推理面。
type GeminiAdapter struct {
	client HTTPClient
	clock  Clock
	random io.Reader
}

var _ inferencegateway.UpstreamAdapter = (*GeminiAdapter)(nil)

// NewGeminiAdapter 创建 Gemini Code Assist 上游适配器。
func NewGeminiAdapter(client HTTPClient, clock Clock) (*GeminiAdapter, error) {
	if client == nil || clock == nil {
		return nil, ErrInvalidDependencies
	}
	return &GeminiAdapter{client: client, clock: clock, random: randReader()}, nil
}

// ProviderID 返回 Gemini。
func (*GeminiAdapter) ProviderID() inference.ProviderID { return inference.ProviderGemini }

// ProtocolID 返回 Gemini Code Assist 协议。
func (*GeminiAdapter) ProtocolID() inference.ProtocolID {
	return inference.ProtocolGeminiCodeAssist
}

// SupportsCredential 只接受带 oauthCreds.access_token 的 Gemini 原生凭据。
func (adapter *GeminiAdapter) SupportsCredential(credential accountapp.Credential) bool {
	_, ok := geminiAccessToken(credential)
	return ok
}

// BuildRoute 为 Gemini Code Assist 模型声明能力合同。
func (adapter *GeminiAdapter) BuildRoute(modelID runtimecore.ModelID) (inferencegateway.Route, error) {
	if adapter == nil || !modelID.IsValid() {
		return inferencegateway.Route{}, ErrInvalidRouteModel
	}
	capabilities, err := inference.NewCapabilitySet(
		inference.CapabilityTextGeneration,
		inference.CapabilityTools,
		inference.CapabilityStreaming,
		inference.CapabilityReasoning,
		inference.CapabilityWebSearch,
		inference.CapabilityImageInput,
		inference.CapabilityContextManagement,
	)
	if err != nil {
		return inferencegateway.Route{}, err
	}
	return inferencegateway.NewRoute(
		inference.ProviderGemini,
		inference.ProtocolGeminiCodeAssist,
		modelID.String(),
		capabilities,
	)
}

// Execute 把 Canonical 请求编码成 Gemini Code Assist envelope，并流式解码回事件。
func (adapter *GeminiAdapter) Execute(
	ctx context.Context,
	invocation inferencegateway.Invocation,
	emit inferencegateway.EventSink,
) (inferencegateway.AttemptResult, error) {
	if adapter == nil || adapter.client == nil || adapter.clock == nil ||
		ctx == nil || emit == nil ||
		invocation.Route().ProviderID() != inference.ProviderGemini ||
		invocation.Route().ProtocolID() != inference.ProtocolGeminiCodeAssist {
		return inferencegateway.AttemptResult{}, ErrInvalidDependencies
	}
	requestID, sessionID, err := newRequestIdentities(adapter.clock(), adapter.random)
	if err != nil {
		return inferencegateway.AttemptResult{}, ErrInvalidDependencies
	}
	model := invocation.Route().EffectiveModel()
	if accessToken, ok := geminiAccessToken(invocation.Credential()); ok {
		return adapter.executeCodeAssist(ctx, invocation, emit, accessToken, model, sessionID, requestID)
	}
	if apiKey, baseURL, ok := geminiAPIKey(invocation.Credential()); ok {
		return adapter.executeStandardAPI(ctx, invocation, emit, apiKey, baseURL, model, sessionID)
	}
	return inferencegateway.AttemptResult{}, ErrGeminiCredential
}

// executeCodeAssist 走 Gemini CLI 的 Code Assist（OAuth）。
func (adapter *GeminiAdapter) executeCodeAssist(
	ctx context.Context,
	invocation inferencegateway.Invocation,
	emit inferencegateway.EventSink,
	accessToken string,
	model string,
	sessionID string,
	requestID string,
) (inferencegateway.AttemptResult, error) {
	project, err := adapter.loadProject(ctx, accessToken)
	if err != nil {
		return inferencegateway.AttemptResult{}, err
	}
	payload, err := encodeGeminiRequest(invocation.Request(), model, project, sessionID, requestID)
	if err != nil {
		return inferencegateway.AttemptResult{}, err
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		geminiCodeAssistBaseURL+":streamGenerateContent?alt=sse",
		bytes.NewReader(payload),
	)
	if err != nil {
		return inferencegateway.AttemptResult{}, ErrInvalidDependencies
	}
	applyGeminiHeaders(request, accessToken, model)
	return adapter.executeStream(ctx, request, invocation, emit, model, sessionID)
}

// executeStandardAPI 走 generativelanguage.googleapis.com（API Key / 自定义 base URL）。
func (adapter *GeminiAdapter) executeStandardAPI(
	ctx context.Context,
	invocation inferencegateway.Invocation,
	emit inferencegateway.EventSink,
	apiKey string,
	baseURL string,
	model string,
	sessionID string,
) (inferencegateway.AttemptResult, error) {
	inner, err := encodeGeminiInnerRequest(invocation.Request(), model, sessionID)
	if err != nil {
		return inferencegateway.AttemptResult{}, err
	}
	payload, err := json.Marshal(inner)
	if err != nil {
		return inferencegateway.AttemptResult{}, ErrUnsupportedRequest
	}
	endpoint := normalizeGeminiAPIBase(baseURL) + "/models/" +
		url.PathEscape(model) + ":streamGenerateContent?alt=sse"
	request, err := http.NewRequestWithContext(
		ctx, http.MethodPost, endpoint, bytes.NewReader(payload),
	)
	if err != nil {
		return inferencegateway.AttemptResult{}, ErrInvalidDependencies
	}
	applyGeminiAPIKeyHeaders(request, apiKey, model)
	return adapter.executeStream(ctx, request, invocation, emit, model, sessionID)
}

// executeStream 发送请求并消费 SSE；两条上游的响应都是 {candidates} 或
// {response:{candidates}}，由共享 decoder 同时兼容。
func (adapter *GeminiAdapter) executeStream(
	ctx context.Context,
	request *http.Request,
	invocation inferencegateway.Invocation,
	emit inferencegateway.EventSink,
	model string,
	sessionID string,
) (inferencegateway.AttemptResult, error) {
	response, err := adapter.client.Do(request)
	if err != nil {
		failure, classifyErr := attemptfailure.NewTransport(err)
		if classifyErr != nil {
			return inferencegateway.AttemptResult{}, ErrInvalidUpstreamResponse
		}
		return inferencegateway.FailedAttempt(failure), nil
	}
	if response == nil || response.Body == nil {
		return malformedAttempt()
	}
	defer response.Body.Close()
	observedAt := adapter.clock()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return classifyHTTPFailure(response, observedAt)
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != "text/event-stream" {
		return malformedAttempt()
	}
	names, err := newToolNameMapper(invocation.Request())
	if err != nil {
		return inferencegateway.AttemptResult{}, err
	}
	decoder := newResponseDecoder(model, sessionID, emit, names)
	reader, err := sharedsse.NewReader(response.Body)
	if err != nil {
		return malformedAttempt()
	}
	for {
		event, readErr := reader.Next()
		if readErr != nil {
			if errors.Is(readErr, io.EOF) && decoder.Terminal() {
				return inferencegateway.CompletedAttempt(), nil
			}
			failure, classifyErr := attemptfailure.NewIncompleteStream(readErr)
			if classifyErr != nil {
				return malformedAttempt()
			}
			return inferencegateway.FailedAttempt(failure), nil
		}
		if bytes.Equal(bytes.TrimSpace(event.Data()), []byte("[DONE]")) {
			if decoder.Terminal() {
				return inferencegateway.CompletedAttempt(), nil
			}
			return malformedAttempt()
		}
		if err := decoder.Apply(event.Data()); err != nil {
			return malformedAttempt()
		}
		if decoder.Terminal() {
			return inferencegateway.CompletedAttempt(), nil
		}
	}
}

// geminiAPIKey 从 VertexAuth 或 native API Key 凭据取 key 与自定义 base URL。
func geminiAPIKey(credential accountapp.Credential) (string, string, bool) {
	switch auth := credential.(type) {
	case *gemini.VertexAuth:
		if auth == nil || auth.Placeholder() || strings.TrimSpace(auth.APIKey()) == "" {
			return "", "", false
		}
		return strings.TrimSpace(auth.APIKey()), strings.TrimSpace(auth.BaseURL()), true
	case *accountcore.NativeCredential:
		if auth == nil || auth.ProviderID() != string(inference.ProviderGemini) {
			return "", "", false
		}
		var document map[string]any
		if err := json.Unmarshal(auth.Payload(), &document); err != nil {
			return "", "", false
		}
		key := firstString(document["api_key"], document["apiKey"])
		baseURL := firstString(document["base_url"], document["baseUrl"])
		if key == "" {
			if credentials := objectValue(document["credentials"]); credentials != nil {
				key = firstString(credentials["api_key"], credentials["apiKey"])
				baseURL = firstString(baseURL, credentials["base_url"], credentials["baseUrl"])
			}
		}
		return key, baseURL, key != ""
	default:
		return "", "", false
	}
}

func firstString(values ...any) string {
	for _, value := range values {
		if text, ok := value.(string); ok {
			if trimmed := strings.TrimSpace(text); trimmed != "" {
				return trimmed
			}
		}
	}
	return ""
}

func normalizeGeminiAPIBase(baseURL string) string {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if base == "" {
		base = "https://generativelanguage.googleapis.com/v1beta"
	}
	if !strings.HasSuffix(base, "/v1beta") && !strings.HasSuffix(base, "/v1") {
		base += "/v1beta"
	}
	return base
}

func applyGeminiAPIKeyHeaders(request *http.Request, apiKey string, model string) {
	request.Header.Set("x-goog-api-key", apiKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("Accept-Encoding", "identity")
	request.Header.Set("User-Agent", geminiUserAgent(model))
}

// encodeGeminiRequest 生成 Gemini CLI 的 Code Assist envelope。
func encodeGeminiRequest(
	request inference.Request,
	model string,
	project string,
	sessionID string,
	requestID string,
) ([]byte, error) {
	if project == "" || requestID == "" {
		return nil, ErrUnsupportedRequest
	}
	inner, err := encodeGeminiInnerRequest(request, model, sessionID)
	if err != nil {
		return nil, err
	}
	envelope := geminiGenerateEnvelope{
		Model:        model,
		Project:      project,
		UserPromptID: requestIDUUID(sessionID),
		Request:      inner,
	}
	return json.Marshal(envelope)
}

// encodeGeminiInnerRequest 生成两种 Gemini 上游共用的 generateContent 内层请求。
func encodeGeminiInnerRequest(
	request inference.Request,
	model string,
	sessionID string,
) (generateInnerRequest, error) {
	if model == "" || sessionID == "" {
		return generateInnerRequest{}, ErrUnsupportedRequest
	}
	request = request.FoldToolChanges()
	names, err := newToolNameMapper(request)
	if err != nil {
		return generateInnerRequest{}, err
	}
	contents, system, toolNames, err := encodeMessages(request.Messages(), names)
	if err != nil {
		return generateInnerRequest{}, err
	}
	tools, err := encodeTools(request.Tools(), model, names)
	if err != nil {
		return generateInnerRequest{}, err
	}
	config := wireGenerationConfig{
		MaxOutputTokens: withThinkingReserve(model, request.MaxOutputTokens()),
		StopSequences:   request.StopSequences(),
	}
	if value, found := request.Temperature(); found {
		config.Temperature = &value
	}
	if value, found := request.TopP(); found {
		config.TopP = &value
	}
	if value, found := request.TopK(); found {
		config.TopK = &value
	}
	inner := generateInnerRequest{
		Contents:          contents,
		SystemInstruction: system,
		GenerationConfig:  config,
		SessionID:         sessionID,
	}
	if len(tools) > 0 {
		inner.Tools = []wireToolGroup{{FunctionDeclarations: tools}}
		inner.ToolConfig = encodeToolChoice(request, toolNames)
	}
	return inner, nil
}

type geminiGenerateEnvelope struct {
	Model        string               `json:"model"`
	Project      string               `json:"project"`
	UserPromptID string               `json:"user_prompt_id"`
	Request      generateInnerRequest `json:"request"`
}

// requestIDUUID 由 sessionID 派生一个稳定的 UUID 形状 user_prompt_id。
func requestIDUUID(sessionID string) string {
	clean := strings.ReplaceAll(sessionID, "-", "")
	if len(clean) < 32 {
		return sessionID
	}
	return clean[:8] + "-" + clean[8:12] + "-" + clean[12:16] + "-" +
		clean[16:20] + "-" + clean[20:32]
}

// loadProject 调 loadCodeAssist 取账号的 cloudaicompanionProject。
func (adapter *GeminiAdapter) loadProject(ctx context.Context, accessToken string) (string, error) {
	payload, err := json.Marshal(map[string]any{
		"metadata": map[string]string{
			"ideType":    "GEMINI",
			"platform":   "PLATFORM_UNSPECIFIED",
			"pluginType": "GEMINI",
		},
	})
	if err != nil {
		return "", ErrGeminiProject
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		geminiCodeAssistBaseURL+":loadCodeAssist",
		bytes.NewReader(payload),
	)
	if err != nil {
		return "", ErrGeminiProject
	}
	applyGeminiHeaders(request, accessToken, "")
	response, err := adapter.client.Do(request)
	if err != nil {
		return "", err
	}
	if response == nil || response.Body == nil {
		return "", ErrGeminiProject
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return "", fmt.Errorf("%w: HTTP %d", ErrGeminiProject, response.StatusCode)
	}
	var document struct {
		Project string `json:"cloudaicompanionProject"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&document); err != nil {
		return "", ErrGeminiProject
	}
	project := strings.TrimSpace(document.Project)
	if project == "" {
		return "", ErrGeminiProject
	}
	return project, nil
}

// geminiAccessToken 从 native_auth_json.oauthCreds（兼容 credentials 包裹）取 token。
func geminiAccessToken(credential accountapp.Credential) (string, bool) {
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil || native.ProviderID() != string(inference.ProviderGemini) {
		return "", false
	}
	var document map[string]any
	if err := json.Unmarshal(native.Payload(), &document); err != nil {
		return "", false
	}
	oauth := objectValue(document["oauthCreds"])
	if oauth == nil {
		oauth = objectValue(document["oauth_creds"])
	}
	if oauth == nil {
		if credentials := objectValue(document["credentials"]); credentials != nil {
			oauth = objectValue(credentials["oauthCreds"])
			if oauth == nil {
				oauth = objectValue(credentials["oauth_creds"])
			}
		}
	}
	if oauth == nil {
		return "", false
	}
	token := strings.TrimSpace(stringValue(oauth["access_token"]))
	if token == "" {
		token = strings.TrimSpace(stringValue(oauth["accessToken"]))
	}
	return token, token != ""
}

func objectValue(value any) map[string]any {
	object, _ := value.(map[string]any)
	return object
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

func applyGeminiHeaders(request *http.Request, accessToken string, model string) {
	request.Header.Set("Authorization", "Bearer "+accessToken)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("Accept-Encoding", "identity")
	request.Header.Set("User-Agent", geminiUserAgent(model))
}

func geminiUserAgent(model string) string {
	modelID := strings.TrimSpace(model)
	if modelID == "" {
		modelID = "unknown"
	}
	platform := runtime.GOOS
	if platform == "windows" {
		platform = "win32"
	}
	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "x64"
	}
	return "GeminiCLI-cli-command/" + geminiClientVersion + "/" + modelID +
		" (" + platform + "; " + arch + "; terminal)"
}

func randReader() io.Reader {
	return rand.Reader
}
