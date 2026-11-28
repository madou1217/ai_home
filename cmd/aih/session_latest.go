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
	text    string
	role    string
	atMS    int64
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
	key := latestMessageKey(provider, sessionID)
	path := resolveLatestMessagePath(ctx, options, provider, sessionID)
	if path == "" {
		return "", "", 0
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return "", "", 0
	}
	if cached, found := latestMessageCache.Load(key); found {
		entry := cached.(latestMessageEntry)
		if entry.size == info.Size() && entry.mtimeNS == info.ModTime().UnixNano() {
			return entry.text, entry.role, entry.atMS
		}
	}
	role, text, atMS := "", "", int64(0)
	found := false
	for _, window := range []int64{latestMessageTailBytes, 2 << 20} {
		lines, readErr := readFileTailLines(path, window)
		if readErr != nil {
			continue
		}
		role, text, atMS, found = findLatestMessage(provider, lines)
		if found {
			break
		}
	}
	if !found {
		latestMessageCache.Store(key, latestMessageEntry{size: info.Size(), mtimeNS: info.ModTime().UnixNano()})
		return "", "", 0
	}
	latestMessageCache.Store(key, latestMessageEntry{
		size: info.Size(), mtimeNS: info.ModTime().UnixNano(), text: text, role: role, atMS: atMS,
	})
	return text, role, atMS
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

func findLatestMessage(provider string, lines [][]byte) (string, string, int64, bool) {
	for index := len(lines) - 1; index >= 0; index-- {
		role, text, atMS, ok := parseLatestMessageLine(provider, lines[index])
		if !ok {
			continue
		}
		text = usableSessionTitle(text)
		if text == "" {
			continue
		}
		return role, text, atMS, true
	}
	return "", "", 0, false
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

func parseLatestMessageLine(provider string, line []byte) (string, string, int64, bool) {
	var record map[string]json.RawMessage
	if json.Unmarshal(line, &record) != nil {
		return "", "", 0, false
	}
	normalized := strings.ToLower(strings.TrimSpace(provider))
	atMS := jsonNumber(record["timestamp"])
	switch {
	case normalized == "claude":
		if jsonBool(record["isMeta"]) || jsonBool(record["isSidechain"]) {
			return "", "", 0, false
		}
		typeName := jsonString(record["type"])
		if typeName != "user" && typeName != "assistant" {
			return "", "", 0, false
		}
		text := extractJSONText(record["message"])
		return roleLabel(typeName), text, atMS, text != ""
	case normalized == "codex":
		typeName := jsonString(record["type"])
		if typeName == "event_msg" {
			var payload map[string]json.RawMessage
			if json.Unmarshal(record["payload"], &payload) != nil {
				return "", "", 0, false
			}
			payloadType := jsonString(payload["type"])
			if payloadType == "agent_message" || payloadType == "user_message" {
				text := jsonString(payload["message"])
				role := "AI"
				if payloadType == "user_message" {
					role = "我"
				}
				return role, text, atMS, text != ""
			}
			if payloadType == "task_complete" {
				text := jsonString(payload["last_agent_message"])
				return "AI", text, atMS, text != ""
			}
		}
		if typeName == "response_item" {
			var payload map[string]json.RawMessage
			if json.Unmarshal(record["payload"], &payload) != nil || jsonString(payload["type"]) != "message" {
				return "", "", 0, false
			}
			text := extractJSONText(payload["content"])
			return roleLabel(jsonString(payload["role"])), text, atMS, text != ""
		}
	default:
		// CodeBuddy 家族：{"type":"message","role":"user|assistant","content":[...]}
		if jsonString(record["type"]) == "message" {
			text := extractJSONText(record["content"])
			return roleLabel(jsonString(record["role"])), text, atMS, text != ""
		}
	}
	return "", "", 0, false
}

func extractJSONText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return strings.TrimSpace(text)
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) == nil {
		if value := jsonString(object["text"]); value != "" {
			return value
		}
		for _, key := range []string{"content", "message"} {
			if value := extractJSONText(object[key]); value != "" {
				return value
			}
		}
		return ""
	}
	var blocks []map[string]json.RawMessage
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	parts := make([]string, 0, len(blocks))
	for _, block := range blocks {
		typeName := strings.ToLower(jsonString(block["type"]))
		if typeName != "text" && typeName != "input_text" && typeName != "output_text" && typeName != "" {
			continue
		}
		if value := jsonString(block["text"]); value != "" {
			parts = append(parts, value)
		}
	}
	return strings.Join(parts, " ")
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
