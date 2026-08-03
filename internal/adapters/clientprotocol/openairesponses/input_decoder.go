package openairesponses

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/core/inference"
)

// decodedInput 保存消息以及精确工具调用和结果 ID，用于 continuation 配对。
type decodedInput struct {
	messages    []inference.Message
	toolCalls   map[string]struct{}
	toolResults []string
}

// decodeInput 解析 Responses 字符串简写或输入项数组。
func decodeInput(raw json.RawMessage) (decodedInput, error) {
	if !hasJSONValue(raw) {
		return decodedInput{}, invalidField("input")
	}
	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, `"`) {
		return decodeStringInput(raw)
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil || len(items) == 0 {
		return decodedInput{}, invalidField("input")
	}
	output := decodedInput{
		messages:  make([]inference.Message, 0, len(items)),
		toolCalls: make(map[string]struct{}),
	}
	for index, item := range items {
		if err := output.appendItem(item, fmt.Sprintf("input[%d]", index)); err != nil {
			return decodedInput{}, err
		}
	}
	return output, nil
}

// decodeStringInput 将 Responses 文本简写转换为 User 消息。
func decodeStringInput(raw json.RawMessage) (decodedInput, error) {
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return decodedInput{}, invalidField("input")
	}
	content, err := inference.NewTextContent(text)
	if err != nil {
		return decodedInput{}, invalidField("input")
	}
	message, err := inference.NewMessage(inference.RoleUser, content)
	if err != nil {
		return decodedInput{}, invalidField("input")
	}
	return decodedInput{
		messages:  []inference.Message{message},
		toolCalls: make(map[string]struct{}),
	}, nil
}

// appendItem 根据输入项 type 选择单一 Decoder 并记录工具配对证据。
func (output *decodedInput) appendItem(raw json.RawMessage, field string) error {
	header, err := decodeHeader[inputItemHeaderDTO](raw, field)
	if err != nil {
		return err
	}
	switch {
	case header.Type == "" && header.Role != "", header.Type == "message":
		message, decodeErr := decodeMessageItem(raw, field)
		if decodeErr != nil {
			return decodeErr
		}
		output.messages = append(output.messages, message)
		return nil
	case header.Type == "function_call":
		message, callID, decodeErr := decodeFunctionCall(raw, field)
		if decodeErr != nil {
			return decodeErr
		}
		if _, exists := output.toolCalls[callID]; exists {
			return invalidField(field + ".call_id")
		}
		output.toolCalls[callID] = struct{}{}
		output.messages = append(output.messages, message)
		return nil
	case header.Type == "function_call_output":
		message, callID, decodeErr := decodeFunctionCallOutput(raw, field)
		if decodeErr != nil {
			return decodeErr
		}
		output.toolResults = append(output.toolResults, callID)
		output.messages = append(output.messages, message)
		return nil
	case header.Type == "reasoning":
		message, decodeErr := decodeReasoningItem(raw, field)
		if decodeErr != nil {
			return decodeErr
		}
		output.messages = append(output.messages, message)
		return nil
	default:
		return invalidField(field + ".type")
	}
}

// externalToolCallIDs 返回由明确 continuation 承担的请求外调用 ID。
func (output decodedInput) externalToolCallIDs(hasContinuation bool) []string {
	if !hasContinuation {
		return nil
	}
	external := make([]string, 0, len(output.toolResults))
	for _, callID := range output.toolResults {
		if _, exists := output.toolCalls[callID]; !exists {
			external = append(external, callID)
		}
	}
	return external
}

// decodeMessageItem 解析一个 Responses message 输入项。
func decodeMessageItem(raw json.RawMessage, field string) (inference.Message, error) {
	wireMessage, err := decodeStrict[messageDTO](raw, field)
	if err != nil {
		return inference.Message{}, err
	}
	if wireMessage.Type != "" && wireMessage.Type != "message" {
		return inference.Message{}, invalidField(field + ".type")
	}
	if wireMessage.Status != "" && wireMessage.Status != "completed" {
		return inference.Message{}, invalidField(field + ".status")
	}
	role, err := decodeRole(wireMessage.Role, field+".role")
	if err != nil {
		return inference.Message{}, err
	}
	contents, err := decodeMessageContents(wireMessage.Content, field+".content")
	if err != nil {
		return inference.Message{}, err
	}
	if wireMessage.Phase == "" {
		message, messageErr := inference.NewMessage(role, contents...)
		if messageErr != nil {
			return inference.Message{}, invalidField(field)
		}
		return message, nil
	}
	phase, err := decodeMessagePhase(wireMessage.Phase, field+".phase")
	if err != nil {
		return inference.Message{}, err
	}
	message, messageErr := inference.NewPhasedMessage(role, phase, contents...)
	if messageErr != nil {
		return inference.Message{}, invalidField(field)
	}
	return message, nil
}

// decodeRole 将 Responses 角色映射为 Canonical Role。
func decodeRole(value string, field string) (inference.Role, error) {
	role := inference.Role(value)
	if !role.IsValid() {
		return "", invalidField(field)
	}
	return role, nil
}

// decodeMessagePhase 将 Responses assistant phase 映射为 Canonical 阶段。
func decodeMessagePhase(value string, field string) (inference.MessagePhase, error) {
	phase := inference.MessagePhase(value)
	if !phase.IsValid() {
		return "", invalidField(field)
	}
	return phase, nil
}

// decodeMessageContents 解析字符串简写或类型化内容块数组。
func decodeMessageContents(raw json.RawMessage, field string) ([]inference.Content, error) {
	if !hasJSONValue(raw) {
		return nil, invalidField(field)
	}
	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, `"`) {
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return nil, invalidField(field)
		}
		content, err := inference.NewTextContent(text)
		if err != nil {
			return nil, invalidField(field)
		}
		return []inference.Content{content}, nil
	}
	var blocks []json.RawMessage
	if err := json.Unmarshal(raw, &blocks); err != nil || len(blocks) == 0 {
		return nil, invalidField(field)
	}
	contents := make([]inference.Content, len(blocks))
	for index, block := range blocks {
		content, err := decodeContentBlock(block, fmt.Sprintf("%s[%d]", field, index))
		if err != nil {
			return nil, err
		}
		contents[index] = content
	}
	return contents, nil
}

// decodeContentBlock 根据内容 type 选择文本、拒绝、图片或文档 Decoder。
func decodeContentBlock(raw json.RawMessage, field string) (inference.Content, error) {
	header, err := decodeHeader[contentHeaderDTO](raw, field)
	if err != nil {
		return nil, err
	}
	switch header.Type {
	case "input_text", "output_text":
		return decodeTextContent(raw, field)
	case "refusal":
		return decodeRefusalContent(raw, field)
	case "input_image":
		return decodeImageContent(raw, field)
	case "input_file":
		return decodeFileContent(raw, field)
	default:
		return nil, invalidField(field + ".type")
	}
}

// decodeTextContent 解析 input_text 或 output_text，并显式拒绝未建模元数据。
func decodeTextContent(raw json.RawMessage, field string) (inference.Content, error) {
	wireContent, err := decodeStrict[textContentDTO](raw, field)
	if err != nil {
		return nil, err
	}
	if wireContent.Type != "input_text" && wireContent.Type != "output_text" {
		return nil, invalidField(field + ".type")
	}
	switch {
	case hasJSONValue(wireContent.PromptCacheBreakpoint):
		return nil, unsupportedField(field + ".prompt_cache_breakpoint")
	case hasJSONValue(wireContent.Annotations) && !isEmptyJSONArray(wireContent.Annotations):
		return nil, unsupportedField(field + ".annotations")
	case hasJSONValue(wireContent.Logprobs) && !isEmptyJSONArray(wireContent.Logprobs):
		return nil, unsupportedField(field + ".logprobs")
	}
	content, contentErr := inference.NewTextContent(wireContent.Text)
	if contentErr != nil {
		return nil, invalidField(field + ".text")
	}
	return content, nil
}

// decodeRefusalContent 解析历史 Assistant refusal 内容。
func decodeRefusalContent(raw json.RawMessage, field string) (inference.Content, error) {
	wireContent, err := decodeStrict[refusalContentDTO](raw, field)
	if err != nil {
		return nil, err
	}
	if wireContent.Type != "refusal" {
		return nil, invalidField(field + ".type")
	}
	content, contentErr := inference.NewRefusalContent(wireContent.Refusal)
	if contentErr != nil {
		return nil, invalidField(field + ".refusal")
	}
	return content, nil
}

// decodeFunctionCall 解析完整且参数合法的历史函数调用。
func decodeFunctionCall(
	raw json.RawMessage,
	field string,
) (inference.Message, string, error) {
	wireCall, err := decodeStrict[functionCallDTO](raw, field)
	if err != nil {
		return inference.Message{}, "", err
	}
	if wireCall.Type != "function_call" ||
		(wireCall.Status != "" && wireCall.Status != "completed") {
		return inference.Message{}, "", invalidField(field)
	}
	var call inference.ToolCallContent
	var callErr error
	if wireCall.Namespace == "" {
		call, callErr = inference.NewToolCallContent(
			wireCall.CallID,
			wireCall.Name,
			[]byte(wireCall.Arguments),
		)
	} else {
		call, callErr = inference.NewNamespacedToolCallContent(
			wireCall.CallID,
			wireCall.Namespace,
			wireCall.Name,
			[]byte(wireCall.Arguments),
		)
	}
	if callErr != nil {
		return inference.Message{}, "", invalidField(field)
	}
	message, messageErr := inference.NewMessage(inference.RoleAssistant, call)
	if messageErr != nil {
		return inference.Message{}, "", invalidField(field)
	}
	return message, wireCall.CallID, nil
}

// decodeFunctionCallOutput 解析字符串或多模态函数结果。
func decodeFunctionCallOutput(
	raw json.RawMessage,
	field string,
) (inference.Message, string, error) {
	wireOutput, err := decodeStrict[functionCallOutputDTO](raw, field)
	if err != nil {
		return inference.Message{}, "", err
	}
	if wireOutput.Type != "function_call_output" ||
		(wireOutput.Status != "" && wireOutput.Status != "completed") {
		return inference.Message{}, "", invalidField(field)
	}
	contents, err := decodeMessageContents(wireOutput.Output, field+".output")
	if err != nil {
		return inference.Message{}, "", err
	}
	result, resultErr := inference.NewToolResultContent(wireOutput.CallID, false, contents...)
	if resultErr != nil {
		return inference.Message{}, "", invalidField(field)
	}
	message, messageErr := inference.NewMessage(inference.RoleUser, result)
	if messageErr != nil {
		return inference.Message{}, "", invalidField(field)
	}
	return message, wireOutput.CallID, nil
}

// decodeReasoningItem 解析可见摘要和加密连续性历史项。
func decodeReasoningItem(raw json.RawMessage, field string) (inference.Message, error) {
	wireReasoning, err := decodeStrict[reasoningItemDTO](raw, field)
	if err != nil {
		return inference.Message{}, err
	}
	if wireReasoning.Type != "reasoning" ||
		(wireReasoning.Status != "" && wireReasoning.Status != "completed") {
		return inference.Message{}, invalidField(field)
	}
	if hasJSONValue(wireReasoning.Content) && !isEmptyJSONArray(wireReasoning.Content) {
		return inference.Message{}, unsupportedField(field + ".content")
	}
	contents := make([]inference.Content, 0, len(wireReasoning.Summary)+1)
	for index, summary := range wireReasoning.Summary {
		if summary.Type != "summary_text" {
			return inference.Message{}, invalidField(fmt.Sprintf("%s.summary[%d].type", field, index))
		}
		content, contentErr := inference.NewReasoningSummaryContent(summary.Text)
		if contentErr != nil {
			return inference.Message{}, invalidField(fmt.Sprintf("%s.summary[%d].text", field, index))
		}
		contents = append(contents, content)
	}
	if wireReasoning.EncryptedContent != "" {
		content, contentErr := inference.NewEncryptedReasoningContent(wireReasoning.EncryptedContent)
		if contentErr != nil {
			return inference.Message{}, invalidField(field + ".encrypted_content")
		}
		contents = append(contents, content)
	}
	if len(contents) == 0 {
		return inference.Message{}, invalidField(field)
	}
	message, messageErr := inference.NewMessage(inference.RoleAssistant, contents...)
	if messageErr != nil {
		return inference.Message{}, invalidField(field)
	}
	return message, nil
}
