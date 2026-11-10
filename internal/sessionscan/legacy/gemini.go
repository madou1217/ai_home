package legacy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	geminiProvider = "gemini"
	// geminiHeadBytes 与 Node 一致：先从 2KB 头里抓 sessionId/summary/lastUpdated。
	geminiHeadBytes = 2048
)

var (
	geminiSessionIDPattern  = regexp.MustCompile(`"sessionId"\s*:\s*"([^"]+)"`)
	geminiSummaryPattern    = regexp.MustCompile(`"summary"\s*:\s*"([^"]+)"`)
	geminiLastUpdatePattern = regexp.MustCompile(`"lastUpdated"\s*:\s*"([^"]+)"`)
)

// ReadGeminiProjects 扫描 <hostHome>/.gemini/tmp 下的全部项目。
func ReadGeminiProjects(hostHome string) []Project {
	geminiDir := filepath.Join(hostHome, ".gemini")
	tmpRoot := filepath.Join(geminiDir, "tmp")
	pathMap := buildGeminiProjectPathMap(geminiDir)
	projects := make([]Project, 0)
	for _, name := range directoryNames(tmpRoot) {
		if project, ok := readGeminiProject(name, pathMap, geminiDir); ok {
			projects = append(projects, project)
		}
	}
	return projects
}

// ReadGeminiProject 读取单个 .gemini/tmp/<name> 项目。
func ReadGeminiProject(hostHome, projectName string) (Project, bool) {
	geminiDir := filepath.Join(hostHome, ".gemini")
	return readGeminiProject(projectName, buildGeminiProjectPathMap(geminiDir), geminiDir)
}

// buildGeminiProjectPathMap 读取 <geminiDir>/history/<name>/.project_root。
func buildGeminiProjectPathMap(geminiDir string) map[string]string {
	pathMap := make(map[string]string)
	historyDir := filepath.Join(geminiDir, "history")
	for _, name := range directoryNames(historyDir) {
		content, err := os.ReadFile(filepath.Join(historyDir, name, ".project_root"))
		if err != nil {
			continue
		}
		pathMap[name] = strings.TrimSpace(string(content))
	}
	return pathMap
}

func readGeminiProject(projectName string, pathMap map[string]string, geminiDir string) (Project, bool) {
	name := strings.TrimSpace(projectName)
	if name == "" {
		return Project{}, false
	}
	chatsDir := filepath.Join(geminiDir, "tmp", name, "chats")
	if !isDirectory(chatsDir) {
		return Project{}, false
	}

	// .json 检查点优先；.jsonl 原生会话只补缺，同 id 的 fork 取 mtime 最新。
	sessionsByID := make(map[string]Session)
	jsonSessionIDs := make(map[string]bool)
	for _, fileName := range fileNames(chatsDir, ".json") {
		session, ok := readGeminiJSONSession(filepath.Join(chatsDir, fileName), name)
		if !ok {
			continue
		}
		if _, exists := sessionsByID[session.ID]; exists {
			continue
		}
		sessionsByID[session.ID] = session
		jsonSessionIDs[session.ID] = true
	}
	for _, fileName := range fileNames(chatsDir, ".jsonl") {
		session, ok := readGeminiJSONLSession(filepath.Join(chatsDir, fileName), name)
		if !ok || jsonSessionIDs[session.ID] {
			continue
		}
		existing, exists := sessionsByID[session.ID]
		if !exists || session.UpdatedAt > existing.UpdatedAt {
			sessionsByID[session.ID] = session
		}
	}

	sessions := make([]Session, 0, len(sessionsByID))
	for _, session := range sessionsByID {
		sessions = append(sessions, session)
	}
	sort.SliceStable(sessions, func(left, right int) bool {
		return sessions[left].UpdatedAt > sessions[right].UpdatedAt
	})

	return Project{
		ID:       geminiProvider + "-" + name,
		Name:     name,
		Path:     pathMap[name],
		Sessions: sessions,
		Provider: geminiProvider,
	}, true
}

type geminiCheckpoint struct {
	SessionID   string `json:"sessionId"`
	Summary     string `json:"summary"`
	LastUpdated string `json:"lastUpdated"`
	Messages    []struct {
		Type    string          `json:"type"`
		Content json.RawMessage `json:"content"`
	} `json:"messages"`
}

// readGeminiJSONSession 解析 /chat save 产生的 .json 检查点。
func readGeminiJSONSession(chatPath, projectDirName string) (Session, bool) {
	file, err := os.Open(chatPath)
	if err != nil {
		return Session{}, false
	}
	head := make([]byte, geminiHeadBytes)
	readBytes, readErr := file.Read(head)
	file.Close()
	if readErr != nil && readBytes == 0 {
		return Session{}, false
	}
	chunk := string(head[:readBytes])

	title := firstSubmatch(geminiSummaryPattern, chunk)
	if title == "" {
		content, err := os.ReadFile(chatPath)
		if err != nil {
			return Session{}, false
		}
		var checkpoint geminiCheckpoint
		if err := json.Unmarshal(content, &checkpoint); err != nil {
			return Session{}, false
		}
		for _, message := range checkpoint.Messages {
			if message.Type != "user" {
				continue
			}
			title = truncateTitle(geminiContentText(message.Content))
			break
		}
	}
	if title == "" || title == warmupTitle {
		return Session{}, false
	}

	sessionID := strings.TrimSpace(firstSubmatch(geminiSessionIDPattern, chunk))
	if sessionID == "" {
		sessionID = strings.TrimSuffix(filepath.Base(chatPath), ".json")
	}
	updatedAt := fileModifiedMillis(chatPath)
	if value := firstSubmatch(geminiLastUpdatePattern, chunk); value != "" {
		if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
			updatedAt = parsed.UnixMilli()
		}
	}
	return Session{
		ID:             sessionID,
		Title:          title,
		UpdatedAt:      updatedAt,
		Provider:       geminiProvider,
		ProjectDirName: projectDirName,
	}, true
}

type geminiJSONLRecord struct {
	Type    string          `json:"type"`
	Content json.RawMessage `json:"content"`
}

// readGeminiJSONLSession 解析原生 .jsonl 会话：首行 meta 带 sessionId，首条 user 记录给标题。
func readGeminiJSONLSession(chatPath, projectDirName string) (Session, bool) {
	content, err := os.ReadFile(chatPath)
	if err != nil {
		return Session{}, false
	}
	lines := make([]string, 0)
	for _, line := range splitLines(string(content)) {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) == 0 {
		return Session{}, false
	}

	sessionID := ""
	var meta struct {
		SessionID string `json:"sessionId"`
	}
	if json.Unmarshal([]byte(lines[0]), &meta) == nil {
		sessionID = strings.TrimSpace(meta.SessionID)
	}
	if sessionID == "" {
		sessionID = strings.TrimSuffix(filepath.Base(chatPath), ".jsonl")
	}

	title := ""
	for _, line := range lines {
		var record geminiJSONLRecord
		if json.Unmarshal([]byte(line), &record) != nil || record.Type != "user" {
			continue
		}
		text := strings.TrimSpace(geminiContentText(record.Content))
		if text != "" {
			title = truncateTitle(text)
			break
		}
	}
	if title == "" || title == warmupTitle {
		return Session{}, false
	}
	return Session{
		ID:             sessionID,
		Title:          title,
		UpdatedAt:      fileModifiedMillis(chatPath),
		Provider:       geminiProvider,
		ProjectDirName: projectDirName,
	}, true
}

func firstSubmatch(pattern *regexp.Regexp, text string) string {
	match := pattern.FindStringSubmatch(text)
	if len(match) < 2 {
		return ""
	}
	return match[1]
}
