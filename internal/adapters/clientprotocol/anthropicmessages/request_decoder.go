package anthropicmessages

import (
	"github.com/madou1217/ai_home/core/inference"
)

// RequestDecoder 将 Anthropic Messages 请求 DTO 转换为 Canonical Request。
type RequestDecoder struct{}

// NewRequestDecoder 创建无状态、可并发复用的 Messages Request Decoder。
func NewRequestDecoder() RequestDecoder {
	return RequestDecoder{}
}

// Decode 严格解析一个完整 Messages create JSON 请求。
func (RequestDecoder) Decode(body []byte) (inference.Request, error) {
	wireRequest, err := decodeStrict[requestDTO](body, "$")
	if err != nil {
		return inference.Request{}, err
	}
	if err := validateRootFields(wireRequest); err != nil {
		return inference.Request{}, err
	}

	systemMessages, systemCacheBreakpoints, err := decodeSystem(wireRequest.System)
	if err != nil {
		return inference.Request{}, err
	}
	conversation, conversationCacheBreakpoints, err := decodeMessages(
		wireRequest.Messages,
		uint32(len(systemMessages)),
	)
	if err != nil {
		return inference.Request{}, err
	}
	messages := make([]inference.Message, 0, len(systemMessages)+len(conversation))
	messages = append(messages, systemMessages...)
	messages = append(messages, conversation...)

	tools, toolCacheBreakpoints, err := decodeTools(wireRequest.Tools)
	if err != nil {
		return inference.Request{}, err
	}
	toolChoice, parallelToolCalls, err := decodeToolChoice(wireRequest.ToolChoice)
	if err != nil {
		return inference.Request{}, err
	}
	structuredOutput, effort, err := decodeOutputConfig(wireRequest.OutputConfig)
	if err != nil {
		return inference.Request{}, err
	}
	reasoning, err := decodeReasoning(
		wireRequest.Thinking,
		effort,
		*wireRequest.MaxTokens,
	)
	if err != nil {
		return inference.Request{}, err
	}
	userID, err := decodeMetadata(wireRequest.Metadata)
	if err != nil {
		return inference.Request{}, err
	}
	cacheBreakpoints := make(
		[]inference.PromptCacheBreakpoint,
		0,
		len(systemCacheBreakpoints)+
			len(conversationCacheBreakpoints)+
			len(toolCacheBreakpoints)+1,
	)
	cacheBreakpoints = append(cacheBreakpoints, systemCacheBreakpoints...)
	cacheBreakpoints = append(cacheBreakpoints, conversationCacheBreakpoints...)
	cacheBreakpoints = append(cacheBreakpoints, toolCacheBreakpoints...)
	requestCacheControl, err := decodePromptCacheControl(
		wireRequest.CacheControl,
		"cache_control",
	)
	if err != nil {
		return inference.Request{}, err
	}
	if requestCacheControl != nil {
		breakpoint, breakpointErr := inference.NewRequestPromptCacheBreakpoint(
			*requestCacheControl,
		)
		if breakpointErr != nil {
			return inference.Request{}, invalidField("cache_control")
		}
		cacheBreakpoints = append(cacheBreakpoints, breakpoint)
	}

	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol:         inference.ClientProtocolAnthropicMessages,
		Model:                  wireRequest.Model,
		Messages:               messages,
		Tools:                  tools,
		ToolChoice:             toolChoice,
		ParallelToolCalls:      parallelToolCalls,
		Reasoning:              reasoning,
		StructuredOutput:       structuredOutput,
		Stream:                 wireRequest.Stream,
		MaxOutputTokens:        *wireRequest.MaxTokens,
		Temperature:            wireRequest.Temperature,
		TopP:                   wireRequest.TopP,
		TopK:                   wireRequest.TopK,
		UserID:                 userID,
		PromptCacheBreakpoints: cacheBreakpoints,
		StopSequences:          wireRequest.StopSequences,
	})
	if err != nil {
		return inference.Request{}, invalidField("$")
	}
	return request, nil
}

// validateRootFields 拒绝无效取值和尚无无损 Canonical 语义的功能。
func validateRootFields(wireRequest requestDTO) error {
	switch {
	case wireRequest.MaxTokens == nil || *wireRequest.MaxTokens == 0:
		return invalidField("max_tokens")
	case wireRequest.Temperature != nil &&
		(*wireRequest.Temperature < 0 || *wireRequest.Temperature > 1):
		return invalidField("temperature")
	case wireRequest.TopK != nil && *wireRequest.TopK == 0:
		return invalidField("top_k")
	case wireRequest.ServiceTier != nil:
		return unsupportedField("service_tier")
	case hasJSONValue(wireRequest.Container):
		return unsupportedField("container")
	case hasJSONValue(wireRequest.InferenceGeo):
		return unsupportedField("inference_geo")
	default:
		return nil
	}
}

// decodeMetadata 只保留 Anthropic 公开的低敏 user_id。
func decodeMetadata(raw []byte) (*string, error) {
	if !hasJSONValue(raw) {
		return nil, nil
	}
	wireMetadata, err := decodeStrict[metadataDTO](raw, "metadata")
	if err != nil {
		return nil, err
	}
	return wireMetadata.UserID, nil
}
