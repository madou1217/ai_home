package openaichatcompletions

import (
	"encoding/json"
	"fmt"

	"github.com/madou1217/ai_home/core/inference"
)

// maxChatMessages 防止绕过 HTTP 层直接调用 Decoder 时无界分配。
const maxChatMessages = 100_000

// decodeMessages 按客户端原始顺序解析全部 Chat 历史消息。
func decodeMessages(rawMessages []json.RawMessage) ([]inference.Message, error) {
	if len(rawMessages) == 0 || len(rawMessages) > maxChatMessages {
		return nil, invalidField("messages")
	}
	messages := make([]inference.Message, len(rawMessages))
	for index, rawMessage := range rawMessages {
		field := fmt.Sprintf("messages[%d]", index)
		message, err := decodeMessage(rawMessage, field)
		if err != nil {
			return nil, err
		}
		messages[index] = message
	}
	return messages, nil
}

// decodeMessage 根据角色选择精确 Decoder，并拒绝角色不支持的字段。
func decodeMessage(raw json.RawMessage, field string) (inference.Message, error) {
	wireMessage, err := decodeStrict[messageDTO](raw, field)
	if err != nil {
		return inference.Message{}, err
	}
	if wireMessage.Name != nil {
		return inference.Message{}, unsupportedField(field + ".name")
	}
	if hasJSONValue(wireMessage.FunctionCall) {
		return inference.Message{}, unsupportedField(field + ".function_call")
	}
	if hasJSONValue(wireMessage.Audio) {
		return inference.Message{}, unsupportedField(field + ".audio")
	}

	switch wireMessage.Role {
	case "system":
		return decodeOrdinaryMessage(wireMessage, inference.RoleSystem, field)
	case "developer":
		return decodeOrdinaryMessage(wireMessage, inference.RoleDeveloper, field)
	case "user":
		return decodeOrdinaryMessage(wireMessage, inference.RoleUser, field)
	case "assistant":
		return decodeAssistantMessage(wireMessage, field)
	case "tool":
		return decodeToolResultMessage(wireMessage, field)
	default:
		return inference.Message{}, invalidField(field + ".role")
	}
}

// decodeOrdinaryMessage 解析 system、developer 和 user 消息。
func decodeOrdinaryMessage(
	wireMessage messageDTO,
	role inference.Role,
	field string,
) (inference.Message, error) {
	if wireMessage.ReasoningContent != nil ||
		wireMessage.Refusal != nil ||
		len(wireMessage.ToolCalls) > 0 ||
		wireMessage.ToolCallID != nil {
		return inference.Message{}, invalidField(field)
	}
	contents, err := decodeMessageContent(wireMessage.Content, role, field+".content", false)
	if err != nil {
		return inference.Message{}, err
	}
	message, err := inference.NewMessage(role, contents...)
	if err != nil {
		return inference.Message{}, invalidField(field)
	}
	return message, nil
}

// decodeAssistantMessage 按 reasoning、可见内容、拒绝和工具调用顺序建模。
func decodeAssistantMessage(
	wireMessage messageDTO,
	field string,
) (inference.Message, error) {
	if wireMessage.ToolCallID != nil {
		return inference.Message{}, invalidField(field + ".tool_call_id")
	}
	contents := make([]inference.Content, 0, 4+len(wireMessage.ToolCalls))
	if wireMessage.ReasoningContent != nil {
		reasoning, err := inference.NewReasoningSummaryContent(*wireMessage.ReasoningContent)
		if err != nil {
			return inference.Message{}, invalidField(field + ".reasoning_content")
		}
		contents = append(contents, reasoning)
	}
	if hasJSONValue(wireMessage.Content) {
		decoded, err := decodeMessageContent(
			wireMessage.Content,
			inference.RoleAssistant,
			field+".content",
			false,
		)
		if err != nil {
			return inference.Message{}, err
		}
		contents = append(contents, decoded...)
	}
	if wireMessage.Refusal != nil {
		refusal, err := inference.NewRefusalContent(*wireMessage.Refusal)
		if err != nil {
			return inference.Message{}, invalidField(field + ".refusal")
		}
		contents = append(contents, refusal)
	}
	toolCalls, err := decodeToolCalls(wireMessage.ToolCalls, field+".tool_calls")
	if err != nil {
		return inference.Message{}, err
	}
	contents = append(contents, toolCalls...)
	message, err := inference.NewMessage(inference.RoleAssistant, contents...)
	if err != nil {
		return inference.Message{}, invalidField(field)
	}
	return message, nil
}

// decodeToolResultMessage 把 Chat tool 角色映射为 Canonical User 工具结果。
func decodeToolResultMessage(
	wireMessage messageDTO,
	field string,
) (inference.Message, error) {
	if wireMessage.ToolCallID == nil ||
		wireMessage.ReasoningContent != nil ||
		wireMessage.Refusal != nil ||
		len(wireMessage.ToolCalls) > 0 {
		return inference.Message{}, invalidField(field)
	}
	payload, err := decodeMessageContent(
		wireMessage.Content,
		inference.RoleUser,
		field+".content",
		true,
	)
	if err != nil {
		return inference.Message{}, err
	}
	result, err := inference.NewToolResultContent(
		*wireMessage.ToolCallID,
		false,
		payload...,
	)
	if err != nil {
		return inference.Message{}, invalidField(field)
	}
	message, err := inference.NewMessage(inference.RoleUser, result)
	if err != nil {
		return inference.Message{}, invalidField(field)
	}
	return message, nil
}

// decodeMessageContent 解析字符串简写或严格的内容块数组。
func decodeMessageContent(
	raw json.RawMessage,
	role inference.Role,
	field string,
	allowEmpty bool,
) ([]inference.Content, error) {
	if !hasJSONValue(raw) {
		return nil, invalidField(field)
	}
	if text, ok := decodeJSONString(raw); ok {
		if text == "" && allowEmpty {
			return nil, nil
		}
		content, err := inference.NewTextContent(text)
		if err != nil {
			return nil, invalidField(field)
		}
		return []inference.Content{content}, nil
	}

	var blocks []json.RawMessage
	if json.Unmarshal(raw, &blocks) != nil || (!allowEmpty && len(blocks) == 0) {
		return nil, invalidField(field)
	}
	contents := make([]inference.Content, 0, len(blocks))
	for index, block := range blocks {
		blockField := fmt.Sprintf("%s[%d]", field, index)
		content, err := decodeContentBlock(block, role, blockField)
		if err != nil {
			return nil, err
		}
		contents = append(contents, content)
	}
	return contents, nil
}

// decodeContentBlock 只解析当前 Canonical Contract 可无损表达的块。
func decodeContentBlock(
	raw json.RawMessage,
	role inference.Role,
	field string,
) (inference.Content, error) {
	header, err := decodeHeader[contentHeaderDTO](raw, field)
	if err != nil {
		return nil, err
	}
	switch header.Type {
	case "text":
		wireText, err := decodeStrict[textContentDTO](raw, field)
		if err != nil {
			return nil, err
		}
		text, contentErr := inference.NewTextContent(wireText.Text)
		if contentErr != nil {
			return nil, invalidField(field)
		}
		return text, nil
	case "image_url":
		if role != inference.RoleUser {
			return nil, invalidField(field)
		}
		return decodeImageContent(raw, field)
	default:
		return nil, unsupportedField(field + ".type")
	}
}

// decodeImageContent 解析 Chat 图片来源和受支持的解析精度。
func decodeImageContent(
	raw json.RawMessage,
	field string,
) (inference.Content, error) {
	wireImage, err := decodeStrict[imageContentDTO](raw, field)
	if err != nil {
		return nil, err
	}
	if wireImage.Type != "image_url" {
		return nil, invalidField(field + ".type")
	}
	source, err := decodeImageSource(wireImage.ImageURL.URL, field+".image_url.url")
	if err != nil {
		return nil, err
	}
	detail := inference.ImageDetail(wireImage.ImageURL.Detail)
	if detail == "" {
		detail = inference.ImageDetailAuto
	}
	if detail != inference.ImageDetailAuto &&
		detail != inference.ImageDetailLow &&
		detail != inference.ImageDetailHigh {
		return nil, invalidField(field + ".image_url.detail")
	}
	content, err := inference.NewImageContent(source, detail)
	if err != nil {
		return nil, invalidField(field)
	}
	return content, nil
}

// decodeToolCalls 解析 Assistant 历史中的完整函数调用。
func decodeToolCalls(
	rawCalls []json.RawMessage,
	field string,
) ([]inference.Content, error) {
	contents := make([]inference.Content, len(rawCalls))
	for index, rawCall := range rawCalls {
		callField := fmt.Sprintf("%s[%d]", field, index)
		wireCall, err := decodeStrict[toolCallDTO](rawCall, callField)
		if err != nil {
			return nil, err
		}
		if wireCall.Type != "function" {
			return nil, unsupportedField(callField + ".type")
		}
		call, err := inference.NewToolCallContent(
			wireCall.ID,
			wireCall.Function.Name,
			[]byte(wireCall.Function.Arguments),
		)
		if err != nil {
			return nil, invalidField(callField)
		}
		contents[index] = call
	}
	return contents, nil
}
