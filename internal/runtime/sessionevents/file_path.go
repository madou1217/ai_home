package sessionevents

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/sessionscan/codebuddy"
)

const maxCodexResolveEntries = 20000

// ResolveSessionFilePath 定位指定会话的宿主存储文件路径，用于 fsnotify 文件变更订阅。
// 返回空串或不存在的文件时调用方继续依赖显式 hook 事件，不阻断订阅。
func ResolveSessionFilePath(hostHomeDir, aiHomeDir, provider, sessionID, projectDirName string) string {
	normalizedProvider := strings.ToLower(strings.TrimSpace(provider))
	cleanSessionID := strings.TrimSpace(sessionID)
	cleanProjectDirName := strings.TrimSpace(projectDirName)
	hostHome := strings.TrimSpace(hostHomeDir)
	if hostHome == "" || normalizedProvider == "" || !isSafePathSegment(cleanSessionID) {
		return ""
	}
	if cleanProjectDirName != "" && !isSafePathSegment(cleanProjectDirName) {
		return ""
	}

	if isCodebuddyFamily(normalizedProvider) {
		return resolveCodebuddySessionPath(hostHome, normalizedProvider, cleanSessionID, cleanProjectDirName)
	}

	switch normalizedProvider {
	case "claude":
		return resolveClaudeSessionPath(hostHome, cleanSessionID, cleanProjectDirName)
	case "codex":
		return resolveCodexSessionPath(hostHome, cleanSessionID)
	case "gemini":
		return resolveGeminiSessionPath(hostHome, cleanSessionID, cleanProjectDirName)
	case "opencode":
		return resolveOpenCodePath(hostHome)
	case "cline":
		return resolveClineSessionPath(hostHome, aiHomeDir, cleanSessionID)
	case "qoder", "qodercn":
		return resolveQoderSessionPath(hostHome, normalizedProvider, cleanSessionID, cleanProjectDirName)
	default:
		return ""
	}
}

func isSafePathSegment(value string) bool {
	if value == "" || value == "." || value == ".." {
		return false
	}
	if strings.ContainsAny(value, "/\\\x00") {
		return false
	}
	return filepath.Base(value) == value
}

func isCodebuddyFamily(provider string) bool {
	for _, member := range codebuddy.Providers() {
		if provider == member {
			return true
		}
	}
	return false
}

func resolveClaudeSessionPath(hostHome, sessionID, projectDirName string) string {
	projectsRoot := filepath.Join(hostHome, ".claude", "projects")
	if projectDirName != "" {
		candidate := filepath.Join(projectsRoot, projectDirName, sessionID+".jsonl")
		if isRegularFile(candidate) {
			return candidate
		}
		return ""
	}
	entries, err := os.ReadDir(projectsRoot)
	if err != nil {
		return ""
	}
	for _, entry := range entries {
		if !entry.IsDir() || !isSafePathSegment(entry.Name()) {
			continue
		}
		candidate := filepath.Join(projectsRoot, entry.Name(), sessionID+".jsonl")
		if isRegularFile(candidate) {
			return candidate
		}
	}
	return ""
}

func resolveCodebuddySessionPath(hostHome, provider, sessionID, projectDirName string) string {
	configDirs := map[string]string{
		"codebuddy":   ".codebuddy",
		"codebuddycn": ".codebuddycn",
		"workbuddy":   ".workbuddy",
		"workbuddycn": ".workbuddycn",
	}
	candidates := make([]string, 0, 2)
	if dir, ok := configDirs[provider]; ok {
		candidates = append(candidates, dir)
	}
	if dir := ".codebuddy"; dir != configDirs[provider] {
		candidates = append(candidates, dir)
	}
	for _, configDir := range candidates {
		projectsRoot := filepath.Join(hostHome, configDir, "projects")
		if projectDirName != "" {
			candidate := filepath.Join(projectsRoot, projectDirName, sessionID+".jsonl")
			if isRegularFile(candidate) {
				return candidate
			}
			continue
		}
		entries, err := os.ReadDir(projectsRoot)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() || !isSafePathSegment(entry.Name()) {
				continue
			}
			candidate := filepath.Join(projectsRoot, entry.Name(), sessionID+".jsonl")
			if isRegularFile(candidate) {
				return candidate
			}
		}
	}
	return ""
}

func resolveCodexSessionPath(hostHome, sessionID string) string {
	roots := []string{
		filepath.Join(hostHome, ".codex", "sessions"),
		filepath.Join(hostHome, ".codex", "archived_sessions"),
	}
	count := 0
	for _, root := range roots {
		var matched string
		_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return nil
			}
			count++
			if count > maxCodexResolveEntries {
				return filepath.SkipAll
			}
			name := entry.Name()
			if !strings.HasSuffix(name, ".jsonl") {
				return nil
			}
			if name == sessionID+".jsonl" || strings.HasSuffix(name, "-"+sessionID+".jsonl") {
				matched = path
				return filepath.SkipAll
			}
			return nil
		})
		if matched != "" {
			return matched
		}
	}
	return ""
}

func resolveGeminiSessionPath(hostHome, sessionID, projectDirName string) string {
	tmpRoot := filepath.Join(hostHome, ".gemini", "tmp")
	searchProject := func(dirName string) string {
		chatsDir := filepath.Join(tmpRoot, dirName, "chats")
		direct := filepath.Join(chatsDir, sessionID+".json")
		if isRegularFile(direct) {
			return direct
		}
		entries, err := os.ReadDir(chatsDir)
		if err != nil {
			return ""
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") || !isSafePathSegment(entry.Name()) {
				continue
			}
			if strings.Contains(entry.Name(), sessionID) {
				return filepath.Join(chatsDir, entry.Name())
			}
		}
		return ""
	}
	if projectDirName != "" {
		return searchProject(projectDirName)
	}
	entries, err := os.ReadDir(tmpRoot)
	if err != nil {
		return ""
	}
	for _, entry := range entries {
		if !entry.IsDir() || !isSafePathSegment(entry.Name()) {
			continue
		}
		if matched := searchProject(entry.Name()); matched != "" {
			return matched
		}
	}
	return ""
}

func resolveOpenCodePath(hostHome string) string {
	wal := filepath.Join(hostHome, ".local", "share", "opencode", "opencode.db-wal")
	if isRegularFile(wal) {
		return wal
	}
	db := filepath.Join(hostHome, ".local", "share", "opencode", "opencode.db")
	if isRegularFile(db) {
		return db
	}
	return ""
}

func resolveClineSessionPath(hostHome, aiHomeDir, sessionID string) string {
	candidates := []string{
		filepath.Join(hostHome, ".cline", "data", "tasks", sessionID, "api_conversation_history.json"),
		filepath.Join(hostHome, ".cline", "data", "tasks", sessionID, "ui_messages.json"),
	}
	for _, candidate := range candidates {
		if isRegularFile(candidate) {
			return candidate
		}
	}
	if strings.TrimSpace(aiHomeDir) != "" {
		projRoot := filepath.Join(strings.TrimSpace(aiHomeDir), "run", "auth-projections", "cline")
		entries, err := os.ReadDir(projRoot)
		if err == nil {
			for _, entry := range entries {
				if !entry.IsDir() || !isSafePathSegment(entry.Name()) {
					continue
				}
				candidate := filepath.Join(projRoot, entry.Name(), ".cline", "data", "tasks", sessionID, "api_conversation_history.json")
				if isRegularFile(candidate) {
					return candidate
				}
			}
		}
	}
	return ""
}

func resolveQoderSessionPath(hostHome, provider, sessionID, projectDirName string) string {
	dirName := ".qoder"
	if provider == "qodercn" {
		dirName = ".qodercn"
	}
	projectsRoot := filepath.Join(hostHome, dirName, "projects")
	if projectDirName != "" {
		candidate := filepath.Join(projectsRoot, projectDirName, sessionID+".jsonl")
		if isRegularFile(candidate) {
			return candidate
		}
		return ""
	}
	entries, err := os.ReadDir(projectsRoot)
	if err != nil {
		return ""
	}
	for _, entry := range entries {
		if !entry.IsDir() || !isSafePathSegment(entry.Name()) {
			continue
		}
		candidate := filepath.Join(projectsRoot, entry.Name(), sessionID+".jsonl")
		if isRegularFile(candidate) {
			return candidate
		}
	}
	return ""
}

func isRegularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}
