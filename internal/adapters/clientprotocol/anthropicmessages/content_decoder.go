package anthropicmessages

import (
	"encoding/json"
	"fmt"

	"github.com/madou1217/ai_home/core/inference"
)

// decodedContent 保存内容值对象及其可选缓存断点。
type decodedContent struct {
	content      inference.Content
	cacheControl *inference.PromptCacheControl
}

// decodeSystem 将顶层 system 字符串或文本块数组转换为系统消息。
func decodeSystem(
	raw json.RawMessage,
) ([]inference.Message, []inference.PromptCacheBreakpoint, error) {
	if !hasJSONValue(raw) {
		return nil, nil, nil
	}
	if text, ok := decodeJSONString(raw); ok {
		content, err := newTextContent(text, "system")
		if err != nil {
			return nil, nil, err
		}
		message, messageErr := inference.NewMessage(inference.RoleSystem, content)
		if messageErr != nil {
			return nil, nil, invalidField("system")
		}
		return []inference.Message{message}, nil, nil
	}

	var blocks []json.RawMessage
	if err := json.Unmarshal(raw, &blocks); err != nil || len(blocks) == 0 {
		return nil, nil, invalidField("system")
	}
	contents := make([]inference.Content, 0, len(blocks))
	breakpoints := make([]inference.PromptCacheBreakpoint, 0)
	for index, block := range blocks {
		field := fmt.Sprintf("system[%d]", index)
		header, err := decodeHeader[contentHeaderDTO](block, field)
		if err != nil {
			return nil, nil, err
		}
		if header.Type != "text" {
			return nil, nil, unsupportedField(field + ".type")
		}
		decoded, err := decodeTextContent(block, field)
		if err != nil {
			return nil, nil, err
		}
		contents = append(contents, decoded.content)
		breakpoint, err := newMessageCacheBreakpoint(
			0,
			uint32(index),
			decoded.cacheControl,
			field+".cache_control",
		)
		if err != nil {
			return nil, nil, err
		}
		if breakpoint != nil {
			breakpoints = append(breakpoints, *breakpoint)
		}
	}
	message, err := inference.NewMessage(inference.RoleSystem, contents...)
	if err != nil {
		return nil, nil, invalidField("system")
	}
	return []inference.Message{message}, breakpoints, nil
}

// decodeMessages 按原始顺序解析 user 和 assistant 历史。
func decodeMessages(
	rawMessages []json.RawMessage,
	messageOffset uint32,
) ([]inference.Message, []inference.PromptCacheBreakpoint, error) {
	if len(rawMessages) == 0 {
		return nil, nil, invalidField("messages")
	}
	if len(rawMessages) > 100_000 {
		return nil, nil, invalidField("messages")
	}
	messages := make([]inference.Message, 0, len(rawMessages))
	breakpoints := make([]inference.PromptCacheBreakpoint, 0)
	for index, raw := range rawMessages {
		field := fmt.Sprintf("messages[%d]", index)
		wireMessage, err := decodeStrict[messageDTO](raw, field)
		if err != nil {
			return nil, nil, err
		}
		role, err := decodeRole(wireMessage.Role, field+".role")
		if err != nil {
			return nil, nil, err
		}
		contents, contentBreakpoints, err := decodeMessageContent(
			wireMessage.Content,
			role,
			field+".content",
			messageOffset+uint32(index),
		)
		if err != nil {
			return nil, nil, err
		}
		message, messageErr := inference.NewMessage(role, contents...)
		if messageErr != nil {
			return nil, nil, invalidField(field)
		}
		messages = append(messages, message)
		breakpoints = append(breakpoints, contentBreakpoints...)
	}
	return messages, breakpoints, nil
}

// decodeRole 只接受 Anthropic Messages 公开的两个历史角色。
func decodeRole(value string, field string) (inference.Role, error) {
	switch value {
	case "user":
		return inference.RoleUser, nil
	case "assistant":
		return inference.RoleAssistant, nil
	default:
		return "", invalidField(field)
	}
}

// decodeMessageContent 解析字符串简写或内容块数组。
func decodeMessageContent(
	raw json.RawMessage,
	role inference.Role,
	field string,
	messageIndex uint32,
) ([]inference.Content, []inference.PromptCacheBreakpoint, error) {
	if text, ok := decodeJSONString(raw); ok {
		content, err := newTextContent(text, field)
		if err != nil {
			return nil, nil, err
		}
		return []inference.Content{content}, nil, nil
	}

	var blocks []json.RawMessage
	if err := json.Unmarshal(raw, &blocks); err != nil || len(blocks) == 0 {
		return nil, nil, invalidField(field)
	}
	contents := make([]inference.Content, 0, len(blocks))
	breakpoints := make([]inference.PromptCacheBreakpoint, 0)
	for index, block := range blocks {
		blockField := fmt.Sprintf("%s[%d]", field, index)
		decoded, err := decodeContentBlock(block, role, blockField)
		if err != nil {
			return nil, nil, err
		}
		contents = append(contents, decoded.content)
		breakpoint, err := newMessageCacheBreakpoint(
			messageIndex,
			uint32(index),
			decoded.cacheControl,
			blockField+".cache_control",
		)
		if err != nil {
			return nil, nil, err
		}
		if breakpoint != nil {
			breakpoints = append(breakpoints, *breakpoint)
		}
	}
	return contents, breakpoints, nil
}

// decodeContentBlock 按角色解析 Messages 当前阶段可无损表达的内容块。
func decodeContentBlock(
	raw json.RawMessage,
	role inference.Role,
	field string,
) (decodedContent, error) {
	header, err := decodeHeader[contentHeaderDTO](raw, field)
	if err != nil {
		return decodedContent{}, err
	}
	switch header.Type {
	case "text":
		return decodeTextContent(raw, field)
	case "image":
		if role != inference.RoleUser {
			return decodedContent{}, invalidField(field)
		}
		return decodeImageContent(raw, field)
	case "document":
		if role != inference.RoleUser {
			return decodedContent{}, invalidField(field)
		}
		return decodeDocumentContent(raw, field)
	case "thinking":
		if role != inference.RoleAssistant {
			return decodedContent{}, invalidField(field)
		}
		return decodeThinkingContent(raw, field)
	case "redacted_thinking":
		if role != inference.RoleAssistant {
			return decodedContent{}, invalidField(field)
		}
		return decodeRedactedThinkingContent(raw, field)
	case "tool_use":
		if role != inference.RoleAssistant {
			return decodedContent{}, invalidField(field)
		}
		return decodeToolUseContent(raw, field)
	case "tool_result":
		if role != inference.RoleUser {
			return decodedContent{}, invalidField(field)
		}
		return decodeToolResultContent(raw, field)
	default:
		return decodedContent{}, unsupportedField(field + ".type")
	}
}

// decodeTextContent 解析普通文本和缓存控制，并拒绝尚未进入 Canonical Contract 的引用。
func decodeTextContent(raw json.RawMessage, field string) (decodedContent, error) {
	wireContent, err := decodeStrict[textContentDTO](raw, field)
	if err != nil {
		return decodedContent{}, err
	}
	switch {
	case wireContent.Type != "text":
		return decodedContent{}, invalidField(field + ".type")
	case hasJSONValue(wireContent.Citations) && !isEmptyJSONArray(wireContent.Citations):
		return decodedContent{}, unsupportedField(field + ".citations")
	}
	content, err := newTextContent(wireContent.Text, field+".text")
	if err != nil {
		return decodedContent{}, err
	}
	cacheControl, err := decodePromptCacheControl(
		wireContent.CacheControl,
		field+".cache_control",
	)
	if err != nil {
		return decodedContent{}, err
	}
	return decodedContent{content: content, cacheControl: cacheControl}, nil
}

// newTextContent 创建普通文本并保留精确字段路径。
func newTextContent(text string, field string) (inference.TextContent, error) {
	content, err := inference.NewTextContent(text)
	if err != nil {
		return inference.TextContent{}, invalidField(field)
	}
	return content, nil
}

// decodeThinkingContent 保留 thinking 文本和签名的精确组合。
func decodeThinkingContent(raw json.RawMessage, field string) (decodedContent, error) {
	wireContent, err := decodeStrict[thinkingContentDTO](raw, field)
	if err != nil {
		return decodedContent{}, err
	}
	if wireContent.Type != "thinking" {
		return decodedContent{}, invalidField(field + ".type")
	}
	content, contentErr := inference.NewThinkingContent(
		wireContent.Thinking,
		wireContent.Signature,
	)
	if contentErr != nil {
		return decodedContent{}, invalidField(field)
	}
	return decodedContent{content: content}, nil
}

// decodeRedactedThinkingContent 保留不可读的 reasoning 连续性。
func decodeRedactedThinkingContent(raw json.RawMessage, field string) (decodedContent, error) {
	wireContent, err := decodeStrict[redactedThinkingContentDTO](raw, field)
	if err != nil {
		return decodedContent{}, err
	}
	if wireContent.Type != "redacted_thinking" {
		return decodedContent{}, invalidField(field + ".type")
	}
	content, contentErr := inference.NewRedactedReasoningContent(wireContent.Data)
	if contentErr != nil {
		return decodedContent{}, invalidField(field + ".data")
	}
	return decodedContent{content: content}, nil
}

// decodeToolUseContent 解析完整且可精确配对的客户端工具调用。
func decodeToolUseContent(raw json.RawMessage, field string) (decodedContent, error) {
	wireContent, err := decodeStrict[toolUseContentDTO](raw, field)
	if err != nil {
		return decodedContent{}, err
	}
	switch {
	case wireContent.Type != "tool_use":
		return decodedContent{}, invalidField(field + ".type")
	case hasJSONValue(wireContent.Caller):
		return decodedContent{}, unsupportedField(field + ".caller")
	}
	content, contentErr := inference.NewToolCallContent(
		wireContent.ID,
		wireContent.Name,
		wireContent.Input,
	)
	if contentErr != nil {
		return decodedContent{}, invalidField(field)
	}
	cacheControl, err := decodePromptCacheControl(
		wireContent.CacheControl,
		field+".cache_control",
	)
	if err != nil {
		return decodedContent{}, err
	}
	return decodedContent{content: content, cacheControl: cacheControl}, nil
}

// decodeToolResultContent 解析字符串、复合内容或明确空结果。
func decodeToolResultContent(raw json.RawMessage, field string) (decodedContent, error) {
	wireContent, err := decodeStrict[toolResultContentDTO](raw, field)
	if err != nil {
		return decodedContent{}, err
	}
	if wireContent.Type != "tool_result" {
		return decodedContent{}, invalidField(field + ".type")
	}
	payload, err := decodeToolResultPayload(wireContent.Content, field+".content")
	if err != nil {
		return decodedContent{}, err
	}
	isError := wireContent.IsError != nil && *wireContent.IsError
	content, contentErr := inference.NewToolResultContent(
		wireContent.ToolUseID,
		isError,
		payload...,
	)
	if contentErr != nil {
		return decodedContent{}, invalidField(field)
	}
	cacheControl, err := decodePromptCacheControl(
		wireContent.CacheControl,
		field+".cache_control",
	)
	if err != nil {
		return decodedContent{}, err
	}
	return decodedContent{content: content, cacheControl: cacheControl}, nil
}

// decodeToolResultPayload 只允许 Canonical ToolResultContent 已声明的内容类别。
func decodeToolResultPayload(
	raw json.RawMessage,
	field string,
) ([]inference.Content, error) {
	if !hasJSONValue(raw) {
		return nil, nil
	}
	if text, ok := decodeJSONString(raw); ok {
		if text == "" {
			return nil, nil
		}
		content, err := newTextContent(text, field)
		if err != nil {
			return nil, err
		}
		return []inference.Content{content}, nil
	}

	var blocks []json.RawMessage
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return nil, invalidField(field)
	}
	contents := make([]inference.Content, 0, len(blocks))
	for index, block := range blocks {
		blockField := fmt.Sprintf("%s[%d]", field, index)
		header, err := decodeHeader[contentHeaderDTO](block, blockField)
		if err != nil {
			return nil, err
		}
		var content inference.Content
		var decoded decodedContent
		switch header.Type {
		case "text":
			decoded, err = decodeTextContent(block, blockField)
		case "image":
			decoded, err = decodeImageContent(block, blockField)
		case "document":
			decoded, err = decodeDocumentContent(block, blockField)
		default:
			return nil, unsupportedField(blockField + ".type")
		}
		if err != nil {
			return nil, err
		}
		if decoded.cacheControl != nil {
			return nil, unsupportedField(blockField + ".cache_control")
		}
		content = decoded.content
		contents = append(contents, content)
	}
	return contents, nil
}

// decodeJSONString 尝试解析 JSON 字符串，失败时由调用方继续尝试数组形式。
func decodeJSONString(raw json.RawMessage) (string, bool) {
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}
