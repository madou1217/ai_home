package persistent

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// 与 Node lib/runtime/persistent-session-cache.js 同文件同格式：Node 的 TAB 补全与
// Go 的选择器共用一份标题缓存。
const (
	sessionCacheFile           = "ss-rows.json"
	sessionCacheTTL            = 30 * time.Minute
	sessionCacheTitleMaxLength = 60
)

// SessionCacheEntry 是缓存里的单行。
type SessionCacheEntry struct {
	Name           string `json:"name"`
	Title          string `json:"title"`
	AgentSessionID string `json:"agentSessionId"`
	Provider       string `json:"provider"`
	ProjectPath    string `json:"projectPath"`
	Live           bool   `json:"live"`
	// Here 表示会话就在当前工作目录（Node 补全用它排序）。
	Here      bool  `json:"here"`
	CreatedAt int64 `json:"createdAt,omitempty"`
	UpdatedAt int64 `json:"updatedAt,omitempty"`
}

type sessionCacheDocument struct {
	At   int64               `json:"at"`
	Rows []SessionCacheEntry `json:"rows"`
}

// SessionCachePath 返回缓存文件路径。
func SessionCachePath(aiHomeDir string) string {
	home := strings.TrimSpace(aiHomeDir)
	if home == "" {
		return ""
	}
	return filepath.Join(home, "run", "cache", "complete", sessionCacheFile)
}

// ReadSessionCache 读取未过期的缓存行；缺失/过期/损坏都返回空。
func ReadSessionCache(aiHomeDir string, now time.Time) []SessionCacheEntry {
	path := SessionCachePath(aiHomeDir)
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var document sessionCacheDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		return nil
	}
	if document.At <= 0 || now.Sub(time.UnixMilli(document.At)) > sessionCacheTTL {
		return nil
	}
	return document.Rows
}

// WriteSessionCache 把当前采集结果写回缓存（供 Node 快速路径与 TAB 使用）。
func WriteSessionCache(aiHomeDir string, rows []SessionRow, now time.Time) error {
	path := SessionCachePath(aiHomeDir)
	if path == "" {
		return errors.New("session cache: AIH home is required")
	}
	cwd, _ := os.Getwd()
	entries := make([]SessionCacheEntry, 0, len(rows))
	for _, row := range rows {
		name := strings.TrimSpace(row.Name)
		if name == "" {
			continue
		}
		projectPath := strings.TrimSpace(row.Path)
		entries = append(entries, SessionCacheEntry{
			Name:           name,
			Title:          strings.TrimSpace(row.Label),
			AgentSessionID: strings.TrimSpace(row.NativeID),
			Provider:       row.Provider,
			ProjectPath:    projectPath,
			Live:           row.Live,
			Here:           projectPath != "" && cwd != "" && projectPath == cwd,
			CreatedAt:      CreatedAtMillis(row),
			UpdatedAt:      now.UnixMilli(),
		})
	}
	payload, err := json.Marshal(sessionCacheDocument{At: now.UnixMilli(), Rows: entries})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".ss-rows-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(payload); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}

// ApplySessionCache 用缓存补标题与原生会话 id：只填空缺/过长/与名字相同的标题，
// 已有可信值不覆盖（与 Node applyCachedSessionMeta 同规则）。
func ApplySessionCache(rows []SessionRow, entries []SessionCacheEntry) {
	if len(rows) == 0 || len(entries) == 0 {
		return
	}
	byName := make(map[string]SessionCacheEntry, len(entries))
	for _, entry := range entries {
		if name := strings.TrimSpace(entry.Name); name != "" {
			byName[name] = entry
		}
	}
	for index := range rows {
		entry, ok := byName[strings.TrimSpace(rows[index].Name)]
		if !ok {
			continue
		}
		current := strings.TrimSpace(rows[index].Label)
		title := strings.TrimSpace(entry.Title)
		if title != "" && (current == "" || len([]rune(current)) > sessionCacheTitleMaxLength ||
			current == strings.TrimSpace(rows[index].Name)) {
			rows[index].Label = title
		}
		if strings.TrimSpace(rows[index].NativeID) == "" {
			rows[index].NativeID = strings.TrimSpace(entry.AgentSessionID)
		}
	}
}

// CreatedAtMillis 把会话创建时间归一成毫秒。tmux 的 session_created 是秒，
// 但字段名是 CreatedAtMS；缓存与展示都对毫秒消费者负责。
func CreatedAtMillis(row SessionRow) int64 {
	value := row.CreatedAtMS
	if value > 0 && value < 1_000_000_000_000 {
		return value * 1000
	}
	return value
}

// cacheFileExists 仅用于测试与诊断。
func cacheFileExists(aiHomeDir string) bool {
	path := SessionCachePath(aiHomeDir)
	if path == "" {
		return false
	}
	_, err := os.Stat(path)
	return err == nil || !errors.Is(err, fs.ErrNotExist)
}
