package sessionread

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// ResolveChatSessionPath 定位 chat-sessions/<sessionId>.json（优先 AIHomeDir，退回 <HostHomeDir>/.ai_home）。
func ResolveChatSessionPath(opts Options, sessionID string) string {
	sid := strings.TrimSpace(sessionID)
	if sid == "" || !IsSafePathSegment(sid) {
		return ""
	}
	candidates := make([]string, 0, 2)
	if aiHome := strings.TrimSpace(opts.AIHomeDir); aiHome != "" {
		candidates = append(candidates, filepath.Join(filepath.Clean(aiHome), "chat-sessions", sid+".json"))
	}
	if hostHome := strings.TrimSpace(opts.HostHomeDir); hostHome != "" {
		fallback := filepath.Join(filepath.Clean(hostHome), ".ai_home", "chat-sessions", sid+".json")
		if len(candidates) == 0 || candidates[0] != fallback {
			candidates = append(candidates, fallback)
		}
	}
	for _, candidate := range candidates {
		if fileExistsRegular(candidate) {
			return candidate
		}
	}
	return ""
}

// ReadChatSessionMessages 读取本地 chat-sessions/<sessionId>.json 里的 messages 字段。
// 文件不存在时 found=false, err=nil；存在但 JSON 损坏时 found=true, err!=nil。
func ReadChatSessionMessages(opts Options, sessionID string) ([]json.RawMessage, bool, error) {
	path := ResolveChatSessionPath(opts, sessionID)
	if path == "" {
		return nil, false, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, false, nil
		}
		return nil, true, err
	}
	var payload struct {
		Messages []json.RawMessage `json:"messages"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, true, err
	}
	if payload.Messages == nil {
		return nil, false, nil
	}
	return payload.Messages, true, nil
}
