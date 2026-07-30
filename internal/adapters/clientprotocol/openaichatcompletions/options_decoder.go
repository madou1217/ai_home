package openaichatcompletions

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/core/inference"
)

// emptyToolParameters 表示未声明参数的零参数函数工具 Schema。
var emptyToolParameters = json.RawMessage(`{}`)

// decodeTools 只接受可由 Codex 和 Claude 上游 Adapter 显式映射的函数工具。
func decodeTools(rawTools []json.RawMessage) ([]inference.ToolDefinition, error) {
	tools := make([]inference.ToolDefinition, len(rawTools))
	for index, rawTool := range rawTools {
		field := fmt.Sprintf("tools[%d]", index)
		wireTool, err := decodeStrict[functionToolDTO](rawTool, field)
		if err != nil {
			return nil, err
		}
		if wireTool.Type != "function" {
			return nil, unsupportedField(field + ".type")
		}
		parameters := wireTool.Function.Parameters
		if !hasJSONValue(parameters) {
			parameters = emptyToolParameters
		}
		var tool inference.ToolDefinition
		if wireTool.Function.Strict == nil {
			tool, err = inference.NewToolDefinition(
				wireTool.Function.Name,
				wireTool.Function.Description,
				parameters,
			)
		} else {
			tool, err = inference.NewToolDefinitionWithStrict(
				wireTool.Function.Name,
				wireTool.Function.Description,
				parameters,
				*wireTool.Function.Strict,
			)
		}
		if err != nil {
			return nil, invalidField(field)
		}
		tools[index] = tool
	}
	return tools, nil
}

// decodeToolChoice 解析字符串模式或明确命名的函数工具。
func decodeToolChoice(raw json.RawMessage) (*inference.ToolChoice, error) {
	if !hasJSONValue(raw) {
		return nil, nil
	}
	if strings.HasPrefix(strings.TrimSpace(string(raw)), `"`) {
		var mode string
		if json.Unmarshal(raw, &mode) != nil {
			return nil, invalidField("tool_choice")
		}
		choice, err := inference.NewToolChoice(inference.ToolChoiceMode(mode))
		if err != nil {
			return nil, invalidField("tool_choice")
		}
		return &choice, nil
	}
	wireChoice, err := decodeStrict[toolChoiceObjectDTO](raw, "tool_choice")
	if err != nil {
		return nil, err
	}
	if wireChoice.Type != "function" {
		return nil, unsupportedField("tool_choice.type")
	}
	choice, err := inference.NewNamedToolChoice(wireChoice.Function.Name)
	if err != nil {
		return nil, invalidField("tool_choice")
	}
	return &choice, nil
}

// decodeReasoningEffort 把 Chat 抽象强度映射为 Canonical reasoning 配置。
func decodeReasoningEffort(value *string) (*inference.ReasoningConfig, error) {
	if value == nil {
		return nil, nil
	}
	config, err := inference.NewEffortReasoning(
		inference.ReasoningEffort(*value),
		"",
	)
	if err != nil {
		return nil, invalidField("reasoning_effort")
	}
	return &config, nil
}

// decodeResponseFormat 解析默认文本或命名 JSON Schema 输出合同。
func decodeResponseFormat(
	raw json.RawMessage,
) (*inference.StructuredOutput, error) {
	if !hasJSONValue(raw) {
		return nil, nil
	}
	header, err := decodeHeader[responseFormatHeaderDTO](raw, "response_format")
	if err != nil {
		return nil, err
	}
	switch header.Type {
	case "text":
		wireFormat, err := decodeStrict[textResponseFormatDTO](raw, "response_format")
		if err != nil || wireFormat.Type != "text" {
			return nil, invalidField("response_format")
		}
		return nil, nil
	case "json_schema":
		wireFormat, err := decodeStrict[structuredResponseFormatDTO](
			raw,
			"response_format",
		)
		if err != nil {
			return nil, err
		}
		strict := false
		if wireFormat.JSONSchema.Strict != nil {
			strict = *wireFormat.JSONSchema.Strict
		}
		output, err := inference.NewStructuredOutput(
			wireFormat.JSONSchema.Name,
			wireFormat.JSONSchema.Description,
			wireFormat.JSONSchema.Schema,
			strict,
		)
		if err != nil {
			return nil, invalidField("response_format")
		}
		return &output, nil
	case "json_object":
		return nil, unsupportedField("response_format.type")
	default:
		return nil, invalidField("response_format.type")
	}
}

// decodeStopSequences 解析字符串或字符串数组形式的停止序列。
func decodeStopSequences(raw json.RawMessage) ([]string, error) {
	if !hasJSONValue(raw) {
		return nil, nil
	}
	if text, ok := decodeJSONString(raw); ok {
		return []string{text}, nil
	}
	var sequences []string
	if json.Unmarshal(raw, &sequences) != nil {
		return nil, invalidField("stop")
	}
	return sequences, nil
}

// decodeStreamUsage 解析流结束前是否需要独立 usage 尾块。
func decodeStreamUsage(
	raw json.RawMessage,
	stream bool,
) (bool, error) {
	if !hasJSONValue(raw) {
		return false, nil
	}
	options, err := decodeStrict[streamOptionsDTO](raw, "stream_options")
	if err != nil {
		return false, err
	}
	if !stream {
		return false, invalidField("stream_options")
	}
	return options.IncludeUsage != nil && *options.IncludeUsage, nil
}

// validateSupportedRootFields 拒绝当前无法无损进入 Canonical Contract 的选项。
func validateSupportedRootFields(wireRequest requestDTO) error {
	switch {
	case wireRequest.MaxCompletionTokens != nil && wireRequest.MaxTokens != nil:
		return invalidField("max_completion_tokens")
	case wireRequest.MaxCompletionTokens != nil && *wireRequest.MaxCompletionTokens == 0:
		return invalidField("max_completion_tokens")
	case wireRequest.MaxTokens != nil && *wireRequest.MaxTokens == 0:
		return invalidField("max_tokens")
	case wireRequest.N != nil && *wireRequest.N == 0:
		return invalidField("n")
	case wireRequest.N != nil && *wireRequest.N != 1:
		return unsupportedField("n")
	case wireRequest.Logprobs != nil:
		return unsupportedField("logprobs")
	case wireRequest.TopLogprobs != nil:
		return unsupportedField("top_logprobs")
	case hasJSONValue(wireRequest.Audio):
		return unsupportedField("audio")
	case wireRequest.Modalities != nil:
		return unsupportedField("modalities")
	case hasJSONValue(wireRequest.Prediction):
		return unsupportedField("prediction")
	case wireRequest.FrequencyPenalty != nil:
		return unsupportedField("frequency_penalty")
	case wireRequest.PresencePenalty != nil:
		return unsupportedField("presence_penalty")
	case hasJSONValue(wireRequest.LogitBias):
		return unsupportedField("logit_bias")
	case wireRequest.Seed != nil:
		return unsupportedField("seed")
	case wireRequest.ServiceTier != nil:
		return unsupportedField("service_tier")
	case hasJSONValue(wireRequest.Metadata):
		return unsupportedField("metadata")
	case hasJSONValue(wireRequest.WebSearchOptions):
		return unsupportedField("web_search_options")
	case wireRequest.Functions != nil:
		return unsupportedField("functions")
	case hasJSONValue(wireRequest.FunctionCall):
		return unsupportedField("function_call")
	default:
		return nil
	}
}

// maxOutputTokens 返回新旧 token 上限字段中的唯一有效值。
func maxOutputTokens(wireRequest requestDTO) uint64 {
	if wireRequest.MaxCompletionTokens != nil {
		return *wireRequest.MaxCompletionTokens
	}
	if wireRequest.MaxTokens != nil {
		return *wireRequest.MaxTokens
	}
	return 0
}
