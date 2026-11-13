package sessionread

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/internal/sessionscan/legacy"
)

var (
	claudeSystemReminderBlock = regexp.MustCompile(`(?s)<system-reminder>.*?</system-reminder>`)
	claudeIDEOpenedBlock      = regexp.MustCompile(`(?s)<ide_opened_file>.*?</ide_opened_file>`)
	claudeIDEBlock            = regexp.MustCompile(`(?s)<ide_[^>]*>.*?</ide_[^>]*>`)
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

func readClaudeKnownPaths(hostHome string) []string {
	raw, err := os.ReadFile(filepath.Join(hostHome, ".claude.json"))
	if err != nil {
		return nil
	}
	var payload struct {
		Projects map[string]any `json:"projects"`
	}
	if json.Unmarshal(raw, &payload) != nil || len(payload.Projects) == 0 {
		return nil
	}
	paths := make([]string, 0, len(payload.Projects))
	for projectPath := range payload.Projects {
		if trimmed := strings.TrimSpace(projectPath); trimmed != "" {
			paths = append(paths, trimmed)
		}
	}
	sort.Strings(paths)
	return paths
}

// ListClaudeProjects 读取 ~/.claude/projects 下的全部项目与会话。
func ListClaudeProjects(hostHome string) []Project {
	home := strings.TrimSpace(hostHome)
	if home == "" {
		return []Project{}
	}
	rawProjects := legacy.ReadClaudeProjects(home, readClaudeKnownPaths(home))
	out := make([]Project, 0, len(rawProjects))
	for _, p := range rawProjects {
		sessions := make([]Session, 0, len(p.Sessions))
		for _, s := range p.Sessions {
			sessions = append(sessions, Session{
				ID:             s.ID,
				Title:          s.Title,
				UpdatedAt:      s.UpdatedAt,
				Provider:       s.Provider,
				ProjectDirName: s.ProjectDirName,
			})
		}
		out = append(out, Project{
			ID:       p.ID,
			Name:     p.Name,
			Path:     p.Path,
			Sessions: sessions,
			Provider: p.Provider,
		})
	}
	return out
}

// ResolveClaudeSessionPath 定位 ~/.claude/projects/<projectDirName>/<sessionId>.jsonl；
// 未指定 projectDirName 时扫描全部项目目录寻找第一个匹配的会话文件。
func ResolveClaudeSessionPath(hostHome, sessionID, projectDirName string) string {
	home := strings.TrimSpace(hostHome)
	sid := strings.TrimSpace(sessionID)
	if home == "" || !IsSafePathSegment(sid) {
		return ""
	}
	projectsDir := filepath.Join(home, ".claude", "projects")
	if dirName := strings.TrimSpace(projectDirName); dirName != "" {
		if !IsSafePathSegment(dirName) {
			return ""
		}
		candidate := filepath.Join(projectsDir, dirName, sid+".jsonl")
		if fileExistsRegular(candidate) {
			return candidate
		}
		return ""
	}
	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		return ""
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		if !entry.IsDir() || !IsSafePathSegment(entry.Name()) {
			continue
		}
		candidate := filepath.Join(projectsDir, entry.Name(), sid+".jsonl")
		if fileExistsRegular(candidate) {
			return candidate
		}
	}
	return ""
}

// ReadClaudeMessages 解析 Claude JSONL 消息记录，对齐 Node readClaudeSessionMessages。
func ReadClaudeMessages(hostHome, sessionID, projectDirName string) ([]json.RawMessage, int64, bool, error) {
	path := ResolveClaudeSessionPath(hostHome, sessionID, projectDirName)
	if path == "" {
		return nil, 0, false, nil
	}
	records, cursor, err := readClaudeRecordsFile(path)
	if err != nil {
		return nil, 0, true, err
	}
	messages := extractClaudeMessages(records)
	return messages, cursor, true, nil
}

func readClaudeRecordsFile(path string) ([]claudeRecord, int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, 0, err
	}
	records := make([]claudeRecord, 0, 64)
	err = forEachJSONLLine(path, func(line []byte) bool {
		var record claudeRecord
		if json.Unmarshal(line, &record) == nil {
			records = append(records, record)
		}
		return true
	})
	if err != nil {
		return nil, 0, err
	}
	return records, info.Size(), nil
}

func extractClaudeMessages(records []claudeRecord) []json.RawMessage {
	toolResultByID := make(map[string]string)
	for _, record := range records {
		if record.Type != "user" {
			continue
		}
		for _, block := range parseClaudeBlocks(record.Message.Content) {
			if block["type"] == "tool_result" {
				toolUseID, _ := block["tool_use_id"].(string)
				if toolUseID != "" {
					toolResultByID[toolUseID] = extractClaudeToolResultContent(block["content"])
				}
			}
		}
	}

	rawMessages := make([]map[string]any, 0, len(records))
	for _, record := range records {
		if record.IsSidechain || record.IsMeta {
			continue
		}
		if record.Type == "user" {
			content, images := extractClaudeUserContent(record.Message.Content)
			if strings.TrimSpace(content) != "" || len(images) > 0 {
				rawMessages = append(rawMessages, map[string]any{
					"role":      "user",
					"content":   content,
					"images":    images,
					"timestamp": firstNonEmpty(record.Timestamp, record.Message.Timestamp),
				})
			}
			continue
		}
		if record.Type == "assistant" {
			blocks := parseClaudeBlocks(record.Message.Content)
			if len(blocks) == 0 && strings.TrimSpace(string(record.Message.Content)) != "" {
				var text string
				if json.Unmarshal(record.Message.Content, &text) == nil && strings.TrimSpace(text) != "" {
					msg := map[string]any{
						"role":      "assistant",
						"content":   text,
						"timestamp": firstNonEmpty(record.Timestamp, record.Message.Timestamp),
					}
					if m := NormalizeMessageModel(record.Message.Model); m != "" {
						msg["model"] = m
					}
					rawMessages = append(rawMessages, msg)
				}
				continue
			}
			var parts []string
			for _, block := range blocks {
				if part := formatClaudeAssistantBlock(block, toolResultByID); part != "" {
					parts = append(parts, part)
				}
			}
			if len(parts) > 0 {
				msg := map[string]any{
					"role":        "assistant",
					"content":     strings.Join(parts, ""),
					"timestamp":   firstNonEmpty(record.Timestamp, record.Message.Timestamp),
					"_messageKey": firstNonEmpty(record.Message.ID, record.RequestID, record.UUID),
				}
				if m := NormalizeMessageModel(record.Message.Model); m != "" {
					msg["model"] = m
				}
				rawMessages = append(rawMessages, msg)
			}
		}
	}

	merged := make([]json.RawMessage, 0, len(rawMessages))
	for i := 0; i < len(rawMessages); i++ {
		msg := rawMessages[i]
		role, _ := msg["role"].(string)
		if role == "assistant" && len(merged) > 0 {
			var prev map[string]any
			if json.Unmarshal(merged[len(merged)-1], &prev) == nil && prev["role"] == "assistant" {
				sameStream := true
				prevKey, _ := prev["_messageKey"].(string)
				currKey, _ := msg["_messageKey"].(string)
				if prevKey != "" && currKey != "" {
					sameStream = prevKey == currKey
				}
				if sameStream {
					prevContent, _ := prev["content"].(string)
					currContent, _ := msg["content"].(string)
					prev["content"] = prevContent + "\n" + currContent
					if currModel := NormalizeMessageModel(stringFromAny(msg["model"])); currModel != "" {
						prev["model"] = currModel
					}
					raw, _ := json.Marshal(prev)
					merged[len(merged)-1] = raw
					continue
				}
			}
		}
		delete(msg, "_messageKey")
		raw, _ := json.Marshal(msg)
		merged = append(merged, raw)
	}

	for i := 0; i < len(merged); i++ {
		var msg map[string]any
		if json.Unmarshal(merged[i], &msg) == nil {
			if _, has := msg["_messageKey"]; has {
				delete(msg, "_messageKey")
				raw, _ := json.Marshal(msg)
				merged[i] = raw
			}
		}
	}
	return merged
}

func parseClaudeBlocks(raw json.RawMessage) []map[string]any {
	var blocks []map[string]any
	if json.Unmarshal(raw, &blocks) == nil {
		return blocks
	}
	return nil
}

func extractClaudeUserContent(raw json.RawMessage) (string, []map[string]any) {
	images := []map[string]any{}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return cleanClaudeUserText(text), images
	}
	var texts []string
	for _, block := range parseClaudeBlocks(raw) {
		switch block["type"] {
		case "text":
			if cleaned := cleanClaudeUserText(stringFromAny(block["text"])); cleaned != "" {
				texts = append(texts, cleaned)
			}
		case "image":
			source, _ := block["source"].(map[string]any)
			if source["type"] == "base64" {
				mediaType := firstNonEmpty(stringFromAny(source["media_type"]), "image/png")
				data := stringFromAny(source["data"])
				if data != "" {
					images = append(images, map[string]any{
						"dataUrl":   "data:" + mediaType + ";base64," + data,
						"mediaType": mediaType,
					})
				}
			}
		}
	}
	return strings.Join(texts, "\n"), images
}

func cleanClaudeUserText(text string) string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" || strings.HasPrefix(trimmed, "<local-command-") || strings.HasPrefix(trimmed, "<command-name>") ||
		strings.Contains(trimmed, "This session is being continued from a previous conversation") ||
		trimmed == "Caveat: The messages below were generated by the user while running local commands. DO NOT EXPECT THEM TO BE RELEVANT TO THE CURRENT TASK." {
		return ""
	}
	trimmed = claudeSystemReminderBlock.ReplaceAllString(trimmed, "")
	trimmed = claudeIDEOpenedBlock.ReplaceAllString(trimmed, "")
	trimmed = claudeIDEBlock.ReplaceAllString(trimmed, "")
	return strings.TrimSpace(trimmed)
}

func formatClaudeAssistantBlock(block map[string]any, toolResultByID map[string]string) string {
	switch block["type"] {
	case "text":
		return stringFromAny(block["text"])
	case "thinking":
		thinking := strings.TrimSpace(stringFromAny(block["thinking"]))
		if thinking == "" {
			return ""
		}
		return "\n:::thinking\n" + thinking + "\n:::\n"
	case "tool_use":
		name := firstNonEmpty(stringFromAny(block["name"]), "Unknown")
		input, _ := block["input"].(map[string]any)
		body := formatClaudeToolInput(name, input)
		out := "\n:::tool{name=\"" + name + "\"}\n" + body + "\n:::\n"
		if id := stringFromAny(block["id"]); id != "" {
			if result := toolResultByID[id]; result != "" {
				out += "\n:::tool-result\n" + result + "\n:::\n"
			}
		}
		return out
	default:
		return ""
	}
}

func formatClaudeToolInput(name string, input map[string]any) string {
	switch name {
	case "Bash":
		return stringFromAny(input["command"])
	case "Read", "Edit", "Write":
		return stringFromAny(input["file_path"])
	case "Grep", "Glob":
		return stringFromAny(input["pattern"])
	case "TodoWrite", "Task", "AskUserQuestion":
		raw, _ := json.Marshal(input)
		return string(raw)
	default:
		raw, _ := json.Marshal(input)
		s := string(raw)
		if len(s) > 200 {
			return s[:200]
		}
		return s
	}
}

func extractClaudeToolResultContent(content any) string {
	var text string
	switch typed := content.(type) {
	case string:
		text = typed
	case []any:
		var parts []string
		for _, item := range typed {
			if obj, ok := item.(map[string]any); ok && obj["type"] == "text" {
				if t := stringFromAny(obj["text"]); t != "" {
					parts = append(parts, t)
				}
			}
		}
		text = strings.Join(parts, "\n")
	default:
		if typed != nil {
			raw, _ := json.Marshal(typed)
			text = string(raw)
		}
	}
	if len(text) > 300 {
		return text[:300]
	}
	return text
}
