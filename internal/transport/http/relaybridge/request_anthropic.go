package relaybridge

import (
	"encoding/json"
	"strings"
)

// anthropicChatRequest 是桥需要读取的 Anthropic Messages 请求字段。
type anthropicChatRequest struct {
	Model         string             `json:"model"`
	System        json.RawMessage    `json:"system"`
	Messages      []anthropicMessage `json:"messages"`
	MaxTokens     *int               `json:"max_tokens"`
	Temperature   *float64           `json:"temperature"`
	TopP          *float64           `json:"top_p"`
	TopK          *int               `json:"top_k"`
	StopSequences []string           `json:"stop_sequences"`
	Stream        bool               `json:"stream"`
	Tools         []anthropicTool    `json:"tools"`
	ToolChoice    json.RawMessage    `json:"tool_choice"`
}

type anthropicMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type anthropicTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"input_schema"`
}

type anthropicBlock struct {
	Type      string                `json:"type"`
	Text      string                `json:"text"`
	Source    *anthropicImageSource `json:"source"`
	ID        string                `json:"id"`
	Name      string                `json:"name"`
	Input     json.RawMessage       `json:"input"`
	ToolUseID string                `json:"tool_use_id"`
	Content   json.RawMessage       `json:"content"`
	IsError   bool                  `json:"is_error"`
}

type anthropicImageSource struct {
	Type      string `json:"type"`
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
	URL       string `json:"url"`
}

type chatRequestWire struct {
	Model             string               `json:"model"`
	Messages          []chatRequestMessage `json:"messages"`
	Stream            bool                 `json:"stream"`
	MaxTokens         *int                 `json:"max_tokens,omitempty"`
	Temperature       *float64             `json:"temperature,omitempty"`
	TopP              *float64             `json:"top_p,omitempty"`
	Stop              []string             `json:"stop,omitempty"`
	Tools             []chatRequestTool    `json:"tools,omitempty"`
	ToolChoice        any                  `json:"tool_choice,omitempty"`
	ReasoningEffort   string               `json:"reasoning_effort,omitempty"`
	ParallelToolCalls *bool                `json:"parallel_tool_calls,omitempty"`
	ResponseFormat    any                  `json:"response_format,omitempty"`
}

type chatRequestMessage struct {
	Role       string                `json:"role"`
	Content    any                   `json:"content"`
	ToolCalls  []chatRequestToolCall `json:"tool_calls,omitempty"`
	ToolCallID string                `json:"tool_call_id,omitempty"`
}

type chatRequestToolCall struct {
	ID       string              `json:"id"`
	Type     string              `json:"type"`
	Function chatRequestFunction `json:"function"`
}

type chatRequestFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type chatRequestTool struct {
	Type     string                `json:"type"`
	Function chatRequestToolDetail `json:"function"`
}

type chatRequestToolDetail struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

// anthropicToChat 把 Anthropic Messages 请求转换为 OpenAI Chat 请求。
//
// 覆盖文本、图片、工具声明、工具调用与工具结果；thinking 等 Canonical 之外的内容
// 不在此处伪造（客户端仍可通过原生 claude 通道获得保真语义）。
func anthropicToChat(body []byte) ([]byte, error) {
	var request anthropicChatRequest
	if err := json.Unmarshal(body, &request); err != nil {
		return nil, err
	}
	out := chatRequestWire{
		Model:  strings.TrimSpace(request.Model),
		Stream: request.Stream,
	}
	if system := anthropicSystemText(request.System); system != "" {
		out.Messages = append(out.Messages, chatRequestMessage{Role: "system", Content: system})
	}
	for _, message := range request.Messages {
		converted, err := anthropicMessageToChat(message)
		if err != nil {
			return nil, err
		}
		out.Messages = append(out.Messages, converted...)
	}
	if request.MaxTokens != nil && *request.MaxTokens > 0 {
		value := *request.MaxTokens
		out.MaxTokens = &value
	}
	out.Temperature = request.Temperature
	out.TopP = request.TopP
	if len(request.StopSequences) > 0 {
		out.Stop = append([]string(nil), request.StopSequences...)
	}
	if tools := anthropicToolsToChat(request.Tools); len(tools) > 0 {
		out.Tools = tools
	}
	if choice := anthropicToolChoice(request.ToolChoice); choice != nil {
		out.ToolChoice = choice
	}
	return json.Marshal(out)
}

func anthropicMessageToChat(message anthropicMessage) ([]chatRequestMessage, error) {
	role := strings.ToLower(strings.TrimSpace(message.Role))
	blocks, err := anthropicBlocks(message.Content)
	if err != nil {
		return nil, err
	}
	if role == "assistant" {
		return anthropicAssistantMessage(blocks), nil
	}
	return anthropicUserMessages(blocks), nil
}

// anthropicAssistantMessage 把文本与 tool_use 合成一条 assistant 消息。
func anthropicAssistantMessage(blocks []anthropicBlock) []chatRequestMessage {
	var textParts []string
	var toolCalls []chatRequestToolCall
	for _, block := range blocks {
		switch block.Type {
		case "text":
			if block.Text != "" {
				textParts = append(textParts, block.Text)
			}
		case "tool_use":
			arguments := "{}"
			if len(block.Input) > 0 && string(block.Input) != "null" {
				arguments = string(block.Input)
			}
			callID := block.ID
			if callID == "" {
				callID = "call_" + block.Name
			}
			toolCalls = append(toolCalls, chatRequestToolCall{
				ID:   callID,
				Type: "function",
				Function: chatRequestFunction{
					Name:      block.Name,
					Arguments: arguments,
				},
			})
		}
	}
	text := strings.Join(textParts, "\n")
	if text == "" && len(toolCalls) == 0 {
		return nil
	}
	message := chatRequestMessage{Role: "assistant", Content: text}
	if len(toolCalls) > 0 {
		message.ToolCalls = toolCalls
	}
	return []chatRequestMessage{message}
}

// anthropicUserMessages 保持内容顺序：tool_result 必须作为独立 tool 消息交付。
func anthropicUserMessages(blocks []anthropicBlock) []chatRequestMessage {
	var messages []chatRequestMessage
	var parts []any
	var textParts []string
	hasImage := false
	flush := func() {
		text := strings.Join(textParts, "\n")
		if len(parts) == 0 && text == "" {
			return
		}
		var content any = text
		if hasImage {
			contentParts := make([]any, 0, len(parts)+1)
			if text != "" {
				contentParts = append(contentParts, map[string]any{"type": "text", "text": text})
			}
			contentParts = append(contentParts, parts...)
			content = contentParts
		}
		messages = append(messages, chatRequestMessage{Role: "user", Content: content})
		parts = nil
		textParts = nil
		hasImage = false
	}
	for _, block := range blocks {
		switch block.Type {
		case "text":
			if block.Text != "" {
				textParts = append(textParts, block.Text)
			}
		case "image":
			if url := anthropicImageURL(block.Source); url != "" {
				parts = append(parts, map[string]any{
					"type":      "image_url",
					"image_url": map[string]any{"url": url},
				})
				hasImage = true
			}
		case "tool_result":
			flush()
			messages = append(messages, chatRequestMessage{
				Role:       "tool",
				ToolCallID: block.ToolUseID,
				Content:    anthropicToolResultText(block.Content),
			})
		}
	}
	flush()
	return messages
}

func anthropicBlocks(raw json.RawMessage) ([]anthropicBlock, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil, nil
	}
	if strings.HasPrefix(trimmed, "\"") {
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return nil, err
		}
		return []anthropicBlock{{Type: "text", Text: text}}, nil
	}
	var rawBlocks []json.RawMessage
	if err := json.Unmarshal(raw, &rawBlocks); err != nil {
		return nil, err
	}
	blocks := make([]anthropicBlock, 0, len(rawBlocks))
	for _, rawBlock := range rawBlocks {
		trimmedBlock := strings.TrimSpace(string(rawBlock))
		if strings.HasPrefix(trimmedBlock, "\"") {
			var text string
			if err := json.Unmarshal(rawBlock, &text); err != nil {
				return nil, err
			}
			blocks = append(blocks, anthropicBlock{Type: "text", Text: text})
			continue
		}
		var block anthropicBlock
		if err := json.Unmarshal(rawBlock, &block); err != nil {
			return nil, err
		}
		blocks = append(blocks, block)
	}
	return blocks, nil
}

func anthropicSystemText(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return ""
	}
	if strings.HasPrefix(trimmed, "\"") {
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return ""
		}
		return strings.TrimSpace(text)
	}
	blocks, err := anthropicBlocks(raw)
	if err != nil {
		return ""
	}
	var parts []string
	for _, block := range blocks {
		if block.Type == "text" && block.Text != "" {
			parts = append(parts, block.Text)
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n\n"))
}

func anthropicImageURL(source *anthropicImageSource) string {
	if source == nil {
		return ""
	}
	switch source.Type {
	case "base64":
		if source.MediaType == "" || source.Data == "" {
			return ""
		}
		return "data:" + source.MediaType + ";base64," + source.Data
	case "url":
		return source.URL
	default:
		return source.URL
	}
}

func anthropicToolResultText(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return ""
	}
	if strings.HasPrefix(trimmed, "\"") {
		var text string
		if err := json.Unmarshal(raw, &text); err == nil {
			return text
		}
	}
	blocks, err := anthropicBlocks(raw)
	if err != nil {
		return trimmed
	}
	var parts []string
	for _, block := range blocks {
		if block.Type == "text" && block.Text != "" {
			parts = append(parts, block.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func anthropicToolsToChat(tools []anthropicTool) []chatRequestTool {
	out := make([]chatRequestTool, 0, len(tools))
	for _, tool := range tools {
		name := strings.TrimSpace(tool.Name)
		if name == "" {
			continue
		}
		parameters := tool.InputSchema
		if len(parameters) == 0 || string(parameters) == "null" {
			parameters = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		out = append(out, chatRequestTool{
			Type: "function",
			Function: chatRequestToolDetail{
				Name:        name,
				Description: tool.Description,
				Parameters:  parameters,
			},
		})
	}
	return out
}

func anthropicToolChoice(raw json.RawMessage) any {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	var value struct {
		Type string `json:"type"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	switch value.Type {
	case "auto":
		return "auto"
	case "any":
		return "required"
	case "none":
		return "none"
	case "tool":
		name := strings.TrimSpace(value.Name)
		if name == "" {
			return nil
		}
		return map[string]any{
			"type":     "function",
			"function": map[string]any{"name": name},
		}
	default:
		return nil
	}
}
