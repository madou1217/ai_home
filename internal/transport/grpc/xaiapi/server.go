package xaiapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// Options 是 xAI gRPC 兼容层的依赖。
type Options struct {
	// HTTPBaseURL 是本机 aih-server 的 HTTP 根地址，例如 http://127.0.0.1:9527。
	// gRPC 层只做协议翻译，账号、模型路由和错误策略仍由 HTTP 网关统一执行。
	HTTPBaseURL string
	// ClientKey 是 gRPC 调用未携带 authorization metadata 时的兜底客户端 Key。
	ClientKey func() string
	// HTTPClient 为空时使用默认 http.Client（本机回环请求）。
	HTTPClient *http.Client
}

// Server 实现 xai_api.Chat 的 gRPC 子集，并桥接到本机 OpenAI Chat 入口。
type Server struct {
	UnimplementedChatServer
	UnimplementedModelsServer
	chatURL    string
	modelsURL  string
	clientKey  func() string
	httpClient *http.Client
}

// NewServer 创建 xAI gRPC 兼容层。
func NewServer(options Options) (*Server, error) {
	base := strings.TrimRight(strings.TrimSpace(options.HTTPBaseURL), "/")
	if base == "" {
		return nil, errors.New("xai grpc: empty HTTP base URL")
	}
	if !strings.HasSuffix(base, "/v1") {
		base += "/v1"
	}
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{}
	}
	return &Server{
		chatURL:    base + "/chat/completions",
		modelsURL:  base + "/models",
		clientKey:  options.ClientKey,
		httpClient: client,
	}, nil
}

// Register 把兼容层注册到 grpc.Server。
func Register(server *grpc.Server, compatibility *Server) {
	RegisterChatServer(server, compatibility)
	RegisterModelsServer(server, compatibility)
}

// ListLanguageModels 把 xAI Models 列表桥接到本机 /v1/models。
func (server *Server) ListLanguageModels(
	ctx context.Context,
	_ *emptypb.Empty,
) (*ListLanguageModelsResponse, error) {
	var response openAIModelList
	if err := server.getJSON(ctx, server.modelsURL, &response); err != nil {
		return nil, err
	}
	result := &ListLanguageModelsResponse{
		Models: make([]*LanguageModel, 0, len(response.Data)),
	}
	for _, item := range response.Data {
		result.Models = append(result.Models, toLanguageModel(item))
	}
	return result, nil
}

// GetLanguageModel 把 xAI 单模型查询桥接到本机 /v1/models/{name}。
func (server *Server) GetLanguageModel(
	ctx context.Context,
	request *GetModelRequest,
) (*LanguageModel, error) {
	name := strings.TrimSpace(request.GetName())
	if name == "" {
		return nil, status.Error(codes.InvalidArgument, "model name is required")
	}
	var item openAIModel
	if err := server.getJSON(ctx, server.modelsURL+"/"+url.PathEscape(name), &item); err != nil {
		return nil, err
	}
	return toLanguageModel(item), nil
}

// ListEmbeddingModels 返回空集：当前 Gateway 不提供 embedding 入口。
func (server *Server) ListEmbeddingModels(
	context.Context,
	*emptypb.Empty,
) (*ListEmbeddingModelsResponse, error) {
	return &ListEmbeddingModelsResponse{}, nil
}

func (server *Server) GetEmbeddingModel(
	context.Context,
	*GetModelRequest,
) (*EmbeddingModel, error) {
	return nil, status.Error(codes.NotFound, "embedding model is not available")
}

// ListImageGenerationModels 返回空集：图像生成走 HTTP /v1/images/*，不走该目录。
func (server *Server) ListImageGenerationModels(
	context.Context,
	*emptypb.Empty,
) (*ListImageGenerationModelsResponse, error) {
	return &ListImageGenerationModelsResponse{}, nil
}

func (server *Server) GetImageGenerationModel(
	context.Context,
	*GetModelRequest,
) (*ImageGenerationModel, error) {
	return nil, status.Error(codes.NotFound, "image generation model is not available")
}

func (server *Server) getJSON(ctx context.Context, target string, out any) error {
	authorization, err := server.authorization(ctx)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return status.Error(codes.Internal, "cannot build gateway request")
	}
	request.Header.Set("Authorization", authorization)
	response, err := server.httpClient.Do(request)
	if err != nil {
		return status.Error(codes.Unavailable, "aih gateway is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		return gatewayStatus(response.StatusCode, body)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 16<<20)).Decode(out); err != nil {
		return status.Error(codes.Internal, "invalid gateway response")
	}
	return nil
}

func toLanguageModel(item openAIModel) *LanguageModel {
	model := &LanguageModel{
		Name: item.ID,
	}
	if item.Created > 0 {
		model.Created = timestamppb.New(time.Unix(item.Created, 0))
	}
	return model
}

// GetCompletion 把 xAI 非流式 Chat 请求桥接到 /v1/chat/completions。
func (server *Server) GetCompletion(
	ctx context.Context,
	request *GetCompletionsRequest,
) (*GetChatCompletionResponse, error) {
	payload, err := server.encodeRequest(request, false)
	if err != nil {
		return nil, err
	}
	response, err := server.do(ctx, payload)
	if err != nil {
		return nil, err
	}
	return toChatCompletionResponse(response, request.GetModel()), nil
}

// GetCompletionChunk 把 xAI 流式 Chat 请求桥接到 SSE，并逐块翻译。
func (server *Server) GetCompletionChunk(
	request *GetCompletionsRequest,
	stream grpc.ServerStreamingServer[GetChatCompletionChunk],
) error {
	payload, err := server.encodeRequest(request, true)
	if err != nil {
		return err
	}
	ctx := stream.Context()
	httpRequest, err := server.newHTTPRequest(ctx, payload)
	if err != nil {
		return err
	}
	response, err := server.httpClient.Do(httpRequest)
	if err != nil {
		return status.Error(codes.Unavailable, "aih gateway is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		return gatewayStatus(response.StatusCode, body)
	}
	return server.relayChunks(stream, response.Body, request.GetModel())
}

func (server *Server) do(ctx context.Context, payload []byte) (*openAIChatResponse, error) {
	request, err := server.newHTTPRequest(ctx, payload)
	if err != nil {
		return nil, err
	}
	response, err := server.httpClient.Do(request)
	if err != nil {
		return nil, status.Error(codes.Unavailable, "aih gateway is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		return nil, gatewayStatus(response.StatusCode, body)
	}
	var decoded openAIChatResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<20)).Decode(&decoded); err != nil {
		return nil, status.Error(codes.Internal, "invalid gateway response")
	}
	return &decoded, nil
}

func (server *Server) newHTTPRequest(ctx context.Context, payload []byte) (*http.Request, error) {
	authorization, err := server.authorization(ctx)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, server.chatURL, bytes.NewReader(payload))
	if err != nil {
		return nil, status.Error(codes.Internal, "cannot build gateway request")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", authorization)
	return request, nil
}

func (server *Server) authorization(ctx context.Context) (string, error) {
	if incoming, ok := metadata.FromIncomingContext(ctx); ok {
		for _, value := range incoming.Get("authorization") {
			value = strings.TrimSpace(value)
			if value == "" {
				continue
			}
			if !strings.HasPrefix(strings.ToLower(value), "bearer ") {
				value = "Bearer " + value
			}
			return value, nil
		}
	}
	if server.clientKey != nil {
		if key := strings.TrimSpace(server.clientKey()); key != "" {
			return "Bearer " + key, nil
		}
	}
	return "", status.Error(codes.Unauthenticated, "missing authorization metadata")
}

func (server *Server) encodeRequest(
	request *GetCompletionsRequest,
	stream bool,
) ([]byte, error) {
	if request == nil || strings.TrimSpace(request.GetModel()) == "" {
		return nil, status.Error(codes.InvalidArgument, "model is required")
	}
	if len(request.GetMessages()) == 0 {
		return nil, status.Error(codes.InvalidArgument, "messages are required")
	}
	wire := openAIChatRequest{
		Model:  request.GetModel(),
		Stream: stream,
	}
	for _, message := range request.GetMessages() {
		encoded, err := encodeMessage(message)
		if err != nil {
			return nil, err
		}
		wire.Messages = append(wire.Messages, encoded)
	}
	if request.GetMaxTokens() > 0 {
		value := int(request.GetMaxTokens())
		wire.MaxTokens = &value
	}
	if request.GetN() > 0 {
		value := int(request.GetN())
		wire.N = &value
	}
	if len(request.GetStop()) > 0 {
		wire.Stop = request.GetStop()
	}
	if request.GetTemperature() != 0 {
		value := float64(request.GetTemperature())
		wire.Temperature = &value
	}
	if request.GetTopP() != 0 {
		value := float64(request.GetTopP())
		wire.TopP = &value
	}
	if request.GetFrequencyPenalty() != 0 {
		value := float64(request.GetFrequencyPenalty())
		wire.FrequencyPenalty = &value
	}
	if request.GetPresencePenalty() != 0 {
		value := float64(request.GetPresencePenalty())
		wire.PresencePenalty = &value
	}
	if request.GetSeed() != 0 {
		value := int(request.GetSeed())
		wire.Seed = &value
	}
	if value := strings.TrimSpace(request.GetUser()); value != "" {
		wire.User = value
	}
	if request.GetParallelToolCalls() {
		wire.ParallelToolCalls = boolPointer(true)
	}
	if effort := reasoningEffortName(request.GetReasoningEffort()); effort != "" {
		wire.ReasoningEffort = effort
	}
	tools, err := encodeTools(request.GetTools())
	if err != nil {
		return nil, err
	}
	wire.Tools = tools
	if choice := encodeToolChoice(request.GetToolChoice()); choice != nil {
		wire.ToolChoice = choice
	}
	payload, err := json.Marshal(wire)
	if err != nil {
		return nil, status.Error(codes.Internal, "cannot encode gateway request")
	}
	return payload, nil
}

func encodeMessage(message *Message) (openAIMessage, error) {
	if message == nil {
		return openAIMessage{}, status.Error(codes.InvalidArgument, "empty message")
	}
	role := messageRoleName(message.GetRole())
	if role == "" {
		return openAIMessage{}, status.Error(codes.InvalidArgument, "unsupported message role")
	}
	encoded := openAIMessage{Role: role, Name: message.GetName()}
	parts := make([]openAIContentPart, 0, len(message.GetContent()))
	text := strings.Builder{}
	for _, content := range message.GetContent() {
		if content == nil {
			continue
		}
		if value := content.GetText(); value != "" {
			text.WriteString(value)
			continue
		}
		if image := content.GetImageUrl(); image != nil && strings.TrimSpace(image.GetImageUrl()) != "" {
			parts = append(parts, openAIContentPart{
				Type:     "image_url",
				ImageURL: &openAIImageURL{URL: strings.TrimSpace(image.GetImageUrl())},
			})
		}
	}
	if len(parts) == 0 {
		encoded.Content = text.String()
	} else {
		if text.Len() > 0 {
			parts = append([]openAIContentPart{{Type: "text", Text: text.String()}}, parts...)
		}
		encoded.Content = parts
	}
	if toolCallID := strings.TrimSpace(message.GetToolCallId()); toolCallID != "" {
		encoded.ToolCallID = toolCallID
	}
	for _, call := range message.GetToolCalls() {
		if call == nil || call.GetFunction() == nil {
			continue
		}
		encoded.ToolCalls = append(encoded.ToolCalls, openAIToolCall{
			ID:   call.GetId(),
			Type: "function",
			Function: openAIFunctionCall{
				Name:      call.GetFunction().GetName(),
				Arguments: call.GetFunction().GetArguments(),
			},
		})
	}
	return encoded, nil
}

func encodeTools(tools []*Tool) ([]openAITool, error) {
	if len(tools) == 0 {
		return nil, nil
	}
	encoded := make([]openAITool, 0, len(tools))
	for _, tool := range tools {
		if tool == nil || tool.GetFunction() == nil {
			continue
		}
		function := tool.GetFunction()
		parameters := json.RawMessage(function.GetParameters())
		if len(parameters) == 0 {
			parameters = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		if !json.Valid(parameters) {
			return nil, status.Error(codes.InvalidArgument, "tool parameters must be valid JSON")
		}
		encoded = append(encoded, openAITool{
			Type: "function",
			Function: openAIFunction{
				Name:        function.GetName(),
				Description: function.GetDescription(),
				Parameters:  parameters,
				Strict:      function.GetStrict(),
			},
		})
	}
	return encoded, nil
}

func encodeToolChoice(choice *ToolChoice) any {
	if choice == nil {
		return nil
	}
	switch choice.GetMode() {
	case ToolMode_TOOL_MODE_AUTO:
		return "auto"
	case ToolMode_TOOL_MODE_NONE:
		return "none"
	case ToolMode_TOOL_MODE_REQUIRED:
		if name := strings.TrimSpace(choice.GetFunctionName()); name != "" {
			return map[string]any{
				"type":     "function",
				"function": map[string]string{"name": name},
			}
		}
		return "required"
	default:
		return nil
	}
}

func reasoningEffortName(effort ReasoningEffort) string {
	switch effort {
	case ReasoningEffort_EFFORT_LOW:
		return "low"
	case ReasoningEffort_EFFORT_MEDIUM:
		return "medium"
	case ReasoningEffort_EFFORT_HIGH:
		return "high"
	case ReasoningEffort_EFFORT_XHIGH:
		return "xhigh"
	case ReasoningEffort_EFFORT_NONE:
		return "none"
	default:
		return ""
	}
}

func messageRoleName(role MessageRole) string {
	switch role {
	case MessageRole_ROLE_USER:
		return "user"
	case MessageRole_ROLE_ASSISTANT:
		return "assistant"
	case MessageRole_ROLE_SYSTEM, MessageRole_ROLE_DEVELOPER:
		return "system"
	case MessageRole_ROLE_TOOL, MessageRole_ROLE_FUNCTION:
		return "tool"
	default:
		return ""
	}
}

func boolPointer(value bool) *bool { return &value }

func toChatCompletionResponse(
	response *openAIChatResponse,
	fallbackModel string,
) *GetChatCompletionResponse {
	id := strings.TrimSpace(response.ID)
	if id == "" {
		id = fmt.Sprintf("xai-%d", time.Now().UnixNano())
	}
	model := strings.TrimSpace(response.Model)
	if model == "" {
		model = fallbackModel
	}
	created := timestamppb.New(time.Unix(response.Created, 0))
	if response.Created <= 0 {
		created = timestamppb.Now()
	}
	result := &GetChatCompletionResponse{
		Id:      id,
		Created: created,
		Model:   model,
		Usage:   toSamplingUsage(response.Usage),
	}
	for _, choice := range response.Choices {
		result.Outputs = append(result.Outputs, &CompletionOutput{
			FinishReason: finishReason(choice.FinishReason),
			Index:        int32(choice.Index),
			Message: &CompletionMessage{
				Content:          openAIContentText(choice.Message.Content),
				Role:             MessageRole_ROLE_ASSISTANT,
				ToolCalls:        toToolCalls(choice.Message.ToolCalls),
				ReasoningContent: choice.Message.ReasoningContent,
			},
		})
	}
	if len(result.Outputs) == 0 {
		result.Outputs = append(result.Outputs, &CompletionOutput{
			FinishReason: FinishReason_REASON_STOP,
			Message:      &CompletionMessage{Role: MessageRole_ROLE_ASSISTANT},
		})
	}
	return result
}

func (server *Server) relayChunks(
	stream grpc.ServerStreamingServer[GetChatCompletionChunk],
	body io.Reader,
	fallbackModel string,
) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64<<10), 8<<20)
	sentFinish := false
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, ":") {
			continue
		}
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" {
			continue
		}
		if data == "[DONE]" {
			if !sentFinish {
				_ = stream.Send(&GetChatCompletionChunk{
					Id:      fmt.Sprintf("xai-%d", time.Now().UnixNano()),
					Model:   fallbackModel,
					Created: timestamppb.Now(),
					Outputs: []*CompletionOutputChunk{{FinishReason: FinishReason_REASON_STOP}},
				})
			}
			return nil
		}
		var event openAIStreamEvent
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			continue
		}
		chunk := &GetChatCompletionChunk{
			Id:      event.ID,
			Model:   event.Model,
			Created: timestamppb.New(time.Unix(event.Created, 0)),
			Usage:   toSamplingUsage(event.Usage),
		}
		if chunk.Id == "" {
			chunk.Id = fmt.Sprintf("xai-%d", time.Now().UnixNano())
		}
		if chunk.Model == "" {
			chunk.Model = fallbackModel
		}
		if event.Created <= 0 {
			chunk.Created = timestamppb.Now()
		}
		for _, choice := range event.Choices {
			output := &CompletionOutputChunk{
				Index: int32(choice.Index),
				Delta: &Delta{
					Content:          choice.Delta.Content,
					ReasoningContent: choice.Delta.ReasoningContent,
					Role:             MessageRole_ROLE_ASSISTANT,
					ToolCalls:        toToolCalls(choice.Delta.ToolCalls),
				},
			}
			if choice.FinishReason != nil {
				output.FinishReason = finishReason(*choice.FinishReason)
				sentFinish = true
			}
			chunk.Outputs = append(chunk.Outputs, output)
		}
		if len(chunk.Outputs) == 0 && chunk.Usage == nil {
			continue
		}
		if err := stream.Send(chunk); err != nil {
			return err
		}
	}
	if err := scanner.Err(); err != nil {
		return status.Error(codes.Unavailable, "gateway stream interrupted")
	}
	return nil
}

func toSamplingUsage(usage *openAIUsage) *SamplingUsage {
	if usage == nil {
		return nil
	}
	result := &SamplingUsage{
		PromptTokens:     usage.PromptTokens,
		CompletionTokens: usage.CompletionTokens,
		TotalTokens:      usage.TotalTokens,
		ReasoningTokens:  usage.CompletionTokensDetails.ReasoningTokens,
	}
	if result.TotalTokens == 0 {
		result.TotalTokens = result.PromptTokens + result.CompletionTokens
	}
	return result
}

func toToolCalls(calls []openAIToolCall) []*ToolCall {
	if len(calls) == 0 {
		return nil
	}
	result := make([]*ToolCall, 0, len(calls))
	for _, call := range calls {
		result = append(result, &ToolCall{
			Id:     call.ID,
			Type:   ToolCallType_TOOL_CALL_TYPE_CLIENT_SIDE_TOOL,
			Status: ToolCallStatus_TOOL_CALL_STATUS_COMPLETED,
			Function: &FunctionCall{
				Name:      call.Function.Name,
				Arguments: call.Function.Arguments,
			},
		})
	}
	return result
}

func finishReason(value string) FinishReason {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "length":
		return FinishReason_REASON_MAX_LEN
	case "tool_calls", "function_call":
		return FinishReason_REASON_TOOL_CALLS
	case "content_filter":
		return FinishReason_REASON_STOP
	default:
		return FinishReason_REASON_STOP
	}
}

func gatewayStatus(statusCode int, body []byte) error {
	message := gatewayMessage(body)
	switch statusCode {
	case http.StatusUnauthorized:
		return status.Error(codes.Unauthenticated, message)
	case http.StatusForbidden:
		return status.Error(codes.PermissionDenied, message)
	case http.StatusNotFound:
		return status.Error(codes.NotFound, message)
	case http.StatusBadRequest, http.StatusUnprocessableEntity:
		return status.Error(codes.InvalidArgument, message)
	case http.StatusTooManyRequests:
		return status.Error(codes.ResourceExhausted, message)
	case http.StatusServiceUnavailable, http.StatusBadGateway, http.StatusGatewayTimeout:
		return status.Error(codes.Unavailable, message)
	default:
		return status.Error(codes.Internal, message)
	}
}

func gatewayMessage(body []byte) string {
	var payload struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &payload) == nil && strings.TrimSpace(payload.Error.Message) != "" {
		return payload.Error.Message
	}
	text := strings.TrimSpace(string(body))
	if text == "" {
		return "aih gateway request failed"
	}
	if len(text) > 512 {
		text = text[:512]
	}
	return text
}

func openAIContentText(content any) string {
	switch value := content.(type) {
	case string:
		return value
	case []any:
		var builder strings.Builder
		for _, part := range value {
			item, ok := part.(map[string]any)
			if !ok {
				continue
			}
			if text, ok := item["text"].(string); ok {
				builder.WriteString(text)
			}
		}
		return builder.String()
	default:
		return ""
	}
}

// 以下是 OpenAI Chat 线协议的私有投影，仅服务 gRPC 桥接。
type openAIChatRequest struct {
	Model             string          `json:"model"`
	Messages          []openAIMessage `json:"messages"`
	MaxTokens         *int            `json:"max_tokens,omitempty"`
	N                 *int            `json:"n,omitempty"`
	Stop              []string        `json:"stop,omitempty"`
	Temperature       *float64        `json:"temperature,omitempty"`
	TopP              *float64        `json:"top_p,omitempty"`
	FrequencyPenalty  *float64        `json:"frequency_penalty,omitempty"`
	PresencePenalty   *float64        `json:"presence_penalty,omitempty"`
	Seed              *int            `json:"seed,omitempty"`
	User              string          `json:"user,omitempty"`
	Tools             []openAITool    `json:"tools,omitempty"`
	ToolChoice        any             `json:"tool_choice,omitempty"`
	ParallelToolCalls *bool           `json:"parallel_tool_calls,omitempty"`
	ReasoningEffort   string          `json:"reasoning_effort,omitempty"`
	Stream            bool            `json:"stream,omitempty"`
	StreamOptions     any             `json:"stream_options,omitempty"`
}

type openAIMessage struct {
	Role       string           `json:"role"`
	Content    any              `json:"content,omitempty"`
	Name       string           `json:"name,omitempty"`
	ToolCallID string           `json:"tool_call_id,omitempty"`
	ToolCalls  []openAIToolCall `json:"tool_calls,omitempty"`
}

type openAIContentPart struct {
	Type     string          `json:"type"`
	Text     string          `json:"text,omitempty"`
	ImageURL *openAIImageURL `json:"image_url,omitempty"`
}

type openAIImageURL struct {
	URL string `json:"url"`
}

type openAITool struct {
	Type     string         `json:"type"`
	Function openAIFunction `json:"function"`
}

type openAIFunction struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Parameters  json.RawMessage `json:"parameters,omitempty"`
	Strict      bool            `json:"strict,omitempty"`
}

type openAIToolCall struct {
	ID       string             `json:"id"`
	Type     string             `json:"type"`
	Function openAIFunctionCall `json:"function"`
}

type openAIFunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type openAIModelList struct {
	Data []openAIModel `json:"data"`
}

type openAIModel struct {
	ID      string `json:"id"`
	Created int64  `json:"created"`
	OwnedBy string `json:"owned_by"`
}

type openAIChatResponse struct {
	ID      string `json:"id"`
	Created int64  `json:"created"`
	Model   string `json:"model"`
	Choices []struct {
		Index   int `json:"index"`
		Message struct {
			Content          any              `json:"content"`
			Role             string           `json:"role"`
			ReasoningContent string           `json:"reasoning_content"`
			ToolCalls        []openAIToolCall `json:"tool_calls"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *openAIUsage `json:"usage"`
}

type openAIStreamEvent struct {
	ID      string `json:"id"`
	Created int64  `json:"created"`
	Model   string `json:"model"`
	Choices []struct {
		Index int `json:"index"`
		Delta struct {
			Content          string           `json:"content"`
			ReasoningContent string           `json:"reasoning_content"`
			Role             string           `json:"role"`
			ToolCalls        []openAIToolCall `json:"tool_calls"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
	Usage *openAIUsage `json:"usage"`
}

type openAIUsage struct {
	PromptTokens            int64 `json:"prompt_tokens"`
	CompletionTokens        int64 `json:"completion_tokens"`
	TotalTokens             int64 `json:"total_tokens"`
	CompletionTokensDetails struct {
		ReasoningTokens int64 `json:"reasoning_tokens"`
	} `json:"completion_tokens_details"`
}
