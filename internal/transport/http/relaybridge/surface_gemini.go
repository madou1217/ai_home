package relaybridge

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/gemini"
	"github.com/madou1217/ai_home/internal/transport/http/geminiapi"
)

// geminiRelayPath 是交给 relaycore 的内部占位路径。
//
// relaycore 要求 request.URL.Path 与 Handler 声明逐字相等；Gemini 的真实路径
// 携带模型（/v1beta/models/{model}:generateContent），因此 Bridge 在进入透传
// 通道前把路径改写成这个固定值。对外路由仍由 Match 按真实路径分流。
const geminiRelayPath = "/v1beta/models/relaybridge:generateContent"

// GeminiSurface 把 Google Gemini generateContent 入口桥接到 Chat 透传通道。
func GeminiSurface() Surface {
	return geminiSurface{}
}

type geminiSurface struct{}

func (geminiSurface) ID() string { return "gemini_generate_content" }

// Path 是 relaycore 内部占位路径；真实挂载由路由器按前缀完成。
func (geminiSurface) Path() string { return geminiRelayPath }

// RelayPath 与 Path 相同。
func (geminiSurface) RelayPath() string { return geminiRelayPath }

// Match 只认 generateContent / streamGenerateContent；:countTokens 与模型列表
// 继续交给原 Gemini Handler（本地计数与目录接口不经过透传）。
func (geminiSurface) Match(request *http.Request) bool {
	if request == nil || request.Method != http.MethodPost {
		return false
	}
	target, ok := geminiapi.ParseTarget(request.URL.Path)
	return ok && !target.Count
}

// Decode 不适配路径携带的模型；真实入口走 DecodeRequest。
func (geminiSurface) Decode([]byte) (Decoded, error) {
	return Decoded{}, fmt.Errorf("gemini 模型在路径中，必须使用 DecodeRequest")
}

// DecodeRequest 解析路径模型与请求体，产出 Chat 请求与 Canonical 渲染请求。
func (geminiSurface) DecodeRequest(request *http.Request, body []byte) (Decoded, error) {
	target, ok := geminiapi.ParseTarget(request.URL.Path)
	if !ok || target.Count {
		return Decoded{}, fmt.Errorf("gemini 推理路径无效")
	}
	stream := target.Stream || strings.EqualFold(request.URL.Query().Get("alt"), "sse")
	adapter, err := gemini.NewAdapter(time.Now)
	if err != nil {
		return Decoded{}, err
	}
	canonical, err := adapter.DecodeWithModel(target.Model, body, stream)
	if err != nil {
		return Decoded{}, err
	}
	chat, err := geminiToChat(body, target.Model, stream)
	if err != nil {
		return Decoded{}, err
	}
	return Decoded{Chat: chat, Request: canonical, Stream: stream}, nil
}

func (geminiSurface) NewRenderer(request inference.Request) (clientprotocol.StreamRenderer, error) {
	adapter, err := gemini.NewAdapter(time.Now)
	if err != nil {
		return nil, err
	}
	return adapter.NewStreamRenderer(request), nil
}

func (geminiSurface) NewAggregator(request inference.Request) clientprotocol.ResponseAggregator {
	adapter, _ := gemini.NewAdapter(time.Now)
	return adapter.NewResponseAggregator(request)
}

func (geminiSurface) ErrorBody(status int, code string, message string) []byte {
	payload, _ := json.Marshal(map[string]any{
		"error": map[string]any{
			"code":    status,
			"message": message,
			"status":  geminiErrorStatus(status),
		},
	})
	return payload
}

func (geminiSurface) ErrorEvent(status int, code string, message string) (clientprotocol.RenderedEvent, bool) {
	frame, err := clientprotocol.NewDataEvent(geminiSurface{}.ErrorBody(status, code, message))
	return frame, err == nil
}

// geminiErrorStatus 把 HTTP 状态映射为 Google API 的 status 词表。
func geminiErrorStatus(status int) string {
	switch status {
	case http.StatusBadRequest, http.StatusRequestEntityTooLarge:
		return "INVALID_ARGUMENT"
	case http.StatusUnauthorized:
		return "UNAUTHENTICATED"
	case http.StatusForbidden:
		return "PERMISSION_DENIED"
	case http.StatusNotFound:
		return "NOT_FOUND"
	case http.StatusTooManyRequests:
		return "RESOURCE_EXHAUSTED"
	case http.StatusServiceUnavailable, http.StatusBadGateway, 529:
		return "UNAVAILABLE"
	default:
		return "INTERNAL"
	}
}

// Gemini 请求中桥接需要读取的字段。
type geminiChatRequest struct {
	Contents          []geminiChatContent     `json:"contents"`
	SystemInstruction *geminiChatContent      `json:"systemInstruction"`
	Tools             []geminiChatToolGroup   `json:"tools"`
	ToolConfig        *geminiChatToolConfig   `json:"toolConfig"`
	GenerationConfig  *geminiGenerationConfig `json:"generationConfig"`
}

type geminiChatContent struct {
	Role  string           `json:"role"`
	Parts []geminiChatPart `json:"parts"`
}

type geminiChatPart struct {
	Text             *string                 `json:"text"`
	Thought          bool                    `json:"thought"`
	InlineData       *geminiInlineData       `json:"inlineData"`
	FileData         *geminiFileData         `json:"fileData"`
	FunctionCall     *geminiFunctionCall     `json:"functionCall"`
	FunctionResponse *geminiFunctionResponse `json:"functionResponse"`
}

type geminiInlineData struct {
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
}

type geminiFileData struct {
	MimeType string `json:"mimeType"`
	FileURI  string `json:"fileUri"`
}

type geminiFunctionCall struct {
	ID   string          `json:"id"`
	Name string          `json:"name"`
	Args json.RawMessage `json:"args"`
}

type geminiFunctionResponse struct {
	ID       string          `json:"id"`
	Name     string          `json:"name"`
	Response json.RawMessage `json:"response"`
}

type geminiChatToolGroup struct {
	FunctionDeclarations []geminiFunctionDeclaration `json:"functionDeclarations"`
}

type geminiFunctionDeclaration struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

type geminiChatToolConfig struct {
	FunctionCallingConfig *geminiFunctionCallingConfig `json:"functionCallingConfig"`
}

type geminiFunctionCallingConfig struct {
	Mode                 string   `json:"mode"`
	AllowedFunctionNames []string `json:"allowedFunctionNames"`
}

type geminiGenerationConfig struct {
	Temperature     *float64 `json:"temperature"`
	TopP            *float64 `json:"topP"`
	TopK            *uint64  `json:"topK"`
	MaxOutputTokens *uint64  `json:"maxOutputTokens"`
	StopSequences   []string `json:"stopSequences"`
	CandidateCount  *uint64  `json:"candidateCount"`
}

// geminiToChat 把 Gemini generateContent 请求转换为 OpenAI Chat 请求。
func geminiToChat(body []byte, model string, stream bool) ([]byte, error) {
	var request geminiChatRequest
	if err := json.Unmarshal(body, &request); err != nil {
		return nil, err
	}
	out := chatRequestWire{
		Model:  strings.TrimSpace(model),
		Stream: stream,
	}
	if request.SystemInstruction != nil {
		if system := geminiContentText(*request.SystemInstruction); system != "" {
			out.Messages = append(out.Messages, chatRequestMessage{Role: "system", Content: system})
		}
	}
	for contentIndex, content := range request.Contents {
		messages, err := geminiContentToChat(content, contentIndex)
		if err != nil {
			return nil, err
		}
		out.Messages = append(out.Messages, messages...)
	}
	if config := request.GenerationConfig; config != nil {
		if config.MaxOutputTokens != nil && *config.MaxOutputTokens > 0 {
			value := int(*config.MaxOutputTokens)
			out.MaxTokens = &value
		}
		out.Temperature = config.Temperature
		out.TopP = config.TopP
		if len(config.StopSequences) > 0 {
			out.Stop = append([]string(nil), config.StopSequences...)
		}
	}
	if tools := geminiToolsToChat(request.Tools); len(tools) > 0 {
		out.Tools = tools
	}
	if choice := geminiToolChoice(request.ToolConfig); choice != nil {
		out.ToolChoice = choice
	}
	return json.Marshal(out)
}

func geminiContentText(content geminiChatContent) string {
	parts := make([]string, 0, len(content.Parts))
	for _, part := range content.Parts {
		if part.Text != nil && *part.Text != "" && !part.Thought {
			parts = append(parts, *part.Text)
		}
	}
	return strings.Join(parts, "\n")
}

// geminiContentToChat 把一轮 contents 转成 Chat 消息；functionResponse 单独成
// role:"tool"，与 assistant 的 tool_calls 一一对应。
func geminiContentToChat(content geminiChatContent, contentIndex int) ([]chatRequestMessage, error) {
	role := strings.ToLower(strings.TrimSpace(content.Role))
	if role == "model" || role == "assistant" {
		return geminiAssistantContent(content, contentIndex)
	}
	return geminiUserContent(content, contentIndex)
}

func geminiAssistantContent(content geminiChatContent, contentIndex int) ([]chatRequestMessage, error) {
	var text strings.Builder
	var reasoning strings.Builder
	var calls []chatRequestToolCall
	for partIndex, part := range content.Parts {
		switch {
		case part.FunctionCall != nil:
			name := strings.TrimSpace(part.FunctionCall.Name)
			if name == "" {
				continue
			}
			callID := strings.TrimSpace(part.FunctionCall.ID)
			if callID == "" {
				callID = fmt.Sprintf("call_%d_%d", contentIndex+1, partIndex+1)
			}
			arguments := "{}"
			if len(part.FunctionCall.Args) > 0 && string(part.FunctionCall.Args) != "null" {
				arguments = string(part.FunctionCall.Args)
			}
			calls = append(calls, chatRequestToolCall{
				ID:       callID,
				Type:     "function",
				Function: chatRequestFunction{Name: name, Arguments: arguments},
			})
		case part.Text != nil:
			if part.Thought {
				reasoning.WriteString(*part.Text)
			} else {
				text.WriteString(*part.Text)
			}
		}
	}
	if text.Len() == 0 && len(calls) == 0 {
		return nil, nil
	}
	message := chatRequestMessage{Role: "assistant", Content: text.String()}
	if reasoning.Len() > 0 {
		message.ReasoningContent = reasoning.String()
	}
	if len(calls) > 0 {
		message.ToolCalls = calls
	}
	return []chatRequestMessage{message}, nil
}

func geminiUserContent(content geminiChatContent, contentIndex int) ([]chatRequestMessage, error) {
	var messages []chatRequestMessage
	var parts []any
	var text strings.Builder
	hasImage := false
	flush := func() {
		if len(parts) == 0 && text.Len() == 0 {
			return
		}
		var payload any = text.String()
		if hasImage {
			contentParts := make([]any, 0, len(parts)+1)
			if text.Len() > 0 {
				contentParts = append(contentParts, map[string]any{"type": "text", "text": text.String()})
			}
			contentParts = append(contentParts, parts...)
			payload = contentParts
		}
		messages = append(messages, chatRequestMessage{Role: "user", Content: payload})
		parts = nil
		text.Reset()
		hasImage = false
	}
	for _, part := range content.Parts {
		switch {
		case part.FunctionResponse != nil:
			flush()
			callID := strings.TrimSpace(part.FunctionResponse.ID)
			if callID == "" {
				callID = strings.TrimSpace(part.FunctionResponse.Name)
			}
			messages = append(messages, chatRequestMessage{
				Role:       "tool",
				ToolCallID: callID,
				Content:    functionResponseText(part.FunctionResponse.Response),
			})
		case part.InlineData != nil:
			if url := geminiInlineDataURL(part.InlineData); url != "" {
				parts = append(parts, map[string]any{
					"type":      "image_url",
					"image_url": map[string]any{"url": url},
				})
				hasImage = true
			}
		case part.FileData != nil:
			if url := strings.TrimSpace(part.FileData.FileURI); url != "" {
				parts = append(parts, map[string]any{
					"type":      "image_url",
					"image_url": map[string]any{"url": url},
				})
				hasImage = true
			}
		case part.Text != nil && *part.Text != "":
			text.WriteString(*part.Text)
		}
	}
	flush()
	return messages, nil
}

func geminiInlineDataURL(data *geminiInlineData) string {
	if data == nil || strings.TrimSpace(data.Data) == "" {
		return ""
	}
	mimeType := strings.TrimSpace(data.MimeType)
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	return "data:" + mimeType + ";base64," + strings.TrimSpace(data.Data)
}

func functionResponseText(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return ""
	}
	if strings.HasPrefix(trimmed, `"`) {
		var text string
		if json.Unmarshal(raw, &text) == nil {
			return text
		}
	}
	return trimmed
}

func geminiToolsToChat(groups []geminiChatToolGroup) []chatRequestTool {
	out := make([]chatRequestTool, 0, len(groups))
	for _, group := range groups {
		for _, declaration := range group.FunctionDeclarations {
			name := strings.TrimSpace(declaration.Name)
			if name == "" {
				continue
			}
			parameters := declaration.Parameters
			if !isJSONObjectSchema(parameters) {
				parameters = json.RawMessage(`{"type":"object","properties":{}}`)
			}
			out = append(out, chatRequestTool{
				Type: "function",
				Function: chatRequestToolDetail{
					Name:        name,
					Description: declaration.Description,
					Parameters:  parameters,
				},
			})
		}
	}
	return out
}

// isJSONObjectSchema 判断工具参数是否是可用的 JSON Schema 对象。
func isJSONObjectSchema(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	if !strings.HasPrefix(trimmed, "{") {
		return false
	}
	var object map[string]any
	return json.Unmarshal([]byte(trimmed), &object) == nil
}

func geminiToolChoice(config *geminiChatToolConfig) any {
	if config == nil || config.FunctionCallingConfig == nil {
		return nil
	}
	calling := config.FunctionCallingConfig
	switch strings.ToUpper(strings.TrimSpace(calling.Mode)) {
	case "NONE":
		return "none"
	case "ANY":
		names := calling.AllowedFunctionNames
		if len(names) == 1 && strings.TrimSpace(names[0]) != "" {
			return map[string]any{
				"type":     "function",
				"function": map[string]any{"name": strings.TrimSpace(names[0])},
			}
		}
		return "required"
	case "AUTO":
		return "auto"
	default:
		return nil
	}
}
