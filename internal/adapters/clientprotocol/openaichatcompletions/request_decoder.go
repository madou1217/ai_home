package openaichatcompletions

import (
	"github.com/madou1217/ai_home/core/inference"
)

// RequestDecoder 将 Chat Completions 请求转换为 Canonical Request。
type RequestDecoder struct{}

// NewRequestDecoder 创建无状态、可并发复用的 Chat Request Decoder。
func NewRequestDecoder() RequestDecoder {
	return RequestDecoder{}
}

// Decode 严格解析一个完整 Chat Completions JSON 请求。
func (RequestDecoder) Decode(body []byte) (inference.Request, error) {
	wireRequest, err := decodeStrict[requestDTO](body, "$")
	if err != nil {
		return inference.Request{}, err
	}
	if err := validateSupportedRootFields(wireRequest); err != nil {
		return inference.Request{}, err
	}
	messages, err := decodeMessages(wireRequest.Messages)
	if err != nil {
		return inference.Request{}, err
	}
	tools, err := decodeTools(wireRequest.Tools)
	if err != nil {
		return inference.Request{}, err
	}
	toolChoice, err := decodeToolChoice(wireRequest.ToolChoice)
	if err != nil {
		return inference.Request{}, err
	}
	reasoning, err := decodeReasoningEffort(wireRequest.ReasoningEffort)
	if err != nil {
		return inference.Request{}, err
	}
	structuredOutput, err := decodeResponseFormat(wireRequest.ResponseFormat)
	if err != nil {
		return inference.Request{}, err
	}
	stopSequences, err := decodeStopSequences(wireRequest.Stop)
	if err != nil {
		return inference.Request{}, err
	}
	includeUsage, err := decodeStreamUsage(wireRequest.StreamOptions, wireRequest.Stream)
	if err != nil {
		return inference.Request{}, err
	}

	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol:       inference.ClientProtocolOpenAIChatCompletions,
		Model:                wireRequest.Model,
		Messages:             messages,
		Tools:                tools,
		ToolChoice:           toolChoice,
		ParallelToolCalls:    wireRequest.ParallelToolCalls,
		Reasoning:            reasoning,
		StructuredOutput:     structuredOutput,
		Stream:               wireRequest.Stream,
		IncludeUsageInStream: includeUsage,
		MaxOutputTokens:      maxOutputTokens(wireRequest),
		Temperature:          wireRequest.Temperature,
		TopP:                 wireRequest.TopP,
		UserID:               wireRequest.User,
		StopSequences:        stopSequences,
		Store:                wireRequest.Store,
	})
	if err != nil {
		return inference.Request{}, invalidField("$")
	}
	return request, nil
}
