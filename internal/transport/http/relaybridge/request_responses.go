package relaybridge

import (
	"encoding/json"
	"strings"
)

// responsesChatRequest 是桥需要读取的 OpenAI Responses 请求字段。
type responsesChatRequest struct {
	Model             string              `json:"model"`
	Instructions      string              `json:"instructions"`
	Input             json.RawMessage     `json:"input"`
	MaxOutputTokens   *int                `json:"max_output_tokens"`
	Temperature       *float64            `json:"temperature"`
	TopP              *float64            `json:"top_p"`
	Stream            bool                `json:"stream"`
	Tools             []responsesTool     `json:"tools"`
	ToolChoice        json.RawMessage     `json:"tool_choice"`
	Reasoning         *responsesReasoning `json:"reasoning"`
	ParallelToolCalls *bool               `json:"parallel_tool_calls"`
	Text              *responsesText      `json:"text"`
}

type responsesReasoning struct {
	Effort string `json:"effort"`
}

type responsesText struct {
	Format *responsesTextFormat `json:"format"`
}

type responsesTextFormat struct {
	Type   string          `json:"type"`
	Name   string          `json:"name"`
	Schema json.RawMessage `json:"schema"`
	Strict *bool           `json:"strict"`
}

type responsesTool struct {
	Type        string          `json:"type"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
	Function    *responsesTool  `json:"function"`
	Input       json.RawMessage `json:"input"`
}

type responsesInputItem struct {
	Type      string          `json:"type"`
	Role      string          `json:"role"`
	Content   json.RawMessage `json:"content"`
	CallID    string          `json:"call_id"`
	Name      string          `json:"name"`
	Arguments string          `json:"arguments"`
	Output    json.RawMessage `json:"output"`
	Input     json.RawMessage `json:"input"`
}

type responsesContentPart struct {
	Type     string          `json:"type"`
	Text     string          `json:"text"`
	ImageURL json.RawMessage `json:"image_url"`
}

// responsesToChat 把 OpenAI Responses 请求转换为 OpenAI Chat 请求。
func responsesToChat(body []byte) ([]byte, error) {
	var request responsesChatRequest
	if err := json.Unmarshal(body, &request); err != nil {
		return nil, err
	}
	out := chatRequestWire{
		Model:  strings.TrimSpace(request.Model),
		Stream: request.Stream,
	}
	if instructions := strings.TrimSpace(request.Instructions); instructions != "" {
		out.Messages = append(out.Messages, chatRequestMessage{Role: "system", Content: instructions})
	}
	inputMessages, err := responsesInputToChat(request.Input)
	if err != nil {
		return nil, err
	}
	out.Messages = append(out.Messages, inputMessages...)
	if request.MaxOutputTokens != nil && *request.MaxOutputTokens > 0 {
		value := *request.MaxOutputTokens
		out.MaxTokens = &value
	}
	out.Temperature = request.Temperature
	out.TopP = request.TopP
	if tools := responsesToolsToChat(request.Tools); len(tools) > 0 {
		out.Tools = tools
	}
	if choice := responsesToolChoice(request.ToolChoice); choice != nil {
		out.ToolChoice = choice
	}
	if request.Reasoning != nil {
		if effort := strings.TrimSpace(request.Reasoning.Effort); effort != "" {
			out.ReasoningEffort = effort
		}
	}
	out.ParallelToolCalls = request.ParallelToolCalls
	if format := responsesResponseFormat(request.Text); format != nil {
		out.ResponseFormat = format
	}
	return json.Marshal(out)
}

func responsesInputToChat(raw json.RawMessage) ([]chatRequestMessage, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil, nil
	}
	if strings.HasPrefix(trimmed, "\"") {
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return nil, err
		}
		return []chatRequestMessage{{Role: "user", Content: text}}, nil
	}
	var rawItems []json.RawMessage
	if err := json.Unmarshal(raw, &rawItems); err != nil {
		return nil, err
	}
	var messages []chatRequestMessage
	for _, rawItem := range rawItems {
		trimmedItem := strings.TrimSpace(string(rawItem))
		if strings.HasPrefix(trimmedItem, "\"") {
			var text string
			if err := json.Unmarshal(rawItem, &text); err != nil {
				return nil, err
			}
			messages = append(messages, chatRequestMessage{Role: "user", Content: text})
			continue
		}
		var item responsesInputItem
		if err := json.Unmarshal(rawItem, &item); err != nil {
			return nil, err
		}
		switch item.Type {
		case "", "message":
			role := strings.ToLower(strings.TrimSpace(item.Role))
			if role == "" {
				role = "user"
			}
			content, err := responsesContentToChat(item.Content)
			if err != nil {
				return nil, err
			}
			messages = append(messages, chatRequestMessage{Role: role, Content: content})
		case "function_call":
			call := chatRequestToolCall{
				ID:   item.CallID,
				Type: "function",
				Function: chatRequestFunction{
					Name:      item.Name,
					Arguments: defaultArguments(item.Arguments),
				},
			}
			// 连续的函数调用合并进同一条 assistant 消息，与 Responses 的
			// function_call 输出项语义一致。
			if len(messages) > 0 && messages[len(messages)-1].Role == "assistant" &&
				len(messages[len(messages)-1].ToolCalls) > 0 {
				messages[len(messages)-1].ToolCalls = append(messages[len(messages)-1].ToolCalls, call)
				continue
			}
			messages = append(messages, chatRequestMessage{
				Role:      "assistant",
				Content:   "",
				ToolCalls: []chatRequestToolCall{call},
			})
		case "function_call_output", "custom_tool_call_output":
			messages = append(messages, chatRequestMessage{
				Role:       "tool",
				ToolCallID: item.CallID,
				Content:    responsesOutputText(item.Output),
			})
		case "custom_tool_call":
			// Codex 的自由文本工具回放：Chat 侧只有「一个字符串参数」这一种表达。
			name := strings.TrimSpace(item.Name)
			if name == "" {
				continue
			}
			input := responsesOutputText(item.Input)
			arguments, _ := json.Marshal(map[string]any{"input": input})
			messages = append(messages, chatRequestMessage{
				Role:    "assistant",
				Content: "",
				ToolCalls: []chatRequestToolCall{{
					ID:   item.CallID,
					Type: "function",
					Function: chatRequestFunction{
						Name:      name,
						Arguments: string(arguments),
					},
				}},
			})
		}
	}
	return messages, nil
}

func responsesContentToChat(raw json.RawMessage) (any, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return "", nil
	}
	if strings.HasPrefix(trimmed, "\"") {
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return nil, err
		}
		return text, nil
	}
	var parts []responsesContentPart
	if err := json.Unmarshal(raw, &parts); err != nil {
		return nil, err
	}
	var textParts []string
	var images []any
	for _, part := range parts {
		switch part.Type {
		case "input_text", "output_text", "text":
			if part.Text != "" {
				textParts = append(textParts, part.Text)
			}
		case "input_image", "image_url":
			if url := responsesImageURL(part.ImageURL); url != "" {
				images = append(images, map[string]any{
					"type":      "image_url",
					"image_url": map[string]any{"url": url},
				})
			}
		}
	}
	text := strings.Join(textParts, "\n")
	if len(images) == 0 {
		return text, nil
	}
	content := make([]any, 0, len(images)+1)
	if text != "" {
		content = append(content, map[string]any{"type": "text", "text": text})
	}
	return append(content, images...), nil
}

func responsesImageURL(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return ""
	}
	if strings.HasPrefix(trimmed, "\"") {
		var url string
		if err := json.Unmarshal(raw, &url); err == nil {
			return url
		}
		return ""
	}
	var object struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(raw, &object); err != nil {
		return ""
	}
	return object.URL
}

func responsesOutputText(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return ""
	}
	if strings.HasPrefix(trimmed, "\"") {
		var text string
		if err := json.Unmarshal(raw, &text); err == nil {
			return text
		}
		return trimmed
	}
	return trimmed
}

func responsesToolsToChat(tools []responsesTool) []chatRequestTool {
	out := make([]chatRequestTool, 0, len(tools))
	for _, tool := range tools {
		if tool.Type != "" && tool.Type != "function" {
			continue
		}
		detail := tool
		if tool.Function != nil {
			detail = *tool.Function
			if detail.Type == "" {
				detail.Type = "function"
			}
		}
		name := strings.TrimSpace(detail.Name)
		if name == "" {
			continue
		}
		parameters := detail.Parameters
		if len(parameters) == 0 || string(parameters) == "null" {
			parameters = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		out = append(out, chatRequestTool{
			Type: "function",
			Function: chatRequestToolDetail{
				Name:        name,
				Description: detail.Description,
				Parameters:  parameters,
			},
		})
	}
	return out
}

func responsesToolChoice(raw json.RawMessage) any {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	if strings.HasPrefix(trimmed, "\"") {
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil
		}
		switch value {
		case "auto", "none", "required":
			return value
		default:
			return nil
		}
	}
	var value struct {
		Type     string `json:"type"`
		Name     string `json:"name"`
		Function *struct {
			Name string `json:"name"`
		} `json:"function"`
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	name := strings.TrimSpace(value.Name)
	if value.Function != nil {
		name = strings.TrimSpace(value.Function.Name)
	}
	if name == "" {
		return nil
	}
	return map[string]any{
		"type":     "function",
		"function": map[string]any{"name": name},
	}
}

// responsesResponseFormat 把 Responses 的 text.format 映射为 Chat 的 response_format。
func responsesResponseFormat(text *responsesText) any {
	if text == nil || text.Format == nil {
		return nil
	}
	format := text.Format
	if format.Type != "json_schema" || len(format.Schema) == 0 {
		return nil
	}
	name := strings.TrimSpace(format.Name)
	if name == "" {
		name = "response"
	}
	schema := map[string]any{
		"name":   name,
		"schema": format.Schema,
	}
	if format.Strict != nil {
		schema["strict"] = *format.Strict
	}
	return map[string]any{
		"type":        "json_schema",
		"json_schema": schema,
	}
}

func defaultArguments(arguments string) string {
	trimmed := strings.TrimSpace(arguments)
	if trimmed == "" || !strings.HasPrefix(trimmed, "{") {
		return "{}"
	}
	return trimmed
}
