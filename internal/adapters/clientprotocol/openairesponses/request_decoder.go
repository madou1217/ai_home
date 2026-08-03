package openairesponses

import (
	"encoding/json"

	"github.com/madou1217/ai_home/core/inference"
)

// RequestDecoder 将 OpenAI Responses 请求 DTO 转换为 Canonical Request。
type RequestDecoder struct{}

// NewRequestDecoder 创建无状态、可并发复用的 Responses Request Decoder。
func NewRequestDecoder() RequestDecoder {
	return RequestDecoder{}
}

// Decode 严格解析一个完整 Responses JSON 请求。
func (RequestDecoder) Decode(body []byte) (inference.Request, error) {
	wireRequest, err := decodeStrict[requestDTO](body, "$")
	if err != nil {
		return inference.Request{}, err
	}
	if err := validateSupportedRootFields(wireRequest); err != nil {
		return inference.Request{}, err
	}

	messages, decodedInput, err := decodeRequestMessages(wireRequest)
	if err != nil {
		return inference.Request{}, err
	}
	tools, webSearch, err := decodeTools(wireRequest.Tools)
	if err != nil {
		return inference.Request{}, err
	}
	toolChoice, err := decodeToolChoice(wireRequest.ToolChoice)
	if err != nil {
		return inference.Request{}, err
	}
	reasoning, err := decodeReasoning(wireRequest.Reasoning)
	if err != nil {
		return inference.Request{}, err
	}
	structuredOutput, err := decodeTextConfig(wireRequest.Text)
	if err != nil {
		return inference.Request{}, err
	}
	continuation, err := decodeContinuation(wireRequest)
	if err != nil {
		return inference.Request{}, err
	}
	includeEncryptedReasoning, err := decodeIncludes(wireRequest.Include)
	if err != nil {
		return inference.Request{}, err
	}
	truncation, err := decodeTruncation(wireRequest.Truncation)
	if err != nil {
		return inference.Request{}, err
	}

	externalCallIDs := decodedInput.externalToolCallIDs(continuation != nil)
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol:            inference.ClientProtocolOpenAIResponses,
		Model:                     wireRequest.Model,
		Messages:                  messages,
		Tools:                     tools,
		WebSearch:                 webSearch,
		ToolChoice:                toolChoice,
		ParallelToolCalls:         wireRequest.ParallelToolCalls,
		Reasoning:                 reasoning,
		StructuredOutput:          structuredOutput,
		Stream:                    wireRequest.Stream,
		MaxOutputTokens:           valueOrZero(wireRequest.MaxOutputTokens),
		Temperature:               wireRequest.Temperature,
		TopP:                      wireRequest.TopP,
		PromptCacheKey:            wireRequest.PromptCacheKey,
		ClientMetadata:            wireRequest.ClientMetadata,
		Store:                     wireRequest.Store,
		IncludeEncryptedReasoning: includeEncryptedReasoning,
		Truncation:                truncation,
		Continuation:              continuation,
		ExternalToolCallIDs:       externalCallIDs,
	})
	if err != nil {
		return inference.Request{}, invalidField("$")
	}
	return request, nil
}

// decodeRequestMessages 合并 instructions 和 input，同时保留输入工具配对证据。
func decodeRequestMessages(
	wireRequest requestDTO,
) ([]inference.Message, decodedInput, error) {
	instructions, err := decodeInstructions(wireRequest.Instructions)
	if err != nil {
		return nil, decodedInput{}, err
	}
	input, err := decodeInput(wireRequest.Input)
	if err != nil {
		return nil, decodedInput{}, err
	}
	messages := make([]inference.Message, 0, len(instructions)+len(input.messages))
	messages = append(messages, instructions...)
	messages = append(messages, input.messages...)
	return messages, input, nil
}

// decodeInstructions 支持字符串形式的 Responses instructions。
func decodeInstructions(raw json.RawMessage) ([]inference.Message, error) {
	if !hasJSONValue(raw) {
		return nil, nil
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return nil, unsupportedField("instructions")
	}
	content, err := inference.NewTextContent(text)
	if err != nil {
		return nil, invalidField("instructions")
	}
	message, err := inference.NewMessage(inference.RoleDeveloper, content)
	if err != nil {
		return nil, invalidField("instructions")
	}
	return []inference.Message{message}, nil
}

// validateSupportedRootFields 拒绝尚未建立共同 Canonical 语义的字段。
func validateSupportedRootFields(wireRequest requestDTO) error {
	if wireRequest.Background != nil && *wireRequest.Background {
		return unsupportedField("background")
	}
	switch {
	case hasJSONValue(wireRequest.ContextManagement):
		return unsupportedField("context_management")
	case hasJSONValue(wireRequest.PromptCacheOptions):
		return unsupportedField("prompt_cache_options")
	case wireRequest.PromptCacheRetention != nil:
		return unsupportedField("prompt_cache_retention")
	case hasJSONValue(wireRequest.Metadata):
		return unsupportedField("metadata")
	case wireRequest.ServiceTier != nil:
		return unsupportedField("service_tier")
	case wireRequest.SafetyIdentifier != nil:
		return unsupportedField("safety_identifier")
	case wireRequest.TopLogprobs != nil:
		return unsupportedField("top_logprobs")
	case wireRequest.MaxToolCalls != nil:
		return unsupportedField("max_tool_calls")
	case wireRequest.MaxOutputTokens != nil && *wireRequest.MaxOutputTokens == 0:
		return invalidField("max_output_tokens")
	default:
		return nil
	}
}

// valueOrZero 将可选 uint64 转为 Canonical Request 使用的零值缺省表示。
func valueOrZero(value *uint64) uint64 {
	if value == nil {
		return 0
	}
	return *value
}
