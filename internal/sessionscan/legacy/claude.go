package legacy

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf16"
)

const (
	claudeProvider = "claude"
	// claudeMetaMaxBytes 与 Node 的 CLAUDE_SESSION_META_MAX_BYTES 一致：只读文件头。
	claudeMetaMaxBytes = 16 * 1024
	warmupTitle        = "Warmup"
)

type claudeRecord struct {
	Type        string `json:"type"`
	Cwd         string `json:"cwd"`
	IsSidechain bool   `json:"isSidechain"`
	Message     *struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type claudeHistoryEntry struct {
	projectPath string
	title       string
}

// ReadClaudeProjects 扫描 <hostHome>/.claude/projects 下的全部项目。
// knownPaths 用于把 sanitized 目录名反解成真实路径（Codex/Gemini 已知 cwd）。
func ReadClaudeProjects(hostHome string, knownPaths []string) []Project {
	projectsRoot := filepath.Join(hostHome, ".claude", "projects")
	history := readClaudeHistory(hostHome)
	projects := make([]Project, 0)
	for _, name := range directoryNames(projectsRoot) {
		if project, ok := readClaudeProject(hostHome, name, knownPaths, history); ok {
			projects = append(projects, project)
		}
	}
	return projects
}

// ReadClaudeProject 读取单个项目目录；目录不存在或无展示会话时 ok=false。
func ReadClaudeProject(hostHome, projectDirName string, knownPaths []string) (Project, bool) {
	return readClaudeProject(hostHome, projectDirName, knownPaths, readClaudeHistory(hostHome))
}

func readClaudeProject(hostHome, projectDirName string, knownPaths []string, history map[string]claudeHistoryEntry) (Project, bool) {
	projectDirName = strings.TrimSpace(projectDirName)
	if projectDirName == "" {
		return Project{}, false
	}
	projectDir := filepath.Join(hostHome, ".claude", "projects", projectDirName)
	if !isDirectory(projectDir) {
		return Project{}, false
	}

	sessions := make([]Session, 0)
	resolvedCwd := ""
	for _, fileName := range fileNames(projectDir, ".jsonl") {
		sessionPath := filepath.Join(projectDir, fileName)
		sessionID := strings.TrimSuffix(fileName, ".jsonl")
		title, cwd, sawMainThread := scanClaudeSession(sessionPath)
		if resolvedCwd == "" && cwd != "" {
			resolvedCwd = cwd
		}

		entry, hasHistory := history[sessionID]
		if title == UnnamedTitle && sawMainThread && hasHistory && entry.title != "" {
			title = entry.title
		}
		if hasHistory && resolvedCwd == "" && entry.projectPath != "" && isDirectory(entry.projectPath) {
			resolvedCwd = entry.projectPath
		}
		if title == warmupTitle || title == UnnamedTitle {
			continue
		}

		sessions = append(sessions, Session{
			ID:             sessionID,
			Title:          title,
			UpdatedAt:      fileModifiedMillis(sessionPath),
			Provider:       claudeProvider,
			ProjectDirName: projectDirName,
		})
	}
	if len(sessions) == 0 {
		return Project{}, false
	}
	sort.SliceStable(sessions, func(left, right int) bool {
		return sessions[left].UpdatedAt > sessions[right].UpdatedAt
	})

	realPath := resolvedCwd
	if realPath == "" {
		realPath = resolveClaudeProjectPath(projectDirName, knownPaths)
	}
	return Project{
		ID:       projectDirName,
		Name:     filepath.Base(realPath),
		Path:     realPath,
		Sessions: sessions,
		Provider: claudeProvider,
	}, true
}

// scanClaudeSession 复刻 Node：16KB 头内逐行解析，取第一条主线程 user 文本作为标题。
// cwd 来自任意记录（含 sidechain），但必须是真实存在的目录。
func scanClaudeSession(filePath string) (title, cwd string, sawMainThread bool) {
	file, err := os.Open(filePath)
	if err != nil {
		return UnnamedTitle, "", false
	}
	defer file.Close()

	reader := bufio.NewReaderSize(io.LimitReader(file, claudeMetaMaxBytes), 32*1024)
	for {
		line, readErr := reader.ReadString('\n')
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			var record claudeRecord
			if json.Unmarshal([]byte(trimmed), &record) == nil {
				if cwd == "" && record.Cwd != "" && isDirectory(record.Cwd) {
					cwd = record.Cwd
				}
				if !record.IsSidechain {
					sawMainThread = true
					if record.Type == "user" && record.Message != nil {
						if text := contentText(record.Message.Content); text != "" && !skipClaudeTitle(text) {
							title = truncateTitle(text)
						}
					}
				}
			}
		}
		if title != "" || readErr != nil {
			break
		}
	}
	if title == "" {
		title = UnnamedTitle
	}
	return title, cwd, sawMainThread
}

// skipClaudeTitle 过滤 CLI 注入的伪用户消息。
func skipClaudeTitle(text string) bool {
	return strings.HasPrefix(text, "Caveat:") ||
		strings.HasPrefix(text, "<command-name>") ||
		strings.HasPrefix(text, "<local-command") ||
		strings.HasPrefix(text, "<ide_opened_file>")
}

func readClaudeHistory(hostHome string) map[string]claudeHistoryEntry {
	entries := make(map[string]claudeHistoryEntry)
	content, err := os.ReadFile(filepath.Join(hostHome, ".claude", "history.jsonl"))
	if err != nil {
		return entries
	}
	for _, line := range splitLines(string(content)) {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var record struct {
			SessionID    string `json:"sessionId"`
			SessionIDAlt string `json:"session_id"`
			Project      string `json:"project"`
			Display      string `json:"display"`
		}
		if json.Unmarshal([]byte(line), &record) != nil {
			continue
		}
		sessionID := strings.TrimSpace(record.SessionID)
		if sessionID == "" {
			sessionID = strings.TrimSpace(record.SessionIDAlt)
		}
		if sessionID == "" {
			continue
		}
		entry := entries[sessionID]
		if entry.projectPath == "" {
			entry.projectPath = strings.TrimSpace(record.Project)
		}
		if entry.title == "" {
			entry.title = normalizeClaudeHistoryTitle(record.Display)
		}
		entries[sessionID] = entry
	}
	return entries
}

func normalizeClaudeHistoryTitle(value string) string {
	title := strings.TrimSpace(value)
	if title == "" || strings.HasPrefix(title, "/") || skipClaudeTitle(title) {
		return ""
	}
	return truncateTitle(title)
}

// sanitizePath 与 Claude CLI 一致：把每个非 [a-zA-Z0-9] 的 UTF-16 单元替换成 '-'。
func sanitizePath(name string) string {
	units := utf16.Encode([]rune(name))
	var builder strings.Builder
	builder.Grow(len(units))
	for _, unit := range units {
		if (unit >= 'a' && unit <= 'z') || (unit >= 'A' && unit <= 'Z') || (unit >= '0' && unit <= '9') {
			builder.WriteRune(rune(unit))
			continue
		}
		builder.WriteByte('-')
	}
	return builder.String()
}

// resolveClaudeProjectPath 复刻 Node 的三级回退：
// 已知路径正向匹配 → 逐段贪心尝试 / . - _ → sanitized 名字按 '-' 摊平成 '/'.
func resolveClaudeProjectPath(dirName string, knownPaths []string) string {
	for _, knownPath := range knownPaths {
		if knownPath != "" && sanitizePath(knownPath) == dirName {
			return knownPath
		}
	}

	parts := make([]string, 0)
	for _, part := range strings.Split(dirName, "-") {
		if part != "" {
			parts = append(parts, part)
		}
	}
	current := ""
	for _, part := range parts {
		candidates := []string{current + "/" + part}
		if current == "" {
			candidates = append(candidates, "/."+part)
		} else {
			candidates = append(candidates,
				current+"-"+part,
				current+"."+part,
				current+"_"+part,
			)
		}
		next := ""
		for _, candidate := range candidates {
			if isDirectory(candidate) {
				next = candidate
				break
			}
		}
		if next == "" {
			next = current + "/" + part
		}
		current = next
	}

	if current != "" && isDirectory(current) {
		return current
	}
	return strings.ReplaceAll(dirName, "-", "/")
}
