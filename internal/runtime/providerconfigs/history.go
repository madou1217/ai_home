package providerconfigs

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	// MaxHistoryEntries 是单个配置文件最多保留的历史快照条数。
	MaxHistoryEntries    = 30
	historySchemaVersion = 1
)

var reSafeSegment = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)

// HistorySummary 是版本列表和保存响应里返回的历史条目摘要（不含原文）。
type HistorySummary struct {
	ID              string `json:"id"`
	Revision        string `json:"revision"`
	SavedAt         int64  `json:"savedAt"`
	Reason          string `json:"reason"`
	Note            string `json:"note"`
	Size            int    `json:"size"`
	ContainsSecrets bool   `json:"containsSecrets"`
}

// HistoryEntry 包含完整配置快照文本，仅在按 entryId 读取或恢复时返回。
type HistoryEntry struct {
	ID              string `json:"id"`
	Revision        string `json:"revision"`
	SavedAt         int64  `json:"savedAt"`
	Reason          string `json:"reason"`
	Note            string `json:"note"`
	Size            int    `json:"size"`
	ContainsSecrets bool   `json:"containsSecrets"`
	Content         string `json:"content"`
}

type historyDocument struct {
	Version int            `json:"version"`
	Entries []HistoryEntry `json:"entries"`
}

func safeSegment(value string) string {
	raw := strings.TrimSpace(value)
	if raw == "" {
		return ""
	}
	if reSafeSegment.MatchString(raw) {
		return raw
	}
	return url.PathEscape(raw)
}

func historyFilePath(aiHomeDir, provider, fileID string) (string, error) {
	base := strings.TrimSpace(aiHomeDir)
	if base == "" {
		return "", fmt.Errorf("provider config history 需要有效的 aiHomeDir")
	}
	return filepath.Join(base, "run", "provider-config-history", safeSegment(provider), safeSegment(fileID), "history.json"), nil
}

func readHistoryDocument(aiHomeDir, provider, fileID string) historyDocument {
	target, err := historyFilePath(aiHomeDir, provider, fileID)
	if err != nil {
		return historyDocument{Version: historySchemaVersion, Entries: []HistoryEntry{}}
	}
	raw, err := os.ReadFile(target)
	if err != nil {
		return historyDocument{Version: historySchemaVersion, Entries: []HistoryEntry{}}
	}
	var doc historyDocument
	if err := json.Unmarshal(raw, &doc); err != nil {
		return historyDocument{Version: historySchemaVersion, Entries: []HistoryEntry{}}
	}
	filtered := make([]HistoryEntry, 0, len(doc.Entries))
	for _, entry := range doc.Entries {
		if entry.ID != "" {
			filtered = append(filtered, entry)
		}
	}
	return historyDocument{Version: historySchemaVersion, Entries: filtered}
}

func writeHistoryDocument(aiHomeDir, provider, fileID string, doc historyDocument) error {
	target, err := historyFilePath(aiHomeDir, provider, fileID)
	if err != nil {
		return err
	}
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	var suffix [4]byte
	_, _ = rand.Read(suffix[:])
	tmp := fmt.Sprintf("%s.%d.%s.tmp", target, os.Getpid(), hex.EncodeToString(suffix[:]))
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, target); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	_ = os.Chmod(target, 0o600)
	return nil
}

func summarizeHistory(entry HistoryEntry) HistorySummary {
	return HistorySummary{
		ID:              entry.ID,
		Revision:        entry.Revision,
		SavedAt:         entry.SavedAt,
		Reason:          entry.Reason,
		Note:            entry.Note,
		Size:            entry.Size,
		ContainsSecrets: entry.ContainsSecrets,
	}
}

func listHistoryEntries(aiHomeDir, provider, fileID string) []HistorySummary {
	doc := readHistoryDocument(aiHomeDir, provider, fileID)
	entries := append([]HistoryEntry(nil), doc.Entries...)
	sort.SliceStable(entries, func(i, j int) bool {
		return entries[i].SavedAt > entries[j].SavedAt
	})
	out := make([]HistorySummary, len(entries))
	for i, e := range entries {
		out[i] = summarizeHistory(e)
	}
	return out
}

func appendHistoryEntry(aiHomeDir, provider, fileID string, entry HistoryEntry) (*HistorySummary, error) {
	rev := strings.TrimSpace(entry.Revision)
	if rev == "" {
		return nil, nil
	}
	doc := readHistoryDocument(aiHomeDir, provider, fileID)
	var prevSavedAt int64
	if n := len(doc.Entries); n > 0 {
		last := doc.Entries[n-1]
		if last.Revision == rev && last.Content == entry.Content {
			s := summarizeHistory(last)
			return &s, nil
		}
		prevSavedAt = last.SavedAt
	}
	savedAt := entry.SavedAt
	if savedAt <= 0 {
		savedAt = time.Now().UnixMilli()
	}
	if savedAt <= prevSavedAt {
		savedAt = prevSavedAt + 1
	}
	var rnd [3]byte
	_, _ = rand.Read(rnd[:])
	prefix := rev
	if len(prefix) > 8 {
		prefix = prefix[:8]
	}
	id := fmt.Sprintf("%d-%s-%s", savedAt, prefix, hex.EncodeToString(rnd[:]))
	reason := strings.TrimSpace(entry.Reason)
	if reason == "" {
		reason = "save"
	}
	note := entry.Note
	if len([]rune(note)) > 200 {
		note = string([]rune(note)[:200])
	}
	record := HistoryEntry{
		ID:              id,
		Revision:        rev,
		SavedAt:         savedAt,
		Reason:          reason,
		Note:            note,
		Size:            len(entry.Content),
		ContainsSecrets: entry.ContainsSecrets,
		Content:         entry.Content,
	}
	doc.Entries = append(doc.Entries, record)
	if len(doc.Entries) > MaxHistoryEntries {
		doc.Entries = doc.Entries[len(doc.Entries)-MaxHistoryEntries:]
	}
	doc.Version = historySchemaVersion
	if err := writeHistoryDocument(aiHomeDir, provider, fileID, doc); err != nil {
		return nil, err
	}
	s := summarizeHistory(record)
	return &s, nil
}

func getHistoryEntry(aiHomeDir, provider, fileID, entryID string) (*HistoryEntry, bool) {
	id := strings.TrimSpace(entryID)
	if id == "" {
		return nil, false
	}
	doc := readHistoryDocument(aiHomeDir, provider, fileID)
	for _, entry := range doc.Entries {
		if entry.ID == id {
			cp := entry
			return &cp, true
		}
	}
	return nil, false
}
