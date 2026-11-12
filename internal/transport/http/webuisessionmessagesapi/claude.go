package webuisessionmessagesapi

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

var (
	claudeSystemReminderBlock = regexp.MustCompile("(?s)<system-reminder>.*?</system-reminder>")
	claudeIDEOpenedBlock      = regexp.MustCompile("(?s)<ide_opened_file>.*?</ide_opened_file>")
	claudeIDEBlock            = regexp.MustCompile("(?s)<ide_[^>]*>.*?</ide_[^>]*>")
)

type claudeRecord struct {
	Type        string `json:"type"`
	UUID        string `json:"uuid"`
	RequestID   string `json:"requestId"`
	ParentUUID  string `json:"parentUuid"`
	Timestamp   string `json:"timestamp"`
	IsSidechain bool   `json:"isSidechain"`
	IsMeta      bool   `json:"isMeta"`
	Message     struct {
		ID        string          `json:"id"`
		Model     string          `json:"model"`
		Timestamp string          `json:"timestamp"`
		Content   json.RawMessage `json:"content"`
	} `json:"message"`
}

func claudeSessionPath(hostHome, projectDirName, sessionID string) string {
	return filepath.Join(hostHome, ".claude", "projects", strings.TrimSpace(projectDirName), strings.TrimSpace(sessionID)+".jsonl")
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
	var records []claudeRecord
	scanner := bufio.NewScanner(file)
	buf := make([]byte, 64*1024)
	scanner.Buffer(buf, 8*1024*1024)
	for scanner.Scan() {
		var item claudeRecord
		if json.Unmarshal(scanner.Bytes(), &item) != nil {
			continue
		}
		records = append(records, item)
	}
	// 第一遍：收集 tool_result，第二遍把结果合并回对应 assistant 工具块（同 Node 两遍读取）。
	toolResults := map[string]string{}
	for _, item := range records {
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
					toolResults[id] = trimToolResultText(toolResultText(block["content"]))
				}
			}
		}
	}
	messages := []json.RawMessage{}
	hiddenMetaUserIDs := map[string]bool{}
	lastAssistantBoundaryKey := ""
	for _, item := range records {
		if item.IsSidechain || (item.Type != "user" && item.Type != "assistant") {
			continue
		}
		text, hasOnlyTool, hasImage := claudeContent(item.Message.Content, toolResults)
		if item.Type == "user" && hasOnlyTool {
			continue
		}
		if item.Type == "user" && item.IsMeta && !hasImage {
			// Claude --resume 会写入内部恢复 turn：isMeta user + <synthetic> assistant。
			// 只有携带图片定位信息的 meta user 属于展示消息的补充元数据，其余不能冒充用户输入。
			if recordID := strings.TrimSpace(item.UUID); recordID != "" {
				hiddenMetaUserIDs[recordID] = true
			}
			continue
		}
		if item.Type == "assistant" && strings.TrimSpace(item.Message.Model) == "<synthetic>" && hiddenMetaUserIDs[strings.TrimSpace(item.ParentUUID)] {
			continue
		}
		if text == "" && !hasImage {
			continue
		}
		if strings.HasPrefix(text, "Caveat:") || strings.HasPrefix(text, "<command-name>") || strings.HasPrefix(text, "<local-command") || strings.HasPrefix(text, "<system-reminder>") || strings.HasPrefix(text, "<ide_") {
			continue
		}
		cleanText := claudeSystemReminderBlock.ReplaceAllString(text, "")
		cleanText = claudeIDEOpenedBlock.ReplaceAllString(cleanText, "")
		cleanText = claudeIDEBlock.ReplaceAllString(cleanText, "")
		cleanText = strings.TrimSpace(cleanText)
		if cleanText == "" && !hasImage {
			continue
		}
		timestamp := item.Timestamp
		if timestamp == "" {
			timestamp = item.Message.Timestamp
		}
		nextMessage := map[string]any{"role": item.Type, "content": cleanText, "timestamp": timestamp}
		if item.Type == "assistant" {
			model := strings.TrimSpace(item.Message.Model)
			if model != "" && model != "<synthetic>" {
				nextMessage["model"] = model
			}
		}
		nextAssistantBoundaryKey := ""
		if item.Type == "assistant" {
			nextAssistantBoundaryKey = claudeAssistantBoundaryKey(item)
		}
		if mergeClaudeAssistantMessage(messages, nextMessage, lastAssistantBoundaryKey, nextAssistantBoundaryKey) {
			lastAssistantBoundaryKey = nextAssistantBoundaryKey
			continue
		}
		if mergeClaudeUserMessage(messages, nextMessage) {
			lastAssistantBoundaryKey = ""
			continue
		}
		raw, _ := json.Marshal(nextMessage)
		messages = append(messages, raw)
		lastAssistantBoundaryKey = nextAssistantBoundaryKey
	}
	return decorateTurnModels(messages), nil
}

func claudeAssistantBoundaryKey(record claudeRecord) string {
	if requestID := strings.TrimSpace(record.RequestID); requestID != "" {
		return "request:" + requestID
	}
	return ""
}

// mergeClaudeAssistantMessage mirrors Node tryMergeClaudeAssistantMessage:
// only merge assistant transcripts that belong to the same request boundary.
func mergeClaudeAssistantMessage(messages []json.RawMessage, next map[string]any, previousKey, nextKey string) bool {
	if next["role"] != "assistant" || len(messages) == 0 {
		return false
	}
	var previous map[string]any
	if json.Unmarshal(messages[len(messages)-1], &previous) != nil || previous["role"] != "assistant" {
		return false
	}
	if (previousKey != "" || nextKey != "") && previousKey != nextKey {
		return false
	}
	previousContent, _ := previous["content"].(string)
	nextContent, _ := next["content"].(string)
	merged := []string{}
	if value := strings.TrimSpace(previousContent); value != "" {
		merged = append(merged, value)
	}
	if value := strings.TrimSpace(nextContent); value != "" {
		merged = append(merged, value)
	}
	previous["content"] = strings.Join(merged, "\n\n")
	previous["images"] = []any{}
	if timestamp, _ := previous["timestamp"].(string); timestamp == "" {
		previous["timestamp"] = next["timestamp"]
	}
	if model, _ := previous["model"].(string); model == "" {
		if nextModel, _ := next["model"].(string); nextModel != "" {
			previous["model"] = nextModel
		}
	}
	raw, err := json.Marshal(previous)
	if err != nil {
		return false
	}
	messages[len(messages)-1] = raw
	return true
}

// mergeClaudeUserMessage mirrors Node tryMergeClaudeUserMessage: adjacent user
// transcripts with the same/empty text and near-identical timestamps are one turn.
func mergeClaudeUserMessage(messages []json.RawMessage, next map[string]any) bool {
	if next["role"] != "user" || len(messages) == 0 {
		return false
	}
	var previous map[string]any
	if json.Unmarshal(messages[len(messages)-1], &previous) != nil || previous["role"] != "user" {
		return false
	}
	previousTimestamp, _ := previous["timestamp"].(string)
	nextTimestamp, _ := next["timestamp"].(string)
	if !closeClaudeTimestamps(previousTimestamp, nextTimestamp) {
		return false
	}
	previousContent, _ := previous["content"].(string)
	nextContent, _ := next["content"].(string)
	previousTrimmed := strings.TrimSpace(previousContent)
	nextTrimmed := strings.TrimSpace(nextContent)
	if previousTrimmed != "" && nextTrimmed != "" && previousTrimmed != nextTrimmed {
		return false
	}
	if previousTrimmed == "" {
		previousTrimmed = nextTrimmed
	}
	previous["content"] = previousTrimmed
	previous["images"] = []any{}
	if previousTimestamp == "" {
		previous["timestamp"] = nextTimestamp
	}
	raw, err := json.Marshal(previous)
	if err != nil {
		return false
	}
	messages[len(messages)-1] = raw
	return true
}

func closeClaudeTimestamps(left, right string) bool {
	leftMs, leftOK := claudeTimestampMs(left)
	rightMs, rightOK := claudeTimestampMs(right)
	if !leftOK || !rightOK {
		return left == right
	}
	diff := leftMs - rightMs
	if diff < 0 {
		diff = -diff
	}
	return diff <= 1000
}

func claudeTimestampMs(value string) (int64, bool) {
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		return 0, false
	}
	return parsed.UnixMilli(), true
}

func trimToolResultText(text string) string {
	text = strings.TrimSpace(text)
	runes := []rune(text)
	if len(runes) > 300 {
		return string(runes[:300]) + "..."
	}
	return text
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
		return plain, false, false
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
			if text, ok := block["thinking"].(string); ok && text != "" {
				parts = append(parts, "\n:::thinking\n"+text+"\n:::\n")
				hasOnlyToolResult = false
			}
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
			if name == "" {
				name = "Unknown"
			}
			id, _ := block["id"].(string)
			input, _ := block["input"].(map[string]any)
			if input == nil {
				input = map[string]any{}
			}
			if name == "ExitPlanMode" && truthyString(input["plan"]) {
				parts = append(parts, "\n<proposed_plan>\n"+strings.TrimSpace(input["plan"].(string))+"\n</proposed_plan>\n")
				continue
			}
			if name == "TaskCreate" || name == "TaskUpdate" {
				status, _ := input["status"].(string)
				if status == "" && name == "TaskCreate" {
					status = "created"
				}
				taskID := firstString(input, "taskId", "id")
				summary := firstString(input, "subject", "description", "summary")
				if summary == "" {
					summary = name
				}
				payload, _ := json.Marshal(struct {
					TaskID     string `json:"taskId"`
					ToolUseID  string `json:"toolUseId"`
					OutputFile string `json:"outputFile"`
					Status     string `json:"status"`
					Summary    string `json:"summary"`
				}{TaskID: taskID, ToolUseID: id, OutputFile: firstString(input, "outputFile", "output_file"), Status: status, Summary: summary})
				parts = append(parts, "\n<task-notification>\n"+string(payload)+"\n</task-notification>\n")
				continue
			}
			body := ""
			switch {
			case name == "Bash" && truthyString(input["command"]):
				body, _ = input["command"].(string)
			case name == "TodoWrite" && input["todos"] != nil:
				payload, _ := json.Marshal(input["todos"])
				body = string(payload)
			case (name == "Task" || name == "update_plan") && firstNonNil(input["tasks"], input["plan"], input["items"]) != nil:
				key := "tasks"
				if name == "update_plan" {
					key = "plan"
				}
				payload, _ := json.Marshal(map[string]any{
					"explanation": input["explanation"],
					key:           firstNonNil(input["tasks"], input["plan"], input["items"]),
				})
				body = string(payload)
			case (name == "Read" || name == "Write" || name == "Edit") && truthyString(input["file_path"]):
				body, _ = input["file_path"].(string)
			case name == "Grep" && truthyString(input["pattern"]):
				pattern, _ := input["pattern"].(string)
				body = pattern
				if path, ok := input["path"].(string); ok && path != "" {
					body += " in " + path
				}
			case name == "Glob" && truthyString(input["pattern"]):
				body, _ = input["pattern"].(string)
			case name == "WebFetch" && truthyString(input["url"]):
				body, _ = input["url"].(string)
			default:
				body = compactInput(input)
			}
			section := "\n:::tool{name=\"" + name + "\"}\n" + body + "\n:::\n"
			if result, ok := toolResults[id]; ok && result != "" {
				section += "\n:::tool-result\n" + result + "\n:::\n"
			}
			parts = append(parts, section)
		case "tool_result":
			continue
		}
	}
	return strings.Join(filterNonEmpty(parts), "\n"), hasOnlyToolResult, hasImage
}

func filterNonEmpty(parts []string) []string {
	filtered := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			filtered = append(filtered, part)
		}
	}
	return filtered
}

func truthyString(value any) bool {
	text, ok := value.(string)
	return ok && text != ""
}

func firstString(input map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := input[key].(string); ok && value != "" {
			return value
		}
	}
	return ""
}

func firstNonNil(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

// compactInput mirrors Node's generic tool input rendering: "key: value" lines,
// strings over 60 chars truncated with an ellipsis, everything else JSON sliced.
func compactInput(input map[string]any) string {
	keys := make([]string, 0, len(input))
	for key := range input {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	lines := make([]string, 0, len(keys))
	for _, key := range keys {
		value := input[key]
		rendered := ""
		if text, ok := value.(string); ok {
			rendered = text
			if len([]rune(rendered)) > 60 {
				rendered = string([]rune(rendered)[:60]) + "..."
			}
		} else {
			raw, _ := json.Marshal(value)
			rendered = string(raw)
			if len([]rune(rendered)) > 60 {
				rendered = string([]rune(rendered)[:60])
			}
		}
		lines = append(lines, key+": "+rendered)
	}
	return strings.Join(lines, "\n")
}

func previousRole(messages []json.RawMessage) string {
	if len(messages) == 0 {
		return ""
	}
	var previous map[string]any
	if json.Unmarshal(messages[len(messages)-1], &previous) != nil {
		return ""
	}
	role, _ := previous["role"].(string)
	return role
}
