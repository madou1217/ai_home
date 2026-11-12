package webuisessionmessagesapi

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

func claudeSessionPath(hostHome, projectDirName, sessionID string) string {
	return filepath.Join(hostHome, ".claude", "projects", projectDirName, sessionID+".jsonl")
}

func claudeSessionCursor(hostHome, projectDirName, sessionID string) int64 {
	info, err := os.Stat(claudeSessionPath(hostHome, projectDirName, sessionID))
	if err != nil {
		return 0
	}
	return info.Size()
}

func readClaudeMessages(hostHome, projectDirName, sessionID string) ([]json.RawMessage, error) {
	path := claudeSessionPath(hostHome, projectDirName, sessionID)
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	toolResults := map[string]string{}
	type record struct {
		Type        string `json:"type"`
		UUID        string `json:"uuid"`
		RequestID   string `json:"requestId"`
		ParentUUID  string `json:"parentUuid"`
		Timestamp   string `json:"timestamp"`
		IsSidechain bool   `json:"isSidechain"`
		IsMeta      bool   `json:"isMeta"`
		Message     struct {
			ID      string          `json:"id"`
			Model   string          `json:"model"`
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	var records []record
	scanner := bufio.NewScanner(file)
	buf := make([]byte, 64*1024)
	scanner.Buffer(buf, 8*1024*1024)
	for scanner.Scan() {
		var item record
		if json.Unmarshal(scanner.Bytes(), &item) != nil {
			continue
		}
		records = append(records, item)
		if item.IsSidechain {
			continue
		}
		var blocks []map[string]any
		if json.Unmarshal(item.Message.Content, &blocks) != nil {
			continue
		}
		for _, block := range blocks {
			if block["type"] == "tool_result" {
				if id, ok := block["tool_use_id"].(string); ok {
					toolResults[id] = toolResultText(block["content"])
				}
			}
		}
	}
	messages := []json.RawMessage{}
	for _, item := range records {
		if item.IsSidechain || (item.Type != "user" && item.Type != "assistant") {
			continue
		}
		text, hasOnlyTool, hasImage := claudeContent(item.Message.Content, toolResults)
		if item.Type == "user" && (hasOnlyTool || (item.IsMeta && !hasImage)) {
			continue
		}
		if cut := strings.Index(text, "<system-reminder>"); cut >= 0 {
			text = strings.TrimSpace(text[:cut])
		}
		if strings.HasPrefix(text, "Caveat:") || strings.HasPrefix(text, "<command-name>") || strings.HasPrefix(text, "<local-command") || strings.HasPrefix(text, "<system-reminder>") || strings.HasPrefix(text, "<ide_") {
			continue
		}
		if strings.Contains(text, "<command-name>") || strings.Contains(text, "<local-command-") {
			// 命令回显不是会话消息；Node reader 同样不把它们放进时间线。
			continue
		}
		if strings.TrimSpace(text) == "" {
			continue
		}
		if item.Type == "assistant" && len(messages) > 0 {
			var previous map[string]any
			if json.Unmarshal(messages[len(messages)-1], &previous) == nil && previous["role"] == "assistant" {
				if _, exists := previous["model"]; !exists && item.Message.Model != "" && item.Message.Model != "<synthetic>" {
					previous["model"] = item.Message.Model
				}
				previous["content"] = strings.TrimRight(previous["content"].(string), "\n") + "\n\n" + strings.TrimSpace(text)
				raw, _ := json.Marshal(previous)
				messages[len(messages)-1] = raw
				continue
			}
		}
		message := map[string]any{"role": item.Type, "content": text, "timestamp": item.Timestamp}
		if item.Message.Model != "" && item.Message.Model != "<synthetic>" {
			message["model"] = item.Message.Model
		}
		if item.Type == "assistant" {
			message["images"] = []any{}
		}
		raw, _ := json.Marshal(message)
		messages = append(messages, raw)
	}
	return messages, nil
}

func toolResultText(value any) string {
	switch item := value.(type) {
	case string:
		return strings.TrimSpace(item)
	case []any:
		parts := []string{}
		for _, part := range item {
			if text := toolResultText(part); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n")
	case map[string]any:
		if text, ok := item["text"].(string); ok {
			return strings.TrimSpace(text)
		}
		if content, ok := item["content"]; ok {
			return toolResultText(content)
		}
	}
	return ""
}

func claudeContent(raw json.RawMessage, toolResults map[string]string) (string, bool, bool) {
	var plain string
	if json.Unmarshal(raw, &plain) == nil {
		return strings.TrimSpace(plain), false, false
	}
	var blocks []map[string]any
	if json.Unmarshal(raw, &blocks) != nil {
		return "", false, false
	}
	parts := []string{}
	hasOnlyToolResult := true
	hasImage := false
	for _, block := range blocks {
		kind, _ := block["type"].(string)
		switch kind {
		case "thinking":
			if text, ok := block["thinking"].(string); ok {
				parts = append(parts, ":::thinking\n"+text+"\n:::\n")
			}
			hasOnlyToolResult = false
		case "text":
			if text, ok := block["text"].(string); ok {
				parts = append(parts, text)
			}
			hasOnlyToolResult = false
		case "image":
			hasImage = true
			hasOnlyToolResult = false
		case "tool_use":
			hasOnlyToolResult = false
			name, _ := block["name"].(string)
			id, _ := block["id"].(string)
			body := ""
			if input, ok := block["input"].(map[string]any); ok {
				if command, ok := input["command"].(string); ok {
					body = command
				} else {
					body = compactInput(input)
				}
			}
			section := "\n:::tool{name=\"" + name + "\"}\n" + body + "\n:::\n"
			if result := toolResults[id]; result != "" {
				section += "\n:::tool-result\n" + result + "\n:::\n"
			}
			parts = append(parts, section)
		case "tool_result":
			continue
		}
	}
	return strings.Join(parts, "\n"), hasOnlyToolResult, hasImage
}

func compactInput(input map[string]any) string {
	for _, key := range []string{"file_path", "path", "pattern", "url"} {
		if value, ok := input[key].(string); ok && value != "" {
			return value
		}
	}
	raw, _ := json.Marshal(input)
	if len(raw) > 120 {
		return string(raw[:120]) + "..."
	}
	return string(raw)
}
