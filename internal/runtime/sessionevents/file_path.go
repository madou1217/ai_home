package sessionevents

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	codebuddyfamilystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codebuddyfamily"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
	"github.com/madou1217/ai_home/internal/sessionscan/codebuddy"
	"github.com/madou1217/ai_home/internal/sessionscan/sessionread"
)

const maxCodexResolveEntries = 20000

// sessionPathQuery 是一次会话文件定位的规范化输入。
type sessionPathQuery struct {
	HostHome       string
	AIHomeDir      string
	Provider       string
	SessionID      string
	ProjectDirName string
}

// sessionPathResolver 定位一个 Provider 的会话存储文件；找不到返回空串。
type sessionPathResolver func(sessionPathQuery) string

// sessionPathResolvers 按 Provider 登记文件定位器。
//
// 各 CLI 的会话布局是协议事实，保持在本包；这里只把 Provider→定位器的分派
// 收进注册表。CodeBuddy 家族成员来自 sessionscan 的家族布局，不在这里另抄名单。
var sessionPathResolvers = buildSessionPathResolvers()

func buildSessionPathResolvers() map[string]sessionPathResolver {
	indexed := map[string]sessionPathResolver{
		"claude":   resolveClaudeQuery,
		"codex":    resolveCodexQuery,
		"gemini":   resolveGeminiQuery,
		"opencode": resolveOpenCodeQuery,
		"cline":    resolveClineQuery,
		"qoder":    resolveQoderQuery,
		"qodercn":  resolveQoderQuery,
		// 这些载体的定位逻辑已经在 sessionread 中实现（账号投影、SQLite、chat JSON）；
		// 订阅只需要同一个文件游标，直接复用，避免两套路径规则漂移。
		"agy":   resolveViaSessionRead,
		"grok":  resolveViaSessionRead,
		"kiro":  resolveViaSessionRead,
		"zcode": resolveViaSessionRead,
		"chat":  resolveViaSessionRead,
	}
	for _, provider := range codebuddy.Providers() {
		indexed[provider] = resolveCodebuddyQuery
	}
	return indexed
}

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

	resolver, found := sessionPathResolvers[normalizedProvider]
	if !found {
		return ""
	}
	return resolver(sessionPathQuery{
		HostHome:       hostHome,
		AIHomeDir:      aiHomeDir,
		Provider:       normalizedProvider,
		SessionID:      cleanSessionID,
		ProjectDirName: cleanProjectDirName,
	})
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

func resolveClaudeQuery(query sessionPathQuery) string {
	return resolveClaudeSessionPath(query.HostHome, query.SessionID, query.ProjectDirName)
}

func resolveCodexQuery(query sessionPathQuery) string {
	return resolveCodexSessionPath(query.HostHome, query.SessionID)
}

func resolveGeminiQuery(query sessionPathQuery) string {
	return resolveGeminiSessionPath(query.HostHome, query.SessionID, query.ProjectDirName)
}

func resolveOpenCodeQuery(query sessionPathQuery) string {
	return resolveOpenCodePath(query.HostHome)
}

func resolveClineQuery(query sessionPathQuery) string {
	return resolveClineSessionPath(query.HostHome, query.AIHomeDir, query.SessionID)
}

func resolveQoderQuery(query sessionPathQuery) string {
	return resolveQoderSessionPath(query.HostHome, query.Provider, query.SessionID, query.ProjectDirName)
}

func resolveCodebuddyQuery(query sessionPathQuery) string {
	return resolveCodebuddySessionPath(query.HostHome, query.Provider, query.SessionID, query.ProjectDirName)
}

func resolveViaSessionRead(query sessionPathQuery) string {
	return sessionread.ResolveSessionFilePath(context.Background(), sessionread.Options{
		HostHomeDir: query.HostHome,
		AIHomeDir:   query.AIHomeDir,
	}, query.Provider, query.SessionID, query.ProjectDirName)
}

func resolveClaudeSessionPath(hostHome, sessionID, projectDirName string) string {
	projectsRoot := filepath.Join(hostHome, providerroot.ConfigDir("claude"), "projects")
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
	// 目录事实由 Provider 合同提供：自己的配置根 → 本地区另一支 → 家族其余成员。
	// 旧实现手写了不存在的 .codebuddycn / .workbuddycn，导致国内站与 WorkBuddy
	// 的会话事件完全定位不到（2026-11-22 真机对照）。
	candidates := make([]string, 0, 4)
	seen := make(map[string]bool, 4)
	addDir := func(dirName string) {
		if dirName == "" || seen[dirName] {
			return
		}
		seen[dirName] = true
		candidates = append(candidates, dirName)
	}
	if dirName, ok := codebuddyfamilystorage.ConfigDir(provider); ok {
		addDir(dirName)
	}
	for _, dirName := range codebuddyfamilystorage.SessionRoots(provider) {
		addDir(dirName)
	}
	for _, dirName := range codebuddyfamilystorage.ConfigDirs() {
		addDir(dirName)
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
		filepath.Join(hostHome, providerroot.ConfigDir("codex"), "sessions"),
		filepath.Join(hostHome, providerroot.ConfigDir("codex"), "archived_sessions"),
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
	tmpRoot := filepath.Join(hostHome, providerroot.ConfigDir("gemini"), "tmp")
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
	root := filepath.Join(append([]string{hostHome}, providerroot.NativeRoot("opencode")...)...)
	wal := filepath.Join(root, "opencode.db-wal")
	if isRegularFile(wal) {
		return wal
	}
	db := filepath.Join(root, "opencode.db")
	if isRegularFile(db) {
		return db
	}
	return ""
}

func resolveClineSessionPath(hostHome, aiHomeDir, sessionID string) string {
	candidates := []string{
		filepath.Join(hostHome, providerroot.ConfigDir("cline"), "data", "tasks", sessionID, "api_conversation_history.json"),
		filepath.Join(hostHome, providerroot.ConfigDir("cline"), "data", "tasks", sessionID, "ui_messages.json"),
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
				candidate := filepath.Join(projRoot, entry.Name(), providerroot.ConfigDir("cline"), "data", "tasks", sessionID, "api_conversation_history.json")
				if isRegularFile(candidate) {
					return candidate
				}
			}
		}
	}
	return ""
}

func resolveQoderSessionPath(hostHome, provider, sessionID, projectDirName string) string {
	dirName := filepath.Join(providerroot.ConfigRoot(provider)...)
	if dirName == "" {
		return ""
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
