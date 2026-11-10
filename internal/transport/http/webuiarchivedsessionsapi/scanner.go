// Package webuiarchivedsessionsapi 提供已归档会话的只读管理视图。
//
// 本切片只覆盖历史归档文件扫描：
//
//	~/.claude/projects/<project>/.archived/*.jsonl
//	~/.gemini/tmp/<project>/chats/.archived/*.json
//
// 对应 Node lib/server/session-lifecycle/legacy-archive-recovery.js 的 list()。
// Codex 原生归档由 app-server stdio 生命周期策略产生（运行时解析 + capabilities
// 探测），Go 尚未拥有。因此响应固定带 scope=legacy，明确这是历史归档的完整
// 结果，而不是把缺失的原生条目伪装成空列表。
package webuiarchivedsessionsapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	legacyOrigin  = "legacy"
	unnamedTitle  = "未命名会话"
	maxTitleRunes = 80
)

// Entry 是 Node ArchivedSession 中历史归档条目的等价投影。
type Entry struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	Provider       string `json:"provider"`
	ProjectDirName string `json:"projectDirName"`
	Origin         string `json:"origin"`
	CanUnarchive   bool   `json:"canUnarchive"`
	UpdatedAt      int64  `json:"updatedAt"`
	ArchivedAt     int64  `json:"archivedAt"`
}

type claudeRecord struct {
	Type    string         `json:"type"`
	Message *claudeMessage `json:"message"`
}

type claudeMessage struct {
	Content json.RawMessage `json:"content"`
}

type contentPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type geminiArchive struct {
	SessionID string          `json:"sessionId"`
	Summary   string          `json:"summary"`
	Messages  []geminiMessage `json:"messages"`
}

type geminiMessage struct {
	Type    string          `json:"type"`
	Content json.RawMessage `json:"content"`
}

// scanLegacyArchives 扫描两类历史归档并按归档时间倒序返回。
//
// 与 Node 一致：目录缺失或不可读时返回空结果，不把单个项目的失败升级成
// 整个列表失败。
func scanLegacyArchives(hostHomeDir string) []Entry {
	entries := make([]Entry, 0)
	entries = append(entries, scanClaudeArchives(hostHomeDir)...)
	entries = append(entries, scanGeminiArchives(hostHomeDir)...)
	sort.SliceStable(entries, func(left, right int) bool {
		return entryTimestamp(entries[left]) > entryTimestamp(entries[right])
	})
	return entries
}

func scanClaudeArchives(hostHomeDir string) []Entry {
	projectsRoot := filepath.Join(hostHomeDir, ".claude", "projects")
	entries := make([]Entry, 0)
	for _, projectDirName := range safeDirectoryNames(projectsRoot) {
		archivedRoot := filepath.Join(projectsRoot, projectDirName, ".archived")
		for _, fileName := range safeFileNames(archivedRoot, ".jsonl") {
			filePath := filepath.Join(archivedRoot, fileName)
			modifiedAt := fileModifiedAt(filePath)
			entries = append(entries, Entry{
				ID:             strings.TrimSuffix(fileName, ".jsonl"),
				Title:          readClaudeTitle(filePath),
				Provider:       "claude",
				ProjectDirName: projectDirName,
				Origin:         legacyOrigin,
				CanUnarchive:   true,
				UpdatedAt:      modifiedAt,
				ArchivedAt:     modifiedAt,
			})
		}
	}
	return entries
}

func scanGeminiArchives(hostHomeDir string) []Entry {
	projectsRoot := filepath.Join(hostHomeDir, ".gemini", "tmp")
	entries := make([]Entry, 0)
	for _, projectDirName := range safeDirectoryNames(projectsRoot) {
		archivedRoot := filepath.Join(projectsRoot, projectDirName, "chats", ".archived")
		for _, fileName := range safeFileNames(archivedRoot, ".json") {
			filePath := filepath.Join(archivedRoot, fileName)
			archive, ok := readGeminiArchive(filePath)
			if !ok {
				continue
			}
			sessionID := strings.TrimSpace(archive.SessionID)
			if sessionID == "" {
				sessionID = strings.TrimSuffix(fileName, ".json")
			}
			modifiedAt := fileModifiedAt(filePath)
			entries = append(entries, Entry{
				ID:             sessionID,
				Title:          geminiTitle(archive),
				Provider:       "gemini",
				ProjectDirName: projectDirName,
				Origin:         legacyOrigin,
				CanUnarchive:   true,
				UpdatedAt:      modifiedAt,
				ArchivedAt:     modifiedAt,
			})
		}
	}
	return entries
}

// readClaudeTitle 复刻 Node：逐行解析，第一条带文本的 user 记录即标题。
// 任意一行 JSON 损坏都会让整次标题读取退回默认值（Node 的 try/catch 语义）。
func readClaudeTitle(filePath string) string {
	content, err := os.ReadFile(filePath)
	if err != nil {
		return unnamedTitle
	}
	for _, line := range strings.Split(string(content), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var record claudeRecord
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			return unnamedTitle
		}
		if record.Type != "user" || record.Message == nil {
			continue
		}
		if title := contentText(record.Message.Content); title != "" {
			return truncateTitle(title)
		}
	}
	return unnamedTitle
}

func readGeminiArchive(filePath string) (geminiArchive, bool) {
	content, err := os.ReadFile(filePath)
	if err != nil {
		return geminiArchive{}, false
	}
	var archive geminiArchive
	if err := json.Unmarshal(content, &archive); err != nil {
		return geminiArchive{}, false
	}
	return archive, true
}

// geminiTitle 复刻 Node：summary 优先；否则只看第一条 user 消息。
func geminiTitle(archive geminiArchive) string {
	if summary := strings.TrimSpace(archive.Summary); summary != "" {
		return summary
	}
	for _, message := range archive.Messages {
		if message.Type != "user" {
			continue
		}
		if title := contentText(message.Content); title != "" {
			return truncateTitle(title)
		}
		return unnamedTitle
	}
	return unnamedTitle
}

// contentText 接受 string 或 [{type:"text",text:"..."}] 两种官方形态。
func contentText(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return strings.TrimSpace(text)
	}
	var parts []contentPart
	if err := json.Unmarshal(raw, &parts); err != nil {
		return ""
	}
	texts := make([]string, 0, len(parts))
	for _, part := range parts {
		if part.Type != "text" {
			continue
		}
		if value := strings.TrimSpace(part.Text); value != "" {
			texts = append(texts, value)
		}
	}
	return strings.TrimSpace(strings.Join(texts, " "))
}

// truncateTitle 按字符截断；Node 用 UTF-16 code unit，这里用 rune 保证
// 截断后仍是合法 UTF-8。
func truncateTitle(text string) string {
	if utf8.RuneCountInString(text) <= maxTitleRunes {
		return text
	}
	return string([]rune(text)[:maxTitleRunes])
}

func entryTimestamp(entry Entry) int64 {
	if entry.ArchivedAt != 0 {
		return entry.ArchivedAt
	}
	return entry.UpdatedAt
}

func fileModifiedAt(filePath string) int64 {
	info, err := os.Stat(filePath)
	if err != nil {
		return 0
	}
	return info.ModTime().UnixMilli()
}

func safeDirectoryNames(root string) []string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() && safeName(entry.Name()) {
			names = append(names, entry.Name())
		}
	}
	return names
}

func safeFileNames(root, suffix string) []string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if !entry.Type().IsRegular() || !safeName(name) || !strings.HasSuffix(name, suffix) {
			continue
		}
		names = append(names, name)
	}
	return names
}

// safeName 与 Node 一致：拒绝空、点目录和路径分隔符（含反斜杠）。
func safeName(value string) bool {
	return value != "" && value != "." && value != ".." &&
		!strings.Contains(value, "/") && !strings.Contains(value, "\\")
}
