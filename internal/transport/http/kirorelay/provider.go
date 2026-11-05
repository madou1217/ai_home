package kirorelay

import (
	"encoding/json"
	"net/http"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// ProviderID 是本通道服务的 Provider。
const ProviderID = "kiro"

// 上游协议常量（Coral 只认这个 content-type，否则判 UnknownOperationException）。
const (
	// Operation 是 CodeWhisperer 流式推理的操作名。
	Operation = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse"
	// ContentType 是 Coral 要求的请求类型。
	ContentType = "application/x-amz-json-1.0"
	// AcceptEventStream 是响应类型。
	AcceptEventStream = "application/vnd.amazon.eventstream"
	// DefaultRegion 是账号没写区域时的兜底。
	DefaultRegion = "us-east-1"
)

// Provider 是 kiro 在 relaycore 上的实现。
//
// 与 cline 这类「零覆盖」不同，kiro 的三处差异都在这里：Coral 的 content-type/
// x-amz-target、conversationState 编码、AWS event-stream 响应。Response 由
// TransformResponse 接管（见 sse.go），其余沿用 relaycore 的尝试循环与记账。
type Provider struct {
	relaycore.BaseProvider
	credential  accountapp.Credential
	accessToken string
	region      string
	profileArn  string
	endpoint    string
	// model 记录最近一次请求的模型名（TransformResponse 回填响应里的 model）。
	model    string
	resolved bool
}

var _ relaycore.Provider = (*Provider)(nil)
var _ relaycore.ResponseTransformer = (*Provider)(nil)

// NewProvider 创建 kiro 透传 Provider。
func NewProvider() *Provider {
	return &Provider{BaseProvider: relaycore.NewBaseProvider(ProviderID, "")}
}

// Resolve 认领 kiro 并解析端点；凭据缺失时认领但 fail-closed（能力判定路径）。
func (provider *Provider) Resolve(input relaycore.ResolveInput) (relaycore.Provider, bool) {
	if !strings.EqualFold(strings.TrimSpace(input.ProviderID), ProviderID) {
		return nil, false
	}
	variant := &Provider{
		BaseProvider: relaycore.NewBaseProvider(ProviderID, ""),
		credential:   input.Credential,
	}
	native, ok := input.Credential.(*accountcore.NativeCredential)
	if !ok || native == nil || native.ProviderID() != ProviderID {
		return variant, true
	}
	var payload map[string]any
	if err := json.Unmarshal(native.Payload(), &payload); err != nil || payload == nil {
		return variant, true
	}
	auth := objectValue(payload["auth"])
	token := textValue(auth["access_token"])
	if token == "" {
		token = textValue(auth["accessToken"])
	}
	region := textValue(auth["region"])
	if region == "" {
		region = DefaultRegion
	}
	profileArn := textValue(payload["profileArn"])
	if profileArn == "" {
		profileArn = textValue(auth["profile_arn"])
	}
	if profileArn == "" {
		profileArn = textValue(auth["profileArn"])
	}
	variant.accessToken = token
	variant.region = region
	variant.profileArn = profileArn
	variant.endpoint = "https://codewhisperer." + region + ".amazonaws.com/"
	variant.resolved = token != ""
	variant.BaseProvider = relaycore.NewBaseProvider(ProviderID, variant.endpoint)
	return variant, true
}

// Endpoint 返回 CodeWhisperer 的区域端点。
func (provider *Provider) Endpoint() (string, bool) {
	if provider == nil || !provider.resolved || provider.endpoint == "" {
		return "", false
	}
	return provider.endpoint, true
}

// AccessToken 返回 Bearer 令牌。
func (provider *Provider) AccessToken(accountapp.Credential) (string, error) {
	if provider == nil || !provider.resolved || provider.accessToken == "" {
		return "", relaycore.ErrUnsupportedCredential
	}
	return provider.accessToken, nil
}

// RewriteRequest 把 OpenAI chat 编码成 conversationState。
func (provider *Provider) RewriteRequest(body []byte) (relaycore.RewriteResult, error) {
	if provider == nil || !provider.resolved {
		return relaycore.RewriteResult{}, relaycore.ErrUnsupportedCredential
	}
	request, err := parseChatRequest(body)
	if err != nil {
		return relaycore.RewriteResult{}, ErrInvalidRequest
	}
	provider.model = request.Model
	encoded := EncodeConversation(request.Messages, EncodeOptions{
		ModelID:   request.Model,
		ToolCount: request.ToolCount,
	})
	if provider.profileArn != "" {
		encoded.Body["profileArn"] = provider.profileArn
	}
	payload, err := json.Marshal(encoded.Body)
	if err != nil {
		return relaycore.RewriteResult{}, ErrInvalidRequest
	}
	return relaycore.RewriteResult{Body: payload, Degradations: encoded.Degradations}, nil
}

// DecorateUpstream 补齐 Coral 协议头。
func (provider *Provider) DecorateUpstream(request *http.Request, accessToken string) {
	if provider == nil || request == nil {
		return
	}
	provider.BaseProvider.DecorateUpstream(request, accessToken)
	request.Header.Set("Content-Type", ContentType)
	request.Header.Set("Accept", AcceptEventStream)
	request.Header.Set("x-amz-target", Operation)
}

// ErrInvalidRequest 表示客户端请求体无法编码成 conversationState。
var ErrInvalidRequest = errorString("kiro 请求体无效")

type errorString string

func (err errorString) Error() string { return string(err) }

type chatRequest struct {
	Model     string
	Messages  []Message
	ToolCount int
}

func parseChatRequest(body []byte) (chatRequest, error) {
	var raw struct {
		Model    string            `json:"model"`
		Messages []json.RawMessage `json:"messages"`
		Tools    []json.RawMessage `json:"tools"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return chatRequest{}, err
	}
	request := chatRequest{Model: strings.TrimSpace(raw.Model), ToolCount: len(raw.Tools)}
	for _, item := range raw.Messages {
		var message struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		}
		if err := json.Unmarshal(item, &message); err != nil {
			return chatRequest{}, err
		}
		text, hasImages := readContent(message.Content)
		request.Messages = append(request.Messages, Message{
			Role:      message.Role,
			Content:   text,
			HasImages: hasImages,
		})
	}
	return request, nil
}

// readContent 接受 OpenAI 的两种 content 形态：字符串或 part 数组。
func readContent(raw json.RawMessage) (string, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return "", false
	}
	if strings.HasPrefix(trimmed, `"`) {
		var text string
		if json.Unmarshal(raw, &text) == nil {
			return strings.TrimSpace(text), false
		}
		return "", false
	}
	if !strings.HasPrefix(trimmed, "[") {
		return "", false
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &parts); err != nil {
		return "", false
	}
	texts := make([]string, 0, len(parts))
	hasImages := false
	for _, part := range parts {
		switch part.Type {
		case "text", "input_text":
			if text := strings.TrimSpace(part.Text); text != "" {
				texts = append(texts, text)
			}
		case "image_url", "input_image", "image":
			hasImages = true
		}
	}
	return strings.Join(texts, "\n"), hasImages
}

func objectValue(value any) map[string]any {
	object, _ := value.(map[string]any)
	return object
}
