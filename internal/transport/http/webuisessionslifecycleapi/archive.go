package webuisessionslifecycleapi

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const (
	// originLegacy 表示条目来自会话文件归档（与归档列表接口的 origin 口径一致）。
	originLegacy = "legacy"
	// originNative 表示条目由 Provider 原生接口归档。
	originNative = "native"

	claudeArchiveSuffix = ".jsonl"
	geminiArchiveSuffix = ".json"
	archiveDirName      = ".archived"

	codeSessionNotFound           = "session_not_found"
	codeSessionArchiveUnsupported = "session_archive_unsupported"
	codeProviderRuntimeNotFound   = "provider_runtime_not_found"
	codeCodexArchiveFailed        = "codex_archive_failed"
)

// archiveResult 是归档成功的稳定投影，字段与 Node 的 archive() 返回值一致。
type archiveResult struct {
	Provider        string
	SessionID       string
	NativeSessionID string
	Origin          string
}

// archive 按 Provider 归档一个会话。
//
// Claude / Gemini 走会话文件归档（写进 Provider 自己的 .archived 目录），
// Codex 走 app-server 的 thread/archive；其余 Provider 没有归档事实源，
// 返回 422 而不是假装成功。
func (handler *Handler) archive(ctx context.Context, provider, sessionID string) (archiveResult, error) {
	switch provider {
	case providerClaude:
		if err := handler.archiveClaudeFile(sessionID); err != nil {
			return archiveResult{}, err
		}
		return archiveResult{Provider: provider, SessionID: sessionID, NativeSessionID: sessionID, Origin: originLegacy}, nil
	case providerGemini:
		if err := handler.archiveGeminiFile(sessionID); err != nil {
			return archiveResult{}, err
		}
		return archiveResult{Provider: provider, SessionID: sessionID, NativeSessionID: sessionID, Origin: originLegacy}, nil
	case providerCodex:
		if err := handler.archiveCodexThread(ctx, sessionID); err != nil {
			return archiveResult{}, err
		}
		return archiveResult{Provider: provider, SessionID: sessionID, NativeSessionID: sessionID, Origin: originNative}, nil
	default:
		return archiveResult{}, &lifecycleError{
			status:  422,
			code:    codeSessionArchiveUnsupported,
			message: provider + " 不支持原生归档",
		}
	}
}

// archiveCodexThread 通过 app-server 归档线程。
func (handler *Handler) archiveCodexThread(ctx context.Context, sessionID string) error {
	if handler.codex == nil {
		return &lifecycleError{
			status:  503,
			code:    codeProviderRuntimeNotFound,
			message: "Codex 运行时未接线，无法归档",
		}
	}
	client, err := handler.codex(ctx)
	if err != nil || client == nil {
		return &lifecycleError{
			status:  503,
			code:    codeProviderRuntimeNotFound,
			message: "Codex 运行时不可用，无法归档",
		}
	}
	defer func() { _ = client.Close() }()

	archiveCtx, cancel := context.WithTimeout(ctx, codexTimeout)
	defer cancel()
	if err := client.ArchiveThread(archiveCtx, sessionID); err != nil {
		return &lifecycleError{
			status:  502,
			code:    codeCodexArchiveFailed,
			message: "Codex 归档失败: " + err.Error(),
		}
	}
	return nil
}

// archiveClaudeFile 把 Claude 会话文件移进项目目录下的 .archived。
//
// 这里不用 sessionscan/legacy 的项目视图：那是给列表展示用的投影，会过滤掉
// 未命名与 warmup 会话，用它的结果定位文件会让这类会话无法归档。
func (handler *Handler) archiveClaudeFile(sessionID string) error {
	projectsRoot := filepath.Join(handler.hostHomeDir, ".claude", "projects")
	for _, projectDirName := range safeDirectoryNames(projectsRoot) {
		projectRoot := filepath.Join(projectsRoot, projectDirName)
		archivedRoot := filepath.Join(projectRoot, archiveDirName)
		archivedPath := filepath.Join(archivedRoot, sessionID+claudeArchiveSuffix)
		if isRegularFile(archivedPath) {
			// 已经归档过：幂等返回，不改写归档时间。
			return nil
		}
		activePath := filepath.Join(projectRoot, sessionID+claudeArchiveSuffix)
		if !isRegularFile(activePath) {
			continue
		}
		if err := os.MkdirAll(archivedRoot, 0o755); err != nil {
			return archiveFailure("创建 Claude 归档目录失败")
		}
		if err := moveFile(activePath, archivedPath); err != nil {
			return archiveFailure("移动 Claude 会话文件失败")
		}
		return nil
	}
	return notFoundFailure("未找到 Claude 会话文件")
}

// archiveGeminiFile 把 Gemini 会话文件移进 chats/.archived。
//
// 与 Node 的 restoreGemini 同一口径：优先按 JSON 里的 sessionId 匹配，
// 读不出来时退回文件名（去掉 .json）。
func (handler *Handler) archiveGeminiFile(sessionID string) error {
	projectsRoot := filepath.Join(handler.hostHomeDir, ".gemini", "tmp")
	for _, projectDirName := range safeDirectoryNames(projectsRoot) {
		chatsRoot := filepath.Join(projectsRoot, projectDirName, "chats")
		archivedRoot := filepath.Join(chatsRoot, archiveDirName)
		for _, fileName := range safeFileNames(archivedRoot, geminiArchiveSuffix) {
			if geminiFileSessionID(filepath.Join(archivedRoot, fileName), fileName) == sessionID {
				return nil
			}
		}
		for _, fileName := range safeFileNames(chatsRoot, geminiArchiveSuffix) {
			activePath := filepath.Join(chatsRoot, fileName)
			if geminiFileSessionID(activePath, fileName) != sessionID {
				continue
			}
			if err := os.MkdirAll(archivedRoot, 0o755); err != nil {
				return archiveFailure("创建 Gemini 归档目录失败")
			}
			if err := moveFile(activePath, filepath.Join(archivedRoot, fileName)); err != nil {
				return archiveFailure("移动 Gemini 会话文件失败")
			}
			return nil
		}
	}
	return notFoundFailure("未找到 Gemini 会话文件")
}

// geminiFileSessionID 复刻 Node：JSON 的 sessionId 优先，否则用文件名。
func geminiFileSessionID(filePath, fileName string) string {
	content, err := os.ReadFile(filePath)
	if err == nil {
		var archive struct {
			SessionID string `json:"sessionId"`
		}
		if json.Unmarshal(content, &archive) == nil {
			if sessionID := strings.TrimSpace(archive.SessionID); sessionID != "" {
				return sessionID
			}
		}
	}
	return strings.TrimSuffix(fileName, geminiArchiveSuffix)
}

// moveFile 把会话文件搬到归档目录。
//
// 目标已存在时按幂等成功处理：并发归档同一个会话时后到的一方不应该报错，
// 也不应该覆盖先到的归档文件。
func moveFile(source, destination string) error {
	if isRegularFile(destination) {
		return nil
	}
	if err := os.Rename(source, destination); err != nil {
		if isRegularFile(destination) {
			return nil
		}
		if errors.Is(err, fs.ErrNotExist) && !isRegularFile(source) {
			// 竞态：另一个请求先搬走了源文件。
			return nil
		}
		return err
	}
	return nil
}

func isRegularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// safeDirectoryNames 只返回单段目录名，避免跟随符号链接或路径分隔符。
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

func safeName(value string) bool {
	return value != "" && value != "." && value != ".." &&
		!strings.Contains(value, "/") && !strings.Contains(value, "\\")
}

func notFoundFailure(message string) error {
	return &lifecycleError{status: 404, code: codeSessionNotFound, message: message}
}

func archiveFailure(message string) error {
	return &lifecycleError{status: 500, code: "session_archive_failed", message: message}
}
