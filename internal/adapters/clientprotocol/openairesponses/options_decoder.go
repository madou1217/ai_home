package openairesponses

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/core/inference"
)

// decodeTools 把普通函数和 namespace 内函数展开为带稳定身份的 Canonical 工具。
func decodeTools(
	rawTools []json.RawMessage,
) ([]inference.ToolDefinition, *inference.WebSearchTool, error) {
	tools := make([]inference.ToolDefinition, 0, len(rawTools))
	var webSearch *inference.WebSearchTool
	for index, rawTool := range rawTools {
		field := "tools[" + strconv.Itoa(index) + "]"
		header, err := decodeHeader[contentHeaderDTO](rawTool, field)
		if err != nil {
			return nil, nil, err
		}
		switch header.Type {
		case "function":
			tool, decodeErr := decodeFunctionTool(rawTool, field, "", "")
			if decodeErr != nil {
				return nil, nil, decodeErr
			}
			tools = append(tools, tool)
		case "namespace":
			wireNamespace, decodeErr := decodeStrict[namespaceToolDTO](rawTool, field)
			if decodeErr != nil {
				return nil, nil, decodeErr
			}
			if wireNamespace.Type != "namespace" ||
				wireNamespace.Name == "" ||
				len(wireNamespace.Tools) == 0 {
				return nil, nil, invalidField(field)
			}
			for childIndex, rawChild := range wireNamespace.Tools {
				childField := field + ".tools[" + strconv.Itoa(childIndex) + "]"
				childHeader, headerErr := decodeHeader[contentHeaderDTO](rawChild, childField)
				if headerErr != nil {
					return nil, nil, headerErr
				}
				if childHeader.Type != "function" {
					return nil, nil, unsupportedField(childField + ".type")
				}
				tool, childErr := decodeFunctionTool(
					rawChild,
					childField,
					wireNamespace.Name,
					wireNamespace.Description,
				)
				if childErr != nil {
					return nil, nil, childErr
				}
				tools = append(tools, tool)
			}
		case "web_search":
			if webSearch != nil {
				return nil, nil, invalidField(field)
			}
			decoded, decodeErr := decodeWebSearchTool(rawTool, field)
			if decodeErr != nil {
				return nil, nil, decodeErr
			}
			webSearch = &decoded
		default:
			return nil, nil, unsupportedField(field + ".type")
		}
	}
	return tools, webSearch, nil
}

// decodeWebSearchTool 解析 Responses 与 Claude 共同支持的搜索配置交集。
func decodeWebSearchTool(
	raw json.RawMessage,
	field string,
) (inference.WebSearchTool, error) {
	wire, err := decodeStrict[webSearchToolDTO](raw, field)
	if err != nil {
		return inference.WebSearchTool{}, err
	}
	if wire.Type != "web_search" {
		return inference.WebSearchTool{}, invalidField(field + ".type")
	}
	if wire.SearchContextSize != "" {
		return inference.WebSearchTool{}, unsupportedField(field + ".search_context_size")
	}
	if len(wire.SearchContentTypes) != 0 {
		return inference.WebSearchTool{}, unsupportedField(field + ".search_content_types")
	}
	var allowedDomains []string
	if hasJSONValue(wire.Filters) {
		filters, decodeErr := decodeStrict[webSearchFiltersDTO](wire.Filters, field+".filters")
		if decodeErr != nil {
			return inference.WebSearchTool{}, decodeErr
		}
		allowedDomains = filters.AllowedDomains
	}
	var location *inference.WebSearchLocation
	if hasJSONValue(wire.UserLocation) {
		wireLocation, decodeErr := decodeStrict[webSearchLocationDTO](
			wire.UserLocation,
			field+".user_location",
		)
		if decodeErr != nil {
			return inference.WebSearchTool{}, decodeErr
		}
		if wireLocation.Type != "approximate" {
			return inference.WebSearchTool{}, unsupportedField(field + ".user_location.type")
		}
		decodedLocation, locationErr := inference.NewWebSearchLocation(
			wireLocation.Country,
			wireLocation.Region,
			wireLocation.City,
			wireLocation.Timezone,
		)
		if locationErr != nil {
			return inference.WebSearchTool{}, invalidField(field + ".user_location")
		}
		location = &decodedLocation
	}
	tool, toolErr := inference.NewWebSearchTool(inference.WebSearchOptions{
		ExternalWebAccess: wire.ExternalWebAccess,
		AllowedDomains:    allowedDomains,
		Location:          location,
	})
	if toolErr != nil {
		return inference.WebSearchTool{}, invalidField(field)
	}
	return tool, nil
}

// decodeFunctionTool 解码普通或 namespace 内的单个函数定义。
func decodeFunctionTool(
	raw json.RawMessage,
	field string,
	namespace string,
	namespaceDescription string,
) (inference.ToolDefinition, error) {
	wireTool, err := decodeStrict[functionToolDTO](raw, field)
	if err != nil {
		return inference.ToolDefinition{}, err
	}
	options := inference.ToolDefinitionOptions{Strict: wireTool.Strict}
	var tool inference.ToolDefinition
	if namespace == "" {
		tool, err = inference.NewToolDefinitionWithOptions(
			wireTool.Name,
			wireTool.Description,
			wireTool.Parameters,
			options,
		)
	} else {
		tool, err = inference.NewNamespacedToolDefinitionWithOptions(
			namespace,
			namespaceDescription,
			wireTool.Name,
			wireTool.Description,
			wireTool.Parameters,
			options,
		)
	}
	if err != nil {
		return inference.ToolDefinition{}, invalidField(field)
	}
	return tool, nil
}

// decodeToolChoice 解析字符串模式或明确命名的 function 工具。
func decodeToolChoice(raw json.RawMessage) (*inference.ToolChoice, error) {
	if !hasJSONValue(raw) {
		return nil, nil
	}
	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, `"`) {
		var mode string
		if err := json.Unmarshal(raw, &mode); err != nil {
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
	var choice inference.ToolChoice
	var choiceErr error
	if wireChoice.Namespace == "" {
		choice, choiceErr = inference.NewNamedToolChoice(wireChoice.Name)
	} else {
		choice, choiceErr = inference.NewNamespacedToolChoice(
			wireChoice.Namespace,
			wireChoice.Name,
		)
	}
	if choiceErr != nil {
		return nil, invalidField("tool_choice")
	}
	return &choice, nil
}

// decodeReasoning 解析当前可无损表示的 effort 和 summary 字段。
func decodeReasoning(raw json.RawMessage) (*inference.ReasoningConfig, error) {
	if !hasJSONValue(raw) {
		return nil, nil
	}
	wireReasoning, err := decodeStrict[reasoningConfigDTO](raw, "reasoning")
	if err != nil {
		return nil, err
	}
	switch {
	case wireReasoning.Context != "":
		return nil, unsupportedField("reasoning.context")
	case wireReasoning.Mode != "":
		return nil, unsupportedField("reasoning.mode")
	case wireReasoning.Summary != "" &&
		wireReasoning.GenerateSummary != "" &&
		wireReasoning.Summary != wireReasoning.GenerateSummary:
		return nil, invalidField("reasoning.generate_summary")
	}
	summary := wireReasoning.Summary
	if summary == "" {
		summary = wireReasoning.GenerateSummary
	}
	config, configErr := inference.NewEffortReasoning(
		inference.ReasoningEffort(wireReasoning.Effort),
		inference.ReasoningSummaryMode(summary),
	)
	if configErr != nil {
		return nil, invalidField("reasoning")
	}
	return &config, nil
}

// decodeTextConfig 解析默认文本或 JSON Schema 结构化输出。
func decodeTextConfig(raw json.RawMessage) (*inference.StructuredOutput, error) {
	if !hasJSONValue(raw) {
		return nil, nil
	}
	wireText, err := decodeStrict[textConfigDTO](raw, "text")
	if err != nil {
		return nil, err
	}
	if wireText.Verbosity != "" {
		return nil, unsupportedField("text.verbosity")
	}
	if !hasJSONValue(wireText.Format) {
		return nil, nil
	}
	header, err := decodeHeader[textFormatHeaderDTO](wireText.Format, "text.format")
	if err != nil {
		return nil, err
	}
	switch header.Type {
	case "text":
		wireFormat, decodeErr := decodeStrict[plainTextFormatDTO](wireText.Format, "text.format")
		if decodeErr != nil || wireFormat.Type != "text" {
			return nil, invalidField("text.format")
		}
		return nil, nil
	case "json_schema":
		wireFormat, decodeErr := decodeStrict[structuredTextFormatDTO](wireText.Format, "text.format")
		if decodeErr != nil {
			return nil, decodeErr
		}
		strict := false
		if wireFormat.Strict != nil {
			strict = *wireFormat.Strict
		}
		output, outputErr := inference.NewStructuredOutput(
			wireFormat.Name,
			wireFormat.Description,
			wireFormat.Schema,
			strict,
		)
		if outputErr != nil {
			return nil, invalidField("text.format")
		}
		return &output, nil
	case "json_object":
		return nil, unsupportedField("text.format.type")
	default:
		return nil, invalidField("text.format.type")
	}
}

// decodeContinuation 解析 previous_response_id 或 conversation，禁止同时设置。
func decodeContinuation(wireRequest requestDTO) (*inference.Continuation, error) {
	hasPrevious := wireRequest.PreviousResponseID != ""
	hasConversation := hasJSONValue(wireRequest.Conversation)
	if hasPrevious && hasConversation {
		return nil, invalidField("conversation")
	}
	if hasPrevious {
		continuation, err := inference.NewContinuation(
			inference.ContinuationPreviousResponse,
			wireRequest.PreviousResponseID,
		)
		if err != nil {
			return nil, invalidField("previous_response_id")
		}
		return &continuation, nil
	}
	if !hasConversation {
		return nil, nil
	}
	conversationID, err := decodeConversationID(wireRequest.Conversation)
	if err != nil {
		return nil, err
	}
	continuation, continuationErr := inference.NewContinuation(
		inference.ContinuationConversation,
		conversationID,
	)
	if continuationErr != nil {
		return nil, invalidField("conversation")
	}
	return &continuation, nil
}

// decodeConversationID 支持字符串和包含 id 的对象形式。
func decodeConversationID(raw json.RawMessage) (string, error) {
	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, `"`) {
		var conversationID string
		if err := json.Unmarshal(raw, &conversationID); err != nil {
			return "", invalidField("conversation")
		}
		return conversationID, nil
	}
	wireConversation, err := decodeStrict[conversationDTO](raw, "conversation")
	if err != nil {
		return "", err
	}
	return wireConversation.ID, nil
}

// decodeIncludes 只接受加密 reasoning 连续性这一当前必需输出。
func decodeIncludes(values []string) (bool, error) {
	if len(values) == 0 {
		return false, nil
	}
	seenEncryptedReasoning := false
	for _, value := range values {
		if value != "reasoning.encrypted_content" || seenEncryptedReasoning {
			return false, unsupportedField("include")
		}
		seenEncryptedReasoning = true
	}
	return seenEncryptedReasoning, nil
}

// decodeTruncation 解析可选 auto 或 disabled 截断策略。
func decodeTruncation(value string) (inference.TruncationMode, error) {
	if value == "" {
		return "", nil
	}
	mode := inference.TruncationMode(value)
	if !mode.IsValid() {
		return "", invalidField("truncation")
	}
	return mode, nil
}
