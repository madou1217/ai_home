package webuisessionslifecycleapi

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const (
	codeLegacyArchiveNotFound       = "legacy_archive_not_found"
	codeLegacyArchiveRestoreConflict = "legacy_archive_restore_conflict"
	codeSessionUnarchiveUnsupported  = "session_unarchive_unsupported"
	codeCodexUnarchiveFailed         = "codex_unarchive_failed"
	codeSessionUnarchiveFailed       = "session_unarchive_failed"
)

func (handler *Handler) serveUnarchive(response http.ResponseWriter, request *http.Request) {
	payload, err := readArchivePayload(request)
	if err != nil {
		writeLifecycleError(response, err)
		return
	}
	result, err := handler.unarchive(request.Context(), payload.Provider, payload.SessionID, payload.Origin)
	if err != nil {
		writeLifecycleError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, archiveResponse{
		OK:              true,
		Provider:        result.Provider,
		SessionID:       result.SessionID,
		NativeSessionID: result.NativeSessionID,
		Origin:          result.Origin,
	})
}

func (handler *Handler) unarchive(ctx context.Context, provider, sessionID, origin string) (archiveResult, error) {
	useLegacy := strings.EqualFold(strings.TrimSpace(origin), originLegacy)
	if useLegacy || provider == providerClaude || provider == providerGemini {
		return handler.unarchiveLegacy(provider, sessionID)
	}
	if provider == providerCodex {
		if err := handler.unarchiveCodexThread(ctx, sessionID); err != nil {
			return archiveResult{}, err
		}
		return archiveResult{
			Provider:        providerCodex,
			SessionID:       sessionID,
			NativeSessionID: sessionID,
			Origin:          originNative,
		}, nil
	}
	return archiveResult{}, &lifecycleError{
		status:  http.StatusUnprocessableEntity,
		code:    codeSessionUnarchiveUnsupported,
		message: provider + " 不支持原生恢复",
	}
}

func (handler *Handler) unarchiveLegacy(provider, sessionID string) (archiveResult, error) {
	switch provider {
	case providerClaude:
		if err := handler.restoreClaudeFile(sessionID); err != nil {
			return archiveResult{}, err
		}
		return archiveResult{
			Provider:  providerClaude,
			SessionID: sessionID,
			Origin:    originLegacy,
		}, nil
	case providerGemini:
		if err := handler.restoreGeminiFile(sessionID); err != nil {
			return archiveResult{}, err
		}
		return archiveResult{
			Provider:  providerGemini,
			SessionID: sessionID,
			Origin:    originLegacy,
		}, nil
	default:
		return archiveResult{}, &lifecycleError{
			status:  http.StatusUnprocessableEntity,
			code:    codeSessionUnarchiveUnsupported,
			message: provider + " 不支持原生恢复",
		}
	}
}

func (handler *Handler) restoreClaudeFile(sessionID string) error {
	projectsRoot := filepath.Join(handler.hostHomeDir, ".claude", "projects")
	for _, projectDirName := range safeDirectoryNames(projectsRoot) {
		projectRoot := filepath.Join(projectsRoot, projectDirName)
		archivedRoot := filepath.Join(projectRoot, archiveDirName)
		source := filepath.Join(archivedRoot, sessionID+claudeArchiveSuffix)
		if !isRegularFile(source) {
			continue
		}
		destination := filepath.Join(projectRoot, sessionID+claudeArchiveSuffix)
		return moveWithoutOverwrite(source, destination, "恢复 Claude 会话文件失败")
	}
	return &lifecycleError{
		status:  http.StatusNotFound,
		code:    codeLegacyArchiveNotFound,
		message: "未找到 Claude 历史归档",
	}
}

func (handler *Handler) restoreGeminiFile(sessionID string) error {
	projectsRoot := filepath.Join(handler.hostHomeDir, ".gemini", "tmp")
	for _, projectDirName := range safeDirectoryNames(projectsRoot) {
		chatsRoot := filepath.Join(projectsRoot, projectDirName, "chats")
		archivedRoot := filepath.Join(chatsRoot, archiveDirName)
		for _, fileName := range safeFileNames(archivedRoot, geminiArchiveSuffix) {
			source := filepath.Join(archivedRoot, fileName)
			if geminiFileSessionID(source, fileName) != sessionID {
				continue
			}
			destination := filepath.Join(chatsRoot, fileName)
			return moveWithoutOverwrite(source, destination, "恢复 Gemini 会话文件失败")
		}
	}
	return &lifecycleError{
		status:  http.StatusNotFound,
		code:    codeLegacyArchiveNotFound,
		message: "未找到 Gemini 历史归档",
	}
}

func (handler *Handler) unarchiveCodexThread(ctx context.Context, sessionID string) error {
	if handler.codex == nil {
		return &lifecycleError{
			status:  http.StatusServiceUnavailable,
			code:    codeProviderRuntimeNotFound,
			message: "Codex 运行时未接线，无法恢复归档",
		}
	}
	client, err := handler.codex(ctx)
	if err != nil || client == nil {
		return &lifecycleError{
			status:  http.StatusServiceUnavailable,
			code:    codeProviderRuntimeNotFound,
			message: "Codex 运行时不可用，无法恢复归档",
		}
	}
	defer func() { _ = client.Close() }()

	unarchiveCtx, cancel := context.WithTimeout(ctx, codexTimeout)
	defer cancel()
	if err := client.UnarchiveThread(unarchiveCtx, sessionID); err != nil {
		return &lifecycleError{
			status:  http.StatusBadGateway,
			code:    codeCodexUnarchiveFailed,
			message: "Codex 恢复归档失败: " + err.Error(),
		}
	}
	return nil
}

func moveWithoutOverwrite(source, destination, failureMessage string) error {
	if _, err := os.Stat(destination); err == nil {
		return &lifecycleError{
			status:  http.StatusConflict,
			code:    codeLegacyArchiveRestoreConflict,
			message: "目标会话文件已存在",
		}
	}
	if err := os.Rename(source, destination); err != nil {
		return &lifecycleError{
			status:  http.StatusInternalServerError,
			code:    codeSessionUnarchiveFailed,
			message: failureMessage,
		}
	}
	return nil
}
