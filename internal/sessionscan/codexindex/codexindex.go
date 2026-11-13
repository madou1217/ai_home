// Package codexindex 扫描 Codex rollout 文件，为持久会话列表提供最小索引。
//
// Codex 没有可直接枚举的项目库：会话写在 ~/.codex/sessions/**.jsonl（归档在
// archived_sessions），首行 session_meta 携带 thread id 与 cwd。本包只读首段，
// 用于给 aih ss --refresh 补原生会话 id 与标题。
package codexindex

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Session 是一条 Codex 会话索引记录。
type Session struct {
	ID          string
	CWD         string
	Title       string
	UpdatedAtMS int64
}

type record struct {
	Type      string          "json:\"type\""
	Timestamp string          "json:\"timestamp\""
	Payload   json.RawMessage "json:\"payload\""
}

type metaPayload struct {
	ID        string "json:\"id\""
	CWD       string "json:\"cwd\""
	Timestamp string "json:\"timestamp\""
}

type itemPayload struct {
	Type    string "json:\"type\""
	Role    string "json:\"role\""
	Content []struct {
		Type string "json:\"type\""
		Text string "json:\"text\""
	} "json:\"content\""
}

// List 扫描 hostHome 下 Codex 的 sessions/archived_sessions，返回按文件更新的会话。
func List(hostHomeDir string) []Session {
	home := strings.TrimSpace(hostHomeDir)
	if home == "" {
		return nil
	}
	roots := []string{
		filepath.Join(home, ".codex", "sessions"),
		filepath.Join(home, ".codex", "archived_sessions"),
	}
	sessions := make([]Session, 0)
	for _, root := range roots {
		_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
			if err != nil || entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
				return nil
			}
			info, statErr := entry.Info()
			if statErr != nil {
				return nil
			}
			session := readSession(path, info.ModTime())
			if session.ID != "" && session.CWD != "" {
				sessions = append(sessions, session)
			}
			return nil
		})
	}
	return sessions
}

// readSession 只读文件开头，提取 session_meta 与首条用户消息。
func readSession(path string, modTime time.Time) Session {
	file, err := os.Open(path)
	if err != nil {
		return Session{}
	}
	defer file.Close()
	reader := bufio.NewReader(io.LimitReader(file, 512*1024))
	session := Session{UpdatedAtMS: modTime.UnixMilli()}
	for {
		line, readErr := reader.ReadString('\n')
		if len(line) > 0 {
			var entry record
			if json.Unmarshal([]byte(line), &entry) == nil {
				switch entry.Type {
				case "session_meta":
					var meta metaPayload
					if json.Unmarshal(entry.Payload, &meta) == nil {
						if session.ID == "" {
							session.ID = strings.TrimSpace(meta.ID)
						}
						if session.CWD == "" {
							session.CWD = strings.TrimSpace(meta.CWD)
						}
						if session.UpdatedAtMS == 0 && meta.Timestamp != "" {
							if parsed, parseErr := time.Parse(time.RFC3339Nano, meta.Timestamp); parseErr == nil {
								session.UpdatedAtMS = parsed.UnixMilli()
							}
						}
					}
				case "response_item":
					if session.Title != "" {
						continue
					}
					var item itemPayload
					if json.Unmarshal(entry.Payload, &item) != nil ||
						item.Type != "message" || item.Role != "user" {
						continue
					}
					for _, part := range item.Content {
						text := strings.Join(strings.Fields(part.Text), " ")
						if text == "" || isSynthetic(text) {
							continue
						}
						session.Title = text
						break
					}
				}
			}
		}
		if readErr != nil {
			break
		}
	}
	if session.ID == "" {
		session.ID = idFromFileName(filepath.Base(path))
	}
	return session
}

// idFromFileName 从 rollout-...-<uuid>.jsonl 回退提取 thread id。
func idFromFileName(name string) string {
	trimmed := strings.TrimSuffix(name, ".jsonl")
	if len(trimmed) >= 36 {
		candidate := trimmed[len(trimmed)-36:]
		if strings.Count(candidate, "-") == 4 {
			return candidate
		}
	}
	return ""
}

// isSynthetic 过滤上下文块，避免把环境说明当成标题。
func isSynthetic(text string) bool {
	for _, prefix := range []string{
		"<environment_context", "<user_instructions", "<goal_context",
		"# AGENTS.md instructions", "<INSTRUCTIONS>", "<session_context",
		"<codex_internal_context", "<turn_aborted", "<user_shell_command",
	} {
		if strings.HasPrefix(text, prefix) {
			return true
		}
	}
	return strings.Contains(text, "<INSTRUCTIONS>")
}
