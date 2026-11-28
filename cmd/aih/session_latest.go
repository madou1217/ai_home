package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/persistent"
	"github.com/madou1217/ai_home/internal/sessionscan/sessionread"
)

// 最新消息只读取会话文件尾部，并按 (size, mtime) 缓存；选择器 2s 刷新
// 时不会反复解析几 MB 的 transcript。
const (
	latestMessageTailBytes = 512 * 1024
	latestPathCacheTTL     = 30 * time.Second
)

type latestMessageEntry struct {
	size    int64
	mtimeNS int64
	entries []sessionPreviewEntry
}

// sessionPreviewEntry 是一条可直接渲染的实时会话内容。
// Kind: user | assistant | tool | screen；Role 是给人看的短标签。
type sessionPreviewEntry struct {
	Kind string `json:"Kind"`
	Role string `json:"Role"`
	Text string `json:"Text"`
	AtMS int64  `json:"AtMS,omitempty"`
}

type latestPathEntry struct {
	path   string
	expiry time.Time
}

var (
	latestMessageCache sync.Map // key -> latestMessageEntry
	latestPathCache    sync.Map // key -> latestPathEntry
)

func latestMessageKey(provider, sessionID string) string {
	return strings.ToLower(strings.TrimSpace(provider)) + "\x00" + strings.TrimSpace(sessionID)
}

// annotateLatestMessages 给有原生 session id 的行补最后一条用户/助手文本。
// 解析失败只代表这一列显示 "-"，不影响会话列表本身。
func annotateLatestMessages(
	ctx context.Context,
	runtime commandRuntime,
	aiHomeDir string,
	rows []persistent.SessionRow,
) {
	if len(rows) == 0 || strings.TrimSpace(aiHomeDir) == "" {
		return
	}
	hostHome := strings.TrimSpace(readEnv(runtime.lookupEnv, "AIH_HOST_HOME"))
	if hostHome == "" {
		hostHome, _ = runtime.userHomeDir()
	}
	options := sessionread.Options{AIHomeDir: aiHomeDir, HostHomeDir: hostHome}
	for index := range rows {
		row := &rows[index]
		if strings.TrimSpace(row.NativeID) == "" {
			continue
		}
		text, role, atMS := latestMessageForSession(ctx, options, row.Provider, row.NativeID)
		if text == "" {
			continue
		}
		row.LastMessage = text
		row.LastMessageRole = role
		if atMS > 0 {
			row.LastMessageAtMS = atMS
		}
	}
}

func latestMessageForSession(
	ctx context.Context,
	options sessionread.Options,
	provider string,
	sessionID string,
) (string, string, int64) {
	entries := transcriptEntriesForSession(ctx, options, provider, sessionID, 0)
	for index := len(entries) - 1; index >= 0; index-- {
		entry := entries[index]
		if entry.Kind == "user" || entry.Kind == "assistant" {
			return entry.Text, entry.Role, entry.AtMS
		}
	}
	return "", "", 0
}

// transcriptEntriesForSession 返回 transcript 尾部最近的可渲染内容。
// limit<=0 表示返回缓存中保留的全部条目（最多 maxTranscriptEntries 条）。
func transcriptEntriesForSession(
	ctx context.Context,
	options sessionread.Options,
	provider string,
	sessionID string,
	limit int,
) []sessionPreviewEntry {
	key := latestMessageKey(provider, sessionID)
	path := resolveLatestMessagePath(ctx, options, provider, sessionID)
	if path == "" {
		return nil
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return nil
	}
	if cached, found := latestMessageCache.Load(key); found {
		entry := cached.(latestMessageEntry)
		if entry.size == info.Size() && entry.mtimeNS == info.ModTime().UnixNano() {
			return tailPreviewEntries(entry.entries, limit)
		}
	}
	var entries []sessionPreviewEntry
	for _, window := range []int64{latestMessageTailBytes, 2 << 20} {
		lines, readErr := readFileTailLines(path, window)
		if readErr != nil {
			continue
		}
		entries = collectTranscriptEntries(provider, lines)
		if len(entries) > 0 {
			break
		}
	}
	if len(entries) > maxTranscriptEntries {
		entries = entries[len(entries)-maxTranscriptEntries:]
	}
	latestMessageCache.Store(key, latestMessageEntry{
		size: info.Size(), mtimeNS: info.ModTime().UnixNano(), entries: entries,
	})
	return tailPreviewEntries(entries, limit)
}

func tailPreviewEntries(entries []sessionPreviewEntry, limit int) []sessionPreviewEntry {
	if limit <= 0 || len(entries) <= limit {
		return append([]sessionPreviewEntry(nil), entries...)
	}
	return append([]sessionPreviewEntry(nil), entries[len(entries)-limit:]...)
}

func resolveLatestMessagePath(
	ctx context.Context,
	options sessionread.Options,
	provider string,
	sessionID string,
) string {
	key := latestMessageKey(provider, sessionID)
	if cached, found := latestPathCache.Load(key); found {
		entry := cached.(latestPathEntry)
		if time.Now().Before(entry.expiry) {
			return entry.path
		}
	}
	path := sessionread.ResolveSessionFilePath(ctx, options, provider, sessionID, "")
	latestPathCache.Store(key, latestPathEntry{path: path, expiry: time.Now().Add(latestPathCacheTTL)})
	return path
}

const (
	// maxTranscriptEntries 是缓存中保留的最近条目数；卡片只展示最后若干条。
	maxTranscriptEntries = 60
	// previewTextLimit 控制单条预览文本长度，避免一条长回答撑爆卡片。
	previewTextLimit = 320
)

func collectTranscriptEntries(provider string, lines [][]byte) []sessionPreviewEntry {
	entries := make([]sessionPreviewEntry, 0, 32)
	for _, line := range lines {
		entries = append(entries, parseTranscriptLineEntries(provider, line)...)
	}
	if len(entries) > maxTranscriptEntries {
		entries = entries[len(entries)-maxTranscriptEntries:]
	}
	return entries
}

func parseTranscriptLineEntries(provider string, line []byte) []sessionPreviewEntry {
	var record map[string]json.RawMessage
	if json.Unmarshal(line, &record) != nil {
		return nil
	}
	normalized := strings.ToLower(strings.TrimSpace(provider))
	atMS := jsonNumber(record["timestamp"])
	switch {
	case normalized == "claude":
		if jsonBool(record["isMeta"]) || jsonBool(record["isSidechain"]) {
			return nil
		}
		typeName := jsonString(record["type"])
		if typeName != "user" && typeName != "assistant" {
			return nil
		}
		return contentPreviewEntries(record["message"], typeName, atMS)
	case normalized == "codex":
		typeName := jsonString(record["type"])
		if typeName == "event_msg" {
			var payload map[string]json.RawMessage
			if json.Unmarshal(record["payload"], &payload) != nil {
				return nil
			}
			switch jsonString(payload["type"]) {
			case "agent_message":
				return textPreviewEntries(jsonString(payload["message"]), "assistant", atMS)
			case "user_message":
				return textPreviewEntries(jsonString(payload["message"]), "user", atMS)
			case "task_complete":
				return textPreviewEntries(jsonString(payload["last_agent_message"]), "assistant", atMS)
			}
			return nil
		}
		if typeName == "response_item" {
			var payload map[string]json.RawMessage
			if json.Unmarshal(record["payload"], &payload) != nil {
				return nil
			}
			switch jsonString(payload["type"]) {
			case "message":
				return contentPreviewEntries(payload["content"], jsonString(payload["role"]), atMS)
			case "function_call":
				return toolPreviewEntries(jsonString(payload["name"]), payload["arguments"], atMS)
			case "custom_tool_call":
				// Codex code-mode 工具把源文本放在 input（不是 arguments JSON）。
				detail := payload["input"]
				if len(detail) == 0 {
					detail = payload["arguments"]
				}
				return toolPreviewEntries(jsonString(payload["name"]), detail, atMS)
			}
			return nil
		}
	default:
		// CodeBuddy 家族：{"type":"message","role":"user|assistant","content":[...]}
		if jsonString(record["type"]) == "message" {
			return contentPreviewEntries(record["content"], jsonString(record["role"]), atMS)
		}
	}
	return nil
}

// contentPreviewEntries 解析 provider 消息 content（字符串 / 单对象 / block 数组）。
func contentPreviewEntries(raw json.RawMessage, role string, atMS int64) []sessionPreviewEntry {
	if len(raw) == 0 {
		return nil
	}
	kind := "assistant"
	if strings.EqualFold(strings.TrimSpace(role), "user") {
		kind = "user"
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return textPreviewEntries(text, kind, atMS)
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) == nil {
		if value := jsonString(object["text"]); value != "" {
			return textPreviewEntries(value, kind, atMS)
		}
		if value := jsonString(object["type"]); value == "tool_use" || value == "tool_call" {
			return toolPreviewEntries(jsonString(object["name"]), object["input"], atMS)
		}
		for _, key := range []string{"content", "message"} {
			if entries := contentPreviewEntries(object[key], role, atMS); len(entries) > 0 {
				return entries
			}
		}
		return nil
	}
	var blocks []map[string]json.RawMessage
	if json.Unmarshal(raw, &blocks) != nil {
		return nil
	}
	entries := make([]sessionPreviewEntry, 0, len(blocks))
	for _, block := range blocks {
		blockType := strings.ToLower(jsonString(block["type"]))
		switch blockType {
		case "text", "input_text", "output_text", "":
			entries = append(entries, textPreviewEntries(jsonString(block["text"]), kind, atMS)...)
		case "tool_use", "tool_call":
			entries = append(entries, toolPreviewEntries(jsonString(block["name"]), block["input"], atMS)...)
		}
	}
	return entries
}

func textPreviewEntries(text, kind string, atMS int64) []sessionPreviewEntry {
	if isSyntheticPreviewText(text) {
		return nil
	}
	text = compactPreviewText(text)
	if text == "" {
		return nil
	}
	return []sessionPreviewEntry{{Kind: kind, Role: roleLabel(kind), Text: text, AtMS: atMS}}
}

// isSyntheticPreviewText 过滤注入的上下文/命令回显；它们不是会话内容。
func isSyntheticPreviewText(value string) bool {
	text := strings.TrimSpace(value)
	if text == "" {
		return true
	}
	for _, prefix := range []string{
		"<system-reminder", "<local-command-stdout", "<local-command-stderr",
		"<command-name>", "<command-args>", "<command-message>",
		"<task-notification", "<goal_context", "<environment_context",
		"<user_instructions", "<session_context", "<codex_internal_context",
		"<turn_aborted", "<user_shell_command", "Caveat:",
	} {
		if strings.HasPrefix(text, prefix) {
			return true
		}
	}
	return false
}

func toolPreviewEntries(name string, input json.RawMessage, atMS int64) []sessionPreviewEntry {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "tool"
	}
	detail := toolPreviewDetail(input)
	text := name
	if detail != "" {
		text = name + " · " + detail
	}
	text = compactPreviewText(text)
	if text == "" {
		return nil
	}
	return []sessionPreviewEntry{{Kind: "tool", Role: "工具", Text: text, AtMS: atMS}}
}

func toolPreviewDetail(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		var object map[string]json.RawMessage
		if json.Unmarshal([]byte(text), &object) == nil {
			raw = []byte(text)
		} else {
			return text
		}
	}
	var input map[string]json.RawMessage
	if json.Unmarshal(raw, &input) != nil {
		return ""
	}
	for _, key := range []string{
		"command", "cmd", "file_path", "filePath", "path", "notebook_path",
		"pattern", "query", "description", "url",
	} {
		if value := previewDetailValue(input[key]); value != "" {
			return value
		}
	}
	return ""
}

func previewDetailValue(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	if value := jsonString(raw); value != "" {
		return value
	}
	var parts []string
	if json.Unmarshal(raw, &parts) == nil {
		return strings.Join(parts, " ")
	}
	return ""
}

func compactPreviewText(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	runes := []rune(value)
	if len(runes) > previewTextLimit {
		return string(runes[:previewTextLimit]) + "…"
	}
	return value
}

func readFileTailLines(path string, maxBytes int64) ([][]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	start := info.Size() - maxBytes
	if start < 0 {
		start = 0
	}
	if _, err := file.Seek(start, io.SeekStart); err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(file)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(string(raw), "\n")
	if start > 0 && len(lines) > 1 {
		lines = lines[1:]
	}
	result := make([][]byte, 0, len(lines))
	for _, line := range lines {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			result = append(result, []byte(trimmed))
		}
	}
	return result, nil
}

func jsonString(raw json.RawMessage) string {
	var value string
	if json.Unmarshal(raw, &value) == nil {
		return strings.TrimSpace(value)
	}
	return ""
}

func jsonNumber(raw json.RawMessage) int64 {
	var value int64
	if json.Unmarshal(raw, &value) == nil {
		return value
	}
	var floatValue float64
	if json.Unmarshal(raw, &floatValue) == nil {
		return int64(floatValue)
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		if parsed, err := time.Parse(time.RFC3339Nano, text); err == nil {
			return parsed.UnixMilli()
		}
	}
	return 0
}

func jsonBool(raw json.RawMessage) bool {
	var value bool
	return json.Unmarshal(raw, &value) == nil && value
}

func roleLabel(role string) string {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "user":
		return "我"
	case "assistant", "agent":
		return "AI"
	}
	return ""
}
