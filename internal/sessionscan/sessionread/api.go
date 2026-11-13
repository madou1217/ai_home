package sessionread

import (
	"context"
	"encoding/json"
	"os"
	"strings"
)

// ListProjects 收集指定 Provider 的全部项目与会话（含项目别名映射与空会话清理排序）。
func ListProjects(ctx context.Context, opts Options, provider string) ([]Project, error) {
	norm := NormalizeProvider(provider)
	if !IsKnownProvider(norm) {
		return nil, ErrUnsupportedProvider
	}
	hostHome := strings.TrimSpace(opts.HostHomeDir)
	var raw []Project
	switch {
	case norm == "claude":
		raw = ListClaudeProjects(hostHome)
	case norm == "gemini":
		raw = ListGeminiProjects(hostHome)
	case norm == "agy":
		raw = ListAgyProjects(hostHome)
	case norm == "opencode":
		raw = ListOpenCodeProjects(ctx, hostHome)
	case norm == "qoder" || norm == "qodercn":
		raw = ListQoderProjects(opts, norm)
	case norm == "grok":
		raw = ListGrokProjects(opts)
	case norm == "kiro":
		raw = ListKiroProjects(ctx, opts)
	case norm == "cline":
		raw = ListClineProjects(ctx, opts)
	case norm == "zcode":
		raw = ListZCodeProjects(ctx, hostHome)
	case IsCodebuddyFamilyProvider(norm):
		raw = ListCodebuddyProjects(ctx, opts, norm)
	case norm == "kimi" || norm == "chat":
		raw = []Project{}
	default:
		return nil, ErrUnsupportedProvider
	}

	mapped := ApplyProjectNameMappings(raw, ReadGeminiProjectNameMappings(hostHome))
	return sanitizeProjects(mapped), nil
}

// ValidateSessionRef 检查 sessionId 与 projectDirName 的路径安全性。
func ValidateSessionRef(provider, sessionID, projectDirName string) error {
	if !IsSafePathSegment(sessionID) {
		return ErrInvalidSessionRef
	}
	projDir := strings.TrimSpace(projectDirName)
	if projDir != "" {
		if HasDotDotSegment(projDir) {
			return ErrInvalidSessionRef
		}
		if RequiresSingleSegmentProjectDirName(provider) && !IsSafePathSegment(projDir) {
			return ErrInvalidSessionRef
		}
	}
	return nil
}

// ReadMessagesSnapshot 读取某会话全部消息及增量光标；支持先查 chat-sessions，未命中再读取原生载体，并完成 Turn Model 装饰与资源路径规范化。
func ReadMessagesSnapshot(ctx context.Context, opts Options, provider, sessionID, projectDirName string) (Snapshot, error) {
	norm := NormalizeProvider(provider)
	if !IsKnownProvider(norm) {
		return Snapshot{}, ErrUnsupportedProvider
	}
	sid := strings.TrimSpace(sessionID)
	if err := ValidateSessionRef(norm, sid, projectDirName); err != nil {
		return Snapshot{}, err
	}

	aiHome := ResolveAIHomeDir(opts)
	hostHome := strings.TrimSpace(opts.HostHomeDir)

	if chatMsgs, found, err := ReadChatSessionMessages(opts, sid); found {
		if err != nil {
			return Snapshot{}, ErrReadFailed
		}
		decorated := ApplyCanonicalAgyTurnModels(ctx, opts, norm, sid, DecorateMessagesWithTurnModels(chatMsgs))
		canonical := CanonicalizeMessages(decorated, norm, aiHome, hostHome)
		return Snapshot{Messages: canonical, Cursor: 0}, nil
	} else if norm == "chat" {
		return Snapshot{}, ErrSessionNotFound
	}

	var rawMessages []json.RawMessage
	var cursor int64
	var readErr error

	switch {
	case norm == "claude":
		rawMessages, cursor, _, readErr = ReadClaudeMessages(hostHome, sid, projectDirName)
	case norm == "codex":
		rawMessages, cursor, _, readErr = ReadCodexMessagesSnapshot(ctx, hostHome, sid)
	default:
		var structMsgs []Message
		structMsgs, cursor, _, readErr = readStructuredProviderMessages(ctx, opts, norm, sid, projectDirName)
		if readErr == nil {
			rawMessages = marshalMessages(structMsgs)
		}
	}
	if readErr != nil {
		return Snapshot{}, readErr
	}
	if rawMessages == nil {
		rawMessages = []json.RawMessage{}
	}

	decorated := DecorateMessagesWithTurnModels(rawMessages)
	if norm == "agy" {
		decorated = ApplyCanonicalAgyTurnModels(ctx, opts, norm, sid, decorated)
	}
	canonical := CanonicalizeMessages(decorated, norm, aiHome, hostHome)
	return Snapshot{Messages: canonical, Cursor: cursor}, nil
}

func readStructuredProviderMessages(ctx context.Context, opts Options, normProvider, sessionID, projectDirName string) ([]Message, int64, bool, error) {
	hostHome := strings.TrimSpace(opts.HostHomeDir)
	switch {
	case normProvider == "gemini":
		return ReadGeminiMessages(hostHome, sessionID, projectDirName)
	case normProvider == "agy":
		return ReadAgyMessages(hostHome, sessionID)
	case normProvider == "opencode":
		return ReadOpenCodeMessages(ctx, hostHome, sessionID)
	case normProvider == "qoder" || normProvider == "qodercn":
		return ReadQoderMessages(opts, normProvider, sessionID, projectDirName)
	case normProvider == "grok":
		return ReadGrokMessages(opts, sessionID, projectDirName)
	case normProvider == "kiro":
		return ReadKiroMessages(ctx, opts, sessionID)
	case normProvider == "zcode":
		return ReadZCodeMessages(ctx, hostHome, sessionID)
	case normProvider == "cline":
		return ReadClineMessages(opts, sessionID)
	case IsCodebuddyFamilyProvider(normProvider):
		return ReadCodebuddyMessages(ctx, opts, normProvider, sessionID, projectDirName)
	case normProvider == "kimi":
		return []Message{}, 0, true, nil
	default:
		return nil, 0, false, ErrUnsupportedProvider
	}
}

func marshalMessages(msgs []Message) []json.RawMessage {
	if len(msgs) == 0 {
		return []json.RawMessage{}
	}
	out := make([]json.RawMessage, 0, len(msgs))
	for _, msg := range msgs {
		if raw, err := json.Marshal(msg); err == nil {
			out = append(out, raw)
		}
	}
	return out
}

// ResolveSessionFilePath 定位指定会话对应的核心事实文件或数据库文件（用于文件光标与尾部模型扫描）。
func ResolveSessionFilePath(ctx context.Context, opts Options, provider, sessionID, projectDirName string) string {
	norm := NormalizeProvider(provider)
	sid := strings.TrimSpace(sessionID)
	hostHome := strings.TrimSpace(opts.HostHomeDir)
	if sid == "" {
		return ""
	}
	switch {
	case norm == "claude":
		return ResolveClaudeSessionPath(hostHome, sid, projectDirName)
	case norm == "codex":
		return ResolveCodexSessionPath(ctx, hostHome, sid)
	case norm == "gemini":
		return ResolveGeminiSessionPath(hostHome, sid, projectDirName)
	case norm == "agy":
		return ResolveAgySessionPath(hostHome, sid)
	case norm == "opencode":
		return ResolveOpenCodeSessionDB(ctx, hostHome, sid)
	case norm == "qoder" || norm == "qodercn":
		return ResolveQoderSessionPath(opts, norm, sid, projectDirName)
	case norm == "grok":
		return ResolveGrokSessionPath(opts, sid, projectDirName)
	case norm == "kiro":
		return ResolveKiroSessionPath(ctx, opts, sid)
	case norm == "zcode":
		cliDB, _ := resolveZCodeDBPaths(hostHome)
		if fileExistsRegular(cliDB) {
			return cliDB
		}
		return ""
	case norm == "cline":
		return ResolveClineSessionPath(opts, sid)
	case IsCodebuddyFamilyProvider(norm):
		return ResolveCodebuddySessionPath(ctx, opts, norm, sid, projectDirName)
	case norm == "chat":
		return ResolveChatSessionPath(opts, sid)
	default:
		return ""
	}
}

// GetSessionFileCursor 返回会话核心文件当前字节长度（不存在时为 0）。
func GetSessionFileCursor(ctx context.Context, opts Options, provider, sessionID, projectDirName string) int64 {
	filePath := ResolveSessionFilePath(ctx, opts, provider, sessionID, projectDirName)
	if filePath == "" {
		return 0
	}
	size, _, ok := fileSizeAndMtimeMs(filePath)
	if !ok {
		return 0
	}
	return size
}

// ReadEventsNonCodex 为非 Codex Provider 生成与 Node readSessionEvents 一致的轻量光标探测响应。
func ReadEventsNonCodex(ctx context.Context, opts Options, provider, sessionID, projectDirName string, requestedCursor int64) (NonCodexEventsResult, error) {
	norm := NormalizeProvider(provider)
	if !IsKnownProvider(norm) {
		return NonCodexEventsResult{}, ErrUnsupportedProvider
	}
	if err := ValidateSessionRef(norm, sessionID, projectDirName); err != nil {
		return NonCodexEventsResult{}, err
	}
	if requestedCursor < 0 {
		requestedCursor = 0
	}
	nextCursor := GetSessionFileCursor(ctx, opts, norm, sessionID, projectDirName)
	return NonCodexEventsResult{
		Events:               []any{},
		Cursor:               nextCursor,
		RequiresSnapshot:     nextCursor != requestedCursor,
		HasAssistantToolCall: false,
	}, nil
}

// ReadSessionModel 为 GET .../sessions/{provider}/{sessionId}/model 读取最近使用模型（opencode 优先 session.model，其余优先 model_usage_records）。
func ReadSessionModel(ctx context.Context, opts Options, provider, sessionID string) string {
	norm := NormalizeProvider(provider)
	sid := strings.TrimSpace(sessionID)
	if sid == "" {
		return ""
	}
	if norm == "opencode" {
		if m := ReadOpenCodeSessionModel(ctx, opts.HostHomeDir, sid); m != "" {
			return m
		}
	}
	return GetLastSessionModel(ctx, opts, norm, sid)
}

// ReadLastTranscriptModel 读取原生会话载体里最近记录的模型名，对齐 Node readSessionLastModel。
func ReadLastTranscriptModel(ctx context.Context, opts Options, provider, sessionID, projectDirName string) string {
	norm := NormalizeProvider(provider)
	sid := strings.TrimSpace(sessionID)
	hostHome := strings.TrimSpace(opts.HostHomeDir)
	switch norm {
	case "opencode":
		return ReadOpenCodeSessionModel(ctx, hostHome, sid)
	case "kiro":
		return ReadKiroSessionModel(ctx, opts, sid)
	case "cline":
		return ReadClineSessionModel(ctx, opts, sid)
	case "zcode":
		return ReadZCodeSessionModel(ctx, hostHome, sid)
	case "chat", "kimi", "":
		return ""
	default:
		filePath := ResolveSessionFilePath(ctx, opts, norm, sid, projectDirName)
		if filePath == "" {
			return ""
		}
		return extractLastModelFromFileTail(filePath, 96*1024)
	}
}

// ReadPreview 为批量预览接口读取单个会话的 { Model, Preview }。
func ReadPreview(ctx context.Context, opts Options, provider, sessionID, projectDirName string) (Preview, error) {
	norm := NormalizeProvider(provider)
	if !IsKnownProvider(norm) {
		return Preview{}, ErrUnsupportedProvider
	}
	sid := strings.TrimSpace(sessionID)
	if err := ValidateSessionRef(norm, sid, projectDirName); err != nil {
		return Preview{}, err
	}

	transcriptModel := ReadLastTranscriptModel(ctx, opts, norm, sid, projectDirName)
	recordedModel := GetLastSessionModel(ctx, opts, norm, sid)
	model := ""
	if norm == "agy" {
		model = firstNonEmpty(recordedModel, transcriptModel)
	} else {
		model = firstNonEmpty(transcriptModel, recordedModel)
	}

	if chatMsgs, found, err := ReadChatSessionMessages(opts, sid); found {
		if err != nil {
			return Preview{}, ErrReadFailed
		}
		return Preview{
			Model:   model,
			Preview: ExtractPreviewFromRawMessages(chatMsgs),
		}, nil
	}

	snap, err := ReadMessagesSnapshot(ctx, opts, norm, sid, projectDirName)
	if err != nil {
		return Preview{Model: model}, nil
	}
	return Preview{
		Model:   model,
		Preview: ExtractPreviewFromRawMessages(snap.Messages),
	}, nil
}

var _ = os.ErrNotExist
