package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/persistent"
)

const (
	ssDismissedFileName = "ss-dismissed.json"
	ssDismissedTTL      = 24 * time.Hour
)

type ssDismissedDocument struct {
	At  int64            `json:"at"`
	IDs map[string]int64 `json:"ids"`
}

func ssDismissedPath(aiHomeDir string) string {
	home := strings.TrimSpace(aiHomeDir)
	if home == "" {
		return ""
	}
	return filepath.Join(home, "run", "cache", "complete", ssDismissedFileName)
}

func ssDismissKey(provider, sessionID string) string {
	return strings.ToLower(strings.TrimSpace(provider)) + "\x00" + strings.TrimSpace(sessionID)
}

// readSSDismissed 读取用户按 x/X 关闭过的已结束会话；过期记录自动忽略。
func readSSDismissed(aiHomeDir string, now time.Time) map[string]bool {
	path := ssDismissedPath(aiHomeDir)
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var document ssDismissedDocument
	if json.Unmarshal(raw, &document) != nil || len(document.IDs) == 0 {
		return nil
	}
	dismissed := make(map[string]bool, len(document.IDs))
	for key, expiresAt := range document.IDs {
		if expiresAt > now.UnixMilli() {
			dismissed[key] = true
		}
	}
	return dismissed
}

func dismissSSSession(aiHomeDir, provider, sessionID string) error {
	path := ssDismissedPath(aiHomeDir)
	if path == "" || strings.TrimSpace(sessionID) == "" {
		return nil
	}
	raw, _ := os.ReadFile(path)
	var document ssDismissedDocument
	if json.Unmarshal(raw, &document) != nil || document.IDs == nil {
		document = ssDismissedDocument{IDs: make(map[string]int64)}
	}
	now := time.Now()
	for key, expiresAt := range document.IDs {
		if expiresAt <= now.UnixMilli() {
			delete(document.IDs, key)
		}
	}
	document.At = now.UnixMilli()
	document.IDs[ssDismissKey(provider, sessionID)] = now.Add(ssDismissedTTL).UnixMilli()
	payload, err := json.Marshal(document)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".ss-dismissed-*")
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

// filterDismissedSessionRows 只隐藏已结束的行；同一个会话重新跑起来时
// 仍然要出现，不能被历史关闭记录永久吞掉。
func filterDismissedSessionRows(rows []persistent.SessionRow, dismissed map[string]bool) []persistent.SessionRow {
	if len(rows) == 0 || len(dismissed) == 0 {
		return rows
	}
	selected := rows[:0]
	for _, row := range rows {
		if !row.Live && row.NativeID != "" && dismissed[ssDismissKey(row.Provider, row.NativeID)] {
			continue
		}
		selected = append(selected, row)
	}
	return selected
}
