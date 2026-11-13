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
	agyUserRequestPattern   = regexp.MustCompile(`(?s)<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>`)
	agySettingsBlockPattern = regexp.MustCompile(`(?is)<USER_SETTINGS_CHANGE>\s*(.*?)\s*</USER_SETTINGS_CHANGE>`)
	agyModelSelectPattern   = regexp.MustCompile(`(?is)changed setting ` + "`Model Selection`" + ` from .*? to (.*?)(?:\.\s+No need to comment|\.\s+If reporting|$)`)
	agySystemBlockPattern   = regexp.MustCompile(`(?is)<SYSTEM_MESSAGE>\s*(.*?)\s*(?:</SYSTEM_MESSAGE>|$)`)
	agyContentEqPattern     = regexp.MustCompile(`(?s)\bcontent=(.+)$`)
	agyInternalNoticeRegex  = regexp.MustCompile(`(?is)(?:not actually sent by the user|^\s*\[Notice\]|subagents?.{0,60}(?:stopped|revived|background task))`)
	agyFileURIPathPattern   = regexp.MustCompile(`(?i)File Path:\s*` + "`file://([^`]+)`")
	agyFileLinePathPattern  = regexp.MustCompile(`(?i)File Path:\s*([^\n]+)`)
)

// ReadGeminiProjectNameMappings 读取 ~/.gemini/projects.json 里的路径->显示名映射。
func ReadGeminiProjectNameMappings(hostHome string) map[string]string {
	home := strings.TrimSpace(hostHome)
	if home == "" {
		return nil
	}
	raw, err := os.ReadFile(filepath.Join(home, ".gemini", "projects.json"))
	if err != nil {
		return nil
	}
	var payload struct {
		Projects map[string]string `json:"projects"`
	}
	if json.Unmarshal(raw, &payload) != nil || len(payload.Projects) == 0 {
		return nil
	}
	return payload.Projects
}

// ApplyProjectNameMappings 对所有项目应用 ~/.gemini/projects.json 的友好名称覆盖。
func ApplyProjectNameMappings(projects []Project, mappings map[string]string) []Project {
	if len(projects) == 0 || len(mappings) == 0 {
		return projects
	}
	normalizeKey := func(p string) string {
		r := strings.NewReplacer("/", "", "_", "")
		return r.Replace(p)
	}
	for i := range projects {
		projPath := projects[i].Path
		if projPath == "" {
			continue
		}
		if mapped, ok := mappings[projPath]; ok && strings.TrimSpace(mapped) != "" {
			projects[i].Name = mapped
			continue
		}
		targetNorm := normalizeKey(projPath)
		for mapPath, mapName := range mappings {
			if targetNorm == normalizeKey(mapPath) && strings.TrimSpace(mapName) != "" {
				projects[i].Name = mapName
				break
			}
		}
	}
	return projects
}

// ListGeminiProjects 扫描 ~/.gemini/tmp/<project>/chats 下的会话项目。
func ListGeminiProjects(hostHome string) []Project {
	home := strings.TrimSpace(hostHome)
	if home == "" {
		return []Project{}
	}
	raw := legacy.ReadGeminiProjects(home)
	out := make([]Project, 0, len(raw))
	for _, p := range raw {
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

// ResolveGeminiSessionPath 定位 Gemini 会话文件（.json 或 .jsonl），存在多文件时选取最新 mtimeMs。
func ResolveGeminiSessionPath(hostHome, sessionID, projectDirName string) string {
	home := strings.TrimSpace(hostHome)
	sid := strings.TrimSpace(sessionID)
	if home == "" || !IsSafePathSegment(sid) {
		return ""
	}
	tmpDir := filepath.Join(home, ".gemini", "tmp")
	if !dirExists(tmpDir) {
		return ""
	}

	readFileSessionID := func(filePath string) string {
		if strings.Contains(filepath.Base(filePath), sid) {
			return sid
		}
		if strings.HasSuffix(filePath, ".jsonl") {
			found := ""
			_ = forEachJSONLLine(filePath, func(line []byte) bool {
				var rec struct {
					SessionID string `json:"sessionId"`
				}
				if json.Unmarshal(line, &rec) == nil && strings.TrimSpace(rec.SessionID) != "" {
					found = strings.TrimSpace(rec.SessionID)
				}
				return false
			})
			return found
		}
		raw, err := os.ReadFile(filePath)
		if err != nil {
			return ""
		}
		var doc struct {
			SessionID string `json:"sessionId"`
		}
		if json.Unmarshal(raw, &doc) == nil {
			return strings.TrimSpace(doc.SessionID)
		}
		return ""
	}

	bestPath := ""
	bestMtime := int64(-1)
	considerDir := func(chatsDir string) {
		entries, err := os.ReadDir(chatsDir)
		if err != nil {
			return
		}
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			name := entry.Name()
			if !strings.HasSuffix(name, ".json") && !strings.HasSuffix(name, ".jsonl") {
				continue
			}
			fp := filepath.Join(chatsDir, name)
			if readFileSessionID(fp) != sid {
				continue
			}
			_, mtime, ok := fileSizeAndMtimeMs(fp)
			if !ok {
				continue
			}
			if mtime > bestMtime {
				bestMtime = mtime
				bestPath = fp
			}
		}
	}

	if projDir := strings.TrimSpace(projectDirName); projDir != "" {
		if !IsSafePathSegment(projDir) {
			return ""
		}
		considerDir(filepath.Join(tmpDir, projDir, "chats"))
		return bestPath
	}

	entries, err := os.ReadDir(tmpDir)
	if err != nil {
		return ""
	}
	for _, entry := range entries {
		if !entry.IsDir() || !IsSafePathSegment(entry.Name()) {
			continue
		}
		considerDir(filepath.Join(tmpDir, entry.Name(), "chats"))
	}
	return bestPath
}

// ReadGeminiMessages 读取并转换 Gemini .json / .jsonl 会话记录。
func ReadGeminiMessages(hostHome, sessionID, projectDirName string) ([]Message, int64, bool, error) {
	filePath := ResolveGeminiSessionPath(hostHome, sessionID, projectDirName)
	if filePath == "" {
		return nil, 0, false, nil
	}
	size, _, ok := fileSizeAndMtimeMs(filePath)
	if !ok {
		return nil, 0, false, nil
	}

	if strings.HasSuffix(filePath, ".jsonl") {
		messages := make([]Message, 0, 32)
		err := forEachJSONLLine(filePath, func(line []byte) bool {
			var rec map[string]any
			if json.Unmarshal(line, &rec) == nil {
				appendGeminiRecord(&messages, rec)
			}
			return true
		})
		if err != nil {
			return nil, 0, true, err
		}
		return messages, size, true, nil
	}

	raw, err := os.ReadFile(filePath)
	if err != nil {
		return nil, 0, true, err
	}
	var doc struct {
		Messages []map[string]any `json:"messages"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, 0, true, err
	}
	messages := make([]Message, 0, len(doc.Messages))
	for _, rec := range doc.Messages {
		appendGeminiRecord(&messages, rec)
	}
	return messages, size, true, nil
}

func appendGeminiRecord(messages *[]Message, rec map[string]any) {
	if rec == nil {
		return
	}
	recType := stringFromAny(rec["type"])
	ts := stringFromAny(rec["timestamp"])
	switch recType {
	case "user":
		text := normalizeGeminiTextContent(rec["content"])
		if text != "" {
			*messages = append(*messages, Message{
				Role:      "user",
				Content:   text,
				Timestamp: ts,
			})
		}
	case "gemini":
		blocks := geminiRecordToBlocks(rec)
		rendered := renderProviderBlocks(blocks)
		if rendered == "" {
			return
		}
		*messages = append(*messages, Message{
			Role:      "assistant",
			Content:   rendered,
			Model:     NormalizeMessageModel(stringFromAny(rec["model"])),
			Timestamp: ts,
		})
	}
}

func normalizeGeminiTextContent(content any) string {
	switch typed := content.(type) {
	case string:
		return compactMultilineText(typed)
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			obj, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if text := compactMultilineText(stringFromAny(obj["text"])); text != "" {
				parts = append(parts, text)
				continue
			}
			if obj["inlineData"] != nil {
				parts = append(parts, "[Image]")
				continue
			}
			if fd, ok := obj["fileData"].(map[string]any); ok {
				if uri := compactMultilineText(stringFromAny(fd["fileUri"])); uri != "" {
					parts = append(parts, "[File: "+uri+"]")
				}
			}
		}
		return strings.TrimSpace(strings.Join(parts, "\n"))
	default:
		return ""
	}
}

func geminiRecordToBlocks(rec map[string]any) []map[string]any {
	blocks := make([]map[string]any, 0, 8)
	if thoughts, ok := rec["thoughts"].([]any); ok {
		for _, t := range thoughts {
			tobj, ok := t.(map[string]any)
			if !ok {
				continue
			}
			desc := compactMultilineText(stringFromAny(tobj["description"]))
			if desc == "" {
				continue
			}
			blocks = append(blocks, map[string]any{
				"type":  "reasoning",
				"title": compactMultilineText(stringFromAny(tobj["subject"])),
				"text":  desc,
			})
		}
	}
	if text := normalizeGeminiTextContent(rec["content"]); text != "" {
		blocks = append(blocks, map[string]any{"type": "text", "text": text})
	}
	if calls, ok := rec["toolCalls"].([]any); ok {
		for _, c := range calls {
			cobj, ok := c.(map[string]any)
			if !ok {
				continue
			}
			name := firstNonEmpty(compactMultilineText(stringFromAny(cobj["name"])), compactMultilineText(stringFromAny(cobj["displayName"])), "GeminiTool")
			args := cobj["args"]
			if args == nil {
				args = map[string]any{}
			}
			blocks = append(blocks, map[string]any{
				"type":   "tool_call",
				"name":   name,
				"args":   args,
				"result": normalizeGeminiToolResult(cobj),
			})
		}
	}
	return blocks
}

func normalizeGeminiToolResult(toolCall map[string]any) string {
	if disp := compactMultilineText(stringFromAny(toolCall["resultDisplay"])); disp != "" {
		return disp
	}
	res := toolCall["result"]
	if res == nil {
		return ""
	}
	switch typed := res.(type) {
	case string:
		return compactMultilineText(typed)
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			if s, ok := item.(string); ok {
				parts = append(parts, s)
			} else {
				raw, _ := json.Marshal(item)
				parts = append(parts, string(raw))
			}
		}
		return compactMultilineText(strings.Join(parts, "\n"))
	default:
		raw, _ := json.Marshal(typed)
		return string(raw)
	}
}

// ListAgyProjects 读取 ~/.gemini/antigravity-cli/aih-session-projects.json 索引与对应 brain transcript。
func ListAgyProjects(hostHome string) []Project {
	home := strings.TrimSpace(hostHome)
	if home == "" {
		return []Project{}
	}
	indexPath := filepath.Join(home, ".gemini", "antigravity-cli", "aih-session-projects.json")
	raw, err := os.ReadFile(indexPath)
	if err != nil {
		return []Project{}
	}
	var index map[string]struct {
		ProjectPath string `json:"projectPath"`
		UpdatedAt   any    `json:"updatedAt"`
	}
	if json.Unmarshal(raw, &index) != nil || len(index) == 0 {
		return []Project{}
	}

	byPath := make(map[string][]Session)
	for rawID, entry := range index {
		sid := strings.TrimSpace(rawID)
		projPath := NormalizeProjectPath(entry.ProjectPath)
		if sid == "" || projPath == "" {
			continue
		}
		transcriptPath := ResolveAgySessionPath(home, sid)
		if transcriptPath == "" {
			continue
		}
		messages, _, _, readErr := readAgyMessagesFromFile(transcriptPath)
		if readErr != nil {
			continue
		}
		title := ""
		for _, m := range messages {
			if m.Role == "user" && strings.TrimSpace(m.Content) != "" {
				runes := []rune(strings.TrimSpace(m.Content))
				if len(runes) > 50 {
					title = string(runes[:50])
				} else {
					title = string(runes)
				}
				break
			}
		}
		if title == "" || title == "Warmup" {
			continue
		}
		_, mtimeMs, _ := fileSizeAndMtimeMs(transcriptPath)
		entryTs := ToTimestampMs(entry.UpdatedAt)
		updatedAt := mtimeMs
		if entryTs > updatedAt {
			updatedAt = entryTs
		}
		byPath[projPath] = append(byPath[projPath], Session{
			ID:        sid,
			Title:     title,
			UpdatedAt: updatedAt,
			Provider:  "agy",
		})
	}

	projects := make([]Project, 0, len(byPath))
	for projPath, sessions := range byPath {
		sort.SliceStable(sessions, func(i, j int) bool {
			return sessions[i].UpdatedAt > sessions[j].UpdatedAt
		})
		projects = append(projects, Project{
			ID:       "agy-" + encodeBase64StdUnderscore(projPath),
			Name:     projectBaseName(projPath),
			Path:     projPath,
			Sessions: sessions,
			Provider: "agy",
		})
	}
	return projects
}

// ResolveAgySessionPath 在 antigravity-cli/brain 与 antigravity/brain 下定位会话 transcript.jsonl。
func ResolveAgySessionPath(hostHome, sessionID string) string {
	home := strings.TrimSpace(hostHome)
	sid := strings.TrimSpace(sessionID)
	if home == "" || !IsSafePathSegment(sid) {
		return ""
	}
	roots := []string{
		filepath.Join(home, ".gemini", "antigravity-cli", "brain"),
		filepath.Join(home, ".gemini", "antigravity", "brain"),
	}
	for _, root := range roots {
		candidate := filepath.Join(root, sid, ".system_generated", "logs", "transcript.jsonl")
		if fileExistsRegular(candidate) {
			return candidate
		}
	}
	for _, root := range roots {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		for _, entry := range entries {
			if !entry.IsDir() || !strings.Contains(entry.Name(), sid) || !IsSafePathSegment(entry.Name()) {
				continue
			}
			candidate := filepath.Join(root, entry.Name(), ".system_generated", "logs", "transcript.jsonl")
			if fileExistsRegular(candidate) {
				return candidate
			}
		}
	}
	return ""
}

// ReadAgyMessages 解析 Antigravity CLI transcript.jsonl 消息列表。
func ReadAgyMessages(hostHome, sessionID string) ([]Message, int64, bool, error) {
	filePath := ResolveAgySessionPath(hostHome, sessionID)
	if filePath == "" {
		return nil, 0, false, nil
	}
	return readAgyMessagesFromFile(filePath)
}

func readAgyMessagesFromFile(filePath string) ([]Message, int64, bool, error) {
	size, _, ok := fileSizeAndMtimeMs(filePath)
	if !ok {
		return nil, 0, false, nil
	}

	messages := make([]Message, 0, 32)
	var assistantParts []string
	assistantTimestamp := ""
	activeModel := ""
	assistantModel := ""

	flushAssistant := func() {
		if len(assistantParts) == 0 {
			return
		}
		combined := strings.TrimSpace(strings.Join(assistantParts, "\n\n"))
		if combined != "" {
			messages = append(messages, Message{
				Role:      "assistant",
				Content:   combined,
				Model:     assistantModel,
				Timestamp: assistantTimestamp,
			})
		}
		assistantParts = nil
		assistantTimestamp = ""
		assistantModel = ""
	}

	err := forEachJSONLLine(filePath, func(line []byte) bool {
		var rec map[string]any
		if json.Unmarshal(line, &rec) != nil {
			return true
		}
		recType := stringFromAny(rec["type"])
		createdAt := stringFromAny(rec["created_at"])

		if recType == "USER_INPUT" {
			rawContent := stringFromAny(rec["content"])
			if extractAgySystemMessage(rawContent) != "" {
				return true
			}
			flushAssistant()
			if selected := extractAgySelectedModel(rawContent); selected != "" {
				activeModel = selected
			}
			if userText := extractAgyUserContent(rawContent); userText != "" {
				messages = append(messages, Message{
					Role:      "user",
					Content:   userText,
					Model:     activeModel,
					Timestamp: createdAt,
				})
			}
			return true
		}

		if assistantTimestamp == "" && createdAt != "" {
			assistantTimestamp = createdAt
			assistantModel = activeModel
		}

		switch recType {
		case "PLANNER_RESPONSE":
			if text := compactMultilineText(stringFromAny(rec["content"])); text != "" {
				assistantParts = append(assistantParts, text)
			}
			if calls, ok := rec["tool_calls"].([]any); ok {
				for _, tc := range calls {
					obj, ok := tc.(map[string]any)
					if !ok {
						continue
					}
					toolName := firstNonEmpty(compactMultilineText(stringFromAny(obj["name"])), "AGYTool")
					argsRaw, _ := json.Marshal(normalizeAgyArgs(obj["args"]))
					assistantParts = append(assistantParts, renderToolBlock(toolName, string(argsRaw), ""))
				}
			}
		case "RUN_COMMAND":
			if text := compactMultilineText(firstNonEmpty(stringFromAny(rec["content"]), stringFromAny(rec["error"]))); text != "" {
				assistantParts = append(assistantParts, renderToolBlock("Terminal", "", text))
			}
		case "VIEW_FILE":
			if text := compactMultilineText(firstNonEmpty(stringFromAny(rec["content"]), stringFromAny(rec["error"]))); text != "" {
				assistantParts = append(assistantParts, renderToolBlock("Read", extractAgyFilePath(text), text))
			}
		case "GREP_SEARCH":
			if text := compactMultilineText(firstNonEmpty(stringFromAny(rec["content"]), stringFromAny(rec["error"]))); text != "" {
				assistantParts = append(assistantParts, renderToolBlock("Grep", "", text))
			}
		case "LIST_DIRECTORY":
			if text := compactMultilineText(firstNonEmpty(stringFromAny(rec["content"]), stringFromAny(rec["error"]))); text != "" {
				assistantParts = append(assistantParts, renderToolBlock("Read", "", text))
			}
		case "CODE_ACTION":
			if text := compactMultilineText(firstNonEmpty(stringFromAny(rec["content"]), stringFromAny(rec["error"]))); text != "" {
				assistantParts = append(assistantParts, renderToolBlock("Edit", "", text))
			}
		case "CHECKPOINT":
			// 内部 checkpoint 标牌不展示
		case "ERROR_MESSAGE":
			if text := compactMultilineText(firstNonEmpty(stringFromAny(rec["error"]), stringFromAny(rec["content"]))); text != "" {
				assistantParts = append(assistantParts, "Error: "+text)
			}
		case "GENERIC", "SYSTEM_MESSAGE":
			rawContent := compactMultilineText(stringFromAny(rec["content"]))
			if rawContent == "" {
				return true
			}
			notice := extractAgySystemMessage(rawContent)
			if notice == "" {
				notice = rawContent
			}
			if !agyInternalNoticeRegex.MatchString(notice) {
				tag := strings.ToLower(recType)
				assistantParts = append(assistantParts, "<"+tag+">\n"+compactMultilineText(notice)+"\n</"+tag+">")
			}
		}
		return true
	})
	if err != nil {
		return nil, 0, true, err
	}
	flushAssistant()
	return messages, size, true, nil
}

func extractAgyUserContent(content string) string {
	trimmed := compactMultilineText(content)
	if match := agyUserRequestPattern.FindStringSubmatch(trimmed); len(match) >= 2 {
		return compactMultilineText(match[1])
	}
	return trimmed
}

func extractAgySelectedModel(content string) string {
	target := content
	if match := agySettingsBlockPattern.FindStringSubmatch(content); len(match) >= 2 {
		target = match[1]
	}
	if match := agyModelSelectPattern.FindStringSubmatch(target); len(match) >= 2 {
		return compactMultilineText(match[1])
	}
	return ""
}

func extractAgySystemMessage(content string) string {
	lower := strings.ToLower(content)
	if !strings.Contains(lower, "<system_message>") || !strings.Contains(lower, "not actually sent by the user") {
		return ""
	}
	body := content
	if match := agySystemBlockPattern.FindStringSubmatch(content); len(match) >= 2 {
		body = match[1]
	}
	if match := agyContentEqPattern.FindStringSubmatch(body); len(match) >= 2 {
		return compactMultilineText(match[1])
	}
	return compactMultilineText(body)
}

func extractAgyFilePath(content string) string {
	if match := agyFileURIPathPattern.FindStringSubmatch(content); len(match) >= 2 {
		return compactMultilineText(match[1])
	}
	if match := agyFileLinePathPattern.FindStringSubmatch(content); len(match) >= 2 {
		return compactMultilineText(match[1])
	}
	return ""
}

func normalizeAgyArgs(raw any) map[string]any {
	obj, ok := raw.(map[string]any)
	if !ok || obj == nil {
		return map[string]any{}
	}
	out := make(map[string]any, len(obj))
	for k, v := range obj {
		if str, ok := v.(string); ok {
			t := strings.TrimSpace(str)
			if len(t) >= 2 && ((t[0] == '"' && t[len(t)-1] == '"') || (t[0] == '\'' && t[len(t)-1] == '\'')) {
				out[k] = t[1 : len(t)-1]
				continue
			}
		}
		out[k] = v
	}
	return out
}
